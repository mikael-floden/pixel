#!/usr/bin/env python3
"""CAST POINTS: where a spell leaves the hero, measured from the hero's own art.

A spell that appears 40 px from the wand it was cast with reads as a bug, and
the art does not draw its wand where a fixed "0.55 of the height above the
feet" guess puts it: PixelLab's south-facing wand points to screen RIGHT, the
north one straight up. So every hero x cast clip x direction is measured on
its KEY frame (define.js CAST_ANIMS: frame 2 of 4 — the thrust, the release):

  spell_wand     the spark at the wand tip: of the clusters of colours the
                 hero's art never uses elsewhere (not in its idle frames nor the
                 clip's wind-up frame 0), the one at arm's length sideways — magic is
                 new colour whatever its hue (the boy's green-white, the girl's
                 violet and cream), and so is a thrust's reshaded skin, but
                 that stays on the body
  spell_channel  the orb between the hands: the brightness-weighted middle of
                 those new colours (a ring round a back-facing body centres)
  bow            the arrow already in flight: the biggest DARK silhouette piece
                 not joined to the body (the effect's arrow takes over from it;
                 the pale pieces are motion strokes)

A facing the art never draws it on (the boy's arrow flies hidden behind him
facing north; the girl's is still on the string facing south) takes its two
neighbours' mean, x mirrored to 0 on the
north/south axis — the manifest's grab rule for the same problem.

Each point is kept in FRAME px (pixel centres) and as an offset from the
game's own FOOT ANCHOR (games2/scripts/anchorlib.mjs footAnchor, ported
verbatim below: the per-direction median over the idle frames), because that
anchor is the point the game pins to the body's world position. The offset is
screen px, x right and y UP: the runtime takes it as { sx, z } on `from`.

  python3 shaders/pipeline/castpoints.py          write shaders/library/cast_points.js
  python3 shaders/pipeline/castpoints.py --check  exit 1 if the art moved on

The output carries a digest of every frame it read; the catalog gate
(pipeline/catalog.mjs --check) recomputes it, so a regenerated hero fails the
gate instead of silently casting from where the old wand was.
"""
import hashlib
import json
import os
import sys

from PIL import Image

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
HEROES = ["default_boy", "default_girl"]
DIRS = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]
CLIPS = {"spell_wand": "wand", "spell_channel": "orb", "bow": "arrow"}
KEY = 2  # define.js CAST_ANIMS: the key frame of every hero cast clip
OUT = os.path.join(ROOT, "shaders", "library", "cast_points.js")


def rel(p):
    return os.path.relpath(p, ROOT).replace(os.sep, "/")


def folder_map(hero):
    m = json.load(open(os.path.join(ROOT, "characters2", "animation_map.json")))
    states = dict(m["states"])
    states.update(m.get("overrides", {}).get(hero, {}))
    return states


def load(path):
    im = Image.open(path).convert("RGBA")
    return im.size[0], im.size[1], im.load()


# ---- footAnchor, ported verbatim from games2/scripts/anchorlib.mjs ----------
def sole_of(w, h, px):
    for y in range(h - 1, -1, -1):
        n = 0
        for x in range(w):
            if px[x, y][3] > 64:
                n += 1
                if n >= 3:
                    return y
    return -1


def band_blobs(w, px, sole, band):
    y0 = max(0, sole - band + 1)
    bh = sole - y0 + 1
    label = [-1] * (w * bh)
    blobs = []
    for by in range(bh):
        for x in range(w):
            if label[by * w + x] >= 0 or px[x, y0 + by][3] <= 64:
                continue
            bid = len(blobs)
            b = {"minX": x, "maxX": x, "maxY": y0 + by, "size": 0}
            stack = [(x, by)]
            label[by * w + x] = bid
            while stack:
                cx, cy = stack.pop()
                b["size"] += 1
                b["minX"] = min(b["minX"], cx)
                b["maxX"] = max(b["maxX"], cx)
                b["maxY"] = max(b["maxY"], y0 + cy)
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        nx, ny = cx + dx, cy + dy
                        if nx < 0 or ny < 0 or nx >= w or ny >= bh:
                            continue
                        if label[ny * w + nx] >= 0 or px[nx, y0 + ny][3] <= 64:
                            continue
                        label[ny * w + nx] = bid
                        stack.append((nx, ny))
            blobs.append(b)
    return blobs


