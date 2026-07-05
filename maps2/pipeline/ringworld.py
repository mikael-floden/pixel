"""Generate the donut/ring TEST map to evaluate tiles2 transitions.

Layout (per the brief):
  - clear_water disk in the CENTRE (the donut hole); spawn is here.
  - a ring of land around it, split into 5 equal PIZZA SLICES, one base type
    each: saturated_grass, lightdark_dirt, stone_mountain, black_mountain,
    regular_snow (ordered as a colour progression green->brown->grey->black->
    white so adjacent borders are maximally informative).
  - ELEVATION rises from the centre outward: a flat coastal ring at the water,
    then concentric terraces climbing to the outer rim.

The point of the map is to SEE the transition tiles working at three kinds of
border: water<->each slice (the inner shore, all around), slice<->slice (the
five radial seams), and each material as a terraced CLIFF (within a slice).

Transition placement = a ONE-SIDED FEATHER. Of any two touching materials, the
lower-`PRIORITY` one hosts the blend and feathers into the higher one over a few
cells; the higher one stays pure up to the seam. That is inherently seam-safe
(no Wang-edge matching needed) and reads like natural ground. For each host
cell we pick the transition tile whose measured composition matches how deep in
the feather it sits and whose measured orientation faces the neighbour.
"""

from __future__ import annotations

import json
import math
import os

import numpy as np

from tiles2lib import DX, DY, Tiles2

# slice order around the ring (green -> brown -> grey -> black -> white)
SLICES = ["saturated_grass", "lightdark_dirt", "stone_mountain",
          "black_mountain", "regular_snow"]
WATER = "clear_water"

# lower priority hosts the feather and blends INTO the higher-priority material
PRIORITY = {"saturated_grass": 0, "lightdark_dirt": 1, "regular_snow": 2,
            "stone_mountain": 3, "black_mountain": 4, "clear_water": 5}


