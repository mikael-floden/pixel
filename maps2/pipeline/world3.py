"""THE GAME (maintainer 2026-08-24) — the_island2 rebuilt on Tiles 3.0.

`pixel-maps3/world@1`, in maps2/worlds3/ — a folder NOTHING in the game scans
(verified: build-worlds.mjs and WorldRoom read exactly maps2/worlds/), so the
migration can be judged before the game ever knows it exists.

THE FORMAT STORES SEMANTICS, NOT TILE PATHS. A v2 world bakes 4,693 tile paths;
a v3 world stores a GROUND TYPE per cell and lets the renderer resolve art
through the tile system's own rules at draw time:

  * fields      -> ground_types.json surface model: flat colour until the
                   maintainer promotes base tiles (live/tuning/base_tiles.json,
                   weighted groups) — THE LAW: no agent introduces texture;
  * walls       -> the x-over-y review matrix (tiles/review/manifest.json),
                   THE ONLY TILES THAT EVER SHOW A WALL, side picked by rule
                   (the ground at the face's foot) + live/tuning/tile_walls.json
                   overrides;
  * boundaries  -> the transition sets (tiles/transitions), drawn on the CORNER
                   lattice, one set per pair, fit-picked; pairs with no set fall
                   back to a FADE (the pair's two palette colours painted
                   through a borrowed mask — flagged for review);
  * details     -> top-approved tiles (live/feedback/tiles.json '#top' entries)
                   sprinkled at DETAIL_FREQ — pool is EMPTY today by design and
                   fills as the maintainer approves tops;
  * scenery     -> scenery/ pieces, off-grid (fractional cells), lit variants
                   as states, hitbox art-measured from the sprite base (no
                   canonical hitbox field ships in scenery yet — flagged).

The terrain IS the_island2's: the same Island2 generator run at the same seed,
so every judgement already made about the island (the gorge, the headlands, the
roads, the houses, the cave, the chess pitch) carries over verbatim. Only the
PAINT changes — plus the new ground types v2 could not express:

  v2 -> v3: saturated_grass->grass, regular_snow->snow, crystal_ice->ice,
  black_mountain->black_rock, stone_mountain->grey_stone,
  light_sand->light_beach, lightdark_dirt->light_soil, clear_water->water.

  NEW GROUND, by rule (never spot edits):
  * deep_water   open sea further than DEEP_R cells from any land — the ocean
                 finally has depth;
  * dark_mud     the fen: level-0 grass within MUD_R of inland-or-south water,
                 where the bog cast (swamp cats, swamp bear) lives;
  * parquet_floor the floor INSIDE both houses (walls stay stone);
  * brown_paving_stone the yard in front of the stone house door.
  Lava and slime are deliberately NOT placed — no ground on this island says
  volcano, and a taste call that big is the maintainer's.

    python maps2/pipeline/world3.py          # build worlds3/the_game/world.json
"""
from __future__ import annotations

import json
import os
import sys
from collections import deque

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
OUT = os.path.join(MAPS2, "worlds3", "the_game")

SCHEMA = "pixel-maps3/world@1"

V2_TO_V3 = {
    "saturated_grass": "grass", "regular_snow": "snow", "crystal_ice": "ice",
    "black_mountain": "black_rock", "stone_mountain": "grey_stone",
    "light_sand": "light_beach", "lightdark_dirt": "light_soil",
    "clear_water": "water", "": "",
}
LIQUIDS = ("water", "deep_water")
DEEP_R = 7          # open sea further than this from land is deep_water
MUD_R = 1           # the fen: a single-cell muddy bank strip along the river


def _grid(doc):
    W, H = doc["size"]["w"], doc["size"]["h"]
    mats = doc["materials"]
    mat = [[V2_TO_V3[mats[i]] for i in row] for row in doc["mat"]]
    return W, H, mat, doc["level"]


def _deep_water(W, H, mat):
    """Open-sea cells further than DEEP_R from any land (4-neighbour BFS)."""
    land = [(x, y) for y in range(H) for x in range(W)
            if mat[y][x] not in ("", "water")]
    dist = {c: 0 for c in land}
    q = deque(land)
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = (x + dx, y + dy)
            if 0 <= n[0] < W and 0 <= n[1] < H and mat[n[1]][n[0]] == "water" \
                    and n not in dist:
                dist[n] = dist[(x, y)] + 1
                q.append(n)
    for (x, y), d in dist.items():
        if mat[y][x] == "water" and d > DEEP_R:
            mat[y][x] = "deep_water"
    # the map's outer frame never touched land in the BFS: it is open sea too
    for y in range(H):
        for x in range(W):
            if mat[y][x] == "water" and (x, y) not in dist:
                mat[y][x] = "deep_water"


