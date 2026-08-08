"""NAMED INDOOR PLACES (maintainer 2026-08-08) — `pixel-maps2/places@1`.

"Can you give the 'in-door' on each map a name so we can trigger a sound when
someone walks into that exact house/dungeon/cave etc. The game engine will then
fire an event on entering this in-door place and we can bind music to it."

Every world ships a sidecar `worlds/<name>/places.json` beside world.json,
spawns.json and npcs.json:

    {
      "schema": "pixel-maps2/places@1",
      "world": "the_island2",
      "places": [
        {"id": "stone_house",          # STABLE key — the event's identity
         "name": "The Stone House",    # display name
         "kind": "house",              # house | cave  (what sort of inside)
         "anchor": [200, 115],         # a cell inside it, for map pins/debug
         "cells": [[198,113], ...]}    # the footprint: cell -> place, one lookup
      ]
    }

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
a world is grouped into 8-connected footprints, each group is one place, and
its ROLE — "the house nearest the arrival point", "the cave" — is computed from
world.json alone. The names table is keyed on that role, never on coordinates,
so a house that moves keeps its name and a re-generated world needs no edit.
`--check` fails when a world grows an inside nobody has named.

    python maps2/pipeline/places.py                  # every world
    python maps2/pipeline/places.py the_island2 ...  # only the named ones
    python maps2/pipeline/places.py --check          # exit 1 on an unnamed inside
"""

from __future__ import annotations

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

MAPS2 = os.path.dirname(_HERE)
WORLDS = os.path.join(MAPS2, "worlds")

SCHEMA = "pixel-maps2/places@1"

# Deck kinds that make an INSIDE. A bridge deck is a roof over open air — the
# game's own classifier calls a span outdoors however enclosed it measures — so
# it is deliberately not here.
INDOOR_KINDS = ("roof", "cave")

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
    """Give every inside a role derived from the world, never from a coordinate.

    `house-1` is the house nearest the arrival point (on the_island2 that is the
    cottage you wake beside, and it stays that whatever the terrain does),
    `cave-1` the cave. Ties break on the lowest cell, so a rebuild is
    reproducible."""
    sx, sy = spawn
    ranked = {}
    for kind in ("house", "cave"):
        mine = [(k, c) for (k, c) in groups if k == kind]
        mine.sort(key=lambda kc: (min(max(abs(x - sx), abs(y - sy)) for (x, y) in kc[1]),
                                  min(kc[1])))
        for i, (_k, comp) in enumerate(mine):
            ranked[id(comp)] = f"{kind}-{i + 1}"
    return ranked


def places_for(name):
    doc = json.load(open(os.path.join(WORLDS, name, "world.json")))
    groups = _groups(doc)
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
            f"{name}: the inside {role} ({len(comp)} cells around "
            f"{min(comp)}) has NO NAME. Every inside a player can walk into is "
            f"an event the game can fire — add {role!r} to places.NAMES.")
        cx = sum(x for x, _ in comp) / len(comp)
        cy = sum(y for _, y in comp) / len(comp)
        anchor = min(comp, key=lambda c: ((c[0] - cx) ** 2 + (c[1] - cy) ** 2, c))
        out.append({"id": pid, "name": disp, "kind": kind,
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
    covered = {(int(c["x"]), int(c["y"])) for dk in world.get("decks", [])
               if dk.get("kind") in INDOOR_KINDS for c in dk["cells"]}
    seen = set()
    for p in doc["places"]:
        assert p["id"] and p["name"] and p["kind"] in ("house", "cave"), \
            f"{name}/{p.get('id')}: bad place record"
        cells = {(x, y) for (x, y) in p["cells"]}
        assert cells, f"{name}/{p['id']}: no cells"
        stray = sorted(cells - covered)
        assert not stray, \
            (f"{name}/{p['id']}: {len(stray)} cell(s) are not under any indoor "
             f"deck any more, e.g. {stray[:3]} — the building moved; re-export.")
        assert tuple(p["anchor"]) in cells, f"{name}/{p['id']}: anchor outside the place"
        assert not (cells & seen), f"{name}/{p['id']}: overlaps another place"
        seen |= cells
    missing = sorted(covered - seen)
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
          + ("ALL OK — every inside has a name"
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
