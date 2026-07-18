# games2/composer — the composer actor

The **integration + mixing** third of the audio model
([`sounds/spec/AUDIO_INTEGRATION.md`](../../sounds/spec/AUDIO_INTEGRATION.md)):
the sound actor produces SFX/ambience (`sounds/`), the musician produces the
score (`music/`), and **this module binds both to the running game** — buses,
ducking, footstep cadence, ambience mood, adaptive music, musical SFX. One
writer: the composer agent. The game emits *semantic events*; the composer
decides what sounds.

## Charter: rights & responsibilities (maintainer, 2026-07-18)

- **The composer has the SAME generation rights as the sound and music
  agents** — it can always generate its own audio (`ELEVENLABS_API_KEY`,
  the shared Actions secret) just like they can. When a producer's asset
  falls short *in the game*, the composer regenerates it itself in its own
  domain (`composer/foley/`) instead of only filing a request and waiting.
- **The producers cannot access the game.** Only the composer hears assets
  in context — mixed, at gait cadence, against the world — so the composer
  is the final judge of in-game audio quality, end to end. The sound/music
  agents own their catalogs and contracts; the composer owns what the
  player actually hears.
- Composer-generated audio lives under `composer/foley/` (one folder per
  set + `foley.json`), is bundled into the client by Vite
  (`engine/foley.ts`, `import.meta.glob`) and **overrides the catalog**
  where present. Regenerate via the `composer-foley` workflow (dispatch) or
  locally: `python composer/foley/pipeline/generate.py [surfaces...]`.

### In-game QA log (what the composer has judged in context)

| Asset (catalog) | Verdict (maintainer, 2026-07-18) | Action |
|---|---|---|
| footstep grass | **bad** | composer regenerates (foley/grass) |
| footstep sand (pitched grass) | **bad** | composer generates a real sand set |
| footstep snow (muffled grass) | **bad** | composer generates a real snow set |
| footstep stone | okey-ish, not great | composer regenerates |
| footstep ice (pitched stone) | okey-ish, not great | composer generates a real ice set |
| footstep wood | unrated | regenerated alongside the rest |

## Architecture (WebAudio, zero dependencies)

```
source → [lowpass] → [pan] → sound gain → BUS ─┐
                                    music ── duck ┤→ master → limiter → out
buses: music / sfx / ui / ambience               ┘
```

- **`engine/context.ts`** — AudioContext + bus graph + autoplay unlock (first
  pointer/key anywhere) + safety limiter + music duck node.
- **`engine/catalog.ts`** — loads the producers' contracts over `/assets/…`.
- **`engine/oneshot.ts`** — one-shots: round-robin takes, pitch/gain/start
  jitter (the sound contract's `variation`), distance/pan spatialization, and
  **scale-snap**: tonal one-shots (measured `music.root_midi`) are shifted ≤
  `max_shift_semitones` onto the current track's `sfx_safe_pitch_classes`, so
  chimes ring in key with the score (`sounds/spec/MUSICAL_SFX.md`).
- **`engine/music.ts`** — the score: crossfade-looped per the track's own
  `loop.recommended`, night dip, ducking, and the **musical clock** (beat grid
  from measured `timing.beats_s`) used to quantize stingers to the beat.
- **`engine/ambience.ts`** — looping beds eased toward mood targets computed
  from time-of-day, weather, and a live terrain field sample (forest / water /
  town / campfire proximity).
- **`engine/api.ts`** — `GameAudio`, the facade the game calls.

## The game-facing API (`gameAudio` from `composer/index.ts`)

| Call | When |
|---|---|
| `init()` | once at boot (`client/src/main.ts`) |
| `startMusic()` | when the world is joined |
| `event(name, opts?)` | semantic events from `sounds/bindings.json` — `"ui.confirm"`, `"player.jump"`, … |
| `avatarFrame(id, frame)` | every frame per avatar: `{moving, running, grounded, swimming, surface, distWu, pan?, dist?}` → the composer emits footsteps at gait cadence + water enter/exit splashes |
| `dropAvatar(id)` | avatar removed |
| `setEnv({sun, cloud, mist})` | world mood, pushed each frame by the scene |
| `setFieldSampler(fn)` | scene-provided terrain fractions `{forest, water, town, fire}` around the listener |
| `thunder(strength)` | with a lightning flash — rumble arrives 1–2.5 s later |
| `star()` | shooting star — chime snapped into key **on the next beat** |
| `toggleSound() / toggleMusic()` | HUD settings switches (persisted in localStorage) |
| `debug()` | QA probe (`__ml.audio()`) |

## Mixing decisions (composer authority)

- Bus floors: ui −12 dB, sfx −14, music −20, ambience −24 (from the sound
  actor's recommendation, then tuned by ear here).
- Ambience beds run at unity into the bus (the catalog's per-bed −20 dB plus
  the bus floor would stack to silence — the bus owns the bed level).
- Music dips ~5 dB toward night (nights belong to crickets and fires) and
  side-chain ducks on `duck: true` events (item.get etc.).
- Footsteps: distance-accumulated per avatar (walk ~25 wu, run ~38 wu per
  footfall), surface-mapped via `shared/SURFACES` `sound` ids; only three
  foley sets exist yet, so sand/snow/swamp/ice are pitched/muffled variants
  of grass/stone until the sound actor ships dedicated sets.
- Distant thunder is the `explosion` take at ~0.4× rate through a ~350 Hz
  lowpass, delayed after the flash — a placeholder until a real
  `thunder_rumble` ships in `sounds/ambience`.

## What would make it better (requests to the producers)

- **musician**: also ship each track as `.ogg`/`.m4a` (~2 MB vs 21 MB WAV) —
  the WAV works but is slow on mobile; more tracks (night, storm, cave) +
  per-section keys if a track modulates.
- **sound actor**: dedicated `thunder_rumble` and a swim-stroke loop;
  `sync_points` are already consumed — keep them coming. (Footsteps are now
  the composer's own problem — see the charter/QA log above.)
