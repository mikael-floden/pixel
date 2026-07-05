"""Library loader + analyzer for tiles2 (the second-generation tile system).

tiles2 geometry (verified against the sheets, DESIGNER_GUIDE + ELEVATION docs):
  - every tile is 64px wide; the TOP DIAMOND is exactly 30px tall x 64px wide,
    apex at y=8, W/E corners at y=23, S corner at y=38 — identical on every tile
  - one elevation level = 16px of vertical face
So the iso grid steps are DX=32, DY=15, and stacking one level = 16px up.

What this module provides to the map generator:
  - `base(gid)`        list of a ground type's base tiles (paths)
  - `target_color(gid)` the type's canonical top-diamond RGB (for classification)
  - `transition(a, b)`  candidate transition tiles for the unordered pair {a,b},
    each analyzed for material COMPOSITION and screen-space ORIENTATION so a
    generator can pick a tile whose split faces the right way and whose A/B mix
    matches how deep into the border a cell sits.

The DESIGNER_GUIDE describes rich per-tile metadata (composition/edges), but only
some sheets carry it, so we compute it ourselves from pixels — uniform and
independent of which sheets were regenerated. Results are cached to
maps2/config/tiles2_analysis.json (keyed by mtime) so repeated builds are fast.
"""

from __future__ import annotations

import glob
import json
import os

import numpy as np
from PIL import Image

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
TILES2 = os.path.join(REPO, "tiles2")
CACHE = os.path.join(MAPS2, "config", "tiles2_analysis.json")

# geometry
DIAMOND_H = 30
APEX_Y = 8
LEVEL_PX = 16
DX, DY = 32, 15


def diamond_mask() -> np.ndarray:
    """Boolean 64x64 mask of the top diamond (apex y=8 .. S corner y=38)."""
    m = np.zeros((64, 64), bool)
    for y in range(APEX_Y, APEX_Y + DIAMOND_H):
        t = (y - APEX_Y) / DIAMOND_H
        hw = int(round(32 * (1 - abs(2 * t - 1))))
        m[y, max(0, 32 - hw):min(64, 32 + hw)] = True
    return m


DM = diamond_mask()
_YS, _XS = np.where(DM)


