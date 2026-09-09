# games2/composer — the composer actor

The **integration + mixing** third of the audio model
([`sounds/spec/AUDIO_INTEGRATION.md`](../../sounds/spec/AUDIO_INTEGRATION.md)):
the sound actor produces SFX/ambience (`sounds/`), the musician produces the
score (`music/`), and **this module binds both to the running game** — buses,
ducking, footstep cadence, ambience mood, adaptive music, musical SFX. One
writer: the composer agent. The game emits *semantic events*; the composer
decides what sounds. Standing maintainer rules (SHA reporting, "he maps
sounds to events, not you") live in [`CLAUDE.md`](CLAUDE.md).

## Charter (maintainer decision)

- **The composer has the SAME generation rights as the sound and music
  agents** (`ELEVENLABS_API_KEY`, the shared Actions secret). When a
  producer's asset falls short *in the game*, the composer regenerates it
  itself under `composer/foley/` instead of filing a request and waiting.
- **The producers cannot access the game.** Only the composer hears assets in
  context — mixed, at gait cadence, against the world — so the composer is
  the final judge of in-game audio quality end to end. The producers own
  their catalogs and contracts; the composer owns what the player hears.
- Composer-generated audio lives under `composer/foley/` (one folder per set
  + `foley.json`), is bundled by Vite (`engine/foley.ts`,
  `import.meta.glob`) and **overrides the catalog** where present. Regenerate
  via the `composer-foley` workflow (dispatch) or
  `python composer/foley/pipeline/generate.py [sets...]`.

## The wiki assignment loop — silent by default

**A sound plays only where the maintainer assigned it.** The engine
(`engine/api.ts`) resolves an emitted event through `EVENT_ASSIGNMENTS` (his
wiki picks) → the approved voice branch / `EVENT_FOLEY` → `bindings.json`
for `BINDINGS_APPROVED` names only. Everything else plays NOTHING. An
unassigned event is silent — no name-matching fallback ever plays a set
(he had to unbind six thunder takes by hand when one did).

- Assignment requests land in **`live/tuning/sfx_requests.json`**
  (`pixel-wiki-sfx-requests@1`): `{event, sound (catalog id or
  composer/<set>), take, pitch, volume_db, max_random_pitch_semis, note}`.
  Read it at every run start; wire accepted entries into `EVENT_ASSIGNMENTS`
  verbatim (fields map 1:1). Take feedback: `live/feedback/composer.json`.
- **A REQUEST IS A MESSAGE, NOT A RECORD.** Consuming one is **ONE COMMIT**
  that both wires it and deletes the request entry (read-modify-write).
  Never one without the other: delete-first loses the ask; wire-first leaves
  a request the next run re-applies over a setting he has since changed. The
  queue is empty afterwards, so it can never be read back to learn what he
  chose —
- — **`composer/assignments.json` is the ground truth**
  (`pixel-composer-assignments@1`, built by
  `games2/scripts/build-assignments.mjs`, staleness-gated by
  `verify-quiet`): what the engine ACTUALLY plays per assigned event (sound,
  take, pitch, volume, jitter, bus). Any tool answering "what does this
  event play" reads that file. **Falling back to
  `EVENT_FOLEY`/`bindings.json` for an assigned event is worse than showing
  nothing** — those layers are outranked, and displaying one is
  indistinguishable from his assignments having been reverted (a paid-for
  wiki bug).
- Candidate SFX are generated as foley sets, served at
  `/assets/composer/foley`, auditioned in the wiki, played nowhere until
  assigned. **A rejected take is DELETED, directory and all** (one wiki pass
  removed 164). Keep-list survivors stay **unwired** — liking a sound is not
  assigning it.
- Gate: `games2/scripts/verify-quiet.mjs` — the can-sound surface must equal
  the approved list + assignments; every assignable action must stay
  emitted (an event nothing fires must not exist); every foley set an active
  route names must EXIST (deleting a rejected set must not leave a dangling
  route).

## Standing verdicts + paid-for lessons (do not re-derive)

**Footsteps** (routing tables at the top of `engine/api.ts`):
- The approved **stone set is the default for every dry surface**
  (`FOOTSTEP_DEFAULT`); per-surface sets are enabled **one at a time with
  explicit approval** — currently `FOOTSTEP_SETS` snow/ice/grass.
  `FOOTSTEP_CATALOG` routes sand/dirt to the catalog `jump` sound ("closest
  we have to sand" after 4 sand generations failed). Water keeps
  splash/swim — no dry footfall; the wet shoreline step is the splash at
  1.15× rate (the approved brighter water-exit character).
- Per-surface trims (`FOOTSTEP_TRIM_DB`): snow −12 ("too loud" twice),
  grass −4, ice −4. Grass also gets a fixed 3600 Hz lowpass + 0.95 rate
  ("very small, just a push away from a hi-hat") and layers the dirt step
  underneath at −6 dB relative (`FOOTSTEP_LAYER`; "dirt at 50%").
- **Stone's recipe is FROZEN — never regenerate a liked set.** The liked set
  trims each take to a tight varied length = one discrete impact; every
  disliked set sat at full clip length = continuous texture. Brief formula:
  "one compact impact" + `max_ms` transient tightening.
- Per-surface sets stay generated and auditionable at `/#foley`
  (`audition.ts`) whether or not they are routed.

**UI clicks**: tactile mechanical wooden-button thocks matching the carved
HUD, explicitly non-musical (verdict: catalog buttons "sound like a piano,
not like buttons"). `ui_cancel` was rejected wholesale in the wiki and
deleted. Vary candidate rounds by the physical MECHANISM (spring, catch,
stone, leather…), briefs purely positive — the anti-piano job belongs to the
`click` GATE, which measures tonality and cannot be talked into what it
filters.
- ⭐ **The click gate does not predict his verdicts** (measured by replaying
  every UI take he ruled on): it would have passed 7 of 7 rejected takes —
  one measuring a perfect 0.000 — and failed one he kept. A pool + judge
  buys more attempts and a deterministic tie-break, nothing more; never pass
  a gate verdict on as a quality signal. (Same shape as the `grain` gate's
  metal lesson.)

**Thunder** = the CLOSE strike, synced to the white flash, "immediate and
loud", "a group with several sounds, but they should not be long". The
shipped set: 6 takes, 1.40 s each, peak at 3–30 ms, 24–66% of energy in the
150–4000 Hz band, `THUNDER_GAIN_DB` +14 (takes master −1 dBFS, sfx bus −14;
the limiter turns the overshoot into punch), and a `rotate` entry binding
all six (a single-take entry once played take01 on every strike for weeks).
**`attack_ms <= 60` is a hard gate.** Rejected on the way: the `explosion`
disguise (0.4× rate + lowpass, delayed after the flash — mush) and DISTANT
rolling thunder (takes 11–12 s, peak 0.7–3.9 s in, 0.0–0.2% mid-band energy
— the crack could never land on the flash and no phone speaker reproduced
what did arrive).

**Jump/fall voice grunts**: per-character sets in `JUMP_VOICE`
(girl `jump_voice`, boy `jump_voice_boy`), routed by character uid
(`opts.voice` from WorldScene), round-robin on the sfx bus at −12 dB
("lower by 50%" twice), fired on jump AND fall-start with a 0.28 s dedupe.
The boy falls back to the girl set pitched 1.33 if his set is absent —
never silent mid-deploy.
- ⭐ **ElevenLabs vocal takes are authored at HALF speed: rate 2.0 is the
  true, normal voice** ("2.0 sounds like a normal man … put the girl at 2.0
  also, I want her real voice"). Start any new character voice at 2.0, then
  nudge — a long tuning loop pitched the girl up by ear (1.12→…→1.75)
  chasing "normal" before this was understood.
- Male vocal briefs lean YOUNG/LIGHT/BRIGHT/HUMAN (a neutral brief read as
  an "orc"), and say "young MAN/youthful" — "boy"/"young boy" wording gets
  moderation-blocked (same as "girl").

**Candidate-brief taste laws** (from his keep/reject record):
- The retro/arcade lane is CLOSED — it lost 10 of 10 head-to-heads.
- Impacts want ORGANIC and PHYSICAL; level-ups want WARM ACOUSTIC; bright
  struck metal (bells, chimes, glockenspiel, gong) lost everywhere tried.
- **Vary by SHAPE and ARRIVAL, not instrument**: ten timbres of one
  rising-and-resolving gesture were all rejected — fix a different arrival
  per brief (a call answered from afar, a bloom with no melody, a flourish
  stopping dead, a sweep landing DOWN, a decay instead of a hold, tender
  instead of triumphant), and include a couple of non-musical object takes
  so the comparison exists.
- Never spend a whole round on one idea (ten takes of slow-solemn-fade
  player_die all lost).
- `foley/pipeline/generate.py:REJECTED_SETS` keeps a bare run from
  resurrecting anything rejected; naming a set on the command line still
  works — that is the deliberate act.

⭐ **The "game from the 90ths" defect was the DECODE — and its fix has
limits.** Every take once arrived at exactly 2.00× the requested length with
aliasing junk in the top octaves. `_generate` now picks the delivered format
BY RESULT (first rung whose decoded length matches what was asked) and
`_decode` resamples any wrong-rate raw pcm. Measured after: both pcm rungs
still return the wrong length, `mp3_44100_192` wins, lengths are 1.00×, UI
sets' ceiling moved ~16→~19 kHz. But impact sets did not move (~100% below
4 kHz in both renders): **that residue is the MODEL, not the pipeline** — a
dull impact is fixed in the BRIEF (ask for the bright half of the sound out
loud), never by another decode change. Do not over-claim apparent full-band
energy — one set's 16–24 kHz "detail" WAS the aliasing artifact.

**Music-generation lessons (ElevenLabs Music, `music_v1`)**:
- Never name real IP/artists — a 400 `bad_prompt` TOS block, not a style
  hint. Describe the style; references translate fine as adjectives.
- Negative prompts backfire (the generator weights the forbidden words). Say
  what you want.
- Say "it starts immediately" in every brief — a bed that fades in from
  ambience reads as broken audio (a theme was rejected for exactly this);
  `lead_in_s` is a scored gate on top.
- Ask for a tempo, then measure it — and expect the measurement to lie:
  autocorrelation returns tempo multiples (2×, 3/2×). The brief's BPM is the
  prior that snaps the raw peak onto the right member of the simple-ratio
  family.
- Generate lossless (`pcm_44100`), master once — mastering a lossy file
  stacks two generations of artefacts.

## Background behavior

- Hidden page → master ducks to 50% (`BACKGROUND_DUCK`, `engine/context.ts`)
  and eases back on return — every bus together; the deploy chime stays
  audible.
- **The score keeps looping in background.** The crossfade scheduler is
  setTimeout-armed and background tabs throttle timers (the music used to
  die when its pass ended). While hidden, MusicDirector hands the score to
  ONE native-looping source (`loopStart/loopEnd` at the measured points,
  zero JS, throttle-immune) with a click-free handoff at the pass's own
  fade-out; on return the scheduler resumes at the position the loop
  reached. Gate: `games2/scripts/verify-background.mjs` (early return AND
  the handoff-then-return leg).

## ENFORCE UNMODIFIED AUDIO (Settings switch)

The maintainer's A/B switch. ON: every one-shot plays the **raw file** — no
pitch/gain/start jitter, no scale-snap, no rate changes, no lowpass, no
pan/distance attenuation, no delays or beat-quantize, no ducking, no night
dip/mode scaling, no underwater insert — and **no take round-robin: always
the FIRST take** (take selection is itself an effect; he heard "a different
sound per press" with the switch on). Kept: which sound plays for which
event, static level balance (bus fader + per-sound mix gain), ambience
looping/bed selection. Diagnosis: sounds bad ON → the asset is bad
(producer problem); fine ON but bad OFF → the composer's processing is at
fault. Persisted; probe: `__ml.audio().pure`.

## Architecture (WebAudio, zero dependencies)

```
source → [lowpass] → [pan] → sound gain → BUS ─┐
                                    music ── duck ┤→ master → limiter → out
buses: music / sfx / ui / ambience               ┘
```

- **`engine/context.ts`** — AudioContext + bus graph + autoplay unlock
  (first pointer/key) + safety limiter + music duck node.
- **`engine/catalog.ts`** — loads the producers' contracts over `/assets/…`.
- **`engine/oneshot.ts`** — one-shots: round-robin takes, pitch/gain/start
  jitter (the contract's `variation`), distance/pan, and **scale-snap**:
  tonal one-shots (measured `music.root_midi`) shift ≤ `max_shift_semitones`
  onto the current track's `sfx_safe_pitch_classes`
  (`sounds/spec/METADATA.md`).
- **`engine/music.ts`** — the score: crossfade-looped per the track's
  `loop.recommended`, night dip, ducking, and the **musical clock** (beat
  grid from measured `timing.beats_s`) that quantizes stingers to the beat.
- **`engine/contextMusic.ts` + `engine/bedSelect.ts`** — the context score
  (below).
- **`engine/ambience.ts`** — looping beds eased toward mood targets from
  time-of-day, weather, and a live terrain field sample.
- **`engine/foley.ts`** — the bundled composer foley library.
- **`engine/api.ts`** — `GameAudio`, the facade the game calls.

## The game-facing API (`gameAudio` from `composer/index.ts`)

| Call | When |
|---|---|
| `init()` | once at boot (`client/src/main.ts`) |
| `startMusic()` | when the world is joined |
| `event(name, opts?)` | semantic events — `"ui.confirm"`, `"player.jump"`, … |
| `avatarFrame(id, frame)` | every frame per avatar: `{moving, running, grounded, swimming, surface, distWu, pan?, dist?}` → footsteps at gait cadence + water enter/exit splashes |
| `dropAvatar(id)` | avatar removed |
| `setEnv({sun, cloud, mist})` | world mood, pushed each frame |
| `setFieldSampler(fn)` | scene-provided terrain fractions `{forest, water, town, fire, threat, cave}` around the listener |
| `setPlace(id)` | named indoor place from maps2 `places.json` (null outdoors) — drives the place beds |
| `thunder(strength)` | with a lightning flash — resolves `weather.thunder` through `EVENT_ASSIGNMENTS` (silent unless assigned), +14 dB × strength |
| `star()` | shooting star — chime snapped into key **on the next beat** |
| `startTitleTheme() / stopTitleTheme()` | character-select theme (looping, music bus) |
| `toggleSound() / toggleMusic()` | HUD settings switches (persisted) |
| `debug()` | QA probe (`__ml.audio()`) |

## The GENTLENESS doctrine (supersedes older ranges)

The raw takes heard through ENFORCE UNMODIFIED AUDIO were judged GOOD after
weeks of "the sound is bad" — the fault was the variation ranges: ±1.5
semitones turns one good recording into four different-sounding ones.
Standing rule for ALL playback: **the raw take is the truth; variation is a
whisper.**

- UI clicks: NO take rotation — the approved primary take every press,
  micro-jitter only (±0.12 semitones, −0.5/+0.3 dB).
- Footsteps: same — primary take every footfall, ±0.2 semitones,
  −0.7/+0.4 dB, no timing jitter, no run rate-change (faster cadence IS the
  run signal; run adds only +0.8 dB of weight).
- Catalog-recommended jitter ranges are scaled ×0.35 at playback — the
  composer overrides the producer's ranges.
- Any future effect starts imperceptible and increases only with explicit
  approval, never the reverse.

## The context score (the beds)

**GENERATING an asset and ROUTING it are two separate decisions**
(maintainer: "I didnt tell you to change the music in the game. Just
generate more music"). The in-world baseline score: the sound-domain catalog
bed by day, cross-faded into the mystical **night** bed after dark
(`NIGHT_MUSIC_DB` −5; the night bed loops continuously so each night plays a
different stretch — the maintainer's "we only get to listen to the start of
the song if it restarts each cycle").

Routed today, on his instruction:

- **battle** — on `field.threat` with the selector's own hysteresis
  (`BED_ON`/`BED_OFF`); the bed is selected ONCE per fight (re-engaging
  inside the tail never restarts the track); `BATTLE_TAIL_S` = 4 s and the
  tail IS the fade, with the world score cross-fading back up as it runs
  out — one gesture, no hole of silence.
- **place beds** — `setPlace()` from maps2 `places.json` (`PLACE_BEDS`:
  `the_cave` → `cave4`, `mountain_top` → `summit_triumph`; keying on the
  place ID covers every world that names one). A place bed OWNS the music
  bus while set — day score and night bed both step aside ("play the music
  cave4 inside that cave regardless if it's day or night").

Everything else (cave/home/town/adventure + the other generated candidates
in `music/tracks.json`) is audition-only until he says what plays where.
Listen at **`/#score`** (`scoreAudition.ts`) — each bed with its brief,
measured facts, and a jump-to-loop-point button; in-game
`__ml.audioBed("cave")` auditions a bed, `__ml.audioBed()` releases,
`__ml.audioField()` shows what the score reads from the world,
`__ml.audio().beds` shows loaded/wanted/playing.

Selection lives in **`engine/bedSelect.ts` as pure functions**, tested in
`test/bedSelect.test.ts` (`npx tsx composer/test/bedSelect.test.ts`) — a
wrong answer is only audible standing in the right place at the right time.
Three pinned rules:

- **PLACE BEATS TIME.** A town at night is still a town; night only decides
  when nowhere else has a claim.
- **HYSTERESIS EVERYWHERE.** Every trigger is a Schmitt trigger
  (`BED_ON`/`BED_OFF`) + `BED_MIN_HOLD_S` 6 s, so a boundary can never make
  the music dither. Battle alone may interrupt instantly.
- **NEVER SILENT.** A missing bed falls down `BED_FALLBACK`; an empty chain
  hands back to the catalog track — exactly the pre-context-score behaviour.

Intended field mapping for the still-unrouted beds: `cave` = deck slabs
overhead (≥1.5 levels above your surface); `home` = spawn-bonfire proximity;
`town` = road/farm/vineyard/mosaic tile fraction in earshot; `night` = sun
strength; `adventure` = the default.

### Why the beds sound like a score, not mp3s on repeat

All from `music/pipeline/master.py`; every number MEASURED, landing in
`music/tracks.json`, which the engine reads.

1. **Loudness matching**: every bed normalised to −18 LUFS (ITU-R BS.1770)
   with a true-peak ceiling — un-matched takes from the same model land 4–6
   LU apart and every context switch is a volume jump. TRAP: deriving
   K-weighting from the RBJ cookbook does NOT reproduce the standard (the
   shelf lands 0.2577 dB low at 997 Hz — exactly how far the calibration
   tone then misses −3.01 LKFS); the tabulated 48 kHz coefficients are
   round-tripped through their analog prototype, and the meter is validated
   against the standard's calibration tone.
2. **Measured loop points**: generated music is never sample-loop-perfect,
   so the seam is searched for — the (start, end) pair whose surrounding
   audio best matches in timbre and level, beat-snapped when a tempo is
   known. The engine crossfades exactly there.
3. **Position memory**: a bed that fades out resumes where it was — walking
   in and out of town does not restart the town tune.

Key and tempo are measured too, so `gameAudio.clock()` and tonal-SFX
scale-snap work over any bed. Delivery is **opus + AAC** (better per byte
than mp3, every browser covered, one format per player). Gates:
`games2/scripts/verify-beds.mjs` (bed routing/fallback in the real game) and
`verify-audio.mjs` (dev stack end to end).

**`title` and `night` are approved takes and are never regenerated.** They
are *adopted* (`generate.py adopt`) — measured as they stand, carrying a
`trim_db` instead of being re-mastered, so the approved bytes keep playing.
The night bed is where the shared bed level comes from: it measures
−16.79 LUFS and played at −5 dB, so −18 LUFS at −3.8 dB reproduces it
exactly.

### Regenerating

`composer-theme` workflow (dispatch; `track` = a name, `new`, or `all`), or
locally with `ELEVENLABS_API_KEY`:

```
python games2/composer/music/pipeline/generate.py new
python games2/composer/music/pipeline/generate.py adopt   # no API key needed
python games2/composer/music/pipeline/test_master.py      # DSP self-test
```

Each track composes from a `/v1/music/plan` composition plan, generates
several candidates, and keeps the best by measured quality (lead-in, loop
seam, dead air, dynamics, brightness, stereo phase); every candidate's card
stays in `tracks.json` so the choice is auditable. Budget-aware: candidate
counts scale down with remaining credits, never below a floor that would
starve the sound/music agents. To nudge a bed's level by ear without
regenerating, edit its `trim_db` in `music/tracks.json` and redeploy.

## Mixing decisions (composer authority)

- Bus floors: ui −12 dB, sfx −14, **music −14**, ambience −24. Music is
  LEVEL with sfx (raised from −20; maintainer: "the music is to low VS the
  sound effects"). TRAP: `sounds/bindings.json` carries the same numbers and
  **overrides** `DEFAULT_BUS_DB` — the two must move together; editing only
  context.ts has no runtime effect.
- Ambience beds run at unity into the bus (the catalog's per-bed −20 dB plus
  the bus floor would stack to silence — the bus owns the bed level).
- Music dips ~5 dB toward night (nights belong to crickets and fires) and
  side-chain ducks on `duck: true` events.
- Footsteps are distance-accumulated per avatar (`WALK_STEP_WU` 25 /
  `RUN_STEP_WU` 38 wu per footfall, foot timing from `FOOT_PHASES` on the
  animation cycle), surface-mapped via `shared/SURFACES` `sound` ids, then
  routed per the footstep law above.
