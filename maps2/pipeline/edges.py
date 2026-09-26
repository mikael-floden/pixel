"""ONE GROUND TO THE EDGE.

Maintainer 2026-09-26, seven photographs of grey rims along the lip of the
mud terraces and striped stairs below them: *"I really don't understand why
you change ground type near a slope/edge like crazy! It looks ugly as fuck!
Yes back in the days we used this technique to make it easier for the player
to detect an edge. But now we have a new rule to always change ground type
on the entire new high ground so this is not needed any more and looks
ugly!"*

THE EDGE IS SHOWN BY THE WHOLE TERRACE, NEVER BY A BAND. `terrace_grounds`
gives touching terraces different grounds, whole; anything that paints a
strip along a level change on top of that is the old technique. Three passes
did, measured on the_game (744 edge cells in a ground their own terrace does
not wear):
  - the scree the apron laid at the foot of every cliff (`cliff_apron`,
    retired from the build: its band IS a ground change at an edge);
  - one-cell rock rims along a terrace's lip, left where an earlier terrace
    shape was recoloured and the recentre and later passes kept the strip;
  - FLIGHTS of small steps - one-cell strips at levels 3, 2, 1 down a bank,
    each strip its own tiny terrace - whose faces `cliff_faces` drew from a
    fresh pick per strip (grey, soil, mud, black: stripes) and whose tops a
    band crossed.

THE RULE, two parts:
  A. A PATCH of another natural ground inside a terrace that never reaches
     more than BAND_DEPTH cells in from the terrace's edge (a level change
     beside it, up or down) is a band, and takes the terrace's own ground.
     A patch that reaches deeper is a place - a fen, an ice pool, a scree
     field - and stays. Never touched: roads and paths (light_soil), beach,
     paving, floors, lava and slime, water, ramps and stairs (they carry
     their own material, `way_ground`), decks, the terrace of a road.
  B. A FLIGHT - a 4-connected run of cells whose own terraces are smaller
     than TERRACE_MIN, stepping at most one level at a time - is one thing:
     its tops take the ground most of them wear and its faces the side most
     of them are named with (ties by a coin seeded at the flight's anchor).

    python3 maps2/pipeline/edges.py --check maps2/worlds3/the_game
    python3 maps2/pipeline/edges.py --apply maps2/worlds3/the_game

The build runs `equalise(doc)` after `way_ground`, before `audit_ground`.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

NATURAL = ("grass", "dark_mud", "grey_stone", "black_rock", "snow", "ice")
KEEP = ("light_soil", "light_beach", "grey_paving_stone", "brown_paving_stone", "parquet_floor",
        "lava", "slime", "water", "deep_water")
TERRACE_MIN = 6     # the slope rule's own: a smaller terrace is a step, not high ground
BAND_DEPTH = 1      # a patch whose every cell lies within this many cells of the edge is a band
FLIGHT_MIN = 3      # a flight has at least this many cells


class World:
    def __init__(self, doc):
        self.doc = doc
        self.G, self.grd, self.lvl = doc["grounds"], doc["ground"], doc["level"]
        self.N = len(self.lvl)
        self.gi = {n: i for i, n in enumerate(self.G)}
        self.liq = set(doc.get("liquids", []))
        self.fixed = {(c["x"], c["y"]) for r in doc.get("ramps", []) for c in r["cells"]}
        self.fixed |= {(c["x"], c["y"]) for dk in doc.get("decks", []) for c in dk["cells"]}
        self.fixed |= {(c["x"], c["y"]) for r in doc.get("rooms", []) for c in r.get("cells", [])}
        self.fixed |= {(c["x"], c["y"]) for w in doc.get("walls", []) if w.get("kind") == "house"
                       for c in w["cells"]}

    def g(self, x, y):
        if not (0 <= x < self.N and 0 <= y < self.N):
            return None
        i = self.grd[y][x]
        return self.G[i] if i >= 0 else None

    def land(self, x, y):
        gg = self.g(x, y)
        return gg is not None and gg not in self.liq

    def terraces(self):
        seen, out = set(), []
        for y in range(self.N):
            for x in range(self.N):
                if (x, y) in seen or not self.land(x, y):
                    continue
                L = self.lvl[y][x]
                st, cs = [(x, y)], []
                seen.add((x, y))
                while st:
                    a, b = st.pop()
                    cs.append((a, b))
                    for n in ((a + 1, b), (a - 1, b), (a, b + 1), (a, b - 1)):
                        if n not in seen and self.land(*n) and self.lvl[n[1]][n[0]] == L:
                            seen.add(n)
                            st.append(n)
                out.append((L, cs))
        return out


def _edge_depth(w, cells):
    """Cells -> distance in cells from the terrace's edge (0 = beside a level change)."""
    S = set(cells)
    L = w.lvl[cells[0][1]][cells[0][0]]
    dist, q = {}, collections.deque()
    for (x, y) in cells:
        if any(w.land(*n) and w.lvl[n[1]][n[0]] != L and n not in S
               for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))):
            dist[(x, y)] = 0
            q.append((x, y))
    while q:
        c = q.popleft()
        for n in ((c[0] + 1, c[1]), (c[0] - 1, c[1]), (c[0], c[1] + 1), (c[0], c[1] - 1)):
            if n in S and n not in dist:
                dist[n] = dist[c] + 1
                q.append(n)
    return dist


