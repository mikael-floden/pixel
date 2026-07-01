"""Deterministic hash-based value noise, shared by the plan and the builder.

No RNG: every value is a pure function of (x, y, seed), so the master plan, the
schematic overview, and the detailed tile world all sample the *same* terrain
and can never drift apart. Reproducible and diff-stable.
"""

from __future__ import annotations

import math


def hash01(ix: int, iy: int, seed: int) -> float:
    h = (ix * 374761393 + iy * 668265263 + seed * 362437) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


def _smooth(t: float) -> float:
    return t * t * (3 - 2 * t)


def value_noise(x: float, y: float, seed: int, scale: float) -> float:
    gx, gy = x / scale, y / scale
    ix, iy = math.floor(gx), math.floor(gy)
    fx, fy = gx - ix, gy - iy
    ux, uy = _smooth(fx), _smooth(fy)
    v00 = hash01(ix, iy, seed)
    v10 = hash01(ix + 1, iy, seed)
    v01 = hash01(ix, iy + 1, seed)
    v11 = hash01(ix + 1, iy + 1, seed)
    a = v00 + (v10 - v00) * ux
    b = v01 + (v11 - v01) * ux
    return a + (b - a) * uy


def fbm(x: float, y: float, seed: int, scale: float, octaves: int = 4) -> float:
    total, amp, norm, s = 0.0, 1.0, 0.0, scale
    for o in range(octaves):
        total += amp * value_noise(x, y, seed + o * 101, s)
        norm += amp
        amp *= 0.5
        s *= 0.5
    return total / norm
