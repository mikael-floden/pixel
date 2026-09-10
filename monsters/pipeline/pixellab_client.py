"""PixelLab API client for MONSTERS.

Monsters are authored on PixelLab in either of its two persistent stores, and
this client speaks to both. The maintainer tags every monster with the tag
"MONSTER" (in whichever store), so discovery = paginate both stores and filter
by tag — see `tagged_monsters()`.

  - **objects** (`v2/objects`, create-object UI): animations carry a
    `description` and per-direction frames under `storage_urls.frames`.
  - **characters** (`v2/characters`, create-character UI): animations carry an
    `animation_type` and per-direction frames directly under `frames`.

  Either store can hold several TAKES of one direction (regenerating in the UI
  keeps the old take in the record, invisibly — no timestamp, no current-flag).
  The UI renders the LAST take in the response, so that is what gets mirrored;
  roster direction_picks can pin an older one.

`normalized_animations()` folds both shapes into one:
  [{name, group_id, directions: {direction: [frame_urls]}}]
so mirror.py has a single code path. Downloading is free (zero generations);
PixelLab is the source of truth for art and the repo mirrors it.

This is the monsters domain's own copy of the client (full isolation per
coordination/PROTOCOL.md).
"""

from __future__ import annotations

import base64
import io
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from PIL import Image

V2_BASE = "https://api.pixellab.ai/v2"
OBJECTS_URL = f"{V2_BASE}/objects"
CHARACTERS_URL = f"{V2_BASE}/characters"
BALANCE_URL = f"{V2_BASE}/balance"
API_KEY_ENV = "PIXELLAB_API_KEY"
MONSTER_TAG = "MONSTER"

