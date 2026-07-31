#!/usr/bin/env python3
"""Measure the REAL creature inside each sprite frame (ignoring padding).

The animation viewer used to scale by FRAME size, which is mostly transparent
padding and differs per export — so Lava Salamander and Lava Salamander II,
pixel-for-pixel the same 30x35 creature, rendered 1.67x apart, and the 32x23
frog was drawn 2.5x wider than the 77x121 mammoth (maintainer 2026-07-30).

This measures the union of every frame's opaque content per entity, so the
viewer can crop the padding away and draw everyone at ONE shared scale: same
creature -> same size on screen, bigger creature -> bigger on screen.

The union is taken across ALL states and directions, so the crop window never
shifts when you switch clip — verified safe because every entity ships one
frame size for all its clips (asserted below).

Run from the repo root after art changes:

    python3 wiki/tools/art-bounds.py

Output: wiki/art_bounds.json ({entity path: [x0, y0, x1, y1]} in frame px).
build.mjs folds it into site/data.json; a missing file just means the viewer
falls back to whole-frame scaling.
"""
import json, os, sys, datetime
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, "wiki", "site", "data.json")
ALPHA = 8  # a pixel counts as content above this alpha


# Art the tool was TOLD about but could not read. Never silent: a clip that
# measures nothing drops out of art_bounds.json, and the viewer then falls back
# to scaling by frame size — which is scaling by transparent padding, the exact
# bug artScale exists to fix. A format the decoder doesn't know (the fleet's
# PNG → WebP migration, 2026-07-31) would look exactly like "no art here".
unreadable: list[tuple[str, str]] = []


