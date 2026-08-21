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


def clean_top(img, hex_flat=None, whole=True):
    """Force the top face to one colour.

    A ground tile's top face is meant to be a single tone so an arbitrarily large field
    shows no repeat. The published grass tile is 96.4% (20,82,59) with 32 pixels of a
    lighter green at FIXED positions - a +10 bevel on the outer ring plus a few
    scattered highlights. On one tile those read as lighting. Tiled, every copy repeats
    them in the same spot, they line up across the lattice, and the field grows chevrons
    of pale dots through open ground. light_soil has none of this: its top is one tone
    and its fields are clean, which is the control that proves the cause.

    ("So the grass ofc knows its clean color. So the grass part is responsible to
    remove any visible edge/seam. It's usually bright lines. The grass default color
    should be used instead.")

    whole=False cleans only the outer ring, leaving interior detail alone.

    The published grass tile carries a +10 green bevel on the last ring of its top face
    (measured: rim (21,92,67) against inner (20,82,59), 124 px); light_soil carries
    none. On a single tile that bevel reads as a lit edge, which is why it was put
    there. Butted against the neighbour that shares the seam it becomes a bright line
    running across open ground - every seam the maintainer marked was on the grass
    side, and none on the soil side, which is the bevel and nothing else.

    ("So the grass ofc knows its clean color. So the grass part is responsible to
    remove any visible edge/seam. It's usually bright lines. The grass default color
    should be used instead.")
    """
    import palette_snap as _ps
    a = np.array(img.convert("RGBA"), int)
    top = top_face(a[..., 3] > 0)
    inner = top.copy()
    e = inner.copy()
    e[1:] &= inner[:-1]; e[:-1] &= inner[1:]
    e[:, 1:] &= inner[:, :-1]; e[:, :-1] &= inner[:, 1:]
    rim = top & ~e
    target = top if whole else rim
    if not target.any() or not e.any():
        return img
    if hex_flat:
        flat = _ps._hex(hex_flat)
    else:                                  # the tone the surface already mostly is
        px = a[e][:, :3]
        cols, cnt = np.unique(px, axis=0, return_counts=True)
        flat = cols[int(np.argmax(cnt))].astype(float)
    out = a.copy()
    out[..., :3][target] = np.round(flat)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def clean_rim(img, hex_flat=None):
    """Backwards-compatible alias: clean only the outer ring."""
    return clean_top(img, hex_flat, whole=False)


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


def _despeckle(m, passes=2):
    """Majority-vote the classification so single pixels cannot flip material.

    "SAME AS THE WALL." A wall face reads smooth because nothing ever classifies it -
    it is one material and only its colour is corrected. A transition top IS two
    materials, so it has to be classified, and a per-pixel decision leaves isolated
    dots of one material stranded in the other. They are not in the source: PixelLab
    draws a blade or a grain of sand with shading, and the classifier sees only that
    one pixel's colour. Voting with the 8 neighbours removes the strays and leaves the
    boundary itself untouched, because a real boundary pixel has neighbours agreeing
    with it.
    """
    m = m.copy()
    for _ in range(passes):
        n = np.zeros(m.shape, np.int8)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                n[max(0, dy):m.shape[0] + min(0, dy),
                  max(0, dx):m.shape[1] + min(0, dx)] += \
                    m[max(0, -dy):m.shape[0] + min(0, -dy),
                      max(0, -dx):m.shape[1] + min(0, -dx)]
        m = np.where(n >= 6, True, np.where(n <= 2, False, m))
    return m


