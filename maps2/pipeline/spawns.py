"""Monster SPAWN ZONES (maintainer 2026-07-29) — `pixel-maps2/spawns@1`.

maps2 owns the REAL monster spawn areas (the game's rectangles near the player
spawn are explicitly "fake debug areas for now — later the maps agent owns real
spawn areas", games2/shared/src/monsters.ts). Every world ships a sidecar
`worlds/<name>/spawns.json` next to world.json:

    {
      "schema": "pixel-maps2/spawns@1",
      "world": "the_island2",
      "zones": [
        {"id": "poring-1", "monster": "poring",
         "area": [[x,y], ...],        # SIMPLE polygon: tile-corner vertices,
                                       # implicit close, axis-aligned edges,
                                       # concave welcome, NEVER self-intersecting
         "elev": [0, 1],               # the INTENDED walk surface: a monster may
                                       # stand at a cell on whichever surface
                                       # (base OR deck) has level in this range —
                                       # this is what disambiguates the cave
                                       # floor [0,1] from the mountain roof
                                       # [24,40] over the very same cells, and a
                                       # bridge deck from the water under it
         "num": 4}                     # monsters living in this zone (scaled by
                                       # area so big zones keep the same density)
      ]
    }

A zone's cells are the cells whose CENTER lies inside the polygon. The area is
where the monster MAY be — the game must still validate each actual spawn/roam
point (standable surface in the elev range, no prop), so a polygon is free to
span the odd boulder. The same monster appears in many zones, and zones may
OVERLAP each other freely (different monsters share ground). The ONE thing a
polygon may never span is WATER — see the water law below.

Zones are DERIVED from world.json by habitat rules (the standing doctrine: rules,
never spot edits) — rerunning this script is idempotent and deterministic:

    python maps2/pipeline/spawns.py                  # every world
    python maps2/pipeline/spawns.py the_island2 ...  # only the named ones

The roster (monsters/config/roster.json) is the monster-id authority and GROWS
on its own (the PixelLab MONSTER tag decides membership): every id maps to a
habitat via MONSTER_HABITAT, with NAME_HINTS guessing a home for ids the table
doesn't know yet — extend the table when a guess is wrong. Rerun this script
after the roster changes AND after regenerating any world.

`monster_demo` writes its own explicit pads (monsterdemo.py) and is skipped here.
"""

from __future__ import annotations

import json
import os
import sys
from collections import deque

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
WORLDS = os.path.join(MAPS2, "worlds")

SCHEMA = "pixel-maps2/spawns@1"
BUILDER_OWNS = {"monster_demo"}     # writes its own explicit spawns.json
# THE ONE MAP THE CROWDING LAW DOES NOT BIND. monster_demo is a display case —
# one 5x5 pad per roster monster, two of each, so you can walk the rows and look
# at them (monsterdemo.py). Two monsters on 25 cells is 0.08/cell and that is
# the entire point of the map, not a pile-up. Every other world obeys the law.
CROWDING_EXEMPT = {"monster_demo"}

# Test/feature-demo maps used to exercise ONE rendering feature — they get NO
# monsters (maintainer 2026-07-29: "used for testing different things"): the
# props showcase, the transition auto-tiler demo, the emission/glow showcase,
# and the deck occlusion test. They ship an empty `zones: []` so the intent is
# explicit, not a missing file. (monster_demo is the deliberate exception — it
# IS the monster showcase and owns its own file.)
NO_SPAWN_WORLDS = {"prop_demo", "trans_demo", "glow_test", "occlusion_test",
                   "house_demo"}

# Worlds that MUST always contain EVERY roster monster (maintainer 2026-07-29:
# "The Island 2 should always contain all monsters — this is the map closest to
# the end game"). Generation guarantees a zone for every monster here (falling
# back off the habitat threshold, then to a neighbouring habitat, if need be)
# and the build ASSERTS full coverage — so a future terrain change that erases
# a monster's habitat fails loudly instead of silently dropping the creature.
MUST_HAVE_ALL = {"the_island2"}
# Fallback habitat order when a monster's own habitat has no home on a
# must-have world (land grounds first, then the wetter/edge ones).
FALLBACK_HABS = ("grass", "dirt", "stone", "dark", "snow", "forest",
                 "ice", "sand", "shore", "cave")

# -- THE WATER LAW (maintainer 2026-08-05) ------------------------------------
# "You need to fix so no monster can spawn on water. Monsters can't swim. We're
# gonna soon make water into a SAFE ZONE."
#
# So water is not a habitat, not a spawn cell, and not even something a zone is
# allowed to CONTAIN. The guarantee is made in the GEOMETRY rather than left to
# the game: no zone polygon on any world encloses a single water-surfaced cell.
# That last part is the load-bearing one — the game picks roam/spawn cells from
# the polygon and flips an ENTIRE zone to swimming when swim cells outnumber
# standable ones (`buildZoneRuntimes`, games2/shared/src/index.ts). With zero
# water inside any polygon that branch can never fire again, whatever the game
# does later, and a water safe-zone can never be violated from the map side.
#
# A cell is WATER-SURFACED for a zone of elevation band [lo,hi] when its base
# material is water AND no deck inside that band covers it. So the bridge guard
# stays legal (it stands ON the span, elev [lvl,lvl]) while the water UNDER a
# bridge does not (a ground-level band there would put the monster in the drink
# beneath it). Enforced by dry_mask() at construction and re-asserted for every
# zone of every world — including builder-owned ones — by validate_zone().

