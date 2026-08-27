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


MIN_HUE_SEP = 25.0   # opponent-space degrees between the two grounds' clean colours
MIN_CHROMA = 12.0    # opponent magnitude below which a pixel has no hue to judge


def _op(c):
    """Opponent channels (R-G, G-B): a colour's HUE signature, free of brightness."""
    c = np.asarray(c, float)
    return np.stack([c[..., 0] - c[..., 1], c[..., 1] - c[..., 2]], -1)


def split_masks(rgb, top, clean_a, clean_b):
    """(A-side mask, B-side mask) - each top pixel assigned to the ground it belongs to.

    BY HUE WHERE THE GROUNDS DIFFER IN HUE, by brightness where they do not. Nearest-RGB
    alone is dominated by VALUE, and that mismeasures every dark-on-dark blend: a dim
    lava ember (100,40,20) sits 161 from grass's clean (20,82,59) but 221 from lava's
    (253,90,2), so it counts as grass. Measured on the pilot, that error alone reported
    the p40 grass/lava sheet as 9% lava when it is 19%. Hue direction is invariant to how
    dark the ember is and gets it right.

    But hue is only a discriminator when the two grounds HAVE different hues: grey_stone
    against black_rock differ in value alone, and an angle between two near-greys is
    noise. So the rule falls back to RGB distance whenever the palette pair is closer
    than MIN_HUE_SEP, and per pixel whenever that pixel has no chroma of its own.
    """
    oa, ob = _op(clean_a), _op(clean_b)
    na, nb = float(np.hypot(*oa)), float(np.hypot(*ob))
    by_rgb = top & (np.abs(rgb - clean_a).sum(2) <= np.abs(rgb - clean_b).sum(2))
    if na < MIN_CHROMA or nb < MIN_CHROMA:
        return by_rgb, top & ~by_rgb
    cosab = float((oa[0] * ob[0] + oa[1] * ob[1]) / (na * nb))
    sep = np.degrees(np.arccos(max(-1.0, min(1.0, cosab))))
    if sep < MIN_HUE_SEP:
        return by_rgb, top & ~by_rgb
    o = _op(rgb)
    n = np.linalg.norm(o, axis=-1)
    da = (o[..., 0] * oa[0] + o[..., 1] * oa[1]) / (np.maximum(n, 1e-6) * na)
    db = (o[..., 0] * ob[0] + o[..., 1] * ob[1]) / (np.maximum(n, 1e-6) * nb)
    a = np.where(n >= MIN_CHROMA, da >= db, by_rgb) & top
    return a, top & ~a


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


def align(img, clean_a, clean_b):
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
    a_side, b_side = split_masks(rgb, top, clean_a, clean_b)
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
        clean_b = TP._hex(PALETTE[sheet["minor"]]["top"])
        d = os.path.join(REPO, sheet["dir"])
        post = os.path.join(d, "post")
        os.makedirs(post, exist_ok=True)
        post_files, fracs, measured, moved = [], [], [], []
        for name in sheet["tiles"]:
            aligned, frac, how, moved_b = align(Image.open(os.path.join(d, name)),
                                                clean_a, clean_b)
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
    # THE LADDER IS BUILT FROM THE MEASUREMENT, NOT FROM THE ORDER.
    # Measured on the pilot: the prompt level is a weak lever. One p10 sheet's 16 takes
    # spanned 0-30% lava and one p40 sheet spanned 0-40%, and the sheet means came out
    # non-monotone (11, 26, 22, 19, 42) even though the endpoints work. So the ordered
    # level is a SAMPLING knob - it moves the distribution, it does not set it - and
    # publishing pNN as if it were the mix would hand the maintainer five labels the art
    # contradicts. Instead every tile is filed under the decile it actually measures,
    # which makes the label true by construction and turns the wide spread from a defect
    # into coverage: 64 pilot tiles filled 5-45% densely.
    # Below 5% a tile is just plain A (that belongs in tiles/tops, not here); above 55%
    # it is dominated by B, and its background was aligned to A's clean colour, so it
    # would sit wrong in a B field - both are dropped rather than mislabelled.
    buckets = {}
    for sheet in out_sheets:
        meas = sheet.get("measured_tiles") or []
        pf = sheet.get("post_files") or []
        key = f'{sheet["dominant"]}__with__{sheet["minor"]}'
        for i, m in enumerate(meas):
            if m is None or m < 5.0 or m > 55.0:
                continue
            b = min(LEVELS, key=lambda L: abs(L - m))
            buckets.setdefault(key, {}).setdefault(str(b), []).append({
                "dir": sheet["dir"], "i": i,
                "file": pf[i] if i < len(pf) else None,
                "raw": sheet["tiles"][i], "measured": m, "ordered": sheet["pct_minor"],
            })
    for k in buckets:
        for b in buckets[k]:
            buckets[k][b].sort(key=lambda e: e["measured"])
    doc = {
        "schema": "tiles3/blends-ladder@1", "kind": idx["kind"],
        "use_for": idx["use_for"], "wall_is_meaningless": True,
        "levels": list(LEVELS), "n_sheets": len(out_sheets), "sheets": out_sheets,
        "buckets": buckets,
    }
    doc["bucket_rule"] = (
        "THE LADDER. buckets[<dominant>__with__<minor>][<10|20|30|40|50>] = the tiles "
        "whose MEASURED minor-ground area is nearest that decile; `measured` is the real "
        "mix, `ordered` only records which prompt produced it. Render from these, not "
        "from pct_minor - the prompt level moves the distribution but does not set it. "
        "Art is at <dir>/post/<file>; below 5% and above 55% are excluded."
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
    tot = sum(len(v) for k in buckets for v in buckets[k].values())
    per = {b: sum(len(buckets[k].get(str(b), [])) for k in buckets) for b in LEVELS}
    print(f"ladder: {tot} tiles filed by measured mix  " +
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
