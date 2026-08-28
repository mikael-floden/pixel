"""The shipped mix classifier for fade tiles - a thin, stable interface over mixmeter.

fades_post depends only on this contract; the meter behind it can be retrained or
replaced without touching the publish pass.
"""
from __future__ import annotations

import mixmeter

DESCRIPTION = (
    "region-arbitrated texture+colour meter (mixmeter.py, model cache/meter.npz): "
    "every ground described by prototype MIXTURES learned from tiles/tops (never the "
    "palette), pixels judged by 35 neighbourhood statistics, texture arbitrated per "
    "region with per-pair fitted trust, windows straddling two grounds rejected by a "
    "likelihood gate. Survives the four historical traps: brightness-split black_rock, "
    "chroma-free grounds, palette-vs-art grass, partner-dependent rendition."
)


def mix_fraction(image, ground_a, ground_b, detail=False):
    """-> {"frac_b": float in [0,1]} or {"uncertain": True} when the meter cannot say.

    With detail=True the result also carries "post" (per-pixel probability the pixel is
    ground B) and "mask" (the meter's top-face mask) - the segmentation the two-sided
    alignment steers by, from the same call that prices the mix."""
    try:
        r = mixmeter.mix_fraction(image, ground_a, ground_b, detail=detail)
    except KeyError:
        return {"uncertain": True}
    if r is None:
        return {"uncertain": True}
    if detail:
        f, det = r
        return {"frac_b": float(f), "post": det["post"], "mask": det["mask"]}
    return {"frac_b": float(r)}
