#!/usr/bin/env python3
"""Convert pixel art from PNG to LOSSLESS WebP, proving each file bit-exact.

The fleet is moving to WebP (2026-07-31: ~50% off 128 MB of art, ~6.5 MB off
every cold load, nothing got bigger). This is the wiki's converter, used for
its own icons. Other agents are welcome to COPY it into their domain and run
it over their art — do not import it across domains, per coordination/
PROTOCOL.md, and do not make it a Dockerfile step: convert once at the source,
commit the result, and every deploy afterwards moves less through the layers.

    python3 wiki/tools/to-webp.py <path>...        # dry run, prints the ledger
    python3 wiki/tools/to-webp.py --write <path>...  # convert and delete the PNG
    python3 wiki/tools/to-webp.py --write --keep <path>...  # keep the PNG too

What makes it safe to run over thousands of files:

- **Every pixel is compared.** The WebP is decoded back and checked against the
  source RGBA, pixel for pixel. A file that differs anywhere is not written and
  the run exits non-zero. "Lossless" is a claim; this is the proof.
- **Fully transparent pixels count.** Two pixels that both render as nothing can
  still carry different RGB, and some encoders normalise them. For pixel art
  that difference is invisible today and a diff nightmare later, so it is
  treated as a failure like any other.
- **A file that would grow is skipped**, not written. Rare for sprites, common
  for tiny 1-bit images.
"""
import io
import os
import sys

from PIL import Image

WRITE = "--write" in sys.argv
KEEP = "--keep" in sys.argv
PATHS = [a for a in sys.argv[1:] if not a.startswith("-")]
if not PATHS:
    print(__doc__)
    sys.exit(2)


def pngs(paths):
    for p in paths:
        if os.path.isdir(p):
            for root, _, files in os.walk(p):
                for n in sorted(files):
                    if n.lower().endswith(".png"):
                        yield os.path.join(root, n)
        elif p.lower().endswith(".png"):
            yield p


def convert(path: str):
    """(webp bytes, source size, webp size) or (None, reason) on refusal."""
    src = Image.open(path).convert("RGBA")
    buf = io.BytesIO()
    # method=6 is the slowest/smallest setting; at ~10 ms a sprite the time is
    # irrelevant next to shipping the bytes to every player, forever.
    src.save(buf, "WEBP", lossless=True, quality=100, method=6)
    data = buf.getvalue()
    back = Image.open(io.BytesIO(data)).convert("RGBA")
    if back.size != src.size:
        return None, f"size changed {src.size} → {back.size}"
    if back.tobytes() != src.tobytes():
        return None, "pixels differ"
    return data, None


fails, wrote, skipped, before, after = [], 0, 0, 0, 0
for path in pngs(PATHS):
    png = os.path.getsize(path)
    try:
        data, why = convert(path)
    except Exception as e:                       # noqa: BLE001 — report, don't crash the batch
        fails.append((path, f"{type(e).__name__}: {e}"))
        continue
    if data is None:
        fails.append((path, why))
        continue
    web = len(data)
    rel = os.path.relpath(path)
    if web >= png:
        skipped += 1
        print(f"  skip  {rel}: WebP is bigger ({web} ≥ {png})")
        continue
    before += png
    after += web
    wrote += 1
    print(f"  {'conv' if WRITE else 'would'}  {rel}: {png} → {web} ({(web - png) / png * 100:+.0f}%)")
    if WRITE:
        with open(os.path.splitext(path)[0] + ".webp", "wb") as f:
            f.write(data)
        if not KEEP:
            os.remove(path)

n = wrote + skipped + len(fails)
print(f"\n{n} PNGs: {wrote} {'converted' if WRITE else 'convertible'}, {skipped} skipped (bigger), {len(fails)} FAILED")
if before:
    print(f"  {before / 1024:.1f} KB → {after / 1024:.1f} KB ({(after - before) / before * 100:+.0f}%), every pixel verified identical")
if not WRITE and wrote:
    print("  dry run — pass --write to apply")
for path, why in fails:
    print(f"  FAILED {os.path.relpath(path)}: {why}", file=sys.stderr)
sys.exit(1 if fails else 0)
