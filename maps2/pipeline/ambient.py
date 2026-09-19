"""AMBIENT ZONES — every ambient effect belongs to a place, and a place has ONE.

Maintainer 2026-09-18: *"the entire ambient-effect system should be tied to
zones you control! This is to make different locations on the map look
different and unique! ... the place a zone and a % how often this effect
should be active in this zone! ... controlled by the backend server."* And
2026-09-19, on the first cut — which gave every place of a kind the same eight
effects at middling shares and laid five weather ellipses over the island:
*"you have no feeling at all and just created lots of areas and randomized
what happened inside them ... The ambient effect should help the player to
remember a place by adding effects the player might have never seen before.
This makes each place special ... the rain that almost always is present at
this location. I SAID ALMOST ALWAYS ... Always leave a small door open to
something weird and it will do more good than bad."*

So a zone carries a SIGNATURE — one effect at 90, the thing the place is
remembered by (the sandstorm dunes, the crab beach, the village where it
rains) — a support or two at 20 or under that colour it and never compete
with it, and DOORS at one half: one window in two hundred, the thing that
should not happen there (snow on the meadow; rain on the summit). There is no
weather province: weather is a place's signature or a door, never a blanket.
Places of one kind take their signatures from the kind's palette in order,
largest place first, and two neighbours of a kind never share one. THE
SURFACE ZONES DO NOT OVERLAP: a cell belongs to the most specific place
standing on it (an islet before the dunes before a lake before the town
before the marsh ... before the shore before the sea), so a point is one
place and one server window. Only the caves and the slime pools, which carry
their own levels, lie under the mountain zones above them.

maps2 places the ZONES (this file writes `worlds3/<world>/ambient.json`,
spec `maps2/spec/AMBIENT.md`); the game's server decides, per zone, what is on
and tells every client in it (games agent + games-ambient agent). A zone is a
polygon in the spawns@1 convention — tile-corner vertices, axis-aligned edges,
simple, cells whose CENTRE is inside — plus `effects`, a map of effect name to
a share: 0.5 is a door, else a whole number 1..100, how often that effect
should be active there.

THE ZONES ARE READ OFF THE TERRAIN, NEVER DRAWN BY HAND. Every region is a
closed, hole-free piece: a mask with a hole is split along the hole's median
row into two touching pieces, so no cell is ever uncovered by the split, and
each piece traces to one simple polygon.

    python3 maps2/pipeline/ambient.py --apply maps2/worlds3/the_game   # write
    python3 maps2/pipeline/ambient.py --check maps2/worlds3/the_game   # gate
    python3 maps2/pipeline/ambient.py --page  maps2/worlds3/the_game <out_dir>
"""
from __future__ import annotations

import argparse
import collections
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

# ONE EFFECT IS THE PLACE (maintainer 2026-09-19, see the head of the file).
SIGNATURE = 90        # the place's own effect: on nine windows in ten - "almost always"
SUPPORT_MAX = 20      # a support colours the signature and never competes with it
DOOR = 0.5            # one window in two hundred: the thing that should not happen here
NEAR = 40             # cells between two places of a kind that makes them neighbours
CAP = 4               # places one effect may sign before the palette skips it for another

