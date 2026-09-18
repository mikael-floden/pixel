#!/usr/bin/env python3
"""A CANDIDATE BECOMES A REAL MONSTER BY ITSELF (maintainer 2026-09-18: "When
all animations have been approved and the monster has been approved I want the
monster to move to be a real monster automatically!").

Eligibility, all of it his:
  * the DESIGN is approved (`monsters/<id>` or `monsters/candidates/<id>`), and
  * every one of the five game states has ONE take whose eight directions are
    ALL approved. Two fully-approved takes of the same state is not a tie to
    break here — it is his pick, so the monster waits and says so.

Graduation, in order (each step is safe to re-run):
  1. pin the roster entry FIRST — id, display name, lore and the renames that
     map this character's PixelLab animation names onto idle/walk/angry/attack/
     die. Pinning before the tag is what keeps the folder id equal to the
     candidate id, so his verdicts, the lore records and the wiki's links all
     survive the move. Let sync discover it untagged and it invents an id from
     the prompt.
  2. retag on PixelLab MONSTER_CANDIDATE -> MONSTER. The tag is the ground
     truth both ways; this is the moment it becomes a monster.
  3. `sync.py --only <id>` mirrors it into `monsters/<id>/`, rebuilds
     `animation_map.json` and verifies.
  4. the candidate folder is removed and the design moves to `config.graduated`
     (NOT `retired` — it was not rejected, and re-adding it as a candidate
     later would re-birth a monster that already exists).
His approvals are NEVER pruned by this: they key on `monsters/<id>`, which is
exactly what the shipped monster is called.
"""
import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import candidates as cand              # noqa: E402
import sync as sync_mod                # noqa: E402
from pixellab_client import PixelLabClient, PixelLabError  # noqa: E402

STATES = ("idle", "walk", "angry", "attack", "die")
DIRS_8 = ("south", "south-east", "east", "north-east", "north",
          "north-west", "west", "south-west")


def _base(slot):
    """`attack_v3` -> `attack`; `die_v1` -> `die`; `idle` -> `idle`."""
    s = slot
    while True:
        h, sep, tail = s.rpartition("_")
        if sep and (tail.startswith("v") and tail[1:].isdigit()):
            s = h
            continue
        return s


def eligible(cid, entries, verbose=False):
    """(ok, chosen_slots, why_not). chosen_slots maps state -> slot."""
    design = (entries.get(f"monsters/{cid}") or
              entries.get(f"monsters/candidates/{cid}") or {})
    if design.get("status") != "approved":
        return False, {}, "design not approved"
    man = cand.load_manifest(cid)
    if not man:
        return False, {}, "no candidate on disk"
    anims = (man.get("animations") or {})
    chosen, missing, ambiguous = {}, [], []
    for state in STATES:
        full = []
        for slot, rec in anims.items():
            if _base(slot) != state:
                continue
            got = [d for d in DIRS_8
                   if (entries.get(f"monsters/{cid}#{slot}#{d}") or {}).get("status") == "approved"]
            if len(got) == len(DIRS_8):
                full.append(slot)
        if not full:
            missing.append(state)
        elif len(full) > 1:
            ambiguous.append(f"{state}: {', '.join(sorted(full))}")
        else:
            chosen[state] = full[0]
    if missing:
        return False, chosen, "not fully approved: " + ", ".join(missing)
    if ambiguous:
        return False, chosen, "HIS pick, two full takes — " + "; ".join(ambiguous)
    return True, chosen, ""


def _renames(client, man, chosen):
    """PixelLab animation NAME -> state key, resolved through the group id each
    direction recorded. Never guessed from the name: v3 stores a clip as
    `custom-` + the first ~30 characters of the action text, so two states of
    one monster can start identically."""
    detail = client.get_character(man["pixellab_id"])
    by_id = {}
    for g in client.normalized_animations("character", detail):
        by_id[g.get("id")] = g.get("name")
    out = {}
    for state, slot in chosen.items():
        for d, q in ((man.get("animations") or {}).get(slot, {}).get("directions", {}).items()):
            name = by_id.get(q.get("group"))
            if name:
                out[name] = state
    return out


def graduate(cid, entries, client, apply=True, verbose=True):
    ok, chosen, why = eligible(cid, entries)
    if not ok:
        if verbose:
            print(f"  {cid}: waiting — {why}")
        return False
    man = cand.load_manifest(cid)
    design = next((d for d in cand.load_cfg()["candidates"] if d["id"] == cid), {})
    if verbose:
        print(f"  {cid}: ELIGIBLE — " + ", ".join(f"{s}={sl}" for s, sl in chosen.items()))
    if not apply:
        return True
    renames = _renames(client, man, chosen)
    roster = sync_mod.load_roster()
    if not any(m["id"] == cid for m in roster):
        roster.append({"id": cid, "kind": "character",
                       "pixellab_id": man["pixellab_id"],
                       "name": design.get("name") or man.get("name"),
                       "lore": design.get("lore") or man.get("lore"),
                       "renames": renames})
        sync_mod.write_roster(roster)
        if verbose:
            print(f"  {cid}: roster entry pinned ({len(renames)} animation name(s) mapped)")
    client.set_character_tags(man["pixellab_id"], ["MONSTER"])
    if verbose:
        print(f"  {cid}: retagged MONSTER on PixelLab")
    sync_mod.sync(client, only=cid)  # sync compares only == m['id'] (a STRING, not a set)
    cfg = cand.load_cfg()
    cfg["candidates"] = [d for d in cfg["candidates"] if d["id"] != cid]
    cfg.setdefault("graduated", []).append(dict(
        design, graduated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        takes={s: sl for s, sl in chosen.items()}))
    cand.save_cfg(cfg)
    if os.path.isdir(cand.cdir(cid)):
        shutil.rmtree(cand.cdir(cid))
    cand.rebuild_index(cand.load_cfg())
    if verbose:
        print(f"  {cid}: GRADUATED — now monsters/{cid}, candidate folder removed")
    return True


def run(apply=True, only=None, verbose=True):
    try:
        entries = json.load(open(cand.FEEDBACK))["entries"]
    except (FileNotFoundError, ValueError):
        entries = {}
    ids = [d["id"] for d in cand.load_cfg()["candidates"]]
    if only:
        ids = [i for i in ids if i in set(only)]
    client = PixelLabClient() if apply else None
    n = 0
    for cid in ids:
        if not os.path.isdir(os.path.join(cand.cdir(cid), "animations")):
            continue
        try:
            n += bool(graduate(cid, entries, client, apply=apply, verbose=verbose))
        except PixelLabError as e:
            print(f"  {cid}: NOT graduated — {e}")
    if verbose:
        print(f"graduate: {n} monster(s) {'moved' if apply else 'ready'}")
    return n


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", help="comma-separated candidate ids")
    a = ap.parse_args()
    run(apply=not a.dry_run, only=a.only.split(",") if a.only else None)


if __name__ == "__main__":
    main()
