"""Convert tiles2 raw/ sheets from PNG to LOSSLESS WebP (smaller deploy image, same art).

Why only raw/
-------------
`games2/Dockerfile` does `COPY tiles2/ /assets/tiles2/`, so raw/ (4372 files, 22.7 MB)
ships in every deploy image even though **nothing outside tiles2 reads it** — it is
purely the input to our own postprocess. Converting it is therefore invisible to the
game and needs no coordination.

The processed tiles under base/ base_x_N/ transitions/ are NOT converted here: maps2's
`worlds/*/world.json` bakes their exact `.../tile_03.png` paths, and games2's
`build-manifest.mjs` parses the PNG IHDR by hand. Those must move first; when they do,
`--processed` flips them too and `common.processed_name` is the one place to update.

Why lossless is non-negotiable
------------------------------
Measured on this tileset: lossless changes 0% of visible pixels, while cwebp's DEFAULT
(lossy q=75) changes 99.6% of them, shifts channels by up to 86, and inflates a tile
from ~819 to ~1375 colours — compression ringing smeared through flat pixel art. Any
"~76% saving" figure for tiles2 is a lossy measurement. Lossless is ~24-30% here.
This script never emits lossy output.

Safety
------
WebP lossless is exact for every visible pixel AND the whole alpha channel; it only
zeroes RGB underneath fully-transparent (alpha==0) pixels, which nothing renders and
which our pipeline never reads (every step masks on alpha>16). Each file is verified
on that basis and the PNG is removed only after its WebP passes.

  python tiles2/pipeline/towebp.py --dry-run
  python tiles2/pipeline/towebp.py            # convert raw/
"""

from __future__ import annotations

import argparse
import glob
import os

import numpy as np
from PIL import Image

import common

SAVE = {"lossless": True, "method": 6, "quality": 100}


def _verify(src_im, dst_path):
    """WebP must reproduce the alpha channel exactly and every VISIBLE pixel exactly."""
    a = np.asarray(src_im)
    b = np.asarray(Image.open(dst_path).convert("RGBA"))
    if a.shape != b.shape or not np.array_equal(a[:, :, 3], b[:, :, 3]):
        return False
    vis = a[:, :, 3] > 0
    return bool(np.array_equal(a[vis][:, :3], b[vis][:, :3]))


def convert(path, dry=False):
    """PNG -> lossless WebP. Returns (png_bytes, webp_bytes) or None if skipped/failed."""
    dst = os.path.splitext(path)[0] + ".webp"
    before = os.path.getsize(path)
    if dry:
        return before, None
    im = Image.open(path).convert("RGBA")
    im.save(dst, "WEBP", **SAVE)
    if not _verify(im, dst):
        os.remove(dst)
        print(f"  ! VERIFY FAILED, kept PNG: {path}")
        return None
    after = os.path.getsize(dst)
    os.remove(path)
    return before, after


def targets(processed=False):
    if processed:
        return [f for f in glob.glob(os.path.join(common.ROOT, "*", "**", "*.png"), recursive=True)
                if os.sep + "raw" + os.sep not in f]
    return sorted(glob.glob(os.path.join(common.ROOT, "*", "raw", "*", "tile_*.png")))


def main():
    ap = argparse.ArgumentParser(description="Convert tiles2 tiles to lossless WebP.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--processed", action="store_true",
                    help="ALSO convert game-facing tiles — only after maps2 world.json and "
                         "games2 build-manifest.mjs read WebP, or the game breaks")
    args = ap.parse_args()

    files = targets(args.processed)
    print(f"{len(files)} PNG(s) to convert" + (" [dry-run]" if args.dry_run else ""))
    if args.processed and not args.dry_run:
        print("  !! processed tiles are referenced by path in maps2 worlds/*/world.json")

    po = wo = n = 0
    for f in files:
        r = convert(f, dry=args.dry_run)
        if not r:
            continue
        po += r[0]
        wo += r[1] or 0
        n += 1
    if args.dry_run:
        print(f"would convert {n} file(s), {po / 1e6:.1f} MB of PNG")
    else:
        print(f"converted {n} file(s): {po / 1e6:.1f} MB -> {wo / 1e6:.1f} MB "
              f"(saved {(po - wo) / 1e6:.1f} MB, {100 * (1 - wo / po):.1f}%)")


if __name__ == "__main__":
    main()
