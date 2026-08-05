#!/usr/bin/env python3
"""Re-extract the HUD tab icons from the maintainer's round-2 plaque mock
(2026-07-18: "reextract the icons from this file instead — more crisp,
better looking border"; the screenshot is soft/compressed but the art
pixels are ~5.33 source px, so the true grid is recoverable).

Method per plaque:
1. GRID FIT: fixed consensus pitch candidates (the whole mock renders at
   one scale); per-region phase by boundary-vs-centre gradient contrast.
2. KEY AT SOURCE RES: flood the plaque background from the region border
   with the icon's dark outline (a ~5px continuous band even under blur)
   as the barrier; a cell is icon if most of its source px stayed dry.
3. RESAMPLE: median of the 3x3 source px at each cell centre.
4. COMPONENT PICK: keep only the icon component under the plaque centre —
   drops the SETTINGS leaves/pick/shovel (maintainer: "only the gear"),
   the baked labels, and plaque specks. Enclosed pockets that match the
   plaque wood (the gear's centre hole) go transparent.
5. Save at 2x nearest (the shipped icon-* convention; hud.ts renders the
   files 1:1 CSS px = 2x art zoom).

Usage: extract-hud-icons.py <screenshot> [--out client/public/ui2/]
"""

import sys
from collections import deque

from PIL import Image

REGIONS = {
    "icon-backpack": (58, 42, 258, 218),
    "icon-equipment": (255, 38, 458, 218),
    "icon-map": (458, 42, 652, 218),
    "icon-settings": (650, 38, 852, 218),
    "icon-logout": (845, 42, 1055, 218),
}

# Hand-tuned ERASERS in extracted-cell coords (pre-crop), removing what the
# component pick can't: the plaque border ring the equipment antlers touch,
# and the settings pick/shovel/leaves that touch the gear (maintainer:
# "only the gear"). Tuned against grid renders — re-derive if REGIONS move.
ERASE: dict[str, list[tuple[int, int, int, int]]] = {}

PALETTE_K = 18  # k-means palette size for the mottle cleanup

PITCHES = [5.33]  # ONE physical render scale for the whole mock
OUTLINE = 80  # luma barrier: the icon's dark outline stops the bg flood


def luma(p):
    return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]


def fit_phase(px, box, pitch):
    x0, y0, x1, y1 = box
    gx = [0.0] * (x1 - x0)
    gy = [0.0] * (y1 - y0)
    for y in range(y0, y1):
        for x in range(x0, x1 - 1):
            gx[x - x0] += abs(luma(px[x + 1, y]) - luma(px[x, y]))
    for y in range(y0, y1 - 1):
        for x in range(x0, x1):
            gy[y - y0] += abs(luma(px[x, y + 1]) - luma(px[x, y]))

    def best_phase(prof):
        best = None
        for ph in [i * 0.2 for i in range(int(pitch * 5))]:
            bnd = cen = n = 0.0
            p = ph
            while p < len(prof) - 1:
                bnd += prof[int(p)]
                cen += prof[int(min(len(prof) - 1, p + pitch / 2))]
                n += 1
                p += pitch
            s = (bnd - cen) / max(1, n)
            if best is None or s > best[0]:
                best = (s, ph)
        return best

    sx, phx = best_phase(gx)
    sy, phy = best_phase(gy)
    return sx + sy, phx, phy


