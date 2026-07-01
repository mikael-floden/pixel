"""The maps loop.

Each "unit" of work is one PixelLab operation OR one zone assembly:
  - generate a shared Wang tileset (assets/tilesets/<id>),
  - generate a shared map object (assets/objects/<id>),
  - assemble a zone (maps/<zone_id>/) from already-generated assets (free).

The loop derives the next missing unit purely by reading the filesystem, so it is
fully resumable. After each unit it rebuilds the mobile viewer and commits +
pushes to `main`. Bounded by --max-minutes / --max-units / budget.

Order: build the zone_plan in sequence (small islands first). For the first
un-built zone, generate any tilesets/objects it needs, then assemble it. Once the
plan is done, invent further islands from config.procedural_zones.

Run a bounded chunk (intended for a scheduled Routine):
  python maps/pipeline/loop.py --max-minutes 50
Other flags: --max-units N, --once, --no-push.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time

import assets
import layouts
import viewer_build
import zone as zonemod
from pixellab_client import BudgetExhausted, PixelLabClient

ROOT = os.path.dirname(os.path.dirname(__file__))
CONFIG = os.path.join(ROOT, "config", "maps.json")
REPO_ROOT = os.path.dirname(ROOT)


def load_config():
    with open(CONFIG) as f:
        return json.load(f)


# --- git --------------------------------------------------------------------

def _git(*args, check=True):
    return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True,
                          check=check)


def commit_push(message, push=True):
    _git("add", "-A")
    if not _git("status", "--porcelain").stdout.strip():
        return False
    _git("commit", "-m", message)
    if push:
        r = None
        for attempt in range(4):
            r = _git("push", "origin", "HEAD", check=False)
            if r.returncode == 0:
                break
            # Remote may have advanced (a concurrent domain loop); rebase + retry.
            _git("fetch", "origin", check=False)
            branch = _git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
            _git("rebase", f"origin/{branch}", check=False)
            time.sleep(2 ** (attempt + 1))
        if r is not None and r.returncode != 0:
            print("  ! push failed after retries:", r.stderr[:200])
    return True


# --- planning ---------------------------------------------------------------

def _procedural_zone_def(cfg, index):
    """Invent a zone_def beyond the explicit plan (Phase B: endless islands)."""
    pz = cfg["procedural_zones"]
    grids = pz["grids"]
    biomes = pz["biomes"]
    g = grids[index % len(grids)]
    biome = biomes[index % len(biomes)]
    zid = f"isle_{index:03d}"
    return {
        "id": zid, "kind": "island", "archetype": pz.get("archetype", "small_island"),
        "title": f"Uncharted Isle {index}", "description": "A procedurally generated small island.",
        "grid": {"width": g[0], "height": g[1]}, "seed": 1000 + index * 37,
        "levels": biome["levels"], "bands": biome["bands"],
        "block_levels": pz.get("block_levels", ["water"]),
        "objects": pz.get("objects", []), "density": pz.get("density", 0.1),
        "links": [{"kind": "dock", "id": "dock", "to_zone": None, "to_exit": None}],
    }


def _zone_unit(cfg, zdef):
    """Next missing unit for one zone: a tileset, then an object, then assembly.
    Returns an action tuple, or None if the zone is already built."""
    if zonemod.zone_exists(zdef["id"]):
        return None
    for tid in zdef["bands"]:
        if not assets.tileset_exists(tid):
            return ("tileset", tid)
    for oid in list(zdef.get("objects", [])) + list(zdef.get("houses", [])):
        if not assets.object_exists(oid):
            return ("object", oid)
    return ("zone", zdef)


def next_action(cfg):
    """Decide the next unit by reading the filesystem.

    Build the explicit zone_plan first (small islands first). Once every planned
    zone exists, invent further islands from config.procedural_zones — an endless
    Phase B, bounded only by budget/time/units."""
    for zdef in cfg["zone_plan"]:
        act = _zone_unit(cfg, zdef)
        if act:
            return act
    idx = 0
    while zonemod.zone_exists(_procedural_zone_def(cfg, idx)["id"]):
        idx += 1
    return _zone_unit(cfg, _procedural_zone_def(cfg, idx)) or ("all_complete",)


# --- one unit ---------------------------------------------------------------

def advance(client, cfg, push=True):
    action = next_action(cfg)
    kind = action[0]

    if kind == "tileset":
        spec = assets.tileset_spec(cfg, action[1])
        assets.generate_tileset(client, cfg, spec)
        desc = f"maps: tileset '{spec['id']}' ({spec['lower']} / {spec['upper']})"
    elif kind == "object":
        spec = assets.object_spec(cfg, action[1])
        assets.generate_object(client, cfg, spec)
        desc = f"maps: object '{spec['id']}' ({spec['description']})"
    elif kind == "zone":
        zdef = action[1]
        layout = layouts.build(cfg, zdef)
        m = zonemod.build_zone(cfg, zdef, layout)
        g = m["grid"]
        desc = (f"maps: zone '{zdef['id']}' ({zdef['kind']}/{zdef.get('archetype')}, "
                f"{g['width']}x{g['height']} tiles, {len(m['objects'])} objects)")
    elif kind == "all_complete":
        print("== all planned zones built ==")
        return None
    else:
        raise RuntimeError(f"unknown action {kind}")

    viewer_build.build()
    commit_push(desc, push=push)
    print("  +", desc)
    return desc


# --- main -------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Run the pixel maps factory loop.")
    ap.add_argument("--max-units", type=int, default=0, help="0 = unlimited")
    ap.add_argument("--max-minutes", type=float, default=0, help="0 = unlimited")
    ap.add_argument("--min-balance", type=int, default=None,
                    help="Stop when generations remaining drops below this.")
    ap.add_argument("--once", action="store_true", help="Do a single unit and exit.")
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()

    cfg = load_config()
    min_balance = args.min_balance if args.min_balance is not None \
        else cfg["budget"]["min_generations_remaining"]
    client = PixelLabClient()

    start = time.monotonic()
    units = 0
    rem = client.generations_remaining()
    print(f"maps loop starting — {rem:.0f} generations remaining (floor {min_balance})")

    while True:
        try:
            client.ensure_budget(min_balance)
            result = advance(client, cfg, push=not args.no_push)
        except BudgetExhausted as e:
            print(f"stopping: {e}")
            break
        if result is None:
            print("stopping: nothing left to generate")
            break
        units += 1
        if args.once or (args.max_units and units >= args.max_units):
            break
        if args.max_minutes and (time.monotonic() - start) / 60 >= args.max_minutes:
            print("stopping: time budget reached")
            break

    print(f"done — {units} unit(s), {client.generations_remaining():.0f} generations left")


if __name__ == "__main__":
    main()
