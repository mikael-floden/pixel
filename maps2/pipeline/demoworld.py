"""demo_isle — a small, calm, pretty island to make people want to play.

A handcrafted scene (not a test grid): a snow-capped stone mountain in the north
falling through grassy meadows to a lake and a beach in the south, a dirt path
winding up to a ruined watchtower, a forest grove, a lakeside willow, a standing-
stone circle, and a small obsidian nook to explore. Terrains fade into each other
with the tiles2 transition tiles; ground stays ~85% clean single-colour so the
deliberate landmark props (base_x_2..5) read as special. Uses props from every
terrain set.
"""

from __future__ import annotations

import json
import math
import os

import numpy as np
from PIL import Image

import worldio
from autotile import PRIORITY, AutoTiler, flatten_shores
from tiles2lib import DX, DY, LEVEL_PX, Tiles2

GROUND_BOTTOM = 54
PLAIN_PROB = 0.90
SPECIAL_PROB = 0.10

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
        ux, uy = fx*fx*(3-2*fx), fy*fy*(3-2*fy)
        v00, v10, v01, v11 = hh(ix, iy), hh(ix+1, iy), hh(ix, iy+1), hh(ix+1, iy+1)
        a = v00 + (v10-v00)*ux
        b = v01 + (v11-v01)*ux
        tot += amp * (a + (b-a)*uy)
        norm += amp
        amp *= 0.5
        s *= 0.5
    return tot / norm


