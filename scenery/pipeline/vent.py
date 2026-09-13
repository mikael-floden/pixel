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
DARK_RELAXED = 0.85   # ...and the whole hole, once one has been found, is this dark
MIN_ROWS = 2        # rows — a pot's mouth is a 2-row ellipse in a 3/4 view
MAX_WIDTH_SHARE = 0.85  # a mouth is narrower than the silhouette; a course is not
TOP_TOL = 4         # px — blobs starting this close to the highest are all 'at the top'
CAND_TOP_SHARE = 0.35  # ...and a mouth begins within this share of the piece's height
FLUE_WIDTH_SHARE = 0.55  # a pot/pipe is this much narrower than the stack under it
FLUE_MIN_ROWS = 4   # ...over at least this many rows, or the piece has no flue
FLUE_RATIO = 2.2    # ...holding roughly one width (a 3/4 corner fans out instead)
FLUE_STEP = 1.5     # ...and the row under it steps out by this much
EDGE_CLEAR = 2      # px of material a mouth's pixels stand back from the silhouette
DEEP_SHARE = 0.55   # ...over this share of the blob
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

    # THE FLUE IS THE NARROW THING AT THE TOP, and the mouth is in IT.
    # (Maintainer 2026-09-13, marking four chimneys by hand: the measurement had
    # put the mouth on the CAP beside the pot, where the socket's shadow is
    # bigger and darker than the pot's own opening; his mark is the top of the
    # pot every time.) So walk down from the topmost row while the silhouette
    # stays narrow against its widest row: that run IS the pot or the flue pipe,
    # and nothing below it can win. A stack with no narrow top — a plain capped
    # brick chimney — has no such run and is searched from its top as before.
    rows_x = {}
    for (x, y) in opaque:
        lo, hi = rows_x.get(y, (x, x))
        rows_x[y] = (min(lo, x), max(hi, x))
    widths = {y: hi - lo + 1 for y, (lo, hi) in rows_x.items()}
    widest = max(widths.values())
    flue = []
    for y in range(y0, y1):
        if widths.get(y, 0) and widths[y] <= FLUE_WIDTH_SHARE * widest:
            flue.append(y)
        elif flue:
            break
    # A FLUE IS NARROW AND STAYS NARROW, THEN STEPS OUT. In a three-quarter
    # view every box begins at its far CORNER, so the top of a plain cap is
    # narrow too and read as a flue — the search band then covered only the
    # cap's top sliver and the anchor sat on the rim of the hole instead of in
    # it (maintainer's third mark, 2026-09-13). A pot holds roughly one width
    # for its whole length and then the cap jumps out under it; a corner grows
    # a few pixels every row. So: near-constant width, and a real step below.
    if flue:
        run = [widths[y] for y in flue]
        below = widths.get(flue[-1] + 1, 0)
        if max(run) > FLUE_RATIO * min(run) or below < FLUE_STEP * max(run):
            flue = []
    if len(flue) >= FLUE_MIN_ROWS:
        search_lo, search_hi = flue[0], flue[-1] + 1
    else:
        search_lo, search_hi = y0, y0 + max(3, int((y1 - y0) * TOP_SHARE))

    lums = sorted(opaque.values())
    median = lums[len(lums) // 2]
    cut = median * DARK_OF_MEDIAN
    dark = {p for p, l in opaque.items() if l <= cut and search_lo <= p[1] < search_hi}

    deep = {p for p in opaque
            if all((p[0] + dx, p[1] + dy) in opaque
                   for dx in range(-EDGE_CLEAR, EDGE_CLEAR + 1)
                   for dy in range(-EDGE_CLEAR, EDGE_CLEAR + 1))}

    seen: set[tuple[int, int]] = set()
    cands = []
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
            if any((cx + dx, cy + dy) not in opaque
                   for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                outline = True
            for nb in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                if nb in dark and nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        if outline or len(blob) < MIN_BLOB:
            continue
        rows = len({p[1] for p in blob})
        if rows < MIN_ROWS:
            continue
        top_row = min(p[1] for p in blob)
        # COMPARE THE OPENING WITH THE SILHOUETTE AT ITS WIDEST ROW, not at its
        # top one. (Maintainer 2026-09-13, second mark: on a capped stack the
        # hole is the middle of the dark opening, and this test was throwing it
        # away — in a three-quarter view the opening's TOP row is the cap's far
        # corner, where the silhouette is at its narrowest, so a 31 px opening
        # measured 31/29 and read as a mortar course.) At its widest row the
        # cap is wide and the opening is plainly narrower; a course, which runs
        # wall to wall, still is not.
        sil = max((widths.get(y, x1 - x0) for y in {p[1] for p in blob}), default=x1 - x0)
        blob_w = max(p[0] for p in blob) - min(p[0] for p in blob) + 1
        if blob_w > MAX_WIDTH_SHARE * sil:
            continue                      # a mortar course, not a mouth
        if len(flue) < FLUE_MIN_ROWS:
            # On a plain cap the rim's own shadow hugs the silhouette; inside a
            # narrow flue there is no room to stand back, so the test is only
            # applied where it means something.
            inside = sum(1 for p in blob if p in deep) / len(blob)
            if inside < DEEP_SHARE:
                continue
        if top_row > y0 + CAND_TOP_SHARE * (y1 - y0):
            # A MOUTH IS NEAR THE TOP OF THE PIECE, full stop. Without this a
            # chimney capped by a dark IRON COWL — where the cap itself is dark
            # and reads as the outline, so no real opening survives — fell
            # through to a shadow under the cap and put the smoke a third of
            # the way down the stack. Better to take the fallback (the top of
            # the piece) and say so than to anchor on something that is not a
            # hole.
            continue
        bx = sum(p[0] for p in blob) / len(blob)
        by = sum(p[1] for p in blob) / len(blob)
        cands.append({"top": top_row, "n": len(blob), "at": (bx, by), "px": blob})

    if cands:
        # THE BIGGEST OPENING NEAR THE TOP, not simply the highest. Two rules
        # were each wrong on real art: weighing size against height put the
        # smoke 10 px low on a stack with two pots (the dark band under them is
        # bigger than either mouth), and taking the strictly highest blob put it
        # on the cap's far RIM in a three-quarter view, where the rim's shadow
        # sits higher on screen than the opening's own centroid. So: take the
        # highest top row, then the LARGEST blob starting within TOP_TOL of it.
        top = min(c["top"] for c in cands)
        near = [c for c in cands if c["top"] <= top + TOP_TOL]
        pick = max(near, key=lambda c: c["n"])
        # THE SMOKE STARTS IN THE MIDDLE OF THE HOLE, not at its top rim
        # (maintainer 2026-09-13, his third mark). Only the DARKEST part of a
        # big opening clears the cut — the deep shadow under the far rim — while
        # the near inner wall catches enough light to sit above it, so the
        # centroid of the cut pixels rides high on the hole. Grow the winner
        # over a relaxed cut, contiguous and inside the same search band, and
        # take THAT centroid: the whole hole, middle included.
        grown = set(pick["px"])
        relaxed = {p for p, l in opaque.items()
                   if l <= median * DARK_RELAXED and search_lo <= p[1] < search_hi}
        stack = list(grown)
        while stack:
            cx, cy = stack.pop()
            for nb in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                if nb in relaxed and nb not in grown:
                    grown.add(nb)
                    stack.append(nb)
        gx = sum(p[0] for p in grown) / len(grown)
        gy = sum(p[1] for p in grown) / len(grown)
        return {"dx": round(gx - cx_frame, 1), "dy": round(gy - cy_frame, 1),
                "conf": "opening"}
    # No opening to find (a solid cap, a pot drawn in silhouette): the middle of
    # the silhouette's top rows, and SAY it is a fallback.
    # NO DARK OPENING. On a pot whose mouth is drawn LIGHT rather than as a
    # hole, the answer is still the top of the pot — which is what the
    # maintainer marked by hand — so fall back to the middle of the flue's top
    # rows and say which fallback it was. `conf` is the consumer's handle:
    # `opening` a real hole was found, `flue_top` the top of the narrow flue,
    # `silhouette` neither (the top of the piece).
    flue_top = [p for p in opaque if search_lo <= p[1] < search_lo + 2]
    rows = flue_top or [p for p in opaque if p[1] < y0 + max(2, (y1 - y0) * 0.12)]
    bx = sum(p[0] for p in rows) / len(rows)
    by = sum(p[1] for p in rows) / len(rows)
    return {"dx": round(bx - cx_frame, 1), "dy": round(by - cy_frame, 1),
            "conf": "flue_top" if (flue_top and len(flue) >= FLUE_MIN_ROWS) else "silhouette"}


def wants_vent(man: dict, group_cfg: dict) -> bool:
    """A piece publishes a vent when its group (or it) declares a `fixture`
    that has one. Today that is the chimney; the field is the contract, never
    the group's name."""
    fixture = man.get("fixture") or group_cfg.get("fixture")
    return fixture in ("chimney",)


def states_of(rel: str, man: dict) -> list[tuple[str, str, dict]]:
    """[(state key, south sprite, {facing: sprite})] — the anchor included.

    THE MOUTH MOVES WITH THE FACING. Scenery never rotates, but a TOWN piece
    ships south-east, south and south-west because a wall (and a roof ridge)
    faces three ways — and those are real three-quarter views, so the hole sits
    at a different pixel in each. A consumer drawing smoke on an SE placement
    needs the SE mouth, so every facing is measured, not just south."""
    out = []
    for key, ent in sorted((man.get("states") or {}).items()):
        sp = (ent or {}).get("sprite")
        if isinstance(sp, str) and sp:
            rots = {d: v for d, v in ((ent or {}).get("rotations") or {}).items()
                    if isinstance(v, str) and v and d != "south"}
            out.append((key, sp, rots))
    if not out and isinstance(man.get("sprite"), str):
        rots = {d: v for d, v in (man.get("rotations") or {}).items()
                if isinstance(v, str) and v and d != "south"}
        out.append(("", man["sprite"], rots))
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
        for key, sp, rots in states_of(rel, man):
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
            # ...and one per FACING, because SE/SW are three-quarter views and
            # the hole is not where the south view puts it.
            per_dir = {}
            for dirn, rsp in sorted(rots.items()):
                rpath = os.path.join(factory.ROOT, rsp)
                if not os.path.exists(rpath):
                    continue
                with Image.open(rpath) as rim:
                    rv = measure(rim)
                if rv:
                    per_dir[dirn] = rv
                    if sheet:
                        shots.append((f"{rel}#{key}#{dirn}", rpath, rv))
            if per_dir:
                v = {**v, "rotations": per_dir}
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
