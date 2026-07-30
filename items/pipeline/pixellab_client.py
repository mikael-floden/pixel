"""PixelLab API client for ITEMS.

Items are authored by the maintainer in the PixelLab **create-object** UI and
tagged with their item TYPE — `MISC`, `SOUL`, `CONSUMABLE`, `SWORD`, `BOW`,
`WAND`, `ARMOR` (see `config/types.json`). Those tags are the single source of
truth for *which* items exist and *what kind* each one is, so discovery =
paginate the objects store and keep everything carrying a known type tag —
`tagged_items()`.

Unlike a monster, an item is one still sprite: a single-direction object
(`directions: 1`) whose art hangs off `storage_urls`. No rotations, no
animations — mirroring is a single image download per item, which costs ZERO
generations.

This is the items domain's own copy of the client (full isolation per
coordination/PROTOCOL.md); it is deliberately smaller than the monsters copy —
no animation normalization, no character store.
"""

from __future__ import annotations

import io
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from PIL import Image

V2_BASE = "https://api.pixellab.ai/v2"
BALANCE_URL = f"{V2_BASE}/balance"
API_KEY_ENV = "PIXELLAB_API_KEY"

# The direction key PixelLab uses for a single-direction object.
STILL = "unknown"


class PixelLabError(RuntimeError):
    pass


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
                f"gitignored .env) before running items tooling."
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

    # -- downloads (free) ----------------------------------------------------

    def download(self, url, retries=4):
        """One CDN image -> PIL (RGBA), or None. CDN URLs can briefly 404 right
        after a job completes, so retry."""
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
        a re-sync skips art that has not changed."""
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

    # -- discovery: the type tag is the ground truth --------------------------

    def _list_all(self, store="objects"):
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

    def tagged_items(self, type_tags):
        """Every object carrying one of `type_tags` ->
        [{id, name, type, tags}]. An object tagged with two item types is
        reported with `type=None` so sync can flag it instead of guessing."""
        want = {t.upper() for t in type_tags}
        out = []
        for it in self._list_all("objects"):
            tags = [str(t).upper() for t in (it.get("tags") or [])]
            hits = [t for t in tags if t in want]
            if not hits:
                continue
            out.append({"id": it.get("id"), "name": it.get("name"),
                        "type": hits[0] if len(hits) == 1 else None,
                        "type_conflict": hits if len(hits) > 1 else None,
                        "tags": it.get("tags")})
        return out

    # -- reads ---------------------------------------------------------------

    def get_object(self, object_id):
        return self._request("GET", f"objects/{object_id}")

    def get_objects(self, object_ids):
        """Detail records for many objects, concurrently; order preserved."""
        return list(self.pool.map(self.get_object, object_ids))

    @staticmethod
    def sprite_url(detail):
        """The still sprite of a single-direction object. Prefers the `unknown`
        direction PixelLab writes for a still, then any rotation, then the
        preview."""
        urls = detail.get("storage_urls") or {}
        if urls.get(STILL):
            return urls[STILL]
        for d in ("south", "south-east", "east", "north-east",
                  "north", "north-west", "west", "south-west"):
            if urls.get(d):
                return urls[d]
        rot = detail.get("rotation_urls") or {}
        for v in rot.values():
            if v:
                return v
        return next((v for v in urls.values() if v), None) or detail.get("preview_url")

    # -- balance / budget ----------------------------------------------------

    def balance(self):
        return self._request("GET", BALANCE_URL)

    def generations_remaining(self):
        b = self.balance()
        sub = b.get("subscription", {})
        return float(sub.get("generations", b.get("credits", {}).get("usd", 0)) or 0)
