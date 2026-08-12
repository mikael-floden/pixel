# ambient/ — the ambient-life agent (mood, feeling, atmosphere)

## Who this is

`games2/` is worked by THREE agents (maintainer decision 2026-07-17): the
**games agent** (gameplay/netcode/world/server), the **games-ui agent**
(HUD/menus/screens), and the **ambient-life agent** (THIS charter) — the one
in charge of the world's *mood and feeling*: birds, bats, fireflies, pollen
drifting through sunbeams, wind, distant thunder-light, any feel-good or
mystical graphics. Board file: `coordination/games-ambient.json`.

**Hard rule from the maintainer: ambient effects NEVER impact gameplay.**
Nothing here collides, blocks, damages, heals, or changes movement — if an
ambient system dies mid-frame the game must play identically. Everything in
this directory is presentation only, and it must *degrade gracefully*: every
integration point is probed defensively, so a missing hook means an effect
quietly doesn't show, never an error.

## Layout — one folder per ambient feature

```
ambient/
  README.md            ← this charter
  index.ts             ← the feature REGISTRY + mountAmbient() entry point
  runtime/             ← shared plumbing (scene attach, env sampling, types)
  fireflies/           ← each feature is a self-contained folder …
  pollen/              ← … with its code + a README explaining its feel
  scripts/             ← this domain's QA (verify-ambient.mjs etc.)
```

Adding a feature = new folder + one import/line in `index.ts`. Nothing else
in the repo changes. Features may not import from each other — shared
mechanics belong in `runtime/` (and only when two features genuinely need
them; folder isolation beats DRY here).

## How it integrates (without owning anyone else's files)

- **One mount line** in `client/src/main.ts` (shared glue per `UI_AGENT.md`;
  announced on the board): `mountAmbient(game)` after the Phaser game is
  created. That is the ONLY edit outside `ambient/` +
  `coordination/games-ambient.json`.
- The runtime attaches to the `"world"` scene from the outside
  (`scene.events` UPDATE hook) and *adds* its own display objects to the
  scene. It never edits, reads privately into, or monkey-patches the games
  agent's code.
- Time-of-day / weather awareness comes from the game's **documented `__ml`
  probe surface** (`__ml.sunInfo()`, `__ml.weatherInfo()`, `__ml.aurora()`),
  sampled at ~10 Hz with safe fallbacks (no probe → effect fades out).
  If a probe's shape ever changes, ambient fades to nothing rather than
  crashing — then fix `runtime/env.ts`.
- Diagnostics for QA live on `window.__mlAmbient` (`list()`, `debug(name)`),
  mirroring the game's `__ml` idiom.

## Depth + blend conventions (inherited from the game — do not drift)

- Darkness overlay sits at depth **900_000**; tap beacon 900_000.5; lit
  copies 900_001+; sky events (shooting stars) 1_500_000.
- Glow-in-the-dark effects (fireflies) live just above the darkness overlay
  (~900_000.6, ADD blend) so night can't dim a light source. Sky-layer
  effects (birds, lightning) belong in the 1_499_xxx band, under the
  shooting stars. Ground-lit matter that should be graded by time-of-day
  belongs UNDER 900_000.
- **Pixel art scales nearest-neighbour only, everywhere, always.** Procedural
  glow textures follow the game's own additive-circle idiom (star-spark,
  tap beacon). No smoothing upscales, no vector gradients.

## Technique policy

Free choice per feature — PixelLab sprites, procedural Phaser textures,
custom shaders — whatever serves the feeling best at the lowest complexity.
Most features are procedural (a 3-px glow needs no PixelLab budget). The
**birds** and **bats** flocks render the maintainer's hand-made PixelLab art:
8 bird TYPES + a bat, each an 8-direction object (`low top-down`) with a
flap animation and a still base, committed as packed spritesheets under
`birds/art/` + `bats/art/` and loaded at runtime (`runtime/critters.ts`;
`fly.png` = 16 flap frames × 8 facings, `still.png` = 8 facings). The boids
sim stays the same — it just drives a directional sprite (facing from the
boid velocity via the shared `vectorToDirection`) instead of a flip-mirrored
2-frame texture; a landed bird shows its still base. If a feature calls the
PixelLab API directly, it keeps its own client copy and respects the shared
budget floors (`coordination/PROTOCOL.md`).

