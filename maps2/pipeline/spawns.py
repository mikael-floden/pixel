"""Monster SPAWN ZONES (maintainer 2026-07-29) — `pixel-maps2/spawns@1`.

maps2 owns the REAL monster spawn areas (the game's rectangles near the player
spawn are explicitly "fake debug areas for now — later the maps agent owns real
spawn areas", games2/shared/src/monsters.ts). Every world ships a sidecar
`worlds/<name>/spawns.json` next to world.json:

    {
      "schema": "pixel-maps2/spawns@1",
      "world": "the_island2",
      "zones": [
        {"id": "poring-1", "monster": "poring",
         "area": [[x,y], ...],        # SIMPLE polygon: tile-corner vertices,
                                       # implicit close, axis-aligned edges,
                                       # concave welcome, NEVER self-intersecting
         "elev": [0, 1],               # the INTENDED walk surface: a monster may
                                       # stand at a cell on whichever surface
                                       # (base OR deck) has level in this range —
                                       # this is what disambiguates the cave
                                       # floor [0,1] from the mountain roof
                                       # [24,40] over the very same cells, and a
                                       # bridge deck from the water under it
         "num": 4}                     # monsters living in this zone (scaled by
                                       # area so big zones keep the same density)
      ]
    }

A zone's cells are the cells whose CENTER lies inside the polygon. The area is
where the monster MAY be — the game must still validate each actual spawn/roam
point (standable surface in the elev range, no prop), so a polygon is free to
span the odd boulder. The same monster appears in many zones, and zones may
OVERLAP each other freely (different monsters share ground). The ONE thing a
polygon may never span is WATER — see the water law below.

Zones are DERIVED from world.json by habitat rules (the standing doctrine: rules,
never spot edits) — rerunning this script is idempotent and deterministic:

    python maps2/pipeline/spawns.py                  # every world
    python maps2/pipeline/spawns.py the_island2 ...  # only the named ones

The roster (monsters/config/roster.json) is the monster-id authority and GROWS
on its own (the PixelLab MONSTER tag decides membership): every id maps to a
habitat via MONSTER_HABITAT, with NAME_HINTS guessing a home for ids the table
doesn't know yet — extend the table when a guess is wrong. Rerun this script
after the roster changes AND after regenerating any world.

`monster_demo` writes its own explicit pads (monsterdemo.py) and is skipped here.
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
WORLDS = os.path.join(MAPS2, "worlds")

SCHEMA = "pixel-maps2/spawns@1"
BUILDER_OWNS = {"monster_demo"}     # writes its own explicit spawns.json

# Test/feature-demo maps used to exercise ONE rendering feature — they get NO
# monsters (maintainer 2026-07-29: "used for testing different things"): the
# props showcase, the transition auto-tiler demo, the emission/glow showcase,
# and the deck occlusion test. They ship an empty `zones: []` so the intent is
# explicit, not a missing file. (monster_demo is the deliberate exception — it
# IS the monster showcase and owns its own file.)
NO_SPAWN_WORLDS = {"prop_demo", "trans_demo", "glow_test", "occlusion_test",
                   "house_demo"}

# Worlds that MUST always contain EVERY roster monster (maintainer 2026-07-29:
# "The Island 2 should always contain all monsters — this is the map closest to
# the end game"). Generation guarantees a zone for every monster here (falling
# back off the habitat threshold, then to a neighbouring habitat, if need be)
# and the build ASSERTS full coverage — so a future terrain change that erases
# a monster's habitat fails loudly instead of silently dropping the creature.
MUST_HAVE_ALL = {"the_island2"}
# Fallback habitat order when a monster's own habitat has no home on a
# must-have world (land grounds first, then the wetter/edge ones).
FALLBACK_HABS = ("grass", "dirt", "stone", "dark", "snow", "forest",
                 "ice", "sand", "shore", "cave")

# -- THE WATER LAW (maintainer 2026-08-05) ------------------------------------
# "You need to fix so no monster can spawn on water. Monsters can't swim. We're
# gonna soon make water into a SAFE ZONE."
#
# So water is not a habitat, not a spawn cell, and not even something a zone is
# allowed to CONTAIN. The guarantee is made in the GEOMETRY rather than left to
# the game: no zone polygon on any world encloses a single water-surfaced cell.
# That last part is the load-bearing one — the game picks roam/spawn cells from
# the polygon and flips an ENTIRE zone to swimming when swim cells outnumber
# standable ones (`buildZoneRuntimes`, games2/shared/src/index.ts). With zero
# water inside any polygon that branch can never fire again, whatever the game
# does later, and a water safe-zone can never be violated from the map side.
#
# A cell is WATER-SURFACED for a zone of elevation band [lo,hi] when its base
# material is water AND no deck inside that band covers it. So the bridge guard
# stays legal (it stands ON the span, elev [lvl,lvl]) while the water UNDER a
# bridge does not (a ground-level band there would put the monster in the drink
# beneath it). Enforced by dry_mask() at construction and re-asserted for every
# zone of every world — including builder-owned ones — by validate_zone().

# -- habitat doctrine ---------------------------------------------------------
# monsters/config/roster.json is the id authority (the PixelLab MONSTER tag
# decides membership, so the roster GROWS on its own). Every monster maps to
# ONE habitat key; several monsters share a habitat, and each still gets its
# own zone(s) — overlapping areas are the design. Habitat keys:
#   grass   open saturated_grass
#   forest  grass within TREE_R of a tall grove prop (base_x_4/5 grass)
#   dirt    lightdark_dirt (forest floor / the road network)
#   snow    regular_snow slopes
#   ice     crystal_ice (tarns, frozen caps)
#   dark    black_mountain rock
#   stone   stone_mountain benches and walls
#   sand    beaches
#   shore   LAND within WATER_SHORE_R of water — the bank, never the water
#           itself (the water law): where the amphibious-looking monsters live
#   cave    THE CAVE floor (cells under kind:"cave" decks, elev [0,1])
# plus one showcase zone on the biggest BRIDGE deck.
MONSTER_HABITAT = {
    "mystical_frog": "shore",
    "hedgehog": "forest",
    "white_rabbit": "snow",
    "malformed_creature": "dark",
    "masked_shadow_creature": "cave",
    "night_beast": "cave",
    "lava_salamander": "dark",
    "lava_salamander_2": "dark",
    "butterfly_dragon": "grass",
    "ice_crystal_golem": "ice",
    "water_poring": "shore",
    "stone_turtle": "stone",
    "tree_stump": "forest",
    "snow_demon": "snow",
    "forest_poring": "forest",
    "forest_poring_2": "forest",
    "stone_golem": "stone",
    "lava_poring": "dark",
    "diablo": "cave",
    "diablo_2": "cave",
    "ice_poring": "ice",
    "dark_donkey": "dirt",
    "saber_toothed_tiger": "grass",
    "mammoth": "snow",
}
# a NEW roster id without a table entry still gets a sensible home
# NOTE the water law: a new `*_water` / `*_frog` id lands on the BANK (shore),
# never in the water — there is no habitat that puts a monster on water.
NAME_HINTS = (("lava", "dark"), ("shadow", "cave"), ("diablo", "cave"),
              ("night", "cave"), ("ice", "ice"), ("snow", "snow"),
              ("water", "shore"), ("frog", "shore"), ("fish", "shore"),
              ("sand", "sand"), ("stone", "stone"), ("rock", "stone"),
              ("forest", "forest"), ("tree", "forest"), ("dark", "dark"))
BRIDGE_GUARD = "stone_turtle"       # the troll under^W on the bridge

# -- population doctrine (maintainer 2026-07-29) -------------------------------
# Every monster TYPE gets a near-equal share of the world's population — "not a
# rule that they have to be the same, just similar". Pure per-area density made
# the roster wildly lopsided (24 butterfly dragons on the plains vs 1 hedgehog
# in a copse), so the budget is now allocated per MONSTER, not per zone:
#   1. the world's budget B = land cells / WORLD_CELLS_PER_MONSTER, clamped so
#      no type is rarer than MON_TOTAL_MIN or commoner than MON_TOTAL_MAX
#      (the_island2: 21978 land cells -> B = 160, the maintainer's target);
#   2. B is split EVENLY across the types that live here (largest-remainder —
#      so with 24 types and B=160, sixteen get 7 and eight get 6); the +1s go
#      to the types with the most habitat, the only nod left to raw area;
#   3. each type's own total is then spread across ITS zones in proportion to
#      zone area (min 1 per zone) — so density still decides WHERE a type is
#      thickest, never HOW MANY of it exist.
# -- THE DIFFICULTY GRADIENT (maintainer 2026-08-06) --------------------------
# "Why do you spawn Duskfang next to newcomers? They are aggressive and will
# kill them immediately. What's wrong with Mirewart? Why not scale up the
# difficulty as you progress? Quillkin should also be closer. You just want
# Newbies to have a hard time. Try to make them enjoy the game instead."
#
# Habitat alone decided placement before this, and habitat knows nothing about
# danger: Duskfang is a sabre-toothed tiger, tigers live on grass, the arrival
# point is grass — so a level-8 hunter with a 96wu aggro radius that kills a
# fresh 40hp player in three hits had a zone touching the spawn, while Mirewart
# (level 1) sat 54 cells away and Quillkin (level 4) was the single most distant
# monster on the map at 152. The correlation between level and distance was nil.
#
# So distance from the arrival point is now a FUNCTION OF DIFFICULTY, measured
# by WALK distance (what the player actually travels) and not by straight line,
# which on a map with a mountain, a gorge and an ocean are very different things.
#
# The ranking is not invented here: `level` and `aggro_radius_wu` come from the
# game's own combat tuning (live/tuning/monsters.json), so a rebalance there
# moves the monsters on the map instead of silently disagreeing with it.
TUNING = os.path.join(REPO, "live", "tuning", "monsters.json")
SAFE_R = 6              # nothing at all inside this walk radius — you land, you
                        # get a moment before anything can reach you
LVL_STEP = 5            # ...then every level of difficulty pushes 5 cells further.
                        # Calibrated against the terrain, not picked: THE CAVE is
                        # a single component 112 walk-cells out and holds all four
                        # cave dwellers, the worst of them Balefiend (L18,
                        # aggressive). 6 + 17*5 + 14 = 105 <= 112, so every
                        # monster on the_island2 can satisfy its own floor and
                        # none has to fall back.
AGGRO_PUSH = 14         # monsters that HUNT (aggro_radius_wu > 0) start further
                        # out again: a passive monster is a thing you choose to
                        # fight, an aggressive one is a thing that chooses you
MAX_LVL = 20

WORLD_CELLS_PER_MONSTER = 137       # world budget = land cells / this
MON_TOTAL_MIN = 3                   # per-type floor on a world it lives on
MON_TOTAL_MAX = 9                   # per-type ceiling
MIN_ZONE = {"forest": 12}           # smallest component worth a zone (cells)
MIN_ZONE_DEFAULT = 30
TOP_K = 4                           # component cap per habitat (>= its members)
TREE_R = 3
WATER_SHORE_R = 4                   # how far inland the `shore` band reaches
BRIDGE_MIN_CELLS = 10
DRY_PASSES = 60                     # water-law fixed-point backstop (asserts)
ELEV_PASSES = 8                     # elev/dry-mask fixed-point backstop


def roster_ids():
    j = json.load(open(os.path.join(REPO, "monsters", "config", "roster.json")))
    return [m["id"] for m in j["monsters"]]


_tuning = None


def tuning():
    """The GAME's combat tuning — the authority on how dangerous a monster is.

    Not a ranking invented in maps2: `level`, `damage` and `aggro_radius_wu` are
    what the server fights with (games2/server/src/tuning.ts reads this exact
    file), so rebalancing combat moves the monsters on the map to match instead
    of quietly disagreeing with it."""
    global _tuning
    if _tuning is None:
        try:
            _tuning = json.load(open(TUNING))
        except Exception:
            _tuning = {"defaults": {}, "monsters": {}}
    return _tuning


def threat(mid):
    """(level, aggro_radius) for a monster, defaults applied."""
    t = tuning()
    d = t.get("defaults") or {}
    m = (t.get("monsters") or {}).get(mid) or {}
    lvl = m.get("level", d.get("level", 1))
    ag = m.get("aggro_radius_wu", d.get("aggro_radius_wu", 0))
    return int(lvl), float(ag)


def keep_out(mid):
    """How far from the arrival point this monster must stay, in walk cells."""
    lvl, ag = threat(mid)
    lvl = max(1, min(MAX_LVL, lvl))
    return SAFE_R + (lvl - 1) * LVL_STEP + (AGGRO_PUSH if ag > 0 else 0)


def walk_dist(w):
    """Walk distance in cells from the arrival point to every standable surface.

    The player's own movement rule (games2: 4-neighbour, climb at most 1 level,
    drops free, a deck top is its own surface and a slab seals the base beneath
    it unless you are already under there). Straight-line distance would call
    the far side of the gorge 'near'."""
    def surfaces(x, y):
        out = []
        if (0 <= x < w.w and 0 <= y < w.h and w.m(x, y) != ""
                and w.m(x, y) not in w.water and (x, y) not in w.props):
            d = w.deck.get((x, y))
            th = w.deck_thick.get((x, y), 1)
            if d is None or d <= w.base(x, y) or w.base(x, y) < d - th:
                out.append((w.base(x, y), "base"))
        d = w.deck.get((x, y))
        if d is not None and d > w.base(x, y) and (x, y) not in w.props:
            out.append((d, "deck"))
        return out

    sx, sy = w.spawn
    start = [(sx, sy, lv, la) for lv, la in surfaces(sx, sy)]
    dist, q = {}, deque()
    for (x, y, lv, la) in start:
        dist[(x, y, la)] = 0
        q.append((x, y, lv, la))
    while q:
        x, y, lv, la = q.popleft()
        d0 = dist[(x, y, la)]
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            for nlv, nla in surfaces(nx, ny):
                if nlv > lv + 1:
                    continue
                if (nx, ny, nla) in dist:
                    continue
                dist[(nx, ny, nla)] = d0 + 1
                q.append((nx, ny, nlv, nla))
    flat = {}
    for (x, y, _la), d in dist.items():
        if d < flat.get((x, y), 1 << 30):
            flat[(x, y)] = d
    return flat


def comp_dist(comp, field):
    """How far a player must walk to reach the NEAREST cell of this habitat."""
    ds = [field[c] for c in comp if c in field]
    return min(ds) if ds else None


_near_cache = {}


def near_cells(field, floor):
    """Cells within `floor` walk-cells of the arrival point — forbidden ground."""
    key = (id(field), floor)
    hit = _near_cache.get(key)
    if hit is None:
        hit = frozenset(c for c, d in field.items() if d < floor)
        _near_cache[key] = hit
    return hit


def gradient_trim(comp, field, floor):
    """Cut the part of a habitat that is too close to the arrival point.

    Choosing a far-enough COMPONENT is not enough on its own: a habitat is often
    one connected sprawl covering half the map, so its nearest cell is next to
    the spawn while most of it is nowhere near — on demo_isle the single grass
    component reaches within 1 cell of the arrival point. Trimming by CELL and
    keeping the largest surviving piece gives a zone that genuinely begins at
    the monster's keep-out distance, whatever shape the habitat is."""
    far = {c for c in comp if field.get(c, 1 << 30) >= floor}
    if not far:
        return set()
    parts = comps(far)
    return parts[0] if parts else set()