def bands(w):
    """[(cells, from ground, to ground)] - rule A."""
    out = []
    for L, cs in w.terraces():
        if len(cs) < TERRACE_MIN:
            continue
        dom = collections.Counter(w.g(*c) for c in cs).most_common(1)[0][0]
        if dom not in NATURAL:
            continue                            # a road's terrace, a beach, a floor: as is
        depth = _edge_depth(w, cs)
        S = set(cs)
        seen = set()
        for c in cs:
            gg = w.g(*c)
            if c in seen or gg == dom or gg not in NATURAL or c in w.fixed:
                continue
            st, patch = [c], []
            seen.add(c)
            while st:
                a, b = st.pop()
                patch.append((a, b))
                for n in ((a + 1, b), (a - 1, b), (a, b + 1), (a, b - 1)):
                    if n in S and n not in seen and w.g(*n) == gg and n not in w.fixed:
                        seen.add(n)
                        st.append(n)
            if max(depth.get(p, 99) for p in patch) <= BAND_DEPTH:
                out.append((patch, gg, dom))
    return out


def flights(w):
    """[(cells, top ground, face side)] - rule B."""
    import world3grow as W
    small = set()
    for L, cs in w.terraces():
        if len(cs) < TERRACE_MIN:
            small |= {c for c in cs if w.g(*c) in NATURAL and c not in w.fixed}
    side = {}
    for wl in w.doc.get("walls", []):
        if wl.get("kind") == "cliff":
            for c in wl["cells"]:
                side[(c["x"], c["y"])] = wl["side"]
    seen, out = set(), []
    for c in sorted(small):
        if c in seen:
            continue
        st, run = [c], []
        seen.add(c)
        while st:
            a, b = st.pop()
            run.append((a, b))
            for n in ((a + 1, b), (a - 1, b), (a, b + 1), (a, b - 1)):
                if n in small and n not in seen and abs(w.lvl[n[1]][n[0]] - w.lvl[b][a]) <= 1:
                    seen.add(n)
                    st.append(n)
        if len(run) < FLIGHT_MIN:
            continue
        r = W._rng32((min(run)[0] * 2654435761 ^ min(run)[1] * 40503 ^ 0xF117) & 0xffffffff)
        tops = collections.Counter(w.g(*p) for p in run)
        best = max(tops.values())
        top = sorted(g for g, n in tops.items() if n == best)[int(r() * 1e6) % sum(1 for n in tops.values() if n == best)]
        faces = collections.Counter(side[p] for p in run if p in side)
        face = None
        if faces:
            best = max(faces.values())
            ties = sorted(s for s, n in faces.items() if n == best)
            face = ties[int(r() * 1e6) % len(ties)]
        out.append((run, top, face))
    return out


