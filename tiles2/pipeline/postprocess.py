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
import tilemeta

DEFAULTS = {"neutralize_outline": True, "darkness_thresh": 60,
            "harmonize": {"hue_strength": 0.9, "sat_strength": 0.6, "v_strength": 0.65},
            "deseam": {"enabled": False, "band": 3, "darkness_thresh": 70,
                       "strength": 0.9, "protect_dark_material": True},
            "clean_top_rim": {"enabled": False, "factor": 0.86, "band": 4,
                              "strength": 1.0, "top_frac": 0.58,
                              "protect_dark_material": True, "edge_margin": 22},
            "gap_close": {"enabled": False, "alpha_thresh": 16, "grow": 2},
            "fade_outline": {"enabled": False, "darkness_thresh": 60, "soft_lum": 120,
                             "run_min": 9, "thick_max": 3, "strength": 0.6,
                             "rim_strength": 0.4, "min_alpha": 0,
                             "seam_strength": 0.0, "seam_jump": 70, "seam_bright": 130,
                             "seam_nbr_sat": 90, "seam_rows": 1,
                             "thin_lum_light": 120, "light_value": 180,
                             "strength_light": 0.97, "rim_strength_light": 0.9,
                             "soft_lum_light": 160,
                             "protect_dark_material": True}}


def _pp_cfg(cfg):
    pp = (cfg.get("postprocess") or {}) if cfg else {}
    out = {**DEFAULTS, **pp}
    out["harmonize"] = {**DEFAULTS["harmonize"], **(pp.get("harmonize") or {})}
    out["deseam"] = {**DEFAULTS["deseam"], **(pp.get("deseam") or {})}
    out["clean_top_rim"] = {**DEFAULTS["clean_top_rim"], **(pp.get("clean_top_rim") or {})}
    out["gap_close"] = {**DEFAULTS["gap_close"], **(pp.get("gap_close") or {})}
    out["fade_outline"] = {**DEFAULTS["fade_outline"], **(pp.get("fade_outline") or {})}
    return out


def _fade_kwargs(fo):
    """Args for normalize.fade_outline_alpha from the fade_outline config (minus enabled)."""
    return {k: fo[k] for k in ("darkness_thresh", "soft_lum", "run_min", "thick_max",
                               "strength", "rim_strength", "min_alpha",
                               "seam_strength", "seam_jump", "seam_bright", "seam_nbr_sat",
                               "seam_rows", "thin_lum_light", "light_value",
                               "strength_light", "rim_strength_light", "soft_lum_light",
                               "protect_dark_material")}


def _first_base_sheet(gid):
    """Raw dir of the harmonise reference: the earliest BASE sheet, or — for
    elevation-only types with no base tiles (e.g. crystal_ice) — the earliest
    ELEVATION sheet, so they still get a canonical colour and get normalised."""
    for kind in ("base", "elevation"):
        sheets = common.list_raw_sheets(gid, kind=kind)
        if sheets:
            sheets.sort(key=lambda s: s[2].get("generated_at", ""))
            return sheets[0][1]
    return None


def type_target(gid, cfg, cache):
    """Material target for a type (cached). Auto-detected from its first base (or,
    for base-less elevation types, elevation) sheet; recorded in the type metadata."""
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

    # Material colour targets for per-tile classification (edges/composition/features).
    mtargets = {}
    if t_from:
        mtargets[gid] = tilemeta.target_abL(t_from)
    if t_to:
        mtargets[other] = tilemeta.target_abL(t_to)
    ctx = {"ground_type": gid, "transition_to": other}
    raw_by_file = {t["file"]: t for t in (req.get("tiles") or [])}

    ds = pp["deseam"]
    cr = pp["clean_top_rim"]
    gc = pp["gap_close"]
    fo = pp["fade_outline"]
    # guard on the DARKER of the two materials so a transition INTO black_mountain
    # still trips the dark-material protection
    fade_mt = min([t for t in (t_from, t_to) if t],
                  key=lambda x: x.get("value", 255), default=None)

    tiles_meta = []
    for fn in common.tile_files(sdir):
        im = Image.open(os.path.join(sdir, fn)).convert("RGBA")
        if pp["neutralize_outline"]:
            im = normalize.neutralize_outline(im, darkness_thresh=pp["darkness_thresh"])
        im = normalize.harmonize(im, t_from, hs["hue_strength"], hs["sat_strength"], hs["v_strength"])
        if t_to:
            im = normalize.harmonize(im, t_to, hs["hue_strength"], hs["sat_strength"], hs["v_strength"])
        if ds.get("enabled"):                          # erase the tessellating diamond-edge grid seam
            im = normalize.deseam_diamond(
                im, band=ds["band"], darkness_thresh=ds["darkness_thresh"],
                strength=ds["strength"], material_target=fade_mt,
                protect_dark_material=ds["protect_dark_material"])
        if fo.get("enabled"):                          # fade AFTER harmonize (which restores alpha)
            im = normalize.fade_outline_alpha(im, material_target=fade_mt, **_fade_kwargs(fo))
        if cr.get("enabled"):                          # lighten the top-diamond rim so tessellating
            im = normalize.clean_top_rim(               # tiles show no seam at shared vertices/edges
                im, material_target=fade_mt, factor=cr["factor"], band=cr["band"],
                strength=cr["strength"], top_frac=cr["top_frac"],
                protect_dark_material=cr["protect_dark_material"],
                edge_margin=cr.get("edge_margin", 22))
        if gc.get("enabled"):                          # LAST: bleed silhouette outward to close
            im = normalize.close_iso_gaps(              # the background-through-gaps grid seam
                im, alpha_thresh=gc["alpha_thresh"], grow=gc["grow"])
        im.save(os.path.join(dest, fn))
        # Per-tile map-builder metadata computed on the FINAL (harmonised) image.
        entry = dict(raw_by_file.get(fn, {"file": fn}))
        entry.update(tilemeta.tile_metadata(im, mtargets, ctx))
        tiles_meta.append(entry)
    n = len(tiles_meta)

    # Metadata is part of DONE: a base/transition tile isn't finished without its
    # per-tile edges + composition (maps2's auto-tiler consumes these; if they're
    # missing it has to re-derive from pixels). Surface any gap loudly rather than
    # committing a half-described sheet.
    complete = sum(1 for t in tiles_meta if "edges" in t and "composition" in t)
    if complete < n:
        print(f"  ! INCOMPLETE metadata {gid}/{sheet}: {complete}/{n} tiles have "
              f"edges+composition (mtargets={list(mtargets)}) — not done without it")

    dest_meta = {
        "schema": "tiles2/sheet@1",
        "sheet": sheet, "ground_type": gid, "kind": kind, "transition_to": other,
        "tile_id": req.get("tile_id"), "settings": req.get("settings"),
        "count": n, "metadata_complete": complete == n,
        "tiles": tiles_meta, "generated_at": req.get("generated_at"),
        "processing": {
            "source_raw": os.path.relpath(sdir, common.type_dir(gid)),
            "neutralize_outline": pp["neutralize_outline"],
            "harmonize": hs,
            "harmonized_from": bool(t_from),
            "harmonized_to": bool(t_to),
            "deseam": ds if ds.get("enabled") else False,
            "clean_top_rim": cr if cr.get("enabled") else False,
            "gap_close": gc if gc.get("enabled") else False,
            "fade_outline": fo if fo.get("enabled") else False,
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
        if req.get("kind") == "elevation":
            continue                       # elevation sheets are handled by elevation.py
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
