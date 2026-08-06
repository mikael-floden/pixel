"""NPC PLACEMENT (maintainer 2026-08-05) — `pixel-maps2/npcs@1`.

maps2 owns WHERE people stand, the same way it owns where monsters spawn.
characters2 owns WHO they are — art, display name, role, lore, keyed by the
folder under `characters2/npcs/` — and this file never restates any of that; it
REFERENCES it by id. Every world ships a sidecar `worlds/<name>/npcs.json`:

    {
      "schema": "pixel-maps2/npcs@1",
      "world": "the_island2",
      "npcs": [
        {"id": "town-general", "character": "51be6251", "name": "Nyssa",
         "type": "MERCHANT",          # AMBIENT | MERCHANT (the maintainer's two)
         "x": 199, "y": 121,          # tile cell
         "elev": 0,                   # WHICH SURFACE — base or deck, exactly as
                                      # spawns@1 `elev` disambiguates the cave
                                      # floor from the mountain roof above it
         "facing": "south-east",      # one of characters2' 8 rotations
         "anchor": "house",           # the rule that put them there
         "wares": ["MISC", "CONSUMABLE"]}   # MERCHANT only; items/ TYPE tags
      ]
    }

## The two types

- **AMBIENT** — someone the world is more alive for. No shop. Cast by ROLE
  affinity for the place (an elder greets the newly fallen at the arrival fire;
  mercenaries loiter at the cave mouth; scouts watch the bridges).
- **MERCHANT** — has something to SELL, and must LOOK like it. This is the one
  hand-curated table in the file, because "looks like a merchant" is a judgement
  about ART that no terrain rule can make: MERCHANT_LOOK lists only characters
  whose sprite visibly presents wares — a vendor's tray, a breastplate held out,
  potions in both hands, a quiver of wands. The `trader` ROLE is deliberately
  NOT sufficient: characters2 has traders whose art shows nothing but a
  waterskin, and one of those standing in a shop reads as a lost villager.

## Placement doctrine (rules, never spot edits)

Anchors are DERIVED from world.json — no world knows it is being decorated:

    arrival  the player spawn (lore: you fall, and there is a fire burning)
    house    the `kind:"roof"` deck — a building; its doorway is the focus
    cave     cave-floor cells that touch open ground: the mouth
    bridge   the biggest `kind:"bridge"` deck
    road     junction cells of the dirt-road graph (degree >= 3), spread out
    shore    beach cells that touch water

Every placement is then held to five laws, all asserted before the file is
written, so a terrain change breaks the BUILD rather than stranding somebody:

  1. DRY, STANDABLE GROUND — never water (the water law applies to people too),
     never void, never a prop cell.
  2. REACHABLE ON FOOT from the player spawn, walked with the GAME's own rule
     (4-neighbour, climb <= WALK_CLIMB=1, drops free, and a slab seals the base
     beneath it unless you are already under it — `baseUnderDeckOpen`). A shop
     you cannot walk to is not a shop.
  3. NOT ON THE SPAWN CELL and not crowding it — you arrive into open ground.
  4. NEVER IN A DOORWAY — stand NEXT to an opening, never in front of it. Both
     the grid lane through it AND the iso SCREEN strip it is seen through, the
     latter measured from the OPENING itself (see doorway()).
  5. NO TWO SPRITES OVERLAP on screen — measured in iso screen space, not grid
     distance, because (x+2,y+2) draws directly below (x,y).
  6. REFERENCES RESOLVE — the character exists in characters2, its art is on
     disk, `name` still matches characters2' display_name (so a rename upstream
     fails loudly instead of rotting), and every ware is a real items/ TYPE.

    python maps2/pipeline/npcs.py                  # every world
    python maps2/pipeline/npcs.py the_island2      # only the named ones
    python maps2/pipeline/npcs.py --check          # validate what is on disk
"""

from __future__ import annotations

import json
import math
import os
import sys
from collections import deque

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
WORLDS = os.path.join(MAPS2, "worlds")
C2_NPCS = os.path.join(REPO, "characters2", "npcs")

SCHEMA = "pixel-maps2/npcs@1"

# Feature-test maps exercise ONE rendering feature and monster_demo is the
# monster showcase — people would only get in the way (same doctrine as
# spawns.NO_SPAWN_WORLDS). They ship an explicit empty list, not a missing file.
NO_NPC_WORLDS = {"prop_demo", "trans_demo", "glow_test", "occlusion_test",
                 "monster_demo"}

WALK_CLIMB = 1          # games2/shared/src/index.ts — passive step up
# Personal space, measured on SCREEN rather than on the grid — see apart().
SEP_COL = 3             # cells apart in (x-y): side by side, 96px of screen x —
                        # 2 (64px) still leaves two 112px sprites shoulder-to-shoulder
