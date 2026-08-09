"""NAMED PLACES (maintainer 2026-08-08) — `pixel-maps2/places@2`.

"Can you give the 'in-door' on each map a name so we can trigger a sound when
someone walks into that exact house/dungeon/cave etc. The game engine will then
fire an event on entering this in-door place and we can bind music to it."

...and then: "Let's say we want to give the top of the mountain a song triggered
by your 'mountain_top' name/id. That is outdoors, but we might want different
named zones for outdoor as well. Do we support that now? If not add support for
it. We need a zone for 'mountain_top'."

@1 could not: it derived places from roof/cave decks, so an inside was the only
thing that could have a name. @2 drops that assumption — a place is a named
REGION of the world, indoors or out — and adds the field outdoors makes
necessary, `elev`. See THE STACK below: it is not decoration.

Every world ships a sidecar `worlds/<name>/places.json` beside world.json,
spawns.json and npcs.json:

    {
      "schema": "pixel-maps2/places@2",
      "world": "the_island2",
      "places": [
        {"id": "stone_house",          # STABLE key — the event's identity
         "name": "The Stone House",    # display name
         "kind": "house",              # house | cave | summit
         "indoor": true,               # are you under a roof in here
         "elev": [0, 0],               # the SURFACE band this place lives at
         "anchor": [200, 115],         # a cell inside it, for map pins/debug
         "cells": [[198,113], ...]}    # the footprint: cell -> place, one lookup
      ]
    }

THE STACK — why `elev` exists and why a cell alone is not an answer. The cave
floor lies at elev 0-1 directly UNDER the black-mountain rock at 32-40, and the
snow cap is stacked over both. `the_cave` and `mountain_top` share 448 cells and
are nowhere near each other: one is a dungeon, the other is a summit you can see
the whole island from. A consumer must resolve (cell, the surface the player is
standing on) — exactly what `Player.elev` already carries and what spawns@1 has
banded since the water law. Two places may share cells; they may never share
cells AND an overlapping band, and the build asserts it.

WHY THIS FILE EXISTS AT ALL — nothing named an inside before it:

  * world@2 DECKS carry `kind` (roof/bridge/cave), material, level, thickness
    and cells, and no identity. Two houses are two anonymous roof decks.
  * the GAME derives insides GEOMETRICALLY, per query: `findIndoorSpace`
    (games2/shared/src/indoor.ts) flood-fills the roofed cells around you and
    measures how enclosed they are. It answers "am I indoors" perfectly and
    "indoors WHERE" not at all — the space it returns has no id, and two calls
    from the same room return equal-but-unrelated objects.
  * the SCORE already has `cave` and `home` beds, but they hang off continuous
    sensors (`BedInputs.cave` = how roofed-over you are; `fire` = how near the
    spawn bonfire), so every cave on every map is the same cave and there is no
    moment of entering — it is a gradient, not an event.

So the identity is the missing piece, and it belongs here: maps2 makes the
rooms, so maps2 names them.

NAMES ARE NOT INVENTED WHERE CANON HAS ONE. lore/canon/GLOSSARY.md is the
project's controlled vocabulary and lore/canon/CONSTRAINTS.md §5 lists the map
features it already treats as named ("their names have persisted; their
coordinates have not — use the names, never the positions"). Two of the three
insides on the_island2 were therefore already named in canon and are adopted
verbatim: the spawn cottage is **the stone house** (GLOSSARY, "the Waking":
you wake "within sight of the stone house and the fire") and the dungeon is
**the cave**, which the red line uses as a proper name throughout. Only the
maintainer's second house needed a new one, and it gets a plain descriptive
one rather than a flowery invention — lore owns the vocabulary and may replace
any name here; the id never changes.

PLACES ARE DERIVED, NAMES ARE LOOKED UP. The rule: every `roof`/`cave` deck in
a world is grouped into 8-connected footprints, and every OUTDOOR rule below
runs over the terrain; each result is one place, and its ROLE — "the house
nearest the arrival point", "the cave", "the summit" — is computed from
world.json alone. The names table is keyed on that role, never on coordinates,
so a house that moves keeps its name and a re-generated world needs no edit.
`--check` fails when a world grows a place nobody has named.

THE OUTDOOR RULE, and why none of it is a magic number. `mountain_top` is THE
MASSIF: found from the top and grown down.

  1. the SNOW LINE is measured, not chosen — walk DOWN from the highest
     populated surface level while each level's land is still mostly snow/ice,
     and stop at the first that is not. the_island2 lands on bench 28 (98% snow
     at 28, 0% and pure grey stone at 27), the boundary the tiles draw. No
     per-world tuning: the_island 24, demo_isle 7, demo_lost 8, and every flat
     showcase map gets nothing, because its snow and ice are tile SAMPLES at
     level 0 and a snow line at level 0 is not a mountain.
  2. that cap is grown DOWN through MOUNTAIN ground (`ROCK`) — which is what
     separates the massif from the high GRASS plateaus sharing its benches; on
     the_island2 bench 20 is 58% meadow, and no level-only rule can tell the
     West Plateau from the mountain's shoulder.
  3. it stops at the mountain's own FOOT: one bench below its lowest real bench
     (see `mountain_foot`). That keeps the cut-in ascent ramps — the climb — and
     drops the toe running to the sea.

Three statistics were tried and rejected on the way, all recorded so nobody
re-derives them: a fixed drop from the peak ("max - 8") reads the whole of a
shallow world as summit; the CUMULATIVE snow fraction crossed its threshold on
the_island2 by 0.06% and swept in 2,780 cells of meadow; and an ABSOLUTE
bench-size floor elected the 60 cells of coastal rock at level 1 as the
mountain's bottom bench, which left the foot at 0 and the zone reaching the
shoreline.

    python maps2/pipeline/places.py                  # every world
    python maps2/pipeline/places.py the_island2 ...  # only the named ones
    python maps2/pipeline/places.py --check          # exit 1 on an unnamed inside
"""

