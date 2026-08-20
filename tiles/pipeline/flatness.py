"""Measure how close a tile's TOP surface is to a single flat colour.

This is the whole acceptance test for a tiles 3.0 base tile, and it is deliberately
a MEASUREMENT rather than a judgement call: the maintainer's requirement ("the top of
the base tile has to be 100% single colour") exists because a perfectly flat fill has
no features for the eye to latch onto, so a huge field of the same tile shows no
visible repeat. That property is objective, so we can score every candidate and keep
the best instead of eyeballing sheets.

Scores (top diamond only — the side walls are a different material by design):
  * `share`   fraction of top pixels sitting in the single most common colour after
              a small quantisation. 1.0 = perfectly flat. THE headline number.
  * `uniq`    distinct colours in the top surface. 1 = perfect.
  * `std`     mean per-channel standard deviation. 0 = perfect.
  * `dE`      distance from the type's intended resting colour, so "flat but the
              wrong colour" cannot pass.

  python tiles/pipeline/flatness.py <image> [<image> ...]
  python tiles/pipeline/flatness.py --hex 3f8a3a sheet/*.png
"""

from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image

# Top-diamond geometry, measured on real 64px tiles-pro output (same as tiles2's
# corrected mask: apex ~y6, 32 rows tall, full width by ~y22) — NOT the narrower
# nominal diamond, which misses the real edge and skews the score.
_APEX_Y = 6
_H = 32


def top_mask(h, w, opaque=None):
    """Top-diamond mask, derived from the tile's OWN opaque bounding box when one is
    given rather than assuming the art fills a centred 64px canvas.

    That assumption is not safe: most sheets do come back canvas-filling (x0..63,
    centre 31.5), but a sheet can return undersized/offset tiles — one bake-off sheet
    came back 57px wide centred at x29. A fixed mask on that art straddles the two
    side walls, and their darker pixels read as 'surface texture', scoring a perfectly
    flat tile at ~0.57. Deriving the diamond from the bbox measures the top face on
    any geometry, so the score describes the ART instead of the framing."""
    m = np.zeros((h, w), bool)
    if opaque is not None and opaque.any():
        ys, xs = np.where(opaque)
        x0, x1, y0 = int(xs.min()), int(xs.max()), int(ys.min())
        bw = x1 - x0 + 1
        cx = (x0 + x1) / 2.0
        hd = bw / 2.0                      # iso: a full-width diamond is half as tall
        cy = y0 + hd / 2.0
        yy, xx = np.mgrid[0:h, 0:w]
        return (np.abs(xx - cx) / (bw / 2.0) + np.abs(yy - cy) / (hd / 2.0)) <= 1.0
    cx = w // 2
    for y in range(_APEX_Y, min(h, _APEX_Y + _H)):
        t = (y - _APEX_Y) / _H
        hw = int(round((w / 2) * (1 - abs(2 * t - 1))))
        m[y, max(0, cx - hw):min(w, cx + hw)] = True
    return m


def _surfaces(op, h, w):
    """Top-diamond and wall masks, with the diamond MEASURED off the art.

    This file used to assume the usual 2:1 diamond (64 wide -> 32 tall). The generator
    makes it 64x28, so that assumption put the top/wall boundary 1-3 rows too low and
    every "top" measurement here was quietly scoring wall pixels as part of the top —
    including the clean-top gate, which is the single most important judgement the
    pipeline makes. Same off-by-two that made rendered plateaus come out ragged and made
    the postprocess fatten the grass; it lived in three files and this was the last one.

    The half-height comes from the tile's own corners: the topmost opaque pixel of the
    outermost columns, minus the apex.
    """
    ys, xs = np.where(op)
    x0, x1, y0 = int(xs.min()), int(xs.max()), int(ys.min())
    hw = (x1 - x0 + 1) / 2.0
    cx = (x0 + x1) / 2.0
    hh = float(np.mean([int(np.where(op[:, x])[0].min()) - y0 for x in (x0, x1)])) or hw / 2.0
    cy = y0 + hh
    yy, xx = np.mgrid[0:h, 0:w]
    below = yy > cy + hh * (1.0 - np.abs(xx - cx) / hw) + 1.0
    return cx, xx, ~below, below


