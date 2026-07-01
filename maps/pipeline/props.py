"""Load props from the OBJECTS agent's catalog (/objects) to place on maps.

Maps never generate props — that's the objects agent's domain. This reads
`objects/<id>/sprite.png` + `object.json` (their format, incl. a `placement`
block) and returns a PIL sprite scaled for the map. We size props relative to the
on-map character height via a per-prop `scale` (a tree ~1.3x a character, a chest
~0.45x), which reads well on the map; the objects agent's `placement.world_px_height`
is a realism hint we keep in provenance.
"""

from __future__ import annotations

import json
import os

from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
OBJECTS_DIR = os.path.join(REPO, "objects")


def available():
    """Ids of objects-agent props that have a usable sprite."""
    out = []
    if not os.path.isdir(OBJECTS_DIR):
        return out
    for name in sorted(os.listdir(OBJECTS_DIR)):
        if os.path.isfile(os.path.join(OBJECTS_DIR, name, "sprite.png")):
            out.append(name)
    return out


def load_meta(oid):
    p = os.path.join(OBJECTS_DIR, oid, "object.json")
    if os.path.isfile(p):
        with open(p) as f:
            return json.load(f)
    return {}


def sprite(oid, height_px):
    """Trimmed sprite scaled to `height_px` tall (aspect preserved)."""
    im = Image.open(os.path.join(OBJECTS_DIR, oid, "sprite.png")).convert("RGBA")
    b = im.getbbox()
    if b:
        im = im.crop(b)
    resample = Image.LANCZOS if height_px < im.height else Image.NEAREST
    w = max(1, round(im.width * height_px / im.height))
    return im.resize((w, height_px), resample)
