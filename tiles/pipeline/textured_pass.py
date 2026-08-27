"""Publish the TEXTURED pass for every review candidate: `<n>_textured.webp`.

The audition gap this closes, in the maintainer's words: "only the first tile had the
texture visible (in raw). All the other tiles had the plain single color... It's more
likely you have a bug and show the clean single color instead of their real texture."

There was no bug and no clean generation - the AFTER tiles are clean BY LAW (the
clean-top default: interior exactly one colour, plus the 0.75 boundary row), and the
wiki's audition falls back to them when it cannot synthesize a textured top
(wiki.js:4987 "cb(null) = cannot synthesize"). black_rock is the worst case: it appears
in ZERO transition pairs, so it has no ballots in tiles/base_candidates/ either, and
287 of its candidates audition as flat colour. The texture was never missing from the
art - every candidate's raw generation is committed as `<n>_before.webp` - it was
missing a published, colour-corrected file.

A textured tile is the AFTER tile with its top face replaced by substitute() of the RAW
top against the ground's top hex: palette hue and saturation, the art's own relief -
the wall treatment the maintainer loves, applied to the top. The wall is the after
tile's wall, untouched. Top and wall are never substituted together (that bug recentred
the top +5 points bright; fixed in transition_render the same day).

Derivable entirely from the committed review tree, which matters: tiles/matrix/ is
container-local and currently empty, so publish.py cannot rebuild the manifest - but
this pass needs only before + after, which are both in git.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
from PIL import Image

import palette_snap as PS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
PALETTE = json.load(open(os.path.join(ROOT, "config", "palette.json")))["types"]


def textured_of(before_path, after_path, top_hex):
    """The after tile, its top face carrying the raw art's texture, colour-corrected."""
    bef = PS.canonicalise(Image.open(before_path).convert("RGBA"))
    aft = PS.canonicalise(Image.open(after_path).convert("RGBA"))
    ab = np.array(bef, int).astype(float)
    aa = np.array(aft, int).astype(float)
    reg = PS._regions(aa)
    if reg is None:
        return None
    # The after's top mask, restricted to where the raw art has pixels (the clean top
    # trims blades above the diamond; the raw art still has them, the reverse is rare).
    m = reg["top"] & (ab[..., 3] > 0)
    if not m.any():
        return None
    px = PS.substitute(ab, m, top_hex)
    out = aa.copy()
    if px is not None:
        out[..., :3][m] = px
    else:
        out[..., :3][m] = ab[..., :3][m]
    # THE BACKGROUND LANDS ON THE CLEAN COLOUR EXACTLY, not merely the mean.
    # substitute() recentres the MEAN, and bright speckle drags a mean: measured on the
    # tile the maintainer flagged (black_rock over dark_mud 6c7f2c5a), the mean sat 0.1
    # from clean while the BACKGROUND - the thing the eye reads as the tile's colour -
    # sat at (29,28,29) against (30,29,30). One unit per channel on near-black is a
    # visible patch in a set field. The same integer-exact shift the tops pass uses
    # closes it; the wall is not touched (it belongs to the cell's side material).
    import tops_post as _tp
    rgbf = out[..., :3].astype(float)
    _tp.shift_mask_to_clean(rgbf, m, _tp._hex(top_hex))
    out[..., :3] = np.clip(np.rint(rgbf), 0, 255).astype(int)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def write_textured(manifest_path=None, only_missing=False):
    """Write `<n>_textured.webp` beside every after tile and record it in the manifest.

    Also run from publish.py's tail so a future publish keeps the pass current.
    """
    mp = manifest_path or os.path.join(ROOT, "review", "manifest.json")
    man = json.load(open(mp))
    wrote = skipped = failed = 0
    for cell, c in man["cells"].items():
        top = c["top"]
        hexv = (PALETTE.get(top) or {}).get("top")
        for e in c["candidates"]:
            after = os.path.join(REPO, e["after"])
            before = os.path.join(REPO, e["before"])
            tex = after.replace("_after.webp", "_textured.webp")
            rel = os.path.relpath(tex, REPO)
            if only_missing and os.path.isfile(tex):
                e["textured"] = rel
                skipped += 1
                continue
            if not (os.path.isfile(after) and os.path.isfile(before)) or not hexv:
                failed += 1
                continue
            im = textured_of(before, after, hexv)
            if im is None:
                failed += 1
                continue
            im.save(tex, "WEBP", lossless=True, exact=True)
            e["textured"] = rel
            wrote += 1
    with open(mp, "w") as f:
        json.dump(man, f, indent=2)
    print(f"textured pass: wrote {wrote}, kept {skipped}, failed {failed}")
    return wrote, skipped, failed


if __name__ == "__main__":
    write_textured(only_missing="--missing-only" in sys.argv)
