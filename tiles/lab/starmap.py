"""The test map: an eight-spoke star inside a ring.

Every straight boundary a square lattice can carry runs in one of eight directions -
the two screen axes and the two 2:1 iso diagonals, each way - and a transition set is
usually good in some and bad in others. A star hits all eight from one centre, and the
ring joining the spoke ends sweeps continuously through every angle in between, so a
single picture shows both the discrete cases and everything between them.
"""
import numpy as np

DIRS = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]


def star_field(R, C, sub, spoke_w=1.8, ring_w=1.5, reach=0.88):
    """Signed field on the corner lattice, sampled `sub` times per cell.
    True where the ground is, False on the road."""
    cr, cc = R / 2.0, C / 2.0
    rad = min(cr, cc) * reach
    gr, gc = np.mgrid[0:R * sub + 1, 0:C * sub + 1].astype(float) / sub
    d = np.full(gr.shape, 1e9)
    for dr, dc in DIRS:
        n = np.hypot(dr, dc)
        ur, uc = dr / n, dc / n
        # distance to the segment from the centre out to the ring
        vr, vc = gr - cr, gc - cc
        t = np.clip(vr * ur + vc * uc, 0, rad)
        np.minimum(d, np.hypot(vr - t * ur, vc - t * uc) - spoke_w, out=d)
    # the ring itself, drawn in LATTICE space so it reads as a circle on the ground
    # rather than on the screen - the projection is what makes it an ellipse in pixels
    np.minimum(d, np.abs(np.hypot(gr - cr, gc - cc) - rad) - ring_w, out=d)
    return d > 0
