"""Align every top-only tile's BACKGROUND onto its ground's clean colour: `post/`.

The maintainer's rule, and it is a selection rule as much as a rendering one:

    "What I want is the top background color to always align with the tile's
     clean/plain color so any tile's top fit in seamlessly without creating a stupid
     border... A good detail to me is where I can see that 'flower' or 'crack' and
     only that detail. I don't want to discard this tile becouse the bg is different."

THE BACKGROUND IS THE MAJORITY, NOT THE MEAN. A detail tile exists because something
big sits on it, and that something drags a mean: recentring the mean would push the
background OFF the clean colour in exact compensation for the flower. The background
is estimated as a trimmed median instead - median of the top face, then twice re-take
the median of only the pixels near it - which a minority feature cannot move.

THE WHOLE TILE MOVES BY ONE OFFSET. out = art + (clean - background), every pixel the
same delta. That is the gentlest transform that puts the background exactly on the
clean colour: every relative relationship in the tile survives untouched, so the
texture keeps its grain and a red flower stays red - substitute() here would repaint
the flower in the ground's hue, which is precisely the "discard this tile" failure he
is trying to stop. The wall is shifted with the top (one tile, one delta - a seam
between shifted top and unshifted wall would be invented detail on art whose wall is
meaningless anyway).

MISFITS ARE FLAGGED, NOT MANGLED. A tile whose background is far from the palette in
HUE cannot be fixed by translation - the shift lands it on the clean value but the
texture reads foreign, and heavy clipping flattens it. Tiles where >10% of top pixels
clip, or the background sits >90 RGB from the clean colour, are still written but
carry "misfit": true in the index so the audition can show them last rather than
silently losing them.

Output sits BESIDE the raw tiles (`<sheet>/post/tile_NN.webp`), never over them: the
raw pass stays reviewable and the rule can be re-run when it changes.
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

import transition_render as TR

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
TOPS = os.path.join(ROOT, "tops")

CLIP_MISFIT = 0.50   # squeeze below half = the tail lost most of its contrast
HUE_MISFIT = 30.0    # degrees between the background's hue and the clean colour's -
                     # value distance is NOT flagged, the shift corrects it exactly
MIN_CHROMA = 18.0    # below this opponent-magnitude a colour has no hue to compare


def _hex(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], float)


def background_of(rgb, top):
    """Trimmed median of the top face - the majority colour, feature-proof."""
    px = rgb[top]
    med = np.median(px, 0)
    for _ in range(2):
        near = np.abs(px - med).sum(1) < 90.0
        if near.sum() >= 30:
            med = np.median(px[near], 0)
    return med


def shift_mask_to_clean(rgb, mask, clean_rgb, iters=3, measure=None):
    """Shift the pixels under `mask` so their trimmed-median background lands on the
    clean colour INTEGER-EXACTLY, compressing overflow around the clean anchor.

    Exactness needs iteration, not faith: a median of integers can be half-integral,
    so one rounded shift can leave the background 1/255 off - and on a near-black
    ground one unit per channel is a visible patch ("the bg has a small differences
    against it's surrounding" - measured on his tile, background (29,28,29) against
    clean (30,29,30)). Each pass applies the rounded residual; it converges in <=3.

    Modifies rgb in place. Returns (1 - worst compression factor).
    """
    squeeze = 1.0
    # MEASURE AND APPLY ARE DIFFERENT MASKS when the wall rides along: the background
    # is a property of the TOP FACE, and a median taken over top+wall answers a
    # question nobody asked.
    measure = mask if measure is None else measure
    for _ in range(iters):
        bg = background_of(rgb, measure)
        delta = np.rint(clean_rgb - bg)
        if not np.abs(delta).sum():
            break
        rgb[mask] += delta
        for c in range(3):
            anchor = clean_rgb[c]
            ch = rgb[..., c]
            vals = ch[mask]
            mx = float(vals.max())
            if mx > 255.0 and mx > anchor:
                f = (255.0 - anchor) / (mx - anchor)
                sel = mask & (ch > anchor)
                ch[sel] = anchor + (ch[sel] - anchor) * f
                squeeze = min(squeeze, f)
            mn = float(vals.min())
            if mn < 0.0 and mn < anchor:
                f = anchor / (anchor - mn) if anchor > 0 else 0.0
                sel = mask & (ch < anchor)
                ch[sel] = anchor + (ch[sel] - anchor) * f
                squeeze = min(squeeze, f)
        np.rint(rgb, out=rgb)
        np.clip(rgb, 0, 255, out=rgb)
    return 1.0 - squeeze


# The drawn edge line lives in the outermost pixels of the top face: measured on the
# maintainer's deep_water tile, ring 1 has 27% of pixels >8 off the clean colour while
# rings 2-4 and the interior sit at exactly 0. Two rings covers every ground sampled.
RIM_W = 2
# A rim pixel is snapped only when it is NEAR the clean colour - the faint edge shading
# always is, a sparkle or a flower crossing the edge never is. L1 over RGB.
RIM_SNAP = 120.0


def rim_suppress(rgb, top, clean_rgb, width=RIM_W, snap=RIM_SNAP):
    """Erase the tile's own edge line so a field of copies shows no lattice.

    "At the border/edge they have a line that makes it very obvious this is a tile" -
    the generator draws every tile as an OBJECT, with a subtle bevel along the top
    face's rim, and a field of them reads as a grid of diamonds. The rim pixels are
    not background, so background alignment cannot reach them.

    Only near-clean rim pixels are snapped: the bevel is always a modest offset from
    the background, while a genuine detail crossing the edge (a sparkle on water, a
    blade of grass) is far from it and passes through untouched. Returns snapped count.
    """
    cur = top.copy()
    for _ in range(width):
        e = cur.copy()
        e[1:] &= cur[:-1]
        e[:-1] &= cur[1:]
        e[:, 1:] &= cur[:, :-1]
        e[:, :-1] &= cur[:, 1:]
        cur = e
    rim = top & ~cur
    if not rim.any():
        return 0
    d1 = np.abs(rgb[rim] - clean_rgb).sum(1)
    sel = np.zeros(rgb.shape[:2], bool)
    sel[rim] = d1 < snap
    rgb[sel] = clean_rgb
    return int(sel.sum())


def align(img, clean_rgb):
    """(aligned image, background before, clipped fraction of top pixels)."""
    a = np.array(img.convert("RGBA"), int)
    top = TR.top_face(a[..., 3] > 0)
    if not top.any():
        return None, None, 1.0
    rgb = a[..., :3].astype(float)
    bg = background_of(rgb, top)
    # One region, one shift: the wall moves with the top (wall_is_meaningless on this
    # art), the background is measured on the top face, and the helper drives it onto
    # the clean colour integer-exactly with anchored compression for the overflow.
    opaque = a[..., 3] > 0
    clipped = shift_mask_to_clean(rgb, opaque, clean_rgb, measure=top)
    rim_suppress(rgb, top, clean_rgb)
    out = a.copy()
    out[..., :3] = np.clip(np.rint(rgb), 0, 255).astype(int)
    return Image.fromarray(out.astype(np.uint8), "RGBA"), bg, clipped


def main():
    idx_path = os.path.join(TOPS, "index.json")
    idx = json.load(open(idx_path))
    wrote = misfits = 0
    worst = []
    for sheet in idx["sheets"]:
        clean = _hex(sheet["palette_top"])
        d = os.path.join(REPO, sheet["dir"])
        post = os.path.join(d, "post")
        os.makedirs(post, exist_ok=True)
        flags = {}
        # ART IS IMMUTABLE: A REGENERATED TILE GETS A NEW NAME. Rewriting pixels under a
        # stable URL is how the maintainer's phone showed two generations of the same
        # file side by side and read it as the game being destroyed ("What is real and
        # what is a cache bug? Noone knows now"). The post filename carries the content
        # hash, the index points at the current name, and every stale name is deleted -
        # so a cache can only ever show a coherent old version or a missing image,
        # never a wrong-pixel mix. The class is gone, not patched.
        post_files = []
        for name in sheet["tiles"]:
            img = Image.open(os.path.join(d, name))
            aligned, bg, clipped = align(img, clean)
            if aligned is None:
                post_files.append(None)
                continue
            buf = io.BytesIO()
            aligned.save(buf, "WEBP", lossless=True, exact=True)
            data = buf.getvalue()
            h8 = hashlib.sha1(data).hexdigest()[:8]
            hashed = name.replace(".webp", f".{h8}.webp")
            with open(os.path.join(post, hashed), "wb") as fh:
                fh.write(data)
            post_files.append(hashed)
            # THE PREVIOUS GENERATION IS KEPT, NOT DELETED. A hashed name is content-
            # addressed: retaining it can only ever serve the identical bytes, so it is
            # not a cache hazard - while deleting it 404s every page ALREADY OPEN, which
            # is what put holes in the maintainer's audition ("Why is so many tiles just
            # a hole"). His page named the previous generation; main had only the new
            # one. Keep current + one previous, drop anything older, so an open page
            # keeps rendering and the repo stays bounded.
            gens = sorted(glob.glob(os.path.join(post, name.replace(".webp", ".*.webp"))),
                          key=os.path.getmtime, reverse=True)
            for old_f in gens[2:]:
                os.remove(old_f)
            wrote += 1
            # THE HUE IS THE ONLY UNFIXABLE AXIS. The shift lands the background's
            # VALUE and tint exactly on the clean colour, so distance alone must not
            # flag - measured, it flagged all 48 slime subtle tiles for being darker
            # than the vivid mint, which the shift corrects perfectly. What survives
            # the shift is the texture's hue, so the flag compares hue ANGLES, and
            # only where both colours have chroma to compare (a grey has no hue).
            import math
            def _op(c):
                return (float(c[0]) - float(c[1]), float(c[1]) - float(c[2]))
            ob, oc = _op(bg), _op(clean)
            nb = math.hypot(*ob)
            nc = math.hypot(*oc)
            hue_deg = 0.0
            if nb >= MIN_CHROMA and nc >= MIN_CHROMA:
                cosang = (ob[0] * oc[0] + ob[1] * oc[1]) / (nb * nc)
                hue_deg = math.degrees(math.acos(max(-1.0, min(1.0, cosang))))
            if clipped > CLIP_MISFIT or hue_deg > HUE_MISFIT:
                flags[name] = {"misfit": True,
                               "squeezed_pct": round(100 * clipped, 1),
                               "hue_deg": round(hue_deg, 1)}
                misfits += 1
            worst.append((clipped, hue_deg, f'{sheet["dir"]}/{name}'))
        sheet["post"] = True
        sheet["post_files"] = post_files
        sheet.pop("misfit_tiles", None)     # stale flags from a prior run must not survive
        if flags:
            sheet["misfit_tiles"] = flags
    idx["post_pass"] = {
        "rule": "out = art + (clean - background), overflow compressed into the gamut "
                "around the clean anchor; background = trimmed median of the top face",
        "dir": "<sheet>/post/<name from sheet.post_files - NEVER constructed by convention>",
        "immutable": "a regenerated tile gets a new content-hashed filename and the old "
                     "one is deleted; stale caches show a coherent old version or a 404, "
                     "never mixed generations",
        "misfit": f"tail contrast squeezed below {int((1-CLIP_MISFIT)*100)}%, or background "
                  f"hue more than {int(HUE_MISFIT)} degrees from the clean colour - "
                  f"written but flagged; value distance never flags, the shift fixes it",
    }
    with open(idx_path, "w") as f:
        json.dump(idx, f, indent=1)
    worst.sort(reverse=True)
    print(f"aligned {wrote} tiles; misfits flagged {misfits}")
    for c, dst, p in worst[:6]:
        print(f"   worst: clip {100*c:5.1f}%  bg_dist {dst:6.1f}  {p}")


if __name__ == "__main__":
    main()