SEP_ROW = 6             # or in (x+y): one clearly behind the other, 90px of y
SPAWN_CLEAR = 2         # keep this many cells clear around the arrival point
SEARCH_R = 14           # how far from an anchor focus a placement may slide
ELEV_BAND = 4           # ...and how far it may drift in ELEVATION while doing it,
                        # so a "shore" NPC cannot end up on the clifftop 30
                        # levels above the beach that anchored them
FACE_R = 16             # face the approach if it is this close, else the open
ROAD_MAT = "lightdark_dirt"
SAND_MAT = "light_sand"

# -- the merchants (hand-verified ART, see the module docstring) ---------------
# id -> (wares, what the sprite actually shows). Only these may be a MERCHANT.
# Between them they cover all seven items/ TYPE tags.
MERCHANT_LOOK = {
    "51be6251": (["MISC", "CONSUMABLE"], "a vendor's tray of goods on a neck strap"),
    "645f1252": (["ARMOR"], "a gilded breastplate held out for inspection"),
    "646b922c": (["SWORD", "BOW"], "a sword presented flat across both hands"),
    "5049d563": (["WAND"], "a bristling quiver of wands, more at the belt"),
    "d762a9f7": (["CONSUMABLE", "MISC"], "a red and a blue potion held up, one per hand"),
    "c03197a9": (["SOUL", "MISC"], "a glowing stone in one hand, a scroll in the other"),
    "f6606d69": (["CONSUMABLE", "MISC"], "four filled vials displayed at arm's length"),
}

# Which merchant belongs at which anchor, in order. The stone dealer sits on the
# road because the trade in soulstones IS the economy (lore/RED_LINE.md §6); the
# alchemist sits at the cave mouth because that is the last shop before you go
# down; the smiths cluster by the house, which is the only tended, hand-made
# thing in the world and therefore the closest this island has to a town.
MERCHANT_PLAN = (
    ("house", "51be6251"),      # Nyssa — general goods, first shop you meet
    ("house", "645f1252"),      # Thorne — armour
    ("house", "646b922c"),      # Sigrun — weapons
    ("cave", "d762a9f7"),       # Aric — potions, OUTSIDE the hole in the mountain
    ("bridge", "5049d563"),     # Norvel — wands, at a span everyone has to cross
    ("road", "c03197a9"),       # Maddox — soulstones, on the trade road
    ("road", "f6606d69"),       # Joss — a roadside vial-seller
)

# AMBIENT casting: anchor -> roles that belong there, best first. Picked from
# characters2 by role, so new NPC art becomes placeable with no edit here.
AMBIENT_ROLES = {
    "arrival": ("elder_scholar", "elder", "priestess", "priest", "scholar", "scribe"),
    "house": ("commoner", "villager", "artisan", "craftsman", "herbalist"),
    "cave": ("mercenary", "veteran", "warrior", "rogue", "champion", "barbarian"),
    "bridge": ("scout", "ranger", "wanderer", "archer"),
    "road": ("wanderer", "commoner", "villager", "knight", "squire", "noble"),
    "shore": ("commoner", "villager", "scout", "ranger"),
}
# how many AMBIENT NPCs each anchor gets (per anchor INSTANCE, capped by supply)
AMBIENT_COUNT = {"arrival": 2, "house": 2, "cave": 2, "bridge": 1,
                 "road": 1, "shore": 1}
MAX_ROAD_ANCHORS = 3
MAX_SHORE_ANCHORS = 2

DIRS8 = ("east", "south-east", "south", "south-west",
         "west", "north-west", "north", "north-east")


# -- references ---------------------------------------------------------------

def roster():
    """characters2' NPC index — the authority on who exists and what they are."""
    return json.load(open(os.path.join(C2_NPCS, "index.json")))["npcs"]


def item_types():
    """The items domain's TYPE tags — the authority on what can be sold."""
    return set(json.load(open(os.path.join(REPO, "items", "viewer_data.json")))["types"])


def has_art(cid):
    return os.path.isfile(os.path.join(C2_NPCS, cid, "base", "south.webp"))


# -- world ---------------------------------------------------------------------

