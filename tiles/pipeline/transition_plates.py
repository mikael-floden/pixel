"""Publish tiles/plates/ - the BASE PLATES the transition patterns compose.

A PLATE IS A BASE TILE IN TRANSITION GEOMETRY. tiles/patterns/ publishes the boundary
and nothing else; a boundary needs two grounds to divide. This module publishes those
two grounds, one file per ground surface, so composing a transition is three drawImage
calls with no geometry knowledge on the consumer's side:

    out.rgb = mask ? B.rgb : A.rgb ;  out.a = silhouette

A CONSUMER CANNOT BUILD A PLATE ITSELF, which is why this file exists. Review art is
64x64 with the tile at row 9 or 10 and 41 distinct silhouettes across the 225 cells;
the transition silhouette is 64x46 with the art at row 0. Composing straight from a
review tile puts 928 of 2012 pixels in the wrong alpha (400 opaque outside the
silhouette, 528 silhouette pixels transparent) - measured. Conforming needs the column
extension and empty-column fill in transition_patterns.plate(), which is not
reimplementable in a browser from anything published.

THE ALPHA IS THE PUBLISHED SILHOUETTE, EXACTLY. 2012 opaque pixels, byte-identical on
every plate and every mask. compose()'s recipe is load-bearing on it: a plate whose
alpha differs by one pixel makes that pixel either a hole or opaque black in every
transition the plate ever enters. Verified per file on write (--write refuses to
publish a mismatch) and again by --verify against the decoded WebP.

THE WALL IS THE GROUND'S OWN PALETTE WALL COLOUR, NEVER THE SOURCE TILE'S WALL. A
review cell is `G__over__H`: the top is G and the wall is H. Ground G's plate pool is
every approved tile of every `G__over__*` cell, so grass's 248 approved tiles carry 15
different walls - lava, snow, ice, parquet. Keeping them would make a grass field's
cliff change material when the set picked a different member, and would put lava under
grass. So the wall region (1088 of 2012 px, the bottom WALL_D=17 rows of every column)
is filled with `ground_types.grounds[<g>].palette.wall`, the same wall clean.webp
carries. The wall is then a function of the GROUND ALONE: which member of a set fills a
cell can never change the cliff, and a composed cliff is the two grounds' wall colours
in the pattern library's three vertical bands.

That is what the maintainer asked for: "I pick tiles to be part of the base tile set if
I like how the top looks with the knowledge this will never define a wall." A base tile
set is about the ground surface; the wall is a separate decision (live/tuning/
tile_walls.json, `pixel-wiki-tile-walls@1`).

THE OVERHANG IS DROPPED WITH THE WALL, deliberately. 25-36% of a grass tile's wall
region reads nearer to grass than to the side material - the blades tufting over the
cliff. They sell a boundary between two DIFFERENT materials; a base tile's cliff is its
own ground, where there is no boundary to sell. Keeping them was tried by nearest-of-
two against (top palette, side wall palette) and misfires visibly - dark lava wall rows
classify as grass and ship a maroon band under a grass tile, the same trap
palette_snap._split_wall documents (81.7% of a rock wall once painted teal). A rule
that needs no classifier cannot misclassify.

WHICH TILES BECOME PLATES: the maintainer's APPROVED verdicts in live/feedback/
tiles.json, resolved through the review manifest's own key `tiles/<cell>/sha1(src)[:8]`
- never through a rank slot. tiles/ground_types.json base_tiles points at
`tiles/review/<cell>/<rank>_after.webp`, and a rank is not an identity: when a tile is
un-published the next one slides into the slot and inherits the verdict.

ONE FILE PER key8 PER GROUND, AND THE PATH IS A PURE FUNCTION OF THE KEY:

    tiles/<top>__over__<side>/<key8>   ->   tiles/plates/<top>/<key8>.webp

No lookup table, so nothing can go stale between this domain and a consumer. It costs
the 155 approved keys whose plates come out byte-identical to another key's: they are
written twice rather than aliased, 155 files and ~40 KB against a 1.6 MB resolve map.

A key8 IS NOT UNIQUE INSIDE A GROUND and the rule survives it. key8 is
sha1(<matrix path>)[:8] and the brown/grey paving expansion publishes ONE matrix tile
into TWO cells, so 226 of the 3911 approved keys share a key8 with a sibling in the same
ground. They are the same base tile: measured across all 226, the two publications
differ by at most 12 of 924 top-face pixels, median 1, and 95 are identical - the
difference is _split_wall putting the brim boundary one pixel apart under a different
side hex. They collapse to one plate, taken from the lexicographically smallest cell,
and a collision differing by more than MAX_TWIN_DELTA px is refused rather than
collapsed silently.

THIS FILE DOES NOT DEFINE BASE TILE SETS. The wiki agent owns that schema
(`pixel-wiki-base-tile-sets@1`, wiki/lib/basesets.mjs, live/tuning/base_tile_sets.json)
- membership, weights, the per-region set pick and the per-cell member pick. This
publishes the ART those members name, plus `resolve`, the map from a member's `tile`
to a plate file. index.json states exactly what is expected of their file and where it
is read from.

Reads tiles/patterns/**, tiles/review/manifest.json, tiles/ground_types.json,
live/feedback/tiles.json. Writes only tiles/plates/**.

    python3 tiles/pipeline/transition_plates.py            # measure, write nothing
    python3 tiles/pipeline/transition_plates.py --write    # publish
    python3 tiles/pipeline/transition_plates.py --verify   # reload from disk and check
"""
import argparse
import hashlib
import io
import json
import os
import shutil
import sys
from collections import defaultdict

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import transition_patterns as TPAT     # noqa: E402  plate(), compose(), load_library()
import transition_render as TR         # noqa: E402  top_face()

