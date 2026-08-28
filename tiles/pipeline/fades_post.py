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
    wiki: edge_ground, edge_contact, spill, phrasing, prompt.

The raw generator listing lives in tiles/fades/sheets.json; this file owns index.json.
Every published number is measured on the exact post/ bytes named in `file`, never on the
raw sheet and never on the prompt.
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

    # 1. THE MIX, measured on the image - the raw art decides which ground owns the tile.
    raw = Image.open(src)
    mix = FM.mix_fraction(raw, a, b)
    if mix is None or mix.get("uncertain"):
        return None, "uncertain"
    frac_b = float(mix["frac_b"])
    majority = b if frac_b > 0.5 else a
    minority = a if majority == b else b

    # 2. ALIGN toward the majority's clean colour: this tile will sit in a field of that
    #    ground. The minority rides the weighted delta and keeps its own hue.
    clean = TP._hex(PALETTE[majority]["top"])
    ref_o = BP.art_refs().get(minority, TP._hex(PALETTE[minority]["top"]))
    aligned, _f, _how, _mv = BP.align(raw, clean, ref_o)
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

    # 3. EVERY PUBLISHED NUMBER FROM THE PUBLISHED BYTES.
    shipped = os.path.join(post, hashed)
    mix2 = FM.mix_fraction(Image.open(shipped), a, b)
    if mix2 is None or mix2.get("uncertain"):
        return None, "uncertain on post"
    frac_b = float(mix2["frac_b"])
    if (b if frac_b > 0.5 else a) != majority:
        return None, "majority flipped in post"
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
