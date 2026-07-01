"""Cross-agent coordination for the objects domain (see coordination/PROTOCOL.md).

Three agents (characters / objects / maps) share one repo, one `main`, and one
PixelLab account. The protocol keeps them conflict-free with **one writer per
file**: this domain writes only `coordination/objects.json` and *reads* the
others. This module is that writer + reader.

Only the objects loop imports this. It never touches another domain's files.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

import factory

# coordination/ lives at the repo root, one level above this domain dir.
REPO_ROOT = os.path.dirname(factory.ROOT)
COORD_DIR = os.path.join(REPO_ROOT, "coordination")
DOMAIN = "objects"
STATUS_PATH = os.path.join(COORD_DIR, f"{DOMAIN}.json")


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_peers():
    """Every other domain's status file -> {domain: dict}. Tolerant: missing dir
    or unreadable/partial files are skipped (a peer may be mid-write)."""
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
    return ["objects domain: props/tools/items (chest, coin, tree, sword...). "
            "Each object = one folder objects/<id>/ with sprite + optional "
            "rotations + animations. Repo is the source of truth (stateless "
            "PixelLab image tools; nothing to sync back)."]


def publish(current, progress, budget_remaining, health="running", add_notes=None,
            add_requests=None):
    """Write coordination/objects.json, refreshing the live fields and PRESERVING
    accumulated `notes`/`requests` (per the protocol). `add_notes`/`add_requests`
    append new, de-duplicated entries. Returns the written dict."""
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


def progress_snapshot(cfg):
    """Filesystem-derived progress for the heartbeat."""
    specs = factory.object_specs(cfg)
    complete = sum(1 for s in specs
                   if (factory.read_manifest(s["id"]) or {}).get("status") == "complete")
    started = sum(1 for s in specs if factory.has_base(s["id"]))
    return {"objects_complete": complete, "objects_started": started,
            "objects_target": len(specs)}


def peer_summary(peers):
    """One-line-per-peer human summary for run startup."""
    if not peers:
        return "no peer status files yet (objects may be first on this branch)."
    out = []
    for dom, s in peers.items():
        out.append(f"{dom}: {s.get('health','?')} — {s.get('current','?')} "
                   f"(budget {s.get('budget_remaining','?')}, updated {s.get('updated_at','?')})")
    return "; ".join(out)
