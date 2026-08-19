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
import hashlib
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

# Same number chase.py defaults --min-wall to; the two components must not disagree.
#
# LOWERED FROM 2.0, because it was not earning its cost. The gate exists for a real
# reason — gating on spill alone once shipped a cell at wall 0.00, a dead flat cardboard
# cliff — but 2.0 was a guess, and measured against the maintainer's own 309 verdicts the
# wall score does not predict their judgement AT ALL: tiles they rejected score a median
# 3.92, tiles they kept 4.26, point-biserial r = -0.058. It was rejecting HALF of every
# sheet on a number unrelated to whether the tile is any good, and it left 15 of 16 stuck
# cells unable to reach three candidates.
#
# At 1.0 six of those sixteen fill up with art already on disk. The maintainer's own
# framing settles where to land: "It's ok you pass through some error to me. Your filter
# just have to be good enough to not give me obvious crap." A dead flat wall is obvious
# crap; a wall scoring 1.4 is a judgement call, and the judgement is theirs.
#
# Wall score remains the RANKING term, which is where a metric with no threshold belongs.
MIN_WALL = 1.0

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MATRIX = os.path.join(ROOT, "matrix")
REVIEW = os.path.join(ROOT, "review")
REPO = os.path.dirname(ROOT)


def candidates(cell_dir, side_hex=None, same=False, rejected=(), top_hex_c=None,
               approved=()):
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
            # A tile the maintainer has already rejected never comes back. Publishing
            # it again asks for the same verdict twice, and their review time is the
            # scarcest thing in this pipeline.
            rel = os.path.relpath(p, REPO)
            if rel in rejected:
                continue
            # THE MAINTAINER OVERRULED THE FILTER ON THIS TILE. It publishes whatever the
            # gates think, and it sorts first, because they picked it out by hand from
            # the reject pile.
            forced = rel in approved
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
            if not forced and flatness.seam_px(p) > flatness.SEAM_TOL:
                continue
            out.append({
                "path": p, "wall": q, "forced": forced,
                "top_share": round(f["top"]["share"], 4) if f and f["top"] else None,
                "overhang": round(flatness.overhang(p), 3),
                "wall_err": round(flatness.wall_material_err(p, side_hex), 1)
                            if side_hex else None,
                "clarity": round(flatness.fringe_clarity(p), 3),
                # Positive = the top reads as the SIDE material, i.e. backwards.
                "swapped": round(flatness.swapped_err(p, top_hex_c, side_hex), 1)
                           if (top_hex_c and side_hex) else None,
                "top_err": round(flatness.top_material_err(p, top_hex_c), 1)
                           if top_hex_c else None,
                "contamination": round(flatness.top_contamination(
                    p, top_hex_c, side_hex), 3) if (top_hex_c and side_hex) else None,
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
    # OVERRIDES ARE ADDED, NOT SUBSTITUTED. Making a forced tile satisfy each tier looked
    # equivalent and was not: the chain takes the FIRST NON-EMPTY tier, so a single
    # override made the strictest tier non-empty and the cell shipped that one tile
    # instead of falling through to a laxer tier holding three. Cells with three
    # candidates fell 173 -> 166 the moment the maintainer's picks were honoured, which
    # is the opposite of what an override is for.
    forced = [c for c in out if c.get("forced")]
    out = [c for c in out if not c.get("forced")]
    keep = lambda c: False
    spill_ok = (lambda c: True) if (same or flatness.indistinguishable(top_hex_c, side_hex)) \
        else (lambda c: c["overhang"] >= flatness.MIN_OVERHANG or keep(c))
    full = [c for c in out if keep(c) or (spill_ok(c)
            and c["wall"]["score"] >= MIN_WALL
            and c["clarity"] >= flatness.MIN_CLARITY)]
    withspill = full or [c for c in out if spill_ok(c)]
    out = withspill or out
    # X-over-X is exempt: the wall IS the top's material by construction, so the only
    # thing this could measure there is SHADE — and snap()'s same-material rule moves the
    # whole face onto the palette anyway. Left in, it called snow-over-snow's correctly
    # generated snow wall "the wrong material" because the generator shaded it bluer than
    # the palette's near-white.
    right = [c for c in out if keep(c) or (c["wall_err"] is not None
             and c["wall_err"] <= flatness.MAX_WALL_ERR)]
    if not same:
        out = right or out
        # And the tile must not be BACKWARDS. Same tier discipline as the wall material:
        # a cell with a correctly-oriented candidate never ships a reversed one, and a
        # cell with nothing but reversed ones is flagged rather than quietly shipped.
        fwd = [c for c in out if keep(c) or (c["swapped"] is not None
               and c["swapped"] <= flatness.MAX_SWAP)]
        out = fwd or out
        # And the surface should actually BE the material, not mostly it. "not enough
        # lava on the ground" was 14 of the 24 verdicts in one review pass.
        clean = [c for c in out if keep(c) or (c["contamination"] is not None
                 and c["contamination"] <= flatness.MAX_CONTAMINATION)]
        out = clean or out
    # The maintainer's own picks go back in at the front, whatever the tiers concluded.
    seen = {id(c) for c in out}
    out = forced + [c for c in out if id(c) not in {id(f) for f in forced}]
    # Least-banded first on X-over-X: those tiles exist to be stacked into a cliff
    # under a "top only" tile, so the one that stacks without a stripe is the best
    # one however good another tile's wall score.
    if same:
        out.sort(key=lambda c: (c["band"] if c["band"] is not None else 1e9,
                                -c["wall"]["score"]))
    else:
        out.sort(key=lambda c: (not c.get("forced", False), -c["wall"]["score"]))

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
    rejected = tombstones.rejected_tiles()
    approved = tombstones.approved_tiles()
    if approved:
        print(f"honouring {len(approved)} maintainer override(s)")
    if rejected:
        print(f"skipping {len(rejected)} individually rejected tile(s)")

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
        # top_hex_c and `rejected` were BOTH being dropped here. Without top_hex_c the
        # swapped/contamination/top_err fields are None for every tile, which makes the
        # `fwd or out` and `clean or out` tiers unreachable — the swapped-material gate
        # built from the maintainer's own 22 "this looks like Y over X" verdicts, and the
        # contamination tier built from their 14 "not enough lava on the ground", had
        # never once fired. Both were reported as working on the strength of a manifest
        # field that was silently null.
        cands, has_spill, right_wall, all_gates = candidates(
            d, (PALETTE.get(side) or {}).get("top"), same=(top == side),
            rejected=rejected, top_hex_c=(PALETTE.get(top) or {}).get("top"),
            approved=approved)
        # EVERY OVERRIDE PUBLISHES. --top caps how many the ranking contributes, but the
        # maintainer picked these out of the reject pile by hand and truncating their
        # choices is not the cap's job — four approvals landed in grey_stone-over-lava
        # and the fourth was silently dropped.
        picks = [c for c in cands if c.get("forced")]
        rest = [c for c in cands if not c.get("forced")]
        cands = picks + rest[:max(0, args.top - len(picks))]
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
            # ALIGN THE SIDE WALL ONLY WHEN IT IS REALLY THAT MATERIAL. The maintainer
            # put grass-over-grass under ice-over-grass with the wiki's "top only"
            # control and asked why the two grasses do not match: because only the
            # same-over-same wall was ever substituted onto the palette, and the grass
            # under ice kept whatever green the generator drew.
            #
            # The gate is what makes this safe rather than a fourth attempt at the bug
            # that produced magenta, vivid and red walls. Those all tried to align a
            # wall that was NOT the requested material — a three-layer tile's grey
            # stone toward green — so the transform had to manufacture colour. A cell
            # over MAX_WALL_ERR is left exactly as generated and flagged instead.
            aligned = (c["wall_err"] is not None
                       and c["wall_err"] <= flatness.MAX_WALL_ERR)
            proc = (palette_snap.snap(raw, top_hex, same_material=(top == side),
                                      wall_hex=wall_hex,
                                      side_hex=wall_hex, align_side=aligned)
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
                "wall_aligned": bool(aligned),
                "postprocess": "raw (guard: invented colour)" if inv.get(
                    "blob", 0) > no_invention.MAX_BLOB else "palette",
                # STABLE PER TILE, not per rank. The key used to be the candidate's
                # POSITION — tiles/<cell>/0 — and a position is not an identity. When a
                # rejected tile was un-published the next tile slid into slot 0 and
                # inherited the maintainer's rejection and their comment: 126 rejected
                # keys were still present in the manifest, attached to art they had
                # never seen. "I don't want old dangling tiles in the wiki I have
                # removed" — they were not dangling, they were being re-pointed.
                #
                # The same defect had already corrupted two verdicts at apply time,
                # because a republish mid-review re-ranked a cell and moved the tile a
                # verdict named. Deriving the key from the SOURCE TILE fixes both ends:
                # a verdict names one specific piece of art forever, and when that art
                # is removed its key disappears rather than being reassigned.
                "key": f"tiles/{cell}/{hashlib.sha1(os.path.relpath(c['path'], REPO).encode()).hexdigest()[:8]}",
                # Kept so anything that wants display order still has it.
                "rank": i,
                # The RAW tile this candidate came from. Without it a wiki verdict can
                # only be resolved to a cell, and resolving a per-tile rejection to a
                # cell is how a single "no" would have marked every generation in that
                # cell rejected — including sheets holding good art the GC would then
                # have deleted from PixelLab.
                "src": os.path.relpath(c["path"], REPO),
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
                # These three were computed and used for tiering but never written out,
                # so the manifest reported None and the gates looked dead when they were
                # merely invisible. A metric the reviewer cannot see is a metric they
                # cannot disagree with.
                "swapped": c["swapped"], "contamination": c["contamination"],
                "top_err": c["top_err"], "maintainer_pick": c.get("forced", False),
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
