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


def _lum_of(px):
    """Rec.601 luminance. Works on a single RGB triple or an (N,3) array."""
    px = np.asarray(px, float)
    return 0.299 * px[..., 0] + 0.587 * px[..., 1] + 0.114 * px[..., 2]


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


SPILL_SPREAD = 16.0     # tiles2 grass measures value std 16.2 — the look being matched


def retint_spill(a, reg, top_hex, hue_tol=22, sat_floor=30, guard=12,
                 max_frac=0.50, max_depth=0.34):
    """Pull the TOP material's overhanging blades to the palette, and nothing else.

    The tufts that fall over the edge are the best thing about these tiles, and they sit
    in the WALL region — which snap() deliberately never touches. That was right while
    the palette came from the generator, because the blades already matched the top. It
    broke the moment the palette moved to the game's own colour: the surface became deep
    pine and the blades stayed the raw bright green, +47 to +103 too bright, glaring
    along every edge.

    So the blades move with the surface they grow from. Selection is by HUE against the
    top's own median, measured from this tile, which is safe here for a reason worth
    stating: this is the same colour inference that went wrong in tiles2, and it went
    wrong there by hunting a whole image for a material. Here the candidate set is one
    region, the reference is measured from the tile itself, and the whole thing is
    skipped when the wall's hue is within `guard` of the top's — grass over grass or over
    slime cannot be separated by hue, so it is not attempted.

    Value is REMAPPED, not preserved: the blades keep their relative light and shade but
    land on the palette's brightness, with their spread compressed to tiles2's own
    (std 16.2 on real grass). Compressed only, never amplified — stretching contrast to
    hit a target is what turned a stone wall into zigzag earlier in this pipeline.
    """
    wall = reg["left"] | reg["right"]
    if not wall.any() or not reg["top"].any():
        return None
    rgb = a[:, :, :3]
    tref = _rgb2hsv(np.median(rgb[reg["top"]], 0)[None, :])[0]
    wref = _rgb2hsv(np.median(rgb[wall], 0)[None, :])[0]
    sep = abs(float(wref[0]) - float(tref[0]))
    sep = min(sep, 255.0 - sep)
    if sep <= guard:
        # Only a floor for the truly indistinguishable. It used to sit at 25 and that
        # was too high: grass over slime separates by exactly 25.0 and got skipped, so
        # its fringe kept the old bright green while everything around it moved. DEPTH
        # is what guards the same-material case now, and it does it on geometry rather
        # than on a hue threshold that has to be tuned per pair.
        return None

    hsv = _rgb2hsv(rgb[wall])
    # NEAREST OF TWO REFERENCES, not a window around one. A blade is not a single hue:
    # the generator draws the fringe across a wide range, and where it meets the rock it
    # blends further. A hue window sized to catch the core misses the rest — measured on
    # a retinted tile, pixels at 24 and 43 hue units from the top's median survived as
    # #358139 and #2b6648, bright yellow-greens sitting on a deep pine surface, which is
    # exactly what the maintainer circled. Widening the window instead would start
    # swallowing the wall.
    #
    # So ask the only question that actually matters: is this pixel closer to the TOP
    # material or to the WALL material? Both references come from this tile. The wall's
    # is taken from its LOWER 60%, which is wall by construction and cannot be polluted
    # by the fringe being classified.
    ys_w, xs_w = np.where(wall)
    lowref = []
    for x in np.unique(xs_w):
        col = np.where(wall[:, x])[0]
        lo = int(col.min()) + int(0.4 * (int(col.max()) - int(col.min())))
        lowref.extend(rgb[lo:int(col.max()) + 1, x])
    if len(lowref) < 20:
        return None
    wmat = _rgb2hsv(np.median(np.array(lowref), 0)[None, :])[0]
    _COLTOP = {}
    for x in np.unique(xs_w):
        col = np.where(wall[:, x])[0]
        _COLTOP[x] = (int(col.min()), max(1, int(col.max()) - int(col.min())))

    # Compare in HUE, not in RGB. A blade in shadow is dark but still green, and RGB
    # distance is dominated by brightness: #2f6b33 — a shaded grass pixel — sits closer
    # to brown wood than to lit grass, so an RGB nearest-reference test hands it to the
    # wall and it survives as a stray green. Measured, that left 147 such pixels on
    # parquet_floor alone. Hue is what the two materials actually differ by.
    #
    # Near-grey pixels carry no reliable hue, so anything below the saturation floor is
    # left to the wall rather than guessed at.
    dt = np.abs(hsv[:, 0] - tref[0]); dt = np.minimum(dt, 255.0 - dt)
    dw = np.abs(hsv[:, 0] - wmat[0]); dw = np.minimum(dw, 255.0 - dw)
    # COLOURFULNESS, NOT SATURATION. The saturation floor is a ratio, so near-black
    # pixels sail over it: a bottom-edge outline pixel at value 50 and saturation 35 has
    # colourfulness 7 — no colour a person can see — but its noise-hue can land nearer
    # green than the rock's, and the retint then painted it FULL grass. The maintainer
    # circled the result on grass over black_rock: "At the very bottom edge it looks
    # like you have invented green pixels. The before image had a black border at the
    # bottom." 14 of 47 tiles in that cell carried them. A real blade in shadow keeps
    # colourfulness ~47+ (#2f6b33 measures 60), so the floor costs nothing it protects.
    cf = hsv[:, 1] * hsv[:, 2] / 255.0
    sel = (dt < dw) & (cf > 14.0)
    # max_frac is only a backstop against a pathological selection. DEPTH is the real
    # test — a large fringe is still a fringe, and capping on size skipped snow at 31%
    # and water at 34% whose depths were 0.19 and 0.16, i.e. hugging the top exactly as
    # a fringe does.
    if sel.sum() < 8 or sel.mean() > max_frac:
        return None
    # A spill is a FRINGE: it hugs the top of the wall, while the wall's own material
    # fills the strip. That difference is GEOMETRIC, and it is the only thing that
    # separates the two when both are the same colour family — hue cannot, since grass
    # over grass separates from its wall by 31 and grass over ice by 34. Measured across
    # the matrix, every genuine fringe sits at depth 0.06-0.13 and slime's green wall at
    # 0.50. Without this a green wall gets repainted as grass.
    depth = np.array([(y - _COLTOP[x][0]) / _COLTOP[x][1] for y, x in zip(ys_w, xs_w)])
    if float(depth[sel].mean()) > max_depth:
        return None
    tgt = _rgb2hsv(_hex(top_hex)[None, :])[0]
    v = hsv[sel, 2]
    scale = min(1.0, SPILL_SPREAD / float(v.std() or SPILL_SPREAD))
    hsv[sel, 0] = tgt[0]
    hsv[sel, 1] = tgt[1]
    hsv[sel, 2] = np.clip(float(tgt[2]) + (v - v.mean()) * scale, 0, 255)
    out = rgb.copy()
    idx = np.where(wall)
    out[idx[0], idx[1]] = _hsv2rgb(hsv)
    m = np.zeros(wall.shape, bool)
    m[idx[0][sel], idx[1][sel]] = True
    return out, m