from __future__ import annotations

import json
import os
import sys
from collections import deque

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

MAPS2 = os.path.dirname(_HERE)
WORLDS = os.path.join(MAPS2, "worlds")

SCHEMA = "pixel-maps2/places@2"

# Deck kinds that make an INSIDE. A bridge deck is a roof over open air — the
# game's own classifier calls a span outdoors however enclosed it measures — so
# it is deliberately not here.
INDOOR_KINDS = ("roof", "cave")

# THE SUMMIT (the outdoor rule). CAP is the ground a mountain wears above its
# snow line; the line itself is measured off it, never chosen (see the module
# docstring). CAP_FRAC is how snowy a bench must be to still count as above the
# line — half, so one obsidian peak or a stone shoulder cannot end the walk
# down. LEVEL_MIN ignores the terrace-transition slivers between benches (a
# handful of cells at level 31 must not out-vote the 1,857 at 28), and
# SUMMIT_MIN keeps a 40-cell nub from being called a mountain top.
CAP = ("regular_snow", "crystal_ice")
CAP_FRAC = 0.5
LEVEL_MIN = 20
SUMMIT_MIN = 200
BENCH_FRAC = 0.05      # a real bench, relative to the massif's biggest level

# ...AND THE CLIMB COUNTS (maintainer 2026-08-08, screenshot from surface 17 on
# the grey benches): "I want the mountain top to start when the player have
# almost climbed it and are kinda at the top. Want the entire mountain_top +
# almost up on it to have the trigger."
#
# The snow line alone starts the zone at bench 28, so a player on the ascent —
# already up in the rock with the whole massif around them — got nothing. The
# zone is therefore the MASSIF, grown DOWN from the cap through MOUNTAIN ground
# and stopping at the mountain's own foot:
#
#   * ROCK is what the massif is made of. Growing down through it rather than by
#     level is what separates the mountain from the high GRASS plateaus that
#     share its benches — level 20 on the_island2 is 58% meadow, and no
#     level-only rule can tell the West Plateau from the mountain's shoulder.
#   * the FOOT is one bench below the lowest REAL bench (a level carrying at
#     least LEVEL_MIN cells of massif). Everything under that is single-digit
#     slivers: the cut-in ascent ramps and the toe running to the sea. Keeping
#     one bench of them is what makes the zone start where the climb ends
#     instead of at the summit proper; dropping the rest is what stops the
#     mountain music playing on a rock at the shoreline.
#
# On the_island2 the benches are 20/24/28/32/36/40, so the foot derives to 16 —
# which is exactly where the generator puts the massif floor ("floor 16 sits a
# gated Delta-4 above the maze cap 12"). The derivation was not tuned to that;
# it landed there, which is the check that it is measuring something real.
ROCK = ("stone_mountain", "black_mountain", "regular_snow", "crystal_ice")

