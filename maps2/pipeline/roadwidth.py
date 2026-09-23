"""A ROAD IS AS WIDE ON SCREEN WHICHEVER WAY IT RUNS.

Maintainer 2026-09-23, beside the road at 247,240: *"I feel you draw the road
narrower when you draw it 100% horizontally vs when you draw the road at an
angle ... The road is way more narrow when you draw it horizontally vs
vertical. Can you try to maintain the same road width?"*

HE MEASURED THE PROJECTION. Both roads there are three cells thick, and three
cells is not one width: a cell is a 64x28 diamond, so three ROWS along a cell
axis stand 77 px across on screen (3 x 2.DX.DY / sqrt(DX^2 + DY^2)), three
ANTI-DIAGONALS of a screen-horizontal staircase 56 px ((k+1).DY), three
DIAGONALS of a screen-vertical one 128 px ((k+1).DX). The solid core the
corner-Wang blend leaves is worse still - 51 px, 28 px and 64 px - because a
staircase band k deep has only k-2 anti-diagonals of full 2x2 quads. The
`widen_roads` law (three cells so a quad can be solid) is a floor in CELLS;
width is a length in PIXELS.

THE RULE: for every road cell, the width of the band ACROSS the road's local
direction, measured on screen (`width_at`: the direction from a PCA of the
road's screen positions round the cell, then a walk out from the cell centre
along the perpendicular until the road ends, in px). A road keeps ITS OWN
width - the lower quartile of its stretches that run along a cell axis
(`ref_width`, never below `MIN_REF` = the three-row road) - and every stretch of it
narrower than that by more than `TOL` px is dilated onto the grass beside it
on its thin side, at the road's level, round after round until nothing is
narrow. Only a STRETCH is widened: a cell whose fitted direction is strongly
one-way (`ANISO`, the covariance's eigenvalue ratio - a road 9 or more, a
patch or a crossing about 2) in a road of `ROAD_CELLS` or more; the first cut
blew an eight-cell sand patch on the massif shoulder into a plaza. A
screen-horizontal road of three anti-diagonals becomes five (84 px);
an axis road of three rows is already 77 and does not move; a screen-vertical
one is wider than its reference and is never thinned (thinning breaks the
solid core, and a wide read is not what he minded). Only a ROAD is widened -
a cell narrower than `ROAD_MIN` px is a yard path, a well's apron, a speck -
and only a natural top takes the road (grass, mud, snow, ice, bare rock: the
fields a road crosses; 131 thin cells of the mud roads had nothing else
beside them): never paving, sand, water, a floor, a ramp cell or a cell a
piece stands in. The thin side is preferred; the other side serves when the
thin one is taken.

    python3 maps2/pipeline/roadwidth.py --check maps2/worlds3/the_game
    python3 maps2/pipeline/roadwidth.py --apply maps2/worlds3/the_game

The build runs `equalise(grow)` after `widen_roads`, before `ramps`.
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

DX, DY = 32.0, 14.0
ROAD = "light_soil"
TAKES = ("grass", "dark_mud", "snow", "ice", "grey_stone", "black_rock")   # the natural tops a widened road is laid on
LEVEL_TOL = 2               # a shoulder this far off the road's level takes the road's level
MIN_REF = 3 * 2 * DX * DY / math.hypot(DX, DY)      # 77 px: three rows along an axis
TOL = 4.0                   # px: narrower than the reference by more than this is thin
ROAD_MIN = 50.0             # px: narrower than this is a path or a speck, not a road
PCA_R = 5                   # cells: the neighbourhood the local direction is read from
AXIS_DEG = 8.0              # a stretch within this of an axis direction is "along an axis"
ANISO = 4.0                 # eigenvalue ratio below which the cell is in a patch or a crossing, not a stretch
ROUNDS = 16
ROAD_CELLS = 24             # a connected road has at least this many cells; less is a patch
STEP = 1.0                  # px per step of the width walk
ALONG = 2                   # cells before and after: the width is the median of five walks


def scr(x, y):
    return (x - y) * DX, (x + y) * DY


def cell_at(sx, sy):
    cx = (sx / DX + sy / DY) / 2
    cy = (sy / DY - sx / DX) / 2
    return math.floor(cx), math.floor(cy)


def direction(road, x, y):
    """The road's direction on screen round (x, y): the first principal axis
    of the road cells' screen centres within PCA_R. Radians, or None."""
    pts = [scr(a + 0.5, b + 0.5) for a in range(x - PCA_R, x + PCA_R + 1)
           for b in range(y - PCA_R, y + PCA_R + 1) if (a, b) in road]
    if len(pts) < 4:
        return None
    mx = sum(p[0] for p in pts) / len(pts)
    my = sum(p[1] for p in pts) / len(pts)
    sxx = sum((p[0] - mx) ** 2 for p in pts)
    syy = sum((p[1] - my) ** 2 for p in pts)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
    th = 0.5 * math.atan2(2 * sxy, sxx - syy)
    # A STRETCH HAS A DIRECTION; a patch or a crossing has none. The
    # eigenvalue ratio of the covariance: a three-row road within PCA_R is
    # 9 or more (a screen-vertical staircase 11, an axis road 28), a
    # junction or a sand patch about 2 - the first cut blew an eight-cell
    # patch on the massif shoulder up into a plaza (measured).
    tr, det = sxx + syy, sxx * syy - sxy * sxy
    disc = max(0.0, tr * tr / 4 - det) ** 0.5
    l1, l2 = tr / 2 + disc, tr / 2 - disc
    if l2 <= 0 or l1 / l2 < ANISO:
        return None
    return th


