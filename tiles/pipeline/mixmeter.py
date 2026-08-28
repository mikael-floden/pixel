#!/usr/bin/env python3
# ADOPTED from the classifier bake-off (2026-08-28): the region-arbitrated
# texture+colour meter - the design that survived all four historical traps in direct
# testing (mud/grass tufts 35.8% where attempt 3 read 0.2%; rock/water 6.9% where
# attempt 1 read 61%). Model: cache/meter.npz, trained on tiles/tops sheets 0,1,3,4
# per ground with 2 and 5 held out; the code never trains at import.
"""mix_fraction(image, ground_a, ground_b) -> share of the top face that is ground B.

    from mixmeter import mix_fraction
    mix_fraction("tiles/blends/dark_mud__with__grass/p30/tile_00.webp",
                 "dark_mud", "grass")            # -> 0.0 .. 1.0

WHAT IS DIFFERENT ABOUT IT (the four previous attempts all compared a pixel to a
colour, and each died on a different pair):

 1. IT IS TRAINED, NOT ASSUMED.  Every ground is described by a MIXTURE of prototypes
    learned from `tiles/tops/` - the 90 pure single-ground sheets the same generator
    drew - never by its palette entry.  So "black rock is a dark matrix WITH bright
    glints" is representable, and the glints stay rock instead of becoming the other
    ground.  (Failure 1 was one colour per ground; failure 3 was believing the palette;
    failure 4 was one art reference per ground.)

 2. IT DESCRIBES A PIXEL BY ITS NEIGHBOURHOOD, NOT ITS VALUE.  35 mask-limited local
    statistics: Lab, multi-scale roughness, gradient energy, edge density, four
    directional energies and their anisotropy, speckle, tonal diversity.  Two grounds
    that share a colour still differ here.

 3. TEXTURE IS JUDGED PER REGION, COLOUR PER PIXEL.  Measured on held-out pure tops:
    per-pixel texture identifies the ground 64.6% of the time, per-pixel colour 92.9%.
    Per REGION the same texture is 75.5% and on the colour-collision pairs it BEATS
    colour (grey_stone/grey_paving 0.94 vs 0.81).  A texture is a property of a patch,
    not of a pixel, so colour proposes regions and each region large enough to have a
    texture is then arbitrated on its aggregate.

 4. HOW MUCH TEXTURE IS TRUSTED IS FITTED PER PAIR, LEAVE-ONE-SHEET-OUT.  A pair whose
    colour carries across to an unseen sheet gets lambda ~ 0; grey_stone/grey_paving,
    whose colour does not, gets a large one.  Nothing is trusted because it sounds right.

 5. WINDOWS THAT STRADDLE TWO GROUNDS ARE REJECTED, NOT BELIEVED.  On a mixture finer
    than a texture window only 12-18% of top-face pixels have a single-ground
    neighbourhood; on those the call is 86-95% right, on the rest 60%, and the rest are
    the majority.  Such a window is not a hard case but an INVALID one - it describes a
    material that does not exist - so it scores low under BOTH ground models and an
    explicit likelihood gate closes on it, dropping that pixel back to colour alone.

Trained on tiles/tops sheets 0,1,3,4 of every ground; sheets 2 and 5 are held out and
every number quoted above was measured on them or on real blend art.

CLI:  python3 mixmeter.py <tile.webp> <ground_a> <ground_b>
      python3 mixmeter.py --sheet tiles/blends/dark_mud__with__grass/p30 dark_mud grass
"""
from __future__ import annotations

import glob
import os
import sys

import numpy as np
from PIL import Image

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "meter.npz")

# ---------------------------------------------------------------- geometry ---------
TILE = 64
_yy, _xx = np.mgrid[0:TILE, 0:TILE]
DIAMOND = (np.abs(_xx - 31.5) / 32.0 + np.abs(_yy - 23.0) / 14.6) <= 1.0
# The nominal 64x28 top diamond, centred where every tiles3 tile puts it. Measured on
# tops and puddles it agrees with transition_render.top_face to within 12 px; on blends
# it drops the raised overhang some sheets draw ABOVE the diamond (up to 1096 px, and on
# the black_rock/grey_stone p50 sheets that region is a white generation artefact).

# ---------------------------------------------------------------- tuned constants ---
GAIN = 4.0          # temperature on the per-pixel log-odds (measured on train-sheet
                    # composites: flat within 0.15pp from 1 to 8, so this is not a knob
                    # anything hinges on)
LAM_SCALE = 1.0     # global multiplier on the per-pair texture trust
PRIOR_CAP = 0.0     # NO adaptive prior. An EM-estimated mixture prior was built and
                    # measured: 15.45 -> 15.55pp, i.e. nothing, and uncapped it is
                    # actively dangerous - with weak per-pixel evidence the fixed point
                    # runs away to 0 or 1 and a pure snow tile read 73% ice. The plain
                    # soft count over a fixed 50/50 prior is what ships.
