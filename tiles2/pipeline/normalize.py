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


def _shift0(a, dy, dx):
    """Shift array; vacated border filled with 0 (off-canvas == transparent).
    Unlike _shift (np.roll, wraps), so the tile edge reads as a true silhouette."""
    out = np.zeros_like(a)
    ys_src = slice(max(0, -dy), a.shape[0] - max(0, dy))
    ys_dst = slice(max(0, dy), a.shape[0] - max(0, -dy))
    xs_src = slice(max(0, -dx), a.shape[1] - max(0, dx))
    xs_dst = slice(max(0, dx), a.shape[1] - max(0, -dx))
    out[ys_dst, xs_dst] = a[ys_src, xs_src]
    return out


def _run_len(mask, dy, dx):
    """Length of the maximal consecutive True run through each pixel along
    (dy,dx). Pure-numpy shift-accumulate; no scipy."""
    m = mask.astype(np.int32)
    fwd = np.zeros(mask.shape, np.int32)
    for _ in range(max(mask.shape)):
        nxt = m * (1 + _shift0(fwd, dy, dx))
        if np.array_equal(nxt, fwd):
            break
        fwd = nxt
    bwd = np.zeros(mask.shape, np.int32)
    for _ in range(max(mask.shape)):
        nxt = m * (1 + _shift0(bwd, -dy, -dx))
        if np.array_equal(nxt, bwd):
            break
        bwd = nxt
    return fwd + bwd - m


def fade_outline_alpha(im, darkness_thresh=60, soft_lum=120, run_min=9, thick_max=3,
                       strength=0.6, rim_strength=0.4, min_alpha=0,
                       seam_strength=0.0, seam_jump=70, seam_bright=130, seam_nbr_sat=90,
                       seam_rows=1, thin_lum_light=120, light_value=180,
                       material_target=None, protect_dark_material=True):
    """Soften the generated near-black wireframe OUTLINE by REDUCING its ALPHA
    (toward transparent) — game1 had a similar step. RGB is never modified and
    non-dark pixels are never touched, so it only thins hard black lines.

    A pixel is faded if it is near-black AND any of:
      (a) SILHOUETTE-RIM — touching transparency;
      (b) THIN FRAME LINE — a dark run >= run_min along one of the four orientations
          whose PERPENDICULAR run is <= thick_max (compact dark blobs stay);
      (c) WAIST SEAM (opt-in, seam_strength>0) — the hard line where a dark object
          meets the LIGHT base platform: a near-black px whose pixel DIRECTLY BELOW
          is opaque, much brighter (jump > seam_jump), genuinely bright
          (> seam_bright) and neutral (< seam_nbr_sat sat). The single dy=+1 test
          gives a provable max-vertical-run of 1, so it can never climb a dark
          trunk/crystal; it only softens the object-to-platform contact row (fixes
          the basalt-column case the rim/thin gates miss).
    `material_target` carries the harmonize centroid; a near-black material
    (value<90 == black_mountain) drops the rim + seam components and caps strength so
    the volcanic body cannot dissolve. Handles 64x64 base and 64x128 elevation.
    Re-runnable from raw; every component toggles independently via config.
    """
    im = im.convert("RGBA")
    a = np.asarray(im).astype(np.float32)
    rgb, alpha = a[:, :, :3], a[:, :, 3]
    opaque = alpha > 16
    if not opaque.any():
        return im.copy()

    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    near_black = opaque & (lum < soft_lum)
    core_dark = opaque & (lum < darkness_thresh)

    # On a LIGHT material (pale ice/snow/sand — value > light_value) a thin DARK-GREY
    # line is an unwanted outline, not art: extend the thin detector's luminance
    # ceiling to thin_lum_light there so it also catches grey (lum 60-120) cube edges,
    # which core_dark<60 misses entirely. Dark/mid materials keep the tight <60 gate,
    # so stone/dirt/black_mountain/grass detail is untouched (as verified).
    light_mat = (material_target is not None
                 and float(material_target.get("value", 0)) > light_value)
    thin_ceiling = thin_lum_light if light_mat else darkness_thresh
    thin_dark = opaque & (lum < thin_ceiling)

    trans = ~opaque                                    # silhouette rim (off-canvas == transparent)
    neigh_t = (_shift0(trans, 1, 0) | _shift0(trans, -1, 0)
               | _shift0(trans, 0, 1) | _shift0(trans, 0, -1))
    rim = near_black & neigh_t

    H = _run_len(thin_dark, 0, 1)                      # thin frame lines: long one way, thin across
    V = _run_len(thin_dark, 1, 0)
    Dg = _run_len(thin_dark, 1, 1)
    Ag = _run_len(thin_dark, 1, -1)
    thin = np.zeros(thin_dark.shape, bool)
    thin |= (H >= run_min) & (V <= thick_max)
    thin |= (V >= run_min) & (H <= thick_max)
    thin |= (Dg >= run_min) & (Ag <= thick_max)
    thin |= (Ag >= run_min) & (Dg <= thick_max)
    thin &= thin_dark

    # waist seam (opt-in): near-black px sitting directly ON TOP of a much brighter,
    # neutral, opaque pixel = the dark object's contact row with the light base
    # platform. dy=+1 only -> max vertical run of 1 -> cannot climb into art.
    if seam_strength > 0:
        mx = rgb.max(2); mn = rgb.min(2)
        sat = np.zeros_like(mx); nz = mx > 0
        sat[nz] = (mx[nz] - mn[nz]) / mx[nz] * 255.0
        below_op = _shift0(opaque, -1, 0)              # off-canvas == 0 -> tile-bottom never qualifies
        below_lum = _shift0(lum, -1, 0)
        below_sat = _shift0(sat, -1, 0)
        seam = (core_dark & below_op & (below_lum - lum > seam_jump)
                & (below_lum > seam_bright) & (below_sat < seam_nbr_sat))
        if seam_rows >= 2:
            seam = seam | (core_dark & _shift0(seam, -1, 0))
        seam &= ~rim & ~thin
    else:
        seam = np.zeros(core_dark.shape, bool)

    if (protect_dark_material and material_target is not None
            and float(material_target.get("value", 255)) < 90):
        rim_strength = 0.0                             # near-black terrain rim is real rock
        strength = min(strength, 0.35)
        seam_strength = 0.0                            # and no seam fade on near-black terrain

    # darkness weight: 1 at lum<=darkness_thresh, ramps to 0 at lum>=soft_lum, so
    # light rims (crystal_ice/snow) are spared and only genuinely-black lines fade.
    dark_w = np.clip((soft_lum - lum) / max(1.0, soft_lum - darkness_thresh), 0.0, 1.0)
    reduce = np.zeros(alpha.shape, np.float32)
    reduce = np.where(rim, np.maximum(reduce, rim_strength), reduce)
    reduce = np.where(thin, np.maximum(reduce, strength), reduce)
    reduce = np.where(seam, np.maximum(reduce, seam_strength), reduce)
    reduce = reduce * dark_w

    new_alpha = alpha * (1.0 - reduce)
    if min_alpha > 0:
        faded = reduce > 0
        new_alpha = np.where(faded & (new_alpha < min_alpha), float(min_alpha), new_alpha)
    a[:, :, 3] = np.clip(new_alpha, 0, 255)
    return Image.fromarray(a.astype(np.uint8), "RGBA")