def _chroma(rgb):
    """(x, y, value) with hue and saturation as a VECTOR, so grey sits at the origin.

    Brightness is the thing that has to stop dominating: on the 0-255 RGB cube a light grey
    rock is nearer to teal water than to its own material's darker wall colour, purely
    because the two are similar in luminance. Laid out as a chroma vector, grey is at the
    origin and teal is far from it, and no amount of lighting moves one onto the other.

    Value is kept, at a fraction of its weight, because two near-grey materials (snow over
    grey_stone, black_rock over grey_stone) have no chroma to separate them and brightness
    is then the only real signal.
    """
    hsv = _rgb2hsv(np.asarray(rgb, float).reshape(-1, 3))
    ang = hsv[:, 0] * (2 * np.pi / 256.0)
    return np.stack([hsv[:, 1] * np.cos(ang), hsv[:, 1] * np.sin(ang), hsv[:, 2]], 1)


CHROMA_VALUE_WEIGHT = 0.35

# A textured top keeps more relief than a wall fringe does: the grain IS the material.
TEXTURED_TOP_SPREAD = 26.0

# Below this the two clusters are one material and the boundary is noise. In CHROMA units
# (see _chroma_dist), not RGB — measured across 182 cells the genuinely-one-material pairs
# (light_soil/light_beach, paving_stone/grey_stone, grey_stone/snow) sit at 23-27 while the
# median cell separates by 135.
# Whitening: an axis may never be weighted harder than 1/WHITEN_STD_FLOOR — a perfectly
# flat wall must not turn a 2-unit difference into a chasm.
WHITEN_STD_FLOOR = 8.0
# Clusters closer than this many wall-noise units are one material split by noise.
MIN_SPLIT_SIGMA = 2.5
# A pixel connected to the top face is overhang if its top-distance is within this
# factor of its wall-distance — lenient, because connectivity carries the rest.
GROW_RATIO = 1.6
# The lean when the wall repaint is disabled anyway (unconfirmed wall) — see _split_wall.
GROW_RATIO_UNCONFIRMED = 2.6
# A wall-classified pixel further than this from the wall's own median value is an alien
# (a rock crumb on a beach wall) and ships raw rather than being recentred to the wall.
SIDE_VALUE_BAND = 75.0


def _chroma_dist(px, target):
    c = _chroma(px)
    t = _chroma(np.asarray(target, float)[None, :])[0]
    return np.sqrt(((c[:, :2] - t[:2]) ** 2).sum(1)
                   + (CHROMA_VALUE_WEIGHT * (c[:, 2] - t[2])) ** 2)


