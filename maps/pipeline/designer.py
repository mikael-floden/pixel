"""The designer brain: turns tiles into a world that reads as *designed*.

This is the opposite of scattering random tiles. It works in deliberate passes,
the way a hand-built ALTTP-style overworld is composed:

  1. a single coherent landmass with a smooth coastline (not noise soup),
  2. a sand beach hugging the water,
  3. a handful of *placed* biome regions with controlled size and location
     (mountains in the highlands, a forest, snowy peaks, open plains),
  4. terraced elevation so mountains rise and the castle sits on a plateau,
  5. real landmarks: a walled castle that looks like a castle, a harbor town
     on the coast,
  6. logical roads (A* that prefers flat ground, hugs gentle grades, bridges
     water) tying the town to the castle gate and the docks,
  7. a river running from the peaks down to the sea, bridged by the road.

`init_world` lays the first draft. `iterate` performs ONE improvement per call
(the loop's unit of work): it consults a prioritized checklist and either adds a
missing landmark, refines an existing region, or extends the world with a new
coherent region — always leaving the world better than it found it.
"""

from __future__ import annotations

import heapq
import math

from world import Cell, Region, World

# ---------------------------------------------------------------------------
# Deterministic value noise (hash-based; no RNG so worlds are reproducible)
# ---------------------------------------------------------------------------


def _hash01(ix: int, iy: int, seed: int) -> float:
    h = (ix * 374761393 + iy * 668265263 + seed * 362437) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


def _smooth(t: float) -> float:
    return t * t * (3 - 2 * t)


def value_noise(x: float, y: float, seed: int, scale: float) -> float:
    gx, gy = x / scale, y / scale
    ix, iy = math.floor(gx), math.floor(gy)
    fx, fy = gx - ix, gy - iy
    ux, uy = _smooth(fx), _smooth(fy)
    v00 = _hash01(ix, iy, seed)
    v10 = _hash01(ix + 1, iy, seed)
    v01 = _hash01(ix, iy + 1, seed)
    v11 = _hash01(ix + 1, iy + 1, seed)
    a = v00 + (v10 - v00) * ux
    b = v01 + (v11 - v01) * ux
    return a + (b - a) * uy


def fbm(x: float, y: float, seed: int, scale: float, octaves: int = 4) -> float:
    total, amp, norm, s = 0.0, 1.0, 0.0, scale
    for o in range(octaves):
        total += amp * value_noise(x, y, seed + o * 101, s)
        norm += amp
        amp *= 0.5
        s *= 0.5
    return total / norm


# ---------------------------------------------------------------------------
# Terrain palettes: which tile category (and preferred variants) a biome uses.
# Variants are picked from these so a region reads as one material with natural
# internal variety, never a checkerboard of unrelated tiles.
# ---------------------------------------------------------------------------

PALETTE = {
    "plains":    ("grass", [0, 1, 2, 0, 0, 1]),      # lush, occasional flowers
    "forest":    ("grass", [3, 5, 3, 5, 3]),          # tall/mossy grass
    "beach":     ("sand", [0, 1, 3, 0]),
    "mountains": ("stone", [0, 2, 3, 5]),
    "highland":  ("stone", [0, 3]),
    "snowfield": ("snow", [0, 1, 4]),
    "ice":       ("ice", [0, 2]),
    # Water reads as one calm surface: one dominant tile with only rare accents,
    # never a high-contrast checkerboard.
    "water":     ("water", [0, 0, 0, 0, 0, 0, 1]),
    "shallows":  ("water", [3, 3, 3, 3, 1]),
    "town":      ("cobblestone", [0, 4, 1]),
    "road":      ("brick_road", [0, 3, 1]),
    "castle_floor": ("castle", [0, 2, 1]),
    "castle_wall":  ("stone", [4, 0]),
    "dirt":      ("dirt", [0, 2]),
    "farm":      ("dirt", [4, 1]),
}


def _paint(world: World, x: int, y: int, biome: str, *, level=None, role=None):
    """Apply a biome's terrain+variant to a cell, keeping variant deterministic
    per cell so the same world always renders identically."""
    if not world.in_bounds(x, y):
        return
    cat, variants = PALETTE[biome]
    vi = variants[(x * 31 + y * 17 + world.seed) % len(variants)]
    c = world.at(x, y)
    c.terrain = cat
    c.variant = vi
    if level is not None:
        c.level = level
    if role is not None:
        c.role = role
    elif c.role == "ground":
        c.role = biome


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------


