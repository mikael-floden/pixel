# Pixel Sound Factory

Sound **effects + ambience** for the game in [`games2/`](../games2). One
**domain** of the multi-domain `pixel` repo; everything lives under `sounds/`,
owned by the sound agent — the "sound actor" of the three-role audio model
([`spec/AUDIO_INTEGRATION.md`](spec/AUDIO_INTEGRATION.md): sound + musician
produce, the composer in `games2/composer` integrates).

## Quality standard

**The bar is AAA / cinematic game audio** — top-tier console/film foley
(Zelda, God of War, *Lord of the Rings*): realistic, layered, punchy,
production-clean. Every shipped clip must be indistinguishable from
professionally recorded foley. Not retro, not chiptune, not placeholder.

- **No procedural synthesis** (v1 used a Python sfxr port; every clip was
  rejected — an oscillator/envelope synth has a hard quality ceiling that no
  parameter tuning fixes). The sfxr code survives only as an offline
  pipeline-test placeholder (`--engine placeholder`), quality-tagged
  `rejected-lowfi`, never shipped.
- **Never ship low-fi.** Only `quality: "aaa"` clips are real assets. Without
  `ELEVENLABS_API_KEY` the loop is BLOCKED on purpose: it writes a `blocked`
  heartbeat and generates nothing rather than ship placeholder audio.
- The ceiling above AI foley is a human sound designer + licensed libraries;
  hero-sound WAVs can be dropped into the same folders — the manifest format
  is engine-agnostic. Stable Audio (~3 min beds) is the planned second engine
  for long ambience.

## Engine + pipeline

**ElevenLabs Sound Effects v2** (`eleven_text_to_sound_v2`,
`pipeline/elevenlabs_client.py`) is the required engine. Per sound:

1. **Rich foley brief** (`ai_prompt`: material + intensity + detail) combined
   with catalog-wide `prompt_directives` (close-miked, dry, single isolated
   sound, no music/chiptune/artifacts). Precise prompts are the quality lever.
2. **Generate** at `engine.ai.output_format` = `mp3_44100_192` — this key
   tier delivers MP3, not lossless PCM (`pcm_48000` needs a higher tier); the
   factory decodes via ffmpeg and masters ONCE to a 48 kHz mono WAV.
3. **Multiple takes** (`variants`, default 2), all kept so a human can pick;
   take 1 is the primary.
4. **Master** (`pipeline/postprocess.py`): trim silence → edge fades
   (de-click) → peak-normalize to −1 dBFS.
5. **Encode delivery copies** (`pipeline/encode.py`): every take stem also
   ships `.m4a` (AAC, iOS/Safari) + `.ogg` (Vorbis, everything else) at 128
   kbps — phones never load the WAV. Spec:
   [`spec/AUDIO_FORMATS.md`](spec/AUDIO_FORMATS.md).

## What is a "sound"?

One sound = one folder `sounds/<category>/<id>/` holding the WAV master,
the `.m4a`/`.ogg` delivery copies, and `metadata.json` (the manifest).
Categories: `ui`, `item`, `tool`, `movement`, `combat`, `feedback`,
`ambience` (loops).

## Consuming the catalog

Read **`sounds/viewer_data.json`** (whole catalog) or a single
`sounds/<category>/<id>/metadata.json`. Paths are repo-relative starting with
the category, served at `/assets/sounds/...`. `index.html` is a phone
gallery.

**Every asset carries a `metadata.json`** — the shared cross-domain contract
(same convention as `music/`) the composer consumes to bind + mix without
listening: `feel`, `mix_gain_db`, `variation` (round-robin + jitter ranges),
`delivery`, and — **measured from the rendered WAV** by
`pipeline/analyze.py`, never written from intention — `music` (tonality /
`root_midi` / `max_shift_semitones`, so tonal SFX can be pitched into the
score's key; atonal foley is never shifted), `envelope`, and `sync_points`
(the transient, for frame-exact effect sync). Full schema:
[`spec/METADATA.md`](spec/METADATA.md).

`sounds/bindings.json` is this domain's **recommended** event → sound map —
intent only; the composer decides the final mix and the wiki assignment loop
decides what actually plays (`games2/composer/README.md`).

## Run / extend the loop

```bash
pip install -r ../requirements.txt
export ELEVENLABS_API_KEY=...                  # required for real output

python pipeline/loop.py --once                 # one sound
python pipeline/loop.py --max-minutes 50       # bounded chunk (for a schedule)
python pipeline/regen.py sword_hit             # (re)generate one catalog sound
python pipeline/loop.py --engine placeholder   # rejected low-fi synth — offline test only
```

Each **unit** is one sound: generate → master → encode → write manifest →
rebuild `viewer_data.json` → heartbeat → commit + push. The next unit is the
first catalog entry without audio (fully resumable, filesystem-derived). It
respects the AI-credit floor `budget.min_ai_credits_remaining` (shared
ElevenLabs account with `music/`). At startup the loop backfills missing
`.m4a`/`.ogg` for any pre-delivery WAV (idempotent).

**Add a sound:** append to [`config/sounds.json`](config/sounds.json) →
`catalog` (`id`, `name`, `category`, `description`, `tags`, `ai_prompt`,
`duration_hint`, `usage`; optional `variants`, `loop`, `prompt_influence`).
See [`spec/SOUNDS_SPEC.md`](spec/SOUNDS_SPEC.md).

**Schedule:** [`.github/workflows/sounds.yml`](../.github/workflows/sounds.yml)
is **workflow_dispatch only** — the hourly schedule is commented out at the
repo owner's request (failing runs emailed him). Uses the
`ELEVENLABS_API_KEY` Actions secret; without it the run records a `blocked`
heartbeat.

## Coordination

This domain owns `sounds/` and writes only `coordination/sounds.json` (per
[`coordination/PROTOCOL.md`](../coordination/PROTOCOL.md)). Requests addressed
to `sounds` are read at the start of each run (`coordination/board.py inbox
sounds`).

## Guardrails

- **Never commit secrets** — `ELEVENLABS_API_KEY` lives in the environment /
  Actions secret.
- **Never ship low-fi** (see Quality standard).
