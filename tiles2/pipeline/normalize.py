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


def harmonize(im, target, hue_strength=0.9, sat_strength=0.6, v_strength=0.65, hue_band=42,
              avoid_hue=None, avoid_value=None, min_value=0, dark_include=0):
    """Pull `im`'s MATERIAL pixels toward the target hue/saturation and level their
    mean brightness, keeping texture. The material is SELECTED by the hue of its own
    RAW colour (`target['select_hue']` — the auto-detected pre-palette hue) so that a
    forced PALETTE target far from the raw colour (e.g. grass raw yellow-green ~70 ->
    palette teal ~122) still selects the right pixels, then the pixels are SHIFTED to
    the palette hue. `avoid_hue` is the other material's raw hue in a transition: a
    pixel is only claimed if it's closer to THIS material's raw hue than the other's,
    so the sand pass can't grab (and brown-out) the grass pixels. Achromatic materials
    (snow/stone) select by low-saturation + a value band. Dirt sides, flowers, rock are
    left untouched."""
    if not target:
        return im.copy()
    hsv = np.asarray(im.convert("HSV"), dtype=np.float32)
    al = np.asarray(im.convert("RGBA"))[:, :, 3]
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    op = al > 16
    hue_t, sat_t, val_t = target["hue"], target["sat"], target["value"]
    sel_h = float(target.get("select_hue", hue_t))       # RAW hue for masking (palette-safe)
    if target.get("chroma", sat_t) > 55:                 # chromatic: hue band around RAW hue
        dh = np.abs(((h - sel_h + 128) % 256) - 128)
        m = op & (s > 45) & (dh < hue_band)
        if avoid_hue is not None:                        # transition: claim only if nearer to US
            da = np.abs(((h - float(avoid_hue) + 128) % 256) - 128)
            m = m & (dh <= da)
    else:                                                # achromatic: desaturated + value BAND
        # Two-sided value window around the material's RAW value (select_value, not the
        # possibly-far palette value) — so a pale grey-stone variant (value ~178) still
        # gets claimed and normalised to the palette grey instead of being left near-white
        # and reading as SNOW. A DARK material (black rock) claims only dark pixels, a
        # BRIGHT one (snow) only bright. `avoid_value` = the other achromatic material's
        # raw value in a transition: claim a pixel only if it's nearer THIS material's
        # value, so the stone pass can't grab snow and the snow pass can't grab stone.
        sel_v = float(target.get("select_value", val_t))
        dv0 = np.abs(v - sel_v)
        # `s < 70` treats saturated pixels as untouchable accents — but a near-black
        # material (black_mountain volcanic rock) has pixels like [15,16,22] whose HSV
        # saturation is INFLATED to 80-110 purely by the tiny channel spread at very low
        # value (sat = (max-min)/max). Those aren't real accents, they're the dark rock —
        # yet the `s < 70` gate SKIPS them, so mean-leveling + the min_value floor never
        # reach them and they stay pitch-#000000-black in transitions. `dark_include` (set
        # only when harmonizing the dark material) also claims any pixel below that value,
        # regardless of its noisy saturation, so the rock gets lifted to a charcoal grey.
        sat_ok = (s < 70)
        if dark_include:
            sat_ok = sat_ok | (v < float(dark_include))
        m = op & sat_ok & (dv0 < 70)
        if avoid_value is not None:
            m = m & (dv0 <= np.abs(v - float(avoid_value)))
    if m.any():
        dh = (((hue_t - h + 128) % 256) - 128) * hue_strength
        hsv[:, :, 0] = np.where(m, (h + dh) % 256, h)
        hsv[:, :, 1] = np.where(m, np.clip(s + (sat_t - s) * sat_strength, 0, 255), s)
        dv = (val_t - v[m].mean()) * v_strength
        # FLOOR at min_value: mean-leveling toward a dark target is a constant downward
        # shift that clips a material's darkest texture to 0 (#000000) — worst on a dark
        # target dragged lower still in a transition. Flooring keeps black rock a dark
        # charcoal instead of pitch black; harmless for bright materials (always > floor).
        hsv[:, :, 2] = np.where(m, np.clip(v + dv, float(min_value), 255), v)
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


