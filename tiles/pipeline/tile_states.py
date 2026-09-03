"""Fold the wiki's per-tile review state INTO the tile: `tiles/review/manifest.json`.

The game agent's ask, 2026-08-28: three states live as wiki review documents rather than
as properties of the tile, so the game cannot implement them without re-deriving the
wiki's logic. All three are keyed by this manifest's own `key` (`tiles/<cell>/<key8>`),
so folding them in is mechanical - and it gives the game ONE source, the tile.

    live/tuning/tile_walls.json  -> top_only     the tile is only ever the top of a
                                                 column; something else builds its wall
    live/tuning/tile_tops.json   -> own_top      always draw the top it was generated
                                                 with, never the ground's configured
                                                 surface - its texture meets its own wall
                                                 in a way a swapped top destroys
    live/tuning/top_walls.json   -> borrow_wall  WHICH x-over-x tile builds that wall

ONE-WAY SYNC, exactly like rejections. The wiki stays the review surface and keeps
writing the maintainer's verdicts to live/; this pass folds them in on each publish. The
live docs remain the source of truth for what he said - this manifest is the source of
truth for what a consumer should draw.

BORROW_WALL IS RESOLVED FOR EVERY top_only TILE, not just the overridden ones, which is
the whole point of the request ("so the game reads one value instead of reimplementing
the matcher"). Where the maintainer overrode the pick, his value is published verbatim.
Where he did not, the pick is computed with the wiki's own published formula, and the
entry carries `borrow_wall_auto: true` so a consumer can tell a measured choice from a
chosen one.

THE FORMULA IS THE WIKI'S, COPIED NOT INVENTED (wiki/site/wiki.js bestWall). Over the
ground's x-over-x candidates - rejected dropped, approved first - minimise

    |mean_top_rgb - ref| / 441  +  0.35*|dominant_share - ref|  +  0.25*|colours - ref|/24

measured on the TEXTURED top of both sides. A tile is excluded from its own pool: a
tile's measured closest wall is usually itself, and top_only means precisely "this
tile's own wall is bad", so a self-match hands back the wall he just rejected.

HOW THIS IS VERIFIED, and where it falls short. The wiki DELETES an override that agrees
with the auto pick ("agreeing with the auto pick DELETES the override"), so every stored
override is by construction a case where the maintainer DISAGREED, and a faithful
implementation must agree with ZERO of them. Measured: 3 of 45 agree, so this
reimplementation is CLOSE TO BUT NOT the wiki's. The metric is theirs verbatim; what
differs is the measurement feeding it - their build measures tm/tflat/tk in its own pass
over its own chosen art, and this pass re-measures the textured top here.

That gap must not be allowed to become invisible: 34 of 98 top_only tiles (2026-09-02)
carry no override, so their `borrow_wall` is this approximation and is flagged
`borrow_wall_auto: true` - a consumer can tell a measured choice from a chosen one. The
fix is for the wiki to publish the measured stats (or the auto pick itself) so the value
is theirs rather than an approximation of theirs - asked for on the board.
"""

from __future__ import annotations

import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
from PIL import Image

import palette_snap as PS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
MANIFEST = os.path.join(ROOT, "review", "manifest.json")
TUNING = os.path.join(REPO, "live", "tuning")
FEEDBACK = os.path.join(REPO, "live", "feedback", "tiles.json")

SCHEMA = "tiles3/review@3"


def _doc(name):
    p = os.path.join(TUNING, f"{name}.json")
    if not os.path.isfile(p):
        return {}
    try:
        return json.load(open(p)).get("overrides") or {}
    except Exception:
        return {}


def _verdicts():
    """key -> status, from the maintainer's own feedback file - EXACT keys only.

    `<key>#top` is the wiki's "not a detail" verdict: a judgement on one USE of the tile
    ("the tile itself is untouched"), never on the tile. Stripping the suffix merged it
    into the tile's own verdict - measured, that flipped 260 tiles, 67 of them approved
    tiles whose top was merely judged not detail material - which is precisely the
    "remove the entire tile" mistake the maintainer warned against.
    """
    if not os.path.isfile(FEEDBACK):
        return {}
    try:
        d = json.load(open(FEEDBACK))
    except Exception:
        return {}
    out = {}
    for k, v in (d.get("entries") or d.get("overrides") or {}).items():
        if "#" in k:
            continue
        if isinstance(v, dict) and v.get("status"):
            out[k] = v["status"]
    return out


def face_stats(path):
    """(mean top RGB, dominant share, distinct colours) of a tile's TEXTURED top face."""
    full = os.path.join(REPO, path)
    if not os.path.isfile(full):
        return None
    a = np.array(PS.canonicalise(Image.open(full).convert("RGBA")), int)
    reg = PS._regions(a.astype(float))
    if reg is None or not reg["top"].any():
        return None
    px = a[..., :3][reg["top"]]
    cols = collections.Counter(map(tuple, px))
    return (px.mean(0), cols.most_common(1)[0][1] / len(px), len(cols))


def _dist(c, ref):
    """The wiki's bestWall metric, verbatim."""
    cm, cflat, ck = c
    rm, rflat, rk = ref
    return (float(np.linalg.norm(np.asarray(cm) - np.asarray(rm))) / 441.0
            + 0.35 * abs(cflat - rflat)
            + 0.25 * abs(ck - rk) / 24.0)