## Performance budget

Ambient is seasoning, not the meal: each feature stays under ~50 display
objects and O(n) per-frame math, throttles env sampling (runtime does this),
and fully idles (visible=false, no per-particle math) while its gain is ~0
— fireflies cost nothing at noon, pollen costs nothing at midnight.

## The director — likeliness by time-of-day × weather

Two kinds of features (maintainer 2026-07-17):

- **FIELD** features gate themselves continuously on the environment
  (fireflies rise with the night, pollen with the sun). Always mounted.
- **EPISODE** features are rolled by the **director**
  (`runtime/director.ts`): every time the time-of-day phase OR the weather
  changes, it re-rolls a weighted lottery over the episode features and
  activates the winner for that window. Each episode computes its own
  likeliness as **base weight × condition multipliers** — e.g. bats are
  ×0.01 by day; thunder is base ×2 when raining, ×3 when night + raining
  (the maintainer's spec, verbatim). A fixed-weight QUIET slot keeps some
  windows intentionally empty — ambience that always performs stops
  feeling ambient.

An episode declares `weight(env)` + `setActive(on)`; deactivation must fade
gracefully (bats finish their crossing, a flash finishes its decay).
QA probes: `__mlAmbient.director()`, `.weights(envOverride?)`,
`.reroll(pinnedRandom?)`.

## The demo button (Settings page)

The **"ambient"** settings button picks WHICH ambient effect is on. It
**never changes time-of-day or weather** — the player owns those
(maintainer 2026-07-18). The ring is:

  `AUTO → NONE → fireflies → pollen → water → bats → birds → thunder →
  sandstorm → leaves → AUTO`

- **AUTO** — the director + fields run normally; the button prints
  `ambient: auto (<current effect>)`, live — the active episode, else the
  most-prominent showing field, else `none`.
- **NONE** — every ambient effect off (all fields suppressed, episodes
  quieted).
- **<effect>** — that ONE effect, solo. An episode pins the director; a
  field is FORCED on (`setForced(true)`) regardless of its env gate, so
  selecting fireflies shows fireflies even by day (the player's own
  time-of-day still grades the lighting). Every other field is suppressed.

(Earlier the button jumped the shared world to each effect's `preferred`
conditions; the maintainer removed that 2026-07-18. `preferred` is now
documentation only — the `{v}` world-state message extension in WorldRoom
stays, unused by the button but still handy.)

Plumbing: the button is INJECTED into the settings row from
`runtime/hudbutton.ts` (games-ui owns hud.ts — we never edit it; the
HudBar rebuilds on re-joins, so the runtime re-injects on a poll). QA
probe: `__mlAmbient.demo(name? | null)` — `"auto"`/`"none"`/a feature
name, or null = auto.

## Toggling effects independently (compatibility)

Effects toggle **on/off on their own** (maintainer 2026-07-19): several
COMPATIBLE effects can run at once, but an effect **can't be switched on while
an incompatible one is active**. Two modes (`runtime/toggles.ts`):

- **AUTO** — the director rolls episodes + fields self-gate (the game's default
  living behaviour).
- **MANUAL** — a SET of enabled effects drives everything; enabled fields are
  forced on, enabled episodes activated, everything else off, director parked.
  Any per-effect toggle leaves AUTO; `auto(true)` returns (and clears the set).

Each feature declares `conflicts: string[]` (default = compatible with
everything — the goal is to play many at once). The runtime makes it symmetric
(`conflictClosure`). Current conflicts (day/night "same-role" pairs):

| Pair | Why |
|------|-----|
| `birds` ⟷ `bats` | day vs night sky creatures |
| `fireflies` ⟷ `pollen` | day vs night floating motes |

`water`, `thunder`, `sandstorm`, `leaves` are compatible with **everything**.
(Rain "one-at-a-time" is the games agent's WEATHER system — a single index —
not an ambient toggle.)

**API for the Settings UI** (the games-ui agent builds the switches on these;
all on `window.__mlAmbient`):

- `effects()` → `[{ name, kind:"field"|"episode", conflicts:[…], on, enabled,
  blocked }]`. `on` = running now; `enabled` = manually switched on; `blocked`
  = the enabled effect that forbids switching this one on (grey the switch and
  say why), else `null`.
- `toggle(name)` / `setEnabled(name, on)` → `{ ok, blockedBy }`. Enabling is
  REFUSED (no state change) when `blockedBy` names an active conflict.
- `auto(on?)` → get/set AUTO vs MANUAL (returns the mode).
- `compatible(a, b)` → boolean (symmetric).

The Settings **"ambient"** button (above) still works — it's a thin cursor over
this same controller (AUTO / NONE / solo-each).

## Current features

| Folder | Kind | Feeling | Likeliness / active when |
|--------|------|---------|--------------------------|
| `fireflies/` | field | Warm, mystical night — tiny wandering lanterns | Night (fades with sun strength), thinned by cloud |
| `pollen/` | field | Sunbeam dust / drifting pollen in forest air | Sunlit hours, clear-ish sky, drifts on the cloud wind |
| `water/` | field | Living water — pixel-art wavelets + sun/moon reflection glints on lakes/sea (frame-animated, full-pixel, no sub-px slide) | Wherever water is on screen (found via the iso water probe); glints tint + thin by time-of-day (warm sun by day, cool dim moon at night) |
| `bats/` | episode | A night colony wheeling through the air: boids flocking in any direction (top-down), erratic jinking, and scattering when the player gets close (no landing — bats stay airborne) | base 1.0; day ×0.01 |
| `birds/` | episode | A living day flock: boids flocking over the world in any direction (top-down), landing on dry ground to peck, and flushing/scattering when the player gets close | base 1.0; night ×0.05 (the daytime mirror of bats) |
| `thunder/` | episode | Distant sheet lightning beyond the horizon | base 0.35 × (1 + rain + night); cloud/mist as weak proxies until a rain weather ships |
| `sandstorm/` | episode | Warm dust veil + wind-driven sand streaks that swallow the player | base 0.6 × **sand** (terrain-aware: only rolls while the player stands in sandy ground) × dryness |
| `leaves/` | episode | Autumn leaves spiralling down through the world, tumbling edge-on | base 0.5 × (0.6 + 0.4·cloud); prefers Evening |

**REMOVED 2026-07-18:** `heathaze/` (a camera PostFX refraction) corrupted
the game's custom render stack — black voids, the player stopped rendering.
A camera-wide post-process is incompatible with this game (night-shader RTs,
mist pass, lit copies) and too risky for the ambient layer, which must never
break the game. `rainbow/` removed the same day (maintainer's call). Both
live in git history.

## Indoors: every effect here stops (runtime/outdoor.ts)

Everything this agent draws is an OUTDOOR effect — birds, bats, pollen,
fireflies, leaves, sandstorm, thunder, water glints. The game now lets the
player walk into a house or cave (it cuts the roof away and blacks the outside
out), so all of it has to stop or the flock wheels through the ceiling.

- The mount reads the game's `__ml.indoor().indoor` geometry verdict EVERY
  FRAME (not on the 10 Hz env sample — a sampled read leaves weather falling
  through the roof for ~6 frames) and publishes `ctx.outdoor`, 0..1.
- **Every feature must multiply its drawn opacity by `ctx.outdoor`**, and should
  skip its simulation at 0. The field features get this for free: their eased
  `gain` is multiplied into a local `g` that already drives both alpha and their
  `visible` early-out. Birds and bats park explicitly (alpha zeroed once, then
  the whole boid/grade/fog pass skipped) — a house visit can last minutes.
- It **SNAPS** 1 → 0 today, because the game's own in/out crossing is a cut.
  It is a GAIN rather than an `if (indoor) return` so that when that crossing
  becomes a fade, the ambience fades with it: set `OUTDOOR_FADE_MS`, or better,
  feed the game's own 0..1 crossing (`__ml.indoor().mix` is already eased) into
  `OutdoorGain.step`. Nothing in the eight features has to change — the partial
  values are already threaded through every draw path.
- A missing/throwing probe reads as OUTDOORS, so ambience is never silently
  suppressed by a dependency that isn't there.

Gates: `server/test/outdoor.test.ts` (the snap, the probe fencing, and the fade
path — the fade duration is injectable so "flip one constant" is tested rather
than promised) and `scripts/verify-indoor-ambient.mjs`, which walks the real
game into a real house and asserts the DRAWN alpha, since a feature that forgot
to multiply still typechecks and still passes every unit test.
Probe: `__mlAmbient.outdoor()` → `{ indoor, gain, fadeMs }`.

## Flap-frame cull (birds + bat)

The 8 birds and the bat share one sheet layout: 16 flap frames × 8 facings at
34px. Not every frame is good — the maintainer reviews them and names the ones
to drop (wings tucked, poses that read wrong). That review is DATA, not a
one-off edit:

- `art-original/` — the pristine 16-frame sheets, never touched, plus
  `cull.json`: the frames to drop per critter per facing, in **original**
  1-based F numbers. Keeping both is what lets a future AUTOMATIC frame-picker
  be scored (input = the originals, expected output = cull.json).
- `scripts/cull_frames.py` — applies it. Repacks each row with the kept frames
  slid LEFT and the tail transparent, and writes `runtime/flapframes.json`
  (per-facing counts + which original frame sits in each slot). Idempotent, and
  `--check` verifies the shipped art still matches without writing.
- `scripts/contact_sheet.py` — the review sheets. Plain run renders the SHIPPING
  (culled) art; **`--original` renders the uncut sheets, and those are the ones
  to name frames on** — a culled sheet has been repacked, so its F5 is not the
  original F5.

The runtime keeps the sheet 16 wide and reads the per-facing count, so
`flyFrame()` and every call site are unchanged. The one rule: **never index past
a facing's count** — those cells are transparent padding and the creature blinks
out. `flyCell()` clamps at the draw site so that is structurally impossible;
`server/test/flapcull.test.ts` gates the arithmetic and the art, and
`scripts/verify-flapcull.mjs` gates the whole chain end to end in a browser.

## QA

`node ambient/scripts/verify-ambient.mjs` against a running dev stack
(`npm run dev`): forces night/day/weather via `__ml` probes and asserts each
feature's gain, population and motion through `__mlAmbient`. That script runs
at the small 480×320 movement-timing viewport — fine for numeric assertions,
but it is NOT what the maintainer's phone looks like.

**Look-and-feel / framing checks MUST render in the phone geometry** (desktop-
site layout on a phone screen — innerWidth 980, screen 393, camZoom 2, big HUD,
zoomed clock/chat). A 480×320 screenshot does not match the phone at all
(different sky framing, HUD, overlap with the chat/clock), so judging an effect
there is misleading. Use `node ambient/scripts/shoot-phone.mjs <effect>
[phase] [weather] [out.png]` — it opens the exact phone context from games2/
CLAUDE.md and shoots the effect mid-flight. Always eyeball a new visual effect
this way before shipping.

Keep `npm test` + `npm run typecheck` green — ambient code is typechecked
through the client's tsconfig via the import chain.

## Don't

- Don't touch gameplay, netcode, `shared/`, `server/`, or any file owned by
  the games/games-ui agents (board round trip first — `UI_AGENT.md` lists
  the split).
- Don't touch the art domains (`characters2/`, `tiles2/`, `maps2/`,
  `scenery/`, `sounds/`) — read-only, same as ever.
- Don't write any `coordination/*.json` except `games-ambient.json`.
- Don't push red — `npm test` + `npm run typecheck` first.
