#!/usr/bin/env python3
"""Apply the maintainer's flap-frame cull to the ambient flyer art.

    art-original/<critter>/fly.webp  +  art-original/cull.json
        -> birds/art/<bird>/fly.webp, bats/art/fly.webp   (repacked)
        -> runtime/flapframes.json                        (per-facing counts)

WHY IT WORKS THIS WAY

* The ORIGINALS are never touched, and the cull list is expressed in ORIGINAL
  1-based F numbers. So this is idempotent (re-running rebuilds the same art
  from the same source) and, more importantly, it is a scoreable GROUND TRUTH:
  a future automatic frame-picker gets art-original/ as input and is judged
  against cull.json. Culling in place would have destroyed exactly the data
  that makes that possible.

* The sheet KEEPS its 16x8 geometry. Kept frames are compacted to the LEFT in
  their original order and the tail is left fully transparent, so the runtime
  needs only a per-facing COUNT — flyFrame()/FLY_FRAMES and every call site are
  untouched. A ragged sheet would have forced a per-critter stride through all
  of that for no gain, because a critter keeping all 16 frames in ANY one
  facing (bird1 W, bird3 S, the bat) pins the width at 16 regardless.
  The art still shrinks: a fully transparent 34x34 cell costs almost nothing in
  lossless VP8L, so the dropped frames stop being paid for.

* Lossless + exact, like every other conversion in this repo: VP8L is bit-exact
  and `exact` keeps the RGB under transparent pixels from being rewritten. Each
  output is re-decoded and checked against the frames it was built from before
  it replaces anything.

    python games2/ambient/scripts/cull_frames.py [--check]

--check verifies the shipped art matches what the cull list implies and writes
nothing (use it in CI / before trusting a sheet).
"""
import io
import os
import sys
import json
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
AMBIENT = os.path.dirname(HERE)
ORIG = os.path.join(AMBIENT, "art-original")
CULL = os.path.join(ORIG, "cull.json")
OUT_JSON = os.path.join(AMBIENT, "runtime", "flapframes.json")
FRAME = 34
NFRAMES = 16
NDIRS = 8


def dest(critter):
    if critter == "bat":
        return os.path.join(AMBIENT, "bats", "art", "fly.webp")
    return os.path.join(AMBIENT, "birds", "art", critter, "fly.webp")


def load_cull():
    with open(CULL) as f:
        c = json.load(f)
    dirs = c["dirs"]
    if len(dirs) != NDIRS:
        sys.exit(f"cull.json: expected {NDIRS} dirs, got {len(dirs)}")
    return dirs, c["drop"]


def keep_lists(dirs, drop_for):
    """Per facing, the ORIGINAL 1-based frame numbers that survive."""
    keep = []
    for d in dirs:
        dropped = drop_for.get(d, [])
        bad = [n for n in dropped if not (1 <= n <= NFRAMES)]
        if bad:
            sys.exit(f"  frame number out of range 1..{NFRAMES}: {bad}")
        s = set(dropped)
        k = [n for n in range(1, NFRAMES + 1) if n not in s]
        if not k:
            sys.exit(f"  facing {d}: every frame dropped — a flyer needs at least one")
        keep.append(k)
    return keep


def build(src_path, keep):
    """Repack: kept frames compacted left per row, tail transparent."""
    src = Image.open(src_path).convert("RGBA")
    exp = (FRAME * NFRAMES, FRAME * NDIRS)
    if src.size != exp:
        sys.exit(f"{src_path}: is {src.size}, expected {exp}")
    out = Image.new("RGBA", exp, (0, 0, 0, 0))
    for r in range(NDIRS):
        for i, n in enumerate(keep[r]):
            cell = src.crop(((n - 1) * FRAME, r * FRAME, n * FRAME, (r + 1) * FRAME))
            out.paste(cell, (i * FRAME, r * FRAME))
    return src, out


