"""Remove a motion animation the maintainer rejected.

Deletes the frames and the manifest entry, then records the id under `declined`
in config/motion_prompts.json with the reason, so the piece is never
re-proposed. This is the counterpart to redo_motion.py: redo clears an
animation to regenerate it, remove takes it out for good.

    python3 pipeline/remove_motion.py D47,D24 --reason "ugly animation (maintainer)"

The animation also exists on the PixelLab object. The v2 API exposes no
delete-animation endpoint (only DELETE /objects/{id}, which would destroy the
art), so the store keeps an orphan animation group. It is invisible to the game
-- the game reads frames from this repo, and nothing here references it -- and
regenerating the piece replaces it via replace_existing. Left deliberately.
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


def remove(ids, reason, dry=False):
    with open(CONFIG, encoding="utf-8") as f:
        cfg = json.load(f)
    gone = []
    for bid in ids:
        b = cfg["animations"].get(bid)
        if not b:
            print(f"  ! {bid} is not a known brief")
            continue
        rel, state = b["example"]["piece"], b["example"]["state"]
        if dry:
            print(f"  would remove {bid} {rel}#{state}")
            continue
        d = os.path.join(factory.ROOT, rel, state.lower(), "animations", NAME)
        shutil.rmtree(d, ignore_errors=True)
        for ext in ("webp", "png"):
            strip = f"{d}__strip.{ext}"
            if os.path.exists(strip):
                os.remove(strip)
        man = factory.read_manifest(rel)
        ent = ((man or {}).get("states") or {}).get(state) or {}
        anims = dict(ent.get("animations") or {})
        anims.pop(NAME, None)
        ent["animations"] = anims
        man["states"][state] = ent
        factory.write_manifest(rel, man)
        cfg["declined"][bid] = {
            "group": b.get("group"), "moves": b.get("moves"),
            "reason": reason, "example": b["example"],
        }
        cfg["animations"].pop(bid, None)
        gone.append(bid)
        print(f"  = removed {bid} {rel}#{state}")
    if not dry:
        with open(CONFIG, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=1, ensure_ascii=False)
        # REBUILD THE WIKI FEED. viewer_data.json is what the wiki reads; removing
        # frames and manifest entries without rebuilding it leaves the wiki
        # advertising animations whose files are gone, and he sees nothing where
        # an animation used to be. Found 2026-08-29 with 46 such dangling entries.
        viewer_build.build()
    return gone


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("ids", help="comma-separated brief ids, e.g. D47,D24")
    ap.add_argument("--reason", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    ids = [x.strip() for x in a.ids.split(",") if x.strip()]
    n = remove(ids, a.reason, dry=a.dry_run)
    print(f"\n{len(n)} removed and recorded as declined")
    return 0


if __name__ == "__main__":
    sys.exit(main())
