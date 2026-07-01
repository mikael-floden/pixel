"""Assemble a self-contained map zone from a worldgen layout + shared assets.

This is where a corner-height grid (worldgen) and Wang tilesets/objects (assets)
become a game-ready **loading zone**: a folder under `maps/<zone_id>/` holding a
`zone.json` manifest, a per-zone tile atlas, the object sprites it uses, a
collision grid, and a rendered `preview.png`. No PixelLab calls happen here — it
is pure packaging, so it's cheap and deterministic. The output format is
documented in maps/README.md.

Dual-grid → Wang tile selection
-------------------------------
The layout is a grid of terrain LEVELS defined on tile *corners*. `levels` is the
ordered list of terrain names; `bands` is a list of Wang-tileset ids where
`bands[k]` draws the boundary between level k (its 'lower') and level k+1 (its
'upper'). worldgen guarantees each tile cell spans at most two *adjacent* levels,
so every cell maps onto exactly one band, and we pick the tile whose four corners
match the cell's four corner levels.
"""

from __future__ import annotations

import json
import os
import shutil

from PIL import Image

import assets

ROOT = os.path.dirname(os.path.dirname(__file__))
SCHEMA = "pixel-maps/zone@1"


def zone_dir(zid):
    return os.path.join(ROOT, zid)


def zone_exists(zid):
    return os.path.exists(os.path.join(zone_dir(zid), "zone.json"))


def list_zones():
    """Every built zone (any top-level maps/ subfolder holding a zone.json)."""
    out = []
    for name in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, name, "zone.json")
        if os.path.isfile(p):
            with open(p) as f:
                out.append(json.load(f))
    return out


# --- corner grid -> per-cell band + corner labels ---------------------------

def _cell_band_and_labels(H, col, row, levels, bands):
    """For tile cell (col,row) return (band_index, {NW,NE,SW,SE: 'lower'/'upper'})
    or None if the cell can't be represented (shouldn't happen after smoothing)."""
    corners = {
        "NW": H[row][col], "NE": H[row][col + 1],
        "SW": H[row + 1][col], "SE": H[row + 1][col + 1],
    }
    lo, hi = min(corners.values()), max(corners.values())
    top = len(levels) - 1
    nbands = len(bands)
    if hi - lo > 1:
        return None
    if hi == lo:                                   # flat cell
        if lo <= 0:
            b, base = 0, 0
        elif lo >= top:
            b, base = nbands - 1, top - 1
        else:
            b, base = lo, lo
    else:                                          # spans two adjacent levels
        b, base = lo, lo
    b = max(0, min(nbands - 1, b))
    labels = {k: ("lower" if v == base else "upper") for k, v in corners.items()}
    return b, labels


def _tile_lookup(tileset):
    """{(NW,NE,SW,SE): tile} for a loaded Wang tileset (all 16 combos present)."""
    out = {}
    for t in tileset["tiles"]:
        c = t["corners"]
        out[(c["NW"], c["NE"], c["SW"], c["SE"])] = t
    return out


# --- atlas ------------------------------------------------------------------

def _build_atlas(used, tile_size, columns=16):
    """`used` = ordered list of (tileset_id, tile_name, corners, PIL). Lay tiles
    on a fixed-column grid. Returns (atlas_image, tiles_json_list)."""
    n = len(used)
    cols = min(columns, n) or 1
    rows = (n + cols - 1) // cols
    atlas = Image.new("RGBA", (cols * tile_size, rows * tile_size), (0, 0, 0, 0))
    meta = []
    for i, (tsid, name, corners, img) in enumerate(used):
        ac, ar = i % cols, i // cols
        atlas.alpha_composite(img.convert("RGBA"), (ac * tile_size, ar * tile_size))
        meta.append({
            "index": i, "tileset": tsid, "tile": name, "corners": corners,
            "atlas": [ac, ar], "px": [ac * tile_size, ar * tile_size],
        })
    return atlas, meta, cols


# --- main assembly ----------------------------------------------------------

