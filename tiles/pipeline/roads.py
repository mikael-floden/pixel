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

# Per-part prompt template + the connection pieces we ask for. `{surface}` is the
# road material, `{blend}` is the ground it must feather into at every edge.
PARTS = {
    "straight": (
        "isometric {surface} on {blend}, straight road pieces only, one flat "
        "64x64 layer, seamlessly tileable: "
        "1) straight road running along the north-east to south-west diagonal "
        "2) straight road running along the north-west to south-east diagonal "
        "3) wide straight road 4) narrow worn footpath "
        "5) straight road with wheel ruts and scattered stones "
        "6) straight road with a frayed end — "
        "every piece centered and feathering smoothly into the surrounding {blend} "
        "on all four sides so it tiles against plain {blend}."
    ),
    "turns": (
        "isometric {surface} on {blend}, road bend and corner pieces only, one "
        "flat 64x64 layer, seamlessly tileable: "
        "1) bend connecting the north-east and south-east edges "
        "2) bend connecting the north-west and south-west edges "
        "3) bend connecting the north-east and north-west edges "
        "4) bend connecting the south-east and south-west edges "
        "5) gentle sweeping curve 6) tight hairpin corner — "
        "every piece feathering smoothly into the surrounding {blend} so it tiles "
        "against plain {blend}."
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