def faces(path):
    """Split a tile into its THREE surfaces and measure each independently:
    the top diamond, the left wall and the right wall.

    Measuring only the top is not enough for tiles 3.0. An "X over Y" tile is a claim
    about TWO materials, and the generator will happily hand back a plausible pairing
    it chose itself (green top over brown soil) whether or not that is what was asked
    for. Without per-wall numbers there is no way to tell a controlled result from the
    generator's default — the walls have to be scored too, or "over" is unverifiable.
    """
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(int)
    h, w = a.shape[:2]
    op = a[:, :, 3] > 200
    if not op.any():
        return None
    cx, xx, dia, below = _surfaces(op, h, w)
    out = {}
    for name, m in (("top", dia & op),
                    ("left", below & op & (xx < cx - 1)),
                    ("right", below & op & (xx > cx + 1))):
        m = _erode(m, 1)
        if m.sum() < 25:
            out[name] = None
            continue
        px = a[:, :, :3][m]
        q = (px // 8) * 8
        vals, cnts = np.unique(q, axis=0, return_counts=True)
        out[name] = {"n": int(m.sum()), "share": float(cnts.max() / m.sum()),
                     "uniq": int(len(np.unique(px, axis=0))),
                     "median": [int(v) for v in np.median(px, axis=0)]}
    return out



CLEAN_TOP = 0.93   # calibrated against the maintainer's own accept/reject, see below

# Minimum edge spill. Calibrated exactly like CLEAN_TOP: the maintainer went through all
# 14 grass cells and circled the ones whose transition was not good enough. Every cell
# they kept scores >= 0.36 (grass 1.00, slime 1.00, light_soil 0.94, grey_stone 0.94,
# lava 0.57, dark_mud 0.46, light_beach 0.36); every cell they circled scores <= 0.10
# (parquet_floor 0.10, ice 0.09, paving_stone 0.09, black_rock 0.07, deep_water 0.07,
# snow 0.07, water 0.07). Nothing lands in between, so the threshold sits in the gap.
#
# It is a GATE and not a ranking term. As a multiplier on wall score it was worthless
# where it mattered: paving_stone had a seamless tile at 0.61 spill and shipped one at
# 0.09 because the flat-walled candidate scored higher on the wall, and snow shipped
# 0.07 while holding a 0.81. A tile without the transition is not a worse tile, it is
# the wrong tile.
MIN_OVERHANG = 0.25

# Minimum fringe CLARITY, calibrated the same way and on the same eye. Having fixed the
# retint, the maintainer looked again and named exactly the cells this catches: "only the
# grass on ice overhang still isn't part of the grass palette theme". Measured over the
# current picks, ice scores 0.039 and slime 0.042 while every cell they accepted scores
# 0.246 to 0.321 — nothing in between, so the threshold sits in the gap.
#
# Distinct from MIN_OVERHANG on purpose. ice scores 0.92 spill and slime 1.00: plenty of
# the top material hangs over. It just cannot be TOLD APART from the wall it hangs on,
# because the generator drew the two as one gradient, and postprocess cannot select what
# is not separable.
MIN_CLARITY = 0.12

# Seam tolerance. This was an absolute == 0 and that is stricter than the defect: a
# handful of the top material's own blades showing where two tiles meet is grass, not a
# grid line. The distribution has a natural break there — measured over 448 tiles, 392
# sit at exactly 0, 406 at <= 8, and then it jumps to 42 tiles above 8. snow over
# paving_stone was rejected at SIX pixels while carrying a full 1.00 spill.
SEAM_TOL = 8


def overhang(path, cap=200.0):
    """How much of the TOP material spills down over the wall — 0.0 to 1.0.

    The maintainer's own words for a ten-star tile: "It looks like grass is falling over
    the edge and there is no sharp edge. This is how I want it." That is a property of
    the GENERATED art and nothing downstream can add it — postprocess deliberately does
    not touch the wall, which is exactly where the spill lives. So it has to be selected
    for, or the pipeline keeps publishing tiles with a clean cut instead.

    Measured by HUE rather than by exact colour, because the blades hanging over an edge
    are darker and more varied than the flat surface they grow from; matching the
    surface colour within a tolerance finds almost none of them (10 on a tile that
    visibly has dozens). The hue of the top material's own median is the reference, so
    this works for any material, not just green.
    """
    try:
        a = np.asarray(Image.open(path).convert("RGBA")).astype(float)
    except Exception:
        return 0.0
    op = a[:, :, 3] > 200
    if not op.any():
        return 0.0
    h, w = a.shape[:2]
    cx, xx, dia, below = _surfaces(op, h, w)
    top, wall = dia & op, below & op
    if top.sum() < 50 or wall.sum() < 50:
        return 0.0
    rgb = a[:, :, :3]
    to_hsv = lambda px: np.asarray(
        Image.fromarray(px.clip(0, 255).astype(np.uint8)[None, :, :], "RGB").convert("HSV"),
        dtype=float)[0]
    ref = to_hsv(np.median(rgb[top], 0)[None, :])[0]
    hsv = to_hsv(rgb[wall])
    dh = np.abs(hsv[:, 0] - ref[0])
    dh = np.minimum(dh, 255.0 - dh)          # hue is circular
    spill = int(((dh < 22) & (hsv[:, 1] > 55)).sum())
    return min(spill / cap, 1.0)


def fringe_clarity(path):
    """How DECISIVELY the overhanging fringe reads as the top material, 0-1.

    `overhang` counts how much spills over the edge; this asks whether what spilled can
    still be told apart from the wall it landed on. They come apart when the two
    materials are close in hue: on grass over ice the fringe blends into the ice across
    a gradient — hue 112 at the top of the wall rising to 125 deeper in, against ice's
    own 127 — so a tile can score a full 1.00 spill and still have no pixel that is
    decisively grass. Postprocess then cannot retint it, because there is nothing to
    select, and the overhang ships in the wrong palette.

    So it is measured as the share of wall pixels whose hue is nearer the TOP material
    than the wall's by a clear margin, rather than merely nearer. Selecting for it is the
    fix; no postprocess can separate two materials the generator drew as one.
    """
    import palette_snap
    try:
        a = np.asarray(palette_snap.canonicalise(
            Image.open(path).convert("RGBA"))).astype(float)
    except Exception:
        return 0.0
    reg = palette_snap._regions(a)
    if not reg:
        return 0.0
    rgb, wall = a[:, :, :3], reg["left"] | reg["right"]
    if wall.sum() < 200 or reg["top"].sum() < 200:
        return 0.0
    tref = palette_snap._rgb2hsv(np.median(rgb[reg["top"]], 0)[None, :])[0]
    ys, xs = np.where(wall)
    low = []
    for x in np.unique(xs):
        c = np.where(wall[:, x])[0]
        lo = int(c.min()) + int(0.4 * (int(c.max()) - int(c.min())))
        low.extend(rgb[lo:int(c.max()) + 1, x])
    if len(low) < 20:
        return 0.0
    wmat = palette_snap._rgb2hsv(np.median(np.array(low), 0)[None, :])[0]
    # WAIVED when the two materials are the same colour by nature. Clarity exists so the
    # retint has something to select; where the top and the wall share a hue there is
    # nothing to correct, and demanding separability asks the generator for a difference
    # the materials do not have. ice over water, light_soil over light_beach and
    # light_soil over parquet_floor separate by 7-8 hue units and scored 0 across all 96
    # tiles each — unsatisfiable — while their fringes ship 0-7 hue units and 9-38
    # luminance from the palette, i.e. already right. Compare the cells the maintainer
    # actually circled, which were ~45 hue units and +47 to +103 luminance out.
    #
    # The waiver is deliberately narrow. grass over slime separates by only 2 and is NOT
    # waived: those are genuinely different materials that happen to be green, the
    # difference is real, and a chase found a tile carrying it at 0.228.
    sep = abs(float(wmat[0]) - float(tref[0]))
    sep = min(sep, 255.0 - sep)
    if sep < 12:
        return 1.0

    hsv = palette_snap._rgb2hsv(rgb[wall])
    dt = np.abs(hsv[:, 0] - tref[0]); dt = np.minimum(dt, 255.0 - dt)
    dw = np.abs(hsv[:, 0] - wmat[0]); dw = np.minimum(dw, 255.0 - dw)
    return float(((dw - dt) > 12).sum()) / float(wall.sum())


def wall_material_err(path, side_hex):
    """How far the WALL is from the side material it was asked for, in hue (or in
    luminance when either colour is too grey for hue to mean anything).

    "X over Y" is a claim about TWO materials and the generator will happily return a
    plausible pairing it chose itself. faces() has said exactly that in its docstring
    since the first commit — and nothing ever gated on it, so 9 of 56 cells shipped with
    a wall that is not the requested material at all: snow-over-grass with a BROWN wall,
    grass-over-snow with a GREY one, black_rock-over-snow 172 luminance out.

    Cheap to check and impossible to fix downstream, which makes it a selection
    criterion: postprocess can put a wall on the palette but it cannot turn soil into
    snow.
    """
    import palette_snap
    try:
        a = np.asarray(palette_snap.canonicalise(
            Image.open(path).convert("RGBA"))).astype(float)
    except Exception:
        return 999.0
    reg = palette_snap._regions(a)
    if not reg:
        return 999.0
    w = reg["left"] | reg["right"]
    if w.sum() < 200:
        return 999.0
    rgb = a[:, :, :3]
    ys, xs = np.where(w)
    low = []
    for x in np.unique(xs):
        c = np.where(w[:, x])[0]
        lo = int(c.min()) + int(0.4 * (int(c.max()) - int(c.min())))
        low.extend(rgb[lo:int(c.max()) + 1, x])
    if len(low) < 20:
        return 999.0
    med = np.median(np.array(low), 0)
    tgt = np.array([int(side_hex.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)], float)
    # ROUTING BY ABSOLUTE CHROMA, and a grey wall against a coloured target is a FAIL
    # rather than a brightness question.
    #
    # The old test routed on HSV saturation < 50 and then compared luminance. That is
    # how a three-layer tile passed unnoticed: black_rock-over-grass drew black stones
    # over grass over LIGHT GREY STONE, and its grey wall was scored on brightness
    # against a green target and came out 6.7 — comfortably inside the gate. Brightness
    # cannot distinguish "grey stone" from "grass"; only chroma can, and when one side
    # has none there is no meaningful distance to compute. Inventing one is the same
    # mistake that painted the grass magenta, one function over.
    #
    # Deliberately the TIGHTENING direction. The looser variants tested alongside this
    # each recovered cells by lowering the bar — they dropped the published wall score
    # in 11 of 13 cells they touched, landing rank-0 at wall 0.00, trading one named
    # defect for a hard seam repeated down every cliff.
    hm = palette_snap._rgb2hsv(med[None, :])[0]
    ht = palette_snap._rgb2hsv(tgt[None, :])[0]
    chroma = lambda c: float(max(c) - min(c))
    cm, ct = chroma(med), chroma(tgt)
    if cm < 25 and ct < 25:
        lum = lambda c: 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
        return abs(float(lum(med)) - float(lum(tgt))) / 2.0    # scaled onto the hue scale
    if cm < 25 or ct < 25:
        # ONE side has colour and the other does not. Colourfulness is itself a material
        # property, so the honest distance here is how far apart the two are in CHROMA —
        # not a hard rejection, and certainly not a luminance comparison, which ignores
        # the very axis they differ on.
        #
        # A hard fail was tried first and over-fired by exactly one direction. It caught
        # the real defect (black_rock-over-grass, a wall at chroma 0 against a grass
        # target at 60 — that wall cannot be grass) but also condemned six cells whose
        # wall is a COLOURED rendering of an achromatic material, all of them "over
        # snow": snow in shadow is legitimately blue, chroma 40 against the palette's 12.
        # Graded, both are handled on their merits — the grass cases land 49-60 and
        # reject, shaded snow lands near the threshold and is judged rather than
        # condemned.
        #
        # AND LUMINANCE TOO, because chroma alone was not enough either. A near-BLACK
        # wall and near-WHITE snow both have little colour, so their chroma gap is small
        # while they could hardly look less alike — lava-over-snow drew a black wall
        # where snow was asked for, scored 26 against a 30 threshold, and shipped. The
        # maintainer named it in three words: "looks like black snow".
        #
        # Taking the worse of the two gaps moves the catch rate over the 57 tiles that
        # reach this branch from 9/16 to 13/16 of the ones they rejected, for 3 extra
        # demotions among the 41 they kept — and this feeds a TIER, so a demotion only
        # costs anything when a better candidate exists. Those black-snow tiles go from
        # 26 and 21 to 93.6 and 92.2.
        _lm = lambda c: 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
        return max(abs(cm - ct), abs(float(_lm(med)) - float(_lm(tgt))) / 2.0)
    # HUE AND COLOURFULNESS, because hue alone cannot tell a material from a washed-out
    # ghost of it. ice-over-grass shipped a candidate that is a SOLID ICE BLOCK — no
    # grass anywhere in it — and scored 11.0 against the grass target, well inside the
    # gate, because a pale cyan sits only 16 hue units from deep green. Its saturation
    # was off by 151 and its value by 115, and both were ignored. The maintainer found
    # it by eye, again: "Ice can't impossible have any green".
    #
    # Saturation is the right second axis and lightness is not. A wall is the material
    # in shadow, so it is legitimately DARKER than the palette — that is why this
    # measured hue in the first place — but shading does not wash the colour out of a
    # pigment. Measured against seven walls labelled by eye, the saturation gap splits
    # them with a wide margin and nothing else does: walls that really show the material
    # score 10/56/61/62, walls that do not score 134/145/211. Hue overlaps (a wrong wall
    # at 11 against a right one at 22); CIELab dE overlaps too (29.2 wrong against 32.2
    # right).
    #
    # /3.0 puts it on the same scale as the hue term so one threshold governs both.
    d = abs(float(hm[0]) - float(ht[0]))
    return max(min(d, 255.0 - d), abs(float(hm[1]) - float(ht[1])) / 3.0)



def top_material_err(path, top_hex):
    """How far the TOP surface is from the material it was asked for.

    THE GAP THIS CLOSES. wall_material_err has guarded the wall for a while and there
    was never an equivalent for the top — so "X over Y" was only ever half-verified.
    The maintainer's first triage pass rejected 58 tiles and 39 of them, two thirds,
    are about the top: 22 where the materials are simply swapped ("this looks like
    grass over dark mud", "looks more like snow over grey stone", "looks like water
    over deep water"), 13 where the side material still covers part of the surface,
    and 4 where the colour is not convincing ("the black rock is not dark enough",
    "This looks like something blue over something light blue").

    Same two axes as the wall version, for the same reason: hue alone cannot tell a
    material from a washed-out ghost of it, and lightness alone cannot be used because
    a surface is legitimately shaded.
    """
    import palette_snap
    try:
        a = np.asarray(palette_snap.canonicalise(
            Image.open(path).convert("RGBA"))).astype(float)
    except Exception:
        return 999.0
    reg = palette_snap._regions(a)
    if not reg or reg["top"].sum() < 100:
        return 999.0
    med = np.median(a[:, :, :3][reg["top"]], 0)
    tgt = np.array([int(top_hex.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)], float)
    hm = palette_snap._rgb2hsv(med[None, :])[0]
    ht = palette_snap._rgb2hsv(tgt[None, :])[0]
    chroma = lambda c: float(max(c) - min(c))
    cm, ct = chroma(med), chroma(tgt)
    if cm < 25 and ct < 25:
        lum = lambda c: 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
        return abs(float(lum(med)) - float(lum(tgt))) / 2.0
    if cm < 25 or ct < 25:
        return abs(cm - ct)
    d = abs(float(hm[0]) - float(ht[0]))
    return max(min(d, 255.0 - d), abs(float(hm[1]) - float(ht[1])) / 3.0)


def top_contamination(path, top_hex, side_hex):
    """Fraction of the TOP surface that reads as the SIDE material instead.

    The maintainer counted this by eye, repeatedly and in quarters: "I don't like that
    1/4 of the ground is still slime", "1/2 of the top is still slime", "1/4 of the
    top is graas", "1/4 of the top/ground is still water". Thirteen rejections say it.

    Nearest-of-two against the two PALETTE colours, which is the same thing that made
    the wall classification work — both references are fixed, so nothing is inferred
    from the art. Returns 0.0 when the two materials are too close to tell apart, since
    a split between near-identical colours is noise rather than contamination.
    """
    import palette_snap
    try:
        a = np.asarray(palette_snap.canonicalise(
            Image.open(path).convert("RGBA"))).astype(float)
    except Exception:
        return 0.0
    reg = palette_snap._regions(a)
    if not reg or reg["top"].sum() < 100:
        return 0.0
    t = np.array([int(top_hex.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)], float)
    s = np.array([int(side_hex.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)], float)
    if float(np.linalg.norm(t - s)) < 60.0:
        return 0.0
    px = a[:, :, :3][reg["top"]]
    return float((np.linalg.norm(px - s, axis=1)
                  < np.linalg.norm(px - t, axis=1)).mean())



def indistinguishable(top_hex, side_hex):
    """True when two materials are too close in colour for any hue-based test to mean
    anything about which is which.

    This guard now governs three separate metrics, because they all fail the same way
    and each was found the hard way. `overhang` and `fringe_clarity` locate the top
    material inside the wall BY HUE; `swapped_err` asks which of two colours a surface
    resembles. Given two materials that share a colour, none of those questions has an
    answer, and the pipeline was answering them anyway:

      * on same-over-same, overhang returns exactly 1.000 for saturated materials and
        0.000 for desaturated ones, on the saturation floor alone — a coin flip on the
        material rather than a measurement of the tile.
      * paving_stone and grey_stone carry the SAME palette hex (#72786c), and 126 of
        that cell's 144 tiles were rejected by the spill gate while only 2 failed on
        wall quality. The cell was reported as needing generation for a year of rolls
        it could never have satisfied.

    60 in RGB distance, the same threshold top_contamination has always used.
    """
    if not top_hex or not side_hex:
        return False
    t = np.array([int(top_hex.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)], float)
    u = np.array([int(side_hex.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)], float)
    return float(np.linalg.norm(t - u)) < 60.0


def swapped_err(path, top_hex, side_hex):
    """Positive when the TOP reads as the SIDE material — i.e. the tile is BACKWARDS.

    The single most common way an "X over Y" cell fails, and there was no check for it.
    In the maintainer's first triage pass 22 of 58 rejections say some version of it in
    their own words: "this looks like grass over dark mud", "looks more like snow over
    grey stone", "looks like water over deep water (deep water is dark near black blue,
    water is blue/light blue)", "This looks like black stones on grass over stone".

    The measurement is a COMPARISON, not a threshold: how far the top sits from the
    material it was asked for, minus how far it sits from the other one. Above zero the
    generator drew the pair the wrong way round. That framing is what makes it work
    across materials without a per-pair constant — both references are palette entries
    and the answer is their difference.

    Measured against the maintainer's own labels: the 22 tiles they called swapped score
    a median of +10.0 with 82% above zero, while the 162 they left alone score -46.0
    with 6% above zero. At a margin of 20 it catches 45% of the swapped tiles and none
    of the kept ones.
    """
    # UNANSWERABLE when the two materials share a colour. paving_stone and grey_stone
    # carry the SAME palette hex (#72786c, distance 0), so asking which of them the top
    # looks like is a coin flip — and the gate was rejecting that cell's tiles on the
    # result. deep_water/dark_mud (55) and black_rock/grass (52) sit close enough to be
    # just as meaningless. Returning "not swapped" is right rather than merely safe:
    # if the two are indistinguishable then the tile cannot be visibly backwards.
    #
    # Same 60 threshold and same reasoning as top_contamination, which already declines
    # on this basis.
    t = np.array([int(top_hex.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)], float)
    u = np.array([int(side_hex.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)], float)
    if float(np.linalg.norm(t - u)) < 60.0:
        return -999.0
    a = top_material_err(path, top_hex)
    b = top_material_err(path, side_hex)
    if a >= 999.0 or b >= 999.0:
        return -999.0
    return a - b


# A tile whose top reads more like the OTHER material than its own is backwards. Zero is
# the natural threshold — it is the point where the two distances cross — and it is
# where the maintainer's labels separate: 82% of the tiles they called swapped are above
# it, 94% of the ones they kept are below.
MAX_SWAP = 0.0


# How much of the top surface may read as the OTHER material. The maintainer counts
# this by eye and says so in quarters — "not enough lava on the ground" (14 times in one
# pass), "I don't like that 1/4 of the ground is still slime", "1/2 of the top is graas".
#
# A TIER rather than a gate, and deliberately. Measured over 285 labelled tiles the
# medians separate strongly (0.182 for the ones they flagged against 0.002 for the rest)
# but the tails overlap: at this threshold it catches 71% of them and would wrongly
# demote 31% of the tiles they left alone. As a tier that costs nothing — a cleaner
# candidate wins when one exists, and a cell with nothing cleaner still ships its best.
MAX_CONTAMINATION = 0.05

# A wall further than this from its material is the wrong material, not a bad shade.
# Set from the gap in the measured distribution: the 47 cells that look right sit at
# 0-32, the 9 the maintainer's ice-over-grass report exposed sit at 32-172.
MAX_WALL_ERR = 30.0


def seam_px(path, top_hex=None):
    """Off-colour pixels inside the top surface of an assembled flat field — the thing
    a clean top is actually FOR.

    The maintainer's insight: prompting for grass rather than for green gives a better
    transition but a dirtier top, and the postprocess overwrites the top anyway, so the
    dirty top costs nothing. Measured and true — every tile the old flatness gate
    rejected comes back with exactly ONE colour on its top after postprocess.

    So gating on the RAW top's flatness threw away 182 perfectly good tiles out of 238
    rejected, including several with the best edge spill in the whole set at a raw share
    of 0.40. What matters is not whether the generator drew a flat top; it is whether the
    SHIPPED tile tiles cleanly. That is this, and it is measured on the postprocessed
    art laid out as a real field.

    Lazy imports: palette_snap imports this module, so they cannot be taken at import
    time.
    """
    import palette_snap
    import render
    im = Image.open(path).convert("RGBA")
    if top_hex is None:
        a = np.asarray(im).astype(float)
        reg = palette_snap._regions(a)
        if not reg or not reg["top"].any():
            return 10 ** 6
        med = np.median(a[:, :, :3][reg["top"]], 0)
        top_hex = "".join(f"{int(v):02x}" for v in med)
    # spill=False on purpose. This measures whether the TOP SURFACE tiles cleanly, and
    # that is all it was calibrated for. With the fringe retint on, a tile's overhanging
    # blades — which are varied by design — register as "off-colour pixels inside the
    # field" and disqualify it: light_beach fell from 0.36 spill to 0.14 that way,
    # because the gate started rejecting the exact property it is supposed to protect.
    sn = palette_snap.snap(im, top_hex, spill=False)
    tgt = np.array([int(top_hex.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)])
    b = np.asarray(render.plateau(sn, 3, 3, level=1)).astype(int)
    op = b[:, :, 3] > 128

    # WHERE THE TOP SURFACE IS, DECIDED BY GEOMETRY. This used to be inferred from
    # COLOUR — take the leftmost and rightmost pixel on each row that matches the target
    # within 2, and call everything between them "inside the field". That is circular:
    # the measurement of how off-colour the surface is depended on which pixels were
    # already the right colour, and it made the metric violently unstable.
    #
    # It cost the maintainer their own reference tile. black_rock's palette is derived
    # FROM `black_rock__over__black_rock/sheet_02_chase2/tile_03.png`, and re-deriving it
    # moved the target by SIX units in one channel (#1e1e24 -> #1e1d1e). That flipped 165
    # pixels into "matching", which widened the row spans past the cliff faces, which
    # swept 1762 WALL pixels into the count as though they were seam. Score 0 -> 1762
    # against a tolerance of 8, and the tile that DEFINES the material was dropped from
    # the wiki for not looking enough like itself.
    #
    # The top surface is a fact about the shape, so ask the shape. Render the same
    # plateau of a probe whose top face is white and whose every other pixel is black;
    # the white is exactly where the tops land, with no colour comparison anywhere. Gaps
    # enclosed by that region are the seams between neighbours — which is what this was
    # always trying to count.
    mask = _assembled_top_mask(im, 3, 3, 1)
    if mask is None or mask.shape != op.shape:
        return 10 ** 6
    holes = _enclosed(mask)
    off = (np.abs(b[:, :, :3] - tgt).max(2) > 2)
    # A gap is a seam whether it shows the wrong colour or shows straight through the
    # ground; both are visible in an assembled field.
    return int((holes & ((op & off) | ~op)).sum())


def _assembled_top_mask(im, cols, rows, level):
    """Where the top faces land once the field is assembled — geometry, not colour."""
    import palette_snap
    import render
    a = np.asarray(palette_snap.canonicalise(im)).astype(np.uint8).copy()
    reg = palette_snap._regions(a.astype(float))
    if not reg or not reg["top"].any():
        return None
    a[:, :, :3] = 0
    a[:, :, :3][reg["top"]] = 255
    b = np.asarray(render.plateau(Image.fromarray(a, "RGBA"), cols, rows, level=level))
    return (b[:, :, 3] > 128) & (b[:, :, 0] > 128)


def _enclosed(mask):
    """Pixels NOT in `mask` that lie between the mask's own extremes on their row.

    Flood fill from the border, but grown with whole-array shifts instead of a Python
    stack. The stack version cost 26 ms of seam_px's 38, and seam_px runs on every
    candidate — it turned a six-minute publish into a twenty-minute one. This returns
    the bit-identical mask.

    A per-row span was tried first and is faster still, but it is an APPROXIMATION of
    connectivity and it moved one verdict in 180. Not worth it for 3 ms: the point of
    rewriting this gate was to stop it being approximately right.
    """
    free = ~mask
    outside = np.zeros_like(mask)
    outside[0, :] = free[0, :]
    outside[-1, :] |= free[-1, :]
    outside[:, 0] |= free[:, 0]
    outside[:, -1] |= free[:, -1]
    while True:
        grown = outside.copy()
        grown[1:, :] |= outside[:-1, :]
        grown[:-1, :] |= outside[1:, :]
        grown[:, 1:] |= outside[:, :-1]
        grown[:, :-1] |= outside[:, 1:]
        grown &= free
        if grown.sum() == outside.sum():
            break
        outside = grown
    return free & ~outside


def _top_hex(path):
    """The palette colour of the TOP material, from the cell directory's own name."""
    import json
    cell = os.path.basename(os.path.dirname(os.path.dirname(os.path.abspath(path))))
    if "__over__" not in cell:
        return None
    try:
        pal = json.load(open(os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "config", "palette.json")))["types"]
    except Exception:
        return None
    return (pal.get(cell.split("__over__")[0]) or {}).get("top")


