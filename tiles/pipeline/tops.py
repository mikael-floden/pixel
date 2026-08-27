"""Generate TOP-ONLY ground tiles: sheets judged on their top surface alone.

THESE ARE NOT X-OVER-Y TILES AND MUST NEVER BE OFFERED AS ONE. The wall and the
overhang on these sheets are unjudged and unusable — nothing in the prompts asks for
a transition, an edge or a tuft, so the wall is whatever the generator felt like
drawing. (Maintainer brief 2026-08-27: "the wall and overhang is 100% unimportant".)
Four separate things carry that fact, because one of them alone gets missed:

  * the tree is `tiles/tops/`, not `tiles/matrix/` and not `tiles/review/`;
  * no directory name contains `__over__`, the substring every consumer keys on
    today (wiki/build.mjs, wiki/lib/topsub.mjs, publish.py, plates/index.json) —
    a tops sheet therefore cannot be resolved as a cell by any of them;
  * every meta.json and the published index carry `kind: "top_only"` and
    `wall_is_meaningless: true`;
  * the index is `tiles3/tops@1`, its own schema — not `tiles3/review@*`.

Two flavours per ground, 3 sheets each, one axis between them (config/tops.json):
`subtle` is a base-tile-set member and must survive being repeated across a field;
`detail` is a showpiece placed once in a while. Density is the only knob the prompts
turn — PixelLab draws flowers, cracks and bubbles unasked on a plain ground prompt,
so naming a feature spends prompt weight on something that arrives for free.

Format is `matrix.FIXED`, imported rather than retyped (a mis-click on exactly these
settings cost the maintainer a whole matrix once, so they live in ONE place). Every
generation is registered with pixellab_gc at the moment it is bought, so the GC can
see our work and the recovery path below can find an already-paid sheet.

Resumable and never re-buys: what is missing is derived from the filesystem each run,
a sheet whose directory is complete is skipped, and a sheet that was paid for but
never reached disk is re-fetched by tile_id from the registry (`fetch_tiles` costs
nothing — the generation is already paid for).

  python3 tiles/pipeline/tops.py --dry-run           # the plan, spends nothing
  python3 tiles/pipeline/tops.py --max-usd 9         # a full run is ~$8.64
  python3 tiles/pipeline/tops.py --only grass
  python3 tiles/pipeline/tops.py --reindex           # rebuild index.json from disk
"""

from __future__ import annotations

import argparse
import datetime
import glob
import hashlib
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

import matrix                     # FIXED + SHEET_USD: one source of truth, never retyped
import pixellab_gc
import transition_render          # top_face(): the top surface, from the tile's own silhouette
from pixellab_client import BudgetExhausted, PixelLabClient, PixelLabError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
OUT = os.path.join(ROOT, "tops")
CFG = os.path.join(ROOT, "config", "tops.json")
PALETTE = os.path.join(ROOT, "config", "palette.json")

SCHEMA = "tiles3/tops@1"
KIND = "top_only"
FLAVOURS = ("subtle", "detail")

# The matrix-only name. It generates as `paving_stone` and publishes as the two real
# grounds (palette.json `generated_as`), so generating it here would buy a third copy
# of a ground the game does not have.
NOT_A_GROUND = {"paving_stone"}


def cfg():
    with open(CFG) as f:
        return json.load(f)


def palette():
    with open(PALETTE) as f:
        return json.load(f)["types"]


def grounds():
    """Every ground the game draws: a palette type with a `top` colour, minus the
    matrix-only name. 15 of them."""
    p = palette()
    return sorted(g for g, v in p.items() if v.get("top") and g not in NOT_A_GROUND)


def seed_for(ground, flavour, i):
    """Deterministic, so a re-run reproduces the same sheet rather than buying a new
    one, and so the seed can be read straight off the directory name."""
    h = hashlib.sha1(f"tops/{ground}/{flavour}/{i}".encode()).hexdigest()
    return 10000 + int(h[:6], 16) % 90000


