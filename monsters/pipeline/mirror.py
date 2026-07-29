"""Mirror one PixelLab monster (object OR character) into monsters/<id>/.

PixelLab is the source of truth for a monster's art — monsters are authored /
regenerated in the web UI, tagged MONSTER, and this tool downloads the result so
the repo holds a full copy of the game data. Downloading costs ZERO generations.

Both PixelLab stores are supported through one code path: the client's
`normalized_animations()` folds the object shape (description +
storage_urls.frames) and the character shape (animation_type + frames) into
{name, group_id, directions:{dir:[urls]}}.

Animation keys are CANONICAL GAME STATES. Each monster's roster entry carries
`renames`: {<exact PixelLab animation name>: idle|walk|angry|attack|die}, so on
disk every monster exposes the same keys regardless of how the animation was
worded in the UI ("Jumps like a frog" -> walk). Unmapped animations keep a
slugged key and are surfaced as extras. The manifest also carries `states`:
the resolved state->key map with the angry->idle fallback applied.

Usage (sync.py drives this; ad-hoc use):
  python monsters/pipeline/mirror.py object <id-from-url> --id frog \
      --rename "Jumps like a frog=walk" --rename "Calm peaceful idle=idle"

Output layout (one folder per monster; monster.json is the contract):

  monsters/<id>/
    monster.json                    manifest: source ids, sizes, animations, states
    sprite.png                      base sprite (south rotation)
    rotations/<dir>.png             8 directions
    animations/<key>/<dir>/NN.png   per-frame PNGs
    animations/<key>__<dir>.png     sprite-sheet strip (all frames in a row)
    animations/<key>__<dir>.gif     looping preview of one direction
    animations/<key>__rotating.gif  plays the full animation in one direction,
                                    then rotates one step (45°) and plays again,
                                    through all 8 directions
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil

from PIL import Image

from pixellab_client import DIRECTIONS_8, PixelLabClient

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESERVED_DIRS = {"pipeline", "config", "spec"}
STATES = ("idle", "walk", "angry", "attack", "die")
PREVIEW_MS = 120


# --- small helpers -----------------------------------------------------------

def _slug(s):
    return re.sub(r"[^a-z0-9]+", "_", (s or "").lower()).strip("_")


def monster_dir(mid):
    return os.path.join(ROOT, mid)


def manifest_path(mid):
    return os.path.join(monster_dir(mid), "monster.json")


def _rel(p):
    return os.path.relpath(p, ROOT)


def read_manifest(mid, default=None):
    p = manifest_path(mid)
    if not os.path.exists(p):
        return default
    with open(p) as f:
        return json.load(f)


def write_manifest(mid, data):
    os.makedirs(monster_dir(mid), exist_ok=True)
    with open(manifest_path(mid), "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def iter_manifests():
    out = []
    for name in sorted(os.listdir(ROOT)):
        if name in RESERVED_DIRS or name.startswith("."):
            continue
        meta = read_manifest(name)
        if meta:
            out.append((name, meta))
    return out


def _save_png(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)


def _normalize(img, w, h):
    """Transparent-center `img` onto a fixed (w, h) canvas so every asset of a
    monster shares one canvas."""
    img = img.convert("RGBA")
    tw, th = int(w), int(h)
    if img.size == (tw, th):
        return img
    if img.width > tw or img.height > th:
        l = max(0, (img.width - tw) // 2)
        t = max(0, (img.height - th) // 2)
        img = img.crop((l, t, l + min(tw, img.width), t + min(th, img.height)))
    canvas = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    canvas.alpha_composite(img, ((tw - img.width) // 2, (th - img.height) // 2))
    return canvas


def _save_frames(frames, dir_path):
    if os.path.isdir(dir_path):
        shutil.rmtree(dir_path)
    os.makedirs(dir_path, exist_ok=True)
    for i, f in enumerate(frames):
        f.save(os.path.join(dir_path, f"{i:02d}.png"))


def _save_strip(frames, path):
    if not frames:
        return
    w = max(f.width for f in frames)
    h = max(f.height for f in frames)
    strip = Image.new("RGBA", (w * len(frames), h), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        strip.alpha_composite(f, (i * w + (w - f.width) // 2, (h - f.height) // 2))
    _save_png(strip, path)


def _gif_quantize(frames):
    out = []
    w = max(f.width for f in frames)
    h = max(f.height for f in frames)
    for f in frames:
        rgba = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        rgba.alpha_composite(f.convert("RGBA"), ((w - f.width) // 2, (h - f.height) // 2))
        p = rgba.convert("RGB").quantize(colors=255, dither=Image.NONE)
        transparent = rgba.getchannel("A").point(lambda a: 255 if a < 128 else 0)
        p.paste(255, mask=transparent)
        out.append(p)
    return out


def _save_gif(frames, path, duration_ms=PREVIEW_MS):
    if not frames:
        return
    out = _gif_quantize(frames)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out[0].save(path, save_all=True, append_images=out[1:], duration=duration_ms,
                loop=0, transparency=255, disposal=2, optimize=False)


def save_rotating_gif(frames_by_dir, path, duration_ms=PREVIEW_MS):
    """The review GIF: play the full animation facing one direction, then turn
    one 45° step and play it again, all the way around (8 plays per loop).
    Directions follow DIRECTIONS_8 so consecutive plays are adjacent headings."""
    seq = []
    for d in DIRECTIONS_8:
        seq.extend(frames_by_dir.get(d) or [])
    if seq:
        _save_gif(seq, path, duration_ms)


# --- mirror one monster ------------------------------------------------------

def _key_for(name, renames, taken):
    """Canonical on-disk key for a PixelLab animation name: the roster rename if
    present, else a slug; de-duped with _2, _3… if two animations collide."""
    key = renames.get(name) or _slug(name)[:40] or "anim"
    base, n = key, 1
    while key in taken:
        n += 1
        key = f"{base}_{n}"
    taken.add(key)
    return key


def resolve_states(anim_keys):
    """The state->animation-key map for a monster. Identity where the canonical
    key exists; the maintainer's rule 'no angry -> use idle for both' applied;
    missing states resolve to None (surfaced by sync's verify)."""
    states = {}
    for s in STATES:
        if s in anim_keys:
            states[s] = s
        elif s == "angry" and "idle" in anim_keys:
            states[s] = "idle"
        else:
            states[s] = None
    return states


def mirror(client, mid, kind, pixellab_id, renames=None, name=None, detail=None):
    """Pull rotations + all animations for one monster from PixelLab into
    monsters/<mid>/ and write its manifest. Change-detected per direction via
    If-Modified-Since; frames download concurrently. Returns the manifest."""
    detail = detail or client.get_source(kind, pixellab_id)
    renames = renames or {}
    size = detail.get("size") or {}
    w = int(size.get("width", 64)) if isinstance(size, dict) else int(size or 64)
    h = int(size.get("height", w)) if isinstance(size, dict) else w
    mdir = monster_dir(mid)
    prev = read_manifest(mid, {}) or {}

    # rotations (+ sprite.png = south)
    rot_urls = {d: u for d, u in (detail.get("rotation_urls") or {}).items() if u}
    rots = {}
    imgs = client.download_many(list(rot_urls.values()))
    for (d, _), img in zip(rot_urls.items(), imgs):
        if img is None:
            continue
        img = _normalize(img, w, h)
        _save_png(img, os.path.join(mdir, "rotations", f"{d}.png"))
        if d == "south":
            _save_png(img, os.path.join(mdir, "sprite.png"))
        rots[d] = _rel(os.path.join(mdir, "rotations", f"{d}.png"))

    # animations
    prev_anims = prev.get("animations") or {}
    anims = {}
    taken = set()
    for g in client.normalized_animations(kind, detail):
        key = _key_for(g["name"], renames, taken)
        prev_dirs = (prev_anims.get(key) or {}).get("directions") or {}
        saved, frames_by_dir = {}, {}
        for direction, urls in sorted(g["directions"].items()):
            pv = prev_dirs.get(direction) or {}
            unchanged = False
            if pv.get("lm") and pv.get("src_frames") == len(urls) \
                    and _exists(pv.get("gif")):
                status, _, _ = client.conditional_download(urls[0], pv["lm"])
                unchanged = status == 304
            if unchanged:
                saved[direction] = pv
                fdir = os.path.join(mdir, "animations", key, direction)
                frames_by_dir[direction] = _load_frames(fdir, w, h)
                continue
            lm = client.last_modified(urls[0])
            frames = [f for f in client.download_many(urls) if f is not None]
            if not frames:
                print(f"  !! {key}/{direction}: NO frames downloaded")
                continue
            frames = [_normalize(f, w, h) for f in frames]
            frames_by_dir[direction] = frames
            fdir = os.path.join(mdir, "animations", key, direction)
            _save_frames(frames, fdir)
            strip = os.path.join(mdir, "animations", f"{key}__{direction}.png")
            gif = os.path.join(mdir, "animations", f"{key}__{direction}.gif")
            _save_strip(frames, strip)
            _save_gif(frames, gif)
            saved[direction] = {
                "frames": len(frames),
                "strip": _rel(strip), "gif": _rel(gif),
                "frame_paths": [_rel(os.path.join(fdir, f"{i:02d}.png"))
                                for i in range(len(frames))],
                "lm": lm, "src_frames": len(urls),
            }
        if not saved:
            continue
        rot_gif = os.path.join(mdir, "animations", f"{key}__rotating.gif")
        save_rotating_gif(frames_by_dir, rot_gif)
        anims[key] = {
            "group_id": g.get("group_id"),
            "source_name": g["name"],
            "directions": saved,
            "rotating_gif": _rel(rot_gif),
        }
        dirs_n = len(saved)
        print(f"  {key}: {dirs_n} dir(s) "
              f"x{sorted({v['frames'] for v in saved.values()})} frames  "
              f"(from {g['name'][:40]!r})")

    # prune animation folders/files that no longer exist on PixelLab
    _prune_stale(mdir, set(anims))

    meta = {
        "id": mid,
        "name": name or prev.get("name") or detail.get("name") or mid,
        "source": {
            "kind": kind,
            "pixellab_id": pixellab_id,
            "url": f"https://www.pixellab.ai/create-{kind}/{pixellab_id}",
            "prompt": (detail.get("prompt") or detail.get("description") or "").strip(),
            "view": detail.get("view"),
            "tags": detail.get("tags"),
        },
        "size": {"width": w, "height": h},
        "sprite": _rel(os.path.join(mdir, "sprite.png")),
        "directions": sorted(rots),
        "rotations": rots,
        "animations": anims,
        "states": resolve_states(set(anims)),
        "synced_from_pixellab": True,
    }
    write_manifest(mid, meta)
    return meta


def _exists(rel):
    return bool(rel) and os.path.exists(os.path.join(ROOT, rel))


def _load_frames(fdir, w, h):
    """Frames already on disk (for rebuilding the rotating gif on 304-skips)."""
    if not os.path.isdir(fdir):
        return []
    names = sorted(f for f in os.listdir(fdir) if f.endswith(".png"))
    return [_normalize(Image.open(os.path.join(fdir, f)), w, h) for f in names]


def _prune_stale(mdir, live_keys):
    """Remove animation folders + derived files whose key vanished upstream."""
    adir = os.path.join(mdir, "animations")
    if not os.path.isdir(adir):
        return
    for fn in os.listdir(adir):
        p = os.path.join(adir, fn)
        key = fn.split("__")[0] if "__" in fn else fn
        if key not in live_keys:
            (shutil.rmtree if os.path.isdir(p) else os.remove)(p)


# --- CLI ---------------------------------------------------------------------

def _parse_pairs(pairs):
    out = {}
    for p in pairs or []:
        if "=" not in p:
            raise SystemExit(f"expected NAME=state, got {p!r}")
        k, v = p.rsplit("=", 1)
        out[k] = v.strip()
    return out


def main():
    ap = argparse.ArgumentParser(description="Mirror one PixelLab monster into monsters/<id>/.")
    ap.add_argument("kind", choices=["object", "character"])
    ap.add_argument("pixellab_id")
    ap.add_argument("--id", dest="mid", required=True, help="folder name under monsters/")
    ap.add_argument("--name", help="display name for the manifest")
    ap.add_argument("--rename", action="append", metavar="ANIM_NAME=state",
                    help="map an exact PixelLab animation name to a canonical state key")
    args = ap.parse_args()
    client = PixelLabClient()
    meta = mirror(client, args.mid, args.kind, args.pixellab_id,
                  renames=_parse_pairs(args.rename), name=args.name)
    print(f"done: {len(meta['rotations'])} rotations, {len(meta['animations'])} animation(s), "
          f"states={meta['states']}")


if __name__ == "__main__":
    main()