def _split_wall(a, reg, wall_all, side_hex=None, aggressive=False, claim_depth=None,
                deep_claim=None, drip_match=None):
    """Which wall pixels are the SIDE material and which are the TOP material spilling over.

    THE BUG THIS REPLACES, in the maintainer's words:

        "The 'water over grey_stone' postprocessing you posted looks really fu*ked up. Why
         did your postpy destroy the rock under the water? The rock almost already had
         correct color and you totally destroyed it."

    Measured on that tile: 81.7% of a rock wall was classified as WATER and painted teal.
    The rock was not ambiguous — it was light grey (#7c8793) and the water is teal — but the
    old test compared raw RGB distance against the two PALETTE colours, and grey_stone's
    palette wall is dark (#45474b). In RGB, brightness swamps everything, so light grey rock
    measured 77 from teal water and 113 from its own material. The classifier was answering
    "which palette colour is this pixel closest to in brightness", which is not the question.

    Two changes, and both are needed:

      OWN COLOURS, NOT PALETTE COLOURS. The palette says what a material SHOULD look like;
      the tile says what the generator actually drew, and those differ a lot (3.0's grass is
      a bright yellow-green, the palette's is a deep pine). The top face is unmixed top
      material and is right there in the same image, so seed from it and from the wall's own
      median — a median because the spill is a minority and a median ignores minorities.
      Same routine as reference.derive_wall(), which found the grass overhang on the
      deep_water reference cleanly.

      CHROMA, NOT RGB. See _chroma(). This is not the hue-off-a-median inference that
      shipped magenta, vivid and red walls: nothing here reads a colour to shift BY. It
      picks which of two fixed palette targets each pixel is substituted onto, and
      substitute() still sets hue and saturation from the palette and reads nothing.

    Measured over 203 tiles whose wall was independently CONFIRMED to be the side material
    (wall_err <= 10 going in), by how far the wall lands from its own material afterwards:

        palette + RGB    (before)   mean  4.2   7 tiles over MAX_WALL_ERR   worst 67.0
        palette + chroma            mean  1.9   2 tiles over               worst 37.0
        own colours + RGB           mean  3.1   5 tiles over               worst 51.0
        own colours + chroma (this) mean  1.6   0 tiles over               worst 28.0

    Zero is the number that matters: no wall that went in as its own material comes out
    failing to be its own material.
    """
    rgb = a[:, :, :3]
    px = rgb[wall_all]
    if len(px) < 40 or reg["top"].sum() < 40:
        return wall_all, np.zeros(wall_all.shape, bool)
    seed_top = np.median(rgb[reg["top"]], 0)

    # ONE METRIC, WHITENED BY THE WALL'S OWN NOISE. Three attempts preceded this and
    # each shipped a visible bug on the pair it was wrong for:
    #
    #   RGB is dominated by brightness: 81.7% of a light-grey rock wall handed to teal
    #   water (they differ in HUE; RGB barely looks at it).
    #
    #   CHROMA damps brightness by a fixed 0.35: on dark_mud over light_beach — same hue
    #   family, separated almost purely by VALUE — it repainted the mud overhang bright
    #   beach ("the top of the right wall is bright as if you see it as light_beach, but
    #   it's part of the dark_muds overhang").
    #
    #   PICKING between them from the seeds fixed mud/beach and broke ice over
    #   paving_stone the same day ("You improved it, but this particular one got worse"):
    #   the seeds differ by 100 in RGB, so the rule chose brightness — but PAVING'S OWN
    #   BRIGHTNESS SPREAD is 42, lighting and texture, so nearness-in-brightness to the
    #   pale ice seed swept lit grey pixels into the ice cluster and painted them cyan.
    #
    # The lesson of all three: no fixed weighting of [hue, saturation, value] is right,
    # because which axis is RELIABLE depends on the wall in front of you. So weight each
    # axis by the reciprocal of the wall cluster's own spread on it, re-estimated as the
    # cluster converges. A wall with wild lighting discounts value automatically (rock,
    # paving); a wall that is flat and bright keeps value sharp, which is exactly where
    # value separates mud from beach. Nothing is inferred from the art but variances,
    # and a variance cannot pick a wrong colour — the failure mode of everything above.
    def _feat(q):
        # COLOURFULNESS, NOT SATURATION. HSV saturation is a ratio, so at low value a
        # huge sat difference is a tiny pixel difference: the mud top (#45423f, sat 22)
        # and the mud drips (#473e35, sat 65) differ by 43 in saturation and by ELEVEN
        # in RGB — they are the same paint. Classifying on sat kept finding the drips
        # "far" from their own material, whatever the whitening did. Scaling the chroma
        # vector by value/255 turns it into absolute colourfulness (opponent-colour
        # axes), where those two are 12 apart and beach is properly distant.
        hsv = _rgb2hsv(np.asarray(q, float).reshape(-1, 3))
        ang = hsv[:, 0] * (2 * np.pi / 256.0)
        c = hsv[:, 1] * hsv[:, 2] / 255.0
        return np.stack([c * np.cos(ang), c * np.sin(ang), hsv[:, 2]], 1)

    # THE NOISE IS ESTIMATED WHERE THE SPILL CANNOT BE. Whitening by the wall's own
    # spread is circular if the estimate includes the overhang: on mud-over-beach the
    # drips inflated the wall's VALUE variance, which discounted value, which is the one
    # axis separating mud from beach — the misclassification manufactured its own
    # justification, and the count got WORSE than the bug (339 against 172). The
    # overhang hangs from the top edge (measured: rows 1-6 below it), so the BOTTOM
    # HALF of each wall column is pure side material: anchors and spreads come from
    # there. The top face plays the same role for the top material — each anchor is
    # whitened by its own population's noise, which is just Mahalanobis distance with
    # a diagonal covariance and a floor.
    h_img, w_img = wall_all.shape
    ys_all = np.arange(h_img)[:, None]
    wy_min = np.where(wall_all, ys_all, h_img).min(0)
    wy_max = np.where(wall_all, ys_all, -1).max(0)
    deep = wall_all & (ys_all >= (wy_min + wy_max)[None, :] / 2.0)
    if deep.sum() < 50:
        deep = wall_all
    deep_px = rgb[deep]
    # WHEN THE CURTAIN REACHES THE FLOOR, EVEN THE DEEP HALF IS SPILL. On dark_mud over
    # paving_stone the maintainer's "redish overhang doesn't change color" tiles have
    # drips covering 44-48% of the deep half — enough to drag even a MEDIAN anchor onto
    # the mud, after which the drips measure close to "the wall" and ship raw. ("Do you
    # think that redish brown is paving stone or what! Paving stone is usually grey.")
    #
    # The palette knows what the side material looks like, so it picks WHICH deep pixels
    # to learn the wall from — nothing more. Classification still runs entirely on the
    # tile's own colours; the palette never becomes the target (that inference is the
    # classifier's original sin). If the palette matches too few pixels (a material the
    # generator draws far from its palette, like 3.0 grass), fall back to the plain deep
    # half — the old behaviour, not a new failure.
    if side_hex is not None:
        near = np.linalg.norm(deep_px - _hex(side_hex).astype(float), axis=1) < 75.0
        if near.sum() >= 50:
            deep_px = deep_px[near]
    F = _feat(px)
    Fd = _feat(deep_px)
    Ft = _feat(rgb[reg["top"]])
    # MEDIAN AND MAD, NOT MEAN AND STD. The deep half is *usually* pure side material,
    # but a tile with long drips (mud-over-beach #12 — the very tile in the report) has
    # spill all the way down, and a mean/std anchor drifts toward it: 446 mud pixels
    # handed to beach, worse than the bug. A median ignores a 40% minority and the MAD
    # ignores it in the spread, so the anchor stays on the material even when the spill
    # reaches deep.
    fw = np.median(Fd, 0)
    ft = np.median(Ft, 0)
    sw = 1.0 / np.maximum(1.4826 * np.median(np.abs(Fd - fw), 0), WHITEN_STD_FLOOR)
    st = 1.0 / np.maximum(1.4826 * np.median(np.abs(Ft - ft), 0), WHITEN_STD_FLOOR)
    # THE TOP ANCHOR'S VALUE TOLERANCE IS THE WALL'S, NOT ITS OWN. The top face is flat
    # and evenly lit, so its own value spread is tiny — but its material arrives on the
    # wall RE-LIT: an ice drape is shaded ice. Whitening the top-distance's value axis
    # by the top's own tiny spread made shaded ice measure "far from ice" and the drape
    # was painted paving grey ("The tile to the right now lost it's blue on both
    # sides!"). Chroma noise is a property of the MATERIAL, measured on the top face;
    # value noise is a property of the LIGHTING, measured where the pixel actually is —
    # the wall.
    st[2] = sw[2]
    d_w = np.linalg.norm((F - fw) * sw, axis=1)
    d_t = np.linalg.norm((F - ft) * st, axis=1)
    keep = d_w <= d_t
    if keep.sum() < 20:
        keep = np.ones(len(px), bool)
    else:
        # THE OVERHANG HANGS. That is the information the colour test cannot see and the
        # maintainer's eye uses without thinking: on dark_mud over paving_stone the
        # shaded drips (#4f4036) and the shaded deep stones (#52504d) are near-twins in
        # colour, and 539 of 719 drip pixels shipped raw ("Can't you see the redish
        # overhang doesn't change color? Do you think that redish brown is paving stone
        # or what!"). But the drips are CONNECTED to the top face and the stones are
        # not. So a pixel that merely LEANS toward the top material (d_t within
        # GROW_RATIO of d_w) is claimed as overhang iff it is 4-connected to the top
        # edge through other such pixels. A bright stone fails the lean and breaks the
        # chain; an isolated muddy patch deep in the wall has no chain to break.
        lean = np.zeros(wall_all.shape, bool)
        idx0 = np.where(wall_all)
        # When the wall is UNCONFIRMED, its repaint is already disabled and the only
        # writer on this wall is the overhang alignment — so the cost of over-claiming
        # is bounded to pixels that would otherwise ship raw, and the lean can afford to
        # be generous. On the confirmed pairs where generosity is dangerous (black rock
        # over grey stone would hand 72% of the stones to the overhang at this ratio)
        # the wall IS confirmed, so they keep the strict ratio. Measured: this takes the
        # mud-over-paving drip recovery from 36-39% to ~65-68% without moving a single
        # battery cell that has a confirmed wall.
        ratio = GROW_RATIO_UNCONFIRMED if aggressive else GROW_RATIO
        lean[idx0[0], idx0[1]] = d_t <= d_w * ratio
        strict = np.zeros(wall_all.shape, bool)
        strict[idx0[0], idx0[1]] = ~keep
        ys2 = np.arange(h_img)[:, None]
        y_top = np.where(reg["top"], ys2, -1).max(0)
        seedrow = np.zeros(wall_all.shape, bool)
        for dy in (1, 2):
            yy = np.clip(y_top + dy, 0, h_img - 1)
            cols = y_top >= 0
            seedrow[yy[cols], np.arange(w_img)[cols]] = True
        # EVERY CLAIM MUST HANG. The first version used connectivity only to EXPAND the
        # colour-based claims, never to test them — so a grey stone stud deep in a mud
        # wall, honestly stone-coloured, was claimed as "overhang" on colour alone and
        # repainted as a flat grey slab ("The top right image on that photo is still
        # not 100% fixed": 118 of 431 claimed pixels sat below half-depth in stud
        # clusters). A depth cap was tried instead and immediately broke the mud
        # curtains over beach, whose genuine overhang passes half-depth. Depth is the
        # wrong test; ATTACHMENT is the thing itself: the flood starts at the top edge
        # and runs through claim-worthy pixels, and whatever it cannot reach — however
        # stone-coloured — is the wall's own texture. Studs are islands; curtains are
        # attached; both facts survive any palette.
        grown = seedrow & (strict | lean)
        reach = strict | lean
        for _ in range(64):
            g2 = grown.copy()
            g2[1:, :] |= grown[:-1, :]
            g2[:-1, :] |= grown[1:, :]
            g2[:, 1:] |= grown[:, :-1]
            g2[:, :-1] |= grown[:, 1:]
            g2 &= reach
            if g2.sum() == grown.sum():
                break
            grown = g2
        if claim_depth is not None:
            # A PER-PAIR DEPTH CAP, for the pairs colour cannot decide. black_rock over
            # ice is the proving case: the generator draws the rock as dark navy and the
            # shaded ice as dark blue, and no metric separates #03101c from #17212f
            # honestly. On such a pair the maintainer sanctioned per-cell tweaks, and
            # the tweak is geometric: this pair's overhang hugs the top edge, so claims
            # below claim_depth of the face are shaded wall, whatever their colour.
            ys3 = np.arange(h_img)[:, None]
            span = np.maximum(1, wy_max - wy_min).astype(float)
            depth = (ys3 - wy_min[None, :]) / span[None, :]
            grown &= depth <= claim_depth
            if deep_claim is not None:
                # THE CAP CUTS DRIPS TOO. On black_rock over grey_stone the cap that
                # stops the flood from swallowing the shaded stones also beheads the
                # three clearly-black drips that hang past it — and the wall repaint
                # then turned them grey ("it feels like they didn't turn near-black").
                # Colour separates what depth cannot: measured on that tile, the drip
                # pixels sit at d_t/d_w 0.29-0.65 in the whitened space while the
                # stones the cap exists to protect sit at 1.49. So below the cap a
                # pixel is claimed iff it is STRONGLY the top colour (within deep_claim
                # of the wall distance) AND still reachable from the capped claims
                # through strong-or-shallow pixels — the re-flood keeps "every claim
                # must hang" true, so an honestly-black stud deep in the wall stays
                # the wall's own texture exactly as before.
                strong = np.zeros(wall_all.shape, bool)
                strong[idx0[0], idx0[1]] = d_t <= d_w * float(deep_claim)
                reach2 = reach & ((depth <= claim_depth) | strong)
                for _ in range(64):
                    g2 = grown.copy()
                    g2[1:, :] |= grown[:-1, :]
                    g2[:-1, :] |= grown[1:, :]
                    g2[:, 1:] |= grown[:, :-1]
                    g2[:, :-1] |= grown[:, 1:]
                    g2 &= reach2
                    if g2.sum() == grown.sum():
                        break
                    grown = g2
        if drip_match is not None:
            # THE MAINTAINER'S DEFINITION, IMPLEMENTED LITERALLY: "What is the
            # overhang? It has the same damn color as you can find on the top/ground.
            # AND it connects to the top (in this case we have an edge highlight so
            # it doesn't connect unless you jump over that highlight 1 pixel)."
            #
            # Same colour: the rock's paint is COOL (blue >= red, traced down the
            # drape the maintainer painted out: (38,37,39), (23,23,26), (9,10,13),
            # (0,0,1)) and the mud is WARM ((38,33,29), (56,50,49)) — brightness-
            # independent, so the drape's darks cannot be confused with brown.
            # Connected: a flood from the already-attached claims through cool-paint
            # pixels, allowed to jump ONE pixel straight down — the drawn edge
            # highlight — when cool paint continues beneath it.
            #
            # This pairs with raw_wall: the claims turn near-black and EVERYTHING
            # else on the wall ships exactly as drawn ("The brown should not change
            # in any shape or form!"). Six versions that also repainted the wall each
            # manufactured a new artifact out of a misclassified pixel; a raw wall
            # has nothing to manufacture with.
            top_rgb = np.median(rgb[reg["top"]], 0)
            top_v = float(top_rgb.max())
            match = np.zeros(wall_all.shape, bool)
            match[idx0[0], idx0[1]] = ((px[:, 0] - px[:, 2] <= float(drip_match))
                                       & (px.max(axis=1) <= top_v + 25.0))
            for _ in range(64):
                g2 = grown.copy()
                g2[1:, :] |= grown[:-1, :]
                g2[:-1, :] |= grown[1:, :]
                g2[:, 1:] |= grown[:, :-1]
                g2[:, :-1] |= grown[:, 1:]
                g2[2:, :] |= grown[:-2, :]  # the 1-px jump over the edge highlight
                g2 &= match
                g2 |= grown
                if g2.sum() == grown.sum():
                    break
                grown = g2
            # THE EDGE HIGHLIGHT BELONGS TO THE ROCK, DARKER. The generator draws a
            # bright line where the top rolls into the wall. soften_rim never fires
            # here — it only fades pixels brighter than BOTH surfaces, and this
            # highlight is dim next to the mud. But it is the BLACK ROCK's edge:
            # "The edge highlight must ofc be blended towards the 'clean top color'
            # and in this case the top is black so we need to find the edge highlight
            # and fade it darker, not brighter... it's ok if the highlight is
            # present, we must just make it darker becouse this is black_rock." So
            # the two rows under the top face's edge, where brighter than the paint,
            # are claimed with the overhang: substitution puts them in the rock's
            # hue and the vcap pulls them down to a still-visible, darker highlight.
            ys_r = np.arange(h_img)[:, None]
            v_all = a[:, :, :3].max(axis=2)
            y0_t = np.where(reg["top"], ys_r, -1).max(0)
            for dy_h in (1, 2):
                yy_h = y0_t + dy_h
                ok_h = (y0_t >= 0) & (yy_h < h_img)
                ci = np.where(ok_h)[0]
                pick = wall_all[yy_h[ci], ci] & (v_all[yy_h[ci], ci] > top_v + 10)
                grown[yy_h[ci][pick], ci[pick]] = True
        keep = ~grown[idx0[0], idx0[1]]
    floor_ok = True
    if keep.sum() >= 20 and (~keep).sum() >= 20:
        # In the wall's own noise units: a "spill" cluster closer than this to the wall
        # is the wall, split by noise.
        floor_ok = float(np.linalg.norm((F[~keep].mean(0) - fw) * sw)) >= MIN_SPLIT_SIGMA

    idx = np.where(wall_all)
    m_side = np.zeros(wall_all.shape, bool)
    m_top = np.zeros(wall_all.shape, bool)
    m_side[idx[0][keep], idx[1][keep]] = True
    m_top[idx[0][~keep], idx[1][~keep]] = True
    return m_side, m_top