class RingWorld:
    def __init__(self, n: int, seed: int):
        self.n = n
        self.seed = seed
        self.mat = np.full((n, n), "", object)      # material id per cell ("" = void)
        self.level = np.zeros((n, n), np.int16)
        self.top = np.full((n, n), None, object)     # top-surface tile path
        self.paths: list[str] = []
        self.path_idx: dict[str, int] = {}
        self.spawn = (n // 2, n // 2)
        self.meta: dict = {}


def _hash01(x, y, seed):
    h = (x * 374761393 + y * 668265263 + seed * 362437) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


def generate(n: int = 160, seed: int = 7, lib: Tiles2 | None = None) -> RingWorld:
    lib = lib or Tiles2()
    W = RingWorld(n, seed)
    cx = cy = n / 2.0

    r_water = n * 0.115          # water disk radius
    r_flat = r_water + 5         # flat coastal ring end
    r_out = n * 0.455            # outer rim
    MAXLEVEL = 7
    band = 3.5                   # feather half-width, cells
    edge_noise_amp = 2.2

    Y, X = np.mgrid[0:n, 0:n].astype(np.float64)
    dx = X - cx
    dy = Y - cy
    r = np.hypot(dx, dy)
    theta = (np.arctan2(dy, dx) + 2 * math.pi) % (2 * math.pi)

    # wobble the coast and radial seams a little so they aren't geometric-perfect
    def noise(sx, sy, s):
        ix, iy = np.floor(sx).astype(int), np.floor(sy).astype(int)
        fx, fy = sx - ix, sy - iy
        def h(a, b):
            hh = (a * 374761393 + b * 668265263 + s * 362437) & 0xFFFFFFFF
            hh = ((hh ^ (hh >> 13)) * 1274126177) & 0xFFFFFFFF
            return ((hh ^ (hh >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF
        ux, uy = fx*fx*(3-2*fx), fy*fy*(3-2*fy)
        v00, v10 = h(ix, iy), h(ix+1, iy)
        v01, v11 = h(ix, iy+1), h(ix+1, iy+1)
        a = v00 + (v10-v00)*ux
        b = v01 + (v11-v01)*ux
        return a + (b-a)*uy
    rn = (noise(X/9, Y/9, seed) - 0.5) * edge_noise_amp
    an = (noise(X/11, Y/11, seed+5) - 0.5) * 0.12   # radians of seam wobble

    r_eff = r + rn
    theta_eff = (theta + an) % (2 * math.pi)

    # --- hard material regions --------------------------------------------------
    land = r_eff < r_out
    water = r_eff < r_water
    seg = np.floor(theta_eff / (2 * math.pi) * len(SLICES)).astype(int) % len(SLICES)
    mat = np.full((n, n), "", object)
    for i, gid in enumerate(SLICES):
        mat[land & ~water & (seg == i)] = gid
    mat[water] = WATER
    W.mat = mat

    # --- elevation: flat coast, then concentric terraces --------------------------
    lvl_cont = np.clip((r_eff - r_flat) / (r_out - r_flat), 0, 1) * MAXLEVEL
    level = np.rint(lvl_cont).astype(np.int16)
    level[water] = 0
    level[~land] = 0
    W.level = level

    # --- feather assignment ----------------------------------------------------
    prio = np.vectorize(lambda m: PRIORITY.get(m, -1))(mat)
    B = int(math.ceil(band)) + 1

    def add_path(p):
        i = W.path_idx.get(p)
        if i is None:
            i = len(W.paths)
            W.paths.append(p)
            W.path_idx[p] = i
        return i

    # cache candidate arrays per pair for fast scoring
    cand_cache: dict = {}

    def candidates(m, other):
        key = (m, other)
        if key not in cand_cache:
            tiles, m_first = lib.transition(m, other)
            comp = np.array([t["compA"] if m_first else 1 - t["compA"] for t in tiles])
            grad = np.array([t["grad"] if m_first else [-t["grad"][0], -t["grad"][1]]
                             for t in tiles], float)
            files = [t["file"] for t in tiles]
            cand_cache[key] = (comp, grad, files)
        return cand_cache[key]

    top = np.full((n, n), None, object)
    ny, nx = np.where(mat != "")
    for y, x in zip(ny.tolist(), nx.tolist()):
        m = mat[y, x]
        if m == "":
            continue
        pm = PRIORITY[m]
        # find nearest cell of a HIGHER-priority material within band
        best_d, best_n, best_dir = 1e9, None, None
        for j in range(-B, B + 1):
            yy = y + j
            if yy < 0 or yy >= n:
                continue
            for i in range(-B, B + 1):
                xx = x + i
                if xx < 0 or xx >= n:
                    continue
                mo = mat[yy, xx]
                if mo == "" or PRIORITY.get(mo, -1) <= pm:
                    continue
                d = math.hypot(i, j)
                if d < best_d:
                    best_d, best_n = d, mo
                    best_dir = (i, j)
        if best_n is not None and best_d <= band + 0.5:
            # desired: deep in host (d~band) -> mostly host; near seam (d~1) -> mostly other
            f = (best_d - 1) / max(1e-3, band - 1)          # 0 near seam .. 1 deep
            desired_compM = float(np.clip(0.12 + 0.80 * f, 0.05, 0.95))
            di, dj = best_dir                                # world dir host->other
            sg = np.array([(di - dj) * DX, (di + dj) * DY], float)
            sgn = np.linalg.norm(sg)
            sg = sg / sgn if sgn > 1e-6 else np.array([0, -1.0])
            comp, grad, files = candidates(m, best_n)
            score = 2.0 * np.abs(comp - desired_compM) + 1.0 * (1 - grad @ sg)
            # a little deterministic jitter for variety among near-ties
            score += _hash01(x, y, seed + 3) * 0.06
            k = int(np.argmin(score))
            top[y, x] = files[k]
        else:
            # pure material: pick a base tile with per-cell variety
            bt = lib.base(m)
            top[y, x] = bt[int(_hash01(x, y, seed + 1) * len(bt)) % len(bt)]

    # intern tile paths into a compact table + per-cell index
    idx = np.full((n, n), -1, np.int32)
    for y in range(n):
        for x in range(n):
            p = top[y, x]
            if p is None:
                continue
            i = W.path_idx.get(p)
            if i is None:
                i = len(W.paths)
                W.paths.append(p)
                W.path_idx[p] = i
            idx[y, x] = i
    W.top = idx

    W.meta = {
        "n": n, "seed": seed, "spawn": [W.spawn[0], W.spawn[1]],
        "slices": SLICES, "water": WATER,
        "r_water": r_water, "r_out": r_out, "max_level": MAXLEVEL,
        "n_paths": len(W.paths),
    }
    return W


def save(W: RingWorld, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # base material per cell as small int for the minimap/debug
    matids = {"": 0, WATER: 1}
    for i, s in enumerate(SLICES):
        matids[s] = i + 2
    matarr = np.vectorize(lambda m: matids[m])(W.mat).astype(np.uint8)
    d = {
        "schema": "pixel-maps2/ringworld@1",
        "meta": W.meta,
        "matids": matids,
        "paths": [os.path.relpath(p, REPO) for p in W.paths],
        "top": [row.tolist() for row in W.top],
        "level": [row.tolist() for row in W.level],
        "mat": [row.tolist() for row in matarr],
    }
    with open(path, "w") as f:
        json.dump(d, f, separators=(",", ":"))


REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


if __name__ == "__main__":
    import time
    t0 = time.time()
    w = generate(120, seed=7)
    print(f"generated {w.n}x{w.n} in {time.time()-t0:.1f}s; paths={len(w.paths)}")
    from collections import Counter
    print("materials:", Counter(w.mat.ravel().tolist()))