# Actual generated top-diamond geometry (measured on the sheets, NOT the narrower
# nominal 30px/apex-8): apex ~y6, full 64px width by ~y22, S vertex ~y38 — a standard
# 64x32 iso diamond. The nominal mask was far too small, so the perimeter target missed
# the real (wider) diamond edge, letting crystal_ice's bright facet edge tile into a
# 'chessboard' lattice.
_DIAMOND_APEX_Y = 6
_DIAMOND_H = 32


def _diamond_mask(h, w):
    """Top-diamond mask matching the ACTUAL tile geometry, so we can target the diamond
    PERIMETER without ever touching the front face below it."""
    m = np.zeros((h, w), bool)
    cx = w // 2
    for y in range(_DIAMOND_APEX_Y, min(h, _DIAMOND_APEX_Y + _DIAMOND_H)):
        t = (y - _DIAMOND_APEX_Y) / _DIAMOND_H
        hw = int(round((w / 2) * (1 - abs(2 * t - 1))))
        m[y, max(0, cx - hw):min(w, cx + hw)] = True
    return m


def _erode_m(m, r):
    for _ in range(r):
        m = m & _shift0(m, 1, 0) & _shift0(m, -1, 0) & _shift0(m, 0, 1) & _shift0(m, 0, -1)
    return m


def _dilate_m(m, r):
    for _ in range(r):
        m = m | _shift0(m, 1, 0) | _shift0(m, -1, 0) | _shift0(m, 0, 1) | _shift0(m, 0, -1)
    return m


def clean_top_rim(im, material_target=None, factor=0.86, band=4, strength=1.0,
                  top_frac=0.58, protect_dark_material=True, edge_margin=22):
    """Flatten the baked rim around the WHOLE top diamond so a clean tile tessellates
    with NO seam at any shared vertex/edge — a dark outline (stone/grass) OR a bright
    block-edge bevel (crystal_ice/snow, which tiles into a white 'chessboard' lattice).

    This matters because the map fills large areas by REPEATING one clean tile, so
    that tile must be flawless when tiled — a single dark edge pixel becomes a dot at
    every junction. The dots are the diamond's edge rim sitting darker than the
    interior (snow interior ~210 vs rim ~180; stone ~188 vs SE-edge ~85). An earlier
    silhouette-only pass missed the LOWER diamond edges (SE/SW): they border the front
    face, so they aren't silhouette-adjacent, yet they land on shared vertices when
    tiled. Fix = target the whole top-diamond PERIMETER geometrically (diamond mask
    minus its eroded interior). The diamond mask covers ONLY the top surface, so the
    front soil/rock FACE is never touched, and interior detail lives in the eroded core
    and is spared. Runs BEFORE gap_close so the mask aligns with the un-grown diamond.
    Threshold is RELATIVE to the material brightness (mv*factor); dark rim pixels are
    recoloured toward the material's own lit body. Near-black terrain (value<70) is
    skipped. (`band` = perimeter width; `top_frac` kept for config compat, unused.)
    """
    a = np.asarray(im.convert("RGBA")).astype(np.float32)
    rgb, al = a[:, :, :3], a[:, :, 3]
    op = al > 16
    if not op.any():
        return im.convert("RGBA")
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    mv = float(material_target.get("value", 180)) if material_target else 180.0
    if protect_dark_material and mv < 35:             # only true near-black terrain (black_mountain
        return im.convert("RGBA")                      # ~18); the palette's dark grass (~59) still cleans
    h, w = op.shape
    dm = _diamond_mask(h, w)
    core = _erode_m(dm, band)
    perim = _dilate_m(dm, 2) & ~core                  # diamond edge ring (+2px for AA/growth)
    body_mask = op & core
    if not body_mask.any():
        body_mask = op & dm
    if not body_mask.any():
        return im.convert("RGBA")
    # the material's own body colour (median of the diamond interior). Perimeter pixels
    # that DEVIATE from it — a dark baked outline (stone/grass) OR a bright block-edge
    # bevel (crystal_ice/snow, which tiles into a white 'chessboard' lattice) — are
    # pulled toward it, so the shared edges vanish and the clean tile tessellates flat.
    gcolor = np.median(rgb[body_mask], axis=0)
    dist = np.sqrt(((rgb - gcolor[None, None, :]) ** 2).sum(axis=2))
    target = op & perim & (dist > edge_margin)
    if not target.any():
        return im.convert("RGBA")
    blended = rgb * (1.0 - strength) + gcolor[None, None, :] * strength
    a[:, :, :3] = np.where(target[:, :, None], blended, rgb)
    return Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGBA")


