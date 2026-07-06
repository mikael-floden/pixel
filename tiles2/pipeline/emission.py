"""Build tiles2/emission.json — the night-glow metadata games2 consumes.

game2 keeps a night shader + glow field + lit-tile runtime, but it was keyed to
v1's `tiles/emission.json`, whose category names don't match tiles2 materials, so
nothing lit up. tiles2 owns the art and the pipeline that knows which tiles emit,
so we own the emission data too.

Two blocks (schema `tiles2-emission@1`):

  * materials — one CURATED entry per material (color/self/strength/radius/anim),
    `null` when the material never emits. Drives the self-glow floor + the soft
    light pool spilled onto neighbours. Hand-authored below (MATERIALS).
  * sources   — per-TILE glowing pixel clusters, keyed by the tile's repo-relative
    PATH (== a world.json paths[] entry). AUTO-EXTRACTED here: each emissive
    material's base/ + base_x_N tiles are scanned for pixel clusters that outshine
    their LOCAL surroundings (a crystal core above the ice, lava above the rock, a
    mushroom cap above the grass), plus a "molten" rule where the whole surface is
    the light. Regenerate whenever the emissive art changes.

Field units are games2's (see coordination): color/`s` linear RGB 0..1; self,
strength, s in 0..1; radius in cells; anim static|pulse|flicker; source x,y,r in
the tile PNG's own pixel space (top-left origin; base 64x64, base_x_N 64x128);
dir up|sw|se = top-diamond/object vs left/right face (geometry diamond_h=30,
faces below, split at x=32).

  python tiles2/pipeline/emission.py            # write tiles2/emission.json
  python tiles2/pipeline/emission.py --dry-run  # summarise, don't write
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re

import numpy as np
from PIL import Image

import common

OUT_PATH = os.path.join(common.ROOT, "emission.json")
DIAMOND_H = 30                      # games2 geometry: top diamond height, faces below

# Which SHEETS to even look at: the art's own object descriptions are the emitter
# inventory (games2's point). Only tiles from a sheet whose objects mention a glow
# source are scanned — so a flat ground sheet never sprouts a halo, and a "driftwood
# + lantern" sheet is scanned but only the lantern's bright pixels survive the gate.
GLOW_RE = re.compile(
    r"glow|radiant|lumin|lava|ember|molten|magma|torch|lantern|lamp|firefl|"
    r"crystal|geode|glint|beacon|shining|luminescen", re.I)

# -- P0: curated per-material glow. null = never emits (keeps games2's load gate
#    green — every world material must resolve here). Colors are linear RGB. ------
MATERIALS = {
    "crystal_ice":     {"color": [0.50, 0.70, 0.95], "self": 0.55, "strength": 0.35, "radius": 2, "anim": "pulse"},
    "black_mountain":  {"color": [1.00, 0.45, 0.15], "self": 0.60, "strength": 0.55, "radius": 2, "anim": "flicker"},
    "saturated_grass": {"color": [0.40, 0.75, 0.95], "self": 0.50, "strength": 0.30, "radius": 2, "anim": "pulse"},
    "clear_water":     {"color": [1.00, 0.80, 0.45], "self": 0.45, "strength": 0.35, "radius": 2, "anim": "flicker"},
    "light_sand":      {"color": [1.00, 0.60, 0.25], "self": 0.50, "strength": 0.40, "radius": 2, "anim": "flicker"},
    "stone_mountain":  {"color": [0.60, 0.75, 0.95], "self": 0.40, "strength": 0.25, "radius": 2, "anim": "pulse"},
    "regular_snow":    None,
    "lightdark_dirt":  None,
}

# -- P1: per-material pixel-detection params for the `sources` extraction. --------
# abs_min : a glow pixel must be at least this bright (sRGB luminance 0..255).
# resid   : ...and this much brighter than its LOCAL neighbourhood (unsharp
#           residual) — this is what isolates a crystal from the surrounding bright
#           ice, or lava from rock, regardless of the tile's overall brightness.
# hue     : None | "warm" (orange/red embers, lava, torches, lanterns) |
#           "cool" (blue/teal crystals, glowing mushrooms) — filters false hits.
# sat_min : minimum saturation (0..1) for the hue gate (skips e.g. pale sand).
# molten  : if this fraction of the opaque tile qualifies, the whole surface is one
#           source (lava fields / geodes filling the tile).
DETECT = {
    "crystal_ice":     {"abs_min": 214, "resid": 30, "hue": None,   "sat_min": 0.0,  "molten": 0.45, "min_area": 6, "max_src": 3},
    "black_mountain":  {"abs_min": 90,  "resid": 16, "hue": "warm", "sat_min": 0.30, "molten": 0.40, "min_area": 4, "max_src": 3},
    "saturated_grass": {"abs_min": 150, "resid": 22, "hue": "cool", "sat_min": 0.22, "molten": 0.35, "min_area": 4, "max_src": 3},
    "clear_water":     {"abs_min": 185, "resid": 30, "hue": "warm", "sat_min": 0.35, "molten": 0.30, "min_area": 4, "max_src": 2},
    "light_sand":      {"abs_min": 185, "resid": 26, "hue": "warm", "sat_min": 0.40, "molten": 0.30, "min_area": 4, "max_src": 2},
    "stone_mountain":  {"abs_min": 150, "resid": 24, "hue": "cool", "sat_min": 0.18, "molten": 0.30, "min_area": 4, "max_src": 2},
}


def _srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float32) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _lum(rgb):
    return 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]


def _box_blur(a, mask, radius=6):
    """Mask-aware box blur (mean of opaque neighbours), a few passes ~ gaussian.
    Transparent pixels don't dilute the local mean at silhouette edges."""
    a = a.astype(np.float32) * mask
    w = mask.astype(np.float32)
    k = 2 * radius + 1
    for _ in range(2):
        a = _sep_mean(a, k)
        w = _sep_mean(w, k)
    return np.where(w > 1e-3, a / np.maximum(w, 1e-3), 0.0)


