"""Rebuild the raw tile matrix from PixelLab, free, using ids we already paid for.

Why this exists
---------------
`tiles/matrix/` is gitignored — 18,777 tiles, 86 MB, almost all of them rejects — so it
lives only on whatever machine last ran the pipeline. The maintainer asked the obvious
question when they wanted to relax a gate: is that art still there, or does loosening
the filter mean paying to generate it again?

Neither, as it turns out. Every sheet's `tile_id` is recorded in `tiles/generated.json`,
which IS committed, and `PixelLabClient.fetch_tiles` re-downloads a completed sheet at
no cost because the generation is already paid for. So the local matrix is a CACHE and
the registry is the master copy.

That was a claim until this file existed. `--verify` tests it: fetch a sample and
compare pixel-for-pixel against the local copy. Measured on the first run, 4 of 4 sheets
came back byte-identical across 64 tiles.

  python tiles/pipeline/restore.py --verify 8     # prove the round-trip still works
  python tiles/pipeline/restore.py --check        # which ids are still retrievable
  python tiles/pipeline/restore.py --fetch        # rebuild whatever is missing locally

WHAT WOULD BREAK IT. Only deletion on PixelLab's side. pixellab_gc marks rejected
generations and `--apply` deletes them permanently — which is why a rejection should
stop at "never publish this again" (tombstones already do that) rather than reaching
for the delete. The maintainer overruled the filter on 40 tiles it had discarded; that
is only possible while the art still exists.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
from PIL import Image

from pixellab_client import PixelLabClient, PixelLabError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MATRIX = os.path.join(ROOT, "matrix")
REGISTRY = os.path.join(ROOT, "generated.json")


def registry():
    return json.load(open(REGISTRY))["items"]


def local_sheets():
    """tile_id -> the sheet directory holding it, from each sheet's own meta.json."""
    out = {}
    for m in glob.glob(os.path.join(MATRIX, "*", "sheet_*", "meta.json")):
        try:
            tid = json.load(open(m)).get("tile_id")
        except Exception:
            continue
        if tid:
            out[tid] = os.path.dirname(m)
    return out


def verify(n):
    """Fetch a sample and compare against disk. Identity, not 'it returned something'."""
    import random
    reg, loc = registry(), local_sheets()
    ids = [t for t in loc if reg.get(t, {}).get("status") != "deleted"]
    random.seed(11)
    ids = random.sample(ids, min(n, len(ids)))
    c = PixelLabClient()
    ok = 0
    for tid in ids:
        d = loc[tid]
        try:
            imgs = c.fetch_tiles(tid)
        except PixelLabError as e:
            print(f"  {tid[:8]}  FETCH FAILED: {str(e)[:60]}")
            continue
        files = sorted(glob.glob(os.path.join(d, "tile_*.png")))
        diff = 0
        for i, p in enumerate(files[:len(imgs)]):
            a = np.asarray(Image.open(p).convert("RGBA"))
            b = np.asarray(imgs[i].convert("RGBA"))
            if a.shape != b.shape or not np.array_equal(a, b):
                diff += 1
        print(f"  {tid[:8]}  {len(imgs):2d} tiles, {diff} differing"
              f"   {'OK' if diff == 0 else 'MISMATCH'}")
        ok += diff == 0
    print(f"\n{ok}/{len(ids)} sheets round-tripped byte-identical")
    return 0 if ok == len(ids) else 1


def check():
    """Which registered generations are still retrievable from PixelLab."""
    reg = registry()
    c = PixelLabClient()
    gone, live, skipped = [], 0, 0
    for i, (tid, meta) in enumerate(sorted(reg.items())):
        if meta.get("status") == "deleted":
            skipped += 1
            continue
        try:
            c._get(f"/tiles-pro/{tid}")
            live += 1
        except PixelLabError:
            gone.append(tid)
        if (i + 1) % 100 == 0:
            print(f"  checked {i + 1}/{len(reg)}...", flush=True)
    print(f"\nretrievable: {live}   MISSING: {len(gone)}   already-deleted: {skipped}")
    for t in gone[:20]:
        print(f"   gone: {t}  {reg[t].get('purpose')}")
    return gone


def fetch():
    """Re-download every registered sheet that is not on disk."""
    reg, loc = registry(), local_sheets()
    c = PixelLabClient()
    n = 0
    for tid, meta in sorted(reg.items()):
        if tid in loc or meta.get("status") == "deleted":
            continue
        purpose = meta.get("purpose", "")
        if not purpose.startswith("matrix:"):
            continue
        cell = purpose.split(":", 1)[1].replace("_over_", "__over__")
        d = os.path.join(MATRIX, cell, f"sheet_restored_{tid[:8]}")
        try:
            imgs = c.fetch_tiles(tid)
        except PixelLabError as e:
            print(f"  {tid[:8]}  failed: {str(e)[:60]}")
            continue
        os.makedirs(d, exist_ok=True)
        for j, im in enumerate(imgs):
            im.save(os.path.join(d, f"tile_{j:02d}.png"))
        with open(os.path.join(d, "meta.json"), "w") as f:
            json.dump({"cell": cell, "tile_id": tid, "style": "restored",
                       "prompt": meta.get("prompt", ""), "n_tiles": len(imgs)}, f, indent=2)
        n += 1
        print(f"  restored {cell}/{os.path.basename(d)}  {len(imgs)} tiles", flush=True)
    print(f"\nrestored {n} sheet(s)")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", type=int, metavar="N", help="round-trip N random sheets")
    ap.add_argument("--check", action="store_true", help="are all ids still retrievable")
    ap.add_argument("--fetch", action="store_true", help="re-download anything missing")
    args = ap.parse_args()
    if args.verify:
        return verify(args.verify)
    if args.check:
        check()
        return 0
    if args.fetch:
        return fetch()
    reg, loc = registry(), local_sheets()
    print(f"registry: {len(reg)} generations   on disk: {len(loc)}   "
          f"missing locally: {len([t for t in reg if t not in loc])}")
    print("pass --verify N, --check or --fetch")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
