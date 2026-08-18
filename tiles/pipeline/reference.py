"""Derive a material's palette colours FROM a reference tile the maintainer picked.

The maintainer's correction, and it inverts how the palette had been treated:

    "That is the ref image on how dark mud should be recolored towards. Running the
     recoloring on that same tile should of be extremely happy with how the tile already
     looks. Feels like you still change the color by a lot to something that looks
     worse. The trick here is that that is the ref and both this tile and all other
     tiles that have mud in them should be recolored to match this mud ref tile."

So a reference tile is not just a nice tile — it is the DEFINITION of the material's
colour. Two consequences follow, and the second is the test:

  1. Every other tile carrying that material is pulled toward the reference.
  2. The reference itself must come out of the postprocess essentially UNCHANGED. If
     recolouring the reference moves it a lot, the palette does not describe it, and it
     is the palette that is wrong.

That second point is what this file exists to enforce, and it is checkable — `--check`
reports the mean pixel shift the postprocess applies to each reference.

WHY dark_mud WAS WRONG. Its entry read "derived from tiles2/lightdark_dirt — 2.0 has no
separate dark_mud", i.e. it was never a real colour of this world, it was interpolated
from a neighbouring one. Measured against the reference the luminance was fine (66.7
against 68.5) but the CHROMA was not: R-B of 38 against the reference's 26. Same
brightness, half again as orange — which is why it read as tan rather than as mud.

WHAT THIS DELIBERATELY WILL NOT DO. It refuses to touch a material whose palette entry
is anchored to tiles2, and that refusal is the whole safety property. The game's grass,
snow and stone come from the shipping 2.0 palette so that 3.0 reads as the same world;
the maintainer asked for that specifically ("The old grass we had in tiles 2.0 had a
different tone. I like the old grass tone more"). Re-deriving those from generator
output is the exact mistake that once made 3.0 grass a bright yellow-green. Only a
material with no 2.0 anchor, or one the maintainer explicitly re-references with
--force, can be redefined here.

MEAN, not median or dominant. A flat fill replaces a textured surface, and what the eye
integrates at a distance is the average reflectance. On the dark_mud reference the three
differ by real amounts — mean #514137, median #594231, dominant #4c3c34 — and the median
is pulled bright by the highlight speckles that make up a small part of the area.

  python tiles/pipeline/reference.py --check
  python tiles/pipeline/reference.py --material dark_mud --write
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import palette_snap

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PALETTE = os.path.join(ROOT, "config", "palette.json")
REVIEW = os.path.join(ROOT, "review", "manifest.json")
REPO = os.path.dirname(ROOT)


def _hex(px):
    return "#%02x%02x%02x" % tuple(int(round(v)) for v in px)


def reference_tile(material, man=None):
    """The tile that DEFINES this material: the top-ranked same-over-same candidate.

    Same-over-same because it is the only cell showing the material as both surface and
    wall with nothing else in frame, so both colours come from one coherent piece of art
    rather than from two cells that happened to light it differently.
    """
    man = man or json.load(open(REVIEW))["cells"]
    cell = man.get(f"{material}__over__{material}")
    if not cell or not cell.get("candidates"):
        return None
    return os.path.join(REPO, cell["candidates"][0]["before"])


def derive(path):
    """(top_hex, wall_hex) as the reference's own average of each surface."""
    a = np.asarray(Image.open(path).convert("RGBA")).astype(float)
    reg = palette_snap._regions(a)
    if not reg:
        return None
    rgb = a[:, :, :3]
    wall = reg["left"] | reg["right"]
    if reg["top"].sum() < 100 or wall.sum() < 100:
        return None
    return _hex(rgb[reg["top"]].mean(0)), _hex(rgb[wall].mean(0))


def shift(path, top_hex, wall_hex, same=True):
    """Mean per-pixel movement the postprocess applies. Small = the palette describes
    this art. This is the acceptance test, not a diagnostic."""
    raw = Image.open(path).convert("RGBA")
    out = palette_snap.snap(raw, top_hex, same_material=same, wall_hex=wall_hex)
    a = np.asarray(raw).astype(float)
    b = np.asarray(out).astype(float)
    op = a[:, :, 3] > 128
    return float(np.abs(b[:, :, :3] - a[:, :, :3])[op].mean())


def anchored(entry):
    """True when this colour comes from the shipping 2.0 palette and is not ours to
    redefine. 'derived from' is NOT an anchor — it means interpolated, which is what
    dark_mud was."""
    src = (entry.get("source") or "").lower()
    return "tiles2" in src and "derived" not in src


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--material")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="re-reference a material anchored to tiles2 (maintainer's call)")
    ap.add_argument("--check", action="store_true",
                    help="report how far the postprocess moves each reference tile")
    args = ap.parse_args()

    doc = json.load(open(PALETTE))
    man = json.load(open(REVIEW))["cells"]
    names = [args.material] if args.material else sorted(doc["types"])
    changed = []

    print(f"{'material':16s} {'palette now':>18s} {'from reference':>18s}  {'shift':>6s}")
    for m in names:
        entry = doc["types"].get(m)
        ref = reference_tile(m, man)
        if not entry or not ref or not os.path.isfile(ref):
            print(f"{m:16s} {'(no reference tile)':>18s}")
            continue
        d = derive(ref)
        if not d:
            continue
        new_top, new_wall = d
        now = shift(ref, entry["top"], entry.get("wall"))
        then = shift(ref, new_top, new_wall)
        lock = "" if (not anchored(entry) or args.force) else "  LOCKED (tiles2)"
        print(f"{m:16s} {entry['top']:>10s}/{str(entry.get('wall')):>7s} "
              f"{new_top:>10s}/{new_wall:>7s}  {now:5.1f}->{then:4.1f}{lock}")
        if args.check or not args.write:
            continue
        if anchored(entry) and not args.force:
            continue
        entry["top"], entry["wall"] = new_top, new_wall
        entry["source"] = (f"reference tile {os.path.relpath(ref, REPO)} — the "
                           f"maintainer's chosen look for this material")
        changed.append(m)

    if changed:
        json.dump(doc, open(PALETTE, "w"), indent=2)
        print(f"\nwrote {len(changed)} material(s): {', '.join(changed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
