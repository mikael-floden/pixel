#!/usr/bin/env python3
"""PUDDLE GATE - is a blend tile's minor ground an INTERIOR ISLAND?

THE GATE RUNS ON THE BYTES THAT SHIP. Measure the published post/ file, never the raw
sheet: blends_post shifts every pixel to align the background and suppresses the rim, so
a raw tile that passes proves nothing about the file a consumer downloads. (Measured on
1,200 tiles, raw and post disagree on 20% of passes.)

The maintainer's rule for every level below 50%: "a tile that have ground type that
should be the majority having all 4 top sides being part of its own type. This means a
transition tile like this doesn't have to care about someone else to look good."

Usage:
    python3 puddle_metric.py tiles/blends/grass__with__lava/p20/tile_*.webp
    python3 puddle_metric.py --json <files>          # one JSON object per tile
    python3 puddle_metric.py --debug out.png <file>  # band / off-band overlay

======================================================================================
1. WHAT "THE FOUR TOP SIDES" IS, EXACTLY

The top face is the exact staircase diamond `clean_top.top_mask()` steps out from the
tile's OWN two side corners at the grid's slope (14 rows per 32 columns). Not the alpha
silhouette - that carries grass blades poking above the apex, which `top_mask` returns
separately as `above` and which the game deletes. Not a fitted rhombus either. The
staircase diamond is the only shape that stays collinear with the neighbour's, so it is
the only shape whose "sides" mean anything. Measured on the tree: 987 px, rows 9..38,
side corners at (0,23) and (63,23), 2px apex.

THE BAND IS THE OUTERMOST THREE EROSION RINGS. Measured, not chosen. Lay that diamond on
the game's lattice (dx=32, dy=14, painter's order by r+c) and ask how deep into a tile
a NEIGHBOURING tile's top-face pixel can sit next to it:

    ring 0   128 px   100.0% of it is 8-adjacent to another tile's top face
    ring 1   120 px   100.0%
    ring 2   111 px    84.7%
    ring 3   102 px     0.0%     <- the first ring that can never touch a neighbour

Rings 0-2 are exactly the pixels that are ever seen ALONGSIDE a neighbour's pixels; from
ring 3 inward there is always at least one dominant pixel between the minor ground and
anything outside the tile. 1px would guard only the literally-shared outline; 2px still
leaves ring 2's 84.7%. Band = 359 px of 987 (36%); the protected core is 628 px (64%), so
even a p40 island (~395 px) fits inside the core with room to spare.

======================================================================================
2. NO DOMINANT-VS-MINOR CLASSIFIER IS USED, AND NONE IS NEEDED

Three general classifiers have already failed on this tree (nearest palette colour halves
black_rock by brightness; opponent hue cannot run on black_rock at all; projecting toward
the minor's clean colour read a dark_mud/grass sheet as 0.2% grass). The border does not
need one. It only has to be CONSISTENT WITH THIS TILE'S OWN BACKGROUND - the trimmed
median of its own top face (`tops_post.background_of`), which is the dominant ground
exactly as this tile draws it, whatever the palette claims.

That also discards the right failures: a minor pixel that sits inside the dominant's own
texture spread does not read as a foreign material at a seam. What breaks a seam is a
VISIBLE step, and visibility is measurable without knowing whose pixel it is.

======================================================================================
3. AREA, NOT PIXELS. THE ONE MEASUREMENT THAT MAKES THIS WORK

A per-pixel colour test cannot gate this and no threshold rescues it. Measured over
tiles/tops (90 sheets of PURE single-ground tops), dE76 from each tile's own background,
inside the band:

    grass  'detail'  p50 13.5  p95 45.8      grass  'subtle'  p95 12.7
    lava   'detail'  p50 19.6  p95 59.6      black_rock 'subtle' p95 3.4

A pure grass tile's own blades are further from its background than a mud patch would be.
Any per-pixel dE threshold either passes the patch or fails the grass.

What separates them is SCALE. Ground texture is high frequency - a blade, a sparkle, a
grain, 1-3 px - and it is symmetric about the background. A puddle is an AREA. So the
diamond is median-filtered (5x5, mask-limited) BEFORE the distance is taken. The same
pure tops then read:

    band dE of the smoothed field, averaged over all 15 grounds x 2 flavours:
        p50 3.0   p90 9.7   p95 12.2   p99 16.3   max 18.9

so DE_PATCH = 20 sits above every pure ground's smoothed texture, including grass's
blades and light_soil's grain, while a real patch of another material clears it easily.
The residual over-20 cases in the null are all `detail`-flavour tops, where the generator
drew a deliberate big feature - which at the border IS a border defect and should fail.

THE GATE IS DELIBERATELY CONSERVATIVE. Each sheet is 16 variations of one prompt, so
rejecting a tile whose dominant ground merely has a big feature at the rim costs one
candidate out of 16; passing a tile whose minor ground reaches the rim ships the exact
artefact the maintainer is trying to remove. False positives are cheap, false negatives
are not.

======================================================================================
4. VALIDATED AT THE RENDERING LEVEL, NOT ONLY IN THE ABSTRACT

The band metric is a proxy. The thing it stands for is: drop the tile into a field of
plain tiles of its own ground and see whether anything cuts the seam. That test was run
directly - candidate at the centre of a 3x3, neighbours a flat tile of the CANDIDATE'S
OWN background, every visible seam pixel pair compared, longest connected run of pairs
over 20 dE recorded - over 900 random p10-p40 tiles:

    Spearman(border_impurity, longest visible seam cut)  0.78
    recall against "a cut run longer than 8px"           94.8%  (276/291)
    longest cut among tiles the gate PASSES              median 1px, p90 4px, max 23px
    longest cut among tiles the gate FAILS               median 12px, p90 33px, max 131px

THE NEIGHBOUR MUST BE THE CANDIDATE'S OWN BACKGROUND, and this is not a cheat. Run the
same test with a plain tile from a DIFFERENT sheet and the correlation collapses to 0.49
- because sheet-to-sheet background difference (measured up to 48/255 in one channel
across grass sets) cuts the WHOLE seam whatever the art does. That is a real defect and
it is blends_post's job, not this one's; the two requirements are independent and both
have to hold. Conflating them makes the puddle rule unmeasurable.
"""
from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image

