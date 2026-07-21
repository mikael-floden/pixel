"""the_island2 ("The Island 2") — the_island's mountain UPPER world + an ALttP
"Light-World"-style relief MAZE lower world, on a ~2x-bigger island.

The maintainer's brief: keep everything we learned building `the_island` for the
UPPER part (the massif that climbs "up up up"), but add the missing LOWER part —
the ALttP-style maze where the ground goes both UP and DOWN. Both worlds on one
island, wrapped in open ocean.

Two worlds under the camera-facing occlusion rule (`maps2/README.md` — land must
never step UP toward the camera with the SAME material):

  * UPPER (the mountain) is strictly ANTITONE, TERRACED onto flat benches
    {16,20,24,28,32} (Δ4 cliffs), peaks topping out on different benches with a
    carved valley + a flush alpine tarn, so it climbs in steps and undulates up AND
    down (mostly up). camera_monotone is masked to it -> occlusion-clean for free.
  * LOWER (the maze) uses genuine RELIEF at BIG tiers {0,4,12} (deltas mostly Δ4,
    some Δ8, rare Δ12), kept legal by the wall-material rule (_wall_rim + a
    neighbour-aware all-zones mat-only _lip_cover).
  * ASCENTS are a SMALL number of tidy Trollstigen SWITCHBACK corridors
    (_mountain_stairs / _climb_corridor); the rest of the mountain foot stays a
    clean sheer rock cliff. Dirt is used ONLY for roads/ramps.
  * WATER at MULTIPLE levels: the ocean plus flush inland ponds/tarns on maze tiers
    {4,12} and mountain benches {20,24} (_ponds), transactional so they never seal
    a region.
  * ROADS are an organic MEANDERING, BRANCHING dirt network (_dirt_roads): a
    wander-biased trunk spawn->summit through jittered waypoints, with landmark
    spurs that fork off the trunk at Y-junctions.
  * The island is INSET into a water frame (M-cell ocean margin on every side) so it
    is fully surrounded by sea, never clipped at the map edge.

Connectivity, zero-pits, bridges and the reachability proof reuse `the_island`'s
machinery. Everything hard-asserted in build(): occlusion clean, 100% prop-aware
reachable, no traps, main piece >= 97% land, bridges connect, maze >= 1.6x mountain,
max level >= 30, no land on the map border.
"""

from __future__ import annotations

import heapq
import math
import os
from collections import Counter, defaultdict, deque

import numpy as np
from PIL import Image

import worldio
from autotile import (PRIORITY, AutoTiler, camera_monotone_masked,
                      flatten_shores, occlusion_violations)
from islandworld import (Island, _dilate, _erode, _fbm, _h01, _largest_component,
                        MAPS2)
from tiles2lib import DX, DY, LEVEL_PX, Tiles2

# LOWER-world named features (fx,fy in [0,1], amp signed, radius in map-fraction).
FEATURES = [
    (0.62, 0.86, -2.0, 0.10),   # Sunken Hollow — a dry stone-rimmed canyon (tier 0)
    (0.30, 0.74, +2.4, 0.11),   # West Plateau — a gated tier-12 overlook (high)
    (0.76, 0.68, -2.2, 0.09),   # Mirror Lake basin (deepest -> water)
    (0.50, 0.62, +2.2, 0.13),   # central bench — a tier-12 rise splitting the routes
]

# UPPER world benches (Δ4 terraces); floor 16 sits a gated Δ4 above the maze cap 12.
BENCHES = np.array([16, 20, 24, 28, 32], np.int16)

# Depth gaussians ADDED before the antitone closure to carve a descending saddle-valley.
MTN_VALLEYS = [(0.38, 0.12, 24, 0.055), (0.41, 0.20, 24, 0.06),
               (0.44, 0.28, 22, 0.065), (0.47, 0.37, 20, 0.07)]

# Switchbacks / mountain ascents.
SWITCH_MIN = 4              # only cliffs of Δ>=4 zigzag
SWITCH_MAX = 6              # cap on the (now stairs-disabled) _merge_ramp switchback branch
MAX_SWITCH_CLIMB = 16      # one staged switchback may climb a full Δ16 foot as a 5-bench ribbon
SWITCH_LEG = 8             # longer, graceful flat legs
STAIR_CORRIDORS = 2        # exactly this many deliberate, tidy mountain ascents
STAIR_SPACING = 0.16       # min lateral separation between corridors (map-fraction)