class W:
    """world.json as the walk rules see it: one base surface per cell, plus the
    deck surfaces that sit above it."""

    def __init__(self, name):
        doc = json.load(open(os.path.join(WORLDS, name, "world.json")))
        self.name = name
        self.w, self.h = int(doc["size"]["w"]), int(doc["size"]["h"])
        mats = doc["materials"]
        self.mat = [[mats[i] for i in row] for row in doc["mat"]]
        self.level = doc["level"]
        self.water = set(doc.get("water", ["clear_water"]))
        self.spawn = (int(doc["spawn"][0]), int(doc["spawn"][1]))
        self.props = {(p["x"], p["y"]) for p in doc.get("props", [])}
        self.deck = {}          # cell -> top deck level
        self.deck_thick = {}    # cell -> that deck's thickness
        self.deck_kind = {}
        self.roofs, self.bridges, self.cave = [], [], set()
        for dk in doc.get("decks", []):
            lvl, th = int(dk["level"]), int(dk.get("thickness", 1))
            cells = [(c["x"], c["y"]) for c in dk["cells"]]
            for c in cells:
                if lvl > self.deck.get(c, -1):
                    self.deck[c], self.deck_thick[c] = lvl, th
                    self.deck_kind[c] = dk.get("kind", "deck")
            if dk.get("kind") == "roof":
                self.roofs.append((lvl, cells))
            elif dk.get("kind") == "bridge":
                self.bridges.append((lvl, cells))
            elif dk.get("kind") == "cave":
                self.cave.update(cells)
        # INDOORS = the ground under a building's roof. Walkable (you can go in)
        # but not somewhere to post a shopkeeper — the cave is explicitly not
        # indoors, it is the dungeon.
        self.indoors = {c for lvl, cells in self.roofs for c in cells}

    def inside(self, x, y):
        return 0 <= x < self.w and 0 <= y < self.h

    def m(self, x, y):
        return self.mat[y][x]

    def base(self, x, y):
        return int(self.level[y][x])

    def base_ok(self, x, y):
        """Standable ground: dry, real, unobstructed — and not sealed under a
        slab (the deckBot rule: you may only be under a deck if the ground is
        strictly below the slab's underside)."""
        if not self.inside(x, y):
            return False
        m = self.m(x, y)
        if m == "" or m in self.water or (x, y) in self.props:
            return False
        d = self.deck.get((x, y))
        if d is not None and d > self.base(x, y):
            if self.base(x, y) >= d - self.deck_thick[(x, y)]:
                return False
        return True

    def surfaces(self, x, y):
        """(level, layer) pairs a person could stand on at this cell."""
        out = []
        if self.base_ok(x, y):
            out.append((self.base(x, y), "base"))
        d = self.deck.get((x, y))
        if d is not None and d > self.base(x, y) and (x, y) not in self.props:
            out.append((d, "deck"))
        return out


def walk_reach(w):
    """Every (cell, layer) a player can WALK to from the spawn.

    The game's rule, not an approximation: 4-neighbour steps, climb at most
    WALK_CLIMB, drops free, decks are their own surface and a slab seals the
    base beneath it unless you are already under there. Used to assert that
    every NPC is somewhere a player can actually reach."""
    start = None
    for lvl, layer in w.surfaces(*w.spawn):
        if layer == "base":
            start = (w.spawn[0], w.spawn[1], lvl, layer)
    if start is None:
        surf = w.surfaces(*w.spawn)
        assert surf, f"{w.name}: the spawn cell is not standable"
        start = (w.spawn[0], w.spawn[1], surf[0][0], surf[0][1])
    seen = {(start[0], start[1], start[3])}
    q = deque([start])
    while q:
        x, y, lvl, layer = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if not w.inside(nx, ny):
                continue
            for nlvl, nlayer in w.surfaces(nx, ny):
                if nlvl > lvl + WALK_CLIMB:
                    continue            # too high to step up (drops are free)
                key = (nx, ny, nlayer)
                if key in seen:
                    continue
                seen.add(key)
                q.append((nx, ny, nlvl, nlayer))
    return seen