TILES = os.environ.get("TILES_ROOT", "/home/user/pixel/tiles")
sys.path.insert(0, os.path.join(TILES, "pipeline"))
import clean_top as CT          # noqa: E402
import tops_post as TP          # noqa: E402

BAND_RINGS = 3       # sec. 1 - ring 3 is the first that can never touch a neighbour
SMOOTH_RAD = 2       # 5x5 masked median: kills 1-3px texture, keeps any real patch
DE_PATCH = 20.0      # sec. 3 - above every pure ground's smoothed band texture
MAX_BAND_OFF = 0.03  # share of the band allowed to be off-background
MAX_BLOB = 8         # largest connected off-background patch allowed in the band, px
MIN_DIAMOND = 700    # below this the tile has no usable top face at all


# ---------------------------------------------------------------- colour ------------
def srgb_to_lab(rgb):
    """rgb float 0..255, shape (..., 3) -> CIELab, D65. One number has to serve
    black_rock (30,29,30) and snow (235,244,246); RGB distance cannot."""
    c = np.asarray(rgb, float) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883])
    e, k = 216 / 24389.0, 24389 / 27.0
    f = np.where(xyz > e, np.cbrt(xyz), (k * xyz + 16) / 116.0)
    return np.stack([116 * f[..., 1] - 16,
                     500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], -1)


def de76(lab, ref):
    return np.sqrt(((lab - ref) ** 2).sum(-1))


# ---------------------------------------------------------------- geometry ----------
def diamond_of(img):
    """(rgba array, exact staircase top face). Diamond is None if the tile has none."""
    a = np.array(img.convert("RGBA"), int)
    op = a[..., 3] > 128
    if not op.any():
        return None, None
    r = CT.top_mask(op)
    if r is None:
        return a, None
    return a, r[0]


def erode(m):
    e = m.copy()
    e[1:] &= m[:-1]; e[:-1] &= m[1:]
    e[:, 1:] &= m[:, :-1]; e[:, :-1] &= m[:, 1:]
    return e


def rings_of(dia, n=BAND_RINGS):
    out, cur = [], dia.copy()
    for _ in range(n):
        e = erode(cur)
        out.append(cur & ~e)
        cur = e
    return out, cur


def band_and_core(dia, n=BAND_RINGS):
    rs, core = rings_of(dia, n)
    return dia & ~core, core


