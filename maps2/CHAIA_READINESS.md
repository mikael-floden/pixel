# CHAIA READINESS — maps2 internal ledger

**maps2-INTERNAL. No other agent needs to read this, and nothing here is a
contract.** Cross-domain contracts live in `maps2/spec/WORLD3.md` and on the
coordination boards; this file exists so the maps2 agent can answer one
question on any future run — *how close are we to moving the game into the
Azgaar world?* — without re-running the investigation.

Investigated 2026-09-02 (nine read-only agents). Source data: the maintainer's
FMG save of the continent **Chaia**, generator version 1.150.0, seed 393321065.
He uploaded `.map` + Cells/Routes/Rivers/Markers/Zones GeoJSON. **The uploads
are not in the repo** — if this is ever picked up, ask him to re-send, and ask
at the same time for **Export ▸ JSON ▸ full**, which is the only export
carrying pack-cell site points, cell→grid links and the vertex table.

---

## 1. The law that decides everything

**ONE GAME CELL IS 1.7 METRES.** Not a choice — `scenery/config/factory.json`
fixes the ruler: *"64px == 1.7m character"*, and a cell is 64 px wide. Every
piece of scenery in the repo is scaled through it.

| | |
|---|---|
| current `the_game`, 512² cells | 870 × 870 m = **0.76 km²** |
| Chaia as the save declares it | 485 × 941 canvas px × 4 km/px = **1,940 × 3,764 km = 7.3 M km²** |
| Chaia imported 1:1 at 1.7 m/cell | **2.5 × 10¹² cells** — nine million times the current world |
| one Azgaar cell | ~6.5 canvas px = **26 km** across |

So "the current world is 1/50th of Chaia" is off by six orders of magnitude,
and a 50× world (3620² cells = 6.15 km) is **4.2× smaller than one Azgaar
cell**. A 1:1 import is not a hard problem, it is an impossible one.

**THE RESCALE IS THE ONLY LIVE OPTION.** Keep Chaia's shape, biomes, rivers,
routes, burgs and names; throw away its kilometres. Redefining 1 canvas px as
~12.7 m (instead of 4,000) gives:

* **3,620 × 7,023 cells = 25.4 M cells**, 6.2 × 11.9 km, **73 km²**
* one Azgaar cell becomes **82 m** — a hamlet and its fields, a sensible grain
  for imported height/biome data
* 23 states at ~3.1 km² each, 189 provinces at ~0.39 km², a marker every
  0.66 km²

For calibration: Skyrim 37.1 km², Oblivion 41, BotW 60, GTA V 81. A 50× world
(37.9 km²) is Skyrim; the full rescale (73 km²) sits between BotW and GTA V.
**His instinct about the SIZE is right; only the kilometres are wrong.**

---

## 2. Facts already paid for — do not re-derive

* `.map` is **53 CRLF-joined elements** (181 physical lines only because
  element 5 is an 872 KB SVG). Format read off FMG's own source at the
  matching version, not guessed.
* **Element 7 (`grid.cells.h`) is a perfect 124 × 241 row-major raster** —
  verified against FMG's `findCell` on all 29,884 points, zero exceptions.
  Height, temperature and precipitation come out as images; **no Voronoi work
  is needed for terrain at all.** This is the single biggest simplification
  available.
* **Height decodes exactly**: `metres = (h − 18)²` for h ≥ 20, sea level
  h = 20, h = 0 → −990 m. All 10,895 exported heights invert to integer bytes,
  so the GeoJSON metres and the raw byte are interchangeable.
* **Burgs are only in the `.map`** — no GeoJSON carries them. 773 settlements,
  24 fields each (population, capital, port, citadel, walls, temple, plaza,
  market, shanty, culture, state, cell, x/y). 23 capitals, 190 ports.
* Also in the save: 23 states, 189 provinces, 10 cultures, 19 religions, 261
  rivers (with discharge), 675 routes, 111 markers, 199 notes, 43 name bases,
  71 trade goods, 23 markets.
* **TRAP — the Cells GeoJSON does not cover the map.** Pack cells span
  y 125.6…803.6 px of a 941 px canvas; the top and bottom 28% (deep ocean)
  have no cells. An importer rasterising from the GeoJSON alone silently
  produces a truncated world.
* **Licence is clean**: FMG is MIT and its LICENSE adds an explicit grant for
  derivative works and commercial benefit from generated maps.
* **The source has no terrain detail**: 29,884 height samples for a world we
  would draw at millions of cells (1 per 137). Bilinearly resampled the
  continent is **smoother than the island already shipping** — 94.0% flat
  adjacent pairs. Chaia gives the SHAPE of a world; every cliff, gorge, ramp
  and cave is still ours to generate.

---

## 3. The gates — where we actually are

Status: ✅ done · 🟡 partly · ❌ not started · ⛔ blocked on a decision

