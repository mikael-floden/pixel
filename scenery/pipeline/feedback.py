"""Wiki verdicts are standing orders: rejected scenery gets removed. Always.

The maintainer reviews scenery in the wiki; the live game server commits his
clicks to `live/feedback/objects.json` ("objects" is that surface's shared
data key, older than the scenery rename — the file is the LIVE SERVER'S, one
writer per file, never edit it from here). A **rejected** verdict is a
standing order (maintainer, 2026-08-13): when the loop sees one, it deletes
the piece from the PixelLab store AND the repo — no confirmation — and the
deterministic planner regenerates the slot with a fresh roll on a later pass.

Safety rails:
  - LEGACY top-level pieces (campfire, grave_cross, blood_spatter) are
    game-referenced and frozen: never auto-deleted, only warned about.
  - STALE-VERDICT GUARD: verdicts linger in the feedback file after a slot
    is re-rolled under the same id, and a fresh roll must never be killed by
    the rejection of its predecessor. A rejection only counts against art
    whose last git commit PRECEDES the verdict's timestamp; art newer than
    its verdict (or not yet committed) is awaiting re-review and untouched.
  - A store delete that 404s is fine (already deleted upstream). Any other
    store error is reported but the repo copy still goes — `sync.py`'s
    orphan report flags SCENERY-tagged leftovers nothing tracks.

Standalone (the loop also runs this automatically at startup):
  python scenery/pipeline/feedback.py --dry-run   # list what would go
  python scenery/pipeline/feedback.py             # delete + commit + push
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import datetime

import factory

FEEDBACK_PATH = os.path.join(os.path.dirname(factory.ROOT),
                             "live", "feedback", "objects.json")


def _parse_ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def load_entries():
    if not os.path.exists(FEEDBACK_PATH):
        return {}
    with open(FEEDBACK_PATH) as f:
        return json.load(f).get("entries") or {}


def _sprite_committed_at(rel_id):
    """When this piece's sprite last landed in git (None = never committed)."""
    r = subprocess.run(
        ["git", "log", "-1", "--format=%cI", "--", f"{rel_id}/sprite.webp"],
        cwd=factory.ROOT, capture_output=True, text=True)
    return _parse_ts(r.stdout.strip()) if r.returncode == 0 else None


def rejections():
    """Applicable rejections -> ([(rel_id, verdict_at)], [legacy rel_ids]).

    Only pieces that still exist on disk; verdicts on already-removed pieces
    are spent orders, silently done."""
    todo, legacy = [], []
    for key, verdict in sorted(load_entries().items()):
        if (verdict or {}).get("status") != "rejected":
            continue
        parts = key.split("/")
        if len(parts) < 2 or parts[0] != "scenery":
            continue
        rel = "/".join(parts[1:])
        if factory.read_manifest(rel) is None:
            continue
        if "/" not in rel:
            legacy.append(rel)
            continue
        todo.append((rel, _parse_ts(verdict.get("updated_at"))))
    return todo, legacy


