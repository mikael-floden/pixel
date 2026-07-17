# `metadata.json` — the per-asset audio contract

**Every audio asset (sound effect, ambience, and — in the `music/` domain — every
track) ships a `metadata.json`** in its folder. It is the shared, cross-domain
contract the **composer** actor (`games2/composer`) consumes to bind + mix audio
into the game **without listening**. This document is the sounds-side schema; the
music domain publishes a parallel one with track-timeline fields.

## Guardrail: MEASURED, not intended

Timing and pitch are **measured from the rendered audio** (`pipeline/analyze.py`),
never written from intention. Generation models don't emit ground-truth timing/key,
so a hand-written "the hit is at 0.5 s" drifts from reality and every synced effect
looks subtly wrong. We run onset/pitch analysis on the finished WAV and annotate it.

## Schema (sounds domain)

```jsonc
{
  "schema": "audio-metadata/1",
  "asset_type": "sfx" | "ambience",
  "id": "coin_pickup", "name": "Coin Pickup", "category": "ui",
  "description": "...", "feel": "rewarding", "tags": ["coin","pickup"],
  "usage": "Play on gold_coin pickup.",
  "loop": false, "engine": "ai", "quality": "aaa", "license": "CC0-1.0",

  // files (repo-relative; served at /assets/sounds/...)
  "file": "ui/coin_pickup/coin_pickup__take01.wav",   // primary take
  "format": "wav",
  "takes": ["ui/coin_pickup/coin_pickup__take01.wav", "...take02.wav"],
  "audio": { "duration_seconds": 0.5, "sample_rate": 48000, "channels": 1,
             "bit_depth": 16, "peak_dbfs": -1.0 },
  "delivery": {                             // compressed formats for fast phone load
    "formats": { "wav": {"file":"...", "role":"master"}, "m4a": {"file":"..."}, "ogg": {"file":"..."} },
    "web_source_order": ["m4a", "ogg"]      // WAV = lossless master/fallback. See AUDIO_FORMATS.md
  },

  // ─── composer-facing: mixing ───
  "mix_gain_db": -3,                       // per-category balance vs music bed
  "variation": {                            // anti-repetition (round-robin + jitter)
    "round_robin": true, "no_immediate_repeat": true,
    "pitch_jitter_semitones": [-1, 1], "gain_jitter_db": [-2, 2], "start_jitter_ms": [0, 15]
  },

  // ─── composer-facing: scale-matching (MEASURED) ───
  "music": {
    "tonal": true,                          // false ⇒ NEVER scale-shift (foley)
    "root_midi": 72, "note": "C5", "fundamental_hz": 521.7, "cents_off": -5,
    "pitch_confidence": 0.99,               // 0..1, from autocorrelation periodicity
    "max_shift_semitones": 3,               // cap (0 when atonal)
    "scale_snap_replaces_jitter": true,     // snap REPLACES pitch-jitter, never stacked
    "tonality": "tonal|mixed|atonal", "spectral_flatness": 0.01
  },

  // ─── composer-facing: sub-second sync (MEASURED) ───
  "envelope": { "duration_ms": 500, "onset_ms": 0.3, "peak_ms": 6.3,
                "attack_ms": 6.0, "peak_dbfs": -1.0, "rms": 0.2, "crest": 4.3 },
  "sync_points": [ { "t_ms": 6.3, "name": "transient",
                     "note": "main attack — measured; safe sync/trigger point" } ],

  "ai": { "provider": "elevenlabs", "model_id": "eleven_text_to_sound_v2",
          "prompt": "...", "prompt_influence": 0.5, "loop": false, "variants": 2 },
  "mastering": "trim + peak-normalize(-1 dBFS) + edge-fades",
  "source": "elevenlabs text-to-sound-effects (eleven_text_to_sound_v2)"
}
```

## How the composer uses it

- **Scale-match** (the "same-scale SFX" feature): if `music.tonal`, snap the clip's
  `root_midi` to the nearest scale tone of the current music section, then
  `playbackRate = 2^(semitones/12)`, clamped to `±max_shift_semitones`. Snapping
  **replaces** `variation.pitch_jitter` (never stacked). Never touch `tonal:false`
  foley — pitched noise sounds wrong.
- **Sync**: trigger visuals / thunder / layered SFX on a `sync_points[t_ms]`, aligned
  to the music's beat grid (from the music-domain metadata).
- **Mix**: apply `mix_gain_db` + the bus targets; duck music on flagged events
  (`bindings.json`).
- **Anti-repetition**: for `variation.round_robin` sounds, cycle takes + jitter
  gain/timing (and pitch, unless scale-snap is in effect).

## Shared vocabulary with the music domain

Both sides use the same `metadata.json` filename and the same `music.root_midi` /
key convention (MIDI note numbers, A4=69=440 Hz) so the composer can compare a
sound's pitch to a track's key directly. The music domain additionally carries a
track **timeline** (BPM, beat grid, key/mode, section + chord changes, named hit
points) — all likewise measured from the rendered track.
