"""Measure whether a tile REPEATS VERTICALLY — whether a visible BAND appears in a
cliff where one elevation level meets the next.

Why this exists
---------------
The maintainer's correction, which inverts the target for the diagonal of the matrix:

    "some tiles look very good to have on top - but they repeat very poorly vertically.
     Tiles like this will be marked 'top only' and will need backup from the 'same over
     same' in order to build a nice looking wall. This is why 'same over same' is extra
     important to get right and it doesn't have to have an edge that 'spills over' like
     the rest of the 'x over y' should have. In fact its best if 'same over same'
     doesn't have that spill-over-effect, becouse it's that effect that make the tile
     hard to repeat vertically."

So X-over-Y and X-over-X want OPPOSITE things and the pipeline currently only knows how
to ask for one of them: `flatness.MIN_OVERHANG = 0.25` gates every cell, including the
14 whose entire job is to stack. It selects for the lip on exactly the tiles the lip
ruins. This module is the other half of that judgement — the measurement that says a
tile stacks cleanly, so X-over-X can be selected on it instead.

THE TEST, and why it is done on the assembled cliff
---------------------------------------------------
Stack the tile at levels 0,1,2,3 in ONE column and look at the cliff face that results.
A band is not a property of a tile, it is a property of the relationship between the art
and the stacking pitch — the same reason `pitch.py` measures an assembled field rather
than a tile, and the same reason `flatness.seam_px` measures a rendered plateau.

The cliff repeats with period `level_px`, so every pixel of it has a PHASE: how many
rows it sits above the bottom of its own block. Fold the cliff by that phase and average
each phase's colour in CIELab, and a band is exactly what the fold makes visible — a
phase whose mean colour sits away from the body of the wall. All three sources the
defect has collapse into that one number:

  * an overhanging LIP of top material sitting on top of each wall segment lands at the
    high phases (`level_px - 1` downward) and pulls them toward the top material;
  * an abrupt luminance STEP at the level boundary is the gap between phase 0 (the
    block's dark occluded base) and phase `level_px - 1` (the next block's lit rim) —
    `palette_snap.middle_floor` measured that profile directly: +22 to +35 on the rim,
    -18/-36/-44 over the last three rows;
  * the TOP SURFACE'S OWN COLOUR showing where it should be hidden is a leak, and
    because the fold is taken over every opaque pixel below the cap's top face — not
    over a wall mask — leaked top pixels are simply part of the cliff and raise their
    phase's mean in proportion to how much of the row they cover and how far their
    colour is from the rock's. `leak` counts them separately as well.

STACK AT THE GAME'S LEVEL HEIGHT, NOT AT THE TILE'S OWN WALL HEIGHT. `render.plateau`
derives its pitch per tile from `render.wall_height`, which is right for LOOKING at one
tile and wrong for judging it: the game stacks every tile in a world at one shared
`LEVEL_PX = 16` (games2/shared/src/index.ts, from maps2), so a tile whose wall is
shorter than that leaks its top surface in play and a tile measured at its own pitch
never shows it. Measured over the 235 published candidates, 4 have a wall height of 4,
5, 6 and 9 px because ONE column of their silhouette is malformed — judged at their own
pitch they stack into a squashed 4px-striped cliff and score as if it were fine.

WHAT THIS DOES NOT SAY. A dead flat wall has no band because it has nothing at all:
`ice__over__ice/2` scores 0.91, the best number in the set, with a right face that is a
single colour (texture 0.69 against a 9.84 median). Low `band` is necessary, not
sufficient — it has to be read next to `flatness.wall_quality`'s `structure` gate, which
exists to reject exactly that tile. `texture` is reported here so the two can be seen
together without a second pass.

  python3 tiles/pipeline/vertical.py tiles/review/grass__over__grass/*_after.webp
  python3 tiles/pipeline/vertical.py --calibrate            # the distribution, X/X vs X/Y
  python3 tiles/pipeline/vertical.py --montage out.png      # best and worst, stacked
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import flatness
import palette_snap
import pitch
import render

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)

# One elevation level in vertical face pixels. This is the GAME's constant
# (`LEVEL_PX` in games2/shared/src/index.ts, "maps2 LEVEL_PX"), not something measured
# here — a world stacks every tile at the same height, so a tile is only stackable if it
# works at this one. It agrees with the art: `render.wall_height` returns 16 for 216 of
# the 235 published candidates (15 for eleven, 17 for four, and 4/5/6/9 for the four with
# a malformed silhouette column), while the MODAL per-column wall height is 17 on 227 of
# them — so 16 is the largest pitch that still covers the shortest column of a normal
# tile, which is what `render.wall_height` was built to find.
LEVEL_PX = 16

# The band a tile may show at a level boundary, in CIELab dE of a row mean against the
# body of the wall. DERIVED FROM THE TWO POPULATIONS, not from taste:
#
#   published X-over-X (17 tiles):  min 0.91  median 6.24  max 9.45
#   published X-over-Y (218 tiles): min 4.11  median 39.49  max 105.18 (205.18 as a
#                                   score, once the leak penalty below is added)
#
# The threshold that maximises Youden's J over that pair sits at 9.45 — the X-over-X
# maximum, J = 0.954 — and the populations' central 90% do not overlap at all (X-over-X
# p95 = 8.71, X-over-Y p05 = 10.31). 10.0 is that boundary rounded to a number that does
# not move when a tile is added: at 10.0 every X-over-X candidate ever published passes
# and 207 of 218 X-over-Y fail. It is stable under the arbitrary choices in the
# measurement too — over levels 2/3/4/6 and seam widths 3/4/5 rows the X-over-X maximum
# stays at 9.44-9.45 and the AUC between the populations stays 0.979-0.995.
#
# The 11 X-over-Y tiles that pass are not errors. They are the pale-on-pale pairs —
# snow over water, snow over ice, snow over deep_water — where the lip is real but
# carries no contrast against the wall it lands on, so it does not read as a band.
# Verified by eye on the stacked render.
MAX_BAND = 10.0

# Leaked top-surface pixels tolerated in the cliff. 232 of the 235 published candidates
# leak exactly ZERO at LEVEL_PX and the three that leak sit at 66, 66 and 1266 px, so
# any value in that gap works; 8 matches `flatness.SEAM_TOL`, which was set for the same
# reason — a handful of pixels is a stray, a row of them is a grid line.
LEAK_TOL = 8

# A tile whose lattice does not close is not a tile with a bad band, it is a tile that
# cannot be stacked at all. Adding a constant of the same order as the worst band
# measured on real art (105.18 dE, on ice over lava) guarantees it can never outrank one
# that merely bands, while preserving the ordering inside each group so the numbers stay
# readable — the three leaking tiles score 132, 154 and 205 rather than collapsing onto
# one sentinel value.
LEAK_PENALTY = 100.0


def _mark(img):
    """The tile with its top face and its walls painted flat marker colours.

    This is `pitch.marked()` taking an Image rather than a path, and it reuses that
    module's marker colours so the two agree. It has to accept an image because the
    thing worth measuring is the SHIPPED tile — `band()` can postprocess first, exactly
    as `flatness.seam_px` does, and there is no file to point at in between.
    """
    a = np.asarray(img.convert("RGBA")).astype(int)
    reg = palette_snap._regions(a.astype(float))
    if not reg:
        return None
    m = a.copy()
    m[:, :, :3][reg["top"]] = pitch.TOP
    m[:, :, :3][reg["left"] | reg["right"]] = pitch.WALL
    return Image.fromarray(m.astype(np.uint8), "RGBA")


def stack(tile, levels=4, level_px=LEVEL_PX, pad=2):
    """One column of `tile`, `levels` storeys high, at the game's level height.

    `render.plateau` already knows how to stack — back to front, higher storeys drawn
    later so they cover the top of the one they sit on — so it is used directly whenever
    its own pitch is the one we want, which is 227 of the 235 published candidates. It
    derives that pitch from the tile itself, and for the handful whose silhouette forces
    `render.wall_height` far below the level height we place the storeys at `level_px`
    instead. That is plateau's own placement rule for a single column (`y -= f * pitch`)
    with the pitch supplied rather than measured; the two are pixel-identical when the
    pitches agree, which `--selftest` checks.
    """
    if render.wall_height(tile) == level_px:
        return render.plateau(tile, 1, 1, level=0, floors=levels, pad=pad)
    tw, th = tile.size
    out = Image.new("RGBA", (tw + pad * 2, th + pad * 2 + (levels - 1) * level_px),
                    (0, 0, 0, 0))
    for f in range(levels):
        out.alpha_composite(tile, (pad, pad + (levels - 1 - f) * level_px))
    return out


def _erode(m, r=1):
    for _ in range(r):
        m = (m & np.roll(m, 1, 0) & np.roll(m, -1, 0)
             & np.roll(m, 1, 1) & np.roll(m, -1, 1))
    return m


def band(src, levels=4, level_px=LEVEL_PX, top_hex=None, same_material=False,
         seam_rows=None):
    """How badly this tile bands when stacked. LOWER IS BETTER; None if unmeasurable.

    Returns `(score, parts)`. `score` is the worst face's band in CIELab dE, plus
    `LEAK_PENALTY` when the stack leaks top surface into the cliff. `parts` carries every
    number it was built from, including the per-phase profile, so a tile's score can
    always be traced to the row that caused it.

    `src` is a path or an Image. Give `top_hex` (and `same_material` for an X-over-X
    cell) to have the tile POSTPROCESSED before it is measured — that is what a selector
    wants, because it is the shipped tile that has to stack and `palette_snap` changes
    the answer a lot: the same-material path repaints the whole wall in the top's hue and
    saturation, which takes the X-over-X population's median band from 14.44 raw to 6.24
    shipped. Measuring raw art and shipping something else is how a gate ends up
    protecting the wrong property.

    Components:
      band      worst face's seam-zone deviation, dE           <- the headline
      lip       deviation of the rows at the TOP of a block (the overhang)
      base      deviation of the rows at the BOTTOM of a block (the occluded foot)
      step      dE straight across the join, phase 0 against phase level_px-1
      interior  worst deviation AWAY from the join — texture that bands but does not
                mark the boundary, which is why it is reported and not scored
      texture   per-pixel Lab spread of the cliff; read with wall_quality's `structure`,
                since a band of 0 on a dead flat wall means nothing
      leak      top-surface pixels visible inside the cliff (pitch.py's failure, stacked)
      wall_h    the tile's own `render.wall_height`; `short` is how far under level_px
                it falls, which is a rim artefact on real tiles and harmless when the
                leak is 0
    """
    img = Image.open(src).convert("RGBA") if isinstance(src, str) else src.convert("RGBA")
    if top_hex:
        img = palette_snap.snap(img, top_hex, same_material=same_material)
    mk = _mark(img)
    if mk is None:
        return None
    lp = int(level_px)
    K = int(seam_rows or max(2, lp // 4))
    if lp < 8 or K * 2 >= lp - 2:
        return None

    a = np.asarray(stack(img, levels, lp)).astype(float)
    q = np.asarray(stack(mk, levels, lp)).astype(int)
    if a.shape != q.shape:
        return None
    h, w = a.shape[:2]
    op = q[:, :, 3] > 128
    if not op.any():
        return None
    wall = (np.abs(q[:, :, :3] - pitch.WALL).max(2) <= 10) & op
    top = (np.abs(q[:, :, :3] - pitch.TOP).max(2) <= 10) & op
    yy, xx = np.mgrid[0:h, 0:w]

    # The cliff is every opaque pixel from the top of the CAP's wall downwards. Defined
    # by opacity rather than by the wall mask on purpose: a lower storey's top surface
    # showing through is part of what the eye sees on the cliff, and taking the wall mask
    # would silently drop exactly the pixels the defect is made of.
    bottom = np.full(w, -1)
    first_wall = np.full(w, h + 1)
    for x in range(w):
        o = np.where(op[:, x])[0]
        if len(o):
            bottom[x] = int(o.max())
        wy = np.where(wall[:, x])[0]
        if len(wy):
            first_wall[x] = int(wy.min())
    # Eroded against OPACITY, not against the cliff mask: the silhouette's antialiased
    # rim would otherwise dominate whichever phase it lands in, while eroding the cliff
    # itself would delete its topmost row — which is the lip, the thing being measured.
    cliff = op & (yy >= first_wall[None, :]) & _erode(op, 1)
    if cliff.sum() < 200:
        return None

    lab = flatness._lab(a[:, :, :3])
    phase = (bottom[None, :] - yy) % lp
    ox = np.where(op.any(0))[0]
    cx = (int(ox.min()) + int(ox.max())) / 2.0
    seamz = set(range(0, K)) | set(range(lp - K, lp))
    inner = [p for p in range(lp) if p not in seamz]

    parts = {"level_px": lp, "levels": levels, "seam_rows": K,
             "wall_h": int(render.wall_height(img)),
             "leak": int((top & cliff).sum()), "faces": {}}
    parts["short"] = max(0, lp - parts["wall_h"])

    # The two faces are folded SEPARATELY. The generator lights them differently on
    # purpose — that difference is what makes a tile read as a solid block — and
    # `palette_snap.middle_floor` found the end-of-block profile differs with it (+43
    # rim / -34 base on one face against +1 / -53 on the other). Averaging them together
    # measures neither, and a band on one face is a band you can see.
    for face, sel in (("left", xx <= cx), ("right", xx > cx)):
        m = cliff & sel
        if m.sum() < 100:
            continue
        prof = {}
        for p in range(lp):
            sub = m & (phase == p)
            if int(sub.sum()) >= 8:
                prof[p] = lab[sub].mean(0)
        ints = [p for p in inner if p in prof]
        if len(prof) < lp - 2 or len(ints) < 3:
            continue
        # The reference is the MEDIAN of the block's interior phases — the wall's own
        # body colour. Taken over all phases instead it would move with the very band it
        # is meant to expose, since the seam zone is half the rows.
        ref = np.median([prof[p] for p in ints], axis=0)
        d = {p: float(np.linalg.norm(prof[p] - ref)) for p in prof}
        lip = max((d[p] for p in range(lp - K, lp) if p in d), default=0.0)
        base = max((d[p] for p in range(0, K) if p in d), default=0.0)
        parts["faces"][face] = {
            "band": round(max(lip, base), 2),
            "lip": round(lip, 2), "base": round(base, 2),
            "step": round(float(np.linalg.norm(prof[0] - prof[lp - 1]))
                          if 0 in prof and lp - 1 in prof else 0.0, 2),
            "interior": round(max((d[p] for p in ints), default=0.0), 2),
            "texture": round(float(np.std(lab[m].reshape(-1, 3), axis=0).mean()), 2),
            "n": int(m.sum()),
            "profile": {p: round(d[p], 2) for p in sorted(d)},
        }
    if not parts["faces"]:
        return None
    for k in ("band", "lip", "base", "step", "interior"):
        parts[k] = round(max(f[k] for f in parts["faces"].values()), 2)
    # texture takes the MIN across faces, alone among these. Every other number is a
    # defect and the worse face is the one you see; texture is the opposite — it exists
    # to expose a wall that scores well by having nothing on it, and a tile with one dead
    # face and one textured one is that tile. ice__over__ice/2 measures 0.65 left and
    # 0.00 right; the max would report it as textured.
    parts["texture"] = round(min(f["texture"] for f in parts["faces"].values()), 2)
    parts["worst_face"] = max(parts["faces"], key=lambda f: parts["faces"][f]["band"])
    score = parts["band"] + (LEAK_PENALTY if parts["leak"] > LEAK_TOL else 0.0)
    parts["score"] = round(score, 2)
    parts["ok"] = bool(score <= MAX_BAND)
    return round(score, 2), parts


def stacks_cleanly(src, **kw):
    """True when this tile can carry a cliff. The gate an X-over-X cell wants in place
    of `flatness.MIN_OVERHANG`, which asks for the opposite property."""
    r = band(src, **kw)
    return bool(r and r[0] <= MAX_BAND)


# --- seeing it ---------------------------------------------------------------


def montage(items, out_path, levels=4, scale=3, cols=None, pad=10):
    """Stack every tile `levels` high and lay them out with their scores under them.

    A number nobody can check is not evidence. `items` is [(label, src, score)].
    """
    tiles, labels = [], []
    for label, src, sc in items:
        img = Image.open(src).convert("RGBA") if isinstance(src, str) else src
        tiles.append(stack(img, levels))
        labels.append((label, sc))
    cols = cols or len(tiles)
    rows = (len(tiles) + cols - 1) // cols
    cw = max(t.width for t in tiles) * scale + pad * 2
    ch = max(t.height for t in tiles) * scale + pad * 2 + 26
    canvas = Image.new("RGB", (cw * cols, ch * rows), (18, 18, 22))
    dr = ImageDraw.Draw(canvas)
    for i, (t, (label, sc)) in enumerate(zip(tiles, labels)):
        r, c = divmod(i, cols)
        big = t.resize((t.width * scale, t.height * scale), Image.NEAREST)
        x = c * cw + (cw - big.width) // 2
        y = r * ch + pad + (ch - 26 - pad * 2 - big.height)
        canvas.paste(big, (x, y), big)
        txt = f"{label}\n{sc}"
        dr.multiline_text((c * cw + cw // 2, r * ch + ch - 24), txt, fill=(220, 220, 225),
                          anchor="ma", align="center", spacing=2)
    canvas.save(out_path)
    return out_path


# --- calibration -------------------------------------------------------------


def _published():
    """Every published candidate, tagged X-over-X or X-over-Y, from the review manifest."""
    man = json.load(open(os.path.join(ROOT, "review", "manifest.json")))
    for cell, c in man["cells"].items():
        for e in c["candidates"]:
            yield {"key": e["key"], "cell": cell, "same": c["top"] == c["side"],
                   "path": os.path.join(REPO, e["after"])}


def _stat(a):
    a = sorted(a)
    if not a:
        return "n=0"
    q = lambda f: a[min(len(a) - 1, int(f * len(a)))]
    return (f"n={len(a):3d}  min={a[0]:7.2f}  p25={q(.25):7.2f}  med={q(.5):7.2f}  "
            f"p75={q(.75):7.2f}  max={a[-1]:7.2f}")


def calibrate(levels=4):
    pops = {True: [], False: []}
    for rec in _published():
        r = band(rec["path"], levels=levels)
        if r:
            rec["score"], rec["parts"] = r
            pops[rec["same"]].append(rec)
    xx = [r["score"] for r in pops[True]]
    xy = [r["score"] for r in pops[False]]
    print(f"stacked {levels} levels at LEVEL_PX = {LEVEL_PX}\n")
    print(f"X-over-X (same over same) {_stat(xx)}")
    print(f"X-over-Y (the rest)       {_stat(xy)}\n")
    if xx and xy:
        auc = sum((b > a) + 0.5 * (b == a) for a in xx for b in xy) / (len(xx) * len(xy))
        J = [(round(sum(v > t for v in xy) / len(xy) - sum(v > t for v in xx) / len(xx), 6), t)
             for t in np.arange(1, 30, 0.05)]
        top = max(j for j, _ in J)
        lo, hi = min(t for j, t in J if j == top), max(t for j, t in J if j == top)
        print(f"AUC {auc:.4f}   best Youden J {top:.3f} over [{lo:.2f}, {hi:.2f}]   "
              f"MAX_BAND {MAX_BAND}")
        print(f"  at MAX_BAND: X-over-X pass {sum(v <= MAX_BAND for v in xx)}/{len(xx)}, "
              f"X-over-Y pass {sum(v <= MAX_BAND for v in xy)}/{len(xy)}\n")
    for same, label in ((True, "X-over-X"), (False, "X-over-Y")):
        rows = sorted(pops[same], key=lambda r: r["score"])
        show = rows if same else rows[:8] + rows[-8:]
        print(f"{label}:")
        for r in show:
            p = r["parts"]
            print(f"  {r['key']:46s} score={r['score']:7.2f} lip={p['lip']:6.2f} "
                  f"base={p['base']:6.2f} step={p['step']:6.2f} int={p['interior']:6.2f} "
                  f"tex={p['texture']:5.2f} leak={p['leak']:5d}")
        print()
    return pops


def _selftest():
    """stack() must agree with render.plateau wherever plateau's own pitch is ours."""
    n = 0
    for rec in list(_published())[:40]:
        t = Image.open(rec["path"]).convert("RGBA")
        if render.wall_height(t) != LEVEL_PX:
            continue
        tw, th = t.size
        ref = Image.new("RGBA", (tw + 4, th + 4 + 3 * LEVEL_PX), (0, 0, 0, 0))
        for f in range(4):
            ref.alpha_composite(t, (2, 2 + (3 - f) * LEVEL_PX))
        assert np.array_equal(np.asarray(stack(t, 4)), np.asarray(ref)), rec["key"]
        n += 1
    print(f"selftest: stack() == render.plateau on {n} tiles")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="*")
    ap.add_argument("--levels", type=int, default=4)
    ap.add_argument("--calibrate", action="store_true",
                    help="the distribution over every published candidate")
    ap.add_argument("--montage", default=None, help="write best/worst stacked to this png")
    ap.add_argument("--n", type=int, default=8, help="tiles per row in the montage")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        _selftest()
        return
    if args.calibrate or args.montage:
        pops = calibrate(args.levels)
        if args.montage:
            xx = sorted(pops[True], key=lambda r: r["score"])
            xy = sorted(pops[False], key=lambda r: r["score"])
            items = ([(r["cell"].replace("__over__", "/"), r["path"], r["score"])
                      for r in xx[:args.n]]
                     + [(r["cell"].replace("__over__", "/"), r["path"], r["score"])
                        for r in xy[-args.n:]])
            print("wrote", montage(items, args.montage, levels=args.levels, cols=args.n))
        return

    rows = []
    for p in args.images:
        r = band(p, levels=args.levels)
        if r:
            rows.append((r[0], p, r[1]))
    for sc, p, parts in sorted(rows):
        flag = "" if parts["ok"] else "   BANDS"
        print(f"  {sc:7.2f}  lip={parts['lip']:6.2f} base={parts['base']:6.2f} "
              f"step={parts['step']:6.2f} tex={parts['texture']:5.2f} "
              f"leak={parts['leak']:4d}  {os.path.basename(p)}{flag}")


if __name__ == "__main__":
    main()
