"""Scan monsters/ -> viewer_data.json for the review page (index.html).

One entry per monster, one row per game state (idle/walk/angry/attack/die),
each pointing at the animation's ROTATING gif — the clip plays the full
animation facing one direction, then turns one 45° step and plays again, all
the way around. Fallbacks (angry -> idle) and missing states are surfaced so
the review page shows exactly what the game will get.
"""

from __future__ import annotations

import json
import os

from mirror import ROOT, STATES, iter_manifests

OUT = os.path.join(ROOT, "viewer_data.json")


def build():
    monsters = []
    for mid, meta in iter_manifests():
        anims = meta.get("animations") or {}
        smap = meta.get("states") or {}
        rows = []
        for s in STATES:
            key = smap.get(s)
            a = anims.get(key) if key else None
            rows.append({
                "state": s,
                "key": key,
                "fallback": bool(key) and key != s,
                "missing": key is None or a is None,
                "rotating_gif": (a or {}).get("rotating_gif"),
                "directions": len((a or {}).get("directions") or {}),
                "frames_per_direction": sorted({v["frames"] for v in
                                                (a or {}).get("directions", {}).values()}),
                "source_name": (a or {}).get("source_name"),
            })
        extras = [{
            "key": k,
            "source_name": a.get("source_name"),
            "rotating_gif": a.get("rotating_gif"),
            "directions": len(a.get("directions") or {}),
        } for k, a in sorted(anims.items()) if k not in set(filter(None, smap.values()))]
        monsters.append({
            "id": mid,
            "name": meta.get("name") or mid,
            "kind": meta.get("source", {}).get("kind"),
            "pixellab_url": meta.get("source", {}).get("url"),
            "prompt": meta.get("source", {}).get("prompt"),
            "size": meta.get("size"),
            "sprite": meta.get("sprite"),
            "states": rows,
            "extras": extras,
        })
    doc = {"states_order": list(STATES), "monsters": monsters}
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=1)
    print(f"viewer_data.json: {len(monsters)} monster(s)")
    return doc


if __name__ == "__main__":
    build()
