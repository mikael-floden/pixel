"""Distil the pre-generated transition sets into ONE material-independent pattern library.

THE BOUNDARY IS NOT THE ART. A transition tile is two ground tiles and a boundary, and
the boundary depends only on (boundary_amplitude, boundary_seed) - not on the two
materials. Measured: sets sharing a (amplitude, seed) but drawn on different material
pairs agree on the boundary mask to 95.0% of pixels. So the 284 sets on disk hold only
18 distinct boundaries, each observed ~17 times, and 18 x 16 masks is the whole library.

A PATTERN IS A 4-REGION PARTITION, NOT 16 MASKS. Every silhouette pixel belongs to
exactly one Wang corner (NW=8, NE=4, SW=2, SE=1) and mask(i) = the union of the regions
whose bit is set in i. Measured on the votes: the union identity holds to 0-2 px of
2012, the complement identity to 0-1 px, and the four corner regions never overlap. So
this module votes the REGION MAP and derives all 16 masks from it, which makes the union
and complement identities exact by construction instead of nearly true.

THE MASK COVERS THE WALL; NOTHING SPECIAL HAPPENS THERE. A corner Wang boundary crosses
each diamond edge at its midpoint, and the four midpoints sit at columns 16 and 48.
Below the two lower ones there is only wall and the boundary runs straight down, so
every wall column is single-material and the splits are at x=16 and x=48 in every
pattern (1086 of 1088 wall pixels already agree across all 18 patterns; raw art agrees
on 96.1% of wall columns, the rest a +/-1 column wobble). A composed wall is never cut
horizontally and a cliff face shows at most three vertical bands.

THE OUTLINE IS CANONICALISED TO THE SAME TWO COLUMNS, AND THE ART DOES NOT DO THAT.
Measured on all 17 observations of a00_s3: the top face's boundary meets the lower-left
rim at x=18 and the lower-right rim at x=46 while the wall two rows below already splits
at 16 and 48 - a 2px step at the top-face/wall junction in every shipped tile - and the
upper-right rim crosses at 47 against the up-right neighbour's lower-left rim at 50,
which is a 3px seam defect between two tiles that are supposed to meet. Imposing the
bands on the rim removes both: t is then exactly 0.500 +- 0.000 on all 32 Wang edges of
all 18 patterns and the seam residual is 0 px, against 0.484 +- 0.016 and a nonzero
residual for the vote alone. This costs 8-10 px per pattern and is what makes the
library strictly better than the art it was distilled from.

POLARITY IS INTERNAL AND ORIENTATION-INDEPENDENT. mask == True means "the index-15
material" - side_b, the material whose corner bits are SET. The library names no
material, so the fact that 39 of 284 sets contradict their own meta.json's "INDEX 0 IS
<lower>" note cannot reach it. That measurement is published separately in
legacy_sets.json for consumers that still address the pre-generated art.

VOTING ERASES GRAIN, AND THAT IS A TASTE CALL. Where 17 observations agree to 95%, the
5% disagreement IS the pixel-level raggedness, so majority vote averages it out and the
voted mask's `grain` lands at the population minimum (0.66 against a per-set median of
1.22 on a00_s3). TRANSITIONS.md:73 says grain is the organic hand-drawn quality,
reported and not penalised - so it is reported here and never gated (M1).

Reads tiles/transitions/**; writes only tiles/patterns/**. The raw art and the post/
pass are never touched.

    python3 tiles/pipeline/transition_patterns.py            # measure, write nothing
    python3 tiles/pipeline/transition_patterns.py --write    # publish the library
    python3 tiles/pipeline/transition_patterns.py --verify   # reload and diff vs art
"""
import argparse
import io
import json
import os
import sys
from collections import defaultdict

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import transition_render as TR          # noqa: E402  _despeckle, top_face, ideal_mask
import transition_score as TS           # noqa: E402  score_all - the only shape gate
import transition_post as TP            # noqa: E402  orientation, _crop_to_art

SCHEMA = "tiles3/transition-patterns@1"
LEGACY_SCHEMA = "tiles3/transition-legacy@1"

TILE_W, TILE_H = 64, 46
CORNERS = (8, 4, 2, 1)                  # NW, NE, SW, SE - the bit is the corner id

# A corner Wang boundary crosses each diamond EDGE at its midpoint, and the four
# midpoints sit at columns 16 and 48. Below the two lower midpoints there is only wall,
# so the wall splits at exactly those columns - measured, in every pattern.
WALL_BANDS = ((0, 16, 2), (16, 48, 1), (48, 64, 4))

# The same two columns rule the tile's OUTLINE, which is what makes the lattice close:
# the top rim is SW / NW / NE and the bottom rim SW / SE / NE across [0,16), [16,48),
# [48,64). The raw art does not obey this - measured on all 17 observations of a00_s3,
# the top face's boundary meets the lower-left rim at x=18 and the lower-right rim at
# x=46 while the wall two rows below already splits at 16 and 48, so every shipped tile
# carries a 2px step at the top-face/wall junction. Imposing the bands removes that step
# AND makes the seam identity exact: this tile's upper-right rim and the up-right
# neighbour's lower-left rim then cross at the same point by construction.
RIM_BANDS = ((0, 16, 2, 2), (16, 48, 8, 1), (48, 64, 4, 4))   # x0, x1, top, bottom

# An observation whose worst index disagrees with the straight-chord ideal_mask by more
# than this is a whole-tile colour inversion, not a rough boundary: on dark_mud/grass
# index 2 came out 97-100% one material across the entire face. Reject before voting
# (G8) - overwriting its pixels instead was measured worse (art 5.4% wrong against
# geometry 11.5%).
REJECT_IDEAL_DISAGREE = 0.30

# No pattern publishes on fewer than this many kept observations. Bad observations
# cluster by material pair (dark_mud__to__grass fails 15 of 15), so a pattern generated
# on three pairs, two of them poisoned, would vote a confidently wrong mask with no
# signal that anything went wrong.
MIN_OBSERVATIONS = 6

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
TRANS = os.path.join(ROOT, "transitions")
OUT = os.path.join(ROOT, "patterns")
REL_MASKS = "tiles/patterns/masks.webp"
REL_BORDERS = "tiles/patterns/borders.webp"

# THE BORDER TONE. Each side of a boundary is darkened to this much of its OWN colour,
# which is what the generator drew: measured on the original PixelLab sets, the rim at
# the cut is a darker shade of each ground's own colour by 5-8 per channel - never a
# blend of the two, never lighter. 0.82 is that, expressed so a consumer can apply it
# as one composite: black at alpha 0.18 over the border mask IS multiply by 0.82.
BORDER_TONE = 0.82
BORDER_ALPHA = round(1.0 - BORDER_TONE, 2)
SIDE_ORDER = ["deep_water", "water", "ice", "snow", "slime", "lava", "black_rock",
              "grey_stone", "dark_mud", "light_soil", "light_beach", "grass",
              "parquet_floor", "grey_paving_stone", "brown_paving_stone"]
"""Which ground is side_b when two meet: the later one. Ordered wettest-to-built so the
BUILT surfaces (paving, parquet) are always side_b and therefore always the material whose
edge is drawn over the natural one - a road laid on grass, not grass growing over a road."""

REL_SIL = "tiles/patterns/silhouette.webp"


# --------------------------------------------------------------------- extraction

def load_set(setdir):
    """The 16 tiles of a set, or None if the set is incomplete.

    grass__to__slime/a23_s1 ships 14 tiles and is excluded from everything - a partial
    Wang set has no index 0/15 pair to classify against.
    """
    tiles = []
    for i in range(16):
        p = os.path.join(setdir, "tile_%02d.webp" % i)
        if not os.path.isfile(p):
            return None
        tiles.append(Image.open(p).convert("RGBA"))
    return tiles


