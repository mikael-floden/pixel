"""Generate base_x_2 … base_x_5 ELEVATION tiles per terrain.

Elevation tiles are TALLER variants of an existing terrain, stored as SIBLINGS of
that terrain's base/ folder:

    saturated_grass/
      base/        <- base_x_1 (height 1)
      base_x_2/    <- height 2   ┐ this module (all on a 64x128 canvas)
      base_x_3/    <- height 3   │ (raw stays in ../raw, kind=elevation)
      base_x_4/    <- height 4   │
      base_x_5/    <- height 5   ┘

They stack pixel-perfectly on base_x_1: identical 30px diamond top (tile_size 64,
view_angle 28, flat_top 2) — only the side face grows to N*16px. The per-height
depth_ratio in config.elevation.heights was calibrated so the measured face is
N levels tall (see docs/ELEVATION.md).

VARIETY: a sheet is NOT 16 clones of one object. For each sheet we take a
seed-shuffled subset (elevation.objects_per_sheet items) of that (terrain, height)
pool in config.elevation.objects_file and number them into one create-tiles-pro
call, so the returned tiles are many DIFFERENT objects (statues, dead trees,
mushrooms, runestones, cairns, crystals …). The target_sheets_per_elev sheets per
(terrain, height) each draw a different subset. Every tile is harmonised toward the
terrain's palette (terrain.harmonize_refs); distinct accents (mushroom red, wood
brown) fall outside the target hue bands and stay. No transitions.

Delete-in-UI -> re-roll: sync() runs at startup and drops any sheet whose PixelLab
tile_id 404s (raw + the processed base_x_N/ copy), reopening that slot. The next
run regenerates that slot with a FRESH seed (per-slot attempt counter in
elevation_state.json), so you get a brand-new shuffled set — not the same tiles.

  python tiles2/pipeline/elevation.py --dry-run
  python tiles2/pipeline/elevation.py              # sync, then fill open slots + push
  python tiles2/pipeline/elevation.py --reprocess  # re-run postprocess from raw
  python tiles2/pipeline/elevation.py --max-units 4
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import random

from PIL import Image

import common
import emission        # per-tile prop emission marking (night-glow metadata)
import loop            # reuse commit_push (add/commit/push to main, with retries)
import normalize
import postprocess     # reuse type_target (per-terrain material colour)
import sync            # drop UI-deleted sheets at startup
from pixellab_client import BudgetExhausted, PixelLabClient, PixelLabError

LEVEL_PX = 16          # one elevation level = base_x_1's face height
STATE_PATH = os.path.join(common.ROOT, "elevation_state.json")
_OBJECTS = None


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _elev(cfg):
    return cfg["elevation"]


def heights(cfg):
    return _elev(cfg)["heights"]


def terrains(cfg):
    return _elev(cfg)["terrains"]


def target_per_elev(cfg):
    return _elev(cfg).get("target_sheets_per_elev", 3)


def objects_per_sheet(cfg):
    return _elev(cfg).get("objects_per_sheet", 14)


def _height(cfg, height_id):
    return next(h for h in heights(cfg) if h["id"] == height_id)


def _objects(cfg):
    global _OBJECTS
    if _OBJECTS is None:
        with open(os.path.join(common.ROOT, "config", _elev(cfg)["objects_file"])) as f:
            _OBJECTS = json.load(f)
    return _OBJECTS


def pool(cfg, gid, height_id):
    return _objects(cfg).get(gid, {}).get(height_id, [])


# -- per-slot attempt counter (survives sheet deletion -> fresh re-roll) --------

def _load_state():
    if os.path.isfile(STATE_PATH):
        with open(STATE_PATH) as f:
            return json.load(f)
    return {}


def _save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2, sort_keys=True)


def _slot_key(gid, height_id, slot):
    return f"{gid}:{height_id}:{slot}"


# -- filesystem state --------------------------------------------------------

def elev_raw_sheets(gid, height_id):
    return [(n, d, m) for n, d, m in common.list_raw_sheets(gid, kind="elevation")
            if m.get("height") == height_id]


def present_slots(gid, height_id):
    return {m.get("slot") for _, _, m in elev_raw_sheets(gid, height_id)
            if m.get("slot") is not None}


def missing_slot(cfg, gid, height_id):
    have = present_slots(gid, height_id)
    for i in range(target_per_elev(cfg)):
        if i not in have:
            return i
    return None


def _settings(cfg, h):
    t = cfg["tile"]
    return {
        "endpoint": "/create-tiles-pro", "tile_type": t["type"],
        "tile_size": h.get("tile_size", t["size"]), "tile_view": t["view"],
        "tile_view_angle": t["view_angle"], "tile_depth_ratio": h["depth_ratio"],
        "tile_height": h.get("tile_height"), "tile_flat_top_px": t["flat_top_px"],
        "levels": h["levels"], "face_px": h["levels"] * LEVEL_PX,
    }


def build_prompt(cfg, terrain, height_id, slot, attempt):
    """Number a ROTATING window of the (terrain, height) object pool.

    The pool is shuffled ONCE with a stable per-(terrain,height) seed, then the
    window start advances by k for every (slot + attempt) step. So the 3 slots —
    and every re-roll of a slot (attempt bumps) — get a DIFFERENT slice of the
    pool, cycling through it before repeating, instead of the old behaviour where
    a pool <= k meant every sheet listed the whole pool reshuffled (which read as
    'the same sheet over and over')."""
    e = _elev(cfg)
    h = _height(cfg, height_id)
    gid = terrain["id"]
    p = pool(cfg, gid, height_id)
    picks = []
    if p:
        k = min(objects_per_sheet(cfg), len(p))
        order = list(p)                                  # each SLOT gets its own shuffle,
        random.Random(common._seed(gid, height_id, "order", slot)).shuffle(order)
        start = (attempt * k) % len(p)                   # so slots never alias each other;
        picks = [order[(start + i) % len(p)] for i in range(k)]   # re-rolls rotate within the slot
    objects = " ".join(f"{i + 1}) {o}" for i, o in enumerate(picks))
    prompt = e["template"].format(
        height_word=h["height_word"], flavor=terrain["flavor"],
        objects=objects, style=e["style"])
    return prompt, picks


def generate_sheet(client, cfg, terrain, height_id, slot):
    gid = terrain["id"]
    h = _height(cfg, height_id)

    state = _load_state()
    key = _slot_key(gid, height_id, slot)
    attempt = int(state.get(key, 0))
    seed = common._seed(gid, height_id, slot, attempt)   # salts the generation
    state[key] = attempt + 1
    _save_state(state)

    prompt, picks = build_prompt(cfg, terrain, height_id, slot, attempt)
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
        "transition_to": None, "tile_id": tile_id, "slot": slot, "attempt": attempt,
        "objects": picks, "prompt": prompt, "settings": _settings(cfg, h), "seed": seed,
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
    emit_target = postprocess.type_target(gid, cfg, cache)   # material colour for glow gating
    tiles_meta = []
    n_emit = 0
    for fn in common.tile_files(sdir):
        im = Image.open(os.path.join(sdir, fn)).convert("RGBA")
        if pp["neutralize_outline"]:
            im = normalize.neutralize_outline(im, darkness_thresh=pp["darkness_thresh"])
        for tgt in ref_targets:
            im = normalize.harmonize(im, tgt, hs["hue_strength"], hs["sat_strength"], hs["v_strength"])
        im.save(os.path.join(dest, fn))
        entry = dict(raw_by_file.get(fn, {"file": fn}))
        # Per-tile emission so the glowing PROPS (crystals, lava, mushrooms, lamps,
        # fires) are tile-indexed in the SAME metadata maps2 already reads — computed
        # on the FINAL harmonised image. Mark features:["shiny"] (the tag maps2's
        # emissive gate keys on) plus a structured `emission` block for night halos.
        emis = emission.tile_emission(gid, im, emit_target)
        if emis:
            entry["emission"] = emis
            feats = list(entry.get("features") or [])
            if "shiny" not in feats:
                feats.append("shiny")
            entry["features"] = feats
            n_emit += 1
        tiles_meta.append(entry)

    dest_meta = {
        "schema": "tiles2/sheet@1", "sheet": sheet, "ground_type": gid,
        "kind": "elevation", "height": height_id, "levels": req.get("levels"),
        "face_px": (req.get("levels") or 0) * LEVEL_PX, "slot": req.get("slot"),
        "objects": req.get("objects"), "tile_id": req.get("tile_id"),
        "settings": req.get("settings"), "count": len(tiles_meta), "tiles": tiles_meta,
        "emissive_tiles": n_emit,
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


def next_unit(cfg, skip=None, only=None):
    """(terrain, height_id, slot) for the first open sheet slot — heights inner so
    a terrain fills x2 then x3/x4/x5 before moving on. `skip` holds
    (gid, height, slot) tuples that failed this run, so one flaky/stalled job
    doesn't get retried forever and doesn't stall the rest of the fleet. `only`
    restricts filling to a single terrain."""
    skip = skip or set()
    tgt = target_per_elev(cfg)
    for terrain in terrains(cfg):
        if only and terrain["id"] != only:
            continue
        for h in heights(cfg):
            have = present_slots(terrain["id"], h["id"])
            for i in range(tgt):
                if i not in have and (terrain["id"], h["id"], i) not in skip:
                    return terrain, h["id"], i
    return None


def _run_sync(cfg, client, push):
    removed = sync.sync(cfg, client)
    for gid, sheet in removed:
        print(f"  - synced out {gid}/{sheet} (deleted in PixelLab)")
    if removed:
        loop.commit_push(f"tiles2: sync — drop {len(removed)} sheet(s) deleted in PixelLab", push=push)
    return removed


def main():
    ap = argparse.ArgumentParser(description="Generate tiles2 elevation tiles (base_x_2…5 per terrain).")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--reprocess", action="store_true", help="re-run postprocess from raw; no API calls")
    ap.add_argument("--no-sync", action="store_true", help="skip the startup UI-deletion sync")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--max-units", type=int, default=0)
    ap.add_argument("--max-retries", type=int, default=3,
                    help="how many times to retry a slot that hits a PixelLab stall "
                         "(0.49 hang) with a fresh seed before giving up (default 3)")
    ap.add_argument("--min-usd", type=float, default=None,
                    help="override the USD credit floor (default from config); use to "
                         "spend down remaining credits")
    ap.add_argument("--only", metavar="TERRAIN", default=None,
                    help="fill only this terrain's elevation slots; leave others untouched")
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
                have = present_slots(terrain["id"], h["id"])
                print(f"    {h['id']}  {len(have)}/{tgt}  levels {h['levels']} face {h['levels']*LEVEL_PX}px "
                      f"depth {h['depth_ratio']} pool {len(pool(cfg, terrain['id'], h['id']))}")
        nxt = next_unit(cfg, only=args.only)
        print("next:", f"{nxt[0]['id']} {nxt[1]} slot {nxt[2]}" if nxt else "== all elevation targets met ==")
        return

    client = PixelLabClient()
    min_gen = cfg["budget"]["min_generations_remaining"]
    min_usd = args.min_usd if args.min_usd is not None else cfg["budget"].get("min_usd", 0.5)
    tgt = target_per_elev(cfg)
    b = client.budget()
    print(f"elevation run — {b['generations']:.0f} generations, ${b['usd']:.2f} credits")
    if not args.no_sync:
        _run_sync(cfg, client, push=not args.no_push)

    units = 0
    skip = set()
    fails = {}                     # (gid,height,slot) -> failures so far this run
    while True:
        try:
            client.ensure_budget(min_gen, min_usd)
        except BudgetExhausted as e:
            print("stopping:", e); break
        unit = next_unit(cfg, skip, only=args.only)
        if unit is None:
            print("== all elevation targets met ==" if not skip else
                  f"== gave up on {len(skip)} slot(s) after {args.max_retries} tries each =="); break
        terrain, height_id, slot = unit
        key = (terrain["id"], height_id, slot)
        try:
            req = generate_sheet(client, cfg, terrain, height_id, slot)
            process_terrain(cfg, terrain, cache)
        except BudgetExhausted as e:
            print("stopping:", e); break
        except PixelLabError as e:
            # PixelLab jobs sometimes stall at progress~0.49 server-side. That's
            # transient, so RE-QUEUE the slot (generate_sheet already bumps the
            # attempt counter -> a fresh seed next try) up to --max-retries before
            # giving up, so one run fills the gaps instead of leaving them for a
            # manual re-run.
            fails[key] = fails.get(key, 0) + 1
            if fails[key] >= args.max_retries:
                print(f"  ! {terrain['id']} {height_id} slot {slot} failed "
                      f"{fails[key]}x ({e}); giving up for this run")
                skip.add(key)
            else:
                print(f"  ~ {terrain['id']} {height_id} slot {slot} stalled "
                      f"(try {fails[key]}/{args.max_retries}); retrying with a fresh seed")
            continue
        desc = (f"tiles2: elevation {terrain['id']}/{height_id} sheet {slot + 1}/{tgt} — "
                f"{req['count']} tiles, {len(req['objects'])} varied objects")
        loop.commit_push(desc, push=not args.no_push)
        print("  +", desc)
        units += 1
        if args.max_units and units >= args.max_units:
            break
    print(f"done — {units} sheet(s)")


if __name__ == "__main__":
    main()
