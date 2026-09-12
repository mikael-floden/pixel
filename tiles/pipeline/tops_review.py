#!/usr/bin/env python3
"""Apply the maintainer's verdicts on TOP-ONLY tiles (tiles/tops: subtle + detail).

A rejected top tile leaves the library: its raw tile and every post generation are
removed from git, the sheet's meta.json and tiles/tops/index.json stop listing it, and
tiles/tops/removed.json remembers the removal (maintainer 2026-09-11: "remove tiles I
have rejected everywhere and is not good enough for anything and never referenced").

WHAT IS NOT REMOVED. A rejected tile that something still draws stays, and is reported:
a member of live/tuning/base_tile_sets.json, a tiles/resolve.json entry, a plates
member, a games2 test fixture. His base set is his configuration; a verdict does not
edit another agent's file. The wiki hides a rejected tile from every picker on its own.

WHY A DURABLE RECORD (mirrors tiles/fades/removed.json). The wiki prunes a feedback
entry once the tile leaves the index, so the feedback file alone forgets a removal, and
tops.py / details.py would re-buy a sheet whose tiles no longer match its meta. The
sheet's meta.json therefore shrinks with the removal, and a sheet whose EVERY tile was
rejected keeps its meta.json (n_tiles 0, `removed` listing them) as a tombstone so the
same seed is never bought again. Bringing a tile back is a deliberate act: an explicit
non-rejected verdict clears the record here, and the art is restored from git history.

    python3 tiles/pipeline/tops_review.py                 # what the verdicts would do
    python3 tiles/pipeline/tops_review.py --apply         # do it (git rm + index edits)
    python3 tiles/pipeline/tops_review.py --ground grass  # one ground
"""
from __future__ import annotations

import argparse
import datetime
import glob
import json
import os
import re
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
TOPS = os.path.join(ROOT, "tops")
INDEX = os.path.join(TOPS, "index.json")
REMOVED = os.path.join(TOPS, "removed.json")
FEEDBACK = os.path.join(REPO, "live", "feedback", "tiles.json")

# Files whose mention of a tile means something DRAWS it. Verdict records
# (tile_walls, top_walls faces, the feedback file) are not references.
REFERENCE_FILES = [
    os.path.join(REPO, "live", "tuning", "base_tile_sets.json"),
    os.path.join(ROOT, "resolve.json"),
    os.path.join(ROOT, "plates", "index.json"),
    os.path.join(ROOT, "ground_types.json"),      # his promoted base tile per ground
] + sorted(glob.glob(os.path.join(REPO, "games2", "server", "test", "fixtures", "*.json")))


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _load(p, default):
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def _dump(p, doc, indent=2):
    tmp = f"{p}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=indent)
        f.write("\n")
    os.replace(tmp, p)


def verdicts():
    """key (`<sheet dir>/tile_NN.webp`) -> status, from the `#top` face."""
    out = {}
    for k, v in (_load(FEEDBACK, {}).get("entries") or {}).items():
        if k.startswith("tiles/tops/") and isinstance(v, dict) and v.get("status"):
            out[k.split("#")[0]] = v["status"]
    return out


def reference_text():
    return "".join(open(p, errors="ignore").read() for p in REFERENCE_FILES if os.path.isfile(p))


def plan(ground=None):
    idx = _load(INDEX, {"sheets": []})
    fb = verdicts()
    tomb = set(_load(REMOVED, {}).get("keys") or [])
    refs = reference_text()
    remove, keep, revive = [], [], []
    for sh in idx["sheets"]:
        if ground and sh.get("ground") != ground:
            continue
        posts = sh.get("post_files") or [None] * len(sh["tiles"])
        for name, pf in zip(sh["tiles"], posts):
            key = f"{sh['dir']}/{name}"
            st = fb.get(key)
            if st == "rejected" or (st is None and key in tomb):
                named = [key] + ([f"{sh['dir']}/post/{pf}"] if pf else [])
                hit = [n for n in named if n in refs]
                (keep if hit else remove).append((sh, name, pf, hit))
            elif st and key in tomb:
                revive.append(key)
    return idx, remove, keep, revive, tomb