# -- habitat doctrine ---------------------------------------------------------
# monsters/config/roster.json is the id authority (the PixelLab MONSTER tag
# decides membership, so the roster GROWS on its own). Every monster maps to
# ONE habitat key; several monsters share a habitat, and each still gets its
# own zone(s) — overlapping areas are the design. Habitat keys:
#   grass   open saturated_grass
#   forest  grass within TREE_R of a tall grove prop (base_x_4/5 grass)
#   dirt    lightdark_dirt (forest floor / the road network)
#   snow    regular_snow slopes
#   ice     crystal_ice (tarns, frozen caps)
#   dark    black_mountain rock
#   stone   stone_mountain benches and walls
#   sand    beaches
#   shore   LAND within WATER_SHORE_R of water — the bank, never the water
#           itself (the water law): where the amphibious-looking monsters live
#   cave    THE CAVE floor (cells under kind:"cave" decks, elev [0,1])
# plus one showcase zone on the biggest BRIDGE deck.
MONSTER_HABITAT = {
    # -- grass ---------------------------------------------------------------
    "plague_hound": "grass",                    # Blightcur L6 — a camp-follower stray that wants to sit near somebody, out on the meadow
    "chestnut_horse": "grass",                  # Sorrel L8 — plain farm horse; lore says open grass and the field side of a gate, and at L8/aggro-0 it sorts ahead of Duskfang for the nearest meadow
    "saber_toothed_tiger": "grass",             # Duskfang L8
    "white_horse": "grass",                     # Snowmane L9 — woke in the meadow grass and leaves you holding tack in an empty field; not one frost pixel on the sprite despite the name
    "armor_tusker": "grass",                    # Ironhide L11 — an armoured grazer; on stone its L11 strands at walk 112, on grass it lands at its 56 floor
    "hellhound": "grass",                       # Cinderhowl L11 — a fire-cracked hound running the open plain; dirt is a ribbon and could not hold six
    "butterfly_dragon": "grass",                # Emberwing L12
    "shadow_panther": "grass",                  # Gloompard L12 — an open-ground night stalker — the smoke it trails needs distance to read
    "undead_charger": "grass",                  # Gravecharger L12 — a charge needs an open field, and the ram's horns are a rumour the witnesses added, not anatomy
    "corrupt_stag": "grass",                    # Thornstag L14 — a thorn-racked browser on the meadow edge; forest could not hold nine
    "blight_elk": "grass",                      # Sporehorn L15 — fungus-steered elk grazing the open grass it sows spores across
    "rune_lion": "grass",                       # Runemane L17 — lore insists 'no wall, no step, only long grass' and paler stone than any local hill; a guardian pacing a floor plan that is gone
    "gray_brute_2": "grass",                    # Tuskmaul L18 — the old bull that 'does not grind its tusks' - the very habit that ties the young to boulders - and 'moves when it wants the sun' (verifier)
    "storm_shellback": "grass",                 # Voltshell L20 — a near-twin of Magmashell already on stone; lore is a valley of alders and a beck, and it is the landmark people measure open distance by (verifier)
    # -- forest --------------------------------------------------------------
    "forest_poring": "forest",                  # Dewling L3
    "forest_poring_2": "forest",                # Sprigling L3
    "hedgehog": "forest",                       # Quillkin L4
    "crystal_lynx": "forest",                   # Prismclaw L9 — art is cold cyan crystal but at L9 (floor 46) no cold ground exists inside walk 121; a woodland cat in a copse at 73 is the only in-gradient home
    "tree_stump": "forest",                     # Stumpling L10
    "root_bear": "forest",                      # Gnarloak L15 — literally made of root, bark and moss and wakes furious at whatever an axe is
    # -- dirt ----------------------------------------------------------------
    "undead_hound": "dirt",                     # Rotjaw L5 — farm dog still waiting on the track its master came home by; L5 lands at walk 26, near-road prey a newcomer can actually reach
    "dark_donkey": "dirt",                      # Nightmule L11
    "black_horse": "dirt",                      # Duskhoof L14 — a draught horse handed on by a dozen owners lives on the roads between them; no elemental cue anywhere on the sprite
    "spectral_horse": "dirt",                   # Nightmare L17 — night-gallop road haunt; sand was quota-filling and at L17 it left the near beach dead anyway (overrules proposer AND verifier)
    # -- sand ----------------------------------------------------------------
    "desert_cat": "sand",                       # Sunscale L10 — its entire defence is sand camouflage and noon glare - any other ground deletes the creature's one idea
    "dune_digger": "sand",                      # Dunedelver L13 — faceless plough-front and spade claws in exactly light_sand's ochre; a sand-swimmer, and sand runs to walk 254 so L13 is safe
    # -- shore ---------------------------------------------------------------
    "mystical_frog": "shore",                   # Mirewart L1
    "water_poring": "shore",                    # Puddling L2
    "swamp_cat": "shore",                       # Bogstalker L8 — pond weed physically hanging off it and splayed wet-ground feet; eyes just above the waterline
    "swamp_cat_2": "shore",                     # Mireglare L10 — algae-green coat with blue water-bristles; the lore's scene is a fen fire
    "swamp_bear": "shore",                      # Mireback L17 — moss and tiered red-caps only take on a thing that stands still in wet; it walks the same bank
    # -- stone ---------------------------------------------------------------
    "gray_brute": "stone",                      # Gnashjaw L7 — grinds its tusks flat on boulders all its life; takes stone's near bench at walk 36 as the massif's low rung
    "crystal_horn": "stone",                    # Amethyrn L13 — slate plating and gem-grazing on the mineral benches; no heat for dark, and cave is at its cap
    "stone_turtle": "stone",                    # Magmashell L13
    "stone_golem": "stone",                     # Mosscairn L18
    "eldritch_maw": "stone",                    # Voidmaw L19 — not one warm pixel so not dark; cave is full at 4 species, and a violet body silhouettes against grey rock (verifier)
    "granite_bear": "stone",                    # Cragback L19 — grey granite with alpine moss and green seams down the legs - the hillside standing up
    # -- snow ----------------------------------------------------------------
    "white_rabbit": "snow",                     # Fluffang L5
    "moon_wolf": "snow",                        # Moonpelt L12 — the trick is leaving no print in new snow, which only reads on a snowfield
    "polar_bear": "snow",                       # Bergclaw L13 — fur first, ice second - the ice came out of the bear; crystal_ice belongs to the crystal-bodied
    "snow_demon": "snow",                       # Frostwraith L17
    "storm_stag": "snow",                       # Stormcrown L19 — its own line is 'the high fells in the worst weather'; snow is the under-used massif and lightning reads on white, not grey-on-grey
    "mammoth": "snow",                          # Diretusk L20
    # -- ice -----------------------------------------------------------------
    "ice_poring": "ice",                        # Frostling L15
    "ice_wolf": "ice",                          # Winterfang L16 — a crown that never melts, the exact hue of crystal_ice; joins the ice-construct cast at L16 between Frostling L15 and Rimeshard L19
    "ice_crystal_golem": "ice",                 # Rimeshard L19
    # -- dark ----------------------------------------------------------------
    "lava_salamander_2": "dark",                # Palemaw L6
    "lava_salamander": "dark",                  # Emberjaw L7
    "lava_poring": "dark",                      # Slagling L9
    "magma_wolf": "dark",                       # Slagfang L11 — black hide with magma standing in the seams and embers lifting off it; the lore sends the pack east into the burnt country
    "malformed_creature": "dark",               # Palehusk L14
    "magma_wolf_2": "dark",                     # Basalthowl L16 — the pack sire at the caldera, identified by the smoke plume standing off its shoulders; must not be split from the pack
    "obsidian_lion": "dark",                    # Magmane L18 — poured from the volcano's throat - obsidian mane, magma cracks - the apex of the burnt country
    # -- cave ----------------------------------------------------------------
    "masked_shadow_creature": "cave",           # Grinmask L8
    "diablo": "cave",                           # Ashfiend L13
    "night_beast": "cave",                      # Glowbone L16
    "diablo_2": "cave",                         # Balefiend L18
}
# a NEW roster id without a table entry still gets a sensible home
# NOTE the water law: a new `*_water` / `*_frog` id lands on the BANK (shore),
# never in the water — there is no habitat that puts a monster on water.
NAME_HINTS = (("lava", "dark"), ("shadow", "cave"), ("diablo", "cave"),
              ("night", "cave"), ("ice", "ice"), ("snow", "snow"),
              ("water", "shore"), ("frog", "shore"), ("fish", "shore"),
              ("sand", "sand"), ("stone", "stone"), ("rock", "stone"),
              ("forest", "forest"), ("tree", "forest"), ("dark", "dark"))
BRIDGE_GUARD = "stone_turtle"       # the troll under^W on the bridge

# -- population doctrine (maintainer 2026-07-29) -------------------------------
# Every monster TYPE gets a near-equal share of the world's population — "not a
# rule that they have to be the same, just similar". Pure per-area density made
# the roster wildly lopsided (24 butterfly dragons on the plains vs 1 hedgehog
# in a copse), so the budget is now allocated per MONSTER, not per zone:
#   1. the world's budget B = land cells / WORLD_CELLS_PER_MONSTER, clamped so
#      every type present gets at least MON_TOTAL_MIN and none more than
#      MON_TOTAL_MAX
#      (the_island2: 22395 land cells -> B = 124);
#   2. B is split EVENLY across the types that live here (largest-remainder —
#      so with 57 types and B=124, ten get 3 and forty-seven get 2); the +1s go
#      to the types with the most habitat, the only nod left to raw area;
#   3. each type's own total is then spread across ITS zones in proportion to
#      zone area (min 1 per zone) — so density still decides WHERE a type is
#      thickest, never HOW MANY of it exist.
# -- THE DIFFICULTY GRADIENT (maintainer 2026-08-06) --------------------------
# "Why do you spawn Duskfang next to newcomers? They are aggressive and will
# kill them immediately. What's wrong with Mirewart? Why not scale up the
# difficulty as you progress? Quillkin should also be closer. You just want
# Newbies to have a hard time. Try to make them enjoy the game instead."
#
# Habitat alone decided placement before this, and habitat knows nothing about
# danger: Duskfang is a sabre-toothed tiger, tigers live on grass, the arrival
# point is grass — so a level-8 hunter with a 96wu aggro radius that kills a
# fresh 40hp player in three hits had a zone touching the spawn, while Mirewart
# (level 1) sat 54 cells away and Quillkin (level 4) was the single most distant
# monster on the map at 152. The correlation between level and distance was nil.
#
# So distance from the arrival point is now a FUNCTION OF DIFFICULTY, measured
# by WALK distance (what the player actually travels) and not by straight line,
# which on a map with a mountain, a gorge and an ocean are very different things.
#
# The ranking is not invented here: `level` and `aggro_radius_wu` come from the
# game's own combat tuning (live/tuning/monsters.json), so a rebalance there
# moves the monsters on the map instead of silently disagreeing with it.
TUNING = os.path.join(REPO, "live", "tuning", "monsters.json")
SAFE_R = 6              # nothing at all inside this walk radius — you land, you
                        # get a moment before anything can reach you
LVL_STEP = 5            # ...then every level of difficulty pushes 5 cells further.
                        # Calibrated against the terrain, not picked: THE CAVE is
                        # a single component 112 walk-cells out and holds all four
                        # cave dwellers, the worst of them Balefiend (L18,
                        # aggressive). 6 + 17*5 + 14 = 105 <= 112, so every
                        # monster on the_island2 can satisfy its own floor and
                        # none has to fall back.
AGGRO_PUSH = 14         # monsters that HUNT (aggro_radius_wu > 0) start further
                        # out again: a passive monster is a thing you choose to
                        # fight, an aggressive one is a thing that chooses you
MAX_LVL = 20

