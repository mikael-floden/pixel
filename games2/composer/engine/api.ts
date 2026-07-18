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
  /** Standing on the wet shoreline band (walkable tile adjacent to water):
   * footsteps switch to the wet set (maintainer 2026-07-18). */
  wetGround?: boolean;
  /** World-units moved since last frame (the gait EMA's raw distance). */
  distWu: number;
  /** 0..1 progress of the walk/run animation cycle, when one is playing.
   * THE sync source: footfalls trigger at fixed phases of the visible
   * stride (maintainer: distance-guessed walking steps were out of sync
   * with the animation) — the distance accumulator is only a fallback. */
  animPhase?: number;
  /** Spatialization for OTHER players; the local player passes 0/0. */
  pan?: number;
  dist?: number;
}

interface EnvState {
  sun: number; // 0..1 sun strength (0 all night)
  cloud: number;
  mist: number;
  rain: number; // 0..1 (drizzle ~0.35, rain ~0.7, heavy/storm 1)
  storm: boolean; // Storm weather (thunder episodes also set storm)
  snow: boolean;
  windy: boolean;
}

/** Terrain mood around the listener, sampled by the scene (fractions 0..1). */
export interface FieldSample {
  forest: number;
  water: number;
  town: number;
  fire: number;
}

// Footfall cadence fallback: distance between footfalls in world units —
// used only when no walk/run animation progress is available (placeholder
// characters). Real sync comes from FOOT_PHASES on the animation cycle.
const WALK_STEP_WU = 25;
const RUN_STEP_WU = 38;
// The two foot plants within one walk/run animation loop (0..1 phase).
// Tunable: if the plant reads early/late on screen, nudge both together.
const FOOT_PHASES = [0.05, 0.55];

// Footstep routing (maintainer directives 2026-07-18): the approved STONE
// set is the default for every dry surface; per-surface sets are enabled
// ONE AT A TIME with explicit approval. Snow re-enabled for trial ("let's
// try the snow version") — same gentleness as stone: primary take every
// step, micro-jitter only. Water stays splash/swim, no dry footfall.
const FOOTSTEP_SETS: Record<string, string> = { snow: "snow" };
const FOOTSTEP_DEFAULT = "stone";
// Per-SURFACE trims on top of the step base (maintainer verdicts
// 2026-07-18): snow −12 ("too loud" ×2, run level then approved), grass
// −1 ("maybe 90% of current"). Keyed by surface sound id so e.g. grass
// can be trimmed without touching stone-on-stone tiles.
const FOOTSTEP_TRIM_DB: Record<string, number> = { snow: -12, grass: -1 };
// The wet shoreline step is the catalog splash played like the water-EXIT
// sound the maintainer approved: pitched up ~15% (brighter, lighter than
// the duller entry splosh). A fixed character choice, not per-step drift.
const WET_STEP_RATE = 1.15;
// Walk plays softer than run by this penalty (default −3 dB ≈ 70%). Snow's
// walk penalty is ZERO: at −3 on top of its deep trim the maintainer heard
// "nothing at all" — snow walking now sits just under snow running.
const FOOTSTEP_WALK_PENALTY_DB: Record<string, number> = { snow: 0 };
const WALK_PENALTY_DEFAULT_DB = -3;
const FOOTSTEP_JITTER: Record<string, { pitch: [number, number]; gain: [number, number] }> = {
  snow: { pitch: [-0.35, 0.35], gain: [-1.0, 0.6] },
};

const SETTINGS_KEY = "ml-audio";

interface AvatarGait {
  travelled: number; // wu since last footfall (fallback cadence only)
  lastPhase?: number; // last seen walk/run animation phase (sync source)
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
  private env: EnvState = {
    sun: 1, cloud: 0, mist: 0, rain: 0, storm: false, snow: false, windy: false,
  };
  private fieldSampler: (() => FieldSample | null) | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private musicWanted = false;
  private underwater = false;
  private storm = false;
  private musicToggleFast = false;
  private mode = "overworld";

  /** Music-level multiplier per mixing mode (see setMode). */
  private static MODE_MUSIC: Record<string, number> = {
    overworld: 1,
    town: 0.9,
    scary: 0.55,
    hushed: 0.25,
  };

