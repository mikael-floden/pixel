"""Reconcile items/ against PixelLab — the TYPE TAGS are the ground truth.

The maintainer authors every item in the PixelLab create-object UI and tags it
with its type (`MISC`, `SOUL`, `CONSUMABLE`, `SWORD`, `BOW`, `WAND`, `ARMOR` —
see `config/types.json`). This tool makes the repo match reality:

  - **discover**: paginate the objects store, keep everything carrying a known
    type tag;
  - **reconcile the roster** (`config/roster.json`): a tagged id already in the
    roster keeps its folder id and all hand-authored metadata (name, category,
    rarity, value, soul power, blurb) and only re-reads its *type* from the
    live tag; a newly tagged id is appended with a placeholder id and flagged
    `needs_review` — somebody has to LOOK at the sprite and name it; a roster
    entry whose id is no longer tagged is dropped;
  - **prune** every item folder that is not in the reconciled roster;
  - **mirror** every roster item (add/update, If-Modified-Since; zero
    generations);
  - **read the maintainer's verdicts** (`live/feedback/items.json`, see
    pipeline/feedback.py): rejected items leave the game, approvals and star
    ratings are recorded on the item;
  - **rebuild `viewer_data.json`** (the rolled-up registry the game and the
    wiki read) and **verify** the metadata.

Does NOT commit — the caller commits the reconciled tree as one atomic change.

Usage:
  python items/pipeline/sync.py                # the usual: discover + mirror + prune
  python items/pipeline/sync.py --dry-run      # print the plan, touch nothing
  python items/pipeline/sync.py --fresh        # re-download every sprite
  python items/pipeline/sync.py --only <id>    # mirror just one item
"""

from __future__ import annotations

import argparse
import json
import os
import shutil

import feedback
import mirror
from mirror import (CONFIG_DIR, ROOT, item_dir, iter_manifests, load_types,
                    now_iso, read_manifest)
from pixellab_client import PixelLabClient

ROSTER = os.path.join(CONFIG_DIR, "roster.json")
VIEWER = os.path.join(ROOT, "viewer_data.json")
NAME_MAX = 12


# --- roster ------------------------------------------------------------------

def load_roster():
    if not os.path.exists(ROSTER):
        return []
    with open(ROSTER) as f:
        return json.load(f)["items"]


