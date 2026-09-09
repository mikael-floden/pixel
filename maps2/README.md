# maps2 — worlds for the game (Map2 agent)

World assembler. Names a **ground type per cell** from `tiles/ground_types.json`
(Tiles 3.0 resolves the art at draw time) and produces **the world** under
`maps2/worlds3/the_game/`: `world.json` plus the sidecars `spawns.json`,
`npcs.json`, `places.json` and the map images. The format contracts the game
parses against live in `spec/`: `WORLD3.md`, `SPAWNS.md`, `NPCS.md`, `PLACES.md`.
(tiles2 and the world@1/@2 worlds were retired 2026-09-09 — history in git.)

## Releasing — deploy YOURSELF, always push to `main`

**`main` is the release channel.** The game reads worlds from the repo at
runtime and every push to `main` under `maps2/**` auto-deploys nangijala.online
(`.github/workflows/nangijala-deploy.yml`). Work on a side branch is invisible
to the game — a map change is only delivered when it's on `main` (a finished
world once sat on a session branch while the maintainer waited).

The deploy ships only if games2's `test` job is green. For a maps2 push the
gate that normally trips is **`check-surfaces`** (a world uses a tile category
with no gameplay classification → prod silently stays on the previous map).
**Standing authorisation from the game agent (runbook `games2/SURFACES.md`):
fix it yourself — never wait.** The recipe:

1. `cd games2 && npx tsx scripts/check-surfaces.mjs` — prints the flagged
   categories with a ready-to-paste proposal (same output as the red CI log).
2. Add one line per category to `SURFACES` in **`games2/shared/src/surfaces.ts`**
   — the ONLY games2 file we may edit. You decide the shape: standable ground
   (`ground(speed, "sound")`), swimmable water, `solid` object, or
   `stairs: true` ramp. Append near similar entries, don't reflow.
3. `cd games2 && npm ci && npm run typecheck && npm test` — must be GREEN.
   **Never push red** — a red push blocks every domain's deploy.
4. Commit + push to `main` (rebase on reject); the deploy re-triggers and prod
   rolls forward with the world + the entry together.
5. Conflict in `surfaces.ts`? Keep both sides' new entries (it's a plain map).

**Resolving a conflict in a file another agent owns** (`live/tuning/*`,
`surfaces.ts`, `coordination/*`): **`git checkout --theirs` takes YOUR side
during a rebase**, not upstream's — the labels are inverted there, and using it
silently reverted 46 of the maintainer's own shadow-calibration blocks in
`live/tuning/monsters.json` (caught by diffing against `origin/main` before the
push; commit 6e72bd9e89). Take the other side EXPLICITLY —
`git show origin/main:<path> > <path>` — then re-apply your own change on top
programmatically, and verify field-by-field against `origin/main` that only the
fields you meant to touch differ. Never resolve a shared file by hand-picking
hunks.

Better still: when adopting a brand-new ground type, ask the tiles agent to
classify it at creation (`python coordination/board.py post maps2 --to tiles
--text "classify <ground> please"`) so the gate never goes red — but don't
block on them.

If a **different** gate fails (navigation sim, `verify-deckwalk`, a unit test),
that's a real defect in the map (walled-in spawn, deck with no entry, …): fix
it HERE in maps2 — do not touch anything else under `games2/`.

