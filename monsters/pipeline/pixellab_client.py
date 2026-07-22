"""PixelLab API client for MONSTERS.

A monster can be authored on PixelLab in either of its two persistent stores,
and this client speaks to both (a maintainer decision — the first monster, the
poring, was made in the create-object UI):

  - **objects** (`v2/objects`, create-object UI): 8-direction sprites with
    animation groups. Created via `create-8-direction-object`, animated via
    `POST v2/objects/<id>/animations`.
  - **characters** (`v2/characters`, create-character UI): rigged humanoids on
    skeleton templates (Bear/Cat/Dog/Horse/Lion/humanoid...), animated via
    skeleton animations.

Both stores expose the same read shape — `rotation_urls` + `animations[]` with
per-direction `storage_urls.frames` — so `mirror.py` can package either with one
code path. Downloading is free (zero generations); PixelLab is the source of
truth for a monster's art and the repo mirrors it.

This is the monsters domain's own copy of the client (full isolation per
coordination/PROTOCOL.md). Object create/animate is ported from the proven
objects-agent client; character *creation* is not implemented yet — port it from
characters2/pipeline/pixellab_client.py when the first character-based monster
is generated.
"""

from __future__ import annotations

import base64
import io
import os
import time

import requests
from PIL import Image

V2_BASE = "https://api.pixellab.ai/v2"
OBJECTS_URL = f"{V2_BASE}/objects"
CHARACTERS_URL = f"{V2_BASE}/characters"
BALANCE_URL = f"{V2_BASE}/balance"
API_KEY_ENV = "PIXELLAB_API_KEY"

DIRECTIONS_8 = ("south", "south-east", "east", "north-east",
                "north", "north-west", "west", "south-west")


class PixelLabError(RuntimeError):
    pass


class BudgetExhausted(PixelLabError):
    pass


def _image_to_b64obj(img):
    """RGBA Pillow image -> PixelLab Base64Image object (PNG)."""
    bio = io.BytesIO()
    img.convert("RGBA").save(bio, "PNG")
    return {"type": "base64", "base64": base64.b64encode(bio.getvalue()).decode(), "format": "png"}


class PixelLabClient:
    def __init__(self, api_key=None, timeout=180):
        self.api_key = api_key or os.environ.get(API_KEY_ENV)
        self.timeout = timeout
        self._session = requests.Session()

    # -- internals -----------------------------------------------------------

    def require_key(self):
        if not self.api_key:
            raise PixelLabError(
                f"{API_KEY_ENV} is not set. Export your PixelLab key (kept in a "
                f"gitignored .env) before running monsters tooling."
            )

    def _headers(self):
        self.require_key()
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def _request(self, method, path, retries=5, **kw):
        """HTTP with retry on transient network errors and 5xx/429. 4xx (except
        429) are real request errors and raise immediately."""
        url = path if path.startswith("http") else f"{V2_BASE}/{path.lstrip('/')}"
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

    def wait_job(self, job_id, timeout=900, interval=6):
        """Block until a background job completes; return its payload."""
        deadline = time.monotonic() + timeout
        while True:
            j = self._request("GET", f"background-jobs/{job_id}")
            st = j.get("status")
            if st == "completed":
                return j
            if st == "failed":
                raise PixelLabError(f"job {job_id} failed: {str(j.get('last_response'))[:200]}")
            if time.monotonic() > deadline:
                raise PixelLabError(f"job {job_id} timed out after {timeout}s")
            time.sleep(interval)

    def _download(self, url, retries=4):
        """One CDN image -> PIL (RGBA). CDN URLs can briefly 404 right after a
        job completes, so retry."""
        for _ in range(retries):
            try:
                r = self._session.get(url, timeout=self.timeout)
            except requests.RequestException:
                r = None
            if r is not None and r.status_code == 200 \
                    and r.headers.get("content-type", "").startswith("image"):
                return Image.open(io.BytesIO(r.content)).convert("RGBA")
            time.sleep(2)
        return None

    def conditional_download(self, url, if_modified=None):
        """GET an image, optionally conditional on If-Modified-Since. Returns
        (status, PIL|None, last_modified). A 304 downloads no body — that's how
        re-mirrors skip unchanged art."""
        headers = {"If-Modified-Since": if_modified} if if_modified else {}
        try:
            r = self._session.get(url, headers=headers, timeout=self.timeout)
        except requests.RequestException:
            return 0, None, if_modified
        if r.status_code == 304:
            return 304, None, if_modified
        if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
            return 200, Image.open(io.BytesIO(r.content)).convert("RGBA"), r.headers.get("Last-Modified")
        return r.status_code, None, if_modified

    # -- reads: both stores share one shape ----------------------------------

    def get_object(self, object_id):
        return self._request("GET", f"objects/{object_id}")

    def list_objects(self):
        resp = self._request("GET", OBJECTS_URL)
        if isinstance(resp, list):
            return resp
        return resp.get("objects") or resp.get("items") or []

    def get_character(self, character_id):
        return self._request("GET", f"characters/{character_id}")

    def get_source(self, kind, pixellab_id):
        """Fetch the detail record for a monster's source, `kind` in
        {'object', 'character'}. Both return rotation_urls + animations[]."""
        if kind == "object":
            return self.get_object(pixellab_id)
        if kind == "character":
            return self.get_character(pixellab_id)
        raise PixelLabError(f"unknown source kind {kind!r} (want object|character)")

    # -- generation: objects (ported from the objects agent, proven) ---------

    def create_object(self, description, size=64, view="low top-down",
                      style_image=None, reference_image=None, job_timeout=900):
        """Create a persistent 8-direction object (shows in the create-object UI,
        animatable, syncable). Returns its object_id."""
        payload = {"description": description, "size": int(size), "view": view}
        if style_image is not None:
            payload["style_image"] = _image_to_b64obj(style_image)
        if reference_image is not None:
            payload["reference_image"] = _image_to_b64obj(reference_image)
        resp = self._request("POST", "create-8-direction-object", json=payload)
        oid = resp.get("object_id") or resp.get("id")
        job = resp.get("background_job_id")
        if job:
            self.wait_job(job, timeout=job_timeout)
        return oid

    def animate_object(self, object_id, animation_description, frame_count=4,
                       directions=None, display_name=None, replace_existing=True,
                       job_timeout=900):
        """Add an animation to an object across `directions` (default ALL 8 —
        the API animates only the directions you pass). Returns the
        animation_group_id."""
        payload = {"animation_description": animation_description,
                   "frame_count": int(frame_count), "replace_existing": replace_existing,
                   "directions": list(directions) if directions else list(DIRECTIONS_8)}
        if display_name:
            payload["display_name"] = display_name
        resp = self._request("POST", f"objects/{object_id}/animations", json=payload)
        for job in (resp.get("background_job_ids") or []):
            try:
                self.wait_job(job, timeout=job_timeout)
            except PixelLabError as e:
                print(f"  ! animation job failed: {e}")
        return resp.get("animation_group_id")

    # -- balance / budget ----------------------------------------------------

    def balance(self):
        return self._request("GET", BALANCE_URL)

    def generations_remaining(self):
        b = self.balance()
        sub = b.get("subscription", {})
        return float(sub.get("generations", b.get("credits", {}).get("usd", 0)) or 0)

    def ensure_budget(self, minimum):
        rem = self.generations_remaining()
        if rem < minimum:
            raise BudgetExhausted(f"only {rem:.0f} generations left (need >= {minimum})")
        return rem