# --- the rim between ground and wall -----------------------------------------------
#
# The generator draws a lit lip where the top face rolls over into the wall, and the
# maintainer wants it KEPT but quieter:
#
#   "This highlight is good becouse the player can see where is the ground and where
#    is the wall. I just feel this highlight is always a bit to strong and pop out to
#    much. It's almost as if this highlight is glowing. ... Don't get me wrong. I like
#    it in a way becouse you can distinguish ground from wall. It's just to bright at
#    times. ... Some tiles are worse then others. So all tiles doesn't need this fix."
#
# So this is a COMPRESSOR, not an eraser, and it is selective by construction: a rim
# is only touched where it is brighter than BOTH the top colour and the wall body by
# more than RIM_MARGIN, and it keeps RIM_KEEP of the excess, so every rim stays
# brighter than its surroundings — just not glowing. A tile whose rim is already
# reasonable has no pixel over the threshold and comes out bit-identical, which is
# exactly the "all tiles doesn't need this fix" behaviour. Measured on the published
# set: 259 of 574 sampled tiles carry a rim more than 18 over both surfaces; the worst
# (lava over grass) peaks 62 over.
#
# RIM_MAX_DROP stays under no_invention's re-lighting allowance (LUM_TOL 40): this
# darkens pixels in place along their own colour, which is rule 3, and must remain so.
RIM_MARGIN = 18.0     # a rim may be this much brighter than the brighter surface
RIM_KEEP = 0.175      # the fraction of the excess that survives ("soften it twice as much")
RIM_MAX_DROP = 70.0   # never darken further than this
RIM_HUE_TOL = 28.0    # a rim already this close to the top's hue is a highlight of it
RIM_SAT_GREY = 45.0   # below this saturation a glow has no hue identity of its own.
                      # MUST stay under no_invention's SAT_FLOOR (50): the first value,
                      # 60, let a sat-57 olive lip through, and a PARTIAL fade of a
                      # pixel that does still have a hue lands on an in-between hue —
                      # which is the definition of an invented colour (blob 14, caught
                      # on dark_mud over slime).


