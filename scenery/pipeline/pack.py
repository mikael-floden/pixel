#!/usr/bin/env python3
"""THE PACKED LAYER — every art file the game draws, cropped to the box of the
art it is swapped with, for games2 (the wiki, the viewer, maps2's render3 and
the bbox table keep reading the raw files; nothing here changes a raw file).

WHY (measured 2026-09-12 over the 192 pieces the_game places, 3,171 files):
PixelLab draws a piece on a square canvas (64..256 px) and the art fills 27%
of it on average — the rest is transparent texels the game's GPU still
decodes, uploads and holds (his phone: 7-9k textures, most of them mostly
empty). Cropping keeps 70% of the decoded bytes: 269 MB -> 188 MB.

THE BOX IS PER STATE, NOT PER FILE: a state's still, its rotations and every
frame of its clips share ONE box (the union of their opaque boxes, +1 px).
games2 registers the drawn still's crop rectangle on each frame texture and
swaps textures under a fixed image (setSceneryFrame), so anything that can be
swapped onto the same image must be cut from the same box or the frame would
need a rectangle the file does not contain. Per-file boxes would keep 72% —
nothing, for a rectangle the game could not apply. A file that came back on a
different canvas than its still (crystal_tree_002: 70 frames at 68 px under a
64-px still) is NOT packed and stays raw — a box is one canvas, and the game
draws that file exactly as it always did.

THE CACHE LAW (CLAUDE.md): a regenerable published asset is never rewritten
under a stable name. A packed file is `packed/<same subpath>.<sha8>.webp`
beside the piece, `packed/index.json` names the current file per raw path
(plus the crop: ox, oy, w, h and the source canvas), and the PREVIOUS
generation is kept (current + one back) so an open page keeps rendering
through a deploy.

    python3 scenery/pipeline/pack.py            # the pieces the published worlds place
    python3 scenery/pipeline/pack.py --all      # every piece with a manifest
    python3 scenery/pipeline/pack.py --only trees/tree_075,stumps/stump_007
    python3 scenery/pipeline/pack.py --check    # exit 1 if a selected piece is stale

ONLY THE PLACED PIECES BY DEFAULT: the domain holds 21k files and the game can
reach the ones its worlds place (games2/scripts/shipset.mjs ships those whole
directories, packed/ included). A newly placed piece draws from its raw files
until this runs again — correct, just bigger. Resumable and idempotent: a
family whose raw bytes all hash to what the index recorded (`src`) is skipped.
Lossless WebP, `exact=True`, method 6 — factory.save_webp's own settings."""
import argparse
import hashlib
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from io import BytesIO

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # scenery/
REPO = os.path.dirname(ROOT)
SCHEMA = "scenery-packed@1"
MARGIN = 1  # px around the union box, so a filtered edge never clips
ART_EXT = ".webp"


def sha8(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:8]


def encode_webp(img: Image.Image) -> bytes:
    """factory.save_webp's settings, to bytes: lossless (no VP8 ringing on a
    hard edge) and exact (the RGB under transparent pixels survives)."""
    buf = BytesIO()
    img.convert("RGBA").save(buf, format="WEBP", lossless=True, exact=True, method=6)
    return buf.getvalue()


def _frames(anims) -> list:
    out = []
    for a in (anims or {}).values() if isinstance(anims, dict) else []:
        if isinstance(a, dict):
            out += [p for p in (a.get("frame_paths") or []) if isinstance(p, str) and p]
    return out


def _norm(p: str) -> str:
    return p.replace("\\", "/").lstrip("/")


def families(man: dict) -> list:
    """The sets of raw paths that share one box, as (stills, files): the
    stills are a state's sprite and rotations (what a placement draws and
    measures), the files add every frame of its clips. games2's parsePiece
    rule as a SUPERSET: the piece-level rotations and animations join the base
    state (parsePiece gives them to it only when the state has none; a bigger
    union is always a valid box). Sets sharing a file are merged."""
    fams = []
    piece_sprite = man.get("sprite")
    piece_rot = [v for v in (man.get("rotations") or {}).values() if isinstance(v, str) and v]
    piece_frames = _frames(man.get("animations"))
    base_hit = False
    states = man.get("states") if isinstance(man.get("states"), dict) else {}
    for s in states.values():
        if not isinstance(s, dict) or not isinstance(s.get("sprite"), str) or not s["sprite"]:
            continue
        stills = [s["sprite"]] + [v for v in (s.get("rotations") or {}).values() if isinstance(v, str) and v]
        frames = _frames(s.get("animations"))
        if s["sprite"] == piece_sprite:
            base_hit = True
            stills += piece_rot
            frames += piece_frames
        fams.append((stills, frames))
    if isinstance(piece_sprite, str) and piece_sprite and not base_hit:
        fams.append(([piece_sprite] + piece_rot, piece_frames))
    merged: list = []  # [(stills set, files set)]
    for stills, frames in fams:
        st = set(_norm(p) for p in stills)
        fl = st | set(_norm(p) for p in frames)
        keep = []
        for ms, mf in merged:
            if mf & fl:
                st |= ms
                fl |= mf
            else:
                keep.append((ms, mf))
        merged = keep + [(st, fl)]
    return [(sorted(st), sorted(fl)) for st, fl in merged]


