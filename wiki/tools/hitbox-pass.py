#!/usr/bin/env python3
"""Auto-place scenery hitboxes from each sprite's alpha, in the editor's
frame-centre coordinates. Reference taste (maintainer 2026-08-28, split rock
054): bottom curve aligned with the graphic's base, wide enough to touch left
and right, depth ratio ~0.43 (his 55.0 x 23.5), standable-behind."""
import json, sys, os
from PIL import Image, ImageDraw

ROOT = "/home/user/pixel"
D = json.load(open(f"{ROOT}/wiki/site/data.json"))
OBJECTS = D["domains"]["objects"]
WALL_TYPES = {"MOUNTAIN_WALL", "WINDOW"}
walls_ov = json.load(open(f"{ROOT}/live/tuning/scenery_walls.json")).get("overrides", {})
hb = json.load(open(f"{ROOT}/live/tuning/scenery_hitbox.json"))
existing = hb.get("overrides", {})

ISO_K = 15 / 32          # the game's own lattice (data.json iso dy/dx)
DEPTH_K = 0.43           # his hand-set rock: 23.5/55 — a touch shallower than isoK
ALPHA_T = 24

def is_wall(o):
    ov = walls_ov.get(o["path"])
    if ov is not None and isinstance(ov.get("wall"), bool):
        return ov["wall"]
    return o.get("type") in WALL_TYPES

def south_frame(o, want=None):
    """A state's south frame 0 as RGBA, plus (fw, fh).

    PER VARIATION (maintainer 2026-08-29: "different variations can be
    different size"), so `want` names the state; without it, the first state
    that has art — the piece-level default the first pass wrote."""
    anims = o.get("animations") or {}
    items = [(want, anims.get(want))] if want else list(anims.items())
    for _name, st in items:
        if not st:
            continue
        d = (st.get("dirs") or {}).get("south")
        if not d or not d.get("strip"):
            continue
        p = os.path.join(ROOT, d["strip"])
        if not os.path.exists(p):
            continue
        im = Image.open(p).convert("RGBA")
        fw = d.get("fw") or im.height
        fh = d.get("fh") or im.height
        return im.crop((0, 0, fw, fh)), fw, fh
    return None, None, None

def spans_of(cols, min_gap):
    """Occupied column list -> [(x0, x1)] merging gaps <= min_gap."""
    out = []
    for x in cols:
        if out and x - out[-1][1] <= min_gap + 1:
            out[-1][1] = x
        else:
            out.append([x, x])
    return out

def place(o, want=None):
    im, fw, fh = south_frame(o, want)
    if im is None:
        return None, "no art"
    a = im.getchannel("A").load()
    # --- opaque mask + connected components (drop debris islands) ----------
    mask = [[a[x, y] > ALPHA_T for x in range(fw)] for y in range(fh)]
    total = sum(r.count(True) for r in mask)
    if not total:
        return None, "empty alpha"
    seen = [[False] * fw for _ in range(fh)]
    comps = []
    for y0 in range(fh):
        for x0 in range(fw):
            if mask[y0][x0] and not seen[y0][x0]:
                stack, px = [(x0, y0)], []
                seen[y0][x0] = True
                while stack:
                    x, y = stack.pop()
                    px.append((x, y))
                    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < fw and 0 <= ny < fh and mask[ny][nx] and not seen[ny][nx]:
                            seen[ny][nx] = True
                            stack.append((nx, ny))
                comps.append(px)
    keep = [c for c in comps if len(c) >= max(12, 0.008 * total)] or comps
    body = set()
    for c in keep:
        body.update(c)
    xsA = [x for x, y in body]; ysA = [y for x, y in body]
    xs0, xs1, ys0, ys1 = min(xsA), max(xsA), min(ysA), max(ysA)
    H = ys1 - ys0 + 1
    W = xs1 - xs0 + 1
    colbot, coltop = {}, {}
    for x, y in body:
        if y > colbot.get(x, -1): colbot[x] = y
        if y < coltop.get(x, fh): coltop[x] = y
    # --- ground-contact columns, and the standing structure among them -----
    zone_top = max(ys0, ys1 - max(3, round(0.35 * H)))
    contact = sorted(x for x, yb in colbot.items() if yb >= zone_top)
    if not contact:
        contact = sorted(colbot)
    # a column BELONGS to the standing structure if its art runs contiguously
    # UP from the ground — a painted floor under an archway is a short grounded
    # run with the arch floating above it, and must not weld the pillars.
    def grounded_run(x):
        y = colbot[x]
        n2 = 0
        while y - n2 >= 0 and mask[y - n2][x]:
            n2 += 1
        return n2
    stand = [x for x in contact if grounded_run(x) >= 0.35 * H]
    use = None
    # an entrance must be big enough to WALK through — a stool's legs also
    # straddle air, and a stool blocks as one piece.
    if stand and W >= 80:
        # merge hairline fractures (a vine crossing a pillar): nothing walks a 5px gap
        big = [s for s in spans_of(stand, 5) if s[1] - s[0] + 1 >= max(4, 0.06 * W)]
        if len(big) >= 2 and max(big[i+1][0] - big[i][1] for i in range(len(big)-1)) >= max(6, 0.18 * W):
            # an ENTRANCE only if the gap is truly walkable. Gap art that is
            # SOLID TO THE GROUND is painted floor (an archway's pool, grass);
            # gap art with AIR UNDER it is a rail, a plank, hung laundry —
            # things a player must not clip through. Any hanging art vetoes.
            band0, band1 = int(ys1 - 0.42 * H), int(ys1 - 0.10 * H)
            n_gap = 0
            bcols = []
            for i in range(len(big) - 1):
                for x in range(big[i][1] + 1, big[i + 1][0]):
                    n_gap += 1
                    ys = [y for y in range(band0, ys1 + 1) if 0 <= y < fh and mask[y][x]]
                    if any(y0 in range(band0, band1 + 1) for y0 in ys):
                        lo2 = min(y0 for y0 in ys if y0 >= band0)
                        solid = all(mask[y][x] for y in range(lo2, colbot.get(x, lo2) + 1))
                        grounded2 = colbot.get(x, -1) >= ys1 - 0.10 * H
                        if not (solid and grounded2):
                            bcols.append(x)
            # a rail is WIDE; a light drip is 1-3 columns. Only runs count.
            blocked = sum(s2[1] - s2[0] + 1 for s2 in spans_of(sorted(bcols), 0) if s2[1] - s2[0] + 1 >= 4)
            if n_gap and blocked / n_gap < 0.15:
                use = big[:3]          # one ellipse per pillar
    multi = use is not None
    if use is None:
        use = [[contact[0], contact[-1]]]
    boxes = []
    for x0, x1 in use:
        w = x1 - x0 + 1
        rx = w / 2 + 0.5
        cols = [x for x in range(x0, x1 + 1) if x in colbot]
        bots = sorted(colbot[x] for x in cols)
        if multi and bots[int(0.85 * (len(bots) - 1))] < ys1 - 0.12 * H:
            continue                   # a span that floats (a hung towel) is not a foot
        # a pillar's foot, not the moss blob painted under it: multi-box spans
        # take a robust bottom; a single body keeps the true lowest row.
        bot = bots[int(0.85 * (len(bots) - 1))] if multi else bots[-1]
        # the span's visible base: from where it reaches (nearly) full width
        # down to the ground — his rock's ellipse wraps exactly that region.
        girth = bot
        for y in range(max(ys0, bot - int(0.6 * H)), bot + 1):
            ext = [x for x in cols if mask[y][x]]
            if ext and (ext[-1] - ext[0] + 1) >= 0.94 * w:
                girth = y
                break
        bottom = bot + 1                      # the curve hugs the base row
        ryA = 0.43 * rx                       # his rock's own ratio
        ryB = (bottom - girth) / 2            # the base the art actually shows
        ry = max(3.0, min(ryA, ryB) if ryB > 0 else ryA)
        cx = (x0 + x1 + 1) / 2
        boxes.append({
            "ax": round(cx - fw / 2, 2),
            "ay": round(bottom - fh / 2 - ry, 2),
            "rx": round(rx, 2),
            "ry": round(ry, 2),
            "rot": 0,
        })
    return boxes, f"{len(boxes)} box"