def write_roster(entries):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    doc = {
        "_comment": "Roster of items, reconciled against PixelLab by pipeline/sync.py "
                    "— the TYPE TAG on a PixelLab object (MISC/SOUL/CONSUMABLE/SWORD/"
                    "BOW/WAND/ARMOR, see types.json) decides membership and type. This "
                    "file owns everything PixelLab has no field for: the stable folder "
                    "`id`, the in-game `name` (max 12 chars, describing what the sprite "
                    "LOOKS like — never the generation prompt; every SOUL item is named "
                    "\"Soulstone\", see types.json:shared_name), `category`, `rarity`, "
                    "gold `value`, the wiki `description` (~90-125 chars, written to the "
                    "monster that drops it — the drop mapping itself lives in "
                    "live/tuning/monsters.json), and for SOUL items the `power` a merge "
                    "grants. Hand-tune freely; sync preserves every "
                    "field across runs. Entries whose pixellab_id loses its tag are "
                    "dropped (and their folder pruned); newly tagged objects are "
                    "appended with needs_review=true and a placeholder name.",
        "items": entries,
    }
    with open(ROSTER, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")


def _unique_id(base, taken):
    iid, n = base or "item", 1
    while iid in taken:
        n += 1
        iid = f"{base}_{n}"
    taken.add(iid)
    return iid


def discover_roster(client, types, verbose=True):
    """Reconcile config/roster.json against the type tags on PixelLab.
    Returns (roster_entries, report)."""
    tags = [t["tag"] for t in types["types"].values()]
    tagged = client.tagged_items(tags)
    tagged_ids = {t["id"] for t in tagged}
    prev = load_roster()
    prev_by_pid = {e["pixellab_id"]: e for e in prev}

    kept, added, dropped, flagged = [], [], [], []
    taken = {e["id"] for e in prev}
    for t in tagged:
        pid = t["id"]
        if t["type_conflict"]:
            flagged.append(f"{pid}: tagged with SEVERAL item types {t['type_conflict']} "
                           f"— fix the tags on PixelLab (skipped)")
            tagged_ids.discard(pid)
            continue
        if pid in prev_by_pid:
            e = dict(prev_by_pid[pid])
            if e.get("type") != t["type"]:
                flagged.append(f"{e['id']}: type changed {e.get('type')} -> {t['type']} "
                               f"(tag edited on PixelLab)")
            e["type"] = t["type"]
            kept.append(e)
            continue
        entry = {
            "id": _unique_id(f"{t['type'].lower()}_{pid[:8]}", taken),
            "pixellab_id": pid,
            "type": t["type"],
            "name": None,
            "category": None,
            "rarity": "common",
            "value": None,
            "description": "",
            "needs_review": True,
        }
        if t["type"] == "SOUL":
            entry["power"] = ""
        added.append(entry)
        flagged.append(f"{entry['id']}: NEW {t['type']} item — look at the sprite, then "
                       f"give it a name/category/value in config/roster.json")
    for pid, e in prev_by_pid.items():
        if pid not in tagged_ids:
            dropped.append(e["id"])

    roster = kept + added
    if verbose:
        print(f"discover: {len(tagged)} tagged on PixelLab | kept {len(kept)}, "
              f"new {len(added)}, dropped {len(dropped)}")
        for e in added:
            print(f"  NEW {e['id']} <- {e['type']} {e['pixellab_id']}")
        for d in dropped:
            print(f"  DROP {d} (tag removed / deleted on PixelLab)")
        for f in flagged:
            print(f"  !! {f}")
    return roster, {"added": [e["id"] for e in added], "dropped": dropped, "flagged": flagged}


# --- the rolled-up registry ---------------------------------------------------

def build_viewer_data(metas, types):
    """items/viewer_data.json — one index of every item. This is what the game
    loads and what wiki/build.mjs picks up (it reads `.items`, using each
    entry's id/name/description/path/preview)."""
    entries = []
    for m in sorted(metas, key=lambda x: (x["type"], x["id"])):
        e = {
            "id": m["id"],
            "name": m["name"],
            "type": m["type"],
            "category": m.get("category"),
            "rarity": m.get("rarity"),
            "value": m.get("value"),
            "stackable": m.get("stackable"),
            "max_stack": m.get("max_stack"),
            "equip_slot": m.get("equip_slot"),
            "description": m.get("description") or "",
            "review": m.get("review") or {"status": "unreviewed"},
            "waiting_for": m.get("waiting_for"),
            "path": f"items/{m['id']}",
            "preview": m["sprite"],
            "sprite": m["sprite"],
            "size": m.get("size"),
        }
        if m.get("soul"):
            e["soul"] = m["soul"]
        entries.append(e)
    counts = {}
    for e in entries:
        counts[e["type"]] = counts.get(e["type"], 0) + 1
    doc = {
        "_comment": "Rolled-up registry of every item — GENERATED by "
                    "items/pipeline/sync.py from the per-item items/<id>/item.json "
                    "manifests. Read this one file to load the whole catalog; paths "
                    "are repo-relative. Do not hand-edit (edit config/roster.json).",
        "generated_at": now_iso(),
        "counts": counts,
        "types": types["types"],
        "rarities": types["rarities"],
        "items": entries,
    }
    # Keep a no-op sync an EMPTY diff: only restamp generated_at when the
    # catalog itself moved.
    try:
        with open(VIEWER) as f:
            prev = json.load(f)
        if {k: v for k, v in prev.items() if k != "generated_at"} == \
                {k: v for k, v in doc.items() if k != "generated_at"}:
            return prev
    except (OSError, ValueError):
        pass
    with open(VIEWER, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    return doc


# --- verify -------------------------------------------------------------------

def verify(metas, types):
    problems = []
    by_name, by_id = {}, {}
    for m in metas:
        iid = m["id"]
        by_id.setdefault(iid, []).append(iid)
        name = (m.get("name") or "").strip()
        shared = (types["types"].get(m["type"]) or {}).get("shared_name")
        if not name:
            problems.append(f"{iid}: no name — name it in config/roster.json")
        elif len(name) > NAME_MAX:
            problems.append(f"{iid}: name {name!r} is {len(name)} chars (max {NAME_MAX})")
        # A type with a shared_name gives every item THAT name on purpose (all
        # soul stones are "Soulstone"); everyone else must be unique.
        if shared:
            if name != shared:
                problems.append(f"{iid}: {m['type']} items are all named {shared!r}, not {name!r}")
        elif name:
            by_name.setdefault(name.lower(), []).append(iid)
        if not os.path.exists(os.path.join(item_dir(iid), "sprite.png")):
            problems.append(f"{iid}: sprite.png missing")
        if m.get("rarity") not in types["rarities"]:
            problems.append(f"{iid}: unknown rarity {m.get('rarity')!r}")
        v = m.get("value")
        if not isinstance(v, int) or v <= 0:
            problems.append(f"{iid}: value {v!r} is not a positive integer")
        elif m.get("rarity") in types["rarities"]:
            lo, hi = types["rarities"][m["rarity"]]["sell_band"]
            if not (lo <= v <= hi):
                problems.append(f"{iid}: value {v} is outside the {m['rarity']} band {lo}-{hi}")
        if not (m.get("description") or "").strip():
            problems.append(f"{iid}: no description")
        if not m.get("category"):
            problems.append(f"{iid}: no category")
        if m["type"] == "SOUL" and not ((m.get("soul") or {}).get("power") or "").strip():
            problems.append(f"{iid}: SOUL item without a `power` — what does merging it grant?")
    for name, ids in by_name.items():
        if len(ids) > 1:
            problems.append(f"duplicate name {name!r} on {ids}")
    return problems


# --- orchestration ------------------------------------------------------------

def sync(client, fresh=False, dry_run=False, only=None, use_feedback=True):
    types = load_types()
    # The maintainer's verdicts come first: a rejected item must not be
    # re-mirrored by the very run that is supposed to remove it.
    if use_feedback:
        feedback.ingest(dry_run=dry_run)
    roster, report = discover_roster(client, types)
    if not roster:
        raise SystemExit("discovery returned NO tagged items — refusing to prune "
                         "everything (is the API reachable / are the tags right?)")
    if not dry_run:
        write_roster(roster)
    # Rejected on the wiki: the entry stays in the roster (so a resync cannot
    # quietly resurrect it) but the item leaves the game — no folder, no
    # registry entry, no drops.
    rejected = feedback.rejected_ids(roster)
    if rejected:
        print(f"rejected on the wiki, staying out of the game: {sorted(rejected)} "
              f"(untag them on PixelLab to drop them for good)")
    roster = [e for e in roster if e["id"] not in rejected]
    want = {e["id"] for e in roster}

    pruned = []
    for iid, _meta in iter_manifests():
        if iid not in want:
            pruned.append(iid)
            print(f"PRUNE {iid} — " + ("rejected on the wiki" if iid in rejected
                                       else "no longer tagged on PixelLab"))
            if not dry_run:
                shutil.rmtree(item_dir(iid), ignore_errors=True)

    if dry_run:
        print(f"\n(dry run: would mirror {len(roster)} items, nothing written)")
        return {"pruned": pruned, **report}

    todo = [e for e in roster if not only or e["id"] == only]
    details = dict(zip([e["pixellab_id"] for e in todo],
                       client.get_objects([e["pixellab_id"] for e in todo])))
    metas, updated = [], []
    for e in roster:
        if only and e["id"] != only:
            existing = read_manifest(e["id"])
            if existing:
                metas.append(existing)
            continue
        meta, changed = mirror.mirror(client, e, detail=details[e["pixellab_id"]],
                                      types=types, fresh=fresh)
        metas.append(meta)
        if changed:
            updated.append(e["id"])
        print(f"  {'updated' if changed else 'unchanged'}  {e['id']:<28} "
              f"{e['type']:<6} {meta.get('name')}")

    build_viewer_data(metas, types)
    problems = verify(metas, types)

    print("\n=== sync summary ===")
    print(f"  roster: {len(roster)} | new: {report['added']} | dropped: {report['dropped']} "
          f"| pruned folders: {pruned} | mirrored/changed: {len(updated)}")
    if problems:
        print("  WARNINGS:")
        for p in problems:
            print(f"    !! {p}")
    else:
        print("  every item has a sprite, a name, a value and a description.")
    return {"pruned": pruned, "updated": updated, "problems": problems, **report}


def main():
    ap = argparse.ArgumentParser(description="Reconcile items/ against the PixelLab type tags.")
    ap.add_argument("--fresh", action="store_true", help="re-download every sprite")
    ap.add_argument("--dry-run", action="store_true", help="print the plan; change nothing")
    ap.add_argument("--only", help="mirror just this item id (others keep current files)")
    ap.add_argument("--no-feedback", action="store_true",
                    help="skip reading live/feedback/items.json (the wiki's verdicts)")
    args = ap.parse_args()
    sync(PixelLabClient(), fresh=args.fresh, dry_run=args.dry_run, only=args.only,
         use_feedback=not args.no_feedback)


if __name__ == "__main__":
    main()