def habitat_of(mid):
    h = MONSTER_HABITAT.get(mid)
    if h is None:
        for pat, key in NAME_HINTS:
            if pat in mid:
                return key
        return "grass"
    return h


# -- world loading ------------------------------------------------------------

class W:
    def __init__(self, name):
        doc = json.load(open(os.path.join(WORLDS, name, "world.json")))
        self.name = name
        size = doc["size"]
        self.w, self.h = int(size["w"]), int(size["h"])
        mats = doc["materials"]
        self.mat = [[mats[i] for i in row] for row in doc["mat"]]
        self.level = doc["level"]
        self.water = set(doc.get("water", ["clear_water"]))
        self.spawn = (int(doc["spawn"][0]), int(doc["spawn"][1]))
        self.props = {(p["x"], p["y"]) for p in doc.get("props", [])}
        self.paths = doc["paths"]
        self.tall_props = set()
        for p in doc.get("props", []):
            path = self.paths[p["tile"]]
            if "saturated_grass" in path and ("base_x_4" in path or "base_x_5" in path):
                self.tall_props.add((p["x"], p["y"]))
        # walk surface per cell = the deck level where one covers, else base;
        # cave floors keep their own base level as a SECOND surface (deck_kind)
        self.deck = {}
        self.deck_thick = {}
        self.deck_kind = {}
        self.cave_floor = set()
        self.bridges = []
        for dk in doc.get("decks", []):
            cells = [(c["x"], c["y"]) for c in dk["cells"]]
            for c in cells:
                if int(dk["level"]) > self.deck.get(c, -1):
                    self.deck[c] = int(dk["level"])
                    self.deck_thick[c] = int(dk.get("thickness", 1))
                    self.deck_kind[c] = dk.get("kind", "deck")
            if dk.get("kind") == "cave":
                self.cave_floor.update(cells)
            if dk.get("kind") == "bridge":
                self.bridges.append((int(dk["level"]), sorted(cells)))

    def m(self, x, y):
        return self.mat[y][x]

    def base(self, x, y):
        return int(self.level[y][x])

    def surf(self, x, y):
        d = self.deck.get((x, y), -1)
        return d if d > self.base(x, y) else self.base(x, y)

    def hab_level(self, x, y):
        """The level a MAT-based habitat means at this cell: cave roofs CARRY the
        old surface (the kept mat belongs to the roof), while a bridge floats
        OVER its ground (the mat belongs to the base beneath)."""
        if self.deck_kind.get((x, y)) == "cave":
            return self.surf(x, y)
        return self.base(x, y)


