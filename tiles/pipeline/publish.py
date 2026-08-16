"""Publish the best candidates per cell into tiles/review/ so they can be reviewed.

Nothing can be approved or rejected that the maintainer cannot see. The raw matrix is
gitignored — 16 tiles per sheet, several sheets per cell, thousands of files, almost
all of them rejects — so it stays local. This promotes only the top candidates of each
cell into a committed, reviewable folder, alongside a manifest the wiki can index.

Ranked on WALL quality, because the walls are what the tiles are for: they become every
cliff and mountain face, and postprocess cannot invent structure that was not
generated, whereas a flat top is free.

The manifest keys each candidate by a stable path (`tiles/<top>__over__<side>/<n>`) so
a wiki verdict maps straight back onto the sheet's tile_id — that is what lets a
rejection actually delete the generation from PixelLab instead of leaving it to rot.

  python tiles/pipeline/publish.py --top 3
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import flatness
import tombstones

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MATRIX = os.path.join(ROOT, "matrix")
REVIEW = os.path.join(ROOT, "review")


def candidates(cell_dir):
    """Every tile in a cell, scored on its wall, best first."""
    out = []
    for sheet in sorted(glob.glob(os.path.join(cell_dir, "sheet_*"))):
        mp = os.path.join(sheet, "meta.json")
        meta = json.load(open(mp)) if os.path.isfile(mp) else {}
        for p in sorted(glob.glob(os.path.join(sheet, "tile_*.png"))):
            q = flatness.wall_quality(p)
            if not q:
                continue
            f = flatness.faces(p)
            if not f or not f["top"] or f["top"]["share"] < flatness.CLEAN_TOP:
                continue      # dirty top = no-go, regardless of how good the wall is
            out.append({
                "path": p, "wall": q,
                "top_share": round(f["top"]["share"], 4) if f and f["top"] else None,
                "tile_id": meta.get("tile_id"), "style": meta.get("style"),
                "prompt": meta.get("prompt"),
            })
    out.sort(key=lambda c: -c["wall"]["score"])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=3, help="candidates published per cell")
    ap.add_argument("--clean", action="store_true", help="rebuild the review folder")
    args = ap.parse_args()

    if args.clean and os.path.isdir(REVIEW):
        shutil.rmtree(REVIEW)
    os.makedirs(REVIEW, exist_ok=True)
    dead = tombstones.load().get("cells", {})

    manifest = {"schema": "tiles3/review@1", "domain": "tiles",
                "_comment": ("Candidates awaiting the maintainer's verdict. Ranked on WALL "
                             "quality — tiling, discretion, structure. `tile_id` is the "
                             "PixelLab generation a rejection should delete; `cell` is the "
                             "X-over-Y pair. A DELETED cell is tombstoned and never "
                             "regenerated, unlike a rejected one."),
                "cells": {}}
    n_pub = 0
    for d in sorted(glob.glob(os.path.join(MATRIX, "*__over__*"))):
        cell = os.path.basename(d)
        if cell.replace("__over__", "_over_") in dead:
            continue
        cands = candidates(d)[:args.top]
        if not cands:
            continue
        top, side = cell.split("__over__")
        cd = os.path.join(REVIEW, cell)
        os.makedirs(cd, exist_ok=True)
        entries = []
        for i, c in enumerate(cands):
            dst = os.path.join(cd, f"{i}.png")
            shutil.copyfile(c["path"], dst)
            entries.append({
                "key": f"tiles/{cell}/{i}",
                "file": os.path.relpath(dst, ROOT),
                "wall_score": c["wall"]["score"],
                "wall": {k: c["wall"][k] for k in
                         ("tiling", "discretion", "structure", "contrast", "edges")},
                "top_share": c["top_share"],
                "tile_id": c["tile_id"], "style": c["style"], "prompt": c["prompt"],
            })
            n_pub += 1
        manifest["cells"][cell] = {"top": top, "side": side, "candidates": entries}

    with open(os.path.join(REVIEW, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"published {n_pub} candidates across {len(manifest['cells'])} cells "
          f"-> {os.path.relpath(REVIEW, os.path.dirname(ROOT))}/")
    for cell, c in manifest["cells"].items():
        best = c["candidates"][0]
        print(f"  {cell:32s} best wall={best['wall_score']:5.2f} [{best['style']}]")


if __name__ == "__main__":
    main()
