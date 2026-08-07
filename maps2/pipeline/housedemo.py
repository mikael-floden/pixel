"""house_demo — buildings with real floor plans (maintainer 2026-08-06).

    "Lets get our map good looking again and move the new houses to a house-demo
     map instead. This time make the rooms bigger (what you did wasn't rooms).
     Also make the rooms more 'real house looking' and not all looking as if they
     was created by a python program."

Both notes were fair. The first pass put 3x2 closets in a row along the top of a
rectangle with a corridor under them — every house the same shape, every room the
same size, the seams of the loop that produced them showing through.

WHAT MAKES A PLAN LOOK DRAWN RATHER THAN GENERATED

  * ROOMS OF DIFFERENT SIZES AND SHAPES. A real house has one big room and
    several small ones, not N equal cells. Here the interior is split by
    recursive BINARY PARTITION: cut the space in two at a ratio drawn from
    SPLIT_LO..SPLIT_HI, alternating the cut axis against the region's aspect so
    long thin rooms don't accumulate, and stop when a piece is too small to cut
    again. Rooms come out 5x4 up to 11x8 in the same building, which is the
    look — nobody plans a house on a grid.
  * A HALL YOU ENTER INTO, not a corridor stapled to one edge. The front door
    opens into a hall, and rooms open off the hall or off each other.
  * DOORS WHERE A DOOR WOULD GO. Every internal doorway is cut at a random
    position along the shared wall rather than always at its midpoint, and never
    in a corner where it would be unreachable.
  * FOOTPRINTS THAT DIFFER. Each house gets its own dimensions and its own
    materials for walls, roof and every room floor.

Everything is seeded, so the map is identical on every run.

    python maps2/pipeline/housedemo.py
    python maps2/pipeline/build.py house_demo
"""

from __future__ import annotations

import json
import os
import random
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import worldio                                     # noqa: E402
from render2 import render_overview, save_minimap  # noqa: E402
from tiles2lib import Tiles2                       # noqa: E402

MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)

SEED = 20260806
GROUND = "saturated_grass"          # the lawn the street runs over
STREET = "lightdark_dirt"
WALL_H = 6                          # 6*16 = 96px of door clearance
MIN_ROOM = (5, 4)                   # NO ROOM SMALLER THAN THIS (w, h) interior —
                                    # the previous 3x2 was a cupboard
SPLIT_LO, SPLIT_HI = 0.36, 0.64     # where a partition cut may fall
CUT_BIAS = 1.35                     # cut across the long axis when it is this
                                    # much longer, else pick freely — stops the
                                    # plan degenerating into stripes

# One entry per house: (rooms wanted, footprint w, h). Deliberately all
# different, because six identical rectangles is the tell.
HOUSES = (
    (2, 15, 12), (3, 20, 13), (4, 24, 15),
    (2, 17, 11), (3, 22, 12), (5, 26, 16),
)
WALL_MATS = ("stone_mountain", "black_mountain", "regular_snow",
             "crystal_ice", "light_sand", "lightdark_dirt")
ROOF_MATS = ("black_mountain", "stone_mountain", "crystal_ice",
             "regular_snow", "lightdark_dirt", "light_sand")
FLOOR_MATS = ("lightdark_dirt", "light_sand", "stone_mountain",
              "black_mountain", "regular_snow", "crystal_ice", "saturated_grass")
BONFIRE = "tiles2/saturated_grass/base_x_3/base_x_3_1054990476/tile_12.webp"

MARGIN, GAP = 8, 7                  # world edge / between plots


class Rect:
    __slots__ = ("x", "y", "w", "h")

    def __init__(self, x, y, w, h):
        self.x, self.y, self.w, self.h = x, y, w, h

    @property
    def x1(self):
        return self.x + self.w - 1

    @property
    def y1(self):
        return self.y + self.h - 1

    def cells(self):
        return [(x, y) for y in range(self.y, self.y + self.h)
                for x in range(self.x, self.x + self.w)]

    def area(self):
        return self.w * self.h


def _splittable(r):
    """Can this region be cut and still leave two rooms of legal size? A cut
    consumes one cell for the dividing wall, hence the +1."""
    mw, mh = MIN_ROOM
    return (r.w >= mw * 2 + 1, r.h >= mh * 2 + 1)


