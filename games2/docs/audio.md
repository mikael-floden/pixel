# Audio

The composer binding: how game code talks to the audio agent module. Moved verbatim out of `games2/CLAUDE.md` (2026-09-09), which keeps the law and points here; the measurements, traps and rejected approaches live in this file. Rewrite in place under the root doc law.

## Audio (games2/composer — the games-audio agent's module)

- A THIRD agent works `games2/`: **games-audio** (the composer;
  `sounds/spec/AUDIO_INTEGRATION.md`), sole owner of `games2/composer/` +
  `coordination/games-audio.json`. It binds `sounds/` + `music/` to the game:
  WebAudio buses, surface footsteps at gait cadence, thunder, ambience, the
  looping score with ducking/night dip, scale-snapped tonal SFX. See
  `composer/README.md`.
- Game code talks to it ONLY via the `gameAudio` singleton — the calls
  sprinkled in WorldScene/hud.ts/main.ts/ambient/thunder are the audio
  agent's wiring; **don't remove them**, and emit new semantic events
  (`gameAudio.event("item.get")`, names from `sounds/bindings.json`) when
  adding gameplay that should sound.
- **Music beds generated but NOT routed**: five tracks (battle/cave/home/
  town/adventure) audition at `/#score`; the in-world score is unchanged
  until the maintainer picks what plays where. Routing is dormant in
  `composer/engine/contextMusic.ts`; selection is pure and tested
  (`composer/engine/bedSelect.ts` + test): priority + Schmitt hysteresis,
  PLACE BEATS TIME, fallback chain to the catalog track (never silence).
  When wired: battle reads the monster brain's `mstate` (chase/combat — a
  roaming monster scores zero), cave reads deck slabs overhead, home the
  spawn bonfire, town road/farm tiles. Beds are −18 LUFS with measured loop
  points and resume where they left off. Probes: `__ml.audioBed("cave")` /
  `__ml.audioBed()` / `__ml.audioField()`. Gate: scripts/verify-beds.mjs.
- **A SOUND PLAYS ONLY WHEN ASKED FOR — the wiki is where it gets asked**
  (maintainer). The engine is silent-by-default: an event plays NOTHING
  unless (a) on the small approved list (jump/fall grunts, UI clicks, chat
  notify) or (b) assigned by the Game Master in the wiki (requests land in
  `live/tuning/sfx_requests.json`; the composer wires them into
  `EVENT_ASSIGNMENTS` in `composer/engine/api.ts` and deletes the acted-on
  entry IN THE SAME COMMIT — a request is a message, not a record). The
  record of what an assigned event plays is **`composer/assignments.json`**
  (`pixel-composer-assignments@1`, built by `scripts/build-assignments.mjs`,
  staleness-gated by verify-quiet) — read THAT, never fall back to
  `EVENT_FOLEY`/`bindings.json` to describe an assigned event (they are
  outranked; showing one looks like a revert). `bindings.json` resolves only
  for `BINDINGS_APPROVED` names. **Emit semantic events freely** with
  LITERAL names (the wiki scans call sites; a ternary hides the name) —
  silent events are exactly what the GM assigns sounds to. Already emitted:
  combat.kick/.punch/.hit_taken/.monster_die/.cross_on/.cross_off,
  player.die, item.pickup, item.drop. Gate: scripts/verify-quiet.mjs (the
  can-sound surface must not grow without approval; the assignable events
  must keep being emitted).
- **Background**: hidden page → master ducks to 50%, the score keeps looping
  (native-loop handoff in composer/engine/music.ts — background timer
  throttling killed the crossfade scheduler). Gate: verify-background.mjs.
- `gameAudio.clock()` / `__ml.audioClock()` publishes live beat/bar phase +
  section intensity (context beds carry measured key + tempo, so tonal-SFX
  scale-snap keeps working). QA: `__ml.audio()`; scripts/verify-audio.mjs
  (dev stack, end to end).