def masked_median(lab, mask, rad=SMOOTH_RAD):
    """(2r+1)^2 median over MASK-ONLY neighbours. Mask-limited so the diamond's own
    edge does not pull the filter toward the transparent background or the wall."""
    h, w, _ = lab.shape
    planes = []
    for dy in range(-rad, rad + 1):
        for dx in range(-rad, rad + 1):
            p = np.full_like(lab, np.nan)
            m = np.zeros(mask.shape, bool)
            ys0, ys1, xs0, xs1 = max(0, dy), h + min(0, dy), max(0, dx), w + min(0, dx)
            yd0, yd1, xd0, xd1 = max(0, -dy), h + min(0, -dy), max(0, -dx), w + min(0, -dx)
            p[ys0:ys1, xs0:xs1] = lab[yd0:yd1, xd0:xd1]
            m[ys0:ys1, xs0:xs1] = mask[yd0:yd1, xd0:xd1]
            p[~m] = np.nan
            planes.append(p)
    with np.errstate(all="ignore"):
        out = np.nanmedian(np.stack(planes, 0), 0)
    return np.where(np.isnan(out), lab, out)


def label(mask):
    """8-connected component labels (1..n) and their sizes. No scipy."""
    lab = np.zeros(mask.shape, np.int32)
    sizes = [0]
    h, w = mask.shape
    for y0, x0 in zip(*np.nonzero(mask)):
        if lab[y0, x0]:
            continue
        k = len(sizes)
        sizes.append(0)
        stack = [(y0, x0)]
        lab[y0, x0] = k
        while stack:
            y, x = stack.pop()
            sizes[k] += 1
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not lab[yy, xx]:
                        lab[yy, xx] = k
                        stack.append((yy, xx))
    return lab, sizes


def blob_sizes(mask):
    return label(mask)[1][1:]


# ---------------------------------------------------------------- the metric --------
SIDES = ("NW", "NE", "SE", "SW")


def side_of(dia):
    """Split the diamond into its four screen sides about its own centre: NW and NE are
    the two upper edges (never covered by anything - the tile in front is BELOW them),
    SW and SE the two lower ones."""
    ys, xs = np.nonzero(dia)
    cx = (xs.min() + xs.max()) / 2.0
    cy = (ys.min() + ys.max()) / 2.0
    yy, xx = np.mgrid[0:dia.shape[0], 0:dia.shape[1]]
    up = yy <= cy
    left = xx <= cx
    return {"NW": dia & up & left, "NE": dia & up & ~left,
            "SW": dia & ~up & left, "SE": dia & ~up & ~left}


def border_purity(img, clean_rgb=None, rings=BAND_RINGS, de=DE_PATCH, rad=SMOOTH_RAD):
    """How much of the border band is NOT this tile's own dominant ground.

    `border_impurity` is THE NUMBER: the fraction of band pixels whose 5x5-median
    colour is more than `de` dE76 from the tile's own background. `is_puddle` is the
    boolean gate. clean_rgb is optional and never load-bearing - pass it only to see
    how far the tile's background sits from the palette.
    """
    a, dia = diamond_of(img)
    if dia is None or int(dia.sum()) < MIN_DIAMOND:
        return {"ok": False, "why": "no usable top diamond",
                "diamond_px": 0 if dia is None else int(dia.sum())}
    rgb = a[..., :3].astype(float)
    band, core = band_and_core(dia, rings)
    rs, _ = rings_of(dia, rings)
    bg = TP.background_of(rgb, dia)
    sm = masked_median(srgb_to_lab(rgb), dia, rad)
    d = de76(sm, srgb_to_lab(bg))
    off = (d > de) & dia
    band_off = off & band
    sizes = blob_sizes(band_off)
    frac = float(band_off.sum()) / float(band.sum())
    biggest = max(sizes) if sizes else 0
    sides = side_of(dia)
    # SPILL vs BEVEL. Two different defects share the band and only one of them is the
    # maintainer's. Label the off-background regions over the WHOLE diamond: a component
    # that lives in the band AND in the core is a patch of the other ground SPILLING out
    # to the edge - that is the thing the puddle rule forbids. A component confined to
    # the band is the generator's own rim shading, drawn on every tile it makes because
    # it draws a tile as an OBJECT ("At the border/edge they have a line that makes it
    # very obvious this is a tile"); tops_post.rim_suppress already exists to erase it,
    # and it is not a ground-type failure. Reported separately so neither hides the other.
    lab, lsz = label(off)
    spill_ids = set(np.unique(lab[band_off])) & set(np.unique(lab[off & core]))
    spill_ids.discard(0)
    spill = np.isin(lab, list(spill_ids)) & band if spill_ids else np.zeros_like(band)
    out = {
        "ok": True,
        "diamond_px": int(dia.sum()), "band_px": int(band.sum()), "core_px": int(core.sum()),
        "bg": [int(round(v)) for v in bg],
        "border_impurity": round(frac, 4),
        "band_off_px": int(band_off.sum()),
        "band_patches": len(sizes), "band_biggest_patch": int(biggest),
        "spill": round(float(spill.sum()) / float(band.sum()), 4),
        "spill_px": int(spill.sum()),
        "bevel_only_px": int(band_off.sum() - spill.sum()),
        "ring_impurity": [round(float((off & r).sum()) / max(float(r.sum()), 1), 4) for r in rs],
        "side_impurity": {s: round(float((band_off & sides[s]).sum())
                                   / max(float((band & sides[s]).sum()), 1), 4) for s in SIDES},
        "sides_clean": sum(1 for s in SIDES
                           if (band_off & sides[s]).sum() <= 1),
        "core_off_frac": round(float((off & core).sum()) / float(core.sum()), 4),
        # STRICT is the maintainer's sentence read literally: nothing foreign anywhere in
        # the band. GROUND is the same rule with the generator's rim shading excused,
        # because rim_suppress removes that in post and it is not a ground-type failure.
        "is_puddle": bool(frac <= MAX_BAND_OFF and biggest <= MAX_BLOB),
        "is_puddle_ground": bool(float(spill.sum()) / float(band.sum()) <= MAX_BAND_OFF
                                 and (max([lsz[i] for i in spill_ids]) if spill_ids else 0)
                                 <= MAX_BLOB * 4),
    }
    if clean_rgb is not None:
        out["bg_de_from_clean"] = round(float(de76(srgb_to_lab(bg),
                                                  srgb_to_lab(np.asarray(clean_rgb, float)))), 2)
    return out


