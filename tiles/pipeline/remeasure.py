"""Re-emit every existing tiles.json with the current geometry/stacking fields.

Pure local re-measurement of the already-downloaded PNGs (no PixelLab calls), so
old sets pick up the corrected level unit (19px) and the new bottom-anchor
placement data (`apex_y`, `base_y`, `image_height`, `levels`, `align`). Run after
changing the elevation model in tilegen.py.

  python tiles/pipeline/remeasure.py
"""

from __future__ import annotations

import json
import os

from PIL import Image

import tilegen


def main():
    updated = 0
    for m in tilegen.list_categories():
        cid = m["category"]
        cdir = tilegen.category_dir(cid)
        tile_size = m.get("tile_size", 64)
        tile_height = m.get("tile_height")
        imgs, metas = [], []
        for tm in m.get("tiles", []):
            p = os.path.join(cdir, tm["file"])
            if os.path.isfile(p):
                imgs.append(Image.open(p))
                metas.append(tm)
        if not imgs:
            continue
        geom, per_tile = tilegen.set_geometry(imgs, tile_size)
        for tm, pt in zip(metas, per_tile):
            tm.update(pt)
        m["geometry"] = geom
        m["stacking"] = tilegen.stacking_info(geom, tile_size, tile_height)
        with open(os.path.join(cdir, "tiles.json"), "w") as f:
            json.dump(m, f, indent=2)
        updated += 1
        s = m["stacking"]
        print(f"  {cid:18s} face={s['face_height_px']}px layers={s['layers']} "
              f"levels={s['levels']} align={s['align']} base_y={s['base_y']}")
    print(f"re-measured {updated} tile set(s)")


if __name__ == "__main__":
    main()
