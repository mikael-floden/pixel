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
import { MusicalContext, OneShotPlayer, PlayOpts } from "./oneshot";
import { composerFoley, composerFoleySurfaces, composerFoleyTake } from "./foley";
import { nightMusicUrl, titleThemeUrl } from "./titleTheme";
import { ContextMusic, hasBed } from "./contextMusic";
import { BED_MIN_HOLD_S, BED_NAMES, BED_OFF, BED_ON, BedName, desiredBed, resolveBed } from "./bedSelect";

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
  /** 0..1 — how enclosed the player is (under a deck / inside the mountain).
   * Drives the cave bed. Optional: absent reads as "outdoors". */
  cave?: number;
  /** 0..1 — how close/numerous the nearest monsters are. Drives the battle
   * bed. Optional: absent reads as "nothing nearby". */
  threat?: number;
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
// The mystical NIGHT bed's level (maintainer 2026-07-19) — this IS the
// in-world night score: a second looping layer cross-faded IN as the sun sets
// and OUT at dawn, looping continuously so each night you hear a different
// stretch rather than only its opening.
const NIGHT_MUSIC_DB = -5;

// The context-score thresholds, fallback chain and hold time live in
// bedSelect.ts as pure functions — see test/bedSelect.test.ts.

// ---- SILENT-BY-DEFAULT EVENTS + THE WIKI ASSIGNMENT LOOP -----------------
// A sound plays only when the maintainer asked for it (2026-08-05, twice).
// The engine used to resolve ANY emitted event through sounds/bindings.json —
// the sound agent's RECOMMENDATIONS — which is exactly how unapproved catalog
// stand-ins started playing the moment the combat work emitted event names
// that happened to be bound. Resolution is now:
//   1. EVENT_ASSIGNMENTS — sounds the maintainer assigned in the wiki
//      (live/tuning/sfx_requests.json → wired here by the composer, the
//      request entry then deleted). The Game Master's explicit choice, so it
//      outranks everything.
//
// A REQUEST IS A MESSAGE, NOT A RECORD (maintainer 2026-08-06: "You consume
// the request when you implement it … the request itself is not a ground
// truth"). Consuming one is a SINGLE COMMIT that both wires it into the table
// below and deletes the entry from sfx_requests.json — never one without the
// other. Deleting first loses the ask with nothing to show for it; wiring
// first leaves a request that the next run re-applies over a setting he has
// since changed. After that commit the queue is empty by design, so NOTHING
// can reconstruct the assignment from it: this table is the only record, and
// it is published as composer/assignments.json for everything outside this
// engine (scripts/build-assignments.mjs, kept honest by verify-quiet).
// Anything reporting "what this event plays" reads THAT — never the request
// queue, and never the layer underneath. Falling back to EVENT_FOLEY or
// bindings.json for an ASSIGNED event is worse than showing nothing: it
// displays an outranked sound as if it were live, which is exactly how his
// ui.press/ui.release picks read as reverted on 2026-08-06.
//   2. the jump/fall VOICE branch and EVENT_FOLEY — approved in their rounds.
//   3. bindings.json — consulted ONLY for BINDINGS_APPROVED events.
// Anything else is SILENT, deliberately: the game may emit any semantic event
// (the wiki lists emitted-but-silent events so the Game Master can assign a
// sound to them), and silence is the correct sound for an unassigned one.
const BINDINGS_APPROVED = new Set<string>([
  "ui.notify", // the chat ping (approved long before combat)
  "player.jump", // the catalog fallback when the voice set isn't bundled
]);

/** One wiki assignment: `sound` is a catalog id or "composer/<set>". The
 * pitch/volume/jitter fields mirror pixel-wiki-sfx-requests@1 verbatim so a
 * request wires in as data, not as new code.
 *
 * A SET IS NOT A SOUND (maintainer 2026-08-06, and the wiki fixed its picker
 * the same day: it "was listing sets, not recordings … with no way to pick
 * take 2"). A ten-take set played round-robin is ten different sounds on one
 * event, which is only what he meant if he picked the set. So an assignment
 * may name ONE recording, and this engine accepts every spelling the picker
 * might send rather than making the format a negotiation:
 *   "composer/punch"                  → the whole set, round-robin
 *   "composer/punch/punch__take02"    → that recording only
 *   "composer/punch#take02"           → that recording only
 *   "composer/punch" + take: "take02" → that recording only
 *   … and `take` may be a bare index (2 = the second take).
 * A take that is not bundled resolves to SILENCE, never to a different
 * recording — a deleted take must not quietly become its neighbour. */
