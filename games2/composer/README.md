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
| UI buttons (menu_select/confirm/cancel) | **"sound like a piano, not like buttons"** (2026-07-18) | composer generates tactile mechanical clicks (foley/ui_tick, ui_confirm) — wooden-button thocks matching the carved HUD, explicitly non-musical. `ui_cancel` (the duller release recording) was **rejected wholesale in the wiki 2026-08-05 and deleted**, so `ui.press` clicks and `ui.release` is silent until he assigns a release sound |
| thunder | **"doesn't sound like thunder"** (2026-07-18); all four generated rolls **rejected in the wiki** (2026-08-05) | the `explosion` disguise (0.4× rate + lowpass, 1–2.5 s after the flash) read as mush, and the real generated `foley/thunder` set that replaced it did not survive QA either — the set is deleted and **the disguise fallback went with it**, because deleting the takes must not silently promote the behaviour he rejected first. Lightning currently flashes SILENT; `thunder()` still picks up a regenerated `foley/thunder` set, which is the only route back (thunder is not a `gameAudio.event`, so the wiki cannot assign it) |
| composer foley round 1 | **stone (black_mountain) GOOD — "I like that one"; other footsteps "still not good enough (but better than before)"** (2026-07-18) | the liked set trims to tight varied lengths = a discrete impact; every disliked set sat at full clip length = continuous texture instead of one step. Round 2: briefs rewritten on stone's "one compact impact" formula + `max_ms` transient tightening cuts the step out of any texture bed in post. **Stone's recipe is FROZEN — never regenerate a liked set.** |
| footsteps, final directive | **"Only use the stone footsteps for now (regardless of tile-type). Water can be different."** (2026-07-18) | playback routes EVERY dry surface to the stone set (`FOOTSTEP_SET` in engine/api.ts); water keeps splash/swim. The per-surface sets stay generated + auditionable at /#foley but are NOT played until something earns approval. Re-enabling per-surface = change one constant back to `f.surface` routing. |
| jump/fall VOICE grunts | **girl + boy each APPROVED at rate 2.0** — "2.0 sounds like a normal man … put the girl at 2.0 also, I want her real voice" (2026-07-25) | per-character `JUMP_VOICE` sets in engine/api.ts (`jump_voice` = girl, `jump_voice_boy` = boy), routed by character uid (`opts.voice` from WorldScene), each on the SFX bus, round-robin, −12 dB, on both jump AND fall-start (0.28 s debounce). **⭐ LESSON — ElevenLabs vocal takes are authored at HALF speed: play them at RATE 2.0 to hear the true, normal voice.** We wasted a long tuning loop pitching the girl up by ear (1.12→…→1.75) chasing "normal" before realizing 2× is the honest baseline — start any new character voice at 2.0, then nudge. Male-brief lessons: lean YOUNG/LIGHT/BRIGHT/HUMAN (round-1 male read as an "orc") and say "young MAN/youthful" not "boy/young boy" (child-voice wording gets moderation-blocked, same as "girl"). |

### Music-generation lessons (ElevenLabs Music, `music_v1`)

- **Never name real IP or artists.** "Ragnarök Online / Studio Ghibli / Joe
  Hisaishi" in a prompt is a 400 `bad_prompt` ToS block, not a style hint.
  Describe the style and the *feeling*; the maintainer's references translate
  fine as adjectives.
- **Negative prompts backfire** (same as foley): the generator weights the words
  you forbid. Say what you want.