# kind -> palette, in the order the kind's places take them, LARGEST PLACE
# FIRST: the biggest dunes are the sandstorm, the widest sea breathes, the
# town has the birds and the village the rain. An entry is (signature,
# supports, needs): `needs` names grounds the place must MOSTLY be, or the
# entry is skipped for it - crabs want sand under them and butterflies grass,
# the effect keeps that gate in the game, and a signature that could never
# draw is not a signature. A support is never in the signature's
# exclusive group (it would eat the signature's windows). Every effect the
# game registers is somebody's signature or support (gate-asserted).
SAND = ("light_beach", "light_soil")
PALETTES = {
    "sea":     [("bubbles", {"birds": 15}, ()), ("storm", {"thunder": 20}, ()),
                ("thunder", {"windy": 15}, ()), ("birds", {"bubbles": 15}, ())],
    "islet":   [("storm", {"thunder": 20, "crabs": 10}, ("grey_stone",)),      # Lighthouse Point
                ("thunder", {"fireflies": 20}, ("grass",)),                    # the standing stones
                ("crabs", {"birds": 15}, SAND),                                # the shoal
                ("fireflies", {"gnats": 15, "dragonflies": 10}, ("dark_mud",)),  # the fen
                ("windy", {"birds": 15}, ()), ("birds", {"gnats": 10}, ())],
    "dunes":   [("sandstorm", {"windy": 15}, SAND), ("windy", {"crabs": 15}, ()),
                ("crabs", {"birds": 15}, SAND), ("ants", {"birds": 10}, ()),
                ("birds", {"ants": 10}, ()), ("gnats", {"crabs": 10}, ())],
    "lake":    [("dragonflies", {"gnats": 15}, ()), ("fireflies", {"dragonflies": 10}, ()),
                ("gnats", {"dragonflies": 10}, ()), ("drizzle", {"dragonflies": 10}, ())],
    "tarn":    [("windy", {"thunder": 15}, ()), ("thunder", {"windy": 15}, ()),
                ("gnats", {"thunder": 10}, ())],
    "lava":    [("thunder", {"windy": 10}, ()), ("windy", {"thunder": 10}, ()),
                ("bats", {"thunder": 10}, ())],
    "summit":  [("snow", {"thunder": 10}, ("snow", "ice")), ("storm", {"thunder": 20}, ()),
                ("snow", {"bats": 10}, ("snow", "ice")), ("windy", {"thunder": 10}, ()),
                ("snow", {"thunder": 15}, ("snow", "ice")), ("thunder", {"bats": 10}, ())],
    "town":    [("snow", {"bats": 10}, ("snow", "ice")),                        # the cottage in the snow
                ("birds", {"leaves": 10, "ants": 10}, ()),                     # the town
                ("rain", {"birds": 10}, ()),                                   # the village where it rains
                ("leaves", {"birds": 10}, ()), ("drizzle", {"birds": 10}, ()),
                ("butterflies", {"birds": 10}, ("grass",)), ("ants", {"birds": 10}, ()),
                ("gnats", {"birds": 10}, ())],
    "marsh":   [("fireflies", {"gnats": 15}, ()), ("gnats", {"dragonflies": 10}, ()),
                ("dragonflies", {"gnats": 10}, ()), ("drizzle", {"gnats": 10}, ()),
                ("spiders", {"gnats": 10}, ()), ("heavyrain", {"thunder": 15}, ()),
                ("thunder", {"drizzle": 15}, ()), ("rain", {"gnats": 10}, ()),
                ("bats", {"gnats": 10}, ()), ("storm", {"thunder": 15}, ()),
                ("windy", {"leaves": 10}, ()), ("leaves", {"gnats": 10}, ())],
    "forest":  [("leaves", {"fireflies": 20, "spiders": 10}, ()), ("pollen", {"leaves": 15}, ()),
                ("fireflies", {"leaves": 15}, ()), ("spiders", {"leaves": 10}, ())],
    "pasture": [("birds", {"leaves": 10}, ()), ("windy", {"leaves": 15}, ()),
                ("leaves", {"birds": 10}, ()), ("pollen", {"butterflies": 15}, ("grass",)),
                ("ants", {"birds": 10}, ())],
    "meadow":  [("butterflies", {"birds": 15}, ("grass",)), ("pollen", {"butterflies": 15}, ()),
                ("leaves", {"birds": 10}, ()), ("birds", {"ants": 10}, ()),
                ("fireflies", {"butterflies": 15}, ()), ("ants", {"birds": 10}, ()),
                ("rain", {"birds": 5}, ()), ("windy", {"leaves": 10}, ()),
                ("gnats", {"birds": 10}, ())],
    "massif":  [("thunder", {"windy": 20}, ()), ("windy", {"thunder": 15}, ()),
                ("bats", {"thunder": 10}, ()), ("spiders", {"windy": 10}, ())],
    "sands":   [("crabs", {"birds": 15}, SAND), ("sandstorm", {"windy": 15}, SAND),
                ("windy", {"birds": 10}, ()), ("ants", {"birds": 10}, ()),
                ("birds", {"gnats": 10}, ()), ("gnats", {"birds": 10}, ()),
                ("drizzle", {"gnats": 10}, ()), ("leaves", {"birds": 10}, ())],
    "moor":    [("windy", {"leaves": 15}, ()), ("thunder", {"windy": 15}, ()),
                ("gnats", {"spiders": 10}, ()), ("drizzle", {"gnats": 10}, ()),
                ("leaves", {"gnats": 10}, ()), ("spiders", {"gnats": 10}, ()),
                ("bats", {"gnats": 10}, ()), ("heavyrain", {"thunder": 15}, ()),
                ("rain", {"gnats": 10}, ()), ("birds", {"gnats": 10}, ())],
    "heath":   [("snow", {"thunder": 10}, ("snow", "ice")), ("windy", {"birds": 10}, ()),
                ("gnats", {"spiders": 10}, ()),
                ("birds", {"gnats": 10}, ()), ("leaves", {"birds": 10}, ()),
                ("drizzle", {"gnats": 10}, ()), ("spiders", {"gnats": 10}, ()),
                ("thunder", {"windy": 15}, ()), ("ants", {"birds": 10}, ()),
                ("bats", {"gnats": 10}, ()), ("rain", {"birds": 5}, ())],
    "shore":   [("crabs", {"birds": 15}, SAND), ("birds", {"gnats": 10}, ()),
                ("windy", {"birds": 10}, ()), ("drizzle", {"gnats": 10}, ()),
                ("gnats", {"birds": 10}, ()), ("storm", {"thunder": 20}, ()),
                ("rain", {"birds": 10}, ()), ("leaves", {"birds": 10}, ())],
    # INDOORS: every zone effect the game registers is outdoor-gated today,
    # so a cave's signature draws only once games-ambient lets bats, spiders
    # or gnats live underground (asked, 2026-09-19); the world's drips and
    # embers are what a cave has until then.
    "cave":    [("bats", {"spiders": 10}, ()), ("spiders", {"gnats": 10}, ()),
                ("gnats", {"spiders": 10}, ())],
    "slime":   [("gnats", {"spiders": 15}, ()), ("spiders", {"gnats": 15}, ()),
                ("bats", {"gnats": 10}, ())],
}
INDOOR = ("cave", "slime")
# The order kinds pick in - the most specific place first, so the dunes get
# the sandstorm before the sands do and the town its birds before a meadow.
KIND_ORDER = ("islet", "dunes", "lake", "tarn", "lava", "summit", "town", "marsh", "forest",
              "pasture", "meadow", "massif", "sands", "moor", "shore", "heath", "sea", "cave", "slime")

