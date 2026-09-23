"""MORE CAVES, BIGGER AND STRANGER — dug into the world that ships, in place.

Maintainer 2026-09-18: *"It would be cool if one cave is a slime cave, lava
cave, rock cave, dark_mud and slime, ice and lava cave. You can do any
combination ... You need to open up for the unlikely. I'm not telling you to
redo the map, but if you add another cave or more houses feel more free.
Let's add 3 more caves on the N side and this time they should be bigger and
feel different."*

THE PLANNER IS THE GENERATOR'S OWN (`world3grow._plan_cave`, `_widen_plan`,
`_dig_planned`, `caves`, `cave_dress`, `_audit_site`): this file drives it on
the SHIPPED world through the same shell navfit and yards build, with three
things changed for these caves and drawn from pools per cave:
  WHERE   the north side of the island (the game's north: the low x+y corner),
          at least CAVE_APART from every cave that exists, on a field the
          player walks to (the pit's head reversibly reachable), never
          cutting a field's own way in;
  HOW BIG rooms and lanes from the BIG pools (five to seven rooms, six to
          eight cells across, two or three lanes wide) in a frame wide
          enough to hold them;
  WHAT    a THEME: slime (dark mud with slime pools under black rock), lava
          (a black-rock floor with lava pools), ice and lava, mud and slime,
          bare rock, ice, mud - weights, and no two of one dig alike. A pool
          is a blob deep inside a room with a rim of floor round it, so the
          way through a room is never cut; the audit proves every floor cell
          reachable before anything is written.
The lids wear their field, the floors take their theme AFTER `caves()` has
widened and iced them, the rooms are dressed and lit as every cave is
(braziers on a room's wall, two torches on the pit's rim, the 8-per-window
light budget re-audited), the scree and the grooming passes run (they are
idempotent on the shipped world - measured), every ring cell is named with
the cave's side (cavewalls.py: the cave half of cliff_faces, whose outdoor
palette re-rolls on a shipped world and so is not run; the first three pits
shipped with 0 of 356 ring cells named and the field's grass drawn on the
walls of a stone cave - games agent 2026-09-23), and the sidecars follow:
places.json (Pit VI, VII, VIII), spawns.json (one cave zone each, the cave
cast), then ambient.py --apply and the minimap.

The build gets the same caves from the same code: `dig_north(grow, n)` runs
in world3grow after `dungeons`, and `paint_themes(grow)` after `caves`.

    python3 maps2/pipeline/newcaves.py --dry-run maps2/worlds3/the_game
    python3 maps2/pipeline/newcaves.py --apply   maps2/worlds3/the_game
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
sys.path.insert(0, _HERE)

N_NORTH = 3
TRIES = 800
NORTH_SHARE = 0.45        # the door lies in the northern share of the land, by x+y
BIG = {                   # the pools these caves draw from instead of the generator's
    "CAVE_ROOMS": ((5, 3), (6, 3), (7, 1)),
    "CAVE_ROOM_W": ((5, 2), (6, 3), (7, 2), (8, 1)),
    "CAVE_ROOM_H": ((5, 2), (6, 3), (7, 2), (8, 1)),
    "CAVE_LANES": ((2, 3), (3, 2)),
}
MEDIUM = {                # ...when no field takes a big one: still bigger than the generator's
    "CAVE_ROOMS": ((4, 3), (5, 3), (6, 1)),
    "CAVE_ROOM_W": ((4, 2), (5, 3), (6, 2), (7, 1)),
    "CAVE_ROOM_H": ((4, 2), (5, 3), (6, 2), (7, 1)),
    "CAVE_LANES": ((2, 3), (3, 1)),
}
PHASES = (0.6, 0.85)      # share of the plans drawn from BIG, then MEDIUM, then the generator's own
FRAME_X, FRAME_UP, FRAME_DOWN = 16, 24, 8      # the planner's frame: half-width, rows north, rows south of the pit
# name, weight, cave_side (the wall the dressing reads), floor ground, pools [(ground, (n_lo, n_hi), (size_lo, size_hi))]
THEMES = (
    ("slime",     3, "black_rock", "dark_mud",   [("slime", (3, 5), (3, 6))]),
    ("lava",      2, "black_rock", "black_rock", [("lava", (2, 3), (3, 5))]),
    ("ice-lava",  2, "ice",        "ice",        [("lava", (1, 2), (3, 4))]),
    ("mud-slime", 2, "grey_stone", "dark_mud",   [("slime", (2, 3), (4, 7))]),
    ("rock",      2, "grey_stone", "grey_stone", []),
    ("ice",       1, "ice",        "ice",        []),
    ("mud",       1, "grey_stone", "dark_mud",   []),
)
THEME_FLOORS = ("dark_mud", "slime", "ice", "black_rock", "grey_stone", "lava")
PIT_NAMES_MORE = (("pit_6", "Pit VI"), ("pit_7", "Pit VII"), ("pit_8", "Pit VIII"),
                  ("pit_9", "Pit IX"), ("pit_10", "Pit X"))


def _theme(r, taken):
    import world3grow as W
    pool = [(t, w) for t in THEMES for w in (t[1],)]
    for _ in range(20):
        t = W.Grow._weighted(pool, r)
        if t[0] not in taken:
            return t
    return t


# -- the shell -----------------------------------------------------------------
def shell(doc, places):
    """The generator over the shipped world, with what the diggers read."""
    import navfit
    import world3grow as W
    g = W.Grow.__new__(W.Grow)
    g.doc, g.G = doc, doc["grounds"]
    g.gi = {n: i for i, n in enumerate(g.G)}
    for name in ("slime", "lava", "ice", "black_rock", "grey_stone", "dark_mud"):
        if name not in g.gi:
            g.gi[name] = len(g.G)
            g.G.append(name)
    g.grd, g.lvl = doc["ground"], doc["level"]
    W.NEW = min(doc["size"]["w"], doc["size"]["h"])
    g._bbox, g._hit = navfit.load_docs()
    g._fp = {}
    g.door_cells = navfit._thresholds(doc)
    g.refused, g.fail, g.placed = {}, 0, []
    g.floor_cells = g.indoor_floors()
    g.build_no_place()
    g._reindex()
    # the caves that exist: their floors keep other caves CAVE_APART away and
    # their mouths stay clear; nothing else of theirs is re-read
    g.cave_sites = []
    g.mouth_clear = set()
    for pl in places:
        if pl.get("kind") != "cave":
            continue
        cells = {tuple(c) for c in pl["cells"]}
        for ex, ey in pl.get("entrances", [pl["entrance"]]):
            g.mouth_clear |= {(ex + dx, ey + dy) for dx in range(-2, 3) for dy in range(-2, 3)}
        g.cave_sites.append({"kind": "old", "cells": cells, "keep": cells, "floor": cells,
                             "doors": [], "clear": set(), "margin": set()})
    g.mouth_torches, g.dungeon_margin, g.margin_outer = [], set(), set()
    g.planned_floor, g.planned_rock = set(), {}
    return g


def north_line(g, share=NORTH_SHARE):
    """The x+y below which the northern `share` of the LAND lies (the game's
    north is the low x+y corner; a quantile, so the islets do not stretch it)."""
    N = len(g.grd)
    s = sorted(x + y for y in range(N) for x in range(N) if g.g(x, y) and not g.liquid(x, y))
    return s[int(len(s) * share)]


# -- the dig --------------------------------------------------------------------
def dig_north(g, n=N_NORTH, log=print):
    """Dig `n` big themed pits on the north side, the way dungeons() digs
    one: plan first, then find a field for the plan's shape. Returns the
    sites (each carries its theme)."""
    import world3grow as W
    r = W._rng32(0xA0A7)
    saved = {k: getattr(g, k) for k in BIG}
    for k, v in BIG.items():
        setattr(g, k, v)
    north = north_line(g)
    log(f"  the north side: land with x+y <= {north}")
    M, B = g.DUNGEON_MARGIN, g.CAVE_BUFFER
    made, taken = [], set()
    try:
        for k in range(n):
            why = collections.Counter()
            for _try in range(TRIES):
                # BIGGER IS A WEIGHT, NOT A RULE: the big pools first, and when
                # half the plans found no field for them the generator's own
                # pools (a cave still, a little smaller) so the north gets its
                # three caves rather than two big ones and a hole
                pools = BIG if _try < TRIES * PHASES[0] else (MEDIUM if _try < TRIES * PHASES[1] else saved)
                for kk, v in pools.items():
                    setattr(g, kk, v)
                D = g._weighted(g.PIT_DEPTH, r)
                beside = 2 + B + 1
                free = lambda x, y, l, D=D: (-FRAME_X <= x <= FRAME_X and -FRAME_UP <= y <= D + FRAME_DOWN
                                             and l >= -g.CAVE_DOWN_MAX
                                             and (y <= -1 or abs(x) >= beside or y >= D + B + 1))
                plan = g._plan_cave(r, -g.CAVE_DOWN_MAX, 0, free, lambda x, y, l: True, (-1, 0, 1))
                if plan is None:
                    why["no plan"] += 1
                    continue
                if not plan["ledges"] and _try < 30:
                    why["no ledge yet"] += 1
                    continue
                if len(plan["chambers"]) < 4 and _try < TRIES // 3:
                    why["under four rooms"] += 1
                    continue                      # bigger: four rooms or more
                P = D - 1
                for x in (-1, 0, 1):
                    for kk in range(1, P + 1):
                        plan["cells"][(x, kk)] = kk
                    plan["cells"][(x, P + 1)] = D
                for x in (-2, 2):
                    plan["cells"][(x, 0)] = D
                    for kk in range(1, P + 1):
                        plan["cells"][(x, kk)] = D - max(0, D - kk - 2)
                core = set(plan["cells"])
                ring = {(c[0] + dx, c[1] + dy) for c in core
                        for dx in range(-M, M + 1) for dy in range(-M, M + 1)} - core
                depth = D - min(plan["cells"].values())
                reach, _ = g._ways()
                fits = [f for f in g._shape_fits(core, ring, depth, g._keep_out())
                        if (f[1], f[2] + D) in reach and f[1] + f[2] <= north]
                if not fits:
                    why["no field fits"] += 1
                    continue

                def field_of(f):
                    S, dx, dy = f
                    return collections.Counter(
                        g.g(dx + c[0], dy + c[1]) for c in ring
                        if g.g(dx + c[0], dy + c[1]) in g.NATURAL).most_common(1)[0][0]
                # spread over the north: the first as far north as it goes, the
                # next ones as far from the caves dug this pass as they can be
                if made:
                    fits.sort(key=lambda f: -min(abs(f[1] - s["door"][0][0]) + abs(f[2] - s["door"][0][1]) for s in made))
                else:
                    fits.sort(key=lambda f: f[1] + f[2])
                meadow = [f for f in fits if field_of(f) in g.DUNGEON_FIELD]
                if not meadow and _try < TRIES * 3 // 4:
                    why["no meadow yet"] += 1
                    continue
                site_ok = next((f for f in (meadow or fits)[:8]
                                if g._cut_keeps_ways([(f[1] + c[0], f[2] + c[1]) for c in plan["cells"]],
                                                     [(f[1] + x, f[2] + D + 1) for x in (-1, 0, 1)])), None)
                if site_ok is None:
                    why["would cut a way"] += 1
                    continue
                S, dx, dy = site_ok
                field = field_of((S, dx, dy))
                for x in (-1, 0, 1):
                    plan["runs"].append([(x, kk) for kk in range(0, P + 2)])
                T = lambda x, y, dx=dx, dy=dy: (dx + x, dy + y)
                nat = [g.gi[g_] for g_ in g.NATURAL if g_ in g.gi]

                def field_cell(fx, fy, l, T=T, S=S):
                    w = T(fx, fy)
                    return (0 <= w[0] < W.NEW and 0 <= w[1] < W.NEW and g.grd[w[1]][w[0]] in nat
                            and g.lvl[w[1]][w[0]] == S and w not in g._keep_out())
                wide = g._widen_plan(plan, field_cell, field_cell)
                site, gone = g._dig_planned(plan, T, S - D, D, field, "pit", min(g.ROCK_MIN, S),
                                            lambda w, S=S, field=field: (S, field))
                site["S"] = S
                pit = {(dx + x, dy + kk) for x in (-2, -1, 0, 1, 2) for kk in range(0, P + 1)} \
                    | {(dx + x, dy + P + 1) for x in (-1, 0, 1)}
                torch = [(dx - 2, dy + P), (dx + 2, dy + P)]
                site["doors"][0]["torches"] = torch
                site["doors"][0]["clear"] = (set(site["door"]) | pit) - set(torch)
                site["clear"] = site["doors"][0]["clear"]
                g.mouth_clear |= site["clear"]
                g.mouth_torches = [t for s_ in g.cave_sites for d in s_["doors"] for t in d["torches"]]
                site["margin"] = {(dx + c[0], dy + c[1]) for c in ring} - set(site["cells"])
                site["margin_lv"] = {c: S for c in site["margin"]}
                g.dungeon_margin |= site["margin"]
                theme = _theme(r, taken)
                taken.add(theme[0])
                site["theme"], site["new"] = theme[0], True
                made.append(site)
                log(f"  cave {k + 1}: {theme[0]} at door ({dx},{dy}), field {field} at {S}, {site['rooms']} rooms, "
                    f"depth {D}, floors {site['levels']}, {len(site['ledges'])} ledges, "
                    f"{len(site['floor'])} floor cells, widened by {wide[0]} cells and {wide[1]} lanes, "
                    f"scenery evicted {gone}")
                break
            else:
                log(f"  cave {k + 1}: no site found in {TRIES} plans: {dict(why)}; planner {dict(getattr(g, 'plan_fails', {}))}")
    finally:
        for k, v in saved.items():
            setattr(g, k, v)
    return made


def paint_themes(g, sites, log=print):
    """The floors take their theme after caves() has widened and iced them:
    the floor ground everywhere but the stairs, then the pools, each a blob
    deep in a room with a rim of floor round it."""
    import world3grow as W
    gi = g.gi
    ramp = {(c["x"], c["y"]) for rp in g.doc.get("ramps", []) for c in rp["cells"]}
    for site in sites:
        theme = next(t for t in THEMES if t[0] == site["theme"])
        _, _, side, floor_g, pools = theme
        r = W._rng32((min(site["floor"])[0] * 2654435761 ^ min(site["floor"])[1] * 40503 ^ 0x7E3E) & 0xffffffff)
        floor = set(site["floor"])
        for (x, y) in floor:
            if (x, y) in ramp:
                continue
            g.grd[y][x] = gi[floor_g]
        laid = 0
        rooms = g._cave_rooms(floor)
        chambers = g._chambers(rooms) if rooms else []
        for pg, (n0, n1), (s0, s1) in pools:
            want = n0 + int(r() * (n1 - n0 + 1))
            cands = [c for c in chambers if len(c) >= 12]
            for k in range(want):
                if not cands:
                    break
                room = cands[(int(r() * len(cands)) + k) % len(cands)]
                blob = g._pool_blob(set(room), r, s0 + int(r() * (s1 - s0 + 1)), ring=1)
                for (x, y) in blob:
                    if (x, y) in floor and (x, y) not in ramp:
                        g.grd[y][x] = gi[pg]
                        laid += 1
        site["side"] = side
        # the wall pass reads cave_side: the theme's side, not the rock the
        # complex rolled in caves() (cliff_faces / cavewalls.py name the ring)
        for i, dk in enumerate(g.doc["decks"]):
            if dk.get("kind") == "cave" and any((c["x"], c["y"]) in floor for c in dk["cells"]):
                g.cave_side[i] = side
        log(f"  {site['theme']}: floor {floor_g}, {laid} pool cells")


# -- everything after the dig, for the world that ships ---------------------------
def _cave_state(g, sites):
    """cave_floor / cave_side / cave_rock_min for the deck list as it is now."""
    g.cave_floor, g.cave_side, g.cave_rock_min = {}, {}, {}
    new_floor = set().union(*(s["floor"] for s in sites)) if sites else set()
    for i, dk in enumerate(g.doc["decks"]):
        if dk.get("kind") != "cave":
            continue
        cells = [(c["x"], c["y"]) for c in dk["cells"]]
        for c in cells:
            g.cave_floor[c] = i                 # by DECK INDEX, the generator's contract
        g.cave_rock_min[i] = min(g.ROCK_MIN, int(dk["level"]))
        for c in cells:
            if c in g.planned_rock:
                g.cave_rock_min[i] = min(g.cave_rock_min[i], g.planned_rock[c])
        mine = [s for s in sites if set(cells) & s["floor"]]
        if mine:
            g.cave_side[i] = mine[0].get("side", "grey_stone")
        else:
            g.cave_side[i] = "ice" if all(g.g(*c) == "ice" for c in cells) else "grey_stone"


def _only_new_decks(g, sites, fn):
    """Run a pass that walks every cave deck over the NEW decks only: the old
    caves are already widened, dressed and lit, and the pass is not
    idempotent on them (measured: caves() moved 395 levels, cave_dress added
    32 pieces)."""
    all_decks = g.doc["decks"]
    new_floor = set().union(*(s["floor"] for s in sites))
    old_caves = [dk for dk in all_decks if dk.get("kind") == "cave"
                 and not any((c["x"], c["y"]) in new_floor for c in dk["cells"])]
    g.doc["decks"] = [dk for dk in all_decks if dk not in old_caves]
    _cave_state(g, sites)
    # the old caves' floors still count as cave for the wall tests
    for dk in old_caves:
        for c in dk["cells"]:
            g.cave_floor[(c["x"], c["y"])] = int(dk["level"])
    try:
        fn()
    finally:
        new_decks = [dk for dk in g.doc["decks"] if dk.get("kind") == "cave"]
        others = [dk for dk in g.doc["decks"] if dk.get("kind") != "cave"]
        g.doc["decks"] = others + old_caves + new_decks
        _cave_state(g, sites)


def braziers_and_torches(g, sites, log=print):
    """Braziers on a room's wall side (three per chamber, never in a passage)
    and two torches on the pit's rim, lit - the cave's own light, as the
    build's village() and lights() give every cave."""
    import world3
    bz = g._lit_pool("braziers")
    tz = g._lit_pool("torch_posts")
    lit_state = dict(bz)
    n = 0
    for site in sites:
        cells = sorted(site["floor"])
        chambers = g._chambers(g._cave_rooms(cells)) or g._chambers(g._cave_rooms(cells, g.ROOM_MIN - 1))
        before = len(g.doc["scenery"])
        for chamber in chambers:
            edge = []
            for c in sorted(chamber):
                for sd, m in (("n", (c[0], c[1] - 1)), ("w", (c[0] - 1, c[1])),
                              ("s", (c[0], c[1] + 1)), ("e", (c[0] + 1, c[1]))):
                    if m not in g.cave_floor:
                        edge.append((c, sd))
                        break
            if not edge:
                continue
            step = max(1, len(edge) // 3)
            for i, (c, sd) in enumerate(edge[::step][:3]):
                if g.g(*c) == "lava":
                    continue
                n += g._put_flush(bz[i % len(bz)][0], c, sd, THEME_FLOORS)
        placed = [p for p in g.doc["scenery"][before:] if p["piece"].startswith("braziers/")]
        for k, (tx, ty) in enumerate(site["doors"][0]["torches"]):
            pc, st = tz[k % len(tz)]
            if g.put(pc, tx + 0.5, ty + 0.5, on=tuple(g.NATURAL), state=st):
                n += 1
                placed.insert(0, g.doc["scenery"][-1])     # torches light first
        site["lights"] = placed
    # THE 8-PER-WINDOW BUDGET, as lights() keeps it: a light burns only while
    # the worst camera window still fits (a cave dug beside the town's lamps
    # blew 23 into one window - measured); the torches first, then the
    # braziers in rounds so no hall hogs the cave's window
    sx, sy = g.doc["spawn"]
    extra = [(sx + 0.5, sy + 0.5, g.BONFIRE_R)]
    boxes = world3.light_boxes(g.doc["scenery"], extra)
    lit, unlit = collections.Counter(), []
    rounds = max((len(s.get("lights", [])) for s in sites), default=0)
    for rnd in range(rounds):
        for si, site in enumerate(sites):
            ls = site.get("lights", [])
            if rnd >= len(ls):
                continue
            p = ls[rnd]
            st = lit_state.get(p["piece"]) or dict(tz).get(p["piece"])
            if not st:
                continue
            box = world3.light_boxes([dict(p, lit=True, state=st)])[0]
            if world3.max_overlap(boxes + [box], only=box)[0] > world3.SLOTS:
                # THE CAVE OUTRANKS THE GLOW ROUND IT, as lights() ranks them
                # (step 3 caves, step 5 road lamps, the wild's glow after):
                # for the torches and the first brazier of a hall, a lower
                # light in the same window goes dark instead - the smallest
                # first, at most UNLIGHT_MAX per cave light
                if rnd < 3:
                    for q in _lower_in(g, boxes, box)[:UNLIGHT_MAX]:
                        _unlight(q)
                        boxes = world3.light_boxes(g.doc["scenery"], extra)
                        unlit.append(q["piece"])
                        if world3.max_overlap(boxes + [box], only=box)[0] <= world3.SLOTS:
                            break
                if world3.max_overlap(boxes + [box], only=box)[0] > world3.SLOTS:
                    continue                      # still full: it stays unlit
            p["lit"], p["state"] = True, st
            boxes.append(box)
            lit[si] += 1
    nlit, worst = world3._light_audit(g.doc["scenery"], extra)
    log(f"  {n} braziers and torches placed, lit per cave {[lit[i] for i in range(len(sites))]}; "
        f"{len(unlit)} lower lights darkened for them {collections.Counter(u.split('/')[0] for u in unlit)}; "
        f"{nlit} lights, worst window {worst}/8")
    return n


LOWER = ("crystals", "crystal_trees", "soulstone_outcrops", "waystones", "wayside_shrines",
         "giant_mushrooms", "geodes", "frost_flowers", "streetlights", "charcoal_kilns")
UNLIGHT_MAX = 3


def _lower_in(g, boxes, box):
    """Lit pieces of a lower rank whose window overlaps `box`, the smallest
    radius first, that can be put out (they carry `lit` and ship a NOT_LIT
    state to fall back to)."""
    import heal
    import world3
    out = []
    for p in g.doc["scenery"]:
        if not p.get("lit") or p["piece"].split("/")[0] not in LOWER:
            continue
        b = world3.light_boxes([p])[0]
        if b[1] < box[0] or b[0] > box[1] or b[3] < box[2] or b[2] > box[3]:
            continue
        meta = heal._meta(p["piece"]) or {}
        dark = [s_ for s_ in sorted(meta.get("states") or {}) if s_.startswith("NOT_LIT")
                and heal._ok_state(p["piece"], s_, p.get("dir"))]
        if not dark:
            continue
        r = world3.light_meta(p["piece"], p.get("state"))[0]
        out.append((r, p["x"] + p["y"], p, dark[0]))
    out.sort(key=lambda t: (t[0], t[1]))
    return _pack(out)


def _pack(out):
    res = []
    for _r, _s, p, d in out:
        p["_dark"] = d
        res.append(p)
    return res


def _unlight(p):
    p.pop("lit", None)
    p["state"] = p.pop("_dark")


def _traps(g):
    R, Rev = g._reach(g._standable())
    return {(x, y) for (x, y, l) in R - Rev if l == 0}


def sidecars(world_dir, g, sites, log=print):
    """places.json and spawns.json grow one entry per new cave."""
    pf = os.path.join(world_dir, "places.json")
    sf = os.path.join(world_dir, "spawns.json")
    places = json.load(open(pf))
    spawns = json.load(open(sf))
    used = {p["id"] for p in places["places"]}
    names = [nm for nm in PIT_NAMES_MORE if nm[0] not in used]
    cast = [z["monster"] for z in spawns["zones"] if z["id"].startswith(("cave", "n-cave"))] or ["masked_shadow_creature"]
    nz = sum(1 for z in spawns["zones"] if z["id"].startswith("n-cave"))
    for j, site in enumerate(sites):
        floor = set(site["floor"]) | set(site["door"])
        lv = [g.lvl[c[1]][c[0]] for c in floor]
        cx = sum(c[0] for c in floor) / len(floor)
        cy = sum(c[1] for c in floor) / len(floor)
        anchor = min(floor, key=lambda c: ((c[0] - cx) ** 2 + (c[1] - cy) ** 2, c))
        d = site["doors"][0]
        mouth = d["cells"][len(d["cells"]) // 2]
        pid, disp = names[j]
        places["places"].append({"id": pid, "name": disp, "kind": "cave", "indoor": True,
                                 "elev": [int(min(lv)), int(max(lv))], "anchor": [anchor[0], anchor[1]],
                                 "entrance": [mouth[0], mouth[1]], "entrances": [[mouth[0], mouth[1]]],
                                 "cells": [[c[0], c[1]] for c in sorted(floor)], "theme": site["theme"]})
        fc = site["floor"]
        xs = [c[0] for c in fc]
        ys = [c[1] for c in fc]
        fl = min(g.lvl[c[1]][c[0]] for c in fc)
        fh = max(g.lvl[c[1]][c[0]] for c in fc)
        x0, y0, w, h = min(xs) - 1, min(ys) - 1, max(xs) - min(xs) + 2, max(ys) - min(ys) + 2
        spawns["zones"].append({"id": f"n-cave-{nz + j + 1}", "monster": cast[(nz + j) % len(cast)],
                                "area": [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]],
                                "elev": [int(fl), int(max(fl + 2, fh))], "num": 2})
        log(f"  {disp}: {len(floor)} cells, entrance {mouth}, zone n-cave-{nz + j + 1} ({spawns['zones'][-1]['monster']})")
    places["places"].sort(key=lambda p: p["id"])
    json.dump(places, open(pf, "w"), separators=(",", ":"))
    json.dump(spawns, open(sf, "w"), separators=(",", ":"))


def apply(world_dir, write=True, n=N_NORTH):
    import world3grow as W
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    places = json.load(open(os.path.join(world_dir, "places.json")))["places"]
    g = shell(doc, places)
    traps0 = _traps(g)
    print(f"{world_dir}: {len(traps0)} trap cells before")
    sites = dig_north(g, n)
    assert len(sites) == n, ("caves dug", len(sites))
    lid = {(c["x"], c["y"]) for dk in doc["decks"] if dk.get("kind") == "cave" for c in dk["cells"]}
    for s in sites:
        g._field_wear(s, lid)
    _only_new_decks(g, sites, g.caves)
    paint_themes(g, sites)
    _only_new_decks(g, sites, g.cave_dress)
    braziers_and_torches(g, sites)
    g.cliff_apron()
    g.regroom()
    import cavewalls
    named = cavewalls.add(doc, cavewalls.missing(g))
    print(f"  cave walls named: {named} ring cells (the caves' own sides)")
    R, _rev = g._reach(g._standable())
    g.reach_cells = {(x, y) for (x, y, layer) in R if layer == 0}
    for s in sites:
        g._audit_site(s)
    traps1 = _traps(g)
    new_traps = traps1 - traps0
    assert not new_traps, ("new trap cells", len(new_traps), sorted(new_traps)[:6])
    print(f"  audited: {len(sites)} caves, {len(traps1)} trap cells after (none new)")
    if write:
        json.dump(doc, open(path, "w"), separators=(",", ":"))
        sidecars(world_dir, g, sites)
        print(f"wrote {path} and the sidecars")
    return sites


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("world_dir")
    gr = ap.add_mutually_exclusive_group(required=True)
    gr.add_argument("--apply", action="store_true")
    gr.add_argument("--dry-run", action="store_true")
    ap.add_argument("--n", type=int, default=N_NORTH)
    a = ap.parse_args()
    apply(a.world_dir, write=a.apply, n=a.n)


if __name__ == "__main__":
    main()
