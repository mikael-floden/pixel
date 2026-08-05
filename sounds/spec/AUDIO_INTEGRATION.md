# Audio in the game — roles & the sound → composer handoff

Decision (owner: product): audio is split into **two producers + one integrator**.

| Role | Actor | Location | Owns |
|---|---|---|---|
| **SFX + ambience production** | **sound actor** (me) | `sounds/` | the assets + the sound contract (`viewer_data.json`, `bindings.json`) |
| **Music production** | **musician actor** | `music/` (or its domain) | score / stems / adaptive-layer cues + its contract |
| **Integration + mixing into the world** | **composer actor** | `games2/composer` | binds sound + music to gameplay, mixes buses, ducking, reverb zones, adaptive music — the AudioManager |
| **Gameplay + events** | **game agent** | rest of `games2/` | emits semantic audio events; owns game logic |

The **composer** is the single owner of "does the game sound good end-to-end." It
lives inside `games2/` (mixing is bound to the running game, like the `games-ui`
actor) and is the only writer of `games2/composer`. It **consumes** the producers'
contracts; the producers never write game code.

## My boundary as the sound actor

I stop at the **contract**. I do NOT bind or mix — that's the composer's job. I own:
- **Assets:** `sounds/<category>/<id>/` (SFX one-shots + ambience loops), mastered.
- **`sounds/viewer_data.json`** — every sound with `feel`, `mix_gain_db`, `variation`
  (round-robin + jitter ranges), `loop`, file paths (served at `/assets/sounds/...`).
- **`sounds/bindings.json`** — my **recommended** event → sound + playback rules
  (which sound for which event, bus, round-robin vs one-shot, reverb-zone + ducking
  hints, region ambience). This is *intent*, not authority: the **composer decides
  the final mix** and may override. I keep it in sync with the catalog.

## What the composer consumes from me

1. **`sounds/<category>/<id>/metadata.json`** — the per-asset contract (shared
   `metadata.json` convention with the `music/` domain). Carries `feel`,
   `mix_gain_db`, `variation`, and — **measured from the rendered audio** — a
   `music` block (tonal? root_midi, pitch_confidence, max_shift_semitones,
   scale_snap_replaces_jitter) and `envelope` + `sync_points` (sub-second timing).
   Full schema: [`METADATA.md`](METADATA.md).
2. `sounds/viewer_data.json` — the rolled-up index of all per-asset metadata.
3. `sounds/bindings.json` — recommended event → sound + playback rules (turnkey).
4. Assets under `/assets/sounds/<category>/<id>/…` (WAV; primary take + variants).

**Scale-matched SFX** (the "same-scale" feature): the composer reads `music` to
snap a tonal SFX's `root_midi` to the current music key (`playbackRate =
2^(semitones/12)`, clamped to `max_shift_semitones`); snapping **replaces** the
random pitch-jitter, and **atonal foley is never shifted**. Timing sync hangs off
`sync_points` aligned to the music domain's beat grid.

The composer combines this with the musician's music contract, negotiates the
event names / interface with the game agent (e.g. a stable `AudioBus` the game calls:
`audio.event("item.coin_pickup", {surface,position})`, `audio.setRegion(region,time,weather)`),
and owns round-robin, jitter, ducking, reverb zones, distance/occlusion, and
adaptive music layering.

## Coordination

- Sound → composer: I publish + maintain the contract; requests/acks via
  `coordination/board.py` (I write only `coordination/sounds.json`).
- Composer ↔ game: the composer negotiates its module path + event interface with
  the game agent (one-writer on `games2/composer`).
- Sound ↔ musician: align on shared vocabulary (region/mood tags, ducking) so the
  composer can mix SFX and music coherently.
