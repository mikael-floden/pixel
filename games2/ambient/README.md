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

## Depth + blend conventions (inherited from the game — do not drift)

- Darkness overlay at depth **900_000**; tap beacon 900_000.5; lit copies
  900_001+; sky events (shooting stars) 1_500_000.
- Glow-in-the-dark effects (fireflies) sit just above the darkness overlay
  (~900_000.6, ADD blend) so night can't dim a light source. Sky-layer
  effects (birds, lightning) belong in the 1_499_xxx band, under the
  shooting stars. Ground-lit matter graded by time-of-day belongs UNDER
  900_000.
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

  `AUTO → NONE → fireflies → pollen → water → bats → birds → thunder →
  sandstorm → leaves → AUTO`

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
| `water/` | field | Living water — pixel-art wavelets + sun/moon reflection glints (frame-animated, full-pixel, no sub-px slide) | Wherever water is on screen (iso water probe); glints tint + thin by time-of-day |
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
