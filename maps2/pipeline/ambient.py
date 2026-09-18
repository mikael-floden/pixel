"""AMBIENT ZONES — every ambient effect belongs to a place, with a share.

Maintainer 2026-09-18: *"the entire ambient-effect system should be tied to
zones you control! This is to make different locations on the map look
different and unique! So ambient effects are no longer turned on/off randomly.
Instead the place a zone and a % how often this effect should be active in
this zone! ... Moreover this is controlled by the backend server and not the
client! ... some effects are meant to be always active like the foam effect or
water effect ... an area surrounding the entire map with 100% active."*

maps2 places the ZONES (this file writes `worlds3/<world>/ambient.json`,
spec `maps2/spec/AMBIENT.md`); the game's server decides, per zone, what is on
and tells every client in it (games agent + games-ambient agent). A zone is a
polygon in the spawns@1 convention — tile-corner vertices, axis-aligned edges,
simple, cells whose CENTRE is inside — plus `effects`, a map of effect name to
a whole-number share 1..100: how often that effect should be active there.
Zones overlap freely; where two zones name the same effect the larger share
wins, and where they name effects that cannot run together (one weather at a
time; birds/bats; fireflies/pollen) the shares are the WEIGHTS of the draw.

THE ZONES ARE READ OFF THE TERRAIN, NEVER DRAWN BY HAND, except the weather
PROVINCES, which are the one thing the ground cannot say (where it rains is a
choice, and it has to differ across the map or the map is one place). Every
region is a closed, hole-free piece: a mask with a hole is split along the
hole's median row into two touching pieces, so no cell is ever uncovered by
the split, and each piece traces to one simple polygon.

    python3 maps2/pipeline/ambient.py --apply maps2/worlds3/the_game   # write
    python3 maps2/pipeline/ambient.py --check maps2/worlds3/the_game   # gate
    python3 maps2/pipeline/ambient.py --page  maps2/worlds3/the_game <out_dir>
"""
from __future__ import annotations

import argparse
import html
import json
import math
import os
import sys

import numpy as np
from scipy import ndimage as ndi

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
sys.path.insert(0, _HERE)
import spawns  # noqa: E402  (comps, fix_diagonals, trace_outer, assert_simple, poly_cells)

SCHEMA = "pixel-maps3/ambient@1"
HOLE_FILL = 500          # a hole this small is filled (an effect self-gates on the ground anyway)
MIN_PIECE = 40           # a region piece smaller than this is noise, not a place
SMOOTH = 2               # closing/opening radius: the coast is a line, not a staircase
BARE_TOL = 0.001         # land cells no region covers, as a fraction (specks the smoothing drops)

# WHAT CANNOT RUN TOGETHER — mirrored from games2/ambient (README "Toggling
# effects independently"); the game's own table is the truth, this copy is
# for the page and the gate.
EXCLUSIVE = (
    ("drizzle", "rain", "heavyrain", "storm", "snow", "windy"),
    ("birds", "bats"),
    ("fireflies", "pollen"),
)

# THE EFFECTS THAT ARE A PROPERTY OF THE WHOLE MAP: each finds its own object
# or surface (a fire, a lamp, a shoreline, a lava pool, a cave) and is nothing
# without it, so the whole world is their zone at 100 — his foam and water.
WORLD_EFFECTS = {"foam": 100, "water": 100, "deepwater": 100, "lava": 100,
                 "drips": 100, "dust": 100, "embers": 100, "smoke": 100,
                 "chimney": 100, "moths": 100, "feathers": 100, "fish": 100}


def roster():
    """Every effect the game registers: one folder per feature under
    games2/ambient, and the weather folder's six rows."""
    d = os.path.join(REPO, "games2", "ambient")
    skip = {"runtime", "scripts", "art-original", "weather"}
    names = {n for n in os.listdir(d) if os.path.isdir(os.path.join(d, n)) and n not in skip}
    return names | {"drizzle", "rain", "heavyrain", "storm", "snow", "windy"}


