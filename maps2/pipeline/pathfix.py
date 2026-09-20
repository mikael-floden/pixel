"""A PIECE NEVER CUTS THE WAY - in place, on the shipped world.

Maintainer 2026-09-20, at 300.7,198.2 in front of the south-eastern cottage:
*"When you place scenery, please try to think if you are blocking a critical
path. I can't walk top-left here because you have placed so much stuff and
blocked the only path."* A lantern post, a water pump, a barrel and a
woodpile stood in a row across the two-cell lane between the house's apron
and the terrace behind it: every piece was lawful on its own (no wall, no
doorway, no drop, its gap to its neighbours kept) and together they were a
fence.

THE RULE: the walkable cells around a footprint must still meet each other
by a SHORT walk. Take the piece's nav cells as the game blocks them
(navfit.nav_cells: the game's lattice, the piece's own level), the walkable
cells 4-adjacent to them, and walk from each within NEAR cells of the
footprint over everything else the world blocks (walls, water, drops, the
other pieces). If they fall into two groups that cannot reach each other
inside that box, the piece is a CUT: the way past it is a detour longer
than a player will find. A cut piece SLIDES to the nearest spot (STEP
apart, SLIDE at most) that keeps the footprint law (walls, doorways, level,
shore, the gap to every other footprint, the art over a drop), keeps its
room, and cuts nothing there; a piece with nowhere to go within SLIDE looks
SLIDE_FAR on the next round and then goes, by name - a clump of reeds is
not worth the only way through the marsh. Rounds repeat until nothing cuts
- moving one piece can leave its neighbour as the last plank of the fence.
The walk is judged with COMFORT: a way is not a squeeze along the wall.

THE APRON IS THE WAY ROUND THE HOUSE: the paving ring against a house wall
is one cell wide, so a piece whose reach touches it stands in the walkway
and moves off it, whatever detour exists - the door is where the player is.

`world3grow.run` ends with this pass, so no build ships a fence.

    python3 maps2/pipeline/pathfix.py maps2/worlds3/the_game --check
    python3 maps2/pipeline/pathfix.py maps2/worlds3/the_game --apply
"""
from __future__ import annotations

import json
import math
import os
import sys

import numpy as np
from scipy import ndimage as ndi

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import navfit  # noqa: E402

NEAR = 8            # the search box either side of a footprint, in cells
WALKS = 6           # the two sides must meet within this many cells of WALKING past the piece
MINSIDE = 6         # a side is a WAY only if that many cells lie beyond it; a one-cell nook is not
COMFORT = 1         # sample points of slack past a footprint's reach: a way is not a squeeze
SLIDE_FAR = 5.0     # a piece that finds nothing within SLIDE looks this far, then it goes
MAXCREW = 5         # an obstacle of more pieces than this is terrain (a wood, a stone field), not a fence
STEP = 0.5          # candidate spacing when a piece slides, in cells
SLIDE = 3.0         # how far a piece may slide, in cells
WALK_CLIMB = 1      # games2/shared: a passive step up; a corridor is walked both ways
ROUNDS = 6
N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))


