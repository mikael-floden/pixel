"""High-level factory operations: skeletons, characters, animations, outfits.

Each operation is small and resumable: it writes its result to disk and updates a
status field in JSON, so the loop can stop/restart at any point and pick up the
next missing unit by reading the filesystem. PixelLab paints the pixels; this
module decides what to ask for, where to store it, and how to package it
(per-direction PNG strips for the game + a dark-background GIF for quick mobile
preview).

The base character is UNDRESSED; clothing is an "outfit" — a PixelLab character
STATE ("wearing X") with its own (re)generated animations. No per-slot gear.

Asset layout:
  skeletons/<sid>/skeleton.json
  skeletons/<sid>/characters/<cid>/character.json
  skeletons/<sid>/characters/<cid>/rotations/<dir>.png
  skeletons/<sid>/characters/<cid>/animations/<key>__<dir>.png|.gif
  skeletons/<sid>/characters/<cid>/outfits/<outfit_id>/rotations/<dir>.png
  skeletons/<sid>/characters/<cid>/outfits/<outfit_id>/animations/<key>__<dir>.png|.gif
"""

from __future__ import annotations

import base64
import io
import json
import os
import shutil
import zlib

from PIL import Image

from pixellab_client import PixelLabClient

ROOT = os.path.dirname(os.path.dirname(__file__))
CONFIG = os.path.join(ROOT, "config", "factory.json")
SKELETONS_DIR = os.path.join(ROOT, "skeletons")
PREVIEW_BG = (32, 36, 43, 255)

# Distinct PERSON looks (appearance only — no clothing; the base is undressed and
# clothing comes from dress states). Mature, gritty, badass adults — varied in
# age, gender, build and ethnicity. No children / cutesy tropes.
CHARACTER_LOOKS = [
    "a grizzled mercenary with a scarred face and a shaved head, muscular build",
    "a brooding swordsman with long black hair and a stern jaw, broad shoulders",
    "a battle-worn warrior woman with a long dark braid and war paint, athletic build",
    "an older veteran with a grey beard and an eyepatch, heavy build",
    "a bald monk with face tattoos and a hard stare, lean and muscular",
    "a fierce huntress with cropped dark hair and a cold gaze, lithe build",
    "a hulking barbarian with wild black hair and a thick beard, massive build",
    "a gaunt pale man with sunken eyes and sharp cheekbones, wiry build",
    "a scarred duelist with slicked-back dark hair and a goatee, athletic build",
    "a hardened woman with a buzz cut and a broken nose, wiry build",
    "a stern dark-skinned fighter with a shaved head and a strong jaw, muscular build",
    "a grim older woman with grey-streaked hair tied back, gaunt weathered face",
]


# --- config / params --------------------------------------------------------

