"""Tiles 3.0 world renderer — pixel-maps3/world@1 (the_game).

Draws by the tile system's OWN rules, resolved at draw time (the world stores
semantics only — see world3.py):

  * iso: tile_px 64, dx 32, DY=14 (GEOMETRY.md: the pitch at which the v3
    lattice closes; 15 leaks a 1px wall band per boundary), wall_px 17/level.
  * fields: THE MAINTAINER'S BASE TILE SETS (live/tuning/base_tile_sets.json)
    on EVERY cell — land, liquid, deck and raised alike. A SET per region (a
    24-cell chunk of one ground), a MEMBER per cell, his weights throughout,
    clean as a member. A member draws ITS OWN ART: the published `textured`
    pass for a review key, the file itself for a tops/base_candidates path,
    conformed into plate geometry. NEVER tiles/plates/<g>/<key8>.webp — that
    is the same tile flattened to the clean colour, and reading it painted
    236 of his 340 members flat. (live/tuning/base_tiles.json is the
    superseded one-tile-per-ground channel and is empty.)
  * walls: THE X-OVER-Y MATRIX ONLY (tiles/review). A rim cell draws its
    over-tile (top ground OVER the ground at the face's foot — the cell's
    down-screen lower neighbour), then one same-over-same band per extra
    exposed level, 17px apart — the wiki isoScene stacking model.
  * boundaries: patterns x plates on the CORNER LATTICE — tiles/patterns
    publishes the material-independent Wang boundary and nothing else, and
    the two grounds it divides come from their own set members, so EVERY
    pair is covered including roads (light_soil over grass, the second most
    common boundary on the_game). index = 8*NW+4*NE+2*SW+1*SE; each half
    asks for its OWN ground's region.
  * fades: tiles/fades (tiles3/fade-tiles@1) — top-only mix tiles that warm
    the player up for a ground change before the switch. Placed BY
    edge_ground, never by area majority; rejected tiles are not candidates
    and his ratings weight the rest; a SCATTERED event over a real Chebyshev
    distance band, never a coat of one tile.
  * details: HIS 478 '#top' APPROVALS. The wiki's roof glyph is "rating the
    TOP as a once-in-a-while ground detail", and a tile rejected AS A PAIR
    can still be a top-approved detail — the two reviews are independent.
    Drawn at DETAIL_FREQ from the `textured` pass and conformed, so a
    detail's foreign lava/ice/sand wall can never leak into a field.
  * slopes: tiles3/slopes@1 — a Wang set on ELEVATION (bit = that corner is
    raised) in the same 64x46 frame as a plate. A cell takes the graded tile
    when its OWN ground rises beside it. Every published set is a 4px
    sub-storey grade: it softens the foot of a rise, it cannot bridge a 17px
    storey (storey-height sets requested from tiles).
  * toggles: live/tuning/tile_walls.json `top_only` (this tile's wall is
    unusable) PAIRED WITH live/tuning/top_walls.json `wall` (the wall it
    borrows instead), and live/tuning/tile_tops.json `own_top` (keep the
    x-over-y tile's own top; do not paint the set surface over it).
  * scenery: sprite scaled so height == placement.world_px_height, feet at
    the piece's (x,y) cell front vertex, hflip honoured, painter-ordered
    with the terrain.

    python maps2/pipeline/render3.py --cal    # 14x14 calibration scene
    python maps2/pipeline/render3.py          # full the_game overview
"""
from __future__ import annotations

import json
import os
import re
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
import transition_patterns as TPAT      # .plate() — the ONLY lawful conformer

DX, DY, WALL, TILE = 32, 14, 17, 64
TOP_Y = 10                              # review tiles: diamond apex row in the 64-box
PATTERNS = json.load(open(os.path.join(REPO, "tiles", "patterns", "index.json")))
PLATES = json.load(open(os.path.join(REPO, "tiles", "plates", "index.json")))
_SIL = None
_MASKS = None


def _silhouette():
    global _SIL
    if _SIL is None:
        _SIL = np.array(Image.open(os.path.join(REPO,
                        PATTERNS["silhouette"]["file"])).convert("RGBA"))[..., 3]
    return _SIL


