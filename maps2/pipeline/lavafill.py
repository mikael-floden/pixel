"""LAVA LAKES ON THE MASSIF — one growth rule, used at build time and applied
in place to the world that already ships.

Maintainer 2026-09-13: *"I feel the lava you have placed on the mountain is
just small spots and doesn't feel epic enough. Can't you make the lava a bit
bigger?"* He was looking at 23 cells in five 3-6 cell dabs.

THE SHAPE OF THE GROUND DECIDES HOW BIG LAVA CAN GET. A pool may only take
cells whose whole (2*RING+1) square is allowed ground, so a walkable ring of
rock always survives around it (`_pool_blob`'s old rule, kept): the pool is a
hazard beside the way, never the way itself, and a lava cell can never border
anything but black_rock, which is the containment collar the ground-transition
law wants. On the_game that interior is ONE 167-cell region of the level-24
shelf (562 cells) — so the ceiling is 167 and the old rule was using 14% of
it. Every other black_rock shelf in the world has an interior of 0-2 cells and
gets no lava at all, which is why the lava is all in one place.

THE GROWTH IS ORGANIC, NOT A DISC. A candidate is scored by how many cells of
the field it already touches (compactness, so the lake fills out instead of
snaking) plus a smooth value-noise field (lobes and bays, so it is not a
circle), and the best is taken until the field reaches LAVA_SHARE of the
interior. Seeded per shelf, deterministic: the same shelf grows the same lake
every run. Pools that grow into each other MERGE — a lake with two arms is the
point, and the old rule's 2-cell "pools keep apart" would have cut it in half.

IN PLACE, NEVER A REBUILD (maintainer 2026-09-13, on a rebuild that re-dressed
the map under a placement fix: *"I was asking for a placement correction
only!"*): `--apply <world_dir>` grows the SHIPPED world's pools and writes
nothing else — no scenery is moved, evicted or re-rolled. It refuses any cell
a scenery footprint, an NPC, a road, a room, a deck, a wall, a ramp, a door
or a cave floor stands on (with the interior rule that is a 2-cell buffer
from each), and it re-checks afterwards that the world stayed reachable.
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

RING = 2            # cells of walkable rock a pool keeps on every side
LAVA_SHARE = 0.78   # of a shelf's allowed interior. Measured on the_game's
                    # 115-cell interior, rendered and looked at: 23 cells
                    # (20%) is the five dabs he called "small spots", 71
                    # (62%) is four ponds, 90 (78%) is three lava FLOWS that
                    # run across the rock and read from the camera — and the
                    # rock still has more than four times the lava's area.
                    # 100% would flood the interior into one sheet with a
                    # 2-cell ledge round it, which is a corridor, not a
                    # mountain.
NOISE_CELLS = 7.0   # the lobes' scale: a bay or a cape is a few cells across
NOISE_W = 1.7       # how much the noise outweighs compactness (0..4 apart)


# -- a small deterministic value noise ---------------------------------------
# crc32, never hash(): a str's hash is salted per process, and a salted seed in
# a world generator re-rolls the map on every run (paid for 2026-09-13).

def _h(i, j, seed):
    return zlib.crc32(f"{i}|{j}|{seed}".encode()) & 0xffffffff


def _noise(x, y, seed, period=NOISE_CELLS):
    """Smooth value noise in [0,1) — bilinear on a lattice of `period` cells,
    smoothstepped, two octaves."""
    out = 0.0
    amp = 1.0
    tot = 0.0
    for o in range(2):
        p = period / (o + 1)
        fx, fy = x / p, y / p
        ix, iy = math.floor(fx), math.floor(fy)
        tx, ty = fx - ix, fy - iy
        sx = tx * tx * (3 - 2 * tx)
        sy = ty * ty * (3 - 2 * ty)
        a = _h(ix, iy, seed + o) / 2 ** 32
        b = _h(ix + 1, iy, seed + o) / 2 ** 32
        c = _h(ix, iy + 1, seed + o) / 2 ** 32
        d = _h(ix + 1, iy + 1, seed + o) / 2 ** 32
        out += amp * ((a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy)
        tot += amp
        amp *= 0.5
    return out / tot


# -- the geometry -------------------------------------------------------------

def interior(cells, ring=RING):
    """The cells whose whole (2*ring+1) square is inside `cells` — the only
    ground a pool may take, so a walkable ring always survives."""
    span = range(-ring, ring + 1)
    return {c for c in cells
            if all((c[0] + dx, c[1] + dy) in cells for dx in span for dy in span)}


def grow(deep, pools, target, seed_int):
    """Grow every pool of `pools` inside `deep`, IN TURN, until the field
    reaches `target` cells. Organic: the candidate touching the most of the
    field, nudged by a noise field of its own, wins.

    EVERY POOL GROWS, one cell each per round. Growing the field as a whole
    spends the whole budget on the biggest cluster — compactness always
    prefers the cell with the most neighbours — and the outlying dabs stay
    dabs: measured on the_game, one lake of 48 and four spots of 3-6 left,
    which is the thing the maintainer was looking at. Round-robin gives a
    volcanic FIELD, and pools that meet merge (a lake with two arms is the
    point). Returns the whole field."""
    N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))
    field = set().union(*pools) if pools else set()

    def touch(c):
        return sum((c[0] + dx, c[1] + dy) in field for dx, dy in N4)

    def edge_of(pool):
        return {(c[0] + dx, c[1] + dy) for c in pool for dx, dy in N4
                if (c[0] + dx, c[1] + dy) in deep and (c[0] + dx, c[1] + dy) not in field}
    live = [(set(p), zlib.crc32(f"{seed_int}|{min(p)}".encode()) & 0xffffffff)
            for p in pools]
    while len(field) < target and live:
        nxt = []
        for pool, s in live:
            if len(field) >= target:
                nxt.append((pool, s))
                continue
            cand = edge_of(pool)
            if not cand:
                continue                  # this pool is boxed in; the rest go on
            best = max(cand, key=lambda c: (touch(c) + NOISE_W * _noise(c[0], c[1], s),
                                            -c[0], -c[1]))
            pool.add(best)
            field.add(best)
            nxt.append((pool, s))
        if len(nxt) == len(live) and not any(edge_of(p) for p, _ in nxt):
            break
        live = nxt
    return field


def pools_of(cells):
    """The 8-connected pools of a cell set — each grows as one lake."""
    todo = set(cells)
    out = []
    while todo:
        st = [todo.pop()]
        pool = set(st)
        while st:
            x, y = st.pop()
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (x + dx, y + dy)
                    if n in todo:
                        todo.discard(n)
                        pool.add(n)
                        st.append(n)
        out.append(pool)
    return sorted(out, key=min)


def field_for(allowed, seeds, seed_int, share=LAVA_SHARE):
    """The lava field of one shelf: every pool of `seeds` grown inside the
    interior of `allowed`, together, to `share` of that interior."""
    deep = interior(allowed)
    if not deep:
        return set(seeds) & set(allowed)
    return grow(deep, pools_of(seeds),
                max(len(seeds), round(share * len(deep))), seed_int)


def shelf_seed(cells):
    """A shelf's own seed: its lowest cell, so the same shelf grows the same
    lake whatever order the terraces come in."""
    a = min(cells)
    return zlib.crc32(f"lava|{a[0]}|{a[1]}".encode()) & 0xffffffff


# -- applying it to a world that already ships --------------------------------

def _shelves(doc, ground=("black_rock", "lava")):
    """[(level, cells)] — 4-connected same-level runs of `ground`."""
    G, grd, lvl = doc["grounds"], doc["ground"], doc["level"]
    W, H = doc["size"]["w"], doc["size"]["h"]
    ix = {i for i, g in enumerate(G) if g in ground}
    seen = set()
    out = []
    for y in range(H):
        for x in range(W):
            if (x, y) in seen or grd[y][x] not in ix:
                continue
            lv = lvl[y][x]
            st, comp = [(x, y)], set()
            seen.add((x, y))
            while st:
                cx, cy = st.pop()
                comp.add((cx, cy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < W and 0 <= ny < H and (nx, ny) not in seen \
                            and grd[ny][nx] in ix and lvl[ny][nx] == lv:
                        seen.add((nx, ny))
                        st.append((nx, ny))
            out.append((lv, comp))
    return out


def _taken(doc, world_dir):
    """Every cell lava may not take on a shipped world: what is built on it
    (decks, walls, ramps, rooms, doorways, cave floors), the roads with their
    2-cell keep-out, and where anything stands (scenery footprints, NPCs)."""
    import navfit
    import world3grow as W

    G, grd = doc["grounds"], doc["ground"]
    Wd, Hd = doc["size"]["w"], doc["size"]["h"]
    keep = set()
    for dk in doc.get("decks", []):
        keep |= {(c["x"], c["y"]) for c in dk["cells"]}
    for wl in doc.get("walls", []):
        keep |= {(c["x"], c["y"]) for c in wl["cells"]}
    for rr in doc.get("ramps", []):
        keep |= {(c["x"], c["y"]) for c in rr["cells"]}
    for rm in doc.get("rooms", []):
        keep |= {(c["x"], c["y"]) for c in rm.get("cells", [])}
    keep |= navfit._thresholds(doc)
    keep |= set(navfit._cave_floor(doc))
    soil = {i for i, g in enumerate(G) if g == "light_soil"}
    for y in range(Hd):
        for x in range(Wd):
            if grd[y][x] in soil:
                for dx in range(-2, 3):
                    for dy in range(-2, 3):
                        keep.add((x + dx, y + dy))
    # WHERE SOMETHING STANDS. A footprint that straddles the shore breaks the
    # footprint law, so a piece's own cells and the cells its box covers are
    # out; the interior rule then keeps lava a further 2 cells away.
    bbox, hit = navfit.load_docs()
    g = W.Grow.__new__(W.Grow)
    g.doc, g.G = doc, G
    g.gi = {n: i for i, n in enumerate(G)}
    g.grd, g.lvl = grd, doc["level"]
    g._bbox, g._hit = bbox, hit
    for p in doc.get("scenery", []):
        if p.get("z") is not None:
            continue
        sh = g._fp_shape(p)
        if sh:
            _kind, dwx, dwy, hx, hy = sh
            cx, cy = p["x"] + dwx, p["y"] + dwy
            rx, ry = hx + g.FP_MARGIN, hy + g.FP_MARGIN
        else:
            cx, cy, rx, ry = p["x"], p["y"], g.FP_DEFAULT, g.FP_DEFAULT
        for yy in range(math.floor(cy - ry), math.floor(cy + ry) + 1):
            for xx in range(math.floor(cx - rx), math.floor(cx + rx) + 1):
                keep.add((xx, yy))
    try:
        npcs = json.load(open(os.path.join(world_dir, "npcs.json")))["npcs"]
    except (OSError, KeyError, ValueError):
        npcs = []
    for n in npcs:
        if n.get("x") is None:
            continue
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                keep.add((int(n["x"]) + dx, int(n["y"]) + dy))
    sx, sy = doc["spawn"]
    for dx in range(-3, 4):
        for dy in range(-3, 4):
            keep.add((int(sx) + dx, int(sy) + dy))
    return keep


def _reachable(doc, blocked_liquid=True):
    """The cells a body can walk to from the spawn, as the nav does it: the
    same level or one step (the game jumps 1), never onto a liquid."""
    G, grd, lvl = doc["grounds"], doc["ground"], doc["level"]
    W, H = doc["size"]["w"], doc["size"]["h"]
    liq = {i for i, g in enumerate(G) if g in doc.get("liquids", [])}
    deck = {}
    for dk in doc.get("decks", []):
        for c in dk["cells"]:
            deck[(c["x"], c["y"])] = dk["level"]

    def walk(x, y):
        if not (0 <= x < W and 0 <= y < H) or grd[y][x] < 0:
            return None
        if (x, y) in deck:
            return deck[(x, y)]
        if blocked_liquid and grd[y][x] in liq:
            return None
        return lvl[y][x]
    sx, sy = int(doc["spawn"][0]), int(doc["spawn"][1])
    start = walk(sx, sy)
    if start is None:
        return set()
    seen = {(sx, sy)}
    st = [(sx, sy, start)]
    while st:
        x, y, z = st.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = (x + dx, y + dy)
            if n in seen:
                continue
            nz = walk(*n)
            if nz is None or abs(nz - z) > 1:
                continue
            seen.add(n)
            st.append((n[0], n[1], nz))
    return seen


def apply(world_dir, share=LAVA_SHARE, write=True):
    """Grow the shipped world's lava pools in place. Nothing but the ground of
    the grown cells changes: no scenery is moved, evicted or re-rolled."""
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    G, grd = doc["grounds"], doc["ground"]
    gi = {n: i for i, n in enumerate(G)}
    if "lava" not in gi:
        print(f"{world_dir}: no lava in the legend — nothing to grow")
        return 0
    LV, BR = gi["lava"], gi["black_rock"]
    before = {(x, y) for y in range(doc["size"]["h"])
              for x in range(doc["size"]["w"]) if grd[y][x] == LV}
    reach_before = _reachable(doc)
    taken = _taken(doc, world_dir)
    grown = set()
    for lv, cells in _shelves(doc):
        seeds = {c for c in cells if grd[c[1]][c[0]] == LV}
        if not seeds:
            continue                      # lava goes where the build put it
        allowed = (cells - taken) | seeds
        field = field_for(allowed, seeds, shelf_seed(cells), share)
        grown |= field - seeds
        print(f"  shelf at level {lv}: {len(cells)} cells, interior "
              f"{len(interior(allowed))}, lava {len(seeds)} -> {len(field)}")
    for (x, y) in grown:
        grd[y][x] = LV
    # THE LAWS, RE-CHECKED ON THE RESULT.
    W_, H_ = doc["size"]["w"], doc["size"]["h"]
    lava = before | grown
    for (x, y) in lava:
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = grd[y + dy][x + dx]
            assert n in (LV, BR), \
                f"lava at {x},{y} borders {G[n]} — the collar is black_rock only"
    for p in doc.get("scenery", []):
        assert (int(p["x"]), int(p["y"])) not in grown, \
            f"{p['piece']} at {p['x']},{p['y']} would stand in lava"
    reach_after = _reachable(doc)
    lost = (reach_before - reach_after) - grown
    assert not lost, f"{len(lost)} cells stopped being reachable, e.g. {sorted(lost)[:5]}"
    print(f"{world_dir}: lava {len(before)} -> {len(lava)} cells "
          f"(+{len(grown)}); reachable ground {len(reach_before)} -> "
          f"{len(reach_after)} (the {len(grown)} grown cells, nothing else); "
          f"scenery untouched ({len(doc.get('scenery', []))} placements)")
    if write:
        json.dump(doc, open(path, "w"), separators=(",", ":"))
    return len(grown)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--apply", metavar="WORLD_DIR")
    ap.add_argument("--share", type=float, default=LAVA_SHARE)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.apply:
        apply(a.apply, a.share, write=not a.dry_run)
        return
    ap.print_help()


if __name__ == "__main__":
    main()
