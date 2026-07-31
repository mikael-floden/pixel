"""Shared layout + metadata helpers for tiles2.

Directory model (per ground type <gid>, e.g. saturated_grass):

    tiles2/<gid>/
      metadata.json                 type meta incl. ref_sprite pointer
      raw/<sheet>/                   raw download (source of truth, never edited)
        tile_00.png ... request.json
      base/<sheet>/                  post-processed base tiles
        tile_00.png ...
      transitions/<other>/<sheet>/   post-processed transition tiles (gid -> other)
        tile_00.png ...

A `sheet` is one create-tiles-pro request (~16 tiles). Raw is always kept so the
post-process (colour normalisation to the ref-sprite) can be re-tuned + re-run.
"""

from __future__ import annotations

import json
import os
import zlib

ROOT = os.path.dirname(os.path.dirname(__file__))          # tiles2/
CONFIG = os.path.join(ROOT, "config", "tiles2.json")

RAW_SCHEMA = "tiles2/raw-sheet@1"
TYPE_SCHEMA = "tiles2/type@1"


def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def _seed(*parts):
    return zlib.crc32("::".join(str(p) for p in parts).encode()) % (2 ** 31)


# -- paths ------------------------------------------------------------------

def type_dir(gid):
    return os.path.join(ROOT, gid)


def raw_dir(gid):
    return os.path.join(type_dir(gid), "raw")


def base_dir(gid):
    return os.path.join(type_dir(gid), "base")


def trans_dir(gid, other):
    return os.path.join(type_dir(gid), "transitions", other)


def elev_dir(gid, height_id):
    """Processed elevation tiles for a terrain, as a SIBLING of base/ (e.g.
    saturated_grass/base_x_2). x1 lives in base/; taller variants beside it."""
    return os.path.join(type_dir(gid), height_id)


def sheet_slug(kind, seed, other=None):
    """Stable id for one request's folder: base_<seed> / trans_<other>_<seed>."""
    return f"trans_{other}_{seed}" if kind == "transition" else f"base_{seed}"


# -- type metadata ----------------------------------------------------------

def meta_path(gid):
    return os.path.join(type_dir(gid), "metadata.json")


def load_type_meta(gid):
    p = meta_path(gid)
    if os.path.isfile(p):
        with open(p) as f:
            return json.load(f)
    return None


def save_type_meta(gid, meta):
    os.makedirs(type_dir(gid), exist_ok=True)
    with open(meta_path(gid), "w") as f:
        json.dump(meta, f, indent=2)


def ensure_type_meta(gt, cfg):
    """Create tiles2/<gid>/metadata.json for a ground type if missing."""
    gid = gt["id"]
    meta = load_type_meta(gid)
    if meta:
        return meta
    meta = {
        "schema": TYPE_SCHEMA,
        "ground_type": gid,
        "name": gt.get("name", gid),
        "description": gt["description"],
        "settings": cfg["tile"],
        "ref_sprite": None,
        "_ref_hint": "Declare the tile that defines this type's target brightness/"
                     "hue/saturation, e.g. {\"sheet\": \"base_123\", \"tile\": "
                     "\"tile_03.png\"}. Until set, postprocess copies raw->base "
                     "unchanged. After setting, re-run postprocess to normalise.",
        "transitions": [],
    }
    save_type_meta(gid, meta)
    return meta


# -- raw sheets -------------------------------------------------------------

def list_raw_sheets(gid, kind=None, other=None):
    """Return raw sheet dirs for a type, optionally filtered by kind/target."""
    rd = raw_dir(gid)
    if not os.path.isdir(rd):
        return []
    out = []
    for name in sorted(os.listdir(rd)):
        d = os.path.join(rd, name)
        mp = os.path.join(d, "request.json")
        if not os.path.isfile(mp):
            continue
        with open(mp) as f:
            m = json.load(f)
        if kind and m.get("kind") != kind:
            continue
        if other and m.get("transition_to") != other:
            continue
        out.append((name, d, m))
    return out


TILE_EXTS = (".png", ".webp")


def tile_files(d):
    """Tile files in a sheet dir, in index order, in EITHER format.

    raw/ sheets are stored as lossless WebP (~24% smaller, and raw/ has no consumer
    outside tiles2), while the processed game-facing tiles stay .png because maps2's
    world.json bakes their exact paths. Readers therefore must not assume an
    extension — this is the single chokepoint they all go through."""
    return sorted((f for f in os.listdir(d)
                   if f.startswith("tile_") and f.endswith(TILE_EXTS)),
                  key=lambda f: os.path.splitext(f)[0]) if os.path.isdir(d) else []


TILE_FORMAT = ".webp"          # game-facing tile container; see docs/WEBP.md

# Pillow writes LOSSY WebP by default — on pixel art that shifts ~99% of visible
# pixels and would undo the palette harmonisation. Never call im.save() on a .webp
# path directly; go through save_tile().
_WEBP = {"lossless": True, "method": 4, "quality": 100}


def processed_name(fn):
    """Output filename for a processed tile, in the game-facing container format.

    The extension is decided HERE and nowhere else, so the whole library can change
    container without touching the pipeline. Safe to flip because the game resolves
    .png<->.webp at runtime (games2 WorldScene.loadImageEitherExt + the server-side
    resolve, 2026-07-31), so a maps2 world.json still naming .png keeps rendering."""
    return os.path.splitext(fn)[0] + TILE_FORMAT


def save_tile(im, path):
    """Write a tile, forcing LOSSLESS for WebP. Use this for every tile write."""
    if path.lower().endswith(".webp"):
        im.save(path, "WEBP", **_WEBP)
    else:
        im.save(path)


def stem(fn):
    """'tile_03.webp' -> 'tile_03'. Used to match a tile against request.json entries,
    which record the filename as it was at GENERATION time — so a raw sheet converted
    to WebP must still find its per-tile record (index/width/height) instead of
    silently dropping it from the sheet metadata maps2 reads."""
    return os.path.splitext(fn)[0]
