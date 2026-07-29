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
point (standable/swimmable surface in the elev range, no prop), so a polygon is
free to span the odd water speck or boulder. The same monster appears in many
zones, and zones may OVERLAP each other freely (different monsters share ground).

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
NO_SPAWN_WORLDS = {"prop_demo", "trans_demo", "glow_test", "occlusion_test"}

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
                 "ice", "sand", "cave", "water")

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
#   water   water within WATER_SHORE_R of land (shore bands + lakes)
#   cave    THE CAVE floor (cells under kind:"cave" decks, elev [0,1])
# plus one showcase zone on the biggest BRIDGE deck.
MONSTER_HABITAT = {
    "mystical_frog": "water",
    "hedgehog": "forest",
    "white_rabbit": "snow",
    "malformed_creature": "dark",
    "masked_shadow_creature": "cave",
    "night_beast": "cave",
    "lava_salamander": "dark",
    "lava_salamander_2": "dark",
    "butterfly_dragon": "grass",
    "ice_crystal_golem": "ice",
    "water_poring": "water",
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
NAME_HINTS = (("lava", "dark"), ("shadow", "cave"), ("diablo", "cave"),
              ("night", "cave"), ("ice", "ice"), ("snow", "snow"),
              ("water", "water"), ("frog", "water"), ("sand", "sand"),
              ("stone", "stone"), ("rock", "stone"), ("forest", "forest"),
              ("tree", "forest"), ("dark", "dark"))
BRIDGE_GUARD = "stone_turtle"       # the troll under^W on the bridge

DENSITY = {"water": 90}             # cells per monster, by habitat key
DENSITY_DEFAULT = 60
NUM_CAP = 12
MIN_ZONE = {"forest": 12}           # smallest component worth a zone (cells)
MIN_ZONE_DEFAULT = 30
TOP_K = 4                           # component cap per habitat (>= its members)
TREE_R = 3
WATER_SHORE_R = 4
BRIDGE_MIN_CELLS = 10


def roster_ids():
    j = json.load(open(os.path.join(REPO, "monsters", "config", "roster.json")))
    return [m["id"] for m in j["monsters"]]


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
        self.deck_kind = {}
        self.cave_floor = set()
        self.bridges = []
        for dk in doc.get("decks", []):
            cells = [(c["x"], c["y"]) for c in dk["cells"]]
            for c in cells:
                if int(dk["level"]) > self.deck.get(c, -1):
                    self.deck[c] = int(dk["level"])
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


def fix_diagonals(cells):
    """Add cells until no 2x2 block holds a diagonal-only contact — the outer
    boundary of such a mask is a SIMPLE rectilinear loop (no pinch vertices).
    Added cells may leave the habitat: the area is where a monster MAY be; the
    game validates the actual ground anyway."""
    cells = set(cells)
    while True:
        add = set()
        for (x, y) in sorted(cells):
            # main diagonal: (x,y) + (x+1,y+1) present, the other two absent
            if ((x + 1, y + 1) in cells and (x + 1, y) not in cells
                    and (x, y + 1) not in cells):
                add.add((x + 1, y))
            # anti-diagonal: (x,y) + (x-1,y+1) present, the other two absent
            if ((x - 1, y + 1) in cells and (x - 1, y) not in cells
                    and (x, y + 1) not in cells):
                add.add((x - 1, y))
        if not add:
            return cells
        cells |= add


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


# -- zone construction --------------------------------------------------------

def make_zone(w, kind, comp, zid, elev=None, num=None, share=1.0):
    cells = fix_diagonals(comp)
    poly = trace_outer(cells)
    assert_simple(poly, f"{w.name}/{zid}")
    inside = poly_cells(poly)
    if elev is None:
        lv = sorted(w.hab_level(x, y) for (x, y) in comp)
        elev = [lv[0], lv[-1]]
    if num is None:
        d = DENSITY.get(habitat_of(kind), DENSITY_DEFAULT)
        num = max(1, min(NUM_CAP, round(len(comp) / d / max(1.0, share))))
    zone = {"id": zid, "monster": kind,
            "area": [[x, y] for (x, y) in poly],
            "elev": [int(elev[0]), int(elev[1])], "num": int(num)}
    validate_zone(w, zone, inside)
    return zone


def validate_zone(w, zone, inside=None):
    kind = zone["monster"]
    poly = [tuple(p) for p in zone["area"]]
    assert_simple(poly, f"{w.name}/{zone['id']}")
    if inside is None:
        inside = poly_cells(poly)
    lo, hi = zone["elev"]
    assert 0 <= lo <= hi <= 64, f"{zone['id']}: bad elev {zone['elev']}"
    assert zone["num"] >= 1, f"{zone['id']}: num < 1"
    wants_water = habitat_of(kind) == "water"
    ok = 0
    for (x, y) in inside:
        if not (0 <= x < w.w and 0 <= y < w.h) or (x, y) in w.props:
            continue
        m = w.m(x, y)
        if m == "":
            continue
        # BASE surface: the ground/water itself must suit the kind.
        base_ok = lo <= w.base(x, y) <= hi and (m in w.water) == wants_water
        # DECK surface: a deck top is standable whatever lies beneath it —
        # bridge spans over water, the cave ROOF over the cave floor.
        d = w.deck.get((x, y), -1)
        deck_ok = (not wants_water) and d > w.base(x, y) and lo <= d <= hi
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
    shore = set()
    for (x, y) in sorted(water):
        if any((x + dx, y + dy) in land
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
        "water": shore,
        "cave": set(w.cave_floor),
    }


def zones_for(w):
    ids = roster_ids()
    members = {}                     # habitat key -> [monster ids] in roster order
    for mid in ids:
        members.setdefault(habitat_of(mid), []).append(mid)
    masks = habitat_masks(w)
    zones = []
    for hab in sorted(members):
        mask = masks.get(hab, set())
        mem = members[hab]
        min_cells = MIN_ZONE.get(hab, MIN_ZONE_DEFAULT)
        kept = [c for c in comps(mask) if len(c) >= min_cells]
        kept = kept[:max(TOP_K, len(mem))]
        if not kept:
            continue
        # every member gets a zone; extra components cycle back over members.
        # Members sharing one component OVERLAP (the design) and split its
        # population so density stays constant.
        count = max(len(mem), len(kept))
        share = count / len(kept)
        for i in range(count):
            kind = mem[i % len(mem)]
            comp = kept[i % len(kept)]
            elev = [0, 1] if hab == "cave" else None
            zones.append(make_zone(w, kind, comp, f"{hab}-{i + 1}",
                                   elev=elev, share=share))
    # showcase: a guard on the biggest bridge span (deck-elevation zone)
    if BRIDGE_GUARD in ids and w.bridges:
        lvl, cells = max(w.bridges, key=lambda b: (len(b[1]), b[0]))
        if len(cells) >= BRIDGE_MIN_CELLS:
            zones.append(make_zone(w, BRIDGE_GUARD, set(cells), "bridge-1",
                                   elev=[lvl, lvl], num=1))

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
                return make_zone(w, mid, comp, f"extra-{mid}", elev=elev, num=1)
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
    zones = zones_for(w)
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


def main():
    names = [a for a in sys.argv[1:] if not a.startswith("-")]
    names = names or sorted(x for x in os.listdir(WORLDS)
                            if os.path.isfile(os.path.join(WORLDS, x, "world.json")))
    for name in names:
        refresh(name)


if __name__ == "__main__":
    main()