def _fen(W, H, mat, lvl):
    """dark_mud: the RIVERBANKS — level-0 grass hugging channel water (water
    with land within CHAN_R on both sides of an axis: the gorge river and the
    ponds), never the open coast, which stays the beach's ground. The bog cast
    (the swamp cats, the swamp bear) lives exactly here."""
    CHAN_R = 12

    def landnear(x, y, dx, dy):
        for k in range(1, CHAN_R + 1):
            xx, yy = x + dx * k, y + dy * k
            if not (0 <= xx < W and 0 <= yy < H):
                return False
            if mat[yy][xx] not in ("water", "deep_water", ""):
                return True
        return False

    chan = {(x, y) for y in range(H) for x in range(W)
            if mat[y][x] == "water"
            and ((landnear(x, y, 1, 0) and landnear(x, y, -1, 0))
                 or (landnear(x, y, 0, 1) and landnear(x, y, 0, -1)))}
    out = 0
    for y in range(H):
        for x in range(W):
            if mat[y][x] != "grass" or lvl[y][x] > 4:
                continue                     # the banks ride the river's own
                                             # tier-4 shoulders; higher is cliff
            if any((x + dx, y + dy) in chan
                   for dx in range(-MUD_R, MUD_R + 1)
                   for dy in range(-MUD_R, MUD_R + 1)):
                mat[y][x] = "dark_mud"
                out += 1
    return out


def _houses(doc, mat):
    """THE HOUSES ARE BUILT FROM THE X-OVER-Y MATRIX (maintainer 2026-08-28:
    "rebuild the houses using new tiles like grass over parquet floor... in
    both stone (brown paving stone) and wood... you can also change the top
    ground type without adding a new layer").

    A wall is a raised cell whose TOP is one ground and whose FACE is the
    building material — no extra layer, the over matrix carries every pair:

      the STONE HOUSE (spawn cottage): grey_paving_stone tops over
        brown_paving_stone faces — a slate-rimmed cobble build; cobble roof.
      the MEADOW HOUSE: grass tops over parquet_floor faces — a turf-roofed
        timber build (the maintainer's own example pair), turf roof slab.

    Interiors floor in parquet. Returns (floors, walls_overrides)."""
    floors = 0
    walls = []
    # the meadow house roof deck is the big one; the stone house's the small
    roofs = sorted((dk for dk in doc.get("decks", []) if dk.get("kind") == "roof"),
                   key=lambda dk: len(dk["cells"]))
    for hi, dk in enumerate(roofs):
        lv, th = int(dk["level"]), int(dk.get("thickness", 1))
        stone = hi == 0                       # smallest roof = the spawn cottage
        wallmat = "brown_paving_stone" if stone else "parquet_floor"
        topmat = "grey_paving_stone" if stone else "grass"
        wcells = []
        for c in dk["cells"]:
            x, y = int(c["x"]), int(c["y"])
            if doc["level"][y][x] < lv - th:  # floor, not wall top
                mat[y][x] = "parquet_floor"
                floors += 1
            else:                              # wall cell: authored top + face
                mat[y][x] = topmat
                wcells.append({"x": x, "y": y})
        walls.append({"side": wallmat, "cells": wcells})
    return floors, walls


def _yard(doc, mat, lvl):
    """The paved yard: the 3x2 patch in front of the stone house door."""
    # the stone house door is at (201,117) facing south (islandworld2)
    n = 0
    for y in (118, 119):
        for x in (200, 201, 202):
            if mat[y][x] == "grass" and lvl[y][x] == 0:
                mat[y][x] = "brown_paving_stone"
                n += 1
    return n


SCEN_BY_GROUND = {
    # a prop keeps its CELL but picks its species by the ground it stands on —
    # an autumn oak on the snow summit was the tell that path-only mapping lies
    "snow": ("crystal_trees",), "ice": ("crystal_trees",),
    "grey_stone": ("rock_spires",), "black_rock": ("rock_spires",),
    "light_beach": ("beached_rowboats", "bushes"),
}


MASSIF_LVL = 14          # at/above this the land is the mountain: rock body
ROCKY = {"black_rock", "grey_stone", "light_beach", "dark_mud",
         "brown_paving_stone", "grey_paving_stone", "parquet_floor"}


