"""Derive a material's palette colours FROM a reference tile the maintainer picked.

The maintainer's correction, and it inverts how the palette had been treated:

    "That is the ref image on how dark mud should be recolored towards. Running the
     recoloring on that same tile should of be extremely happy with how the tile already
     looks. Feels like you still change the color by a lot to something that looks
     worse. The trick here is that that is the ref and both this tile and all other
     tiles that have mud in them should be recolored to match this mud ref tile."

So a reference tile is not just a nice tile — it is the DEFINITION of the material's
colour. Two consequences follow, and the second is the test:

  1. Every other tile carrying that material is pulled toward the reference.
  2. The reference itself must come out of the postprocess essentially UNCHANGED. If
     recolouring the reference moves it a lot, the palette does not describe it, and it
     is the palette that is wrong.

That second point is what this file exists to enforce, and it is checkable — `--check`
reports the mean pixel shift the postprocess applies to each reference.

WHY dark_mud WAS WRONG. Its entry read "derived from tiles2/lightdark_dirt — 2.0 has no
separate dark_mud", i.e. it was never a real colour of this world, it was interpolated
from a neighbouring one. Measured against the reference the luminance was fine (66.7
against 68.5) but the CHROMA was not: R-B of 38 against the reference's 26. Same
brightness, half again as orange — which is why it read as tan rather than as mud.

WHAT THIS DELIBERATELY WILL NOT DO. It refuses to touch a material whose palette entry
is anchored to tiles2, and that refusal is the whole safety property. The game's grass,
snow and stone come from the shipping 2.0 palette so that 3.0 reads as the same world;
the maintainer asked for that specifically ("The old grass we had in tiles 2.0 had a
different tone. I like the old grass tone more"). Re-deriving those from generator
output is the exact mistake that once made 3.0 grass a bright yellow-green. Only a
material with no 2.0 anchor, or one the maintainer explicitly re-references with
--force, can be redefined here.

MEAN, not median or dominant. A flat fill replaces a textured surface, and what the eye
integrates at a distance is the average reflectance. On the dark_mud reference the three
differ by real amounts — mean #514137, median #594231, dominant #4c3c34 — and the median
is pulled bright by the highlight speckles that make up a small part of the area.

  python tiles/pipeline/reference.py --check
  python tiles/pipeline/reference.py --material dark_mud --write
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import palette_snap

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PALETTE = os.path.join(ROOT, "config", "palette.json")
REVIEW = os.path.join(ROOT, "review", "manifest.json")
REPO = os.path.dirname(ROOT)


def _hex(px):
    return "#%02x%02x%02x" % tuple(int(round(v)) for v in px)


def tile_by_key(key_or_src, man=None):
    """Resolve a maintainer-nominated tile: a manifest key, an 8-char id, or a src path.

    The maintainer picks the reference by eye from the wiki and names it by id — "this
    tile is a good palette for dark rock" — so the tool has to accept that identifier
    rather than always taking whatever happens to rank first.

    Returns (path, top_material, side_material). The two materials matter because a
    nominated tile is NOT always a same-over-same one, and which face carries the
    material decides where its colour has to be read from — see derive_wall().
    """
    man = man or json.load(open(REVIEW))["cells"]
    k = key_or_src.strip().strip("/")
    for name, cell in man.items():
        for e in cell["candidates"]:
            if k in (e.get("key"), (e.get("key") or "").rsplit("/", 1)[-1], e.get("src")):
                p = os.path.join(REPO, e["src"]) if e.get("src") else None
                return p, cell.get("top"), cell.get("side")
    if os.path.isfile(k):
        return k, None, None
    return None, None, None


def reference_tile(material, man=None):
    """The tile that DEFINES this material: the top-ranked same-over-same candidate.

    Same-over-same because it is the only cell showing the material as both surface and
    wall with nothing else in frame, so both colours come from one coherent piece of art
    rather than from two cells that happened to light it differently.
    """
    man = man or json.load(open(REVIEW))["cells"]
    cell = man.get(f"{material}__over__{material}")
    if not cell or not cell.get("candidates"):
        return None
    return os.path.join(REPO, cell["candidates"][0]["before"])


def derive(path):
    """(top_hex, wall_hex) as the reference's own average of each surface.

    Reads the art as generated, where derive_wall() canonicalises first. That asymmetry is
    deliberate: derive_wall CLASSIFIES each pixel as one material or the other, and the
    generator's spiky outline pixels belong to neither, so they have to go before the split
    or they bias it. A plain average does not care — measured on the grey_stone reference
    the two agree within 3 RGB units and the uncanonicalised value scores marginally better
    on the acceptance test (16.51 against 16.63), so there is nothing here to fix.
    """
    a = np.asarray(Image.open(path).convert("RGBA")).astype(float)
    reg = palette_snap._regions(a)
    if not reg:
        return None
    rgb = a[:, :, :3]
    wall = reg["left"] | reg["right"]
    if reg["top"].sum() < 100 or wall.sum() < 100:
        return None
    return _hex(rgb[reg["top"]].mean(0)), _hex(rgb[wall].mean(0))


def derive_wall(path, top_art_hex=None):
    """Read a material's colour off the WALL of an X-over-Y tile, rejecting the overhang.

    WHY THIS EXISTS. The maintainer nominated `grass over deep_water` as the definition of
    deep water, and flagged the trap in the same breath:

        "Everything blue in this tile is the palette of deep_water. The deep_water on this
         tile should not change by the filter, but every other deep_water should align with
         the color palette on this tile (and be careful becouse this ref-img is 'grass over
         deep water' and its the dark blue at the bottom that is the color palette for
         other deep_blue tiles)."

    They were right to warn. The wall region of that tile is not all deep water: 14% of it
    is GRASS, the overhang blades spilling down over the top edge — the very feature the
    tile was accepted for. Averaging the region naively returns #1c3538, a teal, because a
    seventh of the sample is bright green. Deriving the palette from that would have made
    every deep_water wall in the game slightly grass-coloured, from the tile the maintainer
    picked *because its grass overhangs well*. The naive read and this one differ by 20 RGB
    units, which is not a rounding difference; it is a different colour.

    THE REJECTION. An X-over-Y wall holds exactly two materials, and the tile hands us one
    of them for free: the top face is unmixed top material. So seed the top colour from the
    top face and the wall colour from the wall's MEDIAN — a median because contamination is
    a minority and a median ignores minorities, which a mean cannot — then let each wall
    pixel choose the nearer of the two and re-average only the winners. Same nearest-of-two
    idea snap() already uses to decide which wall pixels are spill, and for the same reason:
    it is a distance between measured colours, not a hue inferred off the art. Inference is
    what shipped a magenta grass edge, 1413 vivid pixels and a red light_soil.

    The rejected pixels are reported, and they are the check on the whole method. On the
    nominated tile they average #64af47 — grass, unmistakably — and they sit at the TOP of
    the wall where the overhang hangs. If a rejection set ever comes back the same colour as
    what was kept, the split found nothing and the answer is the naive mean.

    Returns (wall_hex, stats) or None.
    """
    a = np.asarray(palette_snap.canonicalise(Image.open(path).convert("RGBA"))).astype(float)
    reg = palette_snap._regions(a)
    if not reg:
        return None
    rgb = a[:, :, :3]
    wall = reg["left"] | reg["right"]
    if wall.sum() < 100 or reg["top"].sum() < 100:
        return None

    top_c = (palette_snap._hex(top_art_hex).astype(float) if top_art_hex
             else np.median(rgb[reg["top"]], 0))
    px = rgb[wall]
    w = np.median(px, 0)
    keep = np.ones(len(px), bool)
    for _ in range(8):
        keep = (np.linalg.norm(px - w, axis=1) <= np.linalg.norm(px - top_c, axis=1))
        if keep.sum() < 40:          # nothing recognisable is left; trust the median
            return _hex(np.median(px, 0)), {"kept": 0, "rejected": int(len(px))}
        nw = px[keep].mean(0)
        if np.abs(nw - w).max() < 0.5:
            w = nw
            break
        w = nw
    rej = ~keep
    return _hex(w), {
        "kept": int(keep.sum()), "rejected": int(rej.sum()),
        "rejected_share": float(rej.mean()),
        "rejected_hex": _hex(px[rej].mean(0)) if rej.any() else None,
        "naive_hex": _hex(px.mean(0)),
        "top_art_hex": _hex(top_c),
    }


def top_from_wall_reference(material, ref_wall_hex, man=None):
    """The material's TOP colour, when the maintainer's reference only shows its WALL.

    A wall reference cannot supply this directly — the nominated tile shows deep water only
    from the side, and a side face is the SHADED one. So the lit face is reconstructed from
    two measured things and nothing assumed:

      * the reference wall, which is the maintainer's colour, and
      * the lit/shaded RATIO of this material's own same-over-same art, per channel.

    Both measurements come from the same candidates so the ratio is coherent, and the
    transfer is per channel rather than on luminance because the generator's lit face is not
    just brighter — on deep water it is also relatively greener, and a luminance scale would
    have kept the shaded face's blue and produced a top nothing draws.

    WHY NOT JUST TAKE THE SAME-OVER-SAME TOP. Because it does not agree with the reference.
    Measured over six candidates, the same-over-same art's wall is #223551 while the
    maintainer picked #102235 — 38 RGB units darker. Pairing their top with their wall gives
    a lift of 2.00, more separation between one material's two faces than ANY of the
    fourteen materials shows (measured range 0.92 to 1.70). That pairing ships a deep water
    whose top is visibly a different, lighter blue than its own wall, which is the exact
    complaint already made twice about grass: "the grass on the 'ice over grass' tile have
    grass that looks much much different. Why is that?"

    It costs something and the cost is worth naming: this top moves the existing art MORE
    than the old palette did (mean top shift 27.6 against 23.4), because the maintainer's
    reference is darker than the average deep water the generator draws. That is not a
    failure of the derivation — pulling art onto a chosen colour is what a palette is for,
    and the choice was theirs. The acceptance test that still has to hold is the one on the
    REFERENCE, and that is measured on the wall by wall_shift().

    Returns (top_hex, n_samples) or None.
    """
    man = man or json.load(open(REVIEW))["cells"]
    cell = man.get(f"{material}__over__{material}")
    if not cell:
        return None
    tops, walls = [], []
    for e in cell.get("candidates", [])[:6]:
        p = os.path.join(REPO, e["src"]) if e.get("src") else None
        if not p or not os.path.isfile(p):
            continue
        a = np.asarray(palette_snap.canonicalise(
            Image.open(p).convert("RGBA"))).astype(float)
        reg = palette_snap._regions(a)
        wall = reg["left"] | reg["right"] if reg else None
        if not reg or reg["top"].sum() < 100 or wall.sum() < 100:
            continue
        tops.append(a[:, :, :3][reg["top"]].mean(0))
        walls.append(a[:, :, :3][wall].mean(0))
    if not tops:
        return None
    st, sw = np.mean(tops, 0), np.mean(walls, 0)
    ratio = np.clip(st / np.maximum(sw, 1.0), 0.5, 3.0)
    return _hex(np.clip(palette_snap._hex(ref_wall_hex).astype(float) * ratio, 0, 255)), len(tops)


def wall_shift(path, top_hex, side_hex):
    """The acceptance test for a WALL reference: how far postprocess moves the wall.

    Runs the real X-over-Y path — the same snap() call publish makes — and measures only the
    wall, because the wall is the part the maintainer nominated. Measuring the whole tile
    would drown the answer in the top face, which on this tile is grass and has nothing to
    do with whether the deep water is right.

    Returns (shift, fired). `fired` is not decoration: snap() only splits an X-over-Y wall
    when the two PALETTE colours are at least 60 apart, and grass-over-deep_water is 39
    apart, so on this very tile the alignment is skipped and the shift is whatever the grass
    fringe did. Reporting the number without that flag would read as "the palette already
    describes this wall" when what actually happened is that nothing looked at it.
    """
    raw = Image.open(path).convert("RGBA")
    out = palette_snap.snap(raw, top_hex, side_hex=side_hex, spill=True,
                            same_material=False, align_side=True)
    a = np.asarray(palette_snap.canonicalise(raw)).astype(float)
    b = np.asarray(out).astype(float)
    reg = palette_snap._regions(a)
    if not reg:
        return None, False
    fired = float(np.linalg.norm(
        palette_snap._hex(top_hex) - palette_snap._hex(side_hex))) >= 60.0
    m = (reg["left"] | reg["right"]) & (a[:, :, 3] > 128)
    if not m.any():
        return None, fired
    return float(np.abs(b[:, :, :3] - a[:, :, :3])[m].mean()), fired


def shift(path, top_hex, wall_hex, same=True):
    """Mean per-pixel movement the postprocess applies. Small = the palette describes
    this art. This is the acceptance test, not a diagnostic."""
    raw = Image.open(path).convert("RGBA")
    out = palette_snap.snap(raw, top_hex, same_material=same, wall_hex=wall_hex)
    a = np.asarray(raw).astype(float)
    b = np.asarray(out).astype(float)
    op = a[:, :, 3] > 128
    return float(np.abs(b[:, :, :3] - a[:, :, :3])[op].mean())


def anchored(entry):
    """True when this colour comes from the shipping 2.0 palette and is not ours to
    redefine. 'derived from' is NOT an anchor — it means interpolated, which is what
    dark_mud was."""
    src = (entry.get("source") or "").lower()
    return "tiles2" in src and "derived" not in src


def nominated(entry):
    """True when a maintainer PICKED this material's colour off a specific tile.

    Without this, a blanket `--write` quietly undoes their choice. Three materials are now
    defined by a nominated reference — dark_mud, black_rock, deep_water — and none of them
    is anchored to tiles2, so nothing else stops the sweep from re-deriving each one off
    whatever the generator happens to average to and overwriting the pick with it. Measured
    right now that sweep would move black_rock #1e1d1e -> #141415 and deep_water
    #162843 -> #243756, silently, with a success message.

    A named --material still re-references it, which is how a maintainer changes their mind.
    """
    return "reference tile" in (entry.get("source") or "").lower()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--material")
    ap.add_argument("--tile", help="nominate an exact reference: manifest key, 8-char id, "
                                   "or path. Without it the top-ranked same-over-same "
                                   "candidate is used.")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="re-reference a material anchored to tiles2 (maintainer's call)")
    ap.add_argument("--check", action="store_true",
                    help="report how far the postprocess moves each reference tile")
    args = ap.parse_args()

    doc = json.load(open(PALETTE))
    man = json.load(open(REVIEW))["cells"]
    names = [args.material] if args.material else sorted(doc["types"])
    changed = []

    print(f"{'material':16s} {'palette now':>18s} {'from reference':>18s}  {'shift':>6s}")
    for m in names:
        entry = doc["types"].get(m)
        ref = top_mat = side_mat = None
        if args.tile and args.material == m:
            ref, top_mat, side_mat = tile_by_key(args.tile, man)
        else:
            ref = reference_tile(m, man)
        if not entry or not ref or not os.path.isfile(ref):
            print(f"{m:16s} {'(no reference tile)':>18s}")
            continue

        # A NOMINATED TILE NEED NOT BE SAME-OVER-SAME. When the material the maintainer is
        # defining is this tile's SIDE, its colour lives in the wall and the top face is a
        # different material entirely — read it the same way and you get the other
        # material's average mixed in.
        wall_ref = bool(side_mat and side_mat == m and top_mat != m)
        if wall_ref:
            dw = derive_wall(ref)
            new_wall, st = dw if dw else (None, None)
            sos = top_from_wall_reference(m, new_wall, man) if new_wall else None
            if not sos:
                print(f"{m:16s} (wall reference unreadable)")
                continue
            new_top, n_sos = sos
            now, _ = wall_shift(ref, doc["types"][top_mat]["top"], entry.get("wall"))
            then, fired = wall_shift(ref, doc["types"][top_mat]["top"], new_wall)
            if not fired:
                print(f"{'':16s} {'':>18s} NOTE: snap() skips the wall split on this cell "
                      f"({top_mat} and {m} palette colours are only "
                      f"{np.linalg.norm(palette_snap._hex(doc['types'][top_mat]['top']) - palette_snap._hex(new_wall)):.0f} "
                      f"apart, gate is 60) — the shift below is the grass fringe, not a "
                      f"verdict on the wall colour")
            src_note = (f"wall of reference tile {os.path.relpath(ref, REPO)} "
                        f"({top_mat} over {m}) — the maintainer's chosen look for this "
                        f"material; top reconstructed from {m} same-over-same lit/shaded ratio (n={n_sos})")
            print(f"{'':16s} {'wall ref:':>18s} {st['rejected']} of "
                  f"{st['kept'] + st['rejected']} wall px rejected as {top_mat} "
                  f"({st['rejected_hex']}); naive mean would be {st['naive_hex']}")
        else:
            d = derive(ref)
            if not d:
                continue
            new_top, new_wall = d
            now = shift(ref, entry["top"], entry.get("wall"))
            then = shift(ref, new_top, new_wall)
            src_note = (f"reference tile {os.path.relpath(ref, REPO)} — the "
                        f"maintainer's chosen look for this material")

        lock = "" if (not anchored(entry) or args.force) else "  LOCKED (tiles2)"
        print(f"{m:16s} {entry['top']:>10s}/{str(entry.get('wall')):>7s} "
              f"{new_top:>10s}/{new_wall:>7s}  {now:5.1f}->{then:4.1f}{lock}")
        if args.check or not args.write:
            continue
        if anchored(entry) and not args.force:
            continue
        if nominated(entry) and not args.material:
            print(f"{'':16s} {'':>18s} KEPT — nominated by the maintainer; name it with "
                  f"--material {m} to re-reference it")
            continue
        entry["top"], entry["wall"] = new_top, new_wall
        entry["source"] = src_note
        changed.append(m)

    if changed:
        json.dump(doc, open(PALETTE, "w"), indent=2)
        print(f"\nwrote {len(changed)} material(s): {', '.join(changed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
