"""The objects loop.

Each "unit" of work is one PixelLab generation: create a persistent
8-direction object, or generate one of its animations (all 8 directions). The
loop figures out the next missing unit purely by reading the filesystem (so it's
fully resumable), does it, rebuilds the viewer manifest, and commits + pushes.

Per object, in order: create the 8-dir object -> each of its 3 animations. Then
the next object. The object list is the curated catalog followed by procedural
fill up to targets.num_objects. Each pass first syncs PixelLab-side regenerations
/ deletions into the repo (zero generations).

Run a bounded chunk (intended for a scheduled Routine / GitHub Action):
  python objects/pipeline/loop.py --max-minutes 50 --min-balance 20
Other flags: --max-units N, --once, --no-push.
"""

from __future__ import annotations

import argparse
import subprocess
import time

import coordination
import factory
import viewer_build
from pixellab_client import BudgetExhausted, PixelLabClient


# --- git --------------------------------------------------------------------

def _git(*args, check=True):
    return subprocess.run(["git", *args], cwd=factory.ROOT, capture_output=True, text=True,
                          check=check)


def _current_branch():
    return _git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or "main"


def commit_push(message, push=True):
    """Commit only the objects/ domain (disjoint from characters/ and maps/, so
    concurrent pushes to the same branch rebase cleanly) and push to the current
    branch with backoff. Git runs with cwd=factory.ROOT (the objects/ dir), so
    '.' stages this domain's subtree and '../coordination/objects.json' stages
    our own heartbeat — the one file we may write outside the domain dir."""
    _git("add", "-A", ".")
    _git("add", "--", "../coordination/objects.json", check=False)
    status = _git("status", "--porcelain", "--", ".", "../coordination/objects.json").stdout.strip()
    if not status:
        return False
    _git("commit", "-m", message)
    if push:
        branch = _current_branch()
        for attempt in range(4):
            r = _git("push", "-u", "origin", branch, check=False)
            if r.returncode == 0:
                break
            # Remote may have advanced (a concurrent domain's push); rebase + retry.
            _git("fetch", "origin", branch, check=False)
            _git("rebase", f"origin/{branch}", check=False)
            time.sleep(2 ** (attempt + 1))
        else:
            print("  ! push failed after retries:", r.stderr[:200])
    return True


# --- planning ---------------------------------------------------------------

def next_action(cfg):
    """The next missing unit across all objects, derived from the filesystem.

    For each object in order: create the persistent 8-direction object (base),
    then generate each of its 3 animations (all 8 directions). Returns an action
    tuple or ('all_complete',)."""
    for spec in factory.object_specs(cfg):
        oid = spec["id"]
        if not factory.has_base(oid):
            return ("base", spec)
        for adef in spec["animations"]:
            if not factory.has_animation(oid, adef["key"]):
                return ("animate", spec, adef)
    return ("all_complete",)


# --- one unit ---------------------------------------------------------------

def advance(client, cfg, push=True):
    """Do exactly one unit of work; commit + push it. Returns a description, or
    None when everything is complete."""
    action = next_action(cfg)
    kind = action[0]

    if kind == "base":
        spec = action[1]
        factory.generate_base(client, cfg, spec)
        desc = f"{spec['id']}: 8-dir object ({spec['size']}px {spec['view']}) — {spec['name']}"
    elif kind == "animate":
        spec, adef = action[1], action[2]
        factory.generate_animation(client, cfg, spec, adef)
        desc = f"{spec['id']}: animation '{adef['key']}' — {adef['description']} (8 dirs)"
    elif kind == "all_complete":
        print("== all objects complete ==")
        return None
    else:
        raise RuntimeError(f"unknown action {kind}")

    factory.mark_complete_if_done(cfg, action[1])
    viewer_build.build()
    # Refresh our coordination heartbeat so the other agents can see objects'
    # health, progress, and how much of the shared budget we've drawn.
    coordination.publish(current=desc, progress=coordination.progress_snapshot(cfg),
                         budget_remaining=client.generations_remaining())
    commit_push(desc, push=push)
    print("  +", desc)
    return desc


