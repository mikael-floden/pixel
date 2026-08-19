"""Clear verdicts whose subject no longer exists.

Maintainer, 2026-08-19: "Please process and leave no 'ghost state' behind."

A verdict is about a picture. Delete the picture — because he rejected it — and
the verdict describes nothing. It is not a record worth keeping: the wiki still
renders a chip for it, coloured by a status, and clicking it shows an empty
frame. That is what he reported as "some states are red... when I click on it I
can't see anything", and it is the single most confusing thing the review
surface can do, because a red chip is indistinguishable from art he still needs
to act on.

This is deliberately NOT the same test as consume_verdicts. That one clears a
verdict whose art was REPLACED (hash mismatch) — the art is still there and
needs re-judging. This one clears a verdict whose art is GONE. Different cause,
different remedy, and conflating them is how a "stale" test ends up deleting
verdicts on live art.

Safety: only keys whose piece is absent from disk, or whose named state is
absent from a piece that IS on disk. STATIC and BASE are the wiki's own
pseudo-states for a piece with no states map and are never treated as missing.

live/feedback/objects.json belongs to the live server as single writer, so the
file is rewritten byte-identically apart from the removed entries.

    python3 pipeline/ghosts.py --dry-run
    python3 pipeline/ghosts.py
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import factory

FEEDBACK = os.path.join(os.path.dirname(factory.ROOT), "live", "feedback",
                        "objects.json")
PSEUDO = {"STATIC", "BASE"}


def ghosts(entries, manifests=None):
    man = manifests if manifests is not None else {r: m for r, m in factory.discover()}
    out = []
    for key in entries:
        if not key.startswith("scenery/"):
            continue
        body = key[len("scenery/"):]
        rel = body.split("#")[0]
        m = man.get(rel)
        if m is None:
            out.append(key)                       # the piece itself is gone
            continue
        if "#" not in body:
            continue
        state = body.split("#")[1].upper()
        if state in PSEUDO:
            continue
        if state not in {s.upper() for s in (m.get("states") or {})}:
            out.append(key)                       # the state is gone
    return out


def sweep(dry=False):
    doc = json.load(open(FEEDBACK, encoding="utf-8"),
                    object_pairs_hook=collections.OrderedDict)
    entries = doc["entries"]
    hits = ghosts(entries)
    kinds = collections.Counter(entries[k].get("status") for k in hits)
    print(f"{len(hits)} ghost verdict(s) — the art they judge no longer exists")
    print("  ", dict(kinds))
    if dry or not hits:
        for k in hits[:10]:
            print("   ", k.replace("scenery/", ""), entries[k].get("status"))
        return 0
    for k in hits:
        entries.pop(k, None)
    doc["entries"] = entries
    with open(FEEDBACK, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"cleared {len(hits)} — no dead chips left in his queue")
    return len(hits)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    sweep(a.dry_run)
