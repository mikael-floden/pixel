"""Migrate raw tiles into per-category `original/` folders and (re)apply the
post-process to produce the tiles the Maps agent reads.

Layout per category:

    tiles/<cat>/original/tile_NN.png   <- untouched raw download (source of truth)
    tiles/<cat>/tile_NN.png            <- post-processed (what maps/ consumes)
    tiles/<cat>/preview.png            <- rebuilt from the processed tiles

First run MOVES the current tile_NN.png (which are the raw originals) into
`original/`. Every run then regenerates the processed tiles + preview FROM the
originals, so you can tweak `config.postprocess` and re-run to re-tune the whole
library without touching PixelLab.

  python tiles/pipeline/postprocess_tiles.py            # all categories
  python tiles/pipeline/postprocess_tiles.py grass snow  # specific ones
"""

from __future__ import annotations

import json
import os
import shutil
import sys

from PIL import Image

import postprocess
import tilegen


def _tile_files(d):
    return sorted(f for f in os.listdir(d)
                  if f.startswith("tile_") and f.endswith(".png"))


def migrate_originals(cdir):
    """Ensure tiles/<cat>/original/ holds the raw tiles. Returns the orig dir.
    One-time move of the current (raw) tile PNGs into original/."""
    odir = os.path.join(cdir, "original")
    if os.path.isdir(odir) and _tile_files(odir):
        return odir                       # already migrated
    os.makedirs(odir, exist_ok=True)
    for f in _tile_files(cdir):
        shutil.move(os.path.join(cdir, f), os.path.join(odir, f))
    return odir


def process_category(cid, cfg):
    cdir = tilegen.category_dir(cid)
    odir = migrate_originals(cdir)
    files = _tile_files(odir)
    if not files:
        return 0
    processed = []
    for f in files:
        im = Image.open(os.path.join(odir, f)).convert("RGBA")
        out = postprocess.process(im, cfg)
        out.save(os.path.join(cdir, f))
        processed.append(out)
    tilegen._preview(processed, os.path.join(cdir, "preview.png"))
    # Stamp the manifest so consumers know tiles are post-processed + where the
    # raw art lives.
    mpath = os.path.join(cdir, "tiles.json")
    if os.path.isfile(mpath):
        with open(mpath) as fh:
            m = json.load(fh)
        m["postprocess"] = {
            "applied": bool((cfg.get("postprocess") or {}).get("enabled", True)),
            "originals": "original/",
            "note": "tile_NN.png are post-processed (softened silhouette outline); "
                    "raw art in original/ can be re-processed.",
        }
        with open(mpath, "w") as fh:
            json.dump(m, fh, indent=2)
    return len(processed)


def main():
    cfg = tilegen_load_config()
    only = set(sys.argv[1:])
    total = sets = 0
    for m in tilegen.list_categories():
        cid = m["category"]
        if only and cid not in only:
            continue
        n = process_category(cid, cfg)
        if n:
            sets += 1
            total += n
    print(f"post-processed {total} tile(s) across {sets} categor(y/ies)")


def tilegen_load_config():
    with open(os.path.join(tilegen.ROOT, "config", "tiles.json")) as f:
        return json.load(f)


if __name__ == "__main__":
    main()
