"""Align every BLEND tile's dominant-ground background onto that ground's clean colour.

Same law as tops_post, one genuine difference: a blend has TWO materials, so "the
background" is ambiguous and the trimmed median of the whole top face answers the wrong
question - at p50 it lands somewhere between the two grounds and would drag the tile off
BOTH palettes.

WE ALIGN THE DOMINANT PORTION. Top pixels are split by which clean colour they sit
nearer (A's or B's), the trimmed median is taken over the A-side pixels only, and the
whole tile is shifted by that one delta. So:

  - the A-portion lands exactly on A's clean colour - a p10 tile drops into a field of
    plain A with no border, which is the entire point of the ladder ("start ease in a
    change in base tile change long before the base tile change is enforced");
  - the B-portion rides along on the same delta, keeping its contrast against A intact.
    Snapping it to B's palette separately would flatten the blend into two flat colours
    and destroy the drift.

The A-side split needs pixels to be honest: below MIN_SIDE the tile is treated as
un-splittable and the plain top-face median is used, flagged `split: "whole"` in the
index so the audition can show it for what it is.

Rim suppression carries over unchanged and needs no special case: it snaps only rim
pixels NEAR A's clean colour, so an A rim loses its bevel while a B patch crossing the
edge is far away and passes straight through.

Output sits beside the raw tiles under content-hashed names (`post/tile_NN.<sha8>.webp`)
- the immutability law, enforced by check_immutable.py.
"""

from __future__ import annotations

import glob
import hashlib
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
from PIL import Image

import blends as BL
import tops_post as TP
import transition_render as TR

LEVELS = BL.LEVELS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
BLENDS = os.path.join(ROOT, "blends")
PALETTE = json.load(open(os.path.join(ROOT, "config", "palette.json")))["types"]

MIN_SIDE = 120       # top-face pixels needed before the A-side median is trustworthy
                     # (the top face is ~1450 px, so this is ~8% of the tile)


B_AT = 0.5          # a pixel is the minor ground once it is more than halfway from
                    # this tile's own background toward the minor ground's clean colour
MIN_TRAVEL = 24.0   # if the two grounds are closer than this in RGB there is no axis to
                    # project onto and the tile is treated as all-dominant


_REFS = None


def art_refs():
    """How the generator ACTUALLY draws each ground, measured from the blend tree.

    The palette's clean colour is a target, not a description. Anchoring the split on it
    fails in both directions and the failures do not look alike: black_rock's clean is
    near-black with no chroma, so a hue test cannot run at all; grass's clean is DARK
    while the generator draws grass bright, so the axis from dark mud toward clean grass
    points the wrong way and a bright grass pixel projects to zero - measured, that
    reported a dark_mud/grass p50 sheet as 0.0% grass.

    Both are the same mistake: assuming the art looks like the palette. So the minor
    ground's anchor is measured instead - the trimmed-median background of the p10 sheets
    where that ground is DOMINANT, which is the same prompt family and therefore the same
    rendition. Sampled, cached per run, and falls back to the clean colour only for a
    ground with no sheets on disk yet.
    """
    global _REFS
    if _REFS is not None:
        return _REFS
    _REFS = {}
    for d in sorted(glob.glob(os.path.join(BLENDS, "*__with__*", "p10"))):
        g = os.path.basename(os.path.dirname(d)).split("__with__")[0]
        if len(_REFS.setdefault(g, [])) >= 12:
            continue
        for f in sorted(glob.glob(os.path.join(d, "tile_*.webp")))[:3]:
            a = np.array(Image.open(f).convert("RGBA"), int)
            t = TR.top_face(a[..., 3] > 0)
            if t.any():
                _REFS[g].append(TP.background_of(a[..., :3].astype(float), t))
    _REFS = {g: np.median(np.array(v), 0) for g, v in _REFS.items() if v}
    return _REFS