SCHEMA = "tiles3/base-plates@1"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # tiles/
REPO = os.path.dirname(ROOT)
PATTERNS = os.path.join(ROOT, "patterns")
OUT = os.path.join(ROOT, "plates")
MANIFEST = os.path.join(ROOT, "review", "manifest.json")
GROUND_TYPES = os.path.join(ROOT, "ground_types.json")
FEEDBACK = os.path.join(REPO, "live", "feedback", "tiles.json")

# The wiki agent's file. READ ONLY - this domain never writes it (the base-tile-set
# schema and every weight in it belong to the wiki agent).
SETS_DOC = "live/tuning/base_tile_sets.json"
SETS_SCHEMA = "pixel-wiki-base-tile-sets@1"

TILE_W, TILE_H = TPAT.TILE_W, TPAT.TILE_H


def _hex(s):
    """'#rrggbb' -> uint8[3]."""
    s = s.lstrip("#")
    return np.array([int(s[i:i + 2], 16) for i in (0, 2, 4)], np.uint8)


def regions():
    """(silhouette, top-face, wall) as bool masks. Measured: 2012 = 924 + 1088."""
    _, _, sil = TPAT.load_library(PATTERNS)
    top = TR.top_face(sil)
    return sil, top, sil & ~top


# --------------------------------------------------------------------- the sources

def approved_keys():
    """The maintainer's approved keys, `tiles/<cell>/<key8>`, from his own file.

    live/feedback/tiles.json is what he actually said. Everything else about a tile's
    standing is derived state that has been lost and rebuilt at least twice.
    """
    entries = json.load(open(FEEDBACK))["entries"]
    return {k.strip("/") for k, v in entries.items() if v.get("status") == "approved"}


def candidates():
    """key -> {ground, cell, side, after, rank} for every published review candidate.

    `ground` is the cell's TOP. A base tile set is about the ground surface, so a tile
    belongs to the pool of the material it shows on top, whatever it stands on.
    """
    cells = json.load(open(MANIFEST))["cells"]
    out = {}
    for cell, c in cells.items():
        for e in c["candidates"]:
            out[e["key"].strip("/")] = {
                "ground": c["top"], "cell": cell, "side": c["side"],
                "after": e["after"], "rank": e["rank"], "src": e["src"],
            }
    return out


def grounds():
    return json.load(open(GROUND_TYPES))["grounds"]


# --------------------------------------------------------------------- the plates

