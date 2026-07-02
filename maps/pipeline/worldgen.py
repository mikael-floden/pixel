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
    "grass": [0, 0, 0, 0, 0, 1, 2, 0], "forest": [0, 0, 1, 0, 2, 0],
    "desert": [0, 0, 1, 0, 2], "sand": [0, 0, 0, 1, 3],
    "stone": [0, 0, 1, 2, 0, 3], "snow": [0, 0, 1, 4],
    "farm": [0, 0, 1, 4], "water": [0, 0, 0, 0, 0, 1],
}


def _variant(terrain: str, x: int, y: int, seed: int) -> int:
    s = _VARIANTS.get(terrain, [0])
    return s[int(hash01(x, y, seed) * len(s)) % len(s)]


def _river_carve(world: World, plan: WorldPlan) -> None:
    """Stamp the river polylines as TERRACED water: the river keeps the level of
    the valley floor it flows through and only steps down (never up) on its way
    to the sea. Each step down renders as stacked water tiles — a blue waterfall
    face — so the river visibly cascades from the highlands, ALTTP-style."""
    for river in plan.rivers:
        pts = river.points
        lvl = None
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            steps = int(math.hypot(bx - ax, by - ay)) + 1
            for i in range(steps + 1):
                t = i / steps
                x = int(round(ax + (bx - ax) * t))
                y = int(round(ay + (by - ay) * t))
                here = plan.elevation_at(x, y)
                lvl = here if lvl is None else min(lvl, here)
                w = max(1, int(river.width))
                for dx in range(-w, w + 1):
                    for dy in range(-w, w + 1):
                        if dx * dx + dy * dy > w * w:
                            continue
                        cx, cy = x + dx, y + dy
                        if not world.in_bounds(cx, cy):
                            continue
                        c = world.at(cx, cy)
                        if c.terrain == "water" and c.role in ("water", "lake"):
                            continue  # already open sea / lake
                        c.terrain, c.variant, c.role = "water", 1, "river"
                        c.level = lvl


def _neighbors4(world: World, x, y):
    for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
        if world.in_bounds(nx, ny):
            yield world.at(nx, ny)


def _smooth_terrain(world: World) -> None:
    """Design-cleanup passes over the raw sampled terrain:
    - knock down 1-cell elevation spikes (they read as litter, not hills);
    - drown orphan 1-cell islands (no 4-connected land neighbour);
    - drop 1-cell water bumps so connected water reads at one level."""
    for _ in range(2):
        for x, y, c in world.cells():
            if c.terrain == "water":
                wn = [n.level for n in _neighbors4(world, x, y) if n.terrain == "water"]
                if wn and all(l < c.level for l in wn):
                    c.level = max(wn)
                continue
            ln = [n for n in _neighbors4(world, x, y) if n.terrain != "water"]
            if not ln:
                c.terrain, c.role, c.level, c.variant = "water", "water", 0, 0
                continue
            if len(ln) >= 3 and all(n.level < c.level for n in ln):
                c.level = max(n.level for n in ln)


def _water_polish(world: World) -> None:
    """One water family, placed by a depth rule: ripple/shallow tiles ONLY in
    the 1-cell ring where water touches land; calm deep tile everywhere else
    (which also matches the flat ocean background); rivers keep their own tile."""
    for x, y, c in world.cells():
        if c.terrain != "water":
            continue
        touches_land = any(n.terrain != "water" for n in _neighbors4(world, x, y))
        if c.role == "river":
            c.variant = 1
        elif touches_land:
            c.variant = 3
        else:
            c.variant = 0


def vegetate(world: World, plan: WorldPlan) -> int:
    """Scatter the objects domain's trees over the natural terrain: dense mixed
    pine/oak canopy in the forests, sparse lone oaks across the plains. Runs
    AFTER landmarks so nothing grows on roads, plazas or set-pieces."""
    placed = 0
    for x, y, c in world.cells():
        if c.object or c.terrain == "water":
            continue
        r = hash01(x, y, plan.seed + 77)
        if c.role == "forest" and c.terrain == "forest":
            if r < 0.34:
                c.object = "pine_tree" if hash01(x, y, plan.seed + 78) < 0.7 else "oak_tree"
                placed += 1
        elif c.role == "woodland":
            if r < 0.45:
                c.object = "oak_tree" if hash01(x, y, plan.seed + 78) < 0.7 else "pine_tree"
                placed += 1
        elif c.role == "plains" and c.level <= 2:
            if r < 0.015:
                c.object = "oak_tree"
                placed += 1
        elif c.role == "snow" and c.level >= 1:
            if r < 0.05:
                c.object = "pine_tree"
                placed += 1
    return placed


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
        biome = plan.biome_at(x, y)
        # sand beaches only where the coast is soft; hard biomes (mountains,
        # snow) run their stone straight into the sea as cliffs
        from plan import _COAST_SINK
        if lv < 0.22 and _COAST_SINK.get(biome, 1.0) > 0.6:
            biome = "beach"
        if plan.in_marsh(x, y):
            # the Lantern Delta: a reedy dither of dark water and tall grass
            c.level = 0
            c.role = "marsh"
            if hash01(x, y, plan.seed + 41) < 0.45:
                c.terrain, c.variant = "water", 5
            else:
                c.terrain, c.variant = "grass", 3
            continue
        c.terrain = BIOME_TILE.get(biome, "grass")
        c.role = biome
        c.level = plan.elevation_at(x, y)
        c.variant = _variant(c.terrain, x, y, plan.seed)

    _river_carve(world, plan)
    _smooth_terrain(world)
    _water_polish(world)

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
