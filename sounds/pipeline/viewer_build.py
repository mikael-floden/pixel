"""Roll every sound's manifest up into sounds/viewer_data.json — a single index a
game (or the viewer page) can load to get the whole catalog at once. Regenerated
after each unit. Pure filesystem scan; zero generations."""

from __future__ import annotations

import json
import os

import factory

VIEWER_PATH = os.path.join(factory.ROOT, "viewer_data.json")


def build() -> dict:
    cfg = factory.load_config()
    sounds = []
    by_category: dict[str, int] = {}
    for spec in factory.sound_specs(cfg):
        man = factory.read_manifest(spec)
        if not man or not factory._audio_exists(spec, man):
            continue
        entry = {
            "id": man["id"],
            "name": man["name"],
            "category": man["category"],
            "description": man["description"],
            "feel": man.get("feel", ""),
            "tags": man.get("tags", []),
            "usage": man.get("usage", ""),
            "engine": man.get("engine"),
            "format": man.get("format"),
            "loop": man.get("loop", False),
            "file": man["file"],
            "delivery": man.get("delivery"),
            "takes": man.get("takes", []),
            "duration_seconds": (man.get("audio") or {}).get("duration_seconds"),
            "mix_gain_db": man.get("mix_gain_db", 0.0),
            "variation": man.get("variation"),
            "music": man.get("music"),
            "envelope": man.get("envelope"),
            "sync_points": man.get("sync_points", []),
        }
        sounds.append(entry)
        by_category[man["category"]] = by_category.get(man["category"], 0) + 1

    data = {
        "domain": "sounds",
        "style": cfg.get("style", ""),
        "count": len(sounds),
        "by_category": by_category,
        "sounds": sounds,
    }
    with open(VIEWER_PATH, "w") as f:
        json.dump(data, f, indent=2)
    return data


if __name__ == "__main__":
    d = build()
    print(f"viewer_data.json: {d['count']} sound(s) across {len(d['by_category'])} categories")
