"""PixelLab API client for the TILES2 domain — isometric tile generation.

tiles2 generates isometric terrain tiles via the async `create-tiles-pro`
endpoint. POST returns {tile_id, background_job_id}; poll the job, then the
completed job's `last_response.images` holds the tiles as RAW RGBA bytes (base64)
with width/height (NOT PNG). `create_tiles` hides all that and returns decoded
Pillow images.

House format (tiles2 is a breaking change from tiles v1):
    tile_type=isometric, tile_size=64, tile_view="high top-down",
    tile_view_angle=28.0, tile_depth_ratio=0.50, tile_flat_top_px=2.
There is deliberately NO outline (create-tiles-pro has no outline param; we ask
for lineless in the prompt and remove any residual outline in post-process).

Base URL https://api.pixellab.ai/v2, Bearer auth from PIXELLAB_API_KEY.
Isolated per-domain copy (see repo CLAUDE.md / coordination/PROTOCOL.md).
"""

from __future__ import annotations

import base64
import io
import os
import time

import numpy as np
import requests
from PIL import Image

BASE_URL = "https://api.pixellab.ai/v2"
API_KEY_ENV = "PIXELLAB_API_KEY"


class PixelLabError(RuntimeError):
    pass


class BudgetExhausted(PixelLabError):
    pass


def _decode_tile(item):
    """Decode one tiles-pro image item -> RGBA PIL. Items are raw rgba bytes with
    width/height; fall back to PNG if the bytes happen to be encoded."""
    raw = base64.b64decode(item["base64"] if isinstance(item, dict) else item)
    w = item.get("width") if isinstance(item, dict) else None
    h = item.get("height") if isinstance(item, dict) else None
    try:
        return Image.open(io.BytesIO(raw)).convert("RGBA")
    except Exception:
        if w and h and len(raw) == w * h * 4:
            return Image.fromarray(np.frombuffer(raw, np.uint8).reshape(h, w, 4), "RGBA")
        n = len(raw) // 4
        s = int(n ** 0.5)
        return Image.fromarray(np.frombuffer(raw, np.uint8)[:s * s * 4].reshape(s, s, 4), "RGBA")


class PixelLabClient:
    def __init__(self, api_key=None, base_url=BASE_URL, timeout=180):
        self.api_key = api_key or os.environ.get(API_KEY_ENV)
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = requests.Session()

    def require_key(self):
        if not self.api_key:
            raise PixelLabError(
                f"{API_KEY_ENV} is not set. Export your PixelLab key (gitignored .env).")

    def _headers(self):
        self.require_key()
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def _request(self, method, path, retries=5, **kw):
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

    # -- budget --------------------------------------------------------------

    def balance(self):
        return self._get("/balance")

    def generations_remaining(self):
        return float(self.balance().get("subscription", {}).get("generations", 0) or 0)

    def ensure_budget(self, minimum):
        rem = self.generations_remaining()
        if rem < minimum:
            raise BudgetExhausted(f"only {rem:.0f} generations left (need >= {minimum})")
        return rem

    def wait_job(self, job_id, timeout=900, interval=6):
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

    # -- isometric tile sets -------------------------------------------------

    def create_tiles(self, description, tile_size=64, tile_view="high top-down",
                     view_angle=28.0, depth_ratio=0.50, tile_type="isometric",
                     flat_top_px=2, tile_height=None, seed=None, job_timeout=900):
        """Generate one isometric tile SET (variations from the numbered
        `description`). Returns [PIL, ...]. ~20 generations per call.

        Sends the fixed tiles2 house format; `view_angle`/`depth_ratio` override
        the `tile_view` preset per the API (angle=side..top-down, depth=thickness).
        """
        payload = {
            "description": description,
            "tile_type": tile_type,
            "tile_size": int(tile_size),
            "tile_view": tile_view,
            "tile_view_angle": float(view_angle),
            "tile_depth_ratio": float(depth_ratio),
        }
        if tile_height is not None:
            payload["tile_height"] = int(tile_height)
        if flat_top_px is not None:
            payload["tile_flat_top_px"] = int(flat_top_px)
        if seed is not None:
            payload["seed"] = int(seed)
        resp = self._post("/create-tiles-pro", payload)
        job = resp.get("background_job_id")
        last = self.wait_job(job, timeout=job_timeout) if job else resp
        images = last.get("images") or []
        return [_decode_tile(im) for im in images]
