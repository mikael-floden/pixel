"""Verify every maps2 world.json is 100% consistent with the tiles on disk.

Run before handing worlds to the game (they bake exact tile paths incl. sheet
hash, so a tiles2 reroll can leave a world pointing at deleted/replaced art):

    python maps2/pipeline/verify.py

Checks, per world: every referenced path exists AND opens as a valid image; every
`top` and `props` tile index is in range; the `emissive` array length matches
`paths`. Exits non-zero if anything is off, so it can gate a re-export/deploy.
"""

from __future__ import annotations

import glob
import json
import os
import sys

from PIL import Image

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)


def verify_world(wp: str) -> list[str]:
    d = json.load(open(wp))
    paths = d["paths"]
    n = len(paths)
    problems = []
    for p in paths:
        ap = p if os.path.isabs(p) else os.path.join(REPO, p)
        if not os.path.isfile(ap):
            problems.append(f"missing tile: {p}")
            continue
        try:
            Image.open(ap).verify()
        except Exception:
            problems.append(f"corrupt image: {p}")
    for row in d.get("top", []):
        for v in row:
            if v != -1 and not (0 <= v < n):
                problems.append(f"top index out of range: {v}")
                break
    for pr in d.get("props", []):
        if not (0 <= pr.get("tile", -1) < n):
            problems.append(f"prop tile index out of range: {pr.get('tile')}")
    for dk in d.get("decks", []):
        for c in dk.get("cells", []):
            if not (0 <= c.get("top", -1) < n):
                problems.append(f"deck tile index out of range: {c.get('top')}")
                break
    em = d.get("emissive")
    if em is not None and len(em) != n:
        problems.append(f"emissive length {len(em)} != paths {n}")
    return problems


def main() -> int:
    worlds = sorted(glob.glob(os.path.join(MAPS2, "worlds", "*", "world.json")))
    ok = True
    for wp in worlds:
        name = os.path.basename(os.path.dirname(wp))
        problems = verify_world(wp)
        d = json.load(open(wp))
        if problems:
            ok = False
            print(f"FAIL {name:12} ({len(problems)} issue(s))")
            for p in problems[:8]:
                print(f"       - {p}")
        else:
            dcells = sum(len(dk.get("cells", [])) for dk in d.get("decks", []))
            extra = f", {dcells} deck cells" if dcells else ""
            print(f"OK   {name:12} {len(d['paths'])} tiles, "
                  f"{len(d.get('props', []))} props, "
                  f"{sum(d.get('emissive', []))} emissive{extra}")
    print("\nALL MAPS 100% CLEAN" if ok else "\n*** RE-EXPORT NEEDED ***")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
