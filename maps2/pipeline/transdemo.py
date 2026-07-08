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

import worldio
from tiles2lib import DX, DY, EDGE_K, Tiles2

TYPES = ["saturated_grass", "lightdark_dirt", "stone_mountain",
         "black_mountain", "regular_snow", "clear_water", "crystal_ice"]
LABEL = {"saturated_grass": "grass", "lightdark_dirt": "dirt",
         "stone_mountain": "stone", "black_mountain": "black",
         "regular_snow": "snow", "clear_water": "water", "crystal_ice": "ice"}

R = 16          # circle radius (big, so the loop is clearly visible)
MARGIN = 9      # surround thickness of B around the circle
FADE = 5        # width (cells) of the graded fade band on EACH side of the seam
FADE_DENSITY = 0.22  # at most ~this fraction of cells get an island (at the seam)
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
        self.W = (len(TYPES) - 1) * PLOT   # each row is A vs the other N-1 types
        self.H = len(TYPES) * PLOT
        self.top = np.full((self.H, self.W), None, object)   # (path, mirror) | None
        self.mat = np.full((self.H, self.W), "", object)     # material per cell
        self.edges = np.full((self.H, self.W), None, object)  # chosen edge profiles
        self.circles = []                                    # (A,B,cx,cy)
        self.fallbacks = 0                                   # cells with no exact code
        self._layout()
        self._paint()
        self._connect()

    def _connect(self):
        """Bridge the land circles that are marooned inside a water surround so a
        player can walk to every section."""
        from autotile import connect_walkable

        def set_bridge(x, y, m):
            self.mat[y, x] = m
            self.top[y, x] = (self.lib.plain_tile(m), False)

        connect_walkable(self.mat, set_bridge=set_bridge)

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
        pureA = [1] * EDGE_K
        pureB = [0] * EDGE_K
        edgesA = {e: pureA for e in ("NE", "SE", "SW", "NW")}
        edgesB = {e: pureB for e in ("NE", "SE", "SW", "NW")}
        for (A, B, cx, cy) in self.circles:
            table = lib.wang(A, B)               # code(N,E,S,W; 1=A) -> candidates
            faceA, faceB = lib.fade_tiles(A, B)  # border-pure/interior-mixed islands
            maxA = min(0.30, max((t["other"] for t in faceA), default=0.0))
            maxB = min(0.30, max((t["other"] for t in faceB), default=0.0))
            x0, y0 = int(cx - R - MARGIN), int(cy - R - MARGIN)
            x1, y1 = int(cx + R + MARGIN) + 1, int(cy + R + MARGIN) + 1
            # scanline order (increasing x+y, then x) so a cell's NE neighbour
            # (x,y-1) and NW neighbour (x-1,y) are already placed and can be matched.
            cells = [(x, y)
                     for y in range(max(0, y0), min(self.H, y1))
                     for x in range(max(0, x0), min(self.W, x1))]
            cells.sort(key=lambda p: (p[0] + p[1], p[0]))
            for x, y in cells:
                self.mat[y, x] = A if self._inside(x, y, cx, cy) else B
                code = (
                    int(self._inside(x - 0.5, y - 0.5, cx, cy)),
                    int(self._inside(x + 0.5, y - 0.5, cx, cy)),
                    int(self._inside(x + 0.5, y + 0.5, cx, cy)),
                    int(self._inside(x - 0.5, y + 0.5, cx, cy)),
                )
                if code == (1, 1, 1, 1):
                    # inside grass: fade IN — dirt islands, denser toward the seam
                    d = math.hypot(x - cx, y - cy)
                    f = min(1.0, max(0.0, (R - d) / FADE))   # 0 at seam .. 1 deep
                    self.top[y, x] = self._fade(faceA, f, maxA, x, y)
                    self.edges[y, x] = edgesA
                    continue
                if code == (0, 0, 0, 0):
                    # outside in dirt: fade OUT — grass islands, thinning outward
                    d = math.hypot(x - cx, y - cy)
                    f = min(1.0, max(0.0, (d - R) / FADE))
                    self.top[y, x] = self._fade(faceB, f, maxB, x, y)
                    self.edges[y, x] = edgesB
                    continue
                self.top[y, x], self.edges[y, x] = self._pick(table, code, x, y)

    def _fade(self, band, f, othermax, x, y):
        """Sparingly drop an interior-island tile as an accent. Only a small
        fraction of cells (FADE_DENSITY at the seam, tapering to 0 deep in) get
        one at all; the rest stay pure ground, so the fade reads as an occasional
        speckle, not a texture. The chosen island's strength also eases off with
        depth, and positional jitter keeps equal-depth cells from matching."""
        if _h01(x, y, self.seed + 7) > FADE_DENSITY * (1.0 - f):
            return (band[0]["file"], band[0]["mirror"])   # pure plain
        t = othermax * (1.0 - f) + (_h01(x, y, self.seed + 5) - 0.5) * 0.05
        near = min(abs(c["other"] - t) for c in band[1:] or band)
        pool = [c for c in band[1:] if abs(c["other"] - t) <= near + 0.04] or band[:1]
        c = pool[int(_h01(x, y, self.seed + 6) * len(pool)) % len(pool)]
        return (c["file"], c["mirror"])

    def _seam_cost(self, cand, x, y):
        """How badly this candidate's shared edges disagree with already-placed
        NE and NW neighbours (0 = perfect). A tile's NE edge must equal its NE
        neighbour's SW edge reversed; its NW edge, the NW neighbour's SE reversed."""
        cost = 0
        nb = self.edges[y - 1, x] if y - 1 >= 0 else None   # NE neighbour (x, y-1)
        if nb is not None:
            cost += sum(a != b for a, b in
                        zip(cand["edges"]["NE"], reversed(nb["SW"])))
        nb = self.edges[y, x - 1] if x - 1 >= 0 else None   # NW neighbour (x-1, y)
        if nb is not None:
            cost += sum(a != b for a, b in
                        zip(cand["edges"]["NW"], reversed(nb["SE"])))
        return cost

    def _pick(self, table, code, x, y):
        cands = table.get(code)
        if not cands:
            # no exact piece (saddle / uncovered) -> nearest corner-code, logged
            self.fallbacks += 1
            best = min(table.keys(), key=lambda k: (_hamming(k, code),
                                                    -table[k][0]["conf"]))
            cands = table[best]
        jit = _h01(x, y, self.seed + 3)
        # pick the corner-matching tile whose seams best fit the placed neighbours;
        # break ties toward high corner-confidence, then a little positional jitter
        c = min(cands, key=lambda cd: (self._seam_cost(cd, x, y),
                                       -cd["conf"], jit))
        return (c["file"], c["mirror"]), c["edges"]

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
    gaps = Tiles2().audit_transition_metadata()
    if gaps:
        raise SystemExit("tiles2 transition metadata incomplete (missing "
                         f"edges/composition): {gaps}")
    d = TransDemo(seed=seed)
    out = out or os.path.join(MAPS2, "worlds", "trans_demo")
    os.makedirs(out, exist_ok=True)
    # split (path, mirror) cells into parallel grids for the loadable world
    top = np.full((d.H, d.W), None, object)
    mir = np.zeros((d.H, d.W), bool)
    for y in range(d.H):
        for x in range(d.W):
            c = d.top[y, x]
            if c is not None:
                top[y, x], mir[y, x] = c
    spawn = (int(PLOT / 2), int(PLOT / 2))       # centre of the first circle
    worldio.save_world(os.path.join(out, "world.json"), name="trans_demo",
                       mat=d.mat, top=top, mirror=mir, spawn=spawn)
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
