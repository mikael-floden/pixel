"""A RUG NEVER TOUCHES A WALL.

Maintainer 2026-09-18, standing on the bear rug of the village house at
308.0,228.7 with its top corner drawn over the cut-away wall beside it: *"Why
did you place the carpet so it intersects the wall! The carpet should never
intersect any wall! It's ok to place it under a furniture like a table etc,
but it should not touch the wall!"*

THE TEST IS THE DRAWN ART AGAINST THE DRAWN WALL. A rug is FLAT (`collision`
false) so it stamps no footprint and the footprint law never looked at it; it
was laid at a cell centre near the room's middle and its ART — anchored
bottom-centre at the cell like every piece, so it lies UP-SCREEN of its anchor
by its whole drawn height, 58 px for that bear (`drawn_px_for_piece`: the
game re-bases the contract's 43 to its own person) — reached the wall two cells
away. What the player sees of a wall indoors is the cut-away: the cell's
ground diamond, its top diamond one storey up (INDOOR_WALL_DEFAULT = 1 level,
15 px in the game) and the face between — one convex hexagon per wall cell.
A rug is clear when its rectangle (`_art_rect`, the game's size) meets no
hexagon of any RAISED cell and lies over floor cells of its own room only.
Under a table or a chair is fine (his words): the scene draws a flat piece
under everything that stands on it.

THE RUG MOVES, THE ROOM DOES NOT. A rug that touches a wall slides to the
nearest clear spot on a quarter-cell lattice of its room, nearest its old
place first (the middle stays the weight the generator drew it with); a room
with no clear spot loses its rug. Same piece, same state. `_lay_rug` in the
generator asks the same test before it lays one, so a rebuild never places
what this pass would move.

    python3 maps2/pipeline/rugfit.py --check maps2/worlds3/the_game
    python3 maps2/pipeline/rugfit.py --apply maps2/worlds3/the_game
"""
from __future__ import annotations

import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

GROUP = "rugs_and_hides"
DX, DY = 32.0, 14.0     # the game's cell on screen (a diamond 64 wide, 28 tall)
LP = 15.0               # the GAME's storey in px
WALL_UP = 1             # INDOOR_WALL_DEFAULT: the cut-away wall stands one storey
CLEAR = 1.0             # px: touching counts
OFFSETS = (0.5, 0.25, 0.75)     # the quarter-cell lattice, centre first


def _grow(doc):
    import world3grow as W
    g = W.Grow.__new__(W.Grow)
    g.doc, g.lvl = doc, doc["level"]
    return g


def rect(g, piece, x, y, state=None):
    return g._art_rect(piece, x, y, state)


def hexagon(cx, cy, up=WALL_UP * LP):
    """The drawn wall cell as one convex polygon: its ground diamond swept up
    to its cut-away top. Screen px, y down."""
    return [(cx - DX, cy), (cx, cy + DY), (cx + DX, cy), (cx + DX, cy - up),
            (cx, cy - DY - up), (cx - DX, cy - up)]


def diamond(cx, cy):
    return [(cx - DX, cy), (cx, cy + DY), (cx + DX, cy), (cx, cy - DY)]


def _proj(poly, ax, ay):
    vs = [px * ax + py * ay for px, py in poly]
    return min(vs), max(vs)


def overlap(rect_, poly, clear=CLEAR):
    """Rect (x0,y0,x1,y1) meets convex polygon: separating axes of both,
    with `clear` px of slack that count as touching."""
    r = [(rect_[0], rect_[1]), (rect_[2], rect_[1]), (rect_[2], rect_[3]), (rect_[0], rect_[3])]
    axes = [(1.0, 0.0), (0.0, 1.0)]
    n = len(poly)
    for i in range(n):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % n]
        ex, ey = bx - ax, by - ay
        L = (ex * ex + ey * ey) ** 0.5 or 1.0
        axes.append((-ey / L, ex / L))
    for ax, ay in axes:
        a0, a1 = _proj(r, ax, ay)
        b0, b1 = _proj(poly, ax, ay)
        if a1 <= b0 + clear or b1 <= a0 + clear:
            return False
    return True


def cell_screen(cx, cy, level):
    """The centre of the cell's top face on screen, at its own level."""
    return ((cx + 0.5) - (cy + 0.5)) * DX, ((cx + 0.5) + (cy + 0.5)) * DY - level * LP


