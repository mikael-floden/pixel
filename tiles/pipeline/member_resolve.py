"""Publish base-tile-set member resolution AS DATA: `tiles/resolve.json`.

The bug this ends, reported by the game agent 2026-08-28 and by the maintainer before
that: a base-tile-set member string has TWO legal forms with two different resolutions,
and every consumer re-implements the choice.

    kind "plate"  tiles/<cell>/<key8>                    -> tiles/plates/<ground>/<key8>.webp
    kind "file"   tiles/tops/.../post/tile_NN.<sha8>.webp -> itself (also ballot files)

The wiki got it right, the map renderer applied the plate rule to a literal path, and
produced `tiles/plates/black_rock/tiles/tops/.../tile_05.d4c1d5e2.webp.webp` - which does
not exist, so 104 of 340 members silently fell back to the clean colour. Reproduced here
exactly. The strings are not the problem; a rule living in three codebases is, and the
game would have been the third to get it wrong.

So the resolution ships as a LOOKUP, not a rule. A consumer asks the map and never parses
the string:

    members["<member string>"] = { "kind": "plate"|"file", "art": "<repo-relative path>" }

Every entry is verified to exist on disk at publish time, so a hit can never 404.

WHY NOT ENUMERATE EVERYTHING: the full set of legal strings is 5,140 (3,700 plates +
1,440 tops/post), about 0.57 MB - too heavy for a file the game server reads live. The map
therefore covers what base_tile_sets.json actually references, and `forms` states the two
patterns precisely for anything minted since the last publish. A consumer that misses the
map should fall back to `forms` AND say so, because a miss means this file is stale and
wants regenerating - it does not mean the member is invalid.

`live/tuning/base_tile_sets.json` belongs to the wiki agent (one writer per file), so this
publishes beside it rather than editing it. If the wiki chooses to inline `kind` and `art`
onto each member, this file becomes redundant and should be retired rather than kept in
parallel - two sources for one fact is the shape of the original bug.
"""

from __future__ import annotations

import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
SETS = os.path.join(REPO, "live", "tuning", "base_tile_sets.json")
OUT = os.path.join(ROOT, "resolve.json")

KEY = re.compile(r"^tiles/([^/]+)/([0-9a-f]{8})$")


def resolve(member):
    """(kind, repo-relative art path) for one member string, or (None, reason)."""
    m = KEY.match(member)
    if m:
        cell, k8 = m.groups()
        ground = cell.split("__over__")[0]
        return "plate", f"tiles/plates/{ground}/{k8}.webp"
    if member.endswith(".webp"):
        # NOT "top": this bucket holds tops/post art AND base_candidates ballot files.
        # Naming it for one of them is how a consumer ends up special-casing the other.
        return "file", member
    return None, "unrecognised form"


def main():
    doc_sets = json.load(open(SETS))
    members, missing, seen = {}, [], 0
    for ground, v in (doc_sets.get("grounds") or {}).items():
        for s in (v.get("sets") or []):
            for mem in (s.get("members") or []):
                t = (mem.get("tile") or "").strip()
                if not t:
                    continue          # the clean member - no art, by design
                seen += 1
                kind, art = resolve(t)
                if kind is None:
                    missing.append({"member": t, "why": art})
                    continue
                if not os.path.isfile(os.path.join(REPO, art)):
                    missing.append({"member": t, "why": f"no file at {art}"})
                    continue
                members[t] = {"kind": kind, "art": art}
    dupes = seen - len(members) - len(missing)
    doc = {
        "schema": "tiles3/member-resolve@1",
        "_comment": [
            "HOW TO TURN A base_tile_sets.json MEMBER STRING INTO ART, as data.",
            "Look the member up in `members` and draw `art`. Do not parse the string:",
            "it has two legal forms, and re-implementing the choice is what made 104 of",
            "340 members fall back to clean in the map renderer while the wiki drew them",
            "correctly (the plate rule applied to a literal path yields '...webp.webp').",
            "A member absent from `members` means THIS FILE IS STALE, not that the member",
            "is invalid - fall back to `forms`, and it is worth saying so out loud.",
            "Every `art` here was verified to exist on disk when this file was written.",
        ],
        "forms": {
            "plate": {
                "match": r"^tiles/([^/]+)/([0-9a-f]{8})$",
                "resolve": "tiles/plates/<the cell's ground, i.e. group 1 before '__over__'>/<group 2>.webp",
            },
            "file": {
                "match": r"\.webp$",
                "resolve": "the string itself, verbatim - it is already a path",
                "covers": "tiles/tops/**/post art and tiles/base_candidates ballot files",
            },
        },
        "n_members": len(members),
        "n_referenced": seen,
        "n_shared_members": dupes,   # one string used by more than one set/ground
        "by_kind": {k: sum(1 for v in members.values() if v["kind"] == k)
                    for k in ("plate", "file")},
        "unresolved": missing,
        "members": dict(sorted(members.items())),
    }
    tmp = OUT + f".{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=1)
    os.replace(tmp, OUT)
    print(f"resolve.json: {len(members)} distinct of {seen} references resolved "
          f"{doc['by_kind']}; shared by >1 set: {dupes}; unresolved {len(missing)}")
    for u in missing[:5]:
        print("   !", u)


if __name__ == "__main__":
    main()