def _sep_mean(a, k):
    pad = k // 2
    c = np.cumsum(np.pad(a, ((pad + 1, pad), (0, 0)), mode="edge"), axis=0)
    a = (c[k:, :] - c[:-k, :]) / k
    c = np.cumsum(np.pad(a, ((0, 0), (pad + 1, pad)), mode="edge"), axis=1)
    return (c[:, k:] - c[:, :-k]) / k


def _hue_ok(rgb, kind, sat_min):
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    if kind is None:
        return np.ones(r.shape, bool)
    if kind == "warm":                       # embers/lava/torches: strong red/orange,
        # g>=b drops pink/magenta blooms (which have b>g); r-b gap keeps it molten
        return (sat >= sat_min) & (r >= g) & (g >= b) & (r - g > 22) & (r - b > 55)
    # cool: BLUE/TEAL glow only. b must lead red, AND green must be present (g not far
    # below r) — that keeps cyan/teal mushroom caps but drops magenta/purple FLOWERS
    # (lavender, wisteria, lilies), whose red rivals their blue with little green.
    return (sat >= sat_min) & (b - r > 20) & (g - r > -10)


def _components(mask, min_area):
    """Connected components (8-connectivity) via stack flood-fill. Small tiles."""
    lab = np.zeros(mask.shape, np.int32)
    comps, cur = [], 0
    ys, xs = np.nonzero(mask)
    seen = set(zip(ys.tolist(), xs.tolist()))
    H, W = mask.shape
    for sy, sx in list(seen):
        if lab[sy, sx]:
            continue
        cur += 1
        stack, pts = [(sy, sx)], []
        lab[sy, sx] = cur
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = cur
                        stack.append((ny, nx))
        if len(pts) >= min_area:
            comps.append(pts)
    return comps


def _dir_of(x, y, h):
    """up = top diamond / object art above the block; sw/se = left/right face.
    Our elevation objects rise on a flat (depth-0) patch, so most glow is 'up';
    only clusters in the bottom face band split by x=32 read as a face."""
    face_top = h - DIAMOND_H if h > 80 else DIAMOND_H + 4   # tall: faces are the bottom band
    if y < face_top:
        return "up"
    return "sw" if x < 32 else "se"


def _cluster_source(pts, rgb, lum, h):
    ys = np.array([p[0] for p in pts]); xs = np.array([p[1] for p in pts])
    cy, cx = float(ys.mean()), float(xs.mean())
    r = float(max(2.0, np.sqrt(len(pts) / np.pi)))
    lin = _srgb_to_linear(rgb[ys, xs])                 # per-pixel linear, mean
    col = [round(float(c), 3) for c in lin.mean(0)]
    s = round(float(np.clip(lum[ys, xs].mean() / 255.0, 0, 1)), 3)
    return {"x": round(cx, 1), "y": round(cy, 1), "r": round(r, 1),
            "color": col, "s": s, "dir": _dir_of(cx, cy, h)}