def facing(fx, fy, tx, ty):
    """Which of characters2' 8 rotations points from (fx,fy) at (tx,ty).

    Grid -> screen is the project's iso: sx = (col-row), sy = (col+row), and the
    camera looks south, so +sy is 'south' and +sx is 'east' on screen."""
    dcol, drow = tx - fx, ty - fy
    if dcol == 0 and drow == 0:
        return "south"
    sx, sy = (dcol - drow), (dcol + drow)
    ang = math.degrees(math.atan2(sy, sx)) % 360
    return DIRS8[int((ang + 22.5) % 360 // 45)]


# -- anchors -------------------------------------------------------------------

def _d(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


# THE SPAWN CAMPFIRE — an object I cannot see in my own data.
# The game draws one animated campfire at every world's arrival point. It is the
# only objects/ asset it draws and it is canon (lore/RED_LINE.md §2: "there is a
# campfire burning at the place where you arrive"), but it is NOT a prop in
# world.json — nothing in the terrain says it exists. So the first cast stood a
# commoner directly in the flames, which the maintainer spotted in-game with
# "Living on the edge :)".
#
# WorldScene.ts placeCampfire() picks the FIRST standable same-level neighbour
# of the spawn from this fixed offset order. Mirroring somebody else's search is
# fragile, so fire_cells() does NOT trust its own standability test to agree
# with theirs: it keeps every candidate up to AND INCLUDING the first one it
# believes is standable, so a small disagreement still lands on a clear cell.
FIRE_OFFSETS = ((2, 0), (0, 2), (2, 2), (-2, 0), (0, -2), (-2, -2), (1, 1), (0, 0))
FIRE_CLEAR = 1          # ...and nobody within a cell of it, or they touch the flames


def fire_cells(w):
    """Every cell the spawn campfire could occupy, plus a ring of breathing room."""
    sx, sy = w.spawn
    lvl = w.base(sx, sy)
    could = []
    for dc, dr in FIRE_OFFSETS:
        c = (sx + dc, sy + dr)
        could.append(c)
        if w.inside(*c) and w.base_ok(*c) and w.base(*c) == lvl:
            break
    return {(cx + dx, cy + dy) for (cx, cy) in could
            for dx in range(-FIRE_CLEAR, FIRE_CLEAR + 1)
            for dy in range(-FIRE_CLEAR, FIRE_CLEAR + 1)}


def apart(a, b):
    """Do these two read as two separate people ON SCREEN?

    Not the same question as "are they far apart on the grid". The iso
    projection puts (x+2, y+2) directly BELOW (x, y) with only 60px between
    them, so plain grid distance happily stacks two sprites into one blob.
    Screen x is (Δx-Δy)*32 and screen y is (Δx+Δy)*15, so separation means
    either far enough to the side or far enough in depth."""
    dx, dy = a[0] - b[0], a[1] - b[1]
    return abs(dx - dy) >= SEP_COL or abs(dx + dy) >= SEP_ROW


RING8 = ((1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1))


HIDE_R = 3              # how far in front tall ground still covers a sprite
HIDE_DX = 2             # ...and how far sideways on SCREEN it can still overlap
HIDE_LVL = 4            # levels of stuff in front before a 112px sprite is lost


def _occluders():
    """Offsets of the cells that are drawn IN FRONT of the one at (0,0).

    Derived from the project's painter order — `(x+y, y)`, camera to the south —
    rather than guessed: a cell is in front if it sorts later, which includes the
    non-obvious case of EQUAL x+y with greater y (one step round the side of a
    building). Screen x is (dx-dy)*32 and a character is ~112px wide, so
    anything more than HIDE_DX columns off to the side misses them entirely."""
    out = []
    for dx in range(-HIDE_R, HIDE_R + 1):
        for dy in range(-HIDE_R, HIDE_R + 1):
            if (dx, dy) == (0, 0) or abs(dx - dy) > HIDE_DX:
                continue
            if (dx + dy, dy) > (0, 0):          # sorts later == drawn in front
                out.append((dx, dy))
    return tuple(out)


OCCLUDERS = _occluders()


def hidden(w, x, y):
    """Would the camera lose this person behind a wall or a cliff?

    An NPC nobody can SEE is worse than no NPC: the player walks straight past a
    shop that is technically there. The case this exists for is standing round
    the BACK of the house — the roof deck covers the whole footprint, walls
    included, so anyone one step behind it is drawn under six levels of stone."""
    lvl = w.base(x, y)
    for dx, dy in OCCLUDERS:
        c = (x + dx, y + dy)
        if not w.inside(*c):
            continue
        if max(w.base(*c), w.deck.get(c, -1)) >= lvl + HIDE_LVL:
            return True
    return False


# A PORTAL is a door, a cave mouth or a bridge head — somewhere with exactly one
# way through. Standing in the opening is the rudest thing generated placement
# can do, and "in the opening" has two separate meanings that must both be kept
# clear, because keeping only the grid one clear is what put a shopkeeper in the
# maintainer's front door:
DOOR_COLS = 1           # SCREEN: cells within this many (x-y) columns of the
                        # portal are the same 32px-wide strip of screen. A
                        # south-facing door at (201,117) is blocked on screen by
                        # (202,118) — one step TOWARD CAMERA, identical (x-y).
DOOR_DEPTH = 4          # ...for this many (x+y) rows in front of it
DOOR_LANE = 2           # GRID: cells straight out along the passage itself


def doorway(x, y, ports):
    """Is this cell in a portal's opening — either the screen strip you see the
    door through, or the passage you physically walk out of?

    Being NEXT to a door is fine and is what we want; being in it is not."""
    for (px, py), _step, (ax, ay) in ports:
        dcol, drow = (x - y) - (px - py), (x + y) - (px + py)
        if abs(dcol) <= DOOR_COLS and 0 <= drow <= DOOR_DEPTH:
            return True                       # standing in the visible opening
        for k in range(0, DOOR_LANE + 1):
            if (x, y) == (px + ax * k, py + ay * k):
                return True                   # standing in the passage itself
    return False


def chokepoint(w, x, y, reach):
    """Is this cell the only way through — a doorway, a bridge end, a cave mouth?

    Standing in one blocks it, and a shopkeeper wedged in your front door is the
    single most annoying thing generated placement can do. Detected the cheap
    roguelike way: walk the 8 neighbours in a circle and count how many separate
    RUNS of open ground there are. One run means open space (a wall at your
    back, fine). Two or more means the open ground on either side of you only
    connects THROUGH you."""
    open_ring = [w.inside(x + dx, y + dy) and (x + dx, y + dy, "base") in reach
                 for dx, dy in RING8]
    if all(open_ring) or not any(open_ring):
        return False
    runs = sum(1 for i in range(8) if open_ring[i] and not open_ring[i - 1])
    return runs >= 2


def road_graph(w):
    return {(x, y) for y in range(w.h) for x in range(w.w)
            if w.m(x, y) == ROAD_MAT and w.base_ok(x, y)}


def portals(w, reach):
    """Every one-way-through opening in the world, as (outside cell, outward
    axis): house doorsteps, cave mouths, bridge heads.

    Shared by anchors() — which uses them as the place worth standing NEAR —
    and by doorway(), which keeps the opening itself clear. One definition, so
    the two can never disagree about where a door is."""
    def walkable(c):
        return w.inside(*c) and w.base_ok(*c) and (c[0], c[1], "base") in reach

    out = []
    seen = set()

    def add(opening, step):
        """`opening` is the hole itself — the gap in the wall, the cave-floor
        cell at the mouth, the last plank of the span. That is what the player
        SEES through and walks through, so it is what the clearance is measured
        from; measuring from the step outside it is off by one column and lets a
        sprite clip the edge of the doorway. `step` is the ground just outside,
        which is where the anchor puts people."""
        ax = (step[0] - opening[0], step[1] - opening[1])
        if (opening, step) not in seen:
            seen.add((opening, step))
            out.append((opening, step, ax))

    # buildings: the gap in the raised wall ring
    for lvl, cells in w.roofs:
        foot = set(cells)
        for c in sorted(foot):
            if not walkable(c):
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = (c[0] + dx, c[1] + dy)
                if n in foot or not walkable(n):
                    continue
                if abs(w.base(*n) - w.base(*c)) <= WALK_CLIMB:
                    add(c, n)
    # the cave mouth
    for c in sorted(w.cave):
        if not walkable(c):
            continue
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = (c[0] + dx, c[1] + dy)
            if n in w.cave or not walkable(n):
                continue
            if abs(w.base(*n) - w.base(*c)) <= WALK_CLIMB:
                add(c, n)
    # bridge heads — a span is a chokepoint everybody crosses
    for lvl, cells in w.bridges:
        cs = set(cells)
        for c in sorted(cs):
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = (c[0] + dx, c[1] + dy)
                if n in cs or not walkable(n):
                    continue
                if abs(w.base(*n) - lvl) <= WALK_CLIMB:
                    add(c, n)
    return out


def anchors(w, reach):
    """Landmarks worth standing at, derived from the terrain alone.

    Each is (kind, focus): the spot an NPC should stand at or near. A focus is
    always OUTSIDE the thing it names — outside the door, outside the cave
    mouth, at the bridge END — because standing inside somebody's house or in
    the middle of a one-lane span is not what a person does."""
    out = [("arrival", w.spawn)]

    def walkable(c):
        return w.base_ok(*c) and (c[0], c[1], "base") in reach

    # Landmarks worth standing NEAR are the portals — doorstep, cave mouth,
    # bridge head — grouped by which kind of opening they are. The focus is the
    # opening; spot_near() then places BESIDE it, never in it (see doorway()).
    ports = portals(w, reach)
    pset = {step for _op, step, _a in ports}
    for lvl, cells in sorted(w.roofs, key=lambda r: (-len(r[1]), sorted(r[1])[0])):
        foot = set(cells)
        door = [c for c in pset
                if any((c[0] + dx, c[1] + dy) in foot
                       for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))]
        if door:   # the doorstep nearest the arrival point is the front door
            out.append(("house", min(door, key=lambda c: _d(c, w.spawn))))

    mouth = [c for c in pset
             if any((c[0] + dx, c[1] + dy) in w.cave
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))]
    if mouth:
        out.append(("cave", min(mouth, key=lambda c: _d(c, w.spawn))))

    if w.bridges:
        lvl, cells = max(w.bridges, key=lambda b: (len(b[1]), b[0]))
        cs = set(cells)
        ends = [c for c in pset
                if any((c[0] + dx, c[1] + dy) in cs
                       for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))]
        if ends:
            out.append(("bridge", min(ends, key=lambda c: _d(c, w.spawn))))

    # ROAD JUNCTIONS: degree >= 3 in the dirt graph, kept far apart so the
    # roadside NPCs are spread over the network instead of bunched at one fork.
    road = road_graph(w)
    junc = []
    for c in sorted(road):
        deg = sum(1 for d in ((1, 0), (-1, 0), (0, 1), (0, -1))
                  if (c[0] + d[0], c[1] + d[1]) in road)
        if deg >= 3:
            junc.append(c)
    picked = []
    for c in junc:
        if all(abs(c[0] - p[0]) + abs(c[1] - p[1]) > 40 for p in picked):
            picked.append(c)
        if len(picked) >= MAX_ROAD_ANCHORS:
            break
    out += [("road", c) for c in picked]

    # SHORE: beach that touches water, spread apart
    beach = [(x, y) for y in range(w.h) for x in range(w.w)
             if w.m(x, y) == SAND_MAT and w.base_ok(x, y)
             and any(w.inside(x + dx, y + dy) and w.m(x + dx, y + dy) in w.water
                     for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))]
    picked = []
    for c in beach:
        if all(abs(c[0] - p[0]) + abs(c[1] - p[1]) > 60 for p in picked):
            picked.append(c)
        if len(picked) >= MAX_SHORE_ANCHORS:
            break
    out += [("shore", c) for c in picked]
    return out


