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


def _slot_names(client, man, chosen):
    """(renames, dead) — PixelLab animation NAME -> state for the chosen takes,
    and the names of every OTHER animation on the character.

    Matched by the ACTION TEXT, not by id: `normalized_animations` reports no
    id for a character's clips (measured — every `group_id` came back empty, and
    an id-keyed map silently mapped walk onto idle on the first graduation).
    PixelLab names a v3 clip `custom-` + the first ~30 characters of the action
    text, which is the same prefix rule the client already uses to find takes.
    """
    detail = client.get_character(man["pixellab_id"])
    groups = [g for g in client.normalized_animations("character", detail) if g.get("name")]
    names = [g["name"] for g in groups]
    # PixelLab keeps the slot each group was GENERATED under in `display_name`
    # ("walk", "attack_v3"). It can be stale (an old attempt's name), so it is
    # only ever a TIE-BREAK — but it is the one thing that separates two action
    # texts sharing a 28-character prefix.
    slot_of = {g["name"]: (g.get("display_name") or "") for g in groups}
    anims = man.get("animations") or {}
    renames, claimed = {}, set()
    wanted = {}                       # name -> [state, …] every state whose text matches it
    for state, slot in chosen.items():
        rec = anims.get(slot) or {}
        acts = {rec.get("action")} | {q.get("action") for q in (rec.get("directions") or {}).values()}
        for act in sorted((a for a in acts if a), key=len, reverse=True):
            key = act.strip()[:28].lower()
            for n in names:
                body = n[len("custom-"):] if n.lower().startswith("custom-") else n
                if body.strip()[:28].lower() == key:
                    wanted.setdefault(n, [])
                    if state not in wanted[n]:
                        wanted[n].append(state)
    for n, states in wanted.items():
        if len(states) > 1:
            # TWO STATES CLAIM THE SAME NAME. His cobra: the attack's south was
            # generated from the ladder's "Lunge Attack …" wording and so was
            # its walk, both names agree for 100 characters, and first-come
            # (walk) took it — the monster graduated with 7/8 attack and a walk
            # whose south was the attack clip. The slot PixelLab recorded picks
            # the right one; with no help there, first-come stands and says so.
            dn = slot_of.get(n, "")
            pick = next((st for st in states if dn == chosen[st] or dn == st), None)
            if pick:
                print(f"    name {n!r} claimed by {states} -> {pick} (PixelLab recorded slot {dn!r})")
            else:
                pick = states[0]
                print(f"    !! name {n!r} claimed by {states}, nothing to tell them apart "
                      f"(PixelLab slot {dn!r}) — taking {pick}; check the directions after the sync")
            states = [pick]
        renames[n] = states[0]
        claimed.add(n)
    dead = [n for n in names if n not in claimed]
    return renames, dead


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
    renames, dead = _slot_names(client, man, chosen)
    if len(renames) < len(chosen):
        print(f"  {cid}: NOT graduated — only matched {sorted(set(renames.values()))} "
              f"of {sorted(chosen)} by action text; fix before moving it")
        return False
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
    # the takes he did NOT pick go before the tag does: left on the character
    # they mirror as extra half-filled states (the first graduation carried four
    # of them, 1/8 and 2/8 directions each, straight into the game's manifest).
    # BY GROUP ID, never by name: PixelLab generates each direction as its own
    # group under the same name, so a delete by animation_type matches five
    # groups at once and 409s (measured on the first graduation).
    ndel = 0
    for slot, rec in (man.get("animations") or {}).items():
        if slot in set(chosen.values()):
            continue
        for d, q in (rec.get("directions") or {}).items():
            if q.get("mirrored") or not q.get("group"):
                continue
            try:
                client.delete_animation(man["pixellab_id"], group_id=q["group"], direction=d)
                ndel += 1
            except PixelLabError as e:
                print(f"  {cid}: could not delete {slot}/{d}: {e}")
    if verbose and ndel:
        print(f"  {cid}: deleted {ndel} direction-take(s) from the takes he did not pick")
    client.set_character_tags(man["pixellab_id"], ["MONSTER"])
    if verbose:
        print(f"  {cid}: retagged MONSTER on PixelLab")
    sync_mod.sync(client, only=cid)  # sync compares only == m['id'] (a STRING, not a set)
    cfg = cand.load_cfg()
    cfg["candidates"] = [d for d in cfg["candidates"] if d["id"] != cid]
    cfg.setdefault("graduated", []).append(dict(
        design, graduated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        takes={s: sl for s, sl in chosen.items()}))
    # THE CANDIDATE IS THE ONLY COPY UNTIL THE SYNC IS PROVEN. His cobra came
    # out of the mirror with 7/8 attack (two names collided); had the folder
    # gone first, the art would have been in git history only. Verify five
    # states x eight directions on disk before deleting anything.
    holes = {}
    for st in STATES:
        p = os.path.join(sync_mod.ROOT, cid, "animations", st)
        n = len([d for d in os.listdir(p)]) if os.path.isdir(p) else 0
        if n != len(DIRS_8):
            holes[st] = n
    if holes:
        print(f"  {cid}: SYNCED WITH HOLES {holes} — candidate folder KEPT. "
              f"Repair the roster renames (two takes can share a name) and re-run sync --only {cid}")
        cand.save_cfg(cfg)
        cand.rebuild_index(cand.load_cfg())
        return False
    cand.save_cfg(cfg)
    if os.path.isdir(cand.cdir(cid)):
        shutil.rmtree(cand.cdir(cid))
    cand.rebuild_index(cand.load_cfg())
    if verbose:
        print(f"  {cid}: GRADUATED — now monsters/{cid}, candidate folder removed")
    return True