# --- main -------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Run the pixel-objects factory loop.")
    ap.add_argument("--max-units", type=int, default=0, help="0 = unlimited")
    ap.add_argument("--max-minutes", type=float, default=0, help="0 = unlimited")
    ap.add_argument("--min-balance", type=int, default=None,
                    help="Stop when generations remaining drops below this.")
    ap.add_argument("--once", action="store_true", help="Do a single unit and exit.")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--restyle", action="store_true",
                    help="Delete objects made under an older style_version so they "
                         "regenerate in the current style (re-spends generations).")
    ap.add_argument("--no-sync", action="store_true",
                    help="Skip the pre-run repo<->PixelLab reconcile (loose-pointer "
                         "prune, deletion parity, UI-object mirror).")
    args = ap.parse_args()

    cfg = factory.load_config()
    min_balance = args.min_balance if args.min_balance is not None \
        else cfg["budget"]["min_generations_remaining"]
    client = PixelLabClient()

    # Reconcile the repo with PixelLab first (zero generations): prune loose
    # pointers, mirror UI-authored objects, and honour PixelLab-side deletions, so
    # the repo and account stay in sync automatically each pass. Lazy import
    # avoids a circular import (sync imports loop for commit_push).
    if not args.no_sync:
        try:
            import sync
            sync.sync_all(client, push=not args.no_push, quiet=True)
        except Exception as e:
            print(f"pre-run sync skipped ({e})")

    # Restyle: drop objects made under an older style so they regenerate in the
    # current look. Commit the removals up front, then the normal loop refills.
    if args.restyle:
        removed = factory.restyle_stale(cfg, client)
        if removed:
            viewer_build.build()
            commit_push(f"objects: restyle — regenerating {len(removed)} object(s) "
                        f"in style v{cfg.get('style_version', 1)}", push=not args.no_push)
            print(f"restyle: cleared {len(removed)} stale object(s): {', '.join(removed)}")

    # Keep in-world sizing current: propagate any scale-rule / world-height change
    # to existing objects (zero PixelLab cost) so nothing is unrealistically sized.
    moved = factory.refresh_placement(cfg)
    if moved:
        viewer_build.build()
        commit_push(f"objects: refresh world-scale placement on {moved} object(s)",
                    push=not args.no_push)
        print(f"refreshed placement on {moved} object(s)")

    # Fleet awareness: read the other domains' heartbeats and honour any request
    # addressed to us (per the protocol), then publish our own starting status.
    peers = coordination.read_peers()
    print("peers:", coordination.peer_summary(peers))
    for dom, s in peers.items():
        for req in s.get("requests", []):
            if req.get("to") == coordination.DOMAIN:
                print(f"  » request from {dom}: {req.get('text')}")

    start = time.monotonic()
    units = 0
    rem = client.generations_remaining()
    print(f"objects loop starting — {rem:.0f} generations remaining (floor {min_balance})")
    coordination.publish(current="startup", progress=coordination.progress_snapshot(cfg),
                         budget_remaining=rem, health="running")

    while True:
        try:
            client.ensure_budget(min_balance)
        except BudgetExhausted as e:
            print(f"stopping: {e}")
            break
        try:
            result = advance(client, cfg, push=not args.no_push)
        except BudgetExhausted as e:
            print(f"stopping: {e}")
            break
        if result is None:
            print("stopping: nothing left to generate")
            break
        units += 1
        if args.once or (args.max_units and units >= args.max_units):
            break
        if args.max_minutes and (time.monotonic() - start) / 60 >= args.max_minutes:
            print("stopping: time budget reached")
            break

    rem = client.generations_remaining()
    health = "idle" if rem >= min_balance else "stopped"
    coordination.publish(current=f"idle after {units} unit(s) this pass",
                         progress=coordination.progress_snapshot(cfg),
                         budget_remaining=rem, health=health)
    commit_push(f"objects heartbeat: {health} ({units} unit(s) this pass)", push=not args.no_push)
    print(f"done — {units} unit(s), {rem:.0f} generations left")


if __name__ == "__main__":
    main()
