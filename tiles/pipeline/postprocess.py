"""Post-process for downloaded tiles: soften the hard black silhouette outline.

PixelLab draws each isometric tile with a near-black, fully-opaque outline around
its diamond silhouette. When tiles are laid edge-to-edge those outlines stack into
harsh dark grid lines (see the in-game screenshot). This softens ONLY the outer
silhouette outline — the pixels on the boundary between opaque tile and
transparent background — by:

  * tinting each dark edge pixel TOWARD its own interior colour (so it reads as a
    soft darker rim, not black) — relative to the tile, so dark tiles like stone
    or water stay dark and keep their identity;
  * lowering its alpha, so the seam blends into the neighbouring tile / the
    background instead of drawing a solid line.

Interior 3D outlines (between a tile's top and its side face) are left untouched —
they give the block its shape; only the grid-forming perimeter is softened.

Params live in config `postprocess.border` so they can be tuned and re-applied to
every tile from the saved originals (postprocess_tiles.py). Pure/​deterministic,
no API calls.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

DEFAULTS = {
    "enabled": True,
    "border": {
        "darkness_thresh": 70,   # luminance (0-255) below this = dark outline
        "edge_alpha": 0.5,       # multiply alpha of dark silhouette-edge pixels
        "lighten": 0.35,         # blend those pixels' rgb toward interior colour
    },
}

_SHIFTS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def _cfg(cfg):
    p = (cfg or {}).get("postprocess", {}) if cfg else {}
    out = {**DEFAULTS, "border": {**DEFAULTS["border"], **(p.get("border") or {})}}
    if "enabled" in p:
        out["enabled"] = p["enabled"]
    return out


def _shift(a, dy, dx):
    return np.roll(np.roll(a, dy, axis=0), dx, axis=1)


def soften_border(img, darkness_thresh=70, edge_alpha=0.5, lighten=0.35):
    """Return a copy of `img` with its dark silhouette outline softened."""
    a = np.asarray(img.convert("RGBA")).astype(np.float32)
    rgb, alpha = a[:, :, :3], a[:, :, 3]
    opaque = alpha > 16
    trans = ~opaque
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]

    # Silhouette edge = opaque pixel touching transparency (4-neighbour); target
    # only the dark ones (the outline).
    neigh_trans = (_shift(trans, 1, 0) | _shift(trans, -1, 0)
                   | _shift(trans, 0, 1) | _shift(trans, 0, -1))
    target = opaque & neigh_trans & (lum < darkness_thresh)
    if not target.any():
        return img.copy()

    # Interior tile colour to tint toward = average of each pixel's opaque,
    # non-edge (non-target) 8-neighbours.
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
    m = apply[:, :, None]
    a[:, :, :3] = np.where(m, rgb * (1 - lighten) + avg * lighten, rgb)
    a[:, :, 3] = np.where(apply, alpha * edge_alpha, alpha)
    return Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGBA")


def process(img, cfg=None):
    """Apply the configured post-process to one tile image."""
    c = _cfg(cfg)
    if not c["enabled"]:
        return img.copy()
    return soften_border(img, **c["border"])
