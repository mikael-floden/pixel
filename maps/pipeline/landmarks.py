"""Stamp the plan's landmarks and roads onto the built terrain, in tiles.

Every set-piece here is buildable with the tile library the tiles agent has
already shipped (plus the objects domain's prop sprites): tall castle_wall
battlements, garden_wall + hedge pleasure gardens, wood_floor piers, stairs
cut into terrace lips, stone circles as raised blocks, ruins as broken wall
rings. The plan says WHERE things stand and what they mean; this module makes
them true on the grid.
"""

from __future__ import annotations

import math

from designer import lay_road, route_road
from noise import hash01
from plan import WorldPlan
from world import Region, World


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------


def _put(world: World, x, y, terrain, variant=0, level=None, role=None, object=None):
    if not world.in_bounds(x, y):
        return
    c = world.at(x, y)
    c.terrain, c.variant = terrain, variant
    if level is not None:
        c.level = level
    if role is not None:
        c.role = role
    c.object = object


def _flatten(world: World, x0, y0, x1, y1, level, terrain, role, variant=0):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if not world.in_bounds(x, y):
                continue
            c = world.at(x, y)
            if c.terrain == "water":
                continue
            c.terrain, c.variant, c.level, c.role = terrain, variant, level, role
            c.object = None


def _is_water(world: World, x, y) -> bool:
    return world.in_bounds(x, y) and world.at(x, y).terrain == "water"


# ---------------------------------------------------------------------------
# Castle Aldermoor — walled keep, gatehouse, pleasure garden with hedge maze
# ---------------------------------------------------------------------------

_MAZE = [
    "###########",
    "#....#....#",
    "#.##.#.##.#",
    "#.#..#..#.#",
    "#.#.###.#.#",
    "#...#.#...#",
    "###.#.#.###",
    "#.........#",
    "#####.#####",
]


def build_castle(world: World, plan: WorldPlan) -> tuple[int, int] | None:
    node = plan.nodes.get("castle")
    if not node:
        return None
    cx, cy = int(node.x), int(node.y)
    if not world.in_bounds(cx, cy) or world.at(cx, cy).terrain == "water":
        return None
    P = 4                       # the crag the plan raised for us
    half = 5

    # a green apron all around the walls so the grey castle silhouette never
    # sits flush against grey mountain rock (find-it-first contrast)
    for y in range(cy - half - 2, cy + half + 3):
        for x in range(cx - half - 2, cx + half + 3):
            if not world.in_bounds(x, y) or _is_water(world, x, y):
                continue
            if abs(x - cx) > half or abs(y - cy) > half:
                _put(world, x, y, "grass", 0, P, "castle_ground")

    _flatten(world, cx - half, cy - half, cx + half, cy + half, P, "castle", "castle_floor")

    for y in range(cy - half, cy + half + 1):
        for x in range(cx - half, cx + half + 1):
            if not world.in_bounds(x, y):
                continue
            edge = x in (cx - half, cx + half) or y in (cy - half, cy + half)
            if not edge:
                continue
            if x == cx and y == cy + half:                     # south gate
                _put(world, x, y, "brick_road", 0, P, "gate")
            elif abs(x - cx) == 1 and y == cy + half:          # gatehouse towers
                _put(world, x, y, "castle_wall", 2, P + 3, "wall")
            else:
                _put(world, x, y, "castle_wall", 0, P + 2, "wall")

    # the keep: the tallest silhouette on the map, crenellated
    for y in range(cy - 3, cy - 1):
        for x in range(cx - 1, cx + 2):
            _put(world, x, y, "castle_wall", 1, P + 5, "keep")
    # processional carpet from gate to keep
    for y in range(cy - 1, cy + half):
        _put(world, cx, y, "castle", 4, P, "castle_floor")
    # a paved approach descending from the gate so the entrance READS
    for i in range(1, 5):
        y = cy + half + i
        if world.in_bounds(cx, y) and not _is_water(world, cx, y):
            lvl = world.at(cx, y).level
            _put(world, cx, y, "brick_road", 0, lvl, "road")

    # pleasure garden annex on the SW lawn: garden_wall ring, hedge maze inside
    gx0, gy0 = cx - half - 13, cy + 1
    for gy, row in enumerate(_MAZE):
        for gx, ch in enumerate(row):
            x, y = gx0 + gx, gy0 + gy
            if not world.in_bounds(x, y) or _is_water(world, x, y):
                continue
            border = gx in (0, len(row) - 1) or gy in (0, len(_MAZE) - 1)
            entrance = gy == len(_MAZE) - 1 and gx == 5
            if entrance:
                _put(world, x, y, "grass", 0, 1, "garden")
            elif border:
                _put(world, x, y, "garden_wall", 0, 1, "wall")
            elif ch == "#":
                _put(world, x, y, "hedge", 0, 1, "wall")
            else:
                # plain calm paths so the hedge WALLS carry the pattern
                _put(world, x, y, "grass", 0, 1, "garden")
    # the maze's reward at its heart
    _put(world, gx0 + 5, gy0 + 5, "grass", 0, 1, "garden", object="wooden_chest")

    world.regions.append(Region("Castle Aldermoor", "castle", cx, cy))
    return (cx, cy + half + 1)


