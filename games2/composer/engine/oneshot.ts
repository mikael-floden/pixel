/**
 * One-shot playback: round-robin takes, pitch/gain/start jitter (the sound
 * actor's per-sound variation contract), distance/pan spatialization — and
 * the MUSICAL_SFX.md trick: tonal one-shots are pitch-snapped onto the
 * currently playing track's sfx-safe scale tones, so chimes and pickups ring
 * IN TUNE with the score. Non-tonal foley is never shifted (pitched noise
 * just sounds wrong); shifts are capped by the sound's own measured
 * max_shift_semitones.
 */

import { SoundEntry, dbToGain, soundUrl } from "./catalog";
import { AudioGraph, BufferCache, BusName } from "./context";

/** What the music director exposes to the rest of the engine. */
export interface MusicalContext {
  /** Pitch classes (0-11) that are SAFE for SFX right now, or null when no
   * tonal music is playing (→ no snapping). */
  scalePitchClasses(): number[] | null;
  /** Seconds until the next musical beat, or 0 when unknown/not playing.
   * Never exceeds maxWait (an event beyond it just plays immediately). */
  nextBeatIn(maxWaitS: number): number;
}

export interface PlayOpts {
  /** -1 (hard left) .. 1 (hard right); 0 = centre. */
  pan?: number;
  /** 0 (at the listener) .. 1 (edge of earshot) — attenuates + softens. */
  dist?: number;
  /** Extra gain trim in dB on top of the catalog mix gain. */
  gainDb?: number;
  /** Multiply playbackRate (thunder rumbles etc.). */
  rate?: number;
  /** Lowpass cutoff Hz (distance/underwater muffling). */
  lowpassHz?: number;
  /** Delay the start by this many seconds (thunder after lightning). */
  delayS?: number;
  /** Quantize the start to the music's next beat (stingers, magic). */
  onBeat?: boolean;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class OneShotPlayer {
  private lastTake = new Map<string, number>();
  private lastPlayedAt = new Map<string, number>();
  played = 0;
  /** ENFORCE UNMODIFIED AUDIO (maintainer testing switch): when true every
   * one-shot plays the raw file — no pitch/gain/start jitter, no scale-snap,
   * no rate change, no lowpass, no pan, no distance attenuation, no delay.
   * Only static level balance survives (per-sound mix gain + bus fader), so
   * the maintainer can hear the ASSET itself and judge whether a bad sound
   * is the audio or the composer's processing. */
  pure = false;

  constructor(
    private graph: AudioGraph,
    private buffers: BufferCache,
    private musical: MusicalContext,
  ) {}

  /** Fire-and-forget. Resolves the buffer lazily; a first-ever play may land
   * a few ms late (the cache holds it for every play after). */
  play(sound: SoundEntry, bus: BusName, opts: PlayOpts = {}): void {
    if (!this.graph.running) return;
    // Debounce identical spam (UI taps, overlapping pickups): a sound can
    // retrigger, but not twice within 30ms — that only doubles the volume.
    const now = performance.now();
    const last = this.lastPlayedAt.get(sound.id) ?? -1e9;
    if (now - last < 30) return;
    this.lastPlayedAt.set(sound.id, now);

    void this.buffers.get(this.pickTake(sound)).then((buf) => {
      if (buf) this.start(sound, bus, buf, opts);
    });
  }

  /** Round-robin across takes, never repeating the last one (the sound
   * actor's variation contract — repeating foley reads as a machine gun).
   * Returns a ready URL: composer-bundled `urls` win over catalog paths. */
  private pickTake(sound: SoundEntry): string {
    if (sound.urls && sound.urls.length > 0) return this.pickFrom(sound.id, sound.urls);
    return soundUrl(this.pickFrom(sound.id, sound.takes?.length ? sound.takes : [sound.file]));
  }

  private pickFrom(id: string, takes: string[]): string {
    if (takes.length === 1) return takes[0];
    const last = this.lastTake.get(id) ?? -1;
    let idx = Math.floor(Math.random() * takes.length);
    if (idx === last) idx = (idx + 1) % takes.length;
    this.lastTake.set(id, idx);
    return takes[idx];
  }

  private start(sound: SoundEntry, bus: BusName, buf: AudioBuffer, opts: PlayOpts): void {
    const ctx = this.graph.ctx;

    if (this.pure) {
      // Raw playback: source → static gain → bus. Nothing else touches it.
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = dbToGain((sound.mix_gain_db ?? 0) + (opts.gainDb ?? 0));
      src.connect(g);
      g.connect(this.graph.bus(bus));
      src.start();
      src.onended = () => g.disconnect();
      this.played++;
      return;
    }

    const v = sound.variation;

    // ---- pitch: scale-snap (tonal) or random jitter (foley) ----
    let semis = 0;
    let snapped = false;
    const m = sound.music;
    const scale = this.musical.scalePitchClasses();
    if (m?.tonal && m.root_midi != null && m.max_shift_semitones > 0 && scale && scale.length) {
      semis = clampShift(nearestScaleShift(m.root_midi, scale), m.max_shift_semitones);
      snapped = true;
    }
    if (!(snapped && (m?.scale_snap_replaces_jitter ?? true)) && v?.pitch_jitter_semitones) {
      semis += rand(v.pitch_jitter_semitones[0], v.pitch_jitter_semitones[1]);
    }

    // ---- gain ----
    let db = (sound.mix_gain_db ?? 0) + (opts.gainDb ?? 0);
    if (v?.gain_jitter_db) db += rand(v.gain_jitter_db[0], v.gain_jitter_db[1]);
    const dist = Math.min(1, Math.max(0, opts.dist ?? 0));
    let gain = dbToGain(db) * (1 - 0.85 * dist * dist);
    if (gain <= 0.001) return;

    // ---- graph: source → [lowpass] → [pan] → gain → bus ----
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, semis / 12) * (opts.rate ?? 1);

    let head: AudioNode = src;
    const cutoff = opts.lowpassHz ?? (dist > 0.4 ? 12000 - 9500 * dist : 0);
    if (cutoff > 0) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = cutoff;
      head.connect(lp);
      head = lp;
    }
    const pan = Math.max(-1, Math.min(1, opts.pan ?? 0));
    if (pan !== 0 && typeof ctx.createStereoPanner === "function") {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      head.connect(p);
      head = p;
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    head.connect(g);
    g.connect(this.graph.bus(bus));

    // ---- when ----
    let delay = opts.delayS ?? 0;
    if (v?.start_jitter_ms) delay += rand(v.start_jitter_ms[0], v.start_jitter_ms[1]) / 1000;
    if (opts.onBeat) delay += this.musical.nextBeatIn(0.6);
    src.start(this.graph.now + delay);
    src.onended = () => {
      g.disconnect();
    };
    this.played++;
  }
}

/** Smallest signed semitone shift that lands rootMidi on one of the scale's
 * pitch classes (octave-equivalent — a +7 is considered as -5 too). */
export function nearestScaleShift(rootMidi: number, scalePcs: number[]): number {
  const pc = ((Math.round(rootMidi) % 12) + 12) % 12;
  let best = 0;
  let bestAbs = Infinity;
  for (const s of scalePcs) {
    for (const octave of [-12, 0, 12]) {
      const d = s + octave - pc;
      if (Math.abs(d) < bestAbs) {
        bestAbs = Math.abs(d);
        best = d;
      }
    }
  }
  return best;
}

function clampShift(semis: number, max: number): number {
  return Math.max(-max, Math.min(max, semis));
}