def compose_collar(tile, ref_a, ref_b, hex_a, hex_b, band=6, spread=None,
                   ramp=None, despeckle=2, rim_guard=1, src_a=None, src_b=None):
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
    # THE WALL'S CALL VERBATIM: substitute() with no spread compression and the
    # material's ramp if it has one. "The top should get the exact same treatment as
    # the walls currently have." TEXTURED_TOP_SPREAD (26) was compressing the relief
    # out again, which is the opposite of what the walls get and why the top read flat
    # beside them. spread stays a parameter but defaults to the wall's None.
    a = np.array(tile.convert("RGBA"), int).astype(float)
    ra = np.array(ref_a.convert("RGBA"), int)
    rb = np.array(ref_b.convert("RGBA"), int)
    alpha = a[..., 3] > 0
    isb = (np.abs(a[..., :3] - rb[..., :3]).sum(2)
           < np.abs(a[..., :3] - ra[..., :3]).sum(2))
    if despeckle:
        isb = _despeckle(isb, passes=despeckle)
    edge = np.zeros_like(alpha)
    edge[:, :-1] |= (isb[:, :-1] != isb[:, 1:])
    edge[:-1] |= (isb[:-1] != isb[1:])
    edge &= alpha
    collar = _grow(edge, band) & alpha
    # FEATHER, DON'T STOP. A hard collar edge is itself a visible line: where a mostly
    # sand tile has its whole surface inside the collar, it is shaded edge to edge
    # while the pure tile beside it is flat, and the eye reads the tile's own diamond
    # outline a cell in from the road. Weight 1 at the material boundary falling to 0
    # at `band`, so the shading dissolves into the flat fill instead of ending.
    w = np.zeros(alpha.shape, float)
    reach = edge.copy()
    for k in range(band):
        nxt = _grow(reach, 1) & alpha
        w[nxt & ~reach] = 1.0 - (k + 1) / float(band + 1)
        reach = nxt
    w[edge] = 1.0
    # THE TILE'S OWN OUTLINE IS NEVER SHADED. A pixel on the silhouette is shared with
    # the neighbour that abuts it, so any relief there stops being texture and becomes
    # a seam - a thin bright line along the tile edge, running across open ground where
    # nothing should be visible at all ("the grass part is responsible to remove any
    # visible edge/seam. It's usually bright lines"). Inside `rim_guard` px of the
    # silhouette every pixel takes the flat palette colour instead.
    if rim_guard:
        # FADE TOWARD THE TILE EDGE, not just guard the last pixel. The collar fades to
        # nothing at `band` px from the material BOUNDARY, but nothing made it fade
        # toward the tile's own edge - so where a boundary runs close to an edge, relief
        # arrived there at almost full strength while the neighbour across that edge was
        # flat. The eye reads the difference as the tile's outline. Ramping the weight
        # over `edge_fade` px means both sides of every shared edge reach the flat
        # palette colour together. ("grass should be fully faded to the base color or
        # else we will see the tiles")
        edge_fade = max(rim_guard, band // 2 + 2)
        depth = np.zeros(alpha.shape, np.int16)
        peel = alpha.copy()
        for k in range(edge_fade):
            e = peel.copy()
            e[1:] &= peel[:-1]; e[:-1] &= peel[1:]
            e[:, 1:] &= peel[:, :-1]; e[:, :-1] &= peel[:, 1:]
            depth[peel & ~e] = k
            peel = e
        depth[peel] = edge_fade
        w *= np.clip(depth / float(edge_fade), 0.0, 1.0)
        inner = peel
        rim = alpha & ~inner
        collar &= ~rim
        w[rim] = 0.0
        # AND THE RIM TAKES ITS MATERIAL FROM THE INTERIOR, not from its own pixel.
        # A single stray sand pixel sitting on the outline is invisible on one tile,
        # but the outline is shared, so those strays line up across the lattice into
        # chevrons of pale dots running through open grass. Copying the classification
        # from just inside means the silhouette can never introduce a material the
        # interior does not already have there.
        vote = np.zeros(isb.shape, np.int16)
        cnt = np.zeros(isb.shape, np.int16)
        src = isb & inner
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                ys0, ys1 = max(0, dy), isb.shape[0] + min(0, dy)
                xs0, xs1 = max(0, dx), isb.shape[1] + min(0, dx)
                yd0, yd1 = max(0, -dy), isb.shape[0] + min(0, -dy)
                xd0, xd1 = max(0, -dx), isb.shape[1] + min(0, -dx)
                vote[ys0:ys1, xs0:xs1] += src[yd0:yd1, xd0:xd1]
                cnt[ys0:ys1, xs0:xs1] += inner[yd0:yd1, xd0:xd1]
        take = rim & (cnt > 0)
        isb = np.where(take, vote * 2 > cnt, isb)
    out = a.copy()
    srcs = {hex_a: src_a, hex_b: src_b}
    for owned, hexv in ((alpha & ~isb, hex_a), (alpha & isb, hex_b)):
        flat = owned & ~collar
        if flat.any():
            # AWAY FROM THE BOUNDARY, COPY THE MATERIAL'S OWN PUBLISHED SURFACE rather
            # than painting one colour. For a flat material the two agree - its top
            # face is already a single tone. For a textured one they do not: paving
            # stone and parquet are marked flat_top false precisely because their
            # surface IS the material, and flat-filling them threw the bricks away and
            # left a blank slab. ("this is paving stone and has texture. So you should
            # not fade to pure color if they have texture as their standard.")
            src = srcs.get(hexv)
            if src is not None:
                sa = np.array(src.convert("RGBA"), int)
                out[..., :3][flat] = sa[..., :3][flat]
            else:
                out[..., :3][flat] = _ps._hex(hexv)
        near = owned & collar
        if near.any():
            # RECENTRE AGAINST THE WHOLE MATERIAL, WRITE ONLY THE COLLAR. substitute()
            # lands the region's MEAN on the palette colour, so running it on the
            # collar alone centres a different population than the flat fill outside
            # it - and where the collar covered most of a cell's sand, the mismatch
            # drew a faint diamond outline one tile in from the edge. Computed over
            # `owned` the two agree by construction.
            px = _ps.substitute(a, owned, hexv, spread=spread, ramp=ramp)
            if px is not None:
                sel = collar[owned]
                ww = w[near][:, None]
                src = srcs.get(hexv)
                if src is not None:
                    base = np.array(src.convert("RGBA"), int)[..., :3][near].astype(float)
                else:
                    base = np.repeat(_ps._hex(hexv)[None, :], int(near.sum()), axis=0)
                out[..., :3][near] = px[sel] * ww + base * (1 - ww)
    out[..., 3] = np.where(alpha, 255, 0)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def retexture(tiles, pub_a, pub_b, hex_a=None, hex_b=None, band=6, spread=None,
              ramp=None, keep_surface=True):
    """A whole set, ready to draw. Pure corners pass through untouched.

    With hex_a/hex_b the boundary tiles go through compose_collar (flat ground, relief
    only in the transition). Without them the older flat substitution is used, which
    speckles the boundary - kept only so existing callers do not change behaviour
    silently."""
    if hex_a and hex_b:
        sa, sb = (pub_a, pub_b) if keep_surface else (None, None)
        return [pub_a if i == 0 else pub_b if i == 15
                else compose_collar(t, tiles[0], tiles[15], hex_a, hex_b, band=band,
                                    spread=spread, ramp=ramp, src_a=sa, src_b=sb)
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


WALL_D = 17          # measured: a 64x46 tile's wall is 17 rows under every column


def top_face(alpha):
    """The top face, taken from the tile's OWN silhouette rather than a formula.

    The wall is a vertical extrusion of constant depth, so for each column the top face
    is everything above the last WALL_D rows. The rhombus formula this replaces was a
    pixel short at every extreme: it called the centre column rows 1-27 when the art
    runs 0-28, and column 0 a single row when the art has two. That one-pixel ring of
    genuine top face was being counted as wall by every measurement built on it, which
    made a lattice that closes look like it was leaking at every pitch - including 12
    and 13, where it certainly does not.
    """
    m = np.zeros(alpha.shape, bool)
    for x in range(alpha.shape[1]):
        ys = np.nonzero(alpha[:, x])[0]
        if len(ys):
            m[ys.min():ys.max() - WALL_D + 1, x] = True
    return m & alpha


DIAMOND = None


def _diamond():
    """The nominal diamond for a full-size tile. Prefer top_face(alpha) where the
    tile's own silhouette is to hand - this is only a fallback for callers that have
    no alpha."""
    global DIAMOND
    if DIAMOND is None:
        yy, xx = np.mgrid[0:TILE_H, 0:TILE_W]
        DIAMOND = (np.abs(xx - (TILE_W - 1) / 2) / HALF_W
                   + np.abs(yy - HALF_H) / (HALF_H + 0.6)) <= 1.0
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
