"""Harvest base-tile CANDIDATES for the wiki's promote/revoke pages.

A base tile is the maintainer's concept: "a tile that can be repeated over and over
again without being annoying" — the ground a world-agent paints first. Promotion is
his call, made in the wiki; this script only lays out the ballot.

Candidates for the "own"-surface materials are the pure corner tiles of every
generated transition set, colour-corrected exactly as the game will draw them
(substitute(): palette hue and saturation, the tile's own relief). The grass he
praised IS one of these, so the pool that produced it is the pool to choose from.
A field must repeat ONE of them — mixing different-looking candidates per cell was
tried and rejected ("adding them all together looks like horse shit").
"""
import io, json, os, sys, hashlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../pipeline")
import numpy as np
from PIL import Image
import transition_render as TR
import palette_snap as PS

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PAL = json.load(open(f"{REPO}/tiles/config/palette.json"))["types"]
TRANS = f"{REPO}/tiles/transitions"
OUT = f"{REPO}/tiles/base_candidates"


def correct(im, hexv):
    a = np.array(im.convert("RGBA"), int).astype(float)
    alpha = a[..., 3] > 0
    px = PS.substitute(a, alpha, hexv)
    out = a.copy()
    if px is not None:
        out[..., :3][alpha] = px
    out[..., 3] = np.where(alpha, 255, 0)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def run():
    own = sorted(m for m, v in PAL.items()
                 if v.get("transition_surface") == "own")
    index = {m: [] for m in own}
    seen = {m: set() for m in own}
    for pair_dir in sorted(os.listdir(TRANS)):
        p = f"{TRANS}/{pair_dir}"
        if "__to__" not in pair_dir or not os.path.isdir(p):
            continue
        first, second = pair_dir.split("__to__")
        for set_dir in sorted(os.listdir(p)):
            meta_p = f"{p}/{set_dir}/meta.json"
            if not os.path.exists(meta_p):
                continue
            # index 0 holds the material named SECOND in the description, 15 the first
            for mat, tile in ((second, "tile_00.webp"), (first, "tile_15.webp")):
                if mat not in index:
                    continue
                src = f"{p}/{set_dir}/{tile}"
                if not os.path.exists(src):
                    continue
                im = correct(Image.open(src), PAL[mat]["top"])
                buf = io.BytesIO()
                im.save(buf, "WEBP", lossless=True, exact=True)
                digest = hashlib.md5(buf.getvalue()).hexdigest()[:10]
                if digest in seen[mat]:
                    continue
                seen[mat].add(digest)
                cid = f"{pair_dir}__{set_dir}"
                d = f"{OUT}/{mat}"
                os.makedirs(d, exist_ok=True)
                open(f"{d}/{cid}.webp", "wb").write(buf.getvalue())
                index[mat].append({
                    "id": cid, "file": f"tiles/base_candidates/{mat}/{cid}.webp",
                    "source_set": f"tiles/transitions/{pair_dir}/{set_dir}",
                })
    for m in own:
        json.dump({"ground": m, "candidates": index[m]},
                  open(f"{OUT}/{m}/index.json", "w"), indent=1)
        print(f"{m:14} {len(index[m])} distinct candidates")


if __name__ == "__main__":
    run()
