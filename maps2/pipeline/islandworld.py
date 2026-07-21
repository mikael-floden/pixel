"""the_island ("The Island") — the WIP production island, organic + ALttP-shaped.

Kept separate from demo_lost (the older grass island, preserved) so we can iterate
here. Built to look like a REAL island with a Zelda-ALttP sense of journey, under
our camera-facing elevation rules.

Design (see scratchpad master blueprint / maps2/README.md):

  * ORGANIC COASTLINE — domain-warped fbm x an anisotropic falloff x a small table
    of explicit lobe attractors (harbor bay, coves, headlands, a north cape, an
    offshore islet). No ellipse, no `hypot < r`.
  * A SOUTH-FACING STAIRCASE of a FEW flat tiers (levels 0/3/8/14/22) separated by
    TALL multi-level cliffs (Δ5/Δ6/Δ8 = 80/96/128px) you cannot climb — so you must
    walk around and find the one RAMP up each tier (descending dirt spurs, R1..R4).
    A localised massif (Embercrown) caps the top; its back is the sheer sea-cliff.
  * DYNAMIC REGIONS — materials from elevation bands on warped tier contours plus
    warped-fbm blobs (glacier, obsidian caldera, dry-dirt meadow). No circular
    region anywhere.
  * CAMERA-FACING is guaranteed: the depth field is antitone by construction (a
    continuous closure before quantizing), `camera_monotone` is the backstop, and
    `occlusion_violations` is asserted == [] every build. Reachability (every tier
    from spawn over |Δlevel|<=1 steps) is asserted too.
"""

from __future__ import annotations

import math
import os
from collections import deque

import numpy as np
from PIL import Image

import worldio
from autotile import (PRIORITY, AutoTiler, camera_monotone, connect_walkable,
                      flatten_shores, occlusion_violations)
from tiles2lib import DX, DY, LEVEL_PX, Tiles2

GROUND_BOTTOM = 54
PLAIN_PROB = 0.90
SPECIAL_PROB = 0.10
SAND_W = 3

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)


def _h01(x, y, s):
    h = (int(x) * 374761393 + int(y) * 668265263 + s * 362437) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


