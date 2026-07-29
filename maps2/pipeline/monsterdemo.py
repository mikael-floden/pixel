"""Monster demo world (maintainer 2026-07-29) — `monster_demo`.

One 5x5 PAD per monster (like prop_demo demos tile props, but bigger so the
monster can wander), floored with the tile the creature is expected to live on —
so the spawn area is easy to see/debug and the monster is judged against its
most likely ground. The pads sit on a neutral stone courtyard (every habitat
tile contrasts against it); the water pad is a swimmable pond.

The pads ARE the spawn zones: this builder writes its own explicit
`spawns.json` (pixel-maps2/spawns@1, one zone per pad, num 2, elev [0,0]) —
spawns.py skips monster_demo for that reason (BUILDER_OWNS).

    python maps2/pipeline/monsterdemo.py
    python maps2/pipeline/build.py monster_demo
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import worldio                                     # noqa: E402
from render2 import render_overview, save_minimap  # noqa: E402
from tiles2lib import Tiles2                       # noqa: E402
import spawns                                      # noqa: E402

MAPS2 = os.path.dirname(_HERE)

# roster order = pad order (row-major, 3 x 2). Habitat = the tile the creature
# most likely lives on (the maintainer's ask: see it against that ground).
HABITAT = {
    "poring": "saturated_grass",
    "lava_poring": "black_mountain",
    "forest_poring": "lightdark_dirt",   # forest floor
    "sand_poring": "light_sand",
    "water_poring": "clear_water",       # a pond — porings that swim
    "ice_poring": "crystal_ice",
}
BASE = "stone_mountain"                  # neutral courtyard every habitat pops on
PAD = 5
GAP = 5
MARGIN = 5
COLS = 3
NUM_PER_PAD = 2


def build(out: str | None = None):
    lib = Tiles2()
    kinds = spawns.roster_ids()
    for k in kinds:
        assert k in HABITAT, f"monster {k} has no habitat tile — extend HABITAT"
    rows = (len(kinds) + COLS - 1) // COLS
    W = MARGIN + COLS * PAD + (COLS - 1) * GAP + MARGIN
    H = MARGIN + rows * PAD + (rows - 1) * GAP + MARGIN
    mat = np.full((H, W), BASE, object)
    zones = []
    for i, kind in enumerate(kinds):
        cx = MARGIN + (i % COLS) * (PAD + GAP)
        cy = MARGIN + (i // COLS) * (PAD + GAP)
        mat[cy:cy + PAD, cx:cx + PAD] = HABITAT[kind]
        zones.append({
            "id": f"demo-{kind}", "monster": kind,
            "area": [[cx, cy], [cx + PAD, cy], [cx + PAD, cy + PAD], [cx, cy + PAD]],
            "elev": [0, 0], "num": NUM_PER_PAD,
        })
    top = np.empty((H, W), object)
    for y in range(H):
        for x in range(W):
            top[y, x] = lib.plain_tile(mat[y, x])
    out = out or os.path.join(MAPS2, "worlds", "monster_demo")
    os.makedirs(out, exist_ok=True)
    spawn = (MARGIN + PAD + GAP // 2 + 1, MARGIN + PAD // 2)  # courtyard between pads
    worldio.save_world(os.path.join(out, "world.json"), name="monster_demo",
                       mat=mat, top=top, spawn=spawn)
    with open(os.path.join(out, "spawns.json"), "w") as f:
        json.dump({"schema": spawns.SCHEMA, "world": "monster_demo",
                   "zones": zones}, f, separators=(",", ":"))
    world = worldio.load_world(os.path.join(out, "world.json"))
    save_minimap(out, render_overview(world, scale=1.0, transparent=True))
    n = spawns.validate_file("monster_demo")
    print(f"monster_demo {W}x{H}: {n} pad zone(s) ({', '.join(kinds)}), "
          f"spawn {spawn}, base {BASE}")


if __name__ == "__main__":
    build()