class Island2(Island):
    def __init__(self, n=220, seed=21):
        self.n, self.seed = n, seed
        self.M = 10                       # ocean-margin ring; inset the design frame into it
        self.nd = n - 2 * self.M          # island design size
        assert self.nd == 200, "nd must stay 200 so every level/ratio/max-level is identical"
        self.lib = Tiles2()
        self.mat = np.full((n, n), "", object)
        self.level = np.zeros((n, n), np.int16)
        self.top = np.full((n, n), None, object)
        self.mirror = np.zeros((n, n), bool)
        self.props = {}
        self.decks = []
        self.reserved = set()
        self.links = []
        self.roads = set()
        self._nswitch = 0
        self._stairs_done = False
        self.road_feet = []
        self.spawn = self._to_grid(0.50, 0.90)

        self._coastline()                 # OVERRIDE: organic island INSET into a water frame
        self._zone_masks()                # UPPER (mountain) vs MAZE (front) on warped depth
        self._elevation_mountain()        # TERRACED onto benches 16..32 (antitone)
        self._tarn()                      # OVERRIDE: a FLUSH alpine ice tarn (not a level-0 well)
        self._relief()                    # big maze tiers {0,4,12} + a lake
        self._rooms()                     # snap the maze into flat chambers
        self._majority()                  # despeckle the maze level field
        self._maze_river()                # a winding water channel across the lowland (bridged)
        flatten_shores(self.mat, self.level)
        camera_monotone_masked(self.level, self.mat, self.upper)   # mountain antitone ONLY
        self.level_before = self.level.copy()
        self._materials()                 # mountain caps + maze floors/beaches (no dirt borders)
        self._wall_rim()                  # Pass A: recolour maze up-step rims -> wall material
        self._mountain_stairs()           # a few TIDY ascents; rest of the foot stays sheer cliff
        self._connect_all(thresh=5)       # reuse: clean connectors (no new zigzags) -> one piece
        self._ford_stranded()             # reuse: causeway across any water-locked pocket
        self._place_bridges(count=5)      # reuse: stone decks over water (both-bank checked)
        for _ in range(10):               # guarantee loop -> converge to no pit AND no lip
            camera_monotone_masked(self.level, self.mat, self.upper)
            self._fill_traps()
            self._lip_cover()
            if self._trap_count() == 0 and not occlusion_violations(self.mat, self.level):
                break
        self._ponds()                     # flush multi-level lakes (before spawn -> post-pond main)
        self._pick_spawn()
        self._dirt_roads()                # meandering, branching dirt ROAD network (ALttP red path)
        self._paint()
        self.deck_at = {(x, y): dk for dk in self.decks for (x, y) in dk["cells"]}
        self._decorate()
        self._reconnect_after_props()     # props collide: never let one seal off a region

    # -- inset coordinate transform --------------------------------------------

    def _to_grid(self, fx, fy):
        """Fraction (of the island design) -> grid cell, offset into the water frame.
        Inverse of the _coastline inset, so any explicitly-placed feature lands inside."""
        return int(fx * self.nd + self.M), int(fy * self.nd + self.M)

    # -- organic coastline, INSET into a water frame ---------------------------

    def _coastline(self):
        """Override of Island._coastline: identical coastline math, but the coordinate
        grid is remapped so the whole island sits INSIDE an M-cell ocean margin. Because
        nd==200 and the fbm phase X/scale is invariant to the n/nd factor, the island is
        the previous the_island2 fraction-for-fraction, just wrapped in open sea. An edge
        moat curves the coast inward and a hard border-clear guarantees the margin."""
        n, M, nd = self.n, self.M, self.nd
        Yg, Xg = np.mgrid[0:n, 0:n].astype(np.float32)
        self.X = (Xg - M) * (n / nd)          # virtual coords: island fills [0,n) inside the frame
        self.Y = (Yg - M) * (n / nd)
        X, Y, s = self.X, self.Y, self.seed
        cx, cy = n * 0.50, n * 0.56
        wx = X + n * 0.11 * (_fbm(X, Y, s + 11, n * 0.28, 4) - 0.5) * 2
        wy = Y + n * 0.11 * (_fbm(X, Y, s + 12, n * 0.28, 4) - 0.5) * 2
        r = np.hypot((wx - cx) / (0.46 * n), (wy - cy) / (0.42 * n))
        r += 0.14 * (_fbm(X, Y, s + 13, n * 0.5, 2) - 0.5)
        coast = (1.0 - r) + (_fbm(wx, wy, s + 2, n * 0.30, 5) - 0.5) * 1.05
        LOBES = [(0.52, 0.96, -0.55, 0.14), (0.34, 0.90, -0.30, 0.06), (0.70, 0.93, -0.28, 0.06),
                 (0.12, 0.58, +0.34, 0.10), (0.90, 0.50, +0.32, 0.10), (0.44, 0.09, +0.24, 0.09)]
        for fx, fy, amp, rad in LOBES:
            coast += amp * np.exp(-(((X - fx * n) ** 2 + (Y - fy * n) ** 2) / (2 * (rad * n) ** 2)))
        # edge moat: pull the coast inward near the grid border so no noise finger reaches it
        edge = np.minimum(np.minimum(Xg, n - 1 - Xg), np.minimum(Yg, n - 1 - Yg))
        coast -= 3.0 * np.clip((1.5 * M - edge) / (1.5 * M), 0, 1) ** 2
        land = coast > 0.0
        land = _largest_component(land)
        islet = np.exp(-(((X - 0.82 * n) ** 2 + (Y - 0.86 * n) ** 2) / (2 * (0.045 * n) ** 2))) > 0.5
        land |= islet
        land = _erode(_dilate(land, 1), 1)
        land[:M, :] = False; land[-M:, :] = False; land[:, :M] = False; land[:, -M:] = False
        self.land = land
        self.mat[land] = "saturated_grass"
        self.mat[~land] = "clear_water"

    # -- two-zone layout -------------------------------------------------------

    def _zone_masks(self):
        """Split the land front-to-back on a WARPED depth so the seam meanders."""
        n, X, Y, s = self.n, self.X, self.Y, self.seed
        d = (X + Y) / (2 * (n - 1))
        dw = d + (_fbm(X, Y, s + 70, n * 0.34, 4) - 0.5) * 0.10
        self.upper = self.land & (dw < 0.40)          # mountain (antitone, terraced 16..32)
        self.maze = self.land & ~self.upper           # the ALttP relief maze (the bulk)

    # -- upper world: the_island mountain, masked + TERRACED -------------------

    def _elevation_mountain(self):
        """`Island._elevation`'s antitone depth field restricted to the mountain mask, but
        TERRACED: the continuous height is snapped to flat benches {16..32} (Δ4 cliffs), a
        saddle-valley is carved before the closure, and the peaks top out on DIFFERENT
        benches — so the massif climbs in dramatic steps and undulates up AND down (mostly
        up) while staying strictly antitone (a monotone bench-snap keeps it antitone)."""
        n, X, Y, s, up = self.n, self.X, self.Y, self.seed, self.upper
        u = (X + Y)
        arm = 0.62 * np.abs(X - Y) + (_fbm(X, Y, s + 20, n * 0.30, 3) - 0.5) * 10
        warp = ((_fbm(X, Y, s, n * 0.30, 4) - 0.5) * 22
                + (_fbm(X, Y, s + 3, n * 0.13, 3) - 0.5) * 12
                + (_fbm(X, Y, s + 8, n * 0.06, 2) - 0.5) * 4)
        uplift = _fbm(X, Y, s + 5, n * 0.42, 3) * 8
        PEAKS = [(0.28, 0.11, 40, 0.10), (0.44, 0.07, 22, 0.09), (0.58, 0.13, 46, 0.11),
                 (0.71, 0.09, 18, 0.08), (0.17, 0.26, 16, 0.09), (0.85, 0.27, 30, 0.09)]
        ridge = np.zeros_like(u)
        for fx, fy, h, sg in PEAKS:
            ridge = np.maximum(ridge, h * np.exp(-(((X - fx * n) ** 2) / (2 * (sg * n) ** 2)
                                                   + ((Y - fy * n) ** 2) / (2 * (sg * 0.85 * n) ** 2))))
        depth = u - arm + warp - uplift - ridge
        for fx, fy, amp, rad in MTN_VALLEYS:
            depth += amp * np.exp(-(((X - fx * n) ** 2 + (Y - fy * n) ** 2) / (2 * (rad * n) ** 2)))
        depth[~up] = 1e9
        self._camera_max_float(depth, up)
        dl = depth[up]
        d = (depth - dl.min()) / (dl.max() - dl.min() + 1e-6)
        h = 16.0 + (1.0 - d) * (32 - 16)
        idx = np.abs(h[..., None] - BENCHES.astype(np.float32)).argmin(-1)
        lvl = BENCHES[idx]
        self.level[up] = lvl[up]

    def _tarn(self):
        """Override of Island._tarn (base sinks to level 0 = a deep well). Instead flush the
        alpine ice tarn to its rim's MODAL bench level, so it reads as a filled pool on the
        massif shoulder (water at a non-zero level — the maintainer's multi-level water)."""
        n, X, Y, s = self.n, self.X, self.Y, self.seed
        bx = X + n * 0.09 * (_fbm(X, Y, s + 40, n * 0.26, 3) - 0.5) * 2
        by = Y + n * 0.09 * (_fbm(X, Y, s + 41, n * 0.26, 3) - 0.5) * 2
        tar = _fbm(bx, by, s + 22, n * 0.10, 3)
        sink = (self.level >= 16) & (self.level < 24) & (tar > 0.74) & self.upper
        for comp in self._mask_components(sink):
            rim = Counter()
            for (x, y) in comp:
                for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    xx, yy = x + i, y + j
                    if (0 <= xx < n and 0 <= yy < n and not sink[yy, xx]
                            and self.mat[yy, xx] not in ("", "clear_water")):
                        rim[int(self.level[yy, xx])] += 1
            L = rim.most_common(1)[0][0] if rim else int(self.level[comp[0][1], comp[0][0]])
            for (x, y) in comp:
                self.mat[y, x] = "clear_water"
                self.level[y, x] = L

    # -- lower world: signed relief -> flat maze chambers (big deltas) ----------

    def _relief(self):
        """A signed, domain-warped low-frequency field quantised into three BIG tiers
        {0,4,12} that go up AND down: deltas mostly Δ4, some Δ8, rare Δ12 (>10 fog-exempt).
        Deepest ~11% -> a lake; a gentle climb keeps the back of the maze high."""
        n, X, Y, s, mz = self.n, self.X, self.Y, self.seed, self.maze
        wx = X + n * 0.13 * (_fbm(X, Y, s + 30, n * 0.28, 4) - 0.5) * 2
        wy = Y + n * 0.13 * (_fbm(X, Y, s + 31, n * 0.28, 4) - 0.5) * 2
        R = (_fbm(wx, wy, s + 32, n * 0.20, 4) - 0.5) * 2.0
        R += (_fbm(wx, wy, s + 33, n * 0.09, 3) - 0.5) * 1.1
        d = (X + Y) / (2 * (n - 1))
        R += 0.45 * (1.0 - d)
        for fx, fy, amp, rad in FEATURES:
            R += amp * np.exp(-(((X - fx * n) ** 2 + (Y - fy * n) ** 2) / (2 * (rad * n) ** 2)))
        Rm = np.where(mz, R, np.nan)
        qs = np.nanquantile(Rm, [0.45, 0.85])
        tier = np.array([0, 4, 12], np.int16)
        idx = np.digitize(R, qs)
        self.level[mz] = tier[idx][mz]
        lake = mz & (R < np.nanquantile(Rm, 0.11))
        self.mat[lake] = "clear_water"
        self.level[lake] = 0

    def _rooms(self, RS=20):
        """Snap the maze into FLAT chambers on a warped lattice (mode of the relief tier)
        -> crisp flat rooms separated by clean Δ>=4 cliffs. Lake-only rooms stay water."""
        n, X, Y, s = self.n, self.X, self.Y, self.seed
        rwx = X + n * 0.05 * (_fbm(X, Y, s + 34, n * 0.10, 3) - 0.5) * 2
        rwy = Y + n * 0.05 * (_fbm(X, Y, s + 35, n * 0.10, 3) - 0.5) * 2
        rid = np.floor(rwx / RS).astype(np.int64) * 997 + np.floor(rwy / RS).astype(np.int64)
        self.room = np.full((n, n), -1, np.int64)
        cells = defaultdict(list)
        for y in range(n):
            for x in range(n):
                if self.maze[y, x]:
                    cells[int(rid[y, x])].append((x, y))
        for r, cl in cells.items():
            lvls = [int(self.level[y, x]) for (x, y) in cl if self.mat[y, x] != "clear_water"]
            if not lvls:
                continue
            mode = Counter(lvls).most_common(1)[0][0]
            for (x, y) in cl:
                self.room[y, x] = r
                if self.mat[y, x] != "clear_water":
                    self.level[y, x] = mode

    def _maze_river(self):
        """A winding water channel across the maze lowland, mostly VERTICAL so its channel
        aligns across rows (lets `_place_bridges` seat stone decks). Routed through the
        inset frame via `_to_grid`."""
        n, s = self.n, self.seed
        PATH = [self._to_grid(fx, fy) for fx, fy in
                ((0.44, 0.42), (0.47, 0.55), (0.45, 0.68), (0.48, 0.80), (0.46, 0.95))]
        for (ax, ay), (bx, by) in zip(PATH, PATH[1:]):
            steps = int(math.hypot(bx - ax, by - ay)) + 1
            for i in range(steps + 1):
                t = i / steps
                wob = (_fbm(np.float32(ax + (bx - ax) * t), np.float32(ay),
                            s + 77, n * 0.06, 3) - 0.5) * 6
                cx = int(ax + (bx - ax) * t + wob)
                cy = int(ay + (by - ay) * t)
                for dx in range(-1, 2):
                    for dy in range(-1, 2):
                        x, y = cx + dx, cy + dy
                        if 0 <= x < n and 0 <= y < n and self.maze[y, x] and self.land[y, x]:
                            self.mat[y, x] = "clear_water"
                            self.level[y, x] = 0

    def _majority(self, passes=2):
        """3x3 mode filter over maze LAND levels — despeckle 1-cell level islands."""
        n = self.n
        for _ in range(passes):
            lv = self.level.copy()
            for y in range(n):
                for x in range(n):
                    if not self.maze[y, x] or self.mat[y, x] == "clear_water":
                        continue
                    vals = []
                    for j in (-1, 0, 1):
                        for i in (-1, 0, 1):
                            xx, yy = x + i, y + j
                            if (0 <= xx < n and 0 <= yy < n and self.maze[yy, xx]
                                    and self.mat[yy, xx] != "clear_water"):
                                vals.append(int(lv[yy, xx]))
                    if vals:
                        self.level[y, x] = Counter(vals).most_common(1)[0][0]

    # -- occlusion legality for the maze (wall-material rule + lip-cover) -------

    def _wall_mat(self, x, y):
        """Wall material for a Pass-A rim (only 4 and 12 exist there): 4->stone, 12->obsidian."""
        return "stone_mountain" if int(self.level[y, x]) < 8 else "black_mountain"

    def _wall_rim(self):
        """Pass A (vectorised): recolour the HIGHER rim of every same-material toward-camera
        up-step of 1..10 in the maze to a wall material; Δ12 keeps its grass top (fog-exempt)."""
        n, mat, level = self.n, self.mat, self.level
        land = (mat != "") & (mat != "clear_water")
        lv = level.astype(np.int32)
        same_hi = np.zeros((n, n), bool)
        dhx = lv[:, 1:] - lv[:, :-1]
        same_hi[:, 1:] |= (land[:, 1:] & land[:, :-1] & (dhx >= 1) & (dhx <= 10)
                           & (mat[:, 1:] == mat[:, :-1]))
        dhy = lv[1:, :] - lv[:-1, :]
        same_hi[1:, :] |= (land[1:, :] & land[:-1, :] & (dhy >= 1) & (dhy <= 10)
                           & (mat[1:, :] == mat[:-1, :]))
        rim = same_hi & self.maze & land
        floor = np.isin(mat, np.array(["saturated_grass", "light_sand", "lightdark_dirt"], object))
        for (y, x) in np.argwhere(rim & floor):
            mat[y, x] = self._wall_mat(x, y)

    def _lip_cover(self, max_iter=8):
        """Pass B (to fixpoint): recolour the HIGHER cell of every residual same-material
        toward-camera lip to a wall material DIFFERING from the LOWER cell — mat-only, all
        zones. Covers the maze rims AND the rare dirt-over-dirt clash where ascents abut."""
        for _ in range(max_iter):
            viol = occlusion_violations(self.mat, self.level)
            if not viol:
                return True
            for ((lx, ly), (hx, hy), _dh) in sorted(viol, key=lambda v: v[1][0] + v[1][1]):
                lo = self.mat[ly, lx]
                self.mat[hy, hx] = "black_mountain" if lo == "stone_mountain" else "stone_mountain"
        return not occlusion_violations(self.mat, self.level)

    # -- Trollstigen switchback ascents (a few tidy corridors, rest sheer cliff) --

    def _carve_switchback(self, hx, hy, lx, ly, leg=SWITCH_LEG, min_climb=SWITCH_MIN):
        """A tidy Z-road up a cliff. hi=(hx,hy) is the TOP (up-screen, level H); lo=(lx,ly)
        its toward-camera neighbour on the low tier (level L). Flat DIRT benches (uniform
        rise 4) joined by up-screen risers, so the climb only ever rises away from camera
        (antitone/legal) and the uncarved native cliff walls the legs into a zigzag. A Δ4
        cliff -> one clean L; up to a Δ16 foot -> a clean 5-bench staged ribbon. All-or-
        nothing plan+validate; caller falls back to a straight spur if it won't fit."""
        n = self.n
        H, L = int(self.level[hy, hx]), int(self.level[ly, lx])
        if not (min_climb <= H - L <= MAX_SWITCH_CLIMB):
            return False
        dx, dy = lx - hx, ly - hy
        if (dx, dy) not in ((1, 0), (0, 1)):
            return False
        px, py = dy, dx
        rise = 4
        gap = rise + 1
        levels = list(range(L, H, rise)) + [H]
        B = len(levels)
        for sgn in (1, -1):
            cells = []
            for k, lvl in enumerate(levels):
                up = gap * (B - 1 - k)
                bx, by = hx + dx * up, hy + dy * up
                rng = range(0, leg + 1) if k % 2 == 0 else range(leg, -1, -1)
                end = (bx, by)
                for t in rng:
                    end = (bx + sgn * px * t, by + sgn * py * t)
                    cells.append((end[0], end[1], lvl))
                if k < B - 1:
                    for g in range(1, gap):
                        cells.append((end[0] - dx * g, end[1] - dy * g, lvl + g))
            if all(0 <= x < n and 0 <= y < n and self.land[y, x]
                   and self.mat[y, x] != "clear_water" and (x, y) not in self.reserved
                   for (x, y, _l) in cells):
                for (x, y, lvl) in cells:
                    self.level[y, x] = lvl
                    self.mat[y, x] = "lightdark_dirt"
                    self.upper[y, x] = False
                    self.reserved.add((x, y))
                self.road_feet.append((lx, ly))
                self._nswitch += 1
                return True
        return False

    def _mountain_stairs(self, k=STAIR_CORRIDORS):
        """Place exactly k deliberate, laterally-separated Trollstigen corridors up the
        mountain foot; the rest of the foot stays a clean sheer rock cliff. Prefers tidy,
        camera-ward, small-drop feet. Sets self._stairs_done so `_connect_all` never sprouts
        a new zigzag afterwards (concern 3: no more chaotic stair-blob)."""
        n, up = self.n, self.upper
        foot = []
        for y in range(n):
            for x in range(n):
                if not (up[y, x] and self.mat[y, x] != "clear_water"):
                    continue
                for i, j in ((1, 0), (0, 1)):          # toward-camera
                    xx, yy = x + i, y + j
                    if (0 <= xx < n and 0 <= yy < n and self.maze[yy, xx]
                            and self.mat[yy, xx] != "clear_water"):
                        drop = int(self.level[y, x]) - int(self.level[yy, xx])
                        if drop >= SWITCH_MIN:
                            foot.append((drop, x, y, xx, yy))
        foot.sort(key=lambda f: (f[0], -(f[3] + f[4])))   # tidy Δ4 feet, front-most first
        chosen = []
        for drop, hx, hy, lx, ly in foot:
            if len(chosen) >= k:
                break
            if any((hx - cx) ** 2 + (hy - cy) ** 2 < (STAIR_SPACING * n) ** 2
                   for cx, cy in chosen):
                continue
            if self._climb_corridor(hx, hy, lx, ly):
                chosen.append((hx, hy))
        self._stairs_done = True

    def _climb_corridor(self, hx, hy, lx, ly):
        """Carve one narrow aligned ribbon: a foot switchback (maze -> first bench), then a
        tidy Δ4 switchback per bench up 16->20->24->28->32 following up-screen neighbours."""
        n = self.n
        if not self._carve_switchback(hx, hy, lx, ly):
            return False
        cx, cy = hx, hy
        for _ in range(6):
            Lc = int(self.level[cy, cx])
            nxt = None
            for (bx, by) in ((cx - 1, cy), (cx, cy - 1)):   # up-screen neighbours
                if (0 <= bx < n and 0 <= by < n and self.upper[by, bx]
                        and int(self.level[by, bx]) - Lc >= SWITCH_MIN):
                    nxt = (bx, by, cx, cy)
                    break
            if not nxt or not self._carve_switchback(*nxt):
                break
            cx, cy = nxt[0], nxt[1]
        return True

    def _merge_ramp(self, main, cands):
        """Post-stairs mop-up: connect residual pockets with short clean straight connectors,
        least-intrusive first (away from the pristine mountain foot). Because _mountain_stairs
        already set _stairs_done, this NEVER carves a new switchback -> the foot stays clean
        rock cliff. The straight-spur fallback still guarantees every rampable component joins."""
        edges = []
        n = self.n
        for cand in cands:
            for (cx, cy) in cand:
                for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    mx, my = cx + i, cy + j
                    if not (0 <= mx < n and 0 <= my < n) or (mx, my) not in main:
                        continue
                    if abs(int(self.level[cy, cx]) - int(self.level[my, mx])) <= 1:
                        continue
                    if int(self.level[cy, cx]) < int(self.level[my, mx]):
                        hi, lo = (mx, my), (cx, cy)
                    else:
                        hi, lo = (cx, cy), (mx, my)
                    drop = abs(int(self.level[hi[1], hi[0]]) - int(self.level[lo[1], lo[0]]))
                    is_foot = 1 if (self.upper[hi[1], hi[0]] and not self.upper[lo[1], lo[0]]) else 0
                    edges.append(((is_foot, drop), hi, lo))
        edges.sort(key=lambda e: e[0])
        for _key, hi, lo in edges:
            drop = abs(int(self.level[hi[1], hi[0]]) - int(self.level[lo[1], lo[0]]))
            if (not self._stairs_done and drop >= SWITCH_MIN
                    and self._nswitch < SWITCH_MAX and self._carve_switchback(*hi, *lo)):
                return True
            if self._carve_connector(*hi, *lo):
                return True
        return False

    def _carve_connector(self, hx, hy, lx, ly, w=3):
        """Override: straight descending dirt spur that also clears self.upper on carved
        cells (so a terraced-mountain fallback spur isn't re-raised by the guarantee loop)."""
        n = self.n
        H, L = int(self.level[hy, hx]), int(self.level[ly, lx])
        if H <= L + 1:
            return False
        dx, dy = lx - hx, ly - hy
        if (dx, dy) not in ((1, 0), (0, 1)):
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
                    self.upper[y, x] = False
                    self.reserved.add((x, y))
        return True

    # -- materials: dirt is ROADS, not borders ---------------------------------

    def _materials(self):
        """Override of Island._materials with the two GENERIC-DIRT sources removed (dry-meadow
        speckle dropped; obsidian collar is stone, not dirt), so dirt survives ONLY as roads.
        Snow only near the peaks (>=28) so the massif reads as rock with snowy caps."""
        n, X, Y, s = self.n, self.X, self.Y, self.seed
        mat, level = self.mat, self.level
        g = mat == "saturated_grass"
        mat[g & (level >= 14)] = "stone_mountain"
        mat[(mat == "stone_mountain") & (level >= 28)] = "regular_snow"
        bx = X + n * 0.09 * (_fbm(X, Y, s + 40, n * 0.26, 3) - 0.5) * 2
        by = Y + n * 0.09 * (_fbm(X, Y, s + 41, n * 0.26, 3) - 0.5) * 2
        glac = _fbm(bx, by, s + 13, n * 0.13, 3)
        mat[(mat == "regular_snow") & (glac > 0.52) & (level >= 32)] = "crystal_ice"
        cald = _fbm(bx, by, s + 9, n * 0.11, 4)
        scar = _fbm(bx, by, s + 50, n * 0.085, 3)
        black = (((mat == "regular_snow") & (cald > 0.60) & (level >= 30))
                 | ((mat == "stone_mountain") & (level >= 16) & (level < 28)
                    & (X < n * 0.56) & (scar > 0.58)))
        black = black & ~_dilate(mat == "saturated_grass", 2)        # STONE collar, not dirt
        mat[black] = "black_mountain"
        water = mat == "clear_water"
        d2w = np.full((n, n), 99, np.int16)
        ring = water.copy()
        for dist in range(1, 8):
            nd = _dilate(ring, 1) & ~ring
            d2w[nd & (d2w == 99)] = dist
            ring = ring | nd
        sd = _fbm(bx, by, s + 60, n * 0.12, 3)
        sand_depth = (1 + np.rint(sd * sd * 7)).astype(np.int16)
        beach = (mat == "saturated_grass") & (level <= 2) & (d2w < 99) & (d2w <= sand_depth)
        mat[beach] = "light_sand"

    # -- multi-level lakes (flush inland ponds/tarns) --------------------------

    def _mask_components(self, mask):
        """4-connected components of a boolean grid -> list of cell-lists."""
        n = self.n
        seen = np.zeros((n, n), bool)
        out = []
        for y in range(n):
            for x in range(n):
                if mask[y, x] and not seen[y, x]:
                    q, comp = deque([(x, y)]), []
                    seen[y, x] = True
                    while q:
                        a, b = q.popleft()
                        comp.append((a, b))
                        for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                            xx, yy = a + i, b + j
                            if 0 <= xx < n and 0 <= yy < n and mask[yy, xx] and not seen[yy, xx]:
                                seen[yy, xx] = True
                                q.append((xx, yy))
                    out.append(comp)
        return out

    def _reserved_np(self):
        n = self.n
        r = np.zeros((n, n), bool)
        for (x, y) in self.reserved:
            r[y, x] = True
        return _dilate(r, 1)

    def _rim_flat(self, comp, L):
        """Every non-blob 4-neighbour of the pond must be LAND at exactly level L and in
        bounds -> a flush pool (uniform rim, no water side-cliff) that never touches the edge."""
        n = self.n
        cs = set(comp)
        for (x, y) in comp:
            for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                xx, yy = x + i, y + j
                if not (0 <= xx < n and 0 <= yy < n):
                    return False
                if (xx, yy) in cs:
                    continue
                m = self.mat[yy, xx]
                if m == "" or m == "clear_water" or int(self.level[yy, xx]) != L:
                    return False
        return True

    def _commit_pond_if_safe(self, comp, L):
        """Transactionally paint a pond at level L; keep it only if the main walkable piece
        stays >=98% of land AND traps==0 — else fully revert. Guarantees the connectivity
        asserts survive (water is a barrier)."""
        saved = [(x, y, self.mat[y, x], int(self.level[y, x])) for (x, y) in comp]
        for (x, y) in comp:
            self.mat[y, x] = "clear_water"
            self.level[y, x] = L
        walk = (self.mat != "") & (self.mat != "clear_water")
        land = int(walk.sum())
        comps = self._walk_components()
        main = len(comps[0]) if comps else 0
        if land > 0 and main >= 0.98 * land and self._trap_count() == 0:
            self.reserved.update(comp)
            return True
        for (x, y, m, lv) in saved:
            self.mat[y, x] = m
            self.level[y, x] = lv
        return False

    def _ponds(self):
        """Small FLUSH lakes at MULTIPLE levels: maze tiers {4,12} and mountain benches
        {20,24}. Each is a small fbm blob painted clear_water AT the surrounding land level L
        (render stacks it to L -> a filled pool, not a well), off shorelines/roads, with a
        uniform flush rim, committed only if it doesn't seal a region. Guards the two maze
        plans so maze_land stays >= 1.7x upper_land (protecting the 1.6x assert)."""
        n, X, Y, s = self.n, self.X, self.Y, self.seed
        water = (self.mat == "clear_water")
        forbid = (_dilate(water, 3) & ~water) | self._reserved_np()
        upper_land = int((self.upper & (self.mat != "clear_water")).sum())
        PLANS = [(self.maze & (self.level == 4), 4, s + 120, 0.62, 55, True),
                 (self.maze & (self.level == 12), 12, s + 121, 0.70, 30, True),
                 (self.upper & (self.level == 20), 20, s + 122, 0.64, 45, False),
                 (self.upper & (self.level == 24), 24, s + 123, 0.70, 30, False)]
        for mask, L, sd, thr, cap, is_maze in PLANS:
            base = mask & (self.mat != "clear_water") & ~forbid
            blob = base & (_fbm(X, Y, sd, n * 0.045, 3) > thr)
            for comp in self._mask_components(blob):
                if not (3 <= len(comp) <= cap and self._rim_flat(comp, L)):
                    continue
                if is_maze:
                    maze_land = int((self.maze & (self.mat != "clear_water")).sum())
                    if maze_land - len(comp) < 1.7 * upper_land:
                        continue
                self._commit_pond_if_safe(comp, L)

    # -- dirt ROAD network: organic MEANDERING + BRANCHING (ALttP red path) -----

    def _wander_field(self):
        """Cached smooth low-frequency scalar in [0,1] added to road edge costs, so least-
        cost paths bow through its grooves into organic bends instead of running straight."""
        if getattr(self, "_wander", None) is None:
            n, X, Y, s = self.n, self.X, self.Y, self.seed
            w = _fbm(X, Y, s + 91, n * 0.16, 4) + 0.5 * _fbm(X, Y, s + 92, n * 0.07, 3)
            self._wander = (w - w.min()) / (w.max() - w.min() + 1e-6)
        return self._wander

    def _water_adjacent(self):
        w = (self.mat == "clear_water")
        return _dilate(w, 1) & (self.mat != "clear_water") & (self.mat != "")

    def _road_graph_bfs(self, sources, dirt_bonus=0.5, water_pen=3.0, wander_amp=0.9):
        """Multi-source Dijkstra over the EXACT walkable graph (4-neighbour |Δlevel|<=1 +
        bridge links). `sources` is a single (x,y) tuple OR an iterable (all seeded at 0).
        Cheaper on existing dirt (fuses onto ramps/switchbacks), dearer near water, and
        biased by the wander field so paths meander. Returns dist{}, parent{}."""
        n, mat, level = self.n, self.mat, self.level
        land = lambda x, y: mat[y, x] != "" and mat[y, x] != "clear_water"
        ladj, wadj, wf = self._link_adj(), self._water_adjacent(), self._wander_field()
        dist, parent, pq = {}, {}, []
        src = [sources] if isinstance(sources, tuple) else list(sources)
        for (sx, sy) in src:
            if land(sx, sy) and (sx, sy) not in dist:
                dist[(sx, sy)] = 0.0
                heapq.heappush(pq, (0.0, sx, sy))
        while pq:
            dd, x, y = heapq.heappop(pq)
            if dd > dist.get((x, y), 1e18):
                continue
            nbrs = [((x + i, y + j), True) for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1))]
            nbrs += [(v, False) for v in ladj.get((x, y), ())]
            for (xx, yy), needs_adj in nbrs:
                if not (0 <= xx < n and 0 <= yy < n and land(xx, yy)):
                    continue
                if needs_adj and abs(int(level[yy, xx]) - int(level[y, x])) > 1:
                    continue
                w = 1.0
                if mat[yy, xx] == "lightdark_dirt":
                    w -= dirt_bonus
                if wadj[yy, xx]:
                    w += water_pen
                w += wander_amp * float(wf[yy, xx])
                nd = dd + w
                if nd < dist.get((xx, yy), 1e18):
                    dist[(xx, yy)] = nd
                    parent[(xx, yy)] = (x, y)
                    heapq.heappush(pq, (nd, xx, yy))
        return dist, parent

    def _road_path(self, a, b):
        dist, parent = self._road_graph_bfs(a)
        if b not in dist:
            return []
        path, cur = [], b
        while cur != a:
            path.append(cur)
            cur = parent[cur]
        path.append(a)
        return path

    def _jitter_waypoints(self, a, b, reach, k=3, amp=0.10):
        """k targets along a->b pushed laterally off the line by smooth noise, each snapped
        to the nearest REACHABLE cell (always on the walkable graph) -> S-curves for the trunk."""
        n, s = self.n, self.seed
        (ax, ay), (bx, by) = a, b
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy) or 1.0
        px, py = -dy / L, dx / L
        out = []
        for i in range(1, k + 1):
            t = i / (k + 1)
            mx, my = ax + dx * t, ay + dy * t
            off = (_fbm(np.float32(mx), np.float32(my), s + 93, n * 0.12, 3) - 0.5) * 2 * amp * n
            tx, ty = mx + px * off, my + py * off
            c = min(reach, key=lambda c: (c[0] - tx) ** 2 + (c[1] - ty) ** 2, default=None)
            if c and c not in out:
                out.append(c)
        return out

    def _road_attach(self, dest, road):
        """Attach `dest` to the growing network via multi-source Dijkstra seeded from ALL
        current road cells -> the shortest meandering spur from dest to its FORK point (a
        Y/T junction on the trunk)."""
        if not road or dest in road:
            return []
        dist, parent = self._road_graph_bfs(list(road))
        if dest not in dist:
            return []
        path, cur = [], dest
        while cur not in road:
            path.append(cur)
            cur = parent[cur]
        path.append(cur)                     # the fork cell (already in road)
        return path

    def _dirt_roads(self):
        """A MEANDERING, BRANCHING dirt trunk (the ALttP red path): a wander-biased trunk
        spawn->summit through jittered waypoints (S-curves), plus landmark SPURS that fork
        off the trunk at Y-junctions (multi-source attach). Widened ~2-3 cells on flats,
        mat-only (never changes level), reserved so props avoid it, occlusion-safe (dirt vs
        grass is a legal seam; trailing _lip_cover). Roads run any direction — the auto-tiler
        makes the seam read as a worn path."""
        n, mat, level = self.n, self.mat, self.level
        dist0, _ = self._road_graph_bfs(self.spawn)
        reach = set(dist0)
        if not reach:
            return

        def near(fx, fy):
            tx, ty = self._to_grid(fx, fy)
            return min(reach, key=lambda c: (c[0] - tx) ** 2 + (c[1] - ty) ** 2, default=None)

        up = [c for c in reach if self.upper[c[1], c[0]]]
        summit = max(up, key=lambda c: int(level[c[1], c[0]])) if up else None
        road = set()
        if summit:
            chain = [self.spawn] + self._jitter_waypoints(self.spawn, summit, reach, k=3) + [summit]
            cur = chain[0]
            for w in chain[1:]:
                seg = self._road_path(cur, w)
                if seg:
                    road.update(seg)
                    cur = w
        if not road:
            road = {self.spawn}
        LANDMARKS = [(0.50, 0.62), (0.30, 0.74), (0.62, 0.86), (0.76, 0.62),
                     (0.15, 0.58), (0.85, 0.60), (0.66, 0.40)]
        for fx, fy in LANDMARKS:
            d = near(fx, fy)
            if d is None or d in road:
                continue
            spur = self._road_attach(d, road)
            if len(spur) >= 2:
                road.update(spur)
        wide = set(road)
        for (x, y) in road:
            for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                xx, yy = x + i, y + j
                if (0 <= xx < n and 0 <= yy < n and (xx, yy) in reach
                        and int(level[yy, xx]) == int(level[y, x])
                        and mat[yy, xx] in ("saturated_grass", "light_sand", "lightdark_dirt")):
                    wide.add((xx, yy))
        for (x, y) in wide:
            if mat[y, x] in ("saturated_grass", "light_sand"):
                mat[y, x] = "lightdark_dirt"
            self.reserved.add((x, y))
        self.roads = wide
        self._lip_cover()

    def _trap_count(self):
        """Walkable cells cut off from the main component yet land-adjacent to it (a pit)."""
        comps = self._walk_components()
        if len(comps) <= 1:
            return 0
        mainset = set(comps[0])
        return sum(len(c) for c in comps[1:]
                   if any((x + i, y + j) in mainset for (x, y) in c
                          for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1))))

    # -- prop-aware reachability (props collide in worldio) --------------------

    def _reach_blocked(self, blocked):
        """BFS reachability from spawn over |Δlevel|<=1 + bridge links, treating `blocked`
        (prop cells — collision=1) as walls."""
        n, mat, level = self.n, self.mat, self.level
        land = lambda x, y: (mat[y, x] != "" and mat[y, x] != "clear_water"
                             and (x, y) not in blocked)
        sx, sy = self.spawn
        ladj = self._link_adj()
        seen = np.zeros((n, n), bool)
        if not land(sx, sy):
            return seen
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

    def _reconnect_after_props(self, max_iter=200):
        """A prop cell blocks movement. While any terrain cell the player should reach is cut
        off ONLY by props, BFS from the reachable set THROUGH props to the nearest such cell
        and delete the minimal prop chain on that path. The water-locked islet stays so."""
        n = self.n
        terrain = self._reach_blocked(set())
        walk = (self.mat != "") & (self.mat != "clear_water")
        ladj = self._link_adj()
        for _ in range(max_iter):
            props = set(self.props)
            seen = self._reach_blocked(props)
            propmask = np.zeros((n, n), bool)
            for (x, y) in props:
                propmask[y, x] = True
            cut = terrain & ~seen & ~propmask
            if not cut.any():
                return
            vis = seen.copy()
            parent = {}
            dq = deque((x, y) for (y, x) in np.argwhere(seen))
            found = None
            while dq and found is None:
                x, y = dq.popleft()
                step = [((x + i, y + j), True) for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1))]
                step += [(v, False) for v in ladj.get((x, y), ())]
                for (xx, yy), needs_adj in step:
                    if not (0 <= xx < n and 0 <= yy < n) or vis[yy, xx] or not walk[yy, xx]:
                        continue
                    if needs_adj and abs(int(self.level[yy, xx]) - int(self.level[y, x])) > 1:
                        continue
                    vis[yy, xx] = True
                    parent[(xx, yy)] = (x, y)
                    if cut[yy, xx]:
                        found = (xx, yy)
                        break
                    dq.append((xx, yy))
            if found is None:
                return
            cur = found
            while cur in parent:
                self.props.pop(cur, None)
                cur = parent[cur]


