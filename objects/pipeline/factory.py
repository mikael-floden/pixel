"""Object factory: persistent 8-direction PixelLab objects + fitting animations.

Every object is a real PixelLab **object** (create-8-direction-object): it shows
in the PixelLab "create-object" web tool, can be regenerated/edited there, is
animatable, and is syncable back into this repo (see sync.py). This is the object
analogue of the character system — the repo mirrors PixelLab, which is the live
source of truth for an object's `pixellab_object_id`.

Each operation is small and resumable: it writes its result to disk and updates
`object.json`, so the loop can stop/restart and pick up the next missing unit by
reading the filesystem.

One OBJECT = one self-contained folder `objects/<id>/`:
  objects/<id>/object.json                       manifest (params + asset index)
  objects/<id>/sprite.png                        the canonical sprite (south view)
  objects/<id>/rotations/<dir>.png               all 8 rotations
  objects/<id>/animations/<key>/<dir>/NN.png     per-direction animation frames
  objects/<id>/animations/<key>__<dir>.png       per-direction sprite-sheet strip
  objects/<id>/animations/<key>__<dir>.gif       per-direction looping preview
Every object has 8 directions; every animation is generated for all 8 directions.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import zlib

import numpy as np
from PIL import Image

from pixellab_client import DIRECTIONS_8, PixelLabClient

ROOT = os.path.dirname(os.path.dirname(__file__))
CONFIG = os.path.join(ROOT, "config", "objects.json")
# Reserved top-level names in objects/ that are tooling, not objects. (The loop
# also skips any dir without an object.json, so this is just belt-and-braces.)
RESERVED_DIRS = {"pipeline", "config", "spec"}
PREVIEW_MS = 140


# --- config / spec resolution ----------------------------------------------

def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "_", (s or "").lower()).strip("_") or "object"


def _seed(*parts):
    return zlib.crc32(("::".join(str(p) for p in parts)).encode()) % (2 ** 31)


def world_height_m(cfg, category, override=None):
    """The realistic real-world height (metres): explicit `world_height_m` or the
    category default. Enforces the realism rule so nothing is sized arbitrarily."""
    if override is not None:
        return float(override)
    return float(cfg["scale"]["category_height_m"].get(category, 1.0))


def placement(cfg, category, override=None):
    """Turn a real-world height into the in-world PIXEL height an object should
    occupy beside a character, so props compose at a believable scale."""
    sc = cfg["scale"]
    wh = world_height_m(cfg, category, override)
    ppm = sc["character_height_px"] / sc["character_height_m"]
    return {
        "world_height_m": round(wh, 3),
        "world_px_height": max(1, round(wh * ppm)),
        "character_height_px": sc["character_height_px"],
        "character_height_m": sc["character_height_m"],
        "note": "Render the sprite scaled so its height == world_px_height; a "
                "character is character_height_px tall.",
    }


def _resolve_animations(spec):
    """The object's 3 animations as [{key, description, frames}]."""
    out = []
    for a in spec.get("animations", []) or []:
        out.append({"key": a["key"], "description": a["description"],
                    "frames": int(a.get("frames", 8))})
    return out


def _finalize_spec(cfg, raw, index, procedural=False):
    """Merge defaults into one object spec. `size` is a single int (32-256) for
    create-8-direction-object; every object is 8-direction with its 3 animations."""
    d = cfg["defaults"]
    spec = dict(raw)
    sz = spec.get("size", 64)
    if isinstance(sz, (list, tuple)):      # tolerate legacy [w, h]
        sz = max(sz)
    size = max(32, min(256, int(sz)))
    return {
        "id": spec["id"],
        "name": spec.get("name", spec["id"].replace("_", " ").title()),
        "category": spec.get("category", "misc"),
        "description": spec["description"],
        "view": spec.get("view", d["view"]),
        "size": size,
        "animations": _resolve_animations(spec),
        "placement": placement(cfg, spec.get("category", "misc"), spec.get("world_height_m")),
        "index": index,
        "procedural": procedural,
        "style_version": cfg.get("style_version", 1),
    }


