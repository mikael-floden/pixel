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
import math
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
        # THE ROOF IS THE THIN COURSE ON TOP OF THE WALL, not a slab
        # (maintainer 2026-08-30): the ring cell's TOP is the roof material
        # and its FACE is the wall, so the roof reads as a band. Wall
        # materials are his three: parquet, brown paving, grey paving.
        stone = hi == 0                       # smallest roof = the spawn cottage
        wallmat = "brown_paving_stone" if stone else "parquet_floor"
        topmat = "grey_paving_stone" if stone else "light_soil"
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
                pool = FOREST_SETS[_tree_pick(v3mat, doc["level"], W2, H2,
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


FOREST_SETS = {
    # Look-clusters read off a rendered contact sheet of all 71 tree pieces
    # (names lie: the "birch" name list mixed white-blossom crowns into the
    # silver birches). Each set is internally ONE tree, and every set is
    # visibly DIFFERENT from every other — that is what lets one region's
    # wood look nothing like the next region's.
    # NO GLOWING TRUNKS in a forest set: tree_058 and tree_074 carry a
    # cyan-glowing trunk, and an independent visual audit read them as a
    # "corrupted species" wherever they appeared. Loud magic is a landmark,
    # never a forest's building block.
    "birch_pale":    ["tree_001", "tree_083", "tree_045"],
    "conifer_dark":  ["tree_069", "tree_063"],
    "conifer_snow":  ["tree_031", "tree_065", "tree_017"],
    "oak_green":     ["tree_047", "tree_077", "tree_059", "tree_035"],
    "oak_dark":      ["tree_046", "tree_066", "tree_034"],
    "autumn_red":    ["tree_015", "tree_029", "tree_057", "tree_071"],
    "autumn_gold":   ["tree_003", "tree_021", "tree_052", "tree_067"],
    "blossom_white": ["tree_005", "tree_011", "tree_053"],
    # tree_012/tree_054 are white-and-yellow FLOWERING trees on orange
    # trunks — a different tree from the grey weeping willows, audit-caught
    "willow_grey":   ["tree_043", "tree_085"],
    "dead_bare":     ["tree_009", "tree_028", "tree_051", "tree_070"],
    "windswept":     ["tree_075", "tree_079", "tree_024"],
}

# the understory that belongs with each canopy — a wood's bushes are retyped
# with its trees, so the floor never fights the crown
FOREST_UNDER = {
    "birch_pale": ["bush_001", "bush_011"], "conifer_dark": ["bush_017"],
    "conifer_snow": ["bush_008"], "oak_green": ["bush_015", "bush_001"],
    "oak_dark": ["bush_017", "bush_011"], "autumn_red": ["bush_016"],
    "autumn_gold": ["bush_016", "bush_900"], "blossom_white": ["bush_007"],
    "willow_grey": ["bush_008"], "dead_bare": ["bush_008"],
    "windswept": ["bush_015"],
}

# THE FOREST MAP (maintainer 2026-08-30: "why do you use the same trees on
# the west, east, north and south side? Can't you change how the forest look
# at different locations?"). Region decides identity, exactly like the
# maintainer's base-tile-set system decides a ground's look per region:
#   * TERRAIN first — snowline, highland, bog, and the wind-blasted coast
#     each speak their own tree wherever they occur;
#   * otherwise the COMPASS wedge around the island centroid, in SCREEN
#     space (iso: east = x-y, south = x+y), with the outer ring shifted
#     half a turn — so N/E/S/W differ, and each has an inner and an outer
#     wood that differ too. 8 wedges x 2 rings = 16 forest areas.
COMPASS_FORESTS = ["oak_green", "autumn_red", "birch_pale", "oak_dark",
                   "blossom_white", "autumn_gold", "conifer_dark",
                   "willow_grey"]   # ordered so NEIGHBOURING wedges contrast


class ForestCtx:
    """Where a wood stands decides what it is. ground_at/level_at are the
    caller's own grid probes, so world3 and world3grow share one rule."""

    def __init__(self, W, H, ground_at, level_at):
        self.W, self.H = W, H
        self.g, self.z = ground_at, level_at
        pts = [(x, y) for y in range(0, H, 3) for x in range(0, W, 3)
               if (ground_at(x, y) or "") not in ("", "water", "deep_water")]
        assert pts, "no land to build a forest map on"
        self.cx = sum(p[0] for p in pts) / len(pts)
        self.cy = sum(p[1] for p in pts) / len(pts)
        self.rmax = max(math.hypot(p[0] - self.cx, p[1] - self.cy)
                        for p in pts) or 1.0

    def near(self, x, y, grounds, r):
        for dx in range(-r, r + 1, max(1, r // 2)):
            for dy in range(-r, r + 1, max(1, r // 2)):
                if (self.g(x + dx, y + dy) or "") in grounds:
                    return True
        return False

    def identity(self, x, y):
        z = self.z(x, y)
        if z >= 18 or self.near(x, y, ("snow", "ice"), 4):
            return "conifer_snow"
        if self.near(x, y, ("dark_mud",), 4):
            return "dead_bare"
        if z >= 13 or self.near(x, y, ("grey_stone", "black_rock"), 3):
            return "conifer_dark"    # tight: at radius 6 the mountain ate
                                     # 356 of 802 trees and the map went one
                                     # colour again
        if z <= 2 and self.near(x, y, ("light_beach",), 4):
            return "windswept"
        if self.near(x, y, ("water",), 3):
            return "willow_grey"
        u = (x - y) - (self.cx - self.cy)          # screen east
        v = (x + y) - (self.cx + self.cy)          # screen south
        sector = int((math.atan2(v, u) + math.pi) / (2 * math.pi) * 8) % 8
        ring = 4 if math.hypot(x - self.cx, y - self.cy) > 0.55 * self.rmax \
            else 0
        return COMPASS_FORESTS[(sector + ring) % len(COMPASS_FORESTS)]


def _tree_pick(mat, lvl, W, H, x, y, u):
    """Placement-time placeholder — retype_woods() makes the final call."""
    highish = lvl[y][x] >= 6 or any(
        0 <= x + dx < W and 0 <= y + dy < H
        and mat[y + dy][x + dx] in ("grey_stone", "snow", "black_rock")
        for dx, dy in ((8, 0), (-8, 0), (0, 8), (0, -8)))
    return "conifer_dark" if highish else "birch_pale"


def retype_woods(scen, ctx):
    """THE FOREST PASS — the LAST word on what a wood is made of. Every
    placed tree, forest ancient and bush clusters into WOODS (link 8); each
    tree asks the FOREST MAP where it stands, the answer is mode-smoothed
    over its neighbours, and it is retyped to that identity's canopy set
    (bushes follow the nearest tree). Runs after all placement, so no placer
    can leak a foreign look in; and because identity is geographic, the
    north wood, the east wood and the shore wood are different forests.
    Returns {identity: n_trees}."""
    items = [p for p in scen
             if p["piece"].startswith(("trees/", "ancient_trees/", "bushes/"))]
    trees = [p for p in items
             if p["piece"].startswith(("trees/", "ancient_trees/"))]
    if not trees:
        return {}
    # 1) every tree asks the FOREST MAP where IT stands. Identity per tree,
    #    not per cluster: link-8 clustering merged the whole southern belt
    #    into one 300-tree "wood" and painted a quarter of the island one
    #    colour (measured). The region is what is spatially coherent.
    ident = [ctx.identity(int(t["x"]), int(t["y"])) for t in trees]
    buckets = {}
    for i, t in enumerate(trees):
        buckets.setdefault((int(t["x"]) // 8, int(t["y"]) // 8), []).append(i)

    def neighbours(i, r2=49):
        bx, by = int(trees[i]["x"]) // 8, int(trees[i]["y"]) // 8
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in buckets.get((bx + dx, by + dy), ()):
                    if (trees[i]["x"] - trees[j]["x"]) ** 2 + \
                            (trees[i]["y"] - trees[j]["y"]) ** 2 <= r2:
                        yield j

    # 2) two mode-smoothing passes: a tree adopts the identity most of its
    #    neighbours have, so a stand never checkerboards at a region seam —
    #    the boundary moves to where the trees thin out, which is where a
    #    real forest changes.
    for _ in range(2):
        ident = [max(set(v := [ident[j] for j in neighbours(i)]), key=v.count)
                 for i in range(len(trees))]
    # 3) THE ECOTONE: where two forests meet, feather them into each other
    #    instead of ruling a line — a third of the trees within reach of the
    #    other identity take it, so the change reads as a wood giving way to
    #    a wood (a hard seam between scarlet and near-black was the flaw an
    #    independent visual audit caught).
    feathered = list(ident)
    for i in range(len(trees)):
        other = [ident[j] for j in neighbours(i, 81) if ident[j] != ident[i]]
        if len(other) < 2:
            continue        # a lone dissenter is not a boundary
        # feather in PATCHES, not per tree: the hash is on a 4-cell block, so
        # neighbouring trees flip together and the band interleaves in
        # tongues. Per-tree flipping stranded single loud trees inside a
        # foreign wood — three independent judges each caught one.
        h = ((int(trees[i]["x"]) // 4) * 2246822519
             ^ (int(trees[i]["y"]) // 4) * 3266489917) & 0xffffffff
        if h % 100 < 40:
            feathered[i] = max(set(other), key=other.count)
    ident = feathered
    # MINIMUM STAND SIZE: a tree whose own identity has fewer than 3 members
    # within reach reverts to the local majority. A one-off tree of a strong
    # species does not read as variation, it reads as a placement mistake.
    for _ in range(2):
        fixed = list(ident)
        for i in range(len(trees)):
            near = [ident[j] for j in neighbours(i, 100)]
            if near.count(ident[i]) < 3:
                fixed[i] = max(set(near), key=near.count)
        ident = fixed
    tally = {}
    for i, t in enumerate(trees):
        canopy = FOREST_SETS[ident[i]]
        h = (int(t["x"] * 4) * 2654435761 ^ int(t["y"] * 4) * 40503
             ^ 0xd00d) & 0xffffffff
        t["piece"] = "trees/" + canopy[h % len(canopy)]
        tally[ident[i]] = tally.get(ident[i], 0) + 1
    # 3) understory follows the nearest tree's identity
    for b in items:
        if not b["piece"].startswith("bushes/"):
            continue
        bx, by = int(b["x"]) // 8, int(b["y"]) // 8
        near = [j for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                for j in buckets.get((bx + dx, by + dy), ())]
        if not near:
            continue
        j = min(near, key=lambda j: (trees[j]["x"] - b["x"]) ** 2
                + (trees[j]["y"] - b["y"]) ** 2)
        if (trees[j]["x"] - b["x"]) ** 2 + (trees[j]["y"] - b["y"]) ** 2 > 64:
            continue
        under = FOREST_UNDER[ident[j]]
        h = (int(b["x"] * 4) * 40503 ^ int(b["y"] * 4) * 2654435761) & 0xffffffff
        b["piece"] = "bushes/" + under[h % len(under)]
    return tally


for _ty, _pieces in list(FOREST_SETS.items()):
    for _p in _pieces:
        assert os.path.isdir(os.path.join(REPO, "scenery", "trees", _p)), \
            f"canopy piece missing: trees/{_p} ({_ty})"
assert set(FOREST_UNDER) == set(FOREST_SETS), "every canopy needs understory"
for _ty, _pieces in FOREST_UNDER.items():
    for _p in _pieces:
        assert os.path.isdir(os.path.join(REPO, "scenery", "bushes", _p)), \
            f"understory piece missing: bushes/{_p} ({_ty})"



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
                grp, pool = "bushes", FOREST_UNDER["birch_pale"]
            else:
                grp = "trees"
                pool = FOREST_SETS[_tree_pick(mat, lvl, W, H, jx, jy, r())]
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

    ctx = ForestCtx(W, H,
                    lambda x, y: mat[y][x] if 0 <= x < W and 0 <= y < H else "",
                    lambda x, y: lvl[y][x] if 0 <= x < W and 0 <= y < H else 0)
    retype_woods(scen, ctx)
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
        cells = [{"x": c["x"], "y": c["y"]} for c in dk["cells"]]
        if kind == "roof":
            # INTERIOR ONLY. The deck is what tells the game you are indoors
            # (it blacks out the world and fixes the draw order); the wall
            # ring keeps its own thin roof-over-wall course, so the roof is
            # not a slab lying over the walls as well.
            top_lv = max(lvl[c["y"]][c["x"]] for c in dk["cells"])
            cells = [{"x": c["x"], "y": c["y"]} for c in dk["cells"]
                     if lvl[c["y"]][c["x"]] < top_lv]
            if not cells:
                continue
        decks.append({"kind": kind, "level": dk["level"],
                      "thickness": dk.get("thickness", 1), "ground": ground,
                      "cells": cells})

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
