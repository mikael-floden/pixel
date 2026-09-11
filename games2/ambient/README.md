# ambient/ — the ambient-life agent (mood, feeling, atmosphere)

## Who this is

`games2/` is worked by multiple agents (maintainer decision): the **games
agent** (gameplay/netcode/world/server), the **games-ui agent**
(HUD/menus/screens), the **games-audio agent** (`composer/`), and the
**ambient-life agent** (THIS charter) — in charge of the world's *mood and
feeling*: birds, bats, fireflies, pollen in sunbeams, wind, distant
thunder-light, any feel-good or mystical graphics. Board file:
`coordination/games-ambient.json`.

**Hard rule from the maintainer: ambient effects NEVER impact gameplay.**
Nothing here collides, blocks, damages, heals, or changes movement — if an
ambient system dies mid-frame the game must play identically. Everything is
presentation only and must *degrade gracefully*: every integration point is
probed defensively, so a missing hook means an effect quietly doesn't show,
never an error.

## Layout — one folder per ambient feature

```
ambient/
  README.md            ← this charter
  index.ts             ← the feature REGISTRY + mountAmbient() entry point
  runtime/             ← shared plumbing (scene attach, env sampling, types)
  fireflies/ pollen/ … ← each feature is a self-contained folder with its code
  art-original/        ← pristine critter sheets + cull.json (see flap cull)
  scripts/             ← this domain's QA (verify-ambient.mjs etc.)
```

Adding a feature = new folder + one import/line in `index.ts`. Nothing else
in the repo changes. Features may not import from each other — shared
mechanics belong in `runtime/` (and only when two features genuinely need
them; folder isolation beats DRY here).

## How it integrates (without owning anyone else's files)

- **One mount line** in `client/src/main.ts` (shared glue per `UI_AGENT.md`):
  `mountAmbient(game)` after the Phaser game is created. That is the ONLY
  edit outside `ambient/` + `coordination/games-ambient.json`.
- The runtime attaches to the `"world"` scene from the outside
  (`scene.events` UPDATE hook) and *adds* its own display objects. It never
  edits, reads privately into, or monkey-patches the games agent's code.