# -- masks --------------------------------------------------------------------
class World:
    def __init__(self, world_dir):
        self.dir = world_dir
        self.w = json.load(open(os.path.join(world_dir, "world.json")))
        G = self.w["grounds"]
        self.N = len(self.w["ground"])
        g = np.array(self.w["ground"], dtype=np.int16)
        self.lvl = np.array(self.w["level"], dtype=np.int16)
        self.g = np.array(G, dtype=object)[g]
        pf = os.path.join(world_dir, "places.json")
        self.places = json.load(open(pf)).get("places", []) if os.path.isfile(pf) else []

    def is_(self, *names):
        m = np.zeros((self.N, self.N), bool)
        for n in names:
            m |= self.g == n
        return m

    def pieces_mask(self, groups, r):
        m = np.zeros((self.N, self.N), bool)
        for p in self.w["scenery"]:
            if p["piece"].split("/")[0] in groups:
                m[int(p["y"]), int(p["x"])] = True
        return dilate(m, r)

    def tree_density(self, win=9):
        m = np.zeros((self.N, self.N), np.float32)
        for p in self.w["scenery"]:
            if p["piece"].split("/")[0] in ("trees", "ancient_trees", "hanging_willows"):
                m[int(p["y"]), int(p["x"])] += 1
        return ndi.uniform_filter(m, win, mode="constant") * win * win

    def deck_cells(self, kind):
        m = np.zeros((self.N, self.N), bool)
        for d in self.w["decks"]:
            if d["kind"] == kind:
                for c in d["cells"]:
                    m[c["y"], c["x"]] = True
        return m

    def room_cells(self):
        m = np.zeros((self.N, self.N), bool)
        for r in self.w.get("rooms", []):
            for c in r.get("cells", []):
                m[c["y"], c["x"]] = True
        return m


