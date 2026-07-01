"""Keep the objects repo and PixelLab consistent — no loose pointers.

How this differs from the characters agent's sync (and why):

  characters/ persist on PixelLab under a character_id — you can edit them in the
  web app and `characters/pipeline/sync.py` mirrors those edits back down, only
  re-downloading frames whose Last-Modified changed (If-Modified-Since -> 304
  skip). That works because there is a live server-side copy to pull from.

  objects/ do NOT persist on PixelLab: the loop uses the *stateless* image
  endpoints (pixflux / rotate / animate-with-text), and the object store has no
  create endpoint (POST /v2/objects -> 405). So there is nothing server-side to
  "download again" for a generated object — the repo is the source of truth.

What this module therefore keeps in sync, automatically (run each loop pass):

  1. Repo integrity ("no loose pointers"): every path a manifest / the viewer
     points at must exist. Missing frames/strips/gifs are pruned from the
     manifest; an object whose sprite is gone is removed entirely. The viewer is
     rebuilt from the cleaned manifests, so it can never reference a dead file.

  2. PixelLab -> repo deletion parity: if an object the repo mirrored from the
     PixelLab UI (tagged with `pixellab_object_id`) is deleted on PixelLab, its
     repo folder is removed too — the "removed on one end -> removed on the other"
     rule. Generated objects (no `pixellab_object_id`) are never touched by this.

  3. UI-authored objects: anything a human makes in the PixelLab Object creator is
     mirrored into the repo (best-effort, with the same Last-Modified change
     detection), so hand-made objects flow in. Objects it can't fully import are
     reported rather than left as a silent gap.

Costs ZERO generations (read/delete + downloads only).

Usage:
  python objects/pipeline/sync.py                 # reconcile everything, push
  python objects/pipeline/sync.py --no-push
  python objects/pipeline/sync.py --dry-run       # report only, change nothing
"""

from __future__ import annotations

import argparse
import os
import re
import shutil

import factory
import viewer_build
import loop
from pixellab_client import PixelLabClient

ROOT = factory.ROOT


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "_", (s or "").lower()).strip("_") or "object"


def _iter_manifests():
    """(oid, meta) for every object folder that has an object.json."""
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


# --- 1. repo integrity: prune loose pointers --------------------------------

def prune_loose_pointers(dry_run=False):
    """Make every manifest reference only files that exist on disk, and drop any
    object whose sprite is gone. Returns (removed_objects, pruned_entries)."""
    removed, pruned = [], []
    for oid, meta in _iter_manifests():
        odir = factory.object_dir(oid)

        # Core art gone -> the object is a dead pointer; remove it wholesale.
        if not os.path.exists(os.path.join(odir, "sprite.png")):
            removed.append(oid)
            if not dry_run:
                shutil.rmtree(odir, ignore_errors=True)
            continue

        changed = False
        # Rotations: keep only directions whose PNG is present.
        rot = meta.get("rotations") or {}
        files = rot.get("files") or {}
        live_files = {d: p for d, p in files.items() if _exists(p)}
        if live_files != files:
            for d in [d for d in files if d not in live_files]:
                pruned.append(f"{oid}: rotation '{d}' (missing file)")
            rot["files"] = live_files
            rot["directions"] = sorted(live_files)
            meta["rotations"] = rot
            changed = True

        # Animations: an entry is valid only if its gif, strip and frames exist.
        anims = meta.get("animations") or {}
        for key in list(anims.keys()):
            a = anims[key]
            frames = a.get("frame_paths") or []
            ok = _exists(a.get("gif")) and _exists(a.get("strip")) \
                and frames and _exists(frames[0]) and _exists(frames[-1])
            if not ok:
                pruned.append(f"{oid}: animation '{key}' (missing files)")
                del anims[key]
                changed = True
        meta["animations"] = anims

        if changed and not dry_run:
            factory.write_manifest(oid, meta)
    return removed, pruned


# --- 2. PixelLab <-> repo reconciliation ------------------------------------

def _repo_by_pixellab_id():
    """{pixellab_object_id: oid} for repo objects mirrored from the PixelLab UI."""
    out = {}
    for oid, meta in _iter_manifests():
        pid = meta.get("pixellab_object_id")
        if pid:
            out[pid] = oid
    return out


def reconcile_deletions(live_ids, dry_run=False):
    """Deletion parity: remove any repo object that was mirrored from PixelLab
    (`pixellab_object_id`) but no longer exists there. Generated objects have no
    such id and are never affected. Returns the oids removed."""
    removed = []
    for pid, oid in _repo_by_pixellab_id().items():
        if pid not in live_ids:
            removed.append(oid)
            if not dry_run:
                shutil.rmtree(factory.object_dir(oid), ignore_errors=True)
    return removed


