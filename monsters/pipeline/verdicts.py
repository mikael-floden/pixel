#!/usr/bin/env python3
"""NO VERDICT OF HIS MAY NAME AN ADDRESS THAT NO LONGER EXISTS.

The wiki writes his review into `live/feedback/monsters.json` keyed on the
address he was looking at — `monsters/candidates/ashling` (the gallery card),
`monsters/ashling` (the creature page), `monsters/ashling#attack_v3#south` (one
direction of one take). When our own pipeline moves the art out from under one
of those addresses, the entry is left pointing at nothing, and the wiki shows
him a verdict he cannot open or his old words over new art
(`wiki/tools/check-dangling.mjs`, maintainer 2026-09-23: "so damn angry
dangling states still exist").

GRADUATION IS WHAT MOVES THE ART, and it is why 751 of them accumulated: the
winning take is RENAMED to its canonical state (`attack_v3` -> `attack`) and the
candidate folder is deleted, so every verdict he ever gave on that take, and on
the gallery card, is instantly at a dead address. The old prune could not see
it — it compared the bare id (`seed_husk`) against the roster, and a graduated
monster IS in the roster, so `monsters/candidates/seed_husk` read as alive. A
KEY IS AN ADDRESS, NOT AN ID: `monsters/candidates/<id>` and `monsters/<id>` are
two different places and only one of them exists at a time.

Settling is not deleting. His yes on `attack_v3#south` was a yes on the pixels
that are now `attack#south` — the art hash is the same file — so the entry is
CARRIED to the address the art moved to, and deleted only when the art itself is
gone (a take he never picked, deleted from PixelLab at graduation). Where both
addresses carry a verdict, the NEWER timestamp is his current word and it stands;
the older is dropped whatever it says. The rename map is not guessed: graduation
records the take it picked per state in `config.graduated[].takes`.

  python monsters/pipeline/verdicts.py settle [--apply]
  python monsters/pipeline/verdicts.py check          # exit 1 if any dangle
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEEDBACK = os.path.join(os.path.dirname(ROOT), "live", "feedback", "monsters.json")
CFG = os.path.join(ROOT, "config", "candidates.json")
OUT = os.path.join(ROOT, "candidates")
STATES = ("idle", "walk", "angry", "attack", "die")
DIRS_8 = ("south", "south-east", "east", "north-east", "north",
          "north-west", "west", "south-west")


def _base(slot):
    """`attack_v3` -> `attack`; `die_v1` -> `die`; `idle` -> `idle`."""
    s = slot
    while True:
        h, sep, tail = s.rpartition("_")
        if sep and tail.startswith("v") and tail[1:].isdigit():
            s = h
            continue
        return s


def load_feedback():
    if not os.path.exists(FEEDBACK):
        return {"format": "pixel-wiki-feedback@1", "domain": "monsters", "entries": {}}
    return json.load(open(FEEDBACK))


def save_feedback(fb):
    """Written the way the wiki writes it — tmp + replace, so a reviewer saving
    mid-write never reads half a file."""
    fb["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    tmp = FEEDBACK + ".tmp"
    with open(tmp, "w") as f:
        json.dump(fb, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, FEEDBACK)


def live_addresses():
    """Every address the wiki can actually open, from the filesystem.

    THE FILESYSTEM, not an index: an index is a thing we write and can be stale
    by exactly the step that moved the art. A monster's states are flat files
    (`animations/attack__south.webp`); a candidate's are the slots in its own
    manifest, which is where a numbered take legitimately lives.
    """
    addrs = set()
    for cid in sorted(os.listdir(ROOT)):
        adir = os.path.join(ROOT, cid, "animations")
        if not os.path.isdir(adir):
            continue
        addrs.add(f"monsters/{cid}")
        for f in os.listdir(adir):
            state, sep, tail = f.partition("__")
            if sep and "." in tail:
                addrs.add(f"monsters/{cid}#{state}#{tail.rsplit('.', 1)[0]}")
    # A CANDIDATE FOLDER ON DISK IS NOT A CANDIDATE. `config.candidates` is the
    # registry the index and the wiki are built from; a folder left behind by a
    # graduation that could not finish (his pebble crab: synced with a 4/8
    # attack, so the folder was kept on purpose) is an ORPHAN, and the wiki
    # resolves its numbered slots to nothing. Reading the folder instead of the
    # registry hid 24 dangling verdicts from this very check.
    registered = {d["id"] for d in json.load(open(CFG))["candidates"]}
    if os.path.isdir(OUT):
        for cid in sorted(os.listdir(OUT)):
            man_p = os.path.join(OUT, cid, "candidate.json")
            if cid not in registered or not os.path.isfile(man_p):
                continue
            addrs.add(f"monsters/candidates/{cid}")
            addrs.add(f"monsters/{cid}")
            man = json.load(open(man_p))
            for slot, rec in (man.get("animations") or {}).items():
                for d in (rec.get("directions") or {}):
                    addrs.add(f"monsters/{cid}#{slot}#{d}")
    return addrs


def _graduated_takes():
    """id -> {state: the slot that WON}, as graduation recorded it."""
    cfg = json.load(open(CFG))
    return {g["id"]: (g.get("takes") or {}) for g in cfg.get("graduated", [])}


def plan(entries=None):
    """[(key, action, target, why)] — action is 'carry', 'drop' or 'hole'.

    A HOLE IS NOT A DANGLING VERDICT AND IS NEVER CLEARED. When the state is
    on disk but one facing of it is not, his yes is the only record that the
    art was ever there, and the answer is to put the art back — dropping the
    verdict would erase the evidence and leave the game with a monster that
    cannot face that way. The wiki's own checker cannot see these (its
    filesystem fallback asks only whether ANY `walk__*` file exists, so a
    missing facing reads as fine); this found three, all in shipped monsters.
    """
    entries = entries if entries is not None else load_feedback().get("entries", {})
    live = live_addresses()
    takes = _graduated_takes()
    states_live = {a.rsplit("#", 1)[0] for a in live if "#" in a}
    out = []
    for key in sorted(entries):
        if not key.startswith("monsters/") or key in live:
            continue
        path, _, rest = key.partition("#")
        cid = path.split("/")[-1]
        graduated = cid in takes
        if rest and key.rsplit("#", 1)[0] in states_live:
            out.append((key, "hole", None, "the state is on disk but this facing of it is missing"))
            continue
        # the gallery card of a monster that graduated: the same design, one
        # address up, and that address exists.
        if not rest and path == f"monsters/candidates/{cid}" and graduated:
            out.append((key, "carry", f"monsters/{cid}", "the candidate card graduated into the creature page"))
            continue
        if rest:
            slot, _, d = rest.partition("#")
            state = _base(slot)
            target = f"monsters/{cid}#{state}#{d}"
            if graduated and takes[cid].get(state) == slot and target in live:
                out.append((key, "carry", target, f"graduation renamed {slot} to {state}"))
                continue
            if graduated:
                out.append((key, "drop", None, f"{slot} is a take he did not pick; it was deleted at graduation"))
                continue
        out.append((key, "drop", None, "nothing on disk answers to this address"))
    return out


def settle(apply=False, verbose=True):
    fb = load_feedback()
    entries = fb.get("entries", {})
    todo = [t for t in plan(entries) if t[1] != "hole"]
    holes = [t for t in plan(entries) if t[1] == "hole"]
    carried = dropped = superseded = 0
    mismatched = []
    for key, action, target, why in todo:
        src = entries.get(key) or {}
        if action == "carry":
            dst = entries.get(target)
            if dst:
                # BOTH ADDRESSES CARRY A VERDICT. His newer word wins, whatever
                # it says — a stale entry must never overwrite a newer decision
                # (PROTOCOL). Measured on his spider queen: the note "the head
                # ends up in the but" sat on `attack_v3#north` from 09-11 while
                # `attack#north`, the same art hash, was approved again on 09-21.
                if (src.get("updated_at") or "") > (dst.get("updated_at") or ""):
                    if apply:
                        entries[target] = src
                    carried += 1
                else:
                    superseded += 1
                if src.get("art") and dst.get("art") and src["art"] != dst["art"]:
                    mismatched.append((key, target))
            else:
                if apply:
                    entries[target] = src
                carried += 1
        else:
            dropped += 1
        if apply:
            entries.pop(key, None)
    if apply and todo:
        fb["entries"] = entries
        save_feedback(fb)
    if verbose:
        print(f"verdicts: {len(todo)} dangling — {carried} carried to the address the art moved to, "
              f"{superseded} superseded by his newer verdict there, {dropped} dropped (the art is gone)"
              f"{'' if apply else '  [dry run — pass --apply]'}")
        for key, target in mismatched:
            print(f"  note: {key} and {target} judge different art hashes; his newer one kept")
        for key, _a, _t, _w in holes:
            print(f"  HOLE (kept): {key} — he approved it and the file is not on disk; re-sync that monster")
    return todo


def check(verbose=True):
    """0 dangling or bust. Wired into every sweep that ends in a push."""
    full = plan()
    todo = [t for t in full if t[1] != "hole"]
    holes = [t for t in full if t[1] == "hole"]
    if verbose:
        if todo:
            print(f"DANGLING: {len(todo)} verdict(s) point at art that is not there:")
            for key, action, target, why in todo[:12]:
                print(f"  {key}  ({why})")
            if len(todo) > 12:
                print(f"  …and {len(todo) - 12} more")
            print("Run: python monsters/pipeline/verdicts.py settle --apply")
        else:
            print("verdicts: 0 dangling — every verdict names art that exists")
        for key, _a, _t, _w in holes:
            print(f"  HOLE: {key} — approved art missing from disk; re-sync that monster")
    return len(todo)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("settle", help="carry or clear every dangling verdict")
    s.add_argument("--apply", action="store_true")
    sub.add_parser("check", help="exit 1 if any verdict dangles")
    args = ap.parse_args()
    if args.cmd == "settle":
        settle(apply=args.apply)
    else:
        sys.exit(1 if check() else 0)


if __name__ == "__main__":
    main()


# ---------------------------------------------------------------------------
# HIS APPROVAL TRAVELS WITH THE ART, STAMP INCLUDED (maintainer 2026-09-25:
# "why didn't you bring the approval with it?"). The wiki pins a verdict to
# the art it judged by `art` = md5 of the clip's strip file, first 16 hex, and
# shows "regenerated since — judge again" when the file on disk hashes
# differently. Graduation re-writes every file (mirrored from PixelLab,
# normalized, padded), so every approval he carried over showed as stale
# although the pixels had not moved. When the new clip is the SAME ART — every
# frame's visible content identical to the clip he approved, frame for frame —
# the stamp is moved to the new file. When it is not, the stamp stays and the
# wiki is right to ask him.

def _content(im):
    """The visible pixels of one frame, cropped to its content box — so a
    canvas grown or padded around the same drawing compares equal."""
    import numpy as np
    a = np.array(im.convert("RGBA"))
    ys, xs = np.nonzero(a[..., 3] > 0)
    if not len(xs):
        return a[:0, :0]
    return a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def restamp(cid, apply=False, verbose=True):
    """Re-stamp his approvals on a graduated monster whose art is unchanged.

    The approved clip is read from the candidate folder, or from git history
    when graduation has already removed it (refill._candidate_frames). Returns
    (restamped, left) — left are approvals whose art genuinely differs."""
    import hashlib
    import numpy as np
    from PIL import Image
    import refill
    mpath = os.path.join(ROOT, cid, "monster.json")
    if not os.path.isfile(mpath):
        return 0, 0
    man = json.load(open(mpath))
    fb = load_feedback()
    ent = fb.get("entries", {})
    takes = _graduated_takes().get(cid, {})
    done = left = 0
    for key, v in list(ent.items()):
        if not key.startswith(f"monsters/{cid}#") or v.get("status") != "approved":
            continue
        _, state, d = key.split("#")
        rec = ((man.get("animations") or {}).get(state) or {}).get("directions", {}).get(d)
        if not rec or not rec.get("strip"):
            continue
        strip = os.path.join(ROOT, rec["strip"])
        if not os.path.isfile(strip):
            continue
        new_art = hashlib.md5(open(strip, "rb").read()).hexdigest()[:16]
        if v.get("art") == new_art:
            continue
        slot = takes.get(state, state)
        old = refill._candidate_frames(cid, slot, d)
        new_dir = os.path.join(ROOT, cid, "animations", state, d)
        new = [Image.open(os.path.join(new_dir, f)) for f in sorted(os.listdir(new_dir)) if f.endswith(".webp")] \
            if os.path.isdir(new_dir) else []
        same = bool(old) and len(old) == len(new) and all(
            np.array_equal(_content(a), _content(b)) for (_, a), b in zip(old, new))
        if not same:
            left += 1
            continue
        done += 1
        if apply:
            ent[key] = dict(v, art=new_art)
    if apply and done:
        fb["entries"] = ent
        save_feedback(fb)
    if verbose:
        print(f"  {cid}: {done} approval(s) re-stamped onto the graduated art"
              f"{f', {left} left for him (the art really differs)' if left else ''}")
    return done, left
