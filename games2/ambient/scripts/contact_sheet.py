#!/usr/bin/env python3
"""Render labelled contact sheets of every ambient FLYER's fly animation.

This is the MAINTAINER'S-EYE VIEW used to decide which flap frames to cull:
each critter gets one block of 8 rows (the facings, in critters.ts DIR_INDEX
order) x 16 columns (the flap frames, named F1..F16 exactly as the maintainer
asked). Every cell is the real sheet cell blown up NEAREST-NEIGHBOUR, so what
you judge here is what the game draws.

Covers every flyer that packs the shared 16x8 fly sheet — the 8 birds AND the
bat, which share the layout exactly (544x272 @ 34px). Format-agnostic: the
ambient art is migrating PNG -> lossless WebP and the bat has already flipped,
so sheets are found by STEM, never by extension.

Regenerate after ANY art change (birds/resync.py) — a stale sheet means the
frame numbers sent back point at different pixels. Output splits into parts
because one sheet with every critter exceeds the chat upload's pixel limit.

    python games2/ambient/scripts/contact_sheet.py [outdir] [--zoom N] [--per-part N]
    python games2/ambient/scripts/contact_sheet.py out --only bat
    python games2/ambient/scripts/contact_sheet.py out --original  # for a NEW cull round
"""
import os
import sys
import glob
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
AMBIENT = os.path.dirname(HERE)
BIRD_ART = os.path.join(AMBIENT, "birds", "art")
BAT_ART = os.path.join(AMBIENT, "bats", "art")
ORIG_ART = os.path.join(AMBIENT, "art-original")
FRAME = 34  # critters.ts FRAME_W / FRAME_H
NFRAMES = 16  # critters.ts FLY_FRAMES
IMG_EXTS = ("png", "webp")  # art domains are mid-migration; try both
# critters.ts DIR_INDEX — the fly sheet ROW order. Labels are the maintainer's.
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


def _fly(dirpath):
    """The fly sheet in dirpath, whatever image format it currently ships as."""
    for e in IMG_EXTS:
        p = os.path.join(dirpath, f"fly.{e}")
        if os.path.exists(p):
            return p
    return None


def critters(original=False):
    """Every flyer packing the shared 16x8 sheet: the 8 birds, then the bat.

    original=True reads art-original/ — the UNCULLED 16-frame sheets. Use that
    for a new culling round: the numbers written on those sheets are the ones
    cull.json speaks, so a frame named there can be dropped verbatim. The
    SHIPPED sheets have been repacked (kept frames slid left), so F5 on a culled
    sheet is a different frame than F5 on the original.
    """
    if original:
        out = []
        for d in sorted(glob.glob(os.path.join(ORIG_ART, "bird*")),
                        key=lambda p: int(os.path.basename(p)[4:])):
            p = _fly(d)
            if p:
                out.append((os.path.basename(d), p))
        p = _fly(os.path.join(ORIG_ART, "bat"))
        if p:
            out.append(("bat", p))
        return out
    out = []
    for d in sorted(glob.glob(os.path.join(BIRD_ART, "bird*")),
                    key=lambda p: int(os.path.basename(p)[4:])):
        p = _fly(d)
        if p:
            out.append((os.path.basename(d), p))
    p = _fly(BAT_ART)
    if p:
        out.append(("bat", p))
    return out


def block(name, fly_path, zoom):
    """One bird: title + F1..F16 header + 8 labelled facing rows."""
    sheet = Image.open(fly_path).convert("RGBA")
    exp = (FRAME * NFRAMES, FRAME * len(ROWS))
    if sheet.size != exp:
        sys.exit(f"{name}: {os.path.basename(fly_path)} is {sheet.size}, "
                 f"expected {exp} — resync first")

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
    only = args[args.index("--only") + 1].split(",") if "--only" in args else None
    original = "--original" in args
    skip = {"--zoom", "--per-part", "--only"}
    pos, i = [], 0
    while i < len(args):
        if args[i] in skip:
            i += 2
            continue
        if not args[i].startswith("--"):
            pos.append(args[i])
        i += 1
    outdir = pos[0] if pos else HERE

    cl = critters(original)
    if only:
        cl = [(n, p) for n, p in cl if n in only]
    if not cl:
        sys.exit(f"no flyer art found under {BIRD_ART} / {BAT_ART}")
    os.makedirs(outdir, exist_ok=True)

    parts = [cl[i:i + per_part] for i in range(0, len(cl), per_part)]
    written = []
    for pi, group in enumerate(parts, 1):
        blocks = [block(n, p, zoom) for n, p in group]
        w = max(b.width for b in blocks) + PAD * 2
        h = TITLE_H + sum(b.height + GAP for b in blocks) + PAD
        im = Image.new("RGB", (w, h), BG)
        d = ImageDraw.Draw(im)
        names = ", ".join(n for n, _ in group)
        d.text((PAD, 14), f"AMBIENT FLYERS — fly frames{' — ORIGINAL (uncut)' if original else ' — CULLED (shipping)'}"
               f" — part {pi}/{len(parts)}  ({names})",
               font=font(26, True), fill=INK)
        y = TITLE_H
        for b in blocks:
            im.paste(b, (PAD, y))
            y += b.height + GAP
        out = os.path.join(outdir, f"ambient-fly-frames-{'original' if original else 'culled'}-part{pi}.png")
        im.save(out)
        written.append((out, im.size))
        print(f"part {pi}: {names}  -> {out}  {im.size[0]}x{im.size[1]}")

    if any(s[0] > 8000 or s[1] > 8000 for _, s in written):
        print("WARNING: a part exceeds ~8000px and may be rejected on upload; "
              "lower --zoom or --per-part")


if __name__ == "__main__":
    main()
