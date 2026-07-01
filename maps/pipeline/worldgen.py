"""Procedural layout for map zones — pure Python, no PixelLab calls.

worldgen decides the *shape* of a zone; PixelLab supplies the *pixels* (tilesets
+ objects) which zone.py bakes together. Everything here is deterministic given a
seed, so a zone regenerates identically.

Core datatype: a **corner height grid** `H` of size (rows+1) x (cols+1). Each
value is a terrain LEVEL (an index into the zone's `levels` list, e.g.
0=water,1=sand,2=grass,3=forest, or 0=floor,1=wall for interiors). Levels are
ordered low→high. The grid is defined on tile *corners* (dual-grid), so a tile
cell reads the 4 corners around it. The grid is always smoothed so neighbouring
corners differ by at most one level — this guarantees every tile spans at most
two adjacent levels, which is exactly what a two-terrain Wang tileset can draw.

A zone layout is a dict:
  { "H": [[...]],            # corner height grid, (rows+1) x (cols+1)
    "objects": [(obj_id, cx, cy), ...],   # placements at tile coords (col,row)
    "exits":   [{...}, ...] }             # doors/docks to other zones
"""

from __future__ import annotations

import math
import random


# --- small deterministic value-noise ---------------------------------------

def _value_noise(cols, rows, rng, cell=4):
    """Smooth value noise in [0,1] over a (rows x cols) grid via a coarse random
    lattice bilinearly interpolated. `cell` = lattice spacing in grid units."""
    gw, gh = cols // cell + 2, rows // cell + 2
    lattice = [[rng.random() for _ in range(gw)] for _ in range(gh)]
    out = [[0.0] * cols for _ in range(rows)]
    for y in range(rows):
        gy, fy = divmod(y / cell, 1)
        gy = int(gy)
        for x in range(cols):
            gx, fx = divmod(x / cell, 1)
            gx = int(gx)
            # smoothstep for gentler transitions
            sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
            a = lattice[gy][gx] * (1 - sx) + lattice[gy][gx + 1] * sx
            b = lattice[gy + 1][gx] * (1 - sx) + lattice[gy + 1][gx + 1] * sx
            out[y][x] = a * (1 - sy) + b * sy
    return out


_NEIGHBOURS8 = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))


def _smooth_levels(H):
    """Clamp a corner grid so no 8-neighbour differs by more than one level.
    Repeatedly lowers any corner that towers >1 over a neighbour, until stable.

    Diagonals matter: a tile cell's four corners include diagonal pairs (NW/SE,
    NE/SW), so smoothing only the 4 orthogonal neighbours could still leave a cell
    spanning two non-adjacent levels — which no two-terrain Wang tile can draw.
    Enforcing the constraint over all 8 neighbours guarantees every 2×2 cell spans
    at most one level boundary."""
    rows, cols = len(H), len(H[0])
    changed = True
    while changed:
        changed = False
        for y in range(rows):
            for x in range(cols):
                lo = H[y][x]
                for dy, dx in _NEIGHBOURS8:
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < rows and 0 <= nx < cols and H[ny][nx] < lo - 1:
                        H[y][x] = H[ny][nx] + 1
                        lo = H[y][x]
                        changed = True
    return H


# --- islands ----------------------------------------------------------------

