#!/usr/bin/env python3
"""Bake the 360-degree clock wheel to game scale — /ui2/clock360.png.

The maintainer's full-circle wheel (client/ui-src/clock360/clock360-keyed.png,
1069x1008, backdrop keyed + de-fringed, approved 2026-07-22) is the game's
LIVE clock: clock.ts hangs it behind the frame at the strap stub and rotates
it 180° at each day/night hand-off. Content registration of its DAY half
against the old in-game half-disc (scratchpad register-clock360.py: grey SSD
over the old disc's opaque px) locked scale s=0.338 (~1/2.96 — the wheel was
authored at ~3x the old art) with the wheel centre landing within 1 px of the
hand pivot / strap stub (frame art 385,88).

The output canvas is built SYMMETRIC about the wheel centre so CSS rotations
land back on the pixel grid: source centre (533.5, 489.5) — divide-line
middle — maps exactly to the canvas middle. 365x353 canvas → centre px index
(182,176), i.e. css transform-origin (182.5, 176.5) at scale 1. A plain
PIL resize left the centre at fractional (179.7,165.1) inside the canvas,
which would smear every 180° flip by a sub-pixel offset.

Constants for clock.ts's WHEEL: w=365 h=353 cx=182.5 cy=176.5 (art px;
multiply by the frame scale). The layer clips at frame row 60 (CLIP_Y) so
nothing shows above the beam; the beam art itself hides the divide line and
the resting night half.
"""

from PIL import Image

SRC = "client/ui-src/clock360/clock360-keyed.png"
OUT = "client/public/ui2/clock360.png"
S = 0.338
SCX, SCY = 533.5, 489.5   # wheel centre, source coords (divide-line middle)
OW, OH = 365, 353         # odd: centre px = canvas middle
CXI, CYI = (OW - 1) // 2, (OH - 1) // 2

im = Image.open(SRC).convert("RGBA")
W, H = im.size
p = im.load()
out = Image.new("RGBA", (OW, OH), (0, 0, 0, 0))
o = out.load()
filled = 0
for oy in range(OH):
    sy = int((SCY + (oy - CYI) / S) // 1)
    if not 0 <= sy < H:
        continue
    for ox in range(OW):
        sx = int((SCX + (ox - CXI) / S) // 1)
        if 0 <= sx < W:
            px = p[sx, sy]
            if px[3]:
                o[ox, oy] = px
                filled += 1
out.save(OUT)
print(f"baked {OW}x{OH}, centre px ({CXI},{CYI}) = origin ({CXI + 0.5},{CYI + 0.5})")
print(f"content px: {filled}, bbox: {out.getbbox()}")