# ---------------------------------------------------------------- cli ---------------
def debug_png(path, dst, de=DE_PATCH, rad=SMOOTH_RAD, rings=BAND_RINGS, scale=6):
    a, dia = diamond_of(Image.open(path))
    rgb = a[..., :3].astype(float)
    band, core = band_and_core(dia, rings)
    bg = TP.background_of(rgb, dia)
    sm = masked_median(srgb_to_lab(rgb), dia, rad)
    off = (de76(sm, srgb_to_lab(bg)) > de) & dia
    vis = a.copy()
    vis[band & ~off] = [0, 255, 0, 255]
    vis[band & off] = [255, 0, 0, 255]
    vis[core & off, 0:3] = [255, 0, 255]
    im = Image.fromarray(vis.astype(np.uint8), "RGBA")
    w, h = im.size
    im.resize((w * scale, h * scale), Image.NEAREST).save(dst)


def main(argv):
    import argparse, glob, json
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--clean", help="dominant ground's clean colour, #rrggbb (optional)")
    ap.add_argument("--rings", type=int, default=BAND_RINGS)
    ap.add_argument("--de", type=float, default=DE_PATCH)
    ap.add_argument("--rad", type=int, default=SMOOTH_RAD)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--debug", help="write an overlay PNG here (single file only)")
    a = ap.parse_args(argv)
    clean = TP._hex(a.clean) if a.clean else None
    files = []
    for p in a.paths:
        files += sorted(glob.glob(p)) if any(c in p for c in "*?[") else [p]
    if a.debug:
        debug_png(files[0], a.debug, a.de, a.rad, a.rings)
        print("wrote", a.debug)
        return
    for f in files:
        r = border_purity(Image.open(f), clean, a.rings, a.de, a.rad)
        if a.json:
            print(json.dumps(dict(r, file=f)))
        elif not r["ok"]:
            print("%-70s %s" % (os.path.relpath(f, TILES), r["why"]))
        else:
            print("%-58s impurity %6.2f%%  spill %6.2f%%  patch %3d  rings %s  sides %d/4  %s"
                  % (os.path.relpath(f, TILES), 100 * r["border_impurity"],
                     100 * r["spill"], r["band_biggest_patch"],
                     "/".join("%.0f" % (100 * v) for v in r["ring_impurity"]),
                     r["sides_clean"],
                     "PUDDLE" if r["is_puddle"] else
                     ("ground-clean, rim shaded" if r["is_puddle_ground"] else "reaches the edge")))


if __name__ == "__main__":
    main(sys.argv[1:])
