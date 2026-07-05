"""Generate ONE tile sheet (base or transition) and download it to raw/.

Every request is saved under tiles2/<gid>/raw/<sheet>/ with the tiles plus a
request.json recording the exact prompt + settings + whether it was a `base` or
`transition` sheet. Nothing is normalised here — that's postprocess.py's job.
"""

from __future__ import annotations

import datetime
import json
import os

import common

ENDPOINT = "/create-tiles-pro"


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def build_base_prompt(cfg, gt):
    p = cfg["prompt"]
    return p["base_template"].format(
        description=gt["description"], name=gt.get("name", gt["id"]),
        style=p["style"], variations=p["base_variations"])


def build_transition_prompt(cfg, frm, to):
    p = cfg["prompt"]
    variations = p["transition_variations"].format(
        from_name=frm.get("name", frm["id"]), to_name=to.get("name", to["id"]))
    return p["transition_template"].format(
        from_desc=frm["description"], to_desc=to["description"],
        style=p["style"], variations=variations)


def _settings(cfg):
    t = cfg["tile"]
    return {
        "endpoint": ENDPOINT, "tile_type": t["type"], "tile_size": t["size"],
        "tile_view": t["view"], "tile_view_angle": t["view_angle"],
        "tile_depth_ratio": t["depth_ratio"], "tile_flat_top_px": t["flat_top_px"],
    }


def _generate(client, cfg, gt, kind, prompt, other=None):
    gid = gt["id"]
    common.ensure_type_meta(gt, cfg)
    idx = len(common.list_raw_sheets(gid, kind=kind, other=other))
    seed = common._seed(gid, kind, other or "", idx)
    slug = common.sheet_slug(kind, seed, other=other)
    t = cfg["tile"]
    tiles, tile_id = client.create_tiles(
        description=prompt, tile_size=t["size"], tile_view=t["view"],
        view_angle=t["view_angle"], depth_ratio=t["depth_ratio"],
        tile_type=t["type"], flat_top_px=t["flat_top_px"], seed=seed)

    sdir = os.path.join(common.raw_dir(gid), slug)
    os.makedirs(sdir, exist_ok=True)
    tile_meta = []
    for i, im in enumerate(tiles):
        fn = f"tile_{i:02d}.png"
        im.save(os.path.join(sdir, fn))
        tile_meta.append({"index": i, "file": fn, "width": im.width, "height": im.height})
    req = {
        "schema": common.RAW_SCHEMA,
        "sheet": slug,
        "ground_type": gid,
        "kind": kind,                       # base | transition
        "transition_to": other,             # None for base
        "tile_id": tile_id,                 # PixelLab id (sync: gone in UI -> drop from git)
        "prompt": prompt,
        "settings": _settings(cfg),
        "seed": seed,
        "count": len(tile_meta),
        "tiles": tile_meta,
        "generated_at": _now(),
        "processed": False,                 # postprocess.py flips this
    }
    with open(os.path.join(sdir, "request.json"), "w") as f:
        json.dump(req, f, indent=2)
    return req


def generate_base(client, cfg, gt):
    return _generate(client, cfg, gt, "base", build_base_prompt(cfg, gt))


def generate_transition(client, cfg, frm, to):
    return _generate(client, cfg, frm, "transition",
                     build_transition_prompt(cfg, frm, to), other=to["id"])
