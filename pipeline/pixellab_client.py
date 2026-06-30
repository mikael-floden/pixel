"""Real PixelLab API client (async-job aware).

Base URL https://api.pixellab.ai/v2, Bearer auth from PIXELLAB_API_KEY.

PixelLab's character endpoints are asynchronous: a create/animate call returns
immediately with background job id(s); the actual pixels land later. This client
hides that — `create_character` / `animate` block until the art is ready and
return decoded Pillow images, so callers think synchronously.

Verified lifecycle (see spec):
  - create-character-v3 -> {character_id, background_job_id}; poll the job, then
    GET /characters/{id} for rotation_urls (one PNG per of 8 directions).
  - animate-character   -> {background_job_ids: [one per direction]}; each job's
    last_response.images is a list of {width, height?, base64 rgba_bytes} frames.
  - create-character-state -> a dressed sibling character ("wearing X"), stored
    on PixelLab (shared group_id); used for outfits.
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


def _img_to_b64obj(img):
    """PIL image -> PixelLab Base64Image object ({type, base64, format})."""
    import base64 as _b64
    import io as _io
    bio = _io.BytesIO()
    img.save(bio, "PNG")
    return {"type": "base64", "base64": _b64.b64encode(bio.getvalue()).decode(), "format": "png"}


def _b64_to_image(b64, width=None, height=None):
    """Decode either a PNG/JPEG base64 or raw rgba_bytes base64 into RGBA."""
    raw = base64.b64decode(b64)
    # Raw rgba_bytes path (animation frames) — width given, length == w*h*4.
    if width and len(raw) % 4 == 0 and (height is None or len(raw) == width * height * 4):
        h = height or (len(raw) // 4 // width)
        arr = np.frombuffer(raw, dtype=np.uint8).reshape(h, width, 4)
        return Image.fromarray(arr, "RGBA")
    # Encoded-image path (pixflux / base64 PNG).
    return Image.open(io.BytesIO(raw)).convert("RGBA")


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
                f"gitignored .env) before running the factory."
            )

    def _headers(self):
        self.require_key()
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def _post(self, path, payload):
        url = f"{self.base_url}/{path.lstrip('/')}"
        r = self._session.post(url, json=payload, headers=self._headers(), timeout=self.timeout)
        if r.status_code >= 400:
            raise PixelLabError(f"POST {path} -> {r.status_code}: {r.text[:300]}")
        return r.json()

    def _get(self, path):
        url = f"{self.base_url}/{path.lstrip('/')}"
        r = self._session.get(url, headers=self._headers(), timeout=self.timeout)
        if r.status_code >= 400:
            raise PixelLabError(f"GET {path} -> {r.status_code}: {r.text[:300]}")
        return r.json()

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

    # -- characters ----------------------------------------------------------

    def create_character(self, description, width, height, view="side",
                         template_id="mannequin", outline=None, shading=None,
                         detail=None, seed=None, reference_image=None,
                         job_timeout=900):
        """Create a character (8 rotations). Returns (character_id, {dir: PIL})."""
        payload = {
            "description": description,
            "image_size": {"width": width, "height": height},
            "view": view,
            "template_id": template_id,
        }
        # create-character-v3 does NOT accept `shading` (only outline/detail).
        for k, v in (("outline", outline), ("detail", detail),
                     ("seed", seed), ("reference_image", reference_image)):
            if v is not None:
                payload[k] = v
        resp = self._post("/create-character-v3", payload)
        cid = resp["character_id"]
        job = resp.get("background_job_id")
        if job:
            self.wait_job(job, timeout=job_timeout)
        rotations = self.fetch_rotations(cid)
        return cid, rotations

    def create_state(self, character_id, edit_description,
                     use_color_palette_from_reference=True, no_background=True,
                     seed=None, job_timeout=900):
        """Create an equipped/edited STATE of a character (e.g. 'wearing a hat').

        The state is a sibling character stored on PixelLab (shares group_id),
        visible in the UI and syncable. Returns (state_character_id, {dir: PIL})."""
        payload = {
            "character_id": character_id,
            "edit_description": edit_description,
            "use_color_palette_from_reference": use_color_palette_from_reference,
            "no_background": no_background,
        }
        if seed is not None:
            payload["seed"] = seed
        resp = self._post("/create-character-state", payload)
        sid = resp["character_id"]
        job = resp.get("background_job_id")
        if job:
            self.wait_job(job, timeout=job_timeout)
        return sid, self.fetch_rotations(sid)

    def list_characters(self):
        resp = self._get("/characters")
        if isinstance(resp, list):
            return resp
        return resp.get("characters") or resp.get("items") or []

    def get_character(self, character_id):
        return self._get(f"/characters/{character_id}")

    def fetch_rotations(self, character_id, wait=120, poll=5):
        """Download all rotation PNGs -> {direction: PIL}.

        Rotation CDN files can 404 for a few seconds after the job completes, so
        we retry only the still-missing directions in short rounds (capped by
        `wait`) instead of a long per-image backoff."""
        urls = {d: u for d, u in (self.get_character(character_id).get("rotation_urls") or {}).items() if u}
        out = {}
        deadline = time.monotonic() + wait
        while True:
            for direction in [d for d in urls if d not in out]:
                img = self._try_download(urls[direction])
                if img is not None:
                    out[direction] = img
            if len(out) == len(urls) or time.monotonic() > deadline:
                return out
            time.sleep(poll)

    def _try_download(self, url):
        try:
            r = self._session.get(url, timeout=self.timeout)
        except requests.RequestException:
            return None
        if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
            return Image.open(io.BytesIO(r.content)).convert("RGBA")
        return None

    def _animate_call(self, character_id, animation_name, action_description,
                      frame_count, directions, job_timeout):
        resp = self._post("/animate-character", {
            "character_id": character_id, "animation_name": animation_name,
            "action_description": action_description, "frame_count": frame_count,
            "directions": list(directions),
        })
        job_ids = resp.get("background_job_ids", [])
        dirs = resp.get("directions", list(directions))
        out = {}
        for direction, job_id in zip(dirs, job_ids):
            try:
                out[direction] = self._frames_from_response(
                    self.wait_job(job_id, timeout=job_timeout))
            except PixelLabError as e:
                print(f"  ! animate {animation_name} [{direction}] failed: {e}")
        return out

    def animate(self, character_id, animation_name, action_description,
                frame_count=6, directions=("east",), job_timeout=900):
        """Animate a character across directions. Returns {direction: [PIL frames]}.

        Tries one batched call; if it fails (e.g. one unsupported direction
        422s the whole request), retries each direction individually so a single
        bad orientation can't lose the rest."""
        dirs = list(directions)
        try:
            out = self._animate_call(character_id, animation_name, action_description,
                                     frame_count, dirs, job_timeout)
            if out:
                return out
        except PixelLabError as e:
            print(f"  ! batched animate failed ({e}); retrying per-direction")
        out = {}
        for d in dirs:
            try:
                out.update(self._animate_call(character_id, animation_name,
                                              action_description, frame_count, [d], job_timeout))
            except PixelLabError as e:
                print(f"  ! animate {animation_name} [{d}] failed: {e}")
        return out

    @staticmethod
    def _frames_from_response(last_response):
        frames = []
        for im in last_response.get("images", []):
            frames.append(_b64_to_image(im["base64"], im.get("width"), im.get("height")))
        return frames

