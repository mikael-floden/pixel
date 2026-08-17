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
import palette_snap
import tombstones

from PIL import Image

# config/palette.json is the GAME's palette, carried over from tiles2 so 3.0 reads as
# the same world. measured_palette.json is only what the generator happens to produce —
# useful evidence, never the target: taking it as one is what made 3.0 grass a bright
# yellow-green against 2.0's deep pine.
_CFG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config")
PALETTE = {k: {"top": v["top"]} for k, v in
           json.load(open(os.path.join(_CFG, "palette.json")))["types"].items()}


def _save(im, path):
    """Lossless WebP. BOTH flags are non-default in Pillow and both matter: without
    `lossless` you silently get lossy VP8 and ringing on every hard pixel-art edge,
    without `exact` libwebp rewrites the RGB under fully-transparent pixels."""
    im.convert("RGBA").save(path, "WEBP", lossless=True, exact=True)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MATRIX = os.path.join(ROOT, "matrix")
REVIEW = os.path.join(ROOT, "review")
REPO = os.path.dirname(ROOT)


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
            if not f or not f["top"]:
                continue
            # Gate on whether the SHIPPED tile tiles cleanly, not on whether the
            # generator happened to draw a flat top. palette_snap overwrites the top
            # regardless, so a raw-flatness gate only throws away good art — measured,
            # 182 of the 238 tiles it rejected were already seamless after postprocess,
            # several of them with the best edge spill in the whole set.
            if flatness.seam_px(p) > 0:
                continue
            out.append({
                "path": p, "wall": q,
                "top_share": round(f["top"]["share"], 4) if f and f["top"] else None,
                "overhang": round(flatness.overhang(p), 3),
                "tile_id": meta.get("tile_id"), "style": meta.get("style"),
                "prompt": meta.get("prompt"),
            })
    # The maintainer's spill threshold is a GATE, not a ranking term — they went
    # through every grass cell and circled the ones whose transition was not good
    # enough, and a tile without it is the wrong tile however good its cliff. Within
    # the tiles that have it, the wall decides, because the wall builds the game.
    withspill = [c for c in out if c["overhang"] >= flatness.MIN_OVERHANG]
    out = withspill or out
    out.sort(key=lambda c: -c["wall"]["score"])
    return out, bool(withspill)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=3, help="candidates published per cell")
    ap.add_argument("--clean", action="store_true", help="rebuild the review folder")
    args = ap.parse_args()

    if args.clean and os.path.isdir(REVIEW):
        shutil.rmtree(REVIEW)
    os.makedirs(REVIEW, exist_ok=True)
    dead = tombstones.load().get("cells", {})

    manifest = {"schema": "tiles3/review@2", "domain": "tiles",
                "_comment": ("Candidates awaiting the maintainer's verdict. Each carries "
                             "BEFORE (raw generator output) and AFTER (what ships) so the "
                             "wiki can show the postprocess itself, not just its result. "
                             "Ranked on WALL "
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
        cands, has_spill = candidates(d)
        cands = cands[:args.top]
        if not cands:
            continue
        top, side = cell.split("__over__")
        cd = os.path.join(REVIEW, cell)
        os.makedirs(cd, exist_ok=True)
        entries = []
        top_hex = PALETTE.get(top, {}).get("top")
        for i, c in enumerate(cands):
            # BOTH states ship, because the maintainer judges the postprocess as well
            # as the art and cannot do that from one image. `before` is the generator's
            # output untouched; `after` is what the game gets — top snapped to the
            # shared palette colour, outline spikes clipped, WALL NOT TOUCHED.
            raw = Image.open(c["path"]).convert("RGBA")
            before = os.path.join(cd, f"{i}_before.webp")
            after = os.path.join(cd, f"{i}_after.webp")
            _save(raw, before)
            _save(palette_snap.snap(raw, top_hex) if top_hex else raw, after)
            entries.append({
                "key": f"tiles/{cell}/{i}",
                # REPO-relative, matching how the wiki addresses every other
                # domain's art (tiles2/<type>/base/...). Tiles-relative paths would
                # resolve only for code that already knows this domain's root.
                "before": os.path.relpath(before, REPO),
                "after": os.path.relpath(after, REPO),
                # `file` kept pointing at `after` so anything written against
                # tiles3/review@1 keeps resolving to the shipped image.
                "file": os.path.relpath(after, REPO),
                "palette_top": top_hex,
                "wall_score": c["wall"]["score"],
                "wall": {k: c["wall"][k] for k in
                         ("tiling", "discretion", "structure", "contrast", "edges")},
                "top_share": c["top_share"], "overhang": c["overhang"],
                "tile_id": c["tile_id"], "style": c["style"], "prompt": c["prompt"],
            })
            n_pub += 1
        manifest["cells"][cell] = {"top": top, "side": side, "candidates": entries,
                                   "needs_regeneration": not has_spill}

    with open(os.path.join(REVIEW, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"published {n_pub} candidates across {len(manifest['cells'])} cells "
          f"-> {os.path.relpath(REVIEW, os.path.dirname(ROOT))}/")
    for cell, c in manifest["cells"].items():
        best = c["candidates"][0]
        flag = "  NEEDS REGEN (no transition in this cell)" if c["needs_regeneration"] else ""
        print(f"  {cell:32s} wall={best['wall_score']:5.2f} spill={best['overhang']:.2f}"
              f" [{best['style']}]{flag}")


if __name__ == "__main__":
    main()