def plate_array(img, wall_rgb, sil, wall):
    """One plate: the source's top face, the ground's wall, the library silhouette.

    RGB outside the silhouette is zeroed so the file is canonical - exact=True keeps
    whatever is under alpha=0, so two plates that differ only in invisible pixels would
    otherwise be two files.
    """
    a = np.array(TPAT.plate(img, PATTERNS))
    a[wall, :3] = wall_rgb
    a[..., 3] = np.where(sil, 255, 0)
    a[~sil, :3] = 0
    return a


def clean_array(top_rgb, wall_rgb, sil, top, wall):
    """The ground's flat palette colour in transition geometry.

    Every ground gets one even with no approved tile: it is the Clean #0 member, and it
    is what makes the library usable before any base tile set exists.
    """
    a = np.zeros((TILE_H, TILE_W, 4), np.uint8)
    a[top, :3] = top_rgb
    a[wall, :3] = wall_rgb
    a[..., 3] = np.where(sil, 255, 0)
    return a


def _webp_bytes(arr, sil):
    """Lossless WebP, re-decoded and diffed before it is returned.

    lossless=True AND exact=True, both non-default in Pillow: without the first this is
    lossy VP8 and every hard pixel-art edge rings, without the second libwebp rewrites
    the RGB under alpha=0 and the file stops being reproducible. The alpha is checked
    against the silhouette here as well as on the array, so a plate can only reach disk
    if the DECODED file carries the right 2012 pixels.
    """
    buf = io.BytesIO()
    Image.fromarray(arr, "RGBA").save(buf, "WEBP", lossless=True, exact=True,
                                      quality=100, method=6)
    data = buf.getvalue()
    back = np.array(Image.open(io.BytesIO(data)).convert("RGBA"))
    if not (back == arr).all():
        raise SystemExit("WebP did not round-trip exactly - refusing to write")
    if not ((back[..., 3] > 0) == sil).all() or set(np.unique(back[..., 3])) - {0, 255}:
        raise SystemExit("plate alpha is not the silhouette - refusing to write")
    return data


def _key8(key):
    """The last segment of a review key `tiles/<cell>/<key8>`."""
    return key.rsplit("/", 1)[-1]


MAX_TWIN_DELTA = 18
# Two publications of one key8 inside a ground are the same matrix tile, expanded into
# brown and grey paving. Measured over all 226: worst 12 top-face pixels of 924, median
# 1, 95 identical. 18 is 2% of the top face - above the measured worst, far below a
# different tile - and a collision over it is a key8 that means two things, which the
# path rule cannot express. Refuse rather than pick one.


def build():
    """Every ground's clean plate plus one plate per distinct approved key8."""
    sil, top, wall = regions()
    gt = grounds()
    appr = approved_keys()
    cand = candidates()

    unresolved = sorted(k for k in appr if k not in cand)
    out = {}
    for g, spec in sorted(gt.items()):
        pal = spec["palette"]
        top_rgb, wall_rgb = _hex(pal["top"]), _hex(pal["wall"])
        clean = clean_array(top_rgb, wall_rgb, sil, top, wall)

        mine = sorted(k for k in appr if k in cand and cand[k]["ground"] == g)
        twins = defaultdict(list)                    # key8 -> keys sharing it
        for k in mine:
            twins[_key8(k)].append(k)

        plates, merged, delta_max = [], [], 0
        for k8, keys in sorted(twins.items()):
            arrs = [plate_array(Image.open(os.path.join(REPO, cand[k]["after"])),
                                wall_rgb, sil, wall) for k in sorted(keys)]
            for a in arrs[1:]:
                d = int((arrs[0][..., :3] != a[..., :3]).any(axis=2)[top].sum())
                delta_max = max(delta_max, d)
                if d > MAX_TWIN_DELTA:
                    raise SystemExit(
                        f"{g}/{k8}: two publications differ by {d} top-face px "
                        f"(> {MAX_TWIN_DELTA}) - one key8, two tiles: "
                        + ", ".join(sorted(keys)))
            plates.append({"key8": k8, "arr": arrs[0], "keys": sorted(keys),
                           "cell": cand[sorted(keys)[0]]["cell"]})
            if len(keys) > 1:
                merged.append({"key8": k8,
                               "cells": sorted(cand[k]["cell"] for k in keys)})

        dupes = defaultdict(list)                    # identical pixels, different key8
        for p in plates:
            dupes[p["arr"].tobytes()].append(p["key8"])
        out[g] = {
            "spec": spec, "clean": clean, "plates": plates, "merged": merged,
            "approved": mine, "twin_delta_max": delta_max,
            "identical": sorted(sorted(v) for v in dupes.values() if len(v) > 1),
            "as_clean": sorted(p["key8"] for p in plates
                               if p["arr"].tobytes() == clean.tobytes()),
        }
    return out, cand, unresolved


