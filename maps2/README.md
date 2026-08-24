# maps2 — worlds for the game (Map2 agent)

World assembler. Consumes **`tiles2/`** (named ground types, first-class
transitions) and produces **worlds** under `maps2/worlds/<name>/`: `world.json`
plus the sidecars `spawns.json`, `npcs.json`, `places.json` and the map images
`minimap.webp` + `map_base.webp`. The format contracts the game parses against
live in `spec/`: `WORLD_FORMAT.md`, `SPAWNS.md`, `NPCS.md`, `PLACES.md`.

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

Better still: when adopting a brand-new tiles2 material, ask tiles2 to classify
it at creation (`python coordination/board.py post maps2 --to tiles2 --text
"classify <cat> please"`) so the gate never goes red — but don't block on them.

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

The pipeline writes WebP everywhere and **reads tiles2 art in either format**:
`tiles2lib._tiles()` globs `tile_*.png` AND `tile_*.webp`, sorted by STEM so a
half-converted sheet can't reorder. `world.json` bakes LITERAL tiles2 paths;
when tiles2 flips a sheet, run
**`python maps2/pipeline/to_webp.py --paths --apply`** — it repoints every
baked path whose `.webp` exists on disk. Only the `paths` table changes (grids,
decks, props untouched), so terrain is bit-identical and no world regenerates.

## Geometry (tiles2)

- top diamond **30px** tall × 64px wide (grid steps DX=32, DY=15)
- one elevation level = **16px** of vertical face
- terraced cliffs stack a type's `base` tile 16px per level (pixel-perfect per
  `tiles2/docs/ELEVATION.md`)

## Pipeline (`pipeline/`)

- `tiles2lib.py` — loads tiles2; per-type target colour; analyses every
  transition tile from pixels into **composition** (material mix) +
  **orientation** (screen-space direction the split faces). Cached to
  `config/tiles2_analysis.json`.
- `worldio.py` — the world.json format (`save_world`/`load_world`; save
  re-derives all sidecars).
- `autotile.py` — the transition auto-tiler (one-sided feather: the
  lower-priority material blends into the higher; per cell, pick the transition
  tile whose measured composition and orientation match the geometry) +
  `camera_monotone` / `occlusion_violations`.
- `render2.py` — isometric renderer (window / overview / minimap).
- `minimaps.py` / `cartomap.py` — the two map images (see above).
- `spawns.py` / `npcs.py` / `places.py` — the sidecar derivers + `--check`
  gates.
- `to_webp.py` — WebP converter + baked-path repointer.
- `verify.py` — the drift catcher: "another domain changed its art — does maps2
  need to re-export anything?" in one command.
- `build.py` — `python maps2/pipeline/build.py <world>`; world builders:
  `ringworld.py`, `islandworld.py`, `islandworld2.py`, `lostworld.py`,
  `demoworld.py` (demo_isle), `propdemo.py`, `transdemo.py`, `glowdemo.py`,
  `occlusionworld.py`, `housedemo.py`, `monsterdemo.py`.

## Worlds

- `worlds/the_island2/` (`islandworld2.py`) — **the production island** (248²,
  max level 40); design laws below.
- `worlds/the_island/` (`islandworld.py`) — the previous production island:
  organic warped coastline, camera-facing gated cliffs, multi-peak mountain
  (max 30), gorge with stone bridges. Preserved unchanged.
- `worlds/demo_lost/` — the older grass island; preserved unchanged, exempt
  from the occlusion rule — not the pattern.
- `worlds/demo_isle/` — small island demo.
- `worlds/ring_test/` — the transition-evaluation donut: `clear_water` centre
  (spawn), 5 pizza slices of the pure grounds, elevation rising outward. See
  its `INSIGHTS.md` for what the transitions taught us.
- `worlds/monster_demo/` — one 5×5 habitat pad per roster monster on a stone
  courtyard.
- Feature-test maps (one rendering feature each, no monsters/NPCs):
  `prop_demo` (tile props), `trans_demo` (auto-tiler rows), `glow_test`
  (emissive tiles), `occlusion_test` (world@2 decks reference),
  `house_demo` (buildings with real floor plans; maintainer: rooms must be
  bigger and "real house looking", not huts).

### the_island2 design laws (all hard-asserted)

Pairs an antitone **mountain** (upper) with an *A Link to the Past*-style
relief **maze** (lower). The maze can't be antitone (a strictly-antitone field
makes one connected lowest sheet — it could never separate two equal-level
floors laterally), so it uses genuine relief kept legible by the
only-where-needed wall-material rule: `_lip_cover` recolours a same-material
toward-camera up-step's higher rim to a wall material (stone/obsidian) ONLY
when `_lip_needed` says it would otherwise be illegible; `_bad_lips` (the
illegible subset) is the must-be-empty gate (Δ>10 is fog-exempt, so tier-12
keeps its grass top).

