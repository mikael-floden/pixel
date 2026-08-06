"""Does maps2 need to re-export anything? — the drift catcher.

Answers, in one command, the question that comes up every time another domain
changes its art: *"tiles2 updated some tiles — do you need to do anything to get
them into the game?"*

    python maps2/pipeline/verify.py            # report
    python maps2/pipeline/verify.py --fix      # ...and repair what is safe to
                                               # repair without regenerating

The answer depends entirely on WHAT changed, and the three cases are very
different:

  1. PIXELS CHANGED, PATH DID NOT — nothing to do. world.json bakes literal tile
     paths and the game renders whatever bytes are at them, so a repaint reaches
     players on the next deploy with no action from maps2. (tiles2's 2026-08-06
     fire-colour fix was exactly this.)

  2. PATHS MOVED — a reroll makes a new sheet hash, so the baked path is dead
     and the tile 404s in the deployed game. THIS is the case that needs a
     re-export, and it is the one tiles2 asked me to detect automatically:
     "please add the --verify mode to your build that flags any world whose
     referenced tiles have gone missing".

  3. DERIVED DATA WENT STALE — world.json also bakes things COMPUTED from
     tiles2 (today: `emissive`, from tiles2/emission.json). Those drift with no
     missing file to give it away. They are pure functions of the path table, so
     --fix rewrites them in place: no regeneration, no terrain change.

Also checks the analysis cache, which is a foot-gun of its own: it stores tile
paths AND pixel-derived numbers, so it has to invalidate on a repaint as well as
on a rename (see tiles2lib._signature — it has been wrong in both directions).
"""

from __future__ import annotations

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
WORLDS = os.path.join(MAPS2, "worlds")


def worlds():
    return [n for n in sorted(os.listdir(WORLDS))
            if os.path.isfile(os.path.join(WORLDS, n, "world.json"))]


def emission_sources():
    try:
        return set(json.load(open(os.path.join(REPO, "tiles2", "emission.json")))
                   .get("sources", {}))
    except Exception:
        return None


def check_paths():
    """CASE 2 — a baked tile path that no longer exists on disk. Needs a re-export."""
    print("tile paths (baked in world.json) still on disk:")
    bad = 0
    for name in worlds():
        doc = json.load(open(os.path.join(WORLDS, name, "world.json")))
        miss = [p for p in doc["paths"] if not os.path.isfile(os.path.join(REPO, p))]
        if miss:
            bad += len(miss)
            print(f"  {name}: {len(miss)}/{len(doc['paths'])} MISSING — RE-EXPORT NEEDED")
            for p in miss[:3]:
                print(f"      {p}")
        else:
            print(f"  {name}: {len(doc['paths'])} ok")
    return bad


def check_emissive(fix=False):
    """CASE 3 — `emissive` is derived from tiles2/emission.json and drifts silently.

    NOTE it is currently baked for nobody: the game reads tiles2/emission.json
    itself (WorldScene.tiles2Src, keyed by tile path) and nothing in games2
    reads world.emissive. Kept correct anyway — a stale field that happens to
    have no consumer is a trap for the first one that arrives."""
    src = emission_sources()
    if src is None:
        print("emissive: tiles2/emission.json unreadable — skipped")
        return 0
    print(f"emissive rows vs tiles2/emission.json ({len(src)} sources):")
    stale_total = 0
    for name in worlds():
        wpath = os.path.join(WORLDS, name, "world.json")
        doc = json.load(open(wpath))
        want = [1 if p in src else 0 for p in doc["paths"]]
        stale = sum(1 for a, b in zip(doc.get("emissive", []), want) if a != b)
        stale_total += stale
        if stale:
            print(f"  {name}: {stale}/{len(want)} stale" + ("  -> rewritten" if fix else ""))
            if fix:
                doc["emissive"] = want
                with open(wpath, "w") as f:
                    json.dump(doc, f, separators=(",", ":"))
        else:
            print(f"  {name}: ok")
    return stale_total


def check_cache():
    """The analysis cache must invalidate on a REPAINT, not just on a rename."""
    from tiles2lib import CACHE, Tiles2
    if not os.path.isfile(CACHE):
        print("analysis cache: absent (will be built on next use) — ok")
        return 0
    have = json.load(open(CACHE)).get("sig")
    want = Tiles2()._signature()
    if have == want:
        print("analysis cache: fresh")
        return 0
    print("analysis cache: STALE — rebuilding on next Tiles2() (that is automatic)")
    return 0


def main():
    fix = "--fix" in sys.argv
    missing = check_paths()
    print()
    stale = check_emissive(fix)
    print()
    check_cache()
    print()
    if missing:
        print(f"VERDICT: {missing} missing tile path(s) — RE-EXPORT the affected worlds "
              f"(python maps2/pipeline/build.py <world>).")
    elif stale and not fix:
        print(f"VERDICT: paths all resolve, but {stale} derived `emissive` row(s) are "
              f"stale. Re-run with --fix (rewrites in place, no regeneration).")
    elif stale and fix:
        print(f"VERDICT: repaired {stale} derived `emissive` row(s) in place. "
              f"No regeneration, terrain untouched.")
    else:
        print("VERDICT: nothing to do — every baked path resolves and every derived "
              "field is current. New tile ART reaches the game on the next deploy "
              "with no maps2 action.")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
