"""High-level factory operations: skeletons, characters, animations, gear.

Each operation is small and resumable: it writes its result to disk and updates a
status field in JSON, so the loop can stop/restart at any point and pick up the
next missing unit by reading the filesystem. PixelLab paints the pixels; this
module decides what to ask for, where to store it, and how to package it
(per-direction PNG strips for the game + a dark-background GIF for quick mobile
preview).

Asset layout:
  skeletons/<sid>/skeleton.json
  skeletons/<sid>/characters/<cid>/character.json
  skeletons/<sid>/characters/<cid>/rotations/<dir>.png
  skeletons/<sid>/characters/<cid>/animations/<key>__<dir>.png   (frame strip)
  skeletons/<sid>/characters/<cid>/animations/<key>.gif          (preview)
  skeletons/<sid>/gear/<slot>/<gear_id>.png                      (shared per skeleton)
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

# A roster of distinct farmer/villager looks so the 10 characters don't clone.
CHARACTER_LOOKS = [
    "a young freckled farmhand with tousled red hair and a green shirt",
    "a weathered old farmer with a long grey beard and a brown coat",
    "a sturdy blacksmith woman with dark braided hair and a leather apron",
    "a lanky scarecrow-thin youth in patched overalls and a straw hat",
    "a cheerful round baker in a flour-dusted white tunic",
    "a stern ranger with a hooded green cloak and a quiver",
    "a freckled girl in a blue dress with twin ponytails",
    "a bald burly woodcutter with a thick beard and suspenders",
    "a tanned fisherman in a striped shirt and rubber boots",
    "a quiet herbalist in earthy robes with a satchel of herbs",
    "a mischievous kid in a oversized red poncho",
    "a dignified elder in a long embroidered robe",
]


# --- config / params --------------------------------------------------------

def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def skeleton_params(cfg, index):
    """Params for the Nth skeleton: explicit variations first, then procedural."""
    variations = cfg["skeleton_variations"]
    if index < len(variations):
        return dict(variations[index])
    pv = cfg["procedural_variation"]
    views, sizes, details = pv["views"], pv["sizes"], pv["details"]
    v = views[index % len(views)]
    w, h = sizes[(index // len(views)) % len(sizes)]
    det = details[(index // (len(views) * len(sizes))) % len(details)]
    dirs = ["south", "north", "east", "west"] if "top-down" in v else ["east"]
    return {
        "id": f"{index:02d}_{v.replace(' ', '')}_{w}x{h}",
        "note": f"Procedural variation #{index}", "view": v, "width": w, "height": h,
        "animation_directions": dirs, "template_id": "mannequin",
        "outline": "single color black outline", "shading": "basic shading", "detail": det,
    }


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
    """Dark-background GIF for quick mobile preview (true alpha lives in PNGs)."""
    if not frames:
        return
    w = max(f.width for f in frames)
    h = max(f.height for f in frames)
    flat = []
    for f in frames:
        bg = Image.new("RGBA", (w, h), PREVIEW_BG)
        bg.alpha_composite(f, ((w - f.width) // 2, (h - f.height) // 2))
        flat.append(bg.convert("RGB"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    flat[0].save(path, save_all=True, append_images=flat[1:], duration=duration_ms,
                 loop=0, optimize=True)


# --- skeleton ---------------------------------------------------------------

def skeleton_dir(sid):
    return os.path.join(SKELETONS_DIR, sid)


def ensure_skeleton(cfg, index):
    """Create skeletons/<sid>/skeleton.json for the Nth skeleton if absent."""
    params = skeleton_params(cfg, index)
    sid = params["id"]
    sdir = skeleton_dir(sid)
    meta_path = os.path.join(sdir, "skeleton.json")
    meta = _read_json(meta_path)
    if meta is None:
        meta = {
            "id": sid, "index": index, "params": params,
            "style": cfg["style_base"], "status": "in_progress",
        }
        _write_json(meta_path, meta)
    return sid, meta


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
    """Create a base character (8 rotations) and save them."""
    p = skel_meta["params"]
    look = CHARACTER_LOOKS[char_index % len(CHARACTER_LOOKS)]
    desc = f"{look}, {cfg['style_base']}"
    cid_local = f"char_{char_index:02d}"
    cdir = os.path.join(skeleton_dir(sid), "characters", cid_local)

    character_id, rotations = client.create_character(
        description=desc, width=p["width"], height=p["height"], view=p["view"],
        template_id=p.get("template_id", "mannequin"), outline=p.get("outline"),
        shading=p.get("shading"), detail=p.get("detail"),
        seed=_seed(sid, char_index),
    )
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


def animation_directions(skel_meta, char_meta):
    """Directions to animate = every orientation the character actually has.

    The character's `rotations` are the source of truth so animations always
    match the character's orientation count. A skeleton may cap this with
    `params.animation_directions` (e.g. to save generations during exploration);
    we intersect, preserving the character's order.
    """
    have = char_meta.get("rotations") or ["south"]
    cap = skel_meta.get("params", {}).get("animation_directions")
    if cap:
        capset = set(cap)
        return [d for d in have if d in capset] or list(cap)
    return have


def _rel(p):
    return os.path.relpath(p, ROOT)


def _animate_into(client, pixellab_id, anim_def, dirs, anim_out_dir):
    """Animate `pixellab_id` across `dirs`, saving frames/strips/gifs into
    `anim_out_dir`. Works for both base characters and equipped states.
    Returns {direction: {...}} for the manifest."""
    key = anim_def["key"]
    frames_by_dir = client.animate(
        character_id=pixellab_id, animation_name=key,
        action_description=anim_def["action"], frame_count=anim_def.get("frames", 6),
        directions=dirs,
    )
    saved = {}
    for direction, frames in frames_by_dir.items():
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


def animate_one(client, cfg, sid, skel_meta, char_meta, anim_def):
    """Animate a base character across all its orientations."""
    cdir = os.path.join(skeleton_dir(sid), "characters", char_meta["local_id"])
    dirs = animation_directions(skel_meta, char_meta)
    saved = _animate_into(client, char_meta["pixellab_id"], anim_def, dirs,
                          os.path.join(cdir, "animations"))
    char_meta.setdefault("animations", {})[anim_def["key"]] = saved
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


# --- gear icons (inventory thumbnails, shared per skeleton) -----------------

def gear_state(sid):
    return _read_json(os.path.join(skeleton_dir(sid), "gear", "gear.json"), default={}) or {}


def make_gear(client, cfg, sid, skel_meta, slot_def, archetype_index):
    """Generate one gear sprite for a slot; gear is shared across the skeleton."""
    p = skel_meta["params"]
    slot = slot_def["slot"]
    archetype = slot_def["archetypes"][archetype_index]
    gear_id = f"{slot}_{archetype_index:02d}"
    gdir = os.path.join(skeleton_dir(sid), "gear", slot)

    # Use a character portrait as a palette reference so gear matches the roster.
    color_ref = None
    chars = list_characters(sid)
    if chars:
        port = os.path.join(skeleton_dir(sid), "characters",
                            chars[0]["local_id"], "portrait.png")
        if os.path.exists(port):
            with open(port, "rb") as fh:
                color_ref = {"type": "base64", "base64": base64.b64encode(fh.read()).decode()}

    desc = (f"a single {archetype}, isolated clothing item icon, centered, "
            f"{cfg['style_base']}")
    img = client.create_item_sprite(
        description=desc, width=p["width"], height=p["height"], view=p["view"],
        outline=p.get("outline"), shading=p.get("shading"), detail=p.get("detail"),
        color_image=color_ref, seed=_seed(sid, slot, archetype_index),
    )
    icon_path = os.path.join(gdir, gear_id, "icon.png")
    _save_png(img, icon_path)

    state = gear_state(sid)
    state.setdefault(slot, {})[gear_id] = {
        "archetype": archetype, "z": slot_def.get("z", 0), "slot": slot,
        "icon": os.path.relpath(icon_path, ROOT),
    }
    _write_json(os.path.join(skeleton_dir(sid), "gear", "gear.json"), state)
    return gear_id


# --- equipment via character STATES (stored on PixelLab, source of truth) ---

def list_states(char_meta):
    return char_meta.get("states", {})


def equip_state(client, cfg, sid, skel_meta, char_meta, slot_def, archetype_index,
                animate_keys=None):
    """Equip gear by creating a PixelLab character STATE — a sibling character
    that wears the gear, stored on PixelLab (visible in the UI, syncable). We
    save the state's rotations and animate the configured animations so the gear
    is part of the motion. Returns the gear_id."""
    slot = slot_def["slot"]
    archetype = slot_def["archetypes"][archetype_index]
    gear_id = f"{slot}_{archetype_index:02d}"
    cid_local = char_meta["local_id"]
    sdir = os.path.join(skeleton_dir(sid), "characters", cid_local, "states", gear_id)

    edit = f"wearing {archetype}"
    state_id, rotations = client.create_state(
        char_meta["pixellab_id"], edit_description=edit,
        seed=_seed(sid, cid_local, gear_id))
    for d, img in rotations.items():
        _save_png(img, os.path.join(sdir, "rotations", f"{d}.png"))
    if "south" in rotations:
        _save_png(rotations["south"], os.path.join(sdir, "portrait.png"))

    state_meta = {
        "gear_id": gear_id, "slot": slot, "archetype": archetype,
        "pixellab_id": state_id, "edit_description": edit,
        "rotations": sorted(rotations.keys()), "animations": {},
    }
    dirs = animation_directions(skel_meta, char_meta)
    for key in (animate_keys or []):
        adef = next((a for a in cfg["animations"] if a["key"] == key), None)
        if adef:
            state_meta["animations"][key] = _animate_into(
                client, state_id, adef, dirs, os.path.join(sdir, "animations"))

    char_meta.setdefault("states", {})[gear_id] = state_meta
    _write_json(character_meta_path(sid, cid_local), char_meta)
    return gear_id
