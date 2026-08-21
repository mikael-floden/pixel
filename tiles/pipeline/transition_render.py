"""Turn a transition set into tiles the game can actually draw, and lay them out.

Two rules, both paid for:

KEEP THE BOUNDARY, THROW AWAY THE FILL. A tileset generation ships its own opinion of
what each material looks like - a different green per set (measured spread up to
48/255), plus cracks, sparkles and scattered stones. Mixing sets to vary the boundary
therefore checkerboards the field. So read each transition tile only as a MASK, decided
per pixel against that set's own pure corners, and paint OUR reviewed materials through
it. Index 0 and 15 are not composed at all - they are the published tiles verbatim, so
an open field is exactly the art the maintainer starred.

DRAW AT DY=14, NOT 15. Tiles 3.0's top diamond is 64x28. At a pitch of 15 every tile
leaks a 1px band of wall from under the tile in front - 960 px over a 6x6 field - and
that band is the faint grid across a flat field (tiles/docs/GEOMETRY.md). It looks like
a fault in the art and is not.
"""
import numpy as np
from PIL import Image

HALF_W, HALF_H = 32, 14          # 3.0 lattice: top diamond 64x28
TILE_W, TILE_H = 64, 46


def classify(tile, ref_a, ref_b):
    """Per pixel: material A or B, judged against the set's OWN pure corners at the
    same pixel, so texture and shading are compared like with like."""
    t = np.array(tile.convert("RGBA"), int)
    a = np.array(ref_a.convert("RGBA"), int)
    b = np.array(ref_b.convert("RGBA"), int)
    return (np.abs(t[..., :3] - b[..., :3]).sum(2)
            < np.abs(t[..., :3] - a[..., :3]).sum(2))


def compose(tile, ref_a, ref_b, pub_a, pub_b):
    """No geometry assumptions: the set's pure corners already carry A's wall and B's
    wall, so classifying every pixel - top face and wall alike - puts our materials
    exactly where the generator put its own. Splitting top from wall by hand left a
    1px sliver of wall showing above the tile in front."""
    t = np.array(tile.convert("RGBA"), int)
    alpha = t[..., 3] > 0
    isb = classify(tile, ref_a, ref_b)
    pa = np.array(pub_a.convert("RGBA"), int)
    pb = np.array(pub_b.convert("RGBA"), int)
    out = np.where(isb[..., None], pb, pa).astype(int)
    out[..., 3] = np.where(alpha, 255, 0)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def _grow(m, n):
    """n-step 4-neighbour dilation."""
    o = m.copy()
    for _ in range(n):
        g = o.copy()
        g[1:] |= o[:-1]
        g[:-1] |= o[1:]
        g[:, 1:] |= o[:, :-1]
        g[:, :-1] |= o[:, 1:]
        o = g
    return o


def compose_collar(tile, ref_a, ref_b, hex_a, hex_b, band=6, spread=None):
    """Flat ground, detail only in the transition.

    Two maintainer rules that look contradictory and are not. "The tiles should be
    flat!" / "Clean, no ground texture!" - so away from the boundary each material is
    its single palette colour, exactly as the matrix ships. And "This is not how we
    preserve the texture on walls!" - because classifying every pixel and then painting
    it a FLAT colour turns PixelLab's grass blades lying on the sand into scattered
    dots, which is the one thing the wall treatment never does.

    So the wall's own substitute() - hue and saturation from the palette, the pixel's
    relief carried through - is applied in a `band` px collar around where the two
    materials actually meet, and nowhere else. Blades stay blades, the ground stays one
    tone. "Only the transition!"
    """
    import palette_snap as _ps
    if spread is None:
        spread = _ps.TEXTURED_TOP_SPREAD
    a = np.array(tile.convert("RGBA"), int).astype(float)
    ra = np.array(ref_a.convert("RGBA"), int)
    rb = np.array(ref_b.convert("RGBA"), int)
    alpha = a[..., 3] > 0
    isb = (np.abs(a[..., :3] - rb[..., :3]).sum(2)
           < np.abs(a[..., :3] - ra[..., :3]).sum(2))
    edge = np.zeros_like(alpha)
    edge[:, :-1] |= (isb[:, :-1] != isb[:, 1:])
    edge[:-1] |= (isb[:-1] != isb[1:])
    edge &= alpha
    collar = _grow(edge, band) & alpha
    out = a.copy()
    for owned, hexv in ((alpha & ~isb, hex_a), (alpha & isb, hex_b)):
        flat = owned & ~collar
        if flat.any():
            out[..., :3][flat] = _ps._hex(hexv)
        near = owned & collar
        if near.any():
            px = _ps.substitute(a, near, hexv, spread=spread)
            if px is not None:
                out[..., :3][near] = px
    out[..., 3] = np.where(alpha, 255, 0)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def retexture(tiles, pub_a, pub_b, hex_a=None, hex_b=None, band=6):
    """A whole set, ready to draw. Pure corners pass through untouched.

    With hex_a/hex_b the boundary tiles go through compose_collar (flat ground, relief
    only in the transition). Without them the older flat substitution is used, which
    speckles the boundary - kept only so existing callers do not change behaviour
    silently."""
    if hex_a and hex_b:
        return [pub_a if i == 0 else pub_b if i == 15
                else compose_collar(t, tiles[0], tiles[15], hex_a, hex_b, band=band)
                for i, t in enumerate(tiles)]
    return [pub_a if i == 0 else pub_b if i == 15
            else compose(t, tiles[0], tiles[15], pub_a, pub_b)
            for i, t in enumerate(tiles)]


