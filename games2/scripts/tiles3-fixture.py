#!/usr/bin/env python3
"""Emit the tiles3 PARITY FIXTURE: what render3.py draws, cell for cell.

  python3 games2/scripts/tiles3-fixture.py
  -> games2/server/test/fixtures/tiles3-parity.json

maps2/pipeline/render3.py IS the spec for pixel-maps3/world@1, so this script
IMPORTS it and records what its own functions return — it never re-derives a
resolution. Every art identity here comes back from render3 itself:

  * regions / ox / oy / LP / maxL      captured out of render()'s frame while
                                       render() actually runs (sys.settrace,
                                       return event). They are locals with no
                                       accessor; reading the frame tracks the
                                       reference, a re-implementation would
                                       drift silently.
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

What CANNOT be imported is the control flow inside render()'s loops (the fade
band, the wall side rule, the corner lattice, the deck stack): it is inline,
not callable. That part is mirrored here — and then PROVEN equal, because
Image.alpha_composite is wrapped during the real render and every (size, dest)
this script predicts is compared against the draw stream render3 actually
emitted. A mirrored line that drifts fails the run; it cannot reach the file.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

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
        name="diag_corners",
        x0=342, y0=405, x1=356, y1=419,
        why="The only place in the 262,144-cell world where the two DIAGONAL "
            "lattice indices meet: 9 (NW+SE) at (347,410) and (350,412), 6 "
            "(NE+SW) at (347,413). 6 anchors world-wide carry them; without "
            "this 14x14 patch the fixture would leave 2 of 16 indices untested.",
    ),
]

# The reader's map. Every index below is into a table, never a repeated string:
# a parity fixture is read by a unit test, so it stays small enough to commit.
FORMAT = {
    "tables": "paths[] holds every repo-relative file. tiles[] and plates[] "
              "hold art identities; a cell/boundary/deck refers to them by "
              "index. plates[] indices are per-fixture, not per-ground.",
    "window": "One render3.render(doc, x0, y0, x1, y1) call. REGIONS ARE "
              "WINDOW-LOCAL: the flood fill runs inside [x0,x1)x[y0,y1) and "
              "g() returns None outside it, so a port must pass the same "
              "window or region ids differ. origin.ox/oy/storey_pitch are the "
              "values render3 derived; world_max_level is over the WHOLE doc "
              "(oy = world_max_level*WALL + 24), not the window.",
    "cell": {
        "x,y,g,z": "cell, ground name, level",
        "r": "index into this window's region_ids[]",
        "sx,sy": "screen origin of the cell's column: sx = ox + (x-x0-(y-y0))"
                 "*DX - DX, sy = oy + (x-x0+y-y0)*DY - z*storey_pitch",
        "set,mi": "pick_set().id and the pick_member() INDEX into that set's "
                  "members[]. Look the set up BY ID in invariants."
                  "base_tile_sets[g] — ids are sorted but not contiguous. "
                  "mi = -1 is pick_member's sentinel clean (no weighted "
                  "member). Absent on a liquid and on a walled cell: neither "
                  "goes through plate_img.",
        "p": "index into plates[] — what plate_img() actually returned",
        "t": "index into tiles[] — a liquid's flat_tile()",
        "py,ph": "paste y and height of the field tile: py = sy - (0 if the "
                 "tile is a 46px plate else TOP_Y)",
        "f": "the fade: o = the other ground found in the band, d = its ring "
             "distance, pool = key into this window's fade_pools, i = index "
             "into that pool, u = the LCG's first draw, t = paths[] index",
        "d": "the detail — never present, see invariants.detail_pool_note",
        "b": "the four corner-lattice anchors touching this cell, in order "
             "(x-1,y-1), (x,y-1), (x-1,y), (x,y); each an index into this "
             "window's boundaries[] or null when nothing is drawn there",
        "w": "the wall column: side = the ground the face is drawn OVER, fl = "
             "front_low, fx/fy = the down-screen neighbour it came from, over "
             "= the cell is in a walls[] group, capped = a face is exposed, "
             "cap/mid = tiles[] indices, st = the stack bottom-to-top as "
             "[storey, tiles[] index, paste y]",
    },
    "boundary": "x,y = the anchor corner; i = the Wang index; a,b = side_a / "
                "side_b by SIDE_ORDER; pa,pb = plates[] indices for each side; "
                "seta/mia and setb/mib the set+member behind them; sx,sy the "
                "paste. THE TRAP: both sides are resolved at the ANCHOR "
                "cell's region and the ANCHOR's x,y — so the side that is not "
                "the anchor's own ground gets a set picked from a region it "
                "does not belong to, and neither plate need match the plate "
                "the blended cells drew.",
    "deck": "one drawn deck cell: d = index into world.decks, lo..lvl is the "
            "storey range, cap/mid = tiles[] indices, st as for a wall.",
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
    c = R3.approved_candidate(top, side) or R3.approved_candidate(top, top)
    im = R3.over_tile(top, side)
    TILE_IX[key] = len(TILES)
    TILES.append({"role": "over", "top": top, "side": side, "key": c["key"],
                  "path": path_ix(c["file"]), "w": im.width, "h": im.height})
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
_DRAWS: list[tuple] = []
_real_ac = PIL.Image.Image.alpha_composite


def _watch_ac(self, im, dest=(0, 0), source=(0, 0)):
    _DRAWS.append((im.width, im.height, int(dest[0]), int(dest[1])))
    return _real_ac(self, im, dest, source)


def trace_render(doc, w):
    """Run render3.render() on the window, capturing (a) the locals it derives
    — regions/ox/oy/LP/maxL — and (b) every alpha_composite it emits."""
    want = ("regions", "ox", "oy", "LP", "maxL", "fw", "fh", "wall_over")
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
    regions, ox, oy, LP, maxL = (cap["regions"], cap["ox"], cap["oy"],
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

    def region_ix(x, y):
        r = R3.region_of(x, y, regions)
        if r not in rid_ix:
            rid_ix[r] = len(rids)
            rids.append(r)
        return rid_ix[r], r

    fade_pools: dict[str, list] = {}
    pred: list[tuple] = []                    # predicted (w,h,dx,dy) draw stream
    cells: dict[tuple, dict] = {}

    # 1) terrain — render3's own painter order (back to front in x+y).
    for s in range(x0 + y0, x1 + y1 - 1):
        for x in range(max(x0, s - y1 + 1), min(x1, s - y0 + 1)):
            y = s - x
            gr = g(x, y)
            if not gr:
                continue
            zl = L(x, y)
            rix, rid = region_ix(x, y)
            rec = {"x": x, "y": y, "g": gr, "z": zl, "r": rix,
                   "sx": bx_of(x, y), "sy": col_y(x, y, zl)}
            cells[(x, y)] = rec
            if zl == 0 or gr in liq:
                if gr in liq:
                    t = R3.flat_tile(gr)
                    rec["t"] = flat_ident(gr)
                else:
                    chosen = pick_set(gr, rid)
                    mi, _m = pick_member_ix(chosen, x, y)
                    pix, t = plate_ident(gr, rid, x, y)
                    rec["set"], rec["mi"], rec["p"] = chosen["id"], mi, pix
                if gr not in liq:
                    near = None
                    for r in range(2, R3.FADE_BAND + 1):
                        for dx2, dy2 in ((r, 0), (-r, 0), (0, r), (0, -r)):
                            og = g(x + dx2, y + dy2)
                            if og and og != gr and og not in liq \
                                    and L(x + dx2, y + dy2) == zl:
                                near = (og, r)
                                break
                        if near:
                            break
                    if near:
                        pool = R3.fade_pool(gr, near[0])
                        if pool:
                            pk = f"{gr}|{near[0]}"
                            if pk not in fade_pools:
                                fade_pools[pk] = [[path_ix(f), pct] for f, pct in pool]
                            rr = R3._rng((x * 73856093) ^ (y * 19349663))
                            hi = len(pool) - 1
                            band_pos = (R3.FADE_BAND + 1 - near[1]) / (R3.FADE_BAND + 1)
                            u = rr()
                            idx = max(0, min(hi, int((band_pos * 0.55 + u * 0.3 - 0.15) * hi)))
                            t = R3.Image.open(os.path.join(REPO, pool[idx][0])).convert("RGBA")
                            t = t.crop((0, 0, t.width,
                                        min(t.height, TOP_Y + 2 * DY + 2)))
                            rec["f"] = {"o": near[0], "d": near[1], "pool": pk,
                                        "i": idx, "u": round(u, 12),
                                        "t": path_ix(pool[idx][0])}
                    if t is R3.flat_tile(gr):
                        # DEAD SINCE plate_img LANDED (2026-08-29): a field cell
                        # is drawn from a plate or a fade, never from flat_tile,
                        # so this identity check is never true and no detail is
                        # ever placed. Mirrored anyway — if the renderer ever
                        # feeds flat tiles back in, the fixture picks details up
                        # with no edit here.
                        dp, dpaths = _traced(R3.detail_pool, gr)
                        if dp and R3._rng((x * 83492791) ^ (y * 2654435761))() < R3.DETAIL_FREQ:
                            di = int(R3._rng(x * 31 + y)() * len(dp)) % len(dp)
                            t = dp[di]
                            rec["d"] = {"pool": gr, "i": di,
                                        "t": path_ix(dpaths[di]) if dpaths else None}
                # the field paste: a 46px plate sits ON the cell's top vertex,
                # anything 64-tall (liquid diamond, fade crop) hangs from TOP_Y
                off = 0 if (gr not in liq and t.height == 46) else TOP_Y
                rec["py"], rec["ph"] = col_y(x, y, zl) - off, t.height
                pred.append((t.width, t.height, bx_of(x, y), rec["py"]))
                continue
            front_low = min(L(x + 1, y), L(x, y + 1))
            fx, fy = (x + 1, y) if L(x + 1, y) <= L(x, y + 1) else (x, y + 1)
            side = wall_over.get((x, y)) or (g(fx, fy) or gr)
            if (x, y) not in wall_over and (side in R3.INDOOR_GROUNDS or side in liq):
                side = gr
            capped = front_low < zl
            cap_t = R3.over_tile(gr, side) if capped else R3.flat_tile(gr)
            cap_ix = over_ident(gr, side) if capped else flat_ident(gr)
            mid_g = side if (x, y) in wall_over else gr
            mid_t, mid_ix = R3.storey_tile(mid_g), storey_ident(mid_g)
            st = []
            for f in range(max(0, front_low), zl + 1):
                t = cap_t if f == zl else mid_t
                ti = cap_ix if f == zl else mid_ix
                yy = col_y(x, y, f) - TOP_Y
                st.append([f, ti, yy])
                pred.append((t.width, t.height, bx_of(x, y), yy))
            rec["w"] = {"side": side, "fl": front_low, "fx": fx, "fy": fy,
                        "over": (x, y) in wall_over, "capped": capped,
                        "cap": cap_ix, "mid": mid_ix, "midg": mid_g, "st": st}

    # 2) the corner lattice, over the flats.
    bnds: list[dict] = []
    at_anchor: dict[tuple, int] = {}
    for s in range(x0 + y0, x1 + y1 - 2):
        for x in range(max(x0, s - y1 + 2), min(x1 - 1, s - y0 + 1)):
            y = s - x
            quad = [(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)]
            gs = [g(*c) for c in quad]
            if None in gs or len(set(gs)) != 2:
                continue
            if len({L(*c) for c in quad}) != 1:
                continue
            a, b = sorted(set(gs))
            sa, sb = R3.side_roles(a, b)
            idx = (8 * (gs[0] == sb) + 4 * (gs[1] == sb)
                   + 2 * (gs[2] == sb) + 1 * (gs[3] == sb))
            if idx in (0, 15):
                continue
            _rix, rid = region_ix(x, y)
            pa, ia = plate_ident(sa, rid, x, y)
            pb, ib = plate_ident(sb, rid, x, y)
            ca = pick_set(sa, rid)
            cb = pick_set(sb, rid)
            z = L(x, y)
            dx_, dy_ = bx_of(x, y), col_y(x, y, z)
            at_anchor[(x, y)] = len(bnds)
            bnds.append({"x": x, "y": y, "i": idx, "a": sa, "b": sb,
                         "pa": pa, "pb": pb,
                         "seta": ca["id"], "mia": pick_member_ix(ca, x, y)[0],
                         "setb": cb["id"], "mib": pick_member_ix(cb, x, y)[0],
                         "sx": dx_, "sy": dy_})
            pred.append((ia.width, ia.height, dx_, dy_))
    for (x, y), rec in cells.items():
        ref = [at_anchor.get((x - 1, y - 1)), at_anchor.get((x, y - 1)),
               at_anchor.get((x - 1, y)), at_anchor.get((x, y))]
        if any(v is not None for v in ref):
            rec["b"] = ref

    # 3) decks.
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
                pred.append((t.width, t.height, bx_of(x, y), yy))
            deck_recs.append({"d": di, "kind": dk.get("kind"), "ground": dg,
                              "lvl": dl, "th": th, "x": x, "y": y,
                              "front_covered": fc, "lo": lo, "body": body,
                              "cap": cap_ix, "mid": mid_ix, "sx": bx_of(x, y),
                              "st": st})

    # 4) scenery — sprite scaled to placement.world_px_height, feet on the
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
        pred.append((aw, ah, dest[0], dest[1]))

    # THE PROOF. Everything mirrored out of render()'s loops above is checked
    # against the draw stream render3 really emitted — same tiles, same order,
    # same destinations. Drift in a mirrored line fails here, not in the game.
    got = list(draws)
    assert len(got) == len(pred), \
        f"{w['name']}: render3 drew {len(got)} tiles, fixture predicts {len(pred)}"
    for i, (gt, pt) in enumerate(zip(got, pred)):
        assert gt == pt, f"{w['name']}: draw #{i} render3={gt} fixture={pt}"

    ordered = sorted(cells.values(), key=lambda r: (r["y"], r["x"]))
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
        _pool, paths = _traced(R3.detail_pool, gname)
        if paths:
            dpools[gname] = [path_ix(p) for p in paths]
    keys = ["", "a", "grass", "bts1|set|grass|r0", "bts1|tile|1|0|0",
            "bts1|set|grass|grass@380,344", "bts1|tile|1|380|344",
            "bts1|set|light_soil|light_soil@383,352", "bts1|tile|3|435|399"]
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
            "render3 places a detail only when the field tile IS flat_tile(g); "
            "since plate_img took over the field, it never is. The pools are "
            "listed so a port can verify detail_pool() itself, but no cell "
            "record carries a detail today.",
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
