"""Road / path tile categories.

Almost every ground type needs a dedicated road that BLENDS into it. We express
that as data in config (`roads.themes`: which surface sits on which ground) and
expand it here into focused tile sets. Each theme is split into three connection
PARTS so the Maps agent has a full road kit per ground:

    straight  — straight segments + ends
    turns     — bends / curves / corners
    junctions — T-junctions + crossroads + forks

Every road is a flat 64x64 @ 50% tile (one layer, `align: exact`) — the base
format, so no per-category overrides are needed. Each set's manifest carries a
`road` block ({part, surface, ground}) plus the isometric axis each tile connects
along, so the Maps agent can auto-tile paths.

Isometric note: the two "straight" directions run along the screen diagonals — we
call them the NE–SW axis and the NW–SE axis (a tile's flat top is a diamond, so a
road crossing it runs corner-to-corner, not left-to-right).
"""

from __future__ import annotations

import numpy as np
from PIL import Image

# Per-part prompt template + the connection pieces we ask for. `{surface}` is the
# road material, `{blend}` is the ground it must feather into at every edge.
PARTS = {
    "straight": (
        "isometric {surface} on {blend}, straight road pieces only, one flat "
        "64x64 layer, seamlessly tileable. IMPORTANT: include BOTH diagonal "
        "directions in equal numbers — some pieces run from the bottom-left up to "
        "the top-right (the north-east to south-west diagonal) and some run from "
        "the bottom-right up to the top-left (the north-west to south-east "
        "diagonal): "
        "1) straight road going from bottom-left to top-right "
        "2) straight road going from bottom-right to top-left "
        "3) wide straight road bottom-left to top-right "
        "4) narrow footpath bottom-right to top-left "
        "5) rutted road bottom-left to top-right "
        "6) worn road bottom-right to top-left — "
        "every piece centered and feathering smoothly into the surrounding {blend} "
        "on all four sides so it tiles against plain {blend}."
    ),
    "turns": (
        "isometric {surface} on {blend}, road bend and corner pieces only, one "
        "flat 64x64 layer, seamlessly tileable. Make every piece a DIFFERENT "
        "corner — cover all four ways a road can turn, do not repeat the same "
        "bend: "
        "1) bend joining the north-east and south-east edges "
        "2) bend joining the north-west and south-west edges "
        "3) bend joining the north-east and north-west edges "
        "4) bend joining the south-east and south-west edges "
        "5) a gentle sweeping curve turning the opposite way to #1 "
        "6) a tight hairpin corner turning the opposite way to #2 — "
        "each a distinct direction, feathering smoothly into the surrounding "
        "{blend} so it tiles against plain {blend}."
    ),
    "junctions": (
        "isometric {surface} on {blend}, road junction pieces only, one flat "
        "64x64 layer, seamlessly tileable: "
        "1) four-way crossroads 2) T-junction opening to the north-east "
        "3) T-junction opening to the north-west 4) T-junction opening to the "
        "south-east 5) T-junction opening to the south-west 6) three-way Y-fork — "
        "every piece feathering smoothly into the surrounding {blend} so it tiles "
        "against plain {blend}."
    ),
}

# Which pieces each part connects, recorded in metadata for auto-tiling. Edges use
# the four isometric diamond edges: ne, nw, se, sw.
PART_CONNECTS = {
    "straight": [["ne", "sw"], ["nw", "se"]],
    "turns": [["ne", "se"], ["nw", "sw"], ["ne", "nw"], ["se", "sw"]],
    "junctions": [["ne", "nw", "se", "sw"], ["ne", "nw", "se"]],
}


def _arr(im):
    return np.asarray(im.convert("RGBA"), dtype=np.int16)


def _diff(a, b):
    """Mean absolute RGBA difference, normalised to 0..1."""
    if a.shape != b.shape:
        return 1.0
    return float(np.abs(a - b).mean()) / 255.0


def mirror_balance(images, sym_thresh=0.015, dup_thresh=0.008):
    """Guarantee both diagonal directions by appending horizontal mirrors.

    In this isometric view a left-right flip swaps the NE<->NW and SE<->SW edges,
    so it turns a bottom-left→top-right road into a bottom-right→top-left one (and
    a corner into its opposite corner). PixelLab tends to draw only one diagonal,
    so we add the mirror of every DIRECTIONAL tile.

    Keep a tile's mirror when:
      * flipping actually changes the tile (self-diff > `sym_thresh`) — this skips
        (near-)symmetric pieces like a 4-way crossroads, whose mirror is itself;
      * it isn't a near-identical duplicate of something already in the set
        (> `dup_thresh`) — a light guard against redundant mirrors.

    Returns (augmented_images, src) where src[k] is the source index of the k-th
    ADDED mirror, so callers can record mirror_of in metadata.
    """
    out = list(images)
    arrs = [_arr(im) for im in out]
    added_src = []
    for i, im in enumerate(images):
        ia = arrs[i]
        m = im.transpose(Image.FLIP_LEFT_RIGHT)
        ma = _arr(m)
        if _diff(ma, ia) <= sym_thresh:                 # symmetric -> mirror adds nothing
            continue
        if any(_diff(ma, a) <= dup_thresh for a in arrs):  # already have this tile
            continue
        out.append(m)
        arrs.append(ma)
        added_src.append(i)
    return out, added_src


def road_categories(cfg):
    """Expand config `roads.themes` × PARTS into full category dicts."""
    r = cfg.get("roads") or {}
    out = []
    for th in r.get("themes", []):
        surface, blend = th["surface"], th["blend"]
        for part_key, tmpl in PARTS.items():
            out.append({
                "id": f"{th['id']}_{part_key}",
                "profile": "flat",
                "kind": "road",
                "description": tmpl.format(surface=surface, blend=blend),
                "road": {
                    "part": part_key,
                    "surface": surface,
                    "ground": th["ground"],
                    "connects": PART_CONNECTS[part_key],
                },
            })
    return out