def island(cols, rows, seed, num_levels=3, sea_border=2, land_bias=0.0):
    """A landmass surrounded by water. `num_levels` terrain bands
    (0=water .. num_levels-1). A radial falloff keeps water on the edges; value
    noise makes an organic coast and interior. `land_bias` (0..0.3) grows the
    island. Returns a smoothed corner grid H sized (rows+1) x (cols+1)."""
    rng = random.Random(seed)
    cw, ch = cols + 1, rows + 1
    noise = _value_noise(cw, ch, rng, cell=max(3, cols // 6))
    cx, cy = (cw - 1) / 2.0, (ch - 1) / 2.0
    maxd = math.hypot(cx, cy)
    top = num_levels - 1
    H = [[0] * cw for _ in range(ch)]
    for y in range(ch):
        for x in range(cw):
            d = math.hypot(x - cx, y - cy) / maxd            # 0 centre .. 1 edge
            falloff = 1.0 - d
            val = falloff * 0.75 + noise[y][x] * 0.45 - 0.30 + land_bias
            # force a water ring around the outside so it always reads as an island
            edge = min(x, y, cw - 1 - x, ch - 1 - y)
            if edge < sea_border:
                val = -1.0
            lvl = 0 if val <= 0.18 else min(top, 1 + int(val * top))
            H[y][x] = lvl
    return _smooth_levels(H)


# --- interior rooms ---------------------------------------------------------

def room(cols, rows, seed, door_side="south"):
    """A rectangular interior: floor (level 0) with a solid wall ring (level 1)
    and one door gap on `door_side`. Corner grid sized (rows+1) x (cols+1)."""
    cw, ch = cols + 1, rows + 1
    H = [[0] * cw for _ in range(ch)]
    for y in range(ch):
        for x in range(cw):
            if x == 0 or y == 0 or x == cw - 1 or y == ch - 1:
                H[y][x] = 1                                   # wall ring
    # carve a 2-corner-wide door on the requested side
    mid_x, mid_y = cw // 2, ch // 2
    for k in (-1, 0):
        if door_side == "south":
            H[ch - 1][mid_x + k] = 0
        elif door_side == "north":
            H[0][mid_x + k] = 0
        elif door_side == "east":
            H[mid_y + k][cw - 1] = 0
        else:  # west
            H[mid_y + k][0] = 0
    return H


# --- object scatter ---------------------------------------------------------

def _cell_level(H, col, row):
    """The dominant (max) level of the 4 corners around tile cell (col,row)."""
    return max(H[row][col], H[row][col + 1], H[row + 1][col], H[row + 1][col + 1])


def _cell_uniform(H, col, row):
    """True if all four corners of the cell share one level (a 'flat' cell)."""
    a = H[row][col]
    return (a == H[row][col + 1] == H[row + 1][col] == H[row + 1][col + 1])


def level_name(levels, idx):
    return levels[idx] if 0 <= idx < len(levels) else None


def scatter(H, levels, object_specs, seed, density=0.06, spacing=2, keep_clear=None):
    """Place objects on flat cells whose terrain is in each object's `on` list.

    object_specs: [{id, on:[level_name,...], blocks:bool, footprint:int}]
    density: fraction of eligible cells that receive an object.
    spacing: minimum Chebyshev distance between placements (avoids overlap).
    keep_clear: set of (col,row) cells to never place on (e.g. town/door area).
    Returns [(obj_id, col, row), ...]."""
    rng = random.Random(seed ^ 0x5EED)
    rows, cols = len(H) - 1, len(H[0]) - 1
    keep_clear = keep_clear or set()
    taken = set()
    by_level = {}
    for spec in object_specs:
        for lv in spec.get("on", []):
            by_level.setdefault(lv, []).append(spec)
    placements = []
    cells = [(c, r) for r in range(rows) for c in range(cols)]
    rng.shuffle(cells)
    for (c, r) in cells:
        if (c, r) in keep_clear or (c, r) in taken:
            continue
        if not _cell_uniform(H, c, r):
            continue
        lv = level_name(levels, _cell_level(H, c, r))
        specs = by_level.get(lv)
        if not specs or rng.random() > density:
            continue
        spec = rng.choice(specs)
        fp = spec.get("footprint", 1)
        # reserve a spacing halo so props don't collide / overlap
        halo = set()
        ok = True
        for dy in range(-spacing, fp + spacing):
            for dx in range(-spacing, fp + spacing):
                cc, rr = c + dx, r + dy
                if (cc, rr) in taken:
                    ok = False
                halo.add((cc, rr))
        if not ok:
            continue
        taken |= halo
        placements.append((spec["id"], c, r))
    return placements


def largest_flat_region(H, levels, level_name_wanted):
    """Find cells forming the biggest connected flat area of the wanted level —
    used to site a town on an island. Returns a set of (col,row) cells."""
    rows, cols = len(H) - 1, len(H[0]) - 1
    want = levels.index(level_name_wanted) if level_name_wanted in levels else None
    flat = set()
    for r in range(rows):
        for c in range(cols):
            if _cell_uniform(H, c, r) and _cell_level(H, c, r) == want:
                flat.add((c, r))
    # connected components (4-neighbour)
    best = set()
    seen = set()
    for cell in flat:
        if cell in seen:
            continue
        stack, comp = [cell], set()
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            comp.add(cur)
            cc, cr = cur
            for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nb = (cc + dc, cr + dr)
                if nb in flat and nb not in seen:
                    stack.append(nb)
        if len(comp) > len(best):
            best = comp
    return best


def place_town(H, levels, town_size, seed, house_ids):
    """Place a small cluster of buildings in the island's largest grass area.
    Returns (placements, occupied_cells). Buildings sit on a rough grid so they
    read as a settlement rather than random scatter."""
    rng = random.Random(seed ^ 0x70)
    region = sorted(largest_flat_region(H, levels, "grass"))
    placements, occupied = [], set()
    if not region:
        return placements, occupied
    # anchor near the region centroid, lay buildings on a 5-cell pitch
    cxs = sum(c for c, _ in region) / len(region)
    cys = sum(r for _, r in region) / len(region)
    region_set = set(region)
    slots = []
    for r in range(int(cys) - 6, int(cys) + 7, 5):
        for c in range(int(cxs) - 6, int(cxs) + 7, 5):
            if (c, r) in region_set:
                slots.append((c, r))
    rng.shuffle(slots)
    for (c, r) in slots[:town_size]:
        hid = rng.choice(house_ids)
        placements.append((hid, c, r))
        for dy in range(-1, 3):
            for dx in range(-1, 3):
                occupied.add((c + dx, r + dy))
    return placements, occupied


def coast_dock_cell(H, levels):
    """Pick a beach cell adjacent to open water for a dock/harbour exit.
    Returns (col,row) or None. Prefers the southernmost coast (bottom of map)."""
    rows, cols = len(H) - 1, len(H[0]) - 1
    sand = levels.index("sand") if "sand" in levels else 1
    best = None
    for r in range(rows):
        for c in range(cols):
            if _cell_level(H, c, r) != sand:                 # dominant terrain is beach
                continue
            near_water = any(
                _cell_level(H, c + dc, r + dr) == 0
                for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1))
                if 0 <= c + dc < cols and 0 <= r + dr < rows)
            if near_water and (best is None or r > best[1]):
                best = (c, r)
    return best
