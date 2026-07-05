"""Post-process raw sheets into base/ and transitions/, per the tiles2 spec.

For each raw sheet of a ground type:
  * base sheet       -> tiles2/<gid>/base/<sheet>/
  * transition sheet -> tiles2/<gid>/transitions/<other>/<sheet>/

Each tile is (optionally) outline-softened, then **harmonised**: the type's dominant
MATERIAL colour is auto-detected once from its reference (first base) sheet, and
every tile's material pixels are pulled to it (hue/saturation + mean brightness),
so a type's sheets read as one material — while dirt sides, rock and flowers are
left untouched (see normalize.py). Transitions harmonise BOTH materials (from-type
then to-type). The target is derived from the first base sheet, so it's stable and
the whole thing is re-runnable from raw at zero API cost.

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

DEFAULTS = {"neutralize_outline": True, "darkness_thresh": 60,
            "harmonize": {"ab_strength": 0.8, "v_strength": 0.65}}


def _pp_cfg(cfg):
    pp = (cfg.get("postprocess") or {}) if cfg else {}
    out = {**DEFAULTS, **pp}
    out["harmonize"] = {**DEFAULTS["harmonize"], **(pp.get("harmonize") or {})}
    return out


def _first_base_sheet(gid):
    """Raw dir of the earliest base sheet for a type (the harmonise reference)."""
    sheets = common.list_raw_sheets(gid, kind="base")
    if not sheets:
        return None
    sheets.sort(key=lambda s: s[2].get("generated_at", ""))
    return sheets[0][1]


def type_target(gid, cfg, cache):
    """Material target for a type (cached). Auto-detected from its first base
    sheet; also recorded in the type metadata for transparency."""
    if gid in cache:
        return cache[gid]
    sdir = _first_base_sheet(gid)
    target = None
    if sdir:
        imgs = [Image.open(os.path.join(sdir, f)).convert("RGBA") for f in common.tile_files(sdir)]
        target = normalize.material_target(imgs)
    cache[gid] = target
    if target:
        meta = common.load_type_meta(gid) or {}
        meta["harmonize_target"] = target
        common.save_type_meta(gid, meta)
    return target


def process_sheet(gid, sheet, sdir, req, cfg, cache):
    pp = _pp_cfg(cfg)
    hs = pp["harmonize"]
    kind = req.get("kind", "base")
    other = req.get("transition_to")
    dest = os.path.join(common.trans_dir(gid, other) if kind == "transition"
                        else common.base_dir(gid), sheet)
    os.makedirs(dest, exist_ok=True)

    t_from = type_target(gid, cfg, cache)
    t_to = type_target(other, cfg, cache) if kind == "transition" else None

    n = 0
    for fn in common.tile_files(sdir):
        im = Image.open(os.path.join(sdir, fn)).convert("RGBA")
        if pp["neutralize_outline"]:
            im = normalize.neutralize_outline(im, darkness_thresh=pp["darkness_thresh"])
        im = normalize.harmonize(im, t_from, hs["ab_strength"], hs["v_strength"])
        if t_to:
            im = normalize.harmonize(im, t_to, hs["ab_strength"], hs["v_strength"])
        im.save(os.path.join(dest, fn))
        n += 1

    dest_meta = {
        "schema": "tiles2/sheet@1",
        "sheet": sheet, "ground_type": gid, "kind": kind, "transition_to": other,
        "tile_id": req.get("tile_id"), "settings": req.get("settings"),
        "count": n, "tiles": req.get("tiles"), "generated_at": req.get("generated_at"),
        "processing": {
            "source_raw": os.path.relpath(sdir, common.type_dir(gid)),
            "neutralize_outline": pp["neutralize_outline"],
            "harmonize": hs,
            "harmonized_from": bool(t_from),
            "harmonized_to": bool(t_to),
        },
    }
    with open(os.path.join(dest, "metadata.json"), "w") as f:
        json.dump(dest_meta, f, indent=2)

    req["processed"] = True
    req["processed_to"] = os.path.relpath(dest, common.type_dir(gid))
    with open(os.path.join(sdir, "request.json"), "w") as f:
        json.dump(req, f, indent=2)
    return n


def process_type(gid, cfg, cache=None):
    cache = {} if cache is None else cache
    total = 0
    for sheet, sdir, req in common.list_raw_sheets(gid):
        total += process_sheet(gid, sheet, sdir, req, cfg, cache)
    return total


def main():
    cfg = common.load_config()
    only = set(sys.argv[1:])
    cache = {}
    grand = 0
    for gt in cfg["ground_types"]:
        gid = gt["id"]
        if only and gid not in only:
            continue
        n = process_type(gid, cfg, cache)
        if n:
            print(f"  {gid:18s} harmonised {n} tile(s)")
        grand += n
    print(f"post-processed {grand} tile(s)")


if __name__ == "__main__":
    main()