def problems(doc):
    w = World(doc)
    b = bands(w)
    side = {}
    for wl in doc.get("walls", []):
        if wl.get("kind") == "cliff":
            for c in wl["cells"]:
                side[(c["x"], c["y"])] = wl["side"]
    f = [(run, top, face) for run, top, face in flights(w)
         if any(w.g(*p) != top for p in run) or (face and any(side.get(p, face) != face for p in run))]
    return b, f


def equalise(doc, log=print):
    """Apply both rules in place. Returns (band cells repainted, flights unified)."""
    w = World(doc)
    nb = 0
    for patch, gg, dom in bands(w):
        for (x, y) in patch:
            w.grd[y][x] = w.gi[dom]
            nb += 1
    fl = flights(w)
    faces = {}
    nf = 0
    for run, top, face in fl:
        changed = False
        for (x, y) in run:
            if w.g(x, y) != top:
                w.grd[y][x] = w.gi[top]
                changed = True
        if face:
            for p in run:
                faces[p] = face
        nf += changed
    moved = 0
    if faces:
        keep = []
        for wl in doc["walls"]:
            if wl.get("kind") != "cliff":
                keep.append(wl)
                continue
            stay = [c for c in wl["cells"] if (c["x"], c["y"]) not in faces or faces[(c["x"], c["y"])] == wl["side"]]
            moved += len(wl["cells"]) - len(stay)
            wl["cells"] = stay
            keep.append(wl)
        gone = {(c["x"], c["y"]) for wl in keep if wl.get("kind") == "cliff" for c in wl["cells"]}
        add = collections.defaultdict(list)
        for p, s in sorted(faces.items()):
            if p not in gone and any(True for _ in [0]):
                add[s].append({"x": p[0], "y": p[1]})
        named = {(c["x"], c["y"]) for wl in keep for c in wl["cells"]}
        for s, cs in add.items():
            cs = [c for c in cs if (c["x"], c["y"]) not in named]
            if not cs:
                continue
            grp = next((wl for wl in keep if wl.get("kind") == "cliff" and wl["side"] == s), None)
            if grp is None:
                keep.append({"side": s, "kind": "cliff", "cells": cs})
            else:
                grp["cells"] += cs
        doc["walls"] = [wl for wl in keep if wl["cells"]]
    log(f"  rule A: {nb} band cell(s) take their terrace's ground")
    log(f"  rule B: {len(fl)} flight(s), {nf} with a top repainted, {moved} face(s) renamed")
    return nb, len(fl), moved


def apply(world_dir, write=True, log=print):
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    nb, nf, moved = equalise(doc, log)
    b, f = problems(doc)
    log(f"{world_dir}: after - {sum(len(p) for p, _, _ in b)} band cell(s), {len(f)} mixed flight(s)")
    if write and (nb or moved or nf):
        json.dump(doc, open(path, "w"), separators=(",", ":"))
        log(f"wrote {path}")
    return nb, nf, moved


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("world_dir")
    gr = ap.add_mutually_exclusive_group(required=True)
    gr.add_argument("--check", action="store_true", help="exit 1 on an edge band or a mixed flight")
    gr.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.check:
        doc = json.load(open(os.path.join(a.world_dir, "world.json")))
        b, f = problems(doc)
        kinds = collections.Counter((gg, dom) for p, gg, dom in b for _ in p)
        for k, v in kinds.most_common(10):
            print(f"  band {k[0]} on a {k[1]} terrace: {v} cell(s)")
        print(f"{a.world_dir}: {sum(len(p) for p, _, _ in b)} band cell(s), {len(f)} mixed flight(s)")
        sys.exit(1 if (b or f) else 0)
    apply(a.world_dir, write=not a.dry_run)


if __name__ == "__main__":
    main()