# ---------------------------------------------------------------------------
# Saltmere Harbor — plaza, streets, sea wall, wood piers with cargo
# ---------------------------------------------------------------------------


def build_saltmere(world: World, plan: WorldPlan) -> tuple[int, int] | None:
    node = plan.nodes.get("saltmere")
    if not node:
        return None
    tx, ty = int(node.x), int(node.y)
    if not world.in_bounds(tx, ty):
        return None
    P = 0
    half = 4
    _flatten(world, tx - half, ty - half, tx + half, ty + half, P, "cobblestone", "town")
    for d in range(-half, half + 1):
        _put(world, tx + d, ty, "brick_road", 0, P, "town_road")
        _put(world, tx, ty + d, "brick_road", 0, P, "town_road")
    # sea wall along the two inland edges
    for d in range(-half, half + 1):
        for (x, y) in ((tx + d, ty - half), (tx - half, ty + d)):
            if (x, y) != (tx, ty - half) and not _is_water(world, x, y):
                _put(world, x, y, "town_wall", 0, P + 1, "wall")

    # houses in the plaza quadrants (building mass = town identity)
    _house(world, tx - 3, ty - 3, 2, 2, P)
    _house(world, tx + 1, ty - 3, 3, 2, P)
    _house(world, tx - 3, ty + 1, 2, 3, P)
    _house(world, tx + 2, ty + 2, 2, 2, P)

    # piers: walk toward open water, lay planks; cargo at the ends
    seaward = _seaward_dir(world, tx, ty)
    built = 0
    for off in (-2, 2):
        px, py = tx + (off if seaward[1] else 0), ty + (off if seaward[0] else 0)
        length = 0
        # advance to the shoreline first
        for _ in range(12):
            if _is_water(world, px, py):
                break
            px, py = px + seaward[0], py + seaward[1]
        for i in range(5):
            if not world.in_bounds(px, py):
                break
            obj = "barrel" if i == 3 else ("wooden_crate" if i == 4 else None)
            _put(world, px, py, "wood_floor", 2, 0, "dock", object=obj)
            px, py = px + seaward[0], py + seaward[1]
            length += 1
        built += length
    world.regions.append(Region("Saltmere Harbor", "town", tx, ty))
    return (tx, ty)


def _house(world: World, x0, y0, w, h, P) -> None:
    """A house: a block raised one level with a warm wood_floor roof — the
    renderer gives it stone sides, so it reads as a stone cottage with a flat
    timber roof. Building mass is what makes a town read as a town."""
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            if world.in_bounds(x, y) and not _is_water(world, x, y):
                _put(world, x, y, "wood_floor", 0, P + 1, "house")


def _seaward_dir(world: World, x, y) -> tuple[int, int]:
    """Direction with the most water within 10 cells."""
    best, bd = -1, (0, 1)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        n = sum(1 for i in range(1, 11) if _is_water(world, x + dx * i, y + dy * i))
        if n > best:
            best, bd = n, (dx, dy)
    return bd


# ---------------------------------------------------------------------------
# Wheatstead — walled farm town in the golden vale
# ---------------------------------------------------------------------------


