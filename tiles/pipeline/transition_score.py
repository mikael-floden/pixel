"""Score a transition set by how straight it can draw a straight boundary.

WHY THIS EXISTS. Shown eleven grass/soil sets, the maintainer picked 14%/seed 4 by eye
as the one with "no bumps" and asked to search for more like it. Bumpiness is therefore
a property of the SET, not of the Wang format alone, so it can be measured and bought
deliberately instead of hoped for: generate many seeds per pair, score, keep the best.
This scorer reproduces his ranking (his pick scores best of the eleven, 1.37 against
45.8 for the worst), which is what licenses using it unattended.

The measurement is the worst case on purpose: a boundary along the map diagonal
(r - c = k), which is the case a corner Wang set handles least well, and which lands
as a VERTICAL line in screen space so the edge can be read row by row. Assemble the
half-plane out of the set's own masks, walk down the picture, and record where the
material flips on each row.

  wander  - std of that x, in px. How far the edge drifts off the true line.
  bump    - mean |second difference| of x. How much it CHANGES direction, which is
            what reads as a tooth. A perfectly straight edge and a smooth diagonal
            both score 0 here; a sawtooth does not.

Both are reported in pixels of a 64px tile.
"""
import numpy as np

HALF_W, HALF_H = 32, 14


def half_plane(masks, alphas, R=26, C=26, k=0):
    """Paste the set's own boolean masks into one big field, back to front."""
    W = (R + C) * HALF_W + 64
    H = (R + C) * HALF_H + 46
    field = np.zeros((H, W), np.int8)          # 0 unset, 1 = material B
    seen = np.zeros((H, W), bool)
    G = np.array([[1 if (r - c) > k else 0 for c in range(C + 1)] for r in range(R + 1)])
    ox = R * HALF_W
    for r, c in sorted(((r, c) for r in range(R) for c in range(C)),
                       key=lambda t: (t[0] + t[1], t[0])):
        i = 8 * G[r, c] + 4 * G[r, c + 1] + 2 * G[r + 1, c] + 1 * G[r + 1, c + 1]
        m = masks[i]
        x, y = ox + (c - r) * HALF_W, (r + c) * HALF_H
        # respect the tile's own alpha: a transparent pixel must leave the tile
        # BEHIND it showing, and RGB ties to material A when it is written blindly
        sub = field[y:y + 46, x:x + 64]
        al = alphas[i][:sub.shape[0], :sub.shape[1]]
        sub[...] = np.where(al, m[:sub.shape[0], :sub.shape[1]], sub)
        sv = seen[y:y + 46, x:x + 64]
        sv[...] = sv | al
    return field, seen


def edge_x(field, seen, R=26, C=26, margin=6):
    """x of the material flip on each row, over the rows that are fully painted."""
    H, W = field.shape
    xs = []
    lo = (margin * 2) * HALF_H
    hi = ((R + C) - margin * 2) * HALF_H
    for y in range(lo, hi):
        row = field[y]
        ok = seen[y]
        idx = np.nonzero(ok)[0]
        if len(idx) < 200:
            continue
        a, b = idx.min() + 64, idx.max() - 64
        seg = row[a:b]
        flips = np.nonzero(np.diff(seg) != 0)[0]
        if len(flips) != 1:          # a clean half-plane has exactly one
            continue
        xs.append(a + flips[0])
    return np.array(xs, float)


def score(masks, alphas, R=26, C=26, margin_rows=6, **kw):
    """clean is the share of scanlines on which the boundary is a SINGLE flip. A set
    that strews islands of the other material scores low here even if the main edge is
    straight, and islands are bumps too."""
    f, s = half_plane(masks, alphas, R=R, C=C, **kw)
    xs = edge_x(f, s, R=R, C=C, margin=margin_rows)
    total = ((R + C) - margin_rows * 2) * HALF_H
    clean = len(xs) / max(total, 1)
    if len(xs) < 40:
        return {"clean": clean, "bump": float("inf"), "wander": float("inf"),
                "peak": float("inf"), "rows": len(xs)}
    d2 = np.abs(np.diff(xs, 2))
    return {"clean": clean, "rows": len(xs), "wander": float(xs.std()),
            "bump": float(d2.mean()), "peak": float(xs.max() - xs.min())}


