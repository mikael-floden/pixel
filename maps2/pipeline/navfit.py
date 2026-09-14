"""NAV FIT — a footprint stands where the game's nav cells match it best.

THE RULE THIS REPLACES centred every hitbox on a cell centre (maintainer
2026-08-30: "the game will mark that spot in the nav as a tile we must
navigate around - so we want that ground we now have to navigate around to
match the scenery hitbox as good as possible"). That is right for a piece
smaller than a cell and wrong for a bigger one (maintainer 2026-09-13, beside
a cart whose rectangle spans two cells and whose nav diamond is one:
"centering will not always (bigger objects) make the nav and collision look
as similar as possible ... if we placed the scenery differently we might have
been able to change the nav grid for a better fit").

WHAT THE NAV IS (games2/shared/src/index.ts, stampSceneryCollision +
navCellOpen): the body collides with the drawn hitbox itself; a cell is
BLOCKED only when no body of PLAYER_RADIUS (12 wu of a 32 wu cell) fits
anywhere in it - sampled 4x4 per cell, then 8x8 inside every tile the coarse
pass cannot settle. So the nav is the hitbox GROWN by the body radius and cut
to whole cells, and which cells those are depends on where the hitbox sits
inside its cell. A cart 1.55 x 2.78 cells along the map diagonals blocks ONE
cell centred (its neighbours' far corners stick out of the grown box) and TWO
on a lattice corner; a big tree's 3.3 x 1.7 ellipse blocks one cell centred
and two when it straddles a cell edge - and two diamonds under a 150 px
canopy is what "the nav matches the hitbox" looks like.

THE FIT: for a shape (all the boxes the game stamps for the placement, in the
game's own arithmetic), every offset of its reference point on a lattice of
1/16 cell (2 wu, twice the bake's own pitch) is scored by the SYMMETRIC
DIFFERENCE between the cells the game would block and the drawn shape - the
area the nav claims outside the hitbox plus the area of the hitbox the nav
does not claim - and the least is taken, nearest the piece's current spot
among equals, the cell centre when nothing beats it. Evaluated on the game's
own sample lattice from one raster of the grown shape, so the answer is the
game's, not an approximation of it; `--check` stamps the shipped world with
this mirror and compares it cell for cell against a dump from the game.

Only the OFFSET is chosen here: what a piece may stand on, how far from a
wall, a cliff, a shore or another footprint, stays the footprint law in
world3grow.py, judged where the piece will actually stand.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(_HERE))
sys.path.insert(0, _HERE)
from sceneryscale import drawn_px               # noqa: E402  games2 sceneryDrawnPx

# THE GAME'S NUMBERS (games2/shared/src/index.ts). Retune there and copy -
# a number that lives in two files is a number that will disagree with itself.
DX, DY = 32.0, 14.0                  # ISO_GEOMETRY_MAPS3 - scenery draws on dy 14
CELL_WU = 32.0
PLAYER_RADIUS = 12.0                 # wu
MIN_SEMI = PLAYER_RADIUS * 0.375     # MIN_FOOTPRINT_SEMI: a footprint is never thinner
LEVEL_SLACK = 1.5                    # FOOTPRINT_LEVEL_SLACK: a piece blocks its own floor
RC = PLAYER_RADIUS / CELL_WU         # the body radius in cells
ROOT2 = math.sqrt(2.0)
DIR_GROUND_DEG = {"south": 0.0, "south-east": 45.0, "east": 90.0,
                  "north-east": 135.0, "north": 180.0, "north-west": -135.0,
                  "west": -90.0, "south-west": -45.0}
STEPS = 16                           # candidate offsets per axis: 1/16 cell = 2 wu
# navCellOpen's lattice, in 64ths of a cell (0.5 wu): the fine pass at every
# half wu, the coarse pass at 4, 12, 20 and 28 wu.
_FINE64 = np.arange(1, 64, 2)
_COARSE64 = np.array([8, 24, 40, 56])


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def hitbox_rec(hit, piece, state):
    """sceneryHitboxRec + the stamp's last resort: the drawn variation's
    record, else the piece's, else any variation's."""
    if state:
        own = hit.get(f"scenery/{piece}#{state}") or hit.get(f"scenery/{piece}#{state.lower()}")
        if own:
            return own
    rec = hit.get(f"scenery/{piece}")
    if rec:
        return rec
    pfx = f"scenery/{piece}#"
    for k, v in hit.items():
        if k.startswith(pfx):
            return v
    return None


def rect_ground_rot(b, d, hflip):
    """rectGroundRot: the piece's own ground turn plus the facing's step, his
    per-facing correction outranking both; hflip negates it."""
    own = (b.get("rot_by_dir") or {}).get(d)
    if _num(own):
        deg = float(own)
    else:
        deg = (float(b["rot"]) if _num(b.get("rot")) else 0.0) - DIR_GROUND_DEG.get(d, 0.0)
    return math.radians(-deg if hflip else deg)


def boxes_for(pl, bbox, hit):
    """The footprints the game stamps for ONE placement, each RELATIVE to the
    placement: (cx, cy, p, q, rect, cos, sin) with the centre in cells, the
    semi-axes p (along the (1,-1) diagonal) and q (along (1,1)) in cells, and
    the rect's ground turn. stampSceneryCollision's pass 1 to the letter;
    [] when the piece stamps nothing (on a wall, flat, no record, no art)."""
    if _num(pl.get("z")):
        return []
    facts = (bbox.get("pieces") or {}).get(pl["piece"])
    wph = drawn_px(facts.get("wph"), facts.get("cpx")) if facts else None
    if not facts or not wph:
        return []
    rec = hitbox_rec(hit, pl["piece"], pl.get("state"))
    nc = rec.get("no_collision") if rec else None
    if facts.get("flat") if nc is None else nc:
        return []
    bxs = (rec or {}).get("boxes")
    if not bxs:
        return []
    spr = ((facts.get("states") or {}).get(pl["state"]) if pl.get("state") else None) \
        or facts.get("sprite")
    bb = (bbox.get("boxes") or {}).get(spr) if spr else None
    if not bb:
        return []
    bx0, by0, bx1, by1, fw, fh = bb[:6]
    k = wph / max(1, by1 - by0)
    afx, afy = bx0 + max(1, bx1 - bx0) / 2.0, float(by1)
    d = pl.get("dir") or "south"
    hflip = bool(pl.get("hflip"))
    out = []
    for b in bxs:
        is_rect = b.get("shape") == "rect"
        szo = (b.get("size_by_dir") or {}).get(d) if is_rect else None
        pos = (b.get("pos_by_dir") or {}).get(d) if is_rect else None
        if pos is None:
            pos = {"ax": b.get("ax"), "ay": b.get("ay")}
        brx = szo["rx"] if szo and _num(szo.get("rx")) else b.get("rx")
        bry = szo["ry"] if szo and _num(szo.get("ry")) else b.get("ry")
        ax, ay = pos.get("ax"), pos.get("ay")
        if not (_num(ax) and _num(ay) and _num(brx) and _num(bry)):
            continue                           # the game's NaN arithmetic skips it
        th = rect_ground_rot(b, d, hflip) if is_rect else 0.0
        bcx = fw / 2.0 + (-ax if hflip else ax)
        bcy = fh / 2.0 + ay
        sx, sy = (bcx - afx) * k, (bcy - afy) * k
        wx = (sx / DX + sy / DY) / 2.0
        wy = (sy / DY - sx / DX) / 2.0
        rx, ry = brx * k, bry * k
        if not (rx > 0 and ry > 0):
            continue
        rx = max(rx, MIN_SEMI / CELL_WU * DX * ROOT2)
        ry = max(ry, MIN_SEMI / CELL_WU * DY * ROOT2)
        out.append((wx, wy, rx / (DX * ROOT2), ry / (DY * ROOT2), is_rect,
                    math.cos(th), math.sin(th)))
    return out


def reference(boxes):
    """The shape's reference point, relative to the placement: the
    area-weighted centroid of its boxes - the box centre for the common
    single-box piece."""
    w = [p * q for (_, _, p, q, _, _, _) in boxes]
    tw = sum(w) or 1.0
    return (sum(wi * b[0] for wi, b in zip(w, boxes)) / tw,
            sum(wi * b[1] for wi, b in zip(w, boxes)) / tw)


def _support(b):
    """The box's half-extent along a WORLD axis, in cells (the stamp's own
    bucket reach: the ellipse's sqrt((p^2+q^2)/2), the turned rect's
    (supX + supY)/sqrt2)."""
    _, _, p, q, rect, c, s = b
    if rect:
        ac, as_ = abs(c), abs(s)
        return (p * ac + q * as_ + p * as_ + q * ac) / ROOT2
    return math.sqrt((p * p + q * q) / 2.0)


def _ellipse_dist(p, q, ax, ay):
    """Distance from first-quadrant points (ax, ay) to the ellipse E(p, q) -
    closestOnEllipse (Eberly), bisected as the game bisects it."""
    swap = q > p
    e0, e1 = (q, p) if swap else (p, q)
    y0, y1 = (ay, ax) if swap else (ax, ay)
    nx = np.empty_like(y0)
    ny = np.empty_like(y0)
    A = (y1 > 0) & (y0 > 0)
    if A.any():
        z0, z1 = y0[A] / e0, y1[A] / e1
        g = z0 * z0 + z1 * z1 - 1
        r0 = (e0 / e1) ** 2
        n0 = r0 * z0
        s0 = z1 - 1
        s1 = np.where(g < 0, 0.0, np.hypot(n0, z1) - 1)
        for _ in range(30):
            s = (s0 + s1) / 2
            ratio0 = n0 / (s + r0)
            ratio1 = z1 / (s + 1)
            f = ratio0 * ratio0 + ratio1 * ratio1 - 1
            s0 = np.where(f > 0, s, s0)
            s1 = np.where(f < 0, s, s1)
        sbar = (s0 + s1) / 2
        gz = g != 0
        nx[A] = np.where(gz, (r0 * y0[A]) / (sbar + r0), y0[A])
        ny[A] = np.where(gz, y1[A] / (sbar + 1), y1[A])
    B = (y1 > 0) & ~(y0 > 0)
    nx[B] = 0.0
    ny[B] = e1
    C = ~(y1 > 0)
    if C.any():
        denom = e0 * e0 - e1 * e1
        numer = e0 * y0[C]
        lt = (numer < denom) if denom > 0 else np.zeros(numer.shape, bool)
        xde0 = numer / denom if denom > 0 else np.zeros(numer.shape)
        nx[C] = np.where(lt, e0 * xde0, e0)
        ny[C] = np.where(lt, e1 * np.sqrt(np.maximum(0.0, 1 - xde0 * xde0)), 0.0)
    return np.hypot(y0 - nx, y1 - ny)


def penetration(boxes, X, Y):
    """footprintDepth for a body of PLAYER_RADIUS centred at world points
    (X, Y) (cells, the boxes' frame): the deepest penetration over the boxes,
    in cells - positive means no body may stand there. The game's gates and
    its exact ellipse distance, so a sample is blocked here iff it is blocked
    there."""
    best = np.full(X.shape, -1.0)
    for (cx, cy, p, q, rect, c, s) in boxes:
        ox, oy = X - cx, Y - cy
        Xr = (ox - oy) / ROOT2
        Yr = (ox + oy) / ROOT2
        if rect:
            U = Xr * c + Yr * s
            V = c * Yr - s * Xr
            ex, ey = np.abs(U) - p, np.abs(V) - q
            inside = (ex <= 0) & (ey <= 0)
            dd = np.hypot(np.maximum(ex, 0.0), np.maximum(ey, 0.0))
            pen = np.where(inside, max(1e-12, RC), RC - dd)
        else:
            ax, ay = np.abs(Xr), np.abs(Yr)
            u, v = Xr / p, Yr / q
            g2 = u * u + v * v
            gu, gv = Xr / (p + RC), Yr / (q + RC)
            in_grown = gu * gu + gv * gv <= 1
            gate1 = (ax < p + RC) & (ay < q + RC)
            pen = np.full(X.shape, -1.0)
            pen = np.where(gate1 & (g2 <= 1), RC, pen)
            band = gate1 & (g2 > 1) & in_grown
            pen = np.where(band, np.maximum(1e-12, RC - (np.sqrt(g2) - 1) * max(p, q)), pen)
            lim = 1 + RC / min(p, q)
            exact = gate1 & (g2 > 1) & ~in_grown & (g2 <= lim * lim)
            if exact.any():
                pen[exact] = RC - _ellipse_dist(p, q, ax[exact], ay[exact])
        best = np.maximum(best, pen)
    return best


def inside(boxes, X, Y):
    """Is the point inside the drawn hitbox itself (the collision shape the
    overlay shows), any box."""
    out = np.zeros(X.shape, bool)
    for (cx, cy, p, q, rect, c, s) in boxes:
        ox, oy = X - cx, Y - cy
        Xr = (ox - oy) / ROOT2
        Yr = (ox + oy) / ROOT2
        if rect:
            U = Xr * c + Yr * s
            V = c * Yr - s * Xr
            out |= (np.abs(U) <= p) & (np.abs(V) <= q)
        else:
            out |= (Xr / p) ** 2 + (Yr / q) ** 2 <= 1
    return out


def _cell_lattice():
    """navCellOpen's sample points of ONE cell, in cells from its origin:
    the fine 32x32 at every half wu and the coarse 4x4 at 4, 12, 20, 28 wu."""
    f = _FINE64 / 64.0
    c = _COARSE64 / 64.0
    fx, fy = np.meshgrid(f, f, indexing="xy")
    cx, cy = np.meshgrid(c, c, indexing="xy")
    return (np.concatenate([fx.ravel(), cx.ravel()]),
            np.concatenate([fy.ravel(), cy.ravel()]))


_LAT_X, _LAT_Y = _cell_lattice()


def nav_cells(boxes, x, y, level=None):
    """The cells the game blocks for a placement at (x, y) with these boxes
    (relative), evaluated at that exact spot on the game's own lattice.
    `level(col, row)` supplies the terrain level when given, so a footprint
    blocks only its own floor (FOOTPRINT_LEVEL_SLACK) as the bake does.
    Returns a set of (col, row)."""
    if not boxes:
        return set()
    absb = [(x + b[0], y + b[1]) + b[2:] for b in boxes]
    reach = max(_support(b) + RC for b in absb)
    c0 = math.floor(min(b[0] for b in absb) - reach)
    c1 = math.floor(max(b[0] for b in absb) + reach)
    r0 = math.floor(min(b[1] for b in absb) - reach)
    r1 = math.floor(max(b[1] for b in absb) + reach)
    floors = [level(math.floor(b[0]), math.floor(b[1])) for b in absb] if level else None
    out = set()
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            use = absb
            if floors is not None:
                lv = level(c, r)
                use = [b for b, fl in zip(absb, floors) if abs(fl - lv) <= LEVEL_SLACK]
                if not use:
                    continue
            X = c + _LAT_X
            Y = r + _LAT_Y
            if (penetration(use, X, Y) > 0).all():
                out.add((c, r))
    return out


def area_in_cells(boxes, x, y, cells):
    """The hitbox's area inside each of `cells`, in cells, on the fine lattice
    - the game's own resolution for the shape."""
    absb = [(x + b[0], y + b[1]) + b[2:] for b in boxes]
    f = _FINE64 / 64.0
    fx, fy = np.meshgrid(f, f, indexing="xy")
    return {cr: float(inside(absb, cr[0] + fx, cr[1] + fy).mean()) for cr in cells}


def mismatch_at(boxes, x, y, level=None):
    """The symmetric difference, in cells, between the cells the game blocks
    for this placement and its drawn hitbox: the nav outside the hitbox plus
    the hitbox outside the nav."""
    if not boxes:
        return 0.0, set()
    blocked = nav_cells(boxes, x, y, level)
    absb = [(x + b[0], y + b[1]) + b[2:] for b in boxes]
    reach = max(_support(b) for b in absb) + 1
    cells = {(c, r)
             for r in range(math.floor(min(b[1] for b in absb) - reach),
                            math.floor(max(b[1] for b in absb) + reach) + 1)
             for c in range(math.floor(min(b[0] for b in absb) - reach),
                            math.floor(max(b[0] for b in absb) + reach) + 1)} | blocked
    area = area_in_cells(boxes, x, y, cells)
    return sum((1 - a) if cr in blocked else a for cr, a in area.items()), blocked


class Fit:
    """The mismatch of one SHAPE at every candidate offset of its reference
    point within a cell, from one raster of the grown shape on the game's
    lattice. Cached per shape by the caller; a shape's answer does not depend
    on where in the world it stands."""

    def __init__(self, boxes, steps=STEPS):
        assert 64 % steps == 0, "the offsets must land on the bake's half-wu lattice"
        self.steps = steps
        rx, ry = reference(boxes)
        self.ref = (rx, ry)
        rel = [(b[0] - rx, b[1] - ry) + b[2:] for b in boxes]
        reach = max(abs(b[0]) + _support(b) + RC for b in rel) if rel else 0.0
        reach = max(reach, max(abs(b[1]) + _support(b) + RC for b in rel) if rel else 0.0)
        H = int(math.ceil(reach)) + 1
        self.H = H
        xs = np.arange(-64 * H, 64 * H + 1) / 64.0
        X, Y = np.meshgrid(xs, xs, indexing="xy")
        self.pen = penetration(rel, X, Y) > 0
        self.shape = inside(rel, X, Y)
        # cells worth scoring: the ones the grown shape reaches; the rest are
        # neither blocked nor inside the hitbox at any offset
        n = self.steps
        self.table = np.zeros((n, n))
        span = range(-H, H)
        for i in range(n):
            for j in range(n):
                ox, oy = 64 * i // n, 64 * j // n
                total = 0.0
                for a in span:
                    xa = 64 * a + 64 * H - ox
                    if xa < 0 or xa + 64 > self.pen.shape[1]:
                        continue
                    for b in span:
                        yb = 64 * b + 64 * H - oy
                        if yb < 0 or yb + 64 > self.pen.shape[0]:
                            continue
                        fine = self.pen[yb + 1:yb + 64:2, xa + 1:xa + 64:2]
                        if not fine.any():
                            continue      # the grown shape misses this cell
                        area = float(self.shape[yb + 1:yb + 64:2, xa + 1:xa + 64:2].mean())
                        blocked = fine.all() and \
                            self.pen[yb + 8:yb + 64:16, xa + 8:xa + 64:16].all()
                        total += (1.0 - area) if blocked else area
                self.table[i, j] = total

    def best(self, near=(0.5, 0.5)):
        """(fx, fy, mismatch): the least-mismatch offset, the one nearest
        `near` (a fraction of a cell, circular) among equals; the cell centre
        whenever it is one of them."""
        n = self.steps
        lo = self.table.min()
        cands = [(i, j) for i in range(n) for j in range(n)
                 if self.table[i, j] <= lo + 1e-9]
        centre = (n // 2, n // 2)
        if centre in cands:
            return 0.5, 0.5, float(lo)

        def dist(ij):
            dx = abs(ij[0] / n - near[0]) % 1.0
            dy = abs(ij[1] / n - near[1]) % 1.0
            return min(dx, 1 - dx) ** 2 + min(dy, 1 - dy) ** 2
        i, j = min(cands, key=lambda ij: (dist(ij), ij))
        return i / n, j / n, float(lo)

    def at(self, fx, fy):
        n = self.steps
        return float(self.table[int(round(fx * n)) % n, int(round(fy * n)) % n])


def shape_key(pl):
    return (pl["piece"], pl.get("state"), pl.get("dir") or "south", bool(pl.get("hflip")))


_FITS = {}


def fit_for(pl, boxes):
    k = shape_key(pl)
    f = _FITS.get(k)
    if f is None:
        f = _FITS[k] = Fit(boxes)
    return f


def target(pl, boxes, x, y):
    """Where the placement's ANCHOR should stand so its footprint's reference
    point sits at the best offset of the cell it is in, nearest to (x, y):
    (nx, ny, fx, fy, mismatch, mismatch_centred)."""
    f = fit_for(pl, boxes)
    rx, ry = f.ref
    wx, wy = x + rx, y + ry
    cx, cy = math.floor(wx), math.floor(wy)
    fx, fy, m = f.best((wx - cx, wy - cy))
    # the lattice translation nearest the current spot: never a whole cell away
    tx = min((cx + fx + k for k in (-1, 0, 1)), key=lambda t: abs(t - wx))
    ty = min((cy + fy + k for k in (-1, 0, 1)), key=lambda t: abs(t - wy))
    return tx - rx, ty - ry, fx, fy, m, f.at(0.5, 0.5)


def load_docs():
    bbox = json.load(open(os.path.join(REPO, "games2", "config", "scenery-bbox.json")))
    hit = json.load(open(os.path.join(REPO, "live", "tuning", "scenery_hitbox.json"))).get("overrides", {})
    return bbox, hit


def check(world_dir, game_dump=None, verbose=False):
    """Stamp the shipped world with this mirror; against a dump from the game
    (a JSON list of {i, cells:[[col,row]...]} per placement, stamped one piece
    at a time), report every disagreement. Prints the totals either way."""
    doc = json.load(open(os.path.join(world_dir, "world.json")))
    bbox, hit = load_docs()
    lvl = doc["level"]
    W, H = doc["size"]["w"], doc["size"]["h"]

    def level(c, r):
        return lvl[r][c] if 0 <= c < W and 0 <= r < H else 0
    game = None
    if game_dump:
        game = {e["i"]: {tuple(c) for c in e["cells"]} for e in json.load(open(game_dump))["items"]}
    n_fp = n_zero = 0
    tot_cells = 0
    tot_mis = tot_mis_centre = 0.0
    disagree = []
    for i, pl in enumerate(doc["scenery"]):
        bx = boxes_for(pl, bbox, hit)
        if not bx:
            if game is not None and game.get(i):
                disagree.append((i, pl["piece"], "game blocks, mirror has no footprint"))
            continue
        n_fp += 1
        m, blocked = mismatch_at(bx, pl["x"], pl["y"], level)
        tot_mis += m
        tot_cells += len(blocked)
        if not blocked:
            n_zero += 1
        if game is not None and game.get(i, set()) != blocked:
            disagree.append((i, pl["piece"], f"game {sorted(game.get(i, set()))} mirror {sorted(blocked)}"))
    print(f"{world_dir}: {len(doc['scenery'])} placements, {n_fp} with a footprint, "
          f"{tot_cells} nav cells, {n_zero} footprints blocking no cell, "
          f"nav/hitbox mismatch {tot_mis:.1f} cells ({tot_mis / max(1, n_fp):.3f} per footprint)")
    if game is not None:
        print(f"against the game's dump: {len(disagree)} placements disagree")
        for d in disagree[:20 if not verbose else None]:
            print("   ", d)
    return disagree


def _thresholds(doc):
    """The doorway cells of every house, as the build knows them: a roof deck's
    ring cell with no wall under it, the step outside it and the cell inside.
    Reconstructed from the shipped world (the build's own list does not ship)."""
    walls = {(c["x"], c["y"]) for w in doc.get("walls", []) if w.get("kind") != "cliff"
             for c in w["cells"]}
    out = set()
    for d in doc.get("decks", []):
        if d.get("kind") != "roof":
            continue
        cells = {(c["x"], c["y"]) for c in d["cells"]}
        for (x, y) in cells:
            outside = [(nx, ny) for (nx, ny) in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
                       if (nx, ny) not in cells]
            if not outside or (x, y) in walls:
                continue
            out.add((x, y))
            out.update(outside)
            out.update((nx, ny) for (nx, ny) in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
                       if (nx, ny) in cells and (nx, ny) not in walls)
    return out


def _cave_floor(doc):
    lvl = doc["level"]
    out = {}
    for d in doc.get("decks", []):
        if d.get("kind") != "cave":
            continue
        for c in d["cells"]:
            if lvl[c["y"]][c["x"]] < d["level"]:
                out[(c["x"], c["y"])] = d["level"]
    return out


def apply(world_dir, write=True):
    """RE-FIT THE PUBLISHED WORLD'S PLACEMENTS IN PLACE — no rebuild, no
    re-roll: every piece keeps what it is (piece, variation, facing, flip)
    and only the footprints the old rule had centred move, each to its
    nav-fit offset, each judged there by the generator's own footprint law
    (walls, doorways, level, shore, the gap to every other footprint, the
    art over a drop) and left where it was when the law says no.

    A rebuild re-dresses the map (the variations are drawn per build), so
    a placement-rule change reaches the shipped world THROUGH THIS, never
    through world3grow.py (maintainer 2026-09-13: "I was asking for a
    placement correction only")."""
    import world3grow as W
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    bbox, hit = load_docs()
    g = W.Grow.__new__(W.Grow)
    g.doc, g.G = doc, doc["grounds"]
    g.gi = {n: i for i, n in enumerate(g.G)}
    g.grd, g.lvl = doc["ground"], doc["level"]
    g._bbox, g._hit, g._fp = bbox, hit, {}
    g.door_cells = _thresholds(doc)
    g.cave_floor = _cave_floor(doc)
    W.NEW = min(doc["size"]["w"], doc["size"]["h"])      # the shipped world's bounds
    rooms = {(c["x"], c["y"]) for r in doc.get("rooms", []) for c in r.get("cells", [])}
    sc = doc["scenery"]
    order = sorted(range(len(sc)), key=lambda i: (round(sc[i]["x"] + sc[i]["y"], 3), sc[i]["piece"]))

    def shape(p):
        sh = g._fp_shape(p)
        if sh:
            kind, dwx, dwy, hx, hy = sh
            return p["x"] + dwx, p["y"] + dwy, (hx, hy) if kind == "rect" else (hx, None)
        return int(p["x"]) + 0.5, int(p["y"]) + 0.5, (g.FP_DEFAULT, None)

    def ok_at(p, x, y):
        q = dict(p, x=x, y=y)
        wx, wy, (R, HY) = shape(q)
        return g._art_clear(p["piece"], x, y, p.get("state")) and \
            g._footprint_ok(wx, wy, R, HY, flush=True, flat=False)

    movable = {}
    for i in order:
        p = sc[i]
        if p.get("z") is not None:
            continue
        bx = boxes_for(p, bbox, hit)
        off = g._hitbox_offset(p)          # the old rule's own arithmetic
        if not bx or off is None:
            continue
        fx, fy = (p["x"] + off[0]) % 1.0, (p["y"] + off[1]) % 1.0
        if abs(fx - 0.5) < 1e-3 and abs(fy - 0.5) < 1e-3:   # the old rule's signature
            movable[i] = bx
    # every piece that stays claims its ground first
    for i in order:
        p = sc[i]
        if p.get("z") is not None or i in movable or g._flat(p):
            continue
        wx, wy, (R, HY) = shape(p)
        g._fp_add(wx, wy, R, HY)
    moved, kept, refused, old = 0, 0, 0, {}
    why = {}
    for i in order:
        if i not in movable:
            continue
        p = sc[i]
        nx, ny, _fx, _fy, m, mc = target(p, movable[i], p["x"], p["y"])
        nx, ny = round(nx, 4), round(ny, 4)
        reason = None
        if abs(nx - p["x"]) < 1e-6 and abs(ny - p["y"]) < 1e-6:
            kept += 1
            continue
        if ((int(nx), int(ny)) in rooms) != ((int(p["x"]), int(p["y"])) in rooms):
            reason = "room boundary"
        elif not g.g(int(nx), int(ny)) or g.liquid(int(nx), int(ny)):
            reason = "water/void"
        elif not g._art_clear(p["piece"], nx, ny, p.get("state")):
            reason = "art over a drop"
        elif not ok_at(p, nx, ny):
            reason = "footprint law"
        if reason:
            refused += 1
            why[reason] = why.get(reason, 0) + 1
        else:
            old[i] = (p["x"], p["y"])
            p["x"], p["y"] = nx, ny
            moved += 1
        wx, wy, (R, HY) = shape(p)
        g._fp_add(wx, wy, R, HY)
    # the law over the whole world at its final positions; a moved piece the
    # neighbours it was judged before now crowd goes back where it was
    for _round in range(6):
        # as police_footprints judges: in order, each piece against the ones
        # already claiming ground, then it claims its own
        g._fp = {}
        reverted = 0
        for i in order:
            p = sc[i]
            if p.get("z") is not None or g._flat(p):
                continue
            if i in old and not ok_at(p, p["x"], p["y"]):
                p["x"], p["y"] = old.pop(i)
                moved -= 1
                refused += 1
                why["crowded after the move"] = why.get("crowded after the move", 0) + 1
                reverted += 1
            wx, wy, (R, HY) = shape(p)
            g._fp_add(wx, wy, R, HY)
        if not reverted:
            break
    print(f"{world_dir}: {len(sc)} placements, {len(movable)} on the old rule's cell centre: "
          f"{moved} moved to their nav-fit offset, {kept} kept (the centre is best), "
          f"{refused} refused at the new spot {why}; nothing else changed")
    if write:
        json.dump(doc, open(path, "w"), separators=(",", ":"))
    return moved


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check", metavar="WORLD_DIR")
    ap.add_argument("--game", metavar="DUMP_JSON", help="per-placement nav cells from the game")
    ap.add_argument("--apply", metavar="WORLD_DIR", help="re-fit the published world's placements in place")
    ap.add_argument("-v", action="store_true")
    a = ap.parse_args()
    if a.apply:
        apply(a.apply)
        return
    if a.check:
        bad = check(a.check, a.game, a.v)
        sys.exit(1 if bad else 0)
    ap.print_help()


if __name__ == "__main__":
    main()
