"""Pull characters (and their equipped states) FROM PixelLab into the repo.

PixelLab is the source of truth. The loop creates characters/animations/states;
you can refine any of them by hand in the PixelLab web app (same character_id).
This mirrors the live state back into the repo: base character + every sibling
STATE (equipped variant, shared group_id) — rotations, animations, strips, GIFs,
manifest — rebuilds the viewer and (unless --no-push) pushes to main.

It costs ZERO generations (download only).

Usage:
  python pipeline/sync.py                      # every character
  python pipeline/sync.py --character char_00
  python pipeline/sync.py --skeleton 00_side_64 --no-push
"""

from __future__ import annotations

import argparse
import os
import re

import factory
import viewer_build
import loop
from pixellab_client import PixelLabClient

ROOT = factory.ROOT


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "_", (s or "").lower()).strip("_") or "state"


def _conditional_get(session, url, timeout, if_modified=None):
    """GET an image, optionally conditional. Returns (status, PIL|None, last_mod).
    A 304 (Not Modified) downloads no body — that's how we skip unchanged art."""
    import io
    from PIL import Image
    headers = {"If-Modified-Since": if_modified} if if_modified else {}
    try:
        r = session.get(url, headers=headers, timeout=timeout)
    except Exception:
        return 0, None, if_modified
    if r.status_code == 304:
        return 304, None, if_modified
    if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
        return 200, Image.open(io.BytesIO(r.content)).convert("RGBA"), r.headers.get("Last-Modified")
    return r.status_code, None, if_modified


def _download_frames(client, urls, retries=4):
    """Download all frames; also return the first frame's Last-Modified so the
    next sync can ask 'changed since?' and skip an unchanged direction."""
    frames, first_lm = [], None
    for i, u in enumerate(urls):
        img, lm = None, None
        for _ in range(retries):
            status, img, lm = _conditional_get(client._session, u, client.timeout)
            if img is not None:
                break
        if img is not None:
            frames.append(img)
            if i == 0:
                first_lm = lm
    return frames, first_lm


def _entry_files_exist(entry):
    """True if the local frame files a manifest entry points to are still present
    (so we never 'reuse' an entry whose art was deleted)."""
    paths = entry.get("frame_paths") or []
    if not paths:
        return False
    return all(os.path.exists(os.path.join(factory.ROOT, p)) for p in (paths[0], paths[-1]))


def _best_groups(detail):
    """One animation group per type; for duplicates keep the most-directions one."""
    best = {}
    for a in detail.get("animations", []):
        t = a["animation_type"]
        dirmap = {x["direction"]: x.get("frames", [])
                  for x in a.get("directions", []) if x.get("frames")}
        if t not in best or len(dirmap) >= len(best[t]):
            best[t] = dirmap
    return best


def _mirror_rotations(client, detail, base_dir, canvas):
    rotations = []
    urls = detail.get("rotation_urls") or {}
    for d, url in urls.items():
        if not url:
            continue
        img = client._try_download(url)
        if img is None:
            continue
        factory._save_png(factory._normalize(img, canvas),
                          os.path.join(base_dir, "rotations", f"{d}.png"))
        rotations.append(d)
    if "south" in rotations:
        factory._save_png(factory._normalize(client._try_download(urls["south"]), canvas),
                          os.path.join(base_dir, "portrait.png"))
    return rotations


def _mirror_animations(client, detail, anim_out_dir, canvas, type2key=None, prev_anims=None):
    anims = {}
    type2key = type2key or {}
    prev_anims = prev_anims or {}
    for anim_type, dirmap in _best_groups(detail).items():
        # PixelLab's animation_type is the template id for template animations
        # (e.g. 'breathing-idle'); map it back to our repo key (e.g. 'idle') so
        # synced art lines up with what the loop creates. Unknown types pass
        # through unchanged (e.g. an animation you made by hand in the UI).
        key = type2key.get(anim_type, anim_type)
        prev_dirs = prev_anims.get(key, {})
        saved = {}
        for direction, urls in dirmap.items():
            prev = prev_dirs.get(direction)
            # Skip-unchanged: if we synced this direction before (same source
            # frame count, files still present) and the CDN says the first frame
            # is Not Modified, reuse the existing entry — no download at all.
            if (prev and prev.get("lm") and prev.get("src_frames") == len(urls)
                    and _entry_files_exist(prev)):
                status, _, _ = _conditional_get(client._session, urls[0],
                                                client.timeout, prev["lm"])
                if status == 304:
                    saved[direction] = prev
                    continue
            frames, lm = _download_frames(client, urls)
            if not frames:
                continue
            frames = factory.strip_kept_idle_frame(frames)
            frames = [factory._normalize(f, canvas) for f in frames]
            fdir = os.path.join(anim_out_dir, key, direction)
            factory._save_frames(frames, fdir)
            strip = os.path.join(anim_out_dir, f"{key}__{direction}.png")
            gif = os.path.join(anim_out_dir, f"{key}__{direction}.gif")
            factory._save_strip(frames, strip)
            factory._save_gif(frames, gif)
            saved[direction] = {
                "frames": len(frames), "strip": factory._rel(strip), "gif": factory._rel(gif),
                "frame_paths": [factory._rel(os.path.join(fdir, f"{i:02d}.png"))
                                for i in range(len(frames))],
                "lm": lm, "src_frames": len(urls),
            }
        if saved:
            anims[key] = saved
    return anims


