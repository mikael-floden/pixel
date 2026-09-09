# Audio in the game — roles & the sound → composer handoff

Decision (owner: product): audio is split into **two producers + one
integrator**.

| Role | Actor | Location | Owns |
|---|---|---|---|
| **SFX + ambience production** | **sound actor** | `sounds/` | the assets + the sound contract (`viewer_data.json`, `bindings.json`) |
| **Music production** | **musician actor** | `music/` | score / adaptive-layer tracks + their contract |
| **Integration + mixing into the world** | **composer actor** | `games2/composer` | binds sound + music to gameplay, mixes buses, ducking, adaptive music — the AudioManager |
| **Gameplay + events** | **game agent** | rest of `games2/` | emits semantic audio events; owns game logic |

The **composer** is the single owner of "does the game sound good
end-to-end". It lives inside `games2/` (mixing is bound to the running
game), is the only writer of `games2/composer`, and **consumes** the
producers' contracts; the producers never write game code. The game calls
the composer only through the `gameAudio` facade
(`gameAudio.event("item.pickup")`, `avatarFrame(...)`, `setEnv(...)` — the
full API table is in `games2/composer/README.md`).

## The sound actor's boundary

The sound actor stops at the **contract** — it does not bind or mix. It owns:
- **Assets:** `sounds/<category>/<id>/` (one-shots + ambience loops),
  mastered, with compressed delivery copies (`AUDIO_FORMATS.md`).
- **`sounds/viewer_data.json`** — every sound with `feel`, `mix_gain_db`,
  `variation`, `loop`, `delivery`, file paths (served at
  `/assets/sounds/...`).
- **`sounds/bindings.json`** — **recommended** event → sound + playback
  rules. *Intent, not authority*: the composer decides the final mix and may
  override — and the engine is silent-by-default, resolving bindings only
  for its approved names (`games2/composer/README.md`). Keep it in sync with
  the catalog.

## What the composer consumes

1. **`sounds/<category>/<id>/metadata.json`** — the per-asset contract
   (shared convention with `music/`): `feel`, `mix_gain_db`, `variation`,
   and — **measured from the rendered audio** — `music` (tonal?, root_midi,
   pitch_confidence, max_shift_semitones, scale_snap_replaces_jitter) +
   `envelope` + `sync_points`. Full schema: [`METADATA.md`](METADATA.md).
2. `sounds/viewer_data.json` — the rolled-up index.
3. `sounds/bindings.json` — the recommendations.
4. Assets under `/assets/sounds/<category>/<id>/…` (WAV master + `.m4a`/
   `.ogg` delivery takes).

**Scale-matched SFX**: the composer snaps a tonal SFX's `root_midi` to the
current music key (`playbackRate = 2^(semitones/12)`, clamped to
`max_shift_semitones`); snapping **replaces** the random pitch-jitter, and
**atonal foley is never shifted**. Timing sync hangs off `sync_points`
aligned to the music domain's beat grid.

## Coordination

- Sound → composer: publish + maintain the contract; requests/acks via
  `coordination/board.py` (the sound actor writes only
  `coordination/sounds.json`).
- Composer ↔ game: one-writer on `games2/composer`; the event interface is
  the `gameAudio` facade.
- Sound ↔ musician: shared vocabulary (`metadata.json` convention,
  `root_midi` MIDI numbers A4=69, region/mood tags) so the composer can mix
  SFX and music coherently.
