#!/usr/bin/env python3
"""Resync an ambient bird's art from its PixelLab OBJECT (the source of truth).

The 8 ambient birds are hand-made PixelLab "create-object" 8-direction objects,
each with a 16-frame "fly" animation and 8 still rotations. When a bird is
upgraded in the PixelLab UI, this mirrors it back into the packed sheet layout
the runtime loads (runtime/critters.ts):

  fly.png   = 16 flap frames (columns) x 8 facings (rows)   -> 544x272 @ 34px
  still.png = 8 facings (columns)                           -> 272x34  @ 34px

Rows/columns follow critters.ts DIR_INDEX order (S, SE, E, NE, N, NW, W, SW),
and the objects are authored at the runtime's native 34x34 so frames pack
directly — no scaling (pixel art is nearest-neighbour only).

Object IDs live in art/sources.json. Self-contained (only requests + Pillow) so
the ambient domain doesn't depend on another domain's PixelLab client.

    PIXELLAB_API_KEY=...  python games2/ambient/birds/resync.py bird1
    python games2/ambient/birds/resync.py           # every bird in sources.json
"""
import io
import os
import sys
import json
import time
import requests
from PIL import Image

V2 = "https://api.pixellab.ai/v2"
HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, "art")
FRAME = 34  # must equal critters.ts FRAME_W / FRAME_H
NFRAMES = 16  # must equal critters.ts FLY_FRAMES
# critters.ts DIR_INDEX — the sheet row (fly) / column (still) for each facing.
ORDER = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]


def _key():
    k = os.environ.get("PIXELLAB_API_KEY")
    if not k:
        sys.exit("PIXELLAB_API_KEY is not set")
    return k


def _get(url, key, retries=5):
    last = None
    for a in range(retries):
        try:
            r = requests.get(url, headers={"Authorization": f"Bearer {key}"}, timeout=180)
        except requests.RequestException as e:
            last = e
            time.sleep(min(2 ** a, 20))
            continue
        if r.status_code in (429, 500, 502, 503, 504):
            last = RuntimeError(f"{r.status_code}: {r.text[:120]}")
            time.sleep(min(2 ** a, 20))
            continue
        r.raise_for_status()
        return r
    raise RuntimeError(f"GET {url} failed after {retries}: {last}")


def _img(url, key):
    return Image.open(io.BytesIO(_get(url, key).content)).convert("RGBA")


def resync(name, oid, key):
    o = _get(f"{V2}/objects/{oid}", key).json()
    w, h = o["size"]["width"], o["size"]["height"]
    if (w, h) != (FRAME, FRAME):
        sys.exit(f"{name}: object {oid} is {w}x{h}, expected {FRAME}x{FRAME} (the runtime frame size)")
    fly_anims = [a for a in (o.get("animations") or []) if int(a.get("frame_count", 0)) == NFRAMES]
    if not fly_anims:
        sys.exit(f"{name}: object {oid} has no {NFRAMES}-frame animation")
    frames = {d["direction"]: d["storage_urls"]["frames"] for d in fly_anims[0]["directions"]}
    rot = {d: u for d, u in (o.get("rotation_urls") or {}).items() if u}
    for d in ORDER:
        if d not in rot:
            sys.exit(f"{name}: object {oid} is missing the {d} rotation")
        if len(frames.get(d, [])) != NFRAMES:
            sys.exit(f"{name}: {d} has {len(frames.get(d, []))} frames, expected {NFRAMES}")

    still = Image.new("RGBA", (FRAME * 8, FRAME), (0, 0, 0, 0))
    for i, d in enumerate(ORDER):
        still.alpha_composite(_img(rot[d], key), (i * FRAME, 0))

    fly = Image.new("RGBA", (FRAME * NFRAMES, FRAME * 8), (0, 0, 0, 0))
    for row, d in enumerate(ORDER):
        for f, url in enumerate(frames[d]):
            fly.alpha_composite(_img(url, key), (f * FRAME, row * FRAME))

    dst = os.path.join(ART, name)
    os.makedirs(dst, exist_ok=True)
    still.save(os.path.join(dst, "still.png"))
    fly.save(os.path.join(dst, "fly.png"))
    print(f"{name}: resynced from {oid}  (still {still.size}, fly {fly.size})")


def main():
    with open(os.path.join(ART, "sources.json")) as f:
        objs = json.load(f)["objects"]
    key = _key()
    names = sys.argv[1:] or sorted(objs)
    for n in names:
        if n not in objs:
            sys.exit(f"unknown bird '{n}'; known: {sorted(objs)}")
        resync(n, objs[n], key)


if __name__ == "__main__":
    main()
