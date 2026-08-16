"""Snap a flat tile's surfaces to exact palette colours.

The requirement is that every grass tile is the SAME green in game, every snow tile
the same white, and so on. That does NOT mean the generator has to return the same
green every time — it only has to return a FLAT one. Alignment happens here.

Why this is trivial for tiles 3.0 and was a months-long fight in tiles2:

  tiles2 had to *harmonise* — hunt a material's pixels by hue band and value window
  inside textured art, shift them toward a target, and try not to catch the flowers,
  the fire, the dirt sides or the other material in a transition. Every failure mode
  we chased (grass going khaki, stone reading as snow, black crushing to #000000,
  the bonfire turning teal) came from that guessing.

  Here the surfaces are found GEOMETRICALLY — the top diamond and the two wall faces
  are known from the tile's own bounding box, not from colour — and each is a single
  flat fill. So aligning to the palette is a substitution, not an inference. Nothing
  can be mis-selected, because nothing is being selected by appearance.

It also REPAIRS the tile: a surface that generated at 0.99 flat comes out exactly
1.00, since every pixel of the region is written. So generation only has to get close
to flat, which is what makes the hard X-over-Y pairs tractable at all.

Wall shading is preserved as a RATIO, not copied: the generator lights the left and
right walls differently (e.g. 105 vs 144 grey), and that difference is what makes the
tile read as a solid block instead of a sticker. We keep each wall's own brightness
relative to the pair and re-apply it to the palette colour.

  python tiles/pipeline/palette_snap.py in.png out.png --top 3f8a3a --side 8a8f8c
"""

from __future__ import annotations

import argparse

import numpy as np
from PIL import Image

import flatness


def _hex(s):
    s = s.lstrip("#")
    return np.array([int(s[i:i + 2], 16) for i in (0, 2, 4)], float)


def _regions(a):
    """Top / left-wall / right-wall masks from the tile's own geometry.

    The diamond is MEASURED, never assumed. Its apex is the topmost opaque pixel and
    its left/right corners are the topmost opaque pixel of the bounding box's outermost
    columns, so the half-height falls out of the art (14 on a 64-wide tile — the diamond
    is 64x28, not 64x32).

    Assuming the usual 2:1 diamond instead costs 2px of half-height, which pushes the
    top/wall boundary 1-3 rows BELOW where the top surface actually ends. That band is
    the dark shading the generator draws where the grass overhangs the cliff, and
    repainting it flat palette green fattens the green area by 4.4% and deletes the
    tile's edge definition. It is the same off-by-two that made rendered plateaus come
    out ragged.

    The +1 is the diamond's own boundary ROW, which a strict inequality drops: with an
    even tile width the centre falls between columns, so the bottom vertex never quite
    reaches the threshold. Including it makes the mask land exactly on the last pixel of
    the top surface far more often than any other cutoff, and leaves the flat fill 2.0%
    SMALLER than the raw art rather than larger — so the postprocess can never be what
    enlarges a surface.

    Both figures are measured over the 350 generated grass tiles whose wall material is
    not itself green, comparing the mask against the raw art's own green silhouette.
    """
    h, w = a.shape[:2]
    op = a[:, :, 3] > 128
    if not op.any():
        return None
    ys, xs = np.where(op)
    x0, x1, y0 = int(xs.min()), int(xs.max()), int(ys.min())
    bw = x1 - x0 + 1
    cx = (x0 + x1) / 2.0
    hw = bw / 2.0
    corners = [int(np.where(op[:, x])[0].min()) - y0 for x in (x0, x1)]
    hh = float(np.mean(corners)) or hw / 2.0
    cy = y0 + hh
    yy, xx = np.mgrid[0:h, 0:w]
    below = yy > cy + hh * (1.0 - np.abs(xx - cx) / hw) + 1.0
    # Claim every opaque pixel above the line rather than only those inside the strict
    # diamond. The strict form leaves its own outermost rim in no mask at all, so the
    # rim keeps its raw colour while the interior is repainted — invisible on one tile,
    # a bright grid line along every shared edge once tessellated. Those rim pixels are
    # not a compromise: measured on a real tile they are fully opaque and green, i.e.
    # they ARE the top surface, the equation just cuts a pixel inside the art. The wall
    # keeps every pixel below the line, unchanged.
    return {"top": op & ~below,
            "left": below & op & (xx <= cx), "right": below & op & (xx > cx)}