def drop_unapproved_takes(entries, client, apply=True, verbose=True, only=None):
    """DELETE AN ATTEMPT HE NEVER APPROVED (maintainer 2026-09-18: "The
    animation attempts that was never approved can be removed").

    A slot is droppable when it is a NUMBERED attempt (`attack_v2`, never the
    bare `attack`), another slot of the same state has approvals, and not one
    of its own eight directions is approved. Frames go from disk, the takes go
    from PixelLab by GROUP ID, the record loses the slot, and any redo or
    rejected verdict left on it goes too — it judged art that no longer exists.
    An attempt with even ONE approval is his and is never touched.
    """
    import re
    dropped = 0
    for design in list(cand.load_cfg()["candidates"]):
        cid = design["id"]
        if only and cid not in set(only):
            continue
        man = cand.load_manifest(cid)
        anims = (man or {}).get("animations") or {}
        if not anims:
            continue
        approved_states = set()
        for slot in anims:
            if any((entries.get(f"monsters/{cid}#{slot}#{d}") or {}).get("status") == "approved"
                   for d in DIRS_8):
                approved_states.add(_base(slot))
        for slot in list(anims):
            if not re.search(r"_v\d+$", slot):          # never the bare state
                continue
            if _base(slot) not in approved_states:       # nothing of this state is his yet
                continue
            if any((entries.get(f"monsters/{cid}#{slot}#{d}") or {}).get("status") == "approved"
                   for d in DIRS_8):
                continue                                  # he approved part of it
            if verbose:
                print(f"  {cid}: dropping unapproved attempt {slot}")
            if not apply:
                dropped += 1
                continue
            for d, q in (anims[slot].get("directions") or {}).items():
                if q.get("group") and not q.get("mirrored"):
                    try:
                        client.delete_animation(man["pixellab_id"], group_id=q["group"], direction=d)
                    except PixelLabError as e:
                        print(f"    {slot}/{d}: {e}")
                fdir = os.path.join(cand.cdir(cid), "animations", slot, d)
                shutil.rmtree(fdir, ignore_errors=True)
                strip = os.path.join(cand.cdir(cid), "animations", f"{slot}__{d}.webp")
                if os.path.exists(strip):
                    os.remove(strip)
            shutil.rmtree(os.path.join(cand.cdir(cid), "animations", slot), ignore_errors=True)
            anims.pop(slot, None)
            with open(cand.manifest_path(cid), "w") as f:
                json.dump(man, f, indent=2, ensure_ascii=False)
                f.write("\n")
            for d in DIRS_8:
                entries.pop(f"monsters/{cid}#{slot}#{d}", None)
            dropped += 1
    if dropped and apply:
        doc = json.load(open(cand.FEEDBACK))
        doc["entries"] = entries
        doc["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        with open(cand.FEEDBACK, "w") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write("\n")
        cand.rebuild_index(cand.load_cfg())
    if verbose:
        print(f"takes: {dropped} unapproved attempt(s) {'removed' if apply else 'ready to remove'}")
    return dropped


def run(apply=True, only=None, verbose=True, drop=True):
    try:
        entries = json.load(open(cand.FEEDBACK))["entries"]
    except (FileNotFoundError, ValueError):
        entries = {}
    ids = [d["id"] for d in cand.load_cfg()["candidates"]]
    if only:
        ids = [i for i in ids if i in set(only)]
    client = PixelLabClient() if apply else None
    if drop:
        drop_unapproved_takes(entries, client, apply=apply, verbose=verbose, only=only)
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
    ap.add_argument("--no-drop", dest="drop", action="store_false",
                    help="graduate only; do not delete the attempts he never approved. What the "
                         "on-approval workflow uses: MOVING a monster he has fully approved is his "
                         "standing instruction, DELETING an attempt he has not looked at is not")
    a = ap.parse_args()
    run(apply=not a.dry_run, only=a.only.split(",") if a.only else None, drop=a.drop)


if __name__ == "__main__":
    main()