# -- mask -> simple polygon ---------------------------------------------------

def comps(cells):
    """4-connected components, biggest first (deterministic)."""
    left = set(cells)
    out = []
    while left:
        seed = min(left)
        q, comp = deque([seed]), {seed}
        left.discard(seed)
        while q:
            x, y = q.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                c = (x + dx, y + dy)
                if c in left:
                    left.discard(c)
                    comp.add(c)
                    q.append(c)
        out.append(comp)
    out.sort(key=lambda c: (-len(c), min(c)))
    return out


def fix_diagonals(cells, blocked=None):
    """Add cells until no 2x2 block holds a diagonal-only contact — the outer
    boundary of such a mask is a SIMPLE rectilinear loop (no pinch vertices).
    Added cells may leave the habitat: the area is where a monster MAY be; the
    game validates the actual ground anyway.

    `blocked(cell)` marks cells this mask may NOT contain (the water law). A
    pinch is normally closed with the horizontal partner; when that one is
    blocked the vertical partner closes it just as well, and when BOTH are
    blocked the pinch is broken from the other side instead — by dropping the
    diagonal cell. Result: the mask never swallows a blocked cell."""
    cells = set(cells)
    for _ in range(DRY_PASSES):
        add, drop = set(), set()
        for (x, y) in sorted(cells):
            # main diagonal (ox=+1): (x,y) + (x+1,y+1) present, others absent
            # anti-diagonal (ox=-1): (x,y) + (x-1,y+1) present, others absent
            for ox in (1, -1):
                if not ((x + ox, y + 1) in cells and (x + ox, y) not in cells
                        and (x, y + 1) not in cells):
                    continue
                if blocked is None or not blocked((x + ox, y)):
                    add.add((x + ox, y))
                elif not blocked((x, y + 1)):
                    add.add((x, y + 1))
                else:
                    drop.add((x + ox, y + 1))
        if drop:                       # shrink first, then re-examine
            cells -= drop
            continue
        if not add:
            return cells
        cells |= add
    raise AssertionError("fix_diagonals did not converge")


