"""Roll every built scene zone into viewer_data.json for index.html.

Zero generations — pure filesystem scan. Run after each unit."""

from __future__ import annotations

import json
import os

ROOT = os.path.dirname(os.path.dirname(__file__))


def build():
    zones = []
    for name in sorted(os.listdir(ROOT)):
        zp = os.path.join(ROOT, name, "zone.json")
        if not os.path.isfile(zp):
            continue
        with open(zp) as f:
            m = json.load(f)
        zones.append({
            "id": m["id"], "title": m.get("title", m["id"]),
            "kind": m.get("kind"), "mood": m.get("mood", ""),
            "pixel_size": m.get("pixel_size"),
            "props": len(m.get("entities", [])),
            "exits": [{"id": e["id"], "kind": e.get("kind"), "to_zone": e.get("to_zone")}
                      for e in m.get("exits", [])],
            "preview": f"{name}/{m.get('preview', 'preview.png')}",
            "scene": f"{name}/{m.get('background', 'scene.png')}",
            "collision": f"{name}/{m.get('collision_preview', 'collision.png')}",
            "manifest": f"{name}/zone.json",
        })
    data = {"schema": "pixel-maps/viewer@2", "zones": zones}
    with open(os.path.join(ROOT, "viewer_data.json"), "w") as f:
        json.dump(data, f, indent=2)
    return data


if __name__ == "__main__":
    d = build()
    print(f"viewer_data.json: {len(d['zones'])} zone(s)")