# role -> (id, display name). The ROLE is derived (see role_of): `house-1` is
# the house nearest the arrival point, `house-2` the next, `cave-1` the cave.
# Ids are the event keys and MUST NOT change once the game binds to them; the
# display name may be rewritten (lore owns the vocabulary).
NAMES = {
    "the_island2": {
        # GLOSSARY.md, "the Waking": you wake in the meadow grass "within sight
        # of the stone house and the fire". That is this cottage — canon named
        # it before maps2 did, so canon wins.
        "house-1": ("stone_house", "The Stone House"),
        # The maintainer's second house (2026-08-07), on the meadow west of the
        # stone house. No canon name; plain and descriptive until lore gives it
        # one — the id is what the engine binds to and it will not change.
        "house-2": ("meadow_house", "The Meadow House"),
        # CONSTRAINTS.md §5 and the red line both use "the cave" as a proper
        # name — the one dungeon everybody in the world is afraid of.
        "cave-1": ("the_cave", "The Cave"),
    },
    # The floor-plan demo (housedemo.py). Ordinals ARE the logical name here:
    # these are six generated plans, not six places in the world.
    "house_demo": {f"house-{i}": (f"demo_house_{i}", f"House {i}") for i in range(1, 7)},
    "occlusion_test": {"house-1": ("test_house", "Occlusion Test House")},
}
# The maintainer named this one himself ("triggered by your 'mountain_top'
# name/id"), so every world that HAS a snow cap uses it — the id is unique
# within its own world, and one id for one kind of place is what lets the score
# bind a mountain song once instead of per map. No canon name exists for a
# summit (CONSTRAINTS §5 lists Trollstigen, the cave, the gorge, Sunken Hollow,
# West Plateau, Mirror Lake basin, the lagoons and the tarn — no peak), so the
# display name is plain and lore may rewrite it.
for _w in ("the_island2", "the_island", "demo_isle", "demo_lost"):
    NAMES.setdefault(_w, {})["summit-1"] = ("mountain_top", "The Mountain Top")


class _Terrain:
    """The world as the PLAYER meets it: one surface level per cell.

    A cave roof deck carries the pre-carve mountain top verbatim, so on the
    massif the surface is the DECK, not the base — read the base there and the
    summit reads as the cave floor it is sitting on top of."""

    def __init__(self, doc):
        self.w, self.h = doc["size"]["w"], doc["size"]["h"]
        mats = doc["materials"]
        self.mat = [[mats[i] for i in row] for row in doc["mat"]]
        self.lvl = doc["level"]
        self.water = set(doc.get("water", ["clear_water"]))
        self.top = {}                      # cell -> cave-roof surface, if any
        self.bot = {}                      # cell -> lowest ceiling over it
        for dk in doc.get("decks", []):
            lv, th = int(dk["level"]), int(dk.get("thickness", 1))
            for c in dk["cells"]:
                p = (int(c["x"]), int(c["y"]))
                if dk.get("kind") == "cave":
                    self.top[p] = max(self.top.get(p, -1), lv)
                if dk.get("kind") in INDOOR_KINDS:
                    self.bot[p] = min(self.bot.get(p, 1 << 20), lv - th)

    def surf(self, x, y):
        return max(self.top.get((x, y), -1), int(self.lvl[y][x]))

    def is_land(self, x, y):
        m = self.mat[y][x]
        return m != "" and m not in self.water

    def land(self):
        return [(x, y) for y in range(self.h) for x in range(self.w)
                if self.is_land(x, y)]


