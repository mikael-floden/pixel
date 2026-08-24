"""Write the POSTPROCESSED pass for every transition set, as `<set>/post/tile_NN.webp`.

Why this exists
---------------
The wiki's Transitions tab has an After/Textured/Before switch like every other tab,
and After silently rendered the raw art because there was nothing else to render:

    "0 of 284 sets have a post/ pass - so there is no 'After' for transitions to
     render. Not a rendering bug; the upstream pass doesn't exist."   - the wiki agent

That is this domain's side of the contract. The tiles themselves have shipped a
postprocessed pass since the review set existed; the transition sets never did, so a
whole tab of the wiki has been showing the maintainer generator output while claiming
to show what ships.

What the pass is
----------------
transition_render.compose_transition() run over each set with the surface taxonomy the
maintainer defined, read from palette.json's `transition_surface`:

    own    keep the generated art, correct only hue and saturation to the palette
    base   copy the material's base tile in, so the transition mimics the field
    flat   base, with the clean-topped base tile

`own` needs no base image. `base` and `flat` take one from ground_types.json when it
declares one, and otherwise from the material's own X-over-X published tile - which is
exactly "the published wall texture below a clean top", because that is what the
publish pipeline now writes for every tile.

The output sits beside the raw tiles rather than replacing them: the wiki's Before
switch still needs the generator's own output, and a postprocess that overwrites its
input cannot be re-run with a changed rule.
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

import transition_render as TR

# The transition tile's own size - every set is drawn at exactly this.
TILE_W, TILE_H = 64, 46

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
TRANS = os.path.join(ROOT, "transitions")
PALETTE = json.load(open(os.path.join(ROOT, "config", "palette.json")))["types"]

try:
    _GT = json.load(open(os.path.join(ROOT, "ground_types.json")))
    _GT = _GT.get("grounds") or _GT
except Exception:
    _GT = {}


def _crop_to_art(img):
    """Crop a tile to its own alpha bbox.

    A published review tile is 64x64 with the art sitting 9 rows down; a transition
    tile is 64x46 and IS the art. Both hold the same 64x46 drawing, so cropping to the
    bbox lines them up exactly - no resampling, which would blur a pixel-art base and
    move every edge the boundary depends on.
    """
    a = np.array(img.convert("RGBA"), int)
    ys, xs = np.where(a[..., 3] > 0)
    if not len(ys):
        return img
    # A FIXED WINDOW ANCHORED AT THE ART'S TOP, not the bbox. Cropping to the bbox gives
    # a different height per material - a tile whose lowest row happens to be empty
    # comes out 45 rows instead of 46 - and the composer indexes base and tile with one
    # mask, so a single row of disagreement is an IndexError. The window is the tile
    # geometry itself, so every material lands the same size. PIL pads outside the
    # canvas with transparent, which is correct for the row a short tile is missing.
    return img.crop((0, int(ys.min()), TILE_W, int(ys.min()) + TILE_H))


def _base_image(material):
    """The tile a `base`/`flat` material copies from, or None if it has none."""
    declared = (_GT.get(material) or {}).get("base_tiles") or []
    for rel in declared:
        p = os.path.join(REPO, rel)
        if os.path.isfile(p):
            return _crop_to_art(Image.open(p).convert("RGBA"))
    # X-over-X is the material standing on itself: its own wall, its own clean top.
    p = os.path.join(ROOT, "review", f"{material}__over__{material}", "0_after.webp")
    if os.path.isfile(p):
        return _crop_to_art(Image.open(p).convert("RGBA"))
    return None


def side_spec(material, cache):
    if material not in cache:
        v = PALETTE.get(material) or {}
        mode = v.get("transition_surface") or "own"
        base = None if mode == "own" else _base_image(material)
        if mode != "own" and base is None:
            # No base to copy: fall back to correcting the art in place rather than
            # writing nothing. Reported, because it means the material is missing the
            # X-over-X tile the taxonomy assumes it has.
            print(f"   ! {material}: mode '{mode}' but no base tile found - using 'own'")
            mode = "own"
        cache[material] = {"mode": mode, "hex": v.get("top"), "base": base}
    return cache[material]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pair", default=None, help="only this pair directory")
    ap.add_argument("--force", action="store_true", help="rewrite sets that already have post/")
    args = ap.parse_args()

    cache = {}
    pairs = sorted(d for d in os.listdir(TRANS) if "__to__" in d)
    if args.pair:
        pairs = [p for p in pairs if p == args.pair]
    done = skipped = failed = 0
    for pair in pairs:
        for setdir in sorted(glob.glob(os.path.join(TRANS, pair, "*"))):
            if not os.path.isdir(setdir):
                continue
            mp = os.path.join(setdir, "meta.json")
            if not os.path.isfile(mp):
                continue
            out_dir = os.path.join(setdir, "post")
            if os.path.isdir(out_dir) and not args.force:
                skipped += 1
                continue
            meta = json.load(open(mp))
            srcs = sorted(glob.glob(os.path.join(setdir, "tile_*.webp")))
            if len(srcs) != 16:
                print(f"   ! {pair}/{os.path.basename(setdir)}: {len(srcs)} tiles, expected 16")
                failed += 1
                continue
            tiles = [Image.open(p).convert("RGBA") for p in srcs]
            # meta names the pair; index 0 holds `lower`, index 15 `upper` - the
            # endpoint's own convention, recorded in every set's meta note.
            s0 = side_spec(meta["lower"], cache)
            s15 = side_spec(meta["upper"], cache)
            try:
                out = TR.compose_transition(tiles, s0, s15)
            except Exception as exc:
                print(f"   ! {pair}/{os.path.basename(setdir)}: {type(exc).__name__}: {exc}")
                failed += 1
                continue
            os.makedirs(out_dir, exist_ok=True)
            for i, im in enumerate(out):
                im.save(os.path.join(out_dir, f"tile_{i:02d}.webp"),
                        "WEBP", lossless=True, exact=True)
            done += 1
        print(f"{pair:44} done")
    print(f"\nwrote post/ for {done} set(s), skipped {skipped} already done, {failed} failed")


if __name__ == "__main__":
    main()
