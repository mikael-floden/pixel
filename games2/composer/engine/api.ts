/**
 * GameAudio — the composer's public face. The game emits SEMANTIC events
 * (audio.event("ui.confirm"), audio.avatarFrame(...)); this class decides
 * what actually sounds: binding resolution, buses, footstep cadence,
 * ambience mood, music level, ducking. One instance per page (exported
 * from composer/index.ts).
 *
 * Everything degrades gracefully: no audio contexts before the first user
 * gesture, missing catalogs → silence, never a throw into the game loop.
 */

import { Bindings, Catalog, SoundEntry, loadCatalog, soundUrl } from "./catalog";
import { AudioGraph, BufferCache, BusName } from "./context";
import { AmbienceMixer } from "./ambience";
import { MusicDirector } from "./music";
import { OneShotPlayer, PlayOpts } from "./oneshot";
import { composerFoley, composerFoleySurfaces } from "./foley";

/** Per-avatar, per-frame movement sample — the scene reports what the body
 * is doing; the composer turns it into footsteps at gait cadence. */
export interface AvatarFrame {
  moving: boolean;
  running: boolean;
  grounded: boolean; // false mid-hop / falling
  swimming: boolean;
  /** shared/SURFACES sound id under the feet ("grass"|"stone"|"wood"|...). */
  surface: string;
  /** World-units moved since last frame (the gait EMA's raw distance). */
  distWu: number;
  /** Spatialization for OTHER players; the local player passes 0/0. */
  pan?: number;
  dist?: number;
}

interface EnvState {
  sun: number; // 0..1 sun strength (0 all night)
  cloud: number;
  mist: number;
}

/** Terrain mood around the listener, sampled by the scene (fractions 0..1). */
export interface FieldSample {
  forest: number;
  water: number;
  town: number;
  fire: number;
}

// Footfall cadence: distance between footfalls in world units. Matches the
// measured gait design (walk ~49.5 wu/s side-view → ~2 steps/s).
const WALK_STEP_WU = 25;
const RUN_STEP_WU = 38;

// Surface sound id (shared/SURFACES) → catalog footstep + character tweak.
// Only three foley sets exist yet; the tweaks keep sand/snow/swamp from
// reading as plain grass until the sound actor ships dedicated sets.
const FOOTSTEPS: Record<string, { id: string; rate?: number; gainDb?: number; lowpassHz?: number }> = {
  grass: { id: "footstep_grass" },
  dirt: { id: "footstep_grass", rate: 0.94 },
  sand: { id: "footstep_grass", rate: 0.9, gainDb: -2 },
  snow: { id: "footstep_grass", rate: 0.8, gainDb: -1, lowpassHz: 2600 },
  swamp: { id: "footstep_grass", rate: 0.72, gainDb: 1 },
  stone: { id: "footstep_stone" },
  ice: { id: "footstep_stone", rate: 1.12, gainDb: -4 },
  wood: { id: "footstep_wood" },
};

const SETTINGS_KEY = "ml-audio";

interface AvatarGait {
  travelled: number; // wu since last footfall
  swimming: boolean;
}

export class GameAudio {
  private graph: AudioGraph | null = null;
  private buffers!: BufferCache;
  private oneShots!: OneShotPlayer;
  private music!: MusicDirector;
  private ambience!: AmbienceMixer;
  private catalog: Catalog | null = null;
  private bindings = new Map<string, { sound: string; bus: BusName; duck: boolean }>();
  private gaits = new Map<string, AvatarGait>();
  private env: EnvState = { sun: 1, cloud: 0, mist: 0 };
  private fieldSampler: (() => FieldSample | null) | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private musicWanted = false;
  private underwater = false;
  private mode = "overworld";

  /** Music-level multiplier per mixing mode (see setMode). */
  private static MODE_MUSIC: Record<string, number> = {
    overworld: 1,
    town: 0.9,
    scary: 0.55,
    hushed: 0.25,
  };

