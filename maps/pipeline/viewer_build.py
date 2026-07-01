"""Roll every built zone into viewer_data.json for the mobile viewer (index.html).

Zero generations — pure filesystem scan. Run after each unit."""

from __future__ import annotations

import json
import os

ROOT = os.path.dirname(os.path.dirname(__file__))


def _read_json(path):
    with open(path) as f:
        return json.load(f)


def build():
    zones = []
    for name in sorted(os.listdir(ROOT)):
        zpath = os.path.join(ROOT, name, "zone.json")
        if not os.path.isfile(zpath):
            continue
        m = _read_json(zpath)
        zones.append({
            "id": m["id"], "title": m.get("title", m["id"]),
            "kind": m.get("kind"), "archetype": m.get("archetype"),
            "description": m.get("description", ""),
            "grid": m.get("grid"), "tile_size": m.get("tile_size"),
            "levels": m.get("levels"), "bands": m.get("bands"),
            "objects": len(m.get("objects", [])),
            "exits": [{"id": e["id"], "kind": e["kind"], "to_zone": e.get("to_zone")}
                      for e in m.get("exits", [])],
            "preview": f"{name}/{m.get('preview', 'preview.png')}",
            "manifest": f"{name}/zone.json",
        })

    tilesets, objects = [], []
    tdir = os.path.join(ROOT, "assets", "tilesets")
    if os.path.isdir(tdir):
        for t in sorted(os.listdir(tdir)):
            mp = os.path.join(tdir, t, "tileset.json")
            if os.path.isfile(mp):
                m = _read_json(mp)
                tilesets.append({"id": m["id"], "lower": m.get("lower"),
                                 "upper": m.get("upper"), "tiles": len(m.get("tiles", [])),
                                 "atlas": f"assets/tilesets/{t}/tiles"})
    odir = os.path.join(ROOT, "assets", "objects")
    if os.path.isdir(odir):
        for o in sorted(os.listdir(odir)):
            mp = os.path.join(odir, o, "object.json")
            if os.path.isfile(mp):
                m = _read_json(mp)
                objects.append({"id": m["id"], "description": m.get("description"),
                                "preview": f"assets/objects/{o}/object.png"})

    data = {"schema": "pixel-maps/viewer@1", "zones": zones,
            "tilesets": tilesets, "objects": objects}
    with open(os.path.join(ROOT, "viewer_data.json"), "w") as f:
        json.dump(data, f, indent=2)
    return data


if __name__ == "__main__":
    d = build()
    print(f"viewer_data.json: {len(d['zones'])} zone(s), "
          f"{len(d['tilesets'])} tileset(s), {len(d['objects'])} object(s)")