def _terrain_walls(W, H, mat, lvl):
    """THE MOUNTAIN IS ROCK UNDER ITS GROUND (maintainer 2026-08-28: "the
    mountain and all cliffs should use the new x-over-x/y to specify what
    mountain/wall type should be under the ground type").

    Every exposed rim cell gets an authored wall BODY through the same `walls`
    channel the houses use:

      massif (level >= MASSIF_LVL)  grey_stone body — snow, ice and grass are
                                    a skin on the mountain, so a cliff shows
                                    snow-over-stone, never snow all the way
                                    down;
      lowland grass/soil tiers      light_soil body — the maze terraces are
                                    turf over earth, the v2 ochre cliffs
                                    reborn as a real over-pair;
      rocky/paved/mud grounds       keep their own body (skip — the foot rule
                                    and same-over-same already say it).
    """
    out = {}
    for y in range(H):
        for x in range(W):
            g = mat[y][x]
            if not g or g in ROCKY or g in ("water", "deep_water"):
                continue
            zl = lvl[y][x]
            if zl <= 0:
                continue
            lower = False
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H and lvl[ny][nx] < zl:
                    lower = True
                    break
            if not lower:
                continue
            side = "grey_stone" if zl >= MASSIF_LVL else "light_soil"
            out.setdefault(side, []).append({"x": x, "y": y})
    return [{"side": side, "cells": cells} for side, cells in sorted(out.items())]


def _scenery(doc):
    """Translate v2 prop-tiles into scenery placements, plus the pieces already
    placed as props (the chess tables ARE scenery pieces).

    v2 trees were tiles2 prop-tiles; scenery owns trees now. The mapping is by
    RULE on the prop path: tall grass props (base_x_4/5) -> a tree piece,
    rotating deterministically through the maintainer-approved trees so a wood
    is not one tree stamped; the bonfire A/B fixture -> the campfire piece; the
    chess tables -> their own scenery ids. Placement keeps the prop's cell
    (centre), fractional coords allowed by the format."""
    ancient = sorted(d for d in os.listdir(os.path.join(REPO, "scenery", "ancient_trees"))
                     if os.path.isdir(os.path.join(REPO, "scenery", "ancient_trees", d)))
    W2, H2 = len(doc["mat"][0]), len(doc["mat"])
    v3mat = [[V2_TO_V3.get(doc["materials"][i], "") for i in row]
             for row in doc["mat"]]
    out = []
    paths = doc["paths"]
    props = sorted(doc.get("props", []), key=lambda p: (p["y"], p["x"]))
    ti = 0
    for p in props:
        path = paths[p["tile"]]
        x, y = p["x"] + 0.5, p["y"] + 0.5
        if "chess_table_1" in path:
            out.append({"piece": "chess_tables/chess_table_006", "x": x, "y": y})
        elif "chess_table_2" in path:
            out.append({"piece": "chess_tables/chess_table_009", "x": x, "y": y})
        elif "base_x_3" in path or "base_x_4" in path or "base_x_5" in path:
            gx, gy = p["x"], p["y"]
            v3g = V2_TO_V3.get(doc["materials"][doc["mat"][gy][gx]], "grass")
            groups = SCEN_BY_GROUND.get(v3g)
            if groups:
                grp = groups[ti % len(groups)]
                pool2 = sorted(d for d in os.listdir(os.path.join(REPO, "scenery", grp))
                               if os.path.isdir(os.path.join(REPO, "scenery", grp, d)))
                pick = pool2[ti % len(pool2)]
            elif "base_x_5" in path:
                grp = "ancient_trees"
                pick = ancient[ti % len(ancient)]
            else:
                # prop trees obey the SAME three-type rule as the forests
                # (cycling the full tree list here was the fruit salad)
                grp = "trees"
                u = ((ti * 2654435761) & 0xffff) / 65536
                pool = TREE_TYPES[_tree_pick(v3mat, doc["level"], W2, H2,
                                             p["x"], p["y"], u)]
                pick = pool[ti % len(pool)]
            out.append({"piece": f"{grp}/{pick}", "x": x, "y": y,
                        "hflip": bool(ti % 2)})
            ti += 1
        else:
            # low decor props (base_x_2 boulders/shrubs) — bushes, len-safe
            bushes = sorted(d for d in os.listdir(os.path.join(REPO, "scenery", "bushes"))
                            if os.path.isdir(os.path.join(REPO, "scenery", "bushes", d)))
            out.append({"piece": "bushes/" + bushes[ti % len(bushes)], "x": x, "y": y,
                        "hflip": bool(ti % 2)})
            ti += 1
    return out


