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
Current features are procedural (a 3-px glow needs no PixelLab budget).
If a feature does call PixelLab, it keeps its own copy of the client and
respects the shared budget floors (`coordination/PROTOCOL.md`).

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

  `AUTO → NONE → fireflies → pollen → bats → thunder → sandstorm →
  tumbleweed → leaves → AUTO`

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

## Current features

| Folder | Kind | Feeling | Likeliness / active when |
|--------|------|---------|--------------------------|
| `fireflies/` | field | Warm, mystical night — tiny wandering lanterns | Night (fades with sun strength), thinned by cloud |
| `pollen/` | field | Sunbeam dust / drifting pollen in forest air | Sunlit hours, clear-ish sky, drifts on the cloud wind |
| `bats/` | episode | Flocks crossing the night sky | base 1.0; day ×0.01 |
| `thunder/` | episode | Distant sheet lightning beyond the horizon | base 0.35 × (1 + rain + night); cloud/mist as weak proxies until a rain weather ships |
| `sandstorm/` | episode | Warm dust veil + wind-driven sand streaks that swallow the player | base 0.6 × **sand** (terrain-aware: only rolls while the player stands in sandy ground) × dryness |
| `tumbleweed/` | episode | A twig-ball rolling through the WORLD on the wind, depth-sorted, hop physics and all | base 0.45 × (0.25 + 0.75·**sand**) × dryness — sand-biased, not sand-locked |
| `leaves/` | episode | Autumn leaves spiralling down through the world, tumbling edge-on | base 0.5 × (0.6 + 0.4·cloud); prefers Evening |

**REMOVED 2026-07-18:** `heathaze/` (a camera PostFX refraction) corrupted
the game's custom render stack — black voids, the player stopped rendering.
A camera-wide post-process is incompatible with this game (night-shader RTs,
mist pass, lit copies) and too risky for the ambient layer, which must never
break the game. `rainbow/` removed the same day (maintainer's call). Both
live in git history.

## QA

`node ambient/scripts/verify-ambient.mjs` against a running dev stack
(`npm run dev`): forces night/day/weather via `__ml` probes and asserts each
feature's gain, population and motion through `__mlAmbient`. Keep
`npm test` + `npm run typecheck` green — ambient code is typechecked through
the client's tsconfig via the import chain.

## Don't

- Don't touch gameplay, netcode, `shared/`, `server/`, or any file owned by
  the games/games-ui agents (board round trip first — `UI_AGENT.md` lists
  the split).
- Don't touch the art domains (`characters2/`, `tiles2/`, `maps2/`,
  `objects/`, `sounds/`) — read-only, same as ever.
- Don't write any `coordination/*.json` except `games-ambient.json`.
- Don't push red — `npm test` + `npm run typecheck` first.
