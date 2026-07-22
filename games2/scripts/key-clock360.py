#!/usr/bin/env python3
"""Key the 360-degree clock art: light-grey backdrop -> transparency.

Source: client/ui-src/clock360/clock360-src.png — the maintainer's new
full-circle clock (2026-07-22): NIGHT face on the top half (moon, stars,
bat, wolf, silver numerals), the familiar DAY face below, gear mechanism at
the centre, vine wreath + flowers around, and a full-width horizontal black
line at the day/night divide (kept — it is part of the delivered art, not
backdrop). Step 1 of the 360-clock integration: remove the grey.

Method (the house keying rule, tuned for this art's quirks): a GRADIENT
FLOOD from the borders — a neighbour joins when the local step is smooth
(sum |Δ| <= FLOOD_STEP) AND it stays inside the greyish-lavender band —
because the backdrop carries a soft DROP SHADOW under the disc that a
fixed global tolerance cannot cross (the shaded wreath gaps survived) yet
interior art greys (numerals, moon, wolf) stay safe: they are only
reachable across sharp art edges. Then ENCLOSED pure-backdrop pockets
(core >= 50% within POCKET_TOL of the sampled grey, size >= 8) — looser
rules ate holes in the MOON, whose grey-blues brush the tolerances.
Finally SOFT-ALPHA the cut edge: an opaque pixel adjacent to cleared
backdrop gets alpha from its distance to its cleared neighbours' LOCAL
colour over EDGE_SOFT (local, so shadowed rims soften correctly too).

ROUND 2 — the maintainer's marked screenshot of the keyed preview
("RED = the grey area should have been transparent. GREEN = restore
graphics"), registered onto the source (uniform scale 980/1069, offset
(22,23)) and decoded to source pixels in clock360-marks-r2.json:
 - GREEN: the enclosed pass had eaten backdrop-grey LOOKALIKES that are
   really art — silver ring arc segments, numeral faces (I, IX, III) —
   and the shaded pass two pale petal blobs of the top wreath flower.
   Those come back as WHOLE cleared components near a mark (his stroke is
   hand-drawn at preview scale, so components are matched within
   MARK_DIST and accepted when well covered or tiny): un-clearing the
   component restores the true art boundary exactly. The LEFT flower is
   different: the gradient flood slipped INSIDE it and ate its cream
   centre highlights, so marked flood-cleared pixels that are clearly not
   backdrop (dist > NOT_BG) are restored individually, then a bounded
   neighbour-closure inside the marked areas heals the last anti-aliased
   specks.
 - RED: two backdrop wedges SURVIVED at the disc's left/right rim at
   divide height — the full-width black line cuts them off from the
   ocean, and shadow shading breaks the pocket rules. Re-flooded with the
   same house rules from pure-grey seeds, bounded to the marked
   neighbourhood (RED_BOX) so the clear cannot creep along the disc rim.

Output: client/ui-src/clock360/clock360-keyed.png (full resolution).
"""

import json
from collections import Counter, deque

from PIL import Image

SRC = "client/ui-src/clock360/clock360-src.png"
MARKS = "client/ui-src/clock360/clock360-marks-r2.json"
OUT = "client/ui-src/clock360/clock360-keyed.png"
FLOOD_TOL = 18   # seed/enclosed match vs the sampled backdrop
FLOOD_STEP = 40  # max sum|Δ| per step — crosses the shadow AND the halo ramps
POCKET_TOL = 7
EDGE_SOFT = 70
# round-2 mark handling
MARK_DIST = 8    # a cleared component within this reach of a GREEN mark is a candidate
MARK_COV = 0.25  # ...restored when the dilated marks cover >= this fraction of it
MARK_TINY = 30   # ...or when it is tiny (1-2 px slivers under a hand-centred stroke)
NOT_BG = 12      # colour distance beyond which a pixel is clearly art, not backdrop
RED_BOX = 50     # the RED re-flood may only act this close to a red mark


