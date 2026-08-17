"""Keep generating a cell until it actually produces the transition we want.

Why this exists
---------------
The maintainer's correction, and it is the important lesson of this whole domain:

    "You try to generate a prompt and think it doesn't work if the graphics comes out
     in a way you didn't want. When I tried to generate this I generated 10x to find
     something that worked. It might take time and you might have to generate over and
     over again to get what you want."

matrix.py generates a FIXED two sheets per cell and moves on. That is a survey, not an
attempt: it tells you what a cell looks like on the first try, and a first try is
mostly rejects. Eleven of thirty-four cells came out of it with no tile whose grass
tufts over the edge, and I reported them as impossible. They are not impossible — they
are un-retried.

So this chases a TARGET instead of a budget. It keeps rolling a cell until a tile comes
back that passes every gate the maintainer has actually calibrated, and only gives up
after `--attempts` rolls. Every roll varies the seed AND the wording, because rolling
the same prompt with a new seed explores much less than changing how the thing is
asked; the phrasings below all push the one property that separates a ten-star tile
from a flat one — the top material growing down over the edge rather than stopping at
it.

The bar (all of them, or the roll does not count):
  * seam_px == 0            the tile tessellates cleanly once postprocessed
  * overhang >= MIN_OVERHANG the transition the maintainer circled cells for missing
  * wall score >= --min-wall a dead flat cliff is not a win; gating on spill alone
                             already shipped one cell at wall 0.00

Resumable and cheap to stop: state lives in the filesystem exactly as matrix.py's does,
every sheet is kept (it is paid for either way, and a "failed" sheet still holds 16
tiles that the next gate change might accept), and every tile_id is registered so
pixellab_gc can clean up whatever is never used.

  python tiles/pipeline/chase.py --dry-run
  python tiles/pipeline/chase.py --attempts 10 --max-usd 20
  python tiles/pipeline/chase.py --cells grass__over__ice grass__over__water
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import flatness
import matrix
import pixellab_gc
import tombstones
import vertical
from pixellab_client import BudgetExhausted, PixelLabClient, PixelLabError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "matrix")

# Ten ways to ask for the same thing. Rolling one prompt with ten seeds explores the
# generator's variance; rolling ten phrasings explores its interpretation, which is the
# axis that actually decides whether the grass grows over the lip or stops at it. Each
# formats with {top_material} {side_material} {top_word} {side_word}.
PHRASINGS = [
    "isometric ground tile. {top_material} on top of {side_material}. The {top_word} "
    "grows over the edge and tufts down over the {side_word} below, so the two meet "
    "naturally with no hard line between them. The {side_word} side walls show their "
    "own surface detail. Seen from above, the {top_word} surface is even and uniform. "
    "No outline.",

    "isometric terrain block of {side_material} with {top_material} growing on top. "
    "The {top_word} spills over the rim and hangs down the {side_word} face in an "
    "uneven fringe. Flat even {top_word} seen from above. No outline.",

    "isometric tile: a layer of {top_material} covering a block of {side_material}. "
    "Ragged {top_word} edge overhanging the {side_word} cliff, individual strands "
    "breaking the line. Smooth uniform {top_word} on the top face. No outline.",

    "top-down isometric ground block. Thick {top_material} carpet over exposed "
    "{side_material}. Where the two meet the {top_word} droops over the edge instead "
    "of being cut off. Even {top_word} surface, detailed {side_word} sides. No outline.",

    "isometric cube of {side_material} capped with {top_material}. The cap overhangs "
    "slightly, {top_word} draping down onto the {side_word} beneath it. Uniform flat "
    "{top_word} top. No outline.",

    "isometric ground tile, {top_material} over {side_material}, photographed from "
    "above. Soft irregular boundary where {top_word} meets {side_word} — the {top_word} "
    "creeps down over the {side_word}. Plain even {top_word} surface. No outline.",

    "isometric terrain tile. Top face: smooth unbroken {top_material}. Sides: "
    "{side_material} with visible texture. Between them the {top_word} overgrows the "
    "edge, hanging down in a broken fringe rather than a straight cut. No outline.",

    "a block of {side_material} with {top_material} established across the top and "
    "spilling over every edge. Isometric view. The {top_word} surface itself is calm "
    "and uniform; only the rim is ragged. No outline.",

    "isometric game tile of {top_material} growing over {side_material}. Overgrown "
    "edges, {top_word} cascading down the {side_word} walls. Flat clean {top_word} on "
    "top. No outline.",

    "isometric ground tile where {top_material} has taken over a {side_material} block. "
    "The {top_word} rolls over the lip and trails down the sides. Top surface smooth "
    "and one even tone. No outline.",
]


# Nine ways to ask for the OPPOSITE thing, for the 14 same-over-same cells. Every
# phrasing above pushes the top material down over the edge; these push a single
# material with nothing hanging over it, because that lip is what puts a stripe at every
# storey when the tile is stacked to build a cliff.
#
# The framing is not a guess. Grouping all 4,897 raw tiles by the prompt that produced
# them, the one existing phrasing with NO spill language — `explicit` — already wins
# every axis that matters here: lip 0.059 against 0.154-0.228 for the chase phrasings,
# vertical seam 0.208 against 0.451-0.757, wall score 3.52 against 1.86-2.56. Measured
# within a single cell (snow-over-snow, the only one carrying both families) the no-spill
# sheets halve the band: cap 24.4 against 49.9. These extend that framing rather than
# inventing one, and they deliberately probe different metaphors — a block, a quarry
# face, a cut section, a cliff, an extrusion — because the maintainer's own method is to
# roll many interpretations, not many seeds.
#
# Format with the same four keys as PHRASINGS so the .format() call is unchanged; none
# uses {side_material} or {side_word}, since on these cells the side IS the top.
PHRASINGS_SAME = [
    "isometric ground tile cut from a single block of {top_material}. The flat top "
    "surface is clean single colour {top_word}, completely smooth with no texture. The "
    "vertical side walls are the same {top_material} seen from the side, with its "
    "natural surface detail clearly visible all the way down. The top edge is a clean "
    "straight line and nothing hangs over it. Top perfectly flat, walls textured. "
    "No outline.",

    "a solid block of {top_material}. Isometric view. One material all the way through: "
    "flat even {top_word} on top, the same {top_word} continuing straight down the "
    "vertical sides. No rim, no lip, no cap, no shadow band — the sides are simply the "
    "inside of the block. No outline.",

    "isometric tile cut from a {top_material} quarry. The top is the quarry floor, flat "
    "and even. The sides are freshly cut {top_word} faces, sheer and vertical, showing "
    "the material's own grain and tool marks evenly from top to bottom. The cut edge "
    "along the top is sharp and straight. No outline.",

    "isometric cross-section through {top_material}. The top face is the exposed "
    "surface, flat and one even tone; the sides are the same {top_material} sliced "
    "open, so the wall is the inside of what you see on top. Continuous material, no "
    "seam, no band and no colour change where the top meets the sides. No outline.",

    "isometric tile of a sheer {top_material} cliff. Flat {top_word} plateau on top, "
    "dropping straight down into a tall vertical {top_word} cliff face with even "
    "texture over its whole height. Nothing overhangs the brink; the plateau ends "
    "exactly at the edge. No outline.",

    # The one that names the actual requirement: these tiles exist to be stacked.
    "one repeating segment of a tall {top_material} wall, isometric. The {top_word} "
    "texture leaves the bottom edge exactly as it enters the top edge, so many copies "
    "stack into one continuous wall with no line where they join. Flat even {top_word} "
    "on the top face. No outline.",

    "isometric ground tile: a flat {top_material} surface extruded downwards. The top "
    "face is smooth uniform {top_word}; the vertical faces are that same {top_word} "
    "extruded, evenly textured over their whole height. The boundary between top and "
    "side is a single clean edge — no fringe, no darker band, no shading strip. "
    "No outline.",

    "isometric block of {top_material}. Flat plain {top_word} on top. The side walls "
    "are {top_word} whose grain, cracks and shading run VERTICALLY down the face, "
    "unbroken from the top edge to the bottom edge — no horizontal layers, no ledge, "
    "no shelf, no band. No outline.",

    "clean single color {top_material} to clean {top_material}. Solid {top_word} block, "
    "flat top, plain {top_word} sides, no outline.",
]


def phrasings_for(cell):
    top, side = cell.split("__over__")
    return PHRASINGS_SAME if top == side else PHRASINGS


def cell_parts(cell, types):
    top, side = cell.split("__over__")
    by_id = {t["id"]: t for t in types}
    return by_id.get(top), by_id.get(side)


def passing(paths, min_wall, min_clarity=0.0, same=False):
    """EVERY tile in these paths that clears the calibrated gates, best wall first.

    `same` inverts the target, because the maintainer's requirement for the 14
    same-over-same cells is the opposite of every other cell's: "it's best if 'same over
    same' doesn't have that spill-over-effect, becouse it's that effect that make the
    tile hard to repeat vertically". Those cells build the wall under a "top only" tile,
    so they must stack level on level without a stripe at every storey.

    MIN_OVERHANG is therefore not inverted, it is WAIVED — inverting it would be just as
    wrong, because the metric is degenerate on same-material tiles: it finds the top
    material in the wall by hue, and there is no hue difference to find. It returns
    exactly 1.000 for every grass/ice/light_soil tile and 0.000 for most
    grey_stone/black_rock, on saturation alone. vertical.band measures the band that
    actually appears when the tile is stacked, and is used to ORDER the survivors rather
    than to gate them, since six cells is not enough to fit a threshold on and the
    maintainer wants alternatives to choose between.

    Plural on purpose. This used to return only the winner, because a cell needed one
    good tile. It needs three: the maintainer reviews by choosing, and told me so —
    "when I review I will try to pick the one I like the most, and with more
    alternatives we will get a better looking game. I don't want to approve something
    if we can get something even better." A chase that stops at the first hit hands
    them a cell with nothing to choose between.
    """
    out = []
    for p in paths:
        q = flatness.wall_quality(p)
        if not q or q["score"] < min_wall:
            continue
        if not same and flatness.overhang(p) < flatness.MIN_OVERHANG:
            continue
        # A spill that cannot be told apart from the wall it lands on is not usable:
        # postprocess has nothing to select, so it ships in the wrong palette.
        if flatness.fringe_clarity(p) < min_clarity:
            continue
        if flatness.seam_px(p) > flatness.SEAM_TOL:
            continue
        out.append((p, q["score"], flatness.overhang(p)))
    if same:
        # Least-banded first: these tiles exist to be stacked, so the tile that stacks
        # without a stripe is the best one however good another tile's cliff is.
        b = {t[0]: (vertical.band(t[0]) if vertical.band(t[0]) is not None else 1e9)
             for t in out}
        out.sort(key=lambda t: (b[t[0]], -t[1]))
    else:
        out.sort(key=lambda t: -t[1])
    return out


def evaluate(paths, min_wall, min_clarity=0.0):
    """Best single tile, or None. Kept for callers that only want the winner."""
    hits = passing(paths, min_wall, min_clarity)
    return hits[0] if hits else None


def cell_passing(cell, min_wall, min_clarity=0.0):
    d = os.path.join(OUT, cell)
    top, side = cell.split("__over__")
    return passing(sorted(glob.glob(os.path.join(d, "sheet_*", "tile_*.png"))),
                   min_wall, min_clarity, same=(top == side))


def cell_status(cell, min_wall, min_clarity=0.0):
    hits = cell_passing(cell, min_wall, min_clarity)
    return hits[0] if hits else None


def failing_cells(min_wall, min_clarity=0.0, need=1):
    """Cells that do not yet have `need` tiles clearing the bar — including cells that
    have never been generated at all, which the directory scan alone cannot see."""
    out = []
    have = {os.path.basename(d) for d in glob.glob(os.path.join(OUT, "*__over__*"))}
    ids = [t["id"] for t in matrix.cfg()["ground_types"]]
    for cell in [f"{a}__over__{b}" for a in ids for b in ids]:
        if cell not in have or len(cell_passing(cell, min_wall, min_clarity)) < need:
            out.append(cell)
    return out


def chase(client, cell, top_g, side_g, attempts, min_wall, spent, max_usd, min_clarity=0.0,
          need=1):
    """Roll this cell until `need` tiles clear the bar, or until `attempts` is used up."""
    d = os.path.join(OUT, cell)
    os.makedirs(d, exist_ok=True)
    # Check BEFORE rolling, not after. Without this a re-run — or a second worker whose
    # cell list overlaps this one's — pays for a sheet before discovering the cell was
    # already satisfied, which at $0.096 a sheet is the whole reason to run workers in
    # parallel in the first place. Makes the chase idempotent and lets concurrent
    # workers share a worklist safely.
    done = cell_passing(cell, min_wall, min_clarity)
    if len(done) >= need:
        print(f"    already has {len(done)}/{need} passing — skipping", flush=True)
        return done[0]
    existing = len([x for x in os.listdir(d) if x.startswith("sheet_")])
    for n in range(attempts):
        if spent[0] >= max_usd:
            print(f"    budget reached (~${spent[0]:.2f})")
            return None
        i = existing + n
        ph = phrasings_for(cell)
        prompt = ph[i % len(ph)].format(
            top_material=top_g["material_words"], side_material=side_g["material_words"],
            top_word=top_g["id"].replace("_", " "), side_word=side_g["id"].replace("_", " "))
        # The suffix carries the PID because two chases can legitimately target the same
        # cell — a bulk row run and a targeted fix — and both compute their sheet index
        # from the directory listing when the cell STARTS. Without this they pick the
        # same name and silently overwrite each other's tiles. Costs nothing when only
        # one run is active.
        tag = ("same" if len(ph) == len(PHRASINGS_SAME) and phrasings_for(cell) is PHRASINGS_SAME
               else "chase")
        sdir = os.path.join(d, f"sheet_{i:02d}_{tag}{i % len(ph)}_{os.getpid()}")
        if os.path.isdir(sdir) and len(os.listdir(sdir)) > 2:
            continue
        os.makedirs(sdir, exist_ok=True)
        # Marker so a sweep can tell "this roll is still generating" from "this roll
        # died and left nothing". Deleting an in-flight directory is not hypothetical:
        # a tidy-up of zero-tile sheets removed one a live chase was about to write
        # into, and that cell crashed with FileNotFoundError mid-run.
        open(os.path.join(sdir, ".inflight"), "w").close()
        try:
            images, tile_id = client.create_tiles(description=prompt, seed=101 + i * 7,
                                                  **matrix.FIXED)
        except PixelLabError as e:
            # A stalled or failed JOB says nothing about the cell, and letting it end
            # the chase throws away the other nine rolls. It cost a cell exactly that
            # once: a job hung at 10% for 180s, the exception unwound out of the whole
            # cell, and snow/paving_stone was reported as having no transition
            # available — it produced a 1.00 on its third roll as soon as it was asked
            # again. So a bad roll is just a bad roll: drop the empty sheet dir and
            # take the next one.
            os.rmdir(sdir) if not os.listdir(sdir) else None
            print(f"    roll {n + 1}/{attempts}: job failed ({str(e)[:70]}), rolling on",
                  flush=True)
            time.sleep(5)
            continue
        pixellab_gc.record(tile_id, purpose=f"matrix:{cell.replace('__over__', '_over_')}",
                           prompt=prompt)
        spent[0] += matrix.SHEET_USD
        if not images and tile_id:
            images = client.fetch_tiles(tile_id)       # already paid for; never re-buy
        paths = []
        for j, im in enumerate(images):
            p = os.path.join(sdir, f"tile_{j:02d}.png")
            im.save(p)
            paths.append(p)
        try:
            os.remove(os.path.join(sdir, ".inflight"))
        except OSError:
            pass
        with open(os.path.join(sdir, "meta.json"), "w") as f:
            json.dump({"cell": cell, "prompt": prompt, "tile_id": tile_id,
                       "style": f"{tag}{i % len(ph)}", "n_tiles": len(paths),
                       "settings": matrix.FIXED}, f, indent=2)
        # Counted over the WHOLE cell, not this sheet: three candidates accumulated
        # across three rolls is exactly as good a choice for the maintainer as three
        # from one lucky sheet, and stopping early on either is what leaves a cell with
        # nothing to pick between.
        hits = cell_passing(cell, min_wall, min_clarity)
        best_oh = max((flatness.overhang(p) for p in paths), default=0.0)
        print(f"    roll {n + 1}/{attempts}: best spill {best_oh:.2f} "
              f"-> {len(hits)}/{need} passing"
              f"{' DONE' if len(hits) >= need else ''}", flush=True)
        if len(hits) >= need:
            return hits[0]
    hits = cell_passing(cell, min_wall, min_clarity)
    return hits[0] if hits else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--attempts", type=int, default=10,
                    help="rolls per cell before giving up (the maintainer's own number)")
    ap.add_argument("--min-clarity", type=float, default=0.0,
                    help="minimum share of wall pixels that read decisively as the top material")
    ap.add_argument("--min-wall", type=float, default=2.0,
                    help="a dead flat cliff is not a win")
    ap.add_argument("--max-usd", type=float, default=20.0)
    ap.add_argument("--min-usd", type=float, default=1.0,
                    help="never take the shared account below this")
    ap.add_argument("--min-candidates", type=int, default=3,
                    help="keep rolling until the cell has this many tiles clearing "
                         "the bar — the maintainer reviews by CHOOSING")
    ap.add_argument("--cells", nargs="*", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    types = matrix.cfg()["ground_types"]
    dead = tombstones.load().get("cells", {})
    cells = args.cells or failing_cells(args.min_wall, args.min_clarity,
                                        need=args.min_candidates)
    cells = [c for c in cells if c.replace("__over__", "_over_") not in dead]

    print(f"{len(cells)} cell(s) with fewer than {args.min_candidates} tiles clearing "
          f"the bar (seam 0, spill >= {flatness.MIN_OVERHANG}, wall >= {args.min_wall})")
    for c in cells:
        print(f"   {c}")
    print(f"\nup to {args.attempts} rolls each -> at most "
          f"{len(cells) * args.attempts} sheets, ~${len(cells) * args.attempts * matrix.SHEET_USD:.2f}")
    if args.dry_run:
        return

    client = PixelLabClient()
    spent = [0.0]
    won, lost = [], []
    for cell in cells:
        top_g, side_g = cell_parts(cell, types)
        if not top_g or not side_g:
            continue
        bal = client.credits_usd()
        if bal < args.min_usd:
            print(f"stopping: shared-account balance ${bal:.2f} below floor")
            break
        if spent[0] >= args.max_usd:
            print(f"stopping: spent ~${spent[0]:.2f}")
            break
        print(f"\n{cell}")
        try:
            hit = chase(client, cell, top_g, side_g, args.attempts, args.min_wall,
                        spent, args.max_usd, args.min_clarity,
                        need=args.min_candidates)
        except BudgetExhausted as e:
            print("stopping:", e)
            break
        except (PixelLabError, Exception) as e:
            print(f"  ! {cell} failed: {str(e)[:160]}")
            traceback.print_exc(limit=1)
            time.sleep(5)
            continue
        if hit:
            won.append((cell, hit))
            print(f"  WON  wall {hit[1]:.2f} spill {hit[2]:.2f}  {os.path.basename(hit[0])}")
        else:
            lost.append(cell)
            print(f"  still nothing after {args.attempts} rolls")

    print(f"\ndone — {len(won)} cell(s) won, {len(lost)} still open, "
          f"~${spent[0]:.2f} of our own spend")
    for cell, hit in won:
        print(f"   WON  {cell:32s} wall {hit[1]:5.2f} spill {hit[2]:.2f}")
    for cell in lost:
        print(f"   open {cell}")


if __name__ == "__main__":
    main()
