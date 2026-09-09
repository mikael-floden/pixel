"""Run the per-group motion briefs the maintainer approved by ID.

Fire and tree-wind were the two motions common to many pieces. Everything left
needs its own brief — a waterwheel turns, a bell rocks, a soulstone vein
brightens — so `config/motion_prompts.json` holds one prompt per approved ID and
this runs them.

TWO MODES, AND THE PILOT IS NOT OPTIONAL. 42 prompts were approved from a table
and none had been tested; the glow briefs (L*) ask for something no animation in
this domain has done before — brightness changing with no geometry moving at
all. `--pilot` animates only the one state shown in the artifact for each id,
which is 42 states and about $1.51 against $22.79 for every state of every
approved group. Look at the pilot, then roll out the ids that worked.

    python3 pipeline/animate_motion.py --pilot --dry-run
    python3 pipeline/animate_motion.py --pilot
    python3 pipeline/animate_motion.py --ids W1,C7,M1     # roll those out fully

DIRECTIONS follow the same rule as everywhere else: 168px and under is an
8-direction object and takes directions=['south']; over 168px is 1-direction and
the API returns 400 if directions is passed at all.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import factory
import viewer_build
from pixellab_client import PixelLabClient
import animate_trees as A

CONFIG = os.path.join(factory.ROOT, "config", "motion_prompts.json")
NAME = "motion"
FRAME_COUNT = 4
EIGHT_DIR_MAX = 168
PARALLEL = 12

_LOCKS = defaultdict(threading.Lock)      # per piece; see add_facings.py


def briefs():
    with open(CONFIG, encoding="utf-8") as f:
        return json.load(f)["animations"]


def targets(pilot, only_ids=None):
    """[(rel, state, oid, size, prompt, brief_id)]."""
    out = []
    for bid, b in briefs().items():
        if only_ids and bid not in only_ids:
            continue
        if pilot:
            rel, state = b["example"]["piece"], b["example"]["state"]
            man = factory.read_manifest(rel)
            if not man:
                continue
            pairs = [(rel, state, man)]
        else:
            pairs = []
            for p in sorted(glob.glob(os.path.join(factory.ROOT, b["group"],
                                                   "*", "scenery.json"))):
                r = os.path.relpath(os.path.dirname(p), factory.ROOT)
                man = factory.read_manifest(r)
                for s in sorted((man.get("states") or {})):
                    pairs.append((r, s, man))
        for rel, state, man in pairs:
            e = (man.get("states") or {}).get(state) or {}
            oid = e.get("pixellab_object_id")
            if not oid:
                continue
            if NAME in (e.get("animations") or {}):
                continue                   # already done — resumable
            out.append((rel, state, oid, int(man.get("size") or 64),
                        b["prompt"], bid, int(b.get("frame_count") or FRAME_COUNT)))
    return out


def one(client, rel, state, oid, size, prompt, bid, frames=None):
    dirs = ["south"] if size <= EIGHT_DIR_MAX else None
    man = factory.read_manifest(rel) or {}
    with _LOCKS[rel]:
        pass                               # cheap ordering barrier, not the write
    prev = A.FRAME_COUNT
    if frames:
        A.FRAME_COUNT = frames        # a brief may ask for a longer loop
    try:
        st, n, how = A.one(client, rel, man, state, oid, False, NAME, prompt,
                           dirs, False)
    finally:
        A.FRAME_COUNT = prev
    if n:
        with _LOCKS[rel]:
            m = factory.read_manifest(rel) or {}
            s = dict(m.get("states") or {})
            ent = dict(s.get(state) or {})
            an = dict(ent.get("animations") or {})
            if NAME in an:
                an[NAME] = dict(an[NAME], brief=bid)
                ent["animations"] = an
                s[state] = ent
                m["states"] = s
                factory.write_manifest(rel, m)
    return (rel, state, n, how, bid)


def main():
    ap = argparse.ArgumentParser(description="Run approved motion briefs.")
    ap.add_argument("--pilot", action="store_true",
                    help="one state per brief (the artifact's example)")
    ap.add_argument("--ids", default="", help="comma-separated brief ids")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--min-usd", type=float, default=2.0)
    args = ap.parse_args()

    only = {i.strip() for i in args.ids.split(",") if i.strip()} or None
    todo = targets(args.pilot, only)
    gens = len(todo) * 3
    print(f"{len(todo)} state(s) across {len({t[5] for t in todo})} brief(s)")
    print(f"  ~{gens} generations x $0.012 = about ${gens * 0.012:.2f}")
    if args.dry_run or not todo:
        from collections import Counter
        for b, n in Counter(t[5] for t in todo).most_common():
            print(f"    {b:<5} {n}")
        return 0

    client = PixelLabClient()
    usd = (client.balance().get("credits") or {}).get("usd", 0)
    if usd is not None and usd < args.min_usd:
        print(f"stopping: credits ${usd:.2f} below the ${args.min_usd:.2f} floor")
        return 0

    ok = done = 0
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        futs = [pool.submit(one, client, *t) for t in todo]
        for f in as_completed(futs):
            rel, state, n, how, bid = f.result()
            done += 1
            if n:
                ok += 1
                print(f"  = {bid} {rel}#{state}: {n} frames")
            else:
                print(f"  x {bid} {rel}#{state}: {how}")
            if done % 20 == 0:
                A.commit_push(f"scenery: motion animations ({done}/{len(todo)})")
    viewer_build.build()
    A.commit_push(f"scenery: motion animations — {ok} state(s)")
    print(f"\n{ok}/{len(todo)} state(s) animated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
