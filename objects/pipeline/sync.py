"""Mirror PixelLab objects into the repo — the object analogue of the characters
agent's sync, now that objects genuinely persist (create-8-direction-object).

PixelLab is the live source of truth for an object's `pixellab_object_id`. You can
open any object in the create-object web tool and press **regenerate**; this
pulls the new art down into the repo — and, like the characters agent, it only
re-downloads frames whose `Last-Modified` changed (`If-Modified-Since` -> 304
skip), so an unchanged object costs almost nothing.

It also keeps the two ends consistent:
  - **Deletion parity:** an object deleted on PixelLab (or gone 404) is removed
    from the repo; a tracked object missing locally is re-mirrored.
  - **No loose pointers:** manifest/viewer references to missing files are pruned.

Costs ZERO generations (download only).

Usage:
  python objects/pipeline/sync.py                 # mirror everything, push
  python objects/pipeline/sync.py --no-push
  python objects/pipeline/sync.py --dry-run       # report only
"""

from __future__ import annotations

import argparse
import os
import shutil

import factory
import viewer_build
import loop
from pixellab_client import DIRECTIONS_8, PixelLabClient, PixelLabError

ROOT = factory.ROOT


def _iter_manifests():
    out = []
    for name in sorted(os.listdir(ROOT)):
        if name in factory.RESERVED_DIRS or name.startswith("."):
            continue
        meta = factory.read_manifest(name)
        if meta:
            out.append((name, meta))
    return out


def _exists(rel):
    return bool(rel) and os.path.exists(os.path.join(ROOT, rel))


# --- change-detecting frame download ----------------------------------------

def _download_series(client, urls, prev=None):
    """Download a list of frame URLs -> ([PIL], last_modified). Skips the whole
    series (returns None) when it's unchanged: same source count and the first
    frame reports 304 Not Modified since we last synced it."""
    prev = prev or {}
    if prev.get("lm") and prev.get("src_frames") == len(urls):
        status, _, _ = client.conditional_download(urls[0], prev["lm"])
        if status == 304:
            return None, prev.get("lm")
    frames, lm = [], None
    for i, u in enumerate(urls):
        img = None
        for _ in range(4):
            status, img, got = client.conditional_download(u)
            if img is not None:
                if i == 0:
                    lm = got
                break
        if img is not None:
            frames.append(img)
    return frames, lm


def _best_groups(detail):
    """One merged group per display_name/description, unioned across duplicate
    groups — for each direction keep the version with the most frames. De-dupes
    the duplicate groups PixelLab creates and recovers split animations."""
    best = {}
    for a in detail.get("animations", []):
        key = a.get("display_name") or factory._slug(a.get("description")) or a.get("animation_group_id")
        g = best.setdefault(key, {"group_id": a.get("animation_group_id"),
                                  "description": a.get("description"), "dirs": {}})
        for x in a.get("directions", []):
            d = x.get("direction")
            fr = (x.get("storage_urls") or {}).get("frames") or []
            if d and fr and len(fr) > len(g["dirs"].get(d, [])):
                g["dirs"][d] = fr
    return best


# --- mirror one object ------------------------------------------------------

