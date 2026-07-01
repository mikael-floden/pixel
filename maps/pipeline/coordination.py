"""Fleet coordination for the maps agent (see coordination/PROTOCOL.md).

Three agents (characters / objects / maps) share one repo, one `main`, and one
PixelLab account. They talk through the repo itself: each agent OWNS
`coordination/<domain>.json` (writes only its own, reads everyone's) — one writer
per file, so pushes to `main` never conflict.

The shared front end is `coordination/board.py` (built by the characters agent):
`inbox` / `post` / `note`. This module **delegates to that shared CLI when it is
present** (so all agents use one implementation), and falls back to an equivalent
local reader when it isn't (e.g. on a feature branch before board.py is merged
in). On top of board's messaging it adds the per-unit **heartbeat** — the live
`updated_at/health/current/progress/budget_remaining` fields — written so that
board's `notes`/`requests` are always preserved.
"""

from __future__ import annotations

import datetime
import importlib.util
import json
import os

DOMAIN = "maps"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))  # repo root
COORD_DIR = os.path.join(ROOT, "coordination")
OUR_FILE = os.path.join(COORD_DIR, f"{DOMAIN}.json")
BOARD_PY = os.path.join(COORD_DIR, "board.py")


def _board():
    """Import coordination/board.py as a module, or None if it isn't there yet."""
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


# --- reading the fleet ------------------------------------------------------

def read_fleet():
    """{domain: status_dict} for every coordination/<domain>.json present."""
    b = _board()
    if b:
        return {d.get("domain"): d for d in b._all_boards() if d.get("domain")}
    out = {}
    if os.path.isdir(COORD_DIR):
        for name in sorted(os.listdir(COORD_DIR)):
            if name.endswith(".json"):
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


# --- sending messages (delegates to board.py) -------------------------------

def post(to, text):
    """Ask another domain for something (append to our own requests)."""
    b = _board()
    if b:
        b.cmd_post(DOMAIN, to, text)
        return
    d = _read(OUR_FILE) or {"domain": DOMAIN, "notes": [], "requests": []}
    d.setdefault("requests", []).append({"to": to, "text": text, "at": _now()})
    _write(d)


def note(text):
    """Leave a note / acknowledge an incoming request (board format: '[ts] text')."""
    b = _board()
    if b:
        b.cmd_note(DOMAIN, text)
        return
    d = _read(OUR_FILE) or {"domain": DOMAIN, "notes": [], "requests": []}
    d.setdefault("notes", []).append(f"[{_now()}] {text}")
    _write(d)


# --- heartbeat (our live status fields; preserves notes/requests) -----------

def _write(data):
    os.makedirs(COORD_DIR, exist_ok=True)
    with open(OUR_FILE, "w") as f:
        json.dump(data, f, indent=2)


def publish(health="running", current="", progress=None, budget_remaining=None):
    """Refresh our heartbeat. Loads the current file first so board-written
    notes/requests are preserved; only the live fields change."""
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
    """Current maps progress for the heartbeat, read from the filesystem."""
    import zone as zonemod  # local import to avoid a cycle at module load
    base = os.path.dirname(os.path.dirname(__file__))
    tdir = os.path.join(base, "assets", "tilesets")
    odir = os.path.join(base, "assets", "objects")
    return {
        "zones": len(zonemod.list_zones()),
        "tilesets": len(os.listdir(tdir)) if os.path.isdir(tdir) else 0,
        "objects": len(os.listdir(odir)) if os.path.isdir(odir) else 0,
    }
