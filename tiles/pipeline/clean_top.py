"""The clean single-colour top, built from the tile's own four corners.

The maintainer's algorithm, in his words:

    "It looks like when I zoom in that you don't draw the rect as small as it could be.
     ... I have encirculed the pixel that is as far left as possible and also the
     highlight pixel in that column. From this pixel we want to draw a single color
     pixel line to the pixel in the center that is as far up as possible (has to also
     be in the center). Our tiles usually have two pixels here on the same y. Pick the
     pixel to the left when you draw the line (if you have two). Everything
     perpendicular upwards should be deleted (alpha). Next you should pick the pixel to
     the right of this pixel and draw a line to the pixel as far right as possible and
     in that column the highest pixel. ... Next we should draw a line from the left most
     top pixel to the center and from the right most pixel to the center. You have found
     a center corner today but the real center is 1 or 2 pixels down from your current
     center. Everything in the center can now be turned into a single color."

WHY IT BEATS THE FITTED DIAMOND. _regions() solves a rhombus equation and then adds a
+1 fudge row because "with an even tile width the centre falls between columns, so the
bottom vertex never quite reaches the threshold". That fudge is the tell: the shape was
being approximated and then nudged. Here the three corners are READ OFF THE ART and the
fourth is implied by them, so there is nothing to nudge.

THE BOTTOM CORNER IS NOT MEASURED, IT IS IMPLIED. A rhombus has B = L + R - A, so the
near corner follows from the other three. That is exactly the "1 or 2 pixels down" he
saw: whenever the apex sits higher than a 2:1 diamond would put it, the implied bottom
corner drops by the same amount, and no constant has to know about it.

THE APEX MUST BE CENTRAL, not merely topmost. The topmost opaque pixel of a grass tile
is usually a blade, and _diamond() already fights this with a median over per-column
estimates. Restricting the search to the centre columns is the simpler statement of the
same rule, and it is what he described: "has to also be in the center".
"""

from __future__ import annotations

import numpy as np

# How far from the exact centre a pixel may sit and still count as the apex. Two would
# do for a clean tile - the apex is a 2px flat - but the outline can be a pixel ragged.
APEX_SLACK = 3

# How far below the side corner the lower edge starts, making that corner 2px tall.
CORNER_DROP = 1

# How far above the apex the upper edges aim, so their slope is exactly 2 columns per row.
APEX_LIFT = 1

# The lower boundary is drawn at this much of the flat colour, so the art beneath still
# reads through it as a highlight.
EDGE_ALPHA = 0.5


def corners(op):
    """(A, L, R, B) for the top face: apex, left, right, and the implied near corner.

    op is the opaque mask. A is the LEFT pixel of the apex pair, per the instruction.
    """
    ys, xs = np.where(op)
    if not len(ys):
        return None
    x0, x1 = int(xs.min()), int(xs.max())
    cx = (x0 + x1) / 2.0

    # L and R: the outermost columns, and in each the highest pixel it has.
    L = (x0, int(np.where(op[:, x0])[0].min()))
    R = (x1, int(np.where(op[:, x1])[0].min()))

    # A: highest pixel among the CENTRE columns; ties go to the left one.
    lo, hi = int(np.floor(cx - APEX_SLACK)), int(np.ceil(cx + APEX_SLACK))
    band = op[:, max(lo, 0):hi + 1]
    if not band.any():
        return None
    ay = int(np.where(band.any(1))[0].min())
    axs = np.where(op[ay, max(lo, 0):hi + 1])[0] + max(lo, 0)
    A = (int(axs.min()), ay)          # "Pick the pixel to the left ... (if you have two)"

    B = (L[0] + R[0] - A[0], L[1] + R[1] - A[1])
    return A, L, R, B


def _edge(x, p, q):
    """y of the straight line p->q at column x, rounded. Vertical-safe."""
    if q[0] == p[0]:
        return min(p[1], q[1])
    t = (x - p[0]) / float(q[0] - p[0])
    return int(round(p[1] + t * (q[1] - p[1])))


