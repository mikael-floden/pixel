# Pixel Music — the score

Background **music** for the game in [`games2/`](../games2). One **domain** of the
multi-domain `pixel` repo; everything lives under `music/`, owned by the
**music agent**.

---

## ⭐ Quality standard

The bar is **film-score-grade game music** — *Lord of the Rings*, *Interstellar*,
Hisaishi. Simple, beautiful, singable melodies over clear baselines; real
orchestral color; soft dynamics that never fatigue on loop. Not stock loops, not
chiptune, not elevator filler. Every track must earn its feeling: home, wonder,
preparation for battle, love, grief, mystery — the brief names the feeling and
the music delivers it.

Engine: **ElevenLabs Music** (`music_v1`) — the strongest promptable
text-to-music API as of 2026 — same account/key as [`sounds/`](../sounds).
Without `ELEVENLABS_API_KEY` the loop records a `blocked` heartbeat and ships
**nothing** (no placeholder audio, same policy as `sounds/`).

---

## What is a track?

One track = **one folder** `music/<id>/`:

```
music/nangijala_cherry_valley/
  nangijala_cherry_valley.wav   the MASTER: mastered 16-bit 44.1 kHz (analysis ground truth)
  nangijala_cherry_valley.ogg   streaming copy, Opus 96 kbps (~1.7 MB) — Chrome/Firefox/Android
  nangijala_cherry_valley.m4a   streaming copy, AAC 128 kbps (~2 MB) — iOS/Safari fallback
  metadata.json                 the full sub-second description (see below)
```

**Phones stream the compressed copies** (`audio.compressed` in the metadata,
`stream` in `viewer_data.json`) — never make a player wait for the 21 MB WAV.
The WAV stays committed as the master and the source for analysis.

Reserved (non-track) entries under `music/`: `README.md`, `config/`, `pipeline/`,
`index.html`, `viewer_data.json`.

## metadata.json — the sync contract (why this domain is useful)

**The metadata is half the deliverable.** A composer-actor, the game agent, or an
effects system must understand a track *without listening to it* — and must be
able to sync gameplay to it at sub-second precision: flash thunder on a musical
peak, pitch footsteps into the track's scale, fade scenes on section boundaries,
pulse light on downbeats.

Schema `music.metadata/v1` (all times in **seconds**, millisecond precision):

| Block | What it gives you |
|---|---|
| `intent` | feeling, narrative, references, where to use the track |
| `musical.key` | root, mode, scale notes, MIDI pitch classes, root Hz, and `sfx_safe_pitch_classes` — the pentatonic subset any SFX can be pitched to without clashing |
| `musical.tempo_bpm`, `time_signature` | authored pulse |
| `structure.sections[]` | name, `start_s`/`end_s` (from the ElevenLabs **composition plan**, exact by construction), measured `intensity` 0–1, description, `sync_hints` |
| `timing.beats_s` / `downbeats_s` | the full beat grid — quantize any rhythmic trigger to these timestamps |
| `timing.tempo` | authored vs **measured** BPM (autocorrelation) + grid anchor |
| `events.onsets_s` (+ strengths) | every audible attack — fire discrete FX exactly on a hit |
| `events.peaks` | the strongest hits — thunder/flash-worthy cue points |
| `dynamics.rms_db` | 50 ms loudness curve (dBFS) — drive continuous effects (light, fog, camera sway) from musical intensity; index = `t / hop_s` |
| `audio.compressed[]` | the streaming copies — file, codec, bitrate, size, mime; pick by `mime` support |
| `layers[]` | intensity layers (see below) — sibling mixes of the same theme with their own audio + metadata |
| `loop` | whether/where to loop and the recommended crossfade |

Sections may carry their own `key` block when a track modulates; when absent,
the track-level `musical.key` applies to the whole track.
| `engine` | full prompt + composition plan (reproducibility) |

### Using it (game side)

```js
const cat  = await (await fetch('/assets/music/viewer_data.json')).json();
const t    = cat.tracks.find(t => t.id === 'nangijala_cherry_valley');
const meta = await (await fetch('/assets/music/' + t.metadata)).json();
// stream a compressed copy (ogg for most, m4a for Safari) — not the WAV master:
const src  = t.stream.ogg && new Audio('').canPlayType(t.stream.ogg.mime)
           ? t.stream.ogg.file : (t.stream.m4a?.file ?? t.file);
const bed  = new Audio('/assets/music/' + src); bed.loop = false; bed.play();

// thunder on the next strong musical hit:
const next = meta.events.peaks.find(p => p.t_s > bed.currentTime);
setTimeout(flashThunder, (next.t_s - bed.currentTime) * 1000);

// pitch a footstep into the track's key (nearest safe pitch class):
const safe = meta.musical.key.sfx_safe_pitch_classes;  // e.g. [2,4,6,9,11]
step.playbackRate = 2 ** (semitoneShiftToNearest(safe, step.basePitch) / 12);

// loop with the recommended seam:
const { loop_start_s, loop_end_s, crossfade_ms } = meta.loop.recommended;
```

