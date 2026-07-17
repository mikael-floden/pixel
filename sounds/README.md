# Pixel Sound Factory

Generates **sound effects** for the game in [`games/`](../games). One **domain** of
the multi-domain `pixel` repo; everything lives under `sounds/`.

---

## ⭐ Quality standard — read this first

**The bar is AAA / cinematic game audio** — top-tier console and film sound design
(Zelda, God of War, *Lord of the Rings*), the kind of foley a player would expect
from a flagship title on the scale of Pokémon. Realistic, layered, punchy,
production-clean.

**This is NOT a retro/indie chiptune project.** 8-bit bleeps, synth beeps, and
"good enough" placeholder audio are explicitly rejected. Every clip we ship must be
indistinguishable from professionally recorded and edited foley.

---

## ☠️ Post-mortem: the rejected v1 approach (procedural sfxr)

**What we did:** the first version generated all SFX with a pure-Python port of
DrPetter's **sfxr** — the classic *procedural chiptune* synth (oscillator +
envelope + filter). It was chosen because it's free, offline, deterministic, and
needs no API key, so it ran in CI immediately.

**Why it failed:** it produced **8-bit retro bleeps** — the wrong medium entirely
for AAA foley. A square-wave synth *cannot* sound like a real chest creak, a steel
clang, boots on stone, or a cinematic explosion. The product owner listened to all
30 clips and (correctly) rejected them as low quality and unusable. No amount of
parameter tuning fixes this: **the technique itself has a hard quality ceiling.**

**The lesson:** pick the tool that matches the *target*, not the tool that's
cheapest to run. For AAA foley there is no free-synth shortcut — you need either
(a) a state-of-the-art neural audio model, or (b) recorded/licensed foley. We
optimized for "runs with no key" and shipped garbage. Fixed below.

The sfxr code is kept **only** as an offline pipeline-test placeholder
(`--engine placeholder`); its output is quality-tagged `rejected-lowfi` and must
never be shipped.

---

## ✅ The approach now (quality-first)

The 2026 quality leader for realistic, promptable foley is **ElevenLabs Sound
Effects (v2)** — rated indistinguishable from recorded foley in blind tests, with
lossless **48 kHz** output. That is now the **required** engine. Pipeline:

1. **Rich foley briefs, not vague labels.** Each catalog entry has an AAA prompt
   specifying *material + intensity + detail*, combined with catalog-wide
   production directives (high-fidelity, close-miked, dry, single isolated sound,
   *no music / no chiptune / no artifacts*). Precise prompts are what separate
   production-ready foley from a vague approximation.
2. **Lossless capture.** Request `pcm_48000` (48 kHz), wrap to WAV — no lossy
   round-trip.
3. **Multiple takes.** Generate N takes per sound (`variants`, default 2) and keep
   them all so a human can pick the best; take 1 is the primary.
4. **Local mastering.** Every take is trimmed (silence gate), edge-faded
   (de-click), and peak-normalized to −1 dBFS → consistent, broadcast-clean levels.

**The quality ladder** (so expectations are explicit): AI foley (this pipeline) is
the best *automatable* path and is now near-indistinguishable from recordings. The
absolute ceiling for a flagship title is still a **human sound designer + licensed
pro foley libraries** (Soundly / A Sound Effect / GameSynth) — if we want that tier
for hero sounds, budget for it and drop the WAVs into the same folders; the manifest
format is engine-agnostic. For longer ambient beds, **Stable Audio** (up to ~3 min)
is the better model — a planned second engine.

### The one thing needed to generate

The AAA engine needs a credential the repo doesn't ship:

```bash
export ELEVENLABS_API_KEY=...     # Pro tier or above for lossless pcm_48000
```

Set it as a local env var (or a repo **Actions secret** for the scheduled loop).
**Until it's set, the loop is BLOCKED on purpose** — it writes a `blocked`
heartbeat and generates nothing, rather than repeat the v1 mistake of shipping
low-fi placeholder audio. (The catalog, prompts, engine, and mastering are all
ready; the moment the key exists the loop produces the real assets.)

---

## What is a "sound"?

One sound = **one folder** `sounds/<category>/<id>/`, holding the audio file(s) plus
`metadata.json` (the manifest). Categories: `ui`, `item`, `tool`, `movement`, `combat`,
`feedback`.

```
sounds/tool/sword_hit/
  sword_hit.wav        48 kHz mono WAV, mastered (or sword_hit__take01.wav … for variants)
  metadata.json           the manifest describing it
```

---

## Using the sounds in a game

Read **`sounds/viewer_data.json`** for the whole catalog, or a single
`sounds/<category>/<id>/metadata.json`. All paths are repo-relative and start with the
category, so they resolve on disk or over HTTP (served at
`/assets/sounds/<category>/<id>/<file>`).

