"""Align, GATE, and publish the puddle set: `tiles/puddles/gated.json`.

THE GATE RUNS ON THE BYTES THAT SHIP. blends_post's alignment moves every pixel (to put
the dominant background exactly on the palette colour) and then suppresses the rim, so a
raw sheet that passes proves nothing about the file a consumer downloads - measured, raw
and post disagree on about a fifth of passes. Every number in gated.json is therefore
measured on the published post/ file itself, and check_immutable re-verifies the hash of
that same file. The claim is a property of the artifact, not of the pipeline that made it.

A CLEAN RIM IS NOT ENOUGH: A TILE WITH NO ISLAND PASSES IT TRIVIALLY. Roughly half the
tiles whose band is clean are simply plain dominant ground with no minor ground at all -
those belong in tiles/tops, not in a transition set. So publication needs BOTH halves of
the maintainer's sentence: the four sides pure dominant AND a real island inside
(`core_off_frac` above MIN_ISLAND).

THE HARVEST IS FREE AND IT COMES FIRST. 349 blend sheets are already paid for and some of
their tiles already satisfy the rule by luck. They are indexed in place - by their
existing content-hashed post name, never copied - so the maintainer has something to
react to before a dollar is spent on regeneration.

WHAT IS DELIBERATELY NOT DONE: repairing a failing tile by erasing the part of the island
that crosses the rim, or grafting a clean border from another tile. Both were designed and
both were rejected in review: a grafted band gives every tile of one ground the SAME
border, and a nibbled island is a stamped shape. This project has twice shipped a
border-drawing fix that looked right on one tile and read as a grid in a field ("will make
the tile look repeated and tiled"). The guarantee here comes from REJECTION, which cannot
invent an artefact - it only ever declines to publish.
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
import puddle_gate as PG
import tops_post as TP

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
PUD = os.path.join(ROOT, "puddles")
BLENDS = os.path.join(ROOT, "blends")
PALETTE = json.load(open(os.path.join(ROOT, "config", "palette.json")))["types"]

MIN_ISLAND = 0.03    # of the protected core - below this there is no minor ground to see
                     # and the tile is a plain top wearing a transition label


def align_and_write(src, dst_dir, name, clean_a, ref_b):
    """Align one raw tile and write it under a content-hashed name. Returns the name."""
    aligned, _frac, _how, _mv = BP.align(Image.open(src), clean_a, ref_b)
    if aligned is None:
        return None
    os.makedirs(dst_dir, exist_ok=True)
    buf = io.BytesIO()
    aligned.save(buf, "WEBP", lossless=True, exact=True)
    data = buf.getvalue()
    h8 = hashlib.sha1(data).hexdigest()[:8]
    hashed = name.replace(".webp", f".{h8}.webp")
    with open(os.path.join(dst_dir, hashed), "wb") as fh:
        fh.write(data)
    # current + one previous generation: a hashed name can only ever serve identical
    # bytes, while deleting it 404s pages already open.
    gens = sorted(glob.glob(os.path.join(dst_dir, name.replace(".webp", ".*.webp"))),
                  key=os.path.getmtime, reverse=True)
    for old in gens[2:]:
        os.remove(old)
    return hashed


def judge(path, dominant):
    """The gate, on the shipped bytes. Returns the metric dict plus `publish`."""
    m = PG.border_purity(Image.open(path),
                         clean_rgb=TP._hex(PALETTE[dominant]["top"]))
    if not m.get("ok"):
        m["publish"] = False
        return m
    m["publish"] = bool(m["is_puddle_ground"] and m["core_off_frac"] >= MIN_ISLAND)
    return m


def entry(sheet_dir, dominant, minor, pct, i, raw, file, m, source):
    return {"dir": sheet_dir, "i": i, "raw": raw, "file": file,
            "dominant": dominant, "minor": minor, "pct_minor": pct, "source": source,
            "border_impurity": m["border_impurity"], "spill": m["spill"],
            "island_frac": m["core_off_frac"], "sides_clean": m["sides_clean"]}


def harvest():
    """Puddle tiles already sitting in the paid-for blend tree. Indexed in place."""
    lp = os.path.join(BLENDS, "ladder.json")
    if not os.path.isfile(lp):
        return [], 0
    lad = json.load(open(lp))
    out, looked = [], 0
    for sh in lad["sheets"]:
        if sh["pct_minor"] >= 50:          # p50 is outside the rule, by design
            continue
        for i, f in enumerate(sh.get("post_files") or []):
            if not f:
                continue
            p = os.path.join(REPO, sh["dir"], "post", f)
            if not os.path.isfile(p):
                continue
            looked += 1
            m = judge(p, sh["dominant"])
            if m.get("publish"):
                out.append(entry(sh["dir"], sh["dominant"], sh["minor"],
                                 sh["pct_minor"], i, sh["tiles"][i], f, m, "blends"))
    return out, looked


def generated():
    """Sheets generated by puddles.py: align, gate, publish the survivors."""
    ip = os.path.join(PUD, "index.json")
    if not os.path.isfile(ip):
        return [], 0
    idx = json.load(open(ip))
    out, looked = [], 0
    for sh in idx["sheets"]:
        d = os.path.join(REPO, sh["dir"])
        post = os.path.join(d, "post")
        clean_a = TP._hex(PALETTE[sh["dominant"]]["top"])
        ref_b = BP.art_refs().get(sh["minor"], TP._hex(PALETTE[sh["minor"]]["top"]))
        for i, name in enumerate(sh["tiles"]):
            src = os.path.join(d, name)
            if not os.path.isfile(src):
                continue
            hashed = align_and_write(src, post, name, clean_a, ref_b)
            if not hashed:
                continue
            looked += 1
            m = judge(os.path.join(post, hashed), sh["dominant"])
            if m.get("publish"):
                out.append(entry(sh["dir"], sh["dominant"], sh["minor"],
                                 sh["pct_minor"], i, name, hashed, m, "puddles"))
    return out, looked


def main():
    h, h_seen = harvest()
    g, g_seen = generated()
    tiles = h + g
    by_cell = {}
    for e in tiles:
        by_cell.setdefault(f'{e["dominant"]}__with__{e["minor"]}', {}) \
               .setdefault(str(e["pct_minor"]), []).append(e)
    for k in by_cell:
        for lv in by_cell[k]:
            by_cell[k][lv].sort(key=lambda e: e["border_impurity"])
    doc = {
        "schema": "tiles3/puddles-gated@1", "kind": "puddle_top_only",
        "use_for": "transition", "wall_is_meaningless": True,
        "levels": [10, 20, 30, 40],
        "rule": (
            "PUBLISHED PUDDLE TILES. ladder[<dominant>__with__<minor>][<10|20|30|40>] = "
            "tiles proved, ON THE EXACT BYTES LISTED, to have all four sides of the top "
            "diamond pure dominant ground AND a real island of the minor ground inside. "
            "Art is at <dir>/post/<file> - read the name, never build it. A tile here "
            "composes with any neighbour of its dominant ground without matching "
            "anything, which is the whole purpose."
        ),
        "gate": {
            "band": f"the outer {PG.BAND_RINGS} erosion rings of the staircase top "
                    f"diamond - measured from the lattice, ring {PG.BAND_RINGS} is the "
                    f"first that can never sit beside a neighbour's top face",
            "foreign": f"a band pixel whose 5x5 mask-limited median sits more than "
                       f"{PG.DE_PATCH} dE76 from the tile's OWN trimmed-median background "
                       f"- no dominant-vs-minor classifier is used or needed",
            "island": f"core_off_frac >= {MIN_ISLAND}: a clean rim with no island is a "
                      f"plain top, not a transition tile",
            "measured_on": "the published post/ file, never the raw sheet",
        },
        "n_tiles": len(tiles), "n_cells": sum(len(v) for v in by_cell.values()),
        "from_blends": len(h), "from_puddles": len(g),
        "ladder": by_cell,
    }
    os.makedirs(PUD, exist_ok=True)
    dst = os.path.join(PUD, "gated.json")
    tmp = f"{dst}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=1)
    os.replace(tmp, dst)
    print(f"harvest: {len(h)}/{h_seen} blend tiles already satisfy the rule")
    print(f"generated: {len(g)}/{g_seen} puddle tiles pass the gate")
    print(f"published: {len(tiles)} tiles over {len(by_cell)} pairs, "
          f"{doc['n_cells']} pair-levels filled of {len(by_cell)*4 or 0}")
    per = {}
    for e in tiles:
        per[e["pct_minor"]] = per.get(e["pct_minor"], 0) + 1
    print("  by level: " + "  ".join(f"p{k}={per[k]}" for k in sorted(per)))


if __name__ == "__main__":
    main()