def _land_cells(world: World):
    return [(x, y) for x, y, c in world.cells() if c.role != "water" and c.terrain != "water"]


def _neighbors4(x, y):
    return [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]


def _is_water(world: World, x: int, y: int) -> bool:
    if not world.in_bounds(x, y):
        return True
    return world.at(x, y).terrain == "water"


# ---------------------------------------------------------------------------
# PASS 1 — landmass + coast
# ---------------------------------------------------------------------------


def carve_landmass(world: World) -> None:
    """One coherent island: radial falloff shaped by fBm so the coast is organic
    but the interior is solid land — no scattered specks."""
    cx, cy = world.width / 2, world.height / 2
    rx, ry = world.width * 0.42, world.height * 0.42
    for x, y, c in world.cells():
        dx, dy = (x - cx) / rx, (y - cy) / ry
        d = math.sqrt(dx * dx + dy * dy)
        n = fbm(x, y, world.seed, scale=9.0, octaves=4)
        land = (1.0 - d) + (n - 0.5) * 0.75
        if land > 0.28:
            _paint(world, x, y, "plains", level=0, role="plains")
        else:
            # deep vs shallow water for a readable coast
            biome = "shallows" if land > 0.10 else "water"
            _paint(world, x, y, biome, level=0, role="water")


def add_beaches(world: World) -> None:
    """Sand ring on every land cell touching the sea."""
    coast = [
        (x, y)
        for x, y in _land_cells(world)
        if any(_is_water(world, nx, ny) for nx, ny in _neighbors4(x, y))
    ]
    for x, y in coast:
        _paint(world, x, y, "beach", role="beach")


# ---------------------------------------------------------------------------
# PASS 2 — biome regions (placed, not random)
# ---------------------------------------------------------------------------


def _land_bbox(world: World):
    xs = [x for x, y in _land_cells(world)]
    ys = [y for x, y in _land_cells(world)]
    return min(xs), min(ys), max(xs), max(ys)


def place_regions(world: World) -> None:
    """Position a curated set of biome regions in sensible places (highlands to
    the north, forest to the east, plains in the fertile centre/south) and paint
    each land cell by its nearest region, with a noisy boundary so borders look
    natural rather than stamped."""
    x0, y0, x1, y1 = _land_bbox(world)
    w, h = x1 - x0, y1 - y0

    def P(fx, fy):
        return (x0 + fx * w, y0 + fy * h)

    # (name, kind, center, radius, priority) — radius as fraction of land size.
    specs = [
        ("Northern Peaks", "mountains", P(0.34, 0.15), 0.30),
        ("Frostcap",       "snowfield", P(0.62, 0.08), 0.18),
        ("Eastwood",       "forest",    P(0.80, 0.55), 0.32),
        ("Green Vale",     "plains",    P(0.45, 0.62), 0.55),
    ]
    world.regions = [
        Region(name=n, kind=k, cx=c[0], cy=c[1], notes="") for n, k, c, _ in specs
    ]

    for x, y in _land_cells(world):
        if world.at(x, y).role == "beach":
            continue  # keep the coastline sandy
        best, best_kind = 1e9, "plains"
        for _, kind, (rcx, rcy), rad in specs:
            R = rad * max(w, h)
            d = math.hypot(x - rcx, y - rcy) / R
            d -= (fbm(x, y, world.seed + 7, 5.0) - 0.5) * 0.6  # organic border
            if d < best:
                best, best_kind = d, kind
        _paint(world, x, y, best_kind, role=best_kind)


def raise_highlands(world: World) -> None:
    """Terrace the highland regions so they actually rise (stacked blocks)
    instead of being flat ground.

    Mountains peak in grey stone and get snow caps at the top; the snowfield is
    a *raised* cold plateau (not a flat white blob at sea level), with a stony
    apron so it descends into the land naturally, ALTTP-style climate zoning."""
    x0, y0, x1, y1 = _land_bbox(world)
    span = max(x1 - x0, y1 - y0)

    for region, base_biome, cap, peak in (
        ("mountains", "mountains", "snowfield", 3),
        ("snowfield", "snowfield", "snowfield", 2),
    ):
        r = next((rg for rg in world.regions if rg.kind == region), None)
        if not r:
            continue
        R = 0.30 * span
        for x, y, c in world.cells():
            if c.role != region:
                continue
            d = math.hypot(x - r.cx, y - r.cy)
            t = max(0.0, 1.0 - d / R) + (fbm(x, y, world.seed + 3, 4.0) - 0.5) * 0.3
            lvl = max(0, min(peak, round(t * peak)))
            c.level = lvl
            # a stony apron at the mountains' feet reads as natural rock, not a
            # snow tile pasted onto grass
            if region == "snowfield" and lvl == 0:
                _paint(world, x, y, "mountains", level=0, role="highland")
            elif lvl >= peak:
                _paint(world, x, y, cap, level=lvl, role="peak")


