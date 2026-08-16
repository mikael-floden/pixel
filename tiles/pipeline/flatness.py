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


def top_mask(h, w):
    m = np.zeros((h, w), bool)
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
    m = _erode(top_mask(h, w) & (a[:, :, 3] > 200), 2)
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
    return out


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
