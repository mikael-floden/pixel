"""the_island2 ("The Island 2") — the_island's mountain UPPER world + an ALttP
"Light-World"-style relief MAZE lower world, on a ~2x-bigger island.

The maintainer's brief: keep everything we learned building `the_island` for the
UPPER part (the massif that climbs "up up up" in altitude), but add the missing
LOWER part — the section that in *Zelda: A Link to the Past* is built like a maze,
where the ground goes both UP and DOWN so navigating it is a puzzle, not a straight
climb. Both worlds on one island → the map has to be twice as big.

How the two worlds coexist under our camera-facing occlusion rule
(`maps2/README.md` — land must never step UP toward the camera with the SAME
material):

  * UPPER (the mountain) is STRICTLY ANTITONE, exactly like `the_island`: the depth
    field is closed to be non-increasing toward the camera, quantised, and backstopped
    by `camera_monotone` (here MASKED to the mountain). Occlusion-clean for free. It is
    TERRACED onto flat benches {16,20,24,28,32} with Δ4 cliffs (not a smooth ramp) and
    the peaks top out on DIFFERENT benches with a carved valley + tarn, so it climbs in
    dramatic steps and goes up AND down laterally (mostly up). Floored at 16 so its whole
    front is a sheer FOOT above the maze.

  * LOWER (the maze) uses GENUINE RELIEF — flat chambers at BIG tiers {0,4,12} that go
    up AND down (deltas mostly Δ4, sometimes Δ8/Δ12) — and is NEVER flattened by
    `camera_monotone`. A strictly-antitone field can only ever make ONE connected lowest
    sheet, so a real maze MUST use relief. It is kept occlusion-legal by the WALL-MATERIAL
    RULE: wherever two same-material floors sit across a toward-camera up-step, the higher
    rim is recoloured to a wall material (stone/obsidian) — a rock escarpment, legal by
    construction. A `mat`-only lip-cover pass mops any residual, so it can never undo
    connectivity or open a pit. A Δ>10 step is fog-exempt (grass tops survive on tier-12).

  * ASCENTS are Trollstigen SWITCHBACKS: every gated cliff (mountain benches, big maze
    steps) is climbed by a Z-road of flat dirt benches joined by up-screen risers, so the
    road only ever rises away from camera (antitone, occlusion-legal) — and being dirt it
    doubles as the ROAD network. Dirt is used ONLY for roads/ramps and a deliberate trunk
    path (the ALttP "red path"), never as generic borders.

  * The SEAM is legal by construction: the mountain is entirely up-screen of the maze,
    its foot (16) stands above the maze top (12), so a mountain cell's toward-camera
    neighbour is always a LOWER maze cell (a visible descent, never a hidden lip).

Connectivity, zero-pits, bridges and the reachability proof reuse `the_island`'s
machinery (`_connect_all`/`_fill_traps`/`_place_bridges`/`_walk_components`), with the
straight spur replaced by a switchback (falling back to the spur where a Z won't fit).
Everything is hard-asserted in `build()`: occlusion clean, 100% reachable (PROP-AWARE),
no traps, bridges connect on every row, maze ≥ 1.6× mountain, max level ≥ 30.
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
from islandworld import (Island, _dilate, _fbm, _h01, MAPS2)
from tiles2lib import DX, DY, LEVEL_PX, Tiles2

# LOWER-world named features (fx,fy in [0,1], amp signed, radius in map-fraction):
# gaussians that carve the maze's signature places into the signed relief field.
# Amps are large enough (~+-2) to reliably cross two quantile bands, so the maze has
# real tier-12 plateaus beside tier-0 hollows (dramatic Δ8/Δ12 cliffs).
FEATURES = [
    (0.62, 0.86, -2.0, 0.10),   # Sunken Hollow — a dry stone-rimmed canyon (tier 0)
    (0.30, 0.74, +2.4, 0.11),   # West Plateau — a gated tier-12 overlook (high)
    (0.76, 0.68, -2.2, 0.09),   # Mirror Lake basin (deepest -> water)
    (0.50, 0.62, +2.2, 0.13),   # central bench — a tier-12 rise splitting the routes
]

# UPPER world: the mountain is TERRACED onto these flat benches (Δ4 cliffs between)
# instead of a smooth ramp, so it climbs in dramatic steps and — with varied peak
# heights + a carved valley — reads as going up AND down (mostly up). Floor 16 sits a
# clean Δ4 above the maze cap of 12 (a gated foot). Top bench 32 keeps max level >= 30.
BENCHES = np.array([16, 20, 24, 28, 32], np.int16)

# Depth gaussians ADDED before the antitone closure to carve a broad saddle-VALLEY
# descending the massif front toward the camera (the closure legalises it into an
# antitone groove that opens at the foot — a "down" you can walk into and back out of).
MTN_VALLEYS = [(0.38, 0.12, 24, 0.055), (0.41, 0.20, 24, 0.06),
               (0.44, 0.28, 22, 0.065), (0.47, 0.37, 20, 0.07)]

# Switchback ascents: only cliffs of Δ>=SWITCH_MIN zigzag (there is no Δ2 anywhere now
# — the Δ4 benches/foot ARE the ascents we want to Trollstigen), capped at SWITCH_MAX so
# the map reads as a deliberate handful of mountain roads.
SWITCH_MIN = 4
SWITCH_MAX = 16


class Island2(Island):
    def __init__(self, n=200, seed=21):
        self.n, self.seed = n, seed
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
        self._nswitch = 0                 # carved switchbacks (capped at SWITCH_MAX)
        self.road_feet = []               # bottom-bench anchors of switchbacks (road hook)
        self.spawn = (int(n * 0.50), int(n * 0.92))

        self._coastline()                 # organic island (reused verbatim)
        self._zone_masks()                # UPPER (mountain) vs MAZE (front) on warped depth
        self._elevation_mountain()        # the_island tech, TERRACED onto benches 16..32
        self._tarn()                      # a high sunken ice tarn on the massif
        self._relief()                    # signed warped field -> big maze tiers {0,4,12} + a lake
        self._rooms()                     # snap the maze into flat chambers (crisp cliffs)
        self._majority()                  # despeckle the maze level field
        self._maze_river()                # a winding water channel across the lowland (bridged)
        flatten_shores(self.mat, self.level)
        camera_monotone_masked(self.level, self.mat, self.upper)   # mountain antitone ONLY
        self.level_before = self.level.copy()
        self._materials()                 # mountain caps + maze floors/beaches (no dirt borders)
        self._wall_rim()                  # Pass A: recolour maze up-step rims -> wall material
        self._connect_all(thresh=5)       # reuse: switchbacks/ramps + emergency spans -> one piece
        self._ford_stranded()             # reuse: causeway across any water-locked pocket
        self._place_bridges(count=5)      # reuse: stone decks over water (both-bank checked)
        for _ in range(10):               # guarantee loop -> converge to no pit AND no lip
            camera_monotone_masked(self.level, self.mat, self.upper)  # antitone mtn (may steepen)
            self._fill_traps()            # then fill any pit (incl. one monotone just made)
            self._lip_cover()             # then cover residual lips (mat-only, makes no pit)
            if self._trap_count() == 0 and not occlusion_violations(self.mat, self.level):
                break
        self._pick_spawn()
        self._dirt_roads()                # deliberate dirt ROAD network (concern 4, ALttP red path)
        self._paint()
        self.deck_at = {(x, y): dk for dk in self.decks for (x, y) in dk["cells"]}
        self._decorate()
        self._reconnect_after_props()     # props collide: never let one seal off a region

    # -- two-zone layout -------------------------------------------------------

    def _zone_masks(self):
        """Split the land front-to-back on a WARPED depth so the seam meanders:
        the back becomes the antitone mountain, the (larger) front becomes the maze."""
        n, X, Y, s = self.n, self.X, self.Y, self.seed
        d = (X + Y) / (2 * (n - 1))
        dw = d + (_fbm(X, Y, s + 70, n * 0.34, 4) - 0.5) * 0.10       # +-0.05 wobble
        self.upper = self.land & (dw < 0.40)          # mountain (antitone, terraced 16..32)
        self.maze = self.land & ~self.upper           # the ALttP relief maze (the bulk)

    # -- upper world: the_island mountain, masked + TERRACED -------------------

    def _elevation_mountain(self):
        """`Island._elevation`'s depth field (multi-peak jagged massif, antitone by
        construction) restricted to the mountain mask, but TERRACED: the continuous
        antitone height is snapped to flat benches {16..32} (Δ4 cliffs), a saddle-VALLEY
        is carved before the closure, and the peaks top out on DIFFERENT benches — so the
        massif climbs in dramatic steps and goes up AND down laterally (mostly up), while
        staying strictly antitone (a monotone bench-snap of an antitone field is antitone,
        so it is occlusion-clean for free and camera_monotone_masked stays a no-op)."""
        n, X, Y, s, up = self.n, self.X, self.Y, self.seed, self.upper
        u = (X + Y)
        arm = 0.62 * np.abs(X - Y) + (_fbm(X, Y, s + 20, n * 0.30, 3) - 0.5) * 10
        warp = ((_fbm(X, Y, s, n * 0.30, 4) - 0.5) * 22
                + (_fbm(X, Y, s + 3, n * 0.13, 3) - 0.5) * 12
                + (_fbm(X, Y, s + 8, n * 0.06, 2) - 0.5) * 4)
        uplift = _fbm(X, Y, s + 5, n * 0.42, 3) * 8
        # peaks of VARIED height so different lobes top out on different benches
        # (32/28/24) with saddles between -> crossing the ridge laterally goes up & down.
        PEAKS = [(0.28, 0.11, 40, 0.10), (0.44, 0.07, 22, 0.09), (0.58, 0.13, 46, 0.11),
                 (0.71, 0.09, 18, 0.08), (0.17, 0.26, 16, 0.09), (0.85, 0.27, 30, 0.09)]
        ridge = np.zeros_like(u)
        for fx, fy, h, sg in PEAKS:
            ridge = np.maximum(ridge, h * np.exp(-(((X - fx * n) ** 2) / (2 * (sg * n) ** 2)
                                                   + ((Y - fy * n) ** 2) / (2 * (sg * 0.85 * n) ** 2))))
        depth = u - arm + warp - uplift - ridge
        for fx, fy, amp, rad in MTN_VALLEYS:          # carve a descending saddle-valley
            depth += amp * np.exp(-(((X - fx * n) ** 2 + (Y - fy * n) ** 2) / (2 * (rad * n) ** 2)))
        depth[~up] = 1e9
        self._camera_max_float(depth, up)             # continuous antitone closure over the mask
        dl = depth[up]
        d = (depth - dl.min()) / (dl.max() - dl.min() + 1e-6)
        h = 16.0 + (1.0 - d) * (32 - 16)              # continuous antitone 16..32
        idx = np.abs(h[..., None] - BENCHES.astype(np.float32)).argmin(-1)
        lvl = BENCHES[idx]                            # TERRACE (monotone snap keeps antitone)
        self.level[up] = lvl[up]

    # -- lower world: signed relief -> flat maze chambers (big deltas) ----------

    def _relief(self):
        """A signed, domain-warped low-frequency field quantised by QUANTILE into three
        BIG tiers {0,4,12} that go up AND down across organic regions. Deltas produced are
        Δ4 (0<->4, dominant), Δ8 (4<->12) and the occasional Δ12 (0<->12, >10 => fog-exempt)
        — dramatic ALttP cliffs, no timid Δ2 anywhere. Deepest ~11% -> a lake. A gentle
        climb toward the mountain keeps the back of the maze high (the run-up to the foot)."""
        n, X, Y, s, mz = self.n, self.X, self.Y, self.seed, self.maze
        wx = X + n * 0.13 * (_fbm(X, Y, s + 30, n * 0.28, 4) - 0.5) * 2
        wy = Y + n * 0.13 * (_fbm(X, Y, s + 31, n * 0.28, 4) - 0.5) * 2
        R = (_fbm(wx, wy, s + 32, n * 0.20, 4) - 0.5) * 2.0           # broad plateaus/hollows
        R += (_fbm(wx, wy, s + 33, n * 0.09, 3) - 0.5) * 1.1         # medium terraces (up&down)
        d = (X + Y) / (2 * (n - 1))
        R += 0.45 * (1.0 - d)                                         # mild climb toward the foot
        for fx, fy, amp, rad in FEATURES:
            R += amp * np.exp(-(((X - fx * n) ** 2 + (Y - fy * n) ** 2) / (2 * (rad * n) ** 2)))
        Rm = np.where(mz, R, np.nan)
        qs = np.nanquantile(Rm, [0.45, 0.85])                        # 2 cuts -> 3 tiers
        tier = np.array([0, 4, 12], np.int16)
        idx = np.digitize(R, qs)                                     # 0..2
        self.level[mz] = tier[idx][mz]
        lake = mz & (R < np.nanquantile(Rm, 0.11))                   # deepest -> water
        self.mat[lake] = "clear_water"
        self.level[lake] = 0

    def _rooms(self, RS=20):
        """Snap the maze into FLAT chambers on a warped lattice (each cell's room id =
        floored warped coords). Flattening every room to the MODE of its relief tier
        turns the smooth field into crisp flat rooms separated by clean Δ>=4 cliffs —
        the ALttP look, and (being crisp, not speckled) exactly what makes lip-cover a
        thin coherent set. Lake-only rooms stay water."""
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
                continue                                             # all-water room (lake)
            mode = Counter(lvls).most_common(1)[0][0]
            for (x, y) in cl:
                self.room[y, x] = r
                if self.mat[y, x] != "clear_water":
                    self.level[y, x] = mode

    def _maze_river(self):
        """Carve a winding water channel across the maze lowland — the ALttP "cross the
        bridge" barrier. Water is always occlusion-legal (a different material at level 0)
        and always crossable: `_place_bridges` lays stone decks where both banks match,
        and `_connect_all`/`_ford_stranded` guarantee the two sides still join. Kept in the
        LOW front lands (levels stay similar across it) so bridges reliably seat."""
        n, s = self.n, self.seed
        # mostly VERTICAL (toward-camera) so its channel aligns across consecutive rows
        # — that row-alignment is exactly what lets `_place_bridges` seat stone decks.
        PATH = [(0.44, 0.42), (0.47, 0.55), (0.45, 0.68), (0.48, 0.80), (0.46, 0.95)]
        pts = [(fx * n, fy * n) for fx, fy in PATH]
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
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
        """3x3 mode filter over maze LAND levels — despeckle 1-cell level islands so no
        isolated rim exists (coherent stone bands, faster lip-cover). Never touches water
        (lakes stay) or the mountain."""
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
        """Wall material for a recoloured rim. With maze tiers {0,4,12}, the only rim
        tiers are 4 and 12, so a static split at level 8 (4->stone, 12->obsidian) keeps a
        4-under-12 step (the one possible rim-over-rim) different-material. Used by Pass A
        (pre-connect, before ramps introduce intermediate levels); Pass B is neighbour-aware."""
        return "stone_mountain" if int(self.level[y, x]) < 8 else "black_mountain"

    def _wall_rim(self):
        """Pass A (vectorised, pre-connect): a toward-camera rise is a hidden lip ONLY if
        same-material AND the drop is <=10 (a >10 drop is fog-exempt). So recolour the
        HIGHER rim of every same-material up-step of 1..10 in the maze to a wall material;
        Δ12 (0->12) plateaus keep their grass tops (fog covers them) — grass tops + rock
        faces, exactly the look the maintainer wants. Bulk of the work; lip-cover mops residuals."""
        n, mat, level = self.n, self.mat, self.level
        land = (mat != "") & (mat != "clear_water")
        lv = level.astype(np.int32)
        same_hi = np.zeros((n, n), bool)                             # cell is the higher, same-mat rim
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
        """Pass B (backstop, to fixpoint): recolour the HIGHER cell of every residual
        same-material toward-camera lip to a wall material chosen to DIFFER from the LOWER
        cell — `mat`-only, so it never changes a level and can never undo connectivity or
        open a pit. Covers the maze rims AND the rare dirt-over-dirt clash where two carved
        ascents abut (that higher cell becomes a small rocky step in the trail). The
        mountain is antitone so it has no lips to touch. Processing camera -> up-screen
        finalises each lower rim before the rim above reads it, so a stacked cliff
        alternates stone/obsidian and settles in <=2 sweeps."""
        for _ in range(max_iter):
            viol = occlusion_violations(self.mat, self.level)
            if not viol:
                return True
            for ((lx, ly), (hx, hy), _dh) in sorted(viol, key=lambda v: v[1][0] + v[1][1]):
                lo = self.mat[ly, lx]
                self.mat[hy, hx] = "black_mountain" if lo == "stone_mountain" else "stone_mountain"
        return not occlusion_violations(self.mat, self.level)

    # -- Trollstigen switchback ascents (dirt roads up the cliffs) -------------

    def _carve_switchback(self, hx, hy, lx, ly, leg=6, min_climb=SWITCH_MIN):
        """A Z-road up a cliff. hi=(hx,hy) is the TOP (up-screen, level H); lo=(lx,ly) its
        toward-camera neighbour on the low tier (level L). The road is a stack of flat DIRT
        benches, one every `rise` levels, alternating lateral direction, joined by short
        risers at each bench's UP-SCREEN hairpin end — so every higher bench sits up-screen
        of every lower one and each road step is Δ0 (flat) or a DESCENT toward camera
        (antitone by construction => occlusion-legal), while the uncarved native cliff
        between legs walls them off so the hairpins are the only way up: a genuine
        Trollstigen zigzag. All-or-nothing plan+validate; if it doesn't fit the caller
        falls back to the straight spur, preserving the connectivity guarantee. Dirt is
        cross-material so it's legal at any height; carved cells leave self.upper so the
        guarantee loop can't re-flatten them."""
        n = self.n
        H, L = int(self.level[hy, hx]), int(self.level[ly, lx])
        if H - L < min_climb:
            return False
        dx, dy = lx - hx, ly - hy
        if (dx, dy) not in ((1, 0), (0, 1)):          # lo must be toward-camera of hi
            return False
        px, py = dy, dx                                # lateral (perpendicular) axis
        rise = max(1, (H - L) // 5)                    # 1 level/cell up short cliffs, more up tall
        gap = rise + 1                                 # rows between benches (>=1 native wall row)
        levels = list(range(L, H, rise)) + [H]         # bench levels bottom..top (incl H)
        B = len(levels)
        for sgn in (1, -1):                            # try both lateral directions
            cells = []                                 # (x, y, level)
            for k, lvl in enumerate(levels):
                up = gap * (B - 1 - k)                  # cells toward-camera from hi (0=top bench)
                bx, by = hx + dx * up, hy + dy * up
                rng = range(0, leg + 1) if k % 2 == 0 else range(leg, -1, -1)
                end = (bx, by)
                for t in rng:
                    end = (bx + sgn * px * t, by + sgn * py * t)
                    cells.append((end[0], end[1], lvl))
                if k < B - 1:                          # riser: climb toward hi (up-screen) at hairpin
                    for g in range(1, gap):
                        cells.append((end[0] - dx * g, end[1] - dy * g, lvl + g))
            if all(0 <= x < n and 0 <= y < n and self.land[y, x]
                   and self.mat[y, x] != "clear_water" and (x, y) not in self.reserved
                   for (x, y, _l) in cells):
                for (x, y, lvl) in cells:
                    self.level[y, x] = lvl
                    self.mat[y, x] = "lightdark_dirt"
                    self.upper[y, x] = False           # maze/wall-rule governed, not mtn-antitone
                    self.reserved.add((x, y))
                self.road_feet.append((lx, ly))
                self._nswitch += 1
                return True
        return False

    def _merge_ramp(self, main, cands):
        """Override: prefer a Trollstigen switchback for real cliffs (Δ>=SWITCH_MIN, under
        the SWITCH_MAX cap), else fall back to the proven straight descending spur — so
        _connect_all's one-walkable-piece guarantee (and every hard assert) is untouched."""
        for cand in cands:
            for (cx, cy) in cand:
                for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    mx, my = cx + i, cy + j
                    if (mx, my) in main and abs(int(self.level[cy, cx]) - int(self.level[my, mx])) > 1:
                        if int(self.level[cy, cx]) < int(self.level[my, mx]):
                            hi, lo = (mx, my), (cx, cy)
                        else:
                            hi, lo = (cx, cy), (mx, my)
                        drop = abs(int(self.level[hi[1], hi[0]]) - int(self.level[lo[1], lo[0]]))
                        if (drop >= SWITCH_MIN and self._nswitch < SWITCH_MAX
                                and self._carve_switchback(*hi, *lo)):
                            return True
                        if self._carve_connector(*hi, *lo):
                            return True
        return False

    def _carve_connector(self, hx, hy, lx, ly, w=3):
        """Override of Island._carve_connector: identical straight descending dirt spur,
        but also clears self.upper on every carved cell — required now the mountain is
        terraced, so a fallback spur seated on the massif isn't re-raised (and the bench
        re-disconnected) by camera_monotone_masked in the guarantee loop. Dirt is cross-
        material and the spur is antitone, so unmasking is occlusion-safe."""
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
        """Override of Island._materials with the two GENERIC-DIRT sources removed, so
        lightdark_dirt survives ONLY as functional roads/ramps (concern 4): (a) the
        dry-meadow dirt speckle line is dropped; (b) the obsidian blob's dirt collar is
        replaced by eroding black OFF the grass boundary, so its natural collar is the
        surrounding STONE (a legal seam) rather than a dirt ring. Every other band
        (stone/snow/ice caps, varied beaches) is identical to the base."""
        n, X, Y, s = self.n, self.X, self.Y, self.seed
        mat, level = self.mat, self.level
        g = mat == "saturated_grass"
        mat[g & (level >= 14)] = "stone_mountain"
        # snow only near the PEAKS (benches 28,32) so the massif reads as ROCK with snowy
        # caps, not a white sheet; ice/obsidian cap only the very top.
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
        # (dry-meadow dirt speckle DELETED — dirt is roads, not borders)
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

    # -- dirt ROAD network (concern 4: the ALttP red path, not generic borders) ---

    def _water_adjacent(self):
        w = (self.mat == "clear_water")
        return _dilate(w, 1) & (self.mat != "clear_water") & (self.mat != "")

    def _road_graph_bfs(self, start, dirt_bonus=0.5, water_pen=3.0):
        """Dijkstra over the EXACT walkable graph (4-neighbour |Δlevel|<=1 + bridge links),
        cheaper on cells already dirt (so the trunk FUSES onto the switchbacks/ramps into
        one continuous route) and dearer next to water (keeps the road off the shoreline;
        bridges are the crossings). Returns dist{}, parent{}."""
        n, mat, level = self.n, self.mat, self.level
        land = lambda x, y: mat[y, x] != "" and mat[y, x] != "clear_water"
        ladj = self._link_adj()
        wadj = self._water_adjacent()
        sx, sy = start
        dist, parent = {}, {}
        if not land(sx, sy):
            return dist, parent
        dist[(sx, sy)] = 0.0
        pq = [(0.0, sx, sy)]
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

    def _dirt_roads(self):
        """Paint ONE deliberate dirt trunk (the ALttP red path): spawn -> maze landmarks ->
        the summit, as a single chain of shortest walkable paths. Because the summit is on
        the massif and the only |Δlevel|<=1 way up is the dirt switchbacks, the route is
        forced onto them; everywhere else stays grass tops + stone/obsidian faces. Widen
        only onto SAME-LEVEL (Δ0) grass/sand neighbours (a comfortable ~2-3 cell path on
        flats, 1-wide on the switchbacks) — Δ0 => never a cliff crossing, never a new lip.
        Material-only, never changes level; reserved so no prop lands on the route; a
        trailing mat-only _lip_cover is a safety net. Roads may run any direction — the
        auto-tiler's transitions make the dirt<->grass seam read as a worn path at any angle."""
        n, mat, level = self.n, self.mat, self.level
        dist0, _ = self._road_graph_bfs(self.spawn)
        reach = set(dist0)
        if not reach:
            return

        def near(fx, fy):
            tx, ty = fx * n, fy * n
            return min(reach, key=lambda c: (c[0] - tx) ** 2 + (c[1] - ty) ** 2, default=None)

        wps = [w for w in (near(0.50, 0.62), near(0.30, 0.74)) if w]
        up = [c for c in reach if self.upper[c[1], c[0]]]
        if up:
            wps.append(max(up, key=lambda c: int(level[c[1], c[0]])))     # summit -> forces switchbacks
        wps = sorted(dict.fromkeys(wps), key=lambda c: dist0[c])          # outward chain (a snake)
        road, cur = set(), self.spawn
        for w in wps:
            seg = self._road_path(cur, w)
            if seg:
                road.update(seg)
                cur = w
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
        self._lip_cover()                                                # mat-only safety net

    def _trap_count(self):
        """Walkable cells cut off from the main component yet land-adjacent to it — a
        pit the player can fall into and be stranded. Zero is asserted every build."""
        comps = self._walk_components()
        if len(comps) <= 1:
            return 0
        mainset = set(comps[0])
        return sum(len(c) for c in comps[1:]
                   if any((x + i, y + j) in mainset for (x, y) in c
                          for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1))))

    # -- prop-aware reachability (props collide in worldio) --------------------

    def _reach_blocked(self, blocked):
        """BFS reachability from spawn over |Δlevel|<=1 + bridge links, treating every
        cell in `blocked` (prop cells — they set collision=1) as a wall."""
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
        """A prop cell blocks movement (collision=1). If decoration ever drops props on
        the sole chokepoint into a region, walking there becomes impossible even though
        the terrain connects. A prop cell being unreachable is fine (you can't stand on a
        tree); a NON-prop terrain cell being sealed off is not. So while any terrain cell
        the player should reach is cut off ONLY by props, BFS from the reachable set
        THROUGH props to the nearest such cell and delete the (minimal) prop chain on that
        path — reopening it. The water-locked islet stays unreachable by design."""
        n = self.n
        terrain = self._reach_blocked(set())                         # terrain-only target
        walk = (self.mat != "") & (self.mat != "clear_water")
        ladj = self._link_adj()
        for _ in range(max_iter):
            props = set(self.props)
            seen = self._reach_blocked(props)
            propmask = np.zeros((n, n), bool)
            for (x, y) in props:
                propmask[y, x] = True
            cut = terrain & ~seen & ~propmask                        # real sealed cells
            if not cut.any():
                return
            # multi-source BFS from the reachable set, allowed to pass through props,
            # to the nearest genuinely-sealed cell; step must stay walkable (|Δlevel|<=1)
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


