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
import no_invention
import palette_snap
import tombstones
import vertical

from PIL import Image

# config/palette.json is the GAME's palette, carried over from tiles2 so 3.0 reads as
# the same world. measured_palette.json is only what the generator happens to produce —
# useful evidence, never the target: taking it as one is what made 3.0 grass a bright
# yellow-green against 2.0's deep pine.
_CFG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config")
PALETTE = {k: {"top": v["top"], "wall": v.get("wall")} for k, v in
           json.load(open(os.path.join(_CFG, "palette.json")))["types"].items()}


def _save(im, path):
    """Lossless WebP. BOTH flags are non-default in Pillow and both matter: without
    `lossless` you silently get lossy VP8 and ringing on every hard pixel-art edge,
    without `exact` libwebp rewrites the RGB under fully-transparent pixels."""
    im.convert("RGBA").save(path, "WEBP", lossless=True, exact=True)

# Same number chase.py defaults --min-wall to. A dead flat cliff is not a win, and
# the two components must not disagree about the bar.
MIN_WALL = 2.0

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MATRIX = os.path.join(ROOT, "matrix")
REVIEW = os.path.join(ROOT, "review")
REPO = os.path.dirname(ROOT)


def candidates(cell_dir, side_hex=None, same=False):
    """Every tile in a cell, scored on its wall, best first.

    WALL MATERIAL is a gate here, not a score. "X over Y" is a request for two materials
    and the generator answers it with whatever pairing it finds plausible: asked for
    black rock over grass it returned small black stones over grass over LIGHT GREY
    STONE — a three-layer tile whose wall is stone, not the grass that was asked for.

    That is the whole reason wall alignment kept inventing colours. The transform was
    being handed a grey wall and a green target and told to make them agree, so it had
    to manufacture green that was nowhere in the image. No postprocess can fix this
    one: the material simply is not in the art. It is a SELECTION problem, and a cell
    with no correct-material candidate needs re-rolling, not tinting.
    """
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
            if flatness.seam_px(p) > flatness.SEAM_TOL:
                continue
            out.append({
                "path": p, "wall": q,
                "top_share": round(f["top"]["share"], 4) if f and f["top"] else None,
                "overhang": round(flatness.overhang(p), 3),
                "wall_err": round(flatness.wall_material_err(p, side_hex), 1)
                            if side_hex else None,
                "clarity": round(flatness.fringe_clarity(p), 3),
                # The band that appears when this tile is stacked on itself. Lower
                # is better; it is what decides a same-over-same tile.
                "band": (lambda b: round(b, 2) if b is not None else None)(
                    vertical.band(p)),
                "tile_id": meta.get("tile_id"), "style": meta.get("style"),
                "prompt": meta.get("prompt"),
            })
    # The maintainer's spill threshold is a GATE, not a ranking term — they went
    # through every grass cell and circled the ones whose transition was not good
    # enough, and a tile without it is the wrong tile however good its cliff. Within
    # the tiles that have it, the wall decides, because the wall builds the game.
    # ONE BAR, not two. chase.py rolls a cell until three tiles clear
    # wall>=2.0 / spill / clarity / seam, and publish then shipped whatever ranked
    # highest whether or not it cleared any of them — so check_gates found published
    # tiles at wall 0.00 and 0.06 in cells whose chase had been told 2.0 was the
    # minimum. Two components disagreeing about what "good" means is how a cell gets
    # declared done while shipping something the generator was still being paid to
    # replace. The tiers below degrade in the maintainer's own priority order, and a
    # cell that lands on a lower tier is FLAGGED rather than quietly shipped.
    #
    # X-over-X waives the spill requirement entirely, because on those cells it is the
    # maintainer's stated ANTI-goal — "it's best if 'same over same' doesn't have that
    # spill-over-effect, becouse it's that effect that make the tile hard to repeat
    # vertically" — and because flatness.overhang is degenerate there anyway (it hunts
    # the top material in the wall by hue, and on same-over-same there is no hue
    # difference to find: exactly 1.000 for every grass/ice/light_soil tile, 0.000 for
    # most grey_stone/black_rock, on saturation alone).
    spill_ok = (lambda c: True) if same else (
        lambda c: c["overhang"] >= flatness.MIN_OVERHANG)
    full = [c for c in out if spill_ok(c)
            and c["wall"]["score"] >= MIN_WALL
            and c["clarity"] >= flatness.MIN_CLARITY]
    withspill = full or [c for c in out if spill_ok(c)]
    out = withspill or out
    # X-over-X is exempt: the wall IS the top's material by construction, so the only
    # thing this could measure there is SHADE — and snap()'s same-material rule moves the
    # whole face onto the palette anyway. Left in, it called snow-over-snow's correctly
    # generated snow wall "the wrong material" because the generator shaded it bluer than
    # the palette's near-white.
    right = [c for c in out if c["wall_err"] is not None
             and c["wall_err"] <= flatness.MAX_WALL_ERR]
    if not same:
        out = right or out
    # Least-banded first on X-over-X: those tiles exist to be stacked into a cliff
    # under a "top only" tile, so the one that stacks without a stripe is the best
    # one however good another tile's wall score.
    if same:
        out.sort(key=lambda c: (c["band"] if c["band"] is not None else 1e9,
                                -c["wall"]["score"]))
    else:
        out.sort(key=lambda c: -c["wall"]["score"])
    return out, bool(withspill), same or bool(right), bool(full)


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
    invented = []
    for d in sorted(glob.glob(os.path.join(MATRIX, "*__over__*"))):
        cell = os.path.basename(d)
        if cell.replace("__over__", "_over_") in dead:
            continue
        top, side = cell.split("__over__")
        cands, has_spill, right_wall, all_gates = candidates(
            d, (PALETTE.get(side) or {}).get("top"), same=(top == side))
        cands = cands[:args.top]
        if not cands:
            continue
        cd = os.path.join(REVIEW, cell)
        os.makedirs(cd, exist_ok=True)
        entries = []
        top_hex = PALETTE.get(top, {}).get("top")
        side_hex = PALETTE.get(side, {}).get("top")
        for i, c in enumerate(cands):
            # BOTH states ship, because the maintainer judges the postprocess as well
            # as the art and cannot do that from one image. `before` is the generator's
            # output untouched; `after` is what the game gets — top snapped to the
            # shared palette colour, outline spikes clipped, WALL NOT TOUCHED.
            raw = Image.open(c["path"]).convert("RGBA")
            before = os.path.join(cd, f"{i}_before.webp")
            after = os.path.join(cd, f"{i}_after.webp")
            _save(raw, before)
            # WALL ALIGNMENT IS OFF. It is the right idea — the maintainer is correct
            # that grass under an ice tile should match grass under a grass tile — and
            # every implementation of it so far has invented colours that were not in
            # the art: a hue read off a grey drew a MAGENTA line along the grass edge,
            # a proportional saturation fix turned dull walls vivid (1413 magenta px),
            # and the version after that made ice-over-light_soil's wall RED, which is
            # what the maintainer saw. Shipping the wall exactly as generated is
            # inconsistent between cells but never wrong, and that is the better of the
            # two failures. side_hex stays measured in the palette, ready for an
            # implementation that converges dull and vivid onto one target without
            # amplifying either.
            wall_hex = (PALETTE.get(side) or {}).get("wall")
            proc = (palette_snap.snap(raw, top_hex, same_material=(top == side),
                                      wall_hex=wall_hex)
                    if top_hex else raw)
            # THE GUARD. Every three attempts at wall alignment put a colour into the
            # art that was in neither the art nor the palette, and every one was caught
            # by the maintainer by eye, in the wiki — which spends the review budget on
            # my bugs and makes starting a review conditional on the postprocess already
            # being right. So the invariant is enforced here instead: a tile whose
            # postprocess invented a visible patch of colour ships RAW and says so, and
            # the review never contains one. See no_invention.py.
            inv = (no_invention.check(raw, proc, top_hex,
                                      extra_hex=(wall_hex,) if wall_hex else ())
                   if top_hex else {})
            if inv.get("blob", 0) > no_invention.MAX_BLOB:
                invented.append((f"tiles/{cell}/{i}", inv))
                proc = raw
            _save(proc, after)
            entries.append({
                "postprocess": "raw (guard: invented colour)" if inv.get(
                    "blob", 0) > no_invention.MAX_BLOB else "palette",
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
                "wall_err": c["wall_err"], "clarity": c["clarity"],
                "band": c["band"],
                "tile_id": c["tile_id"], "style": c["style"], "prompt": c["prompt"],
            })
            n_pub += 1
        manifest["cells"][cell] = {"top": top, "side": side, "candidates": entries,
                                   "needs_regeneration": not has_spill,
                                   # The wall is not the material this cell asked for —
                                   # broken ART, not broken postprocess. Flagged so a
                                   # review can skip it rather than diagnose it.
                                   "wrong_wall_material": not right_wall,
                                   # No candidate clears every gate chase was told
                                   # to hit. The cell ships its best available and
                                   # stays on the worklist.
                                   "below_bar": not all_gates}

    with open(os.path.join(REVIEW, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"published {n_pub} candidates across {len(manifest['cells'])} cells "
          f"-> {os.path.relpath(REVIEW, os.path.dirname(ROOT))}/")
    for cell, c in manifest["cells"].items():
        best = c["candidates"][0]
        flag = "  NEEDS REGEN (no transition in this cell)" if c["needs_regeneration"] else ""
        if c["below_bar"]:
            flag += "  BELOW BAR"
        if c["wrong_wall_material"]:
            flag += f"  WRONG WALL MATERIAL (off by {best['wall_err']:.0f})"
        print(f"  {cell:32s} wall={best['wall_score']:5.2f} spill={best['overhang']:.2f}"
              f" [{best['style']}]{flag}")
    wrong = [k for k, c in manifest["cells"].items() if c["wrong_wall_material"]]
    if wrong:
        print(f"\n{len(wrong)} cell(s) have no candidate whose wall is the material "
              f"asked for — these need re-rolling, not postprocessing:")
        for k in wrong:
            print(f"   {k:40s} off by {manifest['cells'][k]['candidates'][0]['wall_err']:.0f}")
    if invented:
        print(f"\nGUARD: {len(invented)} tile(s) shipped RAW — postprocess invented a colour")
        for key, inv in invented[:10]:
            s = inv.get("sample") or {}
            print(f"   {key:40s} blob {inv['blob']:5d} px  {s.get('from')} -> {s.get('to')}")
    else:
        print("\nGUARD: no invented colours — every published tile is the art's own "
              "colours plus the palette's.")


if __name__ == "__main__":
    main()