def _find_image_urls(detail):
    """Defensively pull downloadable image URL(s) out of an object detail, whose
    exact schema we don't control. Looks for obvious url/image fields and any
    frame lists. Returns an ordered list of (label, url)."""
    urls = []

    def walk(obj, label):
        if isinstance(obj, str) and obj.startswith("http"):
            urls.append((label, obj))
        elif isinstance(obj, dict):
            for k, v in obj.items():
                if any(t in k.lower() for t in ("url", "image", "frame", "sprite")):
                    walk(v, k)
        elif isinstance(obj, list):
            for i, v in enumerate(obj):
                walk(v, f"{label}_{i}")

    walk(detail, "object")
    # de-dup, preserve order
    seen, out = set(), []
    for label, u in urls:
        if u not in seen:
            seen.add(u)
            out.append((label, u))
    return out


def mirror_ui_object(client, obj, dry_run=False):
    """Best-effort import of a UI-authored PixelLab object into the repo, with
    Last-Modified change detection. Saves the first image as sprite.png and tags
    the manifest with its pixellab_object_id + source. Returns the oid, or None if
    nothing importable was found (the caller reports those)."""
    pid = obj.get("id")
    name = obj.get("name") or pid
    oid = f"ui_{_slug(name)}"[:48]
    detail = client.get_object(pid)
    urls = _find_image_urls(detail)
    if not urls:
        return None
    prev = factory.read_manifest(oid) or {}
    prev_lm = prev.get("_lm")
    status, img, lm = client.conditional_download(urls[0][1], prev_lm)
    if status == 304 and factory.has_base(oid):
        return oid  # unchanged, already mirrored
    if img is None:
        return None
    if not dry_run:
        factory._save_png(img, os.path.join(factory.object_dir(oid), "sprite.png"))
        meta = {
            "id": oid, "name": name, "category": "misc",
            "description": f"authored in the PixelLab Object creator ({name})",
            "size": [img.width, img.height],
            "sprite": factory._rel(os.path.join(factory.object_dir(oid), "sprite.png")),
            "rotations": {"count": 0, "directions": []}, "animations": {},
            "source": "pixellab.ai Object creator (synced)",
            "pixellab_object_id": pid, "_lm": lm, "status": "complete",
        }
        factory.write_manifest(oid, meta)
    return oid


# --- orchestration ----------------------------------------------------------

def sync_all(client, push=True, quiet=False, dry_run=False, mirror=True):
    """Reconcile the repo with PixelLab and with itself, rebuild the viewer, and
    commit. Zero generations. Returns a summary dict."""
    removed_missing, pruned = prune_loose_pointers(dry_run)

    live = client.list_objects()
    live_ids = {o.get("id") for o in live}
    removed_deleted = reconcile_deletions(live_ids, dry_run)

    mirrored, unimportable = [], []
    tracked = set(_repo_by_pixellab_id())
    if mirror:
        for obj in live:
            if obj.get("id") in tracked:
                continue
            oid = mirror_ui_object(client, obj, dry_run)
            (mirrored if oid else unimportable).append(obj.get("name") or obj.get("id"))

    summary = {
        "removed_missing_sprite": removed_missing,
        "pruned_entries": pruned,
        "removed_deleted_on_pixellab": removed_deleted,
        "mirrored_ui_objects": mirrored,
        "unimportable_ui_objects": unimportable,
        "pixellab_object_count": len(live),
    }
    if not quiet:
        print(f"sync: {len(live)} object(s) on PixelLab; "
              f"repo pruned {len(pruned)} dead ref(s), removed "
              f"{len(removed_missing) + len(removed_deleted)} object(s), "
              f"mirrored {len(mirrored)} UI object(s)")
        for u in unimportable:
            print(f"  ! UI object not auto-importable (reported): {u}")

    if not dry_run:
        viewer_build.build()
        loop.commit_push("objects sync: reconcile repo <-> PixelLab (no loose pointers)",
                         push=push)
    return summary


def main():
    ap = argparse.ArgumentParser(description="Reconcile the objects repo with PixelLab.")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="Report only; change nothing.")
    ap.add_argument("--no-mirror", action="store_true",
                    help="Don't import UI-authored objects, only reconcile/prune.")
    args = ap.parse_args()
    client = PixelLabClient()
    s = sync_all(client, push=not args.no_push, dry_run=args.dry_run, mirror=not args.no_mirror)
    print("done:", {k: (len(v) if isinstance(v, list) else v) for k, v in s.items()})


if __name__ == "__main__":
    main()