- **Mountain**: TERRACED onto flat benches `{16,20,24,28,32,36,40}` (Δ4
  cliffs, `camera_monotone` masked to it) — ~10 sharp varied-height peaks with
  deep saddles + camera-fanning grooves for a jagged skyline (max 40, not a
  smooth pyramid), a carved valley/tarn so it undulates up *and* down; rock
  with snowy/ice/obsidian peaks. Floor 16 sits a gated Δ4 above the maze cap
  12.
- **Maze** tiers `{0,4,12}` — deltas mostly Δ4, sometimes Δ8, rarely Δ12
  (dramatic cliffs, no timid Δ2); winding cliff/water corridors.
- **The TROLLSTIGEN** (`_foot_switchback`; the maintainer's own design after
  every axis-aligned attempt failed — don't retry those): the descent down the
  sheer toe is a wall-hugging stack of MIRRORED slope legs. His rules,
  verbatim: legs run ALONG the cliff; at a turn you MIRROR the slope and
  continue down in both Z and Y — the new leg's top aligns with the old leg's
  bottom (Z) and draws IN FRONT of it (Y) — so the previous leg is the next
  leg's inner wall and *you can only fall down outwards*; give up "perfect
  straight line" (legs follow the wall contour); vary road width where needed;
  hairpin corners are bigger ("two cars can meet").
  THE GEOMETRY INSIGHT that made it work: a screen-horizontal wall is a
  GRID-DIAGONAL line, so the structure lives on the skew lattice `p=x+y`
  (screen depth), `q=x−y` (screen horizontal). A leg = a zip-band of `wleg`
  consecutive p-layers; stacking outward = +p; the stand-off `o(q)` is the
  1-Lipschitz envelope of the rim (bands shift ≤1 p-layer per column; the
  innermost leg WIDENS back to the wall where it recedes). Levels are
  scheduled on the diagonal `t = dir·q − p`: constant-t lines run along
  `(p+1, q+dir)`, so every 1-level step edge FACES the camera — a
  same-material occluded up-step is impossible by construction — and leg k's
  minimum equals leg k+1's maximum, so the stack is monotone toward the
  camera. HARD-ASSERTED **hug invariant**: no structure cell may drop ≥2 on an
  up-screen side (hairpin noses exempt — they hang free like real switchback
  noses). The PRIMARY sits at the maintainer's chosen window
  (`TROLL_SITE_FRAC`, his blue marks — a design constant like the bridge
  fracs); `_carve_connector` must never slice a Trollstigen (guard in code —
  it once flattened carved legs via `_fill_traps` after slicing them apart).
- **The Trollstigen IS the road, and the mountain road is STONE** (maintainer:
  "should have been in stone and not dirt"): the trunk spawn→summit routes
  through the primary's foot→entry via-points; on the structure the ribbon is
  painted `stone_mountain` (linework-exempt, sand-guarded, band-column
  completion for a solid ribbon), off it the lowland road stays dirt. The
  SECONDARY toe stays a pure grass trail (maintainer: "you fucking nailed
  it" — no paint, no foot spur).
- **EVERY bench climb is a mini-Trollstigen** (maintainer: "why do you keep
  drawing straight staircases when we have a better system"): `_climb_hugging`
  carves a 2-leg mirrored mini (D=4, dP=2, same carver via `mini=True` —
  apron = the next bench down, uniform-floor window, smaller
  `TROLL_QMIN_MINI`) at the far lateral end of each bench; the straight
  `_carve_connector` survives ONLY as last-resort fallback so the summit can
  never disconnect (`_troll_fallbacks` counts uses — keep ~0-1). A HUG-REPAIR
  sweep fills wall notches (groove cracks, jogged rims) to road level as grass
  shoulder so the only-outward-falls law holds against any wall shape.
- **Material policy — stairs KEEP the local ground; dirt = road surface**
  (maintainer: "Don't always use stone. Use the ground type that is already
  present at that location"): carved stairs/ramps (`self._ascent`) keep
  whatever ground they cut through — their step faces point at the camera, so
  they read in any material. Bridge DECKS follow the same law (maintainer:
  "create it in the same ground type, not always switch"): a deck wears its
  BANKS' ground, dirt only where the road runs onto the span; laying-time mats
  are provisional and `_resolve_deck_mats`
  re-reads every deck's final banks (majority ground among adjacent walkable
  land within 1 level) just before `_paint`. Bridges are **1-LEVEL slabs**
  (maintainer: "draw all bridges 1 level in height… remove the bottom tile so
  it still lines up with the ground"): deck `thickness` 0 — the top tile's
  baked cube face IS the one visible level; walk surface flush with the banks.
  Enforced in the same finalize pass so it covers every bridge creator,
  inherited ones included (the game's parser accepts thickness 0). The flat
  road surface is `lightdark_dirt`; the road may repaint bench tops but never
  an ascent cell — EXCEPT Trollstigen cells, which are grass and ARE the road.
- **8-direction dirt ROADS** (`_dirt_roads`): organic meandering branching
  network in all 8 SCREEN directions — the router (`_road_graph_bfs`) adds
  grid-diagonal moves (rendering screen-vertical/-horizontal) on flat Δ0 land,
  each gated by a same-level **elbow** cell so the painted road stays
  4-connected-walkable; the √2 diagonal weight beats the 2.0 cardinal zigzag.
  Held a margin off beach/water and the mountain foot, biased to corridor
  centres via the cached `_road_cost_field`; trunk spawn→summit +
  landmark/stair-foot spurs forking at Y-junctions.
- **The MOUNTAIN GORGE** (`_mtn_gorge`/`_gorge_channel`): a water channel
  carved to level 0 straight through the massif. A level-0 slot in a 40-tall
  massif is invisible if it runs N–S (the tall east wall sits toward-camera of
  it), so it runs along the grid **(1,1) diagonal** = straight down the screen
  toward the camera, then keeps flowing through the low toe/maze (`level <
  16`) to the lowland — every water cell's toward-camera neighbour is also
  water, the near wall vanishes, and the level-0 surface reads the whole way.
  Crossed by a deliberate HIGH (`≥16`) stone bridge (`_bridge_over_gorge`).
- **ONE RIVER** (maintainer: "The small one should be removed"). `_maze_river`
  (a second, raised-valley channel with five crossings) is **deleted**, with
  its bridges — a crossing exists because there is something to cross. The
  gorge is the island's river. Don't re-add.
- **Multi-level water** (`_ponds`/`_tarn`/`_sunken_lagoon`): flush lakes at
  maze tiers `{4,12}` and benches `{20,24}`, a flush alpine tarn, and a sunken
  walk-in lagoon on the snow (`LAGOON_SITES`, water 2 levels down inside a Δ1
  walkable rim) — all transactional so they never seal a region.
- **THE HEADLAND RULE** (`_bridge_headlands`; maintainer: the hill you climb
  to reach the big bridge "need some area to make sense"). A bridge landing is
  a LANDFORM, not whatever ground survived beside the water. Each end of every
  **lowland** crossing needs ≥ `HEADLAND_MIN` (160) cells of ground at deck
  level within `HEADLAND_R` (12) of the landing, **≥ `HEADLAND_DIM` (9) across
  BOTH axes** — the clause that bites: a long thin ledge passes any pure area
  test (`_widen_hills` can't help — it only touches bbox min-dim ≤2 and stops
  at 4). Grown nearest-cell-first (a rounded rise, never a tentacle along the
  bank), raising only land BELOW the deck — never water, never the massif,
  never a reserved cell — and `build()` asserts it. Mountain crossings exempt
  (their banks are terraced rock; reshaping breaks the antitone/terrace
  invariants).
- **…AND YOU HAVE TO BE ABLE TO WALK UP IT** (maintainer: "more and wider
  ways/paths to go get up on it"). Growing a landing without touching its rim
  makes a MESA. A **way up** is a run of rim cells within one level of the
  top; runs narrower than `HEADLAND_WAY_W` (4) are scrambles and count for
  nothing; a landing needs `HEADLAND_ACCESS` (12) rim cells of real ways (that
  single test lets a hill merging into the plain pass untouched while one
  notch fails). What's missing is cut as `HEADLAND_RAMPS` (3) separate
  staircases, `HEADLAND_RAMP_W` (5) wide, spread FARTHEST-APART-FIRST around
  the rim, only ever **toward the camera** so every new slope shows its faces.
  **Each lane starts at its OWN edge**: a hill boundary is ragged, and a ramp
  laid on one straight lateral line leaves lanes whose edge sits further in
  hanging a cell short — a staircase that starts nowhere (shipped once; the
  access assert caught it at 11 of 12).
- **Bigger beaches** + a wide **ocean margin** (`M=24`, `n=248`; island inset
  via `_coastline`, `nd` stays 200). `build()` asserts no land on the border.
  NOTE: a finite frame only pushes the edge out of view; never showing an
  "end of world" is the **game client's** job (clamp the camera or fill
  out-of-bounds with `clear_water`), not the generator's.

Reachability is **prop-aware** (props set `collision=1`).
