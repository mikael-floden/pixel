#!/usr/bin/env python3
"""Measure foot-slide ("moon-walk") in the walk/run animations and derive the
playback FPS that makes feet track the ground.

For every character x {walk,run} x 8 directions:
- load the frame PNGs (characters2 art),
- take the GROUND-CONTACT strip of each frame (the bottom rows of the opaque
  figure — the planted foot dominates there while the swing foot is lifted),
- estimate the strip's frame-to-frame displacement along the direction's
  SCREEN travel axis by best-shift matching (min alpha-weighted SAD),
- sum the BACKWARD component over one cycle = stride px/cycle. A planted foot
  moving backward under the body at fps F covers stride*F/N px/s; matching
  the game's screen speed (uniform by projection design: WALK 70 / RUN 175
  px/s at zoom 1) gives  fps = speed * N / stride.

Writes client/public/anim-speeds.json:
  { "<uid>": { "walk": { "east": fps, ... }, "run": {...} } }
Directions whose measurement is unusable (stride ~ 0: the art encodes no
slide, e.g. some N/S views) are omitted — the client falls back to ANIM_FPS.

Run from games2/:  python3 scripts/measure-stride.py
"""
import json
import math
from pathlib import Path

from PIL import Image

GAME = Path(__file__).resolve().parent.parent
ART = GAME.parent / "characters2"
OUT = GAME / "client" / "public" / "anim-speeds.json"

ANIM_MAP = {"walk": "walking", "run": "running-8-frames"}
SPEED = {"walk": 70.0, "run": 175.0}  # screen px/s at zoom 1 (uniform by projection)
DIRS = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"]
# Screen-space unit travel vector per direction (+x right, +y down).
SQ = 1 / math.sqrt(2)
SCREEN_VEC = {
    "east": (1, 0), "west": (-1, 0), "north": (0, -1), "south": (0, 1),
    "north-east": (SQ, -SQ), "north-west": (-SQ, -SQ),
    "south-east": (SQ, SQ), "south-west": (-SQ, SQ),
}
FPS_MIN, FPS_MAX = 8.0, 30.0
STRIP_ROWS = 7  # ground-contact strip height (px)
RELIABLE_STRIDE = 14.0  # px/cycle below this the view encodes no real slide


def load_frames(char_dir: Path, anim: str, d: str):
    fdir = char_dir / "animations" / anim / d
    if not fdir.is_dir():
        return None
    files = sorted(fdir.glob("*.png"), key=lambda p: int(p.stem))
    return [Image.open(f).convert("RGBA") for f in files] or None


def contact_strip(img: Image.Image):
    """Alpha-weighted grayscale of the bottom STRIP_ROWS rows of the figure."""
    a = img.getchannel("A")
    bbox = a.getbbox()
    if not bbox:
        return None, 0
    x0, y0, x1, y1 = bbox
    top = max(y0, y1 - STRIP_ROWS)
    g = img.convert("L").crop((0, top, img.width, y1))
    m = a.crop((0, top, img.width, y1))
    gp, mp = g.load(), m.load()
    w, h = g.size
    row = [[gp[x, y] if mp[x, y] > 40 else -1 for x in range(w)] for y in range(h)]
    return row, y1


def shift_sad(a, b, dx, dy):
    """Mean abs diff of two strips at offset (dx,dy); -1 cells = transparent."""
    h = len(a)
    w = len(a[0])
    tot = 0
    n = 0
    for y in range(h):
        yy = y + dy
        if yy < 0 or yy >= h:
            continue
        ra, rb = a[y], b[yy]
        for x in range(w):
            xx = x + dx
            if xx < 0 or xx >= w:
                continue
            va, vb = ra[x], rb[xx]
            if va < 0 and vb < 0:
                continue
            tot += abs((va if va >= 0 else 0) - (vb if vb >= 0 else 0)) + (60 if (va < 0) != (vb < 0) else 0)
            n += 1
    return tot / max(n, 1)


def best_shift(a, b, ux, uy):
    """Displacement of strip b relative to a along (ux,uy), searched −6..6."""
    best = (1e18, 0.0)
    for s in [x * 0.5 for x in range(-12, 13)]:
        dx = round(s * ux)
        dy = round(s * uy)
        v = shift_sad(a, b, dx, dy)
        if v < best[0]:
            best = (v, s)
    return best[1]


def measure(char_dir: Path, uid: str):
    out = {}
    for state, folder in ANIM_MAP.items():
        strides = {}
        for d in DIRS:
            frames = load_frames(char_dir, folder, d)
            if not frames:
                continue
            strips = [contact_strip(f)[0] for f in frames]
            if any(s is None for s in strips):
                continue
            ux, uy = SCREEN_VEC[d]
            n = len(frames)
            back = 0.0
            for i in range(n):
                s = best_shift(strips[i], strips[(i + 1) % n], ux, uy)
                # s>0: the strip content moved ALONG travel (swing); s<0: the
                # planted foot slid BACKWARD under the body — the stride.
                if s < 0:
                    back += -s
            strides[d] = (back, n)
        # RELIABLE views (side-ish: real slide drawn) get the exact formula;
        # fore/back views whose art barely encodes slide would explode the
        # formula — they inherit the MEDIAN cadence of the reliable views
        # (one gait = one step frequency; this is what kills the perceived
        # moon-walk in those views without absurd 50fps+ leg blurs).
        rel = {
            d: max(FPS_MIN, min(FPS_MAX, SPEED[state] * n / st))
            for d, (st, n) in strides.items()
            if st >= RELIABLE_STRIDE
        }
        if not rel:
            continue
        med = sorted(rel.values())[len(rel) // 2]
        per_dir = {}
        for d, (st, n) in strides.items():
            fps = rel.get(d, med)
            tag = "measured" if d in rel else "median  "
            print(f"  {uid} {state:4s} {d:10s} stride={st:5.1f}px  {tag} fps={fps:5.1f}")
            per_dir[d] = round(fps, 1)
        out[state] = per_dir
    return out


def main():
    result = {}
    for char_dir in sorted((ART / "humans").iterdir()):
        if not (char_dir / "animations").is_dir():
            continue
        uid = char_dir.name
        print(f"[{uid}]")
        m = measure(char_dir, uid)
        if m:
            result[uid] = m
    OUT.write_text(json.dumps(result, indent=1) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
