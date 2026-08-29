"""Animate the flame on every piece of scenery that actually has one.

Maintainer, 2026-08-28, with a screenshot of a torch post: "I now want you to
find every fire in the Scenery and create an animation on that object. The
animation should have a prompt with the text 'Animate the flame only' in S
direction, 4 frames and Keep first frame checked."

WHAT COUNTS AS A FIRE, and it is not the group name. A brazier is a fire
fixture, but half its lit states glow with "molten soulstone shards among
coals"; a torch post's most common lit state is "ember-crusted head glowing
WITHOUT OPEN FLAME". Meanwhile a candle stub on a table IS a flame. So the test
is per-STATE and reads that state's own `glow_concept`, never its group.

Two substrings make a keyword search wrong here, and both were caught only by
reading the matches:

    foxfire     bioluminescent fungus behind lantern panes — contains "fire"
    fireflies   a swarm in a tree crown — contains "fire"

Neither has a flame to animate, and "Animate the flame only" pointed at one
would be an instruction to invent fire that is not in the art. 48 states were
dropped on that pair alone.

UNLIT STATES ARE NEVER CANDIDATES. A dark brazier has no flame; there is
nothing to animate and the prompt would have to hallucinate one.

DIRECTION DEPENDS ON THE CANVAS, and getting it wrong is a hard failure either
way. Pieces of 168px or under went down create-8-direction-object and take
`directions=['south']` — his S selection. Pieces over 168px are 1-direction
objects and the API returns 400 if `directions` is passed at all. This set
spans both (192 small, 55 large), so it is decided per piece from `size`.

    python3 pipeline/animate_flames.py --dry-run
    python3 pipeline/animate_flames.py
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed

import factory
import viewer_build
from pixellab_client import PixelLabClient
import animate_trees as A

# His animation description, verbatim.
FLAME_PROMPT = "Animate the flame only"
NAME = "flame"
# 168px is the create-8-direction-object ceiling (see pixellab_client).
EIGHT_DIR_MAX = 168

FLAME = re.compile(r"\b(flame|fire|firelight|burning|blaz\w*|ember|coals?|candle|"
                   r"tealight|wick|bonfire|pyre|torch)\w*", re.I)
NOT_FLAME = re.compile(r"foxfire|firefl|without open flame|soulstone|wisp|witchlight|"
                       r"will-o|glowworm|fungus|moss|crystal|starlight|moonlight|"
                       r"bioluminescent|lumin", re.I)


def _types():
    with open(os.path.join(factory.ROOT, "config", "factory.json"),
              encoding="utf-8") as f:
        return {g["id"]: g.get("type") for g in json.load(f).get("groups", [])}


def flame_states(include_trees=False):
    """[(rel, state, oid, size, concept)] — every LIT state with a real flame.

    TREE-TYPE PIECES ARE EXCLUDED (maintainer, 2026-08-28). Two reasons, and
    the pilot showed both. They already carry the `wind` animation he approved,
    so a second animation would be two motions competing for the same art. And
    "Animate the flame only" does not hold on a big canvas: ancient_tree_001 at
    256px came back with 32.8% of the canvas changed — the whole canopy, trunk
    and roots redrawn — against 3.9% on a 64px anvil, where only the flame
    moved. Pass include_trees=True to override."""
    types = _types()
    out = []
    for p in sorted(glob.glob(os.path.join(factory.ROOT, "*", "*", "scenery.json"))):
        rel = os.path.relpath(os.path.dirname(p), factory.ROOT)
        with open(p, encoding="utf-8") as f:
            man = json.load(f)
        size = int(man.get("size") or 64)
        group = rel.split("/")[0]
        if not include_trees and (man.get("type") or types.get(group)) == "TREE":
            continue
        for state, e in sorted((man.get("states") or {}).items()):
            if not state.upper().startswith("LIT"):
                continue
            oid = (e or {}).get("pixellab_object_id")
            if not oid:
                continue                       # nothing on the store to animate
            if NAME in ((e or {}).get("animations") or {}):
                continue                       # already done — resumable
            concept = (e or {}).get("glow_concept") or man.get("glow_concept") or ""
            if not concept or NOT_FLAME.search(concept):
                continue
            if FLAME.search(concept):
                out.append((rel, state, oid, size, concept))
    return out


def main():
    ap = argparse.ArgumentParser(description="Animate every real flame in scenery.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--min-usd", type=float, default=2.0)
    ap.add_argument("--include-trees", action="store_true",
                    help="also animate TREE-type pieces (see flame_states)")
    args = ap.parse_args()

    todo = flame_states(args.include_trees)
    if args.limit:
        todo = todo[:args.limit]
    gens = len(todo) * 3
    pieces = sorted({r for r, *_ in todo})
    print(f"{len(todo)} flame state(s) across {len(pieces)} piece(s)")
    print(f"  ~{gens} generations x $0.012 = about ${gens * 0.012:.2f}")
    small = sum(1 for *_r, z, _c in todo if z <= EIGHT_DIR_MAX)
    print(f"  {small} at 8-direction (directions=['south']), "
          f"{len(todo) - small} at 1-direction (no directions param)")
    if args.dry_run:
        for g, n in Counter(r.split("/")[0] for r, *_ in todo).most_common(15):
            print(f"    {g:<22} {n}")
        return 0
    if not todo:
        print("nothing to do — every flame already animated")
        return 0

    client = PixelLabClient()
    # ONE FLAT POOL ACROSS PIECES, not a pool per piece. These pieces average
    # 2.2 flame states and 41 of them have exactly one, so a per-piece pool ran
    # 1-3 jobs against 14 workers and the first 7 pieces took 16 minutes — a
    # ~4x waste of wall time that the trees never exposed, because a tree
    # carries 14 states and filled the pool on its own.
    mans = {}
    for rel, _s, _o, _z, _c in todo:
        if rel not in mans:
            mans[rel] = factory.read_manifest(rel) or {}
    done = 0
    since_commit = 0
    with ThreadPoolExecutor(max_workers=A.PARALLEL) as pool:
        futs = {}
        for rel, state, oid, size, _c in todo:
            dirs = ["south"] if size <= EIGHT_DIR_MAX else None
            # adopt_existing=False: a state may already carry the TREE wind
            # animation, which is not this animation and must not be adopted.
            futs[pool.submit(A.one, client, rel, mans[rel], state, oid, False,
                             NAME, FLAME_PROMPT, dirs, False)] = rel
        for f in as_completed(futs):
            rel = futs[f]
            state, n, how = f.result()
            if n:
                done += 1
                since_commit += 1
            else:
                print(f"    x {rel} {state}: {how}")
            if done % 10 == 0 and since_commit:
                print(f"  = {done}/{len(todo)} states")
            # COMMIT PERIODICALLY. Same reason as the tree run: this is long,
            # the repo is shared, and art only on disk is art a bad rebase eats.
            if since_commit >= 20:
                A.commit_push(f"scenery: flame animations ({done}/{len(todo)} states)")
                since_commit = 0
    viewer_build.build()
    A.commit_push(f"scenery: flame animations — {done} state(s) across "
                  f"{len(set(r for r, *_ in todo))} piece(s)")
    print(f"\nanimated {done}/{len(todo)} flame state(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