def _side_hex(path):
    """The palette colour of the SIDE material, from the cell directory's own name."""
    import json
    cell = os.path.basename(os.path.dirname(os.path.dirname(os.path.abspath(path))))
    if "__over__" not in cell:
        return None
    side = cell.split("__over__")[1]
    try:
        pal = json.load(open(os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "config", "palette.json")))["types"]
    except Exception:
        return None
    return (pal.get(side) or {}).get("top")


def select_best(paths, gate=CLEAN_TOP):
    """Pick a cell's best tile: CLEAN TOP first as a gate, then wall quality.

    Order matters and I had it wrong. Ranking on wall score alone surfaced tiles with
    the best cliffs and often the WORST tops — the maintainer reviewed eight of them
    and rejected five on exactly that, "not clean grass is a no go". Every one of those
    cells contained clean-top candidates in the same sheets that the ranking never
    showed (dark_mud had 15 of 32 clean; I displayed one at 0.175).

    So a clean top is a GATE, not a score component: below the gate a tile is out no
    matter how good its wall. Among tiles that pass, the wall decides, because the wall
    is what builds every cliff.

    Gate calibrated on the maintainer's verdict: accepted tops measured 0.944, 0.950,
    0.944; rejected ones 0.153, 0.175, 0.390, 0.425 and 0.907. 0.93 separates them
    exactly. Returns (path, wall_quality, top_share) or None.
    """
    scored = []
    for p in paths:
        q = wall_quality(p)
        f = faces(p)
        if not q or not f or not f["top"]:
            continue
        scored.append((p, q, float(f["top"]["share"])))
    if not scored:
        return None
    seamless = [x for x in scored if seam_px(x[0], _top_hex(x[0])) <= SEAM_TOL]
    # The WALL must be the material the cell asked for. "X over Y" is a claim about two
    # materials and nothing downstream can turn soil into snow, so this belongs here
    # rather than in postprocess — 9 of 56 cells shipped a wall that was not Y at all
    # until it was checked.
    side = _side_hex(paths[0]) if paths else None
    pool = [x for x in seamless
            if overhang(x[0]) >= MIN_OVERHANG and fringe_clarity(x[0]) >= MIN_CLARITY
            and (not side or wall_material_err(x[0], side) <= MAX_WALL_ERR)]
    if not pool:
        # No tile in this cell has the transition. Offer the best that at least tiles
        # cleanly rather than nothing, but the caller should treat the cell as needing
        # regeneration — no ranking can conjure a spill that was never generated.
        pool = seamless or [x for x in scored if x[2] >= gate] or scored
    return max(pool, key=lambda x: x[1]["score"])