def sheet_dir(ground, flavour, index, seed):
    return os.path.join(OUT, ground, f"sheet_{index:02d}_{flavour}_{seed}")


def find_sheet(ground, flavour, seed):
    """Locate a sheet by SEED, not by index — the index is only a sort key, so
    changing --per must not orphan sheets already on disk and re-buy them."""
    hits = glob.glob(os.path.join(OUT, ground, f"sheet_*_{flavour}_{seed}"))
    return hits[0] if hits else None


def is_complete(d):
    """A directory counts as done only when its meta agrees with the tiles beside it.
    A dir with no meta.json is a run that died after paying and before writing."""
    if not d or not os.path.isfile(os.path.join(d, "meta.json")):
        return False
    try:
        with open(os.path.join(d, "meta.json")) as f:
            meta = json.load(f)
    except (json.JSONDecodeError, OSError):
        return False
    n = len(glob.glob(os.path.join(d, "tile_*.webp")))
    return n > 0 and n == meta.get("n_tiles")


def plan(only=None, flavours=FLAVOURS, per=3):
    """The whole intended library, in a stable order. Derived, never remembered."""
    c = cfg()
    p = palette()
    out = []
    for g in grounds():
        if only and g != only:
            continue
        for fi, flavour in enumerate(FLAVOURS):
            if flavour not in flavours:
                continue
            for i in range(per):
                seed = seed_for(g, flavour, i)
                out.append({
                    "ground": g, "flavour": flavour, "index": fi * per + i,
                    "seed": seed, "prompt": c["prompts"][g][flavour],
                    "palette_top": p[g]["top"],
                })
    return out


def _save(im, path):
    """Lossless WebP, the project image format. BOTH flags are non-default in Pillow
    and both matter: without `lossless` you silently get lossy VP8 and ringing on every
    hard pixel-art edge, without `exact` libwebp rewrites the RGB under fully
    transparent pixels."""
    im.convert("RGBA").save(path, "WEBP", lossless=True, exact=True)


def top_stats(im):
    """Distinct colours and dominant-tone share on the TOP FACE only — the surface
    these tiles are judged on, and the one number that separates the two flavours.
    (Reference: a deliberately flat matrix top measures 4 colours / 0.95 dominant, a
    textured base candidate 9-14 colours / 0.30-0.67. The wall is excluded because it
    is not part of the product here.)"""
    a = np.array(im.convert("RGBA"))
    m = transition_render.top_face(a[..., 3] > 0)
    px = a[..., :3][m]
    if not len(px):
        return None
    _, counts = np.unique(px.reshape(-1, 3), axis=0, return_counts=True)
    return {"colours": int(len(counts)),
            "dominant_share": round(float(counts.max() / counts.sum()), 4),
            "px": int(counts.sum())}


def _recover(client, purpose):
    """A sheet already bought under this purpose, pulled back for free. The registry
    is written BEFORE the images are saved, so a run killed mid-sheet leaves the
    tile_id findable and the art re-downloadable — `fetch_tiles` costs nothing."""
    reg = pixellab_gc.load().get("items", {})
    for tid, meta in reg.items():
        if meta.get("purpose") != purpose or meta.get("status") == "deleted":
            continue
        try:
            images = client.fetch_tiles(tid)
        except PixelLabError:
            continue
        if images:
            return images, tid
    return None, None


