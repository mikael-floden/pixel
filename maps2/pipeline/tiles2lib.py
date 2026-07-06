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


def _erode(mask: np.ndarray, r: int) -> np.ndarray:
    """Shrink a boolean mask inward by r px (4-neighbour erosion)."""
    m = mask.copy()
    for _ in range(r):
        m = (m & np.roll(m, 1, 0) & np.roll(m, -1, 0)
             & np.roll(m, 1, 1) & np.roll(m, -1, 1))
    return m


# The INTERIOR of the top diamond — the diamond minus its baked dark outline rim.
# Tile "solidity"/colour must be judged HERE: every tile carries a dark edge line,
# so measuring the whole diamond makes even a perfectly flat tile look textured
# and hides the genuinely solid ones.
DM_INNER = _erode(DM, 4)

# The side FACE (wall) below the diamond — what shows on a stacked cliff. The
# plain tile is used for cliff faces too, so we prefer a tile whose wall is also
# clean (a uniform dirt/rock face, not a busy or wrong-coloured one).
_Wy, _Wx = np.mgrid[0:64, 0:64]
WALL_MASK = (~DM) & (_Wy >= 38) & (_Wy <= 58)

# The four diamond CORNER points (N apex, E, S, W) and a small sampling patch at
# each — used to read a tile's Wang corner-code (which material owns each corner).
CORNERS = {"N": (32, 9), "E": (61, 23), "S": (32, 37), "W": (3, 23)}
_YY, _XX = np.mgrid[0:64, 0:64]
CORNER_MASK = {k: (DM & ((_XX - cx) ** 2 + (_YY - cy) ** 2 < 9 ** 2))
               for k, (cx, cy) in CORNERS.items()}
CORNER_ORDER = ("N", "E", "S", "W")   # cyclic order around the diamond

# The four diamond EDGES, each sampled at EDGE_K points from one corner to the
# next in cyclic order (NE: N->E, SE: E->S, SW: S->W, NW: W->N). Matching a tile's
# edge profile against its neighbour's shared edge (reversed) pins not just the
# corners but WHERE along the edge the materials swap (the divider) — which is
# what removes the sub-edge "notch". Samples are nudged toward the diamond centre
# so they read interior art, not the outline rim.
EDGE_K = 6
_EDGE_CORNERS = {"NE": ("N", "E"), "SE": ("E", "S"),
                 "SW": ("S", "W"), "NW": ("W", "N")}
_ECENTER = (32, 23)


def _edge_mask(p0, p1, t):
    x = p0[0] + (p1[0] - p0[0]) * t
    y = p0[1] + (p1[1] - p0[1]) * t
    x += (_ECENTER[0] - x) * 0.18
    y += (_ECENTER[1] - y) * 0.18
    return DM & ((_XX - x) ** 2 + (_YY - y) ** 2 < 3.5 ** 2)


EDGE_MASK = {e: [_edge_mask(CORNERS[c0], CORNERS[c1], (i + 1) / (EDGE_K + 1))
                 for i in range(EDGE_K)]
             for e, (c0, c1) in _EDGE_CORNERS.items()}
EDGE_ORDER = ("NE", "SE", "SW", "NW")


