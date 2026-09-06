# Pixel Music — the score

> *Kondo was free to write Gerudo Valley one hour and a music-box lullaby the
> next.* — the creed of this domain, in one sentence (the owner's idea).

Background **music** for the game in [`games2/`](../games2). One **domain** of
the multi-domain `pixel` repo; everything lives under `music/`, owned by the
**music agent**.

## Quality standard

The bar is **film-score-grade game music** — *Lord of the Rings*,
*Interstellar*, Hisaishi: simple singable melodies over clear baselines, real
orchestral color, soft dynamics that never fatigue on loop. Not stock loops,
not chiptune. The brief names the feeling (home, wonder, grief, mystery…) and
the music delivers it.

**No melody is forbidden — and no style is the house style** (maintainer
decision). Never converge on a formula, not even one that landed well: each
brief starts from the *place and feeling* and picks whatever instruments,
scale, and idiom serve it — a flamenco gallop, a music-box lullaby, a
five-note motif, a dread-drone can all live in one score (Ocarina of Time is
the proof). When a place deserves near-silence and one lonely instrument,
write that.

Engine: **ElevenLabs Music** (`music_v1`), same account/key as
[`sounds/`](../sounds). Without `ELEVENLABS_API_KEY` the loop records a
`blocked` heartbeat and ships **nothing** — no placeholder audio (law
inherited from the sounds v1 rejection).

## What is a track?

One track = **one folder** `music/<id>/`:

```
music/nangijala_cherry_valley/
  nangijala_cherry_valley.wav   the MASTER: mastered 16-bit 44.1 kHz (analysis ground truth)
  nangijala_cherry_valley.ogg   streaming copy, Opus 96 kbps (~1.7 MB) — Chrome/Firefox/Android
  nangijala_cherry_valley.m4a   streaming copy, AAC 128 kbps (~2 MB) — iOS/Safari fallback
  metadata.json                 the full sub-second description (below)
```

**Players stream the compressed copies** (`audio.compressed` in metadata,
`stream` in `viewer_data.json`) — never the ~21 MB WAV. The WAV stays
committed as master and analysis source, but `music/**/*.wav` is excluded
from the deployed game image via the root `.dockerignore` (~61 MB saved).

Reserved (non-track) entries under `music/`: `README.md`, `config/`,
`pipeline/`, `index.html`, `viewer_data.json`.

## metadata.json — the sync contract

**The metadata is half the deliverable**: the composer / game must understand
a track *without listening* and sync gameplay to it at sub-second precision
(thunder on a peak, footsteps pitched into key, fades on section boundaries).

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
| `dynamics.rms_db` | 50 ms loudness curve (dBFS) — drive continuous effects from musical intensity; index = `t / hop_s` |
| `audio.compressed[]` | the streaming copies — file, codec, bitrate, size, mime; pick by `mime` support |
| `layers[]` | intensity layers (below) — sibling mixes with their own audio + metadata |
| `loop` | whether/where to loop and the recommended crossfade |
| `engine` | full prompt + composition plan (reproducibility) |

Sections may carry their own `key` block when a track modulates; absent, the
track-level `musical.key` applies throughout.

### Using it (game side)

```js
const cat  = await (await fetch('/assets/music/viewer_data.json')).json();
const t    = cat.tracks.find(t => t.id === 'nangijala_cherry_valley');
const meta = await (await fetch('/assets/music/' + t.metadata)).json();
// stream a compressed copy (ogg for most, m4a for Safari) — never the WAV:
const src  = t.stream.ogg && new Audio('').canPlayType(t.stream.ogg.mime)
           ? t.stream.ogg.file : (t.stream.m4a?.file ?? t.file);
const bed  = new Audio('/assets/music/' + src); bed.play();

// thunder on the next strong musical hit:
const next = meta.events.peaks.find(p => p.t_s > bed.currentTime);
setTimeout(flashThunder, (next.t_s - bed.currentTime) * 1000);

// pitch a footstep into the track's key (nearest safe pitch class):
const safe = meta.musical.key.sfx_safe_pitch_classes;  // e.g. [2,4,6,9,11]
step.playbackRate = 2 ** (semitoneShiftToNearest(safe, step.basePitch) / 12);

// loop with the recommended seam:
const { loop_start_s, loop_end_s, crossfade_ms } = meta.loop.recommended;
```

`index.html` renders exactly this data (sections, downbeats, RMS curve) over
a player — if the viewer looks synced, the game will be.

## Intensity layers (adaptive music)

A **layer** is a sibling mix of the same track at a different intensity —
combat adds war drums to the *same* theme instead of switching songs.
Composed from the base track's **composition plan** (same sections, tempo,
key, structure by construction) with a per-layer `style_delta` appended and
conflicting negative styles dropped. Files:
`music/<track>/layers/<id>.wav/.ogg/.m4a` + `<id>.metadata.json` (own
timing/events/dynamics analysis).

