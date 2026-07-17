/**
 * The WebAudio graph. One AudioContext, one master chain, one GainNode per
 * bus. Buses (names + base levels) come from the sound actor's
 * bindings.json recommendation; the composer owns the final numbers.
 *
 *   source → [pan] → sound gain → BUS gain → duck (music only) → master → limiter → out
 *
 * Autoplay policy: the context starts suspended until a user gesture. We
 * resume on the first pointer/key anywhere (the select screen's "Enter
 * world" tap usually unlocks it before the world even loads).
 */

import { dbToGain } from "./catalog";

export type BusName = "music" | "sfx" | "ui" | "ambience";

const DEFAULT_BUS_DB: Record<BusName, number> = {
  // Sound-side recommendation (bindings.json) tuned by ear: music is a bed,
  // ambience sits far back, one-shots read clearly over both.
  ui: -12,
  sfx: -14,
  music: -20,
  ambience: -24,
};

export class AudioGraph {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  private insert!: BiquadFilterNode;
  private readonly buses = new Map<BusName, GainNode>();
  /** Music passes through this extra gain so ducking never fights the bus
   * fader or the user's music toggle. */
  readonly musicDuck: GainNode;
  private unlocked = false;

  constructor(busDb?: Partial<Record<string, number>>) {
    type AC = typeof AudioContext;
    const Ctor: AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: AC }).webkitAudioContext;
    this.ctx = new Ctor();

    // Gentle safety limiter so stacked one-shots can never clip the output.
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.18;
    limiter.connect(this.ctx.destination);

    // Full-mix insert: a lowpass the whole game passes through. Wide open it
    // is inaudible; eased down it muffles EVERYTHING at once (underwater,
    // cutscene hush, behind-a-door — one knob, whole world).
    this.insert = this.ctx.createBiquadFilter();
    this.insert.type = "lowpass";
    this.insert.frequency.value = 20000;
    this.insert.Q.value = 0.4;
    this.insert.connect(limiter);

    this.master = this.ctx.createGain();
    this.master.connect(this.insert);

    for (const name of ["music", "sfx", "ui", "ambience"] as BusName[]) {
      const db = busDb?.[name] ?? DEFAULT_BUS_DB[name];
      const g = this.ctx.createGain();
      g.gain.value = dbToGain(db);
      g.connect(this.master);
      this.buses.set(name, g);
    }

    this.musicDuck = this.ctx.createGain();
    this.musicDuck.connect(this.bus("music"));

    // Unlock on the first real user gesture, wherever it lands.
    const unlock = () => {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      if (this.ctx.state === "running") this.unlocked = true;
    };
    for (const ev of ["pointerdown", "keydown", "touchend"]) {
      document.addEventListener(ev, unlock, { capture: true, passive: true });
    }
    // Some browsers re-suspend when the tab backgrounds; resume on return.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.unlocked && this.ctx.state === "suspended") {
        void this.ctx.resume();
      }
    });
  }

  bus(name: BusName): GainNode {
    return this.buses.get(name)!;
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  get running(): boolean {
    return this.ctx.state === "running";
  }

  /** Ease the full-mix lowpass toward a cutoff (Hz). 20000 = wide open. */
  setInsertCutoff(hz: number, tauS = 0.25): void {
    this.insert.frequency.setTargetAtTime(hz, this.now, tauS);
  }

  /** Side-chain duck: dip the music quickly, release back over releaseMs. */
  duckMusic(duckDb: number, releaseMs: number): void {
    const g = this.musicDuck.gain;
    const t = this.now;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(dbToGain(duckDb), t, 0.015);
    g.setTargetAtTime(1, t + 0.09, Math.max(0.05, releaseMs / 1000 / 3));
  }
}

/** Shared decoded-buffer cache: each file is fetched + decoded once. */
export class BufferCache {
  private cache = new Map<string, Promise<AudioBuffer | null>>();

  constructor(private ctx: AudioContext) {}

  get(url: string): Promise<AudioBuffer | null> {
    let p = this.cache.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
        .then((ab) => this.ctx.decodeAudioData(ab))
        .catch((e) => {
          console.warn("[composer] failed to load", url, e);
          this.cache.delete(url); // allow a retry later (CDN blips, dev restarts)
          return null;
        });
      this.cache.set(url, p);
    }
    return p;
  }

  loadedCount(): number {
    return this.cache.size;
  }
}
