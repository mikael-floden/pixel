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

    def corner(c: int, r: int) -> list[float]:
        """A spawns@1 vertex is a TILE CORNER: horizontally centred in the
        tile, at the top vertex of its diamond (the same rule the game's
        projectZoneCorner uses — NOT the body-anchor projection)."""
        lv = int(level[min(max(r, 0), H - 1)][min(max(c, 0), W - 1)])
        fx = ox + (c - r) * DX + TILE / 2
        fy = oy + (c + r) * DY - lv * LEVEL_PX
        return [round(s * fx + offx, 1), round(s * fy + offy, 1)]

    monsters: dict[str, list] = {}
    for z in json.load(open(spath)).get("zones", []):
        mid = z.get("monster")
        if not mid or not z.get("area"):
            continue
        monsters.setdefault(mid, []).append({
            "id": z.get("id", ""),
            "num": int(z.get("num") or 0),
            "poly": [corner(int(c), int(r)) for c, r in z["area"]],
        })

    # VALIDATION: every zone's centroid must land on drawn (opaque) map.
    bad = 0
    for zones in monsters.values():
        for z in zones:
            px = int(np.mean([p[0] for p in z["poly"]]))
            py = int(np.mean([p[1] for p in z["poly"]]))
            if not (0 <= px < img.width and 0 <= py < img.height and alpha[py, px] > 0):
                bad += 1
    total = sum(len(v) for v in monsters.values())
    print(f"  {name}: scale {s:.5f} offset ({offx:.1f},{offy:.1f}) · "
          f"{len(monsters)} monsters / {total} zones · {bad} centroid(s) off-map")
    if bad > total * 0.15:
        print("  refusing to write: too many zones project off the drawn map")
        return None
    return {
        "world": name,
        "minimap": f"maps2/worlds/{name}/minimap.png",
        "mapW": img.width, "mapH": img.height,
        "cells": {"w": W, "h": H},
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
