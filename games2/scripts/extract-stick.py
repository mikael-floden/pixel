#!/usr/bin/env python3
"""Split the maintainer's analog-stick art into TOP and BASE.

Source: client/ui-src/gamepad/stick-source.png — the "Classic Stock"
thumbstick (96x96, binary alpha, 2026-07-22 upload). The split feeds the
gamepad tab's on-screen analog stick: the TOP is the piece that moves
under the thumb; the BASE (dome ring, with a transparent hole) goes to an
AI fill round-trip for the pixels the top occluded.

THE BOUNDARY IS THE MAINTAINER'S, PIXEL-EXACT (2026-07-22, round 3): on
the 16x grid render he marked the not-top boundary as RED flank staircases
plus a BLUE mid line (rows 49/50) — "the blue line and not the green line"
— replacing his earlier GREEN deep sweep (git history), which would have
taken the stalk + shadow well with the top. Both screenshots register back
to art coordinates identically (orange grid pitch ~93.4 shot-px per 4 art
px + content correlation, line0 = art (26,40), SSD 0.4-0.5 — unambiguous).
MARKED below is the decoded red+blue set verbatim (min row per column is
what cuts): the top = the mushroom cap incl. its under-lip shading down to
the shadow's first rows; the stalk, shadow well and dome stay base. The
first heuristic cut (border-valley tracing) is also in git history.

Per column: top = art pixels from the silhouette top down to (first marked
row) - 1; marked pixels and everything below stay base. The sheet's
"Classic Stock" caption (y>=84) is stripped from both outputs.

Invariant (asserted): top ∪ base == source above the caption, top ∩ base
== ∅ — compositing the top back over the base reproduces the original
byte-for-byte.
"""

from PIL import Image

G = "client/ui-src/gamepad/"
CAPTION_Y = 84

# The maintainer's marked NOT-top pixels (art coords), decoded from his red
# staircase. dict: y -> sorted x list.
MARKED = {
    37: [23],
    38: [23, 24],
    39: [24, 68],
    40: [24, 25, 67, 68],
    41: [25, 67],
    42: [25, 26, 66, 67],
    43: [26, 27, 65, 66],
    44: [27, 28, 64, 65],
    45: [28, 29, 63],
    46: [29, 30, 31, 62, 63],
    47: [31, 32, 33, 59, 60, 61],
    48: [33, 34, 58, 59],
    49: [34, 35, 36, 37, 38, 54, 55, 56, 57, 58],
    50: [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54],
}


def main():
    im = Image.open(G + "stick-source.png").convert("RGBA")
    W, H = im.size
    p = im.load()
    art = lambda x, y: p[x, y][3] > 0

    # first marked row per column = the top's exclusive lower bound
    stop = {}
    for y, xs in MARKED.items():
        for x in xs:
            stop[x] = min(stop.get(x, H), y)

    top_im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    base_im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    tp, bp = top_im.load(), base_im.load()
    for y in range(min(H, CAPTION_Y)):
        for x in range(W):
            if not art(x, y):
                continue
            is_top = x in stop and y < stop[x]
            (tp if is_top else bp)[x, y] = p[x, y]

    rp = Image.alpha_composite(base_im, top_im).load()
    for y in range(CAPTION_Y):
        for x in range(W):
            want = p[x, y] if art(x, y) else (0, 0, 0, 0)
            assert rp[x, y] == want, f"reassembly mismatch at {x},{y}"

    top_im.save(G + "stick-top.png")
    base_im.save(G + "stick-base-holed.png")
    print("stick-top.png", top_im.getbbox(), "/ stick-base-holed.png", base_im.getbbox())


if __name__ == "__main__":
    main()
