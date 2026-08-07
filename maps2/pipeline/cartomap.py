"""CARTOGRAPHIC map render — the Map tab's base layer (maintainer 2026-08-06).

The in-game Map tab was `<img src=minimap.webp>` plus one red dot: a *photograph*
of the world, at 300px, with nowhere to put information. This draws a MAP
instead — the same iso projection the game already knows, but every pixel chosen
to be read rather than admired:

  * a cartographic PALETTE per material instead of tile art, so shapes read at
    thumbnail size where 64px tile detail turns to mush;
  * HILLSHADE from the level grid — a north-west sun, so the mountain, the gorge
    and the terraces have form instead of being flat colour;
  * CLIFF FACES darkened by height, so elevation reads as elevation;
  * a COASTLINE stroke and a shallow-water shelf, the two things that make a
    landmass look drawn rather than screenshotted;
  * ROADS as roads — the dirt network is what turns a picture of terrain into
    something a player can navigate by.

Everything else (player, NPCs, shops, the cave mouth, danger, fog) is a LIVE
overlay drawn by the client on top of this, from the sidecars maps2 already
ships. This file deliberately renders only what never changes.

    python maps2/pipeline/cartomap.py the_island2
    python maps2/pipeline/cartomap.py              # every world
"""

from __future__ import annotations

import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
WORLDS = os.path.join(MAPS2, "worlds")

DX, DY, LEVEL_PX = 32, 15, 16      # the project's iso, same as render2/tiles2lib
MARGIN = 12

# Cartographic palette. Not the tile colours — those are lit, textured and
# similar to each other by design (they have to tile seamlessly). A map needs
# the opposite: flat, separable, and ordered so that height reads as height.
PALETTE = {
    "clear_water":     (38, 86, 122),
    "light_sand":      (214, 194, 148),
    "saturated_grass": (86, 124, 74),
    "lightdark_dirt":  (150, 118, 84),
    "stone_mountain":  (140, 140, 146),
    "black_mountain":  (74, 72, 80),
    "regular_snow":    (232, 236, 240),
    "crystal_ice":     (158, 200, 216),
    "":                (0, 0, 0),
}
DEEP = (24, 58, 92)         # open ocean, away from the shore shelf
SHELF = (58, 116, 150)      # shallow water hugging the coast
ROAD = (198, 168, 116)      # the dirt network, lifted so it reads as a route
COAST = (18, 40, 62)        # coastline stroke

SUN = (-0.6, -0.8)          # north-west, the cartographer's convention
SHADE = 0.55                # how hard the hillshade bites
FACE_DARK = 0.62            # cliff faces, relative to their top


def _load(name):
    doc = json.load(open(os.path.join(WORLDS, name, "world.json")))
    W, H = doc["size"]["w"], doc["size"]["h"]
    mats = doc["materials"]
    mat = np.array([[mats[i] for i in row] for row in doc["mat"]], object)
    lvl = np.array(doc["level"], np.int16)
    return doc, W, H, mat, lvl


def _shade(lvl, mat, water):
    """Hillshade: dot the surface normal with a low north-west sun.

    Elevation is integer levels, so a plain gradient is blocky steps. Blurring
    the height field FIRST gives smooth relief while the cliff-face darkening
    below keeps the hard edges crisp — the two together read as terrain rather
    than as a contour map."""
    h = lvl.astype(np.float32)
    # separable 5-tap blur, done in numpy so there is no mode/dtype dance with
    # Pillow over a float height field
    k = np.array([1, 4, 6, 4, 1], np.float32); k /= k.sum()
    hb = h
    for _ in range(2):
        pad = np.pad(hb, ((0, 0), (2, 2)), mode="edge")
        hb = sum(k[i] * pad[:, i:i + hb.shape[1]] for i in range(5))
        pad = np.pad(hb, ((2, 2), (0, 0)), mode="edge")
        hb = sum(k[i] * pad[i:i + hb.shape[0], :] for i in range(5))
    gy, gx = np.gradient(hb)
    nx, ny = -gx, -gy
    nz = np.ones_like(hb) * 2.2
    n = np.sqrt(nx * nx + ny * ny + nz * nz)
    s = (nx * SUN[0] + ny * SUN[1] + nz * 1.0) / (n * math.sqrt(SUN[0] ** 2 + SUN[1] ** 2 + 1))
    s = np.clip(s, -1, 1)
    out = 1.0 + (s - 0.72) * SHADE
    out[water] = 1.0
    return np.clip(out, 0.55, 1.35)


