"""Rebuild a piece's `states` map from the state directories on disk.

Recovery for the concurrent-write race in tree_variants.finalize: the art was
written correctly but the manifest entry was clobbered by a sibling state that
finalized with a stale snapshot. The sprites are the source of truth here — a
state directory holding a sprite IS that state, whatever the manifest says.
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
import factory, viewer_build
import numpy as np
from PIL import Image


def glow_score(img):
    a = np.asarray(img.convert("RGBA")).astype(float)
    op = a[:, :, 3] > 16
    if op.sum() < 50:
        return 0.0
    return float((a[:, :, :3].max(2)[op] > 200).mean())


def main():
    fixed = added = 0
    for rel, man in factory.discover():
        d = factory.piece_dir(rel)
        dirs = [x for x in sorted(os.listdir(d))
                if os.path.isdir(os.path.join(d, x))
                and x.startswith(("not_lit", "lit"))
                and os.path.exists(os.path.join(d, x, "sprite.webp"))]
        if not dirs:
            continue
        states = dict(man.get("states") or {})
        before = len(states)
        for x in dirs:
            key = x.upper()
            if key in states:
                continue
            sp = f"{rel}/{x}/sprite.webp"
            states[key] = {"sprite": sp,
                           "glow_score": round(glow_score(Image.open(
                               os.path.join(factory.ROOT, sp))), 4),
                           "recovered": True}
            added += 1
        if len(states) != before:
            man["states"] = {k: states[k] for k in sorted(states)}
            factory.write_manifest(rel, man)
            fixed += 1
    viewer_build.build()
    print(f"reindexed {fixed} piece(s), recovered {added} state(s)")


if __name__ == "__main__":
    main()