`index.html` is a viewer that renders exactly this data (sections, downbeats,
RMS curve) over an audio player — if the viewer looks synced, the game will be.

## Intensity layers (adaptive music)

A **layer** is a sibling mix of the same track at a different intensity —
combat adds war drums to the *same* Cherry Valley theme instead of switching
songs. Layers are composed from the base track's **composition plan** (same
sections, tempo, key and structure by construction) with a per-layer
`style_delta` appended and conflicting negative styles dropped. They live in
`music/<track>/layers/`:

```
music/nangijala_cherry_valley/layers/
  combat.wav / combat.ogg / combat.m4a   full sibling mix, mastered + compressed
  combat.metadata.json                   its own timing/events/dynamics analysis
```

**Honesty note (recorded in `alignment`):** layers are *vertical remix* mixes,
not phase-locked summable stems — generated independently, so don't sum them
with the base. Crossfade full mixes on a downbeat of the destination mix (its
own `timing.downbeats_s`) over ~250–500 ms; the shared tempo/key/structure
keeps the switch musical.

**Add a layer:** append to the track's `layers` in `config/music.json`
(`id`, `name`, `description`, `intensity`, `style_delta`, optional
`global_delta` / `drop_negative`). The loop composes missing layers after all
base tracks exist; each parent `metadata.json` lists its layers with files and
mixing guidance.

## Pipeline (one unit = one track)

1. **Brief** (`config/music.json` → `catalog[]`): feeling, narrative, key, BPM,
   length, a rich cinematic prompt, and the authored section arc with
   `sync_hints`.
2. **Plan**: `POST /v1/music/plan` turns the prompt into a **composition plan**
   — named sections with exact `duration_ms`. The plan is the ground-truth
   timeline; we compose *from* it, so section boundaries in the metadata are
   exact, not estimated.
3. **Compose**: `POST /v1/music` from the plan, `pcm_44100` (lossless) with a
   one-step fallback to MP3. Bytes are sniffed (WAV/MP3/raw PCM) — the API may
   deliver a different container than requested.
4. **Master**: peak-normalize to −1 dBFS + 15 ms edge fades → WAV.
5. **Analyze** (`pipeline/analyze.py`, pure numpy): RMS envelope, spectral-flux
   onsets, autocorrelation tempo (cross-checks the authored BPM), beat grid
   anchored to the first strong onset.
6. **Package**: write `metadata.json`, rebuild `viewer_data.json`, heartbeat →
   commit → push.

## Run it

```bash
pip install -r ../requirements.txt
export ELEVENLABS_API_KEY=...                    # required for real output

python music/pipeline/loop.py --max-minutes 50   # bounded pass (for CI/Routine)
python music/pipeline/loop.py --max-units 1      # one track
python music/pipeline/compose.py <track_id>      # (re)compose one catalog track
python music/pipeline/analyze.py                 # analyzer self-test (offline)
```

The loop is **fully resumable** (next unit = first catalog track without a
`metadata.json`) and respects an AI-credit floor
(`budget.min_ai_credits_remaining` — shared account with `sounds/`).

**Add a track:** append a brief to `config/music.json` → `catalog`. Name the
feeling, the narrative, the key/BPM (they go into the prompt *and* the
metadata), the section arc with per-section `sync_hints`, and references.

### On a schedule / on demand (durable)

[`.github/workflows/music.yml`](../.github/workflows/music.yml) runs the loop
via **workflow_dispatch** (schedule intentionally off, like `sounds/`) using the
`ELEVENLABS_API_KEY` Actions secret. It generates on whatever branch it is
dispatched on and pushes back to it.

## Coordinating with the other agents

This domain owns `music/` and writes only `coordination/music.json` (per
[`coordination/PROTOCOL.md`](../coordination/PROTOCOL.md)). Want a track for a
scene, a boss, a feeling? Post a request:

```bash
python coordination/board.py post <you> --to music --text "need: tense cave-exploration bed, ~2 min, loopable"
```

The music agent reads its inbox at the start of every run and turns requests
into catalog briefs.

## Guardrails

- **Never commit secrets** — the key lives in the environment / Actions secret.
- **No placeholder audio.** Blocked ≠ ship junk (lesson inherited from
  `sounds/` v1 post-mortem).
- Metadata honesty: measured values are marked measured, authored values
  authored, estimates `approximate` — never present a guess as ground truth.
