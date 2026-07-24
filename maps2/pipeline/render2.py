"""Isometric renderer for the tiles2 ring world.

tiles2 geometry: top diamond 30px (DY=15), face 16px/level (DX=32). Terraced
cliffs within a slice are built by STACKING that material's base tile 16px per
level (pixel-perfect per the ELEVATION doc); the top surface uses the cell's
assigned tile (a base tile for pure cells, a transition tile at borders).
"""

from __future__ import annotations

import os
from collections import deque

import numpy as np
from PIL import Image

from tiles2lib import DX, DY, LEVEL_PX, Tiles2

MARGIN = 12
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class Ctx:
    def __init__(self, world, lib: Tiles2 | None = None):
        self.w = world
        self.lib = lib or Tiles2()
        # per-material base tile for cliff faces (deterministic pick per cell)
        self.mat = world.mat
        self.level = world.level
        self.top = world.top
        self.mirror = getattr(world, "mirror", None)
        self.paths = world.paths
        self.n = world.n
        # background = mean water color
        wc = self.lib.target_color("clear_water")
        self.bg = tuple(int(c) for c in wc) + (255,)
        # deep-water skip: border-connected void/water minus a coastal band
        solid = self.mat != ""
        self.skip = ~solid   # void cells: don't draw, show background

    def face_tile(self, y, x) -> Image.Image:
        # cliff faces use the cell's REGION base tile — same tile as the top, so a
        # terrace reads as one coherent wall; walls vary by region across the map
        return self.lib.img(self.lib.region_base(self.mat[y, x], x, y))

    def top_tile(self, y, x) -> Image.Image:
        i = int(self.top[y, x])
        im = self.lib.img(self.paths[i])
        if self.mirror is not None and self.mirror[y, x]:
            im = im.transpose(Image.FLIP_LEFT_RIGHT)
        return im


def _wh(world):
    return getattr(world, "W", world.n), getattr(world, "H", world.n)


def _origin(world):
    _W, H = _wh(world)
    ox = (H - 1) * DX + MARGIN                     # min screen-x is (0 - (H-1))*DX
    oy = int(world.level.max()) * LEVEL_PX + 40 + MARGIN
    return ox, oy


def render_window(world, x0, y0, x1, y1, ctx: Ctx | None = None) -> Image.Image:
    ctx = ctx or Ctx(world)
    n = world.n
    ox, oy = _origin(world)
    xs, ys = [], []
    for cx, cy in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
        xs.append(ox + (cx - cy) * DX)
        ys.append(oy + (cx + cy) * DY)
    X0, X1 = min(xs) - 40, max(xs) + 80
    Y0, Y1 = min(ys) - int(world.level.max()) * LEVEL_PX - 60, max(ys) + 90
    canvas = Image.new("RGBA", (X1 - X0, Y1 - Y0), ctx.bg)
    pad = 2
    for s in range(x0 + y0 - pad, x1 + y1 + pad):
        base_y = oy + s * DY
        for x in range(max(0, x0 - pad, s - n + 1), min(n, x1 + pad, s + 1)):
            y = s - x
            if y < max(0, y0 - pad) or y >= min(n, y1 + pad):
                continue
            if ctx.skip[y, x]:
                continue
            base_x = ox + (x - y) * DX
            L = int(ctx.level[y, x])
            for lvl in range(L):
                f = ctx.face_tile(y, x)
                canvas.alpha_composite(f, (base_x - X0, base_y - lvl * LEVEL_PX - Y0))
            t = ctx.top_tile(y, x)
            canvas.alpha_composite(t, (base_x - X0, base_y - L * LEVEL_PX - Y0 - (t.height - 64)))
    return canvas