interface EventAssignment {
  sound: string;
  take?: string | number;
  pitch?: number; // playbackRate multiplier
  volume_db?: number;
  max_random_pitch_semis?: number;
  bus?: BusName;
}
/** Filled ONLY from the Game Master's wiki requests — never by the composer's
 * own taste. Empty means every assignable event is silent.
 *
 * THE RECORD OF EVERY ASSIGNMENT, because the request that created it was
 * deleted in the same commit that added it here (see the consume-and-delete
 * note above). Editing this table means re-running scripts/build-assignments.mjs
 * so composer/assignments.json still matches; verify-quiet fails if it doesn't.
 *
 * AN EVENT HOLDS A LIST, not one sound (2026-08-06). The wiki's dialog says
 * "Assign ANOTHER sound to X" and its card unbinds per sound, so several
 * assignments for one event are an ADDITION, not a correction — and he proved
 * it by assigning four different thunder candidates to weather.thunder inside
 * one minute, and two to player.water_enter. A single-slot table could only
 * have honoured one of each and silently dropped the rest, which is the
 * dangling-request bug wearing a different hat. Several sounds ROTATE
 * (round-robin, never the same one twice running) and each keeps its OWN
 * pitch/volume/jitter, so a rotation is not forced to share one setting.
 *
 * Wired 2026-08-06 from live/tuning/sfx_requests.json, entries then deleted
 * per the contract.
 * ONE CLICK EVERYWHERE still holds — it is just his new click now (ui_click_bead
 * on every UI event, the dedicated ui_click_latch on release). */
const EVENT_ASSIGNMENTS: Record<string, EventAssignment[]> = {
  "item.drop": [{ sound: "composer/dirt", pitch: 1.35, volume_db: -8, max_random_pitch_semis: 0.4 }],
  "ui.press": [{ sound: "composer/ui_click_bead" }],
  "ui.release": [{ sound: "composer/ui_click_latch" }],
  "combat.punch": [{ sound: "composer/punch", pitch: 0.9, max_random_pitch_semis: 0.2 }],
  "combat.kick": [{ sound: "hit_hurt" }],
  // Her death cry, one named take, no jitter — exactly as he auditioned it.
  // Scoped to the GIRL because he said so in the request's note; default_boy
  // has no die assignment yet and is therefore silent, which is the right
  // sound for a voice he has not chosen. He could not pick one: the wiki puts
  // only Jump and Fall on the per-hero rows, so Die has a single shared card.
  // Asked them for a Die row per hero (coordination/games-audio.json).
  // REPLACES monster_die_crumble rather than joining it, and that is a
  // judgement — flag it if it is wrong. Several assignments on one event
  // normally ADD (see the list note above), but crumble was picked at 05:57,
  // BEFORE he asked for cross_on candidates at all; the 50 sets in rounds 14
  // and 15 exist precisely because nothing he had was the right cross_on, and
  // peat is the end of that hunt. crumble is also a monster-death brief ("a
  // body crumbling into dry dust"), at 0 dB against peat's deliberately tuned
  // -6 dB — alternating them on every kill would swing loud/quiet, which is
  // not a designed pair. Recovery decided the tie: re-assigning crumble in the
  // wiki works, while un-assigning it needs the per-take unbind that is still
  // broken there.
  "combat.cross_on": [{ sound: "composer/cross_on_peat", take: "cross_on_peat__take01", volume_db: -6 }],
  "combat.cross_off": [{ sound: "composer/monster_die_twigs", take: "monster_die_twigs__take01", pitch: 1.85 }],
  "item.pickup": [{ sound: "composer/kick_earthmound", take: "kick_earthmound__take01" }],
  "combat.hit_taken": [{ sound: "composer/kick_bamboo", take: "kick_bamboo__take01" }],
  // Levelling up finally has a sound. progress.level_up has been emitted and
  // deliberately EMPTY since 2026-08-05 (its old binding was stripped because
  // nothing had asked for it) — this is the first thing he has assigned to it.
  "progress.level_up": [{ sound: "composer/level_up_harp", take: "level_up_harp__take01" }],
  // TWO sounds, 20 seconds apart, so both play — see the list note above.
  // These REPLACE the catalog splash on entering water; exiting still splashes
  // because he has assigned nothing to player.water_exit.
  "player.water_enter": [
    { sound: "composer/cross_rise_water", take: "cross_rise_water__take01" },
    { sound: "composer/mon_water_poring_attack", take: "mon_water_poring_attack__take01" },
  ],
  // FOUR candidates inside one minute — "a group with several sounds"
  // (2026-08-06) delivered as an assignment rather than as a set. All four are
  // POOL files, which is why take lookup now searches the pool too.
  // THREE cries each, rotating — a death you hear more than once should not be
  // the same performance every time. He assigned these in one sitting (three
  // girl, two boy) and unbound nothing, so die_voice_boy__take06 stays: he has
  // shown he unbinds what he does not want, and silently dropping a pick he
  // kept would be the engine deciding for him.
  "player.die@default_boy": [
    { sound: "composer/die_voice_boy", take: "die_voice_boy__take06" },
    { sound: "composer/die_boy_grunt", take: "die_boy_grunt__take01" },
    { sound: "composer/die_boy_rattle", take: "die_boy_rattle__take01" },
  ],
  // Her first cries since die_voice was unbound. inhale carries his 0.9 pitch.
  "player.die@default_girl": [
    { sound: "composer/die_girl_gasp", take: "die_girl_gasp__take01" },
    { sound: "composer/die_girl_groan", take: "die_girl_groan__take01" },
    { sound: "composer/die_girl_inhale", take: "die_girl_inhale__take01", pitch: 0.9 },
  ],
  // First per-monster assignments. The id is `monsters.<kind>.<action>`, built
  // from data in WorldScene rather than written as a literal anywhere.
  // WALK, not idle. The request was filed against `.idle` but its note said
  // "Only use this walk sound", so the event and the words disagreed and I
  // asked rather than guessed: he wants the bubble on WALK and nothing else
  // there, so mon_forest_poring_walk is dropped and idle stays silent.
  "monsters.forest_poring_2.walk": [{ sound: "composer/monster_die_bubble", take: "monster_die_bubble__take01" }],
  "monsters.forest_poring_2.attack": [{ sound: "composer/mon_lava_poring_attack", take: "mon_lava_poring_attack__take01" }],
  // -12 dB on all four (maintainer 2026-08-06: "lower the volume on all sounds
  // attached to Thunder", then "Lower them even more" after -6). Equal cuts,
  // so the four still sit level with each other and only the strike gets
  // quieter. THUNDER_GAIN_DB adds +14, so the net at full strength is +2 dB —
  // twelve down from where it was blasting. -14 here would be the point where
  // the game matches the wiki's audition exactly, one step further on. The trim lives HERE rather than in THUNDER_GAIN_DB because this is
  // the layer the wiki can see: assignments.json carries volume_db, so the
  // audition and the game agree, and he can move it himself next time. The
  // engine still adds THUNDER_GAIN_DB * strength on top, which is what keeps a
  // near strike loud and a distant one soft.
  "weather.thunder": [
    { sound: "composer/thunder", take: "thunder__cand07", volume_db: -12 },
    { sound: "composer/thunder", take: "thunder__cand08", volume_db: -12 },
    { sound: "composer/thunder", take: "thunder__cand09", volume_db: -12 },
    { sound: "composer/thunder", take: "thunder__cand17", volume_db: -12 },
  ],
};