def extract_image(im, det):
    """Glow-source clusters for a single RGBA tile image (see extract_tile)."""
    a = np.asarray(im.convert("RGBA")).astype(np.float32)
    rgb, al = a[:, :, :3], a[:, :, 3]
    op = al > 16
    if not op.any():
        return []
    h = a.shape[0]
    lum = _lum(rgb)
    resid = lum - _box_blur(lum, op, radius=6)
    glow = op & (lum >= det["abs_min"]) & (resid >= det["resid"]) & _hue_ok(rgb, det["hue"], det["sat_min"])
    if not glow.any():
        return []
    frac = glow.sum() / max(op.sum(), 1)
    if frac >= det["molten"]:                          # whole surface is the light
        pts = list(zip(*np.nonzero(op)))
        return [_cluster_source(pts, rgb, lum, h)]
    comps = _components(glow, det["min_area"])
    comps.sort(key=len, reverse=True)
    return [_cluster_source(c, rgb, lum, h) for c in comps[:det["max_src"]]]


def extract_tile(path, det):
    return extract_image(Image.open(path).convert("RGBA"), det)


def tile_emission(gid, im, objects):
    """Per-tile emission RECORD for a tile whose material may emit — or None.
    Gated exactly like the emission.json sources: the material must emit and the
    tile's SHEET objects must name a glow source (so a plain ground tile in a glow
    sheet still only emits if its own pixels glow). Returns
    {material, color, anim, sources:[...]} suitable to drop into tile metadata."""
    mat = MATERIALS.get(gid)
    det = DETECT.get(gid)
    if not mat or not det or not GLOW_RE.search(" ".join(objects or [])):
        return None
    srcs = extract_image(im, det)
    if not srcs:
        return None
    return {"material": gid, "color": mat["color"], "anim": mat["anim"], "sources": srcs}


def tile_paths(gid):
    """Served tiles worth scanning: base/ + base_x_N tiles that belong to a sheet
    whose `objects` inventory names a glow source. Ground-only sheets (no glow
    objects) are skipped — they rely on the material self-glow floor, not halos."""
    out = []
    for sub in ("base", "base_x_2", "base_x_3", "base_x_4", "base_x_5"):
        for md in sorted(glob.glob(os.path.join(common.type_dir(gid), sub, "*", "metadata.json"))):
            meta = json.load(open(md))
            objs = " ".join(meta.get("objects") or [])
            if not GLOW_RE.search(objs):
                continue
            out += sorted(glob.glob(os.path.join(os.path.dirname(md), "tile_*.png")))
    return out


def build(dry_run=False):
    sources = {}
    per_mat = {}
    for gid, mat in MATERIALS.items():
        if mat is None or gid not in DETECT:
            continue
        det = DETECT[gid]
        n_tiles = n_src = 0
        for p in tile_paths(gid):
            srcs = extract_tile(p, det)
            if srcs:
                rel = os.path.relpath(p, common.ROOT)
                rel = os.path.join("tiles2", rel) if not rel.startswith("tiles2") else rel
                sources[rel] = srcs
                n_tiles += 1
                n_src += len(srcs)
        per_mat[gid] = (n_tiles, n_src)
    doc = {
        "schema": "tiles2-emission@1",
        "_note": ("Owned by tiles2. materials = curated per-material glow (null = "
                  "non-emitter); sources = auto-extracted per-tile glow clusters "
                  "(local-contrast scan of base/ + base_x_N). Regenerated by "
                  "tiles2/pipeline/emission.py when emissive art changes."),
        "materials": MATERIALS,
        "sources": dict(sorted(sources.items())),
    }
    emit = sum(1 for v in MATERIALS.values() if v)
    print(f"materials: {len(MATERIALS)} ({emit} emit, {len(MATERIALS) - emit} null)")
    for gid, (nt, ns) in sorted(per_mat.items()):
        print(f"  {gid:16s} {nt:3d} glowing tiles, {ns:3d} source clusters")
    print(f"sources: {len(sources)} tiles total")
    if not dry_run:
        with open(OUT_PATH, "w") as f:
            json.dump(doc, f, indent=2)
        print(f"wrote {os.path.relpath(OUT_PATH, common.ROOT)}")
    return doc


def main():
    ap = argparse.ArgumentParser(description="Build tiles2/emission.json for games2 night-glow.")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    build(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
