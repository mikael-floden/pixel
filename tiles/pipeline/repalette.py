"""Move PUBLISHED review art onto a changed palette colour, without regenerating it.

Why this exists. A palette edit changes what a surface should be, and three consumers
follow it at three different speeds:

  tiles/ground_types.json   the game reads it LIVE, so the flat fill moves immediately
  tiles/tops/**/post/       tops_post.py repaints from config/palette.json on demand
  tiles/review/**_after     written by publish.py, which needs the RAW MATRIX ART

The last one is the problem: tiles/matrix is generator input and is absent from most
clones, so publish.py cannot run there - and `after` is what transition_plates.py reads
to build every base plate. Without this tool a palette change ships a game whose flat
water is the new colour and whose base-set plates are still the old one.

WHY A UNIFORM DELTA AND NOT A COLOUR SWAP. `after`'s top face is a flat fill of the
palette hex - measured 93.5% of top-face pixels are EXACTLY the old colour - and the
remaining 6.5% is the faint rim shading rim_suppress leaves behind. Swapping the exact
hex therefore fixes the field and leaves a ring of stale-coloured pixels around every
tile. Adding (new - old) to the whole face moves the shading with it and preserves the
relief bit for bit, which is the same background alignment the palette work already
relies on.

THE WALL IS ONLY MOVED WHEN IT WAS ON THE PALETTE. A cell's wall is substituted onto
the palette colour only when its measured wall_err passed the gate; the rest ship
exactly as the generator drew them (publish.py documents why: three attempts at
aligning a wall that is not really that material produced magenta, vivid and red
walls). So a wall is shifted only when its dominant colour IS the old palette wall
hex, and left untouched otherwise - never inferred.

Verified by EQUIVALENCE, not by inspection: --check re-runs the transform with delta
zero over a ground whose palette did not change and requires every file to come back
byte-identical. A transform that cannot leave unchanged art alone is not trusted to
touch changed art.

    python3 tiles/pipeline/repalette.py --check                    # prove it is a no-op
    python3 tiles/pipeline/repalette.py --grounds water light_beach --old-json OLD.json
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
from PIL import Image

import palette_snap as PS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
MANIFEST = os.path.join(ROOT, "review", "manifest.json")
PALETTE = os.path.join(ROOT, "config", "palette.json")


def _rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], float)


def shift_file(path, top_delta, wall_old, wall_delta, apply=True):
    """(changed?, n_top_px, n_wall_px). Alpha is never touched."""
    im = Image.open(path).convert("RGBA")
    a = np.array(im, int)
    reg = PS._regions(a.astype(float))
    if reg is None or not reg["top"].any():
        return False, 0, 0
    top = reg["top"]
    opaque = a[..., 3] > 0
    wall = opaque & ~top
    out = a.astype(float)
    out[..., :3][top] = np.clip(out[..., :3][top] + top_delta, 0, 255)
    n_wall = 0
    if wall.any() and wall_old is not None and wall_delta is not None:
        px = a[..., :3][wall]
        cols, cnt = np.unique(px.reshape(-1, 3), axis=0, return_counts=True)
        # only a wall that IS the old palette colour was ever aligned to the palette
        if np.abs(cols[cnt.argmax()] - wall_old).max() == 0:
            out[..., :3][wall] = np.clip(out[..., :3][wall] + wall_delta, 0, 255)
            n_wall = int(wall.sum())
    res = a.copy()
    res[..., :3] = np.clip(np.rint(out[..., :3]), 0, 255).astype(int)
    if not np.array_equal(res, a) and apply:
        Image.fromarray(res.astype(np.uint8), "RGBA").save(
            path, "WEBP", lossless=True, exact=True)
    return (not np.array_equal(res, a)), int(top.sum()), n_wall


def run(grounds, old_palette, apply=True, verbose=True):
    live = json.load(open(PALETTE))["types"]
    man = json.load(open(MANIFEST))
    total = changed = 0
    for g in grounds:
        old = old_palette.get(g) or {}
        new = live.get(g) or {}
        if not old.get("top") or not new.get("top"):
            print(f"  {g}: no top colour on one side, skipped")
            continue
        td = _rgb(new["top"]) - _rgb(old["top"])
        wo = _rgb(old["wall"]) if old.get("wall") else None
        wd = (_rgb(new["wall"]) - _rgb(old["wall"])) if (old.get("wall") and new.get("wall")) else None
        files = []
        for cell, c in man["cells"].items():
            if c["top"] != g:
                continue
            for e in c["candidates"]:
                p = e.get("after")
                if p and os.path.isfile(os.path.join(REPO, p)):
                    files.append(os.path.join(REPO, p))
        n = 0
        for p in files:
            ch, _, _ = shift_file(p, td, wo, wd, apply=apply)
            n += ch
        total += len(files)
        changed += n
        if verbose:
            print(f"  {g:14s} {old['top']} -> {new['top']}  delta {td.astype(int)}  "
                  f"| {n}/{len(files)} after-tiles moved")
    return total, changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grounds", nargs="*", default=[])
    ap.add_argument("--old-json", help="JSON of the PREVIOUS palette `types` block")
    ap.add_argument("--check", action="store_true",
                    help="equivalence test: zero delta must leave every file byte-identical")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    live = json.load(open(PALETTE))["types"]
    if a.check:
        # A zero delta over grounds whose palette did not change must be a no-op.
        gs = a.grounds or ["grass", "black_rock", "grey_stone"]
        total, changed = run(gs, {g: live[g] for g in gs if g in live}, apply=False)
        print(f"\nEQUIVALENCE: {total} files, {changed} would change (must be 0)")
        raise SystemExit(0 if changed == 0 else 1)

    old = json.load(open(a.old_json)) if a.old_json else {}
    total, changed = run(a.grounds, old, apply=not a.dry_run)
    print(f"\n{changed} of {total} after-tiles moved onto the new palette"
          + (" (dry run)" if a.dry_run else ""))


if __name__ == "__main__":
    main()