class Tiles2:
    def __init__(self, tiles_root: str = TILES2):
        self.root = tiles_root
        self.types = self._discover()
        self._targets: dict[str, list] = {}
        self._targets_inner: dict[str, list] = {}
        self._img: dict[str, Image.Image] = {}
        self._pools: dict = {}
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

    def audit_transition_metadata(self) -> list[str]:
        """List every transition sheet whose metadata.json is missing the
        `edges`/`composition` fields the DESIGNER_GUIDE guarantees. tiles2 owns
        this data; maps2 relies on it being complete, so builds call this and
        fail loudly rather than silently working around a gap."""
        import json
        missing = []
        for gid, d in self.types.items():
            for other, tt in d["transitions"].items():
                for p in tt:
                    meta = os.path.join(os.path.dirname(p), "metadata.json")
                    ok = False
                    if os.path.isfile(meta):
                        try:
                            t0 = json.load(open(meta))["tiles"][0]
                            ok = "edges" in t0 and "composition" in t0
                        except Exception:
                            ok = False
                    if not ok:
                        missing.append(os.path.relpath(os.path.dirname(p), self.root))
                        break   # one report per sheet is enough
        return sorted(set(missing))

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

    def target_inner(self, gid: str) -> np.ndarray:
        """Canonical material colour measured on the diamond INTERIOR (excludes the
        dark outline), so it reflects the flat surface colour a solid tile shows."""
        if gid not in self._targets_inner:
            cols = []
            for f in self.base(gid)[:24]:
                a = np.asarray(self.img(f)).astype(np.float32)
                sel = DM_INNER & (a[:, :, 3] > 40)
                if sel.any():
                    cols.append(a[:, :, :3][sel].mean(0))
            self._targets_inner[gid] = (np.mean(cols, 0) if cols
                                        else np.array([128, 128, 128.])).tolist()
        return np.array(self._targets_inner[gid], np.float32)

    # -- clean vs special base tiles ------------------------------------------

    def base_pools(self, gid: str, clean_pct: float = 0.30):
        """Split a type's base tiles into (clean, special). "Clean" = the flat,
        ON-TARGET standard ground; "special" = flower/mushroom/bare-earth/pebble/
        textured tiles. Ranked by a cleanness score with THREE terms:

          * meanDist  — how far the tile's MEAN colour is from the material's
            normalized target. This is the important one: tiles2 pulls every tile
            to a canonical colour so tiles mix seamlessly, but only if the base we
            fill with actually sits ON that colour. A uniform-but-off-hue tile
            used as the field makes every properly-normalized tile "pop".
          * rgbStd    — internal colour variance (flatness / lack of pattern).
          * accent    — fraction of off-material specks (flowers/pebbles/bare soil).

        so the canonical plain tile is the flattest tile that is genuinely the
        target colour, not merely the least-speckled one."""
        if gid in self._pools:
            return self._pools[gid]
        # measure every tile: INTERIOR flatness + mean colour (top), WALL flatness
        # (the cliff face), and tile index (tile_00 is usually the canonical clean
        # one, with a clean wall too — a good tie-breaker).
        stats = []
        for p in self.base(gid):
            a = np.asarray(self.img(p)).astype(np.float32)
            al = a[:, :, 3] > 40
            top = a[:, :, :3][DM_INNER & al]
            wall = a[:, :, :3][WALL_MASK & al]
            wall_std = float(wall.std(0).mean()) if len(wall) else 40.0
            try:
                idx = int(p.rsplit("tile_", 1)[1].split(".")[0])
            except (IndexError, ValueError):
                idx = 8
            stats.append((float(top.std(0).mean()), top.mean(0), wall_std, idx, p))
        # canonical FLAT colour = centre of the genuinely solid tiles (the mean of
        # all is skewed by textured/tinted ones), so an on-shade solid tile isn't
        # wrongly rejected as "off colour"
        solid = [s for s in stats if s[0] < 2.0] or sorted(stats)[:3]
        ctarget = np.mean([s[1] for s in solid], 0)
        scored = []
        for top_std, mean, wall_std, idx, p in stats:
            mean_dist = float(np.linalg.norm(mean - ctarget))
            # SOLID top dominates; then a clean wall + on-shade colour; tile_00 nudge
            score = 4.0 * top_std + mean_dist + 0.5 * wall_std + 0.5 * idx
            scored.append((score, p))
        scored.sort()
        k = max(3, int(round(len(scored) * clean_pct)))
        clean = [p for _, p in scored[:k]]
        special = [p for _, p in scored[k:]] or clean
        self._pools[gid] = (clean, special)
        return clean, special

    def plain_tile(self, gid: str) -> str:
        """The single flattest, most on-target tile of a type — used where ONE
        uniform tile is wanted (e.g. stacked cliff faces read as a clean wall)."""
        return self.base_pools(gid)[0][0]

    def plain_set(self, gid: str, k: int = 5) -> list[str]:
        """The `k` flattest, most on-target tiles. Filling the bulk of a field by
        mixing THESE (rather than repeating one tile) keeps the colour uniform and
        on-target — they're all normalized to the same target, so no cell pops —
        while breaking up the visible single-tile repeat. Excludes the textured /
        bushy / speckled tiles (those live in `special`)."""
        return self.base_pools(gid)[0][:k]

    def pick_base(self, gid: str, r_plain: float, r_pool: float, r_tile: float,
                  plain_prob: float = 0.90, special_prob: float = 0.15) -> str:
        """Deterministic pick. THE single solid base tile (`plain_tile`) is used
        almost everywhere: it gives one uniform SOLID colour on top AND — since it
        renders the cliff faces too — a COHERENT wall. Solid tiles from different
        sheets share the same flat top but have different wall styles, so swapping
        between them per-cell would make cliffs look patchy; we deliberately don't.
        Only a rare cell (~`(1-plain_prob)*special_prob`) breaks to a special
        accent (flower/pebble/bare patch) for a touch of life."""
        if r_plain >= plain_prob and r_pool < special_prob:
            special = self.base_pools(gid)[1]
            return special[int(r_tile * len(special)) % len(special)]
        return self.plain_tile(gid)

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
        # Wang corner-code: for each diamond corner, which material owns it (1=A)
        # plus how confidently (1 = pure, 0 = 50/50), so the auto-tiler can prefer
        # tiles whose corners are unambiguous.
        corners, conf = [], []
        alpha = a[:, :, 3] > 40
        for k in CORNER_ORDER:
            sel = CORNER_MASK[k] & alpha
            cpx = a[:, :, :3][sel]
            if len(cpx) == 0:
                corners.append(1 if compA >= 0.5 else 0)
                conf.append(0.0)
                continue
            fa = float((np.linalg.norm(cpx - ca, axis=1)
                        < np.linalg.norm(cpx - cb, axis=1)).mean())
            corners.append(1 if fa > 0.5 else 0)
            conf.append(round(abs(fa - 0.5) * 2, 3))
        # edge profiles: EDGE_K samples along each edge (1 = A), for seam matching
        edges = {}
        for e in EDGE_ORDER:
            prof = []
            for m in EDGE_MASK[e]:
                sel = m & alpha
                epx = a[:, :, :3][sel]
                if len(epx) == 0:
                    prof.append(1 if compA >= 0.5 else 0)
                else:
                    prof.append(1 if float((np.linalg.norm(epx - ca, axis=1)
                                < np.linalg.norm(epx - cb, axis=1)).mean()) > 0.5
                                else 0)
            edges[e] = prof
        return {"file": path, "compA": round(compA, 3),
                "grad": [round(float(g[0]), 3), round(float(g[1]), 3)],
                "corners": corners, "conf": round(float(np.mean(conf)), 3),
                "edges": edges}

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
        parts = ["v3-edges"]   # bump when the analysis schema changes
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

    def fade_tiles(self, hi: str, lo: str):
        """Tiles for the graded band either side of the hard boundary line.

        Returns (hi_border, lo_border). `hi_border` = tiles whose entire BORDER
        (all four corners and every edge sample) is `hi`, but whose interior
        carries some `lo` — an island of the other material that does NOT touch
        any edge, so the tile still tessellates seamlessly against pure `hi`.
        Dropped a little denser near the seam and thinning out, they read as a
        fade-in before the hard line (and the mirror image fades out after it).

        Each entry: {"file", "mirror", "other"} where `other` is the interior
        fraction of the OTHER material (0 = pure). Sorted ascending by `other`,
        with the pure plain tile first."""
        key = tuple(sorted((hi, lo)))
        tiles = self._analysis.get(f"{key[0]}|{key[1]}", [])
        hi_first = (hi == key[0])
        hi_border, lo_border = [{"file": self.plain_tile(hi), "mirror": False,
                                 "other": 0.0}], \
                               [{"file": self.plain_tile(lo), "mirror": False,
                                 "other": 0.0}]
        for t in tiles:
            c = t.get("corners") or []
            eg = t.get("edges") or {}
            if len(c) != 4 or len(eg) != 4:
                continue
            comp_hi = t["compA"] if hi_first else 1 - t["compA"]
            allhi = all(v == 1 for v in c) if hi_first else all(v == 0 for v in c)
            alllo = all(v == 0 for v in c) if hi_first else all(v == 1 for v in c)
            edge_hi = all((v == 1) == hi_first for pr in eg.values() for v in pr)
            edge_lo = all((v == 0) == hi_first for pr in eg.values() for v in pr)
            if allhi and edge_hi and comp_hi < 0.999:
                for m in (False, True):
                    hi_border.append({"file": t["file"], "mirror": m,
                                      "other": round(1 - comp_hi, 3)})
            if alllo and edge_lo and comp_hi > 0.001:
                for m in (False, True):
                    lo_border.append({"file": t["file"], "mirror": m,
                                      "other": round(comp_hi, 3)})
        hi_border.sort(key=lambda r: r["other"])
        lo_border.sort(key=lambda r: r["other"])
        return hi_border, lo_border

    def wang(self, hi: str, lo: str):
        """Corner-code Wang table for placing `hi` material dissolving into `lo`.

        Returns dict: code -> list of {"file", "mirror", "conf"} sorted best-first,
        where `code` is a 4-tuple of corner materials in cyclic order (N, E, S, W),
        each 1 if that corner is `hi` else 0 (`lo`). Placement is seamless *by
        construction*: neighbours share corner lattice points, so if every cell
        gets a tile whose corners equal its corner-code, all borders agree.

        Horizontal MIRRORS are included (image flipped left-right → the E and W
        corners swap), which fills codes the raw sheets happen to miss."""
        key = tuple(sorted((hi, lo)))
        tiles = self._analysis.get(f"{key[0]}|{key[1]}", [])
        hi_first = (hi == key[0])
        table: dict = {}
        for t in tiles:
            c = list(t.get("corners") or [])
            eg = t.get("edges") or {}
            if len(c) != 4 or len(eg) != 4:
                continue
            # analysis stores 1==first-material; re-express as 1==hi
            if not hi_first:
                c = [1 - v for v in c]
                eg = {k: [1 - v for v in prof] for k, prof in eg.items()}
            n, e, s, w = c
            # unmirrored, then horizontal mirror (E<->W corners; edges remap+reverse)
            emir = {"NE": list(reversed(eg["NW"])), "SE": list(reversed(eg["SW"])),
                    "SW": list(reversed(eg["SE"])), "NW": list(reversed(eg["NE"]))}
            for mirror, code, edges in ((False, (n, e, s, w), eg),
                                        (True, (n, w, s, e), emir)):
                table.setdefault(code, []).append(
                    {"file": t["file"], "mirror": mirror,
                     "conf": t.get("conf", 0), "edges": edges})
        for code in table:
            table[code].sort(key=lambda r: -r["conf"])
        return table


if __name__ == "__main__":
    t = Tiles2()
    print("types:", list(t.types))
    for gid in t.types:
        d = t.types[gid]
        print(f"  {gid:16} base={len(d['base'])} "
              f"trans={ {k: len(v) for k, v in d['transitions'].items()} } "
              f"elev={ {k: len(v) for k, v in d['elev'].items()} }")
    print("analyzed pairs:", {k: len(v) for k, v in t._analysis.items()})