def rank(sets, **kw):
    """[(key, score)] best first. `sets` is {key: (masks, alphas)}."""
    rows = [(k, score(m, a, **kw)) for k, (m, a) in sets.items()]
    rows.sort(key=lambda t: (t[1]["bump"], -t[1]["clean"]))
    return rows


def masks_of(tiles):
    """(boundary masks, alpha masks) for one set's 16 Pillow tiles.

    A tile's own pure corners are the reference: index 0 is all of the first material
    and 15 all of the second, so every other tile can be classified pixel by pixel
    against them without knowing anything about either material's colour.
    """
    import numpy as _np
    a0 = _np.array(tiles[0].convert("RGBA"), int)
    a15 = _np.array(tiles[15].convert("RGBA"), int)
    masks, alphas = [], []
    for t in tiles:
        a = _np.array(t.convert("RGBA"), int)
        masks.append(_np.abs(a[..., :3] - a15[..., :3]).sum(2)
                     < _np.abs(a[..., :3] - a0[..., :3]).sum(2))
        alphas.append(a[..., 3] > 0)
    return masks, alphas


# ---------------------------------------------------------------- all directions
# A set can be clean along one screen diagonal and ragged along the other
# (maintainer, on 23%/seed 4: "looks good with no bumps in one direction, but then we
# have bumps in another direction instead"), so a single-direction score overrates it.
# Rank on the WORST of the four straight boundaries the lattice can carry.
#
#   (nr, nc) is the lattice line nr*r + nc*c = k. Under x = (c-r)*32, y = (r+c)*14 it
#   maps to A*x + B*y = k with A = (nc-nr)/64, B = (nr+nc)/28, so:
#     (1,-1) vertical on screen   (1,1) horizontal   (1,0) and (0,1) the two 2:1 iso
#   diagonals. Those four are every direction a straight boundary can actually take.
DIRECTIONS = {"screen-vertical": (1, -1), "screen-horizontal": (1, 1),
              "iso-down-right": (1, 0), "iso-down-left": (0, 1)}


def half_plane_dir(masks, alphas, nr, nc, R=26, C=26, k=None, margin=4):
    """`inner` marks pixels painted by cells with `margin` cells of map on every side.
    Without it the map's own diamond silhouette is a material boundary too, and it runs
    straight through the middle of the picture - it polluted the profile badly enough
    to invert the ranking."""
    W = (R + C) * HALF_W + 64
    H = (R + C) * HALF_H + 46
    field = np.zeros((H, W), np.int8)
    seen = np.zeros((H, W), bool)
    inner = np.zeros((H, W), bool)
    if k is None:
        k = (nr * R + nc * C) / 2.0
    G = np.array([[1 if (nr * r + nc * c) > k else 0 for c in range(C + 1)]
                  for r in range(R + 1)])
    ox = R * HALF_W
    for r, c in sorted(((r, c) for r in range(R) for c in range(C)),
                       key=lambda t: (t[0] + t[1], t[0])):
        i = 8 * G[r, c] + 4 * G[r, c + 1] + 2 * G[r + 1, c] + 1 * G[r + 1, c + 1]
        x, y = ox + (c - r) * HALF_W, (r + c) * HALF_H
        sub = field[y:y + 46, x:x + 64]
        al = alphas[i][:sub.shape[0], :sub.shape[1]]
        sub[...] = np.where(al, masks[i][:sub.shape[0], :sub.shape[1]], sub)
        sv = seen[y:y + 46, x:x + 64]
        sv[...] = sv | al
        if margin <= r < R - margin and margin <= c < C - margin:
            iv = inner[y:y + 46, x:x + 64]
            iv[...] = iv | al
    return field, seen, inner, k, ox


