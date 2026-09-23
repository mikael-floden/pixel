"""A ROOF NEVER WEARS THE GROUND ROUND THE HOUSE.

Maintainer 2026-09-23, beside the highland house at 258,147 on the snowfield:
*"I know I have told you to not use the same ground type so the player can't
see a slope. I feel this house roof is snow and it's snow behind it as well
so the player can't see where the house roof ends. Did this rule not include
house roofs?"*

IT REACHED THE CELLS AND NOT THE DECK. `terrace_grounds` treats the house's
wall ring (a terrace six levels up) like any terrace and repainted its tops
grey stone against the snow - but a house's roof is DRAWN FROM ITS DECK
(`decks[].ground`, kind "roof"), which that pass never touches, so the game
drew snow over grey-stone cells. The town's timber house at 298,225 has the
second form of it: `yards` paves the apron in the wall's own material, brown
paving, and the timber roof IS brown paving, so the roof's north and west
edges lie invisibly over the apron behind them.

THE RULE: a roof's ground is one ground for the deck and the ring cells that
carry it, and it differs from the ground the player SEES beyond the roof's
north and west edges - the face-less edges, where a same-ground step is
invisible. Seen ON SCREEN: a roof six storeys up hides the five cells behind
it, so the ground past its edge is the one whose top clears the roof's top
vertex (`behind`), never the cell next to the footprint (the first cut read
the paving apron hidden at the foot of the town's timber house as "behind
it" and re-rolled a stone roof that stood against grass - maintainer
2026-09-23: "Why did you change the roof type on this house? The ground
behind is grass and the roof was stone"). `EDGE_MIN` or more edge cells
seeing one ground bans it. A roof that matches takes a new one
from `ROOF_POOL`, a weighted pool of everything a roof may be (the
maintainer's own examples: paving, timber, light soil over parquet, snow on
the mountain, grass on a house - "open up for the unlikely"), less the
grounds round the house and the wall's own material, seeded by the house's
anchor so a rebuild reproduces. Where the ring already contrasts (the slope
rule's own repaint) the deck simply adopts it. Nothing else moves: the walls,
the floor, the chimney on the roof.

    python3 maps2/pipeline/roofs.py --check maps2/worlds3/the_game
    python3 maps2/pipeline/roofs.py --apply maps2/worlds3/the_game

The build runs `apply()` after `yards` (the apron is what the roof must
differ from), before the ambient sidecar.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

ROOF_POOL = (("brown_paving_stone", 3), ("grey_paving_stone", 3), ("light_soil", 3), ("parquet_floor", 2),
             ("grey_stone", 2), ("snow", 2), ("dark_mud", 1), ("grass", 1), ("ice", 1), ("black_rock", 1))
EDGE_MIN = 4        # this many edge cells seeing one ground beyond the roof bans it for the roof


LP = 15.0           # the game's storey in px
DY = 14.0           # half a cell's screen height


def behind(cells, lvl, x, y, L, N):
    """The cell the player sees just beyond a roof cell's north-west edge on
    screen: up the screen column (x-k, y-k) until a cell's top diamond clears
    the roof's top vertex - a six-storey roof hides the five cells behind it,
    so the apron at its foot is never what shows past the edge (measured: a
    stone roof on grass was re-rolled because the hidden apron matched it)."""
    for k in range(1, 40):
        cx, cy = x - k, y - k
        if not (0 <= cx < N and 0 <= cy < N):
            return None
        if (cx, cy) in cells:
            continue
        if 2 * k * DY > (L - lvl[cy][cx]) * LP + 2 * DY:
            return (cx, cy)
    return None


def survey(doc):
    """[(deck index, roof, ring top, banned grounds, wall)] for every roof deck:
    banned = the grounds seen beyond the roof's north and west edges."""
    G, grd, lvl, N = doc["grounds"], doc["ground"], doc["level"], len(doc["level"])
    out = []
    for i, dk in enumerate(doc["decks"]):
        if dk.get("kind") != "roof":
            continue
        L = int(dk["level"])
        cells = {(c["x"], c["y"]) for c in dk["cells"]}
        ring = [c for c in cells if lvl[c[1]][c[0]] == L]
        top = collections.Counter(G[grd[y][x]] for x, y in ring).most_common(1)[0][0] if ring else dk["ground"]
        seen = collections.Counter()
        for (x, y) in cells:
            if (x, y - 1) in cells and (x - 1, y) in cells:
                continue                              # not on the face-less edge
            b = behind(cells, lvl, x, y, L, N)
            if b:
                seen[G[grd[b[1]][b[0]]]] += 1
        banned = {g for g, n in seen.items() if n >= EDGE_MIN}
        out.append((i, dk["ground"], top, banned, dk.get("side")))
    return out


def problems(doc):
    return [(i, roof, top, banned, wall) for (i, roof, top, banned, wall) in survey(doc)
            if roof in banned or top in banned or top != roof]


def pick(banned, wall, seed):
    import world3grow as W
    r = W._rng32(seed)
    pool = [(g, w) for g, w in ROOF_POOL if g not in banned and g != wall]
    return W.Grow._weighted(pool, r)


def apply(world_dir, write=True, log=print):
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    G, grd, lvl = doc["grounds"], doc["ground"], doc["level"]
    gi = {n: k for k, n in enumerate(G)}
    changed = []
    for (i, roof, top, banned, wall) in problems(doc):
        dk = doc["decks"][i]
        cells = {(c["x"], c["y"]) for c in dk["cells"]}
        ax, ay = min(cells)
        if top not in banned and top != wall:
            new = top                       # the slope rule already chose a contrast: the deck adopts it
        else:
            new = pick(banned, wall, (ax * 2654435761 ^ ay * 40503 ^ 0x200F) & 0xffffffff)
        if new not in gi:
            gi[new] = len(G)
            G.append(new)
        for (x, y) in cells:
            if lvl[y][x] == int(dk["level"]):
                grd[y][x] = gi[new]
        dk["ground"] = new
        changed.append((i, ax, ay, roof, top, new, sorted(banned)))
        log(f"  deck {i} at ({ax}, {ay}): roof {roof} on {top} cells, round it {sorted(banned)} -> {new}")
    log(f"{world_dir}: {len(changed)} roof(s) changed")
    if write and changed:
        assert not problems(doc), "a roof still matches its surroundings"
        json.dump(doc, open(path, "w"), separators=(",", ":"))
        log(f"wrote {path}")
    return changed


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("world_dir")
    gr = ap.add_mutually_exclusive_group(required=True)
    gr.add_argument("--check", action="store_true", help="exit 1 when a roof wears the ground round its house")
    gr.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.check:
        doc = json.load(open(os.path.join(a.world_dir, "world.json")))
        bad = problems(doc)
        for (i, roof, top, banned, wall) in survey(doc):
            flag = "   <-- " if (i, roof, top, banned, wall) in bad else "      "
            print(f"{flag}deck {i:2d} roof {roof:18s} ring {top:18s} round {sorted(banned)}")
        print(f"{a.world_dir}: {len(bad)} roof(s) wear the ground round the house")
        sys.exit(1 if bad else 0)
    apply(a.world_dir, write=not a.dry_run)


if __name__ == "__main__":
    main()
