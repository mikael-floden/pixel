"""Cross-agent coordination for the sounds domain (see coordination/PROTOCOL.md).

Several agents (characters / objects / tiles / maps / games / sounds) share one
repo and one `main`. The protocol keeps them conflict-free with **one writer per
file**: this domain writes only `coordination/sounds.json` and *reads* the others.
This module is that writer + reader. Only the sounds loop imports it.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

import factory

REPO_ROOT = os.path.dirname(factory.ROOT)
COORD_DIR = os.path.join(REPO_ROOT, "coordination")
DOMAIN = "sounds"
STATUS_PATH = os.path.join(COORD_DIR, f"{DOMAIN}.json")


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_peers() -> dict:
    """Every other domain's status file -> {domain: dict}. Tolerant of missing dir
    or partial files (a peer may be mid-write)."""
    peers = {}
    if not os.path.isdir(COORD_DIR):
        return peers
    for name in sorted(os.listdir(COORD_DIR)):
        if not name.endswith(".json") or name == f"{DOMAIN}.json":
            continue
        try:
            with open(os.path.join(COORD_DIR, name)) as f:
                data = json.load(f)
            peers[data.get("domain", name[:-5])] = data
        except (OSError, json.JSONDecodeError):
            continue
    return peers


def _default_notes():
    return ["sounds domain: game SFX one-shots (UI, items, tools, movement, "
            "combat, feedback). Each sound = sounds/<category>/<id>/ with a WAV/MP3 "
            "+ metadata.json. Default engine is free procedural sfxr; set "
            "ELEVENLABS_API_KEY for realistic AI foley. Games: read "
            "sounds/viewer_data.json for the whole catalog."]


def publish(current, progress, budget_remaining=None, health="running",
            add_notes=None, add_requests=None):
    """Write coordination/sounds.json, refreshing live fields and PRESERVING
    accumulated notes/requests. Returns the written dict."""
    prev = {}
    if os.path.exists(STATUS_PATH):
        try:
            with open(STATUS_PATH) as f:
                prev = json.load(f)
        except (OSError, json.JSONDecodeError):
            prev = {}

    notes = prev.get("notes") or _default_notes()
    for n in add_notes or []:
        if n not in notes:
            notes.append(n)
    requests = prev.get("requests") or []
    for r in add_requests or []:
        if r not in requests:
            requests.append(r)

    status = {
        "domain": DOMAIN,
        "updated_at": _now(),
        "health": health,
        "current": current,
        "progress": progress,
        "budget_remaining": budget_remaining,
        "notes": notes,
        "requests": requests,
    }
    os.makedirs(COORD_DIR, exist_ok=True)
    with open(STATUS_PATH, "w") as f:
        json.dump(status, f, indent=2)
    return status


def progress_snapshot(cfg) -> dict:
    specs = factory.sound_specs(cfg)
    done = sum(1 for s in specs if factory.has_sound(s))
    return {"sounds_complete": done, "sounds_target": len(specs)}


def peer_summary(peers) -> str:
    if not peers:
        return "no peer status files yet."
    out = []
    for dom, s in peers.items():
        out.append(f"{dom}: {s.get('health','?')} — {s.get('current','?')} "
                   f"(updated {s.get('updated_at','?')})")
    return "; ".join(out)