def _rng32(seed):
    s0 = seed & 0xffffffff
    def r():
        nonlocal s0
        s0 = (s0 * 1664525 + 1013904223) & 0xffffffff
        return s0 / 2 ** 32
    return r


TREE_TYPES = {
    # Sets grouped by LOOK from a rendered contact sheet — NOT by species
    # name (the name lists mixed white-blossom pieces into "birch" and
    # gnarled broadleafs into "pine"; the maintainer counted 4-5 looks in
    # one wood and called it "how NOT to build a forest"). Every list below
    # reads as variations of ONE tree:
    "hawthorn": ["tree_005", "tree_011", "tree_053"],   # white blossom trio
    "conifer": ["tree_069", "tree_006"],                # true pine pair
    "green_oak": ["tree_047", "tree_024", "tree_075"],  # big green gnarled
    "birch": ["tree_001", "tree_008"],                  # white-trunk pair
}

# a WOOD speaks exactly ONE set (maintainer: "maybe two, absolutely max 3
# different trees" per forest — one set of 2-3 look-alike pieces IS that).
# Different woods across the map may differ. Highland woods are conifer.
WOOD_PALETTES = ["hawthorn", "conifer", "green_oak", "birch"]
FOREST_BUSHES = ["bush_001", "bush_011", "bush_017"]   # matching blueberry


def _tree_pick(mat, lvl, W, H, x, y, u):
    """Placement-time pick — a placeholder look; retype_woods() makes the
    final per-wood call over every tree at the end of the build."""
    highish = lvl[y][x] >= 6 or any(
        0 <= x + dx < W and 0 <= y + dy < H
        and mat[y + dy][x + dx] in ("grey_stone", "snow", "black_rock")
        for dx, dy in ((8, 0), (-8, 0), (0, 8), (0, -8)))
    return "conifer" if highish else "birch"


