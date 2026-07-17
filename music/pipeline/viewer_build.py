"""Scan music/*/metadata.json -> music/viewer_data.json (the catalog index).

The game and the viewer read this single file. Heavy per-track arrays (beats,
onsets, RMS) stay in each track's own metadata.json — the index carries just
enough to list, pick and load tracks.
"""

from __future__ import annotations

import datetime
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # music/


def build_viewer() -> dict:
    tracks = []
    for entry in sorted(os.listdir(ROOT)):
        meta_path = os.path.join(ROOT, entry, "metadata.json")
        if not os.path.isfile(meta_path):
            continue
        try:
            with open(meta_path) as f:
                m = json.load(f)
        except ValueError:
            continue
        tracks.append({
            "id": m["id"],
            "name": m["name"],
            "use": m.get("intent", {}).get("use", ""),
            "feeling": m.get("intent", {}).get("feeling", []),
            "file": m["audio"]["file"],
            "format": m["audio"]["format"],
            "stream": {v["format"]: {"file": v["file"], "mime": v["mime"]}
                       for v in m["audio"].get("compressed", [])},
            "duration_s": m["audio"]["duration_s"],
            "bpm": m.get("musical", {}).get("tempo_bpm"),
            "key": {k: m["musical"]["key"][k] for k in ("root", "mode")}
                   if m.get("musical", {}).get("key") else None,
            "loopable": m.get("loop", {}).get("loopable", False),
            "sections": [{k: s[k] for k in ("name", "start_s", "end_s")}
                         for s in m.get("structure", {}).get("sections", [])],
            "layers": [{"id": l["id"], "name": l["name"],
                        "intensity": l.get("intensity"), "file": l["file"],
                        "stream": {v["format"]: {"file": v["file"],
                                                 "mime": v["mime"]}
                                   for v in l.get("compressed", [])},
                        "metadata": l["metadata"]}
                       for l in m.get("layers", [])],
            "metadata": f"{m['id']}/metadata.json",
        })
    data = {
        "domain": "music",
        "generated_at": datetime.datetime.now(datetime.timezone.utc)
                        .isoformat(timespec="seconds"),
        "tracks": tracks,
    }
    with open(os.path.join(ROOT, "viewer_data.json"), "w") as f:
        json.dump(data, f, indent=2)
    return data


if __name__ == "__main__":
    d = build_viewer()
    print(f"viewer_data.json: {len(d['tracks'])} track(s)")