# ---------------------------------------------------------------------------
# PASS 3 — river
# ---------------------------------------------------------------------------


def carve_river(world: World) -> None:
    """Run a river from the highest mountain cell downhill to the sea, so water
    has a source and a mouth like a real map."""
    mtn = next((r for r in world.regions if r.kind == "mountains"), None)
    if not mtn:
        return
    # start near the peak
    start = min(
        (p for p in _land_cells(world) if world.at(*p).level >= 2),
        key=lambda p: math.hypot(p[0] - mtn.cx, p[1] - mtn.cy),
        default=None,
    )
    if not start:
        return
    x, y = start
    seen = set()
    for _ in range(world.width + world.height):
        if _is_water(world, x, y) or (x, y) in seen:
            break
        seen.add((x, y))
        c = world.at(x, y)
        c.terrain, c.variant, c.role = "water", 1, "river"
        # step toward lower elevation, then toward map edge (downhill to sea)
        cands = [(nx, ny) for nx, ny in _neighbors4(x, y) if world.in_bounds(nx, ny)]
        if not cands:
            break
        cx, cy = world.width / 2, world.height / 2

        def score(p):
            lvl = world.at(*p).level
            edge = math.hypot(p[0] - cx, p[1] - cy)
            bend = (fbm(p[0], p[1], world.seed + 11, 3.0) - 0.5) * 1.5
            return lvl * 3 - edge * 0.15 + bend

        x, y = min(cands, key=score)


# ---------------------------------------------------------------------------
# PASS 4 — landmarks: castle + town
# ---------------------------------------------------------------------------


def build_castle(world: World) -> tuple[int, int] | None:
    """A walled keep on a raised plateau at the edge of the highlands, gate
    facing the plains — a castle that looks like a castle."""
    mtn = next((r for r in world.regions if r.kind == "mountains"), None)
    plains = next((r for r in world.regions if r.kind == "plains"), None)
    if not mtn or not plains:
        return None
    # sit it between the mountains and the plains, on buildable ground
    ccx = int(round((mtn.cx * 0.55 + plains.cx * 0.45)))
    ccy = int(round((mtn.cy * 0.6 + plains.cy * 0.4)))
    half = 4  # 9x9 compound
    # keep it on land, away from the sea
    if not world.in_bounds(ccx, ccy):
        return None

    plateau = 1
    for y in range(ccy - half, ccy + half + 1):
        for x in range(ccx - half, ccx + half + 1):
            if not world.in_bounds(x, y) or _is_water(world, x, y):
                continue
            edge = x in (ccx - half, ccx + half) or y in (ccy - half, ccy + half)
            gate = (x == ccx) and (y == ccy + half)  # south gate
            if edge and not gate:
                _paint(world, x, y, "castle_wall", level=plateau + 1, role="wall")
            elif gate:
                _paint(world, x, y, "road", level=plateau, role="gate")
            else:
                _paint(world, x, y, "castle_floor", level=plateau, role="castle_floor")
    # a keep: a taller block at the centre-back
    for y in range(ccy - half + 1, ccy - half + 3):
        for x in range(ccx - 1, ccx + 2):
            _paint(world, x, y, "castle_wall", level=plateau + 2, role="keep")

    world.regions.append(Region("Castle", "castle", ccx, ccy, "royal keep"))
    return (ccx, ccy + half)  # gate cell


def build_town(world: World) -> tuple[int, int] | None:
    """A harbor town: a cobblestone plaza on flat coastal plains, near the sea
    so it can host docks."""
    plains = next((r for r in world.regions if r.kind == "plains"), None)
    if not plains:
        return None
    # find flat plains near the coast, in the plains region
    coast_land = [
        (x, y)
        for x, y in _land_cells(world)
        if world.at(x, y).level == 0
        and world.at(x, y).role in ("plains", "beach")
        and any(_is_water(world, nx, ny) for nx, ny in _neighbors4(x, y))
    ]
    if not coast_land:
        return None
    tx, ty = min(coast_land, key=lambda p: math.hypot(p[0] - plains.cx, p[1] - plains.cy))
    half = 3
    for y in range(ty - half, ty + half + 1):
        for x in range(tx - half, tx + half + 1):
            if not world.in_bounds(x, y) or _is_water(world, x, y):
                continue
            if world.at(x, y).role == "beach":
                continue
            # main street down the middle, plaza around
            if x == tx or y == ty:
                _paint(world, x, y, "road", role="town_road")
            else:
                _paint(world, x, y, "town", role="town")
    world.regions.append(Region("Harbor Town", "town", tx, ty, "coastal market town"))
    return (tx, ty)


