"""Endless procedural category inventor for the tiles loop.

When the explicit + `procedural` lists in config are exhausted, the loop calls
`invent_category` to synthesise the next focused set on demand. It:

  * cycles the four height PROFILES to hold the target ~40/20/20/20 mix
    (flat / raised / cliff / tall), always picking the profile furthest below
    its target share of what's already on disk;
  * draws from curated themed BANKS (each a real, on-theme 6-variation prompt in
    the house style), so quality stays high — never a generic "mixed" tile;
  * once every base theme in a profile is used, re-issues themes with a fresh
    `_vN` id (hence a fresh seed) so the library grows forever.

Everything is deterministic from the filesystem, so the loop stays resumable.
"""

from __future__ import annotations

import tilegen

# Target share of the library per profile (see tiles/README.md height profiles).
TARGET = {"flat": 0.40, "raised": 0.20, "cliff": 0.20, "tall": 0.20}

# Extra generation params each profile needs on top of the fixed base format.
PROFILE_PARAMS = {
    "flat": {},
    "raised": {"depth_ratio": 1.0},
    "cliff": {"tile_height": 128, "depth_ratio": 0.75},
    "tall": {"tile_height": 128, "depth_ratio": 1.0},
}

# Curated themed prompts, one focused set each, in the house style
# ("isometric <theme> tiles, <theme> only: 1) … 6) …"). Order is the tie-break
# for which theme comes next, so keep the most useful terrain up top.
BANKS = {
    "flat": [
        ("meadow", "isometric meadow tiles, flowering grassland only: 1) clover meadow 2) buttercup meadow 3) tall swaying grass 4) grass with dandelions 5) trampled meadow path 6) meadow with small stones"),
        ("autumn_forest", "isometric autumn forest floor tiles, autumn woodland ground only: 1) fallen orange leaves 2) red maple leaves 3) brown leaf litter 4) mossy roots with leaves 5) bare autumn soil 6) acorns and twigs"),
        ("wheat_field", "isometric wheat field tiles, ripe grain only: 1) golden wheat rows 2) short wheat stubble 3) wind-bent wheat 4) barley field 5) harvested field 6) wheat with poppies"),
        ("gravel", "isometric gravel tiles, loose stone only: 1) grey gravel 2) fine gravel path 3) coarse crushed rock 4) gravel with weeds 5) reddish gravel 6) packed gravel"),
        ("clay", "isometric clay ground tiles, clay only: 1) smooth red clay 2) cracked dry clay 3) wet clay 4) grey clay 5) clay with pebbles 6) baked clay flats"),
        ("mushroom_grove", "isometric mushroom grove tiles, fungal forest floor only: 1) mossy floor with red toadstools 2) brown mushroom cluster 3) glowing blue mushrooms 4) fungal roots 5) damp leaf floor with fungi 6) tiny mushroom ring"),
        ("bog", "isometric bog tiles, peat wetland only: 1) dark peat 2) mossy bog 3) waterlogged peat 4) reedy bog pool 5) sphagnum moss 6) muddy bog path"),
        ("savanna", "isometric savanna tiles, dry grassland only: 1) golden dry grass 2) cracked savanna soil 3) sparse tufts on dust 4) reddish earth 5) trampled savanna 6) grass with dry shrubs"),
        ("marble_floor", "isometric marble floor tiles, polished marble only: 1) white marble 2) veined grey marble 3) black marble 4) checkered marble 5) marble with gold inlay 6) cracked marble"),
        ("mosaic_floor", "isometric mosaic floor tiles, decorative tilework only: 1) blue geometric mosaic 2) sunburst mosaic 3) terracotta mosaic 4) worn temple mosaic 5) star-pattern mosaic 6) mossy old mosaic"),
        ("crystal_ground", "isometric crystal cavern floor tiles, crystalline ground only: 1) purple crystal shards 2) blue crystal cluster 3) rocky floor with gems 4) glowing crystal vein 5) quartz gravel 6) dark stone with crystals"),
        ("coral_sand", "isometric coral beach tiles, tropical shore only: 1) pale coral sand 2) sand with pink coral 3) shell-strewn sand 4) wet reef flat 5) sand with starfish 6) tide-rippled coral sand"),
        ("vineyard", "isometric vineyard ground tiles, cultivated rows only: 1) trellised vine rows 2) grassy vine lanes 3) tilled vineyard soil 4) vines with grapes 5) autumn vineyard 6) bare vine stumps"),
        ("permafrost", "isometric permafrost tiles, frozen ground only: 1) frost-cracked soil 2) ice-crusted moss 3) frozen gravel 4) snow-dusted tundra 5) frozen puddle 6) hard frost earth"),
    ],
    "raised": [
        ("brick_step", "isometric low brick step tiles, one-level brick edges only: 1) brick step front 2) brick step corner 3) worn brick riser 4) mossy brick step 5) brick ramp 6) capped brick step", ),
        ("wood_deck_edge", "isometric raised wooden deck edge tiles, one-level wood only: 1) plank deck edge 2) deck corner 3) deck step down 4) railing edge 5) worn deck rim 6) deck with post"),
        ("stone_planter", "isometric raised stone planter tiles, one-level garden borders only: 1) stone planter front 2) planter corner 3) flowering planter 4) hedge-topped planter 5) mossy planter 6) planter with vines"),
        ("sand_bank", "isometric low sand bank tiles, one-level sandy edges only: 1) sand bank front 2) sand bank corner 3) grassy dune edge 4) eroded sand step 5) beach berm 6) sand rim"),
        ("snow_bank", "isometric low snow bank tiles, one-level snowy edges only: 1) snow bank front 2) snow bank corner 3) plowed snow edge 4) icy snow step 5) drifted snow rim 6) snow over low wall"),
        ("iron_railing", "isometric low iron railing tiles, one-level fences only: 1) wrought-iron rail 2) rail corner 3) rail gate 4) spear-top rail 5) rusted rail 6) rail with stone post"),
        ("crop_bed", "isometric raised crop bed tiles, one-level farm beds only: 1) planted raised bed 2) bed corner 3) watered bed 4) sprouting bed 5) strawed bed 6) empty raised bed"),
        ("lava_ledge", "isometric low volcanic ledge tiles, one-level basalt edges only: 1) basalt ledge front 2) ledge corner 3) glowing-crack ledge 4) ashen step 5) obsidian rim 6) cooled lava step"),
    ],
    "cliff": [
        ("cliff_jungle", "isometric jungle cliff tiles, two-level vine-draped rock face, cliffs only: 1) vined cliff front 2) leafy cliff corner 3) mossy jungle cliff 4) rooty overhang 5) fern ledge drop 6) jungle cliff inner corner"),
        ("cliff_coast", "isometric sea-cliff tiles, two-level coastal rock face, cliffs only: 1) wet sea cliff front 2) barnacled cliff corner 3) chalk cliff 4) wave-cut ledge 5) rocky shore drop 6) sea cliff inner corner"),
        ("cliff_clay", "isometric red-clay cliff tiles, two-level badland face, cliffs only: 1) clay cliff front 2) clay cliff corner 3) banded clay strata 4) eroded clay gully 5) crumbling clay drop 6) clay cliff inner corner"),
        ("cliff_moss", "isometric mossy cliff tiles, two-level overgrown rock face, cliffs only: 1) moss cliff front 2) moss cliff corner 3) dripping mossy cliff 4) ferny cliff drop 5) lichen-streaked cliff 6) moss cliff inner corner"),
        ("cliff_crystal", "isometric crystal cliff tiles, two-level gem-studded rock face, cliffs only: 1) crystal cliff front 2) crystal cliff corner 3) glowing vein cliff 4) shard-studded drop 5) quartz ledge 6) crystal cliff inner corner"),
        ("cliff_gold", "isometric gold-ore cliff tiles, two-level mining rock face, cliffs only: 1) ore cliff front 2) ore cliff corner 3) golden vein cliff 4) blasted rock drop 5) timber-braced ledge 6) ore cliff inner corner"),
        ("cliff_marble", "isometric marble quarry cliff tiles, two-level cut-stone face, cliffs only: 1) marble cliff front 2) marble cliff corner 3) chiseled block face 4) stepped quarry drop 5) veined marble ledge 6) marble cliff inner corner"),
    ],
    "tall": [
        ("pine_tree", "isometric tall pine tree tiles, conifers only: 1) tall pine 2) snow-dusted pine 3) narrow fir 4) twin pines 5) bare dead pine 6) young pine"),
        ("oak_tree", "isometric tall oak tree tiles, broadleaf trees only: 1) full oak canopy 2) autumn oak 3) gnarled old oak 4) young oak 5) split-trunk oak 6) mossy oak"),
        ("wooden_tower", "isometric tall wooden tower tiles, timber structures only: 1) log watchtower 2) tower top platform 3) tower with ladder 4) ruined wood tower 5) tower base 6) tower doorway"),
        ("obelisk", "isometric tall stone monument tiles, standing stones only: 1) carved obelisk 2) weathered menhir 3) rune stone 4) broken pillar 5) twin standing stones 6) mossy monolith"),
        ("waterfall", "isometric tall waterfall tiles, falling water on rock only: 1) waterfall face 2) waterfall top lip 3) misty cascade 4) rocky falls edge 5) plunge pool base 6) frozen waterfall"),
        ("ice_spire", "isometric tall ice spire tiles, glacial pillars only: 1) blue ice spire 2) jagged ice tower 3) frosted crag 4) icicle-hung pillar 5) cracked ice column 6) snow-capped ice spire"),
        ("cactus", "isometric tall cactus and desert-spire tiles, desert verticals only: 1) saguaro cactus 2) branching cactus 3) rock spire 4) hoodoo pillar 5) dead cactus 6) flowering cactus"),
        ("crystal_spire", "isometric tall crystal spire tiles, giant gems only: 1) purple crystal spire 2) blue crystal cluster tower 3) glowing shard pillar 4) fractured crystal 5) quartz spire 6) dark gem tower"),
    ],
}

