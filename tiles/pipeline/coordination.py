"""Fleet coordination for the TILES agent (see coordination/PROTOCOL.md).

One writer per file: this agent writes only coordination/tiles.json (its
heartbeat) and reads the others. Delegates to the shared coordination/board.py
CLI when present, with a local fallback.
"""

from __future__ import annotations

import datetime
import importlib.util
import json
import os

DOMAIN = "tiles"
REPO = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
COORD_DIR = os.path.join(REPO, "coordination")
OUR_FILE = os.path.join(COORD_DIR, f"{DOMAIN}.json")
BOARD_PY = os.path.join(COORD_DIR, "board.py")


def _board():
    if not os.path.isfile(BOARD_PY):
        return None
    try:
        spec = importlib.util.spec_from_file_location("coordination_board", BOARD_PY)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except Exception:
        return None


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _read(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def read_fleet():
    b = _board()
    if b:
        return {d.get("domain"): d for d in b._all_boards() if d.get("domain")}
    out = {}
    if os.path.isdir(COORD_DIR):
        for name in sorted(os.listdir(COORD_DIR)):
            if name.endswith(".json"):
                d = _read(os.path.join(COORD_DIR, name))
                if isinstance(d, dict):
                    out[name[:-5]] = d
    return out


def inbox():
    msgs = []
    for dom, status in read_fleet().items():
        if dom == DOMAIN:
            continue
        for req in status.get("requests", []) or []:
            if req.get("to") == DOMAIN:
                msgs.append((dom, req))
    return msgs


def note(text):
    b = _board()
    if b:
        b.cmd_note(DOMAIN, text)
        return
    d = _read(OUR_FILE) or {"domain": DOMAIN, "notes": [], "requests": []}
    d.setdefault("notes", []).append(f"[{_now()}] {text}")
    _write(d)


def post(to, text):
    b = _board()
    if b:
        b.cmd_post(DOMAIN, to, text)
        return
    d = _read(OUR_FILE) or {"domain": DOMAIN, "notes": [], "requests": []}
    d.setdefault("requests", []).append({"to": to, "text": text, "at": _now()})
    _write(d)


def _write(data):
    os.makedirs(COORD_DIR, exist_ok=True)
    with open(OUR_FILE, "w") as f:
        json.dump(data, f, indent=2)


def publish(health="running", current="", progress=None, budget_remaining=None):
    b = _board()
    d = (b._load(DOMAIN) if b else _read(OUR_FILE)) or {"domain": DOMAIN}
    d["domain"] = DOMAIN
    d["updated_at"] = _now()
    d["health"] = health
    d["current"] = current
    if progress is not None:
        d["progress"] = progress
    if budget_remaining is not None:
        d["budget_remaining"] = budget_remaining
    d.setdefault("notes", [])
    d.setdefault("requests", [])
    if b:
        b._save(DOMAIN, d)
    else:
        _write(d)
    return d


def snapshot_progress():
    import tilegen
    cats = tilegen.list_categories()
    return {"categories": len(cats), "tiles": sum(c.get("count", 0) for c in cats)}