/** Split a wiki `sound` id into its set and (optional) chosen recording. */
function splitComposerId(id: string, take?: string | number): { set: string; take?: string | number } {
  const body = id.slice("composer/".length);
  const cut = body.search(/[#/]/);
  if (cut >= 0) return { set: body.slice(0, cut), take: body.slice(cut + 1) };
  return { set: body, take };
}

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
// Per-CHARACTER jump/fall VOICE. Each character has its OWN vocal takes now —
// not one recording pitch-shifted (maintainer 2026-07-20: "new jump sound for
// the boy … their own voice, not just pitched down"). default_girl uses the
// `jump_voice` set (a young-woman recording) pitched to 1.75 (APPROVED FINAL
// 2026-07-19: "a real female now, not sped up, perfect"). default_boy uses his
// OWN male set `jump_voice_boy` at a natural rate. Until that set is generated
// he FALLS BACK to the girl takes pitched DOWN to 1.33 (the old shared
// behavior, "a good pitch for the man") so he's never silent mid-deploy.
// The rate-pitch is bypassed by ENFORCE UNMODIFIED AUDIO; the set choice is not.
interface JumpVoiceCfg {
  set: string;
  rate: number;
  fallbackRate: number; // pitch for the shared `jump_voice` set if `set` is absent
}
// 2.0 for BOTH (maintainer 2026-07-25): the generated vocal takes are authored
// at HALF speed — playing them at 2× lands each character on their true, normal
// voice ("2.0 sounds like a normal man … put the girl at 2.0 also, I want her
// real voice"). The earlier girl-at-1.75 was chasing normal pitch by ear before
// we understood the 2× authoring.
const JUMP_VOICE: Record<string, JumpVoiceCfg> = {
  default_boy: { set: "jump_voice_boy", rate: 2.0, fallbackRate: 1.33 },
  default_girl: { set: "jump_voice", rate: 2.0, fallbackRate: 2.0 },
};
const JUMP_VOICE_DEFAULT: JumpVoiceCfg = { set: "jump_voice", rate: 2.0, fallbackRate: 2.0 };
// The jump grunt also plays on fall-start; this gap dedupes jump→fall (a
// jump OFF a ledge fires both within a few frames) and any double-trigger.
const JUMP_VOICE_MIN_GAP_S = 0.28;
// −12 dB ≈ quarter amplitude (maintainer 2026-07-19: "lower by 50%" twice —
// first −6, then "lower again"). A static level balance → pure mode too.
const JUMP_VOICE_GAIN_DB = -12;
// Thunder from a strike directly overhead (maintainer 2026-08-06: "the exact
// high loud thunder after a lightning strike close by … immediate and loud").
// Takes master at -1 dBFS and the sfx bus is -14 dB, so +14 dB here puts the
// crack at roughly full scale on the master — the limiter (-8 dB threshold,
// 12:1) turns the overshoot into punch instead of clipping.
const THUNDER_GAIN_DB = 14;

// A NAMED PLACE PLAYS ITS OWN SCORE (maintainer 2026-08-08, after picking
// cave4: "Can you play the music cave4 inside that cave regardless if it's day
// or night?"). Keyed by the maps agent's place id from
// maps2/worlds/<world>/places.json — `the_cave` on the_island2 — so adding a
// room's music is a line here plus a track, with no geometry in the audio code.
// Deliberately keyed on the ID and not the `kind`: two caves can want different
// music, and "every cave sounds the same" should be a choice, not a default.
// BATTLE MUSIC (maintainer 2026-08-08). The simple version, deliberately: one
// `battle` bed, triggered when a fight starts and faded away over four seconds
// once it ends — NOT the per-bed battle layers he sketched, which come later.
//
// THE FOUR SECONDS ARE THE WHOLE FEATURE, and they are a TAIL, not a fade-out
// timer: "if you hack-n-slash a lot of monsters the whole mob could be seen as
// one big battle. So we want to not stop the battle music to early." Every
// moment of threat pushes the tail back out to four seconds, so a mob is one
// continuous fight rather than a stutter of starts and stops.
//
// NO RESTART, BY CONSTRUCTION rather than by a flag: the bed is SELECTED once
// when the fight starts and is not re-selected until the tail actually expires.
// Re-engaging inside the tail only moves the deadline and takes the level back
// to 1, so the track carries on exactly where it was. (Bed.stop/start would
// resume from a saved position anyway, but not re-selecting means the question
// never arises.)
const BATTLE_TAIL_S = 4;

const PLACE_BEDS: Record<string, BedName> = {
  the_cave: "cave4",
  // The maps agent names the summit `mountain_top` on every world that has one
  // (the_island2, the_island, demo_isle, demo_lost), so one entry covers them
  // all — which is the payoff of keying on the place ID rather than the world.
  mountain_top: "summit_triumph",
};
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
  // The CONTEXT SCORE (contextMusic.ts): one bed per situation — battle, cave,
  // home, town, night, adventure — cross-faded as the player moves through the
  // world. Replaces the single night-bed layer. Until the beds are generated
  // `resolveBed` finds nothing and the sound-domain catalog bed keeps playing,
  // exactly as before.
  private beds: ContextMusic | null = null;
  private bedWanted = false;
  // The bed a named place demands, or null outdoors — see setPlace().
  private placeBed: BedName | null = null;
  // When the battle tail expires. 0 = not fighting and not fading.
  private battleUntil = 0;
  private bedNow: BedName | null = null;
  private bedSince = 0;
  private bedOverride: BedName | null = null;
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
    this.beds = new ContextMusic(this.graph, this.buffers);
    // Tonal SFX snap to whichever score is actually playing — the context bed
    // when one is up, the catalog track otherwise. Without this delegation the
    // scale-snap and beat-quantize would go dead the moment the context score
    // took over from the catalog bed.
    const musical: MusicalContext = {
      scalePitchClasses: () => this.beds?.scalePitchClasses() ?? this.music.scalePitchClasses(),
      nextBeatIn: (maxWaitS: number) =>
        this.beds?.activeBed() ? this.beds.nextBeatIn(maxWaitS) : this.music.nextBeatIn(maxWaitS),
    };
    this.oneShots = new OneShotPlayer(this.graph, this.buffers, musical);
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
      for (const set of ["stone", "snow", "ice", "grass", "jump_voice", "jump_voice_boy", "ui_tick", "thunder"]) {
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
    this.bedWanted = true; // context beds: audition-only until routed (see slowTick)
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
   * music is off, in pure mode, or while a bed audition has the music bus. */
  private applyNightLevel(night: number, tauS: number): void {
    if (!this.nightGain || !this.graph) return;
    const amt = this.pureOn ? 0 : Math.min(1, Math.max(0, night));
    const target = this.musicOn && this.nightWanted ? dbToGain(NIGHT_MUSIC_DB) * amt : 0;
    this.nightGain.gain.setTargetAtTime(Math.max(0.0001, target), this.graph.now, tauS);
  }

  /** AUDITION a bed in-game (`__ml.audioBed("cave")`), overriding the
   * situation until released with no argument. This is how the maintainer
   * judges a new track without hunting the map for the place that triggers it.
   * Returns the bed list so the console call is self-documenting. */
  auditionBed(name?: string | null): { playing: BedName | null; available: BedName[]; all: BedName[] } {
    const match = BED_NAMES.find((n) => n === name) ?? null;
    this.bedOverride = match;
    if (!match) this.bedSince = 0; // let the situation retake it immediately
    this.slowTick();
    return {
      playing: this.beds?.activeBed() ?? null,
      available: BED_NAMES.filter((n) => hasBed(n)),
      all: [...BED_NAMES],
    };
  }

  /** Pick + apply the context bed. Battle may interrupt immediately; every
   * other change waits out BED_MIN_HOLD_S so a bed always gets to be music
   * rather than a fragment. */
  private updateBeds(field: FieldSample, sun: number, level: number): boolean {
    if (!this.beds || !this.bedWanted) return false;
    const want =
      this.bedOverride ??
      this.placeBed ??
      resolveBed(desiredBed({ ...field, sun }, this.bedNow), (n) => hasBed(n));
    const now = this.graph ? this.graph.now : 0;
    const held = now - this.bedSince;
    // An explicit audition must not wait out the minimum hold — the maintainer
    // types __ml.audioBed("cave") and expects to hear cave, not silence for six
    // seconds followed by a switch they have stopped listening for.
    const urgent =
      want === "battle" || this.bedNow === null || this.bedOverride !== null ||
      // Crossing a doorway is a hard cut in the world; making the player stand
      // in the cave for six seconds of valley music would read as a bug.
      want === this.placeBed || this.placeBed !== null;
    if (want !== this.bedNow && (urgent || held >= BED_MIN_HOLD_S)) {
      this.bedNow = want;
      this.bedSince = now;
      this.beds.setContext(want);
    }
    this.beds.setLevel(level);
    // Report AUDIBLE, not merely wanted: a bed is a ~1 MB fetch the first time
    // its context comes up, and silencing the catalog bed the instant we chose
    // one would leave a hole of silence until it decoded. The catalog keeps
    // playing and cross-fades out the moment the bed is really up.
    return this.beds.activeBed() !== null;
  }

  /** WHICH NAMED PLACE IS THE PLAYER STANDING IN? (maps2 places.json — the
   * maps agent labels the interiors so the game can react to a ROOM rather than
   * re-deriving it from geometry.) null outdoors. The client calls this only
   * when the answer changes.
   *
   * A place bed OWNS THE MUSIC BUS while it is set: the day score and the night
   * bed both step aside, because "inside the cave" is not a time of day
   * (maintainer 2026-08-08: "play the music cave4 inside that cave regardless
   * if it's day or night"). Battle is deliberately NOT special-cased here — no
   * battle layer is wired yet, and the moment one is, this is where that
   * decision belongs. */
  setPlace(id: string | null): void {
    const next = id && PLACE_BEDS[id] ? PLACE_BEDS[id] : null;
    if (next === this.placeBed) return;
    this.placeBed = next;
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
   * sound, everywhere, like the stone footsteps). The ui_confirm set stays
   * bundled + auditionable at /#foley for a future opt-in. */
  private static EVENT_FOLEY: Record<string, string> = {
    // The approved tab click on press. The tactile PAIR is gone: `ui.release`
    // used to play the dedicated duller ui_cancel recording, but the
    // maintainer rejected all four ui_cancel takes in the wiki (2026-08-05)
    // and the set is deleted — so the release is SILENT rather than quietly
    // reusing a sound he approved for something else. `ui.release` is still
    // emitted, so the wiki can assign it whenever he picks a release sound.
    "ui.press": "ui_tick",
    // Legacy single-click events any game code may still emit.
  };

  /** Which of an event's assigned sounds plays this time. Round-robin, so N
   * sounds on one event each get their turn and none repeats back-to-back —
   * the same contract a multi-take set already gets, lifted one level up.
   * Deliberately NOT random: he assigned four thunders to hear four thunders,
   * and random selection would replay one twice in a row often enough to read
   * as "it only picked up some of them". */
  private assignTurn = new Map<string, number>();
  private pickAssigned(name: string, list: EventAssignment[]): EventAssignment {
    if (list.length === 1) return list[0];
    const i = (this.assignTurn.get(name) ?? -1) + 1;
    this.assignTurn.set(name, i);
    return list[i % list.length];
  }

  /** Fire a bound event (sounds/bindings.json names: "ui.confirm",
   * "player.jump", ...). Unknown events are silent no-ops. */
  event(name: string, opts: PlayOpts = {}): void {
    if (!this.ready()) return;
    // The Game Master's wiki assignment outranks every built-in route.
    // A PER-CHARACTER assignment wins over the shared one: the wiki already
    // scopes an event to a hero as `player.jump@<uid>`, so the same spelling
    // gives each character their own death cry (maintainer 2026-08-06, on the
    // die-voice request: "This is the female die sound effect. Can't assign a
    // separate voice to the male (you need to fix that)"). Unscoped stays the
    // everyone-sound; nothing is inherited, so an unassigned voice is silent.
    const list =
      (opts.voice ? EVENT_ASSIGNMENTS[`${name}@${opts.voice}`] : undefined) ??
      EVENT_ASSIGNMENTS[name];
    const assigned = list?.length ? this.pickAssigned(name, list) : undefined;
    if (assigned) {
      const rate = (opts.rate ?? 1) * (assigned.pitch ?? 1);
      const gainDb = (opts.gainDb ?? 0) + (assigned.volume_db ?? 0);
      const j = assigned.max_random_pitch_semis ?? 0;
      if (assigned.sound.startsWith("composer/")) {
        const { set, take } = splitComposerId(assigned.sound, assigned.take);
        // One chosen recording plays ALONE; a whole set rotates. Binding the
        // url list IS how many sounds the event has — never a set of ten with
        // rotation switched off (maintainer 2026-08-05).
        const one = take === undefined ? null : composerFoleyTake(set, take);
        const urls = take === undefined ? composerFoley(set) : one ? [one] : null;
        if (urls) {
          this.oneShots.play(
            {
              id: `assigned:${name}`,
              category: "feedback",
              loop: false,
              file: "",
              urls,
              variation: {
                round_robin: true,
                no_immediate_repeat: true,
                pitch_jitter_semitones: [-j, j],
                // NO GAIN JITTER on an assigned sound. He sets
                // max_random_pitch_semis himself — cross_on_peat is 0, meaning
                // "play it the same every time" — and the engine was still
                // adding a random -0.75/+0.5 dB per fire that he never asked
                // for. On a sound that fires after EVERY kill that is audible
                // wobble, and it is the engine overruling the one knob he set.
                // An assignment plays as assigned.
                gain_jitter_db: [0, 0],
              },
            },
            assigned.bus ?? "sfx",
            { ...opts, rate, gainDb },
          );
        }
        return;
      }
      const snd = this.catalog?.sounds.get(assigned.sound);
      if (snd) this.oneShots.play(snd, assigned.bus ?? "sfx", { ...opts, rate, gainDb });
      return;
    }
    // The jump grunt (maintainer 2026-07-19: a Link-style vocal effort) is a
    // composer set on the SFX bus, spatialized, NOT a −12 dB UI click — so it
    // gets its own branch. The SAME grunt plays when she starts to FALL off a
    // ledge (maintainer 2026-07-19: "same sound when she starts to fall").
    // A short debounce dedupes jump→fall (jumping OFF a cliff would otherwise
    // grunt on the hop and again as the drop begins). Falls through to the
    // catalog `jump` binding if the vocal set isn't bundled yet. NOTE: the
    // catalog `jump` sound stays the sand/dirt footstep — voice only here.
    if (name === "player.jump" || name === "player.fall") {
      const cfg = (opts.voice && JUMP_VOICE[opts.voice]) || JUMP_VOICE_DEFAULT;
      let set = cfg.set;
      let pitch = cfg.rate;
      let voice = composerFoley(set);
      if (!voice && set !== "jump_voice") {
        // The character's OWN set isn't bundled yet — fall back to the shared
        // (girl) takes at this character's fallback pitch (never silent).
        set = "jump_voice";
        pitch = cfg.fallbackRate;
        voice = composerFoley("jump_voice");
      }
      if (voice) {
        const now = this.graph!.ctx.currentTime;
        if (now - this.lastJumpVoiceT < JUMP_VOICE_MIN_GAP_S) return;
        this.lastJumpVoiceT = now;
        this.oneShots.play(this.foleyEntry(set, voice, "voice"), "sfx", {
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
    // bindings.json is the sound agent's RECOMMENDATION, not an approval —
    // only events the maintainer signed off may resolve through it. Every
    // other emitted event is silent until a wiki assignment exists.
    if (!BINDINGS_APPROVED.has(name)) return;
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
   * presence (the roll's low end barely reproduces on small speakers).
   *
   * ASSIGNABLE since 2026-08-06 as `weather.thunder`. It used to play the
   * whole regenerated set, because thunder is not fired by a
   * `gameAudio.event(...)` call site and so had no name the wiki could offer.
   * It has one now, and he immediately used it: four different candidates
   * (cand07/08/09/17) assigned inside a minute, which ROTATE. An assignment
   * replaces the set — picking four means those four, not those four plus the
   * six selected takes. The old catalog fallback (a pitched-down `explosion`
   * arriving 1-2.5 s after the flash) stays deleted: an empty set must not
   * silently promote the exact disguise-and-delay behaviour he rejected.
   *
   * The gain and the near-center pan stay HERE rather than coming from the
   * assignment: they are what puts the crack on the white flash, and they
   * apply whichever recording he picks.
   *
   * NO SET FALLBACK (maintainer 2026-08-06, and this one was mine to fix:
   * "I'm really mad of me having to unassign a list of crappy thunder I never
   * mapped! I'm the one who map sound to events! NOT YOU!"). This used to
   * rotate the whole foley/thunder set whenever no assignment existed, which
   * put six recordings on weather.thunder that he never chose — and he then
   * had to unbind all six by hand. Rotating a set IS mapping sounds to an
   * event. An unassigned event is SILENT, with no exception for the set that
   * happens to share the event's name. */
  thunder(strength = 1): void {
    if (!this.ready()) return;
    if (!EVENT_ASSIGNMENTS["weather.thunder"]?.length) return;
    this.event("weather.thunder", {
      gainDb: THUNDER_GAIN_DB * Math.min(1, strength),
      pan: (Math.random() - 0.5) * 0.16,
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
    //
    // ASSIGNABLE since 2026-08-06. This moment was driven straight off the
    // swimming flag and never passed through event(), so `player.water_enter`
    // existed only as a line in sounds/bindings.json — the wiki listed it, he
    // assigned a sound to it, and there was nothing for the assignment to
    // attach to. Now the transition names itself, and an assignment REPLACES
    // the splash. With no assignment the catalog splash plays exactly as
    // before: this sound was approved long before the assignment loop existed,
    // so "unassigned" must not silence it the way it does for a fresh event.
    if (f.swimming !== g.swimming) {
      g.swimming = f.swimming;
      const evt = f.swimming ? "player.water_enter" : "player.water_exit";
      if (EVENT_ASSIGNMENTS[evt]) {
        this.event(evt, { pan: f.pan, dist: f.dist });
      } else {
        this.play("splash", "sfx", {
          pan: f.pan,
          dist: f.dist,
          gainDb: f.swimming ? SWIM_ENTER_DB : SWIM_EXIT_DB,
          rate: f.swimming ? 1 : 1.2,
        });
      }
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

  /** A CATALOG sound (e.g. `splash`) played as a footstep: the approved
   * PRIMARY take with the gentle step micro-jitter — the same doctrine as the
   * composer foley sets, but sourced from the catalog. Like those, it BINDS
   * the one take it plays rather than carrying the catalog's whole take list
   * behind a disabled rotation (maintainer 2026-08-05: one sound is one
   * sound). Audibly identical — the same primary file played before. */
  private catalogStepEntry(base: SoundEntry): SoundEntry {
    let e = this.stepCache.get(base.id);
    if (!e) {
      const primary = base.takes?.length ? [base.takes[0]] : undefined;
      e = {
        ...base,
        id: `catstep_${base.id}`,
        takes: primary,
        mix_gain_db: 0, // level decided per-play
        variation: {
          round_robin: true,
          no_immediate_repeat: true,
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
  private foleyEntry(set: string, urls: string[], profile: "step" | "click" | "voice" | "rotate"): SoundEntry {
    let e = this.foleyCache.get(set);
    if (!e) {
      const step = profile === "step";
      // A VOICE (the jump grunt) is the one set that ROTATES: hearing the
      // exact same waveform every jump reads as robotic — real games (OoT's
      // Link) rotate a few efforts. Round-robin, no immediate repeat, plus a
      // natural pitch spread (a voice never lands twice at the same pitch).
      // `rotate` is the same deal for a non-vocal set the maintainer asked to
      // hear as a GROUP: thunder ("a group with several sounds", 2026-08-06).
      const voice = profile === "voice";
      const many = voice || profile === "rotate";
      // ONE SOUND MEANS ONE SOUND (maintainer 2026-08-05). Steps and clicks
      // play the set's APPROVED PRIMARY take and only that, so the entry binds
      // that one url — it does not carry every take and then switch rotation
      // off. The old shape advertised four sounds and played one, which the
      // wiki had to mirror as a `round_robin: false` workaround. The variation
      // contract below is now the plain one for every profile; how many sounds
      // an event has is expressed by the URL LIST, which is the honest place
      // for it. Audibly identical: the same primary file plays as before.
      const takes = many ? urls : urls.slice(0, 1);
      e = {
        id: `composer_foley_${set}`,
        category: voice ? "movement" : step ? "movement" : "ui",
        loop: false,
        file: takes[0],
        urls: takes,
        mix_gain_db: 0, // level is decided per-play by the caller
        variation: {
          round_robin: true,
          no_immediate_repeat: true,
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
    // Whichever score is live owns the clock.
    return this.beds?.activeBed() ? this.beds.clock() : this.music.clock();
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

    // THE SCORE. The generated context beds (town/cave/home/battle/adventure)
    // are NOT routed to situations — the maintainer wants to audition them
    // first and then say what plays where (2026-08-05), so the in-world score
    // is exactly what it has always been: the sound-domain catalog bed by day,
    // cross-faded into the mystical NIGHT bed after dark. The bed machinery
    // only takes the music bus while an explicit audition is running
    // (auditionBed / __ml.audioBed / the /#score page).
    const modeMul = GameAudio.MODE_MUSIC[this.mode] ?? 1;
    const tau = this.musicToggleFast ? 0.06 : 0.4;

    // A named PLACE takes the bus on exactly the same terms an audition does:
    // its bed plays, the day score and the night bed both fade out. An explicit
    // audition still wins, so __ml.audioBed() works from inside the cave too.
    if (this.bedOverride || this.placeBed) {
      this.updateBeds(field, sun, this.pureOn ? 1 : this.musicOn ? modeMul : 0);
      this.music.setLevel(0, tau);
      this.applyNightLevel(0, tau);
      this.musicToggleFast = false;
      return;
    }
    // BATTLE. Threat uses the same hysteresis as the bed selector (BED_ON to
    // start, BED_OFF to stop) so a monster hovering at the edge of the trigger
    // cannot strobe the music on and off.
    const now = this.graph ? this.graph.now : 0;
    const fighting = (field.threat ?? 0) > (this.battleUntil ? BED_OFF.battle : BED_ON.battle);
    if (fighting) this.battleUntil = now + BATTLE_TAIL_S;
    if (this.battleUntil && now < this.battleUntil && hasBed("battle")) {
      // Full level while the fight is live; the last BATTLE_TAIL_S seconds ARE
      // the fade, so this reaches 0 exactly as the tail runs out.
      const tail = Math.max(0, Math.min(1, (this.battleUntil - now) / BATTLE_TAIL_S));
      const base = this.pureOn ? 1 : this.musicOn ? modeMul : 0;
      if (this.bedNow !== "battle") {
        // Selected ONCE per fight. Re-engaging inside the tail never reaches
        // here, which is what keeps the track from restarting.
        this.bedNow = "battle";
        this.bedSince = now;
        this.beds?.setContext("battle");
      }
      this.beds?.setLevel(base * tail);
      // The world score cross-fades back UP as the battle fades down, so the
      // handover is one gesture rather than a hole of silence.
      this.music.setLevel(this.musicOn ? this.dayLevelFor(sun, modeMul) * (1 - tail) : 0, tau);
      this.applyNightLevel(Math.min(1, Math.max(0, 1 - sun)) * (1 - tail), tau);
      this.musicToggleFast = false;
      return;
    }
    this.battleUntil = 0;
    // Not auditioning — make sure no bed is left holding the bus.
    if (this.bedNow !== null) {
      this.bedNow = null;
      this.beds?.setContext(null);
    }

    // DAY/NIGHT MUSIC CROSS-FADE (maintainer 2026-07-19: "more mystical bg
    // music during night"). When a night bed exists the DAY score fades to a
    // low floor at night while the mystical NIGHT bed cross-fades UP, so nights
    // belong to the night track — which loops CONTINUOUSLY (a new stretch each
    // cycle, never just its opening). Without a night bed yet, keep the old
    // gentle dip so nights aren't silent. Pure mode freezes at the authored
    // score. The toggle snaps; mood changes keep the slow ease.
    const nightAmt = Math.min(1, Math.max(0, 1 - sun));
    this.music.setLevel(this.musicOn ? this.dayLevelFor(sun, modeMul) : 0, tau);
    if (this.nightWanted) this.ensureNightMusic(); // covers the async unlock/load
    this.applyNightLevel(nightAmt, tau);
    this.musicToggleFast = false;
  }

  /** The day score's level for this sun, extracted so the battle cross-fade
   * hands back to EXACTLY the level the world would otherwise be playing —
   * a second copy of this formula would drift the moment either changed. */
  private dayLevelFor(sun: number, modeMul: number): number {
    if (this.pureOn) return 1;
    const haveNight = !!this.nightGain || !!nightMusicUrl();
    const dayFloor = haveNight ? 0.12 : 0.45;
    return (dayFloor + (1 - dayFloor) * sun) * modeMul;
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
      // Background behavior (maintainer 2026-08-05): master ducks to 0.5
      // hidden, and music.backgroundLoop shows the native-loop handoff.
      master: this.graph ? Math.round(this.graph.master.gain.value * 1000) / 1000 : null,
      hidden: typeof document !== "undefined" ? document.hidden : false,
      music: this.graph ? this.music.debug() : null,
      beds: this.beds?.debug() ?? null,
      ambience: this.ambience?.debug() ?? null,
      env: { ...this.env },
      field: this.fieldSampler?.() ?? null,
    };
  }
}

export type { SoundEntry };
