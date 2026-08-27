"""Align every BLEND tile's dominant-ground background onto that ground's clean colour.

Same law as tops_post, one genuine difference: a blend has TWO materials, so "the
background" is ambiguous and the trimmed median of the whole top face answers the wrong
question - at p50 it lands somewhere between the two grounds and would drag the tile off
BOTH palettes.

WE ALIGN THE DOMINANT PORTION. Top pixels are split by which clean colour they sit
nearer (A's or B's), the trimmed median is taken over the A-side pixels only, and the
whole tile is shifted by that one delta. So:

  - the A-portion lands exactly on A's clean colour - a p10 tile drops into a field of
    plain A with no border, which is the entire point of the ladder ("start ease in a
    change in base tile change long before the base tile change is enforced");
  - the B-portion rides along on the same delta, keeping its contrast against A intact.
    Snapping it to B's palette separately would flatten the blend into two flat colours
    and destroy the drift.

The A-side split needs pixels to be honest: below MIN_SIDE the tile is treated as
un-splittable and the plain top-face median is used, flagged `split: "whole"` in the
index so the audition can show it for what it is.

Rim suppression carries over unchanged and needs no special case: it snaps only rim
pixels NEAR A's clean colour, so an A rim loses its bevel while a B patch crossing the
edge is far away and passes straight through.

Output sits beside the raw tiles under content-hashed names (`post/tile_NN.<sha8>.webp`)
- the immutability law, enforced by check_immutable.py.
"""

from __future__ import annotations

import glob
import hashlib
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
from PIL import Image

import tops_post as TP
import transition_render as TR

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
BLENDS = os.path.join(ROOT, "blends")
PALETTE = json.load(open(os.path.join(ROOT, "config", "palette.json")))["types"]

MIN_SIDE = 120       # top-face pixels needed before the A-side median is trustworthy
                     # (the top face is ~1450 px, so this is ~8% of the tile)


def split_masks(rgb, top, clean_a, clean_b):
    """(A-side mask, B-side mask) - each top pixel to the clean colour it sits nearer."""
    da = np.abs(rgb - clean_a).sum(2)
    db = np.abs(rgb - clean_b).sum(2)
    a = top & (da <= db)
    return a, top & ~a


def align(img, clean_a, clean_b):
    """(aligned image, A-side fraction, which mask drove the shift, squeeze)."""
    arr = np.array(img.convert("RGBA"), int)
    top = TR.top_face(arr[..., 3] > 0)
    if not top.any():
        return None, 0.0, "none", 1.0
    rgb = arr[..., :3].astype(float)
    a_side, _ = split_masks(rgb, top, clean_a, clean_b)
    frac = float(a_side.sum()) / float(top.sum())
    measure, how = (a_side, "dominant") if a_side.sum() >= MIN_SIDE else (top, "whole")
    # One tile, one delta: the whole opaque region moves, measured on the A-side only.
    # The wall rides along - wall_is_meaningless on this art, and a seam between a
    # shifted top and an unshifted wall would be invented detail.
    squeeze = TP.shift_mask_to_clean(rgb, arr[..., 3] > 0, clean_a, measure=measure)
    TP.rim_suppress(rgb, top, clean_a)
    out = arr.copy()
    out[..., :3] = np.clip(np.rint(rgb), 0, 255).astype(int)
    return Image.fromarray(out.astype(np.uint8), "RGBA"), frac, how, squeeze


def main():
    idx_path = os.path.join(BLENDS, "index.json")
    idx = json.load(open(idx_path))
    wrote = whole = 0
    for sheet in idx["sheets"]:
        clean_a = TP._hex(PALETTE[sheet["dominant"]]["top"])
        clean_b = TP._hex(PALETTE[sheet["minor"]]["top"])
        d = os.path.join(REPO, sheet["dir"])
        post = os.path.join(d, "post")
        os.makedirs(post, exist_ok=True)
        post_files, fracs, measured = [], [], []
        for name in sheet["tiles"]:
            aligned, frac, how, _sq = align(Image.open(os.path.join(d, name)),
                                            clean_a, clean_b)
            if aligned is None:
                post_files.append(None)
                measured.append(None)      # both lists stay index-aligned with `tiles`
                continue
            buf = io.BytesIO()
            aligned.save(buf, "WEBP", lossless=True, exact=True)
            data = buf.getvalue()
            h8 = hashlib.sha1(data).hexdigest()[:8]
            hashed = name.replace(".webp", f".{h8}.webp")
            with open(os.path.join(post, hashed), "wb") as fh:
                fh.write(data)
            post_files.append(hashed)
            # Current + one previous generation - a hashed name can only ever serve
            # identical bytes, while deleting it 404s pages already open (that is what
            # put holes in the maintainer's audition).
            gens = sorted(glob.glob(os.path.join(post, name.replace(".webp", ".*.webp"))),
                          key=os.path.getmtime, reverse=True)
            for old_f in gens[2:]:
                os.remove(old_f)
            fracs.append(frac)
            measured.append(round(100.0 * (1.0 - frac), 1))
            whole += how == "whole"
            wrote += 1
        sheet["post"] = True
        sheet["post_files"] = post_files
        # THE MEASURED MIX, beside the asked-for one. `pct_minor` is what we ORDERED;
        # this is what the art actually contains, per sheet, by nearest-clean-colour.
        # A generator does not measure area, so the ladder is only as monotone as the
        # art - publishing both lets the wiki sort by the real thing.
        if fracs:
            sheet["measured_pct_minor"] = round(100.0 * (1.0 - sum(fracs) / len(fracs)), 1)
            # PER TILE, because the maintainer picks TILES, not sheets. One sheet's 16
            # takes measured 0-20% minor against an ordered 10% - a sheet mean would hide
            # both ends. Aligned with `tiles`/`post_files` by index.
            sheet["measured_tiles"] = measured
    idx["post_pass"] = {
        "rule": "out = art + (clean_dominant - background_of_the_dominant_portion); top "
                "pixels are split by nearest clean colour and only the dominant side is "
                "measured, so the tile drops into a plain field of its dominant ground "
                "with no border while the minor ground keeps its contrast",
        "dir": "<sheet>/post/<name from sheet.post_files - NEVER constructed by convention>",
        "immutable": "a regenerated tile gets a new content-hashed filename; current + one "
                     "previous generation are retained so an open page keeps rendering",
        "measured_pct_minor": "the mix actually present in the art (nearest-clean-colour "
                              "area), beside pct_minor which is what was ordered",
        "measured_tiles": "the same measure PER TILE, index-aligned with `tiles` and "
                          "`post_files`; a sheet's 16 takes vary widely around the "
                          "ordered level, so sort and label by this, not by pct_minor",
    }
    with open(idx_path, "w") as f:
        json.dump(idx, f, indent=1)
    print(f"aligned {wrote} blend tiles ({whole} fell back to the whole-top median)")
    if idx["sheets"]:
        rows = [(s.get("measured_pct_minor"), s["pct_minor"],
                 f'{s["dominant"]}+{s["minor"]}') for s in idx["sheets"]
                if s.get("measured_pct_minor") is not None]
        for pair in sorted({r[2] for r in rows})[:4]:
            got = sorted((r[1], r[0]) for r in rows if r[2] == pair)
            print("   " + pair + ": " +
                  "  ".join(f"p{o:02d}->{m:.0f}%" for o, m in got))


if __name__ == "__main__":
    main()
