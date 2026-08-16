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

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import palette_snap

# 64px isometric house format: the top diamond is the full 64 wide and 32 tall, so the
# grid pitch is half of each. LEVEL_PX is one elevation step, matching tiles2/maps2.
DX, DY, LEVEL_PX = 32, 16, 16


def plateau(tile, cols=4, rows=4, level=1, pad=8):
    """Lay `tile` over a cols x rows patch of ground raised to `level`.

    A plateau rather than a flat field on purpose: raising it means the front rank's
    walls are exposed, which is the only way to see the cliff faces the tiles exist
    for, while the interior shows how the tops tessellate.
    """
    tw, th = tile.size
    xs = [(c - r) * DX for c in range(cols) for r in range(rows)]
    ys = [(c + r) * DY for c in range(cols) for r in range(rows)]
    w = (max(xs) - min(xs)) + tw + pad * 2
    h = (max(ys) - min(ys)) + th + pad * 2 + level * LEVEL_PX
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ox = pad - min(xs)
    oy = pad - min(ys) + level * LEVEL_PX
    # back to front: a nearer tile must be able to cover the one behind it
    for c, r in sorted([(c, r) for c in range(cols) for r in range(rows)],
                       key=lambda cr: cr[0] + cr[1]):
        x = ox + (c - r) * DX
        y = oy + (c + r) * DY - level * LEVEL_PX
        out.alpha_composite(tile, (x, y))
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