# Some bank entries above were authored as 1-tuples by accident; normalise.
BANKS = {p: [(e[0], e[1]) for e in entries] for p, entries in BANKS.items()}


def _version_count(base, existing_ids):
    """How many ids for this base theme already exist (base, base_v2, base_v3…)."""
    c = 1 if base in existing_ids else 0
    k = 2
    while f"{base}_v{k}" in existing_ids:
        c += 1
        k += 1
    return c


def _next_id(base, existing_ids):
    if base not in existing_ids:
        return base
    k = 2
    while f"{base}_v{k}" in existing_ids:
        k += 1
    return f"{base}_v{k}"


def invent_category(cfg):
    """Synthesise the next focused category to keep the library growing.

    Picks the profile furthest below its target share, then the least-used theme
    in that profile's bank (fresh themes before any repeat), and returns a
    category dict shaped exactly like a config entry.
    """
    mans = tilegen.list_categories()
    existing_ids = {m["category"] for m in mans}
    counts = {p: 0 for p in TARGET}
    for m in mans:
        p = m.get("profile")
        if p in counts:
            counts[p] += 1
    total = sum(counts.values()) or 1
    # Profile with the biggest shortfall vs its target share.
    profile = max(TARGET, key=lambda p: TARGET[p] - counts[p] / total)

    bank = BANKS[profile]
    # Least-used theme first; ties broken by bank order (min is stable).
    base_id, desc = min(bank, key=lambda e: _version_count(e[0], existing_ids))
    cid = _next_id(base_id, existing_ids)

    cat = {"id": cid, "profile": profile, "description": desc}
    cat.update(PROFILE_PARAMS[profile])
    return cat