def mirror_object(client, oid, meta, dry_run=False):
    """Pull rotations + animations for one tracked object from PixelLab into the
    repo, skipping unchanged art. Returns 'deleted' if it vanished on PixelLab."""
    pid = meta.get("pixellab_object_id")
    if not pid:
        return "untracked"
    try:
        detail = client.get_object(pid)
    except PixelLabError as e:
        if "404" in str(e):
            return "deleted"
        raise
    size = meta.get("size", 64)
    odir = factory.object_dir(oid)

    # rotations
    rots = {}
    for d, url in (detail.get("rotation_urls") or {}).items():
        if not url:
            continue
        img = client._download(url)
        if img is None:
            continue
        if not dry_run:
            factory._save_png(factory._normalize(img, size), os.path.join(odir, "rotations", f"{d}.png"))
        rots[d] = factory._rel(os.path.join(odir, "rotations", f"{d}.png"))
    if "south" in rots and not dry_run:
        south = client._download(detail["rotation_urls"]["south"])
        if south is not None:
            factory._save_png(factory._normalize(south, size), os.path.join(odir, "sprite.png"))

    # animations (change-detected)
    prev_anims = meta.get("animations") or {}
    anims = {}
    for key, g in _best_groups(detail).items():
        prev_dirs = (prev_anims.get(key) or {}).get("directions") or {}
        saved = {}
        for direction, urls in g["dirs"].items():
            frames, lm = _download_series(client, urls, prev_dirs.get(direction))
            if frames is None and _exists((prev_dirs.get(direction) or {}).get("gif")):
                saved[direction] = prev_dirs[direction]      # unchanged -> reuse
                continue
            if not frames:
                continue
            frames = [factory._normalize(f, size) for f in frames]
            if not dry_run:
                fdir = os.path.join(odir, "animations", key, direction)
                factory._save_frames(frames, fdir)
                strip = os.path.join(odir, "animations", f"{key}__{direction}.png")
                gif = os.path.join(odir, "animations", f"{key}__{direction}.gif")
                factory._save_strip(frames, strip)
                factory._save_gif(frames, gif)
            saved[direction] = {
                "frames": len(frames),
                "strip": factory._rel(os.path.join(odir, "animations", f"{key}__{direction}.png")),
                "gif": factory._rel(os.path.join(odir, "animations", f"{key}__{direction}.gif")),
                "frame_paths": [factory._rel(os.path.join(odir, "animations", key, direction, f"{i:02d}.png"))
                                for i in range(len(frames))],
                "lm": lm, "src_frames": len(urls),
            }
        if saved:
            anims[key] = {"group_id": g["group_id"], "description": g["description"],
                          "directions": saved}

    if not dry_run:
        meta["rotations"] = rots
        meta["directions"] = sorted(rots)
        meta["animations"] = anims
        meta["synced_from_pixellab"] = True
        factory.write_manifest(oid, meta)
    return "synced"


# --- repo integrity ---------------------------------------------------------

def prune_loose_pointers(dry_run=False):
    removed, pruned = [], []
    for oid, meta in _iter_manifests():
        if not os.path.exists(os.path.join(factory.object_dir(oid), "sprite.png")):
            removed.append(oid)
            if not dry_run:
                shutil.rmtree(factory.object_dir(oid), ignore_errors=True)
            continue
        changed = False
        for key, a in list((meta.get("animations") or {}).items()):
            dirs = a.get("directions") or {}
            live = {d: v for d, v in dirs.items() if _exists(v.get("gif"))}
            if live != dirs:
                pruned.append(f"{oid}: animation '{key}' pruned to {len(live)} dir(s)")
                if live:
                    a["directions"] = live
                else:
                    del meta["animations"][key]
                changed = True
        if changed and not dry_run:
            factory.write_manifest(oid, meta)
    return removed, pruned


# --- orchestration ----------------------------------------------------------

def sync_all(client, push=True, quiet=False, dry_run=False):
    live_ids = {o.get("id") for o in client.list_objects()}
    synced, deleted = [], []
    for oid, meta in _iter_manifests():
        pid = meta.get("pixellab_object_id")
        if not pid:
            continue
        # deletion parity: gone from the store -> drop the repo folder
        if pid not in live_ids:
            result = mirror_object(client, oid, meta, dry_run=True)  # confirm via 404
            if result == "deleted" or pid not in live_ids:
                deleted.append(oid)
                if not dry_run:
                    shutil.rmtree(factory.object_dir(oid), ignore_errors=True)
                continue
        if mirror_object(client, oid, meta, dry_run) == "synced":
            synced.append(oid)

    removed, pruned = prune_loose_pointers(dry_run)
    if not quiet:
        print(f"sync: {len(live_ids)} object(s) on PixelLab; synced {len(synced)}, "
              f"deleted {len(deleted)} (removed on PixelLab), pruned {len(pruned)} dead ref(s)")
    if not dry_run:
        viewer_build.build()
        loop.commit_push("objects sync: mirror PixelLab objects (regenerations + deletions)",
                         push=push)
    return {"synced": synced, "deleted": deleted, "pruned": pruned, "live": len(live_ids)}


def main():
    ap = argparse.ArgumentParser(description="Mirror PixelLab objects into the repo.")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    client = PixelLabClient()
    s = sync_all(client, push=not args.no_push, dry_run=args.dry_run)
    print("done:", {k: (len(v) if isinstance(v, list) else v) for k, v in s.items()})


if __name__ == "__main__":
    main()