# -- THE CROWDING LAW (maintainer 2026-08-07) ---------------------------------
# "LOL! Why have you placed this many monsters at the same place 😂 Looks funny!"
#
# He was pointing at the copse east of the plains, and he was right: FOUR forest
# species — hedgehog, tree stump and both forest porings — had all picked the
# SAME 46-cell component, six of each, with the two plains zones lying over the
# top. 24 monsters under one tree: 0.53 expected monsters per cell, one every
# two tiles, a mosh pit.
#
# Nothing in the rules was broken. That was the problem. A zone said WHERE a
# monster may live and never HOW MUCH ROOM it needs, and each species picks the
# nearest component it is allowed to live in INDEPENDENTLY of the others — so
# when several share a habitat they all converge on the same patch. Habitat and
# the difficulty gradient both point the same way; nothing pointed apart.
#
# So room is now a first-class quantity. For a cell,
#
#     density(cell) = SUM over zones covering it of num / |zone spawn cells|
#
# is the expected number of monsters standing on it — the game picks roam
# targets uniformly from exactly those cells (pickMonsterTarget, WorldRoom.ts),
# so this is what the player sees, not a proxy for it. It may never exceed
# MAX_DENSITY. Three mechanisms, all in the generator:
#
#   1. ROOM PICKS THE COMPONENT. Each component carries `cells * MAX_DENSITY`
#      monsters. A species prefers one that still has room for its whole
#      population; among those it still takes the NEAREST, so the difficulty
#      gradient is untouched — species spread SIDEWAYS across the habitat, not
#      inwards toward the spawn.
#   2. ROOM CAPS THE POPULATION. balance_population already refused to put more
#      monsters in a zone than it has standable cells; it now also refuses to
#      exceed the zone's room, and the spill goes to that species' other zones.
#   3. enforce_density() SETTLES THE OVERLAP. Zones of different species may
#      still share ground (that has always been the design) — but where the sum
#      goes over the cap, the biggest contributor gives a monster back until it
#      doesn't. Deterministic, monotone, terminates.
#
# assert_density() then fails the BUILD if any cell is still over — including
# for a hand-written spawns.json, which none of the three mechanisms touch.
MAX_DENSITY = 0.05      # expected monsters per cell: one per 20 cells, i.e. at
                        # most ~4 in a 9x9 patch of ground. The forest copse was
                        # at 0.53 when the maintainer laughed at it.
ROOM_MIN = int(round(1 / MAX_DENSITY))   # cells a zone needs to hold ONE monster
                                         # legally — the floor for any component
                                         # worth making a zone out of

# -- ENCLOSED GROUND CARRIES LESS (maintainer 2026-08-08) ---------------------
# "You need to reduce the number of monsters in the cave by 50%."
#
# The crowding law was not what was holding the cave: four species share its one
# 472-cell floor at a combined 0.038/cell, comfortably under the 0.05 cap, so
# the population came straight from the per-type budget — 18 monsters, 17% of
# the whole island's, underground.
#
# The reason a cave needs its own number is not arithmetic, it is that a cell of
# cave is not worth a cell of meadow. A dungeon is corridors and rooms: you meet
# a thing at arm's length, around a corner, with the walls doing its cornering
# for it and nowhere to back off to. Open ground shows you what is coming and
# lets you leave. So the same count that reads as sparse on a meadow reads as a
# swarm underground, and the cap that governs it should say so.
CAVE_DENSITY_F = 0.4    # the cave's share of the open-ground cap -> 0.02/cell,
                        # one monster per 50 cells of floor. On the_island2 that
                        # is 9 in the cave where 18 stood: the maintainer's half.

WORLD_CELLS_PER_MONSTER = 180       # world budget = land cells / this. ONE dial
                                    # for how busy a world feels, applied to every
                                    # map so a change lands proportional to land
                                    # instead of being trimmed off whichever map
                                    # someone was looking at. 137 -> 205 ("reduce
                                    # the total number of monsters by 25%"),
                                    # 205 -> 180 when the roster went 24 -> 57
                                    # ("I can agree on increasing the total amount
                                    # of monsters on the map by 25%"):
                                    # the_island2 99 -> 124.
# THE FLOOR IS "PRESENT AT ALL" (maintainer 2026-08-21: "I can agree on increasing
# the total amount of monsters on the map by 25%... you will probably have to spawn
# less of the monsters already on the map so everyone can be included"). It was 3,
# and `n * 3` is a floor that GROWS with the species count — backwards, because the
# more species share a fixed island the FEWER each can have. The roster going
# 24 -> 57 made that floor demand 171 monsters of a world whose land asks for 124,
# and it would climb again with every creature the monsters agent adds. At 1 the
# floor states the only thing that is always true: a species that lives on a world
# has at least ONE individual there, or it is not on the world at all — which is
# exactly what MUST_HAVE_ALL promises. The LAND is then the only dial on how busy a
# world feels, which is what WORLD_CELLS_PER_MONSTER is for.
MON_TOTAL_MIN = 1                   # ...every species present is really present
MON_TOTAL_MAX = 9                   # per-type ceiling
MIN_ZONE = {"forest": ROOM_MIN}     # smallest component worth a zone (cells)
MIN_ZONE_DEFAULT = 30
TOP_K = 4                           # component cap per habitat (>= its members)
TREE_R = 6                          # the woods a GROVE casts, not the shade of
                                    # one trunk. At 3 every one of the island's
                                    # 8 tall props was its own 7x7 island of
                                    # "forest" and the four forest species had
                                    # nowhere to spread to but each other's
                                    # laps; at 6 the same 8 props make 11
                                    # copses of 100-165 cells, which is a wood
                                    # a species can actually live in.
WATER_SHORE_R = 4                   # how far inland the `shore` band reaches
BRIDGE_MIN_CELLS = 10
DRY_PASSES = 60                     # water-law fixed-point backstop (asserts)
ELEV_PASSES = 8                     # elev/dry-mask fixed-point backstop


def roster_ids():
    j = json.load(open(os.path.join(REPO, "monsters", "config", "roster.json")))
    return [m["id"] for m in j["monsters"]]


_tuning = None


def tuning():
    """The GAME's combat tuning — the authority on how dangerous a monster is.

    Not a ranking invented in maps2: `level`, `damage` and `aggro_radius_wu` are
    what the server fights with (games2/server/src/tuning.ts reads this exact
    file), so rebalancing combat moves the monsters on the map to match instead
    of quietly disagreeing with it."""
    global _tuning
    if _tuning is None:
        try:
            _tuning = json.load(open(TUNING))
        except Exception:
            _tuning = {"defaults": {}, "monsters": {}}
    return _tuning


def threat(mid):
    """(level, aggro_radius) for a monster, defaults applied."""
    t = tuning()
    d = t.get("defaults") or {}
    m = (t.get("monsters") or {}).get(mid) or {}
    lvl = m.get("level", d.get("level", 1))
    ag = m.get("aggro_radius_wu", d.get("aggro_radius_wu", 0))
    return int(lvl), float(ag)


def keep_out(mid):
    """How far from the arrival point this monster must stay, in walk cells."""
    lvl, ag = threat(mid)
    lvl = max(1, min(MAX_LVL, lvl))
    return SAFE_R + (lvl - 1) * LVL_STEP + (AGGRO_PUSH if ag > 0 else 0)


def walk_dist(w):
    """Walk distance in cells from the arrival point to every standable surface.

    The player's own movement rule (games2: 4-neighbour, climb at most 1 level,
    drops free, a deck top is its own surface and a slab seals the base beneath
    it unless you are already under there). Straight-line distance would call
    the far side of the gorge 'near'."""
    def surfaces(x, y):
        out = []
        if (0 <= x < w.w and 0 <= y < w.h and w.m(x, y) != ""
                and w.m(x, y) not in w.water and (x, y) not in w.props):
            d = w.deck.get((x, y))
            th = w.deck_thick.get((x, y), 1)
            if d is None or d <= w.base(x, y) or w.base(x, y) < d - th:
                out.append((w.base(x, y), "base"))
        d = w.deck.get((x, y))
        if d is not None and d > w.base(x, y) and (x, y) not in w.props:
            out.append((d, "deck"))
        return out

    sx, sy = w.spawn
    start = [(sx, sy, lv, la) for lv, la in surfaces(sx, sy)]
    dist, q = {}, deque()
    for (x, y, lv, la) in start:
        dist[(x, y, la)] = 0
        q.append((x, y, lv, la))
    while q:
        x, y, lv, la = q.popleft()
        d0 = dist[(x, y, la)]
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            for nlv, nla in surfaces(nx, ny):
                if nlv > lv + 1:
                    continue
                if (nx, ny, nla) in dist:
                    continue
                dist[(nx, ny, nla)] = d0 + 1
                q.append((nx, ny, nlv, nla))
    flat = {}
    for (x, y, _la), d in dist.items():
        if d < flat.get((x, y), 1 << 30):
            flat[(x, y)] = d
    return flat