def build(out=None, n=220, seed=21):
    d = Island2(n=n, seed=seed)
    out = out or os.path.join(MAPS2, "worlds", "the_island2")
    os.makedirs(out, exist_ok=True)
    decks_out = []
    for dk in d.decks:
        m = dk["mat"]
        cells = [{"x": x, "y": y, "top": d.lib.region_base(m, x, y), "mirror": 0}
                 for (x, y) in dk["cells"]]
        decks_out.append({"kind": dk["kind"], "mat": m, "level": dk["level"],
                          "thickness": dk["thickness"], "cells": cells})
    worldio.save_world(os.path.join(out, "world.json"), name="the_island2",
                       mat=d.mat, top=d.top, mirror=d.mirror, level=d.level,
                       spawn=d.spawn, props=d.props, decks=decks_out)
    img = d.render()
    img.convert("RGB").save(os.path.join(out, "demo.png"))
    w = 2400
    img.resize((w, round(img.height * w / img.width)), Image.LANCZOS).convert("RGB").save(
        os.path.join(out, "preview.png"))

    # --- assert battery ---
    terr = Counter(m for m in d.mat.ravel() if m)
    viol = occlusion_violations(d.mat, d.level)
    assert not viol, f"camera-facing rule broken: {viol[:5]}"

    upper_land = int((d.upper & (d.mat != "clear_water")).sum())
    maze_land = int((d.maze & (d.mat != "clear_water")).sum())
    assert maze_land >= 1.6 * upper_land, \
        f"maze not dominant: maze {maze_land} < 1.6 * upper {upper_land}"

    assert int(d.level.max()) >= 30, f"mountain too short: max level {int(d.level.max())}"

    # island fully surrounded by ocean: no LAND in the outer M-ring
    M = d.M
    land_mask = (d.mat != "") & (d.mat != "clear_water")
    border = np.zeros((n, n), bool)
    border[:M, :] = border[-M:, :] = border[:, :M] = border[:, -M:] = True
    assert int((land_mask & border).sum()) == 0, "island touches map border (no water margin)"

    walk = land_mask
    land_cells = int(walk.sum())
    propmask = np.zeros((d.n, d.n), bool)
    for (x, y) in d.props:
        propmask[y, x] = True
    terrain_seen = d._reach_blocked(set())
    prop_seen = d._reach_blocked(set(d.props))
    sealed = int((terrain_seen & ~propmask & ~prop_seen).sum())
    assert sealed == 0, f"props seal off {sealed} walkable cell(s)"
    reach = int(prop_seen.sum())
    unreachable = land_cells - int(terrain_seen.sum())

    comps = d._walk_components()
    mainset = set(comps[0])
    traps = sum(len(c) for c in comps[1:]
                if any((x + i, y + j) in mainset for (x, y) in c
                       for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1))))
    assert traps == 0, f"pit trap: {traps} walkable cells cut off yet land-adjacent to main"
    assert len(comps[0]) >= 0.97 * land_cells, \
        f"main walkable piece covers only {len(comps[0])}/{land_cells} land"

    for dk in d.decks:
        xs = [c[0] for c in dk["cells"]]
        x0, x1, dlv = min(xs), max(xs), dk["level"]
        for r in sorted({c[1] for c in dk["cells"]}):
            for bx in (x0 - 1, x1 + 1):
                assert (d.mat[r, bx] not in ("", "clear_water")
                        and abs(int(d.level[r, bx]) - dlv) <= 1
                        and (bx, r) in mainset), f"bridge end not walkable at ({bx},{r})"

    print(f"the_island2 {n}x{n}: {len(d.props)} props; max level {int(d.level.max())}; "
          f"switchbacks {d._nswitch} in {STAIR_CORRIDORS} corridors; road {len(d.roads)}")
    print(f"  zones: upper(mtn) {upper_land} land, maze {maze_land} land "
          f"(maze/upper = {maze_land / max(1, upper_land):.2f}x)")
    print(f"  occlusion lips: {len(viol)} {'[CLEAN]' if not viol else viol[:3]}")
    print(f"  reachable (prop-aware) {reach}/{land_cells} land "
          f"({unreachable} water-locked islet); traps {traps}; decks {len(d.decks)}")
    print(f"  walkable components (top 6 sizes): {[len(c) for c in comps[:6]]}")
    print(f"  materials=" + ", ".join(f"{k.split('_')[0]}:{v}" for k, v in terr.most_common()))
    return d


if __name__ == "__main__":
    build()
