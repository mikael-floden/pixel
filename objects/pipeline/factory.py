"""Object factory: resolve the catalog, generate art, package it, track status.

Each operation is small and resumable: it writes its result to disk and updates
`object.json`, so the loop can stop/restart at any point and pick up the next
missing unit by reading the filesystem. PixelLab paints the pixels; this module
decides what to ask for, where to store it, and how to package it (per-frame
PNGs + a horizontal sprite-sheet strip for the game + a transparent GIF for quick
preview).

One OBJECT = one self-contained folder `objects/<id>/`:
  objects/<id>/object.json                 manifest (params + asset index)
  objects/<id>/sprite.png                  the base sprite (transparent)
  objects/<id>/rotations/<dir>.png         optional rotated views (incl. south)
  objects/<id>/animations/<key>/NN.png     per-frame PNGs
  objects/<id>/animations/<key>.png        sprite-sheet strip (game-ready)
  objects/<id>/animations/<key>.gif        looping preview (mobile / GitHub)
"""

from __future__ import annotations

import json
import os
import re
import shutil
import zlib

import numpy as np
from PIL import Image

from pixellab_client import MIN_ANIMATE_SIZE, PixelLabClient

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


def _resolve_animations(cfg, spec):
    """Turn an object's `animations` list (library keys and/or inline overrides)
    into full defs: {key, action, n_frames, view}. `view` defaults to the
    object's view."""
    lib = cfg.get("animation_library", {})
    out = []
    for item in spec.get("animations", []) or []:
        if isinstance(item, str):
            key, override = item, {}
        else:
            key, override = item["key"], dict(item)
            override.pop("key", None)
        base = dict(lib.get(key, {}))
        base.update(override)
        out.append({
            "key": key,
            "action": base.get("action", key),
            "n_frames": int(base.get("n_frames", 4)),
            "view": base.get("view", spec.get("view")),
        })
    return out


def _finalize_spec(cfg, raw, index, procedural=False):
    """Merge defaults into one object spec and normalize it. Animated objects are
    bumped to >= MIN_ANIMATE_SIZE (animate-with-text refuses smaller canvases),
    with the base sprite generated at the same size so it matches its frames."""
    d = cfg["defaults"]
    spec = dict(raw)
    spec["view"] = spec.get("view", d["view"])  # resolve before animations read it
    w, h = spec.get("size", [48, 48])
    anims = _resolve_animations(cfg, spec)
    if anims:
        w, h = max(int(w), MIN_ANIMATE_SIZE), max(int(h), MIN_ANIMATE_SIZE)
    return {
        "id": spec["id"],
        "name": spec.get("name", spec["id"].replace("_", " ").title()),
        "category": spec.get("category", "misc"),
        "description": spec["description"],
        "width": int(w),
        "height": int(h),
        "view": spec.get("view", d["view"]),
        "direction": spec.get("direction", d["direction"]),
        "outline": spec.get("outline", d["outline"]),
        "shading": spec.get("shading", d["shading"]),
        "detail": spec.get("detail", d["detail"]),
        "no_background": spec.get("no_background", d["no_background"]),
        "isometric": spec.get("isometric", False),
        "text_guidance_scale": spec.get("text_guidance_scale", d["text_guidance_scale"]),
        "negative_description": spec.get("negative_description", d["negative_description"]),
        "rotations": int(spec.get("rotations", 0)),
        "animations": anims,
        "index": index,
        "procedural": procedural,
        "seed": _seed(spec["id"], index),
    }


