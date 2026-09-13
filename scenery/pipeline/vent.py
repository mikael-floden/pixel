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
dark region is the hole. So: take the opaque pixels; search the pot or pipe if
the piece has one and the top half if it does not; cut at a fraction of the
piece's OWN median luma, going darker rung by rung until something separates
from the cap around it; flood-fill the cut into blobs and drop the ones that are
a mortar course, a dither speck or the outline; take the highest, then the
biggest at that height; grow it over a relaxed cut to the whole hole unless the
grow walks out of it; and the MIDDLE OF WHAT IS LEFT, snapped onto a pixel that
is really in the hole, is the vent. A piece with no dark opening at all (a pot
drawn light rather than as a hole) falls back to the top of its flue, or to the
top of its silhouette, and says which in `conf` — so a consumer can tell a
measurement from a guess.

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
# ...AND DARKER STILL WHERE THE CAP ITSELF IS DARK. A wooden crown or an iron
# cowl is as dark as its own opening at 0.62, so the two fuse into one blob that
# touches the outline and is thrown away — the piece then fell back to the top of
# its silhouette, which put the smoke on the cap's rim (maintainer's fourth mark,
# 2026-09-13, on chimney_024's crown). Walk the cut down until the cavity
# separates from the cap around it; the FIRST rung that finds any opening wins,
# so a piece that already worked at 0.62 is measured exactly as before.
CUT_LADDER = (1.0, 0.80, 0.64, 0.52, 0.42)   # x DARK_OF_MEDIAN
RELAXED_OF_CUT = 1.37  # the whole hole is this much lighter than its darkest core
MIN_ROWS = 2        # rows — a pot's mouth is a 2-row ellipse in a 3/4 view
FLUE_MIN_ROWS_BLOB = 1  # ...but INSIDE a pot one row of deep shadow IS the mouth
MAX_WIDTH_SHARE = 0.85  # a mouth is narrower than the silhouette; a course is not
TOP_TOL = 4         # px — blobs starting this close to the highest are all 'at the top'
FLUE_TOP_TOL = 1    # ...but INSIDE a pot the highest dark thing IS the mouth
CAND_TOP_SHARE = 0.35  # ...and a mouth begins within this share of the piece's height
FLUE_WIDTH_SHARE = 0.55  # a pot/pipe is this much narrower than the stack under it
FLUE_MIN_ROWS = 4   # ...over at least this many rows, or the piece has no flue
PLATEAU_SHARE = 0.3  # ...and holds ONE width over this share of its rows
EDGE_CLEAR = 2      # px of material a mouth's pixels stand back from the silhouette
DEEP_SHARE = 0.55   # ...over this share of the blob
MIN_BLOB = 3        # px — smaller than this is a dither speck, not an opening
ALPHA_MIN = 16
MARK_RGBA = (0, 255, 255, 255)  # the sheet's marker: a colour this art never uses


def _luma(px):
    return 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2]


def _middle(region):
    """The middle of `region`, GUARANTEED TO BE IN IT.

    THE ANCHOR IS A PIXEL OF THE HOLE, never a point near it (maintainer's
    fourth mark, 2026-09-13, three chimneys by hand). It is the middle of the
    hole's BOX, not the mean of its pixels: a mouth is drawn with a ragged dark
    fringe on its shaded side, and the mean rides into that fringe — 5 px off
    his mark on chimney_009, where the box centre landed 1 px from it. And
    because a slot seen in three-quarter view is a bent parallelogram whose box
    centre can fall on the rim between its rows, the point is snapped to the
    nearest pixel that really is in the region: an anchor off the hole is the
    one thing this must never publish."""
    cx = (min(p[0] for p in region) + max(p[0] for p in region)) / 2
    cy = (min(p[1] for p in region) + max(p[1] for p in region)) / 2
    if (int(round(cx)), int(round(cy))) not in region:
        cx, cy = min(region, key=lambda p: (p[0] - cx) ** 2 + (p[1] - cy) ** 2)
    return cx, cy


