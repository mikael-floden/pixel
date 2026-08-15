"""Backfill `generated_at` on pieces that predate the field.

The wiki sorts the maintainer's review queue newest-first and had to derive
each piece's date from the git commit that added it, cached in
wiki/first_seen.json — which breaks in the deploy image, where there is no
.git and a piece that landed between cache commits falls back to "first build
that saw it". `generated_at` has been stamped at birth since it was added, but
the pieces generated before that carry nothing, so the wiki still needs its
fallback for them. This fills them in once.

THE DATE IS THE SPRITE'S LAST COMMIT, NOT ITS FIRST. Rejected slots are
regenerated at the same path, so a piece's `--diff-filter=A` date is when its
PREDECESSOR was born — for replacement art that is a date from before the
art existed, and it would sort the newest pieces in his queue to the bottom.
Last-touch is when the art on disk now actually landed.

    python3 pipeline/backfill_generated_at.py --dry-run
    python3 pipeline/backfill_generated_at.py
"""

from __future__ import annotations

import argparse
import subprocess
import sys

import factory


def sprite_dates():
    """{sprite path -> newest commit date} in ONE git pass, not one per piece."""
    r = subprocess.run(
        ["git", "log", "--format=@%cI", "--name-only", "--", "*/sprite.webp"],
        cwd=factory.ROOT, capture_output=True, text=True)
    out, at = {}, None
    for line in r.stdout.splitlines():
        if line.startswith("@"):
            at = line[1:]
        elif line.strip() and at:
            out.setdefault(line.strip(), at)   # log is newest-first: first wins
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    dates = sprite_dates()
    filled = missing = states = 0
    for rel, man in factory.discover():
        dirty = False
        key = man.get("sprite") or f"{rel}/sprite.webp"
        # git paths here are domain-relative because git runs with cwd=ROOT
        when = dates.get(key) or dates.get(f"scenery/{key}")
        if not man.get("generated_at"):
            if when:
                filled += 1
                man["generated_at"] = when
                dirty = True
            else:
                missing += 1
        # STATES CARRY THEIR OWN DATE. A tree's 14 variants land on different
        # days, and a regenerated state is the newest art in the domain the
        # moment it lands — dating it by its PIECE would bury it at the bottom
        # of a newest-first queue, which is exactly the sorting the maintainer
        # reviews by.
        for name, st in (man.get("states") or {}).items():
            if not isinstance(st, dict) or st.get("generated_at"):
                continue
            sk = st.get("sprite")
            sw = dates.get(sk) or dates.get(f"scenery/{sk}") if sk else None
            if sw:
                st["generated_at"] = sw
                states += 1
                dirty = True
        if dirty and not args.dry_run:
            factory.write_manifest(rel, man)
    verb = "would fill" if args.dry_run else "filled"
    print(f"{verb} generated_at on {filled} piece(s) and {states} state(s); "
          f"{missing} had no committed sprite (uncommitted or renamed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