# Stepwise compass rotation used for the combined "play, then rotate one step"
# GIFs — each neighbour is one 45° turn.
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
    def __init__(self, api_key=None, timeout=180, workers=8):
        self.api_key = api_key or os.environ.get(API_KEY_ENV)
        self.timeout = timeout
        self._local = threading.local()
        self.pool = ThreadPoolExecutor(max_workers=workers)

    @property
    def _session(self):
        # requests.Session is not guaranteed thread-safe; one per thread.
        s = getattr(self._local, "session", None)
        if s is None:
            s = self._local.session = requests.Session()
        return s

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

    def _request(self, method, path, retries=8, **kw):
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
                # 429 here is the ACCOUNT CONCURRENCY cap (20 background jobs,
                # Tier 3), not a rate limit: it clears only when a running job
                # finishes, which takes minutes. Back off in minutes, not
                # seconds, so a sweep queues behind its own workers instead of
                # burning its retries in half a minute and dying.
                slow = r.status_code == 429 and "concurrent background jobs" in r.text
                time.sleep(min(60 * (attempt + 1), 300) if slow else min(2 ** attempt, 30))
                continue
            if r.status_code >= 400:
                raise PixelLabError(f"{method} {path} -> {r.status_code}: {r.text[:300]}")
            return r.json()
        raise PixelLabError(f"{method} {path} failed after {retries} retries: {last}")

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

    def download_many(self, urls):
        """Download an ordered list of image URLs concurrently -> [PIL|None],
        order preserved."""
        return list(self.pool.map(self._download, urls))

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

    def last_modified(self, url):
        """Last-Modified header of a CDN file (HEAD), or None."""
        try:
            r = self._session.head(url, timeout=30)
            return r.headers.get("Last-Modified")
        except requests.RequestException:
            return None

    # -- discovery: the MONSTER tag is the ground truth ----------------------

    def _list_all(self, store, page=100):
        """Every record in a store — COMPLETE, or it raises.

        PixelLab's limit/offset paging is unstable: rows shift across page
        boundaries between requests, so naive sequential paging serves some
        records twice and MISSES others entirely. Measured 2026-07-31 on
        /v2/objects: the API reports total=218 while three back-to-back
        sequential sweeps each return 218 rows holding only 216 unique ids —
        deterministic, not a network blip (bug reported by the items agent,
        who lost two items to it).

        That is a data-loss bug here, not a cosmetic one: sync.py treats "not
        in this listing" as "untagged on PixelLab" and deletes the monster's
        folder. So we sweep with OVERLAPPING strides (advance by page//2, then
        retry at page//3), dedupe by id, and REFUSE to return a short list —
        callers must never see a silently incomplete roster."""
        seen, order, total = {}, [], None

        def sweep(stride):
            nonlocal total
            offset = 0
            while True:
                r = self._request("GET", f"{store}?limit={page}&offset={offset}")
                batch = r if isinstance(r, list) else r.get(store) or r.get("items") or []
                if isinstance(r, dict) and r.get("total") is not None:
                    total = int(r["total"])
                for it in batch:
                    i = it.get("id")
                    if i and i not in seen:
                        seen[i] = it
                        order.append(i)
                if not batch or len(batch) < page:
                    return
                offset += stride
                if total is not None and offset >= total + page:
                    return

        sweep(page // 2)
        if total is not None and len(seen) < total:
            sweep(max(1, page // 3))
        if total is not None and len(seen) < total:
            raise PixelLabError(
                f"{store}: listing incomplete after overlapping sweeps — got "
                f"{len(seen)} unique of {total} reported. REFUSING to return a "
                f"short list (sync would treat the missing ones as untagged and "
                f"delete their art). Retry; if it persists the API is degraded.")
        return [seen[i] for i in order]

    def tagged_monsters(self):
        """All MONSTER-tagged records across BOTH stores ->
        [{kind: object|character, id, name, tags}]. This is the discovery
        ground truth: a monster exists iff it carries the tag."""
        out = []
        for store, kind in (("objects", "object"), ("characters", "character")):
            for it in self._list_all(store):
                tags = [str(t).upper() for t in (it.get("tags") or [])]
                if MONSTER_TAG in tags:
                    out.append({"kind": kind, "id": it.get("id"),
                                "name": it.get("name"), "tags": it.get("tags")})
        return out

    # -- reads ---------------------------------------------------------------

    def get_object(self, object_id):
        return self._request("GET", f"objects/{object_id}")

    def get_character(self, character_id):
        return self._request("GET", f"characters/{character_id}")

    def get_source(self, kind, pixellab_id):
        """Detail record for a monster, `kind` in {'object', 'character'}."""
        if kind == "object":
            return self.get_object(pixellab_id)
        if kind == "character":
            return self.get_character(pixellab_id)
        raise PixelLabError(f"unknown source kind {kind!r} (want object|character)")

    @staticmethod
    def sub_id(url):
        """The per-direction sub-animation id embedded in a frame URL. PixelLab
        generates each direction as its own job, so this identifies WHICH take
        of a direction a frame belongs to."""
        try:
            return url.split("/animations/")[1].split("/")[0]
        except (IndexError, AttributeError):
            return None

    def normalized_animations(self, kind, detail, picks=None):
        """Fold both stores' animation shapes into one:
        [{name, group_id, display_name, directions: {direction: [urls]}}].

        Duplicate takes of one direction resolve to the LAST one in the
        response — that is the take the PixelLab UI renders, see below."""
        merged = {}
        for a in detail.get("animations") or []:
            name = (a.get("animation_type") if kind == "character" else None) \
                or a.get("description") or a.get("display_name") or a.get("animation_group_id")
            if not name:
                continue
            g = merged.setdefault(name, {"name": name,
                                         "group_id": a.get("animation_group_id"),
                                         "display_name": a.get("display_name"),
                                         "_cands": {}})
            for x in a.get("directions") or []:
                d = x.get("direction")
                urls = (x.get("storage_urls") or {}).get("frames") or x.get("frames") or []
                urls = [u for u in urls if u]
                if d and urls:
                    g["_cands"].setdefault(d, []).append(urls)
        out = []
        picks = picks or {}
        for g in merged.values():
            dirs, subs, ambiguous = {}, {}, {}
            want = picks.get(g["name"]) or {}
            for d, cands in g.pop("_cands").items():
                if len(cands) == 1:
                    dirs[d] = cands[0]
                    subs[d] = self.sub_id(cands[0][0])
                    continue
                # PixelLab keeps EVERY take of a direction; the record carries
                # no per-take timestamp and marks none current (checked
                # 2026-08-13: direction entries hold only direction /
                # frame_count / frames). The UI keys takes by (animation,
                # direction) as it walks this same array, so the LAST duplicate
                # is the one the UI renders — the only take the maintainer ever
                # sees. Mirror exactly that. An explicit pin (roster:
                # direction_picks) still wins for the rare case the OLDER take
                # is wanted.
                #
                # Do not resurrect a Last-Modified/HEAD tiebreak here: measured
                # against the UI over 19 real duplicates it agreed only ~half
                # the time (CDN upload time is not authoring order), and the
                # mismatch cost the maintainer finished animations, deleted
                # while chasing takes the UI never showed.
                pinned = want.get(d)
                chosen = next((c for c in cands if self.sub_id(c[0]) == pinned), None)
                if chosen is None:
                    chosen = cands[-1]
                    ambiguous[d] = [self.sub_id(c[0]) for c in cands]
                dirs[d] = chosen
                subs[d] = self.sub_id(chosen[0])
            g["directions"] = dirs
            g["subs"] = subs
            g["ambiguous"] = ambiguous
            out.append(g)
        return out

    # -- writes: candidate creation (the ONLY generation this domain does) ----

    def wait_job(self, job_id, timeout=900, interval=6):
        """Poll a background job to completion; returns the job record."""
        deadline = time.monotonic() + timeout
        while True:
            j = self._request("GET", f"background-jobs/{job_id}")
            st = j.get("status")
            if st == "completed":
                return j
            if st == "failed":
                raise PixelLabError(f"job {job_id} failed: {str(j.get('last_response'))[:300]}")
            if time.monotonic() > deadline:
                raise PixelLabError(f"job {job_id} timed out after {timeout}s")
            time.sleep(interval)

    def create_character_v3(self, description, size, view="low top-down",
                            template_id="mannequin", name=None, seed=None,
                            outline=None, detail=None, job_timeout=900):
        """Create an 8-direction character FROM SCRATCH (create-character-v3:
        Pixen draws a south sprite, v3 rotates it). Cost per the API contract:
        1 + ceil(size*size*8 / 65536) generations — 64px→2, 128px→3,
        176px→5. Returns (character_id, usage). Blocks until the job lands."""
        payload = {
            "description": description,
            "image_size": {"width": int(size), "height": int(size)},
            "view": view,
            "template_id": template_id,
        }
        if name:
            payload["name"] = name
        if seed is not None:
            payload["seed"] = int(seed)
        for k, v in (("outline", outline), ("detail", detail)):
            if v:
                payload[k] = v
        resp = self._request("POST", "create-character-v3", json=payload)
        cid = resp.get("character_id")
        job = resp.get("background_job_id")
        if job:
            self.wait_job(job, timeout=job_timeout)
        return cid, resp.get("usage")

    def character_rotations(self, character_id, wait=240, poll=5):
        """{direction: PIL} for all 8 rotations; keeps polling while the CDN
        files settle after generation."""
        deadline = time.monotonic() + wait
        out = {}
        while True:
            detail = self.get_character(character_id)
            urls = {d: u for d, u in (detail.get("rotation_urls") or {}).items() if u}
            missing = [d for d in urls if d not in out]
            for d, img in zip(missing, self.download_many([urls[d] for d in missing])):
                if img is not None:
                    out[d] = img
            if urls and len(out) == len(urls):
                return out
            if time.monotonic() > deadline:
                return out
            time.sleep(poll)

    def animate_v3(self, character_id, name, action, direction, frame_count=4,
                   end_frame=None, seed=None, keep_first=True):
        """Start ONE v3 custom animation job for ONE direction of an existing
        character. Returns the background job id.

        `end_frame` (PIL) turns on interpolation mode: the clip runs from the
        character's rotation image for `direction` to that pose — passing the
        rotation image itself pins a loop that starts and ends neutral (the
        maintainer's trick for calm idles). keep_first_frame stays True, so
        the stored clip is frame_count+1 frames with the base as frame 0."""
        payload = {
            "character_id": character_id,
            "animation_name": name,
            "action_description": action,
            "mode": "v3",
            "frame_count": int(frame_count),
            "directions": [direction],
            "keep_first_frame": bool(keep_first),
        }
        if end_frame is not None:
            payload["end_frame"] = _image_to_b64obj(end_frame)
        if seed is not None:
            payload["seed"] = int(seed)
        resp = self._request("POST", "characters/animations", json=payload)
        jobs = resp.get("background_job_ids") or []
        return jobs[0] if jobs else None

    def animate_template(self, character_id, template_animation_id, directions, seed=None):
        """SKELETON-DRIVEN animation from PixelLab's template library (mode
        "template", 1 generation per direction). The templates are per
        SKELETON (`template_id` on the character), not global — mannequin has
        cross-punch/high-kick/flying-kick/hurricane-kick/fireball, bear has
        attack-left/attack-right/jump-attack, dog has none. An invalid id is
        rejected with the valid list for that skeleton, which is how the list
        is discovered — but a request with a valid id and a bad DIRECTION
        starts a job that never finishes and holds a concurrency slot (20 per
        account, no cancel endpoint, deleting the animation group does not
        free it). Probe with a real direction or not at all."""
        payload = {"character_id": character_id, "mode": "template",
                   "template_animation_id": template_animation_id,
                   "directions": list(directions)}
        if seed is not None:
            payload["seed"] = int(seed)
        resp = self._request("POST", "characters/animations", json=payload)
        return resp.get("background_job_ids") or []

    def template_takes(self, character_id, template_animation_id):
        """{direction: [{"urls": [...], "group": gid}, ...]} for a template
        animation (stored under the template id, no "custom-" prefix)."""
        out = {}
        for a in self.get_character(character_id).get("animations") or []:
            if (a.get("animation_type") or "") != template_animation_id:
                continue
            for x in a.get("directions") or []:
                urls = [u for u in (x.get("frames") or []) if u]
                if x.get("direction") and urls:
                    out.setdefault(x["direction"], []).append(
                        {"urls": urls, "group": a.get("animation_group_id")})
        return out

    def skeleton_template(self, character_id):
        """The character's SKELETON id (mannequin, bear, dog, cat…) — decides
        which animation templates exist for it."""
        return (self.get_character(character_id) or {}).get("template_id")

    def animation_takes(self, character_id, action):
        """{direction: [[urls], ...]} — EVERY take of every direction of the
        v3 animations made from `action`. PixelLab ignores animation_name and
        stores a v3 clip as animation_type "custom-" + the first ~30 chars of
        the action text (measured 2026-09-09: 'custom-Calm still idle,
        breathing ver'), ONE entry per direction when end_frame pins a single
        direction — so several entries share one type. Callers pick; the last
        take is what the UI shows."""
        detail = self.get_character(character_id)
        out = {}
        for a in detail.get("animations") or []:
            t = a.get("animation_type") or ""
            if t.startswith("custom-") and (("custom-" + action).startswith(t) or t == ("custom-" + action)[:len(t)]):
                for x in a.get("directions") or []:
                    urls = [u for u in (x.get("frames") or []) if u]
                    if x.get("direction") and urls:
                        out.setdefault(x["direction"], []).append(
                            {"urls": urls, "group": a.get("animation_group_id")})
        return out

    def delete_animation(self, character_id, animation_type=None, group_id=None, direction=None):
        """Delete an animation (all directions, or one). PixelLab keys by
        animation_type or animation_group_id."""
        q = {}
        if group_id:
            q["animation_group_id"] = group_id
        elif animation_type:
            q["animation_type"] = animation_type
        if direction:
            q["direction"] = direction
        return self._request("DELETE", f"characters/{character_id}/animations", params=q)

    def set_character_tags(self, character_id, tags):
        """REPLACES the character's tag list (PATCH semantics on PixelLab)."""
        return self._request("PATCH", f"characters/{character_id}/tags", json={"tags": list(tags)})

    def delete_character(self, character_id):
        return self._request("DELETE", f"characters/{character_id}")

    # -- balance / budget ----------------------------------------------------

    def balance(self):
        return self._request("GET", BALANCE_URL)

    def usd_credits(self):
        return float(self.balance().get("credits", {}).get("usd", 0) or 0)

    def generations_remaining(self):
        b = self.balance()
        sub = b.get("subscription", {})
        return float(sub.get("generations", b.get("credits", {}).get("usd", 0)) or 0)
