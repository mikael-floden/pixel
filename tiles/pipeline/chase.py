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


def cell_parts(cell, types):
    top, side = cell.split("__over__")
    by_id = {t["id"]: t for t in types}
    return by_id.get(top), by_id.get(side)


def evaluate(paths, min_wall, min_clarity=0.0):
    """Best tile in this sheet that clears every calibrated gate, or None."""
    best = None
    for p in paths:
        q = flatness.wall_quality(p)
        if not q or q["score"] < min_wall:
            continue
        if flatness.overhang(p) < flatness.MIN_OVERHANG:
            continue
        # A spill that cannot be told apart from the wall it lands on is not usable:
        # postprocess has nothing to select, so it ships in the wrong palette.
        if flatness.fringe_clarity(p) < min_clarity:
            continue
        if flatness.seam_px(p) > flatness.SEAM_TOL:
            continue
        if not best or q["score"] > best[1]:
            best = (p, q["score"], flatness.overhang(p))
    return best


def cell_status(cell, min_wall, min_clarity=0.0):
    d = os.path.join(OUT, cell)
    return evaluate(sorted(glob.glob(os.path.join(d, "sheet_*", "tile_*.png"))), min_wall, min_clarity)


def failing_cells(min_wall, min_clarity=0.0):
    out = []
    for d in sorted(glob.glob(os.path.join(OUT, "*__over__*"))):
        cell = os.path.basename(d)
        if not cell_status(cell, min_wall, min_clarity):
            out.append(cell)
    return out


def chase(client, cell, top_g, side_g, attempts, min_wall, spent, max_usd, min_clarity=0.0):
    """Roll this cell until a tile clears the bar, or until `attempts` is used up."""
    d = os.path.join(OUT, cell)
    os.makedirs(d, exist_ok=True)
    existing = len([x for x in os.listdir(d) if x.startswith("sheet_")])
    for n in range(attempts):
        if spent[0] >= max_usd:
            print(f"    budget reached (~${spent[0]:.2f})")
            return None
        i = existing + n
        prompt = PHRASINGS[i % len(PHRASINGS)].format(
            top_material=top_g["material_words"], side_material=side_g["material_words"],
            top_word=top_g["id"].replace("_", " "), side_word=side_g["id"].replace("_", " "))
        # The suffix carries the PID because two chases can legitimately target the same
        # cell — a bulk row run and a targeted fix — and both compute their sheet index
        # from the directory listing when the cell STARTS. Without this they pick the
        # same name and silently overwrite each other's tiles. Costs nothing when only
        # one run is active.
        sdir = os.path.join(d, f"sheet_{i:02d}_chase{i % len(PHRASINGS)}_{os.getpid()}")
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
                       "style": f"chase{i % len(PHRASINGS)}", "n_tiles": len(paths),
                       "settings": matrix.FIXED}, f, indent=2)
        hit = evaluate(paths, min_wall, min_clarity)
        best_oh = max((flatness.overhang(p) for p in paths), default=0.0)
        print(f"    roll {n + 1}/{attempts}: best spill {best_oh:.2f} "
              f"{'-> PASS' if hit else ''}", flush=True)
        if hit:
            return hit
    return None


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
    ap.add_argument("--cells", nargs="*", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    types = matrix.cfg()["ground_types"]
    dead = tombstones.load().get("cells", {})
    cells = args.cells or failing_cells(args.min_wall, args.min_clarity)
    cells = [c for c in cells if c.replace("__over__", "_over_") not in dead]

    print(f"{len(cells)} cell(s) with no tile clearing the bar "
          f"(seam 0, spill >= {flatness.MIN_OVERHANG}, wall >= {args.min_wall})")
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
                        spent, args.max_usd, args.min_clarity)
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
