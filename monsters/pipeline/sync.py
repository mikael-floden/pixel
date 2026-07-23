"""Reconcile monsters/ against the authoritative roster (config/roster.json).

The roster is the source of truth for *which* monsters exist; PixelLab is the
source of truth for each monster's *art*. This tool makes the repo match both:

  - **mirror** every monster in the roster from PixelLab into monsters/<id>/
    (via mirror.py) — adding new ones and updating changed ones;
  - **re-point** a folder whose recorded pixellab_id no longer matches the
    roster (the maintainer replaced that monster) — the folder is wiped and
    re-mirrored fresh from the new id;
  - **prune** any monster folder NOT in the roster ("if it isn't listed, remove
    it"), so retiring a monster is just deleting its roster entry.

After mirroring, it checks each monster carries the roster's canonical animation
keys (jump/attack/die) across 8 directions and warns loudly otherwise.

Mirroring costs ZERO generations (download only). This tool does NOT commit —
the caller commits the reconciled tree (keeps history to one atomic change).

Usage:
  python monsters/pipeline/sync.py                 # incremental (skips unchanged frames)
  python monsters/pipeline/sync.py --fresh         # wipe each folder first, full re-download
  python monsters/pipeline/sync.py --dry-run       # report the plan, touch nothing
"""

from __future__ import annotations

import argparse
import json
import os
import shutil

import mirror
from mirror import ROOT, monster_dir, read_manifest, iter_manifests
from pixellab_client import PixelLabClient

CONFIG = os.path.join(ROOT, "config", "roster.json")


def load_roster():
    with open(CONFIG) as f:
        r = json.load(f)
    return r["monsters"], r.get("canonical_animations", ["jump", "attack", "die"])


def _verify(mid, meta, canonical):
    """Return a list of human-readable problems for one mirrored monster."""
    problems = []
    keys = set(meta.get("animations", {}))
    missing = [k for k in canonical if k not in keys]
    extra = [k for k in keys if k not in canonical]
    if missing:
        problems.append(f"missing animation(s): {missing}")
    if extra:
        problems.append(f"unexpected animation key(s): {extra} (fix renames in roster.json)")
    for key, a in meta.get("animations", {}).items():
        ndirs = len(a.get("directions", {}))
        if ndirs != 8:
            problems.append(f"{key}: {ndirs}/8 directions")
    return problems


def sync(client, fresh=False, dry_run=False):
    monsters, canonical = load_roster()
    want_ids = {m["id"] for m in monsters}
    added, updated, repointed, pruned, warned = [], [], [], [], []

    # 1) prune folders not in the roster ("if it isn't listed, remove it")
    for mid, meta in iter_manifests():
        if mid not in want_ids:
            pruned.append(mid)
            print(f"PRUNE {mid} (pixellab {meta.get('source', {}).get('pixellab_id')}) — not in roster")
            if not dry_run:
                shutil.rmtree(monster_dir(mid), ignore_errors=True)

    # 2) mirror every roster monster
    for m in monsters:
        mid, pid = m["id"], m["pixellab_id"]
        prev = read_manifest(mid)
        is_new = prev is None
        mismatch = (not is_new) and prev.get("source", {}).get("pixellab_id") != pid
        wipe = fresh or mismatch
        tag = "NEW" if is_new else ("RE-POINT" if mismatch else "update")
        print(f"\n{tag} {mid} <- {m['kind']} {pid}" + ("  (wipe+fresh)" if wipe and not is_new else ""))
        if dry_run:
            (added if is_new else repointed if mismatch else updated).append(mid)
            continue
        if wipe and os.path.isdir(monster_dir(mid)):
            shutil.rmtree(monster_dir(mid), ignore_errors=True)
        meta = mirror.mirror(client, mid, m["kind"], pid,
                             aliases=m.get("aliases"), name=m.get("name"),
                             renames=m.get("renames"))
        problems = _verify(mid, meta, canonical)
        if problems:
            warned.append((mid, problems))
            for p in problems:
                print(f"  !! {mid}: {p}")
        (added if is_new else repointed if mismatch else updated).append(mid)

    print("\n=== sync summary ===")
    print(f"  roster: {len(monsters)} monster(s)")
    print(f"  added:     {added}")
    print(f"  re-pointed:{repointed}")
    print(f"  updated:   {updated}")
    print(f"  pruned:    {pruned}")
    if warned:
        print("  WARNINGS:")
        for mid, ps in warned:
            print(f"    {mid}: {'; '.join(ps)}")
    else:
        print("  all monsters carry the canonical animations across 8 directions.")
    return {"added": added, "repointed": repointed, "updated": updated,
            "pruned": pruned, "warned": warned}


def main():
    ap = argparse.ArgumentParser(description="Reconcile monsters/ against config/roster.json.")
    ap.add_argument("--fresh", action="store_true",
                    help="wipe each monster folder before mirroring (full re-download)")
    ap.add_argument("--dry-run", action="store_true", help="report the plan; change nothing")
    args = ap.parse_args()
    client = PixelLabClient()
    sync(client, fresh=args.fresh, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