def plan(fam) -> tuple:
    """(stills, files) -> (members, skipped): the existing files on the STILL's
    canvas, and the existing files on another canvas, which stay raw."""
    stills, files = fam
    canvas = None
    for rel in stills:
        raw = os.path.join(ROOT, rel)
        if os.path.isfile(raw):
            canvas = Image.open(raw).size
            break
    members, skipped = [], []
    for rel in files:
        raw = os.path.join(ROOT, rel)
        if not os.path.isfile(raw):
            continue
        size = Image.open(raw).size
        if canvas is None:
            canvas = size
        (members if size == canvas else skipped).append(rel)
    return members, skipped


def packed_name(piece: str, rel: str, h: str) -> str:
    """The packed file's path under <piece>/packed/: the raw subpath with the
    content hash before the extension."""
    sub = rel[len(piece) + 1:] if rel.startswith(piece + "/") else rel.replace("/", "__")
    stem, _ = os.path.splitext(sub)
    return f"{stem}.{h}{ART_EXT}"


def pack_family(job):
    """(piece, family) -> (piece, [(rel, record, encoded bytes)], skipped rels):
    one box over the members on the still's canvas."""
    piece, fam = job
    members, skipped = plan(fam)
    loaded = []
    for rel in members:
        data = open(os.path.join(ROOT, rel), "rb").read()
        loaded.append((rel, sha8(data), Image.open(BytesIO(data)).convert("RGBA")))
    out = []
    if loaded:
        cw, ch = loaded[0][2].size
        x0, y0, x1, y1 = cw, ch, 0, 0
        for _, _, im in loaded:
            bb = im.getchannel("A").getbbox()
            if not bb:
                continue
            x0, y0 = min(x0, bb[0]), min(y0, bb[1])
            x1, y1 = max(x1, bb[2]), max(y1, bb[3])
        if x1 <= x0 or y1 <= y0:
            x0, y0, x1, y1 = 0, 0, cw, ch  # nothing opaque anywhere: keep the canvas
        else:
            x0, y0 = max(0, x0 - MARGIN), max(0, y0 - MARGIN)
            x1, y1 = min(cw, x1 + MARGIN), min(ch, y1 + MARGIN)
        for rel, src, im in loaded:
            enc = encode_webp(im.crop((x0, y0, x1, y1)))
            rec = {"src": src, "ox": x0, "oy": y0, "w": x1 - x0, "h": y1 - y0, "srcW": cw, "srcH": ch,
                   "file": packed_name(piece, rel, sha8(enc))}
            out.append((rel, rec, enc))
    return piece, out, skipped


def placed_pieces() -> list:
    """The pieces the published worlds place — shipset.mjs's own closure rule
    (games2/config/publish.json -> maps2/worlds3/<w>/world.json scenery[])."""
    pol = os.path.join(REPO, "games2", "config", "publish.json")
    if not os.path.exists(pol):
        return []
    policy = json.load(open(pol))
    ids = set()
    for w in (policy.get("userWorlds") or []) + (policy.get("devWorlds3") or []):
        wp = os.path.join(REPO, "maps2", "worlds3", w, "world.json")
        if not os.path.exists(wp):
            continue
        for s in json.load(open(wp)).get("scenery") or []:
            if isinstance(s, dict) and isinstance(s.get("piece"), str):
                ids.add(s["piece"])
    return sorted(i for i in ids if os.path.exists(os.path.join(ROOT, i, "scenery.json")))


def all_pieces() -> list:
    out = []
    for g in sorted(os.listdir(ROOT)):
        gd = os.path.join(ROOT, g)
        if not os.path.isdir(gd) or g in ("pipeline", "config"):
            continue
        for p in sorted(os.listdir(gd)):
            if os.path.exists(os.path.join(gd, p, "scenery.json")):
                out.append(f"{g}/{p}")
    return out


def load_index(pdir: str) -> dict:
    ipath = os.path.join(pdir, "index.json")
    if os.path.exists(ipath):
        try:
            idx = json.load(open(ipath))
            if idx.get("schema") == SCHEMA and isinstance(idx.get("files"), dict):
                return idx
        except (OSError, ValueError):
            pass
    return {"schema": SCHEMA, "files": {}}


