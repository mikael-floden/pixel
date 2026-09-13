#!/usr/bin/env python3
"""Bake the select screen's + game view's CORNER ICONS from the maintainer's
own PixelLab exports.

Sources: client/ui-src/icon-<name>-src.png — the UNTOUCHED export is the pixel
source of record (his reposted images accumulate JPEG artifacts, so the first
upload is what we keep). Each is 24x24 with binary alpha. The bake is an EXACT
2x nearest-neighbour upscale to client/public/ui2/icon-<name>.webp, which the
runtime then sizes to naturalWidth/2 — that lands every icon on its authored
grid at any screen density, and it is ONE rule shared with the tab icons
rather than a hardcoded box per icon (UI_AGENT.md).

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
ICONS = {"wiki": "none", "theme": "centre", "search": "mirror", "install": "none"}


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
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
