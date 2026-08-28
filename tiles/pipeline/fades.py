"""FADE tiles: one ground drifting into another, with PixelLab left free to decide how.

The maintainer, after I over-specified this and bought 114 sheets of perfect ovals:

    "It's important to let pixellab be creative in how a tile containing both looks like.
     You should NOT force pixellab into making ugly spheres... If you just asked pixellab
     to make grass with black rocks on top we would have amazing transition tiles with
     black rocks on top of grass. And small pieces of grass on top of black rock...
     Small prompts! Extremely small prompts! Something like: 'Black rock on top of grass'
     - this prompt is perfect... You will know after the generation how much 'grass vs
     black_rock' a tile should be classified as."

THAT LAST SENTENCE IS THE ARCHITECTURE. The amount is an OUTPUT, not an input. Every
earlier attempt in this domain tried to order a percentage and then discovered the
generator does not measure area: the ordered level moved the distribution and never set
it (one p10 sheet's 16 takes spanned 0-30% minor). So this module asks for a mixture and
nothing else, and `fades_post.py` measures what came back and files it. Nothing about
shape, placement, rim, size or count is ever mentioned to the generator.

WHY THE PROMPT MUST STAY TINY. The prescriptive version of this idea ("one small patch of
{b} in the middle, {a} all around the edge") worked exactly as written and that was the
problem - it produced a field of centred ovals, ~90% unusable. Every clause is a
constraint the model spends its freedom satisfying instead of drawing ground. The house
rule for this domain was already written down before I broke it: short, keyword-led, no
named features, because "the generative AI is not that smart and can't understand exactly
what you write anyways".

TWO DIRECTIONS PER PAIR, WHICH IS THE WHOLE LADDER. "black rock on top of grass" and
"grass on top of black rock" are different art, not one asset read from two sides, and
between them a pair's tiles cover the range from mostly-A to mostly-B. Ordered pairs, so
210 cells for 15 grounds.

NOT A BOUNDARY, and structurally not addressable as one: no path here contains `__over__`.
tiles/patterns answers where two grounds MEET; these ease a field toward a new ground
before any boundary is drawn.
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
OUT = os.path.join(ROOT, "fades")
SCHEMA = "tiles3/fades@1"
KIND = "fade_top_only"

# Candidate phrasings, all deliberately tiny. `on_top_of` is the maintainer's own wording,
# verbatim, and is the default. The others exist to be piloted against it, never to be
# mixed in blindly: whichever draws the best ground wins the whole run.
PHRASINGS = {
    "on_top_of": "{b} on top of {a}",
    "with": "{a} with {b}",
    "and": "{a} and {b}",
}
DEFAULT_PHRASING = "on_top_of"


def _h(*p):
    return int(hashlib.sha1("|".join(map(str, p)).encode()).hexdigest()[:8], 16)


def prompt_for(a, b, phrasing=DEFAULT_PHRASING):
    return PHRASINGS[phrasing].format(a=words(a), b=words(b))


def sheet_dir(a, b, phrasing, rep):
    """<dominant>__with__<minor>/<phrasing>_<rep>. `rep` buys variety, not a level."""
    return os.path.join(OUT, f"{a}__with__{b}", f"{phrasing}_{rep}")


def plan(only=None, pairs=None, phrasing=DEFAULT_PHRASING, reps=1):
    jobs = []
    for a in GROUNDS:
        if only and a != only:
            continue
        for b in GROUNDS:
            if b == a:
                continue
            if pairs is not None and (a, b) not in pairs:
                continue
            for rep in range(1, reps + 1):
                jobs.append({
                    "dominant": a, "minor": b, "phrasing": phrasing, "rep": rep,
                    "prompt": prompt_for(a, b, phrasing),
                    "seed": _h("fade", a, b, phrasing, rep) % 90000 + 1000,
                    "dir": os.path.relpath(sheet_dir(a, b, phrasing, rep), REPO),
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
    meta = {"schema": SCHEMA, "kind": KIND, "wall_is_meaningless": True,
            "use_for": "transition",
            "dominant": job["dominant"], "minor": job["minor"],
            "prompt": job["prompt"], "phrasing": job["phrasing"], "rep": job["rep"],
            "seed": job["seed"], "tile_id": tile_id,
            "settings": dict(matrix.FIXED), "n_tiles": len(names), "tiles": names}
    with open(os.path.join(d, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    return meta


def write_index():
    sheets = []
    for mp in sorted(glob.glob(os.path.join(OUT, "*__with__*", "*", "meta.json"))):
        m = json.load(open(mp))
        m["dir"] = os.path.relpath(os.path.dirname(mp), REPO)
        sheets.append(m)
    doc = {
        "schema": SCHEMA, "kind": KIND, "wall_is_meaningless": True,
        "use_for": "transition",
        "_comment": [
            "FADE TILES: one ground drifting into another, drawn however PixelLab chose.",
            "The prompt asks only for the mixture ('black rock on top of grass') and says",
            "NOTHING about shape, placement or amount - the amount is measured afterwards",
            "by fades_post.py and published in mix.json, which is the consumer surface.",
            "Top only, like tiles/tops: the wall is meaningless art, not a side material.",
            "No path contains `__over__`; these are not x-over-y cells.",
        ],
        "phrasings": PHRASINGS,
        "n_sheets": len(sheets), "n_tiles": sum(s["n_tiles"] for s in sheets),
        "sheets": sheets,
    }
    os.makedirs(OUT, exist_ok=True)
    # sheets.json, NOT index.json: the wiki claimed tiles/fades/index.json as the
    # consumer surface (schema tiles3/fade-tiles@1, posted on the board) before this
    # generator's raw listing had any consumer. The raw listing is pipeline-internal,
    # so it yields the good name. fades_post.py owns index.json.
    dst = os.path.join(OUT, "sheets.json")
    tmp = f"{dst}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=1)
    os.replace(tmp, dst)
    return doc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--pairs", nargs="*")
    ap.add_argument("--phrasing", default=DEFAULT_PHRASING, choices=sorted(PHRASINGS))
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--max-usd", type=float, default=5.0)
    ap.add_argument("--min-usd", type=float, default=15.0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--reindex", action="store_true")
    args = ap.parse_args()

    if args.reindex:
        d = write_index()
        print(f"index: {d['n_sheets']} sheets, {d['n_tiles']} tiles")
        return

    pairs = {tuple(p.split(":")) for p in args.pairs} if args.pairs else None
    jobs = plan(only=args.only, pairs=pairs, phrasing=args.phrasing, reps=args.reps)
    todo = [j for j in jobs if not is_complete(j["dir"])]
    print(f"{len(jobs)} sheet(s) planned; {len(jobs)-len(todo)} on disk, {len(todo)} to "
          f"generate ~${len(todo)*matrix.SHEET_USD:.2f}")
    if args.dry_run:
        for j in todo[:20]:
            print(f'  {j["dir"]:<58} "{j["prompt"]}"')
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
        purpose = f"fade:{j['dominant']}:{j['minor']}:{j['phrasing']}{j['rep']}"
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
            print(f'  [{n}/{len(todo)}] "{j["prompt"]}"  ${spent:.2f}/${args.max_usd:.2f}',
                  flush=True)
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