**Layers are *vertical remix* mixes, NOT phase-locked summable stems**
(generated independently — recorded honestly in `alignment`). Never sum a
layer with its base: crossfade full mixes on a downbeat of the destination
mix (its own `timing.downbeats_s`) over ~250–500 ms; shared tempo/key/
structure keeps the switch musical.

**Add a layer:** append to the track's `layers` in `config/music.json`
(`id`, `name`, `description`, `intensity`, `style_delta`, optional
`global_delta` / `drop_negative`). The loop composes missing layers after all
base tracks exist; each parent `metadata.json` lists its layers with mixing
guidance.

## Pipeline (one unit = one track)

1. **Brief** (`config/music.json` → `catalog[]`): feeling, narrative, key,
   BPM, length, a rich cinematic prompt, section arc with `sync_hints`.
2. **Plan**: `POST /v1/music/plan` → a **composition plan** (named sections
   with exact `duration_ms`) — the ground-truth timeline; composing *from* it
   makes metadata section boundaries exact, not estimated.
3. **Compose**: `POST /v1/music` from the plan, `pcm_44100` (lossless) with a
   one-step MP3 fallback. Bytes are sniffed (WAV/MP3/raw PCM) — the API may
   deliver a different container than requested.
4. **Master**: peak-normalize to −1 dBFS + 15 ms edge fades → WAV.
5. **Analyze** (`pipeline/analyze.py`, pure numpy): RMS envelope,
   spectral-flux onsets, autocorrelation tempo (cross-checks the authored
   BPM), beat grid anchored to the first strong onset.
6. **Package**: write `metadata.json`, rebuild `viewer_data.json`, heartbeat
   → commit → push.

## Run it

```bash
pip install -r ../requirements.txt
export ELEVENLABS_API_KEY=...                    # required for real output

python music/pipeline/loop.py --max-minutes 50   # bounded pass (CI/Routine)
python music/pipeline/loop.py --max-units 1      # one track
python music/pipeline/compose.py <track_id>      # (re)compose one catalog track
python music/pipeline/analyze.py                 # analyzer self-test (offline)
```

Fully resumable (next unit = first catalog track without `metadata.json`);
respects the AI-credit floor `budget.min_ai_credits_remaining` (shared
account with `sounds/`).

**Add a track:** append a brief to `config/music.json` → `catalog`: feeling,
narrative, key/BPM (they go into the prompt *and* the metadata), section arc
with per-section `sync_hints`, references.

⚠️ **Prompts must never name real artists, composers, or works** — the
engine's TOS filter rejects them with a 400 ("Koji Kondo's Gerudo Valley"
killed a composition). Describe the *style*; keep homages in the brief's
`references` field, which is documentation only and never sent to the API.

**Schedule:** [`.github/workflows/music.yml`](../.github/workflows/music.yml)
runs via **workflow_dispatch** (schedule intentionally off, like `sounds/`)
with the `ELEVENLABS_API_KEY` Actions secret; it generates on whatever branch
it is dispatched on and pushes back to it.

## Coordination

This domain owns `music/` and writes only `coordination/music.json` (per
[`coordination/PROTOCOL.md`](../coordination/PROTOCOL.md)). Want a track for
a scene, boss, or feeling? Post a request:

```bash
python coordination/board.py post <you> --to music --text "need: tense cave-exploration bed, ~2 min, loopable"
```

The music agent reads its inbox at the start of every run and turns requests
into catalog briefs.

## Guardrails

- **Never commit secrets** — the key lives in the environment / Actions secret.
- **No placeholder audio.** Blocked ≠ ship junk.
- **Metadata honesty**: measured values marked measured, authored authored,
  estimates `approximate` — never present a guess as ground truth.

## The score (`music/beds/`) — suites, pools and phrases

Generated by `music/pipeline/score/generate.py` (ElevenLabs Music), designed in
`MUSIC_DESIGN.md`, briefed by data in `music/briefs/<suite>.json`.

- `music/tracks.json` — the manifest, with `root` naming where its audio lives
  (`music/beds`). Consumers JOIN it. It carries every measurement the game and
  the wiki use: duration, measured tempo and key, loop points, loudness, the
  phrase grid, and `versions[]` — the archived takes.
- `music/beds/pool/` — THE ARCHIVE. Every take ever generated, never
  overwritten, kept so the maintainer can swap one back in. It is wiki content,
  not game content: excluded from the image in `games2/config/publish.json`
  and streamed from the repo by the wiki.
- `music/briefs/` — a campaign is a diff. Every colour ever written stays in
  the file even after one is chosen.

A SUITE is a compatibility group: one key, one tempo, one phrase length, so any
phrase can follow any other. Crossing between suites is SILENCE, never a
musical transition. The full design is in `MUSIC_DESIGN.md`.
