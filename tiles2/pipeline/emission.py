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

import numpy as np
from PIL import Image

import common
import postprocess          # per-material colour target (to subtract the ground's own hue)

OUT_PATH = os.path.join(common.ROOT, "emission.json")
DIAMOND_H = 30                      # games2 geometry: top diamond height, faces below

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

# -- P1: hue-AGNOSTIC glow detection. A glow is a saturated, colourful accent that
#    stands out locally and ISN'T the tile's own material — lamps, fire, lava, gold
#    veins, blue/green runes, multicolour gems, mushrooms all qualify, regardless of
#    hue or of what the object description happens to say. Per material we only vary:
#    abs_min : brightness floor (low for near-black volcanic rock, high for bright ice)
#    molten  : fraction of the tile that, if glowing, means the whole surface is light
#    max_src : cap on separate halos per tile
# The shared gate (RESID/SAT_MIN) plus subtracting a SATURATED ground's own pale hue
# (grass green, water blue — never a pale ground like sand) does the discrimination.
RESID_MIN = 16          # how much brighter than the local neighbourhood
SAT_MIN = 0.34          # colourfulness floor (pale ground sits below this)
HUE_BAND = 34           # ± hue window counted as "the ground's own colour"
GROUND_SAT = 0.45       # only grounds this saturated get their hue subtracted
DETECT = {
    "crystal_ice":     {"abs_min": 210, "resid": 26, "molten": 0.55, "min_area": 5, "max_src": 3, "core": True},
    "black_mountain":  {"abs_min": 78,  "molten": 0.45, "min_area": 4, "max_src": 3},
    "saturated_grass": {"abs_min": 120, "molten": 0.40, "min_area": 4, "max_src": 3},
    "clear_water":     {"abs_min": 130, "molten": 0.40, "min_area": 4, "max_src": 3},
    "light_sand":      {"abs_min": 150, "molten": 0.40, "min_area": 4, "max_src": 2},
    "stone_mountain":  {"abs_min": 120, "molten": 0.40, "min_area": 4, "max_src": 3},
}

_cfg = None
_target_cache = {}


def _material_target(gid):
    """Cached per-material colour target (hue/sat/chroma) — used to subtract a
    saturated ground's own colour so foliage/water aren't mistaken for glow."""
    global _cfg
    if gid not in _target_cache:
        if _cfg is None:
            _cfg = common.load_config()
        _target_cache[gid] = postprocess.type_target(gid, _cfg, {})
    return _target_cache[gid]


def glow_mask(rgb, op, lum, hsv, gid, target):
    """Boolean mask of glowing pixels for tile material `gid` (see DETECT)."""
    det = DETECT[gid]
    resid = lum - _box_blur(lum, op, radius=6)
    if det.get("core"):                              # crystal_ice: bright near-white cores
        return op & (lum >= det["abs_min"]) & (resid >= det["resid"])
    sat = hsv[:, :, 1] / 255.0
    m = op & (lum >= det["abs_min"]) & (resid >= RESID_MIN) & (sat >= SAT_MIN)
    if target and target.get("chroma", 0) > 55 and target["sat"] / 255.0 > GROUND_SAT:
        # saturated ground (grass green, water blue): drop its own PALE hue, but keep
        # vividly-saturated same-hue accents (a bright flame, a glowing crystal)
        dh = np.abs(((hsv[:, :, 0] - target["hue"] + 128) % 256) - 128)
        m = m & ~((dh <= HUE_BAND) & (sat < target["sat"] / 255.0 + 0.12))
    return m


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


def extract_image(im, gid, target=None):
    """Glow-source clusters for a single RGBA tile of material `gid`."""
    det = DETECT.get(gid)
    if det is None:
        return []
    if target is None:
        target = _material_target(gid)
    a = np.asarray(im.convert("RGBA")).astype(np.float32)
    rgb, al = a[:, :, :3], a[:, :, 3]
    op = al > 16
    if not op.any():
        return []
    h = a.shape[0]
    lum = _lum(rgb)
    hsv = np.asarray(im.convert("HSV"), dtype=np.float32)
    glow = glow_mask(rgb, op, lum, hsv, gid, target)
    if not glow.any():
        return []
    frac = glow.sum() / max(op.sum(), 1)
    if frac >= det["molten"]:                          # whole surface is the light
        pts = list(zip(*np.nonzero(op)))
        return [_cluster_source(pts, rgb, lum, h)]
    comps = _components(glow, det["min_area"])
    comps.sort(key=len, reverse=True)
    return [_cluster_source(c, rgb, lum, h) for c in comps[:det["max_src"]]]


def extract_tile(path, gid, target=None):
    return extract_image(Image.open(path).convert("RGBA"), gid, target)


def tile_emission(gid, im, target=None):
    """Per-tile emission RECORD for a tile — or None if it doesn't glow. The
    material must be an emitter (in DETECT) and the tile's own pixels must contain
    a glow cluster. Returns {material, color, anim, sources:[...]} for tile metadata."""
    mat = MATERIALS.get(gid)
    if not mat or gid not in DETECT:
        return None
    srcs = extract_image(im, gid, target)
    if not srcs:
        return None
    return {"material": gid, "color": mat["color"], "anim": mat["anim"], "sources": srcs}


def tile_paths(gid):
    """All served base/ + base_x_N tiles of a material. No description keyword gate:
    the pixel detection decides, so a glowing prop is found even when the object text
    doesn't say 'glow' (watchtower braziers, lighthouses)."""
    out = []
    for sub in ("base", "base_x_2", "base_x_3", "base_x_4", "base_x_5"):
        out += sorted(glob.glob(os.path.join(common.type_dir(gid), sub, "*", "tile_*.png")))
    return out


def build(dry_run=False):
    sources = {}
    per_mat = {}
    for gid, mat in MATERIALS.items():
        if mat is None or gid not in DETECT:
            continue
        target = _material_target(gid)
        n_tiles = n_src = 0
        for p in tile_paths(gid):
            srcs = extract_tile(p, gid, target)
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
