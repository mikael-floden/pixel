# maps2 — worlds for the new game (Map2 agent)

Second-generation world assembler. Consumes **`tiles2/`** (the new tile system
with specifically-named ground types and first-class transitions) and produces
**worlds** under `maps2/worlds/<name>/`. Built to support **several** maps —
test maps for evaluating tiles + (eventually) the one production world.

## Releasing — deploy YOURSELF, always push to `main`

**`main` is the release channel.** The game reads worlds from the repo at
runtime and every push to `main` under `maps2/**` auto-deploys nangijala.online
(`.github/workflows/nangijala-deploy.yml`). Work on a side branch is invisible
to the game — a map change is only "delivered" when it's on `main` (learned the
hard way 2026-07-22: v6 sat on a session branch while the maintainer waited).

The deploy ships only if games2's `test` job is green. For a maps2 push the only
gate that normally trips is **`check-surfaces`**: a world uses a tile category
with no gameplay classification, so prod silently stays on the previous map.
**Standing authorisation from the game agent (2026-07-22, runbook
`games2/SURFACES.md`, confirmed on the coordination board): fix it yourself —
never wait.** The recipe:

1. `cd games2 && npx tsx scripts/check-surfaces.mjs` — prints the flagged
   categories with a ready-to-paste proposal (same output as the red CI log).
2. Add one line per category to `SURFACES` in **`games2/shared/src/surfaces.ts`**
   — the ONLY games2 file we may edit. You decide the shape: standable ground
   (`ground(speed, "sound")`), swimmable water, `solid` object, or
   `stairs: true` ramp. Append near similar entries, don't reflow.
3. `cd games2 && npm ci && npm run typecheck && npm test` — must be GREEN.
   **Never push red** — a red push blocks every domain's deploy.
4. Commit + push to `main` (rebase on reject). That re-triggers the deploy and
   prod rolls forward with the world + the entry together.
5. Conflict in `surfaces.ts`? Keep both sides' new entries (it's a plain map).

Even better: when adopting a brand-new tiles2 material, ask tiles2 to classify
it at creation (`python coordination/board.py post maps2 --to tiles2 --text
"classify <cat> please"`) so the gate never goes red — but don't block on them.

If a **different** gate fails (navigation sim, `check-deckwalk`, a unit test),
that's a real defect in the map (walled-in spawn, deck with no entry, …): fix it
HERE in maps2 — do not touch anything else under `games2/`.

