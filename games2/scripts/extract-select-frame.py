#!/usr/bin/env python3
"""Key the maintainer's select-screen vine border out of its magenta sheet.

Source: the maintainer's 768x1376 border art on a uniform magenta backdrop
(2026-07-18). Not committed — pass its path as argv[1] to re-run.

Steps:
- colour-key the magenta (distance < 90 from the sampled backdrop colour),
- keep only the largest connected component (drops the interior sparkle),
- DE-FRINGE: kept pixels still leaning magenta (b > g+8 — impossible for
  wood/leaf colours) take the mean colour of their clean neighbours within
  radius 2, or drop when none exists (anti-aliased key blends survive the
  distance threshold and otherwise rim the border pink),
- finish the cut edge with SOFT ALPHA (boundary ring at ~50%) per the house
  keying rules.

Output: client/public/ui2/select-frame.png (768x1376 RGBA). frame2.ts
composes it like the in-game frame (composeSelect): stretch cuts through
plain wood + own-face fiber, rendered at the same "1.5x" scale.
"""

import sys
from collections import deque

from PIL import Image

OUT = "client/public/ui2/select-frame.png"


def main():
    im = Image.open(sys.argv[1]).convert("RGB")
    W, H = im.size
    px = im.load()
    key = px[400, 700]
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    op = out.load()
    for y in range(H):
        for x in range(W):
            p = px[x, y]
            d = (p[0] - key[0]) ** 2 + (p[1] - key[1]) ** 2 + (p[2] - key[2]) ** 2
            if d >= 90 * 90:
                op[x, y] = (*p, 255)
    # largest connected component only
    comp = [[0] * W for _ in range(H)]
    sizes = {}
    cid = 0
    for yy in range(H):
        for xx in range(W):
            if op[xx, yy][3] == 0 or comp[yy][xx]:
                continue
            cid += 1
            n = 0
            q = deque([(xx, yy)])
            comp[yy][xx] = cid
            while q:
                x, y = q.popleft()
                n += 1
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < W and 0 <= ny < H and op[nx, ny][3] > 0 and not comp[ny][nx]:
                        comp[ny][nx] = cid
                        q.append((nx, ny))
            sizes[cid] = n
    main_id = max(sizes, key=sizes.get)
    for y in range(H):
        for x in range(W):
            if op[x, y][3] > 0 and comp[y][x] != main_id:
                op[x, y] = (0, 0, 0, 0)

    def clean(p):
        return p[3] > 0 and p[2] <= p[1] + 8

    for x, y in [(x, y) for y in range(H) for x in range(W)
                 if op[x, y][3] > 0 and not clean(op[x, y])]:
        acc = [0, 0, 0]
        n = 0
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H and clean(op[nx, ny]):
                    q = op[nx, ny]
                    acc[0] += q[0]
                    acc[1] += q[1]
                    acc[2] += q[2]
                    n += 1
        op[x, y] = (acc[0] // n, acc[1] // n, acc[2] // n, 255) if n else (0, 0, 0, 0)
    # soft cut edge
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
