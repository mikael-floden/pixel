#!/usr/bin/env python3
"""Remove x-over-y candidates the maintainer rejected on EVERY face, from the manifest
and from git (maintainer 2026-09-11: "remove tiles I have rejected everywhere and is not
good enough for anything and never referenced").

A candidate goes when every face he voted on (#top, #wall) is rejected and none is
approved, AND nothing draws it. "The wall might still have been accepted" is literal:
a rejected top whose WALL is a chosen donor in live/tuning/top_walls.json stays, because
the game draws that wall under other tiles. Base-set members (base_tile_sets.json,
resolve.json), plate-pool members and games2 fixtures stay likewise and are reported.
tile_walls.json `top_only` is the wall's own rejection, not a use - it never keeps.

What goes: the manifest entry, before/after/textured art (every hashed generation), and
the source is deferred in tombstones.json so publish.py can never bring it back. A cell
left with no candidate is flagged needs_regeneration. publish.py is NOT run - the raw
matrix is container-local and a republish would re-hash art his base sets point at.

    python3 tiles/pipeline/review_prune.py [--cell black_rock__over__]   # dry run
    python3 tiles/pipeline/review_prune.py --apply [--cell ...]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tombstones  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
MANIFEST = os.path.join(ROOT, "review", "manifest.json")
FEEDBACK = os.path.join(REPO, "live", "feedback", "tiles.json")


def _load(p, default=None):
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def references():
    """name -> text, for files whose mention of a key or path means something draws it."""
    files = {
        "base_tile_sets": os.path.join(REPO, "live", "tuning", "base_tile_sets.json"),
        "resolve": os.path.join(ROOT, "resolve.json"),
        "plates_index": os.path.join(ROOT, "plates", "index.json"),
        "hard_cells": os.path.join(ROOT, "hard_cells.json"),
        # THE GROUND'S PROMOTED BASE TILE (ground_types.json base_tiles) is HIS pick
        # for what a whole field of that ground reads as - the strongest keep there is.
        # Measured 2026-09-12: his brown_paving_stone review rejected every candidate in
        # brown_paving_stone__over__brown_paving_stone, including the one his own ground
        # type promotes, and without this the paving would have lost its base tile AND
        # the ground's only x-over-x wall source in one pass.
        "ground_types": os.path.join(ROOT, "ground_types.json"),
    }
    for p in sorted(glob.glob(os.path.join(REPO, "games2", "server", "test", "fixtures", "*.json"))):
        files["games2 fixture " + os.path.basename(p)] = p
    out = {n: open(p, errors="ignore").read() for n, p in files.items() if os.path.isfile(p)}
    # top_walls: only the DONOR side (value.wall) is a use of the tile
    donors = {v.get("wall") for v in (_load(os.path.join(REPO, "live", "tuning", "top_walls.json"), {}).get("overrides") or {}).values()
              if isinstance(v, dict)}
    out["top_walls (wall donor)"] = "\n".join(d for d in donors if d)
    return out


def live_statuses(fb, key):
    """The statuses that still stand for a candidate: its #top and #wall faces, plus the
    bare-key verdict from before faces existed (2026-08-21, one verdict per tile) ONLY
    while no faced verdict is newer than it. Every candidate carries that legacy
    approval; reading it beside a later #top rejection would keep every rejected tile."""
    faced = {f: fb.get(f"{key}#{f}") for f in ("top", "wall")}
    faced = {f: v for f, v in faced.items() if isinstance(v, dict) and v.get("status")}
    sts = {v["status"] for v in faced.values()}
    bare = fb.get(key)
    if isinstance(bare, dict) and bare.get("status"):
        newest = max((v.get("updated_at") or "" for v in faced.values()), default="")
        if (bare.get("updated_at") or "") > newest:
            sts.add(bare["status"])
    return sts


def plan(prefix=None):
    man = _load(MANIFEST)
    fb = _load(FEEDBACK, {}).get("entries") or {}
    refs = references()
    drop, keep = [], []
    for cell, c in man["cells"].items():
        if prefix and not cell.startswith(prefix):
            continue
        for e in c["candidates"]:
            sts = live_statuses(fb, e["key"])
            if "rejected" not in sts or "approved" in sts:
                continue
            named = [e["key"]] + [e[f] for f in ("before", "after", "textured") if e.get(f)]
            hit = sorted(n for n, t in refs.items() if any(s in t for s in named))
            (keep if hit else drop).append((cell, e, hit))
    return man, drop, keep


def apply(man, drop):
    dropped = {e["key"] for _, e, _ in drop}
    paths = []
    for cell, e, _ in drop:
        for f in ("before", "after", "file"):
            if e.get(f):
                paths.append(os.path.join(REPO, e[f]))
        if e.get("textured"):
            stem = os.path.basename(e["textured"]).split("_textured")[0]
            paths += glob.glob(os.path.join(REPO, os.path.dirname(e["textured"]), f"{stem}_textured.*.webp"))
        man["cells"][cell]["candidates"] = [x for x in man["cells"][cell]["candidates"] if x["key"] not in dropped]
        if not man["cells"][cell]["candidates"]:
            man["cells"][cell]["needs_regeneration"] = True
    for k in list((man.get("tile_states") or {}).keys()):
        if k in dropped:
            del man["tile_states"][k]
    # defer the SOURCE only when no surviving candidate (any cell - paving twins share
    # art) still comes from it; publish.py releases wrongly deferred approved sources,
    # but never deferring them is cleaner than relying on that
    survivors = {x.get("src") for c in man["cells"].values() for x in c["candidates"]}
    srcs = sorted({e["src"] for _, e, _ in drop if e.get("src") and e["src"] not in survivors})
    n_def = tombstones.defer_tiles(srcs, reason="rejected on every face in review", from_set="review")
    with open(MANIFEST + ".tmp", "w") as f:
        json.dump(man, f, indent=1)
        f.write("\n")
    os.replace(MANIFEST + ".tmp", MANIFEST)
    existing = sorted({p for p in paths if os.path.isfile(p)})
    if existing:
        spec = os.path.join(ROOT, "review", f"rm.{os.getpid()}.txt")
        with open(spec, "w") as f:
            f.write("\n".join(os.path.relpath(p, REPO) for p in existing) + "\n")
        subprocess.run(["git", "rm", "-q", "--pathspec-from-file", spec], cwd=REPO, check=True)
        os.remove(spec)
    return len(existing), n_def


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--cell", help="cell name prefix, e.g. black_rock__over__")
    a = ap.parse_args()
    man, drop, keep = plan(a.cell)
    cells = {}
    for cell, _, _ in drop:
        cells[cell] = cells.get(cell, 0) + 1
    print(f"rejected everywhere: {len(drop)} candidates to remove, {len(keep)} kept because something draws them")
    for cell, n in sorted(cells.items()):
        left = len(man["cells"][cell]["candidates"]) - n
        print(f"   {cell:42s} -{n:3d}  -> {left} left{'  (EMPTY: needs_regeneration)' if left == 0 else ''}")
    by = {}
    for cell, e, hit in keep:
        by.setdefault(", ".join(hit), []).append(e["key"])
    for why, keys in sorted(by.items()):
        print(f"   KEEP {len(keys):3d} <- {why}")
        for k in keys:
            print(f"        {k}")
    if not a.apply:
        print("(dry run - pass --apply)")
        return 0
    n, n_def = apply(man, drop)
    print(f"git rm {n} file(s); manifest updated; {n_def} source(s) deferred in tombstones.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
