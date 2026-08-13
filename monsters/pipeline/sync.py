"""Reconcile monsters/ against PixelLab — the MONSTER tag is the ground truth.

The maintainer tags every monster with "MONSTER" on PixelLab (in the objects
store or the characters store). This tool makes the repo match reality:

  - **discover**: paginate both stores, keep everything tagged MONSTER;
  - **reconcile the roster** (config/roster.json): a tagged id already in the
    roster keeps its folder id / display name / renames; a newly tagged id gets
    a folder generated from its prompt and best-effort state renames from
    pipeline/states.py (flagged for review); a roster entry whose id is no
    longer tagged is dropped;
  - **prune** every monster folder that is not in the reconciled roster
    ("remove the ones I removed");
  - **mirror** every roster monster (add/update; zero generations);
  - **regenerate** animation_map.json (the game-facing state contract, same
    shape as characters2/animation_map.json) + verify. The review gallery is a
    chat artifact, rebuilt separately with pipeline/review_artifact.py.

Does NOT commit — the caller commits the reconciled tree as one atomic change.

Usage:
  python monsters/pipeline/sync.py                 # the usual: discover + mirror + prune
  python monsters/pipeline/sync.py --dry-run       # print the plan, touch nothing
  python monsters/pipeline/sync.py --fresh         # wipe each folder first (full re-download)
  python monsters/pipeline/sync.py --only <id>     # limit mirroring to one monster
"""

from __future__ import annotations

import argparse
import json
import os
import shutil

import mirror
import postprocess
import states as states_mod
from mirror import ROOT, STATES, iter_manifests, monster_dir, read_manifest
from pixellab_client import PixelLabClient

CONFIG_DIR = os.path.join(ROOT, "config")
ROSTER = os.path.join(CONFIG_DIR, "roster.json")
ANIMATION_MAP = os.path.join(ROOT, "animation_map.json")


def load_roster():
    if not os.path.exists(ROSTER):
        return []
    with open(ROSTER) as f:
        return json.load(f)["monsters"]


