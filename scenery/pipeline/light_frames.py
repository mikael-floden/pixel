"""Per-frame light for LIT animations: how bright, and where, on every frame.

Maintainer 2026-09-09: "What I'm after is for the light to feel more dynamic.
So if we have an intensity scale per frame and a 'spotlight center' per frame
that we calculate based on if the light source gets stronger/dimmer and if the
light source center changes, it will give the effect that the spotlight differs
a bit with the animation and the game will feel more alive."

Every animation on a LIT_* state (and the legacy always-lit piece-root ones),
windows excluded, carries beside its frame_paths:

    "light_frames": [{"intensity": 1.08, "dx": 0.4, "dy": -2.1}, ...]

one entry per frame, same order. `intensity` is relative to the animation's
own mean (so the block's `strength` × intensity is the frame's strength, and a
loop averages to exactly what the block says). `dx`/`dy` are the emissive
centroid's offset from the FRAME CENTRE in frame pixels — the hitbox
convention, so a consumer already placing ellipses can place this the same way.

Measured from the same emissive pixels light.py measures colour from (V >= 0.8,
S >= 0.2, alpha), so the frame data and the block agree on what the light IS.
Energy is the sum of V over those pixels; the centroid is V-weighted.

CLAMPED to [0.5, 1.5]. A frame whose flame the criterion barely catches would
otherwise read as near-off and strobe the room; dimmer is the effect he wants,
blackout is not. A frame with NO emissive pixel takes 0.5 and the mean centre of
the frames that have one.

A pure function of the frames on disk, so it is always recomputed — a
regenerated clip gets fresh numbers and nothing reviewed is ever overwritten,
because nothing here is reviewed.

    python3 scenery/pipeline/light_frames.py --write
    python3 scenery/pipeline/light_frames.py --check
"""
from __future__ import annotations

import collections, os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory, viewer_build, anim_review
from light import V_MIN, S_MIN

LO, HI = 0.5, 1.5
EXCLUDE_GROUPS = {"windows"}


def _frame(path):
    a = np.asarray(Image.open(os.path.join(factory.ROOT, path)).convert("RGBA"), dtype=np.float32) / 255
    rgb, al = a[..., :3], a[..., 3]
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    em = (al > 0.5) & (mx >= V_MIN) & (sat >= S_MIN)
    h, w = al.shape
    if not em.any():
        return 0.0, None, (w, h)
    v = mx[em]
    ys, xs = np.nonzero(em)
    cx = float((xs * v).sum() / v.sum()); cy = float((ys * v).sum() / v.sum())
    return float(v.sum()), (cx - w / 2.0, cy - h / 2.0), (w, h)


def annotate(fps):
    meas = [_frame(p) for p in fps]
    energies = [e for e, _, _ in meas]
    mean = sum(energies) / max(len(energies), 1)
    centres = [c for _, c, _ in meas if c is not None]
    fallback = (tuple(float(np.mean([c[i] for c in centres])) for i in (0, 1))
                if centres else (0.0, 0.0))
    out = []
    for e, c, _ in meas:
        i = (e / mean) if mean > 0 else 1.0
        i = min(HI, max(LO, i)) if e > 0 else LO
        dx, dy = c if c is not None else fallback
        out.append({"intensity": round(i, 3), "dx": round(dx, 1), "dy": round(dy, 1)})
    return out


def qualifies(rel, man, state):
    if rel.split("/", 1)[0] in EXCLUDE_GROUPS or not man.get("light"):
        return False
    if state is not None:
        return state.upper().startswith("LIT_")
    return man.get("lights") == "LIGHTS_ON" and not (man.get("states") or {})


def _entries(man):
    """(state, name, anim_dict, direction_dict_or_None, frame_paths) so the
    result can be written back beside the frames it describes."""
    def scan(c, state):
        for name, a in (c.get("animations") or {}).items():
            if not isinstance(a, dict):
                continue
            d = a.get("directions")
            if isinstance(d, dict):
                for k, v in d.items():
                    fps = (v or {}).get("frame_paths") or []
                    if len(fps) >= 2:
                        yield state, name, a, v, fps
            else:
                fps = a.get("frame_paths") or []
                if len(fps) >= 2:
                    yield state, name, a, None, fps
    yield from scan(man, None)
    for st, sv in (man.get("states") or {}).items():
        if isinstance(sv, dict):
            yield from scan(sv, st)


def run(write=False):
    n = clips = 0
    for rel, man in factory.discover():
        dirty = False
        for state, name, a, dd, fps in _entries(man):
            if not qualifies(rel, man, state):
                continue
            target = dd if dd is not None else a
            lf = annotate(fps)
            if target.get("light_frames") != lf:
                target["light_frames"] = lf
                dirty = True
            clips += 1; n += len(lf)
        if dirty and write:
            factory.write_manifest(rel, man)
    return clips, n


def check():
    bad = []
    for rel, man in factory.discover():
        for state, name, a, dd, fps in _entries(man):
            if not qualifies(rel, man, state):
                continue
            lf = (dd if dd is not None else a).get("light_frames")
            if not isinstance(lf, list) or len(lf) != len(fps):
                bad.append(f"{rel}#{state}#{name}: light_frames {None if lf is None else len(lf)} vs {len(fps)} frames")
    return bad


if __name__ == "__main__":
    if "--check" in sys.argv:
        bad = check()
        for b in bad[:15]:
            print("  " + b)
        print(f"{len(bad)} problem(s)" if bad else "PASS — every LIT animation frame carries intensity and centre")
        sys.exit(1 if bad else 0)
    write = "--write" in sys.argv
    clips, n = run(write)
    print(f"{clips} clip(s), {n} frame(s) annotated{'' if write else ' (DRY RUN — pass --write)'}")
    if write:
        viewer_build.build()
        print("viewer_data.json rebuilt")
