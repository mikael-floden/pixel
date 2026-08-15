"""Clear verdicts whose art has been regenerated since they were made.

The maintainer, seeing an old complaint still attached to a freshly generated
tree: "When you consume a request and generate something new, the new graphics
should have no comment or approve/reject."

He is right, and the art_hash route cannot do it on its own: the wiki stamps a
STATE verdict with the hash of the PIECE'S sprite, so regenerating a state does
not change the hash the verdict carries and the verdict never looks spent.
Staleness is therefore decided by TIME — was the sprite committed after the
verdict? — the same rule feedback.py has always used for pieces.

A cleared verdict is a piece of his work being discarded, so the rule is narrow:
only entries whose art is provably NEWER than the verdict, and the art must
exist. Approvals go too: an approval of art that no longer exists is not an
approval of what is on screen now.

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
    """The sprite a verdict key points at, or None if it no longer exists."""
    if not key.startswith("scenery/"):
        return None
    body = key[len("scenery/"):]
    if "#" in body:
        rel, state = body.split("#")[0], body.split("#")[1].upper()
        ent = ((factory.read_manifest(rel) or {}).get("states") or {}).get(state)
        sp = (ent or {}).get("sprite")
    else:
        sp = (factory.read_manifest(body) or {}).get("sprite")
    if sp and os.path.exists(os.path.join(factory.ROOT, sp)):
        return sp
    return None


def spent(entries):
    out = []
    for key, v in entries.items():
        sp = sprite_for(key)
        if not sp:
            continue                       # piece gone: nothing on screen to confuse him
        vt, ct = _ts(v.get("updated_at")), _committed(sp)
        if vt and ct and ct > vt:          # art newer than the verdict
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
