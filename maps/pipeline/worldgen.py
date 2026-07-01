"""Build the detailed World straight from the master plan.

This is the bridge: it samples the plan's terrain field (`biome_at`,
`elevation_at`, rivers, lake, coastline) into a concrete grid of cells the
isometric renderer can draw. The plan stays the single source of truth — change
the plan and the built world follows.

Landmarks (castle, town, villages) and roads are stamped on top afterwards by
`landmarks.py`; this module lays the natural terrain they sit on.
"""

from __future__ import annotations

import math

from noise import hash01
from plan import WorldPlan, default_plan
from world import Cell, Region, World

# plan biome kind -> ground tile category
BIOME_TILE = {
    "plains": "grass", "forest": "forest", "desert": "desert", "farm": "farm",
    "mountains": "stone", "snow": "snow", "beach": "sand",
    "lake": "water", "water": "water",
}

# per-terrain variant scatter: a small, calm-weighted set picked by hash (not a
# modular arithmetic pattern, which stripes). Mostly one base tile with sparse
# accents so each material reads as one surface, never a checkerboard/banding.
_VARIANTS = {
    "grass": [0, 0, 0, 0, 1, 2, 0, 3], "forest": [0, 0, 1, 0, 2, 0],
    "desert": [0, 0, 1, 0, 2], "sand": [0, 0, 0, 1, 3],
    "stone": [0, 0, 1, 2, 0, 3], "snow": [0, 0, 1, 4],
    "farm": [0, 0, 1, 4], "water": [0, 0, 0, 0, 0, 1],
}


def _variant(terrain: str, x: int, y: int, seed: int) -> int:
    s = _VARIANTS.get(terrain, [0])
    return s[int(hash01(x, y, seed) * len(s)) % len(s)]


def _river_carve(world: World, plan: WorldPlan) -> None:
    """Stamp the river polylines as water threading down the valleys the height
    field already cut, so the water sits in a gorge, not on a ridge."""
    for river in plan.rivers:
        pts = river.points
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            steps = int(math.hypot(bx - ax, by - ay)) + 1
            for i in range(steps + 1):
                t = i / steps
                x = int(round(ax + (bx - ax) * t))
                y = int(round(ay + (by - ay) * t))
                w = max(1, int(river.width))
                for dx in range(-w, w + 1):
                    for dy in range(-w, w + 1):
                        if dx * dx + dy * dy > w * w:
                            continue
                        cx, cy = x + dx, y + dy
                        if not world.in_bounds(cx, cy):
                            continue
                        c = world.at(cx, cy)
                        if c.terrain == "water" and c.role == "water":
                            continue  # already open sea
                        c.terrain, c.variant, c.role, c.level = "water", 1, "river", 0


def build_from_plan(plan: WorldPlan | None = None) -> World:
    plan = plan or default_plan()
    world = World(plan.width, plan.height, plan.seed)

    for x, y, c in world.cells():
        if not plan.is_land(x, y):
            lv = plan.land_value(x, y)
            c.terrain, c.role, c.level = "water", "water", 0
            c.variant = 3 if lv > 0.02 else _variant("water", x, y, plan.seed)
            continue
        if plan.lake_here(x, y):
            c.terrain, c.role, c.level = "water", "lake", 0
            c.variant = _variant("water", x, y, plan.seed)
            continue
        lv = plan.land_value(x, y)
        biome = "beach" if lv < 0.22 else plan.biome_at(x, y)
        c.terrain = BIOME_TILE.get(biome, "grass")
        c.role = biome
        c.level = plan.elevation_at(x, y)
        c.variant = _variant(c.terrain, x, y, plan.seed)

    _river_carve(world, plan)

    # carry the plan's regions/landmarks into the world for later passes
    world.regions = [
        Region(name=d.name, kind=d.kind, cx=d.cx, cy=d.cy) for d in plan.districts
    ]
    world.iteration = 1
    world.log.append(f"built from plan: {plan.title} "
                     f"({plan.width}x{plan.height}, {len(plan.nodes)} landmarks)")
    return world


if __name__ == "__main__":
    w = build_from_plan()
    from collections import Counter
    terr = Counter(c.terrain for _, _, c in w.cells())
    lvl = Counter(c.level for _, _, c in w.cells() if c.terrain != "water")
    print("terrain:", dict(terr))
    print("levels:", dict(sorted(lvl.items())))
