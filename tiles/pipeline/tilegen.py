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

import roads

ROOT = os.path.dirname(os.path.dirname(__file__))  # tiles/
ENDPOINT = "/create-tiles-pro"

# Elevation model (verified on real tiles): the vertical side-face height is
#   face_px ~= depth_ratio * (tile_height - DIAMOND_TOP_H)
# ONE ELEVATION LEVEL is the flat ground tile's own face — a 64x64 @ 50% tile,
# measured at exactly 19px. This matches the unit the Maps agent terraces by. To
# raise a tile N levels, subtract N*ONE_LAYER_PX from its screen-Y.
#   flat   64x64  @ 50%  -> 19px  = 1 level   (exact; the base slab)
#   raised 64x64  @ 100% -> 38px  = 2 levels  (exact; same box, 2x depth)
#   cliff  64x128 @ 75%  -> ~76px ~ 4 levels  (SCENERY: fractional, top/bottom-anchored)
#   tall   64x128 @ 100% -> ~102px ~ 5 levels (SCENERY: fractional, top/bottom-anchored)
# Only the 64x64 tiles land on exact levels; the 64x128 tiles are scenery whose
# faces are NOT exact multiples — place them by the measured `base_y` anchor.
DIAMOND_TOP_H = 26          # diamond top height at tile_size 64, 28 deg, flat_top 4
ONE_LAYER_PX = 19          # 64x64 @ 50% face = one elevation level (measured, exact)


def stacking_info(geometry, tile_size=64, tile_height=None):
    """Elevation/stacking guidance for one set, from its measured geometry."""
    face = geometry.get("level_height")
    layers = round(face / ONE_LAYER_PX, 2) if face else None
    # 64x64 tiles align to exact levels; 64x128 scenery tiles do not.
    box_h = tile_height or tile_size
    exact = box_h <= tile_size
    return {
        "face_height_px": face,
        "one_layer_px": ONE_LAYER_PX,
        "layers": layers,
        "levels": round(layers) if layers is not None else None,
        "align": "exact" if exact else "scenery",
        "diamond_top_height_px": geometry.get("diamond_top_height"),
        "apex_y": geometry.get("apex_y"),
        "base_y": geometry.get("base_y"),
        "image_height": geometry.get("image_height"),
        "grid_dx": geometry.get("grid_dx"),
        "grid_dy": geometry.get("grid_dy"),
        "formula": ("One elevation level = 19px (a 64x64 @ 50% flat tile's face). "
                    "Raise a tile N levels by subtracting N*19 from screen_y; draw "
                    "back-to-front by (col+row), then by level. EXACT tiles (64x64: "
                    "flat=1 level, raised=2 levels) terrace perfectly. SCENERY tiles "
                    "(64x128 cliff/tall) have fractional faces (`layers`) — do NOT use "
                    "them as exact steps; anchor them by `base_y` (the footprint's "
                    "front tip is at image row base_y, identical across thicknesses, "
                    "so bottom-anchoring needs no per-tile correction)."),
    }


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
    centre = np.where(alpha[:, cx])[0]
    apex_y = int(centre.min())              # topmost solid pixel at centre column
    base_y = int(centre.max())              # front tip of the footprint diamond
    leftcol = np.where(alpha[:, xmin])[0]
    left_corner_y = int(leftcol.min())
    level_height = int(leftcol.max() - leftcol.min() + 1)   # side-face height
    dy = left_corner_y - apex_y                             # half diamond-top height
    return {
        "grid_dx": tile_size // 2,          # screen x step per (col-row)
        "grid_dy": dy,                       # screen y step per (col+row)
        "diamond_top_height": dy * 2,
        "level_height": level_height,        # side-face height of THIS tile
        "apex_y": apex_y,                    # top of the sprite in the image
        "base_y": base_y,                    # footprint front tip (bottom anchor)
        "image_height": int(a.shape[0]),
        "note": "screen_x=ox+(col-row)*grid_dx; screen_y=oy+(col+row)*grid_dy; "
                "one level = 19px (subtract N*19 from screen_y to raise N levels); "
                "bottom-anchor by base_y (footprint front tip) so tiles of any "
                "thickness line up without per-tile correction; draw back-to-front "
                "by (col+row) then by level.",
    }