def close_iso_gaps(im, alpha_thresh=16, grow=2):
    """Close the hairline GRID SEAM between tessellating iso tiles.

    The in-game 'grid'/'Ʌ' seam is NOT a dark outline on the tiles — it is the dark
    BACKGROUND showing through 1-2px gaps along every diamond edge, because the
    generated diamond silhouette (soft/antialiased rim) does not fully tile: adjacent
    diamonds leave a thin transparent lane the void shows through (verified: seam
    pixels == background luminance, and a magenta-background tessellation bleeds
    magenta along every edge).

    Fix = a small OUTWARD bleed: harden the silhouette (any alpha>thresh -> opaque)
    and grow it `grow` px, filling each newly-covered pixel with the average of its
    opaque neighbours at full alpha. Neighbouring diamonds then overlap by `grow` px
    (same material, drawn back-to-front) so no gap remains. Interior pixels and any
    interior transparency (they have no transparent-outside neighbour reached by the
    grow front from the silhouette) are untouched. Base + transition floor tiles only;
    NOT elevation object art (a lone sprite must keep its true silhouette).
    """
    a = np.asarray(im.convert("RGBA")).astype(np.float32)
    rgb, al = a[:, :, :3], a[:, :, 3]
    al = np.where(al > alpha_thresh, 255.0, 0.0)       # harden AA rim -> no dark halo
    for _ in range(grow):
        cur = al >= 128
        acc = np.zeros_like(rgb)
        cnt = np.zeros(al.shape, np.float32)
        cf = cur.astype(np.float32)
        for dy, dx in _SHIFTS:                         # zero-fill shifts: no canvas wrap
            acc += _shift0(rgb * cur[:, :, None], dy, dx)
            cnt += _shift0(cf, dy, dx)
        newp = (~cur) & (cnt > 0)
        have = cnt > 0
        avg = np.zeros_like(rgb)
        avg[have] = acc[have] / cnt[have, None]
        rgb = np.where(newp[:, :, None], avg, rgb)
        al = np.where(newp, 255.0, al)
    return Image.fromarray(np.dstack([rgb, al]).clip(0, 255).astype(np.uint8), "RGBA")


def _edge_dist(opaque, maxd):
    """Chebyshev-ish 4-neighbour distance (1..maxd) from the transparent silhouette
    INTO the opaque body; off-canvas counts as transparent so the canvas border is
    distance 1. Opaque pixels farther than maxd stay at 99. Pure-numpy flood."""
    d = np.full(opaque.shape, 99, np.int32)
    seen = ~opaque
    cur = seen.copy()
    for dist in range(1, maxd + 1):
        nb = (_shift0(cur, 1, 0) | _shift0(cur, -1, 0)
              | _shift0(cur, 0, 1) | _shift0(cur, 0, -1))
        newf = nb & opaque & ~seen
        if dist == 1:                                  # off-canvas border == transparent
            border = np.zeros_like(opaque)
            border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
            newf |= border & opaque & ~seen
        d[newf] = dist
        seen |= newf
        cur = newf
        if not newf.any():
            break
    return d