def _mask(index, pattern=None):
    """One Wang mask from the sheet: alpha 255 = side_b."""
    global _MASKS
    if _MASKS is None:
        _MASKS = np.array(Image.open(os.path.join(REPO,
                          PATTERNS["masks"]["file"])).convert("RGBA"))[..., 3]
    pid = pattern or PATTERNS["selection"]["default_pattern"]
    row = next(pp["row"] for pp in PATTERNS["patterns"] if pp["id"] == pid)
    fw, fh = PATTERNS["masks"]["frame_w"], PATTERNS["masks"]["frame_h"]
    fi = row * 16 + index
    r0, c0 = (fi // 16) * fh, (fi % 16) * fw
    return _MASKS[r0:r0 + fh, c0:c0 + fw] > 127


def region_of(x, y, regions):
    return region_at(x, y, gr)


PLATE_ROOT = os.path.join(REPO, "tiles", "patterns")
GROUND_PAL = json.load(open(os.path.join(REPO, "tiles",
                                         "ground_types.json")))["grounds"]
PLATE_FALLBACK = Counter()      # ground -> members that could not be resolved
_REGIONS = None


def _plate_regions():
    """(silhouette, top-face, wall) bool masks — transition_plates.regions()."""
    global _REGIONS
    if _REGIONS is None:
        _, _, sil = TPAT.load_library(PLATE_ROOT)
        top = TR.top_face(sil)
        _REGIONS = (sil, top, sil & ~top)
    return _REGIONS


def conformed_plate(rel, ground):
    """A base-tile member whose art has NO published plate, conformed here.

    tiles/plates is built only from APPROVED REVIEW CELLS, but 104 of the 340
    members in live/tuning/base_tile_sets.json point at art from
    tiles/tops (kind top_only, "never resolve one against
    review/manifest.json") and tiles/base_candidates. No plate exists for any
    of them, so the old key8 rule appended a second .webp, missed, and fell
    through to clean — 30.6% of members drew FLAT, invisibly (game agent,
    2026-08-30; grass was 14 of 14, the island's main land cover).

    Using the art verbatim is NOT the fix: a top tile is 64x64 review
    geometry whose wall the tops index marks meaningless, a plate is 64x46
    with a byte-exact silhouette alpha — straight composition puts 928 of
    2012 px in the wrong alpha (tiles agent, measured). So conform with the
    tiles agent's OWN conformer and fill the wall from the ground's palette,
    exactly as transition_plates.plate_array does. Verified: run over a
    review tile this reproduces their published plate byte-for-byte (0 px
    differing), alpha == the published silhouette, 2012 opaque."""
    ck = ("conform", rel, ground)
    if ck in _tile_cache:
        return _tile_cache[ck]
    sil, _top, wall = _plate_regions()
    a = np.array(TPAT.plate(Image.open(os.path.join(REPO, rel)), PLATE_ROOT))
    w = GROUND_PAL[ground]["palette"]["wall"].lstrip("#")
    a[wall, :3] = [int(w[i:i + 2], 16) for i in (0, 2, 4)]
    a[..., 3] = np.where(sil, 255, 0)
    a[~sil, :3] = 0
    assert int((a[..., 3] > 0).sum()) == int(sil.sum()), \
        f"conformed plate alpha != published silhouette: {rel}"
    img = Image.fromarray(a.astype(np.uint8))
    img.info["k"] = ck
    _tile_cache[ck] = img
    return img


_TEXTURED = None


def textured_art(key):
    """THE MEMBER'S OWN ART for a review key: the published TEXTURED pass.

    tiles/plates/<ground>/<key8>.webp is the same tile FLATTENED — "on a
    flat-surface ground the plate's top is the clean colour by the tiles
    agent's own design, so the set he audited textured composed clean"
    (wiki/site/wiki.js:5541, the maintainer's black-rock complaint
    2026-08-28). The wiki's fix was to draw the member's own art and keep the
    plate for geometry only; render3 never got it, so 236 of his 340 members
    drew the flat palette colour — measured, a grass field's mean top face
    was EXACTLY palette.top (20,82,59).

    Every candidate in the review manifest publishes `textured`; the plate
    remains the fallback."""
    global _TEXTURED
    if _TEXTURED is None:
        _TEXTURED = {}
        for _c, cell in MAN["cells"].items():
            for cand in cell["candidates"]:
                t = cand.get("textured")
                if t:
                    _TEXTURED[cand["key"].strip("/")] = t
                    _TEXTURED[cand["key"].strip("/").rsplit("/", 1)[-1]] = t
    return _TEXTURED.get(key.strip("/"))


# -- slopes (tiles3/slopes@1) --------------------------------------------------
# "One ground raised into a plateau with a graded edge down to ITSELF. NOT a
# transition between two materials - the Wang bit means a corner is RAISED.
# Index 0 flat, index 15 full plateau top." 15 grounds x 15 seeds, 64x46 -
# the SAME frame as a plate, and index 15's alpha is the published silhouette
# byte for byte, so a slope drops straight into the surface slot. The height
# lives INSIDE the art: every published set is elevation 4px, a sub-storey
# grade, which is what softens the foot of a rise.
SLOPES = json.load(open(os.path.join(REPO, "tiles", "slopes", "index.json")))
_SLOPE_BY_GROUND = {}
for _s in SLOPES["sets"]:
    # ONLY COMPLETE SETS. Measured over the published library: 9 of the 225
    # sets ship fewer than 16 post files (7-15), and 122 of 3,553 files are
    # 64x30 instead of the 64x46 the frame requires (slime and water worst).
    # A short set indexed by a Wang bitmask is an IndexError; a 30-row tile
    # cannot be masked by the 46-row silhouette. Reported to the tiles agent.
    if _s.get("complete") and len(_s.get("post_files") or []) == 16:
        _SLOPE_BY_GROUND.setdefault(_s["ground"], []).append(_s)
for _g in _SLOPE_BY_GROUND:
    _SLOPE_BY_GROUND[_g].sort(key=lambda s: s["dir"])


def slope_tile(ground, index, x, y):
    """The slope tile for this corner bitmask, seed chosen per AREA so a
    hillside keeps one boundary character (same reasoning as a base set's
    region)."""
    sets = _SLOPE_BY_GROUND.get(ground)
    if not sets or not (0 < index < 16):
        return None
    si = (fnv1a(f"slope|{ground}|{x // 24}|{y // 24}") % len(sets))
    st = sets[si]
    rel = os.path.join(st["dir"], "post", st["post_files"][index])
    ck = ("slope", rel)
    if ck not in _tile_cache:
        f = os.path.join(REPO, rel)
        if not os.path.isfile(f):
            return None
        im = Image.open(f).convert("RGBA")
        if im.size != (TILE, 46):
            _tile_cache[ck] = None     # a mis-sized publication: fall back
            return None                # to the flat plate, never crash
        im.info["k"] = ck
        _tile_cache[ck] = im
    return _tile_cache[ck]


def as_surface(im):
    """Any tile art -> plate geometry (64x46, art at row 0), so a fade or a
    detail can stand in for a base-tile-set plate anywhere the surface is
    drawn. A review tile is 64x64 with its diamond apex at TOP_Y; the
    published transition geometry starts at row 0 (transition_plates.py)."""
    if im.height == 46:
        return im
    ck = ("surf", im.info.get("k") or id(im))
    if ck in _tile_cache:
        return _tile_cache[ck]
    out = im.crop((0, TOP_Y, TILE, min(im.height, TOP_Y + 46)))
    if out.height < 46:
        pad = Image.new("RGBA", (TILE, 46), (0, 0, 0, 0))
        pad.alpha_composite(out, (0, 0))
        out = pad
    _tile_cache[ck] = out
    return out


def top_face_only(surf):
    """The surface's TOP FACE alone — the wall region dropped so the cell's
    x-over-y wall art shows through. THE WALL IS NEVER THE SURFACE'S."""
    ck = ("topface", surf.info.get("k") or id(surf))
    if ck in _tile_cache:
        return _tile_cache[ck]
    _sil, top, _wall = _plate_regions()
    a = np.array(surf.convert("RGBA"))
    out = np.zeros_like(a)
    out[top] = a[top]
    im = Image.fromarray(out)
    _tile_cache[ck] = im
    return im


DETAIL_FREQ = 1 / 56.0        # "once in a while"; overridable per ground by
                              # live/tuning/tile_details.json if the wiki ever
                              # publishes a rate (read below, absent today)
_DETAIL_RATE = {}
try:
    _DETAIL_RATE = json.load(open(os.path.join(
        REPO, "live", "tuning", "tile_details.json"))).get("rate", {})
except Exception:
    pass


def detail_pool(ground):
    """THE MAINTAINER'S ONCE-IN-A-WHILE GROUND DETAILS — his 478 '#top'
    approvals, which nothing had ever drawn.

    The wiki states the contract in his own words (wiki/site/wiki.js:5896):
    "other categories can still have a chance to once in a while be in the
    game!... if the top looks great you can give it a top star and approval",
    and the card that collects it says it is "rating the TOP as a
    once-in-a-while ground detail". A tile REJECTED AS A PAIR (bad wall) can
    still be a top-approved detail — the top review is independent by design.

    Two consequences the first implementation got wrong:
      * the art is the RAW top (`before`). "The pair postprocess flattens
        every top to the clean colour, which is WHY he has never seen most of
        them" — drawing `after` would draw the flat colour he is trying to
        escape.
      * a detail's WALL is not its own: the pair may be rejected precisely
        because that wall is bad, and half these tiles carry lava, ice or
        sand faces. So it is conformed like any surface — top face kept,
        wall filled from the ground's palette."""
    key = ("details", ground)
    if key in _set_cache:
        return _set_cache[key]
    out = []
    for _ck, cell in MAN["cells"].items():
        if cell["top"] != ground:
            continue
        for c in cell["candidates"]:
            if FB.get(c["key"] + "#top", {}).get("status") != "approved":
                continue
            rel = c.get("textured") or c.get("before") or c.get("file")
            if rel and os.path.isfile(os.path.join(REPO, rel)):
                out.append(conformed_plate(rel, ground))
    _set_cache[key] = out
    return out


def plate_img(ground, region, x, y):
    """The maintainer's ground look: SET per region, MEMBER per cell
    (basesets port above); a member resolves to its published plate, or is
    conformed from its own art when the plate library does not cover it;
    clean -> the ground's clean plate."""
    chosen = pick_set(ground, region)
    m = pick_member(chosen, x, y)
    root = os.path.join(REPO, "tiles", "plates")
    if m.get("kind") == "tile":
        t = m["tile"]
        if t.endswith(".webp"):          # literal art path
            # if the tiles agent ever publishes a plate for this art (its
            # filename carries the content hash), the OFFICIAL plate wins —
            # conforming here is a consumer-side stopgap, not ownership
            for tok in re.findall(r"([0-9a-f]{8})", t.rsplit("/", 1)[-1]):
                f = os.path.join(root, ground, tok + ".webp")
                if os.path.isfile(f):
                    ck = ("plate", ground, tok)
                    if ck not in _tile_cache:
                        _tile_cache[ck] = Image.open(f).convert("RGBA")
                    return _tile_cache[ck]
            if os.path.isfile(os.path.join(REPO, t)):
                return conformed_plate(t, ground)
            PLATE_FALLBACK[ground] += 1
        else:                            # review key -> the member's own art
            tex = textured_art(t)
            if tex and os.path.isfile(os.path.join(REPO, tex)):
                return conformed_plate(tex, ground)
            key8 = t.rsplit("/", 1)[-1]
            f = os.path.join(root, ground, key8 + ".webp")
            if os.path.isfile(f):
                ck = ("plate", ground, key8)
                if ck not in _tile_cache:
                    _tile_cache[ck] = Image.open(f).convert("RGBA")
                    _tile_cache[ck].info["k"] = ck
                return _tile_cache[ck]
            PLATE_FALLBACK[ground] += 1
    ck = ("plate", ground, "clean")
    if ck not in _tile_cache:
        _tile_cache[ck] = Image.open(os.path.join(root, ground, "clean.webp")).convert("RGBA")
        _tile_cache[ck].info["k"] = ck
    return _tile_cache[ck]


def composed_boundary(ga, gb, index, pa, pb):
    """out.rgb = mask ? plate_b : plate_a; out.alpha = silhouette — the
    patterns/plates contract, three draws, no geometry knowledge."""
    a = np.array(pa); b = np.array(pb)
    mk = _mask(index)
    out = np.where(mk[..., None], b, a)
    out[..., 3] = _silhouette()
    return Image.fromarray(out.astype(np.uint8))


SIDE_ORDER = PATTERNS["selection"]["side_order"]


def side_roles(a, b):
    """side_a / side_b assignment, canonical via the library's side_order."""
    ia = SIDE_ORDER.index(a) if a in SIDE_ORDER else 99
    ib = SIDE_ORDER.index(b) if b in SIDE_ORDER else 99
    return (a, b) if ia <= ib else (b, a)


FADES = json.load(open(os.path.join(REPO, "tiles", "fades", "index.json"))) \
    if os.path.isfile(os.path.join(REPO, "tiles", "fades", "index.json")) else {"pairs": {}}
FADE_BAND = 2                           # cells of fade band each side of a hard edge
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


def _load_tuning(name):
    p = os.path.join(REPO, "live", "tuning", name)
    try:
        return json.load(open(p)).get("overrides", {})
    except Exception:
        return {}


# THE MAINTAINER'S TWO TILE TOGGLES, both live channels he edits in the wiki:
#   tile_walls.json  top_only  -> this tile's OWN WALL is unusable
#   top_walls.json   wall: key -> ...and THIS is the wall it borrows instead
#   tile_tops.json   own_top   -> keep the tile's OWN TOP; do not paint the
#                                 base-tile-set surface over it
TOP_WALL_OV = _load_tuning("top_walls.json")
TOP_OV = _load_tuning("tile_tops.json")


def top_only(key):
    return bool(WALL_OV.get(key, {}).get("top_only"))


def own_top(key):
    return bool(TOP_OV.get(key, {}).get("own_top"))


def borrowed_wall(key):
    """The wall the maintainer picked for a top_only tile (top_walls.json)."""
    ref = TOP_WALL_OV.get(key, {}).get("wall")
    if not ref:
        return None
    cell, k8 = ref.strip("/").rsplit("/", 2)[-2:]
    c = MAN["cells"].get(cell)
    if not c:
        return None
    for cand in c["candidates"]:
        if cand["key"].strip("/").endswith("/" + k8):
            return cand
    return None


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


# -- BASE TILE SETS — port of wiki/lib/basesets.mjs (the shared reference) ----
# THE GROUND'S LOOK IS THE MAINTAINER'S DATA (live/tuning/base_tile_sets.json,
# pixel-wiki-base-tile-sets@1): a SET per REGION keeps an area coherent, a
# MEMBER per CELL varies the field, weights are his, clean is a member. The
# pick is FNV-1a/32 + fmix32 to the bit — proven against TEST_VECTORS below,
# because a port that drifts makes the ground disagree between the game, the
# wiki and this renderer.
BTS = json.load(open(os.path.join(REPO, "live", "tuning", "base_tile_sets.json"))) \
    if os.path.isfile(os.path.join(REPO, "live", "tuning", "base_tile_sets.json")) else {"grounds": {}}
CLEAN_SET_ID = 0


def fnv1a(sstr):
    h = 0x811c9dc5
    for ch in sstr:
        h ^= ord(ch) & 0xff
        h = (h * 0x01000193) & 0xffffffff
    h ^= h >> 16
    h = (h * 0x85ebca6b) & 0xffffffff
    h ^= h >> 13
    h = (h * 0xc2b2ae35) & 0xffffffff
    h ^= h >> 16
    return h


def unit_hash(sstr):
    return fnv1a(sstr) / 4294967296


def pick_weighted(weights, u):
    total = sum(w for w in weights if w > 0)
    if not total > 0:
        return -1
    acc, target = 0.0, u * total
    for i, w in enumerate(weights):
        acc += w if w > 0 else 0
        if target < acc:
            return i
    for i in range(len(weights) - 1, -1, -1):
        if weights[i] > 0:
            return i
    return -1


def _norm_members(set_id, members):
    src = members if isinstance(members, list) else []
    tiles = [] if set_id == CLEAN_SET_ID else [
        {"kind": "tile", "tile": m["tile"], "weight": max(0, float(m.get("weight") or 0))}
        for m in src if m and m.get("kind") == "tile" and isinstance(m.get("tile"), str) and m["tile"]]
    clean = next((m for m in src if m and m.get("kind") == "clean"), None)
    cw = max(0, float(clean.get("weight") or 0)) if clean else (0 if tiles else 1)
    return [{"kind": "clean", "weight": cw}] + tiles


def sets_for(ground):
    raw = (BTS.get("grounds", {}).get(ground) or {}).get("sets")
    lst = list(raw) if isinstance(raw, list) else []
    if not any(s and s.get("id") == CLEAN_SET_ID for s in lst):
        lst.append({"id": CLEAN_SET_ID, "name": "Clean", "weight": 1,
                    "members": [{"kind": "clean", "weight": 1}]})
    lst = [s for s in lst if s and isinstance(s.get("id"), int) and s["id"] >= 0]
    lst.sort(key=lambda s: s["id"])
    return [{"id": s["id"], "weight": max(0, float(s.get("weight") or 0)),
             "members": _norm_members(s["id"], s.get("members"))} for s in lst]


def pick_set(ground, region):
    sets = sets_for(ground)
    i = pick_weighted([s["weight"] for s in sets],
                      unit_hash(f"bts1|set|{ground}|{region}"))
    return next(s for s in sets if s["id"] == CLEAN_SET_ID) if i < 0 else sets[i]


def pick_member(chosen, x, y):
    if not chosen or not chosen.get("members"):
        return {"kind": "clean"}
    i = pick_weighted([m["weight"] for m in chosen["members"]],
                      unit_hash(f"bts1|tile|{chosen['id']}|{x}|{y}"))
    return {"kind": "clean"} if i < 0 else chosen["members"][i]


# the port is proven at import, not trusted
for sstr, want in (("", 2872998923), ("a", 444641715), ("grass", 876385684),
                   ("bts1|set|grass|r0", 876574184), ("bts1|tile|1|0|0", 1995477220)):
    assert fnv1a(sstr) == want, f"fnv1a port broken on {sstr!r}"
for w, u, want in (([1, 1], 0, 0), ([1, 1], 0.4999, 0), ([1, 1], 0.5, 1),
                   ([0, 5], 0, 1), ([0, 5], 0.999, 1), ([3, 1], 0.74, 0),
                   ([3, 1], 0.76, 1), ([0, 0], 0.5, -1), ([], 0.5, -1)):
    assert pick_weighted(w, u) == want, f"pickWeighted port broken on {w},{u}"


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


def over_candidate(top, side):
    c = approved_candidate(top, side) or approved_candidate(top, top)
    assert c, f"no review cell for {top} over {side} (nor {top} over {top}) — " \
              f"the x-over-y matrix is the ONLY wall source and it has no tile"
    return c


def over_tile(top, side):
    """The x-over-y tile image — THE ONLY WALL SOURCE.

    TOP_ONLY (his tile_walls.json): the tile's own wall is unusable, so the
    face is replaced by the wall he chose for it in top_walls.json — the
    tile keeps its top and BORROWS a wall, which is what the two files are
    for. Without this the mark was dead: it only filtered a storey pool it
    could never match."""
    key = ("over", top, side)
    if key in _tile_cache:
        return _tile_cache[key]
    c = over_candidate(top, side)
    im = Image.open(os.path.join(REPO, c["file"])).convert("RGBA")
    if top_only(c["key"].strip("/")):
        lend = borrowed_wall(c["key"].strip("/")) or approved_candidate(side, side)
        if lend:
            w = Image.open(os.path.join(REPO, lend["file"])).convert("RGBA")
            out = im.copy()
            band = w.crop((0, TOP_Y + 2 * DY, TILE, w.height))
            out.paste((0, 0, 0, 0), (0, TOP_Y + 2 * DY, TILE, out.height))
            out.alpha_composite(band, (0, TOP_Y + 2 * DY))
            im = out
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


def fade_pool(field_ground, other):
    """The REAL fade product (tiles/fades, tiles3/fade-tiles@1): top-only mix
    tiles placed BY EDGE_GROUND — the ground the tile's rim belongs to — never
    by area majority (maintainer ruling 2026-08-28: big rocks ON an ice sheet).
    Returns [(file, other_pct)] usable inside a `field_ground` field next to
    `other`, sorted by how much of the other ground shows."""
    key = ("fadepool", field_ground, other)   # -> [(file, pct, rating)]
    if key in _set_cache:
        return _set_cache[key]
    out = []
    for pk in (f"{field_ground}__to__{other}", f"{other}__to__{field_ground}"):
        for t in FADES.get("pairs", {}).get(pk, []):
            if t.get("edge_ground") != field_ground:
                continue
            # HIS VERDICTS RIDE THE FADE KEY (tiles/docs/TRANSITIONS.md:188).
            # The pool was drawing tiles he had REJECTED; a rejected fade is
            # not a candidate, and a rated one outranks an unrated one.
            fbe = FB.get(t.get("key", ""), {})
            if fbe.get("status") == "rejected":
                continue
            rating = float(fbe.get("rating") or 0)
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
            out.append((t["file"], pct, rating))
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
    wall_over = {}
    for w_ in doc.get("walls", []):
        for c in w_["cells"]:
            wall_over[(c["x"], c["y"])] = w_["side"]

    def g(x, y):
        if not (x0 <= x < x1 and y0 <= y < y1):
            return None
        i = grd[y][x]
        return G[i] if i >= 0 else None

    def L(x, y):
        return lvl[y][x] if (0 <= x < W and 0 <= y < H) else 0

    # REGIONS for the base-tile-set pick. The reference implementation says
    # region "is an opaque string owned by the world agent — a region id, a
    # chunk key, whatever it decides an area is" (wiki/lib/basesets.mjs:160),
    # so the granularity is MY call, and connected components were the wrong
    # call: grass is ONE 4-connected component across the whole island, so the
    # entire map drew a single grass set and 19 of the 68 weighted sets the
    # maintainer tuned never appeared anywhere. A CHUNK is a location: one set
    # per ground per RGN-cell block, deterministic and independent of which
    # window is being rendered.
    RGN = 24

    def region_at(x, y, gg):
        return f"{gg}@{x // RGN},{y // RGN}"

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

            def surface(gr=gr, x=x, y=y, zl=zl):
                """THE MAINTAINER'S SURFACE for this cell, at ANY level: his
                base tile set, eased by a fade near a ground change, and once
                in a while a detail. Returns a 64x46 plate-geometry image.

                Until 2026-08-30 this ran only for zl == 0: every raised cell
                — the whole massif, every terrace, the town shelf — drew the
                plain x-over-x review tile and ignored the sets he tunes.
                'I kinda expected everything from using the base tile sets.'"""
                t = plate_img(gr, region_at(x, y, gr), x, y)
                # SLOPE: where this ground rises to ITSELF beside the cell,
                # the surface takes the graded Wang tile instead of the flat
                # plate — the corner bit is set when a cell touching that
                # corner is higher and made of the same ground. This is what
                # makes a path uphill read as a climb instead of a stack of
                # flat diamonds (maintainer 2026-08-30).
                sidx = 0
                for bit, (cxx, cyy) in enumerate(((x, y), (x + 1, y),
                                                  (x, y + 1), (x + 1, y + 1))):
                    hi = False
                    for ax, ay in ((cxx - 1, cyy - 1), (cxx, cyy - 1),
                                   (cxx - 1, cyy), (cxx, cyy)):
                        if L(ax, ay) > zl and g(ax, ay) == gr:
                            hi = True
                            break
                    if hi:
                        sidx |= 8 >> bit
                if sidx:
                    sl = slope_tile(gr, sidx, x, y)
                    if sl is not None:
                        t = sl
                # FADE BAND: within FADE_BAND cells of a different SOLID
                # ground at the same level, ease the change with the fades
                # product (top-only, placed by edge_ground). Deterministic.
                # A REAL DISTANCE BAND: the nearest differing solid ground at
                # this level anywhere in the neighbourhood (Chebyshev), ring 1
                # included. Four axis cells at one ring was not a band, and
                # skipping ring 1 dropped the fade exactly where the drift is
                # strongest — the boundary tile rides the corner lattice ON
                # TOP of this cell, so ring 1 is still ours to dress.
                near = None
                for r in range(1, FADE_BAND + 1):
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
                    pool = fade_pool(gr, near[0])
                    if pool:
                        rr = _rng((x * 73856093) ^ (y * 19349663))
                        # A FADE IS A SCATTERED EVENT, NOT A COAT OF PAINT.
                        # Stamping the band solid put ONE tile on up to 1,357
                        # cells — the repetition he ruled out. Probability
                        # falls off with distance from the switch.
                        band_pos = (FADE_BAND + 1 - near[1]) / (FADE_BAND + 1)
                        if rr() > 0.45 * band_pos:
                            return t
                        # sample the WHOLE pool, weighted by his ratings, with
                        # the mix strength tracking the distance
                        wts = [(1.0 + 1.6 * rt) *
                               (1.0 - abs((pc / 60.0) - band_pos))
                               for (_f, pc, rt) in pool]
                        tot = sum(w for w in wts if w > 0) or 1.0
                        pick, acc = len(pool) - 1, rr() * tot
                        for i2, w in enumerate(wts):
                            acc -= max(0.0, w)
                            if acc <= 0:
                                pick = i2
                                break
                        idx = pick
                        hi = len(pool) - 1
                        # a fade is TOP-ONLY art (its wall is meaningless by
                        # the producer's own index), so it conforms exactly
                        # like any other surface: top face kept, wall filled
                        # from the ground's palette, alpha = the published
                        # silhouette. Hand-cropping it to 40 rows produced a
                        # 30-row surface that the top-face mask could not
                        # index — and shipped a garbage wall besides.
                        return conformed_plate(pool[max(0, idx)][0], gr)
                # DETAILS: once in a while, one of his top-approved tops
                dp = detail_pool(gr)
                if dp:
                    rate = float(_DETAIL_RATE.get(gr, DETAIL_FREQ))
                    rd = _rng((x * 83492791) ^ (y * 2654435761) ^ 0xd47a)
                    if rd() < rate:
                        return dp[int(rd() * len(dp)) % len(dp)]
                return t

            if gr in liq:
                # A LIQUID IS A GROUND WITH A SET TOO (water: 16 tiles, clean
                # weight 0 — he chose every one of them). It was drawing a
                # flat diamond, and water is the largest surface on the map.
                # Top face only: a liquid never shows a wall.
                img.alpha_composite(top_face_only(surface()),
                                    (bx, col_y(x, y, zl)))
                continue
            if zl == 0:
                img.alpha_composite(surface(), (bx, col_y(x, y, zl)))
                continue
            front_low = min(L(x + 1, y), L(x, y + 1))
            fx, fy = (x + 1, y) if L(x + 1, y) <= L(x, y + 1) else (x, y + 1)
            side = wall_over.get((x, y)) or (g(fx, fy) or gr)
            if (x, y) not in wall_over and (side in INDOOR_GROUNDS or side in liq):
                side = gr                    # stone over its own body; water is
                                             # never a wall material either
            cap = over_tile(gr, side) if front_low < zl else flat_tile(gr)
            # the repeated course is the WALL's own material in every case —
            # keying it on the top ground drew 407 cells whose courses were a
            # different material from their own cap
            mid = storey_tile(side)
            for f in range(max(0, front_low), zl + 1):
                t = cap if f == zl else mid
                img.alpha_composite(t, (bx, col_y(x, y, f) - TOP_Y))
            # ...and the SURFACE goes on the cap: the wall is x-over-y art,
            # the top is the maintainer's set. Only the top face is painted,
            # so the cap's own wall — the only lawful wall source — survives.
            if not own_top(over_candidate(gr, side)["key"].strip("/")):
                img.alpha_composite(top_face_only(surface()),
                                    (bx, col_y(x, y, zl)))

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
            sa, sb = side_roles(a, b)
            idx = (8 * (gs[0] == sb) + 4 * (gs[1] == sb)
                   + 2 * (gs[2] == sb) + 1 * (gs[3] == sb))
            if idx in (0, 15):
                continue
            reg = region_at(x, y, gr)
            # each half asks for ITS OWN ground's region — asking with the
            # other ground's region drew the neighbour from the wrong set
            tile = composed_boundary(sa, sb, idx,
                                     plate_img(sa, region_at(x, y, sa), x, y),
                                     plate_img(sb, region_at(x, y, sb), x, y))
            z = L(x, y)
            cx = ox + (x - x0 - (y - y0)) * DX - DX
            cy = col_y(x, y, z) - DY
            # apex (32,0) of the transition tile sits on corner (x+1,y+1)'s
            # top vertex = the shared corner of the quad
            img.alpha_composite(tile, (cx, cy + DY))
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
            body = "grey_stone" if (dk.get("kind") == "cave"
                                    and dg not in ("black_rock", "grey_stone")) else dg
            cap = flat_tile(dg) if front_covered else over_tile(dg, body)
            mid = storey_tile(body)
            for f in range(lo, dl + 1):
                t = cap if f == dl else mid
                img.alpha_composite(t, (bx, col_y(x, y, f) - TOP_Y))
            # a roof, a bridge and a cave lid are GROUND too: the slab top
            # wears the maintainer's base tile set like any other surface
            img.alpha_composite(
                top_face_only(plate_img(dg, f"{dg}@{x // 24},{y // 24}", x, y)),
                (bx, col_y(x, y, dl)))

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
        spath = meta["sprite"]
        if p.get("lit"):              # {"lit": true} selects the LIT_* state
            litk = sorted(k for k in (meta.get("states") or {})
                          if k.startswith("LIT"))
            if litk:
                spath = meta["states"][litk[0]]["sprite"]
        sp = Image.open(os.path.join(REPO, "scenery", spath)).convert("RGBA")
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
        # WebP hard-limits each side to 16383 px; cap the overview scale so a
        # grown map still encodes (512-wide world -> full canvas is ~32.8k px)
        W, H = doc["size"]["w"], doc["size"]["h"]
        fw = (W + H) * 32 + 16
        img = render(doc, scale=min(0.5, 16300 / fw))
        out = os.path.join(MAPS2, "worlds3", "the_game", "overview.webp")
    img.convert("RGB").save(out, lossless=True, method=4, exact=True)
    print("wrote", out, img.size)
    # THE SILENT-FLAT GATE. The old member rule fell through to clean.webp on
    # a miss: a real file, so every existence check passed and the only
    # symptom was "the world looks flatter than it is" — 30.6% of members,
    # invisible for two weeks. A miss is now counted and fatal.
    if PLATE_FALLBACK:
        print("BASE-TILE MEMBERS THAT COULD NOT BE RESOLVED (drawn flat):")
        for g, n in sorted(PLATE_FALLBACK.items()):
            print(f"   {g:22} {n}")
        raise SystemExit(
            "render3: %d base-tile member lookups fell back to clean. A "
            "member with no published plate and no art on disk means "
            "live/tuning/base_tile_sets.json references something that is "
            "not published — report it, do not render flat."
            % sum(PLATE_FALLBACK.values()))


if __name__ == "__main__":
    main()