def extract_masks(tiles):
    """One set's 16 boundary masks, in the library's internal polarity.

    Same classification compose_transition() uses: L1 distance in RGB at the SAME pixel
    against the set's own pure corners, so texture and shading compare like with like -
    which is also why the wall classifies correctly, the endpoints carrying their own
    wall. True means "closer to tile_15", i.e. side_b, which is orientation-independent.

    `isb &= alpha` BEFORE _despeckle, unlike compose_transition today (F8). Transparent
    pixels classify arbitrarily against RGBA (0,0,0,0) and then vote on their opaque
    neighbours: 0.14% of opaque pixels flip, every one of them on the silhouette - the
    exact ring that tiles up into chevrons of pale dots across a field. Fixed at the
    call site, not inside _despeckle, which has other callers.
    """
    ra = np.array(tiles[0], int)
    rb = np.array(tiles[15], int)
    masks, alphas = [], []
    for i, t in enumerate(tiles):
        a = np.array(t, int)
        alpha = a[..., 3] > 0
        isb = (np.abs(a[..., :3] - rb[..., :3]).sum(2)
               < np.abs(a[..., :3] - ra[..., :3]).sum(2))
        isb &= alpha
        isb = TR._despeckle(isb, passes=2)
        isb &= alpha
        if i == 0:
            isb = np.zeros(alpha.shape, bool)
        elif i == 15:
            isb = alpha.copy()
        masks.append(isb)
        alphas.append(alpha)
    return masks, alphas


def collect():
    """{(amplitude, seed): [(pair, set_id, setdir, meta)]} over every set on disk."""
    groups = defaultdict(list)
    for pair in sorted(os.listdir(TRANS)):
        pd = os.path.join(TRANS, pair)
        if not os.path.isdir(pd):
            continue
        for sid in sorted(os.listdir(pd)):
            sd = os.path.join(pd, sid)
            mp = os.path.join(sd, "meta.json")
            if not os.path.isfile(mp):
                continue
            meta = json.load(open(mp))
            key = (float(meta["boundary_amplitude"]), int(meta["boundary_seed"]))
            groups[key].append((pair, sid, sd, meta))
    return groups


# --------------------------------------------------------------------- geometry

def edge_rows(sil):
    """(up, lo): per column, the first and last row of the top face.

    top_face() reads the tile's OWN silhouette rather than a rhombus formula - the
    formula it replaced was a pixel short at every extreme, which made a lattice that
    closes look like it was leaking at every pitch.
    """
    top = TR.top_face(sil)
    up, lo = [], []
    for x in range(sil.shape[1]):
        ys = np.nonzero(top[:, x])[0]
        up.append(int(ys.min()) if len(ys) else None)
        lo.append(int(ys.max()) if len(ys) else None)
    return up, lo


def shared_edges(up):
    """The two diamond edges a tile shares with an already-drawn neighbour, as ordered
    lists of (column, is_neighbour) from apex outward.

    At dy=14 the two halves of the 2:1 staircase INTERLOCK rather than align: cell
    (r-1,c) is drawn at (+32,-14), so its bottom-left edge pixel at column x-32 lands
    one row ABOVE this tile's top-right edge pixel at column x exactly when
    up[x] + up[x-32] == 15; where the sum is 14 it lands on the same pixel and this
    tile, drawn later, covers it. Comparing the two edges column-for-column instead
    reports a phantom one-pixel mismatch at every crossing - that is the "constant
    lattice sampling offset" a naive seam probe has to search for.
    """
    upright = []            # NW-NE edge of (r,c) against SW-SE edge of (r-1,c)
    for x in range(32, 64):
        if up[x] is not None and up[x - 32] is not None and up[x] + up[x - 32] == 15:
            upright.append((x - 32, True))
        upright.append((x, False))
    upleft = []             # NW-SW edge of (r,c) against NE-SE edge of (r,c-1)
    for x in range(31, -1, -1):
        if up[x] is not None and up[x + 32] is not None and up[x] + up[x + 32] == 15:
            upleft.append((x + 32, True))
        upleft.append((x, False))
    return upright, upleft


# --------------------------------------------------------------------- the vote

def vote_regions(kept, sil):
    """Per silhouette pixel, which corner owns it - voted across the observations.

    Every observation votes TWICE per corner: mask(1<<b) says the pixel is corner b,
    and the complement of mask(15-(1<<b)) says the same thing from the other side. Both
    are exactly true for a clean partition, so the two votes reinforce and a single
    degenerate index cannot carry a corner on its own.

    Returns (region, agreement) where region holds the corner bit per pixel and
    agreement is the winner's share of the 2n votes - a weak pattern shows up as a low
    share rather than as a silent coin flip.
    """
    h, w = sil.shape
    score = {b: np.zeros((h, w), np.int32) for b in CORNERS}
    for masks in kept:
        for b in CORNERS:
            score[b] += masks[b]
            score[b] += ~masks[15 - b] & sil
    stack = np.stack([score[b] for b in CORNERS])          # (4, h, w)
    best = stack.max(0)
    total = np.maximum(stack.sum(0), 1)
    # Ties sit at the four edge midpoints where the vote is genuinely split. Break by
    # the 8-neighbour majority, then in the fixed order NW, NE, SW, SE - deterministic,
    # documented, and never left uncovered.
    tied = (stack == best[None]).sum(0) > 1
    region = np.zeros((h, w), np.int8)
    for k, b in enumerate(CORNERS):                        # fixed-order argmax
        take = (stack[k] == best) & (region == 0) & sil
        region[take] = b
    if tied.any():
        for y, x in zip(*np.nonzero(tied & sil)):
            nb = defaultdict(int)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dy == 0 and dx == 0:
                        continue
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < h and 0 <= xx < w and sil[yy, xx]:
                        nb[int(region[yy, xx])] += 1
            cand = [b for k, b in enumerate(CORNERS) if stack[k, y, x] == best[y, x]]
            cand.sort(key=lambda b: (-nb.get(b, 0), CORNERS.index(b)))
            region[y, x] = cand[0]
    region[~sil] = 0
    agreement = np.where(sil, best / total, 1.0)
    return region, agreement


def impose_wall(region, sil, up, lo):
    """Force the wall to the three published bands. Returns (region, changed_px).

    Every wall column is one material top to bottom and the two split columns are 16
    and 48, in every pattern, forever - so a cliff face shows at most three vertical
    bands and is never cut horizontally. Imposing it is what makes the library cleaner
    than any single generation, whose crossing wobbles +/-1 column.
    """
    changed = 0
    for x0, x1, b in WALL_BANDS:
        for x in range(x0, x1):
            if lo[x] is None:
                continue
            col = sil[lo[x] + 1:, x]
            if not col.any():
                continue
            seg = region[lo[x] + 1:, x]
            changed += int(((seg != b) & col).sum())
            seg[col] = b
    return region, changed


def _monotone_fix(vals):
    """The single-flip sequence closest to `vals` (True... then False...).

    A Wang boundary crosses a shared edge ONCE. Anything else is a bump the lattice
    cannot close, so the published edge is forced to the nearest one-flip sequence
    rather than left as the vote drew it.
    """
    n = len(vals)
    v = np.array(vals, bool)
    pre = np.concatenate([[0], np.cumsum(v)])
    best_k, best_cost = 0, None
    for k in range(n + 1):
        cost = (k - pre[k]) + (pre[n] - pre[k])            # False before k, True after
        if best_cost is None or cost < best_cost:
            best_k, best_cost = k, cost
    out = np.zeros(n, bool)
    out[:best_k] = True
    return out, int(best_cost)


def impose_rim(region, sil, up, lo):
    """Force the tile's outline to the three bands. Returns (region, changed_px).

    A Wang boundary crosses a shared diamond edge ONCE and at the same point from both
    sides, or the two tiles disagree about where the materials meet. The rim bands are
    that agreement written down: this tile's upper-right rim (columns 32..63, the NW/NE
    split at 48) is the up-right neighbour's lower-left rim (its columns 0..31, the
    SW/SE split at 16) shifted by +32, and my NW is that neighbour's SW. Imposing both
    from the same two columns makes seam identity exact by construction rather than
    nearly true - the same trick as the wall bands, and it is the only reason a field
    of composed tiles has no fray at the cell joins.
    """
    changed = 0
    for x0, x1, ct, cb in RIM_BANDS:
        for x in range(x0, x1):
            if up[x] is None:
                continue
            for row, c in ((up[x], ct), (lo[x], cb)):
                if region[row, x] != c:
                    changed += 1
                    region[row, x] = c
    region[~sil] = 0
    return region, changed


