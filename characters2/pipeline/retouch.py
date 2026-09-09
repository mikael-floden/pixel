"""Declared pixel retouches on top of the PixelLab mirror (characters2/retouch.json).

WHY: PixelLab is the source of truth for art, but its generator sometimes bakes
something into a frame that the GAME must own instead — the pick-up animation
came back with a different hallucinated object per direction (a white scroll, a
dark pot, a blue crystal…) in the hero's hand, while the picked-up item in the
game is dynamic. Those pixels are removed HERE, not in PixelLab (the maintainer
could not prompt them away) and not by hand-editing the mirror (a forced resync
would silently put them back).

HOW: retouch.json maps a frame key (`humans/<hero>/animations/<slug>/<dir>/<i>`)
to a pixel patch — `erase` spans (set transparent) and `paint` spans (set to a
colour: repaired outlines) — pinned to the sha of the PixelLab frame it was
authored against. sync.py applies the patch to every frame it downloads:

  * source sha matches  -> patch applied, the mirror ships the retouched frame;
  * source sha differs  -> the frame was regenerated on PixelLab: the RAW frame
                           is written and a loud STALE warning printed, never a
                           patch on pixels it was not authored for;
  * no entry            -> frame untouched (the normal case).

verify_sync.py checks both shas against the live API; `--check` below checks
the on-disk result without the API. Re-author with pipeline/retouch_author.py.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # characters2/
SPEC = os.path.join(ROOT, "retouch.json")
FORMAT = "characters2-retouch@1"


def frame_key(tree, name, slug, direction, index):
    """`humans/default_boy/animations/<slug>/east/3` — the frame's path under
    characters2/ without its extension (WebP today; the key survives a format
    migration)."""
    return f"{tree}/{name}/animations/{slug}/{direction}/{index}"


def pixel_sha(img):
    """sha256 of the DECODED pixels (size + RGBA, with RGB zeroed under alpha 0
    so an encoder's transparent-pixel cleanup cannot change the hash). File
    bytes are not used: PixelLab serves PNG, the mirror stores WebP."""
    a = np.array(img.convert("RGBA"), dtype=np.uint8).copy()
    a[a[..., 3] == 0] = 0
    h = hashlib.sha256(f"{a.shape[1]}x{a.shape[0]}:".encode())
    h.update(a.tobytes())
    return h.hexdigest()


def load_spec(path=SPEC):
    if not os.path.exists(path):
        return {"format": FORMAT, "frames": {}}
    with open(path) as f:
        spec = json.load(f)
    if spec.get("format") != FORMAT:
        raise SystemExit(f"{path}: unknown format {spec.get('format')!r} (want {FORMAT})")
    spec.setdefault("frames", {})
    return spec


def apply_patch(img, entry):
    """Return a new RGBA image with the entry's erase/paint spans applied."""
    a = np.array(img.convert("RGBA"), dtype=np.uint8).copy()
    for y, x0, x1 in entry.get("erase", []):
        a[y, x0:x1 + 1] = 0
    for y, x0, x1, rgba in entry.get("paint", []):
        a[y, x0:x1 + 1] = rgba
    return Image.fromarray(a, "RGBA")


def apply_retouch(key, img, spec=None):
    """(image, state): state is None (no entry), "applied", or "stale" (the
    PixelLab frame changed since the patch was authored — `img` is returned
    untouched so the mirror shows the real new art, plus a warning to re-author)."""
    spec = load_spec() if spec is None else spec
    entry = spec["frames"].get(key)
    if not entry:
        return img, None
    if pixel_sha(img) != entry["source_sha256"]:
        return img, "stale"
    return apply_patch(img, entry), "applied"


def check(spec=None, ext=None):
    """Offline check: every retouched frame on disk carries the expected result
    pixels. Returns a list of problems (empty = all applied and intact)."""
    from sync import frame_ext
    spec = load_spec() if spec is None else spec
    ext = ext or frame_ext()
    problems = []
    for key, entry in sorted(spec["frames"].items()):
        path = os.path.join(ROOT, key + ext)
        if not os.path.exists(path):
            problems.append(f"{key}: frame missing on disk")
            continue
        if pixel_sha(Image.open(path)) != entry["result_sha256"]:
            problems.append(f"{key}: on-disk pixels != retouch result "
                            f"(raw frame written by a STALE sync, or edited by hand)")
    return problems


def main():
    if "--check" not in sys.argv:
        print(__doc__)
        print("usage: retouch.py --check   # verify every retouched frame on disk")
        return
    spec = load_spec()
    probs = check(spec)
    n = len(spec["frames"])
    for p in probs:
        print(f"  - {p}")
    print(f"{'✅' if not probs else '❌'} retouch: {n} frames declared, {n - len(probs)} intact on disk")
    sys.exit(1 if probs else 0)


if __name__ == "__main__":
    main()
