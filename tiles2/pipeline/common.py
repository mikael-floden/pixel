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


def tile_files(d):
    return sorted(f for f in os.listdir(d)
                  if f.startswith("tile_") and f.endswith(".png")) if os.path.isdir(d) else []