# --------------------------------------------------------------------- publishing

def index_doc(built, cand, unresolved, generated_at, sizes):
    sil, top, wall = regions()
    pdoc = json.load(open(os.path.join(PATTERNS, "index.json")))
    ranks = defaultdict(dict)
    for k, c in cand.items():
        if any(k in b["approved"] for b in built.values()):
            ranks[c["cell"]][str(c["rank"])] = _key8(k)
    grounds_doc = {}
    for g, b in sorted(built.items()):
        pal = b["spec"]["palette"]
        cells = defaultdict(list)
        for p in b["plates"]:
            cells[p["cell"]].append(p["key8"])
        grounds_doc[g] = {
            "clean": {"file": f"{g}/clean.webp", "bytes": sizes[f"{g}/clean.webp"],
                      "top": pal["top"], "wall": pal["wall"]},
            "approved": len(b["approved"]),
            "n_plates": len(b["plates"]),
            "bytes": sum(sizes[f"{g}/{p['key8']}.webp"] for p in b["plates"])
                     + sizes[f"{g}/clean.webp"],
            "plates": {c: sorted(v) for c, v in sorted(cells.items())},
            "merged_twins": b["merged"],
            "identical_plates": b["identical"],
            "plates_identical_to_clean": b["as_clean"],
        }
    return {
        "schema": SCHEMA,
        "domain": "tiles",
        "generated_at": generated_at,
        "generator": "tiles/pipeline/transition_plates.py",
        "_comment": [
            "THE TWO GROUNDS A TRANSITION DIVIDES. tiles/patterns/ publishes the",
            "boundary; this publishes the surfaces it divides. A plate is a 64x46 RGBA",
            "tile whose alpha IS tiles/patterns/silhouette.webp - 2012 opaque pixels,",
            "byte-identical on every plate and every mask - so composing a transition is",
            "out.rgb = mask ? B.rgb : A.rgb, out.a = silhouette, three drawImage calls",
            "with no geometry knowledge on the consumer's side.",
            "A CONSUMER CANNOT BUILD ONE: review art is 64x64 with the tile at row 9-10",
            "and 41 distinct silhouettes across the 225 cells, and composing straight",
            "from it puts 928 of 2012 pixels in the wrong alpha (measured: 400 opaque",
            "outside the silhouette, 528 silhouette pixels transparent).",
            "THE WALL IS THE GROUND'S OWN palette.wall, never the source cell's. A review",
            "cell is G__over__H - top G, wall H - so ground G's approved pool carries up",
            "to 15 different walls (grass: lava, snow, ice, parquet). The wall is a",
            "function of the GROUND ALONE, so which member of a set fills a cell can",
            "never change the cliff, and a composed cliff is the two grounds' wall",
            "colours in the pattern library's three vertical bands.",
            "THE OVERHANG GOES WITH THE WALL: 25-36% of a grass tile's wall region reads",
            "nearer to grass than to the side material. Those blades sell a boundary",
            "between two DIFFERENT materials; a base tile's cliff is its own ground.",
            "THIS FILE DOES NOT DEFINE BASE TILE SETS - see `expects`.",
        ],
        "geometry": {
            "tile_w": TILE_W, "tile_h": TILE_H,
            "opaque_px": int(sil.sum()),
            "top_face_px": int(top.sum()),
            "wall_px": int(wall.sum()),
            "wall_d": TR.WALL_D,
            "dx": pdoc["geometry"]["dx"], "dy": pdoc["geometry"]["dy"],
            "_comment": "Identical to tiles/patterns/index.json geometry. The wall is "
                        "the bottom wall_d rows of every column; everything above it is "
                        "top face.",
        },
        "silhouette": {
            "file": "tiles/patterns/silhouette.webp",
            "sha256": hashlib.sha256(
                open(os.path.join(PATTERNS, "silhouette.webp"), "rb").read()).hexdigest(),
            "opaque_px": int(sil.sum()),
            "_comment": "Every plate's alpha equals this file's alpha exactly, and holds "
                        "only 0 and 255. A plate that differs by one pixel makes that "
                        "pixel a hole or opaque black in every transition it enters.",
        },
        "compose": {
            "patterns": "tiles/patterns/index.json",
            "masks": "tiles/patterns/masks.webp",
            "recipe": "out.rgb = mask(pattern, index) ? B.rgb : A.rgb ; out.a = silhouette",
            "reference": "tiles/pipeline/transition_patterns.py compose(a, b, pattern, "
                         "index, conform=False)",
            "_comment": "Plates are already conformed - pass conform=False. No blending, "
                        "no feathering, no resampling, no colour correction at the seam: "
                        "every output pixel comes verbatim from exactly one plate.",
        },
        "sources": {
            "verdicts": "live/feedback/tiles.json",
            "review_manifest": "tiles/review/manifest.json",
            "palettes": "tiles/ground_types.json",
            "_comment": "A plate exists for a tile the maintainer APPROVED, addressed by "
                        "the review key tiles/<cell>/sha1(<matrix path>)[:8]. Never by "
                        "rank slot: ground_types.base_tiles points at "
                        "tiles/review/<cell>/<rank>_after.webp and a rank is not an "
                        "identity - un-publish a tile and the next one inherits the "
                        "verdict.",
        },
        "pool": {
            "rule": "ground G's pool is every approved candidate of every G__over__* cell",
            "_comment": "The pool is about the GROUND, never the wall: 'I pick tiles to "
                        "be part of the base tile set if I like how the top looks with "
                        "the knowledge this will never define a wall' (maintainer "
                        "2026-08-25). A wall defect in the source cell disqualifies "
                        "nothing, because the wall is replaced.",
            "merged_twins": "One key8 published into two cells is the brown/grey paving "
                            "expansion of ONE matrix tile. Collapsed to one plate from "
                            "the lexicographically smallest cell; measured over all 226, "
                            "the two publications differ by at most 12 of 924 top-face "
                            "pixels (median 1, 95 identical). A collision over "
                            f"{MAX_TWIN_DELTA} px is refused, not collapsed.",
            "identical_plates": "Different key8s whose plates are byte-identical. Written "
                                "once per key8 anyway - the path rule is worth more than "
                                "155 files - and listed so a set UI can hide the twins.",
            "unresolved_approved_keys": unresolved,
        },
        "resolve": {
            "rule": "tiles/<top>__over__<side>/<key8>  ->  <top>/<key8>.webp",
            "clean": "<ground>/clean.webp",
            "root": "tiles/plates/",
            "ballot": "an id NOT matching ^tiles/[^/]+/[0-9a-f]{8}$ is a BALLOT id: use "
                      "tiles/base_candidates/<ground>/<id>.webp AS the plate directly. "
                      "Blessed after the wiki agent verified every ballot file's alpha is "
                      "byte-identical to the library silhouette - they are this domain's "
                      "own post-pass tiles, already in plate geometry. Two resolves, one "
                      "regex between them.",
            "_comment": "A PURE STRING FUNCTION OF THE REVIEW KEY - no lookup table, so "
                        "nothing can go stale between this domain and a consumer. The "
                        "ground is the cell up to '__over__'; the file name is the key's "
                        "last segment. Every approved key in live/feedback/tiles.json "
                        "resolves; a rejected or unknown key has no plate.",
        },
        "resolve_review_path": {
            "rule": "tiles/review/<cell>/<rank>_after.webp -> key8 = ranks[<cell>][<rank>]"
                    ", then `resolve`",
            "_comment": "MIGRATION SHIM. A rank slot is reassigned whenever a cell is "
                        "republished, so a member addressed this way silently changes "
                        "art - that is the bug the review key exists to fix. Present "
                        "because live/tuning/base_tile_sets.json was seeded from "
                        "ground_types.base_tiles, which is written in rank-slot paths. "
                        "Covers approved candidates only.",
            "ranks": {c: dict(sorted(v.items(), key=lambda kv: int(kv[0])))
                      for c, v in sorted(ranks.items())},
        },
        "expects": {
            "file": SETS_DOC,
            "format": SETS_SCHEMA,
            "owner": "wiki agent",
            "reference_impl": "wiki/lib/basesets.mjs",
            "_comment": [
                "SET MEMBERSHIP, WEIGHTS AND SELECTION ARE NOT DEFINED HERE. The wiki",
                "agent owns that schema; this domain READS that file and never writes it.",
                "What is read from it, per ground: an ordered list of sets, each with a",
                "weight (chance the set is chosen for a region) and members, each member",
                "with a weight (chance it fills a cell); one member of kind 'clean' per",
                "set carrying the clean colour's weight; set 0 named Clean, holding only",
                "the clean member, switched off by weight rather than deleted.",
                "What is needed of a member of kind 'tile': `tile` SHOULD be the review",
                "key tiles/<cell>/<key8> - the same key live/feedback/tiles.json uses -",
                "and it becomes a plate path through `resolve` above, with no lookup. A",
                "member of kind 'clean' draws <ground>/clean.webp.",
                "TODAY THE SEEDED MEMBERS ARE RANK-SLOT PATHS (tiles/review/<cell>/",
                "<rank>_after.webp), copied from ground_types.base_tiles; they resolve",
                "through `resolve_review_path`, which is a shim. Move members to the key",
                "form.",
                "A member naming a tile with no plate here is either not approved or not",
                "in the review manifest - draw the clean plate rather than nothing.",
            ],
        },
        "grounds": grounds_doc,
    }


