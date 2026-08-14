"""QA gates for generated TREE VARIANTS (NOT_LIT_1..5 / LIT_1..2 states).

Every tree gets 7 states via the same `POST /v2/objects/{id}/states` edit
machinery the windows used (see lights_on.py). The maintainer's brief
(2026-08-14) asks three things of every generated variant:

  (a) it must actually BE a new variant — not the source handed back, and not
      a copy of a sibling variant either;
  (b) its colours should stay in the family — "but this is not an absolute
      must if lets say its autumn";
  (c) a LIT variant must glow; a NOT_LIT variant must not.

THE LESSON THIS MODULE IS BUILT AROUND
--------------------------------------
A gate that measures the wrong thing silently destroys good art. The window
run rejected EIGHT consecutive correct generations because a raw alpha XOR
called lit glass a redrawn silhouette (lights_on.silhouette_delta's docstring
has the post-mortem), and pixel_qa.py's header records nine statistical mush
detectors that all failed against the maintainer's own labels. So every
threshold below was calibrated against art we KNOW is good — the 73 trees on
disk — and each gate's measured false-positive rate against that known-good
set is written next to it. Where a gate could not be made safe it was demoted
to a WARNING that routes to the agent's eyes instead of deleting art.

WHY THE GATES ARE PAIRED, NOT ABSOLUTE
--------------------------------------
A variant is always generated FROM a specific source tree, so every check
compares variant against source rather than against a global constant. That is
what makes (c) work at all: the confounders that fool an absolute glow
detector — the yellow butterflies on copper beech tree_013, the ember-bright
berries on the bare tree_009, scarlet autumn highlights — are present in the
SOURCE too, so the difference cancels them. Absolute thresholds are kept only
as loose backstops.

Calibration sets (all real art, 2026-08-14, 73 trees at 192px):
  * 42 same-variety pairs (two independently generated "slender silver birch",
    etc.) = what a genuinely different variant of the same tree looks like.
  * 657 synthetic near-copies (9 perturbations x 73 sprites: identity, +-6%
    brightness, +-1/3px translation, 4deg hue rotation, sigma=3 noise, a 10%
    band repainted, and an added lantern glow) = what "the model handed the
    source back" looks like.
  * the 36 LIGHTS_ON vs 37 LIGHTS_OFF labels for the glow gate.

Run `python3 pipeline/tree_variant_qa.py --calibrate` to reproduce every
number in this file from the art on disk.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

# ---------------------------------------------------------------------------
# thresholds — see the calibration table in each gate's docstring
# ---------------------------------------------------------------------------

# (a) novelty. Worst synthetic near-copy scored 0.031; weakest genuine
# same-variety pair scored 0.170. 0.10 sits ~3.2x clear of both.
NOVELTY_MIN = 0.10
ALIGN_SEARCH = 4          # px; a re-centred copy is still a copy

# (b) palette. Same-variety pairs: median 11.7 dE, p90 18.9, max 26.6.
# Season swings inside a genus (scarlet maple vs green field maple, golden
# larch vs green pine) measure 25-38 dE — which is why the FAIL line is at 40
# and the WARN line never auto-rejects anything.
PALETTE_WARN = 22.0
PALETTE_FAIL = 40.0
PALETTE_FAIL_SEASONAL = 55.0
SEASONAL_WORDS = ("autumn", "flame", "scarlet", "golden", "gold", "larch",
                  "snow", "blossom", "blossomed", "cherry", "copper", "berries")

# (c) glow. Score distribution over the labelled trees:
#     LIGHTS_ON  (n=36): min 0.468  median 0.993  max 1.332
#     LIGHTS_OFF (n=37): min 0.296  median 0.528  max 1.084
GLOW_FLOOR = 0.70         # a LIT variant must clear this in absolute terms
GLOW_LIT_DELTA = 0.25     # ...and must beat its source by this much
GLOW_REMOVE_DELTA = 0.25  # a REMOVE-GLOW variant must drop by this much
GLOW_WARN_CEIL = 0.90     # NOT_LIT variants above this get eyes, not deletion
GLOW_WARN_DELTA = 0.35


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _rgba(img):
    if isinstance(img, np.ndarray):
        return img.astype(np.uint8)
    if isinstance(img, str):
        img = Image.open(img)
    return np.asarray(img.convert("RGBA"), dtype=np.uint8)


def _integral(z):
    s = np.zeros((z.shape[0] + 1, z.shape[1] + 1))
    s[1:, 1:] = z.cumsum(0).cumsum(1)
    return s


def _boxsum(s, r):
    h, w = s.shape[0] - 1, s.shape[1] - 1
    y0 = np.clip(np.arange(h) - r, 0, h); y1 = np.clip(np.arange(h) + r + 1, 0, h)
    x0 = np.clip(np.arange(w) - r, 0, w); x1 = np.clip(np.arange(w) + r + 1, 0, w)
    return (s[np.ix_(y1, x1)] - s[np.ix_(y0, x1)]
            - s[np.ix_(y1, x0)] + s[np.ix_(y0, x0)])


def _blur(x, w, r):
    """Box mean of `x` over radius r, weighted by w (so transparent canvas
    does not drag the local background toward black)."""
    return _boxsum(_integral(x * w), r) / np.maximum(_boxsum(_integral(w), r), 1e-6)


def _filled(alpha_mask):
    """The OUTER silhouette: flood the background inward from the border and
    keep everything the flood cannot reach, holes included.

    Deliberately NOT a raw alpha test. lights_on.py's post-mortem: adding light
    turns see-through pixels opaque, and a raw alpha comparison scores that as
    a massive shape change (32.5% on window_052, whose outline had not moved a
    single pixel). Filling first asks the question we actually mean — did the
    OUTLINE move? — and a LIT tree variant's new glow halo therefore reads as
    the small change it is."""
    from collections import deque
    m = alpha_mask
    h, w = m.shape
    seen = np.zeros_like(m)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not m[y, x] and not seen[y, x]:
                seen[y, x] = True; q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if not m[y, x] and not seen[y, x]:
                seen[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < h and 0 <= nx < w and not m[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True; q.append((ny, nx))
    return ~seen


def _premultiplied(arr):
    a = arr[:, :, 3:4].astype(np.float64) / 255.0
    return arr[:, :, :3].astype(np.float64) * a, arr[:, :, 3] > 16


def _roll(x, dy, dx):
    return np.roll(np.roll(x, dy, 0), dx, 1)


# ---------------------------------------------------------------------------
# (a) IS IT ACTUALLY A NEW VARIANT?
# ---------------------------------------------------------------------------

def _rgb_distance(pa, ma, pb, mb):
    u = ma | mb
    if not u.any():
        return 0.0
    return float((np.sqrt(((pa - pb) ** 2).sum(2)) / 441.673)[u].mean())


def novelty(a, b, search=ALIGN_SEARCH):
    """How different two tree sprites are, in [0, 1]. Returns
    (score, shape_diff, rgb_diff, (dy, dx)).

      shape_diff  symmetric difference of the two FILLED silhouettes over
                  their union — did the crown/trunk get redrawn?
      rgb_diff    mean premultiplied-RGB distance over the union of opaque
                  area — did the painting change?
      score       max(shape_diff, rgb_diff), so a variant that changes only
                  its outline OR only its painting still counts as new.

    TRANSLATION IS ALIGNED AWAY FIRST, and that is not a nicety. Measured on
    this art: shifting a sprite by ONE pixel scores 0.354 unaligned and 0.000
    aligned; by three pixels, 0.411 unaligned. PixelLab re-centres art between
    generations, so without the +-4px search the gate would wave through a
    verbatim copy that happened to land two pixels to the left — the exact
    failure this gate exists to catch. The search takes the offset that
    minimises rgb_diff and scores both metrics there.

    CALIBRATION
      same-variety pairs (n=42, known-good "different variant" proxy):
          min 0.170, p5 0.196, median 0.344
      synthetic near-copies (n=657, 9 perturbations x 73 sprites):
          max 0.031, p99 0.024
      at NOVELTY_MIN=0.10 -> 0/42 known-good rejected (FP 0.0%),
                             657/657 near-copies caught.
    """
    A, B = _rgba(a), _rgba(b)
    if A.shape != B.shape:
        B = _rgba(Image.fromarray(B, "RGBA").resize(
            (A.shape[1], A.shape[0]), Image.NEAREST))
    pa, ma = _premultiplied(A)
    pb, mb = _premultiplied(B)
    fa, fb = _filled(ma), _filled(mb)
    best = None
    for dy in range(-search, search + 1):
        for dx in range(-search, search + 1):
            r = _rgb_distance(pa, ma, _roll(pb, dy, dx), _roll(mb, dy, dx))
            if best is None or r < best[0]:
                best = (r, dy, dx)
    r, dy, dx = best
    fbr = _roll(fb, dy, dx)
    u = int((fa | fbr).sum())
    s = float((fa ^ fbr).sum()) / max(u, 1)
    return max(s, r), s, r, (dy, dx)


# ---------------------------------------------------------------------------
# (b) ARE THE COLOURS STILL IN THE FAMILY?
# ---------------------------------------------------------------------------

_QS = np.arange(5, 100, 5)


def _srgb_to_lab(rgb):
    r = rgb / 255.0
    r = np.where(r <= 0.04045, r / 12.92, ((r + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124, 0.3576, 0.1805],
                  [0.2126, 0.7152, 0.0722],
                  [0.0193, 0.1192, 0.9505]])
    xyz = r @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16,
                     500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], -1)


def palette_signature(img):
    """The 5th..95th percentiles of the opaque pixels in CIELAB — a
    distribution fingerprint rather than a k-means palette, because k-means on
    a 192px tree is unstable across runs and would make the gate flap."""
    arr = _rgba(img)
    m = arr[:, :, 3] > 16
    if m.sum() < 50:
        return None
    return np.percentile(_srgb_to_lab(arr[:, :, :3][m].astype(np.float64)),
                         _QS, axis=0)


def palette_delta(a, b):
    """Mean CIELAB distance between matched percentiles, in dE units.

    CALIBRATION
      same-variety pairs (n=42):   median 11.7,  p90 18.9,  max 26.6
      cross-variety pairs (n=2586): median 17.0, p90 32.9,  max 51.9
      season swings inside one genus (measured anchors):
        scarlet maple vs green field maple 35.4 | autumn-flame vs field 30.5
        golden autumn beech vs young green beech 25.5 | golden larch vs
        green scots pine 38.2 | blossom cherry vs bird cherry 27.2

    The two distributions OVERLAP HEAVILY — which is exactly the maintainer's
    "not an absolute must". So PALETTE_WARN=22 only flags for eyes (2.4% of
    known-good same-variety pairs land above it) and PALETTE_FAIL=40 is the
    only hard line: 0/42 known-good pairs and 0/6 season anchors reach it, and
    it still catches the 3.4% most extreme cross-variety pairs — i.e. it fires
    only when the model returned something as differently coloured as a snow
    fir where a scarlet maple was asked for.
    """
    sa, sb = (a if isinstance(a, np.ndarray) and a.shape == (len(_QS), 3)
              else palette_signature(a),
              b if isinstance(b, np.ndarray) and b.shape == (len(_QS), 3)
              else palette_signature(b))
    if sa is None or sb is None:
        return 0.0
    return float(np.sqrt(((sa - sb) ** 2).sum(1)).mean())


def is_seasonal(variety_text):
    t = (variety_text or "").lower()
    return any(w in t for w in SEASONAL_WORDS)


# ---------------------------------------------------------------------------
# (c) DOES IT GLOW?
# ---------------------------------------------------------------------------

def glow_score(img):
    """How much this tree reads as SELF-EMISSIVE. Higher = glowier.

        score = (p99.9 - p90 of luma)  +  2 * (p99.9 of a saturation-weighted
                                               top-hat at radius 8)

    Both halves measure OUTLIER-NESS INSIDE THE PIECE'S OWN ART, which is the
    thing that separates a light source from bright paint. Absolute brightness
    does not: measured over the 73 labelled trees, mean luma is actually
    LOWER on the LIGHTS_ON set (0.250 vs 0.261) and plain bright-pixel
    fractions reach only AUC 0.69, because a white-blossomed hawthorn or a
    snow-dusted fir has far more bright pixels than a tree with one lit knot
    hole. A lantern is bright RELATIVE TO ITS OWN TREE and bright RELATIVE TO
    ITS OWN NEIGHBOURHOOD; snow is neither.

    CALIBRATION (36 LIGHTS_ON vs 37 LIGHTS_OFF, prompt-derived labels)
      AUC = 0.944
      LIGHTS_ON : min 0.468  p10 0.793  median 0.993  max 1.332
      LIGHTS_OFF: min 0.296  median 0.528  p90 0.769  max 1.084

    KNOWN FALSE-POSITIVE MODE, do not pretend it away: small saturated bright
    specks on a dark ground score like glow. The three LIGHTS_OFF trees above
    0.86 are tree_013 (yellow/blue butterflies on a dark copper beech, 1.084),
    tree_057 (scarlet maple highlights, 0.893) and tree_009 (orange berries
    under a bare tree, 0.876). This is why the NOT_LIT direction of the gate
    warns instead of rejecting, and why every check here is paired against the
    source — the butterflies are in the source too.

    KNOWN FALSE-NEGATIVE MODE: pale, desaturated glows score low —
    tree_016 (0.468), tree_024 (0.634), tree_008 (0.749). Inspecting
    tree_016 at 3x, its "pale blossoms shining faintly" do not visibly glow at
    all, so at least one of those is a label error rather than a detector
    error; the labels come from the generation prompt, not from the art.
    """
    arr = _rgba(img)
    m = arr[:, :, 3] > 16
    if m.sum() < 200:
        return 0.0
    w = m.astype(np.float64)
    rgb = arr[:, :, :3].astype(np.float64) / 255.0
    lum = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    v = rgb.max(2)
    sat = np.where(v > 1e-6, (v - rgb.min(2)) / np.maximum(v, 1e-6), 0.0)
    hot = np.percentile(lum[m], 99.9) - np.percentile(lum[m], 90)
    sl = sat * lum
    halo = np.percentile((sl - _blur(sl, w, 8))[m], 99.9)
    return float(hot + 2.0 * halo)


# ---------------------------------------------------------------------------
# the gate
# ---------------------------------------------------------------------------

class Report(dict):
    """dict with .ok / .fails / .warns; truthy when the variant passes."""
    @property
    def ok(self):
        return not self["fails"]

    def __bool__(self):
        return self.ok

    def __str__(self):
        head = "PASS" if self.ok else "FAIL"
        bits = [f"novelty={self['novelty']:.3f}",
                f"palette={self['palette_delta']:.1f}dE",
                f"glow={self['glow']:.3f}(src {self['source_glow']:.3f})"]
        out = f"{head} {self['state']}: " + " ".join(bits)
        for f in self["fails"]:
            out += f"\n  FAIL {f}"
        for w in self["warns"]:
            out += f"\n  warn {w}"
        return out


def check_variant(source_img, variant_img, state, source_lights,
                  variety="", siblings=()):
    """Gate one generated variant.

      source_img     the tree the state was edited from (its `sprite`)
      variant_img    the freshly generated state sprite
      state          "NOT_LIT_1".."NOT_LIT_5" or "LIT_1"/"LIT_2"
      source_lights  "LIGHTS_ON" / "LIGHTS_OFF" — the source's own manifest
                     field, which decides whether this was an ADD-GLOW, a
                     REMOVE-GLOW or a plain redraw
      variety        the manifest `variety` string (only used to loosen the
                     palette FAIL line for seasonal trees)
      siblings       already-accepted sibling variants of the SAME tree; each
                     is checked for novelty too, so variant 4 cannot be a copy
                     of variant 2.

    Returns a Report. `fails` deletes the state and re-rolls; `warns` goes to
    the pixel_qa zoom sheet for the agent's eyes.
    """
    want_lit = state.upper().startswith("LIT")
    src, var = _rgba(source_img), _rgba(variant_img)
    nov, shape_d, rgb_d, off = novelty(src, var)
    pdelta = palette_delta(src, var)
    g_src, g_var = glow_score(src), glow_score(var)

    fails, warns = [], []

    # (a) it must be a NEW variant, against the source and every sibling
    if nov < NOVELTY_MIN:
        fails.append(f"not a new variant: novelty {nov:.3f} < {NOVELTY_MIN} "
                     f"(shape {shape_d:.3f}, rgb {rgb_d:.3f}, offset {off}) — "
                     f"the model handed back the source")
    worst_sib = None
    for i, sib in enumerate(siblings):
        s_nov = novelty(sib, var)[0]
        if worst_sib is None or s_nov < worst_sib[0]:
            worst_sib = (s_nov, i)
        if s_nov < NOVELTY_MIN:
            fails.append(f"duplicate of sibling #{i}: novelty {s_nov:.3f} "
                         f"< {NOVELTY_MIN}")

    # (b) colours in the family — warn freely, fail only at the extreme
    fail_line = PALETTE_FAIL_SEASONAL if is_seasonal(variety) else PALETTE_FAIL
    if pdelta > fail_line:
        fails.append(f"palette {pdelta:.1f} dE > {fail_line:.0f} — this is not "
                     f"the same tree's colours any more")
    elif pdelta > PALETTE_WARN:
        warns.append(f"palette drifted {pdelta:.1f} dE (same-variety p90 is "
                     f"{18.9:.1f}) — look at it")

    # (c) glow, always relative to the source
    if want_lit:
        if g_var < GLOW_FLOOR:
            fails.append(f"LIT variant does not glow: {g_var:.3f} < "
                         f"{GLOW_FLOOR}")
        elif source_lights == "LIGHTS_OFF" and g_var - g_src < GLOW_LIT_DELTA:
            # The +delta is the ADD-GLOW test and applies ONLY when the source
            # is dark. Requiring it of a LIT variant whose source ALREADY
            # glows was measurably wrong: it hard-failed 27 of 84 known-good
            # same-variety orderings (every LIGHTS_ON -> LIGHTS_ON pair, e.g.
            # tree_020 -> tree_062, both plainly glowing), because two lit
            # trees have no reason to differ in glow at all. That is the
            # window-silhouette mistake in a new costume — measuring a
            # difference the brief never asked for.
            fails.append(f"glow was not added: {g_var:.3f} vs dark source "
                         f"{g_src:.3f} (need +{GLOW_LIT_DELTA})")
    else:
        if source_lights == "LIGHTS_ON":
            # REMOVE GLOW: the source glows, this must not.
            if not (g_src - g_var >= GLOW_REMOVE_DELTA or g_var <= GLOW_FLOOR):
                fails.append(f"glow was not removed: {g_var:.3f} vs source "
                             f"{g_src:.3f} (need -{GLOW_REMOVE_DELTA} or "
                             f"<= {GLOW_FLOOR})")
        else:
            # Plain redraw of an already-dark tree. ADVISORY ONLY — see
            # glow_score's false-positive note; a variant that grows brighter
            # berries is not a bug and must not be auto-deleted.
            if g_var > GLOW_WARN_CEIL and g_var - g_src > GLOW_WARN_DELTA:
                warns.append(f"NOT_LIT variant reads as glowing: {g_var:.3f} "
                             f"vs source {g_src:.3f} — check it is berries or "
                             f"highlights, not light")

    return Report(state=state, novelty=nov, shape_diff=shape_d, rgb_diff=rgb_d,
                  offset=off, palette_delta=pdelta, glow=g_var,
                  source_glow=g_src, min_sibling_novelty=(
                      worst_sib[0] if worst_sib else None),
                  fails=fails, warns=warns)


# ---------------------------------------------------------------------------
# self-calibration — reproduces every number above from the art on disk
# ---------------------------------------------------------------------------

def calibrate(verbose=True):
    import glob
    import itertools
    import json
    import os
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    M, A = [], []
    for p in sorted(glob.glob(os.path.join(root, "trees", "*", "scenery.json"))):
        m = json.load(open(p))
        M.append(m)
        A.append(_rgba(Image.open(os.path.join(root, m["sprite"]))))
    lab = np.array([m["lights"] == "LIGHTS_ON" for m in M])
    ids = [m["id"] for m in M]
    keys = ("slender silver birch", "rowan", "lightning-split", "scots pine",
            "ivy-strangled elm", "bird cherry", "small-leaved lime",
            "white-blossomed hawthorn", "copper beech", "autumn-flame maple",
            "black alder", "crab apple", "walnut", "linden", "juniper",
            "twisted mountain pine", "storm-broken", "dead oak",
            "flame-red autumn maple", "wild pear", "fir", "field maple",
            "spruce", "autumn beech", "aspen", "willow", "bare dead tree",
            "chestnut", "coppiced", "hawthorn", "pine", "beech", "larch",
            "yew", "oak", "hornbeam", "elder", "sycamore", "cherry", "maple")

    def vkey(v):
        v = (v or "").lower()
        return next((k for k in keys if k in v), v)

    groups = {}
    for i, m in enumerate(M):
        groups.setdefault(vkey(m.get("variety", "")), []).append(i)
    same = [(i, j) for idx in groups.values()
            for i, j in itertools.combinations(idx, 2)]

    nov = [novelty(A[i], A[j])[0] for i, j in same]
    sig = [palette_signature(a) for a in A]
    pal = [palette_delta(sig[i], sig[j]) for i, j in same]
    G = np.array([glow_score(a) for a in A])
    pos, neg = G[lab], G[~lab]
    auc = sum((1 if a > b else 0.5 if a == b else 0)
              for a in pos for b in neg) / (len(pos) * len(neg))
    pairs_on_off = [(i, j) for idx in groups.values() for i in idx
                    for j in idx if lab[i] and not lab[j]]
    lit_ok = sum(1 for i, j in pairs_on_off
                 if G[i] >= GLOW_FLOOR and G[i] - G[j] >= GLOW_LIT_DELTA)
    rem_ok = sum(1 for i, j in pairs_on_off
                 if G[i] - G[j] >= GLOW_REMOVE_DELTA or G[j] <= GLOW_FLOOR)
    if verbose:
        print(f"{len(M)} trees, {len(groups)} varieties, {len(same)} same-variety pairs")
        print(f"(a) novelty  same-variety: min={min(nov):.3f} med={np.median(nov):.3f} "
              f"| rejected at {NOVELTY_MIN}: "
              f"{sum(1 for x in nov if x < NOVELTY_MIN)}/{len(nov)}")
        print(f"(b) palette  same-variety: med={np.median(pal):.1f} p90="
              f"{np.percentile(pal, 90):.1f} max={max(pal):.1f} | over FAIL "
              f"{PALETTE_FAIL:.0f}: {sum(1 for x in pal if x > PALETTE_FAIL)}/{len(pal)}")
        print(f"(c) glow     AUC={auc:.3f} | ON min/med/max="
              f"{pos.min():.3f}/{np.median(pos):.3f}/{pos.max():.3f} "
              f"OFF min/med/max={neg.min():.3f}/{np.median(neg):.3f}/{neg.max():.3f}")
        print(f"    LIT rule passes {lit_ok}/{len(pairs_on_off)} labelled ON/OFF pairs; "
              f"REMOVE rule passes {rem_ok}/{len(pairs_on_off)}")
        print(f"    LIT floor alone: {int((pos >= GLOW_FLOOR).sum())}/{len(pos)} "
              f"known-good LIGHTS_ON trees clear {GLOW_FLOOR}")
    return dict(ids=ids, glow=G.tolist(), novelty=nov, palette=pal, auc=auc)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--calibrate", action="store_true",
                    help="re-derive every threshold's stats from trees/ on disk")
    ap.add_argument("--glow", nargs="+", metavar="SPRITE",
                    help="print the glow score of each sprite")
    ap.add_argument("--compare", nargs=2, metavar=("A", "B"),
                    help="novelty + palette distance between two sprites")
    args = ap.parse_args()
    if args.glow:
        for p in args.glow:
            print(f"{glow_score(p):.4f}  {p}")
    if args.compare:
        a, b = args.compare
        n, s, r, off = novelty(a, b)
        print(f"novelty={n:.4f} (shape {s:.4f}, rgb {r:.4f}, aligned {off}) "
              f"palette={palette_delta(a, b):.1f} dE")
    if args.calibrate or not any([args.glow, args.compare]):
        calibrate()
