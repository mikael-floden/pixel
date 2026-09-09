"""DETAIL tiles: one ground with one small, chosen thing on it.

The maintainer's brief, 2026-09-03:

    "When it comes to 'details' it's only one ground type, but we still want a lot to
     happen, but the ground type should always be the majority ground so it can be
     placed on it's own ground without looking tiled. We want a lot of fun special
     tiles here! Everything from rocks, flowers, crystals, small mushrooms, footsteps,
     cracks, etc (what I listed is just examples, I want you to think on your own).
     It should be flat or small enough to be considered a ground tile. Larger objects
     are scenery."

WHERE THESE LAND, AND WHY NOT A NEW TREE. They are written into `tiles/tops/<ground>/`
with `flavour: "detail"` and the tops schema, because the wiki ALREADY reviews that
flavour - `detailQueue()` is every top nobody has judged yet, rendered once in the
centre of a 5x5 of plain ground. A new `tiles/details/` tree would have been invisible
until the wiki agent added support for it; this way the first sheet is reviewable the
moment it lands. (The fades tree earned its own directory because nothing rendered a
fade; details already have a home.)

THE MOTIF IS CHOSEN, WHICH REVERSES config/tops.json's RULE - deliberately, and only
for this flavour. That rule says never name a feature, because PixelLab draws cracks
and flowers unasked on a plain ground prompt so naming one wastes prompt weight. True
for a DENSITY prompt, and useless here: "rich, varied, lots of detail" cannot produce a
crystal, a footprint or a mushroom on purpose, and a chosen motif is the whole product.
The 525 motifs live in config/details.json, hand-authored per ground.

FLAT OR ANKLE-LOW, NEVER SCENERY. Every motif is something a character walks straight
over. The scenery domain owns anything you would walk around, so no bushes, logs,
boulders, stumps or signs appear in the catalogue - asking for one here would buy a tile
the game cannot place, and would poach another agent's domain besides.

THE GROUND STAYS THE MAJORITY by wording, not by luck. The prompt names the ground
twice and the rim once - "X, one small M in the middle, X all around the edge" - which
is the phrasing MEASURED on the puddle ladder to keep all four top sides the tile's own
ground (13/16 and 16/16 clean-rimmed at the larger sizes, against 4/32 and 9/32 for an
"anywhere inside" ask). That clean rim is exactly what lets a detail drop onto its own
ground without a seam.

Centred is correct here and would be wrong for a transition: a detail is placed ONCE
and never tiled, so there is no field for a centred feature to turn into a polka-dot
grid - the failure that shaped the puddle and fade wordings.

    python3 tiles/pipeline/details.py --dry-run          # the plan, spends nothing
    python3 tiles/pipeline/details.py --only grass --limit 4
    python3 tiles/pipeline/details.py --max-usd 55       # the full 525 sheets, ~$50.40
"""

from __future__ import annotations

import argparse
import datetime
import glob
import hashlib
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import matrix
import pixellab_gc
import tops                       # sheet layout, index and top_stats: one implementation
from pixellab_client import BudgetExhausted, PixelLabClient, PixelLabError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
CFG = os.path.join(ROOT, "config", "details.json")

FLAVOUR = "detail"
# Indices start past the tops generator's own detail sheets so the two never collide in
# a directory name. tops.py finds its sheets by SEED, so this is only a sort key.
INDEX_BASE = 100


def cfg():
    with open(CFG) as f:
        return json.load(f)


def words(ground):
    """The ground as prose. `light_beach` reads as sand, `black_rock` as black rock."""
    return ground.replace("_", " ")


def seed_for(ground, motif):
    """Deterministic from the motif itself, so re-running reproduces the sheet and a
    re-ordered catalogue does not orphan and re-buy what is already on disk."""
    h = hashlib.sha1(f"detail/{ground}/{motif}".encode()).hexdigest()
    return 10000 + int(h[:6], 16) % 90000


