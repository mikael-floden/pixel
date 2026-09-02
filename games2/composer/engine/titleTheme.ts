/**
 * The composer's own MUSIC tracks (games2/composer/music/): full tracks the
 * composer generates (ElevenLabs Music, same rights as the music domain —
 * music/pipeline) and bundles straight into the client by Vite (like the
 * foley). mp3 on purpose — decodeAudioData handles it in every browser incl.
 * Safari/iOS (ogg/opus does not). Empty until generated → the callers no-op.
 *
 *  title.mp3  the character-select login theme (startTitleTheme)
 *
 * The WORLD beds (night/town/cave/home/battle/adventure) moved to
 * contextMusic.ts, which selects them by situation and reads their measured
 * loop points + loudness trim from music/tracks.json. Only the title theme —
 * approved, and on its own screen — still lives here.
 */


// music/*.mp3 → hashed bundle URLs.
const files = import.meta.glob("../music/*.mp3", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

function byName(...needles: string[]): string | null {
  const keys = Object.keys(files).sort();
  for (const n of needles) {
    const k = keys.find((p) => p.toLowerCase().includes(n));
    if (k) return files[k];
  }
  return null;
}

/** The mystical night-bed URL, or null if not generated yet. This is the
 * IN-WORLD night score (api.ts ensureNightMusic) — the generated context beds
 * are audition-only until the maintainer routes them. */
export function nightMusicUrl(): string | null {
  const url = byName("night", "mystic", "nocturne");
  return url; // bundle emit — never stamped (assetver.ts)
}

/** The title/login theme URL, or null if not generated yet. */
export function titleThemeUrl(): string | null {
  // A file named title/theme; else the first mp3 that isn't the night bed.
  const named = byName("title", "theme");
  if (named) return named;
  const keys = Object.keys(files).sort().filter((k) => !/night/i.test(k));
  return keys[0] ? files[keys[0]] : null;
}
