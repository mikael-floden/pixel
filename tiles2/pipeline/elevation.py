"""Generate base_x_2 / base_x_3 / base_x_4 ELEVATION tiles per terrain.

Elevation tiles are TALLER variants of an existing terrain, stored as SIBLINGS of
that terrain's base/ folder:

    saturated_grass/
      base/        <- base_x_1 (height 1)
      base_x_2/    <- height 2   ┐ this module
      base_x_3/    <- height 3   │ (raw stays in ../raw, kind=elevation)
      base_x_4/    <- height 4   ┘

They stack pixel-perfectly on base_x_1: identical 30px diamond top (tile_size 64,
view_angle 28, flat_top 2) — only the side face grows to N*16px. The per-height
tile_height / depth_ratio in config.elevation.heights were calibrated so the
measured face is exactly N levels tall (see docs/ELEVATION.md).

Each (terrain, height) gets config.elevation.target_sheets_per_elev sheets, one
per decoration. Postprocess softens the outline and HARMONISES each tile toward
the terrain's own palette (config terrain.harmonize_refs) so greens/greys/blues
snap to the existing ground colours and the block blends into the scene; genuinely
distinct accents (mushroom red, wood brown) fall outside the target hue bands and
stay. No transitions. Raw is kept, so postprocess is re-runnable at zero API cost
(e.g. once a terrain that lacked a base sheet — its harmonise reference — gets one).

  python tiles2/pipeline/elevation.py --dry-run
  python tiles2/pipeline/elevation.py              # generate missing sheets + push
  python tiles2/pipeline/elevation.py --reprocess  # re-run postprocess from raw
  python tiles2/pipeline/elevation.py --max-units 4
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
import postprocess     # reuse type_target (per-terrain material colour)
from pixellab_client import BudgetExhausted, PixelLabClient, PixelLabError

LEVEL_PX = 16          # one elevation level = base_x_1's face height


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _elev(cfg):
    return cfg["elevation"]


def heights(cfg):
    return _elev(cfg)["heights"]


def terrains(cfg):
    return _elev(cfg)["terrains"]


def target_per_elev(cfg):
    return _elev(cfg).get("target_sheets_per_elev", 5)


def _height(cfg, height_id):
    return next(h for h in heights(cfg) if h["id"] == height_id)


def _settings(cfg, h):
    t = cfg["tile"]
    return {
        "endpoint": "/create-tiles-pro", "tile_type": t["type"],
        "tile_size": h.get("tile_size", t["size"]), "tile_view": t["view"],
        "tile_view_angle": t["view_angle"], "tile_depth_ratio": h["depth_ratio"],
        "tile_height": h.get("tile_height"), "tile_flat_top_px": t["flat_top_px"],
        "levels": h["levels"], "face_px": h["levels"] * LEVEL_PX,
    }


def build_prompt(cfg, terrain, height_id, idx):
    e = _elev(cfg)
    h = _height(cfg, height_id)
    decos = terrain["decorations"][height_id]
    deco = decos[idx % len(decos)]
    prompt = e["template"].format(
        decoration=deco, height_word=h["height_word"], style=e["style"],
        variations=e["variations"])
    return prompt, deco


def elev_raw_sheets(gid, height_id):
    """Raw elevation sheets of a terrain for one height (sorted by generation)."""
    out = [(n, d, m) for n, d, m in common.list_raw_sheets(gid, kind="elevation")
           if m.get("height") == height_id]
    out.sort(key=lambda s: s[2].get("generated_at", ""))
    return out


def count_sheets(gid, height_id):
    return len(elev_raw_sheets(gid, height_id))


def generate_sheet(client, cfg, terrain, height_id):
    gid = terrain["id"]
    h = _height(cfg, height_id)
    idx = count_sheets(gid, height_id)
    prompt, deco = build_prompt(cfg, terrain, height_id, idx)
    seed = common._seed(gid, height_id, idx)
    slug = f"{height_id}_{seed}"
    t = cfg["tile"]
    tiles, tile_id = client.create_tiles(
        description=prompt, tile_size=h.get("tile_size", t["size"]),
        tile_view=t["view"], view_angle=t["view_angle"], depth_ratio=h["depth_ratio"],
        tile_type=t["type"], flat_top_px=t["flat_top_px"],
        tile_height=h.get("tile_height"), seed=seed)

    sdir = os.path.join(common.raw_dir(gid), slug)
    os.makedirs(sdir, exist_ok=True)
    tile_meta = []
    for i, im in enumerate(tiles):
        fn = f"tile_{i:02d}.png"
        im.save(os.path.join(sdir, fn))
        tile_meta.append({"index": i, "file": fn, "width": im.width, "height": im.height})
    req = {
        "schema": common.RAW_SCHEMA, "sheet": slug, "ground_type": gid,
        "kind": "elevation", "height": height_id, "levels": h["levels"],
        "transition_to": None, "tile_id": tile_id, "decoration": deco,
        "prompt": prompt, "settings": _settings(cfg, h), "seed": seed,
        "count": len(tile_meta), "tiles": tile_meta, "generated_at": _now(),
        "processed": False,
    }
    with open(os.path.join(sdir, "request.json"), "w") as f:
        json.dump(req, f, indent=2)
    return req


def process_sheet(gid, terrain, sheet, sdir, req, cfg, cache):
    pp = postprocess._pp_cfg(cfg)
    hs = pp["harmonize"]
    height_id = req.get("height")
    dest = os.path.join(common.elev_dir(gid, height_id), sheet)
    os.makedirs(dest, exist_ok=True)

    # Harmonise toward the terrain's own palette(s): greens->grass, greys->stone,
    # blues->ice. Refs without a base sheet yet (no target) are skipped gracefully.
    refs = terrain.get("harmonize_refs") or [gid]
    ref_targets = [t for t in (postprocess.type_target(r, cfg, cache) for r in refs) if t]

    raw_by_file = {t["file"]: t for t in (req.get("tiles") or [])}
    tiles_meta = []
    for fn in common.tile_files(sdir):
        im = Image.open(os.path.join(sdir, fn)).convert("RGBA")
        if pp["neutralize_outline"]:
            im = normalize.neutralize_outline(im, darkness_thresh=pp["darkness_thresh"])
        for tgt in ref_targets:
            im = normalize.harmonize(im, tgt, hs["hue_strength"], hs["sat_strength"], hs["v_strength"])
        im.save(os.path.join(dest, fn))
        entry = dict(raw_by_file.get(fn, {"file": fn}))
        entry["description"] = req.get("decoration")
        tiles_meta.append(entry)

    dest_meta = {
        "schema": "tiles2/sheet@1", "sheet": sheet, "ground_type": gid,
        "kind": "elevation", "height": height_id, "levels": req.get("levels"),
        "face_px": (req.get("levels") or 0) * LEVEL_PX,
        "decoration": req.get("decoration"), "tile_id": req.get("tile_id"),
        "settings": req.get("settings"), "count": len(tiles_meta), "tiles": tiles_meta,
        "generated_at": req.get("generated_at"),
        "processing": {"neutralize_outline": pp["neutralize_outline"],
                       "harmonize": hs, "harmonize_refs": refs,
                       "harmonized": len(ref_targets)},
    }
    with open(os.path.join(dest, "metadata.json"), "w") as f:
        json.dump(dest_meta, f, indent=2)

    req["processed"] = True
    req["processed_to"] = os.path.relpath(dest, common.type_dir(gid))
    with open(os.path.join(sdir, "request.json"), "w") as f:
        json.dump(req, f, indent=2)
    return len(tiles_meta)


def process_terrain(cfg, terrain, cache=None):
    cache = {} if cache is None else cache
    gid = terrain["id"]
    total = 0
    for h in heights(cfg):
        for sheet, sdir, req in elev_raw_sheets(gid, h["id"]):
            total += process_sheet(gid, terrain, sheet, sdir, req, cfg, cache)
    return total


def next_unit(cfg):
    """(terrain, height_id) for the first (terrain, height) below target — heights
    inner so a terrain fills x2 then x3 then x4 before moving on."""
    tgt = target_per_elev(cfg)
    for terrain in terrains(cfg):
        for h in heights(cfg):
            if count_sheets(terrain["id"], h["id"]) < tgt:
                return terrain, h["id"]
    return None


def main():
    ap = argparse.ArgumentParser(description="Generate tiles2 elevation tiles (base_x_2/3/4 per terrain).")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--reprocess", action="store_true", help="re-run postprocess from raw; no API calls")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--max-units", type=int, default=0)
    args = ap.parse_args()
    cfg = common.load_config()
    cache = {}

    if args.reprocess:
        for terrain in terrains(cfg):
            n = process_terrain(cfg, terrain, cache)
            if n:
                print(f"  {terrain['id']:16s} reprocessed {n} tile(s)")
        return

    if args.dry_run:
        tgt = target_per_elev(cfg)
        for terrain in terrains(cfg):
            print(f"{terrain['id']}  (harmonize -> {', '.join(terrain.get('harmonize_refs') or [terrain['id']])})")
            for h in heights(cfg):
                c = count_sheets(terrain["id"], h["id"])
                print(f"    {h['id']}  {c}/{tgt}  levels {h['levels']} face {h['levels']*LEVEL_PX}px "
                      f"depth {h['depth_ratio']} h {h.get('tile_height')}")
        nxt = next_unit(cfg)
        print("next:", f"{nxt[0]['id']} {nxt[1]}" if nxt else "== all elevation targets met ==")
        return

    client = PixelLabClient()
    min_gen = cfg["budget"]["min_generations_remaining"]
    min_usd = cfg["budget"].get("min_usd", 0.5)
    tgt = target_per_elev(cfg)
    b = client.budget()
    print(f"elevation run — {b['generations']:.0f} generations, ${b['usd']:.2f} credits")
    units = 0
    while True:
        try:
            client.ensure_budget(min_gen, min_usd)
        except BudgetExhausted as e:
            print("stopping:", e); break
        unit = next_unit(cfg)
        if unit is None:
            print("== all elevation targets met =="); break
        terrain, height_id = unit
        idx = count_sheets(terrain["id"], height_id)
        try:
            req = generate_sheet(client, cfg, terrain, height_id)
            process_terrain(cfg, terrain, cache)
        except PixelLabError as e:
            print(f"  ! {terrain['id']} {height_id} sheet {idx} failed: {e}; stopping"); break
        desc = (f"tiles2: elevation {terrain['id']}/{height_id} sheet {idx + 1}/{tgt} — "
                f"{req['decoration']} ({req['count']} tiles)")
        loop.commit_push(desc, push=not args.no_push)
        print("  +", desc)
        units += 1
        if args.max_units and units >= args.max_units:
            break
    print(f"done — {units} sheet(s)")


if __name__ == "__main__":
    main()