def build_wheatstead(world: World, plan: WorldPlan) -> tuple[int, int] | None:
    node = plan.nodes.get("wheatstead")
    if not node:
        return None
    tx, ty = int(node.x), int(node.y)
    if not world.in_bounds(tx, ty) or _is_water(world, tx, ty):
        return None
    P = max(0, world.at(tx, ty).level)
    half = 3
    _flatten(world, tx - half, ty - half, tx + half, ty + half, P, "cobblestone", "town")
    for d in range(-half, half + 1):
        _put(world, tx + d, ty, "brick_road", 0, P, "town_road")
    for y in range(ty - half, ty + half + 1):
        for x in range(tx - half, tx + half + 1):
            edge = x in (tx - half, tx + half) or y in (ty - half, ty + half)
            gate = (y == ty and x in (tx - half, tx + half))
            if edge and not gate and not _is_water(world, x, y):
                _put(world, x, y, "town_wall", 0, P + 1, "wall")
    # houses + granary yard with cargo
    _house(world, tx - 2, ty - 2, 2, 2, P)
    _house(world, tx + 1, ty + 1, 2, 2, P)
    _put(world, tx + 1, ty - 1, "cobblestone", 0, P, "town", object="wooden_crate")
    _put(world, tx - 1, ty + 1, "cobblestone", 0, P, "town", object="clay_pot")
    world.regions.append(Region("Wheatstead", "town", tx, ty))
    return (tx, ty)


# ---------------------------------------------------------------------------
# Kingsbridge — the only crossing south of the lake: a stone bridge village
# ---------------------------------------------------------------------------


def build_kingsbridge(world: World, plan: WorldPlan) -> tuple[int, int] | None:
    node = plan.nodes.get("kingsbridge")
    if not node:
        return None
    bx, by = int(node.x), int(node.y)
    if not world.in_bounds(bx, by):
        return None
    # find the river near the node and bridge it east-west with castle flagstone
    river_x = None
    for dx in range(-6, 7):
        if world.in_bounds(bx + dx, by) and world.at(bx + dx, by).role == "river":
            river_x = bx + dx
            break
    if river_x is None:
        river_x = bx
    x0 = river_x
    while _is_water(world, x0 - 1, by):
        x0 -= 1
    x1 = river_x
    while _is_water(world, x1 + 1, by):
        x1 += 1
    for x in range(x0, x1 + 1):
        _put(world, x, by, "castle", 0, 0, "bridge")
    # hamlet plazas on both banks, one cottage each
    for cxx in (x0 - 2, x1 + 2):
        for y in range(by - 1, by + 2):
            for x in range(cxx - 1, cxx + 2):
                if not _is_water(world, x, y) and world.in_bounds(x, y):
                    _put(world, x, y, "cobblestone", 4, 0, "hamlet")
    _house(world, x0 - 3, by - 1, 2, 2, 0)
    _house(world, x1 + 2, by + 1, 2, 2, 0)
    _put(world, x0 - 2, by - 1, "cobblestone", 4, 0, "hamlet", object="barrel")
    world.regions.append(Region("Kingsbridge", "village", bx, by))
    return (x0 - 2, by)


# ---------------------------------------------------------------------------
# Woodhollow — a fenced hamlet deep in Eastwood
# ---------------------------------------------------------------------------


def build_woodhollow(world: World, plan: WorldPlan) -> tuple[int, int] | None:
    node = plan.nodes.get("woodhollow")
    if not node:
        return None
    hx, hy = int(node.x), int(node.y)
    if not world.in_bounds(hx, hy) or _is_water(world, hx, hy):
        return None
    P = max(0, world.at(hx, hy).level)
    half = 2
    _flatten(world, hx - half, hy - half, hx + half, hy + half, P, "cobblestone", "hamlet")
    for y in range(hy - half, hy + half + 1):
        for x in range(hx - half, hx + half + 1):
            edge = x in (hx - half, hx + half) or y in (hy - half, hy + half)
            if edge and not (x == hx and y == hy + half) and not _is_water(world, x, y):
                _put(world, x, y, "wooden_fence", 0, P, "fence")
    _house(world, hx - 1, hy - 1, 2, 2, P)
    _put(world, hx + 1, hy + 1, "cobblestone", 0, P, "hamlet", object="wooden_chest")
    world.regions.append(Region("Woodhollow", "hamlet", hx, hy))
    return (hx, hy + half)


# ---------------------------------------------------------------------------
# The Wyrmgate — twin towers pinching the pass road at the fjord head
# ---------------------------------------------------------------------------