def _procedural_spec(cfg, index):
    """Synthesize the (index)th object once the explicit catalog is exhausted, by
    combining a `kind` with an `adjective`. Deterministic in `index`."""
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
    """The full ordered list of objects to build: the explicit catalog first,
    then procedural fill up to targets.num_objects."""
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
    """Transparent-center `img` onto a fixed (w, h) canvas. The API already
    returns art at the requested size; this just guards against off-by-one
    frames so every asset of an object shares one canvas."""
    img = img.convert("RGBA")
    tw, th = size
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
    """Horizontal sprite-sheet strip (game-ready): frames laid left-to-right on a
    uniform cell so a game can slice it by cell width."""
    if not frames:
        return
    w = max(f.width for f in frames)
    h = max(f.height for f in frames)
    strip = Image.new("RGBA", (w * len(frames), h), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        strip.alpha_composite(f, (i * w + (w - f.width) // 2, (h - f.height) // 2))
    _save_png(strip, path)


def _save_gif(frames, path, duration_ms=PREVIEW_MS):
    """Transparent looping GIF preview. GIF transparency is 1-bit, so alpha is
    thresholded (>=128 opaque); per-pixel alpha lives in the PNGs."""
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
    """Save individual frames as zero-padded PNGs. The directory is cleared first
    so a regenerated (shorter) animation can't leave stale higher-numbered frames
    behind."""
    if os.path.isdir(dir_path):
        shutil.rmtree(dir_path)
    os.makedirs(dir_path, exist_ok=True)
    for i, f in enumerate(frames):
        f.save(os.path.join(dir_path, f"{i:02d}.png"))


# --- QA ---------------------------------------------------------------------

def _opaque_px(img):
    return int((np.asarray(img.convert("RGBA"))[:, :, 3] > 10).sum())


def frames_ok(frames):
    """A good animation is non-blank AND actually moves. animate-with-text
    occasionally returns all-transparent or frozen frames; we reject those and
    retry with a fresh seed. Returns (ok, reason)."""
    if len(frames) < 2:
        return False, "too few frames"
    opq = [_opaque_px(f) for f in frames]
    if min(opq) <= 5:
        return False, "a frame is blank"
    a0 = np.asarray(frames[0].convert("RGBA"), dtype=np.int16)
    moved = any(float(np.abs(np.asarray(f.convert("RGBA"), dtype=np.int16) - a0).mean()) > 1.0
                for f in frames[1:])
    if not moved:
        return False, "frames are static (no motion)"
    return True, ""


# --- object status (filesystem-derived) -------------------------------------

def rotation_dirs(cfg, spec):
    """Directions a rotated object should have (empty if rotations == 0). The base
    (`south`) is included so rotations/ is a complete set."""
    n = str(spec.get("rotations", 0))
    if n in ("0", ""):
        return []
    return cfg["rotation_directions"].get(n, [])


def has_base(oid):
    return os.path.exists(os.path.join(object_dir(oid), "sprite.png"))


def has_rotation(oid, direction):
    return os.path.exists(os.path.join(object_dir(oid), "rotations", f"{direction}.png"))


def has_animation(oid, key):
    return os.path.exists(os.path.join(object_dir(oid), "animations", f"{key}.gif"))


# --- generation ops ---------------------------------------------------------

def _base_meta(spec):
    return {
        "id": spec["id"], "name": spec["name"], "category": spec["category"],
        "description": spec["description"], "view": spec["view"],
        "direction": spec["direction"], "size": [spec["width"], spec["height"]],
        "procedural": spec["procedural"],
        "source": "pixellab.ai (generate-image-pixflux / rotate / animate-with-text)",
        "params": {
            "outline": spec["outline"], "shading": spec["shading"],
            "detail": spec["detail"], "no_background": spec["no_background"],
            "isometric": spec["isometric"], "seed": spec["seed"],
        },
    }


def generate_base(client, cfg, spec):
    """Generate the base sprite (generate-image-pixflux) and start the manifest."""
    oid = spec["id"]
    img, used = client.generate_image(
        description=full_description(cfg, spec), width=spec["width"], height=spec["height"],
        view=spec["view"], direction=spec["direction"], outline=spec["outline"],
        shading=spec["shading"], detail=spec["detail"], no_background=spec["no_background"],
        isometric=spec["isometric"], negative_description=spec["negative_description"],
        text_guidance_scale=spec["text_guidance_scale"], seed=spec["seed"],
    )
    img = _normalize(img, (spec["width"], spec["height"]))
    _save_png(img, os.path.join(object_dir(oid), "sprite.png"))

    meta = read_manifest(oid) or {}
    meta.update(_base_meta(spec))
    meta["sprite"] = _rel(os.path.join(object_dir(oid), "sprite.png"))
    meta.setdefault("rotations", {"count": spec["rotations"], "directions": []})
    meta.setdefault("animations", {})
    meta["generations_used"] = round(meta.get("generations_used", 0) + used, 3)
    meta["status"] = "in_progress"
    write_manifest(oid, meta)
    return meta


def generate_rotation(client, cfg, spec, direction):
    """Produce one rotated view. `south` is just a copy of the base sprite (no
    generation); other directions are rotated from it."""
    oid = spec["id"]
    base = Image.open(os.path.join(object_dir(oid), "sprite.png")).convert("RGBA")
    used = 0.0
    if direction == spec["direction"]:
        img = base
    else:
        img, used = client.rotate(
            from_image=base, width=spec["width"], height=spec["height"],
            from_view=spec["view"], to_view=spec["view"],
            from_direction=spec["direction"], to_direction=direction,
            isometric=spec["isometric"], seed=_seed(oid, "rot", direction),
        )
    img = _normalize(img, (spec["width"], spec["height"]))
    _save_png(img, os.path.join(object_dir(oid), "rotations", f"{direction}.png"))

    meta = read_manifest(oid)
    dirs = sorted(set(meta.get("rotations", {}).get("directions", [])) | {direction})
    meta["rotations"] = {"count": spec["rotations"], "directions": dirs,
                         "files": {d: _rel(os.path.join(object_dir(oid), "rotations", f"{d}.png"))
                                   for d in dirs}}
    meta["generations_used"] = round(meta.get("generations_used", 0) + used, 3)
    write_manifest(oid, meta)
    return meta


def generate_animation(client, cfg, spec, adef, max_attempts=3):
    """Generate one animation (animate-with-text), validate it isn't blank/static,
    retry with a fresh seed if so, then package frames + strip + gif."""
    oid = spec["id"]
    base = Image.open(os.path.join(object_dir(oid), "sprite.png")).convert("RGBA")
    key = adef["key"]
    frames, used_total, ok, reason = [], 0.0, False, ""
    for attempt in range(max_attempts):
        raw, used = client.animate(
            reference_image=base, description=spec["description"], action=adef["action"],
            width=spec["width"], height=spec["height"], view=adef["view"],
            direction=spec["direction"] if adef["view"] != "side" else "east",
            n_frames=adef["n_frames"], negative_description=spec["negative_description"],
            seed=_seed(oid, key, attempt),
        )
        used_total += used
        raw = [_normalize(f, (spec["width"], spec["height"])) for f in raw]
        ok, reason = frames_ok(raw)
        if ok:
            frames = raw
            break
        print(f"  ! anim {oid}/{key} attempt {attempt + 1}/{max_attempts}: {reason}")
        if raw and not frames:
            frames = raw  # keep best effort in case all attempts fail

    adir = os.path.join(object_dir(oid), "animations")
    _save_frames(frames, os.path.join(adir, key))
    strip = os.path.join(adir, f"{key}.png")
    gif = os.path.join(adir, f"{key}.gif")
    _save_strip(frames, strip)
    _save_gif(frames, gif)

    meta = read_manifest(oid)
    meta.setdefault("animations", {})[key] = {
        "action": adef["action"], "view": adef["view"], "frames": len(frames),
        "n_frames_requested": adef["n_frames"], "ok": ok, "note": reason,
        "strip": _rel(strip), "gif": _rel(gif),
        "frame_paths": [_rel(os.path.join(adir, key, f"{i:02d}.png")) for i in range(len(frames))],
    }
    meta["generations_used"] = round(meta.get("generations_used", 0) + used_total, 3)
    write_manifest(oid, meta)
    return meta


def mark_complete_if_done(cfg, spec):
    """Flip status to 'complete' once base + all rotations + all animations exist."""
    oid = spec["id"]
    if not has_base(oid):
        return
    if any(not has_rotation(oid, d) for d in rotation_dirs(cfg, spec)):
        return
    if any(not has_animation(oid, a["key"]) for a in spec["animations"]):
        return
    meta = read_manifest(oid)
    if meta and meta.get("status") != "complete":
        meta["status"] = "complete"
        write_manifest(oid, meta)
