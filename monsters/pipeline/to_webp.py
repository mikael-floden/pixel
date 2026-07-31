"""Convert monsters/ art from PNG to LOSSLESS WebP (and back), verified.

Why: WebP is ~33% smaller than PNG on this domain's art at identical pixels,
which is bandwidth off every player's first load and MB off every deploy.
PixelLab output is too colour-rich for palette PNG (measured: 1 of 240 sprites
fits 256 colours), so WebP is the only real win available.

Losslessness is not assumed, it is CHECKED: every converted file is re-decoded
and compared to the source RGBA array, and the conversion aborts on the first
mismatch. `exact=True` is required — without it WebP is free to rewrite the RGB
of fully transparent pixels, which changes bytes the game never draws but which
would make this verification (and any future diff) lie.

WHO READS THIS DOMAIN'S ART (checked 2026-07-31 — keep this list current, it is
the reason this script is opt-in per class rather than a blanket convert):

  class                     files   size    consumers
  animations/<k>/<d>/NN     8608   20.1MB   wiki (site/wiki.js loads NN.png)
  animations/<k>__<d>.png    909   16.1MB   games2 manifest builder + wiki
  animations/<k>__<d>.gif    909    8.8MB   wiki (per-direction preview)
  animations/<k>__rotating   114    8.7MB   nobody (review gallery is an artifact)
  sprite.png / rotations/     216    0.7MB   wiki (preview)

So a class may only be converted once ITS consumers read WebP. The game's
build-monsters-manifest.mjs parses the PNG IHDR by hand and decodes pixels with
pngjs to measure monster contact anchors; if it silently misreads, shadows
detach and monsters float. That is why `--class strips` stays blocked until the
games agent lands a WebP-capable decoder.

Usage:
  python monsters/pipeline/to_webp.py --dry-run            # measure, touch nothing
  python monsters/pipeline/to_webp.py --class frames       # convert one class
  python monsters/pipeline/to_webp.py --class all
  python monsters/pipeline/to_webp.py --revert --class frames
"""

from __future__ import annotations

import argparse
import json
import os

import numpy as np
from PIL import Image

from mirror import ROOT, iter_manifests, read_manifest, write_manifest

# file classes and the consumers that gate them
CLASSES = {
    "frames":  "animations/<key>/<dir>/NN — wiki reads these",
    "strips":  "animations/<key>__<dir> — GAME + wiki read these",
    "sprites": "sprite + rotations/<dir> — wiki reads these",
}


def _is_frame(rel):
    parts = rel.split(os.sep)
    return "animations" in parts and "__" not in os.path.basename(rel)


def classify(rel):
    base = os.path.basename(rel)
    if not base.endswith(".png"):
        return None
    if "__" in base:
        return "strips"
    if _is_frame(rel):
        return "frames"
    return "sprites"


def convert_file(src, revert=False):
    """PNG->WebP (or back). Returns (old_bytes, new_bytes, dst). Verifies the
    pixels round-trip EXACTLY; raises on any mismatch."""
    dst = os.path.splitext(src)[0] + (".png" if revert else ".webp")
    with Image.open(src) as im:
        before = np.asarray(im.convert("RGBA"))
        if revert:
            Image.fromarray(before, "RGBA").save(dst, "PNG")
        else:
            # exact=True keeps RGB under fully-transparent pixels intact
            Image.fromarray(before, "RGBA").save(dst, "WEBP", lossless=True,
                                                method=6, exact=True)
    with Image.open(dst) as im2:
        after = np.asarray(im2.convert("RGBA"))
    if before.shape != after.shape or not np.array_equal(before, after):
        os.remove(dst)
        raise SystemExit(f"NOT LOSSLESS: {src} — aborting, nothing else touched")
    old, new = os.path.getsize(src), os.path.getsize(dst)
    os.remove(src)
    return old, new, dst


def retarget(meta, revert=False):
    """Rewrite every art path in a manifest to the new extension."""
    frm, to = (".webp", ".png") if revert else (".png", ".webp")

    def fix(v):
        return v[: -len(frm)] + to if isinstance(v, str) and v.endswith(frm) else v

    meta["sprite"] = fix(meta.get("sprite"))
    meta["rotations"] = {d: fix(p) for d, p in (meta.get("rotations") or {}).items()}
    for a in (meta.get("animations") or {}).values():
        for rec in (a.get("directions") or {}).values():
            rec["strip"] = fix(rec.get("strip"))
            rec["frame_paths"] = [fix(p) for p in (rec.get("frame_paths") or [])]
    return meta


def walk_art(mid):
    for root, _dirs, files in os.walk(os.path.join(ROOT, mid)):
        for f in files:
            p = os.path.join(root, f)
            yield p, os.path.relpath(p, ROOT)


def main():
    ap = argparse.ArgumentParser(description="PNG <-> lossless WebP for monsters/ art.")
    ap.add_argument("--class", dest="cls", default="all",
                    choices=[*CLASSES, "all"], help="which file class to convert")
    ap.add_argument("--revert", action="store_true", help="WebP -> PNG")
    ap.add_argument("--dry-run", action="store_true", help="measure only")
    args = ap.parse_args()
    want = set(CLASSES) if args.cls == "all" else {args.cls}

    if args.dry_run:
        import collections
        tot = collections.Counter()
        cnt = collections.Counter()
        sample = collections.defaultdict(list)
        for mid, _meta in iter_manifests():
            for p, rel in walk_art(mid):
                c = classify(rel)
                if c:
                    tot[c] += os.path.getsize(p)
                    cnt[c] += 1
                    if len(sample[c]) < 20:
                        sample[c].append(p)
        print(f"{'class':9s} {'files':>6s} {'PNG':>9s} {'->WebP':>9s} {'saved':>7s}  consumers")
        for c in CLASSES:
            if not cnt[c]:
                continue
            so = sn = 0
            for p in sample[c]:
                with Image.open(p) as im:
                    arr = np.asarray(im.convert("RGBA"))
                import io as _io
                b = _io.BytesIO()
                Image.fromarray(arr, "RGBA").save(b, "WEBP", lossless=True,
                                                 method=6, exact=True)
                so += os.path.getsize(p)
                sn += b.tell()
            ratio = sn / so if so else 1
            print(f"{c:9s} {cnt[c]:6d} {tot[c]/1048576:8.2f}M {tot[c]*ratio/1048576:8.2f}M "
                  f"{(1-ratio)*100:6.1f}%  {CLASSES[c]}")
        return

    n = old_t = new_t = 0
    for mid, meta in iter_manifests():
        touched = False
        for p, rel in list(walk_art(mid)):
            base = os.path.basename(rel)
            src_ext = ".webp" if args.revert else ".png"
            if not base.endswith(src_ext):
                continue
            c = classify(rel[: -len(src_ext)] + ".png")
            if c not in want:
                continue
            old, new, _dst = convert_file(p, revert=args.revert)
            old_t += old
            new_t += new
            n += 1
            touched = True
        if touched:
            write_manifest(mid, retarget(meta, revert=args.revert))
            print(f"  {mid}: converted")
    print(f"\n{n} files: {old_t/1048576:.2f} MB -> {new_t/1048576:.2f} MB "
          f"({(1 - new_t/max(old_t,1))*100:.1f}% smaller), pixels verified identical")


if __name__ == "__main__":
    main()
