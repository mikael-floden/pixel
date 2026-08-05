"""The item DROP MAPPING — which monster drops which item.

The mapping does NOT live in `items/`. It lives in **`live/tuning/monsters.json`**,
the game's live-update channel (`live/README.md`): each monster's entry carries a
`loot` array of `{"item": "<items/ folder id>", "chance": <fraction 0..1>}`. That
file is the one the maintainer edits from the wiki's monster page ("Loot / drops
— + add drop"), and the game server re-reads it from `main` and pushes it to every
connected client within seconds — no rebuild, no redeploy, no restart. Putting the
mapping anywhere under `items/` would need a deploy to take effect and could not
be edited from the wiki, so `items/` deliberately keeps **no copy**: one source of
truth, maintainer-owned.

THE ONE RULE THE DATA STRUCTURE CANNOT EXPRESS: a **Soulstone is a monster's
card** (the Ragnarök Online sense) and the binding is STRICTLY 1-to-1 in both
directions — one monster drops exactly one stone, one stone comes from exactly
one monster — so either page can show the other in a chip. `loot[]` is a plain
many-to-many list (correct for MISC, where one fang drops off every biter), so
the constraint is enforced HERE: `SOUL` declares `one_per_monster` in
`config/types.json` and `verify()` fails on any monster with two stones or any
stone with two sources. With more stones than monsters the surplus stays
UNBOUND — reported every run, waiting for a creature of its own — because
doubling up on a monster that already has a stone would break the mapping.

This tool is the items agent's side of that contract — it never regenerates the
file (it is durable maintainer state), it only:

  - **verifies** every `loot` entry against the item registry — unknown item ids,
    the 1-to-1 Soulstone binding (both directions, plus the unbound surplus),
    chances outside their band, monsters with an empty table, and any item that
    nothing drops WITHOUT a `waiting_for` note explaining which creature it is
    waiting for;
  - **applies** an assignment plan (`--apply plan.json`) by writing each monster's
    `loot` array, leaving every other field — stats, defaults, format — untouched;
  - **reports** the resulting loot tables (`--report`).

Usage:
  python items/pipeline/drops.py                 # verify (read-only)
  python items/pipeline/drops.py --report        # verify + print every table
  python items/pipeline/drops.py --apply plan.json [--dry-run]
"""

from __future__ import annotations

import argparse
import datetime
import json
import os

from mirror import ROOT, load_types

REPO = os.path.dirname(ROOT)
LIVE_MONSTERS = os.path.join(REPO, "live", "tuning", "monsters.json")
MONSTERS_DIR = os.path.join(REPO, "monsters")
VIEWER = os.path.join(ROOT, "viewer_data.json")

# Drop chance bands per rarity (fractions). Rarer loot drops less often; the
# wiki shows these as percentages.
CHANCE_BANDS = {
    "common": (0.15, 0.50),
    "uncommon": (0.06, 0.25),
    "rare": (0.015, 0.10),
    "epic": (0.004, 0.03),
    "legendary": (0.001, 0.01),
}


def load_live():
    with open(LIVE_MONSTERS) as f:
        return json.load(f)


