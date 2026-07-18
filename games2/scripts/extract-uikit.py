#!/usr/bin/env python3
"""Extract UI elements from the maintainer's pixel UI kit sheet.

Source: the maintainer's UI pack sheet (2026-07-18, committed at
client/ui-src/uikit.png — buttons/icons/sliders/tabs/pop-ups/font on a
uniform grey-green backdrop, authored at a 2x pixel grid). Pass its path
as argv[1]. Everything is cut at NATIVE 1x resolution (every 2x2 block is
uniform — verified — so the downscale is exact, not a resample).

Current cuts (extend this script as more elements are adopted):
- kit-btn.png     the blank standalone button (tan fill, dark outline,
                  bottom shadow) — action buttons (48x16)
- kit-row.png     the blank pop-up row plate (flat brown bar) — settings
                  toggles OFF (70x12)
- kit-row-sel.png the highlighted row: same bar wrapped in the gold ring,
                  reconstructed from the AUDIO pop-up's selected MUSIC row
                  with its white label erased to the fill colour — settings
                  toggles ON (72x14)

Backdrop/panel colours become transparency. These plates are FLAT pixel
art: they 9-slice losslessly (plate.ts scales corners by an integer factor
and extrudes the flat runs), so no soft-alpha edge is needed — every edge
is an authored hard pixel edge, and the display scale is always integer.
"""

import sys

from PIL import Image

BG = (129, 151, 150)  # sheet backdrop
PANEL = (80, 60, 51)  # pop-up panel behind the rows
FILL = (133, 99, 68)  # row plate fill
TEXT = (255, 255, 255)  # baked label colour
OUT = "client/public/ui2/"


def cut(im, box, clear):
    """crop sheet box, map `clear` colours to transparency, downscale 2x->1x"""
    px = im.load()
    x0, y0, x1, y1 = box
    w, h = (x1 - x0) // 2, (y1 - y0) // 2
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    op = out.load()
    for y in range(h):
        for x in range(w):
            p = px[x0 + 2 * x, y0 + 2 * y]
            if p not in clear:
                op[x, y] = (*p, 255)
    return out


def main():
    im = Image.open(sys.argv[1]).convert("RGB")
    px = im.load()

    # standalone button below QUIT (bbox found by backdrop flood)
    cut(im, (368, 776, 464, 808), {BG}).save(OUT + "kit-btn.png")

    # blank pop-up row (GRAPHICS pop-up, first empty row): find its exact
    # vertical span at a column inside it
    ys = [y for y in range(525, 562) if px[1240, y] == FILL]
    row_box = (1212, min(ys), 1352, max(ys) + 1)
    cut(im, row_box, {PANEL}).save(OUT + "kit-row.png")

    # selected row: the AUDIO pop-up's MUSIC row (gold ring + fill + label) —
    # fixed box just around the row (the volume meter sits further right),
    # tight-cropped, with the white label erased into the fill
    sel = cut(im, (1210, 782, 1360, 816), {PANEL})
    sel = sel.crop(sel.getbbox())
    sp = sel.load()
    for y in range(sel.height):
        for x in range(sel.width):
            if sp[x, y][:3] == TEXT:
                sp[x, y] = (*FILL, 255)
    sel.save(OUT + "kit-row-sel.png")

    for n in ("kit-btn", "kit-row", "kit-row-sel"):
        print(n, Image.open(OUT + n + ".png").size)


if __name__ == "__main__":
    main()
