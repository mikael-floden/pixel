"""Check that the gates agree with each other, and with what actually ships.

Why this exists
---------------
Three times in one session a NEW gate silently rejected good art rather than failing
loudly, and each time it was found by eye or by luck rather than by the pipeline:

  * seam_px called snap(), snap() started retinting the overhanging fringe, and the
    fringe — varied by design — counted as "off-colour pixels inside the field". The
    gate began rejecting the exact property it exists to protect. light_beach fell from
    0.36 spill to 0.14 and nothing said so.
  * chase enforced fringe clarity; select_best did not. publish could ship a blended
    fringe that the chase would have refused, so the two halves of the pipeline
    disagreed about what a good tile was.
  * seam demanded exactly 0 and rejected snow/paving_stone at SIX pixels while it
    carried a full 1.00 spill.

The common shape is not a bad threshold. It is two gates, each defensible alone,
disagreeing — and disagreeing QUIETLY, because a rejected tile looks the same as a tile
that was never generated. So this asserts the invariants that were violated each time.

  python tiles/pipeline/check_gates.py
"""

from __future__ import annotations

import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import chase
import flatness

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MATRIX = os.path.join(ROOT, "matrix")


def gates(path):
    q = flatness.wall_quality(path)
    return {
        "wall": q["score"] if q else 0.0,
        "spill": flatness.overhang(path),
        "clarity": flatness.fringe_clarity(path),
        "seam": flatness.seam_px(path),
    }


def passes(g, min_wall=2.0):
    return (g["wall"] >= min_wall and g["spill"] >= flatness.MIN_OVERHANG
            and g["clarity"] >= flatness.MIN_CLARITY and g["seam"] <= flatness.SEAM_TOL)


def main():
    cells = sorted(glob.glob(os.path.join(MATRIX, "*__over__*")))
    problems = []
    shipped = 0
    for d in cells:
        cell = os.path.basename(d)
        paths = sorted(glob.glob(os.path.join(d, "sheet_*", "tile_*.png")))
        if not paths:
            continue
        best = flatness.select_best(paths)
        if not best:
            problems.append((cell, "select_best returned nothing while the cell has art"))
            continue
        g = gates(best[0])
        shipped += 1

        # 1. WHAT SHIPS MUST CLEAR THE BAR. select_best falls back when no candidate
        #    passes, which is right — offering the least-bad tile beats offering none —
        #    but a fallback must be visible, not silent.
        if not passes(g):
            why = [k for k, ok in (("wall", g["wall"] >= 2.0),
                                   ("spill", g["spill"] >= flatness.MIN_OVERHANG),
                                   ("clarity", g["clarity"] >= flatness.MIN_CLARITY),
                                   ("seam", g["seam"] <= flatness.SEAM_TOL)) if not ok]
            problems.append((cell, f"published tile fails {'+'.join(why)} "
                                   f"(wall {g['wall']:.2f} spill {g['spill']:.2f} "
                                   f"clarity {g['clarity']:.2f} seam {g['seam']})"))

        # 2. THE TWO HALVES MUST AGREE. chase decides what to generate, select_best
        #    decides what to publish. If chase would refuse what publish ships, the
        #    pipeline is arguing with itself and the maintainer sees the loser.
        if chase.evaluate(paths, 2.0, flatness.MIN_CLARITY) is None and passes(g):
            problems.append((cell, "select_best publishes a passing tile that chase "
                                   "considers a failing cell"))

        # 3. NO GATE MAY VETO THE BEST OF ANOTHER. The specific failure that cost
        #    light_beach: the tile with the most spill in a cell is rejected on seam
        #    while a much worse-spilling tile passes. That is the seam gate punishing
        #    the fringe rather than the top surface.
        top_spill = max(paths, key=flatness.overhang)
        gs = gates(top_spill)
        if gs["seam"] > flatness.SEAM_TOL and gs["spill"] >= flatness.MIN_OVERHANG:
            if g["spill"] < gs["spill"] - 0.3:
                problems.append((cell, f"seam vetoes the cell's best spill "
                                       f"({gs['spill']:.2f}, seam {gs['seam']}) and we "
                                       f"ship {g['spill']:.2f} instead"))

    print(f"{shipped} cells checked against "
          f"wall>=2.0 spill>={flatness.MIN_OVERHANG} clarity>={flatness.MIN_CLARITY} "
          f"seam<={flatness.SEAM_TOL}")
    if not problems:
        print("all gates agree; every published tile clears the bar")
        return 0
    print(f"\n{len(problems)} problem(s):")
    for cell, why in problems:
        print(f"  {cell:34s} {why}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