def frames_mask(path: str, fw: int, n: int) -> np.ndarray | None:
    """OR of every frame's opaque mask, in frame-local coords."""
    try:
        a = np.asarray(Image.open(path).convert("RGBA"))
    except FileNotFoundError:
        unreadable.append((os.path.relpath(path, ROOT), "missing"))
        return None
    except Exception as e:
        unreadable.append((os.path.relpath(path, ROOT), f"{type(e).__name__}: {e}"))
        return None
    h, w = a.shape[:2]
    if n <= 0 or fw <= 0 or w < fw:
        return None
    n = min(n, w // fw)
    if n <= 0:
        return None
    op = a[:, : n * fw, 3] > ALPHA
    return op.reshape(h, n, fw).any(axis=1)


def clip_bounds(entity: dict, clip: dict) -> list[int] | None:
    """Union of THIS clip's frames. Per clip, not per entity: a creature is
    drawn at different offsets in each direction, so an entity-wide union
    spans the drift and stops describing the creature. Within one clip the
    window is stable, so the animation still moves inside it."""
    # Character clips carry no per-clip size — they use the entity's frame.
    cw = clip.get("fw") or entity.get("frameW")
    ch = clip.get("fh") or entity.get("frameH")
    if not cw or not ch:
        return None
    m = None
    if clip.get("strip"):
        m = frames_mask(os.path.join(ROOT, clip["strip"]), cw, clip.get("frames") or 1)
    elif clip.get("framesDir"):
        for i in range(clip.get("frames") or 0):
            ext = clip.get("frameExt") or "png"
            name = f"{i:0{clip.get('framePad') or 1}d}.{ext}"
            one = frames_mask(os.path.join(ROOT, clip["framesDir"], name), cw, 1)
            if one is None:
                continue
            m = one if m is None else (m | one if m.shape == one.shape else m)
    if m is None or not m.any():
        return None
    ys, xs = np.where(m)
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


data = json.load(open(DATA))
out: dict[str, list[int]] = {}
report: list[tuple[str, str, int, int]] = []
opens: list[tuple[str, int, int]] = []   # the view a page OPENS on (idle/south)
# One STAGE size per domain: the widest and tallest any pose ever needs
# (shadow included), so paging through monsters never moves the layout.
boxes: dict[str, list[int]] = {}
for dom in ("monsters", "characters", "objects"):
    for e in data["domains"].get(dom) or []:
        base = e.get("path") or f"{dom}/{e['id']}"
        sh = e.get("shadow") or {}
        foot_frac = e.get("artBottom") or 1
        hover = e.get("hoverPx") or 0
        best = None
        for sname, state in (e.get("animations") or {}).items():
            for dname, clip in (state.get("dirs") or {}).items():
                bb = clip_bounds(e, clip)
                if not bb:
                    continue
                out[f"{base}|{sname}|{dname}"] = bb
                w, h = bb[2] - bb[0], bb[3] - bb[1]
                if best is None or w * h > best[0] * best[1]:
                    best = (w, h)
                # What this pose needs on stage, shadow and hover included.
                fh = clip.get("fh") or e.get("frameH") or 64
                need_w = max(w, sh.get("w", 0))
                need_h = max(h, (foot_frac * fh - bb[1]) + hover + sh.get("h", 0) / 2 + 1)
                box = boxes.setdefault(dom, [0, 0])
                box[0] = max(box[0], int(round(need_w)))
                box[1] = max(box[1], int(round(need_h)))
                # The default view every page opens on decides the scale.
                if sname == "idle" and dname == "south" and dom != "objects":
                    opens.append((e["id"], w, h))
        if best:
            report.append((dom, e["id"], best[0], best[1]))

# ONE scale for everyone, chosen so the view a page OPENS on (idle facing
# south) fits the stage. Wide side-on poses of the giants can overflow — the
# stage scrolls — but no page opens needing a scroll.
STAGE = 300
open_max = max((max(w, h) for _, w, h in opens), default=64)
scale = max(1, min(6, STAGE // open_max or 1))

dst = os.path.join(ROOT, "wiki", "art_bounds.json")
with open(dst, "w") as f:
    json.dump({
        "format": "pixel-wiki-art-bounds@2",
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "note": "per-clip union of opaque pixels, '<entity>|<state>|<dir>' -> [x0,y0,x1,y1] in frame px",
        "scale": scale,
        "boxes": boxes,
        "clips": out,
    }, f, separators=(",", ":"))
    f.write("\n")

big = sorted(report, key=lambda r: -max(r[2], r[3]))
print(f"wrote {dst}: {len(out)} clips over {len(report)} entities ({os.path.getsize(dst) // 1024} KB)")
print(f"  shared scale {scale}x (biggest opening view {open_max}px of a {STAGE}px stage)")
print("  widest clip:  " + ", ".join(f"{r[1]} {r[2]}x{r[3]}" for r in big[:3]))
print("  smallest:     " + ", ".join(f"{r[1]} {r[2]}x{r[3]}" for r in big[-3:]))
for dom in ("monsters", "characters", "objects"):
    ds = [r for r in report if r[0] == dom]
    if ds:
        bx = boxes.get(dom, [0, 0])
        print(f"  {dom}: {len(ds)} entities, stage box {bx[0]}x{bx[1]} art px "
              f"({bx[0] * scale}x{bx[1] * scale} at {scale}x)")
sal = [o for o in opens if "salamander" in o[0]]
if sal:
    print("  salamander check (opening view): " + ", ".join(f"{i} {w}x{h} -> {w*scale}x{h*scale}" for i, w, h in sal))

# LOUD, and non-zero: art this tool cannot read measures as "no creature here",
# and the viewer's fallback (scale by frame size) is wrong in a way that looks
# plausible on screen. Better to stop the run than to ship silent bad numbers.
if unreadable:
    kinds = sorted({r for _, r in unreadable})
    print(f"\n{len(unreadable)} declared frames could not be read — art_bounds.json is INCOMPLETE:", file=sys.stderr)
    for path, why in unreadable[:10]:
        print(f"  {path}: {why}", file=sys.stderr)
    if len(unreadable) > 10:
        print(f"  … and {len(unreadable) - 10} more", file=sys.stderr)
    if any("cannot identify" in k or "Error" in k for k in kinds):
        print("  A decode error usually means the art changed format. Pillow reads WebP\n"
              "  when built with libwebp — check `python3 -c \"from PIL import features;"
              " print(features.check('webp'))\"`.", file=sys.stderr)
    sys.exit(1)