def main():
    im = Image.open(SRC).convert("RGB")
    W, H = im.size
    p = im.load()
    border = (
        [p[x, 0] for x in range(W)] + [p[x, H - 1] for x in range(W)]
        + [p[0, y] for y in range(H)] + [p[W - 1, y] for y in range(H)]
    )
    bg = Counter(border).most_common(1)[0][0]
    dist = lambda c: ((c[0] - bg[0]) ** 2 + (c[1] - bg[1]) ** 2 + (c[2] - bg[2]) ** 2) ** 0.5
    isbg = lambda c: dist(c) <= FLOOD_TOL

    def greyish(c):
        # the backdrop family: pure lavender-grey, its drop shadow, AND the
        # light halo the AI painted around the lower wreath (v up to ~238)
        r, g, b = c
        v = (r + g + b) / 3
        return abs(r - g) <= 16 and (g - 8) <= b <= (g + 30) and 140 <= v <= 238

    # origin of a cleared pixel: 1 flood ocean, 2 enclosed pocket, 3 shaded
    # pocket, 4 round-2 red re-flood (0 = opaque). The pocket passes also
    # record their components so a GREEN mark can restore one wholesale.
    cleared = [[False] * W for _ in range(H)]
    origin = [[0] * W for _ in range(H)]
    comps = []  # (pass_code, [pixels]) for enclosed + shaded components
    compid = [[-1] * W for _ in range(H)]
    q = deque()
    for x in range(W):
        for y in (0, H - 1):
            if isbg(p[x, y]) and not cleared[y][x]:
                cleared[y][x] = True
                origin[y][x] = 1
                q.append((x, y))
    for y in range(H):
        for x in (0, W - 1):
            if isbg(p[x, y]) and not cleared[y][x]:
                cleared[y][x] = True
                origin[y][x] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        c0 = p[x, y]
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if not (0 <= nx < W and 0 <= ny < H) or cleared[ny][nx]:
                continue
            c1 = p[nx, ny]
            step = abs(c1[0] - c0[0]) + abs(c1[1] - c0[1]) + abs(c1[2] - c0[2])
            if step <= FLOOD_STEP and greyish(c1):
                cleared[ny][nx] = True
                origin[ny][nx] = 1
                q.append((nx, ny))
    # enclosed backdrop pockets (wreath gaps): components of bg-matching pixels
    # not reached from outside — cleared ONLY when the component's CORE is
    # pure backdrop (>=50% of its pixels within POCKET_TOL). A plain "matches
    # within FLOOD_TOL" clear ate holes in the MOON, whose grey-blues brush
    # the tolerance (magenta speckles); a component-MEAN test then kept real
    # pockets whose anti-aliased rims dragged the mean up.
    pockets = 0
    seen = [[False] * W for _ in range(H)]
    for y0 in range(H):
        for x0 in range(W):
            if cleared[y0][x0] or seen[y0][x0] or not isbg(p[x0, y0]):
                continue
            comp = [(x0, y0)]
            seen[y0][x0] = True
            qi = 0
            core = 0
            while qi < len(comp):
                x, y = comp[qi]
                qi += 1
                if dist(p[x, y]) <= POCKET_TOL:
                    core += 1
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if (0 <= nx < W and 0 <= ny < H and not seen[ny][nx]
                            and not cleared[ny][nx] and isbg(p[nx, ny])):
                        seen[ny][nx] = True
                        comp.append((nx, ny))
            # backdrop pockets have a PURE core AND real size; art greys that
            # merely brush the flood tolerance (moon craters, ring glints —
            # 1-3 px specks) fail one or the other
            if core / len(comp) >= 0.5 and len(comp) >= 8:
                cid = len(comps)
                comps.append((2, comp))
                for x, y in comp:
                    cleared[y][x] = True
                    origin[y][x] = 2
                    compid[y][x] = cid
                pockets += len(comp)
    # SHADED pockets: the backdrop's drop shadow / wreath-halo pockets are too
    # far from the pure grey for the passes above and their border to the
    # cleared region is a sharp step the gradient flood cannot cross. They are
    # dense low-saturation BLOBS in the WREATH ZONE — selected by colour
    # family + density >= 0.4 + min-dim >= 5 + centroid radius >= 0.8R (the
    # interior numerals fail the radius, the thin silver ring arcs fail the
    # density, the violet flower petals fail the low-saturation family; each
    # selection was eyeballed on the numbered overlay before this shipped).
    xs = ys = nn = 0
    for y in range(0, H, 2):
        for x in range(0, W, 2):
            if not cleared[y][x]:
                xs += x; ys += y; nn += 1
    ccx, ccy = xs / nn, ys / nn
    R = 0.0
    for y in range(0, H, 2):
        for x in range(0, W, 2):
            if not cleared[y][x]:
                R = max(R, ((x - ccx) ** 2 + (y - ccy) ** 2) ** 0.5)

    def fam(c):
        r, g, b = c
        v = (r + g + b) / 3
        return abs(r - g) <= 16 and (g - 8) <= b <= (g + 32) and 135 <= v <= 238

    seen2 = [[False] * W for _ in range(H)]
    shaded = 0
    for y0 in range(H):
        for x0 in range(W):
            if seen2[y0][x0] or cleared[y0][x0] or not fam(p[x0, y0]):
                continue
            comp = [(x0, y0)]
            seen2[y0][x0] = True
            qi = 0
            while qi < len(comp):
                x, y = comp[qi]
                qi += 1
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if (0 <= nx < W and 0 <= ny < H and not seen2[ny][nx]
                            and not cleared[ny][nx] and fam(p[nx, ny])):
                        seen2[ny][nx] = True
                        comp.append((nx, ny))
            if len(comp) < 20:
                continue
            bx0 = min(c[0] for c in comp); bx1 = max(c[0] for c in comp) + 1
            by0 = min(c[1] for c in comp); by1 = max(c[1] for c in comp) + 1
            dens = len(comp) / ((bx1 - bx0) * (by1 - by0))
            mx = sum(c[0] for c in comp) / len(comp)
            my = sum(c[1] for c in comp) / len(comp)
            rad = ((mx - ccx) ** 2 + (my - ccy) ** 2) ** 0.5
            if dens >= 0.4 and min(bx1 - bx0, by1 - by0) >= 5 and rad >= 0.80 * R:
                cid = len(comps)
                comps.append((3, comp))
                for x, y in comp:
                    cleared[y][x] = True
                    origin[y][x] = 3
                    compid[y][x] = cid
                shaded += len(comp)
    print(f"shaded-pocket px cleared: {shaded}")

    # ── round 2: the maintainer's GREEN restores + RED clears ──
    marks = json.load(open(MARKS))
    green = [(x, y) for x, y in marks["green"] if 0 <= x < W and 0 <= y < H]
    red = [(x, y) for x, y in marks["red"] if 0 <= x < W and 0 <= y < H]

    def dilate(pts, r):
        g = [[False] * W for _ in range(H)]
        for x, y in pts:
            for yy in range(max(0, y - r), min(H, y + r + 1)):
                row = g[yy]
                for xx in range(max(0, x - r), min(W, x + r + 1)):
                    row[xx] = True
        return g

    gnear = dilate(green, MARK_DIST)
    gcov = dilate(green, 3)  # coverage test tolerates the ±1 px decode error
    restored = set()
    for cid, (pc, comp) in enumerate(comps):
        if not any(gnear[y][x] for x, y in comp):
            continue
        cov = sum(1 for x, y in comp if gcov[y][x])
        take = cov / len(comp) >= MARK_COV or len(comp) <= MARK_TINY
        bx = (min(c[0] for c in comp), min(c[1] for c in comp),
              max(c[0] for c in comp), max(c[1] for c in comp))
        print(f"green comp#{cid} pass={pc} size={len(comp)} cov={cov} "
              f"bbox={bx} -> {'RESTORE' if take else 'keep cleared'}")
        if take:
            for x, y in comp:
                cleared[y][x] = False
                origin[y][x] = 0
            restored.update(comp)
    # flood-eaten art under a green mark (the left flower's cream highlights):
    # restore individually when the colour is clearly not backdrop...
    flood_restored = 0
    for x, y in green:
        if cleared[y][x] and origin[y][x] == 1 and dist(p[x, y]) > NOT_BG:
            cleared[y][x] = False
            origin[y][x] = 0
            flood_restored += 1
    # ...then close over the marked neighbourhood: a cleared non-backdrop
    # pixel mostly surrounded by kept art is an eaten speck, not backdrop
    # (never fires on pure grey, so it cannot creep into the open ocean)
    closed = 0
    grew = True
    while grew:
        grew = False
        for y in range(H):
            row = gnear[y]
            for x in range(W):
                if not row[x] or not cleared[y][x] or origin[y][x] == 4:
                    continue
                if dist(p[x, y]) <= NOT_BG:
                    continue
                nb = sum(
                    1 for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                    if (dx or dy) and 0 <= x + dx < W and 0 <= y + dy < H
                    and not cleared[y + dy][x + dx]
                )
                if nb >= 5:
                    cleared[y][x] = False
                    origin[y][x] = 0
                    closed += 1
                    grew = True
    print(f"green: comps restored={len(restored)}px "
          f"flood-restored={flood_restored}px closure={closed}px")

    # RED: re-flood the surviving backdrop wedges from pure-grey seeds,
    # confined to the marked neighbourhood
    rnear = dilate(red, RED_BOX)
    rq = deque()
    red_cleared = 0
    for y in range(H):
        for x in range(W):
            if rnear[y][x] and not cleared[y][x] and dist(p[x, y]) <= POCKET_TOL:
                cleared[y][x] = True
                origin[y][x] = 4
                red_cleared += 1
                rq.append((x, y))
    while rq:
        x, y = rq.popleft()
        c0 = p[x, y]
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if not (0 <= nx < W and 0 <= ny < H) or cleared[ny][nx] or not rnear[ny][nx]:
                continue
            c1 = p[nx, ny]
            step = abs(c1[0] - c0[0]) + abs(c1[1] - c0[1]) + abs(c1[2] - c0[2])
            if step <= FLOOD_STEP and greyish(c1):
                cleared[ny][nx] = True
                origin[ny][nx] = 4
                red_cleared += 1
                rq.append((nx, ny))
    if red_cleared:
        rxs = [x for y in range(H) for x in range(W) if origin[y][x] == 4]
        rys = [y for y in range(H) for x in range(W) if origin[y][x] == 4]
        print(f"red: cleared={red_cleared}px x[{min(rxs)}..{max(rxs)}] "
              f"y[{min(rys)}..{max(rys)}]")
    # audit: any OTHER surviving pure-backdrop patches he has not marked?
    # (log-only — unmarked art is his call, not the script's)
    seen3 = [[False] * W for _ in range(H)]
    for y0 in range(H):
        for x0 in range(W):
            if seen3[y0][x0] or cleared[y0][x0] or dist(p[x0, y0]) > POCKET_TOL:
                continue
            comp = [(x0, y0)]
            seen3[y0][x0] = True
            qi = 0
            while qi < len(comp):
                x, y = comp[qi]
                qi += 1
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if (0 <= nx < W and 0 <= ny < H and not seen3[ny][nx]
                            and not cleared[ny][nx] and dist(p[nx, ny]) <= POCKET_TOL):
                        seen3[ny][nx] = True
                        comp.append((nx, ny))
            if len(comp) >= 20:
                bx = (min(c[0] for c in comp), min(c[1] for c in comp),
                      max(c[0] for c in comp), max(c[1] for c in comp))
                print(f"audit: surviving pure-bg patch size={len(comp)} bbox={bx}")

    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    o = out.load()
    soft = 0
    for y in range(H):
        for x in range(W):
            if cleared[y][x]:
                continue
            c = p[x, y]
            a = 255
            near = any(
                0 <= x + dx < W and 0 <= y + dy < H and cleared[y + dy][x + dx]
                for dx in (-1, 0, 1) for dy in (-1, 0, 1)
            )
            if near:
                # soften vs the LOCAL cleared colour (the backdrop is shaded)
                ns = [p[x + dx, y + dy] for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                      if 0 <= x + dx < W and 0 <= y + dy < H and cleared[y + dy][x + dx]]
                lr = sum(n[0] for n in ns) / len(ns)
                lg = sum(n[1] for n in ns) / len(ns)
                lb = sum(n[2] for n in ns) / len(ns)
                d = ((c[0] - lr) ** 2 + (c[1] - lg) ** 2 + (c[2] - lb) ** 2) ** 0.5
                if d < EDGE_SOFT:
                    a = max(0, min(255, round(255 * d / EDGE_SOFT)))
                    soft += 1
            o[x, y] = (*c, a)
    out.save(OUT)
    print(f"keyed: bg={bg}, pocket px cleared={pockets}, soft-edge px={soft}")
    print("bbox:", out.getbbox())


if __name__ == "__main__":
    main()
