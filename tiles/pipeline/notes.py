"""The maintainer's NOTES — the part of a review that a script must never handle.

A review carries two different things and they have opposite requirements:

  THE VERDICT (reject / approve / stars) is mechanical. "Do not publish this tile
  again" is a fact about a file, publish applies it, and automating that is right —
  forgetting it once meant a fresh build still contained nine tiles they had deleted.

  THE NOTE is not. "Maybe call parquet_floor just wood — the word floor will get the
  AI to think the wood should be at the top" is a person telling me how to fix the
  generator. Nothing here can act on that, and the danger of automating the verdict is
  that the tile quietly disappears and the sentence attached to it is never read:

    "It's meant that you read them. I might have a comment to you. It should be in
     your readme and not a script to automate it. How do you automate reading my
     comments?"

  You do not. So this file does the one thing a script can honestly do: make sure an
  unread note is IMPOSSIBLE TO MISS, and keep count of which ones I have actually
  looked at. Acknowledging is a separate, deliberate act — `--ack` — and it is a lie
  if run without reading, which is exactly the property that keeps it honest.

Every note in the first review pass changed the pipeline, which is why they matter:
"looks like Y over X" (22 of them) became the swapped-material gate; "not enough lava
on the ground" (14) became the contamination tier; "call water something else like
blue" became the colour-word trick that took deep_water-over-grass from 100% backwards
to 12%; "paving stones are not supposed to be clean" became flat_top.

  python tiles/pipeline/notes.py            # show notes I have not read
  python tiles/pipeline/notes.py --all      # show every note ever left
  python tiles/pipeline/notes.py --ack      # record that I have now read them
"""

from __future__ import annotations

import argparse
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
FEEDBACK = os.path.join(REPO, "live", "feedback", "tiles.json")
SEEN = os.path.join(ROOT, "notes_seen.json")


def _entries():
    try:
        return json.load(open(FEEDBACK))["entries"]
    except Exception:
        return {}


def _seen():
    try:
        return set(json.load(open(SEEN))["read"])
    except Exception:
        return set()


def all_notes():
    """[(key, note, meta)] for every verdict carrying a note, oldest first."""
    out = [(k, (v.get("note") or "").strip(), v)
           for k, v in _entries().items() if (v.get("note") or "").strip()]
    return sorted(out, key=lambda t: t[2].get("updated_at", ""))


def unread():
    seen = _seen()
    return [n for n in all_notes() if n[0] not in seen]


def ack():
    keys = sorted(k for k, _n, _v in all_notes())
    json.dump({"_comment": ("Notes the tiles agent has READ. Acknowledging without "
                            "reading defeats the only purpose this file has."),
               "read": keys}, open(SEEN, "w"), indent=2)
    return len(keys)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--ack", action="store_true")
    args = ap.parse_args()

    notes = all_notes() if args.all else unread()
    if not notes:
        print(f"no unread notes ({len(all_notes())} read in total)")
        return 0
    print(f"{len(notes)} note(s) from the maintainer"
          f"{'' if args.all else ' I HAVE NOT READ'}:\n")
    for k, note, v in notes:
        star = f" {v['rating']}*" if v.get("rating") else ""
        print(f"  {v.get('updated_at', '')[:19]}  {k}  [{v.get('status') or 'rated'}{star}]")
        print(f"      {note}\n")
    if args.ack:
        print(f"acknowledged {ack()} note(s) as read")
    else:
        print("READ THESE. They are instructions to me, not data for a script.")
        print("Then: python tiles/pipeline/notes.py --ack")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
