"""Build the scenery viewer manifest (scenery/viewer_data.json) from the tree.

The static `scenery/index.html` reads this file and lets you browse every piece
from a phone. v2: pieces live in ranked GROUPS (scenery/<group>/<id>/); each
piece's `category` is its group so the viewer's category filter doubles as the
group browser. Legacy top-level pieces keep their own category. Paths are
domain-relative so it works on GitHub Pages and locally.
"""

from __future__ import annotations

import json
import os

import catalog
import factory

ROOT = factory.ROOT
DATA_PATH = os.path.join(ROOT, "viewer_data.json")


def build():
    cfg = factory.load_config()
    pieces, categories = [], {}
    for rel, meta in factory.discover():
        grouped = "/" in rel
        cat = rel.split("/", 1)[0] if grouped else meta.get("category", "legacy")
        anims = []
        for key, a in (meta.get("animations") or {}).items():
            dirs = a.get("directions") or {}
            south = dirs.get("south") or (next(iter(dirs.values())) if dirs else {})
            anims.append({
                "key": key,
                "description": a.get("description"),
                "frames": south.get("frames"),
                "preview_gif": south.get("gif"),
                "directions": {d: v.get("gif") for d, v in dirs.items() if v.get("gif")},
            })
        categories[cat] = categories.get(cat, 0) + 1
        pieces.append({
            "id": meta.get("id", rel.split("/")[-1]),
            "rel": rel,
            "name": meta.get("name", rel),
            "category": cat,
            "lights": meta.get("lights"),
            "description": meta.get("prompt") or meta.get("description", ""),
            "view": meta.get("view"),
            "size": meta.get("size"),
            "placement": meta.get("placement"),
            "status": meta.get("status"),
            "pixellab_object_id": meta.get("pixellab_object_id"),
            "sprite": meta.get("sprite", f"{rel}/sprite.webp"),
            "rotations": meta.get("rotations") or {},
            # LIGHTING STATES, when a piece has more than one. Windows ship
            # "lights_off" (the default, and what `sprite` points at) and
            # "lights_on"; each carries its own sprite + rotations, generated as
            # a text edit of the same art so the two are PIXEL-ALIGNED. The game
            # crossfades between them on interior brightness, which only reads
            # right because the silhouettes match exactly — so a viewer should
            # switch states in place, the way it switches animations, rather
            # than treating them as separate pieces.
            "states": meta.get("states") or {},
            "animations": anims,
        })

    done = factory.done_by_group()
    target = sum(catalog.group_quota(g, cfg) for g in cfg.get("groups", []))
    data = {
        "title": "Nangijala Scenery",
        "scenery_count": len(pieces),
        "target_count": target + sum(1 for r, _ in factory.discover() if "/" not in r),
        "scale": cfg.get("scale"),
        "groups": [{
            "rank": g["rank"], "id": g["id"], "name": g["name"],
            "quota": catalog.group_quota(g, cfg),
            "done": len(done.get(g["id"], set())),
        } for g in cfg.get("groups", [])],
        "categories": categories,
        "scenery": pieces,
    }
    with open(DATA_PATH, "w") as f:
        json.dump(data, f, indent=2)
    return data


if __name__ == "__main__":
    d = build()
    print(f"viewer_data.json: {d['scenery_count']} piece(s) of {d['target_count']} planned")
