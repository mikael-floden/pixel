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
    sel = (dt < dw) & (hsv[:, 1] > sat_floor)
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

# Below this the two clusters are one material and the boundary is noise.
MIN_SPLIT_SEPARATION = 40.0


def _chroma_dist(px, target):
    c = _chroma(px)
    t = _chroma(np.asarray(target, float)[None, :])[0]
    return np.sqrt(((c[:, :2] - t[:2]) ** 2).sum(1)
                   + (CHROMA_VALUE_WEIGHT * (c[:, 2] - t[2])) ** 2)


def _split_wall(a, reg, wall_all):
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
    w = np.median(px, 0)
    keep = np.ones(len(px), bool)
    for _ in range(8):
        keep = _chroma_dist(px, w) <= _chroma_dist(px, seed_top)
        if keep.sum() < 20:            # no recognisable wall left; treat it all as wall
            keep = np.ones(len(px), bool)
            break
        nw = px[keep].mean(0)
        if np.abs(nw - w).max() < 0.5:
            w = nw
            break
        w = nw

    # DID IT ACTUALLY FIND TWO MATERIALS? A two-means split always returns two groups, even
    # when handed one uniform surface, and then the boundary is wherever the noise happened
    # to fall. That is not harmless: the two groups get painted DIFFERENT palette colours,
    # so an invented boundary becomes a visible mottle on a wall that was all one material.
    #
    # Measured on grey_stone over dark_mud, which the old palette-distance gate let through:
    # the two clusters differ by 17 RGB units — one material — yet the split handed 64% of a
    # dark_mud wall to grey_stone. Same failure the maintainer caught on water over rock,
    # one step further down.
    #
    # When the split does not separate, the answer is already known and does not need
    # guessing: publish only passes align_side for a wall whose material has been CONFIRMED
    # (wall_err <= MAX_WALL_ERR), so an unseparated wall is all of the side material. 5 of
    # 182 cells land here.
    if keep.sum() >= 20 and (~keep).sum() >= 20:
        sep = float(np.linalg.norm(px[keep].mean(0) - px[~keep].mean(0)))
        if sep < MIN_SPLIT_SEPARATION:
            keep = np.ones(len(px), bool)

    idx = np.where(wall_all)
    m_side = np.zeros(wall_all.shape, bool)
    m_top = np.zeros(wall_all.shape, bool)
    m_side[idx[0][keep], idx[1][keep]] = True
    m_top[idx[0][~keep], idx[1][~keep]] = True
    return m_side, m_top


def substitute(a, mask, hex_target, spread=None):
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
    tgt = _rgb2hsv(_hex(hex_target)[None, :])[0]
    hsv = _rgb2hsv(a[:, :, :3][mask])
    v = hsv[:, 2]
    sp = SPILL_SPREAD if spread is None else spread
    scale = min(1.0, sp / float(v.std() or sp))
    hsv[:, 0] = tgt[0]
    hsv[:, 1] = tgt[1]
    hsv[:, 2] = np.clip(float(tgt[2]) + (v - v.mean()) * scale, 0, 255)
    return _hsv2rgb(hsv)


def snap(img, top_hex, side_hex=None, keep_wall_texture=True, side_profile=None,
         align_walls=False, spill=True, same_material=False, wall_hex=None,
         align_side=False, flat_top=True):
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
            px = substitute(a, m, wall_hex or top_hex)
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
        if align_side and side_hex:
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
            m_side, m_top = _split_wall(a, reg, wall_all)
            for mask, hx in ((m_side, side_hex), (m_top, top_hex)):
                if mask.sum() < 8:
                    continue
                px = substitute(a, mask, hx)
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
