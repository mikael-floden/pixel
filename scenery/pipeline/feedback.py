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


def apply_rejections(client):
    """Delete every non-stale rejected piece (store first, then repo).
    Returns removed rel ids; the CALLER owns the viewer rebuild + commit."""
    todo, legacy = rejections()
    for rel in legacy:
        print(f"  ! wiki rejected LEGACY piece {rel} — frozen and "
              f"game-referenced, NOT deleting; maintainer's own call")
    removed, stale = [], []
    for rel, verdict_at in todo:
        committed_at = _sprite_committed_at(rel)
        if not (verdict_at and committed_at and committed_at < verdict_at):
            stale.append(rel)
            continue
        meta = factory.read_manifest(rel, {}) or {}
        oid = meta.get("pixellab_object_id")
        if oid:
            try:
                client.delete_object(oid)
            except Exception as e:
                if "404" not in str(e):
                    print(f"  ! store delete failed for {rel} ({oid}): "
                          f"{str(e)[:120]} — repo copy removed anyway; the "
                          f"orphan report will flag the leftover")
        shutil.rmtree(factory.piece_dir(rel), ignore_errors=True)
        removed.append(rel)
    if removed:
        # The id dies with the art: a fresh roll gets a NEW number so the
        # maintainer's verdict keeps pointing at the piece he actually judged
        # and the re-roll lands in his unreviewed queue.
        factory.retire(removed)
    if stale:
        print(f"  feedback: {len(stale)} rejection(s) predate the current art "
              f"(slot re-rolled since) — awaiting re-review, untouched")
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
        viewer_build.build()
        loop.commit_push(
            f"scenery: remove {len(removed)} rejected piece(s) (wiki verdicts)",
            push=not args.no_push)
    print(f"feedback: {len(removed)} piece(s) removed")
