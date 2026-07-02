"""Tile census: measure every tile in every tilesheet, one by one.

For each tile we compute:
  - avg   : mean RGB of all opaque pixels (hex) — overall palette weight
  - top   : mean RGB of the top diamond face (hex) — the color you actually see
            from the map camera; THE number that decides palette harmony
  - detail: 0..1 busyness score (edge energy) — separates calm fillers from
            loud accent tiles
  - arms  : for road pieces, which diamond edges the road mass touches
            (N/E/S/W) → auto-classified as straight / turn / tee / cross

The visual layer (climate, rank, comment) is authored by the maps agent on top
of these measurements in maps/config/tile_census.json. Contact sheets for the
eye pass are written by `make_sheets`.
"""

from __future__ import annotations

import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS_DIR = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS_DIR)
TILES = os.path.join(REPO, "tiles")


def _hex(rgb) -> str:
    return "#{:02x}{:02x}{:02x}".format(*(int(round(c)) for c in rgb))


def measure_tile(path: str) -> dict:
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.int32)
    alpha = a[:, :, 3] > 40
    if not alpha.any():
        return {"avg": "#000000", "top": "#000000", "detail": 0.0}
    rgb = a[:, :, :3]
    avg = rgb[alpha].mean(axis=0)

    rows = np.where(alpha.any(axis=1))[0]
    y0 = int(rows.min())
    top_band = np.zeros_like(alpha)
    top_band[y0:y0 + 27, :] = True          # the top diamond (~26px tall)
    tsel = alpha & top_band
    top = rgb[tsel].mean(axis=0) if tsel.any() else avg

    # busyness: mean gradient magnitude of luminance over the top face
    lum = (0.3 * rgb[:, :, 0] + 0.6 * rgb[:, :, 1] + 0.1 * rgb[:, :, 2])
    gy, gx = np.gradient(lum)
    g = np.hypot(gx, gy)
    detail = float(np.clip(g[tsel].mean() / 40.0, 0, 1)) if tsel.any() else 0.0

    return {"avg": _hex(avg), "top": _hex(top), "detail": round(detail, 3)}


def road_arms(path: str) -> str:
    """Which diamond-edge midpoints does the road surface reach?

    Estimate the background terrain color from the four in-diamond corner
    pockets, then test the four edge midpoints for a clearly different surface.
    Returns a string like "NE+SW" (iso-diagonal straight), "N+E" (turn), etc.
    Edge names: N = top-right edge, E = bottom-right, S = bottom-left, W =
    top-left (matching grid +x = NE screen direction used by the renderer).
    """
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.int32)
    alpha = a[:, :, 3] > 40
    rows = np.where(alpha.any(axis=1))[0]
    if len(rows) == 0:
        return ""
    y0 = int(rows.min())
    rgb = a[:, :, :3]

    def patch(cx, cy, r=4):
        xs = slice(max(0, cx - r), min(64, cx + r))
        ys = slice(max(0, cy - r), min(64, cy + r))
        sel = alpha[ys, xs]
        if not sel.any():
            return None
        return rgb[ys, xs][sel].reshape(-1, 3).mean(axis=0)

    dc = y0 + 13                     # diamond vertical center at the corners
    # corner pockets (inside the diamond, near its L/R/T/B corners)
    corners = [patch(8, dc), patch(56, dc), patch(32, y0 + 4), patch(32, y0 + 22)]
    corners = [c for c in corners if c is not None]
    if not corners:
        return ""
    ground = np.median(np.stack(corners), axis=0)

    # edge midpoints: halfway along each diamond edge
    mids = {
        "N": patch(48, y0 + 6),   # top-right edge  -> neighbour (x, y-1)
        "E": patch(48, y0 + 20),  # bottom-right    -> neighbour (x+1, y)
        "S": patch(16, y0 + 20),  # bottom-left     -> neighbour (x, y+1)
        "W": patch(16, y0 + 6),   # top-left        -> neighbour (x-1, y)
    }
    arms = []
    for k, v in mids.items():
        if v is None:
            continue
        if np.abs(v - ground).sum() > 60:      # clearly a different surface
            arms.append(k)
    return "+".join(arms)


ROAD_CLASS = {
    0: "plain", 1: "stub", 2: None, 3: "tee", 4: "cross",
}


def classify_road(arms: str) -> str:
    parts = [p for p in arms.split("+") if p]
    n = len(parts)
    if n == 2:
        return "straight" if set(parts) in ({"N", "S"}, {"E", "W"}) else "turn"
    return ROAD_CLASS.get(n, "plain") or "plain"