# ---------------------------------------------------------------------------
# PASS 5 — roads (A* that prefers gentle, dry ground)
# ---------------------------------------------------------------------------


def _road_cost(world: World, x: int, y: int, prev_level: int) -> float | None:
    if not world.in_bounds(x, y):
        return None
    c = world.at(x, y)
    base = {
        "water": None, "river": 40.0, "shallows": None,
    }.get(c.role, None)
    if c.terrain == "water":
        base = 40.0  # bridging is expensive but allowed at narrow spots
    if base is None:
        base = {
            "beach": 3.0, "plains": 1.0, "forest": 2.5, "mountains": 6.0,
            "peak": 20.0, "snowfield": 4.0, "town": 0.5, "road": 0.4,
            "town_road": 0.4, "castle_floor": 0.5, "gate": 0.4,
        }.get(c.role, 2.0)
    # discourage climbing: each level change adds cost (roads hug the grade)
    base += abs(c.level - prev_level) * 4.0
    if c.role in ("wall", "keep"):
        return None  # never route through walls
    return base


def route_road(world: World, start, goal) -> list[tuple[int, int]] | None:
    """A* over the grid; returns the cell path or None."""
    if not start or not goal:
        return None
    sx, sy = start
    openq = [(0.0, sx, sy)]
    came: dict[tuple[int, int], tuple[int, int]] = {}
    gscore = {start: 0.0}

    def hcost(x, y):
        return abs(x - goal[0]) + abs(y - goal[1])

    while openq:
        _, x, y = heapq.heappop(openq)
        if (x, y) == goal:
            path = [(x, y)]
            while (x, y) in came:
                x, y = came[(x, y)]
                path.append((x, y))
            return path[::-1]
        for nx, ny in _neighbors4(x, y):
            step = _road_cost(world, nx, ny, world.at(x, y).level)
            if step is None:
                continue
            ng = gscore[(x, y)] + step
            if ng < gscore.get((nx, ny), 1e18):
                gscore[(nx, ny)] = ng
                came[(nx, ny)] = (x, y)
                heapq.heappush(openq, (ng + hcost(nx, ny), nx, ny))
    return None


def lay_road(world: World, path) -> None:
    if not path:
        return
    for x, y in path:
        c = world.at(x, y)
        if c.role in ("town", "town_road", "gate", "castle_floor"):
            continue  # already paved
        if c.terrain == "water":
            _paint(world, x, y, "road", level=c.level, role="bridge")  # bridge
        else:
            _paint(world, x, y, "road", level=c.level, role="road")


# ---------------------------------------------------------------------------
# Top-level: init + iterate
# ---------------------------------------------------------------------------


def init_world(seed: int = 7, width: int = 44, height: int = 44) -> World:
    world = World(width, height, seed)
    carve_landmass(world)
    add_beaches(world)
    place_regions(world)
    raise_highlands(world)
    carve_river(world)
    gate = build_castle(world)
    town = build_town(world)
    if gate and town:
        lay_road(world, route_road(world, town, gate))
    world.iteration = 1
    world.log.append("init: island kingdom — highlands, forest, plains, castle, "
                     "harbor town, river, and the king's road")
    return world


# Each iterate() step is one unit of improvement. Steps are tried in priority
# order; the first that applies runs and the function returns its description.

def _has_role(world: World, role: str) -> bool:
    return any(c.role == role for _, _, c in world.cells())


def iterate(world: World) -> str:
    """Make the world better by ONE deliberate edit or extension."""
    steps = [
        _step_secondary_road,
        _step_farms,
        _step_forest_thickets,
        _step_second_village,
        _step_extend_frontier,
    ]
    for step in steps:
        desc = step(world)
        if desc:
            world.iteration += 1
            world.log.append(f"iter {world.iteration}: {desc}")
            return desc
    world.iteration += 1
    msg = "no further improvement found this pass"
    world.log.append(f"iter {world.iteration}: {msg}")
    return msg