def snow_line(t):
    """The level at which this world becomes a snow cap, or None if it never does.

    Walk DOWN from the highest bench that carries real ground while each bench
    is still mostly CAP, and stop at the first that is not. Benches thinner than
    LEVEL_MIN are terrace-transition slivers and do not get a vote."""
    per = {}
    for (x, y) in t.land():
        lv = t.surf(x, y)
        cap, tot = per.get(lv, (0, 0))
        per[lv] = (cap + (t.mat[y][x] in CAP), tot + 1)
    line = None
    for lv in sorted((l for l, (_c, n) in per.items() if n >= LEVEL_MIN and l > 0),
                     reverse=True):
        cap, tot = per[lv]
        if cap / tot < CAP_FRAC:
            break
        line = lv
    return line


def mountain_foot(t, comp):
    """The level the massif stands ON: one bench below its lowest REAL bench.

    A bench is real RELATIVE TO THIS MOUNTAIN — at least BENCH_FRAC of its
    biggest level. An absolute threshold does not work: the_island2's coastal
    rock is 60 cells at level 1, which clears any fixed floor and would elect
    itself the mountain's bottom bench, while the terrace slivers between real
    benches (20-25 cells each) would count as benches too and collapse the
    measured spacing from 4 to 1. Against the region's own scale the six benches
    20/24/28/32/36/40 separate cleanly from everything else.

    The SPACING is measured for the same reason (4 on a Delta-4 terraced massif,
    1 on a smoothly-sloped one), so 'one bench below' means the same thing on
    both and there is no step size to pick. Everything under that foot is the
    cut-in ascent ramps and the toe running to the sea."""
    per = {}
    for c in comp:
        lv = t.surf(*c)
        per[lv] = per.get(lv, 0) + 1
    bar = max(per.values()) * BENCH_FRAC
    benches = sorted(l for l, n in per.items() if n >= bar)
    if not benches:
        return min(per)
    step = min((b - a for a, b in zip(benches, benches[1:])), default=1)
    return benches[0] - step


def _outdoor(t):
    """The named OUTDOOR regions of a world: [(kind, cells)]. Today, the massif.

    Grown DOWN from the snow cap through mountain ground to the mountain's own
    foot — so the zone covers the summit AND the climb onto it. Both flanks of
    the gorge are one place: the top of a mountain does not become a different
    place because a canyon splits it, and a song should not stop because you
    crossed a bridge."""
    line = snow_line(t)
    if line is None:
        return []
    rock = {c for c in t.land() if t.mat[c[1]][c[0]] in ROCK}
    comp = {c for c in rock if t.surf(*c) >= line}
    if not comp:
        return []
    left, q = rock - comp, deque(comp)
    while q:                               # down the mountain, never off it
        x, y = q.popleft()
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                n = (x + i, y + j)
                if n in left:
                    left.discard(n)
                    comp.add(n)
                    q.append(n)
    foot = mountain_foot(t, comp)
    comp = {c for c in comp if t.surf(*c) >= foot}
    if len(comp) < SUMMIT_MIN:
        return []                          # a nub, not a mountain
    return [("summit", comp)]


