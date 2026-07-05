"""Colour normalisation + outline neutralisation for tiles2 post-processing.

Two jobs:

1. Normalise a tile's look to a ref-sprite so every sheet of a ground type reads
   as the same material. We match the MEAN hue/saturation/brightness of the tile's
   opaque pixels to the ref's (additive hue shift, multiplicative sat/value),
   which nudges tone while preserving texture. `strength` (0..1) scales the shift.
   For transitions we use BOTH refs: each pixel is normalised toward whichever ref
   (the "from" material or the "to" material) its hue is closer to — a first-pass
   two-material split (flagged; refine later).

2. Neutralise any residual dark silhouette outline (tiles2 is "no outline"): the
   dark 1px rim is recoloured toward the tile's own interior colour but kept
   OPAQUE, so the black line disappears without eroding the tile (seamless tiling).
"""

from __future__ import annotations

import numpy as np
from PIL import Image

_SHIFTS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def _shift(a, dy, dx):
    return np.roll(np.roll(a, dy, axis=0), dx, axis=1)


def _hsv(img):
    return np.asarray(img.convert("HSV"), dtype=np.float32)   # H,S,V each 0..255


def _opaque(img):
    return np.asarray(img.convert("RGBA"))[:, :, 3] > 16


def stats(img):
    """Mean H/S/V over the tile's opaque pixels (hue as a circular mean)."""
    hsv, op = _hsv(img), _opaque(img)
    if not op.any():
        return None
    h = hsv[:, :, 0][op] * (2 * np.pi / 256.0)
    hue = (np.arctan2(np.sin(h).mean(), np.cos(h).mean()) % (2 * np.pi)) * (256.0 / (2 * np.pi))
    return {"h": float(hue), "s": float(hsv[:, :, 1][op].mean()),
            "v": float(hsv[:, :, 2][op].mean())}


def _apply(hsv, mask, target, cur, strength):
    """Shift masked HSV pixels' means toward `target` (from measured `cur`)."""
    dh = ((target["h"] - cur["h"] + 128) % 256 - 128) * strength
    s_scale = 1 + ((target["s"] / max(cur["s"], 1e-3)) - 1) * strength
    v_scale = 1 + ((target["v"] / max(cur["v"], 1e-3)) - 1) * strength
    hsv[:, :, 0] = np.where(mask, (hsv[:, :, 0] + dh) % 256, hsv[:, :, 0])
    hsv[:, :, 1] = np.where(mask, np.clip(hsv[:, :, 1] * s_scale, 0, 255), hsv[:, :, 1])
    hsv[:, :, 2] = np.where(mask, np.clip(hsv[:, :, 2] * v_scale, 0, 255), hsv[:, :, 2])
    return hsv


def normalize_base(img, ref, strength=1.0):
    cur = stats(img)
    if cur is None or ref is None:
        return img.copy()
    hsv = _hsv(img)
    op = _opaque(img)
    hsv = _apply(hsv, op, ref, cur, strength)
    return _to_rgba(img, hsv)


def normalize_transition(img, ref_from, ref_to, strength=1.0):
    """First-pass: assign each opaque pixel to the nearer ref by hue, normalise
    each group toward its ref. Refine later (e.g. spatial segmentation)."""
    if ref_from is None or ref_to is None:
        return normalize_base(img, ref_from or ref_to, strength)
    hsv, op = _hsv(img), _opaque(img)
    h = hsv[:, :, 0]
    dfrom = np.minimum((h - ref_from["h"]) % 256, (ref_from["h"] - h) % 256)
    dto = np.minimum((h - ref_to["h"]) % 256, (ref_to["h"] - h) % 256)
    g_from = op & (dfrom <= dto)
    g_to = op & (dto < dfrom)
    for mask, ref in ((g_from, ref_from), (g_to, ref_to)):
        if mask.any():
            cur = {"h": _circ_mean(h[mask]), "s": float(hsv[:, :, 1][mask].mean()),
                   "v": float(hsv[:, :, 2][mask].mean())}
            hsv = _apply(hsv, mask, ref, cur, strength)
    return _to_rgba(img, hsv)


def _circ_mean(hvals):
    a = hvals * (2 * np.pi / 256.0)
    return float((np.arctan2(np.sin(a).mean(), np.cos(a).mean()) % (2 * np.pi)) * (256.0 / (2 * np.pi)))


def _to_rgba(orig, hsv):
    rgb = Image.fromarray(hsv.clip(0, 255).astype(np.uint8), "HSV").convert("RGBA")
    out = np.asarray(rgb).copy()
    out[:, :, 3] = np.asarray(orig.convert("RGBA"))[:, :, 3]   # keep original alpha
    return Image.fromarray(out, "RGBA")


def neutralize_outline(img, darkness_thresh=60):
    """Recolour the dark silhouette rim toward the interior colour, keep it opaque
    (removes the black outline without eroding the tile). tiles2 = no outline."""
    a = np.asarray(img.convert("RGBA")).astype(np.float32)
    rgb, alpha = a[:, :, :3], a[:, :, 3]
    opaque = alpha > 16
    trans = ~opaque
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    neigh_trans = (_shift(trans, 1, 0) | _shift(trans, -1, 0)
                   | _shift(trans, 0, 1) | _shift(trans, 0, -1))
    target = opaque & neigh_trans & (lum < darkness_thresh)
    if not target.any():
        return img.copy()
    interior = opaque & ~target
    acc = np.zeros_like(rgb)
    cnt = np.zeros(lum.shape, np.float32)
    im_f = interior.astype(np.float32)
    for dy, dx in _SHIFTS:
        acc += _shift(rgb * interior[:, :, None], dy, dx)
        cnt += _shift(im_f, dy, dx)
    have = cnt > 0
    avg = np.zeros_like(rgb)
    avg[have] = acc[have] / cnt[have, None]
    apply = target & have
    a[:, :, :3] = np.where(apply[:, :, None], avg, rgb)
    return Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGBA")
