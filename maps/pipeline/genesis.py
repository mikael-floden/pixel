"""Genesis: generate the MMORPG-scale world from the tile census + climates.

Design goals (the maintainer's brief):
  - WAY bigger world (512x448 cells — minutes to cross, not seconds)
  - ALTTP-style climate regions, each with identity, placed by hand
  - palette harmony: fillers/accents/bridges straight from climates.json;
    rank<=2 tiles are never placed
  - dramatic elevation (levels 0..12): glacier massif, mesa canyons, terraced
    farmland, a volcano island — cliffs and waterfalls do the storytelling
  - real roads with directional pieces (straight/turn/junction autotiling from
    the census's detected arms), switching material per climate
  - no object sprites — landmark verticals are tiles (towers, obelisks, trees)

Everything derives from two authored files: config/climates.json (palette law)
and the region layout below (geography). Deterministic per seed.
"""

from __future__ import annotations

import heapq
import json
import math
import os

import numpy as np

from bigworld import BigWorld

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS = os.path.dirname(_HERE)

MAX_LEVEL = 12

# ---------------------------------------------------------------------------
# vectorized value noise (numpy) — same recipe as noise.py, array-wide
# ---------------------------------------------------------------------------

_M32 = np.uint64(0xFFFFFFFF)


def _h01(ix, iy, seed: int):
    h = (ix.astype(np.uint64) * np.uint64(374761393)
         + iy.astype(np.uint64) * np.uint64(668265263)
         + np.uint64((seed * 362437) & 0xFFFFFFFF)) & _M32
    h = ((h ^ (h >> np.uint64(13))) * np.uint64(1274126177)) & _M32
    return (((h ^ (h >> np.uint64(16))) & _M32) / 0xFFFFFFFF).astype(np.float32)


def vnoise(X, Y, seed: int, scale: float):
    gx, gy = X / scale, Y / scale
    ix, iy = np.floor(gx).astype(np.int64), np.floor(gy).astype(np.int64)
    fx, fy = (gx - ix).astype(np.float32), (gy - iy).astype(np.float32)
    ux, uy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    v00, v10 = _h01(ix, iy, seed), _h01(ix + 1, iy, seed)
    v01, v11 = _h01(ix, iy + 1, seed), _h01(ix + 1, iy + 1, seed)
    a = v00 + (v10 - v00) * ux
    b = v01 + (v11 - v01) * ux
    return a + (b - a) * uy


def vfbm(X, Y, seed: int, scale: float, octaves: int = 4):
    total = np.zeros_like(X, dtype=np.float32)
    amp, norm, s = 1.0, 0.0, scale
    for o in range(octaves):
        total += amp * vnoise(X, Y, seed + o * 101, s)
        norm += amp
        amp *= 0.5
        s *= 0.5
    return total / norm


def cellhash(X, Y, seed: int):
    return _h01(X.astype(np.int64), Y.astype(np.int64), seed)


# ---------------------------------------------------------------------------
# the authored geography: regions, water, roads
# ---------------------------------------------------------------------------

# (name, climate, cx, cy, radius, elev_base, elev_amp)  — fractions of W/H
REGIONS = [
    ("Frostspire Glacier", "alpine",    0.13, 0.13, 0.17, 8.5, 2.5),
    ("Hoarwind Tundra",    "tundra",    0.09, 0.37, 0.13, 2.2, 1.0),
    ("Graywatch Spur",     "mountain",  0.22, 0.42, 0.08, 4.0, 1.5),
    ("Greyspine Range",    "mountain",  0.42, 0.11, 0.21, 6.5, 2.5),
    ("Deepdelve Mines",    "mine",      0.61, 0.14, 0.08, 5.5, 1.5),
    ("Emberfall Woods",    "autumn",    0.80, 0.15, 0.13, 3.2, 1.0),
    ("Heartmead Vale",     "meadow",    0.45, 0.44, 0.23, 1.6, 0.8),
    ("Eldergreen Forest",  "forest",    0.77, 0.43, 0.16, 2.5, 1.0),
    ("Gloomcap Hollow",    "enchanted", 0.87, 0.32, 0.06, 3.0, 0.5),
    ("Sunder Mesas",       "desert",    0.15, 0.68, 0.18, 3.0, 1.0),
    ("Goldwash Savanna",   "savanna",   0.33, 0.59, 0.12, 1.4, 0.6),
    ("Millbrook Terraces", "farmland",  0.52, 0.70, 0.14, 1.0, 0.5),
    ("Blackreed Fen",      "swamp",     0.70, 0.80, 0.12, 0.0, 0.0),
    ("Viridian Wilds",     "jungle",    0.87, 0.68, 0.11, 1.6, 0.9),
    ("Cinderholm",         "volcanic",  0.905, 0.895, 0.065, 0.0, 0.0),  # island cone
]

