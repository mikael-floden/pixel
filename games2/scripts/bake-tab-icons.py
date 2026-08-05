#!/usr/bin/env python3
"""Bake the HUD tab icons from the maintainer's 1x pixel-art sources.

Sources: client/ui-src/icons/<tab>.png — the maintainer's icon set
(2026-07-22 round: gamepad, backpack, equipment, map, settings, logout),
authored at TRUE pixel scale on a 48x48 transparent canvas (binary alpha,
verified). The full canvas is kept — the artist's optical centering inside
it is part of the design — and baked at an EXACT 2x nearest-neighbour
upscale to client/public/ui2/icon-<tab>.webp (96x96), matching the tab
renderer's contract: the shipped file is a 2x bake displayed 1:1 CSS px at
the 980 design width, and at CSS zoom 0.5 (= the art's true 1x) on narrow
viewports (hud.ts media queries). Only those two integer scales ever hit
the screen.

Re-run after dropping new/updated sources into ui-src/icons/:
    python3 scripts/bake-tab-icons.py
"""

from pathlib import Path

from PIL import Image

SRC = Path("client/ui-src/icons")
OUT = Path("client/public/ui2")
TABS = ["gamepad", "backpack", "equipment", "map", "settings", "logout", "chat"]


def main():
    for tab in TABS:
        im = Image.open(SRC / f"{tab}.png").convert("RGBA")
        baked = im.resize((im.width * 2, im.height * 2), Image.NEAREST)
        # LOSSLESS WebP (project default 2026-07-31): VP8L is bit-exact, so
        # the nearest-neighbour bake is preserved pixel for pixel, at ~38% of
        # the PNG's bytes. `exact` keeps the RGB under transparent pixels too.
        baked.save(OUT / f"icon-{tab}.webp", "WEBP", lossless=True, method=6, exact=True)
        print(f"icon-{tab}.webp {baked.size[0]}x{baked.size[1]} (from {im.size[0]}x{im.size[1]})")


if __name__ == "__main__":
    main()