def build_wyrmgate(world: World, plan: WorldPlan) -> None:
    node = plan.nodes.get("pass")
    if not node:
        return
    px, py = int(node.x), int(node.y)
    for x, y in ((px - 2, py), (px + 2, py), (px - 2, py - 1), (px + 2, py - 1)):
        if world.in_bounds(x, y) and not _is_water(world, x, y):
            L = world.at(x, y).level
            _put(world, x, y, "town_wall", 0, L + 2, "wall")
    world.regions.append(Region("The Wyrmgate", "pass", px, py))


# ---------------------------------------------------------------------------
# Pale Bell Monastery — a broken ruin on Hoarfell's frozen tarn (secret)
# ---------------------------------------------------------------------------


def build_monastery(world: World, plan: WorldPlan) -> None:
    node = plan.nodes.get("monastery")
    if not node:
        return
    mx, my = int(node.x), int(node.y)
    if not world.in_bounds(mx, my):
        return
    P = max(0, world.at(mx, my).level)
    # the frozen tarn: a sheet of ice east of the ruin, chest out on the ice
    for y in range(my - 2, my + 3):
        for x in range(mx + 3, mx + 9):
            if world.in_bounds(x, y) and math.hypot(x - (mx + 6), y - my) < 3.2:
                _put(world, x, y, "ice", (x + y) % 3, P, "tarn")
    _put(world, mx + 6, my, "ice", 1, P, "tarn", object="wooden_chest")
    # a legible broken hall: an 8x6 wall rectangle with deliberate gaps and a
    # contiguous cracked-flagstone interior — a building time has half-taken
    hw, hh = 4, 3
    _flatten(world, mx - hw, my - hh, mx + hw - 1, my + hh - 1, P, "castle", "ruins", variant=3)
    for y in range(my - hh, my + hh):
        for x in range(mx - hw, mx + hw):
            edge = x in (mx - hw, mx + hw - 1) or y in (my - hh, my + hh - 1)
            if not edge or not world.in_bounds(x, y) or _is_water(world, x, y):
                continue
            if hash01(x, y, plan.seed + 51) < 0.68:            # surviving stones
                _put(world, x, y, "town_wall", 0, P + 1, "ruins")
    world.regions.append(Region("Pale Bell Monastery", "ruins", mx, my))


# ---------------------------------------------------------------------------
# Hourglass Oasis / Sunspire Outpost / the Emberlight
# ---------------------------------------------------------------------------


def build_oasis(world: World, plan: WorldPlan) -> tuple[int, int] | None:
    node = plan.nodes.get("oasis")
    if not node:
        return None
    ox, oy = int(node.x), int(node.y)
    if not world.in_bounds(ox, oy):
        return None
    for y in range(oy - 3, oy + 4):
        for x in range(ox - 3, ox + 4):
            if not world.in_bounds(x, y):
                continue
            d = math.hypot(x - ox, y - oy)
            if d < 1.7:
                _put(world, x, y, "water", 3, 0, "oasis")
            elif d < 3.2:
                obj = "oak_tree" if hash01(x, y, plan.seed + 61) < 0.22 else None
                _put(world, x, y, "grass", 0, 0, "oasis", object=obj)
    world.regions.append(Region("Hourglass Oasis", "oasis", ox, oy))
    return (ox, oy + 3)


def build_sunspire(world: World, plan: WorldPlan) -> tuple[int, int] | None:
    node = plan.nodes.get("sunspire")
    if not node:
        return None
    sx, sy = int(node.x), int(node.y)
    if not world.in_bounds(sx, sy) or _is_water(world, sx, sy):
        return None
    P = max(0, world.at(sx, sy).level)
    _flatten(world, sx - 2, sy - 2, sx + 2, sy + 2, P, "cobblestone", "outpost")
    for x, y in ((sx, sy - 1), (sx + 1, sy - 1)):
        _put(world, x, y, "town_wall", 0, P + 3, "wall")     # the spire itself
    _put(world, sx - 1, sy + 1, "cobblestone", 0, P, "outpost", object="clay_pot")
    world.regions.append(Region("Sunspire Outpost", "outpost", sx, sy))
    return (sx, sy + 2)


