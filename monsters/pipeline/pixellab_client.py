"""PixelLab API client for MONSTERS.

Monsters are authored on PixelLab in either of its two persistent stores, and
this client speaks to both. The maintainer tags every monster with the tag
"MONSTER" (in whichever store), so discovery = paginate both stores and filter
by tag — see `tagged_monsters()`.

  - **objects** (`v2/objects`, create-object UI): animations carry a
    `description` and per-direction frames under `storage_urls.frames`.
  - **characters** (`v2/characters`, create-character UI): animations carry an
    `animation_type` and per-direction frames directly under `frames`; while a
    regeneration is in flight the API can transiently return DUPLICATE entries
    for one direction (old + new copy) — the newest by Last-Modified wins.

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
from email.utils import parsedate_to_datetime

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

        Objects: merge duplicate groups per description, keeping the most
        frames per direction. Characters: `animation_type` names the animation;
        duplicate direction entries (transient, during in-place regeneration)
        resolve to the newest by Last-Modified of frame 0."""
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
                # PixelLab keeps EVERY take of a direction and the API marks
                # none of them current, so a duplicate is a real choice, not a
                # transient. An explicit pin (roster: direction_picks) decides
                # it; otherwise fall back to newest-by-Last-Modified and report
                # the direction as ambiguous so sync can flag it for review.
                pinned = want.get(d)
                chosen = next((c for c in cands if self.sub_id(c[0]) == pinned), None)
                if chosen is None:
                    stamped = [(self._lm_datetime(c[0]), c) for c in cands]
                    dated = [t for t in stamped if t[0] is not None]
                    pool = cands
                    if dated:
                        newest = max(t[0] for t in dated)
                        pool = [c for dt, c in dated if dt == newest]
                    chosen = max(pool, key=len)
                    ambiguous[d] = [self.sub_id(c[0]) for c in cands]
                dirs[d] = chosen
                subs[d] = self.sub_id(chosen[0])
            g["directions"] = dirs
            g["subs"] = subs
            g["ambiguous"] = ambiguous
            out.append(g)
        return out

    def _lm_datetime(self, url):
        lm = self.last_modified(url)
        if not lm:
            return None
        try:
            return parsedate_to_datetime(lm)
        except (TypeError, ValueError):
            return None

    # -- balance / budget ----------------------------------------------------

    def balance(self):
        return self._request("GET", BALANCE_URL)

    def generations_remaining(self):
        b = self.balance()
        sub = b.get("subscription", {})
        return float(sub.get("generations", b.get("credits", {}).get("usd", 0)) or 0)