def deseam_diamond(im, band=3, darkness_thresh=70, strength=0.9, material_target=None,
                   protect_dark_material=True):
    """Erase the near-black diamond-EDGE outline that tessellating ground tiles share,
    which reads in-game as a hard grid/'Ʌ' seam over the whole map.

    neutralize_outline only recolours pixels DIRECTLY touching transparency; but the
    baked diamond-edge line sits 1-3px INSIDE the silhouette (a thin skirt of slightly
    lighter edge pixels wraps it), so the outline itself is interior and survives. This
    recolours every near-black pixel within `band` px of the silhouette toward its LOCAL
    non-dark interior colour (a 5x5 average of nearby lit pixels), keeping alpha — so the
    grid line blends into the ground with NO transparent gap between tiles. Deep-interior
    dark texture (distance > band) is left untouched, so tile surface detail stays.
    A near-black MATERIAL (value < 90 == black_mountain) is skipped entirely (its dark
    body is the point), and it also self-guards: with no lit interior to sample, nothing
    changes. Runs on the harmonised image so it pulls toward the canonical ground colour.
    """
    if (protect_dark_material and material_target is not None
            and float(material_target.get("value", 255)) < 90):
        return im.convert("RGBA").copy()
    a = np.asarray(im.convert("RGBA")).astype(np.float32)
    rgb, alpha = a[:, :, :3], a[:, :, 3]
    opaque = alpha > 16
    if not opaque.any():
        return im.convert("RGBA").copy()
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    d = _edge_dist(opaque, band + 1)
    target = opaque & (lum < darkness_thresh) & (d >= 1) & (d <= band)
    if not target.any():
        return im.convert("RGBA").copy()
    src = opaque & (lum >= darkness_thresh)            # local non-dark interior to pull toward
    acc = np.zeros_like(rgb)
    cnt = np.zeros(lum.shape, np.float32)
    srcf = src.astype(np.float32)
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            acc += _shift0(rgb * src[:, :, None], dy, dx)
            cnt += _shift0(srcf, dy, dx)
    have = cnt > 0
    avg = np.zeros_like(rgb)
    avg[have] = acc[have] / cnt[have, None]
    apply = target & have
    blended = rgb * (1.0 - strength) + avg * strength
    a[:, :, :3] = np.where(apply[:, :, None], blended, rgb)
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
                       strength_light=0.97, rim_strength_light=0.9, soft_lum_light=160,
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

    # On a LIGHT material (pale ice/snow/sand/water — value > light_value) the fade is
    # BORDER-ONLY: rim_strength_light clears the outer silhouette outline (incl. the
    # off-canvas edge fix below), while strength_light=0 turns the interior `thin`
    # detector OFF so it never eats interior tile graphics — the outline goes, the
    # inside stays. thin_lum_light still widens the (now-disabled) thin gate; harmless.
    # Dark/mid materials keep the tight <60 gate and gentle strengths, so
    # stone/dirt/black_mountain/grass are untouched (verified byte-identical).
    light_mat = (material_target is not None
                 and float(material_target.get("value", 0)) > light_value)
    if light_mat:
        soft_lum = soft_lum_light
        strength = strength_light
        rim_strength = rim_strength_light

    near_black = opaque & (lum < soft_lum)
    core_dark = opaque & (lum < darkness_thresh)
    thin_ceiling = thin_lum_light if light_mat else darkness_thresh
    thin_dark = opaque & (lum < thin_ceiling)

    trans = ~opaque                                    # silhouette rim (off-canvas == transparent)
    neigh_t = (_shift0(trans, 1, 0) | _shift0(trans, -1, 0)
               | _shift0(trans, 0, 1) | _shift0(trans, 0, -1))
    # Off-canvas IS transparent: a near-black pixel on the tile's outermost row/column
    # (the very-left / very-right points of the iso diamond, x=0/63, y=0/H-1) has its
    # transparent neighbour off-canvas, which _shift0 zero-fills as opaque and misses —
    # that's what left the hard black vertical stubs at the left/right ends. Mark the
    # canvas border as transparency-adjacent so rim clears those edge pixels cleanly.
    neigh_t[0, :] = True; neigh_t[-1, :] = True
    neigh_t[:, 0] = True; neigh_t[:, -1] = True
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