def verify(src, out, keep):
    """Every shipped cell must be EXACTLY its original frame; the tail empty."""
    for r in range(NDIRS):
        for i, n in enumerate(keep[r]):
            a = src.crop(((n - 1) * FRAME, r * FRAME, n * FRAME, (r + 1) * FRAME))
            b = out.crop((i * FRAME, r * FRAME, (i + 1) * FRAME, (r + 1) * FRAME))
            if a.tobytes() != b.tobytes():
                return f"row {r} slot {i} (orig F{n}) does not match the source frame"
        for i in range(len(keep[r]), NFRAMES):
            b = out.crop((i * FRAME, r * FRAME, (i + 1) * FRAME, (r + 1) * FRAME))
            if b.getbbox() is not None:
                return f"row {r} slot {i} should be transparent padding but has pixels"
    return None


def encode(img):
    buf = io.BytesIO()
    # lossless + exact: both are NON-default in Pillow and both are load-bearing
    # (see the repo's CLAUDE.md). Without them this silently becomes lossy.
    img.save(buf, format="WEBP", lossless=True, exact=True)
    b = buf.getvalue()
    if Image.open(io.BytesIO(b)).convert("RGBA").tobytes() != img.tobytes():
        sys.exit("encoded WebP did not round-trip losslessly — refusing to write")
    return b


def main():
    check = "--check" in sys.argv
    dirs, drop = load_cull()

    meta = {
        "_": "pixel-ambient/flapframes@1",
        "_doc": [
            "GENERATED by scripts/cull_frames.py from art-original/cull.json — do",
            "not hand-edit. `count` is how many flap frames each facing actually",
            "has after the cull; the runtime cycles 0..count-1 and the rest of the",
            "16-wide row is transparent padding. `keep` is the ORIGINAL 1-based F",
            "number now sitting in each slot, so a frame the maintainer names on a",
            "CULLED contact sheet can be mapped back to the original numbering the",
            "cull list is written in.",
        ],
        "dirs": dirs,
        "frames": NFRAMES,
        "critters": {},
    }

    problems, total_before, total_after, changed = [], 0, 0, 0
    for critter in drop:
        keep = keep_lists(dirs, drop[critter])
        src_path = os.path.join(ORIG, critter, "fly.webp")
        if not os.path.exists(src_path):
            sys.exit(f"{critter}: no original at {src_path}")
        src, out = build(src_path, keep)
        err = verify(src, out, keep)
        if err:
            sys.exit(f"{critter}: {err}")

        meta["critters"][critter] = {
            "count": [len(k) for k in keep],
            "keep": keep,
        }

        data = encode(out)
        dst = dest(critter)
        before = os.path.getsize(dst) if os.path.exists(dst) else 0
        total_before += before
        total_after += len(data)

        cur = open(dst, "rb").read() if os.path.exists(dst) else None
        same = cur == data
        if not same:
            changed += 1
        if check:
            if not same:
                problems.append(f"{critter}: shipped art differs from the cull list")
        elif not same:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "wb") as f:
                f.write(data)

        kept = sum(len(k) for k in keep)
        print(f"{critter:6s} keep {kept:3d}/{NFRAMES * NDIRS}  per-dir "
              f"{[len(k) for k in keep]}  {before} -> {len(data)} bytes")

    if check:
        cur = json.load(open(OUT_JSON)) if os.path.exists(OUT_JSON) else None
        if cur != meta:
            problems.append("runtime/flapframes.json is stale")
        if problems:
            for p in problems:
                print("FAIL:", p)
            sys.exit(1)
        print("check: shipped art and flapframes.json match cull.json")
        return

    with open(OUT_JSON, "w") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")
    pct = 100 * (total_before - total_after) / total_before if total_before else 0
    print(f"\n{changed} sheet(s) rewritten; {total_before} -> {total_after} bytes ({pct:.1f}% smaller)")
    print(f"wrote {os.path.relpath(OUT_JSON, AMBIENT)}")


if __name__ == "__main__":
    main()