class Demo:
    def __init__(self, n=104, seed=6):
        self.n, self.seed = n, seed
        self.lib = Tiles2()
        self.mat = np.full((n, n), "", object)
        self.level = np.zeros((n, n), np.int16)
        self.top = np.full((n, n), None, object)
        self.mirror = np.zeros((n, n), bool)
        self.props = {}                     # (x,y) -> prop path
        self.spawn = (n // 2, int(n * 0.72))
        self._terrain()
        self._paint()
        self._decorate()

    # -- terrain + materials ---------------------------------------------------

    def _terrain(self):
        n = self.n
        Y, X = np.mgrid[0:n, 0:n].astype(np.float32)
        cx, cy = n * 0.5, n * 0.46
        # island falloff
        d = np.hypot((X-cx)/(n*0.46), (Y-cy)/(n*0.46))
        h = (1.0 - d) * 7.0
        # a mountain massif in the north
        dm = np.hypot(X - n*0.5, Y - n*0.24)
        h += 7.5 * np.exp(-(dm/(n*0.15))**2)
        # a lake dip in the south-east meadow
        self.lake_c = (n*0.62, n*0.60, n*0.11)
        dl = np.hypot(X - self.lake_c[0], Y - self.lake_c[1])
        h -= 5.5 * np.exp(-(dl/self.lake_c[2])**2)
        # rolling terraces + coast crinkle
        h += (_fbm(X, Y, self.seed, n*0.14, 4) - 0.5) * 3.0
        h += (_fbm(X, Y, self.seed+3, n*0.05, 3) - 0.5) * 1.2
        self.h = h
        MAX = 9
        level = np.clip(np.rint(h), 0, MAX).astype(np.int16)

        mat = np.full((n, n), "", object)
        land = h > 0.9
        mat[land] = "saturated_grass"
        mat[~land] = "clear_water"
        mat[dl < self.lake_c[2]*0.92] = "clear_water"      # the lake
        # mountain stone + snow cap by height
        mat[(mat == "saturated_grass") & (level >= 5)] = "stone_mountain"
        mat[(mat != "clear_water") & (level >= 7)] = "regular_snow"
        level[mat == "clear_water"] = 0
        # a black volcanic nook in the east, buffered by dirt from the grass
        vb = np.hypot(X - n*0.86, Y - n*0.40)
        nook = (mat != "clear_water") & (vb < n*0.085)
        mat[nook] = "black_mountain"
        buf = (mat == "saturated_grass") & (vb < n*0.115)
        mat[buf] = "lightdark_dirt"

        self.mat, self.level = mat, level
        # winding dirt PATH from the beach up toward the mountain foot
        self._carve_path([(0.50, 0.70), (0.47, 0.60), (0.52, 0.50),
                           (0.49, 0.40), (0.50, 0.33)])
        # bring the coast down to the waterline so shores transition, not cliff
        flatten_shores(self.mat, self.level)

    def _carve_path(self, pts):
        n = self.n
        P = [(fx*n, fy*n) for fx, fy in pts]
        for (ax, ay), (bx, by) in zip(P, P[1:]):
            steps = int(math.hypot(bx-ax, by-ay)) + 1
            for i in range(steps+1):
                x = int(round(ax + (bx-ax)*i/steps))
                y = int(round(ay + (by-ay)*i/steps))
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        xx, yy = x+dx, y+dy
                        if 0 <= xx < n and 0 <= yy < n and self.mat[yy, xx] == "saturated_grass":
                            self.mat[yy, xx] = "lightdark_dirt"

    # -- transition auto-tiler (seamless corner+edge Wang + sparse fade) --------

    def _paint(self):
        at = AutoTiler(self.mat, self.lib, self.seed, priority=PRIORITY,
                       level=self.level,
                       plain_prob=PLAIN_PROB, special_prob=SPECIAL_PROB)
        self.top, self.mirror = at.top, at.mirror

    # -- deliberate landmark props --------------------------------------------

    def _place(self, cells, terrain, heights, count, spacing, seedoff, avoid=None):
        lib = self.lib
        pool = [p for h in heights for p in lib.elev(terrain, h)]
        if not pool or not cells:
            return
        cells = sorted(cells, key=lambda c: _h01(c[0], c[1], self.seed+seedoff))
        placed = []
        for (x, y) in cells:
            if len([1 for px, py in placed if abs(px-x) < spacing and abs(py-y) < spacing]):
                continue
            if (x, y) in self.props or (avoid and avoid(x, y)):
                continue
            p = pool[int(_h01(x, y, self.seed+seedoff+9)*len(pool)) % len(pool)]
            self.props[(x, y)] = p
            placed.append((x, y))
            if len(placed) >= count:
                break

    def _cells(self, pred):
        return [(x, y) for y in range(self.n) for x in range(self.n) if pred(x, y)]

    def _decorate(self):
        n = self.n
        mat, level = self.mat, self.level
        far_from_path = lambda x, y: mat[y, x] != "lightdark_dirt"
        g = lambda x, y: mat[y, x] == "saturated_grass"
        s = lambda x, y: mat[y, x] == "stone_mountain"
        sn = lambda x, y: mat[y, x] == "regular_snow"

        # the peak: one tall stone landmark at the very top + snow decoration
        peak = self._cells(lambda x, y: sn(x, y) and level[y, x] >= 8)
        if peak:
            top = min(peak, key=lambda c: c[1])
            self.props[top] = self.lib.elev("stone_mountain", 5)[
                int(_h01(*top, 1)*len(self.lib.elev("stone_mountain", 5)))]
        self._place(self._cells(sn), "regular_snow", [2, 3], 5, 3, 11)          # snowmen/drifts
        self._place(self._cells(sn), "regular_snow", [4], 4, 4, 12)             # snow pines
        # stone slopes: cairns, boulders, an obelisk
        self._place(self._cells(lambda x, y: s(x, y) and level[y, x] <= 6),
                    "stone_mountain", [2, 3], 6, 3, 13)
        self._place(self._cells(s), "stone_mountain", [4, 5], 2, 6, 14)
        # a FOREST GROVE in the west meadow
        grove = self._cells(lambda x, y: g(x, y) and x < n*0.32 and 0.34*n < y < 0.6*n
                            and level[y, x] <= 4)
        self._place(grove, "saturated_grass", [3, 4], 8, 2, 15, avoid=None)
        self._place(grove, "saturated_grass", [5], 3, 4, 16)
        # LAKESIDE: willow + reeds/mushrooms just around the lake
        lx, ly, lr = self.lake_c
        lakeside = self._cells(lambda x, y: g(x, y) and
                               abs(math.hypot(x-lx, y-ly) - lr) < 2.5)
        self._place(lakeside, "saturated_grass", [4], 2, 5, 17)
        self._place(lakeside, "saturated_grass", [2], 4, 3, 18)
        # a STANDING-STONE circle on a knoll east of centre
        kx, ky = int(n*0.40), int(n*0.55)
        ring = []
        for k in range(6):
            a = k*math.tau/6
            rx, ry = int(kx+3*math.cos(a)), int(ky+3*math.sin(a))
            if 0 <= rx < n and 0 <= ry < n and g(rx, ry):
                ring.append((rx, ry))
        self._place(ring, "stone_mountain", [3], 6, 1, 19)
        if g(kx, ky):
            self.props[(kx, ky)] = self.lib.elev("saturated_grass", 3)[0]
        # SPAWN beach: a couple of low props to frame the start
        sx, sy = self.spawn
        beach = self._cells(lambda x, y: g(x, y) and abs(x-sx) < 8 and abs(y-sy) < 6)
        self._place(beach, "saturated_grass", [2], 3, 3, 20)
        # VOLCANIC nook: obsidian spires
        self._place(self._cells(lambda x, y: mat[y, x] == "black_mountain"),
                    "black_mountain", [3, 4], 4, 3, 21)
        # a few lone meadow trees, sparse
        self._place(self._cells(lambda x, y: g(x, y) and level[y, x] <= 3),
                    "saturated_grass", [4, 5], 6, 6, 22)

    # -- render ----------------------------------------------------------------

    def _ymax(self, im):
        a = np.asarray(im)
        ys = np.where((a[:, :, 3] > 20).any(axis=1))[0]
        return int(ys.max()) if len(ys) else 63

    def render(self, scale=1.0):
        n = self.n
        ox = (n-1)*DX + 24
        oy = int(self.level.max())*LEVEL_PX + 150
        W = (n+n)*DX + 48
        H = (n+n)*DY + 64 + int(self.level.max())*LEVEL_PX + 220
        wc = self.lib.target_color("clear_water")
        canvas = Image.new("RGBA", (W, H), tuple(int(c) for c in wc)+(255,))
        order = sorted(((x, y) for y in range(n) for x in range(n)),
                       key=lambda p: (p[0]+p[1], p[1]))
        plaincache = {}
        for x, y in order:
            m = self.mat[y, x]
            if m == "":
                continue
            bx = ox + (x-y)*DX
            by = oy + (x+y)*DY
            L = int(self.level[y, x])
            if m not in plaincache:
                plaincache[m] = self.lib.img(self.lib.plain_tile(m))
            face = plaincache[m]
            for lvl in range(L):
                canvas.alpha_composite(face, (bx, by - lvl*LEVEL_PX))
            timg = self.lib.img(self.top[y, x])
            if self.mirror[y, x]:
                timg = timg.transpose(Image.FLIP_LEFT_RIGHT)
            canvas.alpha_composite(timg, (bx, by - L*LEVEL_PX - (timg.height-64)))
            p = self.props.get((x, y))
            if p is not None:
                pr = self.lib.img(p)
                canvas.alpha_composite(pr, (bx, (by - L*LEVEL_PX) + GROUND_BOTTOM - self._ymax(pr)))
        if scale != 1.0:
            canvas = canvas.resize((int(W*scale), int(H*scale)), Image.LANCZOS)
        return canvas


def build(out=None, n=104, seed=6):
    d = Demo(n=n, seed=seed)
    out = out or os.path.join(MAPS2, "worlds", "demo_isle")
    os.makedirs(out, exist_ok=True)
    worldio.save_world(os.path.join(out, "world.json"), name="demo_isle",
                       mat=d.mat, top=d.top, mirror=d.mirror, level=d.level,
                       spawn=d.spawn, props=d.props)
    img = d.render()
    img.convert("RGB").save(os.path.join(out, "demo.png"))
    # a capped preview for quick viewing / sharing
    w = 2200
    img.resize((w, round(img.height*w/img.width)), Image.LANCZOS).convert("RGB").save(
        os.path.join(out, "preview.png"))
    print(f"demo_isle {n}x{n}: {len(d.props)} props; wrote demo.png {img.size}")
    return d


if __name__ == "__main__":
    build()
