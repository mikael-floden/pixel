"""Measure the vertical pitch a tileset actually closes at.

The maintainer spotted a small jump in a tile's back edge in the wiki and asked whether
we had ever investigated how tiles should be drawn at all. We had not — the renderer's
DY was measured off the art and assumed correct, and the game's ISO_DY was never
compared against either tile generation.

THE TEST. Paint a tile's top surface one marker colour and its walls another, assemble a
FLAT field at a candidate pitch, then count INTERIOR WALL: a wall pixel that still has
top surface below it in the same column. A flat field shows only tops — every tile's
wall is covered by the tile in front — so a single interior wall pixel proves the
lattice does not close at that pitch.

It is deliberately a measurement of the assembled result rather than of the tile, because
the thing that goes wrong is a relationship between the art and the projection, and
neither one alone reveals it.

  python3 tiles/pipeline/pitch.py                 # every generation, default samples
  python3 tiles/pipeline/pitch.py --all           # every tiles 3.0 cell, not one sample
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import palette_snap

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
DX = 32
TOP, WALL = [255, 0, 255], [0, 255, 255]


def half_height(a):
    op = a[:, :, 3] > 128
    if not op.any():
        return None
    ys, xs = np.where(op)
    x0, x1, y0 = int(xs.min()), int(xs.max()), int(ys.min())
    if x1 - x0 + 1 != 64:
        return None
    return int(round(float(np.mean(
        [int(np.where(op[:, x])[0].min()) - y0 for x in (x0, x1)]))))


def marked(path):
    """The tile with its surfaces painted, so they can be told apart once assembled."""
    a = np.asarray(Image.open(path).convert("RGBA")).astype(int)
    reg = palette_snap._regions(a.astype(float))
    if not reg:
        return None, None
    m = a.copy()
    m[:, :, :3][reg["top"]] = TOP
    m[:, :, :3][reg["left"] | reg["right"]] = WALL
    return Image.fromarray(m.astype(np.uint8), "RGBA"), half_height(a)


def interior_wall(tile, dy, n=6, pad=12):
    tw, th = tile.size
    xs = [(c - r) * DX for c in range(n) for r in range(n)]
    ys = [(c + r) * dy for c in range(n) for r in range(n)]
    f = Image.new("RGBA", ((max(xs) - min(xs)) + tw + pad * 2,
                           (max(ys) - min(ys)) + th + pad * 2), (0, 0, 0, 0))
    ox, oy = pad - min(xs), pad - min(ys)
    for c, r in sorted([(c, r) for c in range(n) for r in range(n)], key=sum):
        f.alpha_composite(tile, (ox + (c - r) * DX, oy + (c + r) * dy))
    q = np.asarray(f).astype(int)
    op = q[:, :, 3] > 128
    wall = (np.abs(q[:, :, :3] - WALL).max(2) <= 10) & op
    top = (np.abs(q[:, :, :3] - TOP).max(2) <= 10) & op
    n_int = 0
    for x in range(f.width):
        w = np.where(wall[:, x])[0]
        t = np.where(top[:, x])[0]
        if len(w) and len(t):
            n_int += int((w < t.max()).sum())
    return n_int, int(top.sum())


def closes_at(path):
    """Largest pitch at which this tile's lattice closes, or None."""
    tile, hh = marked(path)
    if tile is None or hh is None:
        return None, None
    for dy in range(hh + 4, 0, -1):
        if interior_wall(tile, dy)[0] == 0:
            return dy, hh
    return None, hh


def game_iso_dy():
    src = os.path.join(REPO, "games2", "shared", "src", "index.ts")
    try:
        for line in open(src):
            if "ISO_DY" in line and "=" in line:
                return int("".join(ch for ch in line.split("=")[1] if ch.isdigit()))
    except Exception:
        pass
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="every tiles 3.0 cell, not a sample")
    args = ap.parse_args()

    dy = game_iso_dy()
    print(f"the game projects at ISO_DY = {dy}\n")

    groups = {
        "tiles 3.0": sorted(glob.glob(os.path.join(ROOT, "review", "*", "*_after.webp"))),
        "tiles2": [p for p in sorted(glob.glob(
            os.path.join(REPO, "tiles2", "*", "base", "*", "*.webp"))) if "raw" not in p],
    }
    for label, paths in groups.items():
        if not paths:
            continue
        if not args.all:
            paths = paths[::max(1, len(paths) // 12)][:12]
        res = [closes_at(p) for p in paths]
        res = [(c, h) for c, h in res if c]
        if not res:
            continue
        closes = [c for c, _ in res]
        hh = [h for _, h in res]
        bad = sum(1 for c in closes if dy and c < dy)
        print(f"{label}: {len(res)} tiles")
        print(f"  diamond half-height : {min(hh)}..{max(hh)} (mode {max(set(hh), key=hh.count)})")
        print(f"  closes at pitch     : {min(closes)}..{max(closes)}")
        if dy:
            print(f"  FAIL at the game's {dy}: {bad}/{len(res)} tiles leak wall between them")
        print()


if __name__ == "__main__":
    main()