def comp_dist(comp, field):
    """How far a player must walk to reach the NEAREST cell of this habitat."""
    ds = [field[c] for c in comp if c in field]
    return min(ds) if ds else None


_near_cache = {}


def near_cells(field, floor):
    """Cells within `floor` walk-cells of the arrival point — forbidden ground."""
    key = (id(field), floor)
    hit = _near_cache.get(key)
    if hit is None:
        hit = frozenset(c for c, d in field.items() if d < floor)
        _near_cache[key] = hit
    return hit


def gradient_trim(comp, field, floor):
    """Cut the part of a habitat that is too close to the arrival point.

    Choosing a far-enough COMPONENT is not enough on its own: a habitat is often
    one connected sprawl covering half the map, so its nearest cell is next to
    the spawn while most of it is nowhere near — on demo_isle the single grass
    component reaches within 1 cell of the arrival point. Trimming by CELL and
    keeping the largest surviving piece gives a zone that genuinely begins at
    the monster's keep-out distance, whatever shape the habitat is."""
    far = {c for c in comp if field.get(c, 1 << 30) >= floor}
    if not far:
        return set()
    parts = comps(far)
    return parts[0] if parts else set()


def habitat_of(mid):
    h = MONSTER_HABITAT.get(mid)
    if h is None:
        for pat, key in NAME_HINTS:
            if pat in mid:
                return key
        return "grass"
    return h


# -- world loading ------------------------------------------------------------

class W:
    def __init__(self, name):
        doc = json.load(open(os.path.join(WORLDS, name, "world.json")))
        self.name = name
        size = doc["size"]
        self.w, self.h = int(size["w"]), int(size["h"])
        mats = doc["materials"]
        self.mat = [[mats[i] for i in row] for row in doc["mat"]]
        self.level = doc["level"]
        self.water = set(doc.get("water", ["clear_water"]))
        self.spawn = (int(doc["spawn"][0]), int(doc["spawn"][1]))
        self.props = {(p["x"], p["y"]) for p in doc.get("props", [])}
        self.paths = doc["paths"]
        self.tall_props = set()
        for p in doc.get("props", []):
            path = self.paths[p["tile"]]
            if "saturated_grass" in path and ("base_x_4" in path or "base_x_5" in path):
                self.tall_props.add((p["x"], p["y"]))
        # walk surface per cell = the deck level where one covers, else base;
        # cave floors keep their own base level as a SECOND surface (deck_kind)
        self.deck = {}
        self.deck_thick = {}
        self.deck_kind = {}
        self.cave_floor = set()
        self.bridges = []
        for dk in doc.get("decks", []):
            cells = [(c["x"], c["y"]) for c in dk["cells"]]
            for c in cells:
                if int(dk["level"]) > self.deck.get(c, -1):
                    self.deck[c] = int(dk["level"])
                    self.deck_thick[c] = int(dk.get("thickness", 1))
                    self.deck_kind[c] = dk.get("kind", "deck")
            if dk.get("kind") == "cave":
                self.cave_floor.update(cells)
            if dk.get("kind") == "bridge":
                self.bridges.append((int(dk["level"]), sorted(cells)))

    def m(self, x, y):
        return self.mat[y][x]

    def base(self, x, y):
        return int(self.level[y][x])

    def surf(self, x, y):
        d = self.deck.get((x, y), -1)
        return d if d > self.base(x, y) else self.base(x, y)

    def hab_level(self, x, y):
        """The level a MAT-based habitat means at this cell: cave roofs CARRY the
        old surface (the kept mat belongs to the roof), while a bridge floats
        OVER its ground (the mat belongs to the base beneath)."""
        if self.deck_kind.get((x, y)) == "cave":
            return self.surf(x, y)
        return self.base(x, y)


# -- mask -> simple polygon ---------------------------------------------------

def comps(cells):
    """4-connected components, biggest first (deterministic)."""
    left = set(cells)
    out = []
    while left:
        seed = min(left)
        q, comp = deque([seed]), {seed}
        left.discard(seed)
        while q:
            x, y = q.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                c = (x + dx, y + dy)
                if c in left:
                    left.discard(c)
                    comp.add(c)
                    q.append(c)
        out.append(comp)
    out.sort(key=lambda c: (-len(c), min(c)))
    return out


def fix_diagonals(cells, blocked=None):
    """Add cells until no 2x2 block holds a diagonal-only contact — the outer
    boundary of such a mask is a SIMPLE rectilinear loop (no pinch vertices).
    Added cells may leave the habitat: the area is where a monster MAY be; the
    game validates the actual ground anyway.

    `blocked(cell)` marks cells this mask may NOT contain (the water law). A
    pinch is normally closed with the horizontal partner; when that one is
    blocked the vertical partner closes it just as well, and when BOTH are
    blocked the pinch is broken from the other side instead — by dropping the
    diagonal cell. Result: the mask never swallows a blocked cell."""
    cells = set(cells)
    for _ in range(DRY_PASSES):
        add, drop = set(), set()
        for (x, y) in sorted(cells):
            # main diagonal (ox=+1): (x,y) + (x+1,y+1) present, others absent
            # anti-diagonal (ox=-1): (x,y) + (x-1,y+1) present, others absent
            for ox in (1, -1):
                if not ((x + ox, y + 1) in cells and (x + ox, y) not in cells
                        and (x, y + 1) not in cells):
                    continue
                if blocked is None or not blocked((x + ox, y)):
                    add.add((x + ox, y))
                elif not blocked((x, y + 1)):
                    add.add((x, y + 1))
                else:
                    drop.add((x + ox, y + 1))
        if drop:                       # shrink first, then re-examine
            cells -= drop
            continue
        if not add:
            return cells
        cells |= add
    raise AssertionError("fix_diagonals did not converge")


def trace_outer(cells):
    """Outer boundary polygon of a diagonal-clean 4-connected mask: directed
    boundary edges (interior on the left), stitched into loops; the loop with
    the largest |signed area| is the outer ring. Collinear runs are merged."""
    nxt = {}

    def _set(a, b):
        assert a not in nxt, f"pinched boundary at {a} (fix_diagonals missed it)"
        nxt[a] = b

    for (x, y) in cells:
        if (x, y - 1) not in cells:
            _set((x, y), (x + 1, y))
        if (x + 1, y) not in cells:
            _set((x + 1, y), (x + 1, y + 1))
        if (x, y + 1) not in cells:
            _set((x + 1, y + 1), (x, y + 1))
        if (x - 1, y) not in cells:
            _set((x, y + 1), (x, y))
    seen = set()
    best, best_area = None, 0
    for start in sorted(nxt):
        if start in seen:
            continue
        loop, cur = [start], nxt[start]
        seen.add(start)
        while cur != start:
            loop.append(cur)
            seen.add(cur)
            cur = nxt[cur]
        area = 0
        for i, (ax, ay) in enumerate(loop):
            bx, by = loop[(i + 1) % len(loop)]
            area += ax * by - bx * ay
        if abs(area) > abs(best_area):
            best, best_area = loop, area
    poly = []
    n = len(best)
    for i in range(n):
        px, py = best[(i - 1) % n]
        cx, cy = best[i]
        qx, qy = best[(i + 1) % n]
        if (cx - px, cy - py) != (qx - cx, qy - cy):
            poly.append((cx, cy))
    return poly


def assert_simple(poly, ctx):
    """Axis-aligned, closed, and NO self-intersections (the maintainer's law:
    'a real area'). O(n^2) segment check with shared-endpoint tolerance."""
    n = len(poly)
    assert n >= 4, f"{ctx}: degenerate polygon"
    segs = []
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        assert a != b and (a[0] == b[0]) != (a[1] == b[1]), \
            f"{ctx}: edge {a}->{b} not axis-aligned"
        segs.append((a, b))
    for i in range(n):
        (ax, ay), (bx, by) = segs[i]
        for j in range(i + 1, n):
            if j == i or (j == (i + 1) % n) or ((j + 1) % n == i):
                continue
            (cx, cy), (dx, dy) = segs[j]
            # axis-aligned overlap / crossing test
            if ax == bx and cx == dx:          # both vertical
                hit = ax == cx and min(ay, by) < max(cy, dy) and min(cy, dy) < max(ay, by)
            elif ay == by and cy == dy:        # both horizontal
                hit = ay == cy and min(ax, bx) < max(cx, dx) and min(cx, dx) < max(ax, bx)
            elif ax == bx:                     # vertical x horizontal
                hit = min(cx, dx) <= ax <= max(cx, dx) and min(ay, by) <= cy <= max(ay, by) \
                    and not (ax in (cx, dx) and cy in (ay, by))
            else:
                hit = min(ax, bx) <= cx <= max(ax, bx) and min(cy, dy) <= ay <= max(cy, dy) \
                    and not (cx in (ax, bx) and ay in (cy, dy))
            assert not hit, f"{ctx}: edges {segs[i]} x {segs[j]} intersect"