def trace_outer(cells):
    """Outer boundary polygon of a diagonal-clean 4-connected mask: directed
    boundary edges (interior on the left), stitched into loops; the loop with
    the largest |signed area| is the outer ring. Collinear runs are merged."""
    nxt = {}

    def _set(a, b):
        assert a not in nxt, f"pinched boundary at {a} (fix_diagonals missed it)"
        nxt[a] = b

    for (x, y) in cells:
        if (x, y - 1) not in cells:
            _set((x, y), (x + 1, y))
        if (x + 1, y) not in cells:
            _set((x + 1, y), (x + 1, y + 1))
        if (x, y + 1) not in cells:
            _set((x + 1, y + 1), (x, y + 1))
        if (x - 1, y) not in cells:
            _set((x, y + 1), (x, y))
    seen = set()
    best, best_area = None, 0
    for start in sorted(nxt):
        if start in seen:
            continue
        loop, cur = [start], nxt[start]
        seen.add(start)
        while cur != start:
            loop.append(cur)
            seen.add(cur)
            cur = nxt[cur]
        area = 0
        for i, (ax, ay) in enumerate(loop):
            bx, by = loop[(i + 1) % len(loop)]
            area += ax * by - bx * ay
        if abs(area) > abs(best_area):
            best, best_area = loop, area
    poly = []
    n = len(best)
    for i in range(n):
        px, py = best[(i - 1) % n]
        cx, cy = best[i]
        qx, qy = best[(i + 1) % n]
        if (cx - px, cy - py) != (qx - cx, qy - cy):
            poly.append((cx, cy))
    return poly