def ideal_region(sil):
    """The free null hypothesis: the straight-chord partition, no observations needed.

    TR.ideal_mask(i) thresholds the bilinear field at 0.5, which is a straight half-plane
    for the six two-bit indices but a HYPERBOLA for the single- and triple-bit ones -
    ideal_mask(1) covers only the outer part of the SE quadrant. Comparing a partition
    against it therefore charges the library for the model's own shape. The honest null
    is the same bilinear field taken as an argmax, which IS a partition, and that is what
    G9 measures against.
    """
    dr, dc = TR.pixel_lattice()
    w = {8: (1 - dr) * (1 - dc), 4: (1 - dr) * dc, 2: dr * (1 - dc), 1: dr * dc}
    stack = np.stack([w[b] for b in CORNERS])
    best = stack.argmax(0)
    region = np.zeros(sil.shape, np.int8)
    for k, b in enumerate(CORNERS):
        region[(best == k) & sil] = b
    return region


def masks_from_regions(region, sil):
    """All 16 masks, as unions of the four corner regions. The union and complement
    identities are exact here, not measured - that is the point of voting the region
    map rather than 16 independent masks."""
    return [np.isin(region, [b for b in CORNERS if i & b]) & sil for i in range(16)]


# --------------------------------------------------------------------- gates

def gate_wang_edges(masks, up, lo):
    """G2. Along each top-face edge: corners differ -> exactly one flip at t ~ 0.5;
    corners agree -> no flip. 32 differing edges, 24 non-trivial agreeing ones (index 0
    and 15 are pure by definition)."""
    edges = (("NW-NE", [(up[x], x) for x in range(32, 64)], 8, 4),
             ("NW-SW", [(up[x], x) for x in range(31, -1, -1)], 8, 2),
             ("SW-SE", [(lo[x], x) for x in range(0, 32)], 2, 1),
             ("NE-SE", [(lo[x], x) for x in range(63, 31, -1)], 4, 1))
    single = multi = spurious = 0
    ts = []
    for i in range(16):
        for _, pts, ca, cb in edges:
            v = np.array([masks[i][r, c] for r, c in pts if r is not None], bool)
            flips = np.nonzero(v[1:] != v[:-1])[0]
            if bool(i & ca) != bool(i & cb):
                if len(flips) == 1:
                    single += 1
                    ts.append((flips[0] + 1) / len(v))
                else:
                    multi += 1
            elif i not in (0, 15):
                if len(flips):
                    spurious += 1
    return {"single": single, "multi": multi, "spurious": spurious,
            "t_mean": float(np.mean(ts)) if ts else 0.0,
            "t_sd": float(np.std(ts)) if ts else 0.0}


def gate_seam(region, up, lo):
    """G4. The interleaved shared-edge sequence must flip exactly once. Reported as a
    residual pixel count so "0" means what it says."""
    upright, upleft = shared_edges(up)
    out = {}
    for name, seq, mine_true, nb_true in (("NW-NE|SW-SE", upright, 8, 2),
                                          ("NW-SW|NE-SE", upleft, 8, 4)):
        vals = [region[(lo[c] if isnb else up[c]), c] == (nb_true if isnb else mine_true)
                for c, isnb in seq]
        _, cost = _monotone_fix(vals)
        out[name] = cost
    return out


def gate_wall(region, sil, up, lo):
    """G5. Every wall column single-valued, split columns exactly 16 and 48, NW owns no
    wall pixel."""
    nonconst = 0
    nw_wall = 0
    splits = []
    prev = None
    for x in range(TILE_W):
        if lo[x] is None:
            continue
        col = sil[lo[x] + 1:, x]
        if not col.any():
            continue
        vals = set(int(v) for v in region[lo[x] + 1:, x][col])
        if len(vals) > 1:
            nonconst += 1
        v = sorted(vals)[0]
        if v == 8:
            nw_wall += 1
        if prev is not None and v != prev:
            splits.append(x)
        prev = v
    return {"nonconst_columns": nonconst, "nw_wall_columns": nw_wall,
            "split_columns": splits}


def gate_structure(masks, sil):
    """G1 + G3. Alpha identity and the corner-union / complement identities."""
    err_union = err_compl = 0
    for i in range(16):
        u = np.zeros(sil.shape, bool)
        for b in CORNERS:
            if i & b:
                u |= masks[b]
        u &= sil
        err_union += int((u != masks[i]).sum())
        err_compl += int(((sil & ~masks[15 - i]) != masks[i]).sum())
    overlap = 0
    for k, b in enumerate(CORNERS):
        for b2 in CORNERS[k + 1:]:
            overlap += int((masks[b] & masks[b2]).sum())
    uncovered = int((sil & ~(masks[8] | masks[4] | masks[2] | masks[1])).sum())
    subset = all(not (m & ~sil).any() for m in masks)
    return {"union_err_px": err_union, "complement_err_px": err_compl,
            "corner_overlap_px": overlap, "uncovered_px": uncovered,
            "mask_subset_of_silhouette": bool(subset),
            "mask0_empty": bool(not masks[0].any()),
            "mask15_is_silhouette": bool((masks[15] == sil).all())}


def roughness(masks, imasks, sil, top):
    """How far the boundary wanders from the straight chord - the number behind the
    human label. Measured on the six diagonal-split indices, top face only, because the
    wall is pattern-invariant and would only dilute it."""
    devs = []
    for i in (12, 3, 10, 5, 9, 6):
        m = masks[i] & top
        w = imasks[i] & top
        for y in range(TILE_H):
            r1 = int((m[y] & top[y]).sum())
            r2 = int((w[y] & top[y]).sum())
            if top[y].any():
                devs.append(abs(r1 - r2))
    d = np.array(devs, float)
    blen = 0
    idiff = 0
    for i in range(1, 15):
        m = masks[i]
        e = np.zeros_like(m)
        e[:, 1:] |= m[:, 1:] != m[:, :-1]
        e[1:, :] |= m[1:, :] != m[:-1, :]
        blen += int((e & top).sum())
        idiff += int((m != imasks[i])[sil].sum())
    return {"mean_dev_px": round(float(d.mean()), 2), "max_dev_px": int(d.max()),
            "boundary_len_px": blen,
            "vs_ideal_pct": round(100.0 * idiff / (14 * int(sil.sum())), 2)}


# --------------------------------------------------------------------- the build

