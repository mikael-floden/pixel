"""Measure how close a tile's TOP surface is to a single flat colour.

This is the whole acceptance test for a tiles 3.0 base tile, and it is deliberately
a MEASUREMENT rather than a judgement call: the maintainer's requirement ("the top of
the base tile has to be 100% single colour") exists because a perfectly flat fill has
no features for the eye to latch onto, so a huge field of the same tile shows no
visible repeat. That property is objective, so we can score every candidate and keep
the best instead of eyeballing sheets.

Scores (top diamond only — the side walls are a different material by design):
  * `share`   fraction of top pixels sitting in the single most common colour after
              a small quantisation. 1.0 = perfectly flat. THE headline number.
  * `uniq`    distinct colours in the top surface. 1 = perfect.
  * `std`     mean per-channel standard deviation. 0 = perfect.
  * `dE`      distance from the type's intended resting colour, so "flat but the
              wrong colour" cannot pass.

  python tiles/pipeline/flatness.py <image> [<image> ...]
  python tiles/pipeline/flatness.py --hex 3f8a3a sheet/*.png
"""

from __future__ import annotations

import sys

import numpy as np
from PIL import Image

# Top-diamond geometry, measured on real 64px tiles-pro output (same as tiles2's
# corrected mask: apex ~y6, 32 rows tall, full width by ~y22) — NOT the narrower
# nominal diamond, which misses the real edge and skews the score.
_APEX_Y = 6
_H = 32


def top_mask(h, w, opaque=None):
    """Top-diamond mask, derived from the tile's OWN opaque bounding box when one is
    given rather than assuming the art fills a centred 64px canvas.

    That assumption is not safe: most sheets do come back canvas-filling (x0..63,
    centre 31.5), but a sheet can return undersized/offset tiles — one bake-off sheet
    came back 57px wide centred at x29. A fixed mask on that art straddles the two
    side walls, and their darker pixels read as 'surface texture', scoring a perfectly
    flat tile at ~0.57. Deriving the diamond from the bbox measures the top face on
    any geometry, so the score describes the ART instead of the framing."""
    m = np.zeros((h, w), bool)
    if opaque is not None and opaque.any():
        ys, xs = np.where(opaque)
        x0, x1, y0 = int(xs.min()), int(xs.max()), int(ys.min())
        bw = x1 - x0 + 1
        cx = (x0 + x1) / 2.0
        hd = bw / 2.0                      # iso: a full-width diamond is half as tall
        cy = y0 + hd / 2.0
        yy, xx = np.mgrid[0:h, 0:w]
        return (np.abs(xx - cx) / (bw / 2.0) + np.abs(yy - cy) / (hd / 2.0)) <= 1.0
    cx = w // 2
    for y in range(_APEX_Y, min(h, _APEX_Y + _H)):
        t = (y - _APEX_Y) / _H
        hw = int(round((w / 2) * (1 - abs(2 * t - 1))))
        m[y, max(0, cx - hw):min(w, cx + hw)] = True
    return m


def _erode(m, r=2):
    for _ in range(r):
        m = (m & np.roll(m, 1, 0) & np.roll(m, -1, 0)
             & np.roll(m, 1, 1) & np.roll(m, -1, 1))
    return m


def _lab(rgb):
    c = np.asarray(rgb, float) / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    M = np.array([[.4124, .3576, .1805], [.2126, .7152, .0722], [.0193, .1192, .9505]])
    xyz = c @ M.T / np.array([.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], -1)


def score(path, target_hex=None, quant=8):
    """Flatness of one tile's top surface. Eroded by 2px so the silhouette's
    anti-aliased rim can't masquerade as surface texture."""
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(int)
    h, w = a.shape[:2]
    op = a[:, :, 3] > 200
    m = _erode(top_mask(h, w, op) & op, 2)
    if m.sum() < 40:
        return None
    px = a[:, :, :3][m]
    q = (px // quant) * quant
    _, counts = np.unique(q, axis=0, return_counts=True)
    uniq_full = len(np.unique(px, axis=0))
    dom = q[np.argmax(np.all(q == q[np.argmax(counts.max() == counts)], axis=1))] if False else None
    vals, cnts = np.unique(q, axis=0, return_counts=True)
    dom = vals[cnts.argmax()]
    out = {
        "n": int(m.sum()),
        "share": float(cnts.max() / m.sum()),
        "uniq": int(uniq_full),
        "uniq_q": int(len(vals)),
        "std": float(px.std(axis=0).mean()),
        "median": [int(v) for v in np.median(px, axis=0)],
        "dominant": [int(v) for v in dom],
    }
    if target_hex:
        t = np.array([int(target_hex[i:i + 2], 16) for i in (0, 2, 4)], float)
        out["dE"] = float(np.linalg.norm(_lab(out["median"]) - _lab(t)))
    out.update(_geometry(op, w))
    return out


def _geometry(op, w):
    """Is this still a usable isometric ground tile, or did the generator cheat?

    Flatness alone is a gameable target: two bake-off prompts scored a perfect 1.000
    by returning a plain shaded CUBE — one uniform top, no distinct wall material, and
    in one case undersized art that would not tessellate. Perfectly flat and perfectly
    useless. So a candidate must also FIT THE GRID (span the full canvas width, since
    neighbouring diamonds have to meet edge to edge) and actually HAVE a front face
    below the diamond for the wall material to live on."""
    ys, xs = np.where(op)
    if not len(xs):
        return {"geom_ok": False, "why": "empty"}
    bw = int(xs.max() - xs.min() + 1)
    fills = bw >= w - 1                    # full-width: tessellates without a gap
    dia_bottom = int(ys.min()) + bw / 2.0  # the diamond's own lower vertex
    has_face = int(ys.max()) > dia_bottom + 2
    return {"geom_ok": bool(fills and has_face), "bbox_w": bw,
            "why": "" if (fills and has_face) else
                   ("not full width" if not fills else "no front face")}


def main():
    args = sys.argv[1:]
    target = None
    if args and args[0] == "--hex":
        target = args[1].lstrip("#")
        args = args[2:]
    rows = []
    for p in args:
        s = score(p, target)
        if s:
            rows.append((s["share"], p, s))
    rows.sort(reverse=True)
    for sh, p, s in rows:
        de = f" dE={s['dE']:5.1f}" if "dE" in s else ""
        print(f"  share={s['share']:.3f} uniq={s['uniq']:5d} std={s['std']:6.2f}{de} "
              f"rgb={s['median']}  {p.split('/')[-1]}")
    if rows:
        print(f"\nBEST: {rows[0][1]}  share={rows[0][0]:.3f}")


if __name__ == "__main__":
    main()
