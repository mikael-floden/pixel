/**
 * The producers' contracts, as shipped on disk (sound actor: sounds/,
 * musician actor: music/). The composer CONSUMES these — it never writes
 * them. Loaded over HTTP from /assets/sounds/... and /assets/music/...
 * (served by both the vite dev middleware and the prod server).
 */

// ---- sounds/viewer_data.json ----

export interface SoundVariation {
  round_robin?: boolean;
  no_immediate_repeat?: boolean;
  pitch_jitter_semitones?: [number, number];
  gain_jitter_db?: [number, number];
  start_jitter_ms?: [number, number];
}

/** Measured musicality block (MUSICAL_SFX.md): lets the composer pitch a
 * tonal one-shot onto the current music's scale. Root pitch is MEASURED by
 * the sounds pipeline, never guessed. */
export interface SoundMusic {
  tonal: boolean;
  root_midi: number | null;
  pitch_confidence: number;
  max_shift_semitones: number;
  scale_snap_replaces_jitter: boolean;
}

export interface SoundEntry {
  id: string;
  category: "ui" | "item" | "tool" | "movement" | "combat" | "feedback" | "ambience" | string;
  loop: boolean;
  file: string; // repo-relative under sounds/ (starts with the category)
  takes?: string[];
  /** ABSOLUTE take URLs (composer's own bundled foley) — when set they win
   * over file/takes and are used verbatim (no /assets/sounds prefix). */
  urls?: string[];
  duration_seconds?: number;
  mix_gain_db?: number;
  variation?: SoundVariation;
  music?: SoundMusic;
}

export interface SoundCatalog {
  sounds: SoundEntry[];
}

// ---- sounds/bindings.json (sound-side recommendation; composer decides) ----

export interface Bindings {
  buses?: Record<string, number>; // dB
  category_gain_db?: Record<string, number>;
  ducking?: { music_duck_db?: number; release_ms?: number };
  events?: { event: string; sound?: string; bus?: string; duck?: boolean }[];
}

// ---- music/viewer_data.json + per-track metadata.json ----

export interface MusicTrackRef {
  id: string;
  file: string; // repo-relative under music/
  duration_s: number;
  bpm?: number;
  key?: { root: string; mode: string };
  loopable?: boolean;
  use?: string; // the musician's intent prose ("Main overworld background bed…")
  metadata: string; // path to the track's metadata.json under music/
}

export interface MusicMetadata {
  musical?: {
    key?: {
      midi_pitch_classes?: number[];
      sfx_safe_pitch_classes?: number[];
      root_midi_reference?: number;
    };
    tempo_bpm?: number;
  };
  timing?: {
    beats_s?: number[];
    downbeats_s?: number[];
    tempo?: { grid_bpm?: number; beat_anchor_s?: number; beats_per_bar?: number };
  };
  structure?: {
    sections?: { name: string; start_s: number; end_s: number; intensity?: number }[];
  };
  loop?: {
    recommended?: { loop_start_s?: number; loop_end_s?: number; crossfade_ms?: number };
  };
}

export interface MusicCatalog {
  tracks: MusicTrackRef[];
}

// ---- loading ----

const SOUNDS_BASE = "/assets/sounds/";
const MUSIC_BASE = "/assets/music/";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface Catalog {
  sounds: Map<string, SoundEntry>;
  bindings: Bindings;
  music: MusicTrackRef[];
}

/** Fetch every contract. Missing files degrade to an empty catalog — the
 * game must run silently rather than break when an asset domain is absent
 * (e.g. a sparse checkout). */
export async function loadCatalog(): Promise<Catalog> {
  const [snd, bnd, mus] = await Promise.all([
    getJson<SoundCatalog>(SOUNDS_BASE + "viewer_data.json"),
    getJson<Bindings>(SOUNDS_BASE + "bindings.json"),
    getJson<MusicCatalog>(MUSIC_BASE + "viewer_data.json"),
  ]);
  const sounds = new Map<string, SoundEntry>();
  for (const s of snd?.sounds ?? []) sounds.set(s.id, s);
  return { sounds, bindings: bnd ?? {}, music: mus?.tracks ?? [] };
}

export function soundUrl(repoRelative: string): string {
  return SOUNDS_BASE + repoRelative;
}

export function musicUrl(repoRelative: string): string {
  return MUSIC_BASE + repoRelative;
}

export async function loadMusicMetadata(track: MusicTrackRef): Promise<MusicMetadata | null> {
  return getJson<MusicMetadata>(musicUrl(track.metadata));
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