def split_masks(rgb, top, clean_a, ref_b):
    """(dominant mask, minor mask), measured RELATIVE TO THIS TILE'S OWN BACKGROUND.

    Comparing each pixel to the two palette colours in the absolute is what a reasonable
    person writes first, and it fails exactly where the generator's rendition of a ground
    sits far from that ground's clean colour. Measured: black_rock's clean is (30,29,30),
    near-black with no chroma at all, so a hue test cannot run and RGB distance simply
    cuts the rock in half by BRIGHTNESS - it reported 61% of a black_rock/deep_water tile
    as deep water, and the median of that "water" is (44,47,52), which is rock. Every
    p10 sheet of that pair came out over 55% minor and was dropped from the ladder.

    The tile's own background does not have that problem. It is the trimmed median of the
    top face - the majority colour, feature-proof (tops_post) - so it IS the dominant
    ground as this tile actually draws it, whatever the palette says. Each pixel is
    projected onto the axis from that background toward the minor ground's clean colour,
    and counts as minor once it travels more than halfway. Nothing depends on the
    dominant ground's clean colour being an accurate description of the art, which is the
    assumption that broke.
    """
    bg = TP.background_of(rgb, top)
    d = ref_b - bg
    travel = float(np.linalg.norm(d))
    if travel < MIN_TRAVEL:
        return top.copy(), np.zeros_like(top)
    t = ((rgb - bg) @ (d / travel)) / travel
    b = top & (t > B_AT)
    return top & ~b, b


def _smooth(m, passes=3):
    """3x3 box mean, `passes` times - a ~3px ramp with no scipy dependency."""
    f = m.astype(float)
    for _ in range(passes):
        acc = f.copy()
        n = np.ones_like(f)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1),
                       (-1, -1), (-1, 1), (1, -1), (1, 1)):
            sh = np.roll(np.roll(f, dy, 0), dx, 1)
            acc += sh
            n += 1
        f = acc / n
    return np.clip(f, 0.0, 1.0)


def align(img, clean_a, ref_b):
    """(aligned image, A-side fraction, which mask drove the shift, max |delta| on B).

    THE DELTA IS WEIGHTED, NOT GLOBAL. Shifting the WHOLE tile by the A-side's delta is
    what a single-material tile wants, and it is actively destructive here: measured on
    the pilot, grass's delta is (-16,-107,+50) - the generator draws vivid green where
    the palette's clean grass is dark - and applying that to an orange lava pixel
    (253,90,2) drives green to zero and renders it MAGENTA. A whole field of pink lava,
    from a transform whose only job was to move the background.

    So the delta is applied through a weight: 1 deep inside the A-side, 0 deep inside the
    B-side, ramped over ~3px between. Grass still lands exactly on its clean colour
    (interiors carry the full delta, and the background is a median over them), lava
    keeps its own hue, and there is no hard seam where the weight turns over - the ramp
    is narrower than the features it crosses.
    """
    arr = np.array(img.convert("RGBA"), int)
    top = TR.top_face(arr[..., 3] > 0)
    if not top.any():
        return None, 0.0, "none", 0.0
    rgb = arr[..., :3].astype(float)
    a_side, b_side = split_masks(rgb, top, clean_a, ref_b)
    frac = float(a_side.sum()) / float(top.sum())
    measure, how = (a_side, "dominant") if a_side.sum() >= MIN_SIDE else (top, "whole")
    w = _smooth(a_side)
    # The wall hangs below its top face and rides along with it: each column takes the
    # weight of the lowest top pixel above it, so the top/wall boundary stays continuous
    # instead of gaining a step this pass invented.
    opaque = arr[..., 3] > 0
    for x in range(w.shape[1]):
        ys = np.flatnonzero(top[:, x])
        if ys.size:
            below = opaque[:, x].copy()
            below[:ys[-1] + 1] = False
            w[below, x] = w[ys[-1], x]
    w3 = w[..., None]
    before = rgb.copy()
    for _ in range(3):
        bg = TP.background_of(rgb, measure)
        delta = np.rint(clean_a - bg)
        if not np.abs(delta).sum():
            break
        rgb += w3 * delta
        np.clip(rgb, 0, 255, out=rgb)
    np.rint(rgb, out=rgb)
    TP.rim_suppress(rgb, top, clean_a)
    # The 95th percentile, not the max: the ramp is 3px wide, so a handful of pixels
    # right at the turnover always carry most of the delta. Measured on grass/light_beach
    # the max read 254/255 while the art is correct - sand stays sand - because that max
    # was one ramp pixel. p95 tracks whether the MINOR GROUND as a whole is being dragged,
    # which is the thing that would show.
    moved_b = (float(np.percentile(np.abs(rgb - before)[b_side], 95))
               if b_side.any() else 0.0)
    out = arr.copy()
    out[..., :3] = np.clip(rgb, 0, 255).astype(int)
    return Image.fromarray(out.astype(np.uint8), "RGBA"), frac, how, moved_b


