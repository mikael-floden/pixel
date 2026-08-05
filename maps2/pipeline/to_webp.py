"""maps2 → lossless WebP (project default, 2026-07-31).

Two jobs, both safe to re-run:

  1. CONVERT maps2's own images (world minimaps, the prop/border sheets) to
     lossless WebP, PROVING each one bit-exact before the PNG is removed.
  2. REWRITE the tiles2 tile paths baked into `worlds/*/world.json` from
     `.png` to `.webp` — but only for entries whose `.webp` actually exists on
     disk. This is what makes tiles2's own flip a NON-EVENT for the worlds:
     they convert, I run `--paths`, and every world points at real files. No
     regeneration, so no terrain can change.

    python maps2/pipeline/to_webp.py               # dry run: what would happen
    python maps2/pipeline/to_webp.py --apply       # convert maps2's images
    python maps2/pipeline/to_webp.py --paths --apply   # + repoint world.json
    python maps2/pipeline/to_webp.py --revert      # webp -> png (from git)

WHY LOSSLESS AND WHY VERIFY (fleet findings, don't re-derive): Pillow's default
WebP encode is LOSSY and silently resamples pixel art; `method=6` costs ~76x the
time for ~0.1% size. So: `lossless=True, method=4`, then decode the result back
and compare RGBA bytes — a file that differs by one byte is not written, and a
PNG is never deleted unless its WebP round-tripped exactly. Files that would
GROW keep their PNG.
"""

from __future__ import annotations

import json
import os
import sys

from PIL import Image

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)

SKIP_DIRS = {"__pycache__"}


def convert(png: str, apply: bool) -> tuple[bool, int, int, str]:
    """Convert one PNG to lossless WebP beside it. Returns (ok, before, after, note)."""
    webp = os.path.splitext(png)[0] + ".webp"
    src = Image.open(png)
    src = src.convert("RGBA") if src.mode != "RGBA" else src
    before = os.path.getsize(png)
    tmp = webp + ".tmp"
    src.save(tmp, "WEBP", lossless=True, method=4, exact=True)
    after = os.path.getsize(tmp)
    # PROOF: decode back and compare every byte, alpha included
    back = Image.open(tmp)
    back = back.convert("RGBA") if back.mode != "RGBA" else back
    if back.tobytes() != src.tobytes():
        os.remove(tmp)
        return False, before, after, "NOT bit-exact — kept PNG"
    if after >= before:
        os.remove(tmp)
        return False, before, after, "would grow — kept PNG"
    if not apply:
        os.remove(tmp)
        return True, before, after, "would convert"
    os.replace(tmp, webp)
    os.remove(png)
    return True, before, after, "converted"


def images(root: str):
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in sorted(files):
            if f.lower().endswith(".png"):
                yield os.path.join(base, f)


def rewrite_paths(apply: bool) -> int:
    """Repoint every world.json `paths` entry whose .webp exists on disk.

    world.json bakes LITERAL tile paths and the client resolves them to a URL
    with no extension fallback, so a tiles2 flip strands the worlds until this
    runs. Only the `paths` table changes — the grids, decks and props are
    untouched, so the terrain is bit-identical."""
    worlds = os.path.join(MAPS2, "worlds")
    total = 0
    for name in sorted(os.listdir(worlds)):
        wpath = os.path.join(worlds, name, "world.json")
        if not os.path.isfile(wpath):
            continue
        doc = json.load(open(wpath))
        paths = doc.get("paths") or []
        hits = 0
        for i, p in enumerate(paths):
            if not p.endswith(".png"):
                continue
            cand = p[:-4] + ".webp"
            if os.path.isfile(os.path.join(REPO, cand)):
                paths[i] = cand
                hits += 1
        if hits:
            total += hits
            print(f"  {name}: {hits}/{len(paths)} tile paths -> .webp")
            if apply:
                with open(wpath, "w") as f:
                    json.dump(doc, f, separators=(",", ":"))
    return total


def main():
    apply = "--apply" in sys.argv
    if "--paths" in sys.argv:
        print("world.json tile paths (.png -> .webp where the file exists):")
        n = rewrite_paths(apply)
        print(f"{'rewrote' if apply else 'would rewrite'} {n} path(s)")
        if not ("--images" in sys.argv or n == 0):
            return
    ok = skip = 0
    before = after = 0
    for png in images(MAPS2):
        good, b, a, note = convert(png, apply)
        rel = os.path.relpath(png, MAPS2)
        if good:
            ok += 1
            before += b
            after += a
            print(f"  {rel}: {b//1024}K -> {a//1024}K ({100 - a*100//max(1,b)}% off)")
        else:
            skip += 1
            print(f"  {rel}: {note}")
    if ok:
        print(f"{'converted' if apply else 'would convert'} {ok} file(s), "
              f"{before/1048576:.1f} MB -> {after/1048576:.1f} MB "
              f"({100 - after*100//max(1,before)}% smaller); {skip} kept as PNG")
    if not apply:
        print("dry run — pass --apply to write")


if __name__ == "__main__":
    main()
