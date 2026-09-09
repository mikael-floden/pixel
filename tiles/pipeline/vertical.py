"""Measure the band that appears when a tile is stacked on itself.

Why this exists
---------------
The maintainer's requirement, which inverts the target for the 14 same-over-same cells:

    "some tiles look very good to have on top - but they repeat very poorly vertically.
     Tiles like this will be marked 'top only' and will need backup from the 'same over
     same' in order to build a nice looking wall. This is why 'same over same' is extra
     important to get right and it doesn't have to have an edge that 'spills over' like
     the rest of the 'x over y' should have. In fact its best if 'same over same'
     doesn't have that spill-over-effect, becouse it's that effect that make the tile
     hard to repeat vertically."

`flatness.overhang()` cannot serve this, and not because it is badly tuned — because it
is DEGENERATE on same-over-same. It finds the top material in the wall by HUE, and on
X-over-X the wall is the same material as the top, so there is no hue difference to
find. Measured over all 288 X-over-X tiles on disk it returns exactly 1.000 for
grass/ice/light_soil (100% of tiles) and 0.000 for most grey_stone/black_rock, purely
because of its `saturation > 55` floor. On those cells MIN_OVERHANG was never selecting
for a lip; it was flipping a coin on how saturated the material happens to be. And the
coin landed badly: the published black_rock-over-black_rock picks measure a lip of
+0.436/+0.419/+0.441 against a cell median of +0.044.

WHAT THIS MEASURES, and what was discarded
------------------------------------------
CAP — the luminance step between the top few rows of the wall and the wall's body,
per face, worst face reported. The lip is the top material draped over the cliff top.
On X-over-X it is the same material, so it carries no hue at all — but it does carry a
LUMINANCE and texture step, and that step is what becomes a stripe at every storey.

Two other formulations were built and thrown away, both because they failed the same
acceptance test:

  * A phase-folded CIELab deviation over a 4-level stack (AUC 0.979 separating X-over-X
    from X-over-Y). The separation was an artifact of the POSTPROCESS, not the art:
    X-over-X tiles are published through snap(same_material=True), which repaints the
    whole wall to one hue and compresses its luminance spread, while X-over-Y tiles are
    not. Holding the postprocess constant collapsed it to AUC 0.708.
  * A hue-differential `lip`. Pearson r(overhang, lip) = -0.021 over 282 X-over-X tiles,
    i.e. statistically blind to the thing it was named for, and it moved the WRONG WAY
    on an injected drape in 4 of 5 cells.

  * WRAP — the wall's own top-to-bottom lighting gradient — is measured and reported
    but deliberately NOT part of the score. It rose on only 17 of 36 injected tiles, a
    coin flip: it tracks how the generator shaded the block, not whether a lip is
    present. Including it is what made the combined score fail to separate the prompt
    families.

THE ACCEPTANCE TEST (`--selftest`) is injection, not correlation. It paints the top
material, darkened, over the upper 30% of every wall column — a synthetic version of
exactly the defect — and asserts the score RISES. Correlating against existing metrics
only proves agreement with whatever they already measure; injection proves the metric
responds to the defect itself. `cap` rises on 33 of 36 tiles. That is the number to
beat if this is ever replaced.

USE IT AS A RANKING, NOT A TIGHT GATE. Six cells is not enough to fit a threshold on
without over-fitting, and the maintainer's ask is for ALTERNATIVES to choose between
rather than for one machine-picked winner. So X-over-X candidates are ordered by cap
ascending and the maintainer picks; the only hard floors stay the ones that were
calibrated on real verdicts (wall quality, seam).

  python tiles/pipeline/vertical.py --selftest
  python tiles/pipeline/vertical.py tiles/matrix/grass__over__grass/sheet_01_explicit/tile_14.png
"""

from __future__ import annotations

import argparse
import glob
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SEAM_ROWS = 4      # rows of wall counted as "the cap"; results are stable over 3..5


def _lum(rgb):
    return 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]


def parts(a, seam_rows=SEAM_ROWS):
    """`cap` and `wrap` for one tile array, or None if the wall cannot be found.

    Both faces are measured separately and the WORST is reported: the generator lights
    left and right differently, and a band on one face is a band in the game.
    """
    import palette_snap
    reg = palette_snap._regions(a)
    if not reg:
        return None
    lum = _lum(a[:, :, :3])
    cap, wrap = [], []
    for k in ("left", "right"):
        w = reg[k]
        if w.sum() < 60:
            continue
        top, body, first, last = [], [], [], []
        for x in np.unique(np.where(w)[1]):
            ys = np.where(w[:, x])[0]
            if len(ys) < seam_rows * 2 + 2:
                continue
            t0, t1 = int(ys.min()), int(ys.max())
            top.extend(lum[t0:t0 + seam_rows, x])
            body.extend(lum[t0 + seam_rows:t1 + 1, x])
            first.append(lum[t0, x])
            last.append(lum[t1, x])
        if len(top) < 10 or len(body) < 10:
            continue
        cap.append(abs(float(np.mean(top)) - float(np.mean(body))))
        wrap.append(abs(float(np.mean(first)) - float(np.mean(last))))
    if not cap:
        return None
    return {"cap": max(cap), "wrap": max(wrap)}


def band(path, seam_rows=SEAM_ROWS):
    """The score. LOWER IS BETTER. Measured on the RAW tile on purpose — postprocess
    flattens an X-over-X wall, which would hide the very band being looked for."""
    try:
        a = np.asarray(Image.open(path).convert("RGBA")).astype(float)
    except Exception:
        return None
    p = parts(a, seam_rows)
    return p["cap"] if p else None


def _inject(path, frac=0.30, darken=0.75):
    """Paint the top material, darkened, over the upper `frac` of every wall column."""
    import palette_snap
    a = np.asarray(Image.open(path).convert("RGBA")).astype(float).copy()
    reg = palette_snap._regions(a)
    if not reg or not reg["top"].any():
        return None
    med = np.median(a[:, :, :3][reg["top"]], 0) * darken
    for k in ("left", "right"):
        w = reg[k]
        for x in np.unique(np.where(w)[1]):
            ys = np.where(w[:, x])[0]
            a[ys[:max(1, int(len(ys) * frac))], x, :3] = med
    return a


def selftest(root=None, per_cell=6):
    """Assert the score RISES on an injected drape. See the module docstring for why
    this is the acceptance test rather than a correlation against another metric."""
    root = root or os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "matrix")
    cells = sorted({os.path.basename(d) for d in glob.glob(os.path.join(root, "*__over__*"))})
    ok = n = 0
    for c in cells:
        if c.split("__over__")[0] != c.split("__over__")[1]:
            continue
        for p in sorted(glob.glob(os.path.join(root, c, "sheet_*", "tile_*.png")))[:per_cell]:
            a0 = parts(np.asarray(Image.open(p).convert("RGBA")).astype(float))
            inj = _inject(p)
            a1 = parts(inj) if inj is not None else None
            if not a0 or not a1:
                continue
            n += 1
            ok += a1["cap"] > a0["cap"]
    return ok, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        ok, n = selftest()
        print(f"injection selftest: cap rises on {ok}/{n} tiles"
              f"{'  OK' if n and ok / n >= 0.85 else '  REGRESSION'}")
        return 0 if n and ok / n >= 0.85 else 1
    for p in args.paths:
        a = np.asarray(Image.open(p).convert("RGBA")).astype(float)
        d = parts(a)
        print(f"{p}: cap {d['cap']:.2f} wrap {d['wrap']:.2f}" if d else f"{p}: no wall")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
