"""Post-process raw sheets into base/ and transitions/, per the tiles2 spec.

For each raw sheet of a ground type:
  * base sheet      -> tiles2/<gid>/base/<sheet>/
  * transition sheet-> tiles2/<gid>/transitions/<other>/<sheet>/

Every tile is outline-neutralised (tiles2 is "no outline"), then colour-normalised
to the ref-sprite(s):
  * base       -> the type's own ref-sprite
  * transition -> BOTH refs (the "from" type's ref for its material, the "to"
                  type's ref for the other material)
If a needed ref-sprite isn't declared yet, tiles are copied as-is (outline still
neutralised). Raw is never modified, so tweak a ref / the config and re-run to
re-normalise everything.

  python tiles2/pipeline/postprocess.py                # all types
  python tiles2/pipeline/postprocess.py saturated_grass
"""

from __future__ import annotations

import json
import os
import sys

from PIL import Image

import common
import normalize

DEFAULTS = {"neutralize_outline": True, "darkness_thresh": 60, "strength": 1.0}


def _pp_cfg(cfg):
    return {**DEFAULTS, **((cfg.get("postprocess") or {}) if cfg else {})}


def _load_ref(gid, cfg):
    """Return ref stats for a type from its metadata.ref_sprite, or None."""
    meta = common.load_type_meta(gid)
    ref = (meta or {}).get("ref_sprite")
    if not ref:
        return None
    p = os.path.join(common.raw_dir(gid), ref["sheet"], ref["tile"])
    if not os.path.isfile(p):
        return None
    return normalize.stats(Image.open(p).convert("RGBA"))


def process_sheet(gid, sheet, sdir, req, cfg, ref_cache):
    pp = _pp_cfg(cfg)
    kind = req.get("kind", "base")
    other = req.get("transition_to")
    if kind == "transition":
        dest = os.path.join(common.trans_dir(gid, other), sheet)
        ref_from = ref_cache.setdefault(gid, _load_ref(gid, cfg))
        ref_to = ref_cache.setdefault(other, _load_ref(other, cfg))
    else:
        dest = os.path.join(common.base_dir(gid), sheet)
        ref_from = ref_cache.setdefault(gid, _load_ref(gid, cfg))
        ref_to = None
    os.makedirs(dest, exist_ok=True)

    n = 0
    for fn in common.tile_files(sdir):
        im = Image.open(os.path.join(sdir, fn)).convert("RGBA")
        if pp["neutralize_outline"]:
            im = normalize.neutralize_outline(im, darkness_thresh=pp["darkness_thresh"])
        if kind == "transition":
            im = normalize.normalize_transition(im, ref_from, ref_to, pp["strength"])
        elif ref_from is not None:
            im = normalize.normalize_base(im, ref_from, pp["strength"])
        im.save(os.path.join(dest, fn))
        n += 1

    # Mark the raw request processed (+ where it went, + whether normalised).
    req["processed"] = True
    req["processed_to"] = os.path.relpath(dest, common.type_dir(gid))
    req["normalized"] = bool(ref_from) if kind == "base" else bool(ref_from and ref_to)
    with open(os.path.join(sdir, "request.json"), "w") as f:
        json.dump(req, f, indent=2)
    return n


def process_type(gid, cfg, ref_cache=None):
    ref_cache = {} if ref_cache is None else ref_cache
    total = 0
    for sheet, sdir, req in common.list_raw_sheets(gid):
        total += process_sheet(gid, sheet, sdir, req, cfg, ref_cache)
    return total


def main():
    cfg = common.load_config()
    only = set(sys.argv[1:])
    ids = [g["id"] for g in cfg["ground_types"]]
    ref_cache = {}
    grand = 0
    for gid in ids:
        if only and gid not in only:
            continue
        n = process_type(gid, cfg, ref_cache)
        if n:
            print(f"  {gid:18s} processed {n} tile(s)")
        grand += n
    print(f"post-processed {grand} tile(s)")


if __name__ == "__main__":
    main()