def poly_cells(poly, ctx=""):
    """Cells whose CENTER lies inside the polygon (even-odd on vertical edges)."""
    ys = [y for _, y in poly]
    xs = [x for x, _ in poly]
    out = set()
    vedges = []
    n = len(poly)
    for i in range(n):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % n]
        if ax == bx:
            vedges.append((ax, min(ay, by), max(ay, by)))
    for cy in range(min(ys), max(ys)):
        yc = cy + 0.5
        crossings = sorted(x for (x, y0, y1) in vedges if y0 <= yc < y1)
        for k in range(0, len(crossings) - 1, 2):
            for cx in range(crossings[k], crossings[k + 1]):
                out.add((cx, cy))
    return out


# -- the water law ------------------------------------------------------------

def wet(w, x, y, lo, hi):
    """Would a monster of a zone banded [lo,hi] be standing on WATER here?

    True only when the base material is water AND no deck inside the band
    covers it — so a bridge span is dry (you stand on the deck) but the water
    beneath it is not. Off-grid and void cells are not water; they are simply
    not spawnable, which validate_zone handles separately."""
    if not (0 <= x < w.w and 0 <= y < w.h):
        return False
    if w.m(x, y) not in w.water:
        return False
    d = w.deck.get((x, y), -1)
    return not (d > w.base(x, y) and lo <= d <= hi)


def _cut_open(filled, inside, pocket):
    """Mask cells to REMOVE so an enclosed pond stops being enclosed.

    spawns@1 polygons are a single ring with no holes, so a pond the ring would
    swallow cannot be excluded by punching a hole — the ring has to snake
    around it. Cutting the cheapest of four straight corridors from the pond to
    outside the ring does exactly that: the boundary walks in along one wall of
    the corridor and back along the other. Ties break by direction then path,
    so the cut is deterministic."""
    best = None
    for (dx, dy) in ((0, -1), (0, 1), (-1, 0), (1, 0)):
        # start at the pond cell furthest along this direction
        sx, sy = max(sorted(pocket), key=lambda c: c[0] * dx + c[1] * dy)
        path = []
        x, y = sx + dx, sy + dy
        while (x, y) in inside:
            if (x, y) in filled:
                path.append((x, y))
            x, y = x + dx, y + dy
        cand = (len(path), (dx, dy), tuple(path))
        if best is None or cand < best:
            best = cand
    return set(best[2])


def dry_mask(w, comp, lo, hi, forbid=frozenset()):
    """Shrink a habitat component until the polygon traced from it encloses NO
    forbidden cell — water (the water law) and, via `forbid`, anything closer to
    the arrival point than this monster is allowed to be (the difficulty
    gradient). Both need the SAME guarantee: not merely that the habitat avoids
    those cells, but that the traced POLYGON cannot contain one, since the game
    picks roam points from the polygon. Two shrink moves, both strictly monotone:

      * a diagonal-fill that would land on water is refused outright
        (fix_diagonals' `blocked`), so the mask never grows into the sea;
      * a pond the outer ring would enclose is CUT OPEN by _cut_open, and the
        corridor cells join `banned` so the next pass cannot re-fill them.

    `banned` only ever grows and every pass must add to it, so this terminates;
    DRY_PASSES is a backstop that fails the BUILD rather than shipping a zone
    with water in it."""
    banned = set()
    bad = (lambda c: c in forbid or wet(w, c[0], c[1], lo, hi))
    for _ in range(DRY_PASSES):
        blocked = (lambda c: c in banned or bad(c))
        parts = comps({c for c in comp if not blocked(c)})
        if not parts:
            return set()
        filled = fix_diagonals(parts[0], blocked)
        if not filled:
            return set()
        poly = trace_outer(filled)
        inside = poly_cells(poly)
        pond = {c for c in inside if bad(c)}
        if not pond:
            return filled
        cut = set()
        for pocket in comps(pond):
            cut |= _cut_open(filled, inside, pocket)
        assert cut - banned, "dry_mask stalled: pond cut made no progress"
        banned |= cut
    raise AssertionError("dry_mask did not converge")


def _elev_of(w, cells):
    lv = sorted(w.hab_level(x, y) for (x, y) in cells)
    return [lv[0], lv[-1]]


# -- zone construction --------------------------------------------------------

def make_zone(w, kind, comp, zid, elev=None, forbid=frozenset()):
    """Build one zone with a placeholder population of 1. The real `num` is set
    later by balance_population(), which shares the world budget out per MONSTER
    (see the population doctrine above) — a zone can't know its own count
    without knowing how many other zones its monster got.

    The elevation band and the water law are mutually dependent — narrowing the
    band un-covers cells that a deck was bridging, which makes them water,
    which shrinks the mask, which narrows the band. Both only ever shrink, so
    iterating to a fixed point converges (ELEV_PASSES is the backstop)."""
    band = [int(elev[0]), int(elev[1])] if elev else _elev_of(w, comp)
    for _ in range(ELEV_PASSES):
        cells = dry_mask(w, comp, band[0], band[1], forbid)
        assert cells, f"{w.name}/{zid}: no dry ground left after the water law"
        nxt = band if elev else _elev_of(w, (cells & set(comp)) or cells)
        if nxt == band:
            break
        band = nxt
    else:
        raise AssertionError(f"{w.name}/{zid}: elev/water fixed point diverged")
    poly = trace_outer(cells)
    assert_simple(poly, f"{w.name}/{zid}")
    inside = poly_cells(poly)
    zone = {"id": zid, "monster": kind,
            "area": [[x, y] for (x, y) in poly],
            "elev": [int(band[0]), int(band[1])], "num": 1}
    zone["_valid"] = validate_zone(w, zone, inside)   # spawnable cells (the cap)
    zone["_cells"] = len(cells & set(comp))           # habitat size (the weight)
    zone["_cap"] = zone_cap(w, spawn_cells(w, zone, inside))   # enclosed vs open
    return zone


def world_budget(w, n):
    """How many monsters this world carries in total, for `n` species."""
    if not n:
        return 0
    land = sum(1 for y in range(w.h) for x in range(w.w)
               if w.m(x, y) not in w.water and w.m(x, y) != "")
    return max(n * MON_TOTAL_MIN,
               min(n * MON_TOTAL_MAX, round(land / WORLD_CELLS_PER_MONSTER)))


def enclosed(w, x, y, lv):
    """Is a monster standing HERE under a roof?

    The test is the SURFACE, never the column. The black-mountain ledge at elev
    32-36 sits directly on top of the cave and shares every one of its (x,y) —
    but you stand there under open sky, and asking only "is this cell in the
    cave footprint" thinned the lava salamanders' ledge along with the dungeon
    beneath it. You are inside when your feet are below the slab's underside
    (`level - thickness`)."""
    d = w.deck.get((x, y))
    if d is None or w.deck_kind.get((x, y)) != "cave":
        return False
    return lv < d - w.deck_thick.get((x, y), 1)


def zone_cap(w, cells):
    """The crowding cap that governs THIS ground — a per-zone number, not a
    global one, because a cell of cave is not worth a cell of meadow.

    Decided by the GROUND and never by the monster: a zone is enclosed when most
    of its surfaces are, so a grass dweller a fallback put underground is thinned
    like everything else down there, and a cave dweller that ended up on the
    surface is not."""
    if not cells:
        return MAX_DENSITY
    under = sum(1 for (x, y, lv) in cells if enclosed(w, x, y, lv))
    return MAX_DENSITY * (CAVE_DENSITY_F if under * 2 > len(cells) else 1.0)


def room_of(z):
    """How many monsters a zone has ROOM for (the crowding law): its standable
    cells at its own cap, and never fewer than one — a single monster on its own
    is not a crowd whatever the arithmetic says."""
    return max(1, min(z["_valid"], int(z["_valid"] * z.get("_cap", MAX_DENSITY))))


