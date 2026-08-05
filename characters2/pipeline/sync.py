"""characters2 sync — mirror the two DECIDED heroes from PixelLab into the repo.

The heroes are now locked to two specific PixelLab characters (chosen in the UI
and pinned in config.json:pixellab_characters). PixelLab is the **source of
truth**: the user keeps adding animations (and later outfits/models) from the UI.
Re-running this script mirrors the current state down into humans/<name>/ with
ZERO generations — it only downloads what changed.

Layout it writes (per hero):

  humans/default_boy/
    character.json                 # manifest: pixellab id, prompt, style, and the
                                   #   source URL of every file (used for change-detection)
    base/
      south.png … south-west.png   # the static 8-direction model (native 112x112)
      preview.png                  # 8-direction strip
    animations/
      walking/
        south/ 0.png 1.png …       # frames per direction
        north/ …
        preview.gif                # animated preview (first available direction)
      breathing-idle/ …

Efficiency / staying in sync:
  * Each animation carries an `animation_group_id`; if it is unchanged AND the
    frames already exist on disk, the whole animation is skipped (no HTTP).
  * Each base rotation / frame records its source URL in the manifest; a file is
    re-downloaded only when its URL changes (PixelLab URLs are content-addressed,
    so a regenerated asset gets a new URL).
  * It is a true MIRROR: animations / directions / stray frames that no longer
    exist on PixelLab are removed locally, so deletions in the UI propagate.

  python characters2/pipeline/sync.py                 # sync both, commit + push
  python characters2/pipeline/sync.py default_girl    # just one
  python characters2/pipeline/sync.py --no-push
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from collections import Counter

from PIL import Image

from pixellab_client import DIRECTIONS_8, PixelLabClient

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # characters2/
REPO_ROOT = os.path.dirname(ROOT)
HUMANS = os.path.join(ROOT, "humans")
NPCS = os.path.join(ROOT, "npcs")
CONFIG = os.path.join(ROOT, "config.json")
NPC_TAG = "NPC"          # the PixelLab tag that makes a character an NPC (ground truth)


def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def frame_ext():
    """Extension for frame/rotation images — the ONE switch for the PNG->WebP
    migration (`config.json: "frame_format": "png" | "webp"`).

    Still "png" until the game's build-manifest.mjs can decode WebP: it
    hand-parses the PNG IHDR and decodes pixels to measure foot anchors,
    shoulder waterlines and gait rates. Flipping this before that lands would
    detach shadows and float characters. See README (WebP migration)."""
    fmt = (load_config().get("frame_format") or "png").lower().lstrip(".")
    return "." + ("png" if fmt not in ("png", "webp") else fmt)


def save_image(img, path):
    """Save pixel art to `path`, LOSSLESSLY whatever the format.

    Pillow's default WebP encode is LOSSY — saving art with a bare
    `img.save(x.webp)` would quietly resample every sprite and there is no
    louder failure than pixel art that has been through a lossy codec. So WebP
    is always written with lossless=True (method=4: same size as 6, ~76x
    faster — measured over 120 sprites)."""
    img = img.convert("RGBA")
    if path.lower().endswith(".webp"):
        img.save(path, "WEBP", lossless=True, quality=100, method=4)
    else:
        img.save(path)


def hero_metadata(name):
    """Hand-authored metadata record for a character (characters2/metadata.json).

    character.json is REGENERATED on every sync, so authored fields cannot live
    there: they are written in metadata.json and merged back on below. Returns
    the WHOLE record (display_name, species, sex, lore, …) so adding a new field
    to metadata.json needs no change here — it just flows through."""
    data = _read_json(os.path.join(ROOT, "metadata.json"), {}) or {}
    rec = (data.get("characters") or {}).get(name) or {}
    return {k: v for k, v in rec.items() if not k.startswith("_")}


def _slug(name):
    """Filesystem-safe folder slug for a PixelLab animation_type. Animation names
    can contain spaces, commas, NEWLINES and trailing spaces (esp. custom-* ones),
    none of which belong in a directory name."""
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower())
    return s.strip("-") or "anim"


def _assign_slugs(anim_types):
    """Map each raw animation_type -> a stable, unique folder slug. If two distinct
    types slugify to the same base, ALL colliding types get a short content hash
    suffix (deterministic, order-independent) so folder names never churn."""
    bases = {t: _slug(t) for t in anim_types}
    counts = Counter(bases.values())
    out = {}
    for t, b in bases.items():
        out[t] = f"{b}-{hashlib.sha1(t.encode()).hexdigest()[:6]}" if counts[b] > 1 else b
    return out


def _read_json(path, default=None):
    if not os.path.exists(path):
        return default
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return default


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def _dir_key(order, d):
    try:
        return order.index(d)
    except ValueError:
        return len(order)


# --- mirroring one character ------------------------------------------------

def sync_character(client, name, cid, force=False, dest=None):
    """Mirror one PixelLab character (base rotations + all animations) into
    humans/<name>/. Returns a short summary dict.

    force=True re-downloads every frame even when the group-id / URL looks
    unchanged. PixelLab can update an animation IN PLACE (same animation_group_id
    and same frame URLs, new pixels), which the normal fast-skip cannot see, so a
    forced pass is how you pull such edits.

    dest picks the tree: HUMANS (default, the two heroes) or NPCS (the
    tag-driven NPC mirror) — the on-disk shape is identical either way."""
    root = os.path.join(dest or HUMANS, name)
    os.makedirs(root, exist_ok=True)
    prev = _read_json(os.path.join(root, "character.json"), {}) or {}
    prev_rot = (prev.get("rotations") or {})
    prev_anims = (prev.get("animations") or {})

    detail = client.get_character(cid)
    rotation_urls = {d: u for d, u in (detail.get("rotation_urls") or {}).items() if u}
    api_anims = detail.get("animations") or []

    stats = {"rot_new": 0, "rot_skip": 0, "anim_new": 0, "anim_skip": 0, "frames": 0}

    # -- base rotations ------------------------------------------------------
    base_dir = os.path.join(root, "base")
    os.makedirs(base_dir, exist_ok=True)
    saved_rot = {}
    ext = frame_ext()
    for d, url in rotation_urls.items():
        dst = os.path.join(base_dir, f"{d}{ext}")
        if prev_rot.get(d) == url and os.path.exists(dst) and not force:
            saved_rot[d] = url
            stats["rot_skip"] += 1
            continue
        img = client.download_image(url)
        if img is None:
            saved_rot[d] = prev_rot.get(d)          # keep old record if download failed
            continue
        save_image(img, dst)
        saved_rot[d] = url
        stats["rot_new"] += 1
    # drop base images for directions no longer present (any art format)
    for fn in os.listdir(base_dir):
        stem, fext = os.path.splitext(fn)
        if fext in (".png", ".webp") and not stem.startswith("preview") and stem not in rotation_urls:
            os.remove(os.path.join(base_dir, fn))
    _write_base_preview(base_dir, rotation_urls.keys())

    # -- animations ----------------------------------------------------------
    anims_dir = os.path.join(root, "animations")
    os.makedirs(anims_dir, exist_ok=True)
    saved_anims = {}
    seen_slugs = set()
    # PixelLab animation_type is the truth; a slug is only the folder name.
    slug_by_type = _assign_slugs([a.get("animation_type") for a in api_anims
                                  if a.get("animation_type") or a.get("animation_group_id")])
    # prev manifest is keyed by slug; index it by animation_type for skip-detection.
    prev_by_type = {v.get("animation_type", k): v for k, v in prev_anims.items()}
    for a in api_anims:
        atype = a.get("animation_type") or a.get("animation_group_id")
        if not atype:
            continue
        slug = slug_by_type.get(atype) or _slug(atype)
        seen_slugs.add(slug)
        gid = a.get("animation_group_id")
        adir = os.path.join(anims_dir, slug)
        dirs_payload = a.get("directions") or []
        # map direction -> list of frame urls. PixelLab can transiently return
        # DUPLICATE entries for a direction while it regenerates an animation in
        # place (an old copy + a new one); when that happens, keep the NEWEST by
        # Last-Modified rather than whatever came last in the list.
        entries = {}
        for dp in dirs_payload:
            dd = dp.get("direction")
            frames = [u for u in (dp.get("frames") or []) if u]
            if dd and frames:
                entries.setdefault(dd, []).append(frames)
        want = {}
        for dd, cands in entries.items():
            if len(cands) == 1:
                want[dd] = cands[0]
            else:
                best, best_lm = cands[0], None
                for fr in cands:
                    lm = client.last_modified(fr[0])
                    if lm is not None and (best_lm is None or lm > best_lm):
                        best, best_lm = fr, lm
                want[dd] = best
                print(f"    · {slug}/{dd}: {len(cands)} duplicate entries — kept newest "
                      f"({best_lm})")

        prev_a = prev_by_type.get(atype) or {}
        unchanged = (not force and prev_a.get("animation_group_id") == gid and gid is not None
                     and _anim_on_disk(adir, want))
        if unchanged:
            saved_anims[slug] = {**prev_a, "animation_type": atype}
            stats["anim_skip"] += 1
            _write_anim_preview(adir, want.keys())
            continue

        os.makedirs(adir, exist_ok=True)
        rec_dirs = {}
        for dd, frames in want.items():
            ddir = os.path.join(adir, dd)
            os.makedirs(ddir, exist_ok=True)
            for i, url in enumerate(frames):
                dst = os.path.join(ddir, f"{i}{ext}")
                img = client.download_image(url)
                if img is None:
                    continue
                save_image(img, dst)
                stats["frames"] += 1
            # trim stray frames beyond current frame_count (any art format)
            for fn in os.listdir(ddir):
                idx, fext = os.path.splitext(fn)
                if fext in (".png", ".webp") and idx.isdigit() and int(idx) >= len(frames):
                    os.remove(os.path.join(ddir, fn))
            rec_dirs[dd] = {"frame_count": len(frames), "frames": frames}
        # drop direction folders no longer present
        for fn in os.listdir(adir):
            p = os.path.join(adir, fn)
            if os.path.isdir(p) and fn not in want:
                shutil.rmtree(p)
        _write_anim_preview(adir, want.keys())
        saved_anims[slug] = {
            "animation_type": atype,
            "animation_group_id": gid,
            "display_name": a.get("display_name"),
            "directions": rec_dirs,
        }
        stats["anim_new"] += 1

    # drop animation folders no longer on PixelLab (true mirror)
    for fn in os.listdir(anims_dir):
        p = os.path.join(anims_dir, fn)
        if os.path.isdir(p) and fn not in seen_slugs:
            shutil.rmtree(p)

    _write_json(os.path.join(root, "character.json"), {
        "id": name,
        "pixellab_character_id": cid,
        # PixelLab's own name — prompt junk ("Improve transparency"), kept for
        # traceability. The human-facing one is `display_name` from metadata.json.
        "name": detail.get("name"),
        # Hand-authored fields (display_name, species, sex, lore, …) merged from
        # metadata.json so regenerating this file never loses them. Merged
        # WHOLESALE: a new field there needs no change here.
        **hero_metadata(name),
        # PixelLab's raw generation prompt. NOT authoritative and NOT a
        # description: both heroes carry the same copy-pasted text there (it says
        # "female" for both, because the boy was created by duplicating the girl),
        # so it was renamed off `prompt` to stop consumers reading it as truth —
        # the authored facts live in metadata.json. Mirrored for traceability only.
        "pixellab_prompt": detail.get("prompt"),
        "size": [detail.get("size", {}).get("width"), detail.get("size", {}).get("height")],
        "view": detail.get("view"),
        "template_id": detail.get("template_id"),
        "style_settings": detail.get("style_settings"),
        "group_id": detail.get("group_id"),
        "directions": detail.get("directions"),
        "rotations": saved_rot,
        "animations": saved_anims,
        "source": "pixellab.ai character (mirrored by sync.py; PixelLab is source of truth)",
    })
    return stats


def _anim_on_disk(adir, want):
    """True if every wanted direction/frame already exists on disk."""
    for dd, frames in want.items():
        ddir = os.path.join(adir, dd)
        for i in range(len(frames)):
            if not os.path.exists(os.path.join(ddir, f"{i}{frame_ext()}")):
                return False
    return True


def _write_base_preview(base_dir, dirs):
    order = [d for d in DIRECTIONS_8 if d in dirs]
    imgs = []
    for d in order:
        p = os.path.join(base_dir, f"{d}{frame_ext()}")
        if os.path.exists(p):
            imgs.append(Image.open(p).convert("RGBA"))
    if not imgs:
        return
    w = max(i.width for i in imgs); h = max(i.height for i in imgs)
    strip = Image.new("RGBA", (w * len(imgs), h), (0, 0, 0, 0))
    for i, im in enumerate(imgs):
        strip.alpha_composite(im, (i * w, 0))
    save_image(strip, os.path.join(base_dir, "preview" + frame_ext()))


def _write_anim_preview(adir, dirs):
    """Animated GIF of the first available direction (south preferred)."""
    order = [d for d in DIRECTIONS_8 if d in dirs] or list(dirs)
    if not order:
        return
    d = order[0]
    ddir = os.path.join(adir, d)
    if not os.path.isdir(ddir):
        return
    ext = frame_ext()
    idxs = sorted(int(os.path.splitext(f)[0]) for f in os.listdir(ddir)
                  if os.path.splitext(f)[1] == ext and os.path.splitext(f)[0].isdigit())
    frames = [Image.open(os.path.join(ddir, f"{i}{ext}")).convert("RGBA") for i in idxs]
    if len(frames) < 2:
        return
    bg = [Image.new("RGBA", f.size, (0, 0, 0, 0)) for f in frames]
    for b, f in zip(bg, frames):
        b.alpha_composite(f)
    bg[0].save(os.path.join(adir, "preview.gif"), save_all=True,
               append_images=bg[1:], duration=120, loop=0, disposal=2)


# --- git --------------------------------------------------------------------

def _git(*args, check=True):
    return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=check)


def commit_push(message, push=True):
    _git("add", "-A", "characters2")
    if not _git("status", "--porcelain", "--", "characters2").stdout.strip():
        return False
    _git("commit", "-m", message)
    if push:
        import time
        branch = _git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or "main"
        for attempt in range(5):
            if _git("push", "origin", branch, check=False).returncode == 0:
                return True
            # Contention (e.g. the scheduled sync pushed meanwhile). Integrate the
            # remote WITHOUT a rebase that can stall on the auto-generated manifest:
            # clear any half-finished op, then MERGE favouring our fresh sync. The
            # mirror is eventually-consistent, so 'ours' is safe and never conflicts.
            _git("rebase", "--abort", check=False)
            _git("merge", "--abort", check=False)
            _git("fetch", "origin", branch, check=False)
            _git("merge", "-X", "ours", f"origin/{branch}",
                 "-m", f"characters2: merge origin/{branch} (auto-sync)", check=False)
            time.sleep(2 ** attempt)
    return True


# --- NPCs (tag-driven mirror) -------------------------------------------------

def npc_folder(cid, taken):
    """Folder name for an NPC: the first 8 hex chars of its PixelLab id.

    PixelLab NPC names are duplicate prompt junk ('light armor with sho (copy
    4)' x7), so names cannot key folders; the id prefix is stable across renames
    and today collision-free across all 191. If a prefix ever collides, extend
    with more of the id until unique."""
    n = 8
    while cid[:n] in taken and n < len(cid):
        n += 1
    return cid[:n]


def list_npcs(client):
    """Every character on PixelLab carrying the NPC tag (case-insensitive).
    The tag is the ground truth for what an NPC is — same model as the
    monsters domain's MONSTER tag."""
    return [c for c in client.list_characters()
            if any((t or "").upper() == NPC_TAG for t in (c.get("tags") or []))]


