"""Add SE/SW facings to a piece that was generated SOUTH-only.

The domain generates scenery SOUTH-only, and pieces over 168px go through
`create-1-direction-object`, which has no rotations at all. That is fine for a
prop you look at from one side, but a piece placed on a WALL needs the facings
the wall can have. The store UI exposes this as "Expand to 8"; the API behind
it is `POST /v2/generate-8-rotations-v3`, which takes the existing frame as a
reference and returns all eight views — so an existing, already-approved piece
gains its facings without being regenerated and without changing its SOUTH art.

Only SE and SW are kept (SOUTH stays the sprite already on disk): those are the
wall facings the game has, and the other five are set dressing for a rotation
the domain never uses.

    python3 pipeline/expand8.py cliff_vines/cliff_vine_128
    python3 pipeline/expand8.py --group windows --limit 10
    python3 pipeline/expand8.py --all --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import factory
from pixellab_client import (V2_BASE, PixelLabClient, PixelLabError,
                             _b64_to_image, _image_to_b64obj)
from PIL import Image

# The order `generate-8-rotations-v3` returns its eight frames in. Verified
# against a real expansion (2026-08-14): indices 2 and 6 came back as narrow
# edge-on strips for a flat wall-hugging vine, which only holds if they are
# east and west — so index 1 is SE and index 7 is SW.
DIRECTIONS_8 = ("south", "south-east", "east", "north-east",
                "north", "north-west", "west", "south-west")
KEEP = ("south-east", "south-west")
MAX_REF = 256          # the endpoint's documented reference-frame limit


def needs_expand(rel_id):
    """True when the piece has no SE/SW on disk yet."""
    man = factory.read_manifest(rel_id) or {}
    rot = man.get("rotations") or {}
    return not all(d in rot for d in KEEP)


def expand(client, rel_id, timeout=600, poll=5):
    """Generate and save SE/SW for one piece. Returns the manifest, or raises."""
    man = factory.read_manifest(rel_id)
    if man is None:
        raise PixelLabError(f"{rel_id}: no manifest")
    sprite = os.path.join(factory.ROOT, man["sprite"])
    img = Image.open(sprite).convert("RGBA")
    if max(img.size) > MAX_REF:
        raise PixelLabError(
            f"{rel_id}: reference frame is {img.size}, over the {MAX_REF}px limit")

    payload = {"first_frame": _image_to_b64obj(img),
               "description": (man.get("prompt") or "")[:2000],
               "no_background": True, "seed": 0}
    job = client._request("POST", f"{V2_BASE}/generate-8-rotations-v3",
                          json=payload).get("background_job_id")
    if not job:
        raise PixelLabError(f"{rel_id}: no background_job_id returned")

    deadline = time.monotonic() + timeout
    while True:
        j = client._request("GET", f"{V2_BASE}/background-jobs/{job}")
        st = j.get("status")
        if st == "completed":
            break
        if st == "failed":
            raise PixelLabError(f"{rel_id}: job failed — "
                                f"{(j.get('last_response') or {}).get('detail')}")
        if time.monotonic() > deadline:
            raise PixelLabError(f"{rel_id}: job {job} timed out")
        time.sleep(poll)

    images = (j.get("last_response") or {}).get("images") or []
    if len(images) != 8:
        raise PixelLabError(f"{rel_id}: expected 8 rotations, got {len(images)}")

    size = int(man.get("size") or img.size[0])
    rot = dict(man.get("rotations") or {})
    for idx, direction in enumerate(DIRECTIONS_8):
        if direction not in KEEP:
            continue
        frame = factory._normalize(_b64_to_image(images[idx]).convert("RGBA"), size)
        bleed = factory.edge_bleed(frame)
        if bleed > factory.EDGE_BLEED_MAX:
            raise PixelLabError(
                f"GATE {rel_id}: {direction} cropped ({bleed:.0%} of a border "
                f"is art, max {factory.EDGE_BLEED_MAX:.0%}) — not saved")
        out = f"{rel_id}/rotations/{direction}.webp"
        factory.save_webp(frame, os.path.join(factory.ROOT, out))
        rot[direction] = out
    rot["south"] = man["sprite"]

    man["rotations"] = rot
    man["directions"] = sorted(rot)
    man["expanded_from_1_direction"] = True
    factory.write_manifest(rel_id, man)
    factory.record_first_seen(rel_id)
    return man


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pieces", nargs="*", help="rel ids, e.g. cliff_vines/cliff_vine_128")
    ap.add_argument("--group", help="expand every piece in this group")
    ap.add_argument("--all", action="store_true", help="every piece missing SE/SW")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rels = list(args.pieces)
    if args.group or args.all:
        for gid, ids in sorted(factory.done_by_group().items()):
            if args.group and gid != args.group:
                continue
            rels += [f"{gid}/{p}" for p in sorted(ids)]
    rels = [r for r in dict.fromkeys(rels) if needs_expand(r)]
    if args.limit:
        rels = rels[:args.limit]
    if not rels:
        print("nothing to expand")
        return 0
    print(f"{len(rels)} piece(s) to expand")
    if args.dry_run:
        for r in rels:
            print("  would expand", r)
        return 0

    client = PixelLabClient()
    ok = fail = 0
    for rel in rels:
        try:
            expand(client, rel)
            ok += 1
            print(f"  = {rel} now has SE + SW")
        except PixelLabError as e:
            fail += 1
            print(f"  x {rel}: {e}")
    import viewer_build
    viewer_build.build()
    print(f"expanded: {ok} ok, {fail} failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
