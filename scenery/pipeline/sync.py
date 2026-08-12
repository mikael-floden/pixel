"""Keep the scenery domain and PixelLab consistent (v2, zero generations).

PixelLab is the live source of truth for a piece's art: the maintainer can
open any piece in the create-object web tool and regenerate it, and this sync
pulls the new art down — only re-downloading a sprite whose `Last-Modified`
changed (`If-Modified-Since` -> 304 skip), exactly like the characters agent.

It also keeps the two ends consistent:
  - **Deletion parity:** a piece whose PixelLab object was deleted (gone from
    the store listing) is removed from the repo, so the maintainer's
    reject-and-delete in the UI/wiki flow propagates here.
  - **No loose pointers:** a manifest whose sprite file is missing is removed
    (the planner then regenerates that piece deterministically).
  - **Orphan report:** store objects tagged SCENERY that no manifest points at
    (a crash between select-frames and the claim commit) are REPORTED, never
    silently adopted or deleted — a human decides.

v2 sync writes **lossless WebP only** (the v1 png gap is gone with the v1
mirror). The three legacy 8-direction pieces (campfire, grave_cross,
blood_spatter) are frozen art — deletion parity applies to them, re-mirroring
does not (regenerating them is forbidden; see README).

Usage:
  python scenery/pipeline/sync.py                 # reconcile + mirror, push
  python scenery/pipeline/sync.py --no-push
  python scenery/pipeline/sync.py --dry-run       # report only
"""

from __future__ import annotations

import argparse
import os
import shutil

import factory
import viewer_build
from pixellab_client import PixelLabClient, PixelLabError

ROOT = factory.ROOT
LEGACY = {"campfire", "grave_cross", "blood_spatter"}


def _exists(rel):
    return bool(rel) and os.path.exists(os.path.join(ROOT, rel))


def prune_loose_pointers(dry_run=False):
    """A grouped piece without its sprite on disk is half-written — remove the
    folder so the deterministic planner regenerates that exact piece."""
    removed = []
    for rel, meta in factory.discover():
        if rel.split("/", 1)[0] in LEGACY:
            continue
        if not _exists(meta.get("sprite")):
            removed.append(rel)
            if not dry_run:
                shutil.rmtree(factory.piece_dir(rel), ignore_errors=True)
    return removed


def mirror_piece(client, rel, meta, dry_run=False):
    """Pull one grouped piece's sprite from PixelLab if it changed upstream.
    Returns 'unchanged' | 'synced' | 'deleted'."""
    pid = meta.get("pixellab_object_id")
    if not pid:
        return "untracked"
    try:
        detail = client.get_object(pid)
    except PixelLabError as e:
        if "404" in str(e):
            return "deleted"
        raise
    url = client.sprite_url(detail)
    if not url:
        return "unchanged"
    status, img, lm = client.conditional_download(url, meta.get("lm"))
    if status == 304 or img is None:
        return "unchanged"
    if not dry_run:
        img = factory._normalize(img, meta.get("size", img.width))
        factory.save_webp(img, os.path.join(factory.piece_dir(rel), "sprite.webp"))
        meta["lm"] = lm
        factory.write_manifest(rel, meta)
    return "synced"


def reconcile(client, push=True, quiet=False, dry_run=False, mirror=True):
    cfg = factory.load_config()
    tag = (cfg.get("tag") or "SCENERY").upper()
    store = client.list_objects()
    live_ids = {o.get("id") for o in store if o.get("id")}

    pieces = factory.discover()
    tracked = {m.get("pixellab_object_id") for _, m in pieces if m.get("pixellab_object_id")}

    # Deletion parity — only when the store actually returned objects, so a
    # transient empty listing can never wipe the repo. LEGACY pieces are
    # game-referenced frozen art and are NEVER auto-deleted, only reported:
    # the 2026-08-12 incident (a single-page store listing read as "deleted
    # upstream" and swept campfire/grave_cross/blood_spatter, breaking three
    # hardcoded game URLs) is why this is a hard rule, belt-and-braces on top
    # of the now-paginated listing.
    deleted = []
    if live_ids:
        for rel, meta in pieces:
            pid = meta.get("pixellab_object_id")
            if not pid or pid in live_ids:
                continue
            if rel.split("/", 1)[0] in LEGACY:
                if not quiet:
                    print(f"⚠ legacy piece '{rel}' no longer on PixelLab — kept "
                          f"(frozen, game-referenced); reconcile by hand if intended")
                continue
            deleted.append(rel)
            if not dry_run:
                shutil.rmtree(factory.piece_dir(rel), ignore_errors=True)

    removed = prune_loose_pointers(dry_run=dry_run)

    synced = []
    if mirror:
        for rel, meta in factory.discover():
            if rel.split("/", 1)[0] in LEGACY or "/" not in rel:
                continue
            if mirror_piece(client, rel, meta, dry_run=dry_run) == "synced":
                synced.append(rel)

    orphans = [o for o in store
               if o.get("id") not in tracked
               and tag in [str(t).upper() for t in (o.get("tags") or [])]]
    if orphans and not quiet:
        print(f"⚠ {len(orphans)} SCENERY-tagged object(s) on PixelLab that no "
              f"manifest tracks (likely a crash between select-frames and the "
              f"claim commit) — review in the UI, delete or leave:")
        for o in orphans[:10]:
            print(f"    {o.get('id')}  {str(o.get('name'))[:60]}")

    if (deleted or removed or synced) and not dry_run:
        viewer_build.build()
        import loop
        loop.commit_push(f"scenery sync: -{len(deleted)} deleted upstream, "
                         f"-{len(removed)} half-written, {len(synced)} re-mirrored",
                         push=push)
    if not quiet:
        print(f"sync: {len(live_ids)} object(s) on PixelLab; deleted {len(deleted)}, "
              f"pruned {len(removed)}, re-mirrored {len(synced)}, orphans {len(orphans)}")
    return {"deleted": deleted, "removed": removed, "synced": synced,
            "orphans": [o.get("id") for o in orphans]}


def reconcile_light(client, push=True, quiet=False):
    """Cheap per-run reconcile: deletion parity + loose-pointer prune only,
    no conditional re-download sweep."""
    return reconcile(client, push=push, quiet=quiet, mirror=False)


def main():
    ap = argparse.ArgumentParser(description="Reconcile scenery/ with PixelLab.")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    client = PixelLabClient()
    s = reconcile(client, push=not args.no_push, dry_run=args.dry_run)
    print("done:", {k: len(v) for k, v in s.items()})


if __name__ == "__main__":
    main()
