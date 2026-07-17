# Musical SFX — pitch sound effects into the music's scale

**Status: IDEA — captured so it isn't lost. Owner of the runtime part: composer
actor (`games2/composer`). Sound side (this domain) and musician (`music/`) supply
the metadata that makes it possible.**

## The idea (product owner, 2026-07-17)

The musician's `music/<track>/metadata.json` describes each track with sub-second
detail: **key, mode, BPM, beat grid, chord/section changes, and "hit points"**
(moments a visual effect like thunder can sync to). If the music contract exposes
the *current key/scale*, then **pitched SFX — footsteps, UI blips, pickups,
chimes — can be pitch-shifted at trigger time to land on a note of that scale**,
so the whole soundscape plays *in tune* with the score. Same trick as adaptive-
audio middleware (Wwise/FMOD music callbacks + magnet-to-scale), which is exactly
the AAA quality tier this repo targets.

Two sync dimensions, both driven by the same metadata:

1. **Pitch sync** — shift a one-shot onto the nearest (or a mapped) scale tone of
   the currently playing track.
2. **Time sync** — optionally quantize non-urgent triggers (stingers, thunder,
   ambient chimes) to the next beat/bar boundary from the beat grid.

## Contract additions

### `music/<track>/metadata.json` (musician actor) must expose

```jsonc
{
  "key": "D", "mode": "minor",            // or per-section if the track modulates
  "bpm": 96, "time_signature": "4/4",
  "timeline": [                            // sub-second, machine-verified
    { "t": 0.000,  "type": "section", "name": "intro", "key": "D", "mode": "minor" },
    { "t": 14.500, "type": "hit",     "name": "thunder_ok", "strength": 0.9 },
    { "t": 15.000, "type": "chord",   "name": "Bb" }
  ],
  "beat_grid": { "first_beat_t": 0.120, "beats_per_bar": 4 }   // or explicit beat times
}
```

### `sounds/<cat>/<id>/sound.json` (this domain) gains a `music` block

```jsonc
"music": {
  "tonal": true,              // false → never pitch-shift (noise-based foley: impacts, whooshes)
  "root_midi": 62,            // detected dominant pitch of the clip (D4), from analysis
  "pitch_confidence": 0.83,   // from the detector; low confidence → treat as tonal:false
  "max_shift_semitones": 3    // guardrail against chipmunk/growl artifacts
}
```

Root pitch is **measured, not guessed** — e.g. `librosa.piptrack`/`pyin` or
`aubio pitch` over the take, stored at generation/mastering time by the sounds
pipeline.

## Runtime sketch (composer actor, WebAudio)

```js
// on trigger:
const { key, mode } = music.currentSection(now);          // from metadata timeline
const scale = scaleMidi(key, mode);                        // e.g. D minor pitch classes
const target = nearestInScale(sfx.music.root_midi, scale); // or map event→scale degree
const semis  = clamp(target - sfx.music.root_midi, -sfx.music.max_shift_semitones,
                                                    +sfx.music.max_shift_semitones);
src.playbackRate.value = Math.pow(2, semis / 12);          // shifts pitch AND duration
```

- `playbackRate` also stretches duration — fine for short one-shots (≤ ~0.5 s);
  a time-preserving phase-vocoder shift is overkill for the first test.
- Variation stacking: apply scale-snap **instead of** the existing random pitch
  jitter from `viewer_data.json` variation, not on top of it.
- Nice extension: round-robin *across scale degrees* (footsteps walk 1→3→5) so
  repetition becomes melody instead of noise.

## Minimal test (what "at least test it" means)

1. One track in `music/` with a **known** key + BPM in its metadata.
2. Two tonal SFX from the catalog (e.g. `item/coin_pickup`-style chime + a
   footstep) — measure `root_midi` with librosa.
3. A throwaway HTML/WebAudio page: music loops, SFX triggered on keypress, a
   checkbox toggling **scale-snap on/off** for an instant A/B.
4. Judgment call: does "in tune" read as *more AAA* or as *uncanny*? Decide
   per-category (chimes/UI almost certainly yes; footsteps maybe).

## Guardrails

- Never shift non-tonal foley (`tonal: false`) — pitching noise just sounds wrong.
- Cap shifts at ±3 semitones; prefer the octave-equivalent nearest scale tone.
- If the music timeline and audio drift apart, everything breaks silently —
  metadata must be derived from the rendered audio (beat/key detection), then
  semantically annotated, not hand-written from intention.
