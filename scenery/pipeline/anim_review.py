"""Which animations are safe to switch on: ANIMATION_PROBABLY_GOOD / _BAD.

His rule (2026-09-09): "The goal with the animations is to just animate some
part of the object while the object itself stands still on the ground. It's ok
if the leaves move and it's even better if the leaves and the branches move,
but as soon as the root moves it looks wrong and the animation can't be used."

The four states are his: PROBABLY_GOOD and PROBABLY_BAD are mine to set, and he
promotes to ANIMATION_APPROVED or ANIMATION_REDO in the wiki. The game switches
animation on for PROBABLY_GOOD and APPROVED; REDO shows no animation until the
clip is regenerated with less movement, and then it comes back here.

MEASURE HOW FAR THE OUTLINE MOVES, NOT WHETHER PIXELS CHANGED. His correction
(2026-09-10): "you need to measure how far the pixels moved as well." A trunk
repainted with different dither changes every pixel and moves nothing; that is
invisible to the eye and must be invisible to the test.

So `base` is the share of the object's bottom 15% whose SILHOUETTE changes —
alpha, not colour. One threshold, every class: base <= 0.10.

CALIBRATED ON HIS 263 APPROVALS, which is the only ground truth there is. They
sit at median 0.003, p90 0.028, p95 0.042; 0.10 covers 98% of them. tree_009,
whose roots genuinely swing, is at 0.632 and stays out. A colour-based version
of this rejected 221 of the 263 he then approved — it scored a still trunk as
fully moving, which is how tree_066 (trunk and roots perfectly still under the
overlay) came to be my canonical bad example.

The earlier per-class table is gone with it. It existed to compensate for a
metric that could not tell repainting from movement; measuring the outline
needs no such compensation, and a rigid piece whose stones are merely repainted
now scores ~0 by itself, which is correct.

Verified before shipping, since the numbers had misled me twice: 12 randomly
sampled newly-promoted clips rendered zoomed with a silhouette-only overlay,
all 12 right — canopy over a still trunk, a lantern on a still stand, runes on
a still stone.

    python3 scenery/pipeline/anim_review.py            # report
    python3 scenery/pipeline/anim_review.py --write    # stamp the manifests
    python3 scenery/pipeline/anim_review.py --check    # gate
"""
from __future__ import annotations

import collections, json, os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory, viewer_build

MINE = ("ANIMATION_PROBABLY_GOOD", "ANIMATION_PROBABLY_BAD")
HIS = ("ANIMATION_APPROVED", "ANIMATION_REDO")
STATES = MINE + HIS

BASE_MAX = 0.10        # share of the footing's OUTLINE that may move


def clips(man):
    """(state_key_or_None, anim_name, direction, frame_paths) for every shape a
    manifest uses — directions as a dict, as a list of names, or absent."""
    def frames(a):
        d = a.get("directions")
        if isinstance(d, dict):
            for k, v in d.items():
                fps = (v or {}).get("frame_paths") or []
                if fps: yield k, fps
        else:
            fps = a.get("frame_paths") or []
            if fps: yield (d[0] if isinstance(d, list) and d else "south"), fps
    def scan(c, state):
        for name, a in (c.get("animations") or {}).items():
            if isinstance(a, dict):
                for dd, fps in frames(a):
                    if len(fps) >= 2:
                        yield state, name, dd, fps
    yield from scan(man, None)
    for st, sv in (man.get("states") or {}).items():
        if isinstance(sv, dict):
            yield from scan(sv, st)


def measure(fps):
    """Worst-frame share of the footing whose SILHOUETTE moves.

    Alpha, deliberately: colour change cannot tell a swaying trunk from a still
    one that was re-dithered, and scoring the second as movement is what
    rejected 221 clips he then approved."""
    masks = []
    shape = None
    for p in fps:
        with Image.open(os.path.join(factory.ROOT, p)) as im:
            a = np.asarray(im.convert("RGBA"))[..., 3] > 8
        if shape is None:
            shape = a.shape
        elif a.shape != shape:
            return None
        masks.append(a)
    union = masks[0].copy()
    for m in masks[1:]:
        union |= m
    ys = np.where(union.any(axis=1))[0]
    if not len(ys):
        return None
    y0, y1 = int(ys.min()), int(ys.max())
    b = y1 - max(3, int(round((y1 - y0 + 1) * 0.15))) + 1
    m0 = masks[0][b:y1 + 1]
    denom = max(int(m0.sum()), 1)
    return max(float(np.logical_xor(m0, m[b:y1 + 1]).sum() / denom) for m in masks[1:])


