"""A SPAWN ZONE IS ONE WALKABLE PLACE - in place, on the shipped world.

Maintainer 2026-09-20, standing at 224.4,182.4 on the rim above the lava
field: *"Why have you spawned so many monsters in this small area?! They
can't even fit here!"* Measured live at that cell: four monsters - two grey
brutes, a crystal horn, a stone turtle - crammed onto a 25-cell island of
grey stone at level 23 inside the lava field. That island is part of the
stone zone's POLYGON and is not walk-connected to the zone's body sixty
cells away, so a monster seeded there can never leave it and every roam
target it draws is unreachable. It shuffles on the spot for ever, and its
zone-mates from the five other species sharing that polygon join it.

The crowding law cannot see this: it measures `num / |zone cells|` smeared
over every cell, so an island inherits the zone's comfortable average.
Measured over the_game before this pass: 35,697 of 149,328 zone cells (24%)
and ~68 of the world's 307 monsters sat on patches that are not their
zone's main body.

THE RULE: a zone's cells must be ONE patch - one place you can walk around
without leaving the zone. Each zone is split into its patches (4-neighbour,
a step of at most WALK_CLIMB either way, so the walk is two-way); every
patch big enough to hold a monster legally (ROOM_MIN cells) becomes a zone
of its own, traced around its own cells with its own elevation band; every
smaller patch carries nobody. A species' population is then shared over its
own patches by area, capped by each patch's room, so the world keeps its
monsters - they just stand where they can walk.

    python3 maps2/pipeline/spawnfit.py the_game --check
    python3 maps2/pipeline/spawnfit.py the_game --apply
"""
from __future__ import annotations

import json
import os
import sys
from collections import deque

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import spawns  # noqa: E402

WALK_CLIMB = 1          # games2/shared canEnter: a passive step up; drops are free
MIN_PATCH = spawns.ROOM_MIN     # a patch smaller than this can hold no monster legally
SWEEP_OK = 0.92         # a traced outline may re-derive to this share of one patch


def patches(cells):
    """The zone's cells (x, y, lvl) grouped into places: 4-neighbour steps of
    at most one level either way, so the walk is two-way - a drop you cannot
    climb back is a different place."""
    at = {}
    for (x, y, lv) in cells:
        at.setdefault((x, y), []).append(lv)
    seen, out = set(), []
    for c in sorted(cells):
        if c in seen:
            continue
        comp = {c}
        seen.add(c)
        q = deque([c])
        while q:
            x, y, lv = q.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                for nl in at.get((x + dx, y + dy), ()):
                    n = (x + dx, y + dy, nl)
                    if n not in seen and abs(nl - lv) <= WALK_CLIMB:
                        seen.add(n)
                        comp.add(n)
                        q.append(n)
        out.append(comp)
    out.sort(key=len, reverse=True)
    return out


def trace(patch):
    """A simple polygon round a patch, and the band it stands in. The diagonal
    fix is free to add a cell to close a pinch - what it must never do is put
    another island back inside the outline, and `split` proves that by
    re-deriving the zone's cells from the polygon it just made."""
    xy = {(x, y) for (x, y, _l) in patch}
    poly = spawns.trace_outer(spawns.fix_diagonals(xy))
    lo = min(l for (_x, _y, l) in patch)
    hi = max(l for (_x, _y, l) in patch)
    return poly, [lo, hi]


def split(w, zone):
    """[(polygon, elev, cells)] - one per patch of this zone worth keeping.
    A patch whose traced outline re-derives to something that is not (mostly)
    itself is dropped rather than shipped: the outline swept a neighbour back
    in, which is the fault this pass exists to remove."""
    out = []
    for patch in patches(spawns.spawn_cells(w, zone)):
        if len(patch) < MIN_PATCH:
            continue
        try:
            poly, elev = trace(patch)
            spawns.assert_simple(poly, zone["id"])
        except AssertionError:
            continue
        got = spawns.spawn_cells(w, dict(zone, area=[list(p) for p in poly], elev=elev))
        if not got:
            continue
        ps = patches(got)
        if len(ps[0]) < SWEEP_OK * len(got):
            continue
        out.append((poly, elev, ps[0]))
    return out


