# Audio delivery formats — the compression standard

Owned by the **sound actor** (compression is our responsibility), used by the whole
audio stack (sounds, music, composer) so the game speaks one set of formats. A
lossless WAV is the master; a multi-minute music WAV is tens of MB and unusable on a
phone, so **every asset also ships compressed delivery formats.**

## The formats (per asset, same stem)

| Ext | Codec | For | Notes |
|-----|-------|-----|-------|
| `.wav` | PCM s16le | master / desktop / offline processing | lossless; not shipped to phones |
| `.m4a` | AAC | Safari / iOS | encoded with `+faststart` (moov atom up front → starts before full download) |
| `.ogg` | Vorbis | Chrome / Firefox / Android | |

`.m4a` + `.ogg` together cover every browser. Default bitrate **128 kbps** for SFX
and ambience (`config/sounds.json → audio.delivery.bitrate`); music should use a
higher rate (≈160–192 kbps) — it's the same encoder, just a different bitrate.

## The encoder (canonical)

`pipeline/encode.py` — `encode_wav(wav, bitrate)` writes `<stem>.m4a` + `<stem>.ogg`
next to the WAV via ffmpeg (present on CI runners; also used for decode). Standalone:
`python pipeline/encode.py path/to/track.wav`. Idempotent (skips existing).

**Music domain / composer:** use this same module/standard (copy it per the
one-lib-per-domain convention, like `pixellab_client.py`) so all compressed audio is
consistent. Run it on your rendered master; it needs no knowledge of the content.

## The manifest `delivery` block

Every `metadata.json` gains a `delivery` block listing the encodings + the web
`<source>` order, so the game/composer picks the best supported format and never
downloads the heavy WAV on a phone:

```jsonc
"delivery": {
  "formats": {
    "wav": { "file": "ui/coin_pickup/coin_pickup__take01.wav", "bytes": 48044, "codec": "pcm_s16le", "role": "master" },
    "m4a": { "file": "ui/coin_pickup/coin_pickup__take01.m4a", "bytes": 8210,  "codec": "aac" },
    "ogg": { "file": "ui/coin_pickup/coin_pickup__take01.ogg", "bytes": 7605,  "codec": "libvorbis" }
  },
  "web_source_order": ["m4a", "ogg"]     // WAV is the fallback/master, not a web <source>
}
```

Every listed take stem also has `.m4a` + `.ogg` on disk (swap the extension).

## How the game/composer loads it

```html
<audio>
  <source src="/assets/sounds/ui/coin_pickup/coin_pickup__take01.m4a" type="audio/mp4">
  <source src="/assets/sounds/ui/coin_pickup/coin_pickup__take01.ogg" type="audio/ogg">
</audio>
```
Or in JS, pick by `HTMLAudioElement.canPlayType` in `web_source_order`. Use the WAV
only for desktop/offline high-fidelity needs.

## Backfill

The loop encodes new assets inline and, at startup, **backfills** `.m4a`/`.ogg` for
any WAV that predates delivery formats (`factory.ensure_delivery`, idempotent) — so
existing assets get compressed on the next CI run with no re-generation.