def build_lighthouse(world: World, plan: WorldPlan) -> tuple[int, int] | None:
    node = plan.nodes.get("lighthouse")
    if not node:
        return None
    lx, ly = int(node.x), int(node.y)
    if not world.in_bounds(lx, ly):
        return None
    # find dry ground near the tip if the node fell in water
    if _is_water(world, lx, ly):
        for r in range(1, 6):
            found = False
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    if world.in_bounds(lx + dx, ly + dy) and not _is_water(world, lx + dx, ly + dy):
                        lx, ly = lx + dx, ly + dy
                        found = True
                        break
                if found:
                    break
            if found:
                break
    P = max(0, world.at(lx, ly).level)
    _flatten(world, lx - 1, ly - 1, lx + 1, ly + 1, P, "stone", "lighthouse")
    # the tower: the tallest single column on the western half of the map,
    # so the peninsula owns a real silhouette
    _put(world, lx, ly, "castle_wall", 0, P + 6, "lighthouse")
    _put(world, lx + 1, ly, "stone", 0, P, "lighthouse", object="barrel")
    world.regions.append(Region("The Emberlight", "lighthouse", lx, ly))
    return (lx, ly + 2)


# ---------------------------------------------------------------------------
# Kingstone Ring / Mirrormere Shrine / the Sunken Court / the ford (secrets)
# ---------------------------------------------------------------------------


def build_kingstone(world: World, plan: WorldPlan) -> None:
    node = plan.nodes.get("kingstone")
    if not node:
        return
    kx, ky = int(node.x), int(node.y)
    if not world.in_bounds(kx, ky):
        return
    P = max(0, world.at(kx, ky).level)
    _flatten(world, kx - 3, ky - 3, kx + 3, ky + 3, P, "grass", "glade", variant=1)
    for i in range(8):                                          # the menhirs
        a = i * math.tau / 8
        x, y = kx + round(2.4 * math.cos(a)), ky + round(2.4 * math.sin(a))
        _put(world, x, y, "stone", 3, P + 1, "stones")
    _put(world, kx, ky, "stone_step", 0, P, "stones")           # the altar
    world.regions.append(Region("Kingstone Ring", "stones", kx, ky))


def build_shrine(world: World, plan: WorldPlan) -> None:
    node = plan.nodes.get("shrine")
    if not node:
        return
    sx, sy = int(node.x), int(node.y)
    if not world.in_bounds(sx, sy):
        return
    # the islet the plan left in the lake — kept clean: floor, chest, landing
    _flatten(world, sx - 1, sy - 1, sx + 1, sy + 1, 0, "castle", "shrine", variant=1)
    _put(world, sx - 1, sy - 1, "castle_wall", 2, 1, "shrine")  # one broken pillar
    _put(world, sx, sy, "castle", 4, 0, "shrine", object="wooden_chest")
    _put(world, sx, sy + 1, "stone_step", 0, 0, "shrine")       # landing
    # stepping stones to the south shore — discoverable from the water's edge
    y = sy + 2
    while world.in_bounds(sx, y) and world.at(sx, y).terrain == "water" and y < sy + 12:
        if (y - sy) % 2 == 0:
            _put(world, sx, y, "stone_step", 1, 0, "ford")
        y += 1
    world.regions.append(Region("Mirrormere Shrine", "shrine", sx, sy))


def build_ruinisle(world: World, plan: WorldPlan) -> None:
    node = plan.nodes.get("ruinisle")
    if not node:
        return
    rx, ry = int(node.x), int(node.y)
    if not world.in_bounds(rx, ry) or _is_water(world, rx, ry):
        return
    P = max(0, world.at(rx, ry).level)
    half = 2
    _flatten(world, rx - half, ry - half, rx + half, ry + half, P, "castle", "ruins", variant=3)
    for y in range(ry - half, ry + half + 1):
        for x in range(rx - half, rx + half + 1):
            edge = x in (rx - half, rx + half) or y in (ry - half, ry + half)
            if edge and world.in_bounds(x, y) and not _is_water(world, x, y):
                if hash01(x, y, plan.seed + 53) < 0.45:
                    _put(world, x, y, "castle_wall", 2, P + 1, "ruins")
    _put(world, rx, ry, "castle", 3, P, "ruins", object="wooden_chest")
    world.regions.append(Region("The Sunken Court", "ruins", rx, ry))