LAKE = (0.46, 0.46, 0.045)          # Mirrormere + shrine island
LAKE_ISLE_R = 0.011

RIVERS = [
    # the Silverrun: glacier -> mountain gorge -> vale -> lake -> terraces -> fen -> sea
    dict(pts=[(0.16, 0.16), (0.26, 0.24), (0.34, 0.33), (0.42, 0.40), (0.46, 0.46)], w=1.6),
    dict(pts=[(0.475, 0.505), (0.50, 0.58), (0.53, 0.66), (0.58, 0.74), (0.66, 0.82),
              (0.72, 0.90), (0.75, 0.97)], w=1.7),
    # the Amberflow: mine -> autumn woods -> forest -> east sea
    dict(pts=[(0.60, 0.17), (0.68, 0.24), (0.74, 0.33), (0.80, 0.42), (0.88, 0.47),
              (0.975, 0.50)], w=1.2),
]

CANYON = dict(pts=[(0.045, 0.585), (0.10, 0.63), (0.165, 0.665), (0.235, 0.715)], w=2.2)

HUB = (0.47, 0.53)                   # the crossroads of the kingdom
ROADS = [
    (HUB, (0.605, 0.165)),           # north road to the mines
    (HUB, (0.152, 0.617)),           # caravan road to the mesa oasis
    (HUB, (0.93, 0.44)),             # east road through Eldergreen
    (HUB, (0.12, 0.35)),             # west road to the tundra
    (HUB, (0.52, 0.70)),             # south road into the terraces
    ((0.52, 0.70), (0.50, 0.87)),    # ... continuing to the south coast
    ((0.52, 0.70), (0.84, 0.70)),    # fen boardwalk to the jungle edge
    ((0.605, 0.165), (0.79, 0.17)),  # mine spur into Emberfall
]

# climate -> A* ground cost (None = impassable)
ROADCOST = {
    "meadow": 1.0, "farmland": 1.0, "savanna": 1.2, "coast": 1.6, "forest": 2.0,
    "autumn": 2.0, "desert": 1.6, "mine": 1.8, "tundra": 2.4, "mountain": 4.5,
    "alpine": 7.0, "swamp": 3.2, "jungle": 3.0, "enchanted": 3.0,
    "volcanic": None, "sea": None,
}

TREES = {   # climate -> (density, [(category, variant), ...])
    "forest":    (0.34, [("oak_tree", 0), ("oak_tree", 5), ("oak_tree", 7),
                         ("pine_tree_v2", 0), ("pine_tree_v2", 8), ("pine_tree_v2", 3)]),
    "autumn":    (0.30, [("oak_tree", 1), ("oak_tree_v2", 1), ("pine_tree", 4),
                         ("oak_tree", 2)]),
    "jungle":    (0.20, [("oak_tree", 5), ("oak_tree", 7), ("oak_tree", 8)]),
    "enchanted": (0.14, [("oak_tree", 8), ("mushroom_grove", 10), ("crystal_spire", 0)]),
    "swamp":     (0.07, [("oak_tree_v2", 7), ("oak_tree", 8), ("oak_tree_v2", 2)]),
    "meadow":    (0.014, [("oak_tree_v2", 0), ("oak_tree_v2", 3), ("oak_tree_v2", 6),
                          ("oak_tree_v2", 9)]),
    "alpine":    (0.05, [("pine_tree_v2", 1), ("pine_tree_v2", 7), ("pine_tree", 1)]),
    "tundra":    (0.025, [("pine_tree_v2", 4), ("pine_tree_v2", 2)]),
    "mine":      (0.03, [("pine_tree_v2", 0)]),
    "mountain":  (0.015, [("pine_tree_v2", 2), ("big_boulder", 0)]),
}


# ---------------------------------------------------------------------------


def _load_cfg():
    climates = json.load(open(os.path.join(MAPS, "config", "climates.json")))
    census = json.load(open(os.path.join(MAPS, "config", "tile_census.json")))
    return climates, census["categories"]


