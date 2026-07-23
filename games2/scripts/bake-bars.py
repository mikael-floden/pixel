#!/usr/bin/env python3
"""Bake the HP/MP bar art from the CRISP UI kit — /ui2/bar-*.png.

Source: client/ui-src/uikit.png — the maintainer's real UI-kit tilesheet
(1632x1344, clean pixel art). The FULL gold bar in the "UI ELEMENTS" column
is the HP/MP track: 90x20, a 3-colour sprite (dark 39,22,24 / gold
237,173,95 / border-brown 156,91,52) with HARD 1px edges. (An earlier bake
mistakenly used a soft, upscaled SCREENSHOT of the kit — the bars read
smeared; the maintainer flagged it: use the crisp tilesheet.)

Everything is derived from the one full-gold-bar crop so the pieces align:
  bar-frame.png        the EMPTY track — gold interior replaced by the dark
                       fill colour, border kept.
  bar-fill-yellow.png  MANA = the kit's own gold, untouched (maintainer
                       2026-07-23: "I also want the mana in that nice
                       looking yellow").
  bar-fill-red.png     HEALTH = the gold interior recoloured to a warm brick
                       red picked from the SAME palette as the gold ("the
                       red ... should be in the same colour palette as the
                       yellow") — a sibling of the kit's brown/gold ramp,
                       not an off-palette red. The kit fill is a FLAT single
                       gold, so the recolour is flat too — crisp, no gradient.
At runtime bars.ts stacks a fill over the track and CLIPS it to the percent;
the dark interior shows through the cut. Alpha is binary (pixel art).
"""

from PIL import Image

SRC = "client/ui-src/uikit.png"
BAR = (928, 102, 1018, 122)  # full gold bar bbox (x0,y0,x1,y1), exclusive hi
FILL_DARK = (39, 22, 24)     # the empty track's interior
GOLD = (237, 173, 95)        # the (single, flat) fill colour = ENERGY yellow
RED = (198, 72, 58)          # HEALTH — a warm brick red in the gold's palette
# EXPERIENCE — a blue in the SAME palette (maintainer 2026-07-23: "a blue color
# in the same palette"): mirrors the health red's saturation/value at a blue
# hue, so it reads as a sibling of the kit ramp, not an off-palette blue.
BLUE = (58, 120, 198)
# the kit's teal backdrop. The bar has ROUNDED corners, so the rectangular
# crop clips a few backdrop pixels into the corner notches — they must be
# KEYED OUT (maintainer 2026-07-23 green marks: "you didn't cut out the UI
# graphics correctly"), or they bake in as teal nubs on a dark background.
BG = (129, 151, 150)


def downscale2x(img):
    """2x -> 1x, NEAREST (drop every other pixel). The kit sheet is authored on
    a 2x pixel grid (every 2x2 block uniform — extract-uikit.py downscales the
    buttons/slots the same way), so this is EXACT, not a resample. It recovers
    the bar's true logical resolution (45x10, 1-px borders) so that when bars.ts
    9-slices it at the shared kit block scale (plate.ts nineSlice / KIT_PX) the
    bar's borders come out the SAME 2px as the buttons — on the 2x-grid art they
    would render 2x thick. The 9-slice extrudes the uniform track to any width,
    so no narrowing is needed anymore (the bar keeps its box, only the pixels
    shrink — maintainer 2026-07-23: "do what we did with the UI KIT buttons")."""
    W, H = img.size
    out = Image.new("RGBA", (W // 2, H // 2), (0, 0, 0, 0))
    ip, op = img.load(), out.load()
    for y in range(H // 2):
        for x in range(W // 2):
            op[x, y] = ip[2 * x, 2 * y]
    return out


def is_gold(c):
    return abs(c[0] - GOLD[0]) < 30 and abs(c[1] - GOLD[1]) < 30 and abs(c[2] - GOLD[2]) < 30


def is_bg(c):
    return abs(c[0] - BG[0]) < 24 and abs(c[1] - BG[1]) < 24 and abs(c[2] - BG[2]) < 24


def main():
    im = Image.open(SRC).convert("RGB")
    p = im.load()
    x0, y0, x1, y1 = BAR
    W, H = x1 - x0, y1 - y0

    frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fred = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fyellow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fblue = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fp, rp, yp, bp = frame.load(), fred.load(), fyellow.load(), fblue.load()

    gold_px = bg_px = 0
    for y in range(H):
        for x in range(W):
            c = p[x0 + x, y0 + y]
            if is_bg(c):
                bg_px += 1                     # corner backdrop -> transparent
            elif is_gold(c):
                gold_px += 1
                fp[x, y] = (*FILL_DARK, 255)   # hollow the track
                rp[x, y] = (*RED, 255)
                yp[x, y] = (*GOLD, 255)        # energy keeps the kit gold
                bp[x, y] = (*BLUE, 255)        # experience = palette blue
            else:
                fp[x, y] = (*c, 255)           # border/chrome (dark + brown)

    frame, fred, fyellow, fblue = (downscale2x(im2) for im2 in (frame, fred, fyellow, fblue))
    frame.save("client/public/ui2/bar-frame.png")
    fred.save("client/public/ui2/bar-fill-red.png")
    fyellow.save("client/public/ui2/bar-fill-yellow.png")
    fblue.save("client/public/ui2/bar-fill-blue.png")
    fcols = {c for c in frame.getdata() if c[3]}
    assert BG not in {(c[0], c[1], c[2]) for c in fcols}, "backdrop leaked into the frame"
    print(f"baked {W}x{H} -> downscaled {frame.size[0]}x{frame.size[1]} from crisp kit: "
          f"gold px {gold_px}, keyed backdrop px {bg_px}")
    print("frame colours:", sorted(fcols), "bbox", frame.getbbox())


if __name__ == "__main__":
    main()
