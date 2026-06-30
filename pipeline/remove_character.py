"""Remove ONE character cleanly — from PixelLab and the repo — without touching
any other character.

A character's base plus all its dressed outfit STATES share a PixelLab
`group_id`; this deletes the whole group so nothing is orphaned, then removes the
local folder. The loop is gap-tolerant (see factory.next_char_index), so on its
next run it regenerates exactly the freed slot (same index, same look) — now
gated by the base-rotation QA check. So you can prune a bad character even when
the roster is large and full of brilliant ones.

Usage:
  python pipeline/remove_character.py --skeleton 00_low8_64 --character char_03
  python pipeline/remove_character.py --skeleton 00_low8_64 --character char_03 --no-push
"""

from __future__ import annotations

import argparse
import os
import shutil

import factory
import viewer_build
import loop
from pixellab_client import PixelLabClient


def remove_character(client, sid, local_id):
    cdir = os.path.join(factory.skeleton_dir(sid), "characters", local_id)
    meta = factory._read_json(os.path.join(cdir, "character.json"))
    if not meta:
        raise SystemExit(f"no such character: {sid}/{local_id}")

    # Collect every PixelLab id to delete: the base, its outfit states (shared
    # group_id), and any outfit ids recorded in the manifest (belt + suspenders).
    ids = set()
    pid = meta.get("pixellab_id")
    if pid:
        ids.add(pid)
        try:
            group = client.get_character(pid).get("group_id")
            if group:
                ids |= {c["id"] for c in client.list_characters()
                        if c.get("group_id") == group}
        except Exception as e:
            print(f"warn: could not enumerate outfit states: {e}")
    for o in (meta.get("outfits") or {}).values():
        if o.get("pixellab_id"):
            ids.add(o["pixellab_id"])

    for cid in ids:
        try:
            client.delete_character(cid)
            print(f"  deleted PixelLab character {cid}")
        except Exception as e:
            print(f"  warn: delete {cid} failed: {e}")

    shutil.rmtree(cdir, ignore_errors=True)
    print(f"  removed local {cdir}")
    return ids


def main():
    ap = argparse.ArgumentParser(description="Remove one character (PixelLab + repo).")
    ap.add_argument("--skeleton", required=True)
    ap.add_argument("--character", required=True, help="local id, e.g. char_03")
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()

    client = PixelLabClient()
    ids = remove_character(client, args.skeleton, args.character)
    viewer_build.build()
    loop.commit_push(
        f"Remove {args.skeleton}/{args.character} ({len(ids)} PixelLab character(s)); "
        f"loop will regenerate the slot",
        push=not args.no_push)
    print(f"done — removed {args.skeleton}/{args.character}. "
          f"The loop will regenerate that slot (validated) on its next run.")


if __name__ == "__main__":
    main()
