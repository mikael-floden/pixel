"""Build a maps2 test world: generate -> save -> render all views.

    python maps2/pipeline/build.py ring_test              # default ring/donut
    python maps2/pipeline/build.py ring_test --n 160 --seed 7
    python maps2/pipeline/build.py ring_test --render-only

Outputs under maps2/worlds/<name>/:
    world.json        source of truth (tile paths + level + material per cell)
    minimap.png       top-down chart with spawn marker
    overview.png      whole map in isometric
    border_*.png      full-res close-ups of every transition, to evaluate them
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

from ringworld import SLICES, WATER, generate, save          # noqa: E402
from render2 import Ctx, render_minimap, render_overview, render_window  # noqa: E402
from tiles2lib import Tiles2                                  # noqa: E402

MAPS2 = os.path.dirname(_HERE)


def border_windows(world):
    """Cell windows centred on each transition to evaluate."""
    n = world.n
    cx = cy = n / 2.0
    r_water = world.meta["r_water"]
    r_out = world.meta["r_out"]
    wins = {}
    half = max(14, int(n * 0.11))
    # radial seams between slice i and i+1, sampled at mid radius
    r_mid = (r_water + r_out) / 2
    for i in range(len(SLICES)):
        a, b = SLICES[i], SLICES[(i + 1) % len(SLICES)]
        theta = ((i + 1) * 2 * math.pi / len(SLICES))
        bx = int(cx + r_mid * math.cos(theta))
        by = int(cy + r_mid * math.sin(theta))
        wins[f"seam_{a}__{b}"] = (bx - half, by - half, bx + half, by + half)
    # each slice's shore (slice <-> water) at inner radius
    for i, g in enumerate(SLICES):
        theta = (i + 0.5) * 2 * math.pi / len(SLICES)
        bx = int(cx + (r_water + 3) * math.cos(theta))
        by = int(cy + (r_water + 3) * math.sin(theta))
        wins[f"shore_{g}"] = (bx - half, by - half, bx + half, by + half)
    # the whole inner hub (water + all shores)
    hh = int(r_water + 10)
    wins["hub"] = (int(cx) - hh, int(cy) - hh, int(cx) + hh, int(cy) + hh)
    return wins


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("name", nargs="?", default="ring_test")
    ap.add_argument("--n", type=int, default=160)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--no-borders", action="store_true")
    args = ap.parse_args()

    if args.name == "prop_demo":
        import propdemo
        propdemo.build(os.path.join(MAPS2, "worlds", "prop_demo"))
        return
    if args.name == "demo_isle":
        import demoworld
        demoworld.build(os.path.join(MAPS2, "worlds", "demo_isle"))
        return
    if args.name == "trans_demo":
        import transdemo
        transdemo.build(os.path.join(MAPS2, "worlds", "trans_demo"))
        return

    out = os.path.join(MAPS2, "worlds", args.name)
    os.makedirs(out, exist_ok=True)
    wpath = os.path.join(out, "world.json")

    lib = Tiles2()
    if args.render_only and os.path.isfile(wpath):
        world = _load(wpath, lib)
        print(f"loaded {world.n}x{world.n}")
    else:
        t0 = time.time()
        world = generate(args.n, seed=args.seed, lib=lib)
        print(f"generated {world.n}x{world.n} in {time.time()-t0:.1f}s "
              f"({len(world.paths)} distinct tiles)")
        save(world, wpath)
        print(f"wrote {wpath} ({os.path.getsize(wpath)//1024}KB)")

    ctx = Ctx(world, lib)
    render_minimap(world).save(os.path.join(out, "minimap.png"))
    print("minimap ok")
    t0 = time.time()
    render_overview(world, scale=0.42).save(os.path.join(out, "overview.png"))
    print(f"overview {time.time()-t0:.1f}s")

    if not args.no_borders:
        for name, (x0, y0, x1, y1) in border_windows(world).items():
            x0, y0 = max(0, x0), max(0, y0)
            x1, y1 = min(world.n, x1), min(world.n, y1)
            img = render_window(world, x0, y0, x1, y1, ctx)
            img.save(os.path.join(out, f"border_{name}.png"))
        print("borders ok")


def _load(path, lib):
    import json
    import numpy as np
    from ringworld import RingWorld
    d = json.load(open(path))
    REPO = os.path.dirname(MAPS2)
    n = d["meta"]["n"]
    w = RingWorld(n, d["meta"]["seed"])
    w.meta = d["meta"]
    w.paths = [os.path.join(REPO, p) for p in d["paths"]]
    w.top = np.array(d["top"], np.int32)
    w.mirror = np.array(d.get("mirror",
                              np.zeros_like(w.top)), bool)
    w.level = np.array(d["level"], np.int16)
    inv = {v: k for k, v in d["matids"].items()}
    matarr = np.array(d["mat"], np.uint8)
    w.mat = np.vectorize(lambda i: inv[i])(matarr)
    w.spawn = tuple(d["meta"]["spawn"])
    return w


if __name__ == "__main__":
    main()
