# Sounds domain — design spec

This is the design note for the `sounds/` domain: how sound effects are generated,
what the on-disk contract is, and how another agent (the game) consumes them. For
the day-to-day "how do I run it / add a sound" guide, see `sounds/README.md`.

## Goal

Produce **AAA / cinematic sound effects** for the game in `games/` — UI, item,
tool, movement, combat and feedback foley at the quality bar of a flagship
console/film title (Zelda, God of War, *Lord of the Rings*). Not retro, not indie
placeholder. See the README's Quality standard + post-mortem.

## Why this engine (the research, take 2)

**v1 used procedural synthesis (sfxr) and it was rejected** — a chiptune
oscillator has a hard quality ceiling and cannot produce realistic foley (see the
README post-mortem). The corrected design is **quality-first**:

1. **AI text-to-SFX — ElevenLabs Sound Effects v2 (REQUIRED, the quality engine).**
   The 2026 leader for realistic, promptable foley — rated indistinguishable from
   recorded foley in blind tests — with lossless **48 kHz** output
   (`POST /v1/sound-generation`, `eleven_text_to_sound_v2`,
   `pipeline/elevenlabs_client.py`). Needs `ELEVENLABS_API_KEY` (Pro tier for
   `pcm_48000`). We request lossless PCM, generate multiple takes, and **master**
   each locally (`pipeline/postprocess.py`: trim → fade → −1 dBFS normalize).

2. **Procedural sfxr (REJECTED, `pipeline/sfxr.py`).** Retained only as an offline
   pipeline-test placeholder (`--engine placeholder`); output is quality-tagged
   `rejected-lowfi` and never shipped.

Other options: **Stable Audio** (Stability) — slightly behind ElevenLabs on precise
foley but best for long ambient beds (planned second engine); Meta *AudioBox/
AudioGen* (self-host, GPU); licensed pro libraries + a human sound designer are the
absolute ceiling for hero sounds and drop straight into the same manifest format.

## On-disk contract

```
sounds/
  config/sounds.json        the catalog (list of sound specs) + engine/audio config
  pipeline/                 sfxr synth, elevenlabs client, factory, loop, viewer
  <category>/<id>/          ONE sound per folder (category ∈ ui|item|tool|movement|combat|feedback)
    <id>.wav                AAA AI output: mastered 48 kHz mono WAV (primary take)
    <id>__take01.wav …      extra takes when variants > 1 (human picks the best)
    metadata.json              the manifest (the contract; read this)
  viewer_data.json          rolled-up index of every sound (for games / the viewer)
  index.html                phone-friendly gallery with audio players
```

Every path in a manifest is **repo-relative** and starts with the category, so it
resolves the same on disk or over HTTP.

### `metadata.json` fields

| Field | Meaning |
|-------|---------|
| `id`, `name`, `category`, `description`, `tags`, `usage` | what the sound is + when to play it |
| `engine` | `ai` (shippable) or `procedural` (rejected-lowfi placeholder) |
| `quality` | `aaa` or `rejected-lowfi` |
| `loop` | whether it is intended to loop |
| `file`, `format`, `takes` | primary take path + `wav`/`mp3` + all take paths |
| `audio` | duration, sample rate (48 kHz), channels, bit depth, peak dBFS |
| `ai` | `{provider, model_id, prompt, prompt_influence, loop, variants}` |
| `mastering` | the post-processing applied (trim + normalize + fades) |
| `feel`, `mix_gain_db`, `variation` | composer-facing: emotional intent, SFX-vs-music balance, anti-repetition (round-robin + jitter) |
| `music` | **MEASURED** pitch/tonality: `{tonal, root_midi, note, pitch_confidence, max_shift_semitones, scale_snap_replaces_jitter, ...}` — lets the composer scale-match tonal SFX to the music's key (never foley) |
| `envelope`, `sync_points` | **MEASURED** sub-second timing (onset/peak/attack) + named trigger points for effect sync |
| `source` | free-text provenance |

> Full per-asset schema (shared with the `music/` domain, consumed by the composer):
> [`METADATA.md`](METADATA.md). Musical/timing fields are **measured from the
> rendered audio** (`pipeline/analyze.py`), never written from intention.

## Quality & mastering

Every shipped clip is `quality: "aaa"`. The AI returns lossless 48 kHz PCM; the
factory wraps it to WAV and masters it (`pipeline/postprocess.py`): trim silence →
short raised-cosine edge fades (de-click) → peak-normalize to −1 dBFS. With
`variants > 1`, all takes are kept so a human can pick the best (take 1 = primary).
The `procedural` engine is a rejected offline placeholder only and is never shipped.

## The loop

`pipeline/loop.py` — each **unit** is one sound. It reads the filesystem for the
first catalog entry without audio, generates it with the AAA AI engine, masters +
writes the manifest, rebuilds `viewer_data.json`, refreshes the
`coordination/sounds.json` heartbeat, then commits + pushes. Fully **resumable**;
bounded by `--max-units` / `--max-minutes`; respects a credit floor
(`budget.min_ai_credits_remaining`). **Without `ELEVENLABS_API_KEY` it blocks** —
it writes a `blocked` heartbeat and generates nothing rather than ship low-fi.

## Coordination

Per `coordination/PROTOCOL.md`: this domain owns `sounds/` and writes only its own
`coordination/sounds.json` heartbeat. The game agent reads `viewer_data.json` to
map events → clips. Requests addressed to `sounds` (e.g. "need a fishing-reel
sound") are picked up at the start of each run via `coordination/board.py inbox
sounds`.

## Extending

- **Add a sound:** append an entry to `config/sounds.json → catalog`
  (`id`, `name`, `category`, `description`, `tags`, `ai_prompt` — a rich
  material-rich foley brief — `duration_hint`, `usage`; optional `variants`,
  `loop`, `prompt_influence`). The loop picks it up on the next run.
- **Raise quality further:** tune the per-sound `ai_prompt` (material + intensity +
  detail) and the catalog-wide `engine.ai.prompt_directives`; bump `variants` for
  more takes to choose from; for hero sounds, drop human/licensed foley WAVs into
  the folder — the manifest format is engine-agnostic.