def sync_character(client, sid, char_meta, type2key=None):
    cid_local = char_meta["local_id"]
    cdir = os.path.join(factory.skeleton_dir(sid), "characters", cid_local)
    skmeta = factory._read_json(os.path.join(factory.skeleton_dir(sid), "skeleton.json")) or {}
    canvas = factory.frame_canvas(skmeta.get("params", {"width": 64, "height": 64}))
    detail = client.get_character(char_meta["pixellab_id"])

    rotations = _mirror_rotations(client, detail, cdir, canvas)
    prev_base = char_meta.get("animations", {})
    char_meta["animations"] = _mirror_animations(
        client, detail, os.path.join(cdir, "animations"), canvas, type2key, prev_base)
    if rotations:
        char_meta["rotations"] = sorted(rotations)

    # Outfits: dressed sibling states sharing the base's group_id.
    group = detail.get("group_id")
    outfit_counts = {}
    if group:
        known = {m.get("pixellab_id"): oid for oid, m in char_meta.get("outfits", {}).items()}
        siblings = [c for c in client.list_characters()
                    if c.get("group_id") == group and c.get("id") != char_meta["pixellab_id"]]
        new_outfits = {}
        for sib in siblings:
            spx = sib["id"]
            outfit_id = known.get(spx) or _slug(sib.get("name") or spx)
            sdet = client.get_character(spx)
            odir = os.path.join(cdir, "outfits", outfit_id)
            prev = char_meta.get("outfits", {}).get(outfit_id, {})
            srot = _mirror_rotations(client, sdet, odir, canvas)
            sanims = _mirror_animations(client, sdet, os.path.join(odir, "animations"),
                                        canvas, type2key, prev.get("animations"))
            new_outfits[outfit_id] = {
                **prev, "id": outfit_id, "pixellab_id": spx,
                "name": sib.get("name"),
                "description": prev.get("description") or sib.get("name"),
                "edit_description": prev.get("edit_description"),
                "rotations": sorted(srot), "animations": sanims,
            }
            outfit_counts[outfit_id] = len(sanims)
        char_meta["outfits"] = new_outfits

    char_meta["synced_from_pixellab"] = True
    factory._write_json(factory.character_meta_path(sid, cid_local), char_meta)
    return {k: len(v) for k, v in char_meta["animations"].items()}, outfit_counts


def main():
    ap = argparse.ArgumentParser(description="Mirror characters + states from PixelLab.")
    ap.add_argument("--skeleton")
    ap.add_argument("--character")
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()

    client = PixelLabClient()
    cfg = factory.load_config()
    # PixelLab animation_type -> our repo animation key (template id -> key).
    type2key = {(a.get("template") or a["key"]): a["key"] for a in cfg["animations"]}
    skels = [s for s in factory.list_skeletons()
             if not args.skeleton or s["id"] == args.skeleton]
    total = 0
    for skel in skels:
        sid = skel["id"]
        for ch in factory.list_characters(sid):
            if args.character and ch["local_id"] != args.character:
                continue
            anims, outfits = sync_character(client, sid, ch, type2key)
            n = sum(anims.values()) + sum(outfits.values())
            total += n
            print(f"synced {sid}/{ch['local_id']}: {len(anims)} base animations; "
                  f"{len(outfits)} outfit(s) [{', '.join(f'{k}:{v}anims' for k, v in outfits.items()) or '-'}]")

    viewer_build.build()
    if total:
        loop.commit_push("Sync characters + equipped states from PixelLab",
                         push=not args.no_push)
    print(f"done — {total} direction-clips synced")


if __name__ == "__main__":
    main()
