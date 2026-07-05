"""characters2 generator — the game's two main heroes.

Ensures exactly two characters exist: humans/default_boy and humans/default_girl,
each a persistent 8-direction static PixelLab character (create-character-with-8-
directions) at the fixed human skeleton (low top-down, 80x80, low detail, default
outline). No animations, no outfits — just the awesome 8-direction base model.

Resumable + reroll-friendly: it (re)generates any character whose folder is
missing. Each regeneration uses a fresh seed (tracked in humans/.state.json), so a
deleted character comes back as a new, slightly different variation — delete until
you're happy with the boy and the girl.

  python characters2/pipeline/generate.py            # ensure both exist, push
  python characters2/pipeline/generate.py --no-push
  python characters2/pipeline/generate.py --force default_boy   # reroll one now
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
STATE = os.path.join(HUMANS, ".state.json")


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


def char_dir(name):
    return os.path.join(HUMANS, name)


def has_character(name):
    return os.path.exists(os.path.join(char_dir(name), "south.png"))


def _fit_to_square(rotations, size):
    """Fit every rotation into an exact `size`×`size` sprite. PixelLab content-fits
    the character onto a padded canvas (e.g. 112px for an 80px request), so we trim
    each frame's transparent margin, apply ONE shared scale (from the largest frame,
    downscale-only) so the character stays a consistent size across all 8
    directions, and center it on the size×size canvas. Result: true 80×80 sprites."""
    boxes = {d: im.convert("RGBA").getbbox() for d, im in rotations.items()}
    valid = [b for b in boxes.values() if b]
    if not valid:
        return {d: im.convert("RGBA").resize((size, size)) for d, im in rotations.items()}
    max_w = max(b[2] - b[0] for b in valid)
    max_h = max(b[3] - b[1] for b in valid)
    scale = min(size / max_w, size / max_h, 1.0)      # only shrink, never upscale
    out = {}
    for d, im in rotations.items():
        im = im.convert("RGBA")
        b = boxes[d]
        crop = im.crop(b) if b else im
        if scale < 1.0:
            crop = crop.resize((max(1, round(crop.width * scale)),
                                max(1, round(crop.height * scale))), Image.NEAREST)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.alpha_composite(crop, ((size - crop.width) // 2, (size - crop.height) // 2))
        out[d] = canvas
    return out


def _save_preview(rotations, path):
    """A single row of the 8 directions for a quick look."""
    order = [d for d in DIRECTIONS_8 if d in rotations]
    if not order:
        return
    w = max(rotations[d].width for d in order)
    h = max(rotations[d].height for d in order)
    strip = Image.new("RGBA", (w * len(order), h), (0, 0, 0, 0))
    for i, d in enumerate(order):
        f = rotations[d]
        strip.alpha_composite(f, (i * w + (w - f.width) // 2, (h - f.height) // 2))
    strip.save(path)


def generate_character(client, cfg, name):
    """(Re)generate one hero as a fresh, slightly different variation."""
    p = cfg["params"]
    state = _read_json(STATE, {}) or {}
    regen = int(state.get(name, 0))
    seed = _seed(name, regen)
    style = (cfg.get("style_base") or "").strip()
    desc = cfg["characters"][name] + (f", {style}" if style else "")

    cid = client.create_character(
        description=desc, width=p["width"], height=p["height"], view=p["view"],
        outline=p.get("outline"), shading=p.get("shading"), detail=p.get("detail"),
        text_guidance_scale=p.get("text_guidance_scale", 8.0), seed=seed)
    raw = client.character_rotations(cid)
    if not raw:
        raise RuntimeError(f"{name}: no rotations returned")
    rotations = _fit_to_square(raw, int(p["width"]))     # true 80×80 sprites

    cdir = char_dir(name)
    os.makedirs(cdir, exist_ok=True)
    for d, im in rotations.items():
        im.save(os.path.join(cdir, f"{d}.png"))
    if "south" in rotations:
        rotations["south"].save(os.path.join(cdir, "portrait.png"))
    _save_preview(rotations, os.path.join(cdir, "preview.png"))

    _write_json(os.path.join(cdir, "character.json"), {
        "id": name, "skeleton": cfg["skeleton"], "pixellab_character_id": cid,
        "description": cfg["characters"][name], "params": p,
        "directions": sorted(rotations.keys()), "seed": seed, "variation": regen,
        "source": "pixellab.ai create-character-with-8-directions (8-dir static)",
    })
    state[name] = regen + 1          # next reroll gets a new seed -> new look
    _write_json(STATE, state)
    return cid, sorted(rotations.keys())


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
        for attempt in range(4):
            if _git("push", "origin", branch, check=False).returncode == 0:
                break
            _git("fetch", "origin", branch, check=False)
            _git("rebase", f"origin/{branch}", check=False)
            import time; time.sleep(2 ** (attempt + 1))
    return True


# --- main -------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Generate the two game heroes.")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--force", nargs="*", default=[],
                    help="Reroll these character(s) now even if present.")
    args = ap.parse_args()

    cfg = load_config()
    client = PixelLabClient()
    floor = cfg["budget"]["min_generations_remaining"]
    names = list(cfg["characters"].keys())

    for name in names:
        if name not in cfg["characters"]:
            continue
        if has_character(name) and name not in args.force:
            print(f"= {name}: present, skipping")
            continue
        try:
            client.ensure_budget(floor)
        except BudgetExhausted as e:
            print(f"stopping: {e}")
            break
        if name in args.force:
            import shutil
            old = (_read_json(os.path.join(char_dir(name), "character.json"), {}) or {})
            if old.get("pixellab_character_id"):
                try:
                    client.delete_character(old["pixellab_character_id"])  # no orphan on PixelLab
                except Exception:
                    pass
            shutil.rmtree(char_dir(name), ignore_errors=True)
        print(f"+ generating {name} …")
        cid, dirs = generate_character(client, cfg, name)
        print(f"  {name}: {len(dirs)} directions ({cid})")
        commit_push(f"characters2: {name} — 8-direction hero (low top-down 80x80, low detail)",
                    push=not args.no_push)

    print("done —", ", ".join(f"{n}:{'ok' if has_character(n) else 'missing'}" for n in names))


if __name__ == "__main__":
    main()