CANON_HH, CANON_HW = 14.0, 32.0     # the house diamond: 64 wide, 28 tall


def _diamond(a):
    """Fit the canonical top diamond to a tile: (apex_y, cx, hw, hh).

    The apex is fitted by MEDIAN rather than taken as the topmost opaque pixel, because
    the topmost pixel is often a grass blade rather than the corner of the tile. Each
    column implies an apex (its own top edge minus where the clean edge would be at that
    column); the median of those is the apex the majority of the outline agrees on, so a
    minority of spikes cannot drag it.
    """
    op = a[:, :, 3] > 128
    ys, xs = np.where(op)
    x0, x1 = int(xs.min()), int(xs.max())
    hw = (x1 - x0 + 1) / 2.0
    hh = CANON_HH * hw / CANON_HW
    cx = (x0 + x1) / 2.0
    implied = [int(np.where(op[:, x])[0].min()) - np.floor(hh * abs(x - cx) / hw)
               for x in range(x0, x1 + 1) if op[:, x].any()]
    return float(np.median(implied)), cx, hw, hh


def canonicalise(img):
    """Cut the tile's outline back to a mathematically clean diamond.

    The generator draws grass blades, snow lumps and stray pixels ABOVE the top
    surface's edge. Recolouring preserves that silhouette, so a plateau's outline
    inherits every spike and reads as a wobbly line instead of a straight one — which is
    exactly what the maintainer kept seeing. Measured over 433 grass tiles: 34% have
    pixels past the clean edge, up to 47 on the worst.

    Clipping them is free here in a way it would not be on a textured tile, because the
    top is about to be overwritten with one flat colour anyway. Nothing of the material
    is lost: the blades were never going to survive the fill. Notches (transparent
    pixels INSIDE the clean edge, the same defect pointing the other way) are filled
    from the column below for the same reason.

    The result is that every tile has an IDENTICAL outline, so tiles meet exactly and
    the edge is the ideal rasterisation of the slope rather than the generator's
    approximation of it.
    """
    a = np.asarray(img.convert("RGBA")).astype(float)
    op = a[:, :, 3] > 128
    if not op.any():
        return img.convert("RGBA")
    ay, cx, hw, hh = _diamond(a)
    h, w = a.shape[:2]
    out = a.copy()
    xs = np.where(op.any(0))[0]
    for x in xs:
        edge = int(round(ay + np.floor(hh * abs(x - cx) / hw)))
        col = np.where(op[:, x])[0]
        first = int(col.min())
        if first < edge:                       # spike: cut back to the clean edge
            out[first:edge, x, 3] = 0
        elif first > edge:                     # notch: extend up to the clean edge
            out[edge:first, x, :3] = a[first, x, :3]
            out[edge:first, x, 3] = 255
    return Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGBA")


