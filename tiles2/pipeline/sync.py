"""Sync git to PixelLab: PixelLab is the source of truth for which sheets exist.

Each generated sheet records its PixelLab `tile_id` (a create-tiles-pro item). If
you delete a tile-set in the PixelLab UI, sync notices its `tile_id` no longer
resolves (GET /tiles-pro/{id} -> 404) and removes that sheet from git — raw plus
its processed base/ or transitions/ copy. The base count then drops, so the loop
generates more to get back up to target.

Granularity note: PixelLab tracks a create-tiles-pro generation as ONE item (~16
tiles), so the deletable unit is a whole SHEET, not an individual tile.

The loop runs this at startup; you can also run it standalone:

  python tiles2/pipeline/sync.py            # all types
  python tiles2/pipeline/sync.py --dry-run
"""

from __future__ import annotations

import os
import shutil
import sys

import common
from pixellab_client import PixelLabClient


def _dest_dir(gid, req):
    kind = req.get("kind")
    if kind == "transition":
        return common.trans_dir(gid, req.get("transition_to"))
    if kind == "elevation":
        return common.elev_dir(gid, req.get("height"))     # <terrain>/base_x_N/
    return common.base_dir(gid)


def sync(cfg, client, dry_run=False):
    """Remove git sheets whose PixelLab tile_id no longer exists. Returns the
    list of removed (gid, sheet) pairs."""
    removed = []
    for gt in cfg["ground_types"]:
        gid = gt["id"]
        for sheet, sdir, req in common.list_raw_sheets(gid):
            tid = req.get("tile_id")
            if not tid:
                continue                       # pre-sync sheet; can't verify, keep
            if client.tiles_pro_exists(tid):
                continue                       # still in PixelLab, keep
            removed.append((gid, sheet))
            if dry_run:
                continue
            shutil.rmtree(sdir, ignore_errors=True)                 # raw/<sheet>
            shutil.rmtree(os.path.join(_dest_dir(gid, req), sheet), ignore_errors=True)
    return removed


def main():
    dry = "--dry-run" in sys.argv
    cfg = common.load_config()
    client = PixelLabClient()
    removed = sync(cfg, client, dry_run=dry)
    if not removed:
        print("sync: nothing to remove (git matches PixelLab)")
    for gid, sheet in removed:
        print(f"  {'would remove' if dry else 'removed'} {gid}/{sheet} (deleted in PixelLab)")
    print(f"sync: {len(removed)} sheet(s) {'to remove' if dry else 'removed'}")


if __name__ == "__main__":
    main()
