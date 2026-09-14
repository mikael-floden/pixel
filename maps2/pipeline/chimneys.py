"""A CHIMNEY ON THE ROOF OVER EVERY OPEN FIRE INDOORS.

Maintainer 2026-09-13: *"The scenery agent has created a lot of chimneys. The
idea here is to place them whenever you have an open fire indoors and also be
sure to place them OVER that indoor fire. If you can't place scenery on a roof
yet, add support for it."*

THE FIRE DECIDES, AND THE CHIMNEY STANDS ON ITS OWN CELL. A chimney is placed
for every piece of a fire group (`FIRE_GROUPS`) that stands inside a room under
a **roof** deck, at that fire's own `x`/`y`, with `z = deck level - the cell's
ground level` — so its feet are on the roof's top and it rises directly above
the fire, one column of smoke from hearth to sky. A fire under a CAVE lid gets
nothing: a mountain is not a house.

WHAT MADE IT POSSIBLE (the game side, 2026-09-13). A `z` placement was wall
scenery — a window, a hanging — and the game flags any placement whose CELL is
a roof cell as `roofed`: indoor furniture, drawn only while that roof is cut
away. A chimney would have been invisible from the street and visible from
inside the room. `scenery3.ts` now asks where the piece's FEET are: at or above
the deck's top it is `onDeck`, drawn like any outdoor piece and fading with the
roof's own curve when the cut takes it. `render3.py` reads the same line.

NO HFLIP, DELIBERATELY. The art publishes its flue mouth per facing
(`scenery.json` `vent`), and the ambient domain's chimney smoke leaves from
that exact point; a mirrored placement would mirror the mouth and nothing
downstream is asked to un-mirror it. A chimney is near enough symmetric that
the variation is not worth the trap.

    python3 maps2/pipeline/chimneys.py --apply maps2/worlds3/the_game
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import zlib

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
sys.path.insert(0, _HERE)

GROUP = "chimneys"
# AN OPEN FIRE INDOORS. A hearth is one whether or not the placement is lit —
# the flue belongs to the fireplace, not to tonight's fire.
FIRE_GROUPS = ("hearths", "fireplaces", "stoves", "forges", "ovens",
               "braziers", "flame_niches", "cauldron_camps", "campfires")
# THE FACING, and it is a taste call the maintainer asked for (S, SE or SW).
# SOUTH-EAST: rendered all three on the spawn-side house at 99,174 and looked.
# The south view is the stack seen flat on — one face, its clay pot dead
# centre, and it reads as a sticker on the roof. The two turned views show the
# brick's corner, so the stack has a lit face and a shaded one and stands up
# off the roof plane. Between them SE turns the lit face toward the same side
# the roofs and walls of this world are lit from (the camera's own right),
# which is what makes it look like part of the building rather than an object
# dropped on it; SW turns its shaded face that way instead.
DIR = "south-east"


def _pieces():
    """The chimney pieces on disk, in name order."""
    d = os.path.join(REPO, "scenery", GROUP)
    if not os.path.isdir(d):
        return []
    return sorted(f"{GROUP}/{n}" for n in os.listdir(d)
                  if os.path.isdir(os.path.join(d, n)))


def _meta(piece, cache={}):
    if piece not in cache:
        cache[piece] = json.load(open(os.path.join(
            REPO, "scenery", piece, "scenery.json")))
    return cache[piece]


def _feedback(cache={}):
    """His verdicts on scenery (live/feedback/objects.json): a rejected piece
    or variation is never placed."""
    if not cache:
        try:
            cache["e"] = json.load(open(os.path.join(
                REPO, "live", "feedback", "objects.json"))).get("entries", {})
        except (OSError, ValueError):
            cache["e"] = {}
    return cache["e"]


def _ok(piece, state=None):
    fb = _feedback()
    key = f"scenery/{piece}" + (f"#{state.lower()}" if state else "")
    rec = fb.get(key) or fb.get(f"scenery/{piece}#{state}" if state else "")
    return (rec or {}).get("status") != "rejected"


def _captioned(piece, state, cache={}):
    """Does this variation's art carry a CAPTION baked into the canvas?

    PixelLab sometimes writes a word across the bottom of the sheet it
    generates. Measured over all 160 chimney images 2026-09-13: chimney_022's
    NOT_LIT_2 and NOT_LIT_4 read "NEW" in rows 90-95 of the 96 px canvas, in
    every facing, and nothing else in the group does. Drawn on a house it is a
    black word lying on the roof, so a captioned variation is never placed and
    the finding goes to the scenery agent (it is their art to re-roll).

    The test is the SHAPE of the defect, not the letters: a component of the
    alpha mask that is detached from the piece and sits in the bottom eighth
    of the canvas. A chimney is one solid stack, so it has exactly one."""
    key = (piece, state)
    if key in cache:
        return cache[key]
    import numpy as np
    from PIL import Image
    rec = (_meta(piece).get("states") or {}).get(state) or {}
    rels = [rec.get("sprite")] + list((rec.get("rotations") or {}).values())
    hit = False
    for rel in [r for r in rels if r]:
        f = os.path.join(REPO, "scenery", rel)
        if not os.path.isfile(f):
            continue
        m = np.array(Image.open(f).convert("RGBA"))[..., 3] > 8
        H, W = m.shape
        seen = np.zeros(m.shape, bool)
        best, blobs = 0, []
        for y in range(H):
            for x in range(W):
                if not m[y, x] or seen[y, x]:
                    continue
                st, cells = [(y, x)], []
                seen[y, x] = True
                while st:
                    cy, cx = st.pop()
                    cells.append((cy, cx))
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            ny, nx = cy + dy, cx + dx
                            if 0 <= ny < H and 0 <= nx < W and m[ny, nx] and not seen[ny, nx]:
                                seen[ny, nx] = True
                                st.append((ny, nx))
                blobs.append((len(cells), min(c[0] for c in cells)))
                best = max(best, len(cells))
        for (n, top) in blobs:
            if n != best and n >= 3 and top >= H * 7 // 8:
                hit = True
    cache[key] = hit
    return hit


def _states(piece):
    """The piece's NOT_LIT variations he has not rejected, and whose art
    carries no baked caption. A chimney is never lit: it ships NOT_LIT states
    only, so it spends no light slot."""
    st = sorted(k for k in (_meta(piece).get("states") or {})
                if k.startswith("NOT_LIT"))
    keep = [k for k in st if _ok(piece, k) and not _captioned(piece, k)]
    return keep or [k for k in st if not _captioned(piece, k)] or st


def pick(cell, pieces=None):
    """(piece, state) for a chimney at this cell — deterministic, and spread
    over the pool so two houses rarely wear the same stack. crc32, never
    hash(): a salted seed re-rolls the map on every build."""
    pool = [p for p in (pieces or _pieces()) if _ok(p)] or (pieces or _pieces())
    if not pool:
        return None, None
    r = zlib.crc32(f"chimney|{cell[0]}|{cell[1]}".encode()) & 0xffffffff
    piece = pool[r % len(pool)]
    st = _states(piece)
    return piece, (st[(r >> 8) % len(st)] if st else None)


def roofs(doc):
    """{cell: the roof deck's own top level} — ROOF decks only: a cave lid is
    a mountain, not a house."""
    out = {}
    for dk in doc.get("decks", []):
        if dk.get("kind") != "roof":
            continue
        for c in dk["cells"]:
            k = (c["x"], c["y"])
            out[k] = max(out.get(k, -1), dk["level"])
    return out


def fires(doc):
    """Every open fire indoors: [(placement, cell, roof level)]. Indoors means
    a room's own floor cell (world.json `rooms`) with a roof over it."""
    rooms = {(c["x"], c["y"]) for r in doc.get("rooms", [])
             for c in r.get("cells", [])}
    roof = roofs(doc)
    out = []
    for p in doc.get("scenery", []):
        if p.get("piece", "").split("/")[0] not in FIRE_GROUPS:
            continue
        if p.get("z") is not None:
            continue                      # on a wall: not a fire on the floor
        cell = (int(p["x"]), int(p["y"]))
        if cell not in rooms or cell not in roof:
            continue
        out.append((p, cell, roof[cell]))
    return out


def place(doc, dir=DIR):
    """The chimney placements this world wants, and the fires already served.
    Pure: it returns the list, it does not touch the doc."""
    lvl = doc["level"]
    pieces = _pieces()
    have = {(int(p["x"]), int(p["y"])) for p in doc.get("scenery", [])
            if p.get("piece", "").split("/")[0] == GROUP}
    new, served = [], 0
    for (fire, cell, top) in fires(doc):
        if cell in have:
            served += 1
            continue                      # this fire already has its stack
        piece, state = pick(cell, pieces)
        if not piece:
            continue
        z = top - lvl[cell[1]][cell[0]]
        if z <= 0:
            continue                      # no roof above the fire to stand on
        p = {"piece": piece, "x": round(float(fire["x"]), 4),
             "y": round(float(fire["y"]), 4), "z": z}
        if dir and dir != "south":        # south IS the base sprite
            p["dir"] = dir
        if state:
            p["state"] = state
        new.append(p)
    return new, served


def apply(world_dir, dir=DIR, write=True):
    """Add the chimneys to a world that already ships. ADDITIVE ONLY: nothing
    already placed is moved, restyled or removed."""
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    before = len(doc.get("scenery", []))
    new, served = place(doc, dir)
    for p in new:
        # SOUTH IS THE BASE SPRITE, not a rotation file: the domain ships
        # rotations/south-east.webp and south-west.webp beside sprite.webp,
        # and a placement asking for a facing the piece does not have would
        # silently draw its south still.
        if p.get("dir"):
            rot = os.path.join(REPO, "scenery", p["piece"], "rotations",
                               p["dir"] + ".webp")
            assert os.path.isfile(rot), f"{p['piece']} has no {p['dir']} rotation"
    doc["scenery"] = sorted(doc.get("scenery", []) + new,
                            key=lambda q: q["x"] + q["y"])
    fs = fires(doc)
    print(f"{world_dir}: {len(fs)} open fire(s) indoors, {served} already "
          f"served, {len(new)} chimney(s) added ({dir}); scenery "
          f"{before} -> {len(doc['scenery'])}")
    for p in new:
        print(f"   {p['piece']} {p.get('state')} at {p['x']},{p['y']} "
              f"z={p['z']} ({p.get('dir') or 'south'})")
    # THE LAWS. A chimney takes no ground (z), so the footprint law does not
    # apply to it; what must hold is that it stands over a fire, on a roof.
    roof = roofs(doc)
    for p in doc["scenery"]:
        if p.get("piece", "").split("/")[0] != GROUP:
            continue
        cell = (int(p["x"]), int(p["y"]))
        assert cell in roof, f"a chimney at {cell} stands on no roof"
        assert doc["level"][cell[1]][cell[0]] + p["z"] == roof[cell], \
            f"a chimney at {cell} does not stand on the roof's own top"
        assert any((int(f[0]["x"]), int(f[0]["y"])) == cell for f in fs), \
            f"a chimney at {cell} stands over no fire"
    if write and new:
        json.dump(doc, open(path, "w"), separators=(",", ":"))
    return len(new)


def heal(world_dir, write=True):
    """RE-PICK A STACK WHOSE ART IS GONE, and leave every other one alone.

    His wiki verdicts are standing removal orders and the scenery agent acts
    on them — chimney_002 and four states went in one review (2026-09-14) —
    so a world that shipped the day before names art that is not on disk. A
    dangling piece draws nothing in the game (the manifest 404s and is
    tombstoned) and stops render3 dead. `pick()` reads the pool FROM DISK, so
    re-asking it for the same cell is the repair: the cells whose art still
    exists keep exactly what they wear, because nothing else is touched."""
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    pieces = _pieces()
    fixed, gone = [], []
    for p in doc.get("scenery", []):
        if p.get("piece", "").split("/")[0] != GROUP:
            continue
        d = os.path.join(REPO, "scenery", p["piece"], "scenery.json")
        st = (_meta(p["piece"]).get("states") or {}) if os.path.isfile(d) else {}
        ok = os.path.isfile(d) and (not p.get("state") or p["state"] in st) \
            and _ok(p["piece"], p.get("state")) and not _captioned(p["piece"], p["state"]) \
            if os.path.isfile(d) else False
        if ok:
            continue
        was = (p["piece"], p.get("state"))
        cell = (int(p["x"]), int(p["y"]))
        piece, state = pick(cell, pieces)
        if not piece:
            gone.append(was)
            continue
        p["piece"], p["state"] = piece, state
        if p.get("dir"):
            rot = (_meta(piece).get("states") or {}).get(state, {}).get("rotations") or {}
            if not rot.get(p["dir"]):
                del p["dir"]
        fixed.append((was, (piece, state), cell))
    print(f"{world_dir}: {len(fixed)} chimney(s) re-picked, {len(gone)} with no "
          f"art left at all")
    for (was, now, cell) in fixed:
        print(f"   {was[0]} {was[1]} -> {now[0]} {now[1]} at {cell}")
    if write and fixed:
        json.dump(doc, open(path, "w"), separators=(",", ":"))
    return len(fixed)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--apply", metavar="WORLD_DIR")
    ap.add_argument("--heal", metavar="WORLD_DIR",
                    help="re-pick a stack whose piece or state was deleted")
    ap.add_argument("--dir", default=DIR, choices=("south", "south-east", "south-west"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.heal:
        heal(a.heal, write=not a.dry_run)
        return
    if a.apply:
        apply(a.apply, a.dir, write=not a.dry_run)
        return
    ap.print_help()


if __name__ == "__main__":
    main()
