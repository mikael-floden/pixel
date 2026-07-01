# Sounds domain — design spec

This is the design note for the `sounds/` domain: how sound effects are generated,
what the on-disk contract is, and how another agent (the game) consumes them. For
the day-to-day "how do I run it / add a sound" guide, see `sounds/README.md`.

## Goal

Produce **game-ready sound effects** for the pixel RPG built in `games/` — UI
blips, item pickups, tool swings, footsteps, combat hits, feedback jingles — in a
style that matches the pixel art (`characters/`, `objects/`, `tiles/`, `maps/`).

## Why these engines (the research)

Two families dominate SFX generation in 2026, and this domain uses **both**, with
a deliberate default:

1. **Procedural synthesis — the sfxr / bfxr family (DEFAULT).**
   DrPetter's *sfxr* is the de-facto standard for retro / 8-bit game SFX: a small
   oscillator → envelope → filter → phaser chain driven by ~24 parameters, with
   battle-tested presets (`pickupCoin`, `laserShoot`, `explosion`, `powerUp`,
   `hitHurt`, `jump`, `blipSelect`). It is **free, offline, deterministic, and
   needs no API key**, so it runs in CI today and every result is reproducible
   from `(preset, seed)`. Ported to pure Python in `pipeline/sfxr.py`. This suits
   a pixel game stylistically and removes any dependency/secret risk.

2. **AI text-to-SFX — ElevenLabs Sound Effects (OPTIONAL upgrade).**
   As of 2026 the market leader for turning a text prompt into a *realistic /
   foley* effect (`POST /v1/sound-generation`, `eleven_text_to_sound_v2`). Higher
   fidelity than synthesis but hosted + paid. Wired up in
   `pipeline/elevenlabs_client.py` and used automatically when `ELEVENLABS_API_KEY`
   is set (or `--engine ai`). Each catalog entry already carries an `ai_prompt`,
   so switching engines re-renders the same catalog as foley with no other change.

Other options considered: Stability's *Stable Audio* (music-leaning), Meta's
*AudioCraft/AudioGen* (self-host, GPU + model weights), and game-focused APIs
(Ludo, Optimizer AI). ElevenLabs won the "best hosted AI SFX" slot on breadth and
prompt control; sfxr won the "always-works default" slot on cost/determinism.

## On-disk contract

```
sounds/
  config/sounds.json        the catalog (list of sound specs) + engine/audio config
  pipeline/                 sfxr synth, elevenlabs client, factory, loop, viewer
  <category>/<id>/          ONE sound per folder (category ∈ ui|item|tool|movement|combat|feedback)
    <id>.wav                procedural output (16-bit mono PCM WAV, 44.1 kHz)
    <id>.mp3                AI output (mp3_44100_128) — only when generated via AI
    sound.json              the manifest (the contract; read this)
  viewer_data.json          rolled-up index of every sound (for games / the viewer)
  index.html                phone-friendly gallery with audio players
```

Every path in a manifest is **repo-relative** and starts with the category, so it
resolves the same on disk or over HTTP.

### `sound.json` fields

| Field | Meaning |
|-------|---------|
| `id`, `name`, `category`, `description`, `tags`, `usage` | what the sound is + when to play it |
| `engine` | `procedural` or `ai` |
| `loop` | whether it is intended to loop |
| `license` | `CC0-1.0` for procedural output |
| `file`, `format` | repo-relative audio path + `wav`/`mp3` |
| `audio` | duration, sample rate, channels, bit depth (procedural) / bytes + format (AI) |
| `procedural` | `{family, preset, seed, params, reproduce}` — exact sfxr params; paste into jsfxr/bfxr, or `regen` to reproduce byte-for-byte |
| `ai` | `{provider, model_id, prompt, prompt_influence, loop}` — for AI output |
| `source` | free-text provenance |

## Determinism & reproducibility

Procedural sounds are a pure function of the spec: the seed is derived from the id
(`sha256`), then re-rolled deterministically if a seed yields an inaudibly short
clip (below `min_duration`, default 0.14 s; footsteps opt lower). The chosen seed
is stored in the manifest and `pipeline/regen.py <id>` reproduces the identical
WAV. Change a seed/preset/params in `config/sounds.json` and re-run to re-roll.

## The loop

`pipeline/loop.py` — each **unit** is one sound. It reads the filesystem for the
first catalog entry without audio, generates it (procedural or AI), writes the
manifest, rebuilds `viewer_data.json`, refreshes the `coordination/sounds.json`
heartbeat, then commits + pushes. Fully **resumable**; bounded by
`--max-units` / `--max-minutes`. The AI engine additionally respects a credit
floor (`budget.min_ai_credits_remaining`).

## Coordination

Per `coordination/PROTOCOL.md`: this domain owns `sounds/` and writes only its own
`coordination/sounds.json` heartbeat. The game agent reads `viewer_data.json` to
map events → clips. Requests addressed to `sounds` (e.g. "need a fishing-reel
sound") are picked up at the start of each run via `coordination/board.py inbox
sounds`.

## Extending

- **Add a sound:** append an entry to `config/sounds.json → catalog`
  (`id`, `name`, `category`, `description`, `tags`, `preset`, `ai_prompt`,
  `duration_hint`, `usage`; optional `seed`, `params`, `min_duration`, `loop`).
  The loop picks it up on the next run.
- **New preset:** add a generator to `pipeline/sfxr.py:PRESETS`.
- **Go realistic:** set `ELEVENLABS_API_KEY` (repo secret) — the same catalog
  re-renders as AI foley from each entry's `ai_prompt`.