class Walk:
    """The base surface AS THE BODY WALKS IT, not as the pathfinder counts it.
    The player is a disc of PLAYER_RADIUS (12 wu, 0.375 cell) and the game
    blocks a point when its cell is a nav cell (`propBlocked`) OR the disc
    penetrates a footprint there (isBlockedAtWorld -> footprintBlocks, the
    raw ellipse at the probe point). A lantern post blocks no whole cell and
    still stops a body: measured at the south-eastern cottage, four pieces in
    a two-cell lane left 0 nav cells blocked and no way through. So the walk
    is sampled S x S points per cell; a point is open when its cell has
    ground, is dry, is not a wall, is not sealed under a slab, is nobody's
    nav cell, and no footprint reaches it (navfit.penetration <= 0 - the
    game's own distance, a piece blocking only its own floor). Scenery is a
    count per point so one piece can be lifted and put back."""

    S = 4                       # samples per cell per axis: 8 wu apart, a body is 24 wu across

    def __init__(self, doc, g):
        self.N = doc["size"]["w"]
        self.lvl = np.array(doc["level"], np.int16)
        walls = g._walls()
        deck, thick = {}, {}
        for dk in doc.get("decks", []):
            lv, th = int(dk["level"]), int(dk.get("thickness", 1))
            for c in dk["cells"]:
                k = (c["x"], c["y"])
                if lv > deck.get(k, -1):
                    deck[k], thick[k] = lv, th
        self.ok = np.zeros((self.N, self.N), bool)
        for y in range(self.N):
            for x in range(self.N):
                if not g.g(x, y) or g.liquid(x, y) or (x, y) in walls:
                    continue
                d = deck.get((x, y))
                if d is not None and d > self.lvl[y, x] and self.lvl[y, x] >= d - thick[(x, y)]:
                    continue
                self.ok[y, x] = True
        S = self.S
        # THE APRON IS THE WAY ROUND THE HOUSE: the paving ring against a
        # house wall is one cell wide, so anything standing on it stands in
        # the walkway (the lantern post beside the cottage door). A piece
        # whose reach touches an apron cell is in the way, whatever the
        # detour: the door is where the player IS.
        # OUTDOORS ONLY: a room's floor is paved too, and a cupboard against
        # the inner wall is where it belongs.
        paving = {g.gi[n] for n in ("grey_paving_stone", "brown_paving_stone") if n in g.gi}
        indoors = {(c["x"], c["y"]) for r in doc.get("rooms", []) for c in r.get("cells", [])}
        indoors |= {(c["x"], c["y"]) for dk in doc.get("decks", []) if dk.get("kind") == "roof" for c in dk["cells"]}
        self.lane = np.zeros((self.N, self.N), bool)
        for (wx, wy) in walls:
            for dx, dy in N4:
                x, y = wx + dx, wy + dy
                if self.inside(x, y) and doc["ground"][y][x] in paving and (x, y) not in walls \
                        and (x, y) not in indoors:
                    self.lane[y, x] = True
        self.indoors = indoors
        self.cellblk = np.zeros((self.N, self.N), np.int16)          # nav cells, per cell
        self.blk = np.zeros((self.N * S, self.N * S), np.int16)      # footprint reach, per point
        self.pts = {}                                                # piece -> (rows, cols) of its points

    def inside(self, x, y):
        return 0 <= x < self.N and 0 <= y < self.N

    def level(self, c, r):
        return int(self.lvl[r, c]) if self.inside(c, r) else 0

    def points_of(self, boxes, x, y):
        """The lattice points a placement's footprints reach for a body, on
        the placement's own floor (LEVEL_SLACK), as (rows, cols)."""
        S = self.S
        absb = [(x + b[0], y + b[1]) + b[2:] for b in boxes]
        reach = max(navfit._support(b) + navfit.RC for b in absb) + 0.5
        c0 = max(0, math.floor(min(b[0] for b in absb) - reach))
        c1 = min(self.N - 1, math.floor(max(b[0] for b in absb) + reach))
        r0 = max(0, math.floor(min(b[1] for b in absb) - reach))
        r1 = min(self.N - 1, math.floor(max(b[1] for b in absb) + reach))
        if c1 < c0 or r1 < r0:
            return np.zeros(0, np.int64), np.zeros(0, np.int64)
        floors = [self.level(math.floor(b[0]), math.floor(b[1])) for b in absb]
        px = c0 + (np.arange((c1 - c0 + 1) * S) + 0.5) / S
        py = r0 + (np.arange((r1 - r0 + 1) * S) + 0.5) / S
        X, Y = np.meshgrid(px, py, indexing="xy")
        hit = np.zeros(X.shape, bool)
        cell_lv = self.lvl[r0:r1 + 1, c0:c1 + 1]
        lvpts = np.repeat(np.repeat(cell_lv, S, axis=0), S, axis=1)
        for b, fl in zip(absb, floors):
            pen = navfit.penetration([b], X, Y)
            hit |= (pen > 0) & (np.abs(lvpts - fl) <= navfit.LEVEL_SLACK)
        rr, cc = np.nonzero(hit)
        return rr + r0 * S, cc + c0 * S

    def add(self, i, pts, cells):
        self.pts[i] = pts
        self.blk[pts] += 1
        for c in cells:
            self.cellblk[c[1], c[0]] += 1

    def remove(self, i, cells):
        self.blk[self.pts[i]] -= 1
        for c in cells:
            self.cellblk[c[1], c[0]] -= 1
        del self.pts[i]

    def open_box(self, r0, r1, c0, c1, floor):
        """Open points in a cell box, on floors a step from `floor`."""
        S = self.S
        cell_ok = self.ok[r0:r1 + 1, c0:c1 + 1] & (self.cellblk[r0:r1 + 1, c0:c1 + 1] == 0) \
            & (np.abs(self.lvl[r0:r1 + 1, c0:c1 + 1] - floor) <= WALK_CLIMB)
        o = np.repeat(np.repeat(cell_ok, S, axis=0), S, axis=1)
        reach = self.blk[r0 * S:(r1 + 1) * S, c0 * S:(c1 + 1) * S] > 0
        # A WAY IS NOT A SQUEEZE: the body's centre may pass a footprint at
        # exactly its radius, and it does, sliding along the pump with the
        # wall at its back. One sample of slack (8 wu) either side of every
        # footprint's reach is what makes a passage a passage.
        if COMFORT:
            reach = ndi.binary_dilation(reach, structure=[[0, 1, 0], [1, 1, 1], [0, 1, 0]], iterations=COMFORT)
        return o & ~reach

    CROSS = [[0, 1, 0], [1, 1, 1], [0, 1, 0]]

    def cluster(self, pts, floor):
        """THE OBSTACLE IS THE CLUSTER, NOT THE PIECE. A lantern post, a pump
        and a woodpile whose comfort zones touch are one fence: each alone
        has open ground on one side only (the other side is its neighbour's
        zone), so each alone passes, and together they close the lane. The
        obstacle a piece belongs to is the connected run of every zone its
        zone touches, inside the NEAR box. Returns (mask, r0, c0, open)."""
        rr, cc = pts
        S = self.S
        r0 = max(0, rr.min() // S - NEAR); r1 = min(self.N - 1, rr.max() // S + NEAR)
        c0 = max(0, cc.min() // S - NEAR); c1 = min(self.N - 1, cc.max() // S + NEAR)
        o = self.open_box(r0, r1, c0, c1, floor)
        zone = self.blk[r0 * S:(r1 + 1) * S, c0 * S:(c1 + 1) * S] > 0
        if COMFORT:
            zone = ndi.binary_dilation(zone, structure=self.CROSS, iterations=COMFORT)
        z = np.zeros(zone.shape, bool)
        z[rr - r0 * S, cc - c0 * S] = True
        lab, n = ndi.label(zone, structure=self.CROSS)
        ks = np.unique(lab[z & zone])
        Z = np.isin(lab, ks[ks > 0])
        return Z, r0, c0, o

    def groups(self, pts, floor):
        """The open points beside a piece's obstacle, grouped by who can reach
        whom within WALKS cells of walking, as (points beside, cells within
        that walk). The walk is GEODESIC - the ground grown step by step from
        the obstacle's rim through open points - so a way round the whole
        house does not count as the sides meeting: that is the detour the
        player never finds (maintainer 2026-09-20). A group with fewer than
        MINSIDE cells behind it is a nook the piece fills, not a way it cuts
        (a brazier in a cave wall's niche)."""
        if not len(pts[0]):
            return []
        S = self.S
        Z, r0, c0, o = self.cluster(pts, floor)
        beside = ndi.binary_dilation(Z, structure=self.CROSS) & ~Z & o
        if beside.sum() < 2:
            return []
        ball = ndi.binary_dilation(beside, structure=self.CROSS, iterations=WALKS * S, mask=o)
        lab, n = ndi.label(ball, structure=self.CROSS)
        out = []
        for k in np.unique(lab[beside]):
            if k == 0:
                continue
            comp = lab == k
            out.append((int((beside & comp).sum()), (comp.sum()) / (S * S)))
        return out

    def ways(self, pts, floor):
        """How many separate WAYS the obstacle this footprint belongs to stands between."""
        return sum(1 for _a, n in self.groups(pts, floor) if n >= MINSIDE)

    def on_lane(self, pts):
        """Does this footprint's reach touch the apron round a house?"""
        rr, cc = pts
        return bool(len(rr)) and bool(self.lane[rr // self.S, cc // self.S].any())

    def members(self, pts, floor, candidates):
        """Which of `candidates` (piece ids) stand in this footprint's obstacle."""
        Z, r0, c0, _o = self.cluster(pts, floor)
        S = self.S
        out = []
        for j in candidates:
            if j not in self.pts:
                continue
            jr, jc = self.pts[j]
            rr, cc = jr - r0 * S, jc - c0 * S
            ok = (rr >= 0) & (cc >= 0) & (rr < Z.shape[0]) & (cc < Z.shape[1])
            if ok.any() and Z[rr[ok], cc[ok]].any():
                out.append(j)
        return out


def cut_free(walk, pts, floor):
    """True when the ground beside a footprint's obstacle still meets itself
    by a short walk with the footprint standing - the rule a placement must
    pass."""
    return walk.ways(pts, floor) <= 1


def _grow(doc, bbox, hit):
    import world3grow as W
    g = W.Grow.__new__(W.Grow)
    g.doc, g.G = doc, doc["grounds"]
    g.gi = {n: i for i, n in enumerate(g.G)}
    g.grd, g.lvl = doc["ground"], doc["level"]
    g._bbox, g._hit, g._fp = bbox, hit, {}
    g.door_cells = navfit._thresholds(doc)
    g.cave_floor = navfit._cave_floor(doc)
    W.NEW = min(doc["size"]["w"], doc["size"]["h"])
    return g


def run(world_dir, write):
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    bbox, hit = navfit.load_docs()
    g = _grow(doc, bbox, hit)
    sc = doc["scenery"]
    rooms = {(c["x"], c["y"]) for r in doc.get("rooms", []) for c in r.get("cells", [])}
    npc_cells = set()
    npcf = os.path.join(world_dir, "npcs.json")
    if os.path.isfile(npcf):
        npc_cells = {(int(n["x"]), int(n["y"])) for n in json.load(open(npcf)).get("npcs", [])}
    walk = Walk(doc, g)
    level = walk.level

    def shape(p):
        sh = g._fp_shape(p)
        if sh:
            kind, dwx, dwy, hx, hy = sh
            return p["x"] + dwx, p["y"] + dwy, (hx, hy) if kind == "rect" else (hx, None)
        return int(p["x"]) + 0.5, int(p["y"]) + 0.5, (g.FP_DEFAULT, None)

    # every piece's nav cells and reach points, and the footprint registry the law reads
    boxes, cells, floor, fpkey = {}, {}, {}, {}
    for i, p in enumerate(sc):
        if p.get("z") is not None or g._flat(p):
            continue
        bx = navfit.boxes_for(p, bbox, hit)
        if not bx:
            continue
        boxes[i] = bx
        cells[i] = navfit.nav_cells(bx, p["x"], p["y"], level)
        floor[i] = level(int(p["x"]), int(p["y"]))
        walk.add(i, walk.points_of(bx, p["x"], p["y"]), cells[i])
    for i, p in enumerate(sc):
        if p.get("z") is not None or g._flat(p):
            continue
        wx, wy, (R, HY) = shape(p)
        g._fp_add(wx, wy, R, HY)
        fpkey[i] = ((int(wx) // 4, int(wy) // 4), (wx, wy, R, R if HY is None else HY))

    def lift_fp(i):
        k, e = fpkey[i]
        g._fp[k].remove(e)

    def place_fp(i, p):
        wx, wy, (R, HY) = shape(p)
        g._fp_add(wx, wy, R, HY)
        fpkey[i] = ((int(wx) // 4, int(wy) // 4), (wx, wy, R, R if HY is None else HY))

    def lawful(p, x, y):
        q = dict(p, x=x, y=y)
        if ((int(x), int(y)) in rooms) != ((int(p["x"]), int(p["y"])) in rooms):
            return False
        if not g.g(int(x), int(y)) or g.liquid(int(x), int(y)):
            return False
        if not g._art_clear(p["piece"], x, y, p.get("state")):
            return False
        wx, wy, (R, HY) = shape(q)
        return g._footprint_ok(wx, wy, R, HY, flush=True, flat=False)

    def spiral(limit):
        return sorted(
            {(round(dx * STEP, 4), round(dy * STEP, 4))
             for dx in range(-int(limit / STEP), int(limit / STEP) + 1)
             for dy in range(-int(limit / STEP), int(limit / STEP) + 1)
             if (dx or dy) and math.hypot(dx * STEP, dy * STEP) <= limit + 1e-9},
            key=lambda o: (math.hypot(*o), abs(o[0]) + abs(o[1])))
    offsets, offsets_far = spiral(SLIDE), spiral(SLIDE_FAR)

    def crew_of(i):
        return walk.members(walk.pts[i], floor[i], list(cells))

    def is_cut(i):
        # a piece on the apron is in the way; a fence of a few pieces is
        # mended; a wood of many is walked round
        if walk.on_lane(walk.pts[i]):
            return True
        return walk.ways(walk.pts[i], floor[i]) >= 2 and len(crew_of(i)) <= MAXCREW

    door_set = set(g.door_cells)

    def try_move(i, far):
        """Slide piece i to the nearest lawful spot where its obstacle - old
        and new - cuts nothing. Returns the new (x, y) or None; the piece is
        left standing where it was on None."""
        p = sc[i]
        old_pts, old_cells = walk.pts[i], cells[i]
        others = [j for j in walk.members(old_pts, floor[i], list(cells)) if j != i]
        walk.remove(i, old_cells)
        lift_fp(i)
        def judge(nx, ny):
            """The spot passes the footprint law, keeps off doors, NPCs, the
            apron and other pieces' nav cells, and cuts nothing there."""
            if not walk.inside(int(nx), int(ny)) or not lawful(p, nx, ny):
                return None
            F = navfit.nav_cells(boxes[i], nx, ny, level)
            if F & door_set or F & npc_cells:
                return None
            if any(not walk.ok[c[1], c[0]] or walk.cellblk[c[1], c[0]] for c in F):
                return None
            pts = walk.points_of(boxes[i], nx, ny)
            if walk.on_lane(pts):
                return None
            walk.add(i, pts, F)
            fl = level(int(nx), int(ny))
            ok = cut_free(walk, pts, fl) and all(cut_free(walk, walk.pts[j], floor[j]) for j in others)
            walk.remove(i, F)
            return (nx, ny, F, pts, fl) if ok else None

        found = None
        for dx, dy in (offsets_far if far else offsets):
            nx, ny = round(p["x"] + dx, 4), round(p["y"] + dy, 4)
            hit_ = judge(nx, ny)
            if not hit_:
                continue
            # THE NAV-FIT LAW STILL HOLDS (spec -> a placement stands where the
            # game's nav matches its hitbox): the landing spot is refined to
            # the nav-fit offset nearest it, when that offset passes the same
            # judgement; the half-cell spot stands otherwise.
            try:
                tx, ty = navfit.target(p, boxes[i], nx, ny)[:2]
                fine = judge(round(tx, 4), round(ty, 4))
            except Exception:
                fine = None
            found = fine or hit_
            break
        if not found:
            walk.add(i, old_pts, old_cells)
            place_fp(i, p)
            return None
        nx, ny, F, pts, fl = found
        p["x"], p["y"] = nx, ny
        cells[i], floor[i] = F, fl
        walk.add(i, pts, F)
        place_fp(i, p)
        moved[i] = moved.get(i, 0) + 1
        return nx, ny

    moved, moves, removed = {}, [], []
    if write:
        for rnd in range(ROUNDS):
            cuts = [i for i in cells if is_cut(i)]
            if not cuts:
                break
            progress = 0
            for i in cuts:
                if i not in cells or not is_cut(i):
                    continue                      # mended with a neighbour already
                # the obstacle's members, cheapest to move first - and a
                # piece ON the apron is itself the one to move
                crew = [i] if walk.on_lane(walk.pts[i]) else \
                    sorted(crew_of(i), key=lambda j: (moved.get(j, 0), len(walk.pts[j][0])))
                done = False
                for j in crew:
                    if moved.get(j, 0) >= 2:
                        continue
                    was = (sc[j]["x"], sc[j]["y"])
                    at = try_move(j, far=rnd > 0)
                    if at:
                        moves.append((sc[j]["piece"], sc[j].get("state"), was, at, rnd))
                        progress += 1
                        done = True
                        break
                if not done and rnd >= 2:
                    # NOWHERE, for any of them: the smallest DRESSING goes, and is
                    # named - a clump of reeds is not worth the only way through the
                    # marsh. Never a fire (its chimney and its light stand on it)
                    # and never a room's furniture: those are reported instead.
                    keep = ("hearths/", "braziers/")
                    goers = [j for j in crew if not sc[j]["piece"].startswith(keep)
                             and (int(sc[j]["x"]), int(sc[j]["y"])) not in walk.indoors]
                    if not goers:
                        continue
                    j = goers[0]
                    p = sc[j]
                    removed.append((p["piece"], p.get("state"), (p["x"], p["y"])))
                    walk.remove(j, cells[j])
                    lift_fp(j)
                    del cells[j], boxes[j], floor[j], fpkey[j]
                    p["_gone"] = True
                    progress += 1
            if not progress:
                break
        if removed:
            doc["scenery"] = [p for p in sc if not p.get("_gone")]
    left = [i for i in cells if is_cut(i)]
    if write:
        json.dump(doc, open(path, "w"), separators=(",", ":"))
    return doc, moves, left, removed, walk, cells, floor


def main():
    world_dir = sys.argv[1]
    apply = "--apply" in sys.argv
    doc, moves, left, removed, walk, cells, floor = run(world_dir, apply)
    sc = doc["scenery"]
    seen = set()
    for i in left:
        if i in seen:
            continue
        crew = walk.members(walk.pts[i], floor[i], list(cells))
        seen.update(crew)
        p = sc[i]
        lane = " ON THE APRON;" if walk.on_lane(walk.pts[i]) else ""
        print(f"  CUT  {p['piece']:36s} {p.get('state', ''):12s} at {p['x']:.2f},{p['y']:.2f} {lane} "
              f"with {len(crew) - 1} more; ways: {[(a, round(n, 1)) for a, n in walk.groups(walk.pts[i], floor[i]) if n >= MINSIDE]}")
    for piece, state, a, b, rnd in moves:
        print(f"  moved {piece:36s} {state or '':12s} {a[0]:.2f},{a[1]:.2f} -> {b[0]:.2f},{b[1]:.2f}  (round {rnd + 1})")
    for piece, state, a in removed:
        print(f"  REMOVED {piece:34s} {state or '':12s} at {a[0]:.2f},{a[1]:.2f}: nowhere within {SLIDE_FAR} cells")
    print(f"{world_dir}: {len(cells)} standing pieces, {len(moves)} moved, {len(removed)} removed, {len(left)} still cut")
    if apply:
        print("wrote world.json")
    if left:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
