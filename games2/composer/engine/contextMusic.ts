/**
 * The CONTEXT SCORE — one bed per thing the player is doing, cross-faded.
 *
 *   battle     monsters are on you
 *   cave       underground
 *   home       at the spawn bonfire — safe
 *   town       village / market / farmland
 *   night      the overworld after dark
 *   adventure  the default: out in the world
 *
 * Three things make this sound composed rather than "six mp3s on repeat", and
 * all three come from measurements the generator baked into `music/tracks.json`
 * (see music/pipeline/master.py):
 *
 *  1. LOUDNESS MATCHING. Every bed is mastered to the same K-weighted loudness
 *     (and adopted takes carry a `trim_db` that gets them there), so a context
 *     switch changes the MUSIC, never the volume.
 *  2. MEASURED LOOP POINTS. Each bed loops loop_start↔loop_end with an
 *     equal-power crossfade at the seam the analysis found to match best —
 *     not a hard wrap at the end of the file.
 *  3. POSITION MEMORY. A bed that fades out remembers where it was and RESUMES
 *     there (the maintainer's rule for the night bed: "we only get to listen to
 *     the start of the song if it restarts each cycle — continue where we left
 *     off"). Walking in and out of town does not restart the town tune.
 *
 * Beds load LAZILY — a context nobody enters is never downloaded — and only the
 * outgoing bed is kept alive through a fade, so at most two are decoded at once.
 */

import { withAudioV } from "./assetver";
import { AudioGraph, BufferCache } from "./context";
import { dbToGain } from "./catalog";
import { MusicalContext } from "./oneshot";
import tracksFile from "../music/tracks.json";

export type BedName = "adventure" | "town" | "cave" | "home" | "battle" | "night" | "cave4" | "summit_triumph";

/** Priority order — the FIRST match wins in api.ts's context resolve. */
export const BED_NAMES: BedName[] = ["battle", "cave", "cave4", "summit_triumph", "home", "town", "night", "adventure"];

/**
 * The shared level for every world bed, in dB.
 *
 * DERIVED, not taste: the approved night bed measures −16.79 LUFS and shipped
 * at −5 dB, i.e. −21.79 dB effective. Every bed is now normalised to −18 LUFS,
 * so −3.8 dB reproduces that exact perceived level. The maintainer's approved
 * night loudness is therefore unchanged, and the five new beds match it.
 */
const WORLD_BED_DB = -3.8;

/** Cross-fade speeds (setTargetAtTime tau). Battle arrives fast — a fight has
 * already started by the time you hear it — and leaves slowly. */
const FADE_IN_TAU = 0.9;
const FADE_OUT_TAU = 1.3;
const BATTLE_IN_TAU = 0.3;

interface LoopPoints {
  loop_start_s: number;
  loop_end_s: number;
  crossfade_ms: number;
  score: number;
}
export interface TrackEntry {
  id: string;
  files: { file: string; mime: string }[];
  duration_s: number;
  bpm?: number | null;
  trim_db?: number;
  loop: LoopPoints;
  musical?: {
    root?: string | null;
    mode?: string | null;
    sfx_safe_pitch_classes?: number[] | null;
    midi_pitch_classes?: number[] | null;
  };
  timing?: { bpm?: number | null; beat_anchor_s?: number };
  /** The phrase grid, written by the music pipeline for sequenceable beds.
   * Absent on every v1 bed, which is why they keep looping linearly. */
  phrase?: {
    phrase_ms: number;
    bars?: number | null;
    phrases: number;
    beat_anchor_s?: number | null;
    suite?: string | null;
    pool?: string | null;
  };
}
interface TracksFile {
  tracks: Record<string, TrackEntry>;
}

const TRACKS = (tracksFile as unknown as TracksFile).tracks ?? {};