def _fill_tables(climates, census):
    """Per climate: weighted (cat, variant) filler + accent lists, rank>=3 only."""
    out = {}
    for name, c in climates["climates"].items():
        def ok(cat, v):
            t = census[cat]["tiles"][v] if v < len(census[cat]["tiles"]) else None
            return t is not None and t["rank"] >= 3
        fillers = [(cat, v) for cat, vs in c["ground"].items() for v in vs if ok(cat, v)]
        acc = c.get("accent", {})
        budget = acc.get("budget", 0.1)
        accents = [(cat, v) for cat, vs in acc.items() if cat != "budget"
                   for v in vs if ok(cat, v)]
        out[name] = dict(fillers=fillers, accents=accents, budget=budget,
                         cliff=c["cliff"], road=c["road"], edge=c.get("edge"))
    return out


def _road_pieces(census):
    """style -> {frozenset(arms): [(category, index), ...]} from detected arms."""
    out = {}
    for cat, meta in census.items():
        if not cat.startswith("road_"):
            continue
        style = cat.rsplit("_", 1)[0]
        d = out.setdefault(style, {})
        for t in meta["tiles"]:
            if t["rank"] < 3:
                continue
            arms = frozenset(a for a in t.get("arms", "").split("+") if a)
            d.setdefault(arms, []).append((cat, t["index"]))
    return out


