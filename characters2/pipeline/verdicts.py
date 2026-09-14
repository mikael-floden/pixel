"""Consume the maintainer's review verdicts (live/feedback/characters.json).

THE CONTRACT (live/README.md): each art agent reads its own feedback file at
the start of every run and acts on it — `rejected` → remove the asset, then
delete the handled entry.

WHY A REJECTION MUST BE RECORDED HERE AND NOT JUST ACTED ON: this domain's NPC
mirror is TAG-DRIVEN — the `NPC` tag on PixelLab is ground truth both ways, so
`sync.py` re-downloads every tagged character on every run. A rejected NPC is
usually still tagged (rejecting in the wiki does not touch PixelLab), so
deleting the folder alone would last exactly until the next sync. And the
contract says to delete the feedback entry once handled, which throws away the
only other memory of the verdict. So the verdict is written into
`metadata.json: rejected` — this domain's own durable store — and sync.py
treats that set as an exclusion list that OUTRANKS the tag. Untagging on
PixelLab afterwards is optional and changes nothing here.

NPCs ONLY. A verdict on one of the two pinned heroes is reported and LEFT in
the feedback file: the heroes are locked, the whole game addresses them, and no
review verdict should be able to delete one from a script.

    python3 characters2/pipeline/verdicts.py --dry-run
    python3 characters2/pipeline/verdicts.py
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # characters2/
REPO_ROOT = os.path.dirname(ROOT)
FEEDBACK = os.path.join(REPO_ROOT, "live", "feedback", "characters.json")
METADATA = os.path.join(ROOT, "metadata.json")
NPC_PREFIX = "characters2/npcs/"
HERO_PREFIX = "characters2/humans/"


def _read(path, default):
    if not os.path.exists(path):
        return default
    with open(path) as f:
        return json.load(f)


def load_metadata():
    return _read(METADATA, {"format": "characters2-metadata@1", "characters": {}})


def rejected_ids(meta=None):
    """Folder ids this domain must never mirror, whatever PixelLab's tags say."""
    meta = load_metadata() if meta is None else meta
    return set((meta.get("rejected") or {}).keys())


def _write_metadata(meta):
    with open(METADATA, "w") as f:
        json.dump(meta, f, indent=1, ensure_ascii=False)
        f.write("\n")


def _write_feedback(doc):
    """The live server is this file's other writer, so rewrite it in its own
    shape (indent 2, ensure_ascii off) and touch nothing but the entries."""
    with open(FEEDBACK, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")


def ingest(dry_run=False, verbose=True):
    """Apply every actionable verdict. Returns (newly_rejected, skipped_heroes).

    A rejected NPC is recorded in metadata.json `rejected` (carrying its
    authored name so the removal stays readable a year later) and its authored
    `characters` record is retired into that entry. Removing the ART is
    sync.py's job — it prunes any folder in the rejected set."""
    doc = _read(FEEDBACK, None)
    if not doc:
        if verbose:
            print(f"no feedback at {FEEDBACK}")
        return [], []
    entries = doc.get("entries") or {}
    meta = load_metadata()
    meta.setdefault("rejected", {})
    chars = meta.setdefault("characters", {})

    new, heroes, handled = [], [], []
    for key, entry in sorted(entries.items()):
        if (entry or {}).get("status") != "rejected":
            continue                        # approvals/stars steer taste, not files
        if key.startswith(HERO_PREFIX):
            heroes.append(key)
            continue                        # never script-delete a locked hero
        if not key.startswith(NPC_PREFIX):
            continue                        # not addressed to this mirror
        folder = key[len(NPC_PREFIX):].split("/")[0]
        handled.append(key)
        if folder in meta["rejected"]:
            continue                        # already recorded; just clear the entry
        was = chars.pop(folder, {}) or {}
        meta["rejected"][folder] = {
            "rejected_at": entry.get("updated_at") or datetime.now(timezone.utc)
                                                             .isoformat(timespec="seconds"),
            "display_name": was.get("display_name"),
            "note": "rejected in the wiki review; never mirrored again even while "
                    "the PixelLab NPC tag is still on (verdicts.py)",
            "was": was or None,
        }
        new.append(folder)

    if not dry_run and (new or handled):
        meta["rejected"] = dict(sorted(meta["rejected"].items()))
        _write_metadata(meta)
        for key in handled:
            entries.pop(key, None)          # contract: clear the handled entry
        doc["entries"] = entries
        _write_feedback(doc)

    if verbose:
        for f in new:
            name = meta["rejected"][f].get("display_name") or "(unnamed)"
            print(f"  verdict: REJECTED {f} ({name}) — recorded; sync.py will prune it")
        for k in heroes:
            print(f"  ! verdict on a LOCKED HERO left for you: {k} rejected — "
                  f"heroes are pinned in config.json and are never removed by script")
        if not new and not heroes:
            print(f"  verdicts: nothing to act on ({len(entries)} entrie(s) in feedback)")
    return new, heroes


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    new, heroes = ingest(dry_run=args.dry_run)
    total = len(rejected_ids())
    print(f"{'(dry) ' if args.dry_run else ''}{len(new)} newly rejected, "
          f"{total} rejected in total, {len(heroes)} hero verdict(s) left for the maintainer")


if __name__ == "__main__":
    main()
