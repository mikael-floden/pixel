"""Maps agent entrypoint: grow / edit / render the world, one unit at a time.

Usage:
    python maps/pipeline/build.py --init          # lay the first draft
    python maps/pipeline/build.py --iterate       # one improvement (default)
    python maps/pipeline/build.py --steps 5       # several improvements
    python maps/pipeline/build.py --render-only   # just re-render current world
    python maps/pipeline/build.py --scale 2       # bigger PNG (nearest-neighbor)

The world lives at maps/world/world.json (source of truth) and renders to
maps/world/world.png. Each call mirrors the repo's per-unit rhythm: mutate the
world a little, re-render, and (optionally) it's ready to commit + push.
"""

from __future__ import annotations

import argparse
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)  # so sibling modules import cleanly under any cwd

from designer import iterate                  # noqa: E402
from landmarks import stamp_all                # noqa: E402
from plan import default_plan, render_schematic  # noqa: E402
from render import render                      # noqa: E402
from tileset import TileSet                    # noqa: E402
from world import World                        # noqa: E402
from worldgen import build_from_plan           # noqa: E402

MAPS_DIR = os.path.dirname(_HERE)
WORLD_JSON = os.path.join(MAPS_DIR, "world", "world.json")
WORLD_PNG = os.path.join(MAPS_DIR, "world", "world.png")
PLAN_PNG = os.path.join(MAPS_DIR, "world", "plan.png")
CONFIG = os.path.join(MAPS_DIR, "config", "world.json")


def _render_plan(plan) -> None:
    img = render_schematic(plan)
    os.makedirs(os.path.dirname(PLAN_PNG), exist_ok=True)
    img.save(PLAN_PNG)
    print(f"plan: {plan.title}  {plan.width}x{plan.height}  "
          f"{len(plan.districts)} districts, {len(plan.nodes)} landmarks")
    print(f"wrote {PLAN_PNG}  ({img.width}x{img.height})")


def _config_defaults() -> dict:
    import json
    try:
        with open(CONFIG) as f:
            return json.load(f).get("world", {})
    except FileNotFoundError:
        return {}


def main() -> None:
    ap = argparse.ArgumentParser(description="Grow/edit/render the pixel world.")
    ap.add_argument("--init", action="store_true", help="(re)initialize the world")
    ap.add_argument("--iterate", action="store_true", help="apply one improvement")
    ap.add_argument("--steps", type=int, default=0, help="apply N improvements")
    ap.add_argument("--render-only", action="store_true", help="only re-render")
    ap.add_argument("--plan", action="store_true",
                    help="render the bird's-eye world plan (schematic) and exit")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--scale", type=int, default=1)
    args = ap.parse_args()

    cfg = _config_defaults()
    seed = args.seed if args.seed is not None else cfg.get("seed", 7)

    # The master plan (the bigger picture) always renders; the detailed world is
    # built into that plan.
    plan = default_plan(seed=seed)
    _render_plan(plan)
    if args.plan:
        return

    tiles = TileSet()

    if args.init or not os.path.isfile(WORLD_JSON):
        world = build_from_plan(plan)
        stamp_all(world, plan)
        print("init:", world.log[-1])
    else:
        world = World.load(WORLD_JSON)
        print("loaded existing world")

    if not args.render_only:
        n = args.steps if args.steps > 0 else (1 if args.iterate else 0)
        for _ in range(n):
            print("iter:", iterate(world))

    world.save(WORLD_JSON)
    img = render(world, tiles, scale=args.scale)
    os.makedirs(os.path.dirname(WORLD_PNG), exist_ok=True)
    img.save(WORLD_PNG)
    print(f"world: {world.width}x{world.height}  iteration={world.iteration}  "
          f"regions={len(world.regions)}")
    print(f"wrote {WORLD_JSON}")
    print(f"wrote {WORLD_PNG}  ({img.width}x{img.height})")


if __name__ == "__main__":
    main()
