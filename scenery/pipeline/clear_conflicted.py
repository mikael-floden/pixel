"""Clear verdicts that contradict themselves, so the piece reads as unreviewed.

A rejection carrying a high star rating — tree_021 arrived rejected at 5 stars
with 13 of its 14 states approved at 5 — is a misclick, not an instruction.
feedback.py refuses to delete on one. But leaving the verdict in place leaves
the piece looking judged, and the maintainer cannot find it again:

  "Can you please remove the star and the rejection on items like that so it's
   easier for me to find them again. It's very easy for me to find the tree if
   the tree is not rated and not rejected."

So the piece-level entry is REMOVED entirely — no status, no stars — and the
piece returns to his unreviewed queue. Per-state verdicts are left alone; those
are separate review items he made deliberately.

NOTE ON OWNERSHIP: live/feedback/objects.json belongs to the live server, which
is the single writer. This deletes only entries that are self-contradictory, and
never edits or invents a verdict. If the server dumps its own state on top, the
entry returns and this needs to move into the wiki instead — check after a
server push before trusting it.

    python3 pipeline/clear_conflicted.py --dry-run
    python3 pipeline/clear_conflicted.py
"""
import collections, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import factory

FEEDBACK = os.path.join(os.path.dirname(factory.ROOT), "live", "feedback", "objects.json")


def conflicted(entries):
    out = []
    for key, v in entries.items():
        if not key.startswith("scenery/") or "#" in key:
            continue
        if (v or {}).get("status") != "rejected":
            continue
        rel = key[len("scenery/"):]
        if factory.read_manifest(rel) is None:
            continue
        rating = v.get("rating") or 0
        sub = [x for k2, x in entries.items() if k2.startswith(f"scenery/{rel}#")]
        ok = sum(1 for x in sub if x.get("status") == "approved")
        if rating >= 4 or (sub and ok == len(sub)):
            out.append((key, rating, ok, len(sub)))
    return out


def main():
    dry = "--dry-run" in sys.argv
    # object_pairs_hook + indent=2 + ensure_ascii=False reproduce the live
    # server's exact formatting. Writing with different options rewrote all
    # 15,279 lines for a one-entry deletion — a diff nobody can review and a
    # guaranteed conflict with the server's next dump. The edit must be
    # invisible apart from the entry it removes.
    doc = json.load(open(FEEDBACK, encoding="utf-8"),
                    object_pairs_hook=collections.OrderedDict)
    entries = doc.get("entries") or {}
    hits = conflicted(entries)
    print(f"{len(hits)} self-contradictory verdict(s)")
    for key, rating, ok, n in hits:
        print(f"  {key}  rejected but rated {rating}, {ok}/{n} states approved")
    if dry or not hits:
        return 0
    for key, *_ in hits:
        entries.pop(key, None)
    doc["entries"] = entries
    with open(FEEDBACK, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"cleared {len(hits)} — those pieces are unrated and unrejected again")
    return 0


if __name__ == "__main__":
    sys.exit(main())
