"""Generate the X-over-Y matrix: every ground type's top over every other type's wall.

Each cell gets SEVERAL sheets, deliberately. The maintainer's own history says the hard
pairs took 7-9 attempts before one came out clean, so a single sheet per cell would
mostly produce rejects. Every sheet is 16 tiles, so 2 sheets already gives 32
candidates to choose from, and the maintainer curates the winners in the wiki.

Ranking is by WALL quality, not by the top. The walls become every cliff and mountain
face in the game and postprocess cannot invent structure that was never generated,
whereas the flat top is essentially free (palette_snap rewrites the whole top surface).

Resumable: a cell with enough sheets on disk is skipped, so this can be stopped and
restarted, and it never pays twice for work already done. Every tile_id is registered
so pixellab_gc.py can delete whatever the maintainer rejects.

  python tiles/pipeline/matrix.py --dry-run
  python tiles/pipeline/matrix.py --sheets 2 --max-usd 40
  python tiles/pipeline/matrix.py --only grass          # one top material
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import flatness
import pixellab_gc
import tombstones
from pixellab_client import BudgetExhausted, PixelLabClient, PixelLabError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "matrix")
CFG = os.path.join(ROOT, "config", "tiles.json")

# Pinned house format. tile_view/size/type match all 531 of the maintainer's own
# X-over-Y sheets exactly; the angle/depth come from tiles2's shipping format. A
# mis-click on exactly these settings cost the maintainer an entire matrix once, so
# they live in ONE place and are recorded into every cell's meta.json.
SHEET_USD = 0.096   # measured per 16-tile sheet at this size

FIXED = dict(tile_size=64, tile_view="high top-down", view_angle=28.0,
             depth_ratio=0.5, tile_type="isometric", flat_top_px=2,
             outline_mode="segmentation")

# Two prompt styles per cell, both now asking for the MATERIAL rather than for a colour.
#
# Asking for a colour ("clean single colour green") buys a flat top we do not need:
# palette_snap overwrites the top with the palette colour anyway, and measured over the
# whole matrix, every tile the old flatness gate rejected came back at exactly ONE colour
# after postprocess. What a colour prompt cannot buy is the transition — told it is
# painting green, the generator draws a clean cut where the paint stops and the tile
# reads as green over soil. Told it is growing grass, it tufts the blades down over the
# edge, which is the property the maintainer scores ten stars and the one thing no
# postprocess can add, because the spill lives on the WALL and the wall is never touched.
#
# Read from config so there is ONE source of truth. These lived here as hardcoded
# lambdas while config/tiles.json carried its own unused copy, which is exactly how an
# edit lands in the wrong file and changes nothing.
def STYLE_PROMPTS(cfg_doc):
    p = cfg_doc["prompts"]
    return {"material": p["over"], "colour": p.get("over_colour", p["over"])}


def cfg():
    with open(CFG) as f:
        return json.load(f)


def cell_dir(top, side):
    return os.path.join(OUT, f"{top}__over__{side}")


def have_sheets(top, side):
    d = cell_dir(top, side)
    if not os.path.isdir(d):
        return 0
    return len([x for x in os.listdir(d) if x.startswith("sheet_")])


def score_sheet(paths):
    """Best tile in a sheet, ranked on the walls."""
    best = None
    for p in paths:
        q = flatness.wall_quality(p)
        if not q:
            continue
        f = flatness.faces(p)
        rec = {"path": os.path.basename(p), "wall": q,
               "top_share": round(f["top"]["share"], 4) if f and f["top"] else None}
        if not best or q["score"] > best["wall"]["score"]:
            best = rec
    return best


def generate_cell(client, top_g, side_g, style, sheets, seed0=11):
    top, side = top_g["id"], side_g["id"]
    d = cell_dir(top, side)
    os.makedirs(d, exist_ok=True)
    made = []
    for i in range(sheets):
        styles = STYLE_PROMPTS(cfg())
        style_name = list(styles)[i % len(styles)]
        prompt = styles[style_name].format(
            top_material=top_g["material_words"], side_material=side_g["material_words"],
            top_word=top_g["id"].replace("_", " "), side_word=side_g["id"].replace("_", " "),
            top_hex=top_g["hex"].lstrip("#"), side_hex=side_g["hex"].lstrip("#"),
            top_color=top_g["color_words"], side_color=side_g["color_words"])
        sdir = os.path.join(d, f"sheet_{len(os.listdir(d)):02d}_{style_name}")
        if os.path.isdir(sdir) and len(os.listdir(sdir)) > 2:
            continue
        os.makedirs(sdir, exist_ok=True)
        images, tile_id = client.create_tiles(
            description=prompt, seed=seed0 + i, **FIXED)
        pixellab_gc.record(tile_id, purpose=f"matrix:{top}_over_{side}", prompt=prompt)
        if not images and tile_id:
            images = client.fetch_tiles(tile_id)      # already paid for; never re-buy
        paths = []
        for j, im in enumerate(images):
            p = os.path.join(sdir, f"tile_{j:02d}.png")
            im.save(p)
            paths.append(p)
        best = score_sheet(paths)
        meta = {"top": top, "side": side, "style": style_name, "prompt": prompt,
                "tile_id": tile_id, "n_tiles": len(paths), "settings": FIXED,
                "best": best}
        with open(os.path.join(sdir, "meta.json"), "w") as f:
            json.dump(meta, f, indent=2)
        made.append(meta)
        print(f"    {top}/{side} [{style_name}] {len(paths)} tiles, "
              f"wall={best['wall']['score'] if best else '-'}", flush=True)
    return made


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheets", type=int, default=2, help="sheets per cell")
    ap.add_argument("--max-usd", type=float, default=30.0, help="stop after spending this")
    ap.add_argument("--min-usd", type=float, default=5.0, help="never spend below this balance")
    ap.add_argument("--only", default=None, help="restrict to one TOP material")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    c = cfg()
    types = c["ground_types"]
    pairs = [(t, s) for t in types for s in types
             if not args.only or t["id"] == args.only]
    # A DELETED cell is not an empty cell. The maintainer's rule is that deleting an
    # object means it should be gone, not regenerated — and without this check the
    # pipeline does the opposite by construction: matrix regenerates anything short of
    # its sheet target and pixellab_gc deletes what was rejected, so a deletion becomes
    # reject -> delete -> regenerate -> reject, an unbounded paid loop that keeps
    # resurrecting art already refused.
    dead = tombstones.load().get("cells", {})
    todo = [(t, s) for t, s in pairs
            if have_sheets(t["id"], s["id"]) < args.sheets
            and f"{t['id']}_over_{s['id']}" not in dead]
    if dead:
        print(f"skipping {len(dead)} tombstoned cell(s) — deleted, not to be regenerated")
    print(f"{len(pairs)} cells, {len(todo)} still need sheets "
          f"({args.sheets} each) -> ~{len(todo) * args.sheets} generations "
          f"~${len(todo) * args.sheets * 0.10:.0f}")
    if args.dry_run:
        for t, s in todo[:20]:
            print(f"  {t['id']} over {s['id']}")
        print("  ..." if len(todo) > 20 else "")
        return

    client = PixelLabClient()
    done = 0
    spent = 0.0
    # Track OUR spend by counting sheets, not by watching the balance. The PixelLab
    # account is shared with the other domain agents, so the balance moves for reasons
    # that have nothing to do with this run — a balance-delta guard read $1.90 for two
    # sheets that actually cost $0.19, and would have halted the run on someone else's
    # work. The absolute balance is still checked, since not draining the shared
    # account matters, but the budget itself is counted from what we generate.
    for t, s in todo:
        if spent >= args.max_usd:
            print(f"stopping: spent ~${spent:.2f} of ${args.max_usd:.2f}")
            break
        bal = client.credits_usd()
        if bal < args.min_usd:
            print(f"stopping: shared-account balance ${bal:.2f} below floor")
            break
        try:
            made = generate_cell(client, t, s, None, args.sheets)
            spent += SHEET_USD * len(made)
            done += 1
        except BudgetExhausted as e:
            print("stopping:", e)
            break
        except (PixelLabError, Exception) as e:      # one bad cell must not kill the run
            print(f"  ! {t['id']}/{s['id']} failed: {str(e)[:160]}")
            traceback.print_exc(limit=1)
            time.sleep(5)
    print(f"done — {done} cells, ~${spent:.2f} of our own spend")


if __name__ == "__main__":
    main()