def build(verbose=True):
    """Every pattern, voted and gated. Returns (patterns, silhouette, notes)."""
    groups = collect()
    sil = None
    sil_src = None
    sil_mismatch = []
    obs = defaultdict(list)
    incomplete = []
    for key in sorted(groups):
        for pair, sid, sd, meta in groups[key]:
            tiles = load_set(sd)
            if tiles is None:
                incomplete.append("%s/%s" % (pair, sid))
                continue
            masks, alphas = extract_masks(tiles)
            a = alphas[0]
            for al in alphas[1:]:
                if not (al == a).all():
                    sil_mismatch.append("%s/%s (internal)" % (pair, sid))
                    break
            if sil is None:
                sil, sil_src = a, "%s/%s" % (pair, sid)
            elif not (a == sil).all():
                sil_mismatch.append("%s/%s" % (pair, sid))
            obs[key].append((pair, sid, masks))
    top = TR.top_face(sil)
    up, lo = edge_rows(sil)
    ideal = [TR.ideal_mask(i) & sil for i in range(16)]
    imasks = masks_from_regions(ideal_region(sil), sil)

    patterns = []
    for key in sorted(groups):
        amp, seed = key
        sid = "a%02d_s%d" % (round(amp * 100), seed)
        kept, rejected = [], []
        for pair, s, masks in obs[key]:
            worst = max(1.0 - float((masks[i][sil] == ideal[i][sil]).mean())
                        for i in range(1, 15))
            (kept if worst <= REJECT_IDEAL_DISAGREE else rejected).append(
                (pair, s, masks, round(worst, 3)))
        if len(kept) < MIN_OBSERVATIONS:
            if verbose:
                print("REFUSED %s: %d kept observations < %d (G8)"
                      % (sid, len(kept), MIN_OBSERVATIONS))
            continue
        kmasks = [m for _, _, m, _ in kept]
        region, vote_share = vote_regions(kmasks, sil)
        region, wall_changed = impose_wall(region, sil, up, lo)
        region, rim_changed = impose_rim(region, sil, up, lo)
        masks = masks_from_regions(region, sil)

        # Per index: what fraction of the observations the published mask speaks for,
        # and how many pixels were within one vote of going the other way.
        n = len(kmasks)
        agree_idx, close_idx = [], []
        for i in range(16):
            share = np.zeros(sil.shape, float)
            for m in kmasks:
                share += (m[i] == masks[i])
            share /= n
            agree_idx.append(round(float(share[sil].mean()), 4))
            close_idx.append(int(((share <= 0.5 + 1.0 / (2 * n)) & sil).sum()))

        alphas16 = [sil] * 16
        sc = TS.score_all(masks, alphas16)
        per_obs = [TS.score_all(m, alphas16) for m in kmasks]
        we = gate_wang_edges(masks, up, lo)
        seam = gate_seam(region, up, lo)
        wall = gate_wall(region, sil, up, lo)
        struct = gate_structure(masks, sil)
        ideal_sc = TS.score_all(imasks, alphas16)

        # G7: how much of the shipped art the published mask still speaks for.
        reg = []
        for pair, s, m, _ in kept + rejected:
            ag = np.mean([float((m[i][sil] == masks[i][sil]).mean()) for i in range(16)])
            reg.append((pair, float(ag)))
        reg.sort(key=lambda t: t[1])

        patterns.append({
            "id": sid, "amplitude": amp, "seed": seed,
            "label": "straight" if amp == 0 else "rough %.2f" % amp,
            "roughness": roughness(masks, imasks, sil, top),
            "observations": {"kept": len(kept), "rejected": len(rejected),
                             "rejected_pairs": sorted({p for p, _, _, _ in rejected})},
            "agreement": round(float(np.mean(agree_idx)), 4),
            "agreement_by_index": agree_idx,
            "close_px_by_index": close_idx,
            "vote_share_mean": round(float(vote_share[sil].mean()), 4),
            "vote_share_min": round(float(vote_share[sil].min()), 4),
            "gates": {
                "wang_edges": "%d/32" % we["single"],
                "spurious": "%d/24" % we["spurious"],
                "t_mean": round(we["t_mean"], 3), "t_sd": round(we["t_sd"], 3),
                "seam_mismatch_pct": 0.0 if not any(seam.values()) else round(
                    100.0 * sum(seam.values()) / (2 * TILE_W), 2),
                "clean": round(sc["clean"], 2), "bump": round(sc["bump"], 2),
                "grain": round(sc["grain"], 2),
            },
            "duplicate_of": None,
            "_build": {
                "wall_px_imposed": wall_changed, "rim_px_imposed": rim_changed,
                "structure": struct, "wall": wall,
                "clean_max_obs": round(max(s["clean"] for s in per_obs), 2),
                "bump_median_obs": round(float(np.median([s["bump"] for s in per_obs])), 2),
                "grain_median_obs": round(float(np.median([s["grain"] for s in per_obs])), 2),
                "ideal_clean": round(ideal_sc["clean"], 2),
                "ideal_bump": round(ideal_sc["bump"], 2),
                "regression": reg,
                "region": region,
                "masks": masks,
            },
        })

    patterns.sort(key=lambda p: (p["amplitude"], p["seed"]))
    for r, p in enumerate(patterns):
        p["row"] = r
    # Two keys, one shape: at amplitude 0 the seed does nothing. Both keys are published
    # (they exist on disk and the wiki's chips address them) and one is marked a
    # duplicate so a picker shows ONE "straight" chip.
    for a in range(len(patterns)):
        for b in range(a + 1, len(patterns)):
            d = sum(int((patterns[a]["_build"]["masks"][i]
                         != patterns[b]["_build"]["masks"][i])[sil].sum())
                    for i in range(16))
            if d <= 4 and patterns[b]["duplicate_of"] is None:
                patterns[b]["duplicate_of"] = patterns[a]["id"]
                patterns[b]["_build"]["duplicate_diff_px"] = d
    notes = {"silhouette_source": sil_src, "silhouette_mismatch": sil_mismatch,
             "incomplete_sets": incomplete, "up": up, "lo": lo}
    return patterns, sil, notes


# --------------------------------------------------------------------- publishing

def _webp_bytes(arr):
    """Lossless WebP, verified by re-decoding.

    lossless=True AND exact=True, both non-default in Pillow. Without the first this is
    lossy VP8 and every hard mask edge rings; without the second libwebp rewrites the
    RGB under alpha=0 and the file stops being reproducible. RGB is 255,255,255
    everywhere so the sheet compresses to nothing and a debug view of the colour planes
    is blank rather than misleading.
    """
    im = Image.fromarray(arr, "RGBA")
    buf = io.BytesIO()
    im.save(buf, "WEBP", lossless=True, exact=True, quality=100, method=6)
    data = buf.getvalue()
    back = np.array(Image.open(io.BytesIO(data)).convert("RGBA"))
    if not (back == arr).all():
        raise SystemExit("WebP did not round-trip exactly - refusing to write")
    return data


def border_masks(pattern_masks, sil):
    """The 1px seam, per index: pixels of each side that TOUCH the other side.

    ONLY WHERE THE TWO GROUNDS MEET - not around the tile. Eroding each side against the
    whole silhouette instead outlines every tile, and a field of them reads as a grid:
    "The way you added the 1px border everywhere will make the tile look repeated and
    tiled." Measured on one tile, the outline version paints 184 px where the true
    meeting line is 68 - 2.7x of it tile edge that no boundary passes through.

    Both sides are one mask because both take the same factor, so a consumer darkens
    once and each side goes darker in its own colour by construction.

    It covers the WALL as well as the top face (maintainer's choice of the three
    variants): 33% of all border pixels are wall, the vertical seam at columns 15/16 and
    47/48 where two grounds own adjacent wall bands - which is what a cliff shows
    edge-on. Indices 0 and 15 are pure, have no boundary, and come out empty on all 18
    patterns; that is what keeps a field of one ground completely unmarked.
    """
    out = []
    for m in pattern_masks:
        a = (~m) & sil
        b = m & sil

        def touch(x, y):
            n = np.zeros_like(y)
            n[1:] |= y[:-1]
            n[:-1] |= y[1:]
            n[:, 1:] |= y[:, :-1]
            n[:, :-1] |= y[:, 1:]
            return x & n

        out.append(touch(a, b) | touch(b, a))
    return out


def sheet_array(patterns, sil):
    """16 columns x N rows of 64x46 frames. frame = row*16 + index, row-major, which is
    Phaser's own spritesheet numbering - so the game needs no lookup table."""
    rows = len(patterns)
    arr = np.zeros((TILE_H * rows, TILE_W * 16, 4), np.uint8)
    arr[..., 0:3] = 255
    for p in patterns:
        r = p["row"]
        for i in range(16):
            arr[r * TILE_H:(r + 1) * TILE_H, i * TILE_W:(i + 1) * TILE_W, 3] = \
                p["_build"]["masks"][i].astype(np.uint8) * 255
    return arr


def border_sheet_array(patterns, sil):
    """The border masks in the SAME layout as masks.webp - frame = row*16 + index."""
    rows = len(patterns)
    arr = np.zeros((TILE_H * rows, TILE_W * 16, 4), np.uint8)
    arr[..., 0:3] = 255
    for p in patterns:
        r = p["row"]
        for i, b in enumerate(border_masks(p["_build"]["masks"], sil)):
            arr[r * TILE_H:(r + 1) * TILE_H, i * TILE_W:(i + 1) * TILE_W, 3] = \
                b.astype(np.uint8) * 255
    return arr


def silhouette_array(sil):
    arr = np.zeros((TILE_H, TILE_W, 4), np.uint8)
    arr[..., 0:3] = 255
    arr[..., 3] = sil.astype(np.uint8) * 255
    return arr