def _step_secondary_road(world: World) -> str | None:
    """Connect the town to the sea with a dock road (if not already present)."""
    if _has_role(world, "dock"):
        return None
    town = next((r for r in world.regions if r.kind == "town"), None)
    if not town:
        return None
    # nearest deep water to the town → a pier of road tiles over the water
    water = [(x, y) for x, y, c in world.cells() if c.terrain == "water" and c.role == "water"]
    if not water:
        return None
    tx, ty = int(town.cx), int(town.cy)
    wx, wy = min(water, key=lambda p: math.hypot(p[0] - tx, p[1] - ty))
    path = route_road(world, (tx, ty), (wx, wy))
    if not path:
        return None
    lay_road(world, path[:-1])
    # last stretch onto the water = the dock
    for x, y in path[-2:]:
        if world.at(x, y).terrain == "water":
            _paint(world, x, y, "road", role="dock")
    return f"built a dock road from {town.name} out to the harbor"


def _step_farms(world: World) -> str | None:
    """Ring the town with tilled farm fields on nearby flat plains."""
    if _has_role(world, "farm"):
        return None
    town = next((r for r in world.regions if r.kind == "town"), None)
    if not town:
        return None
    tx, ty = int(town.cx), int(town.cy)
    changed = 0
    for x, y, c in world.cells():
        if c.role != "plains" or c.level != 0:
            continue
        if 4 <= math.hypot(x - tx, y - ty) <= 8:
            _paint(world, x, y, "farm", role="farm")
            changed += 1
    return f"laid {changed} farm fields around the town" if changed else None


def _step_forest_thickets(world: World) -> str | None:
    """Deepen the forest: convert its dense core to dirt-floored woodland so it
    reads as thick woods, not just tall grass."""
    if _has_role(world, "woodland"):
        return None
    forest = next((r for r in world.regions if r.kind == "forest"), None)
    if not forest:
        return None
    changed = 0
    for x, y, c in world.cells():
        if c.role != "forest":
            continue
        if math.hypot(x - forest.cx, y - forest.cy) < 4:
            _paint(world, x, y, "dirt", role="woodland")
            changed += 1
    return f"thickened {forest.name}'s core into deep woodland" if changed else None


def _step_second_village(world: World) -> str | None:
    """Add a small forest hamlet if the world has a forest but no second town."""
    if sum(1 for r in world.regions if r.kind in ("town", "hamlet")) >= 2:
        return None
    forest = next((r for r in world.regions if r.kind == "forest"), None)
    if not forest:
        return None
    hx, hy = int(forest.cx), int(forest.cy)
    if not world.in_bounds(hx, hy):
        return None
    for y in range(hy - 2, hy + 3):
        for x in range(hx - 2, hx + 3):
            if not world.in_bounds(x, y) or _is_water(world, x, y):
                continue
            _paint(world, x, y, "town", role="hamlet")
    world.regions.append(Region("Woodhollow", "hamlet", hx, hy, "forest hamlet"))
    # tie it to the road network
    castle = next((r for r in world.regions if r.kind == "castle"), None)
    if castle:
        lay_road(world, route_road(world, (hx, hy), (int(castle.cx), int(castle.cy) + 4)))
    return "founded the forest hamlet of Woodhollow and linked it by road"


def _step_extend_frontier(world: World) -> str | None:
    """When the interior is developed, grow the world: extend to the south and
    add a new coastal plains frontier so the map keeps expanding coherently."""
    # cap growth so a single run doesn't balloon the image unboundedly
    if world.width >= 80 or world.height >= 80:
        return None
    grow = 16
    world.extend(bottom=grow, right=grow, fill_terrain="water")
    # re-carve a peninsula in the new area by nudging the coastline outward:
    # convert nearby shallow/water cells into new plains where they neighbor land
    frontier = 0
    for _ in range(3):  # grow the land a few rings into the new sea
        additions = []
        for x, y, c in world.cells():
            if c.terrain != "water":
                continue
            # only grow next to *natural* coastline — never pave over docks,
            # bridges, roads or town edges (that would thrash placed structures)
            if any(
                world.in_bounds(nx, ny)
                and world.at(nx, ny).role in ("plains", "beach", "forest", "farm")
                for nx, ny in _neighbors4(x, y)
            ):
                n = fbm(x, y, world.seed + 21, 6.0)
                if n > 0.52 and y > world.height * 0.35 and x > world.width * 0.35:
                    additions.append((x, y))
        for x, y in additions:
            _paint(world, x, y, "plains", role="plains")
            frontier += 1
    add_beaches(world)
    return f"extended the world south-east — {frontier} new frontier cells of coastal plains"
