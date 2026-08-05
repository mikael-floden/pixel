"""characters2 generator — the game's two heroes, versioned.

Two characters: humans/default_boy and humans/default_girl. Each is a persistent
8-direction static PixelLab character (create-character-with-8-directions) at the
fixed human skeleton (low top-down, low detail, default outline). The sprites are
kept at PixelLab's **native** canvas (112x112) — no cropping.

VERSIONED: we never delete/replace. Each generation writes a new numbered
version:

  characters2/humans/default_boy/
    v001/  south.png … character.json preview.png
    v002/  …
    LATEST                                # text file: the newest version id

so you can accumulate takes and keep the ones you like.

  python characters2/pipeline/generate.py                 # ensure each has a v001
  python characters2/pipeline/generate.py --new           # add a new version to both
  python characters2/pipeline/generate.py --new default_girl   # new version of the girl only
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import zlib

from PIL import Image

from pixellab_client import BudgetExhausted, DIRECTIONS_8, PixelLabClient

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # characters2/
REPO_ROOT = os.path.dirname(ROOT)
HUMANS = os.path.join(ROOT, "humans")
CONFIG = os.path.join(ROOT, "config.json")


def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def _seed(*parts):
    return zlib.crc32(("::".join(str(p) for p in parts)).encode()) % (2 ** 31)


def _read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path) as f:
        return json.load(f)


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


# --- versions ---------------------------------------------------------------

def char_root(name):
    return os.path.join(HUMANS, name)


def version_dir(name, v):
    return os.path.join(char_root(name), f"v{v:03d}")


def existing_versions(name):
    d = char_root(name)
    if not os.path.isdir(d):
        return []
    out = []
    for n in os.listdir(d):
        if n.startswith("v") and n[1:].isdigit() and os.path.isdir(os.path.join(d, n)):
            out.append(int(n[1:]))
    return sorted(out)


def next_version(name):
    vs = existing_versions(name)
    return (vs[-1] + 1) if vs else 1


# --- packaging (keep native canvas, no crop) --------------------------------

def _uniform_native(rotations):
    """Pad every rotation onto one square canvas = the largest native frame, so
    all 8 directions share a size. No cropping/scaling — PixelLab's 112x112 look
    is preserved. Returns (dict, size)."""
    s = max(max(im.width, im.height) for im in rotations.values())
    out = {}
    for d, im in rotations.items():
        im = im.convert("RGBA")
        if im.size == (s, s):
            out[d] = im
        else:
            c = Image.new("RGBA", (s, s), (0, 0, 0, 0))
            c.alpha_composite(im, ((s - im.width) // 2, (s - im.height) // 2))
            out[d] = c
    return out, s


def _save_preview(rotations, path):
    order = [d for d in DIRECTIONS_8 if d in rotations]
    w = max(rotations[d].width for d in order)
    h = max(rotations[d].height for d in order)
    strip = Image.new("RGBA", (w * len(order), h), (0, 0, 0, 0))
    for i, d in enumerate(order):
        strip.alpha_composite(rotations[d], (i * w, 0))
    strip.save(path)


def save_version(name, v, cid, rotations, size, seed, description, params):
    """Write one version's 8 sprites + portrait + preview + manifest."""
    vdir = version_dir(name, v)
    os.makedirs(vdir, exist_ok=True)
    for d, im in rotations.items():
        im.save(os.path.join(vdir, f"{d}.png"))
    if "south" in rotations:
        rotations["south"].save(os.path.join(vdir, "portrait.png"))
    _save_preview(rotations, os.path.join(vdir, "preview.png"))
    _write_json(os.path.join(vdir, "character.json"), {
        "id": name, "version": v, "pixellab_character_id": cid,
        "description": description, "params": params, "size": [size, size],
        "directions": sorted(rotations.keys()), "seed": seed,
        "source": "pixellab.ai create-character-with-8-directions (8-dir static, native canvas)",
    })
    with open(os.path.join(char_root(name), "LATEST"), "w") as f:
        f.write(f"v{v:03d}\n")


def generate_version(client, cfg, name, v):
    """Create a new persistent character and save it as version v of `name`."""
    p = cfg["params"]
    seed = _seed(name, v)
    style = (cfg.get("style_base") or "").strip()
    desc = cfg["characters"][name] + (f", {style}" if style else "")
    cid = client.create_character(
        description=desc, width=p["width"], height=p["height"], view=p["view"],
        outline=p.get("outline"), shading=p.get("shading"), detail=p.get("detail"),
        text_guidance_scale=p.get("text_guidance_scale", 8.0), seed=seed)
    raw = client.character_rotations(cid)
    if not raw:
        raise RuntimeError(f"{name}: no rotations returned")
    rotations, size = _uniform_native(raw)
    save_version(name, v, cid, rotations, size, seed, cfg["characters"][name], p)
    return cid, size, sorted(rotations.keys())


# --- git --------------------------------------------------------------------

def _git(*args, check=True):
    return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=check)


def commit_push(message, push=True):
    _git("add", "-A", "characters2")
    if not _git("status", "--porcelain", "--", "characters2").stdout.strip():
        return False
    _git("commit", "-m", message)
    if push:
        branch = _git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or "main"
        import time
        for attempt in range(4):
            if _git("push", "origin", branch, check=False).returncode == 0:
                break
            _git("fetch", "origin", branch, check=False)
            _git("rebase", f"origin/{branch}", check=False)
            time.sleep(2 ** (attempt + 1))
    return True


# --- main -------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Generate/ version the two game heroes.")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--new", nargs="*", default=None,
                    help="Add a NEW version to these character(s) (default: both).")
    ap.add_argument("--version", type=int, default=None,
                    help="Pin the new version number (for one target only). Lets several "
                         "processes generate distinct versions in parallel without racing on "
                         "next_version(). Use with --no-push and commit once afterwards.")
    args = ap.parse_args()

    if args.version is not None and (not args.new or len(args.new) != 1):
        ap.error("--version requires exactly one character named via --new")

    cfg = load_config()
    client = PixelLabClient()
    floor = cfg["budget"]["min_generations_remaining"]
    all_names = list(cfg["characters"].keys())

    if args.new is not None:
        targets = args.new or all_names          # --new [names]: add a version
    else:
        targets = [n for n in all_names if not existing_versions(n)]  # ensure a v001 exists
        if not targets:
            print("both heroes already have at least one version; use --new to add another.")
            return

    for name in targets:
        try:
            client.ensure_budget(floor)
        except BudgetExhausted as e:
            print(f"stopping: {e}")
            break
        v = args.version if args.version is not None else next_version(name)
        print(f"+ {name}: generating v{v:03d} …")
        cid, size, dirs = generate_version(client, cfg, name, v)
        print(f"  {name} v{v:03d}: {len(dirs)} directions, {size}x{size} ({cid})")
        commit_push(f"characters2: {name} v{v:03d} — 8-direction hero ({size}x{size}, low top-down)",
                    push=not args.no_push)

    for n in all_names:
        print(f"= {n}: versions {['v%03d' % v for v in existing_versions(n)] or 'none'}")


if __name__ == "__main__":
    main()