def assert_simple(poly, ctx):
    """Axis-aligned, closed, and NO self-intersections (the maintainer's law:
    'a real area'). O(n^2) segment check with shared-endpoint tolerance."""
    n = len(poly)
    assert n >= 4, f"{ctx}: degenerate polygon"
    segs = []
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        assert a != b and (a[0] == b[0]) != (a[1] == b[1]), \
            f"{ctx}: edge {a}->{b} not axis-aligned"
        segs.append((a, b))
    for i in range(n):
        (ax, ay), (bx, by) = segs[i]
        for j in range(i + 1, n):
            if j == i or (j == (i + 1) % n) or ((j + 1) % n == i):
                continue
            (cx, cy), (dx, dy) = segs[j]
            # axis-aligned overlap / crossing test
            if ax == bx and cx == dx:          # both vertical
                hit = ax == cx and min(ay, by) < max(cy, dy) and min(cy, dy) < max(ay, by)
            elif ay == by and cy == dy:        # both horizontal
                hit = ay == cy and min(ax, bx) < max(cx, dx) and min(cx, dx) < max(ax, bx)
            elif ax == bx:                     # vertical x horizontal
                hit = min(cx, dx) <= ax <= max(cx, dx) and min(ay, by) <= cy <= max(ay, by) \
                    and not (ax in (cx, dx) and cy in (ay, by))
            else:
                hit = min(ax, bx) <= cx <= max(ax, bx) and min(cy, dy) <= ay <= max(cy, dy) \
                    and not (cx in (ax, bx) and ay in (cy, dy))
            assert not hit, f"{ctx}: edges {segs[i]} x {segs[j]} intersect"


def poly_cells(poly, ctx=""):
    """Cells whose CENTER lies inside the polygon (even-odd on vertical edges)."""
    ys = [y for _, y in poly]
    xs = [x for x, _ in poly]
    out = set()
    vedges = []
    n = len(poly)
    for i in range(n):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % n]
        if ax == bx:
            vedges.append((ax, min(ay, by), max(ay, by)))
    for cy in range(min(ys), max(ys)):
        yc = cy + 0.5
        crossings = sorted(x for (x, y0, y1) in vedges if y0 <= yc < y1)
        for k in range(0, len(crossings) - 1, 2):
            for cx in range(crossings[k], crossings[k + 1]):
                out.add((cx, cy))
    return out


# -- the water law ------------------------------------------------------------

def wet(w, x, y, lo, hi):
    """Would a monster of a zone banded [lo,hi] be standing on WATER here?

    True only when the base material is water AND no deck inside the band
    covers it — so a bridge span is dry (you stand on the deck) but the water
    beneath it is not. Off-grid and void cells are not water; they are simply
    not spawnable, which validate_zone handles separately."""
    if not (0 <= x < w.w and 0 <= y < w.h):
        return False
    if w.m(x, y) not in w.water:
        return False
    d = w.deck.get((x, y), -1)
    return not (d > w.base(x, y) and lo <= d <= hi)


def _cut_open(filled, inside, pocket):
    """Mask cells to REMOVE so an enclosed pond stops being enclosed.

    spawns@1 polygons are a single ring with no holes, so a pond the ring would
    swallow cannot be excluded by punching a hole — the ring has to snake
    around it. Cutting the cheapest of four straight corridors from the pond to
    outside the ring does exactly that: the boundary walks in along one wall of
    the corridor and back along the other. Ties break by direction then path,
    so the cut is deterministic."""
    best = None
    for (dx, dy) in ((0, -1), (0, 1), (-1, 0), (1, 0)):
        # start at the pond cell furthest along this direction
        sx, sy = max(sorted(pocket), key=lambda c: c[0] * dx + c[1] * dy)
        path = []
        x, y = sx + dx, sy + dy
        while (x, y) in inside:
            if (x, y) in filled:
                path.append((x, y))
            x, y = x + dx, y + dy
        cand = (len(path), (dx, dy), tuple(path))
        if best is None or cand < best:
            best = cand
    return set(best[2])


def dry_mask(w, comp, lo, hi, forbid=frozenset()):
    """Shrink a habitat component until the polygon traced from it encloses NO
    forbidden cell — water (the water law) and, via `forbid`, anything closer to
    the arrival point than this monster is allowed to be (the difficulty
    gradient). Both need the SAME guarantee: not merely that the habitat avoids
    those cells, but that the traced POLYGON cannot contain one, since the game
    picks roam points from the polygon. Two shrink moves, both strictly monotone:

      * a diagonal-fill that would land on water is refused outright
        (fix_diagonals' `blocked`), so the mask never grows into the sea;
      * a pond the outer ring would enclose is CUT OPEN by _cut_open, and the
        corridor cells join `banned` so the next pass cannot re-fill them.

    `banned` only ever grows and every pass must add to it, so this terminates;
    DRY_PASSES is a backstop that fails the BUILD rather than shipping a zone
    with water in it."""
    banned = set()
    bad = (lambda c: c in forbid or wet(w, c[0], c[1], lo, hi))
    for _ in range(DRY_PASSES):
        blocked = (lambda c: c in banned or bad(c))
        parts = comps({c for c in comp if not blocked(c)})
        if not parts:
            return set()
        filled = fix_diagonals(parts[0], blocked)
        if not filled:
            return set()
        poly = trace_outer(filled)
        inside = poly_cells(poly)
        pond = {c for c in inside if bad(c)}
        if not pond:
            return filled
        cut = set()
        for pocket in comps(pond):
            cut |= _cut_open(filled, inside, pocket)
        assert cut - banned, "dry_mask stalled: pond cut made no progress"
        banned |= cut
    raise AssertionError("dry_mask did not converge")


def _elev_of(w, cells):
    lv = sorted(w.hab_level(x, y) for (x, y) in cells)
    return [lv[0], lv[-1]]


# -- zone construction --------------------------------------------------------

