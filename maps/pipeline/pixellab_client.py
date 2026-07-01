"""PixelLab API client for the MAPS domain — scene generation.

Maps are built by letting PixelLab *draw* cohesive map scenes (create-image-
pixflux), art-directed with a palette/reference image, rather than tiling flat
Wang blocks. This client is deliberately small: a balance check, background-job
polling, and the pixflux scene call (synchronous). Terrain tilesets and map
objects are NOT generated here — terrain comes from drawn scenes, props come from
the objects agent (see maps/README.md).

Base URL https://api.pixellab.ai/v2, Bearer auth from PIXELLAB_API_KEY.
"""

from __future__ import annotations

import base64
import io
import os
import time

import requests
from PIL import Image

BASE_URL = "https://api.pixellab.ai/v2"
API_KEY_ENV = "PIXELLAB_API_KEY"


class PixelLabError(RuntimeError):
    pass


class BudgetExhausted(PixelLabError):
    pass


def _b64_to_image(b64):
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGBA")


def _img_to_b64obj(img):
    """PIL image -> PixelLab Base64Image object ({type, base64, format})."""
    bio = io.BytesIO()
    img.convert("RGBA").save(bio, "PNG")
    return {"type": "base64", "base64": base64.b64encode(bio.getvalue()).decode(),
            "format": "png"}


class PixelLabClient:
    def __init__(self, api_key=None, base_url=BASE_URL, timeout=180):
        self.api_key = api_key or os.environ.get(API_KEY_ENV)
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = requests.Session()

    def require_key(self):
        if not self.api_key:
            raise PixelLabError(
                f"{API_KEY_ENV} is not set. Export your PixelLab key (kept in a "
                f"gitignored .env) before running the maps loop.")

    def _headers(self):
        self.require_key()
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def _request(self, method, path, retries=5, **kw):
        """HTTP with retry on transient network/proxy errors and 5xx (429/5xx),
        so the loop survives the shared account occasionally rate-limiting."""
        url = f"{self.base_url}/{path.lstrip('/')}"
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
        return self._get("/balance")

    def generations_remaining(self):
        sub = self.balance().get("subscription", {})
        return float(sub.get("generations", 0) or 0)

    def ensure_budget(self, minimum):
        rem = self.generations_remaining()
        if rem < minimum:
            raise BudgetExhausted(f"only {rem:.0f} generations left (need >= {minimum})")
        return rem

    # -- scene generation (pixflux) -----------------------------------------

    def create_scene(self, description, width, height, view="high top-down",
                     outline=None, shading=None, detail=None, seed=None,
                     color_image=None, init_image=None, init_image_strength=300):
        """Draw a whole pixel-art map scene (pixflux). Synchronous; returns PIL.

        `color_image` steers the palette & rendering style (pass an art/palette
        reference for cohesion — the key lever). width/height 32-400."""
        payload = {
            "description": description,
            "image_size": {"width": int(width), "height": int(height)},
            "no_background": False,
        }
        if view is not None:
            payload["view"] = view
        if seed is not None:
            payload["seed"] = int(seed)
        if color_image is not None:
            payload["color_image"] = _img_to_b64obj(color_image)
        if init_image is not None:
            payload["init_image"] = _img_to_b64obj(init_image)
            payload["init_image_strength"] = int(init_image_strength)
        for k, v in (("outline", outline), ("shading", shading), ("detail", detail)):
            if v is not None:
                payload[k] = v
        resp = self._post("/create-image-pixflux", payload)
        return _b64_to_image(resp["image"]["base64"])
