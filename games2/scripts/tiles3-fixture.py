#!/usr/bin/env python3
"""Emit the tiles3 PARITY FIXTURE: what render3.py draws, cell for cell.

  python3 games2/scripts/tiles3-fixture.py
  -> games2/server/test/fixtures/tiles3-parity.json

maps2/pipeline/render3.py IS the spec for pixel-maps3/world@1, so this script
IMPORTS it and records what its own functions return — it never re-derives a
resolution. Every art identity here comes back from render3 itself:

  * region_at / ox / oy / LP / maxL    captured out of render()'s frame while
                                       render() actually runs (sys.settrace,
                                       return event). They are locals with no
                                       accessor; reading the frame tracks the
                                       reference, a re-implementation would
                                       drift silently. `region_at` is render3's
                                       own closure, so the CHUNK RULE is called,
                                       never restated.
  * plate identity                     plate_img() returns a cached Image; the
                                       key it is cached under in
                                       render3._tile_cache IS the resolution
                                       (('plate', ground, key8) | ('conform',
                                       art_rel, ground) | ('plate', g,'clean')).
  * over / storey identity             render3.approved_candidate(), the same
                                       call over_tile()/storey_tile() make.
  * flat identity                      render3.Image.open is wrapped, so the
                                       path flat_tile()'s ladder lands on is
                                       observed, not predicted.

  * slope / fade / detail / boundary   the leaf calls themselves —
                                       R3.slope_tile, R3.fade_pool,
                                       R3.detail_pool, R3.conformed_plate,
                                       R3.composed_boundary, R3.top_face_only —
                                       so every art path is the spec's answer.

What CANNOT be imported is the control flow AROUND those calls: render3's
`surface` and `wang_surface` are closures redefined per cell inside render()'s
loop, so the slope bitmask, the Chebyshev fade band, the detail roll, the Wang
fold and the wall-side rule are mirrored here. THEY ARE THEN PROVEN EQUAL:
Image.alpha_composite is wrapped during the real render and every (size, dest,
IDENTITY) this script predicts is compared against the draw stream render3
actually emitted, where the identity is the tile's own cache key. A mirrored
line that drifts fails the run; it cannot reach the file. Size alone would not
do it — a plate, a slope, a fade and a detail are all 64x46.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "maps2", "pipeline"))

import render3 as R3                                    # THE SPEC
import PIL.Image

OUT = os.path.join(REPO, "games2", "server", "test", "fixtures", "tiles3-parity.json")
WORLD_REL = "maps2/worlds3/the_game/world.json"

# THE REGIONS. Flat grass proves nothing, so each window is chosen for what it
# forces the renderer to decide, not for its area.
WINDOWS = [
    dict(
        name="the_bay",
        x0=380, y0=344, x1=436, y1=400,
        why="The south-east bay: a deep_water/water/light_beach coastline, the "
            "grass~light_soil road running inland, cliffs up to 7 exposed "
            "storeys, and a parquet_floor/grey_paving_stone house under a roof "
            "deck with a bridge deck beside it. 10 of the world's 13 grounds, "
            "13 of the 14 drawn corner-lattice indices.",
    ),
    dict(
        name="his_beach",
        x0=430, y0=352, x1=478, y1=400,
        why="Where the maintainer stood when he marked stripes along every "
            "grass~light_beach~water transition (2026-08-29, 453/375). The "
            "coastline here is the fade band's densest run in the world.",
    ),
    dict(
        name="diag_corner",
        x0=328, y0=324, x1=344, y1=340,
        why="The ONLY place in the 262,144-cell world that carries a DIAGONAL "
            "lattice index: 9 (NW+SE) at the snow/grey_stone shoulder (336,332). "
            "Index 6 (NE+SW) does not occur anywhere in the_game at all, so 13 "
            "of the 14 drawn indices is the ceiling; without this patch it would "
            "be 12. Also 16x16 of the massif at level 20 — raised cells that "
            "wear the maintainer's set with NO exposed face, which is 41,988 of "
            "the world's 45,658 raised cells and the case a top-face dressing "
            "exists for.",
    ),
]

# The reader's map. Every index below is into a table, never a repeated string:
# a parity fixture is read by a unit test, so it stays small enough to commit.
FORMAT = {
    "tables": "paths[] holds every repo-relative file. tiles[] and plates[] "
              "hold art identities; a cell/boundary/deck refers to them by "
              "index. plates[] indices are per-fixture, not per-ground.",
    "window": "One render3.render(doc, x0, y0, x1, y1) call. g() returns None "
              "outside the window, so a quad at the window edge composes no "
              "boundary and a fade band is cut there — a port must pass the "
              "same window. REGIONS ARE 24-CELL CHUNKS and are therefore NOT "
              "window-dependent: region_ids[] is just the set the window "
              "touches. origin.ox/oy/storey_pitch are the values render3 "
              "derived; world_max_level is over the WHOLE doc (oy = "
              "world_max_level*WALL + 24), not the window.",
    "cell": {
        "x,y,g,z": "cell, ground name, level",
        "r": "index into this window's region_ids[]",
        "sx,sy": "screen origin of the cell's column: sx = ox + (x-x0-(y-y0))"
                 "*DX - DX, sy = oy + (x-x0+y-y0)*DY - z*storey_pitch",
        "srf": "WHAT THE SURFACE RESOLVED TO — plate | slope | fade | detail | "
               "boundary. Every one of them is 64x46 plate geometry pasted at "
               "sy, which is why the identity and not the size is what the "
               "generator compares against render3's draw stream.",
        "set,mi": "pick_set().id and the pick_member() INDEX into that set's "
                  "members[]. Look the set up BY ID in invariants."
                  "base_tile_sets[g] — ids are sorted but not contiguous. "
                  "mi = -1 is pick_member's sentinel clean. On a boundary cell "
                  "these are the CELL'S OWN half of the composed tile.",
        "p": "index into plates[] — what plate_img() actually returned",
        "sl": "the slope: i = the Wang-on-ELEVATION bitmask (bit set = that "
              "corner is raised by a cell of the same ground), dir = the set "
              "the chunk picked, t = paths[] index",
        "f": "the fade: o = the other ground found in the band, d = its "
             "CHEBYSHEV ring (1 or 2), pool = key into this window's "
             "fade_pools, i = index into that pool, u = the LCG draw that "
             "decides WHETHER this cell fades (fades iff u <= 0.45*band_pos), "
             "v = the draw that picks from the rating-weighted pool, t = "
             "paths[] index",
        "d": "the detail: i = index into invariants.detail_pools[g], t = "
             "paths[] index. Rolled at DETAIL_FREQ 1/56 on every surface that "
             "is not a fade or a boundary.",
        "b": "index into this window's boundaries[] — the composed Wang tile "
             "IS this cell's surface, drawn INSTEAD of the plate",
        "top_only": "only the TOP FACE of the surface is painted "
                    "(top_face_only): a liquid, and the cap of a raised cell",
        "dressed": "the surface is painted at all — false only where the "
                   "maintainer set own_top on the cap's review key (no cell of "
                   "the_game does today)",
        "py,ph": "paste y and height of the surface: always sy and 46",
        "w": "the wall column, present only when a face is EXPOSED (a "
             "down-screen neighbour is LOWER). side = the ground the face is "
             "drawn OVER, fl = front_low, fx/fy = the down-screen neighbour it "
             "came from, over = the cell is in a walls[] group, cap/mid = "
             "tiles[] indices, midg = the course's ground (THE WALL'S SIDE, "
             "always), st = the stack bottom-to-top as [storey, tiles[] index, "
             "paste y]. A raised cell with NO exposed face carries no `w` at "
             "all and draws exactly one surface — 41,988 of the world's 45,658 "
             "raised cells.",
    },
    "boundary": "x,y = the cell it is the surface of; i = the Wang index; a,b = "
                "side_a / side_b by SIDE_ORDER; folded = a three-ground "
                "junction whose rarest ground was folded into the majority; "
                "pa,pb = plates[] indices for each side; seta/mia and setb/mib "
                "the set+member behind them; sx,sy the paste. EACH HALF ASKS "
                "FOR ITS OWN GROUND'S REGION — chunk regions make that the same "
                "chunk with a different ground name.",
    "deck": "one drawn deck cell: d = index into world.decks, lo..lvl is the "
            "storey range, cap/mid = tiles[] indices, st as for a wall, and "
            "srf_set/srf_mi/srf_p/srf_y the base-tile-set surface the slab "
            "wears on top (top face only, straight from plate_img — no fade, "
            "no slope, no boundary).",
    "scenery": "bbox = the sprite's getbbox() before scaling to want_h; w,h "
               "the scaled size (Python round(), banker's — a port that "
               "rounds half-up drifts a pixel); sx,sy the paste.",
}

# ---------------------------------------------------------------- tables ----
PATHS: list[str] = []
PATH_IX: dict[str, int] = {}
TILES: list[dict] = []
TILE_IX: dict[tuple, int] = {}
PLATES: list[dict] = []
PLATE_IX: dict[tuple, int] = {}


def path_ix(rel):
    rel = os.path.relpath(os.path.abspath(os.path.join(REPO, rel)), REPO)
    if rel not in PATH_IX:
        PATH_IX[rel] = len(PATHS)
        PATHS.append(rel)
    return PATH_IX[rel]


# render3 opens every art file through its module-level `Image`; wrapping it is
# how flat_tile()'s ladder (base_tiles -> live promotion -> review) reports the
# path it actually chose without this script re-walking the ladder.
_OPENED: list[str] = []
_real_open = R3.Image.open


def _tracing_open(fp, *a, **k):
    _OPENED.append(str(fp))
    return _real_open(fp, *a, **k)


R3.Image.open = _tracing_open


def _traced(fn, *args):
    """Call fn(*args) and return (result, paths it opened). Empty on a cache
    hit — every identity below is resolved once, on its first (cold) call."""
    _OPENED.clear()
    r = fn(*args)
    return r, list(_OPENED)


_FLAT_SRC: dict[str, str | None] = {}


def prewarm_flat(doc):
    """flat_tile() caches, and a cache hit opens nothing — so its ladder must
    be observed on the COLD call, before any render warms it. None = painted."""
    for gname in doc["grounds"]:
        _, opened = _traced(R3.flat_tile, gname)
        _FLAT_SRC[gname] = opened[-1] if opened else None


def flat_ident(ground):
    key = ("flat", ground)
    if key in TILE_IX:
        return TILE_IX[key]
    im = R3.flat_tile(ground)
    e = {"role": "flat", "ground": ground, "w": im.width, "h": im.height}
    src = _FLAT_SRC[ground]
    if src:
        e["path"] = path_ix(src)
    else:
        # liquids are painted, not loaded: a flat-colour diamond from the
        # ground's palette top over rows TOP_Y..TOP_Y+2*DY, no wall (a liquid
        # never shows one). A port paints it; there is no file to compare.
        e["painted"] = "liquid_diamond"
        e["top_rgb"] = list(R3._hex(R3.GT[ground]["palette"]["top"]))
    TILE_IX[key] = len(TILES)
    TILES.append(e)
    return TILE_IX[key]


def over_ident(top, side):
    key = ("over", top, side)
    if key in TILE_IX:
        return TILE_IX[key]
    c = R3.over_candidate(top, side)
    im = R3.over_tile(top, side)
    e = {"role": "over", "top": top, "side": side, "key": c["key"],
         "path": path_ix(c["file"]), "w": im.width, "h": im.height}
    # THE BORROWED WALL. He marks a tile top_only (its own face is unusable) in
    # tile_walls.json and names the face it wears instead in top_walls.json; the
    # two files only mean anything together. The over tile is then `path`'s art
    # with THIS candidate's band pasted over rows TOP_Y+2*DY.., which is a raster
    # the resolver NAMES and the draw layer builds — so the fixture pins which
    # wall, not just that there is one. 181 cells of the_game wear one today.
    if R3.top_only(c["key"].strip("/")):
        lend = R3.borrowed_wall(c["key"].strip("/")) or R3.approved_candidate(side, side)
        if lend:
            e["borrowed"] = {"key": lend["key"], "path": path_ix(lend["file"])}
    TILE_IX[key] = len(TILES)
    TILES.append(e)
    return TILE_IX[key]


def storey_ident(ground):
    key = ("storey", ground)
    if key in TILE_IX:
        return TILE_IX[key]
    c = R3.approved_candidate(ground, ground, storey=True)
    im = R3.storey_tile(ground)
    TILE_IX[key] = len(TILES)
    TILES.append({"role": "storey", "ground": ground, "key": c["key"],
                  "path": path_ix(c["file"]), "w": im.width, "h": im.height})
    return TILE_IX[key]


def plate_ident(ground, region, x, y):
    """plate_img()'s own cache key IS the resolution — reverse-look it up by
    object identity rather than replaying the key8/conform rules here."""
    img = R3.plate_img(ground, region, x, y)
    ck = next(k for k, v in R3._tile_cache.items() if v is img)
    if ck in PLATE_IX:
        return PLATE_IX[ck], img
    if ck[0] == "conform":
        e = {"kind": "conformed", "ground": ground, "src": path_ix(ck[1])}
    elif ck[2] == "clean":
        e = {"kind": "clean", "ground": ground,
             "path": path_ix(f"tiles/plates/{ground}/clean.webp")}
    else:
        e = {"kind": "plate", "ground": ground, "key8": ck[2],
             "path": path_ix(f"tiles/plates/{ground}/{ck[2]}.webp")}
    e["w"], e["h"] = img.width, img.height
    for k in ("path", "src"):
        if k in e:
            assert os.path.isfile(os.path.join(REPO, PATHS[e[k]])), PATHS[e[k]]
    PLATE_IX[ck] = len(PLATES)
    PLATES.append(e)
    return PLATE_IX[ck], img


_SETS: dict[tuple, dict] = {}


def pick_set(ground, region):
    k = (ground, region)
    if k not in _SETS:
        _SETS[k] = R3.pick_set(ground, region)
    return _SETS[k]


def pick_member_ix(chosen, x, y):
    """render3.pick_member returns the member OBJECT; the fixture wants its
    index. -1 is the sentinel clean it returns when no member has weight."""
    m = R3.pick_member(chosen, x, y)
    for i, mm in enumerate(chosen.get("members") or []):
        if mm is m:
            return i, m
    return -1, m


# ------------------------------------------------------- the real render ----
# THE IDENTITY OF A DRAWN TILE, not just its size. Every art render3 draws is
# cached in render3._tile_cache under a key that IS its resolution; a composed
# boundary is the one thing built fresh per cell, so it is tagged at the source.
# Comparing sizes alone would let a fade, a detail and a slope swap places
# unnoticed — they are all 64x46 — which is exactly where the new logic lives.
_IDENT: dict[int, tuple] = {}


def _reindex():
    _IDENT.clear()
    for k, v in R3._tile_cache.items():
        if v is not None:
            _IDENT[id(v)] = k


def ident(im):
    """The canonical resolution string of one drawn image, or None for art that
    is neither cached nor tagged — which is exactly and only SCENERY (a sprite
    is opened, cropped and scaled per piece). The count of Nones is asserted
    against the scenery count below, so a terrain source that ever stopped being
    identifiable fails the run rather than comparing None to None."""
    k = im.info.get("k")
    if k is None:
        k = _IDENT.get(id(im))
        if k is None:
            _reindex()
            k = _IDENT.get(id(im))
    return None if k is None else "|".join(str(p) for p in k)


_real_cb = R3.composed_boundary


def _tagging_cb(ga, gb, index, pa, pb, x=0, y=0):
    out = _real_cb(ga, gb, index, pa, pb, x, y)
    out.info["k"] = ("boundary", ga, gb, index,
                     R3.mask_for(index, x, y,
                                 not (ga in R3.MADE_GROUND or gb in R3.MADE_GROUND)),
                     ident(pa), ident(pb))
    return out


R3.composed_boundary = _tagging_cb

_DRAWS: list[tuple] = []
_real_ac = PIL.Image.Image.alpha_composite


def _watch_ac(self, im, dest=(0, 0), source=(0, 0)):
    # ONLY COMPOSITES ONTO THE CANVAS ARE DRAWS. render3 also composites while
    # BUILDING art — over_tile() pastes a borrowed wall band onto a 64px tile
    # when the maintainer marks the tile top_only — and the target there is the
    # tile, not the map. The canvas is (x1-x0+y1-y0)*DX+16 wide, thousands of px;
    # every piece of art is at most TILE.
    if self.width > R3.TILE:
        _DRAWS.append((im.width, im.height, int(dest[0]), int(dest[1]), ident(im)))
    return _real_ac(self, im, dest, source)


def trace_render(doc, w):
    """Run render3.render() on the window, capturing (a) the locals it derives
    — region_at/ox/oy/LP/maxL — and (b) every alpha_composite it emits."""
    want = ("region_at", "ox", "oy", "LP", "maxL", "fw", "fh", "wall_over")
    cap = {}

    def _ret(f, ev, a):
        if ev == "return":
            for k in want:
                if k in f.f_locals:
                    cap[k] = f.f_locals[k]

    def _call(frame, event, arg):
        if event == "call" and frame.f_code is R3.render.__code__:
            frame.f_trace_lines = False       # return events only — line
            return _ret                       # tracing a 3k-cell render is slow
        return None

    _DRAWS.clear()
    PIL.Image.Image.alpha_composite = _watch_ac
    sys.settrace(_call)
    try:
        R3.render(doc, w["x0"], w["y0"], w["x1"], w["y1"], log=lambda *a: None)
    finally:
        sys.settrace(None)
        PIL.Image.Image.alpha_composite = _real_ac
    missing = [k for k in want if k not in cap]
    assert not missing, f"render3.render() no longer defines {missing} — the " \
                        f"frame capture must be retargeted, not guessed"
    _OPENED.clear()
    return cap, list(_DRAWS)


# ------------------------------------------------------------- the window ---
def build_window(doc, w):
    x0, y0, x1, y1 = w["x0"], w["y0"], w["x1"], w["y1"]
    cap, draws = trace_render(doc, w)
    region_at, ox, oy, LP, maxL = (cap["region_at"], cap["ox"], cap["oy"],
                                   cap["LP"], cap["maxL"])
    wall_over = cap["wall_over"]
    W, H = doc["size"]["w"], doc["size"]["h"]
    G, grd, lvl = doc["grounds"], doc["ground"], doc["level"]
    liq = set(doc.get("liquids", []))
    DX, DY, TOP_Y = R3.DX, R3.DY, R3.TOP_Y

    def g(x, y):
        if not (x0 <= x < x1 and y0 <= y < y1):
            return None
        i = grd[y][x]
        return G[i] if i >= 0 else None

    def L(x, y):
        return lvl[y][x] if (0 <= x < W and 0 <= y < H) else 0

    def bx_of(x, y):
        return ox + (x - x0 - (y - y0)) * DX - DX

    def col_y(x, y, f):
        return oy + (x - x0 + y - y0) * DY - f * LP

    rids, rid_ix = [], {}

    def region_ix(gg, x, y):
        r = region_at(x, y, gg)
        if r not in rid_ix:
            rid_ix[r] = len(rids)
            rids.append(r)
        return rid_ix[r], r

    fade_pools: dict[str, list] = {}
    pred: list[tuple] = []                    # predicted draw stream
    cells: list[dict] = []
    bnds: list[dict] = []

    def plate_rec(gg, x, y, rec, prefix=""):
        """plate_img at the ground's OWN region, recorded."""
        _rix, rid = region_ix(gg, x, y)
        chosen = pick_set(gg, rid)
        mi, _m = pick_member_ix(chosen, x, y)
        pix, im = plate_ident(gg, rid, x, y)
        rec[prefix + "set"] = chosen["id"]
        rec[prefix + "mi"] = mi
        rec[prefix + "p"] = pix
        return im

    def surface_rec(gr, x, y, zl, rec):
        """MIRROR of render3.surface(): plate -> slope -> fade -> detail. Every
        leaf decision calls render3's own function; only the order is here, and
        the draw-stream comparison proves the order."""
        t = plate_rec(gr, x, y, rec)
        rec["srf"] = "plate"
        # SLOPE — the Wang bitmask on ELEVATION: bit set = that corner is raised
        # by a cell of the SAME ground.
        sidx = 0
        for bit, (cxx, cyy) in enumerate(((x, y), (x + 1, y),
                                          (x, y + 1), (x + 1, y + 1))):
            for ax, ay in ((cxx - 1, cyy - 1), (cxx, cyy - 1),
                           (cxx - 1, cyy), (cxx, cyy)):
                if L(ax, ay) > zl and g(ax, ay) == gr:
                    sidx |= 8 >> bit
                    break
        if sidx:
            sl = R3.slope_tile(gr, sidx, x, y)
            if sl is not None:
                t = sl
                rec["srf"] = "slope"
                rec["sl"] = {"i": sidx, "dir": sl.info["k"][1].rsplit("/post/", 1)[0],
                             "t": path_ix(sl.info["k"][1])}
        # FADE — a real Chebyshev band from ring 1, scattered, his ratings
        # weighting the pool.
        near = None
        for r in range(1, R3.FADE_BAND + 1):
            for dy2 in range(-r, r + 1):
                for dx2 in range(-r, r + 1):
                    if max(abs(dx2), abs(dy2)) != r:
                        continue
                    og = g(x + dx2, y + dy2)
                    if og and og != gr and og not in liq \
                            and L(x + dx2, y + dy2) == zl:
                        near = (og, r)
                        break
                if near:
                    break
            if near:
                break
        if near:
            pool = R3.fade_pool(gr, near[0])
            if pool:
                pk = f"{gr}|{near[0]}"
                if pk not in fade_pools:
                    fade_pools[pk] = [[path_ix(f), pct, rt] for f, pct, rt in pool]
                rr = R3._rng((x * 73856093) ^ (y * 19349663))
                band_pos = (R3.FADE_BAND + 1 - near[1]) / (R3.FADE_BAND + 1)
                u = rr()
                if u <= 0.45 * band_pos:
                    wts = [(1.0 + 1.6 * rt) * (1.0 - abs((pc / 60.0) - band_pos))
                           for (_f, pc, rt) in pool]
                    tot = sum(wt for wt in wts if wt > 0) or 1.0
                    v = rr()
                    pick, acc = len(pool) - 1, v * tot
                    for i2, wt in enumerate(wts):
                        acc -= max(0.0, wt)
                        if acc <= 0:
                            pick = i2
                            break
                    idx = max(0, pick)
                    rec["srf"] = "fade"
                    rec["f"] = {"o": near[0], "d": near[1], "pool": pk, "i": pick,
                                "u": round(u, 12), "v": round(v, 12),
                                "t": path_ix(pool[idx][0])}
                    return R3.conformed_plate(pool[idx][0], gr)
        # DETAILS — his 478 '#top' approvals, once in a while.
        dp = R3.detail_pool(gr)
        if dp:
            rate = float(R3._DETAIL_RATE.get(gr, R3.DETAIL_FREQ))
            rd = R3._rng((x * 83492791) ^ (y * 2654435761) ^ 0xd47a)
            if rd() < rate:
                di = int(rd() * len(dp)) % len(dp)
                t = dp[di]
                rec["srf"] = "detail"
                rec["d"] = {"i": di, "t": path_ix(t.info["k"][1])}
        return t

    def wang_rec(gr, x, y, zl, rec):
        """MIRROR of render3.wang_surface(): THE TILE IS THE BOUNDARY."""
        quad = [(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)]
        gs = [g(*c) for c in quad]
        folded = False
        if gs.count(None) == 0 and "" not in gs and len(set(gs)) == 3:
            cnt = Counter(gs)
            keep = [t for t, _n in cnt.most_common(2)]
            odd = next(t for t in cnt if t not in keep)
            gs = [keep[0] if t == odd else t for t in gs]
            folded = True
        if None not in gs and "" not in gs and len(set(gs)) == 2 \
                and len({L(*c) for c in quad}) == 1 \
                and not any(q in liq for q in gs):
            a, b = sorted(set(gs))
            sa, sb = R3.side_roles(a, b)
            idx = (8 * (gs[0] == sb) + 4 * (gs[1] == sb)
                   + 2 * (gs[2] == sb) + 1 * (gs[3] == sb))
            if idx not in (0, 15):
                brec = {}
                ia = plate_rec(sa, x, y, brec, "a")
                ib = plate_rec(sb, x, y, brec, "b")
                # the cell's OWN half — what a port names as the art under the
                # composed tile
                own = "b" if gs[0] == sb else "a"
                rec["set"], rec["mi"], rec["p"] = (brec[own + "set"],
                                                   brec[own + "mi"],
                                                   brec[own + "p"])
                rec["srf"] = "boundary"
                rec["b"] = len(bnds)
                # HIS PAIR LAB MASK, per cell. Recorded because a Wang index
                # alone does not say which SHAPE the cell wears: render3 picks
                # from a spoke-direction pool, and a consumer drawing one global
                # default matches every index while drawing the wrong road.
                bnds.append({"x": x, "y": y, "i": idx, "a": sa, "b": sb,
                             "m": R3.mask_for(idx, x, y,
                                              not (sa in R3.MADE_GROUND
                                                   or sb in R3.MADE_GROUND)),
                             "folded": folded,
                             "pa": brec["ap"], "pb": brec["bp"],
                             "seta": brec["aset"], "mia": brec["ami"],
                             "setb": brec["bset"], "mib": brec["bmi"],
                             "sx": bx_of(x, y), "sy": col_y(x, y, L(x, y))})
                return R3.composed_boundary(sa, sb, idx, ia, ib, x, y)
        return surface_rec(gr, x, y, zl, rec)

    # 1) terrain — render3's own painter order (back to front in x+y).
    for s in range(x0 + y0, x1 + y1 - 1):
        for x in range(max(x0, s - y1 + 1), min(x1, s - y0 + 1)):
            y = s - x
            gr = g(x, y)
            if not gr:
                continue
            zl = L(x, y)
            rix, _rid = region_ix(gr, x, y)
            rec = {"x": x, "y": y, "g": gr, "z": zl, "r": rix,
                   "sx": bx_of(x, y), "sy": col_y(x, y, zl)}
            cells.append(rec)

            if gr in liq:
                # A LIQUID IS A GROUND WITH A SET TOO, top face only: a liquid
                # never shows a wall. surface(), never wang_surface().
                t = R3.top_face_only(surface_rec(gr, x, y, zl, rec))
                rec["top_only"] = True
                rec["py"], rec["ph"] = col_y(x, y, zl), t.height
                pred.append((t.width, t.height, bx_of(x, y), rec["py"], ident(t)))
                continue
            if zl == 0:
                t = wang_rec(gr, x, y, zl, rec)
                rec["py"], rec["ph"] = col_y(x, y, zl), t.height
                pred.append((t.width, t.height, bx_of(x, y), rec["py"], ident(t)))
                continue

            front_low = min(L(x + 1, y), L(x, y + 1))
            fx, fy = (x + 1, y) if L(x + 1, y) <= L(x, y + 1) else (x, y + 1)
            side = wall_over.get((x, y)) or (g(fx, fy) or gr)
            if (x, y) not in wall_over and (side in R3.INDOOR_GROUNDS or side in liq):
                side = gr
            # NO EXPOSED FACE, NO WALL: a raised cell whose down-screen
            # neighbours sit at its own level shows no cliff, and its x-over-x
            # tile painted a wall band onto flat ground — the row of ticks along
            # every plateau edge. Such a cell draws its surface and nothing else.
            exposed = front_low < zl
            if exposed:
                cap_t, cap_ix = R3.over_tile(gr, side), over_ident(gr, side)
                # the repeated course is the WALL's own material in every case
                mid_t, mid_ix = R3.storey_tile(side), storey_ident(side)
                st = []
                for f in range(max(0, front_low), zl + 1):
                    t = cap_t if f == zl else mid_t
                    ti = cap_ix if f == zl else mid_ix
                    yy = col_y(x, y, f) - TOP_Y
                    st.append([f, ti, yy])
                    pred.append((t.width, t.height, bx_of(x, y), yy, ident(t)))
                rec["w"] = {"side": side, "fl": front_low, "fx": fx, "fy": fy,
                            "over": (x, y) in wall_over, "capped": True,
                            "cap": cap_ix, "mid": mid_ix, "midg": side, "st": st}
            dressed = not exposed or not R3.own_top(
                R3.over_candidate(gr, side)["key"].strip("/"))
            # ...and the SURFACE goes on the cap: the wall is x-over-y art, the
            # top is the maintainer's set, top face only so the cap's own wall
            # survives.
            t = R3.top_face_only(wang_rec(gr, x, y, zl, rec))
            rec["top_only"] = True
            rec["dressed"] = dressed
            rec["py"], rec["ph"] = col_y(x, y, zl), t.height
            if dressed:
                pred.append((t.width, t.height, bx_of(x, y), rec["py"], ident(t)))

    # 2) decks.
    deck_recs = []
    for di, dk in enumerate(doc.get("decks", [])):
        dg = dk.get("ground") or "grey_stone"
        dl, th = int(dk["level"]), int(dk.get("thickness", 1))
        dcells = sorted(((c["x"], c["y"]) for c in dk["cells"]),
                        key=lambda c: (c[0] + c[1], c[1]))
        cellset = set(dcells)
        for (x, y) in dcells:
            if not (x0 <= x < x1 and y0 <= y < y1):
                continue
            fc = (x + 1, y) in cellset and (x, y + 1) in cellset
            lo = dl if fc else max(0, dl - max(1, th))
            body = "grey_stone" if (dk.get("kind") == "cave"
                                    and dg not in ("black_rock", "grey_stone")) else dg
            cap_t = R3.flat_tile(dg) if fc else R3.over_tile(dg, body)
            cap_ix = flat_ident(dg) if fc else over_ident(dg, body)
            mid_t, mid_ix = R3.storey_tile(body), storey_ident(body)
            st = []
            for f in range(lo, dl + 1):
                t = cap_t if f == dl else mid_t
                ti = cap_ix if f == dl else mid_ix
                yy = col_y(x, y, f) - TOP_Y
                st.append([f, ti, yy])
                pred.append((t.width, t.height, bx_of(x, y), yy, ident(t)))
            drec = {"d": di, "kind": dk.get("kind"), "ground": dg,
                    "lvl": dl, "th": th, "x": x, "y": y,
                    "front_covered": fc, "lo": lo, "body": body,
                    "cap": cap_ix, "mid": mid_ix, "sx": bx_of(x, y), "st": st}
            # A roof, a bridge and a cave lid are GROUND too: the slab top wears
            # the maintainer's base tile set, top face only.
            sim = plate_rec(dg, x, y, drec, "srf_")
            t = R3.top_face_only(sim)
            drec["srf_y"] = col_y(x, y, dl)
            pred.append((t.width, t.height, bx_of(x, y), drec["srf_y"], ident(t)))
            deck_recs.append(drec)

    # 3) scenery — sprite scaled to placement.world_px_height, feet on the
    #    cell's front vertex. round() here is Python's banker's rounding; a
    #    port that uses round-half-up drifts a pixel on exact .5 scales.
    roofed = {(c["x"], c["y"]) for dk in doc.get("decks", [])
              if dk.get("kind") in ("roof", "cave") for c in dk["cells"]}
    scen = []
    for p in sorted(doc.get("scenery", []), key=lambda p: p["x"] + p["y"]):
        px, py = p["x"], p["y"]
        if not (x0 <= px < x1 and y0 <= py < y1):
            continue
        if (int(px), int(py)) in roofed:
            continue
        meta = json.load(open(os.path.join(REPO, "scenery", p["piece"], "scenery.json")))
        spath = meta["sprite"]
        if p.get("lit"):
            litk = sorted(k for k in (meta.get("states") or {}) if k.startswith("LIT"))
            if litk:
                spath = meta["states"][litk[0]]["sprite"]
        sp = R3.Image.open(os.path.join(REPO, "scenery", spath)).convert("RGBA")
        want = meta.get("placement", {}).get("world_px_height") or sp.height
        bb = sp.getbbox()
        art = sp.crop(bb)
        k = want / art.height
        aw, ah = max(1, round(art.width * k)), max(1, round(art.height * k))
        sx = ox + (px - x0 - (py - y0)) * DX
        sy = oy + (px - x0 + py - y0) * DY - L(int(px), int(py)) * LP
        dest = (int(sx - aw / 2), int(sy - ah))
        scen.append({"piece": p["piece"], "x": px, "y": py,
                     "sprite": path_ix(os.path.join("scenery", spath)),
                     "want_h": want, "bbox": list(bb), "w": aw, "h": ah,
                     "hflip": bool(p.get("hflip")), "lit": bool(p.get("lit")),
                     "sx": dest[0], "sy": dest[1]})
        pred.append((aw, ah, dest[0], dest[1], None))

    # THE PROOF. Everything mirrored out of render()'s loops above is checked
    # against the draw stream render3 really emitted — same tile IDENTITY, same
    # order, same destination. Drift in a mirrored line fails here, not in the
    # game; and because the identity is the resolution and not the size, a fade
    # swapped for a detail (both 64x46) cannot slip through.
    got = list(draws)
    # Report the FIRST divergence, with its neighbours: "4862 against 4861" says
    # a line drifted and nothing about which.
    for i, (gt, pt) in enumerate(zip(got, pred)):
        if gt == pt:
            continue
        lo, hi = max(0, i - 2), i + 3
        raise AssertionError(
            f"{w['name']}: draw #{i} diverges.\n  render3 " +
            "\n          ".join(str(d) for d in got[lo:hi]) +
            "\n  fixture " + "\n          ".join(str(d) for d in pred[lo:hi]))
    assert len(got) == len(pred), \
        f"{w['name']}: render3 drew {len(got)} tiles, fixture predicts {len(pred)} " \
        f"(the streams agree up to #{min(len(got), len(pred))})"
    assert sum(1 for d in got if d[4] is None) == len(scen), \
        f"{w['name']}: {sum(1 for d in got if d[4] is None)} unidentifiable " \
        f"draws but {len(scen)} scenery pieces — a TERRAIN art source stopped " \
        f"being cached or tagged and its identity is no longer being compared"

    ordered = sorted(cells, key=lambda r: (r["y"], r["x"]))
    return {
        "name": w["name"], "why": w["why"],
        "x0": x0, "y0": y0, "x1": x1, "y1": y1,
        "origin": {"ox": ox, "oy": oy, "storey_pitch": LP,
                   "world_max_level": maxL, "canvas": [cap["fw"], cap["fh"]]},
        "region_ids": rids,
        "fade_pools": fade_pools,
        "cells": ordered,
        "boundaries": bnds,
        "decks": deck_recs,
        "scenery": scen,
        "draws": len(got),
        "cells_hash": _sha(ordered),
    }


