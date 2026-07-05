"""characters2 sync — mirror the two DECIDED heroes from PixelLab into the repo.

The heroes are now locked to two specific PixelLab characters (chosen in the UI
and pinned in config.json:pixellab_characters). PixelLab is the **source of
truth**: the user keeps adding animations (and later outfits/models) from the UI.
Re-running this script mirrors the current state down into humans/<name>/ with
ZERO generations — it only downloads what changed.

Layout it writes (per hero):

  humans/default_boy/
    character.json                 # manifest: pixellab id, prompt, style, and the
                                   #   source URL of every file (used for change-detection)
    base/
      south.png … south-west.png   # the static 8-direction model (native 112x112)
      preview.png                  # 8-direction strip
    animations/
      walking/
        south/ 0.png 1.png …       # frames per direction
        north/ …
        preview.gif                # animated preview (first available direction)
      breathing-idle/ …

Efficiency / staying in sync:
  * Each animation carries an `animation_group_id`; if it is unchanged AND the
    frames already exist on disk, the whole animation is skipped (no HTTP).
  * Each base rotation / frame records its source URL in the manifest; a file is
    re-downloaded only when its URL changes (PixelLab URLs are content-addressed,
    so a regenerated asset gets a new URL).
  * It is a true MIRROR: animations / directions / stray frames that no longer
    exist on PixelLab are removed locally, so deletions in the UI propagate.

  python characters2/pipeline/sync.py                 # sync both, commit + push
  python characters2/pipeline/sync.py default_girl    # just one
  python characters2/pipeline/sync.py --no-push
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess

from PIL import Image

from pixellab_client import DIRECTIONS_8, PixelLabClient

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # characters2/
REPO_ROOT = os.path.dirname(ROOT)
HUMANS = os.path.join(ROOT, "humans")
CONFIG = os.path.join(ROOT, "config.json")


def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def _read_json(path, default=None):
    if not os.path.exists(path):
        return default
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return default


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def _dir_key(order, d):
    try:
        return order.index(d)
    except ValueError:
        return len(order)


# --- mirroring one character ------------------------------------------------

def sync_character(client, name, cid):
    """Mirror one PixelLab character (base rotations + all animations) into
    humans/<name>/. Returns a short summary dict."""
    root = os.path.join(HUMANS, name)
    os.makedirs(root, exist_ok=True)
    prev = _read_json(os.path.join(root, "character.json"), {}) or {}
    prev_rot = (prev.get("rotations") or {})
    prev_anims = (prev.get("animations") or {})

    detail = client.get_character(cid)
    rotation_urls = {d: u for d, u in (detail.get("rotation_urls") or {}).items() if u}
    api_anims = detail.get("animations") or []

    stats = {"rot_new": 0, "rot_skip": 0, "anim_new": 0, "anim_skip": 0, "frames": 0}

    # -- base rotations ------------------------------------------------------
    base_dir = os.path.join(root, "base")
    os.makedirs(base_dir, exist_ok=True)
    saved_rot = {}
    for d, url in rotation_urls.items():
        dst = os.path.join(base_dir, f"{d}.png")
        if prev_rot.get(d) == url and os.path.exists(dst):
            saved_rot[d] = url
            stats["rot_skip"] += 1
            continue
        img = client.download_image(url)
        if img is None:
            saved_rot[d] = prev_rot.get(d)          # keep old record if download failed
            continue
        img.convert("RGBA").save(dst)
        saved_rot[d] = url
        stats["rot_new"] += 1
    # drop base pngs for directions no longer present
    for fn in os.listdir(base_dir):
        d = fn[:-4]
        if fn.endswith(".png") and fn != "preview.png" and d not in rotation_urls:
            os.remove(os.path.join(base_dir, fn))
    _write_base_preview(base_dir, rotation_urls.keys())

    # -- animations ----------------------------------------------------------
    anims_dir = os.path.join(root, "animations")
    os.makedirs(anims_dir, exist_ok=True)
    saved_anims = {}
    seen_types = set()
    for a in api_anims:
        atype = a.get("animation_type") or a.get("animation_group_id")
        if not atype:
            continue
        seen_types.add(atype)
        gid = a.get("animation_group_id")
        adir = os.path.join(anims_dir, atype)
        dirs_payload = a.get("directions") or []
        # map direction -> list of frame urls
        want = {}
        for dp in dirs_payload:
            dd = dp.get("direction")
            frames = [u for u in (dp.get("frames") or []) if u]
            if dd and frames:
                want[dd] = frames

        prev_a = prev_anims.get(atype) or {}
        unchanged = (prev_a.get("animation_group_id") == gid and gid is not None
                     and _anim_on_disk(adir, want))
        if unchanged:
            saved_anims[atype] = prev_a
            stats["anim_skip"] += 1
            _write_anim_preview(adir, want.keys())
            continue

        os.makedirs(adir, exist_ok=True)
        rec_dirs = {}
        for dd, frames in want.items():
            ddir = os.path.join(adir, dd)
            os.makedirs(ddir, exist_ok=True)
            for i, url in enumerate(frames):
                dst = os.path.join(ddir, f"{i}.png")
                img = client.download_image(url)
                if img is None:
                    continue
                img.convert("RGBA").save(dst)
                stats["frames"] += 1
            # trim stray frames beyond current frame_count
            for fn in os.listdir(ddir):
                if fn.endswith(".png") and fn != "preview.gif":
                    idx = fn[:-4]
                    if idx.isdigit() and int(idx) >= len(frames):
                        os.remove(os.path.join(ddir, fn))
            rec_dirs[dd] = {"frame_count": len(frames), "frames": frames}
        # drop direction folders no longer present
        for fn in os.listdir(adir):
            p = os.path.join(adir, fn)
            if os.path.isdir(p) and fn not in want:
                shutil.rmtree(p)
        _write_anim_preview(adir, want.keys())
        saved_anims[atype] = {
            "animation_group_id": gid,
            "display_name": a.get("display_name"),
            "directions": rec_dirs,
        }
        stats["anim_new"] += 1

    # drop animation folders no longer on PixelLab (true mirror)
    for fn in os.listdir(anims_dir):
        p = os.path.join(anims_dir, fn)
        if os.path.isdir(p) and fn not in seen_types:
            shutil.rmtree(p)

    _write_json(os.path.join(root, "character.json"), {
        "id": name,
        "pixellab_character_id": cid,
        "name": detail.get("name"),
        "prompt": detail.get("prompt"),
        "size": [detail.get("size", {}).get("width"), detail.get("size", {}).get("height")],
        "view": detail.get("view"),
        "template_id": detail.get("template_id"),
        "style_settings": detail.get("style_settings"),
        "group_id": detail.get("group_id"),
        "directions": detail.get("directions"),
        "rotations": saved_rot,
        "animations": saved_anims,
        "source": "pixellab.ai character (mirrored by sync.py; PixelLab is source of truth)",
    })
    return stats


def _anim_on_disk(adir, want):
    """True if every wanted direction/frame already exists on disk."""
    for dd, frames in want.items():
        ddir = os.path.join(adir, dd)
        for i in range(len(frames)):
            if not os.path.exists(os.path.join(ddir, f"{i}.png")):
                return False
    return True


def _write_base_preview(base_dir, dirs):
    order = [d for d in DIRECTIONS_8 if d in dirs]
    imgs = []
    for d in order:
        p = os.path.join(base_dir, f"{d}.png")
        if os.path.exists(p):
            imgs.append(Image.open(p).convert("RGBA"))
    if not imgs:
        return
    w = max(i.width for i in imgs); h = max(i.height for i in imgs)
    strip = Image.new("RGBA", (w * len(imgs), h), (0, 0, 0, 0))
    for i, im in enumerate(imgs):
        strip.alpha_composite(im, (i * w, 0))
    strip.save(os.path.join(base_dir, "preview.png"))


def _write_anim_preview(adir, dirs):
    """Animated GIF of the first available direction (south preferred)."""
    order = [d for d in DIRECTIONS_8 if d in dirs] or list(dirs)
    if not order:
        return
    d = order[0]
    ddir = os.path.join(adir, d)
    if not os.path.isdir(ddir):
        return
    idxs = sorted(int(f[:-4]) for f in os.listdir(ddir)
                  if f.endswith(".png") and f[:-4].isdigit())
    frames = [Image.open(os.path.join(ddir, f"{i}.png")).convert("RGBA") for i in idxs]
    if len(frames) < 2:
        return
    bg = [Image.new("RGBA", f.size, (0, 0, 0, 0)) for f in frames]
    for b, f in zip(bg, frames):
        b.alpha_composite(f)
    bg[0].save(os.path.join(adir, "preview.gif"), save_all=True,
               append_images=bg[1:], duration=120, loop=0, disposal=2)


# --- git --------------------------------------------------------------------

def _git(*args, check=True):
    return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=check)


def commit_push(message, push=True):
    _git("add", "-A", "characters2")
    if not _git("status", "--porcelain", "--", "characters2").stdout.strip():
        return False
    _git("commit", "-m", message)
    if push:
        import time
        branch = _git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or "main"
        for attempt in range(4):
            if _git("push", "origin", branch, check=False).returncode == 0:
                break
            _git("fetch", "origin", branch, check=False)
            _git("rebase", f"origin/{branch}", check=False)
            time.sleep(2 ** (attempt + 1))
    return True


# --- main -------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Mirror the two heroes (+ animations) from PixelLab.")
    ap.add_argument("names", nargs="*", help="Which heroes to sync (default: all pinned).")
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()

    cfg = load_config()
    pins = cfg.get("pixellab_characters") or {}
    if not pins:
        raise SystemExit("config.json:pixellab_characters is empty — nothing to sync.")
    targets = args.names or list(pins.keys())

    client = PixelLabClient()
    for name in targets:
        cid = pins.get(name)
        if not cid:
            print(f"! {name}: not pinned in config, skipping")
            continue
        print(f"+ syncing {name} <- {cid}")
        s = sync_character(client, name, cid)
        print(f"  {name}: rotations +{s['rot_new']}/skip {s['rot_skip']} | "
              f"animations +{s['anim_new']}/skip {s['anim_skip']} | {s['frames']} frames downloaded")
        commit_push(f"characters2: sync {name} from PixelLab "
                    f"(+{s['anim_new']} anims, +{s['frames']} frames)", push=not args.no_push)

    print("done.")


if __name__ == "__main__":
    main()
