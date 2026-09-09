"""Reclaim a wall face that the colour split handed to the wrong material.

FOR ONE CELL. dark_mud over slime: "the left slime wall is light brown redish?
Bottom left wall should be green." The darker-lit LEFT face sits closer to the mud
anchor than to slime's own wall, so _split_wall gives it away wholesale - measured
98.3% of that face reading as mud, against 26% on the healthy grey_stone over slime.

WHY NOT A pair_tweak. claim_depth and claim_lip both re-run the wall split, and that
makes substitute() re-centre its statistics across the WHOLE side region - so every
slime pixel moves, not just the wrong ones. Measured on a sibling cell: the slime wall
went from (42,160,114) vivid mint to (90,132,44) olive, 751 of 776 pixels, on a change
meant only to deepen a lip. The slime palette is the maintainer's favourite in the
game and is marked PROTECTED in palette.json.

So this repaints NOTHING. It takes the wrongly-claimed pixels only, and gives each one
a colour that is ALREADY IN THE TILE: the slime the generator drew, matched by
luminance rank so the face keeps its own shading. Every pixel that was already slime
is byte-identical afterwards, which is asserted, not hoped for.
"""
import numpy as np
from PIL import Image


def _lum(px):
    return 0.299 * px[..., 0] + 0.587 * px[..., 1] + 0.114 * px[..., 2]


def reclaim_left_wall(img, top_hex, side_hex, min_source=40):
    """Give the left wall face back to the side material, using its own slime.

    Takes palette hexes and finds the wall faces itself, so the caller needs neither
    numpy nor the region geometry. Returns (image, n_fixed); only pixels that read as
    the TOP material on the LEFT face are ever written.
    """
    import palette_snap as _ps
    top_rgb = _ps._hex(top_hex)
    side_rgb = _ps._hex(side_hex)
    _a = np.asarray(_ps.canonicalise(img)).astype(float)
    reg = _ps._regions(_a)
    if not reg:
        return img, 0
    wall_mask = reg["left"] | reg["right"]
    # palette_snap's wall regions and the per-column top face disagree by a few pixels
    # at the crown - 3 on this cell. The top is never this function's business, so it
    # is excluded explicitly rather than trusted to be outside the wall mask.
    import transition_render as _tr
    a0 = np.array(img.convert("RGBA"), int)
    wall_mask = wall_mask & ~_tr.top_face(a0[..., 3] > 0)
    a = np.array(img.convert("RGBA"), int)
    rgb = a[..., :3].astype(float)
    h, w = a.shape[:2]
    xx = np.arange(w)[None, :].repeat(h, 0)

    d_top = np.abs(rgb - np.asarray(top_rgb, float)).sum(2)
    d_side = np.abs(rgb - np.asarray(side_rgb, float)).sum(2)
    is_top = d_top < d_side

    # THE OVERHANG STAYS BROWN. The top material drapes over its own wall and that brim
    # is real on both faces: "I have drawn red on the overhang. The overhang should be
    # brown, but the wall marked with blue should still be green (at the bottom of the
    # wall there can also be a small 1px brown line)."
    #
    # The depth is not guessed. The RIGHT face already draws it correctly, so it is
    # measured there per column and the same depth is protected on the left - measured
    # on this cell: 6 rows of 17 on the right, against 16 of 17 wrongly brown on the
    # left. A 1px line at the very bottom is left brown for the same reason.
    right = wall_mask & (xx >= w / 2)
    depths = []
    for x in np.nonzero(right.any(0))[0]:
        col = np.nonzero(right[:, x])[0]
        k = 0
        for y in col:
            if is_top[y, x]:
                k += 1
            else:
                break
        depths.append(k)
    brim = int(np.median(depths)) if depths else 0

    left = wall_mask & (xx < w / 2)
    body = np.zeros_like(left)
    for x in np.nonzero(left.any(0))[0]:
        col = np.nonzero(left[:, x])[0]
        if len(col) > brim + 1:
            body[col[brim]:col[-1], x] = True   # skip the brim, and the last row
    left = left & body

    wrong = left & is_top                      # what to fix
    source = wall_mask & ~is_top               # slime the generator already drew
    if wrong.sum() == 0 or source.sum() < min_source:
        return img, 0

    # match by luminance rank, so a dark wrong pixel becomes a dark slime pixel and the
    # face keeps its relief instead of going flat
    src = rgb[source]
    order = np.argsort(_lum(src))
    ranked = src[order]
    tgt_l = _lum(rgb[wrong])
    if tgt_l.max() > tgt_l.min():
        q = (tgt_l - tgt_l.min()) / (tgt_l.max() - tgt_l.min())
    else:
        q = np.full(tgt_l.shape, 0.5)
    idx = np.clip((q * (len(ranked) - 1)).astype(int), 0, len(ranked) - 1)

    picked = ranked[idx].astype(float)

    # KEEP THE FACE'S OWN LIGHTING. The generator lights the left and right faces
    # differently, and that difference is most of what makes a tile read as a solid
    # block rather than a sticker. Matching ranks alone pulls the left face up to the
    # source's brightness, so it comes out lighter than the right and the block goes
    # flat. Rescale back onto the brightness the face already had.
    want = float(_lum(rgb[wrong]).mean())
    got = float(_lum(picked).mean())
    if got > 1.0:
        picked = np.clip(picked * (want / got), 0, 255)

    out = a.copy()
    out[..., :3][wrong] = np.round(picked)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA"), int(wrong.sum())