def write(built, cand, unresolved, generated_at):
    sil, _, _ = regions()
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)              # the set is derived; a stale file is a lie
    sizes = {}
    for g, b in sorted(built.items()):
        os.makedirs(os.path.join(OUT, g), exist_ok=True)
        for name, arr in [(f"{g}/clean.webp", b["clean"])] + \
                         [(f"{g}/{p['key8']}.webp", p["arr"]) for p in b["plates"]]:
            if name in sizes:
                raise SystemExit(f"{name} written twice - the path rule is not injective")
            data = _webp_bytes(arr, sil)
            open(os.path.join(OUT, name), "wb").write(data)
            sizes[name] = len(data)
    doc = index_doc(built, cand, unresolved, generated_at, sizes)
    with open(os.path.join(OUT, "index.json"), "w") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")
    return doc, sizes


# --------------------------------------------------------------------- verification

def verify():
    """Reload from disk and check the three laws the recipe rests on.

    1. the files the index names are exactly the files on disk - a name collision
       overwrites art and leaves every survivor looking valid, which is how the first
       run lost 131 plates to a key8 shared by two cells
    2. every plate's DECODED alpha equals silhouette.webp's, pixel for pixel, 0 or 255
    3. a real compose of two real plates through a real mask has that same alpha, and
       every rgb pixel comes verbatim from one of the two plates
    """
    sil, _, _ = regions()
    doc = json.load(open(os.path.join(OUT, "index.json")))
    named = []
    for g, gd in sorted(doc["grounds"].items()):
        named.append(gd["clean"]["file"])
        named += [f"{g}/{k}.webp" for ks in gd["plates"].values() for k in ks]
    on_disk = sorted(f"{g}/{n}" for g in doc["grounds"]
                     for n in os.listdir(os.path.join(OUT, g)) if n.endswith(".webp"))
    ok = sorted(named) == on_disk and len(named) == len(set(named))
    print(f"files: index names {len(named)} ({len(set(named))} distinct), disk holds "
          f"{len(on_disk)} -> {'match' if ok else 'MISMATCH'}")

    bad = []
    for f in named:
        a = np.array(Image.open(os.path.join(OUT, f)).convert("RGBA"))
        if a.shape != (TILE_H, TILE_W, 4) or not ((a[..., 3] > 0) == sil).all() \
           or bool(set(np.unique(a[..., 3])) - {0, 255}):
            bad.append(f)
    print(f"alpha: {len(bad)} of {len(named)} plates differ from silhouette.webp"
          + (f" -> {bad[:5]}" if bad else ""))

    pats = [p["id"] for p in json.load(
        open(os.path.join(PATTERNS, "index.json")))["patterns"]]
    fa = f"grass/{sorted(doc['grounds']['grass']['plates']['grass__over__grass'])[0]}.webp"
    fb = f"light_soil/{sorted(doc['grounds']['light_soil']['plates']['light_soil__over__light_soil'])[0]}.webp"
    ia, ib = Image.open(os.path.join(OUT, fa)), Image.open(os.path.join(OUT, fb))
    av, bv = np.array(ia.convert("RGBA")), np.array(ib.convert("RGBA"))
    comp_bad = seam_bad = n = 0
    for pat in pats:
        for i in range(16):
            out = np.array(TPAT.compose(ia, ib, pat, i, conform=False, root=PATTERNS))
            m = TPAT.mask_of(pat, i, PATTERNS)
            n += 1
            comp_bad += not ((out[..., 3] > 0) == sil).all()
            comp_bad += bool(set(np.unique(out[..., 3])) - {0, 255})
            want = np.where(m[..., None], bv, av)
            seam_bad += not (out[..., :3][sil] == want[..., :3][sil]).all()
    print(f"compose: {n} real composes ({len(pats)} patterns x 16 indices) of {fa} x "
          f"{fb} - alpha != silhouette on {comp_bad}, rgb not verbatim from one plate "
          f"on {seam_bad}")

    idx = os.path.getsize(os.path.join(OUT, "index.json"))
    art = sum(os.path.getsize(os.path.join(OUT, f)) for f in on_disk)
    print(f"bytes: {art + idx} total = {art} in {len(on_disk)} webp "
          f"(mean {art // max(1, len(on_disk))} B) + {idx} index.json")
    return ok and not bad and not comp_bad and not seam_bad