def main():
    # ONE WRITER PER FILE. index.json belongs to the GENERATOR, which rebuilds it from a
    # filesystem scan after every sheet - so anything this pass wrote into it was erased
    # the moment the next sheet landed (measured: the buckets vanished mid-run). The post
    # pass reads that file and owns a separate one.
    idx = json.load(open(os.path.join(BLENDS, "index.json")))
    out_sheets = []
    wrote = whole = 0
    worst_moved = []
    for sheet in idx["sheets"]:
        clean_a = TP._hex(PALETTE[sheet["dominant"]]["top"])
        # the minor ground as the ART draws it; the palette colour only as a fallback
        ref_b = art_refs().get(sheet["minor"], TP._hex(PALETTE[sheet["minor"]]["top"]))
        d = os.path.join(REPO, sheet["dir"])
        post = os.path.join(d, "post")
        os.makedirs(post, exist_ok=True)
        post_files, fracs, measured, moved = [], [], [], []
        for name in sheet["tiles"]:
            aligned, frac, how, moved_b = align(Image.open(os.path.join(d, name)),
                                                clean_a, ref_b)
            if aligned is None:
                post_files.append(None)
                measured.append(None)      # both lists stay index-aligned with `tiles`
                continue
            buf = io.BytesIO()
            aligned.save(buf, "WEBP", lossless=True, exact=True)
            data = buf.getvalue()
            h8 = hashlib.sha1(data).hexdigest()[:8]
            hashed = name.replace(".webp", f".{h8}.webp")
            with open(os.path.join(post, hashed), "wb") as fh:
                fh.write(data)
            post_files.append(hashed)
            # Current + one previous generation - a hashed name can only ever serve
            # identical bytes, while deleting it 404s pages already open (that is what
            # put holes in the maintainer's audition).
            gens = sorted(glob.glob(os.path.join(post, name.replace(".webp", ".*.webp"))),
                          key=os.path.getmtime, reverse=True)
            for old_f in gens[2:]:
                os.remove(old_f)
            fracs.append(frac)
            measured.append(round(100.0 * (1.0 - frac), 1))
            whole += how == "whole"
            moved.append(moved_b)
            wrote += 1
        worst_moved += moved
        rec = {k: sheet[k] for k in
               ("dir", "dominant", "minor", "pct_minor", "prompt", "seed", "tiles")}
        rec["post_files"] = post_files
        sheet = rec
        out_sheets.append(rec)
        # THE MEASURED MIX, beside the asked-for one. `pct_minor` is what we ORDERED;
        # this is what the art actually contains, per sheet, by nearest-clean-colour.
        # A generator does not measure area, so the ladder is only as monotone as the
        # art - publishing both lets the wiki sort by the real thing.
        if fracs:
            sheet["measured_pct_minor"] = round(100.0 * (1.0 - sum(fracs) / len(fracs)), 1)
            # PER TILE, because the maintainer picks TILES, not sheets. One sheet's 16
            # takes measured 0-20% minor against an ordered 10% - a sheet mean would hide
            # both ends. Aligned with `tiles`/`post_files` by index.
            sheet["measured_tiles"] = measured
    # THE LADDER IS KEYED BY THE LEVEL THAT WAS ORDERED. That is what the maintainer
    # asked for ("10% ground-type B, 20% ground-type B, ..."), and it is the only key
    # that is reliable for every pair.
    #
    # Filing tiles by a MEASURED mix was tried first and abandoned, because no measure
    # survived contact with all 210 pairs. Three were built and each failed differently:
    # nearest-palette-colour cut black rock in half by brightness and called the lighter
    # half deep water; an opponent-hue test cannot run at all on black_rock, whose clean
    # colour has no chroma; and projecting onto the axis toward the minor ground's colour
    # fails whenever the generator's rendition sits somewhere else - it read a dark_mud/
    # grass sheet as 0.2% grass when the art plainly shows grass tufts, because the
    # generator draws grass bright while the palette's clean grass is dark. The generator
    # even renders the SAME ground differently depending on its partner (water is bright
    # in water sheets, near-black inside rock), so no single per-ground reference exists.
    #
    # The measure is published anyway as `minor_seen`, clearly advisory: it is accurate on
    # high-contrast pairs (grass/lava, grass/light_beach) and unreliable on low-contrast
    # ones (mud/grass, brown/grey paving). It is a sorting hint for the audition, never a
    # label and never a filter - the maintainer reviews and rejects tiles himself, which
    # is the workflow every other tiles surface already uses.
    ladder = {}
    for sheet in out_sheets:
        meas = sheet.get("measured_tiles") or []
        pf = sheet.get("post_files") or []
        key = f'{sheet["dominant"]}__with__{sheet["minor"]}'
        ents = []
        for i, name in enumerate(sheet["tiles"]):
            if i >= len(pf) or not pf[i]:
                continue
            ents.append({"dir": sheet["dir"], "i": i, "file": pf[i], "raw": name,
                         "minor_seen": meas[i] if i < len(meas) else None})
        if ents:
            ladder.setdefault(key, {})[str(sheet["pct_minor"])] = ents
    doc = {
        "schema": "tiles3/blends-ladder@2", "kind": idx["kind"],
        "use_for": idx["use_for"], "wall_is_meaningless": True,
        "levels": list(LEVELS), "n_sheets": len(out_sheets), "sheets": out_sheets,
    }
    doc["ladder"] = ladder
    doc["ladder_rule"] = (
        "THE LADDER. ladder[<dominant>__with__<minor>][<10|20|30|40|50>] = the tiles "
        "generated for that level, in sheet order. Art is at <dir>/post/<file> - read "
        "the name, never build it. `minor_seen` is an ADVISORY estimate of how much of "
        "the minor ground the tile actually shows: accurate on high-contrast pairs, "
        "unreliable on low-contrast ones, so sort by it if it helps and never label or "
        "filter with it."
    )
    doc["post_pass"] = {
        "rule": "out = art + (clean_dominant - background_of_the_dominant_portion); top "
                "pixels are split by nearest clean colour and only the dominant side is "
                "measured, so the tile drops into a plain field of its dominant ground "
                "with no border while the minor ground keeps its contrast",
        "dir": "<sheet>/post/<name from sheet.post_files - NEVER constructed by convention>",
        "immutable": "a regenerated tile gets a new content-hashed filename; current + one "
                     "previous generation are retained so an open page keeps rendering",
        "measured_pct_minor": "the mix actually present in the art (nearest-clean-colour "
                              "area), beside pct_minor which is what was ordered",
        "measured_tiles": "the same measure PER TILE, index-aligned with `tiles` and "
                          "`post_files`; a sheet's 16 takes vary widely around the "
                          "ordered level, so sort and label by this, not by pct_minor",
    }
    dst = os.path.join(BLENDS, "ladder.json")
    tmp = f"{dst}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=1)
    os.replace(tmp, dst)
    print(f"aligned {wrote} blend tiles ({whole} fell back to the whole-top median); "
          f"worst minor-ground pixel moved {max(worst_moved or [0]):.0f}/255")
    tot = sum(len(v) for k in ladder for v in ladder[k].values())
    per = {b: sum(len(ladder[k].get(str(b), [])) for k in ladder) for b in LEVELS}
    print(f"ladder: {tot} tiles over {len(ladder)} ordered pairs  " +
          "  ".join(f"p{b}={n}" for b, n in per.items()))
    if out_sheets:
        rows = [(s.get("measured_pct_minor"), s["pct_minor"],
                 f'{s["dominant"]}+{s["minor"]}') for s in out_sheets
                if s.get("measured_pct_minor") is not None]
        for pair in sorted({r[2] for r in rows})[:4]:
            got = sorted((r[1], r[0]) for r in rows if r[2] == pair)
            print("   " + pair + ": " +
                  "  ".join(f"p{o:02d}->{m:.0f}%" for o, m in got))


if __name__ == "__main__":
    main()
