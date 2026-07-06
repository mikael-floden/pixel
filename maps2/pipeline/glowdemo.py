"""glow_test — a dark showcase of every self-emissive tiles2 prop.

For testing the game's light/emission code. tiles2 owns emission.json, whose
`sources` list every tile with an extracted night-glow cluster — the glowing
props: crystal geodes/spires, volcanic lava/embers, bioluminescent mushrooms, etc.
This world lays every one of them out as PROPS on a dark (black_mountain) field,
grouped by material, so each glow reads clearly under the game's night shader.
Flat, one walkable field. world.json marks the emissive tiles (via worldio, which
reads the same emission.json), so the renderer lights exactly them.

Ownership: this "all glowing tiles" test map is the maps2 domain's, handed off
from the game agent. Regenerate when tiles2's emissive set changes.
"""

from __future__ import annotations

import collections
import os

import numpy as np
from PIL import Image

import worldio
from tiles2lib import DX, DY, LEVEL_PX, Tiles2

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)

DARK = "black_mountain"      # dark floor for contrast
GROUND_BOTTOM = 54
COLS = 16                   # props per row within a material block
SX = 2                      # cell spacing across
SY = 3                      # cell spacing between prop rows
MARGIN = 3
GAP = 2                     # blank rows between material blocks
ORDER = ["crystal_ice", "black_mountain", "saturated_grass", "clear_water",
         "light_sand", "stone_mountain"]


def _ymax(im):
    a = np.asarray(im)
    ys = np.where((a[:, :, 3] > 20).any(axis=1))[0]
    return int(ys.max()) if len(ys) else 63


class GlowDemo:
    def __init__(self):
        self.lib = Tiles2()
        # emissive prop tiles grouped by material, per emission.json
        self.by_mat = collections.OrderedDict()
        for rel in sorted(worldio.emissive_paths()):
            mat = rel.split("/")[1]
            self.by_mat.setdefault(mat, []).append(os.path.join(REPO, rel))
        mats = [m for m in ORDER if m in self.by_mat] + \
               [m for m in self.by_mat if m not in ORDER]
        rows_per = {m: (len(self.by_mat[m]) + COLS - 1) // COLS for m in mats}

        self.n_x = MARGIN * 2 + COLS * SX
        self.n_y = MARGIN * 2 + sum(r * SY for r in rows_per.values()) \
            + GAP * (len(mats) - 1)
        # a walkable dark floor everywhere (so you can walk BETWEEN sections),
        # with each material's props sitting on a patch of THAT material's own
        # plain ground so you can see how the light falls on each surface
        self.mat = np.full((self.n_y, self.n_x), DARK, object)
        self.top = np.full((self.n_y, self.n_x), self.lib.plain_tile(DARK), object)
        self.props = {}
        self.spawn = (MARGIN, MARGIN)
        y = MARGIN
        for m in mats:
            tiles = self.by_mat[m]
            ground = self.lib.plain_tile(m)
            rows = rows_per[m]
            # fill this block's rectangle with the material's ground
            for cy in range(y - 1, y + rows * SY):
                for cx in range(MARGIN - 1, MARGIN + COLS * SX):
                    if 0 <= cy < self.n_y and 0 <= cx < self.n_x:
                        self.mat[cy, cx] = m
                        self.top[cy, cx] = ground
            for i, p in enumerate(tiles):
                cx = MARGIN + (i % COLS) * SX
                cy = y + (i // COLS) * SY
                self.props[(cx, cy)] = p
            if m not in ("clear_water",):
                self.spawn = (MARGIN, y)     # a walkable block for the start
            y += rows * SY + GAP

    # -- render (flat, iso, dark) ----------------------------------------------

    def render(self, cap=2600):
        nx, ny = self.n_x, self.n_y
        ox = (ny - 1) * DX + 20
        oy = 150
        cw = (nx + ny) * DX + 60
        ch = (nx + ny) * DY + 96 + 160
        canvas = Image.new("RGBA", (cw, ch), (14, 14, 20, 255))
        order = sorted(((x, y) for y in range(ny) for x in range(nx)),
                       key=lambda p: (p[0] + p[1], p[1]))
        for x, y in order:
            if self.top[y, x] is None:
                continue
            bx = ox + (x - y) * DX
            by = oy + (x + y) * DY
            canvas.alpha_composite(self.lib.img(self.top[y, x]), (bx, by))
            p = self.props.get((x, y))
            if p is not None:
                pr = self.lib.img(p)
                canvas.alpha_composite(pr, (bx, by + GROUND_BOTTOM - _ymax(pr)))
        if canvas.width > cap:
            canvas = canvas.resize((cap, round(canvas.height * cap / canvas.width)),
                                   Image.LANCZOS)
        return canvas.convert("RGB")


def build(out=None):
    d = GlowDemo()
    out = out or os.path.join(MAPS2, "worlds", "glow_test")
    os.makedirs(out, exist_ok=True)
    props = [(x, y, p) for (x, y), p in d.props.items()]
    worldio.save_world(os.path.join(out, "world.json"), name="glow_test",
                       mat=d.mat, top=d.top, spawn=d.spawn, props=props)
    d.render().save(os.path.join(out, "overview.png"))
    print(f"glow_test {d.n_x}x{d.n_y}: {len(d.props)} emissive props; "
          + ", ".join(f"{m.split('_')[0]}:{len(v)}" for m, v in d.by_mat.items()))
    return d


if __name__ == "__main__":
    build()
