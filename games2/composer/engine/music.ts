/**
 * The music director: plays the musician actor's tracks (music/) as the
 * game's score and publishes a MUSICAL CLOCK — current scale + beat grid
 * from the track's measured metadata.json — that the rest of the engine
 * uses to snap tonal SFX into key and quantize stingers to the beat.
 *
 * Looping: generated audio is not sample-loop-perfect, so per the track's
 * own loop recommendation we crossfade loop_end back into loop_start
 * (equal-power, crossfade_ms). Sources are scheduled a couple of seconds
 * ahead on a re-armed timer.
 */

import {
  MusicMetadata,
  MusicTrackRef,
  dbToGain,
  loadMusicMetadata,
  musicUrl,
} from "./catalog";
import { AudioGraph, BufferCache } from "./context";
import { MusicalContext } from "./oneshot";

const LOOKAHEAD_S = 2; // schedule the next loop pass this far ahead

export class MusicDirector implements MusicalContext {
  private track: MusicTrackRef | null = null;
  private meta: MusicMetadata | null = null;
  private buffer: AudioBuffer | null = null;

  /** track sources → volume (fade in/out + night dip) → duck → music bus */
  private volume: GainNode;
  private live: AudioBufferSourceNode[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  // Musical clock: song position of the CURRENT loop pass.
  private segStartCtx = 0; // AudioContext time the pass started
  private segStartPos = 0; // song seconds at that moment
  private playing = false;
  private targetLevel = 1; // 0..1 — enable × night dip, eased in WebAudio

  constructor(
    private graph: AudioGraph,
    private buffers: BufferCache,
  ) {
    this.volume = graph.ctx.createGain();
    this.volume.gain.value = 1;
    this.volume.connect(graph.musicDuck);
  }

  /** Load + start the default background track (lazy — the score is a few
   * MB of WAV, so it streams in after the world is already playable).
   * The catalog now carries REGION themes too (canyon etc.) — the default
   * bed is the track the musician marked as the main/overworld one, never
   * just whichever sorts first. */
  async start(tracks: MusicTrackRef[]): Promise<void> {
    const score = (t: MusicTrackRef): number => {
      const use = (t.use ?? "").toLowerCase();
      let s = 0;
      if (/\b(main|default)\b/.test(use)) s += 4;
      if (use.includes("overworld") || use.includes("background bed")) s += 2;
      if (t.loopable) s += 1;
      return s;
    };
    const track = [...tracks].sort((a, b) => score(b) - score(a))[0];
    if (!track || this.track) return;
    this.track = track;
    this.meta = await loadMusicMetadata(track);
    this.buffer = await this.buffers.get(musicUrl(track.file));
    if (!this.buffer) return;
    this.playing = true;
    this.schedulePass(this.graph.now + 0.05, true);
  }

  private loopPoints(): { start: number; end: number; cf: number } {
    const rec = this.meta?.loop?.recommended;
    const dur = this.buffer?.duration ?? this.track?.duration_s ?? 0;
    const start = rec?.loop_start_s ?? 0;
    const end = Math.min(rec?.loop_end_s ?? dur, dur);
    const cf = Math.min(2, (rec?.crossfade_ms ?? 600) / 1000);
    return { start, end, cf };
  }

  /** Start one pass of the loop at ctx time `when`; arm the next pass to
   * begin cf seconds before this one ends, fading equal-power. */
  private schedulePass(when: number, first: boolean): void {
    const buf = this.buffer;
    if (!buf || !this.playing) return;
    const { start, end, cf } = this.loopPoints();
    const span = Math.max(1, end - start);
    const ctx = this.graph.ctx;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    src.connect(g);
    g.connect(this.volume);

    // Equal-power edges: fade in over cf (except the very first pass, which
    // rises from silence a touch slower for a gentler entrance), fade out
    // over the cf overlapping the NEXT pass's fade-in.
    const fadeIn = first ? Math.max(cf, 1.2) : cf;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(1, when + fadeIn);
    const tEnd = when + span; // this pass plays start..end
    g.gain.setValueAtTime(1, tEnd - cf);
    g.gain.exponentialRampToValueAtTime(0.0001, tEnd);

    src.start(when, start, span);
    src.onended = () => {
      g.disconnect();
      this.live = this.live.filter((s) => s !== src);
    };
    this.live.push(src);

    // Clock: this pass owns the musical "now" from `when` onward.
    this.segStartCtx = when;
    this.segStartPos = start;

    // Next pass begins cf before this one ends; arm its scheduling a
    // LOOKAHEAD ahead of that so timer jitter can never gap the loop.
    const nextWhen = tEnd - cf;
    const armInMs = Math.max(50, (nextWhen - LOOKAHEAD_S - this.graph.now) * 1000);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.schedulePass(nextWhen, false), armInMs);
  }

