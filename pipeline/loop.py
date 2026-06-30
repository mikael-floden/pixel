"""The factory loop.

Each "unit" of work is one PixelLab operation: create a base character, generate
one animation, generate one gear item, or open a new skeleton. The loop figures
out the next missing unit purely by reading the filesystem (so it's fully
resumable), does it, rebuilds the mobile viewer, and commits + pushes to main.

Per skeleton, in order:
  1. create `characters_per_skeleton` base characters,
  2. give every character the full animation set,
  3. generate `gear_per_slot` items for each equippable gear slot,
  4. mark the skeleton complete and open the next one.

Run a bounded chunk (intended for a scheduled Routine):
  python pipeline/loop.py --max-minutes 50 --min-balance 40
Other flags: --max-units N, --once, --no-push.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import time

import factory
import viewer_build
from pixellab_client import BudgetExhausted, PixelLabClient


# --- git --------------------------------------------------------------------

def _git(*args, check=True):
    return subprocess.run(["git", *args], cwd=factory.ROOT, capture_output=True, text=True,
                          check=check)


def commit_push(message, push=True):
    _git("add", "-A")
    status = _git("status", "--porcelain").stdout.strip()
    if not status:
        return False
    _git("commit", "-m", message)
    if push:
        for attempt in range(4):
            r = _git("push", "origin", "main", check=False)
            if r.returncode == 0:
                break
            time.sleep(2 ** (attempt + 1))
        else:
            print("  ! push failed after retries:", r.stderr[:200])
    return True


# --- planning ---------------------------------------------------------------

def current_skeleton(cfg):
    """Return (sid, meta) for the skeleton to work on, creating one if needed."""
    sks = factory.list_skeletons()
    if not sks:
        return factory.ensure_skeleton(cfg, 0)
    last = sks[-1]
    if last.get("status") == "complete":
        return factory.ensure_skeleton(cfg, last["index"] + 1)
    return last["id"], last


def char_fully_animated(cfg, char_meta):
    done = char_meta.get("animations", {})
    return all(a["key"] in done for a in cfg["animations"])


def next_action(cfg, sid, skel_meta):
    """Decide the next unit for this skeleton. Returns (kind, payload...)."""
    target_chars = cfg["targets"]["characters_per_skeleton"]
    per_slot = cfg["targets"]["gear_per_slot"]
    chars = factory.list_characters(sid)

    # Phase 1: bases.
    if len(chars) < target_chars:
        return ("base", len(chars))

    # Phase 2: animations.
    for ch in chars:
        for anim in cfg["animations"]:
            if anim["key"] not in ch.get("animations", {}):
                return ("animate", ch, anim)

    # Phase 3: gear (shared per skeleton).
    state = factory.gear_state(sid)
    for slot_def in cfg["gear_slots"]:
        if slot_def.get("kind") != "gear":
            continue
        have = len(state.get(slot_def["slot"], {}))
        if have < per_slot:
            return ("gear", slot_def, have)

    return ("complete",)


# --- one unit ---------------------------------------------------------------

def advance(client, cfg, push=True):
    """Do exactly one unit of work. Returns a short description, or None when
    the current skeleton just completed (caller should loop again for the next)."""
    sid, skel_meta = current_skeleton(cfg)
    action = next_action(cfg, sid, skel_meta)
    kind = action[0]

    if kind == "base":
        idx = action[1]
        meta = factory.create_base_character(client, cfg, sid, skel_meta, idx)
        desc = f"[{sid}] base character {meta['local_id']}: {meta['look']}"
    elif kind == "animate":
        ch, anim = action[1], action[2]
        factory.animate_one(client, cfg, sid, skel_meta, ch, anim)
        desc = f"[{sid}] {ch['local_id']} animation '{anim['key']}'"
    elif kind == "gear":
        slot_def, archetype_index = action[1], action[2]
        gid = factory.make_gear(client, cfg, sid, skel_meta, slot_def, archetype_index)
        desc = f"[{sid}] gear {gid} ({slot_def['archetypes'][archetype_index]})"
    elif kind == "complete":
        skel_meta["status"] = "complete"
        factory._write_json(os.path.join(factory.skeleton_dir(sid), "skeleton.json"),
                            skel_meta)
        viewer_build.build()
        commit_push(f"Complete skeleton {sid}", push=push)
        print(f"== skeleton {sid} complete ==")
        return None
    else:
        raise RuntimeError(f"unknown action {kind}")

    viewer_build.build()
    commit_push(f"Generate {desc}", push=push)
    print("  +", desc)
    return desc


# --- main -------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Run the pixel-character factory loop.")
    ap.add_argument("--max-units", type=int, default=0, help="0 = unlimited")
    ap.add_argument("--max-minutes", type=float, default=0, help="0 = unlimited")
    ap.add_argument("--min-balance", type=int, default=None,
                    help="Stop when generations remaining drops below this.")
    ap.add_argument("--once", action="store_true", help="Do a single unit and exit.")
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()

    cfg = factory.load_config()
    min_balance = args.min_balance if args.min_balance is not None \
        else cfg["budget"]["min_generations_remaining"]
    client = PixelLabClient()

    start = time.monotonic()
    units = 0
    rem = client.generations_remaining()
    print(f"factory loop starting — {rem:.0f} generations remaining "
          f"(floor {min_balance})")

    while True:
        try:
            client.ensure_budget(min_balance)
        except BudgetExhausted as e:
            print(f"stopping: {e}")
            break
        try:
            advance(client, cfg, push=not args.no_push)
        except BudgetExhausted as e:
            print(f"stopping: {e}")
            break
        units += 1
        if args.once or (args.max_units and units >= args.max_units):
            break
        if args.max_minutes and (time.monotonic() - start) / 60 >= args.max_minutes:
            print("stopping: time budget reached")
            break

    print(f"done — {units} unit(s), {client.generations_remaining():.0f} generations left")


if __name__ == "__main__":
    main()
