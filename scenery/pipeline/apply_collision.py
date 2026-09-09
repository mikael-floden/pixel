"""Set each piece's `collision` flag, and take the maintainer's overrides.

DOES THE PLAYER WALK INTO IT, OR OVER IT? Almost all scenery collides -- a
player should not walk through a well -- but a flat floor covering should not
block anything. The game reads `collision` per piece from viewer_data.json
(maintainer 2026-08-30: "add that as a field to the object so the game knows
about it").

TWO SOURCES, AND HIS ALWAYS WINS:

  1. This domain's default, from FLOOR_COVERING below: rugs, hides, mats and
     doormats are collision-less, everything else collides. Pre-marking these
     is the point -- "mark all carpets you can find as having no collision so I
     only have to use the wiki when I find something that is wrong."
  2. live/tuning/scenery_collision.json, which the wiki writes when he marks a
     piece by hand. Keyed `scenery/<group>/<piece>` like the hitbox and wall
     docs beside it. An override is applied last and is never overwritten by a
     later run of this script.

    python3 pipeline/apply_collision.py --dry-run
    python3 pipeline/apply_collision.py
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

import factory
import viewer_build

# live/ is the LIVE-UPDATE channel: the running game server reads it straight
# from GitHub main, no redeploy. One writer per file -- the wiki owns this one,
# so this script only ever READS it.
OVERRIDES = os.path.join(os.path.dirname(factory.ROOT), "live", "tuning",
                         "scenery_collision.json")

# Groups whose every piece lies flat on the floor.
FLOOR_GROUPS = {"rugs_and_hides"}
# ...and individual pieces elsewhere that are also floor coverings. Matched on
# the piece's own name so a new doormat in a mixed group is caught too.
FLOOR_NAME_RE = re.compile(r"\b(rug|carpet|doormat|floor mat|hide)\b", re.I)


def default_collision(rel, meta):
    group = rel.split("/", 1)[0]
    if group in FLOOR_GROUPS:
        return False
    if FLOOR_NAME_RE.search(str(meta.get("name") or "")):
        return False
    return True


def load_overrides():
    if not os.path.exists(OVERRIDES):
        return {}
    with open(OVERRIDES, encoding="utf-8") as f:
        doc = json.load(f)
    out = {}
    for key, v in (doc.get("overrides") or {}).items():
        rel = key[len("scenery/"):] if key.startswith("scenery/") else key
        if isinstance(v, dict) and "collision" in v:
            out[rel] = bool(v["collision"])
        elif isinstance(v, bool):
            out[rel] = v
    return out


def run(dry=False):
    ov = load_overrides()
    changed, off, from_wiki = 0, [], 0
    for rel, meta in factory.discover():
        want = ov[rel] if rel in ov else default_collision(rel, meta)
        if rel in ov:
            from_wiki += 1
        if meta.get("collision") == want:
            if not want:
                off.append(rel)
            continue
        changed += 1
        if not want:
            off.append(rel)
        if dry:
            print(f"  {rel}: collision -> {want}")
            continue
        man = factory.read_manifest(rel)
        man["collision"] = want
        factory.write_manifest(rel, man)
    if not dry and changed:
        viewer_build.build()
    print(f"\n{changed} piece(s) {'would change' if dry else 'updated'}; "
          f"{len(off)} collision-less; {from_wiki} set by his wiki overrides")
    for r in sorted(off):
        print(f"   no collision: {r}")
    return changed


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    run(dry=a.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