def clear_verdicts(rel_ids, why):
    """Strip status + rating + note so a piece RETURNS TO HIS REVIEW QUEUE.

    Maintainer, 2026-08-17: "When you find something you think is confusing
    like this you must remove the rating and the approval/rejection so I can
    find them again with my filters in the wiki next time I try to see what
    still needs review. I will work in batches when I have time and then I will
    not remember what you write to me here."

    That is the whole point: a note in a chat message is not a work queue. If
    this agent declines to act on a verdict, the ONLY place that decision can
    survive is the wiki's own filters, and a piece is only in the needs-review
    filter while it carries no verdict. Telling him in chat and leaving the
    verdict in place means the piece looks decided to both of us and is never
    seen again.

    This writes live/feedback/objects.json, which the LIVE SERVER owns. It is a
    deliberate exception on his instruction, so it is done as surgically as
    possible: read, delete three keys, write back with the same 2-space,
    non-escaped formatting the server uses, touching nothing else."""
    if not rel_ids:
        return 0
    try:
        with open(FEEDBACK_PATH, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        print(f"  ! could not clear verdicts ({e}) — they stay as they are")
        return 0
    entries = doc.get("entries") or {}
    n = 0
    for rel in rel_ids:
        e = entries.get(f"scenery/{rel}")
        if not e:
            continue
        for k in ("status", "rating", "note"):
            e.pop(k, None)
        # An entry with nothing but a timestamp is noise; drop it entirely so
        # the piece reads as genuinely untouched.
        if not any(k in e for k in ("status", "rating", "note")):
            entries.pop(f"scenery/{rel}", None)
        n += 1
    if n:
        with open(FEEDBACK_PATH, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"  feedback: cleared {n} verdict(s) ({why}) — back in his queue")
    return n


def apply_rejections(client):
    """Delete every non-stale rejected piece (store first, then repo).
    Returns removed rel ids; the CALLER owns the viewer rebuild + commit."""
    todo, legacy = rejections()
    for rel in legacy:
        print(f"  ! wiki rejected LEGACY piece {rel} — frozen and "
              f"game-referenced, NOT deleting; maintainer's own call")
    entries = load_entries()
    removed, stale, conflicted = [], [], []
    for rel, verdict_at in todo:
        verdict = entries.get(f"scenery/{rel}") or {}
        # CONTRADICTORY VERDICT GUARD. A rejection that carries a HIGH star
        # rating, or whose own per-state verdicts are all approvals, is far
        # more likely a misclick than an instruction — and this function
        # deletes art from the repo AND the store, which is not recoverable
        # from the PixelLab side. tree_021 arrived rejected at 5 stars with all
        # eleven of its states approved at 5 (2026-08-15). Report it and let
        # the maintainer confirm; deleting five-star art on a slip is a far
        # worse failure than leaving one rejection outstanding.
        rating = verdict.get("rating") or 0
        # A BARE REJECTION IS DELIBERATE, NOT SUSPICIOUS. Maintainer,
        # 2026-08-17: "I will also start to reject without given a star more
        # going forward. It's just for me to be able to review faster by not
        # having to press both on one star and reject." So an unrated rejection
        # is now his NORMAL fast path and must never be held.
        #
        # "Every state approved" is therefore no longer a signal either: it will
        # co-occur with bare rejections constantly, and holding on it would
        # quietly ignore most of what he does. Only art he explicitly rated
        # HIGHLY and then rejected still reads as a stray tap — that is the one
        # shape this guard was built for.
        if rating >= 4:
            conflicted.append(f"{rel} (rating {rating})")
            continue
        committed_at = _sprite_committed_at(rel)
        if not (verdict_at and committed_at and committed_at < verdict_at):
            stale.append(rel)
            continue
        meta = factory.read_manifest(rel, {}) or {}
        # EVERY store object the piece owns, not just its base one. A piece can
        # now carry STATES (windows: lights on/off; trees: 7 variants), each a
        # separate PixelLab object sharing the piece's group_id. Deleting only
        # `pixellab_object_id` would have left six tagged orphans per rejected
        # tree, sitting in the store with nothing in the repo tracking them —
        # this function predates states and quietly stopped being complete.
        oids = [meta.get("pixellab_object_id")]
        for st in (meta.get("states") or {}).values():
            oids.append((st or {}).get("pixellab_object_id"))
        for oid in [o for o in dict.fromkeys(oids) if o]:
            try:
                client.delete_object(oid)
            except Exception as e:
                if "404" not in str(e):
                    print(f"  ! store delete failed for {rel} ({oid}): "
                          f"{str(e)[:120]} — repo copy removed anyway; the "
                          f"orphan report will flag the leftover")
        # Retire BEFORE deleting: a crash between the two must never leave a
        # judged id free for the planner to re-roll onto (it happened —
        # 2026-08-13, a worker restart mid-apply left ~68 rejected ids
        # unretired and the next run squatted 60 of them with fresh art,
        # resurrecting the maintainer's whole review queue).
        factory.retire([rel])
        shutil.rmtree(factory.piece_dir(rel), ignore_errors=True)
        removed.append(rel)
    if conflicted:
        print(f"  feedback: {len(conflicted)} CONTRADICTORY rejection(s) NOT "
              f"deleted — rated highly AND rejected, which reads as a stray "
              f"tap. Their verdicts are CLEARED so they return to his queue:")
        for c in conflicted:
            print(f"      {c}")
        clear_verdicts([c.split(" (")[0] for c in conflicted],
                       "held as contradictory")
    if stale:
        # A verdict about art that no longer exists is spent. Leaving it in
        # place makes the piece look decided in the wiki's piece-level filters,
        # so it silently never comes back to him — the same trap as the
        # contradictory ones. Clear it and let the current art be judged.
        print(f"  feedback: {len(stale)} rejection(s) predate the current art "
              f"(slot re-rolled since) — clearing so the NEW art gets judged")
        clear_verdicts(stale, "verdict predates the current art")
    if removed:
        head = ", ".join(removed[:5])
        print(f"  feedback: removed {len(removed)} rejected piece(s): {head}"
              + (f" … +{len(removed) - 5} more" if len(removed) > 5 else ""))
    return removed


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(
        description="Apply wiki verdicts: delete rejected scenery (store + repo).")
    ap.add_argument("--dry-run", action="store_true",
                    help="List applicable rejections; delete nothing.")
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()

    if args.dry_run:
        todo, legacy = rejections()
        for rel, verdict_at in todo:
            committed_at = _sprite_committed_at(rel)
            live = verdict_at and committed_at and committed_at < verdict_at
            print(f"{'REMOVE' if live else 'stale '}  {rel}  "
                  f"(verdict {verdict_at}, art committed {committed_at})")
        for rel in legacy:
            print(f"LEGACY  {rel}  (frozen, never auto-deleted)")
        raise SystemExit(0)

    from pixellab_client import PixelLabClient
    import loop
    import viewer_build

    removed = apply_rejections(PixelLabClient())
    if removed:
        # Same reason as prune.py: a deleted PIECE leaves its own verdict and
        # every one of its states' verdicts pointing at nothing.
        import ghosts
        ghosts.sweep()
        viewer_build.build()
        loop.commit_push(
            f"scenery: remove {len(removed)} rejected piece(s) (wiki verdicts)",
            push=not args.no_push)
    print(f"feedback: {len(removed)} piece(s) removed")


# --- saturation: his notes are quota decisions -------------------------------

SATURATION_PHRASES = (
    "enough", "to many", "too many", "so many", "plenty", "no more", "no nore",
    "not more", "nore of this", "last from this", "last one from this",
    "done with this",
)


def saturated_groups():
    """{group_id: [note, ...]} for every group he has said he has ENOUGH of.

    He writes it a dozen ways ("Got to many already", "No nore barrels", "This
    was the last from this type I will approve") and — crucially — often on a
    piece he APPROVED or even five-starred. Saturation is not a quality
    verdict: it means beautiful, stop. The loop freezes these groups at their
    current count so budget flows to what he still wants."""
    out = {}
    for key, verdict in load_entries().items():
        note = (verdict or {}).get("note") or ""
        parts = key.split("/")
        if not note or len(parts) < 3:
            continue
        if any(p in note.lower() for p in SATURATION_PHRASES):
            out.setdefault(parts[1], []).append(note)
    return out
