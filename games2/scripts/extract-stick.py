#!/usr/bin/env python3
"""Split the maintainer's analog-stick art into TOP (cap) and BASE.

Source: client/ui-src/gamepad/stick-source.png — the "Classic Stock"
thumbstick (96x96, binary alpha, 2026-07-22 upload; his red-circle marking
was a hand hint, not a boundary). The split feeds the gamepad tab's
on-screen analog stick: the cap is the piece that moves under the thumb;
the base goes to an AI fill round-trip for the pixels hidden by the cap.

The cut respects the art's 1px border (maintainer: "hard to see" — it is
dark-on-dark): per column, the cap keeps its pixels down to the FIRST
border-family pixel (brightness <=35 reached from >=36), which is the 1px
outline; everything below is base. Where the shapes touch tangentially and
share a silhouette (no drawn border), explicit per-column guards stop the
scan at the base's surface row: left dome top y44 (x26-35), right lip
x60-64 y42 / x65-67 y43. The fused tangent outline px (26,43) goes to the
cap (border priority — it closes the cap's silhouette). The sheet's
"Classic Stock" caption (y>=84) is stripped from both outputs.

Invariant (asserted): cap ∪ base == source above the caption, cap ∩ base
== ∅ — compositing the cap back over the base reproduces the original
byte-for-byte.
"""

from PIL import Image

G = "client/ui-src/gamepad/"
CAP_SCAN_TOP, BORDER_MIN_Y, CAPTION_Y = 14, 43, 84


def main():
    im = Image.open(G + "stick-source.png").convert("RGBA")
    W, H = im.size
    p = im.load()
    v = lambda x, y: (p[x, y][0] + p[x, y][1] + p[x, y][2]) // 3
    art = lambda x, y: p[x, y][3] > 0

    base_top = {}
    for x in range(26, 36):
        base_top[x] = 44
    for x in range(60, 65):
        base_top[x] = 42
    for x in range(65, 68):
        base_top[x] = 43

    cap = [[False] * W for _ in range(H)]
    for x in range(W):
        ys = next((y for y in range(CAP_SCAN_TOP, 41) if art(x, y)), None)
        if ys is None:
            continue
        y = ys
        yb = None
        while y < H - 1:
            ny = y + 1
            if not art(x, ny):
                yb = y
                break
            if x in base_top and ny >= base_top[x]:
                yb = y
                break
            if ny >= BORDER_MIN_Y and v(x, ny) <= 35 and v(x, y) >= 36:
                yb = ny
                break
            y = ny
        if yb is None:
            yb = y
        for yy in range(ys, yb + 1):
            if art(x, yy):
                cap[yy][x] = True
    if art(26, 43) and v(26, 43) < 26:
        cap[43][26] = True

    cap_im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    base_im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cp, bp = cap_im.load(), base_im.load()
    for y in range(min(H, CAPTION_Y)):
        for x in range(W):
            if art(x, y):
                (cp if cap[y][x] else bp)[x, y] = p[x, y]

    rp = Image.alpha_composite(base_im, cap_im).load()
    for y in range(CAPTION_Y):
        for x in range(W):
            want = p[x, y] if art(x, y) else (0, 0, 0, 0)
            assert rp[x, y] == want, f"reassembly mismatch at {x},{y}"

    cap_im.save(G + "stick-top.png")
    base_im.save(G + "stick-base-holed.png")
    print("stick-top.png", cap_im.getbbox(), "/ stick-base-holed.png", base_im.getbbox())


if __name__ == "__main__":
    main()
