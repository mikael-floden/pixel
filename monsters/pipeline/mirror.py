"""Mirror one PixelLab monster (object OR character) into monsters/<id>/.

PixelLab is the source of truth for a monster's art — monsters are authored /
regenerated in the web UI or via the API, and this tool downloads the result so
the repo holds a full copy of the game data. Downloading costs ZERO generations.

Both PixelLab stores (create-object and create-character) expose the same read
shape — `rotation_urls` + `animations[]` with per-direction frame URLs — so one
code path packages either. Re-running is cheap: frames whose Last-Modified is
unchanged are skipped via If-Modified-Since (304).

Usage:
  python monsters/pipeline/mirror.py object <pixellab_id> --id poring \
      --alias walk=jump                      # game asking for "walk" plays "jump"
  python monsters/pipeline/mirror.py character <pixellab_id> --id forest_dragon
  python monsters/pipeline/mirror.py --all    # re-mirror every tracked monster

Output layout (one folder per monster; monster.json is the contract the game
reads — same spirit as objects/<id>/object.json):

  monsters/<id>/
    monster.json                    manifest: source ids, sizes, animations, aliases
    sprite.png                      base sprite (south rotation)
    rotations/<dir>.png             8 directions
    animations/<key>/<dir>/NN.png   per-frame PNGs
    animations/<key>__<dir>.png     sprite-sheet strip (all frames in a row)
    animations/<key>__<dir>.gif     looping preview (plays on GitHub)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil

from PIL import Image

from pixellab_client import PixelLabClient, PixelLabError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESERVED_DIRS = {"pipeline", "config", "spec"}
PREVIEW_MS = 100


# --- small helpers (packaging identical to the objects domain) ---------------

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


# --- animation-group handling ------------------------------------------------

def _best_groups(detail):
    """One merged group per display_name/description, unioned across duplicate
    groups — for each direction keep the version with the most frames (PixelLab
    sometimes creates duplicate/split groups)."""
    best = {}
    for a in detail.get("animations", []):
        key = a.get("display_name") or _slug(a.get("description")) or a.get("animation_group_id")
        g = best.setdefault(key, {"group_id": a.get("animation_group_id"),
                                  "description": a.get("description"), "dirs": {}})
        for x in a.get("directions", []):
            d = x.get("direction")
            fr = (x.get("storage_urls") or {}).get("frames") or []
            if d and fr and len(fr) > len(g["dirs"].get(d, [])):
                g["dirs"][d] = fr
    return best


def _short_keys(groups):
    """Map each raw group key to a short game-facing animation key: the first
    word of the description ('Attack, swing the tail...' -> 'attack') when that
    is unique across the monster's animations, else the full slug."""
    firsts = {}
    for raw, g in groups.items():
        first = (_slug(g.get("description")) or raw).split("_")[0]
        firsts.setdefault(first, []).append(raw)
    return {raw: (first if len(raws) == 1 else raw)
            for first, raws in firsts.items() for raw in raws}


def _download_series(client, urls, prev=None):
    """Download frame URLs -> ([PIL], last_modified). Returns (None, lm) when the
    whole series is unchanged since the last mirror (304 on frame 0)."""
    prev = prev or {}
    if prev.get("lm") and prev.get("src_frames") == len(urls):
        status, _, _ = client.conditional_download(urls[0], prev["lm"])
        if status == 304:
            return None, prev.get("lm")
    frames, lm = [], None
    for i, u in enumerate(urls):
        img = None
        for _ in range(4):
            status, img, got = client.conditional_download(u)
            if img is not None:
                if i == 0:
                    lm = got
                break
        if img is not None:
            frames.append(img)
    return frames, lm


def _exists(rel):
    return bool(rel) and os.path.exists(os.path.join(ROOT, rel))


# --- mirror one monster ------------------------------------------------------

