"""Build the objects viewer manifest (objects/viewer_data.json) from the tree.

The static `objects/index.html` reads this file and lets you browse every object
— its sprite, rotations, and animations — from a phone. Paths are repo-relative
so it works both on GitHub Pages and when opened locally. Animation GIFs are also
viewable directly in the GitHub mobile app without any setup.
"""

from __future__ import annotations

import json
import os

import factory

ROOT = factory.ROOT
DATA_PATH = os.path.join(ROOT, "viewer_data.json")


def _list_objects():
    """Every object folder = any subdir of objects/ containing an object.json."""
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
    objects = []
    categories = {}
    for meta in _list_objects():
        oid = meta["id"]
        rots = meta.get("rotations", {})
        anims = []
        for key, a in (meta.get("animations") or {}).items():
            if a.get("gif"):
                anims.append({"key": key, "gif": a["gif"], "strip": a.get("strip"),
                              "frames": a.get("frames"), "action": a.get("action")})
        objects.append({
            "id": oid,
            "name": meta.get("name", oid),
            "category": meta.get("category", "misc"),
            "description": meta.get("description", ""),
            "view": meta.get("view"),
            "size": meta.get("size"),
            "placement": meta.get("placement"),
            "status": meta.get("status"),
            "sprite": meta.get("sprite", f"{oid}/sprite.png"),
            "rotation_files": rots.get("files", {}),
            "animations": anims,
        })
        categories[meta.get("category", "misc")] = categories.get(meta.get("category", "misc"), 0) + 1

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
