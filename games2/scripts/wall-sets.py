#!/usr/bin/env python3
"""WALL SETS, CHOSEN BY MEASURING THE SEAM — not by anybody's eye.

The maintainer's instruction, 2026-09-07: "Since we don't have the base wall
sets yet, you can't rely on a combination I think looks good. But what I mostly
look at is if this tile looks 'tiled' when combined with other tiles. Is the
transition good? ... some walls might have a totally different ground brightness
and tile in a completely different direction. You need to take responsibility
for us not having a set that can tell you what looks good and what doesn't."

So this measures the thing he actually looks at. An earlier attempt scored tiles
by a GLOBAL signature — mean luminance, contrast, directional energy — and
picked look-alikes. That was taste dressed as measurement, and it is measurably
worthless for this: over the 5,402 ordered pairs of approved
grey_stone__over__grey_stone walls its distance correlates with the real seam
cost at +0.105, and the 200 pairs it called most similar had a MEDIAN SEAM WORSE
THAN THE POOL AVERAGE (2.09 against 1.91). A global descriptor cannot see a
join; only the join can.

THE MEASUREMENT. Two tiles are composited exactly as the game stacks them — the
neighbour along a face at (+32, +14), the storey above at (0, -15) — and the
luminance step across the join is compared against the step the same two tiles
show INSIDE themselves. A join no worse than the art's own texture is invisible;
one several times worse is a seam you can see across the map. The ratio is the
cost, so it is scale-free and comparable between pools.

A SET IS THREE TILES THAT ALL JOIN WELL, in every order and with themselves —
the dominant repeats against itself far more often than against anything else,
so `cost(i, i)` is in the score. Sets are emitted per pool, best first, with
distinct dominants so different massifs get different rock.

This file is the stand-in for hand-authored wall base sets. When the tiles agent
ships real ones they replace it wholesale; the runtime already reads a set the
same way either way.

    python3 games2/scripts/wall-sets.py [--pool NAME] [--sets 12]
"""
import argparse, json, os, sys
import numpy as np
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, "games2", "client", "src", "wallsets.json")
TILE, DX, DY, TOP_Y, PITCH = 64, 32, 14, 10, 15
BAND = slice(TOP_Y + 2 * DY, TILE)          # the wall band; the top face is a different surface


def load(path):
    a = np.asarray(Image.open(os.path.join(REPO, path)).convert("RGBA")).astype(np.float32)
    lum = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    return lum, a[..., 3] / 255.0


def interior(lum, al):
    """The art's own texture step — the reference every join is judged against."""
    b, ab = lum[BAND, :], al[BAND, :]
    gx = np.abs(np.diff(b, axis=1)); mx = (ab[:, 1:] > 0.5) & (ab[:, :-1] > 0.5)
    gy = np.abs(np.diff(b, axis=0)); my = (ab[1:, :] > 0.5) & (ab[:-1, :] > 0.5)
    h = float(gx[mx].mean()) if mx.any() else 0.0
    v = float(gy[my].mean()) if my.any() else 0.0
    return h, v


def seam_side(a, b):
    """Tile b placed to the right along the face: its left edge lands at x=DX."""
    (la, aa), (lb, ab) = a, b
    rows = range(BAND.start, TILE)
    left, right, m = [], [], []
    for y in rows:
        yb = y - DY
        if yb < 0 or yb >= TILE:
            continue
        if aa[y, DX - 1] > 0.5 and ab[yb, 0] > 0.5:
            left.append(la[y, DX - 1]); right.append(lb[yb, 0])
    if len(left) < 6:
        return None
    return float(np.abs(np.array(right) - np.array(left)).mean())


def seam_stack(a, b):
    """Tile b as the storey ABOVE: its band bottom meets a's band top, PITCH apart."""
    (la, aa), (lb, ab) = a, b
    ya, yb = BAND.start, BAND.start + PITCH
    if yb >= TILE:
        return None
    m = (aa[yb] > 0.5) & (ab[ya] > 0.5)
    if m.sum() < 6:
        return None
    return float(np.abs(lb[ya][m] - la[yb][m]).mean())


def main():
    ap_ = argparse.ArgumentParser()
    ap_.add_argument("--pool")
    ap_.add_argument("--sets", type=int, default=12)
    args = ap_.parse_args()

    man = json.load(open(os.path.join(REPO, "tiles", "review", "manifest.json")))
    fb = json.load(open(os.path.join(REPO, "live", "feedback", "tiles.json")))["entries"]
    pools, out = 0, {}
    for name, cell in man["cells"].items():
        if args.pool and name != args.pool:
            continue
        cands = [c for c in cell["candidates"] if fb.get(c["key"], {}).get("status") == "approved"]
        if len(cands) < 3:
            continue
        keys = [c["key"].strip("/").split("/")[-1] for c in cands]
        tiles = [load(c["file"]) for c in cands]
        n = len(tiles)
        ref = [interior(*t) for t in tiles]
        # C[i][j] = how visible the join is with i left of j / i under j.
        C = np.full((n, n), np.nan, np.float32)
        for i in range(n):
            for j in range(n):
                rh = (ref[i][0] + ref[j][0]) / 2 + 1e-6
                rv = (ref[i][1] + ref[j][1]) / 2 + 1e-6
                s = seam_side(tiles[i], tiles[j]); t = seam_stack(tiles[i], tiles[j])
                if s is None and t is None:
                    continue
                parts = []
                if s is not None: parts.append(s / rh)
                if t is not None: parts.append(t / rv)
                C[i, j] = sum(parts) / len(parts)
        # A set's cost is its WORST join, in any order, including each tile
        # against itself: a bad pair anywhere is a seam you will find.
        def cost(members):
            vals = [C[a, b] for a in members for b in members]
            vals = [v for v in vals if not np.isnan(v)]
            return max(vals) if vals else float("inf")
        sets = []
        for d in range(n):
            if np.isnan(C[d, d]):
                continue
            chosen = [d]
            while len(chosen) < 3:
                best, bi = float("inf"), None
                for k in range(n):
                    if k in chosen:
                        continue
                    c = cost(chosen + [k])
                    if c < best:
                        best, bi = c, k
                if bi is None:
                    break
                chosen.append(bi)
            if len(chosen) == 3:
                sets.append((cost(chosen), chosen))
        sets.sort(key=lambda s: s[0])
        seen, kept = set(), []
        for c, mem in sets:
            if mem[0] in seen:
                continue
            seen.add(mem[0])
            kept.append({"cost": round(float(c), 3), "tiles": [keys[i] for i in mem]})
            if len(kept) >= args.sets:
                break
        if kept:
            out[name] = kept
            pools += 1
            if args.pool:
                for k in kept:
                    print(f"  cost {k['cost']:.2f}  {k['tiles']}")
        print(f"  {name}: {n} approved -> {len(kept)} sets, best cost {kept[0]['cost'] if kept else '-'}", file=sys.stderr)
    doc = {"format": "games2-wall-sets@1", "_comment": __doc__.split("\n")[0], "pools": out}
    json.dump(doc, open(OUT, "w"), separators=(",", ":"), sort_keys=True)
    print(f"{pools} pools -> {os.path.getsize(OUT)/1024:.0f} KB at {OUT}")


main()
