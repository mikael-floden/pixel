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


def doors(cells, lvl):
    """A ROOM'S OPENINGS, and the floor cell in front of each: every room cell
    with a neighbour you can STEP to that is not this room's floor.

    A wall in this world is a raised column (a room floor at level 0 with its
    wall at level 6), so a neighbour within one level of the floor is not a
    wall — it is the next room, a passage, or the street. Both cells are
    returned: the opening and the cell you cross to reach it, because a
    footprint covering either one shuts the door."""
    out = set()
    for (x, y) in cells:
        for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if n in cells:
                continue
            if abs(lvl[n[1]][n[0]] - lvl[y][x]) <= 1:
                out.add((x, y))
                out.add(n)
    return out


def _walls(cells, lvl):
    """This room's BACK walls as runs of floor cells, longest first:
    `("north", y, [x...])` for a run with a WALL to its north, `("west", x,
    [y...])` for one with a wall to its west.

    Two things this has to get right, and the second was paid for.
    - `interiors().against()` takes the bounding box's own min-x column and
      min-y row, which IS the back wall of a rectangle and is wrong for
      anything else: the_game's room 10 is an L of 54 cells whose bbox top row
      is ONE cell, so the pass had one 4-cell wall to try and left the room
      bare. A wall face is a LOCAL fact, so it is read per cell.
    - **A DOORWAY IS NOT A WALL** (maintainer 2026-09-14, standing in room 9's
      only doorway looking at a fireplace: *"How did you reason when you
      placed the fire and chimney in front of the door to the room?"*). The
      first cut asked only whether the neighbour was in THIS room, which is
      equally true of a wall, of a passage and of the next room's floor — so
      the gap at (303,231) read as wall and the hearth went across it, sealing
      room 9. The test is the LEVEL: a wall is a raised column. An opening is
      not a wall cell, so the run breaks there and no piece can straddle it.
    """
    runs = []
    for side in ("north", "west"):
        by = {}
        for (x, y) in cells:
            nb = (x, y - 1) if side == "north" else (x - 1, y)
            if nb in cells or lvl[nb[1]][nb[0]] <= lvl[y][x]:
                continue              # my own floor, or a way out: not a wall
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
    import navfit
    cells = {(c["x"], c["y"]) for c in room.get("cells", [])}
    if not cells:
        return None
    ground = room.get("ground") or "parquet_floor"
    shut = doors(cells, g.lvl)
    for (side, wk, run) in _walls(cells, g.lvl):
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
                # AND IT MUST NOT SHUT A DOOR. The footprint law judges the
                # room's floor, not its ways out, and a hearth is wide enough
                # to reach past the end of its wall into the gap beside it:
                # measured in the game's OWN stamp (the cells it blocks), not
                # in the box, because that is what stops a body.
                probe2 = dict(probe, x=x, y=y)
                nav = navfit.nav_cells(
                    navfit.boxes_for(probe2, g._bbox, g._hit), x, y)
                if shut.intersection(nav):
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


