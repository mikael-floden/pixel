#!/usr/bin/env python3
"""Project the default world's monster spawn zones onto its minimap.

The wiki's monster pages show WHERE a creature lives. The world already ships
the isometric `minimap.png` the game's Map tab uses, so the honest overlay is
that same image with each zone's real polygon drawn on it — which means we
need the exact cell → minimap-pixel transform.

The renderer's layout (maps2/pipeline/render2.py) gives cell → FULL-render
pixels; the saved minimap is that render, cropped/padded by whatever the
world's own builder does and resized to a fixed width. Rather than guess each
builder's padding, we FIT the remaining affine (uniform scale + offset) by
matching the predicted content bounding box to the PNG's opaque bounding box —
so this works for any world, and the fit is validated (x/y scales must agree,
and projected zone cells must land on opaque pixels) before anything is
written.

Run from the repo root whenever a world's spawns or minimap change:

    python3 wiki/tools/world-map.py            # the game's DEFAULT world
    python3 wiki/tools/world-map.py ring_test  # a specific world

Output: wiki/world_map.json — minimap size/path + per-monster zone polygons
already in MINIMAP PIXEL coordinates (the wiki just strokes them).
build.mjs folds it into site/data.json; a missing file simply means no map.
"""
import json, os, re, sys, datetime
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# tiles2 iso geometry + render2's canvas padding (see maps2/pipeline).
DX, DY, LEVEL_PX, MARGIN, TILE = 32, 15, 16, 12, 64


def default_world() -> str:
    try:
        src = open(os.path.join(ROOT, "games2", "client", "src", "maps.ts")).read()
        return re.search(r'DEFAULT_WORLD\s*=\s*"([^"]+)"', src).group(1)
    except Exception:
        return "the_island2"


