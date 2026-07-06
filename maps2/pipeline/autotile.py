"""Seamless multi-material auto-tiler for maps2 worlds.

Given a per-cell material grid, assign every cell a top-surface tile so material
borders are seamless and read as a gentle gradient — the same technique proven
in trans_demo, generalised from one A/B circle to an arbitrary map of many
materials:

  * CORNER-CODE WANG. A shared corner lattice is filled by PRIORITY: each corner
    point takes the highest-priority material among the (up to 4) cells touching
    it, so the harder material claims the seam and the softer one hosts the blend
    (one-sided feather). Neighbours share corner points, so a cell placed to match
    its own 4 corners agrees with its neighbours by construction.
  * EDGE-PROFILE SEAM MATCHING. Among the tiles matching a cell's corner code we
    pick, in scanline order, the one whose shared edges best fit already-placed
    neighbours (edges compared as actual materials, so it works across differing
    material pairs). Horizontal mirrors are allowed to complete the tile set.
  * SPARSE FADE. Either side of a border, a few interior-island tiles (border all
    one material, a patch of the other inside) are dropped as accents — dense-ish
    at the seam, thinning out — so the change eases in and out instead of snapping.

Independent of elevation: the caller stacks cliff faces itself; this only picks
the walkable top tile. Produces `top` (tile path per cell) and `mirror` (flip
flag per cell) grids for the caller to store/render.
"""

from __future__ import annotations

import numpy as np

from tiles2lib import EDGE_K, Tiles2

# hardness order: higher wins the seam (claims corners); void is -1
PRIORITY = {"saturated_grass": 0, "lightdark_dirt": 1, "regular_snow": 2,
            "stone_mountain": 3, "black_mountain": 4, "clear_water": 5,
            "crystal_ice": 6}

EDGES = ("NE", "SE", "SW", "NW")


def _h01(x, y, s):
    h = (int(x) * 374761393 + int(y) * 668265263 + s * 362437) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


def flatten_shores(mat, level, water=("clear_water",), band=3, ramp=1):
    """Bring the coast down to the waterline so land can *transition* into water
    instead of dropping a cliff into it. Water sits at level 0; a bare sea-cliff
    happens when the land touching it stands a level or more above. So we cap land
    height by distance to the nearest water: the first land ring (dist 1) is pulled
    to water level, the next to <=ramp, and so on for `band` cells — a beach that
    ramps up into the terrain. Only coastal cells are touched (inland is farther
    than `band` and untouched). Mutates and returns `level`.

    Do this BEFORE auto-tiling so the shore reads flat and a beach tile is placed;
    render from the same, lowered levels so it actually sits at the waterline."""
    from collections import deque
    H, W = mat.shape
    ws = set(water)
    INF = 1 << 30
    dist = np.full((H, W), INF, np.int32)
    dq = deque()
    for y in range(H):
        for x in range(W):
            if mat[y, x] in ws:
                dist[y, x] = 0
                dq.append((x, y))
    while dq:
        x, y = dq.popleft()
        if dist[y, x] >= band:            # only need the coastal band
            continue
        for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            xx, yy = x + i, y + j
            if 0 <= xx < W and 0 <= yy < H and dist[yy, xx] > dist[y, x] + 1:
                dist[yy, xx] = dist[y, x] + 1
                dq.append((xx, yy))
    for y in range(H):
        for x in range(W):
            m = mat[y, x]
            if m == "" or m in ws:
                continue
            d = int(dist[y, x])
            if 1 <= d <= band:
                cap = (d - 1) * ramp
                if level[y, x] > cap:
                    level[y, x] = cap
    return level


