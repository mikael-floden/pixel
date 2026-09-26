#!/usr/bin/env python3
"""Bake the HUD's PIXELLAB ICONS from the maintainer's own exports — the
select screen's and game view's corner icons, and the record button's two
faces. (The name is the original four; the recipe was always "his export ->
exact 2x -> /ui2" and that is what the entries below are.)

Sources: client/ui-src/icon-<name>-src.png — the UNTOUCHED export is the pixel
source of record (his reposted images accumulate JPEG artifacts, so the first
upload is what we keep). Any size, binary alpha; the corner icons are 24x24
and the record faces 48x48. The bake is an EXACT 2x nearest-neighbour upscale
to client/public/ui2/icon-<name>.webp, which the runtime then sizes to
naturalWidth/2 — that lands every icon on its authored grid at any screen
density, and it is ONE rule shared with the tab icons rather than a hardcoded
box per icon (UI_AGENT.md).

    python3 scripts/bake-corner-icons.py           # verify only, writes nothing
    python3 scripts/bake-corner-icons.py --write   # bake

WHY THIS SCRIPT EXISTS. The first three were baked by hand in 2026-09-03/04,
so the transforms lived only in a commit message and the icons could not be
reproduced. Every transform is ASSERTED here instead, because a resample that
softens pixel art is invisible until it is on his phone: a mirror must be a
pure mirror, a 2x must reproduce the source in every 2x2 block, and a
re-centring must move the same pixels it started with. The three already on
disk are re-baked and compared BYTE FOR BYTE — if this script and the shipped
file ever disagree, one of them is wrong and the run fails rather than
overwriting his art.

THE TRANSFORMS, one line each:
  wiki     none    — the open book, as exported.
  theme    centre  — its export sat flush to two canvas edges while the book
                     beside it was centred; side by side in the SHARED .ml-cicon
                     box that reads as 2px of exactly the misalignment the box
                     exists to prevent. Pure integer translation, -2/+2.
  search   mirror  — the antique magnifying glass, flipped (maintainer's own).
  record   none    — the record button's IDLE face: lamp dark, knob raised.
  record-on none   — its RECORDING face: lamp lit with a halo, knob pressed
                     (maintainer 2026-09-18: "if you press the button it
                     should change state to red/recording"). Which export is
                     which was MEASURED, not guessed from the file order: the
                     lit face carries 88 warm pixels peaking at 188, the idle
                     one 16 peaking at 98.
  report   centre  — the bug (PixelLab prompt "Report code bug", 2026-09-19:
                     the freeze button became a wiki-style pill, "a 24x24 icon
                     and text instead"). 24x24 like the other corner icons,
                     which is what let it join them; the 48x48 record/record-on
                     plates below are RETIRED with the button they drew and are
                     kept only because they are his art and this script proves
                     the bake of every entry it lists.
                     CENTRED, on his eye: the export's ink sits at y 6..21 of a
                     24px canvas — six above, three below — and read low beside
                     the label ("I feel the Report bug should be lifted a couple
                     of pixels to feel more vertically centered"). `centre`
                     computes dy = -2 and dx = 0 for it, so the fix IS this
                     transform, asserted like every other: pure integer
                     translation, same pixels, nothing clipped.
  install  none    — the gold download arrow (PixelLab prompt "Download",
                     2026-09-13: "the new download game icon on the character
                     select screen"). Its 18x21 ink sits 2px from the top and
                     1px from the bottom: an odd remainder cannot split evenly,
                     so that IS centred to the pixel, and the artist's optical
                     placement inside the canvas is part of the design (the tab
                     bake keeps the full canvas for the same reason). Nothing
                     to correct — and a 1px "improvement" here would be us
                     re-framing his art on a hunch.
"""

import sys
from pathlib import Path

from PIL import Image

SRC = Path("client/ui-src")
OUT = Path("client/public/ui2")
# name -> transform: "none" | "mirror" | "centre"
ICONS = {
    "wiki": "none",
    "theme": "centre",
    "search": "mirror",
    "install": "none",
    "record": "none",
    "record-on": "none",
    "report": "centre",
    "arrow": "none",
}

# THE SPIN BAR'S ORB (spinbar.ts). His animation arrives as a GIF, which the
# browser cannot be scrubbed frame by frame, so it is baked into ONE horizontal
# strip the CSS steps through with background-position — the same "his export ->
# exact 2x -> /ui2" recipe as the icons, just laid out in a row.
#   name -> (source, frames kept)
# EVERY FRAME IS KEPT, and that is the rule: his export is a CLOSED LOOP whose
# last frame hands back to its first, so it carries N authored transitions, not
# N-1. Dropping one replaces two of them with a single join that covers twice
# the rotation — a snap, always at the cut. An 8-frame cut shipped on
# 2026-09-26 and he saw it immediately ("the rotation animation snaps at the
# last frame"), which is also what settled the clip's span: a press plays the
# whole strip, and had that been a full 360° he would have reported a full
# spin rather than a seam. The strip IS the quarter turn. `keep` stays as a
# parameter because a future export may need aiming — but trimming a closed
# loop for smoothness is the one thing it cannot do.
STRIPS = {
    "spin-orb": ("spin-orb-src.gif", 9),
}


def mirror(im: Image.Image) -> Image.Image:
    out = im.transpose(Image.FLIP_LEFT_RIGHT)
    # a mirror is a permutation of the SAME pixels: every column swaps with its
    # partner and nothing is resampled.
    for y in range(im.height):
        for x in range(im.width):
            assert out.getpixel((x, y)) == im.getpixel((im.width - 1 - x, y)), "mirror moved a pixel"
    return out


