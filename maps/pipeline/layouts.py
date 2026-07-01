"""Turn a zone definition (from config) into a concrete worldgen layout.

Each archetype (small island, island with a town, cave interior, house interior)
maps to a worldgen call plus object scatter and exit placement. Output is the
`layout` dict consumed by zone.build_zone: {"H", "objects", "exits"}.
"""

from __future__ import annotations

import worldgen


def _object_specs(cfg, zone_def, tile_size):
    """Scatter specs for the objects this zone is allowed to place."""
    allowed = set(zone_def.get("objects", []))
    specs = []
    for o in cfg["objects"]:
        if o["id"] not in allowed:
            continue
        specs.append({
            "id": o["id"], "on": o.get("on", []),
            "blocks": o.get("blocks", True),
            "footprint": max(1, round(o.get("size", tile_size) / tile_size / 2)),
        })
    return specs


def _tile_size(cfg, zone_def):
    d = cfg.get("defaults", {})
    return int(zone_def.get("tile_size", d.get("tile_size", 16)))


def _links_by_kind(zone_def):
    out = {}
    for lk in zone_def.get("links", []):
        out.setdefault(lk.get("kind", "door"), []).append(lk)
    return out


def build(cfg, zone_def):
    kind = zone_def.get("archetype", "small_island")
    if kind in ("small_island", "island", "island_town"):
        return _island(cfg, zone_def, town=(kind == "island_town"))
    if kind in ("cave", "house", "interior"):
        return _interior(cfg, zone_def)
    raise ValueError(f"unknown archetype {kind!r}")


def _island(cfg, zone_def, town=False):
    cols, rows = zone_def["grid"]["width"], zone_def["grid"]["height"]
    seed = int(zone_def.get("seed", 0))
    levels = zone_def["levels"]
    ts = _tile_size(cfg, zone_def)
    H = worldgen.island(cols, rows, seed, num_levels=len(levels),
                        land_bias=zone_def.get("land_bias", 0.0))

    keep_clear = set()
    objects = []
    exits = []
    links = _links_by_kind(zone_def)

    if town:
        house_ids = [o for o in zone_def.get("houses", ["house_small"])]
        town_size = int(zone_def.get("town_size", 4))
        town_objs, occupied = worldgen.place_town(H, levels, town_size, seed, house_ids)
        objects += town_objs
        keep_clear |= occupied

    specs = _object_specs(cfg, zone_def, ts)
    objects += worldgen.scatter(H, levels, specs, seed,
                                density=zone_def.get("density", 0.06),
                                spacing=zone_def.get("spacing", 2),
                                keep_clear=keep_clear)

    # dock/harbour exit at the coast
    dock_links = links.get("dock", [{}])
    cell = worldgen.coast_dock_cell(H, levels)
    if cell:
        lk = dock_links[0] if dock_links else {}
        exits.append({"id": lk.get("id", "dock"), "kind": "dock", "tile": list(cell),
                      "to_zone": lk.get("to_zone"), "to_exit": lk.get("to_exit")})
        if "dock" in zone_def.get("objects", []):
            objects.append(("dock", cell[0], cell[1]))
    return {"H": H, "objects": objects, "exits": exits}


def _interior(cfg, zone_def):
    cols, rows = zone_def["grid"]["width"], zone_def["grid"]["height"]
    seed = int(zone_def.get("seed", 0))
    levels = zone_def["levels"]
    ts = _tile_size(cfg, zone_def)
    door_side = zone_def.get("door_side", "south")
    H = worldgen.room(cols, rows, seed, door_side=door_side)

    specs = _object_specs(cfg, zone_def, ts)
    # keep the door tiles + a landing strip clear
    keep_clear = set()
    mx, my = cols // 2, rows // 2
    if door_side in ("south", "north"):
        dr = rows - 1 if door_side == "south" else 0
        for k in (-1, 0, 1):
            keep_clear |= {(mx + k, dr), (mx + k, dr - 1 if door_side == "south" else dr + 1)}
    else:
        dc = cols - 1 if door_side == "east" else 0
        for k in (-1, 0, 1):
            keep_clear |= {(dc, my + k), (dc - 1 if door_side == "east" else dc + 1, my + k)}
    objects = worldgen.scatter(H, levels, specs, seed,
                               density=zone_def.get("density", 0.10),
                               spacing=zone_def.get("spacing", 1),
                               keep_clear=keep_clear)

    exits = []
    links = _links_by_kind(zone_def)
    door_links = links.get("door", [{}])
    lk = door_links[0] if door_links else {}
    if door_side == "south":
        cell = (mx, rows - 1)
    elif door_side == "north":
        cell = (mx, 0)
    elif door_side == "east":
        cell = (cols - 1, my)
    else:
        cell = (0, my)
    exits.append({"id": lk.get("id", "door"), "kind": "door", "tile": list(cell),
                  "to_zone": lk.get("to_zone"), "to_exit": lk.get("to_exit")})
    return {"H": H, "objects": objects, "exits": exits}