class AutoTiler:
    def __init__(self, mat, lib: Tiles2, seed: int, *, priority=None, level=None,
                 water=("clear_water",), fade_width: int = 5,
                 fade_density: float = 0.22, other_max: float = 0.30,
                 plain_prob: float = 0.82, special_prob: float = 0.12):
        self.mat = mat
        self.lib = lib
        self.seed = seed
        self.prio = priority or PRIORITY
        # Water sits at its own (low) level and land rises to cliffs above it, so a
        # tile containing water must never be raised onto elevated land. `level`
        # lets the tiler drop the water blend wherever the land is above the water.
        self.level = level if level is not None else np.zeros(mat.shape, np.int16)
        self.water = set(water)
        self.fw = fade_width
        self.fd = fade_density
        self.om = other_max
        self.plain_prob = plain_prob
        self.special_prob = special_prob
        self.H, self.W = mat.shape
        self.top = np.full((self.H, self.W), None, object)
        self.mirror = np.zeros((self.H, self.W), bool)
        self.edges = np.full((self.H, self.W), None, object)  # 4 material tuples
        self._wcache: dict = {}
        self._fcache: dict = {}
        self._corner_field()
        self._assign()

    def _p(self, m):
        return self.prio.get(m, -1)

    # -- corner lattice --------------------------------------------------------

    def _corner_field(self):
        """corner[b][a] = material at lattice point (a-0.5, b-0.5), the highest
        PRIORITY among the four cells meeting there. Shared by neighbours."""
        H, W = self.H, self.W
        corner = np.full((H + 1, W + 1), "", object)
        m, lvl = self.mat, self.level
        for b in range(H + 1):
            for a in range(W + 1):
                quad = [(ox, oy) for ox, oy in
                        ((a - 1, b - 1), (a, b - 1), (a - 1, b), (a, b))
                        if 0 <= ox < W and 0 <= oy < H and m[oy, ox] != ""]
                # a corner sitting where land rises ABOVE the water is a cliff edge,
                # not a shore: water may not claim it (else its tile lifts onto the
                # cliff). Exclude water there so the land owns the top surface.
                land = [(x, y) for x, y in quad if m[y, x] not in self.water]
                wat = [(x, y) for x, y in quad if m[y, x] in self.water]
                drop_water = (land and wat
                              and max(lvl[y, x] for x, y in land)
                              > max(lvl[y, x] for x, y in wat))
                best, bp = "", -2
                for x, y in quad:
                    if drop_water and m[y, x] in self.water:
                        continue
                    if self._p(m[y, x]) > bp:
                        bp, best = self._p(m[y, x]), m[y, x]
                corner[b, a] = best
        self.corner = corner

    def _corners(self, x, y):
        c = self.corner
        return (c[y, x], c[y, x + 1], c[y + 1, x + 1], c[y + 1, x])  # N, E, S, W

    # -- candidate caches ------------------------------------------------------

    def _wang(self, hi, lo):
        k = (hi, lo)
        if k not in self._wcache:
            table = self.lib.wang(hi, lo)
            # pre-convert each candidate's edge bits (1=hi) into material tuples
            for cands in table.values():
                for cd in cands:
                    cd["medges"] = {e: tuple(hi if v == 1 else lo for v in cd["edges"][e])
                                    for e in EDGES}
            self._wcache[k] = table
        return self._wcache[k]

    def _fade_band(self, hi, lo):
        k = (hi, lo)
        if k not in self._fcache:
            band = self.lib.fade_tiles(hi, lo)[0]     # hi border, lo interior
            omax = min(self.om, max((t["other"] for t in band), default=0.0))
            self._fcache[k] = (band, omax)
        return self._fcache[k]

    # -- assignment ------------------------------------------------------------

    def _assign(self):
        H, W = self.H, self.W
        # cells within fade_width of a material border get the sparse island fade
        m = self.mat
        diff = np.zeros((H, W), bool)
        diff[:, :-1] |= (m[:, :-1] != m[:, 1:]) & (m[:, :-1] != "") & (m[:, 1:] != "")
        diff[:, 1:] |= (m[:, 1:] != m[:, :-1]) & (m[:, 1:] != "") & (m[:, :-1] != "")
        diff[:-1, :] |= (m[:-1, :] != m[1:, :]) & (m[:-1, :] != "") & (m[1:, :] != "")
        diff[1:, :] |= (m[1:, :] != m[:-1, :]) & (m[1:, :] != "") & (m[:-1, :] != "")
        near = diff.copy()                       # dilate by fade_width (Manhattan)
        for _ in range(self.fw):
            nn = near.copy()
            nn[:, :-1] |= near[:, 1:]; nn[:, 1:] |= near[:, :-1]
            nn[:-1, :] |= near[1:, :]; nn[1:, :] |= near[:-1, :]
            near = nn

        cells = [(x, y) for y in range(H) for x in range(W) if m[y, x] != ""]
        cells.sort(key=lambda p: (p[0] + p[1], p[0]))
        for x, y in cells:
            mm = m[y, x]
            corners = self._corners(x, y)
            highs = [c for c in corners if c not in ("", mm) and self._p(c) > self._p(mm)]
            if highs:
                o = max(highs, key=self._p)                    # the harder neighbour
                code = tuple(1 if c == o else 0 for c in corners)
                self.top[y, x], self.mirror[y, x], self.edges[y, x] = \
                    self._pick(o, mm, code, x, y)
            else:
                self.top[y, x], self.mirror[y, x], self.edges[y, x] = \
                    self._interior(mm, x, y, near[y, x])

    def _pick(self, hi, lo, code, x, y):
        table = self._wang(hi, lo)
        cands = table.get(code)
        if not cands:
            cands = table[min(table, key=lambda k: (
                sum(a != b for a, b in zip(k, code)), -table[k][0]["conf"]))]
        jit = _h01(x, y, self.seed + 3)
        c = min(cands, key=lambda cd: (self._seam(cd["medges"], x, y), -cd["conf"], jit))
        return c["file"], c["mirror"], c["medges"]

    def _seam(self, medges, x, y):
        cost = 0
        nb = self.edges[y - 1, x] if y - 1 >= 0 else None      # NE meets SW rev
        if nb is not None:
            cost += sum(a != b for a, b in zip(medges["NE"], reversed(nb["SW"])))
        nb = self.edges[y, x - 1] if x - 1 >= 0 else None      # NW meets SE rev
        if nb is not None:
            cost += sum(a != b for a, b in zip(medges["NW"], reversed(nb["SE"])))
        return cost

    def _interior(self, mm, x, y, near):
        pure = {e: (mm,) * EDGE_K for e in EDGES}
        if near:
            o, dd, olvl = self._nearest_other(mm, x, y)
            # never fade water UP onto higher ground — that raises the water
            water_uphill = o in self.water and self.level[y, x] > olvl
            if o is not None and dd <= self.fw and not water_uphill:
                f = dd / self.fw                               # 0 at seam .. 1 out
                if _h01(x, y, self.seed + 7) <= self.fd * (1.0 - f):
                    band, omax = self._fade_band(mm, o)
                    if len(band) > 1:
                        t = omax * (1.0 - f) + (_h01(x, y, self.seed + 5) - 0.5) * 0.05
                        near_o = min(abs(c["other"] - t) for c in band[1:])
                        pool = [c for c in band[1:] if abs(c["other"] - t) <= near_o + 0.04]
                        c = pool[int(_h01(x, y, self.seed + 6) * len(pool)) % len(pool)]
                        return c["file"], c["mirror"], pure
        # plain ground with the usual rare clean/special variation
        p = self.lib.pick_base(mm, _h01(x, y, self.seed + 4), _h01(x, y, self.seed + 2),
                               _h01(x, y, self.seed + 1),
                               plain_prob=self.plain_prob, special_prob=self.special_prob)
        return p, False, pure

    def _nearest_other(self, mm, x, y):
        best_d, best_o, best_l = 1e9, None, 0
        r = self.fw
        for j in range(-r, r + 1):
            yy = y + j
            if yy < 0 or yy >= self.H:
                continue
            for i in range(-r, r + 1):
                xx = x + i
                if xx < 0 or xx >= self.W:
                    continue
                o = self.mat[yy, xx]
                if o == "" or o == mm:
                    continue
                d = (i * i + j * j) ** 0.5
                if d < best_d:
                    best_d, best_o, best_l = d, o, int(self.level[yy, xx])
        return best_o, best_d, best_l