class Tiles2:
    def __init__(self, tiles_root: str = TILES2):
        self.root = tiles_root
        self.types = self._discover()
        self._targets: dict[str, list] = {}
        self._img: dict[str, Image.Image] = {}
        self._analysis = self._load_or_build_analysis()

    # -- discovery -------------------------------------------------------------

    def _discover(self) -> dict:
        out = {}
        for gid in sorted(os.listdir(self.root)):
            base = os.path.join(self.root, gid, "base")
            if not os.path.isdir(base):
                continue
            bt = sorted(glob.glob(os.path.join(base, "*", "tile_*.png")))
            trans = {}
            tdir = os.path.join(self.root, gid, "transitions")
            if os.path.isdir(tdir):
                for other in sorted(os.listdir(tdir)):
                    tt = sorted(glob.glob(os.path.join(tdir, other, "*", "tile_*.png")))
                    if tt:
                        trans[other] = tt
            elev = {}
            for n in (2, 3, 4, 5):
                ed = sorted(glob.glob(os.path.join(self.root, gid, f"base_x_{n}",
                                                   "*", "tile_*.png")))
                if ed:
                    elev[n] = ed
            out[gid] = {"base": bt, "transitions": trans, "elev": elev}
        return out

    def has(self, gid: str) -> bool:
        return gid in self.types

    def base(self, gid: str) -> list[str]:
        return self.types[gid]["base"]

    def elev(self, gid: str, n: int) -> list[str]:
        return self.types[gid]["elev"].get(n, [])

    # -- images ---------------------------------------------------------------

    def img(self, path: str) -> Image.Image:
        im = self._img.get(path)
        if im is None:
            im = Image.open(path).convert("RGBA")
            self._img[path] = im
        return im

    # -- target color ---------------------------------------------------------

    def target_color(self, gid: str) -> np.ndarray:
        if gid not in self._targets:
            cols = []
            for f in self.base(gid)[:24]:
                a = np.asarray(self.img(f)).astype(np.float32)
                sel = DM & (a[:, :, 3] > 40)
                if sel.any():
                    cols.append(a[:, :, :3][sel].mean(0))
            self._targets[gid] = (np.mean(cols, 0) if cols
                                  else np.array([128, 128, 128.])).tolist()
        return np.array(self._targets[gid], np.float32)

    # -- transition analysis --------------------------------------------------

    def _analyze_tile(self, path: str, ca: np.ndarray, cb: np.ndarray) -> dict:
        """compA (fraction of material A on the top diamond) and gradAB (unit
        screen-space vector from the A-region centroid to the B-region)."""
        a = np.asarray(self.img(path)).astype(np.float32)
        sel = DM & (a[:, :, 3] > 40)
        ys, xs = np.where(sel)
        px = a[ys, xs, :3]
        da = np.linalg.norm(px - ca, axis=1)
        db = np.linalg.norm(px - cb, axis=1)
        isA = da < db
        compA = float(isA.mean())
        if isA.any():
            ax, ay = xs[isA].mean(), ys[isA].mean()
        else:
            ax, ay = 32, 23
        if (~isA).any():
            bx, by = xs[~isA].mean(), ys[~isA].mean()
        else:
            bx, by = 32, 23
        g = np.array([bx - ax, by - ay], np.float32)
        n = np.linalg.norm(g)
        g = (g / n) if n > 1e-3 else np.array([0, 0], np.float32)
        return {"file": path, "compA": round(compA, 3),
                "grad": [round(float(g[0]), 3), round(float(g[1]), 3)]}

    def _load_or_build_analysis(self) -> dict:
        sig = self._signature()
        if os.path.isfile(CACHE):
            try:
                c = json.load(open(CACHE))
                if c.get("sig") == sig:
                    return c["pairs"]
            except Exception:
                pass
        pairs = self._build_analysis()
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        json.dump({"sig": sig, "pairs": pairs}, open(CACHE, "w"))
        return pairs

    def _signature(self) -> str:
        parts = []
        for gid, d in self.types.items():
            for other, tt in d["transitions"].items():
                parts.append(f"{gid}>{other}:{len(tt)}")
        return "|".join(sorted(parts))

    def _build_analysis(self) -> dict:
        """For every unordered pair with any transition sheet (either direction),
        analyze every tile. Store keyed 'A|B' with A<B; compA = fraction of A."""
        pairs: dict[str, list] = {}
        seen = set()
        for gid, d in self.types.items():
            for other, tt in d["transitions"].items():
                key = tuple(sorted((gid, other)))
                if key in seen:
                    continue
                seen.add(key)
                A, B = key
                ca, cb = self.target_color(A), self.target_color(B)
                tiles = []
                # gather tiles from BOTH directions if present
                srcs = list(self.types[A]["transitions"].get(B, []))
                srcs += list(self.types[B]["transitions"].get(A, []))
                for p in srcs:
                    tiles.append(self._analyze_tile(p, ca, cb))
                pairs[f"{A}|{B}"] = tiles
        return pairs

    def transition(self, a: str, b: str):
        """Return (tiles, a_is_first). tiles carry compA (fraction of `first`)
        and grad (screen dir first->second). a_is_first says whether `a` is the
        canonical first material, so the caller can interpret compA/grad."""
        key = tuple(sorted((a, b)))
        tiles = self._analysis.get(f"{key[0]}|{key[1]}", [])
        return tiles, (a == key[0])


if __name__ == "__main__":
    t = Tiles2()
    print("types:", list(t.types))
    for gid in t.types:
        d = t.types[gid]
        print(f"  {gid:16} base={len(d['base'])} "
              f"trans={ {k: len(v) for k, v in d['transitions'].items()} } "
              f"elev={ {k: len(v) for k, v in d['elev'].items()} }")
    print("analyzed pairs:", {k: len(v) for k, v in t._analysis.items()})