def stale_families(piece: str, index: dict) -> list:
    """Families with a member the index does not hold at its current bytes —
    or holds when it should not (a file that left the still's canvas)."""
    man = json.load(open(os.path.join(ROOT, piece, "scenery.json")))
    pdir = os.path.join(ROOT, piece, "packed")
    todo = []
    for fam in families(man):
        members, skipped = plan(fam)
        fresh = not any(rel in index["files"] for rel in skipped)
        for rel in members if fresh else []:
            raw = os.path.join(ROOT, rel)
            rec = index["files"].get(rel)
            if not rec or rec.get("src") != sha8(open(raw, "rb").read()) or not os.path.exists(os.path.join(pdir, rec.get("file", ""))):
                fresh = False
                break
        if not fresh:
            todo.append((piece, fam))
    return todo


def refresh(ids=None, jobs=None, check=False, log=print) -> dict:
    """Pack what is stale among `ids` (default: the pieces the published worlds
    place); the one entry point for the CLI, for viewer_build.build() (every
    pipeline script ends there, so a regenerated placed piece is re-cut in the
    same unit) and for .github/workflows/scenery-pack.yml (a piece maps2 has
    just placed). `jobs=1` packs inline, no process pool — what a caller
    inside another pipeline wants. Returns {"pieces", "stale_families",
    "touched"}; with `check` nothing is written."""
    if ids is None:
        ids = placed_pieces()
    if not ids:
        log("[pack] no pieces selected")
        return {"pieces": 0, "stale_families": 0, "touched": []}
    indexes = {i: load_index(os.path.join(ROOT, i, "packed")) for i in ids}
    todo = []
    for i in ids:
        todo += stale_families(i, indexes[i])
    if check:
        stale = sum(len(f[1]) for _, f in todo)
        log(f"[pack] {len(ids)} pieces: {'STALE ' + str(stale) + ' files in ' + str(len(todo)) + ' families' if todo else 'up to date'}")
        return {"pieces": len(ids), "stale_families": len(todo), "touched": []}
    log(f"[pack] {len(ids)} pieces, {len(todo)} families to pack")
    touched = set()

    def land(n, piece, recs, skipped):
        index = indexes[piece]
        pdir = os.path.join(ROOT, piece, "packed")
        for rel in skipped:
            index["files"].pop(rel, None)  # stays raw: not on its still's canvas
        for rel, rec, enc in recs:
            path = os.path.join(pdir, rec["file"])
            os.makedirs(os.path.dirname(path), exist_ok=True)
            if not os.path.exists(path):
                with open(path, "wb") as f:
                    f.write(enc)
            old = index["files"].get(rel, {}).get("file")
            if old and old != rec["file"]:
                rec["prev"] = old
            index["files"][rel] = rec
        touched.add(piece)
        if n % 100 == 0:
            log(f"[pack] {n}/{len(todo)} families")

    jobs = jobs or max(1, (os.cpu_count() or 2) - 1)
    if jobs <= 1 or len(todo) < 4:
        for n, job in enumerate(todo, 1):
            land(n, *pack_family(job))
    else:
        with ProcessPoolExecutor(max_workers=jobs) as ex:
            for n, (piece, recs, skipped) in enumerate(ex.map(pack_family, todo, chunksize=4), 1):
                land(n, piece, recs, skipped)
    for piece in sorted(touched):
        index = indexes[piece]
        pdir = os.path.join(ROOT, piece, "packed")
        # Drop index entries whose raw file is gone, then keep current + one back.
        for rel in list(index["files"]):
            if not os.path.isfile(os.path.join(ROOT, rel)):
                del index["files"][rel]
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
    raw_b = packed_b = files = 0
    for i in ids:
        for r in indexes[i]["files"].values():
            files += 1
            raw_b += r["srcW"] * r["srcH"] * 4
            packed_b += r["w"] * r["h"] * 4
    log(f"[pack] {len(touched)} pieces written; {files} files in the selected indexes")
    if raw_b:
        log(f"[pack] decoded texels: raw {raw_b/1e6:.0f} MB -> packed {packed_b/1e6:.0f} MB ({100*packed_b/raw_b:.0f}%)")
    return {"pieces": len(ids), "stale_families": len(todo), "touched": sorted(touched)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="every piece, not only the placed ones")
    ap.add_argument("--only", default=None, help="comma-separated piece ids (group/id)")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args()
    if args.only:
        ids = [i for i in args.only.split(",") if os.path.exists(os.path.join(ROOT, i, "scenery.json"))]
    elif args.all:
        ids = all_pieces()
    else:
        ids = placed_pieces()
    r = refresh(ids, jobs=args.jobs, check=args.check)
    if args.check:
        sys.exit(1 if r["stale_families"] else 0)


if __name__ == "__main__":
    main()
