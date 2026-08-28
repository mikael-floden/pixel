"""PUDDLE tiles: the minor ground as an interior island, all four top sides pure dominant.

The maintainer's rule, for every blend level below 50%:

    "a tile that have ground type that should be the majority having all 4 top sides
     being part of its own type. This means a transition tile like this doesn't have to
     care about someone else to look good."

That last sentence is the whole point, and it is a composability property, not a taste
one: a tile whose rim is entirely its own ground drops next to ANY tile of that ground
without matching anything. Rendered as fields it is the difference between one continuous
surface and a checkerboard - see the left/right halves of the field proof that motivated
this tree.

WHY A SEPARATE TREE FROM tiles/blends. The blends ladder asked for a MIX ("scattered
patches of lava") and got minor ground running off every edge; that art is still valid and
still published, it just cannot satisfy this rule. Puddles ask for a different shape, so
they are generated, gated and indexed separately rather than silently replacing sheets
consumers may already reference.

FOUR LEVELS, NOT FIVE. p50 is deliberately absent. The maintainer said "less than 50%",
and the measurement agrees for a reason he did not have to know: at p10-p40 the tile's own
trimmed-median background is the dominant ground 93-99% of the time, but at p50 only 77.7%
- so at an even mix the gate's own reference stops meaning what it needs to mean.

THE PROMPT NAMES THE RIM, AND SCALES ONE FEATURE. Measured over the 349 blend sheets
already on disk, wording moves this far more than quantity does: the share of sheets
containing at least one clean-rimmed tile is 43.3% for "a few small spots" and 3.6% for
"mixed evenly", and holding the actual minor area FIXED, the p10 wording puts only 0.27x
as much minor ground into the rim band as an even spread would. Puddle-ness is a property
of the SHEET rather than a per-tile lottery (200 of 288 sheets contain zero clean-rim
tiles while 11 contain five or more, against a binomial expectation of ~0), so the wording
buys or poisons all 16 tiles at once. Feature COUNT is the strongest geometric lever -
clean-rim rate falls 16.4% -> 0.4% going from one blob to 9-16 - so the ladder scales one
island's SIZE and never its count.

TWO WORDING FAMILIES, SPLIT BY LEVEL - see family_of(). A rule that confines every island
to the middle manufactures a polka-dot grid, the same artefact the maintainer has rejected
twice before ("will make the tile look repeated and tiled"), and measured on the gated
tiles the islands ARE strongly centred (centroid radius p50 0.146 of the diamond's
half-width). So p10/p20 alternate between a centred ask and an anywhere-inside ask, where
yield is high enough to spend on variety; p30/p40 always ask for the middle, because a big
island reaches the rim unless told not to.

DENSITY IS PART OF THE CONTRACT. Rendered as fields, these read as ground with pools at
20-35% coverage and as a grid of dots above ~50%. That is not a defect to fix in the art -
it is how the set is meant to be laid, easing a change in gradually - but a consumer that
tiles a solid field of them will see the lattice, so the index says so.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import matrix
import pixellab_gc
from blends import GROUNDS, words
from pixellab_client import BudgetExhausted, PixelLabClient, PixelLabError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
OUT = os.path.join(ROOT, "puddles")
SCHEMA = "tiles3/puddles@1"
KIND = "puddle_top_only"

# ONE island, its SIZE scaling with the level; the rim named in every line.
CENTRED = {
    10: "{a}, one small patch of {b} in the middle, {a} all around the edge",
    20: "{a}, one patch of {b} in the middle, {a} all around the edge",
    30: "{a}, one wide patch of {b} in the middle, {a} all around the edge",
    40: "{a}, one large patch of {b} in the middle, {a} all around the edge",
}
# The same ask without "in the middle" - the island may sit anywhere inside, which is all
# the gate requires and is what keeps a field from reading as a regular grid of dots.
ANYWHERE = {
    10: "{a} all around the edge, a small pool of {b} inside",
    20: "{a} all around the edge, a pool of {b} inside",
    30: "{a} all around the edge, a wide pool of {b} inside",
    40: "{a} all around the edge, a big pool of {b} inside",
}
LEVELS = (10, 20, 30, 40)


def _h(*parts):
    return int(hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:8], 16)


def family_of(a, b, pct):
    """Which wording family to use - variety where it is cheap, reliability where it is not.

    Measured on the 12-sheet pilot, sheets pass all-or-nothing (16/16 or 0/16 - puddle-ness
    is a property of the sheet), and the two families do not behave alike as the island
    grows: at p10 both pass ~100%, but at p30/p40 the "centred" wording returned 13/16 and
    16/16 where "anywhere" returned 4/32 and 9/32. A big island has to be told to stay in
    the middle or it reaches the rim.

    So: p10/p20 alternate by pair, because yield is high there and positional variety is
    what stops a laid field reading as a grid of dots; p30/p40 always say "in the middle",
    because at those sizes a clean rim is scarce and worth more than the variety. (The
    pilot confounds family with pair - only one pair drew the centred wording - so this is
    a hedge on the evidence, not a claim to have separated them.)
    """
    if pct >= 30:
        return "centred"
    return "centred" if _h("fam", a, b) % 2 == 0 else "anywhere"


def prompt_for(a, b, pct, family=None):
    fam = family or family_of(a, b, pct)
    table = CENTRED if fam == "centred" else ANYWHERE
    return table[pct].format(a=words(a), b=words(b)), fam


def seed_of(a, b, pct):
    return _h("puddle", a, b, pct) % 90000 + 1000


def sheet_dir(a, b, pct):
    return os.path.join(OUT, f"{a}__with__{b}", f"p{pct:02d}")


def plan(only=None, pairs=None, levels=LEVELS):
    jobs = []
    for a in GROUNDS:
        if only and a != only:
            continue
        for b in GROUNDS:
            if b == a:
                continue
            if pairs is not None and (a, b) not in pairs:
                continue
            for pct in levels:
                pr, fam = prompt_for(a, b, pct)
                jobs.append({"dominant": a, "minor": b, "pct": pct, "prompt": pr,
                             "family": fam, "seed": seed_of(a, b, pct),
                             "dir": os.path.relpath(sheet_dir(a, b, pct), REPO)})
    return jobs


def is_complete(d):
    return len(glob.glob(os.path.join(REPO, d, "tile_*.webp"))) == 16


def write_sheet(job, images, tile_id):
    d = os.path.join(REPO, job["dir"])
    os.makedirs(d, exist_ok=True)
    names = []
    for i, im in enumerate(images):
        n = f"tile_{i:02d}.webp"
        im.convert("RGBA").save(os.path.join(d, n), "WEBP", lossless=True, exact=True)
        names.append(n)
    meta = {"schema": SCHEMA, "kind": KIND, "wall_is_meaningless": True,
            "use_for": "transition",
            "dominant": job["dominant"], "minor": job["minor"], "pct_minor": job["pct"],
            "prompt": job["prompt"], "wording_family": job["family"],
            "seed": job["seed"], "tile_id": tile_id,
            "settings": dict(matrix.FIXED), "n_tiles": len(names), "tiles": names}
    with open(os.path.join(d, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    return meta


def write_index():
    sheets = []
    for mp in sorted(glob.glob(os.path.join(OUT, "*__with__*", "p??", "meta.json"))):
        m = json.load(open(mp))
        m["dir"] = os.path.relpath(os.path.dirname(mp), REPO)
        sheets.append(m)
    doc = {
        "schema": SCHEMA, "kind": KIND, "wall_is_meaningless": True,
        "use_for": "transition",
        "_comment": [
            "PUDDLE TILES: mostly `dominant`, with `pct_minor` percent of `minor` sitting",
            "as an INTERIOR ISLAND - all four sides of the top diamond are the dominant",
            "ground, so the tile composes with any neighbour of that ground without",
            "matching anything.",
            "THIS INDEX IS RAW GENERATOR OUTPUT and is NOT the publish surface: a raw",
            "sheet has not been aligned and has not passed the gate. Consumers read",
            "tiles/puddles/gated.json, which lists only tiles proved to satisfy the rule",
            "on the exact bytes they will download.",
            "No path contains `__over__`; the wall is meaningless, same as tiles/tops.",
        ],
        "levels": list(LEVELS),
        "wordings": {"centred": CENTRED, "anywhere": ANYWHERE},
        "n_sheets": len(sheets), "n_tiles": sum(s["n_tiles"] for s in sheets),
        "sheets": sheets,
    }
    os.makedirs(OUT, exist_ok=True)
    dst = os.path.join(OUT, "index.json")
    tmp = f"{dst}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=1)
    os.replace(tmp, dst)          # atomic: parallel workers all rewrite this
    return doc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--pairs", nargs="*", help="dominant:minor pairs")
    ap.add_argument("--levels", nargs="*", type=int, default=list(LEVELS))
    ap.add_argument("--max-usd", type=float, default=5.0)
    ap.add_argument("--min-usd", type=float, default=20.0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--reindex", action="store_true")
    args = ap.parse_args()

    if args.reindex:
        d = write_index()
        print(f"index: {d['n_sheets']} sheets, {d['n_tiles']} tiles")
        return

    pairs = {tuple(p.split(":")) for p in args.pairs} if args.pairs else None
    jobs = plan(only=args.only, pairs=pairs, levels=tuple(args.levels))
    todo = [j for j in jobs if not is_complete(j["dir"])]
    print(f"{len(jobs)} sheet(s) planned; {len(jobs)-len(todo)} on disk, {len(todo)} to "
          f"generate ~${len(todo)*matrix.SHEET_USD:.2f}")
    if args.dry_run:
        for j in todo[:24]:
            print(f"  {j['dominant']:>18} +{j['pct']:2d}% {j['minor']:<18} "
                  f"[{j['family']:8s}] \"{j['prompt']}\"")
        if len(todo) > 24:
            print(f"  ... and {len(todo)-24} more")
        print("\ndry run - nothing generated, $0.00 spent")
        return

    client = PixelLabClient()
    spent = 0.0
    for n, j in enumerate(todo, 1):
        if spent + matrix.SHEET_USD > args.max_usd:
            print(f"stopping: ${spent:.2f} spent, next sheet would pass the "
                  f"${args.max_usd:.2f} cap")
            break
        try:
            if client.credits_usd() < args.min_usd:
                print(f"stopping: balance below the ${args.min_usd:.2f} floor")
                break
        except PixelLabError as e:
            print(f"stopping: cannot read balance ({str(e)[:100]})")
            break
        purpose = f"puddle:{j['dominant']}:{j['minor']}:p{j['pct']}"
        try:
            images, tile_id = client.create_tiles(
                description=j["prompt"], seed=j["seed"], **matrix.FIXED)
            pixellab_gc.record(tile_id, purpose=purpose, prompt=j["prompt"])
            if not images and tile_id:
                images = client.fetch_tiles(tile_id)     # already paid for
            if not images:
                print(f"  ! {purpose} produced no tiles")
                continue
            write_sheet(j, images, tile_id)
            spent += matrix.SHEET_USD
            print(f"  [{n}/{len(todo)}] {j['dominant']} +{j['pct']}% {j['minor']} "
                  f"[{j['family']}]  ${spent:.2f}/${args.max_usd:.2f}", flush=True)
        except BudgetExhausted as e:
            print("stopping:", e)
            break
        except Exception as e:
            print(f"  ! {purpose} failed: {str(e)[:150]}")
            traceback.print_exc(limit=1)
            time.sleep(5)
        finally:
            write_index()
    d = write_index()
    print(f"\ndone - {d['n_sheets']} sheets / {d['n_tiles']} tiles, ~${spent:.2f} spent")


if __name__ == "__main__":
    main()