def _walk(road, cx, cy, px, py):
    ext = []
    for s in (1, -1):
        t = 0.0
        while t < 400:
            t += STEP
            if cell_at(cx + px * t * s, cy + py * t * s) not in road:
                break
        ext.append(t)
    return ext


def width_at(road, x, y, th=None):
    """(width px, up px, down px, angle) of the band across the road at the
    cell: the walk along the perpendicular of the local direction, each way,
    until the road ends - taken at the cell and at ALONG cells before and
    after it along the road, the MEDIAN of the five. A single walk read every
    bend's inner corner as thin (the fitted direction lies between the two
    legs and the walk leaves the road at once on the inside), the corners
    filled, and the filled corners raised the road's reference for the next
    run: 386 cells more on a second run, measured. A stretch is thin when it
    is thin along its length."""
    th = direction(road, x, y) if th is None else th
    if th is None:
        return None                         # a patch or a crossing: no width to speak of
    ux, uy = math.cos(th), math.sin(th)
    px, py = -math.sin(th), math.cos(th)
    cx, cy = scr(x + 0.5, y + 0.5)
    step = math.hypot(DX, DY)             # one cell along an axis, in px
    samples = []
    for k in range(-ALONG, ALONG + 1):
        sx, sy = cx + ux * k * step, cy + uy * k * step
        if cell_at(sx, sy) not in road:
            continue
        samples.append(_walk(road, sx, sy, px, py))
    samples.sort(key=lambda e: e[0] + e[1])
    up, down = samples[len(samples) // 2]
    return up + down, up, down, th


def along_axis(th):
    a = math.degrees(th) % 180
    ax = math.degrees(math.atan2(DY, DX))         # 23.6: the x axis on screen
    return min(abs(a - ax), abs(a - (180 - ax))) <= AXIS_DEG


def components(road):
    seen, out = set(), []
    for c in sorted(road):
        if c in seen:
            continue
        comp, st = [], [c]
        seen.add(c)
        while st:
            x, y = st.pop()
            comp.append((x, y))
            for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if n in road and n not in seen:
                    seen.add(n)
                    st.append(n)
        out.append(comp)
    return out


def ref_width(widths, comp):
    """A road's own width: the LOWER QUARTILE of its axis-running stretches,
    never below the three-row road (a junction or a widened corner sits in
    the upper tail and cannot lift it - the median crept, measured)."""
    ax = sorted(w[0] for c in comp for w in (widths.get(c),) if w and along_axis(w[3]) and w[0] >= ROAD_MIN)
    if not ax:
        return MIN_REF
    return max(MIN_REF, ax[len(ax) // 4])


def measure(road):
    return {c: width_at(road, *c) for c in road}


def survey(road, log=print):
    """Widths by screen direction: what --check prints."""
    widths = measure(road)
    by = collections.defaultdict(list)
    for c, w in widths.items():
        if not w or w[0] < ROAD_MIN:
            continue
        a = math.degrees(w[3]) % 180
        by[int(a // 15) * 15].append(w[0])
    thin = 0
    for comp in components(road):
        ref = ref_width(widths, comp)
        thin += sum(1 for c in comp if widths.get(c) and ROAD_MIN <= widths[c][0] < ref - TOL)
    for k in sorted(by):
        v = sorted(by[k])
        log(f"  screen {k:3d}-{k + 15:3d} deg: {len(v):5d} cells, width px median {v[len(v) // 2]:5.0f} "
            f"p10 {v[len(v) // 10]:5.0f} p90 {v[9 * len(v) // 10]:5.0f}")
    log(f"{thin} road cell(s) thinner than their road's own width")
    return thin, widths


def _blocked(doc):
    ramp = {(c["x"], c["y"]) for r in doc.get("ramps", []) for c in r["cells"]}
    stood = {(int(p["x"]), int(p["y"])) for p in doc.get("scenery", [])}
    return ramp | stood


def equalise(doc, log=print, seed=0x50AD):
    """Widen every thin stretch in place. Returns (cells added, cells still
    thin with nothing beside them to take the road)."""
    import world3grow as W
    G, grd, lvl = doc["grounds"], doc["ground"], doc["level"]
    gi = {n: i for i, n in enumerate(G)}
    soil, takes = gi[ROAD], {gi[g] for g in TAKES if g in gi}
    N = len(lvl)
    blocked = _blocked(doc)
    r = W._rng32(seed)
    road = {(x, y) for y in range(N) for x in range(N) if grd[y][x] == soil}
    # A ROAD'S OWN WIDTH IS READ ONCE, from the road as it is: re-read each
    # round, the reference rose with the stretches the round before had just
    # widened and the pass chased its own tail (measured: 326 thin cells
    # became 711 in eight rounds).
    widths = measure(road)
    ref, comp_size = {}, {}
    for comp in components(road):
        w = ref_width(widths, comp)
        for c in comp:
            ref[c] = w
            comp_size[c] = len(comp)
    added, stuck = {}, set()
    for rnd in range(ROUNDS):
        if rnd:
            widths = measure(road)
        got = 0
        stuck = set()
        for (x, y) in sorted(road):
            w = widths.get((x, y))
            rw = ref.get((x, y)) or ref.setdefault((x, y), next(ref[n] for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)) if n in ref))
            if not w or w[0] < ROAD_MIN or w[0] >= rw - TOL:
                continue
            _, up, down, th = w
            px, py = -math.sin(th), math.cos(th)
            side = 1 if up <= down else -1         # the thin side
            z = lvl[y][x]
            comp_n = comp_size.get((x, y), 0)
            if comp_n < ROAD_CELLS:
                continue                            # a patch, not a road
            best, bx = None, None
            cx, cy = scr(x + 0.5, y + 0.5)
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if not (0 <= nx < N and 0 <= ny < N) or (nx, ny) in road or (nx, ny) in blocked:
                    continue
                if grd[ny][nx] not in takes or abs(lvl[ny][nx] - z) > LEVEL_TOL:
                    continue
                sx, sy = scr(nx + 0.5, ny + 0.5)
                proj = ((sx - cx) * px + (sy - cy) * py) * side
                key = (proj > 0, r())               # the thin side first; among equals a coin
                if best is None or key > best:
                    best, bx = key, (nx, ny)
            if bx:
                grd[bx[1]][bx[0]] = soil
                lvl[bx[1]][bx[0]] = z
                road.add(bx)
                ref[bx] = rw
                comp_size[bx] = comp_n
                added[bx] = rnd
                got += 1
            else:
                stuck.add((x, y))
        log(f"  round {rnd + 1}: {got} cell(s) widened, {len(stuck)} thin with nothing to take")
        if not got:
            break
    return added, stuck


def apply(world_dir, write=True, log=print):
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    added, stuck = equalise(doc, log)
    log(f"{world_dir}: {len(added)} road cell(s) added; {len(stuck)} thin cell(s) with nothing beside them to take the road")
    if write and added:
        json.dump(doc, open(path, "w"), separators=(",", ":"))
        log(f"wrote {path}")
    return added


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("world_dir")
    gr = ap.add_mutually_exclusive_group(required=True)
    gr.add_argument("--check", action="store_true", help="survey; exit 1 when a road stretch could still be widened")
    gr.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.check:
        doc = json.load(open(os.path.join(a.world_dir, "world.json")))
        N = len(doc["level"])
        soil = doc["grounds"].index(ROAD)
        road = {(x, y) for y in range(N) for x in range(N) if doc["ground"][y][x] == soil}
        survey(road)
        # the gate: what --apply would still widen (a thin cell with nothing
        # beside it to take the road is reported, not failed)
        added, stuck = equalise(doc, log=lambda *a: None)
        print(f"{a.world_dir}: {len(added)} widenable cell(s), {len(stuck)} thin with nothing to take")
        sys.exit(1 if added else 0)
    apply(a.world_dir, write=not a.dry_run)


if __name__ == "__main__":
    main()