def retype_woods(scen, is_high):
    """THE FOREST COHERENCE PASS — the LAST word on tree species. All placed
    trees AND forest ancients cluster into WOODS (link distance 8); every
    wood of 2+ retypes to exactly ONE look-alike set from WOOD_PALETTES by
    centroid hash (conifer forced on highland woods). Ancients inside a
    wood become the wood's own trees — giant brown canopies inside a pine
    wood read as a fifth tree type (maintainer screenshot, 2026-08-30);
    a SOLITARY ancient stays a landmark. Runs after all placement, so no
    code path can leak a stray look into a wood."""
    trees = [p for p in scen
             if p["piece"].startswith(("trees/", "ancient_trees/"))]
    if not trees:
        return 0
    buckets = {}
    for i, t in enumerate(trees):
        buckets.setdefault((int(t["x"]) // 8, int(t["y"]) // 8), []).append(i)
    parent = list(range(len(trees)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, t in enumerate(trees):
        bx, by = int(t["x"]) // 8, int(t["y"]) // 8
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in buckets.get((bx + dx, by + dy), ()):
                    if j < i and (trees[i]["x"] - trees[j]["x"]) ** 2 + \
                            (trees[i]["y"] - trees[j]["y"]) ** 2 <= 64:
                        parent[find(i)] = find(j)
    woods = {}
    for i in range(len(trees)):
        woods.setdefault(find(i), []).append(i)
    for members in woods.values():
        if len(members) < 2:
            continue                   # a lone specimen may be anything
        cx = sum(trees[i]["x"] for i in members) / len(members)
        cy = sum(trees[i]["y"] for i in members) / len(members)
        h = (int(cx) * 2654435761 ^ int(cy) * 40503 ^ 0xd00d) & 0xffffffff
        ty = "conifer" if is_high(int(cx), int(cy)) else \
            WOOD_PALETTES[h % len(WOOD_PALETTES)]
        pool = TREE_TYPES[ty]
        for k, i in enumerate(sorted(members)):
            th = (h ^ (k * 40503) ^ 0x7ee5) & 0xffffffff
            trees[i]["piece"] = "trees/" + pool[th % len(pool)]
    return len(woods)


for _ty, _pieces in list(TREE_TYPES.items()) + [("bush", FOREST_BUSHES)]:
    _grp = "bushes" if _ty == "bush" else "trees"
    for _p in _pieces:
        assert os.path.isdir(os.path.join(REPO, "scenery", _grp, _p)), \
            f"palette piece missing: {_grp}/{_p} ({_ty})"


def _forests(W, H, mat, lvl, scen, spawn):
    """REAL WOODS (maintainer 2026-08-28: "you can now place lots of trees to
    create a forest"). Scenery is cheap now, so the eight lonely groves become
    forests — grown by rule:

      seeds     every existing tree placement on grass (the v2 grove sites)
                plus the biggest open-grass interiors;
      trees     THE THREE-TYPE PALETTE ONLY (_tree_pick): birch lowland,
                pine upland, grand oak rare — variation comes from the
                pieces within a type, never from mixing types;
      ground    flat grass only — never roads (+2), banks, beach, rims, water;
      keep-outs spawn plaza (r 12), the houses (+4), existing pieces;
      density   jittered stride grid, ~1 tree per 4-5 cells inside a wood,
                thinning toward the edge; ancients rare, a bush fringe;
      lights    all BASE (unlit) pieces — the engine's budget is 8 point
                lights per camera window (games2 check-light-budget) and the
                forest must cost ZERO of them.
    """
    sx, sy = spawn

    def grass_flat(x, y):
        if not (0 <= x < W and 0 <= y < H) or mat[y][x] != "grass":
            return False
        z = lvl[y][x]
        return all(0 <= x + dx < W and 0 <= y + dy < H and lvl[y + dy][x + dx] == z
                   for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))

    def clear(x, y):
        if abs(x - sx) + abs(y - sy) <= 12:
            return False
        for dx in (-2, -1, 0, 1, 2):
            for dy in (-2, -1, 0, 1, 2):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H and mat[ny][nx] in (
                        "light_soil", "dark_mud", "brown_paving_stone",
                        "grey_paving_stone", "parquet_floor"):
                    return False
        return True

    seeds = [(int(p["x"]), int(p["y"])) for p in scen
             if p["piece"].startswith(("trees/", "ancient_trees/"))
             and mat[int(p["y"])][int(p["x"])] == "grass"]
    # three broad open-grass interiors as new heartwoods (deterministic scan)
    best = []
    for y in range(8, H - 8, 6):
        for x in range(8, W - 8, 6):
            if not grass_flat(x, y) or not clear(x, y):
                continue
            score = sum(grass_flat(x + dx, y + dy)
                        for dx in range(-6, 7, 3) for dy in range(-6, 7, 3))
            best.append((score, x, y))
    best.sort(reverse=True)
    hearts = []
    for sc, x, y in best:
        if sc < 20:
            break
        if all(abs(x - hx) + abs(y - hy) > 34 for hx, hy in hearts):
            hearts.append((x, y))
        if len(hearts) >= 5:
            break
    seeds += hearts
    WOOD_R = 12       # real woods, not groves (maintainer 2026-08-29: "don't
                      # be shy... I'm looking forward to see hundreds of trees")
    out, taken = [], {(int(p["x"]), int(p["y"])) for p in scen}
    for y in range(0, H, 2):
        for x in range(0, W, 2):
            r = _rng32((x * 2654435761) ^ (y * 40503) ^ 0x5eed)
            d2 = min(((x - ax) ** 2 + (y - ay) ** 2 for ax, ay in seeds),
                     default=10 ** 9)
            if d2 > WOOD_R * WOOD_R:
                continue
            edge = d2 > (WOOD_R - 3) ** 2
            if r() > (0.55 if not edge else 0.30):
                continue
            jx, jy = x + int(r() * 2), y + int(r() * 2)
            if not grass_flat(jx, jy) or not clear(jx, jy) or (jx, jy) in taken:
                continue
            taken.add((jx, jy))
            u = r()
            if edge and u < 0.12:
                grp, pool = "bushes", FOREST_BUSHES
            else:
                grp = "trees"
                pool = TREE_TYPES[_tree_pick(mat, lvl, W, H, jx, jy, r())]
            pick = pool[int(r() * len(pool)) % len(pool)]
            out.append({"piece": f"{grp}/{pick}",
                        "x": jx + 0.25 + round(r() * 0.5, 2),
                        "y": jy + 0.25 + round(r() * 0.5, 2),
                        "hflip": r() < 0.5})
    return out


def _light_audit(scen):
    """THE ENGINE'S LIGHT BUDGET (games2/scripts/check-light-budget.mjs): 8
    point-light slots per worst-case camera window (899x774 px, each light
    grown by its reach). Mirrored here for worlds3 so a scenery pass can never
    ship a scene the engine has to degrade. Radius assumed campfire-class (7
    cells) for lit scenery until scenery publishes real radii."""
    import math
    VIEW_W, VIEW_H, SLOTS, RAD = 899, 774, 8, 7
    RX, RY = math.sqrt(2) * 32 * RAD, math.sqrt(2) * 15 * RAD
    lit = []
    for p in scen:
        d = json.load(open(os.path.join(REPO, "scenery", p["piece"], "scenery.json")))
        # a light is a PLACEMENT choice: {"lit": true} selects the piece's
        # LIT_* state sprite; inherently-lit pieces (lights == LIGHTS_ON)
        # count too. Unlit placements of lightable pieces cost nothing.
        if p.get("lit") or d.get("lights") == "LIGHTS_ON":
            lit.append(((p["x"] - p["y"]) * 32, (p["x"] + p["y"]) * 15))
    worst = 0
    for (cx, cy) in lit:
        n = sum(1 for (ox, oy) in lit
                if abs(ox - cx) <= VIEW_W / 2 + RX and abs(oy - cy) <= VIEW_H / 2 + RY)
        worst = max(worst, n)
    assert worst <= SLOTS, (
        f"LIGHT BUDGET BLOWN: {worst} lit scenery pieces share one camera "
        f"window — the engine has {SLOTS} slots (check-light-budget). Unlight "
        f"or spread them.")
    return len(lit), worst


def build():
    src = json.load(open(os.path.join(MAPS2, "worlds", "the_island2", "world.json")))
    W, H, mat, lvl = _grid(src)
    _deep_water(W, H, mat)
    fen = _fen(W, H, mat, lvl)
    floors, walls = _houses(src, mat)
    walls += _terrain_walls(W, H, mat, lvl)
    yard = _yard(src, mat, lvl)
    scen = _scenery(src)
    scen += _forests(W, H, mat, lvl, scen, (int(src["spawn"][0]), int(src["spawn"][1])))

    def _is_high(x, y):
        if not (0 <= x < W and 0 <= y < H):
            return False
        return lvl[y][x] >= 6 or any(
            0 <= x + dx < W and 0 <= y + dy < H
            and mat[y + dy][x + dx] in ("grey_stone", "snow", "black_rock")
            for dx, dy in ((8, 0), (-8, 0), (0, 8), (0, -8)))
    retype_woods(scen, _is_high)
    nlit, worst = _light_audit(scen)

    grounds = sorted({m for row in mat for m in row if m})
    gi = {g: i for i, g in enumerate(grounds)}
    decks = []
    for dk in src.get("decks", []):
        kind = dk.get("kind", "deck")
        ground = V2_TO_V3.get(src["materials"][dk["mat"]], "grey_stone") \
            if isinstance(dk.get("mat"), int) else "grey_stone"
        # ROOFS: v2 slate was black_mountain; v3 black_rock is a flat
        # near-black and a big flat black slab is not a roof. grey_paving_stone
        # is v3's patterned always-own-texture surface with a published base
        # tile — it reads as shingles. A taste call, flagged in the build log.
        if kind == "roof":
            small = len(dk["cells"]) <= min(len(d2["cells"]) for d2 in src["decks"]
                                            if d2.get("kind") == "roof")
            ground = "grey_paving_stone" if small else "grass"
        decks.append({"kind": kind, "level": dk["level"],
                      "thickness": dk.get("thickness", 1), "ground": ground,
                      "cells": [{"x": c["x"], "y": c["y"]} for c in dk["cells"]]})

    doc = {
        "schema": SCHEMA,
        "name": "the_game",
        "size": {"w": W, "h": H},
        "grounds": grounds,
        "liquids": [g for g in LIQUIDS if g in gi],
        "ground": [[gi.get(m, -1) if m else -1 for m in row] for row in mat],
        "level": lvl,
        "spawn": src["spawn"],
        "decks": decks,
        "walls": walls,
        "scenery": scen,
    }
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "world.json"), "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    from collections import Counter
    c = Counter(m for row in mat for m in row if m)
    print(f"the_game: {W}x{H}, {len(grounds)} grounds, {len(scen)} scenery "
          f"({nlit} lit, worst window {worst}/8), {len(decks)} decks | "
          f"fen {fen}, floors {floors}, yard {yard}")
    for g, n in c.most_common():
        print(f"   {g:20s} {n}")
    return doc


if __name__ == "__main__":
    build()
