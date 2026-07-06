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


def _circ_mean(h):
    r = h * (2 * np.pi / 256.0)
    return float((np.arctan2(np.sin(r).mean(), np.cos(r).mean()) % (2 * np.pi)) * (256.0 / (2 * np.pi)))


def material_target(images):
    """Dominant material colour of a set of tiles, as target hue/sat/value.

    Found as the mode of a coarse (a,b,L) histogram (separates materials by hue
    AND brightness — green vs brown vs white-vs-grey), refined to the local mean,
    then summarised as circular-mean hue + median saturation + median value.
    `chroma` (mean saturation) flags chromatic (grass, dirt, water) vs achromatic
    (snow, stone) materials, which the mask handles differently."""
    A, B, L, H, S, V = [], [], [], [], [], []
    for im in images:
        hsv = np.asarray(im.convert("HSV"), dtype=np.float32)
        al = np.asarray(im.convert("RGBA"))[:, :, 3] > 16
        a, b, l = _abL(hsv)
        A.append(a[al]); B.append(b[al]); L.append(l[al])
        H.append(hsv[:, :, 0][al]); S.append(hsv[:, :, 1][al]); V.append(hsv[:, :, 2][al])
    if not A or sum(len(x) for x in A) == 0:
        return None
    a = np.concatenate(A); b = np.concatenate(B); l = np.concatenate(L)
    h = np.concatenate(H); s = np.concatenate(S); v = np.concatenate(V)
    pts = np.stack([a, b, l], axis=1)
    keys = np.round(pts / 16.0).astype(int)
    uniq, counts = np.unique(keys, axis=0, return_counts=True)
    peak = uniq[counts.argmax()] * 16.0
    sel = np.linalg.norm(pts - peak, axis=1) < 45.0
    return {
        "hue": _circ_mean(h[sel]),
        "sat": float(np.median(s[sel])),
        "value": float(np.median(v[sel])),
        "chroma": float(np.median(s[sel])),
    }


def harmonize(im, target, hue_strength=0.9, sat_strength=0.6, v_strength=0.65):
    """Pull `im`'s MATERIAL pixels toward the target hue/saturation and level their
    mean brightness, keeping texture. The material is selected by a generous
    HUE BAND for chromatic materials (grass/dirt/water — catches every tone of
    that hue), or by low-saturation + brightness for achromatic ones (snow/stone).
    Everything else (dirt sides on grass, flowers, rock) is left untouched."""
    if not target:
        return im.copy()
    hsv = np.asarray(im.convert("HSV"), dtype=np.float32)
    al = np.asarray(im.convert("RGBA"))[:, :, 3]
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    op = al > 16
    hue_t, sat_t, val_t = target["hue"], target["sat"], target["value"]
    if target.get("chroma", sat_t) > 55:                 # chromatic: hue band
        dh = np.abs(((h - hue_t + 128) % 256) - 128)
        m = op & (s > 45) & (dh < 42)
    else:                                                # achromatic: desaturated + value BAND
        # Two-sided value window around the target: a DARK material (black rock,
        # value~56) claims only dark pixels, a BRIGHT one (snow, value~243) only
        # bright pixels. A lower bound alone was degenerate for dark targets —
        # `v > val_t-45` selected the whole tile (incl. the snow half of a
        # black<->snow transition), then mean-leveling crushed it all to near-black.
        m = op & (s < 70) & (np.abs(v - val_t) < 70)
    if m.any():
        dh = (((hue_t - h + 128) % 256) - 128) * hue_strength
        hsv[:, :, 0] = np.where(m, (h + dh) % 256, h)
        hsv[:, :, 1] = np.where(m, np.clip(s + (sat_t - s) * sat_strength, 0, 255), s)
        dv = (val_t - v[m].mean()) * v_strength
        hsv[:, :, 2] = np.where(m, np.clip(v + dv, 0, 255), v)
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
