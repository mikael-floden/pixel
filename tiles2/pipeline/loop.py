"""The tiles2 iteration loop.

Each UNIT = one create-tiles-pro request (a base or a transition sheet):
  1. pick the next unit from the filesystem (resumable):
       - BASE first: the ground type with the fewest raw base sheets that is still
         below targets.base_sheets_per_type (round-robin, balanced);
       - then TRANSITIONS: each config pair below targets.transition_sheets_per_pair;
  2. generate.py downloads it to raw/ (+ request.json);
  3. postprocess.py copies it into base/ or transitions/<other>/, neutralising the
     outline and normalising to the ref-sprite(s) (or copy-as-is until a ref is set);
  4. commit + push.

Bounded by --max-minutes / --max-units / --min-balance. NOTE: not scheduled yet —
run manually while we dial the pipeline in.

  python tiles2/pipeline/loop.py --once
  python tiles2/pipeline/loop.py --max-minutes 45
  python tiles2/pipeline/loop.py --dry-run          # show the plan, no API calls
"""

from __future__ import annotations

import argparse
import os
import subprocess
import time

import common
import generate
import postprocess
from pixellab_client import BudgetExhausted, PixelLabClient, PixelLabError

REPO_ROOT = os.path.dirname(common.ROOT)


def _by_id(cfg):
    return {g["id"]: g for g in cfg["ground_types"]}


def next_unit(cfg):
    """Return ('base', gt) or ('transition', frm, to) or None."""
    gts = cfg["ground_types"]
    tgt = cfg["targets"]
    # BASE first — pick the type furthest from its base target (fewest sheets).
    base_need = []
    for gt in gts:
        have = len(common.list_raw_sheets(gt["id"], kind="base"))
        if have < tgt["base_sheets_per_type"]:
            base_need.append((have, gts.index(gt), gt))
    if base_need:
        base_need.sort(key=lambda x: (x[0], x[1]))
        return ("base", base_need[0][2])
    # TRANSITIONS next.
    by = _by_id(cfg)
    for a, b in cfg.get("transitions", []):
        if a not in by or b not in by:
            continue
        have = len(common.list_raw_sheets(a, kind="transition", other=b))
        if have < tgt["transition_sheets_per_pair"]:
            return ("transition", by[a], by[b])
    return None


def _describe(unit):
    if unit[0] == "base":
        return f"base '{unit[1]['id']}'"
    return f"transition '{unit[1]['id']}' -> '{unit[2]['id']}'"


def _git(*args, check=True):
    return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=check)


def commit_push(message, push=True):
    _git("add", "-A")
    if not _git("status", "--porcelain").stdout.strip():
        return False
    _git("commit", "-m", message)
    if push:
        for attempt in range(4):
            r = _git("push", "origin", "HEAD:main", check=False)
            if r.returncode == 0:
                break
            _git("fetch", "origin", "main", check=False)
            _git("rebase", "origin/main", check=False)
            time.sleep(2 ** (attempt + 1))
    return True


def advance(client, cfg, unit, push=True):
    if unit[0] == "base":
        req = generate.generate_base(client, cfg, unit[1])
    else:
        req = generate.generate_transition(client, cfg, unit[1], unit[2])
    postprocess.process_type(req["ground_type"], cfg)
    desc = f"tiles2: {_describe(unit)} — {req['count']} tiles ({req['sheet']})"
    commit_push(desc, push=push)
    print("  +", desc)
    return desc


def main():
    ap = argparse.ArgumentParser(description="Run the tiles2 loop.")
    ap.add_argument("--max-units", type=int, default=0)
    ap.add_argument("--max-minutes", type=float, default=0)
    ap.add_argument("--min-balance", type=int, default=None)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="print the next units; no API calls")
    args = ap.parse_args()

    cfg = common.load_config()

    if args.dry_run:
        # Show what the loop WOULD do, without generating (safe to run anytime).
        print("tiles2 plan (base-first, then transitions):")
        for gt in cfg["ground_types"]:
            have = len(common.list_raw_sheets(gt["id"], kind="base"))
            print(f"  base {gt['id']:18s} {have}/{cfg['targets']['base_sheets_per_type']}")
        for a, b in cfg.get("transitions", []):
            have = len(common.list_raw_sheets(a, kind="transition", other=b))
            print(f"  trans {a} -> {b}: {have}/{cfg['targets']['transition_sheets_per_pair']}")
        nxt = next_unit(cfg)
        print("next unit:", _describe(nxt) if nxt else "== all targets met ==")
        return

    min_balance = args.min_balance if args.min_balance is not None \
        else cfg["budget"]["min_generations_remaining"]
    client = PixelLabClient()
    start = time.monotonic()
    units = 0
    skip = set()
    rem = client.generations_remaining()
    print(f"tiles2 loop starting — {rem:.0f} generations remaining (floor {min_balance})")

    while True:
        try:
            client.ensure_budget(min_balance)
        except BudgetExhausted as e:
            print(f"stopping: {e}"); break
        unit = next_unit(cfg)
        if unit is None or _describe(unit) in skip:
            print("== all targets met =="); break
        try:
            advance(client, cfg, unit, push=not args.no_push)
        except BudgetExhausted as e:
            print(f"stopping: {e}"); break
        except PixelLabError as e:
            print(f"  ! {_describe(unit)} failed: {e}; skipping for this run")
            skip.add(_describe(unit))
            continue
        units += 1
        if args.once or (args.max_units and units >= args.max_units):
            break
        if args.max_minutes and (time.monotonic() - start) / 60 >= args.max_minutes:
            break
    print(f"done — {units} unit(s)")


if __name__ == "__main__":
    main()
