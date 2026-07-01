# Pixel Sound Factory

An automated loop that generates **game-ready sound effects** — UI blips, item
pickups, tool swings, footsteps, combat hits and feedback jingles — for the pixel
RPG in [`games/`](../games), matching the pixel art produced by the sibling
domains (`characters/`, `objects/`, `tiles/`, `maps/`).

This is one **domain** of the multi-domain `pixel` repo. It is self-contained:
everything lives under `sounds/`, and this loop never touches another domain
(see [`coordination/PROTOCOL.md`](../coordination/PROTOCOL.md)).

> **Making a game?** Jump to **[Using the sounds in a game](#using-the-sounds-in-a-game)** —
> that section is all a game developer needs.

---

## How sounds are generated (two engines)

Sound generation in 2026 splits into two families, and this domain uses **both**:

| Engine | What | When |
|--------|------|------|
| **Procedural (sfxr)** — *default* | DrPetter's classic retro-SFX synth, ported to pure Python (`pipeline/sfxr.py`). Free, offline, deterministic per `(preset, seed)`. | Always available — no API key, runs in CI today. |
| **AI (ElevenLabs)** — *optional* | ElevenLabs text-to-sound-effects — realistic/foley effects from a text prompt. | Used automatically when `ELEVENLABS_API_KEY` is set, or with `--engine ai`. |

The default is procedural because it needs no secret, is reproducible, and fits a
pixel game stylistically. Every catalog entry also carries an `ai_prompt`, so
adding an ElevenLabs key re-renders the **same catalog** as higher-fidelity foley
with no other change. See [`spec/SOUNDS_SPEC.md`](spec/SOUNDS_SPEC.md) for the full
rationale and the endpoints used.

---

## What is a "sound"?

One sound = **one folder** `sounds/<category>/<id>/`, holding the audio file plus
`sound.json` (the manifest — read this). Categories: `ui`, `item`, `tool`,
`movement`, `combat`, `feedback`.

```
sounds/ui/coin_pickup/
  coin_pickup.wav     16-bit mono PCM WAV, 44.1 kHz (procedural)   [or .mp3 for AI]
  sound.json          the manifest describing it (below)
```

---

## Using the sounds in a game

**Everything you need is in `sounds/viewer_data.json`** (the whole catalog) and in
each `sounds/<category>/<id>/sound.json` (one sound). You don't need to run any
Python — read the JSON and load the audio file it points at. All paths are
repo-relative and start with the category, so they resolve on disk or over HTTP
(the game already serves the repo domains at `/assets/<domain>/…`, so a clip is at
`/assets/sounds/<category>/<id>/<id>.wav`).

### `sound.json` fields

```jsonc
{
  "id": "coin_pickup",
  "name": "Coin Pickup",
  "category": "ui",                    // ui | item | tool | movement | combat | feedback
  "description": "a bright, short metallic jingle when the player picks up a coin",
  "tags": ["coin", "pickup", "money", "reward", "collect"],
  "usage": "Play on gold_coin / gold_ingot pickup and shop sales.",
  "loop": false,                       // true for looping ambiences
  "engine": "procedural",              // procedural | ai
  "license": "CC0-1.0",
  "file": "ui/coin_pickup/coin_pickup.wav",   // repo-relative audio path
  "format": "wav",                     // wav (procedural) | mp3 (AI)
  "audio": { "duration_seconds": 0.364, "sample_rate": 44100, "channels": 1, "bit_depth": 16 },
  "procedural": {                      // present for procedural output
    "family": "sfxr", "preset": "pickupCoin", "seed": 1251735654,
    "params": { "...": "full sfxr parameter vector — pasteable into jsfxr/bfxr" },
    "reproduce": "python pipeline/regen.py coin_pickup"
  }
  // AI output instead carries an "ai": { provider, model_id, prompt, ... } block.
}
```

### How to load it (web / Phaser)

```js
const cat = await (await fetch('/assets/sounds/viewer_data.json')).json();
const byId = Object.fromEntries(cat.sounds.map(s => [s.id, s]));

// plain Web Audio:
const a = new Audio('/assets/sounds/' + byId['coin_pickup'].file);
a.play();

// Phaser: this.load.audio(s.id, '/assets/sounds/' + s.file) then this.sound.play('coin_pickup')
```

`viewer_data.json` also has `by_category` counts and the shared `style` string —
handy for building an audio picker or preloading a whole category.

---

## Browse it (no setup)

- **Phone / GitHub app:** open any `sounds/<category>/<id>/*.wav` to play it.
  `viewer_data.json` lists everything.
- **Viewer page:** serve this folder (`python -m http.server`) and open
  [`index.html`](index.html) — a gallery with an audio player per sound, filtered
  by category.

---

## Run / extend the loop

```bash
pip install -r ../requirements.txt

python pipeline/loop.py --once                 # one sound
python pipeline/loop.py --max-minutes 50       # a bounded chunk (for a schedule)
python pipeline/loop.py --max-units 5 --no-push
python pipeline/loop.py --engine ai            # force ElevenLabs (needs ELEVENLABS_API_KEY)

python pipeline/regen.py                        # re-render every catalog sound in place
python pipeline/regen.py coin_pickup            # just one (reproduces it byte-for-byte)
```

Each **unit** is one sound: generate → write manifest → rebuild `viewer_data.json`
→ heartbeat → commit + push. The loop reads the filesystem for the next missing
sound, so it is **fully resumable** — stop it any time and the next run continues.

**Add a sound:** append an entry to [`config/sounds.json`](config/sounds.json) →
`catalog` (`id`, `name`, `category`, `description`, `tags`, `preset`, `ai_prompt`,
`duration_hint`, `usage`; optional `seed`, `params`, `min_duration`, `loop`). The
available procedural presets are `pickupCoin`, `laserShoot`, `explosion`,
`powerUp`, `hitHurt`, `jump`, `blipSelect`, `tone`.

### On a schedule (durable)

[`.github/workflows/sounds.yml`](../.github/workflows/sounds.yml) runs the loop
hourly (and on demand) and pushes each unit — it survives container restarts.
**No secret is required** (procedural engine); add an optional `ELEVENLABS_API_KEY`
repo secret to auto-upgrade to AI foley.

---

## Coordinating with the other agents

This domain owns `sounds/` and writes only its own heartbeat
`coordination/sounds.json` (per [`coordination/PROTOCOL.md`](../coordination/PROTOCOL.md)).
At the start of each run it reads the fleet and handles any request addressed to
`sounds`:

```bash
python coordination/board.py inbox sounds                       # requests + fleet health
python coordination/board.py post sounds --to games --text "…"  # ask another domain
```

The **game agent** consumes this domain by reading `viewer_data.json` and mapping
game events → clips (e.g. coin pickup → `ui/coin_pickup`, sword hit →
`tool/sword_hit`).

## Notes / guardrails

- **Never commit secrets** — `ELEVENLABS_API_KEY` is read from the environment.
- **The repo is the source of truth.** Procedural output is regenerated from
  `(preset, seed)`; AI output is a one-shot download. The loop only ever *creates
  missing* sounds — it never overwrites one already on disk, so hand-tweaks and
  UI-authored clips you commit are safe (`regen.py` is the explicit way to re-render).
