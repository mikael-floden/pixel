/**
 * The composer's own MUSIC tracks, which live in music/ — one directory a
 * dedicated music agent owns outright — and are served from /assets/music.
 * Not generated yet → the callers no-op.
 *
 *  title.ogg  the character-select login theme (startTitleTheme)
 *
 * THESE WERE mp3 "on purpose", and the purpose expired: the reason on record
 * was "decodeAudioData handles it in every browser incl. Safari/iOS (ogg/opus
 * does not)". Safari has played the Ogg container — Opus and Vorbis — since
 * 18.4 (macOS 15.4 / iOS 18.4, March 2025), so the exception outlived its
 * reason and left two files as the only non-ogg audio in the repo. Transcoded
 * 2026-09-09 at 128k rather than the beds' 96k: no lossless master of these
 * two ever existed, so it is a SECOND lossy generation on the two tracks
 * players hear most, and the extra 0.33 MB each keeps the encoder from being
 * the bottleneck. Measured against the mp3: identical duration to the
 * millisecond, zero lag (so the loop points, which are in seconds, still
 * land), and no change at all across 20 Hz - 16 kHz.
 *
 * The WORLD beds (night/town/cave/home/battle/adventure) moved to
 * contextMusic.ts, which selects them by situation and reads their measured
 * loop points + loudness trim from music/tracks.json. Only the title theme —
 * approved, and on its own screen — still lives here.
 */


import { bedTrack, musicTracks } from "./contextMusic";

/** Find a track by NAME SUBSTRING in the fetched score manifest, and return
 *  its playable url. The names are the manifest's ids ("title", "night"), and
 *  matching on a substring is what lets the composer rename a take without
 *  the title screen going silent. */
function byName(...needles: string[]): string | null {
  const ids = Object.keys(musicTracks()).sort();
  for (const n of needles) {
    const id = ids.find((k) => k.toLowerCase().includes(n));
    const hit = id ? bedTrack(id) : null;
    if (hit) return hit.url;
  }
  return null;
}

/** The mystical night-bed URL, or null if not generated yet. This is the
 * IN-WORLD night score (api.ts ensureNightMusic) — the generated context beds
 * are audition-only until the maintainer routes them. */
export function nightMusicUrl(): string | null {
  const url = byName("night", "mystic", "nocturne");
  return url;
}

/** The title/login theme URL, or null if not generated yet. */
export function titleThemeUrl(): string | null {
  // A file named title/theme; else the first mp3 that isn't the night bed.
  const named = byName("title", "theme");
  if (named) return named;
  const first = Object.keys(musicTracks()).sort().find((k) => !/night/i.test(k));
  return first ? (bedTrack(first)?.url ?? null) : null;
}