def refine_interface(a, reg, band=3):
    """Let the grass/wall boundary keep the material's OWN shape.

    The geometric split is right for the interior of each surface and wrong at the seam
    between them. A real 'grass over soil' tile has grass tufting down over the edge and
    soil poking up into it; forcing a straight mathematical line there produces 'green
    over soil' — a colour lying on top of a material instead of one material growing out
    of another. Measured: the raw art carries a boundary raggedness of 0.4 to 1.5 px and
    up to 16 pixels of overhanging tuft, and the geometric line flattens both to exactly
    zero.

    So within `band` rows of the boundary, and ONLY there, each pixel is assigned by
    colour: closer to the top material's median, it is top; closer to the wall's, it is
    wall. This is the inference tiles2 got wrong for months, which is why it is fenced in
    hard — it runs in a 3px band around a boundary already known geometrically, between
    exactly two candidate colours measured from this tile. It cannot wander off into the
    flowers or the fire, because it never looks anywhere else.

    The interior is untouched, so the top stays a clean single colour. Only the seam
    moves, which is the whole point: clean surface, interesting transition.
    """
    rgb = a[:, :, :3]
    op = a[:, :, 3] > 128
    top, left, right = reg["top"], reg["left"], reg["right"]
    wall = left | right
    if top.sum() < 50 or wall.sum() < 50:
        return reg
    # medians taken AWAY from the seam, so the reference colours are not themselves
    # contaminated by the transition we are trying to resolve
    _, xs = np.mgrid[0:a.shape[0], 0:a.shape[1]]
    ox = np.where(op.any(0))[0]
    cx = (int(ox.min()) + int(ox.max())) / 2.0

    bnd = np.zeros_like(top)
    for x in range(a.shape[1]):
        t = np.where(top[:, x])[0]
        if len(t):
            tb = int(t.max())
            bnd[max(0, tb - band + 1):tb + band + 1, x] = True

    core_t = top & ~bnd
    if core_t.sum() < 30:
        return reg
    tmed = np.median(rgb[core_t], 0)
    dt = np.abs(rgb - tmed).sum(2)

    out = {"top": top.copy(), "left": left.copy(), "right": right.copy()}
    for face, side in (("left", xs <= cx), ("right", xs > cx)):
        core = reg[face] & ~bnd
        if core.sum() < 20:
            continue
        sel = bnd & op & side & (reg[face] | top)
        if not sel.any():
            continue
        dw = np.abs(rgb - np.median(rgb[core], 0)).sum(2)
        out["top"] = (out["top"] & ~sel) | (sel & (dt <= dw))
        out[face] = (out[face] & ~sel) | (sel & (dt > dw))
    return out


def _rgb2hsv(px):
    return np.asarray(Image.fromarray(px.clip(0, 255).astype(np.uint8)[None, :, :], "RGB")
                      .convert("HSV"), dtype=float)[0]


def _hsv2rgb(px):
    return np.asarray(Image.fromarray(px.clip(0, 255).astype(np.uint8)[None, :, :], "HSV")
                      .convert("RGB"), dtype=float)[0]


def profile(ref_path, surface="left"):
    """Measure what a material's surface ACTUALLY looks like, from an approved
    reference tile of that type.

    The reference tile is the definition of the type — it is the one the maintainer
    approved as 'this is how light_soil looks'. So the conversion target is taken from
    it rather than from hand-picked constants: hue and saturation say what colour the
    material is, and the luminance SPREAD says how cracked or smooth its cliff face is.
    That spread is what separates black_rock from dark_mud once both are dark and
    brownish — without it, converting the same tile toward either target would differ
    only in tint and both would come out as the same texture wearing different paint.

    Returns a dict consumable by snap(); None if the reference has no such surface.
    """
    a = np.asarray(Image.open(ref_path).convert("RGBA")).astype(float)
    reg = _regions(a)
    if not reg or not reg.get(surface) is not None:
        return None
    m = reg[surface]
    if m.sum() < 25:
        return None
    hsv = _rgb2hsv(a[:, :, :3][m])
    v = hsv[:, 2]
    return {
        "hue": float(np.median(hsv[:, 0])),
        "sat": float(np.median(hsv[:, 1])),
        "value": float(v.mean()),
        # relative spread, so it transfers to a surface of any brightness
        "spread": float(v.std() / (v.mean() or 1.0)),
        "source": ref_path,
    }


def _apply_profile(px, prof, lighting=1.0, shift_value=False):
    """Recolour a surface to the palette WITHOUT relighting it.

    The postprocess exists to align colour. It is not a lighting pass, and every step
    beyond recolouring damages the art: an earlier version rescaled the wall's mean
    brightness to a target and applied a contrast gain, which brightened a stone wall
    by +29 and +41 luminance, amplified its variation (std 23.7 -> 27.5 and 36.4 ->
    44.9) and erased the dark band the generator had drawn under the grass. Amplified
    contrast on a stone pattern reads as harsh zigzag rather than rock.

    So only HUE and SATURATION move. The value channel — which carries the material's
    entire shading, relief and shape-reading — is left exactly as generated. That keeps
    the tile looking like the art PixelLab produced, in the palette's colour.

    `shift_value` is available for the rare case where a material's brightness is
    genuinely wrong rather than merely different, and it applies a flat OFFSET rather
    than a rescale, so texture contrast is carried across unchanged.
    """
    hsv = _rgb2hsv(px)
    hsv[:, 0] = prof["hue"]
    hsv[:, 1] = prof["sat"]
    if shift_value:
        v = hsv[:, 2]
        hsv[:, 2] = np.clip(v + (prof["value"] * lighting - float(v.mean())), 0, 255)
    return _hsv2rgb(hsv)


