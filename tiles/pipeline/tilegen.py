"""Generate one focused isometric tile set and download it to tiles/<category>/.

Each category is a single create-tiles-pro call at the fixed house format
(64px, 28-degree view angle, 50% thickness, isometric). We save every tile as a
PNG plus a `tiles.json` manifest (params + per-tile file/size) and a preview
sheet, so the Maps agent can consume them directly.
"""

from __future__ import annotations

import json
import os
import zlib

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(__file__))  # tiles/


def _seed(*parts):
    return zlib.crc32("::".join(str(p) for p in parts).encode()) % (2 ** 31)


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
    tiles = client.create_tiles(
        description=cat["description"],
        tile_size=t["size"], view_angle=t["view_angle"],
        depth_ratio=t["depth_ratio"], tile_type=t.get("type", "isometric"),
        flat_top_px=t.get("flat_top_px", 4), seed=_seed(cid))
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
        "depth_ratio": t["depth_ratio"], "flat_top_px": t.get("flat_top_px", 4),
        "count": len(tile_meta), "tiles": tile_meta,
        "preview": "preview.png",
        "provenance": "pixellab create-tiles-pro (isometric)",
    }
    with open(os.path.join(cdir, "tiles.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    return manifest
