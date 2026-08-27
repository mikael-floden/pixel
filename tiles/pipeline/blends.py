"""BLEND tiles: mostly ground A with ground B creeping in. Top only, for transitions.

The maintainer's idea, and it is a different thing from every transition built so far:

    "What I want is tiles where we focus on only the top, but we want pixellab to
     generate something that is a bit of ground type A and a bit of ground type B...
     The thinking behind this tiles is to start ease in a change in base tile change
     long before the base tile change is enforced. This will be a gradual change
     towards the new ground."

Not a boundary. tiles/transitions/ and tiles/patterns/ answer "where exactly does grass
stop and lava start"; these answer "this is still grass, but lava is coming". A field
drifts through p10 -> p50 tiles before any Wang boundary is drawn.

EACH GROUND GENERATES ONLY WHERE IT DOMINATES: A publishes B at 10/20/30/40/50%, and
the other half of the ladder (60-90% B) is B's own p40..p10 of A, read the other way
round. So the pair grass/lava needs nine distinct blends and both grounds own five each,
sharing 50/50 - exactly as he specified ("So each ground-type is responsible for
generating a mixed tile where this ground tile is in focus (from 90% to 50%)").

THE PERCENTAGE IS SPOKEN, NOT NUMBERED. A generative model does not measure area, so
"10%" in a prompt buys nothing; the ladder is worded by how much of B you would notice,
from "a few small spots" to "mixed evenly". The percent survives in the PATH and the
index, which is what the wiki labels and what a world agent picks by.

NOT AN X-OVER-Y CELL, and structurally so: no path contains `__over__`, the substring
every consumer keys on. `kind` is `blend_top_only`, `use_for` is `transition`, and
`wall_is_meaningless` is true - these are tops with a purpose, and their wall is as
irrelevant as any other top-only tile's.
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

import numpy as np
from PIL import Image

import matrix
import pixellab_gc
import transition_render as TR
from pixellab_client import BudgetExhausted, PixelLabClient, PixelLabError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
OUT = os.path.join(ROOT, "blends")
SCHEMA = "tiles3/blends@1"
KIND = "blend_top_only"

PALETTE = json.load(open(os.path.join(ROOT, "config", "palette.json")))["types"]

# The published grounds: a type with `generated_as` publishes under its own name, and
# the matrix-only source name is never a ground of its own.
_GEN_AS = {m for m, v in PALETTE.items() if isinstance(v, dict) and v.get("generated_as")}
GROUNDS = sorted(
    m for m, v in PALETTE.items()
    if isinstance(v, dict) and v.get("top")
    and (m in _GEN_AS or not any(
        isinstance(w, dict) and w.get("generated_as") == m for w in PALETTE.values())))

# HOW MUCH OF B YOU WOULD NOTICE, per level. Short and keyword-led, because the model
# reads keywords and not arithmetic ("the generative AI is not that smart and can't
# understand exactly what you write anyways"). No named features - a plain prompt
# already supplies those.
LADDER = {
    10: "mostly {a}, a few small spots of {b}",
    20: "mostly {a}, scattered patches of {b}",
    30: "{a} with clear patches of {b} breaking through",
    40: "{a} and {b} mixed, more {a}",
    50: "{a} and {b} mixed evenly",
}
LEVELS = tuple(sorted(LADDER))


def words(ground):
    """The ground as the model should hear it - underscores are not words."""
    return ground.replace("_", " ")


def pair_dir(a, b):
    return os.path.join(OUT, f"{a}__with__{b}")


def sheet_dir(a, b, pct):
    return os.path.join(pair_dir(a, b), f"p{pct:02d}")


def seed_of(a, b, pct):
    """Deterministic, so a re-run reproduces and never re-buys a different sheet."""
    import hashlib
    h = hashlib.sha1(f"blend|{a}|{b}|{pct}".encode()).hexdigest()
    return int(h[:6], 16) % 90000 + 1000


def plan(only=None, levels=LEVELS):
    jobs = []
    for a in GROUNDS:
        if only and a != only:
            continue
        for b in GROUNDS:
            if b == a:
                continue
            for pct in levels:
                jobs.append({
                    "dominant": a, "minor": b, "pct": pct,
                    "prompt": LADDER[pct].format(a=words(a), b=words(b)),
                    "seed": seed_of(a, b, pct),
                    "dir": os.path.relpath(sheet_dir(a, b, pct), REPO),
                    "palette_top": PALETTE[a]["top"],
                    "minor_top": PALETTE[b]["top"],
                })
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
    meta = {
        "schema": SCHEMA, "kind": KIND, "wall_is_meaningless": True,
        "use_for": "transition",
        "dominant": job["dominant"], "minor": job["minor"], "pct_minor": job["pct"],
        "prompt": job["prompt"], "seed": job["seed"], "tile_id": tile_id,
        "settings": dict(matrix.FIXED), "n_tiles": len(names), "tiles": names,
    }
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
            "BLEND TILES: mostly `dominant`, with `pct_minor` percent of `minor` mixed",
            "in. Top only - the wall is meaningless, exactly as in tiles/tops.",
            "NOT a boundary: tiles/patterns answers where two grounds MEET; these ease a",
            "field toward a new ground before any boundary exists.",
            "EACH GROUND OWNS 10-50% OF THE OTHER. The rest of the ladder is the other",
            "ground's own entry read backwards: 80% lava / 20% grass IS",
            "lava__with__grass/p20.",
            "No path contains `__over__` - these can never be addressed as an x-over-y",
            "cell.",
        ],
        "levels": list(LEVELS),
        "ladder": {str(k): v for k, v in LADDER.items()},
        "pair_note": "<dominant>__with__<minor>/p<NN>, NN = percent of the MINOR ground",
        "n_sheets": len(sheets), "n_tiles": sum(s["n_tiles"] for s in sheets),
        "sheets": sheets,
    }
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "index.json"), "w") as f:
        json.dump(doc, f, indent=1)
    return doc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="only this dominant ground")
    ap.add_argument("--pairs", nargs="*", help="only these dominant:minor pairs")
    ap.add_argument("--max-usd", type=float, default=10.0)
    ap.add_argument("--min-usd", type=float, default=5.0,
                    help="never draw the shared account below this")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--reindex", action="store_true")
    args = ap.parse_args()

    if args.reindex:
        doc = write_index()
        print(f"index: {doc['n_sheets']} sheets, {doc['n_tiles']} tiles")
        return

    jobs = plan(only=args.only)
    if args.pairs:
        want = {tuple(p.split(":")) for p in args.pairs}
        jobs = [j for j in jobs if (j["dominant"], j["minor"]) in want]
    todo = [j for j in jobs if not is_complete(j["dir"])]
    print(f"{len(jobs)} sheet(s) planned; {len(jobs)-len(todo)} on disk, {len(todo)} to "
          f"generate ~${len(todo)*matrix.SHEET_USD:.2f} ({len(todo)*16} tiles)")
    if args.dry_run:
        for j in todo[:40]:
            print(f"  {j['dominant']:>18} + {j['pct']:2d}% {j['minor']:<18} "
                  f"\"{j['prompt']}\"")
        if len(todo) > 40:
            print(f"  ... and {len(todo)-40} more")
        print("\ndry run - nothing generated, $0.00 spent")
        return

    client = PixelLabClient()
    spent = 0.0
    for n, j in enumerate(todo, 1):
        # A hard cap: stop BEFORE the sheet that would cross it.
        if spent + matrix.SHEET_USD > args.max_usd:
            print(f"stopping: ${spent:.2f} spent, the next sheet would pass the "
                  f"${args.max_usd:.2f} cap")
            break
        try:
            bal = client.credits_usd()
        except PixelLabError as e:
            print(f"stopping: cannot read balance ({str(e)[:120]})")
            break
        if bal < args.min_usd:
            print(f"stopping: shared-account balance ${bal:.2f} below floor "
                  f"${args.min_usd:.2f}")
            break
        purpose = f"blend:{j['dominant']}:{j['minor']}:p{j['pct']}"
        try:
            images, tile_id = client.create_tiles(
                description=j["prompt"], seed=j["seed"], **matrix.FIXED)
            pixellab_gc.record(tile_id, purpose=purpose, prompt=j["prompt"])
            if not images and tile_id:
                images = client.fetch_tiles(tile_id)      # paid for; never re-buy
            if not images:
                print(f"  ! {purpose} produced no tiles")
                continue
            write_sheet(j, images, tile_id)
            spent += matrix.SHEET_USD
            print(f"  [{n}/{len(todo)}] {j['dominant']} +{j['pct']}% {j['minor']} "
                  f"seed={j['seed']}  ${matrix.SHEET_USD:.3f}  "
                  f"running ${spent:.2f}/${args.max_usd:.2f}", flush=True)
        except BudgetExhausted as e:
            print("stopping:", e)
            break
        except Exception as e:                  # one bad sheet must not kill the run
            print(f"  ! {purpose} failed: {str(e)[:160]}")
            traceback.print_exc(limit=1)
            time.sleep(5)
        finally:
            write_index()                       # index survives any exit
    doc = write_index()
    print(f"\ndone - {doc['n_sheets']} sheets / {doc['n_tiles']} tiles on disk, "
          f"~${spent:.2f} of our own spend")


if __name__ == "__main__":
    main()