def refit(world_dir, write=True):
    """MOVE A FIRE THAT SHUTS A DOOR, and its chimney with it.

    The rule changed under a world that already ships (a doorway is not a
    wall, `_walls`), so the world needs the same correction the rule now
    prevents: every fire whose footprint covers one of its room's openings is
    lifted and asked for again under the new rule, the chimney standing on its
    cell goes with it, and nothing else in the room is touched."""
    import chimneys
    import navfit
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    lvl = doc["level"]
    bbox, hit = navfit.load_docs()
    moved, stuck = [], []
    for room in doc.get("rooms", []):
        cells = {(c["x"], c["y"]) for c in room.get("cells", [])}
        if not cells:
            continue
        shut = doors(cells, lvl)
        for p in list(doc["scenery"]):
            if p.get("z") is not None:
                continue
            if p.get("piece", "").split("/")[0] not in FIRE_GROUPS:
                continue
            if (int(p["x"]), int(p["y"])) not in cells:
                continue
            nav = navfit.nav_cells(navfit.boxes_for(p, bbox, hit), p["x"], p["y"])
            if not shut.intersection(nav):
                continue
            cell = (int(p["x"]), int(p["y"]))
            stack = [q for q in doc["scenery"]
                     if q.get("piece", "").split("/")[0] == chimneys.GROUP
                     and (int(q["x"]), int(q["y"])) == cell]
            doc["scenery"].remove(p)
            for q in stack:
                doc["scenery"].remove(q)
            key = (min(x for x, _ in cells), min(y for _, y in cells))
            g = _shell(doc, world_dir)          # after the removal: its ground is free
            new = None
            for group in FIRE_GROUPS:
                new = _against(g, room, group, key, lit=bool(p.get("lit")))
                if new:
                    break
            if not new:
                doc["scenery"] += [p] + stack   # nowhere better: leave it be
                stuck.append((p["piece"], p["x"], p["y"]))
                continue
            if p.get("lit"):
                st = _state(g, new["piece"], (int(new["x"]), int(new["y"])), lit=True)
                if st:
                    new["state"], new["lit"] = st, True
            doc["scenery"].append(new)
            doc["scenery"].sort(key=lambda q: q["x"] + q["y"])
            moved.append((p["piece"], (p["x"], p["y"]), new["piece"],
                          (new["x"], new["y"]), sorted(shut.intersection(nav))))
    print(f"{world_dir}: {len(moved)} fire(s) moved off a doorway, {len(stuck)} "
          f"with nowhere to go")
    for (was, wxy, now, nxy, hit_cells) in moved:
        print(f"   {was} {wxy} -> {now} {nxy}   (it blocked {hit_cells})")
    for t in stuck:
        print(f"   STUCK {t}")
    if write and moved:
        json.dump(doc, open(path, "w"), separators=(",", ":"))
    return len(moved)


# WHAT GIVES UP ITS SLOT TO A FIRE, cheapest rank first. The generator's own
# `lights()` queues "the rest of the town's lamps" LAST of everything it
# lights, so a street lamp is the cheapest slot in the world — and his
# standing complaint about them is that they CLUSTER ("I have 3 very bright
# streetlights very very close together ... it's just very very bright
# here"), so the one that goes dark is the one with the most lit neighbours.
# Nothing of a dearer rank is touched while a cheaper one is still available
# at that window.
DIM_RANK = {"streetlights": 0, "lantern_posts": 0,
            "mushrooms": 1, "giant_mushrooms": 1, "toadstool_rings": 1,
            "crystals": 1, "crystal_trees": 1, "ancient_trees": 1,
            "soulstone_outcrops": 1, "rock_spires": 1, "chess_tables": 1,
            "charcoal_kilns": 1,
            "braziers": 2, "torch_posts": 2, "cauldron_camps": 2,
            "waystones": 3, "wayside_shrines": 3}
# NEVER put out: another indoor fire (that is the thing being lit) and the
# lighthouse BEACON, the one big far light and the only one on its headland.
# The game's own spawn bonfire is not a placement, so it cannot be touched.
DIM_NEVER = ("beacons",)