- **Say "it starts immediately".** A bed that fades in from ambience reads as
  broken audio — the maintainer rejected a theme for exactly this ("the start is
  important because you might click away fast"). Every brief says the first bar
  is already music, and `lead_in_s` is a scored gate on top.
- **Ask for a tempo, then measure it — and expect the measurement to lie.**
  Autocorrelation cannot tell a tempo from its multiples: it came back at 2× for
  the night bed (123 for 62) and 3/2× for the title theme (140 for 92). The
  brief's BPM is used as a prior to snap the raw peak onto the right member of
  the simple-ratio family.
- **Generate lossless, master once.** Asking for `pcm_44100` and encoding at the
  end avoids mastering a lossy file (decode + re-encode = two generations of
  artefacts on a track the player hears for hours).

### The wiki assignment loop (maintainer 2026-08-05)

The Game Master auditions sounds in the wiki and assigns them to in-game
events; the game never plays unapproved audio. The machinery:

- The engine is **silent-by-default** (`engine/api.ts`): an emitted event
  resolves through `EVENT_ASSIGNMENTS` (the Game Master's wiki picks) → the
  approved voice branch / `EVENT_FOLEY` → `bindings.json` for
  `BINDINGS_APPROVED` names only. Everything else plays nothing.
- Assignment requests land in **`live/tuning/sfx_requests.json`**
  (`pixel-wiki-sfx-requests@1`): `{event, sound (catalog id or
  composer/<set>), pitch, volume_db, max_random_pitch_semis, note}`. **Read it
  at every run start**, wire accepted entries into `EVENT_ASSIGNMENTS`
  verbatim (the fields map 1:1), and DELETE the entries acted on
  (read-modify-write). Feedback on takes: `live/feedback/composer.json`.
- Candidate SFX are generated as foley sets, served at
  `/assets/composer/foley`, auditioned in the wiki, played nowhere until
  assigned. **A rejected take is DELETED, not left lying around** (wiki pass
  2026-08-05 removed 164 takes; a set whose every take was rejected — the
  whole round-5 candidate batch, plus `sand`, `thunder`, `ui_cancel` — is
  gone, directory and all). What survives is the maintainer's keep list: the
  footstep/voice/click sets in playback, plus the ten single-take candidates
  he liked (`cross_rise_roots`, `cross_sink_swallow`, `hit_taken_gut`,
  `item_drop_mudplop`, `kick_bamboo`, `level_up_choir`, `level_up_harp`,
  `monster_die_bubble`, `monster_die_splat`, `monster_hit_splat`) — kept and
  **unwired**: liking a sound is not assigning it.
- Gate: `scripts/verify-quiet.mjs` — the can-sound surface must equal the
  approved list + assignments, every assignable action must stay emitted, and
  every foley set an active route names must EXIST (deleting a rejected set
  must not leave a route pointing at nothing).

### Background behavior (maintainer 2026-08-05)

- **Hidden page → master ducks to 50%** (`BACKGROUND_DUCK`, context.ts) and
  eases back on return — every bus together; the deploy chime stays audible.
- **The score keeps looping in background.** The crossfade scheduler is
  setTimeout-armed and background tabs throttle/freeze timers — the music
  died the moment its pass ended. While hidden, MusicDirector hands the score
  to ONE native-looping source (`loopStart/loopEnd` at the measured points,
  zero JS, immune to throttling), with a click-free handoff at the pass's own
  fade-out; on return the scheduler resumes at the position the loop reached.
  Title theme + night bed already loop natively and never had the bug. Gate:
  `scripts/verify-background.mjs` (covers both the early return AND the real
  handoff-then-return leg).

### ENFORCE UNMODIFIED AUDIO (Settings switch)

The maintainer's A/B test switch (requested 2026-07-18, exactly for cases
like the thunder): when ON, every one-shot plays the **raw file** — no
pitch/gain/start jitter, no scale-snap, no rate changes, no lowpass, no
pan/distance attenuation, no delays or beat-quantize, no ducking, no night
dip/mode scaling, no underwater insert — and no take round-robin: always
the FIRST take, so the same event plays the same file every time (take
selection is itself an effect; the maintainer heard "a different sound per
press" with the switch on, 2026-07-18). Kept: which sound plays for which
event, static level balance (bus fader + per-sound mix gain), ambience
looping/bed selection. So: sounds bad with the switch ON → the asset is bad
(producer/generation problem); sounds fine ON but bad OFF → the composer's
processing is at fault. Persisted; probe: `__ml.audio().pure`.

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
| `thunder(strength)` | with a lightning flash — in sync with the flash; **silent today**, its set was rejected and deleted |
| `star()` | shooting star — chime snapped into key **on the next beat** |
| `toggleSound() / toggleMusic()` | HUD settings switches (persisted in localStorage) |
| `debug()` | QA probe (`__ml.audio()`) |

## The GENTLENESS doctrine (maintainer, 2026-07-18 — supersedes older ranges)

After weeks of "the sound is bad" verdicts, the raw takes heard through
ENFORCE UNMODIFIED AUDIO were judged GOOD — the fault was the variation
ranges: ±1.5 semitones turns one good recording into four different-sounding
ones. Standing rule for ALL playback: **the raw take is the truth; variation
is a whisper.**

- UI clicks: NO take rotation — the approved primary take every press, with
  micro-jitter only (±0.12 semitones, −0.5/+0.3 dB).
- Footsteps: SAME rule (maintainer approved the raw step too) — the primary
  stone take every footfall, micro-jitter ±0.2 semitones / −0.7/+0.4 dB, no
  timing jitter, no run rate-change (faster cadence IS the run signal; run
  adds only +0.8 dB of weight).
- Catalog-recommended jitter ranges from `sounds/viewer_data.json` are
  scaled ×0.35 at playback — the composer overrides the producer's ranges.
- When tuning any future effect: start from imperceptible and increase only
  with explicit approval, never the reverse.

## The music beds — generated, NOT yet routed

**The in-world score is unchanged**: the sound-domain catalog bed by day,
cross-faded into the mystical `night` bed after dark. The five new beds are
generated and auditionable, and nothing plays them automatically —
the maintainer listens first and then says what plays where (2026-08-05:
"I didnt tell you to change the music in the game. Just generate more music").
GENERATING an asset and ROUTING it are two separate decisions.

**Listen at `/#score`** (`scoreAudition.ts`): every bed with what it was written
for, its measured facts, and a button that jumps to the measured loop point so
the seam can be judged in seconds.

`engine/contextMusic.ts` + `engine/bedSelect.ts` hold the routing machinery,
dormant, for when that call is made. A bed only takes the music bus during an
explicit audition (`__ml.audioBed("cave")`, `__ml.audioBed()` to release).
The intended mapping, when it is wanted:

| bed | when | what triggers it |
|---|---|---|
| `battle` | monsters are fighting you | a monster in `mstate` `chase`/`combat` within ~7 cells (the combat brain's own state — a *roaming* monster is scenery however close) |
| `cave` | underground | world@2 deck slabs overhead (≥1.5 levels above your surface, so a bridge you stand ON never counts) |
| `home` | at the spawn bonfire | the campfire proximity the ambience bed already measures — the "you are home" landmark |
| `town` | village / market / farmland | fraction of `road_*`/`farm`/`vineyard`/`mosaic_floor` tiles in earshot |
| `night` | the overworld after dark | sun strength |
| `adventure` | anywhere else | the default, and by far the most-heard track |

Selection (unused until routed) lives in **`engine/bedSelect.ts` as pure functions**, tested in
`test/bedSelect.test.ts` (`npx tsx composer/test/bedSelect.test.ts`), because a
wrong answer is only audible if you stand in the right place on the right map at
the right time of day. Three rules the tests pin:

- **PLACE BEATS TIME.** A town at night is still a town. Night only decides when
  nowhere in particular has a claim — otherwise half the day/night cycle would
  erase every other bed.
- **HYSTERESIS EVERYWHERE.** Every trigger is a Schmitt trigger (`BED_ON` /
  `BED_OFF`) plus a 6 s minimum hold, so standing on a boundary can never make
  the music dither. Battle is the one thing allowed to interrupt instantly.
- **NEVER SILENT.** A bed that has not been generated falls back down a
  documented chain (`BED_FALLBACK`), and an empty chain hands back to the
  sound-domain catalog track — which is exactly the behaviour that shipped
  before the context score existed.

Audition any bed in-game without hunting for its trigger:
`__ml.audioBed("cave")`, and `__ml.audioBed()` to release. `__ml.audioField()`
shows what the score is reading from the world; `__ml.audio().beds` shows what
is loaded, wanted and playing.

### Why these tracks sound like a score and not six mp3s on repeat

All three come out of `music/pipeline/master.py`, and all three are *measured*,
never eyeballed — the numbers land in `music/tracks.json`, which the engine reads.

1. **Loudness matching.** Beds cross-fade into each other, and two takes from the
   same model routinely land 4–6 LU apart; un-matched, every context switch is a
   volume jump. Every bed is normalised to the same ITU-R BS.1770 loudness
   (−18 LUFS) with a true-peak ceiling. **The meter is validated against the
   standard's own calibration tone** — and note that deriving K-weighting from
   the usual RBJ cookbook formulas does *not* reproduce the standard: the shelf
   lands 0.2577 dB low at 997 Hz, which is exactly how far the calibration tone
   then misses −3.01 LKFS. The tabulated 48 kHz coefficients are round-tripped
   through their analog prototype instead.
2. **Measured loop points.** Generated music is never sample-loop-perfect, so
   the seam is *searched for*: the (start, end) pair whose surrounding audio best
   matches in timbre and level, beat-snapped when a tempo is known. The engine
   crossfades exactly there instead of hard-wrapping at end of file.
3. **Position memory.** A bed that fades out remembers where it was and resumes
   there — the maintainer's rule for the night bed ("we only get to listen to the
   start of the song if it restarts each cycle"), now true of all six. Walking in
   and out of town does not restart the town tune.

Key and tempo are measured too, so `gameAudio.clock()` and the tonal-SFX
scale-snap keep working once these beds are the score rather than the catalog
track. Delivery is **opus + AAC**, not mp3: better quality per byte, every
browser covered, one format downloaded per player.

**`title` and `night` are approved takes and are never regenerated.** They are
*adopted* into the same system (`generate.py adopt`) — measured as they stand,
carrying a `trim_db` instead of being re-mastered, so the approved bytes keep
playing. The night bed's shipped loudness is in fact where the shared bed level
comes from: it measures −16.79 LUFS and played at −5 dB, so −18 LUFS at −3.8 dB
reproduces it exactly.

### Regenerating

`composer-theme` workflow (dispatch) with `track` = a name, `new` (the five
context beds) or `all`; or locally with `ELEVENLABS_API_KEY`:

```
python games2/composer/music/pipeline/generate.py new
python games2/composer/music/pipeline/generate.py adopt   # no API key needed
python games2/composer/music/pipeline/test_master.py      # DSP self-test
```

Each track composes from a `/v1/music/plan` **composition plan** (structured
sections) rather than a flat prompt, generates several candidates, and keeps the
best by measured quality — lead-in, loop seam, dead air, dynamics, brightness,
stereo phase. Every candidate's card is kept in `tracks.json` so the choice is
auditable. Budget: the run checks remaining credits and scales candidates down,
never below a floor that would starve the sound/music agents.

To nudge a bed's level **by ear** without regenerating anything, edit its
`trim_db` in `music/tracks.json` and redeploy.

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
