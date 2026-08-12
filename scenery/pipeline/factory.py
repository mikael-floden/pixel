"""Scenery factory core: config, filesystem contract, packaging helpers.

The v2 factory (2026-08-12, maintainer's structure) generates SOUTH-only
scenery in RANKED GROUPS — see `catalog.py` for the plan and `loop.py` for the
runner. ("Object" in the client is PixelLab's product term for the store entity
a scenery piece persists as; here the domain is **scenery**: freely placeable,
optionally animated set dressing that doesn't follow the tile grid.)

Filesystem contract:

  scenery/<group>/<piece>/scenery.json    the manifest (one per piece)
  scenery/<group>/<piece>/sprite.webp     the SOUTH sprite (lossless WebP)

plus three LEGACY pieces at the top level (campfire, grave_cross,
blood_spatter — game-referenced, pre-v2, 8-direction). Discovery treats a
top-level dir with a scenery.json as a legacy piece and a top-level dir whose
children carry scenery.json as a group. `pipeline/`, `config/`, `spec/` are
tooling, never scenery.

Every asset the v2 factory writes is LOSSLESS WebP (`save_webp`: lossless=True
AND exact=True — both non-default in Pillow, both mandatory; see
games2/CLAUDE.md for why lossy or inexact encoding is forbidden).
"""

from __future__ import annotations

import json
import os
import re
import zlib

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(__file__))
# NB "factory.json", NOT "scenery.json": a per-piece manifest is scenery.json,
# and consumers discover pieces by scanning for that filename — a config file
# with the manifest's name would read as a phantom piece (the lore builder
# proved it). Same naming as the characters domain's config/factory.json.
CONFIG = os.path.join(ROOT, "config", "factory.json")
# Reserved top-level names in scenery/ that are tooling, not scenery.
RESERVED_DIRS = {"pipeline", "config", "spec"}


# --- config -----------------------------------------------------------------

def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "_", (s or "").lower()).strip("_") or "piece"


def _seed(*parts):
    return zlib.crc32(("::".join(str(p) for p in parts)).encode()) % (2 ** 31)


def placement(cfg, world_height_m):
    """Turn a real-world height into the in-world PIXEL height a piece should
    occupy beside a character, so props compose at a believable scale."""
    sc = cfg["scale"]
    wh = float(world_height_m)
    ppm = sc["character_height_px"] / sc["character_height_m"]
    return {
        "world_height_m": round(wh, 3),
        "world_px_height": max(1, round(wh * ppm)),
        "character_height_px": sc["character_height_px"],
        "character_height_m": sc["character_height_m"],
        "note": "Render the sprite scaled so its height == world_px_height; a "
                "character is character_height_px tall.",
    }


# --- io / discovery ---------------------------------------------------------
#
# A piece is addressed by its REL ID: "trees/tree_001" for grouped pieces,
# "campfire" for legacy top-level ones. All manifest paths are domain-relative
# (they start with the rel id), so they resolve the same over HTTP or on disk.

def piece_dir(rel_id):
    return os.path.join(ROOT, rel_id)


def manifest_path(rel_id):
    return os.path.join(piece_dir(rel_id), "scenery.json")


def _rel(p):
    return os.path.relpath(p, ROOT)


def read_manifest(rel_id, default=None):
    p = manifest_path(rel_id)
    if not os.path.exists(p):
        return default
    with open(p) as f:
        return json.load(f)


def write_manifest(rel_id, data):
    os.makedirs(piece_dir(rel_id), exist_ok=True)
    with open(manifest_path(rel_id), "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def discover():
    """Every piece on disk -> [(rel_id, manifest)]. Legacy top-level pieces and
    grouped pieces alike; deterministic order (sorted)."""
    out = []
    for name in sorted(os.listdir(ROOT)):
        if name in RESERVED_DIRS or name.startswith(".") \
                or not os.path.isdir(os.path.join(ROOT, name)):
            continue
        meta = read_manifest(name)
        if meta is not None:
            out.append((name, meta))
            continue
        group_dir = os.path.join(ROOT, name)
        for child in sorted(os.listdir(group_dir)):
            rel = f"{name}/{child}"
            if not os.path.isdir(os.path.join(ROOT, rel)):
                continue
            meta = read_manifest(rel)
            if meta is not None:
                out.append((rel, meta))
    return out


def done_by_group():
    """{group_id: {piece_id, ...}} for every COMPLETE grouped piece on disk —
    the planner's whole input. A piece counts only when its sprite exists, so a
    half-written folder is re-planned instead of silently skipped."""
    done = {}
    for rel, meta in discover():
        if "/" not in rel:
            continue                      # legacy top-level piece
        group, pid = rel.split("/", 1)
        sprite = meta.get("sprite")
        if sprite and os.path.exists(os.path.join(ROOT, sprite)):
            done.setdefault(group, set()).add(pid)
    return done


# --- packaging --------------------------------------------------------------

def save_webp(img, path):
    """Lossless WebP, exact RGBA. `lossless=True` avoids VP8 ringing on hard
    pixel edges; `exact=True` stops libwebp rewriting RGB under transparent
    pixels. BOTH are non-default and BOTH are required (games2/CLAUDE.md)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.convert("RGBA").save(path, format="WEBP", lossless=True, exact=True, method=6)


def _save_png(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)


def _normalize(img, size):
    """Transparent-center `img` onto a fixed (size, size) canvas so every asset
    of a piece shares one square canvas."""
    img = img.convert("RGBA")
    tw = th = int(size)
    if img.size == (tw, th):
        return img
    if img.width > tw or img.height > th:
        l = max(0, (img.width - tw) // 2)
        t = max(0, (img.height - th) // 2)
        img = img.crop((l, t, l + min(tw, img.width), t + min(th, img.height)))
    canvas = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    canvas.alpha_composite(img, ((tw - img.width) // 2, (th - img.height) // 2))
    return canvas
