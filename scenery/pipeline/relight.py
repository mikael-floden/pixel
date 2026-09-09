"""Re-file states the maintainer says are filed under the wrong lighting.

Him, via the wiki: "the AI that generates the image might fail to produce the
light, but the scenery overall looks great. So I want a way to change the state
from 'lit' to 'unlit' when doing the review. So we don't have to throw away the
art just because it's lit state is wrong."

So this is a RENAME, never a regeneration. A LIT_2 that came out dark is not
bad art; it is unlit art filed under the wrong name, and rejecting it would
destroy the thing he wants kept.

Input:  live/tuning/scenery_lights.json (the wiki's document, schema
        pixel-wiki-scenery-lights@1) — overrides["<path>#<state>"] = {lit: bool}
        Absent means the name is already right.

THE VERDICT MOVES WITH THE ART. Renaming LIT_1 to NOT_LIT_3 would otherwise
strand his rating and comment on a state key that no longer exists — a ghost of
exactly the kind he has just spent a session complaining about — and lose his
judgement of a picture that is still on screen. His verdict is about the
PICTURE, so it follows the picture.

    python3 pipeline/relight.py --dry-run
    python3 pipeline/relight.py
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(__file__))
import factory
import viewer_build

LIGHTS = os.path.join(os.path.dirname(factory.ROOT), "live", "tuning",
                      "scenery_lights.json")
FEEDBACK = os.path.join(os.path.dirname(factory.ROOT), "live", "feedback",
                        "objects.json")


def _family(state):
    return "LIT_" if state.upper().startswith("LIT_") else "NOT_LIT_"


def _free_slot(states, family):
    """Lowest unused index in that family — numbering is per piece."""
    used = {int(s.rsplit("_", 1)[-1]) for s in states
            if s.upper().startswith(family) and s.rsplit("_", 1)[-1].isdigit()
            and _family(s) == family}
    n = 1
    while n in used:
        n += 1
    return f"{family}{n}"


def plan():
    """[(rel, old_state, new_state, is_anchor)] plus the keys to drop."""
    try:
        ov = json.load(open(LIGHTS, encoding="utf-8")).get("overrides") or {}
    except (OSError, ValueError) as e:
        print(f"cannot read the lights document ({e})")
        return [], []
    moves, spent = [], []
    per_piece = collections.defaultdict(dict)
    for key, v in ov.items():
        body = key[len("scenery/"):] if key.startswith("scenery/") else key
        rel, state = body.split("#")[0], body.split("#")[1]
        per_piece[rel][state] = bool(v.get("lit"))

    for rel, asks in sorted(per_piece.items()):
        man = factory.read_manifest(rel)
        if not man:
            spent += [f"scenery/{rel}#{s}" for s in asks]
            continue                      # piece is gone; the override is spent
        states = dict(man.get("states") or {})
        anchor = next((s for s, e in states.items()
                       if (e or {}).get("sprite") == man.get("sprite")), None)
        for state, want_lit in sorted(asks.items()):
            key = f"scenery/{rel}#{state}"
            # "base" is the wiki's name for the piece's own sprite when no state
            # claims it. owl_snag_002 lost its anchor to a regeneration, so its
            # base art is unrepresented; marking it lit means giving it a real
            # anchor state in the lit family.
            if state.lower() == "base":
                if anchor:
                    spent.append(key)
                    continue
                new = _free_slot(states, "LIT_" if want_lit else "NOT_LIT_")
                moves.append((rel, None, new, True))
                spent.append(key)
                continue
            actual = next((s for s in states if s.lower() == state.lower()), None)
            if not actual:
                spent.append(key)          # state already gone
                continue
            fam = "LIT_" if want_lit else "NOT_LIT_"
            if _family(actual) == fam:
                spent.append(key)          # already right — nothing to do
                continue
            new = _free_slot(states, fam)
            states[new] = states[actual]   # reserve so siblings do not collide
            del states[actual]
            moves.append((rel, actual, new, actual == anchor))
            spent.append(key)
    return moves, spent


def apply(moves, dry):
    fb = json.load(open(FEEDBACK, encoding="utf-8"),
                   object_pairs_hook=collections.OrderedDict)
    entries = fb["entries"]
    moved_verdicts = 0
    for rel, old, new, is_anchor in moves:
        if dry:
            what = "give the base art" if old is None else f"re-file {old} ->"
            print(f"  {rel}: {what} {new}"
                  f"{' (anchor — key only, no file move)' if is_anchor else ''}")
            continue
        man = factory.read_manifest(rel) or {}
        states = dict(man.get("states") or {})
        if old is None:
            states[new] = {"sprite": man["sprite"],
                           "pixellab_object_id": man.get("pixellab_object_id"),
                           "generated_at": man.get("generated_at")}
        else:
            ent = dict(states.pop(old))
            if not is_anchor:
                # The ANCHOR's sprite is the piece's own sprite.webp and has no
                # state directory of its own, so only its key changes.
                src = os.path.join(factory.ROOT, rel, old.lower())
                dst = os.path.join(factory.ROOT, rel, new.lower())
                if os.path.isdir(src):
                    shutil.rmtree(dst, ignore_errors=True)
                    shutil.move(src, dst)
                ent["sprite"] = f"{rel}/{new.lower()}/sprite.webp"
            ent["relit_from"] = old
            states[new] = ent
        man["states"] = {k: states[k] for k in sorted(states)}
        factory.write_manifest(rel, man)
        if old:
            ok = f"scenery/{rel}#{old.lower()}#south"
            nk = f"scenery/{rel}#{new.lower()}#south"
            if ok in entries and nk not in entries:
                entries[nk] = entries.pop(ok)
                moved_verdicts += 1
        print(f"  = {rel}: {old or 'base'} -> {new}")
    if not dry and moved_verdicts:
        with open(FEEDBACK, "w", encoding="utf-8") as f:
            json.dump(fb, f, indent=2, ensure_ascii=False)
            f.write("\n")

    # A CORRECTION IS NOT A GAP. Four pieces here had ALL FOUR of their lit
    # states re-filed as unlit — he is saying that art was never lit. But
    # state_variants plans by asking which of the six slots are empty, so the
    # now-empty lit family reads as missing and the next scheduled run
    # generates LIT_1 and LIT_2 from scratch: brand new art, on a piece he has
    # just told us has no light, paid for out of his credit. Same shape as the
    # pruning trap, one level along. Retiring the slots the planner would ask
    # for is what makes his correction stick.
    if not dry:
        import state_variants as sv
        retired = []
        for rel in sorted({m[0] for m in moves}):
            man = factory.read_manifest(rel)
            if not man:
                continue
            for state in sv.plan_for(man, rel)[1]:
                retired.append((rel, state))
        if retired:
            factory.retire_states(retired)
            print(f"  retired {len(retired)} slot(s) the planner would have "
                  f"refilled: {sorted({r for r, _ in retired})}")
    return moved_verdicts


def drop_overrides(spent, dry):
    if dry or not spent:
        return 0
    doc = json.load(open(LIGHTS, encoding="utf-8"),
                    object_pairs_hook=collections.OrderedDict)
    ov = doc.get("overrides") or {}
    n = 0
    for k in spent:
        if ov.pop(k, None) is not None:
            n += 1
    doc["overrides"] = ov
    with open(LIGHTS, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    moves, spent = plan()
    print(f"{len(moves)} state(s) to re-file, {len(spent)} override(s) to clear")
    moved = apply(moves, args.dry_run)
    if args.dry_run:
        return 0
    dropped = drop_overrides(spent, False)
    viewer_build.build()
    print(f"\nre-filed {len(moves)}, carried {moved} verdict(s) across, "
          f"cleared {dropped} override(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