def _fbm(X, Y, seed, scale, oct=4):
    tot = np.zeros_like(X, np.float32)
    amp, norm, s = 1.0, 0.0, scale
    for o in range(oct):
        ix, iy = np.floor(X / s).astype(int), np.floor(Y / s).astype(int)
        fx, fy = X / s - ix, Y / s - iy

        def hh(a, b):
            v = (a * 374761393 + b * 668265263 + (seed + o * 71) * 362437) & 0xFFFFFFFF
            v = ((v ^ (v >> 13)) * 1274126177) & 0xFFFFFFFF
            return ((v ^ (v >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF

        ux, uy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
        v00, v10, v01, v11 = hh(ix, iy), hh(ix + 1, iy), hh(ix, iy + 1), hh(ix + 1, iy + 1)
        a = v00 + (v10 - v00) * ux
        b = v01 + (v11 - v01) * ux
        tot += amp * (a + (b - a) * uy)
        norm += amp
        amp *= 0.5
        s *= 0.5
    return tot / norm


def _dilate(mask, r):
    m = mask.copy()
    for _ in range(r):
        nn = m.copy()
        nn[:, :-1] |= m[:, 1:]; nn[:, 1:] |= m[:, :-1]
        nn[:-1, :] |= m[1:, :]; nn[1:, :] |= m[:-1, :]
        m = nn
    return m


def _erode(mask, r):
    m = mask.copy()
    for _ in range(r):
        nn = m.copy()
        nn[:, :-1] &= m[:, 1:]; nn[:, 1:] &= m[:, :-1]
        nn[:-1, :] &= m[1:, :]; nn[1:, :] &= m[:-1, :]
        m = nn
    return m


def _largest_component(mask):
    """Keep only the largest 4-connected True component of a boolean mask."""
    H, W = mask.shape
    seen = np.zeros((H, W), bool)
    best = None
    for y in range(H):
        for x in range(W):
            if mask[y, x] and not seen[y, x]:
                q, cells = deque([(x, y)]), []
                seen[y, x] = True
                while q:
                    cx, cy = q.popleft()
                    cells.append((cx, cy))
                    for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        xx, yy = cx + i, cy + j
                        if 0 <= xx < W and 0 <= yy < H and mask[yy, xx] and not seen[yy, xx]:
                            seen[yy, xx] = True
                            q.append((xx, yy))
                if best is None or len(cells) > len(best):
                    best = cells
    out = np.zeros((H, W), bool)
    for x, y in (best or []):
        out[y, x] = True
    return out


class Island:
    def __init__(self, n=140, seed=11):
        self.n, self.seed = n, seed
        self.lib = Tiles2()
        self.mat = np.full((n, n), "", object)
        self.level = np.zeros((n, n), np.int16)
        self.top = np.full((n, n), None, object)
        self.mirror = np.zeros((n, n), bool)
        self.props = {}
        self.decks = []
        self.reserved = set()
        self.links = []          # virtual walkable edges (bridge decks span these)
        self.spawn = (int(n * 0.52), int(n * 0.90))
        self._coastline()
        self._elevation()
        self._tarn()
        flatten_shores(self.mat, self.level)
        camera_monotone(self.level, self.mat)     # true antitone before we read components
        self._river()                             # carve the gorge (banks keep full height)
        self.level_before = self.level.copy()
        self._connect_all()                       # ramps within banks + bridges across gorge
        camera_monotone(self.level, self.mat)     # backstop the ramps
        self._materials()
        self._place_bridges(count=3)              # deliberate stone bridges over the gorge
        self._pick_spawn()
        self._paint()
        self.deck_at = {(x, y): dk for dk in self.decks for (x, y) in dk["cells"]}
        self._decorate()

    # -- A. organic coastline --------------------------------------------------

    def _coastline(self):
        n = self.n
        Y, X = np.mgrid[0:n, 0:n].astype(np.float32)
        self.X, self.Y = X, Y
        s = self.seed
        cx, cy = n * 0.50, n * 0.56
        # domain warp — breaks radial symmetry into lobes, not a fringe
        wx = X + n * 0.11 * (_fbm(X, Y, s + 11, n * 0.28, 4) - 0.5) * 2
        wy = Y + n * 0.11 * (_fbm(X, Y, s + 12, n * 0.28, 4) - 0.5) * 2
        # anisotropic, noise-wobbled falloff (never a clean ellipse)
        r = np.hypot((wx - cx) / (0.46 * n), (wy - cy) / (0.42 * n))
        r += 0.14 * (_fbm(X, Y, s + 13, n * 0.5, 2) - 0.5)
        coast = (1.0 - r) + (_fbm(wx, wy, s + 2, n * 0.30, 5) - 0.5) * 1.05
        # explicit named lobes: (+)=peninsula/spit, (-)=bay/cove
        LOBES = [(0.52, 0.96, -0.55, 0.14),   # harbor bay (near shore) -> spawn
                 (0.34, 0.90, -0.30, 0.06),   # west marsh cove
                 (0.70, 0.93, -0.28, 0.06),   # east cove
                 (0.12, 0.58, +0.34, 0.10),   # west headland
                 (0.90, 0.50, +0.32, 0.10),   # east headland -> lighthouse
                 (0.44, 0.09, +0.24, 0.09)]   # north cape -> sheer sea-cliff
        for fx, fy, amp, rad in LOBES:
            coast += amp * np.exp(-(((X - fx * n) ** 2 + (Y - fy * n) ** 2) / (2 * (rad * n) ** 2)))
        land = coast > 0.0
        land = _largest_component(land)
        # one intentional offshore islet (small, decorative)
        islet = np.exp(-(((X - 0.82 * n) ** 2 + (Y - 0.86 * n) ** 2) / (2 * (0.045 * n) ** 2))) > 0.5
        land |= islet
        # de-sliver the coast
        land = _erode(_dilate(land, 1), 1)
        self.land = land
        self.mat[land] = "saturated_grass"
        self.mat[~land] = "clear_water"

    # -- B. tiered elevation (antitone by construction) ------------------------

    def _elevation(self):
        n, X, Y, s, land = self.n, self.X, self.Y, self.seed, self.land
        # camera depth: strictly increasing toward camera (+x,+y); its decreasing
        # quantization is antitone. Organic cliff-line wiggle + NW uplift; a massif
        # FOLDED IN (lowers depth -> a camera-facing wedge, steep legal lateral flanks).
        u = (X + Y)
        # BOWL / CHEVRON structure: subtract a term in |x-y| (screen-horizontal), so
        # screen-LEFT and screen-RIGHT rise into highland arms and screen-CENTRE stays
        # a valley funnelling toward the camera. This bends every tier contour into a
        # chevron (V opening at the camera) instead of a straight left-to-right band.
        # beta<1 keeps the front-back ramp dominant => still antitone => occlusion-clean.
        arm = 0.62 * np.abs(X - Y)
        arm += (_fbm(X, Y, s + 20, n * 0.30, 3) - 0.5) * 10   # wander the valley walls
        # strong, multi-scale warp so the chevron cliff-lines also meander (not clean V's).
        warp = ((_fbm(X, Y, s, n * 0.30, 4) - 0.5) * 22
                + (_fbm(X, Y, s + 3, n * 0.13, 3) - 0.5) * 12
                + (_fbm(X, Y, s + 8, n * 0.06, 2) - 0.5) * 4)
        uplift = _fbm(X, Y, s + 5, n * 0.42, 3) * 8
        px, py = 0.42 * n, 0.16 * n
        self.peak_c = (px, py)
        massif = 30 * np.exp(-(((X - px) ** 2 / (2 * (n * 0.20) ** 2)) + ((Y - py) ** 2 / (2 * (n * 0.13) ** 2))))
        depth = u - arm + warp - uplift - massif
        depth[~land] = 1e9
        self._camera_max_float(depth, land)          # continuous closure -> antitone
        dland = depth[land]
        d = (depth - dland.min()) / (dland.max() - dland.min() + 1e-6)
        level = np.zeros((n, n), np.int16)
        for thr, lv in ((0.82, 3), (0.62, 8), (0.44, 14), (0.26, 22)):
            level[d < thr] = lv
        bump = np.rint(2 * np.exp(-(((X - px) ** 2 + (Y - py) ** 2) / (2 * (n * 0.09) ** 2)))).astype(np.int16)
        level[d < 0.26] += bump[d < 0.26]
        level = np.clip(level, 0, 24)
        level[~land] = 0
        self.level = level
        self.d = d

    @staticmethod
    def _camera_max_float(E, land):
        """Continuous closure: make depth NON-DECREASING toward the camera (running
        MIN of depth over the toward-camera quadrant) so the quantised LEVEL is
        antitone and no cliff is half-clipped. Processed camera -> up-screen."""
        H, W = E.shape
        for x, y in sorted(((x, y) for y in range(H) for x in range(W)),
                           key=lambda p: -(p[0] + p[1])):
            if not land[y, x]:
                continue
            v = E[y, x]
            if x + 1 < W and land[y, x + 1]:
                v = min(v, E[y, x + 1])
            if y + 1 < H and land[y + 1, x]:
                v = min(v, E[y + 1, x])
            E[y, x] = v

    # -- E. tarn (organic depression on the shelf) -----------------------------

    def _tarn(self):
        n, X, Y, s = self.n, self.X, self.Y, self.seed
        bx = X + n * 0.09 * (_fbm(X, Y, s + 40, n * 0.26, 3) - 0.5) * 2
        by = Y + n * 0.09 * (_fbm(X, Y, s + 41, n * 0.26, 3) - 0.5) * 2
        tar = _fbm(bx, by, s + 22, n * 0.10, 3)
        sink = (self.level >= 14) & (self.level < 22) & (tar > 0.72)
        self.mat[sink] = "clear_water"
        self.level[sink] = 0

    # -- C. ramps: sparse descending-spur connectors that gate the cliffs ------

    def _carve_connector(self, hx, hy, lx, ly, w=3):
        """Carve a climbable dirt RAMP that merges the plateau at (hx,hy) [higher]
        with the tier at (lx,ly) [lower, toward-camera-adjacent]. It is a DESCENDING
        SPUR: a finger jutting from the high plateau toward the camera, stepping down
        one level per cell to the low tier — antitone by construction, and dirt, so
        its lateral edges are different-material (legal) lips, not leg-eaters."""
        n = self.n
        H, L = int(self.level[hy, hx]), int(self.level[ly, lx])
        if H <= L + 1:
            return False
        dx, dy = lx - hx, ly - hy
        if (dx, dy) not in ((1, 0), (0, 1)):     # lo must be toward-camera of hi
            return False
        perp = (dy, dx)
        for k in range(H - L + 1):
            lv = H - k
            cx, cy = hx + dx * k, hy + dy * k
            for t in range(-(w // 2), w - w // 2):
                x, y = cx + perp[0] * t, cy + perp[1] * t
                if 0 <= x < n and 0 <= y < n and self.land[y, x] and self.mat[y, x] != "clear_water":
                    self.level[y, x] = lv
                    self.mat[y, x] = "lightdark_dirt"
                    self.reserved.add((x, y))
        return True

    def _ford_stranded(self, thresh=60, max_iter=10):
        """Merge any big walkable component still cut off by RIVER water (no cliff to
        ramp) by carving a low dirt causeway across the shortest river gap to the
        main piece. Only crosses river cells (water on land), never the open sea."""
        n = self.n
        for _ in range(max_iter):
            comps = self._walk_components()
            big = [c for c in comps if len(c) >= thresh]
            if len(big) <= 1:
                return
            main = set(big[0])
            best = None
            for cand in big[1:]:
                for (tx, ty) in cand:
                    for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        gap = 0
                        for step in range(1, 7):
                            mx, my = tx + i * step, ty + j * step
                            if not (0 <= mx < n and 0 <= my < n):
                                break
                            if (mx, my) in main:
                                if best is None or gap < best[0]:
                                    best = (gap, (tx, ty), (i, j), step,
                                            int(self.level[my, mx]))
                                break
                            if self.mat[my, mx] == "clear_water" and self.land[my, mx]:
                                gap += 1
                            else:
                                break
            if best is None:
                return
            gap, (tx, ty), (i, j), step, mlv = best
            lvl = max(1, min(int(self.level[ty, tx]), mlv))
            for s in range(step):
                cx, cy = tx + i * s, ty + j * s
                for w in (-1, 0, 1):
                    x, y = cx + (w if j else 0), cy + (w if i else 0)
                    if 0 <= x < n and 0 <= y < n:
                        self.mat[y, x] = "lightdark_dirt"
                        self.level[y, x] = lvl
                        self.land[y, x] = True
                        self.reserved.add((x, y))

    def _connect_all(self, thresh=45, max_iter=90):
        """Make the island one walkable piece: each round, merge the largest
        component with another either by a cliff RAMP (adjacent across a cliff) or,
        if only WATER separates them (the gorge), by a stone BRIDGE deck + a walk
        link across a short, similar-level reach. Guarantees reachability while
        preserving the gorge the player crosses at a few deliberate bridges."""
        for _ in range(max_iter):
            comps = self._walk_components()
            big = [c for c in comps if len(c) >= thresh]
            if len(big) <= 1:
                return
            main = set(big[0])
            if self._merge_ramp(main, big[1:]):
                continue
            if self._merge_span(main, big[1:]):
                continue
            return

    def _place_bridges(self, count=3):
        """Deliberate STONE BRIDGES (world@2 decks) across the gorge — the crossings
        the player uses. THE GAP FIX: a bridge is placed only where the two banks sit
        at the SAME level (+-1), and the deck is set to that level, so BOTH ends meet
        their bank within one step (walkable). No `max(bank)` deck floating above a
        low far bank. The deck also LAPS one cell onto each bank so it physically
        abuts walkable ground on both sides. Water still passes beneath."""
        n = self.n
        riverw = (self.mat == "clear_water") & self.land

        def channel(cy):
            xs = sorted(x for x in range(n) if riverw[cy, x])
            if not xs:
                return None
            runs, cur = [], [xs[0]]
            for x in xs[1:]:
                if x == cur[-1] + 1:
                    cur.append(x)
                else:
                    runs.append(cur); cur = [x]
            runs.append(cur)
            run = min(runs, key=lambda r: abs((r[0] + r[-1]) / 2 - n / 2))
            return run[0], run[-1]

        cands = []
        for cy in range(int(n * 0.30), int(n * 0.92)):
            ch = channel(cy)
            if not ch:
                continue
            x0, x1 = ch
            if x0 - 1 < 0 or x1 + 1 >= n:
                continue
            la, lb = self.mat[cy, x0 - 1], self.mat[cy, x1 + 1]
            if la in ("", "clear_water") or lb in ("", "clear_water"):
                continue
            va, vb = int(self.level[cy, x0 - 1]), int(self.level[cy, x1 + 1])
            width = x1 - x0 + 1
            if abs(va - vb) <= 1 and 1 <= width <= 12:       # LEVEL-MATCHED banks only
                cands.append((width, cy, x0, x1, min(va, vb)))
        cands.sort()                                          # narrowest crossings first
        chosen = []
        for c in cands:
            if all(abs(c[1] - ch[1]) > 10 for ch in chosen):  # spread out along the gorge
                chosen.append(c)
            if len(chosen) >= count:
                break

        for _w, cy, x0, x1, dlv in chosen:
            # deck at dlv (== the lower bank), lapping one cell onto EACH bank so both
            # ends abut walkable ground within one step; middle spans the water.
            cells = [(x, y) for x in range(x0 - 1, x1 + 2) for y in (cy - 1, cy, cy + 1)
                     if 0 <= y < n]
            self.decks.append({"kind": "bridge", "mat": "stone_mountain", "level": dlv,
                               "thickness": 1, "cells": cells})
            for y in (cy - 1, cy, cy + 1):
                if 0 <= y < n:
                    self.links.append(((x0 - 1, y), (x1 + 1, y)))
            self.reserved.update(cells)

    def _merge_ramp(self, main, cands):
        for cand in cands:
            for (cx, cy) in cand:
                for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    mx, my = cx + i, cy + j
                    if (mx, my) in main and abs(int(self.level[cy, cx]) - int(self.level[my, mx])) > 1:
                        if int(self.level[cy, cx]) < int(self.level[my, mx]):
                            hi, lo = (mx, my), (cx, cy)
                        else:
                            hi, lo = (cx, cy), (mx, my)
                        if self._carve_connector(*hi, *lo):
                            return True
        return False

    def _merge_span(self, main, cands):
        n = self.n
        best = None
        for cand in cands:
            for (tx, ty) in cand:
                if self.mat[ty, tx] == "clear_water":
                    continue
                for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    gap = 0
                    for step in range(1, 8):
                        mx, my = tx + i * step, ty + j * step
                        if not (0 <= mx < n and 0 <= my < n):
                            break
                        if (mx, my) in main:
                            if (self.mat[my, mx] != "clear_water"
                                    and abs(int(self.level[ty, tx]) - int(self.level[my, mx])) <= 1):
                                if best is None or gap < best[0]:
                                    best = (gap, (tx, ty), (i, j), step)
                            break
                        if self.mat[my, mx] == "clear_water":
                            gap += 1
                        else:
                            break
        if best is None or best[0] == 0:
            return False
        gap, (tx, ty), (i, j), step = best
        blv = int(self.level[ty, tx])
        perp = (j, i)
        cells = []
        for s in range(1, step):
            cxx, cyy = tx + i * s, ty + j * s
            for w in (-1, 0, 1):
                x, y = cxx + perp[0] * w, cyy + perp[1] * w
                if 0 <= x < n and 0 <= y < n:
                    cells.append((x, y))
        self.decks.append({"kind": "bridge", "mat": "stone_mountain", "level": max(2, blv),
                           "thickness": 1, "cells": cells})
        mx, my = tx + i * step, ty + j * step
        for w in (-1, 0, 1):
            a = (tx + perp[0] * w, ty + perp[1] * w)
            b = (mx + perp[0] * w, my + perp[1] * w)
            if all(0 <= v < n for v in (a[0], a[1], b[0], b[1])):
                self.links.append((a, b))
        return True

    def _connect_tiers(self, thresh=40, max_iter=30):
        """Greedily carve the FEWEST descending-spur ramps that make the island one
        walkable piece: merge the largest component with an adjacent one across a
        cliff, repeat. Result: each tier/region reachable by a sparse, deliberate set
        of ramps (the ALttP 'find the way up' feel), reachability guaranteed."""
        n = self.n
        for _ in range(max_iter):
            comps = self._walk_components()
            big = [c for c in comps if len(c) >= thresh]
            if len(big) <= 1:
                return
            main = set(big[0])
            done = False
            for cand in big[1:]:
                edge = None
                for (cx, cy) in cand:
                    for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        mx, my = cx + i, cy + j
                        if (mx, my) in main and abs(int(self.level[cy, cx]) - int(self.level[my, mx])) > 1:
                            if int(self.level[cy, cx]) < int(self.level[my, mx]):
                                edge = ((mx, my), (cx, cy))   # (higher main, lower cand)
                            else:
                                edge = ((cx, cy), (mx, my))   # (higher cand, lower main)
                            break
                    if edge:
                        break
                if edge and self._carve_connector(*edge[0], *edge[1]):
                    done = True
                    break
            if not done:
                return

    # -- river gorge (carved AFTER camera_monotone; water is always legal) -----

    def _river(self):
        """The Silverrun: a gorge from the shelf tarn down to the sea. Carved after
        camera_monotone (land->water never raises a neighbour, so it's always legal
        and the banks keep full height = a deep gorge). It bisects the island E-W;
        crossable only at a FORD (low reach) and a BRIDGE (deep reach) => a gate."""
        n = self.n
        RIVER = [(0.46, 0.26), (0.50, 0.40), (0.52, 0.54), (0.53, 0.68),
                 (0.52, 0.82), (0.52, 0.95)]
        pts = [(fx * n, fy * n) for fx, fy in RIVER]
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            steps = int(math.hypot(bx - ax, by - ay)) + 1
            for i in range(steps + 1):
                t = i / steps
                wob = (_fbm(np.float32(ax + (bx - ax) * t), np.float32(ay), self.seed + 7,
                            n * 0.06, 3) - 0.5) * 5
                cx = int(ax + (bx - ax) * t + wob)
                cy = int(ay + (by - ay) * t)
                wr = 2 if t < 0.72 else 3
                for dx in range(-wr, wr + 1):
                    for dy in range(-wr, wr + 1):
                        x, y = cx + dx, cy + dy
                        if 0 <= x < n and 0 <= y < n and self.land[y, x]:
                            self.mat[y, x] = "clear_water"
                            self.level[y, x] = 0

    def _cross_river(self):
        """A FORD (low reach) + a BRIDGE deck (deep reach): the only two E-W crossings."""
        n = self.n
        riverw = (self.mat == "clear_water") & self.land

        def run_at(cy):
            xs = [x for x in range(n) if riverw[cy, x]]
            if not xs:
                return None
            # longest contiguous x-run at this row (the main channel)
            best, cur = [], [xs[0]]
            for x in xs[1:]:
                if x == cur[-1] + 1:
                    cur.append(x)
                else:
                    if len(cur) > len(best):
                        best = cur
                    cur = [x]
            if len(cur) > len(best):
                best = cur
            return best

        def bank_level(cy, x0, x1):
            lv = []
            for bx in (x0 - 1, x1 + 1):
                if 0 <= bx < n and self.land[cy, bx] and self.mat[cy, bx] != "clear_water":
                    lv.append(int(self.level[cy, bx]))
            return lv

        # FORD: the narrowest low-bank reach in the lower third → a 3-row dirt causeway
        ford = None
        for cy in range(int(n * 0.58), int(n * 0.90)):
            run = run_at(cy)
            if not run:
                continue
            bl = bank_level(cy, run[0], run[-1])
            if len(bl) == 2 and abs(bl[0] - bl[1]) <= 1 and max(bl) <= 4:
                if ford is None or len(run) < ford[1]:
                    ford = (cy, len(run), run, min(bl))
        if ford:
            cy, _, run, fl = ford
            for x in range(run[0], run[-1] + 1):
                for dy in (-1, 0, 1):
                    y = cy + dy
                    if 0 <= y < n and self.mat[y, x] == "clear_water" and self.land[y, x]:
                        self.mat[y, x] = "lightdark_dirt"
                        self.level[y, x] = max(1, fl)
                        self.reserved.add((x, y))

        # BRIDGE: a deep reach up in the gorge → a stone deck (world@2) at bank height,
        # linking the two banks (a second walkable surface; water passes beneath).
        bridge = None
        for cy in range(int(n * 0.36), int(n * 0.58)):
            run = run_at(cy)
            if not run or len(run) > 8:
                continue
            bl = bank_level(cy, run[0], run[-1])
            if len(bl) == 2 and abs(bl[0] - bl[1]) <= 2 and min(bl) >= 6:
                bridge = (cy, run, min(bl))
                break
        if bridge:
            cy, run, bl = bridge
            cells = [(x, y) for x in range(run[0] - 1, run[-1] + 2) for y in (cy - 1, cy, cy + 1)
                     if 0 <= x < n and 0 <= y < n]
            self.decks.append({"kind": "bridge", "mat": "stone_mountain", "level": bl,
                               "thickness": 1, "cells": cells})
            for y in (cy - 1, cy, cy + 1):
                if run[0] - 1 >= 0 and run[-1] + 1 < n:
                    self.links.append(((run[0] - 1, y), (run[-1] + 1, y)))

    # -- D. dynamic (non-circular) region materials ----------------------------

    def _materials(self):
        n, X, Y, s = self.n, self.X, self.Y, self.seed
        mat, level = self.mat, self.level
        g = mat == "saturated_grass"
        mat[g & (level >= 14)] = "stone_mountain"
        mat[(mat == "stone_mountain") & (level >= 20)] = "regular_snow"
        # a second, independent warp for lateral biomes (organic borders)
        bx = X + n * 0.09 * (_fbm(X, Y, s + 40, n * 0.26, 3) - 0.5) * 2
        by = Y + n * 0.09 * (_fbm(X, Y, s + 41, n * 0.26, 3) - 0.5) * 2
        glac = _fbm(bx, by, s + 13, n * 0.13, 3)
        mat[(mat == "regular_snow") & (glac > 0.56) & (level >= 20)] = "crystal_ice"
        # OBSIDIAN black_mountain: a caldera at the summit AND a scar on the stone
        # shelf (west), each dirt-collared so it never abuts grass — big organic blobs.
        cald = _fbm(bx, by, s + 9, n * 0.11, 4)
        scar = _fbm(bx, by, s + 50, n * 0.085, 3)
        black = (((mat == "regular_snow") & (cald > 0.60) & (level >= 22))
                 | ((mat == "stone_mountain") & (level >= 12) & (level < 20)
                    & (X < n * 0.56) & (scar > 0.58)))
        mat[_dilate(black, 2) & ((mat == "stone_mountain") | (mat == "regular_snow"))] = "lightdark_dirt"
        mat[black] = "black_mountain"
        dry = _fbm(bx, by, s + 15, n * 0.10, 3)
        mat[(mat == "saturated_grass") & (level <= 8) & (dry > 0.72)] = "lightdark_dirt"
        # VARIED beaches: sand reaches inland by a NOISE-modulated depth, so some
        # coves are broad strands and headlands are thin (up-screen coasts stay sheer).
        water = mat == "clear_water"
        d2w = np.full((n, n), 99, np.int16)
        ring = water.copy()
        for dist in range(1, 8):
            nd = _dilate(ring, 1) & ~ring
            d2w[nd & (d2w == 99)] = dist
            ring = ring | nd
        sd = _fbm(bx, by, s + 60, n * 0.12, 3)
        sand_depth = (1 + np.rint(sd * sd * 7)).astype(np.int16)      # 1..~6, mostly small
        beach = (mat == "saturated_grass") & (level <= 2) & (d2w < 99) & (d2w <= sand_depth)
        mat[beach] = "light_sand"

    # -- connectivity ----------------------------------------------------------

    def _walk_components(self):
        """4-connected components over land where a step is walkable iff
        |Δlevel| <= 1 (the movement model). Returns list of cell-lists, largest first."""
        n, mat, level = self.n, self.mat, self.level
        land = lambda x, y: mat[y, x] != "" and mat[y, x] != "clear_water"
        ladj = self._link_adj()
        seen = np.zeros((n, n), bool)
        comps = []
        for y in range(n):
            for x in range(n):
                if land(x, y) and not seen[y, x]:
                    q, comp = deque([(x, y)]), []
                    seen[y, x] = True
                    while q:
                        a, b = q.popleft()
                        comp.append((a, b))
                        nbrs = [(a + i, b + j) for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1))]
                        for (xx, yy) in nbrs:
                            if (0 <= xx < n and 0 <= yy < n and land(xx, yy) and not seen[yy, xx]
                                    and abs(int(level[yy, xx]) - int(level[b, a])) <= 1):
                                seen[yy, xx] = True
                                q.append((xx, yy))
                        for (xx, yy) in ladj.get((a, b), ()):       # bridge links
                            if 0 <= xx < n and 0 <= yy < n and land(xx, yy) and not seen[yy, xx]:
                                seen[yy, xx] = True
                                q.append((xx, yy))
                    comps.append(comp)
        comps.sort(key=len, reverse=True)
        return comps

    def _link_adj(self):
        adj = {}
        for a, b in self.links:
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
        return adj

    def _pick_spawn(self):
        """Spawn in the LARGEST walkable component, at its lowest / most camera-ward
        cell (a beach/meadow landing you can walk inland from)."""
        comps = self._walk_components()
        if comps:
            self.main_comp = set(comps[0])
            self.spawn = min(comps[0], key=lambda c: (int(self.level[c[1], c[0]]), -(c[0] + c[1])))

    # -- reachability proof ----------------------------------------------------

    def _reachable(self):
        n, mat, level = self.n, self.mat, self.level
        land = lambda x, y: mat[y, x] != "" and mat[y, x] != "clear_water"
        sx, sy = self.spawn
        if not land(sx, sy):
            # snap spawn to nearest land
            cand = [(x, y) for y in range(n) for x in range(n) if land(x, y)]
            sx, sy = min(cand, key=lambda c: (c[0] - self.spawn[0]) ** 2 + (c[1] - self.spawn[1]) ** 2)
            self.spawn = (sx, sy)
        ladj = self._link_adj()
        seen = np.zeros((n, n), bool)
        q = deque([(sx, sy)]); seen[sy, sx] = True
        while q:
            x, y = q.popleft()
            for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                xx, yy = x + i, y + j
                if (0 <= xx < n and 0 <= yy < n and land(xx, yy) and not seen[yy, xx]
                        and abs(int(level[yy, xx]) - int(level[y, x])) <= 1):
                    seen[yy, xx] = True
                    q.append((xx, yy))
            for (xx, yy) in ladj.get((x, y), ()):
                if 0 <= xx < n and 0 <= yy < n and land(xx, yy) and not seen[yy, xx]:
                    seen[yy, xx] = True
                    q.append((xx, yy))
        return seen

    # -- auto-tile -------------------------------------------------------------

    def _paint(self):
        at = AutoTiler(self.mat, self.lib, self.seed, priority=PRIORITY,
                       level=self.level, plain_prob=PLAIN_PROB, special_prob=SPECIAL_PROB)
        self.top, self.mirror = at.top, at.mirror

    # -- F. landmarks & props --------------------------------------------------

    def _place(self, cells, terrain, heights, count, spacing, seedoff):
        pool = [p for hh in heights for p in self.lib.elev(terrain, hh)]
        if not pool or not cells:
            return
        cells = sorted(cells, key=lambda c: _h01(c[0], c[1], self.seed + seedoff))
        placed = []
        for (x, y) in cells:
            if any(abs(px - x) < spacing and abs(py - y) < spacing for px, py in placed):
                continue
            if (x, y) in self.props or (x, y) in self.reserved:
                continue
            self.props[(x, y)] = pool[int(_h01(x, y, self.seed + seedoff + 9) * len(pool)) % len(pool)]
            placed.append((x, y))
            if len(placed) >= count:
                break

    def _cells(self, pred):
        return [(x, y) for y in range(self.n) for x in range(self.n) if pred(x, y)]

    def _decorate(self):
        n, mat, level = self.n, self.mat, self.level
        is_m = lambda m: (lambda x, y: mat[y, x] == m)
        g, s, sn = is_m("saturated_grass"), is_m("stone_mountain"), is_m("regular_snow")
        # SUMMIT CAIRN beacon: tallest stone prop at the highest up-screen snow/ice cell
        peak = self._cells(lambda x, y: (sn(x, y) or mat[y, x] == "crystal_ice") and level[y, x] >= 20)
        if peak:
            t = min(peak, key=lambda c: c[0] + c[1])
            pool = self.lib.elev("stone_mountain", 5)
            if pool:
                self.props[t] = pool[int(_h01(*t, 1) * len(pool)) % len(pool)]
        # glacier + caldera
        self._place(self._cells(is_m("crystal_ice")), "crystal_ice", [4, 5], 5, 2, 30)
        self._place(self._cells(is_m("crystal_ice")), "crystal_ice", [2, 3], 5, 2, 31)
        self._place(self._cells(is_m("black_mountain")), "black_mountain", [3, 4], 6, 2, 24)
        # snow + stone slopes
        self._place(self._cells(sn), "regular_snow", [2, 3], 7, 3, 11)
        self._place(self._cells(lambda x, y: s(x, y) and level[y, x] <= 20),
                    "stone_mountain", [2, 3], 10, 3, 13)
        self._place(self._cells(s), "stone_mountain", [4, 5], 4, 5, 14)
        # WEALDWOOD grove (forest bench, T2 grass around level 8)
        grove = self._cells(lambda x, y: g(x, y) and 6 <= level[y, x] <= 9)
        self._place(grove, "saturated_grass", [4, 5], 14, 2, 15)
        self._place(grove, "saturated_grass", [3], 10, 3, 16)
        # meadow lone trees + a perturbed standing-stone ring
        self._place(self._cells(lambda x, y: g(x, y) and level[y, x] <= 5),
                    "saturated_grass", [4, 5], 8, 6, 17)
        kx, ky = int(n * 0.30), int(n * 0.74)
        ring = [(int(kx + (4 + 1.4 * _h01(k, 0, 7)) * math.cos(k * math.tau / 7)),
                 int(ky + (4 + 1.4 * _h01(k, 1, 7)) * math.sin(k * math.tau / 7))) for k in range(7)]
        self._place([c for c in ring if 0 <= c[0] < n and 0 <= c[1] < n and g(*c)],
                    "stone_mountain", [3], 7, 1, 19)
        # SAND: palms + a shipwreck cluster; LIGHTHOUSE on the east headland
        sand = self._cells(is_m("light_sand"))
        self._place(sand, "light_sand", [3, 4], 8, 5, 22)
        self._place(sand, "light_sand", [2], 7, 4, 23)
        head = self._cells(lambda x, y: s(x, y) and x > n * 0.8 and level[y, x] <= 8)
        self._place(head, "stone_mountain", [5], 1, 1, 26)      # lighthouse
        # DIRT trails / marsh
        self._place(self._cells(is_m("lightdark_dirt")), "lightdark_dirt", [2, 3], 5, 5, 25)

    # -- render ----------------------------------------------------------------

    def _ymax(self, im):
        a = np.asarray(im)
        ys = np.where((a[:, :, 3] > 20).any(axis=1))[0]
        return int(ys.max()) if len(ys) else 63

    def render(self, scale=1.0):
        n = self.n
        ox = (n - 1) * DX + 24
        oy = int(self.level.max()) * LEVEL_PX + 160
        W = (n + n) * DX + 48
        H = (n + n) * DY + 64 + int(self.level.max()) * LEVEL_PX + 240
        wc = self.lib.target_color("clear_water")
        canvas = Image.new("RGBA", (W, H), tuple(int(c) for c in wc) + (255,))
        order = sorted(((x, y) for y in range(n) for x in range(n)),
                       key=lambda p: (p[0] + p[1], p[1]))
        for x, y in order:
            m = self.mat[y, x]
            if m == "":
                continue
            bx = ox + (x - y) * DX
            by = oy + (x + y) * DY
            L = int(self.level[y, x])
            face = self.lib.img(self.lib.region_base(m, x, y))
            for lvl in range(L):
                canvas.alpha_composite(face, (bx, by - lvl * LEVEL_PX))
            timg = self.lib.img(self.top[y, x])
            if self.mirror[y, x]:
                timg = timg.transpose(Image.FLIP_LEFT_RIGHT)
            canvas.alpha_composite(timg, (bx, by - L * LEVEL_PX - (timg.height - 64)))
            p = self.props.get((x, y))
            if p is not None:
                pr = self.lib.img(p)
                canvas.alpha_composite(pr, (bx, (by - L * LEVEL_PX) + GROUND_BOTTOM - self._ymax(pr)))
            dk = self.deck_at.get((x, y))
            if dk is not None:
                dl, dth = dk["level"], dk["thickness"]
                dimg = self.lib.img(self.lib.region_base(dk["mat"], x, y))
                for lvl in range(dl - dth, dl):
                    canvas.alpha_composite(dimg, (bx, by - lvl * LEVEL_PX))
                canvas.alpha_composite(dimg, (bx, by - dl * LEVEL_PX - (dimg.height - 64)))
        if scale != 1.0:
            canvas = canvas.resize((int(W * scale), int(H * scale)), Image.LANCZOS)
        return canvas


def build(out=None, n=140, seed=11):
    d = Island(n=n, seed=seed)
    out = out or os.path.join(MAPS2, "worlds", "the_island")
    os.makedirs(out, exist_ok=True)
    decks_out = []
    for dk in d.decks:
        m = dk["mat"]
        cells = [{"x": x, "y": y, "top": d.lib.region_base(m, x, y), "mirror": 0}
                 for (x, y) in dk["cells"]]
        decks_out.append({"kind": dk["kind"], "mat": m, "level": dk["level"],
                          "thickness": dk["thickness"], "cells": cells})
    worldio.save_world(os.path.join(out, "world.json"), name="the_island",
                       mat=d.mat, top=d.top, mirror=d.mirror, level=d.level,
                       spawn=d.spawn, props=d.props, decks=decks_out)
    img = d.render()
    img.convert("RGB").save(os.path.join(out, "demo.png"))
    w = 2200
    img.resize((w, round(img.height * w / img.width)), Image.LANCZOS).convert("RGB").save(
        os.path.join(out, "preview.png"))
    from collections import Counter
    terr = Counter(m for m in d.mat.ravel() if m)
    viol = occlusion_violations(d.mat, d.level)
    assert not viol, f"camera-facing rule broken: {viol[:5]}"
    changed = int((d.level_before != d.level).sum())
    seen = d._reachable()
    land_cells = int((d.mat != "") .sum() - (d.mat == "clear_water").sum())
    reach = int(seen.sum())
    # per-tier reachability
    tiers = {}
    for lv in (0, 3, 8, 14, 22):
        band = (d.level >= lv) & (d.mat != "clear_water") & (d.mat != "")
        if lv < 22:
            band &= d.level < lv + 6 if lv else d.level <= 2
        tiers[lv] = (int((band & seen).sum()), int(band.sum()))
    comps = d._walk_components()
    print(f"the_island {n}x{n}: {len(d.props)} props; max level {int(d.level.max())}; "
          f"materials=" + ", ".join(f"{k.split('_')[0]}:{v}" for k, v in terr.most_common()))
    print(f"  occlusion lips: {len(viol)} {'[CLEAN]' if not viol else viol[:3]}")
    print(f"  monotone touched {changed} cells (light-touch); reachable {reach}/{land_cells} land")
    print(f"  walkable components (top 6 sizes): {[len(c) for c in comps[:6]]}")
    print(f"  tier reach (reached/total): " + ", ".join(f"L{lv}:{a}/{b}" for lv, (a, b) in tiers.items()))
    return d


if __name__ == "__main__":
    build()