def build(out=None, n=200, seed=21):
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

    # --- assert battery (mirrors the_island, plus the two-world invariants) ---
    terr = Counter(m for m in d.mat.ravel() if m)
    viol = occlusion_violations(d.mat, d.level)
    assert not viol, f"camera-facing rule broken: {viol[:5]}"

    upper_land = int((d.upper & (d.mat != "clear_water")).sum())
    maze_land = int((d.maze & (d.mat != "clear_water")).sum())
    assert maze_land >= 1.6 * upper_land, \
        f"maze not dominant: maze {maze_land} < 1.6 * upper {upper_land}"

    assert int(d.level.max()) >= 30, f"mountain too short: max level {int(d.level.max())}"

    walk = (d.mat != "") & (d.mat != "clear_water")
    land_cells = int(walk.sum())
    propmask = np.zeros((d.n, d.n), bool)
    for (x, y) in d.props:
        propmask[y, x] = True
    terrain_seen = d._reach_blocked(set())                           # terrain-only
    prop_seen = d._reach_blocked(set(d.props))                       # props are walls
    # every terrain cell the player should reach (not a prop footprint, not the islet)
    sealed = int((terrain_seen & ~propmask & ~prop_seen).sum())
    assert sealed == 0, f"props seal off {sealed} walkable cell(s)"
    reach = int(prop_seen.sum())
    unreachable = land_cells - int(terrain_seen.sum())               # water-locked islet only

    comps = d._walk_components()
    mainset = set(comps[0])
    traps = sum(len(c) for c in comps[1:]
                if any((x + i, y + j) in mainset for (x, y) in c
                       for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1))))
    assert traps == 0, f"pit trap: {traps} walkable cells cut off yet land-adjacent to main"
    # nothing but the small water-locked islet may sit outside the main walkable piece
    # (guards against a river/lake silently stranding a whole maze half)
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
          f"switchbacks {d._nswitch}; road {len(d.roads)}")
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
