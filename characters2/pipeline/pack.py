#!/usr/bin/env python3
"""THE PACKED LAYER — every NPC's art cut to ONE box per NPC, for games2
(games2/scripts/build-npcs-manifest.mjs points at these; the wiki, the previews
and verify_sync.py keep reading the raw files; nothing here changes a raw file).

WHY (measured 2026-09-12 over all 191 NPCs, 4,436 files): PixelLab draws every
character on a 112x112 canvas and a body fills 38% of it. The game loads each
rotation and each idle frame as its own texture and pays for the whole
canvas in decode, upload and video memory — 223 MB of decoded texels for the
roster where 84 MB are art.

ONE BOX PER NPC, not per file: the union of the opaque boxes of every file
the NPC has (8 rotations, every frame of every animation, every direction),
+1 px. The game draws an NPC as ONE sprite whose origin is the measured foot
anchor of its rotation, expressed as a fraction of the frame, and swaps
rotations and idle frames under that one origin — so every texture of the NPC
must be the same size with the art at the same offset, or the body would
jump when it turns or breathes. The manifest builder measures the anchors on
the RAW frames (footAnchor's band and lift scale with the frame height) and
converts them into the packed frame, so the anchor is the same pixel.

THE CACHE LAW (CLAUDE.md): a regenerable published asset is never rewritten
under a stable name. A packed file is `packed/<same subpath>.<sha8>.webp`
beside the NPC, `packed/index.json` names the current file per raw path and
the NPC's box, and the PREVIOUS generation is kept (current + one back) so
an open page keeps rendering through a deploy. sync.py never touches
`packed/` (it prunes inside base/ and animations/ only).

    python3 characters2/pipeline/pack.py            # every NPC, only what changed
    python3 characters2/pipeline/pack.py --only 06e4eb08,3749cceb
    python3 characters2/pipeline/pack.py --check    # exit 1 if any NPC is stale

Resumable and idempotent: an NPC whose raw bytes all hash to what its index
recorded (`src`) is skipped. Lossless WebP, exact, method 4 — sync.py's own
save_image settings (README: method 6 matched 4's size to within 0.1% at 76x
the time)."""
import argparse
import hashlib
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from io import BytesIO

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # characters2/
NPCS = os.path.join(ROOT, "npcs")
SCHEMA = "characters2-packed@1"
MARGIN = 1  # px around the union box, so a filtered edge never clips
ART_EXT = ".webp"


def sha8(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:8]


def encode_webp(img: Image.Image) -> bytes:
    """sync.py's save_image settings, to bytes: lossless, exact (the RGB under
    transparent pixels survives), method 4."""
    buf = BytesIO()
    img.convert("RGBA").save(buf, format="WEBP", lossless=True, exact=True, method=4)
    return buf.getvalue()


def art_files(npc_dir: str) -> list:
    """Every art file the game can draw: the rotations under base/ and every
    frame under animations/<slug>/<dir>/, as paths relative to the NPC dir.
    Previews (contact sheets, gifs) are not art."""
    out = []
    base = os.path.join(npc_dir, "base")
    if os.path.isdir(base):
        for fn in sorted(os.listdir(base)):
            if fn.endswith(ART_EXT) and not fn.startswith("preview"):
                out.append(f"base/{fn}")
    anims = os.path.join(npc_dir, "animations")
    if os.path.isdir(anims):
        for slug in sorted(os.listdir(anims)):
            sd = os.path.join(anims, slug)
            if not os.path.isdir(sd):
                continue
            for d in sorted(os.listdir(sd)):
                dd = os.path.join(sd, d)
                if not os.path.isdir(dd):
                    continue
                for fn in sorted(os.listdir(dd)):
                    stem, ext = os.path.splitext(fn)
                    if ext == ART_EXT and stem.isdigit():
                        out.append(f"animations/{slug}/{d}/{fn}")
    return out


def packed_name(rel: str, h: str) -> str:
    stem, _ = os.path.splitext(rel)
    return f"{stem}.{h}{ART_EXT}"


