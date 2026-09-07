#!/usr/bin/env python3
"""WHAT EACH WALL TILE LOOKS LIKE, as three numbers — so the wall-variety rule
can put tiles that MATCH next to each other.

The maintainer approved 74 grey_stone walls, but approving a tile means "this is
good art", not "this belongs beside that one". Composited side by side they are
not interchangeable: measured over the approved grey_stone pool, mean luminance
runs 80.6 to 119.2 (a 48% brightness range) and a directional-energy term runs
-0.48 to +0.35, which is the difference between a vertically-cracked face and a
horizontally-layered one. Picking two at random and abutting them gives a hard
seam down the cliff, which is the "random" look the whole rule exists to avoid
("We might create wall base sets in the future with wall tiles that look good
together. We don't have that now however so you will have to create a nice
looking wall on your own." — maintainer 2026-09-07).

So the palette is drawn from tiles NEAR EACH OTHER in this space. This is the
measurement that makes that possible, and it is the stand-in for a hand-made
wall base set: when the tiles agent ships real ones, the sets win and this file
becomes dead weight to delete.

Three numbers per tile, from the WALL BAND only (the top diamond is a different
surface and would swamp the signal):
    lum   mean luminance over the opaque pixels, 0-255
    con   its standard deviation — how busy the face is, 0-99
    ani   (vertical energy - horizontal energy) / their sum, scaled to -100..100.
          Positive is horizontal layering, negative is vertical cracking. This
          is the term that catches the one tile that looks like a different rock.

Regenerate after any change to tiles/review or live/feedback:
    python3 games2/scripts/wall-signatures.py
"""
import json, math, os, sys
import numpy as np
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, "games2", "client", "src", "wallsig.json")
TOP_Y, DY = 10, 14

man = json.load(open(os.path.join(REPO, "tiles", "review", "manifest.json")))
fb = json.load(open(os.path.join(REPO, "live", "feedback", "tiles.json")))["entries"]


def signature(path):
    im = Image.open(os.path.join(REPO, path)).convert("RGBA")
    a = np.asarray(im).astype(np.float32)
    band = a[TOP_Y + 2 * DY:, :, :]
    al = band[..., 3] / 255.0
    if al.sum() < 50:
        return None
    lum = 0.299 * band[..., 0] + 0.587 * band[..., 1] + 0.114 * band[..., 2]
    m = float((lum * al).sum() / al.sum())
    sd = math.sqrt(float(((lum - m) ** 2 * al).sum() / al.sum()))
    gx = np.abs(np.diff(lum, axis=1)).mean()
    gy = np.abs(np.diff(lum, axis=0)).mean()
    ani = float((gy - gx) / (gy + gx + 1e-6))
    return [int(round(m)), min(99, int(round(sd))), int(round(ani * 100))]


out, pools, tiles, missing = {}, 0, 0, 0
for name, cell in man["cells"].items():
    ap = [c for c in cell["candidates"] if fb.get(c["key"], {}).get("status") == "approved"]
    # A pool with fewer than two approved tiles has nothing to choose between.
    if len(ap) < 2:
        continue
    entry = {}
    for c in ap:
        try:
            s = signature(c["file"])
        except Exception as e:
            print(f"  ! {c['key']}: {e}", file=sys.stderr)
            s = None
        if s is None:
            missing += 1
            continue
        entry[c["key"].strip("/").split("/")[-1]] = s
    if len(entry) >= 2:
        out[name] = entry
        pools += 1
        tiles += len(entry)

doc = {"format": "games2-wall-signatures@1", "_comment": __doc__.split("\n")[0], "pools": out}
with open(OUT, "w") as f:
    json.dump(doc, f, separators=(",", ":"), sort_keys=True)
print(f"{pools} pools, {tiles} tiles, {missing} without a readable wall band")
print(f"{os.path.getsize(OUT) / 1024:.0f} KB -> {OUT}")
