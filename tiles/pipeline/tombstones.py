"""Remember what the maintainer DELETED, so it is never generated again.

The maintainer's rule: if they delete an entire object, it should be deleted — not
quietly replaced with fresh graphics.

Without this the pipeline actively fights that instruction. matrix.py regenerates any
cell holding fewer than N sheets, and pixellab_gc deletes sheets that were rejected —
so a deletion becomes reject -> delete -> regenerate -> reject, an unbounded paid loop
that also keeps resurrecting art the maintainer has already said no to. A deletion has
to leave something behind that outlives the files, which is what a tombstone is.

Two ways a deletion is detected, both meaning "the maintainer removed this":

  * DELETED IN THE PIXELLAB UI — a registered tile_id that now 404s. This is the same
    signal tiles2's sync.py uses, and it is the maintainer's most direct lever: remove
    it in the UI and it stays gone.
  * DELETED LOCALLY — a cell that the registry says we generated, whose directory is
    no longer on disk.

Tombstones are permanent and committed. Removing an entry is a deliberate act
(`--revive`), never something the pipeline does on its own.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os

import pixellab_gc
from pixellab_client import PixelLabClient, PixelLabError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, "tombstones.json")
MATRIX = os.path.join(ROOT, "matrix")


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def load():
    if os.path.isfile(PATH):
        with open(PATH) as f:
            return json.load(f)
    return {"schema": "tiles3/tombstones@1",
            "_comment": ("Cells the maintainer deleted. NEVER regenerate these — a "
                         "deletion means the thing should not exist, not that it needs "
                         "a fresh attempt."),
            "cells": {}}


def save(t):
    with open(PATH, "w") as f:
        json.dump(t, f, indent=2, sort_keys=True)


def rejected_tiles():
    """Raw tiles the maintainer rejected individually, as repo-relative paths.

    Distinct from a cell tombstone. A tombstoned CELL is never regenerated at all; a
    rejected TILE just never gets published again, while the cell keeps being chased
    for something better. Both are permanent, because a review the maintainer has
    already given must not be asked for twice — they said as much when starting
    triage: "It feels you often get confused by the buggy art that should obviously be
    removed."
    """
    return set((load().get("tiles") or {}).keys())


def approved_tiles():
    """Tiles the maintainer explicitly OVERRULED the filter on.

    The counterpart to a rejection, and it exists because the feedback loop only ran one
    way for months: every gate was added after they reacted to something that SHIPPED, so
    the only correction they could make was "stricter". They said as much — "what you
    discard before I can see them has been blind to me, so I have never been able to
    relax your filter - only make it stronger."

    An approved tile publishes regardless of any gate. A measurement exists to predict
    their judgement; where it disagrees with their actual judgement, the measurement is
    the thing that is wrong.
    """
    return set((load().get("approved") or {}).keys())


def approve_tiles(paths, reason="maintainer override"):
    """Record tiles as publish-always. Returns how many were newly added."""
    doc = load()
    doc.setdefault("approved", {})
    n = 0
    for p in paths:
        if p in doc["approved"]:
            continue
        doc["approved"][p] = {"reason": reason, "at": _now()}
        n += 1
        # An override wins over a stale rejection of the same tile.
        (doc.get("tiles") or {}).pop(p, None)
    if n:
        save(doc)
    return n


def reject_tiles(paths, reason="wiki reject"):
    """Record individual tiles as rejected. Returns how many were newly added."""
    doc = load()
    doc.setdefault("tiles", {})
    n = 0
    for p in paths:
        if p in doc["tiles"]:
            continue
        doc["tiles"][p] = {"reason": reason, "at": _now()}
        n += 1
    if n:
        save(doc)
    return n


def is_dead(cell):
    return cell in load().get("cells", {})


def bury(cell, reason, tile_ids=None):
    t = load()
    if cell in t["cells"]:
        return False
    t["cells"][cell] = {"reason": reason, "at": _now(), "tile_ids": tile_ids or []}
    save(t)
    return True


def detect(client=None, check_remote=True):
    """Find deletions and record them. Returns the list of newly buried cells."""
    reg = pixellab_gc.load()["items"]
    cells = {}
    for tid, meta in reg.items():
        p = meta.get("purpose", "")
        if p.startswith("matrix:"):
            cells.setdefault(p.split(":", 1)[1], []).append(tid)

    buried = []
    for cell, ids in cells.items():
        d = os.path.join(MATRIX, cell.replace("_over_", "__over__"))
        if not os.path.isdir(d):
            if bury(cell, "cell directory removed locally", ids):
                buried.append((cell, "local"))

    if check_remote:
        client = client or PixelLabClient()
        for cell, ids in cells.items():
            if is_dead(cell):
                continue
            gone = []
            for tid in ids:
                try:
                    client._get(f"/tiles-pro/{tid}")
                except PixelLabError as e:
                    if "404" in str(e) or "410" in str(e):
                        gone.append(tid)
            if gone and len(gone) == len(ids):
                if bury(cell, "all sheets deleted in the PixelLab UI", ids):
                    buried.append((cell, "pixellab"))
    return buried


def main():
    ap = argparse.ArgumentParser(description="Record cells the maintainer deleted.")
    ap.add_argument("--detect", action="store_true", help="scan for deletions and bury them")
    ap.add_argument("--no-remote", action="store_true", help="skip the PixelLab 404 check")
    ap.add_argument("--bury", nargs="*", default=None, metavar="CELL")
    ap.add_argument("--revive", nargs="*", default=None, metavar="CELL",
                    help="deliberately allow a buried cell to be generated again")
    args = ap.parse_args()

    if args.bury:
        for c in args.bury:
            print(("buried " if bury(c, "buried by hand") else "already buried ") + c)
    if args.revive:
        t = load()
        for c in args.revive:
            if t["cells"].pop(c, None):
                print("revived", c)
        save(t)
    if args.detect:
        for cell, how in detect(check_remote=not args.no_remote):
            print(f"  buried {cell}  ({how})")

    t = load()
    print(f"\n{len(t['cells'])} tombstoned cell(s) — these are never regenerated")
    for c, m in sorted(t["cells"].items()):
        print(f"  {c:34s} {m['reason']}")


if __name__ == "__main__":
    main()
