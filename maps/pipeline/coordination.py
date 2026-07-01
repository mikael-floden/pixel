"""Fleet coordination for the maps agent (see coordination/PROTOCOL.md).

Three agents (characters / objects / maps) share one repo, one `main`, and one
PixelLab account. The contract that keeps them conflict-free: **one writer per
file**. This agent may write only `coordination/maps.json`; it *reads* the other
domains' files. This module handles both halves:

  - `publish(...)`  — refresh our heartbeat (preserving our own notes/requests).
  - `read_fleet()`  — load every domain's status.
  - `inbox()`       — requests addressed to "maps" from the other domains.

`notes` and `requests` in maps.json persist across heartbeats (the human or this
code edits them deliberately); the live fields refresh every unit.
"""

from __future__ import annotations

import datetime
import json
import os

DOMAIN = "maps"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))  # repo root
COORD_DIR = os.path.join(ROOT, "coordination")
OUR_FILE = os.path.join(COORD_DIR, f"{DOMAIN}.json")


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _read(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def read_fleet():
    """{domain: status_dict} for every coordination/<domain>.json present."""
    out = {}
    if not os.path.isdir(COORD_DIR):
        return out
    for name in sorted(os.listdir(COORD_DIR)):
        if not name.endswith(".json"):
            continue
        data = _read(os.path.join(COORD_DIR, name))
        if isinstance(data, dict):
            out[name[:-5]] = data
    return out


def inbox():
    """Open requests from other domains addressed to us: [(from_domain, request)]."""
    msgs = []
    for dom, status in read_fleet().items():
        if dom == DOMAIN:
            continue
        for req in status.get("requests", []) or []:
            if req.get("to") == DOMAIN:
                msgs.append((dom, req))
    return msgs


def publish(health="running", current="", progress=None, budget_remaining=None,
            notes=None, requests=None):
    """Write our heartbeat, preserving existing notes/requests unless overridden."""
    os.makedirs(COORD_DIR, exist_ok=True)
    prev = _read(OUR_FILE) or {}
    status = {
        "domain": DOMAIN,
        "updated_at": _now(),
        "health": health,
        "current": current,
        "progress": progress if progress is not None else prev.get("progress", {}),
        "budget_remaining": budget_remaining if budget_remaining is not None
        else prev.get("budget_remaining"),
        "notes": notes if notes is not None else prev.get("notes", []),
        "requests": requests if requests is not None else prev.get("requests", []),
    }
    with open(OUR_FILE, "w") as f:
        json.dump(status, f, indent=2)
    return status


def snapshot_progress():
    """Current maps progress for the heartbeat, read from the filesystem."""
    import zone as zonemod  # local import to avoid a cycle at module load
    zones = zonemod.list_zones()
    tdir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "tilesets")
    odir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "objects")
    return {
        "zones": len(zones),
        "tilesets": len(os.listdir(tdir)) if os.path.isdir(tdir) else 0,
        "objects": len(os.listdir(odir)) if os.path.isdir(odir) else 0,
    }
