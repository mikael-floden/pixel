"""Minimal PixelLab character client for characters2 (self-contained).

The human hero is a persistent PixelLab **character** created with
create-character-with-8-directions (v2): it returns a character_id, renders 8
rotations, and shows in the PixelLab UI. We only need the static 8-direction
model — no animations, no outfits.
"""

from __future__ import annotations

import base64
import io
import os
import time

import requests
from PIL import Image

V2 = "https://api.pixellab.ai/v2"
BALANCE_URL = f"{V2}/balance"
API_KEY_ENV = "PIXELLAB_API_KEY"
DIRECTIONS_8 = ("south", "south-east", "east", "north-east",
                "north", "north-west", "west", "south-west")


class PixelLabError(RuntimeError):
    pass


class BudgetExhausted(PixelLabError):
    pass


class PixelLabClient:
    def __init__(self, api_key=None, timeout=180):
        self.api_key = api_key or os.environ.get(API_KEY_ENV)
        self.timeout = timeout
        self._session = requests.Session()

    def _headers(self):
        if not self.api_key:
            raise PixelLabError(f"{API_KEY_ENV} is not set.")
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def _request(self, method, url, retries=5, **kw):
        last = None
        for attempt in range(retries):
            try:
                r = self._session.request(method, url, headers=self._headers(),
                                          timeout=self.timeout, **kw)
            except requests.RequestException as e:
                last = e; time.sleep(min(2 ** attempt, 30)); continue
            if r.status_code in (429, 500, 502, 503, 504):
                last = PixelLabError(f"{r.status_code}: {r.text[:200]}")
                time.sleep(min(2 ** attempt, 30)); continue
            if r.status_code >= 400:
                raise PixelLabError(f"{method} {url} -> {r.status_code}: {r.text[:300]}")
            return r.json()
        raise PixelLabError(f"{method} {url} failed after {retries}: {last}")

    # -- budget --------------------------------------------------------------

    def generations_remaining(self):
        b = self._request("GET", BALANCE_URL)
        sub = b.get("subscription", {})
        return float(sub.get("generations", 0) or 0)

    def usd_credits(self):
        return float(self._request("GET", BALANCE_URL).get("credits", {}).get("usd", 0) or 0)

    def ensure_budget(self, minimum):
        rem = self.generations_remaining()
        # Allow running on usd credits when the generation quota is exhausted.
        if rem < minimum and self.usd_credits() <= 0:
            raise BudgetExhausted(f"only {rem:.0f} generations and no credits left")
        return rem

    # -- job polling ---------------------------------------------------------

    def wait_job(self, job_id, timeout=900, interval=6):
        deadline = time.monotonic() + timeout
        while True:
            j = self._request("GET", f"{V2}/background-jobs/{job_id}")
            st = j.get("status")
            if st == "completed":
                return j
            if st == "failed":
                raise PixelLabError(f"job {job_id} failed: {str(j.get('last_response'))[:200]}")
            if time.monotonic() > deadline:
                raise PixelLabError(f"job {job_id} timed out")
            time.sleep(interval)

    # -- character create + rotations ---------------------------------------

    def create_character(self, description, width, height, view="low top-down",
                         outline=None, shading=None, detail=None,
                         text_guidance_scale=8.0, seed=None, job_timeout=900):
        """Create a persistent 8-direction character. Returns its character_id.
        `outline=None` (or 'default') uses PixelLab's default outline."""
        payload = {
            "description": description,
            "image_size": {"width": int(width), "height": int(height)},
            "view": view,
            "text_guidance_scale": text_guidance_scale,
        }
        for k, v in (("outline", outline), ("shading", shading), ("detail", detail)):
            if v is not None and v != "default":
                payload[k] = v
        if seed is not None:
            payload["seed"] = int(seed)
        resp = self._request("POST", f"{V2}/create-character-with-8-directions", json=payload)
        cid = resp.get("character_id") or resp.get("id")
        job = resp.get("background_job_id")
        if job:
            self.wait_job(job, timeout=job_timeout)
        return cid

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

    def character_rotations(self, character_id, wait=180, poll=5):
        """Download all rotation PNGs -> {direction: PIL}. Retries directions whose
        CDN file 404s briefly right after generation."""
        deadline = time.monotonic() + wait
        out = {}
        while True:
            detail = self._request("GET", f"{V2}/characters/{character_id}")
            urls = {d: u for d, u in (detail.get("rotation_urls") or {}).items() if u}
            for d in [d for d in urls if d not in out]:
                img = self._download(urls[d])
                if img is not None:
                    out[d] = img
            if urls and len(out) == len(urls):
                return out
            if time.monotonic() > deadline:
                return out
            time.sleep(poll)

    def delete_character(self, character_id):
        return self._request("DELETE", f"{V2}/characters/{character_id}")
