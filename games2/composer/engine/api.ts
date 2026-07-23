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

import { Bindings, Catalog, SoundEntry, dbToGain, loadCatalog, soundUrl } from "./catalog";
import { AudioGraph, BufferCache, BusName } from "./context";
import { AmbienceMixer } from "./ambience";
import { MusicDirector } from "./music";
import { OneShotPlayer, PlayOpts } from "./oneshot";
import { composerFoley, composerFoleySurfaces } from "./foley";
import { titleThemeUrl, nightMusicUrl } from "./titleTheme";

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
  /** Current world speed (wu/s, the gait EMA). Drives the swim-stroke level:
   * a fast crawl is louder than a lazy float. */
  speedWu?: number;
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
// SWIMMING (a new locomotion, maintainer 2026-07-19): ONE looping water
// source (the catalog swim_stroke is a 6s loop) per swimming avatar, whose
// VOLUME is driven in real time by the swim speed — NOT a shower of
// overlapping one-shots (maintainer: "use 1 effect ... realtime control the
// volume based on speed"). SWIM_REF_SPEED_WU ≈ a brisk swim (water is ~1.8×
// slower than the ~49.5 wu/s walk ref) → speed 0..that maps MIN..MAX level.
// Floating still sits at MIN (a faint water lap), a fast crawl at MAX. The
// loop also brightens/quickens slightly with speed (the "alter it slightly").
const SWIM_REF_SPEED_WU = 28;
const SWIM_LOOP_MIN_DB = -24; // floating still — a faint lap
const SWIM_LOOP_MAX_DB = -7; // full-speed crawl
const SWIM_GAIN_TAU_S = 0.12; // real-time volume follow (responsive, no zipper)
// Enter/exit water splashes: a fuller plunge going IN, a lighter, brighter
// splash climbing OUT (maintainer 2026-07-19).
const SWIM_ENTER_DB = 1;
const SWIM_EXIT_DB = -4;
// The character-select TITLE THEME plays on the music bus (respects the music
// toggle); trimmed a touch so it sits under the SFX, never blaring on load.
const TITLE_THEME_DB = -4;
// The mystical NIGHT bed: a second looping music layer cross-faded IN as the
// sun sets and OUT at dawn (maintainer 2026-07-19). It loops CONTINUOUSLY —
// never stopped on the day/night flip — so each night you hear a different
// stretch, not just its opening. Level at full night; the day score fades to
// a low floor so the night bed takes over.
const NIGHT_MUSIC_DB = -5;