def extract(im, name, box):
    px = im.load()
    best = None
    for pitch in PITCHES:
        s, phx, phy = fit_phase(px, box, pitch)
        if best is None or s > best[0]:
            best = (s, pitch, phx, phy)
    _, pitch, phx, phy = best
    x0, y0, x1, y1 = box

    # background flood at SOURCE resolution (barrier: dark outline band).
    # Seeds sit INSET from the box corners/edges — the box rim can lie on
    # the dark page behind the plaques, which is itself below the barrier
    # (a rim-seeded flood then never starts; the equipment plaque did that)
    w, h = x1 - x0, y1 - y0
    wet = [[False] * w for _ in range(h)]
    q = deque()
    for fy in (0.12, 0.5, 0.88):
        for fx in (0.12, 0.5, 0.88):
            if fx == 0.5 and fy == 0.5:
                continue  # centre belongs to the icon
            q.append((int(h * fy), int(w * fx)))
    while q:
        r, c = q.popleft()
        if not (0 <= r < h and 0 <= c < w) or wet[r][c]:
            continue
        if luma(px[x0 + c, y0 + r]) < OUTLINE:
            continue
        wet[r][c] = True
        q.extend([(r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)])

    cols = int((w - phx) / pitch)
    rows = int((h - phy) / pitch)

    def cell_center(r, c):
        return int(x0 + phx + (c + 0.5) * pitch), int(y0 + phy + (r + 0.5) * pitch)

    def cell_dry(r, c):
        cx, cy = cell_center(r, c)
        dry = tot = 0
        span = int(pitch / 2) - 1
        for dy in range(-span, span + 1):
            for dx in range(-span, span + 1):
                sx_, sy_ = cx + dx - x0, cy + dy - y0
                if 0 <= sx_ < w and 0 <= sy_ < h:
                    tot += 1
                    if not wet[sy_][sx_]:
                        dry += 1
        return tot and dry / tot >= 0.5

    def cell_color(r, c):
        cx, cy = cell_center(r, c)
        ch = [[], [], []]
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                p = px[min(im.width - 1, cx + dx), min(im.height - 1, cy + dy)]
                for i in range(3):
                    ch[i].append(p[i])
        return tuple(sorted(ch[i])[4] for i in range(3))

    icon = [[cell_dry(r, c) for c in range(cols)] for r in range(rows)]

    # keep only the component under the plaque centre (4-connected — the
    # diagonal bridges were merging neighbours that merely touch corners)
    comp = [[False] * cols for _ in range(rows)]
    q = deque([(rows // 2, cols // 2)])
    while q:
        r, c = q.popleft()
        if not (0 <= r < rows and 0 <= c < cols) or comp[r][c] or not icon[r][c]:
            continue
        comp[r][c] = True
        q.extend([(r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)])

    # hand-tuned erasers (plaque ring segments, attached tools/leaves)
    for er0, ec0, er1, ec1 in ERASE.get(name, []):
        for r in range(max(0, er0), min(rows, er1)):
            for c in range(max(0, ec0), min(cols, ec1)):
                comp[r][c] = False

    # plaque-wood reference (median of flooded cells) to clear enclosed
    # pockets that just show the plaque through (the gear's centre hole)
    bg_cells = [cell_color(r, c) for r in range(rows) for c in range(cols) if not icon[r][c]]
    med = tuple(sorted(p[i] for p in bg_cells)[len(bg_cells) // 2] for i in range(3))

    def plaque_like(col):
        return sum(abs(col[i] - med[i]) for i in range(3)) < 90

    # enclosed pockets: comp cells NOT reachable from outside the bbox…
    # simpler: pocket = 4-connected group of comp cells that are BRIGHT
    # (not outline) and plaque-toned; clear the whole group only if every
    # cell in it is plaque-toned
    seen = [[False] * cols for _ in range(rows)]
    for r in range(rows):
        for c in range(cols):
            if comp[r][c] and not seen[r][c] and luma(cell_color(r, c)) >= OUTLINE:
                group = []
                ok = True
                q = deque([(r, c)])
                seen[r][c] = True
                while q:
                    rr, cc = q.popleft()
                    col = cell_color(rr, cc)
                    if luma(col) < OUTLINE:
                        continue
                    group.append((rr, cc))
                    if not plaque_like(col):
                        ok = False
                    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nr, nc = rr + dr, cc + dc
                        if 0 <= nr < rows and 0 <= nc < cols and comp[nr][nc] and not seen[nr][nc]:
                            if luma(cell_color(nr, nc)) >= OUTLINE:
                                seen[nr][nc] = True
                                q.append((nr, nc))
                if ok:
                    for rr, cc in group:
                        comp[rr][cc] = False

    # PALETTE SNAP: k-means over the kept cells, every cell snapped to its
    # centroid — flattens the screenshot's JPEG mottle back into the flat
    # fills pixel art is made of
    kept = [(r, c, cell_color(r, c)) for r in range(rows) for c in range(cols) if comp[r][c]]
    cents = [kept[0][2]]
    while len(cents) < min(PALETTE_K, len(kept)):  # farthest-point init
        far = max(kept, key=lambda k: min(sum((k[2][j] - ct[j]) ** 2 for j in range(3)) for ct in cents))
        cents.append(far[2])
    for _ in range(12):
        buckets: list[list[tuple[int, int, int]]] = [[] for _ in cents]
        for _, _, col in kept:
            bi = min(range(len(cents)), key=lambda i: sum((col[j] - cents[i][j]) ** 2 for j in range(3)))
            buckets[bi].append(col)
        cents = [
            tuple(sum(p[j] for p in b) // len(b) for j in range(3)) if b else cents[i]
            for i, b in enumerate(buckets)
        ]
    out = Image.new("RGBA", (cols, rows), (0, 0, 0, 0))
    op = out.load()
    for r, c, col in kept:
        best = min(cents, key=lambda ct: sum((col[j] - ct[j]) ** 2 for j in range(3)))
        op[c, r] = (*best, 255)
    bb = out.getbbox()
    if not bb:
        print(f"{name}: EMPTY extraction!")
        return None
    out = out.crop(bb)
    out = out.resize((out.width * 2, out.height * 2), Image.NEAREST)
    print(f"{name}: pitch {pitch} phase ({phx:.1f},{phy:.1f}) -> {out.width//2}x{out.height//2} art")
    return out


def main():
    im = Image.open(sys.argv[1]).convert("RGB")
    out_dir = sys.argv[3] if len(sys.argv) > 3 else "client/public/ui2/"
    for name, box in REGIONS.items():
        icon = extract(im, name, box)
        if icon:
            icon.save(out_dir + name + ".png")


if __name__ == "__main__":
    main()
