#!/usr/bin/env python3
"""Bake the HP/MP bar art from the maintainer's UI kit — /ui2/bar-*.png.

Source: client/ui-src/bars/uikit.png — his "UI ELEMENTS" sheet (2026-07-23)
on a grey-teal backdrop. The plain (badge-less) horizontal bar is the HP/MP
track: an empty dark version and a full GOLD version of identical shape.

Everything is derived from ONE crop of the FULL gold bar so the pieces align
by construction (same rounded caps, same border, same interior offset):
  bar-frame.png      the EMPTY track — gold interior replaced by the dark
                     fill colour, border kept.
  bar-fill-red.png   the gold interior alone (rest transparent), recoloured
  bar-fill-blue.png  to a red / blue luminance ramp (health / mana; the
                     maintainer's legend "Red = Health, Blue = Mana"). The
                     kit's gold shading is preserved as tonal structure.
At runtime bars.ts stacks a fill over the frame and CLIPS it to the percent —
the dark interior shows through where the fill is cut.

Gold isolation: g>=130 and r>=170 picks only the fill (border browns top out
at g~91). Alpha stays binary — pixel art, no fringe.
"""

from PIL import Image

SRC = "client/ui-src/bars/uikit.png"
BAR = (215, 132, 351, 163)  # full gold bar bbox (x0,y0,x1,y1), exclusive hi
BG = (129, 151, 150)
FILL_DARK = (39, 22, 24)    # the empty track's interior + border black
GOLD_LO, GOLD_HI = 164.0, 184.0  # gold luminance ramp (measured)
# recolour endpoints (dark shade .. bright shade)
RED = ((104, 20, 28), (232, 96, 84))
BLUE = ((26, 50, 120), (110, 168, 236))

lum = lambda c: 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]


def is_bg(c):
    return abs(c[0] - BG[0]) < 20 and abs(c[1] - BG[1]) < 20 and abs(c[2] - BG[2]) < 20


def is_gold(c):
    return c[1] >= 130 and c[0] >= 170


def ramp(c, lo_hi):
    t = (lum(c) - GOLD_LO) / (GOLD_HI - GOLD_LO)
    t = max(0.0, min(1.0, t))
    a, b = lo_hi
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def main():
    im = Image.open(SRC).convert("RGBA")
    p = im.load()
    x0, y0, x1, y1 = BAR
    W, H = x1 - x0, y1 - y0

    frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fred = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fblue = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fp, rp, bp = frame.load(), fred.load(), fblue.load()

    for y in range(H):
        for x in range(W):
            c = p[x0 + x, y0 + y][:3]
            if is_bg(c):
                continue
            if is_gold(c):
                fp[x, y] = (*FILL_DARK, 255)       # empty track: hollow it
                rp[x, y] = (*ramp(c, RED), 255)
                bp[x, y] = (*ramp(c, BLUE), 255)
            else:
                fp[x, y] = (*c, 255)               # border/chrome stays

    frame.save("client/public/ui2/bar-frame.png")
    fred.save("client/public/ui2/bar-fill-red.png")
    fblue.save("client/public/ui2/bar-fill-blue.png")
    print(f"baked {W}x{H}: frame + red + blue fills")
    print("frame bbox", frame.getbbox(), "fill bbox", fred.getbbox())


if __name__ == "__main__":
    main()