def balance_population(w, zones):
    """Share the world's monster budget out so every TYPE ends up with a similar
    total, then spread each type's total across its own zones by area."""
    by_mon = {}
    for z in zones:
        by_mon.setdefault(z["monster"], []).append(z)
    n = len(by_mon)
    if not n:
        return zones
    budget = world_budget(w, n)
    base, extra = divmod(budget, n)
    # the few +1s go to the types with the most habitat (deterministic tie-break)
    order = sorted(by_mon, key=lambda m: (-sum(z["_cells"] for z in by_mon[m]), m))
    kept = []
    for i, mon in enumerate(order):
        target = base + (1 if i < extra else 0)
        zs = sorted(by_mon[mon], key=lambda z: (-z["_cells"], z["id"]))
        for z in zs:
            z["_target"] = target       # what topup_population aims back at
        if len(zs) > target:            # more zones than monsters: keep the biggest
            zs = zs[:target]
        weight = sum(z["_cells"] for z in zs) or 1
        rest = target - len(zs)         # one each, then area-proportional
        share = [rest * z["_cells"] / weight for z in zs]
        for z, s in zip(zs, share):
            z["num"] = 1 + int(s)
        for k in sorted(range(len(zs)),
                        key=lambda k: (-(share[k] % 1), zs[k]["id"]))[
                            :rest - sum(int(s) for s in share)]:
            zs[k]["num"] += 1
        # never claim more than the zone can HOLD (standable cells) or has ROOM
        # for (the crowding law) — and spill the excess into this species' OTHER
        # zones, so a full copse sends hedgehogs to the next copse instead of
        # stacking them six-deep in this one.
        for z in zs:
            z["num"] = max(1, min(z["num"], room_of(z)))
        short = target - sum(z["num"] for z in zs)
        for z in zs:
            while short > 0 and z["num"] < room_of(z):
                z["num"] += 1
                short -= 1
        kept.extend(zs)
    pos = {id(z): i for i, z in enumerate(zones)}
    return sorted(kept, key=lambda z: pos[id(z)])


# -- the crowding law ---------------------------------------------------------

def cell_caps(w, zones, cells):
    """cell -> the cap that governs it: the TIGHTEST of the zones covering it.

    Well-defined because the key carries the level: the cave floor at 0-1 is
    only ever covered by cave zones, and the mountain stacked over it by
    open-ground ones. Where an open zone did overlap enclosed ground, the
    enclosed number is the honest one — the walls are still there."""
    caps = {}
    for z in zones:
        cap = z.get("_cap")
        if cap is None:
            cap = zone_cap(w, cells[z["id"]])
        for c in cells[z["id"]]:
            if cap < caps.get(c, 1e9):
                caps[c] = cap
    return caps


def density_field(w, zones, cells=None):
    """cell -> expected monsters standing on it, summed over every zone.

    A zone contributes `num / |spawn cells|` to each of its spawn cells because
    that is literally how the server places them: pickMonsterTarget draws a cell
    uniformly from the zone's pre-validated list. Overlapping zones add up —
    which is the whole point, since overlap is what stacked 24 monsters under
    one tree."""
    cells = cells if cells is not None else \
        {z["id"]: spawn_cells(w, z) for z in zones}
    dens = {}
    for z in zones:
        cs = cells[z["id"]]
        if not cs:
            continue
        share = z["num"] / len(cs)
        for c in cs:
            dens[c] = dens.get(c, 0.0) + share
    return dens, cells


def floor_density(zones, cells):
    """cell -> the density that remains when every zone is down to ONE monster.

    The irreducible floor. ONE MONSTER IS NEVER A CROWD: a zone always keeps at
    least one, so a 14-cell footbridge with a single turtle on it sits at
    0.071/cell and no amount of arithmetic makes that a pile-up. The crowding
    law therefore binds on everything ABOVE this line — which is everything the
    generator can actually spend."""
    out = {}
    for z in zones:
        cs = cells[z["id"]]
        if not cs:
            continue
        share = 1.0 / len(cs)
        for c in cs:
            out[c] = out.get(c, 0.0) + share
    return out


def enforce_density(w, zones):
    """Settle the overlap: while some cell is over MAX_DENSITY, the zone
    crowding it hardest gives a monster back.

    Room-aware component choice keeps species APART, and the per-zone room cap
    keeps each one thin; neither can see the SUM where two species deliberately
    share ground. This can. Strictly monotone (Sum(num) drops by one per step,
    floored at one monster per zone), so it terminates; and it takes from the
    thickest contributor first, so the population it gives back is the crowd,
    not the map's variety.

    Returns (monsters given back, cells it could not get under the cap) — the
    second is terrain too small for the species that want it, reported the same
    way the difficulty gradient reports a habitat with nowhere far enough."""
    dens, cells = density_field(w, zones)
    caps = cell_caps(w, zones, cells)
    given, stuck = 0, []
    live = {c: v - caps[c] for c, v in dens.items()}      # ranked by OVERSHOOT
    while live:
        c, over = max(live.items(), key=lambda kv: (kv[1], kv[0]))
        hi = dens[c]
        if over <= 1e-9:
            break
        cand = [z for z in zones if z["num"] > 1 and c in cells[z["id"]]]
        if not cand:                    # already one monster per zone here
            ids = sorted(z["id"] for z in zones if c in cells[z["id"]])
            # A LONE zone at its minimum is just a small zone — the bridge guard
            # is one turtle on 14 cells and always will be. Only ground several
            # species are squeezed onto is worth reporting.
            if len(ids) > 1 and not any(o == ids for _c, _h, o in stuck):
                stuck.append((c, hi, ids))
            del live[c]
            continue
        z = max(cand, key=lambda z: (z["num"] / len(cells[z["id"]]), z["id"]))
        share = 1.0 / len(cells[z["id"]])
        z["num"] -= 1
        given += 1
        for cc in cells[z["id"]]:
            dens[cc] -= share
            if cc in live:
                live[cc] -= share
    return given, stuck


def topup_population(w, zones):
    """Hand back what enforce_density took, wherever the ground can still take
    it — the other half of settling the overlap.

    enforce_density takes from the thickest contributor at the crowded cell,
    which is fair but blind to WHOSE population it is spending: the lava poring
    lost four of its five monsters to a stone-golem zone lying over its ledge,
    while its other ledge sat half empty. So every species that ends up under
    the target it was allocated gets monsters back, one at a time, in whichever
    of its own zones has the most headroom left under the cap. Only ever adds
    where the result is still legal, so the law holds throughout."""
    dens, cells = density_field(w, zones)
    caps = cell_caps(w, zones, cells)
    by_mon = {}
    for z in zones:
        by_mon.setdefault(z["monster"], []).append(z)
    added = 0
    for _mon, zs in sorted(by_mon.items()):
        target = zs[0].get("_target", 0)
        while sum(z["num"] for z in zs) < target:
            best = None
            for z in sorted(zs, key=lambda z: z["id"]):
                cs = cells[z["id"]]
                if not cs or z["num"] >= min(z["_valid"], room_of(z)):
                    continue
                share = 1.0 / len(cs)
                head = min(caps[c] - dens[c] - share for c in cs)
                if head >= -1e-9 and (best is None or head > best[0]):
                    best = (head, z, share, cs)
            if best is None:
                break
            _h, z, share, cs = best
            z["num"] += 1
            added += 1
            for c in cs:
                dens[c] += share
    return added


def assert_density(w, zones):
    """THE CROWDING LAW — no cell may carry more than MAX_DENSITY monsters,
    beyond the one-per-zone floor no generator can spend.

    The gate the three mechanisms exist to satisfy, and the only one that also
    binds a hand-written spawns.json. Returns the peak density seen."""
    dens, cells = density_field(w, zones)
    if not dens:
        return 0.0
    base = floor_density(zones, cells)
    caps = cell_caps(w, zones, cells)

    def bar(c):                          # what this cell is actually allowed
        return max(caps[c], base[c])

    c, hi = max(dens.items(),
                key=lambda kv: (kv[1] - min(kv[1], bar(kv[0])), kv[1], kv[0]))
    over = sorted(z["id"] for z in zones if c in cells[z["id"]])
    assert hi <= bar(c) + 1e-9, (
        f"{w.name}: {hi:.3f} expected monsters on cell {c} — over the crowding "
        f"law's {caps[c]:.3f} for this ground (one per {round(1 / caps[c])} "
        f"cells). {len(over)} zone(s) stack there: {', '.join(over)}. Spread "
        f"them across more of the habitat; don't pile them up.")
    return max(dens.values())


def assert_gradient(w, zones, field=None):
    """THE DIFFICULTY GRADIENT — nothing dangerous within reach of a newcomer.

    Two rules, both about the moment a player lands:

      * NOTHING at all inside SAFE_R walk-cells of the arrival point. Absolute.
        A fresh player has 40 HP, and the map is not allowed to spend any of it
        before they have looked around.
      * every monster at least keep_out() away, which scales with its combat
        level and pushes the ones that HUNT further still — unless its habitat
        genuinely cannot offer anywhere far enough, which is reported rather
        than hidden.

    Returns the list of monsters the terrain could not satisfy (empty is good)."""
    field = field if field is not None else walk_dist(w)
    short = []
    for z in zones:
        kind = z["monster"]
        cells = poly_cells([tuple(p) for p in z["area"]])
        ds = [field[c] for c in cells if c in field]
        if not ds:
            continue
        d = min(ds)
        assert d >= SAFE_R, (
            f"{w.name}/{z['id']} ({kind}): spawns {d} walk-cell(s) from the "
            f"arrival point {w.spawn} — inside the SAFE_R={SAFE_R} landing "
            f"radius. Newcomers arrive there with 40 HP.")
        floor = keep_out(kind)
        if d < floor:
            lvl, ag = threat(kind)
            short.append((kind, lvl, ag, d, floor))
    return short