def _openings(dark, opaque, outside, deep, widths, flue, x0, y0, x1, y1):
    """Every blob of `dark` that could be a mouth, as {top, n, at, px}."""
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
            # ...THE OUTSIDE, not any transparent pixel. A cap raised on legs
            # is drawn with REAL HOLES through it, and the mouth under such a
            # cap touches them — treating every transparent neighbour as the
            # silhouette threw the one true opening away and left the piece on
            # its silhouette fallback, on the rim (maintainer's fourth mark,
            # 2026-09-13, chimney_024's crown seen from the south-west). The
            # background AROUND the piece is what disqualifies a blob; a pocket
            # of sky enclosed by the art is part of the art's own geometry.
            if any((cx + dx, cy + dy) in outside
                   for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                outline = True
            for nb in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                if nb in dark and nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        if outline or len(blob) < MIN_BLOB:
            continue
        rows = len({p[1] for p in blob})
        # INSIDE A POT, ONE ROW IS ENOUGH. The 2-row floor is there to throw out
        # mortar lines on a big masonry cap; a pot has no mortar, and its mouth
        # in this projection is often a single row of deep shadow under the far
        # rim with the rest of the bowl merely shaded. Holding the floor at 2
        # there left the piece on its flue_top fallback, which anchors on the
        # rim's top edge — 5 px above the mouth, and he marked every facing of
        # that pot (maintainer 2026-09-13, fifth round).
        if rows < (FLUE_MIN_ROWS_BLOB if len(flue) >= FLUE_MIN_ROWS else MIN_ROWS):
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
    return cands


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
    # A FLUE HOLDS ITS WIDTH; A CORNER NEVER DOES. In a three-quarter view
    # every box begins at its far CORNER, so the top of a plain cap is narrow
    # too and was read as a flue — the search band then covered only the cap's
    # top sliver and the anchor sat on the rim of the hole instead of in it
    # (maintainer's third mark, 2026-09-13). What separates them is a PLATEAU:
    # a pot or a pipe widens from its rim and then holds one width down its
    # body (7, 11, 13, 15, 17, 17, 17, 17, ...), while a corner gains a couple
    # of pixels every row all the way to full width and repeats nothing. Two
    # rules that looked simpler each failed on real art and are not coming
    # back: a ratio bound (a pot TAPERS 2.6x from rim to foot, so the bound
    # that stopped corners threw pots away), and a step-out under the run (in
    # three-quarter the cap under the pot starts at ITS corner too, so there is
    # no step to find).
    if flue:
        run = [widths[y] for y in flue]
        mode = max(set(run), key=run.count)
        if run.count(mode) < max(3, int(PLATEAU_SHARE * len(run))):
            flue = []
    if len(flue) >= FLUE_MIN_ROWS:
        search_lo, search_hi = flue[0], flue[-1] + 1
    else:
        search_lo, search_hi = y0, y0 + max(3, int((y1 - y0) * TOP_SHARE))

    lums = sorted(opaque.values())
    median = lums[len(lums) // 2]

    deep = {p for p in opaque
            if all((p[0] + dx, p[1] + dy) in opaque
                   for dx in range(-EDGE_CLEAR, EDGE_CLEAR + 1)
                   for dy in range(-EDGE_CLEAR, EDGE_CLEAR + 1))}
    outside = set()
    stack = [(x, y) for x in range(w) for y in (0, h - 1) if (x, y) not in opaque]
    stack += [(x, y) for y in range(h) for x in (0, w - 1) if (x, y) not in opaque]
    outside.update(stack)
    while stack:
        cx, cy = stack.pop()
        for nb in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
            if (0 <= nb[0] < w and 0 <= nb[1] < h
                    and nb not in opaque and nb not in outside):
                outside.add(nb)
                stack.append(nb)

    for rung in CUT_LADDER:
        cut = median * DARK_OF_MEDIAN * rung
        dark = {p for p, l in opaque.items()
                if l <= cut and search_lo <= p[1] < search_hi}
        cands = _openings(dark, opaque, outside, deep, widths, flue, x0, y0, x1, y1)
        if cands:
            break

    if cands:
        # THE BIGGEST OPENING NEAR THE TOP, not simply the highest. Two rules
        # were each wrong on real art: weighing size against height put the
        # smoke 10 px low on a stack with two pots (the dark band under them is
        # bigger than either mouth), and taking the strictly highest blob put it
        # on the cap's far RIM in a three-quarter view, where the rim's shadow
        # sits higher on screen than the opening's own centroid. So: take the
        # highest top row, then the LARGEST blob starting within TOP_TOL of it.
        # ...EXCEPT INSIDE A POT, where the highest dark thing is the mouth and
        # nothing else can be. The slack exists for a CAP, whose far rim throws a
        # shadow that starts higher on screen than the opening it belongs to; a
        # pot has no far rim, and the slack let its own shaded flank — taller
        # than the little ellipse of its mouth, and starting two rows under it —
        # win on size (chimney_030's grey pot, south-east and south-west).
        top = min(c["top"] for c in cands)
        tol = FLUE_TOP_TOL if len(flue) >= FLUE_MIN_ROWS else TOP_TOL
        near = [c for c in cands if c["top"] <= top + tol]
        pick = max(near, key=lambda c: c["n"])
        # THE SMOKE STARTS IN THE MIDDLE OF THE HOLE, not at its top rim
        # (maintainer 2026-09-13, his third mark). Only the DARKEST part of a
        # big opening clears the cut — the deep shadow under the far rim — while
        # the near inner wall catches enough light to sit above it, so the
        # centroid of the cut pixels rides high on the hole. Grow the winner
        # over a relaxed cut, contiguous and inside the same search band: that
        # is the whole hole, middle included.
        grown = set(pick["px"])
        relaxed = {p for p, l in opaque.items()
                   if l <= cut * RELAXED_OF_CUT and search_lo <= p[1] < search_hi}
        stack = list(grown)
        while stack:
            cx, cy = stack.pop()
            for nb in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                if nb in relaxed and nb not in grown:
                    grown.add(nb)
                    stack.append(nb)
        # ...UNLESS THE GROW WALKED OUT OF THE HOLE. (Maintainer's fourth mark,
        # 2026-09-13: "You nailed everyone except the 3 I posted" — on all three
        # the cross sat on the lit course just UNDER the opening.) A cap's rim
        # casts a dark band that runs wall to wall beneath the mouth, and at the
        # relaxed cut it is dark enough to join the mouth through one shadowed
        # mortar joint; the mean of mouth+band then lands on the band, outside
        # the hole. A mouth is never as wide as the stack — the same test that
        # rejects a mortar course as a candidate — so if the grown shape is,
        # the grow is the leak and the darkest core alone is the hole.
        gsil = max((widths.get(y, x1 - x0) for y in {p[1] for p in grown}),
                   default=x1 - x0)
        if max(p[0] for p in grown) - min(p[0] for p in grown) + 1 > MAX_WIDTH_SHARE * gsil:
            grown = set(pick["px"])
        gx, gy = _middle(grown)
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


def off_the_hole(img: Image.Image, v: dict) -> str | None:
    """Why this published anchor is not in a hole, or None if it is.

    THE ONE THING A SHEET CATCHES AND NO COUNT DID (maintainer 2026-09-13,
    marking three chimneys whose cross sat on the lit course just under the
    opening: "You nailed everyone except the 3 I posted"). Every earlier cut
    passed its own checks — they counted how many states had a vent and how
    each was found, never whether the pixel it names is dark. A mouth's own
    pixel is far darker than the piece's median; masonry in daylight is not.
    Cheap enough to run over every state on every `--check`."""
    im = img.convert("RGBA")
    w, h = im.size
    px = im.load()
    box = im.getbbox()
    if not box:
        return None
    lums = sorted(_luma(px[x, y])
                  for y in range(box[1], box[3]) for x in range(box[0], box[2])
                  if px[x, y][3] >= ALPHA_MIN)
    if not lums:
        return None
    median = lums[len(lums) // 2]
    x, y = int(round(v["dx"] + w / 2.0)), int(round(v["dy"] + h / 2.0))
    if not (0 <= x < w and 0 <= y < h) or px[x, y][3] < ALPHA_MIN:
        return f"anchor ({x},{y}) is off the art"
    l = _luma(px[x, y])
    if v.get("conf") == "opening" and l > median * RELAXED_OF_CUT * DARK_OF_MEDIAN:
        return f"anchor ({x},{y}) is on lit material (luma {l:.0f} of median {median:.0f})"
    return None


def run(group: str | None = None, check: bool = False, force: bool = False,
        sheet: str | None = None, log=print) -> dict:
    cfg = factory.load_config()
    groups = {g["id"]: g for g in cfg.get("groups", [])}
    wrote, missing, shots, off = 0, [], [], []
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
                if check:
                    for dirn, hv in [("south", have)] + sorted(
                            (d, r) for d, r in (have.get("rotations") or {}).items()):
                        hp = path if dirn == "south" else os.path.join(
                            factory.ROOT, rots.get(dirn, ""))
                        if not os.path.exists(hp):
                            continue
                        with Image.open(hp) as him:
                            why = off_the_hole(him, hv)
                        if why:
                            off.append(f"{rel}#{key}#{dirn}: {why}")
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
        for o in off:
            log(f"[vent] OFF THE HOLE {o}")
        if not off:
            log("[vent] every anchor is on a dark pixel of its own art")
        return {"missing": missing, "off": off, "wrote": 0}
    log(f"[vent] wrote {wrote} state vent(s)")
    if sheet and shots:
        _sheet(shots, sheet)
        log(f"[vent] {sheet}: {len(shots)} state(s), a cross on every mouth — LOOK AT IT")
    return {"missing": missing, "wrote": wrote, "shots": len(shots)}


def _sheet(shots, out_path, zoom=4, cols=10, pad=6):
    """Zoomed contact sheet with a crosshair on every vent, and a NUMBER per tile.

    IT HAS TO SURVIVE THE PHONE. The maintainer reviews these on a phone, where a
    3516 px sheet is drawn at ~1000 px: a one-pixel cross becomes a third of a
    screen pixel and vanishes into the art, and he twice circled a light MORTAR
    JUNCTION as "yours" because it was the only cross-shaped thing he could see
    (2026-09-13, his fifth round). So the marker is drawn at the TILE's scale —
    thick arms with a black halo, a ring, and a hole in the middle so the anchor
    pixel itself stays visible — in a colour this art never uses. The number in
    the corner is the other half of it: it lets him say WHICH tile, and it lets
    this side map a mark back without guessing from the artwork."""
    from PIL import ImageDraw
    tiles = []
    for name, path, v in shots:
        with Image.open(path) as im:
            im = im.convert("RGBA")
            w, h = im.size
            big = im.resize((w * zoom, h * zoom), Image.NEAREST)
        d = ImageDraw.Draw(big)
        cx = (v["dx"] + w / 2.0 + 0.5) * zoom      # the CENTRE of that pixel
        cy = (v["dy"] + h / 2.0 + 0.5) * zoom
        arm, gap = max(10, 5 * zoom), max(2, zoom)
        th = max(3, zoom)
        for col, width in (((0, 0, 0, 255), th + 2), (MARK_RGBA, th)):
            for a, b in (((cx - arm, cy), (cx - gap, cy)), ((cx + gap, cy), (cx + arm, cy)),
                         ((cx, cy - arm), (cx, cy - gap)), ((cx, cy + gap), (cx, cy + arm))):
                d.line([a, b], fill=col, width=width)
            r = gap + th
            d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col, width=max(1, width - 1))
        tiles.append(big)
    if not tiles:
        return
    tw = max(t.width for t in tiles)
    th_ = max(t.height for t in tiles)
    sheet = Image.new("RGBA", (cols * (tw + pad) + pad,
                               ((len(tiles) + cols - 1) // cols) * (th_ + pad) + pad),
                      (30, 32, 38, 255))
    d = ImageDraw.Draw(sheet)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        ox, oy = pad + c * (tw + pad), pad + r * (th_ + pad)
        sheet.alpha_composite(t, (ox, oy))
        _stamp(d, str(i + 1), ox + 6, oy + 6, scale=max(2, zoom))
    sheet.save(out_path)


_DIGITS = {  # 3x5 blocks, so a tile number is legible at any zoom with no font file
    "0": ("###", "# #", "# #", "# #", "###"), "1": (" # ", "## ", " # ", " # ", "###"),
    "2": ("###", "  #", "###", "#  ", "###"), "3": ("###", "  #", "###", "  #", "###"),
    "4": ("# #", "# #", "###", "  #", "  #"), "5": ("###", "#  ", "###", "  #", "###"),
    "6": ("###", "#  ", "###", "# #", "###"), "7": ("###", "  #", "  #", "  #", "  #"),
    "8": ("###", "# #", "###", "# #", "###"), "9": ("###", "# #", "###", "  #", "###"),
}


def _stamp(draw, text, x, y, scale):
    """Draw `text` as 3x5 blocks at `scale`, on its own dark plate."""
    w = (len(text) * 4 - 1) * scale
    draw.rectangle([x - scale, y - scale, x + w + scale, y + 6 * scale],
                   fill=(18, 19, 22, 255))
    for i, ch in enumerate(text):
        for ry, row in enumerate(_DIGITS.get(ch, ())):
            for rx, on in enumerate(row):
                if on == "#":
                    px, py = x + (i * 4 + rx) * scale, y + ry * scale
                    draw.rectangle([px, py, px + scale - 1, py + scale - 1], fill=MARK_RGBA)


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
        sys.exit(1 if (r["missing"] or r.get("off")) else 0)
    if r["wrote"] and not args.no_publish:
        viewer_build.build()


if __name__ == "__main__":
    main()
