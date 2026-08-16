"""Snap a flat tile's surfaces to exact palette colours.

The requirement is that every grass tile is the SAME green in game, every snow tile
the same white, and so on. That does NOT mean the generator has to return the same
green every time — it only has to return a FLAT one. Alignment happens here.

Why this is trivial for tiles 3.0 and was a months-long fight in tiles2:

  tiles2 had to *harmonise* — hunt a material's pixels by hue band and value window
  inside textured art, shift them toward a target, and try not to catch the flowers,
  the fire, the dirt sides or the other material in a transition. Every failure mode
  we chased (grass going khaki, stone reading as snow, black crushing to #000000,
  the bonfire turning teal) came from that guessing.

  Here the surfaces are found GEOMETRICALLY — the top diamond and the two wall faces
  are known from the tile's own bounding box, not from colour — and each is a single
  flat fill. So aligning to the palette is a substitution, not an inference. Nothing
  can be mis-selected, because nothing is being selected by appearance.

It also REPAIRS the tile: a surface that generated at 0.99 flat comes out exactly
1.00, since every pixel of the region is written. So generation only has to get close
to flat, which is what makes the hard X-over-Y pairs tractable at all.

Wall shading is preserved as a RATIO, not copied: the generator lights the left and
right walls differently (e.g. 105 vs 144 grey), and that difference is what makes the
tile read as a solid block instead of a sticker. We keep each wall's own brightness
relative to the pair and re-apply it to the palette colour.

  python tiles/pipeline/palette_snap.py in.png out.png --top 3f8a3a --side 8a8f8c
"""

from __future__ import annotations

import argparse

import numpy as np
from PIL import Image

import flatness


def _hex(s):
    s = s.lstrip("#")
    return np.array([int(s[i:i + 2], 16) for i in (0, 2, 4)], float)


def _regions(a):
    """Top / left-wall / right-wall masks from the tile's own geometry."""
    h, w = a.shape[:2]
    op = a[:, :, 3] > 128
    if not op.any():
        return None
    ys, xs = np.where(op)
    x0, x1, y0 = int(xs.min()), int(xs.max()), int(ys.min())
    bw = x1 - x0 + 1
    cx = (x0 + x1) / 2.0
    hd = bw / 2.0
    cy = y0 + hd / 2.0
    yy, xx = np.mgrid[0:h, 0:w]
    dia = (np.abs(xx - cx) / (bw / 2.0) + np.abs(yy - cy) / (hd / 2.0)) <= 1.0
    below = yy > cy + (hd / 2.0) * (1.0 - np.abs(xx - cx) / (bw / 2.0))
    return {"top": dia & op, "left": below & op & (xx <= cx), "right": below & op & (xx > cx)}


def _rgb2hsv(px):
    return np.asarray(Image.fromarray(px.clip(0, 255).astype(np.uint8)[None, :, :], "RGB")
                      .convert("HSV"), dtype=float)[0]


def _hsv2rgb(px):
    return np.asarray(Image.fromarray(px.clip(0, 255).astype(np.uint8)[None, :, :], "HSV")
                      .convert("RGB"), dtype=float)[0]


def snap(img, top_hex, side_hex, keep_wall_texture=True):
    """Align a tile to the palette. The two surfaces are treated DIFFERENTLY on purpose.

    TOP — overwritten with a single flat colour. That is the whole point of the base
    tile: a featureless fill has nothing for the eye to lock onto, so an arbitrarily
    large field of it shows no visible repeat.

    WALLS — recoloured but NOT flattened. The walls are not decoration; they are every
    cliff and mountain face in the game, so they have to keep reading as the material
    (rock looks like rock, soil like soil). Flattening them produced clean but dead
    cardboard-looking cliffs. So the wall keeps its own luminance detail and only its
    HUE and SATURATION are forced to the palette, with the brightness RESCALED so the
    mean lands on the palette colour while the texture's contrast survives around it.

    The left/right lighting difference is preserved either way — the generator lights
    the two faces differently, and that is what makes a tile read as a solid block
    rather than a sticker.
    """
    a = np.asarray(img.convert("RGBA")).astype(float)
    reg = _regions(a)
    if not reg:
        return img.convert("RGBA")
    out = a.copy()
    top = _hex(top_hex)
    side = _hex(side_hex)
    side_hsv = _rgb2hsv(side[None, :])[0]

    lum = {}
    for k in ("left", "right"):
        m = reg[k]
        lum[k] = float(a[:, :, :3][m].mean()) if m.sum() > 20 else None
    if lum["left"] and lum["right"]:
        mean = (lum["left"] + lum["right"]) / 2.0 or 1.0
        fac = {k: lum[k] / mean for k in ("left", "right")}
    else:
        fac = {"left": 0.86, "right": 1.10}

    if reg["top"].sum():
        out[:, :, :3][reg["top"]] = np.clip(top, 0, 255)

    for k in ("left", "right"):
        m = reg[k]
        if not m.sum():
            continue
        px = a[:, :, :3][m]
        if not keep_wall_texture:
            out[:, :, :3][m] = np.clip(side * fac[k], 0, 255)
            continue
        hsv = _rgb2hsv(px)
        v = hsv[:, 2]
        vm = float(v.mean()) or 1.0
        target_v = float(side_hsv[2]) * fac[k]
        # Rescale rather than offset: a multiplicative fit keeps the texture's
        # contrast proportional to its new brightness, so a dark material stays
        # legible instead of having its detail crushed flat by a constant shift.
        hsv[:, 2] = np.clip(v * (target_v / vm), 0, 255)
        hsv[:, 0] = side_hsv[0]
        hsv[:, 1] = side_hsv[1]
        out[:, :, :3][m] = _hsv2rgb(hsv)

    out[:, :, 3] = a[:, :, 3]
    return Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGBA")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--top", required=True)
    ap.add_argument("--side", required=True)
    ap.add_argument("--flat-walls", action="store_true",
                    help="also flatten the walls (normally they KEEP their material texture)")
    args = ap.parse_args()
    im = snap(Image.open(args.src), args.top, args.side, keep_wall_texture=not args.flat_walls)
    im.save(args.dst)
    f = flatness.faces(args.dst)
    for k in ("top", "left", "right"):
        if f and f[k]:
            print(f"  {k:6s} share={f[k]['share']:.3f} rgb={f[k]['median']}")


if __name__ == "__main__":
    main()
