"""Apply his verdicts as PRUNING: rejected art goes, and nothing replaces it.

Maintainer, 2026-08-17: "This review process will be a bit different. Because
when I reject from here on - that doesn't mean something new should be
generated. I will reject a lot of things and what's left is what we will stay
with."

Generation is finished. This is the cutting-down phase, and it is a different
operation from everything before it:

  redo_rejected.py  — DELETE the state, then GENERATE a replacement.  (before)
  prune.py          — DELETE the state, and RECORD that it stays gone. (now)

The recording is the entire point. state_variants plans by asking "which of
this piece's six states are missing?", so a state that is merely deleted reads
as a gap and the next scheduled run regenerates it — his rejection would be
silently reverted by the scheduler, at his expense, with art he never asked
for. factory.retire_states() is what makes a deletion stick, exactly as
factory.retire() does for whole pieces.

    python3 pipeline/prune.py --dry-run
    python3 pipeline/prune.py
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime

import re

import factory
import viewer_build

# "Redo to get rid of the owl", "it should be regenerated", "Should be light
# but still a bit darker, see LIT_1 for style" — all of these are briefs for
# new art, not instructions to delete.
REDO_RE = re.compile(r"\b(redo|regenerat|should be)", re.I)
from pixellab_client import PixelLabClient, PixelLabError

FEEDBACK = os.path.join(os.path.dirname(factory.ROOT), "live", "feedback",
                        "objects.json")


def _ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _committed(relpath):
    """When this sprite last landed in git. Time, not hash: the wiki stamps a
    STATE verdict with the PIECE's art hash, so a hash comparison here says
    'stale' for every state verdict ever written (measured 2026-08-15, 0 of 225
    matched)."""
    if not relpath:
        return None
    r = subprocess.run(["git", "log", "-1", "--format=%cI", "--", relpath],
                       cwd=factory.ROOT, capture_output=True, text=True)
    return _ts(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None


def rejected_states():
    """[(rel, STATE)] for rejected states whose art PREDATES the rejection.

    THE STALENESS TEST STAYS, and dropping it would have been destructive. My
    first draft reasoned that with nothing being regenerated, a rejection is
    simply an instruction to remove — so it needed no staleness test. The dry
    run returned 118 states. Every one of them was a verdict this agent had
    ALREADY actioned by regenerating: the art on disk is the replacement, which
    he has never seen, let alone rejected. Pruning them would have destroyed
    118 pieces of art on the strength of verdicts about art that no longer
    exists.

    His rule is "when I reject from HERE ON", which is a statement about what a
    NEW rejection means — not a licence to re-apply every old one. A verdict
    only describes the art on disk if that art was committed BEFORE it."""
    try:
        with open(FEEDBACK, encoding="utf-8") as f:
            entries = json.load(f).get("entries") or {}
    except (OSError, ValueError) as e:
        print(f"cannot read the feedback file ({e})")
        return []
    out, spent, redo = [], 0, 0
    for key, v in sorted(entries.items()):
        if (v or {}).get("status") != "rejected" or "#" not in key:
            continue
        if not key.startswith("scenery/"):
            continue
        rel, state = key.split("#")[0][len("scenery/"):], key.split("#")[1].upper()
        man = factory.read_manifest(rel)
        if not man:
            continue
        ent = (man.get("states") or {}).get(state)
        if not ent:
            continue
        # NEVER PRUNE THE ANCHOR. Its sprite IS the piece's own sprite, so
        # removing it would strip the art every card and thumbnail shows and
        # leave a piece that renders as nothing. A rejection of the anchor is a
        # rejection of the PIECE, which feedback.py handles.
        if (ent or {}).get("sprite") == man.get("sprite"):
            continue
        # A NOTE ASKING FOR A REDO IS NOT A PRUNE. Maintainer 2026-08-18: "The
        # general rule is of course that you don't regenerate the art I reject.
        # But on some reviews I made a comment for you to regenerate." Deleting
        # those would throw away the one thing he took the trouble to ask for,
        # and deletion is irreversible while a regeneration he dislikes can
        # simply be rejected again — so the safe error is to regenerate.
        if REDO_RE.search(v.get("note") or ""):
            redo += 1
            continue
        vt, ct = _ts(v.get("updated_at")), _committed(ent.get("sprite"))
        if not (vt and ct and ct < vt):
            spent += 1
            continue                # art is newer than the verdict — not his
        out.append((rel, state))
    if redo:
        print(f"  ({redo} rejection(s) ask for a REGENERATION in the note — "
              f"those go to redo_rejected.py, not here)")
    if spent:
        print(f"  ({spent} rejection(s) describe art that has since been "
              f"regenerated — those verdicts are spent, leaving them alone)")
    return out


def prune(client, todo, dry=False):
    removed = 0
    for rel, state in todo:
        man = factory.read_manifest(rel) or {}
        ent = (man.get("states") or {}).get(state) or {}
        if dry:
            print(f"  would remove {rel} {state}")
            continue
        oid = ent.get("pixellab_object_id")
        if oid:
            try:
                client.delete_object(oid)
            except PixelLabError as e:
                if "404" not in str(e):
                    print(f"  ! store delete failed for {rel} {state}: "
                          f"{str(e)[:90]} — removing the repo copy anyway")
        shutil.rmtree(os.path.join(factory.ROOT, rel, state.lower()),
                      ignore_errors=True)
        # RECORD BEFORE FORGETTING. Retire first, then drop it from the
        # manifest: if this crashed in between, a state that is gone from the
        # manifest but not retired is exactly the case the scheduler
        # regenerates.
        factory.retire_states([(rel, state)])
        fresh = factory.read_manifest(rel) or man
        st = dict(fresh.get("states") or {})
        st.pop(state, None)
        fresh["states"] = st
        factory.write_manifest(rel, fresh)
        removed += 1
        print(f"  = pruned {rel} {state}")
    return removed


def main():
    ap = argparse.ArgumentParser(
        description="Delete rejected states permanently; generate nothing.")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    todo = rejected_states()
    print(f"{len(todo)} rejected state(s) to prune")
    if not todo:
        return 0
    client = None if args.dry_run else PixelLabClient()
    n = prune(client, todo, dry=args.dry_run)
    if args.dry_run:
        return 0
    # SWEEP THE GHOSTS IN THE SAME RUN. A pruned state's verdict outlives the
    # art it judged, and the wiki still draws a chip for it — a red button that
    # opens on an empty frame, indistinguishable from art he still has to act
    # on. He asked for this directly: "Please process and leave no 'ghost
    # state' behind." Doing it here rather than as a separate chore is what
    # stops them accumulating: 1,460 had piled up before this existed.
    import ghosts
    ghosts.sweep()
    viewer_build.build()
    print(f"\npruned {n} state(s) — retired so nothing regenerates them")
    return 0


if __name__ == "__main__":
    sys.exit(main())