def judge(rel, man):
    """{(state, name): (verdict, base)} — worst direction wins, because the game
    may draw any facing."""
    worst = collections.defaultdict(float)
    for state, name, _d, fps in clips(man):
        b = measure(fps)
        if b is None:
            continue
        worst[(state, name)] = max(worst[(state, name)], b)
    return {k: (MINE[0] if b <= BASE_MAX else MINE[1], round(b, 4))
            for k, b in worst.items()}


def stamp(write=False):
    tally = collections.Counter()
    kept = 0
    for rel, man in factory.discover():
        v = judge(rel, man)
        if not v:
            continue
        dirty = False
        for (state, name), (verdict, b) in v.items():
            c = man if state is None else man["states"][state]
            a = (c.get("animations") or {}).get(name)
            if not isinstance(a, dict):
                continue
            # HIS VERDICT IS NEVER OVERWRITTEN. Once he has approved a clip or
            # sent it back, re-running this must not quietly undo him.
            if a.get("review") in HIS:
                tally[a["review"]] += 1; kept += 1; continue
            if a.get("review") != verdict:
                a["review"] = verdict
                a["review_metrics"] = {"base_outline": b}
                dirty = True
            tally[verdict] += 1
        if dirty and write:
            factory.write_manifest(rel, man)
    return tally, kept


def check():
    """Every animation carries a state, and a PLAYABLE verdict is only given to
    a clip both consumers can find: the game reads top-level frame_paths/strip
    (parseAnims), the wiki the on-disk <name>__south.webp. A verdict on a clip
    neither can see is what sent the map agent lighting brazier_008 off a
    PROBABLY_GOOD the game silently dropped (2026-09-10)."""
    bad = []
    for rel, man in factory.discover():
        for state, name, _d, fps in clips(man):
            c = man if state is None else man["states"][state]
            a = (c.get("animations") or {}).get(name) or {}
            r = a.get("review")
            if r not in STATES:
                bad.append((f"{rel}#{state}#{name}", f"review={r!r}")); continue
            if r in ("ANIMATION_PROBABLY_GOOD", "ANIMATION_APPROVED"):
                strip_ok = a.get("strip") and os.path.exists(os.path.join(factory.ROOT, a["strip"]))
                if not (a.get("frame_paths") or strip_ok):
                    bad.append((f"{rel}#{state}#{name}", "playable verdict but no top-level frame_paths and no EXISTING strip — the game drops or 404s it"))
                if a.get("strip") and not strip_ok:
                    bad.append((f"{rel}#{state}#{name}", f"strip points at a missing file: {a['strip']}"))
                rel_dir = os.path.dirname(fps[0]).rsplit("/animations", 1)[0]
                if not os.path.exists(os.path.join(factory.ROOT, f"{rel_dir}/animations/{name}__south.webp")) \
                        and not strip_ok:
                    bad.append((f"{rel}#{state}#{name}", "playable verdict but no south strip — the wiki draws a still"))
    return bad


if __name__ == "__main__":
    if "--check" in sys.argv:
        bad = check()
        for k, v in bad[:15]:
            print(f"  {k:<56} {v}")
        print(f"{len(bad)} animation(s) unjudged" if bad
              else "PASS — every animation carries a review state")
        sys.exit(1 if bad else 0)
    write = "--write" in sys.argv
    tally, kept = stamp(write)
    tot = sum(tally.values())
    for k, v in tally.most_common():
        print("  %-26s %5d  %4.1f%%" % (k, v, 100 * v / max(tot, 1)))
    print("%d animation(s)%s; %d already judged by him and left alone"
          % (tot, "" if write else " (DRY RUN — pass --write)", kept))
    if write:
        viewer_build.build()
        print("viewer_data.json rebuilt")