def index_doc(patterns, sil, generated_at):
    pub = []
    for p in patterns:
        q = {k: v for k, v in p.items() if k != "_build"}
        pub.append({"id": q["id"], "row": q["row"], "amplitude": q["amplitude"],
                    "seed": q["seed"], "label": q["label"],
                    "roughness": q["roughness"], "observations": q["observations"],
                    "agreement": q["agreement"],
                    "agreement_by_index": q["agreement_by_index"],
                    "close_px_by_index": q["close_px_by_index"],
                    "gates": q["gates"], "duplicate_of": q["duplicate_of"]})
    return {
        "schema": SCHEMA,
        "domain": "tiles",
        "generated_at": generated_at,
        "generator": "tiles/pipeline/transition_patterns.py",
        "_comment": [
            "A transition tile is TWO GROUND TILES AND A BOUNDARY. This file publishes",
            "the boundary. %d patterns x 16 Wang corner masks, distilled by majority"
            % len(patterns),
            "vote from the pre-generated sets in tiles/transitions/.",
            "It is MATERIAL-INDEPENDENT: the same roughness+seed divides the tile the",
            "same way whatever the two materials are. Give it any two base plates and",
            "it makes the transition. It reproduces the boundary SHAPE, not the",
            "generator's shading along the seam - see `reproduces` below.",
        ],
        "geometry": {
            "tile_w": TILE_W, "tile_h": TILE_H, "half_w": 32, "half_h": 14,
            "dx": 32, "dy": 14, "wall_d": TR.WALL_D,
            "top_face_px": int(TR.top_face(sil).sum()),
            "wall_px": int(sil.sum() - TR.top_face(sil).sum()),
            "opaque_px": int(sil.sum()),
            "_comment": "dx/dy are the lattice step the art is authored and validated "
                        "at. The game ships ISO_DY=15 today "
                        "(games2/shared/src/index.ts:181); tiles 3.0 requires 14 "
                        "(tiles/docs/GEOMETRY.md, maintainer verdict). Anything drawn "
                        "at 15 leaks a 1px wall band per tile boundary.",
        },
        "silhouette": {
            "file": REL_SIL, "opaque_px": int(sil.sum()),
            "_comment": "THE alpha of every transition tile and every base plate. "
                        "Identical on all 16 tiles of every complete set. A composed "
                        "tile whose alpha differs from this is a bug.",
        },
        "border": {
            "file": REL_BORDERS, "encoding": "lossless-webp-alpha", "channel": "alpha",
            "layout": "identical to masks.webp - frame = row*16 + index",
            "tone": BORDER_TONE, "overlay_alpha": BORDER_ALPHA, "overlay_rgb": [0, 0, 0],
            "covers": ["top_face", "wall"],
            "empty_on": [0, 15],
            "symmetric_under_flip": True,
            "_symmetry": "border frame i == border frame 15-i, byte-identical - measured "
                         "0 of 423,936 px differing (wiki agent, all 18 patterns). A "
                         "consumer that flips the MASK frame does not flip the border.",
            "_comment": [
                "THE SEAM, 1px on each side, and it is NOT optional - a transition without",
                "it is a 0-100 hard cut, which is not what the generator drew.",
                "Each side is darkened to BORDER_TONE of ITS OWN colour. One mask serves",
                "both sides because both take the same factor: darkening what is already",
                "there gives each side a darker shade of itself, never a blend.",
                "Black at overlay_alpha over this mask IS multiply by tone, so a consumer",
                "needs one extra drawImage and no per-pixel work.",
                "ONLY WHERE THE TWO GROUNDS MEET. Outlining each side against the whole",
                "tile instead marks every tile and a field reads as a grid: measured, 184",
                "px against the true meeting line's 68.",
                "It covers the WALL too (maintainer's choice): 33% of border pixels are",
                "the vertical seam at columns 15/16 and 47/48, which is what a cliff shows",
                "edge-on. Indices 0 and 15 are pure and their frames are EMPTY on all 18",
                "patterns, so a field of one ground carries no marks at all.",
            ],
        },
        "compose": {
            "recipe": [
                "1. draw plate_a  (source-over onto a cleared 64x46 canvas)",
                "2. draw mask     (destination-out is WRONG - see below; use the mask as a "
                "   stencil: draw plate_b with globalCompositeOperation 'source-over' through "
                "   a clipped/stencilled path, or in a worker do it per pixel)",
                "3. the reference implementation is one line: "
                "   out = where(mask, plate_b, plate_a); out.alpha = silhouette",
            ],
            "canvas_ops": [
                {"op": "clearRect", "on": "scratch"},
                {"op": "drawImage", "img": "mask", "gco": "source-over"},
                {"op": "drawImage", "img": "plate_b", "gco": "source-in"},
                {"op": "drawImage", "img": "plate_a", "gco": "destination-over"},
                {"op": "drawImage", "img": "border", "gco": "source-over",
                 "on": "scratch2", "then": "fill #000 with source-in"},
                {"op": "drawImage", "img": "scratch2", "gco": "source-over",
                 "globalAlpha": BORDER_ALPHA,
                 "note": "the seam - black at this alpha over the border mask is exactly "
                         "multiply by border.tone, so each side darkens in its own colour"},
                {"op": "_caveat",
                 "note": "the drawImage path is an APPROXIMATION good to 2/255: canvas "
                         "composites premultiplied in 8 bits, so seam pixels land up to 2 "
                         "per channel from the reference's rint(v * tone) - every one "
                         "still darkens, none lightens (wiki agent, measured over four "
                         "pairs). Bit-exact consumers apply the seam per pixel with "
                         "HALF-TO-EVEN rounding: np.rint, which is NOT JS Math.round - "
                         "channel values 25/75/125/175/225 at tone 0.82 discriminate."},
            ],
            "_comment": [
                "THE MASK IS WHITE-ON-TRANSPARENT, so 'source-in' after drawing it keeps",
                "exactly plate_b's mask pixels, and 'destination-over' fills the rest from",
                "plate_a. Three drawImage calls, no per-pixel work, no geometry knowledge.",
                "The result's alpha is the silhouette because both plates already carry it",
                "and mask is a subset of it - which is why plates exist and why a raw review",
                "tile MUST NOT be substituted: measured, that puts 928 of 2012 px in the",
                "wrong alpha, silently.",
            ],
        },
        "selection": {
            "default_pattern": "a18_s4",
            "_default_reason": "mid roughness (mean deviation 4.32px of the 0.97-4.94 range) "
                               "and the highest vote agreement of the rough patterns. A "
                               "consumer with no maintainer preference draws this one.",
            "side_order": SIDE_ORDER,
            "side_rule": "side_b is whichever of the two grounds appears LATER in "
                         "side_order; side_a is the earlier. Deterministic, so two "
                         "consumers never disagree about which way a boundary fades, and "
                         "a 3-way vertex is painted by taking the pairs in this order.",
            "_comment": "Pattern choice is a TUNING decision the maintainer owns. When "
                        "live/tuning/ grows a transition_patterns.json, it wins over "
                        "default_pattern; until then this field is the whole answer.",
        },
        "lattice": {
            "corner_to_neighbour": {"NW": [0, 0], "NE": [1, 0], "SW": [0, 1], "SE": [1, 1]},
            "_comment": "Which world cell each screen corner samples, as [dq, dr] from the "
                        "tile's own cell. A tile at (q,r) reads the ground of (q,r), "
                        "(q+1,r), (q,r+1), (q+1,r+1) and forms its index as "
                        "8*NW + 4*NE + 2*SW + 1*SE. Corner-based, not edge-based: the "
                        "ground lives on the LATTICE VERTICES, so four cells meet at every "
                        "tile and no tile can ask for a transition that does not exist.",
        },
        "wang": {
            "formula": "index = 8*NW + 4*NE + 2*SW + 1*SE",
            "corners": {"8": "NW", "4": "NE", "2": "SW", "1": "SE"},
            "vertices": {"NW": "apex", "NE": "right", "SW": "left", "SE": "bottom"},
            "edge_midpoints": {"NW_SW": [16, 7], "NW_NE": [47, 7],
                               "SW_SE": [16, 21], "NE_SE": [47, 21]},
            "pure": {"0": "side_a everywhere", "15": "side_b everywhere"},
            "edge_crossings": {
                "x": [16, 48],
                "top_rim": [{"x": [0, 16], "corner": 2}, {"x": [16, 48], "corner": 8},
                            {"x": [48, 64], "corner": 4}],
                "bottom_rim": [{"x": [0, 16], "corner": 2}, {"x": [16, 48], "corner": 1},
                               {"x": [48, 64], "corner": 4}],
                "_comment": "The outline follows the same two columns as the wall, and "
                            "that is what closes the lattice: this tile's upper-right "
                            "rim IS the up-right neighbour's lower-left rim shifted by "
                            "+32, with NW playing that neighbour's SW. Imposed at build "
                            "time, so every Wang edge crosses at t = 0.500 exactly.",
            },
            "_comment": "Measured off clean sets, not assumed "
                        "(transition_render.py:518-526). The boundary crosses every "
                        "diamond EDGE at its midpoint - that is what makes the lattice "
                        "close. Midpoints are keyed by the two corners the edge joins, "
                        "consistent with `vertices`: apex-left is NW_SW at (16,7).",
        },
        "polarity": {
            "id": "bit_set_is_side_b",
            "mask_true": "side_b", "mask_false": "side_a",
            "side_a": "the material whose corner bits are CLEAR; fills index 0 entirely",
            "side_b": "the material whose corner bits are SET; fills index 15 entirely",
            "_comment": [
                "THE LIBRARY NAMES NO MATERIALS. side_a / side_b are roles the CONSUMER",
                "assigns when it composes. There is no per-pattern polarity and no",
                "per-pattern material. Index 0 vs index 15 ambiguity exists only for",
                "the PRE-GENERATED art in tiles/transitions/ - see legacy_sets.json.",
                "It does not exist here.",
            ],
        },
        "masks": {
            "file": REL_MASKS, "encoding": "lossless-webp-alpha", "channel": "alpha",
            "rgb": "255,255,255 at every pixel including under alpha=0",
            "sheet_w": TILE_W * 16, "sheet_h": TILE_H * len(patterns),
            "frame_w": TILE_W, "frame_h": TILE_H, "cols": 16, "rows": len(patterns),
            "frame_index": "pattern.row * 16 + wang_index",
            "value": {"255": "side_b", "0": "side_a or outside the tile"},
            "binary": True,
            "_comment": [
                "Alpha, not luminance: canvas source-in / destination-in and every GPU",
                "blend path operate on alpha. A luminance mask would force getImageData",
                "or a shader. Alpha is strictly 0 or 255 - there is no anti-aliasing",
                "anywhere in this format. Frame 0 of every row is fully transparent and",
                "frame 15 is the full silhouette; they are present so frame arithmetic",
                "has no special cases.",
            ],
        },
        "structure": {
            "masks_are_corner_unions": True,
            "rule": "mask(i) == union over set bits b of mask(1<<b)",
            "complement": "mask(i) == silhouette AND NOT mask(15-i)",
            "partition": "mask(8),mask(4),mask(2),mask(1) are disjoint and cover all "
                         "%d px" % int(sil.sum()),
            "_comment": "Exact by construction: the vote decides ONE corner per pixel "
                        "and the 16 masks are unions of the four regions. A consumer "
                        "MAY load only frames 1,2,4,8 of a row and OR them; the sheet "
                        "is the normative artefact either way.",
        },
        "wall": {
            "covered_by_mask": True,
            "bands": [{"x": [a, b], "corner": c} for a, b, c in WALL_BANDS],
            "nw_owns_wall": False, "column_constant": True,
            "_comment": [
                "The masks cover the WALL as well as the top face - a consumer does",
                "nothing special. Every wall column is a single material and the two",
                "split columns are 16 and 48 in every pattern, imposed at build time.",
                "A cliff face therefore shows at most three vertical bands, each one",
                "material top to bottom. A wall is never cut horizontally.",
            ],
        },
        "reproduces": {
            "shape": True, "seam_shading": False,
            "_comment": [
                "The pre-generated post/ art carries the generator's own relief along",
                "the boundary - grass blades leaning over a road edge. Dynamic",
                "composition cannot: it produces base tile A meeting base tile B along",
                "this shape, with no shading invented at the seam. That is the honest",
                "cost of the whole approach and the reason tiles/transitions/ is",
                "retained until the maintainer rules.",
            ],
        },
        "agreement_fields": {
            "agreement": "mean over the 16 indices of agreement_by_index",
            "agreement_by_index": "per Wang index, the fraction of (kept observation, "
                                  "silhouette pixel) pairs that agree with the "
                                  "published mask",
            "close_px_by_index": "per Wang index, silhouette pixels the vote carried "
                                 "by one observation or less - a weak pattern is "
                                 "visible here rather than silent",
        },
        "labels": {
            "_comment": "How `label` is derived, so it never has to be hand-maintained.",
            "rule": "amplitude == 0 -> 'straight'; else 'rough ' + amplitude.toFixed(2)",
            "scale_hint": "mean_dev_px is the number to sort or slider on",
        },
        "patterns": pub,
    }


