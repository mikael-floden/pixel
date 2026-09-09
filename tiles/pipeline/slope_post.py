"""Postprocess slope sets - and detect what the generator actually drew on the cliff.

The maintainer's instruction, 2026-08-28:

    "I want the tiles to be processed by your postprocessing like all other tiles.
     HOWEVER! The AI might have generated dark_mud in the slopes. Yes we asked for only
     'clean grass to clean grass', but the AI might have generated a different
     material/ground type in the slope anyways. If that's the case. Detect what
     ground-type the slope is and run the slope in the postprocess as well (towards the
     slopes palette)."

So a slope tile is processed as TWO regions with possibly TWO different palettes:

  FLAT      the plateau top and the ground below it - both the ground that was ordered.
  CLIFF     the graded face between them. Usually the same ground in shadow; sometimes
            the generator draws something else entirely, and painting that toward the
            ordered ground's palette would be exactly the lime-grass mistake again.

DETECTING THE CLIFF'S GROUND IS 1-OF-15, NOT A PAIR. The mix meter's model carries a
prototype mixture per ground learned from tiles/tops, and Stream.logp scores any region
against any ground - so the cliff is scored against all fifteen and the best wins. Two
guards keep that from repainting a shadow:

  MARGIN   the winner must beat the ORDERED ground by MIN_MARGIN nats per pixel. A cliff
           that is merely the ordered ground in shadow scores close to it and keeps its
           own palette, which is the common case and the safe default.
  SIZE     a cliff under MIN_CLIFF px is not enough evidence to name a material.

Everything else is the house pipeline every other tile gets: substitute() toward the
region's anchors ([top] + its approved top_extras, nearest-anchor), then the region's
background lands on its clean colour integer-exactly, then rim suppression. Hue and
saturation come from the palette and never from the art; only the value relief carries.

Output is content-hashed and immutable (`post/tile_NN.<sha8>.webp`), current + one
previous generation retained - the cache law.
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

import mixmeter
import palette_snap as PS
import puddle_gate as PG
import tops_post as TP

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
SLOPES = os.path.join(ROOT, "slopes")
PALETTE = json.load(open(os.path.join(ROOT, "config", "palette.json")))["types"]

DE_CLIFF = 18.0     # smoothed dE from the tile's own flat background that marks the face
MIN_CLIFF = 60      # px: below this there is not enough cliff to name a material
MIN_MARGIN = 0.60   # nats/px the detected ground must beat the ORDERED ground by before
                    # we believe the generator drew something else. Measured: a cliff
                    # that is only the ordered ground in shadow lands well inside this.


def _anchors(g):
    v = PALETTE[g]
    return [PS._hex(v["top"])] + [PS._hex(h) for h in (v.get("top_extras") or [])]


def split_flat_cliff(rgb, mask):
    """(flat mask, cliff mask). The flat surfaces are the majority; the cliff deviates.

    Scale, not colour, is what separates them - the same lesson the puddle band learned:
    a ground's own grain is 1-3px and symmetric about its background, while a cliff face
    is an AREA at a different lighting. So the distance is taken after a 5x5 mask-limited
    median, which collapses grain and leaves the face standing.
    """
    bg = TP.background_of(rgb, mask)
    sm = PG.masked_median(PG.srgb_to_lab(rgb), mask, PG.SMOOTH_RAD)
    d = PG.de76(sm, PG.srgb_to_lab(bg))
    cliff = mask & (d > DE_CLIFF)
    return mask & ~cliff, cliff


HUE_DIFF = 35.0     # degrees in opponent space before a cliff is called foreign
MIN_CHROMA = 12.0   # below this a colour has no hue to compare, so it cannot disagree


def _op(c):
    c = np.asarray(c, float)
    return np.array([c[0] - c[1], c[1] - c[2]])


def is_foreign(rgb, flat, cliff):
    """Does the cliff differ from THIS TILE'S OWN flat surface in HUE?

    The 1-of-15 model cannot answer this alone and must not be asked to: its prototypes
    are lit top faces from tiles/tops, so a cliff in shadow resembles no ground well and
    the argmax lands on whichever dark ground is nearest - measured, it called a shadowed
    grass cliff "lava" and a shadowed paving cliff "dark_mud". Wrong for the same reason
    the three earlier classifiers were wrong: the model was asked about a surface it was
    never shown.

    Hue is the lighting-invariant part. Shadowed grass keeps grass's hue; genuine dark
    mud on a grass cliff does not. So the cliff is only called foreign when its hue
    direction departs from the tile's own flat surface, and only when both have enough
    chroma to have a hue at all - on near-grey grounds nothing can be distinguished and
    the ordered ground is the safe answer.
    """
    if cliff.sum() < MIN_CLIFF or flat.sum() < MIN_CLIFF:
        return False
    of, oc = _op(TP.background_of(rgb, flat)), _op(TP.background_of(rgb, cliff))
    nf, nc = float(np.hypot(*of)), float(np.hypot(*oc))
    if nf < MIN_CHROMA or nc < MIN_CHROMA:
        return False
    cos = float((of @ oc) / (nf * nc))
    return np.degrees(np.arccos(max(-1.0, min(1.0, cos)))) > HUE_DIFF


def classify(img, region, ordered):
    """(best ground, margin in nats/px over `ordered`). None when there is no evidence."""
    if region.sum() < MIN_CLIFF:
        return None, 0.0
    M = mixmeter.meter()
    F, m = mixmeter.features(mixmeter.as_rgba(img), region)
    if not m.any():
        return None, 0.0
    X = F[m].astype(np.float64)
    Zc = (X[:, mixmeter.CI] - M.col.mu) @ M.col.W
    Zt = (X[:, mixmeter.TI] - M.tex.mu) @ M.tex.W
    score = {}
    for g in M.grounds:
        lc = M.col.logp(Zc, g)
        lt = M.tex.logp(Zt, g)
        # texture only where it is confident enough to speak, the same gate the pair
        # meter uses; colour always.
        gate = 1.0 / (1.0 + np.exp(-(lt - M.tau) / M.spread))
        score[g] = float((lc + gate * lt).mean())
    best = max(score, key=score.get)
    if ordered not in score:
        return best, 0.0
    return best, score[best] - score[ordered]


def process(img, ordered, cliff_ground=None):
    """The house pipeline, per region, each toward its own palette."""
    arr = np.array(img.convert("RGBA"), int)
    mask = arr[..., 3] > 0
    if not mask.any():
        return None, {}
    af = arr.astype(float)
    rgb = af[..., :3]
    flat, cliff = split_flat_cliff(rgb, mask)
    regions = [(ordered, flat)]
    if cliff.sum() >= MIN_CLIFF:
        regions.append((cliff_ground or ordered, cliff))
    else:
        regions[0] = (ordered, mask)
    out = af.copy()
    for g, gm in regions:
        if not gm.any():
            continue
        anchors = _anchors(g)
        clean = anchors[0]
        bg = TP.background_of(rgb, gm) if gm.sum() >= 40 else np.median(rgb[gm], 0)
        if len(anchors) == 1:
            px = PS.substitute(af, gm, "%02x%02x%02x" % tuple(int(round(c)) for c in clean))
            if px is not None:
                out[..., :3][gm] = px
        else:
            al = np.clip(rgb + (clean - bg), 0, 255)
            A = PG.srgb_to_lab(np.array(anchors, float))
            P = PG.srgb_to_lab(al[gm])
            assign = np.linalg.norm(P[:, None, :] - A[None, :, :], axis=2).argmin(1)
            for k, anc in enumerate(anchors):
                sub = np.zeros_like(gm)
                sub[gm] = assign == k
                if not sub.any():
                    continue
                px = PS.substitute(af, sub, "%02x%02x%02x" % tuple(int(round(c)) for c in anc))
                if px is not None:
                    out[..., :3][sub] = px
        rgbf = out[..., :3]
        TP.shift_mask_to_clean(rgbf, gm, clean, measure=gm)
    rgbf = out[..., :3]
    TP.rim_suppress(rgbf, mask, _anchors(ordered)[0])
    res = arr.copy()
    res[..., :3] = np.clip(np.rint(rgbf), 0, 255).astype(int)
    return Image.fromarray(res.astype(np.uint8), "RGBA"), {
        "cliff_px": int(cliff.sum()), "flat_px": int(flat.sum())}


def main():
    idx_path = os.path.join(SLOPES, "index.json")
    if not os.path.isfile(idx_path):
        print("no slopes index yet"); return
    idx = json.load(open(idx_path))
    wrote = foreign = 0
    seen = {}
    for st in idx["sets"]:
        g = st["ground"]
        d = os.path.join(REPO, st["dir"])
        post = os.path.join(d, "post")
        os.makedirs(post, exist_ok=True)
        files, cliffs = [], []
        for name in sorted(st["tiles"].values()):
            src = os.path.join(d, name)
            if not os.path.isfile(src):
                files.append(None); cliffs.append(None); continue
            img = Image.open(src)
            arr = np.array(img.convert("RGBA"), int)
            m = arr[..., 3] > 0
            _flat, cl = split_flat_cliff(arr[..., :3].astype(float), m)
            cg = g
            if is_foreign(arr[..., :3].astype(float), _flat, cl):
                best, margin = classify(img, cl, g)
                if best and best != g and margin >= MIN_MARGIN:
                    cg = best
            if cg != g:
                foreign += 1
                seen[(g, cg)] = seen.get((g, cg), 0) + 1
            out, _stat = process(img, g, cg)
            if out is None:
                files.append(None); cliffs.append(None); continue
            buf = io.BytesIO()
            out.save(buf, "WEBP", lossless=True, exact=True)
            data = buf.getvalue()
            h8 = hashlib.sha1(data).hexdigest()[:8]
            hashed = name.replace(".webp", f".{h8}.webp")
            with open(os.path.join(post, hashed), "wb") as fh:
                fh.write(data)
            gens = sorted(glob.glob(os.path.join(post, name.replace(".webp", ".*.webp"))),
                          key=os.path.getmtime, reverse=True)
            for old in gens[2:]:
                os.remove(old)
            files.append(hashed)
            cliffs.append(cg)
            wrote += 1
        st["post_files"] = files
        st["cliff_ground"] = cliffs
    idx["post_pass"] = {
        "rule": "each region substituted toward ITS OWN palette ([top] + top_extras, "
                "nearest anchor), background integer-exact per region, then rim "
                "suppression. Flat surfaces take the ordered ground; the cliff face "
                "takes the ground actually DETECTED on it.",
        "cliff_detection": f"HUE first: a cliff is only foreign when its hue departs "
                           f"from the tile's own flat surface (shadow keeps hue), then "
                           f"named 1-of-15 by the mix meter; the winner "
                           f"must beat the ordered ground by {MIN_MARGIN} nats/px and the "
                           f"face must exceed {MIN_CLIFF}px, so a cliff that is merely "
                           f"the ordered ground in shadow keeps its own palette",
        "dir": "<dir>/post/<name from post_files> - read the name, never build it",
        "cliff_ground": "index-aligned with post_files: the ground each tile's cliff was "
                        "painted toward",
    }
    tmp = idx_path + f".{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(idx, f, indent=1)
    os.replace(tmp, idx_path)
    print(f"processed {wrote} slope tiles; {foreign} had a foreign cliff material")
    for (g, cg), n in sorted(seen.items(), key=lambda kv: -kv[1])[:10]:
        print(f"   {g:20s} cliff detected as {cg:20s} x{n}")


if __name__ == "__main__":
    main()