def apply(idx, remove, revive, tomb):
    by_sheet = {}
    for sh, name, pf, _ in remove:
        by_sheet.setdefault(sh["dir"], []).append(name)
    paths = []
    for d, names in by_sheet.items():
        sheet = next(s for s in idx["sheets"] if s["dir"] == d)
        posts = sheet.get("post_files") or [None] * len(sheet["tiles"])
        post_by = dict(zip(sheet["tiles"], posts))
        for n in names:
            paths.append(os.path.join(REPO, d, n))
            paths += glob.glob(os.path.join(REPO, d, "post", n.replace(".webp", ".*.webp")))
        gone = set(names)
        sheet["tiles"] = [t for t in sheet["tiles"] if t not in gone]
        sheet["post_files"] = [post_by[t] for t in sheet["tiles"]] if sheet.get("post_files") else sheet.get("post_files")
        sheet["n_tiles"] = len(sheet["tiles"])
        if sheet.get("misfit_tiles"):
            sheet["misfit_tiles"] = {k: v for k, v in sheet["misfit_tiles"].items() if k not in gone}
            if not sheet["misfit_tiles"]:
                sheet.pop("misfit_tiles")
        # the sheet's own record shrinks with it, so tops.is_complete() stays true and
        # the generator never re-buys this seed
        mp = os.path.join(REPO, d, "meta.json")
        meta = _load(mp, None)
        if meta is not None:
            meta["tiles"] = [t for t in meta.get("tiles", []) if t not in gone]
            meta["n_tiles"] = len(meta["tiles"])
            rem = meta.setdefault("removed", {})
            for n in names:
                rem[n] = {"status": "rejected", "at": _now(), "record": "tiles/tops/removed.json"}
            _dump(mp, meta)
    # sheets with nothing left are tombstones on disk (meta.json only), not listings
    idx["sheets"] = [s for s in idx["sheets"] if s["tiles"]]
    counts = {}
    for s in idx["sheets"]:
        counts.setdefault(s["ground"], {"subtle": 0, "detail": 0})[s["flavour"]] += 1
    idx["counts"] = counts
    idx["n_sheets"] = len(idx["sheets"])
    idx["n_tiles"] = sum(len(s["tiles"]) for s in idx["sheets"])
    _dump(INDEX, idx, indent=1)     # tops_post.py's indent, so a rewrite is a real diff
    existing = [p for p in paths if os.path.isfile(p)]
    if existing:
        spec = os.path.join(TOPS, f"rm.{os.getpid()}.txt")
        with open(spec, "w") as f:
            f.write("\n".join(os.path.relpath(p, REPO) for p in existing) + "\n")
        subprocess.run(["git", "rm", "-q", "--pathspec-from-file", spec], cwd=REPO, check=True)
        os.remove(spec)
    tomb = (tomb | {f"{sh['dir']}/{n}" for sh, n, _, _ in remove}) - set(revive)
    _dump(REMOVED, {
        "schema": "tiles3/top-removals@1",
        "_comment": [
            "TOP-ONLY TILES THE MAINTAINER REJECTED - the durable record.",
            "The wiki prunes a feedback entry once the tile leaves index.json, so this",
            "file is what keeps a removal decided. The art is deleted from git; an",
            "explicit non-rejected verdict in live/feedback/tiles.json clears an entry",
            "here and the tile is restored from git history by hand. Absence never revives.",
        ],
        "n_removed": len(tomb),
        "keys": sorted(tomb),
    })
    return len(existing)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--ground")
    a = ap.parse_args()
    idx, remove, keep, revive, tomb = plan(a.ground)
    sheets = {sh["dir"] for sh, *_ in remove}
    emptied = [d for d in sheets if all(t in {n for s, n, _, _ in remove if s["dir"] == d}
                                        for t in next(s for s in idx["sheets"] if s["dir"] == d)["tiles"])]
    print(f"rejected top tiles: {len(remove)} to remove across {len(sheets)} sheets "
          f"({len(emptied)} sheets lose every tile), {len(keep)} kept because something draws them")
    for sh, name, pf, hit in keep:
        who = sorted({os.path.relpath(p, REPO) for p in REFERENCE_FILES
                      if os.path.isfile(p) and any(h in open(p, errors="ignore").read() for h in hit)})
        print(f"   KEEP {sh['dir']}/{name}  <- {', '.join(who)}")
    if revive:
        print(f"{len(revive)} removed tile(s) now carry a non-rejected verdict; the record clears, restore the art from git by hand:")
        for k in revive:
            print(f"   REVIVE {k}")
    if not a.apply:
        print("(dry run - pass --apply)")
        return 0
    n = apply(idx, remove, revive, tomb)
    total = len((tomb | {sh["dir"] + "/" + nm for sh, nm, _, _ in remove}) - set(revive))
    print(f"git rm {n} file(s); index and meta updated; removed.json has {total} keys")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