def compute_all() -> dict:
    """Measure every tile of every category. Returns {category: {meta, tiles}}."""
    out = {}
    for name in sorted(os.listdir(TILES)):
        man = os.path.join(TILES, name, "tiles.json")
        if not os.path.isfile(man):
            continue
        d = json.load(open(man))
        if d.get("schema") != "pixel-tiles/set@1":
            continue
        is_road = d.get("kind") == "road" or name.startswith("road_")
        tiles = []
        for t in d.get("tiles", []):
            p = os.path.join(TILES, name, t["file"])
            if not os.path.isfile(p):
                continue
            m = measure_tile(p)
            m["index"] = t["index"]
            if is_road:
                arms = road_arms(p)
                m["arms"] = arms
                m["piece"] = classify_road(arms)
            tiles.append(m)
        out[name] = {
            "kind": "road" if is_road else d.get("kind", "ground"),
            "tile_height": d.get("tile_height") or 64,
            "count": len(tiles),
            "description": d.get("description", ""),
            "tiles": tiles,
        }
    return out


# ---------------------------------------------------------------------------
# contact sheets for the eye pass
# ---------------------------------------------------------------------------


def _font(size=11):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",):
        if os.path.isfile(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def make_sheets(outdir: str, per_sheet: int = 8) -> list[str]:
    """One row per category (label + all its tiles with indices), grouped into
    sheets. Road categories get merged rows per style (samples of each kind)."""
    os.makedirs(outdir, exist_ok=True)
    cats = []
    for name in sorted(os.listdir(TILES)):
        man = os.path.join(TILES, name, "tiles.json")
        if not os.path.isfile(man):
            continue
        d = json.load(open(man))
        if d.get("schema") != "pixel-tiles/set@1":
            continue
        cats.append((name, d.get("tile_height") or 64, len(d.get("tiles", []))))

    ground = [(n, h, c) for n, h, c in cats if not n.startswith("road_")]
    road = [(n, h, c) for n, h, c in cats if n.startswith("road_")]

    font = _font()
    paths = []

    def sheet(rows, fname, tile_cap=16):
        pad, label_h = 4, 14
        row_hs = [h + label_h + pad for _, h, _ in rows]
        W = tile_cap * 66 + 8
        H = sum(row_hs) + pad
        img = Image.new("RGB", (W, H), (18, 22, 32))
        dr = ImageDraw.Draw(img)
        y = pad
        for name, h, cnt in rows:
            dr.text((4, y), f"{name}  (n={cnt})", font=font, fill=(240, 240, 250))
            y += label_h
            for i in range(min(cnt, tile_cap)):
                p = os.path.join(TILES, name, f"tile_{i:02d}.png")
                if not os.path.isfile(p):
                    continue
                t = Image.open(p).convert("RGBA")
                x = 4 + i * 66
                img.paste(t, (x, y), t)
                dr.text((x + 24, y + h - 12), f"{i}", font=font, fill=(255, 220, 90))
            y += h + pad
        img.save(fname)
        paths.append(fname)

    # ground sheets
    for si in range(0, len(ground), per_sheet):
        sheet(ground[si:si + per_sheet], os.path.join(outdir, f"sheet_{si//per_sheet:02d}.png"))

    # road sheets: one row per style with 5 samples of each kind
    styles = {}
    for n, h, c in road:
        style = n.rsplit("_", 1)[0]
        styles.setdefault(style, []).append((n, c))
    rows = []
    for style, members in sorted(styles.items()):
        rows.append((style, members))
    ri = 0
    while ri < len(rows):
        chunk = rows[ri:ri + 6]
        pad, label_h, W = 4, 14, 16 * 66 + 8
        H = len(chunk) * (64 + label_h + pad) + pad
        img = Image.new("RGB", (W, H), (18, 22, 32))
        dr = ImageDraw.Draw(img)
        y = pad
        for style, members in chunk:
            dr.text((4, y), style, font=font, fill=(240, 240, 250))
            y += label_h
            x = 4
            for n, cnt in sorted(members):
                kind = n.rsplit("_", 1)[1][:1].upper()   # S/T/J
                for i in range(0, min(cnt, 10), 2):      # 5 samples each
                    p = os.path.join(TILES, n, f"tile_{i:02d}.png")
                    if not os.path.isfile(p):
                        continue
                    t = Image.open(p).convert("RGBA")
                    img.paste(t, (x, y), t)
                    dr.text((x + 20, y + 52), f"{kind}{i}", font=font, fill=(255, 220, 90))
                    x += 66
            y += 64 + pad
        f = os.path.join(outdir, f"sheet_roads_{ri//6:02d}.png")
        img.save(f)
        paths.append(f)
        ri += 6
    return paths


if __name__ == "__main__":
    import sys
    if "--sheets" in sys.argv:
        out = make_sheets("/tmp/claude-0/-home-user/091b8a18-3973-5464-9ac6-a09a04d62e3f/scratchpad/census")
        print("\n".join(out))
    else:
        data = compute_all()
        n = sum(c["count"] for c in data.values())
        print(f"{len(data)} categories, {n} tiles measured")
        with open(os.path.join(MAPS_DIR, "config", "tile_measurements.json"), "w") as f:
            json.dump(data, f, indent=0)
        print("wrote maps/config/tile_measurements.json")