def wrap_wall(img, band=6, strength=1.0):
    """Make the wall texture continuous across the tile's own left/right edge.

    A cliff is built from many copies of ONE tile, and along a plateau's front edge
    consecutive tiles sit exactly one tile-width apart horizontally. So the wall repeats
    with period = tile width, and whatever discontinuity exists between column 0 and
    column W-1 becomes a hard vertical line at every tile boundary, repeated across the
    whole rock face — measured on a 4x4 plateau: 34 columns with a luminance jump above
    12, peaking at 59.8.

    Fixing it is a wrap, not a blur: the first `band` columns are cross-faded with the
    columns that will actually abut them (the last `band`), weighted so the seam itself
    gets the most correction and the tile's interior is left alone. The top surface is
    untouched — it is already flat and seamless after the palette snap.
    """
    a = np.asarray(img.convert("RGBA")).astype(float)
    reg = _regions(a)
    if not reg:
        return img.convert("RGBA")
    wall = reg["left"] | reg["right"]
    if not wall.any():
        return img.convert("RGBA")
    h, w = a.shape[:2]
    out = a.copy()
    for i in range(band):
        wgt = strength * (1.0 - i / float(band)) * 0.5
        li, ri = i, w - 1 - i
        for src, dst in ((ri, li), (li, ri)):
            m = wall[:, dst] & wall[:, src]
            if not m.any():
                continue
            out[m, dst, :3] = (a[m, dst, :3] * (1 - wgt) + a[m, src, :3] * wgt)
    return Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGBA")


def middle_floor(img, band=4):
    """Derive the tile used for every floor BELOW the top of a cliff.

    A cliff is one tile stacked N high, so the wall repeats vertically and any
    discontinuity between the strip's first and last row becomes a hard line at every
    storey. Measured on a 4-storey stack, the join rows step 1.2x to 1.9x harder than
    the texture's own row-to-row variation.

    The cause is not the texture, it is END-OF-BLOCK LIGHTING. Measuring mean luminance
    by depth into the wall shows the generator draws a lit rim on the top row (+22 on
    grey_stone, +35 on paving_stone) and an occlusion falloff over the last three rows
    (-18, -36, -44). Stacked, the dark base of one block meets the bright rim of the next
    and that IS the line. Cross-fading the two ends together does not fix it — measured,
    it moved 1.6x to 1.5x and made light_soil worse — because averaging a dark edge with
    a bright one leaves a band either way.

    A middle floor has no ends, so it should carry neither. This removes the systematic
    profile: for each depth within `band` of an end, the mean deviation from the strip's
    interior is measured across all columns and subtracted. Because the correction is one
    constant per depth, every pixel's deviation from its row — the actual rock texture —
    survives untouched; only the banding goes.

    The CAP tile keeps its shading. That is what makes ground read as sitting on rock,
    and it is correct exactly once, at the top.

    The two faces are corrected SEPARATELY. The generator lights them differently on
    purpose — that difference is what makes a tile read as a solid block — and it applies
    to the end effects too: on grey_stone the left face's rim is +43 and its base -34,
    while the right face's rim is +1 and its base -53. Averaging the two into one profile
    corrects neither, which is what a first attempt at this did.
    """
    a = np.asarray(img.convert("RGBA")).astype(float)
    reg = _regions(a)
    if not reg:
        return img.convert("RGBA")
    lum = lambda p: 0.299 * p[..., 0] + 0.587 * p[..., 1] + 0.114 * p[..., 2]
    L = lum(a[:, :, :3])
    out = a.copy()

    for face in ("left", "right"):
        wall = reg[face]
        strips = {}
        for x in range(a.shape[1]):
            rows = np.where(wall[:, x])[0]
            if len(rows) >= band * 2 + 2:
                strips[x] = (int(rows.min()), int(rows.max()))
        if not strips:
            continue
        mid = float(np.mean(np.concatenate(
            [L[r0 + band:r1 - band + 1, x] for x, (r0, r1) in strips.items()])))
        top_dev = [float(np.mean([L[r0 + d, x] for x, (r0, _) in strips.items()])) - mid
                   for d in range(band)]
        bot_dev = [float(np.mean([L[r1 - d, x] for x, (_, r1) in strips.items()])) - mid
                   for d in range(band)]
        for x, (r0, r1) in strips.items():
            for d in range(band):
                for row, dev in ((r0 + d, top_dev[d]), (r1 - d, bot_dev[d])):
                    out[row, x, :3] = np.clip(a[row, x, :3] - dev, 0, 255)
    return Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGBA")