def write_roster(monsters):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    doc = {
        "_comment": "Roster of monsters, reconciled against PixelLab by pipeline/sync.py "
                    "— the MONSTER tag on PixelLab decides membership; this file just pins "
                    "each monster's stable folder id, display name and animation renames "
                    "({exact PixelLab animation name: idle|walk|angry|attack|die}). Hand-"
                    "tune names/renames freely; sync preserves them across runs. Entries "
                    "whose pixellab_id loses its tag are dropped (and their folder pruned).",
        "monsters": monsters,
    }
    with open(ROSTER, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")


def _unique_id(base, taken):
    mid, n = base or "monster", 1
    while mid in taken:
        n += 1
        mid = f"{base}_{n}"
    taken.add(mid)
    return mid


def _auto_folder_id(prompt, taken):
    """Folder id for a newly tagged monster nobody has named yet: a compact
    slug of the prompt's leading subject words."""
    words = [w for w in mirror._slug(prompt).split("_")
             if w not in {"a", "an", "the", "of", "with", "and", "but", "as",
                          "in", "like", "this", "is", "one"}]
    return _unique_id("_".join(words[:3]) or "monster", taken)


MAX_AUTO_PRUNE = 5


def discover_roster(client, verbose=True, allow_mass_prune=False):
    """Reconcile config/roster.json against the MONSTER tags on PixelLab.
    Returns (roster_entries, report)."""
    tagged = client.tagged_monsters()
    tagged_ids = {t["id"] for t in tagged}
    prev = load_roster()
    prev_by_pid = {m["pixellab_id"]: m for m in prev}

    kept, added, dropped, flagged = [], [], [], []
    # Reserve EVERY existing roster id up front — a newly tagged monster that
    # happens to be listed before an existing one must never steal its folder.
    taken = {m["id"] for m in prev}
    for t in tagged:
        pid = t["id"]
        if pid in prev_by_pid:
            e = dict(prev_by_pid[pid])
            e["kind"] = t["kind"]
            kept.append(e)
            continue
        detail = client.get_source(t["kind"], pid)
        prompt = (detail.get("prompt") or detail.get("description") or "").strip()
        anims = [g["name"] for g in client.normalized_animations(t["kind"], detail)]
        renames, unplaced = states_mod.propose_renames(anims)
        entry = {
            "id": _auto_folder_id(prompt, taken),
            "kind": t["kind"],
            "pixellab_id": pid,
            "name": None,
            "renames": renames,
        }
        added.append(entry)
        if unplaced:
            flagged.append(f"{entry['id']}: could not auto-place animation(s) "
                           f"{unplaced} — pin them in config/roster.json")
    for pid, e in prev_by_pid.items():
        if pid not in tagged_ids:
            dropped.append(e["id"])
    # Second line of defence behind the client's complete-or-raise paging: a
    # dropped entry means "rmtree this monster's art", so a listing glitch must
    # never be able to wipe the domain. Losing a handful of tags at once is a
    # human action; losing many at once is a bug.
    if len(dropped) > MAX_AUTO_PRUNE and not allow_mass_prune:
        raise SystemExit(
            f"REFUSING TO PRUNE: {len(dropped)} monsters lost their MONSTER tag in one "
            f"run ({', '.join(sorted(dropped)[:8])}{'...' if len(dropped) > 8 else ''}).\n"
            f"That is more than MAX_AUTO_PRUNE={MAX_AUTO_PRUNE} and would delete their "
            f"art. If the API listing was incomplete this is data loss; if you really "
            f"untagged them, re-run with --allow-mass-prune.")

    roster = kept + added
    if verbose:
        print(f"discover: {len(tagged)} tagged on PixelLab | kept {len(kept)}, "
              f"new {len(added)}, dropped {len(dropped)}")
        for e in added:
            print(f"  NEW {e['id']} <- {e['kind']} {e['pixellab_id']}")
        for d in dropped:
            print(f"  DROP {d} (tag removed / deleted on PixelLab)")
        for fmsg in flagged:
            print(f"  !! {fmsg}")
    return roster, {"added": [e["id"] for e in added], "dropped": dropped, "flagged": flagged}


def adopt_new_animations(roster, metas, verbose=True):
    """Map animations added to an ALREADY-KNOWN monster onto the states they fill.

    Auto-renaming used to happen only for brand-new monsters, so when the
    maintainer generated a missing animation for an existing one it mirrored as
    an unmapped extra with a slugged key — the art sat on disk while verify kept
    reporting the state as missing (plague_hound's attack, 2026-08-13). Here a
    monster with an unmapped state adopts an extra animation whose name
    classifies to exactly that state. Deliberately narrow: it only ever FILLS a
    hole, never re-points a state the roster already pins.
    """
    by_id = {m["id"]: m for m in roster}
    adopted = []
    for meta in metas:
        entry = by_id.get(meta["id"])
        if not entry:
            continue
        unmapped = {s for s, k in (meta.get("states") or {}).items() if k is None}
        if not unmapped:
            continue
        renames = dict(entry.get("renames") or {})
        for key, a in (meta.get("animations") or {}).items():
            if key in STATES:
                continue
            src = a.get("source_name")
            guess = states_mod.classify(src)
            if src and guess in unmapped and src not in renames:
                renames[src] = guess
                unmapped.discard(guess)
                adopted.append({"id": meta["id"], "name": src, "state": guess})
        if renames != (entry.get("renames") or {}):
            entry["renames"] = renames
    if verbose:
        for a in adopted:
            print(f"  ADOPT {a['id']}: {a['name']!r} -> {a['state']} "
                  f"(new animation filling a missing state)")
    return adopted


# --- animation_map.json (the game-facing contract) ---------------------------

def build_animation_map(metas):
    """Same shape as characters2/animation_map.json: `states` holds the default
    (identity) mapping, `overrides.<monster>` the deviations — e.g. a monster
    without an angry animation maps angry -> idle (maintainer rule). A state a
    monster simply cannot serve is listed in `missing` instead of being mapped."""
    overrides, missing = {}, {}
    for meta in metas:
        ov = {}
        for s, key in (meta.get("states") or {}).items():
            if key is None:
                missing.setdefault(meta["id"], []).append(s)
            elif key != s:
                ov[s] = key
        if ov:
            overrides[meta["id"]] = ov
    doc = {
        "_comment": "Stable GAME-STATE -> animation-key mapping for every monster "
                    "(same contract as characters2/animation_map.json). Keys under "
                    "`states` are the game's logical names and map to the animation "
                    "folder under monsters/<id>/animations/; `overrides.<id>` wins "
                    "where a monster deviates — e.g. {\"angry\": \"idle\"} means this "
                    "monster has no angry animation and the game should reuse idle "
                    "(maintainer rule). `missing` lists states a monster cannot serve "
                    "at all yet. REGENERATED by monsters/pipeline/sync.py from "
                    "config/roster.json renames — to change a mapping, edit the "
                    "roster and re-run sync.",
        "states": {s: s for s in STATES},
        "overrides": overrides,
        "missing": missing,
    }
    with open(ANIMATION_MAP, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    return doc


# --- verify ------------------------------------------------------------------

def verify(metas):
    problems = []
    for meta in metas:
        mid = meta["id"]
        if len(meta.get("rotations") or {}) != 8:
            problems.append(f"{mid}: {len(meta.get('rotations') or {})}/8 rotations")
        for key, a in (meta.get("animations") or {}).items():
            nd = len(a.get("directions") or {})
            if nd != 8:
                problems.append(f"{mid}: animation '{key}' has {nd}/8 directions")
        for s, key in (meta.get("states") or {}).items():
            if key is None:
                problems.append(f"{mid}: state '{s}' has NO animation "
                                f"(generate one on PixelLab and resync)")
        for u in meta.get("unresolved_takes") or []:
            problems.append(f"{mid}: '{u['key']}' direction '{u['direction']}' has "
                            f"{len(u['takes'])} takes upstream; mirrored the one the "
                            f"PixelLab UI shows (the newest). Older take(s) are invisible "
                            f"in the UI — no action needed unless the art looks wrong, "
                            f"then pin in config/roster.json:direction_picks")
    return problems


# --- orchestration -----------------------------------------------------------

def sync(client, fresh=False, dry_run=False, only=None, allow_mass_prune=False):
    roster, report = discover_roster(client, allow_mass_prune=allow_mass_prune)
    if not roster:
        raise SystemExit("discovery returned NO tagged monsters — refusing to prune "
                         "everything (is the API reachable / the tag right?)")
    if not dry_run:
        write_roster(roster)
    want = {m["id"] for m in roster}

    pruned = []
    for mid, _meta in iter_manifests():
        if mid not in want:
            pruned.append(mid)
            print(f"PRUNE {mid} — not tagged MONSTER anymore")
            if not dry_run:
                shutil.rmtree(monster_dir(mid), ignore_errors=True)

    metas = []
    for m in roster:
        if only and m["id"] != only:
            existing = read_manifest(m["id"])
            if existing:
                metas.append(existing)
            continue
        print(f"\nmirror {m['id']} <- {m['kind']} {m['pixellab_id']}")
        if dry_run:
            continue
        if fresh and os.path.isdir(monster_dir(m["id"])):
            shutil.rmtree(monster_dir(m["id"]), ignore_errors=True)
        mirror.mirror(client, m["id"], m["kind"], m["pixellab_id"],
                      renames=m.get("renames"), name=m.get("name"),
                      direction_picks=m.get("direction_picks"),
                      lore=m.get("lore"))
        # repair wrap-around overflow + pinned die-tail cloud cuts on freshly
        # mirrored frames — see postprocess.py; re-reads the manifest they rewrite
        postprocess.process_monster(m["id"])
        postprocess.trim_die_tails(m["id"])
        metas.append(read_manifest(m["id"]))

    if dry_run:
        print("\n(dry run: nothing written)")
        return {"pruned": pruned, **report}

    # An animation the maintainer added to an existing monster arrives as an
    # unmapped extra; adopt it into the state it fills, then re-mirror that
    # monster so the art lands under the canonical key (frames are unchanged,
    # so this is 304s plus a re-save).
    adopted = adopt_new_animations(roster, metas)
    if adopted:
        write_roster(roster)
        by_id = {m["id"]: m for m in roster}
        for mid in sorted({a["id"] for a in adopted}):
            m = by_id[mid]
            print(f"\nre-mirror {mid} (adopted "
                  f"{', '.join(a['state'] for a in adopted if a['id'] == mid)})")
            shutil.rmtree(monster_dir(mid), ignore_errors=True)
            mirror.mirror(client, mid, m["kind"], m["pixellab_id"],
                          renames=m.get("renames"), name=m.get("name"),
                          direction_picks=m.get("direction_picks"),
                          lore=m.get("lore"))
            postprocess.process_monster(mid)
            postprocess.trim_die_tails(mid)
            metas = [read_manifest(mid) if x["id"] == mid else x for x in metas]

    build_animation_map(metas)
    problems = verify(metas)

    print("\n=== sync summary ===")
    print(f"  roster: {len(roster)} | new: {report['added']} | "
          f"dropped: {report['dropped']} | pruned folders: {pruned}")
    if problems:
        print("  WARNINGS:")
        for p in problems:
            print(f"    !! {p}")
    else:
        print("  every monster serves all 5 states across 8 directions.")
    return {"pruned": pruned, "problems": problems, **report}


def main():
    ap = argparse.ArgumentParser(description="Reconcile monsters/ against PixelLab MONSTER tags.")
    ap.add_argument("--fresh", action="store_true", help="wipe each folder before mirroring")
    ap.add_argument("--dry-run", action="store_true", help="print the plan; change nothing")
    ap.add_argument("--only", help="mirror just this monster id (others keep current files)")
    ap.add_argument("--allow-mass-prune", action="store_true",
                    help=f"permit deleting more than {MAX_AUTO_PRUNE} monsters in one run")
    args = ap.parse_args()
    client = PixelLabClient()
    sync(client, fresh=args.fresh, dry_run=args.dry_run, only=args.only,
         allow_mass_prune=args.allow_mass_prune)


if __name__ == "__main__":
    main()