def run(world_dir, write):
    name = os.path.basename(os.path.normpath(world_dir))
    doc = json.load(open(os.path.join(world_dir, "spawns.json")))
    w = spawns.load_world(name)
    kept, dropped, before = [], [], []
    for z in doc["zones"]:
        cells = spawns.spawn_cells(w, z)
        ps = patches(cells)
        before.append((z, cells, ps))
        parts = split(w, z)
        if not parts:
            dropped.append((z, len(cells), len(ps)))
            continue
        for i, (poly, elev, pc) in enumerate(parts):
            nz = dict(z)
            nz["id"] = z["id"] if i == 0 else f"{z['id']}-{chr(ord('a') + i - 1)}"
            nz["area"] = [[int(a), int(b)] for a, b in poly]
            nz["elev"] = elev
            nz["_cells"] = len(pc)
            nz["_valid"] = len(pc)
            nz["_cap"] = spawns.zone_cap(w, pc)
            nz["_key"] = frozenset(pc)
            kept.append(nz)
    # THE PLACE CARRIES THE MONSTERS, NOT THE ZONE. This is the half the
    # crowding law was missing and the whole of what he photographed: six
    # species shared one polygon, so splitting it gave each of them its own
    # zone on the SAME 25-cell island and each zone's floor of one monster
    # put six of them on it - 0.24 per cell against a cap of 0.05. A patch is
    # one place and one place has one budget: `cells x cap` monsters, summed
    # over every species standing on it. A species that does not fit simply
    # does not live there; its monsters go to its own other patches.
    by_patch = {}
    for z in kept:
        by_patch.setdefault(z["_key"], []).append(z)
    budget = {k: max(1, int(len(k) * zs[0]["_cap"])) for k, zs in by_patch.items()}
    want = {}
    for z in doc["zones"]:
        want[z["monster"]] = want.get(z["monster"], 0) + z["num"]
    by_mon = {}
    for z in kept:
        by_mon.setdefault(z["monster"], []).append(z)
        z["num"] = 0
    # the species with the most habitat picks first, deterministically
    order = sorted(by_mon, key=lambda m: (-sum(z["_cells"] for z in by_mon[m]), m))
    for mon in order:
        zs = sorted(by_mon[mon], key=lambda z: (-z["_cells"], z["id"]))
        left = want.get(mon, 0)
        # one each on the biggest patches that still have room, then by area
        for _round in range(2):
            for z in zs:
                if left <= 0:
                    break
                room = min(spawns.room_of(z), budget[z["_key"]])
                if z["num"] >= room:
                    continue
                take = 1 if _round == 0 else min(left, room - z["num"])
                z["num"] += take
                budget[z["_key"]] -= take
                left -= take
    zones = [z for z in kept if z["num"] > 0]
    # ...AND THE DOCTRINE'S OWN HAND SETTLES WHAT IS LEFT: patches of different
    # species can still overlap where two habitats do, and enforce_density
    # takes the monster back from the thickest contributor, as the build does.
    given, stuck = spawns.enforce_density(w, zones)
    out = []
    for z in zones:
        q = {k: v for k, v in z.items() if not k.startswith("_")}
        out.append(q)
    doc["zones"] = out
    return doc, before, dropped, w, given, stuck


def report(doc, before, dropped, w):
    off0 = sum(len(c) - len(ps[0]) for _z, c, ps in before)
    cells0 = sum(len(c) for _z, c, _ps in before)
    mon0 = sum(z["num"] for z, _c, _p in before)
    isl = sum(z["num"] * (len(c) - len(ps[0])) / max(1, len(c)) for z, c, ps in before)
    off1 = 0
    cells1 = 0
    for z in doc["zones"]:
        cs = spawns.spawn_cells(w, z)
        ps = patches(cs)
        cells1 += len(cs)
        off1 += len(cs) - len(ps[0]) if ps else 0
    mon1 = sum(z["num"] for z in doc["zones"])
    for z, n, np_ in dropped:
        print(f"  DROPPED {z['id']:12s} {z['monster']:24s} {n:5d} cells in {np_} patches, none big enough to hold a monster")
    print(f"  zones   {len(before):4d} -> {len(doc['zones'])}")
    print(f"  cells   {cells0:6d} -> {cells1}   off-body {off0} ({100*off0/max(1,cells0):.0f}%) -> {off1} ({100*off1/max(1,cells1):.0f}%)")
    print(f"  monsters{mon0:6d} -> {mon1}   (of the old count ~{isl:.0f} stood on an island)")
    return off1


def main():
    name = [a for a in sys.argv[1:] if not a.startswith("-")][0]
    world_dir = os.path.join(spawns.WORLDS3, name)
    apply = "--apply" in sys.argv
    doc, before, dropped, w, given, stuck = run(world_dir, apply)
    off1 = report(doc, before, dropped, w)
    if given:
        print(f"  the crowding law took {given} monster(s) back where the split thickened an overlap"
              + (f"; {len(stuck)} cell(s) it could not settle" if stuck else ""))
    if apply:
        f = os.path.join(world_dir, "spawns.json")
        json.dump(doc, open(f, "w"), separators=(",", ":"))
        print("wrote", f)
    if off1:
        print(f"  NOTE: {off1} cells still off-body")


if __name__ == "__main__":
    main()
