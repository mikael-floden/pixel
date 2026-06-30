"""Pull a character's animations/rotations FROM PixelLab into the repo.

PixelLab is the source of truth for a character's art: the loop creates the
initial animations, and you can refine any of them by hand in the PixelLab web
app (it edits the same character_id). This command mirrors that live state back
into the repo — it downloads the current frames, repackages them (per-direction
strips + preview GIFs), updates character.json, rebuilds the viewer, and (unless
--no-push) commits + pushes to main.

It costs ZERO generations — it only downloads what already exists on PixelLab.

Usage:
  python pipeline/sync.py                      # sync every character
  python pipeline/sync.py --character char_00  # one character
  python pipeline/sync.py --skeleton 00_side_64 --no-push
"""

from __future__ import annotations

import argparse
import os

import factory
import viewer_build
import loop
from pixellab_client import PixelLabClient

ROOT = factory.ROOT


def _download_frames(client, urls, retries=4):
    frames = []
    for u in urls:
        img = None
        for _ in range(retries):
            img = client._try_download(u)
            if img is not None:
                break
        if img is not None:
            frames.append(img)
    return frames


def _best_groups(detail):
    """Pick one animation group per type. If a type has duplicate groups (e.g.
    re-animated), keep the one covering the most directions (ties: the later)."""
    best = {}
    for a in detail.get("animations", []):
        t = a["animation_type"]
        dirmap = {x["direction"]: x.get("frames", [])
                  for x in a.get("directions", []) if x.get("frames")}
        if t not in best or len(dirmap) >= len(best[t]):
            best[t] = dirmap
    return best


def sync_character(client, sid, char_meta):
    cid_local = char_meta["local_id"]
    cdir = os.path.join(factory.skeleton_dir(sid), "characters", cid_local)
    detail = client.get_character(char_meta["pixellab_id"])

    # Rotations.
    rotations = []
    for direction, url in (detail.get("rotation_urls") or {}).items():
        if not url:
            continue
        img = client._try_download(url)
        if img is None:
            continue
        factory._save_png(img, os.path.join(cdir, "rotations", f"{direction}.png"))
        rotations.append(direction)
    if "south" in rotations:
        factory._save_png(client._try_download(detail["rotation_urls"]["south"]),
                          os.path.join(cdir, "portrait.png"))

    # Animations (mirror PixelLab; replaces the animations section).
    anims = {}
    counts = {}
    for key, dirmap in _best_groups(detail).items():
        saved = {}
        for direction, urls in dirmap.items():
            frames = _download_frames(client, urls)
            if not frames:
                continue
            fdir = os.path.join(cdir, "animations", key, direction)
            frame_paths = factory._save_frames(frames, fdir)
            strip = os.path.join(cdir, "animations", f"{key}__{direction}.png")
            factory._save_strip(frames, strip)
            gif = os.path.join(cdir, "animations", f"{key}__{direction}.gif")
            factory._save_gif(frames, gif)
            saved[direction] = {
                "frames": len(frames),
                "strip": os.path.relpath(strip, ROOT),
                "gif": os.path.relpath(gif, ROOT),
                "frame_paths": [os.path.relpath(p, ROOT) for p in frame_paths],
            }
        if saved:
            anims[key] = saved
            counts[key] = len(saved)

    char_meta["animations"] = anims
    if rotations:
        char_meta["rotations"] = sorted(rotations)
    char_meta["synced_from_pixellab"] = True
    factory._write_json(factory.character_meta_path(sid, cid_local), char_meta)
    return counts


def main():
    ap = argparse.ArgumentParser(description="Mirror character art from PixelLab into the repo.")
    ap.add_argument("--skeleton", help="Only this skeleton id")
    ap.add_argument("--character", help="Only this character local_id (e.g. char_00)")
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()

    client = PixelLabClient()
    skels = [s for s in factory.list_skeletons()
             if not args.skeleton or s["id"] == args.skeleton]
    total = 0
    for skel in skels:
        sid = skel["id"]
        for ch in factory.list_characters(sid):
            if args.character and ch["local_id"] != args.character:
                continue
            counts = sync_character(client, sid, ch)
            n = sum(counts.values())
            total += n
            print(f"synced {sid}/{ch['local_id']}: "
                  f"{len(counts)} animations, {n} direction-clips "
                  f"({', '.join(f'{k}:{v}' for k, v in counts.items())})")

    viewer_build.build()
    if total:
        loop.commit_push("Sync character art from PixelLab (manual edits)",
                         push=not args.no_push)
    print(f"done — {total} direction-clips synced")


if __name__ == "__main__":
    main()