def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def skeleton_params(cfg, index):
    """Params for the Nth skeleton: explicit variations first, then procedural.
    Each picks a PixelLab-supported resolution (32-256) and 4 or 8 directions."""
    variations = cfg["skeleton_variations"]
    if index < len(variations):
        return dict(variations[index])
    pv = cfg["procedural_variation"]
    views, sizes, details = pv["views"], pv["sizes"], pv["details"]
    choices = pv.get("direction_choices", [4, 8])
    v = views[index % len(views)]
    w, h = sizes[(index // len(views)) % len(sizes)]
    det = details[(index // (len(views) * len(sizes))) % len(details)]
    dirs = choices[index % len(choices)]
    return {
        "id": f"{index:02d}_{v.replace(' ', '')}_{w}x{h}_d{dirs}",
        "note": f"Procedural variation #{index}", "view": v, "width": w, "height": h,
        "directions": dirs, "template_id": "mannequin",
        "outline": "single color black outline", "shading": "basic shading", "detail": det,
    }


def anim_def(cfg, key):
    return next((a for a in cfg["animations"] if a["key"] == key), None)


def dress_def(cfg, dress_id):
    return next((d for d in cfg["dress_pool"] if d["id"] == dress_id), None)


def _seed(*parts):
    return zlib.crc32(("::".join(str(p) for p in parts)).encode()) % (2 ** 31)


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


def _save_strip(frames, path):
    if not frames:
        return None
    w = max(f.width for f in frames)
    h = max(f.height for f in frames)
    strip = Image.new("RGBA", (w * len(frames), h), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        strip.alpha_composite(f, (i * w + (w - f.width) // 2, (h - f.height) // 2))
    _save_png(strip, path)
    return strip


def _save_gif(frames, path, duration_ms=140):
    """Transparent animated GIF preview. GIF transparency is 1-bit, so alpha is
    thresholded (>=128 opaque); the per-pixel alpha lives in the PNGs."""
    if not frames:
        return
    w = max(f.width for f in frames)
    h = max(f.height for f in frames)
    out = []
    for f in frames:
        rgba = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        rgba.alpha_composite(f.convert("RGBA"), ((w - f.width) // 2, (h - f.height) // 2))
        # Quantize colors (reserve palette index 255 for transparency).
        p = rgba.convert("RGB").quantize(colors=255, dither=Image.NONE)
        transparent = rgba.getchannel("A").point(lambda a: 255 if a < 128 else 0)
        p.paste(255, mask=transparent)
        out.append(p)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out[0].save(path, save_all=True, append_images=out[1:], duration=duration_ms,
                loop=0, transparency=255, disposal=2, optimize=False)


def frame_canvas(params):
    """Fixed per-skeleton frame size = 2x the declared size. PixelLab returns
    each character on its own ~2x content-fitted canvas (so sizes vary per
    character), and we normalize everything to this uniform canvas."""
    return (int(params["width"]) * 2, int(params["height"]) * 2)


def _normalize(img, target):
    """Transparent-center `img` onto a fixed `target` (w, h) canvas so every
    character/dress/animation in a skeleton shares one frame size. Center-crops
    if a frame is somehow larger than the target."""
    img = img.convert("RGBA")
    tw, th = target
    if img.size != (tw, th):
        if img.width > tw or img.height > th:
            l = max(0, (img.width - tw) // 2)
            t = max(0, (img.height - th) // 2)
            img = img.crop((l, t, l + min(tw, img.width), t + min(th, img.height)))
        canvas = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
        canvas.alpha_composite(img, ((tw - img.width) // 2, (th - img.height) // 2))
        img = canvas
    return img


# --- skeleton ---------------------------------------------------------------

def skeleton_dir(sid):
    return os.path.join(SKELETONS_DIR, sid)


def ensure_skeleton(cfg, index):
    """Create skeletons/<sid>/skeleton.json for the Nth skeleton if absent.
    A fresh skeleton starts with the base animations (idle, walk) and no dresses;
    the loop appends more (up to the caps) in the append phase."""
    params = skeleton_params(cfg, index)
    sid = params["id"]
    sdir = skeleton_dir(sid)
    meta_path = os.path.join(sdir, "skeleton.json")
    meta = _read_json(meta_path)
    if meta is None:
        meta = {
            "id": sid, "index": index, "params": params,
            "style": cfg["style_base"], "status": "in_progress",
            "animations": list(cfg["base_animations"]),
            "dresses": list(cfg.get("base_dresses", ["undressed"])),
        }
        _write_json(meta_path, meta)
    return sid, meta


def save_skeleton(sid, meta):
    _write_json(os.path.join(skeleton_dir(sid), "skeleton.json"), meta)


def list_skeletons():
    if not os.path.isdir(SKELETONS_DIR):
        return []
    out = []
    for name in sorted(os.listdir(SKELETONS_DIR)):
        meta = _read_json(os.path.join(SKELETONS_DIR, name, "skeleton.json"))
        if meta:
            out.append(meta)
    return out


# --- character --------------------------------------------------------------

def character_meta_path(sid, cid):
    return os.path.join(skeleton_dir(sid), "characters", cid, "character.json")


def list_characters(sid):
    cdir = os.path.join(skeleton_dir(sid), "characters")
    if not os.path.isdir(cdir):
        return []
    out = []
    for name in sorted(os.listdir(cdir)):
        meta = _read_json(os.path.join(cdir, name, "character.json"))
        if meta:
            out.append(meta)
    return out


def create_base_character(client, cfg, sid, skel_meta, char_index):
    """Create an UNDRESSED base character (neutral body, ready to be dressed)."""
    p = skel_meta["params"]
    look = CHARACTER_LOOKS[char_index % len(CHARACTER_LOOKS)]
    base_outfit = cfg.get("base_outfit", "wearing only plain underclothes, barefoot")
    desc = f"{look}, {base_outfit}, {cfg['style_base']}"
    cid_local = f"char_{char_index:02d}"
    cdir = os.path.join(skeleton_dir(sid), "characters", cid_local)

    character_id, rotations = client.create_character(
        description=desc, width=p["width"], height=p["height"], view=p["view"],
        directions=p.get("directions", 8),
        template_id=p.get("template_id", "mannequin"), outline=p.get("outline"),
        shading=p.get("shading"), detail=p.get("detail"),
        seed=_seed(sid, char_index),
    )
    canvas = frame_canvas(p)
    rotations = {d: _normalize(img, canvas) for d, img in rotations.items()}
    for direction, img in rotations.items():
        _save_png(img, os.path.join(cdir, "rotations", f"{direction}.png"))
    if "south" in rotations:
        _save_png(rotations["south"], os.path.join(cdir, "portrait.png"))
    elif rotations:
        _save_png(next(iter(rotations.values())), os.path.join(cdir, "portrait.png"))

    meta = {
        "local_id": cid_local, "pixellab_id": character_id, "index": char_index,
        "description": desc, "look": look, "skeleton": sid,
        "rotations": sorted(rotations.keys()), "animations": {}, "base_done": True,
    }
    _write_json(character_meta_path(sid, cid_local), meta)
    return meta


def animation_directions(cfg, skel_meta, char_meta=None):
    """The 4 or 8 directions this skeleton animates (from skeleton.params.directions).
    Intersected with the base's actual rotations when a character is given."""
    n = str(skel_meta.get("params", {}).get("directions", 8))
    dirs = (cfg.get("directions", {}).get(n)
            or (["south", "north", "east", "west"] if n == "4"
                else ["south", "north", "east", "west",
                      "south-east", "south-west", "north-east", "north-west"]))
    if char_meta:
        have = set(char_meta.get("rotations") or [])
        dirs = [d for d in dirs if d in have] or dirs
    return dirs


def _rel(p):
    return os.path.relpath(p, ROOT)


def _animate_into(client, adef, dirs, anim_out_dir, pixellab_id, canvas):
    """Animate `pixellab_id` across `dirs`, saving frames/strips/gifs into
    `anim_out_dir`, normalized to the skeleton's fixed `canvas`. Works for both
    base characters and dressed states. Returns {direction: {...}}."""
    key = adef["key"]
    frames_by_dir = client.animate(
        character_id=pixellab_id, animation_name=key,
        action_description=adef["action"], frame_count=adef.get("frames", 6),
        directions=dirs,
    )
    saved = {}
    for direction, frames in frames_by_dir.items():
        frames = [_normalize(f, canvas) for f in frames]
        fdir = os.path.join(anim_out_dir, key, direction)
        _save_frames(frames, fdir)
        strip = os.path.join(anim_out_dir, f"{key}__{direction}.png")
        gif = os.path.join(anim_out_dir, f"{key}__{direction}.gif")
        _save_strip(frames, strip)
        _save_gif(frames, gif)
        saved[direction] = {
            "frames": len(frames), "strip": _rel(strip), "gif": _rel(gif),
            "frame_paths": [_rel(os.path.join(fdir, f"{i:02d}.png")) for i in range(len(frames))],
        }
    return saved


def animate_variant(client, cfg, sid, skel_meta, char_meta, dress_id, adef):
    """Animate one animation for one variant of a character: the undressed base
    (dress_id=None) or one of its dresses. Saves frames and records the manifest
    in the right place. Returns the saved manifest dict."""
    cdir = os.path.join(skeleton_dir(sid), "characters", char_meta["local_id"])
    dirs = animation_directions(cfg, skel_meta, char_meta)
    if dress_id in (None, "undressed"):
        out_dir = os.path.join(cdir, "animations")
        pixellab_id = char_meta["pixellab_id"]
        target = char_meta.setdefault("animations", {})
    else:
        dress = char_meta["outfits"][dress_id]
        out_dir = os.path.join(cdir, "outfits", dress_id, "animations")
        pixellab_id = dress["pixellab_id"]
        target = dress.setdefault("animations", {})
    saved = _animate_into(client, adef, dirs, out_dir, pixellab_id,
                          frame_canvas(skel_meta["params"]))
    target[adef["key"]] = saved
    _write_json(character_meta_path(sid, char_meta["local_id"]), char_meta)
    return saved


def _save_frames(frames, dir_path):
    """Save individual frames as zero-padded PNGs; return their paths.

    The directory is cleared first so a regenerated animation with FEWER frames
    can't leave stale higher-numbered frames behind (mixing two versions)."""
    if os.path.isdir(dir_path):
        shutil.rmtree(dir_path)
    os.makedirs(dir_path, exist_ok=True)
    paths = []
    for i, f in enumerate(frames):
        p = os.path.join(dir_path, f"{i:02d}.png")
        f.save(p)
        paths.append(p)
    return paths


# --- outfits ("dresses") via character STATES (stored on PixelLab) ----------
#
# An outfit is one full clothing change (swim trunks -> godly armor), created as
# a PixelLab character STATE ("wearing X"). The state is a sibling character
# stored on PixelLab (visible in the UI, syncable) with its OWN animations
# regenerated wearing that clothing. There is no per-slot gear or layering —
# this matches what PixelLab supports.

def list_outfits(char_meta):
    return char_meta.get("outfits", {})


def create_dress_state(client, cfg, sid, skel_meta, char_meta, dress_def):
    """Create a dressed STATE (the dress's rotations) for a character. The dress's
    animations are filled in afterwards by animate_variant (the matrix fill), so
    every dress ends up with every animation. Returns the dress id."""
    dress_id = dress_def["id"]
    description = dress_def["description"]
    cid_local = char_meta["local_id"]
    odir = os.path.join(skeleton_dir(sid), "characters", cid_local, "outfits", dress_id)

    edit = f"wearing {description}"
    state_id, rotations = client.create_state(
        char_meta["pixellab_id"], edit_description=edit,
        seed=_seed(sid, cid_local, dress_id))
    canvas = frame_canvas(skel_meta["params"])
    rotations = {d: _normalize(img, canvas) for d, img in rotations.items()}
    for d, img in rotations.items():
        _save_png(img, os.path.join(odir, "rotations", f"{d}.png"))
    if "south" in rotations:
        _save_png(rotations["south"], os.path.join(odir, "portrait.png"))
    elif rotations:
        _save_png(next(iter(rotations.values())), os.path.join(odir, "portrait.png"))

    char_meta.setdefault("outfits", {})[dress_id] = {
        "id": dress_id, "description": description, "pixellab_id": state_id,
        "edit_description": edit, "rotations": sorted(rotations.keys()), "animations": {},
    }
    _write_json(character_meta_path(sid, cid_local), char_meta)
    return dress_id
