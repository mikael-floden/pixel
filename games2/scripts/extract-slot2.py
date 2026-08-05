#!/usr/bin/env python3
"""Extract the REAL backpack slot from the maintainer's round-2 concept.

Source: the maintainer's original round-2 concept page (768x1376 — the SAME
image frame.png was extracted from; verified 98.6% pixel-identical in the
frame's opaque areas, the rest being the frame's inpainted patches). It is
not committed to the repo — pass its path as argv[1] to re-run.

The concept's backpack page holds a 5x3 grid of slots (twig/bark frame,
moss rim, dark recess) on the mossy stone backdrop: cols x=46,182,318,454,
590 / rows y=890,1030,1170, each slot a ~128x128 module (pitch 136/140).
This script cuts ONE slot (r2c3 — fullest moss ring, cleanest rim, no frame
decorations intruding) and keys the stone out:

- classify backdrop as the muted grey-green stone family (g>=r, low
  saturation, incl. its darker shadowed variants; very dark pixels only
  count when clearly greenish so the bark's warm/neutral dark outline is
  never nibbled),
- flood from the crop border so the ENCLOSED dark-green recess survives
  (it is colour-wise close to shadowed stone),
- keep the largest connected component (drops loose moss tufts that belong
  to the backdrop),
- finish the cut edge with SOFT ALPHA (boundary ring at ~50%) per the house
  keying rules — never a hard 100%->0% step.

Output: client/public/ui2/slot2.png (128x128, native frame-space px).
.ml-slot displays it at the frame's own scale (--ml-fs) so 1 slot px scales
exactly like 1 frame px — the art never stretches and never resamples
beyond the frame's single uniform nearest-neighbour scale.
"""

import sys
from collections import deque

from PIL import Image

CELL = (454, 1035, 594, 1185)  # r2c3 window (x0, y0, x1, y1)
OUT = "client/public/ui2/slot2.png"


def stoneish(r, g, b):
    sat = max(r, g, b) - min(r, g, b)
    if not (g >= r and g >= b - 4):
        return False
    if (g - r) > 30 or (g - b) > 38 or sat > 42:
        return False
    if g > 135 or g < 12:
        return False
    if g < 35 and (g - r) < 5:  # dark: only clearly-green counts as backdrop
        return False
    return True


def main():
    src = Image.open(sys.argv[1]).convert("RGB")
    px = src.load()
    x0, y0, x1, y1 = CELL
    w, h = x1 - x0, y1 - y0
    back = [[False] * w for _ in range(h)]
    seen = [[False] * w for _ in range(h)]
    q = deque()
    for x in range(w):
        q += [(x, 0), (x, h - 1)]
    for y in range(h):
        q += [(0, y), (w - 1, y)]
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y][x]:
            continue
        seen[y][x] = True
        if not stoneish(*px[x0 + x, y0 + y]):
            continue
        back[y][x] = True
        q += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    # largest connected non-backdrop component
    comp = [[0] * w for _ in range(h)]
    sizes = {0: 0}
    cid = 0
    for yy in range(h):
        for xx in range(w):
            if back[yy][xx] or comp[yy][xx]:
                continue
            cid += 1
            n = 0
            q2 = deque([(xx, yy)])
            comp[yy][xx] = cid
            while q2:
                x, y = q2.popleft()
                n += 1
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not back[ny][nx] and not comp[ny][nx]:
                        comp[ny][nx] = cid
                        q2.append((nx, ny))
            sizes[cid] = n
    main_id = max(sizes, key=sizes.get)
    xs = [x for y in range(h) for x in range(w) if comp[y][x] == main_id]
    ys = [y for y in range(h) for x in range(w) if comp[y][x] == main_id]
    bx0, bx1, by0, by1 = min(xs), max(xs), min(ys), max(ys)
    out = Image.new("RGBA", (bx1 - bx0 + 1, by1 - by0 + 1), (0, 0, 0, 0))
    op = out.load()
    for y in range(by0, by1 + 1):
        for x in range(bx0, bx1 + 1):
            if comp[y][x] == main_id:
                op[x - bx0, y - by0] = (*px[x0 + x, y0 + y], 255)
    # soft cut edge: boundary pixels at ~50% alpha
    W, H = out.size
    for y in range(H):
        for x in range(W):
            r, g, b, a = op[x, y]
            if a == 0:
                continue
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if nx < 0 or ny < 0 or nx >= W or ny >= H or op[nx, ny][3] == 0:
                    op[x, y] = (r, g, b, 130)
                    break
    out.save(OUT)
    print(OUT, out.size)


if __name__ == "__main__":
    main()
