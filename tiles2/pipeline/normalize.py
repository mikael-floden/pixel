"""Colour harmonisation + outline softening for tiles2 post-processing.

**Harmonisation** makes every tile of a type read as the SAME material, without
touching the parts that should stay different (dirt sides, rock, flowers):

  * auto-detect the type's dominant MATERIAL colour from its reference sheet — the
    largest colour cluster (green for grass, white for snow, brown for dirt, …) —
    as a centroid in (a, b, L) space, where a = sat·cos(hue), b = sat·sin(hue),
    L = value. This separates materials by hue AND brightness (so white snow ≠
    grey rock);
  * for each tile, select pixels within `radius` of that centroid (the material)
    and pull their hue+saturation toward it, and shift their MEAN brightness to
    it — keeping each pixel's local variation, so texture/shading survives. Pixels
    far from the centroid are left exactly as-is.

Transitions harmonise twice — once toward the from-material centroid, once toward
the to-material centroid — each masked by its own distance, so both sides snap to
their type's palette.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

_SHIFTS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def _shift(a, dy, dx):
    return np.roll(np.roll(a, dy, axis=0), dx, axis=1)


def _abL(hsv):
    """HSV (0..255 each) -> (a, b, L): a,b = chroma vector, L = brightness."""
    h = hsv[:, :, 0] * (2 * np.pi / 256.0)
    s = hsv[:, :, 1]
    v = hsv[:, :, 2]
    return s * np.cos(h), s * np.sin(h), v


def material_target(images):
    """Dominant material colour of a set of tiles, as {'c': [a,b,L], 'radius': R}.
    Found as the mode of a coarse (a,b,L) histogram, refined to the local mean."""
    A, B, L = [], [], []
    for im in images:
        hsv = np.asarray(im.convert("HSV"), dtype=np.float32)
        al = np.asarray(im.convert("RGBA"))[:, :, 3] > 16
        a, b, l = _abL(hsv)
        A.append(a[al]); B.append(b[al]); L.append(l[al])
    if not A or sum(len(x) for x in A) == 0:
        return None
    pts = np.stack([np.concatenate(A), np.concatenate(B), np.concatenate(L)], axis=1)
    keys = np.round(pts / 16.0).astype(int)
    uniq, counts = np.unique(keys, axis=0, return_counts=True)
    peak = uniq[counts.argmax()] * 16.0
    sel = np.linalg.norm(pts - peak, axis=1) < 40.0
    c = pts[sel].mean(axis=0)
    rad = float(np.percentile(np.linalg.norm(pts[sel] - c, axis=1), 90)) * 1.7
    return {"c": [float(x) for x in c], "radius": max(rad, 35.0)}


def harmonize(im, target, ab_strength=0.8, v_strength=0.65):
    """Pull `im`'s material pixels (those near `target`'s centroid) toward it in
    hue/saturation, and level their mean brightness. Non-material pixels untouched."""
    if not target:
        return im.copy()
    hsv = np.asarray(im.convert("HSV"), dtype=np.float32)
    al = np.asarray(im.convert("RGBA"))[:, :, 3]
    a, b, l = _abL(hsv)
    ca, cb, cl = target["c"]
    R = target["radius"]
    m = (al > 16) & (np.sqrt((a - ca) ** 2 + (b - cb) ** 2 + (l - cl) ** 2) < R)
    if m.any():
        na = a + (ca - a) * ab_strength
        nb = b + (cb - b) * ab_strength
        sat = np.sqrt(na ** 2 + nb ** 2)
        hue = (np.arctan2(nb, na) % (2 * np.pi)) * (256.0 / (2 * np.pi))
        dL = (cl - l[m].mean()) * v_strength
        hsv[:, :, 0] = np.where(m, hue, hsv[:, :, 0])
        hsv[:, :, 1] = np.where(m, np.clip(sat, 0, 255), hsv[:, :, 1])
        hsv[:, :, 2] = np.where(m, np.clip(l + dL, 0, 255), hsv[:, :, 2])
    out = np.asarray(Image.fromarray(hsv.clip(0, 255).astype(np.uint8), "HSV").convert("RGBA")).copy()
    out[:, :, 3] = al
    return Image.fromarray(out, "RGBA")


def neutralize_outline(im, darkness_thresh=60):
    """Recolour the dark silhouette rim toward the interior colour, keep it opaque
    (softens the outer grid seam without eroding the tile)."""
    a = np.asarray(im.convert("RGBA")).astype(np.float32)
    rgb, alpha = a[:, :, :3], a[:, :, 3]
    opaque = alpha > 16
    trans = ~opaque
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    neigh_trans = (_shift(trans, 1, 0) | _shift(trans, -1, 0)
                   | _shift(trans, 0, 1) | _shift(trans, 0, -1))
    target = opaque & neigh_trans & (lum < darkness_thresh)
    if not target.any():
        return im.copy()
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
