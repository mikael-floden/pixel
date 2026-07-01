"""The tiles loop.

Each unit generates one focused isometric tile set (one category) via
create-tiles-pro and downloads it to tiles/<category>/. The next unit is derived
from the filesystem (a category with no tiles.json), so the loop is resumable;
after each unit it publishes a coordination heartbeat, commits and pushes. When
the explicit category list is exhausted it keeps inventing focused categories
(config.procedural) so the library grows forever.

  python tiles/pipeline/loop.py --max-minutes 50
  python tiles/pipeline/loop.py --once --no-push
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time

import coordination
import roads
import synth
import tilegen
from pixellab_client import BudgetExhausted, PixelLabClient

ROOT = os.path.dirname(os.path.dirname(__file__))       # tiles/
CONFIG = os.path.join(ROOT, "config", "tiles.json")
REPO_ROOT = os.path.dirname(ROOT)


def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def _git(*args, check=True):
    return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=check)


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
            print("  ! push failed:", r.stderr[:200])
    return True


def next_category(cfg):
    for cat in cfg.get("categories", []):
        if not tilegen.category_done(cat["id"]):
            return cat
    # Roads/paths for each ground type (prioritised ahead of open-ended growth).
    for cat in roads.road_categories(cfg):
        if not tilegen.category_done(cat["id"]):
            return cat
    for cat in (cfg.get("procedural", {}) or {}).get("categories", []):
        if not tilegen.category_done(cat["id"]):
            return cat
    # Explicit + procedural lists exhausted: invent an endless focused category
    # that holds the ~40/20/20/20 profile mix (see synth.py).
    return synth.invent_category(cfg)


def advance(client, cfg, budget=None, push=True):
    cat = next_category(cfg)
    if cat is None:
        print("== all categories generated ==")
        return None
    m = tilegen.generate_category(client, cfg, cat)
    desc = f"tiles: '{cat['id']}' — {m['count']} isometric tiles ({m['tile_size']}px, {m['view_angle']}deg, {int(m['depth_ratio']*100)}% depth)"
    coordination.publish(health="running", current=desc,
                         progress=coordination.snapshot_progress(), budget_remaining=budget)
    commit_push(desc, push=push)
    print("  +", desc)
    return desc


def main():
    ap = argparse.ArgumentParser(description="Run the isometric tiles loop.")
    ap.add_argument("--max-units", type=int, default=0)
    ap.add_argument("--max-minutes", type=float, default=0)
    ap.add_argument("--min-balance", type=int, default=None)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()

    cfg = load_config()
    min_balance = args.min_balance if args.min_balance is not None \
        else cfg["budget"]["min_generations_remaining"]
    client = PixelLabClient()

    for dom, req in coordination.inbox():
        print(f"  * request from {dom}: {req.get('text', req)}")

    start = time.monotonic()
    units = 0
    rem = client.generations_remaining()
    print(f"tiles loop starting — {rem:.0f} generations remaining (floor {min_balance})")

    stop = "all categories generated"
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
    commit_push("tiles: heartbeat (loop idle)", push=not args.no_push)
    print(f"done — {units} unit(s), {rem:.0f} generations left")


if __name__ == "__main__":
    main()
