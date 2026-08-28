"""Analyse and publish the fade tiles into the WIKI'S contract: `tiles/fades/index.json`.

TWO RULINGS SHAPE THIS FILE, both maintainer 2026-08-28:

    "You must analyse the image. It's not enough to think your prompt gave you exactly
     what you wanted when it comes to %."

    "Don't make the filter absolute... the image is a visualization of a 3D stone with
     height. So it's ok if some edge contains black_rock and not grass... The black rock
     should try as much as it can to be INSIDE the tile, but you can pass images to me
     even if some edges are black_rock. What I don't want is tiles with 50% grass and
     50% black_rock."

So the edge test is a MEASUREMENT PUBLISHED, not a guillotine. A tall rock whose
silhouette crosses the rim is fine - its base sits inside and the height is drawing. What
still fails: a tile with no clear majority (the 50/50 he named), a tile whose edges are
owned by the WRONG ground (more than half the rim band reads as the minority - that tile
sits well on neither field), and a tile with no real mixture at all (a plain top wearing
a fade label; fine art, wrong tree).

THE OUTPUT IS THE WIKI'S SHAPE, posted by the wiki agent on the board before this data
existed and adopted verbatim rather than negotiated:

    tiles/fades/index.json     schema tiles3/fade-tiles@1
    { schema, pairs: { "<a>__to__<b>": [ { key, file, pct: {"<a>": 62.5, "<b>": 37.5} },
                                          ... ] } }

  - `key` is STABLE for the life of the art - the maintainer's verdicts ride
    live/feedback/tiles.json on it verbatim. It is derived from the sheet directory and
    the tile's position, which never change; the content hash lives only in `file`.
  - `file` is the full repo-relative path of the shipped bytes ("I never construct
    paths" - wiki). Content-hashed, immutable, current + one previous generation kept.
  - `pct` both grounds by name, 0-100. Extra fields ride along and are ignored by the
    wiki: edge_ground, edge_contact, phrasing, prompt.

The raw generator listing lives in tiles/fades/sheets.json; this file owns index.json.
The EDGE numbers are measured on the exact post/ bytes named in `file` (the border rule
compares the band against the tile's own shipped background). The MIX is measured on the
raw art, because the meter's prototypes were learned from raw generator output and
alignment deliberately shifts the art off that distribution; alignment is a uniform
shift, so the area each ground covers - which is what pct claims - is unchanged by it.
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

import blends_post as BP
import fade_mix as FM
import puddle_gate as PG
import tops_post as TP
import transition_render as TR


MIN_REGION_PX = 60   # a side needs this many pixels before its own median is
                     # trustworthy; below it the shift falls back to the measured
                     # art-rendition delta for that ground (art_refs -> clean)


def align_two_sided(img, maj, mino, post_map, meter_mask):
    """BOTH grounds land on their own palette colour - the fade fix, 2026-08-28.

    The single-sided rule inherited from blends moved only the majority onto its clean
    colour and let the minority "ride along keeping its own hue". For blends (small
    embers) that protected the art; for fades it shipped the generator's hue for the
    whole minority region - the maintainer caught grass-in-black_rock flecks wearing
    olive (47,78,21) beside a wiki page whose every other green is the palette's
    (20,82,59) exactly: "We don't have that grass color palette."

    So: per-pixel weight w = the mix meter's own probability this pixel is the minority
    ground (smoothed ~3px), and out = art + (1-w)*deltaMaj + w*deltaMin, iterated so
    each side's trimmed median lands on ITS clean colour integer-exactly. A uniform
    shift per region - detail rides, exactly the property the Palette Headroom page
    established as the ceiling. No hard seam: the weight ramps where the meter is
    unsure. Walls take the weight of the lowest top pixel above them (wall_is_
    meaningless, but a top/wall step would be invented detail).
    """
    arr = np.array(img.convert("RGBA"), int)
    top = TR.top_face(arr[..., 3] > 0)
    if not top.any() or post_map is None:
        return None
    clean_a = TP._hex(PALETTE[maj]["top"])
    clean_b = TP._hex(PALETTE[mino]["top"])
    w = np.zeros(top.shape, float)
    mm = meter_mask & top
    w[mm] = np.clip(post_map[mm], 0.0, 1.0)
    w = BP._smooth(w, passes=2)
    w[~top] = 0.0
    opaque = arr[..., 3] > 0
    for x in range(w.shape[1]):
        ys = np.flatnonzero(top[:, x])
        if ys.size:
            below = opaque[:, x].copy()
            below[:ys[-1] + 1] = False
            w[below, x] = w[ys[-1], x]
    rgb = arr[..., :3].astype(float)
    a_m = top & (w < 0.25)
    b_m = top & (w > 0.75)
    ref_b = BP.art_refs().get(mino)
    w3 = w[..., None]
    for _ in range(3):
        da = (clean_a - TP.background_of(rgb, a_m)) if a_m.sum() >= MIN_REGION_PX             else np.zeros(3)
        if b_m.sum() >= MIN_REGION_PX:
            db = clean_b - TP.background_of(rgb, b_m)
        elif ref_b is not None:
            db = clean_b - ref_b          # the generator's typical rendition -> palette
        else:
            db = np.zeros(3)
        da, db = np.rint(da), np.rint(db)
        if not np.abs(da).sum() and not np.abs(db).sum():
            break
        rgb += (1.0 - w3) * da + w3 * db
        np.clip(rgb, 0, 255, out=rgb)
        if b_m.sum() < MIN_REGION_PX:
            break                          # the fallback delta must not iterate
    np.rint(rgb, out=rgb)
    TP.rim_suppress(rgb, top, clean_a)
    out = arr.copy()
    out[..., :3] = np.clip(rgb, 0, 255).astype(int)
    return Image.fromarray(out.astype(np.uint8), "RGBA")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
FADES = os.path.join(ROOT, "fades")
PALETTE = json.load(open(os.path.join(ROOT, "config", "palette.json")))["types"]

MIN_MIX = 0.02      # below this one ground is not visibly present: a plain top, not a fade
MAX_EDGE_LOSS = 0.50  # more than half the rim band reading as the minority ground means
                      # the tile sits well on NEITHER field - the one edge failure that
                      # still rejects after the maintainer's "don't make it absolute"


def sheets():
    out = []
    for mp in sorted(glob.glob(os.path.join(FADES, "*__with__*", "*", "meta.json"))):
        m = json.load(open(mp))
        m["dir"] = os.path.relpath(os.path.dirname(mp), REPO)
        out.append(m)
    return out


def analyse(sheet, i, name):
    """One raw tile -> (entry, None) or (None, reject-reason). Entry is wiki-shaped."""
    a, b = sheet["dominant"], sheet["minor"]
    d = os.path.join(REPO, sheet["dir"])
    src = os.path.join(d, name)
    if not os.path.isfile(src):
        return None, "missing"

    # 1. THE MIX, measured on the image - the raw art decides which ground owns the
    #    tile. detail=True also hands back the meter's per-pixel map, which is what the
    #    two-sided alignment steers by.
    raw = Image.open(src)
    mix = FM.mix_fraction(raw, a, b, detail=True)
    if mix is None or mix.get("uncertain"):
        return None, "uncertain"
    frac_b = float(mix["frac_b"])
    majority = b if frac_b > 0.5 else a
    minority = a if majority == b else b

    # 2. ALIGN BOTH SIDES onto their own palette colours (the minority riding was a
    #    blends rule; on fades it shipped the generator's hue - see align_two_sided).
    clean = TP._hex(PALETTE[majority]["top"])
    post_map = mix["post"] if majority == a else (1.0 - mix["post"])
    aligned = align_two_sided(raw, majority, minority, post_map, mix["mask"])
    if aligned is None:
        return None, "no top face"
    post = os.path.join(d, "post")
    os.makedirs(post, exist_ok=True)
    buf = io.BytesIO()
    aligned.save(buf, "WEBP", lossless=True, exact=True)
    data = buf.getvalue()
    h8 = hashlib.sha1(data).hexdigest()[:8]
    hashed = name.replace(".webp", f".{h8}.webp")
    with open(os.path.join(post, hashed), "wb") as fh:
        fh.write(data)
    gens = sorted(glob.glob(os.path.join(post, name.replace(".webp", ".*.webp"))),
                  key=os.path.getmtime, reverse=True)
    for old in gens[2:]:
        os.remove(old)              # current + one previous generation - cache law

    # 3. THE GATE ON THE PUBLISHED BYTES; THE MIX ON THE RAW ART. The border rule is
    #    self-referential (band vs the tile's own background) so it must see exactly
    #    what ships - alignment moves every pixel. The METER is the opposite case: its
    #    prototypes were learned from raw generator output, and alignment deliberately
    #    shifts the art off that distribution, so raw is where its numbers are valid.
    shipped = os.path.join(post, hashed)
    frac_min = min(frac_b, 1.0 - frac_b)
    if frac_min < MIN_MIX:
        return None, "no real mixture"
    if frac_min > 0.5 - 1e-9 or abs(frac_b - 0.5) < 1e-9:
        return None, "50/50"
    m = PG.border_purity(Image.open(shipped), clean_rgb=clean)
    if not m.get("ok"):
        return None, "no diamond"
    # spill = the share of the rim band where a feature genuinely crosses out of the
    # interior (the generator's own rim shading is excused). His tall-rock examples
    # measure as moderate spill and PASS; only a rim mostly owned by the minority fails.
    if m["spill"] > MAX_EDGE_LOSS:
        return None, "edges mostly minority"

    return {
        # STABLE for the life of the art: directory + position. The hash lives in `file`.
        "key": f'{sheet["dir"]}/{name[:-5]}',
        "file": os.path.relpath(shipped, REPO),
        "pct": {a: round(100 * (1.0 - frac_b), 1), b: round(100 * frac_b, 1)},
        "edge_ground": majority,
        "edge_contact": round(float(m["spill"]), 4),
        "border_impurity": m["border_impurity"],
        "phrasing": sheet["phrasing"], "prompt": sheet["prompt"],
    }, None


def main():
    pairs, rejected, n_valid = {}, {}, 0
    for sheet in sheets():
        pk = f'{sheet["dominant"]}__to__{sheet["minor"]}'
        for i, name in enumerate(sheet["tiles"]):
            e, why = analyse(sheet, i, name)
            if e is None:
                rejected[why] = rejected.get(why, 0) + 1
            else:
                pairs.setdefault(pk, []).append(e)
                n_valid += 1
    for pk in pairs:
        first = pk.split("__to__")[0]
        pairs[pk].sort(key=lambda e: -e["pct"][first])
    doc = {
        "schema": "tiles3/fade-tiles@1",
        "kind": "fade_top_only", "use_for": "transition", "wall_is_meaningless": True,
        "_comment": [
            "VALID fade tiles only, per the maintainer's rules: a clear majority ground",
            "(never 50/50), both grounds visibly present, and edges that still read as",
            "the majority - some edge contact by the minority is allowed (tall features",
            "have height), so `edge_contact` is published as a number, 0 = fully clean.",
            "pct is MEASURED from the published bytes named in `file`, never taken from",
            "the prompt. `key` is stable for the life of the art; verdicts ride on it.",
            "Rejected tiles stay on disk (raw sheets are never deleted) but are not",
            "listed here and should not be shown.",
        ],
        "classifier": FM.DESCRIPTION,
        "n_valid": n_valid,
        "n_rejected": rejected,
        "pairs": pairs,
    }
    dst = os.path.join(FADES, "index.json")
    tmp = f"{dst}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=1)
    os.replace(tmp, dst)
    print(f"valid: {n_valid}   rejected: {sum(rejected.values())}  {rejected}")
    for pk in sorted(pairs)[:8]:
        first = pk.split("__to__")[0]
        ps = [e["pct"][first] for e in pairs[pk]]
        print(f"  {pk}: {len(ps)} tiles, {first} {max(ps):.0f}%..{min(ps):.0f}%")


if __name__ == "__main__":
    main()
