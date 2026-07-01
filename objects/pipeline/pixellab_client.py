"""PixelLab API client for OBJECTS (props, tools, items).

Objects use PixelLab's **image** endpoints, which are different from the
character endpoints another agent's loop uses:

  - characters/ drives `create-character-*` / `animate-character` — asynchronous
    *character* jobs (background job polling, raw rgba_bytes frames, stored on
    PixelLab under a character_id).
  - objects/ (this file) drives the stateless **image** tools on the `/v1` API:
      * generate-image-pixflux  — text -> a single pixel-art sprite
      * rotate                  — one sprite -> a rotated view
      * animate-with-text       — one sprite -> a short animation (text action)

These `/v1` image endpoints are **synchronous**: the POST returns the finished
art inline as a Base64 PNG (`{"image": {"base64": ...}}` or
`{"images": [{"base64": ...}]}`), with `{"usage": {"generations": N}}`. There is
no job to poll and — unlike a character — no server-side object to re-fetch, so
the repo (not PixelLab) is the source of truth for objects. Verified live against
the API (see objects/spec/OBJECTS_SPEC.md).

Every method returns decoded Pillow images so callers work synchronously.
"""

from __future__ import annotations

import base64
import io
import os
import time

import requests
from PIL import Image

# Image tools live on the v1 API. (The v2 API hosts the character endpoints the
# characters/ loop uses; the two are deliberately separate.)
BASE_URL = "https://api.pixellab.ai/v1"
# The subscription generation balance is only exposed on the v2 balance endpoint
# (v1 /balance reports the usd credit pool, which is 0 on a generations plan).
BALANCE_URL = "https://api.pixellab.ai/v2/balance"
API_KEY_ENV = "PIXELLAB_API_KEY"

# animate-with-text refuses canvases smaller than this (422). Objects that carry
# animations are bumped up to it; static sprites can be smaller.
MIN_ANIMATE_SIZE = 64


class PixelLabError(RuntimeError):
    pass


class BudgetExhausted(PixelLabError):
    pass


def _b64_to_image(obj):
    """Decode a PixelLab Base64Image ({type, base64, format}) or bare base64 str
    into an RGBA Pillow image. Image endpoints return PNG-encoded base64."""
    b64 = obj["base64"] if isinstance(obj, dict) else obj
    raw = base64.b64decode(b64)
    return Image.open(io.BytesIO(raw)).convert("RGBA")


def _image_to_b64obj(img):
    """RGBA Pillow image -> PixelLab Base64Image object (PNG)."""
    bio = io.BytesIO()
    img.convert("RGBA").save(bio, "PNG")
    return {"type": "base64", "base64": base64.b64encode(bio.getvalue()).decode(), "format": "png"}