def make_zone(w, kind, comp, zid, elev=None, forbid=frozenset()):
    """Build one zone with a placeholder population of 1. The real `num` is set
    later by balance_population(), which shares the world budget out per MONSTER
    (see the population doctrine above) — a zone can't know its own count
    without knowing how many other zones its monster got.

    The elevation band and the water law are mutually dependent — narrowing the
    band un-covers cells that a deck was bridging, which makes them water,
    which shrinks the mask, which narrows the band. Both only ever shrink, so
    iterating to a fixed point converges (ELEV_PASSES is the backstop)."""
    band = [int(elev[0]), int(elev[1])] if elev else _elev_of(w, comp)
    for _ in range(ELEV_PASSES):
        cells = dry_mask(w, comp, band[0], band[1], forbid)
        assert cells, f"{w.name}/{zid}: no dry ground left after the water law"
        nxt = band if elev else _elev_of(w, (cells & set(comp)) or cells)
        if nxt == band:
            break
        band = nxt
    else:
        raise AssertionError(f"{w.name}/{zid}: elev/water fixed point diverged")
    poly = trace_outer(cells)
    assert_simple(poly, f"{w.name}/{zid}")
    inside = poly_cells(poly)
    zone = {"id": zid, "monster": kind,
            "area": [[x, y] for (x, y) in poly],
            "elev": [int(band[0]), int(band[1])], "num": 1}
    zone["_valid"] = validate_zone(w, zone, inside)   # spawnable cells (the cap)
    zone["_cells"] = len(cells & set(comp))           # habitat size (the weight)
    return zone


def balance_population(w, zones):
    """Share the world's monster budget out so every TYPE ends up with a similar
    total, then spread each type's total across its own zones by area."""
    by_mon = {}
    for z in zones:
        by_mon.setdefault(z["monster"], []).append(z)
    n = len(by_mon)
    if not n:
        return zones
    land = sum(1 for y in range(w.h) for x in range(w.w)
               if w.m(x, y) not in w.water and w.m(x, y) != "")
    budget = max(n * MON_TOTAL_MIN,
                 min(n * MON_TOTAL_MAX, round(land / WORLD_CELLS_PER_MONSTER)))
    base, extra = divmod(budget, n)
    # the few +1s go to the types with the most habitat (deterministic tie-break)
    order = sorted(by_mon, key=lambda m: (-sum(z["_cells"] for z in by_mon[m]), m))
    kept = []
    for i, mon in enumerate(order):
        target = base + (1 if i < extra else 0)
        zs = sorted(by_mon[mon], key=lambda z: (-z["_cells"], z["id"]))
        if len(zs) > target:            # more zones than monsters: keep the biggest
            zs = zs[:target]
        weight = sum(z["_cells"] for z in zs) or 1
        rest = target - len(zs)         # one each, then area-proportional
        share = [rest * z["_cells"] / weight for z in zs]
        for z, s in zip(zs, share):
            z["num"] = 1 + int(s)
        for k in sorted(range(len(zs)),
                        key=lambda k: (-(share[k] % 1), zs[k]["id"]))[
                            :rest - sum(int(s) for s in share)]:
            zs[k]["num"] += 1
        for z in zs:                    # never claim more than the zone can hold
            z["num"] = min(z["num"], z["_valid"])
        short = target - sum(z["num"] for z in zs)
        for z in zs:                    # spill anything that got capped
            while short > 0 and z["num"] < z["_valid"]:
                z["num"] += 1
                short -= 1
        kept.extend(zs)
    pos = {id(z): i for i, z in enumerate(zones)}
    return sorted(kept, key=lambda z: pos[id(z)])


def assert_gradient(w, zones, field=None):
    """THE DIFFICULTY GRADIENT — nothing dangerous within reach of a newcomer.

    Two rules, both about the moment a player lands:

      * NOTHING at all inside SAFE_R walk-cells of the arrival point. Absolute.
        A fresh player has 40 HP, and the map is not allowed to spend any of it
        before they have looked around.
      * every monster at least keep_out() away, which scales with its combat
        level and pushes the ones that HUNT further still — unless its habitat
        genuinely cannot offer anywhere far enough, which is reported rather
        than hidden.

    Returns the list of monsters the terrain could not satisfy (empty is good)."""
    field = field if field is not None else walk_dist(w)
    short = []
    for z in zones:
        kind = z["monster"]
        cells = poly_cells([tuple(p) for p in z["area"]])
        ds = [field[c] for c in cells if c in field]
        if not ds:
            continue
        d = min(ds)
        assert d >= SAFE_R, (
            f"{w.name}/{z['id']} ({kind}): spawns {d} walk-cell(s) from the "
            f"arrival point {w.spawn} — inside the SAFE_R={SAFE_R} landing "
            f"radius. Newcomers arrive there with 40 HP.")
        floor = keep_out(kind)
        if d < floor:
            lvl, ag = threat(kind)
            short.append((kind, lvl, ag, d, floor))
    return short


def validate_zone(w, zone, inside=None):
    kind = zone["monster"]
    poly = [tuple(p) for p in zone["area"]]
    assert_simple(poly, f"{w.name}/{zone['id']}")
    if inside is None:
        inside = poly_cells(poly)
    lo, hi = zone["elev"]
    assert 0 <= lo <= hi <= 64, f"{zone['id']}: bad elev {zone['elev']}"
    assert zone["num"] >= 1, f"{zone['id']}: num < 1"
    ok = 0
    for (x, y) in inside:
        if not (0 <= x < w.w and 0 <= y < w.h):
            continue
        # THE WATER LAW: monsters can't swim, and water is about to become a
        # safe zone — so a zone may not even CONTAIN water it could roam onto.
        assert not wet(w, x, y, lo, hi), (
            f"{w.name}/{zone['id']} ({kind}): polygon contains WATER at "
            f"({x},{y}) in elev {zone['elev']} — monsters can't swim. Redraw "
            f"the zone off the water (dry_mask does this automatically for "
            f"generated zones; a hand-written spawns.json must do it itself).")
        if (x, y) in w.props:
            continue
        m = w.m(x, y)
        if m == "":
            continue
        # BASE surface: dry ground inside the band. Water never qualifies —
        # the assert above already proved any water here is deck-covered.
        base_ok = lo <= w.base(x, y) <= hi and m not in w.water
        # DECK surface: a deck top is standable whatever lies beneath it —
        # bridge spans over water, the cave ROOF over the cave floor.
        d = w.deck.get((x, y), -1)
        deck_ok = d > w.base(x, y) and lo <= d <= hi
        if base_ok or deck_ok:
            ok += 1
    assert ok >= zone["num"], \
        (f"{w.name}/{zone['id']}: only {ok} valid spawn cell(s) for num="
         f"{zone['num']} in elev {zone['elev']}")
    return ok


