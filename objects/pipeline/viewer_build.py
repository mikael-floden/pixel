"""Build the objects viewer manifest (objects/viewer_data.json) from the tree.

The static `objects/index.html` reads this file and lets you browse every object —
its 8 rotations and its 3 animations (each across 8 directions) — from a phone.
Paths are repo-relative so it works on GitHub Pages and locally. Animation GIFs
play directly in the GitHub mobile app.
"""

from __future__ import annotations

import json
import os

import factory

ROOT = factory.ROOT
DATA_PATH = os.path.join(ROOT, "viewer_data.json")


def _list_objects():
    out = []
    for name in sorted(os.listdir(ROOT)):
        if name in factory.RESERVED_DIRS or name.startswith("."):
            continue
        meta = factory.read_manifest(name)
        if meta:
            out.append(meta)
    return out


def build():
    cfg = factory.load_config()
    objects, categories = [], {}
    for meta in _list_objects():
        oid = meta["id"]
        rotations = meta.get("rotations") or {}
        anims = []
        for key, a in (meta.get("animations") or {}).items():
            dirs = a.get("directions") or {}
            # Prefer the south preview; expose every direction's gif too.
            south = dirs.get("south") or (next(iter(dirs.values())) if dirs else {})
            anims.append({
                "key": key,
                "description": a.get("description"),
                "frames": south.get("frames"),
                "preview_gif": south.get("gif"),
                "directions": {d: v.get("gif") for d, v in dirs.items() if v.get("gif")},
            })
        cat = meta.get("category", "misc")
        categories[cat] = categories.get(cat, 0) + 1
        objects.append({
            "id": oid,
            "name": meta.get("name", oid),
            "category": cat,
            "description": meta.get("description", ""),
            "view": meta.get("view"),
            "size": meta.get("size"),
            "placement": meta.get("placement"),
            "status": meta.get("status"),
            "pixellab_object_id": meta.get("pixellab_object_id"),
            "sprite": meta.get("sprite", f"{oid}/sprite.png"),
            "rotations": rotations,
            "animations": anims,
        })

    data = {
        "title": "Pixel Object Factory",
        "object_count": len(objects),
        "target_count": cfg["targets"]["num_objects"],
        "scale": cfg.get("scale"),
        "categories": categories,
        "objects": objects,
    }
    with open(DATA_PATH, "w") as f:
        json.dump(data, f, indent=2)
    return data


if __name__ == "__main__":
    d = build()
    print(f"viewer_data.json: {d['object_count']} object(s)")