# THE DOORS, by kind: what should not happen here, first. A place takes the
# first two it does not already carry (one, indoors, where only the cave's
# own life can appear at all); the fallback fills in when a kind's own list
# is spent.
DOORS = {
    "sea": ("snow", "heavyrain"), "islet": ("snow", "storm"), "dunes": ("snow", "heavyrain"),
    "lake": ("snow", "storm"), "tarn": ("rain", "drizzle"), "lava": ("snow", "rain"),
    "summit": ("rain", "drizzle"), "town": ("snow", "storm"), "marsh": ("snow", "storm"),
    "forest": ("snow", "storm"), "pasture": ("snow", "storm"), "meadow": ("snow", "storm"),
    "massif": ("heavyrain", "drizzle"), "shore": ("snow", "storm"),
    "sands": ("snow", "heavyrain"), "moor": ("snow", "storm"), "heath": ("snow", "storm"),
    "cave": ("gnats", "spiders", "bats"), "slime": ("bats", "spiders", "gnats"),
}
DOOR_FALLBACK = ("snow", "storm", "heavyrain", "rain", "drizzle", "windy", "leaves", "thunder")


def group_of(effect):
    """The exclusive group an effect belongs to, or an empty set."""
    for g in EXCLUSIVE:
        if effect in g:
            return set(g)
    return set()


def doors_for(kind, effects):
    n = 1 if kind in INDOOR else 2
    cands = DOORS[kind] + (() if kind in INDOOR else DOOR_FALLBACK)
    out = []
    for d in cands:
        if d not in effects and d not in out:
            out.append(d)
        if len(out) == n:
            break
    return out