| # | Gate | Measured today | Done means | Owner |
|---|---|---|---|---|
| 1 | Deterministic build | ❌ three identical runs → three different `world.json`; three tie-breaks in the forest pass resolve by iteration order (`world3.py` mode-smoothing) | pipeline run twice, byte-identical, gated | **maps2** |
| 2 | Chunked world document | ❌ one `world.json`, fetched whole by the client | content-hashed chunks + index; server loads only what a room needs | maps2 + games |
| 3 | Typed-array world | ❌ parser builds one JS object per cell, **112 B/cell** → 443 MB heap / 599 MB RSS at 4 M cells | ~10 B/cell → 41 MB; parse becomes a binary decode | games |
| 4 | Server box | ❌ Cloud Run pinned `--cpu 1 --memory 512Mi --max-instances 1`; OOMs before a player joins | fits, or the shape is raised deliberately | games |
| 5 | Tiled reference renderer | ❌ `render3.py` allocates the whole canvas as one PIL image: 1.98 GB today, ~34 GB at 20× | region tiles + zoom pyramid; 16 cells of overlap makes tiles byte-identical to one canvas | **maps2** |
| 6 | Deploy gate covers the shipping world | ❌ deploy sparse-checkout omits `maps2/worlds3/`; ~122 tests self-skip; surfaces + light-budget checks only open v2 worlds | the world that ships is the world that is tested | games |
| 7 | Wiki reads worlds3 | ❌ wiki build reads `maps2/worlds/<name>`; DEFAULT_WORLD moved to a worlds3 world 2026-09-02 | the maintainer's review instrument opens the live world | wiki |
| 8 | Review loop at scale | ❌ no single render exists above ~4× cells; crossing takes ~15 min at 20× | he can still look, judge and tune — the project's whole premise | **maps2** + wiki |
| 9 | Biome art | 🟡 4 of 13 biomes covered. Missing ground: savanna, tropical seasonal, rainforest, taiga (+ hot desert, tundra, glacier, wetland thin). Tropics + savanna = **40% of Chaia's land** | one `G__over__G` tile per new ground is the hard minimum — the Wang boundary layer is material-independent, so no per-pair matrix | tiles |
| 10 | Biome scenery | ⛔ `EXCLUDED_GROUPS` blocks the trees group ("we are NOT working with trees right now") | jungle/savanna/taiga dressable | scenery + maintainer |
| 11 | Height → level curve | ⛔ unspecified. FMG −950…6,724 m vs our integer levels; night heightmap packs level into **one byte**, so >255 levels cannot exist | a chosen metres-per-level, with the renderer's storey cost understood | maps2 + maintainer |
| 12 | Burg tiering | ⛔ 773 settlements sit ~19 cells apart at any workable scale | a rule for which burgs are real places and which are a signpost | maintainer |
| 13 | Naming | ⛔ existing cast + canon are Nordic; Chaia is Vietic/Persian/Turkic/Korean | one of the two gives | maintainer + lore |
| 14 | Water law | ⛔ `spawns.py`: nothing spawns on water, water is a safe zone. Chaia ships 190 ports, 115 sea routes, pirates, sea monsters | decided | maintainer |
| 15 | Things to do out there | ❌ no dialogue, quest, shop or boat systems exist | a world 50× larger is not 50× more walking | games + maintainer |

**Nothing on this list is finished.** Gates 1 and 5 are mine and are the only
ones I can close without anyone else.

---

## 4. Order of work — what actually unblocks what

1. **Gate 1, determinism.** Cheapest, mine, and everything content-addressed
   is built on it. Nothing about chunked publication works while a rebuild
   changes every chunk for no reason.
2. **Gate 5, the tiled renderer.** On the critical path for *every* option
   including the cheap one, because without it nobody can look at what we
   import. The review tool breaks at 4× the current cells — a quarter of the
   ask — so this bites long before the engine does.
3. **One region, imported end to end.** A few hundred Azgaar cells around a
   chosen burg: rasterise height and biome, lay roads on the routes, place the
   town, render it. **This is the experiment that proves or kills the idea**,
   and it is one image. Do not write a general importer before it exists.
4. Only then: gates 2/3/4 (the engine), which are games-owned and large.

---

## 5. What I would ask him, when this comes up again

The five decisions are gates 10–14 above. The one that must come first is
**gate 11's parent question**: do we throw away Chaia's kilometres? Everything
downstream depends on it, and it costs him nothing to answer.

Second: he should know that the review loop (gate 8) is the thing that fails
first and the thing with no obvious fix. The engine limits all have fixes;
"he can no longer see the world he is judging" does not.

---

*Full investigation report (artifact, his copy):*
`https://claude.ai/code/artifact/591268b7-efff-428a-b4a1-cd163799aed1`