def _procedural_spec(cfg, index):
    """Synthesize the (index)th object once the explicit catalog is exhausted."""
    pv = cfg["procedural"]
    kinds, adjs = pv["kinds"], pv["adjectives"]
    j = index - len(cfg["catalog"])
    kind = kinds[j % len(kinds)]
    adj = adjs[(j // len(kinds)) % len(adjs)]
    noun = kind["noun"]
    raw = dict(kind)
    raw.pop("noun", None)
    raw["id"] = f"{_slug(adj)}_{_slug(noun)}_{index:02d}"
    raw["name"] = f"{adj.title()} {noun.title()}"
    raw["description"] = f"an {adj} {noun}" if adj[0] in "aeiou" else f"a {adj} {noun}"
    return _finalize_spec(cfg, raw, index, procedural=True)


def object_specs(cfg):
    """The full ordered list of objects: explicit catalog then procedural fill."""
    specs = [_finalize_spec(cfg, o, i) for i, o in enumerate(cfg["catalog"])]
    target = cfg["targets"]["num_objects"]
    for i in range(len(specs), max(target, len(specs))):
        specs.append(_procedural_spec(cfg, i))
    return specs


def full_description(cfg, spec):
    return f"{spec['description']}, {cfg['style_base']}"


# --- io / packaging helpers -------------------------------------------------

def object_dir(oid):
    return os.path.join(ROOT, oid)


def manifest_path(oid):
    return os.path.join(object_dir(oid), "object.json")


def _rel(p):
    return os.path.relpath(p, ROOT)


def read_manifest(oid, default=None):
    p = manifest_path(oid)
    if not os.path.exists(p):
        return default
    with open(p) as f:
        return json.load(f)


def write_manifest(oid, data):
    os.makedirs(object_dir(oid), exist_ok=True)
    with open(manifest_path(oid), "w") as f:
        json.dump(data, f, indent=2)


def _save_png(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)


def _normalize(img, size):
    """Transparent-center `img` onto a fixed (size, size) canvas so every asset of
    an object shares one square canvas."""
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


def _save_strip(frames, path):
    if not frames:
        return
    w = max(f.width for f in frames)
    h = max(f.height for f in frames)
    strip = Image.new("RGBA", (w * len(frames), h), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        strip.alpha_composite(f, (i * w + (w - f.width) // 2, (h - f.height) // 2))
    _save_png(strip, path)


def _save_gif(frames, path, duration_ms=PREVIEW_MS):
    if not frames:
        return
    w = max(f.width for f in frames)
    h = max(f.height for f in frames)
    out = []
    for f in frames:
        rgba = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        rgba.alpha_composite(f.convert("RGBA"), ((w - f.width) // 2, (h - f.height) // 2))
        p = rgba.convert("RGB").quantize(colors=255, dither=Image.NONE)
        transparent = rgba.getchannel("A").point(lambda a: 255 if a < 128 else 0)
        p.paste(255, mask=transparent)
        out.append(p)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out[0].save(path, save_all=True, append_images=out[1:], duration=duration_ms,
                loop=0, transparency=255, disposal=2, optimize=False)


def _save_frames(frames, dir_path):
    if os.path.isdir(dir_path):
        shutil.rmtree(dir_path)
    os.makedirs(dir_path, exist_ok=True)
    for i, f in enumerate(frames):
        f.save(os.path.join(dir_path, f"{i:02d}.png"))


# --- object status (filesystem-derived) -------------------------------------

def has_base(oid):
    return os.path.exists(os.path.join(object_dir(oid), "sprite.png"))


def has_animation(oid, key):
    """Done = the manifest records this animation with at least one direction.
    (Not a specific file like south.gif: a v3 animation occasionally returns fewer
    than 8 directions, and a missing 'south' must NOT make the loop regenerate the
    same animation forever — that was the stall.)"""
    meta = read_manifest(oid) or {}
    dirs = ((meta.get("animations") or {}).get(key) or {}).get("directions") or {}
    return len(dirs) > 0


# --- generation: base 8-direction object ------------------------------------

def _base_meta(spec):
    return {
        "id": spec["id"], "name": spec["name"], "category": spec["category"],
        "description": spec["description"], "view": spec["view"], "size": spec["size"],
        "placement": spec["placement"], "procedural": spec["procedural"],
        "source": "pixellab.ai create-8-direction-object (persistent, syncable)",
    }


def generate_base(client, cfg, spec):
    """Create the persistent 8-direction object and mirror its rotations."""
    oid = spec["id"]
    object_id = client.create_object(
        description=full_description(cfg, spec), size=spec["size"], view=spec["view"])
    rotations = client.download_object_rotations(object_id)
    rotations = {d: _normalize(img, spec["size"]) for d, img in rotations.items()}
    for d, img in rotations.items():
        _save_png(img, os.path.join(object_dir(oid), "rotations", f"{d}.png"))
    south = rotations.get("south") or (next(iter(rotations.values())) if rotations else None)
    if south is not None:
        _save_png(south, os.path.join(object_dir(oid), "sprite.png"))

    meta = read_manifest(oid) or {}
    meta.update(_base_meta(spec))
    meta["pixellab_object_id"] = object_id
    meta["style_version"] = cfg.get("style_version", 1)
    meta["sprite"] = _rel(os.path.join(object_dir(oid), "sprite.png"))
    meta["directions"] = sorted(rotations.keys())
    meta["rotations"] = {d: _rel(os.path.join(object_dir(oid), "rotations", f"{d}.png"))
                         for d in sorted(rotations.keys())}
    meta.setdefault("animations", {})
    meta["status"] = "in_progress"
    write_manifest(oid, meta)
    return meta


# --- generation: one animation across all 8 directions ----------------------

def generate_animation(client, cfg, spec, adef):
    """Animate the object (all 8 directions) and package per-direction frames."""
    oid = spec["id"]
    meta = read_manifest(oid)
    object_id = meta["pixellab_object_id"]
    key = adef["key"]

    group_id = client.animate_object(
        object_id, animation_description=adef["description"],
        frame_count=adef["frames"], display_name=key)
    by_dir = client.download_object_animation(object_id, group_id, expected=len(DIRECTIONS_8))

    adir = os.path.join(object_dir(oid), "animations")
    saved = {}
    for direction, frames in by_dir.items():
        frames = [_normalize(f, spec["size"]) for f in frames]
        fdir = os.path.join(adir, key, direction)
        _save_frames(frames, fdir)
        strip = os.path.join(adir, f"{key}__{direction}.png")
        gif = os.path.join(adir, f"{key}__{direction}.gif")
        _save_strip(frames, strip)
        _save_gif(frames, gif)
        saved[direction] = {
            "frames": len(frames), "strip": _rel(strip), "gif": _rel(gif),
            "frame_paths": [_rel(os.path.join(fdir, f"{i:02d}.png")) for i in range(len(frames))],
        }
    meta = read_manifest(oid)
    meta.setdefault("animations", {})[key] = {
        "group_id": group_id, "description": adef["description"],
        "frame_count": adef["frames"], "directions": saved,
    }
    write_manifest(oid, meta)
    return meta


def mark_complete_if_done(cfg, spec):
    oid = spec["id"]
    if not has_base(oid):
        return
    if any(not has_animation(oid, a["key"]) for a in spec["animations"]):
        return
    meta = read_manifest(oid)
    if meta and meta.get("status") != "complete":
        meta["status"] = "complete"
        write_manifest(oid, meta)


# --- maintenance: scale + restyle -------------------------------------------

def refresh_placement(cfg):
    """Recompute `placement` for every existing manifest (zero PixelLab cost)."""
    by_id = {s["id"]: s for s in object_specs(cfg)}
    changed = 0
    for oid, spec in by_id.items():
        meta = read_manifest(oid)
        if meta and meta.get("placement") != spec["placement"]:
            meta["placement"] = spec["placement"]
            write_manifest(oid, meta)
            changed += 1
    return changed


def restyle_stale(cfg, client=None):
    """Delete objects made under an older style_version so the loop regenerates
    them. Also deletes the live PixelLab object (deletion parity) when a client is
    given, so the store doesn't accumulate orphans. Returns the ids removed."""
    current = cfg.get("style_version", 1)
    removed = []
    for spec in object_specs(cfg):
        meta = read_manifest(spec["id"])
        if meta and meta.get("style_version", 1) < current:
            pid = meta.get("pixellab_object_id")
            if pid and client is not None:
                try:
                    client.delete_object(pid)
                except Exception:
                    pass
            shutil.rmtree(object_dir(spec["id"]), ignore_errors=True)
            removed.append(spec["id"])
    return removed
