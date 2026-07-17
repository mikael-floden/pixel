"""The music loop: next missing track -> compose -> commit -> push. Resumable.

Mirrors the other domains' loops: each **unit** is one full track (one
`/v1/music` composition). The next unit is derived from the filesystem (a
catalog entry whose folder lacks `metadata.json`), so the loop can be killed
and rerun at any point. After every unit: rebuild `viewer_data.json`, write the
coordination heartbeat, commit, push.

Like `sounds/`, the engine REQUIRES the ElevenLabs key. Without it the loop
records a `blocked` heartbeat and generates nothing — no placeholder audio.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from compose import ROOT, compose_layer, compose_track, load_config
from elevenlabs_music_client import (BudgetExhausted, ElevenLabsMusicClient,
                                     ElevenLabsMusicError)
from viewer_build import build_viewer

REPO = os.path.dirname(ROOT)
BOARD = os.path.join(REPO, "coordination", "music.json")


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=REPO, text=True, capture_output=True, **kw)


def heartbeat(health: str, current: str, progress: dict,
              budget_remaining: int | None = None,
              add_notes: list[str] | None = None) -> None:
    """Write coordination/music.json (our own board file; notes/requests are
    preserved across heartbeats per the protocol)."""
    try:
        with open(BOARD) as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {"domain": "music", "notes": [], "requests": []}
    data.update({"domain": "music", "updated_at": _now(), "health": health,
                 "current": current, "progress": progress,
                 "budget_remaining": budget_remaining})
    for n in add_notes or []:
        if n not in data.setdefault("notes", []):
            data["notes"].append(n)
    with open(BOARD, "w") as f:
        json.dump(data, f, indent=2)


def commit_push(message: str, push: bool = True) -> None:
    _run(["git", "add", "music", "coordination/music.json"])
    if not _run(["git", "diff", "--cached", "--quiet"]).returncode:
        return                                       # nothing staged
    _run(["git", "commit", "-m", message])
    if not push:
        return
    branch = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    for attempt in range(4):
        if _run(["git", "push", "-u", "origin", branch]).returncode == 0:
            return
        _run(["git", "fetch", "origin", branch])
        _run(["git", "rebase", f"origin/{branch}"])
        time.sleep(2 ** (attempt + 1))
    print("  ! push failed after retries — commit is local")


def _layer_done(track_id: str, layer_id: str) -> bool:
    return os.path.exists(os.path.join(ROOT, track_id, "layers",
                                       f"{layer_id}.metadata.json"))


def next_unit(cfg: dict) -> tuple[str, dict, dict | None] | None:
    """Base tracks first, then missing intensity layers. -> ("track"|"layer",
    track, layer|None)."""
    for track in cfg["catalog"]:
        if not os.path.exists(os.path.join(ROOT, track["id"], "metadata.json")):
            return ("track", track, None)
    for track in cfg["catalog"]:
        for layer in track.get("layers", []):
            if not _layer_done(track["id"], layer["id"]):
                return ("layer", track, layer)
    return None


def progress(cfg: dict) -> dict:
    tracks = sum(1 for t in cfg["catalog"]
                 if os.path.exists(os.path.join(ROOT, t["id"], "metadata.json")))
    layers_total = sum(len(t.get("layers", [])) for t in cfg["catalog"])
    layers = sum(1 for t in cfg["catalog"] for l in t.get("layers", [])
                 if _layer_done(t["id"], l["id"]))
    return {"tracks_done": tracks, "tracks_total": len(cfg["catalog"]),
            "layers_done": layers, "layers_total": layers_total}


def main() -> int:
    ap = argparse.ArgumentParser(description="Music generation loop")
    ap.add_argument("--max-minutes", type=float, default=50)
    ap.add_argument("--max-units", type=int, default=0, help="0 = unlimited")
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()

    cfg = load_config()
    # protocol: read the inbox at the start of every run
    inbox = _run([sys.executable, "coordination/board.py", "inbox", "music"])
    print(inbox.stdout or inbox.stderr)

    if not ElevenLabsMusicClient.available():
        print("ELEVENLABS_API_KEY is not set — the music engine cannot run.\n"
              "Set it locally or as the repo Actions secret; the moment it "
              "exists this loop produces real tracks. No placeholder audio "
              "will be shipped.")
        heartbeat("stopped", "blocked: ELEVENLABS_API_KEY not set",
                  progress(cfg),
                  add_notes=["BLOCKED: needs ELEVENLABS_API_KEY to compose"])
        commit_push("music heartbeat: blocked (no ELEVENLABS_API_KEY)",
                    push=not args.no_push)
        return 0

    client = ElevenLabsMusicClient()
    deadline = time.time() + args.max_minutes * 60
    units = 0
    while time.time() < deadline and (not args.max_units or units < args.max_units):
        unit = next_unit(cfg)
        if unit is None:
            print("catalog complete — nothing to do")
            break
        kind, track, layer = unit
        label = track["id"] if kind == "track" else f"{track['id']}/{layer['id']}"
        try:
            client.ensure_budget(cfg["budget"]["min_ai_credits_remaining"])
            heartbeat("running", f"composing {label}", progress(cfg),
                      client.credits_remaining())
            if kind == "track":
                compose_track(track, cfg, client)
            else:
                compose_layer(track, layer, cfg, client)
        except BudgetExhausted as e:
            print(f"stopping: {e}")
            heartbeat("idle", f"budget floor reached ({e})", progress(cfg),
                      client.credits_remaining())
            commit_push("music heartbeat: budget floor", push=not args.no_push)
            return 0
        except ElevenLabsMusicError as e:
            print(f"engine error on {label}: {e}")
            heartbeat("error", f"engine error on {label}: {str(e)[:140]}",
                      progress(cfg), client.credits_remaining())
            commit_push(f"music heartbeat: engine error on {label}",
                        push=not args.no_push)
            return 1
        units += 1
        build_viewer()
        heartbeat("running", f"composed {label}", progress(cfg),
                  client.credits_remaining())
        commit_push(f"music: compose {label}", push=not args.no_push)

    heartbeat("idle", "pass complete", progress(cfg),
              client.credits_remaining())
    commit_push("music heartbeat: pass complete", push=not args.no_push)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