  // User settings (persisted): master sound + music independently, plus the
  // maintainer's ENFORCE UNMODIFIED AUDIO testing switch (pure).
  private soundOn = true;
  private musicOn = true;
  private pureOn = false;

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as {
        sound?: boolean;
        music?: boolean;
        pure?: boolean;
      };
      this.soundOn = s.sound !== false;
      this.musicOn = s.music !== false;
      this.pureOn = s.pure === true;
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
    this.oneShots.pure = this.pureOn;
    this.applySfxMute();

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
      // Warm the composer's own primary takes too — thunder especially must
      // not miss its first flash on a fetch+decode.
      for (const set of ["stone", "snow", "ui_tick", "ui_cancel", "thunder"]) {
        const urls = composerFoley(set);
        if (urls) void this.buffers.get(urls[0]);
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

  /** Events whose sound the composer has taken in-house. MAINTAINER
   * 2026-07-18: the tab click (ui_tick) is THE approved button sound —
   * "I want the backpack button sound" — so every UI event plays it (one
   * sound, everywhere, like the stone footsteps). The ui_confirm/ui_cancel
   * sets stay bundled + auditionable at /#foley for a future opt-in. */
  private static EVENT_FOLEY: Record<string, string> = {
    // Tactile pair (maintainer 2026-07-18: distinct down/up for immersive
    // touch feedback): press = the approved tab click, release = the
    // dedicated duller release recording (ui_cancel — generated for this).
    "ui.press": "ui_tick",
    "ui.release": "ui_cancel",
    // Legacy single-click events any game code may still emit.
    "ui.cursor_move": "ui_tick",
    "ui.confirm": "ui_tick",
    "ui.cancel": "ui_tick",
    "ui.error": "ui_tick",
  };

  /** Fire a bound event (sounds/bindings.json names: "ui.confirm",
   * "player.jump", ...). Unknown events are silent no-ops. */
  event(name: string, opts: PlayOpts = {}): void {
    if (!this.ready()) return;
    const ownSet = GameAudio.EVENT_FOLEY[name];
    const own = ownSet ? composerFoley(ownSet) : null;
    if (ownSet && own) {
      // −12 dB static trim = quarter amplitude (maintainer 2026-07-18:
      // "lower 50%" twice — first −6 dB, then "still too loud, remove 50%
      // again"). Static level balance, so it applies in pure mode too.
      this.oneShots.play(this.foleyEntry(ownSet, own, "click"), "ui", {
        ...opts,
        gainDb: (opts.gainDb ?? 0) - 12,
      });
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

  /** Thunder roll, IN SYNC with the lightning flash (maintainer 2026-07-18:
   * "I want it in sync with the flashes" — the earlier 0.8-2.3s realism
   * delay read as silence). GENTLENESS: the primary real roll (take01)
   * every strike, micro pitch jitter, near-center pan, level with real
   * presence (the roll's low end barely reproduces on small speakers). */
  thunder(strength = 1): void {
    if (!this.ready()) return;
    const own = composerFoley("thunder");
    if (own) {
      this.oneShots.play(this.foleyEntry("thunder", own, "click"), "sfx", {
        gainDb: 6 * Math.min(1, strength),
        pan: (Math.random() - 0.5) * 0.16,
      });
      return;
    }
    const sound = this.catalog!.sounds.get("explosion");
    if (!sound) return;
    this.oneShots.play(sound, "sfx", {
      rate: 0.38 + Math.random() * 0.14,
      lowpassHz: 300 + Math.random() * 200,
      gainDb: 2 + 5 * Math.min(1, strength),
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

    // Water edges (server owns swimming): the catalog splash, as before.
    // (Maintainer 2026-07-18: swim-entry sounds are LATER scope — the
    // composer wet set is for walking the wet shoreline band, below.)
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
      g.lastPhase = undefined;
      return;
    }

    if (f.animPhase !== undefined) {
      // SYNC SOURCE: the visible stride. A footfall sounds exactly when the
      // walk/run clip crosses a plant phase — per-character gait rates,
      // timeScale and direction-preserving clip resumes all come for free.
      const prev = g.lastPhase;
      g.lastPhase = f.animPhase;
      if (prev === undefined) return; // just started moving: wait for a plant
      let planted = false;
      for (const phase of FOOT_PHASES) {
        planted ||= prev <= f.animPhase
          ? prev < phase && phase <= f.animPhase
          : phase > prev || phase <= f.animPhase; // loop wrapped
      }
      if (!planted) return;
    } else {
      // Fallback: distance cadence (characters without gait clips).
      g.travelled += Math.max(0, f.distWu);
      const stepLen = f.running ? RUN_STEP_WU : WALK_STEP_WU;
      if (g.travelled < stepLen) return;
      g.travelled = 0;
    }

    // Water/void/unknown surfaces: no dry footfall (splash/swim handle water).
    if (!f.surface || f.surface === "water") return;

    // WET SHORELINE band: the catalog `splash` IS the wet footstep the
    // maintainer approved ("perfect footstep sound", 2026-07-18) — the
    // generated water_step set is retired from playback. Played under the
    // gentleness step profile (primary take, micro-jitter, walk/run level).
    if (f.wetGround) {
      const splash = this.catalog?.sounds.get("splash");
      if (splash) {
        const walkPenalty = FOOTSTEP_WALK_PENALTY_DB.wet ?? WALK_PENALTY_DEFAULT_DB;
        this.oneShots.play(this.catalogStepEntry(splash), "sfx", {
          pan: f.pan,
          dist: f.dist,
          rate: WET_STEP_RATE, // the water-EXIT character (the approved one)
          gainDb: -8 + (FOOTSTEP_TRIM_DB.wet ?? 0) + (f.running ? 0.8 : walkPenalty),
        });
        return;
      }
    }

    const setName = FOOTSTEP_SETS[f.surface] ?? FOOTSTEP_DEFAULT;
    const own = composerFoley(setName) ?? composerFoley(FOOTSTEP_DEFAULT);
    if (own) {
      // Gentleness: no rate change for running — the faster CADENCE is the
      // run signal; walking is the SAME sound with a small per-surface
      // penalty (see the tables above).
      const walkPenalty = FOOTSTEP_WALK_PENALTY_DB[f.surface] ?? WALK_PENALTY_DEFAULT_DB;
      this.oneShots.play(this.foleyEntry(setName, own, "step"), "sfx", {
        pan: f.pan,
        dist: f.dist,
        gainDb: -8 + (FOOTSTEP_TRIM_DB[f.surface] ?? 0) + (f.running ? 0.8 : walkPenalty),
      });
      return;
    }
    // Fallback if the stone set isn't bundled: the catalog's stone foley.
    this.play("footstep_stone", "sfx", {
      pan: f.pan,
      dist: f.dist,
      rate: f.running ? 1.06 : 1,
      gainDb: f.running ? 1.5 : 0,
    });
  }

  private foleyCache = new Map<string, SoundEntry>();
  private stepCache = new Map<string, SoundEntry>();

  /** A CATALOG sound (e.g. `splash`) played as a footstep: its primary take
   * every step (no rotation) with the gentle step micro-jitter — the same
   * doctrine as the composer foley sets, but sourced from the catalog. */
  private catalogStepEntry(base: SoundEntry): SoundEntry {
    let e = this.stepCache.get(base.id);
    if (!e) {
      e = {
        ...base,
        id: `wetstep_${base.id}`,
        mix_gain_db: 0, // level decided per-play
        variation: {
          round_robin: false, // the approved primary take, every step
          no_immediate_repeat: false,
          pitch_jitter_semitones: [-0.2, 0.2],
          gain_jitter_db: [-0.7, 0.4],
          start_jitter_ms: [0, 0],
        },
        music: {
          tonal: false,
          root_midi: null,
          pitch_confidence: 0,
          max_shift_semitones: 0,
          scale_snap_replaces_jitter: false,
        },
      };
      this.stepCache.set(base.id, e);
    }
    return e;
  }

  /** Synthetic catalog entry for a composer-generated foley set (bundled
   * absolute URLs). GENTLENESS DOCTRINE (maintainer 2026-07-18, after
   * approving the raw click AND the raw footstep): the primary take IS the
   * sound for clicks and steps alike — no take rotation; repeat plays get
   * only barely-perceptible micro-jitter (steps a touch more than clicks,
   * so a walk doesn't read as a machine gun). */
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
          round_robin: false, // the approved primary take, every play
          no_immediate_repeat: false,
          pitch_jitter_semitones: step
            ? FOOTSTEP_JITTER[set]?.pitch ?? [-0.2, 0.2]
            : [-0.12, 0.12],
          gain_jitter_db: step ? FOOTSTEP_JITTER[set]?.gain ?? [-0.7, 0.4] : [-0.5, 0.3],
          start_jitter_ms: [0, 0],
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

  /** The ambient thunder episode is a storm even outside Storm weather —
   * rain + gusts accompany the lightning (called from ambient/thunder). */
  setStorm(on: boolean): void {
    this.storm = on;
  }

  /** Underwater: ease the full-mix lowpass down while the player swims —
   * the whole world (music, birds, other players' steps) muffles together.
   * Suppressed entirely in pure mode (the insert IS a modification). */
  setUnderwater(on: boolean): void {
    if (on === this.underwater || !this.graph) return;
    this.underwater = on;
    if (this.pureOn) return;
    this.graph.setInsertCutoff(on ? 900 : 20000, on ? 0.15 : 0.35);
  }

  /** The scene provides terrain fractions around the listener (4Hz). */
  setFieldSampler(fn: (() => FieldSample | null) | null): void {
    this.fieldSampler = fn;
  }

  /** Slow tick (4 Hz): recompute ambience targets + music level. Runs even
   * with the sound switch OFF — the music has its own switch and must keep
   * following the day/night level (its bus is unaffected by the sfx mute). */
  private slowTick(): void {
    if (!this.graph || !this.catalog || !this.ambience || !this.graph.running) return;
    const { sun, cloud, mist, rain, snow, windy } = this.env;
    const night = 1 - sun;
    const field = this.fieldSampler?.() ?? { forest: 0, water: 0, town: 0, fire: 0 };
    const day = sun * (1 - 0.45 * cloud);
    // Wetness: real rain weather (drizzle/rain/heavy/storm) or an active
    // ambient thunder episode — rain falls, wind rises, birds shelter.
    const wet = Math.max(rain, this.storm || this.env.storm ? 0.9 : 0);
    // Birds sing in BOUTS (maintainer: "I hear birds always") — a slow ~47s
    // swell-and-fade so daytime has birdsong AND silence.
    const bout = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(performance.now() / 7500));

    this.ambience.setTargets({
      // The base pastoral pair: birdsong owns the day, crickets own the night.
      birds_day: day * (0.3 + 0.4 * field.forest) * (1 - 0.6 * field.town) * (1 - wet) * bout,
      crickets_night: night * (0.5 + 0.5 * field.forest) * (1 - 0.7 * wet),
      // Weather: wind under cloud, thin wind in mist, gusts when windy/stormy.
      wind: 0.18 + 0.55 * cloud + 0.35 * mist + (windy ? 0.5 : 0) + (wet > 0.5 ? 0.3 : 0) + (snow ? 0.2 : 0),
      rain: wet * 0.95,
      // Terrain beds from the live field sample.
      forest: field.forest * (0.35 + 0.4 * sun),
      river: field.water,
      town_murmur: field.town * (0.25 + 0.75 * sun),
      fire_crackle: field.fire,
    });

    // The score dips into the night — Nangijala's nights belong to the
    // crickets and the fires; music returns with the light. Pure mode
    // freezes ALL level automation at unity (the score plays as authored).
    const modeMul = GameAudio.MODE_MUSIC[this.mode] ?? 1;
    const level = this.pureOn ? 1 : (0.45 + 0.55 * sun) * modeMul;
    // The user's toggle snaps (a switch must feel like a switch); mood
    // changes keep the slow ease.
    this.music.setLevel(this.musicOn ? level : 0, this.musicToggleFast ? 0.06 : 0.4);
    this.musicToggleFast = false;
  }

  private duck(): void {
    if (this.pureOn) return; // ducking is level automation — frozen in pure mode
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
  get pureEnabled(): boolean {
    return this.pureOn;
  }

  /** ENFORCE UNMODIFIED AUDIO — the maintainer's A/B switch: raw files
   * only, so a bad sound can be pinned on the asset OR on the composer's
   * processing. Bypasses: pitch/gain/start jitter, scale-snap, rate
   * changes, lowpass, pan, distance attenuation, delays/beat-quantize,
   * ducking, night dip, mode scaling, the underwater insert, AND take
   * round-robin (always the first take — deterministic: same event, same
   * file). Keeps: which sound an event maps to, static level balance
   * (bus + per-sound mix gain), looping. */
  togglePure(): void {
    this.pureOn = !this.pureOn;
    if (this.graph) {
      this.oneShots.pure = this.pureOn;
      // Pure opens the full-mix insert; leaving pure re-applies underwater.
      this.graph.setInsertCutoff(this.pureOn || !this.underwater ? 20000 : 900, 0.1);
      this.graph.duckMusic(0, 100); // release any in-flight duck
      this.slowTick(); // re-settle the music level immediately
    }
    this.persist();
  }

  toggleSound(): void {
    this.soundOn = !this.soundOn;
    this.applySfxMute();
    this.persist();
  }

  toggleMusic(): void {
    this.musicOn = !this.musicOn;
    this.musicToggleFast = true;
    this.slowTickSoon();
    this.persist();
  }

  /** "sound" mutes the EFFECT buses only (sfx/ui/ambience) — the music has
   * its own switch (maintainer: the sound button must not stop the music). */
  private applySfxMute(): void {
    this.graph?.setBusesMuted(["sfx", "ui", "ambience"], !this.soundOn);
  }

  private slowTickSoon(): void {
    this.slowTick();
  }

  private persist(): void {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ sound: this.soundOn, music: this.musicOn, pure: this.pureOn }),
      );
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
      recent: this.graph ? [...this.oneShots.recent] : [],
      sound: this.soundOn,
      musicOn: this.musicOn,
      pure: this.pureOn,
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
