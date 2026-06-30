"""The factory loop.

Each "unit" of work is one PixelLab operation: create an undressed base
character, generate one animation, create one dressed outfit state, or open a new
skeleton. The loop figures out the next missing unit purely by reading the
filesystem (so it's fully resumable), does it, rebuilds the mobile viewer, and
commits + pushes to main.

Per skeleton, in order:
  1. create `characters_per_skeleton` UNDRESSED base characters,
  2. give every character the full animation set,
  3. create the configured outfits (dressed states) on the reference character,
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
            # Remote may have advanced (e.g. a concurrent run); rebase and retry.
            _git("fetch", "origin", "main", check=False)
            _git("rebase", "origin/main", check=False)
            time.sleep(2 ** (attempt + 1))
        else:
            print("  ! push failed after retries:", r.stderr[:200])
    return True


# --- planning ---------------------------------------------------------------

def fill_next(cfg, sk, n_chars):
    """Next missing unit to make this skeleton's matrix consistent across
    `n_chars` characters: every character has every declared dress (undressed is
    dress #1), and every dress has every declared animation. Returns an action
    tuple or None when filled. Char-major order: each character is completed
    before the next, so the roster fills out steadily."""
    sid = sk["id"]
    chars = factory.list_characters(sid)
    anims = sk.get("animations", [])
    dresses = sk.get("dresses", ["undressed"])
    for i in range(n_chars):
        if i >= len(chars):
            return ("base", sid, sk, i)
        ch = chars[i]
        for did in dresses:
            if did == "undressed":
                for akey in anims:
                    if akey not in ch.get("animations", {}):
                        return ("animate", sid, sk, ch, "undressed", factory.anim_def(cfg, akey))
            else:
                dress = ch.get("outfits", {}).get(did)
                if not dress:
                    return ("dress", sid, sk, ch, factory.dress_def(cfg, did))
                for akey in anims:
                    if akey not in dress.get("animations", {}):
                        return ("animate", sid, sk, ch, did, factory.anim_def(cfg, akey))
    return None


def _next_pool(items, have, key):
    return next((it[key] for it in items if it[key] not in have), None)


def next_action(cfg):
    """Decide the next global unit.

    Phase A (< num_skeletons): build the current skeleton to its full target
    (characters x animations x dresses), growing animations then dresses, then
    open the next skeleton. Phase B (>= num_skeletons): append beyond the target
    to existing skeletons (animation, then dress, then character), each fanned
    out across the whole matrix."""
    t = cfg["targets"]
    skels = factory.list_skeletons()
    if not skels:
        return ("new_skeleton", 0)

    if len(skels) < t["num_skeletons"]:                      # ---- Phase A ----
        sk = skels[-1]
        u = fill_next(cfg, sk, t["characters"])
        if u:
            return u
        if len(sk.get("animations", [])) < t["animations"]:  # grow animations -> target
            nxt = _next_pool(cfg["animations"], sk.get("animations", []), "key")
            if nxt:
                return ("append_anim", sk, nxt)
        if len(sk.get("dresses", [])) < t["dresses"]:        # grow dresses -> target
            nxt = _next_pool(cfg["dress_pool"], sk.get("dresses", []), "id")
            if nxt:
                return ("append_dress", sk, nxt)
        return ("new_skeleton", len(skels))                  # at full target -> next skeleton

    for sk in skels:                                         # ---- Phase B ----
        u = fill_next(cfg, sk, len(factory.list_characters(sk["id"])))
        if u:
            return u
    for sk in skels:                                         # append beyond target
        nxt = _next_pool(cfg["animations"], sk.get("animations", []), "key")
        if nxt:
            return ("append_anim", sk, nxt)
        nxt = _next_pool(cfg["dress_pool"], sk.get("dresses", []), "id")
        if nxt:
            return ("append_dress", sk, nxt)
        if len(factory.list_characters(sk["id"])) < len(factory.CHARACTER_LOOKS):
            return ("base", sk["id"], sk, len(factory.list_characters(sk["id"])))
    return ("all_complete",)


# --- one unit ---------------------------------------------------------------

def advance(client, cfg, push=True):
    """Do exactly one unit of work; commit + push it. Returns a description, or
    None when everything is complete."""
    action = next_action(cfg)
    kind = action[0]

    if kind == "new_skeleton":
        sid, sk = factory.ensure_skeleton(cfg, action[1])
        p = sk["params"]
        desc = f"open skeleton {sid} ({p['view']} {p['width']}x{p['height']} {p['directions']}-dir)"
    elif kind == "base":
        _, sid, sk, i = action
        meta = factory.create_base_character(client, cfg, sid, sk, i)
        desc = f"[{sid}] undressed base {meta['local_id']}: {meta['look']}"
    elif kind == "dress":
        _, sid, sk, ch, ddef = action
        factory.create_dress_state(client, cfg, sid, sk, ch, ddef)
        desc = f"[{sid}] {ch['local_id']} dress '{ddef['id']}' (state)"
    elif kind == "animate":
        _, sid, sk, ch, did, adef = action
        factory.animate_variant(client, cfg, sid, sk, ch, did, adef)
        desc = f"[{sid}] {ch['local_id']}/{did or 'undressed'} animation '{adef['key']}'"
    elif kind == "append_anim":
        sk, akey = action[1], action[2]
        sk.setdefault("animations", []).append(akey)
        factory.save_skeleton(sk["id"], sk)
        desc = f"[{sk['id']}] +animation '{akey}' (fans out to all characters & dresses)"
    elif kind == "append_dress":
        sk, did = action[1], action[2]
        sk.setdefault("dresses", []).append(did)
        factory.save_skeleton(sk["id"], sk)
        desc = f"[{sk['id']}] +dress '{did}' (fans out to all characters)"
    elif kind == "all_complete":
        print("== all skeletons complete ==")
        return None
    else:
        raise RuntimeError(f"unknown action {kind}")

    viewer_build.build()
    commit_push(desc, push=push)
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

    print(f"done — {units} unit(s), {client.generations_remaining():.0f} generations left")


if __name__ == "__main__":
    main()