def clears_bar(path, top_hex=None, side_hex=None, side_wall_hex=None, same=False,
               min_wall=1.0):
    """THE bar. One function, so two components cannot disagree about it.

    Returns (ok, reason). `reason` is the first gate that rejected, or None.

    This exists because the same bug has now happened three times. chase decides which
    cells still need generation; publish decides which tiles ship. Each grew its own
    copy of "is this tile acceptable", and every time a gate was added to one it drifted
    from the other:

      * first the wall SCORE diverged, and publish shipped tiles at wall 0.00 from cells
        whose chase had been told 2.0 was the minimum;
      * then the wall MATERIAL check landed in publish only, and three cells sat
        unattempted through an entire sweep because chase called them full;
      * then CONTAMINATION landed in publish only, and chase reported 172 cells complete
        against publish's 164.

    Each time the fix was to copy the new check across. That is what guarantees a fourth
    occurrence, so the decision lives here now and both callers ask it.

    publish still applies these as TIERS rather than as a hard gate — a cell with
    nothing better ships its best and is flagged — but the definition of "clears
    everything" is shared, which is the part that kept drifting.
    """
    q = wall_quality(path)
    if not q or q["score"] < min_wall:
        return False, "wall"
    f = faces(path)
    if not f or not f["top"]:
        return False, "faces"
    # MEASURED AGAINST THE COLOUR THE TILE ACTUALLY SHIPS WITH. seam_px derives its
    # target from the tile's OWN median when none is given, but a tile ships snapped to
    # the PALETTE colour — so the gate was measuring a tile that will never exist, and
    # rejecting it for pixels that the snap removes. On a black_rock tile the derived
    # median was #2c2527 against the palette's #1e1e24: 541 seam pixels measured, 0 in
    # what ships.
    #
    # This is the largest filter in the pipeline and it was the least correct. Sampled
    # over 400 tiles across the matrix, seam rejection falls from 56% to 11% when the
    # right target is used: 46% of everything ever generated was thrown away for a
    # defect that postprocess removes.
    if seam_px(path, top_hex) > SEAM_TOL:
        return False, "seam"
    ind = indistinguishable(top_hex, side_hex) if (top_hex and side_hex) else False
    if not same and not ind and overhang(path) < MIN_OVERHANG:
        return False, "spill"
    if fringe_clarity(path) < MIN_CLARITY:
        return False, "clarity"
    if not same and top_hex and side_hex:
        if swapped_err(path, top_hex, side_hex) > MAX_SWAP:
            return False, "swapped"
        if top_contamination(path, top_hex, side_hex) > MAX_CONTAMINATION:
            return False, "contamination"
    if not same and side_wall_hex:
        if wall_material_err(path, side_wall_hex) > MAX_WALL_ERR:
            return False, "wall_material"
    return True, None


