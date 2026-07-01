"""Balance existing road sets so BOTH diagonal directions are present.

PixelLab tends to draw straight roads and bends in only one diagonal. This walks
every road set already on disk (manifests with a `road` block) and appends the
horizontal mirror of each tile whose mirror isn't already present — a left-right
flip swaps the NE<->NW / SE<->SW edges, i.e. flips the road's diagonal. It updates
the PNGs, the preview, and the manifest (per-tile geometry + mirrored flags). No
PixelLab calls, so it's free and deterministic. Idempotent: re-running skips tiles
that already have a mirror in the set.

  python tiles/pipeline/augment_roads.py            # all road sets
  python tiles/pipeline/augment_roads.py road_snow_turns   # specific set(s)
"""

from __future__ import annotations

import json
import os
import sys

from PIL import Image

import roads
import tilegen


def augment_set(m):
    cid = m["category"]
    cdir = tilegen.category_dir(cid)
    imgs = [Image.open(os.path.join(cdir, tm["file"])).convert("RGBA")
            for tm in m["tiles"] if os.path.isfile(os.path.join(cdir, tm["file"]))]
    if not imgs:
        return 0
    n_orig = len(imgs)
    balanced, mirror_src = roads.mirror_balance(imgs)
    added = len(mirror_src)
    if not added:
        return 0
    # Re-write every tile fresh (stable tile_NN.png numbering) + preview + geom.
    tile_size = m.get("tile_size", 64)
    tile_height = m.get("tile_height")
    geom, per_tile = tilegen.set_geometry(balanced, tile_size)
    tiles_meta = []
    for i, im in enumerate(balanced):
        fname = f"tile_{i:02d}.png"
        im.save(os.path.join(cdir, fname))
        meta = {"index": i, "file": fname, "width": im.width,
                "height": im.height, **per_tile[i]}
        if i >= n_orig:
            meta["mirrored"] = True
            meta["mirror_of"] = mirror_src[i - n_orig]
        tiles_meta.append(meta)
    tilegen._preview(balanced, os.path.join(cdir, "preview.png"))
    m["tiles"] = tiles_meta
    m["count"] = len(tiles_meta)
    m["geometry"] = geom
    m["stacking"] = tilegen.stacking_info(geom, tile_size, tile_height)
    m.setdefault("road", {})["mirror_balanced"] = True
    with open(os.path.join(cdir, "tiles.json"), "w") as f:
        json.dump(m, f, indent=2)
    return added


def main():
    only = set(sys.argv[1:])
    total_added = total_sets = 0
    for m in tilegen.list_categories():
        if not m.get("road"):
            continue
        if only and m["category"] not in only:
            continue
        added = augment_set(m)
        if added:
            total_sets += 1
            total_added += added
            print(f"  {m['category']:28s} +{added} mirror(s) -> {m['count']} tiles")
        else:
            print(f"  {m['category']:28s} already balanced")
    print(f"balanced {total_sets} set(s), added {total_added} mirrored tile(s)")


if __name__ == "__main__":
    main()
