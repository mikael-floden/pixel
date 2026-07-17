/**
 * The ambience mixer: a stack of looping BEDS (sounds/ambience/*) whose
 * levels ease toward targets the composer recomputes from the world's live
 * mood — time of day, weather, and what the terrain around the player
 * actually is (forest, water, town, fire). Beds fade over seconds, never
 * cut. Buffers load lazily the first time a bed is audible.
 *
 * Note on levels: the catalog stamps every ambience entry with the same
 * mix_gain_db (-20) AND the bus recommendation is very low; stacked they'd
 * be inaudible. The composer owns the final mix (AUDIO_INTEGRATION.md), so
 * beds run at unity into the ambience bus and the BUS level sets the floor.
 */

import { SoundEntry, soundUrl } from "./catalog";
import { AudioGraph, BufferCache } from "./context";

const FADE_TAU_S = 1.6; // setTargetAtTime time-constant: ~5s to settle
const STOP_AFTER_SILENT_MS = 12_000;

interface Layer {
  gain: GainNode;
  src: AudioBufferSourceNode | null;
  target: number;
  silentSince: number; // performance.now() when target hit 0 (-1 = audible)
  loading: boolean;
}

export class AmbienceMixer {
  private layers = new Map<string, Layer>();

  constructor(
    private graph: AudioGraph,
    private buffers: BufferCache,
    private catalog: Map<string, SoundEntry>,
  ) {}

  /** Ease every bed toward its target level (0..1). Ids not mentioned keep
   * their previous target. Call at a few Hz; cheap. */
  setTargets(targets: Record<string, number>): void {
    if (!this.graph.running) return;
    const now = performance.now();
    for (const [id, raw] of Object.entries(targets)) {
      const target = Math.min(1, Math.max(0, raw));
      let layer = this.layers.get(id);
      if (!layer) {
        if (target <= 0.01) continue; // never load a bed nobody can hear
        const gain = this.graph.ctx.createGain();
        gain.gain.value = 0.0001;
        gain.connect(this.graph.bus("ambience"));
        layer = { gain, src: null, target: 0, silentSince: -1, loading: false };
        this.layers.set(id, layer);
      }
      layer.target = target;
      if (target > 0.01) {
        layer.silentSince = -1;
        this.ensurePlaying(id, layer);
      } else if (layer.silentSince < 0) {
        layer.silentSince = now;
      }
      layer.gain.gain.setTargetAtTime(Math.max(0.0001, target), this.graph.now, FADE_TAU_S);

      // Reclaim silent sources (buffers stay cached for instant restarts).
      if (layer.src && layer.silentSince >= 0 && now - layer.silentSince > STOP_AFTER_SILENT_MS) {
        try {
          layer.src.stop();
        } catch {}
        layer.src.disconnect();
        layer.src = null;
      }
    }
  }

  private ensurePlaying(id: string, layer: Layer): void {
    if (layer.src || layer.loading) return;
    const entry = this.catalog.get(id);
    if (!entry) return;
    layer.loading = true;
    void this.buffers.get(soundUrl(entry.file)).then((buf) => {
      layer.loading = false;
      if (!buf || layer.src || layer.target <= 0.01) return;
      const src = this.graph.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      // Desynchronize multiple joins/restarts: start anywhere in the bed.
      const offset = Math.random() * buf.duration;
      src.connect(layer.gain);
      src.start(this.graph.now, offset);
      layer.src = src;
    });
  }

  debug(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [id, l] of this.layers) {
      out[id] = { target: Math.round(l.target * 100) / 100, playing: !!l.src };
    }
    return out;
  }
}