def _sha(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":"))
                          .encode()).hexdigest()


# ------------------------------------------------------------ invariants ----
def invariants(doc):
    sil, top, wall = R3._plate_regions()
    masks = []
    for i in range(16):
        m = R3._mask(i)
        masks.append({"i": i, "true_px": int(m.sum()),
                      "sha256": hashlib.sha256(m.tobytes()).hexdigest()[:16]})
    sets = {}
    counts = {}
    for gname in doc["grounds"]:
        ss = R3.sets_for(gname)
        sets[gname] = [{"id": s["id"], "weight": s["weight"],
                        "members": [{"kind": m["kind"], "weight": m["weight"],
                                     **({"tile": path_ix(m["tile"])} if m.get("tile") else {})}
                                    for m in s["members"]]} for s in ss]
        counts[gname] = {str(s["id"]): len(s["members"]) for s in ss}
    dpools = {}
    for gname in doc["grounds"]:
        pool = R3.detail_pool(gname)
        if pool:
            dpools[gname] = [path_ix(im.info["k"][1]) for im in pool]
    # The slope library as the resolver must see it: only COMPLETE sets with at
    # least one approved tile, in dir order, plus which indices he approved.
    slopes = {}
    for gname, gsets in sorted(R3._SLOPE_BY_GROUND.items()):
        slopes[gname] = [{"dir": st["dir"],
                          "approved": [i for i in range(16)
                                       if R3._slope_approved(st["dir"], i)]}
                         for st in gsets]
    keys = ["", "a", "grass", "bts1|set|grass|r0", "bts1|tile|1|0|0",
            "bts1|set|grass|grass@15,14", "bts1|tile|1|380|344",
            "bts1|set|light_soil|light_soil@15,14", "bts1|tile|3|435|399",
            "slope|grass|15|14", "slope|grey_stone|14|13"]
    return {
        "constants": {
            "DX": R3.DX, "DY": R3.DY, "WALL": R3.WALL, "TILE": R3.TILE,
            "TOP_Y": R3.TOP_Y, "FADE_BAND": R3.FADE_BAND,
            "DETAIL_FREQ": R3.DETAIL_FREQ, "CLEAN_SET_ID": R3.CLEAN_SET_ID,
            "PLATE_H": 46,
            "storey_pitch": R3.storey_pitch(R3.over_tile("grey_stone", "grey_stone")),
            "storey_pitch_source":
                "tiles/pipeline/render.py wall_height(over_tile('grey_stone',"
                "'grey_stone')) — MEASURED from the tile's own silhouette. It "
                "is NOT WALL: 17 leaks a row of the floor below at every storey.",
            "REGION_CHUNK": 24,
            "region_rule": "region_at(x, y, ground) = f'{ground}@{x//24},{y//24}'"
                           " — a CHUNK, not a connected component. Components "
                           "made one set paint 98.7% of the_game's grass and "
                           "99.7% of its snow, so 19 of the 68 weighted sets "
                           "never appeared anywhere.",
            "INDOOR_GROUNDS": sorted(R3.INDOOR_GROUNDS),
            "SIDE_ORDER": R3.SIDE_ORDER,
            "fade_pct_window": [8, 55],
            "lcg": "seed & 0xffffffff, then s = (s*1664525 + 1013904223) & "
                   "0xffffffff, value = s / 2**32. Fade seed (x*73856093) ^ "
                   "(y*19349663), detail seed (x*83492791) ^ (y*2654435761) — "
                   "both exceed 32 bits before the mask.",
            "boundary_anchor_order": [[-1, -1], [0, -1], [-1, 0], [0, 0]],
            "boundary_index": "8*NW + 4*NE + 2*SW + 1*SE, bit set = side_b "
                              "(side_roles: the earlier ground in SIDE_ORDER "
                              "is side_a); 0 and 15 are not drawn",
        },
        "grounds": doc["grounds"],
        "liquids": sorted(set(doc.get("liquids", []))),
        "ground_palette": {gname: {
            "surface": R3.GT[gname].get("surface"),
            "top": R3.GT[gname]["palette"]["top"],
            "wall": R3.GT[gname]["palette"]["wall"]} for gname in doc["grounds"]},
        "plate_regions": {"silhouette_px": int(sil.sum()),
                          "top_face_px": int(top.sum()),
                          "wall_px": int(wall.sum()),
                          "shape": list(sil.shape)},
        "silhouette_opaque_px": int((R3._silhouette() > 0).sum()),
        "masks": {"pattern": R3.PATTERNS["selection"]["default_pattern"],
                  "frame": [R3.PATTERNS["masks"]["frame_w"],
                            R3.PATTERNS["masks"]["frame_h"]],
                  "per_index": masks},
        "base_tile_sets": sets,
        "member_counts": counts,
        "detail_pools": dpools,
        "detail_pool_reachable": None,   # filled from the windows, not asserted
        "detail_pool_note":
            "HIS 478 '#top' APPROVALS, which nothing had ever drawn. The art is "
            "the candidate's `textured` pass (the pair postprocess flattens "
            "every top to the clean colour, which is WHY he has never seen most "
            "of them) and it is CONFORMED, so a detail's foreign lava/ice/sand "
            "wall can never leak into a field. Rolled on every surface that is "
            "not a fade or a boundary, at DETAIL_FREQ.",
        "slope_sets": slopes,
        "slope_note":
            "tiles3/slopes@1 — a Wang set on ELEVATION (bit = that corner is "
            "RAISED), same 64x46 frame as a plate. ONLY COMPLETE SETS (9 of the "
            "225 ship fewer than 16 post files) and ONLY TILES HE HAS APPROVED "
            "(he has judged 15 of the 225 sets; picking across all 15 seeds per "
            "ground drew slopes he had never seen). The seed is picked per "
            "CHUNK, like a base set's region.",
        "fnv1a_vectors": [[s, R3.fnv1a(s)] for s in keys],
        "pick_weighted_vectors": [
            [w, u, R3.pick_weighted(w, u)] for w, u in (
                ([1, 1], 0), ([1, 1], 0.4999), ([1, 1], 0.5), ([0, 5], 0),
                ([0, 5], 0.999), ([3, 1], 0.74), ([3, 1], 0.76),
                ([0, 0], 0.5), ([], 0.5))],
        "lcg_vectors": [[s, R3._rng(s)()] for s in
                        (0, 1, 12345, (380 * 73856093) ^ (344 * 19349663),
                         (435 * 73856093) ^ (399 * 19349663))],
    }


