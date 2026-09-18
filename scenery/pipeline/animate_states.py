"""Animate the STATES of an animated piece that were never animated.

Maintainer 2026-09-18: "I still find animations with only 1 frame ... Generate
the missing animations immediately!" — and the things he was looking at were
not clips short of a facing (the sweep had those): they were states with NO
clip at all on a piece whose other states animate. cupboard_010 LIT_2 has a
motion clip; LIT_1 and LIT_3 have none, and he judged all three facings of
each "Not enough frames for an animation". A state with no clip shows the
still on every facing; from his side that is the same fault.

THE CLASS: a state with a PixelLab object and no animation, on a piece with an
animated state of the SAME FAMILY (LIT -> LIT, NOT_LIT -> NOT_LIT). The
family rule is the subject rule: a LIT sibling's brief names the light, a
NOT_LIT sibling's names the thing that sways. An unlit stone beside a glowing
one has nothing to animate and no brief to borrow — and the one time a glow
was asked of an unlit piece he wrote "This flower doesn't glow!".

THE BRIEF: the sibling clip's own "ONLY the ... ." subject in
redo_facing_anim.brief_for's round-0 wording; config/redo_prompts.json wins
where he or I wrote one for the state. Created on SOUTH here (animate_trees.one
is the one creator this domain has), then redo_facing_anim.py --missing
extends the facings the state ships — the proven path — and finish_clips
publishes strips, lifts, reviews, light, packs. A created clip that measures
over the outline line is a PROBABLY_BAD clip like any other: his second-pass
order applies to it (--bad --rounds).

    python3 scenery/pipeline/animate_states.py --dry-run
    python3 scenery/pipeline/animate_states.py --only <group>/<piece>#<STATE>,...
    python3 scenery/pipeline/animate_states.py
"""
from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory                                        # noqa: E402
import animate_trees as A                             # noqa: E402
import finish_clips                                   # noqa: E402
import redo_facing_anim as R                          # noqa: E402
from pixellab_client import PixelLabClient, PixelLabError  # noqa: E402

PARALLEL = 4
USD_PER_GEN = R.USD_PER_GEN


def family(state):
    return "LIT" if state.upper().startswith("LIT") else "NOT_LIT"


def targets():
    """[(rel, state, oid, name, prompt, sibling)]"""
    out = []
    for rel, man in factory.discover():
        if int(man.get("size") or 64) > R.EIGHT_DIR_MAX:
            continue
        states = man.get("states") or {}
        for st, sv in states.items():
            if sv.get("animations") or not sv.get("pixellab_object_id"):
                continue
            sib = [(k, x) for k, x in states.items()
                   if isinstance(x.get("animations"), dict) and x["animations"] and family(k) == family(st)]
            if not sib:
                continue
            name, a = next(iter(sib[0][1]["animations"].items()))
            prompt = R.clip_prompts().get(f"{rel}#{st}#{name}") or R.brief_for(a, name, 0)
            out.append((rel, st, sv["pixellab_object_id"], name, prompt, sib[0][0]))
    return out


def one(client, rel, st, oid, name, prompt):
    man = factory.read_manifest(rel) or {}
    try:
        state, n, how = A.one(client, rel, man, st, oid, False, name, prompt, directions=["south"])
        return (rel, st, name, n, how)
    except PixelLabError as e:
        return (rel, st, name, 0, f"FAILED: {str(e)[:260]}")
    except Exception as e:                  # noqa: BLE001
        return (rel, st, name, 0, f"ERROR: {type(e).__name__}: {str(e)[:220]}")


def main():
    ap = argparse.ArgumentParser(description="Animate never-animated states of animated pieces.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", default=None, help="comma-separated <group>/<piece>#<STATE>")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--min-usd", type=float, default=2.0)
    args = ap.parse_args()

    todo = targets()
    if args.only:
        keep = set(args.only.split(","))
        todo = [t for t in todo if f"{t[0]}#{t[1]}" in keep]
    if args.limit:
        todo = todo[:args.limit]
    gens = len(todo) * 3
    print(f"{len(todo)} state(s) with no clip on an animated piece, south first: "
          f"~{gens} generations x ${USD_PER_GEN} = about ${gens * USD_PER_GEN:.2f} "
          f"(facings follow via redo_facing_anim.py --missing)")
    for rel, st, _, name, prompt, sib in todo[:30]:
        print(f"  {rel:<36} {st:<10} {name:<7} after {sib:<10} {prompt[45:100]}")
    if args.dry_run or not todo:
        return 0
    client = PixelLabClient()
    bal = (client.balance().get("credits") or {}).get("usd")
    if bal is not None and bal < args.min_usd:
        print(f"balance ${bal:.2f} under the ${args.min_usd:.2f} floor — stopping")
        return 1
    ok, done = 0, []
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        futs = [pool.submit(one, client, r, s, o, n, p) for r, s, o, n, p, _ in todo]
        for f in as_completed(futs):
            rel, st, name, n, how = f.result()
            good = how in ("generated", "adopted his own") and n > 0
            ok += good
            if n > 0:
                done.append(f"{rel}#{st}#{name}")
            print(f"  {'=' if good else '!'} {rel} {st} {name}: {n} frame(s) {how}")
    print(f"\n{ok}/{len(todo)} state(s) animated on south")
    if done and not finish_clips.finish(done):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
