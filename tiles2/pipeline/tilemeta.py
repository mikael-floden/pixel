"""Per-tile metadata for map builders: edge material samples, composition %, and a
short heuristic description of standout features.

For each tile we describe its TOP diamond:
  * `composition` — % of each material over the top (grass 0.6 / dirt 0.4 …), so
    the builder knows the overall mix (a mostly-grass tile with a dirt speck can
    foreshadow a biome long before its border).
  * `edges` — 8 samples along each of the 4 diamond edges (NE/SE/SW/NW), each
    labelled by material TYPE-ID, so neighbours pair when a shared edge matches
    (A.SE == reverse(B.NW), A.NE == reverse(B.SW)). Plus a derived ratio and, for
    a clean single split, a `divider` fraction.
  * `description` — a short human string of standout FEATURES (flowers, pebbles,
    shiny specks, bare soil …) detected as top pixels that sit far from every
    material target, so a designer can place tiles without opening them.

Materials are classified against the per-type `harmonize_target` colours — the
harmonisation squeezes each material to a tight target, which makes this reliable.
"""

from __future__ import annotations

from collections import Counter

import numpy as np
from PIL import Image

import common

SAMPLES_PER_EDGE = 8
FEATURE_DIST = 75.0        # (a,b,L) distance beyond which a top pixel is a "feature"
FEATURE_MIN_PX = 6         # a feature must be at least this many pixels (ignore texture noise)


def target_abL(t):
    h = t["hue"] * (2 * np.pi / 256.0)
    return np.array([t["sat"] * np.cos(h), t["sat"] * np.sin(h), t["value"]], dtype=np.float32)


def _abL(hsv):
    h = hsv[:, :, 0] * (2 * np.pi / 256.0)
    s = hsv[:, :, 1]
    v = hsv[:, :, 2]
    return np.stack([s * np.cos(h), s * np.sin(h), v], axis=-1)


def diamond_corners(img):
    a = np.asarray(img.convert("RGBA"))
    al = a[:, :, 3] > 16
    cols = np.where(al.any(0))[0]
    if not len(cols):
        return None
    xmin, xmax = int(cols.min()), int(cols.max())
    cx = (xmin + xmax) // 2
    apex = int(np.where(al[:, cx])[0].min())
    yw = int(np.where(al[:, xmin])[0].min())
    return {"N": (cx, apex), "E": (xmax, yw), "S": (cx, 2 * yw - apex), "W": (xmin, yw), "C": (cx, yw)}


def _in_diamond(x, y, c):
    cx, cy = c["C"]
    hw = max(c["E"][0] - cx, 1)
    hh = max(cy - c["N"][1], 1)
    return abs(x - cx) / hw + abs(y - cy) / hh <= 1.02


def classify(img, targets):
    """Per-pixel nearest material and its distance. targets: {tid: abL vector}."""
    ab = _abL(np.asarray(img.convert("HSV"), dtype=np.float32))
    tids = list(targets)
    tv = np.stack([targets[t] for t in tids])
    d = np.linalg.norm(ab[:, :, None, :] - tv[None, None, :, :], axis=-1)
    return d.argmin(-1), d.min(-1), tids


def _majority(idx, sx, sy, tids):
    H, W = idx.shape
    vals = [idx[min(max(sy + dy, 0), H - 1), min(max(sx + dx, 0), W - 1)]
            for dy in (-1, 0, 1) for dx in (-1, 0, 1)]
    return tids[max(set(vals), key=vals.count)]


def _ratio(samples):
    n = len(samples)
    return {k: round(v / n, 3) for k, v in Counter(samples).items()}


def _divider(samples):
    runs = []
    for v in samples:
        if not runs or runs[-1][0] != v:
            runs.append([v, 1])
        else:
            runs[-1][1] += 1
    return round(runs[0][1] / len(samples), 3) if len(runs) == 2 else None