def legacy_doc(generated_at):
    """Which material sits at index 0 of each pre-generated set - MEASURED, per set.

    meta.json's "INDEX 0 IS <lower>" note contradicts the art on 39 of 284 sets and 29
    more fall under the AMBIGUOUS margin, so a consumer that reads the note captions
    those sets backwards. No consumer re-derives this from pixels; the pipeline already
    measured it. Dies with tiles/transitions/.
    """
    sets = {}
    contradicted = ambiguous = post = 0
    for pair in sorted(os.listdir(TRANS)):
        pd = os.path.join(TRANS, pair)
        if not os.path.isdir(pd):
            continue
        try:
            mat_a, mat_b = pair.split("__to__")
        except ValueError:
            continue
        for sid in sorted(os.listdir(pd)):
            sd = os.path.join(pd, sid)
            mp = os.path.join(sd, "meta.json")
            if not os.path.isfile(mp):
                continue
            meta = json.load(open(mp))
            i0, margin = TP.orientation(sd, mat_a, mat_b)
            if i0 is None:
                continue
            i15 = mat_b if i0 == mat_a else mat_a
            amb = margin < TP.AMBIGUOUS
            agrees = (i0 == meta.get("lower"))
            has_post = os.path.isfile(os.path.join(sd, "post", "tile_00.webp"))
            n = sum(1 for i in range(16)
                    if os.path.isfile(os.path.join(sd, "tile_%02d.webp" % i)))
            sets["%s/%s" % (pair, sid)] = {
                "index0": i0, "index15": i15, "margin": round(float(margin), 1),
                "ambiguous": bool(amb), "meta_says": meta.get("lower"),
                "meta_agrees": bool(agrees), "post": bool(has_post), "n_tiles": n}
            contradicted += (not agrees)
            ambiguous += bool(amb)
            post += bool(has_post)
    return {
        "schema": LEGACY_SCHEMA, "domain": "tiles", "generated_at": generated_at,
        "generator": "tiles/pipeline/transition_patterns.py",
        "_comment": "MEASURED per set by transition_post.orientation(), NOT read from "
                    "meta.json. meta.json's 'INDEX 0 IS <lower>' note contradicts the "
                    "art on %d of %d sets; %d more fall under the AMBIGUOUS=%.1f margin "
                    "and must be shown as unknown, never guessed. Dies with "
                    "tiles/transitions/." % (contradicted, len(sets), ambiguous,
                                             TP.AMBIGUOUS),
        "sets": sets,
        "summary": {"sets": len(sets), "meta_contradicted": contradicted,
                    "ambiguous": ambiguous, "post": post},
    }


# --------------------------------------------------------------------- reference impl

_LIB = {}


def load_library(root=None):
    """The published library, as (index doc, sheet array, silhouette bool array)."""
    root = root or OUT
    key = os.path.abspath(root)
    if key not in _LIB:
        doc = json.load(open(os.path.join(root, "index.json")))
        sheet = np.array(Image.open(os.path.join(root, "masks.webp")).convert("RGBA"))
        sil = np.array(Image.open(os.path.join(root, "silhouette.webp"))
                       .convert("RGBA"))[..., 3] > 0
        _LIB[key] = (doc, sheet, sil)
    return _LIB[key]


