"""Build the mobile viewer manifest (viewer_data.json) from the skeletons tree.

The static `index.html` at the repo root reads this file and lets you browse
every skeleton → character → animation/gear from a phone. Paths are repo-relative
so it works both on GitHub Pages (served from main / root) and when opened
locally. Animation GIFs are also viewable directly in the GitHub mobile app
without any setup.
"""

from __future__ import annotations

import json
import os

import factory

ROOT = factory.ROOT
DATA_PATH = os.path.join(ROOT, "viewer_data.json")


def build():
    cfg = factory.load_config()
    anim_order = [a["key"] for a in cfg["animations"]]
    skeletons = []

    for skel in factory.list_skeletons():
        sid = skel["id"]
        chars = []
        for ch in factory.list_characters(sid):
            cdir = os.path.join("skeletons", sid, "characters", ch["local_id"])
            anims = []
            for key in anim_order:
                a = ch.get("animations", {}).get(key)
                if not a:
                    continue
                anims.append({
                    "key": key,
                    "gif": a.get("gif"),
                    "strips": {d: v["strip"] for d, v in a.items()
                               if isinstance(v, dict) and "strip" in v},
                })
            chars.append({
                "local_id": ch["local_id"],
                "look": ch.get("look", ch.get("description", "")),
                "portrait": f"{cdir}/portrait.png",
                "rotations": [f"{cdir}/rotations/{d}.png" for d in ch.get("rotations", [])],
                "animation_count": len(anims),
                "animations": anims,
            })

        gear = factory.gear_state(sid)
        skeletons.append({
            "id": sid,
            "status": skel.get("status"),
            "note": skel.get("params", {}).get("note", ""),
            "params": skel.get("params", {}),
            "character_count": len(chars),
            "characters": chars,
            "gear": gear,
        })

    data = {
        "title": "Modular Pixel Character Factory",
        "targets": cfg["targets"],
        "animation_order": anim_order,
        "skeleton_count": len(skeletons),
        "skeletons": skeletons,
    }
    with open(DATA_PATH, "w") as f:
        json.dump(data, f, indent=2)
    return data


if __name__ == "__main__":
    d = build()
    print(f"viewer_data.json: {d['skeleton_count']} skeleton(s)")