def spawn_cells(w, zone, inside=None):
    """The SURFACES the game will actually stand a monster on inside this
    polygon, as (x, y, level) — a cell that is both dry ground and covered by a
    deck in the band yields two, exactly as the server's list does.

    Mirrors buildZoneRuntimes (games2/shared/src/index.ts): a surface counts
    when the base is dry ground inside the elevation band, or when a deck top
    inside the band covers it (bridge spans over water, the cave roof over the
    cave floor). Props and void are out.

    The LEVEL is part of the key on purpose. This world is stacked: the cave
    floor at elev 0-1 lies directly under the black-mountain rock at 32-36, and
    the mountain benches and the snow cap are stacked over both. Those are
    different FLOORS of the same building — a player on the summit never meets
    what lives in the cave under their boots — so the crowding law must not add
    them together. Keyed by (x,y) alone it did, and it emptied the cave to
    relieve a crowd on the mountain that was never there.

    This — not the polygon — is the set the server draws roam targets from
    uniformly, so it is the set THE CROWDING LAW measures density over. Also
    re-asserts the water law on every cell it walks."""
    kind = zone["monster"]
    if inside is None:
        inside = poly_cells([tuple(p) for p in zone["area"]])
    lo, hi = zone["elev"]
    out = set()
    for (x, y) in inside:
        if not (0 <= x < w.w and 0 <= y < w.h):
            continue
        # THE WATER LAW: monsters can't swim, and water is about to become a
        # safe zone — so a zone may not even CONTAIN water it could roam onto.
        assert not wet(w, x, y, lo, hi), (
            f"{w.name}/{zone['id']} ({kind}): polygon contains WATER at "
            f"({x},{y}) in elev {zone['elev']} — monsters can't swim. Redraw "
            f"the zone off the water (dry_mask does this automatically for "
            f"generated zones; a hand-written spawns.json must do it itself).")
        if (x, y) in w.props:
            continue
        m = w.m(x, y)
        if m == "":
            continue
        # BASE surface: dry ground inside the band. Water never qualifies —
        # the assert above already proved any water here is deck-covered.
        if lo <= w.base(x, y) <= hi and m not in w.water:
            out.add((x, y, w.base(x, y)))
        d = w.deck.get((x, y), -1)
        if d > w.base(x, y) and lo <= d <= hi:
            out.add((x, y, d))
    return out


def validate_zone(w, zone, inside=None):
    poly = [tuple(p) for p in zone["area"]]
    assert_simple(poly, f"{w.name}/{zone['id']}")
    if inside is None:
        inside = poly_cells(poly)
    lo, hi = zone["elev"]
    assert 0 <= lo <= hi <= 64, f"{zone['id']}: bad elev {zone['elev']}"
    assert zone["num"] >= 1, f"{zone['id']}: num < 1"
    ok = len(spawn_cells(w, zone, inside))
    assert ok >= zone["num"], \
        (f"{w.name}/{zone['id']}: only {ok} valid spawn cell(s) for num="
         f"{zone['num']} in elev {zone['elev']}")
    return ok


def habitat_masks(w):
    """The habitat-key -> cell-mask table for one world."""
    land = {(x, y) for y in range(w.h) for x in range(w.w)
            if w.m(x, y) not in w.water and w.m(x, y) != ""}
    water = {(x, y) for y in range(w.h) for x in range(w.w) if w.m(x, y) in w.water}
    grass = {c for c in land if w.m(*c) == "saturated_grass"}
    near = set()
    for (px, py) in w.tall_props:
        for dx in range(-TREE_R, TREE_R + 1):
            for dy in range(-TREE_R, TREE_R + 1):
                near.add((px + dx, py + dy))
    # THE BANK, not the water: land within reach of water. Before the water law
    # this mask was the wet side of the same border — that is exactly what put
    # frogs in the ocean, so it is now the dry side and nothing else.
    shore = set()
    for (x, y) in sorted(land):
        if any((x + dx, y + dy) in water
               for dx in range(-WATER_SHORE_R, WATER_SHORE_R + 1)
               for dy in range(-WATER_SHORE_R, WATER_SHORE_R + 1)):
            shore.add((x, y))
    return {
        "grass": grass,
        "forest": grass & near,
        "dirt": {c for c in land if w.m(*c) == "lightdark_dirt"},
        "snow": {c for c in land if w.m(*c) == "regular_snow"},
        "ice": {c for c in land if w.m(*c) == "crystal_ice"},
        "dark": {c for c in land if w.m(*c) == "black_mountain"},
        "stone": {c for c in land if w.m(*c) == "stone_mountain"},
        "sand": {c for c in land if w.m(*c) == "light_sand"},
        "shore": shore,
        "cave": set(w.cave_floor),
    }