def partition(r, want, rng):
    """Recursive binary partition into `want` rooms of UNEQUAL size.

    Always splits the biggest region that can still be split, so the result is a
    handful of differently-shaped rooms rather than a uniform grid. Returns the
    leaf rectangles (room interiors) and the wall segments between them."""
    leaves, walls = [r], []
    while len(leaves) < want:
        cand = [l for l in leaves if any(_splittable(l))]
        if not cand:
            break
        big = max(cand, key=lambda l: (l.area(), -l.x, -l.y))
        leaves.remove(big)
        vert, horiz = _splittable(big)
        if vert and horiz:
            # cut ACROSS the long axis, unless the region is roughly square, in
            # which case let the seed decide — that variety is the whole point
            if big.w > big.h * CUT_BIAS:
                axis = "v"
            elif big.h > big.w * CUT_BIAS:
                axis = "h"
            else:
                axis = rng.choice(("v", "h"))
        else:
            axis = "v" if vert else "h"
        mw, mh = MIN_ROOM
        if axis == "v":
            lo, hi = mw, big.w - mw - 1
            cut = rng.randint(max(lo, int(big.w * SPLIT_LO)),
                              min(hi, int(big.w * SPLIT_HI)) if
                              min(hi, int(big.w * SPLIT_HI)) >= max(lo, int(big.w * SPLIT_LO))
                              else hi)
            a = Rect(big.x, big.y, cut, big.h)
            b = Rect(big.x + cut + 1, big.y, big.w - cut - 1, big.h)
            walls.append([(big.x + cut, y) for y in range(big.y, big.y + big.h)])
        else:
            lo, hi = mh, big.h - mh - 1
            cut = rng.randint(max(lo, int(big.h * SPLIT_LO)),
                              min(hi, int(big.h * SPLIT_HI)) if
                              min(hi, int(big.h * SPLIT_HI)) >= max(lo, int(big.h * SPLIT_LO))
                              else hi)
            a = Rect(big.x, big.y, big.w, cut)
            b = Rect(big.x, big.y + cut + 1, big.w, big.h - cut - 1)
            walls.append([(x, big.y + cut) for x in range(big.x, big.x + big.w)])
        leaves += [a, b]
    return leaves, walls


def plan(ox, oy, rooms, W, H, rng):
    """One building: outer wall ring, a HALL along the front you enter into, and
    `rooms` partitioned rooms behind it. Returns everything named."""
    hall_h = rng.choice((3, 4))                       # deep enough to be a room
    inner = Rect(ox + 1, oy + 1, W - 2, H - 2)
    hall = Rect(inner.x, inner.y1 - hall_h + 1, inner.w, hall_h)
    body = Rect(inner.x, inner.y, inner.w, inner.h - hall_h - 1)
    hall_wall = [(x, hall.y - 1) for x in range(inner.x, inner.x + inner.w)]
    leaves, inner_walls = partition(body, rooms, rng)
    leaves.sort(key=lambda r: (r.x, r.y))
    wallset = {c for seg in inner_walls for c in seg} | set(hall_wall)
    # the outer ring
    ring = [(x, y) for y in range(oy, oy + H) for x in range(ox, ox + W)
            if x in (ox, ox + W - 1) or y in (oy, oy + H - 1)]
    return {"ox": ox, "oy": oy, "w": W, "h": H, "rooms": leaves, "hall": hall,
            "ring": ring, "inner_walls": wallset, "hall_wall": set(hall_wall)}