def mask_of(pattern, index, root=None):
    """One boolean mask. True means side_b."""
    doc, sheet, _ = load_library(root)
    row = next(p["row"] for p in doc["patterns"] if p["id"] == pattern)
    y, x = row * TILE_H, index * TILE_W
    return sheet[y:y + TILE_H, x:x + TILE_W, 3] > 127


def plate(img, root=None):
    """A base tile conformed to transition geometry: THE thing that makes composition
    three drawImage calls with no geometry knowledge on the consumer's side.

    Base tiles are not in transition geometry - 41 distinct silhouettes across the
    published cells, most at 1998 px against the transition art's 2012, and their
    diamond ramp reaches full width one row earlier. Copying a base in pixel-for-pixel
    leaves those pixels landing on nothing: "leaving a few edge pixels like this looks
    like shit. If the goal is to make this tile clean - make it clean."

    Crop to the art, extend every column outward, then take the library silhouette as
    the alpha. F9 IS FIXED HERE: transition_render._extend_base() skips a column with no
    opaque pixel but sets alpha=255 unconditionally, so a ragged base tile ships an
    opaque black stripe; here an empty column is filled from the nearest column that has
    art, so every silhouette pixel has a real colour.
    """
    _, _, sil = load_library(root)
    a = np.array(TP._crop_to_art(img.convert("RGBA")), int)
    if a.shape[0] < TILE_H:
        a = np.pad(a, ((0, TILE_H - a.shape[0]), (0, 0), (0, 0)))
    a = a[:TILE_H, :TILE_W]
    alpha = a[..., 3] > 0
    top = TR.top_face(alpha)
    lib_top = TR.top_face(sil)
    out = a.copy()
    empty = []
    for x in range(TILE_W):
        ts = np.nonzero(top[:, x])[0]
        col = np.nonzero(alpha[:, x])[0]
        if not len(ts) or not len(col):
            empty.append(x)
            continue
        out[:ts.min(), x, :3] = a[ts.min(), x, :3]
        out[col.max() + 1:, x, :3] = a[col.max(), x, :3]
        # THE LIBRARY'S TOP FACE IS ONE ROW DEEPER THAN A REVIEW TILE'S, and that row
        # must come from the source's own SURFACE, not from whatever the source drew
        # there - which is its BRIM, the overhang belonging to the cell's side material.
        # Left alone it ships the neighbour's colour inside the ground: measured, a blue
        # ice rim on a black_rock plate (distance 56.6), a green grass rim on another.
        # 234,789 px, 6.9% of all top-face pixels, 3,661 of 3,685 plates - and after
        # tiling ~36 visible px per tile, which reads as a DIAMOND WIREFRAME over any
        # textured field. Measured |last top row - row above|: 17.6 mean against 8.2 for
        # the same tiles on their own geometry, 2.1x, and 4.8-7.9 on the generated
        # transition art this library was distilled from.
        lt = np.nonzero(lib_top[:, x])[0]
        deeper = lt[lt > ts.max()] if len(lt) else lt
        if len(deeper):
            out[deeper, x, :3] = a[ts.max(), x, :3]
    for x in empty:
        src = min((c for c in range(TILE_W) if c not in empty),
                  key=lambda c: abs(c - x), default=None)
        if src is not None:
            out[:, x, :3] = out[:, src, :3]
    out[..., 3] = np.where(sil, 255, 0)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def border_of(pattern, index, root=None):
    """The published seam mask for one (pattern, index). Empty on 0 and 15."""
    root = root or OUT
    key = os.path.abspath(root) + "|border"
    if key not in _LIB:
        _LIB[key] = np.array(Image.open(os.path.join(root, "borders.webp"))
                             .convert("RGBA"))[..., 3] > 0
    doc, _, _ = load_library(root)
    row = [p["id"] for p in doc["patterns"]].index(pattern)
    sheet = _LIB[key]
    return sheet[row * TILE_H:(row + 1) * TILE_H, index * TILE_W:(index + 1) * TILE_W]


def compose(base_a, base_b, pattern, index, conform=True, root=None, seam=True):
    """THE reference implementation. Any consumer that disagrees with this is wrong.

    out.rgb = mask ? B.rgb : A.rgb, then the SEAM: every pixel of the border mask is
    darkened to BORDER_TONE of what it already is. out.a = silhouette.

    No blending between the two materials anywhere - a border pixel darkens the colour
    ALREADY THERE, so each side gets a darker shade of its own ground and the two meet
    without mixing. That is what the generator drew (measured: 5-8 per channel darker,
    never a blend, never lighter), and it is not optional: without it the mask is a
    0-100 hard cut.

    Top face and wall follow the same rule: the mask covers both, a wall is never cut
    across because every wall column is single-material, and the seam runs down the
    vertical band boundary a cliff shows edge-on.

    `conform=False` when the inputs are already plates (64x46 on the library
    silhouette), which is what a transition set's own tile_00 / tile_15 are.
    `seam=False` returns the bare cut, for measuring what the seam changed.
    """
    _, _, sil = load_library(root)
    pa = plate(base_a, root) if conform else base_a.convert("RGBA")
    pb = plate(base_b, root) if conform else base_b.convert("RGBA")
    m = mask_of(pattern, index, root)
    a = np.array(pa, int)
    b = np.array(pb, int)
    out = np.where(m[..., None], b, a)
    if seam:
        bd = border_of(pattern, index, root)
        if bd.any():
            out[..., :3][bd] = np.rint(out[..., :3][bd] * BORDER_TONE)
    out[..., 3] = np.where(sil, 255, 0)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


# --------------------------------------------------------------------- main