def render(name, scale=1.0):
    doc, W, H, mat, lvl = _load(name)
    waterset = set(doc.get("water", ["clear_water"]))
    water = np.isin(mat.astype(str), list(waterset)) | (mat.astype(str) == "")
    land = ~water
    shade = _shade(lvl, mat, water)

    # SHALLOW SHELF: water within a few cells of land. One cheap dilation pass
    # per ring — the halo is what makes a coast look like a coast.
    near = land.copy()
    shelf = np.zeros_like(land)
    for _ in range(3):
        n2 = near.copy()
        n2[:, :-1] |= near[:, 1:]; n2[:, 1:] |= near[:, :-1]
        n2[:-1, :] |= near[1:, :]; n2[1:, :] |= near[:-1, :]
        shelf |= (n2 & water)
        near = n2

    maxL = int(lvl.max())
    ox = (H - 1) * DX + MARGIN
    oy = maxL * LEVEL_PX + 40 + MARGIN
    fullW = (W + H) * DX + MARGIN * 2
    fullH = (W + H) * DY + 64 + maxL * LEVEL_PX + 80
    img = Image.new("RGBA", (fullW, fullH), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def tint(rgb, f):
        return tuple(max(0, min(255, int(c * f))) for c in rgb)

    # Painter's order, exactly the game's: by (x+y), then y.
    for s in range(W + H - 1):
        for x in range(max(0, s - H + 1), min(W, s + 1)):
            y = s - x
            m = str(mat[y, x])
            if m == "":
                continue
            bx = ox + (x - y) * DX
            by = oy + (x + y) * DY
            L = int(lvl[y, x])
            is_w = m in waterset
            if is_w:
                base = SHELF if shelf[y, x] else DEEP
            else:
                base = PALETTE.get(m, (128, 128, 128))
                if m == "lightdark_dirt":
                    base = ROAD
            top = tint(base, float(shade[y, x]))
            ty = by - L * LEVEL_PX
            # cliff face: everything below the top diamond, darkened by depth
            if L > 0 and not is_w:
                face = tint(base, FACE_DARK)
                d.polygon([(bx, ty + DY), (bx + DX, ty + DY * 2), (bx + DX * 2, ty + DY),
                           (bx + DX * 2, ty + DY + L * LEVEL_PX),
                           (bx + DX, ty + DY * 2 + L * LEVEL_PX),
                           (bx, ty + DY + L * LEVEL_PX)], fill=face)
            d.polygon([(bx, ty + DY), (bx + DX, ty), (bx + DX * 2, ty + DY),
                       (bx + DX, ty + DY * 2)], fill=top)

    # COASTLINE: stroke the land/water boundary. Drawn after the fill so it sits
    # on top of both, which is what gives the landmass a drawn edge.
    for y in range(H):
        for x in range(W):
            if not land[y, x]:
                continue
            L = int(lvl[y, x])
            bx = ox + (x - y) * DX
            ty = oy + (x + y) * DY - L * LEVEL_PX
            for dx, dy, a, b in ((1, 0, (DX * 2, DY), (DX, DY * 2)),
                                 (0, 1, (DX, DY * 2), (0, DY))):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H and water[ny, nx]:
                    d.line([(bx + a[0], ty + a[1]), (bx + b[0], ty + b[1])],
                           fill=COAST, width=2)
    if scale != 1.0:
        img = img.resize((int(fullW * scale), int(fullH * scale)), Image.LANCZOS)
    return img


MAX_W = 1600            # the tab shows this at ~300-800px; 1600 leaves plenty
                        # of headroom for pinch-zoom and keeps every world well
                        # under 200 KB. A 7948px render was 1.1 MB for nothing.


def build(name, scale=0.5):
    img = render(name, scale)
    bb = img.getbbox()          # crop the empty margin the iso canvas pads out
    if bb:
        img = img.crop(bb)
    if img.width > MAX_W:
        img = img.resize((MAX_W, max(1, round(img.height * MAX_W / img.width))),
                         Image.LANCZOS)
    out = os.path.join(WORLDS, name, "map_base.webp")
    img.save(out, lossless=True, method=4, exact=True)
    print(f"{name}: map_base.webp {img.size[0]}x{img.size[1]} "
          f"({os.path.getsize(out) // 1024} KB)")
    return out


def main():
    names = [a for a in sys.argv[1:] if not a.startswith("-")]
    names = names or sorted(n for n in os.listdir(WORLDS)
                            if os.path.isfile(os.path.join(WORLDS, n, "world.json")))
    for n in names:
        build(n)


if __name__ == "__main__":
    main()
