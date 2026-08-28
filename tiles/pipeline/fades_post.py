"""Analyse, gate and publish the fade tiles: `tiles/fades/mix.json`.

The maintainer's contract, 2026-08-28, and every clause is implemented here:

    "You must analyse the image. It's not enough to think your prompt gave you exactly
     what you wanted when it comes to %."

    "If the tile has grass on all top edges it means the tile can be placed on grass and
     look good/seamless... A tile that can be placed seamless on ice must have more than
     50% ice in the metadata... Tiles that doesn't have all 4 edges either grass or ice
     cannot be used. They are invalid 'fading tiles' and should not show up in the wiki."

So per tile, measured on the image and never inferred from the prompt:

  edge test   all four sides of the top diamond belong to ONE of the pair's two grounds.
              This is puddle_gate.border_purity: the band (the outer three erosion rings,
              derived from the lattice) must be consistent with the tile's OWN
              trimmed-median background - which for any valid fade IS the majority ground,
              because a ground that owns all four edges and the rim band is the majority.
              A tile whose edges are a mix of both grounds has a band inconsistent with
              any single background and fails. No dominant-vs-minor classifier involved.

  edge_ground which of the two named grounds owns those edges - decided on the
              whole-tile background by the shipped mix classifier's labelling, never on
              single pixels.

  pct         the fraction of the top face that is each ground, from fade_mix (the
              classifier that survived adversarial cross-testing against synthesised
              ground truth). Published per ground by name, so no consumer ever has to
              know which side of the pair was "dominant" in the directory name.

  consistency edge_ground must BE the measured majority (>50%). The maintainer ties
              placement to the majority explicitly; a ring of ice around mostly-grass
              would carry a lying label, so it is invalid rather than mislabelled.

INVALID TILES ARE OMITTED, NOT DELETED. mix.json lists only valid tiles; the raw sheets
stay on disk untouched ("don't delete anything you have already generated" - and the
maintainer may still harvest good art from them by hand).

ALIGNMENT FOLLOWS THE EDGES. A fade tile lives in a field of its edge ground, so its
background is aligned onto THAT ground's palette clean colour (the weighted delta from
blends_post: interiors of the other ground ride along and keep their own hue). Alignment
happens before the gate, and every published number is measured on the exact post/ bytes
a consumer downloads - raw and post disagree on about a fifth of gate passes.
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

MIN_MIX = 0.02       # below this the tile is a plain top of one ground, not a fade -
                     # fine art, wrong tree (tiles/tops is where plain tops live)


def gate(path, edge_ground):
    """The maintainer's edge rule, on the shipped bytes."""
    m = PG.border_purity(Image.open(path),
                         clean_rgb=TP._hex(PALETTE[edge_ground]["top"]))
    return m