def habitat_masks(w):
    """The habitat-key -> cell-mask table for one world."""
    land = {(x, y) for y in range(w.h) for x in range(w.w)
            if w.m(x, y) not in w.water and w.m(x, y) != ""}
    water = {(x, y) for y in range(w.h) for x in range(w.w) if w.m(x, y) in w.water}
    grass = {c for c in land if w.m(*c) == "saturated_grass"}
    near = set()
    for (px, py) in w.tall_props:
        for dx in range(-TREE_R, TREE_R + 1):
            for dy in range(-TREE_R, TREE_R + 1):
                near.add((px + dx, py + dy))
    # THE BANK, not the water: land within reach of water. Before the water law
    # this mask was the wet side of the same border — that is exactly what put
    # frogs in the ocean, so it is now the dry side and nothing else.
    shore = set()
    for (x, y) in sorted(land):
        if any((x + dx, y + dy) in water
               for dx in range(-WATER_SHORE_R, WATER_SHORE_R + 1)
               for dy in range(-WATER_SHORE_R, WATER_SHORE_R + 1)):
            shore.add((x, y))
    return {
        "grass": grass,
        "forest": grass & near,
        "dirt": {c for c in land if w.m(*c) == "lightdark_dirt"},
        "snow": {c for c in land if w.m(*c) == "regular_snow"},
        "ice": {c for c in land if w.m(*c) == "crystal_ice"},
        "dark": {c for c in land if w.m(*c) == "black_mountain"},
        "stone": {c for c in land if w.m(*c) == "stone_mountain"},
        "sand": {c for c in land if w.m(*c) == "light_sand"},
        "shore": shore,
        "cave": set(w.cave_floor),
    }


def zones_for(w):
    ids = roster_ids()
    members = {}                     # habitat key -> [monster ids] in roster order
    for mid in ids:
        members.setdefault(habitat_of(mid), []).append(mid)
    masks = habitat_masks(w)
    field = walk_dist(w)             # THE DIFFICULTY GRADIENT: walk cells from spawn
    zones = []
    for hab in sorted(members):
        mask = masks.get(hab, set())
        mem = members[hab]
        min_cells = MIN_ZONE.get(hab, MIN_ZONE_DEFAULT)
        kept = [c for c in comps(mask) if len(c) >= min_cells]
        kept = kept[:max(TOP_K, len(mem))]
        if not kept:
            continue
        far = {}
        for i, c in enumerate(kept):
            d = comp_dist(c, field)
            far[i] = d if d is not None else 1 << 30   # unreachable: treat as far
        # Every member gets a zone; extra components cycle back over members, and
        # members sharing one component OVERLAP — that is still the design. What
        # changed (maintainer 2026-08-06) is WHICH component a given monster gets:
        # the NEAREST one it is allowed to live in, where "allowed" is its
        # keep_out() distance from the arrival point. Easy monsters therefore
        # come as close as the terrain permits and hard ones are pushed out,
        # instead of difficulty being scattered at random by habitat alone.
        count = max(len(mem), len(kept))
        taken = {}
        for i in range(count):
            kind = mem[i % len(mem)]
            floor = keep_out(kind)
            seen = taken.setdefault(kind, set())
            # Trim each unused component to the part far enough out for THIS
            # monster, then take the nearest surviving piece: as close as it is
            # allowed to be, never closer.
            cands = []
            for j, c in enumerate(kept):
                if j in seen:
                    continue
                t = gradient_trim(c, field, floor)
                if len(t) >= min_cells:
                    cands.append((comp_dist(t, field) or (1 << 30), -len(t), j, t))
            if cands:
                cands.sort()
                _d, _n, j, comp = cands[0]
            elif not seen:
                # Nowhere on this world is far enough for it, and it still needs
                # a home: take the furthest habitat there is. assert_gradient
                # REPORTS this rather than letting it pass unnoticed.
                j = max(range(len(kept)), key=lambda j: (far[j], len(kept[j])))
                comp = kept[j]
            else:
                # It already has a zone. A spare component is NOT a reason to add
                # a second one somewhere too easy — that is exactly how a level-11
                # Nightmule ended up 5 cells from the arrival point.
                continue
            seen.add(j)
            elev = [0, 1] if hab == "cave" else None
            # The polygon may not merely START beyond the floor — it may not
            # CONTAIN a cell inside it, or the game could roam a monster back
            # toward the newcomers. Same guarantee, same machinery as the water
            # law: hand the too-close cells to dry_mask as forbidden ground.
            # In the fallback case the terrain already cannot meet the floor, so
            # only SAFE_R is enforced — the absolute landing radius always holds.
            forbid = near_cells(field, floor if cands else SAFE_R)
            try:
                zones.append(make_zone(w, kind, comp, f"{hab}-{i + 1}",
                                       elev=elev, forbid=forbid))
            except AssertionError:
                # Nothing legal survives here on this world (small maps hit this).
                # Coverage on MUST_HAVE_ALL worlds is handled by fallback_zone.
                seen.discard(j)
    # showcase: a guard on the biggest bridge span (deck-elevation zone)
    if BRIDGE_GUARD in ids and w.bridges:
        lvl, cells = max(w.bridges, key=lambda b: (len(b[1]), b[0]))
        if len(cells) >= BRIDGE_MIN_CELLS:
            zones.append(make_zone(w, BRIDGE_GUARD, set(cells), "bridge-1",
                                   elev=[lvl, lvl]))

    # THE ISLAND 2 must carry EVERY monster (the endgame map). Any monster that
    # its habitat rules left out gets a guaranteed fallback zone; then we assert.
    if w.name in MUST_HAVE_ALL:
        placed = {z["monster"] for z in zones}
        for mid in ids:
            if mid in placed:
                continue
            z = fallback_zone(w, masks, mid)
            assert z is not None, \
                (f"{w.name} MUST contain all monsters but {mid} has NO valid "
                 f"home anywhere — redraw the habitat rules")
            zones.append(z)
        placed = {z["monster"] for z in zones}
        missing = [m for m in ids if m not in placed]
        assert not missing, f"{w.name} is missing monster(s): {missing}"
    return zones


