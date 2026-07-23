#!/usr/bin/env python3
"""Bake the AI-filled socket back onto the 128 grid — stick2-base-filled.png.

The maintainer round-tripped stick2-base-holed through an image model
(2026-07-23): back came a COMPLETE socket (closed back rim, well, shaft
with its occluded top invented) at 1169x896 on the light-grey backdrop of
the handoff image ("remember the background now is grey").

Recipe (first-gen bake-stick-base.py house method, minus the chroma
drama — the art is near-black on light grey):
 1. REGISTER the fill against the KNOWN pixels of the holed base by grey
    SSD (scale + offset, small anisotropy allowed — the model does not
    keep 1px/pixel).
 2. Every ORIGINAL base pixel stays byte-identical. Only pixels that are
    transparent in the holed base may gain art, inside the work bbox.
 3. Each candidate samples its registered footprint in the fill with a
    DOMINANT-COLOUR cluster (quantize, most common, darkest tie — no
    blend pixels), then keys: backdrop-family colours stay transparent.
    Output alpha is BINARY like the source art — no soft fringe to glow
    on a dark background.
 4. Additions must connect (8-way, transitively) to existing art — stray
    backdrop artifacts (the sparkle) cannot attach.

Output: client/ui-src/gamepad/stick2-base-filled.png
"""

from collections import Counter

from PIL import Image

FILL = "/root/.claude/uploads/acbf8e56-1a5a-520e-a01f-328c70374792/79236130-1784764712026.png"
BASE = "client/ui-src/gamepad/stick2-base-holed.png"
OUT = "client/ui-src/gamepad/stick2-base-filled.png"
BG = (232, 231, 227)
BG_TOL = 30          # colour distance to BG that still counts as backdrop
WORK = (14, 38, 114, 123)  # x0,y0,x1,y1 — where additions may appear


def main():
    fill = Image.open(FILL).convert("RGB")
    base = Image.open(BASE).convert("RGBA")
    fp = fill.load()
    bp = base.load()
    FW, FH = fill.size
    W, H = base.size
    dist = lambda c: ((c[0] - BG[0]) ** 2 + (c[1] - BG[1]) ** 2 + (c[2] - BG[2]) ** 2) ** 0.5
    lum = lambda c: 0.3 * c[0] + 0.6 * c[1] + 0.1 * c[2]

    known = [(x, y) for y in range(H) for x in range(W) if bp[x, y][3]]

    # ── seed the transform from the dark-content bboxes ──
    xs, ys = [], []
    for fy in range(0, FH, 3):
        for fx in range(0, FW, 3):
            if dist(fp[fx, fy]) > 80:
                xs.append(fx)
                ys.append(fy)
    fx0, fx1, fy1 = min(xs), max(xs), max(ys)
    bx0, bx1, by1 = 17, 111, 120
    s0 = (fx1 - fx0) / (bx1 - bx0)

    def score(sx, sy, ox, oy):
        t = 0.0
        n = 0
        for x, y in known[::3]:
            fx = int(x * sx + ox)
            fy = int(y * sy + oy)
            if 0 <= fx < FW and 0 <= fy < FH:
                d = lum(fp[fx, fy]) - lum(bp[x, y])
                t += d * d
                n += 1
            else:
                t += 20000
                n += 1
        return t / max(1, n)

    best = None
    for sx in (s0 * f for f in (0.96, 0.98, 1.0, 1.02, 1.04)):
        for sy in (sx * f for f in (0.96, 0.98, 1.0, 1.02, 1.04)):
            ox0 = fx0 - bx0 * sx + sx / 2
            oy0 = fy1 - by1 * sy + sy / 2
            for ox in (ox0 + d * sx for d in (-1.5, -1, -0.5, 0, 0.5, 1, 1.5)):
                for oy in (oy0 + d * sy for d in (-1.5, -1, -0.5, 0, 0.5, 1, 1.5)):
                    sc = score(sx, sy, ox, oy)
                    if best is None or sc < best[0]:
                        best = (sc, sx, sy, ox, oy)
    sc, sx, sy, ox, oy = best
    # fine offset polish
    for dox in (-0.6, -0.3, 0, 0.3, 0.6):
        for doy in (-0.6, -0.3, 0, 0.3, 0.6):
            s2 = score(sx, sy, ox + dox * sx / 2, oy + doy * sy / 2)
            if s2 < sc:
                sc, ox, oy = s2, ox + dox * sx / 2, oy + doy * sy / 2
    print(f"registered: sx={sx:.3f} sy={sy:.3f} ox={ox:.1f} oy={oy:.1f} ssd={sc:.0f}")

    def sample(x, y):
        """Dominant-colour cluster over the pixel's footprint in the fill."""
        cx0 = int(x * sx + ox - sx * 0.45)
        cy0 = int(y * sy + oy - sy * 0.45)
        cx1 = int(x * sx + ox + sx * 0.45)
        cy1 = int(y * sy + oy + sy * 0.45)
        cnt = Counter()
        for fy in range(max(0, cy0), min(FH, cy1 + 1)):
            for fx in range(max(0, cx0), min(FW, cx1 + 1)):
                c = fp[fx, fy]
                cnt[(c[0] // 24, c[1] // 24, c[2] // 24)] += 1
        if not cnt:
            return None
        top = max(cnt.values())
        # among equally-dominant clusters prefer the DARKEST (art beats halo)
        key = min((k for k, v in cnt.items() if v == top), key=sum)
        members = [
            fp[fx, fy]
            for fy in range(max(0, cy0), min(FH, cy1 + 1))
            for fx in range(max(0, cx0), min(FW, cx1 + 1))
            if (fp[fx, fy][0] // 24, fp[fx, fy][1] // 24, fp[fx, fy][2] // 24) == key
        ]
        r = round(sum(c[0] for c in members) / len(members))
        g = round(sum(c[1] for c in members) / len(members))
        b = round(sum(c[2] for c in members) / len(members))
        return (r, g, b)

    out = base.copy()
    op = out.load()
    adds = {}
    for y in range(WORK[1], WORK[3] + 1):
        for x in range(WORK[0], WORK[2] + 1):
            if bp[x, y][3]:
                continue
            c = sample(x, y)
            if c is None or dist(c) <= BG_TOL:
                continue
            adds[(x, y)] = c
    # connectivity: additions must chain back to existing art
    keep = set()
    frontier = [(x, y) for (x, y) in adds
                if any(0 <= x + dx < W and 0 <= y + dy < H and bp[x + dx, y + dy][3]
                       for dx in (-1, 0, 1) for dy in (-1, 0, 1))]
    keep.update(frontier)
    while frontier:
        nxt = []
        for x, y in frontier:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    q = (x + dx, y + dy)
                    if q in adds and q not in keep:
                        keep.add(q)
                        nxt.append(q)
        frontier = nxt
    dropped = len(adds) - len(keep)
    for (x, y), c in adds.items():
        if (x, y) in keep:
            op[x, y] = (*c, 255)
    out.save(OUT)

    # invariants: originals byte-identical, additions only in the work box
    for y in range(H):
        for x in range(W):
            if bp[x, y][3]:
                assert op[x, y] == bp[x, y], f"original px changed at {(x, y)}"
    light = sum(1 for (x, y) in keep
                if lum(adds[(x, y)]) > 150 and max(adds[(x, y)]) - min(adds[(x, y)]) < 14)
    print(f"added {len(keep)} px (dropped {dropped} unconnected), "
          f"suspicious-light kept: {light}")
    print("filled bbox:", out.getbbox())


if __name__ == "__main__":
    main()
