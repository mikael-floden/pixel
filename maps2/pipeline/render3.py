"""Tiles 3.0 world renderer — pixel-maps3/world@1 (the_game).

Draws by the tile system's OWN rules, resolved at draw time (the world stores
semantics only — see world3.py):

  * iso: tile_px 64, dx 32, DY=14 (GEOMETRY.md: the pitch at which the v3
    lattice closes; 15 leaks a 1px wall band per boundary), wall_px 17/level.
  * fields: ground_types.json — flat base_color until the maintainer promotes
    base tiles (live/tuning/base_tiles.json weighted groups). THE LAW: no
    texture the maintainer did not promote.
  * walls: THE X-OVER-Y MATRIX ONLY (tiles/review). A rim cell draws its
    over-tile (top ground OVER the ground at the face's foot — the cell's
    down-screen lower neighbour), then one same-over-same band per extra
    exposed level, 17px apart — the wiki isoScene stacking model.
  * boundaries: transition sets on the CORNER LATTICE (TRANSITIONS.md), one
    set per pair, composed through the lab's own compose_transition (surface
    taxonomy: own/base/flat), index = 8*NW+4*NE+2*SW+1*SE with bit = the
    UPPER material of the set. Pairs with no committed set fall back to the
    pair's flat colours through a borrowed mask set (grass__to__water's
    geometry) — the FADE, flagged in the build log for review.
  * details: top-approved tiles (live/feedback/tiles.json '#top') at
    DETAIL_FREQ per field cell. Pool is empty today; fills as he approves.
  * scenery: sprite scaled so height == placement.world_px_height, feet at
    the piece's (x,y) cell front vertex, hflip honoured, painter-ordered
    with the terrain.

    python maps2/pipeline/render3.py --cal    # 14x14 calibration scene
    python maps2/pipeline/render3.py          # full the_game overview
"""
from __future__ import annotations

import json
import os
import sys
from collections import Counter

import numpy as np
from PIL import Image

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
sys.path.insert(0, os.path.join(REPO, "tiles", "pipeline"))
import transition_render as TR          # the lab's own composer — reused, not copied
import render as TILE_RENDER            # tiles/pipeline/render.py — wall_height

DX, DY, WALL, TILE = 32, 14, 17, 64
TOP_Y = 10                              # review tiles: diamond apex row in the 64-box
FADES = json.load(open(os.path.join(REPO, "tiles", "fades", "index.json"))) \
    if os.path.isfile(os.path.join(REPO, "tiles", "fades", "index.json")) else {"pairs": {}}
FADE_BAND = 2                           # cells of fade band each side of a hard edge
DETAIL_FREQ = 1 / 48                    # a detail roughly once per 48 field cells
INDOOR_GROUNDS = {"parquet_floor", "brown_paving_stone", "grey_paving_stone"}
# a wall's side is the ground at its FOOT — but an indoor floor is never a
# wall's body: a stone wall whose foot stands on parquet is still stone

GT = json.load(open(os.path.join(REPO, "tiles", "ground_types.json")))["grounds"]
MAN = json.load(open(os.path.join(REPO, "tiles", "review", "manifest.json")))
FB = json.load(open(os.path.join(REPO, "live", "feedback", "tiles.json")))["entries"]
BASE = json.load(open(os.path.join(REPO, "live", "tuning", "base_tiles.json"))).get("overrides", {})
WALL_OV = json.load(open(os.path.join(REPO, "live", "tuning", "tile_walls.json"))).get("overrides", {})