def fallback_zone(w, masks, mid):
    """A guaranteed zone for a monster whose habitat rules produced nothing on a
    MUST_HAVE_ALL world: the largest component (no size threshold) of its own
    habitat, then of each FALLBACK_HABS habitat, that yields >=1 valid cell."""
    tried = [habitat_of(mid)] + [h for h in FALLBACK_HABS if h != habitat_of(mid)]
    for hab in tried:
        elev = [0, 1] if hab == "cave" else None
        for comp in comps(masks.get(hab, set())):    # biggest first
            try:
                return make_zone(w, mid, comp, f"extra-{mid}", elev=elev)
            except AssertionError:
                continue
    return None


def refresh(name):
    if name in BUILDER_OWNS:
        print(f"{name}: builder owns spawns.json — skipped")
        return
    wpath = os.path.join(WORLDS, name, "world.json")
    if not os.path.isfile(wpath):
        return
    if name in NO_SPAWN_WORLDS:                     # feature-test map: no monsters
        with open(os.path.join(WORLDS, name, "spawns.json"), "w") as f:
            json.dump({"schema": SCHEMA, "world": name, "zones": []}, f,
                      separators=(",", ":"))
        print(f"{name}: 0 zones (feature-test map — no monsters)")
        return
    w = W(name)
    zones = balance_population(w, zones_for(w))
    short = assert_gradient(w, zones)
    for kind, lvl, ag, d, floor in short:
        print(f"  ! {name}/{kind} (L{lvl}{'/hunts' if ag else ''}) sits {d} cells "
              f"from spawn, wanted {floor} — its habitat has nowhere further")
    for z in zones:                                 # drop the allocator's scratch
        z.pop("_valid", None)
        z.pop("_cells", None)
    doc = {"schema": SCHEMA, "world": name, "zones": zones}
    with open(os.path.join(WORLDS, name, "spawns.json"), "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    kinds = sorted({z["monster"] for z in zones})
    total = sum(z["num"] for z in zones)
    extra = f"  [ALL {len(kinds)} monsters]" if name in MUST_HAVE_ALL else ""
    print(f"{name}: {len(zones)} zone(s), {total} monsters, "
          f"{len(kinds)} kind(s){extra}")


def validate_file(name):
    """Re-validate a shipped spawns.json against its world (used by builders)."""
    w = W(name)
    doc = json.load(open(os.path.join(WORLDS, name, "spawns.json")))
    assert doc["schema"] == SCHEMA and doc["world"] == name
    ids = set(roster_ids())
    for z in doc["zones"]:
        assert z["monster"] in ids, f"{z['id']}: unknown monster {z['monster']}"
        validate_zone(w, z)
    return len(doc["zones"])


def check_all(names):
    """Gate: re-validate every SHIPPED spawns.json without regenerating anything.

    refresh() proves the laws when zones are built, but a hand-edited spawns.json
    or a world.json changed outside the pipeline would not be re-checked until
    the next rebuild. This re-runs the full validation (simple polygon, enough
    standable cells, and above all the WATER LAW) against what is on disk.

        python maps2/pipeline/spawns.py --check      # exit 1 on any violation
    """
    bad = 0
    zones = mons = 0
    for name in names:
        sp = os.path.join(WORLDS, name, "spawns.json")
        if not os.path.isfile(sp):
            print(f"  {name}: NO spawns.json")
            bad += 1
            continue
        try:
            n = validate_file(name)
        except AssertionError as e:
            print(f"  {name}: FAIL — {e}")
            bad += 1
            continue
        doc = json.load(open(sp))
        zones += n
        mons += sum(z["num"] for z in doc["zones"])
        print(f"  {name}: {n} zone(s) OK")
    print(f"spawns --check: {zones} zone(s), {mons} monsters, "
          f"{'ALL OK — no zone touches water' if not bad else f'{bad} WORLD(S) FAILED'}")
    return 1 if bad else 0


def main():
    names = [a for a in sys.argv[1:] if not a.startswith("-")]
    names = names or sorted(x for x in os.listdir(WORLDS)
                            if os.path.isfile(os.path.join(WORLDS, x, "world.json")))
    if "--check" in sys.argv:
        sys.exit(check_all(names))
    for name in names:
        refresh(name)


if __name__ == "__main__":
    main()
