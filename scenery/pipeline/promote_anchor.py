"""Action a rejection that lands on the ANCHOR state, without losing the piece.

THE DEAD END THIS FIXES. A piece's ANCHOR is the state whose sprite IS the
piece's own `sprite.webp` — it has no directory of its own, and the wiki draws
it as a chip like any other. When he rejects that chip, prune.py deliberately
skips it: deleting the anchor would strip the art every card, thumbnail and
world placement renders and leave a piece that draws as nothing. So the
rejection is never actioned, the chip stays red forever, and each review pass
reports it as "held" to a maintainer who has told us plainly he will not
remember chat messages between batches.

WHAT HE ACTUALLY MEANT. In all four cases on 2026-08-19 the shape was the same:
the PIECE is approved, every OTHER state is approved, and the one rejected chip
is the anchor. He is not saying "delete this piece" — he has a piece-level
reject button and uses it. He is saying "this particular variant is bad", and
has no way to know that this one chip happens to be the file the piece points
at. So the faithful action is to keep the piece, drop the rejected art, and let
one of the variants he approved become the piece's face.

    PROMOTE  the best-rated approved sibling to anchor (its art becomes the
             piece's sprite.webp, and it keeps its own approval)
    DELETE   the rejected art and its store object, and RETIRE the slot so the
             planner does not regenerate what he just removed

THE CONTRADICTION GUARD. driftwood_log_901 does not fit that shape: its state
rejection (Aug 18, 1 star) and its PIECE approval (Aug 19, 3 stars) carry the
SAME art hash, and the approval is the newer of the two — he looked at that
exact image twice and said opposite things. Deleting art on that is guessing.
Per his standing instruction ("you must remove the rating and the
approval/rejection so I can find them again with my filters"), the verdict is
CLEARED instead so the chip returns to his queue unjudged.

    python3 pipeline/promote_anchor.py --dry-run
    python3 pipeline/promote_anchor.py
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime

import factory
import viewer_build
from pixellab_client import PixelLabClient, PixelLabError

FEEDBACK = os.path.join(os.path.dirname(factory.ROOT), "live", "feedback",
                        "objects.json")


def _ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _entries():
    with open(FEEDBACK, encoding="utf-8") as f:
        return json.load(f)


def survey():
    """([(rel, rejected_state, promote_to)], [(rel, rejected_state, why)]).

    The second list is the confusing ones, whose verdicts get cleared."""
    entries = _entries()["entries"]
    promote, confusing = [], []
    for key, v in sorted(entries.items()):
        if (v or {}).get("status") != "rejected" or "#" not in key:
            continue
        if not key.startswith("scenery/"):
            continue
        rel = key.split("#")[0][len("scenery/"):]
        state = key.split("#")[1].upper()
        man = factory.read_manifest(rel)
        if not man:
            continue
        ent = (man.get("states") or {}).get(state)
        # STATIC and BASE are the WIKI's names for the piece's own art, not
        # manifest states — so they are anchors too, and they fall through every
        # other tool: prune.py looks them up in `states` and finds nothing,
        # ghosts.py deliberately never sweeps them. A rejection there is the
        # same dead end, one door along.
        pseudo = ent is None and state in ("STATIC", "BASE")
        if not pseudo and (not ent or ent.get("sprite") != man.get("sprite")):
            continue                      # not the anchor — prune.py's job

        piece = entries.get(f"scenery/{rel}") or {}
        if piece.get("status") == "rejected":
            continue                      # feedback.py removes the whole piece

        # SAME IMAGE, OPPOSITE VERDICTS, and the approval is the newer one.
        if (piece.get("status") == "approved" and piece.get("art")
                and piece.get("art") == v.get("art")):
            pt, st = _ts(piece.get("updated_at")), _ts(v.get("updated_at"))
            if pt and st and pt > st:
                confusing.append((rel, state, "the piece was approved LATER "
                                              "with this very art"))
                continue

        # A pseudo-state has no slot of its own to swap out — the only art it
        # names is the piece's, and dropping that would be rejecting the piece,
        # which he does with the piece's own button. Nothing to promote, so it
        # goes back to him.
        if pseudo:
            confusing.append((rel, state, "a rejection on the piece's own art "
                                          "with no state slot to swap"))
            continue

        # Pick his best surviving state. SAME LIGHTING FAMILY FIRST: the piece's
        # face was a lit one or an unlit one, and he rejected the art, not the
        # lighting — swapping a lit anchor for an unlit sibling would quietly
        # change what the piece IS everywhere it is placed. Only when the family
        # has been emptied (mushroom_002, whose lit states he re-filed as unlit
        # earlier the same day) does it cross over. Then rating, then recency.
        lit_family = state.startswith("LIT")
        cands = []
        for s, e in (man.get("states") or {}).items():
            if s == state or (e or {}).get("sprite") == man.get("sprite"):
                continue
            sv = entries.get(f"scenery/{rel}#{s.lower()}#south") or {}
            if sv.get("status") != "approved":
                continue
            same = s.startswith("LIT") == lit_family
            cands.append((same, sv.get("rating") or 0,
                          str(sv.get("updated_at")), s))
        if not cands:
            confusing.append((rel, state, "no approved sibling to promote"))
            continue
        promote.append((rel, state, sorted(cands, reverse=True)[0][3]))
    return promote, confusing


def apply(client, promote, confusing, dry=False):
    doc = _entries()
    entries = doc["entries"]
    done = 0
    for rel, rejected, winner in promote:
        man = factory.read_manifest(rel) or {}
        states = dict(man.get("states") or {})
        win = dict(states.get(winner) or {})
        if dry:
            print(f"  {rel}: promote {winner} -> anchor, delete {rejected}")
            continue

        # 1. The winner's art becomes the piece's own sprite. Scenery is
        #    SOUTH-only (no `rotations` on any piece here), so this is one file.
        src = os.path.join(factory.ROOT, win["sprite"])
        dst = os.path.join(factory.ROOT, man["sprite"])
        shutil.copyfile(src, dst)
        shutil.rmtree(os.path.join(factory.ROOT, rel, winner.lower()),
                      ignore_errors=True)
        win["sprite"] = man["sprite"]
        win["replaced_anchor"] = rejected
        states[winner] = win

        # 2. The old anchor's store object holds ONLY the rejected art — the
        #    piece now points at the winner's object, so the old one is dead.
        old_oid = man.get("pixellab_object_id")
        if old_oid and old_oid != win.get("pixellab_object_id"):
            try:
                client.delete_object(old_oid)
            except PixelLabError as e:
                if "404" not in str(e):
                    print(f"  ! store delete failed for {rel} ({old_oid}): "
                          f"{str(e)[:90]} — the orphan report will flag it")
        man["pixellab_object_id"] = win.get("pixellab_object_id")

        # 3. Record the removal BEFORE forgetting it, same order as prune.py:
        #    a slot missing from the manifest but not retired is exactly what
        #    the scheduler regenerates.
        factory.retire_states([(rel, rejected)])
        states.pop(rejected, None)
        man["states"] = {k: states[k] for k in sorted(states)}
        factory.write_manifest(rel, man)
        done += 1
        print(f"  = {rel}: {winner} is now the anchor; {rejected} deleted")

    cleared = 0
    for rel, state, why in confusing:
        key = f"scenery/{rel}#{state.lower()}#south"
        print(f"  ? {rel} {state}: {why} — {'would clear' if dry else 'cleared'}"
              f" the verdict, back in his queue")
        if not dry and key in entries:
            entries.pop(key)
            cleared += 1
    if not dry and cleared:
        with open(FEEDBACK, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write("\n")
    return done, cleared


def main():
    ap = argparse.ArgumentParser(
        description="Action anchor-state rejections by promoting a sibling.")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    promote, confusing = survey()
    print(f"{len(promote)} anchor rejection(s) to action, "
          f"{len(confusing)} to hand back to him")
    if not promote and not confusing:
        return 0
    client = None if args.dry_run else PixelLabClient()
    done, cleared = apply(client, promote, confusing, dry=args.dry_run)
    if args.dry_run:
        return 0
    # The rejected state's verdict now judges art that is gone.
    import ghosts
    ghosts.sweep()
    viewer_build.build()
    print(f"\npromoted {done} anchor(s), cleared {cleared} confusing verdict(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