def plan(only=None, limit=None):
    c = cfg()
    tmpl = c["prompt_template"]
    out = []
    for g in sorted(c["motifs"]):
        if only and g != only:
            continue
        for i, motif in enumerate(c["motifs"][g]):
            seed = seed_for(g, motif)
            d = tops.sheet_dir(g, FLAVOUR, INDEX_BASE + i, seed)
            out.append({
                "ground": g, "motif": motif, "flavour": FLAVOUR,
                "index": INDEX_BASE + i, "seed": seed,
                "prompt": tmpl.format(ground=words(g), motif=motif),
                "palette_top": tops.palette()[g]["top"],
                "dir": os.path.relpath(d, REPO),
            })
        if limit:
            out = out[:limit] if only else out
    return out


def is_complete(job):
    """By SEED, like tops.py: an existing sheet for this motif is never re-bought even
    if the catalogue order changed underneath it."""
    return tops.is_complete(tops.find_sheet(job["ground"], FLAVOUR, job["seed"]))


def write_sheet(job, images, tile_id):
    """The tops sheet layout, plus `motif` so a consumer can tell WHAT was asked for."""
    meta = tops.write_sheet(job, images, tile_id)
    p = os.path.join(REPO, job["dir"], "meta.json")
    d = tops.sheet_dir(job["ground"], FLAVOUR, job["index"], job["seed"])
    p = os.path.join(d, "meta.json")
    with open(p) as f:
        m = json.load(f)
    m["motif"] = job["motif"]
    m["motif_source"] = "tiles/config/details.json"
    m["walkable"] = True          # flat or ankle-low; anything larger is scenery
    with open(p, "w") as f:
        json.dump(m, f, indent=2)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="one ground")
    ap.add_argument("--grounds", nargs="*", help="several grounds")
    ap.add_argument("--limit", type=int, help="first N motifs per ground (a pilot)")
    ap.add_argument("--max-usd", type=float, default=5.0)
    ap.add_argument("--min-usd", type=float, default=10.0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--reindex", action="store_true")
    args = ap.parse_args()

    if args.reindex:
        d = tops.write_index()
        print(f"tops index: {d['n_sheets']} sheets")
        return

    jobs = plan(only=args.only)
    if args.grounds:
        jobs = [j for j in jobs if j["ground"] in set(args.grounds)]
    if args.limit:
        keep, seen = [], {}
        for j in jobs:
            seen[j["ground"]] = seen.get(j["ground"], 0) + 1
            if seen[j["ground"]] <= args.limit:
                keep.append(j)
        jobs = keep
    todo = [j for j in jobs if not is_complete(j)]
    print(f"{len(jobs)} sheet(s) planned; {len(jobs)-len(todo)} on disk, {len(todo)} to "
          f"generate ~${len(todo)*matrix.SHEET_USD:.2f}")
    if args.dry_run:
        for j in todo[:20]:
            print(f'  {j["ground"]:<20} "{j["prompt"]}"')
        if len(todo) > 20:
            print(f"  ... and {len(todo)-20} more")
        print("\ndry run - nothing generated, $0.00 spent")
        return

    client = PixelLabClient()
    spent = 0.0
    for n, j in enumerate(todo, 1):
        if spent + matrix.SHEET_USD > args.max_usd:
            print(f"stopping: next sheet would pass the ${args.max_usd:.2f} cap")
            break
        try:
            if client.credits_usd() < args.min_usd:
                print(f"stopping: balance below the ${args.min_usd:.2f} floor")
                break
        except PixelLabError as e:
            print(f"stopping: cannot read balance ({str(e)[:100]})")
            break
        purpose = f"detail:{j['ground']}:{j['motif']}"
        try:
            images, tile_id = client.create_tiles(
                description=j["prompt"], seed=j["seed"], **matrix.FIXED)
            pixellab_gc.record(tile_id, purpose=purpose, prompt=j["prompt"])
            if not images and tile_id:
                images = client.fetch_tiles(tile_id)
            if not images:
                print(f"  ! {purpose} produced no tiles")
                continue
            write_sheet(j, images, tile_id)
            spent += matrix.SHEET_USD
            print(f'  [{n}/{len(todo)}] {j["ground"]:<20} "{j["motif"]}"  '
                  f"${spent:.2f}/${args.max_usd:.2f}")
        except BudgetExhausted as e:
            print(f"stopping: {e}")
            break
        except Exception as e:
            print(f"  ! {purpose}: {str(e)[:120]}")
            traceback.print_exc(limit=1)
            continue
    tops.write_index()
    print(f"\ndone - ${spent:.2f} spent")


if __name__ == "__main__":
    main()
