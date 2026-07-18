#!/usr/bin/env python3
"""Extract UI elements from the maintainer's pixel UI kit sheet.

Source: the maintainer's UI pack sheet (2026-07-18, committed at
client/ui-src/uikit.png — buttons/icons/sliders/tabs/pop-ups/font on a
uniform grey-green backdrop, authored at a 2x pixel grid). Pass its path
as argv[1]. Everything is cut at NATIVE 1x resolution (every 2x2 block is
uniform — verified — so the downscale is exact, not a resample).

Current cuts (extend this script as more elements are adopted):
- kit-btn-normal.png / kit-btn-sel.png / kit-btn-down.png (48x12 each)
  THE button state trio the maintainer circled in UI ELEMENTS ("Normal,
  Selected, Down"): mid-brown / cream / dark-brown bars, dark outline,
  used for every HUD button (settings toggles: OFF=normal, ON=sel,
  held=down; one-shot buttons: normal + down).
- kit-slot.png (16x14) the small dark rounded square below the segmented
  bar (maintainer circled it) — the backpack's empty item slot, displayed
  at an integer multiple, centred.

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

    # the circled state trio in UI ELEMENTS (below the dropdown rows),
    # three stacked 96x24 bars at x 784..880 — tight-cropped per bar
    for name, box in (
        ("kit-btn-normal", (784, 568, 882, 596)),
        ("kit-btn-sel", (784, 594, 882, 622)),
        ("kit-btn-down", (784, 622, 882, 648)),
        ("kit-slot", (958, 160, 994, 192)),
    ):
        b = cut(im, box, {BG})
        b = b.crop(b.getbbox())
        b.save(OUT + name + ".png")
        print(name, b.size)


if __name__ == "__main__":
    main()
