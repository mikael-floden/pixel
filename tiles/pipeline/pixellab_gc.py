"""Delete tiles this domain generated but did NOT keep, so PixelLab does not fill
with junk from regeneration.

Why this needs to be careful rather than clever
-----------------------------------------------
tiles2's `sync.py` DROPS any local sheet whose PixelLab tile_id 404s — that is a
feature (delete-in-UI to force a re-roll), but it means deleting the wrong id here
would silently delete shipped art from the repo on the next tiles2 run. There are
currently 905 tiles-pro on the account and only a handful are ours.

So this refuses to delete anything unless it is BOTH:

  1. in our own registry (`tiles/generated.json`) — every id this domain created,
     written at generation time. Anything not in it is someone else's: the
     maintainer's own experiments, tiles2's shipped sheets, another domain's work.
     Never touched, never even considered.
  2. not currently referenced anywhere in the repo — a second, independent check
     against the filesystem, so a registry mistake still cannot delete live art.

Dry-run is the default; `--apply` is required to delete. Deletions are irreversible.

  python tiles/pipeline/pixellab_gc.py                 # show what WOULD be deleted
  python tiles/pipeline/pixellab_gc.py --apply         # delete rejected + unreferenced
  python tiles/pipeline/pixellab_gc.py --keep <id> ... # mark ids as approved
  python tiles/pipeline/pixellab_gc.py --reject <id> ... # mark rejected (deleted on next --apply)
"""

from __future__ import annotations

import argparse
import datetime
import contextlib
import fcntl
import json
import os
import subprocess

from pixellab_client import PixelLabClient, PixelLabError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
REGISTRY = os.path.join(ROOT, "generated.json")


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


_EMPTY = {"schema": "tiles3/generated@1", "items": {}}
_LOCK = REGISTRY + ".lock"


def load():
    """Never raise. A corrupt ledger is a bookkeeping problem; it must not be able to
    take down a generator that is spending real money.

    It happened: twelve concurrent chase workers each did an unlocked
    read-modify-write of this file, one read a half-written copy, and every one of 116
    cells then died on the same JSONDecodeError — after the sheet was paid for and
    before the tiles were saved. $11 of art that was generated and never reached disk.
    """
    if not os.path.isfile(REGISTRY):
        return dict(_EMPTY)
    try:
        with open(REGISTRY) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        # Keep the damaged file for inspection rather than silently discarding what may
        # be thousands of ids, and carry on from empty — record() merges, so the next
        # writes rebuild rather than overwrite a good file with a stub.
        bad = REGISTRY + ".corrupt"
        try:
            if not os.path.exists(bad):
                os.replace(REGISTRY, bad)
                print(f"  ! {os.path.basename(REGISTRY)} was corrupt ({e}); "
                      f"moved to {os.path.basename(bad)}")
        except OSError:
            pass
        return dict(_EMPTY)


def save(reg):
    """ATOMIC. Write beside the target and rename over it — os.replace is atomic on
    POSIX, so a concurrent reader sees either the whole old file or the whole new one,
    never the half-written middle."""
    tmp = f"{REGISTRY}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(reg, f, indent=2, sort_keys=True)
    os.replace(tmp, REGISTRY)


@contextlib.contextmanager
def _locked():
    """Serialise the read-modify-write across processes. Atomic writes alone stop
    corruption but not LOST UPDATES: two workers both read, both add their own id, and
    whichever writes second silently drops the other's — which for this file means a
    paid generation the GC can no longer see and will never clean up."""
    with open(_LOCK, "w") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX)
        except OSError:
            pass                     # no locking available: still better than nothing
        try:
            yield
        finally:
            try:
                fcntl.flock(fh, fcntl.LOCK_UN)
            except OSError:
                pass


def record(tile_id, purpose, prompt="", status="pending"):
    """Register an id at generation time. Called by whatever generates, so the GC
    can only ever see — and therefore only ever delete — our own work."""
    if not tile_id:
        return
    with _locked():
        reg = load()
        reg["items"][tile_id] = {"purpose": purpose, "prompt": prompt[:400],
                                 "status": status, "created": _now()}
        save(reg)


def set_status(ids, status):
    with _locked():
        return _set_status(ids, status)


def _set_status(ids, status):
    reg = load()
    n = 0
    for i in ids:
        if i in reg["items"]:
            reg["items"][i]["status"] = status
            reg["items"][i]["reviewed"] = _now()
            n += 1
        else:
            print(f"  ! not ours, ignoring: {i}")
    save(reg)
    return n


FEEDBACK = os.path.join(REPO, "live", "feedback", "tiles.json")


def read_wiki_feedback():
    """Read the maintainer's wiki review for this domain.

    Format (pixel-wiki-feedback@1, the same channel the scenery domain already uses —
    3,554 entries in live/feedback/objects.json as of 2026-08-16):

        entries: { "<entity path>": {status: approved|rejected, rating: 1-5,
                                     art: "<hash>", updated_at: "..."} }

    We only READ it — live/ belongs to another domain. Returns
    {entity_path: {status, rating}}. Empty until the wiki ships Tiles 3.0 review
    support; wiring it now means the first batch of reviews is actionable the moment
    it lands rather than needing code written under time pressure.
    """
    if not os.path.isfile(FEEDBACK):
        return {}
    with open(FEEDBACK) as f:
        doc = json.load(f)
    out = {}
    for k, v in (doc.get("entries") or {}).items():
        if isinstance(v, dict) and v.get("status"):
            out[k] = {"status": v["status"], "rating": v.get("rating"),
                      "updated_at": v.get("updated_at")}
    return out