def dim_edge_highlight(out, a, reg, top_hex):
    """Fade the drawn highlight line at the top edge toward the TOP colour. In place.

    Per-pair opt-in (edge_dim). The maintainer, on black_rock over dark_mud, X-ing
    out a version that repainted the drape: "WHAT WE HAVE IN GAME NOW HAS COLORED THE
    BOTTOM BROWN PERFECTLY ALREADY ... YOU NEED TO ONLY CHANGE THE HIGHLIGHT AT THE
    VERY TOP/EDGE!! THAT IS THE OVERHANG. THAT IS THE PART THAT CONNECTS WITH THE
    TOP/GROUND." So: the two rows of wall directly under the top face's edge, where
    brighter than the top's paint, blend toward the top colour until they sit just
    above it — a highlight that is still present, but dark, because this is black
    rock. soften_rim cannot do this: it only fades pixels brighter than BOTH
    surfaces, and this line is dim next to the mud. Nothing outside those rows is
    touched, which is the entire point.
    """
    top = reg["top"]
    wall = reg["left"] | reg["right"]
    if top.sum() < 100 or wall.sum() < 100:
        return
    h, w = top.shape
    ys = np.arange(h)[:, None]
    y0 = np.where(top, ys, -1).max(0)
    t_rgb = _hex(top_hex).astype(float)
    t_l = 0.299 * t_rgb[0] + 0.587 * t_rgb[1] + 0.114 * t_rgb[2]
    for x in range(w):
        if y0[x] < 0:
            continue
        for dy in (1, 2):
            y = y0[x] + dy
            if y >= h or not wall[y, x]:
                continue
            p = out[y, x, :3].astype(float)
            L = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
            if L <= t_l + 10.0:
                continue
            tgt = t_l + 10.0
            mix = min(1.0, max(0.0, (L - tgt) / max(L - t_l, 1.0)))
            out[y, x, :3] = (p * (1.0 - mix) + t_rgb * mix).astype(out.dtype)