def edges(img, c, idx, tids, k=SAMPLES_PER_EDGE):
    cx, cy = c["C"]
    out = {}
    seq = {"NE": (c["N"], c["E"]), "SE": (c["E"], c["S"]),
           "SW": (c["S"], c["W"]), "NW": (c["W"], c["N"])}
    for name, (p0, p1) in seq.items():
        s = []
        for i in range(k):
            t = (i + 0.5) / k
            x = p0[0] + (p1[0] - p0[0]) * t
            y = p0[1] + (p1[1] - p0[1]) * t
            dx, dy = cx - x, cy - y
            n = (dx * dx + dy * dy) ** 0.5 or 1
            s.append(_majority(idx, int(round(x + dx / n * 3)), int(round(y + dy / n * 3)), tids))
        e = {"samples": s, "ratio": _ratio(s)}
        div = _divider(s)
        if div is not None:
            e["divider"] = div
        out[name] = e
    return out


def composition(img, c, idx, tids):
    al = np.asarray(img.convert("RGBA"))[:, :, 3] > 16
    cnt = Counter()
    tot = 0
    ys, xs = np.where(al)
    for y, x in zip(ys, xs):
        if _in_diamond(x, y, c):
            cnt[tids[idx[y, x]]] += 1
            tot += 1
    return {t: round(cnt[t] / tot, 3) for t in cnt} if tot else {}


def feature_tags(img, c, dmin):
    """Standout features = top pixels far from every material target, tagged by colour."""
    al = np.asarray(img.convert("RGBA"))[:, :, 3] > 16
    hsv = np.asarray(img.convert("HSV"), dtype=np.float32)
    tags = Counter()
    for y, x in zip(*np.where(al)):
        if dmin[y, x] <= FEATURE_DIST or not _in_diamond(x, y, c):
            continue
        h, s, v = hsv[y, x]
        if s < 45 and v > 230:
            tags["shiny"] += 1
        elif s >= 70 and 140 < h < 200:
            tags["water"] += 1                      # blue
        elif s >= 65 and (h < 30 or 33 < h < 62 or h > 205):
            tags["flowers"] += 1                    # warm / pink / purple
        elif s < 55 and 75 < v < 190:
            tags["pebbles"] += 1                    # grey
        elif 12 < h < 40 and s >= 50 and v < 175:
            tags["bare_soil"] += 1                  # darker brown
        else:
            tags["accent"] += 1
    return [t for t, n in tags.most_common() if n >= FEATURE_MIN_PX]


_FEATURE_WORDS = {"flowers": "small flowers", "pebbles": "pebbles",
                  "shiny": "a shiny speck", "bare_soil": "a bare soil patch",
                  "water": "a small puddle", "accent": "a small detail"}


def describe(sheet_meta, comp, feats):
    def nm(tid):
        return (common.load_type_meta(tid) or {}).get("name", tid)
    frm, to = sheet_meta.get("ground_type"), sheet_meta.get("transition_to")
    # order materials by how much of the tile they cover
    present = sorted(comp.items(), key=lambda kv: -kv[1])
    if to and len(present) >= 2 and present[1][1] >= 0.05:
        base = f"{nm(present[0][0])} blending to {nm(present[1][0])}"
    else:
        dom = present[0][0] if present else (frm or to)
        base = ("plain " + nm(dom)) if not feats else nm(dom)
    extra = [_FEATURE_WORDS[f] for f in feats if f in _FEATURE_WORDS]
    return base + (" with " + ", ".join(extra) if extra else "")


def tile_metadata(img, targets, sheet_meta):
    """Full per-tile metadata dict: composition + edges + description."""
    c = diamond_corners(img)
    if not c or not targets:
        return {}
    idx, dmin, tids = classify(img, targets)
    comp = composition(img, c, idx, tids)
    feats = feature_tags(img, c, dmin)
    return {
        "composition": comp,
        "edges": edges(img, c, idx, tids),
        "features": feats,
        "description": describe(sheet_meta, comp, feats),
    }
