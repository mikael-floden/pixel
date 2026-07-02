"""Renderer for BigWorld: window renders, banded overview, minimap.

The full world at native resolution is ~30,700 x 13,100 px — too large for one
canvas. Three outputs instead:

  render_window(world, cx0, cy0, cx1, cy1)  full-res iso of a cell rect
  render_overview(world, scale=0.25)        whole world, rendered in horizontal
                                            bands (cells grouped by their x+y
                                            diagonal share one base_y) and
                                            downscaled band by band
  render_minimap(world, px=3)               top-down map colored by each tile's
                                            census top-face color + hillshade

Anchoring rules come from the census roles:
  spire/wall -> bottom-anchored (the tile STANDS ON the cell: trees, towers,
                obelisks, boulders, cacti)
  cliff      -> top-anchored face below the cell's surface
  water drop -> waterfall_v2 face (the marquee tiles)
  otherwise  -> top surface pinned to the level grid (surface_offset)
"""

from __future__ import annotations

import json
import os
from collections import deque

import numpy as np
from PIL import Image

from bigworld import BigWorld
from tileset import TileSet

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS = os.path.dirname(_HERE)

LH = 19          # px per elevation level (stacking step)
DX, DY = 32, 13  # iso grid steps
MARGIN = 16


class RenderCtx:
    def __init__(self, world: BigWorld):
        self.w = world
        self.tiles = TileSet()
        census = json.load(open(os.path.join(MAPS, "config", "tile_census.json")))
        self.role = {c: m["role"] for c, m in census["categories"].items()}
        self.topcol = {}
        for c, m in census["categories"].items():
            for t in m["tiles"]:
                hexc = t["top"].lstrip("#")
                self.topcol[(c, t["index"])] = tuple(int(hexc[i:i+2], 16) for i in (0, 2, 4))
        cli = json.load(open(os.path.join(MAPS, "config", "climates.json")))
        self.cliff = {name: c["cliff"] for name, c in cli["climates"].items()}
        self.water_i = world.cats.index("water") if "water" in world.cats else 0

        # deep ocean mask (border-connected water, minus a coastal band)
        wat = world.terr == self.water_i
        sea = np.zeros_like(wat)
        dq = deque()
        H, W = wat.shape
        for x in range(W):
            for y in (0, H - 1):
                if wat[y, x] and not sea[y, x]:
                    sea[y, x] = True
                    dq.append((x, y))
        for y in range(H):
            for x in (0, W - 1):
                if wat[y, x] and not sea[y, x]:
                    sea[y, x] = True
                    dq.append((x, y))
        while dq:
            x, y = dq.popleft()
            for nx, ny in ((x+1, y), (x-1, y), (x, y+1), (x, y-1)):
                if 0 <= nx < W and 0 <= ny < H and wat[ny, nx] and not sea[ny, nx]:
                    sea[ny, nx] = True
                    dq.append((nx, ny))
        land = ~wat
        coast = land.copy()
        for _ in range(3):
            c2 = coast.copy()
            c2[1:] |= coast[:-1]; c2[:-1] |= coast[1:]
            c2[:, 1:] |= coast[:, :-1]; c2[:, :-1] |= coast[:, 1:]
            coast = c2
        self.skip = sea & ~coast

        a = np.asarray(self.tiles.tile("water", 0).convert("RGBA"))
        m = a[:, :, 3] > 200
        self.seacolor = tuple(int(a[:, :, i][m].mean()) for i in range(3)) + (255,)

        # front-min-level for drop detection (front = (x+1,y) and (x,y+1))
        lvl = world.level.astype(np.int16)
        lvl_w = np.where(wat, 0, lvl)
        fe = np.full_like(lvl_w, -1)
        fs = np.full_like(lvl_w, -1)
        fe[:, :-1] = lvl_w[:, 1:]
        fs[:-1, :] = lvl_w[1:, :]
        self.frontmin = np.minimum(fe, fs)
        self.iswater = wat

    def draw_cell(self, canvas, x, y, base_x, base_y):
        w = self.w
        cat = w.cats[w.terr[y, x]]
        v = int(w.variant[y, x])
        L = int(w.level[y, x])
        t = self.tiles
        if not t.has(cat):
            return
        drop = L - int(self.frontmin[y, x]) if L > 0 else 0

        if self.iswater[y, x]:
            if drop > 0 and t.has("waterfall_v2"):
                fv = [0, 3, 5, 8][(x * 7 + y * 13) % 4]
                img = t.tile("waterfall_v2", fv)
                off = t.surface_offset("waterfall_v2")
                cover = max(1, t.face_height("waterfall_v2") // LH)
                fl = L - cover
                fills = []
                while fl > L - drop - 1 and fl >= 0:
                    fills.append(fl)
                    fl -= cover
                for f in reversed(fills):
                    canvas.paste(img, (base_x, base_y - f * LH + off), img)
                canvas.paste(img, (base_x, base_y - L * LH + off), img)
            else:
                img = t.tile(cat, v)
                canvas.paste(img, (base_x, base_y - L * LH + t.surface_offset(cat)), img)
            return

        role = self.role.get(cat, "ground")
        if role in ("spire", "wall"):
            img = t.tile(cat, v)
            canvas.paste(img, (base_x, base_y - L * LH - (img.height - 64)), img)
            return

        if drop > 0 and role != "cliff":
            cli = w.climates[w.climate[y, x]]
            cliff = self.cliff.get(cli, "cliff_stone")
            if not t.has(cliff):
                cliff = "cliff_stone"
            img = t.tile(cliff, (x * 5 + y * 3) % t.count(cliff))
            off = t.surface_offset(cliff)
            cover = max(1, t.face_height(cliff) // LH)
            fl = L - cover
            fills = []
            while fl > L - drop - 1 and fl >= 0:
                fills.append(fl)
                fl -= cover
            for f in reversed(fills):
                canvas.paste(img, (base_x, base_y - f * LH + off), img)
            canvas.paste(img, (base_x, base_y - L * LH + off), img)
            return

        img = t.tile(cat, v)
        canvas.paste(img, (base_x, base_y - L * LH + t.surface_offset(cat)), img)


def render_window(world: BigWorld, cx0: int, cy0: int, cx1: int, cy1: int,
                  ctx: RenderCtx | None = None) -> Image.Image:
    """Full-res iso render of the cell rect [cx0..cx1) x [cy0..cy1)."""
    ctx = ctx or RenderCtx(world)
    W, H = world.w, world.h
    # screen origin of the whole world
    ox = (H - 1) * DX + MARGIN
    oy = int(world.level.max()) * LH + 140 + MARGIN
    # screen bounds of the window
    xs, ys = [], []
    for (cx, cy) in ((cx0, cy0), (cx1, cy0), (cx0, cy1), (cx1, cy1)):
        xs.append(ox + (cx - cy) * DX)
        ys.append(oy + (cx + cy) * DY)
    x0, x1 = min(xs) - 80, max(xs) + 144
    y0, y1 = min(ys) - 320, max(ys) + 220
    canvas = Image.new("RGBA", (x1 - x0, y1 - y0), ctx.seacolor)
    pad = 10
    for s in range(max(0, cx0 + cy0 - pad), min(W + H - 1, cx1 + cy1 + pad)):
        base_y = oy + s * DY
        if base_y < y0 - 100 or base_y > y1 + 420:
            continue
        for x in range(max(0, s - H + 1, cx0 - pad), min(W, s + 1, cx1 + pad)):
            y = s - x
            if y < max(0, cy0 - pad) or y >= min(H, cy1 + pad):
                continue
            if ctx.skip[y, x]:
                continue
            base_x = ox + (x - y) * DX
            if base_x + 64 < x0 or base_x > x1:
                continue
            ctx.draw_cell(canvas, x, y, base_x - x0, base_y - y0)
    return canvas


def render_overview(world: BigWorld, scale: float = 0.25,
                    band_px: int = 1560) -> Image.Image:
    """Whole-world iso render, banded by screen rows then downscaled."""
    ctx = RenderCtx(world)
    W, H = world.w, world.h
    ox = (H - 1) * DX + MARGIN
    maxL = int(world.level.max())
    oy = maxL * LH + 140 + MARGIN
    full_w = (W + H) * DX + MARGIN * 2
    full_h = (W + H) * DY + 64 + maxL * LH + 300
    out = Image.new("RGB", (int(full_w * scale), int(full_h * scale)), ctx.seacolor[:3])

    reach_up = maxL * LH + 300      # how far above base_y a cell can draw
    reach_dn = 64 + 90
    for b0 in range(0, full_h, band_px):
        b1 = min(full_h, b0 + band_px)
        band = Image.new("RGBA", (full_w, b1 - b0), ctx.seacolor)
        s_lo = max(0, (b0 - reach_dn - oy) // DY)
        s_hi = min(W + H - 1, (b1 + reach_up - oy) // DY + 1)
        for s in range(int(s_lo), int(s_hi)):
            base_y = oy + s * DY
            if base_y + reach_dn < b0 or base_y - reach_up > b1:
                continue
            x_lo, x_hi = max(0, s - H + 1), min(W, s + 1)
            for x in range(x_lo, x_hi):
                y = s - x
                if ctx.skip[y, x]:
                    continue
                ctx.draw_cell(band, x, y, ox + (x - y) * DX, base_y - b0)
        band = band.convert("RGB").resize(
            (int(full_w * scale), max(1, int((b1 - b0) * scale))), Image.LANCZOS)
        out.paste(band, (0, int(b0 * scale)))
    return out


def render_minimap(world: BigWorld, px: int = 3) -> Image.Image:
    """Top-down chart: census top-face colors + hillshade + terrace edges."""
    ctx = RenderCtx(world)
    H, W = world.h, world.w
    img = np.zeros((H, W, 3), np.uint8)
    for y in range(H):
        for x in range(W):
            cat = world.cats[world.terr[y, x]]
            col = ctx.topcol.get((cat, int(world.variant[y, x])))
            if col is None:
                col = ctx.topcol.get((cat, 0), (120, 120, 120))
            L = int(world.level[y, x])
            f = 0.78 + 0.035 * L
            img[y, x] = [min(255, int(c * f)) for c in col]
    # terrace edge darkening
    lvl = world.level
    edge = np.zeros((H, W), bool)
    edge[:, :-1] |= lvl[:, :-1] > lvl[:, 1:]
    edge[:-1, :] |= lvl[:-1, :] > lvl[1:, :]
    img[edge] = (img[edge] * 0.55).astype(np.uint8)
    return Image.fromarray(img).resize((W * px, H * px), Image.NEAREST)
