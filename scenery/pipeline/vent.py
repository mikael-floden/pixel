#!/usr/bin/env python3
"""WHERE THE EFFECT COMES OUT — the flue mouth of every chimney state.

Maintainer 2026-09-13: "If the ambient-agent should have a way to create maybe
smoke he will need to know where the chimney center hole is."

A consumer cannot derive this and must never guess it. The hole is not the
middle of the sprite (a chimney with a pot puts it a third of the way up the
pot, a corbelled stack puts it inside the cap), not the top of the bbox (a
twisted pot's rim leans), and not a constant per group — every VARIANT STATE
draws its own cap, so the unit is the state, exactly like `light_frames`.

WHAT IS PUBLISHED, beside `light` in the manifest and in viewer_data.json:

    "vent": {"dx": -1, "dy": -28, "conf": "measured"}

`dx`/`dy` are FRAME PIXELS FROM THE CANVAS CENTRE — the same convention
`light_frames` uses for its emissive centroid, so a consumer that already
converts one converts this (the packed layer's `ox`/`oy` shift it like any
other measured point; games2 measures on the raw canvas and converts).
Per state under `states.<STATE>.vent`, and the anchor state's copy at the piece
root as the default.

HOW IT IS MEASURED, and why this shape. The mouth is the DARK OPENING at the
top of the stack: a chimney is lit from above in this view, so its one genuinely
dark region is the hole. So: take the opaque pixels, look at the top half, keep
the darkest fifth, flood-fill them into blobs, and score each blob by size and
by how high and how central it sits. The winner's centroid is the vent. A piece
with no dark opening at all (a solid cap, a pot drawn in silhouette) falls back
to the middle of the top rows of its own silhouette and says so in `conf`, so a
consumer can tell a measurement from a guess.

MEASUREMENT IS NOT TASTE: run `--sheet` and LOOK at it. It writes a zoomed
contact sheet with a cross on every vent, which is the domain's own QA duty
(README, "Pixel-perfect QA is the agent's own duty") and the only thing that
catches a blob that is a doorway, a window or a shadow rather than a hole.

    python3 pipeline/vent.py --group chimneys            # measure + write
    python3 pipeline/vent.py --group chimneys --sheet out.png
    python3 pipeline/vent.py --check                     # gate: every wanted state has one
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory  # noqa: E402
import viewer_build  # noqa: E402

TOP_SHARE = 0.55    # the mouth is in the top half of the piece, never the foot
DARK_OF_MEDIAN = 0.62  # a mouth is this much darker than the piece's median
MIN_ROWS = 3        # rows — deeper than a mortar course, which is 1-2
MIN_BLOB = 3        # px — smaller than this is a dither speck, not an opening
ALPHA_MIN = 16


def _luma(px):
    return 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2]


def measure(img: Image.Image) -> dict | None:
    """{dx, dy, conf} for one sprite, or None when it has no opaque pixels.

    THREE RULES, each of which a first cut got wrong on this art:

      DARK, RELATIVE TO THE PIECE. A hole is far darker than the material
      around it (measured on chimney_009: median luma 89, the opening under 53),
      so the cut is a fraction of the piece's OWN median rather than a
      percentile of the pixels — a percentile always finds a "darkest fifth"
      even on a piece with no hole at all.

      INTERIOR, NEVER TOUCHING THE BACKGROUND. The sprite's own outline is dark
      and connected all the way round; it swamps every other blob. A mouth is
      enclosed by material, so a blob with any pixel against a transparent one
      is the outline and is dropped.

      TALLER THAN A MORTAR LINE. A course of mortar is dark, interior and WIDE,
      and it beat the real opening on every brick stack in the first pass: the
      openings run 3-5 rows deep, the mortar 1-2. So a blob must span at least
      MIN_ROWS rows, and size is scored against how high and how central it is.
    """
    im = img.convert("RGBA")
    w, h = im.size
    px = im.load()
    box = im.getbbox()
    if not box:
        return None
    x0, y0, x1, y1 = box
    opaque = {}
    for y in range(y0, y1):
        for x in range(x0, x1):
            c = px[x, y]
            if c[3] >= ALPHA_MIN:
                opaque[(x, y)] = _luma(c)
    if not opaque:
        return None
    cx_frame, cy_frame = w / 2.0, h / 2.0
    lums = sorted(opaque.values())
    median = lums[len(lums) // 2]
    cut = median * DARK_OF_MEDIAN
    top_cut = y0 + (y1 - y0) * TOP_SHARE
    dark = {p for p, l in opaque.items() if l <= cut and p[1] < top_cut}

    def open_air(p):
        x, y = p
        return any((x + dx, y + dy) not in opaque
                   for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))

    seen: set[tuple[int, int]] = set()
    best_blob = None
    best_score = 0.0
    span_x = max(1.0, (x1 - x0) / 2.0)
    span_y = max(1.0, y1 - y0)
    for seed in dark:
        if seed in seen:
            continue
        stack = [seed]
        seen.add(seed)
        blob = []
        outline = False
        while stack:
            cx, cy = stack.pop()
            blob.append((cx, cy))
            if open_air((cx, cy)):
                outline = True
            for nb in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                if nb in dark and nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        if outline or len(blob) < MIN_BLOB:
            continue
        rows = len({p[1] for p in blob})
        if rows < MIN_ROWS:
            continue                      # a mortar course, not a mouth
        bx = sum(p[0] for p in blob) / len(blob)
        by = sum(p[1] for p in blob) / len(blob)
        score = (len(blob)
                 * (1.0 - min(1.0, (by - y0) / span_y))
                 * (1.0 - 0.7 * min(1.0, abs(bx - (x0 + x1) / 2.0) / span_x)))
        if score > best_score:
            best_score, best_blob = score, (bx, by)
    if best_blob:
        return {"dx": round(best_blob[0] - cx_frame, 1),
                "dy": round(best_blob[1] - cy_frame, 1), "conf": "measured"}
    # No opening to find (a solid cap, a pot drawn in silhouette): the middle of
    # the silhouette's top rows, and SAY it is a fallback.
    rows = [p for p in opaque if p[1] < y0 + max(2, (y1 - y0) * 0.12)]
    bx = sum(p[0] for p in rows) / len(rows)
    by = sum(p[1] for p in rows) / len(rows)
    return {"dx": round(bx - cx_frame, 1), "dy": round(by - cy_frame, 1), "conf": "silhouette"}


def wants_vent(man: dict, group_cfg: dict) -> bool:
    """A piece publishes a vent when its group (or it) declares a `fixture`
    that has one. Today that is the chimney; the field is the contract, never
    the group's name."""
    fixture = man.get("fixture") or group_cfg.get("fixture")
    return fixture in ("chimney",)