  // User settings (persisted): master sound + music independently.
  private soundOn = true;
  private musicOn = true;

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as {
        sound?: boolean;
        music?: boolean;
      };
      this.soundOn = s.sound !== false;
      this.musicOn = s.music !== false;
    } catch {}
  }

  /** Boot: build the graph, fetch the contracts, warm the common one-shots.
   * Safe to call more than once; must be called from the browser. */
  init(): void {
    if (this.graph) return;
    try {
      this.graph = new AudioGraph();
    } catch (e) {
      console.warn("[composer] WebAudio unavailable — game runs silent", e);
      return;
    }
    this.buffers = new BufferCache(this.graph.ctx);
    this.music = new MusicDirector(this.graph, this.buffers);
    this.oneShots = new OneShotPlayer(this.graph, this.buffers, this.music);
    this.applyMasterGain();

    void loadCatalog().then((cat) => {
      this.catalog = cat;
      this.ambience = new AmbienceMixer(this.graph!, this.buffers, cat.sounds);
      this.indexBindings(cat.bindings);
      // Warm what fires constantly, so the first step isn't late.
      for (const id of [
        "footstep_grass", "footstep_stone", "footstep_wood", "jump", "splash",
        "menu_select", "menu_confirm", "menu_cancel", "notification", "gem_pickup",
      ]) {
        const s = cat.sounds.get(id);
        if (s) void this.buffers.get(soundUrl(s.file));
      }
      if (this.musicWanted) void this.music.start(cat.music);
    });

    this.tick = setInterval(() => this.slowTick(), 250);
  }

  private indexBindings(b: Bindings): void {
    const busOf = (name?: string): BusName =>
      name === "ui" || name === "music" || name === "ambience" ? name : "sfx";
    for (const e of b.events ?? []) {
      if (e.sound) this.bindings.set(e.event, { sound: e.sound, bus: busOf(e.bus), duck: !!e.duck });
    }
  }

  /** The world is live — bring the score in. */
  startMusic(): void {
    this.musicWanted = true;
    if (this.catalog && this.graph) void this.music.start(this.catalog.music);
  }

  // ---- semantic events ----

  /** Events whose sound the composer has taken in-house (maintainer QA:
   * the catalog UI clicks "sound like a piano, not like buttons"). When the
   * named foley set exists under composer/foley/, it wins over the catalog
   * binding; until generated, the catalog remains the fallback. */
  private static EVENT_FOLEY: Record<string, string> = {
    "ui.cursor_move": "ui_tick",
    "ui.confirm": "ui_confirm",
    "ui.cancel": "ui_cancel",
    "ui.error": "ui_cancel",
  };

  /** Fire a bound event (sounds/bindings.json names: "ui.confirm",
   * "player.jump", ...). Unknown events are silent no-ops. */
  event(name: string, opts: PlayOpts = {}): void {
    if (!this.ready()) return;
    const ownSet = GameAudio.EVENT_FOLEY[name];
    const own = ownSet ? composerFoley(ownSet) : null;
    if (ownSet && own) {
      this.oneShots.play(this.foleyEntry(ownSet, own, "click"), "ui", opts);
      return;
    }
    const bound = this.bindings.get(name);
    if (!bound) return;
    const sound = this.catalog!.sounds.get(bound.sound);
    if (!sound) return;
    this.oneShots.play(sound, bound.bus, opts);
    if (bound.duck) this.duck();
  }

  /** Play a catalog sound directly (composer's own flourishes). */
  play(soundId: string, bus: BusName = "sfx", opts: PlayOpts = {}): void {
    if (!this.ready()) return;
    const sound = this.catalog!.sounds.get(soundId);
    if (sound) this.oneShots.play(sound, bus, opts);
  }

  /** Distant thunder to accompany a lightning flash: the explosion take
   * slowed to a rumble, muffled, arriving 1-2.5s after the light (the
   * storm is beyond the horizon). */
  thunder(strength = 1): void {
    if (!this.ready()) return;
    const sound = this.catalog!.sounds.get("explosion");
    if (!sound) return;
    this.oneShots.play(sound, "ambience", {
      rate: 0.38 + Math.random() * 0.14,
      lowpassHz: 300 + Math.random() * 200,
      gainDb: 14 + 6 * Math.min(1, strength), // beds run quiet; a rumble must not
      delayS: 1.0 + Math.random() * 1.5,
      pan: (Math.random() - 0.5) * 0.8,
    });
  }

  /** A shooting star: a soft chime snapped into key ON the next beat —
   * the sky twinkles in time with the score. */
  star(): void {
    this.play("gem_pickup", "sfx", { gainDb: -10, onBeat: true, pan: (Math.random() - 0.5) * 0.6 });
  }

  // ---- movement → footsteps ----

  avatarFrame(id: string, f: AvatarFrame): void {
    if (!this.ready()) return;
    let g = this.gaits.get(id);
    if (!g) {
      g = { travelled: 0, swimming: f.swimming };
      this.gaits.set(id, g);
    }

    // Water edges: entering/leaving water splashes (server owns swimming).
    if (f.swimming !== g.swimming) {
      g.swimming = f.swimming;
      this.play("splash", "sfx", {
        pan: f.pan,
        dist: f.dist,
        gainDb: f.swimming ? 0 : -6,
        rate: f.swimming ? 1 : 1.15,
      });
    }

    if (!f.moving || !f.grounded || f.swimming) {
      g.travelled = Math.min(g.travelled, WALK_STEP_WU * 0.55); // next start-step comes quickly
      return;
    }
    g.travelled += Math.max(0, f.distWu);
    const stepLen = f.running ? RUN_STEP_WU : WALK_STEP_WU;
    if (g.travelled < stepLen) return;
    g.travelled = 0;

    // Composer-generated per-surface foley wins (maintainer QA rated the
    // catalog sets bad/okeyish); catalog mapping is the fallback until every
    // surface is regenerated.
    const own = composerFoley(f.surface);
    if (own) {
      this.oneShots.play(this.foleyEntry(f.surface, own, "step"), "sfx", {
        pan: f.pan,
        dist: f.dist,
        rate: f.running ? 1.05 : 1,
        gainDb: -8 + (f.running ? 1.5 : 0),
      });
      return;
    }
    const foot = FOOTSTEPS[f.surface];
    if (!foot) return; // water/void/unknown: no dry footfall
    this.play(foot.id, "sfx", {
      pan: f.pan,
      dist: f.dist,
      rate: (foot.rate ?? 1) * (f.running ? 1.06 : 1),
      gainDb: (foot.gainDb ?? 0) + (f.running ? 1.5 : 0),
      lowpassHz: foot.lowpassHz,
    });
  }

  private foleyCache = new Map<string, SoundEntry>();

  /** Synthetic catalog entry for a composer-generated foley set (bundled
   * absolute URLs). Profiles: "step" varies like foley footfalls; "click"
   * stays tight — a button must sound like the SAME button every press. */
  private foleyEntry(set: string, urls: string[], profile: "step" | "click"): SoundEntry {
    let e = this.foleyCache.get(set);
    if (!e) {
      const step = profile === "step";
      e = {
        id: `composer_foley_${set}`,
        category: step ? "movement" : "ui",
        loop: false,
        file: urls[0],
        urls,
        mix_gain_db: 0, // level is decided per-play by the caller
        variation: {
          round_robin: true,
          no_immediate_repeat: true,
          pitch_jitter_semitones: step ? [-1.5, 1.5] : [-0.4, 0.4],
          gain_jitter_db: step ? [-2.5, 2.5] : [-1, 0.5],
          start_jitter_ms: step ? [0, 15] : [0, 0],
        },
        music: {
          tonal: false,
          root_midi: null,
          pitch_confidence: 0,
          max_shift_semitones: 0,
          scale_snap_replaces_jitter: false,
        },
      };
      this.foleyCache.set(set, e);
    }
    return e;
  }

  dropAvatar(id: string): void {
    this.gaits.delete(id);
  }

  // ---- the musical clock (audio → game) ----

  /** The score's live heartbeat: beat/bar phase, section, intensity, scale.
   * Poll it every frame from ANY system — light flicker, animation nudges,
   * shader pulses, petals falling on downbeats. This is the anti-callback:
   * the world reads the music instead of the music subscribing to the world. */
  clock(): ReturnType<MusicDirector["clock"]> {
    if (!this.graph) {
      return {
        playing: false, bpm: 0, position: 0, beatPhase: 0, barPhase: 0,
        nextBeatIn: 0, section: null, intensity: 0, scale: null,
      };
    }
    return this.music.clock();
  }

  // ---- modes (mixing scenes) ----

  /** A MODE is a whole mixing scene — town / combat / scary / menu — that
   * biases every decision at once. Today it scales the music level; the seam
   * is here so new modes are one table row, not a refactor. */
  setMode(mode: string): void {
    this.mode = mode;
  }

  // ---- world mood ----

  setEnv(env: Partial<EnvState>): void {
    Object.assign(this.env, env);
  }

  /** Underwater: ease the full-mix lowpass down while the player swims —
   * the whole world (music, birds, other players' steps) muffles together. */
  setUnderwater(on: boolean): void {
    if (on === this.underwater || !this.graph) return;
    this.underwater = on;
    this.graph.setInsertCutoff(on ? 900 : 20000, on ? 0.15 : 0.35);
  }

  /** The scene provides terrain fractions around the listener (4Hz). */
  setFieldSampler(fn: (() => FieldSample | null) | null): void {
    this.fieldSampler = fn;
  }

  /** Slow tick (4 Hz): recompute ambience targets + music level. */
  private slowTick(): void {
    if (!this.ready() || !this.ambience) return;
    const { sun, cloud, mist } = this.env;
    const night = 1 - sun;
    const field = this.fieldSampler?.() ?? { forest: 0, water: 0, town: 0, fire: 0 };
    const day = sun * (1 - 0.45 * cloud);

    this.ambience.setTargets({
      // The base pastoral pair: birdsong owns the day, crickets own the night.
      birds_day: day * (0.45 + 0.55 * field.forest) * (1 - 0.6 * field.town),
      crickets_night: night * (0.5 + 0.5 * field.forest),
      // Weather: wind under cloud, an eerie thin wind inside mist.
      wind: 0.18 + 0.55 * cloud + 0.35 * mist,
      // Terrain beds from the live field sample.
      forest: field.forest * (0.35 + 0.4 * sun),
      river: field.water,
      town_murmur: field.town * (0.25 + 0.75 * sun),
      fire_crackle: field.fire,
    });

    // The score dips into the night — Nangijala's nights belong to the
    // crickets and the fires; music returns with the light.
    const modeMul = GameAudio.MODE_MUSIC[this.mode] ?? 1;
    this.music.setLevel(this.musicOn ? (0.45 + 0.55 * sun) * modeMul : 0);
  }

  private duck(): void {
    const d = this.catalog?.bindings.ducking;
    this.graph?.duckMusic(d?.music_duck_db ?? -5, d?.release_ms ?? 300);
  }

  // ---- settings (HUD switches) ----

  get soundEnabled(): boolean {
    return this.soundOn;
  }
  get musicEnabled(): boolean {
    return this.musicOn;
  }

  toggleSound(): void {
    this.soundOn = !this.soundOn;
    this.applyMasterGain();
    this.persist();
  }

  toggleMusic(): void {
    this.musicOn = !this.musicOn;
    this.slowTickSoon();
    this.persist();
  }

  private applyMasterGain(): void {
    if (!this.graph) return;
    this.graph.master.gain.setTargetAtTime(this.soundOn ? 1 : 0.0001, this.graph.now, 0.1);
  }

  private slowTickSoon(): void {
    this.slowTick();
  }

  private persist(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ sound: this.soundOn, music: this.musicOn }));
    } catch {}
  }

  private ready(): boolean {
    return !!(this.graph && this.catalog && this.graph.running && this.soundOn);
  }

  /** QA probe surface (__ml.audio()). */
  debug(): Record<string, unknown> {
    return {
      context: this.graph?.ctx.state ?? "none",
      catalog: this.catalog ? this.catalog.sounds.size : 0,
      buffers: this.graph ? this.buffers.loadedCount() : 0,
      played: this.graph ? this.oneShots.played : 0,
      sound: this.soundOn,
      musicOn: this.musicOn,
      foley: composerFoleySurfaces(),
      mode: this.mode,
      underwater: this.underwater,
      music: this.graph ? this.music.debug() : null,
      ambience: this.ambience?.debug() ?? null,
      env: { ...this.env },
    };
  }
}

export type { SoundEntry };
