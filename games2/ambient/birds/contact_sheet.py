#!/usr/bin/env python3
"""Render labelled contact sheets of every ambient bird's fly animation.

This is the MAINTAINER'S-EYE VIEW used to decide which flap frames to cull:
each bird gets one block of 8 rows (the facings, in critters.ts DIR_INDEX
order) x 16 columns (the flap frames, named F1..F16 exactly as the maintainer
asked). Every cell is the real sheet cell blown up NEAREST-NEIGHBOUR, so what
you judge here is what the game draws.

Regenerate after ANY art change (resync.py) — a stale sheet means the frame
numbers you send back point at different pixels. Output is split into parts
because a single 8-bird sheet exceeds the chat upload's pixel limit.

    python games2/ambient/birds/contact_sheet.py [outdir] [--zoom N] [--per-part N]
"""
import os
import sys
import glob
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, "art")
FRAME = 34  # critters.ts FRAME_W / FRAME_H
NFRAMES = 16  # critters.ts FLY_FRAMES
# critters.ts DIR_INDEX — the fly.png ROW order. Labels are the maintainer's.
ROWS = ["S", "SE", "E", "NE", "N", "NW", "W", "SW"]

BG = (233, 233, 236)
CELL_A = (255, 255, 255)
CELL_B = (244, 244, 247)
GRID = (198, 198, 205)
INK = (26, 26, 32)
MUTED = (104, 104, 118)
ACCENT = (217, 119, 87)  # the project's coral

GUTTER = 104  # left label column
TITLE_H = 52
HEAD_H = 34
GAP = 30
PAD = 18


def font(size, bold=False):
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    try:
        return ImageFont.truetype(f"/usr/share/fonts/truetype/dejavu/{name}", size)
    except OSError:
        return ImageFont.load_default()


def birds():
    out = []
    for d in sorted(glob.glob(os.path.join(ART, "bird*")), key=lambda p: int(os.path.basename(p)[4:])):
        fly = os.path.join(d, "fly.png")
        if os.path.exists(fly):
            out.append((os.path.basename(d), fly))
    return out


def block(name, fly_path, zoom):
    """One bird: title + F1..F16 header + 8 labelled facing rows."""
    sheet = Image.open(fly_path).convert("RGBA")
    exp = (FRAME * NFRAMES, FRAME * len(ROWS))
    if sheet.size != exp:
        sys.exit(f"{name}: fly.png is {sheet.size}, expected {exp} — resync first")

    cell = FRAME * zoom
    w = GUTTER + NFRAMES * cell
    h = TITLE_H + HEAD_H + len(ROWS) * cell
    im = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(im)

    d.text((6, 12), name.upper(), font=font(30, True), fill=INK)
    d.text((6 + d.textlength(name.upper(), font=font(30, True)) + 16, 20),
           f"{NFRAMES} flap frames x {len(ROWS)} facings", font=font(17), fill=MUTED)

    y0 = TITLE_H + HEAD_H
    for c in range(NFRAMES):
        x = GUTTER + c * cell
        lab = f"F{c + 1}"
        d.text((x + (cell - d.textlength(lab, font=font(19, True))) / 2, TITLE_H + 7),
               lab, font=font(19, True), fill=ACCENT)

    for r, rl in enumerate(ROWS):
        y = y0 + r * cell
        d.text((10, y + cell / 2 - 13), rl, font=font(24, True), fill=INK)
        for c in range(NFRAMES):
            x = GUTTER + c * cell
            d.rectangle([x, y, x + cell - 1, y + cell - 1],
                        fill=CELL_A if (r + c) % 2 == 0 else CELL_B)
            src = sheet.crop((c * FRAME, r * FRAME, (c + 1) * FRAME, (r + 1) * FRAME))
            # NEAREST only — pixel art is never smoothed (repo rule).
            im.paste(src.resize((cell, cell), Image.NEAREST), (x, y), src.resize((cell, cell), Image.NEAREST))

    for r in range(len(ROWS) + 1):
        d.line([(GUTTER, y0 + r * cell), (w, y0 + r * cell)], fill=GRID)
    for c in range(NFRAMES + 1):
        d.line([(GUTTER + c * cell, y0), (GUTTER + c * cell, h)], fill=GRID)
    return im


def main():
    args = [a for a in sys.argv[1:]]
    zoom, per_part = 6, 3
    if "--zoom" in args:
        zoom = int(args[args.index("--zoom") + 1])
    if "--per-part" in args:
        per_part = int(args[args.index("--per-part") + 1])
    pos = [a for a in args if not a.startswith("--") and not a.isdigit()]
    outdir = pos[0] if pos else HERE

    bl = birds()
    if not bl:
        sys.exit(f"no bird art under {ART}")
    os.makedirs(outdir, exist_ok=True)

    parts = [bl[i:i + per_part] for i in range(0, len(bl), per_part)]
    written = []
    for pi, group in enumerate(parts, 1):
        blocks = [block(n, p, zoom) for n, p in group]
        w = max(b.width for b in blocks) + PAD * 2
        h = TITLE_H + sum(b.height + GAP for b in blocks) + PAD
        im = Image.new("RGB", (w, h), BG)
        d = ImageDraw.Draw(im)
        names = ", ".join(n for n, _ in group)
        d.text((PAD, 14), f"AMBIENT BIRDS — fly frames — part {pi}/{len(parts)}  ({names})",
               font=font(26, True), fill=INK)
        y = TITLE_H
        for b in blocks:
            im.paste(b, (PAD, y))
            y += b.height + GAP
        out = os.path.join(outdir, f"bird-fly-frames-part{pi}.png")
        im.save(out)
        written.append((out, im.size))
        print(f"part {pi}: {names}  -> {out}  {im.size[0]}x{im.size[1]}")

    if any(s[0] > 8000 or s[1] > 8000 for _, s in written):
        print("WARNING: a part exceeds ~8000px and may be rejected on upload; "
              "lower --zoom or --per-part")


if __name__ == "__main__":
    main()