  /** 0..1 target level (user music toggle × night dip). Mood changes ease
   * slowly (default tau); the user's on/off toggle passes a fast tau so the
   * switch FEELS like a switch (maintainer: "doesn't toggle on/off"). */
  setLevel(level: number, tauS = 0.4): void {
    if (Math.abs(level - this.targetLevel) < 0.01) return;
    this.targetLevel = level;
    this.volume.gain.setTargetAtTime(Math.max(0.0001, level), this.graph.now, tauS);
  }

  /** Song position in seconds (within the current loop pass). */
  position(): number {
    if (!this.playing) return 0;
    return this.segStartPos + (this.graph.now - this.segStartCtx);
  }

  /** THE MUSICAL CLOCK — the published heartbeat of the score, readable by
   * ANY system every frame (lights, animation, shaders, ambient life). This
   * is the anti-callback: instead of audio subscribing to the game, the
   * world can breathe with the music. beatPhase ramps 0→1 between measured
   * beats (timing.beats_s); barPhase between downbeats; section/intensity
   * come from the track's composition plan. */
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
    const idle = {
      playing: false, bpm: 0, position: 0, beatPhase: 0, barPhase: 0,
      nextBeatIn: 0, section: null, intensity: 0, scale: null,
    };
    if (!this.playing || this.targetLevel < 0.05) return idle;
    const pos = this.position();
    const t = this.meta?.timing;
    const bpm = t?.tempo?.grid_bpm ?? this.meta?.musical?.tempo_bpm ?? this.track?.bpm ?? 0;
    const sections = this.meta?.structure?.sections ?? [];
    const sec = sections.find((s) => pos >= s.start_s && pos < s.end_s) ?? null;
    return {
      playing: true,
      bpm,
      position: pos,
      beatPhase: phaseIn(t?.beats_s, pos, bpm > 0 ? 60 / bpm : 0),
      barPhase: phaseIn(t?.downbeats_s, pos, bpm > 0 ? 240 / bpm : 0),
      nextBeatIn: this.nextBeatIn(10),
      section: sec?.name ?? null,
      intensity: sec?.intensity ?? 0.5,
      scale: this.scalePitchClasses(),
    };
  }

  // ---- MusicalContext ----

  scalePitchClasses(): number[] | null {
    if (!this.playing || this.targetLevel < 0.05) return null;
    const key = this.meta?.musical?.key;
    return key?.sfx_safe_pitch_classes ?? key?.midi_pitch_classes ?? null;
  }

  nextBeatIn(maxWaitS: number): number {
    const beats = this.meta?.timing?.beats_s;
    if (!this.playing || !beats || beats.length === 0) return 0;
    const pos = this.position();
    // beats_s is sorted — find the first beat after `pos`.
    let lo = 0;
    let hi = beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] <= pos) lo = mid + 1;
      else hi = mid;
    }
    const next = lo < beats.length ? beats[lo] - pos : 0;
    return next > 0 && next <= maxWaitS ? next : 0;
  }

  debug(): Record<string, unknown> {
    return {
      clock: this.clock(),
      track: this.track?.id ?? null,
      playing: this.playing,
      loaded: !!this.buffer,
      position: Math.round(this.position() * 100) / 100,
      level: this.targetLevel,
      scale: this.scalePitchClasses(),
      liveSources: this.live.length,
    };
  }
}

/** 0→1 phase within the measured grid around `pos` (falls back to a fixed
 * period when the grid is missing). */
function phaseIn(grid: number[] | undefined, pos: number, fallbackPeriod: number): number {
  if (grid && grid.length > 1) {
    let lo = 0;
    let hi = grid.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (grid[mid] <= pos) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && lo < grid.length) {
      const prev = grid[lo - 1];
      const next = grid[lo];
      if (next > prev) return (pos - prev) / (next - prev);
    }
  }
  if (fallbackPeriod > 0) return (pos % fallbackPeriod) / fallbackPeriod;
  return 0;
}

export { dbToGain };
