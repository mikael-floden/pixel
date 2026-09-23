"""A CAVE'S WALLS ARE NAMED, IN PLACE.

The grass wall in Pit VI (games agent via the maintainer, 2026-09-23, at
262,66: "The stone cave renders grass inside it"). A raised cell says nothing
about its faces; the renderer's default is the cell's own top over the ground
at the face's foot, and inside a cave that is the lid's field drawn on the
wall: grass on the walls of a stone cave. The generator's `cliff_faces` names
every cell of a cave's ring in `walls[]` with the cave's own side - the
exposed faces AND the near and side walls that show no face to the camera,
because the game cuts a wall to one storey indoors and caps the stump with
its NAMED side (games2 tiles3 `cutCap`). newcaves.py did not run that pass on
the shipped world (its outdoor palette re-rolls), and so the three north
caves shipped with 0 of 356 ring cells named. This is the cave half of
`cliff_faces`, runnable on the world that ships and on any pit dug later:
the same cells, the same sides, nothing outdoors touched.

WHICH CELLS: what `cliff_faces` names. A cell that is not cave floor, not
liquid, not a floor or paving, not a house wall, and
  - shows an exposed face whose foot is cave floor (the wall you look at), or
  - shows no face but stands at or above the cave's rock line beside one of
    the five cells the camera reads as its wall (its near and side walls).
THE ROCK LINE IS THE CAVE'S OWN (`cave_rock_min`: ROCK_MIN 24 for the
mountain, the lid's level for a pit under a field) - not ROCK_MIN alone, which
left every near and side wall of a pit at 6 or 10 unnamed in a fresh build
too (measured: the mountain's rings were named, the dungeon's and the north
pits' were not). `cliff_faces` reads the same line now.

WHICH SIDE: the cave's own, as the dressing reads it. A themed pit takes the
theme's side (`newcaves.THEMES`, via the `theme` its place carries); a cave
already named keeps the side its ring wears; a cave with neither is ice when
its floor is all ice and grey stone otherwise (`caves()`'s own fallback). A
cell already named keeps its name: this pass ADDS, it never repaints.

    python3 maps2/pipeline/cavewalls.py --check maps2/worlds3/the_game
    python3 maps2/pipeline/cavewalls.py --apply maps2/worlds3/the_game
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

NEAR = ((0, -1), (-1, 0), (-1, -1), (1, -1), (-1, 1))   # the cells the camera reads as a room's near and side walls


def _grow(doc):
    import world3grow as W
    g = W.Grow.__new__(W.Grow)
    g.doc, g.G, g.grd, g.lvl = doc, doc["grounds"], doc["ground"], doc["level"]
    g.gi = {n: i for i, n in enumerate(g.G)}
    return g


def cave_state(g, places=None):
    """cave_floor (cell -> deck index), cave_side and cave_rock_min for the
    deck list as it is - the generator's contract, rebuilt from a shipped
    world."""
    import newcaves
    doc = g.doc
    themes = {t[0]: t[2] for t in newcaves.THEMES}
    named = collections.defaultdict(collections.Counter)
    wall_of = {}
    for w in doc["walls"]:
        for c in w["cells"]:
            wall_of[(c["x"], c["y"])] = w["side"]
    g.cave_floor, g.cave_side, g.cave_rock_min = {}, {}, {}
    decks = [(i, dk) for i, dk in enumerate(doc["decks"]) if dk.get("kind") == "cave"]
    for i, dk in decks:
        for c in dk["cells"]:
            g.cave_floor[(c["x"], c["y"])] = i
        g.cave_rock_min[i] = min(g.ROCK_MIN, int(dk["level"]))
    themed = {}
    for p in places or []:
        if p.get("kind") == "cave" and p.get("theme") in themes:
            for c in p.get("cells", []):
                themed[tuple(c)] = themes[p["theme"]]
    for i, dk in decks:
        cells = [(c["x"], c["y"]) for c in dk["cells"]]
        sides = collections.Counter(themed[c] for c in cells if c in themed)
        if sides:
            g.cave_side[i] = sides.most_common(1)[0][0]
            continue
        ring = collections.Counter()
        for (x, y) in cells:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    m = (x + dx, y + dy)
                    if m not in g.cave_floor and m in wall_of:
                        ring[wall_of[m]] += 1
        if ring:
            g.cave_side[i] = ring.most_common(1)[0][0]
        else:
            g.cave_side[i] = "ice" if all(g.g(*c) == "ice" for c in cells) else "grey_stone"
    return g


def ring_names(g, decks=None):
    """{(x, y): side} for every cell `cliff_faces` names as a cave wall,
    limited to the caves in `decks` (deck indices) when given."""
    doc, N = g.doc, len(g.lvl)
    cave = g.cave_floor
    house = {(c["x"], c["y"]) for w in doc["walls"] if w.get("kind") == "house" for c in w["cells"]}
    want = set(decks) if decks is not None else None
    out = {}
    for y in range(N - 1):
        for x in range(N - 1):
            top = g.g(x, y)
            if not top or g.liquid(x, y) or (x, y) in house:
                continue
            if top in g.INDOOR_GROUNDS or top == "light_soil":
                continue
            z = g.lvl[y][x]
            e = g.lvl[y][x + 1] if g.g(x + 1, y) else 0
            sth = g.lvl[y + 1][x] if g.g(x, y + 1) else 0
            if z <= min(e, sth):
                if (x, y) in cave:
                    continue
                near = [(x + dx, y + dy) for dx, dy in NEAR if (x + dx, y + dy) in cave]
                if near and z >= g.cave_rock_min[cave[near[0]]]:
                    i = cave[near[0]]
                    if want is None or i in want:
                        out[(x, y)] = g.cave_side[i]
                continue
            fx, fy = (x + 1, y) if e <= sth else (x, y + 1)
            if (fx, fy) in cave:
                i = cave[(fx, fy)]
                if want is None or i in want:
                    out[(x, y)] = g.cave_side[i]
    return out


def missing(g, decks=None):
    """The named cells not yet in walls[] (house or cliff): what --apply adds."""
    have = {(c["x"], c["y"]) for w in g.doc["walls"] if w.get("kind") in ("house", "cliff") for c in w["cells"]}
    return {c: s for c, s in ring_names(g, decks).items() if c not in have}


def add(doc, cells):
    """Merge {(x, y): side} into walls[] as kind-"cliff" groups; a cell dressed
    here leaves every terrain group, as in cliff_faces."""
    if not cells:
        return 0
    for w in doc["walls"]:
        if w.get("kind") not in ("house", "cliff"):
            w["cells"] = [c for c in w["cells"] if (c["x"], c["y"]) not in cells]
    doc["walls"] = [w for w in doc["walls"] if w["cells"]]
    by = collections.defaultdict(list)
    for (x, y), s in sorted(cells.items()):
        by[s].append({"x": x, "y": y})
    for side, cs in sorted(by.items()):
        grp = next((w for w in doc["walls"] if w.get("kind") == "cliff" and w["side"] == side), None)
        if grp is None:
            doc["walls"].append({"side": side, "kind": "cliff", "cells": cs})
        else:
            grp["cells"] += cs
    return len(cells)


def report(g, log=print):
    """Per cave: ring cells the rule names, how many are named, how many wait."""
    names = ring_names(g)
    have = {(c["x"], c["y"]) for w in g.doc["walls"] if w.get("kind") in ("house", "cliff") for c in w["cells"]}
    per = collections.defaultdict(lambda: [0, 0])
    for c, s in names.items():
        i = _deck_of(g, c)
        per[i][0] += 1
        per[i][1] += c not in have
    waiting = 0
    for i in sorted(per):
        n, m = per[i]
        dk = g.doc["decks"][i]
        waiting += m
        log(f"  deck {i:3d} lid {dk.get('ground'):10s} L{int(dk['level']):2d} side {g.cave_side[i]:10s} "
            f"ring named {n - m:3d}/{n:3d}{'   <- ' + str(m) + ' to name' if m else ''}")
    log(f"{len(names)} cave wall cells by the rule, {waiting} unnamed")
    return waiting


def _deck_of(g, c):
    x, y = c
    near = [(x + dx, y + dy) for dx, dy in NEAR + ((1, 0), (0, 1))]
    for m in near:
        if m in g.cave_floor:
            return g.cave_floor[m]
    return -1


def load(world_dir):
    doc = json.load(open(os.path.join(world_dir, "world.json")))
    pp = os.path.join(world_dir, "places.json")
    places = json.load(open(pp))["places"] if os.path.exists(pp) else []
    return doc, cave_state(_grow(doc), places)


def apply(world_dir, write=True, log=print):
    doc, g = load(world_dir)
    todo = missing(g)
    n = add(doc, todo)
    log(f"{world_dir}: {n} cave wall cell(s) named "
        + ", ".join(f"{s} {k}" for s, k in sorted(collections.Counter(todo.values()).items())))
    if write and n:
        g2 = cave_state(_grow(doc), json.load(open(os.path.join(world_dir, "places.json")))["places"])
        assert not missing(g2), "cells still unnamed after the pass"
        json.dump(doc, open(os.path.join(world_dir, "world.json"), "w"), separators=(",", ":"))
        log(f"wrote {world_dir}/world.json")
    return todo


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("world_dir")
    gr = ap.add_mutually_exclusive_group(required=True)
    gr.add_argument("--check", action="store_true", help="report; exit 1 when a cave wall cell is unnamed")
    gr.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.check:
        _, g = load(a.world_dir)
        sys.exit(1 if report(g) else 0)
    apply(a.world_dir, write=not a.dry_run)


if __name__ == "__main__":
    main()
