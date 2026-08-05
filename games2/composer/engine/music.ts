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
  musicStreamUrl,
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

  // BACKGROUND MODE (maintainer 2026-08-05: "the music suddenly stops ... it
  // should keep playing in a loop as long as the page is open"). The crossfade
  // loop above is re-armed by setTimeout, and background tabs throttle or
  // freeze timers — so the pass ended and the re-arm never came. While the
  // page is hidden the score runs on ONE native-looping source instead
  // (loopStart/loopEnd at the measured points): sample-accurate, zero JS,
  // immune to throttling. The seam is a hard wrap rather than a crossfade,
  // but the loop points were CHOSEN for seam similarity and nobody is
  // A/B-ing seams from another tab. On return the crossfade scheduler takes
  // back over at the position the native loop reached.
  private bgSrc: AudioBufferSourceNode | null = null;
  private bgGain: GainNode | null = null;
  private bgStartCtx = 0;
  private bgStartPos = 0;

  constructor(
    private graph: AudioGraph,
    private buffers: BufferCache,
  ) {
    this.volume = graph.ctx.createGain();
    this.volume.gain.value = 1;
    this.volume.connect(graph.musicDuck);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.enterBackgroundLoop();
      else this.exitBackgroundLoop();
    });
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
    // Stream the compact ogg/m4a, NOT the 21 MB WAV master (musicStreamUrl).
    this.buffer = await this.buffers.get(musicStreamUrl(track));
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
   * begin cf seconds before this one ends, fading equal-power. `fromPos`
   * resumes mid-song (the return from the background native loop); passes
   * armed from here always restart at the loop start as before. */
  private schedulePass(when: number, first: boolean, fromPos?: number): void {
    const buf = this.buffer;
    if (!buf || this.bgSrc || !this.playing) return;
    const { start, end, cf } = this.loopPoints();
    const from = fromPos != null && fromPos >= start && fromPos < end - 1 ? fromPos : start;
    const span = Math.max(1, end - from);
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

    src.start(when, from, span);
    src.onended = () => {
      g.disconnect();
      this.live = this.live.filter((s) => s !== src);
    };
    this.live.push(src);

    // Clock: this pass owns the musical "now" from `when` onward.
    this.segStartCtx = when;
    this.segStartPos = from;

    // Next pass begins cf before this one ends; arm its scheduling a
    // LOOKAHEAD ahead of that so timer jitter can never gap the loop.
    const nextWhen = tEnd - cf;
    const armInMs = Math.max(50, (nextWhen - LOOKAHEAD_S - this.graph.now) * 1000);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.schedulePass(nextWhen, false), armInMs);
  }

  /** HIDDEN: retire the timer and hand the score to a native-looping source.
   * The handoff is click-free: the CURRENT pass keeps playing and fades out
   * on its own scheduled envelope, and the native source starts exactly where
   * the NEXT pass would have (tEnd − cf, at the loop start), fading in over
   * the same crossfade — the seam the scheduler would have made, made once. */
  private enterBackgroundLoop(): void {
    const buf = this.buffer;
    if (!buf || !this.playing || this.bgSrc) return;
    const { start, end, cf } = this.loopPoints();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const ctx = this.graph.ctx;
    const now = this.graph.now;
    // When the pass that is playing right now ends (its envelope already
    // fades to silence there). If the timer was throttled past it, start at
    // once — a moment of silence already happened; end it.
    const tEnd = this.segStartCtx + (end - this.segStartPos);
    const when = Math.max(now + 0.03, tEnd - cf);
    const fadeIn = Math.max(0.1, Math.min(cf, 2));

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = start;
    src.loopEnd = end;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(1, when + fadeIn);
    src.connect(g);
    g.connect(this.volume);
    src.start(when, start);
    this.bgSrc = src;
    this.bgGain = g;
    this.bgStartCtx = when;
    this.bgStartPos = start;
  }

  /** VISIBLE again: fade the native loop out and resume the crossfade
   * scheduler from the position the loop has reached — the song continues,
   * it does not restart (the maintainer's standing rule for every bed). */
  private exitBackgroundLoop(): void {
    const src = this.bgSrc;
    const g = this.bgGain;
    if (!src || !g) return;
    this.bgSrc = null;
    this.bgGain = null;
    const nowEarly = this.graph.now;
    if (nowEarly < this.bgStartCtx - 0.05) {
      // Returned before the handoff even fired: the original pass is still
      // sounding. Cancel the scheduled native source and re-arm the next
      // pass exactly where the handoff would have been.
      try {
        src.stop();
      } catch {
        /* not started */
      }
      g.disconnect();
      // Re-arm THROUGH THE TIMER, like every normal pass: calling
      // schedulePass directly with a far-future `when` makes it claim the
      // musical clock now (segStartCtx in the future → negative position —
      // the second gate run caught exactly that, pos 4.7 → −112.6).
      if (this.playing) {
        const armInMs = Math.max(50, (this.bgStartCtx - LOOKAHEAD_S - nowEarly) * 1000);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.schedulePass(this.bgStartCtx, false), armInMs);
      }
      return;
    }
    const { start, end, cf } = this.loopPoints();
    const span = Math.max(1, end - start);
    const now = this.graph.now;
    const elapsed = Math.max(0, now - this.bgStartCtx);
    const pos = start + ((((this.bgStartPos - start + elapsed) % span) + span) % span);
    const fade = Math.max(0.2, Math.min(cf, 2));
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + fade);
    setTimeout(() => {
      try {
        src.stop();
      } catch {
        /* never started / already stopped */
      }
      g.disconnect();
    }, fade * 1000 + 150);
    if (this.playing) this.schedulePass(now + 0.02, false, pos);
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
    if (this.bgSrc && this.graph.now >= this.bgStartCtx) {
      // Native background loop RUNNING: wrap elapsed time into the window.
      // Before bgStartCtx the handoff is only SCHEDULED — the current pass is
      // still sounding and still owns the clock (the first gate run caught
      // position() freezing for the whole pre-handoff stretch).
      const { start, end } = this.loopPoints();
      const span = Math.max(1, end - start);
      const elapsed = this.graph.now - this.bgStartCtx;
      return start + ((((this.bgStartPos - start + elapsed) % span) + span) % span);
    }
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
      backgroundLoop: !!this.bgSrc,
      backgroundRunning: !!this.bgSrc && this.graph.now >= this.bgStartCtx,
      loop: this.loopPoints(),
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
