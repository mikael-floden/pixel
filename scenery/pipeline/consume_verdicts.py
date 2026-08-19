"""Clear verdicts whose art has been regenerated since they were made.

The maintainer, seeing his own old complaint still attached to freshly
generated art: "It's really confusing to me to know if this is what I have said
on this state or if it's a ghost from something I reported on something
completely different."

STALENESS IS NOW DECIDED BY HASH, NOT BY TIME. A verdict carries `art`, the
md5[:16] of the picture it was given to. When the art on disk hashes
differently, the verdict is provably about a picture that no longer exists —
no dates, no inference. This used to be impossible because the wiki stamped a
STATE verdict with the PIECE's hash; it now stamps the clip's own, so the exact
route works. Measured on fallen_log_014: not_lit_10 carries c728315868 while
the file on disk hashes 74dbcbe2c3, and the piece hash is a third value again.

It is also what makes this usable. The old rule asked git for a commit date per
verdict — one subprocess each, ~3,900 of them — and took long enough that it
was timing out and silently doing nothing, which is precisely why his ghosts
survived. Hashing the files is instant.

A cleared verdict is a piece of his work being discarded, so the rule stays
narrow: the art must still exist, and it must provably differ from what he
judged. Approvals go too — an approval of art that no longer exists is not an
approval of what is on screen now. Verdicts with no `art` stamp at all are left
alone: nothing can be proven about them, and guessing would throw away work.

live/feedback/objects.json belongs to the live server as single writer, so the
file is rewritten byte-identically apart from the removed entries — ordered
keys, indent 2, ensure_ascii off.

    python3 pipeline/consume_verdicts.py --dry-run
    python3 pipeline/consume_verdicts.py
"""
import collections, json, os, subprocess, sys
from datetime import datetime
sys.path.insert(0, os.path.dirname(__file__))
import factory

FEEDBACK = os.path.join(os.path.dirname(factory.ROOT), "live", "feedback", "objects.json")


def _ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _committed(relpath):
    r = subprocess.run(["git", "log", "-1", "--format=%cI", "--", relpath],
                       cwd=factory.ROOT, capture_output=True, text=True)
    return _ts(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None


def sprite_for(key):
    """The sprite a verdict key points at, or None if it no longer exists.

    A VERDICT KEY HAS THREE PARTS: <piece>#<state>#<DIRECTION>. Ignoring the
    third and always returning the SOUTH sprite is not a rounding error — it
    silently destroyed 136 of the maintainer's verdicts on 2026-08-18, 135 of
    them five-star approvals and one a rejection carrying a written instruction
    about windows.

    The mechanism: the wiki stamps a verdict with the md5 of the CLIP he was
    looking at, so a south-east verdict carries the hash of the south-east
    rotation file. Hashing SOUTH instead can never match that, so every
    non-south verdict looked stale and was cleared. Windows are the only pieces
    with south-east and south-west facings, so this deleted his entire window
    review and nothing else — which is exactly why it went unnoticed.

    Returning None for a direction whose file cannot be found is the safe
    failure: the caller treats an unresolvable key as untouchable."""
    if not key.startswith("scenery/"):
        return None
    body = key[len("scenery/"):]
    parts = body.split("#")
    if len(parts) == 1:
        sp = (factory.read_manifest(parts[0]) or {}).get("sprite")
        return sp if sp and os.path.exists(os.path.join(factory.ROOT, sp)) else None

    rel, state = parts[0], parts[1].upper()
    direction = parts[2].lower() if len(parts) > 2 else "south"
    ent = ((factory.read_manifest(rel) or {}).get("states") or {}).get(state)
    if not ent:
        return None
    if direction == "south":
        sp = ent.get("sprite")
    else:
        # Non-south lives in the state's own rotations map when it has one, and
        # otherwise beside the piece — windows carry rotations at both levels.
        rots = ent.get("rotations") or {}
        sp = rots.get(direction)
        if not sp:
            cand = f"{rel}/{state.lower()}/rotations/{direction}.webp"
            if os.path.exists(os.path.join(factory.ROOT, cand)):
                sp = cand
        if not sp:
            cand = f"{rel}/rotations/{direction}.webp"
            if os.path.exists(os.path.join(factory.ROOT, cand)):
                sp = cand
    return sp if sp and os.path.exists(os.path.join(factory.ROOT, sp)) else None


def _hash(relpath):
    import hashlib
    try:
        with open(os.path.join(factory.ROOT, relpath), "rb") as f:
            return hashlib.md5(f.read()).hexdigest()[:16]
    except OSError:
        return None


def spent(entries):
    """Keys whose stamped art hash provably differs from the art on disk.

    A STAMP EQUAL TO THE PIECE'S OWN HASH IS AMBIGUOUS AND MUST BE TRUSTED.
    Verdicts given before the wiki stamped per-clip hashes all carry the PIECE
    sprite's hash, and so does a legitimately-judged anchor state, whose clip
    IS the piece sprite. Treating those as mismatches flags 873 verdicts —
    almost all of them APPROVALS — and clearing them would have thrown away the
    bulk of his review work and sent him round the whole library again. That is
    the same rule the wiki's own facetStale applies, for the same reason.

    What remains is exact: a stamp that matches NEITHER the clip on disk NOR
    the piece sprite can only have come from art that has since been replaced."""
    out = []
    for key, v in entries.items():
        stamp = (v or {}).get("art")
        if not stamp:
            continue                       # unprovable — never guess
        sp = sprite_for(key)
        if not sp:
            continue                       # art gone: nothing on screen to confuse him
        now = _hash(sp)
        if not now or now == stamp:
            continue
        body = key[len("scenery/"):]
        rel = body.split("#")[0]
        piece_sprite = (factory.read_manifest(rel) or {}).get("sprite")
        if piece_sprite and _hash(piece_sprite) == stamp:
            continue                       # legacy/anchor stamp — trust it
        out.append(key)
    return out


def main():
    dry = "--dry-run" in sys.argv
    doc = json.load(open(FEEDBACK, encoding="utf-8"),
                    object_pairs_hook=collections.OrderedDict)
    entries = doc.get("entries") or {}
    hits = spent(entries)
    import collections as C
    kinds = C.Counter(entries[k].get("status") for k in hits)
    print(f"{len(hits)} verdict(s) describe art that has since been regenerated")
    print("  ", dict(kinds))
    for k in hits[:12]:
        note = entries[k].get("note") or ""
        print(f"   {k.replace('scenery/','')}  [{entries[k].get('status')}] {note[:50]}")
    if dry or not hits:
        return 0
    for k in hits:
        entries.pop(k, None)
    doc["entries"] = entries
    with open(FEEDBACK, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"cleared {len(hits)} — that art now shows unreviewed, with no comment")
    return 0


if __name__ == "__main__":
    sys.exit(main())
