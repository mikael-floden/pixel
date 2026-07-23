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
GOLD = (237, 173, 95)        # the (single, flat) fill colour = MANA yellow
RED = (198, 72, 58)          # HEALTH — a warm brick red in the gold's palette
# the kit's teal backdrop. The bar has ROUNDED corners, so the rectangular
# crop clips a few backdrop pixels into the corner notches — they must be
# KEYED OUT (maintainer 2026-07-23 green marks: "you didn't cut out the UI
# graphics correctly"), or they bake in as teal nubs on a dark background.
BG = (129, 151, 150)
# The kit bar is 90px, but at SCALE 3 (=270 CSS px) it can't sit high in the
# top-left with even margins: the left vine curls inward at the very top and
# the clock disc bulges in from the right, so a 270px bar has to drop below the
# curl — leaving an "enormous" top gap (maintainer 2026-07-23). The track's
# interior (cols ~5..84) is a UNIFORM vertical slice (top border / dark / bottom
# border), so we can delete interior columns to shorten the bar seamlessly while
# keeping BOTH rounded end caps. NARROW_TO trims it to a width that clears the
# disc bulge up high; the runtime clip-path fill is percentage-based so a shorter
# track fills correctly and bars.ts' ART_W just tracks this number.
NARROW_TO = 86
CUT_AT = 42  # first interior column to drop (well inside the uniform run)


def narrow(img, target):
    """Delete interior columns from the middle to reach `target` width, keeping
    the caps. Interior is uniform so any contiguous middle run is seamless."""
    W, H = img.size
    drop = W - target
    if drop <= 0:
        return img
    keep = [x for x in range(W) if not (CUT_AT <= x < CUT_AT + drop)]
    out = Image.new("RGBA", (target, H), (0, 0, 0, 0))
    op, ip = out.load(), img.load()
    for nx, ox in enumerate(keep):
        for y in range(H):
            op[nx, y] = ip[ox, y]
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
    fp, rp, yp = frame.load(), fred.load(), fyellow.load()

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
                yp[x, y] = (*GOLD, 255)        # mana keeps the kit gold
            else:
                fp[x, y] = (*c, 255)           # border/chrome (dark + brown)

    frame, fred, fyellow = (narrow(im2, NARROW_TO) for im2 in (frame, fred, fyellow))
    frame.save("client/public/ui2/bar-frame.png")
    fred.save("client/public/ui2/bar-fill-red.png")
    fyellow.save("client/public/ui2/bar-fill-yellow.png")
    fcols = {c for c in frame.getdata() if c[3]}
    assert BG not in {(c[0], c[1], c[2]) for c in fcols}, "backdrop leaked into the frame"
    print(f"baked {W}x{H} -> narrowed {frame.size[0]}x{frame.size[1]} from crisp kit: "
          f"gold px {gold_px}, keyed backdrop px {bg_px}")
    print("frame colours:", sorted(fcols), "bbox", frame.getbbox())


if __name__ == "__main__":
    main()
