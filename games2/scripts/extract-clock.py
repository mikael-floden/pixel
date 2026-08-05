#!/usr/bin/env python3
"""Split the zodiac CLOCK DISC out of the HUD frame.

Source: client/ui-src/frame-clock-src.png — the original 768x1376 frame
WITH the baked disc. The maintainer wants the clock as its own graphic
(2026-07-22: "the clock should not be part of the frame graphics, but the
location is perfect as it is"), so this produces:

  client/public/ui2/frame.png       the frame with the disc removed
  client/public/ui2/clock-disc.png  the disc + vine wreath, tight-cropped
                                    at DISC_POS (frame coords) — frame2.ts
                                    pastes it back there at load

THE BOUNDARY IS THE MAINTAINER'S: he marked the rail/disc border in RED on
a live screenshot (registered back to frame coords at scale 1.0547, offset
(185,9) by content correlation); the BLUE span x374-402 was hidden behind
the runtime clock hand in his shot, so the contour is interpolated there —
the compass rosette and the short strap stub stay with the RAIL, the disc
carries the notch. ROUND 2 (maintainer marks on the posted split): the
strap-stub remnant in the notch (x375-393) and his blue-marked rail-border
rows (clusters x240-529) moved BACK to the frame — 'you have taken too
much frame border'. CUT_Y is the corrected per-column contour
(columns 232..533; frame keeps y <= cut, the clock takes opaque y > cut).
Outside that span the split is by CONNECTIVITY within the wreath
neighbourhood (x 200-580): rail art is the contiguous run from the top;
anything after the first transparent break is wreath -> clock. Verified:
no rail-vine/wreath merges exist in the flank columns.

Invariant (asserted): disc ∪ clockless frame == the original, byte-exact,
zero overlap — so frame2.ts' load-time paste reproduces the composed frame
pixel-for-pixel.
"""

from PIL import Image

SRC = "client/ui-src/frame-clock-src.png"
OUT_FRAME = "client/public/ui2/frame.png"
OUT_DISC = "client/public/ui2/clock-disc.png"
X0, X1 = 232, 533
CLOCK_ROWS = 300
WREATH_X = (200, 580)
DISC_POS = (217, 60)  # tight-crop origin, frame coords (frame2.ts pastes here)
CUT_Y = [
    68, 68, 67, 67, 66, 66, 67, 67, 67, 67, 67, 67, 67, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64,
    64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 63, 63, 64,
    64, 64, 63, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 65, 66, 66, 66, 68, 68, 68, 68, 70, 70, 70,
    70, 70, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 71, 71, 72, 72, 71, 70, 70, 70, 69, 68,
    68, 68, 67, 67, 64, 64, 64, 64, 64, 64, 62, 62, 63, 63, 63, 62, 62, 61, 61, 61, 60, 60, 60, 60,
    61, 62, 64, 63, 64, 68, 68, 70, 70, 70, 70, 70, 69, 64, 64, 64, 64, 64, 64, 64, 64, 65, 65, 66,
    66, 68, 69, 71, 72, 79, 80, 80, 79, 79, 79, 79, 79, 79, 79, 69, 68, 68, 66, 66, 66, 66, 66, 66,
    66, 67, 67, 68, 68, 68, 66, 66, 66, 65, 63, 63, 62, 61, 61, 60, 60, 59, 59, 59, 59, 59, 60, 61,
    61, 61, 61, 63, 63, 63, 63, 63, 63, 63, 64, 64, 64, 67, 67, 67, 68, 69, 70, 70, 70, 70, 70, 70,
    70, 71, 72, 71, 71, 70, 70, 70, 71, 71, 70, 70, 70, 70, 70, 70, 68, 68, 68, 67, 66, 66, 64, 64,
    63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 64, 63, 63,
    63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63,
    63, 63, 62, 63, 63, 63, 63, 63, 63, 64, 63, 64, 63, 63,
]


def main():
    fr = Image.open(SRC).convert("RGBA")
    W, H = fr.size
    p = fr.load()
    clock = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    frame = fr.copy()
    cp, fp = clock.load(), frame.load()
    for x in range(W):
        if X0 <= x <= X1:
            cut = CUT_Y[x - X0]
            for y in range(CLOCK_ROWS):
                if y > cut and p[x, y][3] > 0:
                    cp[x, y] = p[x, y]
                    fp[x, y] = (0, 0, 0, 0)
        elif WREATH_X[0] <= x < WREATH_X[1]:
            if not any(p[x, y][3] > 0 for y in range(0, 55)):
                continue
            y = 40
            while y < CLOCK_ROWS and p[x, y][3] > 0:
                y += 1
            for yy in range(y, CLOCK_ROWS):
                if p[x, yy][3] > 0:
                    cp[x, yy] = p[x, yy]
                    fp[x, yy] = (0, 0, 0, 0)

    rp = Image.alpha_composite(frame, clock).load()
    for y in range(H):
        for x in range(W):
            assert rp[x, y] == p[x, y], f"reassembly mismatch at {x},{y}"
            assert not (cp[x, y][3] and fp[x, y][3]), f"overlap at {x},{y}"

    bb = clock.getbbox()
    assert (bb[0], bb[1]) == DISC_POS, f"disc origin moved: {bb}"
    frame.save(OUT_FRAME)
    clock.crop(bb).save(OUT_DISC)
    print(f"frame.png (clockless) + clock-disc.png {bb[2]-bb[0]}x{bb[3]-bb[1]} at {DISC_POS}")


if __name__ == "__main__":
    main()
