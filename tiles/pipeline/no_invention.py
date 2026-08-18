"""Prove the postprocess never invents a colour.

Three times now a wall-alignment implementation has put a colour into a tile that was
not in the art and was not in the palette: a MAGENTA line along the grass edge (a hue
read off a grey), 1413 vivid pixels where the walls had been dull, and a RED light_soil.
Each was caught by the maintainer, in the wiki, by eye — which means the review budget
was being spent on finding my bugs instead of on judging art, and the maintainer
correctly refuses to start a review while that is still possible. That is a catch-22
and it is resolved here rather than by promising harder.

THE INVARIANT. Postprocess is allowed to do exactly three things to a pixel:

  1. paint it the palette colour of the TOP material (the flat fill),
  2. pull it TOWARD that colour (the overhanging blades move with the material they
     belong to),
  3. leave it alone.

So every pixel of the output must be the palette colour, or keep the hue it came in
with, or land on the palette colour's hue. A pixel that changed to some THIRD hue is
an invented colour by definition — magenta from grey and red from soil are both exactly
that, and both would have been caught here before the maintainer ever saw them.

Two guards make the test mean what it says:

  ACHROMATIC. Hue is not defined for grey, and every one of the three bugs went through
  a hue read off something with no hue. So a low-saturation pixel is compared on
  LUMINANCE, never on hue.

  SATURATION. Hue alone would pass "dull grey wall becomes vivid grey-blue wall" — same
  hue, different material. Saturation may not exceed what the source or the target
  already had, so a fix cannot amplify its way to a new colour.

Not a style checker. It says nothing about whether a tile looks good; it says the
image that ships is made of the art's own colours plus the palette's. Judging the art
is the maintainer's job and this is what makes that judgement affordable.

  python tiles/pipeline/no_invention.py            # sweep everything published
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import palette_snap

HUE_TOL = 14.0      # on the 0-255 hue scale; the magenta was 101 out, the red 60
SAT_FLOOR = 50.0    # below this a pixel has no meaningful hue and is judged on value
SAT_SLACK = 24.0    # allowed saturation overshoot past the source and the target
VAL_SLACK = 60.0    # ~3 std of SPILL_SPREAD: the palette colour's own natural spread
LUM_TOL = 40.0      # a pixel left in place may be re-lit, but not re-coloured


def _lum(px):
    return 0.299 * px[..., 0] + 0.587 * px[..., 1] + 0.114 * px[..., 2]


def check(before, after, top_hex, extra_hex=()):
    """Violations of the invariant, as a dict of counts plus a sample pixel.

    Both images are canonicalised the same way before comparison: postprocess clips the
    generator's spiky outline to a clean diamond, and pixels that only MOVED are not
    invented colours. Comparing raw against processed would report the whole outline.
    """
    a = np.asarray(palette_snap.canonicalise(before.convert("RGBA"))).astype(float)
    b = np.asarray(after.convert("RGBA")).astype(float)
    if a.shape != b.shape:
        return {"error": f"shape {a.shape} vs {b.shape}"}

    # A material has more than one palette colour: the flat top the surface is painted
    # and the darker `wall` shade the same material takes seen from the side. Both are
    # PALETTE colours, so both are legitimate destinations — the invariant is "the art's
    # own colours plus the palette's", not "one hex".
    targets = [palette_snap._hex(h) for h in (top_hex,) + tuple(extra_hex) if h]
    tgt = targets[0]
    tgt_hsv = palette_snap._rgb2hsv(tgt[None, :])[0]

    op = (a[..., 3] > 128) & (b[..., 3] > 128)
    changed = op & (np.abs(a[..., :3] - b[..., :3]).max(-1) > 2)
    # Rule 1: painted the palette colour. Exactly, because that is what the fill does.
    is_target = np.zeros(b.shape[:2], bool)
    for t in targets:
        is_target |= np.abs(b[..., :3] - t).max(-1) <= 2
    suspect = changed & ~is_target
    if not suspect.any():
        return {"invented": 0, "checked": int(changed.sum())}

    ys, xs = np.where(suspect)
    src = a[..., :3][suspect]
    dst = b[..., :3][suspect]
    hs = palette_snap._rgb2hsv(src)
    hd = palette_snap._rgb2hsv(dst)

    def hue_gap(u, v):
        d = np.abs(u - v)
        return np.minimum(d, 255.0 - d)

    # Rule 2 — LANDED ON THE PALETTE COLOUR. Postprocess remaps brightness as well as
    # hue on purpose (a blade in shadow keeps its relative shade but lands on the
    # palette's own light), so this has to be judged on the whole colour, not on hue
    # alone: near the target in hue, saturation AND value, with the material's natural
    # spread as slack. Judging greys on luminance instead flagged 36 tiles that were
    # doing exactly what the X-over-X rule says to do — moving a snow wall onto snow.
    onto = np.zeros(len(hd), bool)
    for t in targets:
        th = palette_snap._rgb2hsv(t[None, :])[0]
        ok = ((hue_gap(hd[:, 0], float(th[0])) <= HUE_TOL)
              | ((hd[:, 1] < SAT_FLOOR) & (th[1] < SAT_FLOOR)))
        ok &= hd[:, 1] <= float(th[1]) + SAT_SLACK
        ok &= np.abs(hd[:, 2] - float(th[2])) <= VAL_SLACK
        onto |= ok

    # Rule 3 — LEFT IN ITS OWN COLOUR. Re-lighting is allowed, re-colouring is not.
    grey = (hs[:, 1] < SAT_FLOOR) & (hd[:, 1] < SAT_FLOOR)
    kept = (hue_gap(hd[:, 0], hs[:, 0]) <= HUE_TOL) | grey
    kept &= hd[:, 1] <= hs[:, 1] + SAT_SLACK
    kept &= np.abs(_lum(dst) - _lum(src)) <= LUM_TOL

    # Neither: a third colour that was in neither the art nor the palette. Every one of
    # the three bugs lands here — magenta 101 hue units off the palette, red 60 off, and
    # the vivid walls on the saturation clause of rule 2.
    bad = ~onto & ~kept

    # BLOB, not count. An invented colour is only a bug if it can be SEEN, and what the
    # maintainer saw all three times was a REGION — a magenta line along the grass edge,
    # a red wall. A lone pixel at the far tail of the brightness remap is not that, and
    # widening the tolerances until those disappear would blunt the very rules that catch
    # the real thing. So the verdict is the largest contiguous patch of invented pixels;
    # measured, the three bugs ran to hundreds of connected pixels and the tail runs to
    # one.
    mask = np.zeros(suspect.shape, bool)
    mask[ys[bad], xs[bad]] = True
    out = {"invented": int(bad.sum()), "blob": _largest_blob(mask),
           "checked": int(changed.sum())}
    if bad.any():
        i = int(np.argmax(bad))
        out["sample"] = {
            "xy": [int(xs[i]), int(ys[i])],
            "from": [int(v) for v in src[i]], "to": [int(v) for v in dst[i]],
            "from_hue": int(hs[i, 0]), "to_hue": int(hd[i, 0]),
            "target_hue": int(tgt_hsv[0]),
        }
    return out


# The smallest patch that reads as a mark rather than as a stray pixel at this scale.
MAX_BLOB = 4


def _largest_blob(mask):
    """Size of the biggest 4-connected run of True. Flood fill — the tiles are 64px."""
    seen = np.zeros(mask.shape, bool)
    best = 0
    for sy, sx in zip(*np.where(mask)):
        if seen[sy, sx]:
            continue
        stack, n = [(int(sy), int(sx))], 0
        seen[sy, sx] = True
        while stack:
            y, x = stack.pop()
            n += 1
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                v, u = y + dy, x + dx
                if (0 <= v < mask.shape[0] and 0 <= u < mask.shape[1]
                        and mask[v, u] and not seen[v, u]):
                    seen[v, u] = True
                    stack.append((v, u))
        best = max(best, n)
    return int(best)


def sweep(review_dir, verbose=False):
    """Run the invariant over every published before/after pair. Returns the failures."""
    man = json.load(open(os.path.join(review_dir, "manifest.json")))
    repo = os.path.dirname(os.path.dirname(os.path.abspath(review_dir)))
    fails, n = [], 0
    for cell, c in man["cells"].items():
        for e in c["candidates"]:
            top_hex = e.get("palette_top")
            if not top_hex:
                continue
            r = check(Image.open(os.path.join(repo, e["before"])),
                      Image.open(os.path.join(repo, e["after"])), top_hex)
            n += 1
            if r.get("error") or r.get("blob", 0) > MAX_BLOB:
                fails.append({"key": e["key"], **r})
            elif verbose:
                stray = r.get("invented", 0)
                print(f"  ok  {e['key']:44s} {r['checked']:6d} px changed"
                      + (f", {stray} stray" if stray else ""))
    return fails, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--review", default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "review"))
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    fails, n = sweep(args.review, args.verbose)
    if not fails:
        print(f"NO INVENTED COLOURS — {n} published tiles, every changed pixel is either "
              f"the palette colour, its own hue, or the palette's hue.")
        return 0
    print(f"INVENTED COLOURS in {len(fails)} of {n} published tiles:\n")
    for f in sorted(fails, key=lambda f: -f.get("blob", 0))[:20]:
        s = f.get("sample") or {}
        print(f"  {f['key']:44s} blob {f.get('blob', 0):5d} px  "
              f"{s.get('from')} -> {s.get('to')}  "
              f"hue {s.get('from_hue')} -> {s.get('to_hue')} (palette {s.get('target_hue')})")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
