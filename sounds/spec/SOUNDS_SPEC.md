# Sounds domain — design spec

Design note for the `sounds/` domain: how sound effects are generated, the
on-disk contract, and how another agent (the game / the composer) consumes
them. Day-to-day "how do I run it / add a sound": `sounds/README.md`.

## Goal

**AAA / cinematic sound effects** for the game in `games2/` — UI, item, tool,
movement, combat, feedback foley + ambience loops at the quality bar of a
flagship console/film title. Not retro, not indie placeholder.

## The engine

1. **ElevenLabs Sound Effects v2 (REQUIRED)** — the promptable-foley quality
   leader (`POST /v1/sound-generation`, `eleven_text_to_sound_v2`,
   `pipeline/elevenlabs_client.py`). Needs `ELEVENLABS_API_KEY`. The
   configured `output_format` is `mp3_44100_192` (this key tier delivers
   MP3; lossless `pcm_48000` needs a higher tier); the factory decodes and
   **masters** each take once (`pipeline/postprocess.py`: trim → fade →
   −1 dBFS normalize) to a 48 kHz mono WAV.
2. **Procedural sfxr (REJECTED — do not revive as a deliverable)**:
   chiptune synthesis has a hard quality ceiling; v1 shipped it and every
   clip was rejected. `pipeline/sfxr.py` survives only as the offline
   pipeline-test placeholder (`--engine placeholder`), tagged
   `rejected-lowfi`, never shipped.

Other options, for the record: Stable Audio — best for long ambient beds
(planned second engine); licensed pro libraries + a human designer are the
absolute ceiling for hero sounds and drop straight into the same manifest
format.

## On-disk contract

```
sounds/
  config/sounds.json        the catalog (sound specs) + engine/audio config
  pipeline/                 clients, factory, loop, analyze, encode, viewer
  <category>/<id>/          ONE sound per folder
                            (category ∈ ui|item|tool|movement|combat|feedback|ambience)
    <id>__take01.wav …      mastered 48 kHz mono WAV takes (take 1 = primary)
    <id>__take01.m4a/.ogg   compressed delivery copies per take (AUDIO_FORMATS.md)
    metadata.json           the manifest (the contract; read this)
  viewer_data.json          rolled-up index of every sound
  index.html                phone-friendly gallery
```

Every path in a manifest is **repo-relative** and starts with the category,
so it resolves the same on disk or over HTTP (`/assets/sounds/...`).

### `metadata.json` fields

| Field | Meaning |
|-------|---------|
| `id`, `name`, `category`, `description`, `tags`, `usage` | what the sound is + when to play it |
| `engine` | `ai` (shippable) or `procedural` (rejected-lowfi placeholder) |
| `quality` | `aaa` or `rejected-lowfi` |
| `loop` | whether it is intended to loop |
| `file`, `format`, `takes` | primary take path + format + all take paths |
| `audio` | duration, sample rate, channels, bit depth, peak dBFS, requested vs delivered format |
| `delivery` | compressed formats (`m4a`/`ogg`) + `web_source_order` — see `AUDIO_FORMATS.md` |
| `ai` | `{provider, model_id, prompt, prompt_influence, loop, variants}` |
| `mastering` | the post-processing applied (trim + normalize + fades) |
| `feel`, `mix_gain_db`, `variation` | composer-facing: emotional intent, SFX-vs-music balance, anti-repetition (round-robin + jitter) |
| `music` | **MEASURED** pitch/tonality: `{tonal, root_midi, note, pitch_confidence, max_shift_semitones, scale_snap_replaces_jitter, ...}` — lets the composer scale-match tonal SFX to the music's key (never foley) |
| `envelope`, `sync_points` | **MEASURED** sub-second timing (onset/peak/attack) + named trigger points for effect sync |
| `source` | free-text provenance |

> Full per-asset schema (shared with `music/`, consumed by the composer):
> [`METADATA.md`](METADATA.md). Musical/timing fields are **measured from
> the rendered audio** (`pipeline/analyze.py`), never written from
> intention.

## Quality & mastering

Every shipped clip is `quality: "aaa"`, mastered to −1 dBFS peak with edge
fades. With `variants > 1`, all takes are kept so a human can pick the best
(take 1 = primary). Each take stem also ships `.m4a` + `.ogg`
(`pipeline/encode.py`); the loop backfills these for pre-delivery WAVs at
startup.

## The loop

`pipeline/loop.py` — each **unit** is one sound: first catalog entry without
audio → generate → master → encode → manifest → rebuild `viewer_data.json` →
`coordination/sounds.json` heartbeat → commit + push. Fully resumable
(filesystem-derived); bounded by `--max-units` / `--max-minutes`; respects
the credit floor (`budget.min_ai_credits_remaining`). **Without
`ELEVENLABS_API_KEY` it blocks** — a `blocked` heartbeat, zero output,
rather than shipping low-fi.

## Coordination

Per `coordination/PROTOCOL.md`: this domain owns `sounds/` and writes only
`coordination/sounds.json`. Consumers read `viewer_data.json` to map
events → clips; requests addressed to `sounds` are picked up at run start
(`coordination/board.py inbox sounds`).

## Extending

- **Add a sound:** append to `config/sounds.json → catalog` (`id`, `name`,
  `category`, `description`, `tags`, `ai_prompt` — a rich material-rich
  foley brief — `duration_hint`, `usage`; optional `variants`, `loop`,
  `prompt_influence`). The loop picks it up next run.
- **Raise quality:** tune the per-sound `ai_prompt` (material + intensity +
  detail) and the catalog-wide `engine.ai.prompt_directives`; bump
  `variants`; for hero sounds, drop human/licensed foley WAVs into the
  folder — the manifest format is engine-agnostic.
