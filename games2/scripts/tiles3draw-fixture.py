#!/usr/bin/env python3
"""Emit the tiles3 DRAW-LAYER parity fixture: the two rasters, byte for byte.

  python3 games2/scripts/tiles3draw-fixture.py
  -> games2/server/test/fixtures/tiles3draw-parity.json

client/src/tiles3draw.ts owns the two pixel operations client/src/tiles3.ts
deliberately only NAMES — conforming 64x64 art into 64x46 plate geometry, and
composing a boundary out of two plates and a Wang mask. Both are ports, so both
are gated the only way a port can be: against the producer's own code.

PROVENANCE, per case:
  * conform   render3.conformed_plate() itself — which is
              transition_patterns.plate() (the tiles agent's ONLY lawful
              conformer) plus the palette wall fill. Imported, never mirrored.
  * boundary  render3.composed_boundary() itself for the two-line rule and
              render3._mask()/_silhouette() for the sheets...
  * ...THE SEAM excepted, because render3 does not draw it. The pattern library
    publishes borders.webp and states the rule in the file that ships it —
    "THE SEAM, 1px on each side, and it is NOT optional - a transition without
    it is a 0-100 hard cut, which is not what the generator drew"
    (tiles/patterns/index.json, maintainer verdict 2026-08-27) — and the wiki
    the maintainer reviews boundaries in draws it. So the seamed reference is
    built HERE from the published constants (border.tone, np.rint), and the
    unseamed one comes straight from render3, so the gate pins both halves and
    names which is whose.

Every source file is recorded with its sha256: a republished plate, mask sheet
or silhouette invalidates the fixture loudly instead of passing on stale bytes.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "maps2", "pipeline"))

import render3 as R3                                    # THE SPEC

OUT = os.path.join(REPO, "games2", "server", "test", "fixtures", "tiles3draw-parity.json")
LIB = json.load(open(os.path.join(REPO, "tiles", "patterns", "index.json")))
RESOLVE = json.load(open(os.path.join(REPO, "tiles", "resolve.json")))
BTS = json.load(open(os.path.join(REPO, "live", "tuning", "base_tile_sets.json")))
GT = json.load(open(os.path.join(REPO, "tiles", "ground_types.json")))["grounds"]
TONE = LIB["border"]["tone"]
FW, FH, COLS = LIB["masks"]["frame_w"], LIB["masks"]["frame_h"], LIB["masks"]["cols"]
_BORD = np.array(Image.open(os.path.join(REPO, LIB["border"]["file"]))
                 .convert("RGBA"))[..., 3] > 127


def sha(path: str) -> str:
    return hashlib.sha256(open(os.path.join(REPO, path), "rb").read()).hexdigest()


def rsha(arr) -> str:
    """sha256 of a raster's raw RGBA bytes — the whole picture in 64 chars."""
    return hashlib.sha256(np.ascontiguousarray(arr, dtype=np.uint8).tobytes()).hexdigest()