def _groups(doc):
    """Every INSIDE in a world: 8-connected footprints of its roof/cave decks.

    8-connected on purpose, and for the same reason the game's own `shell` is:
    a point-touch between two slabs is a visible seam, not a separate building.
    The cave is twelve decks stacked up the massif and is one place."""
    own = {}
    for dk in doc.get("decks", []):
        if dk.get("kind") not in INDOOR_KINDS:
            continue
        for c in dk["cells"]:
            p = (int(c["x"]), int(c["y"]))
            # a cave slab and a roof slab can never share a cell, but if they
            # ever did, the deeper kind wins: you are inside the cave.
            if own.get(p) != "cave":
                own[p] = dk["kind"]
    left, out = set(own), []
    while left:
        seed = min(left)
        st, comp = [seed], set()
        left.discard(seed)
        while st:
            x, y = st.pop()
            comp.add((x, y))
            for i in (-1, 0, 1):
                for j in (-1, 0, 1):
                    q = (x + i, y + j)
                    if q in left:
                        left.discard(q)
                        st.append(q)
        kind = "cave" if any(own[c] == "cave" for c in comp) else "house"
        out.append((kind, comp))
    return out


def role_of(groups, spawn):
    """Give every place a role derived from the world, never from a coordinate.

    `house-1` is the house nearest the arrival point (on the_island2 that is the
    cottage you wake beside, and it stays that whatever the terrain does),
    `cave-1` the cave, `summit-1` the mountain top. Ties break on the lowest
    cell, so a rebuild is reproducible."""
    sx, sy = spawn
    ranked = {}
    for kind in sorted({k for k, _c in groups}):
        mine = [(k, c) for (k, c) in groups if k == kind]
        mine.sort(key=lambda kc: (min(max(abs(x - sx), abs(y - sy)) for (x, y) in kc[1]),
                                  min(kc[1])))
        for i, (_k, comp) in enumerate(mine):
            ranked[id(comp)] = f"{kind}-{i + 1}"
    return ranked


def _band(t, kind, comp):
    """The SURFACE band this place lives at — what the player's `elev` must be in.

    Indoors that is the FLOOR under the slab, and the walls are excluded by
    construction: a wall cell's base reaches the ceiling (`level - thickness`),
    the floor's does not. Outdoors it is simply the ground you walk on. This is
    what keeps `the_cave` [0,1] and `mountain_top` [28,40] apart on the 448
    cells they share."""
    if kind in ("house", "cave"):
        lv = [int(t.lvl[y][x]) for (x, y) in comp
              if int(t.lvl[y][x]) < t.bot.get((x, y), 1 << 20)]
    else:
        lv = [t.surf(x, y) for (x, y) in comp]
    assert lv, f"place has no standable surface: {sorted(comp)[:3]}"
    return [min(lv), max(lv)]


def places_for(name):
    doc = json.load(open(os.path.join(WORLDS, name, "world.json")))
    t = _Terrain(doc)
    groups = _groups(doc) + _outdoor(t)
    if not groups:
        return []
    spawn = (int(doc["spawn"][0]), int(doc["spawn"][1]))
    roles = role_of(groups, spawn)
    table = NAMES.get(name, {})
    out = []
    for kind, comp in groups:
        role = roles[id(comp)]
        pid, disp = table.get(role, (None, None))
        assert pid, (
            f"{name}: the place {role} ({len(comp)} cells around "
            f"{min(comp)}) has NO NAME. Every place a player can walk into is "
            f"an event the game can fire — add {role!r} to places.NAMES.")
        cx = sum(x for x, _ in comp) / len(comp)
        cy = sum(y for _, y in comp) / len(comp)
        anchor = min(comp, key=lambda c: ((c[0] - cx) ** 2 + (c[1] - cy) ** 2, c))
        out.append({"id": pid, "name": disp, "kind": kind,
                    "indoor": kind in ("house", "cave"),
                    "elev": _band(t, kind, comp),
                    "anchor": [anchor[0], anchor[1]],
                    "cells": [[x, y] for (x, y) in sorted(comp)]})
    out.sort(key=lambda p: p["id"])
    ids = [p["id"] for p in out]
    assert len(set(ids)) == len(ids), f"{name}: duplicate place id(s) in {ids}"
    return out