def build(name: str) -> dict | None:
    wdir = os.path.join(ROOT, "maps2", "worlds", name)
    wpath, mpath, spath = (os.path.join(wdir, f) for f in ("world.json", "minimap.png", "spawns.json"))
    if not all(os.path.isfile(p) for p in (wpath, mpath, spath)):
        print(f"  {name}: missing world.json / minimap.png / spawns.json — skipped")
        return None
    world = json.load(open(wpath))
    W, H = world["size"]["w"], world["size"]["h"]
    level = np.array(world["level"])
    top = np.array(world["top"])
    maxL = int(level.max())
    ox, oy = (H - 1) * DX + MARGIN, maxL * LEVEL_PX + 40 + MARGIN

    # Predicted bbox of the DRAWN content in full-render pixels.
    ys, xs = np.where(top >= 0)
    bx = ox + (xs - ys) * DX
    by = oy + (xs + ys) * DY - level[ys, xs] * LEVEL_PX
    pred = (float(bx.min()), float(by.min()), float(bx.max() + TILE), float(by.max() + TILE))

    img = Image.open(mpath).convert("RGBA")
    alpha = np.array(img)[:, :, 3]
    yy, xx = np.where(alpha > 0)
    meas = (float(xx.min()), float(yy.min()), float(xx.max() + 1), float(yy.max() + 1))

    sx = (meas[2] - meas[0]) / (pred[2] - pred[0])
    sy = (meas[3] - meas[1]) / (pred[3] - pred[1])
    if abs(sx - sy) / max(sx, sy) > 0.01:
        print(f"  {name}: x/y scales disagree ({sx:.5f} vs {sy:.5f}) — refusing to guess")
        return None
    s = (sx + sy) / 2
    offx, offy = meas[0] - s * pred[0], meas[1] - s * pred[1]

    # RASTERIZE the zone into CELLS — never project the outline itself.
    # A zone polygon is simple in the flat cell plane, but the iso projection
    # of a vertex includes that corner's terrain height (−level·16px, and
    # this world is 40 levels tall): applying it per-vertex is NON-LINEAR, so
    # neighbouring vertices on a cliff edge get torn hundreds of px apart and
    # the outline self-intersects into shards. (Shipped once, 2026-07-30; the
    # maps agent proved the data clean — 0 self-intersections — and the bug
    # was here.) Drawing the cells the polygon CONTAINS, each diamond at its
    # own level, is immune by construction and hugs the terraces honestly.
    def cells_of(poly) -> np.ndarray:
        """Cells whose CENTRE is inside the polygon (even-odd) — the same
        rule the game's zonePolygonCells uses."""
        px = np.array([p[0] for p in poly], float)
        py = np.array([p[1] for p in poly], float)
        c0, c1 = max(0, int(px.min()) - 1), min(W - 1, int(px.max()) + 1)
        r0, r1 = max(0, int(py.min()) - 1), min(H - 1, int(py.max()) + 1)
        if c1 < c0 or r1 < r0:
            return np.zeros((0, 0), bool)
        cc, rr = np.meshgrid(np.arange(c0, c1 + 1) + 0.5, np.arange(r0, r1 + 1) + 0.5)
        inside = np.zeros(cc.shape, bool)
        for i in range(len(poly)):
            x1, y1 = px[i], py[i]
            x2, y2 = px[(i + 1) % len(poly)], py[(i + 1) % len(poly)]
            if y1 == y2:
                continue
            straddles = ((y1 > rr) != (y2 > rr))
            xint = x1 + (rr - y1) * (x2 - x1) / (y2 - y1)
            inside ^= straddles & (cc < xint)
        return inside, c0, r0

    # Decks (bridges, cave roofs) are a SECOND surface over a cell. A zone
    # qualifies a cell on whichever surface — base or deck — sits inside its
    # elev band (the game's buildZoneRuntimes rule), so a bridge habitat lives
    # at deck height even though the water below is out of band.
    deck_levels: dict[tuple[int, int], list[int]] = {}
    for dk in world.get("decks") or []:
        lv = int(dk.get("level") or 0)
        for cell in dk.get("cells") or []:
            deck_levels.setdefault((int(cell["x"]), int(cell["y"])), []).append(lv)

    def surface_level(c: int, r: int, band) -> int | None:
        """The level this zone actually occupies at (c,r) — None when neither
        surface is inside the band."""
        base = int(level[r][c])
        if band is None:
            return base
        lo, hi = int(band[0]), int(band[1])
        if lo <= base <= hi:
            return base
        for lv in deck_levels.get((c, r), ()):
            if lo <= lv <= hi:
                return lv
        return None

    def spans_of(poly, band) -> list[list[int]]:
        """Runs of consecutive cells sharing a row AND a surface level — each
        run is one parallelogram on screen (the union of its diamonds)."""
        got = cells_of(poly)
        if not isinstance(got, tuple):
            return []
        inside, c0, r0 = got
        out = []
        for j in range(inside.shape[0]):
            r = r0 + j
            run_c, run_lv = None, None
            for i in range(inside.shape[1]):
                c = c0 + i
                lv = surface_level(c, r, band) if inside[j, i] else None
                if lv is not None and run_c is not None and lv == run_lv and c == out_end + 1:
                    out_end = c
                    continue
                if run_c is not None:
                    out.append([r, run_lv, run_c, out_end])
                    run_c = None
                if lv is not None:
                    run_c, run_lv, out_end = c, lv, c
            if run_c is not None:
                out.append([r, run_lv, run_c, out_end])
        return out

    monsters: dict[str, list] = {}
    for z in json.load(open(spath)).get("zones", []):
        mid = z.get("monster")
        if not mid or not z.get("area"):
            continue
        spans = spans_of(z["area"], z.get("elev"))
        if not spans:
            print(f"    note: {mid}/{z.get('id')} has no cell inside its elev band — skipped")
            continue
        monsters.setdefault(mid, []).append({
            "id": z.get("id", ""),
            "num": int(z.get("num") or 0),
            "spans": spans,
        })

    # VALIDATION: a zone's cells must land on DRAWN (opaque) minimap pixels —
    # a projection slip would drop them in the transparent sea.
    def project(c: float, r: float, lv: int) -> tuple[float, float]:
        return (s * (ox + (c - r) * DX + TILE / 2) + offx,
                s * (oy + (c + r) * DY - lv * LEVEL_PX + DY) + offy)
    checked = hit = 0
    for zones in monsters.values():
        for z in zones:
            for r, lv, ca, cb in z["spans"][::7]:          # sample, don't grind
                px, py = project((ca + cb) / 2 + 0.5, r + 0.5, lv)
                checked += 1
                x, y = int(px), int(py)
                if 0 <= x < img.width and 0 <= y < img.height and alpha[y, x] > 0:
                    hit += 1
    ratio = hit / max(1, checked)
    total = sum(len(v) for v in monsters.values())
    cells = sum(cb - ca + 1 for v in monsters.values() for z in v for _, _, ca, cb in z["spans"])
    print(f"  {name}: scale {s:.5f} offset ({offx:.1f},{offy:.1f}) · {len(monsters)} monsters / "
          f"{total} zones / {cells} cells · {ratio * 100:.1f}% of sampled cells on drawn map")
    if ratio < 0.9:
        print("  refusing to write: zone cells do not land on the drawn map")
        return None
    return {
        "world": name,
        "minimap": f"maps2/worlds/{name}/minimap.png",
        "mapW": img.width, "mapH": img.height,
        "cells": {"w": W, "h": H},
        # Cell → minimap px, applied client-side (an AFFINE map, so it can
        # never distort a shape): px = s·(ox + (c−r)·dx + tile/2) + offx …
        "proj": {"ox": ox, "oy": oy, "dx": DX, "dy": DY, "levelPx": LEVEL_PX,
                 "tile": TILE, "s": round(s, 6), "offx": round(offx, 2), "offy": round(offy, 2)},
        "monsters": monsters,
    }


world = sys.argv[1] if len(sys.argv) > 1 else default_world()
data = build(world)
if not data:
    sys.exit(1)
out = {
    "format": "pixel-wiki-world-map@1",
    "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "source": "maps2 world.json + spawns.json + minimap.png, projected per render2.py",
    **data,
}
dst = os.path.join(ROOT, "wiki", "world_map.json")
with open(dst, "w") as f:
    json.dump(out, f, separators=(",", ":"))
    f.write("\n")
print(f"wrote {dst} ({os.path.getsize(dst) // 1024} KB)")
