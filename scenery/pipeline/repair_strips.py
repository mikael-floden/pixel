"""Publish the per-direction strips the wiki reads, for every animation.

THE WIKI DRAWS FROM A STRIP, NOT FROM THE NUMBERED FRAMES. Its resolver
(wiki/build.mjs, dirClip) looks for, in order: the `strip` named in that
direction's metadata, then the animation's top-level `strip` for south, then
the domain's own naming on disk -- `<name>__<dir>.webp`.

The flame pass wrote ONE file per state, `flame__strip.webp`, and published no
`strip` key at all. So the wiki fell through to `flame__south.webp`, found
nothing, and showed a still image: 166 of 212 flame animations were invisible
(maintainer 2026-08-30: "Take this fire for example. You would think a fire like
this would have an animation by now").

This writes `<name>__<dir>.webp` for every direction that has frames on disk and
records the path in the manifest, so both lookups succeed. No API calls -- the
frames already exist; a strip is just one row of them.

    python3 pipeline/repair_strips.py --dry-run
    python3 pipeline/repair_strips.py
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import sys

from PIL import Image

import factory
import viewer_build

FRAME_RE = re.compile(r"^\d+\.webp$", re.I)


def frames_in(d):
    return sorted(f for f in os.listdir(d) if FRAME_RE.match(f))


def write_strip(frame_dir, out_path):
    names = frames_in(frame_dir)
    if not names:
        return 0
    ims = [Image.open(os.path.join(frame_dir, n)).convert("RGBA") for n in names]
    w = max(i.width for i in ims)
    h = max(i.height for i in ims)
    strip = Image.new("RGBA", (w * len(ims), h), (0, 0, 0, 0))
    for i, im in enumerate(ims):
        strip.paste(im, (i * w + (w - im.width) // 2, (h - im.height) // 2), im)
    # Repo law: lossless AND exact, both non-default in Pillow.
    strip.save(out_path, format="WEBP", lossless=True, exact=True, method=6)
    return len(ims)


def _resolves(rel, state, name, direction):
    """Reproduce wiki/build.mjs dirClip: does it already find a strip?"""
    man = factory.read_manifest(rel) or {}
    a = (((man.get("states") or {}).get(state) or {}).get("animations") or {}).get(name)
    if not isinstance(a, dict):
        return False
    d = a.get("directions")
    dsec = d.get(direction) if isinstance(d, dict) else None
    declared = None
    if isinstance(dsec, dict) and dsec.get("strip"):
        declared = dsec["strip"]
    elif direction == "south" and a.get("strip"):
        declared = a["strip"]
    if not declared:
        return False
    stem = re.sub(r"\.(png|webp)$", "", str(declared), flags=re.I)
    return any(os.path.exists(os.path.join(factory.ROOT, stem + "." + e))
               for e in ("webp", "png"))


def run(dry=False):
    made = 0
    touched = {}
    # BOTH LAYOUTS. State-level animations live at <grp>/<piece>/<state>/animations/<name>;
    # the ANCHOR state's animation lives at the piece root, <grp>/<piece>/animations/<name>.
    # The first pass of this repair only walked the state-level glob and left 37 anchor
    # animations still invisible.
    anim_dirs = (sorted(glob.glob(os.path.join(factory.ROOT, "*", "*", "*", "animations", "*")))
                 + sorted(glob.glob(os.path.join(factory.ROOT, "*", "*", "animations", "*"))))
    for anim_dir in anim_dirs:
        if not os.path.isdir(anim_dir):
            continue
        name = os.path.basename(anim_dir)
        parent = os.path.dirname(os.path.dirname(anim_dir))   # state dir, or the piece dir
        if os.path.exists(os.path.join(parent, "scenery.json")):
            rel, state = os.path.relpath(parent, factory.ROOT), None   # anchor
        else:
            rel = os.path.relpath(os.path.dirname(parent), factory.ROOT)
            state = os.path.basename(parent).upper()
        subdirs = [d for d in sorted(os.listdir(anim_dir))
                   if os.path.isdir(os.path.join(anim_dir, d))]
        # per-direction layout (flame): one strip per direction
        # flat layout (motion, wind): the frames are the south direction
        pairs = ([(d, os.path.join(anim_dir, d)) for d in subdirs] if subdirs
                 else [("south", anim_dir)])
        for direction, fdir in pairs:
            out = os.path.join(os.path.dirname(anim_dir), f"{name}__{direction}.webp")
            if os.path.exists(out):
                continue
            # ONLY WRITE WHAT THE WIKI CANNOT ALREADY FIND. wind and motion
            # publish a top-level `strip` and the wiki resolves south from it,
            # so writing <name>__south.webp for those would duplicate ~1,000
            # files for nothing. Skip any direction that already resolves.
            if state and _resolves(rel, state, name, direction):
                continue
            if dry:
                print(f"  would write {os.path.relpath(out, factory.ROOT)}")
                made += 1
                continue
            n = write_strip(fdir, out)
            if not n:
                continue
            made += 1
            if state:
                touched.setdefault((rel, state, name), {})[direction] = (
                    os.path.relpath(out, factory.ROOT), n)
    if not dry:
        # Record the path in the manifest too, so the wiki's FIRST lookup hits
        # rather than relying on its on-disk fallback.
        for (rel, state, name), dirs in touched.items():
            man = factory.read_manifest(rel)
            ent = ((man or {}).get("states") or {}).get(state)
            if not ent:
                continue
            a = (ent.get("animations") or {}).get(name)
            if not isinstance(a, dict):
                continue
            d = a.get("directions")
            if isinstance(d, dict):
                for direction, (path, n) in dirs.items():
                    d.setdefault(direction, {})["strip"] = path
                    d[direction].setdefault("frames", n)
            elif "south" in dirs:
                a["strip"] = dirs["south"][0]
            factory.write_manifest(rel, man)
        viewer_build.build()
    return made


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    n = run(dry=a.dry_run)
    print(f"\n{n} strip(s) {'would be ' if a.dry_run else ''}written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
