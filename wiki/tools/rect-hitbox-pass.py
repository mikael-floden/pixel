#!/usr/bin/env python3
"""Replace the ELLIPSE-ERA auto proposals on rect-tagged scenery with a rect
fitted to each variation's own measured footprint.

Maintainer 2026-09-03, on "Open shelf unit of jars and crocks 008": "how come
[it] has a mega bad hitbox? Doesn't look like you followed my steps at all."
He was right, and the cause was not the fit: 546 of the 583 rect variations
still carried a proposal written in the ellipse era (one had ry 16.55 — a
footprint three times too deep), and because the piece is now TAGGED rect that
old ellipse was being DRAWN as a rectangle. A default only applies where there
is no record, so the new fit never got a chance.

His own decisions are never touched: only records marked `auto: true` are
rewritten, and a variation he has decided is left exactly as it is.

The geometry is not repeated here — build.mjs measures the three corners off
each clip's silhouette and publishes them per state and facing (`base` on the
clip), and this pass solves them the same way the wiki does.

    python3 wiki/tools/rect-hitbox-pass.py            # dry run, prints a summary
    python3 wiki/tools/rect-hitbox-pass.py --write    # rewrite the proposals
"""
import json, math, sys, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = json.loads((ROOT / "wiki/site/data.json").read_text())
DOC_PATH = ROOT / "live/tuning/scenery_hitbox.json"
K = DATA["iso"]["dy"] / DATA["iso"]["dx"]
GROUND = {"south": 0, "south-east": 45, "south-west": -45}


def solve(base, dname):
    """The three measured corners → (rx, ry, centre) for that facing."""
    Lx, Ly, Bx, By, Rx, Ry = base
    th = math.radians(-GROUND[dname])
    eu = (math.cos(th), math.sin(th) * K)
    ev = (-math.sin(th), math.cos(th) * K)
    cx, cy = (Lx + Rx) / 2, (Ly + Ry) / 2
    d = (Rx - cx, Ry - cy)
    det = eu[0] * ev[1] - eu[1] * ev[0]
    if not det:
        return None
    p = (d[0] * ev[1] - d[1] * ev[0]) / det
    q = (eu[0] * d[1] - eu[1] * d[0]) / det
    return abs(p), abs(q) * K, (cx, cy), By


def base_span(piece, state):
    """The south base line's left and right ends, in frame px."""
    b = ((piece.get("animations") or {}).get(state, {}).get("dirs") or {}).get("south", {}).get("base")
    return (b[0], b[4]) if isinstance(b, list) and len(b) == 6 else (0, 0)


def fit(piece, state):
    dirs = (piece.get("animations") or {}).get(state, {}).get("dirs") or {}
    fits = {}
    for dname in ("south", "south-east", "south-west"):
        b = dirs.get(dname, {}).get("base")
        if isinstance(b, list) and len(b) == 6:
            r = solve(b, dname)
            if r:
                fits[dname] = r
    turned = [fits[d] for d in ("south-east", "south-west") if d in fits and fits[d][0] > 3 and fits[d][1] > 1]
    any_dir = next(iter(dirs.values()), {})
    W, H = any_dir.get("fw", 96), any_dir.get("fh", 96)
    if turned:
        rx = sum(t[0] for t in turned) / len(turned)
        ry = sum(t[1] for t in turned) / len(turned)
    else:
        # DEPTH CANNOT BE SEEN FROM THE SOUTH (29 of the 33 unmeasurable
        # variations ship south art only — aqueducts, archways, a washing
        # line). The width is measured; the depth is the MEDIAN ratio of the
        # 531 pieces that could be measured, ground depth = 0.68 x half-width,
        # rather than a number made up here. He can drag D on any of them.
        if "south" not in fits:
            return None
        rx = (fits["south"][2][0] - fits["south"][2][0]) or None
        Lx, Rx = base_span(piece, state)
        if Rx - Lx < 6:
            return None
        rx = (Rx - Lx) / 2
        ry = 0.679 * rx * K
    pos = {d: {"ax": round(fits[d][2][0] - W / 2, 2), "ay": round(fits[d][2][1] - H / 2, 2)}
           for d in ("south-east", "south-west") if d in fits}
    s = fits.get("south")
    sx = s[2][0] if s else W / 2
    sy = (s[3] - ry) if s else H * 0.75
    # A BOX MUST FIT ITS FRAME: the wiki's own data gate rejects one that does
    # not, and a 128px fence measured 130px wide across its feet.
    ax, ay = round(sx - W / 2, 2), round(sy - H / 2, 2)
    rx = min(rx, W / 2 - abs(ax) - 1)
    ry = min(ry, H / 2 - abs(ay) - 1)
    if rx < 3 or ry < 1:
        return None
    box = {"ax": ax, "ay": ay, "rx": round(rx, 2), "ry": round(max(2, ry), 2), "rot": 0, "shape": "rect"}
    # SOUTH OPTS OUT WHEN ITS OWN ART DISAGREES (2026-09-03, maintainer: "Some
    # art just looks that way and we can't do anything about it ... when you
    # run my formula and you see that the W is way off you just 'request a
    # unique size' and adjust"). Measured: 54 of the 131 rect pieces have a
    # south view whose base is a different width from the one their turned
    # views imply — bed_002 shows 70 where its turned views say 105 — so the
    # shared size is simply wrong there, whichever facing it is fitted to.
    # South can measure its own WIDTH but never its depth, so it keeps the
    # shared depth and takes its own width.
    if turned and "south" in fits:
        south_w = base_span(piece, state)
        south_w = south_w[1] - south_w[0]
        if south_w > 6 and abs(south_w / 2 - rx) / max(south_w / 2, rx) > 0.18:
            own_rx = min(south_w / 2, W / 2 - abs(ax) - 1)
            if own_rx >= 3:
                box["size_by_dir"] = {"south": {"rx": round(own_rx, 2), "ry": round(max(2, ry), 2)}}
    if pos:
        for d, q in pos.items():
            q["ax"] = round(min(max(q["ax"], -(W / 2 - rx - 1)), W / 2 - rx - 1), 2)
        box["pos_by_dir"] = pos
    return box


def main():
    write = "--write" in sys.argv
    doc = json.loads(DOC_PATH.read_text())
    ov = doc.setdefault("overrides", {})
    rect = [o for o in DATA["domains"]["objects"] if o.get("hitboxShape") == "rect"]
    rewrote = kept_his = no_fit = fresh = 0
    now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    for o in rect:
        for st in (o.get("animations") or {}):
            key = f'{o["path"]}#{st}'
            rec = ov.get(key) or ov.get(o["path"])
            if rec and not rec.get("auto"):
                kept_his += 1
                continue
            box = fit(o, st)
            if not box:
                no_fit += 1
                continue
            if key not in ov:
                fresh += 1
            else:
                rewrote += 1
            ov[key] = {"boxes": [box], "auto": True, "updated_at": now}
    print(f"rect variations: {sum(len(o.get('animations') or {}) for o in rect)}")
    print(f"  proposals rewritten as fitted rects: {rewrote}")
    print(f"  written where there was none:        {fresh}")
    print(f"  HIS decisions left untouched:        {kept_his}")
    print(f"  no measurable footprint (skipped):   {no_fit}")
    if write:
        doc["updated_at"] = now
        DOC_PATH.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
        print("WRITTEN", DOC_PATH)
    else:
        print("dry run — pass --write to apply")


main()
