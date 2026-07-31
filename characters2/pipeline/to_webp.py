"""Convert characters2 art PNG -> lossless WebP (and verify it is truly lossless).

WHY: WebP lossless is ~30% smaller than PNG on this art with byte-identical
pixels, which shrinks both the deploy image and every player's first load.

SAFETY: pixel art must survive EXACTLY — nearest-neighbour rendering makes any
lossy resampling instantly visible. So every file is re-decoded after encoding
and compared pixel-for-pixel (RGBA, including the alpha channel); a file that
does not round-trip is left as PNG and reported. Nothing is deleted unless its
replacement verified.

  python characters2/pipeline/to_webp.py                 # dry run: measure + verify
  python characters2/pipeline/to_webp.py --apply         # convert (git rm the PNGs)
  python characters2/pipeline/to_webp.py --revert        # WebP -> PNG (undo)

Read the CONSUMER note in characters2/README.md before --apply: the game's
build-manifest.mjs decodes these frames and must be WebP-capable first.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # characters2/
HUMANS = os.path.join(ROOT, "humans")


def _same_pixels(a_path, b_path):
    """True when two images decode to identical RGBA pixels (and size)."""
    with Image.open(a_path) as a, Image.open(b_path) as b:
        a = a.convert("RGBA")
        b = b.convert("RGBA")
        return a.size == b.size and a.tobytes() == b.tobytes()


def convert_one(png_path, apply=False):
    """Encode one PNG as lossless WebP. Returns (old_bytes, new_bytes, ok)."""
    webp_path = png_path[:-4] + ".webp"
    old = os.path.getsize(png_path)
    with Image.open(png_path) as im:
        # method=4 (Pillow's default) is the sweet spot on this art: measured over
        # 120 sprites it matches method=6's size to within 0.1% while being ~76x
        # faster (1.3ms vs 99.5ms per file). Don't "optimize" this to 6.
        im.convert("RGBA").save(webp_path, "WEBP", lossless=True, quality=100, method=4)
    ok = _same_pixels(png_path, webp_path)
    new = os.path.getsize(webp_path)
    if not ok or not apply:
        os.remove(webp_path)          # dry run (or a failure) leaves the tree untouched
    return old, new, ok


def _git_rm(paths):
    """Remove the superseded PNGs, staging the deletion in git when the file is
    actually tracked. Falls back to a plain unlink for anything git doesn't own
    (a scratch/shadow copy outside the repo — used to rehearse a conversion),
    so this tool works on any tree."""
    repo = os.path.dirname(ROOT)
    for i in range(0, len(paths), 400):                     # keep argv small
        batch = paths[i:i + 400]
        rc = subprocess.run(["git", "rm", "-q", "--"] + batch,
                            cwd=repo, capture_output=True).returncode
        if rc != 0:                                          # untracked / not a repo
            for p in batch:
                if os.path.exists(p):
                    os.remove(p)


def walk_pngs(base):
    for root, _dirs, files in os.walk(base):
        for fn in sorted(files):
            if fn.endswith(".png"):
                yield os.path.join(root, fn)


def main():
    ap = argparse.ArgumentParser(description="characters2 PNG -> lossless WebP")
    ap.add_argument("--apply", action="store_true", help="actually write .webp and git rm the .png")
    ap.add_argument("--revert", action="store_true", help="convert .webp back to .png")
    ap.add_argument("--path", default=HUMANS, help="subtree to convert (default: humans/)")
    args = ap.parse_args()

    if args.revert:
        n = 0
        for root, _d, files in os.walk(args.path):
            for fn in sorted(files):
                if not fn.endswith(".webp"):
                    continue
                wp = os.path.join(root, fn)
                pp = wp[:-5] + ".png"
                with Image.open(wp) as im:
                    im.convert("RGBA").save(pp, "PNG", optimize=True)
                if _same_pixels(wp, pp):
                    _git_rm([wp]); n += 1
                else:
                    os.remove(pp); print(f"  ! {wp}: revert did not round-trip")
        print(f"reverted {n} files to PNG")
        return

    pngs = list(walk_pngs(args.path))
    if not pngs:
        print(f"no PNGs under {args.path}")
        return

    tot_old = tot_new = 0
    bad, bigger, done = [], [], []
    for p in pngs:
        old, new, ok = convert_one(p, apply=args.apply)
        tot_old += old
        tot_new += new
        if not ok:
            bad.append(p)
            continue
        if new >= old:
            bigger.append((p, old, new))
        done.append(p)

    saved = tot_old - tot_new
    pct = (saved / tot_old * 100) if tot_old else 0
    print(f"{len(pngs)} PNG files")
    print(f"  PNG   {tot_old/1024/1024:8.2f} MiB")
    print(f"  WebP  {tot_new/1024/1024:8.2f} MiB   ({pct:.1f}% smaller, {saved/1024/1024:.2f} MiB saved)")
    print(f"  lossless verified: {len(pngs) - len(bad)}/{len(pngs)}"
          + (f"   FAILED: {len(bad)}" if bad else ""))
    for p in bad[:10]:
        print(f"    ! not pixel-identical, kept as PNG: {os.path.relpath(p, ROOT)}")
    if bigger:
        print(f"  {len(bigger)} file(s) got BIGGER as WebP (kept anyway for format uniformity):")
        for p, o, n in bigger[:5]:
            print(f"    {os.path.relpath(p, ROOT)}: {o} -> {n}")

    if args.apply:
        if bad:
            print("\nrefusing to delete PNGs while any file failed verification")
            sys.exit(1)
        _git_rm(done)
        print(f"\nconverted {len(done)} files; PNGs removed (staged in git)")
    else:
        print("\ndry run — nothing written. Re-run with --apply to convert.")


if __name__ == "__main__":
    main()