**After EVERY deploy, send the maintainer the full-map image** (maintainer
2026-07-22: "always do that after you have deployed, so I can see the entire
map state directly"): once the deploy run is green, deliver
`worlds/the_island2/preview.png` (the committed full-map render) — don't wait
to be asked.

## Elevation & occlusion rules — ALWAYS apply when shaping terrain

Read this every time, the same way you always run the transition auto-tiler.

The camera looks from the **south**, so a tile toward the camera (larger `x+y`)
draws **over** whatever is up-screen behind it. If a player stands with **higher
ground on their camera-facing (`+x`/`+y`) side**, that ground swallows their legs —
and its cliff face points *away* from the camera (invisible), so with the **same
material** on both sides it reads as a rendering bug, not a hill. **Never ship
that.** (It's fine where the hill's face IS visible — a rise descending toward the
camera — so the fix is not "change material at every level".)

**The rule, one line:** land elevation must never step **up toward the camera**
with the same material. Equivalently — make terrain **camera-facing**: high
up-screen, sloping **down toward the camera**, so every cliff face is visible.

Consequences to honour:

- **Slopes face the camera.** A rise whose face is visible (it descends toward the
  camera) is fine with one material over a big area. The forbidden case is the
  far/back side of a hill *descending away from the camera*.
- **Up-screen coasts are sheer sea-cliffs, not beaches.** The top of the map drops
  abruptly to water so the player falls off / can't walk behind it (à la Zelda
  *A Link to the Past*'s northern mountains). Beaches live only on the **near
  (camera) shore.** This also limits where walk-behind valleys can occur — which is
  fine, valleys/cliffs are still allowed, just make their faces camera-visible.
- **Change material only across a genuine away-step, and only as a BIG region** —
  the whole far side becomes a different type, **never a 1-cell stripe.** (Usually
  unnecessary: camera-facing terrain + always-different water boundaries cover it.)
- **The wall-material recolour is a LAST RESORT** (maintainer 2026-07-22: "it looks
  ugly — only use this trick when absolutely needed"). A same-material toward-camera
  up-step is FINE — leave it — when the elevation change is legible anyway:
  (a) a **CONTRASTING cliff face marks THIS SAME EDGE** — walking the lip's own
  boundary ≤2 cells laterally, a cell touching it draws a ≥2-level toward-camera
  face whose material differs from the seam's ground (a corner's grey wall, the
  stacked stone tier below it). Two traps learned the hard way: a cliff that is
  merely NEARBY (a staircase beside the seam, another boundary) does NOT count —
  it says "there is elevation around here", not where THIS edge runs; and a
  SAME-material face is itself camouflage (a grass wall marking a grass seam
  reveals nothing) — contrast is required. Or (b) the ground the player
  **actually sees behind the seam differs** from the high top — and for a tall
  step that visible ground is several ROWS up-screen (15px/row vs 16px/level),
  NOT the grid-adjacent tile: a rock band, dirt road or water back there makes
  the edge read even when the adjacent cell is grass. Recolour ONLY the lips that
  fail both — and the stripe material must ALSO differ from any bridge DECK
  rendering nearby (screen-space test: a low deck a few cells up-screen lands on
  the same pixels as a high rim, and stone-on-stone-deck was unreadable).
- **Ground types never change "this fast" (maintainer 2026-07-22).** A ground tile can
  carry a transition to only ONE partner, so a tile may border at most one foreign ground
  type — no 1-tile slivers (grass squeezed between dirt and sand), no three-ground junction
  points. How the_island2 enforces it, all as GENERATOR RULES (never spot edits):
  - **Containment collars** (`_materials`): accents live strictly INSIDE their parent —
    ice inside snow, obsidian inside snow/stone (≥2 from ice), sand collared off rock by
    grass — so pure-terrain pairs always meet two-by-two.
  - **Road padding**: dirt never comes within 2 cells of sand — a HARD routing keep-out
    with soft fallback (`_road_path`/`_road_attach` two-pass), the widen margin, a paint
    skip, and a build assert. The buffer between a road and a beach is always ≥2 GRASS
    cells (maintainer: extra space stays grass — never stone).
  - **Infrastructure is an overlay, not terrain**: dirt roads/fords and the local-ground
    stair strips (`_ascent`) are exempt subjects AND don't count as transition partners —
    where a line crosses a biome boundary some tile must see both sides, and the line cell
    is the least-bad place for it.
  - **Only near-level neighbours pair** (|Δlevel|≤1): across a cliff the wall face renders
    between the tops, so no transition is needed.
  - **Fewer stripes**: lips within 2 of sand/water (the coastline marks the drop — rims by
    the beach stay grass) or beside a dirt road (a contrasting line on the edge) are
    legible and never striped; stripes are wall materials only, never local-ground reuse.
  - `_material_slivers` (the detector) must be EMPTY at build time — `_fix_material_slivers`
    repairs stragglers by flipping them to the dominant adjacent terrain (never to dirt,
    never to stone at the shore) in a joint fixpoint with `_lip_cover`.
- **A road is full-width and solid, or it doesn't exist** (maintainer 2026-07-22: "if you
  can't make the road as wide as it needs to be — don't make a road at that location at
  all"). Roads PAVE **grass only**: dirt over stone/snow/obsidian renders as patchy eroded
  stains in this tileset, so a mountain-cap road never feels like the solid lowland band
  no matter how many cells wide it is painted. The mountain is traversed by its stairs
  and open benches; road spurs still lead to every staircase foot at the base. Where
  roads DO exist, a WIDTH NORMALIZER enforces a minimum of 3 strands on every linear run
  (screen-vertical runs keep their approved 2-column elbow form; 1-cell gaps to parallel
  strands are never bridged so close legs don't merge) — a uniform look needs a uniform
  floor, not the opportunistic widen's local luck.
- **Fog exception:** a drop of **more than 10 levels** is separated by the game's
  fog, so the same material MAY be reused across it (an alternative to changing
  type — just make sure the z-distance is >10 and let the fog do the work).

Enforce it in code (`pipeline/autotile.py`):

- **`camera_monotone(level, mat)`** — reshapes land so no cell is lower than its
  toward-camera neighbours: every slope becomes camera-facing and every up-screen
  coast becomes a sea-cliff. Run it **after `flatten_shores`** (which beaches all
  coasts) so only the near-shore beaches survive.
- **`occlusion_violations(mat, level)`** — returns every remaining hidden
  same-material lip (drops >10 ignored as fog-safe). the_island2 filters this
  through `Island2._lip_needed` (the legibility test above) and asserts the
  **illegible** subset (`_bad_lips`) is empty — legible same-material lips are
  allowed and preferred. `pipeline/islandworld.py` (`the_island`) still asserts
  the raw list empty.
  (`demo_lost` is the *older* grass island, kept as-is and NOT under this rule —
  don't use it as the pattern.)

## Geometry (tiles2)

- top diamond **30px** tall × 64px wide (grid steps DX=32, DY=15)
- one elevation level = **16px** of vertical face
- terraced cliffs are built by stacking a type's `base` tile 16px per level
  (pixel-perfect per `tiles2/docs/ELEVATION.md`)

## Pipeline (`pipeline/`)

- `tiles2lib.py` — loads tiles2; per-type target colour; analyses every
  transition tile from pixels into **composition** (material mix) + **orientation**
  (screen-space direction the split faces). Cached to `config/tiles2_analysis.json`.
- `ringworld.py` — the ring/donut test-map generator + the transition
  **auto-tiler** (one-sided feather: the lower-priority material blends into the
  higher one; per cell we pick the transition tile whose measured composition and
  orientation match the geometry, so borders are seamless and correctly faced).
- `render2.py` — isometric renderer (window / overview / minimap) for the new geometry.
- `build.py` — `python maps2/pipeline/build.py ring_test --n 160 --seed 7`.

## Worlds

- `worlds/ring_test/` — the transition-evaluation donut: `clear_water` centre
  (spawn), 5 pizza slices (saturated_grass, lightdark_dirt, stone_mountain,
  black_mountain, regular_snow), elevation rising outward. See `INSIGHTS.md` for
  what the transitions taught us for the real game.
- `worlds/the_island/` (`islandworld.py`) — the WIP production island: organic
  warped coastline, a camera-facing staircase of gated cliffs, a jagged multi-peak
  mountain (max level 30), a gorge with connected stone bridges. The reference for
  the elevation/occlusion rules above.
- `worlds/the_island2/` (`islandworld2.py`) — a ~2×-bigger island that pairs
  **two worlds**: an antitone **mountain** (upper) with a new *A Link to the Past*-style
  relief **maze** (lower). The maze can't be antitone (a strictly-antitone field only
  makes one connected lowest sheet, so it could never separate two equal-level floors
  laterally), so it uses genuine relief kept legible by the **only-where-needed
  wall-material rule**: `_lip_cover` recolours a same-material toward-camera up-step's
  higher rim to a wall material (stone/obsidian) ONLY when `_lip_needed` says the step
  would otherwise be illegible — no nearby visible cliff face AND the same ground
  visible behind the seam (several rows up-screen for a tall step). Legible lips stay
  natural grass; `_bad_lips` (the illegible subset) is the must-be-empty gate
  (a Δ>10 step is fog-exempt, so tier-12 keeps its grass top).
  Design details (all four hard-asserted):
  - **Mountain** is TERRACED onto flat benches `{16,20,24,28,32}` (Δ4 cliffs, `camera_monotone`
    masked to it), with varied peak heights + a carved valley/tarn so it climbs in steps and
    undulates up *and* down (mostly up); rock with snowy/ice/obsidian peaks. Floor 16 sits a
    gated Δ4 above the maze cap 12.
  - **Maze** tiers are `{0,4,12}` — deltas mostly Δ4, sometimes Δ8, rarely Δ12 (dramatic cliffs,
    no timid Δ2). Winding cliff/water corridors, a river + bridges.
  - **The TROLLSTIGEN** (`_foot_switchback`, rebuilt 2026-07-22 to the maintainer's own
    design after every axis-aligned attempt failed): the descent down the sheer toe is a
    wall-hugging stack of MIRRORED slope legs. His spec, verbatim rules: legs run ALONG the
    cliff; at a turn you MIRROR the slope and continue down in both Z and Y — the top of the
    new leg aligns with the bottom of the old (Z) and the new leg draws IN FRONT of the old
    (Y) — so the previous leg becomes the next leg's inner wall and *you can only fall down
    outwards*; give up "perfect straight line" (legs follow the wall contour); vary the road
    width where needed; hairpin corners are bigger ("two cars can meet").
    THE GEOMETRY INSIGHT that made it work: a screen-horizontal wall is a GRID-DIAGONAL
    line, so the whole structure lives on the skew lattice `p=x+y` (screen depth), `q=x−y`
    (screen horizontal). A leg = a zip-band of `wleg` consecutive p-layers; stacking
    outward = +p; the stand-off `o(q)` is the 1-Lipschitz envelope of the rim (bands shift
    ≤1 p-layer per column; the innermost leg WIDENS back to the wall where it recedes).
    Levels are scheduled on the diagonal `t = dir·q − p` (dir = the leg's ascend direction):
    constant-t lines run along `(p+1, q+dir)`, so every 1-level step edge FACES the camera —
    a same-material occluded up-step is impossible by construction — and leg k's minimum
    equals leg k+1's maximum, so the stack is monotone toward the camera. HARD-ASSERTED
    **hug invariant**: no structure cell may drop ≥2 on an up-screen side (hairpin noses
    exempt — they hang free like real switchback noses). The PRIMARY sits at the
    maintainer's chosen window (`TROLL_SITE_FRAC`, his blue marks — a design constant like
    the bridge fracs); `_carve_connector` must never slice a Trollstigen (guard in code —
    it once flattened carved legs via `_fill_traps` after slicing them apart).
  - **The Trollstigen IS the road, and the mountain road is STONE** (maintainer
    2026-07-22: "should have been in stone and not dirt"): the trunk spawn→summit is
    routed through the primary's foot→entry via-points; on the structure the ribbon is
    painted `stone_mountain` (linework-exempt, sand-guarded, band-column completion for a
    solid ribbon), off the structure the lowland road stays dirt. The SECONDARY toe stays
    a pure grass trail (maintainer: "you fucking nailed it" — no paint, no foot spur).
  - **EVERY bench climb is a mini-Trollstigen** (maintainer: "why do you keep drawing
    straight staircases when we have a better system"): `_climb_hugging` carves a
    2-leg mirrored mini (D=4, dP=2, same carver via `mini=True` — apron = the next bench
    down, uniform-floor window, smaller TROLL_QMIN_MINI) at the far lateral end of each
    bench; the straight `_carve_connector` survives ONLY as a last-resort fallback so the
    summit can never disconnect (`_troll_fallbacks` counts uses — keep it at ~0-1).
    A HUG-REPAIR sweep fills wall notches (groove cracks, jogged rims) to road level as
    grass shoulder so the only-outward-falls law holds against any wall shape.
  - **Material policy — stairs KEEP the local ground; dirt=road surface** (maintainer
    2026-07-22: "Don't always use stone. Use the ground type that is already present at that
    location"): carved stairs/ramps (`self._ascent`) keep whatever ground they cut through —
    snow steps on the snow benches, grass steps in the maze, stone only where the ground IS
    stone. Their step faces point at the camera, so they read in any material. Bridge DECKS
    follow the same law (maintainer 2026-07-22: "create it in the same ground type, not
    always switch"): a deck wears its BANKS' ground — snow spans on the snow benches, stone
    on the stone bench, grass over the maze river, dirt only where the road itself runs onto
    the span. Laying-time mats are provisional (the gorge crossings are laid before
    `_materials` paints the caps); `_resolve_deck_mats` re-reads every deck's final banks
    (majority ground among adjacent walkable land within 1 level) just before `_paint`.
    Bridges are **1-LEVEL slabs** (maintainer 2026-07-22: "draw all bridges 1 level in
    height... remove the bottom tile so it still lines up with the ground"): deck
    `thickness` 0 = the top tile alone, whose baked cube face IS the one visible level;
    the walk surface stays at deck level, flush with the banks. Enforced in the same
    finalize pass so it covers every bridge creator, inherited ones included (the game's
    `parseWorld` accepts thickness 0 since 2026-07-22 — it used to clamp to >=1).
    The flat road surface is `lightdark_dirt`; the road may repaint bench tops to
    dirt but never an ascent cell — EXCEPT Trollstigen cells, which are grass and ARE
    the road (see the Trollstigen bullet; rock/snow stairs stay unpainted).
  - **8-direction dirt ROADS** (`_dirt_roads`): an organic meandering, branching network that
    runs in all 8 SCREEN directions — the router (`_road_graph_bfs`) adds grid-diagonal moves
    (which render screen-vertical/horizontal) on flat Δ0 land, each gated by a same-level
    **elbow** cell so the painted road stays 4-connected-walkable; the √2 diagonal weight beats
    the 2.0 cardinal zigzag. Held a **margin** off beach/water and the mountain foot and biased
    to corridor **centres** via a cached `_road_cost_field` (distance fields); trunk
    spawn→summit + landmark/stair-foot spurs fork at Y-junctions.
  - **The MOUNTAIN GORGE that cuts the massif in two** (`_mtn_gorge`/`_gorge_channel`): a water
    channel carved to the LOWEST level (0) straight down the massif. A level-0 slot inside a 40-tall
    massif is invisible if it runs N–S (the tall east wall sits toward-camera of it), so the channel
    runs along the grid **(1,1) diagonal** = straight down the screen toward the camera, then keeps
    flowing through the low toe/maze (`level < 16`) so it exits into the lowland. Then every water
    cell's toward-camera neighbour is also water — the near wall vanishes and the level-0 surface
    reads the whole way, visibly splitting the mountain, crossed by a deliberate HIGH (`≥16`) stone
    bridge (`_bridge_over_gorge`).
  - **Multi-level water** (`_ponds`/`_tarn`/`_sunken_lagoon`): besides the ocean + the gorge, small
    **flush** lakes at maze tiers `{4,12}` and mountain benches `{20,24}`, a flush alpine tarn, and a
    **sunken walk-in lagoon on the mountain snow** (`LAGOON_SITES`, water 2 levels down inside a Δ1
    walkable rim you descend into) — all transactional so they never seal a region.
  - **Raised-valley MAZE RIVER** (`_maze_river`, carved AFTER `flatten_shores`): the river runs in a
    tier-4 valley (shoulders lifted to 4, water cut to 0) so `_place_bridges` spans it with decks that
    stand a bench ABOVE the water and meet tier-4/12 GROUND on both banks — raised bridges you cross,
    not flat slabs flush on the water.
  - **Spiky massif**: benches `{16,20,24,28,32,36,40}`, ~10 sharp varied-height peaks with deep
    saddles + camera-fanning grooves → a jagged skyline (max level 40), not a smooth pyramid.
  - **Bigger beaches** + a wide **ocean margin** (`M=24`, `n=248`; island inset via `_coastline`,
    `nd` stays 200). `build()` asserts no land on the border. NOTE: a finite frame only pushes
    the edge out of view; to *never* show an "end of world" the **game client** must clamp the
    camera to world bounds or fill out-of-bounds with `clear_water` — that's the engine's job,
    not the generator's.

  Reachability is **prop-aware** (props set `collision=1`). `demo_lost` and `the_island`
  are preserved unchanged.
