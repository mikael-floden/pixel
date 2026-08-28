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


def _scenery(doc):
    """Translate v2 prop-tiles into scenery placements, plus the pieces already
    placed as props (the chess tables ARE scenery pieces).

    v2 trees were tiles2 prop-tiles; scenery owns trees now. The mapping is by
    RULE on the prop path: tall grass props (base_x_4/5) -> a tree piece,
    rotating deterministically through the maintainer-approved trees so a wood
    is not one tree stamped; the bonfire A/B fixture -> the campfire piece; the
    chess tables -> their own scenery ids. Placement keeps the prop's cell
    (centre), fractional coords allowed by the format."""
    trees = sorted(d for d in os.listdir(os.path.join(REPO, "scenery", "trees"))
                   if os.path.isdir(os.path.join(REPO, "scenery", "trees", d)))
    ancient = sorted(d for d in os.listdir(os.path.join(REPO, "scenery", "ancient_trees"))
                     if os.path.isdir(os.path.join(REPO, "scenery", "ancient_trees", d)))
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
            else:
                pool = ancient if ("base_x_5" in path) else trees
                grp = "ancient_trees" if pool is ancient else "trees"
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


def build():
    src = json.load(open(os.path.join(MAPS2, "worlds", "the_island2", "world.json")))
    W, H, mat, lvl = _grid(src)
    _deep_water(W, H, mat)
    fen = _fen(W, H, mat, lvl)
    floors, walls = _houses(src, mat)
    yard = _yard(src, mat, lvl)
    scen = _scenery(src)

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
    print(f"the_game: {W}x{H}, {len(grounds)} grounds, {len(scen)} scenery, "
          f"{len(decks)} decks | fen {fen}, floors {floors}, yard {yard}")
    for g, n in c.most_common():
        print(f"   {g:20s} {n}")
    return doc


if __name__ == "__main__":
    build()
