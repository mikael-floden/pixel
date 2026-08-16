"""Generate ONE tile sheet for ONE prompt and score how flat its top surface is.

The harness for prompt bake-offs. Everything except the prompt is pinned — same
size, view, angle, depth, seed and outline_mode — so a difference in the score is
a difference in the PROMPT and nothing else. Prints a JSON result line so a caller
(or a workflow agent) can collect results without parsing prose.

  python tiles/pipeline/probe.py --label bare --prompt "green" --hex 3f8a3a
  python tiles/pipeline/probe.py --label over --prompt "..." --no-score
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import flatness
from pixellab_client import PixelLabClient

OUT_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "probes")

# Pinned house format — identical to what tiles 3.0 will ship, so a probe result
# transfers directly to production instead of being a lab-only number.
FIXED = dict(tile_size=64, tile_view="high top-down", view_angle=28.0,
             depth_ratio=0.5, tile_type="isometric", flat_top_px=2,
             outline_mode="segmentation")


def run(label, prompt, target_hex=None, seed=7, outline_mode=None, side_hex=None):
    out = os.path.join(OUT_ROOT, label)
    os.makedirs(out, exist_ok=True)
    kw = dict(FIXED)
    if outline_mode:
        kw["outline_mode"] = outline_mode
    client = PixelLabClient()
    before = client.credits_usd()
    images, tile_id = client.create_tiles(description=prompt, seed=seed, **kw)
    spent = before - client.credits_usd()
    paths = []
    for i, im in enumerate(images):
        p = os.path.join(out, f"tile_{i:02d}.png")
        im.save(p)
        paths.append(p)
    scored = [(flatness.score(p, target_hex), p) for p in paths]
    scored = [(s, p) for s, p in scored if s]
    scored.sort(key=lambda sp: -sp[0]["share"])
    if side_hex:
        # An "X over Y" tile is a claim about TWO surfaces, so rank by the WORST of
        # them. Scoring the top alone would happily pass a tile with a perfect top
        # over whatever wall the generator felt like producing — which is the default
        # brown soil, and the whole thing we are trying to control.
        pairs = []
        for _, p in scored:
            f = flatness.faces(p)
            if not f or not f["top"]:
                continue
            walls = [f[k] for k in ("left", "right") if f[k]]
            if not walls:
                continue
            wall_share = min(x["share"] for x in walls)
            wall_rgb = walls[0]["median"]
            top_dE = flatness.dE(f["top"]["median"], target_hex) if target_hex else 0.0
            wall_dE = flatness.dE(wall_rgb, side_hex)
            pairs.append({
                "path": p,
                "top_share": round(f["top"]["share"], 4), "top_rgb": f["top"]["median"],
                "top_dE": round(top_dE, 1),
                "wall_share": round(wall_share, 4), "wall_rgb": wall_rgb,
                "wall_dE": round(wall_dE, 1),
                "worst_share": round(min(f["top"]["share"], wall_share), 4),
                "worst_dE": round(max(top_dE, wall_dE), 1),
            })
        pairs.sort(key=lambda d: (-d["worst_share"], d["worst_dE"]))
        return _finish(out, label, prompt, tile_id, paths, spent, kw, scored, pairs)
    return _finish(out, label, prompt, tile_id, paths, spent, kw, scored, None)


def _finish(out, label, prompt, tile_id, paths, spent, kw, scored, pairs):
    res = {
        "label": label, "prompt": prompt, "tile_id": tile_id,
        "n_tiles": len(paths), "usd": round(spent, 4),
        "outline_mode": kw["outline_mode"],
    }
    if scored:
        best = scored[0][0]
        res.update(best_share=round(best["share"], 4), best_uniq=best["uniq"],
                   best_std=round(best["std"], 2), best_rgb=best["median"],
                   best_path=scored[0][1],
                   mean_share=round(sum(s["share"] for s, _ in scored) / len(scored), 4))
        if "dE" in best:
            res["best_dE"] = round(best["dE"], 1)
    if pairs:
        res["best_pair"] = pairs[0]
        res["pairs_ok"] = sum(1 for p in pairs
                              if p["worst_share"] >= 0.98 and p["worst_dE"] < 15)
        res["n_pairs"] = len(pairs)
    with open(os.path.join(out, "result.json"), "w") as f:
        json.dump(res, f, indent=2)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--hex", default=None)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--side-hex", default=None, help="target wall colour for an X-over-Y probe")
    ap.add_argument("--outline-mode", default=None,
                    help="override (default segmentation); use 'outline' to A/B it")
    args = ap.parse_args()
    res = run(args.label, args.prompt, args.hex, args.seed, args.outline_mode, args.side_hex)
    print("RESULT " + json.dumps(res))


if __name__ == "__main__":
    main()
