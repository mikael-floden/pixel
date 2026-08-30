"""Clear a motion animation so animate_motion.py regenerates it.

animate_motion is resumable: it skips any state that already carries a `motion`
animation. That is what makes a batch re-runnable, and it is also what makes a
REDO a no-op -- the maintainer rejects an animation, the prompt is rewritten,
and the runner then skips the very state that needed the new prompt.

So a redo is two steps, and this is the first:

    python3 pipeline/redo_motion.py X39,X46,X34      # clear
    python3 pipeline/animate_motion.py --pilot --ids X39,X46,X34

Clearing is local only. `animate_object(replace_existing=True)` (the default)
replaces the animation on the PixelLab object, so the store never accumulates a
second group for the same piece.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

import factory
import viewer_build

NAME = "motion"
CONFIG = os.path.join(factory.ROOT, "config", "motion_prompts.json")


def clear(ids, dry=False):
    with open(CONFIG, encoding="utf-8") as f:
        briefs = json.load(f)["animations"]
    done = []
    for bid in ids:
        b = briefs.get(bid)
        if not b:
            print(f"  ! {bid} is not a known brief")
            continue
        rel, state = b["example"]["piece"], b["example"]["state"]
        man = factory.read_manifest(rel)
        ent = ((man or {}).get("states") or {}).get(state) or {}
        if NAME not in (ent.get("animations") or {}):
            print(f"  - {bid} {rel}#{state}: no {NAME} animation to clear")
            continue
        if dry:
            print(f"  would clear {bid} {rel}#{state}")
            continue
        d = os.path.join(factory.ROOT, rel, state.lower(), "animations", NAME)
        shutil.rmtree(d, ignore_errors=True)
        for ext in ("webp", "png"):
            strip = f"{d}__strip.{ext}"
            if os.path.exists(strip):
                os.remove(strip)
        anims = dict(ent.get("animations") or {})
        anims.pop(NAME, None)
        ent["animations"] = anims
        man["states"][state] = ent
        factory.write_manifest(rel, man)
        done.append(bid)
        print(f"  = cleared {bid} {rel}#{state}")
    if done and not dry:
        # Same reason as remove_motion: the wiki reads viewer_data.json, so a
        # cleared animation must leave the feed too or the wiki advertises frames
        # that are no longer there. animate_motion rebuilds it again afterwards.
        viewer_build.build()
    return done


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("ids", help="comma-separated brief ids, e.g. X39,X46")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    ids = [x.strip() for x in a.ids.split(",") if x.strip()]
    n = clear(ids, dry=a.dry_run)
    print(f"\n{len(n)} cleared — now run: "
          f"python3 pipeline/animate_motion.py --pilot --ids {','.join(n) or ','.join(ids)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
