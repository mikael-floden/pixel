#!/usr/bin/env python3
"""Bake the HP/MP bar art from the CRISP UI kit — /ui2/bar-*.png.

Source: client/ui-src/uikit.png — the maintainer's real UI-kit tilesheet
(1632x1344, clean pixel art). The FULL gold bar in the "UI ELEMENTS" column
is the HP/MP track: 90x20, a 3-colour sprite (dark 39,22,24 / gold
237,173,95 / border-brown 156,91,52) with HARD 1px edges. (An earlier bake
mistakenly used a soft, upscaled SCREENSHOT of the kit — the bars read
smeared; the maintainer flagged it: use the crisp tilesheet.)

Everything is derived from the one full-gold-bar crop so the pieces align:
  bar-frame.png      the EMPTY track — gold interior replaced by the dark
                     fill colour, border kept.
  bar-fill-red.png   the gold interior alone (rest transparent), recoloured
  bar-fill-blue.png  flat to health-red / mana-blue (his legend "Red =
                     Health, Blue = Mana"). The kit fill is a FLAT single
                     gold, so the recolour is flat too — crisp, no gradient.
At runtime bars.ts stacks a fill over the track and CLIPS it to the percent;
the dark interior shows through the cut. Alpha is binary (pixel art).
"""

from PIL import Image

SRC = "client/ui-src/uikit.png"
BAR = (928, 102, 1018, 122)  # full gold bar bbox (x0,y0,x1,y1), exclusive hi
FILL_DARK = (39, 22, 24)     # the empty track's interior
GOLD = (237, 173, 95)        # the (single, flat) fill colour
RED = (196, 66, 58)          # health
BLUE = (74, 128, 196)        # mana


def is_gold(c):
    return abs(c[0] - GOLD[0]) < 30 and abs(c[1] - GOLD[1]) < 30 and abs(c[2] - GOLD[2]) < 30


def main():
    im = Image.open(SRC).convert("RGB")
    p = im.load()
    x0, y0, x1, y1 = BAR
    W, H = x1 - x0, y1 - y0

    frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fred = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fblue = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fp, rp, bp = frame.load(), fred.load(), fblue.load()

    gold_px = 0
    for y in range(H):
        for x in range(W):
            c = p[x0 + x, y0 + y]
            if is_gold(c):
                gold_px += 1
                fp[x, y] = (*FILL_DARK, 255)   # hollow the track
                rp[x, y] = (*RED, 255)
                bp[x, y] = (*BLUE, 255)
            else:
                fp[x, y] = (*c, 255)           # border/chrome (dark + brown)

    frame.save("client/public/ui2/bar-frame.png")
    fred.save("client/public/ui2/bar-fill-red.png")
    fblue.save("client/public/ui2/bar-fill-blue.png")
    print(f"baked {W}x{H} from crisp kit: gold px {gold_px}")
    print("frame bbox", frame.getbbox(), "fill bbox", fred.getbbox())


if __name__ == "__main__":
    main()