CLIP = 12.0         # per-pixel log-odds clip: no single pixel may outvote a region
MIN_REGION = 45     # px below which a patch has no texture to measure
REGION_W = 0.5      # how much of a pixel's vote is replaced by its region's consensus
SMOOTH_R = 2


# ---------------------------------------------------------------- features ---------
def srgb_to_lab(rgb):
    c = np.asarray(rgb, float) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883])
    e, k = 216 / 24389.0, 24389 / 27.0
    f = np.where(xyz > e, np.cbrt(xyz), (k * xyz + 16) / 116.0)
    return np.stack([116 * f[..., 1] - 16,
                     500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], -1)


def shift(a, dy, dx, fill=0.0):
    out = np.full_like(a, fill, dtype=float)
    h, w = a.shape[:2]
    ys0, ys1, xs0, xs1 = max(0, dy), h + min(0, dy), max(0, dx), w + min(0, dx)
    yd0, yd1, xd0, xd1 = max(0, -dy), h + min(0, -dy), max(0, -dx), w + min(0, -dx)
    out[ys0:ys1, xs0:xs1] = a[yd0:yd1, xd0:xd1]
    return out


def _off(r):
    return [(dy, dx) for dy in range(-r, r + 1) for dx in range(-r, r + 1)]


def box(x, mask, r):
    m = mask.astype(float)
    s = np.zeros_like(x, float); s2 = np.zeros_like(x, float); n = np.zeros_like(x, float)
    for dy, dx in _off(r):
        v = shift(np.where(mask, x, 0.0), dy, dx)
        s += v; s2 += v * v; n += shift(m, dy, dx)
    n = np.maximum(n, 1.0)
    mu = s / n
    return mu, np.sqrt(np.maximum(s2 / n - mu * mu, 0.0))


def boxmean(x, mask, r):
    return box(x, mask, r)[0]


def boxrange(x, mask, r):
    lo = np.full_like(x, 1e9, float); hi = np.full_like(x, -1e9, float)
    for dy, dx in _off(r):
        w = shift(mask.astype(float), dy, dx) > 0.5
        v = shift(np.where(mask, x, 0.0), dy, dx)
        lo = np.where(w, np.minimum(lo, v), lo)
        hi = np.where(w, np.maximum(hi, v), hi)
    return np.where(hi > -1e8, hi - lo, 0.0)


def _masked_median(x, mask, r):
    planes = []
    for dy, dx in _off(r):
        p = np.full(x.shape, np.nan)
        w = shift(mask.astype(float), dy, dx) > 0.5
        v = shift(x, dy, dx)
        p[w] = v[w]
        planes.append(p)
    with np.errstate(all="ignore"):
        out = np.nanmedian(np.stack(planes, 0), 0)
    return np.where(np.isnan(out), x, out)


def dirdiff(L, mask, dy, dx):
    v = shift(L, -dy, -dx)
    ok = (shift(mask.astype(float), -dy, -dx) > 0.5) & mask
    return np.where(ok, np.abs(L - v), 0.0)


NAMES = ["L", "a", "b", "Lmean2", "Lmean4", "amean2", "bmean2", "Lres1", "Lres4",
         "ares2", "bres2", "Lstd1", "Lstd2", "Lstd4", "astd2", "bstd2", "Lrange2",
         "grad1", "grad3", "edged", "edged_hi", "dir01", "dir2_01", "dir10", "dir2_10",
         "dir11", "dir2_11", "dir1-1", "dir2_1-1", "aniso", "aniso_h", "aniso_v",
         "speckle", "speckle3", "tones2"]

COLOUR = ["L", "a", "b", "Lres1", "Lstd1", "speckle", "grad1"]
TEXTURE = ["Lres1", "Lres4", "ares2", "bres2", "Lstd1", "Lstd2", "Lstd4", "astd2",
           "bstd2", "Lrange2", "grad1", "grad3", "edged", "edged_hi",
           "dir01", "dir10", "dir11", "dir1-1", "dir2_01", "dir2_10", "dir2_11",
           "dir2_1-1", "aniso", "aniso_h", "aniso_v", "speckle", "speckle3", "tones2"]
CI = [NAMES.index(n) for n in COLOUR]
TI = [NAMES.index(n) for n in TEXTURE]


