"""A WALL HANGING IS NOT HUNG BEHIND THE FURNITURE.

Maintainer 2026-09-15, on a crest hung inside the chimney breast of the hearth
below it: *"It's a wall decoration you placed so it collides with the open fire
scenery. It looks really ugly."*

`_hang` already knows the rule — *"Not behind a dresser: the slot farthest from
the furniture already standing against that wall wins, and a wall with no clear
cell gets nothing (a cupboard is as tall as the hanging is high)"* — but it
judges the FOOTPRINT, and it ran before `indoorfire` put a hearth on the same
wall. A hearth is a metre of masonry with a breast that rises most of the wall,
so the hanging ended up inside it: measured on the_game, 22 hangings were
overlapped by a floor piece's drawn art, 9 of them by a fire this pass placed,
five of those completely.

THE TEST IS THE DRAWN ART, not the ground. Both rectangles are taken from the
same table the game draws from (`scenery-bbox.json` through `_art_rect`), the
hanging's lifted by its `z` at the GAME's 15 px storey — what he actually
looks at, not render3's 17.

THE FIRE WINS AND THE HANGING MOVES. A fire is what a room is built around; a
hanging is decoration, and its own rule already says a wall with no clear slot
gets nothing. So a covered hanging slides along its own wall to the nearest
clear slot, keeping its piece, state, facing and height, and is removed only
when the wall has nowhere left.

    python3 maps2/pipeline/hangfit.py --apply maps2/worlds3/the_game
"""
from __future__ import annotations

import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
sys.path.insert(0, _HERE)

GROUP = "wall_hangings"
LP = 15.0          # the GAME's storey in px — the height he sees
DX = 32.0          # one cell along a wall face
STEP = 0.125       # how finely a hanging is slid along its wall
COVER = 0.12       # more of the hanging than this behind something = move it
CLEAR = 2.0        # px of overlap that count at all


def _grow(doc):
    import world3grow as W
    g = W.Grow.__new__(W.Grow)
    g.doc, g.lvl = doc, doc["level"]
    return g


def rect(g, p):
    """the piece's drawn rectangle in screen px, `z` lifted at the game's storey"""
    r = g._art_rect(p["piece"], p["x"], p["y"], p.get("state"))
    if r is None:
        return None
    z = p.get("z") or 0
    return (r[0], r[1] - z * LP, r[2], r[3] - z * LP)


def cover(a, b):
    """how much of rect `a` rect `b` hides, 0..1"""
    if not a or not b:
        return 0.0
    ox = min(a[2], b[2]) - max(a[0], b[0])
    oy = min(a[3], b[3]) - max(a[1], b[1])
    if ox <= CLEAR or oy <= CLEAR:
        return 0.0
    return ox * oy / max(1.0, (a[2] - a[0]) * (a[3] - a[1]))


def face_of(p, cells):
    """("north", x0) or ("west", y0) — which wall this hanging hangs on, read
    the way `_hang` writes it: the anchor sits a thousandth INTO the room off
    the wall's own line."""
    x0 = min(x for x, _ in cells)
    y0 = min(y for _, y in cells)
    if abs(p["y"] - (y0 + 0.001)) < 1e-6:
        return "north"
    if abs(p["x"] - (x0 + 0.001)) < 1e-6:
        return "west"
    return None


def apply(world_dir, write=True):
    """Slide every hanging that is hidden behind furniture, and drop the ones
    with nowhere left on their wall."""
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    g = _grow(doc)
    moved, dropped, kept = [], [], 0
    for room in doc.get("rooms", []):
        cells = {(c["x"], c["y"]) for c in room.get("cells", [])}
        if not cells:
            continue
        x0, x1 = min(x for x, _ in cells), max(x for x, _ in cells)
        y0, y1 = min(y for _, y in cells), max(y for _, y in cells)
        inside = [p for p in doc["scenery"] if (int(p["x"]), int(p["y"])) in cells]
        floor = [p for p in inside if p.get("z") is None]
        hangs = [p for p in inside if p.get("piece", "").split("/")[0] == GROUP]
        for h in sorted(hangs, key=lambda q: q["x"] + q["y"]):
            others = [q for q in hangs if q is not h]

            def worst(at):
                probe = dict(h)
                probe["x"], probe["y"] = at
                r = rect(g, probe)
                return max([cover(r, rect(g, q)) for q in floor + others] or [0.0])

            here = worst((h["x"], h["y"]))
            if here <= COVER:
                kept += 1
                continue
            face = face_of(h, cells)
            if not face:
                dropped.append((h, here, "not on a wall this pass understands"))
                continue
            art = g._art_rect(h["piece"], 0, 0, h.get("state"))
            half = ((art[2] - art[0]) / 2.0 / DX) if art else 0.5

            def slide(on):
                """the nearest clear slot along `on`, or None. A room shows two
                walls, so a hanging whose own wall is full is offered the
                other one before it is given up — `_hang` deals them across
                both anyway."""
                lo, hi = ((x0 + half, x1 + 1 - half) if on == "north"
                          else (y0 + half, y1 + 1 - half))
                if hi < lo:
                    return None
                start = (h["x"] if on == "north" else h["y"])
                start = min(max(start, lo), hi)
                t = 0.0
                while t <= (hi - lo):
                    for s in (1, -1):
                        v = start + s * t
                        if not (lo - 1e-9 <= v <= hi + 1e-9):
                            continue
                        at = ((round(v, 4), round(y0 + 0.001, 4)) if on == "north"
                              else (round(x0 + 0.001, 4), round(v, 4)))
                        if worst(at) <= COVER:
                            return at
                    t += STEP
                return None

            other = "west" if face == "north" else "north"
            best, on = slide(face), face
            if not best:
                best, on = slide(other), other
            if best:
                was = (h["x"], h["y"])
                h["x"], h["y"] = best
                if on != face:
                    h["dir"] = "south-west" if on == "north" else "south-east"
                moved.append((h, was, here))
            else:
                dropped.append((h, here, "no clear slot on either wall"))
    for (h, _c, _why) in dropped:
        doc["scenery"].remove(h)
    doc["scenery"].sort(key=lambda q: q["x"] + q["y"])
    print(f"{world_dir}: {kept} hanging(s) already clear, {len(moved)} slid along "
          f"their wall, {len(dropped)} removed")
    for (h, was, c) in moved:
        d = abs(h["x"] - was[0]) + abs(h["y"] - was[1])
        print(f"   {h['piece'].split('/')[1]:18s} {was} -> ({h['x']},{h['y']})"
              f"  {d:.2f} cells   (was {round(c*100)}% hidden)")
    for (h, c, why) in dropped:
        print(f"   REMOVED {h['piece'].split('/')[1]:18s} at {h['x']},{h['y']}"
              f"  ({round(c*100)}% hidden): {why}")
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