def zones_for(w):
    ids = roster_ids()
    members = {}                     # habitat key -> [monster ids] in roster order
    for mid in ids:
        members.setdefault(habitat_of(mid), []).append(mid)
    # THE EASIEST PICKS FIRST. Within a habitat the members choose their component
    # in this order, and the first to choose gets the NEAREST ground it is allowed
    # (the difficulty gradient decides what "allowed" means). Roster order is
    # arbitrary, so sorting by combat level puts the gentlest creature of each
    # habitat closest to the arrival point and pushes the dangerous ones to its far
    # end — which is what a newcomer walking out of the spawn actually meets
    # (maintainer 2026-08-21: "Think about not placing to hard monsters near the
    # spawn where the player is level 1"). Ties break on roster order, so a rebuild
    # still reproduces.
    for hab in members:
        members[hab].sort(key=lambda m: (threat(m)[0], threat(m)[1], ids.index(m)))
    masks = habitat_masks(w)
    field = walk_dist(w)             # THE DIFFICULTY GRADIENT: walk cells from spawn
    zones = []
    for hab in sorted(members):
        mask = masks.get(hab, set())
        mem = members[hab]
        min_cells = MIN_ZONE.get(hab, MIN_ZONE_DEFAULT)
        kept = [c for c in comps(mask) if len(c) >= min_cells]
        # Two homes per species' worth of components: the crowding law needs
        # somewhere to spread TO, and one component per member only works if
        # every member happens to want a different one.
        kept = kept[:max(TOP_K, 2 * len(mem))]
        if not kept:
            continue
        far = {}
        for i, c in enumerate(kept):
            d = comp_dist(c, field)
            far[i] = d if d is not None else 1 << 30   # unreachable: treat as far
        # Every member gets a zone; extra components cycle back over members, and
        # members sharing one component OVERLAP — that is still the design. What
        # changed (maintainer 2026-08-06) is WHICH component a given monster gets:
        # the NEAREST one it is allowed to live in, where "allowed" is its
        # keep_out() distance from the arrival point. Easy monsters therefore
        # come as close as the terrain permits and hard ones are pushed out,
        # instead of difficulty being scattered at random by habitat alone.
        count = max(len(mem), len(kept))
        taken = {}
        # THE CROWDING LAW, mechanism 1. Each component carries only so many
        # monsters; `used` is what the species placed so far have already
        # claimed of it. `demand` is what one species expects to be given
        # (balance_population splits the world budget evenly by type), so a
        # species can tell whether a component has room for it BEFORE moving in.
        used = [0.0] * len(kept)
        # enclosed ground carries less, so a cave component has less room
        cap = MAX_DENSITY * (CAVE_DENSITY_F if hab == "cave" else 1.0)
        room = [len(c) * cap for c in kept]
        demand = max(1, world_budget(w, len(ids)) // max(1, len(ids)))
        got = {m: 0.0 for m in mem}      # room each species has actually secured
        for i in range(count):
            # Everyone once, in roster order; then the SPARE components go to
            # whoever has the least room so far. Round-robin gave them to the
            # first names in the roster instead, which is how the lava poring
            # ended up alone on a ledge the stone golems were already using
            # while the malformed creature had two homes.
            kind = mem[i] if i < len(mem) else \
                min(mem, key=lambda m: (got[m], mem.index(m)))
            floor = keep_out(kind)
            seen = taken.setdefault(kind, set())
            # Trim each unused component to the part far enough out for THIS
            # monster, then take the nearest piece THAT STILL HAS ROOM: as close
            # as it is allowed to be, never closer, never on top of the
            # neighbours. Room outranks distance — that is the only way four
            # species sharing a habitat end up in four different copses — but
            # among the components with room, distance decides exactly as
            # before, so the difficulty gradient is unchanged.
            cands = []
            for j, c in enumerate(kept):
                if j in seen:
                    continue
                t = gradient_trim(c, field, floor)
                if len(t) < min_cells:
                    continue
                # ROOM IS MEASURED ON THE TRIMMED PIECE, not the raw component.
                # The gradient cuts a component down to the part far enough out
                # for THIS monster, and dry_mask cuts it again; sizing room off
                # the raw component overstates it, so several species judged a
                # ledge "roomy", moved in together, and the crowding law then
                # shaved them to one each afterwards.
                free = len(t) * cap - used[j]     # monsters it can still take
                fits = free >= demand
                # Tier 1: components with room for the whole population, nearest
                # first. Tier 2 (nothing has room): the EMPTIEST one — falling
                # back to distance here is what put all four black-mountain
                # species on the same 127-cell ledge, since "nearest" is the
                # same answer for all of them.
                cands.append((0 if fits else 1, 0 if fits else -free,
                              comp_dist(t, field) or (1 << 30), -len(t), j, t))
            if cands:
                cands.sort()
                j, comp = cands[0][-2], cands[0][-1]
                got[kind] += max(0.0, min(demand, room[j] - used[j]))
                used[j] += demand
            elif not seen:
                # Nowhere on this world is far enough for it, and it still needs
                # a home: take the furthest habitat there is. assert_gradient
                # REPORTS this rather than letting it pass unnoticed.
                j = max(range(len(kept)), key=lambda j: (far[j], len(kept[j])))
                comp = kept[j]
            else:
                # It already has a zone. A spare component is NOT a reason to add
                # a second one somewhere too easy — that is exactly how a level-11
                # Nightmule ended up 5 cells from the arrival point.
                continue
            seen.add(j)
            elev = [0, 1] if hab == "cave" else None
            # The polygon may not merely START beyond the floor — it may not
            # CONTAIN a cell inside it, or the game could roam a monster back
            # toward the newcomers. Same guarantee, same machinery as the water
            # law: hand the too-close cells to dry_mask as forbidden ground.
            # In the fallback case the terrain already cannot meet the floor, so
            # only SAFE_R is enforced — the absolute landing radius always holds.
            forbid = near_cells(field, floor if cands else SAFE_R)
            try:
                zones.append(make_zone(w, kind, comp, f"{hab}-{i + 1}",
                                       elev=elev, forbid=forbid))
            except AssertionError:
                # Nothing legal survives here on this world (small maps hit this).
                # Coverage on MUST_HAVE_ALL worlds is handled by fallback_zone.
                seen.discard(j)
                if cands:                # it never moved in — give the room back
                    got[kind] -= max(0.0, min(demand, room[j] - used[j] + demand))
                    used[j] -= demand
    # showcase: a guard on the biggest bridge span (deck-elevation zone)
    if BRIDGE_GUARD in ids and w.bridges:
        lvl, cells = max(w.bridges, key=lambda b: (len(b[1]), b[0]))
        if len(cells) >= BRIDGE_MIN_CELLS:
            zones.append(make_zone(w, BRIDGE_GUARD, set(cells), "bridge-1",
                                   elev=[lvl, lvl]))

    # THE ISLAND 2 must carry EVERY monster (the endgame map). Any monster that
    # its habitat rules left out gets a guaranteed fallback zone; then we assert.
    if w.name in MUST_HAVE_ALL:
        placed = {z["monster"] for z in zones}
        for mid in ids:
            if mid in placed:
                continue
            z = fallback_zone(w, masks, mid)
            assert z is not None, \
                (f"{w.name} MUST contain all monsters but {mid} has NO valid "
                 f"home anywhere — redraw the habitat rules")
            zones.append(z)
        placed = {z["monster"] for z in zones}
        missing = [m for m in ids if m not in placed]
        assert not missing, f"{w.name} is missing monster(s): {missing}"
    return zones


def fallback_zone(w, masks, mid):
    """A guaranteed zone for a monster whose habitat rules produced nothing on a
    MUST_HAVE_ALL world: the largest component (no size threshold) of its own
    habitat, then of each FALLBACK_HABS habitat, that yields >=1 valid cell."""
    tried = [habitat_of(mid)] + [h for h in FALLBACK_HABS if h != habitat_of(mid)]
    for hab in tried:
        elev = [0, 1] if hab == "cave" else None
        for comp in comps(masks.get(hab, set())):    # biggest first
            try:
                return make_zone(w, mid, comp, f"extra-{mid}", elev=elev)
            except AssertionError:
                continue
    return None


def refresh(name):
    if name in BUILDER_OWNS:
        print(f"{name}: builder owns spawns.json — skipped")
        return
    wpath = os.path.join(WORLDS, name, "world.json")
    if not os.path.isfile(wpath):
        return
    if name in NO_SPAWN_WORLDS:                     # feature-test map: no monsters
        with open(os.path.join(WORLDS, name, "spawns.json"), "w") as f:
            json.dump({"schema": SCHEMA, "world": name, "zones": []}, f,
                      separators=(",", ":"))
        print(f"{name}: 0 zones (feature-test map — no monsters)")
        return
    w = W(name)
    zones = balance_population(w, zones_for(w))
    given, stuck = enforce_density(w, zones)         # THE CROWDING LAW
    given -= topup_population(w, zones)              # ...and its refund
    peak = assert_density(w, zones)
    short = assert_gradient(w, zones)
    for kind, lvl, ag, d, floor in short:
        print(f"  ! {name}/{kind} (L{lvl}{'/hunts' if ag else ''}) sits {d} cells "
              f"from spawn, wanted {floor} — its habitat has nowhere further")
    for c, hi, over in stuck[:3]:
        print(f"  ! {name}: {hi:.3f} monsters/cell at {c} with every zone there "
              f"down to one — {len(over)} species want the same small ground "
              f"({', '.join(over)})")
    if given:
        print(f"  ~ the crowding law gave back {given} monster(s) where zones "
              f"overlapped")
    for z in zones:                                 # drop the allocator's scratch
        z.pop("_valid", None)
        z.pop("_cells", None)
        z.pop("_target", None)
        z.pop("_cap", None)
    doc = {"schema": SCHEMA, "world": name, "zones": zones}
    with open(os.path.join(WORLDS, name, "spawns.json"), "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    kinds = sorted({z["monster"] for z in zones})
    total = sum(z["num"] for z in zones)
    extra = f"  [ALL {len(kinds)} monsters]" if name in MUST_HAVE_ALL else ""
    print(f"{name}: {len(zones)} zone(s), {total} monsters, "
          f"{len(kinds)} kind(s), peak {peak:.3f}/cell{extra}")


def validate_file(name):
    """Re-validate a shipped spawns.json against its world (used by builders)."""
    w = W(name)
    doc = json.load(open(os.path.join(WORLDS, name, "spawns.json")))
    assert doc["schema"] == SCHEMA and doc["world"] == name
    ids = set(roster_ids())
    for z in doc["zones"]:
        assert z["monster"] in ids, f"{z['id']}: unknown monster {z['monster']}"
        validate_zone(w, z)
    if name not in CROWDING_EXEMPT:
        assert_density(w, doc["zones"])              # THE CROWDING LAW
    return len(doc["zones"])


def check_all(names):
    """Gate: re-validate every SHIPPED spawns.json without regenerating anything.

    refresh() proves the laws when zones are built, but a hand-edited spawns.json
    or a world.json changed outside the pipeline would not be re-checked until
    the next rebuild. This re-runs the full validation (simple polygon, enough
    standable cells, and above all the WATER LAW) against what is on disk.

        python maps2/pipeline/spawns.py --check      # exit 1 on any violation
    """
    bad = 0
    zones = mons = 0
    for name in names:
        sp = os.path.join(WORLDS, name, "spawns.json")
        if not os.path.isfile(sp):
            print(f"  {name}: NO spawns.json")
            bad += 1
            continue
        try:
            n = validate_file(name)
        except AssertionError as e:
            print(f"  {name}: FAIL — {e}")
            bad += 1
            continue
        doc = json.load(open(sp))
        zones += n
        mons += sum(z["num"] for z in doc["zones"])
        print(f"  {name}: {n} zone(s) OK")
    print(f"spawns --check: {zones} zone(s), {mons} monsters, "
          + ("ALL OK — no zone touches water, nothing is piled up"
             if not bad else f"{bad} WORLD(S) FAILED"))
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
