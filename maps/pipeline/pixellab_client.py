"""PixelLab API client for the MAPS domain (async-job aware).

Base URL https://api.pixellab.ai/v2, Bearer auth from PIXELLAB_API_KEY.

This is a deliberately *isolated* copy of the client (the characters domain keeps
its own copy too — see the repo CLAUDE.md), specialised for the map/tileset
endpoints. As with characters, PixelLab's generation endpoints are asynchronous:
a create call returns immediately with a background job id and the pixels land
later. This client hides that — every method blocks until the art is ready and
returns decoded Pillow images, so callers are effectively synchronous.

Verified endpoints (probed against the live API):
  - create-tileset      -> {tileset_id, background_job_id}; poll the job, then
    GET /tilesets/{id} for `tileset.tiles` (a Wang set: 16 tiles, or 23 with a
    transition band). Each tile has a base64 PNG `image` and `corners`
    {NW,NE,SW,SE} classified as one of `terrain_types` (e.g. lower/upper).
  - map-objects         -> {object_id, background_job_id}; the job's
    last_response.image is a base64 PNG of a transparent prop.
  - create-image-pixflux -> returns {image} synchronously (a whole scene / tile).
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
    """Decode a base64 PNG (map endpoints return encoded PNGs, not raw rgba)."""
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
    def __init__(self, api_key=None, base_url=BASE_URL, timeout=120):
        self.api_key = api_key or os.environ.get(API_KEY_ENV)
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = requests.Session()

    # -- internals -----------------------------------------------------------

    def require_key(self):
        if not self.api_key:
            raise PixelLabError(
                f"{API_KEY_ENV} is not set. Export your PixelLab key (kept in a "
                f"gitignored .env) before running the maps loop."
            )

    def _headers(self):
        self.require_key()
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def _request(self, method, path, retries=5, **kw):
        """HTTP with retry on transient network/proxy errors and 5xx, so the
        autonomous loop survives the agent proxy occasionally dropping a
        connection. 4xx are real errors and raise immediately."""
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

    # -- job polling ---------------------------------------------------------

    def wait_job(self, job_id, timeout=900, interval=8):
        """Block until a background job completes; return its last_response."""
        deadline = time.monotonic() + timeout
        while True:
            j = self._get(f"/background-jobs/{job_id}")
            st = j.get("status")
            if st == "completed":
                return j.get("last_response") or {}
            if st == "failed":
                raise PixelLabError(f"job {job_id} failed: {str(j.get('last_response'))[:200]}")
            if time.monotonic() > deadline:
                raise PixelLabError(f"job {job_id} timed out after {timeout}s")
            time.sleep(interval)

    # -- style helpers -------------------------------------------------------

    @staticmethod
    def _add_style(payload, outline, shading, detail):
        for k, v in (("outline", outline), ("shading", shading), ("detail", detail)):
            if v is not None:
                payload[k] = v
        return payload

    # -- tilesets (Wang) -----------------------------------------------------

    def create_tileset(self, lower_description, upper_description,
                       transition_description="", tile_size=16, view="high top-down",
                       transition_size=0.0, outline=None, shading=None, detail=None,
                       seed=None, job_timeout=900, color_image=None,
                       lower_reference_image=None, upper_reference_image=None):
        """Create a Wang tileset (two seamlessly-connecting terrain levels).

        Returns (tileset_id, terrain_types, [tile,...]) where each tile is a dict
        {name, corners:{NW,NE,SW,SE}, image:PIL, id}. `corners` classify each of
        the four corners as one of terrain_types (e.g. 'lower'/'upper', plus
        'transition' when transition_size>0). The Wang set covers every corner
        combination, so a renderer can pick a tile purely from its 4 corners."""
        payload = {
            "lower_description": lower_description,
            "upper_description": upper_description,
            "tile_size": {"width": int(tile_size), "height": int(tile_size)},
            "view": view,
            "transition_size": float(transition_size),
        }
        if transition_description:
            payload["transition_description"] = transition_description
        if seed is not None:
            payload["seed"] = int(seed)
        # Style/palette guidance: pass a reference image (e.g. an art screenshot)
        # so PixelLab imitates its palette & rendering — the closest lever to an
        # art director for cohesion.
        if color_image is not None:
            payload["color_image"] = _img_to_b64obj(color_image)
        if lower_reference_image is not None:
            payload["lower_reference_image"] = _img_to_b64obj(lower_reference_image)
        if upper_reference_image is not None:
            payload["upper_reference_image"] = _img_to_b64obj(upper_reference_image)
        self._add_style(payload, outline, shading, detail)
        resp = self._post("/create-tileset", payload)
        tileset_id = resp["tileset_id"]
        job = resp.get("background_job_id")
        if job:
            self.wait_job(job, timeout=job_timeout)
        full = self._get(f"/tilesets/{tileset_id}")
        tsd = full["tileset"]
        tiles = []
        for t in tsd["tiles"]:
            tiles.append({
                "id": t.get("id"),
                "name": t.get("name"),
                "corners": t["corners"],
                "image": _b64_to_image(t["image"]["base64"]),
            })
        return tileset_id, tsd.get("terrain_types", ["lower", "upper"]), tiles

    # -- map objects (transparent props) ------------------------------------

    def create_map_object(self, description, size=64, view="high top-down",
                          outline=None, shading=None, detail=None, seed=None,
                          job_timeout=900):
        """Create a single transparent map object/prop. Returns a PIL image."""
        payload = {
            "description": description,
            "image_size": {"width": int(size), "height": int(size)},
            "view": view,
        }
        if seed is not None:
            payload["seed"] = int(seed)
        self._add_style(payload, outline, shading, detail)
        resp = self._post("/map-objects", payload)
        job = resp.get("background_job_id")
        last = self.wait_job(job, timeout=job_timeout) if job else resp
        img_b64 = last.get("image") or (last.get("images") or [None])[0]
        if not img_b64:
            raise PixelLabError(f"map-object '{description}' returned no image")
        return _b64_to_image(img_b64)

    # -- pixflux scenes (whole images) --------------------------------------

    def create_scene(self, description, width, height, view="high top-down",
                     no_background=False, outline=None, shading=None, detail=None,
                     seed=None, color_image=None, init_image=None, init_image_strength=300):
        """Generate a whole pixel-art image (pixflux). Synchronous. Returns PIL.

        Useful for establishing / backdrop art (e.g. a painted cave interior) —
        not a tilemap, just a picture. width/height 32-400. `color_image` guides
        the palette (e.g. an art screenshot); `init_image` seeds composition."""
        payload = {
            "description": description,
            "image_size": {"width": int(width), "height": int(height)},
            "no_background": bool(no_background),
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
        self._add_style(payload, outline, shading, detail)
        resp = self._post("/create-image-pixflux", payload)
        return _b64_to_image(resp["image"]["base64"])