def write_sheet(job, images, tile_id, recovered=False):
    d = sheet_dir(job["ground"], job["flavour"], job["index"], job["seed"])
    os.makedirs(d, exist_ok=True)
    files, stats = [], []
    for j, im in enumerate(images):
        name = f"tile_{j:02d}.webp"
        _save(im, os.path.join(d, name))
        files.append(name)
        s = top_stats(im)
        stats.append(s)
    good = [s for s in stats if s]
    meta = {
        "schema": SCHEMA,
        "kind": KIND,
        "wall_is_meaningless": True,
        "not_a_candidate_for": "x over y",
        "ground": job["ground"],
        "flavour": job["flavour"],
        "index": job["index"],
        "seed": job["seed"],
        "prompt": job["prompt"],
        "palette_top": job["palette_top"],
        "tile_id": tile_id,
        "n_tiles": len(files),
        "tiles": files,
        "settings": matrix.FIXED,
        "usd": 0.0 if recovered else matrix.SHEET_USD,
        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "top_face": {
            "per_tile": stats,
            "mean_colours": round(sum(s["colours"] for s in good) / len(good), 2) if good else None,
            "mean_dominant_share": round(sum(s["dominant_share"] for s in good) / len(good), 4)
            if good else None,
        },
    }
    with open(os.path.join(d, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    return meta


def write_index():
    """Rebuild tiles/tops/index.json from what is on disk. Derived every time, so a
    sheet deleted by hand disappears from it and a crashed run cannot leave a phantom."""
    sheets = []
    for m in sorted(glob.glob(os.path.join(OUT, "*", "sheet_*", "meta.json"))):
        try:
            with open(m) as f:
                meta = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        d = os.path.dirname(m)
        sheets.append({
            "ground": meta.get("ground"), "flavour": meta.get("flavour"),
            "seed": meta.get("seed"), "prompt": meta.get("prompt"),
            "palette_top": meta.get("palette_top"), "tile_id": meta.get("tile_id"),
            "dir": os.path.relpath(d, REPO), "n_tiles": meta.get("n_tiles"),
            "tiles": meta.get("tiles", []),
            "top_face": {k: meta.get("top_face", {}).get(k)
                         for k in ("mean_colours", "mean_dominant_share")},
        })
    sheets.sort(key=lambda s: (s["ground"] or "", s["flavour"] or "", s["seed"] or 0))
    counts = {}
    for s in sheets:
        counts.setdefault(s["ground"], {"subtle": 0, "detail": 0})[s["flavour"]] += 1
    doc = {
        "schema": SCHEMA,
        "kind": KIND,
        "wall_is_meaningless": True,
        "_comment": (
            "TOP-ONLY ground tiles. Judged on the top surface alone; the wall and the "
            "overhang on these tiles are unjudged and unusable. NEVER offer a sheet listed "
            "here as an 'x over y' candidate, and never resolve one against "
            "tiles/review/manifest.json — nothing here is a cell. Two flavours: `subtle` is "
            "a base-tile-set member and must survive being repeated across a field, `detail` "
            "is a showpiece placed once in a while."
        ),
        "not_a_candidate_for": "x over y",
        "generator": "tiles/pipeline/tops.py",
        "prompts": "tiles/config/tops.json",
        "settings": matrix.FIXED,
        "sheet_usd": matrix.SHEET_USD,
        "top_face_note": (
            "mean_colours / mean_dominant_share measure the TOP FACE only "
            "(transition_render.top_face). Reference: a deliberately flat matrix top is "
            "4 colours / 0.95, a textured base candidate 9-14 / 0.30-0.67."
        ),
        "n_sheets": len(sheets),
        "n_tiles": sum(s["n_tiles"] or 0 for s in sheets),
        "counts": counts,
        "sheets": sheets,
    }
    os.makedirs(OUT, exist_ok=True)
    tmp = os.path.join(OUT, f"index.json.{os.getpid()}.tmp")
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    os.replace(tmp, os.path.join(OUT, "index.json"))
    return doc


def main():
    ap = argparse.ArgumentParser(description="Generate top-only ground tile sheets.")
    ap.add_argument("--per", type=int, default=3, help="sheets per flavour per ground")
    ap.add_argument("--max-usd", type=float, default=9.0, help="stop after spending this")
    ap.add_argument("--min-usd", type=float, default=5.0,
                    help="never spend below this shared-account balance")
    ap.add_argument("--only", default=None, help="restrict to one ground")
    ap.add_argument("--flavour", default=None, choices=FLAVOURS, help="restrict to one flavour")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--reindex", action="store_true", help="rebuild index.json and exit")
    args = ap.parse_args()

    if args.reindex:
        doc = write_index()
        print(f"index: {doc['n_sheets']} sheets, {doc['n_tiles']} tiles -> "
              f"{os.path.relpath(os.path.join(OUT, 'index.json'), REPO)}")
        return

    flavours = (args.flavour,) if args.flavour else FLAVOURS
    jobs = plan(only=args.only, flavours=flavours, per=args.per)
    todo = [j for j in jobs
            if not is_complete(find_sheet(j["ground"], j["flavour"], j["seed"]))]
    gs = sorted({j["ground"] for j in jobs})
    print(f"{len(gs)} ground(s) x {len(flavours)} flavour(s) x {args.per} = {len(jobs)} sheets; "
          f"{len(jobs) - len(todo)} already on disk, {len(todo)} to generate "
          f"~${len(todo) * matrix.SHEET_USD:.2f} ({len(todo) * 16} tiles)")

    if args.dry_run:
        cur = None
        for j in todo:
            if j["ground"] != cur:
                cur = j["ground"]
                print(f"  {cur}  (palette top {j['palette_top']})")
            print(f"    sheet_{j['index']:02d}_{j['flavour']}_{j['seed']}  "
                  f"\"{j['prompt']}\"")
        print("\ndry run — nothing generated, $0.00 spent")
        return

    client = PixelLabClient()
    spent = 0.0
    made = 0
    # Count OUR spend by counting sheets, not by watching the balance: the PixelLab
    # account is shared with the other domain agents, so the balance moves for reasons
    # that have nothing to do with this run. The absolute balance is still checked —
    # draining a shared account is the one thing a budget guard must prevent.
    for n, j in enumerate(todo, 1):
        # A HARD cap: stop before the sheet that would cross it, not after. Checking
        # `spent >= max` instead lets every run overshoot by one full sheet ($0.096),
        # which is the difference between a budget and a suggestion.
        if spent + matrix.SHEET_USD > args.max_usd:
            print(f"stopping: ${spent:.2f} spent, the next sheet would pass "
                  f"the ${args.max_usd:.2f} cap")
            break
        try:
            bal = client.credits_usd()
        except PixelLabError as e:
            print(f"stopping: cannot read balance ({str(e)[:120]})")
            break
        if bal < args.min_usd:
            print(f"stopping: shared-account balance ${bal:.2f} below floor ${args.min_usd:.2f}")
            break
        purpose = f"tops:{j['ground']}:{j['flavour']}:{j['seed']}"
        try:
            images, tile_id = _recover(client, purpose)
            recovered = bool(images)
            if not images:
                images, tile_id = client.create_tiles(
                    description=j["prompt"], seed=j["seed"], **matrix.FIXED)
                pixellab_gc.record(tile_id, purpose=purpose, prompt=j["prompt"])
                if not images and tile_id:
                    images = client.fetch_tiles(tile_id)   # paid for; never re-buy
            if not images:
                print(f"  ! {purpose} produced no tiles")
                continue
            meta = write_sheet(j, images, tile_id, recovered=recovered)
            if not recovered:
                spent += matrix.SHEET_USD
            made += 1
            print(f"  [{n}/{len(todo)}] {j['ground']} {j['flavour']} seed={j['seed']} "
                  f"{meta['n_tiles']} tiles  top={meta['top_face']['mean_colours']}c/"
                  f"{meta['top_face']['mean_dominant_share']}  "
                  f"{'recovered $0.00' if recovered else f'${matrix.SHEET_USD:.3f}'}  "
                  f"running ${spent:.2f}/${args.max_usd:.2f}", flush=True)
        except BudgetExhausted as e:
            print("stopping:", e)
            break
        except Exception as e:                 # one bad sheet must not kill the run
            print(f"  ! {purpose} failed: {str(e)[:160]}")
            traceback.print_exc(limit=1)
            time.sleep(5)
        finally:
            write_index()                      # index survives any exit, clean or not
    doc = write_index()
    print(f"done — {made} sheet(s) written, ~${spent:.2f} of our own spend; "
          f"index has {doc['n_sheets']} sheets / {doc['n_tiles']} tiles")


if __name__ == "__main__":
    main()
