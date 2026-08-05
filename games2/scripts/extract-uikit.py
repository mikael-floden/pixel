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
- kit-chevron.png / kit-chevron-dark.png (6x6) the dropdown caret cut off
  the kit's dropdown header bars (UI ELEMENTS, left column: normal/cream/
  dark header states over an open option list). The header bars themselves
  are the SAME art as the button trio (verified: identical fill/outline/
  shadow palette), so the dropdown renders as a kit button + this chevron
  overlaid at the shared block scale — the chevron can't ride inside the
  9-slice (the stretch zone would smear it). The dark variant is the
  outline-colour caret the kit paints on the dark (open) header.

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

    # dropdown chevrons: the caret glyph alone, keyed off its header's fill
    # (normal header: shadow-brown caret on mid-brown; open header:
    # outline-dark caret on shadow-brown fill)
    for name, box, clear in (
        ("kit-chevron", (870, 498, 882, 510), {BG, (156, 91, 52)}),
        ("kit-chevron-dark", (870, 552, 882, 564), {BG, (96, 48, 38)}),
    ):
        b = cut(im, box, clear)
        b = b.crop(b.getbbox())
        b.save(OUT + name + ".png")
        print(name, b.size)

    # ICONS: complete square icon buttons (own plate + border baked in).
    # kit-icon-down (16x16): the download arrow — the select screen's
    # icon-only install button (maintainer picked it over the house).
    for name, box in (
        ("kit-icon-home", (640, 96, 672, 128)),
        ("kit-icon-down", (704, 198, 736, 230)),
    ):
        b = cut(im, box, {BG})
        b = b.crop(b.getbbox())
        b.save(OUT + name + ".png")
        print(name, b.size)

    # CHECKBOX (UI ELEMENTS, the stacked square pair right of the sliders):
    # an EMPTY dark box (OFF) and the SAME box with a bright centre (ON) —
    # the maintainer's checkbox states. Used by the Settings ambient-effect
    # switches (games-ui: each ambient effect toggles on/off on its own,
    # several compatible ones at once). 8x8 native, hard-edged like every
    # other flat kit plate (no soft alpha needed).
    for name, box in (
        ("kit-check-off", (1088, 366, 1104, 382)),
        ("kit-check-on", (1088, 386, 1104, 402)),
    ):
        b = cut(im, box, {BG})
        b = b.crop(b.getbbox())
        b.save(OUT + name + ".png")
        print(name, b.size)


if __name__ == "__main__":
    main()