def snap(img, top_hex, side_hex, keep_wall_texture=True, side_profile=None):
    """Align a tile to the palette. The two surfaces are treated DIFFERENTLY on purpose.

    TOP — overwritten with a single flat colour. That is the whole point of the base
    tile: a featureless fill has nothing for the eye to lock onto, so an arbitrarily
    large field of it shows no visible repeat.

    WALLS — recoloured but NOT flattened. The walls are not decoration; they are every
    cliff and mountain face in the game, so they have to keep reading as the material
    (rock looks like rock, soil like soil). Flattening them produced clean but dead
    cardboard-looking cliffs. So the wall keeps its own luminance detail and only its
    HUE and SATURATION are forced to the palette, with the brightness RESCALED so the
    mean lands on the palette colour while the texture's contrast survives around it.

    The left/right lighting difference is preserved either way — the generator lights
    the two faces differently, and that is what makes a tile read as a solid block
    rather than a sticker.

    The outline is canonicalised FIRST, so the flat fill lands on a clean diamond rather
    than on the generator's spiky approximation of one.
    """
    a = np.asarray(canonicalise(img)).astype(float)
    reg = _regions(a)
    if reg:
        reg = refine_interface(a, reg)
    if not reg:
        return img.convert("RGBA")
    out = a.copy()
    top = _hex(top_hex)
    side = _hex(side_hex)
    side_hsv = _rgb2hsv(side[None, :])[0]

    lum = {}
    for k in ("left", "right"):
        m = reg[k]
        lum[k] = float(a[:, :, :3][m].mean()) if m.sum() > 20 else None
    if lum["left"] and lum["right"]:
        mean = (lum["left"] + lum["right"]) / 2.0 or 1.0
        fac = {k: lum[k] / mean for k in ("left", "right")}
    else:
        fac = {"left": 0.86, "right": 1.10}

    if reg["top"].sum():
        out[:, :, :3][reg["top"]] = np.clip(top, 0, 255)

    for k in ("left", "right"):
        m = reg[k]
        if not m.sum():
            continue
        px = a[:, :, :3][m]
        if not keep_wall_texture:
            out[:, :, :3][m] = np.clip(side * fac[k], 0, 255)
            continue
        # With a reference profile we match the target material's own colour AND
        # surface contrast; without one we fall back to the palette hex, which can
        # only carry colour. The profile is what makes converting the same tile
        # toward black_rock and toward dark_mud produce genuinely different cliffs
        # rather than one texture in two tints.
        prof = side_profile or {"hue": float(side_hsv[0]), "sat": float(side_hsv[1]),
                                "value": float(side_hsv[2]), "spread": None}
        out[:, :, :3][m] = _apply_profile(px, prof, lighting=fac[k])

    out[:, :, 3] = a[:, :, 3]
    return Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGBA")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--top", required=True)
    ap.add_argument("--side", required=True)
    ap.add_argument("--flat-walls", action="store_true",
                    help="also flatten the walls (normally they KEEP their material texture)")
    args = ap.parse_args()
    im = snap(Image.open(args.src), args.top, args.side, keep_wall_texture=not args.flat_walls)
    im.save(args.dst)
    f = flatness.faces(args.dst)
    for k in ("top", "left", "right"):
        if f and f[k]:
            print(f"  {k:6s} share={f[k]['share']:.3f} rgb={f[k]['median']}")


if __name__ == "__main__":
    main()