def sync_npcs(client, force=False):
    """Mirror ALL NPC-tagged PixelLab characters into npcs/<id8>/ and PRUNE any
    folder whose character lost the tag or was deleted (true mirror). Also
    writes npcs/index.json (characters2-npcs@1) so consumers can enumerate NPCs
    without walking the tree."""
    os.makedirs(NPCS, exist_ok=True)
    npcs = list_npcs(client)

    # id-prefix folder per NPC, resolved against the whole set at once
    folders = {}
    for c in sorted(npcs, key=lambda c: c["id"]):
        folders[c["id"]] = npc_folder(c["id"], set(folders.values()))

    totals = {"npcs": len(npcs), "rot_new": 0, "anim_new": 0, "frames": 0, "skipped": 0}
    index = {}
    for i, c in enumerate(sorted(npcs, key=lambda c: c["id"]), 1):
        cid = c["id"]; folder = folders[cid]
        s = sync_character(client, folder, cid, force=force, dest=NPCS)
        totals["rot_new"] += s["rot_new"]; totals["anim_new"] += s["anim_new"]
        totals["frames"] += s["frames"]
        if not (s["rot_new"] or s["anim_new"]):
            totals["skipped"] += 1
        man = _read_json(os.path.join(NPCS, folder, "character.json"), {}) or {}
        index[folder] = {
            "pixellab_character_id": cid,
            "name": c.get("name"),
            "animations": sorted((man.get("animations") or {}).keys()),
        }
        if i % 25 == 0 or i == len(npcs):
            print(f"  npcs: {i}/{len(npcs)} mirrored "
                  f"(+{totals['frames']} frames so far)", flush=True)

    # prune folders whose character is no longer NPC-tagged on PixelLab
    keep = set(folders.values())
    pruned = []
    for fn in sorted(os.listdir(NPCS)):
        p = os.path.join(NPCS, fn)
        if os.path.isdir(p) and fn not in keep:
            shutil.rmtree(p); pruned.append(fn)
    if pruned:
        print(f"  npcs: pruned {len(pruned)} no-longer-tagged: {pruned[:8]}"
              f"{'…' if len(pruned) > 8 else ''}")

    _write_json(os.path.join(NPCS, "index.json"), {
        "format": "characters2-npcs@1",
        "_comment": "Roll-up of the tag-driven NPC mirror: every PixelLab "
                    "character tagged NPC, keyed by its npcs/<folder>. The tag "
                    "is the ground truth — sync.py prunes untagged folders. "
                    "`name` is PixelLab prompt junk; authored facts belong in "
                    "characters2/metadata.json under the same folder key.",
        "count": len(index),
        "npcs": index,
    })
    totals["pruned"] = len(pruned)
    return totals