def refresh(name):
    wpath = os.path.join(WORLDS, name, "world.json")
    if not os.path.isfile(wpath):
        return
    places = places_for(name)
    doc = {"schema": SCHEMA, "world": name, "places": places}
    with open(os.path.join(WORLDS, name, "places.json"), "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    if places:
        print(f"{name}: {len(places)} named place(s) — "
              + ", ".join(f"{p['name']} ({p['kind']}, {len(p['cells'])} cells)"
                          for p in places))
    else:
        print(f"{name}: 0 places (nothing to walk into)")


def validate_file(name):
    """Re-check a shipped places.json against its world (the gate).

    Proves the two things a consumer relies on: every inside in the world is
    named, and every named cell is really covered by an indoor deck — so a
    terrain change that moves a building cannot leave the event firing over
    open grass."""
    doc = json.load(open(os.path.join(WORLDS, name, "places.json")))
    assert doc["schema"] == SCHEMA and doc["world"] == name
    world = json.load(open(os.path.join(WORLDS, name, "world.json")))
    t = _Terrain(world)
    covered = {(int(c["x"]), int(c["y"])) for dk in world.get("decks", [])
               if dk.get("kind") in INDOOR_KINDS for c in dk["cells"]}
    inside, done = set(), []
    for p in doc["places"]:
        assert p["id"] and p["name"] and p["kind"] in ("house", "cave", "summit"), \
            f"{name}/{p.get('id')}: bad place record"
        lo, hi = p["elev"]
        assert 0 <= lo <= hi, f"{name}/{p['id']}: bad elev {p['elev']}"
        cells = {(x, y) for (x, y) in p["cells"]}
        assert cells, f"{name}/{p['id']}: no cells"
        assert tuple(p["anchor"]) in cells, f"{name}/{p['id']}: anchor outside the place"
        if p["indoor"]:
            stray = sorted(cells - covered)
            assert not stray, \
                (f"{name}/{p['id']}: {len(stray)} cell(s) are not under any "
                 f"indoor deck any more, e.g. {stray[:3]} — the building moved; "
                 f"re-export.")
            inside |= cells
        else:
            wet = sorted(c for c in cells if not t.is_land(*c))
            assert not wet, \
                (f"{name}/{p['id']}: {len(wet)} cell(s) are water or void, e.g. "
                 f"{wet[:3]} — an outdoor place is ground you stand on.")
        # THE STACK: two places may share cells, never cells AND a band. The cave
        # floor and the summit over it are 448 shared cells and 28 levels apart.
        for (oid, ocells, olo, ohi) in done:
            both = cells & ocells
            if both and not (hi < olo or ohi < lo):
                raise AssertionError(
                    f"{name}: {p['id']} {p['elev']} and {oid} [{olo},{ohi}] share "
                    f"{len(both)} cell(s) at an overlapping elevation, e.g. "
                    f"{sorted(both)[:3]} — a player standing there is in two "
                    f"places at once and the game cannot pick one.")
        done.append((p["id"], cells, lo, hi))
    missing = sorted(covered - inside)
    assert not missing, \
        (f"{name}: {len(missing)} roofed cell(s) belong to NO named place, e.g. "
         f"{missing[:3]} — a player can walk in there and the game has nothing "
         f"to fire. Re-export, and name the new inside in places.NAMES.")
    return len(doc["places"])


def check_all(names):
    bad = total = 0
    for name in names:
        pp = os.path.join(WORLDS, name, "places.json")
        if not os.path.isfile(pp):
            print(f"  {name}: NO places.json")
            bad += 1
            continue
        try:
            n = validate_file(name)
        except AssertionError as e:
            print(f"  {name}: FAIL — {e}")
            bad += 1
            continue
        total += n
        print(f"  {name}: {n} place(s) OK")
    print(f"places --check: {total} named place(s), "
          + ("ALL OK — every place has a name, nothing is in two at once"
             if not bad else f"{bad} WORLD(S) FAILED"))
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