def disk(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= r * r


def dilate(m, r):
    return ndi.binary_dilation(m, disk(r)) if r > 0 else m


def erode(m, r):
    return ndi.binary_erosion(m, disk(r)) if r > 0 else m


def smooth(m, r=SMOOTH):
    """Closing then opening: fills nicks, drops specks, keeps the shape."""
    if r <= 0:
        return m
    m = ndi.binary_closing(m, disk(r))
    return ndi.binary_opening(m, disk(r))


def ellipse(N, cx, cy, rx, ry, deg=0.0):
    y, x = np.mgrid[0:N, 0:N]
    dx, dy = x + 0.5 - cx, y + 0.5 - cy
    a = math.radians(deg)
    u = (dx * math.cos(a) + dy * math.sin(a)) / rx
    v = (-dx * math.sin(a) + dy * math.cos(a)) / ry
    return (u * u + v * v) <= 1.0


def _holes(m):
    return ndi.binary_fill_holes(m) & ~m


def hole_free_pieces(m):
    """Split a mask into pieces with no hole: small holes are filled, a big one
    cuts the mask along the hole's median row into two TOUCHING pieces (no cell
    is lost to the cut), recursively."""
    lab, n = ndi.label(_holes(m))
    if n:
        sizes = ndi.sum(np.ones_like(lab), lab, range(1, n + 1))
        for i, s in enumerate(sizes, 1):
            if s <= HOLE_FILL:
                m = m | (lab == i)
    lab, n = ndi.label(_holes(m))
    if not n:
        return [m]
    sizes = ndi.sum(np.ones_like(lab), lab, range(1, n + 1))
    big = int(np.argmax(sizes)) + 1
    ys = np.nonzero(lab == big)[0]
    row = int(np.median(ys))
    top, bot = m.copy(), m.copy()
    top[row + 1:, :] = False
    bot[:row + 1, :] = False
    return hole_free_pieces(top) + hole_free_pieces(bot)


def polygons(m, min_cells=MIN_PIECE, ctx=""):
    """[(polygon, cells)] for a mask: hole-free pieces, 4-connected components
    of each, diagonal-clean, traced, proved simple."""
    out = []
    for piece in hole_free_pieces(m):
        cells = {(int(x), int(y)) for y, x in zip(*np.nonzero(piece))}
        for comp in spawns.comps(cells):
            if len(comp) < min_cells:
                continue
            comp = spawns.fix_diagonals(comp)
            poly = spawns.trace_outer(comp)
            spawns.assert_simple(poly, f"{ctx}")
            out.append((poly, comp))
    return out


# -- the zones ----------------------------------------------------------------
def build(world_dir):
    W = World(world_dir)
    N = W.N
    lvl = W.lvl
    deep = W.is_("deep_water")
    water = W.is_("water")
    lava = W.is_("lava")
    liquid = deep | water | lava
    land = ~liquid
    sea = smooth(deep, 1)
    coastwater = ndi.label(water | deep)[0]
    # water touching the deep is the sea's shelf; the rest are lakes
    shelf_ids = set(np.unique(coastwater[deep])) - {0}
    shelf = np.isin(coastwater, list(shelf_ids)) & ~deep
    lakes = water & ~shelf & (lvl <= 12)
    tarns = water & ~shelf & (lvl > 12)
    coast = land & dilate(deep | shelf, 3)
    beach = smooth(W.is_("light_beach"), 1)
    marshmud = W.is_("dark_mud") & (lvl <= 6)
    waterline = W.pieces_mask({"reed_beds", "cattail_clumps", "water_lily_clumps"}, 3)
    marsh = smooth(marshmud | (waterline & land), 2) & land
    trees = W.tree_density(9)
    forest = smooth(trees >= 4.0, 2) & land
    houses = W.is_("parquet_floor") | W.room_cells() | W.deck_cells("roof")
    paving = W.is_("brown_paving_stone", "grey_paving_stone")
    # a settlement is its houses and the paving AMONG them - a road is not a town
    town = smooth(dilate(houses, 6) | (paving & dilate(houses, 12)), 3) & land
    lowgrass = W.is_("grass") & (lvl <= 8)
    meadow = smooth(lowgrass & ~forest & ~town, 2) & land
    highgrass = W.is_("grass") & (lvl >= 9)
    pasture = smooth(highgrass, 2) & land
    rock = W.is_("grey_stone", "black_rock", "snow", "ice", "dark_mud", "light_soil") & (lvl >= 14)
    massif = smooth(rock, 3) & land
    summit = smooth(W.is_("snow", "ice") & (lvl >= 30), 2)
    lavafield = dilate(lava, 5)
    slime = dilate(W.is_("slime"), 2) & ~deep
    cave = W.deck_cells("cave")
    # the main landmass and the islets
    lab, n = ndi.label(land)
    sizes = ndi.sum(np.ones_like(lab), lab, range(1, n + 1))
    main = int(np.argmax(sizes)) + 1
    islets = [(lab == i) for i in range(1, n + 1) if i != main and sizes[i - 1] >= 25]

    zones = []

    lab_land, n_land = ndi.label(land)
    sizes_land = ndi.sum(np.ones_like(lab_land), lab_land, range(1, n_land + 1))
    ISLE = int(np.argmax(sizes_land)) + 1
    icy, icx = ndi.center_of_mass(lab_land == ISLE)

    def compass(cells):
        """The direction of a piece from the island's middle, in the GAME's
        compass: north is the corner at low x+y (the iso view), so the axes
        are the diagonals of the cell grid."""
        xs = np.fromiter((c[0] for c in cells), float)
        ys = np.fromiter((c[1] for c in cells), float)
        dx, dy = xs.mean() - icx, ys.mean() - icy
        s_, e_ = dx + dy, dx - dy                  # south-ness, east-ness
        if math.hypot(s_, e_) < 18:
            return "middle"
        a = (math.degrees(math.atan2(e_, -s_)) + 360) % 360   # 0 = north, 90 = east
        return ("northern", "north-eastern", "eastern", "south-eastern", "southern",
                "south-western", "western", "north-western")[int((a + 22.5) // 45) % 8]

    def add(kind, name, mask, effects, elev=None, min_cells=MIN_PIECE, one=False, named=None):
        """`name` holds `{d}` where a compass word goes when the region falls
        in more than one piece ("the {d} marsh": "the marsh" alone, else "the
        northern marsh", "the southern marsh"). `named(cells)` overrides."""
        polys = polygons(mask, min_cells, ctx=name)
        if one:
            polys = polys[:1]
        taken = {z["name"] for z in zones}
        for i, (poly, cells) in enumerate(polys):
            if named:
                nm = named(cells)
            elif len(polys) > 1 and "{d}" in name:
                nm = name.format(d=compass(cells))
            else:
                nm = name.replace("{d} ", "").replace("{d}", "")
            base_nm, k = nm, 2
            while nm in taken:
                nm = f"{base_nm} {k}"; k += 1
            taken.add(nm)
            zid = f"{kind}-{nm.lower().replace(' ', '-').replace(chr(39), '')}"
            z = {"id": zid, "name": nm, "kind": kind,
                 "area": [[int(x), int(y)] for x, y in poly],
                 "cells": len(cells), "effects": dict(effects)}
            if elev:
                z["elev"] = list(elev)
            zones.append(z)
        return polys

    # 0. THE WORLD — the effects that find their own object or surface.
    zones.append({"id": "world", "name": "The whole world", "kind": "world",
                  "area": [[0, 0], [N, 0], [N, N], [0, N]], "cells": N * N,
                  "effects": dict(WORLD_EFFECTS)})

    # 1. THE SEA, in quarters around the island so each quarter is a simple
    #    piece (the island is a hole in the sea; a quarter has none).
    cy, cx = [int(v) for v in ndi.center_of_mass(lab == main)]
    quarters = (("the north sea", (slice(0, cy), slice(0, cx))),
                ("the east sea", (slice(0, cy), slice(cx, N))),
                ("the south sea", (slice(cy, N), slice(cx, N))),
                ("the west sea", (slice(cy, N), slice(0, cx))))
    for nm, (sy, sx) in quarters:
        q = np.zeros_like(sea)
        q[sy, sx] = sea[sy, sx]
        add("sea", nm, q, {"bubbles": 70, "thunder": 45, "birds": 25, "windy": 25,
                           "rain": 15, "storm": 12, "heavyrain": 8, "drizzle": 10},
            min_cells=200, one=True)

    # 2. THE SHORE — every land cell within three of salt water.
    add("shore", "the {d} shore", coast, {"crabs": 100, "birds": 70, "gnats": 20, "drizzle": 10})
    # 3. THE DUNES — the big sands.
    add("dunes", "the {d} dunes", beach & (lvl <= 2), {"sandstorm": 45, "windy": 30, "crabs": 100,
                                                   "ants": 30, "birds": 40}, min_cells=60)
    # 4. LAKES, with their shores; the tarns up on the massif.
    add("lake", "the {d} lake", dilate(lakes, 3) & ~deep, {"dragonflies": 100, "gnats": 60, "fireflies": 70,
                                                       "bats": 30, "birds": 40, "drizzle": 15}, min_cells=30)
    add("tarn", "the {d} tarn", dilate(tarns, 3), {"gnats": 30, "snow": 25, "windy": 30, "thunder": 40,
                                                       "bats": 25}, min_cells=20)
    # 5. THE MARSH — low dark mud and the reed beds.
    add("marsh", "the {d} marsh", marsh, {"dragonflies": 100, "gnats": 85, "fireflies": 90, "spiders": 55,
                                      "bats": 45, "birds": 35, "drizzle": 25, "rain": 12, "heavyrain": 8,
                                      "leaves": 10}, min_cells=150)
    # 6. THE MEADOWS — low grass that is neither wood nor street.
    add("meadow", "the {d} meadow", meadow, {"butterflies": 85, "pollen": 55, "fireflies": 55, "birds": 80,
                                       "ants": 60, "spiders": 25, "gnats": 35, "leaves": 15}, min_cells=150)
    # 7. THE WOODS — where the trees stand thick.
    add("forest", "the {d} woods", forest, {"pollen": 90, "fireflies": 95, "leaves": 70, "bats": 60,
                                        "birds": 45, "spiders": 70, "ants": 40, "gnats": 30,
                                        "butterflies": 25, "drizzle": 15, "rain": 10}, min_cells=80)
    # 8. THE HIGH PASTURE — grass up the terraces.
    add("pasture", "the {d} pasture", pasture, {"butterflies": 45, "pollen": 45, "birds": 60, "ants": 30,
                                                 "leaves": 35, "windy": 20, "snow": 10, "thunder": 30},
        min_cells=100)
    # 9. THE MASSIF and its SUMMIT.
    add("massif", "the {d} massif", massif, {"bats": 65, "thunder": 55, "spiders": 40, "snow": 30, "windy": 30,
                                         "storm": 12, "heavyrain": 6, "leaves": 5}, min_cells=200)
    add("summit", "the {d} summit", summit, {"snow": 70, "windy": 45, "storm": 15, "thunder": 40, "bats": 20},
        min_cells=60)
    # 10. THE LAVA FIELD.
    add("lava", "the lava field", lavafield, {"bats": 35, "thunder": 25, "windy": 10}, min_cells=20)
    # 11. THE CAVES — indoors, on the cave floor's own levels.
    for pl in W.places:
        if pl.get("kind") != "cave":
            continue
        m = np.zeros((N, N), bool)
        for x, y in pl["cells"]:
            m[y, x] = True
        add("cave", pl["name"], m, {"spiders": 90, "bats": 40, "gnats": 15},
            elev=pl.get("elev"), min_cells=10, one=True)
    # 12. THE TOWNS — streets, roofs and gardens.
    def settlement(cells):
        if len(cells) < 500:                       # one cottage, not a street
            return f"the {compass(cells)} cottage"
        return "the town" if np.mean([c[0] for c in cells]) < icx else "the village"
    add("town", "the town", town, named=settlement,
        effects={"birds": 55, "ants": 35, "spiders": 20, "butterflies": 30, "leaves": 25,
                                   "drizzle": 15, "rain": 8}, min_cells=60)
    # 13. THE SLIME POOLS.
    # the slime lies on cave floors under the massif: the zone is UNDERGROUND
    # (its own levels), never the mountain top above it
    sl = W.is_("slime")
    add("slime", "the {d} slime pools", slime, {"gnats": 100, "spiders": 70, "bats": 30, "drizzle": 20},
        elev=(int(lvl[sl].min()), int(lvl[sl].max()) + 1) if sl.any() else None, min_cells=30)
    # 14. THE ISLETS — each its own small world.
    for m in islets:
        g = W.g[m]
        dom = max(set(g.tolist()), key=lambda k: (g == k).sum())
        yy, xx = np.nonzero(m)
        nm, eff = {
            "grey_stone": ("Lighthouse Point", {"crabs": 100, "birds": 80, "windy": 35, "storm": 12,
                                                "thunder": 50, "rain": 15}),
            "grass": ("the standing stones", {"fireflies": 100, "thunder": 60, "moths": 100, "bats": 40,
                                              "drizzle": 20, "birds": 40}),
            "light_beach": ("the shoal", {"crabs": 100, "birds": 70, "bubbles": 80, "windy": 25,
                                          "sandstorm": 20}),
            "dark_mud": ("the fen", {"gnats": 100, "dragonflies": 100, "fireflies": 100, "spiders": 50,
                                     "drizzle": 30, "rain": 15}),
        }.get(dom, (f"an islet of {dom}", {"crabs": 100, "birds": 60, "windy": 20, "rain": 10}))
        add("islet", nm, dilate(m, 2), eff, min_cells=10, one=True)

    # 15. THE WEATHER PROVINCES — hand-placed, the one thing the ground cannot
    #     say. Each is an ellipse over the map; a place under two of them
    #     rains by both their weights.
    for nm, (ex, ey, rx, ry, deg), eff in PROVINCES:
        add("province", nm, ellipse(N, ex, ey, rx, ry, deg), eff, min_cells=100, one=True)

    doc = {"schema": SCHEMA, "world": os.path.basename(os.path.normpath(world_dir)),
           "size": N, "exclusive": [list(e) for e in EXCLUSIVE], "zones": zones}
    return doc


# name, (centre x, centre y, radius x, radius y, angle deg), effects
PROVINCES = (
    ("the wet west", (100, 215, 105, 95, 0),
     {"drizzle": 25, "rain": 18, "heavyrain": 7, "storm": 4, "windy": 8}),
    ("the northern sun", (215, 105, 135, 70, 0),
     {"windy": 15, "drizzle": 10, "rain": 6}),
    ("the eastern shore", (325, 240, 92, 100, 0),
     {"drizzle": 15, "rain": 10, "windy": 14, "storm": 5, "snow": 3}),
    ("the southern rains", (225, 300, 112, 64, 0),
     {"drizzle": 30, "rain": 16, "heavyrain": 10, "storm": 6}),
    ("the mountain weather", (200, 210, 65, 120, -35),
     {"snow": 35, "windy": 25, "storm": 10, "heavyrain": 5, "rain": 5}),
)


# -- the gate -----------------------------------------------------------------
def check(world_dir, doc=None):
    f = os.path.join(world_dir, "ambient.json")
    doc = doc or json.load(open(f))
    W = World(world_dir)
    N = W.N
    names = roster()
    assert doc["schema"] == SCHEMA, doc["schema"]
    ids = set()
    used = set()
    cover = np.zeros((N, N), np.int16)
    weather = np.zeros((N, N), np.int16)
    wz = {"drizzle", "rain", "heavyrain", "storm", "snow", "windy"}
    for z in doc["zones"]:
        assert z["id"] not in ids, f"duplicate zone id {z['id']}"
        ids.add(z["id"])
        poly = [tuple(v) for v in z["area"]]
        spawns.assert_simple(poly, z["id"])
        for k, v in z["effects"].items():
            assert k in names, f"{z['id']}: unknown effect {k!r} (games2/ambient has no such feature)"
            assert isinstance(v, int) and 1 <= v <= 100, f"{z['id']}: share {k}={v!r} is not a whole number 1..100"
            used.add(k)
        if z["kind"] == "world":
            assert poly == [(0, 0), (N, 0), (N, N), (0, N)], "the world zone must cover the whole canvas"
            continue
        cells = spawns.poly_cells(poly, z["id"])
        for x, y in cells:
            if 0 <= x < N and 0 <= y < N:
                cover[y, x] += 1
                if set(z["effects"]) & wz:
                    weather[y, x] += 1
    missing = names - used
    assert not missing, f"effects with no zone at all: {sorted(missing)}"
    land = ~(W.is_("deep_water", "water", "lava"))
    bare = land & (cover == 0)
    # a few specks the smoothing dropped (a lone rock on the shelf) are not a
    # place; more than a thousandth of the land is a region gone missing
    assert bare.sum() <= land.sum() * BARE_TOL, \
        f"{int(bare.sum())} land cells in no zone but the world, first {[(int(x), int(y)) for y, x in zip(*np.nonzero(bare))][:3]}"
    noweather = land & (weather == 0)
    assert noweather.sum() == 0, f"{int(noweather.sum())} land cells under no zone that carries weather, first {[(int(x), int(y)) for y, x in zip(*np.nonzero(noweather))][:3]}"
    for z in doc["zones"]:
        if z["kind"] == "world":
            assert not (set(z["effects"]) & wz), "the world zone carries no weather"
    print(f"{world_dir}: {len(doc['zones'])} zones, {len(used)}/{len(names)} effects placed, "
          f"{int(bare.sum())} land specks in no region, every land cell under weather")
    return doc


# -- the page -----------------------------------------------------------------
def page(world_dir, out):
    """A review page: the minimap with every zone drawn over it (the world's
    own dot formula at the ground's level), a legend, tap a zone to see it."""
    doc = json.load(open(os.path.join(world_dir, "ambient.json")))
    mm = json.load(open(os.path.join(world_dir, "minimap.json")))
    W = World(world_dir)
    d = mm["dot"]
    os.makedirs(out, exist_ok=True)
    import shutil
    shutil.copy(os.path.join(world_dir, mm["image"]), os.path.join(out, "minimap.webp"))

    def proj(x, y):
        cx, cy = min(max(int(x), 0), W.N - 1), min(max(int(y), 0), W.N - 1)
        lv = int(W.lvl[cy, cx])
        return d["kx"] * (x - y) + d["x0"], d["ky"] * (x + y) - d["kz"] * lv + d["y0"]

    HUES = {"world": "#ffffff", "sea": "#4aa3ff", "shore": "#ffe28a", "dunes": "#f4c26b", "lake": "#7fd6ff",
            "tarn": "#b8e8ff", "marsh": "#8fbf5f", "meadow": "#9be36b", "forest": "#2f8f4e", "pasture": "#c6e88a",
            "massif": "#c9c9c9", "summit": "#f4f7ff", "lava": "#ff7a2f", "cave": "#d06cff", "town": "#ff9d5c",
            "slime": "#b6ff3c", "islet": "#ffd1f0", "province": "#ffffff"}
    polys, items = [], []
    for z in doc["zones"]:
        if z["kind"] == "world":
            continue
        pts = " ".join(f"{px:.1f},{py:.1f}" for px, py in (proj(x, y) for x, y in z["area"]))
        dash = ' stroke-dasharray="6 4"' if z["kind"] == "province" else ""
        polys.append(f'<polygon data-id="{z["id"]}" class="z {z["kind"]}" points="{pts}" '
                     f'fill="{HUES.get(z["kind"], "#fff")}" stroke="{HUES.get(z["kind"], "#fff")}"{dash}/>')
        eff = " ".join(f'<span class="chip" data-e="{k}">{k} {v}%</span>'
                       for k, v in sorted(z["effects"].items(), key=lambda kv: -kv[1]))
        elev = f' · levels {z["elev"][0]}–{z["elev"][1]}' if z.get("elev") else ""
        items.append(f'<li data-id="{z["id"]}" style="--kc:{HUES.get(z["kind"], "#fff")}"><b>{html.escape(z["name"])}</b>'
                     f'<span class="k">{z["kind"]}{elev} · {z["cells"]} cells</span><div class="chips">{eff}</div></li>')
    world_eff = " ".join(f'<span class="chip">{k} {v}%</span>' for k, v in WORLD_EFFECTS.items())
    effects = sorted({k for z in doc["zones"] for k in z["effects"]})
    opts = "".join(f'<option value="{e}">{e}</option>' for e in effects)
    w, h = mm["size"]["w"], mm["size"]["h"]
    kinds = "".join(f'<span><i style="background:{c}"></i>{k}</span>' for k, c in HUES.items() if k != "world"
                    and any(z["kind"] == k for z in doc["zones"]))
    doc_html = f"""<title>Ambient Zones</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{{--bg:#eef2f0;--fg:#14201c;--mut:#5f6f69;--card:#ffffff;--line:#d5dcd8;--acc:#b8862b;--acc-ink:#fff8e6;--ink-on-acc:#1f1600}}
@media (prefers-color-scheme: dark){{:root:not([data-theme="light"]){{--bg:#0f1614;--fg:#e6ede9;--mut:#93a39c;--card:#172019;--line:#24302a;--acc:#e0b04f;--acc-ink:#2a2208;--ink-on-acc:#1f1600}}}}
:root[data-theme="dark"]{{--bg:#0f1614;--fg:#e6ede9;--mut:#93a39c;--card:#172019;--line:#24302a;--acc:#e0b04f;--acc-ink:#2a2208;--ink-on-acc:#1f1600}}
body{{background:var(--bg);color:var(--fg);font:15px/1.5 "IBM Plex Sans",system-ui,sans-serif;padding-inline:16px;padding-block:8px 32px;max-width:1240px;margin:0 auto}}
h1{{font:500 30px/1.1 "Fraunces","Iowan Old Style",Georgia,serif;margin:14px 0 6px;text-wrap:balance}}
.sub{{color:var(--mut);margin:0 0 14px;max-width:68ch}}
.map{{position:relative;width:100%;max-width:100%;aspect-ratio:{w}/{h};background:#08111a;border-radius:12px;overflow:hidden;border:1px solid var(--line)}}
.map img,.map svg{{position:absolute;inset:0;width:100%;height:100%}}
.z{{fill-opacity:.24;stroke-width:1.5;cursor:pointer;transition:fill-opacity .15s,stroke-opacity .15s}}
.z.province{{fill-opacity:.05;stroke-width:2}}
.z.dim{{fill-opacity:.02;stroke-opacity:.2}} .z.hot{{fill-opacity:.6;stroke-width:3;stroke:#fff}}
.bar{{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:14px 0 10px}}
select,button{{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 11px;font:inherit}}
button:focus-visible,select:focus-visible,li:focus-visible{{outline:2px solid var(--acc);outline-offset:2px}}
#pick{{font:500 17px "Fraunces",Georgia,serif}}
.note{{color:var(--mut);font-size:13.5px;margin:10px 0 16px;max-width:80ch}}
.kinds{{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--mut);margin:0 0 14px}}
.kinds i{{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}}
ul{{list-style:none;padding:0;margin:0;display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}}
li{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;cursor:pointer;border-left:5px solid var(--kc,var(--line))}}
li.hot{{outline:2px solid var(--acc)}} li.dim{{opacity:.3}}
li b{{font:600 16px "Fraunces",Georgia,serif}}
.k{{color:var(--mut);font:12.5px "IBM Plex Mono",ui-monospace,monospace;display:block;margin-top:2px}}
.chips{{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}}
.chip{{font:12px "IBM Plex Mono",ui-monospace,monospace;background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-variant-numeric:tabular-nums}}
.chip.hot{{background:var(--acc);color:var(--ink-on-acc);border-color:var(--acc)}}
@media (prefers-reduced-motion: reduce){{.z,li{{transition:none}}}}
</style>
<h1>Ambient zones of the_game</h1>
<p class="sub">{len(doc["zones"])} zones read off the terrain, plus five weather provinces drawn by hand. Tap a zone on the map or in the list. A share is how often an effect should be on there; where two zones meet, their shares are weights against each other.</p>
<div class="map"><img src="minimap.webp" alt="the island"><svg viewBox="0 0 {w} {h}" preserveAspectRatio="none" role="img" aria-label="zones over the minimap">{"".join(polys)}</svg></div>
<div class="bar"><label>Show one effect <select id="eff"><option value="">every zone</option>{opts}</select></label><button id="clear" type="button">Clear</button><span id="pick"></span></div>
<div class="kinds">{kinds}</div>
<p class="note">Everywhere, at 100%: {world_eff}. Each of these finds its own fire, lamp, shoreline, pool or cave and is nothing without it, so the whole world is its zone.</p>
<ul id="list">{"".join(items)}</ul>
<script>
(function(){{
  var polys=document.querySelectorAll('polygon.z'), items=document.querySelectorAll('#list li'), pick=document.getElementById('pick'), sel=document.getElementById('eff');
  function hot(id){{
    polys.forEach(function(p){{p.classList.toggle('hot',p.dataset.id===id)}});
    items.forEach(function(l){{l.classList.toggle('hot',l.dataset.id===id); if(l.dataset.id===id) l.scrollIntoView({{block:'nearest'}})}});
    var z=id?document.querySelector('#list li[data-id="'+id+'"] b'):null; pick.textContent=z?z.textContent:'';
  }}
  function filter(e){{
    items.forEach(function(l){{var has=!e||l.querySelector('.chip[data-e="'+e+'"]'); l.classList.toggle('dim',!has);
      l.querySelectorAll('.chip').forEach(function(c){{c.classList.toggle('hot',!!e&&c.dataset.e===e)}});
      var p=document.querySelector('polygon.z[data-id="'+l.dataset.id+'"]'); if(p) p.classList.toggle('dim',!has);}});
  }}
  polys.forEach(function(p){{p.addEventListener('click',function(e){{e.stopPropagation();hot(p.dataset.id)}})}});
  items.forEach(function(l){{l.addEventListener('click',function(){{hot(l.dataset.id)}});l.tabIndex=0;l.addEventListener('keydown',function(e){{if(e.key==='Enter')hot(l.dataset.id)}})}});
  document.getElementById('clear').addEventListener('click',function(){{hot(null);sel.value='';filter('')}});
  sel.addEventListener('change',function(){{filter(sel.value)}});
}})();
</script>
"""
    open(os.path.join(out, "index.html"), "w").write(doc_html)
    return os.path.join(out, "index.html")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("world_dir")
    ap.add_argument("out", nargs="?")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--apply", action="store_true", help="derive and write ambient.json")
    g.add_argument("--check", action="store_true", help="gate the shipped ambient.json")
    g.add_argument("--page", action="store_true", help="render the review page into <out>")
    a = ap.parse_args()
    if a.apply:
        doc = build(a.world_dir)
        f = os.path.join(a.world_dir, "ambient.json")
        json.dump(doc, open(f, "w"), separators=(",", ":"))
        check(a.world_dir, doc)          # after the write: a red gate leaves the file to look at
        for z in doc["zones"]:
            print(f"  {z['id']:32s} {z['cells']:6d} cells  {len(z['area']):4d} vertices  {z['effects']}")
        print(f"wrote {f}")
    elif a.check:
        check(a.world_dir)
    else:
        assert a.out, "--page wants an out dir"
        print(page(a.world_dir, a.out))


if __name__ == "__main__":
    main()
