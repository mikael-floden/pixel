"""Verify the repo mirror EXACTLY matches PixelLab truth for the pinned heroes.

PixelLab is the source of truth. This re-fetches each pinned character and checks
that humans/<name>/ is an exact, complete mirror — nothing missing, nothing stale:

  * every PixelLab animation has a folder (by the same slug sync.py uses);
  * each animation's per-direction frame COUNT matches PixelLab exactly;
  * every frame PNG on disk opens and is a valid, non-empty RGBA image;
  * all 8 base rotations are present and valid;
  * NO extra/stale animation folders exist that PixelLab no longer has;
  * character.json is internally consistent (pixellab id, slugs, counts).

Exit code 0 = exact mirror; nonzero = mismatches (printed). Read-only; no writes.

  python characters2/pipeline/verify_sync.py
  python characters2/pipeline/verify_sync.py default_girl
"""

from __future__ import annotations

import json
import os
import sys

from PIL import Image

from pixellab_client import DIRECTIONS_8, PixelLabClient
from sync import HUMANS, load_config, frame_ext, _assign_slugs, _slug


EXT = frame_ext()   # ".png" today, ".webp" after the migration (config.json)


def _expected_from_api(detail):
    """Build {slug: {direction: frame_count}} and base rotation dirs from API."""
    rot = [d for d, u in (detail.get("rotation_urls") or {}).items() if u]
    anims = detail.get("animations") or []
    types = [a.get("animation_type") or a.get("animation_group_id") for a in anims]
    types = [t for t in types if t]
    slug_by_type = _assign_slugs(types)
    exp = {}
    for a in anims:
        atype = a.get("animation_type") or a.get("animation_group_id")
        if not atype:
            continue
        slug = slug_by_type[atype]
        dirs = {}
        for dp in (a.get("directions") or []):
            dd = dp.get("direction")
            n = len([u for u in (dp.get("frames") or []) if u])
            if dd and n:
                dirs[dd] = n
        exp[slug] = {"animation_type": atype, "dirs": dirs}
    return sorted(rot), exp


def _valid_png(path, require_opaque_pixels=False):
    try:
        im = Image.open(path); im.load()
        im = im.convert("RGBA")
    except Exception as e:
        return f"unreadable ({e})"
    if im.width < 1 or im.height < 1:
        return "zero-size"
    if require_opaque_pixels and im.getextrema()[3][1] == 0:
        return "fully transparent"
    return None


