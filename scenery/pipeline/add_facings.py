"""Give every INDOOR and TOWN state its south-east and south-west facings.

Maintainer, 2026-08-28: "Everything under 'Indoor' and under 'Town' should have
SW, S and SE."

THIS COSTS NOTHING, and that is the whole point. Any piece of 168px or under
went down create-8-direction-object, so PixelLab generated all eight facings
when the piece was made and has been storing them ever since — this repo simply
never downloaded more than SOUTH, because "SOUTH only, scenery never rotates"
was the domain rule. Windows were already the standing exception (walls face
three ways), and this extends that exception to indoor and town furniture on the
same free path. Verified before writing a line: torch_post_004's object reports
rotation_urls for all eight directions.

PIECES OVER 168px CANNOT DO THIS. They went down create-1-direction-object and
no other facing was ever generated, so there is nothing to download. 22 of them
(16 at 192px, 6 at 256px) stay south-only; giving them facings would mean
regenerating them as new art and discarding pieces he has already reviewed.

Each STATE is its own PixelLab object with its own eight rotations, so the unit
of work is the state, not the piece.

    python3 pipeline/add_facings.py --dry-run
    python3 pipeline/add_facings.py
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import factory
import viewer_build
from pixellab_client import PixelLabClient, PixelLabError
import animate_trees as A

TYPES = ("INDOOR", "TOWN")
WANT = ("south-east", "south-west")     # SOUTH is already the stored sprite
EIGHT_DIR_MAX = 168
PARALLEL = 12

# ONE LOCK PER PIECE. Every state of a piece writes the SAME scenery.json, so
# a read-modify-write from two workers interleaves and the later write drops
# the earlier one's rotations. Re-reading before writing is not enough — the
# gap between read and write is the race. Measured: 15 states across 10 pieces
# silently lost their entries on the 2026-08-28 run, all on pieces with many
# states (tables, cupboards). The .webp files survived; only the manifest
# forgot them, which is exactly the kind of loss that looks like nothing.
_LOCKS = defaultdict(threading.Lock)


def _types():
    with open(os.path.join(factory.ROOT, "config", "factory.json"),
              encoding="utf-8") as f:
        return {g["id"]: g.get("type") for g in json.load(f).get("groups", [])}


def targets():
    """[(rel, state, oid, size)] — states that should gain SE/SW and have not."""
    types = _types()
    out = []
    for p in sorted(glob.glob(os.path.join(factory.ROOT, "*", "*", "scenery.json"))):
        rel = os.path.relpath(os.path.dirname(p), factory.ROOT)
        with open(p, encoding="utf-8") as f:
            man = json.load(f)
        group = rel.split("/")[0]
        if (man.get("type") or types.get(group) or "OTHER") not in TYPES:
            continue
        size = int(man.get("size") or 64)
        if size > EIGHT_DIR_MAX:
            continue                       # no other facing was ever generated
        for state, e in sorted((man.get("states") or {}).items()):
            oid = (e or {}).get("pixellab_object_id")
            if not oid:
                continue
            have = set((e or {}).get("rotations") or {})
            if all(d in have for d in WANT):
                continue                   # already done — resumable
            out.append((rel, state, oid, size))
    return out


def facing_path(rel, state, man, direction):
    """Beside the state's own sprite, mirroring how windows store their facings."""
    ent = (man.get("states") or {}).get(state) or {}
    if ent.get("sprite") == man.get("sprite"):          # anchor: no dir of its own
        return f"{rel}/rotations/{direction}.webp"
    return f"{rel}/{state.lower()}/rotations/{direction}.webp"


def one(client, rel, state, oid, size):
    try:
        rots = client.download_object_rotations(oid, wait=120)
        got = {d: im for d, im in rots.items() if d in WANT}
        if not got:
            return (rel, state, 0, "no SE/SW rotations upstream")
        man = factory.read_manifest(rel) or {}
        saved = {}
        for d, im in got.items():
            out = facing_path(rel, state, man, d)
            factory.save_webp(factory._normalize(im.convert("RGBA"), size),
                              os.path.join(factory.ROOT, out))
            saved[d] = out
        with _LOCKS[rel]:
            man = factory.read_manifest(rel) or {}
            states = dict(man.get("states") or {})
            ent = dict(states.get(state) or {})
            rot = dict(ent.get("rotations") or {})
            rot.update(saved)
            rot["south"] = ent.get("sprite")   # so a consumer iterates all three
            ent["rotations"] = rot
            states[state] = ent
            man["states"] = states
            factory.write_manifest(rel, man)
        return (rel, state, len(saved), "ok")
    except PixelLabError as e:
        return (rel, state, 0, f"FAILED: {str(e)[:90]}")
    except Exception as e:                   # noqa: BLE001
        return (rel, state, 0, f"ERROR: {type(e).__name__}: {str(e)[:80]}")


def main():
    ap = argparse.ArgumentParser(description="Download SE/SW facings for INDOOR/TOWN.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    todo = targets()
    if args.limit:
        todo = todo[:args.limit]
    pieces = {r for r, *_ in todo}
    print(f"{len(todo)} state(s) across {len(pieces)} piece(s) to gain SE+SW")
    print("  cost: NOTHING — these facings were generated with the piece and are "
          "only being downloaded")
    if args.dry_run or not todo:
        from collections import Counter
        for g, n in Counter(r.split("/")[0] for r, *_ in todo).most_common(12):
            print(f"    {g:<24} {n}")
        return 0

    client = PixelLabClient()
    ok = files = 0
    done = 0
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        futs = [pool.submit(one, client, rel, st, oid, sz)
                for rel, st, oid, sz in todo]
        for f in as_completed(futs):
            rel, st, n, how = f.result()
            done += 1
            if n:
                ok += 1
                files += n
            else:
                print(f"    x {rel} {st}: {how}")
            if done % 200 == 0:
                print(f"  = {done}/{len(todo)}")
                A.commit_push(f"scenery: SE/SW facings ({done}/{len(todo)} states)")
    viewer_build.build()
    A.commit_push(f"scenery: SE/SW facings for {ok} INDOOR/TOWN state(s)")
    print(f"\n{ok}/{len(todo)} state(s) gained facings ({files} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