def _hex(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _candidates(top, side):
    cell = MAN["cells"].get(f"{top}__over__{side}")
    if not cell:
        return []
    out = [c for c in cell["candidates"] if FB.get(c["key"], {}).get("status") == "approved"]
    return out + [c for c in cell["candidates"] if c not in out]


def approved_candidate(top, side, storey=False):
    """The wiki's own rule: the approved candidate, else rank 0. For a STOREY
    fill (the repeated wall below the cap), candidates the maintainer flagged
    `top_only` in live/tuning/tile_walls.json are skipped — vertical.py's
    doctrine: a top that repeats poorly vertically needs same-over-same backup."""
    cands = _candidates(top, side)
    if storey:
        rest = [c for c in cands if not WALL_OV.get(c["key"], {}).get("top_only")]
        cands = rest or cands
    return cands[0] if cands else None


_tile_cache = {}
_lp_cache = {}


def storey_pitch(im):
    """The stacking pitch, MEASURED from the tile (tiles/pipeline/render.py:
    wall_height). Assuming the doc's 17 leaks one row of the floor below at
    every storey — the tiles agent's own paid-for stripe bug."""
    key = id(im)
    if key not in _lp_cache:
        _lp_cache[key] = TILE_RENDER.wall_height(im) or 16
    return _lp_cache[key]


def over_tile(top, side):
    """The x-over-y tile image — THE ONLY WALL SOURCE. Falls back to
    same-over-same, then to a painted flat tile."""
    key = ("over", top, side)
    if key in _tile_cache:
        return _tile_cache[key]
    c = approved_candidate(top, side) or approved_candidate(top, top)
    assert c, f"no review cell for {top} over {side} (nor {top} over {top}) — " \
              f"the x-over-y matrix is the ONLY wall source and it has no tile"
    im = Image.open(os.path.join(REPO, c["file"])).convert("RGBA")
    _tile_cache[key] = im
    return im


def storey_tile(ground):
    """The repeated storey below a cap: same-over-same, honouring top_only."""
    key = ("storey", ground)
    if key not in _tile_cache:
        c = approved_candidate(ground, ground, storey=True)
        _tile_cache[key] = Image.open(os.path.join(REPO, c["file"])).convert("RGBA")
    return _tile_cache[key]


def wall_band(top, side):
    """The 17px wall strip of the over-tile — what a stacked storey repeats
    (vertical.py's band). Repeating the whole tile toothed every rim with the
    band's own diamond top; the band alone is what the lattice can hide."""
    key = ("band", top, side)
    if key in _tile_cache:
        return _tile_cache[key]
    t = over_tile(top, side)
    band = t.crop((0, TOP_Y + 2 * DY, TILE, min(t.height, TOP_Y + 2 * DY + WALL)))
    _tile_cache[key] = band
    return band


def flat_tile(ground):
    """A FIELD tile, by the law's ladder:

      liquids          -> a pure flat-colour diamond, NO wall — liquids never
                          show one;
      surface: base    -> the ground's own published base tile
                          (ground_types.json base_tiles — paving, parquet);
      live promotion   -> the maintainer's promoted base tile
                          (live/tuning/base_tiles.json; review candidate or
                          textured base_candidates entry);
      otherwise        -> the APPROVED same-over-same review tile: its top is
                          already flattened to the clean palette colour (the
                          flat field the law demands) and its wall is the real
                          x-over-x art — the only lawful wall source — for
                          wherever a rim exposes it.
    """
    key = ("flat", ground)
    if key in _tile_cache:
        return _tile_cache[key]
    g = GT.get(ground, {})
    if ground in ("water", "deep_water", "lava", "slime"):
        top = _hex(g.get("palette", {}).get("top", g.get("base_color", "#808080")))
        im = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
        px = im.load()
        for y in range(2 * DY):
            half = int(DX * (1 - abs(y - DY) / DY))
            for x in range(DX - half, DX + half):
                px[x, TOP_Y + y] = (*top, 255)
        _tile_cache[key] = im
        return im
    canon = g.get("base_tiles") or []
    if canon:
        im = Image.open(os.path.join(REPO, canon[0])).convert("RGBA")
        _tile_cache[key] = im
        return im
    promos = [k for k, v in BASE.items() if v.get("type") == ground]
    if promos:
        path = None
        for cell in MAN["cells"].values():
            for c in cell["candidates"]:
                if c["key"] == promos[0]:
                    path = c.get("before") or c["file"]
        if path is None:
            idxp = os.path.join(REPO, "tiles", "base_candidates", ground, "index.json")
            if os.path.isfile(idxp):
                for c in json.load(open(idxp))["candidates"]:
                    if c["id"] == promos[0] or c["file"].endswith(promos[0] + ".webp"):
                        path = c["file"]
        if path:
            im = Image.open(os.path.join(REPO, path)).convert("RGBA")
            _tile_cache[key] = im
            return im
    c = approved_candidate(ground, ground)
    assert c, f"no same-over-same review cell for {ground}"
    im = Image.open(os.path.join(REPO, c["file"])).convert("RGBA")
    _tile_cache[key] = im
    return im


# -- transitions ---------------------------------------------------------------

_set_cache = {}


def pair_set(a, b):
    """The composed 16-tile set for an unordered pair, via the lab's own
    compose_transition (surface taxonomy from ground_types). Returns
    (tiles16, upper) where bit=1 in the Wang index means `upper`; None when no
    committed set exists for the pair."""
    key = frozenset((a, b))
    if key in _set_cache:
        return _set_cache[key]
    root = os.path.join(REPO, "tiles", "transitions")
    d = None
    for x, y in ((a, b), (b, a)):
        p = os.path.join(root, f"{x}__to__{y}")
        if os.path.isdir(p):
            d = p
            break
    out = None
    if d:
        sets = sorted(s for s in os.listdir(d) if os.path.isdir(os.path.join(d, s, "post")))
        if sets:
            pick = sets[0]                # amplitude-then-seed — the wiki's order
            base = os.path.join(d, pick)
            tiles = [Image.open(os.path.join(base, "post", f"tile_{i:02d}.webp")).convert("RGBA")
                     for i in range(16)]
            # POLARITY IS MEASURED, never read from meta: 6 of 15 dark_mud
            # sets carry the opposite material at index 0 than meta claims
            # (transition_post.py). Classify tile 15's mean colour against the
            # two grounds' palettes — bit=1 means tile 15's material.
            na, nb = os.path.basename(d).split("__to__")
            import numpy as _np
            m15 = _np.array(tiles[15].convert("RGB"), float)[:2 * DY + 8].mean((0, 1))
            ca = _np.array(_hex(GT[na]["palette"]["top"]), float)
            cb = _np.array(_hex(GT[nb]["palette"]["top"]), float)
            upper = na if ((m15 - ca) ** 2).sum() <= ((m15 - cb) ** 2).sum() else nb
            out = (tiles, upper)
    _set_cache[key] = out
    return out


def detail_pool(ground):
    """Top-approved detail tiles for a ground (live/feedback '#top' approvals,
    raw pass — the flattening is why he had never seen them). Empty today."""
    key = ("details", ground)
    if key in _set_cache:
        return _set_cache[key]
    out = []
    for ck, cell in MAN["cells"].items():
        if cell["top"] != ground:
            continue
        for c in cell["candidates"]:
            if FB.get(c["key"] + "#top", {}).get("status") == "approved":
                out.append(Image.open(os.path.join(REPO, c.get("before") or c["file"])).convert("RGBA"))
    _set_cache[key] = out
    return out


def fade_pool(field_ground, other):
    """The REAL fade product (tiles/fades, tiles3/fade-tiles@1): top-only mix
    tiles placed BY EDGE_GROUND — the ground the tile's rim belongs to — never
    by area majority (maintainer ruling 2026-08-28: big rocks ON an ice sheet).
    Returns [(file, other_pct)] usable inside a `field_ground` field next to
    `other`, sorted by how much of the other ground shows."""
    key = ("fadepool", field_ground, other)
    if key in _set_cache:
        return _set_cache[key]
    out = []
    for pk in (f"{field_ground}__to__{other}", f"{other}__to__{field_ground}"):
        for t in FADES.get("pairs", {}).get(pk, []):
            if t.get("edge_ground") != field_ground:
                continue
            pct = t.get("pct", {}).get(other, 0)
            # honest mixes only: a ~0% tile is the source set's own idea of a
            # pure field (a lime square on our grass), a >60% one reads as the
            # other ground with a rim — the maintainer's never-50/50 rule
            if not (8 <= pct <= 55):
                continue
            # palette sanity: the tile's own mean must sit near the pct-blend
            # of the two grounds' palette tops — one mis-corrected set ships a
            # lime square onto our dark meadow otherwise
            try:
                imt = Image.open(os.path.join(REPO, t["file"])).convert("RGBA")
            except FileNotFoundError:
                continue
            import numpy as _np
            arr = _np.array(imt, float)
            m = arr[..., 3] > 0
            if not m.any():
                continue
            ca = _np.array(_hex(GT[field_ground]["palette"]["top"]), float)
            cb = _np.array(_hex(GT[other]["palette"]["top"]), float)
            # a fade tile's WALL is explicitly meaningless (index law) — crop
            # to the top diamond so a flat field never grows a stray wall
            arr = arr[:TOP_Y + 2 * DY + 2]
            m = arr[..., 3] > 0
            if not m.any():
                continue
            px3 = arr[..., :3][m]
            # alien-palette guard, tuned to kill wrong-green sets but keep the
            # soil sets' honest shading range
            da = _np.abs(px3 - ca).max(1)
            db = _np.abs(px3 - cb).max(1)
            near_d = _np.minimum(da, db)
            if _np.percentile(near_d, 80) > 78:
                continue
            out.append((t["file"], pct))
    out.sort(key=lambda r: r[1])
    _set_cache[key] = out
    return out


# -- the painter ---------------------------------------------------------------

def _rng(seed):
    s = seed & 0xffffffff
    def r():
        nonlocal s
        s = (s * 1664525 + 1013904223) & 0xffffffff
        return s / 2 ** 32
    return r


def render(doc, x0=0, y0=0, x1=None, y1=None, scale=1.0, log=print):
    W, H = doc["size"]["w"], doc["size"]["h"]
    x1 = W if x1 is None else x1
    y1 = H if y1 is None else y1
    G = doc["grounds"]
    grd = doc["ground"]
    lvl = doc["level"]
    liq = set(doc.get("liquids", []))

    def g(x, y):
        if not (x0 <= x < x1 and y0 <= y < y1):
            return None
        i = grd[y][x]
        return G[i] if i >= 0 else None

    def L(x, y):
        return lvl[y][x] if (0 <= x < W and 0 <= y < H) else 0

    maxL = max(max(r) for r in lvl)
    ox = (y1 - 1 - y0) * DX + 8
    oy = maxL * 17 + 24
    fw = (x1 - x0 + y1 - y0) * DX + 16
    fh = (x1 - x0 + y1 - y0) * DY + maxL * WALL + 120
    img = Image.new("RGBA", (fw, fh), (26, 28, 33, 255))
    fades = Counter()

    def cellpos(x, y, z):
        return (ox + (x - x0 - (y - y0)) * DX - DX,
                oy + (x - x0 + y - y0) * DY - z * WALL - DY)

    # painter order over cells — THE TILES AGENT'S OWN MODEL (pipeline/
    # render.py plateau): whole tiles, back to front in (x+y) then storey,
    # stacking pitch MEASURED per tile (wall_height; 17 leaks a stripe of the
    # floor below at every storey — their paid-for bug), the same-over-same
    # tile as `middle` for every storey below the cap.
    LP = storey_pitch(over_tile("grey_stone", "grey_stone"))

    def col_y(x, y, f):
        return oy + (x - x0 + y - y0) * DY - f * LP

    for s in range(x0 + y0, x1 + y1 - 1):
        for x in range(max(x0, s - y1 + 1), min(x1, s - y0 + 1)):
            y = s - x
            gr = g(x, y)
            if not gr:
                continue
            zl = L(x, y)
            bx = ox + (x - x0 - (y - y0)) * DX - DX
            if zl == 0 or gr in liq:
                t = flat_tile(gr)
                if gr not in liq:
                    # FADE BAND: within FADE_BAND cells of a different SOLID
                    # ground at the same level, ease the change with the fades
                    # product (top-only, placed by edge_ground). Deterministic.
                    near = None
                    for r in range(1, FADE_BAND + 1):
                        for dx2, dy2 in ((r, 0), (-r, 0), (0, r), (0, -r)):
                            og = g(x + dx2, y + dy2)
                            if og and og != gr and og not in liq \
                                    and L(x + dx2, y + dy2) == zl:
                                near = (og, r)
                                break
                        if near:
                            break
                    if near:
                        pool = fade_pool(gr, near[0])
                        if pool:
                            rr = _rng((x * 73856093) ^ (y * 19349663))
                            # nearer the edge -> stronger mix; jittered pick
                            hi = len(pool) - 1
                            band_pos = (FADE_BAND + 1 - near[1]) / (FADE_BAND + 1)
                            idx = min(hi, int((band_pos * 0.55 + rr() * 0.3 - 0.15) * hi))
                            f = Image.open(os.path.join(REPO, pool[max(0, idx)][0])).convert("RGBA")
                            f = f.crop((0, 0, f.width, min(f.height, TOP_Y + 2 * DY + 2)))
                            t = f
                    # DETAILS: a top-approved tile once in a while (pool is
                    # empty until the maintainer approves — then it just works)
                    if t is flat_tile(gr):
                        dp = detail_pool(gr)
                        if dp and _rng((x * 83492791) ^ (y * 2654435761))() < DETAIL_FREQ:
                            t = dp[int(_rng(x * 31 + y)() * len(dp)) % len(dp)]
                img.alpha_composite(t, (bx, col_y(x, y, zl) - TOP_Y))
                continue
            front_low = min(L(x + 1, y), L(x, y + 1))
            fx, fy = (x + 1, y) if L(x + 1, y) <= L(x, y + 1) else (x, y + 1)
            side = g(fx, fy) or gr
            if side in INDOOR_GROUNDS or side in liq:
                side = gr                    # stone over its own body; water is
                                             # never a wall material either
            cap = over_tile(gr, side) if front_low < zl else flat_tile(gr)
            mid = storey_tile(gr)
            for f in range(max(0, front_low), zl + 1):
                t = cap if f == zl else mid
                img.alpha_composite(t, (bx, col_y(x, y, f) - TOP_Y))

    # 2) transitions on the corner lattice, over the flats: a drawn tile at
    #    corner (x,y) blends cells (x,y),(x+1,y),(x,y+1),(x+1,y+1) when all
    #    four share a level and exactly two grounds
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
            ps = pair_set(a, b)
            if ps is None:
                fades[(a, b)] += 1        # hard edge today; the log is the
                continue                  # transition-set shopping list
            tiles, upper = ps
            idx = (8 * (gs[0] == upper) + 4 * (gs[1] == upper)
                   + 2 * (gs[2] == upper) + 1 * (gs[3] == upper))
            if idx in (0, 15):
                continue
            z = L(x, y)
            cx = ox + (x - x0 - (y - y0)) * DX - DX
            cy = col_y(x, y, z) - DY
            # apex (32,0) of the transition tile sits on corner (x+1,y+1)'s
            # top vertex = the shared corner of the quad
            img.alpha_composite(tiles[idx], (cx + DX - DX, cy + DY + TOP_Y - TOP_Y + 2 * DY - DY))
    if fades:
        log("FADE fallback used (no committed set): " +
            ", ".join(f"{a}~{b} x{n}" for (a, b), n in fades.most_common()))

    # 2b) DECKS — roofs, bridges and the cave lid: a slab whose top rides at
    #     its own level with same-over-same wall bands down to its underside.
    #     Drawn after terrain (higher, so painter order within a diagonal is
    #     safe) and before scenery.
    for dk in doc.get("decks", []):
        dg = dk.get("ground") or "grey_stone"
        dl, th = int(dk["level"]), int(dk.get("thickness", 1))
        cells = sorted(((c["x"], c["y"]) for c in dk["cells"]),
                       key=lambda c: (c[0] + c[1], c[1]))
        cellset = {(c[0], c[1]) for c in cells}
        for (x, y) in cells:
            if not (x0 <= x < x1 and y0 <= y < y1):
                continue
            front_covered = (x + 1, y) in cellset and (x, y + 1) in cellset
            lo = dl if front_covered else max(0, dl - max(1, th))
            bx = ox + (x - x0 - (y - y0)) * DX - DX
            cap = flat_tile(dg) if front_covered else over_tile(dg, dg)
            mid = storey_tile(dg)
            for f in range(lo, dl + 1):
                t = cap if f == dl else mid
                img.alpha_composite(t, (bx, col_y(x, y, f) - TOP_Y))

    # 3) scenery, painter-ordered with terrain already flat-composited.
    #    A piece under a roof/cave deck is indoors — invisible from out here,
    #    and drawing it put a bush on the meadow house's roof.
    roofed = {(c["x"], c["y"]) for dk in doc.get("decks", [])
              if dk.get("kind") in ("roof", "cave") for c in dk["cells"]}
    pieces = sorted(doc.get("scenery", []), key=lambda p: p["x"] + p["y"])
    for p in pieces:
        px, py = p["x"], p["y"]
        if not (x0 <= px < x1 and y0 <= py < y1):
            continue
        if (int(px), int(py)) in roofed:
            continue
        meta = json.load(open(os.path.join(REPO, "scenery", p["piece"], "scenery.json")))
        sp = Image.open(os.path.join(REPO, "scenery",
                                     meta["sprite"].split("/", 0)[0] if False else meta["sprite"])).convert("RGBA")
        want = meta.get("placement", {}).get("world_px_height") or sp.height
        bb = sp.getbbox()
        art = sp.crop(bb)
        k = want / art.height
        art = art.resize((max(1, round(art.width * k)), max(1, round(art.height * k))), Image.NEAREST)
        if p.get("hflip"):
            art = art.transpose(Image.FLIP_LEFT_RIGHT)
        z = L(int(px), int(py))
        sx = ox + (px - x0 - (py - y0)) * DX
        sy = oy + (px - x0 + py - y0) * DY - z * LP
        img.alpha_composite(art, (int(sx - art.width / 2), int(sy - art.height)))

    if scale != 1:
        img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    return img


def main():
    doc = json.load(open(os.path.join(MAPS2, "worlds3", "the_game", "world.json")))
    if "--cal" in sys.argv:
        img = render(doc, 190, 108, 216, 134)
        out = os.path.join(MAPS2, "worlds3", "the_game", "cal.webp")
    else:
        img = render(doc, scale=0.5)
        out = os.path.join(MAPS2, "worlds3", "the_game", "overview.webp")
    img.convert("RGB").save(out, lossless=True, method=4, exact=True)
    print("wrote", out, img.size)


if __name__ == "__main__":
    main()