def top_mask(op):
    """The rhombus A-L-B-R as a boolean mask, plus what sits ABOVE its upper edges.

    Returns (inside, above, edge): the fill, what to alpha away above it, and the
    lower boundary row that is drawn at half strength.
    """
    c = corners(op)
    if c is None:
        return None
    A, L, R, B = c
    h, w = op.shape
    inside = np.zeros((h, w), bool)
    above = np.zeros((h, w), bool)
    edge = np.zeros((h, w), bool)
    # THE UPPER EDGES AIM ONE PIXEL ABOVE THE APEX, which is what makes them read as
    # straight: "fix the top left and top right line so it looks 100 straight. You can do
    # this by drawing to a px 1 pixel up when you draw towards the top center pixel."
    #
    # It is the 2:1 isometric slope asserting itself. From the left corner at x=0 to the
    # apex pair the run is 32 columns, so a true iso edge drops exactly 16 rows and every
    # step is 2 columns wide. Aiming at the apex ITSELF drops only 15 over that run, and
    # 15 does not divide 32 - the staircase has to hide the remainder in odd steps, which
    # is the raggedness he can see. One pixel up makes the rise exactly half the run.
    A = (A[0], A[1] - APEX_LIFT)
    A2 = (A[0] + 1, A[1])             # the right half of the apex pair
    # THE SIDE CORNERS ARE TWO PIXELS TALL, NOT ONE. The lower edges start a pixel below
    # where the upper ones do: "When you draw a line from the left-most and right-most
    # top pixel to the center. Start from 1px down vs you current start. This will give
    # us 2px wide corner (looks better)." With both edges leaving the same pixel the
    # corner comes to a single-pixel point, which reads as a nick rather than a corner.
    L2 = (L[0], L[1] + CORNER_DROP)
    R2 = (R[0], R[1] + CORNER_DROP)
    for x in range(L[0], R[0] + 1):
        # upper edge: L->A on the left of the apex, A2->R on its right
        ty = _edge(x, L, A) if x <= A[0] else _edge(x, A2, R)
        # lower edge: L2->B, then B->R2
        by = _edge(x, L2, B) if x <= B[0] else _edge(x, B, R2)
        if by < ty:
            continue
        inside[ty:by + 1, x] = True
        # THE LAST ROW OF THE FILL IS THE BOUNDARY, and it is not painted solid: "drawing
        # the line towards the bottom beter corner as 50% alpha (this will look like a
        # highlight defined by the texture under it)". A hard edge stamps the same shape
        # on every tile; a half-strength one lets whatever the generator drew underneath
        # decide where the highlight is bright and where it is not, so the boundary
        # belongs to the art instead of to the mask.
        edge[by, x] = True
        above[:ty, x] = True
    return inside & op, above & op, edge & op


def apply(img, colour):
    """Trim the silhouette to the rhombus and flood its interior with one colour."""
    a = np.array(img.convert("RGBA"), int)
    op = a[:, :, 3] > 128
    r = top_mask(op)
    if r is None:
        return img, 0, 0
    inside, above, edge = r
    out = a.copy()
    out[above] = [0, 0, 0, 0]
    solid = inside & ~edge
    out[solid, 0], out[solid, 1], out[solid, 2] = colour
    out[solid, 3] = 255
    # blend, not transparency: the result stays opaque, it just carries the art through
    if edge.any():
        src = a[edge][:, :3].astype(float)
        out[edge, 0:3] = np.round(EDGE_ALPHA * np.array(colour, float)
                                  + (1.0 - EDGE_ALPHA) * src).astype(int)
        out[edge, 3] = 255
    from PIL import Image
    return Image.fromarray(out.astype(np.uint8), "RGBA"), int(inside.sum()), int(above.sum())
