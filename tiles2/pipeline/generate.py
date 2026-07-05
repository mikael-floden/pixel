"""Generate ONE tile sheet (base or transition) and download it to raw/.

A sheet is N individual /create-isometric-tile calls (one no-outline 64x64 tile
each, cycling the config variation list for variety). Everything is saved under
tiles2/<gid>/raw/<sheet>/ with the tiles plus a request.json recording each tile's
exact prompt + the shared settings + whether the sheet was `base` or `transition`.
Nothing is normalised here — that's postprocess.py's job.
"""

from __future__ import annotations

import datetime
import json
import os

import common
from pixellab_client import PixelLabError

ENDPOINT = "/create-isometric-tile"


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def base_desc(cfg, gt, variation):
    p = cfg["prompt"]
    return p["base_template"].format(desc=gt["description"], variation=variation, style=p["style"])


def transition_desc(cfg, frm, to, variation):
    p = cfg["prompt"]
    v = variation.format(from_name=frm.get("name", frm["id"]), to_name=to.get("name", to["id"]))
    return p["transition_template"].format(
        from_desc=frm["description"], to_desc=to["description"], variation=v, style=p["style"])


def _settings(cfg):
    t = cfg["tile"]
    return {
        "endpoint": ENDPOINT, "image_size": t["size"], "isometric_tile_shape": t["shape"],
        "outline": t["outline"], "shading": t["shading"], "detail": t["detail"],
    }


def _generate(client, cfg, gt, kind, variations, other=None, to_gt=None):
    gid = gt["id"]
    common.ensure_type_meta(gt, cfg)
    t = cfg["tile"]
    n = cfg["targets"].get("tiles_per_sheet", 8)
    idx = len(common.list_raw_sheets(gid, kind=kind, other=other))
    base_seed = common._seed(gid, kind, other or "", idx)
    slug = common.sheet_slug(kind, base_seed, other=other)
    sdir = os.path.join(common.raw_dir(gid), slug)
    os.makedirs(sdir, exist_ok=True)

    tile_meta = []
    saved = 0
    for i in range(n):
        variation = variations[i % len(variations)]
        if kind == "transition":
            desc = transition_desc(cfg, gt, to_gt, variation)
        else:
            desc = base_desc(cfg, gt, variation)
        seed = (base_seed + i) % (2 ** 31)
        try:
            im = client.create_isometric_tile(
                description=desc, image_size=t["size"], tile_shape=t["shape"],
                outline=t["outline"], shading=t["shading"], detail=t["detail"], seed=seed)
        except PixelLabError as e:
            print(f"    ! tile {i} failed: {e}")
            continue
        if im is None:
            continue
        fn = f"tile_{saved:02d}.png"
        im.save(os.path.join(sdir, fn))
        tile_meta.append({"index": saved, "file": fn, "width": im.width,
                          "height": im.height, "prompt": desc, "seed": seed})
        saved += 1

    if saved == 0:
        raise PixelLabError(f"no tiles generated for {gid} {kind} sheet")

    req = {
        "schema": common.RAW_SCHEMA,
        "sheet": slug, "ground_type": gid, "kind": kind, "transition_to": other,
        "settings": _settings(cfg), "count": saved, "tiles": tile_meta,
        "generated_at": _now(), "processed": False,
    }
    with open(os.path.join(sdir, "request.json"), "w") as f:
        json.dump(req, f, indent=2)
    return req


def generate_base(client, cfg, gt):
    return _generate(client, cfg, gt, "base", cfg["prompt"]["base_variations"])


def generate_transition(client, cfg, frm, to):
    return _generate(client, cfg, frm, "transition", cfg["prompt"]["transition_variations"],
                     other=to["id"], to_gt=to)