def set_geometry(images, tile_size):
    """Measure every tile and return (set_geometry, per_tile). The set geometry
    is the MEDIAN across tiles (robust to odd pieces like inner corners); per_tile
    carries each tile's own apex_y/base_y/face_px so the Maps agent can anchor
    each sprite exactly, with no per-tile pixel hunting."""
    per_tile, geoms = [], []
    for im in images:
        g = measure_geometry(im, tile_size)
        geoms.append(g)
        per_tile.append({
            "apex_y": g.get("apex_y"), "base_y": g.get("base_y"),
            "face_px": g.get("level_height"),
        })
    if not geoms:
        return {}, per_tile

    def med(key):
        vals = [g[key] for g in geoms if g.get(key) is not None]
        return int(np.median(vals)) if vals else None

    dy = med("grid_dy")
    geometry = {
        "grid_dx": tile_size // 2,
        "grid_dy": dy,
        "diamond_top_height": dy * 2 if dy is not None else None,
        "level_height": med("level_height"),
        "apex_y": med("apex_y"),
        "base_y": med("base_y"),
        "image_height": med("image_height"),
        "note": geoms[0].get("note"),
    }
    return geometry, per_tile


def category_dir(cid):
    return os.path.join(ROOT, cid)


def category_done(cid):
    return os.path.isfile(os.path.join(category_dir(cid), "tiles.json"))


RESERVED_DIRS = {"config", "pipeline"}


def list_categories():
    out = []
    for name in sorted(os.listdir(ROOT)):
        if name in RESERVED_DIRS:
            continue
        p = os.path.join(ROOT, name, "tiles.json")
        if os.path.isfile(p):
            with open(p) as f:
                m = json.load(f)
            # Only real tile-set manifests (guards against stray config files).
            if m.get("schema") == "pixel-tiles/set@1":
                out.append(m)
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
    # `seed` override lets us reroll a category that generated malformed (same id
    # otherwise derives the same deterministic seed and reproduces the fault).
    seed = cat.get("seed") if cat.get("seed") is not None else _seed(cid)
    request = {
        "endpoint": ENDPOINT, "tile_type": t.get("type", "isometric"),
        "tile_size": t["size"], "tile_view_angle": t["view_angle"],
        "tile_depth_ratio": depth, "tile_flat_top_px": t.get("flat_top_px", 4),
        "tile_height": tile_height, "seed": seed, "description": cat["description"],
    }
    tiles = client.create_tiles(
        description=cat["description"],
        tile_size=t["size"], view_angle=t["view_angle"],
        depth_ratio=depth, tile_type=t.get("type", "isometric"),
        flat_top_px=t.get("flat_top_px", 4), tile_height=tile_height,
        seed=seed)
    # Roads: guarantee BOTH diagonal directions (and more corner variety) by
    # appending horizontal mirrors — a left-right flip swaps the road's diagonal.
    n_orig = len(tiles)
    mirror_src = []
    if cat.get("road"):
        tiles, mirror_src = roads.mirror_balance(tiles)
    cdir = category_dir(cid)
    os.makedirs(cdir, exist_ok=True)
    geometry, per_tile = set_geometry(tiles, t["size"])
    tile_meta = []
    for i, im in enumerate(tiles):
        fname = f"tile_{i:02d}.png"
        im.save(os.path.join(cdir, fname))
        meta = {"index": i, "file": fname, "width": im.width,
                "height": im.height, **per_tile[i]}
        if i >= n_orig:                       # an appended mirror
            meta["mirrored"] = True
            meta["mirror_of"] = mirror_src[i - n_orig]
        tile_meta.append(meta)
    _preview(tiles, os.path.join(cdir, "preview.png"))
    manifest = {
        "schema": "pixel-tiles/set@1",
        "category": cid, "description": cat["description"],
        "kind": cat.get("kind", "ground"),
        "tile_type": t.get("type", "isometric"),
        "tile_size": t["size"], "view_angle": t["view_angle"],
        "depth_ratio": depth, "flat_top_px": t.get("flat_top_px", 4),
        "tile_height": tile_height,
        "profile": cat.get("profile"),
        "geometry": geometry,
        "stacking": stacking_info(geometry, t["size"], tile_height),
        "count": len(tile_meta), "tiles": tile_meta,
        "preview": "preview.png",
        **({"road": cat["road"]} if cat.get("road") else {}),
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "provenance": {"tool": "pixellab", "endpoint": ENDPOINT, "seed": seed,
                       "request": request},
    }
    with open(os.path.join(cdir, "tiles.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    return manifest
