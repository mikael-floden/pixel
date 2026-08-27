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


def align(img, clean_rgb):
    """(aligned image, background before, clipped fraction of top pixels)."""
    a = np.array(img.convert("RGBA"), int)
    top = TR.top_face(a[..., 3] > 0)
    if not top.any():
        return None, None, 1.0
    rgb = a[..., :3].astype(float)
    bg = background_of(rgb, top)
    shifted = rgb + (clean_rgb - bg)
    # THE OVERFLOW IS COMPRESSED, NEVER CLIPPED. Lava's clean colour has red at 253, so
    # a plain shift throws every glow highlight off the top of the range and hard-clips
    # it flat - measured, up to 91% of a lava tile's top pixels, the texture destroyed.
    # Instead each channel's tail beyond the anchor is scaled into the headroom that is
    # actually left: the background stays EXACTLY on the clean colour (the anchor is the
    # fixed point of the scaling) and everything above or below it keeps its ordering,
    # just tighter. `squeeze` records the worst channel's factor - 1.0 means the shift
    # fitted without touching anything.
    squeeze = 1.0
    for c in range(3):
        anchor = clean_rgb[c]
        ch = shifted[..., c]
        mx = float(ch[top].max()) if top.any() else anchor
        if mx > 255.0 and mx > anchor:
            f = (255.0 - anchor) / (mx - anchor)
            sel = ch > anchor
            ch[sel] = anchor + (ch[sel] - anchor) * f
            squeeze = min(squeeze, f)
        mn = float(ch[top].min()) if top.any() else anchor
        if mn < 0.0 and mn < anchor:
            f = anchor / (anchor - mn) if anchor > 0 else 0.0
            sel = ch < anchor
            ch[sel] = anchor + (ch[sel] - anchor) * f
            squeeze = min(squeeze, f)
    out = a.copy()
    out[..., :3] = np.clip(np.rint(shifted), 0, 255).astype(int)
    return Image.fromarray(out.astype(np.uint8), "RGBA"), bg, 1.0 - squeeze


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
        for name in sheet["tiles"]:
            img = Image.open(os.path.join(d, name))
            aligned, bg, clipped = align(img, clean)
            if aligned is None:
                continue
            aligned.save(os.path.join(post, name), "WEBP", lossless=True, exact=True)
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
        sheet.pop("misfit_tiles", None)     # stale flags from a prior run must not survive
        if flags:
            sheet["misfit_tiles"] = flags
    idx["post_pass"] = {
        "rule": "out = art + (clean - background), overflow compressed into the gamut "
                "around the clean anchor; background = trimmed median of the top face",
        "dir": "<sheet>/post/tile_NN.webp",
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
