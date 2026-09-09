"""Publish base-tile-set member resolution AS DATA: `tiles/resolve.json`.

The bug this ends, reported by the game agent 2026-08-28 and by the maintainer before
that: a base-tile-set member string has TWO legal forms with two different resolutions,
and every consumer re-implements the choice.

    kind "conform" tiles/<cell>/<key8>                   -> that candidate's TEXTURED art
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
MANIFEST = os.path.join(ROOT, "review", "manifest.json")
_TEX = None


def _textured():
    """review key -> the candidate's TEXTURED art, which is what render3 draws.

    THIS FILE USED TO SEND A REVIEW KEY TO THE FLATTENED PLATE, and the game agent
    recorded the disagreement on 2026-08-29: render3 resolves a review-key member to
    the candidate's textured art and consults this map only for the file form, so the
    published rule was stale for all 236 review-key members. A resolver that disagrees
    with the renderer is worse than no resolver - it is a second answer that looks
    authoritative - so the map now states what is actually drawn.

    The plate is still the fallback for a candidate with no textured art, which is the
    only case the old rule got right, and `forms` says so.
    """
    global _TEX
    if _TEX is None:
        _TEX = {}
        try:
            man = json.load(open(MANIFEST))
        except Exception:
            return _TEX
        for c in (man.get("cells") or {}).values():
            for e in (c.get("candidates") or []):
                t = e.get("textured")
                if e.get("key") and t:
                    _TEX[e["key"]] = t
    return _TEX
POST = re.compile(r"^(tiles/tops/.+/post)/(tile_\d\d)\.[0-9a-f]{8}\.webp$")


def _current_post():
    """(sheet post dir, tile_NN) -> the CURRENT hashed file, from tops/index.json.

    A REGENERATED TILE GETS A NEW NAME, which is the cache law working: post art is
    content-addressed, so repainting a sheet onto a changed palette writes
    tile_NN.<newsha>.webp and leaves the old name in place for pages already open.
    A base-tile-set member, though, names the file it was PICKED as - so after the
    2026-09-03 water/beach palette change every sand and water member still pointed at
    the superseded file and the live game drew the OLD colours while ground_types.json
    served the new ones. Measured live: the served member tile was byte-identical to
    the old hash.

    A member names a TILE, not a byte sequence, so this map resolves it to that tile's
    current art. That is exactly what this file exists for ("ask the map, never parse
    the string") and it needs no change from the wiki, which owns the member list.
    The superseded path is still reported per entry so the drift stays visible.
    """
    out = {}
    idx = os.path.join(ROOT, "tops", "index.json")
    if not os.path.isfile(idx):
        return out
    try:
        doc = json.load(open(idx))
    except Exception:
        return out
    for sh in (doc.get("sheets") or []):
        d = sh.get("dir")
        for name in (sh.get("post_files") or []):
            if not isinstance(name, str):
                continue
            stem = name.split(".")[0]
            out[(f"{d}/post", stem)] = f"{d}/post/{name}"
    return out


CURRENT = None


def resolve(member):
    """(kind, repo-relative art path) for one member string, or (None, reason)."""
    global CURRENT
    m = KEY.match(member)
    if m:
        cell, k8 = m.groups()
        tex = _textured().get(member)
        if tex:
            return "conform", tex        # what render3 actually draws
        ground = cell.split("__over__")[0]
        return "plate", f"tiles/plates/{ground}/{k8}.webp"
    if member.endswith(".webp"):
        # NOT "top": this bucket holds tops/post art AND base_candidates ballot files.
        # Naming it for one of them is how a consumer ends up special-casing the other.
        pm = POST.match(member)
        if pm:
            if CURRENT is None:
                CURRENT = _current_post()
            cur = CURRENT.get((pm.group(1), pm.group(2)))
            if cur and cur != member:
                return "file", cur       # the tile's CURRENT art, not the picked bytes
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
                entry = {"kind": kind, "art": art}
                if kind == "file" and art != t:
                    # a plate member's art path ALWAYS differs from its key, which is
                    # the plate rule, not drift - only a file member that moved counts
                    entry["superseded"] = t
                members[t] = entry
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
            "conform": {
                "match": r"^tiles/([^/]+)/([0-9a-f]{8})$",
                "resolve": "the review manifest candidate's `textured` art for that key",
                "why": "render3 draws the TEXTURED art for a review-key member; this "
                       "file used to send it to the flattened plate and was stale "
                       "against the renderer for all 236 of them (game agent, "
                       "2026-08-29). A resolver that disagrees with the renderer is a "
                       "second answer that looks authoritative.",
                "fallback": "tiles/plates/<ground>/<key8>.webp when the candidate has "
                            "no textured art",
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
                    for k in ("plate", "conform", "file")},
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