def render_overview(world, scale: float = 0.32, band_px: int = 1400,
                    transparent: bool = False) -> Image.Image:
    # transparent=True: every NON-MAP pixel (the iso-diamond corners + void cells)
    # stays fully transparent, the ocean/land is drawn opaque — the normalized minimap
    # look (maintainer 2026-07-23). Output is RGBA when transparent, else RGB (as before).
    ctx = Ctx(world)
    W, H = _wh(world)                               # supports NON-SQUARE worlds
    ox, oy = _origin(world)
    maxL = int(world.level.max())
    full_w = (W + H) * DX + MARGIN * 2
    full_h = (W + H) * DY + 64 + maxL * LEVEL_PX + 80
    band_bg = (0, 0, 0, 0) if transparent else ctx.bg
    out = (Image.new("RGBA", (int(full_w * scale), int(full_h * scale)), (0, 0, 0, 0))
           if transparent else
           Image.new("RGB", (int(full_w * scale), int(full_h * scale)), ctx.bg[:3]))
    reach_up = maxL * LEVEL_PX + 80
    for b0 in range(0, full_h, band_px):
        b1 = min(full_h, b0 + band_px)
        band = Image.new("RGBA", (full_w, b1 - b0), band_bg)
        s_lo = max(0, (b0 - 80 - oy) // DY)
        s_hi = min(W + H - 1, (b1 + reach_up - oy) // DY + 1)
        for s in range(int(s_lo), int(s_hi)):
            base_y = oy + s * DY
            for x in range(max(0, s - H + 1), min(W, s + 1)):
                y = s - x
                if ctx.skip[y, x]:
                    continue
                base_x = ox + (x - y) * DX
                L = int(ctx.level[y, x])
                for lvl in range(L):
                    f = ctx.face_tile(y, x)
                    band.alpha_composite(f, (base_x, base_y - lvl * LEVEL_PX - b0))
                t = ctx.top_tile(y, x)
                band.alpha_composite(t, (base_x, base_y - L * LEVEL_PX - b0 - (t.height - 64)))
        bw, bh = int(full_w * scale), max(1, int((b1 - b0) * scale))
        if transparent:
            out.alpha_composite(band.resize((bw, bh), Image.LANCZOS), (0, int(b0 * scale)))
        else:
            out.paste(band.convert("RGB").resize((bw, bh), Image.LANCZOS), (0, int(b0 * scale)))
    return out


def save_minimap(out_dir, img, width: int = 2000):
    """Normalized map-tab image (maintainer 2026-07-23: "normalize how you save/store the
    map"): every world writes exactly one `minimap.png` — the world's isometric view with
    all NON-MAP pixels transparent, capped to `width` px. Keeps alpha (RGBA); NEVER
    convert('RGB') (that would flatten the transparency back onto a solid rectangle)."""
    import os
    if img.width > width:
        img = img.resize((width, max(1, round(img.height * width / img.width))), Image.LANCZOS)
    img.save(os.path.join(out_dir, "minimap.png"))


def render_minimap(world, px: int = 4) -> Image.Image:
    """Top-down chart coloured by each material's target colour + hillshade."""
    lib = Tiles2()
    n = world.n
    colors = {"": (20, 26, 40)}
    from ringworld import SLICES, WATER
    for g in SLICES + [WATER]:
        colors[g] = tuple(int(c) for c in lib.target_color(g))
    img = np.zeros((n, n, 3), np.uint8)
    for y in range(n):
        for x in range(n):
            base = colors[world.mat[y, x]]
            f = 0.72 + 0.04 * int(world.level[y, x])
            img[y, x] = [min(255, int(c * f)) for c in base]
    lvl = world.level
    edge = np.zeros((n, n), bool)
    edge[:, :-1] |= lvl[:, :-1] > lvl[:, 1:]
    edge[:-1, :] |= lvl[:-1, :] > lvl[1:, :]
    img[edge] = (img[edge] * 0.6).astype(np.uint8)
    # spawn marker
    sx, sy = world.spawn
    img[max(0, sy-1):sy+2, max(0, sx-1):sx+2] = (255, 60, 60)
    return Image.fromarray(img).resize((n * px, n * px), Image.NEAREST)
