"""Move a piece-level verdict onto the state its art actually became.

When a single-sprite piece gains states, its original sprite becomes the ANCHOR
state (NOT_LIT_1 / LIT_1 / LIGHTS_OFF) — the same bytes, never regenerated. His
judgement of that sprite was recorded against the PIECE, so it does not follow
the art onto its new state key, and the piece reads as though nothing has been
reviewed:

  "that single sprite had a state approval on that single individual
   sprite/state. So now when that single sprite gets more states one state will
   still be approved and this means the scenery will show up in the 'partially
   reviewed' filter."

He is right. This copies the verdict onto the anchor state ONLY when the anchor
sprite is byte-identical to the piece sprite, so it is a relocation of his own
judgement rather than an invented one. The piece-level entry is left in place —
it is still a true statement about the piece.

    python3 pipeline/migrate_anchor_verdicts.py --dry-run
"""
import collections, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import factory

FEEDBACK = os.path.join(os.path.dirname(factory.ROOT), "live", "feedback", "objects.json")


def candidates(entries):
    out = []
    for rel, m in factory.discover():
        st = m.get("states") or {}
        if not st:
            continue
        anchor = next((s for s, v in st.items()
                       if v.get("sprite") == m.get("sprite")), None)
        if not anchor:
            continue                      # anchor art was replaced: not the same judgement
        pv = entries.get(f"scenery/{rel}")
        key = f"scenery/{rel}#{anchor.lower()}#south"
        if pv and pv.get("status") and key not in entries:
            out.append((key, pv))
    return out


def main():
    dry = "--dry-run" in sys.argv
    doc = json.load(open(FEEDBACK, encoding="utf-8"),
                    object_pairs_hook=collections.OrderedDict)
    entries = doc.get("entries") or {}
    hits = candidates(entries)
    kinds = collections.Counter(v.get("status") for _, v in hits)
    print(f"{len(hits)} anchor state(s) inherit their piece's verdict  {dict(kinds)}")
    for k, v in hits[:10]:
        print(f"   {k.replace('scenery/','')}  <- {v.get('status')} r={v.get('rating')}")
    if dry or not hits:
        return 0
    for key, pv in hits:
        entries[key] = collections.OrderedDict(pv)
    doc["entries"] = entries
    with open(FEEDBACK, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"migrated {len(hits)} — those pieces now read as partly reviewed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
