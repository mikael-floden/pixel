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


def mix_fraction(image, ground_a, ground_b):
    """-> {"frac_b": float in [0,1]} or {"uncertain": True} when the meter cannot say."""
    try:
        f = mixmeter.mix_fraction(image, ground_a, ground_b)
    except KeyError:
        return {"uncertain": True}
    if f is None:
        return {"uncertain": True}
    return {"frac_b": float(f)}