// Footstep routing (maintainer directives 2026-07-18): the approved STONE
// set is the default for every dry surface; per-surface sets are enabled
// ONE AT A TIME with explicit approval. Snow re-enabled for trial ("let's
// try the snow version") — same gentleness as stone: primary take every
// step, micro-jitter only. Water stays splash/swim, no dry footfall.
const FOOTSTEP_SETS: Record<string, string> = { snow: "snow", ice: "ice", grass: "grass" };
// Surfaces mapped to a CATALOG sound played as a footstep, when the
// maintainer picks an existing sound over a generated set. sand/dirt → the
// `jump` sound ("closest we have to sand", 2026-07-18, after 4 sand
// generations failed to read as sand). grass stays on its generated
// composer set (2026-07-19): the maintainer played the round-3 grass set
// and preferred it ("kinda nice, not metal") over the footstep_wood
// swap. Overrides FOOTSTEP_SETS.
const FOOTSTEP_CATALOG: Record<string, string> = { sand: "jump", dirt: "jump" };
const FOOTSTEP_DEFAULT = "stone";
// Per-SURFACE trims on top of the step base (maintainer verdicts
// 2026-07-18): snow −12 ("too loud" ×2, run level then approved). grass
// −4 (2026-07-19: the generated grass set was liked but "a bit less
// volume", down from the earlier −1). Keyed by surface sound id so e.g.
// grass can be trimmed without touching stone-on-stone tiles.
const FOOTSTEP_TRIM_DB: Record<string, number> = { snow: -12, grass: -4, ice: -4 };
// Per-SURFACE tone shaping (a FIXED darkening character, not per-step
// drift — bypassed by ENFORCE UNMODIFIED AUDIO like all processing).
// grass (2026-07-19): the liked generated set still read a touch like a
// hi-hat, so a gentle lowpass shaves the top sizzle and a small pitch-
// down lowers the tone — both "very small, just a push away from a
// hi-hat" per the maintainer.
const FOOTSTEP_LOWPASS_HZ: Record<string, number> = { grass: 3600 };
const FOOTSTEP_RATE: Record<string, number> = { grass: 0.95 };
// Surfaces that ALSO play a SECOND surface's step layered underneath, at a
// relative dB trim vs that surface's own level (maintainer 2026-07-19: on
// grass, play the grass sound AND the dirt sound, "dirt at 50% of what dirt
// plays at" → −6 dB under dirt's own footstep level). The primary sound
// still plays as normal; this just adds the layer.
const FOOTSTEP_LAYER: Record<string, { surface: string; relDb: number }> = {
  grass: { surface: "dirt", relDb: -6 },
};
// The wet shoreline step is the catalog splash played like the water-EXIT
// sound the maintainer approved: pitched up ~15% (brighter, lighter than
// the duller entry splosh). A fixed character choice, not per-step drift.
const WET_STEP_RATE = 1.15;
// The jump grunt plays pitched UP: the raw female takes read a touch dark/low
// (maintainer 2026-07-19: "still too dark, increase pitch a bit", then
// "higher still", "more", "another bump"). The SAME grunt takes are pitched
// PER CHARACTER ("use that config as the man … same audio with different
// settings"): default_boy sits at 1.33 ("a good pitch for the man" — the orc
// turned human there), default_girl keeps climbing (1.58 ≈ +8 semis, still
// tuned up by ear). NOTE: rate-pitching speeds the clip up, so far above here
// it thins into a sped-up chipmunk — once the girl pitch is found, regenerate
// her voice natively high. Bypassed by ENFORCE UNMODIFIED AUDIO.
const JUMP_VOICE_RATE: Record<string, number> = {
  default_boy: 1.33,
  default_girl: 1.75, // APPROVED FINAL 2026-07-19 ("a real female now, not sped up, perfect")
};
const JUMP_VOICE_RATE_DEFAULT = 1.58; // unknown character → the girl pitch
// The jump grunt also plays on fall-start; this gap dedupes jump→fall (a
// jump OFF a ledge fires both within a few frames) and any double-trigger.
const JUMP_VOICE_MIN_GAP_S = 0.28;
// −12 dB ≈ quarter amplitude (maintainer 2026-07-19: "lower by 50%" twice —
// first −6, then "lower again"). A static level balance → pure mode too.
const JUMP_VOICE_GAIN_DB = -12;
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

/** One persistent looping water source per swimming avatar — gain + pan +
 * playbackRate driven live from swim speed (see updateSwim). */
