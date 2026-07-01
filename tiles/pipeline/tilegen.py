"""Generate one focused isometric tile set and download it to tiles/<category>/.

Each category is a single create-tiles-pro call at the fixed house format
(64px, 28-degree view angle, 50% thickness, isometric). We save every tile as a
PNG plus a `tiles.json` manifest (params + per-tile file/size) and a preview
sheet, so the Maps agent can consume them directly.
"""

from __future__ import annotations

import datetime
import json
import os
import zlib

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(__file__))  # tiles/
ENDPOINT = "/create-tiles-pro"


def _seed(*parts):
    return zlib.crc32("::".join(str(p) for p in parts).encode()) % (2 ** 31)


def measure_geometry(img, tile_size):
    """Measure isometric alignment geometry from a rendered tile so the Maps
    agent can place/stack tiles exactly. Returns dict with the diamond-top
    height, the per-level vertical step (block side-face height), and the grid
    step (dx, dy). Same format params -> same geometry across all categories."""
    a = np.asarray(img.convert("RGBA"))
    alpha = a[:, :, 3] > 16
    cols = np.where(alpha.any(axis=0))[0]
    if len(cols) == 0:
        return {}
    xmin, xmax = int(cols.min()), int(cols.max())
    cx = (xmin + xmax) // 2
    apex_y = int(np.where(alpha[:, cx])[0].min())
    leftcol = np.where(alpha[:, xmin])[0]
    left_corner_y = int(leftcol.min())
    level_height = int(leftcol.max() - leftcol.min() + 1)   # side-face height
    dy = left_corner_y - apex_y                             # half diamond-top height
    return {
        "grid_dx": tile_size // 2,          # screen x step per (col-row)
        "grid_dy": dy,                       # screen y step per (col+row)
        "diamond_top_height": dy * 2,
        "level_height": level_height,        # offset up by this per elevation level
        "note": "screen_x=ox+(col-row)*grid_dx; screen_y=oy+(col+row)*grid_dy; "
                "raise one level by subtracting level_height from screen_y; "
                "draw back-to-front by (col+row) then by level.",
    }


def category_dir(cid):
    return os.path.join(ROOT, cid)


def category_done(cid):
    return os.path.isfile(os.path.join(category_dir(cid), "tiles.json"))


def list_categories():
    out = []
    for name in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, name, "tiles.json")
        if os.path.isfile(p):
            with open(p) as f:
                out.append(json.load(f))
    return out


def _preview(tiles, path, scale=2):
    if not tiles:
        return
    pad = 6
    h = max(t.height for t in tiles)
    w = sum(t.width for t in tiles) + pad * (len(tiles) + 1)
    sheet = Image.new("RGBA", (w, h + pad * 2), (40, 44, 52, 255))
    x = pad
    for t in tiles:
        sheet.alpha_composite(t, (x, pad + (h - t.height)))
        x += t.width + pad
    sheet.resize((sheet.width * scale, sheet.height * scale), Image.NEAREST).save(path)


def generate_category(client, cfg, cat):
    """Generate + download one focused tile set. Returns the manifest dict."""
    cid = cat["id"]
    t = cfg["tile"]
    # Elevation categories may override height/depth to make TALL tiles (cliffs,
    # walls) on the same footprint; the format is otherwise fixed.
    depth = cat.get("depth_ratio", t["depth_ratio"])
    tile_height = cat.get("tile_height")
    tiles = client.create_tiles(
        description=cat["description"],
        tile_size=t["size"], view_angle=t["view_angle"],
        depth_ratio=depth, tile_type=t.get("type", "isometric"),
        flat_top_px=t.get("flat_top_px", 4), tile_height=tile_height,
        seed=_seed(cid))
    cdir = category_dir(cid)
    os.makedirs(cdir, exist_ok=True)
    tile_meta = []
    for i, im in enumerate(tiles):
        fname = f"tile_{i:02d}.png"
        im.save(os.path.join(cdir, fname))
        tile_meta.append({"index": i, "file": fname, "width": im.width, "height": im.height})
    _preview(tiles, os.path.join(cdir, "preview.png"))
    manifest = {
        "schema": "pixel-tiles/set@1",
        "category": cid, "description": cat["description"],
        "tile_type": t.get("type", "isometric"),
        "tile_size": t["size"], "view_angle": t["view_angle"],
        "depth_ratio": depth, "flat_top_px": t.get("flat_top_px", 4),
        "tile_height": tile_height, "kind": cat.get("kind", "ground"),
        "count": len(tile_meta), "tiles": tile_meta,
        "preview": "preview.png",
        "provenance": "pixellab create-tiles-pro (isometric)",
    }
    with open(os.path.join(cdir, "tiles.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    return manifest
