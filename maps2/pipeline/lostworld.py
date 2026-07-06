"""demo_lost — a lost tropical island that showcases EVERY base tile.

A grass-dominant island (the look we liked most) with room made for all the
others: a light_sand BEACH ringing the whole coast, a stone_mountain rising to a
regular_snow cap with a crystal_ice glacier set into the snow, a clear_water lake,
a winding lightdark_dirt path, and a black_mountain volcanic nook. Everything we
learned is applied: seamless corner+edge Wang transitions with a sparse fade,
solid on-target region-coherent base tiles (coherent cliff walls that vary across
the map), elevation-correct shores (beaches, never raised water), props from every
terrain set, full walkability, and a loadable world.json.
"""

from __future__ import annotations

import math
import os

import numpy as np
from PIL import Image

import worldio
from autotile import PRIORITY, AutoTiler, connect_walkable, flatten_shores
from tiles2lib import DX, DY, LEVEL_PX, Tiles2

GROUND_BOTTOM = 54
PLAIN_PROB = 0.90
SPECIAL_PROB = 0.10
SAND_W = 3                       # beach width (cells) inland from the water

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


class Lost:
    def __init__(self, n=120, seed=11):
        self.n, self.seed = n, seed
        self.lib = Tiles2()
        self.mat = np.full((n, n), "", object)
        self.level = np.zeros((n, n), np.int16)
        self.top = np.full((n, n), None, object)
        self.mirror = np.zeros((n, n), bool)
        self.props = {}
        self.spawn = (int(n * 0.5), int(n * 0.80))     # south beach
        self._terrain()
        self._paint()
        self._decorate()

    # -- terrain ---------------------------------------------------------------

    def _terrain(self):
        n = self.n
        Y, X = np.mgrid[0:n, 0:n].astype(np.float32)
        cx, cy = n * 0.5, n * 0.5
        d = np.hypot((X - cx) / (n * 0.44), (Y - cy) / (n * 0.44))
        h = (1.0 - d) * 7.0
        # stone/snow massif in the north-west
        self.peak_c = (n * 0.36, n * 0.30)
        dm = np.hypot(X - self.peak_c[0], Y - self.peak_c[1])
        h += 8.5 * np.exp(-(dm / (n * 0.17)) ** 2)
        # an inland lake in the south-east meadow (kept well clear of the coast)
        self.lake_c = (n * 0.60, n * 0.58, n * 0.075)
        dl = np.hypot(X - self.lake_c[0], Y - self.lake_c[1])
        h -= 5.0 * np.exp(-(dl / self.lake_c[2]) ** 2)
        h += (_fbm(X, Y, self.seed, n * 0.14, 4) - 0.5) * 3.0
        h += (_fbm(X, Y, self.seed + 3, n * 0.05, 3) - 0.5) * 1.2
        MAX = 10
        level = np.clip(np.rint(h), 0, MAX).astype(np.int16)

        mat = np.full((n, n), "", object)
        land = h > 0.9
        mat[land] = "saturated_grass"
        mat[~land] = "clear_water"
        mat[dl < self.lake_c[2] * 0.9] = "clear_water"      # the lake
        level[mat == "clear_water"] = 0

        # SAND beach: low land within SAND_W of any water (sea or lake)
        near_water = _dilate(mat == "clear_water", SAND_W)
        beach = near_water & (mat == "saturated_grass") & (level <= 1)
        mat[beach] = "light_sand"

        # mountain: stone slopes -> snow cap, with a crystal-ice glacier in the snow
        mat[(mat == "saturated_grass") & (level >= 5)] = "stone_mountain"
        mat[(mat == "stone_mountain") & (level >= 8)] = "regular_snow"
        di = np.hypot(X - self.peak_c[0] - n * 0.02, Y - self.peak_c[1] + n * 0.04)
        mat[(mat == "regular_snow") & (di < n * 0.055)] = "crystal_ice"

        # a black volcanic nook in the east upland, buffered by dirt from the grass
        self.nook_c = (n * 0.76, n * 0.44)
        vb = np.hypot(X - self.nook_c[0], Y - self.nook_c[1])
        buf = (mat == "saturated_grass") & (vb < n * 0.12)
        mat[buf] = "lightdark_dirt"
        nook = (mat == "lightdark_dirt") & (vb < n * 0.085)
        mat[nook] = "black_mountain"

        self.mat, self.level = mat, level
        # a dirt PATH from the south beach up toward the mountain foot
        self._carve_path([(0.50, 0.80), (0.47, 0.66), (0.44, 0.54),
                           (0.40, 0.44), (0.37, 0.38)])
        # bring the coast down to the waterline so it BEACHES, never cliffs, in
        flatten_shores(self.mat, self.level)

    def _carve_path(self, pts):
        n = self.n
        P = [(fx * n, fy * n) for fx, fy in pts]
        for (ax, ay), (bx, by) in zip(P, P[1:]):
            steps = int(math.hypot(bx - ax, by - ay)) + 1
            for i in range(steps + 1):
                x = int(round(ax + (bx - ax) * i / steps))
                y = int(round(ay + (by - ay) * i / steps))
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        xx, yy = x + dx, y + dy
                        if 0 <= xx < n and 0 <= yy < n and self.mat[yy, xx] == "saturated_grass":
                            self.mat[yy, xx] = "lightdark_dirt"

    # -- auto-tile -------------------------------------------------------------

    def _paint(self):
        at = AutoTiler(self.mat, self.lib, self.seed, priority=PRIORITY,
                       level=self.level, plain_prob=PLAIN_PROB,
                       special_prob=SPECIAL_PROB)
        self.top, self.mirror = at.top, at.mirror

    # -- props (every terrain set) ---------------------------------------------

    def _place(self, cells, terrain, heights, count, spacing, seedoff):
        lib = self.lib
        pool = [p for hh in heights for p in lib.elev(terrain, hh)]
        if not pool or not cells:
            return
        cells = sorted(cells, key=lambda c: _h01(c[0], c[1], self.seed + seedoff))
        placed = []
        for (x, y) in cells:
            if any(abs(px - x) < spacing and abs(py - y) < spacing for px, py in placed):
                continue
            if (x, y) in self.props:
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

        # PEAK: a towering stone landmark at the very top
        peak = self._cells(lambda x, y: (sn(x, y) or mat[y, x] == "crystal_ice") and level[y, x] >= 9)
        if peak:
            t = min(peak, key=lambda c: c[1])
            self.props[t] = self.lib.elev("stone_mountain", 5)[
                int(_h01(*t, 1) * len(self.lib.elev("stone_mountain", 5)))]
        # crystal ICE glacier: ice spires + crystals
        self._place(self._cells(is_m("crystal_ice")), "crystal_ice", [4, 5], 4, 2, 30)
        self._place(self._cells(is_m("crystal_ice")), "crystal_ice", [2, 3], 4, 2, 31)
        # SNOW: snowmen/drifts + snow pines
        self._place(self._cells(sn), "regular_snow", [2, 3], 6, 3, 11)
        self._place(self._cells(sn), "regular_snow", [4], 4, 4, 12)
        # STONE slopes: cairns, boulders, obelisks
        self._place(self._cells(lambda x, y: s(x, y) and level[y, x] <= 7),
                    "stone_mountain", [2, 3], 7, 3, 13)
        self._place(self._cells(s), "stone_mountain", [4, 5], 3, 5, 14)
        # GRASS: a forest grove in the east meadow + lone trees
        grove = self._cells(lambda x, y: g(x, y) and x > n * 0.6 and 0.45 * n < y < 0.7 * n
                            and level[y, x] <= 5)
        self._place(grove, "saturated_grass", [3, 4], 9, 2, 15)
        self._place(grove, "saturated_grass", [5], 3, 4, 16)
        self._place(self._cells(lambda x, y: g(x, y) and level[y, x] <= 4),
                    "saturated_grass", [4, 5], 7, 7, 17)
        # a STANDING-STONE ring on a central knoll
        kx, ky = int(n * 0.52), int(n * 0.50)
        ring = [(int(kx + 3 * math.cos(k * math.tau / 6)), int(ky + 3 * math.sin(k * math.tau / 6)))
                for k in range(6)]
        self._place([c for c in ring if 0 <= c[0] < n and 0 <= c[1] < n and g(*c)],
                    "stone_mountain", [3], 6, 1, 19)
        # LAKESIDE: willow + reeds
        lx, ly, lr = self.lake_c
        lakeside = self._cells(lambda x, y: g(x, y) and abs(math.hypot(x - lx, y - ly) - lr) < 2.5)
        self._place(lakeside, "saturated_grass", [4, 5], 3, 4, 20)
        self._place(lakeside, "saturated_grass", [2], 4, 3, 21)
        # SAND beach: palms / dune props, sparse, back from the waterline
        sand = self._cells(lambda x, y: mat[y, x] == "light_sand")
        self._place(sand, "light_sand", [3, 4], 7, 5, 22)
        self._place(sand, "light_sand", [2], 6, 4, 23)
        # BLACK nook: obsidian spires
        self._place(self._cells(is_m("black_mountain")), "black_mountain", [3, 4], 5, 3, 24)
        # DIRT path: a couple of low markers
        self._place(self._cells(is_m("lightdark_dirt")), "lightdark_dirt", [2, 3], 3, 5, 25)

    # -- render ----------------------------------------------------------------

    def _ymax(self, im):
        a = np.asarray(im)
        ys = np.where((a[:, :, 3] > 20).any(axis=1))[0]
        return int(ys.max()) if len(ys) else 63

    def render(self, scale=1.0):
        n = self.n
        ox = (n - 1) * DX + 24
        oy = int(self.level.max()) * LEVEL_PX + 150
        W = (n + n) * DX + 48
        H = (n + n) * DY + 64 + int(self.level.max()) * LEVEL_PX + 220
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
        if scale != 1.0:
            canvas = canvas.resize((int(W * scale), int(H * scale)), Image.LANCZOS)
        return canvas


def build(out=None, n=120, seed=11):
    d = Lost(n=n, seed=seed)
    out = out or os.path.join(MAPS2, "worlds", "demo_lost")
    os.makedirs(out, exist_ok=True)
    worldio.save_world(os.path.join(out, "world.json"), name="demo_lost",
                       mat=d.mat, top=d.top, mirror=d.mirror, level=d.level,
                       spawn=d.spawn, props=d.props)
    img = d.render()
    img.convert("RGB").save(os.path.join(out, "demo.png"))
    w = 2200
    img.resize((w, round(img.height * w / img.width)), Image.LANCZOS).convert("RGB").save(
        os.path.join(out, "preview.png"))
    from collections import Counter
    terr = Counter(m for m in d.mat.ravel() if m)
    print(f"demo_lost {n}x{n}: {len(d.props)} props; materials="
          + ", ".join(f"{k.split('_')[0]}:{v}" for k, v in terr.most_common()))
    return d


if __name__ == "__main__":
    build()
