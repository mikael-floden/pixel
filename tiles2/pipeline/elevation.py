"""Generate base_x_2 / base_x_3 / base_x_4 ELEVATION tiles.

These are themed TALL blocks (boulder, tree, crystal, mushroom, fortress, cliff …)
that stack pixel-perfectly on base_x_1: they share its exact 30px diamond top
(tile_size 64, view_angle 28, flat_top 2), so the walkable top surface lands in
the same place — only the side face grows to N * 16px. The per-type
tile_height / depth_ratio in config.elevation were calibrated so the measured
face is exactly N levels tall (see docs/ELEVATION.md).

Each type has TARGET_PER_TYPE sheets, one per DECORATION (config.elevation.types
[].decorations). Unlike ground types these get NO transitions and are NOT
colour-harmonised (they're multi-coloured props) — postprocess only softens the
outline and copies raw -> base/, stamping per-sheet metadata (decoration, levels,
face height) so map builders know what each tile is and how tall it stands.

  python tiles2/pipeline/elevation.py --dry-run    # show the plan, no API calls
  python tiles2/pipeline/elevation.py              # generate missing sheets + push
  python tiles2/pipeline/elevation.py --reprocess  # re-run postprocess from raw
  python tiles2/pipeline/elevation.py --max-units 3
"""

from __future__ import annotations

import argparse
import datetime
import json
import os

from PIL import Image

import common
import loop            # reuse commit_push (add/commit/push to main, with retries)
import normalize
from pixellab_client import BudgetExhausted, PixelLabClient, PixelLabError

TARGET_PER_TYPE = 5
LEVEL_PX = 16          # one elevation level = base_x_1's face height


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def types(cfg):
    return cfg["elevation"]["types"]


def _settings(cfg, et):
    t = cfg["tile"]
    return {
        "endpoint": "/create-tiles-pro", "tile_type": t["type"],
        "tile_size": et.get("tile_size", t["size"]), "tile_view": t["view"],
        "tile_view_angle": t["view_angle"], "tile_depth_ratio": et["depth_ratio"],
        "tile_height": et.get("tile_height"), "tile_flat_top_px": t["flat_top_px"],
        "levels": et["levels"], "face_px": et["levels"] * LEVEL_PX,
    }


def build_prompt(cfg, et, idx):
    e = cfg["elevation"]
    deco = et["decorations"][idx % len(et["decorations"])]
    prompt = e["template"].format(
        decoration=deco, height_word=et["height_word"], name=et["name"],
        style=e["style"], variations=e["variations"].format(name=et["name"]))
    return prompt, deco


def count_sheets(gid):
    return len(common.list_raw_sheets(gid, kind="elevation"))


def ensure_meta(et, cfg):
    gid = et["id"]
    if common.load_type_meta(gid):
        return
    common.save_type_meta(gid, {
        "schema": common.TYPE_SCHEMA, "ground_type": gid, "kind": "elevation",
        "name": et["name"], "levels": et["levels"],
        "description": (f"{et['name']} — themed tall blocks, {et['levels']} levels "
                        f"(face {et['levels'] * LEVEL_PX}px); stacks pixel-perfectly "
                        f"on base_x_1 (shared 30px diamond top)."),
        "settings": _settings(cfg, et), "decorations": et["decorations"],
    })


def generate_sheet(client, cfg, et):
    gid = et["id"]
    ensure_meta(et, cfg)
    idx = count_sheets(gid)
    prompt, deco = build_prompt(cfg, et, idx)
    seed = common._seed(gid, "elevation", idx)
    slug = f"base_{seed}"
    t = cfg["tile"]
    tiles, tile_id = client.create_tiles(
        description=prompt, tile_size=et.get("tile_size", t["size"]),
        tile_view=t["view"], view_angle=t["view_angle"], depth_ratio=et["depth_ratio"],
        tile_type=t["type"], flat_top_px=t["flat_top_px"],
        tile_height=et.get("tile_height"), seed=seed)

    sdir = os.path.join(common.raw_dir(gid), slug)
    os.makedirs(sdir, exist_ok=True)
    tile_meta = []
    for i, im in enumerate(tiles):
        fn = f"tile_{i:02d}.png"
        im.save(os.path.join(sdir, fn))
        tile_meta.append({"index": i, "file": fn, "width": im.width, "height": im.height})
    req = {
        "schema": common.RAW_SCHEMA, "sheet": slug, "ground_type": gid,
        "kind": "elevation", "transition_to": None, "tile_id": tile_id,
        "decoration": deco, "levels": et["levels"], "prompt": prompt,
        "settings": _settings(cfg, et), "seed": seed, "count": len(tile_meta),
        "tiles": tile_meta, "generated_at": _now(), "processed": False,
    }
    with open(os.path.join(sdir, "request.json"), "w") as f:
        json.dump(req, f, indent=2)
    return req