def build_zone(cfg, zone_def, layout, preview_scale=3):
    """Bake a zone folder from a zone definition + a worldgen layout.

    layout = {"H": corner grid, "objects":[(id,col,row)], "exits":[{...}]}
    Returns the written zone.json manifest dict.
    """
    zid = zone_def["id"]
    levels = zone_def["levels"]
    bands = zone_def["bands"]
    H = layout["H"]
    rows, cols = len(H) - 1, len(H[0]) - 1

    tilesets = {b: assets.load_tileset(b) for b in bands}
    lookups = {b: _tile_lookup(ts) for b, ts in tilesets.items()}
    tile_size = tilesets[bands[0]]["tile_size"]

    # 1) choose a tile per cell, collecting the unique tiles into an atlas
    used_index = {}                     # (tileset_id, tile_name) -> atlas index
    used_list = []
    grid = [[-1] * cols for _ in range(rows)]
    for r in range(rows):
        for c in range(cols):
            sel = _cell_band_and_labels(H, c, r, levels, bands)
            if sel is None:
                continue
            b, labels = sel
            tsid = bands[b]
            key = (labels["NW"], labels["NE"], labels["SW"], labels["SE"])
            tile = lookups[tsid].get(key)
            if tile is None:
                continue
            uid = (tsid, tile["name"])
            if uid not in used_index:
                used_index[uid] = len(used_list)
                used_list.append((tsid, tile["name"], tile["corners"], tile["image"]))
            grid[r][c] = used_index[uid]

    atlas, tiles_meta, atlas_cols = _build_atlas(used_list, tile_size)

    zdir = zone_dir(zid)
    if os.path.isdir(zdir):
        # clear stale generated artefacts (keep nothing — fully rebuilt)
        for sub in ("objects",):
            p = os.path.join(zdir, sub)
            if os.path.isdir(p):
                shutil.rmtree(p)
    os.makedirs(zdir, exist_ok=True)
    atlas.save(os.path.join(zdir, "tiles.png"))
    _write_json(os.path.join(zdir, "tiles.json"), {
        "atlas": "tiles.png", "tile_size": tile_size,
        "columns": atlas_cols, "count": len(tiles_meta), "tiles": tiles_meta,
    })

    # 2) collision from terrain (blocked levels) — before objects
    block_levels = set(zone_def.get("block_levels", []))
    collision = [[0] * cols for _ in range(rows)]
    for r in range(rows):
        for c in range(cols):
            dom = max(H[r][c], H[r][c + 1], H[r + 1][c], H[r + 1][c + 1])
            name = levels[dom] if dom < len(levels) else None
            if name in block_levels:
                collision[r][c] = 1

    # 3) objects — copy sprites in, place, and add their footprint to collision
    obj_records = []
    copied = set()
    canvas = atlas  # placeholder; real preview canvas built below
    preview = Image.new("RGBA", (cols * tile_size, rows * tile_size), (0, 0, 0, 0))
    # paint terrain onto preview
    for r in range(rows):
        for c in range(cols):
            idx = grid[r][c]
            if idx < 0:
                continue
            m = tiles_meta[idx]
            tile_img = atlas.crop((m["px"][0], m["px"][1],
                                   m["px"][0] + tile_size, m["px"][1] + tile_size))
            preview.alpha_composite(tile_img, (c * tile_size, r * tile_size))

    for (oid, col, row) in sorted(layout.get("objects", []), key=lambda p: p[2]):
        ometa = assets.load_object(oid)
        if not ometa:
            continue
        if oid not in copied:
            os.makedirs(os.path.join(zdir, "objects"), exist_ok=True)
            ometa["image"].save(os.path.join(zdir, "objects", f"{oid}.png"))
            copied.add(oid)
        img = ometa["image"]
        # anchor bottom-centre on the cell
        px = col * tile_size + tile_size // 2 - img.width // 2
        py = (row + 1) * tile_size - img.height
        preview.alpha_composite(img, (px, py))
        blocks = bool(ometa.get("blocks", True))
        obj_records.append({
            "id": oid, "file": f"objects/{oid}.png", "tile": [col, row],
            "x": px, "y": py, "anchor": "bottom-center", "blocks": blocks,
        })
        if blocks:
            fp = assets.footprint_tiles(ometa, tile_size)
            hw = fp // 2
            for dr in range(-(fp - 1), 1):
                for dc in range(-hw, hw + 1):
                    rr, cc = row + dr, col + dc
                    if 0 <= rr < rows and 0 <= cc < cols:
                        collision[rr][cc] = 1

    # 4) exits -> pixel coords
    exits = []
    for ex in layout.get("exits", []):
        c, r = ex["tile"]
        exits.append({
            "id": ex["id"], "kind": ex.get("kind", "door"),
            "tile": [c, r], "x": c * tile_size, "y": r * tile_size,
            "to_zone": ex.get("to_zone"), "to_exit": ex.get("to_exit"),
        })

    # 5) scaled preview for legible mobile viewing
    if preview_scale and preview_scale != 1:
        preview = preview.resize(
            (preview.width * preview_scale, preview.height * preview_scale), Image.NEAREST)
    preview.save(os.path.join(zdir, "preview.png"))

    # 6) manifest
    manifest = {
        "schema": SCHEMA,
        "id": zid, "kind": zone_def["kind"], "archetype": zone_def.get("archetype"),
        "title": zone_def.get("title", zid), "description": zone_def.get("description", ""),
        "view": tilesets[bands[0]]["view"], "tile_size": tile_size,
        "seed": zone_def.get("seed"),
        "grid": {"width": cols, "height": rows},
        "pixel_size": {"width": cols * tile_size, "height": rows * tile_size},
        "levels": levels, "bands": bands,
        "layers": [{
            "name": "terrain", "type": "tilelayer",
            "width": cols, "height": rows,
            "encoding": "tile-index-grid", "tileset": "tiles.json",
            "empty": -1, "data": grid,
        }],
        "tileset": {"source": "tiles.json", "atlas": "tiles.png",
                     "tile_size": tile_size, "columns": atlas_cols,
                     "count": len(tiles_meta)},
        "corner_heights": {"width": cols + 1, "height": rows + 1,
                            "note": "terrain level index per tile corner (dual-grid source)",
                            "data": H},
        "objects": obj_records,
        "collision": {"encoding": "walkable-grid", "width": cols, "height": rows,
                       "legend": {"0": "walkable", "1": "blocked"}, "data": collision},
        "exits": exits,
        "preview": "preview.png", "preview_scale": preview_scale,
        "provenance": {
            "generator": "maps/pipeline",
            "tilesets": {b: tilesets[b].get("pixellab_tileset_id") for b in bands},
        },
    }
    _write_json(os.path.join(zdir, "zone.json"), manifest)
    return manifest


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
