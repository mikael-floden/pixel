"""occlusion_test — tall structures to test the "fade the occluder" system.

In this iso view the camera looks from the south-east: a tile/prop at a HIGHER
(x+y) is drawn later and on top, so it hides whatever sits up-screen behind it
(lower x+y). This map gives the game a set of deliberately TALL occluders — a big
mountain, a long wall with a doorway, a hollow keep, tower clusters, and a tall
forest — each with flat, walkable, detail-filled ground to its NORTH (behind it,
up-screen). Walk the player up behind any of them and the structure should fade.

Near spawn it also carries two structures that need a SECOND walkable surface over
the same footprint — expressed with the new world@2 `decks` concept (elevated
walkable slabs floating over the base terrain, which stays walkable/swimmable
underneath):

  * a flat-roofed HOUSE — walls stand 4 levels high with a door gap TALLER than the
    player in the south (front) wall so you can walk into the room; a rock
    staircase on the RIGHT (east) climbs onto the roof deck; the LEFT (west) and
    BACK (north) roof edges are open drops. Tests: walk inside under the roof, walk
    on the roof, jump off the left/back edges, walk behind the house.
  * a stone BRIDGE between two grassy hills — climb either hill's ramp and walk
    OVER the deck; the channel beneath is half grass, half water, so you can walk
    UNDER the deck and swim UNDER it too.

Nothing exotic in the base data: terrain height is in `level`, props carry `levels`
(their base_x_N height); the house roof and bridge span are `decks` entries in
world.json (kind/level/thickness/cells). One connected walkable field, so the
player can reach every structure — and behind/under all of them.
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
        self.decks = []                # elevated walkable slabs (roof, bridge span)
        self.reserved = set()          # cells the house/bridge own (keep props off)
        self.spawn = (n // 2, n - 6)                            # front (down-screen)
        self._structures()
        self._house()                  # flat-roof house: room + walkable roof deck
        self._bridge()                 # bridge over a half-grass/half-water channel
        self._paint()
        self.deck_at = {(x, y): dk for dk in self.decks for (x, y) in dk["cells"]}
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

        # 1) HUGE STEEP MOUNTAIN (west): a tall stone peak (~32 levels) with STEEP
        #    sides — a small footprint but very high, so the summit sits right
        #    above the grass behind it and fully hides a player standing there
        #    (a broad, gradual cone wastes its height just reaching the back rim).
        mcx, mcy = n * 0.28, n * 0.64
        dm = np.hypot(X - mcx, Y - mcy)
        mh = np.clip(32.0 - dm * 2.6, 0, 32)          # ~2.6 levels/cell => steep
        m = mh > 0.5
        self.level[m] = np.rint(mh)[m].astype(np.int16)
        self.mat[m] = "stone_mountain"
        self.mat[m & (self.level >= 22)] = "regular_snow"

        # 2) CITY WALL — a U of 14-level ramparts around a courtyard, open to the
        #    south so you walk in; props go on top (battlements) to test those too
        cwx, cwy, cw = int(n * 0.44), int(n * 0.12), 22
        self._wall(cwx, cwy, cwx + cw, cwy + 3, 14)             # north rampart
        self._wall(cwx, cwy, cwx + 3, cwy + cw, 14)            # west rampart
        self._wall(cwx + cw - 3, cwy, cwx + cw, cwy + cw, 14)  # east rampart

        # 3) LONG HIGH CLIFF WALL (centre, E-W): 16 levels, thick, with a doorway
        wy = int(n * 0.52)
        self._wall(int(n * 0.40), wy, int(n * 0.72), wy + 3, 16)
        self._wall(int(n * 0.55), wy, int(n * 0.58), wy + 3, 0, "saturated_grass")  # doorway

        # 4) TALL STEP PYRAMID (east): a steep ziggurat 12/22/32 — tall enough that
        #    you can stand behind it on the grass and be fully hidden
        tx, ty = int(n * 0.80), int(n * 0.30)
        for lvl, pad in ((12, 0), (22, 3), (32, 6)):
            self._wall(tx + pad, ty + pad, tx + 16 - pad, ty + 16 - pad, lvl)

        # 5) HOLLOW KEEP (SE): 16-level black-stone walls, room inside, south
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
                    self.level[yy, x] = 16

        # 6) a couple of free-standing STONE WALL segments to stand behind
        self._wall(int(n * 0.30), int(n * 0.30), int(n * 0.46), int(n * 0.32), 12)
        self._wall(int(n * 0.60), int(n * 0.68), int(n * 0.62), int(n * 0.82), 12)

    # -- house + bridge (need a second walkable surface: world@2 decks) --------

    def _reserve(self, x0, x1, y0, y1):
        for y in range(max(0, y0), min(self.n, y1)):
            for x in range(max(0, x0), min(self.n, x1)):
                self.reserved.add((x, y))

    def _house(self):
        """A flat-roofed stone house near spawn. Walls stand ROOF levels high; the
        SOUTH (front) wall has a full-height door gap — taller than the player — so
        you walk into the room, whose floor stays at ground level. A rock staircase
        on the RIGHT (east) climbs to the roof, a walkable deck flush with the wall
        tops; its LEFT (west) and BACK (north) edges are open drops to the grass."""
        x0, y0, w, d = 54, 104, 10, 8
        x1, y1 = x0 + w, y0 + d
        ROOF = 7                    # 7 levels = 112px: the player sprite is ~5 levels
        wall = "stone_mountain"     # tall, so a 4-level door left its head over the roof
        for y in range(y0, y1):
            for x in range(x0, x1):
                if x in (x0, x1 - 1) or y in (y0, y1 - 1):
                    self.mat[y, x] = wall            # perimeter wall column
                    self.level[y, x] = ROOF
                # interior stays grass @ level 0: a walkable room under the roof
        # door gap in the SOUTH wall (front, down-screen): ONE cell wide but FULL
        # height (0..ROOF), so the opening clears the tall player with headroom
        dcx = x0 + w // 2
        self.mat[y1 - 1, dcx] = "saturated_grass"
        self.level[y1 - 1, dcx] = 0
        # rock STAIRCASE on the right (east): unit steps ROOF..1 down to the ground,
        # so the player climbs all the way up onto the (now taller) roof; kept a few
        # rows deep so it reads as a stair, not a solid block
        for k in range(ROOF):
            x = x1 + k
            for y in range(y0 + 2, y1 - 2):
                self.mat[y, x] = wall
                self.level[y, x] = ROOF - k
        # ROOF DECK: a walkable slab over the whole footprint, flush with wall tops
        cells = [(x, y) for y in range(y0, y1) for x in range(x0, x1)]
        self.decks.append({"kind": "roof", "mat": wall, "level": ROOF,
                           "thickness": 1, "cells": cells})
        self._reserve(x0 - 1, x1 + ROOF + 1, y0 - 1, y1 + 1)

    def _bridge(self):
        """A stone bridge spanning a channel between two grassy hills, near spawn.
        Each hill rises to DECK level with a south ramp you climb; the deck connects
        the two hilltops (walk OVER). The channel below stays at ground level and is
        HALF grass / HALF water, so you can walk UNDER the deck on the grass and swim
        UNDER it in the water — a second walkable surface over one footprint."""
        DECK = 10                   # 10 levels: raised bridge, ~144px of headroom beneath
        y0, y1 = 104, 119                    # so the tall (~5-level) player fits beneath
        ax0, ax1 = 34, 40                    # west hill x-range
        gx0, gx1 = 40, 46                    # channel (the gap) x-range
        bx0, bx1 = 46, 52                    # east hill x-range
        plateau = y1 - DECK                  # ramp spans DECK rows so it still reaches ground
        # two grassy hills: flat at DECK, ramping down to ground on the south side
        for hx0, hx1 in ((ax0, ax1), (bx0, bx1)):
            for y in range(y0, y1):
                for x in range(hx0, hx1):
                    self.mat[y, x] = "saturated_grass"
                    self.level[y, x] = (DECK if y < plateau
                                        else max(0, DECK - (y - plateau + 1)))
        # channel floor at ground level, running the FULL length between the hills:
        # a WATER lane on the west and a GRASS lane on the east, side by side, so a
        # player can swim UNDER the deck (water lane) and walk UNDER it (grass lane),
        # each passing all the way through beneath the bridge.
        wmid = (gx0 + gx1) // 2
        for y in range(y0, y1):
            for x in range(gx0, gx1):
                self.level[y, x] = 0
                self.mat[y, x] = "clear_water" if x < wmid else "saturated_grass"
        # the DECK: spans the gap and laps both flat hilltops, covering water AND grass
        cells = [(x, y) for y in range(y0, plateau)
                 for x in range(ax1 - 1, bx0 + 1)]
        self.decks.append({"kind": "bridge", "mat": "stone_mountain", "level": DECK,
                           "thickness": 1, "cells": cells})
        self._reserve(ax0 - 1, bx1 + 1, y0 - 1, y1 + 1)

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
            if (x, y) in self.props or (x, y) in self.reserved:
                continue
            if (x, y) in self.deck_at:                 # never under/on a deck
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
            # DECK slab (roof / bridge span): a thin walkable slab floating at its
            # own level over the base cell, with open air beneath (see under it).
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


def build(out=None, n=128, seed=3):
    d = Occlude(n=n, seed=seed)
    out = out or os.path.join(MAPS2, "worlds", "occlusion_test")
    os.makedirs(out, exist_ok=True)
    # expand each deck's cells with an explicit (region-coherent) top tile path
    decks_out = []
    for dk in d.decks:
        m = dk["mat"]
        cells = [{"x": x, "y": y, "top": d.lib.region_base(m, x, y), "mirror": 0}
                 for (x, y) in dk["cells"]]
        decks_out.append({"kind": dk["kind"], "mat": m, "level": dk["level"],
                          "thickness": dk["thickness"], "cells": cells})
    worldio.save_world(os.path.join(out, "world.json"), name="occlusion_test",
                       mat=d.mat, top=d.top, mirror=d.mirror, level=d.level,
                       spawn=d.spawn, props=d.props, decks=decks_out)
    img = d.render()
    img.convert("RGB").save(os.path.join(out, "demo.png"))
    w = 2200
    img.resize((w, round(img.height * w / img.width)), Image.LANCZOS).convert("RGB").save(
        os.path.join(out, "preview.png"))
    tall = int((d.level >= 5).sum())
    dcells = sum(len(dk["cells"]) for dk in d.decks)
    print(f"occlusion_test {n}x{n}: {len(d.props)} props, max level {int(d.level.max())}, "
          f"{tall} tall (>=5) terrain cells, {len(d.decks)} decks / {dcells} deck cells")
    return d


if __name__ == "__main__":
    build()