# --- main -------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Mirror the two heroes (+ animations) from PixelLab.")
    ap.add_argument("names", nargs="*", help="Which heroes to sync (default: all pinned).")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="Re-download every frame even if group-id/URL look unchanged "
                         "(catches PixelLab IN-PLACE animation edits).")
    args = ap.parse_args()

    cfg = load_config()
    pins = cfg.get("pixellab_characters") or {}
    if not pins:
        raise SystemExit("config.json:pixellab_characters is empty — nothing to sync.")
    # Default pass = the two pinned heroes, then the tag-driven NPC set.
    # `sync.py npcs` runs just the NPCs; `sync.py default_girl` just one hero.
    targets = args.names or (list(pins.keys()) + ["npcs"])

    client = PixelLabClient()
    for name in targets:
        if name == "npcs":
            print(f"+ syncing NPCs (every PixelLab character tagged {NPC_TAG})"
                  f"{' (FORCE)' if args.force else ''}")
            t = sync_npcs(client, force=args.force)
            print(f"  npcs: {t['npcs']} mirrored | +{t['frames']} frames | "
                  f"{t['skipped']} unchanged | {t['pruned']} pruned")
            commit_push(f"characters2: sync {t['npcs']} NPCs from PixelLab "
                        f"(+{t['frames']} frames, {t['pruned']} pruned)",
                        push=not args.no_push)
            continue
        cid = pins.get(name)
        if not cid:
            print(f"! {name}: not pinned in config, skipping")
            continue
        print(f"+ syncing {name} <- {cid}{' (FORCE)' if args.force else ''}")
        s = sync_character(client, name, cid, force=args.force)
        print(f"  {name}: rotations +{s['rot_new']}/skip {s['rot_skip']} | "
              f"animations +{s['anim_new']}/skip {s['anim_skip']} | {s['frames']} frames downloaded")
        commit_push(f"characters2: sync {name} from PixelLab "
                    f"(+{s['anim_new']} anims, +{s['frames']} frames)", push=not args.no_push)

    print("done.")


if __name__ == "__main__":
    main()