// Bundled audio: Vite emits each as its own hashed asset, so nothing is
// downloaded until a bed actually plays.
const bundled = import.meta.glob("../music/*.{ogg,m4a,mp3}", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const byName = new Map<string, string>();
for (const path of Object.keys(bundled)) {
  const base = path.split("/").pop();
  if (base) byName.set(base, bundled[path]);
}

/** The playable URL for a bed: first listed format this browser can decode
 * (opus everywhere, AAC on Safari/iOS), version-pinned so it downloads once
 * per deploy. Null when the bed has not been generated yet. */
export function bedTrack(name: string): { url: string; entry: TrackEntry } | null {
  const entry = TRACKS[name];
  if (!entry) return null;
  const probe = typeof document !== "undefined" ? document.createElement("audio") : null;
  for (const f of entry.files ?? []) {
    const url = byName.get(f.file);
    if (!url) continue;
    if (probe && f.mime && !probe.canPlayType(f.mime)) continue;
    return { url: withAudioV(url), entry };
  }
  return null;
}

export function hasBed(name: string): boolean {
  return bedTrack(name) !== null;
}

/** WHICH PHRASE NEXT — a shuffled BAG, not a random pick.
 *
 * Uniform random over N clusters: you hear the same phrase twice inside a
 * minute far more often than feels accidental, and that is exactly what a
 * listener catches. A bag plays all N in a random order, reshuffles, and never
 * repeats inside a cycle — so with 12 explore phrases nothing can return for
 * ~2.7 minutes, and the ORDER differs every cycle (12! of them). Ocarina of
 * Time does the cheap version of this: pick at random, but never the one just
 * played. The bag is that idea with a guaranteed floor instead of a hope.
 *
 * The one seam a bag cannot fix by itself is the reshuffle: the last of one
 * cycle and the first of the next can be the same index. `last` blocks it. */
class PhraseBag {
  private order: number[] = [];
  private at = 0;
  private last = -1;
  constructor(private n: number) {}

  next(): number {
    if (this.n <= 1) return 0;
    if (this.at >= this.order.length) {
      this.order = [...Array(this.n).keys()];
      for (let i = this.order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
      }
      // Never hand back the phrase that just played, even across a reshuffle.
      if (this.order[0] === this.last && this.order.length > 1) {
        [this.order[0], this.order[1]] = [this.order[1], this.order[0]];
      }
      this.at = 0;
    }
    this.last = this.order[this.at++];
    return this.last;
  }
}

/** One looping bed: its own gain, its own loop scheduling, its own position. */
class Bed {
  readonly gain: GainNode;
  private live: AudioBufferSourceNode[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private segStartCtx = 0;
  private segStartPos = 0;
  private playing = false;
  /** Song seconds where playback stopped — where a resume picks up. */
  private savedPos: number | null = null;
  /** PHRASE MODE. Set when the track publishes a phrase grid (tracks.json
   * `phrase`, written by the music pipeline). Without it a bed plays its loop
   * window linearly, exactly as before — every existing bed is unaffected. */
  private bag: PhraseBag | null = null;
  private phraseS = 0;
  private anchorS = 0;
  private phraseCount = 0;

  constructor(
    private graph: AudioGraph,
    private buffer: AudioBuffer,
    readonly entry: TrackEntry,
  ) {
    this.gain = graph.ctx.createGain();
    this.gain.gain.value = 0.0001;
    this.gain.connect(graph.bus("music"));
    const ph = entry.phrase;
    if (ph?.phrase_ms && (ph.phrases ?? 0) >= 2) {
      this.phraseS = ph.phrase_ms / 1000;
      // Cuts are measured from BEAT ONE, not from zero: the master trims the
      // lead-in, so a grid anchored at 0 would be offset by whatever silence
      // was removed and every boundary would land mid-bar.
      this.anchorS = Math.max(0, ph.beat_anchor_s ?? 0);
      // Never let the grid run past the buffer — a short master would schedule
      // a phrase that does not exist and go silent.
      const fit = Math.floor((buffer.duration - this.anchorS) / this.phraseS);
      this.phraseCount = Math.max(0, Math.min(ph.phrases ?? 0, fit));
      if (this.phraseCount >= 2) this.bag = new PhraseBag(this.phraseCount);
    }
  }

  /** Where phrase `i` starts, in song seconds. */
  private phraseAt(i: number): number {
    return this.anchorS + i * this.phraseS;
  }

  /** Is this bed playing phrase-by-phrase rather than as one linear loop? */
  phraseMode(): boolean {
    return this.bag !== null;
  }

  private points(): { start: number; end: number; cf: number } {
    const dur = this.buffer.duration;
    const l = this.entry.loop ?? ({} as LoopPoints);
    const start = Math.max(0, Math.min(l.loop_start_s ?? 0, dur - 1));
    const end = Math.min(l.loop_end_s ?? dur, dur);
    return { start, end: Math.max(end, start + 1), cf: Math.min(2, (l.crossfade_ms ?? 900) / 1000) };
  }

  start(): void {
    if (this.playing) return;
    this.playing = true;
    const { start } = this.points();
    const from = this.savedPos ?? (this.bag ? this.phraseAt(this.bag.next()) : start);
    this.schedulePass(this.graph.now + 0.04, from, true);
  }

  /** The phrase index most recently scheduled, or -1 in linear mode. QA reads
   * this to prove the order actually varies and never repeats in a cycle. */
  lastPhrase = -1;
  phraseInfo(): { mode: boolean; count: number; phraseS: number; last: number } {
    return { mode: !!this.bag, count: this.phraseCount, phraseS: this.phraseS, last: this.lastPhrase };
  }

  /** Fade-out is the caller's job (it owns the cross-fade); this reclaims the
   * sources once silent and remembers the position for the next visit. */
  stop(afterS = 2.5): void {
    if (!this.playing) return;
    this.savedPos = this.position();
    this.playing = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const live = this.live;
    this.live = [];
    setTimeout(() => {
      for (const s of live) {
        try {
          s.stop();
        } catch {
          /* already ended */
        }
        s.disconnect();
      }
    }, afterS * 1000);
  }

  private schedulePass(when: number, from: number, first: boolean): void {
    if (!this.playing) return;
    const { start, end, cf } = this.points();
    // PHRASE MODE plays ONE phrase per pass and asks the bag what comes next,
    // so the piece is re-ordered every cycle instead of looping. Linear mode
    // plays the whole loop window, which is what every bed did before and what
    // any bed without a phrase grid still does.
    const span = this.bag ? this.phraseS : Math.max(0.5, end - from);
    const ctx = this.graph.ctx;

    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    const g = ctx.createGain();
    src.connect(g);
    g.connect(this.gain);

    // Equal-power seam: this pass fades out over cf while the next fades in.
    const fadeIn = first ? 0.05 : cf;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(1, when + fadeIn);
    const tEnd = when + span;
    g.gain.setValueAtTime(1, Math.max(when + fadeIn, tEnd - cf));
    g.gain.exponentialRampToValueAtTime(0.0001, tEnd);

    src.start(when, from, span);
    src.onended = () => {
      g.disconnect();
      this.live = this.live.filter((s) => s !== src);
    };
    this.live.push(src);

    this.segStartCtx = when;
    this.segStartPos = from;

    const nextWhen = tEnd - cf;
    // THE ONLY PLACE A DECISION IS MADE — which is why a state change always
    // lands on a musical boundary without any extra beat-quantising code: the
    // next phrase is chosen here, at the seam, and nowhere else.
    const nextFrom = this.bag ? this.phraseAt(this.bag.next()) : start;
    this.lastPhrase = this.bag ? Math.round((nextFrom - this.anchorS) / this.phraseS) : -1;
    const armInMs = Math.max(40, (nextWhen - 2 - this.graph.now) * 1000);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.schedulePass(nextWhen, nextFrom, false), armInMs);
  }

  /** Song seconds right now (wrapped into the loop window). */
  position(): number {
    if (!this.playing) return this.savedPos ?? 0;
    const { start, end } = this.points();
    const span = Math.max(0.5, end - start);
    const raw = this.segStartPos + (this.graph.now - this.segStartCtx);
    return raw <= end ? raw : start + ((raw - start) % span);
  }

  /** Target 0..1; the per-track trim + shared bed level are applied here so a
   * caller only ever thinks in "how much of this bed do I want". */
  setLevel(level: number, tauS: number): void {
    const db = WORLD_BED_DB + (this.entry.trim_db ?? 0);
    const target = Math.max(0.0001, level * dbToGain(db));
    this.gain.gain.setTargetAtTime(target, this.graph.now, tauS);
  }

  dispose(): void {
    this.stop(0.1);
    setTimeout(() => this.gain.disconnect(), 300);
  }
}

export class ContextMusic implements MusicalContext {
  private beds = new Map<BedName, Bed>();
  private loading = new Set<BedName>();
  private current: BedName | null = null;
  private wanted: BedName | null = null;
  private level = 1;
  private enabled = true;

  constructor(
    private graph: AudioGraph,
    private buffers: BufferCache,
  ) {}

  /** Is there any generated bed at all? (Until the tracks are generated the
   * caller keeps using the sound-domain catalog bed.) */
  static anyBedAvailable(): boolean {
    return BED_NAMES.some((n) => hasBed(n));
  }

  /** Ask for a context. Cheap + idempotent — call it every tick. */
  setContext(name: BedName | null): void {
    if (name === this.wanted) return;
    this.wanted = name;
    if (name) void this.ensure(name);
    this.apply();
  }

  /** Master level for the whole context score (music toggle × mode). */
  setLevel(level: number): void {
    this.level = Math.max(0, Math.min(1, level));
    this.apply();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.apply();
  }

  private async ensure(name: BedName): Promise<void> {
    if (this.beds.has(name) || this.loading.has(name)) return;
    const track = bedTrack(name);
    if (!track) return; // not generated yet
    this.loading.add(name);
    const buf = await this.buffers.get(track.url);
    this.loading.delete(name);
    if (!buf || this.beds.has(name)) return;
    this.beds.set(name, new Bed(this.graph, buf, track.entry));
    this.apply();
  }

  /** Drive every live bed toward its target: the wanted one up, the rest down.
   * A faded-out bed is stopped (and remembers its position) so we never hold
   * six decoded buffers and six running sources. */
  private apply(): void {
    const want = this.enabled && this.level > 0.001 ? this.wanted : null;
    for (const [name, bed] of this.beds) {
      const active = name === want;
      if (active) {
        bed.start();
        bed.setLevel(this.level, name === "battle" ? BATTLE_IN_TAU : FADE_IN_TAU);
      } else {
        bed.setLevel(0, FADE_OUT_TAU);
        bed.stop();
      }
    }
    this.current = want && this.beds.has(want) ? want : null;
  }

  /** The bed that is actually audible right now (null while one is loading). */
  activeBed(): BedName | null {
    return this.current;
  }

  // ---- MusicalContext: keeps tonal SFX in key + on the beat ----------------
  // Without these the engine's scale-snap and beat-quantize silently switch
  // off the moment the context score replaces the catalog bed.

  scalePitchClasses(): number[] | null {
    const bed = this.current ? this.beds.get(this.current) : null;
    if (!bed || this.level < 0.05) return null;
    const m = bed.entry.musical;
    return m?.sfx_safe_pitch_classes ?? m?.midi_pitch_classes ?? null;
  }

  nextBeatIn(maxWaitS: number): number {
    const bed = this.current ? this.beds.get(this.current) : null;
    if (!bed || this.level < 0.05) return 0;
    const bpm = bed.entry.timing?.bpm ?? bed.entry.bpm ?? 0;
    if (!bpm || bpm <= 20) return 0;
    const period = 60 / bpm;
    const anchor = bed.entry.timing?.beat_anchor_s ?? 0;
    const since = (bed.position() - anchor) % period;
    const next = period - (since < 0 ? since + period : since);
    return next > 0 && next <= maxWaitS ? next : 0;
  }

  /** The published musical clock for the context score (same shape the
   * MusicDirector publishes, so gameAudio.clock() can hand back either). */
  clock(): {
    playing: boolean;
    bpm: number;
    position: number;
    beatPhase: number;
    barPhase: number;
    nextBeatIn: number;
    section: string | null;
    intensity: number;
    scale: number[] | null;
  } {
    const bed = this.current ? this.beds.get(this.current) : null;
    if (!bed || this.level < 0.05) {
      return {
        playing: false, bpm: 0, position: 0, beatPhase: 0, barPhase: 0,
        nextBeatIn: 0, section: null, intensity: 0, scale: null,
      };
    }
    const bpm = bed.entry.timing?.bpm ?? bed.entry.bpm ?? 0;
    const pos = bed.position();
    const anchor = bed.entry.timing?.beat_anchor_s ?? 0;
    const period = bpm > 20 ? 60 / bpm : 0;
    const phase = (t: number) => (t > 0 ? (((pos - anchor) % t) + t) % t / t : 0);
    return {
      playing: true,
      bpm,
      position: pos,
      beatPhase: phase(period),
      barPhase: phase(period * 4),
      nextBeatIn: this.nextBeatIn(10),
      section: this.current,
      // Loud beds read as "busier" to anything syncing visuals to the score.
      intensity: this.current === "battle" ? 1 : this.current === "town" ? 0.6 : 0.35,
      scale: this.scalePitchClasses(),
    };
  }

  debug(): Record<string, unknown> {
    return {
      wanted: this.wanted,
      active: this.current,
      level: this.level,
      loaded: [...this.beds.keys()],
      loading: [...this.loading],
      available: BED_NAMES.filter((n) => hasBed(n)),
      position: this.current ? Math.round((this.beds.get(this.current)?.position() ?? 0) * 10) / 10 : 0,
    };
  }

  dispose(): void {
    for (const bed of this.beds.values()) bed.dispose();
    this.beds.clear();
  }
}
