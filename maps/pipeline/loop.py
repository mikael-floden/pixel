"""The maps loop (scene-based).

Each unit builds one loading-zone screen: PixelLab draws the palette-guided
ground scene, we derive collision, place objects-agent props on a y-sorted
layer, and write a self-contained zone folder. The next unit is derived from the
filesystem (a zone with no zone.json), so the loop is resumable; after each unit
it rebuilds the viewer, publishes a coordination heartbeat, commits and pushes.

  python maps/pipeline/loop.py --max-minutes 50
  python maps/pipeline/loop.py --once --no-push
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time

import coordination
import proportions
import scene as scenemod
import viewer_build
from pixellab_client import BudgetExhausted, PixelLabClient

ROOT = os.path.dirname(os.path.dirname(__file__))
CONFIG = os.path.join(ROOT, "config", "maps.json")
REPO_ROOT = os.path.dirname(ROOT)


def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def _git(*args, check=True):
    return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True,
                          check=check)


def commit_push(message, push=True):
    _git("add", "-A")
    if not _git("status", "--porcelain").stdout.strip():
        return False
    _git("commit", "-m", message)
    if push:
        r = None
        for attempt in range(4):
            r = _git("push", "origin", "HEAD:main", check=False)
            if r.returncode == 0:
                break
            _git("fetch", "origin", "main", check=False)
            _git("rebase", "origin/main", check=False)
            time.sleep(2 ** (attempt + 1))
        if r is not None and r.returncode != 0:
            print("  ! push failed after retries:", r.stderr[:200])
    return True


def next_zone(cfg):
    for z in cfg.get("zones", []):
        if not scenemod.zone_exists(z["id"]):
            return z
    return None


def advance(client, cfg, budget=None, push=True):
    z = next_zone(cfg)
    if z is None:
        print("== all zones built ==")
        return None
    m = scenemod.build_zone(client, cfg, z)
    desc = f"maps: scene zone '{z['id']}' — {m['pixel_size']['width']}x{m['pixel_size']['height']}, {len(m['entities'])} props"
    viewer_build.build()
    coordination.publish(health="running", current=desc,
                         progress=coordination.snapshot_progress(), budget_remaining=budget)
    commit_push(desc, push=push)
    print("  +", desc)
    return desc


def main():
    ap = argparse.ArgumentParser(description="Run the scene-based maps loop.")
    ap.add_argument("--max-units", type=int, default=0)
    ap.add_argument("--max-minutes", type=float, default=0)
    ap.add_argument("--min-balance", type=int, default=None)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()

    cfg = load_config()
    min_balance = args.min_balance if args.min_balance is not None \
        else cfg["budget"]["min_generations_remaining"]

    ok, issues = proportions.validate_config(cfg)
    print(proportions.summary(cfg))
    if not ok:
        for i in issues:
            print(f"  !! {i}")
        raise SystemExit("aborting: fix config issues first")

    client = PixelLabClient()
    for dom, req in coordination.inbox():
        print(f"  * request from {dom}: {req.get('text', req)}")

    start = time.monotonic()
    units = 0
    rem = client.generations_remaining()
    print(f"maps loop starting — {rem:.0f} generations remaining (floor {min_balance})")

    stop = "nothing left to build"
    while True:
        try:
            rem = client.ensure_budget(min_balance)
            result = advance(client, cfg, budget=rem, push=not args.no_push)
        except BudgetExhausted as e:
            stop = str(e); print(f"stopping: {e}"); break
        if result is None:
            break
        units += 1
        if args.once or (args.max_units and units >= args.max_units):
            stop = "unit budget reached"; break
        if args.max_minutes and (time.monotonic() - start) / 60 >= args.max_minutes:
            stop = "time budget reached"; break

    rem = client.generations_remaining()
    coordination.publish(health="idle", current=f"stopped: {stop}",
                         progress=coordination.snapshot_progress(), budget_remaining=rem)
    commit_push("maps: heartbeat (loop idle)", push=not args.no_push)
    print(f"done — {units} unit(s), {rem:.0f} generations left")


if __name__ == "__main__":
    main()