def features(rgba, mask=None):
    """(H,W,35) local statistics, every window limited to `mask`."""
    a = np.asarray(rgba, int)
    if mask is None:
        mask = DIAMOND & (a[..., 3] > 0)
    lab = srgb_to_lab(a[..., :3].astype(float))
    L, A, B = lab[..., 0], lab[..., 1], lab[..., 2]
    f = []
    def add(x):
        f.append(np.where(mask, x, 0.0))
    m1, s1 = box(L, mask, 1)
    m2, s2 = box(L, mask, 2)
    m4, s4 = box(L, mask, 4)
    ma2, sa2 = box(A, mask, 2)
    mb2, sb2 = box(B, mask, 2)
    add(L); add(A); add(B); add(m2); add(m4); add(ma2); add(mb2)
    add(L - m1); add(L - m4); add(A - ma2); add(B - mb2)
    add(s1); add(s2); add(s4); add(sa2); add(sb2)
    add(boxrange(L, mask, 2))
    g = dirdiff(L, mask, 0, 1) + dirdiff(L, mask, 1, 0)
    add(boxmean(g, mask, 1)); add(boxmean(g, mask, 3))
    add(boxmean((g > 8).astype(float), mask, 3))
    add(boxmean((g > 20).astype(float), mask, 3))
    ds = []
    for (dy, dx) in ((0, 1), (1, 0), (1, 1), (1, -1)):
        e = boxmean(dirdiff(L, mask, dy, dx), mask, 3)
        e2 = boxmean(dirdiff(L, mask, 2 * dy, 2 * dx), mask, 3)
        ds.append(e); add(e); add(e2)
    ds = np.stack(ds, 0)
    tot = ds.sum(0) + 1e-6
    add((ds.max(0) - ds.min(0)) / tot); add(ds[0] / tot); add(ds[1] / tot)
    med = _masked_median(L, mask, 1)
    add(np.abs(L - med)); add(boxmean(np.abs(L - med), mask, 3))
    add(boxrange(np.round(L / 4.0), mask, 2))
    return np.stack(f, -1), mask


# ---------------------------------------------------------------- the model --------
class Stream:
    """One whitened feature space + a prototype mixture per ground."""

    def __init__(self, mu, W, mods):
        self.mu, self.W, self.mods = mu, W, mods

    def logp(self, Z, g):
        C, var, wt = self.mods[g]
        D = Z.shape[1]
        d = ((Z[:, None, :] - C[None]) ** 2).sum(-1)
        ll = -0.5 * (d / var[None] + D * np.log(2 * np.pi * var)[None]) + np.log(wt)[None]
        mx = ll.max(1)
        return mx + np.log(np.exp(ll - mx[:, None]).sum(1))


class Meter:
    def __init__(self, path=MODEL):
        z = np.load(path, allow_pickle=True)
        gs = [k[5:] for k in z.files if k.startswith("colC_")]
        self.col = Stream(z["col_mu"], z["col_W"],
                          {g: (z["colC_" + g], z["colV_" + g], z["colP_" + g]) for g in gs})
        self.tex = Stream(z["tex_mu"], z["tex_W"],
                          {g: (z["texC_" + g], z["texV_" + g], z["texP_" + g]) for g in gs})
        self.tau, self.spread = float(z["tau"]), float(z["spread"])
        self.lam = {str(k): float(v) for k, v in zip(z["lkeys"], z["lvals"])}
        self.grounds = sorted(gs)

    def trust(self, a, b):
        """How much this PAIR's texture evidence is worth, fitted leave-one-sheet-out."""
        if f"{a}|{b}" in self.lam:
            return self.lam[f"{a}|{b}"]
        return self.lam.get(f"{b}|{a}", 0.0)

    def evidence(self, img, a, b, mask=None):
        F, m = features(img, mask)
        if not m.any():
            return None
        X = F[m].astype(np.float64)
        Zc = (X[:, CI] - self.col.mu) @ self.col.W
        Zt = (X[:, TI] - self.tex.mu) @ self.tex.W
        lc = np.clip(self.col.logp(Zc, b) - self.col.logp(Zc, a), -CLIP, CLIP)
        ta, tb = self.tex.logp(Zt, a), self.tex.logp(Zt, b)
        gate = 1.0 / (1.0 + np.exp(-(np.maximum(ta, tb) - self.tau) / self.spread))
        lt = gate * np.clip(tb - ta, -CLIP, CLIP)
        return lc, lt, m


# ---------------------------------------------------------------- regions ----------
def _label(mask):
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    sizes = [0]
    nb = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    for y0, x0 in zip(*np.nonzero(mask)):
        if lab[y0, x0]:
            continue
        k = len(sizes); sizes.append(0)
        st = [(y0, x0)]; lab[y0, x0] = k
        while st:
            y, x = st.pop(); sizes[k] += 1
            for dy, dx in nb:
                yy, xx = y + dy, x + dx
                if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = k; st.append((yy, xx))
    return lab, np.array(sizes)


