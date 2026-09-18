"""SOMEBODY LIVES HERE — the ground and the yard around every house.

Maintainer 2026-09-18: *"I think it looks better if you place brown or grey
paving stone around the house (not a hard rule so don't do this 100%) and use
paving stone or stone to create a nice looking path/entrance to the house that
maybe connects to a road or something. You should think somebody lives here. A
garden? Maybe they have wet cloth hanging in the wind. Feel creative and make
the house not just be a boring square."*

EVERY CHOICE IS A POOL DRAWN PER HOUSE (his meta-law: a nudge, never an if):
  the APRON     none 30 / the doorstep 25 / the front 20 / a ring 20 / wide 5,
                in brown or grey paving - the street's own material seven
                times in ten when a street is near, else a coin;
  the PATH      from the doorstep to the nearest road or street within
                PATH_MAX steps on the house's own level (BFS over dry ground,
                round other houses, their doorsteps and every footprint),
                paved in the apron's material; one wide, or two wide near a
                street (3 in 10); no road in reach -> a short walk of paving
                that ends in the grass (6 in 10) or nothing;
  the GARDEN    5 in 10: a tilled plot beside the house - dark mud on grass,
                grass on the town's mud (a place brings its own ground) -
                with two to four bushes, flower stands, planters, hives or a
                scarecrow in it;
  the YARD      two to four pieces from a pool - a washing line, a woodpile,
                barrels, a bench, a well or a pump, a cart, a haystack, a hive,
                a fence, and drying racks only where the water is close -
                each judged where it stands by the generator's own footprint
                law (walls, doorways, level, shore, the gap to every other
                footprint), at its nav-fit offset, never behind the roof.
A house on snow or rock keeps its bare ground (paving on a summit is a lie),
and no ground is painted into a natural-ground SPECK: a house whose painting
would leave one is painted again with the next draw, or not at all.

THE SHIPPED WORLD CHANGES IN PLACE (maintainer 2026-09-13): `--apply` dresses
the world that ships; the build calls the same pass after it writes
world.json, so a rebuilt world gets its yards from the same rule.

    python3 maps2/pipeline/yards.py --dry-run maps2/worlds3/the_game
    python3 maps2/pipeline/yards.py --apply   maps2/worlds3/the_game
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import zlib
from collections import deque

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
sys.path.insert(0, _HERE)

PATH_MAX = 18
RING = 3                       # the yard: cells within this of the house
APRON = ((None, 30), ("step", 25), ("front", 20), ("ring", 20), ("wide", 5))
MATERIAL = (("brown_paving_stone", 50), ("grey_paving_stone", 50))
STREET_WINS = 0.7              # a street nearby: its material, seven in ten
WALK_WHEN_NO_ROAD = 0.6
WALK_LEN = (3, 6)
GARDEN = 0.5
GARDEN_SIZE = ((3, 2), (3, 3), (4, 2), (4, 3))
GARDEN_POOL = (("bushes", 3), ("flower_stands", 3), ("trailing_planters", 2),
               ("beehives", 2), ("scarecrows", 2))
GARDEN_N = ((2, 3), (3, 4), (4, 2))
YARD_POOL = (("washing_lines", 30), ("woodpiles", 30), ("barrels", 25),
             ("chairs_and_benches", 20), ("wells", 12), ("water_pumps", 12),
             ("carts", 8), ("haystacks", 8), ("beehives", 10), ("fences", 15),
             ("fish_drying_racks", 15))
YARD_N = ((2, 4), (3, 4), (4, 2))
WATER_NEAR = 8                 # drying racks want water within this many cells
TWICE_OK = ("barrels", "woodpiles", "fences", "beehives")
BARE = ("snow", "ice", "black_rock", "grey_stone", "lava", "slime")
PAVE_ON = ("grass", "dark_mud", "light_soil")
ROAD = ("light_soil",)
PAVING = ("brown_paving_stone", "grey_paving_stone")


def _rng(seed):
    r = zlib.crc32(seed.encode()) & 0xffffffff

    def nxt():
        nonlocal r
        r = (r * 1103515245 + 12345) & 0x7fffffff
        return r / 0x80000000
    return nxt


def _weighted(pool, rnd):
    tot = sum(w for _, w in pool)
    t = rnd() * tot
    for it, w in pool:
        t -= w
        if t <= 0:
            return it
    return pool[-1][0]


def _shell(doc):
    """The generator, as navfit builds it: enough of it to judge a footprint
    where it stands, with every shipped placement already claiming ground."""
    import navfit
    import world3grow as W
    g = W.Grow.__new__(W.Grow)
    g.doc, g.G = doc, doc["grounds"]
    g.gi = {n: i for i, n in enumerate(g.G)}
    g.grd, g.lvl = doc["ground"], doc["level"]
    g._bbox, g._hit = navfit.load_docs()
    g._fp = {}
    g.door_cells = navfit._thresholds(doc)
    g.cave_floor = navfit._cave_floor(doc)
    W.NEW = min(doc["size"]["w"], doc["size"]["h"])
    for p in doc["scenery"]:
        if p.get("z") is not None or g._flat(p):
            continue
        sh = g._fp_shape(p)
        if sh:
            kind, dwx, dwy, hx, hy = sh
            g._fp_add(p["x"] + dwx, p["y"] + dwy, hx, hy if kind == "rect" else None)
        else:
            g._fp_add(int(p["x"]) + 0.5, int(p["y"]) + 0.5, g.FP_DEFAULT, None)
    return g


def _houses(doc):
    walls = {(c["x"], c["y"]) for w in doc.get("walls", []) if w.get("kind") != "cliff"
             for c in w["cells"]}
    out = []
    for d in doc.get("decks", []):
        if d.get("kind") != "roof":
            continue
        cells = {(c["x"], c["y"]) for c in d["cells"]}
        doors = []
        for (x, y) in sorted(cells):
            if (x, y) in walls:
                continue
            for dx, dy in ((0, 1), (1, 0), (0, -1), (-1, 0)):
                if (x + dx, y + dy) not in cells:
                    doors.append(((x, y), (x + dx, y + dy), (dx, dy)))
                    break
        if not doors:
            continue
        xs = [c[0] for c in cells]
        ys = [c[1] for c in cells]
        out.append({"cells": cells, "bbox": (min(xs), min(ys), max(xs), max(ys)),
                    "door": doors[0][0], "step": doors[0][1], "face": doors[0][2]})
    out.sort(key=lambda h: h["bbox"])
    return out


class Yards:
    def __init__(self, doc):
        self.doc = doc
        self.g = _shell(doc)
        self.G = doc["grounds"]
        self.gi = self.g.gi
        self.grd, self.lvl = doc["ground"], doc["level"]
        self.N = len(self.grd)
        self.houses = _houses(doc)
        self.house_cells = set().union(*(h["cells"] for h in self.houses))
        self.doorsteps = set(self.g.door_cells)
        self.occupied = {(int(p["x"]), int(p["y"])) for p in doc["scenery"] if p.get("z") is None}
        self.no_place = set()
        for h in self.houses:
            x0, y0, x1, y1 = h["bbox"]
            for x in range(x0 - 2, x1 + 3):
                for y in range(y0 - 6, y1 + 1):
                    self.no_place.add((x, y))
        self.liquid = {self.gi[n] for n in doc.get("liquids", []) if n in self.gi}
        self.painted = set()
        self.log = []

    # -- ground ---------------------------------------------------------------
    def ground(self, x, y):
        return self.G[self.grd[y][x]] if 0 <= x < self.N and 0 <= y < self.N else None

    def wet(self, x, y):
        return self.grd[y][x] in self.liquid

    def dry_at(self, x, y, level):
        return (0 <= x < self.N and 0 <= y < self.N and not self.wet(x, y)
                and self.lvl[y][x] == level and (x, y) not in self.house_cells)

    def paint(self, x, y, name):
        if self.ground(x, y) != name:
            self.grd[y][x] = self.gi[name]
            self.painted.add((x, y))

    def natural_specks(self, box, before=None):
        """The natural-ground components of SPECK_MAX cells or fewer inside a
        box, as frozensets — compared before and after a painting."""
        x0, y0, x1, y1 = box
        nat = set(self.g.NATURAL)
        seen, out = set(), set()
        for y in range(max(0, y0), min(self.N, y1 + 1)):
            for x in range(max(0, x0), min(self.N, x1 + 1)):
                if (x, y) in seen or self.ground(x, y) not in nat:
                    continue
                comp, q = {(x, y)}, deque([(x, y)])
                seen.add((x, y))
                g0, l0 = self.ground(x, y), self.lvl[y][x]
                big = False
                while q:
                    cx, cy = q.popleft()
                    for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                        if (nx, ny) in comp or self.ground(nx, ny) != g0 or self.lvl[ny][nx] != l0:
                            continue
                        comp.add((nx, ny)); seen.add((nx, ny)); q.append((nx, ny))
                        if len(comp) > self.g.SPECK_MAX:
                            big = True
                    if big and len(comp) > self.g.SPECK_MAX * 4:
                        break
                if not big:
                    out.add(frozenset(comp))
        return out

    # -- the pieces -----------------------------------------------------------
    def _pool(self, group):
        import heal
        gp = os.path.join(REPO, "scenery", group)
        if not os.path.isdir(gp):
            return []
        gone = heal._retired()[0]
        return [f"{group}/{n}" for n in sorted(os.listdir(gp))
                if os.path.isfile(os.path.join(gp, n, "scenery.json")) and f"{group}/{n}" not in gone
                and not heal._rejected(f"{group}/{n}")]

    def _state(self, piece, rnd):
        import heal
        meta = heal._meta(piece) or {}
        sts = [s for s in sorted(meta.get("states") or {}) if s.startswith("NOT_LIT")
               and heal._ok_state(piece, s, None)]
        return sts[int(rnd() * len(sts)) % len(sts)] if sts else None

    def place(self, piece, x, y, rnd, level):
        """One yard piece, judged where it stands by the generator's own law;
        appended to the world and claiming its ground when it passes."""
        import heal
        g = self.g
        cx, cy = int(x), int(y)
        if not self.dry_at(cx, cy, level) or (cx, cy) in self.doorsteps or (cx, cy) in self.no_place \
                or (cx, cy) in self.occupied or (cx, cy) in self.path_cells:
            return False
        meta = heal._meta(piece) or {}
        hflip = meta.get("must_be_imbplemented_with_random_hflip") is not False and rnd() < 0.5
        state = self._state(piece, rnd)
        probe = {"piece": piece, "x": x, "y": y, "hflip": hflip, "state": state, "dir": None}
        sh = g._fp_shape(probe)
        if sh:
            kind, dwx, dwy, hx, hy = sh
            x, y = g._nav_target(probe, x, y)
            if (int(x), int(y)) != (cx, cy) and not self.dry_at(int(x), int(y), level):
                return False
            wx, wy, R, HY = x + dwx, y + dwy, hx, (hy if kind == "rect" else None)
        else:
            wx, wy, R, HY = cx + 0.5, cy + 0.5, g.FP_DEFAULT, None
        flat = g._flat(probe)
        if not flat and not g._art_clear(piece, x, y, state):
            return False
        if not g._footprint_ok(wx, wy, R, HY, flush=False, flat=flat):
            return False
        p = {"piece": piece, "x": round(x, 4), "y": round(y, 4)}
        if hflip:
            p["hflip"] = True
        if state:
            p["state"] = state
        self.doc["scenery"].append(p)
        if not flat:
            g._fp_add(wx, wy, R, HY)
        self.occupied.add((int(x), int(y)))
        return True

    # -- one house ------------------------------------------------------------
    def dress(self, h):
        x0, y0, x1, y1 = h["bbox"]
        sx, sy = h["step"]
        fx, fy = h["face"]
        rnd = _rng(f"yard|{x0}|{y0}|{x1}|{y1}")
        level = self.lvl[sy][sx]
        counts = {}
        for (x, y) in self._ring(h, RING, level, grounds=None):
            gg = self.ground(x, y)
            if gg not in PAVING:
                counts[gg] = counts.get(gg, 0) + 1
        ring_ground = max(counts, key=counts.get) if counts else None
        h["ring_ground"] = ring_ground
        report = {"house": (x0, y0, x1, y1), "door": h["door"], "step": h["step"]}
        if ring_ground in BARE or ring_ground is None:
            report["apron"] = "bare ground - none"
            self.path_cells = set()
        else:
            self._ground(h, rnd, level, report)
        self._garden(h, rnd, level, report)
        self._yard(h, rnd, level, report)
        self.log.append(report)
        return report

    def _material(self, h, rnd):
        x0, y0, x1, y1 = h["bbox"]
        near = {}
        for y in range(y0 - 6, y1 + 7):
            for x in range(x0 - 6, x1 + 7):
                gg = self.ground(x, y)
                if gg in PAVING and (x, y) not in self.house_cells:
                    near[gg] = near.get(gg, 0) + 1
        if near and rnd() < STREET_WINS:
            return max(near, key=near.get)
        return _weighted(MATERIAL, rnd)

    def _ring(self, h, dist, level, grounds=PAVE_ON):
        """The cells within `dist` of the house on its level; `grounds` limits
        them (None: any dry ground - a yard stands on snow, paving does not)."""
        x0, y0, x1, y1 = h["bbox"]
        out = []
        for y in range(y0 - dist, y1 + dist + 1):
            for x in range(x0 - dist, x1 + dist + 1):
                d = max(x0 - x, x - x1, y0 - y, y - y1)
                if 1 <= d <= dist and self.dry_at(x, y, level) and (grounds is None or self.ground(x, y) in grounds):
                    out.append((x, y))
        return out

    def _front(self, h, level):
        x0, y0, x1, y1 = h["bbox"]
        fx, fy = h["face"]
        if fy:
            row = y1 + 1 if fy > 0 else y0 - 1
            cells = [(x, row) for x in range(x0, x1 + 1)]
        else:
            col = x1 + 1 if fx > 0 else x0 - 1
            cells = [(col, y) for y in range(y0, y1 + 1)]
        return [c for c in cells if self.dry_at(*c, level) and self.ground(*c) in PAVE_ON]

    def _road_path(self, h, level, avoid):
        """BFS from the doorstep to the nearest road or street cell."""
        sx, sy = h["step"]
        start = (sx, sy)
        prev = {start: None}
        q = deque([(start, 0)])
        while q:
            (cx, cy), d = q.popleft()
            if (cx, cy) != start and self.ground(cx, cy) in ROAD + PAVING and (cx, cy) not in avoid:
                path, c = [], prev[(cx, cy)]
                while c and c != start:
                    path.append(c); c = prev[c]
                return path[::-1], (cx, cy)
            if d >= PATH_MAX:
                continue
            for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                if (nx, ny) in prev or not self.dry_at(nx, ny, level):
                    continue
                if (nx, ny) in self.occupied or ((nx, ny) in self.doorsteps and (nx, ny) not in avoid):
                    continue
                prev[(nx, ny)] = (cx, cy)
                q.append(((nx, ny), d + 1))
        return None, None

    def _ground(self, h, rnd, level, report):
        x0, y0, x1, y1 = h["bbox"]
        sx, sy = h["step"]
        fx, fy = h["face"]
        box = (x0 - RING - 4, y0 - RING - 4, x1 + RING + 4, y1 + RING + 4)
        specks0 = self.natural_specks(box)
        saved = {(x, y): self.grd[y][x] for y in range(box[1], box[3] + 1)
                 for x in range(box[0], box[2] + 1) if 0 <= x < self.N and 0 <= y < self.N}
        for attempt in range(4):
            mat = self._material(h, rnd)
            style = _weighted(APRON, rnd)
            cells = set()
            if style == "step":
                cells = {(sx, sy), (sx + fy, sy + fx), (sx - fy, sy - fx)}
            elif style == "front":
                cells = set(self._front(h, level)) | {(sx, sy)}
            elif style == "ring":
                cells = set(self._ring(h, 1, level))
                if rnd() < 0.5:           # ragged: the corners go
                    cells -= {(x0 - 1, y0 - 1), (x1 + 1, y0 - 1), (x0 - 1, y1 + 1), (x1 + 1, y1 + 1)}
            elif style == "wide":
                cells = set(self._ring(h, 2, level))
            cells = {c for c in cells if self.dry_at(*c, level) and self.ground(*c) in PAVE_ON} | (
                {(sx, sy)} if self.dry_at(sx, sy, level) and self.ground(sx, sy) in PAVE_ON else set())
            # the path
            mine = {(sx, sy)} | h["cells"]
            path, road = self._road_path(h, level, avoid=mine | cells)
            walk = None
            if path is None and rnd() < WALK_WHEN_NO_ROAD:
                n = WALK_LEN[0] + int(rnd() * (WALK_LEN[1] - WALK_LEN[0] + 1))
                walk = []
                for i in range(1, n + 1):
                    c = (sx + fx * i, sy + fy * i)
                    if not self.dry_at(*c, level) or self.ground(*c) not in PAVE_ON or c in self.occupied:
                        break
                    walk.append(c)
                path = walk
            path = path or []
            wide = bool(road) and self.ground(*road) in PAVING and rnd() < 0.3
            pcells = set(path)
            if wide:
                for (x, y) in list(path):
                    c = (x + fy, y + fx)     # beside the walk, across the face
                    if self.dry_at(*c, level) and self.ground(*c) in PAVE_ON:
                        pcells.add(c)
            for (x, y) in cells | pcells:
                self.paint(x, y, mat)
            new = self.natural_specks(box) - specks0
            if not new:
                report["apron"] = f"{style or 'none'} in {mat.split('_')[0]}"
                report["path"] = (f"{len(pcells)} cells to the {'street' if road and self.ground(*road) in PAVING else 'road'} at {road}"
                                  if road else (f"a walk of {len(pcells)}" if pcells else "none"))
                self.path_cells = set(path) | pcells
                return
            for (x, y), v in saved.items():         # a speck: undo, draw again
                self.grd[y][x] = v
            self.painted -= set(saved)
        report["apron"] = "none (every draw left a speck)"
        report["path"] = "none"
        self.path_cells = set()

    def _garden(self, h, rnd, level, report):
        if rnd() >= GARDEN:
            report["garden"] = "none"
            return
        x0, y0, x1, y1 = h["bbox"]
        fx, fy = h["face"]
        ring_ground = h.get("ring_ground")
        soil = "dark_mud" if ring_ground == "grass" else ("grass" if ring_ground == "dark_mud" else None)
        if soil is None:
            report["garden"] = "none (no soil for one here)"
            return
        w, d = GARDEN_SIZE[int(rnd() * len(GARDEN_SIZE))]
        # beside the door's face, to its left or right, one cell off the wall
        sides = [1, -1] if rnd() < 0.5 else [-1, 1]
        box = None
        for side in sides:
            if fy:                       # door on a row: the plot lies along that row
                px0 = (x1 + 2) if side > 0 else (x0 - 1 - w)
                py0 = (y1 + 1) if fy > 0 else (y0 - d)
                cand = [(x, y) for x in range(px0, px0 + w) for y in range(py0, py0 + d)]
            else:
                py0 = (y1 + 2) if side > 0 else (y0 - 1 - d)
                px0 = (x1 + 1) if fx > 0 else (x0 - w)
                cand = [(x, y) for x in range(px0, px0 + w) for y in range(py0, py0 + d)]
            if all(self.dry_at(x, y, level) and self.ground(x, y) == ring_ground
                   and (x, y) not in self.occupied and (x, y) not in self.path_cells
                   and (x, y) not in self.doorsteps for x, y in cand):
                box = cand
                break
        if not box:
            report["garden"] = "none (no room beside the house)"
            return
        specks0 = self.natural_specks((x0 - 8, y0 - 8, x1 + 8, y1 + 8))
        for x, y in box:
            self.paint(x, y, soil)
        if self.natural_specks((x0 - 8, y0 - 8, x1 + 8, y1 + 8)) - specks0:
            for x, y in box:
                self.paint(x, y, ring_ground)
            report["garden"] = "none (it would leave a speck)"
            return
        n = _weighted(GARDEN_N, rnd)
        spots = list(box)
        placed = 0
        for _ in range(n * 4):
            if placed >= n or not spots:
                break
            group = _weighted(GARDEN_POOL, rnd)
            pool = self._pool(group)
            if not pool:
                continue
            piece = pool[int(rnd() * len(pool))]
            c = spots[int(rnd() * len(spots))]
            if self.place(piece, c[0] + 0.5, c[1] + 0.5, rnd, level):
                placed += 1
                spots.remove(c)
        report["garden"] = f"{w}x{d} of {soil} with {placed} piece(s)"

    def _yard(self, h, rnd, level, report):
        x0, y0, x1, y1 = h["bbox"]
        n = _weighted(YARD_N, rnd)
        spots = [c for c in self._ring(h, RING, level, grounds=None)
                 if c not in self.no_place and c not in self.doorsteps
                 and c not in self.occupied and c not in self.path_cells]
        # the sides and the front, nearest the house first, shuffled within
        spots.sort(key=lambda c: (max(x0 - c[0], c[0] - x1, y0 - c[1], c[1] - y1), rnd()))
        water_near = any(self.wet(x, y) for y in range(y0 - WATER_NEAR, y1 + WATER_NEAR + 1)
                         for x in range(x0 - WATER_NEAR, x1 + WATER_NEAR + 1)
                         if 0 <= x < self.N and 0 <= y < self.N)
        placed, tries = [], 0
        while len(placed) < n and tries < n * 6 and spots:
            tries += 1
            group = _weighted(YARD_POOL, rnd)
            if group == "fish_drying_racks" and not water_near:
                continue
            if group in [p.split("/")[0] for p in placed] and (group not in TWICE_OK or rnd() < 0.6):
                continue                 # two woodpiles happen; two wells do not
            pool = self._pool(group)
            if not pool:
                continue
            piece = pool[int(rnd() * len(pool))]
            for c in spots[:12]:
                if self.place(piece, c[0] + 0.5, c[1] + 0.5, rnd, level):
                    placed.append(piece)
                    spots.remove(c)
                    break
        report["yard"] = [p.split("/")[0] for p in placed]


def apply(world_dir, write=True):
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    before = len(doc["scenery"])
    Y = Yards(doc)
    for h in Y.houses:
        r = Y.dress(h)
        print(f"  house {r['house']} door {r['door']}: apron {r['apron']}; path {r.get('path')}; "
              f"garden {r['garden']}; yard {r['yard']}")
    print(f"{world_dir}: {len(Y.houses)} houses, {len(Y.painted)} cells painted, "
          f"{len(doc['scenery']) - before} pieces placed")
    if write:
        json.dump(doc, open(path, "w"), separators=(",", ":"))
    return Y


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("world_dir")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--apply", action="store_true")
    g.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    apply(a.world_dir, write=a.apply)


if __name__ == "__main__":
    main()
