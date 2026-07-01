"""Stamp the plan's landmarks and roads onto the built terrain.

The plan says *where* Aldermoor Castle, Saltmarsh Harbor and the villages stand
and how the King's Road connects them; this module builds them in the tiles: a
walled keep on its plateau, a harbor town, fenced hamlets, and A* roads that
prefer flat, dry ground and bridge water only where they must. Uses the tall
`castle_wall` / `town_wall` tiles so the castle actually looks like a castle.
"""

from __future__ import annotations

import math

from designer import lay_road, route_road           # reuse the A* road layer
from plan import WorldPlan
from world import Region, World


def _flatten(world: World, x0, y0, x1, y1, level, terrain, role, variant=0):
    """Level a footprint to one plateau height and pave it (skipping water)."""
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if not world.in_bounds(x, y):
                continue
            c = world.at(x, y)
            if c.terrain == "water":
                continue
            c.terrain, c.variant, c.level, c.role = terrain, variant, level, role


def build_castle(world: World, plan: WorldPlan) -> tuple[int, int] | None:
    node = plan.nodes.get("castle")
    if not node:
        return None
    cx, cy = int(node.x), int(node.y)
    if not world.in_bounds(cx, cy) or world.at(cx, cy).terrain == "water":
        return None
    P = max(3, world.at(cx, cy).level)          # plateau height
    half = 5

    # courtyard: a flat flagstone plateau (auto-gets stone cliffs at its edges)
    _flatten(world, cx - half, cy - half, cx + half, cy + half, P, "castle", "castle_floor")

    # wall ring rising above the courtyard, with a south gate
    for y in range(cy - half, cy + half + 1):
        for x in range(cx - half, cx + half + 1):
            if not world.in_bounds(x, y):
                continue
            edge = x in (cx - half, cx + half) or y in (cy - half, cy + half)
            if not edge:
                continue
            c = world.at(x, y)
            if x == cx and y == cy + half:          # gate opening (toward plains)
                c.terrain, c.variant, c.level, c.role = "brick_road", 0, P, "gate"
            else:
                c.terrain, c.variant, c.level, c.role = "castle_wall", 0, P + 2, "wall"

    # the keep: a taller tower block at the centre-back
    for y in range(cy - 2, cy):
        for x in range(cx - 1, cx + 2):
            if world.in_bounds(x, y):
                c = world.at(x, y)
                c.terrain, c.variant, c.level, c.role = "castle_wall", 1, P + 4, "keep"

    world.regions.append(Region("Aldermoor Castle", "castle", cx, cy))
    return (cx, cy + half + 1)                    # road hooks up just outside the gate


def build_town(world: World, plan: WorldPlan) -> tuple[int, int] | None:
    node = plan.nodes.get("port")
    if not node:
        return None
    tx, ty = int(node.x), int(node.y)
    if not world.in_bounds(tx, ty) or world.at(tx, ty).terrain == "water":
        return None
    P = world.at(tx, ty).level
    half = 4
    _flatten(world, tx - half, ty - half, tx + half, ty + half, P, "cobblestone", "town")
    # brick main streets crossing the plaza
    for d in range(-half, half + 1):
        for (x, y) in ((tx + d, ty), (tx, ty + d)):
            if world.in_bounds(x, y) and world.at(x, y).terrain != "water":
                c = world.at(x, y)
                c.terrain, c.variant, c.role, c.level = "brick_road", 0, "town_road", P
    # a low town wall along the two inland edges
    for d in range(-half, half + 1):
        for (x, y) in ((tx + d, ty - half), (tx - half, ty + d)):
            if world.in_bounds(x, y) and world.at(x, y).terrain != "water" and (x, y) != (tx, ty - half):
                c = world.at(x, y)
                c.terrain, c.variant, c.role, c.level = "town_wall", 0, "wall", P + 1
    world.regions.append(Region("Saltmarsh Harbor", "town", tx, ty))
    return (tx, ty)


def build_hamlet(world: World, plan: WorldPlan, node_name: str) -> tuple[int, int] | None:
    node = plan.nodes.get(node_name)
    if not node:
        return None
    hx, hy = int(node.x), int(node.y)
    if not world.in_bounds(hx, hy) or world.at(hx, hy).terrain == "water":
        return None
    P = world.at(hx, hy).level
    half = 2
    _flatten(world, hx - half, hy - half, hx + half, hy + half, P, "cobblestone", "hamlet")
    # a wooden fence perimeter
    for y in range(hy - half, hy + half + 1):
        for x in range(hx - half, hx + half + 1):
            if not world.in_bounds(x, y):
                continue
            if (x in (hx - half, hx + half) or y in (hy - half, hy + half)) and not (x == hx and y == hy + half):
                c = world.at(x, y)
                if c.terrain != "water":
                    c.terrain, c.variant, c.role, c.level = "wooden_fence", 0, "fence", P
    world.regions.append(Region(node.label, "hamlet", hx, hy))
    return (hx, hy)


def build_roads(world: World, plan: WorldPlan, hooks: dict) -> int:
    """Lay the King's Road along the plan's node graph via A*."""
    laid = 0
    for a, b in plan.roads:
        pa = hooks.get(a) or (int(plan.nodes[a].x), int(plan.nodes[a].y))
        pb = hooks.get(b) or (int(plan.nodes[b].x), int(plan.nodes[b].y))
        path = route_road(world, pa, pb)
        if path:
            lay_road(world, path)
            laid += 1
    return laid


def stamp_all(world: World, plan: WorldPlan) -> None:
    hooks: dict[str, tuple[int, int]] = {}
    gate = build_castle(world, plan)
    if gate:
        hooks["castle"] = gate
    town = build_town(world, plan)
    if town:
        hooks["port"] = town
    for name in ("westvillage", "easthamlet", "desertpost", "lakeside"):
        h = build_hamlet(world, plan, name)
        if h:
            hooks[name] = h
    n = build_roads(world, plan, hooks)
    world.log.append(f"stamped landmarks: castle, town, {len(hooks) - 2} hamlets, "
                     f"{n} King's Road segments")