def report(built, cand, unresolved, sizes=None):
    sil, top, wall = regions()
    print(f"silhouette: {int(sil.sum())} opaque px = {int(top.sum())} top face + "
          f"{int(wall.sum())} wall")
    ta = tp = tm = ti = 0
    for g, b in sorted(built.items()):
        n, mg = len(b["plates"]), len(b["merged"])
        ident = sum(len(v) - 1 for v in b["identical"])
        ta += len(b["approved"]); tp += n; tm += mg; ti += ident
        by = (sizes.get(f"{g}/clean.webp", 0)
              + sum(sizes.get(f"{g}/{p['key8']}.webp", 0) for p in b["plates"])) \
            if sizes else 0
        print(f"  {g:20s} {len(b['approved']):4d} approved -> {n:4d} plates + clean"
              f"  ({mg:3d} twins merged, worst {b['twin_delta_max']:2d} px;"
              f" {ident:3d} byte-identical to another plate)"
              f"{f'  {by:7d} B' if sizes else ''}")
    print(f"total: {ta} approved keys -> {tp} plates + {len(built)} clean"
          f" ({tm} twins merged, {ti} byte-identical), "
          f"{len(unresolved)} approved keys not in the review manifest")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--verify", action="store_true")
    a = ap.parse_args()
    if a.verify and not a.write:
        sys.exit(0 if verify() else 1)
    built, cand, unresolved = build()
    if not a.write:
        report(built, cand, unresolved)
        return
    from datetime import datetime, timezone
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc, sizes = write(built, cand, unresolved, stamp)
    report(built, cand, unresolved, sizes)
    sys.exit(0 if verify() else 1)


if __name__ == "__main__":
    main()