def overlay(o, boxes, out):
    im, fw, fh = south_frame(o)
    z = 4
    im2 = im.resize((fw * z, fh * z), Image.NEAREST).convert("RGB")
    dr = ImageDraw.Draw(im2)
    for b in boxes or []:
        cx, cy = (fw / 2 + b["ax"]) * z, (fh / 2 + b["ay"]) * z
        dr.ellipse([cx - b["rx"] * z, cy - b["ry"] * z, cx + b["rx"] * z, cy + b["ry"] * z], outline=(255, 110, 70), width=2)
    im2.save(out)

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "sample"
    if mode == "sample":
        picks = sys.argv[2].split(",")
        os.makedirs(sys.argv[3], exist_ok=True)
        for pid in picks:
            o = next((x for x in OBJECTS if x["id"] == pid or x["path"].endswith(pid)), None)
            if not o:
                print("?", pid); continue
            boxes, why = place(o)
            print(f"{o['id']:28s} {o['type']:14s} {why}  " + " | ".join(
                f"{2*b['rx']:.0f}x{2*b['ry']:.0f} at {b['ax']:+.1f},{b['ay']:+.1f}" for b in boxes or []))
            overlay(o, boxes, os.path.join(sys.argv[3], f"{o['id']}.png"))
    elif mode == "write":
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        n = s = 0
        for o in OBJECTS:
            if is_wall(o):
                s += 1
                continue
            for st_name in (o.get("animations") or {}):
                key = f"{o['path']}#{st_name}"
                # never overwrite a decision: his own records have no auto flag
                prev = existing.get(key)
                if prev is not None and not prev.get("auto"):
                    s += 1
                    continue
                boxes, why = place(o, st_name)
                if boxes is None:
                    print("SKIP", key, why)
                    continue
                hb["overrides"][key] = {"boxes": boxes, "auto": True, "updated_at": now}
                n += 1
        # the superseded piece-level PROPOSALS go: every variation now has its
        # own. His own piece-level decisions stay — they keep answering for a
        # variation he has not set (see hitboxRaw's fallback).
        stale = [k for k, v in hb["overrides"].items() if "#" not in k and v.get("auto")]
        for k in stale:
            del hb["overrides"][k]
        print(f"dropped {len(stale)} superseded piece-level proposals")
        hb["updated_at"] = now
        json.dump(hb, open(f"{ROOT}/live/tuning/scenery_hitbox.json", "w"), indent=2)
        open(f"{ROOT}/live/tuning/scenery_hitbox.json", "a").write("\n")
        print(f"wrote {n} variation defaults, kept {s} (walls + his own decisions)")