def border_frame(frame: int):
    """The seam mask for a FLAT frame index (pattern.row * cols + wang index) —
    the same arithmetic render3._mask applies to the mask sheet."""
    r0, c0 = (frame // COLS) * FH, (frame % COLS) * FW
    return _BORD[r0:r0 + FH, c0:c0 + FW]


def seamed(out, frame: int):
    """The published seam: every border pixel darkened to `tone` of ITS OWN
    colour, rounded HALF TO EVEN (np.rint, which is not JS Math.round). One mask
    serves both sides because darkening keeps each side its own material."""
    sil = R3._silhouette()
    m = border_frame(frame) & (sil > 0)
    o = np.array(out, dtype=np.int32)
    o[m, :3] = np.rint(o[m, :3] * TONE)
    return np.clip(o, 0, 255).astype(np.uint8)


def plate_for(spec):
    """The 64x46 plate a side composes from, by the same two kinds
    tiles3.ts reports: a published/clean plate is opened, a `conform` art goes
    through render3.conformed_plate."""
    if spec["kind"] == "conform":
        return R3.conformed_plate(spec["path"], spec["ground"])
    return Image.open(os.path.join(REPO, spec["path"])).convert("RGBA")


def conform_cases():
    """Every DISTINCT (ground, art) a conform can be asked for, from the
    maintainer's own live sets through tiles/resolve.json — the same route
    tiles3.memberArt takes. Sampled deterministically, widest first: every
    ground that has one, then the rest in sorted order."""
    seen: dict[tuple[str, str], None] = {}
    for ground, g in sorted((BTS.get("grounds") or {}).items()):
        for s in g.get("sets") or []:
            for m in s.get("members") or []:
                if m.get("kind") != "tile":
                    continue
                e = (RESOLVE.get("members") or {}).get(m.get("tile") or "")
                if not e or e.get("kind") == "plate" or not e.get("art"):
                    continue
                if os.path.isfile(os.path.join(REPO, e["art"])):
                    seen[(ground, e["art"])] = None
    by_ground: dict[str, list[str]] = {}
    for (ground, art) in seen:
        by_ground.setdefault(ground, []).append(art)
    out = []
    for ground in sorted(by_ground):
        for art in sorted(by_ground[ground])[:3]:
            out.append({"ground": ground, "path": art})
    return out


def clean_plate(ground: str) -> str:
    return f"tiles/plates/{ground}/clean.webp"


def boundary_cases(conforms):
    """Pairs that exercise every flavour of side and a spread of frames.

    The pairs DIFFER LOUDLY on purpose (the wiki's own compose gate makes the
    same choice): a compose bug on two similar plates is invisible. `a18_s4` is
    the library default and the only row render3 itself ever draws; the other
    rows prove the frame arithmetic, which is the part a flat frame index can
    get wrong silently."""
    order = LIB["selection"]["side_order"]
    rows = {p["id"]: p["row"] for p in LIB["patterns"]}
    conf = {c["ground"]: c["path"] for c in conforms}
    pairs = []
    for a, b in (("grass", "deep_water"), ("black_rock", "snow"),
                 ("parquet_floor", "lava"), ("grass", "brown_paving_stone"),
                 ("light_soil", "grass"), ("ice", "water")):
        sa, sb = (a, b) if order.index(a) <= order.index(b) else (b, a)
        pairs.append((sa, sb))
    cases = []
    for pi, (sa, sb) in enumerate(pairs):
        for pat, idx in (("a18_s4", 1 + pi), ("a18_s4", 14 - pi),
                         ("a00_s3", 3), ("a30_s1", 6), ("a18_s4", 15)):
            frame = rows[pat] * COLS + idx
            # ALL FOUR COMBINATIONS OF SIDE KINDS appear, cycled on the pair
            # index: a conformed side and a published/clean side compose
            # through the same mask, and a bug that only shows when BOTH sides
            # are derived is exactly the one a clean/clean fixture cannot see.
            want = (("conform", "conform"), ("conform", "clean"),
                    ("clean", "conform"), ("clean", "clean"))[pi % 4]
            ka = want[0] if sa in conf else "clean"
            kb = want[1] if sb in conf else "clean"
            A = ({"kind": "conform", "path": conf[sa], "ground": sa} if ka == "conform"
                 else {"kind": "clean", "path": clean_plate(sa), "ground": sa})
            B = ({"kind": "conform", "path": conf[sb], "ground": sb} if kb == "conform"
                 else {"kind": "clean", "path": clean_plate(sb), "ground": sb})
            if not os.path.isfile(os.path.join(REPO, A["path"])) \
                    or not os.path.isfile(os.path.join(REPO, B["path"])):
                continue
            cases.append({"pattern": pat, "index": idx, "frame": frame, "a": A, "b": B})
    return cases


def main():
    conforms = conform_cases()
    for c in conforms:
        arr = R3.conformed_plate(c["path"], c["ground"])
        a = np.array(arr)
        c["sha"] = rsha(a)
        c["opaque"] = int((a[..., 3] > 0).sum())
        c["src_sha"] = sha(c["path"])
        c["wall"] = GT[c["ground"]]["palette"]["wall"]

    bcases = boundary_cases(conforms)
    for c in bcases:
        pa, pb = plate_for(c["a"]), plate_for(c["b"])
        # render3's own two-line rule, unmodified
        raw = np.array(R3.composed_boundary(c["a"]["ground"], c["b"]["ground"],
                                            c["index"], pa, pb))
        # ...but render3 hardcodes the DEFAULT pattern's row inside _mask, so a
        # non-default row is recomposed here through render3._mask(index,
        # pattern) — still its own sheet reader, only told which pattern.
        if c["pattern"] != LIB["selection"]["default_pattern"]:
            mk = R3._mask(c["index"], c["pattern"])
            raw = np.where(mk[..., None], np.array(pb), np.array(pa)).astype(np.uint8)
            raw[..., 3] = R3._silhouette()
        sil = R3._silhouette()
        raw = raw.copy()
        raw[sil == 0, :3] = 0        # invisible either way; a canvas stores 0
        c["sha_noseam"] = rsha(raw)
        c["sha"] = rsha(seamed(raw, c["frame"]))
        c["seam_px"] = int((border_frame(c["frame"]) & (sil > 0)).sum())
        c["a"]["src_sha"] = sha(c["a"]["path"])
        c["b"]["src_sha"] = sha(c["b"]["path"])

    doc = {
        "schema": "games2/tiles3draw-parity@1",
        "generator": "games2/scripts/tiles3draw-fixture.py",
        "spec": ["maps2/pipeline/render3.py", "tiles/patterns/index.json"],
        "sheets": {k: {"path": LIB[k]["file"], "sha": sha(LIB[k]["file"])}
                   for k in ("silhouette", "masks", "border")},
        "constants": {"frame_w": FW, "frame_h": FH, "cols": COLS, "tone": TONE,
                      "wall_d": 17, "silhouette_opaque": int((R3._silhouette() > 0).sum())},
        "conform": conforms,
        "boundary": bcases,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=1, sort_keys=False)
        f.write("\n")
    print(f"{OUT}: {len(conforms)} conform cases, {len(bcases)} boundary cases")


if __name__ == "__main__":
    main()
