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

ROUND 4 — trim the divide line: with the extraction approved ("The
extracted click is now perfect!") he red-marked the divider's OUTBOARD
stubs — the black line originally runs the full canvas width, floating
past the wreath silhouette on both sides. His strokes (decoded like round
3, kept in clock360-marks-r4.json) span x[0..78] and x[980..1067] over
the line body; the cut clears the line BAND rows only (LINE_BAND — the
full-width fringe+core rows) across those column ranges, right stub
extended to the canvas edge his stroke fell one pixel short of. Row 493
and below are wreath art at both junctions (a leaf under x72..78, a vine
ledge under x980..991) and are never touched — the line INSIDE the disc
stays, per his call.

ROUND 3 — "This is on individual pixel level now": his second marked
screenshot (a ~0.94x viewer shot of the corrected art, registered via the
magenta content bbox) is applied LITERALLY, pixel for pixel, from
clock360-marks-r3.json. GREEN ("should not have been transparent") pins
the pixel fully opaque — that restores the eaten X-numeral serifs and a
vine chunk below II, and also OVERRIDES the soft-edge pass, because a
half-ghosted rim pixel reads as damage too. RED ("should have been
transparent") clears the pixel outright — soft-edge ghost crumbs of rim
shadow poking out of the wreath silhouette. No inference on top: a green
mark on already-opaque art and a red mark on already-cleared backdrop are
no-ops, which also makes the decode robust to the shot's registration
fuzz.

Output: client/ui-src/clock360/clock360-keyed.png (full resolution).
"""

import json
from collections import Counter, deque

from PIL import Image

SRC = "client/ui-src/clock360/clock360-src.png"
MARKS = "client/ui-src/clock360/clock360-marks-r2.json"
MARKS3 = "client/ui-src/clock360/clock360-marks-r3.json"
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
# round-3 closure (heal what the pixel-level scribble narrowly missed)
CLOSE_REACH = 3  # enclosed-pocket rule: reach around a pinned green pixel
CLOSE_MAX = 40   # ...max pocket size
CLOSE_ART = 60   # art-colour rule: srcdist beyond any backdrop/halo grey
# round-4 divider trim (derived from clock360-marks-r4.json)
LINE_BAND = (486, 492)             # the divider's full-width rows: fringe + core
LINE_CUT = ((0, 78), (980, 1068))  # his red strokes; right stub to the canvas edge


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

    # ── round 3: literal per-pixel overrides, applied last so they win ──
    m3 = json.load(open(MARKS3))
    pin = set()  # GREEN pixels: forced fully opaque, exempt from soft-edge
    g_restored = 0
    for x, y in m3["green"]:
        if 0 <= x < W and 0 <= y < H:
            if cleared[y][x]:
                g_restored += 1
            cleared[y][x] = False
            origin[y][x] = 0
            pin.add((x, y))
    r_cleared = 0
    for x, y in m3["red"]:
        if 0 <= x < W and 0 <= y < H:
            if not cleared[y][x]:
                r_cleared += 1
            cleared[y][x] = True
            origin[y][x] = 5
            pin.discard((x, y))
    print(f"round3: green pinned={len(pin)} (un-cleared {g_restored}), "
          f"red cleared={r_cleared}")
    # round-3 closure: the pixel-level scribble (decoded through a ~0.94x
    # lossy shot) brackets the damage but misses single pixels. Two NARROW
    # rules heal those without ever touching real backdrop — both disclosed
    # to the maintainer, and a red mark next round overrides either:
    #  (A) ENCLOSED POCKETS: a small transparent 4-component living entirely
    #      within CLOSE_REACH of pinned pixels and sealed off from any
    #      transparent pixel outside that zone is a leftover dash INSIDE art
    #      (serif / leaf-highlight bits whose colour matches the backdrop —
    #      colour cannot judge them, enclosure can). The open ocean always
    #      touches transparency beyond the zone, so it can never qualify.
    #  (B) ART-COLOUR CRUMBS: a transparent pixel hugging a pin whose source
    #      colour sits far outside the backdrop/halo family (> CLOSE_ART;
    #      halos top out near 47) is eaten art regardless of connectivity —
    #      vine-edge shadow the stroke stopped one pixel short of.
    redset = {(x, y) for x, y in m3["red"] if 0 <= x < W and 0 <= y < H}
    zone = set()
    for x, y in pin:
        for dx in range(-CLOSE_REACH, CLOSE_REACH + 1):
            for dy in range(-CLOSE_REACH, CLOSE_REACH + 1):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H:
                    zone.add((nx, ny))
    healed_a = healed_b = 0
    seen4 = set()
    for x0, y0 in sorted(zone):
        if (x0, y0) in seen4 or not cleared[y0][x0] or (x0, y0) in redset:
            continue
        comp = [(x0, y0)]
        seen4.add((x0, y0))
        qi = 0
        sealed = True
        while qi < len(comp):
            x, y = comp[qi]
            qi += 1
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if not (0 <= nx < W and 0 <= ny < H) or not cleared[ny][nx]:
                    continue
                if (nx, ny) not in zone:
                    sealed = False
                    continue
                if (nx, ny) not in seen4:
                    seen4.add((nx, ny))
                    comp.append((nx, ny))
        if sealed and len(comp) <= CLOSE_MAX and not any(c in redset for c in comp):
            for x, y in comp:
                cleared[y][x] = False
                origin[y][x] = 0
            healed_a += len(comp)
    pin2 = set()
    for x, y in pin:
        for dx in (-2, -1, 0, 1, 2):
            for dy in (-2, -1, 0, 1, 2):
                pin2.add((x + dx, y + dy))
    for x, y in sorted(pin2):
        if not (0 <= x < W and 0 <= y < H) or (x, y) in redset:
            continue
        if cleared[y][x] and dist(p[x, y]) > CLOSE_ART:
            cleared[y][x] = False
            origin[y][x] = 0
            healed_b += 1
    print(f"round3 closure: enclosed-pocket px={healed_a}, art-colour px={healed_b}")

    # ── round 4: trim the divider's outboard stubs (line band only) ──
    trimmed = 0
    for cx0, cx1 in LINE_CUT:
        for y in range(LINE_BAND[0], LINE_BAND[1] + 1):
            for x in range(cx0, min(cx1, W - 1) + 1):
                if cleared[y][x]:
                    continue
                v = sum(p[x, y]) / 3
                # the band here is line fringe/core (dark) by construction; a
                # bright pixel would mean the cut is misaligned — refuse it
                assert v < 130, f"round4: non-line pixel at ({x},{y}) v={v:.0f}"
                cleared[y][x] = True
                origin[y][x] = 6
                trimmed += 1
    print(f"round4: divider stub px trimmed={trimmed}")

    # ── output with DE-FRINGE (maintainer 2026-07-22 #2: on the game's dark
    # HUD the rim showed LIGHT GREY — "in reality the pixels was black with a
    # percentage transparency"). The old soft-edge pass kept each edge
    # pixel's OBSERVED colour — art blended over the grey backdrop — so the
    # backdrop stayed baked into the fringe and glowed on dark backgrounds.
    # UNMIX instead: an edge pixel is a mix C = a·F + (1-a)·B of its true
    # foreground F over the local backdrop B. For every kept pixel within
    # DEFRINGE_R of transparency that is either backdrop-family or inside
    # the old soft ramp, estimate F from nearby SOLID art (the vine outline
    # / leaf / wood the fringe belongs to; near-black fallback = his model),
    # solve for a, and emit (F, a). Over the original grey that renders back
    # to ~C; over the dark HUD the fringe now fades into the background.
    # Round-3 pinned pixels stay exactly as pinned. Applied along the WHOLE
    # silhouette — his red marks are examples ("we might have more pixels
    # like this on the other side").
    DEFRINGE_R = 2
    SOLID = 110          # |C-B| at/above which a pixel is solid art
    FALLBACK_F = (14, 16, 18)

    def fam2(c):
        r, g, b = c
        v = (r + g + b) / 3
        return abs(r - g) <= 20 and (g - 10) <= b <= (g + 34) and 60 <= v <= 238

    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    o = out.load()
    soft = 0
    unmixed = 0
    for y in range(H):
        for x in range(W):
            if cleared[y][x]:
                continue
            c = p[x, y]
            if (x, y) in pin:
                o[x, y] = (*c, 255)
                continue
            # local backdrop over the de-fringe window
            ns = [p[x + dx, y + dy]
                  for dx in range(-DEFRINGE_R, DEFRINGE_R + 1)
                  for dy in range(-DEFRINGE_R, DEFRINGE_R + 1)
                  if 0 <= x + dx < W and 0 <= y + dy < H and cleared[y + dy][x + dx]]
            if not ns:
                o[x, y] = (*c, 255)
                continue
            lr = sum(n[0] for n in ns) / len(ns)
            lg = sum(n[1] for n in ns) / len(ns)
            lb = sum(n[2] for n in ns) / len(ns)
            d = ((c[0] - lr) ** 2 + (c[1] - lg) ** 2 + (c[2] - lb) ** 2) ** 0.5
            near1 = any(
                0 <= x + dx < W and 0 <= y + dy < H and cleared[y + dy][x + dx]
                for dx in (-1, 0, 1) for dy in (-1, 0, 1)
            )
            if not (fam2(c) or (near1 and d < EDGE_SOFT)):
                o[x, y] = (*c, 255)
                continue
            # true foreground: mean of solid art in the window (else black-ish)
            fs = [p[x + dx, y + dy]
                  for dx in range(-DEFRINGE_R, DEFRINGE_R + 1)
                  for dy in range(-DEFRINGE_R, DEFRINGE_R + 1)
                  if 0 <= x + dx < W and 0 <= y + dy < H
                  and not cleared[y + dy][x + dx]
                  and ((p[x + dx, y + dy][0] - lr) ** 2
                       + (p[x + dx, y + dy][1] - lg) ** 2
                       + (p[x + dx, y + dy][2] - lb) ** 2) ** 0.5 >= SOLID]
            if fs:
                F = (round(sum(n[0] for n in fs) / len(fs)),
                     round(sum(n[1] for n in fs) / len(fs)),
                     round(sum(n[2] for n in fs) / len(fs)))
            else:
                F = FALLBACK_F
            fb = ((F[0] - lr) ** 2 + (F[1] - lg) ** 2 + (F[2] - lb) ** 2) ** 0.5
            a = max(0.0, min(1.0, d / fb)) if fb >= 1 else min(1.0, d / SOLID)
            if a >= 0.99:
                o[x, y] = (*c, 255)
                continue
            o[x, y] = (*F, max(0, min(255, round(255 * a))))
            unmixed += 1
            if near1 and d < EDGE_SOFT:
                soft += 1
    out.save(OUT)
    print(f"keyed: bg={bg}, pocket px cleared={pockets}, "
          f"defringed px={unmixed} (of which old-soft {soft})")
    print("bbox:", out.getbbox())


if __name__ == "__main__":
    main()
