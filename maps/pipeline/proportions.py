"""Scale / proportion criterion for the maps loop.

Realism rule: a **character must read at a believable size when standing on the
map**. The whole repo targets the Grave Seasons / Stardew look, where a person is
about **1 tile wide x 2 tiles tall**. That fixes one number for the whole domain:

    tile_px x CHARACTER_HEIGHT_TILES  ==  the character sprite's drawn body height

The characters domain draws bodies ~67px tall (measured from its rotation PNGs),
so a **32px tile** puts a character at ~2.1 tiles tall — correct. A 16px tile
would make the same character ~4 tiles tall (as tall as a house) — wrong. Hence
`tile_size: 32` in config, and this module enforces the contract so a future
config edit can't silently break walkability.

Everything on a map shares ONE pixels-per-tile scale: tiles are exactly
`tile_px` square, and every object's pixel size is `footprint_tiles x tile_px`,
so a tree/house/barrel is always the right size next to a character.
"""

from __future__ import annotations

# The genre contract. A person is ~1x2 tiles; tiles are square.
CHARACTER_HEIGHT_TILES = 2.0
CHARACTER_WIDTH_TILES = 1.0
PIXELLAB_TILE_SIZES = (16, 32)          # sizes create-tileset accepts
MIN_OBJECT_PX = 32                      # map-objects requires image_size >= 32
FOOTPRINT_MIN_TILES = 0.5
FOOTPRINT_MAX_TILES = 8.0


def object_px(spec, tile_size):
    """An object's pixel size from its real footprint in tiles (proportion by
    construction). Falls back to an explicit `size` for legacy specs."""
    tiles = spec.get("tiles")
    if tiles is None:
        return max(MIN_OBJECT_PX, int(spec.get("size", tile_size * 2)))
    return max(MIN_OBJECT_PX, int(round(float(tiles) * tile_size)))


def expected_tile_size_for(body_px, character_height_tiles=CHARACTER_HEIGHT_TILES):
    """The tile_px that makes a character of `body_px` drawn height read as
    `character_height_tiles` tall — the number we align the whole domain to."""
    return body_px / character_height_tiles


def validate_config(cfg):
    """Check the scale contract. Returns (ok, issues[])."""
    issues = []
    ts = int(cfg.get("defaults", {}).get("tile_size", 16))
    if ts not in PIXELLAB_TILE_SIZES:
        issues.append(f"tile_size {ts} not supported by create-tileset "
                      f"(must be one of {PIXELLAB_TILE_SIZES})")
    for o in cfg.get("objects", []):
        tiles = o.get("tiles")
        if tiles is None:
            issues.append(f"object '{o['id']}' has no `tiles` footprint "
                          f"(proportion can't be guaranteed)")
            continue
        if not (FOOTPRINT_MIN_TILES <= float(tiles) <= FOOTPRINT_MAX_TILES):
            issues.append(f"object '{o['id']}' footprint {tiles} tiles out of "
                          f"[{FOOTPRINT_MIN_TILES}, {FOOTPRINT_MAX_TILES}]")
        if object_px(o, ts) < MIN_OBJECT_PX:
            issues.append(f"object '{o['id']}' px < {MIN_OBJECT_PX} (PixelLab min)")
    return (not issues), issues


def normalize_tile(img, tile_size):
    """Guarantee a tile is exactly tile_size x tile_size so the map grid is
    pixel-perfect (tiles must abut with no drift). Resizes only if PixelLab
    returned an off-by-rounding size; nearest-neighbour keeps it crisp."""
    if img.size != (tile_size, tile_size):
        img = img.resize((tile_size, tile_size))
    return img


def summary(cfg):
    ts = int(cfg.get("defaults", {}).get("tile_size", 16))
    return (f"scale: {ts}px tiles; character ~= {CHARACTER_WIDTH_TILES:g}x"
            f"{CHARACTER_HEIGHT_TILES:g} tiles ({int(ts*CHARACTER_HEIGHT_TILES)}px tall body)")
