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
        # ONE FACTOR FOR ALL THREE CHANNELS, or the compression ROTATES THE COLOUR.
        #
        # This used to squeeze each channel by its own factor, which is hue-destroying
        # by construction: scaling R toward the anchor by 0.4 while G keeps 1.0 turns a
        # red flower green. Measured on the detail sheets, 2026-09-03: the motif's
        # leading channel changed in 9 of 14 grass sheets and its chroma fell 152->52,
        # 95->28, 74->33. The maintainer saw it as "you do everything green... maybe we
        # had a small red flower and you make it green".
        #
        # Scaling (px - anchor) by ONE scalar moves the colour along the line to the
        # anchor, so hue and the ratios between channels survive; only distance from
        # the clean colour shrinks, which is what fitting the range means. It costs a
        # little more contrast than the per-channel version - the worst channel now sets
        # the factor for all - and that is the right trade against inventing a colour
        # the generator never drew.
        fmin = 1.0
        for c in range(3):
            anchor = clean_rgb[c]
            vals = rgb[..., c][mask]
            mx, mn = float(vals.max()), float(vals.min())
            if mx > 255.0 and mx > anchor:
                fmin = min(fmin, (255.0 - anchor) / (mx - anchor))
            if mn < 0.0 and mn < anchor:
                fmin = min(fmin, (anchor / (anchor - mn)) if anchor > 0 else 0.0)
        if fmin < 1.0:
            for c in range(3):
                anchor = clean_rgb[c]
                ch = rgb[..., c]
                ch[mask] = anchor + (ch[mask] - anchor) * fmin
            squeeze = min(squeeze, fmin)
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


# A DETAIL'S MOTIF KEEPS ITS OWN COLOUR. Below MOTIF_NEAR a pixel is ground and takes
# the whole alignment shift; above MOTIF_FAR it is the drawn thing - a flower, a
# crystal, a footprint - and takes none. Between, the weight ramps, so there is no hard
# seam where the two meet.
MOTIF_NEAR, MOTIF_FAR = 30.0, 60.0


def align(img, clean_rgb, protect_motif=False):
    """(aligned image, background before, clipped fraction of top pixels).

    `protect_motif` is for DETAIL sheets, and it is the maintainer's rule of what a
    detail is for: "I want the grass on the detail to feel seamless against the base
    tile set... what I'm after with the details is to make the detail POP, not the
    grass tile itself."

    The plain path moves every pixel by one delta. That keeps the tile's internal
    relationships, but the delta is not small - measured on the detail sheets, grass
    needs 125 RGB units - and a translation that large does not preserve hue: it drags
    colours toward the anchor and flips which channel leads. Measured over the same
    motif pixels before and after, 38.5% of them changed leading channel and chroma
    fell to 64%. That is what he saw: "maybe we had a small red flower or something and
    you make it green".

    So on a detail sheet the shift is WEIGHTED by how ground-like each pixel is. The
    background is measured on ground pixels either way, so alignment with the base tile
    set stays exact - the seam he cares about is untouched - while the motif keeps the
    colour the generator drew.
    """
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
    if protect_motif:
        # Ground only: the same helper, on the pixels that ARE the ground, so the
        # background lands on the clean colour integer-exactly exactly as before.
        d = np.linalg.norm(rgb - bg, axis=2)
        ground = opaque & (d <= MOTIF_NEAR)
        before = rgb.copy()
        clipped = shift_mask_to_clean(rgb, ground, clean_rgb, measure=top & ground)
        # Then feather the SAME delta outward over the ramp, fading to nothing on the
        # motif, so the transition from shifted ground to untouched motif is gradual.
        delta = (rgb - before)[ground]
        step = np.median(delta, axis=0) if len(delta) else np.zeros(3)
        w = np.clip((MOTIF_FAR - d) / (MOTIF_FAR - MOTIF_NEAR), 0.0, 1.0)[..., None]
        ramp = opaque & (d > MOTIF_NEAR)
        rgb[ramp] = np.clip(before[ramp] + step * w[ramp], 0, 255)
    else:
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
    # THE LIVE PALETTE WINS, NOT THE ONE BAKED AT GENERATION TIME. index.json carries
    # each sheet's `palette_top` as it stood when the art was bought, so a palette edit
    # used to leave every post/ tile painted toward the OLD colour while the game's flat
    # fill (tiles/ground_types.json, read live) moved immediately - a bright new surface
    # meeting old-coloured tiles of the same ground. Measured when the maintainer's
    # water/sand change landed, 2026-09-03. config/palette.json is the source of truth
    # for what a surface should be; the index value is only a fallback for a ground the
    # palette no longer names.
    live = json.load(open(os.path.join(ROOT, "config", "palette.json")))["types"]
    for sheet in idx["sheets"]:
        g = sheet.get("ground")
        clean = _hex((live.get(g) or {}).get("top") or sheet["palette_top"])
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
            aligned, bg, clipped = align(
                img, clean, protect_motif=(sheet.get("flavour") == "detail"))
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
