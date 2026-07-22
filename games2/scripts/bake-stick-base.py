#!/usr/bin/env python3
"""Bake the AI-filled stick base back to true pixel scale.

Source: client/ui-src/gamepad/stick-base-fill-src.png — the maintainer's
Gemini round-trip of stick-base-holed.png (2026-07-22): the dome re-imagined
with a recessed SOCKET well (purple iris + a pale-green crystal glint
cluster) where the stick top sat. Gemini outputs pixel-art-LOOKING graphics
that are neither 1px-per-pixel nor uniformly scaled (measured 18.16x
horizontal vs 20.19x vertical here, on a re-rendered teal backdrop), so:

1. REGISTRATION — the art rect (49,116,1048,843) was found by
   box-downscaling candidate rects onto the original 55x36 cell grid and
   minimizing SSD against the KNOWN ring pixels of stick-base-holed.png
   (coarse bbox search + 1px refinement, unambiguous).
2. BACKDROP KEY by the teal's HUE SIGNATURE — (b-r)>10 ∧ (g-r)>8 ∧
   b>=g-6 ∧ r<90 — NOT by generic chroma or a colour box: the first ate
   the crystal's pale greens ("you destroyed the nice looking crystal"),
   the second ate the dome's own mid-greys. Greys, purples and greens all
   fail the teal test.
3. REDUCER — per art cell, the DOMINANT colour cluster (quantized /24,
   ties to the brighter cluster; final colour = mean of the winning
   cluster's members). A plain mean muddied the thin crystal shards into
   grey; dominant keeps crisp pixel-art colour choices. Cell opaque at
   >=50% non-backdrop coverage (binary alpha, like every stick source).
4. FOOTPRINT — cells outside the ORIGINAL stick footprint (holed base ∪
   cap hole) are dropped (11 stray Gemini specks). No back-fill from the
   original where Gemini has nothing: it deliberately LOWERED the dome-top
   profile into the socket opening, and restoring the old corners painted
   floating "horns" (tried, reverted).

Output: stick-base-filled.png on the original 96x96 canvas at (19,43) —
drop-in registered with stick-top.png.
"""

from collections import Counter

from PIL import Image

G = "client/ui-src/gamepad/"
BOX = (49, 116, 1048, 843)          # registered art rect in the Gemini image
BX0, BY0, AW, AH = 19, 43, 55, 36   # the base art box on the 96x96 canvas


def isbg(c):
    r, g, b = c
    return (b - r) > 10 and (g - r) > 8 and b >= g - 6 and r < 90


def main():
    gem = Image.open(G + "stick-base-fill-src.png").convert("RGB")
    old = Image.open(G + "stick-base-holed.png").convert("RGBA")
    top = Image.open(G + "stick-top.png").convert("RGBA")
    gp, op, tp = gem.load(), old.load(), top.load()
    x0, y0, x1, y1 = BOX
    cw, ch = (x1 - x0) / AW, (y1 - y0) / AH

    out = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    q = out.load()
    specks = 0
    for j in range(AH):
        for i in range(AW):
            x, y = BX0 + i, BY0 + j
            px, tot = [], 0
            for yy in range(int(y0 + j * ch), int(y0 + (j + 1) * ch)):
                for xx in range(int(x0 + i * cw), int(x0 + (i + 1) * cw)):
                    c = gp[xx, yy]
                    tot += 1
                    if not isbg(c):
                        px.append(c)
            if not tot or len(px) / tot < 0.5:
                continue
            if not (op[x, y][3] or tp[x, y][3]):
                specks += 1
                continue
            buckets = Counter((c[0] // 24, c[1] // 24, c[2] // 24) for c in px)
            top_n = max(buckets.values())
            win = max((b for b, n in buckets.items() if n == top_n), key=lambda b: sum(b))
            mem = [c for c in px if (c[0] // 24, c[1] // 24, c[2] // 24) == win]
            q[x, y] = (
                round(sum(c[0] for c in mem) / len(mem)),
                round(sum(c[1] for c in mem) / len(mem)),
                round(sum(c[2] for c in mem) / len(mem)),
                255,
            )
    out.save(G + "stick-base-filled.png")
    print(f"stick-base-filled.png {out.getbbox()} (specks dropped: {specks})")


if __name__ == "__main__":
    main()