def states_of(rel: str, man: dict) -> list[tuple[str, str]]:
    """[(state key, domain-relative sprite path)] — the anchor included."""
    out = []
    for key, ent in sorted((man.get("states") or {}).items()):
        sp = (ent or {}).get("sprite")
        if isinstance(sp, str) and sp:
            out.append((key, sp))
    if not out and isinstance(man.get("sprite"), str):
        out.append(("", man["sprite"]))
    return out


def run(group: str | None = None, check: bool = False, force: bool = False,
        sheet: str | None = None, log=print) -> dict:
    cfg = factory.load_config()
    groups = {g["id"]: g for g in cfg.get("groups", [])}
    wrote, missing, shots = 0, [], []
    for rel, man in factory.discover():
        if "/" not in rel:
            continue
        gid = rel.split("/")[0]
        if group and gid != group:
            continue
        if not wants_vent(man, groups.get(gid, {})):
            continue
        changed = False
        for key, sp in states_of(rel, man):
            path = os.path.join(factory.ROOT, sp)
            if not os.path.exists(path):
                continue
            ent = (man.get("states") or {}).get(key) if key else man
            have = (ent or {}).get("vent")
            if have and not force:
                if sheet:
                    shots.append((f"{rel}#{key}", path, have))
                continue
            if check:
                missing.append(f"{rel}#{key}")
                continue
            with Image.open(path) as im:
                v = measure(im)
            if not v:
                missing.append(f"{rel}#{key}")
                continue
            if key:
                man.setdefault("states", {}).setdefault(key, {})["vent"] = v
                # The anchor's vent is the piece default, like `light`.
                if (man["states"][key] or {}).get("sprite") == man.get("sprite"):
                    man["vent"] = dict(v)
            else:
                man["vent"] = v
            changed = True
            wrote += 1
            if sheet:
                shots.append((f"{rel}#{key}", path, v))
        if changed:
            factory.write_manifest(rel, man)
    if check:
        log(f"[vent] {len(missing)} state(s) without a vent" if missing else "[vent] every state has one")
        return {"missing": missing, "wrote": 0}
    log(f"[vent] wrote {wrote} state vent(s)")
    if sheet and shots:
        _sheet(shots, sheet)
        log(f"[vent] {sheet}: {len(shots)} state(s), a cross on every mouth — LOOK AT IT")
    return {"missing": missing, "wrote": wrote, "shots": len(shots)}


def _sheet(shots, out_path, zoom=4, cols=10, pad=6):
    """Zoomed contact sheet with a cross drawn on every measured vent."""
    tiles = []
    for name, path, v in shots:
        with Image.open(path) as im:
            im = im.convert("RGBA")
            w, h = im.size
            big = im.resize((w * zoom, h * zoom), Image.NEAREST)
            px = big.load()
            cx = int((v["dx"] + w / 2.0) * zoom)
            cy = int((v["dy"] + h / 2.0) * zoom)
            col = (255, 60, 60, 255) if v.get("conf") == "measured" else (255, 210, 60, 255)
            for d in range(-3 * zoom, 3 * zoom + 1):
                for x, y in ((cx + d, cy), (cx, cy + d)):
                    if 0 <= x < big.width and 0 <= y < big.height:
                        px[x, y] = col
            tiles.append(big)
    if not tiles:
        return
    tw = max(t.width for t in tiles)
    th = max(t.height for t in tiles)
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * (tw + pad) + pad, rows * (th + pad) + pad), (30, 32, 38, 255))
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet.alpha_composite(t, (pad + c * (tw + pad), pad + r * (th + pad)))
    sheet.save(out_path)


def main():
    ap = argparse.ArgumentParser(description="Measure the flue mouth of every chimney state.")
    ap.add_argument("--group", default=None, help="only this group id")
    ap.add_argument("--check", action="store_true", help="exit 1 if a wanted state has no vent")
    ap.add_argument("--force", action="store_true", help="re-measure states that already have one")
    ap.add_argument("--sheet", default=None, help="write a zoomed contact sheet here and LOOK at it")
    ap.add_argument("--no-publish", action="store_true", help="skip the viewer_data rebuild")
    args = ap.parse_args()
    r = run(group=args.group, check=args.check, force=args.force, sheet=args.sheet)
    if args.check:
        sys.exit(1 if r["missing"] else 0)
    if r["wrote"] and not args.no_publish:
        viewer_build.build()


if __name__ == "__main__":
    main()