# -- placement -----------------------------------------------------------------

def spot_near(w, focus, reach, taken, band, approach=(), ports=(), fire=()):
    """First legal standing spot at/around `focus`, ringing outward so the same
    terrain always yields the same placement.

    Legal means: dry standable ground, walk-reachable from the spawn, NOT under
    a building's roof (that is somebody's home, not a market stall), within
    ELEV_BAND of the landmark's own level, clear of the arrival cell and of
    every NPC already placed."""
    fx, fy = focus
    for r in range(0, SEARCH_R + 1):
        ring = ([(fx + dx, fy + dy) for dx in range(-r, r + 1) for dy in (-r, r)] +
                [(fx + dx, fy + dy) for dy in range(-r + 1, r) for dx in (-r, r)]) \
            if r else [(fx, fy)]
        ok = []
        for (x, y) in sorted(set(ring)):
            if not w.inside(x, y) or not w.base_ok(x, y):
                continue
            if (x, y, "base") not in reach:
                continue
            if (x, y) in w.indoors:
                continue
            if abs(w.base(x, y) - band) > ELEV_BAND:
                continue
            if _d((x, y), w.spawn) <= SPAWN_CLEAR:
                continue
            if chokepoint(w, x, y, reach):
                continue
            if doorway(x, y, ports):
                continue
            if (x, y) in fire:
                continue
            if hidden(w, x, y):
                continue
            if any(not apart((x, y), t) for t in taken):
                continue
            ok.append((x, y))
        if ok:
            # Of the equally-near spots, take the one closest to where people
            # actually walk. That is what keeps a shopkeeper on the DOOR side of
            # a house instead of round the back, where the building would occlude
            # them and no player would ever find them.
            if approach:
                return min(ok, key=lambda c: (min(_d(c, a) for a in approach), c))
            return min(ok)
    return None