def wall_quality(path, ideal_contrast=26.0, tol=18.0):
    """Score the WALLS on the three things the maintainer actually judges them on.

    The walls are the product: they become every cliff and mountain face in the game,
    and postprocess can only recolour them — it cannot invent structure that was never
    generated. (The flat top, by contrast, is free: palette_snap rewrites the whole top
    surface, so a source measured at 0.547 flat with visible grass still lands at
    1.000.) So a sheet is kept or discarded on its walls, judged as:

      1. DOES IT TILE WITH ITSELF, seamlessly, horizontally AND vertically. A cliff is
         built from many copies of this one wall, so a mismatch at the wrap becomes a
         hard line repeated across the whole rock face — the same class of defect that
         plagued tiles2's ground tiles. `seam_h` / `seam_v` measure the discontinuity
         at the wrap; LOWER IS BETTER.
      2. IS IT DISCREET — it must read as background rock, not compete with the scene.
         This is the one that inverts a naive metric: more contrast is NOT better past
         a point. `spread` is scored against a target band (`ideal_spread`), so both a
         dead flat cardboard wall and a garish noisy one lose.
      3. DOES IT HAVE REAL STRUCTURE at all — `edges`, the mean local gradient. A smooth
         gradient can carry many distinct colours while having no texture whatsoever,
         so a colour count alone cannot see this.

    `score` is 0..~10, higher better. Reported alongside the raw parts so a rejection
    can always be explained by which criterion failed.
    """
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(float)
    h, w = a.shape[:2]
    op = a[:, :, 3] > 200
    if not op.any():
        return None
    # The diamond is MEASURED, via the one function that already does it correctly, so
    # all three modules agree on where the wall starts. This used to assume the usual
    # 2:1 diamond (half-height = bw/4 = 16), but tiles 3.0's top is 64x28 — half-height
    # 14 — so the mask began 2 rows BELOW the true top of the wall. The same off-by-two
    # was found and fixed in palette_snap._regions and flatness._surfaces and was left
    # here, in the function that RANKS every candidate and gates the chase.
    #
    # Those two rows are not incidental: they are exactly where the top material's lip
    # sits, which means seam_v — the term that scores whether a wall repeats DOWNWARDS —
    # was blind to the band it exists to measure. Measured on
    # grass__over__grass/sheet_01_explicit/tile_14.png the true wall runs rows 38..54 at
    # centre and this mask ran 41..54.
    import palette_snap
    reg = palette_snap._regions(a)
    if not reg:
        return None
    wall = _erode(reg["left"] | reg["right"], 1)
    if wall.sum() < 40:
        return None

    rgb = a[:, :, :3]
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    # THE FRINGE IS THE OTHER MATERIAL, so it is not part of the wall's statistics.
    # Every other wall measurement in this pipeline already says so and cuts the same
    # way — fringe_clarity, wall_material_err, palette_snap.retint_spill and
    # retint_spill all take each column's lower 60%. wall_quality was the only one that
    # did not, and it is the one that GATES.
    #
    # The cost was severe and invisible. `seam_v` compares the top two rows of the wall
    # against the bottom two; on an X-over-Y tile the top rows ARE the overhang that
    # MIN_OVERHANG separately requires, so the term was largely a restatement of how far
    # apart the two materials sit in brightness: r(pair's palette luminance separation,
    # seam_v) = +0.565 over 12,847 tiles, collapsing to +0.133 measured on the body.
    # That made the wall gate unsatisfiable BY CONSTRUCTION for high-contrast pairs —
    # wall >= 2.0 passed 56.8% of tiles at low luminance separation and 12.7% at high —
    # and the 19 cells that could not reach three candidates were exactly those pairs.
    #
    # Worse, it inverted the ranking against the maintainer's own first criterion:
    # r(overhang, wall score) = -0.156, i.e. the tile with the better transition scored
    # the worse wall. Re-ranked on the body, grass-over-snow's top pick goes from a
    # BROWN wall to a snow wall with grass spilling over it.
    body = np.zeros_like(wall)
    for x in np.unique(np.where(wall)[1]):
        c = np.where(wall[:, x])[0]
        body[c.min() + int(0.4 * (c.max() - c.min())):c.max() + 1, x] = True
    body &= wall
    if body.sum() < 40:
        body = wall

    v = lum[wall]
    mean = float(v.mean()) or 1.0
    contrast = float(v.std())          # absolute, dark-material safe
    spread = contrast / mean           # kept as a diagnostic only

    gy = np.abs(np.diff(lum, axis=0, prepend=lum[:1]))
    gx = np.abs(np.diff(lum, axis=1, prepend=lum[:, :1]))
    inner = _erode(wall, 1)
    edges = float(((gx + gy) / 2.0)[inner].mean()) if inner.sum() else 0.0

    # --- tiling seams -------------------------------------------------------
    # A wall repeats by the TILE pitch: horizontally the next tile's wall starts one
    # tile-width along, vertically the next elevation level stacks one face-height up.
    # So the honest test is to compare each edge of the wall band against the edge it
    # will actually abut, and see how big the jump is relative to the wall's own
    # internal variation — a seam only reads as a line if it is worse than the texture.
    def _seam(axis, region=None):
        region = wall if region is None else region
        prof = []
        idx = np.where(region.any(axis=axis))[0]
        if len(idx) < 6:
            return None
        lo, hi = int(idx.min()), int(idx.max())
        for i in (lo, lo + 1, hi - 1, hi):
            band = region.take(i, axis=1 - axis)
            vals = lum.take(i, axis=1 - axis)[band]
            prof.append(float(vals.mean()) if band.sum() else None)
        if any(p is None for p in prof):
            return None
        near = (prof[0] + prof[1]) / 2.0
        far = (prof[2] + prof[3]) / 2.0
        return abs(near - far) / (mean or 1.0)

    seam_h = _seam(0)
    # seam_v ONLY on the body: vertically, the rows it compares are the fringe.
    # seam_h compares the LEFT and RIGHT edges of the wall, which the fringe spans
    # equally, so it is not contaminated and is left measuring the whole face.
    seam_v = _seam(1, body)

    # --- combine ------------------------------------------------------------
    # discretion: a triangular band around ideal_spread, so flat AND garish both lose
    # Discretion is judged on ABSOLUTE luminance contrast, not on std/mean. The
    # relative form systematically punishes dark materials: a black_rock wall measured
    # LOWER absolute contrast than a snow wall (std 28.8 vs 54.2) yet scored a HIGHER
    # relative spread (0.44 vs 0.33) purely because its mean luminance is a third as
    # big — so every dark type (black_rock, dark_mud, deep_water) scored discretion
    # 0.00 and would have been rejected wholesale. Same trap as tiles2's black_mountain
    # bugs, where relative measures kept misreading near-black art.
    disc = max(0.0, 1.0 - abs(contrast - ideal_contrast) / tol)
    struct = min(1.0, edges / 12.0)                 # saturates: enough is enough
    seams = [s for s in (seam_h, seam_v) if s is not None]
    tiling = 1.0 if not seams else max(0.0, 1.0 - (sum(seams) / len(seams)) / 0.35)
    # Structure GATES the score rather than contributing a share of it. As a weighted
    # sum it did the wrong thing: a deliberately flattened wall tiles perfectly and is
    # maximally discreet, so it scored 4.55 — above two genuinely textured walls — on
    # two criteria it passes only by having no content. A wall with no structure is
    # unusable however well it tiles, so it must collapse the whole score.
    score = 10.0 * (0.55 * tiling + 0.45 * disc) * struct

    px = rgb[wall]
    return {
        "n": int(wall.sum()),
        "contrast": round(contrast, 2), "spread": round(spread, 4),
        "edges": round(edges, 3),
        "uniq": int(len(np.unique((px // 4) * 4, axis=0))),
        "seam_h": None if seam_h is None else round(seam_h, 4),
        "seam_v": None if seam_v is None else round(seam_v, 4),
        "tiling": round(tiling, 3), "discretion": round(disc, 3),
        "structure": round(struct, 3),
        "median": [int(x) for x in np.median(px, axis=0)],
        "score": round(score, 2),
    }


def dE(rgb, target_hex):
    """Perceptual distance from a measured colour to an intended one."""
    t = np.array([int(target_hex.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4)], float)
    return float(np.linalg.norm(_lab(np.array(rgb, float)) - _lab(t)))


def _erode(m, r=2):
    for _ in range(r):
        m = (m & np.roll(m, 1, 0) & np.roll(m, -1, 0)
             & np.roll(m, 1, 1) & np.roll(m, -1, 1))
    return m


def _lab(rgb):
    c = np.asarray(rgb, float) / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    M = np.array([[.4124, .3576, .1805], [.2126, .7152, .0722], [.0193, .1192, .9505]])
    xyz = c @ M.T / np.array([.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], -1)


def score(path, target_hex=None, quant=8):
    """Flatness of one tile's top surface. Eroded by 2px so the silhouette's
    anti-aliased rim can't masquerade as surface texture."""
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(int)
    h, w = a.shape[:2]
    op = a[:, :, 3] > 200
    m = _erode(top_mask(h, w, op) & op, 2)
    if m.sum() < 40:
        return None
    px = a[:, :, :3][m]
    q = (px // quant) * quant
    _, counts = np.unique(q, axis=0, return_counts=True)
    uniq_full = len(np.unique(px, axis=0))
    dom = q[np.argmax(np.all(q == q[np.argmax(counts.max() == counts)], axis=1))] if False else None
    vals, cnts = np.unique(q, axis=0, return_counts=True)
    dom = vals[cnts.argmax()]
    out = {
        "n": int(m.sum()),
        "share": float(cnts.max() / m.sum()),
        "uniq": int(uniq_full),
        "uniq_q": int(len(vals)),
        "std": float(px.std(axis=0).mean()),
        "median": [int(v) for v in np.median(px, axis=0)],
        "dominant": [int(v) for v in dom],
    }
    if target_hex:
        t = np.array([int(target_hex[i:i + 2], 16) for i in (0, 2, 4)], float)
        out["dE"] = float(np.linalg.norm(_lab(out["median"]) - _lab(t)))
    out.update(_geometry(op, w))
    return out


def _geometry(op, w):
    """Is this still a usable isometric ground tile, or did the generator cheat?

    Flatness alone is a gameable target: two bake-off prompts scored a perfect 1.000
    by returning a plain shaded CUBE — one uniform top, no distinct wall material, and
    in one case undersized art that would not tessellate. Perfectly flat and perfectly
    useless. So a candidate must also FIT THE GRID (span the full canvas width, since
    neighbouring diamonds have to meet edge to edge) and actually HAVE a front face
    below the diamond for the wall material to live on."""
    ys, xs = np.where(op)
    if not len(xs):
        return {"geom_ok": False, "why": "empty"}
    bw = int(xs.max() - xs.min() + 1)
    fills = bw >= w - 1                    # full-width: tessellates without a gap
    dia_bottom = int(ys.min()) + bw / 2.0  # the diamond's own lower vertex
    has_face = int(ys.max()) > dia_bottom + 2
    return {"geom_ok": bool(fills and has_face), "bbox_w": bw,
            "why": "" if (fills and has_face) else
                   ("not full width" if not fills else "no front face")}


def main():
    args = sys.argv[1:]
    target = None
    if args and args[0] == "--hex":
        target = args[1].lstrip("#")
        args = args[2:]
    rows = []
    for p in args:
        s = score(p, target)
        if s:
            rows.append((s["share"], p, s))
    rows.sort(reverse=True)
    for sh, p, s in rows:
        de = f" dE={s['dE']:5.1f}" if "dE" in s else ""
        print(f"  share={s['share']:.3f} uniq={s['uniq']:5d} std={s['std']:6.2f}{de} "
              f"rgb={s['median']}  {p.split('/')[-1]}")
    if rows:
        print(f"\nBEST: {rows[0][1]}  share={rows[0][0]:.3f}")


if __name__ == "__main__":
    main()