def wang_index(G, r, c):
    """The API's own numbering: 8*NW + 4*NE + 2*SW + 1*SE on the CORNER lattice, a
    set bit meaning the second material. A map is painted on corners, not on cells -
    a boundary drawn on cells leaves the set no way to round its own edge."""
    return 8 * G[r][c] + 4 * G[r][c + 1] + 2 * G[r + 1][c] + 1 * G[r + 1][c + 1]


def render(G, pick, R, C, bg=(26, 28, 33, 255)):
    """pick(r, c, index) -> the 16-tile list to draw that cell from."""
    img = Image.new("RGBA", ((R + C) * HALF_W + TILE_W,
                             (R + C) * HALF_H + TILE_H), bg)
    ox = R * HALF_W
    # back to front by (row+col), so each tile's wall is covered by the one in front
    for r, c in sorted(((r, c) for r in range(R) for c in range(C)),
                       key=lambda t: (t[0] + t[1], t[0])):
        i = wang_index(G, r, c)
        t = pick(r, c, i)[i]
        img.paste(t, (ox + (c - r) * HALF_W, (r + c) * HALF_H), t)
    return img


def pixel_lattice(h=TILE_H, w=TILE_W):
    """Per pixel of a tile, its (dr, dc) offset inside the cell. The diamond's apex
    (32,0) is the cell's own corner, (64,14) is +1 column, (0,14) is +1 row."""
    yy, xx = np.mgrid[0:h, 0:w].astype(float)
    s = (xx - (w - 1) / 2) / HALF_W
    t = yy / HALF_H
    return (t - s) / 2, (t + s) / 2


DIAMOND = None


def _diamond():
    global DIAMOND
    if DIAMOND is None:
        yy, xx = np.mgrid[0:TILE_H, 0:TILE_W]
        DIAMOND = (np.abs(xx - (TILE_W - 1) / 2) / HALF_W
                   + np.abs(yy - HALF_H) / HALF_H) <= 1.0
    return DIAMOND


def fit_picker(field, sub, sets, masks, fallback=None):
    """Choose the variant per cell by FITTING it to a smooth curve.

    A corner Wang set decides the boundary at cell CORNERS, so a boundary crossing
    cells diagonally can only turn in 64px steps - one tooth per cell, identical every
    time, because one set has one shape per index. Each index exists in as many shapes
    as we generated, though, and each wanders up to amplitude*64 px inside its own
    cell. So draw the boundary once at PIXEL resolution and let every cell pick the
    variant whose own pixels agree with it best. This is what the variations are FOR;
    with one set per pair there is nothing to pick from and the staircase is forced.

    field  boolean, sampled `sub` times per cell, True on material B
    sets   {key: 16 retextured tiles}      masks  {key: 16 boolean boundary masks}
    """
    DR, DC = pixel_lattice()
    dia = _diamond()
    flat = {k: [m[dia] for m in masks[k]] for k in sets}
    fallback = fallback if fallback is not None else next(iter(sets))
    R, C = field.shape[0] // sub, field.shape[1] // sub

    def pick(r, c, i):
        if i in (0, 15):                       # pure cells are the published tiles
            return sets[fallback]
        rr = np.clip(((r + DR) * sub).astype(int), 0, R * sub)
        cc = np.clip(((c + DC) * sub).astype(int), 0, C * sub)
        want = field[rr, cc][dia]
        return sets[min(flat, key=lambda k: int((flat[k][i] != want).sum()))]
    return pick


def corners_from(field, sub):
    """The corner lattice implied by a pixel-resolution boundary field."""
    R, C = field.shape[0] // sub, field.shape[1] // sub
    return [[int(field[r * sub, c * sub]) for c in range(C + 1)] for r in range(R + 1)]