def face_from(w, x, y, reach, approach):
    """Which way a person standing here would naturally turn.

    Toward the APPROACH — the arrival point or the nearest road, i.e. where
    people come from — when that is close enough to matter. Otherwise toward
    the most open ground, which keeps anyone from being left nose-to-the-wall.
    A shopkeeper with their back to the customer is the tell that placement was
    generated and never looked at."""
    near = min(approach, key=lambda c: _d(c, (x, y))) if approach else None
    if near is not None and _d(near, (x, y)) <= FACE_R and near != (x, y):
        return facing(x, y, *near)
    best, best_open = "south", -1
    for d in DIRS8:
        # walk 3 steps along this screen direction and count open ground
        i = DIRS8.index(d)
        ang = math.radians(i * 45)
        sx, sy = math.cos(ang), math.sin(ang)
        dcol, drow = (sx + sy) / 2, (sy - sx) / 2
        open_n = 0
        for step in (1, 2, 3):
            cx = x + int(round(dcol * step))
            cy = y + int(round(drow * step))
            if w.inside(cx, cy) and (cx, cy, "base") in reach:
                open_n += 1
        if open_n > best_open:
            best, best_open = d, open_n
    return best


def cast_ambient(idx, role_pref, used, nth):
    """Pick an unused characters2 NPC for an anchor. Rotates the role
    preference by `nth` so two people at the same landmark are not both the
    same trade; deterministic, and new art joins the pool automatically."""
    order = list(role_pref[nth % len(role_pref):]) + list(role_pref[:nth % len(role_pref)])
    for role in order:
        for cid in sorted(idx):
            if cid in used or idx[cid].get("role") != role:
                continue
            if not has_art(cid):
                continue
            return cid
    return None