def write_live(doc, dry_run=False):
    """Write live/tuning/monsters.json exactly as the game server would: 2-space
    JSON, trailing newline, `updated_at` restamped (the server adopts the NEWER
    of two docs by that field)."""
    doc["updated_at"] = datetime.datetime.now(datetime.timezone.utc) \
        .isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if dry_run:
        return doc
    with open(LIVE_MONSTERS, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    return doc


def load_items():
    with open(VIEWER) as f:
        return {it["id"]: it for it in json.load(f)["items"]}


def monster_names():
    """id -> display name, for readable reports (monsters/ is another agent's
    directory: read-only, and missing manifests are tolerated)."""
    out = {}
    try:
        for mid in sorted(os.listdir(MONSTERS_DIR)):
            p = os.path.join(MONSTERS_DIR, mid, "monster.json")
            if os.path.exists(p):
                with open(p) as f:
                    out[mid] = json.load(f).get("name") or mid
    except OSError:
        pass
    return out


# --- verify -------------------------------------------------------------------

def verify(live, items, types):
    problems, warnings = [], []
    dropped_by = {}
    # Types whose items bind 1-to-1 to a monster (SOUL: a stone is a creature's
    # card — one stone per monster, one monster per stone, both directions).
    exclusive = {t for t, d in types["types"].items() if d.get("one_per_monster")}
    per_monster = {}
    for mid, stats in sorted((live.get("monsters") or {}).items()):
        loot = stats.get("loot")
        if loot is None:
            warnings.append(f"{mid}: no loot key at all")
            continue
        if not loot:
            warnings.append(f"{mid}: empty loot table — nothing to farm here")
            continue
        seen = set()
        for entry in loot:
            iid = entry.get("item")
            chance = entry.get("chance")
            if not iid:
                problems.append(f"{mid}: loot row with no item id")
                continue
            if iid not in items:
                problems.append(f"{mid}: drops unknown item {iid!r}")
                continue
            if iid in seen:
                problems.append(f"{mid}: lists {iid} twice")
            seen.add(iid)
            dropped_by.setdefault(iid, []).append(mid)
            if items[iid]["type"] in exclusive:
                per_monster.setdefault(mid, []).append(iid)
            if not isinstance(chance, (int, float)) or not 0 < chance <= 1:
                problems.append(f"{mid}/{iid}: chance {chance!r} is not a fraction in (0, 1]")
                continue
            # A type may pin its own band (a soul stone is a rare signature
            # drop whatever its grade); otherwise the rarity decides.
            tdef = types["types"].get(items[iid]["type"]) or {}
            band = tdef.get("drop_chance_band")
            label = f"{items[iid]['type']} type" if band else items[iid].get("rarity")
            lo, hi = band or CHANCE_BANDS.get(items[iid].get("rarity"), (0.0, 1.0))
            if not lo <= chance <= hi:
                warnings.append(f"{mid}/{iid}: chance {chance:.3f} outside the "
                                f"{label} band {lo}-{hi}")
    # The 1-to-1 binding, both directions.
    for mid, iids in sorted(per_monster.items()):
        if len(iids) > 1:
            problems.append(f"{mid}: drops {len(iids)} soul stones {iids} — a monster "
                            f"is bound to exactly ONE stone (see types.json:one_per_monster)")
    unbound, waiting = [], []
    for iid, it in items.items():
        srcs = dropped_by.get(iid, [])
        if it["type"] in exclusive:
            if len(srcs) > 1:
                problems.append(f"{iid}: dropped by {len(srcs)} monsters {srcs} — a soul "
                                f"stone belongs to exactly ONE monster")
            elif not srcs:
                # Not an error: with more stones than monsters the surplus waits
                # for a creature that does not exist yet. It must never be
                # doubled up on a monster that already has one.
                unbound.append(iid)
        elif not srcs:
            # Not a defect: this repo makes art ahead of the world that uses
            # it, so an item whose creature does not exist yet simply waits.
            # It IS a defect to have no idea why nothing drops it.
            if it.get("waiting_for"):
                waiting.append((iid, it["waiting_for"]))
            else:
                warnings.append(f"{iid}: nothing drops it and no `waiting_for` says why — "
                                f"bind it to a creature it plausibly came off, or record "
                                f"what it is waiting for in config/roster.json")
    return problems, warnings, dropped_by, sorted(unbound), sorted(waiting)


# --- apply --------------------------------------------------------------------

def apply_plan(live, items, plan, dry_run=False):
    """Write the plan's assignments into each monster's `loot`. Only `loot` is
    touched; every other stat the maintainer tuned stays exactly as it is."""
    known = set((live.get("monsters") or {}).keys())
    tables, unknown = {}, []
    for a in plan["assignments"]:
        iid = a["item_id"]
        if iid not in items:
            unknown.append(f"unknown item {iid}")
            continue
        for d in a.get("drops") or []:
            mid = d["monster_id"]
            if mid not in known:
                unknown.append(f"{iid}: unknown monster {mid}")
                continue
            tables.setdefault(mid, []).append({"item": iid, "chance": round(float(d["chance"]), 4)})
    if unknown:
        raise SystemExit("plan does not match the repo:\n  " + "\n  ".join(unknown))
    # Stable, readable order: rarest-first reads like a loot table.
    rank = {"legendary": 0, "epic": 1, "rare": 2, "uncommon": 3, "common": 4}
    for mid, rows in tables.items():
        rows.sort(key=lambda r: (items[r["item"]]["type"] != "SOUL",
                                 rank.get(items[r["item"]]["rarity"], 9), r["item"]))
        live["monsters"][mid]["loot"] = rows
    for mid in known - set(tables):
        live["monsters"][mid].setdefault("loot", [])
    write_live(live, dry_run=dry_run)
    return tables


# --- report -------------------------------------------------------------------

def report(live, items, names):
    for mid, stats in sorted((live.get("monsters") or {}).items(),
                             key=lambda kv: kv[1].get("level", 0)):
        loot = stats.get("loot") or []
        print(f"\n{names.get(mid, mid)} ({mid}, lv{stats.get('level', '?')}) — {len(loot)} drops")
        for e in loot:
            it = items.get(e["item"], {})
            print(f"    {100 * e.get('chance', 0):6.2f}%  {it.get('name', '?'):<12} "
                  f"{it.get('type', '?'):<5} {it.get('rarity', '?'):<9} {e['item']}")


def main():
    ap = argparse.ArgumentParser(description="Verify / apply the item drop mapping in live/tuning/monsters.json.")
    ap.add_argument("--apply", metavar="PLAN", help="assignment plan JSON to write into the live file")
    ap.add_argument("--dry-run", action="store_true", help="with --apply: change nothing")
    ap.add_argument("--report", action="store_true", help="print every monster's loot table")
    args = ap.parse_args()

    live, items, types = load_live(), load_items(), load_types()
    if args.apply:
        with open(args.apply) as f:
            plan = json.load(f)
        tables = apply_plan(live, items, plan, dry_run=args.dry_run)
        print(f"applied: {sum(len(v) for v in tables.values())} drop rows across "
              f"{len(tables)} monsters{' (dry run)' if args.dry_run else ''}")

    problems, warnings, dropped_by, unbound, waiting = verify(live, items, types)
    if args.report:
        report(live, items, monster_names())
    print(f"\n=== drops ===\n  items: {len(items)} | dropped: {len(dropped_by)} | "
          f"monsters with loot: {sum(1 for s in live['monsters'].values() if s.get('loot'))}"
          f"/{len(live['monsters'])}")
    # Unbound is a normal resting state, not a defect: content is made ahead of
    # the world that uses it, so a stone simply waits for its creature.
    if unbound:
        print(f"  {len(unbound)} soul stone(s) unbound, waiting for a monster of their "
              f"own: {unbound}")
    if waiting:
        print(f"  {len(waiting)} item(s) waiting for the creature they were drawn for:")
        for iid, what in waiting:
            print(f"      {iid:<28} waits for {what}")
    for w in warnings:
        print(f"  ! {w}")
    for p in problems:
        print(f"  !! {p}")
    if problems:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