def clear(g, piece, x, y, floor, state=None):
    """Is a rug of `piece` anchored at (x, y) clear of every wall of the room
    whose floor cells are `floor`, and over that floor only?"""
    r = rect(g, piece, x, y, state)
    if r is None:
        return True                         # no art record: nothing to judge
    cx0, cy0 = int(x), int(y)
    if (cx0, cy0) not in floor:
        return False
    lvl = g.lvl
    base = lvl[cy0][cx0]
    # the rug is three cells tall up-screen and two wide: look one further
    for cy in range(cy0 - 4, cy0 + 3):
        for cx in range(cx0 - 4, cx0 + 3):
            if not (0 <= cy < len(lvl) and 0 <= cx < len(lvl[0])):
                continue
            l = lvl[cy][cx]
            sx, sy = cell_screen(cx, cy, base)
            if (cx, cy) in floor and l == base:
                continue
            if l > base and overlap(r, hexagon(sx, sy)):
                return False                # a wall, drawn
            if overlap(r, diamond(sx, sy)):
                return False                # off the room's own floor
    return True


def spots(floor, near=None):
    """The room's quarter-cell lattice, nearest `near` first (or the floor's
    centroid when no `near`): where a rug may be tried."""
    cs = sorted(floor)
    if near is None:
        near = (sum(c[0] + 0.5 for c in cs) / len(cs), sum(c[1] + 0.5 for c in cs) / len(cs))
    out = []
    for (cx, cy) in cs:
        for ox in OFFSETS:
            for oy in OFFSETS:
                x, y = cx + ox, cy + oy
                out.append(((x - near[0]) ** 2 + (y - near[1]) ** 2, x, y))
    out.sort()
    return [(x, y) for _, x, y in out]


def rooms_of(doc):
    return [{(c["x"], c["y"]) for c in r.get("cells", [])} for r in doc.get("rooms", [])]


def _room_for(rooms, x, y):
    c = (int(x), int(y))
    for cells in rooms:
        if c in cells:
            return cells
    return None


def check(world_dir, doc=None, log=print):
    doc = doc or json.load(open(os.path.join(world_dir, "world.json")))
    g = _grow(doc)
    rooms = rooms_of(doc)
    bad = []
    for i, p in enumerate(doc["scenery"]):
        if not p["piece"].startswith(GROUP + "/"):
            continue
        floor = _room_for(rooms, p["x"], p["y"])
        if floor is None:
            continue                        # a hide outdoors is not a carpet in a room
        if not clear(g, p["piece"], p["x"], p["y"], floor, p.get("state")):
            bad.append((i, p))
            log(f"  TOUCHES A WALL .scenery[{i}] {p['piece']} {p.get('state') or ''} at ({p['x']}, {p['y']})")
    log(f"{world_dir}: {len(bad)} rug(s) touch a wall")
    return bad


def apply(world_dir, write=True):
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    g = _grow(doc)
    rooms = rooms_of(doc)
    moved, dropped, keep = [], [], []
    taken = {(round(p["x"], 2), round(p["y"], 2)) for p in doc["scenery"] if p["piece"].startswith(GROUP + "/")}
    for i, p in enumerate(doc["scenery"]):
        if not p["piece"].startswith(GROUP + "/"):
            keep.append(p)
            continue
        floor = _room_for(rooms, p["x"], p["y"])
        if floor is None or clear(g, p["piece"], p["x"], p["y"], floor, p.get("state")):
            keep.append(p)
            continue
        was = (p["x"], p["y"])
        for (x, y) in spots(floor, near=was):
            if (round(x, 2), round(y, 2)) in taken:
                continue
            if clear(g, p["piece"], x, y, floor, p.get("state")):
                q = dict(p)
                q["x"], q["y"] = round(x, 4), round(y, 4)
                keep.append(q)
                taken.add((round(x, 2), round(y, 2)))
                moved.append((p["piece"], was, (q["x"], q["y"])))
                print(f"  MOVED  {p['piece']} {p.get('state') or ''} ({was[0]}, {was[1]}) -> ({q['x']}, {q['y']})")
                break
        else:
            dropped.append((p["piece"], was))
            print(f"  DROPPED {p['piece']} at ({was[0]}, {was[1]}): no clear spot in its room")
    print(f"{world_dir}: {len(moved)} rug(s) moved, {len(dropped)} dropped, "
          f"{sum(1 for p in keep if p['piece'].startswith(GROUP + '/'))} rugs in place")
    if write and (moved or dropped):
        doc["scenery"] = keep
        assert not check(world_dir, doc, log=lambda *a: None)
        json.dump(doc, open(path, "w"), separators=(",", ":"))
    return moved, dropped


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("world_dir")
    gr = ap.add_mutually_exclusive_group(required=True)
    gr.add_argument("--check", action="store_true")
    gr.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.check:
        sys.exit(1 if check(a.world_dir) else 0)
    apply(a.world_dir, write=not a.dry_run)


if __name__ == "__main__":
    main()
