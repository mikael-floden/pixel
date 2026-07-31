#!/usr/bin/env python3
"""Convert PNG art to LOSSLESS WebP — the project default since 2026-07-31.

Written by the games-ui agent for its own assets, then shared: every art
domain needs exactly this, and it is easier to hand over a verified script
than to have five agents each rediscover `exact=True`.

WHY WEBP. VP8L is mathematically lossless — bit-exact, not "visually
lossless" — and on this project's art it lands at 32-76% of the PNG.
Measured on 240 random sprites, not one file got bigger. Palette PNG (PNG-8)
was tried first because it needs no pipeline changes: useless here, only 1 of
those 240 sprites has <=256 colours.

TWO TRAPS, both handled below:
  * `lossless=True` is NOT the default. Without it you silently get lossy
    VP8 and ringing artifacts around every hard pixel-art edge.
  * `exact=True` is NOT the default either. libwebp otherwise rewrites the
    RGB *underneath* fully-transparent pixels to whatever compresses best.
    Invisible in a browser, but it breaks byte-identity — and any offline
    tool that reads those pixels sees different numbers.

CONVERT AT THE SOURCE. Run this once over a tree, commit the WebP, and point
the generator at WebP for new art. Do NOT put conversion in the Dockerfile:
that adds minutes to every deploy and busts the layer cache, which is the
opposite of the point.

BEFORE YOU CONVERT A SPRITE TREE, check what still reads the PNGs offline.
games2's own manifest builders parse the PNG IHDR by hand and decode pixels
with pngjs (build-manifest.mjs, build-monsters-manifest.mjs) — neither reads
WebP, and they measure the foot plants, shoulder waterlines and monster
contact anchors the game renders with. Silently wrong numbers there mean
detached shadows and floating characters, not a crash.

    python3 scripts/to-webp.py <path>...        # dry run, prints the tally
    python3 scripts/to-webp.py --write <path>...  # convert, keep the PNGs
    python3 scripts/to-webp.py --write --replace <path>...  # …and delete them

Every write is verified by decoding the WebP back and comparing RGBA arrays
against the source. A file that does not round-trip exactly is left alone and
reported; a file WebP makes bigger is skipped (none so far).
"""

import argparse
import os
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:
    sys.exit("needs pillow + numpy:  pip install pillow numpy")


def convert(png: Path, write: bool, replace: bool):
    """-> (before, after, status). Never writes a file that isn't identical."""
    src = Image.open(png).convert("RGBA")
    before = png.stat().st_size
    out = png.with_suffix(".webp")
    src.save(out, "WEBP", lossless=True, method=6, exact=True)
    after = out.stat().st_size
    if not np.array_equal(np.array(Image.open(out).convert("RGBA")), np.array(src)):
        out.unlink()
        return before, before, "NOT-LOSSLESS"
    if after >= before:
        out.unlink()
        return before, before, "bigger-skipped"
    if not write:
        out.unlink()
        return before, after, "would-convert"
    if replace:
        png.unlink()
    return before, after, "converted"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+", help="files or directories to walk")
    ap.add_argument("--write", action="store_true", help="actually write the .webp")
    ap.add_argument("--replace", action="store_true", help="delete the .png after a verified write")
    a = ap.parse_args()

    files = []
    for p in map(Path, a.paths):
        files.extend(sorted(p.rglob("*.png")) if p.is_dir() else [p])
    if not files:
        sys.exit("no .png found")

    before = after = 0
    tally = {}
    for f in files:
        b, x, st = convert(f, a.write, a.replace)
        before += b
        after += x
        tally[st] = tally.get(st, 0) + 1
        if st == "NOT-LOSSLESS":
            print(f"  !! {f} did not round-trip — left as PNG")

    pct = 100 * after / before if before else 100
    print(f"{len(files)} files: {before/1048576:.2f} MB -> {after/1048576:.2f} MB ({pct:.1f}%)")
    print("  " + ", ".join(f"{k}: {v}" for k, v in sorted(tally.items())))
    if not a.write:
        print("  (dry run — pass --write to keep the .webp, --replace to drop the .png)")


if __name__ == "__main__":
    main()
