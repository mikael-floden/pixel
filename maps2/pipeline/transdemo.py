"""trans_demo — showcase every terrain transition as a big circle.

Grid of circles: row = a base type A, column = each OTHER type B. Each cell is a
large CIRCLE of A sitting in a field of B, so the A->B border wraps the whole
circle and you can read it at every orientation. Circle centres are left plain.

Placement is CORNER-CODE WANG TILING, not fuzzy matching. We evaluate the A/B
region at each diamond CORNER (a point on a lattice shared by neighbouring
cells), giving every cell a 4-bit corner code (which of its N/E/S/W corners are
A). We then place the transition tile whose *measured* corners equal that code.
Because adjacent cells share corner lattice points, their shared edge is guaranteed
to agree material-for-material -> no cut, no speckle. Horizontal MIRRORS of the
sheet tiles are allowed so codes the raw art misses are still filled. A smooth
circle only ever needs contiguous codes (never the opposite-corner "saddle"
cases), which the sheets cover well.
"""

from __future__ import annotations

import math
import os

import numpy as np
from PIL import Image

from tiles2lib import DX, DY, Tiles2

TYPES = ["saturated_grass", "lightdark_dirt", "stone_mountain",
         "black_mountain", "regular_snow", "clear_water"]
LABEL = {"saturated_grass": "grass", "lightdark_dirt": "dirt",
         "stone_mountain": "stone", "black_mountain": "black",
         "regular_snow": "snow", "clear_water": "water"}

R = 16          # circle radius (big, so the loop is clearly visible)
MARGIN = 7      # surround thickness of B around the circle
PLOT = 2 * R + 2 * MARGIN

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)


def _h01(x, y, s):
    h = (int(x) * 374761393 + int(y) * 668265263 + s * 362437) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


def _hamming(a, b):
    return sum(1 for i in range(4) if a[i] != b[i])


class TransDemo:
    def __init__(self, seed=4):
        self.seed = seed
        self.lib = Tiles2()
        self.W = 5 * PLOT
        self.H = len(TYPES) * PLOT
        self.top = np.full((self.H, self.W), None, object)   # (path, mirror) | None
        self.circles = []                                    # (A,B,cx,cy)
        self.fallbacks = 0                                   # cells with no exact code
        self._layout()
        self._paint()

    def _layout(self):
        for ai, A in enumerate(TYPES):
            others = [t for t in TYPES if t != A]
            for bi, B in enumerate(others):
                cx = bi * PLOT + PLOT / 2
                cy = ai * PLOT + PLOT / 2
                self.circles.append((A, B, cx, cy))

    def _inside(self, px, py, cx, cy):
        """Region membership evaluated at a CORNER position (deterministic in
        space, so cells sharing a corner agree). Perfectly round for a crisp,
        contiguous-only code set."""
        return math.hypot(px - cx, py - cy) < R

    def _paint(self):
        lib = self.lib
        for (A, B, cx, cy) in self.circles:
            table = lib.wang(A, B)               # code(N,E,S,W; 1=A) -> candidates
            plainA = (lib.plain_tile(A), False)
            plainB = (lib.plain_tile(B), False)
            x0, y0 = int(cx - R - MARGIN), int(cy - R - MARGIN)
            x1, y1 = int(cx + R + MARGIN) + 1, int(cy + R + MARGIN) + 1
            for y in range(max(0, y0), min(self.H, y1)):
                for x in range(max(0, x0), min(self.W, x1)):
                    # 4 corner lattice points of this cell (N, E, S, W)
                    code = (
                        int(self._inside(x - 0.5, y - 0.5, cx, cy)),
                        int(self._inside(x + 0.5, y - 0.5, cx, cy)),
                        int(self._inside(x + 0.5, y + 0.5, cx, cy)),
                        int(self._inside(x - 0.5, y + 0.5, cx, cy)),
                    )
                    if code == (1, 1, 1, 1):
                        self.top[y, x] = plainA
                        continue
                    if code == (0, 0, 0, 0):
                        self.top[y, x] = plainB
                        continue
                    self.top[y, x] = self._pick(table, code, x, y)

    def _pick(self, table, code, x, y):
        cands = table.get(code)
        if not cands:
            # no exact piece (saddle / uncovered) -> nearest corner-code, logged
            self.fallbacks += 1
            best = min(table.keys(), key=lambda k: (_hamming(k, code),
                                                    -table[k][0]["conf"]))
            cands = table[best]
        # among the confidently-matching tiles, vary by position for a natural look
        top = cands[0]["conf"]
        good = [c for c in cands if c["conf"] >= top - 0.12] or cands
        c = good[int(_h01(x, y, self.seed + 3) * len(good)) % len(good)]
        return (c["file"], c["mirror"])

    # -- render ----------------------------------------------------------------

    def _img(self, cell):
        path, mirror = cell
        im = self.lib.img(path)
        return im.transpose(Image.FLIP_LEFT_RIGHT) if mirror else im

    def render(self, x0, y0, x1, y1):
        ox = (self.H - 1) * DX + 16
        oy = 40
        xs, ys = [], []
        for cx, cy in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
            xs.append(ox + (cx - cy) * DX)
            ys.append(oy + (cx + cy) * DY)
        X0, X1 = min(xs) - 40, max(xs) + 80
        Y0, Y1 = min(ys) - 40, max(ys) + 80
        wc = self.lib.target_color("clear_water")
        canvas = Image.new("RGBA", (X1 - X0, Y1 - Y0),
                           tuple(int(c) for c in wc) + (255,))
        order = sorted(((x, y) for y in range(y0, y1) for x in range(x0, x1)),
                       key=lambda p: (p[0] + p[1], p[1]))
        for x, y in order:
            cell = self.top[y, x]
            if cell is None:
                continue
            bx = ox + (x - y) * DX - X0
            by = oy + (x + y) * DY - Y0
            canvas.alpha_composite(self._img(cell), (bx, by))
        return canvas

    def render_row(self, ai):
        return self.render(0, ai * PLOT, self.W, (ai + 1) * PLOT)


def _cap(img, w):
    return img if img.width <= w else img.resize(
        (w, round(img.height * w / img.width)), Image.LANCZOS)


def build(out=None, seed=4):
    d = TransDemo(seed=seed)
    out = out or os.path.join(MAPS2, "worlds", "trans_demo")
    os.makedirs(out, exist_ok=True)
    _cap(d.render(0, 0, d.W, d.H), 2800).convert("RGB").save(
        os.path.join(out, "overview.png"))
    print("overview ok")
    for ai, A in enumerate(TYPES):
        _cap(d.render_row(ai), 2600).convert("RGB").save(
            os.path.join(out, f"row_{LABEL[A]}.png"))
    total = sum(1 for c in d.top.ravel() if c is not None)
    print(f"trans_demo {d.W}x{d.H}: {len(d.circles)} circles; "
          f"{d.fallbacks}/{total} cells used a fallback (no exact corner code)")
    return d


if __name__ == "__main__":
    build()