def doorways(p, rng):
    """Cut the doors. Every room reaches the hall — directly if they share a
    wall, otherwise through a neighbouring room — and the hall reaches the
    street. Doors sit at a RANDOM position along the shared wall, never in a
    corner, because a plan where every door is centred looks generated."""
    doors = set()
    rooms = p["rooms"]
    hall = p["hall"]

    def between(a, b):
        """The wall cells shared by two rectangles, minus their ends."""
        if a.y1 + 2 == b.y or b.y1 + 2 == a.y:            # stacked
            wy = (a.y1 + 1) if a.y1 + 2 == b.y else (b.y1 + 1)
            lo, hi = max(a.x, b.x), min(a.x1, b.x1)
            return [(x, wy) for x in range(lo + 1, hi)]
        if a.x1 + 2 == b.x or b.x1 + 2 == a.x:            # side by side
            wx = (a.x1 + 1) if a.x1 + 2 == b.x else (b.x1 + 1)
            lo, hi = max(a.y, b.y), min(a.y1, b.y1)
            return [(wx, y) for y in range(lo + 1, hi)]
        return []

    spaces = [("hall", hall)] + [(i, r) for i, r in enumerate(rooms)]
    linked = {"hall"}
    edges = []
    for i in range(len(spaces)):
        for j in range(i + 1, len(spaces)):
            seg = between(spaces[i][1], spaces[j][1])
            if seg:
                edges.append((spaces[i][0], spaces[j][0], seg))
    # connect every space, nearest-to-the-hall first (a spanning tree)
    progress = True
    while progress:
        progress = False
        for a, b, seg in edges:
            if (a in linked) != (b in linked):
                doors.add(rng.choice(seg))
                linked.add(a); linked.add(b)
                progress = True
    # a couple of extra internal doors so the plan is not a strict tree —
    # real houses have a room with two ways in
    extra = [e for e in edges if not any(c in doors for c in e[2])]
    rng.shuffle(extra)
    for a, b, seg in extra[:max(1, len(rooms) // 3)]:
        doors.add(rng.choice(seg))
    # the front door, in the middle third of the front wall
    fx = rng.randint(p["ox"] + p["w"] // 3, p["ox"] + 2 * p["w"] // 3)
    front = (fx, p["oy"] + p["h"] - 1)
    doors.add(front)
    return doors, front, linked


def house_plan(ox, oy, rooms, W, H, seed=SEED):
    """Reproduce ONE house's floor plan at (ox, oy), exactly as house_demo draws
    it for (rooms, W, H) under `seed`.

    Exported so another world can stamp a house the maintainer picked out of the
    demo without a second copy of the layout rules — islandworld2 calls this for
    the reference house. Note the demo's rng is one stream shared by all six
    houses, so a FRESH Random(seed) reproduces house 0; later houses would need
    the stream advanced to their position.

    Returns (plan, doors, front-door cell)."""
    rng = random.Random(seed)
    p = plan(ox, oy, rooms, W, H, rng)
    doors, front, _linked = doorways(p, rng)
    return p, doors, front


def stamp(p, doors, mat, level, hi=0):
    """Paint a planned house into (mat, level) grids: walls raised to WALL_H in
    that house's wall material, each room and the hall in its own floor
    material. Returns (walls, rooms, hall, footprint, wall material)."""
    walls = [c for c in (p["ring"] + sorted(p["inner_walls"])) if c not in doors]
    wm = WALL_MATS[hi % len(WALL_MATS)]
    for (wx, wy) in walls:
        mat[wy, wx] = wm
        level[wy, wx] = WALL_H
    for ri, r in enumerate(p["rooms"]):
        fm = FLOOR_MATS[(hi * 3 + ri + 1) % len(FLOOR_MATS)]
        for (fx, fy) in r.cells():
            mat[fy, fx] = fm
    hm = FLOOR_MATS[(hi * 3 + len(p["rooms"]) + 2) % len(FLOOR_MATS)]
    for (fx, fy) in p["hall"].cells():
        mat[fy, fx] = hm
    foot = [(fx, fy) for fy in range(p["oy"], p["oy"] + p["h"])
            for fx in range(p["ox"], p["ox"] + p["w"])]
    return walls, p["rooms"], p["hall"], foot, wm


def build(out=None):
    rng = random.Random(SEED)
    lib = Tiles2()
    plans = []
    x = MARGIN
    row_h = 0
    rows = []
    for rooms, W, H in HOUSES:            # lay the plots out in two streets
        if x + W > MARGIN + 60:
            rows.append((x, row_h)); x = MARGIN; row_h = 0
        plans.append((x, rooms, W, H))
        x += W + GAP
        row_h = max(row_h, H)
    # place: two rows, second below the first
    placed, cy, rowmax, cx = [], MARGIN, 0, MARGIN
    for rooms, W, H in HOUSES:
        if cx + W + MARGIN > 78:
            cx = MARGIN; cy += rowmax + GAP + 4; rowmax = 0
        placed.append((cx, cy, rooms, W, H))
        cx += W + GAP
        rowmax = max(rowmax, H)
    WW = max(px + pw for px, _, _, pw, _ in placed) + MARGIN
    HH = max(py + ph for _, py, _, _, ph in placed) + MARGIN + 6

    mat = np.full((HH, WW), GROUND, object)
    level = np.zeros((HH, WW), int)
    decks, props, houses = [], {}, []

    for hi, (ox, oy, rooms, W, H) in enumerate(placed):
        p = plan(ox, oy, rooms, W, H, rng)
        doors, front, _ = doorways(p, rng)
        walls = [c for c in (p["ring"] + sorted(p["inner_walls"])) if c not in doors]
        wm = WALL_MATS[hi % len(WALL_MATS)]
        for (wx, wy) in walls:
            mat[wy, wx] = wm
            level[wy, wx] = WALL_H
        for ri, r in enumerate(p["rooms"]):
            fm = FLOOR_MATS[(hi * 3 + ri + 1) % len(FLOOR_MATS)]
            for (fx, fy) in r.cells():
                mat[fy, fx] = fm
        hm = FLOOR_MATS[(hi * 3 + len(p["rooms"]) + 2) % len(FLOOR_MATS)]
        for (fx, fy) in p["hall"].cells():
            mat[fy, fx] = hm
        foot = [(fx, fy) for fy in range(oy, oy + H) for fx in range(ox, ox + W)]
        rm = ROOF_MATS[hi % len(ROOF_MATS)]
        decks.append({"kind": "roof", "mat": rm, "level": WALL_H, "thickness": 0,
                      "cells": [{"x": fx, "y": fy, "top": lib.plain_tile(rm),
                                 "mirror": 0} for (fx, fy) in foot]})
        houses.append({"i": hi, "plan": p, "doors": doors, "front": front,
                       "wall_mat": wm, "foot": foot})

    # a street along the front of each row so the houses read as a street
    for (ox, oy, rooms, W, H) in placed:
        for sx in range(max(0, ox - 2), min(WW, ox + W + 2)):
            sy = oy + H + 2
            if 0 <= sy < HH and level[sy, sx] == 0:
                mat[sy, sx] = STREET

    # BONFIRES — 50% of rooms and 50% of halls, every other one in order so the
    # split is exact. Placed in the room's own centre, which in a 5x4 or larger
    # room can never be the cell that seals a doorway.
    tile = os.path.join(REPO, BONFIRE)
    nr = nh = 0
    fires = []
    for h in houses:
        for r in h["plan"]["rooms"]:
            if nr % 2 == 0:
                fires.append((r.x + r.w // 2, r.y + r.h // 2))
            nr += 1
        if nh % 2 == 0:
            hl = h["plan"]["hall"]
            c = (hl.x + hl.w // 2, hl.y + hl.h // 2)
            if c[0] != h["front"][0]:
                fires.append(c)
            else:
                fires.append((c[0] + 1, c[1]))
        nh += 1
    for c in fires:
        props[c] = tile

    # EVERY ROOM MUST BE ENTERABLE. A generated plan that walls a room off is a
    # broken fixture, and the only way to know is to walk it: flood from outside
    # each front door under the game's own rule (4-neighbour, climb <= 1) with the
    # bonfires treated as solid, and require every room and hall cell to be hit.
    from collections import deque as _dq
    blocked = set(props)
    for h in houses:
        p2 = h["plan"]
        start = (h["front"][0], h["front"][1] + 1)
        seen, q = {start}, _dq([start])
        while q:
            cx2, cy2 = q.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx2 + dx, cy2 + dy
                if not (0 <= nx < WW and 0 <= ny < HH) or (nx, ny) in seen:
                    continue
                if (nx, ny) in blocked:
                    continue
                if abs(int(level[ny, nx]) - int(level[cy2, cx2])) > 1:
                    continue
                seen.add((nx, ny)); q.append((nx, ny))
        want = [c for r in p2["rooms"] for c in r.cells()] + p2["hall"].cells()
        missed = [c for c in want if c not in seen and c not in blocked]
        assert not missed, (f"house {h['i']}: {len(missed)} interior cell(s) "
                            f"unreachable from the front door, e.g. {missed[:4]}")
        for ri, r in enumerate(p2["rooms"]):
            assert r.w >= MIN_ROOM[0] and r.h >= MIN_ROOM[1], \
                f"house {h['i']} room {ri} is {r.w}x{r.h}, below the {MIN_ROOM} floor"

    spawn = (placed[0][0] + placed[0][3] // 2, placed[0][1] + placed[0][4] + 4)
    top = np.empty((HH, WW), object)
    for y in range(HH):
        for x in range(WW):
            top[y, x] = lib.plain_tile(str(mat[y, x]))
    out = out or os.path.join(MAPS2, "worlds", "house_demo")
    os.makedirs(out, exist_ok=True)
    worldio.save_world(os.path.join(out, "world.json"), name="house_demo",
                       mat=mat, top=top, level=level, spawn=spawn,
                       props=props, decks=decks)
    world = worldio.load_world(os.path.join(out, "world.json"))
    save_minimap(out, render_overview(world, scale=1.0, transparent=True))
    sizes = [f"{r.w}x{r.h}" for h in houses for r in h["plan"]["rooms"]]
    print(f"house_demo {WW}x{HH}: {len(houses)} houses, "
          f"{sum(len(h['plan']['rooms']) for h in houses)} rooms + {len(houses)} halls; "
          f"room sizes {min(sizes, key=lambda s: int(s.split('x')[0])*int(s.split('x')[1]))}"
          f"..{max(sizes, key=lambda s: int(s.split('x')[0])*int(s.split('x')[1]))}; "
          f"{len(fires)} bonfires; spawn {spawn}")
    return houses


if __name__ == "__main__":
    build()