def build_ford(world: World, plan: WorldPlan) -> None:
    """Stepping stones across the Silverrill north of the lake — an unmarked
    shortcut that turns the King's Round into a figure-8 once spotted."""
    lake = next((d for d in plan.districts if d.kind == "lake"), None)
    if not lake:
        return
    fy = int(lake.cy - lake.radius - 4)
    xs = [x for x in range(world.width) if world.in_bounds(x, fy)
          and world.at(x, fy).role == "river"]
    if not xs:
        return
    for x in range(min(xs) - 1, max(xs) + 2):
        if world.in_bounds(x, fy) and world.at(x, fy).terrain == "water":
            _put(world, x, fy, "stone_step", 1, 0, "ford")


# ---------------------------------------------------------------------------
# farms, roads, stairs, props
# ---------------------------------------------------------------------------


def build_farms(world: World, centers: list[tuple[int, int]]) -> int:
    changed = 0
    for tx, ty in centers:
        for y in range(ty - 8, ty + 9):
            for x in range(tx - 8, tx + 9):
                if not world.in_bounds(x, y):
                    continue
                c = world.at(x, y)
                d = math.hypot(x - tx, y - ty)
                if 4 <= d <= 8 and c.role in ("plains", "farm") and c.level <= 1:
                    # lighter tilled variants — fields shouldn't out-contrast
                    # the castle at overview scale
                    c.terrain, c.variant = "farm", (0, 1, 4)[(x + y) % 3]
                    c.role = "farm"
                    c.object = None
                    changed += 1
    return changed


def build_roads(world: World, plan: WorldPlan, hooks: dict) -> int:
    laid = 0
    for a, b in plan.roads:
        pa = hooks.get(a) or (int(plan.nodes[a].x), int(plan.nodes[a].y))
        pb = hooks.get(b) or (int(plan.nodes[b].x), int(plan.nodes[b].y))
        path = route_road(world, pa, pb)
        if path:
            lay_road(world, path)
            laid += 1
    return laid


def add_stairs(world: World) -> int:
    """Wherever the road network climbs a terrace lip, cut a stair into it —
    the road physically negotiates the level system instead of teleporting."""
    n = 0
    road_roles = {"road", "gate", "town_road"}
    for x, y, c in world.cells():
        if c.role not in road_roles:
            continue
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if not world.in_bounds(nx, ny):
                continue
            nc = world.at(nx, ny)
            if nc.role in road_roles and nc.level == c.level + 1:
                if c.terrain != "stairs":
                    c.terrain, c.variant = "stairs", 0
                    c.role = "stairs"
                    n += 1
                break
    return n


def place_props(world: World, plan: WorldPlan) -> int:
    """Scatter small cargo props through paved areas so towns feel inhabited."""
    n = 0
    for x, y, c in world.cells():
        if c.object or c.role not in ("town", "hamlet"):
            continue
        r = hash01(x, y, plan.seed + 71)
        if r < 0.14:
            c.object = ("barrel", "wooden_crate", "clay_pot")[int(r * 1000) % 3]
            n += 1
    return n


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------


def stamp_all(world: World, plan: WorldPlan) -> None:
    hooks: dict[str, tuple[int, int]] = {}

    gate = build_castle(world, plan)
    if gate:
        hooks["castle"] = gate
    for name, fn in (("saltmere", build_saltmere), ("wheatstead", build_wheatstead),
                     ("kingsbridge", build_kingsbridge), ("woodhollow", build_woodhollow),
                     ("oasis", build_oasis), ("sunspire", build_sunspire),
                     ("lighthouse", build_lighthouse)):
        h = fn(world, plan)
        if h:
            hooks[name] = h

    build_wyrmgate(world, plan)
    build_monastery(world, plan)
    build_kingstone(world, plan)
    build_shrine(world, plan)
    build_ruinisle(world, plan)
    build_ford(world, plan)

    n = build_roads(world, plan, hooks)
    s = add_stairs(world)
    f = build_farms(world, [hooks[k] for k in ("wheatstead", "saltmere") if k in hooks])
    p = place_props(world, plan)
    world.log.append(
        f"stamped Aldermoor: castle+garden, 2 towns, 2 villages, wyrmgate, "
        f"monastery, oasis, sunspire, emberlight, kingstone, shrine, sunken court, "
        f"ford — {n} roads, {s} stairs, {f} farm fields, {p} props")