def analyse(sheet, name):
    """One raw tile -> (published filename, entry dict) or (None, reason)."""
    a, b = sheet["dominant"], sheet["minor"]
    d = os.path.join(REPO, sheet["dir"])
    src = os.path.join(d, name)
    if not os.path.isfile(src):
        return None, "missing"

    # 1. WHICH GROUND OWNS THIS TILE - measured on the image, not read off the dir name.
    #    fade_mix returns the fraction of ground B and the labelling it trusted; the
    #    majority ground is the placement side and the alignment target.
    raw = Image.open(src)
    mix = FM.mix_fraction(raw, a, b)
    if mix is None or mix.get("uncertain"):
        return None, "uncertain"
    frac_b = float(mix["frac_b"])
    edge_ground = b if frac_b > 0.5 else a
    other = a if edge_ground == b else b

    # 2. ALIGN toward the edge ground's clean colour; the other ground rides the
    #    weighted delta and keeps its own hue.
    clean = TP._hex(PALETTE[edge_ground]["top"])
    ref_o = BP.art_refs().get(other, TP._hex(PALETTE[other]["top"]))
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
        os.remove(old)          # current + one previous generation, cache law

    # 3. EVERY PUBLISHED NUMBER FROM THE PUBLISHED BYTES.
    shipped = os.path.join(post, hashed)
    mix2 = FM.mix_fraction(Image.open(shipped), a, b)
    if mix2 is None or mix2.get("uncertain"):
        return None, "uncertain on post"
    frac_b = float(mix2["frac_b"])
    majority = b if frac_b > 0.5 else a
    if majority != edge_ground:
        return None, "majority flipped between raw and post"
    m = gate(shipped, edge_ground)
    if not m.get("ok"):
        return None, "no diamond"
    frac_edge = frac_b if edge_ground == b else 1.0 - frac_b
    entry = {
        "dir": sheet["dir"], "raw": name, "file": hashed,
        "grounds": [a, b],
        "pct": {a: round(100 * (1.0 - frac_b), 1), b: round(100 * frac_b, 1)},
        "edge_ground": edge_ground,
        "border_impurity": m["border_impurity"], "spill": m["spill"],
        "phrasing": sheet["phrasing"], "prompt": sheet["prompt"],
    }
    # THE MAINTAINER'S THREE CLAUSES, as one boolean:
    #   all four edges one ground     -> the band is pure (spill catches a real crossing;
    #                                    the generator's own rim shading is excused, the
    #                                    alignment pass already suppressed it)
    #   that ground is the majority   -> frac_edge > 0.5 (checked above via majority)
    #   it is actually a fade         -> both grounds visibly present
    valid = (m["is_puddle_ground"]
             and frac_edge > 0.5
             and MIN_MIX <= min(frac_b, 1.0 - frac_b))
    if not valid:
        why = ("edges mixed" if not m["is_puddle_ground"]
               else "no real mixture" if min(frac_b, 1.0 - frac_b) < MIN_MIX
               else "majority mismatch")
        return None, why
    return hashed, entry


def main():
    idx = json.load(open(os.path.join(FADES, "index.json")))
    valid, rejected = [], {}
    for sheet in idx["sheets"]:
        for name in sheet["tiles"]:
            f, res = analyse(sheet, name)
            if f is None:
                rejected[res] = rejected.get(res, 0) + 1
            else:
                valid.append(res)
    pages = {}
    for e in valid:
        a, b = sorted(e["grounds"])
        pages.setdefault(f"{a}__and__{b}", []).append(e)
    for k in pages:
        # THE WIKI'S SORT ORDER, precomputed: by the fraction of the lexicographically
        # second ground, so one page runs 95% A ... 50/50 ... 95% B in one sweep.
        second = k.split("__and__")[1]
        pages[k].sort(key=lambda e: e["pct"][second])
    doc = {
        "schema": "tiles3/fades-mix@1", "kind": "fade_top_only",
        "use_for": "transition", "wall_is_meaningless": True,
        "rule": (
            "VALID FADE TILES ONLY - measured on the exact published bytes, never on the "
            "prompt. A tile is here iff all four sides of its top diamond are its "
            "majority ground (so it places seamlessly on that ground), the majority is "
            ">50% by measured area, and both grounds are visibly present. `pct` gives "
            "the measured percentage per ground BY NAME; `edge_ground` is the ground the "
            "tile sits on. Invalid tiles are omitted, not deleted - do not show them. "
            "Art at <dir>/post/<file>; read the name, never build it."
        ),
        "sorting": "pages[<a>__and__<b>] is presorted by pct of <b> ascending - one "
                   "sweep from mostly-a to mostly-b, both generation directions merged",
        "classifier": FM.DESCRIPTION,
        "n_valid": len(valid),
        "n_rejected": rejected,
        "pages": pages,
    }
    dst = os.path.join(FADES, "mix.json")
    tmp = f"{dst}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=1)
    os.replace(tmp, dst)
    print(f"valid: {len(valid)}   rejected: {sum(rejected.values())}  {rejected}")
    for k in sorted(pages)[:6]:
        ps = [e["pct"][k.split('__and__')[1]] for e in pages[k]]
        print(f"  {k}: {len(ps)} tiles, {ps[0]:.0f}%..{ps[-1]:.0f}%")


if __name__ == "__main__":
    main()
