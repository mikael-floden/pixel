"""Turn the maintainer's wiki verdicts into actions — safely, one TILE at a time.

The maintainer is starting a triage pass to clear out obviously broken generations
before the real review: "I want the final review to be done with a working
postprocessing script, but I can at least start a smaller initial review to get rid of
buggy generations. It feels you often get confused by the buggy art that should
obviously be removed." They are right — ice-over-grass was ranking a SOLID ICE BLOCK
first and it cost two rounds of their attention.

For that pass to be worth their time, two things have to hold, and neither did:

  1. A REJECTED TILE MUST STAY GONE. publish only skipped tombstoned CELLS, so a tile
     they rejected was republished on the next run and asked for the same verdict
     again. Rejections are now recorded per tile in tombstones.json and publish skips
     them permanently.

  2. A REJECTION MUST NOT DESTROY GOOD ART. pixellab_gc.apply_wiki_feedback resolved a
     verdict to a CELL and then stamped every tile_id in that cell — so rejecting one
     candidate marked every generation in the cell rejected, and the GC deletes what is
     marked rejected. A cell holds several 16-tile sheets and rejecting one tile says
     nothing about the other fifteen.

So a GENERATION is only marked rejected when every one of its published candidates has
been rejected. Until then the tile is merely un-published, which costs nothing and is
reversible; deleting from PixelLab is not.

  python tiles/pipeline/review.py             # show what the verdicts would do
  python tiles/pipeline/review.py --apply     # record them
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pixellab_gc
import tombstones

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REVIEW = os.path.join(ROOT, "review", "manifest.json")


def resolve():
    """Map each wiki verdict onto the exact published candidate it names.

    The wiki keys a verdict by the manifest's own `key` (tiles/<cell>/<n>), so this is
    an exact lookup rather than the substring match against cell names that the old
    path used. Anything that does not resolve is REPORTED, never guessed at — a verdict
    landing on the wrong tile is worse than one that lands nowhere.
    """
    fb = pixellab_gc.read_wiki_feedback()
    man = json.load(open(REVIEW))["cells"]
    by_key = {}
    for cell in man.values():
        for e in cell["candidates"]:
            by_key[e["key"]] = e
    hits, misses = [], []
    for key, v in fb.items():
        e = by_key.get(key.strip("/"))
        (hits if e else misses).append((key, v, e))
    return hits, misses, by_key


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    hits, misses, by_key = resolve()
    if not hits and not misses:
        print("no wiki verdicts for tiles yet")
        return 0

    rejects = [(k, e) for k, v, e in hits if v["status"] == "rejected"]
    approves = [(k, e) for k, v, e in hits if v["status"] == "approved"]
    print(f"{len(hits)} verdict(s) resolved, {len(misses)} unmatched"
          f"  ->  {len(approves)} approved, {len(rejects)} rejected")
    for k, v, _ in misses:
        print(f"   UNMATCHED (ignored): {k}")

    # A generation dies only when everything it produced was rejected.
    rejected_keys = {k for k, _ in rejects}
    by_gen = {}
    for e in by_key.values():
        if e.get("tile_id"):
            by_gen.setdefault(e["tile_id"], []).append(e["key"])
    doomed = [g for g, keys in by_gen.items()
              if keys and all(k in rejected_keys for k in keys)]

    srcs = [e["src"] for _, e in rejects if e.get("src")]
    missing_src = sum(1 for _, e in rejects if not e.get("src"))
    for k, e in rejects:
        print(f"   reject {k:34s} -> {e.get('src') or '(no src recorded; republish first)'}")
    print(f"\n{len(srcs)} tile(s) would never be published again")
    print(f"{len(doomed)} generation(s) fully rejected and safe to delete from PixelLab")
    if missing_src:
        print(f"WARNING: {missing_src} rejection(s) carry no `src` — run publish.py once "
              f"so the manifest records it, then re-run this.")

    if not args.apply:
        print("\n(dry run — pass --apply to record)")
        return 0
    n = tombstones.reject_tiles(srcs)
    if doomed:
        pixellab_gc.set_status(doomed, "rejected")
    print(f"recorded {n} new tile rejection(s); marked {len(doomed)} generation(s) rejected")
    print("run publish.py to rebuild the review set without them")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