### `metadata.json` fields

```jsonc
{
  "id": "sword_hit",
  "name": "Sword Hit",
  "category": "tool",                 // ui | item | tool | movement | combat | feedback
  "description": "a sharp metallic clang of a sword striking a target",
  "tags": ["sword", "hit", "clang", "impact", "weapon"],
  "usage": "Sword connecting with an enemy or object.",
  "loop": false,
  "engine": "ai",                     // ai (shippable) | procedural (rejected-lowfi placeholder)
  "quality": "aaa",                   // aaa | rejected-lowfi
  "file": "tool/sword_hit/sword_hit.wav",   // primary take (repo-relative)
  "format": "wav",
  "audio": { "duration_seconds": 0.6, "sample_rate": 48000, "channels": 1, "bit_depth": 16, "peak_dbfs": -1.0 },
  "takes": ["tool/sword_hit/sword_hit__take01.wav", "tool/sword_hit/sword_hit__take02.wav"],
  "ai": { "provider": "elevenlabs", "model_id": "eleven_text_to_sound_v2", "prompt": "…full foley brief…", "prompt_influence": 0.5, "variants": 2 },
  "mastering": "trim + peak-normalize(-1 dBFS) + edge-fades",

  // composer-facing (see spec/METADATA.md) — MEASURED from the rendered audio:
  "feel": "impactful, sharp", "mix_gain_db": -2,
  "variation": { "round_robin": true, "pitch_jitter_semitones": [-2,2], "gain_jitter_db": [-3,3] },
  "music": { "tonal": false, "root_midi": null, "pitch_confidence": 0.19, "max_shift_semitones": 0,
             "scale_snap_replaces_jitter": false },   // tonal chimes get root_midi + ±3 so the composer keys them to the music
  "envelope": { "onset_ms": 0.3, "peak_ms": 6.3, "attack_ms": 6.0 },
  "sync_points": [ { "t_ms": 6.3, "name": "transient" } ]
}
```

**Every asset carries a `metadata.json`** — the shared cross-domain convention (same
file in the `music/` domain) that the **composer** (`games2/composer`) consumes to
bind + mix without listening. Musical/timing fields (`music`, `envelope`,
`sync_points`) are **measured from the rendered WAV** (`pipeline/analyze.py`), so
tonal SFX can be pitched into the music's key and effects synced to the transient.
Full schema + composer usage: [`spec/METADATA.md`](spec/METADATA.md).

### How to load it (web / Phaser)

```js
const cat = await (await fetch('/assets/sounds/viewer_data.json')).json();
const byId = Object.fromEntries(cat.sounds.map(s => [s.id, s]));
new Audio('/assets/sounds/' + byId['sword_hit'].file).play();
// Phaser: this.load.audio(s.id, '/assets/sounds/' + s.file)
```

---

## Run / extend the loop

```bash
pip install -r ../requirements.txt
export ELEVENLABS_API_KEY=...                  # required for real output

python pipeline/loop.py --once                 # one sound (AAA engine)
python pipeline/loop.py --max-minutes 50       # a bounded chunk (for a schedule)
python pipeline/regen.py sword_hit             # (re)generate one catalog sound
python pipeline/loop.py --engine placeholder   # REJECTED low-fi synth — offline test only
```

Each **unit** is one sound: generate → master → write manifest → rebuild
`viewer_data.json` → heartbeat → commit + push. The loop reads the filesystem for
the next missing sound, so it is **fully resumable**. It respects an AI-credit floor
(`budget.min_ai_credits_remaining`).

**Add a sound:** append an entry to [`config/sounds.json`](config/sounds.json) →
`catalog` (`id`, `name`, `category`, `description`, `tags`, `ai_prompt` — a rich
material-rich foley brief — `duration_hint`, `usage`; optional `variants`, `loop`,
`prompt_influence`). See [`spec/SOUNDS_SPEC.md`](spec/SOUNDS_SPEC.md).

### On a schedule (durable)

[`.github/workflows/sounds.yml`](../.github/workflows/sounds.yml) runs the loop
hourly. Add the `ELEVENLABS_API_KEY` **Actions secret**; without it the run records
a `blocked` heartbeat and generates nothing (by design).

---

## Coordinating with the other agents

This domain owns `sounds/` and writes only `coordination/sounds.json` (per
[`coordination/PROTOCOL.md`](../coordination/PROTOCOL.md)). The game agent reads
`viewer_data.json` and maps events → clips.

## Guardrails

- **Never commit secrets** — `ELEVENLABS_API_KEY` is read from the environment.
- **Never ship low-fi.** Only `quality: "aaa"` clips are real assets; the loop
  refuses to generate placeholders as if they were the deliverable.
