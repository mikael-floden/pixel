"""Build the MMORPG-scale world: generate -> save -> render all outputs.

    python maps/pipeline/buildworld.py             # full 512x448 build
    python maps/pipeline/buildworld.py --size 256x224 --seed 11
    python maps/pipeline/buildworld.py --render-only   # re-render from saved json

Outputs in maps/world/:
    world.json      the source of truth (compact arrays; the game reads this)
    minimap.png     top-down chart (census colors + hillshade)
    overview.png    the whole continent in isometric (banded render, downscaled)
    showcase_*.png  full-resolution windows on signature places
"""

from __future__ import annotations

import argparse
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

from bigworld import BigWorld            # noqa: E402
from bigrender import (RenderCtx, render_minimap, render_overview,  # noqa: E402
                       render_window)

MAPS = os.path.dirname(_HERE)
OUT = os.path.join(MAPS, "world")

SHOWCASES = {   # name -> cell rect (fractions) — signature places
    "hub_lake":   (0.42, 0.46, 0.53, 0.56),
    "canyon":     (0.06, 0.58, 0.22, 0.74),
    "glacier":    (0.30, 0.03, 0.44, 0.15),
    "farmland":   (0.46, 0.63, 0.58, 0.75),
    "volcano":    (0.855, 0.845, 0.955, 0.945),
    "fen":        (0.60, 0.72, 0.74, 0.84),
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", default="512x448")
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--no-overview", action="store_true")
    args = ap.parse_args()

    path = os.path.join(OUT, "world.json")
    if args.render_only and os.path.isfile(path):
        world = BigWorld.load(path)
        print(f"loaded {world.w}x{world.h}")
    else:
        from genesis import generate
        w, h = (int(v) for v in args.size.split("x"))
        t0 = time.time()
        world = generate(w, h, seed=args.seed)
        print(f"generated in {time.time()-t0:.1f}s — {world.log[-1]}")
        world.save(path)
        print(f"wrote {path} ({os.path.getsize(path)//1024}KB)")

    ctx = RenderCtx(world)

    t0 = time.time()
    render_minimap(world).save(os.path.join(OUT, "minimap.png"))
    print(f"minimap {time.time()-t0:.1f}s")

    for name, (fx0, fy0, fx1, fy1) in SHOWCASES.items():
        t0 = time.time()
        img = render_window(world, int(fx0 * world.w), int(fy0 * world.h),
                            int(fx1 * world.w), int(fy1 * world.h), ctx)
        img.save(os.path.join(OUT, f"showcase_{name}.png"))
        print(f"showcase_{name} {img.size} {time.time()-t0:.1f}s")

    if not args.no_overview:
        t0 = time.time()
        render_overview(world, scale=0.25).save(os.path.join(OUT, "overview.png"))
        print(f"overview {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
