"""The maintainer's verdicts on items — `live/feedback/items.json`.

Everything an agent makes starts **unreviewed**, and that is the normal state of
the repo: content is generated continuously and only becomes *approved* when the
maintainer says so, signed in on the wiki. `live/feedback/items.json` is that
channel (`pixel-wiki-feedback@1`): per asset id a star `rating` (1-5), a
`status` (`approved` / `rejected`) and an optional `note`, written by the wiki
and pushed to `main` in seconds.

Per `live/README.md` every art agent MUST read its own feedback file at the
start of each run and act on it. For items that means:

  - **rejected** → the item stops being part of the game: its folder is pruned,
    it leaves `viewer_data.json`, and any loot row pointing at it is removed
    from `live/tuning/monsters.json`. The roster keeps the entry with
    `review.status = "rejected"` so a resync cannot quietly resurrect it —
    untag it on PixelLab to drop it for good;
  - **approved** → recorded as `review.status = "approved"` on the item, so the
    game and the wiki can tell a keeper from something nobody has looked at yet;
  - **rating / note** → recorded on the item; stars steer what gets made next.

Handled entries are then CLEARED from the live file (the contract: the wiki
writes verdicts, the agent consumes them), leaving the durable record in
`config/roster.json` where this domain owns it.

Usage:
  python items/pipeline/feedback.py             # ingest + report
  python items/pipeline/feedback.py --dry-run   # print what it would do
"""

from __future__ import annotations

import argparse
import datetime
import json
import os

from mirror import CONFIG_DIR, ROOT

REPO = os.path.dirname(ROOT)
FEEDBACK = os.path.join(REPO, "live", "feedback", "items.json")
LIVE_MONSTERS = os.path.join(REPO, "live", "tuning", "monsters.json")
ROSTER = os.path.join(CONFIG_DIR, "roster.json")


def _now():
    return datetime.datetime.now(datetime.timezone.utc) \
        .isoformat(timespec="milliseconds").replace("+00:00", "Z")


def load_feedback():
    try:
        with open(FEEDBACK) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"format": "pixel-wiki-feedback@1", "domain": "items",
                "updated_at": "", "entries": {}}


def write_feedback(doc, dry_run=False):
    doc["updated_at"] = _now()
    if dry_run:
        return
    with open(FEEDBACK, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")


def item_id_of(asset_id):
    """Feedback ids are repo paths: `items/<id>` for the whole item, and
    `items/<id>/<file>` for one file of it. Both resolve to the item."""
    parts = str(asset_id).strip("/").split("/")
    if len(parts) >= 2 and parts[0] == "items":
        return parts[1]
    return None


def strip_loot(item_ids, dry_run=False):
    """Remove every loot row pointing at these items from the live tuning file
    (a rejected item must not drop). Only `loot` is touched."""
    if not item_ids:
        return 0
    try:
        with open(LIVE_MONSTERS) as f:
            live = json.load(f)
    except (OSError, ValueError):
        return 0
    removed = 0
    for stats in (live.get("monsters") or {}).values():
        loot = stats.get("loot")
        if not loot:
            continue
        keep = [e for e in loot if e.get("item") not in item_ids]
        removed += len(loot) - len(keep)
        stats["loot"] = keep
    if removed and not dry_run:
        live["updated_at"] = _now()
        with open(LIVE_MONSTERS, "w") as f:
            json.dump(live, f, indent=2)
            f.write("\n")
    return removed


def ingest(dry_run=False, verbose=True):
    """Apply the wiki's verdicts to config/roster.json and clear the ones
    handled. Returns a report dict."""
    doc = load_feedback()
    entries = doc.get("entries") or {}
    with open(ROSTER) as f:
        roster_doc = json.load(f)
    by_id = {e["id"]: e for e in roster_doc["items"]}

    applied, unknown, rejected, approved = [], [], [], []
    for asset_id, entry in sorted(entries.items()):
        iid = item_id_of(asset_id)
        if iid is None or iid not in by_id:
            unknown.append(asset_id)
            continue
        review = {k: entry[k] for k in ("status", "rating", "note") if entry.get(k) not in (None, "")}
        if not review:
            applied.append(asset_id)  # cleared verdict: drop the entry, keep nothing
            by_id[iid].pop("review", None)
            continue
        review["at"] = entry.get("updated_at") or _now()
        by_id[iid]["review"] = review
        applied.append(asset_id)
        if review.get("status") == "rejected":
            rejected.append(iid)
        elif review.get("status") == "approved":
            approved.append(iid)

    if applied and not dry_run:
        for asset_id in applied:
            entries.pop(asset_id, None)
        doc["entries"] = entries
        write_feedback(doc)
        with open(ROSTER, "w") as f:
            json.dump(roster_doc, f, indent=2)
            f.write("\n")
    loot_rows = strip_loot(set(rejected), dry_run=dry_run)

    if verbose:
        if not entries and not applied:
            print("feedback: no verdicts waiting (everything is unreviewed — the default)")
        else:
            print(f"feedback: {len(applied)} verdict(s) handled | approved {approved or '-'} | "
                  f"rejected {rejected or '-'}")
            if loot_rows:
                print(f"  removed {loot_rows} loot row(s) for rejected items")
            for a in unknown:
                print(f"  !! verdict for {a!r} does not match any item — left in place")
    return {"applied": applied, "approved": approved, "rejected": rejected,
            "unknown": unknown, "loot_rows_removed": loot_rows}


def rejected_ids(roster_items):
    return {e["id"] for e in roster_items
            if (e.get("review") or {}).get("status") == "rejected"}


def main():
    ap = argparse.ArgumentParser(description="Apply the wiki's item verdicts (live/feedback/items.json).")
    ap.add_argument("--dry-run", action="store_true", help="print the plan; change nothing")
    args = ap.parse_args()
    ingest(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
