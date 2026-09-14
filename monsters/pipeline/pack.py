#!/usr/bin/env python3
"""THE PACKED STRIPS — every animation strip cropped to the union box of its
frames' art, for the game (games2/scripts/build-monsters-manifest.mjs points
at these; the wiki and the contact sheets keep reading the raw strips).

WHY (measured 2026-09-12 over 60 random strips): a raw strip is 16% opaque
texels — PixelLab draws a small body on a large canvas and `_save_strip`
centres every frame in a max-size cell — and the game's GPU pays for all of
it: decoded bytes, upload bands, video memory (his phone held 7-9k textures
and uploaded 200-270 MB per 30 s window, most of it transparent). Cropping
each strip to the union of its frames' opaque boxes keeps 32% of the texels
(per-frame tight boxes would keep 26%, for a lot more machinery); the frames
stay one strip in one row, so the game slices it exactly as before and every
anchor the manifest builder measures comes from the packed strip itself.

THE CACHE LAW (CLAUDE.md): a regenerable published asset is never rewritten
under a stable name. The raw strip is the mirror's write-once output and keeps
its name; a packed strip is DERIVED and named by its content hash
(`packed/<key>__<dir>.<sha8>.webp`), `packed/index.json` names the current
file for each strip, and the PREVIOUS generation is kept (current + one
back) so a page already open keeps rendering while a deploy rolls.

    python3 monsters/pipeline/pack.py            # every monster, only what changed
    python3 monsters/pipeline/pack.py --only id  # one monster
    python3 monsters/pipeline/pack.py --check    # exit 1 if any index is stale

Resumable and idempotent: a strip whose raw bytes hash to what the index
already recorded (`src`) is skipped. Lossless WebP through the domain's own
save helper (format.json: lossless + exact), like everything here."""
import argparse
import hashlib
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from mirror import ART_EXT, WEBP_OPTS  # noqa: E402  (the domain's format contract)

MARGIN = 1  # px around the union box, so a filtered edge never clips


def sha8(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:8]


def union_box(strip: Image.Image, frames: int):
    """The union of the frames' opaque boxes, in frame-cell coordinates."""
    w, h = strip.size
    fw = w // frames if frames else w
    a = strip.getchannel("A")
    x0, y0, x1, y1 = fw, h, 0, 0
    for i in range(frames):
        bb = a.crop((i * fw, 0, (i + 1) * fw, h)).getbbox()
        if not bb:
            continue
        x0, y0 = min(x0, bb[0]), min(y0, bb[1])
        x1, y1 = max(x1, bb[2]), max(y1, bb[3])
    if x1 <= x0 or y1 <= y0:
        return fw, h, (0, 0, fw, h)  # a fully transparent strip keeps its cell
    x0, y0 = max(0, x0 - MARGIN), max(0, y0 - MARGIN)
    x1, y1 = min(fw, x1 + MARGIN), min(h, y1 + MARGIN)
    return fw, h, (x0, y0, x1, y1)


def pack_one(job):
    """(raw path, frames) -> the packed record, encoded bytes and the name."""
    raw, frames = job
    data = open(raw, "rb").read()
    src = sha8(data)
    strip = Image.open(raw).convert("RGBA")
    fw, h, (x0, y0, x1, y1) = union_box(strip, frames)
    bw, bh = x1 - x0, y1 - y0
    out = Image.new("RGBA", (bw * frames, bh), (0, 0, 0, 0))
    for i in range(frames):
        out.paste(strip.crop((i * fw + x0, y0, i * fw + x1, y1)), (i * bw, 0))
    from io import BytesIO
    buf = BytesIO()
    out.save(buf, "WEBP", lossless=WEBP_OPTS.get("lossless", True), method=WEBP_OPTS.get("method", 6), exact=WEBP_OPTS.get("exact", True))
    enc = buf.getvalue()
    rec = {"src": src, "frames": frames, "w": bw, "h": bh, "ox": x0, "oy": y0, "srcW": fw, "srcH": h}
    return raw, rec, enc, sha8(enc)


def strips_of(mon_dir):
    m = json.load(open(os.path.join(mon_dir, "monster.json")))
    out = []
    for key, anim in (m.get("animations") or {}).items():
        for d, dd in (anim.get("directions") or {}).items():
            rel = dd.get("strip")
            if not rel:
                continue
            raw = os.path.join(ROOT, os.path.splitext(rel.replace("\\", "/"))[0] + ART_EXT)
            if not os.path.exists(raw):
                raw2 = os.path.join(ROOT, rel)
                if not os.path.exists(raw2):
                    continue
                raw = raw2
            out.append((f"{key}__{d}", raw, int(dd.get("frames") or 1)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args()
    ids = sorted(d for d in os.listdir(ROOT) if os.path.exists(os.path.join(ROOT, d, "monster.json")))
    if args.only:
        ids = [i for i in ids if i in set(args.only.split(","))]
    stale = 0
    total_raw = total_packed = 0
    for mid in ids:
        mon_dir = os.path.join(ROOT, mid)
        pdir = os.path.join(mon_dir, "packed")
        ipath = os.path.join(pdir, "index.json")
        index = json.load(open(ipath)) if os.path.exists(ipath) else {"schema": "monsters-packed@1", "strips": {}}
        old_files = {r["file"] for r in index["strips"].values() if r.get("file")}
        todo = []
        for name, raw, frames in strips_of(mon_dir):
            rec = index["strips"].get(name)
            if rec and rec.get("src") == sha8(open(raw, "rb").read()) and os.path.exists(os.path.join(pdir, rec["file"])):
                continue
            todo.append((name, raw, frames))
        if args.check:
            if todo:
                print(f"[pack] {mid}: {len(todo)} strips stale")
                stale += len(todo)
            continue
        if todo:
            os.makedirs(pdir, exist_ok=True)
            with ProcessPoolExecutor(max_workers=args.jobs) as ex:
                for (name, raw, frames), (rawp, rec, enc, h) in zip(todo, ex.map(pack_one, [(raw, frames) for _, raw, frames in todo])):
                    fname = f"{name}.{h}{ART_EXT}"
                    with open(os.path.join(pdir, fname), "wb") as f:
                        f.write(enc)
                    rec["file"] = fname
                    rec["prev"] = index["strips"].get(name, {}).get("file")
                    index["strips"][name] = rec
            # Keep current + one back; drop anything older.
            keep = set()
            for r in index["strips"].values():
                keep.add(r.get("file"))
                if r.get("prev"):
                    keep.add(r["prev"])
            for f in os.listdir(pdir):
                if f.endswith(ART_EXT) and f not in keep:
                    os.remove(os.path.join(pdir, f))
            with open(ipath, "w") as f:
                json.dump(index, f, indent=1, sort_keys=True)
        for r in index["strips"].values():
            total_raw += r["srcW"] * r["srcH"] * r["frames"] * 4
            total_packed += r["w"] * r["h"] * r["frames"] * 4
        print(f"[pack] {mid}: {len(todo)} packed, {len(index['strips'])} in index")
    if args.check:
        print(f"[pack] {'STALE ' + str(stale) if stale else 'up to date'}")
        sys.exit(1 if stale else 0)
    if total_raw:
        print(f"[pack] decoded texels: raw {total_raw/1e6:.0f} MB -> packed {total_packed/1e6:.0f} MB ({100*total_packed/total_raw:.0f}%)")


if __name__ == "__main__":
    main()