def relight(world_dir, share=0.8, write=True):
    """LIGHT MOST OF THE FIRES, AND TAKE THE SLOTS FROM THE LAMPS.

    Maintainer 2026-09-14, told 2 of 10 hearths burn: *"You made 80% not lit?
    I think that number should be flipped and 80% should have been lit."* The
    engine's 8 world lights per camera window is a hard ceiling, so this is
    not a number that can simply be asked for — it is a TRADE, and he has now
    made it: an indoor fire outranks the lamp in the street outside.

    WHY IT COSTS WHAT IT COSTS, and why a dimmer fire does not help: the
    budget is per CAMERA WINDOW, and a window is 899 x 774 px — about 28 x 26
    cells, which is bigger than the town. Every light within that of another
    shares its 8 slots whatever its radius, so capping a hearth's pool at 6
    cells instead of the published 16 saves 5 lamps of 12 and costs the fire
    its glow (measured). And lighting a fire SPENDS the slot it just freed, so
    three hearths in one saturated window cost three lamps however cleverly
    they are chosen.

    A lamp is not removed, it is put OUT: the post still stands in the street.
    """
    import world3
    import world3grow as W
    import navfit
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    g = _shell(doc, world_dir)
    rooms = {(c["x"], c["y"]) for r in doc.get("rooms", []) for c in r.get("cells", [])}
    cave = navfit._cave_floor(doc)
    sx, sy = doc["spawn"]
    extra = [(sx + 0.5, sy + 0.5, W.Grow.BONFIRE_R)]

    def space(x, y):
        c = (int(x), int(y))
        return "in" if c in rooms else "cave" if c in cave else "out"

    fires = [p for p in doc["scenery"] if p.get("z") is None
             and p.get("piece", "").split("/")[0] in FIRE_GROUPS
             and (int(p["x"]), int(p["y"])) in rooms]
    if not fires:
        print(f"{world_dir}: no indoor fires")
        return 0
    want = math.ceil(share * len(fires))
    was_lit = sum(1 for p in fires if p.get("lit"))

    def lit_pts():
        out = [(sx + 0.5, sy + 0.5, W.Grow.BONFIRE_R, "out")]
        for q in doc["scenery"]:
            if world3.is_lit(q):
                out.append((q["x"], q["y"],
                            world3.light_meta(q["piece"], q.get("state"))[0],
                            space(q["x"], q["y"])))
        return out

    def states_of(piece):
        """its LIT variations, DIMMEST FIRST — a smaller pool is a smaller
        box, so the quietest fire that still reads as a fire is the one that
        might fit without putting anything out."""
        meta = _meta(piece).get("states") or {}
        ks = [k for k in meta if k.startswith("LIT") and g._rated(piece, k)[0]]
        return sorted(ks, key=lambda k: (world3.light_meta(piece, k)[0], k))

    def fits(p):
        box = world3.light_boxes([p])[0]
        n, where = world3.max_overlap(
            world3.light_boxes(doc["scenery"], extra) + [box], only=box)
        return n <= world3.SLOTS, where

    def crowded(p, r):
        sp = space(p["x"], p["y"])
        return any(sp == lsp and math.hypot(p["x"] - lx, p["y"] - ly)
                   < W.Grow.MIN_CORE * max(r, lr)
                   for (lx, ly, lr, lsp) in lit_pts()
                   if (lx, ly) != (p["x"], p["y"]))

    def blockers(where):
        """the lit placements whose own box covers that point"""
        out = []
        for q in doc["scenery"]:
            if not world3.is_lit(q):
                continue
            b = world3.light_boxes([q])[0]
            if b[0] <= where[0] <= b[1] and b[2] <= where[1] <= b[3]:
                out.append(q)
        return out

    def dim_order(cands, fire, rest):
        """Which light gives up its slot: cheapest RANK first, then the one in
        the way of the most fires still dark, then the most redundant, then
        the farthest from this fire. Do not expect the second key to save many
        lamps — lighting a fire spends the slot it freed — but it cannot cost
        anything and it breaks the tie the right way."""
        pts = lit_pts()
        boxes = {id(q): world3.light_boxes([q])[0] for q in cands}
        want_boxes = [world3.light_boxes([dict(f, lit=True,
                                               state=states_of(f["piece"])[0])])[0]
                      for f in rest if states_of(f["piece"])]

        def key(q):
            b = boxes[id(q)]
            helps = sum(1 for w in want_boxes
                        if not (b[1] < w[0] or w[1] < b[0]
                                or b[3] < w[2] or w[3] < b[2]))
            near = sum(1 for (lx, ly, _r, _s) in pts
                       if (lx, ly) != (q["x"], q["y"])
                       and math.hypot(q["x"] - lx, q["y"] - ly) < 14)
            return (DIM_RANK.get(q["piece"].split("/")[0], 9), -helps, -near,
                    -math.hypot(q["x"] - fire["x"], q["y"] - fire["y"]))
        return sorted(cands, key=key)

    dark = [p for p in fires if not p.get("lit")]

    def light(fire, rest):
        """Light this one, putting lights out until it fits. Returns the
        placements dimmed, or None — and on None nothing is changed."""
        for st in states_of(fire["piece"]):
            r = world3.light_meta(fire["piece"], st)[0]
            was = fire.get("state")
            fire["state"], fire["lit"] = st, True
            if crowded(fire, r):
                fire["state"] = was
                del fire["lit"]
                continue
            ok, where = fits(fire)
            undo = []
            while not ok:
                cands = [q for q in blockers(where)
                         if q is not fire
                         and q["piece"].split("/")[0] not in DIM_NEVER
                         and not ((int(q["x"]), int(q["y"])) in rooms
                                  and q["piece"].split("/")[0] in FIRE_GROUPS)
                         and _state(g, q["piece"], (int(q["x"]), int(q["y"])), lit=False)]
                if not cands:
                    break
                q = dim_order(cands, fire, rest)[0]
                undo.append((q, q.get("state"), q.get("lit")))
                # PUT OUT, not removed, and it must wear an unlit look:
                # settle_states asserts that nothing unlit wears a LIT one.
                q["state"] = _state(g, q["piece"],
                                    (int(q["x"]), int(q["y"])), lit=False)
                q.pop("lit", None)
                ok, where = fits(fire)
            if ok:
                return [q for (q, _s, _l) in undo]
            for (q, st0, lit0) in undo:            # this fire is not lit after
                q["state"] = st0                   # all: put them back
                if lit0:
                    q["lit"] = lit0
            fire["state"] = was
            fire.pop("lit", None)
        return None

    # NEAREST THE ARRIVAL POINT FIRST, which is `lights()`'s own order and the
    # only one that survives contact with a player: the fires he walks past
    # are the ones that burn, and the share decides how far out the budget
    # reaches. (Pricing every fire and lighting the cheapest was tried and
    # rejected — it left a hearth 55 cells from spawn cold while three houses
    # 245 cells away burned, because a fire is only "cheap" by accident of
    # which lamps happen to stand near it.) What IS priced is how each one is
    # PAID for: dim_order spends a street lamp before a cave torch, always.
    lit_count, dimmed, failed = was_lit, [], []
    order = sorted(dark, key=lambda q: (q["x"] - sx) ** 2 + (q["y"] - sy) ** 2)
    for i, fire in enumerate(order):
        if lit_count >= want:
            break
        got = light(fire, [f for f in order[i + 1:] if not f.get("lit")])
        if got is None:
            failed.append((fire["piece"], fire["x"], fire["y"]))
            continue
        dimmed += [(q["piece"], q["x"], q["y"]) for q in got]
        lit_count += 1

    nlit, worst = world3._light_audit(doc["scenery"], extra)
    print(f"{world_dir}: {lit_count} of {len(fires)} indoor fires lit "
          f"({100 * lit_count // len(fires)}%, asked for {100 * share:.0f}%, "
          f"was {was_lit}); {len(dimmed)} light(s) put out to pay for it; "
          f"world lights {nlit}, worst camera window {worst}/{world3.SLOTS}")
    for (piece, x, y) in dimmed:
        print(f"   OUT  {piece} at {x},{y}")
    for t in failed:
        print(f"   COULD NOT LIGHT {t}")
    if write and (dimmed or lit_count != was_lit):
        json.dump(doc, open(path, "w"), separators=(",", ":"))
    return lit_count


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--apply", metavar="WORLD_DIR")
    ap.add_argument("--relight", metavar="WORLD_DIR",
                    help="light most of the indoor fires, putting lamps out to pay")
    ap.add_argument("--share", type=float, default=0.8,
                    help="how many of the fires should burn (default 0.8)")
    ap.add_argument("--refit", metavar="WORLD_DIR",
                    help="move a fire that shuts a door (and its chimney)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.relight:
        relight(a.relight, a.share, write=not a.dry_run)
        return
    if a.refit:
        refit(a.refit, write=not a.dry_run)
        return
    if a.apply:
        apply(a.apply, write=not a.dry_run)
        return
    ap.print_help()


if __name__ == "__main__":
    main()
