"""trans_demo — showcase every terrain transition as a big circle.

Grid of circles: row = a base type A, column = each OTHER type B. Each cell is a
large CIRCLE of A sitting in a field of B, so the A->B transition wraps the whole
circle and you can see how the border reads at every orientation. The circle
centre is left plain (roads later). Ground is otherwise a single plain tile so the
only detail is the transition ring itself.

Uses the same measured-orientation feather as the other worlds, but forced
one-sided: the circle's own material A always hosts the blend outward into the
surround B, so each circle "is" A dissolving into B at its rim.
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
BAND = 3.5      # transition feather width
MARGIN = 7      # surround thickness of B around the circle
PLOT = 2 * R + 2 * MARGIN

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)


def _h01(x, y, s):
    h = (int(x) * 374761393 + int(y) * 668265263 + s * 362437) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


class TransDemo:
    def __init__(self, seed=4):
        self.seed = seed
        self.lib = Tiles2()
        self.rows = TYPES                                  # A per row
        self.W = 5 * PLOT
        self.H = len(TYPES) * PLOT
        self.mat = np.full((self.H, self.W), "", object)   # base material
        self.top = np.full((self.H, self.W), None, object)  # tile path
        self.circles = []                                  # (a,b,cx,cy)
        self._layout()
        self._paint()

    def _layout(self):
        for ai, A in enumerate(TYPES):
            others = [t for t in TYPES if t != A]
            for bi, B in enumerate(others):
                px, py = bi * PLOT, ai * PLOT
                cx, cy = px + PLOT / 2, py + PLOT / 2
                self.circles.append((A, B, cx, cy))
                for y in range(py, py + PLOT):
                    for x in range(px, px + PLOT):
                        d = math.hypot(x - cx, y - cy)
                        d += (_h01(x, y, self.seed) - 0.5) * 1.6   # gentle wobble
                        self.mat[y, x] = A if d < R else B

    def _paint(self):
        lib = self.lib
        cand = {}

        def candidates(m, other):
            k = (m, other)
            if k not in cand:
                tiles, first = lib.transition(m, other)
                comp = np.array([t["compA"] if first else 1 - t["compA"] for t in tiles])
                grad = np.array([t["grad"] if first else [-t["grad"][0], -t["grad"][1]]
                                 for t in tiles], float)
                cand[k] = (comp, grad, [t["file"] for t in tiles])
            return cand[k]

        plain = {t: self.lib.plain_tile(t) for t in TYPES}
        for (A, B, cx, cy) in self.circles:
            for y in range(int(cy - R - MARGIN), int(cy + R + MARGIN)):
                for x in range(int(cx - R - MARGIN), int(cx + R + MARGIN)):
                    if not (0 <= x < self.W and 0 <= y < self.H):
                        continue
                    m = self.mat[y, x]
                    if m == "":
                        continue
                    d = math.hypot(x - cx, y - cy)
                    if m == A and R - BAND <= d < R:
                        # feather cell: A hosting outward into B
                        f = (R - d) / BAND                     # 0 edge .. 1 inner
                        want = float(np.clip(0.1 + 0.8 * f, 0.05, 0.95))
                        nx, ny = (x - cx), (y - cy)
                        nl = math.hypot(nx, ny) or 1.0
                        wc, wr = nx / nl, ny / nl              # world outward normal A->B
                        sg = np.array([(wc - wr) * DX, (wc + wr) * DY], float)
                        sn = np.linalg.norm(sg)
                        sg = sg / sn if sn > 1e-6 else np.array([0, -1.0])
                        comp, grad, files = candidates(A, B)
                        score = 2.0 * np.abs(comp - want) + (1 - grad @ sg) \
                            + _h01(x, y, self.seed + 3) * 0.05
                        self.top[y, x] = files[int(np.argmin(score))]
                    else:
                        self.top[y, x] = plain[m]

    # -- render ----------------------------------------------------------------

    def render(self, x0, y0, x1, y1):
        lib = self.lib
        ox = (self.H - 1) * DX + 16
        oy = 40
        xs, ys = [], []
        for cx, cy in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
            xs.append(ox + (cx - cy) * DX)
            ys.append(oy + (cx + cy) * DY)
        X0, X1 = min(xs) - 40, max(xs) + 80
        Y0, Y1 = min(ys) - 40, max(ys) + 80
        wc = lib.target_color("clear_water")
        canvas = Image.new("RGBA", (X1 - X0, Y1 - Y0), tuple(int(c) for c in wc) + (255,))
        order = sorted(((x, y) for y in range(y0, y1) for x in range(x0, x1)),
                       key=lambda p: (p[0] + p[1], p[1]))
        for x, y in order:
            if self.top[y, x] is None:
                continue
            bx = ox + (x - y) * DX - X0
            by = oy + (x + y) * DY - Y0
            canvas.alpha_composite(lib.img(self.top[y, x]), (bx, by))
        return canvas

    def render_row(self, ai):
        y0, y1 = ai * PLOT, (ai + 1) * PLOT
        return self.render(0, y0, self.W, y1)


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
    print(f"trans_demo {d.W}x{d.H}: {len(d.circles)} circles; rows ok")
    return d


if __name__ == "__main__":
    build()
