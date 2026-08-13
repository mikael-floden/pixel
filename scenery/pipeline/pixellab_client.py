"""PixelLab API client for the SCENERY domain (this domain's own copy — each
domain keeps its own `pixellab_client.py`, per coordination/PROTOCOL.md).

Scenery pieces persist as PixelLab **objects** on the `/v2` API ("object" is
PixelLab's product term; the repo mirrors the store):

  - `create-8-direction-object` -> `{object_id, background_job_id}`; poll the
    job, then `GET /objects/{id}` for the 8 `rotation_urls`.
  - `POST /objects/{id}/animations` -> an animation group whose frames land
    asynchronously per direction; poll `GET /objects/{id}` until all 8
    directions carry `storage_urls.frames`, then download.
  - `GET /objects` (list), `DELETE /objects/{id}`, `/v2/balance` for budget.

The old stateless `/v1` image tools (generate-image-pixflux / rotate /
animate-with-text) remain at the bottom for one-off sprites; they return the
finished art inline as Base64 with `{"usage": {"generations": N}}`. Verified
live against the API (see scenery/spec/SCENERY_SPEC.md).

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
# Server-side object store lives on v2. create-8-direction-object persists a real
# object (8 rotations) that shows in the PixelLab "create-object" UI, is
# animatable, and is syncable — the object analogue of the character system.
V2_BASE = "https://api.pixellab.ai/v2"
OBJECTS_URL = f"{V2_BASE}/objects"
API_KEY_ENV = "PIXELLAB_API_KEY"

# animate-with-text only accepts an exactly 64x64 canvas (min 64 AND max 64), so
# any animated object is generated at 64x64. rotate only accepts a square canvas
# from this set. Static pixflux sprites are free to be other sizes.
ANIMATE_SIZE = 64
ROTATE_SIZES = (16, 32, 64, 128)
# Every object is 8-direction, and every animation must cover all 8 (the API
# animates only the directions you pass — omitting it does a single direction).
DIRECTIONS_8 = ("south", "south-east", "east", "north-east",
                "north", "north-west", "west", "south-west")


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

    # -- server-side object store (v2/objects) -------------------------------
    #
    # PixelLab keeps a server-side "Object creator" store at v2/objects. Since
    # 2026-08 the API creates into it directly (create-1-direction-object /
    # create-8-direction-object) — the old "POST /objects -> 405" note predates
    # that. Sync uses these reads to (a) mirror any object a human authored or
    # regenerated in the UI and (b) keep repo/PixelLab deletions in lockstep.

    PAGE = 100  # the API's hard cap (limit > 100 is a 422)

    def _objects_page(self, offset):
        r = self._request("GET", f"{OBJECTS_URL}?limit={self.PAGE}&offset={offset}")
        if isinstance(r, list):
            return r, None
        return (r.get("objects") or r.get("items") or []), r.get("total")

    def list_objects(self):
        """EVERY object in the store, deduped by id — never a single page.

        PixelLab's limit/offset pagination is NOT stable (the items agent
        measured consecutive pages repeating one record and skipping another),
        and a short listing is DANGEROUS here: deletion parity treats "not in
        the listing" as "deleted upstream" and removes repo folders. The 2026-
        08-12 incident proved it — a single-page listing of a 228-object store
        made parity delete the three game-referenced legacy pieces. So pages
        OVERLAP (offset advances by half a page, then a third on the retry
        sweep), ids are deduped, and a listing shorter than the server's own
        `total` RAISES instead of being returned."""
        seen, total = {}, None
        for stride in (self.PAGE // 2, self.PAGE // 3):
            offset = 0
            while True:
                batch, t = self._objects_page(offset)
                if t is not None:
                    total = t
                for it in batch:
                    if it.get("id"):
                        seen[it["id"]] = it
                if not batch:
                    break
                offset += stride
                if total is not None and offset >= total:
                    break
            if total is None or len(seen) >= total:
                break
        if total is not None and len(seen) < total:
            raise PixelLabError(
                f"objects: listed only {len(seen)} of {total} records — the API's "
                f"pagination is dropping rows. Refusing to return a short list: "
                f"deletion parity prunes what a listing omits.")
        return list(seen.values())

    def get_object(self, object_id):
        return self._request("GET", f"{OBJECTS_URL}/{object_id}")

    def delete_object(self, object_id):
        return self._request("DELETE", f"{OBJECTS_URL}/{object_id}")

    def conditional_download(self, url, if_modified=None):
        """GET an image, optionally conditional on If-Modified-Since. Returns
        (status, PIL|None, last_modified). A 304 downloads no body — that's how
        sync skips unchanged art (mirrors the characters agent's approach)."""
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

    # -- scenery v2: batched 1-direction objects ------------------------------
    #
    # The v2 factory's whole cost model rides on ONE API rule: a
    # create-1-direction-object call costs 20-40 generations but yields
    # MULTIPLE candidate objects at once when the size allows it (<=42px -> 64
    # candidates, <=85 -> 16, <=170 -> 4, else 1), each candidate drawable from
    # its own `item_descriptions` entry. The call lands in status 'review';
    # select-frames turns kept candidates into completed individual objects and
    # tags them all (`common_tag`) in the same request.

    def create_1d_batch(self, description, size, item_descriptions=None, view="top-down"):
        """Queue one batched 1-direction create. Returns the raw response
        ({object_id, background_job_id, ...}) without waiting."""
        payload = {"description": description, "size": int(size), "view": view}
        if item_descriptions:
            payload["item_descriptions"] = list(item_descriptions)
        return self._request("POST", f"{V2_BASE}/create-1-direction-object", json=payload)

    def wait_object(self, object_id, want=("review", "completed"), timeout=1200, interval=6):
        """Poll GET /objects/{id} until it reaches one of `want` (or fails)."""
        deadline = time.monotonic() + timeout
        while True:
            o = self.get_object(object_id)
            st = o.get("status")
            if st in want:
                return o
            if st == "failed":
                raise PixelLabError(f"object {object_id} generation failed")
            if time.monotonic() > deadline:
                raise PixelLabError(f"object {object_id} still '{st}' after {timeout}s")
            time.sleep(interval)

    def select_frames(self, object_id, indices, common_tag=None):
        """Keep review candidates as completed individual objects; `common_tag`
        tags every newly-created object in the same call."""
        payload = {"indices": list(indices)}
        if common_tag:
            payload["common_tag"] = common_tag
        return self._request("POST", f"{OBJECTS_URL}/{object_id}/select-frames", json=payload)

    def dismiss_review(self, object_id):
        return self._request("POST", f"{OBJECTS_URL}/{object_id}/dismiss-review", json={})

    def set_tags(self, object_id, tags):
        """Replace ALL tags on an object (max 20 tags, 50 chars each)."""
        return self._request("PATCH", f"{OBJECTS_URL}/{object_id}/tags", json={"tags": list(tags)})

    @staticmethod
    def sprite_url(detail):
        """The single image URL of a 1-direction object's detail record.
        1-direction objects carry null rotation_urls; the art lives in
        storage_urls (or, in review status, frame_urls)."""
        rot = detail.get("rotation_urls") or {}
        if rot.get("south"):
            return rot["south"]
        storage = detail.get("storage_urls") or {}
        for v in storage.values():
            if isinstance(v, str) and v:
                return v
            if isinstance(v, dict):
                for u in v.values():
                    if isinstance(u, str) and u:
                        return u
        frames = detail.get("frame_urls") or []
        if frames:
            return frames[0]
        return detail.get("preview_url")

    # -- persistent 8-direction objects (create-object UI + animations) ------

    def wait_job(self, job_id, timeout=900, interval=6):
        """Block until a background job completes; return its payload."""
        deadline = time.monotonic() + timeout
        while True:
            j = self._request("GET", f"{V2_BASE}/background-jobs/{job_id}")
            st = j.get("status")
            if st == "completed":
                return j
            if st == "failed":
                raise PixelLabError(f"job {job_id} failed: {str(j.get('last_response'))[:200]}")
            if time.monotonic() > deadline:
                raise PixelLabError(f"job {job_id} timed out after {timeout}s")
            time.sleep(interval)

    def submit_object(self, description, size=64, view="low top-down"):
        """Submit an 8-direction create WITHOUT waiting for the job — the
        parallel loop keeps many of these in flight and polls get_object().
        Returns the object_id immediately."""
        payload = {"description": description, "size": int(size), "view": view}
        resp = self._request("POST", f"{V2_BASE}/create-8-direction-object", json=payload)
        oid = resp.get("object_id") or resp.get("id")
        if not oid:
            raise PixelLabError(f"create returned no object_id: {str(resp)[:200]}")
        return oid

    def create_object(self, description, size=64, view="low top-down",
                      style_image=None, reference_image=None, job_timeout=900):
        """Create a persistent 8-direction object (shows in the create-object UI,
        animatable, syncable). Returns its object_id."""
        payload = {"description": description, "size": int(size), "view": view}
        if style_image is not None:
            payload["style_image"] = _image_to_b64obj(style_image)
        if reference_image is not None:
            payload["reference_image"] = _image_to_b64obj(reference_image)
        resp = self._request("POST", f"{V2_BASE}/create-8-direction-object", json=payload)
        oid = resp.get("object_id") or resp.get("id")
        job = resp.get("background_job_id")
        if job:
            self.wait_job(job, timeout=job_timeout)
        return oid

    def _download(self, url, retries=4):
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

    def download_object_rotations(self, object_id, wait=180, poll=5):
        """All 8 rotation PNGs -> {direction: PIL}. Retries directions whose CDN
        file 404s briefly right after generation."""
        deadline = time.monotonic() + wait
        out = {}
        while True:
            urls = {d: u for d, u in (self.get_object(object_id).get("rotation_urls") or {}).items() if u}
            for d in [d for d in urls if d not in out]:
                img = self._download(urls[d])
                if img is not None:
                    out[d] = img
            if urls and len(out) == len(urls):
                return out
            if time.monotonic() > deadline:
                return out
            time.sleep(poll)

    def animate_object(self, object_id, animation_description, frame_count=4,
                       directions=None, display_name=None, replace_existing=True,
                       job_timeout=900):
        """Add an animation to an object across `directions` (default ALL 8 —
        the API animates only the directions you pass). Returns the
        animation_group_id; frames are fetched via download_object_animation."""
        payload = {"animation_description": animation_description,
                   "frame_count": int(frame_count), "replace_existing": replace_existing,
                   "directions": list(directions) if directions else list(DIRECTIONS_8)}
        if display_name:
            payload["display_name"] = display_name
        resp = self._request("POST", f"{OBJECTS_URL}/{object_id}/animations", json=payload)
        for job in (resp.get("background_job_ids") or []):
            try:
                self.wait_job(job, timeout=job_timeout)
            except PixelLabError as e:
                print(f"  ! animation job failed: {e}")
        return resp.get("animation_group_id")

    def download_object_animation(self, object_id, group_id, expected=8, wait=600,
                                  poll=8, stall=120):
        """Poll until the animation group has frames for all `expected` directions
        (they land asynchronously, one direction at a time), THEN download them ->
        {direction: [PIL frames]}.

        Returns as soon as all 8 are ready. If new directions STOP arriving for
        `stall` seconds (the animation stalled short of 8), it accepts whatever is
        present rather than waiting out the full `wait` — otherwise a partial
        animation burns ~10 minutes of the pass for nothing."""
        deadline = time.monotonic() + wait
        last_n, stall_since = -1, time.monotonic()
        while True:
            group = None
            for a in (self.get_object(object_id).get("animations") or []):
                if a.get("animation_group_id") == group_id:
                    group = a
                    break
            ready = []
            if group:
                ready = [d for d in (group.get("directions") or [])
                         if (d.get("storage_urls") or {}).get("frames")]
            n = len(ready)
            if n != last_n:
                last_n, stall_since = n, time.monotonic()
            stalled = (time.monotonic() - stall_since) >= stall
            done = n >= expected or time.monotonic() > deadline or (n >= 1 and stalled)
            if ready and done:
                out = {}
                for d in ready:
                    urls = (d.get("storage_urls") or {}).get("frames") or []
                    imgs = [im for im in (self._download(u) for u in urls) if im is not None]
                    if imgs:
                        out[d.get("direction")] = imgs
                return out
            if time.monotonic() > deadline:
                return {}
            time.sleep(poll)

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