def main():
    doc = json.load(open(os.path.join(REPO, WORLD_REL)))
    assert doc["schema"] == "pixel-maps3/world@1", doc["schema"]
    prewarm_flat(doc)
    inv = invariants(doc)
    wins = [build_window(doc, w) for w in WINDOWS]
    # THE SILENT-FLAT GATE, render3's own: a member that resolves to clean on a
    # miss is a fixture that certifies flat ground. Never emit one.
    assert not R3.PLATE_FALLBACK, dict(R3.PLATE_FALLBACK)
    out = {
        "schema": "pixel-games2/tiles3-parity@1",
        "generator": "games2/scripts/tiles3-fixture.py",
        "reference": "maps2/pipeline/render3.py",
        "format": FORMAT,
        "world": {"path": WORLD_REL, "schema": doc["schema"],
                  "size": doc["size"],
                  "sha256": hashlib.sha256(
                      open(os.path.join(REPO, WORLD_REL), "rb").read()).hexdigest()},
        "invariants": inv,
        "paths": PATHS,
        "tiles": TILES,
        "plates": PLATES,
        "windows": wins,
    }
    inv["detail_pool_reachable"] = any("d" in c for w in wins for c in w["cells"])
    out["hash"] = _sha([w["cells_hash"] for w in wins] +
                       [_sha(w["boundaries"]) for w in wins] +
                       [_sha(w["decks"]) for w in wins] +
                       [_sha(w["scenery"]) for w in wins] +
                       [_sha(TILES), _sha(PLATES), _sha(PATHS)])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"), sort_keys=False)
        f.write("\n")
    n = sum(len(w["cells"]) for w in wins)
    print(f"wrote {os.path.relpath(OUT, REPO)}  "
          f"{os.path.getsize(OUT)/1024:.0f} KB  {n} cells")
    for w in wins:
        c = w["cells"]
        print(f"  {w['name']:14} {len(c):5} cells  "
              f"{len(w['region_ids']):3} regions  "
              f"{len(w['boundaries']):4} boundaries  "
              f"{sum(1 for r in c if 'w' in r):4} wall cells  "
              f"{sum(1 for r in c if 'f' in r):4} fades  "
              f"{len(w['decks']):4} deck cells  "
              f"{len(w['scenery']):3} scenery  "
              f"{w['draws']} draws verified")
    print(f"  tables: {len(PATHS)} paths, {len(TILES)} tiles, {len(PLATES)} plates")
    print(f"  hash {out['hash']}")


if __name__ == "__main__":
    main()
