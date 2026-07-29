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

    def _list_all(self, store):
        """Every record in a store, following limit/offset pagination."""
        items, offset = [], 0
        while True:
            r = self._request("GET", f"{store}?limit=100&offset={offset}")
            batch = r if isinstance(r, list) else r.get(store) or r.get("items") or []
            items += batch
            offset += len(batch)
            total = r.get("total") if isinstance(r, dict) else None
            if not batch or len(batch) < 100 or (total is not None and offset >= total):
                return items

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

    def normalized_animations(self, kind, detail):
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
        for g in merged.values():
            dirs = {}
            for d, cands in g.pop("_cands").items():
                if len(cands) == 1:
                    dirs[d] = cands[0]
                    continue
                # objects: keep most frames; ties (and characters) -> newest
                best = max(cands, key=len)
                same_len = [c for c in cands if len(c) == len(best)]
                if len(same_len) > 1:
                    stamped = [(self.last_modified(c[0]) or "", c) for c in same_len]
                    best = max(stamped, key=lambda t: t[0])[1]
                dirs[d] = best
            g["directions"] = dirs
            out.append(g)
        return out

    # -- balance / budget ----------------------------------------------------

    def balance(self):
        return self._request("GET", BALANCE_URL)

    def generations_remaining(self):
        b = self.balance()
        sub = b.get("subscription", {})
        return float(sub.get("generations", b.get("credits", {}).get("usd", 0)) or 0)