def build(w):
    idx = roster()
    types = item_types()
    reach = walk_reach(w)
    ports = portals(w, reach)
    fire = fire_cells(w)
    anch = anchors(w, reach)
    # where people come FROM: the arrival point and the road network. NPCs turn
    # to face it, so the world greets the player rather than ignoring them.
    approach = [w.spawn] + sorted(road_graph(w))
    taken, out, used = [], [], set()

    def place(kind, focus, cid, ntype, wares=None):
        band = w.deck.get(focus, w.base(*focus)) if w.inside(*focus) else 0
        spot = spot_near(w, focus, reach, taken, band, approach, ports, fire)
        if spot is None:
            return False
        x, y = spot
        nid = f"{kind}-{len([n for n in out if n['anchor'] == kind]) + 1}"
        npc = {"id": nid, "character": cid,
               "name": idx[cid].get("display_name") or cid,
               "type": ntype, "x": x, "y": y, "elev": w.base(x, y),
               "facing": face_from(w, x, y, reach, approach), "anchor": kind}
        if ntype == "MERCHANT":
            npc["wares"] = list(wares)
        out.append(npc)
        taken.append(spot)
        used.add(cid)
        return True

    # MERCHANTS first — they get the best spots at their planned anchors.
    by_kind = {}
    for kind, focus in anch:
        by_kind.setdefault(kind, []).append(focus)
    for kind, cid in MERCHANT_PLAN:
        if cid not in MERCHANT_LOOK or not has_art(cid) or cid not in idx:
            continue
        foci = by_kind.get(kind)
        if not foci:
            continue                     # this world has no such landmark
        wares, _why = MERCHANT_LOOK[cid]
        assert all(t in types for t in wares), f"{cid}: unknown ware type"
        place(kind, foci[len([n for n in out if n["anchor"] == kind]) % len(foci)],
              cid, "MERCHANT", wares)

    # then the AMBIENT cast, per anchor instance
    for kind, focus in anch:
        for i in range(AMBIENT_COUNT.get(kind, 1)):
            cid = cast_ambient(idx, AMBIENT_ROLES.get(kind, ("commoner",)), used, i)
            if cid is None:
                break
            if not place(kind, focus, cid, "AMBIENT"):
                break
    return out


# -- validation ----------------------------------------------------------------