def _report(patterns, sil, notes):
    print("silhouette: %d opaque px (top %d + wall %d), source %s"
          % (sil.sum(), TR.top_face(sil).sum(), sil.sum() - TR.top_face(sil).sum(),
             notes["silhouette_source"]))
    if notes["silhouette_mismatch"]:
        print("  SILHOUETTE MISMATCH:", notes["silhouette_mismatch"])
    if notes["incomplete_sets"]:
        print("  incomplete sets excluded:", notes["incomplete_sets"])
    print()
    hdr = ("row id       amp  seed  kept rej   agree  worst_idx(agree)  close_px "
           "wangE spur   t          seam wall_px  clean  bump  grain  dev_px")
    print(hdr)
    for p in patterns:
        b = p["_build"]
        wi = int(np.argmin(p["agreement_by_index"]))
        print("%3d %-8s %.2f %4d %5d %3d  %.4f  %2d(%.4f)      %5d  %5s %5s "
              "%.3f+-%.3f %4.1f %6d %6.2f %5.2f %6.2f %6.2f"
              % (p["row"], p["id"], p["amplitude"], p["seed"],
                 p["observations"]["kept"], p["observations"]["rejected"],
                 p["agreement"], wi, p["agreement_by_index"][wi],
                 sum(p["close_px_by_index"]),
                 p["gates"]["wang_edges"], p["gates"]["spurious"],
                 p["gates"]["t_mean"], p["gates"]["t_sd"],
                 p["gates"]["seam_mismatch_pct"],
                 b["wall_px_imposed"] + b["rim_px_imposed"],
                 p["gates"]["clean"], p["gates"]["bump"], p["gates"]["grain"],
                 p["roughness"]["mean_dev_px"]))
    print()
    print("G1/G3 structure, G5 wall, G6 vs observations, G7 regression, G9 vs ideal:")
    for p in patterns:
        b = p["_build"]
        s, w = b["structure"], b["wall"]
        bad = [n for n, v in (("union", s["union_err_px"]),
                              ("complement", s["complement_err_px"]),
                              ("overlap", s["corner_overlap_px"]),
                              ("uncovered", s["uncovered_px"]),
                              ("nonconst_wall", w["nonconst_columns"]),
                              ("nw_wall", w["nw_wall_columns"])) if v]
        g6 = "clean %.2f vs obs max %.2f %s | bump %.2f vs obs med %.2f %s" % (
            p["gates"]["clean"], b["clean_max_obs"],
            "PASS" if p["gates"]["clean"] >= b["clean_max_obs"] - 1e-9 else "FAIL",
            p["gates"]["bump"], b["bump_median_obs"],
            "PASS" if p["gates"]["bump"] <= b["bump_median_obs"] + 1e-9 else "FAIL")
        reg = b["regression"]
        ge95 = sum(1 for _, a in reg if a >= 0.95)
        print("  %-8s splits %s  %s | %s | G7 %d/%d >=95%% median %.4f worst %s %.4f "
              "| G9 vs_ideal %.2f%% (ideal clean %.2f bump %.2f)"
              % (p["id"], w["split_columns"], "OK" if not bad else "FAIL " + ",".join(bad),
                 g6, ge95, len(reg), float(np.median([a for _, a in reg])),
                 reg[0][0], reg[0][1], p["roughness"]["vs_ideal_pct"],
                 b["ideal_clean"], b["ideal_bump"]))
    dups = [(p["id"], p["duplicate_of"], p["_build"].get("duplicate_diff_px"))
            for p in patterns if p["duplicate_of"]]
    if dups:
        print("\nduplicates:", dups)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="publish tiles/patterns/")
    ap.add_argument("--verify", action="store_true",
                    help="reload the library and diff composed tiles against the art")
    ap.add_argument("--legacy", action="store_true", help="also write legacy_sets.json")
    a = ap.parse_args()

    patterns, sil, notes = build()
    _report(patterns, sil, notes)

    if a.write:
        os.makedirs(OUT, exist_ok=True)
        stamp = "2026-08-25T00:00:00Z"
        sheet = sheet_array(patterns, sil)
        sb = _webp_bytes(sheet)
        sib = _webp_bytes(silhouette_array(sil))
        bb = _webp_bytes(border_sheet_array(patterns, sil))
        open(os.path.join(OUT, "masks.webp"), "wb").write(sb)
        open(os.path.join(OUT, "borders.webp"), "wb").write(bb)
        open(os.path.join(OUT, "silhouette.webp"), "wb").write(sib)
        doc = index_doc(patterns, sil, stamp)
        ij = json.dumps(doc, indent=1) + "\n"
        open(os.path.join(OUT, "index.json"), "w").write(ij)
        print("\nwrote %s  %d bytes" % (REL_MASKS, len(sb)))
        print("wrote %s  %d bytes" % (REL_BORDERS, len(bb)))
        print("wrote %s  %d bytes" % (REL_SIL, len(sib)))
        print("wrote tiles/patterns/index.json  %d bytes" % len(ij.encode()))
        if a.legacy:
            ld = json.dumps(legacy_doc(stamp), indent=1) + "\n"
            open(os.path.join(OUT, "legacy_sets.json"), "w").write(ld)
            print("wrote tiles/patterns/legacy_sets.json  %d bytes" % len(ld.encode()))

    if a.verify:
        verify()


def verify():
    """Compose from the PUBLISHED library and diff against the art it was distilled from.

    Two corpora, because they answer different questions.

    RAW ART: compose from the set's own tile_00 / tile_15 and diff against tile_NN. Side
    agreement is how well the boundary is reproduced; RGB identity is not a fair test
    here, because the generator redraws its texture on every tile - a grass pixel far
    from the boundary is grass in both images and still a different green.

    THE post/ PASS on pairs where NEITHER material is `own`: there the pipeline itself
    copies base tiles through the mask with no per-tile relief, so composing post/tile_00
    with post/tile_15 must reproduce post/tile_NN to EXACTLY the mask difference. That is
    the sharp test, and the number it returns is the honest cost of the library.
    """
    doc, sheet, sil = load_library()
    top = TR.top_face(sil)
    print("\nreloaded: %s  %dx%d, %d patterns, silhouette %d px"
          % (doc["schema"], doc["masks"]["sheet_w"], doc["masks"]["sheet_h"],
             len(doc["patterns"]), sil.sum()))
    pal = json.load(open(os.path.join(ROOT, "config", "palette.json")))["types"]
    groups = collect()
    rows, sharp = [], []
    for p in doc["patterns"]:
        key = (p["amplitude"], p["seed"])
        for pair, sid, sd, meta in groups.get(key, []):
            tiles = load_set(sd)
            if tiles is None:
                continue
            obs, _ = extract_masks(tiles)
            side = rgb = near = far = tot = 0
            for i in range(16):
                m = mask_of(p["id"], i)
                got = np.array(compose(tiles[0], tiles[15], p["id"], i, conform=False),
                               int)
                want = np.array(tiles[i], int)
                side += int((m[sil] == obs[i][sil]).sum())
                same = (got[..., :3] == want[..., :3]).all(2)
                rgb += int(same[sil].sum())
                edge = TR._grow(m != np.roll(m, 1, 1), 3) | TR._grow(
                    m != np.roll(m, 1, 0), 3)
                wrong = (m == obs[i]) & ~same & sil
                near += int((wrong & edge).sum())
                far += int((wrong & ~edge).sum())
                tot += int(sil.sum())
            rows.append((p["id"], pair, side / tot, rgb / tot, near / tot, far / tot))

            mats = pair.split("__to__")
            if any(pal.get(m, {}).get("transition_surface", "own") == "own"
                   for m in mats):
                continue
            post = [os.path.join(sd, "post", "tile_%02d.webp" % i) for i in range(16)]
            if not all(os.path.isfile(q) for q in post):
                continue
            pt = [Image.open(q).convert("RGBA") for q in post]
            ok = tp = wall = wtot = 0
            for i in range(16):
                got = np.array(compose(pt[0], pt[15], p["id"], i, conform=False), int)
                want = np.array(pt[i], int)
                same = (got[..., :3] == want[..., :3]).all(2)
                ok += int(same[sil].sum())
                tp += int(sil.sum())
                wall += int(same[sil & ~top].sum())
                wtot += int((sil & ~top).sum())
            sharp.append((p["id"], pair, ok / tp, wall / wtot))

    rows.sort(key=lambda r: r[2])
    sides = np.array([r[2] for r in rows])
    rgbs = np.array([r[3] for r in rows])
    print("%d (pattern, pair) observations composed from the reloaded library" % len(rows))
    print("  boundary SIDE agreement vs the raw art : median %.4f  mean %.4f  "
          ">=0.95 %d/%d  min %.4f"
          % (np.median(sides), sides.mean(), int((sides >= 0.95).sum()), len(sides),
             sides.min()))
    print("  RGB identity vs the raw art            : median %.4f  max %.4f"
          % (np.median(rgbs), rgbs.max()))
    print("  right side, different pixel            : median %.4f within 3px of the "
          "boundary, %.4f beyond it"
          % (np.median([r[4] for r in rows]), np.median([r[5] for r in rows])))
    print("  (the `beyond` half is the generator redrawing its texture per tile, not a "
          "mask error)")
    print("  worst 8 by side agreement:")
    for r in rows[:8]:
        print("    %-8s %-34s side %.4f  rgb %.4f" % (r[0], r[1], r[2], r[3]))
    print("  best 5:")
    for r in rows[-5:]:
        print("    %-8s %-34s side %.4f  rgb %.4f" % (r[0], r[1], r[2], r[3]))

    if sharp:
        sharp.sort(key=lambda r: r[2])
        v = np.array([r[2] for r in sharp])
        w = np.array([r[3] for r in sharp])
        print("\n  SHARP TEST - %d sets whose post/ pass is a pure copy through the "
              "mask (no `own` material):" % len(sharp))
        print("    composed post/tile_00 + post/tile_15 vs post/tile_NN, RGB identity:")
        print("    median %.4f  mean %.4f  min %.4f  max %.4f   (wall only: median %.4f)"
              % (np.median(v), v.mean(), v.min(), v.max(), np.median(w)))
        for r in sharp[:4] + sharp[-4:]:
            print("      %-8s %-34s %.4f  wall %.4f" % (r[0], r[1], r[2], r[3]))


if __name__ == "__main__":
    main()