def generate(w: int = 512, h: int = 448, seed: int = 11) -> BigWorld:
    climates_cfg, census = _load_cfg()
    tables = _fill_tables(climates_cfg, census)
    roadsets = _road_pieces(census)

    W = BigWorld(w, h, seed)
    Y, X = np.mgrid[0:h, 0:w].astype(np.float32)

    # ---- land ----------------------------------------------------------------
    nx = (X / w - 0.5) * 2
    ny = (Y / h - 0.5) * 2
    d = np.sqrt((nx / 0.92) ** 2 + (ny / 0.90) ** 2)
    land_v = (1.0 - d) + (vfbm(X, Y, seed, w * 0.11, 4) - 0.5) * 0.8 \
                       + (vfbm(X, Y, seed + 5, w * 0.03, 3) - 0.5) * 0.22
    # carve the SE strait (volcano island sits offshore) + west notch bay
    for (bx, by, brx, bry, amp) in [
        (0.82 * w, 0.86 * h, 0.10 * w, 0.09 * h, -0.55),
        (0.03 * w, 0.52 * h, 0.05 * w, 0.08 * h, -0.35),
        (0.52 * w, 0.985 * h, 0.10 * w, 0.05 * h, -0.30),
        (0.905 * w, 0.895 * h, 0.055 * w, 0.05 * h, +0.85),   # Cinderholm island
    ]:
        land_v += amp * np.exp(-(((X - bx) / brx) ** 2 + ((Y - by) / bry) ** 2))
    land = land_v > 0.16

    # ---- climate regions (warped voronoi) -------------------------------------
    warp = (vfbm(X, Y, seed + 7, w * 0.05, 3) - 0.5) * (0.10 * w)
    stack = []
    for (name, cli, cx, cy, r, _b, _a) in REGIONS:
        dist = np.hypot(X + warp - cx * w, Y - warp - cy * h) / (r * max(w, h))
        stack.append(dist.astype(np.float32))
    nearest = np.argmin(np.stack(stack), axis=0)
    cli_names = [r[1] for r in REGIONS]
    climate = np.empty((h, w), dtype=object)
    for i, cname in enumerate(cli_names):
        climate[nearest == i] = cname
    # meadow is the connective tissue where no region really reaches
    mind = np.min(np.stack(stack), axis=0)
    climate[mind > 1.15] = "meadow"
    # island is volcanic regardless of voronoi noise
    isl = np.exp(-(((X - 0.905 * w) / (0.06 * w)) ** 2 + ((Y - 0.895 * h) / (0.055 * h)) ** 2)) > 0.35
    climate[isl] = "volcanic"
    climate[~land] = "sea"
    # soft coasts get a beach climate ring
    SOFT = {"meadow", "farmland", "savanna", "forest", "jungle", "desert", "autumn"}
    beach = land & (land_v < 0.205)
    soft_mask = np.isin(climate, list(SOFT))
    climate[beach & soft_mask] = "coast"

    # ---- elevation -------------------------------------------------------------
    base = np.zeros((h, w), np.float32)
    amp = np.zeros((h, w), np.float32)
    for i, (name, cname, cx, cy, r, eb, ea) in enumerate(REGIONS):
        m = nearest == i
        base[m], amp[m] = eb, ea
    base[climate == "meadow"] = 1.6
    amp[climate == "meadow"] = 0.8
    base[climate == "coast"] = 0.6
    amp[climate == "coast"] = 0.3

    elev = base + (vfbm(X, Y, seed + 13, w * 0.05, 4) - 0.5) * 2 * amp
    # broad terraced shelves in the green lowlands (ALTTP hill walls)
    shelf = vfbm(X, Y, seed + 31, w * 0.075, 2)
    shelfy = np.isin(climate, ["meadow", "farmland", "forest", "autumn", "jungle", "savanna"])
    elev += shelfy * ((shelf > 0.56) * 1.0 + (shelf > 0.68) * 1.0 + (shelf > 0.78) * 1.0)
    # desert MESAS: flat plateau tops with sheer walls
    mesa = vfbm(X, Y, seed + 41, w * 0.06, 3)
    dm = climate == "desert"
    elev[dm] = 1.0 + (mesa[dm] > 0.52) * 3.0 + (mesa[dm] > 0.64) * 2.0 + (mesa[dm] > 0.74) * 2.0
    # volcano cone with a crater
    vr = np.hypot(X - 0.905 * w, Y - 0.895 * h) / (0.055 * w)
    cone = np.clip(1 - vr, 0, 1) * 10.5
    crater = np.exp(-(vr / 0.16) ** 2) * 3.5
    vm = climate == "volcanic"
    elev[vm] = (cone - crater)[vm]
    # swamp is dead flat
    elev[climate == "swamp"] = 0.0

    # coastal profile: soft climates sink to beaches, hard ones cliff into the sea
    t = np.clip((land_v - 0.16) / 0.26, 0, 1)
    softc = np.isin(climate, list(SOFT) + ["coast", "swamp", "tundra"])
    hardc = np.isin(climate, ["mountain", "alpine", "mine", "volcanic"])
    elev = np.where(softc, elev * t, elev)
    elev = np.where(hardc, elev * (0.7 + 0.3 * t), elev)

    elev = np.clip(np.round(elev), 0, MAX_LEVEL).astype(np.int8)
    elev[~land] = 0

    # ---- lake + rivers + canyon -------------------------------------------------
    lake_d = np.hypot(X - LAKE[0] * w, Y - LAKE[1] * h)
    lake = (lake_d < LAKE[2] * w * (1 + (vnoise(X, Y, seed + 9, 14) - 0.5) * 0.5)) \
           & (lake_d > LAKE_ISLE_R * w)
    water = ~land | lake
    elev[lake] = 0

    river_mask = np.zeros((h, w), bool)
    river_lvl = np.zeros((h, w), np.int8)

    def carve(path, width, is_canyon=False):
        lvl = None
        pts = [(px * w, py * h) for px, py in path]
        seg_i = 0
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            seg_i += 1
            steps = int(math.hypot(bx - ax, by - ay)) + 1
            # perpendicular for meander offsets
            sl = math.hypot(bx - ax, by - ay) or 1.0
            px_, py_ = -(by - ay) / sl, (bx - ax) / sl
            for i in range(steps + 1):
                t_ = i / steps
                fx = ax + (bx - ax) * t_
                fy = ay + (by - ay) * t_
                # natural meander: two sine waves + noise, fading at joints
                fade = min(1.0, 4 * t_ * (1 - t_)) if steps > 8 else 0.0
                m = (math.sin(t_ * math.pi * 2.2 + seg_i * 1.7) * 2.4
                     + math.sin(t_ * math.pi * 5.1 + seg_i * 0.9) * 1.1) * fade
                fx += px_ * m
                fy += py_ * m
                cx, cy = int(fx), int(fy)
                if not (0 <= cx < w and 0 <= cy < h):
                    continue
                here = int(elev[cy, cx])
                lvl = here if lvl is None else min(lvl, here)
                r = int(width) + 1
                for dy2 in range(-r, r + 1):
                    for dx2 in range(-r, r + 1):
                        x2, y2 = cx + dx2, cy + dy2
                        if not (0 <= x2 < w and 0 <= y2 < h):
                            continue
                        dd = math.hypot(dx2, dy2)
                        if dd <= width:
                            if is_canyon:
                                elev[y2, x2] = min(elev[y2, x2], 1)
                            elif land[y2, x2] and not lake[y2, x2]:
                                river_mask[y2, x2] = True
                                river_lvl[y2, x2] = lvl
                        elif dd <= r and not is_canyon:
                            elev[y2, x2] = min(elev[y2, x2], lvl + 1)

    for rv in RIVERS:
        carve(rv["pts"], rv["w"])
    carve(CANYON["pts"], CANYON["w"], is_canyon=True)
    elev[river_mask] = river_lvl[river_mask]
    water |= river_mask

    # ---- smoothing: no 1-cell spikes/pits, no orphan islets ----------------------
    for _ in range(2):
        e = elev.copy()
        up = np.roll(e, 1, 0); dn = np.roll(e, -1, 0)
        lf = np.roll(e, 1, 1); rt = np.roll(e, -1, 1)
        mx = np.maximum(np.maximum(up, dn), np.maximum(lf, rt))
        spike = (e > mx) & land & ~water
        elev[spike] = mx[spike]

    # ---- tile assignment ----------------------------------------------------------
    terr = np.empty((h, w), object)
    varr = np.zeros((h, w), np.uint8)
    # CLUSTERED filler selection: a low-frequency field picks the tile, so the
    # same filler runs in organic patches of several cells (painterly), never a
    # per-cell checkerboard. A whisper of per-cell jitter keeps borders soft.
    fpick = vfbm(X, Y, seed + 77, 9.0, 2)
    fpick = np.clip((fpick - 0.30) / 0.40 + (cellhash(X, Y, seed + 82) - 0.5) * 0.12,
                    0, 0.9999)
    hpick = fpick
    hacc = cellhash(X, Y, seed + 78)

    for cname, tab in tables.items():
        m = (climate == cname) & land & ~water
        if not m.any():
            continue
        f = tab["fillers"]
        idx = (hpick[m] * len(f)).astype(int)
        cats = np.array([c for c, _ in f], object)
        vs = np.array([v for _, v in f], np.uint8)
        terr[m] = cats[idx]
        varr[m] = vs[idx]
        if tab["accents"]:
            am = m & (hacc < tab["budget"])
            a = tab["accents"]
            aidx = (cellhash(X, Y, seed + 79)[am] * len(a) * 0.9999).astype(int)
            terr[am] = np.array([c for c, _ in a], object)[aidx]
            varr[am] = np.array([v for _, v in a], np.uint8)[aidx]

    # coast climate: sand (coral on the southern/jungle shores)
    cm = (climate == "coast") & land & ~water
    south = Y > 0.60 * h
    terr[cm & ~south] = "sand"
    terr[cm & south] = "coral_sand"
    sandpick = (hpick * 4).astype(int)
    for v, vv in enumerate([0, 6, 7, 13]):
        varr[cm & ~south & (sandpick == v)] = vv
    for v, vv in enumerate([0, 3, 12, 15]):
        varr[cm & south & (sandpick == v)] = vv
    acc = cm & south & (hacc < 0.06)
    terr[acc] = "coral_sand"
    varr[acc] = np.where(cellhash(X, Y, seed + 80)[acc] < 0.5, 4, 6).astype(np.uint8)

    # farmland patchwork quilt: block-hashed field types
    fm = (climate == "farmland") & land & ~water
    bx = (X / 7).astype(np.int64)
    by = (Y / 9).astype(np.int64)
    bh = _h01(bx, by, seed + 90)
    PATCH = [("wheat_field", [0, 5, 6, 8]), ("farm", [0, 2, 9, 10]),
             ("farm", [7, 12]), ("vineyard", [7, 8, 13]), ("grass", [1, 1, 3])]
    pidx = (bh * len(PATCH) * 0.9999).astype(int)
    for i, (pc, pvs) in enumerate(PATCH):
        pm = fm & (pidx == i)
        terr[pm] = pc
        varr[pm] = np.array(pvs, np.uint8)[(hpick[pm] * len(pvs)).astype(int)]

    # water tiles: depth-ramped family
    terr[water] = "water"
    landU8 = land.astype(np.uint8)
    near = landU8.copy()
    for _ in range(4):   # distance-to-land rings 1..4
        n2 = near.copy()
        n2[1:] |= near[:-1]; n2[:-1] |= near[1:]
        n2[:, 1:] |= near[:, :-1]; n2[:, :-1] |= near[:, 1:]
        near = n2
        landU8 = landU8 + near
    ring = landU8  # higher = closer to land
    sea = water & ~river_mask & ~lake
    varr[sea & (ring >= 4)] = 6                    # shallows
    varr[sea & (ring == 3)] = 0
    varr[sea & (ring == 2)] = 1
    varr[sea & (ring <= 1)] = 4                    # deep
    spark = sea & (ring <= 2) & (hacc < 0.02)
    varr[spark] = 8
    varr[river_mask] = 2
    varr[lake] = 1
    lakeshallow = lake & (ring >= 4)
    varr[lakeshallow] = 3          # soft ripple ring, not glowing cyan

    # swamp waterline: olive murk pools instead of blue
    swm = (climate == "swamp") & land & ~water & (cellhash(X, Y, seed + 91) < 0.30)
    terr[swm] = "water"
    varr[swm] = np.where(cellhash(X, Y, seed + 92)[swm] < 0.5, 10, 11).astype(np.uint8)
    elev[swm] = 0

    # volcano ground: heat ramp by height
    vm2 = vm & land & ~water
    ve = elev.astype(np.int32)
    terr[vm2 & (ve <= 3)] = "lava"; varr[vm2 & (ve <= 3)] = 0
    terr[vm2 & (ve > 3) & (ve <= 6)] = "lava"
    varr[vm2 & (ve > 3) & (ve <= 6)] = np.where(
        cellhash(X, Y, seed + 93)[vm2 & (ve > 3) & (ve <= 6)] < 0.5, 5, 6).astype(np.uint8)
    hot = vm2 & (ve > 6)
    varr[hot] = np.where(cellhash(X, Y, seed + 94)[hot] < 0.4, 10, 9).astype(np.uint8)
    terr[hot] = "lava"
    crater_m = vm2 & (vr < 0.14)
    terr[crater_m] = "lava"; varr[crater_m] = 12          # molten heart

    # ---- climate transitions: bridge tiles at borders -----------------------------
    def neighbors_climate(cname):
        m = climate == cname
        n = np.zeros_like(m)
        n[1:] |= m[:-1]; n[:-1] |= m[1:]
        n[:, 1:] |= m[:, :-1]; n[:, :-1] |= m[:, 1:]
        n[1:, 1:] |= m[:-1, :-1]; n[:-1, :-1] |= m[1:, 1:]
        return n

    htr = cellhash(X, Y, seed + 95)
    for tr in climates_cfg["transitions"]:
        a, b, via = tr["a"], tr["b"], tr["via"]
        vialist = [(c, v) for c, vs in via.items() for v in vs]
        if not vialist:
            continue
        for side, other in ((a, b), (b, a)):
            m = (climate == side) & neighbors_climate(other) & land & ~water & (htr < 0.40)
            if not m.any():
                continue
            vi = (cellhash(X, Y, seed + 96)[m] * len(vialist) * 0.9999).astype(int)
            terr[m] = np.array([c for c, _ in vialist], object)[vi]
            varr[m] = np.array([v for _, v in vialist], np.uint8)[vi]

    # ---- trees (tile verticals; none on water/roads/steep edges) -------------------
    e = elev
    edge_drop = np.zeros((h, w), bool)
    edge_drop[:-1] |= e[:-1] > e[1:]
    edge_drop[:, :-1] |= e[:, :-1] > e[:, 1:]
    htree = cellhash(X, Y, seed + 97)
    hkind = cellhash(X, Y, seed + 98)
    for cname, (dens, kinds) in TREES.items():
        m = (climate == cname) & land & ~water & ~edge_drop & (htree < dens)
        if not m.any():
            continue
        ki = (hkind[m] * len(kinds) * 0.9999).astype(int)
        terr[m] = np.array([c for c, _ in kinds], object)[ki]
        varr[m] = np.array([v for _, v in kinds], np.uint8)[ki]

    # ---- roads ---------------------------------------------------------------------
    cost = np.full((h, w), np.inf, np.float32)
    for cname, cc in ROADCOST.items():
        if cc is not None:
            cost[climate == cname] = cc
    cost[water] = np.inf
    cost[river_mask] = 14.0          # bridgeable
    road_mask = np.zeros((h, w), bool)

    def snap(pt):
        """Nearest passable land cell to a fractional point (roads must start
        and end on ground even when noise nudged the coastline)."""
        x0, y0 = int(pt[0] * w), int(pt[1] * h)
        best, bd = None, 1e9
        for r in range(0, 14):
            for dy2 in range(-r, r + 1):
                for dx2 in range(-r, r + 1):
                    if max(abs(dx2), abs(dy2)) != r:
                        continue
                    x1, y1 = x0 + dx2, y0 + dy2
                    if 0 <= x1 < w and 0 <= y1 < h and np.isfinite(cost[y1, x1]):
                        dd = dx2 * dx2 + dy2 * dy2
                        if dd < bd:
                            best, bd = (x1, y1), dd
            if best:
                return best
        return (x0, y0)

    def astar(a, b):
        start, goal = snap(a), snap(b)
        openq = [(0.0, start)]
        g = {start: 0.0}
        came = {}
        while openq:
            _, cur = heapq.heappop(openq)
            if cur == goal:
                path = [cur]
                while cur in came:
                    cur = came[cur]
                    path.append(cur)
                return path[::-1]
            x0, y0 = cur
            for x1, y1 in ((x0+1,y0),(x0-1,y0),(x0,y0+1),(x0,y0-1)):
                if not (0 <= x1 < w and 0 <= y1 < h):
                    continue
                c = cost[y1, x1]
                if not np.isfinite(c):
                    continue
                if road_mask[y1, x1]:
                    c = 0.4
                c += abs(int(elev[y1, x1]) - int(elev[y0, x0])) * 3.0
                ng = g[cur] + float(c)
                if ng < g.get((x1, y1), 1e18):
                    g[(x1, y1)] = ng
                    came[(x1, y1)] = cur
                    heapq.heappush(openq, (ng + abs(x1-goal[0]) + abs(y1-goal[1]), (x1, y1)))
        return None

    paths = []
    for a, b in ROADS:
        p = astar(a, b)
        if p:
            paths.append(p)
            for (x0, y0) in p:
                road_mask[y0, x0] = True

    # flatten the roadbed a touch: no road cell more than 1 above its predecessor
    for p in paths:
        for (x0, y0), (x1, y1) in zip(p, p[1:]):
            if abs(int(elev[y1, x1]) - int(elev[y0, x0])) > 1:
                elev[y1, x1] = elev[y0, x0] + (1 if elev[y1, x1] > elev[y0, x0] else -1)

    # place road tiles: bridge arches on water, stairs on climbs, autotile the rest
    for p in paths:
        for i, (x0, y0) in enumerate(p):
            if water[y0, x0]:
                terr[y0, x0] = "stairs"; varr[y0, x0] = 9        # stone bridge arch
                prev = p[i-1] if i else p[i]
                elev[y0, x0] = elev[prev[1], prev[0]]
                continue
    for p in paths:
        for i in range(1, len(p)):
            (x0, y0), (x1, y1) = p[i-1], p[i]
            if terr[y0, x0] == "stairs" or terr[y1, x1] == "stairs":
                continue
            if int(elev[y1, x1]) == int(elev[y0, x0]) + 1:
                terr[y0, x0] = "stairs"; varr[y0, x0] = 0
            elif int(elev[y1, x1]) == int(elev[y0, x0]) - 1:
                terr[y1, x1] = "stairs"; varr[y1, x1] = 0

    fallback_style = "road_dirt_grass"
    for y0 in range(h):
        for x0 in range(w):
            if not road_mask[y0, x0] or terr[y0, x0] == "stairs" or water[y0, x0]:
                continue
            cname = climate[y0, x0]
            style = tables.get(cname, {}).get("road", fallback_style)
            pieces = roadsets.get(style) or roadsets.get(fallback_style, {})
            arms = set()
            if y0 > 0 and road_mask[y0-1, x0]: arms.add("N")
            if x0+1 < w and road_mask[y0, x0+1]: arms.add("E")
            if y0+1 < h and road_mask[y0+1, x0]: arms.add("S")
            if x0 > 0 and road_mask[y0, x0-1]: arms.add("W")
            key = frozenset(arms)
            cand = pieces.get(key)
            if not cand and len(key) >= 2:
                sups = [k for k in pieces if key <= k]
                if sups:
                    cand = pieces[min(sups, key=len)]
            if not cand and len(key) == 2:
                cand = pieces.get(frozenset({"N", "S"})) or pieces.get(frozenset({"E", "W"}))
            if not cand:
                sups = [k for k in pieces if len(k) >= 2 and key <= k]
                cand = pieces[min(sups, key=len)] if sups else None
            if not cand:
                big = [k for k in pieces if len(k) == 4] or [k for k in pieces if len(k) >= 2]
                cand = pieces[big[0]] if big else [(fallback_style + "_straight", 0)]
            pick = cand[int(cellhash(np.array([[x0]]), np.array([[y0]]), seed + 99)[0, 0]
                           * len(cand) * 0.9999)]
            terr[y0, x0], varr[y0, x0] = pick[0], pick[1]

    # ---- landmark verticals (single tiles, sparse) ----------------------------------
    def put(fx, fy, cat, v, label=None):
        x0, y0 = int(fx * w), int(fy * h)
        for dy2 in range(-3, 4):
            for dx2 in range(-3, 4):
                x1, y1 = x0 + dx2, y0 + dy2
                if 0 <= x1 < w and 0 <= y1 < h and land[y1, x1] and not water[y1, x1] \
                        and not road_mask[y1, x1]:
                    terr[y1, x1] = cat
                    varr[y1, x1] = v
                    if label:
                        W.pois.append({"x": x1, "y": y1, "label": label, "tile": cat})
                    return

    put(0.475, 0.545, "watchtower", 1, "Kingscross Beacon")       # hub signal tower
    put(0.60, 0.155, "wooden_tower", 0, "Deepdelve Gate")
    put(0.155, 0.607, "watchtower", 7, "Oasis Turret")
    put(0.52, 0.695, "watchtower", 0, "Millbrook Keep")
    put(0.12, 0.345, "wooden_tower_v2", 7, "Hoarwind Post")
    put(0.93, 0.435, "watchtower", 3, "Eldergreen Ruin")
    put(0.35, 0.35, "obelisk", 2, "The Runestone")
    put(0.80, 0.155, "obelisk_v2", 2, "Emberfall Stone")
    put(0.87, 0.315, "crystal_spire", 6, "Gloomcap Heart")
    put(0.145, 0.115, "ice_spire", 1, "Frostspire")
    put(0.905, 0.888, "big_boulder", 6, "Cinder Columns")
    put(0.185, 0.645, "cactus", 5, "Bloom of the Waste")
    # a menhir ring on the meadow hill west of the lake
    for i in range(8):
        a = i * math.tau / 8
        put(0.395 + 0.018 * math.cos(a), 0.415 + 0.02 * math.sin(a), "obelisk", 1)
    # the oasis pond
    ox, oy = int(0.150 * w), int(0.622 * h)
    for dy2 in range(-2, 3):
        for dx2 in range(-2, 3):
            if dx2*dx2 + dy2*dy2 <= 3 and 0 <= ox+dx2 < w and 0 <= oy+dy2 < h:
                terr[oy+dy2, ox+dx2] = "water"; varr[oy+dy2, ox+dx2] = 6
                elev[oy+dy2, ox+dx2] = 1
    for dx2, dy2, c, v in [(-3, 0, "grass", 1), (3, 1, "grass", 3), (0, -3, "oak_tree_v2", 0),
                           (2, 3, "grass", 1), (-2, -2, "oak_tree_v2", 6)]:
        if 0 <= ox+dx2 < w and 0 <= oy+dy2 < h:
            terr[oy+dy2, ox+dx2] = c; varr[oy+dy2, ox+dx2] = v

    # lake shrine island
    ix, iy = int(LAKE[0] * w), int(LAKE[1] * h)
    terr[iy, ix] = "mosaic_floor"; varr[iy, ix] = 6
    for dx2, dy2 in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        terr[iy+dy2, ix+dx2] = "grass"; varr[iy+dy2, ix+dx2] = 1
    terr[iy-1, ix-1] = "obelisk_v2"; varr[iy-1, ix-1] = 8

    # ---- pack into BigWorld ----------------------------------------------------------
    terr[terr == None] = "water"       # safety
    for y0 in range(h):
        trow = terr[y0]
        for x0 in range(w):
            W.terr[y0, x0] = W.cat(trow[x0])
    W.variant = varr
    W.level = elev
    for y0 in range(h):
        crow = climate[y0]
        for x0 in range(w):
            W.climate[y0, x0] = W.cli(crow[x0] if crow[x0] is not None else "sea")
    W.log.append(f"genesis: {w}x{h} seed={seed}; {len(REGIONS)} regions, "
                 f"{len(paths)} roads, {int(road_mask.sum())} road cells, "
                 f"{int(river_mask.sum())} river cells")
    return W


if __name__ == "__main__":
    import time
    t0 = time.time()
    world = generate(192, 168, seed=11)
    print(world.log[-1], f"({time.time()-t0:.1f}s)")
