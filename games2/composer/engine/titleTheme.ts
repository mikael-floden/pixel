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


import { bedTrack } from "./contextMusic";

/** A track by its EXACT manifest id.
 *
 * NEVER SUBSTRING-MATCH HERE. This used to, because it searched a glob of
 * `../music/*.mp3` — a namespace of exactly two files, where "night" could
 * only ever mean night.mp3. Rewiring it onto tracks.json widened that to 51
 * ids without narrowing the lookup, and `battle_night` sorts before `night`:
 * the maintainer got a bare combat layer every night instead of the bed he
 * approved ("this stupid action song is playing instead"). A lookup written
 * for a namespace of two is not safe in a namespace of fifty. */
function track(id: string): string | null {
  return bedTrack(id)?.url ?? null;
}

/** The mystical night-bed URL, or null if not generated yet. This is the
 * IN-WORLD night score (api.ts ensureNightMusic) — the generated context beds
 * are audition-only until the maintainer routes them. */
export function nightMusicUrl(): string | null {
  return track("night");
}

/** The title/login theme URL, or null if not generated yet. */
export function titleThemeUrl(): string | null {
  return track("title");
}