def _erode(m, n=1):
    e = m.copy()
    for _ in range(n):
        f = e.copy()
        e[1:] &= f[:-1]; e[:-1] &= f[1:]
        e[:, 1:] &= f[:, :-1]; e[:, :-1] &= f[:, 1:]
    return e


def smooth_masked(x, mask, r):
    if r <= 0:
        return x
    s = np.zeros_like(x); n = np.zeros_like(x)
    m = mask.astype(float)
    for dy, dx in _off(r):
        s += shift(np.where(mask, x, 0.0), dy, dx); n += shift(m, dy, dx)
    return np.where(mask, s / np.maximum(n, 1e-9), 0.0)


def region_means(lc_map, lt_map, mask, min_region=MIN_REGION):
    """(regional colour log-odds, regional texture log-odds, in-a-region mask).

    COLOUR PROPOSES THE REGIONS - the split is the sign of the smoothed colour log-odds -
    and each patch big enough to HAVE a texture is then judged on its interior, eroded by
    one so the patch's own rim (where every window already straddles the boundary) never
    votes.  A patch smaller than `min_region` gets no regional term at all, which is what
    makes a 1px speckle fall back to pure per-pixel colour automatically.
    """
    seg = smooth_masked(lc_map, mask, SMOOTH_R) > 0
    rc = np.zeros_like(lc_map)
    rt = np.zeros_like(lt_map)
    inreg = np.zeros(mask.shape, bool)
    for cls in (True, False):
        lab, sz = _label(mask & (seg == cls))
        for k in range(1, len(sz)):
            if sz[k] < min_region:
                continue
            reg = lab == k
            inner = _erode(reg)
            if inner.sum() < 12:
                inner = reg
            rc[reg] = float(lc_map[inner].mean())
            rt[reg] = float(lt_map[inner].mean())
            inreg |= reg
    return rc, rt, inreg


def _sig(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -40, 40)))


def em_prior(llr, cap=PRIOR_CAP):
    """Area share under a mixture prior, the prior itself estimated by EM and CAPPED."""
    pi = 0.5
    for _ in range(100):
        p = _sig(llr + float(np.clip(np.log(pi / (1 - pi)), -cap, cap)))
        n = float(p.mean())
        if abs(n - pi) < 1e-7:
            return n
        pi = min(max(n, 1e-4), 1 - 1e-4)
    return pi


# ---------------------------------------------------------------- the API ----------
_METER = None


def meter(path=MODEL):
    global _METER
    if _METER is None:
        _METER = Meter(path)
    return _METER


def as_rgba(image):
    if isinstance(image, str):
        return np.array(Image.open(image).convert("RGBA"), int)
    if isinstance(image, Image.Image):
        return np.array(image.convert("RGBA"), int)
    return np.asarray(image, int)


def mix_fraction(image, ground_a_name, ground_b_name, mask=None, detail=False):
    """Share of the tile's TOP FACE that is ground B, in [0, 1].

    `image` is a path, a PIL image, or an HxWx4 array of a 64x64 tiles3 tile.
    Order matters only for the sense of the answer: mix_fraction(t, A, B) and
    mix_fraction(t, B, A) sum to 1 by construction.
    """
    M = meter()
    a, b = ground_a_name, ground_b_name
    if a not in M.grounds or b not in M.grounds:
        raise KeyError(f"unknown ground: {a if a not in M.grounds else b}")
    if a == b:
        return 0.0
    arr = as_rgba(image)
    ev = M.evidence(arr, a, b, mask)
    if ev is None:
        return 0.0
    lc, lt, m = ev
    lcm = np.zeros(m.shape); lcm[m] = lc
    ltm = np.zeros(m.shape); ltm[m] = lt
    rc, rt, inreg = region_means(lcm, ltm, m)
    lam = LAM_SCALE * M.trust(a, b)
    w = np.where(inreg[m], REGION_W, 0.0)
    llr = GAIN * ((1 - w) * lc + w * rc[m] + lam * rt[m])
    f = em_prior(llr)
    if detail:
        p = np.zeros(m.shape); p[m] = _sig(llr)
        return f, dict(post=p, mask=m, colour=lcm, texture=ltm, rc=rc, rt=rt,
                       inreg=inreg, lam=lam)
    return float(f)


def sheet_fraction(directory, a, b):
    out = []
    for p in sorted(glob.glob(os.path.join(directory, "tile_*.webp"))):
        out.append((os.path.basename(p), mix_fraction(p, a, b)))
    return out


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--sheet"]:
        d, a, b = args[1], args[2], args[3]
        vals = sheet_fraction(d, a, b)
        for n, v in vals:
            print(f"{n:24s} {v:6.3f}")
        print(f"{'MEAN':24s} {np.mean([v for _, v in vals]):6.3f}")
    else:
        p, a, b = args[0], args[1], args[2]
        print(f"{mix_fraction(p, a, b):.4f}")