**After EVERY deploy, send the maintainer the full-map image** (maintainer:
"always do that after you have deployed, so I can see the entire map state
directly"): once the deploy run is green, deliver
`worlds/the_island2/minimap.webp` — don't wait to be asked.

## Map images — one `minimap.webp` + one `map_base.webp` per world

- **`minimap.webp`** (maintainer: "normalize how you save/store the map") — the
  isometric view with **every NON-MAP pixel transparent**;
  `games2/scripts/build-worlds.mjs` captures it into `worlds.json`'s `preview`.
  Transparency happens at RENDER time (the iso canvas starts transparent) —
  the corner filler and the ocean are the SAME water colour and can't be
  separated after the fact. `render()`/`render_overview(..., transparent=True)`
  produce it; `render2.save_minimap()` caps the width and saves **without
  `convert('RGB')`** (that flattens the alpha to a solid rectangle). The old
  ad-hoc names (`preview.png`, `demo.png`, `overview.png`, 17MB full-res
  demos) are retired; `save_minimap` deletes a stale `minimap.png` beside it.
  Each builder writes its own (island builders keep props/decks in the
  picture);
  **`python maps2/pipeline/minimaps.py`** backfills/refreshes every world from
  its committed `world.json` (no regeneration) — run it after touching the
  renderer.
- **`map_base.webp`** (`pipeline/cartomap.py`) — the Map tab's cartographic
  base layer: same iso projection but drawn to be READ at thumbnail size
  (per-material palette instead of tile art, hillshade from the level grid,
  height-darkened cliff faces, coastline stroke + shallow-water shelf, roads).
  Renders only what never changes; the client overlays the live layer (player,
  NPCs, shops, cave mouth, danger, fog) from the sidecars.

## Elevation & occlusion rules — ALWAYS apply when shaping terrain

The camera looks from the **south**: a tile toward the camera (larger `x+y`)
draws **over** what is up-screen behind it. Higher ground on a player's
camera-facing (`+x`/`+y`) side swallows their legs, and its cliff face points
away from the camera — with the same material on both sides it reads as a
rendering bug, not a hill. **Never ship that.**

**The rule:** land elevation must never step **up toward the camera** with the
same material. Equivalently: make terrain **camera-facing** — high up-screen,
sloping down toward the camera, so every cliff face is visible.

Consequences:

- **Slopes face the camera.** A rise descending toward the camera is fine with
  one material over a big area; the forbidden case is the far side of a hill
  descending *away*.
- **Up-screen coasts are sheer sea-cliffs, not beaches** (à la *A Link to the
  Past*'s northern mountains): the top of the map drops abruptly to water.
  Beaches live only on the **near (camera) shore**. Valleys/cliffs are still
  allowed — keep their faces camera-visible.
- **Change material only across a genuine away-step, and only as a BIG
  region** — never a 1-cell stripe. (Usually unnecessary: camera-facing terrain
  + always-different water boundaries cover it.)
- **The wall-material recolour is a LAST RESORT** (maintainer: "it looks ugly —
  only use this trick when absolutely needed"). A same-material toward-camera
  up-step is FINE — leave it — when the step is legible anyway:
  (a) a **CONTRASTING cliff face marks THIS SAME EDGE** — within ≤2 cells
  laterally along the lip's own boundary, a cell touching it draws a ≥2-level
  toward-camera face whose material differs from the seam's ground. Two paid
  traps: a cliff merely NEARBY (a staircase beside the seam, another boundary)
  does NOT count — it says "there is elevation around here", not where THIS
  edge runs; and a SAME-material face is itself camouflage — contrast is
  required. Or (b) the ground the player **actually sees behind the seam
  differs** from the high top — for a tall step that visible ground is several
  ROWS up-screen (15px/row vs 16px/level), NOT the grid-adjacent tile.
  Recolour ONLY lips failing both — and the stripe material must ALSO differ
  from any bridge DECK rendering nearby in screen space (a low deck a few
  cells up-screen lands on the same pixels as a high rim; stone-on-stone-deck
  was unreadable).
- **Ground types never change "this fast" (maintainer).** A ground tile can
  carry a transition to only ONE partner, so a tile may border at most one
  foreign ground type — no 1-tile slivers, no three-ground junction points.
  Enforced on the_island2 as GENERATOR RULES (never spot edits):
  - **Containment collars** (`_materials`): accents live strictly INSIDE their
    parent — ice inside snow, obsidian inside snow/stone (≥2 from ice), sand
    collared off rock by grass — so pure-terrain pairs meet two-by-two.
  - **Road padding**: dirt never comes within 2 cells of sand — a HARD routing
    keep-out with soft fallback (`_road_path`/`_road_attach` two-pass), the
    widen margin, a paint skip, and a build assert. The buffer between road and
    beach is always ≥2 GRASS cells (maintainer: extra space stays grass —
    never stone).
  - **Infrastructure is an overlay, not terrain**: dirt roads/fords and the
    local-ground stair strips (`_ascent`) are exempt subjects AND don't count
    as transition partners — where a line crosses a biome boundary some tile
    must see both sides, and the line cell is the least-bad place.
  - **Only near-level neighbours pair** (|Δlevel|≤1): across a cliff the wall
    face renders between the tops, so no transition is needed.
  - **Fewer stripes**: lips within 2 of sand/water (the coastline marks the
    drop) or beside a dirt road (a contrasting line on the edge) are legible
    and never striped; stripes are wall materials only, never local-ground
    reuse.
  - **No FALL-IN WELLS** (`_fill_water_traps`; maintainer: "a hole you fall
    down in and get stuck"): a non-ocean water pocket with NO swim-out — no
    shore within 1 level of its surface — is filled to its low rim. Runs AFTER
    the guarantee loop (its antitone raises can seal a lagoon's walk-in shore
    into a well, so the swim-out test is only meaningful once levels are
    final); the designed gorge (`_gorge_cells`) is exempt.
  - **WIDEN thin ridges — don't remove them** (`_widen_hills` +
    `_dechunk_maze`; maintainer, emphatically: "the hill I stand on looks
    ridiculous — WIDEN it, make it look like real landscape", NOT dissolve). A
    raised low blob (level < 14, no Trollstigen cell) that is thin (bbox
    min-dim ≤ 2) and stands ≥ 3 above a neighbour is an absurd 1-cell levee.
    Grow it along its THIN axis until `widen_to` (4) cells wide, TOWARD the
    camera — the only occlusion-safe direction (the new front drops toward the
    camera; growing up-screen would bury a hidden back-wall). Growth targets,
    in order: lower land / beach toward the camera; else the flanking WATER
    (narrow the channel — but NEVER the open ocean, `_ocean_cells`). Widened
    cells are plain terrain (NOT reserved) so `_beach_access` can still cut a
    ramp to any beach the new headland walls off. `_dechunk_maze` keeps raw
    relief chunky. Trollstigen ramps are left alone (their legs descend toward
    the camera and must not be buried). Runs before `_place_bridges` so no bank
    depends on a moved cell; the guarantee loop then fixes traps/occlusion.
  - `_material_slivers` (the detector) must be EMPTY at build time —
    `_fix_material_slivers` flips stragglers to the dominant adjacent terrain
    (never to dirt, never to stone at the shore) in a joint fixpoint with
    `_lip_cover`.
- **A road is full-width and solid, or it doesn't exist** (maintainer: "if you
  can't make the road as wide as it needs to be — don't make a road at that
  location at all"). Roads PAVE **grass only**: dirt over stone/snow/obsidian
  renders as patchy eroded stains in this tileset, so a mountain-cap road never
  reads as the solid lowland band however wide it is painted — the mountain is
  traversed by its stairs and open benches, with road spurs to every staircase
  foot at the base. Where roads DO exist, a WIDTH NORMALIZER enforces ≥3
  strands on every linear run (screen-vertical runs keep their approved
  2-column elbow form; 1-cell gaps to parallel strands are never bridged so
  close legs don't merge) — a uniform look needs a uniform floor, not the
  opportunistic widen's local luck.
- **Fog exception:** a drop of **more than 10 levels** is separated by the
  game's fog, so the same material MAY be reused across it.

Enforced in code (`pipeline/autotile.py`):

- **`camera_monotone(level, mat)`** — reshapes land so no cell is lower than
  its toward-camera neighbours: every slope camera-facing, every up-screen
  coast a sea-cliff. Run it **after `flatten_shores`** (which beaches all
  coasts) so only the near-shore beaches survive.
- **`occlusion_violations(mat, level)`** — every remaining hidden same-material
  lip (drops >10 ignored as fog-safe). the_island2 filters this through
  `Island2._lip_needed` (the legibility test above) and asserts the illegible
  subset (`_bad_lips`) empty — legible same-material lips are allowed and
  preferred. `pipeline/islandworld.py` (`the_island`) asserts the raw list
  empty. (`demo_lost` is the older grass island, kept as-is and NOT under this
  rule — don't use it as the pattern.)

## The Cave — the carve-out protocol

Caves/dungeons live in the SAME seamless world, no transitions: the deck idea
INVERTED. `Island2._carve_cave()` (the LAST pass; fully transactional) hollows
the east massif into a Diablo-style dungeon — rooms stamped at clearance maxima
of the massif interior, straight turn-penalised corridors, ONE pinned doorway
(`CAVE_MOUTH`, the maintainer's encircled spot at the south wall foot, grid
(142,67)±diagonal). The **floor becomes the base terrain** (level 0, dark
`black_mountain` tops — the cell `mat` is KEPT so roof walkers keep
snow-on-snow speed/sound) and the mountain above becomes `kind:"cave"` roof
decks carrying the pre-carve surface **verbatim** (per-cell top/mirror; deck
level/mat = old surface; `thickness = level - CAVE_CEIL` so the slab underside
is the ceiling and the missing wall faces at the rim ARE the visible dark
door). Spec: `spec/WORLD_FORMAT.md` → Caves; game physics: a deck slab is
SOLID (`games2/shared` `deckBot` — nothing falls through a roof).

Iterate on the cave from IN-CAVE screenshots (the game prints world coords
under the avatar) by changing `_carve_cave`/`CAVE_*` **rules** — never spot
edits. Risk-free for the mountain top because `build()` proves:

- **byte-identity**: a full pre/post-carve render diff must be EMPTY outside
  the doorway window (`_cave_check_render` — "the cave is never rendered
  outside the mountain");
- **surface laws**: the whole legacy assert battery re-runs on the pre-carve
  SURFACE VIEW (the roof decks preserve that surface cell-for-cell,
  engine-checked as identical walk levels);
- **CONTAINMENT (the redraw reminder)**: every cave cell ≥3 cells deep inside
  the INDEPENDENTLY recomputed massif with ≥14 levels of rock above the floor,
  exactly one mouth (the pinned cells), ≥6 levels of headroom, every floor cell
  reachable from the mouth, footprint ≥55% of the massif. If the mountain
  changes shape under the cave, the build FAILS with "CAVE OUTSIDE THE
  MOUNTAIN — redraw the cave": update the layout first.

## Monster spawn zones — `spawns.json` (`pixel-maps2/spawns@1`)

Full spec + all constants: `spec/SPAWNS.md`. maps2 places the monsters: every
world ships polygon zones `{monster, area, elev, num}`. Zones are DERIVED by
habitat rules in `pipeline/spawns.py` and re-derived AUTOMATICALLY whenever a
world is written (`save_world` calls `spawns.refresh`), so a terrain edit can
never leave stale zones; every zone is validated (simple polygon, ≥num
standable cells at the claimed elevation) before writing. The game consumes
them live (`games2/shared/src/monsters.ts`, roaming in `WorldRoom.ts`).

The laws (details + provenance in the spec):

- **No monster on water** — guaranteed by GEOMETRY: no polygon contains a
  water-surfaced cell (`dry_mask` builds dry, `validate_zone` re-asserts for
  every world, hand-written included). No water habitat exists — the old
  `water` habitat is `shore`, the land band within 4 cells of water.
- **Nothing piles up** — surface density `Σ num/|zone cells|` ≤
  `MAX_DENSITY = 0.05` (one per 20 cells), keyed by (x, y, LEVEL) — the cave
  floor and the rock above are different floors of one building. Enclosed
  surfaces (feet below a slab underside) carry `CAVE_DENSITY_F (0.4)` of that.
  `assert_density()` gates the build.
- **Difficulty scales with walk-distance from the arrival point** —
  `keep_out = SAFE_R(6) + (level-1)·LVL_STEP(5) + AGGRO_PUSH(14) if it hunts`,
  with level/aggro from the GAME's own tuning (`live/tuning/monsters.json`).
  Nothing at all within SAFE_R; too-close cells are forbidden ground the
  polygon cannot contain.
- **Population is budgeted per TYPE** so the roster stays balanced (world
  budget = land/`WORLD_CELLS_PER_MONSTER` (205 — the ONE busy-ness dial; 137→
  205 = the maintainer's "25% fewer"), split evenly across resident types,
  spread over each type's zones by area, capped by room).
- **`the_island2` MUST contain every roster monster** (build-asserted, with
  habitat fallback). Currently: 99 monsters, 24 types, 2-5 of each.
- **Feature-test maps carry NO monsters** (`prop_demo`, `trans_demo`,
  `glow_test`, `occlusion_test`, `house_demo`: explicit `zones: []`).
  `monster_demo` is the showcase (one 5×5 habitat pad per monster,
  `pipeline/monsterdemo.py`) and the one world the crowding law does not bind.

## Named places — `places.json` (`pixel-maps2/places@2`)

Full spec: `spec/PLACES.md`. A place is a named REGION, indoors or out —
`{id, name, kind (house|cave|summit), indoor, elev, anchor, cells}`; **cell →
place is one lookup**. `id` is the event key and never changes; `name` is
display text lore may rewrite. `elev` is THE STACK: `the_cave` (elev 0) and
`mountain_top` (16-40) share the cave's whole footprint — a consumer resolves
(cell, the surface you stand on), i.e. `Player.elev`; two places may share
cells, never cells AND an overlapping band (build-asserted).

Places are DERIVED, names LOOKED UP: `roof`/`cave` decks group into 8-connected
footprints (`bridge` excluded — a span is a roof over open air, outdoors), each
group gets a ROLE from world.json alone (`house-1` = nearest the arrival
point), and `places.NAMES[world][role]` supplies the name — keying on role,
never a coordinate, is what makes a name survive the terrain moving.
Re-derived by `save_world`. **Canon wins where canon has a name**
(`lore/canon/CONSTRAINTS.md` §5): The Stone House and The Cave are adopted
verbatim; The Meadow House is the one plain-descriptive addition.
`mountain_top` is MEASURED, not chosen — snow line down to the massif's foot
(7,309 cells, elev 16-40 on the_island2; derivation + rejected statistics in
the spec). Gate: `python maps2/pipeline/places.py --check` (every roofed cell
named; every named cell still as named; no overlapping-band double booking).
Consumers are live: the client's place lookup and the composer's per-id music
beds.

## NPCs — `npcs.json` (`pixel-maps2/npcs@1`)

Full spec (fields, cast, anchors, all ten laws): `spec/NPCS.md`. maps2 owns
WHERE people stand; **characters2 owns WHO they are** — referenced by folder id
(`characters2/npcs/`), restating nothing. Two types (the maintainer's):
**AMBIENT** and **MERCHANT**. A merchant **must look like one**:
`MERCHANT_LOOK` in `pipeline/npcs.py` is the single hand-curated table in the
placement system, deliberately — "looks like a merchant" is an ART judgement no
terrain rule can make (the `trader` role is not sufficient); the seven eligible
characters cover all seven `items/` TYPE tags, and `wares` is validated against
`items/viewer_data.json`.

Placement is DERIVED from world.json landmarks (arrival, doorway, cave mouth,
bridge end, road junction, shore) and re-derived on every world write. The laws
— dry standable ground, walk-reachable from spawn with the game's own step
rule, never in a chokepoint / doorway (grid lane AND screen strip) / the spawn
campfire (drawn by the game, not in world.json — the first cast stood a
commoner in the flames), never camera-hidden, never screen-space overlapping,
never crowding the arrival, never indoors, every reference resolving (`name`
asserted equal to characters2) — are all build-asserted.
Gate: `python maps2/pipeline/npcs.py --check`. Consumers are live: the client
fetches `npcs.json` per world; NPC art ships via
`games2/scripts/build-npcs-manifest.mjs`.

## Image format — lossless WebP (project default)

Every image maps2 ships is **lossless WebP**. Measured on this domain:
28.1 MB → 17.5 MB (38% off, 35/35 files, none rejected). `pipeline/to_webp.py`
is the tool — it PROVES each file bit-exact (decodes back and compares RGBA
including alpha) and refuses to delete a PNG whose WebP didn't round-trip or
would be bigger. `lossless=True, method=4, exact=True` is not optional:
Pillow's default WebP encode is LOSSY and silently resamples pixel art.
Convert at the SOURCE and commit — never in the Dockerfile (that re-runs every
deploy and busts the layer cache).

The pipeline writes WebP everywhere; a maps3 world bakes no art paths at all (a
ground NAME per cell), so a tiles publish never repoints anything here.

## Geometry (tiles3)

- top diamond **28px** tall × 64px wide (grid steps DX=32, DY=14)
- one storey = **15px** of stacking pitch (`shared ISO_GEOMETRY_MAPS3`); the
  art's own wall band is 17px (`tiles/docs/GEOMETRY.md`)

## Pipeline (`pipeline/`)

- `world3.py` / `world3grow.py` — the_game's builder (pixel-maps3: a ground
  NAME per cell, decks, scenery placements; see `spec/WORLD3.md`).
- `render3.py` — the tiles3 reference renderer (window / overview / minimap;
  the game's `tiles3.ts` resolver is parity-gated against it).
- `spawns.py` / `npcs.py` / `places.py` — the sidecar derivers + `--check` gates.
- `sceneryscale.py` — the size the GAME draws scenery at.

RETIRED 2026-09-09: the world@1/@2 pipeline (`tiles2lib`, `render2`,
`autotile`, `worldio`, `build`, `minimaps`, `cartomap`, `verify`, `to_webp` and
the eleven world builders) with the tiles2 domain it painted — history in git.

## Worlds

- `worlds3/the_game/` (`world3.py`) — **the game**, the only world (maintainer
  2026-09-09: "We will commit 100% to the new tiles3 system and the new map
  from here on").

RETIRED 2026-09-09: `worlds/` — the_island2, the_island, demo_lost, demo_isle,
ring_test, monster_demo, prop_demo, trans_demo, glow_test, occlusion_test,
house_demo — history in git.

