"""Prop demo: every terrain's elevation tiles (base_x_2..5) on its own ground.

For each ground type we lay ALL of its elevation/prop tiles (the boulders,
stumps, mushrooms, cairns, statues, towers, snowmen, crystals … in base_x_2
through base_x_5) onto a plot tiled with that same terrain's plain ground — so
each prop is shown standing on the terrain that owns it. Heights are ordered
back-to-front (x2 at the back, x5 at the front) so tall props never hide the
shorter ones behind them.

Props anchor differently from ground tiles: a prop is a 64x128 tile whose terrain
block base sits on the ground and whose object rises above, so we plant it by
aligning its content BOTTOM to the ground cell's base line.
"""

from __future__ import annotations

import json
import os

import numpy as np
from PIL import Image

import worldio
from tiles2lib import DX, DY, LEVEL_PX, Tiles2

TERRAINS = ["saturated_grass", "lightdark_dirt", "stone_mountain",
            "black_mountain", "regular_snow", "clear_water", "crystal_ice"]
GROUND_BOTTOM = 54          # content bottom of a 64x64 base tile
COLS = 16                   # props per row within a height group
SX = 2                      # cell spacing between props across
SY = 3                      # cell spacing between prop rows
GAP_ROWS = 1                # blank rows between height groups
PLOT_MARGIN = 3
PLOT_GAP = 5                # void columns between terrain plots

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)


def _ymax(im: Image.Image) -> int:
    a = np.asarray(im)
    ys = np.where((a[:, :, 3] > 20).any(axis=1))[0]
    return int(ys.max()) if len(ys) else 63


class PropDemo:
    def __init__(self):
        self.lib = Tiles2()
        self.plots = {}         # gid -> (x0, y0, w, h)
        self.ground = {}        # (x,y) -> gid  (plain ground cells)
        self.props = {}         # (x,y) -> prop path
        self.labels = []        # (gid, x0)
        self._layout()

    def _layout(self):
        cursor_x = PLOT_MARGIN
        for gid in TERRAINS:
            # gather props grouped by height, back(x2)->front(x5)
            groups = [(h, self.lib.elev(gid, h)) for h in (2, 3, 4, 5)
                      if self.lib.elev(gid, h)]
            rows = sum(int(np.ceil(len(t) / COLS)) for _, t in groups) \
                + GAP_ROWS * (len(groups) - 1)
            plot_w = COLS * SX + PLOT_MARGIN
            plot_h = rows * SY + PLOT_MARGIN * 2
            x0, y0 = cursor_x, PLOT_MARGIN
            self.plots[gid] = (x0, y0, plot_w, plot_h)
            self.labels.append((gid, x0))
            # ground fill
            for yy in range(y0, y0 + plot_h):
                for xx in range(x0, x0 + plot_w):
                    self.ground[(xx, yy)] = gid
            # place props
            ry = y0 + PLOT_MARGIN
            for h, tiles in groups:
                for i, p in enumerate(tiles):
                    col = i % COLS
                    row = i // COLS
                    cx = x0 + PLOT_MARGIN + col * SX
                    cy = ry + row * SY
                    self.props[(cx, cy)] = p
                ry += (int(np.ceil(len(tiles) / COLS)) + GAP_ROWS) * SY
            cursor_x += plot_w + PLOT_GAP
        self.n_x = cursor_x + PLOT_MARGIN
        self.n_y = max(p[1] + p[3] for p in self.plots.values()) + PLOT_MARGIN

    # -- render ---------------------------------------------------------------

    def _bg(self):
        wc = self.lib.target_color("clear_water")
        return tuple(int(c) for c in wc) + (255,)

    def render(self, x0=None, y0=None, x1=None, y1=None) -> Image.Image:
        nx, ny = self.n_x, self.n_y
        x0 = 0 if x0 is None else x0
        y0 = 0 if y0 is None else y0
        x1 = nx if x1 is None else x1
        y1 = ny if y1 is None else y1
        ox = (ny - 1) * DX + 20
        oy = 150
        # screen bounds of the window
        xs, ys = [], []
        for cx, cy in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
            xs.append(ox + (cx - cy) * DX)
            ys.append(oy + (cx + cy) * DY)
        X0, X1 = min(xs) - 40, max(xs) + 90
        Y0, Y1 = min(ys) - 150, max(ys) + 90
        canvas = Image.new("RGBA", (X1 - X0, Y1 - Y0), self._bg())
        order = sorted(((x, y) for y in range(y0, y1) for x in range(x0, x1)),
                       key=lambda p: (p[0] + p[1], p[1]))
        for x, y in order:
            gid = self.ground.get((x, y))
            if gid is None:
                continue
            bx = ox + (x - y) * DX - X0
            by = oy + (x + y) * DY - Y0
            g = self.lib.img(self.lib.plain_tile(gid))
            canvas.alpha_composite(g, (bx, by))
            p = self.props.get((x, y))
            if p is not None:
                pr = self.lib.img(p)
                canvas.alpha_composite(pr, (bx, by + GROUND_BOTTOM - _ymax(pr)))
        return canvas

    def render_terrain(self, gid: str) -> Image.Image:
        x0, y0, w, h = self.plots[gid]
        return self.render(x0 - 1, y0 - 1, x0 + w + 1, y0 + h + 1)


def _cap(img: Image.Image, w: int = 1800) -> Image.Image:
    if img.width <= w:
        return img
    return img.resize((w, round(img.height * w / img.width)), Image.LANCZOS)


def build(out: str | None = None):
    d = PropDemo()
    out = out or os.path.join(MAPS2, "worlds", "prop_demo")
    os.makedirs(out, exist_ok=True)
    print(f"grid {d.n_x}x{d.n_y}; plots: "
          + ", ".join(f"{g}:{d.plots[g][2]}x{d.plots[g][3]}" for g in TERRAINS))
    # loadable world: plain ground per cell + the props laid on top
    mat = np.full((d.n_y, d.n_x), "", object)
    top = np.full((d.n_y, d.n_x), None, object)
    for (x, y), gid in d.ground.items():
        mat[y, x] = gid
        top[y, x] = d.lib.plain_tile(gid)
    props = [(x, y, p) for (x, y), p in d.props.items()]
    x0, y0 = d.plots[TERRAINS[0]][:2]
    worldio.save_world(os.path.join(out, "world.json"), name="prop_demo",
                       mat=mat, top=top, spawn=(x0, y0 + 1), props=props)
    _cap(d.render(), 2400).convert("RGB").save(os.path.join(out, "overview.png"))
    print("overview ok")
    for gid in TERRAINS:
        _cap(d.render_terrain(gid)).convert("RGB").save(
            os.path.join(out, f"props_{gid}.png"))
    print("per-terrain ok")


if __name__ == "__main__":
    build()