def process_sheet(gid, sheet, sdir, req, cfg):
    pp = cfg.get("postprocess") or {}
    neut = pp.get("neutralize_outline", True)
    thr = pp.get("darkness_thresh", 60)
    dest = os.path.join(common.base_dir(gid), sheet)
    os.makedirs(dest, exist_ok=True)
    raw_by_file = {t["file"]: t for t in (req.get("tiles") or [])}

    tiles_meta = []
    for fn in common.tile_files(sdir):
        im = Image.open(os.path.join(sdir, fn)).convert("RGBA")
        if neut:
            im = normalize.neutralize_outline(im, darkness_thresh=thr)
        im.save(os.path.join(dest, fn))
        entry = dict(raw_by_file.get(fn, {"file": fn}))
        entry["description"] = req.get("decoration")
        tiles_meta.append(entry)

    dest_meta = {
        "schema": "tiles2/sheet@1", "sheet": sheet, "ground_type": gid,
        "kind": "elevation", "decoration": req.get("decoration"),
        "levels": req.get("levels"), "face_px": (req.get("levels") or 0) * LEVEL_PX,
        "tile_id": req.get("tile_id"), "settings": req.get("settings"),
        "count": len(tiles_meta), "tiles": tiles_meta,
        "generated_at": req.get("generated_at"),
        "processing": {"neutralize_outline": neut, "harmonize": False},
    }
    with open(os.path.join(dest, "metadata.json"), "w") as f:
        json.dump(dest_meta, f, indent=2)

    req["processed"] = True
    req["processed_to"] = os.path.relpath(dest, common.type_dir(gid))
    with open(os.path.join(sdir, "request.json"), "w") as f:
        json.dump(req, f, indent=2)
    return len(tiles_meta)


def process_type(gid, cfg):
    total = 0
    for sheet, sdir, req in common.list_raw_sheets(gid, kind="elevation"):
        total += process_sheet(gid, sheet, sdir, req, cfg)
    return total


def next_type(cfg):
    for et in types(cfg):
        if count_sheets(et["id"]) < TARGET_PER_TYPE:
            return et
    return None


def main():
    ap = argparse.ArgumentParser(description="Generate tiles2 elevation blocks (base_x_2/3/4).")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--reprocess", action="store_true", help="re-run postprocess from raw; no API calls")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--max-units", type=int, default=0)
    args = ap.parse_args()
    cfg = common.load_config()

    if args.reprocess:
        for et in types(cfg):
            n = process_type(et["id"], cfg)
            if n:
                print(f"  {et['id']:9s} reprocessed {n} tile(s)")
        return

    if args.dry_run:
        for et in types(cfg):
            c = count_sheets(et["id"])
            print(f"  {et['id']}  {c}/{TARGET_PER_TYPE}  levels {et['levels']} "
                  f"face {et['levels'] * LEVEL_PX}px  depth {et['depth_ratio']} "
                  f"h {et.get('tile_height')}")
            for i, d in enumerate(et["decorations"]):
                print(f"      sheet {i}: {d}" + ("  [done]" if i < c else ""))
        nxt = next_type(cfg)
        print("next:", nxt["id"] if nxt else "== all elevation targets met ==")
        return

    client = PixelLabClient()
    min_gen = cfg["budget"]["min_generations_remaining"]
    min_usd = cfg["budget"].get("min_usd", 0.5)
    b = client.budget()
    print(f"elevation run — {b['generations']:.0f} generations, ${b['usd']:.2f} credits")
    units = 0
    while True:
        try:
            client.ensure_budget(min_gen, min_usd)
        except BudgetExhausted as e:
            print("stopping:", e); break
        et = next_type(cfg)
        if et is None:
            print("== all elevation targets met =="); break
        idx = count_sheets(et["id"])
        try:
            req = generate_sheet(client, cfg, et)
            process_type(et["id"], cfg)
        except PixelLabError as e:
            print(f"  ! {et['id']} sheet {idx} failed: {e}; stopping"); break
        desc = (f"tiles2: elevation {et['id']} sheet {idx + 1}/{TARGET_PER_TYPE} — "
                f"{req['decoration']} ({req['count']} tiles)")
        loop.commit_push(desc, push=not args.no_push)
        print("  +", desc)
        units += 1
        if args.max_units and units >= args.max_units:
            break
    print(f"done — {units} sheet(s)")


if __name__ == "__main__":
    main()