def apply_wiki_feedback():
    """Map wiki verdicts onto our tile_ids.

    A review names a TILE (a cell/sheet/tile path); we delete by SHEET, since a
    tile_id is the whole 16-tile generation. So a sheet is only marked rejected when
    the maintainer has rejected every reviewed tile in it — one bad tile in a sheet
    that also contains an approved one must not delete the approved art. Ratings are
    kept on the record because they are the ground truth the wall metric needs to be
    calibrated against; the current score disagrees with the maintainer's eye in
    places, and guessing at that is what a rating fixes.
    """
    fb = read_wiki_feedback()
    if not fb:
        return {"reviewed": 0, "approved": 0, "rejected": 0, "unmatched": 0}
    reg = load()
    # our sheets carry the cell + sheet in their purpose (matrix:<top>_over_<side>);
    # match a review path against that, tolerant of how the wiki chooses to key them
    by_cell = {}
    for tid, meta in reg["items"].items():
        p = meta.get("purpose", "")
        if p.startswith("matrix:"):
            by_cell.setdefault(p.split(":", 1)[1], []).append(tid)
    verdicts = {}
    unmatched = 0
    for path, v in fb.items():
        norm = path.replace("__over__", "_over_").strip("/")
        hit = next((c for c in by_cell if c and c in norm), None)
        if not hit:
            unmatched += 1
            continue
        for tid in by_cell[hit]:
            verdicts.setdefault(tid, []).append(v)
    n_a = n_r = 0
    for tid, vs in verdicts.items():
        approved = any(x["status"] == "approved" for x in vs)
        reg["items"][tid]["status"] = "approved" if approved else "rejected"
        reg["items"][tid]["reviewed"] = _now()
        ratings = [x["rating"] for x in vs if x.get("rating")]
        if ratings:
            reg["items"][tid]["rating"] = max(ratings)
        n_a += bool(approved)
        n_r += (not approved)
    save(reg)
    return {"reviewed": len(fb), "approved": n_a, "rejected": n_r, "unmatched": unmatched}


def referenced_ids():
    """Every tile_id mentioned anywhere in the repo's tracked files. The independent
    safety net: if art derived from an id is still committed, the id is in use, no
    matter what the registry believes."""
    try:
        out = subprocess.run(
            ["git", "grep", "-hoE", r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"],
            cwd=REPO, capture_output=True, text=True, timeout=180).stdout
        return set(out.split())
    except Exception as e:
        raise PixelLabError(f"could not scan the repo for referenced ids ({e}); "
                            "refusing to delete without that check")


def main():
    ap = argparse.ArgumentParser(description="Delete unused tiles 3.0 generations from PixelLab.")
    ap.add_argument("--apply", action="store_true", help="actually delete (default: dry run)")
    ap.add_argument("--keep", nargs="*", default=None, metavar="ID")
    ap.add_argument("--reject", nargs="*", default=None, metavar="ID")
    ap.add_argument("--from-wiki", action="store_true",
                    help="pull approve/reject verdicts from live/feedback/tiles.json")
    ap.add_argument("--reject-pending", action="store_true",
                    help="treat every still-unreviewed id as rejected")
    args = ap.parse_args()

    if args.from_wiki:
        r = apply_wiki_feedback()
        print(f"wiki feedback: {r['reviewed']} reviewed -> {r['approved']} sheets approved, "
              f"{r['rejected']} rejected, {r['unmatched']} not ours/unmatched")
    if args.keep:
        print(f"marked {set_status(args.keep, 'approved')} approved")
    if args.reject:
        print(f"marked {set_status(args.reject, 'rejected')} rejected")

    reg = load()
    items = reg["items"]
    if not items:
        print("registry empty — nothing this domain generated is tracked yet")
        return

    refs = referenced_ids()
    doomed, kept = [], []
    for tid, meta in items.items():
        st = meta.get("status", "pending")
        if st == "approved":
            kept.append((tid, "approved")); continue
        if tid in refs:
            kept.append((tid, "referenced in the repo")); continue
        if st == "rejected" or (args.reject_pending and st == "pending"):
            doomed.append((tid, meta))
        else:
            kept.append((tid, "pending review"))

    print(f"\nregistry: {len(items)} ids generated by tiles 3.0")
    for tid, why in kept:
        print(f"  KEEP   {tid}  ({why})")
    print()
    if not doomed:
        print("nothing to delete")
        return
    client = PixelLabClient()
    for tid, meta in doomed:
        if not args.apply:
            print(f"  would delete {tid}  {meta.get('purpose','')} :: {meta.get('prompt','')[:60]}")
            continue
        try:
            client._request("DELETE", f"/tiles-pro/{tid}")
            items[tid]["status"] = "deleted"
            items[tid]["deleted_at"] = _now()
            print(f"  deleted {tid}")
        except PixelLabError as e:
            print(f"  ! failed {tid}: {str(e)[:120]}")
    if args.apply:
        save(reg)
    else:
        print(f"\n{len(doomed)} would be deleted. Re-run with --apply to do it.")


if __name__ == "__main__":
    main()