def soften_rim(out, a, reg, top_hex):
    """Compress the glowing lip where the top face meets the wall. In place, on `out`."""
    top = reg["top"]
    wall = reg["left"] | reg["right"]
    if top.sum() < 100 or wall.sum() < 100:
        return
    h, w = top.shape
    ys = np.arange(h)[:, None]
    y0 = np.where(top, ys, -1).max(0)              # bottom edge of the top face, per column
    band = np.zeros_like(top)
    for x in range(w):
        if y0[x] < 0:
            continue
        for dy in (1, 2, 3):
            y = y0[x] + dy
            if y < h and wall[y, x]:
                band[y, x] = True
    deep = wall & ~band
    if band.sum() < 4 or deep.sum() < 50:
        return
    def lum(px):
        return 0.299 * px[..., 0] + 0.587 * px[..., 1] + 0.114 * px[..., 2]
    t_l = float(lum(_hex(top_hex).astype(float)[None, :])[0])
    w_l = float(lum(out[:, :, :3][deep]).mean())
    thresh = max(t_l, w_l) + RIM_MARGIN
    px = out[:, :, :3][band]
    L = lum(px)
    hot = L > thresh
    if not hot.any():
        return
    new_l = thresh + (L[hot] - thresh) * RIM_KEEP
    drop = np.minimum(L[hot] - new_l, RIM_MAX_DROP)
    tgt_l = L[hot] - drop
    # FADE TOWARD THE TOP COLOUR, not down the pixel's own colour. The first version
    # darkened each rim pixel multiplicatively — same hue, lower value — and the
    # maintainer saw exactly what is wrong with that: "I think you have to fade it
    # towards the top color to dim it down, feel you changed it to another color that
    # also got it to pop (but in a different way)." A white glow darkened along its own
    # hue becomes a grey-cyan band: still a foreign colour sitting on the edge. Blended
    # toward the top palette colour it becomes the ground's own colour, slightly lit —
    # which is what a pixel-art edge highlight is.
    #
    # Luminance is linear in the blend, so the mix that lands each pixel on its target
    # brightness is exact: a = (L - target) / (L - L_top). L > target > L_top always
    # holds here (target >= top luminance + RIM_MARGIN), so a is in (0, 1).
    # ONLY GLOW-LIKE PIXELS FADE. A highlight is near-white or already the top's own
    # hue; fading THOSE toward the top colour stays in-family. A saturated wall-hued lip
    # (the bright green edge slime draws under a dark_mud top) is the wall's material,
    # not the glow — fading green toward brown manufactures olive, which is precisely an
    # invented colour, and the guard caught it doing so (blob 14 on dark_mud over
    # slime). Those pixels are left alone: "Some tiles are worse then others. So all
    # tiles doesn't need this fix."
    t_rgb = _hex(top_hex).astype(float)
    hsv_px = _rgb2hsv(px[hot])
    t_hsv = _rgb2hsv(t_rgb[None, :])[0]
    gap = np.abs(hsv_px[:, 0] - float(t_hsv[0]))
    gap = np.minimum(gap, 255.0 - gap)
    glow = (gap <= RIM_HUE_TOL) | (hsv_px[:, 1] < RIM_SAT_GREY)
    if not glow.any():
        return
    a_mix = (L[hot] - tgt_l) / np.maximum(L[hot] - t_l, 1.0)
    a_mix = (np.clip(a_mix, 0.0, 1.0) * glow)[:, None]
    px[hot] = px[hot] * (1.0 - a_mix) + t_rgb[None, :] * a_mix
    out[:, :, :3][band] = px


def substitute(a, mask, hex_target, spread=None, ramp=None, vcap=None):
    """Put `mask` onto a palette colour by SUBSTITUTION, keeping its relief.

    Hue and saturation are SET from the palette, never derived from the art, and only
    the value carries through — recentred on the target with its spread compressed, so
    the texture survives but the colour is the palette's. That distinction is the whole
    safety property: all three wall-alignment attempts that shipped an invented colour
    (a magenta grass edge, 1413 vivid pixels, a red light_soil) READ a hue off the art
    and shifted by it, and reading a hue off something near-grey is meaningless. Nothing
    here reads anything.

    Compressed only, never stretched. Amplifying a spread to hit a target is what turned
    a stone wall into zigzag earlier in this pipeline.
    """
    if not mask.any():
        return None
    if ramp:
        # A MATERIAL IS A RAMP, NOT A HEX. The maintainer nominated the dark_mud
        # reference for its RANGE — "the ref has several colors of brown" — and single-
        # hue substitution averaged that range away twice: once when the palette kept
        # only the mean, once when every pixel got the mean's hue and saturation ("you
        # have managed to get everything into a single brown color. I don't like
        # that."). With a ramp, each pixel keeps its place in the relief and takes the
        # reference's OWN colour for that place: shadows get the reference's shadow
        # brown, highlights its highlight brown. Still substitution, not inference —
        # the only thing read off the art is brightness, and every output colour is a
        # palette colour verbatim, which also keeps no_invention's rule 1 trivially
        # true for them.
        stops = np.stack([_hex(h) for h in ramp]).astype(float)
        v = _rgb2hsv(a[:, :, :3][mask])[:, 2]
        lo, hi = np.percentile(v, 5.0), np.percentile(v, 95.0)
        t = np.full(len(v), 0.5) if hi - lo < 6 else np.clip((v - lo) / (hi - lo), 0, 1)
        return stops[np.round(t * (len(stops) - 1)).astype(int)]
    tgt = _rgb2hsv(_hex(hex_target)[None, :])[0]
    hsv = _rgb2hsv(a[:, :, :3][mask])
    v = hsv[:, 2]
    sp = SPILL_SPREAD if spread is None else spread
    scale = min(1.0, sp / float(v.std() or sp))
    hsv[:, 0] = tgt[0]
    hsv[:, 1] = tgt[1]
    # CLAMPED TO WHAT THE GUARD CAN PROVE. no_invention's rule 2 accepts a pixel that
    # landed on the palette colour within VAL_SLACK (60) of its value. A substituted
    # pixel has the palette's exact hue and saturation, so the ONLY way it can fail the
    # guard is value relief poking past that slack — which happened: a bright streak on
    # a deep_water wall recentred to 66 over the target, blob 6, and the guard punished
    # the whole tile by shipping it raw. Clamping the relief to 58 makes every
    # substituted pixel provably legal, so a substitution can never again be the reason
    # a tile ships unprocessed.
    hsv[:, 2] = np.clip(
        np.clip(float(tgt[2]) + (v - v.mean()) * scale, float(tgt[2]) - 58.0,
                float(tgt[2]) + 58.0), 0, 255)
    if vcap is not None:
        # A claimed drape must BE near-black, its lit lip included. Relief-keeping
        # left the bright edge pixels bright ("Red is the one that should be
        # near-black") — the cap pulls everything claimed down to the paint's own
        # darkness. Lowering toward the target keeps rule 2 trivially true.
        hsv[:, 2] = np.minimum(hsv[:, 2], float(vcap))
    return _hsv2rgb(hsv)