def centre(im: Image.Image) -> Image.Image:
    bb = im.getbbox()  # (l, u, r, b), r/b exclusive
    if bb is None:
        raise SystemExit("an empty canvas has nothing to centre")
    dx = (im.width - (bb[2] - bb[0])) // 2 - bb[0]
    dy = (im.height - (bb[3] - bb[1])) // 2 - bb[1]
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    out.paste(im.crop(bb), (bb[0] + dx, bb[1] + dy))
    # a re-centring is a pure integer TRANSLATION: the same ink, moved — so the
    # destination must carry the source pixel from (x-dx, y-dy) everywhere, and
    # no ink may fall off the canvas.
    assert out.getbbox() == (bb[0] + dx, bb[1] + dy, bb[2] + dx, bb[3] + dy), "re-centring clipped the art"
    for y in range(bb[1] + dy, bb[3] + dy):
        for x in range(bb[0] + dx, bb[2] + dx):
            assert out.getpixel((x, y)) == im.getpixel((x - dx, y - dy)), "re-centring changed a pixel"
    return out


def bake(im: Image.Image) -> Image.Image:
    out = im.resize((im.width * 2, im.height * 2), Image.NEAREST)
    # an exact 2x reproduces the source in EVERY 2x2 block — this is what
    # separates a nearest-neighbour upscale from a resample that has quietly
    # blended neighbouring art pixels.
    for y in range(im.height):
        for x in range(im.width):
            p = im.getpixel((x, y))
            for oy in (0, 1):
                for ox in (0, 1):
                    assert out.getpixel((x * 2 + ox, y * 2 + oy)) == p, "2x is not nearest-neighbour"
    return out


def main() -> int:
    write = "--write" in sys.argv
    bad = 0
    for name, how in ICONS.items():
        src = Image.open(SRC / f"icon-{name}-src.png").convert("RGBA")
        alphas = set(src.tobytes()[3::4])
        if alphas - {0, 255}:
            print(f"FAIL {name}: soft alpha in the source ({sorted(alphas - {0, 255})[:4]}…) — pixel art is binary")
            bad += 1
            continue
        art = {"none": lambda i: i, "mirror": mirror, "centre": centre}[how](src)
        out = bake(art)
        dst = OUT / f"icon-{name}.webp"
        # LOSSLESS + exact (root CLAUDE.md): VP8L is bit-exact, and `exact`
        # keeps the RGB under transparent pixels so the bake is reproducible.
        # method=4 — the games agent measured m6 to be 3.9x slower AND larger;
        # at this size every method >= 1 emits identical bytes anyway.
        tmp = dst.with_suffix(".webp.new")
        out.save(tmp, "WEBP", lossless=True, method=4, exact=True)
        fresh = tmp.read_bytes()
        back = Image.open(tmp).convert("RGBA")
        if back.tobytes() != out.tobytes():
            print(f"FAIL {name}: the WebP did not round-trip")
            tmp.unlink()
            bad += 1
            continue
        if dst.exists():
            same = dst.read_bytes() == fresh
            print(f"{'ok  ' if same else 'DIFF'} icon-{name}.webp  {how:<6} {out.width}x{out.height}  {len(fresh)} bytes")
            if not same and not write:
                print(f"     ^ the shipped file differs from this recipe — re-run with --write only if that is intended")
                bad += 1
        else:
            print(f"NEW  icon-{name}.webp  {how:<6} {out.width}x{out.height}  {len(fresh)} bytes")
            if not write:
                bad += 1
        if write:
            tmp.replace(dst)
        else:
            tmp.unlink()

    for name, (srcname, keep) in STRIPS.items():
        gif = Image.open(SRC / srcname)
        n = getattr(gif, "n_frames", 1)
        if keep > n:
            print(f"FAIL {name}: asked for {keep} frames of a {n}-frame source")
            bad += 1
            continue
        frames = []
        for i in range(keep):
            gif.seek(i)
            f = gif.convert("RGBA")
            alphas = set(f.tobytes()[3::4])
            if alphas - {0, 255}:
                print(f"FAIL {name}: soft alpha in frame {i} — pixel art is binary")
                bad += 1
                frames = []
                break
            frames.append(f)
        if not frames:
            continue
        w, h = frames[0].size
        if any(f.size != (w, h) for f in frames):
            print(f"FAIL {name}: the source frames are not all {w}x{h}")
            bad += 1
            continue
        out = Image.new("RGBA", (w * 2 * len(frames), h * 2), (0, 0, 0, 0))
        for i, f in enumerate(frames):
            out.paste(bake(f), (i * w * 2, 0))
        dst = OUT / f"{name}.webp"
        tmp = dst.with_suffix(".webp.new")
        out.save(tmp, "WEBP", lossless=True, method=4, exact=True)
        fresh = tmp.read_bytes()
        if Image.open(tmp).convert("RGBA").tobytes() != out.tobytes():
            print(f"FAIL {name}: the WebP did not round-trip")
            tmp.unlink()
            bad += 1
            continue
        if dst.exists():
            same = dst.read_bytes() == fresh
            print(f"{'ok  ' if same else 'DIFF'} {name}.webp  {len(frames)}/{n} frames  {out.width}x{out.height}  {len(fresh)} bytes")
            if not same and not write:
                print("     ^ the shipped file differs from this recipe — re-run with --write only if that is intended")
                bad += 1
        else:
            print(f"NEW  {name}.webp  {len(frames)}/{n} frames  {out.width}x{out.height}  {len(fresh)} bytes")
            if not write:
                bad += 1
        if write:
            tmp.replace(dst)
        else:
            tmp.unlink()
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
