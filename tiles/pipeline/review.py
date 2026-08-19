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
import datetime
import glob
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pixellab_gc
import tombstones

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REVIEW = os.path.join(ROOT, "review", "manifest.json")
# git needs a REPO-RELATIVE path. Passing the absolute one made `git show`
# and `git log` fail silently, so every verdict fell back to today's manifest
# — which is the exact failure this module exists to prevent.
REPO = os.path.dirname(ROOT)
REVIEW_REL = os.path.relpath(REVIEW, REPO)


def _history():
    """Every published manifest with the time it went live, newest first.

    THE KEY IS POSITIONAL — `tiles/<cell>/<n>` names a RANK, not a tile — so resolving a
    verdict against the CURRENT manifest is only correct if nothing has been republished
    since it was cast. Something had: a republish landed at 19:28 in the middle of a
    review that ran 19:22-20:06, re-ranked ice__over__grass, and the maintainer's
    rejection of the solid ice block at /0 was applied to the good tile that had since
    moved into /0. One verdict, exactly inverted, and it would have deleted the tile they
    had spent the previous hour asking me to fix.

    So a verdict is resolved against the manifest that was live WHEN IT WAS CAST.
    """
    out = []
    log = subprocess.run(["git", "log", "--format=%H %cI", "--", REVIEW_REL],
                         capture_output=True, text=True, cwd=REPO).stdout.split("\n")
    for line in log:
        if not line.strip():
            continue
        sha, iso = line.split()
        out.append((datetime.datetime.fromisoformat(iso), sha))
    return out


def _manifest_at(sha):
    try:
        blob = subprocess.run(["git", "show", f"{sha}:{REVIEW_REL}"],
                              capture_output=True, text=True, check=True, cwd=REPO).stdout
        return json.loads(blob)["cells"]
    except Exception:
        return None


def _src_of(entry, cell):
    """The raw tile behind a published candidate. Older manifests predate the `src`
    field, so fall back to locating it by generation + wall score — the same identity
    that was used to untangle the misapplied verdict by hand."""
    if entry.get("src"):
        return entry["src"]
    tid, want = entry.get("tile_id"), entry.get("wall_score")
    if not tid or want is None:
        return None
    import flatness
    for meta in glob.glob(os.path.join(ROOT, "matrix", cell, "sheet_*", "meta.json")):
        if json.load(open(meta)).get("tile_id") != tid:
            continue
        best = None
        for t in sorted(glob.glob(os.path.join(os.path.dirname(meta), "tile_*.png"))):
            q = flatness.wall_quality(t)
            if not q:
                continue
            if best is None or abs(q["score"] - want) < abs(best[1] - want):
                best = (t, q["score"])
        if best and abs(best[1] - want) < 0.05:
            return os.path.relpath(best[0], REPO)
    return None


def resolve():
    """Map each wiki verdict onto the exact tile it named, AT THE TIME it was cast."""
    fb = pixellab_gc.read_wiki_feedback()
    hist = _history()
    current = json.load(open(REVIEW))["cells"]
    hits, misses, shifted = [], [], []
    for key, v in fb.items():
        k = key.strip("/")
        cell, idx = k.rsplit("/", 1)
        cell = cell.split("/", 1)[1]
        ts = v.get("updated_at")
        man = current
        if ts:
            t = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
            for when, sha in hist:
                if when <= t:
                    man = _manifest_at(sha) or current
                    break
        # IDENTITY FIRST, POSITION ONLY AS A FALLBACK. Never try to tell the two kinds
        # of key apart by inspecting them — a sha1 prefix is hex, and hex is sometimes
        # all digits. "61453326".isdigit() is True, so six of the maintainer's
        # rejections took the positional branch, asked for candidate number 61,453,326,
        # and silently matched nothing. They stayed on the wiki after being rejected,
        # which is exactly what they had asked to stop happening.
        #
        # An exact key hit is unambiguous whatever the key looks like, so it is tried
        # first for every verdict; the positional archaeology below only runs when that
        # fails, which is the case it was written for.
        by_key = {x["key"]: x for c in current.values() for x in c["candidates"]}
        e = by_key.get(k)
        if e:
            e = dict(e)
            (hits if e.get("src") else misses).append((key, v, e))
            continue
        cands = (man.get(cell) or {}).get("candidates") or []
        if idx.isdigit() and int(idx) < len(cands):
            e = dict(cands[int(idx)])
            e["src"] = _src_of(e, cell)
            now = (current.get(cell) or {}).get("candidates") or []
            if int(idx) < len(now) and now[int(idx)].get("tile_id") != e.get("tile_id"):
                shifted.append(key)
        (hits if e and e.get("src") else misses).append((key, v, e))
    return hits, misses, shifted


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    hits, misses, shifted = resolve()
    if not hits and not misses:
        print("no wiki verdicts for tiles yet")
        return 0

    rejects = [(k, e) for k, v, e in hits if v["status"] == "rejected"]
    approves = [(k, e) for k, v, e in hits if v["status"] == "approved"]
    print(f"{len(hits)} verdict(s) resolved, {len(misses)} unmatched"
          f"  ->  {len(approves)} approved, {len(rejects)} rejected")
    for k, v, _ in misses:
        print(f"   UNMATCHED (ignored): {k}")

    if shifted:
        print(f"\nNOTE: {len(shifted)} verdict(s) were cast against an older ranking and "
              f"have been resolved against it, not against today's:")
        for k in shifted:
            print(f"   {k}")

    # A generation dies only when everything it produced was rejected.
    current = json.load(open(REVIEW))["cells"]
    rejected_src = {e["src"] for _, e in rejects if e.get("src")}
    by_gen = {}
    for c in current.values():
        for e in c["candidates"]:
            if e.get("tile_id") and e.get("src"):
                by_gen.setdefault(e["tile_id"], []).append(e["src"])
    doomed = [g for g, srcs in by_gen.items()
              if srcs and all(s in rejected_src for s in srcs)]

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
    n = tombstones.defer_tiles(srcs)
    # NOTHING IS MARKED FOR DELETION. This used to stamp a generation "rejected" once
    # every candidate from it had been rejected, and pixellab_gc --apply deletes what is
    # marked rejected. The maintainer's instruction makes that wrong in principle, not
    # just risky: a rejection here means "the wall is not good enough to be SEEN", and a
    # whole tile type is coming whose wall never is. "So instead of regenerating, we
    # might be able to reuse tiles from this set that didn't have a wall good enough."
    #
    # They also proved the value of it by hand, recovering 40 tiles from the reject pile
    # that a --apply run would have destroyed.
    print(f"deferred {n} new tile(s) from the wall-visible set; deleted nothing")
    print(f"({len(doomed)} generation(s) have no surviving candidate here — kept anyway, "
          f"they are the top-only set's raw material)")
    print("run publish.py to rebuild the review set without them")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