def profile(field, inner, nr, nc, k, ox):
    """The boundary's offset from the ideal straight line, sampled along it."""
    core = inner.copy()
    for _ in range(2):
        core[1:] &= core[:-1]; core[:-1] &= core[1:]
        core[:, 1:] &= core[:, :-1]; core[:, :-1] &= core[:, 1:]
    b = np.zeros(field.shape, bool)
    b[:, :-1] |= field[:, :-1] != field[:, 1:]
    b[:-1] |= field[:-1] != field[1:]
    b &= core
    by, bx = np.nonzero(b)
    if len(bx) < 200:
        return None, None
    A = (nc - nr) / (2.0 * HALF_W)
    B = (nr + nc) / (2.0 * HALF_H)
    n = np.hypot(A, B)
    d = (A * (bx - ox) + B * by - k) / n           # perpendicular offset, px
    t = (-B * (bx - ox) + A * by) / n              # position along the line, px
    return t, d


def score_dir(masks, alphas, nr, nc, R=26, C=26):
    f, s, inner, k, ox = half_plane_dir(masks, alphas, nr, nc, R=R, C=C)
    t, d = profile(f, inner, nr, nc, k, ox)
    if t is None:
        return {"bump": float("inf"), "wander": float("inf"), "clean": 0.0,
                "grain": 0.0}
    lo, hi = int(np.floor(t.min())), int(np.ceil(t.max()))
    idx = np.clip((t - lo).astype(int), 0, hi - lo)
    n = np.bincount(idx, minlength=hi - lo + 1)
    tot = np.bincount(idx, weights=d, minlength=hi - lo + 1)
    ok = n > 0
    if ok.sum() < 60:
        return {"bump": float("inf"), "wander": float("inf"), "clean": 0.0,
                "grain": 0.0}
    prof = tot[ok] / n[ok]
    # a single clean crossing leaves 1-3 boundary pixels in a 1px slice; more than
    # that means the edge frayed or the set strewed islands
    clean = float((n[ok] <= 3).mean())

    # TWO SCALES, AND ONLY ONE OF THEM IS A FAULT. Pixel-level raggedness is the
    # organic grain that makes an edge look hand-drawn; the tooth the maintainer
    # crossed out is a cell-scale feature, wavelength 32-64px. Measuring second
    # differences at 1px therefore ranks the best-looking set worst - it did, and it
    # disagreed with his pick until this split went in. So smooth to kill the grain,
    # then look for direction changes over a HALF-CELL stride.
    w = 9
    ker = np.ones(w) / w
    sm = np.convolve(prof, ker, mode="valid")
    step = HALF_W // 2                                  # 16px: half a half-cell
    if len(sm) < step * 3 + 1:
        return {"bump": float("inf"), "wander": float("inf"), "clean": clean,
                "grain": 0.0}
    coarse = sm[::step]
    return {"bump": float(np.abs(np.diff(coarse, 2)).mean()),
            "wander": float(sm.std()),
            "grain": float((prof[w // 2:w // 2 + len(sm)] - sm).std()),
            "clean": clean}


def score_all(masks, alphas, R=26, C=26):
    per = {name: score_dir(masks, alphas, nr, nc, R=R, C=C)
           for name, (nr, nc) in DIRECTIONS.items()}
    worst = max(per.values(), key=lambda s: s["bump"])
    return {"per_direction": per, "bump": worst["bump"],
            "wander": max(s["wander"] for s in per.values()),
            "grain": float(np.mean([s.get("grain", 0.0) for s in per.values()])),
            "clean": min(s["clean"] for s in per.values()),
            "worst_direction": max(per, key=lambda n: per[n]["bump"])}
