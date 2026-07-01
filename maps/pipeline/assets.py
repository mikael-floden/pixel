"""Shared, reusable art assets: Wang tilesets and map objects.

Terrain tilesets and props are *shared across zones* (an island and a harbour
town both reuse the same ocean/sand tileset and the same oak tree), so they live
here under `assets/` and are generated at most once. A zone references them by id;
zone.py copies just the tiles/props it actually uses into the zone folder so each
zone stays self-contained (see MAPS_SPEC.md).

Everything is filesystem-checked so the loop is resumable: an asset that already
has its `*.json` manifest is considered done and never regenerated.

Layout:
  assets/tilesets/<id>/tileset.json         params + per-tile corner data
  assets/tilesets/<id>/tiles/<name>.png     one PNG per Wang tile
  assets/objects/<id>/object.json           params
  assets/objects/<id>/object.png            transparent prop
"""

from __future__ import annotations

import json
import os
import zlib

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(__file__))
TILESETS_DIR = os.path.join(ROOT, "assets", "tilesets")
OBJECTS_DIR = os.path.join(ROOT, "assets", "objects")


# --- io helpers -------------------------------------------------------------

def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def _read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path) as f:
        return json.load(f)


def _save_png(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)


def _seed(*parts):
    return zlib.crc32("::".join(str(p) for p in parts).encode()) % (2 ** 31)


def _style(cfg, spec):
    d = cfg.get("defaults", {})
    return (spec.get("outline", d.get("outline")),
            spec.get("shading", d.get("shading")),
            spec.get("detail", d.get("detail")))


# --- tilesets ---------------------------------------------------------------

def tileset_dir(tid):
    return os.path.join(TILESETS_DIR, tid)


def tileset_exists(tid):
    return os.path.exists(os.path.join(tileset_dir(tid), "tileset.json"))


def tileset_spec(cfg, tid):
    return next((t for t in cfg["tilesets"] if t["id"] == tid), None)


def load_tileset(tid):
    """Load a stored tileset with its tile PNGs decoded to PIL for baking.
    Returns {..manifest.., 'tiles':[{name, corners, image:PIL}]} or None."""
    meta = _read_json(os.path.join(tileset_dir(tid), "tileset.json"))
    if not meta:
        return None
    tdir = tileset_dir(tid)
    for t in meta["tiles"]:
        t["image"] = Image.open(os.path.join(tdir, t["file"])).convert("RGBA")
    return meta


def generate_tileset(client, cfg, spec):
    """Generate one Wang tileset from a config spec and store it. One PixelLab
    op. Returns the manifest dict."""
    tid = spec["id"]
    d = cfg.get("defaults", {})
    tile_size = int(spec.get("tile_size", d.get("tile_size", 16)))
    view = spec.get("view", d.get("view", "high top-down"))
    outline, shading, detail = _style(cfg, spec)
    tset_id, terrain_types, tiles = client.create_tileset(
        lower_description=spec["lower"], upper_description=spec["upper"],
        transition_description=spec.get("transition", ""),
        tile_size=tile_size, view=view,
        transition_size=float(spec.get("transition_size", 0.0)),
        outline=outline, shading=shading, detail=detail,
        seed=_seed("tileset", tid))
    tdir = tileset_dir(tid)
    tile_meta = []
    for t in tiles:
        fname = os.path.join("tiles", f"{t['name']}.png")
        _save_png(t["image"], os.path.join(tdir, fname))
        tile_meta.append({"name": t["name"], "corners": t["corners"], "file": fname})
    meta = {
        "id": tid, "pixellab_tileset_id": tset_id, "kind": "wang",
        "lower": spec["lower"], "upper": spec["upper"],
        "transition": spec.get("transition", ""),
        "tile_size": tile_size, "view": view,
        "transition_size": float(spec.get("transition_size", 0.0)),
        "terrain_types": terrain_types, "tiles": tile_meta,
    }
    _write_json(os.path.join(tdir, "tileset.json"), meta)
    return meta


# --- objects ----------------------------------------------------------------

def object_dir(oid):
    return os.path.join(OBJECTS_DIR, oid)


def object_exists(oid):
    return os.path.exists(os.path.join(object_dir(oid), "object.json"))


def object_spec(cfg, oid):
    return next((o for o in cfg["objects"] if o["id"] == oid), None)


def load_object(oid):
    meta = _read_json(os.path.join(object_dir(oid), "object.json"))
    if not meta:
        return None
    meta["image"] = Image.open(os.path.join(object_dir(oid), meta["file"])).convert("RGBA")
    return meta


def footprint_tiles(spec, tile_size):
    """How many tiles wide/tall an object blocks (for collision), from its px
    size — at least 1. A tree 'size' 48 at 16px tiles ≈ 3, but the trunk is
    smaller, so collision uses a modest footprint."""
    return max(1, int(spec.get("footprint", max(1, round(spec.get("size", tile_size) / tile_size / 2)))))


def generate_object(client, cfg, spec):
    """Generate one transparent map object and store it. One PixelLab op."""
    oid = spec["id"]
    d = cfg.get("defaults", {})
    size = int(spec.get("size", 64))
    view = spec.get("view", d.get("view", "high top-down"))
    outline, shading, detail = _style(cfg, spec)
    img = client.create_map_object(
        description=f"{spec['description']}, {cfg.get('style_base','')}",
        size=size, view=view, outline=outline, shading=shading, detail=detail,
        seed=_seed("object", oid))
    _save_png(img, os.path.join(object_dir(oid), "object.png"))
    meta = {
        "id": oid, "description": spec["description"], "size": size, "view": view,
        "blocks": bool(spec.get("blocks", True)),
        "on": spec.get("on", []), "file": "object.png",
    }
    _write_json(os.path.join(object_dir(oid), "object.json"), meta)
    return meta