def validate(w, npcs, idx=None, types=None, reach=None):
    idx = idx if idx is not None else roster()
    types = types if types is not None else item_types()
    reach = reach if reach is not None else walk_reach(w)
    ports = portals(w, reach)
    fire = fire_cells(w)
    seen_ids, spots = set(), []
    for n in npcs:
        tag = f"{w.name}/{n['id']}"
        assert n["id"] not in seen_ids, f"{tag}: duplicate id"
        seen_ids.add(n["id"])
        assert n["type"] in ("AMBIENT", "MERCHANT"), \
            f"{tag}: type {n['type']!r} is not AMBIENT or MERCHANT"
        cid = n["character"]
        assert cid in idx, f"{tag}: no such characters2 NPC {cid!r}"
        assert has_art(cid), f"{tag}: {cid} has no base art on disk"
        # characters2 owns the name; a rename upstream must FAIL, not rot
        assert n.get("name") == (idx[cid].get("display_name") or cid), \
            (f"{tag}: name {n.get('name')!r} no longer matches characters2' "
             f"{idx[cid].get('display_name')!r} — re-run npcs.py")
        x, y = n["x"], n["y"]
        assert w.inside(x, y), f"{tag}: ({x},{y}) is off the map"
        # LAW 1 — dry, standable ground (people can't swim either)
        assert w.m(x, y) not in w.water, \
            f"{tag}: standing on WATER at ({x},{y}) — {n['name']} can't swim"
        assert w.base_ok(x, y), \
            f"{tag}: ({x},{y}) is not standable (void, prop, or sealed under a deck)"
        assert (x, y) not in w.indoors, \
            f"{tag}: standing inside a building at ({x},{y}) — that is someone's home"
        assert not chokepoint(w, x, y, reach), \
            (f"{tag}: ({x},{y}) is a chokepoint — {n['name']} is blocking the "
             f"only way through (a doorway, a bridge end, the cave mouth)")
        assert (x, y) not in fire, (
            f"{tag}: ({x},{y}) is in the SPAWN CAMPFIRE — {n['name']} is "
            f"standing in the flames. The fire is drawn by the game at the "
            f"arrival point and is not in world.json; see fire_cells().")
        assert not doorway(x, y, ports), (
            f"{tag}: ({x},{y}) is IN a doorway/cave mouth/bridge head — "
            f"{n['name']} is blocking the way in. Stand NEXT to an opening, "
            f"never in front of it.")
        assert not hidden(w, x, y), \
            (f"{tag}: ({x},{y}) is hidden from the camera — {n['name']} stands "
             f"behind a wall or cliff and the player would never see them")
        assert n["elev"] == w.base(x, y), \
            f"{tag}: elev {n['elev']} but the ground at ({x},{y}) is {w.base(x, y)}"
        # LAW 2 — a player can walk there
        assert (x, y, "base") in reach, \
            (f"{tag}: ({x},{y}) is not walk-reachable from the spawn "
             f"{w.spawn} — nobody could ever talk to {n['name']}")
        # LAW 3 — keep the arrival point clear
        assert abs(x - w.spawn[0]) + abs(y - w.spawn[1]) > SPAWN_CLEAR, \
            f"{tag}: standing on top of the arrival point {w.spawn}"
        # LAW 4 — personal space, measured on screen (see apart())
        for (px, py, pid) in spots:
            assert apart((x, y), (px, py)), \
                (f"{tag}: sprite overlaps {pid} — (x-y) differs by "
                 f"{abs((x-y)-(px-py))}, (x+y) by {abs((x+y)-(px+py))}")
        spots.append((x, y, n["id"]))
        assert n["facing"] in DIRS8, f"{tag}: bad facing {n['facing']!r}"
        # LAW 5 — merchants look like merchants, and sell real things
        if n["type"] == "MERCHANT":
            assert cid in MERCHANT_LOOK, (
                f"{tag}: {n['name']} ({idx[cid].get('role')}) is a MERCHANT but "
                f"is not in MERCHANT_LOOK — only characters whose ART visibly "
                f"presents wares may sell. Look at the sprite before adding it.")
            wares = n.get("wares") or []
            assert wares, f"{tag}: MERCHANT with nothing to sell"
            for t in wares:
                assert t in types, f"{tag}: ware {t!r} is not an items/ TYPE tag"
        else:
            assert "wares" not in n, f"{tag}: AMBIENT must not carry wares"
    return len(npcs)


def refresh(name):
    wpath = os.path.join(WORLDS, name, "world.json")
    if not os.path.isfile(wpath):
        return
    out = os.path.join(WORLDS, name, "npcs.json")
    if name in NO_NPC_WORLDS:
        with open(out, "w") as f:
            json.dump({"schema": SCHEMA, "world": name, "npcs": []}, f,
                      separators=(",", ":"))
        print(f"{name}: 0 NPCs (feature-test map)")
        return
    w = W(name)
    npcs = build(w)
    validate(w, npcs)
    with open(out, "w") as f:
        json.dump({"schema": SCHEMA, "world": name, "npcs": npcs}, f,
                  separators=(",", ":"))
    merch = [n for n in npcs if n["type"] == "MERCHANT"]
    print(f"{name}: {len(npcs)} NPCs ({len(merch)} MERCHANT, "
          f"{len(npcs) - len(merch)} AMBIENT)")


def validate_file(name):
    path = os.path.join(WORLDS, name, "npcs.json")
    doc = json.load(open(path))
    assert doc["schema"] == SCHEMA and doc["world"] == name
    return validate(W(name), doc["npcs"])


def check_all(names):
    bad = tot = merch = 0
    for name in names:
        path = os.path.join(WORLDS, name, "npcs.json")
        if not os.path.isfile(path):
            print(f"  {name}: NO npcs.json")
            bad += 1
            continue
        try:
            n = validate_file(name)
        except AssertionError as e:
            print(f"  {name}: FAIL — {e}")
            bad += 1
            continue
        doc = json.load(open(path))
        m = sum(1 for x in doc["npcs"] if x["type"] == "MERCHANT")
        tot += n
        merch += m
        print(f"  {name}: {n} NPC(s) OK ({m} MERCHANT)")
    print(f"npcs --check: {tot} NPC(s), {merch} merchant(s), "
          f"{'ALL OK' if not bad else f'{bad} WORLD(S) FAILED'}")
    return 1 if bad else 0


def main():
    names = [a for a in sys.argv[1:] if not a.startswith("-")]
    names = names or sorted(x for x in os.listdir(WORLDS)
                            if os.path.isfile(os.path.join(WORLDS, x, "world.json")))
    if "--check" in sys.argv:
        sys.exit(check_all(names))
    for name in names:
        refresh(name)


if __name__ == "__main__":
    main()