def foot_anchor(path):
    w, h, px = load(path)
    sole = sole_of(w, h, px)
    if sole < 0:
        return None
    band = max(8, round(h * 0.09))
    planted = [b for b in band_blobs(w, px, sole, band) if b["size"] >= 4 and b["maxY"] >= sole - 6]
    planted.sort(key=lambda b: b["minX"] + b["maxX"])
    if not planted:
        return None
    first, last = planted[0], planted[-1]
    cen = lambda b: (b["minX"] + b["maxX"] + 1) / 2
    ax = (cen(first) + cen(last)) / 2
    ay = (first["maxY"] + last["maxY"] + 2) / 2 - h * 0.022
    return round(ax / w, 4), round(ay / h, 4)


# ---- the key-frame measurements -------------------------------------------
def components(w, h, keep):
    """8-connected clusters of the pixels keep(x, y) accepts: lists of (x, y)."""
    seen = set()
    out = []
    for y in range(h):
        for x in range(w):
            if (x, y) in seen or not keep(x, y):
                continue
            comp, stack = [], [(x, y)]
            seen.add((x, y))
            while stack:
                cx, cy = stack.pop()
                comp.append((cx, cy))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        q = (cx + dx, cy + dy)
                        if 0 <= q[0] < w and 0 <= q[1] < h and q not in seen and keep(*q):
                            seen.add(q)
                            stack.append(q)
            out.append(comp)
    return out


def centre(comp):
    return (sum(p[0] for p in comp) / len(comp) + 0.5, sum(p[1] for p in comp) / len(comp) + 0.5)


def luma(c):
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def body_mid(w, h, px):
    pts = [(x, y) for y in range(h) for x in range(w) if px[x, y][3] > 64]
    return centre(pts)


def new_colour(px, palette):
    return lambda x, y: px[x, y][3] > 64 and px[x, y][:3] not in palette


def wand_point(w, h, px, palette):
    # a thrust pose reshades the body too (new tones on the legs and feet),
    # so of the new-colour clusters the spark is the one at arm's length —
    # SIDEWAYS: every facing of both heroes thrusts the wand out to a side
    # (|sx| 43-53 px), while reshaded feet sit under the body's middle
    comps = [c for c in components(w, h, new_colour(px, palette)) if len(c) >= 3]
    if not comps:
        return None
    mx, _ = body_mid(w, h, px)
    best = max(comps, key=lambda c: abs(centre(c)[0] - mx))
    return centre(best)


def orb_point(w, h, px, palette):
    keep = new_colour(px, palette)
    pts = [(x, y) for y in range(h) for x in range(w) if keep(x, y)]
    if len(pts) < 3:
        return None
    wsum = sum(luma(px[x, y]) for x, y in pts)
    return (sum((x + 0.5) * luma(px[x, y]) for x, y in pts) / wsum, sum((y + 0.5) * luma(px[x, y]) for x, y in pts) / wsum)


def arrow_point(w, h, px, palette):
    # the loose pieces are the arrow AND the girl's pale motion strokes: an
    # arrow is dark (mean luma 42-84 measured), a stroke pale (117-195)
    comps = components(w, h, lambda x, y: px[x, y][3] > 64)
    if len(comps) < 2:
        return None
    comps.sort(key=len, reverse=True)
    dark = lambda c: sum(luma(px[x, y]) for x, y in c) / len(c) < 100
    loose = [c for c in comps[1:] if len(c) >= 3 and dark(c)]
    return centre(loose[0]) if loose else None


MEASURE = {"wand": wand_point, "orb": orb_point, "arrow": arrow_point}


def colours(path):
    w, h, px = load(path)
    return {px[x, y][:3] for y in range(h) for x in range(w) if px[x, y][3] > 64}


def neighbours(d):
    i = DIRS.index(d)
    return DIRS[(i - 1) % 8], DIRS[(i + 1) % 8]