- **Terrain awareness** likewise: `landableAtScreen` (dry walkable top ground —
  the crawlers and the bird flock), `waterAtScreen` (any swimmable surface) and
  `deepCurrentAtScreen` (the open sea's current). The last was ADDED to
  `WorldScene` for `deepwater/`, because `water` and `deep_water` carry
  identical `Surface` records and nothing on the probe surface could tell a pond
  from the end of the world.
- **A SOURCE-ATTACHED EFFECT FOLLOWS ITS SOURCE, NOT THE ROOF.** The outdoor
  rule (`ctx.outdoor`, below) exists because rain, pollen and birds fall through
  a roof the game has just cut away. A spark from a fire does not: it belongs to
  a thing you can SEE, and the most atmospheric fire in this world is a brazier
  in a cave — `embers/` inherited the rule and was silently dead beside one
  (maintainer 2026-09-08). So an effect anchored to a visible object gates on
  the OBJECT: an unsealed source works wherever you are, and a sealed one (in a
  room) works only while you are indoors, when the roof over it is cut away.
  Without that second half its marks would draw over the roof hiding their own
  source — they sit above the darkness overlay — which is the wall-hack the
  cut-away exists to prevent. Everything that fills the air keeps the plain
  outdoor rule.
- **`plumageOf(scene, key)`** (`runtime/critters.ts`) samples a loaded
  creature sheet for its dominant mid-tone colour, cached per sheet. Anything
  a creature drops must be ITS colour and the art is the only honest source:
  hand-picked feather tints made a white, a red and a green bird all shed
  white (maintainer 2026-09-11), and they would drift again at the next art
  regeneration. Measured over the eight birds: 5b9a42 green, e84940 red,
  cbd1d9 white, and six more all distinct.
- **`groundSoundAt(wx, wy)`** (`runtime/ground.ts`) answers WHAT THE GROUND
  UNDER A DRAWN POINT IS MADE OF — its surface `sound` ("grass", "sand",
  "stone", "dirt", …) — for a feature that belongs over one kind of ground.
  It is TWO probes (`pickAt` to leave drawn iso pixels for world units, then
  `surfaceAt`), which is why it is a PLACEMENT call and never a per-frame one.
  A feature that wants its creature to STAY on that ground does it with
  behaviour instead: `butterflies/` gives each one the patch it was placed on
  and bends its drift back at the edge (`homePull`), which costs nothing and
  is what a butterfly does anyway.
  The `sound` is the right axis because it is the one the art domains already
  maintain per category (`shared/src/surfaces.ts`, gated by
  `check-surfaces.mjs`): "grass" already covers meadow, flowers, forest,
  jungle, savanna and wheat_field, so a feature keyed to it inherits every
  grassy category the maps agent adds next without a second list to update.

- **`runtime/flush.ts`** carries one fact between two features: a flock has
  just panicked off the ground. `birds/` emits per spooked bird, `feathers/`
  listens, and neither imports the other — the flock runs identically whether
  or not anything is listening, and a listener that throws cannot take it
  down. It also carries `setFlushSource`, which is how a listener tells "no
  flock exists" from "a flock exists and is quiet": MANUAL mode forces every
  enabled field, so `forced` alone cannot, and `feathers/` was shedding demo
  feathers over a live flock.
- **A CRITTER'S `gx`/`gy` ARE DRAWN ISO PIXELS, NOT WORLD UNITS.** The player's
  `__ml.me()` is world units (32 per cell) and a critter's position is the
  projected drawing point; the two are different spaces and `teleport` takes a
  CELL. Dividing a critter's gx by 32 put the test player 150 cells away and
  nothing ever happened. `__ml.pickAt(gx, gy)` inverts the projection and is
  the only correct way back.
- **`runtime/water.ts`** answers the two water questions no feature can derive:
  is this point swimmable, and is it the OPEN SEA (`deepCurrentAtScreen`, a
  non-null moving answer). `water` and `deep_water` carry identical Surface
  records, so the split between the lake chop and the seaward current is a
  contract, not a detail — anything new that draws on water inherits it.
  `findLake` takes SEPARATE x and y margins: the projection squashes y by
  14/32, so a mark reaching 15 px sideways reaches 7 down the screen, and one
  symmetric margin refuses most of a real pond for clearance it never needed.
- **The coast is in the artwork, not on the grid**, and `foam/` is the first
  feature that reads it: `__ml.t3at(col,row)` names a boundary tile's Wang
  index and mask frame, and the tiles domain's published mask sheet
  (`tiles/patterns/masks.webp`, fetched by the feature itself) says which
  pixels of the tile are water. Every earlier feature kept a measured
  DISTANCE from the water cells because it could not see that seam.
- **`lightsInView(pad)`** — the second seam added to `WorldScene`, for
  `moths/`: every `EmissiveSource` the camera can see (emissive tiles AND
  scenery lamps) as `{id, x, y, footY, z, r, color, flicker, sealed}`,
  read-only, filtered by a padded `worldView`.
  **`x`/`y` IS WHERE THE GLOW IS DRAWN** — the middle of the lit pixels, which
  the game derives from a piece's own art. Two wrong answers sit next to it and
  both shipped once: the record's ANCHOR is the post's foot, and the record's
  `z` is the LIGHTING height, capped at 1.5 levels so a pool does not leave the
  ground under a tall streetlight dark. A lamp whose lantern is four levels up
  reports 1.5, and anything drawn there lands on the post. The unclamped point
  travels on the record as `hx`/`hy` for exactly this.
  `kind` and `embers` say WHAT the light is — published per piece by the scenery
  domain, classified by eye off the lit art, because nothing derivable works
  (99 of 500 pieces override their own group, and the game's own `flicker` is a
  brightness decision that calls a street lamp a flame). **Embers is not
  flame**: a lantern is a real fire and throws nothing, the glass being between
  it and the world. `flicker` remains for anything that wants the animation. Ambient could not derive this — a lamp's DRAWN anchor
  and its sealed-in-a-room verdict live only in those arrays. It walks every
  source in the world, so a caller reads it on a THROTTLE, never per frame.
- Time-of-day / weather awareness comes from the game's **documented `__ml`
  probe surface** (`__ml.sunInfo()`, `__ml.weatherInfo()`, `__ml.aurora()`),
  sampled at ~10 Hz with safe fallbacks (no probe → effect fades out). If a
  probe's shape changes, ambient fades to nothing rather than crashing —
  then fix `runtime/env.ts`.
- **The light ledger reserves ONE shader light slot for this agent**
  (`setAmbientLight` in `client/src/lightslots.ts`; spec
  `games2/spec/LIGHT_BUDGET.md`) — reservations are strict, never lent.
- The Settings cycler button is INJECTED from `runtime/hudbutton.ts` using
  the games-ui `.ml-plate-btn` class (a load-bearing hook — games-ui keeps
  it alive as plain CSS); we never edit `hud.ts`, and re-inject on a poll
  because the HudBar rebuilds on re-joins.
- Diagnostics live on `window.__mlAmbient` (`list()`, `debug(name)`),
  mirroring the game's `__ml` idiom.
- **`cost(reset?)` is the LAG ANSWER, per feature**: the mount times every
  feature's own `update` and reports `{ms, peak, frames}` — mean ms/frame,
  worst single frame, and how many frames were measured. Whole-frame time in a
  software-GL harness is far too noisy to see a 0.2 ms effect inside it, so a
  "does this feature lag" question is answered here and nowhere else. Measured
  2026-09-07: `moths` 0.027 ms/frame at night, 0.018 by day (both at the
  timer's own noise floor — `performance.now()` granularity, not work).

## Depth + blend conventions (inherited from the game — do not drift)

- Darkness overlay at depth **900_000**; tap beacon 900_000.5; lit copies
  900_001+; sky events (shooting stars) 1_500_000.
- Glow-in-the-dark effects (fireflies) sit just above the darkness overlay
  (~900_000.6, ADD blend) so night can't dim a light source. Sky-layer
  effects (birds, lightning) belong in the 1_499_xxx band, under the
  shooting stars. Ground-lit matter graded by time-of-day belongs UNDER
  900_000.
- **A SURFACE effect is part of the ground: -999_999**, one above the ground
  RenderTexture (-1_000_000) and under the first painter-sorted body. `foam/`
  is the one that lives there: it animates a line the game paints INTO the
  ground texture (the wall's crest, the coast seam), so it must take the night
  and a cliff's cast shadow exactly as that line does, and go under a wall's
  face, a pier, a swimmer. Nothing above the overlay could do that.
  Two facts every surface effect needs, measured 2026-09-09:
  - **What covers a water cell is the picker's to say** (`__ml.pickAt`). A
    plateau drawn in front of a water cell hides it in the ground texture; a
    sprite above that texture would paint on the plateau. Every pixel is
    checked at bake time. **The picker's lattice sits 4 px BELOW the drawn
    plate** (its diamond starts at iso.oy + dy, the plate at iso.oy + 10): on
    the quay at 280,235 the crest rows 7-8 picked as face and row 9 as the
    cell, so a query is shifted down by 4.
  - **A SURFACE EFFECT IS A POPULATION, AND IT FILLS IN ORDER** (maintainer
    2026-09-11, at 278,261: "why is the foam effect only on the left side
    here?"). It was not: the near cliff had 21 sprites at 33 s and the far
    bank 3, and the view did not finish until 64 s. Two causes, both in the
    scheduling. A COUNT budget (10 resolves a scan) is a fixed number of cells
    per second however fast the device runs, and a lattice walk visits cells
    in grid order, which is LEFT TO RIGHT on screen. So the work is one queue
    ordered by distance from the middle of the view, walked under a per-frame
    TIME budget covering resolve and bake together (a count cannot tell a
    cell the game has already resolved, 13.5 us, from one it has not, ~1 ms).
    Measured after: a view completes in about 92 frames — two seconds on his
    phone — and fills outward from where he stands.
  - **Judge throughput at 480x320, never in the phone viewport**: the phone
    geometry runs at 1-2 fps in this harness, so every per-frame budget is
    starved there and the measurement says nothing about his device. The same
    fill measured 8.7 s at 10.7 fps and 64 s at 1.5 fps — the frames are the
    invariant, not the seconds.
  - **The draw loop must skip a RETIRED sprite.** Cells leaving the view keep
    their sheet warm and are hidden, and the per-frame draw pass then set
    every live sprite visible again, undoing it. Off-screen, so nothing looked
    wrong; it showed up as the debug population flickering by a third.
  - **The ground can show the plain plate where the resolver names a composed
    boundary.** After a teleport the coast at 335,255 was a hard diamond edge
    for 16 s while `t3at` reported boundary tiles (composed later, under the
    compose budget, and the drain did not repaint them); `__ml.groundRedraw()`
    brought the seam. A surface effect follows the RESOLVER, never the screen
    — the screen catches up. Reported to the games agent.
- **Pixel art scales nearest-neighbour only, everywhere, always.**
  Procedural glow textures follow the game's own additive-circle idiom. No
  smoothing upscales, no vector gradients.

## Technique policy

Free choice per feature — PixelLab sprites, procedural Phaser textures,
custom shaders — whatever serves the feeling at the lowest complexity. Most
features are procedural (a 3-px glow needs no PixelLab budget). The
**birds** and **bats** flocks render the maintainer's hand-made PixelLab
art: 8 bird TYPES + a bat, each an 8-direction object (`low top-down`) with
a flap animation and a still base, committed as packed spritesheets under
`birds/art/<bird>/` + `bats/art/` and loaded at runtime
(`runtime/critters.ts`; `fly.webp` = 16 flap frames × 8 facings,
`still.webp` = 8 facings — lossless WebP per repo law; bats ship no still,
they never land). The boids
sim drives a directional sprite (facing from boid velocity via the shared
`vectorToDirection`); a landed bird shows its still base. A feature calling
the PixelLab API directly keeps its own client copy and respects the shared
budget floors (`coordination/PROTOCOL.md`).

## Performance budget

Ambient is seasoning, not the meal: each feature stays under ~50 display
objects and O(n) per-frame math, throttles env sampling (the runtime does
this), and fully idles (visible=false, no per-particle math) while its gain
is ~0 — fireflies cost nothing at noon, pollen nothing at midnight.

## The director — likeliness by time-of-day × weather

Two kinds of features (maintainer decision):

- **FIELD** features gate themselves continuously on the environment
  (fireflies rise with the night, pollen with the sun). Always mounted.
- **EPISODE** features are rolled by the **director**
  (`runtime/director.ts`): whenever the time-of-day phase OR weather
  changes, it re-rolls a weighted lottery over the episodes and activates
  the winner for that window. Each episode computes its likeliness as
  **base weight × condition multipliers** (the maintainer's spec — e.g.
  bats ×0.01 by day; thunder base ×2 raining, ×3 night + raining). A
  fixed-weight QUIET slot keeps some windows intentionally empty — ambience
  that always performs stops feeling ambient.

An episode declares `weight(env)` + `setActive(on)`; deactivation must fade
gracefully (bats finish their crossing, a flash finishes its decay). Probes:
`__mlAmbient.director()`, `.weights(envOverride?)`, `.reroll(pinnedRandom?)`.

## The demo button (Settings page)

The **"ambient"** settings button picks WHICH ambient effect is on. It
**never changes time-of-day or weather** — the player owns those (maintainer
decision; an earlier version that jumped the world to each effect's
`preferred` conditions was removed — `preferred` is documentation only; the
`{v}` world-state message extension in WorldRoom stays, unused). The ring:

  `AUTO → NONE → <each feature in registry order> → AUTO`

  (currently fireflies, pollen, water, deepwater, foam, fish, ants, spiders, moths,
  gnats, crabs, bubbles, embers, bats, birds, feathers, butterflies,
  thunder, sandstorm, leaves — the ring is built from `index.ts`, so a new
  folder joins it automatically.)

- **AUTO** — director + fields run normally; the button prints
  `ambient: auto (<current effect>)`, live.
- **NONE** — everything off (fields suppressed, episodes quieted).
- **<effect>** — that ONE effect, solo. An episode pins the director; a
  field is FORCED on (`setForced(true)`) regardless of its env gate — the
  player's own time-of-day still grades the lighting. Every other field is
  suppressed.

QA probe: `__mlAmbient.demo(name? | null)` — `"auto"`/`"none"`/a feature
name, or null = auto.

## Toggling effects independently (compatibility)

Effects toggle **on/off individually** (maintainer decision): several
COMPATIBLE effects can run at once, but an effect **can't be switched on
while an incompatible one is active**. Two modes (`runtime/toggles.ts`):

- **AUTO** — director rolls episodes + fields self-gate (the default).
- **MANUAL** — a SET of enabled effects drives everything; enabled fields
  forced on, enabled episodes activated, everything else off, director
  parked. Any per-effect toggle leaves AUTO; `auto(true)` returns (and
  clears the set).

Each feature declares `conflicts: string[]` (default = compatible with
everything — the goal is many at once). The runtime makes it symmetric
(`conflictClosure`). Current conflicts (day/night "same-role" pairs):

| Pair | Why |
|------|-----|
| `birds` ⟷ `bats` | day vs night sky creatures |
| `fireflies` ⟷ `pollen` | day vs night floating motes |

`water`, `thunder`, `sandstorm`, `leaves` are compatible with everything.
(Rain "one-at-a-time" is the games agent's WEATHER system — a single index —
not an ambient toggle.)

**API for the Settings UI** (games-ui builds the switches on these; all on
`window.__mlAmbient`):

- `effects()` → `[{ name, kind:"field"|"episode", conflicts:[…], on,
  enabled, blocked }]`. `on` = running now; `enabled` = manually switched
  on; `blocked` = the enabled effect that forbids switching this one on
  (grey the switch and say why), else `null`.
- `toggle(name)` / `setEnabled(name, on)` → `{ ok, blockedBy }`. Enabling is
  REFUSED (no state change) when `blockedBy` names an active conflict.
- `auto(on?)` → get/set AUTO vs MANUAL (returns the mode).
- `compatible(a, b)` → boolean (symmetric).

The Settings "ambient" button (above) is a thin cursor over this same
controller (AUTO / NONE / solo-each).

## Current features

| Folder | Kind | Feeling | Likeliness / active when |
|--------|------|---------|--------------------------|
| `fireflies/` | field | Warm, mystical night — tiny wandering lanterns | Night (fades with sun strength), thinned by cloud |
| `pollen/` | field | Sunbeam dust / drifting pollen in forest air | Sunlit hours, clear-ish sky, drifts on the cloud wind |
| `deepwater/` | field | The SEAWARD CURRENT — dim crest lines at the current's own angle rolling inward, specks of drift skating over them, sparks glinting along parts of a crest | Open sea only (`deepCurrentAtScreen`); fades in over the shoreline band, full out at sea |
| `ants/` | field | A foraging TRAIL — 1px ants nose-to-tail along a bowed line, out and back | Dry ground; diurnal, thinned by cloud |
| `spiders/` | field | The SKITTER — 3px, dart-stop-dart, solitary, keeps out of the player's lap | Dry ground; dusk/night leaning (0.25 by day) |
| `moths/` | field | The LAMP DANCE — a few cream specks holding a squashed orbit round a lit lamp, diving at it now and then | Night, outdoors, and only where `lightsInView` reports an unsealed lamp of radius >= 1.5 |
| `gnats/` | field | THE COLUMN — dozens of specks flying hard inside a column of AIR (about a metre across and two tall) that stands still over one patch of ground; walk into it and it breaks up, then gathers again | Dusk (Evening full, Morning half), outdoors, dry ground; gone in rain, storm, snow or wind |
| `crabs/` | field | THE SIDEWAYS SCUTTLE — red crabs strung out along the WHOLE beach (the shoreline is walked, so a curving bay comes out as a curve), still, then running hard along it; the ones at your feet bolt as you pass | Daylight-leaning (night 0.3), outdoors, dry ground with water within a few steps |
| `bubbles/` | field | A STRING FROM THE DEEP — bubbles climbing out of one spot on the open sea, growing and sharpening as they rise, bursting into a ring at the top, leaning downstream on the real current | Open sea only (`deepCurrentAtScreen`); nothing at all over land |
| `embers/` | field | SPARKS OFF A FIRE — they leave the flame, rise on its heat and slow, cool from the fire's own colour toward deep red, and wink out; a blue flame throws blue sparks | Outdoor, unsealed sources whose published `light.embers` is true (a lantern is a fire and throws none); night-leaning, never off by day |
| `foam/` | field | SEA FOAM — the white line where moving water meets land, alive: a one-pixel band hugging the coast seam and the wall's crest, a train of crest lines sliding in from a few pixels out, the band swelling as each arrives (onto the sand over a beach; thick and bright against a wall), in a slow sweep along the coast. Solid contours only, Wind Waker not grain (maintainer's picks) | Any water/land edge in view — the composed boundary seam (mask sheet) and the wall foot's crest (`footBand` replicated, parity-tested); outdoors |
| `fish/` | field | THE RISE — a fish takes a fly: a dorsal fin breaks the surface, a tail flicks a beat later, and two or three rings leave the spot and widen until they fade; the harder takes throw a few specks of water. Rings are ISO ELLIPSES (a circle stands up out of the lake like a hoop) at whole-pixel radii, the lead ring big and the followers smaller so nested rings stay legible | Lakes and shallows only (`runtime/water.ts`; the open sea is `deepwater/`'s), outdoors. Peaks at dawn and dusk on a bump in the sun, never zero, hidden by heavy rain |
| `water/` | field | Living water — pixel-art wavelets + sun/moon reflection glints (frame-animated, full-pixel, no sub-px slide) | LAKES AND SHALLOWS: water on screen (iso probe) MINUS anywhere the deep-sea current runs — the open sea is `deepwater/`'s |
| `feathers/` | field | WHAT A FLUSH LEAVES BEHIND — spook a landed flock and each bird drops a feather or two: knocked loose by the wingbeat so it rises first, then sinks slowly, swinging side to side and LEANING into each slide, and lies on the ground a few seconds before it goes. TINTED FROM ITS OWN BIRD (`plumageOf`, lifted toward white): a red bird sheds a pink feather, a green one a pale green | Only when `birds/` announces a flush (`runtime/flush.ts`); outdoors. Selected ALONE in Settings there is no flock, so it sheds a demo feather then and only then |
| `butterflies/` | field | THE MEADOW IN SUMMER — at four pixels a butterfly is a WAY OF MOVING, not a shape: the body BOBS a whole pixel or three with every wingbeat (a mark that slides level reads as a bee), the path is short runs broken by hard turns (a smooth curve reads as a bird), and the beat is uneven so it does not tick. Wings change SILHOUETTE WIDTH, 5 px open / 3 half / 1 shut, on frames all the same height so only the wings move. TEN COLOUR MIXES FROM THE MAINTAINER'S OWN TABLE (`species.ts`), brown+black commonest at 22% down to green+blue at 1%, with red and purple lifted 1.2x because he likes them. Each one works the PATCH it was placed on and settles onto the grass now and then, wings shut, before lifting off | Grass (the surface's own `sound`, `groundSoundAt`), outdoors, by DAY: a ramp on sun strength, gone in rain, and gone in storm, snow or wind |
| `bats/` | episode | Night colony wheeling: boids in any direction (top-down), erratic jinking, scattering near the player (no landing) | base 1.0; day ×0.01 |
| `birds/` | episode | Living day flock: boids over the world, landing on dry ground to peck, flushing near the player | base 1.0; night ×0.05 |
| `thunder/` | episode | Distant sheet lightning beyond the horizon | base 0.35 × (1 + rain + night); cloud/mist as weak proxies |
| `sandstorm/` | episode | Warm dust veil + wind-driven sand streaks | base 0.6 × **sand** (only rolls while the player stands on sandy ground) × dryness |
| `leaves/` | episode | Autumn leaves spiralling down, tumbling edge-on | base 0.5 × (0.6 + 0.4·cloud); prefers Evening |

**REMOVED — do not reintroduce:** `heathaze/` (a camera PostFX refraction)
corrupted the game's custom render stack — black voids, the player stopped
rendering. A camera-wide post-process is incompatible with this game
(night-shader RTs, mist pass, lit copies) and too risky for a layer that
must never break the game. `rainbow/` removed the same day (maintainer's
call). Both live in git history.

## Indoors: every effect here stops (runtime/outdoor.ts)

Everything this agent draws is an OUTDOOR effect. When the player walks into
a house or cave (the game cuts the roof away), it all has to stop or the
flock wheels through the ceiling.

- The mount reads the game's `__ml.indoor().indoor` geometry verdict EVERY
  FRAME (not on the 10 Hz env sample — a sampled read leaves weather falling
  through the roof for ~6 frames) and publishes `ctx.outdoor`, 0..1.
- **Every feature must multiply its drawn opacity by `ctx.outdoor`**, and
  skips its simulation at 0. Field features get this free: their eased
  `gain` multiplies into the local `g` that drives alpha and the `visible`
  early-out. Birds and bats park explicitly (alpha zeroed once, then the
  whole boid/grade/fog pass skipped) — a house visit can last minutes.
- **The crossing is a FADE**: `OUTDOOR_FADE_MS` = **1050** — not taste, but
  3 · INDOOR_TAU(0.35 s) · 1000: `step()` rolls
  `k = 1 − exp(−(dt_ms/fadeMs)·3)`, making the curve frame-identical to the
  game's own eased `indoorMix`, stepping on the same boolean flip (the
  geometry verdict, not the light blend) — the ambience and the world it
  hangs in can never drift apart. **If INDOOR_TAU ever moves, move this with
  it** (the test asserts the relationship, so `npm test` catches a lone
  change). `fadeMs` is injectable so the fade path stays reachable and
  tested.
- A missing/throwing probe reads as OUTDOORS, so ambience is never silently
  suppressed by a dependency that isn't there.

Gates: `server/test/outdoor.test.ts` (probe fencing + the fade path) and
`games2/scripts/verify-indoor-ambient.mjs`, which walks the real game into a real
house and asserts the DRAWN alpha — a feature that forgot to multiply still
typechecks and passes every unit test. Probe: `__mlAmbient.outdoor()` →
`{ indoor, gain, fadeMs }`.

**`debug().all[].a` IS THE DRAWN ALPHA ON EVERY PATH, including the ones that
return early.** A feature that hides a sprite and `continue`s — parked while
it waits for somewhere to go, off the view, out of budget — must zero `a`
there too, not only where it draws. `butterflies/` kept the alpha each one had
before it left, and over a sea with no grass within twenty cells the gate read
four butterflies flying over open water that were not on screen at all. The
indoor gate above reads the same field, so this is not just a QA nicety.

## Flap-frame cull (birds + bat)

The 8 birds and the bat share one sheet layout: 16 flap frames × 8 facings
at 34px. The maintainer reviews frames and names the ones to drop (wings
tucked, poses that read wrong). That review is DATA, not a one-off edit:

- `art-original/` — the pristine 16-frame sheets, never touched, plus
  `cull.json`: frames to drop per critter per facing, in **original**
  1-based F numbers. Keeping both is what lets a future automatic
  frame-picker be scored (input = originals, expected output = cull.json).
- `scripts/cull_frames.py` — applies it: repacks each row with kept frames
  slid LEFT and the tail transparent, writes `runtime/flapframes.json`
  (per-facing counts + which original frame sits in each slot). Idempotent;
  `--check` verifies the shipped art still matches without writing.
- `scripts/contact_sheet.py` — review sheets. Plain run renders the
  SHIPPING (culled) art; **`--original` renders the uncut sheets, and those
  are the ones to name frames on** — a culled sheet is repacked, so its F5
  is not the original F5.

The runtime keeps the sheet 16 wide and reads the per-facing count, so
`flyFrame()` and every call site are unchanged. The one rule: **never index
past a facing's count** — those cells are transparent padding and the
creature blinks out. `flyCell()` clamps at the draw site so that is
structurally impossible; `server/test/flapcull.test.ts` gates the arithmetic
and the art; `games2/scripts/verify-flapcull.mjs` gates the chain end to end in a
browser.

## QA

`node ambient/scripts/verify-ambient.mjs` against a running dev stack
(`npm run dev`): forces night/day/weather via `__ml` probes and asserts each
feature's gain, population and motion through `__mlAmbient`. It runs at the
small 480×320 movement-timing viewport — fine for numeric assertions, NOT
what the maintainer's phone looks like.

**Look-and-feel / framing checks MUST render in the phone geometry**
(desktop-site layout on a phone: innerWidth 980, screen 393, camZoom 2, big
HUD, zoomed clock/chat) — a 480×320 screenshot has different sky framing,
HUD, and chat/clock overlap, so judging an effect there is misleading. Use
`node ambient/scripts/shoot-phone.mjs <effect> [phase] [weather] [out.png]`
— it opens the exact phone context from games2/CLAUDE.md and shoots the
effect mid-flight. Always eyeball a new visual effect this way before
shipping.

Per-feature browser gates live in `games2/scripts/verify-<feature>.mjs`
(embers, moths, foam, fish, feathers, butterflies, …). SPOOKING A FLOCK IS A PROTOCOL, not
a lunge: a flock only SETTLES while the player is far away, so chasing it keeps
it airborne and it never lands to be flushed — stand off, wait for `landed`,
convert the bird's drawn position with `pickAt`, then close.
A pixel arm's BOX IS THE GAME AREA, never the
screen: at the 480x320 QA viewport the camera shows 198 px of world and the
rest is HUD, where the chat line rewrites itself while the gate runs — judging
the whole screen measured that text and read 243.6 with the control at 243.6.
**And for a SMALL mark the box is the MARK, not the game area** — and it
measures CONTRAST EITHER WAY, not a brightness rise: the commonest butterfly
in the game is brown+black, which is DARKER than the grass, so an OFF envelope
read only as a maximum would call it invisible. Keep a max and a min over the
OFF frames and take the largest departure from that band. An OFF
envelope over a wide box also measures everything else alive in it — the
player's idle and the scenery's sway are both bigger than a 5 px butterfly —
so ask the feature where its mark is (`debug().all`), convert to screen, and
judge a window a few pixels wider than the art, with the control taken in the
SAME windows. Measured: a deliberately broken butterflies run "failed" on a
swaying grass tuft (rise 199, noise 125) instead of on the thing being broken;
the same run on per-mark windows read rise 222 against noise 0.0.
**AN OFF ENVELOPE NEEDS A QUIET SCREEN, AND QUIET MUST BE MEASURED.** The
ground is a render texture that scrolls and repaints in slices, so for a
second or two after the camera arrives somewhere its own frames differ from
each other by more than any small mark does — measured 99 luma of "noise" in
an OFF control taken right after an arm teleported around and came back,
which failed the arm on the ground finishing its paint rather than on
anything real. Before building an envelope, shoot two frames 400 ms apart and
require them to agree (under 8 luma) — two frames that agree is the evidence
that the only thing still moving is the feature under test. A fixed sleep is
a guess; this is not.
**STAND WHERE THE THING COULD GO WRONG.** `verify-butterflies` first ran on a
13x13 block of pure grass, where widening the accepted-ground set to every
surface in the world still passed — there was no other surface to get it wrong
on. Moved to a view that is 63% grass and 37% soil and paving, the same
falsification fails two arms. A gate location is part of the gate.
**A TWO-COLOUR CREATURE CANNOT BE A TINT, and a colour table's percentages
are not pixel areas.** `setTint` multiplies the whole sprite by one value, so
anything with a marking has its colours PAINTED INTO per-species textures
(ten mixes x three frames = thirty 5x4 textures, built once at init — cheaper
than the second sprite per creature the alternative needs, and the colours
come out exact rather than as a multiply). And a real colour table's split
("60% black / 40% orange") counts VEINS AND BORDERS that do not exist at five
pixels across: spending 60% of thirteen pixels on black drew a black blob with
two orange specks. The split sets HOW MUCH MARKING and the table's ORDER is
what is preserved; the marking is capped (`MAX_DARK_PAIRS`) and spent from the
hindwing and forewing TIPS inward, so the forewing mass — the pixels that say
what colour the creature is — is the last thing it reaches.
**AND THE BODY IS BLENDED BACK TOWARD THE WING.** Twice a flat dark body split
a creature into two blobs on screen: near-black over grass, then the mix's own
black under brown wings. The pixel joining the wings must belong to them.
**AN IN-PAGE LOOP RUNS ON rAF WITH A WALL-CLOCK DEADLINE, never on a
`setTimeout` count.** Chromium clamps timers hard in a headless page, so a
gate arm written as "900 iterations of `await setTimeout(30)`" — 27 s on
paper — ran past ten minutes and read as a hung gate with no output, because
the arm's own `console.log` comes after the loop. Tick on
`requestAnimationFrame` (the game's own clock, and it cannot be clamped below
the frame rate) and bound the loop with `performance.now()`, so the arm
reports what it found rather than never finishing.
**TEST WHAT THE FEATURE CONTROLS.** The same gate first asked every DRAWN
butterfly position to be grass and sat at 81% against an 80% bar, because a
butterfly that flies for ten seconds crosses the path at the edge of the
meadow — which is a butterfly, not a defect. What the feature decides is where
it PLACES one; that arm is 100% or fail, with "never over water" beside it.
Nor can an animation be judged in the PHONE viewport: a screenshot there takes
about 8 s, so a 2 s effect is one frame. Shape and timing are shot at 480x320,
framing at the phone size, as a still. `verify-foam.mjs` judges the coast band and the wall
crest by the OFF-envelope pixel technique, with open-water and dry-sand
controls, a depth check, motion, and the idle cost. `server/test/foam.test.ts`
composes the game's own `footBand` and asserts the foam's crest is the same
pixels for every wall combination — if the games agent moves the line, that
test says so first.

Keep `npm test` + `npm run typecheck` green — ambient code is typechecked
through the client's tsconfig via the import chain.

## Don't

- Don't touch gameplay, netcode, `shared/`, `server/`, or any file owned by
  the games/games-ui agents (board round trip first — `UI_AGENT.md` lists
  the split).
- Don't touch the art domains (`characters2/`, `tiles/`, `maps2/`,
  `scenery/`, `sounds/`) — read-only, same as ever.
- Don't write any `coordination/*.json` except `games-ambient.json`.
- Don't push red — `npm test` + `npm run typecheck` first.