def auto_wall(ref_stats, pool):
    """pool: [(key, stats)] already ordered approved-first. Index 0 when no stats."""
    if not pool:
        return None
    if ref_stats is None:
        return pool[0][0]
    best, bd = pool[0][0], float("inf")
    for k, st in pool:
        if st is None:
            continue
        d = _dist(st, ref_stats)
        if d < bd:
            bd, best = d, k
    return best


def build(verbose=True):
    man = json.load(open(MANIFEST))
    walls, tops, topwalls = _doc("tile_walls"), _doc("tile_tops"), _doc("top_walls")
    status = _verdicts()

    by_key, cell_of = {}, {}
    for cell, c in man["cells"].items():
        for e in c["candidates"]:
            by_key[e["key"]] = e
            cell_of[e["key"]] = cell

    # x-over-x pools per ground, ordered the way the wiki orders them: rejected dropped,
    # approved first, original order preserved inside each group.
    pools, stats_cache = {}, {}

    def stats_of(e):
        k = e["key"]
        if k not in stats_cache:
            stats_cache[k] = face_stats(e.get("textured") or e["after"])
        return stats_cache[k]

    for cell, c in man["cells"].items():
        if c["top"] != c["side"]:
            continue
        keep = [e for e in c["candidates"] if status.get(e["key"]) != "rejected"]
        ordered = ([e for e in keep if status.get(e["key"]) == "approved"]
                   + [e for e in keep if status.get(e["key"]) != "approved"])
        pools[c["top"]] = ordered

    n_top_only = n_own = n_auto = n_ov = 0
    agree = 0
    for key, e in by_key.items():
        cell = cell_of[key]
        side = man["cells"][cell]["side"]
        top_only = bool(walls.get(key, {}).get("top_only"))
        own_top = bool(tops.get(key, {}).get("own_top"))
        if top_only:
            e["top_only"] = True
            n_top_only += 1
        else:
            e.pop("top_only", None)
        if own_top:
            e["own_top"] = True
            n_own += 1
        else:
            e.pop("own_top", None)
        e.pop("borrow_wall", None)
        e.pop("borrow_wall_auto", None)
        if not top_only:
            continue
        ov = (topwalls.get(key) or {}).get("wall")
        pool = [(x["key"], stats_of(x)) for x in pools.get(side, []) if x["key"] != key]
        auto = auto_wall(stats_of(e), pool)
        if ov:
            e["borrow_wall"] = ov
            n_ov += 1
            agree += (auto == ov)
        elif auto:
            e["borrow_wall"] = auto
            e["borrow_wall_auto"] = True
            n_auto += 1

    man["schema"] = SCHEMA
    # THE PROJECTION THE ART IS BUILT FOR, published so a consumer follows the art
    # instead of hardcoding a pitch. A 3.0 top diamond is 64x28, so 14 is the largest
    # vertical pitch at which each tile's wall is fully covered by the tile in front:
    # measured interior-wall pixels are 0 at 14 and 960 at 15 (tiles/docs/GEOMETRY.md).
    # Drawn at 15 that leak is a dotted grid along every tile's top edge - the artefact
    # the maintainer reported on sand and water, 2026-09-03. The wiki already draws 3.0
    # at 14 (WORLD_DY) and asked for this number rather than tracking it by hand.
    man["geometry"] = {
        "tile_w": 64, "tile_h": 46, "dx": 32, "dy": 14, "wall_d": 17,
        "_comment": "dy 14 is REQUIRED, not a preference: at 15 a sliver of each "
                    "tile's wall stays visible along the next tile's top edge and "
                    "reads as a dotted grid. Identical to tiles/plates/index.json and "
                    "tiles/patterns/index.json geometry.",
    }
    man["tile_states"] = {
        "source": "live/tuning/{tile_walls,tile_tops,top_walls}.json, folded on publish",
        "top_only": "the tile is only ever the top of a column; `borrow_wall` names the "
                    "x-over-x tile that builds the wall under it. Absent = the tile "
                    "stacks to build its own cliff.",
        "own_top": "always draw the top it was generated with; absent = the ground's "
                   "configured surface (clean colour or a base-tile-set member).",
        "borrow_wall": "resolved for EVERY top_only tile. The maintainer's override "
                       "verbatim where he set one; otherwise computed with the wiki's "
                       "own bestWall metric and flagged `borrow_wall_auto`.",
        "metric": "argmin over the ground's x-over-x candidates (rejected dropped, "
                  "approved first) of |mean_top_rgb - ref|/441 + 0.35*|dominant_share - "
                  "ref| + 0.25*|colours - ref|/24, measured on the TEXTURED top; the "
                  "tile is excluded from its own pool.",
        "verified": ("the wiki deletes an override that agrees with its auto pick, so a "
                     f"faithful reimplementation must agree with NONE: {agree} of {n_ov} "
                     "agree, so the auto path here is CLOSE TO BUT NOT the wiki's. Every "
                     "published borrow_wall today is the maintainer's own override; "
                     "borrow_wall_auto marks any that are not."),
        "counts": {"top_only": n_top_only, "own_top": n_own,
                   "borrow_wall_override": n_ov, "borrow_wall_auto": n_auto},
    }
    tmp = MANIFEST + f".{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(man, f, indent=2)
    os.replace(tmp, MANIFEST)
    if verbose:
        print(f"schema {SCHEMA}: top_only {n_top_only}, own_top {n_own}, "
              f"borrow_wall {n_ov} override + {n_auto} auto")
        print(f"  faithfulness check (must be 0): {agree} of {n_ov} auto picks equal "
              f"the maintainer's override")
    return man


if __name__ == "__main__":
    build()