def measure():
    digest = hashlib.sha256()
    heroes = {}
    size = None
    for hero in HEROES:
        fm = folder_map(hero)
        base = os.path.join(ROOT, "characters2", "humans", hero, "animations")
        anchors = {}
        palette = set()  # every colour the hero's idle art uses, any facing
        for d in DIRS:
            ddir = os.path.join(base, fm["idle"], d)
            frames = sorted(f for f in os.listdir(ddir) if f.endswith(".webp"))
            xs, ys = [], []
            for f in frames:
                p = os.path.join(ddir, f)
                digest.update(rel(p).encode() + open(p, "rb").read())
                palette |= colours(p)
                a = foot_anchor(p)
                if a:
                    xs.append(a[0])
                    ys.append(a[1])
            xs.sort()
            ys.sort()
            anchors[d] = (xs[len(xs) >> 1], ys[len(ys) >> 1])
        clips = {}
        for state, how in CLIPS.items():
            dirs = {}
            for d in DIRS:
                p = os.path.join(base, fm[state], d, f"{KEY}.webp")
                p0 = os.path.join(base, fm[state], d, "0.webp")
                for q in (p0, p):
                    digest.update(rel(q).encode() + open(q, "rb").read())
                w, h, px = load(p)
                size = (w, h)
                pt = MEASURE[how](w, h, px, palette | colours(p0))
                if pt is None:
                    continue
                ax, ay = anchors[d][0] * w, anchors[d][1] * h
                dirs[d] = {
                    "x": round(pt[0], 1),
                    "y": round(pt[1], 1),
                    "sx": round(pt[0] - ax, 1),  # screen px right of the feet
                    "z": round(ay - pt[1], 1),  # screen px above the feet
                }
            for d in DIRS:
                if d in dirs:
                    continue
                a, b = (dirs.get(n) for n in neighbours(d))
                if a and b:
                    axis = d in ("north", "south")
                    dirs[d] = {
                        "sx": 0.0 if axis else round((a["sx"] + b["sx"]) / 2, 1),
                        "z": round((a["z"] + b["z"]) / 2, 1),
                        "approx": True,
                    }
            clips[state] = {"frame": KEY, "folder": fm[state], "point": how, "dirs": {d: dirs[d] for d in DIRS if d in dirs}}
        # every clip a preview plays: its folder and frame count (the least
        # over the facings — a viewer cannot list a directory over HTTP)
        anims = {}
        for state in ["idle", "spell_wand", "spell_channel", "bow", "sword", "punch", "kick"]:
            counts = [len([f for f in os.listdir(os.path.join(base, fm[state], d)) if f.endswith(".webp")]) for d in DIRS]
            anims[state] = {"folder": fm[state], "frames": min(counts)}
            digest.update(f"{hero}|{state}|{fm[state]}|{min(counts)}".encode())
        heroes[hero] = {
            "anchors": {d: {"x": a[0], "y": a[1]} for d, a in anchors.items()},
            "anims": anims,
            "clips": clips,
        }
    return {
        "format": "nangijala-shaders-cast-points@1",
        "frame": {"w": size[0], "h": size[1]},
        "source": digest.hexdigest()[:16],
        "heroes": heroes,
    }


def render(table):
    body = json.dumps(table, indent=1, sort_keys=False)
    return (
        "// GENERATED by shaders/pipeline/castpoints.py from the heroes' own frames —\n"
        "// do not edit. Where each hero's spell leaves it on a cast clip's key frame,\n"
        "// per facing: frame px, and { sx, z } = screen px right of / above the game's\n"
        "// foot anchor (anchorlib footAnchor), which is what play()'s `from` takes.\n"
        f"export const CAST_POINTS = {body};\n"
        "export default CAST_POINTS;\n"
    )


def main():
    table = measure()
    text = render(table)
    if "--check" in sys.argv:
        cur = open(OUT).read() if os.path.exists(OUT) else ""
        if cur != text:
            print("cast points are STALE: python3 shaders/pipeline/castpoints.py")
            sys.exit(1)
        print(f"cast points ok ({table['source']})")
        return
    open(OUT, "w").write(text)
    n = sum(len(c["dirs"]) for h in table["heroes"].values() for c in h["clips"].values())
    print(f"wrote {rel(OUT)}: {n} points, source {table['source']}")
    for hero, H in table["heroes"].items():
        for state, c in H["clips"].items():
            miss = [d for d in DIRS if d not in c["dirs"]]
            print(f"  {hero:13s} {state:14s} " + " ".join(f"{d[:2] if '-' not in d else d.split('-')[0][0]+d.split('-')[1][0]}:{v['sx']:+.0f},{v['z']:.0f}" for d, v in c["dirs"].items()) + (f"  MISSING {miss}" if miss else ""))


if __name__ == "__main__":
    main()
