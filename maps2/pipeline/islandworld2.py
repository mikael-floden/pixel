"""the_island2 ("The Island 2") — the_island's mountain UPPER world + an ALttP
"Light-World"-style relief MAZE lower world, on a ~2x-bigger island, wrapped in ocean.

Two worlds under the camera-facing occlusion rule (`maps2/README.md` — land must never
step UP toward the camera with the SAME material):

  * UPPER (the mountain) is strictly ANTITONE, TERRACED onto flat Δ4 benches {16..40}. A
    sharp multi-peak ridge (distinct summits topping out on 32/36/40 with deep saddles) +
    camera-fanning grooves + an internal water valley make it JAGGED and undulating (down-
    then-up), not a smooth pyramid. camera_monotone masked to it -> occlusion-clean.
  * LOWER (the maze) uses genuine RELIEF at BIG tiers {0,4,12} (deltas Δ4/Δ8/Δ12), legal by
    the wall-material rule, applied ONLY WHERE NEEDED (_lip_needed gates _lip_cover: a lip is
    left alone when a nearby visible cliff or a different ground visible behind the seam
    already makes the elevation change legible — maintainer 2026-07-22).
  * The massif is climbed by TROLLSTIGEN switchbacks (maintainer 2026-07-22, his design):
    wall-hugging stacked legs on the SKEW lattice p=x+y/q=x-y down the sheer toe — at every
    turn the slope MIRRORS one band further out (top of the new leg flush with the bottom of
    the old, drawn in front of it), so the previous leg is the next leg's inner wall and the
    only fall direction is OUTWARDS (hug invariant, build-asserted; hairpin pads "two cars
    can meet"; the primary sits at the maintainer's TROLL_SITE_FRAC window and carries the
    trunk dirt ROAD). Above the toe, short bench-hop ramps keep the LOCAL ground type (snow
    stairs on snow; steps face the camera). _carve_connector never slices a Trollstigen.
  * ROADS (_dirt_roads) are an organic MEANDERING, BRANCHING dirt network that can run in all
    8 SCREEN directions (grid-diagonal steps + same-level elbow fill), held a margin off the
    beach/water and the mountain foot and biased to corridor centres.
  * WATER at MULTIPLE levels: ocean + flush inland ponds/tarns (maze tiers 4/12, benches
    20/24) + an internal mountain gorge, all transactional so they never seal a region.
  * The island is INSET into a wide OCEAN frame (M-cell margin on every side).

Everything hard-asserted in build(): occlusion clean, prop-aware reachable, no traps, main
piece >= 97% land, bridges connect, maze >= 1.6x mountain, max level >= 36, no land on the
map border. NOTE: a finite frame can only push the edge out of view; truly never showing an
"end of world" also needs the game client to fill out-of-bounds with ocean (see README).
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

def _dilate8(mask, r):
    """Chebyshev (8-neighbour, square-kernel) dilation — the metric of tile neighbourhoods.
    The cross-kernel _dilate gives Manhattan balls; transition legality needs Chebyshev:
    two materials at Manhattan 3 can still be diagonal neighbours of the SAME tile."""
    m = mask.copy()
    for _ in range(r):
        nn = m.copy()
        nn[:, :-1] |= m[:, 1:]; nn[:, 1:] |= m[:, :-1]
        nn[:-1, :] |= m[1:, :]; nn[1:, :] |= m[:-1, :]
        nn[:-1, :-1] |= m[1:, 1:]; nn[1:, 1:] |= m[:-1, :-1]
        nn[:-1, 1:] |= m[1:, :-1]; nn[1:, :-1] |= m[:-1, 1:]
        m = nn
    return m


# LOWER-world named features (fx,fy in [0,1], amp signed, radius in map-fraction).
FEATURES = [
    (0.62, 0.86, -2.0, 0.10),   # Sunken Hollow — a dry stone-rimmed canyon (tier 0)
    (0.30, 0.74, +2.4, 0.11),   # West Plateau — a gated tier-12 overlook (high)
    (0.76, 0.68, -2.2, 0.09),   # Mirror Lake basin (deepest -> water)
    (0.50, 0.62, +2.2, 0.13),   # central bench — a tier-12 rise splitting the routes
]

# UPPER benches (uniform Δ4 so the fixed switchback carver can climb the whole height).
BENCHES = np.array([16, 20, 24, 28, 32, 36, 40], np.int16)
BENCH_HI = 40
# Stairs/ramps KEEP the ground type already present where they are carved (no forced rock);
# bridge DECKS stay stone. Flat ROADS are dirt.

# Sharper massif: ~10 narrow gaussians of widely varied height -> distinct spiky summits
# (topping 32/36/40) with deep saddles, taken as a max-envelope.
PEAKS = [(0.24, 0.09, 52, 0.065), (0.33, 0.13, 30, 0.055), (0.42, 0.06, 46, 0.055),
         (0.50, 0.12, 22, 0.050), (0.58, 0.08, 50, 0.065), (0.66, 0.14, 34, 0.055),
         (0.73, 0.07, 18, 0.050), (0.82, 0.12, 44, 0.060), (0.16, 0.24, 26, 0.060),
         (0.88, 0.26, 30, 0.058)]

# Deep camera-fanning grooves (fy strictly increasing per chain) that survive the antitone
# closure as open notches -> dry valleys between the peak clusters.
MTN_VALLEYS = [(0.37, 0.14, 26, 0.050), (0.39, 0.22, 26, 0.055), (0.41, 0.30, 24, 0.060),
               (0.43, 0.38, 22, 0.070), (0.62, 0.16, 24, 0.050), (0.63, 0.24, 24, 0.055),
               (0.64, 0.32, 22, 0.060), (0.65, 0.40, 20, 0.070)]

# Mountain ascents: a few TIDY corridors climb the terraced benches by short rock ramps
# cut into each cliff at alternating ends (the benches are the long legs).
SWITCH_MIN = 4
STAIR_CORRIDORS = 2
STAIR_SPACING = 0.16
# TROLLSTIGEN toe descent (maintainer 2026-07-22): wall-hugging stacked legs down the
# sheer mountain toe, built on the SKEW lattice p=x+y / q=x-y (a screen-horizontal wall
# is a grid-diagonal line). Each leg descends TROLL_DROP levels along the wall, then the
# slope MIRRORS one band further out (toward the camera) — top of the new leg flush with
# the bottom of the old — so the previous leg IS the next leg's inner wall and the only
# fall direction is outwards. Leg width tries TROLL_WLEG (p-layers per leg); windows of
# TROLL_QMIN..TROLL_QMAX q-units are searched along the rim contour; each leg's last
# TROLL_PADQ q-units run flat (the hairpin pad).
TROLL_DROP = 4
TROLL_WLEG = (3, 2)
TROLL_QMAX, TROLL_QMIN = 44, 14
TROLL_QMIN_MINI = 7
TROLL_PADQ = 4
# The maintainer's chosen window for the PRIMARY Trollstigen (blue marks, 2026-07-22
# screenshots): the bench-20/24 south face x~63-89 west of the toe lake. Island fracs,
# same convention as GORGE_BRIDGE_FRACS; the nearest foot candidate within
# TROLL_SITE_R cells gets the first corridor ("try the location before coming up with
# a new better location" — the maintainer). Other corridors pick freely by drop.
TROLL_SITE_FRAC = (0.27, 0.50)
TROLL_SITE_R = 20

# Road cost tunables (all FINITE so a route always exists -> summit never disconnected).
ROAD_BEACH_MARGIN = 3
ROAD_FOOT_MARGIN = 2
BEACH_PEN = 2.5
FOOT_PEN = 1.5
CENTER_AMP = 0.35
ASCENT_BONUS = 0.5
DIRT_BONUS = 0.5
WANDER_AMP = 0.9
ROAD_MAGNET = 1.2          # pull a new spur onto the existing road -> tight Y-merges
ROAD_ATTRACT_R = 2

# Walkable GROUND types under the no-sliver rule (a tile borders at most ONE foreign ground;
# water/void exempt). Order = deterministic tie-break for the absorb repair.
GROUND_MATS = ("saturated_grass", "light_sand", "lightdark_dirt", "stone_mountain",
               "black_mountain", "regular_snow", "crystal_ice")
# Materials a legibility STRIPE may use (never sand — beaches only — and never water).
STRIPE_MATS = ("saturated_grass", "lightdark_dirt", "stone_mountain",
               "black_mountain", "regular_snow", "crystal_ice")

# Sunken walk-in lagoon (water 2 levels down, walkable Δ1 shore) — on the MOUNTAIN snow.
LAGOON_SITES = [(0.36, 0.17), (0.44, 0.14), (0.30, 0.22), (0.52, 0.16), (0.24, 0.30)]
LAGOON_RW = 2

# Deliberate BRIDGE SITES (maintainer 2026-07-22, red/blue overview marks), as design-fraction
# fy targets like PATH/LAGOON_SITES. Gorge/waterway crossings: the very top of the massif gap,
# a HIGH bench-24 span mid-massif, the foot crossing where the channel exits into the maze, and
# one mid-channel. Maze-river crossings: the maintainer kept 5 of the original 8.
GORGE_BRIDGE_FRACS = (0.10, 0.235, 0.4175, 0.515)
RIVER_BRIDGE_FRACS = (0.47, 0.53, 0.595, 0.7275, 0.7925)


class Island2(Island):
    def __init__(self, seed=21, M=24):
        self.M = M                        # ocean-margin ring
        self.nd = 200                     # island design size (kept constant)
        self.n = self.nd + 2 * self.M     # full grid (island inset in the ocean frame)
        assert self.nd == 200, "nd must stay 200 so every level/ratio/max-level is identical"
        n = self.n
        self.seed = seed
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
        self._linework = set()           # painted line features (stripes/roads): sliver-exempt
        self._gorge_cells = set()
        self._road_now = None
        self._road_attract = None
        self._ascent = set()              # rock stair/ramp cells (road cost prefers them)
        self._troll = set()               # Trollstigen cells (hug-invariant assert)
        self._troll_raw = {}              # (x,y) -> level as carved (mutation detector)
        self._troll_pads = set()          # hairpin noses: lateral exposure allowed there
        self._troll_ends = []             # (foot, entry) per structure: trunk road via-points
        self._troll_floor = {}            # (x,y) -> its structure's floor (assert exemption)
        self._troll_top = {}              # (x,y) -> its structure's TOPL (assert exemption)
        self._troll_fallbacks = 0         # bench climbs that had to use a straight connector
        self._troll_mini_fail = Counter() # why mini carves bailed (diagnostics)
        self._troll_road = set()          # the PRIMARY structure's BAND cells: the ONLY
                                          # paintable ascent (the secondary stays a grass
                                          # trail; the wall-fill stays grass shoulder)
        self._troll_band = {}             # (x,y) -> (leg, q) for the ribbon completion
        self._nswitch = 0
        self._stairs_done = False
        self.road_feet = []
        self.spawn = self._to_grid(0.50, 0.90)

        self._coastline()                 # organic island INSET into a wide water frame
        self._zone_masks()                # UPPER (mountain) vs MAZE (front)
        self._elevation_mountain()        # spiky TERRACED massif, benches 16..40 (antitone)
        self._tarn()                      # a FLUSH alpine ice tarn
        self._relief()                    # big maze tiers {0,4,12} + a lake
        self._rooms()                     # snap the maze into flat chambers
        self._majority()                  # despeckle the maze level field
        flatten_shores(self.mat, self.level)
        self._maze_river()                # raised-valley river (AFTER shores so banks stay tier 4)
        camera_monotone_masked(self.level, self.mat, self.upper)   # mountain antitone ONLY
        self._mtn_gorge()                 # DEEP gorge down the massif (banks keep full height)
        self._bridge_over_gorge(self._gorge_cells)   # maintainer's waterway crossings (early:
        self.level_before = self.level.copy()        # links exist before _connect_all runs)
        self._materials()                 # mountain caps + BIGGER beaches
        self._mountain_stairs()           # a few TIDY full-height ROCK ascents; rest sheer cliff
        self._connect_all(thresh=5)       # reuse: rock connectors + span the gorge -> one piece
        self._ford_stranded()
        self._place_bridges()             # maze-river crossings at the maintainer's 5 sites
        self._beach_access()              # no dead-end shores: slope tongues up from stranded beaches
        for _ in range(10):               # guarantee loop -> converge to no pit AND no lip
            camera_monotone_masked(self.level, self.mat, self.upper)
            self._fill_traps()
            self._lip_cover()
            if self._trap_count() == 0 and not self._bad_lips():
                break
        self._ponds()                     # flush multi-level lakes (before spawn -> post-pond main)
        self._sunken_lagoon()             # a walk-in lagoon sunk 2 levels (transactional)
        self._pick_spawn()
        self._dirt_roads()                # 8-direction meandering, margined, centred dirt roads
        self._fix_material_slivers()      # NEW RULE: no tile borders two different foreign grounds
        self._resolve_deck_mats()         # bridges wear their banks' FINAL ground (maintainer)
        self._paint()
        self.deck_at = {(x, y): dk for dk in self.decks for (x, y) in dk["cells"]}
        self._decorate()
        self._reconnect_after_props()

    # -- inset coordinate transform --------------------------------------------

    def _to_grid(self, fx, fy):
        """Fraction (of the island design) -> grid cell, offset into the water frame."""
        return int(fx * self.nd + self.M), int(fy * self.nd + self.M)

    # -- organic coastline, INSET into a water frame ---------------------------

    def _coastline(self):
        """Override: identical coastline math on a remapped grid so the island sits inside an
        M-cell ocean margin. nd==200 + the M-invariant moat term keep the island bit-for-bit
        the same for any margin; a hard border-clear guarantees the ocean ring."""
        n, M, nd = self.n, self.M, self.nd
        Yg, Xg = np.mgrid[0:n, 0:n].astype(np.float32)
        self.X = (Xg - M) * (n / nd)
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
        # M-invariant moat: a fixed 5-cell penetration past the design border (algebraically
        # identical to the old 3.0*clip((1.5*M-edge)/(1.5*M))**2 at M=10) so the island shape
        # is independent of the margin size.
        edge = np.minimum(np.minimum(Xg, n - 1 - Xg), np.minimum(Yg, n - 1 - Yg))
        coast -= 3.0 * np.clip((5.0 - (edge - M)) / 15.0, 0, 1) ** 2
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
        n, X, Y, s = self.n, self.X, self.Y, self.seed
        d = (X + Y) / (2 * (n - 1))
        dw = d + (_fbm(X, Y, s + 70, n * 0.34, 4) - 0.5) * 0.10
        self.upper = self.land & (dw < 0.40)
        self.maze = self.land & ~self.upper

    # -- upper world: spiky TERRACED massif ------------------------------------

    def _elevation_mountain(self):
        """Antitone depth field on the mountain mask, snapped to flat Δ4 benches {16..40}. A
        sharp multi-peak ridge (distinct summits, deep saddles) + camera-fanning grooves make
        the skyline JAGGED and give dry valleys; the alpine tarn + gorge give real water
        'downs'. A monotone bench-snap of an antitone field is antitone for any Δ4 spacing, so
        it stays occlusion-clean regardless of the {16..40} set. Max level rises to 40."""
        n, X, Y, s, up = self.n, self.X, self.Y, self.seed, self.upper
        u = (X + Y)
        arm = 0.62 * np.abs(X - Y) + (_fbm(X, Y, s + 20, n * 0.30, 3) - 0.5) * 10
        warp = ((_fbm(X, Y, s, n * 0.30, 4) - 0.5) * 22
                + (_fbm(X, Y, s + 3, n * 0.13, 3) - 0.5) * 12
                + (_fbm(X, Y, s + 8, n * 0.06, 2) - 0.5) * 4)
        uplift = _fbm(X, Y, s + 5, n * 0.42, 3) * 8
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
        h = 16.0 + (1.0 - d) * (BENCH_HI - 16)
        idx = np.abs(h[..., None] - BENCHES.astype(np.float32)).argmin(-1)
        lvl = BENCHES[idx]
        self.level[up] = lvl[up]

    def _tarn(self):
        """FLUSH alpine ice tarn (base sinks to level 0; instead flush to the rim's modal
        bench level -> a filled pool on the massif shoulder, water at a non-zero level)."""
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
        """A winding river across the maze that runs in a RAISED VALLEY: its shoulders are lifted
        to tier 4 while the water is cut to level 0, so the river sits in a Δ4 trench and the stone
        bridges laid across it (_place_bridges, deck at the shared bank level) stand a full bench
        ABOVE the water and meet tier-4 GROUND on both banks (IMG4: raised bridges that connect to
        grounds, not flat slabs flush on the water). Wall-material rims + _connect_all keep it
        occlusion-legal and reachable. Carved AFTER flatten_shores so the banks are not beached."""
        n, s = self.n, self.seed
        PATH = [self._to_grid(fx, fy) for fx, fy in
                ((0.44, 0.42), (0.47, 0.55), (0.45, 0.68), (0.48, 0.80), (0.46, 0.95))]
        center = []
        for (ax, ay), (bx, by) in zip(PATH, PATH[1:]):
            steps = int(math.hypot(bx - ax, by - ay)) + 1
            for i in range(steps + 1):
                t = i / steps
                wob = (_fbm(np.float32(ax + (bx - ax) * t), np.float32(ay),
                            s + 77, n * 0.06, 3) - 0.5) * 6
                center.append((int(ax + (bx - ax) * t + wob), int(ay + (by - ay) * t)))
        RV = 3                                            # valley half-width (raised shoulders)
        for (cx, cy) in center:                           # 1) lift the shoulders to >= tier 4
            for dx in range(-RV, RV + 1):
                for dy in range(-RV, RV + 1):
                    x, y = cx + dx, cy + dy
                    if (0 <= x < n and 0 <= y < n and self.maze[y, x] and self.land[y, x]
                            and self.mat[y, x] != "clear_water" and int(self.level[y, x]) < 4):
                        self.level[y, x] = 4
        for (cx, cy) in center:                           # 2) cut the water channel to level 0
            for dx in range(-1, 2):
                for dy in range(-1, 2):
                    x, y = cx + dx, cy + dy
                    if 0 <= x < n and 0 <= y < n and self.maze[y, x] and self.land[y, x]:
                        self.mat[y, x] = "clear_water"
                        self.level[y, x] = 0

    def _majority(self, passes=2):
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

    # -- occlusion legality for the maze ---------------------------------------

    def _lip_needed(self, lx, ly, hx, hy, dh=None):
        """Is the wall-material trick actually NEEDED for this same-material toward-camera lip?
        Maintainer rule (2026-07-22): the recolour is a LAST RESORT — it looks ugly — used only
        when the elevation change would otherwise be illegible. It is NOT needed when:
          (a) THIS SAME EDGE draws a cliff face within 2 cells ALONG the boundary: walking the
              lip's own contour laterally, a boundary cell whose toward-camera neighbour drops
              >=2 levels shows a visible wall that pins down exactly where this edge runs (the
              zigzag-corner case). A cliff that is merely NEARBY — a staircase beside the seam,
              some other boundary — does NOT count: it says "there is elevation around here",
              not where THIS edge is (the grass-on-grass seam report: a radius test accepted
              the adjacent stairs and left a long invisible seam unpainted); or
          (b) the ground the player SEES just behind the seam differs from the high cell's top.
              For a tall step that visible ground is several ROWS up-screen (15px/row vs 16px/
              level), NOT the grid-adjacent tile — a rock band / dirt road / water back there
              already makes the edge read."""
        n = self.n
        Lh = int(self.level[hy, hx])
        hm = self.mat[hy, hx]
        i, j = hx - lx, hy - ly                          # this lip's toward-camera step
        # (0) SHORE CONTEXT (maintainer: no stone at the beach — "that space should have stayed
        # grass"): within 2 cells of sand or open water the coastline itself marks the drop, so
        # the lip is legible and the rim stays natural grass.
        for yy in range(max(0, hy - 2), min(n, hy + 3)):
            for xx in range(max(0, hx - 2), min(n, hx + 3)):
                if self.mat[yy, xx] in ("light_sand", "clear_water"):
                    return False
        # (0b) a DIRT ROAD hugging this edge is itself a contrasting line that marks it
        # (and striping beside the road is what turned the summit into a dirt mountain):
        for (cx, cy) in ((hx, hy), (lx, ly)):
            for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ax, ay = cx + di, cy + dj
                if 0 <= ax < n and 0 <= ay < n and self.mat[ay, ax] == "lightdark_dirt":
                    return False
        # (a) walk this lip's OWN boundary laterally (both ways, up to 2 cells). Legible only
        # if some cell TOUCHING the walked boundary (its 8-neighbourhood — includes the corner
        # turn and the stacked lower walls right below a corner) shows a drawn >=2-level
        # toward-camera face whose material CONTRASTS with the seam's ground: a face renders in
        # its cell's own material, so a grass face marking a grass seam is itself camouflage
        # and reveals nothing (the maintainer's grass-on-grass seam — its corner face was
        # grass too). A contrasting wall at the corner (feedback #1's grey cliffs) counts.
        for p, q in ((j, i), (-j, -i)):
            cx, cy = hx, hy
            for _t in range(3):                          # t=0 is H itself, then 2 lateral steps
                for ni in (-1, 0, 1):
                    for nj in (-1, 0, 1):
                        dx2, dy2 = cx + ni, cy + nj
                        if not (0 <= dx2 < n and 0 <= dy2 < n):
                            continue
                        dm = self.mat[dy2, dx2]
                        if dm in ("", "clear_water") or dm == hm:
                            continue                     # no face, or camouflaged face
                        Ld = int(self.level[dy2, dx2])
                        for fi, fj in ((1, 0), (0, 1)):
                            fx2, fy2 = dx2 + fi, dy2 + fj
                            if (0 <= fx2 < n and 0 <= fy2 < n
                                    and int(self.level[fy2, fx2]) <= Ld - 2):
                                return False             # contrasting drawn face marks this edge
                nx2, ny2 = cx + p, cy + q
                if not (0 <= nx2 < n and 0 <= ny2 < n) or self.mat[ny2, nx2] == "":
                    break
                if int(self.level[ny2, nx2]) < Lh:       # high side ends
                    break
                ux2, uy2 = nx2 - i, ny2 - j              # low side must continue too (same lip)
                if not (0 <= ux2 < n and 0 <= uy2 < n) or int(self.level[uy2, ux2]) >= Lh:
                    break
                cx, cy = nx2, ny2
        # (b) walk straight UP-SCREEN from the seam (alternating the U-column and H-column of
        # the screen line, one row = 15px) until a top surface pokes above the lip's height;
        # that's the ground actually visible at the edge. Different material -> edge reads.
        for rowdist in range(1, 26):
            m = (rowdist - 1) // 2
            if rowdist % 2 == 1:
                cx, cy = lx - m, ly - m                  # U-column cells (odd rows behind)
            else:
                cx, cy = hx - m, hy - m                  # H-column cells (even rows behind)
            if not (0 <= cx < n and 0 <= cy < n) or self.mat[cy, cx] == "":
                return False                             # open ocean/void behind -> edge reads
            if 15 * rowdist + 16 * int(self.level[cy, cx]) >= 16 * Lh:
                return self.mat[cy, cx] == hm            # same ground behind -> illegible -> paint
        return False

    def _bad_lips(self):
        """The lips that actually need covering: same-material toward-camera up-steps that are
        ILLEGIBLE (no nearby visible cliff, same ground visible behind the seam). This — not the
        raw occlusion_violations list — is the_island2's must-be-empty gate; legible same-material
        steps are ALLOWED (maintainer prefers them over the ugly wall-material stripes)."""
        return [v for v in occlusion_violations(self.mat, self.level)
                if self._lip_needed(v[0][0], v[0][1], v[1][0], v[1][1], v[2])]

    def _lip_cover(self, max_iter=8, deck_r=4):
        """Recolour the HIGHER cell of every ILLEGIBLE same-material toward-camera lip (see
        _lip_needed — legible lips are left alone) to a wall material that DIFFERS from ALL its
        up-screen lower neighbours AND from any BRIDGE DECK rendering nearby: a deck floats at
        its own level in a separate overlay, so a stone stripe beside a stone deck merged into
        one unreadable grey band (maintainer's stone-on-stone bridge report) — deck materials
        within deck_r cells join the clash set. If stone AND obsidian both clash (an un-2-
        colourable corner), fall back to DIRT — which differs from both — and drop the cell from
        the rock-ascent set. mat-only, so it never changes a level; always converges (dirt is a
        third escape)."""
        n = self.n
        deck_cells = [(x, y, dk["mat"], int(dk["level"]))
                      for dk in self.decks for (x, y) in dk["cells"]]
        painted = {}
        for _ in range(max_iter):
            bad = self._bad_lips()
            if not bad:
                return True
            for (_lo, (hx, hy), _dh) in sorted(bad, key=lambda v: v[1][0] + v[1][1]):
                L = int(self.level[hy, hx])
                clash = set()
                for i, j in ((-1, 0), (0, -1)):               # up-screen neighbours (lower -> lip)
                    ux, uy = hx + i, hy + j
                    if (0 <= ux < n and 0 <= uy < n and self.mat[uy, ux] not in ("", "clear_water")
                            and int(self.level[uy, ux]) < L):
                        clash.add(self.mat[uy, ux])
                # deck adjacency is a SCREEN-space test: a low deck a few cells up-screen renders
                # at nearly the same pixels as a high stripe (screen y = 15*(x+y) - 16*level), so
                # grid distance lies about what sits "against" the bridge.
                sx, sy = (hx - hy) * 32, (hx + hy) * 15 - 16 * L
                for (dx2, dy2, dm, dl) in deck_cells:
                    if (abs((dx2 - dy2) * 32 - sx) <= 96
                            and abs((dx2 + dy2) * 15 - 16 * dl - sy) <= 64):
                        clash.add(dm)
                # prefer the material an ADJACENT already-painted stripe cell got (one
                # continuous band, no zebra), then the wall materials, then the dirt escape.
                # Stripes are WALL materials only — reusing arbitrary local grounds (grass on
                # the summit) leaked foreign pairs into the collared regions and fed the
                # sliver repair endless work.
                prefer = [painted[(hx + i, hy + j)]
                          for i in (-1, 0, 1) for j in (-1, 0, 1)
                          if (hx + i, hy + j) in painted]
                choice = "lightdark_dirt"                      # fallback: differs from both walls
                for m in prefer + ["stone_mountain", "black_mountain"]:
                    if m in ("stone_mountain", "black_mountain") and m not in clash:
                        choice = m
                        break
                # The beach law is ABSOLUTE (no dirt within Chebyshev 2 of sand — build
                # assert); a deck-clash is only a readability preference. Near sand the
                # dirt escape is forbidden, so take stone even if it clashes.
                if choice == "lightdark_dirt" and any(
                        self.mat[hy + j, hx + i] == "light_sand"
                        for i in (-2, -1, 0, 1, 2) for j in (-2, -1, 0, 1, 2)
                        if 0 <= hx + i < self.n and 0 <= hy + j < self.n):
                    choice = "stone_mountain"
                self.mat[hy, hx] = choice
                painted[(hx, hy)] = choice
                self._linework.add((hx, hy))
                if choice == "lightdark_dirt":
                    self._ascent.discard((hx, hy))
        return not self._bad_lips()

    # -- mountain-HUGGING ascent (cut-in ramps; the benches are the legs) -------

    def _flood_bench(self, cx, cy, L, cap=6000):
        """4-connected flood over walkable non-water cells at level L reachable from (cx,cy)
        — the bench actually reachable from where the last ramp landed (connectivity backbone)."""
        n = self.n
        seen = {(cx, cy)}
        q = deque([(cx, cy)])
        out = []
        while q and len(out) < cap:
            x, y = q.popleft()
            out.append((x, y))
            for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                xx, yy = x + i, y + j
                if (0 <= xx < n and 0 <= yy < n and (xx, yy) not in seen
                        and self.mat[yy, xx] not in ("", "clear_water")
                        and int(self.level[yy, xx]) == L):
                    seen.add((xx, yy))
                    q.append((xx, yy))
        return out

    def _lateral_cliff_step(self, cx, cy, L, side):
        """Over the bench reachable from (cx,cy) at level L, find the L->L+4 cliff whose foot
        `lo` sits at the FAR lateral end in screen-x direction `side` (key=side*(lxx-lyy)); its
        up-screen neighbour `hi` is the next bench (L+4). Alternating `side` makes each leg run
        the full bench width -> long screen-horizontal legs. Returns ((hx,hy),(lx,ly)) or None."""
        n = self.n
        best = None
        for (lxx, lyy) in self._flood_bench(cx, cy, L):
            if (lxx, lyy) in self.reserved:
                continue
            for i, j in ((-1, 0), (0, -1)):          # up-screen (higher) neighbour
                hxx, hyy = lxx + i, lyy + j
                if not (0 <= hxx < n and 0 <= hyy < n):
                    continue
                if not (self.upper[hyy, hxx] and self.mat[hyy, hxx] != "clear_water"):
                    continue
                if int(self.level[hyy, hxx]) != L + 4 or (hxx, hyy) in self.reserved:
                    continue
                key = side * (lxx - lyy)
                if best is None or key > best[0]:
                    best = (key, (hxx, hyy), (lxx, lyy))
        return (best[1], best[2]) if best else None

    def _foot_switchback(self, bx, by, mini=False, floor=None, min_drop=None):
        """TROLLSTIGEN: a wall-hugging stacked-leg switchback down the sheer mountain toe
        (maintainer 2026-07-22, spelled out after every straight staircase failed him):
        the legs run ALONG the cliff and at every turn the slope MIRRORS and continues one
        band further OUT toward the camera -- the top of the new leg aligned with the
        bottom of the old (Z), drawn in front of it (Y) -- so the previous leg becomes the
        next leg's inner WALL and the only fall direction is OUTWARDS.

        GEOMETRY (the insight every axis-aligned attempt missed): a screen-horizontal wall
        is a GRID-DIAGONAL line, so the structure lives on the skew lattice p = x+y
        (screen depth), q = x-y (screen horizontal). The rim is a near-constant-p contour;
        a leg is a zip-band of wleg consecutive p-layers; stacking outward = +p. Levels
        are scheduled on the diagonal t = dir*q - p (dir = the leg's ASCEND direction):
        constant-t lines run along (p+1, q+dir), so every 1-level step edge faces the
        camera (an occluded same-material up-step is impossible by construction), adjacent
        zip cells differ in t by 0 or 2 (walkable at 1 level per R >= 2 t-units), and leg
        k's minimum level equals leg k+1's maximum -- the whole stack is monotone toward
        the camera. Where the wall recedes, the innermost leg WIDENS back to it (the
        1-Lipschitz stand-off o(q)); each leg runs FLAT for its last ~TROLL_PADQ q-units,
        which with the next leg's flat start forms the 2-band hairpin pad ("two cars can
        meet"). Carves by RAISING clean apron cells, keeps the local ground material,
        records cells in _ascent/_troll (+_troll_pads = hairpin noses, exempt from the
        hug assert). Returns the maze landing cell or None."""
        n = self.n
        TOPL = int(self.level[by, bx])
        P0, Q0 = bx + by, bx - by

        def cellpq(p, q):
            return ((p + q) // 2, (p - q) // 2)

        def is_wall(p, q):
            if (p + q) % 2:
                return False
            x, y = cellpq(p, q)
            return (0 <= x < n and 0 <= y < n
                    and (self.upper[y, x] or mini)
                    and (x, y) not in self._troll
                    and self.mat[y, x] not in ("", "clear_water")
                    and int(self.level[y, x]) >= TOPL)

        # -- rim contour: the outermost wall p-layer per screen-horizontal column q --
        start = next((p for p in range(P0 + 4, P0 - 5, -1) if is_wall(p, Q0)), None)
        if start is None:
            self._troll_mini_fail["rim"] += 1
            return None
        rimp = {Q0: start}
        for dq in (1, -1):
            prev, q = rimp[Q0], Q0
            for _ in range(TROLL_QMAX + 24):
                q += dq
                r = next((p for p in range(prev + 2, prev - 3, -1)
                          if (p + q) % 2 == 0 and is_wall(p, q)), None)
                if r is None:
                    break
                rimp[q] = r
                prev = r

        win = None
        for wleg in TROLL_WLEG:                   # wide road first, then narrower
            win = self._troll_window(rimp, cellpq, TOPL, Q0, wleg, mini, floor)
            if win:
                break
        if not win:
            self._troll_mini_fail["window"] += 1
            return None
        qa, qb, FLOOR, entry_right = win
        qs = list(range(qa, qb + 1))
        D = TOPL - FLOOR
        nlegs = max(2, -(-D // TROLL_DROP))
        dP = -(-D // nlegs)

        # 1-Lipschitz stand-off: bands shift <= 1 p-layer per q-column, never on the wall.
        o = {q: max(rimp[z] + 1 - abs(q - z) for z in qs) for q in qs}

        desc0 = -1 if entry_right else 1          # leg 0 walks AWAY from the bench entry
        carved, pads, fill_cells, bandof = {}, set(), set(), {}
        for k in range(nlegs):
            desc = desc0 * (1 if k % 2 == 0 else -1)
            q_s = qa if desc == 1 else qb         # this leg's high (start) end
            Sk = TOPL - k * dP
            t_top = (-desc) * q_s - (o[q_s] + k * wleg)
            # slope from the leg's MEASURED t-span (a fixed window-based run made legs
            # whose stand-off drifts drop once per tile - the staircase gait he rejected)
            t_min = min((-desc) * q - (o[q] + k * wleg) for q in qs)
            Rk = max(2, 2 * (max(2, (t_top - t_min) - TROLL_PADQ) // (2 * dP)))
            for q in qs:
                for m in range(k * wleg, (k + 1) * wleg):
                    p = o[q] + m
                    if (p + q) % 2:
                        continue
                    t = (-desc) * q - p
                    lv = max(FLOOR, Sk - dP, Sk - max(0, t_top - t) // Rk)
                    carved[cellpq(p, q)] = lv
                    bandof[cellpq(p, q)] = (k, q)
                if k == 0:                        # widen back to the wall (hug the recess)
                    for p in range(rimp[q] + 1, o[q]):
                        if (p + q) % 2:
                            continue
                        t = (-desc) * q - p
                        lv = min(TOPL, max(FLOOR, Sk - dP,
                                           Sk - max(0, t_top - t) // Rk))
                        carved[cellpq(p, q)] = lv
                        fill_cells.add(cellpq(p, q))
            q_e = qb if desc == 1 else qa         # hairpin nose: the leg's LOW end plus the
            m_hi = min(k + 2, nlegs) * wleg       # NEXT leg's start there hang free together
            P_e = int(carved[next(cellpq(o[q_e] + m, q_e) for m in range(k * wleg, m_hi)
                                  if (o[q_e] + m + q_e) % 2 == 0)])
            for q in (q_e, q_e - desc):
                for m in range(k * wleg, m_hi):
                    p = o[q] + m
                    if (p + q) % 2 == 0:
                        pads.add(cellpq(p, q))
                        bandof.setdefault(cellpq(p, q), (k, q))
            # BULGE the turn 1-2 columns past the window where the apron allows
            # (maintainer: "extend a bit out... bigger so two cars can meet") — this is
            # what makes the hairpin READ as a turn pad at map scale.
            if k < nlegs - 1:
                for step in (1, 2):
                    q_b = q_e + desc * step
                    ps = [o[q_e] + m for m in range(k * wleg, m_hi)
                          if (o[q_e] + m + q_b) % 2 == 0]
                    if not all(self._troll_apron_ok(cellpq(p, q_b), FLOOR) for p in ps):
                        break
                    for p in ps:
                        carved[cellpq(p, q_b)] = P_e
                        pads.add(cellpq(p, q_b))
                        bandof.setdefault(cellpq(p, q_b), (k, q_b))

        # HUG REPAIR: a ragged wall (groove crack, jogged rim) can leave an up-screen
        # neighbour of the structure >=2 BELOW it — an inward fall. Fill such notches to
        # road level (grass shoulder, unpainted) so "you can only fall outwards" holds
        # against any wall shape; iterate since a fill can expose the next notch cell.
        for _ in range(4):
            grew = False
            for (cx2, cy2), lv in list(carved.items()):
                if (cx2, cy2) in pads:
                    continue
                for wx, wy in ((cx2 - 1, cy2), (cx2, cy2 - 1)):
                    if ((wx, wy) in carved or not (0 <= wx < n and 0 <= wy < n)
                            or self.mat[wy, wx] in ("", "clear_water", "light_sand")
                            or (wx, wy) in self.reserved):
                        continue
                    if int(self.level[wy, wx]) < lv - 1:
                        carved[(wx, wy)] = lv
                        fill_cells.add((wx, wy))
                        grew = True
            if not grew:
                break

        for (x, y), lv in carved.items():         # commit: raise, keep local ground
            self.level[y, x] = lv
            self.upper[y, x] = False
            self.reserved.add((x, y))
            self._ascent.add((x, y))
            self._troll.add((x, y))
            self._troll_floor[(x, y)] = FLOOR
            self._troll_top[(x, y)] = TOPL
        self._troll_raw.update(carved)            # as-carved levels (debug/verify probes)
        if not mini and not self._troll_road:     # first TOE carve = the anchored PRIMARY; only
            # its BAND cells are the paintable road — the wall-fill stays grass shoulder
            # (painting the fill made the whole face one tan blob at map scale)
            self._troll_road.update(c for c in carved if c not in fill_cells)
            self._troll_band.update(bandof)
        self._troll_pads |= pads
        self._nswitch += nlegs - 1

        # Landing: a tail cell of the LAST leg meets the maze floor in front of it.
        desc_last = desc0 * (1 if (nlegs - 1) % 2 == 0 else -1)
        landed = None
        for q in (qs[::-1] if desc_last == 1 else qs):        # from the LOW end back
            for m in range((nlegs - 1) * wleg, nlegs * wleg):
                p = o[q] + m
                if (p + q) % 2:
                    continue
                c = cellpq(p, q)
                if c not in carved:
                    continue
                for pp, qq in ((p + 1, q + 1), (p + 1, q - 1)):
                    x, y = cellpq(pp, qq)
                    if (0 <= x < n and 0 <= y < n and (x, y) not in carved
                            and self.mat[y, x] not in ("", "clear_water", "light_sand")
                            and (x, y) not in self.reserved
                            and abs(int(self.level[y, x]) - carved[c]) <= 1):
                        landed = (x, y)
                        break
                if landed:
                    break
            if landed:
                break
        if landed and not mini:
            self.road_feet.append(landed)
            # the bench entry cell (leg 0's flat start) — the trunk road is routed
            # foot -> entry so the Trollstigen IS the road up the massif
            q_en = qb if entry_right else qa
            for p in (o[q_en], o[q_en] + 1):
                if (p + q_en) % 2 == 0:
                    self._troll_ends.append((landed, cellpq(p, q_en)))
                    break
        return landed

    def _troll_apron_ok(self, xy, floor):
        x, y = xy
        return (0 <= x < self.n and 0 <= y < self.n
                and self.mat[y, x] not in ("", "clear_water", "light_sand")
                and (x, y) not in self.reserved and int(self.level[y, x]) == floor)

    def _troll_window(self, rimp, cellpq, TOPL, Q0, wleg, mini=False, floor=None):
        """Best contiguous q-window along the rim for a Trollstigen: smooth contour
        (|d rimp| <= 2 per column), a clean UNIFORM low apron deep enough for the whole
        stack in every column, and a bench cell at exactly TOPL at one end (the entry,
        flush with the road's start). Prefers the widest window, then nearest the site.
        Returns (qa, qb, floor, entry_right) or None."""
        n = self.n
        qs = sorted(rimp)
        ok, floor_of = {}, {}
        for q in qs:
            ok[q] = False
            fl, uniform, maxd = None, True, 0
            for d in range(1, 4 * wleg + 8):
                p = rimp[q] + d
                if (p + q) % 2:
                    maxd = d
                    continue
                x, y = cellpq(p, q)
                if not (0 <= x < n and 0 <= y < n
                        and self.mat[y, x] not in ("", "clear_water", "light_sand")
                        and (x, y) not in self.reserved):
                    break
                lv = int(self.level[y, x])
                if fl is None:
                    fl = lv
                elif lv != fl:
                    uniform = False
                    break
                maxd = d
            # a MINI climbs exactly one Δ4 bench (its apron IS the next bench down);
            # the TOE descends the full face onto the low maze floor.
            accept = (fl is not None and uniform
                      and ((fl == floor) if floor is not None
                           else (fl == TOPL - 4) if mini
                           else (fl <= 4 and TOPL - fl >= 2 * TROLL_DROP)))
            if accept:
                nl = max(2, -(-(TOPL - fl) // TROLL_DROP))
                if maxd >= nl * wleg + (1 if mini else 2):
                    ok[q], floor_of[q] = True, fl

        def entry_at(q, right):
            # the entry must sit INBOARD of the wall: the rim continues past it (an entry
            # at a rim corner leaves the road's first cells with floor behind). Minis
            # tolerate a 1-level rim step (auto-jump) and 1 column of continuation.
            step = 1 if right else -1
            deep = 1 if mini else 2
            if any(q + k * step not in rimp for k in range(1, deep + 1)):
                return False
            x, y = cellpq(rimp[q], q)
            return TOPL <= int(self.level[y, x]) <= TOPL + (1 if mini else 0)

        qmin = TROLL_QMIN_MINI if mini else TROLL_QMIN
        runs, cur = [], []
        for q in qs:
            if ok[q] and (not cur or (q - cur[-1] == 1
                                      and abs(rimp[q] - rimp[cur[-1]]) <= 2
                                      and floor_of[q] == floor_of[cur[0]])):
                cur.append(q)
            else:
                if len(cur) > qmin:
                    runs.append(cur)
                cur = [q] if ok[q] else []
        if len(cur) > qmin:
            runs.append(cur)
        best = None
        for run in runs:
            cands = [(run[0], run[-1])]
            if run[-1] - run[0] > TROLL_QMAX:
                cands = [(run[0], run[0] + TROLL_QMAX), (run[-1] - TROLL_QMAX, run[-1])]
            for qa, qb in cands:
                for right in (False, True):
                    if not entry_at(qb if right else qa, right):
                        continue
                    score = (-(qb - qa), abs((qa + qb) / 2 - Q0))
                    if best is None or score < best[0]:
                        best = (score, qa, qb, floor_of[qa], right)
        return None if best is None else (best[1], best[2], best[3], best[4])

    def _climb_hugging(self, hx, hy, lx, ly):
        """A mountain-HUGGING ascent: a HAIRPINNING foot switchback down the sheer toe to the maze,
        then bench-by-bench a SHORT rock ramp cut into each Δ4 cliff at ALTERNATING lateral ends.
        The flat benches are the long contour-following LEGS the dirt router paints a road along;
        every ramp keeps the higher bench as an uphill WALL and drops one bench toward the camera
        (single fall direction). No straight free-standing ribbon over low ground."""
        if self._foot_switchback(hx, hy) is None:       # folded descent bench16 -> maze
            return False
        cx, cy = hx, hy
        side = 1
        top = int(BENCHES.max())
        for _ in range(len(BENCHES)):
            L = int(self.level[cy, cx])
            if L >= top:
                break
            step = self._lateral_cliff_step(cx, cy, L, side)
            if step is None:
                break
            (hxx, hyy), (lxx, lyy) = step
            # Every bench climb is a MINI-Trollstigen (maintainer 2026-07-22: "why do you
            # keep drawing straight staircases when we have a better system" — the red-
            # crossed connector ramps are gone). The straight connector remains only as a
            # last-resort fallback so the summit can never be disconnected.
            if self._foot_switchback(hxx, hyy, mini=True) is None:
                alt = self._lateral_cliff_step(cx, cy, L, -side)
                done = (alt is not None
                        and self._foot_switchback(alt[0][0], alt[0][1], mini=True) is not None)
                if done:
                    (hxx, hyy), (lxx, lyy) = alt
                else:
                    self._troll_fallbacks += 1
                    if not self._carve_connector(hxx, hyy, lxx, lyy):
                        break
            cx, cy = hxx, hyy                            # now on bench L+4
            side = -side                                # alternate the hairpin end
        return True

    def _mountain_stairs(self, k=STAIR_CORRIDORS):
        """Place exactly k tidy, laterally-separated full-height ROCK corridors up the mountain
        foot; the rest stays a sheer rock cliff. Sets _stairs_done so _connect_all sprouts no
        new zigzag afterwards."""
        n, up = self.n, self.upper
        foot = []
        for y in range(n):
            for x in range(n):
                if not (up[y, x] and self.mat[y, x] != "clear_water"):
                    continue
                for i, j in ((1, 0), (0, 1)):
                    xx, yy = x + i, y + j
                    if (0 <= xx < n and 0 <= yy < n and self.maze[yy, xx]
                            and self.mat[yy, xx] != "clear_water"):
                        drop = int(self.level[y, x]) - int(self.level[yy, xx])
                        if drop >= SWITCH_MIN:
                            foot.append((drop, x, y, xx, yy))
        # The maintainer anchored the PRIMARY corridor to his blue window (TROLL_SITE_FRAC):
        # the candidate nearest the anchor within TROLL_SITE_R goes first. The rest prefer
        # the BIGGEST drop (the Trollstigen wants a tall sheer face), then camera-ward.
        foot.sort(key=lambda f: (-f[0], -(f[3] + f[4])))
        ax_ = self.M + TROLL_SITE_FRAC[0] * self.nd
        ay_ = self.M + TROLL_SITE_FRAC[1] * self.nd
        anchored = sorted((f for f in foot
                           if (f[1] - ax_) ** 2 + (f[2] - ay_) ** 2 <= TROLL_SITE_R ** 2),
                          key=lambda f: (f[1] - ax_) ** 2 + (f[2] - ay_) ** 2)
        if anchored:
            foot = anchored[:1] + [f for f in foot if f != anchored[0]]
        chosen = []
        for drop, hx, hy, lx, ly in foot:
            if len(chosen) >= k:
                break
            if any((hx - cx) ** 2 + (hy - cy) ** 2 < (STAIR_SPACING * n) ** 2
                   for cx, cy in chosen):
                continue
            if self._climb_hugging(hx, hy, lx, ly):
                chosen.append((hx, hy))
        self._stairs_done = True

    def _fill_traps(self, max_iter=40):
        """Override: after the parent's flush-raise of sealed pockets, any SAND lifted off
        the shore stops being beach (sand is a SHORE material — at altitude it violates
        the beach laws: dirt-distance, rock collar). Raised sand becomes grass terrace."""
        super()._fill_traps(max_iter)
        lifted = (self.mat == "light_sand") & (self.level >= 3)
        self.mat[lifted] = "saturated_grass"

    def _merge_ramp(self, main, cands):
        """Post-stairs mop-up: connect residual pockets with MINI-TROLLSTIGENS (maintainer
        2026-07-23: "this was your goal — remove the need for a traditional staircase";
        the zigzag system is THE way up every elevation, maze tiers included). For each
        candidate edge, carve a mini from the HIGH rim down to the LOW side's exact floor.
        The straight _carve_connector survives only as a counted last resort — and the
        build asserts the count stays ZERO, so a resistant pocket fails loudly instead of
        shipping a staircase."""
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
            fl = int(self.level[lo[1], lo[0]])
            if self._foot_switchback(hi[0], hi[1], mini=True, floor=fl,
                                     min_drop=2) is not None:
                return True
        return False

    def _carve_connector(self, hx, hy, lx, ly, w=3):
        """Override: straight descending stair spur that KEEPS the ground type already present
        at each cell (maintainer 2026-07-22: don't always use stone — a stair through snow is
        snow, through grass is grass; the steps face the camera so they read in any material);
        clears self.upper and records the cells in self._ascent."""
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
                if (0 <= x < n and 0 <= y < n and self.land[y, x]
                        and self.mat[y, x] != "clear_water"
                        and (x, y) not in self._troll):   # never slice the Trollstigen
                    self.level[y, x] = lv
                    self.upper[y, x] = False
                    self.reserved.add((x, y))
                    self._ascent.add((x, y))
        return True

    # -- materials: BIGGER beaches; dirt is ROADS, not borders -----------------

    def _materials(self):
        n, X, Y, s = self.n, self.X, self.Y, self.seed
        mat, level = self.mat, self.level
        g = mat == "saturated_grass"
        mat[g & (level >= 14)] = "stone_mountain"
        mat[(mat == "stone_mountain") & (level >= 28)] = "regular_snow"
        bx = X + n * 0.09 * (_fbm(X, Y, s + 40, n * 0.26, 3) - 0.5) * 2
        by = Y + n * 0.09 * (_fbm(X, Y, s + 41, n * 0.26, 3) - 0.5) * 2
        glac = _fbm(bx, by, s + 13, n * 0.13, 3)
        cald = _fbm(bx, by, s + 9, n * 0.11, 4)
        scar = _fbm(bx, by, s + 50, n * 0.085, 3)
        # CONTAINMENT COLLARS (the no-sliver rule at the SOURCE): every pure-terrain material
        # pair must meet cleanly two-by-two — a point where three grounds all touch always
        # leaves some tile bordering two different foreigns, which a tile can't transition to.
        # So the accent materials are kept STRICTLY INTERIOR to their parent: ice inside snow,
        # summit obsidian inside snow (and >=2 from ice), scar obsidian inside stone. The parent
        # then always separates them from any third material.
        snowm = mat == "regular_snow"
        ice = snowm & (glac > 0.52) & (level >= 32) & ~_dilate8(~snowm, 2)
        mat[ice] = "crystal_ice"
        snow2 = mat == "regular_snow"
        black_hi = (snow2 & (cald > 0.60) & (level >= 30)
                    & ~_dilate8(~(snow2 | ice), 2) & ~_dilate8(ice, 3))
        stonem = mat == "stone_mountain"
        black_lo = (stonem & (level >= 16) & (level < 28) & (X < n * 0.56) & (scar > 0.58)
                    & ~_dilate8(~stonem, 2))
        mat[black_hi | black_lo] = "black_mountain"
        # BIGGER beaches: a deeper distance sweep + a wider, cove/camera-biased sand depth.
        water = mat == "clear_water"
        d2w = np.full((n, n), 99, np.int16)
        ring = water.copy()
        for dist in range(1, 16):
            nd = _dilate(ring, 1) & ~ring
            d2w[nd & (d2w == 99)] = dist
            ring = ring | nd
        sd = _fbm(bx, by, s + 60, n * 0.12, 3)
        dcam = (X + Y) / (2 * (n - 1))
        cove = np.exp(-(((X - 0.50 * n) ** 2 + (Y - 0.90 * n) ** 2) / (2 * (0.14 * n) ** 2)))
        sand_depth = (2 + np.rint(sd * sd * 10) + np.rint(6.0 * cove)
                      + np.rint(3.0 * dcam)).astype(np.int16)
        rock = np.isin(mat, np.array(["stone_mountain", "black_mountain"], object))
        beach = ((mat == "saturated_grass") & (level <= 2) & (d2w < 99) & (d2w <= sand_depth)
                 & ~_dilate8(rock, 2))         # grass collar: sand >= Chebyshev 3 from rock
        mat[beach] = "light_sand"

    # -- multi-level lakes (flush inland ponds/tarns + an internal gorge) -------

    def _mask_components(self, mask):
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


    def _beach_access(self, maxd=30):
        """NO DEAD-END SHORES (maintainer 2026-07-23: "you can't walk up from the beach"):
        every stretch of beach must reach interior ground without a long detour. Multi-
        source BFS over the sand from every existing up-exit (a step of <=1 level onto
        walkable non-sand land); every stranded cluster (all cells farther than `maxd`)
        gets ONE graded TONGUE -- a 2-wide slope notch cut INTO the adjacent shelf,
        stepping 1 level per cell inward (up-screen only, so every face stays visible),
        keeping the shelf's local ground. No sand is ever raised; no staircase drawn."""
        n = self.n
        sand = self.mat == "light_sand"
        cells = [(x, y) for y in range(n) for x in range(n) if sand[y, x]]
        sandset = set(cells)
        dist, q = {}, deque()
        for (x, y) in cells:
            for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                xx, yy = x + i, y + j
                if (0 <= xx < n and 0 <= yy < n and not sand[yy, xx]
                        and self.mat[yy, xx] not in ("", "clear_water")
                        and abs(int(self.level[yy, xx]) - int(self.level[y, x])) <= 1):
                    dist[(x, y)] = 0
                    q.append((x, y))
                    break
        while q:
            x, y = q.popleft()
            for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                c = (x + i, y + j)
                if (c in sandset and c not in dist
                        and abs(int(self.level[y, x]) - int(self.level[c[1], c[0]])) <= 1):
                    dist[c] = dist[(x, y)] + 1
                    q.append(c)
        far = lambda c: dist.get(c, 10 ** 9) > maxd
        seen = set()
        for c0 in sorted((c for c in cells if far(c)), key=lambda c: -dist.get(c, 10 ** 9)):
            if c0 in seen:
                continue
            comp, st = {c0}, [c0]
            while st:
                px, py = st.pop()
                seen.add((px, py))
                for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    cc = (px + i, py + j)
                    if cc in sandset and cc not in seen and far(cc):
                        comp.add(cc)
                        st.append(cc)
            for (sx, sy) in sorted(comp, key=lambda c: -dist.get(c, 10 ** 9)):
                if self._carve_tongue(sx, sy):
                    break

    def _carve_tongue(self, sx, sy):
        n = self.n
        b = int(self.level[sy, sx])
        for i, j in ((0, -1), (-1, 0)):          # inward must be UP-SCREEN: faces visible
            wx, wy = sx + i, sy + j
            if not (0 <= wx < n and 0 <= wy < n):
                continue
            m = self.mat[wy, wx]
            if m in ("", "clear_water", "light_sand"):
                continue
            L = int(self.level[wy, wx])
            if not (2 <= L - b <= 8):
                continue
            perp = (j, i)
            plan, ok = [], True
            for k in range(L - b - 1):           # tongue levels b+1 .. L-1, stepping inward
                for t in (0, 1):
                    x, y = wx + i * k + perp[0] * t, wy + j * k + perp[1] * t
                    if not (0 <= x < n and 0 <= y < n and self.mat[y, x] == m
                            and (x, y) not in self.reserved
                            and int(self.level[y, x]) == L):
                        ok = False
                        break
                    plan.append((x, y, b + 1 + k))
                if not ok:
                    break
            if not ok:
                continue
            for (x, y, lv) in plan:
                self.level[y, x] = lv
                self.upper[y, x] = False
                self.reserved.add((x, y))
            return True
        return False

    def _reserved_np(self):
        n = self.n
        r = np.zeros((n, n), bool)
        for (x, y) in self.reserved:
            r[y, x] = True
        return _dilate(r, 1)

    def _rim_flat(self, comp, L):
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

    def _mtn_gorge(self):
        """A PROMINENT DEEP water gorge down the massif spine that VISIBLY cuts the mountain in
        two. The old version was a 3-wide trench that hid its water behind the near wall (a grey
        shadow). This one is a WIDE (7-cell) channel that runs continuously toward the camera and
        EXITS through the massif toe into the lowland — so downstream every water cell's toward-
        camera neighbour is also water (or open low ground), the near wall vanishes, and the level-0
        water surface is plainly visible. Carved AFTER camera_monotone; _connect_all/_place_bridges
        reconnect the flanks and _bridge_over_gorge lays a deliberate HIGH (>=16) stone bridge up in
        the tall part. Water at level 0 is occlusion-legal (different material)."""
        # Run the channel along the grid (1,1) diagonal = STRAIGHT DOWN THE SCREEN toward the
        # camera. Then a water cell's toward-camera neighbours (+x,+y) are inside the channel
        # (not a tall bank), so nothing occludes the surface; the tall walls sit to screen-left/
        # right and merely frame it. A short near-vertical reach up high hosts the high bridge.
        # The passage then CONTINUES SOUTH through the maze all the way to the OCEAN (maintainer
        # 2026-07-22, red mark): the carver stops by itself when it meets sea water, so the
        # channel joins the ocean through the south beach — one waterway from massif to sea.
        PATH = [(90, 30), (100, 40), (108, 50),          # diagonal approach from the ridge
                (110, 62), (112, 74),                     # near-vertical bridge reach (banks tall)
                (124, 88), (138, 102), (150, 114),        # open diagonal exit through the toe
                (152, 134), (149, 154), (151, 174),       # south through the maze tiers...
                (149, 194), (150, 222)]                   # ...across the beach into the sea
        chan = self._gorge_channel(PATH, wob_amp=2, half=3,
                                   straight=((0.19, 0.25), (0.60, 0.68)))
        if len(chan) < 12:
            self._gorge_cells = set()
            return
        for (x, y) in chan:
            self.mat[y, x] = "clear_water"
            self.level[y, x] = 0
        self._gorge_cells = chan

    def _gorge_channel(self, PATH, wob_amp=4, half=1, straight=None):
        """Deep-gorge rasteriser down the massif. The UPPER reach (in self.upper) is a deep slot;
        past the massif toe it keeps flowing through the LOW foothill/maze so the canyon opens to
        the camera instead of dead-ending in a hidden trench. Only carves land at level < 16 once
        it leaves the upper zone (so it exits through the low toe, never eating a maze plateau).
        `straight`=(fy0,fy1) zeroes the x-wobble -> x-aligned rows for the high bridge. Returns a
        set."""
        n, s, M, nd = self.n, self.seed, self.M, self.nd
        if straight and isinstance(straight[0], (int, float)):
            straight = (straight,)                       # single band -> list of bands
        chan = set()
        for (ax, ay), (bx, by) in zip(PATH, PATH[1:]):
            steps = int(math.hypot(bx - ax, by - ay)) + 1
            for i in range(steps + 1):
                t = i / steps
                yy_f = ay + (by - ay) * t
                fy = (yy_f - M) / nd
                if straight and any(b0 <= fy <= b1 for (b0, b1) in straight):
                    wob = 0.0
                else:
                    wob = (_fbm(np.float32(ax), np.float32(yy_f), s + 79, n * 0.06, 3) - 0.5) * 2 * wob_amp
                cx = int(ax + (bx - ax) * t + wob)
                cy = int(yy_f)
                for dx in range(-half, half + 1):
                    x, y = cx + dx, cy
                    if not (0 <= x < n and 0 <= y < n) or (x, y) in self.reserved:
                        continue
                    m = self.mat[y, x]
                    if m in ("", "clear_water"):
                        continue
                    if self.upper[y, x] or int(self.level[y, x]) < 16:
                        chan.add((x, y))
        return chan

    def _deck_mat(self, wm, em):
        """A bridge wears the ground it connects (maintainer 2026-07-22: 'create it in the same
        ground type, not always switch') — deck material = the bank's ground: grass decks over
        the maze river, snow up on the massif, stone only where the banks ARE stone. The value
        picked at laying time is PROVISIONAL — _resolve_deck_mats re-reads the banks once all
        ground painting is final (the gorge bridges are laid before _materials paints the
        mountain caps, so at that moment every bank still reads grass)."""
        if wm in GROUND_MATS:
            return wm
        if em in GROUND_MATS:
            return em
        return "stone_mountain"

    def _resolve_deck_mats(self):
        """Re-resolve every deck's material from its FINAL banks: majority ground among the
        walkable land cells orthogonally adjacent to the deck within 1 level of it. Must run
        after _materials/_fix_material_slivers/_dirt_roads so a massif crossing reads its real
        snow/stone banks (and a bridge a road actually runs onto may wear the road).

        Also slims every BRIDGE to a 1-level slab (maintainer 2026-07-22: 'draw all bridges
        1 level in height... remove the bottom tile so the bridge still lines up with the
        ground'): thickness 0 = the top tile alone, whose baked face IS the one visible
        level; the walk surface stays at deck level, flush with the banks. Applied here so
        it covers bridges laid by ANY creator, including inherited ones."""
        for dk in self.decks:
            if dk.get("kind") == "bridge":
                dk["thickness"] = 0
            cells = set(dk["cells"])
            dlv = int(dk["level"])
            votes = Counter()
            for (x, y) in cells:
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    bx, by = x + dx, y + dy
                    if not (0 <= bx < self.n and 0 <= by < self.n) or (bx, by) in cells:
                        continue
                    m = self.mat[by, bx]
                    if m not in GROUND_MATS or abs(int(self.level[by, bx]) - dlv) > 1:
                        continue
                    votes[m] += 1
            if votes:
                dk["mat"] = max(votes, key=lambda m: (votes[m], -GROUND_MATS.index(m)))

    def _bridge_over_gorge(self, chan, sites=GORGE_BRIDGE_FRACS):
        """Lay the maintainer's deliberate STONE crossings over the massif-to-ocean waterway at
        the `sites` design fractions (nearest clean candidate row per site). Runs EARLY — before
        _connect_all — so the flanks are linked by REAL bridges and the connectivity pass never
        improvises a make-shift span; bank membership therefore checks 'in a sizeable walkable
        component' rather than 'in THE main component'. Deck at the shared bank level; a
        walk-link per row spans the water. Returns #laid."""
        n = self.n
        riverw = np.zeros((n, n), bool)
        for (x, y) in chan:
            riverw[y, x] = True
        main = set()
        for comp in self._walk_components():
            if len(comp) >= 8:               # pre-connect pockets count: the bridge's own links
                main.update(comp)            # merge them into main, and the final deck-bank
                                             # assert still guarantees real connectivity

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
            run = min(runs, key=lambda r: r[-1] - r[0])
            return run[0], run[-1]

        def row_ok(r, x0, x1, dlv):
            if not all(0 <= x < n and riverw[r, x] for x in range(x0, x1 + 1)):
                return False
            for bx in (x0 - 1, x1 + 1):
                if not (0 <= bx < n and self.mat[r, bx] not in ("", "clear_water")):
                    return False
                if abs(int(self.level[r, bx]) - dlv) > 1:
                    return False
                if (bx, r) not in main:
                    return False
            return True

        cands = []
        for cy in sorted({y for (_x, y) in chan}):
            ch = channel(cy)
            if not ch:
                continue
            x0, x1 = ch
            if x0 - 1 < 0 or x1 + 1 >= n or x1 - x0 > 6:
                continue
            la, lb = self.mat[cy, x0 - 1], self.mat[cy, x1 + 1]
            if la in ("", "clear_water") or lb in ("", "clear_water"):
                continue
            va, vb = int(self.level[cy, x0 - 1]), int(self.level[cy, x1 + 1])
            if abs(va - vb) > 1:
                continue
            dlv = min(va, vb)
            rows3 = [r for r in (cy - 1, cy, cy + 1) if row_ok(r, x0, x1, dlv)]
            rows = rows3 if len(rows3) >= 2 else ([cy] if row_ok(cy, x0, x1, dlv) else [])
            if rows:
                cands.append(((x1 - x0), -len(rows), -dlv, cy, x0, x1, dlv, rows))
        if not cands:
            return 0
        # One crossing per SITE: nearest clean candidate row to each design-fraction target
        # (within 10 rows), never two crossings closer than 8 rows, never on cells that already
        # carry a deck.
        laid = 0
        laid_cys = []
        for frac in sites:
            gy = self.M + frac * self.nd
            near = sorted((c for c in cands if abs(c[3] - gy) <= 10),
                          key=lambda c: (abs(c[3] - gy), c[0], c[2]))
            for _w, _nr, _nl, cy, x0, x1, dlv, rows in near:
                if any(abs(cy - lc) < 8 for lc in laid_cys):
                    continue
                cells = [(x, r) for r in rows for x in range(x0, x1 + 1)]
                if any((x, r) in self.reserved for (x, r) in cells):
                    continue
                dm = self._deck_mat(self.mat[cy, x0 - 1], self.mat[cy, x1 + 1])
                self.decks.append({"kind": "bridge", "mat": dm, "level": dlv,
                                   "thickness": 0, "cells": cells})
                for r in rows:
                    self.links.append(((x0 - 1, r), (x1 + 1, r)))
                self.reserved.update(cells)
                laid_cys.append(cy)
                laid += 1
                break
        return laid

    def _place_bridges(self, count=None):
        """Override: maze-river crossings at the maintainer's RIVER_BRIDGE_FRACS sites (nearest
        clean row per site), scoped to the RIVER water only — the massif waterway has its own
        deliberate crossings (_bridge_over_gorge) and must not attract extra decks here."""
        n = self.n
        riverw = (self.mat == "clear_water") & self.land
        for (x, y) in self._gorge_cells:
            riverw[y, x] = False
        main = set(self._walk_components()[0])

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
            run = min(runs, key=lambda r: r[-1] - r[0])
            return run[0], run[-1]

        def row_ok(r, x0, x1, dlv):
            if not all(0 <= x < n and riverw[r, x] for x in range(x0, x1 + 1)):
                return False
            for bx in (x0 - 1, x1 + 1):
                if not (0 <= bx < n and self.mat[r, bx] not in ("", "clear_water")):
                    return False
                if abs(int(self.level[r, bx]) - dlv) > 1:
                    return False
                if (bx, r) not in main:
                    return False
            return True

        cands = []
        for cy in range(int(n * 0.30), int(n * 0.92)):
            ch = channel(cy)
            if not ch:
                continue
            x0, x1 = ch
            if x0 - 1 < 0 or x1 + 1 >= n or x1 - x0 > 6:
                continue
            la, lb = self.mat[cy, x0 - 1], self.mat[cy, x1 + 1]
            if la in ("", "clear_water") or lb in ("", "clear_water"):
                continue
            va, vb = int(self.level[cy, x0 - 1]), int(self.level[cy, x1 + 1])
            if abs(va - vb) > 1:
                continue
            dlv = min(va, vb)
            rows3 = [r for r in (cy - 1, cy, cy + 1) if row_ok(r, x0, x1, dlv)]
            rows = rows3 if len(rows3) >= 2 else ([cy] if row_ok(cy, x0, x1, dlv) else [])
            if rows:
                cands.append(((x1 - x0), -len(rows), -dlv, cy, x0, x1, dlv, rows))
        laid_cys = []
        for frac in RIVER_BRIDGE_FRACS:
            gy = self.M + frac * self.nd
            near = sorted((c for c in cands if abs(c[3] - gy) <= 8),
                          key=lambda c: (abs(c[3] - gy), c[0], c[1]))
            for _w, _nr, _nl, cy, x0, x1, dlv, rows in near:
                if any(abs(cy - lc) < 8 for lc in laid_cys):
                    continue
                cells = [(x, r) for r in rows for x in range(x0, x1 + 1)]
                if any((x, r) in self.reserved for (x, r) in cells):
                    continue
                dm = self._deck_mat(self.mat[cy, x0 - 1], self.mat[cy, x1 + 1])
                self.decks.append({"kind": "bridge", "mat": dm, "level": dlv,
                                   "thickness": 0, "cells": cells})
                for r in rows:
                    self.links.append(((x0 - 1, r), (x1 + 1, r)))
                self.reserved.update(cells)
                laid_cys.append(cy)
                break

    def _merge_span(self, main, cands):
        """Override: like Island's connectivity water-span bridge, but a side lane (w=±1) is
        laid ONLY when BOTH of its own bank endpoints are walkable land within 1 level of the
        deck — the parent laid all three lanes blindly, which on a span crossing a wide channel
        left side lanes ending in open water (deck rows with no walkable bank; the build's
        bank assert rightly rejects that). The centre lane is guaranteed by construction."""
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
        mx, my = tx + i * step, ty + j * step
        lanes = []
        for w in (-1, 0, 1):
            a = (tx + perp[0] * w, ty + perp[1] * w)
            b = (mx + perp[0] * w, my + perp[1] * w)
            if not all(0 <= v < n for v in (a[0], a[1], b[0], b[1])):
                continue
            if w != 0:
                ok = all(self.mat[p[1], p[0]] not in ("", "clear_water")
                         and abs(int(self.level[p[1], p[0]]) - blv) <= 1
                         for p in (a, b))
                if not ok:
                    continue
            lanes.append((w, a, b))
        cells = []
        for s in range(1, step):
            cxx, cyy = tx + i * s, ty + j * s
            for (w, _a, _b) in lanes:
                x, y = cxx + perp[0] * w, cyy + perp[1] * w
                if 0 <= x < n and 0 <= y < n:
                    cells.append((x, y))
        self.decks.append({"kind": "bridge", "mat": self._deck_mat(self.mat[ty, tx],
                                                                    self.mat[my, mx]),
                           "level": max(2, blv), "thickness": 0, "cells": cells})
        for (_w, a, b) in lanes:
            self.links.append((a, b))
        return True

    def _ponds(self):
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

    def _sunken_lagoon(self, rw=LAGOON_RW):
        """A small WALK-IN lagoon: a bowl sunk 2 levels below its flat surroundings with a Δ1
        walkable shore ring you descend to and climb back from. Water at L-2 (barrier), shore
        at L-1, rim at L. Placed in the MAZE/foothill (not the antitone mountain) AFTER the
        guarantee loop; camera-facing (+x/+y) rim lips made legal by _lip_cover. Whole-bbox
        transactional so it can never seal a region or strand the shore."""
        for (fx, fy) in LAGOON_SITES:
            if self._try_lagoon(*self._to_grid(fx, fy), rw):
                return True
        return False

    def _try_lagoon(self, tx, ty, rw):
        n = self.n
        zone = self.maze | self.upper          # a lagoon may sit on the mountain OR in the maze
        lo, hi = self.M + rw + 2, n - self.M - rw - 2
        best = None
        for y in range(max(lo, ty - 22), min(hi, ty + 23)):
            for x in range(max(lo, tx - 22), min(hi, tx + 23)):
                if not (zone[y, x] and self.mat[y, x] not in ("", "clear_water")):
                    continue
                L = int(self.level[y, x])
                if L < 2:
                    continue
                flat = True
                for j in range(-(rw + 1), rw + 2):
                    for i in range(-(rw + 1), rw + 2):
                        xx, yy = x + i, y + j
                        if (not zone[yy, xx] or self.mat[yy, xx] in ("", "clear_water")
                                or int(self.level[yy, xx]) != L or (xx, yy) in self.reserved):
                            flat = False
                            break
                    if not flat:
                        break
                if flat:
                    d = (x - tx) ** 2 + (y - ty) ** 2
                    if best is None or d < best[0]:
                        best = (d, x, y, L)
        if best is None:
            return False
        _d, cx, cy, L = best
        water, ring = [], []
        for j in range(-(rw + 1), rw + 2):
            for i in range(-(rw + 1), rw + 2):
                md = abs(i) + abs(j)
                if md <= rw:
                    water.append((cx + i, cy + j))
                elif md == rw + 1:
                    ring.append((cx + i, cy + j))
        bbox = [(cx + i, cy + j) for j in range(-(rw + 2), rw + 3)
                for i in range(-(rw + 2), rw + 3)]
        saved = [(x, y, self.mat[y, x], int(self.level[y, x]), bool(self.upper[y, x]))
                 for (x, y) in bbox]
        for (x, y) in water:
            self.mat[y, x] = "clear_water"
            self.level[y, x] = L - 2
            self.upper[y, x] = False        # water is barrier-governed, not mountain-antitone
        for (x, y) in ring:
            self.level[y, x] = L - 1        # walkable Δ1 shore; camera-side lip fixed next
            self.upper[y, x] = False
        ok = self._lip_cover()
        walk = (self.mat != "") & (self.mat != "clear_water")
        land = int(walk.sum())
        comps = self._walk_components()
        mainset = set(comps[0]) if comps else set()
        maze_land = int((self.maze & (self.mat != "clear_water")).sum())
        upper_land = int((self.upper & (self.mat != "clear_water")).sum())
        if (ok and not self._bad_lips()
                and self._trap_count() == 0
                and len(mainset) >= 0.98 * land
                and all((x, y) in mainset for (x, y) in ring)
                and maze_land >= 1.6 * upper_land):
            self.reserved.update(water)
            self.reserved.update(ring)
            return True
        for (x, y, m, lv, up) in saved:
            self.mat[y, x] = m
            self.level[y, x] = lv
            self.upper[y, x] = up
        return False

    # -- dirt ROADS: 8-direction, margined off beach/mountain, corridor-centred --

    def _wander_field(self):
        if getattr(self, "_wander", None) is None:
            n, X, Y, s = self.n, self.X, self.Y, self.seed
            w = _fbm(X, Y, s + 91, n * 0.16, 4) + 0.5 * _fbm(X, Y, s + 92, n * 0.07, 3)
            self._wander = (w - w.min()) / (w.max() - w.min() + 1e-6)
        return self._wander

    def _dist_field(self, mask, cap=8):
        """Capped multi-source Manhattan distance from every True cell of `mask`."""
        n = self.n
        d = np.full((n, n), cap, np.int16)
        ring = mask.copy()
        d[ring] = 0
        for dist in range(1, cap):
            grow = _dilate(ring, 1) & ~ring
            d[grow & (d == cap)] = dist
            ring = ring | grow
        return d

    def _set_road_now(self, road):
        """Cache a distance-to-current-road field so _road_graph_bfs pulls a new spur ONTO the
        existing network (a tight Y-merge) instead of running parallel to it. Rebuilt after the
        trunk and after each accepted spur."""
        n = self.n
        m = np.zeros((n, n), bool)
        for (x, y) in road:
            m[y, x] = True
        self._road_now = set(road)
        self._road_attract = self._dist_field(m, cap=ROAD_ATTRACT_R + 1)

    def _mtn_foot_mask(self):
        """Maze/land cells at the foot of an UNCARVED sheer mountain cliff (ascent ribbons
        have upper=False so they are NOT flagged — the road can still approach the stairs)."""
        n, up = self.n, self.upper
        land = (self.mat != "") & (self.mat != "clear_water")
        lv = self.level.astype(np.int32)
        foot = np.zeros((n, n), bool)
        for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            up_nb = np.roll(np.roll(up & land, -j, 0), -i, 1)
            lv_nb = np.roll(np.roll(lv, -j, 0), -i, 1)
            foot |= land & ~up & up_nb & ((lv_nb - lv) >= SWITCH_MIN)
        foot[:1, :] = foot[-1:, :] = foot[:, :1] = foot[:, -1:] = False
        return foot

    def _road_obstacle_mask(self):
        """Non-walkable boundaries for the centring term: water/void + any cliff edge."""
        n = self.n
        land = (self.mat != "") & (self.mat != "clear_water")
        lv = self.level.astype(np.int32)
        obs = ~land
        for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            lv_nb = np.roll(np.roll(lv, -j, 0), -i, 1)
            land_nb = np.roll(np.roll(land, -j, 0), -i, 1)
            obs |= land & land_nb & (np.abs(lv_nb - lv) > 1)
        obs[:1, :] = obs[-1:, :] = obs[:, :1] = obs[:, -1:] = True
        return obs

    def _road_cost_field(self):
        """Cached additive per-cell road cost: margin off beach/water (concerns 2/4) + off the
        mountain-foot cliff (concern 3) + a corridor-centring reward (concern 3). Rock-ascent
        cells get a flat bonus so the trunk prefers the stairs. All FINITE -> a route exists."""
        if getattr(self, "_rcost", None) is not None:
            return self._rcost
        n, mat = self.n, self.mat
        d2edge = self._dist_field((mat == "clear_water") | (mat == "light_sand"), cap=8)
        d2foot = self._dist_field(self._mtn_foot_mask(), cap=6)
        d2obs = self._dist_field(self._road_obstacle_mask(), cap=6)
        cost = np.zeros((n, n), np.float32)
        cost += np.where(d2edge <= ROAD_BEACH_MARGIN,
                         (ROAD_BEACH_MARGIN + 1 - d2edge).astype(np.float32) * BEACH_PEN, 0.0)
        cost += np.where(d2foot <= ROAD_FOOT_MARGIN,
                         (ROAD_FOOT_MARGIN + 1 - d2foot).astype(np.float32) * FOOT_PEN, 0.0)
        cost += (6 - np.clip(d2obs, 0, 6)).astype(np.float32) * CENTER_AMP
        if self._ascent:
            for (x, y) in self._ascent:
                # a non-road Trollstigen must not magnet the trunk off-course
                if (x, y) in self._troll and (x, y) not in self._troll_road:
                    continue
                cost[y, x] = -ASCENT_BONUS
        self._rcost = cost
        return cost

    def _road_graph_bfs(self, sources, diagonals=True):
        """8-DIRECTION Dijkstra over the walkable graph. Cardinal moves (screen-diagonal):
        4-neighbour, |Δlevel|<=1, + bridge links. Grid-DIAGONAL moves (screen +/horizontal/
        vertical): only on FLAT Δ0 land with a same-level ELBOW cell (recorded) so the painted
        road stays 4-connected-walkable. sqrt2 diagonal weight beats the 2.0 cardinal zigzag ->
        clean screen +/vertical/horizontal roads. Costs from the wander + margin/centre field.
        Returns dist{}, parent{}, elbow{} (elbow None for cardinal moves)."""
        n, mat, level = self.n, self.mat, self.level
        land = lambda x, y: mat[y, x] != "" and mat[y, x] != "clear_water"
        ladj, wf, wc = self._link_adj(), self._wander_field(), self._road_cost_field()
        ra = self._road_attract          # pull spurs onto the existing road (early Y-merge)
        fb = getattr(self, "_road_forbid", None)   # HARD keep-out (beach padding); soft pass: None
        dist, parent, elbow, pq = {}, {}, {}, []
        src = [sources] if isinstance(sources, tuple) else list(sources)
        for (sx, sy) in src:
            if land(sx, sy) and (sx, sy) not in dist:
                dist[(sx, sy)] = 0.0
                heapq.heappush(pq, (0.0, sx, sy))
        while pq:
            dd, x, y = heapq.heappop(pq)
            if dd > dist.get((x, y), 1e18):
                continue
            L = int(level[y, x])
            moves = []
            for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                xx, yy = x + i, y + j
                if 0 <= xx < n and 0 <= yy < n and land(xx, yy) and abs(int(level[yy, xx]) - L) <= 1:
                    if fb is None or not fb[yy, xx]:
                        moves.append(((xx, yy), None))
            for v in ladj.get((x, y), ()):
                if 0 <= v[0] < n and 0 <= v[1] < n and land(*v):
                    moves.append((v, None))
            if diagonals:
                for dx, dy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
                    xx, yy = x + dx, y + dy
                    if not (0 <= xx < n and 0 <= yy < n and land(xx, yy) and int(level[yy, xx]) == L):
                        continue
                    if fb is not None and fb[yy, xx]:
                        continue
                    E = None
                    for ex, ey in ((x + dx, y), (x, y + dy)):
                        if (0 <= ex < n and 0 <= ey < n and land(ex, ey)
                                and int(level[ey, ex]) == L
                                and (fb is None or not fb[ey, ex])):
                            E = (ex, ey)
                            break
                    if E is not None:
                        moves.append(((xx, yy), E))
            for (xx, yy), E in moves:
                step = 1.4142 if E is not None else 1.0
                w = step
                if mat[yy, xx] == "lightdark_dirt":
                    w -= DIRT_BONUS * step
                w += WANDER_AMP * float(wf[yy, xx]) * step
                w += float(wc[yy, xx]) * step
                if E is not None:
                    w += float(wc[E[1], E[0]])
                if ra is not None:
                    b = (ROAD_ATTRACT_R + 1 - int(ra[yy, xx])) / (ROAD_ATTRACT_R + 1)
                    if b > 0:
                        w -= ROAD_MAGNET * b * step
                w = max(0.05, w)
                nd = dd + w
                if nd < dist.get((xx, yy), 1e18):
                    dist[(xx, yy)] = nd
                    parent[(xx, yy)] = (x, y)
                    elbow[(xx, yy)] = E
                    heapq.heappush(pq, (nd, xx, yy))
        return dist, parent, elbow

    def _road_path(self, a, b):
        """Two-pass routing: first with the HARD beach keep-out (the padding rule — a road must
        never run close enough to sand to squeeze a 1-tile grass sliver), falling back to the
        soft-penalty-only graph when the hard pass can't reach (a target inside the margin)."""
        for fb in (getattr(self, "_sand_forbid", None), None):
            self._road_forbid = fb
            dist, parent, elbow = self._road_graph_bfs(a)
            self._road_forbid = None
            if b in dist:
                path, cur = [], b
                while cur != a:
                    path.append(cur)
                    e = elbow.get(cur)
                    if e is not None:
                        path.append(e)
                    cur = parent[cur]
                path.append(a)
                return path
        return []

    def _jitter_waypoints(self, a, b, reach, k=3, amp=0.10):
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
        if not road or dest in road:
            return []
        for fb in (getattr(self, "_sand_forbid", None), None):   # hard beach padding, then soft
            self._road_forbid = fb
            dist, parent, elbow = self._road_graph_bfs(list(road))
            self._road_forbid = None
            if dest in dist:
                path, cur = [], dest
                while cur not in road:
                    path.append(cur)
                    e = elbow.get(cur)
                    if e is not None:
                        path.append(e)
                    cur = parent[cur]
                path.append(cur)
                return path
        return []

    def _dirt_roads(self):
        """An 8-direction MEANDERING, BRANCHING dirt trunk (the ALttP red path): a wander-
        biased trunk spawn->summit through jittered waypoints, landmark + stair-foot SPURS that
        fork at Y-junctions, held a margin off the beach/water and the mountain foot and biased
        to corridor centres. Widened ~2-3 on flats off the beach; mat-only (grass->dirt only,
        never sand/stone), reserved, occlusion-safe (trailing _lip_cover)."""
        n, mat, level = self.n, self.mat, self.level
        self._road_forbid = None
        dist0, _, _ = self._road_graph_bfs(self.spawn)
        reach = set(dist0)
        if not reach:
            return
        d2edge = self._dist_field((mat == "clear_water") | (mat == "light_sand"), cap=8)
        # PADDING vs the beach (maintainer: ground types must never change dirt->grass->sand in
        # 2 tiles): dirt may never come within 2 cells of sand, so the grass band between a road
        # and a beach is always >=2 wide and no tile needs transitions to two different grounds.
        # Enforced three ways: a HARD routing keep-out (with soft fallback so no target is ever
        # unreachable), the widen margin, and a final paint skip for fallback remnants.
        self._sand_forbid = _dilate8(mat == "light_sand", 2)   # Chebyshev: covers diagonals

        def near(fx, fy):
            tx, ty = self._to_grid(fx, fy)
            return min(reach, key=lambda c: (c[0] - tx) ** 2 + (c[1] - ty) ** 2, default=None)

        up = [c for c in reach if self.upper[c[1], c[0]]]
        summit = max(up, key=lambda c: int(level[c[1], c[0]])) if up else None
        road = set()
        if summit:
            # The trunk climbs the PRIMARY Trollstigen (maintainer: the zigzag is a ROAD):
            # via-points foot -> entry force the route up the structure's own legs.
            via = [c for pair in self._troll_ends[:1] for c in pair if c in reach]
            chain = ([self.spawn] + self._jitter_waypoints(self.spawn, summit, reach, k=3)
                     + via + [summit])
            cur = chain[0]
            for w in chain[1:]:
                seg = self._road_path(cur, w)
                if seg:
                    road.update(seg)
                    cur = w
        if not road:
            road = {self.spawn}
        self._set_road_now(road)                         # magnet: later spurs Y-merge onto this
        targets = [near(fx, fy) for fx, fy in
                   ((0.50, 0.62), (0.30, 0.74), (0.62, 0.86), (0.76, 0.62),
                    (0.15, 0.58), (0.85, 0.60), (0.66, 0.40))]
        # Spur ONLY to the primary Trollstigen's foot: a dirt stub at the unpainted
        # secondary's base read as orphaned debris (verify judges 2026-07-22).
        for (fx, fy) in dict.fromkeys(self.road_feet[:1]):
            targets.append(min(reach, key=lambda c: (c[0] - fx) ** 2 + (c[1] - fy) ** 2, default=None))
        for dk in self.decks:                            # to each bridge's banks -> roads cross it
            xs = [c[0] for c in dk["cells"]]
            x0, x1 = min(xs), max(xs)
            rows = sorted({c[1] for c in dk["cells"]})
            r = rows[len(rows) // 2]
            for bx in (x0 - 1, x1 + 1):
                targets.append(min(reach, key=lambda c: (c[0] - bx) ** 2 + (c[1] - r) ** 2, default=None))
        sx, sy = self.spawn
        targets = [t for t in dict.fromkeys(targets) if t is not None]
        targets.sort(key=lambda c: (c[0] - sx) ** 2 + (c[1] - sy) ** 2)   # grow outward
        for d in targets:
            if d in road:
                continue
            spur = self._road_attach(d, road)
            if len(spur) >= 2:
                road.update(spur)
                self._set_road_now(road)                 # rebuild magnet after each spur
        self._road_now = self._road_attract = None
        # Materials the road may PAVE (turn to dirt). GRASS ONLY (maintainer 2026-07-22: "if you
        # can't make the road as wide as it needs to be — don't make a road at that location at
        # all"): dirt over stone/snow/obsidian renders as patchy eroded stains in this tileset,
        # so a mountain-cap road never FEELS like the solid lowland band no matter how many
        # cells wide it is painted. Roads therefore live where they render solid — on grass —
        # and the mountain is traversed by its stairs and open benches; road spurs still lead
        # to every staircase foot at the mountain base.
        PAVE = ("saturated_grass", "lightdark_dirt")
        # SCREEN-VERTICAL runs (grid (1,1) steps) must NOT widen: for them the two toward-camera
        # directions are lateral LEFT and RIGHT, so widening fattened the road on BOTH flanks on
        # top of the elbow that already doubles it (4 strands ~160px vs the approved 3-strand
        # ~60px horizontal road — the maintainer's width complaint). The (1,1) chain + its elbow
        # alone is the slim 2-strand vertical road that matches. Mark chain cells AND elbows.
        vert = set()
        for (x, y) in road:
            if (x + 1, y + 1) in road:
                for ex, ey in ((x + 1, y), (x, y + 1)):
                    if (ex, ey) in road:
                        vert.update(((x, y), (x + 1, y + 1), (ex, ey)))
        wide = set(road)
        for (x, y) in road:
            if (x, y) in vert:                           # vertical run: elbow IS the width
                continue
            for ax, ay in ((1, 0), (0, 1)):              # per axis: toward camera, ELSE up-screen
                for sgn in (1, -1):
                    # On a mountain bench rim the toward-camera side is the CLIFF (level differs),
                    # which left mountain roads 1 cell wide (maintainer: same road width applies
                    # regardless of elevation) — so fall back to the up-screen strand there.
                    i, j = ax * sgn, ay * sgn
                    xx, yy = x + i, y + j
                    if not (0 <= xx < n and 0 <= yy < n and (xx, yy) in reach
                            and int(level[yy, xx]) == int(level[y, x])
                            and mat[yy, xx] in PAVE
                            and ((xx, yy) not in self._ascent or (xx, yy) in self._troll_road)
                            and d2edge[yy, xx] > ROAD_BEACH_MARGIN
                            and not self._sand_forbid[yy, xx]):
                        continue
                    if (xx + i, yy + j) in road:          # gap between two parallel strands -> skip
                        continue
                    wide.add((xx, yy))
                    break                                 # one strand per axis

        def _can_pave(xx, yy, rx, ry):
            return (0 <= xx < n and 0 <= yy < n and (xx, yy) in reach
                    and int(level[yy, xx]) == int(level[ry, rx])
                    and mat[yy, xx] in PAVE
                    and ((xx, yy) not in self._ascent or (xx, yy) in self._troll_road)
                    and d2edge[yy, xx] > ROAD_BEACH_MARGIN
                    and not self._sand_forbid[yy, xx])

        # WIDTH NORMALIZER (maintainer: same road width regardless of elevation). The widen
        # above is opportunistic, so segment width varied 2-3 with local luck — on a bench that
        # read as a thinner road than the approved 3-strand lowland look. Enforce a MINIMUM of
        # 3 strands across every LINEAR run (along-run >= 3 and wider than the cross run — end
        # caps and junction blobs excluded; screen-vertical runs keep their approved 2-column
        # elbow form), trying toward-camera first, then up-screen, same paint rules, and still
        # skipping 1-cell gaps to parallel strands so close switchback legs never merge.
        for _pass in range(3):
            grown = False
            for (x, y) in sorted(wide):
                if (x, y) in vert:
                    continue
                runs = {}
                for ax, ay in ((1, 0), (0, 1)):
                    w = 1
                    for sgn in (1, -1):
                        k = 1
                        while (x + ax * sgn * k, y + ay * sgn * k) in wide:
                            w += 1
                            k += 1
                    runs[(ax, ay)] = w
                (wax, way) = min(runs, key=runs.get)      # the cross (width) axis
                if runs[(wax, way)] >= 3 or max(runs.values()) < 3:
                    continue                              # wide enough / an end cap or blob
                for sgn in (1, -1):
                    i, j = wax * sgn, way * sgn
                    xx, yy = x + i, y + j
                    if (xx, yy) in wide or not _can_pave(xx, yy, x, y):
                        continue
                    if (xx + i, yy + j) in wide:          # would bridge to a parallel strand
                        continue
                    wide.add((xx, yy))
                    grown = True
                    break
            if not grown:
                break
        for (x, y) in wide:
            # The Trollstigen is a ROAD: on the structure the route paints STONE
            # (maintainer 2026-07-22: "should have been in stone and not dirt") — a paved
            # mountain road, linework-exempt like the stripes; off the structure the
            # lowland road stays dirt. PAVE keeps both grass-only; sand padding holds.
            if mat[y, x] in PAVE and not self._sand_forbid[y, x]:
                if (x, y) in self._troll_road:
                    mat[y, x] = "stone_mountain"
                    self._linework.add((x, y))
                elif (x, y) not in self._ascent:
                    mat[y, x] = "lightdark_dirt"
            self.reserved.add((x, y))
        # SOLID Trollstigen ribbon: if the route painted any cell of a leg's band-column,
        # pave the whole column — the zip parity otherwise leaves a paved/grass
        # checkerboard whose transition tiles smear the face at map scale.
        cols_hit = {self._troll_band[c] for c in self._troll_road
                    if c in self._troll_band and mat[c[1], c[0]] == "stone_mountain"}
        for c in self._troll_road:
            if self._troll_band.get(c) in cols_hit:
                x, y = c
                if mat[y, x] in PAVE and not self._sand_forbid[y, x]:
                    mat[y, x] = "stone_mountain"
                    self._linework.add((x, y))
                    self.reserved.add((x, y))
        self.roads = {(x, y) for (x, y) in wide if mat[y, x] == "lightdark_dirt"}
        self._linework.update(self.roads)
        self._lip_cover()

    # -- NEW RULE: ground types never change "this fast" (no transition slivers) --

    def _material_slivers(self):
        """Cells that break the maintainer's rule (2026-07-22): a ground tile may border at most
        ONE foreign ground type, because a tile can only carry a transition to a single partner —
        a 1-tile grass strip between dirt and sand needs transitions to BOTH on one tile and
        renders broken. Water/void neighbours are exempt (shore transitions are first-class and
        every approved beach has sand touching grass on one side and water on the other). ROAD
        cells are exempt AS SUBJECTS: where a road crosses a biome boundary some tile must border
        both biomes — topologically unavoidable — and the road's own dirt is the least-bad place
        for it (dirt contrasts with everything it crosses); road cells still count as a FOREIGN
        type for their neighbours, which keeps the original dirt-grass-sand sliver illegal."""
        n = self.n
        gs = set(GROUND_MATS)
        out = []
        for y in range(n):
            for x in range(n):
                m = self.mat[y, x]
                if (m not in gs or m == "lightdark_dirt"    # all dirt = infrastructure
                        or (x, y) in self.roads or (x, y) in self._linework
                        or (x, y) in self._ascent):         # stairs too: local-ground line
                    continue
                foreign = set()
                for i in (-1, 0, 1):
                    for j in (-1, 0, 1):
                        if i == 0 and j == 0:
                            continue
                        xx, yy = x + i, y + j
                        if 0 <= xx < n and 0 <= yy < n:
                            fm = self.mat[yy, xx]
                            # The FULL 8-neighbourhood pairs for transitions (the auto-tiler
                            # measures composition over all 8 — a diagonal foreign breaks a tile
                            # exactly like a cardinal one). Only NEAR-LEVEL neighbours count:
                            # across a cliff (|Δlevel|>1) the wall face renders between the two
                            # tops, so they never blend. INFRASTRUCTURE is an overlay, never a
                            # terrain partner: where a road or stair strip crosses a biome
                            # boundary its flank cells unavoidably see line+other (the same
                            # forcing as the line cell itself); the maintainer's dirt-grass-sand
                            # beach case is guarded STRUCTURALLY by the Chebyshev padding rule
                            # instead (no dirt within Chebyshev 2 of sand — build asserts,
                            # unconditionally).
                            if (fm in gs and fm != m and fm != "lightdark_dirt"
                                    and (xx, yy) not in self._ascent
                                    and abs(int(self.level[yy, xx]) - int(self.level[y, x])) <= 1):
                                foreign.add(fm)
                if len(foreign) >= 2:
                    out.append((x, y, m, tuple(sorted(foreign))))
        return out

    def _fix_material_slivers(self, max_pass=80):
        """Repair pass for _material_slivers, by THICKENING: assign each violating cell the 3x3
        MAJORITY ground material (own material included; deterministic tie-break by GROUND_MATS
        order). Absorbing a sliver into one neighbour merely SHIFTS a three-region junction — at
        any point where three grounds all pairwise touch, some cell borders two foreigners — but
        majority smoothing widens the middle band to >=2 cells, which is exactly the maintainer's
        padding rule and the only stable shape. mat-only — walkability/levels untouched; a
        repainted dirt cell leaves self.roads; ends with _lip_cover since materials moved."""
        n = self.n
        gs = set(GROUND_MATS)
        prio = {m: k for k, m in enumerate(GROUND_MATS)}
        # dirt NEVER occurs naturally in this generator — every dirt cell is infrastructure
        # (roads, fords, stripe fallbacks), i.e. linework: exempt subject, flanks flip aside
        for (yy, xx) in np.argwhere(self.mat == "lightdark_dirt"):
            self._linework.add((int(xx), int(yy)))
        for _round in range(6):
            self._sliver_passes(max_pass, gs, prio)
            self._lip_cover()                    # may paint NEW stripes -> new junctions...
            if not self._material_slivers():     # ...so iterate the PAIR to a joint fixpoint
                break

    def _sliver_passes(self, max_pass, gs, prio):
        n = self.n
        for _ in range(max_pass):
            viol = self._material_slivers()
            if not viol:
                break
            progressed = False
            for (x, y, m, _f) in viol:
                # Count the 8-neighbour foreign grounds, split into TERRAIN cells and LINEWORK
                # cells (roads/stripes). A violated flank beside a line crossing flips to the
                # DOMINANT TERRAIN side — pushing the biome boundary one cell off the line, a
                # stable shape — never into the line itself: absorbing flanks into dirt/stripe
                # material snowballed the road across the whole summit patchwork.
                tvotes, lvotes = {}, {}
                for i in (-1, 0, 1):
                    for j in (-1, 0, 1):
                        xx, yy = x + i, y + j
                        if 0 <= xx < n and 0 <= yy < n:
                            fm = self.mat[yy, xx]
                            if fm in gs and fm != m:
                                if (xx, yy) in self._linework or (xx, yy) in self.roads:
                                    lvotes[fm] = lvotes.get(fm, 0) + 1
                                else:
                                    tvotes[fm] = tvotes.get(fm, 0) + 1
                tvotes.pop("lightdark_dirt", None)        # dirt is infrastructure, not terrain
                if tvotes:
                    best = sorted(tvotes.items(), key=lambda kv: (-kv[1], prio[kv[0]]))[0][0]
                elif lvotes:                              # enclosed by linework only: join it
                    best = sorted(lvotes.items(), key=lambda kv: (-kv[1], prio.get(kv[0], 99)))[0][0]
                else:
                    continue
                self.mat[y, x] = best
                if best != "lightdark_dirt":
                    self.roads.discard((x, y))
                progressed = True
            if not progressed:
                break

    def _trap_count(self):
        comps = self._walk_components()
        if len(comps) <= 1:
            return 0
        mainset = set(comps[0])
        return sum(len(c) for c in comps[1:]
                   if any((x + i, y + j) in mainset for (x, y) in c
                          for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1))))

    # -- prop-aware reachability -----------------------------------------------

    def _reach_blocked(self, blocked):
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


def build(out=None, seed=21, M=24):
    d = Island2(seed=seed, M=M)
    n = d.n
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
    viol = occlusion_violations(d.mat, d.level)   # raw same-material lips (legible ones ALLOWED)
    bad = d._bad_lips()                           # illegible ones — these must be zero
    assert not bad, f"camera-facing rule broken (illegible lips): {bad[:5]}"

    upper_land = int((d.upper & (d.mat != "clear_water")).sum())
    maze_land = int((d.maze & (d.mat != "clear_water")).sum())
    assert maze_land >= 1.6 * upper_land, \
        f"maze not dominant: maze {maze_land} < 1.6 * upper {upper_land}"

    assert int(d.level.max()) >= 36, f"mountain too short/flat: max level {int(d.level.max())}"

    M = d.M
    land_mask = (d.mat != "") & (d.mat != "clear_water")
    border = np.zeros((n, n), bool)
    border[:M, :] = border[-M:, :] = border[:, :M] = border[:, -M:] = True
    assert int((land_mask & border).sum()) == 0, "island touches map border (no water margin)"

    assert all(d.mat[y, x] != "light_sand" for (x, y) in d.roads), \
        "a road cell is on sand (beach margin broken)"

    walk = land_mask
    land_cells = int(walk.sum())
    propmask = np.zeros((n, n), bool)
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
        ys = [c[1] for c in dk["cells"]]
        x0, x1, y0, y1, dlv = min(xs), max(xs), min(ys), max(ys), dk["level"]
        if x1 - x0 >= y1 - y0:                # horizontal span: banks sit E/W of every row
            for r in sorted(set(ys)):
                for bx in (x0 - 1, x1 + 1):
                    assert (d.mat[r, bx] not in ("", "clear_water")
                            and abs(int(d.level[r, bx]) - dlv) <= 1
                            and (bx, r) in mainset), f"bridge end not walkable at ({bx},{r})"
        else:                                  # vertical span: banks sit N/S of every column
            for c in sorted(set(xs)):
                for by in (y0 - 1, y1 + 1):
                    assert (d.mat[by, c] not in ("", "clear_water")
                            and abs(int(d.level[by, c]) - dlv) <= 1
                            and (c, by) in mainset), f"bridge end not walkable at ({c},{by})"

    slivers = d._material_slivers()
    assert not slivers, f"material sliver (tile borders 2+ foreign grounds): {slivers[:5]}"
    sand_halo = _dilate8(d.mat == "light_sand", 2)
    near_sand_dirt = int(((d.mat == "lightdark_dirt") & sand_halo).sum())
    assert near_sand_dirt == 0, \
        f"beach padding broken: {near_sand_dirt} dirt cell(s) within Chebyshev 2 of sand"
    both = _dilate8(d.mat == "lightdark_dirt", 1) & _dilate8(d.mat == "light_sand", 1)
    both &= (d.mat != "") & (d.mat != "clear_water")
    assert int(both.sum()) == 0, \
        f"{int(both.sum())} tile(s) see BOTH dirt and sand in their 8-neighbourhood"

    # the massif gorge crossing must have shipped (maze-river decks sit at bank level <=12)
    gorge_bridges = [dk for dk in d.decks if dk["kind"] == "bridge" and int(dk["level"]) >= 16]
    assert gorge_bridges, "mountain gorge bridge missing (concern 4 failed to commit at this seed)"

    # HUG INVARIANT (maintainer 2026-07-22): on the Trollstigen you can only fall OUTWARDS —
    # neither up-screen neighbour (x-1,y)/(x,y-1) of a structure cell may be a drop of >=2
    # (it must be road, wall, or within one level). Hairpin noses exempt: the pad's outer
    # half hangs free like a real switchback nose.
    assert d._troll, "no Trollstigen was carved (toe descent missing)"
    hug_bad = []
    for (x, y) in d._troll - d._troll_pads:
        lv_ = int(d.level[y, x])
        if lv_ <= d._troll_floor.get((x, y), -1) or lv_ >= d._troll_top.get((x, y), 99):
            continue        # flush with a natural tier (entry/landing) = ordinary ground;
                            # the strict only-outward law governs the ELEVATED ramp between
        for wx, wy in ((x - 1, y), (x, y - 1)):
            if not (0 <= wx < n and 0 <= wy < n) or d.mat[wy, wx] in ("", "clear_water") \
                    or int(d.level[wy, wx]) < int(d.level[y, x]) - 1:
                hug_bad.append((x, y, wx, wy))
    assert not hug_bad, f"Trollstigen hug broken (inward drop) at {hug_bad[:6]}"

    # NO TRADITIONAL STAIRCASES (maintainer 2026-07-23: "this was your goal — remove the
    # need for a traditional staircase up towards high elevations"): every ascent cell
    # belongs to a Trollstigen; a straight _carve_connector may not ship.
    straight = d._ascent - d._troll
    assert not straight, \
        f"traditional staircase cells remain ({len(straight)}): {sorted(straight)[:5]}"
    assert d._troll_fallbacks == 0, \
        f"{d._troll_fallbacks} straight-connector fallback(s) used"

    print(f"the_island2 {n}x{n} (M={M}): {len(d.props)} props; max level {int(d.level.max())}; "
          f"switchbacks {d._nswitch}/{STAIR_CORRIDORS} corr; ascent {len(d._ascent)}; road {len(d.roads)}")
    print(f"  zones: upper(mtn) {upper_land} land, maze {maze_land} land "
          f"(maze/upper = {maze_land / max(1, upper_land):.2f}x)")
    print(f"  occlusion lips: {len(viol)} legible allowed / {len(bad)} illegible "
          f"{'[CLEAN]' if not bad else bad[:3]}; material slivers {len(slivers)}")
    print(f"  reachable (prop-aware) {reach}/{land_cells} land "
          f"({unreachable} water-locked islet); traps {traps}; decks {len(d.decks)}")
    print(f"  walkable components (top 6 sizes): {[len(c) for c in comps[:6]]}")
    print(f"  materials=" + ", ".join(f"{k.split('_')[0]}:{v}" for k, v in terr.most_common()))
    return d


if __name__ == "__main__":
    build()