interface SwimVoice {
  gain: GainNode;
  pan: StereoPannerNode | null;
  src: AudioBufferSourceNode | null;
  loading: boolean;
  active: boolean; // currently swimming
  silentSince: number; // performance.now() when it went idle (-1 = live)
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
  private swimVoices = new Map<string, SwimVoice>();
  private env: EnvState = {
    sun: 1, cloud: 0, mist: 0, rain: 0, storm: false, snow: false, windy: false,
  };
  private fieldSampler: (() => FieldSample | null) | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private musicWanted = false;
  private underwater = false;
  // Title-theme (select screen): a looping music source, started on the first
  // gesture and handed off to the world score on join.
  private titleWanted = false;
  private titleSrc: AudioBufferSourceNode | null = null;
  private titleGain: GainNode | null = null;
  private titleLoading = false;
  // Night music bed (in-world): a second looping layer, cross-faded by the sun.
  private nightWanted = false;
  private nightSrc: AudioBufferSourceNode | null = null;
  private nightGain: GainNode | null = null;
  private nightLoading = false;
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
        "footstep_grass", "footstep_stone", "footstep_wood", "jump", "splash", "swim_stroke",
        "menu_select", "menu_confirm", "menu_cancel", "notification", "gem_pickup",
      ]) {
        const s = cat.sounds.get(id);
        if (s) void this.buffers.get(soundUrl(s.file));
      }
      // Warm the composer's own primary takes too — thunder especially must
      // not miss its first flash on a fetch+decode.
      for (const set of ["stone", "snow", "ice", "grass", "jump_voice", "ui_tick", "ui_cancel", "thunder"]) {
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

  /** The world is live — bring the score in (and retire the title theme). */
  startMusic(): void {
    this.musicWanted = true;
    this.nightWanted = true; // arm the night bed; slowTick cross-fades it
    this.stopTitleTheme();
    this.ensureNightMusic();
    if (this.catalog && this.graph) void this.music.start(this.catalog.music);
  }

  private ensureNightMusic(): void {
    if (!this.graph || !this.graph.running || this.nightSrc || this.nightLoading || !this.nightWanted) return;
    const url = nightMusicUrl();
    if (!url) return; // not generated yet
    if (!this.nightGain) {
      this.nightGain = this.graph.ctx.createGain();
      this.nightGain.gain.value = 0.0001;
      this.nightGain.connect(this.graph.bus("music"));
    }
    this.nightLoading = true;
    void this.buffers.get(url).then((buf) => {
      this.nightLoading = false;
      if (!buf || !this.graph || !this.nightGain || this.nightSrc || !this.nightWanted) return;
      const src = this.graph.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true; // loops FOREVER — never restarted on the day/night flip
      src.connect(this.nightGain);
      // Start anywhere in the bed so it isn't always heard from its opening.
      src.start(this.graph.now, 0);
      this.nightSrc = src;
    });
  }

  /** Cross-fade the night bed by how dark it is (0 day → 1 night); silent when
   * music is off or in pure mode. Called from slowTick with the live sun. */
  private applyNightLevel(night: number, tauS: number): void {
    if (!this.nightGain || !this.graph) return;
    const amt = this.pureOn ? 0 : Math.min(1, Math.max(0, night));
    const target = this.musicOn && this.nightWanted ? dbToGain(NIGHT_MUSIC_DB) * amt : 0;
    this.nightGain.gain.setTargetAtTime(Math.max(0.0001, target), this.graph.now, tauS);
  }

  /** Start the character-select TITLE THEME (composer-generated, looping on the
   * music bus). Called from the select screen's first gesture; safe to call
   * repeatedly. No-ops until the AudioContext is unlocked and a theme is
   * bundled — slowTick retries so it starts the moment both are true. */
  startTitleTheme(): void {
    this.titleWanted = true;
    this.ensureTitleTheme();
  }

  /** Retire the title theme (world join / music-off): fade out, then reclaim. */
  stopTitleTheme(): void {
    this.titleWanted = false;
    const src = this.titleSrc;
    const gain = this.titleGain;
    this.titleSrc = null;
    this.titleGain = null;
    if (!this.graph || !gain) return;
    gain.gain.setTargetAtTime(0.0001, this.graph.now, 0.5);
    setTimeout(() => {
      try {
        src?.stop();
      } catch {}
      src?.disconnect();
      gain.disconnect();
    }, 1400);
  }

  private ensureTitleTheme(): void {
    if (!this.graph || !this.graph.running || this.titleSrc || this.titleLoading || !this.titleWanted) return;
    const url = titleThemeUrl();
    if (!url) return; // not generated yet
    if (!this.titleGain) {
      this.titleGain = this.graph.ctx.createGain();
      this.titleGain.gain.value = 0.0001;
      this.titleGain.connect(this.graph.bus("music"));
    }
    this.titleLoading = true;
    void this.buffers.get(url).then((buf) => {
      this.titleLoading = false;
      if (!buf || !this.graph || !this.titleGain || this.titleSrc || !this.titleWanted) return;
      const src = this.graph.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.titleGain);
      src.start();
      this.titleSrc = src;
      this.applyTitleLevel(2.0); // gentle fade-in on the select screen
    });
  }

  /** Ease the title gain toward its target (0 when music is off). */
  private applyTitleLevel(tauS: number): void {
    if (!this.titleGain || !this.graph) return;
    const target = this.titleWanted && this.musicOn ? dbToGain(TITLE_THEME_DB) : 0.0001;
    this.titleGain.gain.setTargetAtTime(Math.max(0.0001, target), this.graph.now, tauS);
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
    // The jump grunt (maintainer 2026-07-19: a Link-style vocal effort) is a
    // composer set on the SFX bus, spatialized, NOT a −12 dB UI click — so it
    // gets its own branch. The SAME grunt plays when she starts to FALL off a
    // ledge (maintainer 2026-07-19: "same sound when she starts to fall").
    // A short debounce dedupes jump→fall (jumping OFF a cliff would otherwise
    // grunt on the hop and again as the drop begins). Falls through to the
    // catalog `jump` binding if the vocal set isn't bundled yet. NOTE: the
    // catalog `jump` sound stays the sand/dirt footstep — voice only here.
    if (name === "player.jump" || name === "player.fall") {
      const voice = composerFoley("jump_voice");
      if (voice) {
        const now = this.graph!.ctx.currentTime;
        if (now - this.lastJumpVoiceT < JUMP_VOICE_MIN_GAP_S) return;
        this.lastJumpVoiceT = now;
        const pitch = (opts.voice && JUMP_VOICE_RATE[opts.voice]) || JUMP_VOICE_RATE_DEFAULT;
        this.oneShots.play(this.foleyEntry("jump_voice", voice, "voice"), "sfx", {
          ...opts,
          rate: (opts.rate ?? 1) * pitch,
          gainDb: (opts.gainDb ?? 0) + JUMP_VOICE_GAIN_DB,
        });
        return;
      }
    }
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

  /** A STAR-SHIMMER chime for "a new build just went live" (maintainer
   * 2026-07-19: an audible cue while the game sits in a background tab, so
   * you know a deploy landed). Three ascending sparkle notes from the star
   * chime = a shimmer. Respects the sound toggle; needs the AudioContext
   * running (desktop keeps a backgrounded tab's audio alive). */
  notifyNewVersion(): void {
    if (!this.ready()) return;
    const s = this.catalog!.sounds.get("gem_pickup");
    if (!s) return;
    this.oneShots.play(s, "ui", { gainDb: -2, rate: 1.0 });
    this.oneShots.play(s, "ui", { gainDb: -4, rate: 1.33, delayS: 0.12 });
    this.oneShots.play(s, "ui", { gainDb: -6, rate: 1.6, delayS: 0.24 });
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

    // Enter/exit water: a catalog `splash`. A fuller plunge going IN, a
    // lighter + brighter (pitched-up) splash climbing OUT.
    if (f.swimming !== g.swimming) {
      g.swimming = f.swimming;
      this.play("splash", "sfx", {
        pan: f.pan,
        dist: f.dist,
        gainDb: f.swimming ? SWIM_ENTER_DB : SWIM_EXIT_DB,
        rate: f.swimming ? 1 : 1.2,
      });
    }

    // SWIMMING: ONE looping water source whose volume follows swim speed in
    // real time (updated every frame). No per-stroke one-shots to pile up.
    this.updateSwim(id, f.swimming, f.speedWu ?? 0, f.pan ?? 0, f.dist ?? 0);
    if (f.swimming) return; // no footfalls while swimming

    if (!f.moving || !f.grounded) {
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

    // LAYERING: some surfaces play a SECOND surface's step underneath the
    // primary (grass also gets the dirt step at half dirt's level — the
    // primary grass sound still plays below). Not on the wet band (returns
    // above) — a wet shoreline step is its own thing.
    const layer = FOOTSTEP_LAYER[f.surface];
    if (layer) this.playFootstepFor(layer.surface, f, layer.relDb);

    // Surfaces mapped to a catalog sound (sand → jump) — played as a
    // footstep under the gentleness step profile, like the wet band.
    const catId = FOOTSTEP_CATALOG[f.surface];
    if (catId) {
      const base = this.catalog?.sounds.get(catId);
      if (base) {
        const walkPenalty = FOOTSTEP_WALK_PENALTY_DB[f.surface] ?? WALK_PENALTY_DEFAULT_DB;
        this.oneShots.play(this.catalogStepEntry(base), "sfx", {
          pan: f.pan,
          dist: f.dist,
          gainDb: -8 + (FOOTSTEP_TRIM_DB[f.surface] ?? 0) + (f.running ? 0.8 : walkPenalty),
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
        lowpassHz: FOOTSTEP_LOWPASS_HZ[f.surface],
        rate: FOOTSTEP_RATE[f.surface],
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

  /** Play ONE surface's footstep at its own computed level plus `extraDb` —
   * the same catalog/foley-set resolution the primary step uses, so a layered
   * sound (e.g. dirt under grass) matches exactly "what that surface plays at"
   * shifted by the trim. Silent if the surface has no bundled sound. */
  private playFootstepFor(surface: string, f: AvatarFrame, extraDb: number): void {
    const walkPenalty = FOOTSTEP_WALK_PENALTY_DB[surface] ?? WALK_PENALTY_DEFAULT_DB;
    const level = -8 + (FOOTSTEP_TRIM_DB[surface] ?? 0) + (f.running ? 0.8 : walkPenalty) + extraDb;
    const catId = FOOTSTEP_CATALOG[surface];
    if (catId) {
      const base = this.catalog?.sounds.get(catId);
      if (base) {
        this.oneShots.play(this.catalogStepEntry(base), "sfx", {
          pan: f.pan,
          dist: f.dist,
          gainDb: level,
        });
      }
      return;
    }
    const setName = FOOTSTEP_SETS[surface] ?? FOOTSTEP_DEFAULT;
    const own = composerFoley(setName) ?? composerFoley(FOOTSTEP_DEFAULT);
    if (own) {
      this.oneShots.play(this.foleyEntry(setName, own, "step"), "sfx", {
        pan: f.pan,
        dist: f.dist,
        gainDb: level,
        lowpassHz: FOOTSTEP_LOWPASS_HZ[surface],
        rate: FOOTSTEP_RATE[surface],
      });
    }
  }

  /** Drive the per-avatar swim loop: one persistent looping water source whose
   * GAIN follows the swim speed in real time (and a slight rate lift with
   * speed). Ramps up on entering water, down to silence on leaving; the source
   * is reclaimed once it's been idle a while (buffer stays cached). */
  private updateSwim(id: string, swimming: boolean, speed: number, pan: number, dist: number): void {
    if (!this.graph) return;
    let v = this.swimVoices.get(id);
    // Nothing playing and not swimming → nothing to do (never spin up a voice
    // just to silence it).
    if (!v && !swimming) return;
    if (!v) {
      const gain = this.graph.ctx.createGain();
      gain.gain.value = 0.0001;
      let panNode: StereoPannerNode | null = null;
      if (typeof this.graph.ctx.createStereoPanner === "function") {
        panNode = this.graph.ctx.createStereoPanner();
        panNode.connect(gain);
      }
      gain.connect(this.graph.bus("sfx"));
      v = { gain, pan: panNode, src: null, loading: false, active: true, silentSince: -1 };
      this.swimVoices.set(id, v);
    }
    v.active = swimming;

    // Target level: speed 0..ref → MIN..MAX dB, times distance attenuation for
    // other players. Not swimming → silence.
    const t = Math.min(1, Math.max(0, speed / SWIM_REF_SPEED_WU));
    const d = Math.min(1, Math.max(0, dist));
    const targetDb = SWIM_LOOP_MIN_DB + (SWIM_LOOP_MAX_DB - SWIM_LOOP_MIN_DB) * t;
    const target = swimming ? dbToGain(targetDb) * (1 - 0.85 * d * d) : 0;
    const now = performance.now();
    v.silentSince = swimming ? -1 : v.silentSince < 0 ? now : v.silentSince;

    if (swimming) this.ensureSwimSource(id, v);
    v.gain.gain.setTargetAtTime(Math.max(0.0001, target), this.graph.now, SWIM_GAIN_TAU_S);
    if (v.pan) v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), this.graph.now, 0.1);
    // Slight character shift with speed: brighten/quicken a touch (the "alter
    // it slightly" the maintainer asked for), not a pitch sweep.
    if (v.src) v.src.playbackRate.setTargetAtTime(0.97 + 0.1 * t, this.graph.now, 0.15);

    // Reclaim a long-idle source (keeps the buffer cached for instant restart).
    if (v.src && v.silentSince >= 0 && now - v.silentSince > 4000) {
      try {
        v.src.stop();
      } catch {}
      v.src.disconnect();
      v.src = null;
    }
  }

  private ensureSwimSource(id: string, v: SwimVoice): void {
    if (v.src || v.loading) return;
    const entry = this.catalog?.sounds.get("swim_stroke");
    if (!entry) return;
    v.loading = true;
    void this.buffers.get(soundUrl(entry.file)).then((buf) => {
      v.loading = false;
      if (!buf || v.src || !v.active) return;
      const src = this.graph!.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(v.pan ?? v.gain);
      src.start(this.graph!.now, Math.random() * buf.duration); // desync joiners
      v.src = src;
    });
  }

  private foleyCache = new Map<string, SoundEntry>();
  private stepCache = new Map<string, SoundEntry>();
  private lastJumpVoiceT = 0; // ctx-time of the last jump/fall grunt (debounce)

  /** A CATALOG sound (e.g. `splash`) played as a footstep: its primary take
   * every step (no rotation) with the gentle step micro-jitter — the same
   * doctrine as the composer foley sets, but sourced from the catalog. */
  private catalogStepEntry(base: SoundEntry): SoundEntry {
    let e = this.stepCache.get(base.id);
    if (!e) {
      e = {
        ...base,
        id: `catstep_${base.id}`,
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
  private foleyEntry(set: string, urls: string[], profile: "step" | "click" | "voice"): SoundEntry {
    let e = this.foleyCache.get(set);
    if (!e) {
      const step = profile === "step";
      // A VOICE (the jump grunt) is the one set that ROTATES: hearing the
      // exact same waveform every jump reads as robotic — real games (OoT's
      // Link) rotate a few efforts. Round-robin, no immediate repeat, plus a
      // natural pitch spread (a voice never lands twice at the same pitch).
      const voice = profile === "voice";
      e = {
        id: `composer_foley_${set}`,
        category: voice ? "movement" : step ? "movement" : "ui",
        loop: false,
        file: urls[0],
        urls,
        mix_gain_db: 0, // level is decided per-play by the caller
        variation: {
          round_robin: voice, // steps/clicks: primary take; voice: rotate
          no_immediate_repeat: voice,
          pitch_jitter_semitones: voice
            ? [-0.4, 0.4]
            : step
              ? FOOTSTEP_JITTER[set]?.pitch ?? [-0.2, 0.2]
              : [-0.12, 0.12],
          gain_jitter_db: voice ? [-1.0, 0.5] : step ? FOOTSTEP_JITTER[set]?.gain ?? [-0.7, 0.4] : [-0.5, 0.3],
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
    const v = this.swimVoices.get(id);
    if (v) {
      try {
        v.src?.stop();
      } catch {}
      v.src?.disconnect();
      v.pan?.disconnect();
      v.gain.disconnect();
      this.swimVoices.delete(id);
    }
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
    if (!this.graph || !this.graph.running) return;
    // Title theme: start once the context is unlocked + a theme is bundled
    // (retries the async unlock), and keep its level tracking the music toggle.
    // Runs before the catalog guard — the select screen has no world yet.
    if (this.titleWanted) {
      this.ensureTitleTheme();
      this.applyTitleLevel(0.4);
    }
    if (!this.catalog || !this.ambience) return;
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

    // DAY/NIGHT MUSIC CROSS-FADE (maintainer 2026-07-19: "more mystical bg
    // music during night"). When a night bed exists the DAY score fades to a
    // low floor at night while the mystical NIGHT bed cross-fades UP, so nights
    // belong to the night track — which loops CONTINUOUSLY (a new stretch each
    // cycle, never just its opening). Without a night bed yet, keep the old
    // gentle dip so nights aren't silent. Pure mode freezes at the authored
    // score. The toggle snaps; mood changes keep the slow ease.
    const modeMul = GameAudio.MODE_MUSIC[this.mode] ?? 1;
    const nightAmt = Math.min(1, Math.max(0, 1 - sun));
    const haveNight = !!this.nightGain || !!nightMusicUrl();
    const dayFloor = haveNight ? 0.12 : 0.45;
    const dayLevel = this.pureOn ? 1 : (dayFloor + (1 - dayFloor) * sun) * modeMul;
    const tau = this.musicToggleFast ? 0.06 : 0.4;
    this.music.setLevel(this.musicOn ? dayLevel : 0, tau);
    if (this.nightWanted) this.ensureNightMusic(); // covers the async unlock/load
    this.applyNightLevel(nightAmt, tau);
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
    this.applyTitleLevel(0.06); // the title theme snaps with the toggle too
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
