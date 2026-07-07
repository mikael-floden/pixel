"""occlusion_test — tall structures to test the "fade the occluder" system.

In this iso view the camera looks from the south-east: a tile/prop at a HIGHER
(x+y) is drawn later and on top, so it hides whatever sits up-screen behind it
(lower x+y). This map gives the game a set of deliberately TALL occluders — a big
mountain, a long wall with a doorway, a hollow keep, tower clusters, and a tall
forest — each with flat, walkable, detail-filled ground to its NORTH (behind it,
up-screen). Walk the player up behind any of them and the structure should fade.

Nothing exotic in the data: terrain height is in `level`, props carry `levels`
(their base_x_N height) in world.json — enough for the game to know how tall each
occluder stands. One flat walkable field, so the player can reach behind them all.
"""

from __future__ import annotations

import math
import os

import numpy as np
from PIL import Image

import worldio
from autotile import PRIORITY, AutoTiler
from tiles2lib import DX, DY, LEVEL_PX, Tiles2

GROUND_BOTTOM = 54
PLAIN_PROB = 0.92
SPECIAL_PROB = 0.08

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)


def _h01(x, y, s):
    h = (int(x) * 374761393 + int(y) * 668265263 + s * 362437) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


class Occlude:
    def __init__(self, n=128, seed=3):
        self.n, self.seed = n, seed
        self.lib = Tiles2()
        self.mat = np.full((n, n), "saturated_grass", object)   # flat walkable field
        self.level = np.zeros((n, n), np.int16)
        self.top = np.full((n, n), None, object)
        self.mirror = np.zeros((n, n), bool)
        self.props = {}
        self.spawn = (n // 2, n - 6)                            # front (down-screen)
        self._structures()
        self._paint()
        self._decorate()

    def _wall(self, x0, y0, x1, y1, lvl, mat="stone_mountain"):
        n = self.n
        for yy in range(max(0, y0), min(n, y1)):
            for x in range(max(0, x0), min(n, x1)):
                self.mat[yy, x] = mat
                self.level[yy, x] = lvl

    # -- tall structures -------------------------------------------------------

    def _structures(self):
        n = self.n
        Y, X = np.mgrid[0:n, 0:n].astype(np.float32)

        # 1) HUGE MOUNTAIN (west): a broad stone massif to a snow cap ~28 levels
        #    tall — tall enough to fully hide a player on the grass BEHIND it, not
        #    just its snowy tip. (3x+ the old 8-level version, bigger radius too.)
        mcx, mcy = n * 0.26, n * 0.62
        dm = np.hypot(X - mcx, Y - mcy)
        mh = np.clip(28.0 - dm * 1.15, 0, 28)
        m = mh > 0.5
        self.level[m] = np.rint(mh)[m].astype(np.int16)
        self.mat[m] = "stone_mountain"
        self.mat[m & (self.level >= 18)] = "regular_snow"

        # 2) CITY WALL — a U of 10-level ramparts around a courtyard, open to the
        #    south so you walk in; props go on top (battlements) to test those too
        cwx, cwy, cw = int(n * 0.44), int(n * 0.12), 22
        self._wall(cwx, cwy, cwx + cw, cwy + 3, 10)             # north rampart
        self._wall(cwx, cwy, cwx + 3, cwy + cw, 10)            # west rampart
        self._wall(cwx + cw - 3, cwy, cwx + cw, cwy + cw, 10)  # east rampart

        # 3) LONG HIGH CLIFF WALL (centre, E-W): 14 levels, thick, with a doorway
        wy = int(n * 0.52)
        self._wall(int(n * 0.40), wy, int(n * 0.72), wy + 3, 14)
        self._wall(int(n * 0.55), wy, int(n * 0.58), wy + 3, 0, "saturated_grass")  # doorway

        # 4) TERRACED CLIFFS (east): a stepped ziggurat 5/10/16 to test walking
        #    behind stacked terraces
        tx, ty = int(n * 0.80), int(n * 0.30)
        for lvl, pad in ((5, 0), (10, 3), (16, 6)):
            self._wall(tx + pad, ty + pad, tx + 16 - pad, ty + 16 - pad, lvl)

        # 5) HOLLOW KEEP (SE): 12-level black-stone walls, room inside, south
        #    entrance; battlement props on top
        kx, ky, ks = int(n * 0.78), int(n * 0.66), 14
        for yy in range(ky, ky + ks):
            for x in range(kx, kx + ks):
                on_wall = (yy < ky + 2 or yy >= ky + ks - 2
                           or x < kx + 2 or x >= kx + ks - 2)
                if yy >= ky + ks - 2 and kx + 6 <= x <= kx + 7:   # south entrance
                    on_wall = False
                if on_wall:
                    self.mat[yy, x] = "black_mountain"
                    self.level[yy, x] = 12

        # 6) a couple of free-standing STONE WALL segments to stand behind
        self._wall(int(n * 0.30), int(n * 0.30), int(n * 0.46), int(n * 0.32), 8)
        self._wall(int(n * 0.60), int(n * 0.68), int(n * 0.62), int(n * 0.82), 9)

    # -- auto-tile -------------------------------------------------------------

    def _paint(self):
        at = AutoTiler(self.mat, self.lib, self.seed, priority=PRIORITY,
                       level=self.level, plain_prob=PLAIN_PROB,
                       special_prob=SPECIAL_PROB)
        self.top, self.mirror = at.top, at.mirror

    # -- props -----------------------------------------------------------------

    def _place(self, cells, terrain, heights, count, spacing, seedoff,
               on_ground=True):
        pool = [p for hh in heights for p in self.lib.elev(terrain, hh)]
        if not pool or not cells:
            return
        cells = sorted(cells, key=lambda c: _h01(c[0], c[1], self.seed + seedoff))
        placed = []
        for (x, y) in cells:
            if any(abs(px - x) < spacing and abs(py - y) < spacing for px, py in placed):
                continue
            if (x, y) in self.props:
                continue
            if on_ground and self.level[y, x] > 0:     # flat ground only
                continue
            self.props[(x, y)] = pool[int(_h01(x, y, self.seed + seedoff + 9) * len(pool)) % len(pool)]
            placed.append((x, y))
            if len(placed) >= count:
                break

    def _cells(self, pred):
        return [(x, y) for y in range(self.n) for x in range(self.n) if pred(x, y)]

    def _decorate(self):
        n = self.n
        flat = lambda x, y: self.mat[y, x] == "saturated_grass" and self.level[y, x] == 0

        # BATTLEMENTS: x2..x5 props ON TOP of the tall walls/cliffs — so the game
        # can check that props standing on a wall fade with it. Wall tops = the
        # stone/black cells with real elevation.
        walltop = self._cells(lambda x, y: self.level[y, x] >= 6
                              and self.mat[y, x] in ("stone_mountain", "black_mountain"))
        self._place(walltop, "stone_mountain", [2, 3], 16, 2, 50, on_ground=False)
        self._place(walltop, "stone_mountain", [4], 8, 3, 51, on_ground=False)
        self._place(walltop, "crystal_ice", [5], 5, 4, 52, on_ground=False)

        # TALL FOREST: dense giant trees (north-east), behind the cliffs
        grove = self._cells(lambda x, y: flat(x, y) and n * 0.60 < x < n * 0.78
                            and n * 0.14 < y < n * 0.34)
        self._place(grove, "saturated_grass", [5], 12, 2, 41)
        self._place(grove, "saturated_grass", [4], 7, 3, 42)
        # CRYSTAL SPIRES on the ground, centre-north
        spires = self._cells(lambda x, y: flat(x, y) and n * 0.30 < x < n * 0.42
                            and n * 0.14 < y < n * 0.28)
        self._place(spires, "crystal_ice", [5, 4], 5, 3, 43)
        # DETAIL to see behind the occluders: bushes/flowers scattered up-screen
        behind = self._cells(lambda x, y: flat(x, y) and y < n * 0.46)
        self._place(behind, "saturated_grass", [2], 28, 3, 44)
        self._place(behind, "saturated_grass", [3], 10, 5, 45)
        # a few lone tall trees in front too, so the player passes behind them
        front = self._cells(lambda x, y: flat(x, y) and y > n * 0.68)
        self._place(front, "saturated_grass", [5, 4], 6, 9, 46)

    # -- render ----------------------------------------------------------------

    def _ymax(self, im):
        a = np.asarray(im)
        ys = np.where((a[:, :, 3] > 20).any(axis=1))[0]
        return int(ys.max()) if len(ys) else 63

    def render(self, scale=1.0):
        n = self.n
        ox = (n - 1) * DX + 24
        oy = int(self.level.max()) * LEVEL_PX + 170
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
        if scale != 1.0:
            canvas = canvas.resize((int(W * scale), int(H * scale)), Image.LANCZOS)
        return canvas


def build(out=None, n=128, seed=3):
    d = Occlude(n=n, seed=seed)
    out = out or os.path.join(MAPS2, "worlds", "occlusion_test")
    os.makedirs(out, exist_ok=True)
    worldio.save_world(os.path.join(out, "world.json"), name="occlusion_test",
                       mat=d.mat, top=d.top, mirror=d.mirror, level=d.level,
                       spawn=d.spawn, props=d.props)
    img = d.render()
    img.convert("RGB").save(os.path.join(out, "demo.png"))
    w = 2200
    img.resize((w, round(img.height * w / img.width)), Image.LANCZOS).convert("RGB").save(
        os.path.join(out, "preview.png"))
    tall = int((d.level >= 5).sum())
    print(f"occlusion_test {n}x{n}: {len(d.props)} props, max level {int(d.level.max())}, "
          f"{tall} tall (>=5) terrain cells")
    return d


if __name__ == "__main__":
    build()