class PixelLabClient:
    def __init__(self, api_key=None, base_url=BASE_URL, timeout=180):
        self.api_key = api_key or os.environ.get(API_KEY_ENV)
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = requests.Session()

    # -- internals -----------------------------------------------------------

    def require_key(self):
        if not self.api_key:
            raise PixelLabError(
                f"{API_KEY_ENV} is not set. Export your PixelLab key (kept in a "
                f"gitignored .env) before running the objects loop."
            )

    def _headers(self):
        self.require_key()
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def _request(self, method, path, retries=5, **kw):
        """HTTP with retry on transient network/proxy errors and 5xx/429, so the
        autonomous loop survives the occasional dropped connection. 4xx (except
        429) are real request errors and raise immediately."""
        url = path if path.startswith("http") else f"{self.base_url}/{path.lstrip('/')}"
        last = None
        for attempt in range(retries):
            try:
                r = self._session.request(method, url, headers=self._headers(),
                                          timeout=self.timeout, **kw)
            except requests.RequestException as e:
                last = e
                time.sleep(min(2 ** attempt, 30))
                continue
            if r.status_code in (429, 500, 502, 503, 504):
                last = PixelLabError(f"{method} {path} -> {r.status_code}: {r.text[:200]}")
                time.sleep(min(2 ** attempt, 30))
                continue
            if r.status_code >= 400:
                raise PixelLabError(f"{method} {path} -> {r.status_code}: {r.text[:300]}")
            return r.json()
        raise PixelLabError(f"{method} {path} failed after {retries} retries: {last}")

    def _post(self, path, payload):
        return self._request("POST", path, json=payload)

    def _get(self, path):
        return self._request("GET", path)

    # -- balance / budget ----------------------------------------------------

    def balance(self):
        """Fetch the subscription balance from the v2 balance endpoint (see
        BALANCE_URL) regardless of the image base_url."""
        return self._request("GET", BALANCE_URL)

    def generations_remaining(self):
        b = self.balance()
        sub = b.get("subscription", {})
        # Prefer the subscription generation count; fall back to usd credits.
        return float(sub.get("generations", b.get("credits", {}).get("usd", 0)) or 0)

    def ensure_budget(self, minimum):
        rem = self.generations_remaining()
        if rem < minimum:
            raise BudgetExhausted(f"only {rem:.0f} generations left (need >= {minimum})")
        return rem

    # -- sprite (pixflux text -> image) --------------------------------------

    def generate_image(self, description, width, height, view=None, direction=None,
                       outline=None, shading=None, detail=None, no_background=True,
                       isometric=False, negative_description=None,
                       text_guidance_scale=8.0, init_image=None, init_image_strength=300,
                       seed=0):
        """Text -> a single pixel-art sprite (generate-image-pixflux).

        `no_background=True` yields a transparent sprite ready to drop into a
        game. Returns one RGBA Pillow image."""
        payload = {
            "description": description,
            "image_size": {"width": int(width), "height": int(height)},
            "no_background": no_background,
            "isometric": isometric,
            "text_guidance_scale": text_guidance_scale,
            "seed": seed,
        }
        for k, v in (("view", view), ("direction", direction), ("outline", outline),
                     ("shading", shading), ("detail", detail),
                     ("negative_description", negative_description)):
            if v is not None:
                payload[k] = v
        if init_image is not None:
            payload["init_image"] = _image_to_b64obj(init_image)
            payload["init_image_strength"] = init_image_strength
        resp = self._post("/generate-image-pixflux", payload)
        return _b64_to_image(resp["image"]), self._usage(resp)

    # -- rotate (one sprite -> a rotated view) -------------------------------

    def rotate(self, from_image, width, height, from_view=None, to_view=None,
               from_direction="south", to_direction="east", isometric=False,
               oblique_projection=False, image_guidance_scale=3.0, seed=0):
        """Rotate a sprite to another direction/view. Returns one RGBA image."""
        payload = {
            "image_size": {"width": int(width), "height": int(height)},
            "from_image": _image_to_b64obj(from_image),
            "from_direction": from_direction,
            "to_direction": to_direction,
            "isometric": isometric,
            "oblique_projection": oblique_projection,
            "image_guidance_scale": image_guidance_scale,
            "seed": seed,
        }
        for k, v in (("from_view", from_view), ("to_view", to_view)):
            if v is not None:
                payload[k] = v
        resp = self._post("/rotate", payload)
        return _b64_to_image(resp["image"]), self._usage(resp)

    # -- animate (one sprite -> a short clip) --------------------------------

    def animate(self, reference_image, description, action, width, height,
                view="side", direction="east", n_frames=4, negative_description=None,
                text_guidance_scale=7.5, image_guidance_scale=1.5, seed=0):
        """Animate a sprite from a text `action` (animate-with-text).

        Requires a canvas >= MIN_ANIMATE_SIZE (enforced by the caller). Returns a
        list of RGBA frames; frame 0 is the reference pose, the rest are motion.
        The endpoint may return fewer frames than requested — callers use what
        comes back."""
        payload = {
            "description": description,
            "action": action,
            "image_size": {"width": int(width), "height": int(height)},
            "reference_image": _image_to_b64obj(reference_image),
            "view": view,
            "direction": direction,
            "n_frames": int(n_frames),
            "text_guidance_scale": text_guidance_scale,
            "image_guidance_scale": image_guidance_scale,
            "seed": seed,
        }
        if negative_description is not None:
            payload["negative_description"] = negative_description
        resp = self._post("/animate-with-text", payload)
        frames = [_b64_to_image(im) for im in resp.get("images", [])]
        return frames, self._usage(resp)

    @staticmethod
    def _usage(resp):
        u = resp.get("usage") or {}
        return float(u.get("generations", u.get("usd", 0)) or 0)
