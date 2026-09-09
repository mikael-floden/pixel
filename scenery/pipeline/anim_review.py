"""Which animations are safe to switch on: ANIMATION_PROBABLY_GOOD / _BAD.

His rule (2026-09-09): "The goal with the animations is to just animate some
part of the object while the object itself stands still on the ground. It's ok
if the leaves move and it's even better if the leaves and the branches move,
but as soon as the root moves it looks wrong and the animation can't be used."

The four states are his: PROBABLY_GOOD and PROBABLY_BAD are mine to set, and he
promotes to ANIMATION_APPROVED or ANIMATION_REDO in the wiki. The game switches
animation on for PROBABLY_GOOD and APPROVED; REDO shows no animation until the
clip is regenerated with less movement, and then it comes back here.

WHY THIS IS NOT ONE THRESHOLD. Measured over all 2,327 clips: how MUCH moves
says nothing. tree_040 (crown only, right) redraws 74% of its pixels, exactly
like tree_066 (whole trunk, wrong). The fraction that stays still is worse than
useless — his ideal cases, tree_083 and tree_022, are the LOWEST at 0.30 and
0.45, below cairn_026 which is wrong. The same amount of movement means opposite
things depending on what the object IS: a tree's crown may move, a stack of
stones may not.

So the test is per CLASS, and the numbers only ask whether the movement stayed
where that class allows:

  foliage  the crown IS the animation; only the footing must hold  base<=0.12
  fire     the flame may move, the body may not                    base<=0.08, still>=0.55
  water    the water may move, the stonework may not               base<=0.08, still>=0.50
  rigid    nothing may move but a small emitter (a glowing seam)   base<=0.03, still>=0.85

`base` is the share of the object's bottom 15% that CHANGES COLOUR between
frames — not alpha, which cannot see a trunk repainted in place and scored
tree_040 and tree_066 identically at ~0.0. `still` is the share of the object
never touched. Both taken at the worst frame and worst direction, because the
game may draw any facing.

Thresholds calibrated by eye on zoomed frame-difference renders, not chosen:
tree_083/tree_022 (right) sit at 0.098/0.089, cairn_026 (wrong) at 0.067 rigid,
torch_post_018 (right) at 0.000/0.72 fire. A thumbnail is not enough — three
pieces read as wrong at thumbnail size and right at full size (hearth_900,
cairn_016 twice), so every calibration here was made zoomed.

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

FOLIAGE = set("""ancient_trees briar_thickets bushes cattail_clumps cliff_mosses cliff_roots
 cliff_shrubs cliff_vines cup_fungi ferns flower_stands flower_trellises frost_flowers
 giant_mushrooms grass_tufts hanging_baskets hanging_willows haystacks honey_trees hop_poles
 ivy_posts maypoles moss_clumps mushrooms overgrown_archways puffballs reed_beds sheaf_poles
 toadstool_rings trailing_planters trees wasp_nest_trees water_lily_clumps wisteria_snags""".split())
FIRE = set("""anvils beacons beached_rowboats beds bell_posts braziers campfire carts
 cauldron_camps chairs_and_benches charcoal_kilns cupboards_and_shelves fences fish_drying_racks
 flame_niches graves hearths house_clutter lantern_posts lantern_stands market_stalls
 offering_tables scarecrows signposts story_posts streetlights tables torch_posts wall_hangings
 washing_lines wayside_shrines windmills""".split())
WATER = set("""wells spring_basins stone_fountains hot_springs moon_pools frozen_springs
 water_pumps waterwheels""".split())
RULES = {"foliage": (0.12, 0.00), "fire": (0.08, 0.55),
         "water": (0.08, 0.50), "rigid": (0.03, 0.85)}


def class_of(rel):
    g = rel.split("/", 1)[0]
    return ("foliage" if g in FOLIAGE else "fire" if g in FIRE
            else "water" if g in WATER else "rigid")


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
    """(base, still) at the worst frame — base is COLOUR change in the bottom
    15%, not alpha; alpha cannot see a trunk repainted in place."""
    ims = [np.asarray(Image.open(os.path.join(factory.ROOT, p)).convert("RGBA"),
                      dtype=np.int16) for p in fps]
    if len({im.shape for im in ims}) != 1:
        return None
    a0 = ims[0][..., 3] > 8
    union = a0.copy()
    moved = np.zeros(a0.shape, bool)
    for im in ims[1:]:
        union |= im[..., 3] > 8
        moved |= np.abs(im - ims[0]).sum(axis=2) > 12
    ys = np.where(union.any(axis=1))[0]
    if not len(ys):
        return None
    y0, y1 = int(ys.min()), int(ys.max())
    b = y1 - max(3, int(round((y1 - y0 + 1) * 0.15))) + 1
    band = a0[b:y1 + 1]
    base = float((moved[b:y1 + 1] & band).sum() / max(int(band.sum()), 1))
    still = float(((~moved) & a0).sum() / max(int(a0.sum()), 1))
    return base, still


def judge(rel, man):
    """{(state, name): (verdict, cls, base, still)} — worst direction wins,
    because the game may draw any facing."""
    worst = collections.defaultdict(lambda: (0.0, 1.0))
    for state, name, _d, fps in clips(man):
        m = measure(fps)
        if m is None:
            continue
        b, s = m
        pb, ps = worst[(state, name)]
        worst[(state, name)] = (max(pb, b), min(ps, s))
    cls = class_of(rel)
    mb, ms = RULES[cls]
    return {k: (MINE[0] if (b <= mb and s >= ms) else MINE[1], cls, round(b, 4), round(s, 3))
            for k, (b, s) in worst.items()}


def stamp(write=False):
    tally = collections.Counter()
    kept = 0
    for rel, man in factory.discover():
        v = judge(rel, man)
        if not v:
            continue
        dirty = False
        for (state, name), (verdict, cls, b, s) in v.items():
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
                a["review_metrics"] = {"class": cls, "base": b, "still": s}
                dirty = True
            tally[verdict] += 1
        if dirty and write:
            factory.write_manifest(rel, man)
    return tally, kept


def check():
    bad = []
    for rel, man in factory.discover():
        for state, name, _d, _f in clips(man):
            c = man if state is None else man["states"][state]
            a = (c.get("animations") or {}).get(name) or {}
            if a.get("review") not in STATES:
                bad.append((f"{rel}#{state}#{name}", a.get("review")))
    return bad


if __name__ == "__main__":
    if "--check" in sys.argv:
        bad = check()
        for k, v in bad[:15]:
            print(f"  {k:<56} review={v!r}")
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