def snap(img, top_hex, side_hex=None, keep_wall_texture=True, side_profile=None,
         align_walls=False, spill=True, same_material=False, wall_hex=None,
         align_side=False, flat_top=True, top_ramp=None, side_ramp=None,
         claim_depth=None, paint_side=True, deep_claim=None, drip_match=None,
         edge_dim=False):
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
    if not reg:
        return img.convert("RGBA")
    out = a.copy()
    top = _hex(top_hex)
    side = _hex(side_hex) if side_hex else np.array([128.0, 128.0, 128.0])
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

    # align_wall() is GONE. It used to fire from this exact spot on any call that
    # passed side_hex, and it is the function that shipped a magenta grass edge, 1413
    # vivid pixels and a red light_soil — three colours that were in neither the art nor
    # the palette. Leaving it reachable meant the first caller to pass side_hex for an
    # unrelated reason would silently re-arm it, which is precisely what wiring up the
    # side-wall alignment below would have done. substitute() replaces it and cannot
    # fail the same way, because it reads nothing off the art.

    if reg["top"].sum() and not flat_top:
        # THE TOP KEEPS ITS TEXTURE and only its colour is corrected — the same treatment
        # the walls get, and for the same reason. The maintainer asked for it by material:
        # "parquet_floor is not expected to be 'clean'. So a parquet_floor should always
        # maintain it's unclean top texture (but the color palette should still align)."
        #
        # This is the one case where the argument for flattening does not apply. A flat fill
        # exists so a large field shows no repeat, but planks ARE the material — a parquet
        # floor with no grain is not a cleaner parquet floor, it is a brown rectangle.
        px = substitute(a, reg["top"], top_hex, spread=TEXTURED_TOP_SPREAD)
        if px is not None:
            out[:, :, :3][reg["top"]] = px
    elif reg["top"].sum():
        # Overwrite the top with the one palette colour. This looks like the bigger
        # edit next to a shift, and on the tiles we actually accept it is the SAME edit:
        # the clean-top gate only passes tiles whose top already generated flat, and
        # shifting a flat surface onto a colour and painting it that colour agree pixel
        # for pixel. Where they differ is on a top that did NOT generate flat, and there
        # a shift preserves the texture and it survives into the game as a dotted grid
        # along every tile edge (measured on a grass-textured dark_mud top: 4048
        # off-colour pixels inside a 4x4 field, against 0 for a flat grey_stone one).
        #
        # It cannot reach the border the maintainer wants kept: that border lives in the
        # WALL region, which this function no longer touches at all.
        out[:, :, :3][reg["top"]] = np.clip(top, 0, 255)

    # The overhanging blades belong to the top material, so they move with it. This is
    # the ONLY thing that writes into the wall region, and it writes only pixels the
    # hue test picked out; the rock itself is still untouched.
    if spill and same_material:
        # X-over-X: the wall IS the top's material, so the whole face moves with it, not
        # just a fringe. This needs no detection at all — the cell name says both
        # materials — which is worth preferring wherever it is available, because the
        # hue test cannot tell this case from grass-over-slime (they separate by 31 and
        # 29) and the fringe rules therefore skip both.
        m = reg["left"] | reg["right"]
        if m.any():
            # THE WALL IS DARKER THAN THE TOP. It is the same material seen from the
            # side, in its own shade — that difference is most of what makes a block
            # read as a block instead of a sticker, and the generator draws it: on
            # dark_mud the raw art measures top luminance 70.9 against wall 45.3.
            #
            # Moving the wall onto the TOP's colour threw that away and inverted it,
            # landing the wall at 66.9 — BRIGHTER than the top it sits under. The
            # maintainer saw it immediately: "the color palette you use to get dark mud
            # makes dark mud look worse". Washed out, because a cliff lit like a
            # tabletop has no cliff in it.
            #
            # palette.json has carried a MEASURED per-material `wall` colour since the
            # alignment work, and nothing has ever used it. dark_mud's is #3b2e1f,
            # luminance 48.1 — within 3 of what the generator draws unaided. So the
            # wall goes to the wall colour and the top to the top colour, which is what
            # the palette was built to say.
            px = substitute(a, m, wall_hex or top_hex, ramp=top_ramp)
            if px is not None:
                out[:, :, :3][m] = px
    elif spill:
        fringe = np.zeros(reg["top"].shape, bool)
        r = retint_spill(a, reg, top_hex)
        if r:
            newrgb, m = r
            out[:, :, :3][m] = newrgb[m]
            fringe = m
        # THE WALL UNDER THE FRINGE IS THE SIDE MATERIAL, and it gets exactly what the
        # same-over-same path gives it. Until now it got nothing, so the grass under an
        # ice tile kept the generator's bright yellow-green while the grass under a
        # GRASS tile was substituted onto the palette's deep pine — the maintainer put
        # the two side by side with the wiki's "top only" control and asked why they do
        # not match. They did not match because only one of them was ever aligned.
        #
        # Safe now in a way it was not for the three attempts that failed: this
        # SUBSTITUTES rather than infers (see substitute()), and align_side is only
        # passed for a cell whose wall has been confirmed to BE the material asked for.
        # Tinting a three-layer tile's grey-stone wall toward green is what produced
        # colours that were in neither the art nor the palette.
        if side_hex:
            # ASK EACH PIXEL WHICH MATERIAL IT IS, against the two PALETTE colours.
            #
            # The maintainer's insight, and it removes the need for detection entirely:
            # "Ice can't impossible have any green, so you must in this case know that
            # green is supposed to be grass. It feels like you are trying to solve this
            # by drawing a line or something." That is exactly what the previous version
            # did — it took the lower 60% of the wall as "the wall" and left the rest,
            # so a bright band of grass under the ice lip kept the generator's colour.
            # A line drawn across the art, not an answer about the art.
            #
            # An X-over-Y wall holds exactly two materials and BOTH palette colours are
            # known, so nearest-of-two decides it with nothing inferred. Measured on the
            # cell the maintainer was reviewing: 93% of the wall classifies as grass, 7%
            # as ice, and the 7% is the thin lip along the top edge.
            #
            # This is not the hue-off-a-median inference that failed three times. The
            # references are fixed palette entries, and the classification is a distance,
            # not a shift.
            wall_all = reg["left"] | reg["right"]
            # THE 60-UNIT PALETTE-DISTANCE GATE IS GONE. It asked whether the two PALETTE
            # colours were far enough apart to tell the materials apart — a fair question
            # when the classifier compared against those colours, and the wrong question now
            # that it compares against the tile's own. It measured neither the right thing
            # nor reliably: it blocked grass over deep_water (39 apart in palette, 130 apart
            # in the art, so trivially separable) while waving through grey_stone over
            # dark_mud (139 apart in palette, 17 in the art, i.e. one material). Both
            # backwards. _split_wall() now decides from the separation it actually finds.
            #
            # Measured on the 14 tiles the gate used to block: after this, mean wall_err 5.5,
            # worst 20.8, none over MAX_WALL_ERR.
            m_side, m_top = _split_wall(a, reg, wall_all, side_hex=side_hex,
                                        aggressive=not align_side,
                                        claim_depth=claim_depth,
                                        deep_claim=deep_claim,
                                        drip_match=drip_match)
            if drip_match is not None:
                # THE BROWN DOES NOT CHANGE FROM LIVE, BYTE FOR BYTE. The drip claim
                # may only ADD black pixels; it must never alter how the mud paints.
                # The wall repaint maps value percentiles WITHIN its mask, so merely
                # removing the claimed drape from the side mask re-ladders every mud
                # pixel — which the maintainer caught instantly ("NOOOOOOOO! YOU
                # CHANGED THE BROWN AGAIN!"). So the side is painted from the BASE
                # classification, exactly as a drip-less run paints it, and the
                # extended top claims overwrite on top of it afterwards.
                m_side, _base_top = _split_wall(a, reg, wall_all, side_hex=side_hex,
                                                aggressive=not align_side,
                                                claim_depth=claim_depth,
                                                deep_claim=deep_claim)
            # THE OVERHANG ALWAYS ALIGNS; THE WALL ONLY WHEN CONFIRMED. align_side (the
            # wall_err gate) exists so a wall that may not BE the requested material is
            # never repainted as it. But it used to gate this whole block, overhang
            # included, and the overhang's identity is not in question — it is the top
            # material, named by the cell and standing on the top face. On dark_mud over
            # paving_stone every candidate fails the wall gate (wall_err 42-67 against
            # 30), so the mud spill shipped in whatever colour the generator drew:
            # "the overhang is a bit redish ... It's clear to me that the overhang
            # belongs to the dark_mud. But they don't change color."
            pairs = [(m_top, top_hex, top_ramp, False)]
            paint_last = drip_match is not None
            # paint_side=False is the raw_wall tweak: the wall's CLASSIFICATION stays
            # strict (align_side still says the material is confirmed, so the claims do
            # not go aggressive), but the wall itself ships as drawn. Suppressing
            # alignment entirely was tried and flipped the pair into aggressive
            # claiming — the black overhang swallowed the shadowed stones it was
            # supposed to leave alone.
            if align_side and paint_side:
                pairs.append((m_side, side_hex, side_ramp, True))
            if paint_last:
                # side first, extended top last, so the claims overwrite the mud
                # paint on the pixels they take — and only on those pixels
                pairs = pairs[::-1]
            for mask, hx, rmp, is_side in pairs:
                if mask.sum() < 8:
                    continue
                if is_side:
                    # A PIXEL FAR OUTSIDE THE WALL'S OWN BRIGHTNESS IS NOT THE WALL.
                    # substitute() recentres value on the target, so a stray near-black
                    # rock crumb classified into a bright beach wall came out beach-
                    # bright ([4,4,7] -> [92,78,62]) — an invented colour the guard then
                    # punished by shipping the WHOLE tile raw: "Black Rock over light
                    # beach also has a tile that didn't get any postprocessing at all."
                    # Alien pixels stay raw; the rest of the tile still gets processed.
                    hsv_m = _rgb2hsv(a[:, :, :3][mask])
                    med = float(np.median(hsv_m[:, 2]))
                    band = np.abs(hsv_m[:, 2] - med) <= SIDE_VALUE_BAND
                    if band.sum() < 8:
                        continue
                    idxm = np.where(mask)
                    mask = np.zeros(mask.shape, bool)
                    mask[idxm[0][band], idxm[1][band]] = True
                px = substitute(a, mask, hx, ramp=rmp,
                                vcap=(None if (is_side or drip_match is None)
                                      else _rgb2hsv(_hex(hx)[None, :])[0][2] + 12.0))
                if px is not None:
                    out[:, :, :3][mask] = px

    for k in ("left", "right") if align_walls else ():
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

    soften_rim(out, a, reg, top_hex)
    if edge_dim:
        dim_edge_highlight(out, a, reg, top_hex)
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
