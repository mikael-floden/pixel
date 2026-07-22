#!/usr/bin/env python3
"""Bake the 360-degree clock wheel to game scale — /ui2/clock360.png.

The maintainer's full-circle wheel (client/ui-src/clock360/clock360-keyed.png,
1069x1008, backdrop keyed + 4 mark rounds, approved "pixel perfect"
2026-07-22) REPLACES the old extracted half-disc (/ui2/clock-disc.png) in the
game. Content registration of its DAY half against the old in-game disc
(scratchpad register-clock360.py: grey SSD over the old disc's opaque px,
seeded from the wheel geometry) locked scale s=0.338 (~1/2.96 — the wheel was
authored at ~3x the old art) with the wheel centre landing within 1 px of the
hand pivot / strap stub (frame art 385,88). The bake pins the centre EXACTLY
to the pivot: that identity is what the animated hand (clock.ts) and any
future wheel rotation pivot on.

Output: the FULL wheel, NEAREST-resized to 361x341 (game px). frame2.ts
composites it UNDER the frame art (frame-over-wheel), clipped to frame rows
>= 60 (the old disc box top): the top beam hides the divide line and the
night half except through its vine gaps, the day half hangs below the beam
where the old disc hung, and the wheel's keyed transparency keeps everything
outside its silhouette untouched.

Derived constants (printed, mirrored in frame2.ts):
  scaled size 361x341, wheel centre ~(180,165) in scaled px,
  paste top-left frame (205,-77), source clip row 137 (= frame y 60).
"""

from PIL import Image

SRC = "client/ui-src/clock360/clock360-keyed.png"
OUT = "client/public/ui2/clock360.png"
OLD = "client/public/ui2/clock-disc.png"  # coverage report only
S = 0.338
CENTRE = (533.0, 489.0)   # wheel centre in source px (divide-line middle)
PIVOT = (385, 88)         # frame art px: strap stub, the hand's pivot
CLIP_FRAME_Y = 60         # nothing pastes above this frame row (old box top)

im = Image.open(SRC).convert("RGBA")
W, H = im.size
OW = round(W * S)
OH = round(H * S)
out = im.resize((OW, OH), Image.NEAREST)
out.save(OUT)

cx = (CENTRE[0] + 0.5) * OW / W - 0.5
cy = (CENTRE[1] + 0.5) * OH / H - 0.5
px0 = PIVOT[0] - round(cx)
py0 = PIVOT[1] - round(cy)
sy0 = CLIP_FRAME_Y - py0
print(f"baked {OW}x{OH}, centre=({cx:.1f},{cy:.1f})")
print(f"frame paste top-left=({px0},{py0}), source clip row sy0={sy0}")

# coverage report: old-disc pixels the new wheel does NOT cover would show
# page background where art used to be — expect only outer-wreath fringe
# (the redrawn wreath legitimately differs), nothing inside the face.
# (one-time migration check — the retired asset is gone after the switch)
import os

if not os.path.exists(OLD):
    print("old disc asset retired — coverage report skipped")
    raise SystemExit(0)
old = Image.open(OLD).convert("RGBA")
op = old.load()
np_ = out.load()
DISC_POS = (217, 60)
miss = []
for y in range(old.size[1]):
    for x in range(old.size[0]):
        if op[x, y][3] <= 128:
            continue
        fx = DISC_POS[0] + x
        fy = DISC_POS[1] + y
        sx = fx - px0
        sy = fy - py0
        if not (0 <= sx < OW and 0 <= sy < OH) or np_[sx, sy][3] <= 128:
            miss.append((fx, fy))
print(f"old-disc px not covered by the wheel: {len(miss)}")
if miss:
    xs = [m[0] for m in miss]
    ys = [m[1] for m in miss]
    print(f"  bbox frame ({min(xs)},{min(ys)})-({max(xs)},{max(ys)})")
