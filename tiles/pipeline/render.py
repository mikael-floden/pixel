"""Render tiles the way the game actually places them, so they can be judged honestly.

A tile only tells you the truth when it is laid on a real isometric grid. A cell at
(col, row) lands at

    x = (col - row) * DX          DX = half the tile width
    y = (col + row) * DY          DY = half the top diamond's height

and cells are drawn BACK TO FRONT, ascending in (col + row), so nearer tiles overlap
the walls of the ones behind them — which is exactly why only the front rank's walls
stay visible in a plateau. Getting this wrong (offsetting tiles along a row instead of
across the grid) produces a zigzag staircase that looks nothing like the game and makes
the art impossible to assess.

Also renders the POSTPROCESSED state, since that is what ships: palette_snap flattens
the top to the palette colour and re-fits the wall's own texture to the wall material,
keeping its detail. Showing before and after side by side is the only way to see what
the script actually does to the art.

  python tiles/pipeline/render.py <tile.png> out.png --top 3f8a3a --side 8a8f8c
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import palette_snap

# 64px isometric house format. DY is MEASURED from the art, not assumed: on a real
# generated tile the top diamond's apex sits at y9 and it reaches full width at y23,
# so the diamond is 64 wide and 28 tall and the grid pitch is 32 x 14.
#
# Assuming 16 (half of a 32-tall diamond) is wrong by 2px per step, which is exactly
# what makes a plateau's edge come out ragged instead of a straight diagonal — the
# maintainer spotted it on sight. Verified by rendering 14/15/16 side by side: only 14
# gives clean edges.
DX, DY = 32, 14


def wall_height(tile):
    """How far one floor drops — MEASURED, like DY and the top diamond.

    A floor's cliff face runs from the bottom of the TOP REGION to the bottom of the
    silhouette, so that distance is the stacking pitch: offset two blocks by it and the
    upper one's wall ends exactly where the lower one's begins, covering the lower
    block's top surface completely.

    It must come from palette_snap's own mask, not from the bare diamond, or the two
    disagree by the boundary row the mask deliberately includes. Deriving it from the
    diamond gave 17 where the mask's wall is 16, and that one row exposed 114 pixels of
    each lower floor's top per tile — which is what put bright green stripes across the
    cliff at every storey in a 3-floor render.

    Taken as the MINIMUM across columns, since the wall is a row shorter at the tile's
    left and right corners than in the middle, and a pitch that fits the tallest column
    still leaks at the shortest.
    """
    a = np.asarray(tile.convert("RGBA")).astype(float)
    op = a[:, :, 3] > 128
    reg = palette_snap._regions(a)
    if not reg:
        return 0
    gaps = []
    for x in range(a.shape[1]):
        t = np.where(reg["top"][:, x])[0]
        o = np.where(op[:, x])[0]
        if len(t) and len(o):
            gaps.append(int(o.max()) - int(t.max()))
    return int(min(gaps)) if gaps else 0


def plateau(tile, cols=4, rows=4, level=1, pad=8, floors=1, middle=None):
    """Lay `tile` over a cols x rows patch of ground raised to `level`.

    A plateau rather than a flat field on purpose: raising it means the front rank's
    walls are exposed, which is the only way to see the cliff faces the tiles exist
    for, while the interior shows how the tops tessellate.

    `floors` stacks that many storeys into one cliff. One floor only ever shows the wall
    repeating sideways; the wall also has to repeat downwards, and a single storey
    cannot show whether it does.

    `middle`, when given, is used for every floor BELOW the top one. A cliff wants two
    different tiles: the cap carries the shading where the ground overhangs the rock,
    and the floors under it want that shading gone or it becomes a stripe at every
    storey. Passing the same tile for both is what puts a hard line at each join.
    """
    lp = wall_height(tile)
    tw, th = tile.size
    xs = [(c - r) * DX for c in range(cols) for r in range(rows)]
    ys = [(c + r) * DY for c in range(cols) for r in range(rows)]
    lift = level * lp + (floors - 1) * lp
    w = (max(xs) - min(xs)) + tw + pad * 2
    h = (max(ys) - min(ys)) + th + pad * 2 + lift
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ox = pad - min(xs)
    oy = pad - min(ys) + lift
    # back to front: a nearer tile must be able to cover the one behind it, and within
    # a cell a higher storey must be able to cover the top of the one it sits on
    cells = [(c, r, f) for c in range(cols) for r in range(rows) for f in range(floors)]
    for c, r, f in sorted(cells, key=lambda k: (k[0] + k[1], k[2])):
        x = ox + (c - r) * DX
        y = oy + (c + r) * DY - level * lp - f * lp
        out.alpha_composite(tile if (middle is None or f == floors - 1) else middle, (x, y))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tile")
    ap.add_argument("out")
    ap.add_argument("--top", required=True)
    ap.add_argument("--side", required=True)
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--rows", type=int, default=4)
    ap.add_argument("--scale", type=int, default=3)
    args = ap.parse_args()
    t = Image.open(args.tile).convert("RGBA")
    raw = plateau(t, args.cols, args.rows)
    done = plateau(palette_snap.snap(t, args.top, args.side), args.cols, args.rows)
    s = args.scale
    gap = 24
    canvas = Image.new("RGBA", (raw.width * s + done.width * s + gap,
                                max(raw.height, done.height) * s), (16, 16, 20, 255))
    canvas.alpha_composite(raw.resize((raw.width * s, raw.height * s), Image.NEAREST), (0, 0))
    canvas.alpha_composite(done.resize((done.width * s, done.height * s), Image.NEAREST),
                           (raw.width * s + gap, 0))
    canvas.convert("RGB").save(args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