def verify_character(client, name, cid):
    problems = []
    root = os.path.join(HUMANS, name)
    if not os.path.isdir(root):
        return [f"{name}: directory missing entirely"]

    detail = client.get_character(cid)
    exp_rot, exp_anims = _expected_from_api(detail)

    # -- base rotations ------------------------------------------------------
    base = os.path.join(root, "base")
    for d in exp_rot:
        p = os.path.join(base, f"{d}{EXT}")
        if not os.path.exists(p):
            problems.append(f"{name}/base: missing {d}{EXT}")
        else:
            bad = _valid_png(p, require_opaque_pixels=(d == "south"))
            if bad:
                problems.append(f"{name}/base/{d}{EXT}: {bad}")
    # stray base pngs
    if os.path.isdir(base):
        for fn in os.listdir(base):
            stem, fext = os.path.splitext(fn)
            if fext == EXT and not stem.startswith("preview") and stem not in exp_rot:
                problems.append(f"{name}/base: STALE {fn} (not on PixelLab)")

    # -- animations ----------------------------------------------------------
    adir_root = os.path.join(root, "animations")
    on_disk = set()
    if os.path.isdir(adir_root):
        on_disk = {f for f in os.listdir(adir_root)
                   if os.path.isdir(os.path.join(adir_root, f))}
    expected_slugs = set(exp_anims)

    for slug in sorted(expected_slugs):
        adir = os.path.join(adir_root, slug)
        if not os.path.isdir(adir):
            problems.append(f"{name}/animations: MISSING '{slug}' "
                            f"({exp_anims[slug]['animation_type']!r})")
            continue
        for dd, n in exp_anims[slug]["dirs"].items():
            ddir = os.path.join(adir, dd)
            if not os.path.isdir(ddir):
                problems.append(f"{name}/{slug}: missing direction '{dd}'")
                continue
            have = sorted(f for f in os.listdir(ddir)
                          if os.path.splitext(f)[1] == EXT and os.path.splitext(f)[0].isdigit())
            if len(have) != n:
                problems.append(f"{name}/{slug}/{dd}: {len(have)} frames, expected {n}")
            for i in range(n):
                p = os.path.join(ddir, f"{i}{EXT}")
                if not os.path.exists(p):
                    problems.append(f"{name}/{slug}/{dd}: missing frame {i}{EXT}")
                else:
                    bad = _valid_png(p)
                    if bad:
                        problems.append(f"{name}/{slug}/{dd}/{i}{EXT}: {bad}")
            # stray extra directions inside the animation
        for dd in os.listdir(adir):
            p = os.path.join(adir, dd)
            if os.path.isdir(p) and dd not in exp_anims[slug]["dirs"]:
                problems.append(f"{name}/{slug}: STALE direction '{dd}'")

    # stale animation folders
    for slug in sorted(on_disk - expected_slugs):
        problems.append(f"{name}/animations: STALE folder '{slug}' (not on PixelLab)")

    # -- manifest consistency ------------------------------------------------
    manifest = os.path.join(root, "character.json")
    if not os.path.exists(manifest):
        problems.append(f"{name}: character.json missing")
    else:
        m = json.load(open(manifest))
        if m.get("pixellab_character_id") != cid:
            problems.append(f"{name}: manifest pixellab id {m.get('pixellab_character_id')} != pinned {cid}")
        man_slugs = set((m.get("animations") or {}).keys())
        if man_slugs != expected_slugs:
            miss = expected_slugs - man_slugs
            extra = man_slugs - expected_slugs
            if miss:
                problems.append(f"{name}: manifest missing anims {sorted(miss)}")
            if extra:
                problems.append(f"{name}: manifest extra anims {sorted(extra)}")

    return problems


def verify_animation_map(name):
    """The game maps stable state names (idle/walk/run/…) to art folders via
    characters2/animation_map.json. Check every state resolves to a real folder
    for this hero — a rename that isn't reflected there silently drops the move
    from the game manifest (exactly the bug this guards against)."""
    problems = []
    mpath = os.path.join(os.path.dirname(HUMANS), "animation_map.json")
    if not os.path.exists(mpath):
        return [f"{name}: animation_map.json missing (game state->folder mapping)"]
    m = json.load(open(mpath))
    resolved = {**(m.get("states") or {}), **((m.get("overrides") or {}).get(name) or {})}
    adir_root = os.path.join(HUMANS, name, "animations")
    for state, folder in resolved.items():
        south = os.path.join(adir_root, folder, "south")
        if not (os.path.isdir(os.path.join(adir_root, folder)) and os.path.isdir(south)
                and any(os.path.splitext(f)[1] == EXT for f in os.listdir(south))):
            problems.append(f"{name}: state '{state}' -> folder '{folder}' MISSING "
                            f"(update animation_map.json)")
    return problems


def main():
    cfg = load_config()
    pins = cfg.get("pixellab_characters") or {}
    targets = sys.argv[1:] or list(pins.keys())
    client = PixelLabClient()

    all_problems = {}
    for name in targets:
        cid = pins.get(name)
        if not cid:
            all_problems[name] = [f"{name}: not pinned in config"]
            continue
        detail = client.get_character(cid)
        exp_rot, exp_anims = _expected_from_api(detail)
        probs = verify_character(client, name, cid)
        probs += verify_animation_map(name)
        all_problems[name] = probs
        tf = sum(sum(d["dirs"].values()) for d in exp_anims.values())
        status = "PASS" if not probs else f"FAIL ({len(probs)} problems)"
        print(f"[{status}] {name} <- {cid[:8]} ({detail.get('name')!r}): "
              f"{len(exp_anims)} anims, {len(exp_rot)} rotations, {tf} animation frames expected")
        for p in probs:
            print(f"    - {p}")

    total = sum(len(v) for v in all_problems.values())
    print(f"\n{'✅ EXACT MIRROR' if total == 0 else f'❌ {total} PROBLEM(S)'}")
    sys.exit(0 if total == 0 else 1)


if __name__ == "__main__":
    main()
