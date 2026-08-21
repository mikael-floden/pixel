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
