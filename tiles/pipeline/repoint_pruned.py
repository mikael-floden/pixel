#!/usr/bin/env python3
"""Repoint dangling hashed post references at the CURRENT published name.

A published detail/top tile is content-addressed (`post/tile_NN.<sha8>.webp`) and
only the current generation plus one back is retained. A consumer that PINS a
hash therefore rots the moment that tile is republished twice - the file it names
is pruned, `ship-tiles3 --check` fails, and the deploy goes red for every agent
(measured 2026-09-04: 13 pinned names across 4 detail sheets, five red deploys).

The law this restores: consumers read the current name from the index
(`tiles/tops/index.json` -> `sheets[].post_files`, ordered by tile index); they
never carry a hash of their own. `--check` fails on any dangling reference and is
what the publish gates on.
"""
import argparse, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOPS_INDEX = "tiles/tops/index.json"
# Every consumer that may name a hashed post file. tiles/ and live/ are ours;
# the games2 fixtures are the game agent's and are only reported, never written.
CONSUMERS = ["tiles/resolve.json", "live/tuning/base_tile_sets.json", "coordination/tiles.json"]
REPORT_ONLY = ["games2/server/test/fixtures/tiles3-parity.json",
               "games2/server/test/fixtures/tiles3draw-parity.json"]

REF = re.compile(r'(tiles/tops/[A-Za-z0-9_]+/sheet_[A-Za-z0-9_]+)/post/tile_(\d+)\.([0-9a-f]{8})\.webp')


def current_names():
    """dir -> {tile_index: 'tile_NN.<sha8>.webp'} for the current generation."""
    idx = json.load(open(os.path.join(ROOT, TOPS_INDEX)))
    out = {}
    for sheet in idx.get("sheets", []):
        files = sheet.get("post_files") or []
        by_i = {}
        for name in files:
            m = re.match(r'tile_(\d+)\.[0-9a-f]{8}\.webp$', name)
            if m:
                by_i[int(m.group(1))] = name
        if by_i:
            out[sheet["dir"]] = by_i
    return out


def scan(path):
    """Every hashed reference in the file that no longer exists on disk."""
    text = open(os.path.join(ROOT, path)).read()
    dangling = []
    for m in REF.finditer(text):
        if not os.path.exists(os.path.join(ROOT, m.group(0))):
            dangling.append(m)
    return text, dangling


def repoint(path, cur, write):
    text, dangling = scan(path)
    if not dangling:
        return 0, 0
    fixed, unresolved = {}, []
    for m in dangling:
        sheet_dir, i = m.group(1), int(m.group(2))
        name = cur.get(sheet_dir, {}).get(i)
        if not name or not os.path.exists(os.path.join(ROOT, sheet_dir, "post", name)):
            unresolved.append(m.group(0))
            continue
        fixed[m.group(0)] = f"{sheet_dir}/post/{name}"
    for old, new in fixed.items():
        text = text.replace(old, new)
    if write and fixed:
        json.loads(text)  # never write a file we just broke
        with open(os.path.join(ROOT, path), "w") as fh:
            fh.write(text)
    for old, new in sorted(fixed.items()):
        print(f"  {old}\n    -> {os.path.basename(new)}")
    for u in unresolved:
        print(f"  UNRESOLVED (no current generation): {u}", file=sys.stderr)
    return len(fixed), len(unresolved)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if any consumer names a pruned file; write nothing")
    ap.add_argument("--write", action="store_true", help="repoint in place")
    a = ap.parse_args()
    cur = current_names()
    total_fixed = total_bad = 0
    for path in CONSUMERS + REPORT_ONLY:
        if not os.path.exists(os.path.join(ROOT, path)):
            continue
        _, dangling = scan(path)
        if not dangling:
            continue
        report_only = path in REPORT_ONLY
        print(f"{path}: {len(dangling)} dangling"
              + (" (not ours - reported only)" if report_only else ""))
        if a.check or report_only:
            for m in dangling:
                print(f"  {m.group(0)}")
            total_bad += len(dangling)
            continue
        f, u = repoint(path, cur, a.write)
        total_fixed += f
        total_bad += u
    if a.check:
        print(f"[repoint] {total_bad} dangling reference(s)")
        return 1 if total_bad else 0
    print(f"[repoint] repointed {total_fixed}, unresolved {total_bad}"
          + ("" if a.write else "  (dry run - pass --write)"))
    return 1 if total_bad else 0


if __name__ == "__main__":
    sys.exit(main())