def pack_npc(uid: str):
    """-> (uid, box, [(rel, record, encoded bytes)]). One box over every file
    on the NPC's canvas; a file on another canvas (none today) stays raw."""
    npc_dir = os.path.join(NPCS, uid)
    loaded = []
    for rel in art_files(npc_dir):
        data = open(os.path.join(npc_dir, rel), "rb").read()
        loaded.append((rel, sha8(data), Image.open(BytesIO(data)).convert("RGBA")))
    if not loaded:
        return uid, None, []
    sizes = {}
    for _, _, im in loaded:
        sizes[im.size] = sizes.get(im.size, 0) + 1
    cw, ch = max(sizes, key=sizes.get)  # the canvas most files share (all, today)
    members = [m for m in loaded if m[2].size == (cw, ch)]
    x0, y0, x1, y1 = cw, ch, 0, 0
    for _, _, im in members:
        bb = im.getchannel("A").getbbox()
        if not bb:
            continue
        x0, y0 = min(x0, bb[0]), min(y0, bb[1])
        x1, y1 = max(x1, bb[2]), max(y1, bb[3])
    if x1 <= x0 or y1 <= y0:
        x0, y0, x1, y1 = 0, 0, cw, ch
    else:
        x0, y0 = max(0, x0 - MARGIN), max(0, y0 - MARGIN)
        x1, y1 = min(cw, x1 + MARGIN), min(ch, y1 + MARGIN)
    box = {"ox": x0, "oy": y0, "w": x1 - x0, "h": y1 - y0, "srcW": cw, "srcH": ch}
    out = []
    for rel, src, im in members:
        enc = encode_webp(im.crop((x0, y0, x1, y1)))
        out.append((rel, {"src": src, "file": packed_name(rel, sha8(enc))}, enc))
    return uid, box, out


def load_index(pdir: str) -> dict:
    ipath = os.path.join(pdir, "index.json")
    if os.path.exists(ipath):
        try:
            idx = json.load(open(ipath))
            if idx.get("schema") == SCHEMA and isinstance(idx.get("files"), dict) and isinstance(idx.get("box"), dict):
                return idx
        except (OSError, ValueError):
            pass
    return {"schema": SCHEMA, "box": None, "files": {}}


def stale(uid: str, index: dict) -> bool:
    npc_dir = os.path.join(NPCS, uid)
    pdir = os.path.join(npc_dir, "packed")
    files = art_files(npc_dir)
    if not files or not index.get("box"):
        return bool(files)
    if set(index["files"]) != set(files):
        return True  # a frame came or went: the box may have moved
    for rel in files:
        rec = index["files"].get(rel)
        if not rec or rec.get("src") != sha8(open(os.path.join(npc_dir, rel), "rb").read()):
            return True
        if not os.path.exists(os.path.join(pdir, rec.get("file", ""))):
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None, help="comma-separated NPC folders")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args()
    ids = sorted(d for d in os.listdir(NPCS) if os.path.exists(os.path.join(NPCS, d, "character.json")))
    if args.only:
        want = set(args.only.split(","))
        ids = [i for i in ids if i in want]
    indexes = {i: load_index(os.path.join(NPCS, i, "packed")) for i in ids}
    todo = [i for i in ids if stale(i, indexes[i])]
    if args.check:
        print(f"[pack] {len(ids)} npcs: {'STALE ' + str(len(todo)) if todo else 'up to date'}")
        sys.exit(1 if todo else 0)
    print(f"[pack] {len(ids)} npcs, {len(todo)} to pack")
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        for n, (uid, box, recs) in enumerate(ex.map(pack_npc, todo, chunksize=2), 1):
            index = indexes[uid]
            pdir = os.path.join(NPCS, uid, "packed")
            if not box:
                continue
            old = index["files"]
            index["box"] = box
            index["files"] = {}
            for rel, rec, enc in recs:
                path = os.path.join(pdir, rec["file"])
                os.makedirs(os.path.dirname(path), exist_ok=True)
                if not os.path.exists(path):
                    with open(path, "wb") as f:
                        f.write(enc)
                prev = old.get(rel, {}).get("file")
                if prev and prev != rec["file"]:
                    rec["prev"] = prev
                index["files"][rel] = rec
            # Keep current + one back; drop anything older.
            keep = set()
            for r in index["files"].values():
                keep.add(r.get("file"))
                if r.get("prev"):
                    keep.add(r["prev"])
            for dp, _, fns in os.walk(pdir):
                for fn in fns:
                    if fn.endswith(ART_EXT):
                        relp = os.path.relpath(os.path.join(dp, fn), pdir).replace(os.sep, "/")
                        if relp not in keep:
                            os.remove(os.path.join(dp, fn))
            with open(os.path.join(pdir, "index.json"), "w") as f:
                json.dump(index, f, indent=1, sort_keys=True)
                f.write("\n")
            if n % 25 == 0:
                print(f"[pack] {n}/{len(todo)} npcs")
    raw_b = packed_b = files = 0
    for i in ids:
        idx = indexes[i]
        if not idx.get("box"):
            continue
        b = idx["box"]
        n = len(idx["files"])
        files += n
        raw_b += b["srcW"] * b["srcH"] * 4 * n
        packed_b += b["w"] * b["h"] * 4 * n
    print(f"[pack] {len(todo)} npcs packed, {files} files in the indexes")
    if raw_b:
        print(f"[pack] decoded texels: raw {raw_b/1e6:.0f} MB -> packed {packed_b/1e6:.0f} MB ({100*packed_b/raw_b:.0f}%)")


if __name__ == "__main__":
    main()