def dress(zones, W):
    """ONE SIGNATURE PER PLACE. Kinds pick in KIND_ORDER and each kind's
    places largest first; a place takes the palette entry that fits its
    ground, is not a neighbour's (any kind, within NEAR), and has been taken
    the fewest times ANYWHERE on the map - so two places side by side never
    share one, and every effect is somebody's before any is somebody's twice.
    Then the supports, then the doors."""
    by_place = collections.OrderedDict()
    for z in zones:
        if z["kind"] != "world":
            by_place.setdefault(z["_place"], []).append(z)
    by_kind = collections.defaultdict(list)
    for place, zs in by_place.items():
        cells = set().union(*(z["_cells"] for z in zs))
        xs = [c[0] for c in cells]
        ys = [c[1] for c in cells]
        grounds = collections.Counter(str(W.g[y, x]) for x, y in cells)
        # nearness is by PIECE (a marsh beside one half of a split massif is
        # its neighbour, whatever the massif's whole box says); the gate
        # measures the same way
        pieces = []
        for z in zs:
            px = [v[0] for v in z["area"]]
            py = [v[1] for v in z["area"]]
            pieces.append(((min(px) + max(px)) / 2, (min(py) + max(py)) / 2))
        by_kind[zs[0]["kind"]].append({
            "zones": zs, "cells": len(cells), "pieces": pieces,
            "dominant": grounds.most_common(1)[0][0]})
    placed = []                                          # (piece centres, kind, signature), the whole map
    for kind in KIND_ORDER:
        places = by_kind.get(kind, [])
        palette = PALETTES[kind]
        places.sort(key=lambda p: -p["cells"])
        for p in places:
            near = {sg for cs, _k, sg in placed
                    if any(math.hypot(a[0] - b[0], a[1] - b[1]) <= NEAR for a in cs for b in p["pieces"])}
            fits = [e for e in palette if not e[2] or p["dominant"] in e[2]]
            assert fits, f"{p['zones'][0]['id']}: no palette entry fits its ground {p['dominant']}"
            in_kind = collections.Counter(sg for _c, k, sg in placed if k == kind)
            everywhere = collections.Counter(sg for _c, _k, sg in placed)
            fresh = [e for e in fits if e[0] not in near] or fits
            # THE KIND ROTATES (its places differ), THE PALETTE ORDER HOLDS
            # (the dunes are the sandstorm before anything else is), and an
            # effect that already signs CAP places yields to the next entry.
            pick = min(fresh, key=lambda e: (in_kind[e[0]], everywhere[e[0]] >= CAP, palette.index(e)))
            sig, sup, _ = pick
            eff = {sig: SIGNATURE}
            for k, v in sup.items():
                assert k not in group_of(sig), f"{kind}: support {k} is in {sig}'s exclusive group"
                eff[k] = v
            for d in doors_for(kind, eff):
                eff[d] = DOOR
            for z in p["zones"]:
                z["effects"] = dict(eff)
            placed.append((p["pieces"], kind, sig))
    for z in zones:
        z.pop("_cells", None)
        z.pop("_place", None)


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
    """[(polygon, cells, place)] for a mask: hole-free pieces, 4-connected
    components of each, diagonal-clean, traced, proved simple. `place` is the
    label of the mask's own 4-connected component the piece was cut from: a
    marsh around a lake is split along the lake into two touching polygons,
    and those are ONE place with one signature, not two neighbours."""
    lab = ndi.label(m)[0]
    out = []
    for piece in hole_free_pieces(m):
        cells = {(int(x), int(y)) for y, x in zip(*np.nonzero(piece))}
        for comp in spawns.comps(cells):
            if len(comp) < min_cells:
                continue
            x0, y0 = next(iter(comp))
            comp = spawns.fix_diagonals(comp)
            poly = spawns.trace_outer(comp)
            spawns.assert_simple(poly, f"{ctx}")
            out.append((poly, comp, int(lab[y0, x0])))
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
    taken = np.zeros((N, N), bool)                 # surface cells that are already some place's

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

    def add(kind, name, mask, elev=None, min_cells=MIN_PIECE, one=False, named=None, cut=True):
        """`name` holds `{d}` where a compass word goes when the region falls
        in more than one piece ("the {d} marsh": "the marsh" alone, else "the
        northern marsh", "the southern marsh"). `named(cells)` overrides.

        A SURFACE PLACE OWNS ITS CELLS (`cut`): what an earlier, more specific
        place took is not offered to this one, and what this one takes is not
        offered to the next - so a cell is one place. A piece too small to be
        a place is not taken, so the next kind may still cover it. A cave or
        the slime pools carry their own levels and lie UNDER the surface, so
        they neither cut nor are cut."""
        polys = polygons(mask & ~taken if cut else mask, min_cells, ctx=name)
        if one:
            polys = polys[:1]
        # ONE PLACE, ONE NAME: the pieces of a component share it (the id gets
        # the suffix); a second component of the kind is another place.
        places = {}
        for poly, cells, place in polys:
            places.setdefault(place, set()).update(cells)
        names_taken = {z["name"] for z in zones}
        pname = {}
        for place, cells in places.items():
            if named:
                nm = named(cells)
            elif len(places) > 1 and "{d}" in name:
                nm = name.format(d=compass(cells))
            else:
                nm = name.replace("{d} ", "").replace("{d}", "")
            base_nm, k = nm, 2
            while nm in names_taken:
                nm = f"{base_nm} {k}"; k += 1
            names_taken.add(nm)
            pname[place] = nm
        ids = {z["id"] for z in zones}
        for poly, cells, place in polys:
            nm = pname[place]
            base_id = f"{kind}-{nm.lower().replace(' ', '-').replace(chr(39), '')}"
            zid, k = base_id, 2
            while zid in ids:
                zid = f"{base_id}-{k}"; k += 1
            ids.add(zid)
            z = {"id": zid, "name": nm, "kind": kind,
                 "area": [[int(x), int(y)] for x, y in poly],
                 "cells": len(cells), "effects": {},
                 "_cells": set(cells), "_place": f"{kind}:{nm}"}
            if elev:
                z["elev"] = list(elev)
            zones.append(z)
            if cut:
                for x, y in cells:
                    taken[y, x] = True
            elif elev:
                # an underground place whose band reaches the surface (the
                # slime pools) owns that surface: nothing else is offered it
                for x, y in cells:
                    if elev[0] <= lvl[y, x] <= elev[1]:
                        taken[y, x] = True
        return polys

    # 0. THE WORLD — the effects that find their own object or surface.
    zones.append({"id": "world", "name": "The whole world", "kind": "world",
                  "area": [[0, 0], [N, 0], [N, N], [0, N]], "cells": N * N,
                  "effects": dict(WORLD_EFFECTS)})

    # THE ORDER BELOW IS THE PRECEDENCE: the most specific place first.
    # 1. THE ISLETS — each its own small world, whole, with its water rim.
    for m in islets:
        g = W.g[m]
        dom = max(set(g.tolist()), key=lambda k: (g == k).sum())
        nm = {"grey_stone": "Lighthouse Point", "grass": "the standing stones",
              "light_beach": "the shoal", "dark_mud": "the fen"}.get(dom, f"an islet of {dom}")
        add("islet", nm, dilate(m, 2), min_cells=10, one=True)
    # 2. THE SLIME POOLS — on cave floors under the massif: UNDERGROUND (their
    #    own levels), never the mountain top above them; where a pool lies
    #    open at the surface, that surface is theirs before any surface kind.
    sl = W.is_("slime")
    add("slime", "the {d} slime pools", slime,
        elev=(int(lvl[sl].min()), int(lvl[sl].max()) + 1) if sl.any() else None, min_cells=30, cut=False)
    # 3. THE DUNES — the big sands.
    add("dunes", "the {d} dunes", beach & (lvl <= 2), min_cells=60)
    # 3. LAKES, with their banks; the tarns up on the massif.
    add("lake", "the {d} lake", dilate(lakes, 3) & ~deep, min_cells=30)
    add("tarn", "the {d} tarn", dilate(tarns, 3), min_cells=20)
    # 4. THE LAVA FIELD.
    add("lava", "the lava field", lavafield, min_cells=20)
    # 5. THE SUMMITS — the high snow, before the mountain around them.
    add("summit", "the {d} summit", summit, min_cells=60)
    # 6. THE TOWNS — streets, roofs and gardens.
    def settlement(cells):
        if len(cells) < 500:                       # one cottage, not a street
            return f"the {compass(cells)} cottage"
        return "the town" if np.mean([c[0] for c in cells]) < icx else "the village"
    add("town", "the town", town, named=settlement, min_cells=60)
    # 7. THE MARSH — low dark mud and the reed beds.
    add("marsh", "the {d} marsh", marsh, min_cells=150)
    # 8. THE WOODS — where the trees stand thick.
    add("forest", "the {d} woods", forest, min_cells=80)
    # 9. THE HIGH PASTURE — grass up the terraces.
    add("pasture", "the {d} pasture", pasture, min_cells=100)
    # 10. THE MEADOWS — low grass that is neither wood nor street.
    add("meadow", "the {d} meadow", meadow, min_cells=150)
    # 11. THE MASSIF — the mountain that is left around its summits and lava.
    add("massif", "the {d} massif", massif, min_cells=200)
    # 12. WHAT THE NAMED KINDS LEAVE: the sands above the dunes' level (the
    #     beach under a cliff), the high mud plateaus, and the rest by its own
    #     ground — without the weather provinces these were nobody's, a sixth
    #     of the land.
    add("sands", "the {d} sands", W.is_(*SAND) & land, min_cells=120)
    add("moor", "the {d} moor", W.is_("dark_mud") & land, min_cells=120)
    # 13. THE SHORE — what is still nobody's within three cells of salt water:
    #     the strand itself, never a meadow's or a marsh's own coast.
    add("shore", "the {d} shore", coast)
    # 14. THE HEATH — every other piece of land, named by what it is made of.
    def heathname(cells):
        dom = collections.Counter(str(W.g[y, x]) for x, y in cells).most_common(1)[0][0]
        what = {"grey_stone": "rocks", "black_rock": "black rocks", "snow": "snowfield", "ice": "ice",
                "grass": "green", "slime": "slime", "light_soil": "sands", "light_beach": "sands",
                "dark_mud": "moor"}.get(dom, dom.replace("_", " "))
        return f"the {compass(cells)} {what}"
    add("heath", "the heath", land & ~W.is_("grey_paving_stone", "brown_paving_stone", "parquet_floor"),
        named=heathname, min_cells=120)
    # 15. THE SEA, in quarters around the island so each quarter is a simple
    #     piece (the island is a hole in the sea; a quarter has none).
    cy, cx = [int(v) for v in ndi.center_of_mass(lab == main)]
    quarters = (("the north sea", (slice(0, cy), slice(0, cx))),
                ("the east sea", (slice(0, cy), slice(cx, N))),
                ("the south sea", (slice(cy, N), slice(cx, N))),
                ("the west sea", (slice(cy, N), slice(0, cx))))
    for nm, (sy, sx) in quarters:
        q = np.zeros_like(sea)
        q[sy, sx] = sea[sy, sx]
        add("sea", nm, q, min_cells=200, one=True, cut=False)
    # 16. THE CAVES — indoors, on the cave floor's own levels, under the surface.
    for pl in W.places:
        if pl.get("kind") != "cave":
            continue
        m = np.zeros((N, N), bool)
        for x, y in pl["cells"]:
            m[y, x] = True
        add("cave", pl["name"], m, elev=pl.get("elev"), min_cells=10, one=True, cut=False)

    # THE LEFTOVERS JOIN THE PLACE BESIDE THEM: a scrap too small to be a place
    # of its own (under MIN_PIECE, or a sliver the smoothing dropped) goes to
    # the surface zone it touches along most of its rim, and that zone is
    # traced again. A scrap touching nothing (a rock on the shelf) stays out,
    # inside BARE_TOL.
    surface = [z for z in zones if z["kind"] != "world" and not z.get("elev")]
    owner = np.full((N, N), -1, np.int32)
    for i, z in enumerate(surface):
        for x, y in z["_cells"]:
            owner[y, x] = i
    rest = land & ~taken
    lab, n = ndi.label(rest)
    grew = set()
    for i in range(1, n + 1):
        comp = lab == i
        ring = dilate(comp, 1) & ~comp & (owner >= 0)
        if not ring.any():
            continue
        best = int(collections.Counter(owner[ring].tolist()).most_common(1)[0][0])
        surface[best]["_cells"].update((int(x), int(y)) for y, x in zip(*np.nonzero(comp)))
        taken |= comp
        grew.add(best)
    for i in sorted(grew):
        z = surface[i]
        m = np.zeros((N, N), bool)
        for x, y in z["_cells"]:
            m[y, x] = True
        polys = polygons(m, 1, ctx=z["id"])
        polys.sort(key=lambda t: -len(t[1]))
        poly, cells, _ = polys[0]
        z["area"] = [[int(x), int(y)] for x, y in poly]
        z["cells"] = len(cells)
        ids = {q["id"] for q in zones}
        for poly, cells, _ in polys[1:]:           # the hole split, again
            zid, k = z["id"], 2
            while zid in ids:
                zid = f"{z['id']}-{k}"; k += 1
            ids.add(zid)
            zones.append({"id": zid, "name": z["name"], "kind": z["kind"],
                          "area": [[int(x), int(y)] for x, y in poly], "cells": len(cells),
                          "effects": {}, "_cells": set(cells), "_place": z["_place"]})

    dress(zones, W)

    doc = {"schema": SCHEMA, "world": os.path.basename(os.path.normpath(world_dir)),
           "size": N, "exclusive": [list(e) for e in EXCLUSIVE], "zones": zones}
    return doc


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
    cover = np.zeros((N, N), np.int16)           # every zone holding the cell at its own level
    surface = np.zeros((N, N), np.int16)         # ...of which the surface ones (a cave lies under the mountain)
    wz = {"drizzle", "rain", "heavyrain", "storm", "snow", "windy"}
    sigs = {}                                     # zone id -> its signature
    centres = {}
    for z in doc["zones"]:
        assert z["id"] not in ids, f"duplicate zone id {z['id']}"
        ids.add(z["id"])
        assert z["kind"] != "province", f"{z['id']}: weather is a place's signature or a door, never a blanket"
        poly = [tuple(v) for v in z["area"]]
        spawns.assert_simple(poly, z["id"])
        for k, v in z["effects"].items():
            assert k in names, f"{z['id']}: unknown effect {k!r} (games2/ambient has no such feature)"
            assert v == DOOR or (isinstance(v, int) and 1 <= v <= 100), \
                f"{z['id']}: share {k}={v!r} is neither a door ({DOOR}) nor a whole number 1..100"
            used.add(k)
        if z["kind"] == "world":
            assert poly == [(0, 0), (N, 0), (N, N), (0, N)], "the world zone must cover the whole canvas"
            assert not (set(z["effects"]) & wz), "the world zone carries no weather"
            continue
        # ONE SIGNATURE, SUPPORTS THAT NEVER COMPETE, A DOOR
        eff = z["effects"]
        sig = [k for k, v in eff.items() if v >= 85]
        assert len(sig) == 1, f"{z['id']}: a place has exactly one signature (>= 85), found {sig}"
        for k, v in eff.items():
            if k == sig[0] or v == DOOR:
                continue
            assert v <= SUPPORT_MAX, f"{z['id']}: support {k}={v} competes with the signature (> {SUPPORT_MAX})"
            assert k not in group_of(sig[0]), f"{z['id']}: support {k} is in {sig[0]}'s exclusive group"
        assert any(v == DOOR for v in eff.values()), f"{z['id']}: no door left open"
        sigs[z["id"]] = sig[0]
        xs = [v[0] for v in poly]; ys = [v[1] for v in poly]
        centres[z["id"]] = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
        cells = spawns.poly_cells(poly, z["id"])
        band = z.get("elev")
        for x, y in cells:
            if 0 <= x < N and 0 <= y < N and (not band or band[0] <= W.lvl[y, x] <= band[1]):
                cover[y, x] += 1
                if z["kind"] != "cave":
                    surface[y, x] += 1
    missing = names - used
    assert not missing, f"effects with no zone at all: {sorted(missing)}"
    land = ~(W.is_("deep_water", "water", "lava"))
    bare = land & (cover == 0)
    # a few specks the smoothing dropped (a lone rock on the shelf) are not a
    # place; more than a thousandth of the land is a region gone missing
    assert bare.sum() <= land.sum() * BARE_TOL, \
        f"{int(bare.sum())} land cells in no zone but the world, first {[(int(x), int(y)) for y, x in zip(*np.nonzero(bare))][:3]}"
    # A CELL IS ONE PLACE: surface zones do not overlap (a trace can add a
    # corner cell to a neighbour's, so a sliver is tolerated, never a band).
    double = land & (surface >= 2)
    assert double.sum() <= land.sum() * 0.005, \
        f"{int(double.sum())} land cells under two surface zones, first {[(int(x), int(y)) for y, x in zip(*np.nonzero(double))][:3]}"
    # TWO NEIGHBOURING PLACES NEVER SHARE A SIGNATURE (the pieces of one place
    # do - same name - and the indoor kinds have three effects to choose from).
    surf = [z for z in doc["zones"] if z["kind"] not in ("world",) + INDOOR]
    for i, a in enumerate(surf):
        for b in surf[i + 1:]:
            if a["name"] == b["name"] and a["kind"] == b["kind"]:
                continue
            ca, cb = centres[a["id"]], centres[b["id"]]
            if math.hypot(ca[0] - cb[0], ca[1] - cb[1]) <= NEAR:
                assert sigs[a["id"]] != sigs[b["id"]], \
                    f"{a['id']} and {b['id']} are neighbours and both {sigs[a['id']]}"
    print(f"{world_dir}: {len(doc['zones'])} zones, {len(used)}/{len(names)} effects placed, "
          f"{int(bare.sum())} land specks in no region, {int(double.sum())} cells under two places, "
          f"{len(set(sigs.values()))} distinct signatures")
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
            "slime": "#b6ff3c", "islet": "#ffd1f0", "sands": "#f6d9a0", "moor": "#a58b5a",
            "heath": "#b9b39a"}
    # ONE CARD PER PLACE: the pieces of a place split along a hole share its
    # name and its signature, so they share the card, and tapping either
    # lights both.
    polys, items = [], []
    places = collections.OrderedDict()
    for z in doc["zones"]:
        if z["kind"] == "world":
            continue
        key = f"{z['kind']}:{z['name']}"
        places.setdefault(key, []).append(z)
        hue = HUES.get(z["kind"], "#fff")
        pts = " ".join(f"{px:.1f},{py:.1f}" for px, py in (proj(x, y) for x, y in z["area"]))
        polys.append(f'<polygon data-place="{html.escape(key)}" class="z {z["kind"]}" points="{pts}" '
                     f'fill="{hue}" stroke="{hue}"/>')
    for key, zs in places.items():
        z = zs[0]
        eff = " ".join(
            f'<span class="chip sig" data-e="{k}">{k} {v}%</span>' if v >= 85 else
            f'<span class="chip door" data-e="{k}">{k} 1 in 200</span>' if v == DOOR else
            f'<span class="chip" data-e="{k}">{k} {v}%</span>'
            for k, v in sorted(z["effects"].items(), key=lambda kv: -kv[1]))
        elev = f' · levels {z["elev"][0]}–{z["elev"][1]}' if z.get("elev") else ""
        pieces = f" · {len(zs)} pieces" if len(zs) > 1 else ""
        items.append(f'<li data-place="{html.escape(key)}" style="--kc:{HUES.get(z["kind"], "#fff")}"><b>{html.escape(z["name"])}</b>'
                     f'<span class="k">{z["kind"]}{elev} · {sum(q["cells"] for q in zs)} cells{pieces}</span><div class="chips">{eff}</div></li>')
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
.chip.sig{{border-color:var(--acc);font-weight:600}} .chip.door{{border-style:dashed;opacity:.7}}
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
<p class="sub">{len(places)} places read off the terrain, none overlapping on the surface. Each has ONE signature — the effect it is remembered by, on nine windows in ten — a support or two that never compete with it, and a door or two at one in two hundred for the thing that should not happen there. Tap a place on the map or in the list.</p>
<div class="map"><img src="minimap.webp" alt="the island"><svg viewBox="0 0 {w} {h}" preserveAspectRatio="none" role="img" aria-label="zones over the minimap">{"".join(polys)}</svg></div>
<div class="bar"><label>Show one effect <select id="eff"><option value="">every zone</option>{opts}</select></label><button id="clear" type="button">Clear</button><span id="pick"></span></div>
<div class="kinds">{kinds}</div>
<p class="note">Everywhere, at 100%: {world_eff}. Each of these finds its own fire, lamp, shoreline, pool or cave and is nothing without it, so the whole world is its zone.</p>
<ul id="list">{"".join(items)}</ul>
<script>
(function(){{
  var polys=document.querySelectorAll('polygon.z'), items=document.querySelectorAll('#list li'), pick=document.getElementById('pick'), sel=document.getElementById('eff');
  function hot(id){{
    polys.forEach(function(p){{p.classList.toggle('hot',p.dataset.place===id)}});
    items.forEach(function(l){{l.classList.toggle('hot',l.dataset.place===id); if(l.dataset.place===id) l.scrollIntoView({{block:'nearest'}})}});
    var z=id?document.querySelector('#list li.hot b'):null; pick.textContent=z?z.textContent:'';
  }}
  function filter(e){{
    items.forEach(function(l){{var has=!e||l.querySelector('.chip[data-e="'+e+'"]'); l.classList.toggle('dim',!has);
      l.querySelectorAll('.chip').forEach(function(c){{c.classList.toggle('hot',!!e&&c.dataset.e===e)}});
      polys.forEach(function(p){{if(p.dataset.place===l.dataset.place) p.classList.toggle('dim',!has)}});}});
  }}
  polys.forEach(function(p){{p.addEventListener('click',function(e){{e.stopPropagation();hot(p.dataset.place)}})}});
  items.forEach(function(l){{l.addEventListener('click',function(){{hot(l.dataset.place)}});l.tabIndex=0;l.addEventListener('keydown',function(e){{if(e.key==='Enter')hot(l.dataset.place)}})}});
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