def mirror(client, mid, kind, pixellab_id, aliases=None, name=None):
    """Pull rotations + all animations for one monster from PixelLab into
    monsters/<mid>/ and write its manifest. Idempotent + change-detected."""
    detail = client.get_source(kind, pixellab_id)
    size = detail.get("size") or {}
    w = int(size.get("width", 64)) if isinstance(size, dict) else int(size or 64)
    h = int(size.get("height", w)) if isinstance(size, dict) else w
    mdir = monster_dir(mid)
    prev = read_manifest(mid, {}) or {}

    # rotations (+ sprite.png = south)
    rots = {}
    for d, url in (detail.get("rotation_urls") or {}).items():
        if not url:
            continue
        img = client._download(url)
        if img is None:
            continue
        img = _normalize(img, w, h)
        _save_png(img, os.path.join(mdir, "rotations", f"{d}.png"))
        if d == "south":
            _save_png(img, os.path.join(mdir, "sprite.png"))
        rots[d] = _rel(os.path.join(mdir, "rotations", f"{d}.png"))
    print(f"  rotations: {len(rots)}")

    # animations (change-detected via If-Modified-Since)
    groups = _best_groups(detail)
    keys = _short_keys(groups)
    prev_anims = prev.get("animations") or {}
    anims = {}
    for raw, g in groups.items():
        key = keys[raw]
        prev_dirs = (prev_anims.get(key) or {}).get("directions") or {}
        saved = {}
        for direction, urls in sorted(g["dirs"].items()):
            frames, lm = _download_series(client, urls, prev_dirs.get(direction))
            if frames is None and _exists((prev_dirs.get(direction) or {}).get("gif")):
                saved[direction] = prev_dirs[direction]      # unchanged -> reuse
                print(f"  {key}/{direction}: unchanged, skipped")
                continue
            if not frames:
                print(f"  {key}/{direction}: NO frames downloaded")
                continue
            frames = [_normalize(f, w, h) for f in frames]
            fdir = os.path.join(mdir, "animations", key, direction)
            _save_frames(frames, fdir)
            strip = os.path.join(mdir, "animations", f"{key}__{direction}.png")
            gif = os.path.join(mdir, "animations", f"{key}__{direction}.gif")
            _save_strip(frames, strip)
            _save_gif(frames, gif)
            saved[direction] = {
                "frames": len(frames),
                "strip": _rel(strip),
                "gif": _rel(gif),
                "frame_paths": [_rel(os.path.join(fdir, f"{i:02d}.png"))
                                for i in range(len(frames))],
                "lm": lm, "src_frames": len(urls),
            }
            print(f"  {key}/{direction}: {len(frames)} frames")
        if saved:
            anims[key] = {"group_id": g["group_id"], "description": g["description"],
                          "directions": saved}

    meta = {
        "id": mid,
        "name": name or prev.get("name") or detail.get("name") or mid,
        "source": {
            "kind": kind,                       # object | character
            "pixellab_id": pixellab_id,
            "url": f"https://www.pixellab.ai/create-{kind}/{pixellab_id}",
            "prompt": detail.get("prompt") or detail.get("description"),
            "view": detail.get("view"),
        },
        "size": {"width": w, "height": h},
        "sprite": _rel(os.path.join(mdir, "sprite.png")),
        "directions": sorted(rots),
        "rotations": rots,
        "animations": anims,
        # game-facing indirection: "walk": "jump" means a game asking for the
        # walk animation should play this monster's jump frames.
        "animation_aliases": aliases if aliases is not None
                             else (prev.get("animation_aliases") or {}),
        "synced_from_pixellab": True,
    }
    write_manifest(mid, meta)
    return meta


# --- CLI ---------------------------------------------------------------------

def _parse_aliases(pairs):
    out = {}
    for p in pairs or []:
        if "=" not in p:
            raise SystemExit(f"--alias wants game_key=real_key, got {p!r}")
        k, v = p.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def main():
    ap = argparse.ArgumentParser(description="Mirror PixelLab monsters into monsters/<id>/.")
    ap.add_argument("kind", nargs="?", choices=["object", "character"],
                    help="which PixelLab store the monster lives in")
    ap.add_argument("pixellab_id", nargs="?", help="PixelLab object/character id (from the UI url)")
    ap.add_argument("--id", dest="mid", help="folder name under monsters/ (default: slug of the name/prompt)")
    ap.add_argument("--name", help="display name for the manifest")
    ap.add_argument("--alias", action="append", metavar="GAME_KEY=REAL_KEY",
                    help="animation alias, e.g. walk=jump (repeatable)")
    ap.add_argument("--all", action="store_true", help="re-mirror every tracked monster instead")
    args = ap.parse_args()

    client = PixelLabClient()
    if args.all:
        for mid, meta in iter_manifests():
            src = meta.get("source") or {}
            print(f"mirror {mid} ({src.get('kind')} {src.get('pixellab_id')})")
            mirror(client, mid, src.get("kind"), src.get("pixellab_id"))
        return
    if not (args.kind and args.pixellab_id):
        ap.error("need `kind pixellab_id` (or --all)")
    detail_name = args.name
    mid = args.mid
    if not mid:
        d = client.get_source(args.kind, args.pixellab_id)
        mid = _slug(d.get("name") or d.get("prompt") or d.get("description")) or args.pixellab_id[:8]
    print(f"mirror {mid} ({args.kind} {args.pixellab_id})")
    meta = mirror(client, mid, args.kind, args.pixellab_id,
                  aliases=_parse_aliases(args.alias), name=detail_name)
    n_anim = len(meta["animations"])
    n_dirs = {k: len(v["directions"]) for k, v in meta["animations"].items()}
    print(f"done: {len(meta['rotations'])} rotations, {n_anim} animation(s) {n_dirs}, "
          f"aliases={meta['animation_aliases']}")


if __name__ == "__main__":
    main()
