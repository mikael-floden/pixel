"""A FIRE IN MOST HOUSES, A LIGHT IN SOME, NOTHING IN A FEW.

Maintainer 2026-09-13, told that one room of thirteen had a fire: *"ONLY ONE
ROOM HAS FIRE?!?! WTF! I kinda want 70% to have a fire and 10% to at least
have a light. Only 20% should have no fire and no light. This is not a hard
rule but something to strive for."*

WHY ONE. `interiors()` does ask for a hearth in every room — `against("hearths",
north, len(north) // 2)` — but it asks LAST: the north wall is dressed with
cupboards first (one every three cells), and a hearth's footprint is 1.51 x 1.65
cells, so by the time it asks there is no clear stretch left and the footprint
law refuses it. 12 of 13 rooms lost their fire that way, silently, because a
refusal only increments a counter. The build fix is the ORDER — a room is built
around its fire — and this module is the rule both paths share.

THE DRAW IS PER ROOM AND DETERMINISTIC: 70% fire, 10% light, 20% bare
(`ROLE_FIRE`, `ROLE_LIGHT`). It is a weighted draw and not a quota, which is
what "strive for" means — and a room that draws a fire it cannot fit falls back
to a light, then to bare, so the shape of a small room is never fought.

A ROOM THAT ALREADY HAS ONE KEEPS IT. This runs on a world that ships, so it is
additive: it adds the hearth or the lantern a room is missing and never moves,
restyles or removes anything already placed.

THE LIGHT BUDGET IS THE ENGINE'S, NOT A PREFERENCE (8 per camera window,
`world3.SLOTS`): every new fire is placed and THEN lit, nearest the arrival
point first, only while the worst camera window still holds — the same
priority `lights()` uses. A hearth the budget cannot light is still a
fireplace, and still gets its chimney.

    python3 maps2/pipeline/indoorfire.py --apply maps2/worlds3/the_game
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import zlib

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
sys.path.insert(0, _HERE)

ROLE_FIRE = 0.70          # of rooms get an open fire...
ROLE_LIGHT = 0.10         # ...and a tenth at least a light; the rest are bare
# A HEARTH FIRST, THEN A BRAZIER: see apply().
FIRE_GROUPS = ("hearths", "braziers")
LIGHT_GROUP = "lantern_stands"


def role(room_key, fire=ROLE_FIRE, light=ROLE_LIGHT):
    """"fire" | "light" | "bare" for a room — a weighted draw on its own
    corner, so the same room draws the same role every run. crc32, never
    hash(): a salted seed re-rolls the world on every build."""
    u = (zlib.crc32(f"indoorfire|{room_key[0]}|{room_key[1]}".encode()) & 0xffffffff) / 2 ** 32
    return "fire" if u < fire else "light" if u < fire + light else "bare"


def _shell(doc, world_dir):
    """A world3grow.Grow bound to a shipped world — its footprint law, its
    pools and its ratings, with no build state behind them."""
    import navfit
    import world3grow as W
    bbox, hit = navfit.load_docs()
    g = W.Grow.__new__(W.Grow)
    g.doc, g.G = doc, doc["grounds"]
    g.gi = {n: i for i, n in enumerate(g.G)}
    g.grd, g.lvl = doc["ground"], doc["level"]
    g._bbox, g._hit, g._fp = bbox, hit, {}
    g.door_cells = navfit._thresholds(doc)
    g.cave_floor = navfit._cave_floor(doc)
    W.NEW = min(doc["size"]["w"], doc["size"]["h"])
    # every piece already placed claims its ground first
    for p in doc.get("scenery", []):
        if p.get("z") is not None or g._flat(p):
            continue
        sh = g._fp_shape(p)
        if sh:
            _k, dwx, dwy, hx, hy = sh
            g._fp_add(p["x"] + dwx, p["y"] + dwy, hx, hy if _k == "rect" else None)
        else:
            g._fp_add(int(p["x"]) + 0.5, int(p["y"]) + 0.5, g.FP_DEFAULT, None)
    return g


def _faced(piece, d, state=None):
    """The facing to place this piece in: `d` when the STATE it will wear
    publishes that rotation, else none at all.

    The manifest is the test, not the disk — `facedSprite(state, dir)` reads
    `state.rotations[dir]` and falls back to south, so a placement naming a
    facing the state does not publish draws its south still anyway while
    render3 and the footprint lookup ask for a box that was never measured.
    (A brazier publishes its rotations per STATE and nothing at the piece
    root, so the piece-root map is not the answer either.)"""
    rec = (_meta(piece).get("states") or {}).get(state) or {}
    rots = rec.get("rotations") or _meta(piece).get("rotations") or {}
    return d if rots.get(d) else None


def _meta(piece, cache={}):
    if piece not in cache:
        cache[piece] = json.load(open(os.path.join(
            REPO, "scenery", piece, "scenery.json")))
    return cache[piece]


def _pool(g, group, key):
    """The group's pieces he has not rejected, ROTATED so this room starts at
    its own one — so two rooms rarely wear the same hearth, and a room whose
    first choice does not fit tries the rest instead of going without. The
    pieces are not interchangeable in size: the seven hearths run 1.2 to 1.7
    cells along a wall, and a room that is full for one has room for
    another."""
    pool = [q for q in g.pool(group) if g._rated(q)[0]]
    if not pool:
        return []
    r = zlib.crc32(f"{group}|{key[0]}|{key[1]}".encode()) & 0xffffffff
    i = r % len(pool)
    return pool[i:] + pool[:i]


def _state(g, piece, key, lit):
    """The variation this placement wears: a LIT one when it is a light,
    else a NOT_LIT one. His rejections are skipped."""
    meta = json.load(open(os.path.join(REPO, "scenery", piece, "scenery.json")))
    want = "LIT" if lit else "NOT_LIT"
    st = sorted(k for k in (meta.get("states") or {})
                if k.startswith(want) and g._rated(piece, k)[0])
    if not st:
        return None
    r = zlib.crc32(f"state|{piece}|{key[0]}|{key[1]}".encode()) & 0xffffffff
    return st[r % len(st)]


def _walls(cells):
    """This room's BACK walls as runs of floor cells, longest first:
    `("north", y, [x...])` for a run whose north neighbour is outside the
    room, `("west", x, [y...])` for one whose west neighbour is.

    `interiors().against()` takes the bounding box's own min-x column and
    min-y row, which IS the back wall of a rectangle and is wrong for anything
    else: the_game's room 10 is an L of 54 cells whose bbox top row is ONE
    cell, so the pass had exactly one 4-cell wall to try and left the room
    bare. A wall face is a local fact — the cell north of me is not in this
    room — and reading it that way finds every wall a rectangle has plus the
    ones an L has."""
    runs = []
    for side in ("north", "west"):
        by = {}
        for (x, y) in cells:
            nb = (x, y - 1) if side == "north" else (x - 1, y)
            if nb in cells:
                continue
            by.setdefault(y if side == "north" else x, []).append(
                x if side == "north" else y)
        for k, vs in by.items():
            vs.sort()
            run = [vs[0]]
            for v in vs[1:]:
                if v == run[-1] + 1:
                    run.append(v)
                else:
                    runs.append((side, k, run))
                    run = [v]
            runs.append((side, k, run))
    # THE LONGEST WALL FIRST — a fire belongs on the room's main wall, and a
    # 2-cell stub is a doorway's shoulder. Ties break on the wall's own
    # position so the choice is the same every run.
    runs.sort(key=lambda r: (-len(r[2]), r[0], r[1], r[2][0]))
    return [r for r in runs if len(r[2]) > 2]


def _against(g, room, group, piece_key, lit):
    """Put one piece of `group` flush against one of this room's back walls,
    sliding along it — `interiors().against()`'s arithmetic, which is the
    measured rule: a west wall faces south-east, a north wall south-west, the
    footprint's near edge exactly ON the wall face.

    Returns the placement dict, or None when no wall can take it."""
    cells = {(c["x"], c["y"]) for c in room.get("cells", [])}
    if not cells:
        return None
    ground = room.get("ground") or "parquet_floor"
    for (side, wk, run) in _walls(cells):
        along_y = side == "west"
        d = "south-east" if along_y else "south-west"
        for piece in _pool(g, group, piece_key):
            state = _state(g, piece, piece_key, lit)
            pd = _faced(piece, d, state)
            probe = {"piece": piece, "x": 0, "y": 0, "state": state}
            if pd:
                probe["dir"] = pd
            sh = g._fp_shape(probe)
            if not sh:
                continue
            _kind, cx, cy, hx, hy = sh
            deep = hx if along_y else hy
            span = hy if along_y else hx
            lo, hi = run[0] + span, run[-1] + 1 - span
            if lo > hi:
                continue                  # too long for this wall
            want = run[len(run) // 2] + 0.5
            first = min(max(want, lo), hi)
            cands, t = [first], 0.5
            while t <= hi - lo:
                for sgn in (1, -1):
                    v = first + sgn * t
                    if lo - 1e-9 <= v <= hi + 1e-9:
                        cands.append(v)
                t += 0.5
            for v in cands:
                if along_y:
                    x, y = wk + deep - cx, v - cy
                else:
                    x, y = v - cx, wk + deep - cy
                x, y = round(x, 4), round(y, 4)
                if (int(x), int(y)) not in cells:
                    continue              # it must stand on this room's floor
                if g.g(int(x), int(y)) != ground:
                    continue
                if (int(x), int(y)) in g.door_cells:
                    continue
                if not g._art_clear(piece, x, y, state):
                    continue
                wx, wy = x + cx, y + cy
                R, HY = (hx, hy) if _kind == "rect" else (hx, None)
                if not g._footprint_ok(wx, wy, R, HY, flush=True, flat=False):
                    continue
                g._fp_add(wx, wy, R, HY)
                p = {"piece": piece, "x": x, "y": y}
                if pd:
                    p["dir"] = pd
                if state:
                    p["state"] = state
                return p
    return None


def has_fire(doc, cells):
    import chimneys
    return any(p.get("piece", "").split("/")[0] in chimneys.FIRE_GROUPS
               and (int(p["x"]), int(p["y"])) in cells and p.get("z") is None
               for p in doc.get("scenery", []))


def has_light(doc, cells):
    import world3
    return any(world3.is_lit(p) and (int(p["x"]), int(p["y"])) in cells
               for p in doc.get("scenery", []))


def apply(world_dir, write=True):
    """Give the shipped world's rooms their fires. ADDITIVE ONLY."""
    import world3
    import world3grow as W
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    g = _shell(doc, world_dir)
    rooms = doc.get("rooms", [])
    before = len(doc.get("scenery", []))
    added, tally = [], {"hearths": 0, "braziers": 0, "lanterns": 0,
                        "kept": 0, "refused": 0}
    for room in rooms:
        cells = {(c["x"], c["y"]) for c in room.get("cells", [])}
        if not cells:
            continue
        key = (min(x for x, _ in cells), min(y for _, y in cells))
        if has_fire(doc, cells):
            tally["kept"] += 1
            continue
        want = role(key)
        p = None
        if want == "fire":
            # A HEARTH FIRST, A BRAZIER WHEN THE ROOM IS FULL. A hearth is a
            # metre and a half of masonry along a wall and a dressed room may
            # have no such stretch left; a brazier is a fire basket of half a
            # cell, the same open fire (it takes its own chimney), and it is
            # what keeps a crowded room from going cold.
            for group in FIRE_GROUPS:
                p = _against(g, room, group, key, lit=False)
                if p:
                    tally[group if group in tally else "hearths"] += 1
                    break
            if not p:
                want = "light"            # a room that cannot fit one is lit
                tally["refused"] += 1
        if p is None and want == "light" and not has_light(doc, cells):
            # placed UNLIT: the budget pass below decides, with the fires
            p = _against(g, room, LIGHT_GROUP, key, lit=False)
            if p:
                tally["lanterns"] += 1
            else:
                tally["refused"] += 1
        if p:
            added.append(p)
    doc["scenery"] = sorted(doc.get("scenery", []) + added,
                            key=lambda q: q["x"] + q["y"])

    # EVERY NEW FIRE IS LIT WHILE THE ENGINE HAS SLOTS, nearest the arrival
    # point first. THE TEST IS `lights()`'s, to the line: the budget is per
    # CAMERA WINDOW, so what a new light must not do is push a window IT IS IN
    # over 8 (`max_overlap(..., only=box)`) - a global worst is the wrong
    # question and answers "no" to every indoor fire in this world, whose
    # streetlamp windows already sit at 8 of 8. And no light stands inside
    # another's core, per SPACE: a wall is between a hearth and the lamp in
    # the street outside it, so the street does not crowd the room.
    sx, sy = doc["spawn"]
    extra = [(sx + 0.5, sy + 0.5, W.Grow.BONFIRE_R)]
    boxes = world3.light_boxes(doc["scenery"], extra)
    indoor = {(c["x"], c["y"]) for r in rooms for c in r.get("cells", [])}

    def space(x, y):
        c = (int(x), int(y))
        return ("in" if c in indoor
                else "cave" if c in g.cave_floor else "out")

    lit_pts = [(sx + 0.5, sy + 0.5, W.Grow.BONFIRE_R, "out")]
    for q in doc["scenery"]:
        if world3.is_lit(q):
            lit_pts.append((q["x"], q["y"],
                            world3.light_meta(q["piece"], q.get("state"))[0],
                            space(q["x"], q["y"])))
    lit, refused = 0, {"no LIT state": 0, "another light's core": 0, "budget": 0}
    for p in sorted(added, key=lambda q: (q["x"] - sx) ** 2 + (q["y"] - sy) ** 2):
        st = _state(g, p["piece"], (int(p["x"]), int(p["y"])), lit=True)
        if not st:
            refused["no LIT state"] += 1
            continue
        r = world3.light_meta(p["piece"], st)[0]
        sp = space(p["x"], p["y"])
        if any(sp == lsp and math.hypot(p["x"] - lx, p["y"] - ly)
               < W.Grow.MIN_CORE * max(r, lr)
               for (lx, ly, lr, lsp) in lit_pts):
            refused["another light's core"] += 1
            continue
        was, pd = p.get("state"), _faced(p["piece"], p.get("dir"), st)
        p["state"], p["lit"] = st, True
        box = world3.light_boxes([p])[0]
        n, _w = world3.max_overlap(boxes + [box], only=box)
        if n > world3.SLOTS:
            p["state"], refused["budget"] = was, refused["budget"] + 1
            del p["lit"]
            continue
        # THE FACING FOLLOWS THE STATE: every state publishes its own
        # rotations map and a LIT one may publish fewer than the NOT_LIT the
        # placement was measured on.
        if p.get("dir") and not pd:
            del p["dir"]
        boxes.append(box)
        lit_pts.append((p["x"], p["y"], r, sp))
        lit += 1
    for p in list(added):                 # a lantern nobody lit is not a light
        if p["piece"].split("/")[0] == LIGHT_GROUP and not p.get("lit"):
            doc["scenery"].remove(p)
            added.remove(p)
            tally["lanterns"] -= 1
            tally["refused"] += 1
    nlit, worst = world3._light_audit(doc["scenery"], extra)

    def cells_of(r):
        return {(c["x"], c["y"]) for c in r.get("cells", [])}
    with_fire = sum(1 for r in rooms if has_fire(doc, cells_of(r)))
    with_light = sum(1 for r in rooms if not has_fire(doc, cells_of(r))
                     and has_light(doc, cells_of(r)))
    n = len(rooms) or 1
    print(f"{world_dir}: {len(rooms)} rooms -> {with_fire} with a fire "
          f"({100 * with_fire // n}%), {with_light} with a light only "
          f"({100 * with_light // n}%), {n - with_fire - with_light} bare "
          f"({100 * (n - with_fire - with_light) // n}%); "
          f"{len(added)} pieces added ({tally}), {lit} of them lit "
          f"({ {k: v for k, v in refused.items() if v} }); world lights "
          f"{nlit}, worst camera window {worst}/{world3.SLOTS}; scenery "
          f"{before} -> {len(doc['scenery'])}")
    for p in added:
        print(f"   {p['piece']} {p.get('state')} at {p['x']},{p['y']} "
              f"{p.get('dir') or 'south'}{' LIT' if p.get('lit') else ''}")
    if write and added:
        json.dump(doc, open(path, "w"), separators=(",", ":"))
    return len(added)


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
