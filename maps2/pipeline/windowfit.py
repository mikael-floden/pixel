"""A WINDOW NEEDS A ROOM BEHIND IT.

Maintainer 2026-09-14, on a window at a house corner: *"You know the walls in
this game is 1 cell/tile wide right? So if you place a window too close to the
house edge there is no 'inside room' (the outer tile is just wall). I feel you
are very much on the edge with the window on this house."*

THE WALL IS ONE CELL THICK, SO THE CELL BEHIND THE WINDOW **IS** THE ROOM —
and at a corner it is the wall turning, not a room. `windows()` laid its slots
along the whole face, corner cells included, and a window is 30 to 52 px of a
32 px cell wide, so an edge slot always hangs part of its frame over the
corner: 28 of the_game's 40 windows did.

THE RULE: a face cell is BACKED when the cell directly behind it (north of a
south face, west of an east face) is inside the house at its FLOOR level. A
window may only stand where its whole drawn width sits over backed cells, so
the usable span is each run of backed cells shrunk by the art's half-width at
both ends. Nothing else about the placement changes — same face, same height,
same piece, same spacing rule.

    python3 maps2/pipeline/windowfit.py --apply maps2/worlds3/the_game
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
sys.path.insert(0, _HERE)

GROUP = "windows"
FACE_PX = 32.0        # one cell of a wall face is DX screen px wide
CLEAR = 8.0           # px of bare wall a window keeps from the door


def houses(doc):
    """Every roof deck, with the box, the floor level and the door — the same
    reading `windows()` builds from, so the two agree on what a house is."""
    out = []
    for dk in doc.get("decks", []):
        if dk.get("kind") != "roof":
            continue
        xs = [c["x"] for c in dk["cells"]]
        ys = [c["y"] for c in dk["cells"]]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        inner = [(x, y) for y in range(y0 + 1, y1) for x in range(x0 + 1, x1)]
        if not inner:
            continue
        base = min(doc["level"][y][x] for (x, y) in inner)
        ring = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)
                if x in (x0, x1) or y in (y0, y1)]
        doors = [c for c in ring if doc["level"][c[1]][c[0]] == base]
        out.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "base": base,
                    "door": doors[0] if doors else None})
    return out


def backed(doc, hs, face):
    """The cells of this face that have ROOM behind them, in face order.

    Behind is one cell INTO the house — the wall is a single cell thick — and
    a cell is the room when it is inside the deck's box at the house's floor
    level. A corner fails it twice over: the cell behind it is the other
    wall, raised."""
    lvl = doc["level"]
    ok = []
    if face == "south":
        y = hs["y1"]
        for x in range(hs["x0"], hs["x1"] + 1):
            b = (x, y - 1)
            ok.append(hs["x0"] < b[0] < hs["x1"] and hs["y0"] < b[1] < hs["y1"]
                      and lvl[b[1]][b[0]] == hs["base"])
    else:
        x = hs["x1"]
        for y in range(hs["y0"], hs["y1"] + 1):
            b = (x - 1, y)
            ok.append(hs["x0"] < b[0] < hs["x1"] and hs["y0"] < b[1] < hs["y1"]
                      and lvl[b[1]][b[0]] == hs["base"])
    return ok


def spans(doc, hs, face, half):
    """[(lo, hi)] in FACE COORDINATES (the face's own axis, in cells) where a
    window of half-width `half` may stand: every run of backed cells, shrunk
    by `half` at both ends, and cut 8 px clear of the door."""
    ok = backed(doc, hs, face)
    a0 = hs["x0"] if face == "south" else hs["y0"]
    runs, i = [], 0
    while i < len(ok):
        if not ok[i]:
            i += 1
            continue
        j = i
        while j + 1 < len(ok) and ok[j + 1]:
            j += 1
        runs.append((a0 + i, a0 + j + 1))          # [lo, hi) in cells
        i = j + 1
    out = []
    door = hs.get("door")
    for (lo, hi) in runs:
        segs = [(lo, hi)]
        if door:
            d = door[0] if face == "south" else door[1]
            on = (door[1] == hs["y1"]) if face == "south" else (door[0] == hs["x1"])
            if on and lo <= d < hi:
                segs = [(lo, d - CLEAR / FACE_PX), (d + 1 + CLEAR / FACE_PX, hi)]
        for (a, b) in segs:
            if b - a >= 2 * half:
                out.append((a + half, b - half))
    return out


def _art(piece, d, cache={}):
    """(w, h) in screen px as the game draws it — world3grow's own _wall_art,
    so the width a window is judged by is the width it is drawn at."""
    if (piece, d) not in cache:
        import world3grow as W
        g = cache.get("g")
        if g is None:
            g = cache["g"] = W.Grow.__new__(W.Grow)
        cache[(piece, d)] = W.Grow._wall_art(g, piece, d)
    return cache[(piece, d)]


def face_of(p, hs):
    """which face this window hangs on, or None if it is not this house's"""
    if p.get("dir") == "south-west" and int(p["y"]) == hs["y1"] + 1 \
            and hs["x0"] <= p["x"] <= hs["x1"] + 1:
        return "south"
    if p.get("dir") == "south-east" and int(p["x"]) == hs["x1"] + 1 \
            and hs["y0"] <= p["y"] <= hs["y1"] + 1:
        return "east"
    return None


def apply(world_dir, write=True):
    """Slide every window that overhangs the wall into the nearest place with
    a room behind it, and drop the ones with nowhere to go. ONLY the position
    along the face changes: the piece, the facing, the height and the house
    are all left as they were."""
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    hss = houses(doc)
    wins = [p for p in doc.get("scenery", [])
            if p.get("piece", "").split("/")[0] == GROUP]
    moved, kept, dropped, orphan = [], 0, [], []
    per_house = {id(h): [] for h in hss}
    for p in wins:
        hs = next((h for h in hss if face_of(p, h)), None)
        if not hs:
            orphan.append(p)
            continue
        per_house[id(hs)].append((p, face_of(p, hs)))
    for hs in hss:
        for (p, face) in sorted(per_house[id(hs)],
                                key=lambda t: t[0]["x"] + t[0]["y"]):
            half = _art(p["piece"], p["dir"])[0] / 2.0 / FACE_PX
            a = p["x"] if face == "south" else p["y"]
            segs = spans(doc, hs, face, half)
            if any(lo - 1e-9 <= a <= hi + 1e-9 for (lo, hi) in segs):
                kept += 1
                continue
            if not segs:
                dropped.append((p, face, "no run of wall with a room behind it"))
                continue
            # the nearest END of a legal run, rounded INWARDS: the world
            # stores 4 decimals, and rounding the other way puts the frame
            # back over the corner by a ten-thousandth of a cell — invisible,
            # and enough to fail the rule it was just moved to satisfy.
            best, inward = min(
                (min(abs(a - lo), abs(a - hi)),
                 (lo, math.ceil) if abs(a - lo) <= abs(a - hi) else (hi, math.floor))
                for (lo, hi) in segs)[1]
            best = inward(best * 10000) / 10000
            was = (p["x"], p["y"])
            if face == "south":
                p["x"] = best
            else:
                p["y"] = best
            moved.append((p, was, face, abs(best - a)))
    for (p, _f, _why) in dropped:
        doc["scenery"].remove(p)
    doc["scenery"].sort(key=lambda q: q["x"] + q["y"])
    # EVERY HOUSE STILL SHOWS A WINDOW — the build asserts it, and a fix that
    # blinds a house is not a fix.
    left = {}
    for p in doc["scenery"]:
        if p.get("piece", "").split("/")[0] != GROUP:
            continue
        for h in hss:
            if face_of(p, h):
                left[id(h)] = left.get(id(h), 0) + 1
    blind = [(h["x0"], h["y0"]) for h in hss if not left.get(id(h))]
    print(f"{world_dir}: {len(wins)} window(s) — {kept} already had a room "
          f"behind them, {len(moved)} slid along their wall, {len(dropped)} "
          f"removed, {len(orphan)} on no house; {len(hss)} houses, "
          f"{len(blind)} now blind")
    for (p, was, face, d) in moved:
        print(f"   {p['piece']} {face:5s} {was} -> ({p['x']},{p['y']})  {d:.2f} cells")
    for (p, face, why) in dropped:
        print(f"   REMOVED {p['piece']} {face} at {p['x']},{p['y']}: {why}")
    assert not blind, f"a house lost every window: {blind}"
    if write and (moved or dropped):
        json.dump(doc, open(path, "w"), separators=(",", ":"))
    return len(moved) + len(dropped)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--apply", metavar="WORLD_DIR")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.apply:
        apply(a.apply, write=not a.dry_run)
        return
    ap.print_help()


if __name__ == "__main__":
    main()
