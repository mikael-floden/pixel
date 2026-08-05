import Phaser from "phaser";
import { Room, getStateCallbacks } from "colyseus.js";
import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  CELL_WU,
  DIRECTIONS,
  DEFAULT_DIRECTION,
  InputMessage,
  ChatBroadcast,
  stepMovement,
  vectorToDirection,
  TerrainGrid,
  buildTerrainGrid,
  makeBlocked,
  makeBlockedElev,
  resolveElevAt,
  makeSideBlocked,
  unstickFromSolids,
  autoJumpWanted,
  steerAssist,
  monsterDodge,
  type MonsterDodgeState,
  DEFAULT_MONSTER_RADIUS,
  startTrip,
  stepAutopilot,
  AutopilotTrip,
  surfaceAtWorld,
  levelAtWorld,
  integrateFall,
  isStandableAtWorld,
  isBlockedAtWorld,
  findSpawn,
  surfaceFor,
  isKnownSurface,
  screenToWorldVector,
  PLAYER_RADIUS,
  WALK_CLIMB,
  JUMP_CLIMB,
  JUMP_SPEED_FACTOR,
  JUMP_MS,
  JUMP_COOLDOWN_MS,
  WALK_SPEED,
  RUN_SPEED,
  DEFAULT_TIME_IDX,
  TIME_PHASE_SECONDS,
  WEATHER_NAMES,
  WEATHER_COUNT,
  parseSpawns,
  type SpawnZone,
  unarmedClip,
  idSalt,
  xpToNext,
  faceDirWorld,
  PICKUP_RADIUS_WU,
  attackRange,
  PLAYER_BODY_RADIUS,
  PROVOKE_RADIUS_WU,
  DROP_TTL_MS,
  DROP_FLASH_MS,
} from "@nangijala/shared";
import { CharacterDef, Manifest, frameUrl, frameKey, BOOT_ANIM_STATES } from "../manifest";
import { withV } from "../assetver";
import { MonsterManifest, MonsterDef, monsterWalkKey, resolveMonsterAnim } from "../monsterManifest";
import { colorForName } from "../placeholder";
import { setBar, setLevel } from "../bars";
import { gameAudio } from "../../../composer/index";
import { Atmosphere, LightSource } from "../lighting";
import {
  NightLights,
  ShaderLight,
  MAX_SHADER_LIGHTS,
  emissionWave,
  emissionSelfPulse,
  EmissionMap,
  EmissionEntry,
  EmissionSource,
  GlowStamp,
  buildGlowStamps,
} from "../nightlight";
import { joinWorld } from "../net";
import { bindLiveTuning, liveTuningSnapshot } from "../live";
import { ChatUI } from "../chat";
import { WeatherFX } from "../weatherfx";
import { Footsteps } from "../footsteps";
import { setClockTime, clockStar } from "../clock";
import { HudBar, mountPageFrame } from "../hud";
import { getHand, setHand } from "../controls";
import { setLoadingProgress, hideLoading } from "../loading";
import { fadeToBlack } from "../fade";
import { applyUiZoom } from "../uiscale";
import {
  World,
  MAP_GEOMETRY,
  tileKey,
  tileUrl,
  distinctTiles,
  distinctTilePaths,
  distinctPropPaths,
  pathTileKey,
  assetUrl,
  faceKeyFor,
  topKeyFor,
  isMaps2World,
  drawOrder,
  canvasSize,
  TileBases,
  artLift,
  DEFAULT_WORLD,
  Deck,
} from "../maps";

// Fallback loop rates when a state has no measured gaitFps. The jump clip is
// NOT here: it plays once and its rate is derived per character in
// buildAnimations (frames / JUMP_MS) so the clip always spans the hop arc —
// the art agent resizes it freely (the 2026-07-29 overhaul cut it 9→4 frames,
// and the old fixed 18fps would have frozen a 4-frame clip mid-air at ~222ms).
const ANIM_FPS: Record<string, number> = {
  idle: 6,
  walk: 12,
  run: 14,
  // One-shot combat clips: strikes read snappy, the pickup crouch and the
  // death fall read deliberate. (Movement clips use measured gaitFps instead.)
  kick: 12,
  punch: 12,
  hurt: 16, // round 7 (maintainer): the got-hit flinch plays FAST
  pickup: 9,
  die: 8,
};
// The blood spatter's 8 direction variants (objects/blood_spatter, trimmed to
// burst->dispersal) — one is picked at random per landed hit, played forward
// or reversed at random.
const BLOOD_DIRS = ["east", "north", "north-east", "north-west", "south", "south-east", "south-west", "west"];
// The target/aggro border palettes (maintainer rounds 9-11). Each border is a
// GENERATED outline texture — see ringTextureFor: 4-NEIGHBOUR dilation only,
// so a diagonal silhouette step yields single diagonally-touching border
// pixels, the way pixel art draws its own outlines (round 10: 8-direction
// dilation read THICK). Round 11: the border is 2px — an inner line in the
// base colour and an outer line slightly BRIGHTER in the same palette.
// RED = monsters: the one you clicked (the whole fight through) and every
// monster currently hunting YOU. LIGHT-LIGHT-BLUE = the ground item you are
// fetching (tap or PICK UP), replacing the old hand icon.
const TARGET_RING_COLOR = 0x8e2222; // dark red, inner (round 9's approved tone)
const TARGET_RING_BRIGHT = 0xb83a3a; // outer line, same palette a step brighter
const ITEM_RING_COLOR = 0x9adcf0; // light-light-blue, inner
const ITEM_RING_BRIGHT = 0xc4ecfa; // outer line, brighter
const RING_PAD = 2; // outline canvas pad = border width in art pixels
// Tap hitboxes (maintainer round 12: taps kept missing small targets). World
// px ≈ screen px at zoom 1; phones run integer zoom ≥1, so these are AT
// LEAST fingertip-scale on every device.
const DROP_TAP_HALF = 26; // was 16 — items are ~29px art on the ground
const MONSTER_TAP_MIN_HALF_W = 26; // was 18, and the art factor grew 0.4→0.5+6
const MONSTER_TAP_MIN_H = 48; // minimum box height — sprigling-class bodies
// Spawn campfire (objects/campfire, burn/south): 96px frames; per its
// placement metadata the fire is 0.6m ≈ 23px tall vs a 64px character, and
// the drawn logs span rows 15..83 of the frame → scale + base anchor below.
const CAMPFIRE_KEY = "campfire-burn";
// The ONE art asset the game names directly instead of reading it from a
// manifest — objects/ ships none, and that whole domain is now this single
// file. If objects/ ever gains a manifest, read the url from it instead of
// hardcoding the extension here.
const CAMPFIRE_URL = "/assets/objects/campfire/animations/burn__south.webp";
const CAMPFIRE_FRAME = 96;
const CAMPFIRE_FRAMES = 17;
const CAMPFIRE_SCALE = 42 / 68;
const CAMPFIRE_BASE = 83 / 96;
// Settings "OVERLAY" cycler: flat covers over the game view for frame QA
// (pink = the keying magenta, deliberately loud).
// Per-weather overcast (uCloud scale) + flat ambient gloom: the rain family
// brings clouds, drizzle/snow/windy only partly. Shared by the ease loop and
// the instant paths (join sync + the __ml.weather QA probe).
const WEATHER_CLOUD: Record<number, number> = { 1: 1, 3: 0.35, 4: 0.7, 5: 1, 6: 1, 7: 0.4, 8: 0.25 };
const WEATHER_DIM: Record<number, number> = { 3: 0.05, 4: 0.12, 5: 0.22, 6: 0.34, 7: 0.05 };

const OVERLAYS = [
  { name: "none", color: null as string | null },
  { name: "black", color: "#000" },
  { name: "white", color: "#fff" },
  { name: "pink", color: "#ff00ff" },
];
const INPUT_HZ = 20;
const BUBBLE_MS = 5000;
const PLACEHOLDER_TEX = "placeholder:wanderer";
const SHADOW_TEX = "avatar:shadow";
// Monsters use a softer, more diffuse variant (see ensureMonsterShadowTexture):
// a light core with a long penumbra tail, spread MONSTER_SHADOW_SPREAD beyond
// the measured footprint so the visible core still matches the contact patch.
const MONSTER_SHADOW_TEX = "monster:shadow";
const MONSTER_SHADOW_SPREAD = 1.35;
// CAMERA GATE for the monster body pipeline. A world ships ~160 monsters
// (the_island2) and EVERY one of them used to run the full shared body
// pipeline each frame — stableDir + anim play, per-frame origin/shift,
// occluder-aware resolveBodyDepth (a ray test), placeBodyShadow, and a
// lit-copy sync that samples the CPU light AND the depth fog — plus a Phaser
// draw for sprite + shadow + lit copy. Off-screen that is all invisible work.
// A monster is ACTIVE only while its art box can touch the camera view grown
// by this slack; the slack is pure hysteresis so a body idling on the rim
// can't flicker in and out (the box itself already uses the real art size).
// Culled monsters still track their authoritative position every frame — the
// player's input-dodge reads fx/fy for EVERY monster, and a parked body must
// re-enter the view already in the right place, never sliding in from a stale
// spot. See `__ml.monsterGate()`.
const MONSTER_CULL_SLACK = 64;
// Tile self-emission is data-driven: tiles/emission.json (owned by the tiles
// agent — every category has an entry, null = does not glow). Each glowing
// category gets (a) a self-glow FLOOR on its own pixels (shader, nightlight.ts)
// and (b) a small SHADOW-FREE glow pool around it. Pools are clustered per
// EMISSION_BUCKET-cell bucket (a whole lava lake becomes a few soft pools)
// and rendered as big elliptical stamps in the additive glow field — NOT as
// shader light slots. Slots are capped at 12 and were handed to the nearest
// pools only, so walking a few steps re-ranked the winners and pools popped
// on/off deep inside the viewport (playtester). The stamp field has no slot
// limit, and EMISSION_PAD keeps every pool whose light could reach the view
// inside the rebuild window: culling only ever drops light that is entirely
// off-screen.
const MAX_EMISSIVE = 48; // atmosphere blooms per view (canvas fallback, perf)
const EMISSION_BUCKET = 3; // cells per cluster bucket side
// Pool reach ≈ radius(≤3.5 cells) × cluster growth(≤2) × 45.3 px/cell ≈ 316px,
// plus the 96px camera drift allowed between occluder rebuilds.
const EMISSION_PAD = 448;
// Time-of-day cycle ([1] cycles, ~2.5s smooth interpolation between phases).
// Each phase is ONLY an ambient grade (what unlit art is multiplied by) —
// point lights are never phase-tuned (a light is a light; daylight drowns
// fire pools naturally because the multiply clamps near full brightness).
// NIGHT is the calibrated reference — its values must never drift. The other
// grades are first passes from the Sea of Stars reference stills, tuned one
// phase at a time with the playtester (morning next).
const TIME_PHASES: { name: string; ambient: [number, number, number] }[] = [
  // Calibrated night: dark, desaturated, mild blue tilt.
  { name: "Night", ambient: [0.075, 0.09, 0.14] },
  // Rosy dawn: as dark as evening but PINK-red (B stays up) — vs evening's
  // orange-amber. Playtester: "the famous reddish tint we all love".
  { name: "Morning", ambient: [0.61, 0.43, 0.4] },
  // Ref: the art as authored — neutral, full brightness.
  { name: "Day", ambient: [1.0, 1.0, 1.0] },
  // Amber sunset, dimmed — same hue as before, ~78% the brightness.
  { name: "Evening", ambient: [0.74, 0.55, 0.37] },
];
// Directional sun per phase (maintainer: the day's sun MOVES — morning light
// from the east casts long west-pointing shadows, noon stands high with short
// ones, evening mirrors morning; night has no sun). cast = the GRID direction
// shadows fall (screen west ≈ grid (-1,+1), screen east ≈ (+1,-1), down-screen
// ≈ (+1,+1)); slope = levels climbed per cell toward the sun (lower = longer
// shadows); strength 0 disables. Lerped with the same clock as the ambient.
const R2 = Math.SQRT1_2;
const SUN_PHASES: { cast: [number, number]; slope: number; strength: number }[] = [
  { cast: [0, 0], slope: 1, strength: 0 }, // Night — no sun
  // Maintainer-specified sweep: shadows point screen-RIGHT in the morning,
  // screen-DOWN(-ish) at midday (sun top-centre), screen-LEFT in the
  // evening — the shadow direction rotates clockwise right -> down -> left.
  { cast: [R2, -R2], slope: 0.34, strength: 1 }, // Morning — shadows to screen-east
  // Midday: shadows fall EXACTLY straight down-screen, in sync with the
  // clock hand at 12 (maintainer). An older west tilt guarded against
  // shadows hiding under south wall faces, but that dated from the steep
  // slope-1.15 era — at 0.45 a 1-level ledge shadow spans ~2 cells and
  // clears the face (verify-sunshadow's day gate holds it honest).
  { cast: [R2, R2], slope: 0.45, strength: 1 },
  { cast: [-R2, R2], slope: 0.34, strength: 1 }, // Evening — shadows to screen-west
];

function sunVec(idx: number): [number, number, number, number] {
  const p = SUN_PHASES[idx % SUN_PHASES.length];
  return [p.cast[0], p.cast[1], p.slope, p.strength];
}

/** CONTINUOUS time: blend the phase tables between MID-phase anchors.
 * u = timeIdx + phaseT (server-synced progress). At u = i + 0.5 the look is
 * exactly TIME_PHASES[i]/SUN_PHASES[i] — the approved discrete looks — and
 * between anchors everything sweeps linearly (maintainer: "the clock arrow
 * and the shadow should move continuously... not swap from day to evening
 * that sudden"; the discrete jumps were why time kept LOOKING broken).
 * Manual skips land at phaseT 0.5, so frozen phase-testing still shows the
 * exact keyframes (and every verify script keeps its calibration). */
function blendPhases(u: number): {
  ambient: [number, number, number];
  torchF: number;
} {
  const N = TIME_PHASES.length;
  const v = u - 0.5;
  const k = Math.floor(v);
  const w = v - k;
  const i0 = ((k % N) + N) % N;
  const i1 = (i0 + 1) % N;
  const a0 = TIME_PHASES[i0].ambient;
  const a1 = TIME_PHASES[i1].ambient;
  const L = (x: number, y: number) => x + (y - x) * w;
  // Torch impact is part of the sweep: melts out through late morning,
  // rekindles through early evening.
  const t0 = i0 === 2 ? 0 : 1;
  const t1 = i1 === 2 ? 0 : 1;
  return {
    ambient: [L(a0[0], a1[0]), L(a0[1], a1[1]), L(a0[2], a1[2])],
    torchF: L(t0, t1),
  };
}

/** The clock hand's continuous position, weighted by the PHASE DURATIONS:
 * the sunlit phases (morning+day+evening) share ONE sweep of the 12-hour
 * face in proportion to their length, the night is the other sweep. Each
 * sweep spans its phase set's real duration — night ticks 3x as fast
 * (40s vs the sunlit 120s, maintainer), so the night sweep covers the
 * same full half-circle at 3x the angular speed. Angle: degrees from
 * straight DOWN, + = left. */
function handAngle(u: number): { deg: number; night: boolean; f: number } {
  const N = TIME_PHASE_SECONDS.length;
  const idx = ((Math.floor(u) % N) + N) % N;
  const t = u - Math.floor(u);
  if (idx === 0) return { deg: -90 + t * 180, night: true, f: t };
  const D = TIME_PHASE_SECONDS[1] + TIME_PHASE_SECONDS[2] + TIME_PHASE_SECONDS[3];
  let acc = 0;
  for (let i = 1; i < idx; i++) acc += TIME_PHASE_SECONDS[i];
  const f = (acc + t * TIME_PHASE_SECONDS[idx]) / D;
  return { deg: -90 + f * 180, night: false, f };
}

/** Directional light ALWAYS points where the arrow points (maintainer):
 * the sun vector DERIVES from the hand angle instead of per-phase
 * keyframes. Screen shadow direction for hand angle A is (-sin A, cos A);
 * the grid cast solves the iso projection ((cx-cy)*32, (cx+cy)*13) to
 * yield it — passing exactly through the approved keyframes: -90 ->
 * (R2,-R2) morning-right, 0 -> (R2,R2) straight down at 12, +90 ->
 * (-R2,R2) evening-left. Slope rises toward noon; strength is 0 all night
 * (no sun = no wrong direction) with short sunrise/sunset ramps at the
 * sweep ends. */
function sunFromHand(deg: number, night: boolean, f: number): [number, number, number, number] {
  if (night) return [0, 0, 1, 0];
  const A = (deg * Math.PI) / 180;
  const sx = -Math.sin(A);
  const sy = Math.cos(A);
  let cx = sx / 32 + sy / 13;
  let cy = sy / 13 - sx / 32;
  const n = Math.hypot(cx, cy) || 1;
  const slope = 0.34 + 0.11 * Math.cos(A);
  const strength = Math.max(0, Math.min(1, f / 0.06, (1 - f) / 0.06));
  return [cx / n, cy / n, slope, strength];
}

// Ambient/sun ease for a manual phase SKIP only — time itself is continuous,
// and the clock pill is a pure function of it (no fade, no hand-off hold).
const TIME_TRANSITION_S = 1.25;
// The starting phase + count live in shared/ — time-of-day is WORLD STATE
// (server-owned, synced): [1] / the HUD button send "timeofday" and the
// state listener applies the change for everyone. TIME_PHASES must stay in
// step with TIME_PHASE_COUNT.

// Lit copies (see applyObjectLights) live in a thin band ABOVE the darkness
// overlay (depth 900_000) but must keep the world's relative draw order among
// themselves — a character in front of the fire must cover the fire's lit copy
// too. Base depths are screen-y scalars (< ~20k px), compressed into the band.
const litDepth = (baseDepth: number) => 900_001 + baseDepth * 1e-5;
const JUMP_HEIGHT = 28; // px peak of the jump hop (a tall, floaty arc)
// A 1-level STEP (up or down) plays a QUICK little hop — the jump animation + jump
// sound — while the player keeps FULL walk/run speed (this is purely cosmetic: the
// movement/collision is untouched, so a single step never slows you). Shorter +
// lower than the real 2-level jump, which stays a taller, slower, deliberate arc.
const STEP_HOP_MS = 240; // duration of the quick step-hop arc
const STEP_HOP_HEIGHT = 12; // px peak of the quick step-hop arc
const SWIM_BOB = 2.2; // px amplitude of the gentle head bob while swimming
const EXIT_JUMP_MS = 500; // ms window to rise out of the water on exit (matches the hop)
// Foam "lapping" animation (maintainer's idea): re-bake the SAME crest at a
// slightly different line ANGLE per frame. The tiny tilt tips some columns over
// their rounding boundary, so the crest hops in WHOLE pixels (never subpixel) —
// reads as gentle water movement. The rock is SYMMETRIC (±) about the opaque
// span's centre and ADAPTIVE (normalised by span width in foamTexture), so the
// span ends move only ±1px however long/steep the line is — no rotating away.
// Three variants — left(-1)/normal(0)/right(+1) — each frame jumps to a RANDOM
// different one (no fixed loop), so it reads as lapping rather than a metronome.
const FOAM_ANIM_MS = 230; // ms each foam frame holds (~4 fps — slow, watery)
// The waterline is a shallow downward BOW (a "smile"), not a straight line, so
// the cut + foam wrap around the character's volume: lowest at the centre-front
// (body nearest the viewer), rising to the sides. Dip = BOW_FRAC × the shoulder
// span, in px. Both the clip mask and the foam crest follow it.
const BOW_FRAC = 0.14;
const GROUND_MARGIN = 512; // extra ground drawn beyond the screen (px per side)
// Occluder rebuild cadence, and the slack every occluder cull margin is
// derived FROM. The set is only re-evaluated once the camera centre has
// drifted this far, so anything culled must stay invisible for a whole
// OCC_STEP of camera travel — every cull box below is grown by at least this
// much (plus a tile) or geometry would wink in at the leading screen edge.
const OCC_STEP = 96;
// Extra cull margin beyond OCC_STEP: one tile of art, plus room for the
// biggest body art box that resolveBodyDepth can test against a column
// (a mammoth spans ~190px) — a column that could still sort against an
// on-screen body must keep its images, not just the ones that draw.
const OCC_CULL_PAD = OCC_STEP + 64 + 200;
// Living camera (maintainer): the camera CHASES the player instead of pinning
// them dead-centre — exponential ease toward the sprite with the trail capped,
// plus a small speed-coupled ZOOM-OUT so the player still sees a bit further
// while moving (the chase alone would show less in the running direction).
// Battle music (composer): how close a HUNTING monster (mstate chase/combat)
// has to be for the fight to count as mine — world units, 32/cell, so ~7
// cells. Roaming monsters score zero at any distance.
const THREAT_NEAR_WU = 220;
const CAM_TAU = 0.3; // s — position smoothing (run trail ≈ 175px/s × τ ≈ 52px)
const CAM_TRAIL_MAX = 70; // scene px — the player never outruns the frame
const CAM_SNAP_DIST = 600; // teleports (respawn/lookAt) snap instead of crawl
const CAM_ZOOM_OUT = 0.32; // fraction of base zoom shed at full run speed (maintainer: "stronger", twice)
const CAM_ZOOM_REF_WU = 124; // ≈ run world-speed (175 px/s side-view · √½)
const CAM_ZOOM_TAU_OUT = 0.45; // s — ease toward zoomed-out while speeding up
const CAM_ZOOM_TAU_IN = 0.85; // s — slower ease back in (no pumping)

interface Avatar {
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  character: string;
  // Logical (eased) ground position; the sprite is drawn at this minus the jump
  // hop so the hop offset never feeds back into the easing. `ly` is the LIFTED
  // feet screen y (flat ground minus the animated elevation) — every consumer
  // (depth, shadow, labels, lit copy) reads it. `lyFlat` is the eased FLAT
  // (unlifted) ground y and `elev` the animated elevation lift in px; splitting
  // them lets a cliff descent fall under gravity instead of snapping.
  lx: number;
  ly: number;
  lyFlat: number;
  elev: number; // current elevation lift (px); eases/falls toward cell level×lh
  fallV: number; // downward velocity (px/s) while a cliff fall is in progress
  falling: boolean;
  wasFalling?: boolean; // prev-frame falling, for the fall-start grunt edge
  // Flat authoritative world position (pre-projection) — terrain queries and
  // the night-shader lights need THIS space, never the projected lx/ly.
  fx: number;
  fy: number;
  lit?: Phaser.GameObjects.Sprite; // lit copy above the night overlay
  // Screen y of the highest wall top drawn over the sprite this frame, or
  // undefined when nothing covers it — the lit copy is cropped BELOW this line.
  coverY?: number;
  hopUntil: number;
  hopDur?: number; // duration (ms) of the CURRENT hop arc (JUMP_MS jump vs STEP_HOP_MS step)
  hopH?: number; // peak height (px) of the current hop arc
  stepLvl?: number; // last frame's rounded surface level — detects a 1-level step to hop over
  wasJumping?: boolean; // last synced jumping flag (hop re-arms on rising edge only)
  swimming: boolean;
  wasSwimming?: boolean; // last frame's swimming — detects the swim→land exit
  exitJumpUntil?: number; // while >now, ease the elevation UP (leap out of water)
  swimT: number; // 0..1 submerge amount (0 = feet on ground, 1 = shoulders at surface)
  // The SURFACE level the avatar stands (deck/base) or floats (pool) on. While
  // swimming the rendered `elev` sinks `swimDrop` px BELOW this, so lighting must
  // sample HERE (the visible head/shoulders float at the surface) — see litLevelOf.
  surfLevel?: number;
  bobPhase: number; // per-avatar swim bob phase
  waterMaskG?: Phaser.GameObjects.Graphics; // half-plane-above-shoulders mask shape
  waterMask?: Phaser.Display.Masks.GeometryMask; // the reusable geometry mask
  foam?: Phaser.GameObjects.Image; // waterline foam (per-frame texture, sprite-aligned)
  foamTilt?: number; // current foam crest tilt variant (-1/0/+1), the lapping frame
  foamNextAt?: number; // time.now when the foam rolls to a new tilt
  baseTint: number;
  // Combat mirrors (server action/actionSeq/hitSeq/dead drive one-shot clips).
  actionKey?: string;
  actionUntil?: number;
  lastActionSeq?: number;
  lastHitSeq?: number;
  lastHp?: number;
  bubble?: Phaser.GameObjects.Text;
  bubbleUntil?: number;
  // Direction hysteresis (stableDir): the direction currently DISPLAYED, and
  // the pending adjacent-sector candidate with the time it first appeared.
  dispDir?: string;
  pendDir?: string;
  pendSince?: number;
  // EMA of the avatar's ground speed in WORLD units/s, back-projected from
  // the eased flat screen position. Drives anims.timeScale so gait playback
  // stays proportional to the ground ACTUALLY covered. World — not screen —
  // speed on purpose: the iso projection compresses vertical, so at the
  // calibrated uniform screen speed a screen-north walk crosses ISO_DX/ISO_DY
  // ≈ 2.13× more world ground per second than an east one; legs must pace
  // the ground, or fore/back walks read as a lazy shuffle while tiles fly by
  // (playtester: "up/down walk plays too slow, feet not traveling as far").
  spdWu?: number;
}

// How long an ADJACENT (45°) direction change must persist before the sprite
// turns. Walking along a sector boundary makes vectorToDirection flip every
// few frames; each flip used to restart the walk cycle ("jitter"). 160ms is
// invisible on a deliberate turn but longer than any boundary wobble period.
const DIR_STICK_MS = 160;
// Where the DRAWN ground diamond's top vertex sits below the tile art box's
// lattice anchor (world px). The maps2 tile art seats its diamond this far
// down inside the 64px box — measured by flood-filling monster_demo pads
// (salamander + sand, two materials agree): the drawn diamond is exactly
// lattice-sized (640x~298 for a 5x5 pad) but a uniform ~5px lower than the
// pure (c+r)*dy lattice. The spawn-zone overlay must add this or its outline
// rides visibly above every pad it traces (maintainer screenshot 2026-07-30 —
// the residual previously misread as edge-alpha inset).
const TILE_DIAMOND_TOP = 5;

// A roaming MONSTER (the poring family) rendered from the authoritative
// server-synced Monster schema. Much lighter than an Avatar: no swim/torch/
// footstep/label machinery — porings just hop (walk == jump), so we ease the
// projected position exactly like a remote player and play the 8-dir jump
// strip while `moving`. `lx/lyFlat/ly/elev/fallV/falling` mirror the avatar
// easing fields; `dispDir` is the last-played facing, `fx/fy` the flat
// authoritative world position (for depth/debug).
interface MonsterAvatar {
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Image;
  kind: string;
  lx: number;
  lyFlat: number;
  ly: number;
  elev: number; // current elevation lift (px); eases/falls toward cell level×lh
  fallV: number;
  falling: boolean;
  dispDir: string;
  fx: number;
  fy: number;
  lit?: Phaser.GameObjects.Sprite; // lit copy above the night overlay (shared pipeline)
  coverY?: number; // wall-top line covering the sprite (lit copy cropped below it)
  surfLevel?: number; // surface level in LEVELS (occluder + light sampling basis)
  shadowW: number; // resting nadir-shadow ellipse, measured from the walk ART
  shadowH: number; // (footprint blended toward body width; see addMonster)
  radius: number; // physical body radius (wu) — the player's input-dodge clearance
  hoverPx: number; // intentional levitation (winged flyers) above the ground anchor
  pendDir?: string; // stableDir hysteresis state (same contract as Avatar)
  pendSince?: number;
  // The manifest-RESOLVED walk anim key for this kind (animation_map.json —
  // "walk" for the 24-roster). NEVER hardcode the anim name here: the poring
  // era's art happened to call its walk "jump", a literal "jump" hid in
  // playMonsterAnim behind that coincidence, and the moment the manifest
  // resolved properly every monster froze mid-slide (maintainer 2026-07-30).
  walkKey: string;
  attackKey?: string; // resolved attack anim (undefined: art has none)
  angryKey?: string; // between-swings loop (6 of 24 kinds ship none)
  dieKey?: string;
  idleKey?: string; // resolved idle anim (undefined: no idle art — park on walk contact)
  // PER-DIRECTION ground contract (manifest `ground`): originY feet line,
  // originX foot centre, and the planted `contact` frame a pause parks on.
  // One pooled anchor floated whole directions (strips differ per direction
  // after art repairs) and frame-0 pauses left hop gaits levitating.
  ground?: Record<
    string,
    {
      f: number;
      cx: number;
      contact: number;
      sink?: number;
      up?: number;
      shift?: number[];
      air?: number[];
    }
  >;
  groundIdle?: MonsterAvatar["ground"]; // idle strips are framed independently
  // CAMERA GATE (see MONSTER_CULL_SLACK): true while the body's art cannot
  // touch the view, so its render pipeline is parked. Positions keep syncing.
  culled?: boolean;
  // COMBAT mirrors (server mstate/actionSeq drive the clips).
  mstate?: string;
  lastActionSeq?: number;
  combatClip?: boolean; // current clip is attack/angry/die — per-frame walk drift must not index into it
  hpBg?: Phaser.GameObjects.Rectangle;
  hpFill?: Phaser.GameObjects.Rectangle;
  nameText?: Phaser.GameObjects.Text; // display name — left-aligned OVER the bar
  lvText?: Phaser.GameObjects.Text; // "Lv N" — left-aligned UNDER the bar
  hpText?: Phaser.GameObjects.Text; // "hp/max" — right-aligned UNDER the bar
  label?: string; // manifest display name ("Dewling"), resolved once at spawn
  lastHp?: number;
}

/** The common body-visual subset the SHARED render helpers operate on —
 * occluder-aware depth (resolveBodyDepth), landing-ground shadow
 * (placeBodyShadow) and the lit copy (syncLitCopy). Avatar and MonsterAvatar
 * both satisfy it structurally, so monsters render through the exact same
 * battle-tested code path as players (maintainer 2026-07-29: monsters drew
 * behind terrace tiles with detached shadows and took no lighting — their
 * first cut had a naive painter depth and no lit copy). */
interface BodyVisual {
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Image;
  lx: number;
  lyFlat: number;
  ly: number;
  elev: number;
  fx: number;
  fy: number;
  lit?: Phaser.GameObjects.Sprite;
  coverY?: number;
  surfLevel?: number;
  swimming?: boolean;
}

export class WorldScene extends Phaser.Scene {
  private manifest!: Manifest;
  private myCharacter!: CharacterDef;
  private myName!: string;
  private room?: Room;
  private avatars = new Map<string, Avatar>();
  // Roaming monsters (server-authoritative, all clients see the same ones).
  private monsters = new Map<string, MonsterAvatar>();
  // How many monsters passed the camera gate last frame (QA: __ml.monsterGate).
  private monstersActive = 0;
  // Monster catalog (null when /monsters.json was unavailable → no monsters).
  private monsterManifest: MonsterManifest | null = null;
  // Faint debug outline of each fake SPAWN_AREA rectangle (WIP placeholder,
  // later the maps agent owns real areas). World-anchored via this.project.
  private spawnAreaGfx?: Phaser.GameObjects.Graphics;
  // Monster spawn-zone overlay: DEBUG, off by default and persisted like the
  // other switches (maintainer 2026-07-30 — the zones are map data, not part
  // of the played world).
  private spawnAreasOn = localStorage.getItem("ml-spawn-areas") === "1";
  private spawnZones: SpawnZone[] | null = null; // lazily fetched when first shown
  private spawnZonesLoading = false;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private lastSent = "";
  private chat!: ChatUI;
  private hud?: HudBar;
  // Client-side prediction state (local player). Each pending input keeps the
  // JUMP state it was originally integrated with: reconcile replays must use
  // the same climb allowance, or mid-jump inputs replayed after landing get
  // re-blocked at the ledge (walk climb) — the anchor briefly rolls back to
  // the wall base until the server acks, and auto-jump saw that phantom wall
  // and fired a silly second hop on the hilltop.
  private pending: { seq: number; ax: number; ay: number; running: boolean; dt: number; jumping: boolean; slow: number }[] = [];
  private curSlowFactor = 1; // the hit-slow factor live integration ran under (captured per input)
  private inputSeq = 0;
  private sendAccum = 0;
  private lastInput: { ax: number; ay: number; running: boolean } = { ax: 0, ay: 0, running: false };
  // Tap-to-move (mobile-first): tap the ground → walk there; double-tap → run.
  // The autopilot only SYNTHESIZES the same 8-way screen input the keyboard
  // produces, so prediction/server validation/auto-jump all behave identically.
  private unloading = false; // page is really unloading (pagehide) — don't auto-rejoin
  private connected = false; // live room connection (false while reconnecting)
  private reconnectRetries = 0;
  private reconnectToast?: HTMLElement;
  // Trip state — ALL navigation logic lives in the shared startTrip /
  // stepAutopilot (headless-testable, see server/test/navigation.sim.test.ts);
  // the scene owns only the glue (tap picking, marker, keyboard-cancels).
  private trip: AutopilotTrip | null = null;
  // Autopilot decision trace (debug hook __ml.navLog; ring buffer, dev cost ~0).
  private navLog: Record<string, unknown>[] = [];
  // Hold-to-move: the one pointer allowed to steer (first touch down), the
  // finger's CURRENT ground point (the beacon follows it every frame — the
  // instant-feel half), and the next time a real findPath replan is allowed
  // (the adaptive-budget half: measured p50 ≈ 3-5ms, p95 ≈ 17-24ms on the
  // shipped worlds — see scripts/bench-findpath.ts — so per-frame replans
  // would eat whole frames on phones; each replan schedules the next at
  // cost×8, floored at 50ms).
  private holdPointerId: number | null = null;
  /** A HUD modal (the drop-quantity dialog) owns the screen: the world
   * ignores pointer input entirely. NOT decorative — Phaser's window-level
   * listeners deliberately process events whose target is NOT the canvas
   * (TouchManager.onTouchStartWindow), so a tap on a DOM overlay reaches the
   * scene and armed a walk-to trip THROUGH the dialog (maintainer 2026-08-05:
   * cancelling a drop ran the player to where he tapped). */
  private uiLocked = false;
  /** …and the tap that CLOSES a modal must not become a trip either: the
   * close handler runs on the element, Phaser's window listener runs after it
   * in the same dispatch, so the lock is lifted a beat later than it is
   * released. */
  private uiLockLiftAt = 0;
  private holdGround: { x: number; y: number; lvl: number } | null = null;
  private holdRepathAt = 0;
  private keysActive = false;
  private tapMarker?: Phaser.GameObjects.Container;
  // Isometric tile world (null → fall back to a plain ground).
  private world: World | null = null;
  private worldName: string = DEFAULT_WORLD; // which maps2 world (room + assets)
  private worldW = WORLD_WIDTH; // this world's extent in world units (grid×CELL_WU)
  private worldH = WORLD_HEIGHT;
  private maps2 = false; // true when the world uses maps2 explicit tile paths
  private iso = { ox: 0, oy: 0, w: WORLD_WIDTH, h: WORLD_HEIGHT };
  // Terrain (elevation + surface) — same grid the server uses, so prediction matches.
  private terrain: TerrainGrid | null = null;
  // Streaming ground renderer state.
  private groundRT?: Phaser.GameObjects.RenderTexture;
  // Chase-cam state: eased world centre + eased zoom; detached while a debug
  // lookAt holds the camera elsewhere.
  private camChase = { x: 0, y: 0, zoom: 0, init: false };
  private camDetached = false;
  private lastGround = { x: NaN, y: NaN };
  private maxLevel = 0;
  // world@2 decks (elevated walkable slabs): cell key (row*width+col) → slab.
  private deckIndex = new Map<number, { deck: Deck; cell: Deck["cells"][number] }>();
  // Occlusion: raised/solid tiles near the camera drawn as depth-sorted images
  // so they cover characters standing BEHIND them (the ground RT is flat).
  private occluders: Phaser.GameObjects.Image[] = [];
  // Placed decorations (maps2 world@1 props): depth-sorted so characters pass
  // in front of / behind them; rebuilt with the occluders as the camera moves.
  private propImgs: Phaser.GameObjects.Image[] = [];
  // Lit copies of TALL NON-EMISSIVE solid structures: billboard art samples
  // the light field of the terrain BEHIND it, so a shore tree's canopy was
  // multiplied by the level-0 ocean's night — pitch black above the horizon
  // (playtester report). Like characters, they get a copy above the darkness
  // overlay tinted by their OWN cell's light. Emissive solids (lava pillars,
  // glowing spires) keep their per-pixel field look.
  private litOccluders: {
    img: Phaser.GameObjects.Image;
    col: number;
    row: number;
    z: number;
    emission?: EmissionEntry; // emissive variant: tint gets the self-glow floor
    phase?: number;
  }[] = [];
  private occluderMeta: {
    col: number;
    row: number;
    top: number; // column's top level
    solid: boolean; // impassable structure — its tall art is a billboard
    depth: number;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  }[] = [];
  private lastOccl = { x: NaN, y: NaN };
  // Images the last rebuild skipped (view-culled + deck-exposure-culled) —
  // reported by __ml.occCount() so the win is measurable, not asserted.
  private occCulled = 0;
  // --- Occlusion fade: tall geometry ABOVE the local player's level near the
  // player is faded to a faint ghost (moved behind the player) so it stops
  // hiding the character; a REVEAL layer redraws the player-level ground the
  // tower was covering (so you see the grass/level you're walking on, NOT the
  // tower), and drops a BLACK diamond at each faded tower's ROOT (its base
  // footprint — the one spot with nothing behind it, so it must read as void).
  // Masked to a soft bubble around the player (distance falloff).
  private occFadeOn = false; // feature toggle ([7]) — WIP prototype, opt-in for now
  private occFocus: { col: number; row: number } | null = null; // debug focus override
  // Does the CURRENT occluder set carry ghost depth/alpha from a fade pass?
  // While the feature is OFF (the default) this stays false, which lets
  // updateOcclusionFade skip its restore sweep entirely — see there.
  private occGhosted = false;
  private occRevealRT?: Phaser.GameObjects.RenderTexture; // player-level ground + black roots
  private lastReveal = { x: NaN, y: NaN, cx: NaN, cy: NaN };
  private emissiveLights: LightSource[] = [];
  // Local jump prediction (client owns its jump timing).
  private jumpUntil = 0;
  private jumpReadyAt = 0;
  private jumpQueued = false;
  private deferredAnimsKicked = false; // action-state frames background-load once, after join
  private selfDead = false; // mirror of my own Player.dead (freezes input sending)
  private engagedId: string | null = null; // monster I tapped to fight (client intent)
  private pendingPickupId: string | null = null; // walk-to-item, grab on arrival
  private pickupIntentUntil = 0; // give up on a pickup intent after this
  private nextPickupSendAt = 0; // pickup re-send throttle (server race under latency)
  private lastHudSig = ""; // last hp/ep/xp/level pushed to the DOM bars
  private monsterRings = new Map<string, Phaser.GameObjects.Image>(); // red outlines: engaged + hunters
  private itemRingImg?: Phaser.GameObjects.Image; // blue outline on the item being fetched
  private aggroGfx?: Phaser.GameObjects.Graphics; // aggro-radius debug rings
  private aggroRadiusOn = localStorage.getItem("ml-aggro-radius") === "1";
  private nextChaseRepathAt = 0; // walk-to-engaged-monster retarget throttle
  private nextEngageSendAt = 0; // engage re-assert throttle (server drops target on move)
  private joinQuietUntil = 0; // drops synced in at (re)join are not events
  private drops = new Map<
    string,
    {
      img: Phaser.GameObjects.Image;
      shadow: Phaser.GameObjects.Image;
      wx: number;
      wy: number;
      item: string;
      bornAt: number;
    }
  >();
  private roomBoundAt = 0; // when the current room's state flood began (join vs witnessed)
  // Grave crosses (objects/grave_cross): appear where a monster died, hold on
  // the last frame, then REVERSE back into the ground and vanish.
  private graveCrosses: { sprite: Phaser.GameObjects.Sprite; bornAt: number; reversing: boolean }[] = [];
  private pendingCrosses: { lx: number; lyFlat: number; elevPx: number }[] = []; // kills before the strip landed
  private crossLoadQueued = false;
  private bloodSeen = 0; // QA counter: blood spatters spawned this session
  private dodgeState?: MonsterDodgeState; // soft monster-collision side commitment
  // It is ALWAYS night in Nangijala (for now): the per-pixel shader when
  // WebGL is available, the multiply grade as the canvas fallback.
  private atmo!: Atmosphere;
  private night?: NightLights;

  // tiles/emission.json categories (empty when the registry failed to load).
  private emission: EmissionMap = {};
  // tiles2/emission.json (maps2 worlds): per-material glow params (keyed by
  // material name = a maps2 cell/prop's `t`) + per-tile-path glow sources.
  private tiles2Mat: EmissionMap = {};
  private tiles2Src: Record<string, EmissionSource[]> = {};
  // Glow halos emitted by emissive PROPS this frame — merged into glowStamps.
  private propStamps: GlowStamp[] = [];
  // Bottom-anchor offset for tall (64x128 cliff/tall profile) tile art: drawn
  // with the same top-left anchor as 64px tiles it sinks 64px into the ground
  // (only the crystal tip peeked out — playtester report). Lift comes from the
  // variant's measured art base (tile-bases.json), see artYOff.
  private artOffCache = new Map<string, number>();
  private tileBases: TileBases | null = null;
  // /#emission: this SAME scene on the generated station world (demo room).
  // Per-pixel glow halos for the visible window (rebuilt with the occluders).
  private glowStamps: GlowStamp[] = [];
  // The spawn campfire: an animated world object with its own fire light.
  private campfire?: { col: number; row: number; z: number; x: number; y: number; depth: number };
  private campfireSprite?: Phaser.GameObjects.Sprite;
  private campfireLit?: Phaser.GameObjects.Sprite;
  // [5] toggles the LOCAL player's hand torch (handy for judging fixed lights).
  private torchOn = true;
  // [6] toggles the spawn bonfire — firelight drowns self-emission QA nearby.
  private fireOn = true;
  // Position readout pinned under the local player (cell coords, chat-style
  // UI text above the darkness overlay) — every screenshot self-locates.
  private posLabel?: Phaser.GameObjects.Text;
  // Debug-only extra light, set from __ml.probeLight for headless probes.
  private probeLight: ShaderLight | null = null;
  // Time-of-day state: target phase index + eased interpolation FROM whatever
  // grade is currently on screen (mid-transition retargets stay smooth).
  private timeIdx = DEFAULT_TIME_IDX;
  private timeT = 1; // 0..1 progress toward TIME_PHASES[timeIdx]
  private timeStart = 0; // wall-clock ms when the transition began
  private timeFromAmbient: [number, number, number] = [...TIME_PHASES[DEFAULT_TIME_IDX].ambient];
  private timeFromSun: [number, number, number, number] = sunVec(DEFAULT_TIME_IDX);
  private curSun: [number, number, number, number] = sunVec(DEFAULT_TIME_IDX);
  // Weather layer (server-owned like timeIdx): cloud cover eases toward the
  // target over a few seconds — clouds roll in, they don't blink in.
  private weatherIdx = 0;
  private curCloud = 0;
  private curMist = 0;
  private curPrecipDim = 0;
  private weatherFX?: WeatherFX;
  private footsteps?: Footsteps;
  private timeFrozen = true; // synced mirror of WorldState.frozen (switch state)
  private timeSpeed = 0; // synced mirror of WorldState.timeSpeed (button label)
  private phaseT = 0.5; // synced mirror of WorldState.phaseT (continuous progress)
  private auroraOn = false; // synced target; curAurora eases toward it
  private curAurora = 0;
  // Torch IMPACT is continuous, not a boolean (maintainer): 1 at dusk/night/
  // dawn, 0 at full Day, riding the same 2.5s clock as the ambient grade so
  // flames melt away as daylight arrives and rekindle as it passes.
  private curTorchF = 1;
  private timeFromTorchF = 1;
  private curAmbient: [number, number, number] = [...TIME_PHASES[DEFAULT_TIME_IDX].ambient];

  constructor() {
    super("world");
  }

  init() {
    this.manifest = this.registry.get("manifest") as Manifest;
    this.monsterManifest = (this.registry.get("monsterManifest") as MonsterManifest | null) ?? null;
    this.myCharacter = this.registry.get("character") as CharacterDef;
    this.myName = this.registry.get("name") as string;
    this.world = (this.registry.get("world") as World | null) ?? null;
    this.worldName = (this.registry.get("worldName") as string | undefined) ?? DEFAULT_WORLD;
    this.maps2 = !!this.world && isMaps2World(this.world);
    this.tileBases = (this.registry.get("tileBases") as TileBases | null) ?? null;
    if (this.world) {
      // The world's extent in world units (grid×CELL_WU) — per-world, so any
      // size renders/collides right (see shared: WORLD_WIDTH is only a default).
      this.worldW = this.world.width * CELL_WU;
      this.worldH = this.world.height * CELL_WU;
      this.terrain = buildTerrainGrid(this.world.width, this.world.height, this.world.rows, this.world.props, this.world.decks);
      // Surface-contract watchdog: categories missing from SURFACES default
      // to walkable ground, which ALSO makes the night lighting treat them
      // as terrain (walls + face shadows) instead of solid objects (art +
      // soft cast shadow). Surface it loudly so the loop adds new categories.
      const unknown = new Set<string>();
      for (const row of this.world.rows) for (const c of row) if (!isKnownSurface(c.t)) unknown.add(c.t);
      if (unknown.size)
        console.warn(
          `[nangijala] ${unknown.size} tile categories missing from SURFACES (defaulting to plain ground — night shadows may misclassify them):`,
          [...unknown].sort().join(", "),
        );
    }
  }

  preload() {
    // Drive the post-"Enter world" loading overlay with real asset progress
    // (characters + tiles are hundreds of small PNGs — slow on mobile).
    this.load.on("progress", (f: number) => {
      if (!this.deferredAnimsKicked) setLoadingProgress(0.05 + f * 0.85, "Loading art…");
    });
    // characters2 stores animations as frame FOLDERS (one PNG per frame), not
    // strips — load each frame as its own texture. BOOT loads only the
    // movement states (BOOT_ANIM_STATES); the 9 action states (~800 PNGs the
    // 2026-07-29 overhaul added, nothing triggers them yet) background-load
    // AFTER the avatar is in (loadDeferredAnims) so joining stays fast.
    for (const def of this.manifest.characters) {
      for (const [state, dirs] of Object.entries(def.animations)) {
        if (!BOOT_ANIM_STATES.includes(state)) continue;
        for (const [dir, count] of Object.entries(dirs)) {
          for (let n = 0; n < count; n++) {
            this.load.image(frameKey(def.uid, state, dir, n), withV(frameUrl(def, state, dir, n)));
          }
        }
      }
    }
    // Monster art: 48x48 HORIZONTAL strips, loaded as spritesheets (campfire
    // pattern). WALK/ROAM only this round — load just the resolved walk (jump)
    // strip per (kind, direction); attack/die are deferred.
    for (const def of this.monsterManifest?.monsters ?? []) {
      // WALK + IDLE (maintainer 2026-07-30: stopped monsters must PLAY their
      // idle, not freeze on a walk frame); attack/die stay deferred.
      const states = [monsterWalkKey(def)];
      if (def.idleAnim && !states.includes(def.idleAnim)) states.push(def.idleAnim);
      for (const anim of states) {
        const dirStrips = def.strips?.[anim] ?? {};
        for (const [dir, url] of Object.entries(dirStrips)) {
          if (!url) continue; // guard a missing strip
          // Slice with the STRIP'S OWN measured frame size — art repairs
          // resize strips in place, so the monster-level size can be stale
          // (frame bleed).
          const dims = def.stripDims?.[anim]?.[dir];
          this.load.spritesheet(monsterSheetKey(def.id, anim, dir), withV(url), {
            frameWidth: dims?.w ?? def.frameW,
            frameHeight: dims?.h ?? def.frameH,
          });
        }
      }
    }
    // Isometric ground tiles.
    if (this.world) {
      if (this.maps2) {
        // maps2 world bakes an explicit tile PNG per cell + per-material face
        // tiles + placed props — load that unique set.
        for (const path of distinctTilePaths(this.world)) {
          this.load.image(pathTileKey(path), withV(assetUrl(path)));
        }
        for (const path of distinctPropPaths(this.world)) {
          this.load.image(pathTileKey(path), withV(assetUrl(path)));
        }
      } else {
        for (const { t, v } of distinctTiles(this.world)) {
          this.load.image(tileKey(t, v), withV(tileUrl(t, v)));
        }
      }
      // maps2 worlds get their glow from tiles2/emission.json
      // (per-MATERIAL params + per-TILE-PATH sources — see loadTiles2Emission).
      if (this.maps2) this.load.json("tiles2-emission", withV("/assets/tiles2/emission.json"));
      // placeCampfire guards on textures.exists, so a miss means no bonfire
      // rather than a broken scene.
      this.load.spritesheet(CAMPFIRE_KEY, withV(CAMPFIRE_URL), {
        frameWidth: CAMPFIRE_FRAME,
        frameHeight: CAMPFIRE_FRAME,
      });
    }
  }

  async create() {
    this.ensurePlaceholderTexture();
    this.ensureShadowTexture();
    this.ensureMonsterShadowTexture();
    this.buildAnimations();
    this.buildMonsterAnimations();
    if (this.world) this.setupStreamingGround();
    else this.drawGround();
    this.placeCampfire();

    this.atmo = new Atmosphere(this);
    this.atmo.create();
    this.atmo.setPreset("night");
    // Shader night needs WebGL; on canvas renderers the multiply grade
    // remains the night fallback.
    // maps2 self-emission (tiles2/emission.json): per-material glow params +
    // per-tile-path glow sources. In every maps2 world the emissive tiles are
    // PROPS (geodes, lava rocks, glowing mushrooms — base_x_N object tiles), so
    // the glow is stamped from prop positions in rebuildProps; nothing on the
    // flat terrain glows, so this stays out of the per-cell shader floor.
    if (this.maps2) {
      const t2 = this.cache.json.get("tiles2-emission") as
        | { materials?: EmissionMap; sources?: Record<string, EmissionSource[]> }
        | undefined;
      this.tiles2Mat = t2?.materials ?? {};
      this.tiles2Src = t2?.sources ?? {};
      if (!t2) console.warn("[nangijala] tiles2/emission.json missing — prop glow disabled");
    }
    if (this.world && this.game.renderer.type === Phaser.WEBGL) {
      try {
        this.night = new NightLights(this, this.world, this.iso, this.maxLevel, this.emission);
        this.night.create();
      } catch (err) {
        console.warn("[nangijala] shader night unavailable:", err);
        this.night = undefined;
      }
      // The first ground window / occluders were drawn BEFORE this.night
      // existed and still carry the baked daylight contact shades — redraw
      // them so the night world uses per-pixel light only.
      if (this.night) {
        this.lastGround = { x: NaN, y: NaN };
        this.lastOccl = { x: NaN, y: NaN };
      }
    }

    // A resize grows the visible window: force the streamed ground,
    // occluders and glow stamps to rebuild for the new extent (and re-pick
    // the camera zoom for the new viewport width).
    this.scale.on("resize", () => {
      this.cameras.main.setZoom(this.zoomFor());
      this.camChase.zoom = this.zoomFor(); // re-base the chase zoom too
      this.lastGround = { x: NaN, y: NaN };
      this.lastOccl = { x: NaN, y: NaN };
    });

    this.keys = this.input.keyboard!.addKeys(
      "W,A,S,D,UP,DOWN,LEFT,RIGHT,SHIFT",
    ) as Record<string, Phaser.Input.Keyboard.Key>;
    // F = pick up nearest ground item (the gamepad pickup button synthesizes
    // this same key, exactly like its jump button synthesizes SPACE).
    this.input.keyboard!.on("keydown-F", () => this.pickupNearest());

    // Tap/hold-to-move. A tap RUNS to the tapped point — nobody walks when
    // they can run (maintainer), so there is no double-tap gesture; the
    // autopilot itself eases into a walk inside APPROACH_WALK_RADIUS of the
    // target. HOLDING the pointer steers continuously: the target follows
    // the finger (no tap-tap-tap), so holding near the player walks (the
    // target stays inside the walk zone) and holding further out runs.
    // The trip starts on pointerDOWN (instant response); releasing simply
    // stops retargeting — the trip finishes at the last touched point.
    this.input.addPointer(2); // second touch (e.g. resting thumb) must not steer
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      // A HUD modal is up (or just closed under this very gesture): the world
      // takes no input at all — no trip, no engage, no fetch.
      if (this.uiLocked || performance.now() < this.uiLockLiftAt) return;
      if (this.holdPointerId !== null) return; // first touch keeps the wheel
      // TAP TARGETS outrank ground movement (RO: click a monster to fight it,
      // click an item to fetch it). Hit-tested against the drawn art boxes in
      // world coords; a miss falls straight through to the movement path, so
      // the hold-to-move machinery (and its wedge-proofing) is untouched.
      const tgt = this.tapTarget(p.worldX, p.worldY);
      if (tgt) {
        if (tgt.kind === "drop") {
          this.pendingPickupId = tgt.id;
          this.pickupIntentUntil = this.time.now + 6000;
          this.engagedId = null;
          const d = this.drops.get(tgt.id)!;
          this.setMoveTarget(d.wx, d.wy, true, false, undefined, false); // hand marker, no beacon
        } else {
          this.engagedId = tgt.id;
          this.pendingPickupId = null;
          const mv = this.monsters.get(tgt.id)!;
          this.setMoveTarget(mv.fx, mv.fy, true, false, undefined, false); // sword mark, no beacon
          this.nextChaseRepathAt = 0;
          // Tell the server NOW, not on arrival: the target persists while
          // moving and the sword-marked monster aggros as we close in.
          this.room?.send("engage", { id: tgt.id });
          this.nextEngageSendAt = this.time.now + 700;
        }
        return; // no hold armed: the walk-to is driven by driveCombatIntent
      }
      // A plain ground tap breaks off any fight/fetch (RO: moving cancels).
      this.engagedId = null;
      this.pendingPickupId = null;
      this.holdPointerId = p.id;
      this.holdGround = this.pickGround(p.worldX, p.worldY);
      // Fresh gesture = fresh trip (hold=false: reset the sticky slow, build
      // the beacon); subsequent drag replans go through holdRepath's budget.
      if (this.holdGround) this.setMoveTarget(this.holdGround.x, this.holdGround.y, true, false, this.holdGround.lvl);
      this.holdRepathAt = performance.now() + 50;
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (p.id !== this.holdPointerId || !p.isDown) return;
      const g = this.pickGround(p.worldX, p.worldY);
      if (!g) return;
      this.holdGround = g;
      // The beacon tracks the FINGER in realtime (free — pure projection);
      // the actual findPath replan runs on holdRepath's adaptive budget, so
      // the drag never *feels* throttled even when a replan is deferred.
      if (this.tapMarker) {
        const pr = this.projectFlat(g.x, g.y);
        this.tapMarker.setPosition(pr.x, pr.y - Math.max(pr.lvl, g.lvl) * MAP_GEOMETRY.lh);
      }
      this.holdRepath(performance.now());
    });
    const releaseHold = (p: Phaser.Input.Pointer) => {
      if (p.id !== this.holdPointerId) return;
      this.commitReleaseHold();
    };
    this.input.on("pointerup", releaseHold);
    this.input.on("pointerupoutside", releaseHold);
    // WEDGE-PROOFING (maintainer: tap racing the join/reconnect → the player
    // runs to the stale point forever and NO new tap registers — pointerdown
    // ignores everything while holdPointerId is set). The scene's pointerup
    // can be swallowed: a DOM overlay (loading screen, reconnect toast, HUD)
    // racing the gesture, or an OS touchcancel Phaser doesn't re-emit. Listen
    // at the WINDOW in capture phase — the DOM's ground truth about fingers —
    // and heal: all fingers up → commit the release exactly like pointerup
    // would have; a NEW first finger while a stale hold is armed → drop the
    // stale hold so the fresh tap (dispatched right after capture) wins.
    // (The frame-loop isDown self-heal in predictAndSend covers the paths
    // where Phaser itself processed the loss.)
    const touchAllUp = (e: TouchEvent) => {
      if (this.holdPointerId !== null && e.touches.length === 0) this.commitReleaseHold();
    };
    const touchFresh = (e: TouchEvent) => {
      if (this.holdPointerId !== null && e.touches.length === 1) this.dropHold();
    };
    window.addEventListener("touchend", touchAllUp, { capture: true, passive: true });
    window.addEventListener("touchcancel", touchAllUp, { capture: true, passive: true });
    window.addEventListener("touchstart", touchFresh, { capture: true, passive: true });
    this.events.once("shutdown", () => {
      window.removeEventListener("touchend", touchAllUp, { capture: true } as any);
      window.removeEventListener("touchcancel", touchAllUp, { capture: true } as any);
      window.removeEventListener("touchstart", touchFresh, { capture: true } as any);
    });

    // Chat: Enter opens the input; while typing, Phaser keyboard is disabled so
    // movement keys don't leak through, and re-enabled when the box closes.
    this.chat = new ChatUI(
      (text) => this.room?.send("chat", { text }),
      () => (this.input.keyboard!.enabled = true),
    );
    this.input.keyboard!.on("keydown-ENTER", () => {
      if (!this.chat.open) {
        this.input.keyboard!.enabled = false;
        this.chat.openInput();
      }
    });
    // Jump (Space): edge-triggered, lets you cross a 1-level ledge if timed.
    this.input.keyboard!.on("keydown-SPACE", () => this.tryJump());
    // Feature/debug toggles: TOP-ROW digits on keyboard AND buttons in the
    // HUD's Settings tab (mobile has no keys; maintainer moved them there —
    // the old chat welcome overlay listing the keys is gone).
    const sync = (fn: () => void) => () => {
      fn();
      this.hud?.refreshSettings(); // keys flip the same state the switches show
    };
    this.input.keyboard!.on("keydown-ONE", () => this.cycleTimeOfDay());
    this.input.keyboard!.on("keydown-FIVE", sync(() => this.toggleTorch()));
    this.input.keyboard!.on("keydown-SIX", sync(() => this.toggleBonfire()));
    this.input.keyboard!.on("keydown-SEVEN", sync(() => this.toggleWalls()));
    // Bottom HUD (the golden-ratio dock): framed tab row + content page; the
    // game viewport itself gets the matching pixel frame overlay.
    this.hud = new HudBar({
      onLogout: () => this.logout(),
      // The Chat page's bottom input sends through the SAME rate-limited path
      // as the on-screen chat box.
      onChat: (text) => this.room?.send("chat", { text }),
      // Backpack drag-out: client coords -> canvas coords -> world point ->
      // the server's "drop" (which clamps to a short reach + standable
      // ground, so the client conversion only has to be roughly right).
      onDropItem: (slot, item, cx, cy, n) => {
        if (!this.room) return;
        const rect = this.game.canvas.getBoundingClientRect();
        const px = ((cx - rect.left) / Math.max(1, rect.width)) * this.scale.width;
        const py = ((cy - rect.top) / Math.max(1, rect.height)) * this.scale.height;
        const wp = this.cameras.main.getWorldPoint(px, py);
        const g = this.pickGround(wp.x, wp.y);
        if (g) this.room.send("drop", { slot, item, n, wx: g.x, wy: g.y });
        else this.room.send("drop", { slot, item, n }); // void/solid target: at my feet
      },
      // A HUD modal is up (the drop-quantity dialog): FREEZE the player —
      // "when this dialog is open the player can't walk" (maintainer
      // 2026-08-05). Same gate the chat input uses (Phaser's keyboard, which
      // is also what the analog stick synthesizes into), plus a reset so a
      // key held at the moment it opened can't stick, and any autopilot trip
      // or hold in flight is dropped. The dialog's own backdrop swallows
      // taps, so tap-to-move can't start a new one either.
      onUiLock: (locked) => {
        // …and never hand the keys back to a chat box that is still typing.
        this.input.keyboard!.enabled = !locked && !this.chat?.open;
        this.uiLocked = locked;
        // Lift the pointer lock a beat AFTER the modal closes: the tap that
        // dismissed it is still being dispatched, and Phaser's window-level
        // listener sees it after the DOM handler that closed the dialog.
        if (!locked) {
          this.uiLockLiftAt = performance.now() + 150;
          return;
        }
        this.input.keyboard!.resetKeys();
        this.dropHold();
        this.clearMoveTarget();
      },
      settings: [
        // Time-of-day is the one plain BUTTON; the rest are switches
        // (down = ON) — no keyboard-digit prefixes (maintainer).
        {
          label: "time-of-day",
          act: () => this.cycleTimeOfDay(),
          hook: true,
          state: () => TIME_PHASES[this.timeIdx].name,
        },
        // The old freeze switch is now the SPEED cycler (maintainer): x0
        // freeze -> x0.5 -> x1 -> x2 -> x5 -> x10 -> back to x0; pressed
        // look while frozen.
        {
          label: "time speed",
          act: () => this.room?.send("timespeed", {}),
          get: () => this.timeSpeed === 0,
          state: () => (this.timeSpeed === 0 ? "frozen" : `x${this.timeSpeed}`),
        },
        {
          label: "weather",
          act: () => this.room?.send("weather"),
          state: () => WEATHER_NAMES[this.weatherIdx % WEATHER_NAMES.length],
        },
        // Audio (composer agent): master sound + music, persisted switches.
        { label: "sound", act: () => gameAudio.toggleSound(), get: () => gameAudio.soundEnabled },
        { label: "music", act: () => gameAudio.toggleMusic(), get: () => gameAudio.musicEnabled },
        // Maintainer's A/B test switch: raw audio files, zero composer
        // processing — pins a bad sound on the asset or on the composer.
        {
          label: "enforce unmodified audio",
          act: () => gameAudio.togglePure(),
          get: () => gameAudio.pureEnabled,
        },
        { label: "respawn", act: () => this.room?.send("respawn") },
        { label: "torch", act: () => this.toggleTorch(), get: () => this.torchOn },
        { label: "bonfire", act: () => this.toggleBonfire(), get: () => this.fireOn },
        { label: "see-through walls", act: () => this.toggleWalls(), get: () => this.occFadeOn },
        // Monster spawn zones (maps2 spawns@1) — a DEBUG overlay, off by
        // default (maintainer 2026-07-30: "not visible by default").
        { label: "spawn areas", act: () => this.toggleSpawnAreas(), get: () => this.spawnAreasOn },
        // Aggro radii (combat round 2) — DEBUG rings, off by default: red =
        // a predator's proximity radius, gold = the provoke radius on the
        // sword-marked target.
        { label: "aggro radius", act: () => this.toggleAggroRadius(), get: () => this.aggroRadiusOn },
        {
          label: "overlay",
          act: () => this.setOverlay((this.overlayIdx + 1) % OVERLAYS.length),
          get: () => this.overlayIdx !== 0,
          state: () => OVERLAYS[this.overlayIdx].name,
        },
      ],
    });
    mountPageFrame();
    // Feed EVERY on-screen log line into the Chat page's persistent history
    // (system events + other players' chat — the same stream, kept 1000 deep).
    this.chat.onLog = (name, text) => this.hud?.pushChat(name, text);

    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.iso.w, this.iso.h);
    // Integer zoom (crisp nearest-neighbour pixels) chosen so the VISIBLE
    // WORLD WIDTH is ~520 world-px regardless of the CSS viewport. This
    // neutralizes mobile Chrome's "Desktop site" toggle for the canvas: a
    // phone viewport (~412px) gets zoom 1 and desktop-site/desktop (~980-
    // 1100px) gets zoom 2 — the same amount of world either way (the
    // maintainer's preferred, slightly zoomed-out framing on phones).
    cam.setZoom(this.zoomFor());
    cam.setBackgroundColor(this.world ? "#181c28" : "#1b3327");

    setLoadingProgress(0.95, "Connecting…");
    try {
      this.bindRoom(
        await joinWorld(
          { name: this.myName, character: this.myCharacter.uid, world: this.worldName },
        ),
      );
      // The world is live: bring in the score + let the composer sample the
      // terrain mood (forest/water/town/fire beds) around the player.
      gameAudio.startMusic();
      gameAudio.setFieldSampler(() => this.sampleAudioField());
    } catch (err) {
      hideLoading(true); // instant — the error panel must not wait behind the cinematic fade
      this.showConnectionError(err);
      return;
    }
    window.addEventListener("pagehide", () => (this.unloading = true), { once: true });

    // Debug hooks for headless end-to-end verification.
    (window as any).__ml = {
      players: () => this.avatars.size,
      myId: () => this.room?.sessionId,
      liveTuning: () => liveTuningSnapshot(),
      // Live feed for the HUD Map tab (hud.ts polls per rAF): the current world
      // id + grid size (cells) and the LOCAL player's SMOOTH predicted cell —
      // av.fx/fy is the same client-predicted position the sprite + coord label
      // use, so the minimap dot tracks the avatar (using me()/server 20Hz state
      // instead would stutter). col=fx/CELL_WU, row=fy/CELL_WU.
      minimap: () => {
        const av = this.avatars.get(this.room?.sessionId ?? "");
        const w = this.world;
        const col = av ? av.fx / CELL_WU : 0;
        const row = av ? av.fy / CELL_WU : 0;
        // The minimaps are ISO renders (maps2 render_overview), so hud.ts needs
        // maxL (the render origin lifts by the world's tallest level) and the
        // player's own cell level (the iso dot lifts with the terrain it stands
        // on). Clamp the cell index — fx/fy can ease a hair past the rim.
        const ci = w ? Math.max(0, Math.min(w.width - 1, Math.floor(col))) : 0;
        const ri = w ? Math.max(0, Math.min(w.height - 1, Math.floor(row))) : 0;
        return {
          world: this.worldName,
          w: w?.width ?? 0,
          h: w?.height ?? 0,
          maxL: this.maxLevel,
          col,
          row,
          level: w?.rows[ri]?.[ci]?.l ?? 0,
        };
      },
      // world@2 decks: parsed summary + cells indexed for the ground/occluder loop.
      deckInfo: () => ({
        decks: (this.world?.decks ?? []).map((d) => ({ kind: d.kind, mat: d.mat, level: d.level, thickness: d.thickness, cells: d.cells.length })),
        indexed: this.deckIndex.size,
      }),
      // Per-deck render diagnosis: how many cells have a VOID base (deck skipped
      // by the void `continue`), a missing deck-top texture, or render OK.
      deckDiag: () => {
        const w = this.world;
        if (!w) return null;
        return (w.decks ?? []).map((d) => {
          let voidBase = 0, deckTopMissing = 0, ok = 0;
          for (const c of d.cells) {
            const base = w.rows[c.row]?.[c.col];
            const bk = base ? topKeyFor(base) : null;
            const baseVoid = !bk || !this.textures.exists(bk);
            const dt = c.path ? pathTileKey(c.path) : null;
            const dtMissing = !dt || !this.textures.exists(dt);
            if (baseVoid) voidBase++;
            if (dtMissing) deckTopMissing++;
            if (!baseVoid && !dtMissing) ok++;
          }
          return { kind: d.kind, level: d.level, cells: d.cells.length, voidBase, deckTopMissing, ok };
        });
      },
      myX: () => {
        const id = this.room?.sessionId;
        const av = id ? this.avatars.get(id) : undefined;
        return av ? av.sprite.x : null;
      },
      myCharacter: () => {
        const id = this.room?.sessionId;
        const av = id ? this.avatars.get(id) : undefined;
        return av ? av.character : null;
      },
      say: (text: string) => this.room?.send("chat", { text }),
      // Chat-page QA: push a history line directly (bypassing the server), at an
      // optional controlled receive-time (ms epoch) so the day-divider + cap
      // logic can be verified deterministically. verify-chatpage.mjs drives this.
      chatPush: (name: string, text: string, tMs?: number) =>
        this.hud?.pushChat(name, text, tMs != null ? new Date(tMs) : undefined),
      // Debug: occluder build state (maps2 z-order verification).
      occCount: () => ({
        maps2: this.maps2,
        occluders: this.occluders.length,
        meta: this.occluderMeta.length,
        culled: this.occCulled,
      }),
      // CULL AUDIT (perf #2/#3). Checks the built occluder set against
      // Phaser's OWN bounds and the camera's OWN worldView — never against
      // the cull arithmetic in rebuildOccluders, so a wrong formula there
      // cannot agree with itself.
      //   offScreenBuilt  — images we built that don't touch the view (waste,
      //                     harmless; the pad guarantees some of this)
      //   metaWithoutArt  — cells whose meta says the column overlaps the
      //                     view but which contributed NO image. This is the
      //                     one that can be a BUG: resolveBodyDepth would
      //                     clamp/crop a body against terrain that the
      //                     occluder layer no longer draws.
      occAudit: () => {
        const v = this.cameras.main.worldView;
        let onScreen = 0;
        let offScreenBuilt = 0;
        for (const o of this.occluders) {
          const b = o.getBounds();
          if (b.right >= v.x && b.x <= v.right && b.bottom >= v.y && b.y <= v.bottom) onScreen++;
          else offScreenBuilt++;
        }
        // Which cells actually got at least one image this rebuild?
        const drawn = new Set<number>();
        for (const o of this.occluders) {
          const c = o.getData("oc") as number | undefined;
          const r = o.getData("or") as number | undefined;
          if (c !== undefined && r !== undefined) drawn.add(r * 100000 + c);
        }
        let metaWithoutArt = 0;
        let propMeta = 0;
        const offenders: Array<Record<string, number>> = [];
        for (const m of this.occluderMeta) {
          if (m.x1 < v.x || m.x0 > v.right || m.y1 < v.y || m.y0 > v.bottom) continue;
          // PROPS (solid) live in `propImgs`, never in `occluders`, and are
          // not touched by the cull — their meta legitimately has no occluder
          // image, so they are not offenders.
          if (m.solid) {
            propMeta++;
            continue;
          }
          if (drawn.has(m.row * 100000 + m.col)) continue;
          metaWithoutArt++;
          if (offenders.length < 5) offenders.push({ col: m.col, row: m.row, top: m.top });
        }
        return {
          built: this.occluders.length,
          culled: this.occCulled,
          onScreen,
          offScreenBuilt,
          meta: this.occluderMeta.length,
          metaWithoutArt,
          propMeta,
          offenders,
        };
      },
      bubbles: () => [...this.avatars.values()].filter((a) => a.bubble).map((a) => a.bubble!.text),
      jump: () => this.tryJump(),
      // Tap-to-move probes: set/inspect the autopilot target directly, and
      // run the same screen-point picking a real tap uses. A tap on a world cell
      // that carries a deck (bridge/roof) targets the DECK — same as a real
      // screen-tap's pickGround, so headless tests can drive deck routes.
      tapTo: (x: number, y: number, run = false) => {
        const col = Math.floor(x / CELL_WU);
        const row = Math.floor(y / CELL_WU);
        const deckL = this.terrain && this.world ? this.terrain.deck[row * this.world.width + col] : -1;
        return this.setMoveTarget(x, y, !!run, false, deckL >= 0 ? deckL : undefined);
      },
      target: () => this.trip?.target ?? null,
      path: () => this.trip?.path ?? [],
      navLog: (n = 40) => this.navLog.slice(-n),
      // Destination marker probe: world+screen position while a trip is live.
      marker: () => {
        const m = this.tapMarker;
        if (!m) return null;
        const cam = this.cameras.main;
        return {
          x: m.x,
          y: m.y,
          sx: (m.x - cam.worldView.x) * cam.zoom,
          sy: (m.y - cam.worldView.y) * cam.zoom,
          alpha: m.alpha,
          visible: m.visible,
        };
      },
      // 5x5 cell dump around a world point (solid/level) — stall forensics.
      gridAround: (x: number, y: number, r = 2) => {
        if (!this.terrain) return null;
        const g = this.terrain;
        const c0 = Math.floor(x / CELL_WU);
        const r0 = Math.floor(y / CELL_WU);
        const rows: string[] = [];
        for (let rr = r0 - r; rr <= r0 + r; rr++) {
          let line = "";
          for (let cc = c0 - r; cc <= c0 + r; cc++) {
            if (cc < 0 || rr < 0 || cc >= g.width || rr >= g.height) {
              line += "  ?";
              continue;
            }
            const i = rr * g.width + cc;
            const cx = (cc + 0.5) * CELL_WU;
            const cy = (rr + 0.5) * CELL_WU;
            const s = surfaceAtWorld(g, cx, cy);
            const solid = g.blocked[i] || (!s.standable && !s.swimmable);
            line += solid ? "  #" : ` ${String(g.level[i]).padStart(2)}`;
          }
          rows.push(line);
        }
        return { c0, r0, rows };
      },
      pickAt: (wx: number, wy: number) => this.pickGround(wx, wy),
      // What a tap at these WORLD (iso screen-space) coords would select —
      // the exact hit test pointerdown runs (round 12 hitbox QA).
      tapAt: (wx: number, wy: number) => this.tapTarget(wx, wy),
      camZoom: () => this.cameras.main.zoom,
      sunInfo: () => ({ sun: [...this.curSun], phase: TIME_PHASES[this.timeIdx].name, t: this.timeT }),
      // Weather probes: info + LOCAL force (headless QA without the server).
      weatherInfo: () => ({
        idx: this.weatherIdx,
        name: WEATHER_NAMES[this.weatherIdx],
        cloud: this.curCloud,
        mist: this.curMist,
        precipDim: this.curPrecipDim,
        precip: this.weatherFX?.info() ?? null,
      }),
      weather: (idx?: number, instant = true) => {
        if (idx !== undefined) {
          this.weatherIdx = idx % WEATHER_COUNT;
          if (instant) {
            this.curCloud = WEATHER_CLOUD[this.weatherIdx] ?? 0;
            this.curMist = this.weatherIdx === 2 ? 1 : 0;
            this.curPrecipDim = WEATHER_DIM[this.weatherIdx] ?? 0;
            this.weatherFX?.snap();
          }
        }
        return this.weatherIdx;
      },
      cloudAt: (wx: number, wy: number) => this.night?.cloudFactorAt(wx, wy, this.curCloud, this.curSun[3]) ?? 1,
      mistAt: (wx: number, wy: number) => this.night?.mistAt(wx, wy, this.curMist) ?? 0,
      // Is the ground drawn at this world/screen point open water? (snow-melt QA)
      waterAtScreen: (wx: number, wy: number) => this.isWaterAtScreen(wx, wy),
      // Is it walkable dry TOP ground (not a cliff face / water)? (ambient bird landing)
      landableAtScreen: (wx: number, wy: number) => this.landableAtScreen(wx, wy),
      // Camera world-view rect (QA: sample effects across the visible world).
      camView: () => {
        const w = this.cameras.main.worldView;
        return { x: w.x, y: w.y, w: w.width, h: w.height };
      },
      // Footstep-mark probes: live count + per-mark world pos/style.
      footprints: () => this.footsteps?.count() ?? 0,
      footprintsList: () => this.footsteps?.list() ?? [],
      // My avatar's on-screen position (CSS px) — anchors QA screenshot crops.
      myScreen: () => {
        const av = this.avatars.get(this.room?.sessionId ?? "");
        if (!av) return null;
        const cam = this.cameras.main;
        return {
          sx: (av.sprite.x - cam.worldView.x) * cam.zoom,
          sy: (av.sprite.y - cam.worldView.y) * cam.zoom,
          zoom: cam.zoom,
        };
      },
      // World-state setters (games-ambient's demo button): jump the SHARED
      // time/weather straight to a value via the messages' {v} extension —
      // without {v} those messages keep their legacy cycle semantics.
      worldTime: (idx: number) => this.room?.send("timeofday", { v: idx }),
      worldWeather: (idx: number) => this.room?.send("weather", { v: idx }),
      star: (name?: string) => this.shootingStar(name), // LOCAL trigger for headless QA
      aurora: (on?: boolean, instant = true) => {
        if (on !== undefined) {
          this.auroraOn = on;
          if (instant) this.curAurora = on ? 1 : 0;
        }
        return this.curAurora;
      },
      auroraAt: (wx: number, wy: number) => this.night?.auroraAt(wx, wy, this.curAurora, this.curSun[3]) ?? [0, 0, 0],

      sunAt: (col: number, row: number, z = -1) =>
        this.night?.sunFactorAt(col + 0.5, row + 0.5, z, this.curSun as [number, number, number, number]) ?? 1,
      // Elevation depth-fog: set the master strength (0 = off) for tuning /
      // rollback; returns the current value + the player's level driving it.
      depthFog: (v?: number, testZ?: number, testCol?: number, testRow?: number) => {
        if (this.night && typeof v === "number") this.night.fogStrength = Math.max(0, v);
        if (this.night && testZ !== undefined) this.night.fogTestZ = testZ === -1 ? null : testZ;
        if (this.night && testCol !== undefined && testRow !== undefined)
          this.night.fogTestXY = testCol === -1 ? null : [testCol, testRow];
        const av = this.avatars.get(this.room?.sessionId ?? "");
        return {
          strength: this.night?.fogStrength ?? 0,
          testZ: this.night?.fogTestZ ?? null,
          testXY: this.night?.fogTestXY ?? null,
          playerZ: av ? +Math.max(0, av.elev / MAP_GEOMETRY.lh).toFixed(2) : 0,
        };
      },
      // Local avatar's lit-copy light sample. `l` is what SHIPS: the light at
      // the avatar's RENDERED surface height (a.elev px → levels), so a deck top
      // (roof/bridge) is lit. `lBase` is the OLD base-terrain sample — dark under
      // a roof. QA for the "character shaded on the roof in daylight" deck bug.
      litInfo: () => {
        const av = this.avatars.get(this.room?.sessionId ?? "");
        if (!av || !this.night) return null;
        const rendLvl = Math.max(0, av.elev / MAP_GEOMETRY.lh); // sunk while swimming
        const litLvl = this.litLevelOf(av); // where lighting SHIPS (surface when swimming)
        const baseLvl = this.terrain ? levelAtWorld(this.terrain, av.fx, av.fy) : 0;
        return {
          elevLvl: +litLvl.toFixed(2),
          rendLvl: +rendLvl.toFixed(2), // the sunk render elevation (swimming)
          surfLevel: av.surfLevel ?? null,
          swimming: av.swimming,
          baseLvl,
          // l = what SHIPS (sampled at litLvl); lSunk = the OLD buggy sample at the
          // sunk render elevation; lBase = base-terrain sample (deck QA).
          l: this.night.lightAt(av.fx / CELL_WU, av.fy / CELL_WU, litLvl, false).map((v) => +v.toFixed(3)),
          lSunk: this.night.lightAt(av.fx / CELL_WU, av.fy / CELL_WU, rendLvl, false).map((v) => +v.toFixed(3)),
          lBase: this.night.lightAt(av.fx / CELL_WU, av.fy / CELL_WU, baseLvl, false).map((v) => +v.toFixed(3)),
        };
      },
      // What terrain is currently COVERING my avatar — `coverY` is the wall/
      // slab top line that crops the lit copy, and it is set purely from
      // occluderMeta by resolveBodyDepth. This is the invariant the occluder
      // cull must not break: standing UNDER a deck (cave slab, bridge) or
      // behind a cliff must still report a cover line.
      myCover: () => {
        const av = this.avatars.get(this.room?.sessionId ?? "");
        if (!av) return null;
        return {
          coverY: av.coverY ?? null,
          depth: +av.sprite.depth.toFixed(1),
          elev: +(av.elev / MAP_GEOMETRY.lh).toFixed(2),
          litVisible: av.lit ? av.lit.visible : null,
          litCropped: av.lit ? !!av.lit.isCropped : null,
        };
      },
      // Chase-cam probe: eased zoom vs base, and how far the camera trails
      // the avatar (scene px).
      camInfo: () => {
        const id = this.room?.sessionId;
        const av = id ? this.avatars.get(id) : undefined;
        const cam = this.cameras.main;
        const cx = cam.worldView.centerX; // zoom-correct world centre
        const cy = cam.worldView.centerY;
        return {
          zoom: cam.zoom,
          base: this.zoomFor(),
          trail: av ? Math.hypot(av.sprite.x - cx, av.sprite.y - cy) : null,
          detached: this.camDetached,
        };
      },
      // Playback rate of a built animation (anti-moonwalk verification).
      animRate: (uid: string, state: string, dir: string) =>
        this.anims.get(animKey(uid, state, dir))?.frameRate ?? null,
      // Frame-QA cover: flat-colour the game render so the HUD frame can be
      // screenshot-compared against the concept art without world noise
      // (maintainer's suggestion). Cycles NONE/BLACK/WHITE/PINK; pass an
      // index (or true = black) to jump straight to a state.
      blackout: (on: number | boolean = true) =>
        this.setOverlay(typeof on === "number" ? on : on ? 1 : 0),
      // Live gait-sync probes: my avatar's playback timeScale (rate ∝ speed)
      // and the EMA'd WORLD-units ground speed it derives from (wu/s).
      timeScale: () => this.avatars.get(this.room?.sessionId ?? "")?.sprite.anims.timeScale ?? null,
      worldSpeed: () => this.avatars.get(this.room?.sessionId ?? "")?.spdWu ?? null,
      // One-call sample for the gait-sync probe (verify-gaitsync): the EASED
      // sprite ground position (scene px at zoom 1 — what the eye sees), the
      // flat WORLD position, the playing clip and its 0-based frame index.
      // Sampled per rAF; offline it gates world-ground-per-cycle and measures
      // planted-foot slip against the art offsets ("moonwalk meter").
      gaitSample: () => {
        const av = this.avatars.get(this.room?.sessionId ?? "");
        if (!av) return null;
        return {
          sx: av.lx,
          sy: av.lyFlat,
          wx: av.fx,
          wy: av.fy,
          anim: av.sprite.anims.getName(),
          frame: (av.sprite.anims.currentFrame?.index ?? 0) - 1, // Phaser is 1-based
          originX: av.sprite.originX,
        };
      },
      // Kill the websocket (headless probe for the dead-connection recovery).
      dropConnection: () => {
        const conn = (this.room as unknown as { connection?: { close?: () => void; transport?: { close?: () => void } } })
          ?.connection;
        (conn?.close ?? conn?.transport?.close)?.call(conn?.close ? conn : conn?.transport);
      },
      // Occlusion-fade debug: force the fade focus to a cell (null → follow the
      // player), and toggle the feature. Lets headless probes frame the effect.
      occFocus: (col?: number, row?: number) => {
        this.occFocus = col === undefined || row === undefined ? null : { col, row };
        return this.occFocus;
      },
      occFade: (on?: boolean) => {
        if (on !== undefined) this.occFadeOn = on;
        return this.occFadeOn;
      },
      // Force one fade pass now (headless render loop is throttled) and report
      // how many occluders were tagged vs ghosted-to-black.
      worldInfo: () => {
        let maxL = 0;
        if (this.world) for (const r of this.world.rows) for (const c of r) if (c.l > maxL) maxL = c.l;
        return { name: this.worldName, maps2: this.maps2, w: this.world?.width, h: this.world?.height, maxL };
      },
      occApply: () => {
        this.lastReveal = { x: NaN, y: NaN, cx: NaN, cy: NaN }; // force a reveal redraw
        this.updateOcclusionFade();
        const fc = this.occFocus;
        let fLevel = null,
          ghosted = 0;
        for (const o of this.occluders) if (o.getData("oc") !== undefined && o.depth < -1000) ghosted++;
        if (fc && this.world) fLevel = this.world.rows[fc.row]?.[fc.col]?.l ?? 0;
        return { occluders: this.occluders.length, ghosted, revealVisible: !!this.occRevealRT?.visible, focus: fc, fLevel };
      },
      // Would auto-jump fire from world (x,y) moving in screen dir (ax,ay)?
      // Headless probe for the auto-hop rule against real map geometry.
      autoJumpAt: (x: number, y: number, ax: number, ay: number) => this.wouldAutoJump(x, y, ax, ay),
      // Steer-assist probe: what would direct input (ax,ay) at world (x,y)
      // deflect to (null = no assist)? Headless QA for the prop corner-dodge.
      steerAt: (x: number, y: number, ax: number, ay: number) =>
        this.terrain ? steerAssist(this.terrain, x, y, ax, ay) : null,
      // Current animation key of the local avatar's sprite — headless probe for
      // verifying state selection (jump vs gaits).
      anim: () => {
        const id = this.room?.sessionId;
        const av = id ? this.avatars.get(id) : undefined;
        return av ? av.sprite.anims.getName() : null;
      },
      // Local avatar fall state — headless probe for the cliff-fall animation.
      fall: () => {
        const id = this.room?.sessionId;
        const av = id ? this.avatars.get(id) : undefined;
        return av ? { falling: av.falling, elev: av.elev, fallV: av.fallV } : null;
      },
      me: () => this.room?.state.players.get(this.room!.sessionId),
      // Composer probes: engine state, the musical clock (beat/scale — what
      // beat-reactive visuals read), and a manual event trigger for QA.
      audio: () => gameAudio.debug(),
      audioClock: () => gameAudio.clock(),
      audioEvent: (name: string) => gameAudio.event(name),
      // Force a music bed to audition it: __ml.audioBed("battle"); no argument
      // hands control back to the situation. Returns what is playing + which
      // beds are actually bundled.
      audioBed: (name?: string) => gameAudio.auditionBed(name ?? null),
      // What the context score is reading from the world right now.
      audioField: () => this.sampleAudioField(),
      audioPure: () => {
        gameAudio.togglePure();
        this.hud?.refreshSettings();
        return gameAudio.pureEnabled;
      },
      // Fire the thunder rumble on demand (storms are rare episodes — this
      // lets QA/the maintainer hear it without waiting for the weather).
      audioThunder: (strength = 1) => gameAudio.thunder(strength),
      swimming: () => !!this.room?.state.players.get(this.room!.sessionId)?.swimming,
      myDispDir: () => this.avatars.get(this.room?.sessionId ?? "")?.dispDir ?? null,
      swimT: () => this.avatars.get(this.room?.sessionId ?? "")?.swimT ?? 0,
      // Hold-gesture/trip state — QA for the wedged-hold self-heal (a swallowed
      // pointerup must not leave holdPointerId armed forever).
      holdInfo: () => ({
        held: this.holdPointerId,
        ground: this.holdGround ? [this.holdGround.x, this.holdGround.y] : null,
        trip: this.trip ? { x: this.trip.target.x, y: this.trip.target.y } : null,
        marker: !!this.tapMarker,
      }),
      // QA-only: arm the exact WEDGED hold state a swallowed release leaves
      // behind (hold keyed to a pointer slot that is not down, stale ground
      // point at flat world (x,y)) — the frame-loop self-heal must clear it.
      wedgeHold: (x: number, y: number) => {
        this.holdPointerId = 1;
        this.holdGround = { x, y, lvl: this.terrain ? levelAtWorld(this.terrain, x, y) : 0 };
        this.holdRepathAt = 0;
      },
      swimDebug: () => {
        const av = this.avatars.get(this.room?.sessionId ?? "");
        if (!av) return null;
        const sp = av.sprite;
        const dir = av.dispDir ?? DEFAULT_DIRECTION;
        const { def, s } = this.waterlineFor(av.character, dir);
        const fw = def?.frameW ?? sp.frame.realWidth;
        const fh = def?.frameH ?? sp.frame.realHeight;
        const cam = this.cameras.main;
        const toScreen = (fx: number, fy: number) => ({
          x: (sp.x + (fx * fw - sp.originX * fw) * sp.scaleX - cam.worldView.x) * cam.zoom,
          y: (sp.y + (fy * fh - sp.originY * fh) * sp.scaleY - cam.worldView.y) * cam.zoom,
        });
        return {
          dir,
          swimT: av.swimT,
          // Render lift QA (elevated-pool float): elev must settle at the
          // POOL surface (surfLevel·lh) − swimDrop, not at absolute −swimDrop.
          elev: av.elev,
          lyFlat: av.lyFlat,
          ly: av.ly,
          L: toScreen(s.lx, s.ly),
          R: toScreen(s.rx, s.ry),
          frame: { cutX: sp.frame.cutX, cutY: sp.frame.cutY, cutW: sp.frame.cutWidth, cutH: sp.frame.cutHeight, realW: sp.frame.realWidth, realH: sp.frame.realHeight },
          origin: { x: sp.originX, y: sp.originY },
          scale: { x: sp.scaleX, y: sp.scaleY },
          def: { fw, fh },
        };
      },
      surfaceAt: (x: number, y: number) => (this.terrain ? surfaceAtWorld(this.terrain, x, y) : null),
      blockedAt: (x: number, y: number) => (this.terrain ? isBlockedAtWorld(this.terrain, x, y) : null),
      propCount: () => this.propImgs.length,
      // Sample the CPU light (what a character's lit copy is tinted by) at a
      // grid cell — headless probe for emission monotonicity/colour.
      lightAtCell: (col: number, row: number, z = 0) =>
        this.night ? this.night.lightAt(col, row, z, false) : null,
      // Light + depth-fog for an ambient flyer at iso-screen ground point (gx,gy)
      // lifted alt px — face-aware inverse + altitude-aware sample (see critterLight).
      critterLight: (gx: number, gy: number, alt: number) => this.critterLight(gx, gy, alt),
      levelAt: (x: number, y: number) => (this.terrain ? levelAtWorld(this.terrain, x, y) : 0),
      nightShader: () => !!this.night && this.night.active,
      // Get/set the time-of-day phase (by index or name); instant when set —
      // headless probes sample grades without waiting out the transition.
      // `phaseT` pins the progress WITHIN the phase (default 0.5 = the phase's
      // calibrated keyframe, which every grade gate samples); pass 0/1 to park
      // the world clock exactly on a phase boundary — that's how the clock
      // gate checks the sun and moon cross sunset/sunrise continuously.
      timeOfDay: (which?: number | string, instant = true, phaseT = 0.5) => {
        if (which !== undefined) {
          const idx =
            typeof which === "number"
              ? which % TIME_PHASES.length
              : TIME_PHASES.findIndex((p) => p.name.toLowerCase() === String(which).toLowerCase());
          if (idx >= 0) this.setTimeOfDay(idx, instant, phaseT);
        }
        const ha = handAngle(this.timeIdx + this.phaseT);
        return {
          name: TIME_PHASES[this.timeIdx].name,
          t: this.timeT,
          ambient: [...this.curAmbient],
          phaseT: this.phaseT,
          f: ha.f,
          night: ha.night,
        };
      },
      // Get/set the WORLD clock speed — the same "timespeed" message the
      // Settings button sends, but to an exact value. Every phase-PINNED gate
      // needs x0 first: since time started running at x1 by default the server
      // patches phaseT continuously, which overwrites a probe's pinned
      // keyframe within a frame or two (it used to stick because the boot
      // default was frozen).
      timeSpeed: (v?: number) => {
        if (typeof v === "number") this.room?.send("timespeed", { v });
        return this.timeSpeed;
      },
      // Get/set handedness (controls.ts) — the same toggle the Settings
      // "controls" button drives; setting re-anchors the layout via the
      // "ml-hand" event. QA hook for the landscape gate.
      hand: (h?: "right" | "left") => (h ? setHand(h) : getHand()),
      // Place/clear a debug light at a grid position (headless probes).
      probeLight: (col?: number, row?: number, z = 0.55, radius = 8) => {
        this.probeLight =
          col === undefined || row === undefined
            ? null
            : { col, row, z, radius, color: [1.5, 1.15, 0.85], flicker: 0 };
        return this.probeLight;
      },
      // Screen-space anchor of a cell's tile image (its 64px art box top-left)
      // + camera zoom — lets probes locate baked-lip rows in screenshots.
      cellScreen: (col: number, row: number) => {
        if (!this.world) return null;
        const { dx, dy, lh } = MAP_GEOMETRY;
        const cam = this.cameras.main;
        const cell = this.world.rows[row]?.[col];
        if (!cell) return null;
        const wx = this.iso.ox + (col - row) * dx;
        const wy = this.iso.oy + (col + row) * dy - cell.l * lh;
        return {
          x: (wx - cam.worldView.x) * cam.zoom,
          y: (wy - cam.worldView.y) * cam.zoom,
          zoom: cam.zoom,
          level: cell.l,
          t: cell.t,
          v: cell.v ?? 0,
        };
      },
      // Draw-order probe: base + lit-copy depths for me and the campfire, so
      // the lit layer's ordering can be asserted numerically (no screenshots).
      litOrder: () => {
        const id = this.room?.sessionId;
        const av = id ? this.avatars.get(id) : undefined;
        return {
          me: av ? { base: av.sprite.depth, lit: av.lit?.visible ? av.lit.depth : null } : null,
          fire: this.campfireSprite
            ? {
                base: this.campfireSprite.depth,
                lit: this.campfireLit?.visible ? this.campfireLit.depth : null,
              }
            : null,
        };
      },
      // Detach the camera and centre it on a cell (headless probes: emissive
      // sites sit far outside walking range on dt-clamped clients). No args
      // re-attaches the camera to the local player.
      // Demo mode: the station pois of the generated world.
      stations: () => this.world?.pois ?? [],
      // Demo mode: centre the camera on station n (from the world's pois).
      lookStation: (n: number) => {
        const poi = this.world?.pois.find((p) => parseInt(p.label, 10) === n);
        if (!poi) return null;
        (window as any).__ml.lookAt(poi.x, poi.y);
        return poi;
      },
      lookAt: (col?: number, row?: number) => {
        const cam = this.cameras.main;
        if (col === undefined || row === undefined) {
          this.camDetached = false;
          this.camChase.init = false; // snap back onto the avatar
          return null;
        }
        this.camDetached = true;
        const { dx, dy, lh } = MAP_GEOMETRY;
        const cell = this.world?.rows[row]?.[col];
        const wx = this.iso.ox + (col - row) * dx + dx;
        const wy = this.iso.oy + (col + row) * dy + dy - (cell?.l ?? 0) * lh;
        cam.centerOn(wx, wy);
        return { x: wx, y: wy, t: cell?.t ?? null, l: cell?.l ?? 0 };
      },
      // Teleport the player to an exact world coordinate — the SAME (col,row)
      // numbers shown under the avatar's name (fx/CELL_WU, fy/CELL_WU). Server-
      // authoritative, so this asks the room to move the player; the camera
      // re-attaches and snaps onto the avatar. Reproduce a spot from a screenshot:
      //   __ml.teleport(114.9, 13.7)  // e.g. the_island2 peak
      teleport: (col?: number, row?: number) => {
        if (col === undefined || row === undefined) return null;
        this.camDetached = false;
        this.camChase.init = false; // snap the camera back onto the avatar
        this.room?.send("teleport", { x: col * CELL_WU, y: row * CELL_WU });
        const cell = this.world?.rows[Math.floor(row)]?.[Math.floor(col)];
        return { col, row, sent: !!this.room, t: cell?.t ?? null, l: cell?.l ?? 0 };
      },
      // Flicker QA: terrain occluder TOPS whose drawn diamond covers a ground
      // point (gx,gy), with their depth — i.e. what could sort in FRONT of a
      // critter shadow placed there. The top image is drawn at y0 = by - l*lh
      // with the diamond APEX at y0 + dy (the art carries ~dy of padding above
      // the apex), spanning 2*dy — gate on the real diamond rows, not the image
      // box, or padding rows read as phantom cover. Sorted front-most first.
      shadowCover: (gx: number, gy: number) => {
        const dy = MAP_GEOMETRY.dy;
        return this.occluderMeta
          .filter((o) => gx >= o.x0 && gx <= o.x1 && gy >= o.y0 + dy - 2 && gy <= o.y0 + dy * 3 + 2)
          .map((o) => ({ col: o.col, row: o.row, top: o.top, depth: Math.round(o.depth), y0: Math.round(o.y0) }))
          .sort((a, b) => b.depth - a.depth);
      },
      // My sprite depth vs every occluder column near it — z-order probes.
      depthProbe: () => {
        const id = this.room?.sessionId;
        const av = id ? this.avatars.get(id) : undefined;
        if (!av) return null;
        const s = av.sprite;
        const x0 = s.x - s.displayWidth / 2, x1 = s.x + s.displayWidth / 2;
        const y0 = s.y - s.displayHeight, y1 = s.y;
        return {
          me: { depth: s.depth, fx: av.fx, fy: av.fy, coverY: av.coverY ?? null },
          near: this.occluderMeta
            .filter((o) => !(o.x1 < x0 || o.x0 > x1 || o.y1 < y0 || o.y0 > y1))
            .map((o) => ({ col: o.col, row: o.row, depth: o.depth, top: o.top })),
        };
      },
      nightInfo: () => this.night?.debugInfo(),
      // Where the spawn bonfire ended up, and how far that is from the world's
      // declared spawn cell — the "is the home fire actually at home" probe.
      campfireInfo: () => {
        if (!this.campfire || !this.world) return null;
        const sp = this.world.spawn ?? null;
        return {
          col: this.campfire.col,
          row: this.campfire.row,
          z: this.campfire.z,
          spawn: sp,
          distCells: sp ? +Math.hypot(this.campfire.col - sp[0], this.campfire.row - sp[1]).toFixed(2) : null,
        };
      },
      // Spawn-zone debug overlay: toggle + inspect. `corner(c,r)` returns the
      // SCREEN point the overlay draws a tile corner at, so a probe can compare
      // it with cellScreen() (the tile art box) without a screenshot.
      spawnOverlay: (on?: boolean) => {
        if (on !== undefined) this.toggleSpawnAreas(on);
        return {
          on: this.spawnAreasOn,
          zones: this.spawnZones?.length ?? null,
          corner: (c: number, r: number) => {
            const p = this.projectZoneCorner(c, r);
            const cam = this.cameras.main;
            return { x: (p.x - cam.worldView.x) * cam.zoom, y: (p.y - cam.worldView.y) * cam.zoom };
          },
        };
      },
      // The input vector actually predicted+sent this frame (AFTER the
      // monster-dodge deflection) — dodge QA reads the deflection live.
      lastInput: () => this.lastInput,
      // Monster render-state probe (shared body pipeline QA): per monster the
      // resolved depth, cover line, shadow anchor and lit-copy state.
      monsterInfo: () =>
        [...this.monsters.entries()].map(([id, mv]) => ({
          id,
          kind: mv.kind,
          col: +(mv.fx / CELL_WU).toFixed(2),
          row: +(mv.fy / CELL_WU).toFixed(2),
          surfLevel: mv.surfLevel ?? null,
          depth: +mv.sprite.depth.toFixed(1),
          coverY: mv.coverY !== undefined ? Math.round(mv.coverY) : null,
          shadow: {
            x: Math.round(mv.shadow.x),
            y: Math.round(mv.shadow.y),
            depth: +mv.shadow.depth.toFixed(1),
            w: mv.shadowW,
            h: mv.shadowH,
          },
          originX: +mv.sprite.originX.toFixed(3),
          originY: +mv.sprite.originY.toFixed(3),
          // The measured ground contract for the CURRENT facing (per-dir feet
          // line/foot centre/parked contact frame) — null = manifest gap.
          ground: mv.ground?.[mv.dispDir] ?? null,
          dir: mv.dispDir,
          frame: mv.sprite.frame.name,
          radius: mv.radius,
          hover: mv.hoverPx,
          lit: mv.lit
            ? { visible: mv.lit.visible, tint: mv.lit.tintTopLeft.toString(16), alpha: +mv.lit.alpha.toFixed(3) }
            : null,
          // Animation state — a headless probe CAN catch "moving but frozen"
          // (screenshots can't distinguish a stuck walk from freeze-frame idle).
          anim: mv.sprite.anims.getName() || null,
          playing: mv.sprite.anims.isPlaying,
          tex: mv.sprite.texture.key,
          // Camera-gated (off-screen): its pipeline is parked this frame, so
          // `playing`/`depth`/`lit` are deliberately stale — QA must skip it.
          culled: !!mv.culled,
          // Combat mirrors (verify-combat drives fights through these).
          x: mv.fx,
          y: mv.fy,
          // The DRAWN sprite in iso screen-space (what tapAt compares
          // against) + its display box — round-12 hitbox QA aims with these.
          sx: mv.sprite.x,
          sy: mv.sprite.y,
          dw: mv.sprite.displayWidth,
          dh: mv.sprite.displayHeight,
          lx: mv.lx,
          hp: (this.room?.state as any)?.monsters?.get(id)?.hp ?? null,
          hpMax: (this.room?.state as any)?.monsters?.get(id)?.hpMax ?? null,
          level: (this.room?.state as any)?.monsters?.get(id)?.level ?? null,
          aggro: (this.room?.state as any)?.monsters?.get(id)?.aggro ?? null,
          mstate: mv.mstate ?? "roam",
          hpBar: !!mv.hpBg?.visible,
          hpBarText:
            mv.lvText?.visible && mv.hpText?.visible ? `${mv.lvText.text}|${mv.hpText.text}` : null,
          // the three-line readout, for the gate: name OVER the bar, Lv + hp
          // UNDER it (each as [text, x, y] so the alignment is checkable)
          readout:
            mv.hpBg?.visible && mv.nameText && mv.lvText && mv.hpText
              ? {
                  name: [mv.nameText.text, Math.round(mv.nameText.x), Math.round(mv.nameText.y)],
                  lv: [mv.lvText.text, Math.round(mv.lvText.x), Math.round(mv.lvText.y)],
                  hp: [mv.hpText.text, Math.round(mv.hpText.x), Math.round(mv.hpText.y)],
                  bar: [Math.round(mv.hpBg.x), Math.round(mv.hpBg.y), Math.round(mv.hpBg.width)],
                }
              : null,
        })),
      // The target overlays, for the gate: the red monster borders (engaged +
      // hunters), the blue item border, whether a walk-to beacon is up, the
      // debug rings. (The in-fight hp/level readout is per monster —
      // monsterInfo().)
      targetOverlay: () => ({
        icon: !!(this.engagedId && this.monsterRings.get(this.engagedId)?.visible), // engaged border
        ringTint:
          this.engagedId && this.monsterRings.get(this.engagedId)?.visible
            ? TARGET_RING_COLOR
            : null,
        rings: [...this.monsterRings.values()].filter((r) => r.visible).length,
        itemRing: !!this.itemRingImg?.visible,
        itemRingTint: this.itemRingImg?.visible ? ITEM_RING_COLOR : null,
        beacon: !!this.tapMarker,
        engaged: this.engagedId,
        pendingPickup: this.pendingPickupId,
        aggroRings: this.aggroRadiusOn,
        loaderState: this.load.state,
      }),
      // Debug: the generated outline images' live state (rounds 10-11 QA).
      ringInfo: () => {
        const describe = (img?: Phaser.GameObjects.Image) => {
          if (!img) return null;
          const tex = this.textures.get(img.texture.key);
          const src = tex?.getSourceImage() as HTMLCanvasElement | undefined;
          let filled = -1;
          try {
            const c = src?.getContext?.("2d");
            if (c && src) {
              const d = c.getImageData(0, 0, src.width, src.height).data;
              filled = 0;
              for (let i = 3; i < d.length; i += 4) if (d[i] > 0) filled++;
            }
          } catch {
            /* not a canvas source */
          }
          return {
            key: img.texture.key,
            visible: img.visible,
            x: img.x,
            y: img.y,
            depth: img.depth,
            originX: img.originX,
            originY: img.originY,
            scaleX: img.scaleX,
            alpha: img.alpha,
            texW: src?.width ?? null,
            texH: src?.height ?? null,
            filled,
          };
        };
        return {
          monsters: Object.fromEntries(
            [...this.monsterRings.entries()].map(([id, img]) => [id, describe(img)]),
          ),
          item: describe(this.itemRingImg),
        };
      },
      toggleAggroRadius: (on?: boolean) => this.toggleAggroRadius(on),
      bloodFx: () => this.bloodSeen,
      graveCrosses: () =>
        this.graveCrosses.map((gc) => ({
          x: Math.round(gc.sprite.x),
          y: Math.round(gc.sprite.y),
          frame: gc.sprite.frame.name,
          playing: gc.sprite.anims.isPlaying,
          reversing: gc.reversing,
        })),
      // Glow-field RT orientation calibration (headless probes flip + verify).
      glowFlip: (v?: number) => {
        if (this.night && v !== undefined) this.night.glowFlip = v;
        return { flip: this.night?.glowFlip, stamps: this.glowStamps.length };
      },
      nightCal: (flip: number, span: number, test: number) => {
        if (!this.night) return null;
        this.night.fieldFlip = flip;
        this.night.spanScale = span;
        this.night.testPattern = test;
        return { flip, span, test };
      },
      // Roaming monsters (headless QA): live count + a dump of every rendered
      // monster's synced state, and the nearest monster to a world point.
      monsters: () => this.monsters.size,
      // CAMERA GATE state + a full AUDIT of the cull decision. `wrongCulled`
      // is the only number that can be a real BUG: a body Phaser's OWN
      // getBounds() says overlaps the camera's OWN worldView, yet we parked —
      // i.e. a monster that visibly popped out at the screen edge. It must be
      // 0. `wastedActive` is the harmless direction (gated in but off-screen);
      // it just costs a little. Audited against Phaser/camera geometry rather
      // than re-running the gate's own arithmetic, so a wrong formula in the
      // gate cannot agree with itself here.
      monsterGate: () => {
        const v = this.cameras.main.worldView;
        let culled = 0;
        let visibleCulled = 0;
        let animatingCulled = 0;
        let wrongCulled = 0;
        let wastedActive = 0;
        this.monsters.forEach((mv) => {
          const b = mv.sprite.getBounds();
          const sw = mv.shadow.displayWidth;
          const sh = mv.shadow.displayHeight;
          const x0 = Math.min(b.x, mv.sprite.x - sw / 2);
          const x1 = Math.max(b.right, mv.sprite.x + sw / 2);
          const y0 = Math.min(b.y, mv.sprite.y - sh / 2);
          const y1 = Math.max(b.bottom, mv.sprite.y + sh / 2);
          const hits = x1 >= v.x && x0 <= v.right && y1 >= v.y && y0 <= v.bottom;
          if (mv.culled) {
            culled++;
            if (mv.sprite.visible || mv.lit?.visible || mv.shadow.visible) visibleCulled++;
            if (mv.sprite.anims.isPlaying) animatingCulled++;
            if (hits) wrongCulled++;
          } else if (!hits) wastedActive++;
        });
        return {
          total: this.monsters.size,
          active: this.monstersActive,
          culled,
          visibleCulled,
          animatingCulled,
          wrongCulled,
          wastedActive,
          slack: MONSTER_CULL_SLACK,
        };
      },
      monstersDump: () => {
        const st = (this.room?.state as any)?.monsters;
        const out: Record<string, unknown>[] = [];
        this.monsters.forEach((mv, id) => {
          const m = st?.get(id);
          out.push({
            id,
            kind: mv.kind,
            x: m?.x ?? mv.fx,
            y: m?.y ?? mv.fy,
            dir: m?.dir ?? mv.dispDir,
            moving: !!m?.moving,
            elev: m?.elev ?? 0,
          });
        });
        return out;
      },
      monsterAt: (x: number, y: number) => {
        const st = (this.room?.state as any)?.monsters;
        let best: { id: string; kind: string; x: number; y: number; d: number } | null = null;
        this.monsters.forEach((mv, id) => {
          const m = st?.get(id);
          const mx = m?.x ?? mv.fx;
          const my = m?.y ?? mv.fy;
          const d = Math.hypot(mx - x, my - y);
          if (!best || d < best.d) best = { id, kind: mv.kind, x: mx, y: my, d };
        });
        return best;
      },
      // --- combat probes -------------------------------------------------
      engage: (id?: string | null) => {
        if (id === null) {
          this.engagedId = null;
          this.room?.send("engage", { id: null });
          return null;
        }
        if (id) {
          this.engagedId = id;
          this.pendingPickupId = null;
          this.nextChaseRepathAt = 0;
          this.nextEngageSendAt = 0;
        }
        return this.engagedId;
      },
      combat: () => {
        const p = this.room ? (this.room.state as any).players.get(this.room.sessionId) : null;
        return {
          engaged: this.engagedId,
          pendingPickup: this.pendingPickupId,
          hp: p?.hp,
          hpMax: p?.hpMax,
          ep: p?.ep,
          level: p?.level,
          xp: p?.xp,
          dead: !!p?.dead,
          slow: p?.slow ?? 1,
          action: p?.action,
          actionSeq: p?.actionSeq,
          hitSeq: p?.hitSeq,
        };
      },
      dropsList: () => {
        const out: Array<{
          id: string; item: string; x: number; y: number; shown: boolean; sx: number; sy: number;
        }> = [];
        // x/y = FLAT world units (server space); sx/sy = the drawn image in
        // iso screen-space (what tapAt compares against — round-12 QA).
        this.drops.forEach((d, id) =>
          out.push({ id, item: d.item, x: d.wx, y: d.wy, shown: d.img.visible, sx: d.img.x, sy: d.img.y }),
        );
        return out;
      },
      pickupNearest: () => this.pickupNearest(),
      inv: () => this.hud?.invSnapshot?.() ?? [],
      // QA (local only, like __ml.weather): paint a backpack WITHOUT farming
      // the stacks — the server owns the real one and never sends a ×3 on
      // demand. Drops made from a faked slot are healed by the server's item
      // check, so this exercises the DIALOG, not the economy.
      invFake: (items: { item: string; n: number }[]) => this.hud?.setInventory(items ?? []),
      /** Is the player allowed to walk right now? (chat typing and the HUD's
       * drop-quantity modal both freeze Phaser's keyboard — the stick
       * synthesizes into it too, so this covers every input path.) */
      canWalk: () => !!this.input.keyboard?.enabled,
      myAnim: () => {
        const av = this.room ? this.avatars.get(this.room.sessionId) : null;
        return av?.sprite.anims.getName() ?? "";
      },
      monsterAnimReady: (kind: string) => {
        const def = this.monsterManifest?.monsters.find((d) => d.id === kind);
        if (!def) return false;
        const attack = resolveMonsterAnim(def, "attack");
        if (!attack) return true; // no attack art = nothing to wait for
        for (const dir of Object.keys(def.animations?.[attack] ?? {}))
          if (this.anims.exists(monsterAnimKey(kind, attack, dir))) return true;
        return false;
      },
      roomSend: (type: string, msg: unknown) => this.room?.send(type, msg),
    };
  }

  /** Wire a (re)joined room into the scene: state callbacks, messages, and
   * the dead-connection recovery. Called for the initial join and for every
   * in-place rejoin. */
  private bindRoom(room: Room) {
    // The state flood right after (re)bind replays every EXISTING ground drop
    // through drops.onAdd — inherited loot is scenery, not a drop happening,
    // so item.drop only fires for drops witnessed after this window.
    this.joinQuietUntil = this.time.now + 1500;
    this.room = room;
    this.connected = true;
    this.reconnectRetries = 0;
    this.roomBoundAt = this.time.now;
    const cam = this.cameras.main;
    const $ = getStateCallbacks(room);
    // Shared time-of-day: fires immediately with the current phase (instant
    // apply, no log) and then on every change anyone triggers.
    let firstTimeSync = true;
    $(room.state).listen("timeIdx", (idx: number) => {
      this.setTimeOfDay(idx % TIME_PHASES.length, firstTimeSync);
      if (!firstTimeSync) this.chat.addLog("—", `Time of day: ${TIME_PHASES[idx % TIME_PHASES.length].name}`);
      firstTimeSync = false;
    });
    $(room.state).listen("phaseT", (t: number) => {
      if (typeof t === "number" && !Number.isNaN(t)) this.phaseT = t;
    });
    $(room.state).listen("frozen", (on: boolean) => {
      this.timeFrozen = !!on; // logs live on the timeSpeed listener
      this.hud?.refreshSettings();
    });
    let firstSpeedSync = true;
    $(room.state).listen("timeSpeed", (v: number) => {
      this.timeSpeed = typeof v === "number" ? v : 0;
      this.hud?.refreshSettings();
      if (!firstSpeedSync)
        this.chat.addLog("—", v === 0 ? "Time is frozen." : `Time speed: x${v}.`);
      // A reconnect can land in a FRESH room where the clock is back to its
      // frozen default — say so on join, or flowing time silently "stops"
      // again (maintainer hit exactly this).
      else if (v === 0) this.chat.addLog("—", "Time is frozen (Settings → time speed).");
      firstSpeedSync = false;
    });
    let firstAuroraSync = true;
    $(room.state).listen("aurora", (on: boolean) => {
      this.auroraOn = !!on;
      if (firstAuroraSync) this.curAurora = on ? 1 : 0; // no roll-in on join
      else if (on) this.chat.addLog("—", "Northern lights dance over Nangijala.");
      firstAuroraSync = false;
    });
    let firstWeatherSync = true;
    $(room.state).listen("weather", (idx: number) => {
      this.weatherIdx = idx % WEATHER_COUNT;
      this.hud?.refreshSettings(); // the weather button prints the state
      if (firstWeatherSync) {
        this.curCloud = WEATHER_CLOUD[this.weatherIdx] ?? 0; // no roll-in on join
        this.curMist = this.weatherIdx === 2 ? 1 : 0;
        this.curPrecipDim = WEATHER_DIM[this.weatherIdx] ?? 0;
        this.weatherFX?.snap();
      }
      else this.chat.addLog("—", `Weather: ${WEATHER_NAMES[this.weatherIdx]}`);
      firstWeatherSync = false;
    });
    $(room.state).players.onAdd((player: any, id: string) => {
      this.addAvatar(id, player);
      if (id === room.sessionId) {
        this.camDetached = false;
        this.camChase.init = false; // chase-cam snaps onto the new avatar
        // Re-assert my torch to the fresh player entry (rejoins reset it).
        if (!this.torchOn) room.send("torch", { on: false });
        hideLoading(); // my avatar is in and the camera is on it — world's up
        this.loadDeferredAnims(); // action states stream in behind the live world
      }
      this.refreshRoster();
    });
    $(room.state).players.onRemove((_player: any, id: string) => {
      this.removeAvatar(id);
      this.refreshRoster();
    });
    // Roaming monsters — server-authoritative, so every client renders the same
    // ones at the same positions. Poll state.monsters.get(id) each frame and
    // ease like a remote player (see the monster loop in update()).
    $(room.state).monsters.onAdd((m: any, id: string) => this.addMonster(id, m));
    $(room.state).monsters.onRemove((_m: any, id: string) => this.removeMonster(id));
    $(room.state).drops.onAdd((g: any, id: string) => this.addDrop(id, g));
    $(room.state).drops.onRemove((_g: any, id: string) => this.removeDrop(id));
    // Spawn areas are server-computed per world and synced once — redraw the
    // debug overlay as they arrive (they land after the first iso build).
    $(room.state).spawnAreas.onAdd(() => this.drawSpawnAreas());
    // Live tuning pushes (monster stats + constant overrides edited in the
    // wiki) — sent on join and broadcast on every admin save / live/** push.
    bindLiveTuning(room);
    room.onMessage("chat", (msg: ChatBroadcast) => {
      this.chat.addLog(msg.name, msg.text);
      this.showBubble(msg.id, msg.text);
      if (msg.id !== room.sessionId) gameAudio.event("ui.notify", { gainDb: -9 });
    });
    // Every arrival in Nangijala is a shooting star everyone sees at the
    // same moment; the night sky also throws wild ones (no name).
    room.onMessage("inv", (msg: { items?: { item: string; n: number }[] }) => {
      this.hud?.setInventory(msg?.items ?? []);
    });
    room.onMessage("levelup", (msg: { name?: string; level?: number }) => {
      if (!msg?.name || !msg?.level) return;
      this.chat.addLog("—", `${msg.name} reached level ${msg.level}!`);
      // BOUND BUT EMPTY (maintainer 2026-08-05): the action fires so the wiki
      // can list it and assign a sound to it; nothing plays until they do.
      gameAudio.event("progress.level_up");
    });
    room.onMessage("star", (msg: { name?: string }) => {
      this.shootingStar(msg?.name);
      gameAudio.star(); // a chime in key, on the beat
    });
    // Dead-connection recovery. Backgrounding the tab (phones especially)
    // freezes JS; the server drops the silent client and this room becomes a
    // ZOMBIE — no patches, no acks, prediction replaying an ever-growing
    // unacked input history from a frozen base (the old "teleport when I jump
    // uphill after tabbing back" bug). The game can't run offline — rejoin
    // IN PLACE (no page reload: phones background constantly and a reload
    // means the whole loading screen again). A real page unload fires
    // pagehide first and is left alone.
    room.onLeave(() => {
      if (this.unloading || this.room !== room) return;
      this.handleDrop();
    });
  }

  private removeAvatar(id: string) {
    const av = this.avatars.get(id);
    if (!av) return;
    av.sprite.destroy();
    av.lit?.destroy();
    av.shadow.destroy();
    av.label.destroy();
    av.waterMask?.destroy();
    av.waterMaskG?.destroy();
    av.foam?.destroy();
    av.bubble?.destroy();
    this.avatars.delete(id);
    gameAudio.dropAvatar(id);
  }

  /** Spawn a roaming-monster sprite. Mirrors the essential parts of addAvatar:
   * project the authoritative flat (x,y) onto the iso ground (feet lifted by
   * the cell/surface elevation), a squashed drop shadow, and the south walk
   * frame as the initial texture. No label/torch/footstep machinery. */
  private addMonster(id: string, m: any) {
    const def = this.monsterManifest?.monsters.find((d) => d.id === m.kind);
    // The roster's own display name ("Dewling" for forest_poring) — resolved
    // HERE, once, because updateMonsterHpBar runs per monster per frame and a
    // manifest scan there would be 24 finds × 160 monsters × 60fps.
    const label = def?.name || m.kind;
    const f0 = this.projectFlat(m.x, m.y);
    const elev0 = (m.elev ?? f0.lvl) * MAP_GEOMETRY.lh;
    const p0 = { x: f0.x, y: f0.y - elev0 };
    const walk = def ? monsterWalkKey(def) : "jump";
    const initKey = monsterSheetKey(m.kind, walk, DEFAULT_DIRECTION);
    const hasArt = this.textures.exists(initKey);
    // 48px art, drawn at scale 1 (the camera zoom already scales the world);
    // origin near the feet so it y-sorts and lifts like a player. Fall back to
    // the wanderer placeholder if a monster's strip failed to load.
    const sprite = this.add.sprite(p0.x, p0.y, hasArt ? initKey : PLACEHOLDER_TEX);
    // Feet origin = the PER-DIRECTION measured ground contract (feet line +
    // foot centre of the south strip to start; playMonsterAnim re-anchors on
    // every facing change). One pooled anchor floated whole directions by up
    // to 9px and off-centre art (turtle east: feet 6px from frame centre) put
    // the shadow beside the body (maintainer 2026-07-30, round 2). The parked
    // frame is the direction's planted CONTACT frame, never an airborne f0.
    const g0 = def?.ground?.[DEFAULT_DIRECTION];
    if (hasArt) sprite.setFrame(g0?.contact ?? 0);
    sprite.setOrigin(g0?.cx ?? 0.5, g0?.f ?? def?.artBottom ?? 0.85).setScale(1);
    // Nadir shadow sized from the ART, not the frame (manifest-emitted:
    // ground-contact footprint blended toward body width — frame-scaled
    // shadows ran huge on padded frames and tiny on slim bodies, RED/GREEN).
    const shadowW = def?.shadowW ?? Math.round((def?.frameW ?? 48) * 0.54);
    const shadowH = def?.shadowH ?? Math.max(6, Math.round(shadowW * 0.385));
    const shadow = this.add
      .image(p0.x, p0.y, MONSTER_SHADOW_TEX)
      .setOrigin(0.5, 0.5)
      .setDisplaySize(shadowW * MONSTER_SHADOW_SPREAD, shadowH * MONSTER_SHADOW_SPREAD);
    const mv: MonsterAvatar = {
      sprite,
      shadow,
      kind: m.kind,
      label,
      lx: p0.x,
      ly: p0.y,
      lyFlat: f0.y,
      elev: elev0,
      fallV: 0,
      falling: false,
      dispDir: DEFAULT_DIRECTION,
      fx: m.x,
      fy: m.y,
      shadowW,
      shadowH,
      radius: def?.radius ?? DEFAULT_MONSTER_RADIUS,
      hoverPx: def?.hoverPx ?? 0,
      walkKey: walk,
      attackKey: def ? resolveMonsterAnim(def, "attack") : undefined,
      angryKey: def ? resolveMonsterAnim(def, "angry") : undefined,
      dieKey: def ? resolveMonsterAnim(def, "die") : undefined,
      idleKey: def?.idleAnim ?? undefined,
      ground: def?.ground,
      groundIdle: def?.groundIdle ?? undefined,
    };
    sprite.y = p0.y - mv.hoverPx;
    // Joining mid-fight must not replay a stale swing: start from the synced seq.
    mv.lastActionSeq = m.actionSeq ?? 0;
    mv.lastHp = m.hp;
    this.monsters.set(id, mv);
    this.playMonsterAnim(mv, !!m.moving, m.dir, m.mstate ?? "roam", m.actionSeq ?? 0);
  }

  /** Ground loot: one Image + a soft shadow per drop, y-sorted with the
   * bodies. Item sprites are UNIFORM at items/<id>/sprite.webp (verified over
   * all 105 items), so no manifest fetch is needed — textures lazy-load per
   * KIND the first time one drops. */
  private addDrop(id: string, g: any) {
    const p = this.projectFlat(g.x, g.y);
    const y = p.y - Math.max(g.elev ?? 0, p.lvl) * MAP_GEOMETRY.lh;
    if (this.time.now > this.joinQuietUntil) {
      const spG = this.worldSpatial(p.x, y);
      gameAudio.event("item.drop", { pan: spG.pan, dist: spG.dist });
    }
    const shadow = this.add
      .image(p.x, y, SHADOW_TEX)
      .setOrigin(0.5, 0.5)
      .setDisplaySize(20, 9)
      .setAlpha(0.55)
      .setDepth(y - 0.6);
    const img = this.add.image(p.x, y - 7, "__MISSING").setVisible(false).setDepth(y);
    // Witnessed drops carry their local birth time (drives the end-of-life
    // flash); join-inherited ones (the state flood right after bind) start
    // the clock at join — their flash can come late, and the server's sweep
    // is the ground truth either way.
    const rec = {
      img,
      shadow,
      wx: g.x,
      wy: g.y,
      item: g.item,
      bornAt: this.time.now,
    };
    this.drops.set(id, rec);
    this.withItemTexture(g.item, (key) => {
      if (this.drops.get(id) !== rec) return; // picked up before the art landed
      img.setTexture(key).setScale(0.6).setVisible(true);
      // The little TOSS (maintainer: "thrown up from the ground", subtle):
      // freshly witnessed drops pop up a few px and settle; the join flood
      // (< 2s after bind) lands silent so a full field doesn't bounce at us.
      if (this.time.now - this.roomBoundAt > 2000) {
        const rest = y - 7;
        img.setY(y); // out of the ground…
        this.tweens.add({ targets: img, y: rest - 8, duration: 190, ease: "Quad.easeOut", yoyo: false,
          onComplete: () => {
            this.tweens.add({ targets: img, y: rest, duration: 240, ease: "Bounce.easeOut" });
          } });
      }
    });
  }

  private removeDrop(id: string) {
    const rec = this.drops.get(id);
    if (!rec) return;
    rec.img.destroy();
    rec.shadow.destroy();
    this.drops.delete(id);
    if (this.pendingPickupId === id) this.pendingPickupId = null;
  }

  /** Lazy per-kind item texture (48x48 webp). The callback fires immediately
   * when cached, else when the background load lands. */
  private withItemTexture(item: string, cb: (key: string) => void) {
    const key = `item:${item}`;
    if (this.textures.exists(key)) {
      cb(key);
      return;
    }
    this.load.image(key, withV(`/assets/items/${item}/sprite.webp`));
    this.load.once(`filecomplete-image-${key}`, () => cb(key));
    this.load.start();
  }

  /** What did a world-coords tap land on? Drops first (small, precise
   * intent), then monsters. Culled monsters are not drawn, so they are not
   * tappable. Hitboxes are FINGER-SIZED, not art-sized (maintainer round 12:
   * "less hard/annoying by constantly miss clicking", explicitly incl. small
   * monsters like the sprigling): every box is the art box grown by a pad
   * and clamped to a minimum, and when the fat boxes overlap in a crowd the
   * CLOSEST candidate wins — generosity must never select the wrong body. */
  private tapTarget(wx: number, wy: number): { kind: "drop" | "monster"; id: string } | null {
    let best: { kind: "drop" | "monster"; id: string; d: number } | null = null;
    for (const [id, d] of this.drops) {
      if (!d.img.visible) continue;
      const dx = wx - d.img.x;
      const dy = wy - d.img.y;
      if (Math.abs(dx) <= DROP_TAP_HALF && Math.abs(dy) <= DROP_TAP_HALF) {
        const dist = Math.hypot(dx, dy);
        if (!best || dist < best.d) best = { kind: "drop", id, d: dist };
      }
    }
    // A drop tap is deliberate and drops are tiny — they keep priority over
    // any monster box lying across them.
    if (best) return { kind: best.kind, id: best.id };
    for (const [id, mv] of this.monsters) {
      if (mv.culled || mv.mstate === "die") continue;
      const sp = mv.sprite;
      const halfW = Math.max(MONSTER_TAP_MIN_HALF_W, sp.displayWidth * 0.5 + 6);
      let top = sp.y - sp.displayHeight * sp.originY - 8;
      const bottom = sp.y + 10;
      // A sprigling-sized body still gets a full fingertip of height.
      if (bottom - top < MONSTER_TAP_MIN_H) top = bottom - MONSTER_TAP_MIN_H;
      if (wx < mv.lx - halfW || wx > mv.lx + halfW || wy < top || wy > bottom) continue;
      const dist = Math.hypot(wx - mv.lx, wy - (top + bottom) / 2);
      if (!best || dist < best.d) best = { kind: "monster", id, d: dist };
    }
    return best ? { kind: best.kind, id: best.id } : null;
  }

  /** Per-frame combat/fetch intent: walk to the engaged monster (which
   * moves), stand and engage in reach; walk to a tapped item and grab it.
   * The SERVER owns everything that happens after the messages land. */
  private driveCombatIntent() {
    if (this.selfDead || !this.room) return;
    const me = this.avatars.get(this.room.sessionId);
    if (!me) return;
    if (this.pendingPickupId) {
      const d = this.drops.get(this.pendingPickupId);
      const nowP = this.time.now;
      // The intent stays ARMED until the drop actually disappears (its
      // onRemove clears us) or a timeout gives up: the server validates
      // against ITS position, which trails the predicted one by the unacked
      // input window, so a single fire-and-forget send silently loses the
      // race on laggy links and the player stands next to untouched loot.
      if (!d || nowP >= this.pickupIntentUntil) this.pendingPickupId = null;
      else if (Math.hypot(d.wx - me.fx, d.wy - me.fy) <= PICKUP_RADIUS_WU * 0.8) {
        if (nowP >= this.nextPickupSendAt) {
          this.nextPickupSendAt = nowP + 400;
          this.room.send("pickup", { id: this.pendingPickupId });
        }
        if (this.trip) this.clearMoveTarget(); // arrived: stand for the grab
      }
    }
    if (!this.engagedId) return;
    const mv = this.monsters.get(this.engagedId);
    if (!mv || mv.mstate === "die") {
      this.engagedId = null;
      return;
    }
    const now = this.time.now;
    // Re-assert ~1/s the whole time we hold the intent — walking OR standing:
    // the server keeps the target across movement now (the sword mark), so
    // this only guards against ordering/reconnect losses.
    if (now >= this.nextEngageSendAt) {
      this.nextEngageSendAt = now + 700;
      this.room.send("engage", { id: this.engagedId });
    }
    const range = attackRange(PLAYER_BODY_RADIUS, mv.radius);
    const dist = Math.hypot(mv.fx - me.fx, mv.fy - me.fy);
    if (dist <= range) {
      if (this.trip) this.clearMoveTarget(); // arrived: stand and fight
    } else if (now >= this.nextChaseRepathAt) {
      this.nextChaseRepathAt = now + 300; // the target roams/circles — retarget
      this.setMoveTarget(mv.fx, mv.fy, true, false, undefined, false); // sword mark, no beacon
    }
  }

  /** A marked body's OUTLINE texture for its current frame, built on first
   * sight and cached in the texture manager: the frame is drawn into a
   * canvas padded RING_PAD px on every side, its alpha read back, and a 2px
   * two-tone border grown out of the silhouette — the INNER line in the
   * palette's base colour, the OUTER line a step brighter (maintainer round
   * 11). Each line is a 4-NEIGHBOUR dilation (N/S/E/W — never diagonals:
   * side-dilation leaves single diagonally-touching pixels across the art's
   * diagonal steps, the thin connected border pixel art itself outlines
   * with; 8-way dilation doubles up there and reads thick — round 10). The
   * pad is symmetric, so a setFlipX mirror still lines up with the mirrored
   * art. ~1 tiny canvas per (strip, frame, palette) actually marked. */
  private ringTextureFor(
    sp: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image,
    inner: number,
    outer: number,
  ): string | null {
    const frame = sp.frame;
    const key = `ring:${inner.toString(16)}:${sp.texture.key}|${frame.name}`;
    if (this.textures.exists(key)) return key;
    const fw = frame.cutWidth;
    const fh = frame.cutHeight;
    if (!fw || !fh) return null;
    const w = fw + RING_PAD * 2;
    const h = fh + RING_PAD * 2;
    const cnv = document.createElement("canvas");
    cnv.width = w;
    cnv.height = h;
    const ctx = cnv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(
      frame.source.image as CanvasImageSource,
      frame.cutX, frame.cutY, fw, fh,
      RING_PAD, RING_PAD, fw, fh,
    );
    const a = ctx.getImageData(0, 0, w, h).data;
    // Solid = the art's own opacity threshold; soft anti-alias fringes on
    // generated strips stay outside the border.
    const n = w * h;
    const solid = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (a[i * 4 + 3] >= 128) solid[i] = 1;
    // One 4-neighbour dilation ring: mask=1 where a transparent-in-`base`
    // pixel touches a `base` pixel on a side.
    const growRing = (base: Uint8Array) => {
      const ring = new Uint8Array(n);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (base[i]) continue;
          if (
            (x > 0 && base[i - 1]) ||
            (x < w - 1 && base[i + 1]) ||
            (y > 0 && base[i - w]) ||
            (y < h - 1 && base[i + w])
          )
            ring[i] = 1;
        }
      }
      return ring;
    };
    const ring1 = growRing(solid);
    const filled = new Uint8Array(n);
    for (let i = 0; i < n; i++) filled[i] = solid[i] | ring1[i];
    const ring2 = growRing(filled);
    const out = ctx.createImageData(w, h);
    const od = out.data;
    const paint = (ring: Uint8Array, c: number) => {
      const r = (c >> 16) & 0xff;
      const g = (c >> 8) & 0xff;
      const b = c & 0xff;
      for (let i = 0; i < n; i++) {
        if (!ring[i]) continue;
        od[i * 4] = r;
        od[i * 4 + 1] = g;
        od[i * 4 + 2] = b;
        od[i * 4 + 3] = 255;
      }
    };
    paint(ring1, inner);
    paint(ring2, outer);
    ctx.putImageData(out, 0, 0);
    // NEAREST explicitly: addCanvas does not inherit pixelArt's default the
    // way loaded textures do, and LINEAR smears the outline into a soft
    // translucent halo at any fractional camera zoom (measured).
    this.textures.addCanvas(key, cnv)?.setFilter(Phaser.Textures.FilterMode.NEAREST);
    return key;
  }

  /** The engagement overlays, per frame after the monster loop: (1) the red
   * target/aggro borders + the blue item border; (2) the settings debug
   * rings: every monster's aggro radius, plus the provoke radius on the
   * marked one. (The in-fight hp/level readout lives ON the monster —
   * updateMonsterHpBar.) */
  private updateTargetOverlays() {
    const state = this.room?.state as any;

    // (1) The RED BORDERS (maintainer rounds 9-11): a 2-MONSTER-PIXEL dark
    // red two-tone outline hugging the body's own silhouette — on the
    // monster I clicked (from the tap through the ENTIRE fight, round 11)
    // AND on every monster currently hunting ME (synced Monster.tsid). The
    // outline is a GENERATED texture (ringTextureFor — thin 4-neighbour
    // lines, inner base + outer brighter) drawn ABOVE the darkness overlay
    // and every lit copy at FULL alpha, whatever the hour — the mark is UI,
    // and lighting/shadow/fog never touch it (round 10). An outline has no
    // interior, so nothing bleeds through the body it surrounds.
    const mySid = this.room?.sessionId;
    for (const [id, mv2] of this.monsters) {
      const sm = state?.monsters?.get(id);
      const hunting =
        !!sm && sm.tsid === mySid && !!mySid && (mv2.mstate === "chase" || mv2.mstate === "combat");
      const on =
        (this.engagedId === id || hunting) &&
        !!sm &&
        mv2.mstate !== "die" &&
        !mv2.culled &&
        mv2.sprite.visible;
      let ring = this.monsterRings.get(id);
      if (!on) {
        ring?.setVisible(false);
        continue;
      }
      const sp = mv2.sprite;
      const ringKey = this.ringTextureFor(sp, TARGET_RING_COLOR, TARGET_RING_BRIGHT);
      if (!ringKey) {
        ring?.setVisible(false);
        continue;
      }
      if (!ring) {
        ring = this.add.image(0, 0, ringKey).setVisible(false);
        this.monsterRings.set(id, ring);
      }
      // POSITION ALWAYS FROM THE LIVE SPRITE, never from the lit copy:
      // applyObjectLights syncs lit copies LATER in the frame, so its x/y
      // is one frame stale — on a hopping monster that lag smeared the
      // ring sideways instead of hugging the silhouette. The outline canvas
      // is the frame padded RING_PAD px on every side, so the origin shifts
      // by that pad to keep the art aligned under the sprite's own origin
      // (which the walk shift[] moves per frame).
      const fw = sp.frame.cutWidth;
      const fh = sp.frame.cutHeight;
      ring
        .setTexture(ringKey)
        .setOrigin(
          (sp.originX * fw + RING_PAD) / (fw + RING_PAD * 2),
          (sp.originY * fh + RING_PAD) / (fh + RING_PAD * 2),
        )
        .setScale(sp.scaleX, sp.scaleY)
        .setFlipX(sp.flipX)
        .setPosition(sp.x, sp.y)
        .setAlpha(1)
        .setDepth(900_001.45) // above every lit copy, below the hp bar
        .setVisible(true);
    }
    // Rings for monsters that left the room entirely.
    for (const [id, ring] of this.monsterRings) {
      if (!this.monsters.has(id)) {
        ring.destroy();
        this.monsterRings.delete(id);
      }
    }

    // (1b) The ITEM BORDER (maintainer round 11, replacing the round-8/9
    // hand icon): the drop I am fetching — a tap on it, or the nearest one
    // via PICK UP / F — gets the same generated outline in light-light-blue,
    // until it is picked up. Rendered exactly like the red one: above the
    // lighting at full alpha; the item itself stays an ordinary world-layer
    // drop (shadow, night dimming and the end-of-life flash untouched).
    let itemRingOn = false;
    const pd = this.pendingPickupId ? this.drops.get(this.pendingPickupId) : undefined;
    if (pd && pd.img.visible) {
      const ringKey = this.ringTextureFor(pd.img, ITEM_RING_COLOR, ITEM_RING_BRIGHT);
      if (ringKey) {
        itemRingOn = true;
        if (!this.itemRingImg) {
          this.itemRingImg = this.add.image(0, 0, ringKey).setVisible(false);
        }
        const fw = pd.img.frame.cutWidth;
        const fh = pd.img.frame.cutHeight;
        this.itemRingImg
          .setTexture(ringKey)
          .setOrigin(
            (pd.img.originX * fw + RING_PAD) / (fw + RING_PAD * 2),
            (pd.img.originY * fh + RING_PAD) / (fh + RING_PAD * 2),
          )
          .setScale(pd.img.scaleX, pd.img.scaleY)
          // Live img position: the spawn TOSS tween owns y while it runs and
          // the border rides along with it.
          .setPosition(pd.img.x, pd.img.y)
          .setAlpha(1)
          .setDepth(900_001.44) // unlit, beside the monster rings
          .setVisible(true);
      }
    }
    if (!itemRingOn) this.itemRingImg?.setVisible(false);

    // (2) Aggro-radius debug rings.
    if (!this.aggroGfx && this.aggroRadiusOn) this.aggroGfx = this.add.graphics().setDepth(-799_999);
    if (this.aggroGfx) {
      this.aggroGfx.clear();
      if (this.aggroRadiusOn && state?.monsters) {
        state.monsters.forEach((sm: any, id: string) => {
          if (sm.mstate === "die") return;
          const marked = id === this.engagedId;
          const r = marked ? Math.max(sm.aggro ?? 0, PROVOKE_RADIUS_WU) : (sm.aggro ?? 0);
          if (r <= 0) return;
          // A world-space circle projected point by point — correct in iso
          // (an ellipse on screen) and following the ground under it.
          const lift = (sm.elev ?? 0) * MAP_GEOMETRY.lh;
          const pts: { x: number; y: number }[] = [];
          for (let i = 0; i < 28; i++) {
            const a = (i / 28) * Math.PI * 2;
            const p = this.projectFlat(sm.x + Math.cos(a) * r, sm.y + Math.sin(a) * r);
            pts.push({ x: p.x, y: p.y - lift });
          }
          this.aggroGfx!.lineStyle(1, marked ? 0xffd166 : 0xf25d5d, marked ? 0.9 : 0.55);
          this.aggroGfx!.strokePoints(pts, true);
        });
      }
    }
  }

  private toggleAggroRadius(on = !this.aggroRadiusOn) {
    this.aggroRadiusOn = on;
    try {
      localStorage.setItem("ml-aggro-radius", on ? "1" : "0");
    } catch {}
    this.chat.addLog("—", `Aggro radius: ${on ? "on" : "off"}`);
    return this.aggroRadiusOn;
  }

  /** The PICKUP BUTTON / F key: grab the nearest ground item — immediately
   * when in reach, else walk to it first (same flow as tapping it). */
  private pickupNearest() {
    if (this.selfDead || !this.room) return;
    const me = this.avatars.get(this.room.sessionId);
    if (!me) return;
    let bestId: string | null = null;
    let bestD = CELL_WU * 5; // don't sprint across the map for a mis-tap
    for (const [id, d] of this.drops) {
      const dist = Math.hypot(d.wx - me.fx, d.wy - me.fy);
      if (dist < bestD) {
        bestD = dist;
        bestId = id;
      }
    }
    if (!bestId) return;
    // Arm the intent either way — driveCombatIntent retries until the drop
    // vanishes, which absorbs the predicted-vs-server position skew.
    this.pendingPickupId = bestId;
    this.pickupIntentUntil = this.time.now + 6000;
    if (bestD <= PICKUP_RADIUS_WU * 0.8) {
      this.nextPickupSendAt = this.time.now + 400;
      this.room.send("pickup", { id: bestId });
    } else {
      const d = this.drops.get(bestId)!;
      this.setMoveTarget(d.wx, d.wy, true, false, undefined, false); // hand marker, no beacon
    }
  }

  private removeMonster(id: string) {
    const mv = this.monsters.get(id);
    if (!mv) return;
    mv.lit?.destroy();
    mv.hpBg?.destroy();
    mv.hpFill?.destroy();
    mv.nameText?.destroy();
    mv.lvText?.destroy();
    mv.hpText?.destroy();
    if (mv.mstate === "die" && mv.sprite.visible && !mv.culled) {
      // The server held the schema entry for the die clip; now the corpse
      // FADES instead of popping off (RO body dissolve). The sprites are
      // detached from the map first, so a respawn under the same id can't
      // fight the tween.
      const corpse = mv.sprite;
      const shadow = mv.shadow;
      this.tweens.add({
        targets: [corpse, shadow],
        alpha: 0,
        duration: 450,
        onComplete: () => {
          corpse.destroy();
          shadow.destroy();
        },
      });
      // …and the GRAVE CROSS rises where it fell (maintainer 2026-08-05),
      // right as the loot appears beside it.
      this.spawnGraveCross(mv.lx, mv.lyFlat, mv.elev);
      const spM = this.worldSpatial(mv.lx, mv.lyFlat - mv.elev);
      gameAudio.event("combat.monster_die", { pan: spM.pan, dist: spM.dist });
    } else {
      mv.sprite.destroy();
      mv.shadow.destroy();
    }
    this.monsters.delete(id);
  }

  /** The wooden grave cross (objects/grave_cross, the maintainer's PixelLab
   * object): plays its 16-frame SOUTH "appear" once at the death spot, holds
   * on the LAST frame, and after a minute plays the same clip REVERSED —
   * sinking back into the ground — and vanishes. Client-local decoration:
   * every client witnesses the same death via the synced die state. Spawns
   * QUEUE while the strip loads (appending to a busy loader is fine — a
   * kill during the deferred-anim batch must not silently drop its cross). */
  private spawnGraveCross(lx: number, lyFlat: number, elevPx: number) {
    const KEY = "grave-cross-appear";
    if (this.textures.exists(KEY)) {
      this.materializeCross(lx, lyFlat, elevPx);
      return;
    }
    this.pendingCrosses.push({ lx, lyFlat, elevPx });
    if (!this.crossLoadQueued) {
      this.crossLoadQueued = true;
      this.load.spritesheet(KEY, withV("/assets/objects/grave_cross/animations/appear__south.webp"), {
        frameWidth: 34,
        frameHeight: 34,
      });
      this.load.once(`filecomplete-spritesheet-${KEY}`, () => {
        for (const c of this.pendingCrosses.splice(0)) this.materializeCross(c.lx, c.lyFlat, c.elevPx);
      });
      this.load.start();
    }
  }

  private materializeCross(lx: number, lyFlat: number, elevPx: number) {
    const KEY = "grave-cross-appear";
    if (!this.anims.exists(KEY)) {
      this.anims.create({
        key: KEY,
        frames: this.anims.generateFrameNumbers(KEY, {}),
        frameRate: 13,
        repeat: 0,
      });
    }
    const y = lyFlat - elevPx;
    const sprite = this.add
      .sprite(lx, y, KEY, 0)
      .setOrigin(0.5, 1)
      .setDepth(y - 0.5); // ground decor: just under bodies standing on the spot
    sprite.y += 2; // the mound reads planted, not floating
    sprite.play(KEY);
    sprite.once("animationcomplete", () => {
      sprite.anims.pause(); // hold the standing cross (last frame)
    });
    this.graveCrosses.push({ sprite, bornAt: this.time.now, reversing: false });
    const spC = this.worldSpatial(lx, y);
    gameAudio.event("combat.cross_on", { pan: spC.pan, dist: spC.dist });
  }

  /** Cross lifecycle + the ground items' end-of-life flash, each frame. */
  private stepGroundDecor() {
    const now = this.time.now;
    for (let i = this.graveCrosses.length - 1; i >= 0; i--) {
      const gc = this.graveCrosses[i];
      if (!gc.reversing && now - gc.bornAt >= 60_000) {
        gc.reversing = true;
        gc.sprite.anims.resume();
        gc.sprite.playReverse("grave-cross-appear");
        const spX = this.worldSpatial(gc.sprite.x, gc.sprite.y);
        gameAudio.event("combat.cross_off", { pan: spX.pan, dist: spX.dist });
        gc.sprite.once("animationcomplete", () => gc.sprite.destroy());
        // If the reverse somehow never completes (tab hidden through it),
        // the sweep below still drops the record; the sprite dies with it.
      }
      if (gc.reversing && (!gc.sprite.active || now - gc.bornAt >= 70_000)) {
        if (gc.sprite.active) gc.sprite.destroy();
        this.graveCrosses.splice(i, 1);
      }
    }
    // Ground items: the last DROP_FLASH_MS before the server sweeps them,
    // flash transparent FASTER AND FASTER until gone (maintainer). Timed
    // from the witnessed birth; the server's sweep is authoritative.
    for (const rec of this.drops.values()) {
      const left = DROP_TTL_MS - (now - rec.bornAt);
      if (left <= DROP_FLASH_MS) {
        const t = Math.max(0, 1 - left / DROP_FLASH_MS); // 0 → 1 over the final stretch
        const hz = 2 + t * 8; // 2Hz ramping to 10Hz
        const s = 0.5 + 0.5 * Math.sin((now / 1000) * hz * Math.PI * 2);
        const a = 0.15 + 0.85 * s;
        rec.img.setAlpha(a);
        rec.shadow.setAlpha(0.55 * a);
      }
    }
  }

  /** The slim in-fight readout floating over a monster, styled after the
   * player's own HP bar. THREE LINES (maintainer 2026-08-05): the monster's
   * NAME left-aligned OVER the bar, then the bar, then "Lv N" left-aligned
   * and "hp/max" right-aligned UNDER it — a clear gap between the two even
   * at 4-digit HP, which is what the bar's width is sized for. (Rounds 5-9
   * kept Lv/hp on the bar's own line with no name at all; the name is his
   * call to add now, and it needed that line freed up.) Drawn ABOVE the
   * darkness overlay (900_000) and the lit copies, UNDER the damage floats
   * (900_002): day, night and shadow never touch it. Shown while the monster
   * is wounded, in combat, or MY engaged target. */
  private updateMonsterHpBar(mv: MonsterAvatar, m: any, id: string) {
    const inFight =
      m.hpMax > 0 &&
      m.mstate !== "die" &&
      (m.hp < m.hpMax || m.mstate === "combat" || this.engagedId === id);
    if (!inFight) {
      mv.hpBg?.setVisible(false);
      mv.hpFill?.setVisible(false);
      mv.nameText?.setVisible(false);
      mv.lvText?.setVisible(false);
      mv.hpText?.setVisible(false);
      return;
    }
    const W = 76; // fits "Lv 19" + gap + "9999/9999" at 8px monospace
    if (!mv.hpBg) {
      const style = {
        fontFamily: "monospace",
        fontSize: "8px",
        color: "#f4efe4",
        stroke: "#10101c",
        strokeThickness: 2,
      };
      mv.hpBg = this.add.rectangle(0, 0, W, 6, 0x10101c, 0.85).setDepth(900_001.5).setOrigin(0.5, 0.5);
      mv.hpFill = this.add.rectangle(0, 0, W - 2, 4, 0xf25d5d, 1).setDepth(900_001.6).setOrigin(0, 0.5);
      // name ABOVE (origin bottom-left), Lv + hp BELOW (origin top-left /
      // top-right) — the bar's own line is the name's now.
      mv.nameText = this.add.text(0, 0, "", style).setOrigin(0, 1).setDepth(900_001.7).setResolution(2);
      mv.lvText = this.add.text(0, 0, "", style).setOrigin(0, 0).setDepth(900_001.7).setResolution(2);
      mv.hpText = this.add.text(0, 0, "", style).setOrigin(1, 0).setDepth(900_001.7).setResolution(2);
    }
    const frac = Math.max(0, Math.min(1, m.hp / m.hpMax));
    const topY = mv.sprite.y - mv.sprite.displayHeight * mv.sprite.originY - 8;
    mv.hpBg.setPosition(mv.lx, topY).setVisible(true);
    mv.hpFill!
      .setPosition(mv.lx - (W - 2) / 2, topY)
      .setVisible(true)
      .setSize(Math.max(1, (W - 2) * frac), 4);
    const name = mv.label ?? mv.kind;
    const lv = `Lv ${m.level ?? 1}`;
    const hp = `${Math.ceil(m.hp)}/${m.hpMax}`;
    if (mv.nameText!.text !== name) mv.nameText!.setText(name);
    if (mv.lvText!.text !== lv) mv.lvText!.setText(lv);
    if (mv.hpText!.text !== hp) mv.hpText!.setText(hp);
    // All three hang off the BAR's own edges, so the three lines share one
    // left margin and the stack stays centred on the monster.
    mv.nameText!.setPosition(mv.lx - W / 2, topY - 5).setVisible(true);
    mv.lvText!.setPosition(mv.lx - W / 2, topY + 5).setVisible(true);
    mv.hpText!.setPosition(mv.lx + W / 2, topY + 5).setVisible(true);
  }

  /** A small rising damage number (world-space, above the night overlay). */
  private spawnDamageFloat(x: number, y: number, text: string, color: number) {
    // Round 7 (maintainer): twice as big, on screen 0.2s longer.
    const t = this.add
      .text(x, y, text, {
        fontFamily: "monospace",
        fontSize: "26px",
        fontStyle: "bold",
        color: `#${color.toString(16).padStart(6, "0")}`,
        stroke: "#101018",
        strokeThickness: 5,
      })
      .setOrigin(0.5, 1)
      .setDepth(900_002)
      .setResolution(2);
    this.tweens.add({
      targets: t,
      y: y - 30,
      alpha: { from: 1, to: 0 },
      duration: 850,
      ease: "Cubic.easeOut",
      onComplete: () => t.destroy(),
    });
  }

  /** A blood spatter on a struck body (objects/blood_spatter, the
   * maintainer's PixelLab object trimmed to burst->dispersal): one of the 8
   * direction variants at random, played forward or REVERSED at random —
   * reversed reads as the burst converging, so no two hits look alike. */
  private spawnBloodFx(x: number, y: number) {
    const dir = BLOOD_DIRS[Math.floor(Math.random() * BLOOD_DIRS.length)];
    const key = `blood:${dir}`;
    if (!this.anims.exists(key)) return; // strips still background-loading — skip quietly
    const s = this.add.sprite(x, y, key, 0).setOrigin(0.5, 0.5).setDepth(900_001.95);
    this.bloodSeen++;
    if (Math.random() < 0.5) s.play(key);
    else s.playReverse(key);
    s.once("animationcomplete", () => s.destroy());
  }

  /** Drive a monster's 8-dir WALK clip (mv.walkKey — the manifest-resolved
   * anim, never a hardcoded name): loop it while `moving`, else freeze on the
   * first frame of the current facing (idle pause between legs). A
   * direction-only change keeps the loop progress so the gait doesn't restart.
   * Facing goes through the SAME stableDir hysteresis as players (maintainer
   * 2026-07-30: monsters flip-flopped between adjacent directions walking at
   * sector-boundary angles — the identical jitter the player fix killed):
   * a 45° change must persist DIR_STICK_MS before the sprite turns, 90°+
   * turns switch instantly. */
  private playMonsterAnim(mv: MonsterAvatar, moving: boolean, dir: string, mstate = "roam", actionSeq = 0) {
    const want = DIRECTIONS.includes(dir as never) ? dir : DEFAULT_DIRECTION;
    // Monsters take EVERY turn (even 90-180°) through hysteresis: they are
    // remote puppets, so a 160ms facing lag is invisible — while autopilot
    // thrash near a roam target flipped them "back and forth like crazy"
    // right before stopping (maintainer 2026-07-30). Players keep instant
    // large turns for input feel.
    const d = this.stableDir(mv, want, true);
    mv.mstate = mstate;

    // --- COMBAT CLIPS (attack / angry / die — deferred-loaded strips). The
    // anims.exists guards make every branch degrade to the walk-park below
    // until the background load lands and buildMonsterAnimations re-runs;
    // 6 of 24 kinds ship no angry at all and park between swings instead.
    // combatClip gates the per-frame walk-drift compensation: shift[]/air[]
    // are measured on the WALK/IDLE strips and must never index into an
    // attack frame.
    if (mstate === "die") {
      const dieAnim = mv.dieKey ? monsterAnimKey(mv.kind, mv.dieKey, d) : null;
      if (dieAnim && this.anims.exists(dieAnim)) {
        mv.combatClip = true;
        if (mv.sprite.anims.getName() !== dieAnim) mv.sprite.play(dieAnim);
        return;
      }
      // No die art: freeze on the parked contact frame (better than looping).
      mv.combatClip = false;
      mv.sprite.anims.stop();
      const skD = monsterSheetKey(mv.kind, mv.walkKey, d);
      const gD = mv.ground?.[d];
      if (this.textures.exists(skD)) mv.sprite.setTexture(skD, gD?.contact ?? 0);
      return;
    }
    if (mstate === "combat") {
      const attackAnim = mv.attackKey ? monsterAnimKey(mv.kind, mv.attackKey, d) : null;
      if (actionSeq !== (mv.lastActionSeq ?? 0)) {
        mv.lastActionSeq = actionSeq;
        if (attackAnim && this.anims.exists(attackAnim)) {
          mv.combatClip = true;
          mv.sprite.play(attackAnim); // restart even mid-clip: a new swing IS a restart
          return;
        }
      }
      // Let a running swing finish before falling back to the angry loop.
      const cur = mv.sprite.anims.getName();
      if (attackAnim && cur === attackAnim && mv.sprite.anims.isPlaying) {
        mv.combatClip = true;
        return;
      }
      const angryAnim = mv.angryKey ? monsterAnimKey(mv.kind, mv.angryKey, d) : null;
      if (angryAnim && this.anims.exists(angryAnim)) {
        mv.combatClip = true;
        if (cur !== angryAnim || !mv.sprite.anims.isPlaying) mv.sprite.play(angryAnim, true);
        return;
      }
      // No angry art (6 kinds): fall through to the stopped walk-park below.
    }
    mv.combatClip = false;
    mv.lastActionSeq = actionSeq;

    // Re-anchor to the ACTIVE STATE's measured ground contract for this
    // direction: idle strips are framed independently of walk (their own
    // stripDims + anchors), and per-direction margins differ after art
    // repairs. The feet stay planted through turns AND state changes.
    const g = (!moving && mv.groundIdle?.[d]) || mv.ground?.[d];
    if (g) mv.sprite.setOrigin(g.cx, g.f);
    const idleKey = !moving && mv.idleKey ? monsterAnimKey(mv.kind, mv.idleKey, d) : null;
    if (moving || (idleKey && this.anims.exists(idleKey))) {
      // Walking → walk clip; stopped with idle art → the IDLE clip
      // (maintainer 2026-07-30: "the idle animation doesn't play when
      // stopped"). Direction-only changes keep the loop progress.
      const state = moving ? mv.walkKey : mv.idleKey!;
      const key = moving ? monsterAnimKey(mv.kind, mv.walkKey, d) : idleKey!;
      if (!this.anims.exists(key)) return;
      if (mv.sprite.anims.getName() !== key || !mv.sprite.anims.isPlaying) {
        const prev = mv.sprite.anims.getName();
        const sameState = !!prev && mv.sprite.anims.isPlaying && prev.split(":").at(-2) === state;
        const progress = sameState ? mv.sprite.anims.getProgress() : 0;
        mv.sprite.play(key, true);
        if (progress > 0) mv.sprite.anims.setProgress(progress);
      }
    } else {
      // No idle art (legacy poring family): park on the walk strip's PLANTED
      // CONTACT FRAME (frame 0 is airborne for hop gaits — parked frogs
      // levitated above their shadow until the next trip).
      mv.sprite.anims.stop();
      const sk = monsterSheetKey(mv.kind, mv.walkKey, d);
      if (this.textures.exists(sk)) mv.sprite.setTexture(sk, g?.contact ?? 0);
    }
  }

  /** Stereo position of an avatar relative to the camera view — pan (-1..1)
   * and distance (0 at centre, 1 at the edge of earshot) for the composer's
   * spatialized one-shots. The local player is always centred. */
  private avatarSpatial(id: string | undefined): { pan: number; dist: number } {
    if (!id || id === this.room?.sessionId) return { pan: 0, dist: 0 };
    const av = id ? this.avatars.get(id) : undefined;
    if (!av) return { pan: 0, dist: 0.5 };
    return this.worldSpatial(av.sprite.x, av.sprite.y);
  }

  /** Pan/dist for any world-space point (monster deaths, grave crosses,
   * ground drops) — the same camera-relative math avatarSpatial uses. */
  private worldSpatial(sx: number, sy: number): { pan: number; dist: number } {
    const view = this.cameras.main.worldView;
    const nx = (sx - view.centerX) / Math.max(1, view.width * 0.55);
    const ny = (sy - view.centerY) / Math.max(1, view.height * 0.55);
    return {
      pan: Math.max(-1, Math.min(1, nx)),
      dist: Math.min(1, Math.hypot(nx, ny) * 0.75),
    };
  }

  /** Terrain mood around the player for the composer's ambience beds:
   * fractions (0..1) of forest / water / town cells in earshot, plus
   * campfire proximity. Sampled by the composer at ~4 Hz — keep it cheap
   * (a 15×15 cell window ≈ 225 string checks). */
  private sampleAudioField(): {
    forest: number; water: number; town: number; fire: number; cave: number; threat: number;
  } {
    const none = { forest: 0, water: 0, town: 0, fire: 0, cave: 0, threat: 0 };
    const g = this.terrain;
    const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
    if (!g || !me) return none;
    const cc = Math.floor(me.fx / CELL_WU);
    const cr = Math.floor(me.fy / CELL_WU);
    const R = 7;
    let forest = 0;
    let water = 0;
    let town = 0;
    let roofed = 0;
    let n = 0;
    // My own surface height, in LEVELS — the same px→level basis the lit copy
    // and torch use. A deck only counts as a roof when it is above ME, so
    // walking ACROSS a bridge (deck == my own surface) is never "in a cave".
    const myLevel = Math.max(0, me.elev / MAP_GEOMETRY.lh);
    for (let r = cr - R; r <= cr + R; r++) {
      if (r < 0 || r >= g.height) continue;
      for (let c = cc - R; c <= cc + R; c++) {
        if (c < 0 || c >= g.width) continue;
        n++;
        const i = r * g.width + c;
        // Roofed: a world@2 deck slab overhead (cave ceiling, house roof, the
        // span you are walking UNDER). 1.5 levels of clearance keeps a deck at
        // my own height — the bridge I am standing on — out of the count.
        const dk = g.deck?.[i] ?? -1;
        if (dk >= 0 && dk > myLevel + 1.5) roofed++;
        const t = g.type[i];
        if (!t) continue;
        if (
          t.includes("tree") || t.includes("forest") || t === "jungle" || t === "mushroom_grove"
        ) forest++;
        else if (surfaceFor(t).swimmable) water++;
        else if (t.startsWith("road_") || t === "mosaic_floor" || t === "farm" || t === "vineyard")
          town++;
      }
    }
    if (!n) return none;
    // Small fractions should already register (a lakeside has ~15% water
    // cells in earshot) — scale up and cap.
    const frac = (k: number) => Math.min(1, (k / n) * 3.2);
    let fire = 0;
    if (this.fireOn && this.campfire) {
      // campfire.x/y are projected screen px — measure in grid cells instead.
      const d = Math.hypot(me.fx / CELL_WU - this.campfire.col, me.fy / CELL_WU - this.campfire.row);
      fire = Math.max(0, 1 - d / 7);
    }
    // THREAT — am I in a FIGHT, for the battle bed. The monster brain's own
    // `mstate` is the honest signal: a monster that is merely roaming past is
    // scenery however close it gets, while one in `chase`/`combat` is hunting.
    // Proximity then decides whether the fight is MINE (a monster chasing
    // someone else across the valley must not score my music). Summed over
    // attackers so a pack reads hotter than a single donkey, and a dying
    // monster stops counting immediately so the music can let go.
    let threat = 0;
    if (this.monsters.size) {
      const mx = me.fx;
      const my = me.fy;
      this.monsters.forEach((mv) => {
        const w = mv.mstate === "combat" ? 1 : mv.mstate === "chase" ? 0.75 : 0;
        if (!w) return;
        const d = Math.hypot(mv.fx - mx, mv.fy - my);
        threat += w * Math.max(0, 1 - d / THREAT_NEAR_WU);
      });
      threat = Math.min(1, threat);
    }
    return {
      forest: frac(forest), water: frac(water), town: frac(town), fire,
      cave: frac(roofed), threat,
    };
  }

  /** The connection died: freeze input, rejoin in place (immediately when
   * visible, else the moment the tab is shown again), retry with backoff,
   * and only fall back to a full reload after repeated failures. */
  private handleDrop() {
    this.connected = false;
    this.showReconnectToast();
    const attempt = async () => {
      if (this.unloading) return;
      if (document.visibilityState !== "visible") {
        document.addEventListener("visibilitychange", () => void attempt(), { once: true });
        return;
      }
      try {
        const room = await joinWorld(
          { name: this.myName, character: this.myCharacter.uid, world: this.worldName },
        );
        // Clean slate: the new room's full state re-adds every player (new
        // sessionIds), so drop all old sprites + prediction/input state.
        for (const id of [...this.avatars.keys()]) this.removeAvatar(id);
        for (const id of [...this.monsters.keys()]) this.removeMonster(id);
        // Ground drops too: the fresh room re-sends its whole drops map via
        // onAdd — stale sprites from the dead room would double every item.
        for (const id of [...this.drops.keys()]) this.removeDrop(id);
        this.engagedId = null;
        this.pendingPickupId = null;
        this.selfDead = false;
        this.pending = [];
        this.inputSeq = 0;
        this.sendAccum = 0;
        this.lastSent = "";
        this.jumpQueued = false;
        this.clearMoveTarget();
        this.bindRoom(room);
        this.hideReconnectToast();
        this.chat.addLog("—", "Reconnected.");
      } catch {
        if (++this.reconnectRetries >= 6) {
          // Persistent failure — a clean reload (with the select-skip flag)
          // is the last resort, not the first.
          sessionStorage.setItem("ml-rejoin", "1");
          location.reload();
          return;
        }
        setTimeout(() => void attempt(), Math.min(15_000, 1000 * 2 ** this.reconnectRetries));
      }
    };
    void attempt();
  }

  private showReconnectToast() {
    if (this.reconnectToast) return;
    const el = document.createElement("div");
    el.textContent = "Reconnecting…";
    // Same SPOT and size family as main.ts's update banner (maintainer's
    // "perfect spot" — the open playfield just below the clock). top:340px is
    // DESIGN px (980-wide reference layout): the toast root is uiZoom'd
    // (design-width normalization, uiscale.ts), so on narrower clients the
    // plain px scales with k and stays below the clock disc, which shrinks
    // with the frame the same way (a plain top:150px sat ON the disc).
    el.style.cssText =
      "position:fixed;top:340px;left:50%;transform:translateX(-50%);z-index:100;" +
      "padding:14px 26px;border-radius:12px;background:#111114f2;border:2px solid #ffd678aa;" +
      "color:#ffd678;font:bold 19px system-ui,sans-serif;box-shadow:0 6px 24px #000c;" +
      "white-space:nowrap;pointer-events:none";
    document.body.appendChild(el);
    applyUiZoom(el);
    this.reconnectToast = el;
  }

  private hideReconnectToast() {
    this.reconnectToast?.remove();
    this.reconnectToast = undefined;
  }

  private showConnectionError(err: unknown) {
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    // This panel is scrollFactor(0), so Phaser scales it by the camera zoom
    // (base·rs) — its size is in ZOOM-LOCAL units. Cap by the ON-SCREEN width
    // (scale.width / zoom), not the device backing, or it overflows the screen
    // at rs>1 (device DPI) or base>1 (desktop). rs=1 phone base 1 = unchanged.
    const screenW = this.scale.width / (this.cameras.main.zoom || 1);
    const panel = this.add.rectangle(cx, cy, Math.min(560, screenW - 40), 150, 0x12121c, 0.92)
      .setScrollFactor(0).setStrokeStyle(2, 0xff6b6b).setDepth(1e9);
    const msg =
      "Can't reach the world server.\n\n" +
      "Is it running?  In dev, run  npm run dev  (starts server + client).\n" +
      "The server should be listening on :2567.";
    this.add.text(cx, cy, msg, {
      color: "#ffd0d0", fontFamily: "system-ui, sans-serif", fontSize: "15px", align: "center",
      wordWrap: { width: panel.width - 30 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1e9 + 1);
    console.error("[nangijala] failed to join world:", err);
  }

  /** A shooting star streaks across the visible sky — high above the world
   * (over the darkness overlay), additive glow with a fading particle tail,
   * echoed by a micro-star on the celestial dial. Arrivals carry a name
   * (chat-logged); wild night stars don't. Brightest at night. */
  private shootingStar(name?: string) {
    if (!this.textures.exists("star-spark")) {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      for (let i = 4; i >= 2; i--) g.fillStyle(0xffffff, 0.13).fillCircle(6, 6, 1.5 * i);
      g.fillStyle(0xffffff, 1).fillCircle(6, 6, 1.6);
      g.generateTexture("star-spark", 12, 12);
      g.destroy();
    }
    const view = this.cameras.main.worldView;
    const ltr = Math.random() < 0.5;
    const sx = view.x + view.width * (ltr ? 0.08 + Math.random() * 0.22 : 0.7 + Math.random() * 0.22);
    const sy = view.y + view.height * (0.08 + Math.random() * 0.16);
    const len = view.width * (0.32 + Math.random() * 0.16);
    const ang = ((12 + Math.random() * 16) * Math.PI) / 180;
    const bright = this.timeIdx === 0 ? 1 : 0.55; // night stars blaze, day ones shimmer
    const head = this.add
      .image(sx, sy, "star-spark")
      .setDepth(1_500_000)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(bright)
      .setScale(1.5);
    const tail = this.add
      .particles(0, 0, "star-spark", {
        lifespan: 480,
        speed: { min: 0, max: 8 },
        scale: { start: 0.9, end: 0 },
        alpha: { start: 0.7 * bright, end: 0 },
        frequency: 12,
        blendMode: Phaser.BlendModes.ADD,
      })
      .setDepth(1_499_999);
    tail.startFollow(head);
    this.tweens.add({
      targets: head,
      x: sx + (ltr ? 1 : -1) * Math.cos(ang) * len,
      y: sy + Math.sin(ang) * len,
      duration: 850 + Math.random() * 300,
      ease: "Sine.easeIn",
      onComplete: () => {
        tail.stopFollow();
        tail.stop();
        this.tweens.add({ targets: head, alpha: 0, scale: 0.2, duration: 250, onComplete: () => head.destroy() });
        this.time.delayedCall(600, () => tail.destroy());
      },
    });
    clockStar();
    if (name) this.chat.addLog("⭐", `${name} has arrived in Nangijala — a star crosses the sky.`);
  }

  private showBubble(id: string, text: string) {
    const av = this.avatars.get(id);
    if (!av) return;
    av.bubble?.destroy();
    const bubble = this.add
      .text(av.sprite.x, av.sprite.y, text, {
        fontFamily: "system-ui, sans-serif",
        fontSize: "13px",
        color: "#12121c",
        backgroundColor: "#f4f4ff",
        padding: { x: 7, y: 4 },
        align: "center",
        wordWrap: { width: 180 },
      })
      .setOrigin(0.5, 1)
      .setDepth(1e9);
    av.bubble = bubble;
    av.bubbleUntil = this.time.now + BUBBLE_MS;
  }

  /** The online-players panel is GONE (maintainer) — arrivals still show as
   * shooting stars + chat lines; this stub keeps the call sites cheap. */
  private refreshRoster() {}

  private addAvatar(id: string, player: any) {
    const uid: string = player.character || this.manifest.characters[0]?.uid || PLACEHOLDER_TEX;
    const key = frameKey(uid, "idle", DEFAULT_DIRECTION, 0);
    const f0 = this.projectFlat(player.x, player.y);
    const elev0 = f0.lvl * MAP_GEOMETRY.lh;
    const p0 = { x: f0.x, y: f0.y - elev0 };
    // Fall back to the built-in wanderer whenever the character's art is absent
    // (empty roster, a deleted character, or art still loading). Tint it per
    // name so same-named wanderers stay distinguishable.
    const hasArt = this.textures.exists(key);
    const sprite = this.add.sprite(p0.x, p0.y, hasArt ? key : PLACEHOLDER_TEX);
    const baseTint = hasArt ? 0xffffff : colorForName(player.name || id);
    sprite.setTint(baseTint);
    // Footstep marks: stamp on the measured foot-plant frames (see
    // footsteps.ts). Listener per avatar sprite — remote players stamp too.
    sprite.on(Phaser.Animations.Events.ANIMATION_UPDATE, (_a: unknown, frame: Phaser.Animations.AnimationFrame) =>
      this.onPlantFrame(uid, sprite, frame),
    );
    // Pin the sprite at the measured foot anchor (sole line) so the drawn feet
    // sit exactly on the collision position; fall back to a sane default.
    this.applyAnchor(sprite, uid, DEFAULT_DIRECTION, hasArt);
    const label = this.add
      .text(p0.x, p0.y, player.name, { fontFamily: "monospace", fontSize: "12px", color: "#eef" })
      .setOrigin(0.5, 1)
      .setDepth(890_000); // names stay readable above occluding tiles
    // Drop shadow at the collision anchor — marks the exact ground position.
    const shadow = this.add.image(p0.x, p0.y, SHADOW_TEX).setOrigin(0.5, 0.5).setDisplaySize(30, 12);
    this.avatars.set(id, {
      sprite,
      shadow,
      label,
      character: uid,
      lx: p0.x,
      ly: p0.y,
      lyFlat: f0.y,
      elev: elev0,
      fallV: 0,
      falling: false,
      fx: player.x,
      fy: player.y,
      hopUntil: 0,
      swimming: false,
      swimT: 0,
      bobPhase: (uid.charCodeAt(0) + uid.length * 7) % 100, // deterministic per char
      baseTint,
      // Seed the combat counters from the synced values (monsters do the
      // same): a fighter's actionSeq/hitSeq are already >0 when a joiner
      // first sees them, and an unseeded 0 would replay one stale
      // kick/punch/pickup/flinch the moment the avatar appears.
      lastActionSeq: player.actionSeq ?? 0,
      lastHitSeq: player.hitSeq ?? 0,
      lastHp: player.hp,
    });
    this.applyAnimState(this.avatars.get(id)!, player.moving, player.running, player.dir, false);
  }

  update(_time: number, delta: number) {
    this.redrawGround();
    this.rebuildOccluders();
    if (!this.room) return;
    const dt = delta / 1000;
    const myId = this.room.sessionId;
    this.predictAndSend(dt);

    const state = this.room.state as any;
    if (!state?.players) return; // first frame after join, before the state syncs

    // World mood → composer: sun strength drives day/night beds + the music's
    // night dip; swimming muffles the whole mix (underwater insert).
    // Name-matched (not index) so weather-list reordering can't break audio.
    const wn = WEATHER_NAMES[this.weatherIdx % WEATHER_NAMES.length] as string;
    gameAudio.setEnv({
      sun: this.curSun[3],
      cloud: this.curCloud,
      mist: this.curMist,
      rain: wn === "Drizzle" ? 0.35 : wn === "Rain" ? 0.7 : wn === "Heavy rain" || wn === "Storm" ? 1 : 0,
      storm: wn === "Storm",
      snow: wn === "Snowing",
      windy: wn === "Windy",
    });
    gameAudio.setUnderwater(!!state.players.get(myId)?.swimming);

    this.avatars.forEach((av, id) => {
      const player = state.players.get(id);
      if (!player) return;

      let tx: number;
      let ty: number;
      let moving: boolean;
      let running: boolean;
      let dir: string;
      let surfLevel: number; // the surface LEVEL the avatar stands on (deck vs base)

      if (id === myId) {
        // Reconcile: start from the authoritative position and replay every
        // input the server hasn't acked yet, so the local player is responsive
        // but never drifts from the server.
        this.pending = this.pending.filter((p) => p.seq > player.seq);
        // Zombie-connection guard: with a dead room nothing is ever acked and
        // this list (and the per-frame replay cost) grows without bound. The
        // onLeave handler reloads soon; keep the tail bounded meanwhile.
        if (this.pending.length > 400) this.pending.splice(0, this.pending.length - 400);
        let rx = player.x;
        let ry = player.y;
        // world@2 decks: predict the surface elevation alongside x,y so the local
        // player walks ON a deck (not through it) and renders at the right height
        // — mirrors the server's canEnterElev/resolveElevAt exactly.
        let predElev = player.elev ?? 0;
        const jumpingNow = this.time.now < this.jumpUntil;
        // Each input replays with the jump state it was ORIGINALLY integrated
        // under (see the `pending` field note) — using "jumping right now" for
        // historical inputs rolled the anchor back below ledges after landing.
        // The hit stagger mirrors the server through the SYNCED factor — both
        // sides multiply the same stepMovement speedScale. Historical inputs
        // must replay under the factor they were ORIGINALLY integrated with
        // (like `jumping`): replaying an RTT-deep pending buffer with the
        // CURRENT factor rewrote history at every slow onset/expiry — a
        // rubber-band tug backward on the hit (fine, reads as hit-stop) and
        // an uncommanded forward teleport when the slow expired (not fine,
        // fired exactly as you broke free of a chase).
        this.curSlowFactor = player.slow || 1;
        const stepLocal = (ax: number, ay: number, running: boolean, sdt: number, jumping: boolean, slowF: number) => {
          let blocked;
          let sideBlocked;
          let speed = 1;
          if (this.terrain) {
            // Mirror the server exactly: unstick before integrating.
            const u = unstickFromSolids(this.terrain, rx, ry, 80 * sdt);
            rx = u.x;
            ry = u.y;
            const ctx = { maxClimb: jumping ? JUMP_CLIMB : WALK_CLIMB, canSwim: true };
            blocked = makeBlockedElev(this.terrain, ctx, () => predElev);
            sideBlocked = makeSideBlocked(this.terrain, ctx); // corner probes: solids only
            speed =
              surfaceAtWorld(this.terrain, rx, ry).speed *
              (jumping ? JUMP_SPEED_FACTOR : 1) *
              slowF;
          }
          // screenInput matches the server: on the iso world, input is screen-relative.
          const r = stepMovement(rx, ry, ax, ay, running, sdt, blocked, speed, !!this.terrain, this.worldW, this.worldH, sideBlocked);
          rx = r.x;
          ry = r.y;
          if (this.terrain) {
            const ctx = { maxClimb: jumping ? JUMP_CLIMB : WALK_CLIMB, canSwim: true };
            predElev = resolveElevAt(this.terrain, predElev, rx, ry, ctx);
          }
        };
        for (const p of this.pending) stepLocal(p.ax, p.ay, p.running, p.dt, p.jumping, p.slow);
        // Integrate the not-yet-sent input tail too, so the local player moves
        // every FRAME (60fps-smooth) instead of only at the 20Hz send tick.
        if (this.sendAccum > 0)
          stepLocal(this.lastInput.ax, this.lastInput.ay, this.lastInput.running, this.sendAccum, jumpingNow, this.curSlowFactor);
        tx = rx;
        ty = ry;
        surfLevel = predElev;
        // Animate from live input for instant turn/walk feedback.
        const li = this.lastInput;
        moving = li.ax !== 0 || li.ay !== 0;
        running = li.running && moving;
        dir = (moving ? vectorToDirection(li.ax, li.ay) : null) ?? player.dir;
      } else {
        tx = player.x;
        ty = player.y;
        surfLevel = player.elev ?? 0;
        moving = player.moving;
        running = player.running;
        dir = player.dir;
      }

      // --- COMBAT SIGNALS (both self and remote) -------------------------
      // One-shot clips ride action/actionSeq; hits ride hitSeq; death rides
      // dead. All server-owned — the client only ever mirrors.
      const nowMs = this.time.now;
      if ((player.actionSeq ?? 0) !== (av.lastActionSeq ?? 0)) {
        av.lastActionSeq = player.actionSeq;
        if (player.action === "attack") {
          // Unarmed: pseudo-random kick/punch, deterministic from the synced
          // swing counter so every client shows the same move (shared
          // unarmedClip; no weapons yet — maintainer).
          av.actionKey = unarmedClip(player.actionSeq, idSalt(id));
          av.actionUntil = nowMs + 600;
          // SILENT semantic events (composer plays nothing until the Game
          // Master assigns a sound in the wiki — engine/api.ts). Two literal
          // names, not a ternary: the wiki lists events by scanning literal
          // gameAudio.event("...") call sites.
          const spA = this.avatarSpatial(id);
          if (av.actionKey === "kick") gameAudio.event("combat.kick", { pan: spA.pan, dist: spA.dist });
          else gameAudio.event("combat.punch", { pan: spA.pan, dist: spA.dist });
        } else if (player.action === "pickup") {
          av.actionKey = "pickup";
          av.actionUntil = nowMs + 850;
          const spP = this.avatarSpatial(id);
          gameAudio.event("item.pickup", { pan: spP.pan, dist: spP.dist });
        } else if (player.action === "die") {
          av.actionKey = "die";
          av.actionUntil = nowMs + 10_000; // held below while dead anyway
          const spD = this.avatarSpatial(id);
          gameAudio.event("player.die", { pan: spD.pan, dist: spD.dist });
        }
      }
      if ((player.hitSeq ?? 0) !== (av.lastHitSeq ?? 0)) {
        const first = av.lastHitSeq === undefined;
        av.lastHitSeq = player.hitSeq;
        if (!first && !player.dead) {
          // The flinch — unless a stronger clip (attack/die) is mid-play.
          // FAST since round 7 (16fps clip, short overlay window)…
          if (!av.actionUntil || nowMs >= av.actionUntil || av.actionKey === "hurt") {
            av.actionKey = "hurt";
            av.actionUntil = nowMs + 300;
          }
          // …with the blood ON the body (maintainer round 7).
          this.spawnBloodFx(av.lx, av.sprite.y - av.sprite.displayHeight * 0.45);
          const spH = this.avatarSpatial(id);
          gameAudio.event("combat.hit_taken", { pan: spH.pan, dist: spH.dist });
        }
      }
      if ((av.lastHp ?? player.hp) > player.hp)
        this.spawnDamageFloat(av.lx, av.sprite.y - av.sprite.displayHeight * 0.8, `${Math.round((av.lastHp ?? player.hp) - player.hp)}`, 0xf25d5d);
      av.lastHp = player.hp;
      if (player.dead) {
        // Death: the die clip HOLDS (no overlay expiry) until the server
        // revives us; movement input is pointless meanwhile.
        av.actionKey = "die";
        av.actionUntil = nowMs + 1000;
        moving = false;
        running = false;
        if (id === myId && !this.selfDead) {
          this.selfDead = true;
          this.clearMoveTarget();
          this.dropHold();
          this.engagedId = null;
          this.pendingPickupId = null; // no surprise auto-grab after respawn
        }
      } else {
        // Respawn: the hold-loop above kept re-arming the die overlay ~1s
        // ahead, so without this clear the revived avatar walks around as a
        // corpse until it expires — every client, not just our own.
        if (av.actionKey === "die") {
          av.actionKey = undefined;
          av.actionUntil = 0;
        }
        if (id === myId && this.selfDead) {
          this.selfDead = false; // respawned: the >2-cell snap does the rest
        }
      }

      // Facing in a fight: a stationary engaged player LOOKS AT its target
      // (the circling monster sweeps around, so this is what makes the
      // kick/punch directions vary — the other half of the maintainer's
      // circling idea).
      if (id === myId && this.engagedId && !moving && !player.dead) {
        const tgt = this.monsters.get(this.engagedId);
        if (tgt) dir = faceDirWorld(av.fx, av.fy, tgt.fx, tgt.fy) ?? dir;
      } else if (id === myId && this.pendingPickupId && !moving && !player.dead) {
        // …and a player grabbing an item TURNS TO it (maintainer 2026-08-05:
        // "always turn/face the item currently being picked up").
        const d = this.drops.get(this.pendingPickupId);
        if (d) dir = faceDirWorld(av.fx, av.fy, d.wx, d.wy) ?? dir;
      }

      // HUD: hp/ep/xp/level are server-owned; push only on change (DOM).
      if (id === myId) {
        const sig = `${player.hp}|${player.hpMax}|${player.ep}|${player.epMax}|${player.xp}|${player.level}`;
        if (sig !== this.lastHudSig) {
          this.lastHudSig = sig;
          setBar("hp", Math.ceil(player.hp), player.hpMax);
          setBar("ep", Math.floor(player.ep), player.epMax);
          setBar("xp", Math.floor(player.xp), xpToNext(player.level));
          setLevel(player.level);
        }
      }

      // Project onto the iso ground with the FLAT (unlifted) point + cell level
      // kept apart: ease the horizontal + flat ground toward the target, but
      // animate the elevation lift separately so a cliff descent FALLS under
      // gravity instead of the anchor snapping down a level. `av.ly` stays the
      // lifted feet y (flat − elevation) every other consumer expects.
      av.fx = tx;
      av.fy = ty;
      const g = this.projectFlat(tx, ty);
      // Swimming FLOAT depth: while over water the fall settles BELOW the
      // surface so this direction's shoulder waterline lands at the water
      // level — the feet sink `swimDrop` px under THE POOL'S OWN surface
      // (surfLevel·lh): an elevated mountain lagoon floats you at ITS rim, not
      // at sea level (the old absolute -swimDrop target sank a level-4 pool's
      // swimmer 4 whole levels — she vanished into the cliff). Falling in from
      // a ledge still submerges progressively (gravity carries the body through
      // the surface) and STOPS (buoyancy) at the shoulder line. swimDir = the
      // DISPLAYED facing, so the waterline matches the drawn frame.
      const swimming = !!player.swimming;
      av.swimming = swimming;
      const swimDir = av.dispDir ?? dir;
      let swimDrop = 0;
      if (swimming) {
        const { def, s } = this.waterlineFor(av.character, swimDir);
        const anchor = def?.anchors?.[swimDir] ?? def?.anchors?.[DEFAULT_DIRECTION] ?? { x: 0.5, y: 0.9 };
        const fh = def?.frameH ?? 112;
        const t = s.rx !== s.lx ? (anchor.x - s.lx) / (s.rx - s.lx) : 0.5;
        const waterYFrac = s.ly + (s.ry - s.ly) * Math.max(0, Math.min(1, t));
        swimDrop = Math.max(0, (anchor.y - waterYFrac) * fh * av.sprite.scaleY);
      }
      // world@2: lift by the SURFACE level (deck when standing on it, else base),
      // not the cell's base level — so a player on the roof/bridge draws up there.
      const targetElev = surfLevel * MAP_GEOMETRY.lh - (swimming ? swimDrop : 0);
      // JUMP OUT of the water, don't teleport: reaching land from a swim means
      // the feet must rise ~swimDrop back to the surface. Ease that rise over a
      // short arc + a hop so it reads as leaping out instead of snapping up.
      if (av.wasSwimming && !swimming && av.elev < targetElev - 1) {
        av.exitJumpUntil = this.time.now + EXIT_JUMP_MS;
        if (av.hopUntil <= this.time.now) {
          av.hopUntil = this.time.now + JUMP_MS;
          const sp = this.avatarSpatial(id);
          gameAudio.event("player.jump", { pan: sp.pan, dist: sp.dist, voice: av.character });
        }
      }
      av.wasSwimming = swimming;
      // A big horizontal jump (respawn/teleport) is not a walk — snap, don't
      // ease or fall, so the character doesn't skate/plummet across the map.
      let snapped = false;
      if (Math.abs(g.x - av.lx) > CELL_WU * 2 || Math.abs(g.y - av.lyFlat) > CELL_WU * 2) {
        snapped = true;
        av.lx = g.x;
        av.lyFlat = g.y;
        av.elev = targetElev;
        av.fallV = 0;
        av.falling = false;
        av.wasFalling = false; // a teleport landing must not swallow the next fall grunt
        av.exitJumpUntil = 0; // a teleport cancels any in-progress leap-out
        av.spdWu = undefined; // a teleport is not a speed sample
        // A respawn/teleport also cancels MY tap trip + hold gesture: the
        // autopilot must never run the player back toward the pre-jump target
        // (maintainer: after respawn she ran straight back to the stale
        // tapped point and wedged again).
        if (id === myId && (this.trip || this.holdPointerId !== null)) {
          this.clearMoveTarget();
          this.dropHold();
        }
      } else {
        const px0 = av.lx;
        const py0 = av.lyFlat;
        const k = Math.min(1, dt * (id === myId ? 45 : 12));
        av.lx += (g.x - av.lx) * k;
        av.lyFlat += (g.y - av.lyFlat) * k;
        if (this.time.now < (av.exitJumpUntil ?? 0)) {
          // Leaping out of the water: rise smoothly to land (matched to the hop
          // arc) instead of the gravity snap.
          av.elev += (targetElev - av.elev) * (1 - Math.exp(-dt / 0.08));
          if (Math.abs(av.elev - targetElev) < 0.5) av.elev = targetElev;
          av.fallV = 0;
          av.falling = false;
        } else {
          this.stepElevation(av, targetElev, dt);
        }
        // Fall-start grunt: the SAME voice as a jump when she steps off a
        // ledge into a gravity fall (maintainer). Rising edge only; the
        // engine debounce dedupes a jump that flows into a fall.
        if (av.falling && !av.wasFalling) {
          const sp = this.avatarSpatial(id);
          gameAudio.event("player.fall", { pan: sp.pan, dist: sp.dist, voice: av.character });
        }
        av.wasFalling = av.falling;
        // Ground speed in WORLD units/s, back-projected from the EASED flat
        // screen delta (smooth for remote 20Hz-stepped targets too):
        // Δsx = Δ(x−y)·dx/CELL_WU, Δsy = Δ(x+y)·dy/CELL_WU — invert, so a
        // screen-north walk (vertical, iso-compressed) counts the full
        // ~2.13× world ground it actually covers. On the plain fallback
        // ground the projection is identity. EMA (~125ms) irons out easing
        // ripple; applyAnimState turns it into gait-playback timeScale.
        if (dt > 0.001) {
          const dsx = av.lx - px0; // = Δ(x−y)·dx/CELL_WU (dx == CELL_WU → 1:1)
          const dsy = av.lyFlat - py0; // = Δ(x+y)·dy/CELL_WU
          const dSum = dsy * (CELL_WU / MAP_GEOMETRY.dy); // Δ(x+y)
          const v = this.world
            ? Math.hypot((dsx + dSum) / 2, (dSum - dsx) / 2) / dt
            : Math.hypot(dsx, dsy) / dt;
          av.spdWu = av.spdWu === undefined ? v : av.spdWu + (v - av.spdWu) * Math.min(1, dt * 8);
        }
      }
      av.ly = av.lyFlat - av.elev;

      // STEP-HOP: a 1-level surface-level change (up or down) that ISN'T a real jump
      // (a ≥2-level climb is player.jumping, handled below) fires the QUICK cosmetic
      // hop — jump anim + jump sound + a small arc — so a single step reads as a
      // lively hop while the player keeps FULL walk/run speed (movement untouched).
      // Driven off the SYNCED surface level, so every client plays the same hop for
      // every avatar; teleports (snapped) and swimming don't hop.
      const lvlNow = Math.round(surfLevel);
      if (
        !snapped &&
        !swimming &&
        av.stepLvl !== undefined &&
        Math.abs(lvlNow - av.stepLvl) === 1 &&
        !player.jumping &&
        av.hopUntil <= this.time.now
      ) {
        av.hopUntil = this.time.now + STEP_HOP_MS;
        av.hopDur = STEP_HOP_MS;
        av.hopH = STEP_HOP_HEIGHT;
        const sp = this.avatarSpatial(id);
        gameAudio.event("player.jump", { pan: sp.pan, dist: sp.dist, voice: av.character });
      }
      av.stepLvl = lvlNow;

      // Submerge amount: 0 = feet at the surface, 1 = shoulders at the surface
      // (fully floating). Tied to how far the fall has sunk the feet below the
      // POOL'S OWN surface (surfLevel·lh — not absolute 0, or an elevated
      // lagoon would read as instantly/never submerged), so a ledge drop
      // submerges progressively then floats.
      av.swimT = swimDrop > 0
        ? Math.max(0, Math.min(1, (surfLevel * MAP_GEOMETRY.lh - av.elev) / swimDrop))
        : swimming ? 1 : 0;

      // Jump hop: a short parabola driven by the synced `jumping` flag —
      // RISING-EDGE triggered. Re-arming whenever the flag was still true
      // after the hop expired replayed a whole second hop when a state patch
      // arrived late (the flag outlives the local 500ms window by a frame on
      // jittery links): the "jumps again after landing on the hill" bug.
      if (player.jumping && !av.wasJumping && av.hopUntil <= this.time.now) {
        av.hopUntil = this.time.now + JUMP_MS;
        av.hopDur = JUMP_MS;
        av.hopH = JUMP_HEIGHT;
        // Sound exactly when the visual hop starts (synced flag = same
        // trigger for every client), spatialized for other players.
        const sp = this.avatarSpatial(id);
        gameAudio.event("player.jump", { pan: sp.pan, dist: sp.dist, voice: av.character });
      }
      av.wasJumping = !!player.jumping;
      const hopLeft = av.hopUntil - this.time.now;
      const hop = hopLeft > 0 ? Math.sin((1 - hopLeft / (av.hopDur ?? JUMP_MS)) * Math.PI) * (av.hopH ?? JUMP_HEIGHT) : 0;

      // Gentle head bob while afloat; the float depth is already baked into
      // av.ly (via the negative water elevation), so only the bob is added
      // here. Everything below the shoulder line is clipped by updateWaterClip,
      // which raises the waterline feet→shoulders with swimT. No blue tint —
      // only the head/shoulders show and they're ABOVE the water.
      av.sprite.setTint(av.baseTint);
      av.sprite.x = av.lx;
      const bob = swimming ? Math.sin(this.time.now / 850 + av.bobPhase) * SWIM_BOB * av.swimT : 0;
      av.sprite.y = av.ly - (swimming ? 0 : hop) + bob;
      this.updateWaterClip(av, swimDir, av.swimT);
      // The SURFACE level the sprite stands on (the deck when on a bridge/roof,
      // else the base terrain). Using the base here made a deck the player walks
      // ON count as a "higher" occluder that drew over their legs.
      av.surfLevel = surfLevel; // for lighting: swimmers sample HERE, not the sunk elev
      this.resolveBodyDepth(av, surfLevel);
      this.placeBodyShadow(av, targetElev, hop, 34, 14, 9, 4);
      av.shadow.setVisible(!av.swimming);
      // Head top (measured from the art), not the frame top — labels hug the
      // character instead of floating over transparent padding.
      const topFrac = (av.sprite.getData("topFrac") as number) ?? 0;
      const topY = av.sprite.y - av.sprite.displayHeight * (av.sprite.originY - topFrac);
      av.label.setPosition(av.lx, topY - 4);
      if (id === myId) {
        if (!this.posLabel)
          this.posLabel = this.add
            .text(0, 0, "", {
              fontFamily: "monospace",
              fontSize: "10px",
              color: "#cfd6ff",
              stroke: "#000000",
              strokeThickness: 3,
            })
            .setOrigin(0.5, 0)
            .setDepth(900_100);
        this.posLabel
          .setPosition(av.lx, av.ly + 4)
          // World id on a 2nd line — so it's always obvious WHICH world you're on
          // (worlds differ in scale: occlusion_test tops out at level 7, the_island 19).
          .setText(`${(av.fx / CELL_WU).toFixed(1)}, ${(av.fy / CELL_WU).toFixed(1)}\n${this.worldName}`);
      }
      if (av.bubble) {
        av.bubble.setPosition(av.lx, topY - 18);
        if (this.time.now > (av.bubbleUntil ?? 0)) {
          av.bubble.destroy();
          av.bubble = undefined;
        }
      }
      // Swimming plays the idle clip ("swim = modified idle", maintainer): the
      // legs are underwater/clipped, so a gait would just churn invisibly — the
      // visible head + shoulders bob (float offset above), reading as swimming.
      this.applyAnimState(av, moving && !av.swimming, running && !av.swimming, dir, hopLeft > 0 || av.falling);

      // Feed the composer's gait tracker: footfalls trigger on the walk/run
      // clip's plant phases (animPhase) so sound locks to the VISIBLE
      // stride; distance cadence is only the placeholder fallback. Water
      // enter/exit become splashes; remote players pan by screen pos.
      const sp = this.avatarSpatial(id);
      const animName = av.sprite.anims.getName();
      const gaitState = animName ? animName.split(":").at(-2) : undefined;
      const inGait = (gaitState === "walk" || gaitState === "run") && av.sprite.anims.isPlaying;
      // The wet shoreline band: a walkable tile with water within one cell
      // (the maps' shore transition tiles) — footsteps go wet there.
      let wetGround = false;
      if (this.terrain) {
        for (const [ox, oy] of [[CELL_WU, 0], [-CELL_WU, 0], [0, CELL_WU], [0, -CELL_WU]]) {
          if (surfaceAtWorld(this.terrain, tx + ox, ty + oy).swimmable) {
            wetGround = true;
            break;
          }
        }
      }
      gameAudio.avatarFrame(id, {
        moving,
        running,
        grounded: hopLeft <= 0 && !av.falling,
        swimming: av.swimming,
        surface: this.terrain ? surfaceAtWorld(this.terrain, tx, ty).sound : "grass",
        wetGround,
        distWu: (av.spdWu ?? 0) * dt,
        speedWu: av.spdWu ?? 0,
        animPhase: inGait ? av.sprite.anims.getProgress() : undefined,
        pan: sp.pan,
        dist: sp.dist,
      });
    });

    // Roaming monsters: authoritative server positions, eased exactly like a
    // remote player (rate 12, snap on a big jump). Server owns the movement —
    // the client only interpolates + renders the hop.
    const monsterState = state.monsters;
    if (monsterState) {
      // CAMERA GATE (see MONSTER_CULL_SLACK): the view in world coords, grown
      // by the hysteresis slack. Zoom is already baked into worldView.
      const mview = this.cameras.main.worldView;
      const vL = mview.x - MONSTER_CULL_SLACK;
      const vR = mview.right + MONSTER_CULL_SLACK;
      const vT = mview.y - MONSTER_CULL_SLACK;
      const vB = mview.bottom + MONSTER_CULL_SLACK;
      let active = 0;
      this.monsters.forEach((mv, id) => {
        const m = monsterState.get(id);
        if (!m) return;
        mv.fx = m.x;
        mv.fy = m.y;
        const g = this.projectFlat(m.x, m.y);
        const targetElev = (m.elev ?? g.lvl) * MAP_GEOMETRY.lh;
        // Is any of this body's art inside the view? The anchor is at the FEET,
        // so the sprite occupies [y-h, y] and the shadow — which can be WIDER
        // than the sprite (a mammoth's ellipse spans ~190px) — straddles it.
        const sp = mv.sprite;
        const halfW =
          Math.max(sp.displayWidth, mv.shadowW * MONSTER_SHADOW_SPREAD) * 0.5;
        const ay = g.y - targetElev - mv.hoverPx; // where it WILL be drawn
        const onScreen =
          g.x + halfW >= vL &&
          g.x - halfW <= vR &&
          ay + mv.shadowH >= vT &&
          ay - sp.displayHeight <= vB;
        if (!onScreen) {
          // PARKED: no anim, no depth ray, no shadow, no lit copy, no draw.
          // The position still tracks the server exactly (snapped, not eased —
          // easing off-screen is invisible work, and snapping guarantees the
          // body re-enters the view already where it belongs).
          mv.lx = g.x;
          mv.lyFlat = g.y;
          mv.elev = targetElev;
          mv.fallV = 0;
          mv.falling = false;
          mv.ly = mv.lyFlat - mv.elev;
          sp.x = mv.lx;
          sp.y = ay;
          mv.surfLevel = m.elev ?? g.lvl;
          // Track hp while parked too, or damage dealt off-screen aggregates
          // into one phantom float the frame the body scrolls back into view.
          mv.lastHp = m.hp;
          if (!mv.culled) {
            mv.culled = true;
            sp.setVisible(false);
            mv.shadow.setVisible(false);
            mv.lit?.setVisible(false);
            mv.hpBg?.setVisible(false);
            mv.hpFill?.setVisible(false);
            mv.lvText?.setVisible(false);
            mv.hpText?.setVisible(false);
            // Phaser's UpdateList advances anims on invisible sprites too.
            sp.anims.pause();
          }
          return;
        }
        if (mv.culled) {
          mv.culled = false;
          sp.setVisible(true);
          mv.shadow.setVisible(true);
          sp.anims.resume();
        }
        active++;
        if (Math.abs(g.x - mv.lx) > CELL_WU * 2 || Math.abs(g.y - mv.lyFlat) > CELL_WU * 2) {
          // A respawn/reslot teleport — snap, don't ease across the map.
          mv.lx = g.x;
          mv.lyFlat = g.y;
          mv.elev = targetElev;
          mv.fallV = 0;
          mv.falling = false;
        } else {
          const k = Math.min(1, dt * 12);
          mv.lx += (g.x - mv.lx) * k;
          mv.lyFlat += (g.y - mv.lyFlat) * k;
          // Elevation eases/falls via the shared integrator, like avatars.
          const s = integrateFall(
            { elev: mv.elev, fallV: mv.fallV, falling: mv.falling },
            targetElev,
            dt,
            MAP_GEOMETRY.lh,
          );
          mv.elev = s.elev;
          mv.fallV = s.fallV;
          mv.falling = s.falling;
        }
        mv.ly = mv.lyFlat - mv.elev;
        mv.sprite.x = mv.lx;
        // Winged flyers levitate hoverPx above the ground anchor; the nadir
        // shadow stays ON the ground (placeBodyShadow gets the hover as air
        // height, so it shrinks/fades slightly — the bird pattern).
        mv.sprite.y = mv.ly - mv.hoverPx;
        // SHARED body pipeline (same code as players — maintainer 2026-07-29:
        // the naive painter depth drew terrace tiles over monsters and their
        // shadows in front): occluder-aware depth + landing-ground shadow.
        const sLvl = m.elev ?? g.lvl;
        mv.surfLevel = sLvl; // occluder + light sampling basis (LEVELS)
        this.playMonsterAnim(mv, !!m.moving, m.dir, m.mstate ?? "roam", m.actionSeq ?? 0);
        // PER-FRAME drift compensation (the safe equivalent of the player
        // art's nadir postprocess — measured in the manifest, art untouched):
        // pin THIS frame's own body-mass origin-x so baked horizontal
        // translation never slides the body off its shadow; per-frame `air`
        // (deepest point risen vs the planted frame) feeds the hop shrink so
        // real levitation (demon stone, hops) reads as airborne on purpose.
        // NEVER during a combat clip: shift[]/air[] are indexed by WALK/IDLE
        // frame numbers and an attack strip has different counts.
        const gd = mv.combatClip
          ? undefined
          : (!m.moving && mv.groundIdle?.[mv.dispDir]) || mv.ground?.[mv.dispDir];
        const fi = parseInt(String(mv.sprite.frame.name), 10) || 0;
        const ox = gd?.shift?.[fi];
        if (ox !== undefined) mv.sprite.setOrigin(ox, gd!.f);
        const airPx = gd?.air?.[fi] ?? 0;
        // Damage float + blood + hp bar (RO: you SEE the number and the wound).
        if (mv.lastHp !== undefined && m.hp < mv.lastHp) {
          this.spawnDamageFloat(mv.lx, mv.sprite.y - mv.sprite.displayHeight * mv.sprite.originY, `${mv.lastHp - m.hp}`, 0xffe08a);
          this.spawnBloodFx(mv.lx, mv.sprite.y - mv.sprite.displayHeight * 0.45);
        }
        mv.lastHp = m.hp;
        this.updateMonsterHpBar(mv, m, id);
        this.resolveBodyDepth(mv, sLvl);
        // Shadow ellipse is PER DIRECTION (an east mammoth's footprint spans
        // ~140px, its south one ~90 — one size can't fit both facings).
        // ONE constant ellipse per monster (maintainer: no size changes on
        // turns or walk<->idle) — soft smear comes from texture + spread.
        const gw = mv.shadowW * MONSTER_SHADOW_SPREAD;
        const gh = mv.shadowH * MONSTER_SHADOW_SPREAD;
        this.placeBodyShadow(mv, targetElev, mv.hoverPx + airPx, gw, gh);
        // The anchor is the CONTACT CENTROID (between the foot undersides);
        // the front toes plant `sink` px below it. Lift the ellipse so its
        // south rim kisses the toe line — but NEVER above the contact band
        // (`up` + 3): a monolith's compact base keeps its ellipse centred on
        // the base instead of floating half-a-height up the rock ("the big
        // demon stone is flying", round 5).
        mv.shadow.y -= Math.max(
          0,
          Math.min(gh / 2 - (gd?.sink ?? 2) - 2, (gd?.up ?? 99) + 3),
        );
      });
      this.monstersActive = active;
    }

    // Sword marker + target frame + aggro-radius debug rings (all read the
    // freshly-updated monster sprites above).
    this.updateTargetOverlays();
    // Grave crosses (appear → hold → reverse) + the drop end-of-life flash.
    this.stepGroundDecor();

    this.updateChaseCam(delta);

    // See-through tall geometry above the player's level (occlusion fade).
    this.updateOcclusionFade();

    // Night lighting (always on): per-pixel point lights with heightmap
    // line-of-sight when WebGL is available; the multiply grade otherwise.
    const shaderNight = !!this.night;
    this.night?.setActive(shaderNight);
    this.atmo.suppressGrade = shaderNight;
    if (shaderNight && this.world) {
      const sl: ShaderLight[] = [];
      // Debug-only probe light (set via __ml.probeLight) — lets headless
      // verification place a light at an exact grid position, since walking
      // there is dt-clamped to a crawl on slow headless clients.
      if (this.probeLight) sl.push(this.probeLight);
      if (this.campfire && this.fireOn) {
        const c = this.campfire;
        // Overbright core: the shader clamps the multiplier at 1.25, so values
        // >1 widen the hot plateau around the fire (ref: bright ~2 cells, then
        // a fast falloff into the ember-red rim).
        sl.push({ col: c.col, row: c.row, z: c.z, radius: 7, color: [1.9, 0.88, 0.3], flicker: 1 });
      }
      // Torches fill the remaining slots (emission glow pools live in the
      // additive glow field, not in light slots — they can't be crowded out).
      const tf = this.curTorchF;
      for (const [id, a] of this.avatars.entries()) {
        if (tf <= 0.01) break; // full Day: torches have no impact
        if (!this.torchLit(id, myId, state)) continue;
        if (sl.length >= MAX_SHADER_LIGHTS) break;
        // Grid position from the FLAT authoritative coords (1 cell = CELL_WU
        // world units) — the projected lx/ly live in screen space and put the
        // torch underground, so the terrain shadowed its own light.
        sl.push({
          col: a.fx / CELL_WU,
          row: a.fy / CELL_WU,
          // Held low (waist height): a high torch grazes over ledge lips and
          // lights ground far below cliffs, which reads as leakage. Anchor to the
          // avatar's RENDERED elevation (litLevelOf: a.elev px → levels, or the
          // pool surface while swimming) so a torch carried ONTO a deck
          // (bridge/roof) sits at the deck's height and lights the deck around it
          // — not the base ground 4 levels below, nor the pool floor a swimmer
          // is sunk to (its head + the torch it holds float at the surface).
          z: this.litLevelOf(a) + 0.55,
          radius: 6,
          // Colour scales with the day-fade: the light's whole contribution
          // is linear in it, so the pool melts out smoothly.
          color: [0.85 * tf, 0.58 * tf, 0.32 * tf],
          flicker: 0.35, // hand torch: gentle fire flicker
        });
      }
      // Time-of-day: ease the on-screen grade toward the target phase.
      // Wall-clock driven — the physics dt is clamped per frame and would
      // crawl on slow clients. Night's values are the calibrated reference.
      if (this.timeT < 1)
        this.timeT = Math.min(1, (this.time.now - this.timeStart) / (TIME_TRANSITION_S * 1000));
      const e = this.timeT * this.timeT * (3 - 2 * this.timeT); // smoothstep
      // Continuous target from the synced (timeIdx, phaseT): drifts a little
      // every frame while time flows; the 2.5s ease only smooths SKIPS.
      const blend = blendPhases(this.timeIdx + this.phaseT);
      for (let ch = 0; ch < 3; ch++)
        this.curAmbient[ch] = this.timeFromAmbient[ch] + (blend.ambient[ch] - this.timeFromAmbient[ch]) * e;
      // The sun IS the hand (maintainer): direction/slope/strength derive
      // from the same continuous hand angle the dial shows.
      const ha = handAngle(this.timeIdx + this.phaseT);
      const sunTo = sunFromHand(ha.deg, ha.night, ha.f);
      for (let ch = 0; ch < 4; ch++)
        this.curSun[ch] = this.timeFromSun[ch] + (sunTo[ch] - this.timeFromSun[ch]) * e;
      this.curTorchF = this.timeFromTorchF + (blend.torchF - this.timeFromTorchF) * e;
      // The pill reads the SAME continuous world-clock position the ambient and
      // the directional sun do — it maps it to its own sky (clock.ts).
      setClockTime(this.timeIdx + this.phaseT);
      // Weather: ease the cloud cover toward the synced target (~4s roll),
      // and grey the sky a touch while cloudy — "the sky is not perfect
      // blue" — before handing the ambient to the shader + CPU twin.
      const cloudTo = WEATHER_CLOUD[this.weatherIdx] ?? 0;
      const ca = 1 - Math.exp(-(this.game.loop.delta / 1000) / 4);
      this.curCloud += (cloudTo - this.curCloud) * ca;
      if (Math.abs(this.curCloud - cloudTo) < 0.005) this.curCloud = cloudTo;
      // Mist (weather 2) creeps in on the same roll — banks ease up from
      // nothing rather than popping.
      const mistTo = this.weatherIdx === 2 ? 1 : 0;
      this.curMist += (mistTo - this.curMist) * ca;
      if (Math.abs(this.curMist - mistTo) < 0.005) this.curMist = mistTo;
      // Flat rain-gloom on the ambient (the patchy cloud shade rides on top).
      const dimTo = WEATHER_DIM[this.weatherIdx] ?? 0;
      this.curPrecipDim += (dimTo - this.curPrecipDim) * ca;
      if (!this.weatherFX) this.weatherFX = new WeatherFX(this);
      this.weatherFX.setWeather(this.weatherIdx);
      this.weatherFX.update(this.game.loop.delta, this.cameras.main, (wx, wy) => this.isWaterAtScreen(wx, wy));
      // Aurora eases on the same ~4s roll (the curtains breathe in).
      const auroraTo = this.auroraOn ? 1 : 0;
      this.curAurora += (auroraTo - this.curAurora) * ca;
      if (Math.abs(this.curAurora - auroraTo) < 0.005) this.curAurora = auroraTo;
      const ambEff = this.curAmbient.map((v, i) => {
        const grey = (this.curAmbient[0] + this.curAmbient[1] + this.curAmbient[2]) / 3;
        const clouded = v + (grey * 0.94 - v) * this.curCloud * 0.22;
        return clouded * (1 - this.curPrecipDim);
      }) as [number, number, number];
      // Local player drives the cel-shaded distance fog: its rendered elevation
      // (so the fog eases as it climbs/falls) + its cell (col,row) for the
      // horizontal distance term.
      const meAv = this.avatars.get(this.room?.sessionId ?? "");
      const playerZ = meAv ? Math.max(0, meAv.elev / MAP_GEOMETRY.lh) : 0;
      const playerCol = meAv ? meAv.fx / CELL_WU : 0;
      const playerRow = meAv ? meAv.fy / CELL_WU : 0;
      this.night!.update(
        this.cameras.main,
        sl,
        ambEff,
        this.glowStamps,
        this.curSun,
        this.curCloud,
        this.curAurora,
        this.curMist,
        playerZ,
        playerCol,
        playerRow,
      );
    }

    const lights: LightSource[] = [];
    if (this.campfire && this.fireOn) {
      const c = this.campfire;
      // Additive bloom hugging the flames (both render paths) — the shader
      // lights the WORLD but the fire itself must also glow, like the ref.
      // Slow breathing, not a strobe: ~4s and ~1.4s periods, small swing.
      const flick = 0.52 + Math.sin(this.time.now / 640) * 0.05 + Math.sin(this.time.now / 225) * 0.03;
      lights.push({ x: c.x, y: c.y - 9, color: 0xff8830, radius: 72, alpha: flick, depth: c.depth + 0.2 });
      // Flame-core bloom ABOVE the night grade + vignette so the flame never
      // goes dull at screen edges — but sized to HUG the flame (a big fixed
      // disc read as a floating ball from afar) and scaled by proximity, so
      // the fire joins the brightens-as-you-approach effect.
      const camMid = this.cameras.main.midPoint;
      const camDist = Math.hypot(c.x - camMid.x, c.y - camMid.y);
      const near = Math.max(0.45, Math.min(1, 1.15 - camDist / 1400));
      lights.push({ x: c.x, y: c.y - 12, color: 0xffb75a, radius: 12, alpha: (flick + 0.2) * near, depth: 900_005 });
      if (!shaderNight)
        lights.push({ x: c.x, y: c.y, color: 0xff9e4a, radius: 120, ground: true, depth: c.depth + 0.1 });
    }
    if (!shaderNight) {
      for (const [id, a] of this.avatars.entries()) {
        if (this.curTorchF <= 0.5) break; // canvas fallback: no per-light tint
        if (!this.torchLit(id, myId, this.room?.state as any)) continue;
        lights.push({ x: a.lx, y: a.ly - 20 }); // lantern pool
      }
      lights.push(...this.emissiveLights);
    }
    this.applyObjectLights();
    this.footsteps?.update(this.time.now);
    this.atmo.update(lights, this.cameras.main, dt);
  }

  /** Start easing toward a time-of-day phase FROM the grade currently on
   * screen — pressing [1] mid-transition retargets without a jump. */
  /** HUD Logout: leave the room and return to the character select. Clears
   * the remembered choice + rejoin fast-path so the reload really lands on
   * the select screen instead of auto-rejoining the world. */
  private logout() {
    this.unloading = true;
    try {
      localStorage.removeItem("ml-last-choice");
      sessionStorage.removeItem("ml-rejoin");
      // tell the select screen we're arriving FROM the game: skip its
      // first-launch title beat and land the logo already at its final spot,
      // just fading in from black (select.ts reads + clears this flag).
      sessionStorage.setItem("ml-from-game", "1");
    } catch {}
    try {
      this.room?.leave();
    } catch {}
    // fade the whole page to black before the reload; the select screen
    // fades back in from black on the other side (fade.ts)
    fadeToBlack(() => location.reload());
  }

  /** Torch is PLAYER state everyone sees: local mirror flips instantly (my
   * own light + the switch), and the server broadcasts it to the world. */
  private toggleTorch() {
    this.torchOn = !this.torchOn;
    this.room?.send("torch", { on: this.torchOn });
    this.chat.addLog("—", `My torch: ${this.torchOn ? "on" : "off"}`);
  }

  /** Is a player's torch lit? Mine reads the instant local mirror; everyone
   * else reads their synced player state (default lit). NOBODY'S torch burns
   * during Day (maintainer: torches are an evening/night/morning feature) —
   * the switch keeps the preference, the flame just waits for the light to
   * fade. */
  private torchLit(id: string, myId: string, state: any): boolean {
    if (id === myId) return this.torchOn;
    return state?.players?.get?.(id)?.torch ?? true;
  }

  /** Cover the game render with a flat colour (frame QA): the Settings
   * "OVERLAY" button cycles NONE -> BLACK -> WHITE -> PINK. The cover is a
   * div over the game viewport only (z 3: above the canvas, below the HUD
   * at 4 and the frame art at 6); chat/roster hide while it's up. */
  private overlayIdx = 0;
  private setOverlay(idx: number) {
    this.overlayIdx = idx % OVERLAYS.length;
    let el = document.getElementById("ml-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "ml-overlay";
      el.style.cssText =
        "position:fixed;left:0;top:0;width:100vw;height:var(--hud-h-inv,61.8vh);" +
        "z-index:3;pointer-events:none;display:none";
      document.body.appendChild(el);
    }
    const color = OVERLAYS[this.overlayIdx].color;
    el.style.display = color ? "block" : "none";
    if (color) el.style.background = color;
    document
      .querySelectorAll<HTMLElement>(".ml-chatlog, .ml-roster")
      .forEach((e) => (e.style.display = color ? "none" : ""));
    this.hud?.refreshSettings();
    return this.overlayIdx;
  }

  private toggleWalls() {
    this.occFadeOn = !this.occFadeOn;
    this.chat.addLog("—", `[7] See-through walls: ${this.occFadeOn ? "on" : "off"}`);
  }

  /** Show/hide the maps2 monster spawn-zone outlines (debug). Persisted so a
   * QA session keeps them on across reloads; OFF for everyone by default. */
  private toggleSpawnAreas(on = !this.spawnAreasOn) {
    this.spawnAreasOn = on;
    try {
      localStorage.setItem("ml-spawn-areas", on ? "1" : "0");
    } catch {}
    this.drawSpawnAreas();
    this.chat.addLog("—", `Spawn areas: ${on ? "on" : "off"}`);
    return this.spawnAreasOn;
  }

  /** The spawn bonfire on/off — its firelight drowns nearby tiles'
   * self-emission, so QA next to it needs the fire quiet. */
  private toggleBonfire() {
    this.fireOn = !this.fireOn;
    this.campfireSprite?.setVisible(this.fireOn);
    this.campfireLit?.setVisible(this.fireOn && !!this.night?.active);
    this.chat.addLog("—", `[6] Bonfire: ${this.fireOn ? "lit" : "out"}`);
  }

  /** Ask the SERVER for the next time-of-day phase (the [1] key and the HUD
   * button) — the state listener applies it when the patch lands, for every
   * player at once. */
  private cycleTimeOfDay() {
    this.room?.send("timeofday");
  }

  private setTimeOfDay(idx: number, instant = false, tOverride?: number) {
    if (tOverride !== undefined) this.phaseT = tOverride; // local probes pin mid-phase
    this.timeFromAmbient = [...this.curAmbient];
    this.timeFromSun = [...this.curSun];
    this.timeFromTorchF = this.curTorchF;
    this.timeIdx = idx;
    this.timeT = instant ? 1 : 0;
    this.timeStart = this.time.now;
    if (instant) {
      // Read the freshest synced progress directly (patch listener order is
      // not guaranteed within the join sync) — unless a LOCAL probe pinned
      // it (reading state here once clobbered the probe's keyframe).
      const t = tOverride ?? this.room?.state?.phaseT;
      if (typeof t === "number" && !Number.isNaN(t)) this.phaseT = t;
      const blend = blendPhases(idx + this.phaseT);
      const ha = handAngle(idx + this.phaseT);
      this.curAmbient = [...blend.ambient];
      this.curSun = sunFromHand(ha.deg, ha.night, ha.f);
      this.curTorchF = blend.torchF;
      setClockTime(idx + this.phaseT);
    }
  }

  /** Lit copies: a pixel-identical duplicate of each character drawn ABOVE
   * the darkness overlay, tinted by its ground-cell light — exact silhouette
   * with zero shader plumbing. When a wall draws over the sprite the copy is
   * CROPPED below the wall's top line (not hidden): the covered part defers
   * to the depth-sorted under-sprite, everything above it stays lit. */
  private applyObjectLights() {
    const night = this.night;
    // Test patterns ([9]/headless probes) read the RAW field off the screen —
    // lit copies drawn above the overlay would pollute the samples.
    const on = !!night && night.active && night.testPattern < 3;
    const tNow = this.time.now / 1000;
    for (const lo of this.litOccluders) {
      lo.img.setVisible(on);
      if (!on) continue;
      let tint = night!.tintAt(lo.col, lo.row, lo.z, true);
      if (lo.emission) {
        // Self-glow floor on the copy's tint — same semantics as the
        // shader's per-cell floor (max(light, colour*self*anim)) but applied
        // to the ART's own pixels, so the glow follows the tile's shape.
        const e = lo.emission;
        const ph = lo.phase ?? 0;
        const animN = e.anim === "flicker" ? 2 : e.anim === "pulse" ? 1 : 0;
        // Shared "alive" waveform (emissionWave) — same maths as the shader
        // floor, so the copy's glow moves in step with the world's.
        const fv = emissionWave(animN, tNow, ph);
        const floor = (i: number) => Math.round(Math.min(1, e.color[i] * e.self * fv[i]) * 255);
        tint =
          (Math.max((tint >> 16) & 0xff, floor(0)) << 16) |
          (Math.max((tint >> 8) & 0xff, floor(1)) << 8) |
          Math.max(tint & 0xff, floor(2));
        // Emitter self-pulse: dim the whole billboard so the OBJECT itself
        // breathes (the shader does this for terrain emitters; solid emissive
        // art — spires, mushroom stacks, cliff pillars — is drawn as these lit
        // copies which can't be lit per-pixel by the glow field, so the pulse
        // has to ride the whole sprite). GENTLE (mix 0.45 toward 1.0): the
        // strong per-detail pulse lives in the glow halos for terrain tiles;
        // here we keep solids alive without turning them into pulsing slabs.
        const sp = 1 - 0.45 * (1 - emissionSelfPulse(animN, tNow, ph));
        tint =
          (Math.round(((tint >> 16) & 0xff) * sp) << 16) |
          (Math.round(((tint >> 8) & 0xff) * sp) << 8) |
          Math.round((tint & 0xff) * sp);
      }
      lo.img.setTint(tint);
    }
    for (const a of this.avatars.values()) {
      const l = this.syncLitCopy(a, on, a.baseTint);
      if (!l) {
        if (!on) a.foam?.clearTint(); // day: foam at full brightness
        continue;
      }
      // Underwater clip: the lit copy follows the same shoulder-waterline mask
      // as the base sprite so the submerged body doesn't show above the night
      // overlay (composes with the wall crop inside syncLitCopy).
      if (a.swimming && a.swimT > 0.001 && a.waterMask) a.lit!.setMask(a.waterMask);
      else if (a.lit!.mask) a.lit!.clearMask();
      // Foam draws ABOVE the night overlay (like the lit copy), so tint its
      // white crest by the same LOCAL light — otherwise it stays bright white
      // at full night. Light-only (the texture already carries its colours), so
      // it fades into the dark and warms up under a nearby torch, matching the
      // character.
      if (a.foam?.visible) {
        const fr = Math.min(255, Math.round(255 * Math.min(1, l[0])));
        const fg = Math.min(255, Math.round(255 * Math.min(1, l[1])));
        const fb = Math.min(255, Math.round(255 * Math.min(1, l[2])));
        a.foam.setTint((fr << 16) | (fg << 8) | fb);
      }
    }
    // Monsters ride the SAME lit-copy pipeline (plain white base tint), so
    // they answer the sun, clouds, night and torches exactly like players —
    // their first cut had no lit copy at all (maintainer 2026-07-29).
    // Camera-gated bodies are skipped outright: their copy is already hidden,
    // and syncLitCopy samples the CPU light AND the depth fog per call.
    for (const mv of this.monsters.values())
      if (!mv.culled) this.syncLitCopy(mv, on, 0xffffff);
    if (this.campfireSprite) {
      if (!this.campfireLit) {
        this.campfireLit = this.add
          .sprite(this.campfireSprite.x, this.campfireSprite.y, CAMPFIRE_KEY)
          .setOrigin(0.5, CAMPFIRE_BASE)
          .setScale(CAMPFIRE_SCALE);
      }
      this.campfireLit
        .setVisible(on && this.fireOn)
        .setFrame(this.campfireSprite.frame.name)
        .setPosition(this.campfireSprite.x, this.campfireSprite.y)
        .setDepth(litDepth(this.campfireSprite.depth));
      // Like the avatar lit copies: a camera-forward SOLID structure whose
      // art overlaps the fire must cover its lit copy too — otherwise the
      // flames float on top of the pillar in front (playtester report).
      if (on && this.campfire) {
        let coverY = Infinity;
        for (const o of this.occluderMeta) {
          if (
            o.solid &&
            // campfire.col/row already carry the +0.5 cell-centre offset.
            o.col + o.row + 1.2 > this.campfire.col + this.campfire.row &&
            this.campfire.x >= o.x0 - 6 &&
            this.campfire.x <= o.x1 + 6 &&
            o.y0 < this.campfire.y
          )
            coverY = Math.min(coverY, o.y0);
        }
        const s = this.campfireLit;
        if (coverY < Infinity) {
          const frameTop = s.y - s.displayHeight * s.originY;
          const cropH = (coverY - frameTop) / s.scaleY;
          if (cropH <= 2) s.setVisible(false);
          else s.setCrop(0, 0, s.frame.cutWidth, cropH);
        } else if (s.isCropped) s.setCrop();
      }
    }
  }

  private predictAndSend(dt: number) {
    if (this.selfDead) {
      this.sendAccum = 0;
      this.jumpQueued = false;
      return;
    }
    // Self-heal a wedged hold gesture: if Phaser's own pointer slot says the
    // finger is no longer down but the scene never got its pointerup (overlay
    // races, touchcancel), the hold would otherwise persist forever — every
    // new tap ignored and the stale ground point re-arming the trip each
    // frame (the "runs to the same spot and gets stuck" report). Drop it
    // WITHOUT the release commit: the ground point is stale by definition.
    if (this.holdPointerId !== null) {
      const held = this.input.manager.pointers.find((pt) => pt.id === this.holdPointerId);
      if (!held || !held.isDown) this.dropHold();
    }
    const k = this.keys;
    let ax = (down(k.D) || down(k.RIGHT) ? 1 : 0) - (down(k.A) || down(k.LEFT) ? 1 : 0);
    let ay = (down(k.S) || down(k.DOWN) ? 1 : 0) - (down(k.W) || down(k.UP) ? 1 : 0);
    let running = down(k.SHIFT);
    // Tap-to-move autopilot: keyboard always wins (touching the keys cancels
    // the trip); otherwise steer toward the tapped target with the same 8-way
    // screen input a keyboard would produce.
    this.keysActive = ax !== 0 || ay !== 0;
    if (this.keysActive) {
      if (this.trip) this.clearMoveTarget();
      this.engagedId = null; // RO: moving breaks the attack / the fetch
      this.pendingPickupId = null;
      // STEER ASSIST: an accidental run into a solid prop's corner slips
      // around it when the tiles right beside the blocked cell allow it —
      // strictly local, no pathfinding (shared steerAssist). Applies to
      // DIRECT input only (keys + the HUD analog stick, which synthesizes
      // keys); the autopilot has real findPath. Like auto-jump, the deflected
      // input is what gets predicted AND sent — the server stays untouched.
      if (this.terrain) {
        const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
        if (me) {
          const assist = steerAssist(this.terrain, me.fx, me.fy, ax, ay);
          if (assist) {
            ax = assist.ax;
            ay = assist.ay;
          }
        }
      }
    } else {
      // Held finger at rest: pointermove stops firing, so commit any
      // budget-deferred drag retarget from the frame loop instead.
      this.holdRepath(performance.now());
      // Fight/fetch intent runs with OR without a trip: standing in reach it
      // re-asserts the engagement; walking it retargets the moving monster.
      this.driveCombatIntent();
      if (this.trip) {
        const drive = this.driveAutopilot();
        ax = drive.ax;
        ay = drive.ay;
        running = drive.running;
      }
    }
    // SOFT MONSTER COLLISION (maintainer 2026-07-30): monsters are not in the
    // collision grid — no network or pathfinder cost — so the INPUT slips
    // around a monster's personal space instead, exactly like steer assist
    // slips around a prop corner. Applies to keys AND the autopilot; the
    // deflected vector is what gets predicted AND sent, so the server
    // integrates the same move and nothing rubber-bands.
    if ((ax !== 0 || ay !== 0) && this.monsters.size) {
      const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
      if (me) {
        // Per-monster ART radii (v2): a mammoth deflects the walker from ~4×
        // the distance a poring does, so the near-filter box must admit the
        // biggest bodies' lookahead (~140wu), not the old fixed 48.
        const near: Array<{ id: string; x: number; y: number; r: number }> = [];
        this.monsters.forEach((mv, id) => {
          if (Math.abs(mv.fx - me.fx) < 140 && Math.abs(mv.fy - me.fy) < 140)
            near.push({ id, x: mv.fx, y: mv.fy, r: mv.radius });
        });
        const dodge = near.length ? monsterDodge(me.fx, me.fy, ax, ay, near, this.dodgeState) : null;
        if (dodge) {
          ax = dodge.ax;
          ay = dodge.ay;
          this.dodgeState = dodge.state;
        } else this.dodgeState = undefined;
      }
    }
    const sig = `${ax},${ay},${running ? 1 : 0}`;
    // If the input CHANGED, flush the elapsed window under the PREVIOUS input
    // first. Otherwise a quick tap gets re-attributed to the new vector (e.g.
    // idle) — the tap's movement evaporates and the player pops back.
    if (sig !== this.lastSent && this.sendAccum > 0) this.flushInput();
    this.lastInput = { ax, ay, running };
    this.lastSent = sig;
    this.sendAccum += dt;
    // Auto-hop a 1-level ledge you walk into (a wall a jump COULD clear) so the
    // player doesn't have to tap Space at every step — may set jumpQueued.
    this.maybeAutoJump(ax, ay);
    // Regular cadence, and jumps flush immediately so the edge isn't delayed.
    if (this.jumpQueued || this.sendAccum >= 1 / INPUT_HZ) this.flushInput();
  }

  /**
   * Iso pick: which walkable ground does a tap at camera-world (wx,wy) land
   * on? Raised tops draw shifted UP by level×lh, so invert the projection
   * once per candidate level, from the highest down — the first cell whose
   * actual level matches the candidate is the surface the player SEES there.
   * Returns flat world coords (the same space the server moves players in).
   */
  /** Is the ground point drawn at world/screen (wx, wy) open water? Same iso
   * inverse-projection as pickGround, but reports the FRONT-MOST drawn cell's
   * swimmable-ness — used by the water/snow FX so glimmer/melt land on visible
   * lake surface only, never on a cliff FACE with a lake hidden behind it.
   *
   * Scanning level high→low walks candidate cells strictly front-to-back (v =
   * col+row grows with the hypothesised level l, and higher col+row draws in
   * front). A cell stacks face tiles for levels 0..cell.l then its top, so its
   * drawn column covers this screen point whenever `cell.l >= l` — top OR face.
   * The first such cell is the surface actually visible here: stopping on the
   * cliff's FACE (cell.l > l) instead of only its TOP (the old `cell.l === l`)
   * is what stops water glinting THROUGH the wall (the lake behind resolves at
   * a lower l, reached only after the occluding face). */
  private isWaterAtScreen(wx: number, wy: number): boolean {
    if (!this.world) return false;
    const { dx, dy, lh, tile } = MAP_GEOMETRY;
    const u = (wx - this.iso.ox - tile / 2) / dx;
    for (let l = this.maxLevel; l >= 0; l--) {
      const v = (wy - this.iso.oy - dy + l * lh) / dy;
      const col = (u + v) / 2;
      const row = (v - u) / 2;
      const cell = this.world.rows[Math.floor(row)]?.[Math.floor(col)];
      if (!cell || cell.l < l) continue; // this cell draws no top/face at level l
      const s = surfaceFor(cell.t);
      return !s.standable && s.swimmable; // front-most drawn surface (top or face)
    }
    return false;
  }

  /** Is the point drawn at world (wx, wy) walkable DRY GROUND a creature could
   * perch on? Face-aware like isWaterAtScreen: it resolves the FRONT-MOST drawn
   * surface and returns true only when that surface is the standable, non-water
   * TOP of a cell (cell.l === l) — NOT a cliff FACE (cell.l > l → the point is on
   * the vertical wall) and NOT water. The ambient bird flock lands in a flat
   * plane with no knowledge of terrain height, so it validates each perch spot
   * through this to avoid landing on cliff walls or in the water. */
  private landableAtScreen(wx: number, wy: number): boolean {
    if (!this.world) return false;
    const { dx, dy, lh, tile } = MAP_GEOMETRY;
    const u = (wx - this.iso.ox - tile / 2) / dx;
    for (let l = this.maxLevel; l >= 0; l--) {
      const v = (wy - this.iso.oy - dy + l * lh) / dy;
      const col = Math.floor((u + v) / 2);
      const row = Math.floor((v - u) / 2);
      const cell = this.world.rows[row]?.[col];
      if (!cell || cell.l < l) continue; // this cell draws no top/face here
      const s = surfaceFor(cell.t);
      return cell.l === l && s.standable && !s.swimmable; // a walkable TOP, not a face/water
    }
    return false;
  }

  /** Light + depth-fog haze for an ambient FLYER (bird/bat) whose GROUND point
   * is drawn at iso-screen (gx,gy) and lifted `altPx` above it. The flat flock
   * sim has no terrain awareness, so this does the face-aware iso inverse of the
   * GROUND point → the front-most drawn surface, then the flyer's ABSOLUTE
   * height z = L + altPx/lh. It samples the CPU light field (day/night + cloud +
   * directional-sun CAST SHADOW + point lights, the same lightAt the avatar
   * lit-copy uses) AND the depth-fog band math at that 3D point. NEVER a
   * framebuffer read — the shadow and haze come from the light field at the
   * bird's own position+altitude (the maintainer's requirement).
   *
   * L is the DRAWN level at the resolved screen row (the loop's `l`), NOT the
   * cell's TOP level (cell.l). On a flat top the two are equal (so flat ground,
   * plateaus and landed birds are unchanged), but on a cliff FACE `l` RAMPS
   * smoothly from the foot (0) to the top (cell.l) as the point climbs the wall.
   * The old cell.l pinned every bird flying in FRONT of a tall wall to the wall
   * TOP — so a bird cruising up the face SNAPPED to max fog the instant its
   * ground point touched the sheer face (maintainer: "they fly into the wall and
   * get the fog from the ground layer that is over the bird"). With the drawn
   * level the fog now ramps with the bird's screen height up the face. A high
   * flyer's large alt still lifts z clear into open-sky light; a landed bird
   * (alt=0) gets z=L and catches its surface's sun/shadow.
   *
   * Returns RAW floats — the light multipliers `l` (0..~N, clamp before tinting),
   * the fog opacity, the fog colour (0..1), and the resolved col/row/L/z (debug)
   * — so the ambient layer can EASE the grade per creature (any residual 1-level
   * step smooths over ~0.15s). null before the world/night field exist. */
  private critterLight(
    gx: number,
    gy: number,
    altPx: number,
  ): { l: [number, number, number]; fog: number; fogCol: [number, number, number]; col: number; row: number; L: number; cellL: number; lift: number; shadowDepth: number; z: number } | null {
    if (!this.world || !this.night) return null;
    const { dx, dy, lh, tile } = MAP_GEOMETRY;
    const u = (gx - this.iso.ox - tile / 2) / dx;
    // Front-most drawn surface under the ground point, falling back to the
    // level-0 projection when nothing is hit (off-map / over a gap).
    const v0 = (gy - this.iso.oy - dy) / dy;
    let col = (u + v0) / 2, row = (v0 - u) / 2, L = 0, cellL = 0;
    for (let l = this.maxLevel; l >= 1; l--) {
      const v = (gy - this.iso.oy - dy + l * lh) / dy;
      const c = (u + v) / 2, r = (v - u) / 2;
      const cell = this.world.rows[Math.floor(r)]?.[Math.floor(c)];
      if (cell && cell.l >= l) { col = c; row = r; L = l; cellL = cell.l; break; } // L = DRAWN level (ramps up a face); cellL = the column's TOP (cell.l) — lifts a flyer's shadow off the face onto the flat top
    }
    const z = L + altPx / lh;
    const lgt = this.night.lightAt(col, row, z, false);
    const f = this.night.depthFogAt(col, row, z);
    // Depth to sort a critter's ground SHADOW at. The naive `gy + L*lh + 3` uses
    // the CONTINUOUS gy, so over ELEVATED terrain it swings across a ~2*dy band
    // vs the DISCRETE per-cell occluder images (all of a column's face+top tiles
    // sit at oDepth = by+dy) and dips BEHIND covering tiles as the flyer moves —
    // the blinking shadows (maintainer). For any resolved ELEVATED column
    // (cellL>0 — flat top AND cliff face, whose lifted shadow draws on this same
    // column's top diamond) sort at the DISCRETE resolved-cell anchor + 3*dy:
    // the shadow ellipse can only ever overlap this column's own images (+1*dy),
    // the cardinal fronts (+2*dy) and the FRONT-DIAGONAL (col+1,row+1) at +3*dy —
    // whose diamond APEX the shadow straddles near the cell's bottom corner (the
    // maintainer's "80% hidden at the top of the tile diamond": the first cut
    // used +2*dy and sat 12 under that tile). Discrete per cell → cannot swing;
    // +0.25 (not +3) so decks/avatars at +3*dy+0.4/0.5 still occlude correctly;
    // columns ≥ +4*dy (genuinely nearer walls) still draw over and hide it.
    // Flat level-0 (cell.l<=0 builds NO occluders) keeps the byte-identical
    // `gy + 3` of the original code.
    const shadowDepth =
      cellL > 0
        ? this.iso.oy + (Math.floor(col) + Math.floor(row) + 3) * dy + 0.25
        : gy + L * lh + 3;
    // CONTINUOUS face-lift for the critter shadow. The resolved column's top
    // LIP line on screen is lipY = flat cell-bottom anchor − cellL*lh; a face
    // pixel's lift is simply how far gy sits BELOW that line (0 on any top /
    // flat / level-0), so the lifted shadow y = gy − lift = min(gy, lipY) —
    // pinned at the lip across the whole face band and continuous at the
    // face↔top handover. The INTEGER drawn-level version ((cellL−L)*lh) stepped
    // 16px once per level as gy swept a face, so the shadow SAW-TOOTHED around
    // the lip during every hill crossing (maintainer: "jitters for a while
    // until it settles on the new elevation level").
    const lipY = this.iso.oy + (Math.floor(col) + Math.floor(row) + 3) * dy - cellL * lh;
    const lift = cellL > 0 ? Math.max(0, gy - lipY) : 0;
    return { l: [lgt[0], lgt[1], lgt[2]], fog: f.a, fogCol: [f.r, f.g, f.b], col, row, L, cellL, lift, shadowDepth, z };
  }

  private pickGround(wx: number, wy: number): { x: number; y: number; lvl: number } | null {
    const clampW = (x: number, y: number, lvl: number) => ({
      x: Math.max(1, Math.min(this.worldW - 1, x)),
      y: Math.max(1, Math.min(this.worldH - 1, y)),
      lvl,
    });
    if (!this.world) return clampW(wx, wy, 0); // plain-ground fallback: screen == flat world
    const { dx, dy, lh, tile } = MAP_GEOMETRY;
    const u = (wx - this.iso.ox - tile / 2) / dx;
    for (let l = this.maxLevel; l >= 0; l--) {
      const v = (wy - this.iso.oy - dy + l * lh) / dy;
      const col = (u + v) / 2;
      const row = (v - u) / 2;
      const ci = Math.floor(col);
      const ri = Math.floor(row);
      const cell = this.world.rows[ri]?.[ci];
      if (!cell) continue;
      // world@2: a deck slab drawn at level l here is the TOP surface — tapping
      // it targets the deck (bridge/roof), not the base underneath.
      const deckL = this.terrain?.deck[ri * this.world.width + ci] ?? -1;
      if (deckL === l) return clampW(col * CELL_WU, row * CELL_WU, l);
      if (cell.l !== l) continue;
      const s = surfaceFor(cell.t);
      if (!s.standable && !s.swimmable) return null; // tapped a solid prop/structure
      return clampW(col * CELL_WU, row * CELL_WU, l);
    }
    return null; // void (outside the drawn world)
  }

  /** Start a tap-to-move trip (run = double-tap). Plans a route with the
   * shared findPath (walk around props, along walls, jump 1-level ledges
   * head-on) and drops a pulsing ground marker at the destination. */
  /** Replan the hold-to-move trip toward the finger's current ground point,
   * under an adaptive time budget: each findPath schedules the next replan at
   * cost×8 (floor 50ms, cap 400ms), so cheap paths replan at ~20Hz while a
   * pathological drag (sealed target → exhaustive search, ~20-40ms) backs
   * off by itself. Skipped while keyboard movement is active (keys win) and
   * when the finger rests on the player/current target. */
  /** Forget the hold gesture WITHOUT committing a final replan — for healing a
   * wedged hold (stale ground point) and for teleport/respawn cancels. */
  private dropHold() {
    this.holdPointerId = null;
    this.holdGround = null;
    this.holdRepathAt = 0;
  }

  /** Normal end-of-hold: commit the final finger position even if the budget
   * deferred it, land the beacon on the trip's TRUE end (the finger point
   * clearance-adjusted out of solids — they can differ while dragging), then
   * forget the gesture. Shared by the scene pointerup and the window-capture
   * touch healers so both paths behave identically. */
  private commitReleaseHold() {
    this.holdRepathAt = 0;
    this.holdRepath(performance.now());
    if (this.trip && this.tapMarker) {
      const e = this.trip.target;
      const pr = this.projectFlat(e.x, e.y);
      // Lift the beacon onto the tapped surface — a deck target sits at its
      // deck level (projectFlat returns the lower BASE level).
      this.tapMarker.setPosition(pr.x, pr.y - Math.max(pr.lvl, this.trip.goalLevel ?? 0) * MAP_GEOMETRY.lh);
    }
    this.dropHold();
  }

  private holdRepath(nowMs: number) {
    if (this.holdPointerId === null || !this.holdGround || this.keysActive) return;
    if (nowMs < this.holdRepathAt) return;
    const g = this.holdGround;
    const cur = this.trip?.target;
    if (cur && Math.hypot(g.x - cur.x, g.y - cur.y) < CELL_WU * 0.35) return;
    if (!this.trip) {
      // Arrived and the finger is resting on us: standing at the finger IS
      // the goal — don't churn a new one-step trip (and beacon) every budget.
      const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
      if (me && Math.hypot(g.x - me.fx, g.y - me.fy) < CELL_WU * 0.75) return;
    }
    const t0 = performance.now();
    this.setMoveTarget(g.x, g.y, true, true, g.lvl);
    const cost = performance.now() - t0;
    this.holdRepathAt = nowMs + Math.min(400, Math.max(50, cost * 8));
  }

  private setMoveTarget(x: number, y: number, run: boolean, hold = false, goalLevel?: number, showMarker = true) {
    const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
    if (!me) return;
    // world@2: route from the player's live surface elevation toward the tapped
    // surface's level, so a tap on a bridge/roof climbs onto and crosses the
    // deck instead of routing under it (undefined on flat worlds → base terrain).
    const fromElev = this.room?.state?.players?.get(this.room.sessionId)?.elev;
    // startTrip routes with the shared findPath; the trip's destination is
    // the route's END — the tapped point pushed out of any solid's collision
    // margin, or the reachable rim when the goal is walled off. Null →
    // nowhere to go (tap into a sealed area) — ignore (a hold-drag passing
    // over a sealed spot keeps the current trip alive).
    const trip = startTrip(this.terrain, me.fx, me.fy, x, y, run, this.time.now, fromElev, goalLevel);
    if (!trip) return;
    // A hold-drag retarget carries the sticky run→walk demotion: fresh trips
    // reset it, and at ~7 retargets/s a throttled tab would re-arm the run
    // every retarget and oscillate run/walk forever.
    if (hold && this.trip) trip.slow = this.trip.slow;
    this.trip = trip;
    // Engaging a MONSTER shows the sword mark instead of a destination — the
    // beacon would double-flag the same intent (maintainer 2026-08-05); a
    // plain ground tap keeps the beacon and never the sword.
    if (!showMarker) {
      this.tapMarker?.destroy();
      this.tapMarker = undefined;
      return;
    }
    const end = trip.target;
    this.ensureTapAssets();
    const p = this.projectFlat(end.x, end.y);
    // Sit the beacon ON the tapped surface: a deck target lifts to its deck
    // level (projectFlat returns the BASE level, which is lower).
    const my = p.y - Math.max(p.lvl, goalLevel ?? 0) * MAP_GEOMETRY.lh;
    // Hold replans never touch the beacon: while the finger is down the
    // beacon tracks the FINGER per frame (pointermove/releaseHold own it) —
    // rebuilding the container + tween per replan also made the pulse
    // stutter.
    if (hold && this.tapMarker) return;
    this.tapMarker?.destroy();
    // A GLOWING destination beacon. Depth 900_000.5 sits ABOVE the darkness
    // overlay (900_000) so night can't dim it, and above every terrain
    // occluder so a target on top of a cliff stays visible — but BELOW the
    // lit avatar copies (900_001+), so characters still read on top of it at
    // night. ADD blend makes it light-like wherever it lands. It pulses until
    // the trip ends (arrival/cancel fades it in clearMoveTarget).
    const tint = run ? 0xffb454 : 0x8fe08f;
    // 0.9: the pulse tween drops the container to 0.55 alpha — the outline
    // must stay legible on white ground at the trough too.
    const dark = this.add.image(0, 0, "tap-dark").setAlpha(0.9);
    const glow = this.add.image(0, 0, "tap-glow").setBlendMode(Phaser.BlendModes.ADD).setTint(tint);
    const ring = this.add.image(0, 0, "tap-ring").setBlendMode(Phaser.BlendModes.ADD).setTint(tint);
    this.tapMarker = this.add.container(p.x, my, [dark, glow, ring]).setDepth(900_000.5);
    this.tweens.add({
      targets: this.tapMarker,
      scale: { from: 1.25, to: 0.8 },
      alpha: { from: 1, to: 0.55 },
      duration: run ? 300 : 500,
      yoyo: true,
      repeat: -1,
    });
  }

  private clearMoveTarget() {
    this.trip = null;
    if (this.tapMarker) {
      const m = this.tapMarker;
      this.tapMarker = undefined;
      this.tweens.killTweensOf(m);
      this.tweens.add({ targets: m, alpha: 0, duration: 180, onComplete: () => m.destroy() });
    }
  }

  /** One autopilot step — delegates every decision to the shared
   * stepAutopilot (the headless-tested brain); here we only feed it the
   * predicted position, mirror its trace into __ml.navLog, and clear the
   * trip (marker included) when it reports done. */
  private driveAutopilot(): { ax: number; ay: number; running: boolean } {
    const idle = { ax: 0, ay: 0, running: false };
    const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
    if (!me || !this.trip) return idle;
    const myElev = this.room?.state?.players?.get(this.room.sessionId)?.elev;
    const d = stepAutopilot(this.terrain, this.trip, me.fx, me.fy, this.time.now, this.worldW, this.worldH, myElev);
    if (d.done) {
      this.clearMoveTarget();
      return idle;
    }
    this.navLog.push({
      t: this.time.now,
      x: Math.round(me.fx * 10) / 10,
      y: Math.round(me.fy * 10) / 10,
      wp: { x: Math.round(d.wp.x), y: Math.round(d.wp.y) },
      left: this.trip.path.length,
      dist: Math.round(d.dist),
      ax: d.ax,
      ay: d.ay,
      rawDot: Math.round(d.rawDot * 100) / 100,
      openDot: d.openDot === null ? null : Math.round(d.openDot * 100) / 100,
      usedOpen: d.usedOpen,
    });
    if (this.navLog.length > 400) this.navLog.splice(0, this.navLog.length - 400);
    return { ax: d.ax, ay: d.ay, running: d.running };
  }

  /** The tap marker texture: a small iso-foreshortened ring (white; tinted
   * green for walk, orange for run at use). */
  private ensureTapAssets() {
    if (this.textures.exists("tap-ring")) return;
    // Iso-foreshortened ring (crisp edge) + a soft radial glow disc under it.
    // Both render ADD-blended and tinted at use, so the marker reads as a
    // glowing ground light day and night.
    const w = 30;
    const h = 15;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.lineStyle(3, 0xffffff, 1).strokeEllipse(w / 2, h / 2, w - 4, h - 4);
    g.fillStyle(0xffffff, 0.5).fillEllipse(w / 2, h / 2, (w - 4) / 2.4, (h - 4) / 2.4);
    g.generateTexture("tap-ring", w, h);
    g.clear();
    // Dark under-ring, NORMAL blend: additive light cannot brighten
    // near-white ground (on snow the beacon vanished — maintainer), so a
    // dark outline carries the shape on bright terrain while the additive
    // pair carries it in the dark. Slightly larger canvas so the wider
    // stroke isn't clipped; same ellipse, so it rims the bright ring.
    const dw = w + 4;
    const dh = h + 4;
    g.lineStyle(6, 0x140f0a, 1).strokeEllipse(dw / 2, dh / 2, w - 4, h - 4);
    g.generateTexture("tap-dark", dw, dh);
    g.clear();
    const gw = 56;
    const gh = 28;
    for (let i = 8; i >= 1; i--) {
      g.fillStyle(0xffffff, 0.09).fillEllipse(gw / 2, gh / 2, (gw * i) / 8, (gh * i) / 8);
    }
    g.generateTexture("tap-glow", gw, gh);
    g.destroy();
  }

  /**
   * If the player is walking INTO a ledge that a jump could climb but a walk
   * can't — i.e. a 2-level wall (`WALK_CLIMB < step ≤ JUMP_CLIMB`, now 1 < step ≤ 2;
   * a 1-level step just walks up) — fire the jump automatically. A 3-level+ wall
   * fails the jump check too, so it's left alone; solid props (trees/boulders) are
   * impassable at any climb, so they never auto-jump either. `tryJump` still gates
   * on grounded+cooldown.
   */
  private maybeAutoJump(ax: number, ay: number) {
    if (ax === 0 && ay === 0) return;
    const now = this.time.now;
    if (now < this.jumpUntil || now < this.jumpReadyAt) return; // already airborne / cooling down
    const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
    if (me && this.wouldAutoJump(me.fx, me.fy, ax, ay)) this.tryJump();
  }

  /** The terrain predicate behind auto-jump: from world (fromX,fromY), moving
   * in screen direction (ax,ay), is the terrain just past the feet a 2-level
   * ledge a jump would clear? Delegates to the shared `autoJumpWanted` (which
   * also handles the concave-corner probe geometry). Exposed via __ml.autoJumpAt. */
  private wouldAutoJump(fromX: number, fromY: number, ax: number, ay: number): boolean {
    if (!this.terrain) return false;
    const w = screenToWorldVector(ax, ay);
    return autoJumpWanted(this.terrain, fromX, fromY, w.x, w.y);
  }

  /** Persist + send the accumulated input window (prediction and server get
   * the exact same vector and duration). */
  private flushInput() {
    // Disconnected (reconnecting): don't queue prediction inputs or send on a
    // dead socket — the position stays put until the new room takes over.
    if (!this.connected || !this.room) {
      this.sendAccum = 0;
      this.jumpQueued = false;
      return;
    }
    const li = this.lastInput;
    this.inputSeq += 1;
    this.pending.push({
      seq: this.inputSeq,
      ax: li.ax,
      ay: li.ay,
      running: li.running,
      dt: this.sendAccum,
      // The jump/slow state this window was integrated under — replays must
      // match (jump flushes immediately in predictAndSend, so windows never
      // straddle a jump onset).
      jumping: this.time.now < this.jumpUntil,
      slow: this.curSlowFactor,
    });
    const msg: InputMessage = { ax: li.ax, ay: li.ay, running: li.running, seq: this.inputSeq, dt: this.sendAccum };
    if (this.jumpQueued) {
      msg.jump = true;
      this.jumpQueued = false;
    }
    this.room!.send("input", msg);
    this.sendAccum = 0;
  }

  private applyAnimState(av: Avatar, moving: boolean, running: boolean, dir: string, jumping: boolean) {
    // Airborne overrides ground gait. ONE jump clip (art overhaul 2026-07-29):
    // the standing high-jump was retired on PixelLab and the steeplechase leap
    // now covers standing and running hops alike, timed to the hop arc.
    let state = jumping
      ? "jump"
      : moving
        ? running
          ? "run"
          : "walk"
        : "idle";
    // One-shot combat/pickup overlays (kick/punch/hurt/pickup/die) outrank
    // the movement state while their window runs; die holds via the update
    // loop refreshing actionUntil for as long as the player is dead.
    if (av.actionUntil && this.time.now < av.actionUntil && av.actionKey) state = av.actionKey;
    const want = DIRECTIONS.includes(dir as never) ? dir : DEFAULT_DIRECTION;
    const d = this.stableDir(av, want);
    const key = this.resolveAnim(av.character, state, d);
    if (key && av.sprite.anims.getName() !== key) {
      // A direction-only change keeps the stride: resume the new clip at the
      // SAME loop progress instead of frame 0 — a restarted cycle on every
      // turn read as a visible hitch even when the turn itself was right.
      // animKey format: anim:<uid>:<state>:<dir> — state is second-to-last
      // (indexing from the end keeps this safe even if a uid had a colon).
      const prev = av.sprite.anims.getName();
      const sameState =
        !!prev && av.sprite.anims.isPlaying && prev.split(":").at(-2) === key.split(":").at(-2);
      const progress = sameState ? av.sprite.anims.getProgress() : 0;
      av.sprite.play(key, true);
      if (progress > 0) av.sprite.anims.setProgress(progress);
      // The foot position shifts slightly between directions — re-pin.
      // (Per-DIRECTION on purpose: per-state anchors would snap the sprite
      // sideways at every idle→walk→run transition.)
      this.applyAnchor(av.sprite, av.character, d, av.sprite.texture.key !== PLACEHOLDER_TEX);
    }
    // Rate ∝ speed: the gait clips' base frameRate is measured (build-manifest
    // gaitFps) to plant feet at the gait's base SIDE-VIEW speed — in world
    // units that's speed·√½ (a screen-east walk maps to the world diagonal).
    // Scale playback by the avatar's ACTUAL world speed over that reference:
    // east/west stay 1×, screen-north/south walks cover ISO_DX/ISO_DY ≈ 2.13×
    // the world ground so their legs pace 2.13× faster (playtester: N/S
    // "playing too slow"), key diagonals land at 1.28×, and water/autopilot/
    // easing pace changes keep footfalls tracking the ground — continuously,
    // no per-direction cadence pops. Clamp floor: a wall-push (speed→0)
    // reads as a slow struggle, not frozen legs mid-stride.
    if (state === "walk" || state === "run") {
      const base = (running ? RUN_SPEED : WALK_SPEED) * (this.world ? Math.SQRT1_2 : 1);
      av.sprite.anims.timeScale = Phaser.Math.Clamp((av.spdWu ?? base) / base, 0.4, 2.6);
    } else {
      av.sprite.anims.timeScale = 1;
    }
  }

  /**
   * Direction hysteresis: which direction should avatar `av` DISPLAY when the
   * movement math wants `want`? A turn of 2+ sectors (90°+) is a deliberate
   * turn — switch immediately. A 1-sector (45°) change is indistinguishable
   * from walking along a sector boundary, where the raw direction flips back
   * and forth every few frames — only accept it once it has PERSISTED for
   * DIR_STICK_MS. A wobble flips the candidate back to the current direction
   * (clearing the pending timer) long before that, so the sprite holds one
   * stable orientation; a real 45° turn lands ~160ms later, imperceptibly.
   */
  private stableDir(
    av: { dispDir?: string; pendDir?: string; pendSince?: number },
    want: string,
    allTurns = false, // monsters: EVERY turn size needs persistence (anti-thrash)
  ): string {
    const cur = (av.dispDir ??= want);
    if (want === cur) {
      av.pendDir = undefined;
      return cur;
    }
    const i = DIRECTIONS.indexOf(cur as (typeof DIRECTIONS)[number]);
    const j = DIRECTIONS.indexOf(want as (typeof DIRECTIONS)[number]);
    const ring = Math.abs(i - j);
    if (!allTurns && Math.min(ring, DIRECTIONS.length - ring) >= 2) {
      av.dispDir = want;
      av.pendDir = undefined;
      return want;
    }
    const now = this.time.now;
    if (av.pendDir !== want) {
      av.pendDir = want;
      av.pendSince = now;
      return cur;
    }
    if (now - (av.pendSince ?? 0) >= DIR_STICK_MS) {
      av.dispDir = want;
      av.pendDir = undefined;
      return want;
    }
    return cur;
  }

  /** Opaque art bounds inside the sprite's current frame (frame px), measured
   * once per texture+frame from the alpha channel and cached. The drawn figure
   * occupies a small box in the middle of a mostly-transparent frame; occlusion
   * tests against the full frame hit walls tiles away from the body. */
  private artBoundsCache = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();

  private artBounds(sprite: Phaser.GameObjects.Sprite) {
    const frame = sprite.frame;
    const key = `${frame.texture.key}#${frame.name}`;
    let b = this.artBoundsCache.get(key);
    if (b) return b;
    b = { x0: 0, y0: 0, x1: frame.cutWidth, y1: frame.cutHeight }; // fallback: whole frame
    try {
      const src = frame.source.image as CanvasImageSource;
      const cnv = document.createElement("canvas");
      cnv.width = frame.cutWidth;
      cnv.height = frame.cutHeight;
      const ctx = cnv.getContext("2d", { willReadFrequently: true });
      if (src && ctx) {
        ctx.drawImage(src, frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight, 0, 0, cnv.width, cnv.height);
        const d = ctx.getImageData(0, 0, cnv.width, cnv.height).data;
        let x0 = cnv.width, y0 = cnv.height, x1 = -1, y1 = -1;
        for (let y = 0; y < cnv.height; y++)
          for (let x = 0; x < cnv.width; x++)
            if (d[(y * cnv.width + x) * 4 + 3] > 16) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
        if (x1 >= x0) b = { x0, y0, x1: x1 + 1, y1: y1 + 1 };
      }
    } catch {
      // Unreadable source (shouldn't happen same-origin) — keep the fallback.
    }
    this.artBoundsCache.set(key, b);
    return b;
  }

  private alphaMapCache = new Map<string, { w: number; h: number; a: Uint8Array }>();

  /** Per-pixel alpha of the sprite's current FRAME (cutWidth×cutHeight), cached
   * per texture+frame. Used to clamp the waterline foam to the character's
   * actual opaque silhouette so the crest never spills into transparent pixels. */
  private alphaMap(sprite: Phaser.GameObjects.Sprite): { w: number; h: number; a: Uint8Array } {
    const frame = sprite.frame;
    const key = `${frame.texture.key}#${frame.name}`;
    let m = this.alphaMapCache.get(key);
    if (m) return m;
    const w = frame.cutWidth, h = frame.cutHeight;
    const a = new Uint8Array(w * h);
    try {
      const src = frame.source.image as CanvasImageSource;
      const cnv = document.createElement("canvas");
      cnv.width = w;
      cnv.height = h;
      const ctx = cnv.getContext("2d", { willReadFrequently: true });
      if (src && ctx) {
        ctx.drawImage(src, frame.cutX, frame.cutY, w, h, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        for (let i = 0; i < w * h; i++) a[i] = d[i * 4 + 3];
      }
    } catch {
      // Unreadable source (shouldn't happen same-origin) — leave all-transparent.
    }
    m = { w, h, a };
    this.alphaMapCache.set(key, m);
    return m;
  }

  /** Set the sprite origin to the measured foot anchor for this direction and
   * remember the head-top fraction for label placement. */
  private applyAnchor(sprite: Phaser.GameObjects.Sprite, uid: string, dir: string, hasArt: boolean) {
    if (!hasArt) {
      sprite.setOrigin(0.5, 0.94); // placeholder wanderer: feet at 32/34
      sprite.setData("topFrac", 0.1);
      return;
    }
    const def = this.manifest.characters.find((c) => c.uid === uid);
    const a = def?.anchors?.[dir] ?? def?.anchors?.[DEFAULT_DIRECTION];
    if (a) {
      sprite.setOrigin(a.x, a.y);
      sprite.setData("topFrac", a.top ?? Math.max(0, a.y - 0.55));
    } else {
      sprite.setOrigin(0.5, 0.9);
      sprite.setData("topFrac", 0.25);
    }
  }

  /** The swim WATERLINE (shoulder line) for a character+direction: the two
   * shoulder points as frame fractions (maintainer-specified / auto-detected).
   * Falls back to a flat chest-height line when unmeasured. */
  private waterlineFor(
    uid: string,
    dir: string,
  ): { def?: CharacterDef; s: { lx: number; ly: number; rx: number; ry: number } } {
    const def = this.manifest.characters.find((c) => c.uid === uid);
    const s = def?.shoulders?.[dir] ?? def?.shoulders?.[DEFAULT_DIRECTION] ?? { lx: 0.4, ly: 0.42, rx: 0.6, ry: 0.42 };
    return { def, s };
  }

  /** The elevation (in levels) at which to sample lighting for the VISIBLE
   * character — its torch and its lit-copy day/night tint. Normally the avatar's
   * RENDERED height (`elev` px → levels, follows falls/hops onto decks). But a
   * SWIMMER's `elev` sinks `swimDrop` px BELOW the pool surface while the head +
   * shoulders float AT the surface: sampling down there marches the sun ray into
   * the pool's own raised edges and the swimmer renders shaded in full daylight
   * (maintainer 2026-07-25 — only bit ELEVATED pools; a sea's sunk elev clamps to
   * 0 = its own surface). So float swimmers sample at the pool surface `surfLevel`. */
  private litLevelOf(a: BodyVisual): number {
    if (a.swimming && a.surfLevel !== undefined) return a.surfLevel;
    return Math.max(0, a.elev / MAP_GEOMETRY.lh);
  }

  /** Depth vs occluding columns for ANY body (player or monster): a single
   * painter scalar can't resolve every sprite-vs-column case (diagonals,
   * same-level, lower columns), so refine per frame with the EXACT test — a
   * column truly hides the sprite only if its top is strictly higher than the
   * sprite's ground AND it lies on the camera ray (grid interval test). Place
   * the sprite above every falsely-deeper column and below every true
   * occluder. `lvl` = the SURFACE level the body stands on, in LEVELS.
   * Sets sprite depth + b.coverY (wall-top line for the lit-copy crop). */
  private resolveBodyDepth(b: BodyVisual, lvl: number) {
    let depth = b.lyFlat + 0.5; // painter y at the flat (unlifted) ground
    if (this.world) {
      const colf = b.fx / CELL_WU; // 1 cell = CELL_WU world units (any world size)
      const rowf = b.fy / CELL_WU;
      // Sprite bounds = the MEASURED opaque art box (+4px margin for walk
      // frames dipping past the idle anchor). The drawn figure is ~30x68px
      // inside a 128px frame — testing the whole frame let raised cells 2-3
      // tiles away "cover" the sprite via its transparent padding.
      const ab = this.artBounds(b.sprite);
      const aLeft = b.sprite.x - b.sprite.displayWidth * b.sprite.originX;
      const aTop = b.sprite.y - b.sprite.displayHeight * b.sprite.originY;
      const sx0 = aLeft + ab.x0 * b.sprite.scaleX - 4;
      const sx1 = aLeft + ab.x1 * b.sprite.scaleX + 4;
      const sy0 = aTop + ab.y0 * b.sprite.scaleY - 4;
      const sy1 = aTop + ab.y1 * b.sprite.scaleY + 4;
      let above = -Infinity;
      let below = Infinity;
      let coverY = Infinity;
      const feetY = b.ly;
      for (const o of this.occluderMeta) {
        if (o.x1 < sx0 || o.x0 > sx1 || o.y1 < sy0 || o.y0 > sy1) continue;
        const higher = o.top > lvl;
        // (a) Wall genuinely between the camera and the feet point.
        const t0 = Math.max(o.col - colf, o.row - rowf);
        const t1 = Math.min(o.col + 1 - colf, o.row + 1 - rowf);
        const rayBlocked = higher && t1 > Math.max(t0, 0);
        // (b) A higher column whose LIFTED TOP FACE overlaps the feet band
        // (the sprite is a billboard — raised corners of side/front
        // neighbours pass in front of its lower pixels even when the feet
        // point itself is visible) and whose face is camera-closer.
        // The upper reach must clear a DIAGONALLY adjacent ledge: a step to
        // the E/S (same-row/col neighbour) sits one grid diagonal AND one
        // level up, so its top lands ~lh+dy above the feet — a tighter band
        // (the old −26) let that ledge's corner poke between the legs with
        // the foot drawn over it (playtester, standing at a step edge).
        const faceOverFeet =
          higher &&
          o.y0 <= feetY + 6 &&
          o.y0 >= feetY - (MAP_GEOMETRY.lh + MAP_GEOMETRY.dy + 9) &&
          o.col + o.row + 1.2 > colf + rowf;
        // (c) A camera-closer SOLID structure whose (tall, bottom-anchored)
        // art overlaps the sprite: billboard art covers anything behind
        // its diagonal regardless of how far its top rises above the feet
        // — the faceOverFeet band was tuned for 1-level ledges and never
        // fired for a 100px pillar, so the LIT COPY floated over it.
        // BEHIND also requires the feet anchor inside the art's x-span:
        // standing BESIDE the pillar at a smaller diagonal is not behind
        // it, and forcing the base below the pillar dragged it below the
        // equal-depth grass tiles too (clipped legs, playtester report).
        const solidArtOver =
          higher &&
          o.solid &&
          o.col + o.row + 1.2 > colf + rowf &&
          b.lx >= o.x0 - 6 &&
          b.lx <= o.x1 + 6;
        if (rayBlocked || faceOverFeet || solidArtOver) {
          below = Math.min(below, o.depth);
          coverY = Math.min(coverY, o.y0);
        } else if (!o.solid || colf + rowf > o.col + o.row + 1) {
          // Overlapping, not covering → lift the sprite above it. For
          // STANDABLE terrain this must stay unconditional: the flat tile
          // in FRONT of the feet has a higher painter depth and would
          // otherwise draw over the drop shadow/feet (playtester report).
          // SOLID structures are gated on the feet being camera-forward
          // of their front corner — their bottom-anchored tall art
          // (128px spires) overlaps characters standing well BEHIND
          // them, and the blanket lift drew those on top of the pillar.
          above = Math.max(above, o.depth);
        }
      }
      if (above > -Infinity) depth = Math.max(depth, above + 0.6);
      if (below < Infinity) depth = Math.min(depth, below - 0.3); // walls win conflicts
      b.coverY = below < Infinity ? coverY : undefined;
    } else {
      b.coverY = undefined;
    }
    b.sprite.setDepth(depth);
  }

  /** Shadow for ANY body: cast on the LANDING ground (flat − target
   * elevation), not the sprite's current lifted feet. It stays put on the
   * lower ground while the body hops OR falls toward it, shrinking with total
   * air height so a cliff fall reads as "dropping toward the shadow below".
   * `w/h` = the resting ellipse size, `shrinkW/H` = how much a full-height
   * hop shrinks it (sizes differ per body art — parameterized so the incoming
   * larger monsters can pass their own). */
  private placeBodyShadow(
    b: BodyVisual,
    targetElevPx: number,
    hopPx: number,
    w: number,
    h: number,
    shrinkW = w * 0.26,
    shrinkH = h * 0.29,
  ) {
    const landY = b.lyFlat - targetElevPx;
    const airFrac = Math.min(1, (hopPx + Math.max(0, landY - b.ly)) / JUMP_HEIGHT);
    b.shadow
      .setPosition(b.lx, landY)
      .setAlpha(1 - airFrac * 0.35)
      .setDisplaySize(w - airFrac * shrinkW, h - airFrac * shrinkH)
      .setDepth(b.sprite.depth - 0.1);
  }

  /** Lit copy for ANY body (player or monster): the sprite re-drawn ABOVE the
   * night multiply overlay, tinted by the CPU light sample so it answers the
   * sun/clouds/night/torches at ITS OWN standing height. Samples at the body's
   * ACTUAL rendered surface height, NOT the base terrain level: on a deck
   * (roof/bridge) the base is the floor UNDER it, so lightAt marches the sun
   * ray from down there and the body renders shaded in full daylight.
   * litLevelOf gives elev px → levels (same basis as the torch z); a SWIMMER
   * samples at the pool surface its head floats on. Cropped below b.coverY so
   * a covering wall cuts the copy exactly where it cuts the sprite. Returns
   * the light sample for caller extras (foam tint), or null when hidden. */
  private syncLitCopy(b: BodyVisual, on: boolean, baseTint: number): number[] | null {
    if (!b.lit) {
      b.lit = this.add.sprite(b.sprite.x, b.sprite.y, b.sprite.texture.key).setDepth(900_001);
    }
    if (!on || !b.sprite.visible) {
      b.lit.setVisible(false);
      return null;
    }
    const lvl = this.litLevelOf(b);
    const l = this.night!.lightAt(b.fx / CELL_WU, b.fy / CELL_WU, lvl, false);
    // DEPTH-FOG applies to BODIES too (maintainer 2026-07-30: a summit
    // monster rendered crisp inside heavy fog — and remote players shared
    // the bug): the lit copy sits ABOVE the overlay, so it bypasses the
    // shader's fog wash. Fading the copy by the body's own fog amount
    // cross-fades it into the fogged under-overlay sprite — which composites
    // to exactly a strength-f fog on the body, same colour/wash as its
    // terrain (fog 0 → unchanged crisp copy).
    const fog = this.night!.depthFogAt(b.fx / CELL_WU, b.fy / CELL_WU, lvl);
    const r = Math.min(255, Math.round(((baseTint >> 16) & 0xff) * Math.min(1, l[0])));
    const g = Math.min(255, Math.round(((baseTint >> 8) & 0xff) * Math.min(1, l[1])));
    const bl = Math.min(255, Math.round((baseTint & 0xff) * Math.min(1, l[2])));
    b.lit
      .setVisible(true)
      .setTexture(b.sprite.texture.key, b.sprite.frame.name)
      .setPosition(b.sprite.x, b.sprite.y)
      .setOrigin(b.sprite.originX, b.sprite.originY)
      .setScale(b.sprite.scaleX, b.sprite.scaleY)
      .setDepth(litDepth(b.sprite.depth))
      .setAlpha(1 - Math.min(1, Math.max(0, fog.a)))
      .setTint((r << 16) | (g << 8) | bl);
    if (b.coverY !== undefined) {
      // Frame-space y of the occluding wall's top line.
      const frameTop = b.sprite.y - b.sprite.displayHeight * b.sprite.originY;
      const cropH = (b.coverY - frameTop) / b.sprite.scaleY;
      const ab = this.artBounds(b.sprite);
      if (cropH <= ab.y0 + 2) b.lit.setVisible(false); // wall covers the whole figure
      else b.lit.setCrop(0, 0, b.sprite.frame.cutWidth, cropH);
    } else if (b.lit.isCropped) b.lit.setCrop();
    return l;
  }

  /** Clip everything below the water surface (underwater) while swimming, via
   * a geometry mask covering the half-plane ABOVE the (possibly tilted) line
   * through the two shoulder points — applied to both the base sprite and (in
   * the night-light pass) its lit copy. `swimT` (0..1) raises the clip line
   * from the FEET (just entered / falling in) to the SHOULDERS (fully afloat),
   * so a ledge drop submerges progressively. Cleared when not swimming. */
  private updateWaterClip(av: Avatar, dir: string, swimT: number) {
    const sp = av.sprite;
    if (!av.swimming || swimT <= 0.001) {
      if (sp.mask) sp.clearMask();
      av.foam?.setVisible(false);
      return;
    }
    const { def, s } = this.waterlineFor(av.character, dir);
    const fw = def?.frameW ?? sp.frame.realWidth;
    const fh = def?.frameH ?? sp.frame.realHeight;
    // Raise the clip line from the feet (anchor y) toward the shoulders by
    // swimT — the visible cut climbs the body as it sinks through the surface.
    const feetY = def?.anchors?.[dir]?.y ?? def?.anchors?.[DEFAULT_DIRECTION]?.y ?? sp.originY;
    // Quantise swimT ONCE and use it for the clip, the span, AND the foam bake.
    // The foam is a texture cached per quantised swimT; if the clip used the RAW
    // (continuously easing) swimT it would drift away from the frozen foam within
    // a bucket — up to ~3px — leaving a visible gap between the cut and the foam.
    const swimTq = Math.round(swimT * 8) / 8;
    const lyC = feetY + (s.ly - feetY) * swimTq;
    const ryC = feetY + (s.ry - feetY) * swimTq;
    const toWorld = (fx: number, fy: number) => ({
      x: sp.x + (fx * fw - sp.originX * fw) * sp.scaleX,
      y: sp.y + (fy * fh - sp.originY * fh) * sp.scaleY,
    });
    // The waterline is a CURVE (shallow downward bow), not a straight line, so
    // everything under the curve is clipped and the body's volume pokes through
    // at the centre. Build the mask polygon: the bottom edge samples the curve
    // across the shoulder span (bow) and runs straight (baseline) beyond it; the
    // top edge is far above. Both the clip here and the foam bake use this curve.
    // The bow is centred on and scaled to the BODY — the opaque span the line
    // crosses — so it's a symmetric smile under the character in every view (the
    // shoulder points can sit wider than the visible body in profile). The foam
    // bake uses the SAME span, so cut + crest stay glued.
    const span = this.waterlineSpan(sp, s, feetY, swimTq);
    if (!span) {
      if (sp.mask) sp.clearMask();
      av.foam?.setVisible(false);
      return;
    }
    const baseYf = (xf: number) => lyC + (ryC - lyC) * ((xf - s.lx) / ((s.rx - s.lx) || 1));
    const spanLf = span.min / fw, spanRf = span.max / fw;
    const bowF = (BOW_FRAC * (span.max - span.min)) / fh; // centre dip, y-fraction
    const uf = (xf: number) => Math.max(0, Math.min(1, (xf - spanLf) / ((spanRf - spanLf) || 1)));
    const crestYf = (xf: number) => baseYf(xf) + bowF * 4 * uf(xf) * (1 - uf(xf));
    const E = 4000; // extend far above to cover the whole kept half
    const pts: { x: number; y: number }[] = [];
    pts.push(toWorld(spanLf - 1, baseYf(spanLf - 1))); // straight baseline, far left
    const K = 24;
    for (let i = 0; i <= K; i++) {
      const xf = spanLf + (spanRf - spanLf) * (i / K);
      pts.push(toWorld(xf, crestYf(xf))); // the bowed body span
    }
    pts.push(toWorld(spanRf + 1, baseYf(spanRf + 1))); // straight baseline, far right
    const first = pts[0], last = pts[pts.length - 1];
    pts.push({ x: last.x, y: last.y - E }, { x: first.x, y: first.y - E }); // top edge
    if (!av.waterMaskG) {
      av.waterMaskG = this.make.graphics({});
      av.waterMask = av.waterMaskG.createGeometryMask();
    }
    const g = av.waterMaskG;
    g.clear();
    g.fillStyle(0xffffff);
    g.fillPoints(pts, true);
    sp.setMask(av.waterMask!);

    // Waterline foam: a crisp 1-character-pixel WHITE crest + 2px darker water,
    // painted per column ONLY where the body actually meets the surface. We
    // bake it into a FRAME-space texture (same fw×fh pixel grid as the sprite)
    // and draw it with the sprite's EXACT transform — so a white pixel lands on
    // exactly one character pixel (nearest-sampled, no subpixel thinning to a
    // half-pixel), and painting per opaque column makes the crest respect the
    // character's alpha: it breaks across transparent gaps (hair↔body) instead
    // of bridging them, and reaches every opaque column (no missed edge pixel).
    // Animate by rocking the crest angle in whole-pixel steps (see FOAM_TILT):
    // every FOAM_ANIM_MS jump to a RANDOM different tilt (left/normal/right), so
    // there's always a visible hop and no metronome loop. Per-avatar state, so
    // swimmers lap out of sync.
    if (av.foamNextAt === undefined || this.time.now >= av.foamNextAt) {
      const others = [-1, 0, 1].filter((t) => t !== av.foamTilt);
      av.foamTilt = others[(Math.random() * others.length) | 0];
      av.foamNextAt = this.time.now + FOAM_ANIM_MS;
    }
    const foamKey = this.foamTexture(sp, s, feetY, swimTq, av.foamTilt ?? 0, span);
    if (!foamKey) {
      av.foam?.setVisible(false);
      return;
    }
    if (!av.foam) av.foam = this.add.image(0, 0, foamKey);
    av.foam
      .setTexture(foamKey)
      .setPosition(sp.x, sp.y)
      .setOrigin(sp.originX, sp.originY)
      .setScale(sp.scaleX, sp.scaleY)
      .setFlipX(sp.flipX)
      // Above the night overlay (900_000) and lit avatar copies (litDepth
      // ~900_001+) so the crest reads ON TOP of the body at the waterline;
      // stays under the campfire light halos (900_005).
      .setDepth(litDepth(sp.depth) + 2)
      .setVisible(true);
  }

  /** The opaque column span the (straight) waterline crosses for the current
   * frame — the body's extent at the surface. Both the clip curve and the foam
   * bake centre the bow on this span. Null if the body doesn't reach the line. */
  private waterlineSpan(
    sp: Phaser.GameObjects.Sprite,
    s: { lx: number; ly: number; rx: number; ry: number },
    feetY: number,
    swimT: number,
  ): { min: number; max: number } | null {
    const am = this.alphaMap(sp);
    const fw = am.w, fh = am.h;
    const lineY0 = (feetY + (s.ly - feetY) * swimT) * fh;
    const lineY1 = (feetY + (s.ry - feetY) * swimT) * fh;
    const x0 = s.lx * fw, x1 = s.rx * fw;
    const slope = (lineY1 - lineY0) / ((x1 - x0) || 1);
    let mn = fw, mx = -1;
    for (let x = 0; x < fw; x++) {
      const cy = Math.round(lineY0 + slope * (x - x0));
      if (cy >= 1 && cy < fh && (am.a[(cy - 1) * fw + x] > 40 || (cy >= 2 && am.a[(cy - 2) * fw + x] > 40))) {
        if (x < mn) mn = x;
        if (x > mx) mx = x;
      }
    }
    return mx >= mn ? { min: mn, max: mx } : null;
  }

  /** Bake the waterline foam for the sprite's CURRENT frame into a frame-space
   * (fw×fh) texture: for every column find the crest row on the bowed CURVE (the
   * same one the clip mask uses), and paint 1px white + 2px darker water. Inside
   * the body it honours the silhouette (breaks over hair↔body gaps); it also
   * runs a few px PAST each end and fades those tips to transparent, so the foam
   * reads as wrapping the volume. Drawn with the sprite's exact transform, so
   * it's pixel-perfect. `tilt` (-1/0/+1) rocks the whole curve ±≤1px about the
   * span centre (the lapping animation). Cached per texture+frame+swimT+tilt. */
  private foamTexture(
    sp: Phaser.GameObjects.Sprite,
    s: { lx: number; ly: number; rx: number; ry: number },
    feetY: number,
    swimT: number,
    tilt = 0,
    span: { min: number; max: number },
  ): string | null {
    const am = this.alphaMap(sp);
    const fw = am.w, fh = am.h;
    const swimTq = Math.round(swimT * 8) / 8; // quantise so a fall reuses ~8 bakes
    const key = `${sp.frame.texture.key}#${sp.frame.name}#foam${swimTq}#t${tilt}`;
    if (this.textures.exists(key)) return key;
    const lineY0 = (feetY + (s.ly - feetY) * swimT) * fh; // crest row at column s.lx
    const lineY1 = (feetY + (s.ry - feetY) * swimT) * fh; // crest row at column s.rx
    const x0 = s.lx * fw, x1 = s.rx * fw;
    const slope = (lineY1 - lineY0) / ((x1 - x0) || 1);
    const spanMin = span.min, spanMax = span.max;
    const bowPx = BOW_FRAC * (spanMax - spanMin); // centre dip of the smile
    const uu = (x: number) => Math.max(0, Math.min(1, (x - spanMin) / ((spanMax - spanMin) || 1)));
    // Downward-bowed crest (matches the clip curve): baseline + a parabola that
    // is 0 at the body-span ends and dips `bowPx` at the centre, so the foam
    // wraps the body's volume instead of cutting a flat line.
    const curveY = (x: number) => lineY0 + slope * (x - x0) + bowPx * 4 * uu(x) * (1 - uu(x));
    const opaqueAbove = (x: number, cy: number) =>
      cy >= 1 && cy < fh && (am.a[(cy - 1) * fw + x] > 40 || (cy >= 2 && am.a[(cy - 2) * fw + x] > 40));
    // Extend the crest a few px PAST the body at each end so it reads as wrapping
    // around the volume even where the silhouette is transparent (maintainer);
    // those tips fade to nothing. Rock the whole curve ±≤1px (adaptive, softened
    // a touch) about the span centre for the lapping animation.
    const EXT = 3; // px the foam runs beyond the body at each end
    const FADE = EXT + 3; // outer columns over which the tips fade to transparent
    const lo = Math.max(0, spanMin - EXT), hi = Math.min(fw - 1, spanMax + EXT);
    const cx = (spanMin + spanMax) / 2;
    const half = Math.max(1, (spanMax - spanMin) / 2);
    const dSlope = tilt / (half * 1.5); // gentle rotation; the ±≤1px lives only
    // at the outer columns, which fade out — so it can't open a visible gap
    const cnv = document.createElement("canvas");
    cnv.width = fw;
    cnv.height = fh;
    const ctx = cnv.getContext("2d");
    if (!ctx) return null;
    let any = false;
    for (let x = lo; x <= hi; x++) {
      const cy0 = Math.round(curveY(x));
      // Inside the body respect the silhouette (break over hair↔body gaps); in
      // the extension tips always draw (the wrap-around past the edge).
      if (x >= spanMin && x <= spanMax && !opaqueAbove(x, cy0)) continue;
      const cy = cy0 + Math.round(dSlope * (x - cx));
      if (cy < 0 || cy >= fh) continue;
      const fade = Math.max(0, Math.min(1, Math.min(x - lo, hi - x) / FADE)); // fade both ends
      if (fade <= 0.02) continue;
      ctx.fillStyle = `rgba(236,248,255,${(0.92 * fade).toFixed(3)})`; // 1px white crest
      ctx.fillRect(x, cy, 1, 1);
      ctx.fillStyle = `rgba(6,26,34,${(0.42 * fade).toFixed(3)})`; // 2px darker water below
      ctx.fillRect(x, cy + 1, 1, Math.min(2, fh - cy - 1));
      any = true;
    }
    if (!any) return null;
    this.textures.addCanvas(key, cnv);
    return key;
  }

  /** Pick an existing animation, falling back run→walk→idle then default dir. */
  private resolveAnim(uid: string, state: string, dir: string): string | null {
    const order =
      state === "jump"
        ? ["jump", "walk", "idle"]
        : state === "run"
            ? ["run", "walk", "idle"]
            : state === "walk"
              ? ["walk", "idle"]
              : state === "kick" || state === "punch"
                ? [state, state === "kick" ? "punch" : "kick", "idle"] // deferred art mid-load: try the twin strike
                : state === "hurt" || state === "pickup" || state === "die"
                  ? [state, "idle"]
                  : ["idle"];
    for (const s of order) {
      for (const d of [dir, DEFAULT_DIRECTION]) {
        const key = animKey(uid, s, d);
        if (this.anims.exists(key)) return key;
      }
    }
    return null;
  }

  /** Background-load every manifest state preload skipped (BOOT_ANIM_STATES),
   * then extend buildAnimations with the new clips. Runs once, kicked when the
   * player's own avatar joins — the world is already live, so these ~800 PNGs
   * stream in without holding the loading screen (resolveAnim's fallback covers
   * any state something might request before its clip lands). */
  private loadDeferredAnims() {
    if (this.deferredAnimsKicked) return;
    this.deferredAnimsKicked = true;
    let queued = 0;
    for (const def of this.manifest.characters) {
      for (const [state, dirs] of Object.entries(def.animations)) {
        if (BOOT_ANIM_STATES.includes(state)) continue;
        for (const [dir, count] of Object.entries(dirs)) {
          for (let n = 0; n < count; n++) {
            const fk = frameKey(def.uid, state, dir, n);
            if (this.textures.exists(fk)) continue;
            this.load.image(fk, withV(frameUrl(def, state, dir, n)));
            queued++;
          }
        }
      }
    }
    // MONSTER combat strips (attack/angry/die — 525 strips, ~3.1 MB) join the
    // SAME background batch: boot stays walk+idle only (the loading-time work
    // must not regress), and the fight art streams in behind the live world.
    // Sliced with each strip's OWN measured frame size (stripDims) — the
    // monster-level size goes stale on in-place art repairs and frames bleed.
    for (const def of this.monsterManifest?.monsters ?? []) {
      for (const state of ["attack", "angry", "die"]) {
        const anim = resolveMonsterAnim(def, state);
        if (!anim) continue;
        const dirStrips = def.strips?.[anim] ?? {};
        for (const [dir, url] of Object.entries(dirStrips)) {
          if (!url) continue;
          const sk = monsterSheetKey(def.id, anim, dir);
          if (this.textures.exists(sk)) continue;
          const dims = def.stripDims?.[anim]?.[dir];
          this.load.spritesheet(sk, withV(url), {
            frameWidth: dims?.w ?? def.frameW,
            frameHeight: dims?.h ?? def.frameH,
          });
          queued++;
        }
      }
    }
    // The BLOOD SPATTER variants (objects/blood_spatter, trimmed) ride the
    // same batch — tiny (8 strips, 34px frames), ready before the first hit.
    for (const dir of BLOOD_DIRS) {
      const bk = `blood:${dir}`;
      if (this.textures.exists(bk)) continue;
      this.load.spritesheet(bk, withV(`/assets/objects/blood_spatter/animations/spatter__${dir}.webp`), {
        frameWidth: 34,
        frameHeight: 34,
      });
      queued++;
    }
    // (Neither target marker needs an asset since rounds 9-11 — both borders
    // are drawn from the marked body's own silhouette.)
    if (!queued) return;
    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      this.buildAnimations();
      // THE SINGLE-CALL-SITE TRAP (see CLAUDE.md): textures.exists turning
      // true does NOT register anims — without this re-run every late-loaded
      // combat strip would stay a texture no clip ever plays.
      this.buildMonsterAnimations();
      for (const dir of BLOOD_DIRS) {
        const bk = `blood:${dir}`;
        if (this.textures.exists(bk) && !this.anims.exists(bk)) {
          this.anims.create({
            key: bk,
            frames: this.anims.generateFrameNumbers(bk, {}),
            frameRate: 14,
            repeat: 0,
          });
        }
      }
    });
    this.load.start();
  }

  private buildAnimations() {
    // Anti-moonwalk playback rates measured from the art (build-manifest
    // gaitFps): the fps at which the gait's feet track the ground at the
    // gait's BASE speed. ONE rate per gait — legs keep the same cadence in
    // every direction (the old per-direction table was measurement noise and
    // made cadence pop on turns). Movement speed itself is untouched; actual
    // speed variation scales anims.timeScale per frame (applyAnimState).
    for (const def of this.manifest.characters) {
      for (const [state, dirs] of Object.entries(def.animations)) {
        for (const [dir, count] of Object.entries(dirs)) {
          const key = animKey(def.uid, state, dir);
          if (this.anims.exists(key)) continue;
          const frames: Phaser.Types.Animations.AnimationFrame[] = [];
          for (let n = 0; n < count; n++) {
            const fk = frameKey(def.uid, state, dir, n);
            if (this.textures.exists(fk)) frames.push({ key: fk });
          }
          if (!frames.length) continue;
          // idle/walk/run loop; jump/kick play once. The jump's rate is derived
          // from its own frame count so the once-through clip spans the whole
          // ~JUMP_MS hop and lands on its feet regardless of how many frames
          // the art ships (currently 4; was 9).
          const once =
            state === "jump" ||
            state === "kick" ||
            state === "punch" ||
            state === "hurt" ||
            state === "pickup" ||
            state === "die";
          const rate =
            state === "jump"
              ? frames.length / (JUMP_MS / 1000)
              : (def.gaitFps?.[state] ?? ANIM_FPS[state] ?? 10);
          this.anims.create({
            key,
            frames,
            frameRate: rate,
            repeat: once ? 0 : -1,
          });
        }
      }
    }
  }

  /** Build the looping WALK (jump) animation for every monster + direction from
   * its strip spritesheet. Frame counts vary per (kind, dir) — read them from
   * the manifest (poring/forest = 16, ice/lava/sand/water = 6), never hardcode.
   * Slow 6-frame hops read better at ~6fps, the longer 16-frame ones at ~10. */
  private buildMonsterAnimations() {
    for (const def of this.monsterManifest?.monsters ?? []) {
      const walk = monsterWalkKey(def);
      // kind: loop (walk/idle/angry) vs once (attack spans ~0.7s, die spans
      // the server's MONSTER_DIE_MS corpse window so the clip and the sweep
      // agree). Combat strips background-load AFTER join — this builder is
      // idempotent and re-runs on that loader's COMPLETE, registering whatever
      // arrived (the single-call-site trap, documented in CLAUDE.md).
      const states: Array<[string, "loop" | "idle" | "attack" | "die"]> = [[walk, "loop"]];
      if (def.idleAnim && def.idleAnim !== walk) states.push([def.idleAnim, "idle"]);
      const angry = resolveMonsterAnim(def, "angry");
      const attack = resolveMonsterAnim(def, "attack");
      const die = resolveMonsterAnim(def, "die");
      if (angry && angry !== walk) states.push([angry, "idle"]);
      if (attack) states.push([attack, "attack"]);
      if (die) states.push([die, "die"]);
      for (const [anim, kind] of states) {
        const isIdle = kind === "idle";
        const dirCounts = def.animations?.[anim] ?? {};
        for (const [dir, frames] of Object.entries(dirCounts)) {
          const sk = monsterSheetKey(def.id, anim, dir);
          if (!this.textures.exists(sk) || frames <= 0) continue; // strip missing
          const key = monsterAnimKey(def.id, anim, dir);
          if (this.anims.exists(key)) continue;
          const rate =
            kind === "attack"
              ? Math.max(5, frames / 0.7) // one swing ≈ 700ms whatever the art ships
              : kind === "die"
                ? Math.max(3, frames / 1.05) // ≈ MONSTER_DIE_MS before the corpse sweeps
                : isIdle
                  ? frames <= 6
                    ? 4
                    : 7 // idle/angry breathe slower than a gait reads
                  : frames <= 6
                    ? 6
                    : 10;
          this.anims.create({
            key,
            frames: this.anims.generateFrameNumbers(sk, { start: 0, end: frames - 1 }),
            frameRate: rate,
            repeat: kind === "attack" || kind === "die" ? 0 : -1,
          });
        }
      }
    }
  }

  /**
   * Streaming ground: the world is far too large to bake into one texture
   * (512×448 cells ≈ 30k px wide). Instead a world-anchored RenderTexture
   * covering the screen plus GROUND_MARGIN on every side is redrawn only when
   * the camera wanders near its edge — scrolling between redraws costs nothing.
   * Painter order comes free from iterating v = col+row back-to-front.
   */
  private setupStreamingGround() {
    const world = this.world!;
    const cs = canvasSize(world);
    this.iso = { ox: cs.ox, oy: cs.oy, w: cs.w, h: cs.h };
    this.maxLevel = cs.maxLevel;
    // world@2 decks: index by cell for O(1) lookup in the ground/occluder loops,
    // and lift maxLevel so the streamed window + shader ray cover raised slabs.
    this.deckIndex.clear();
    for (const d of world.decks ?? []) {
      this.maxLevel = Math.max(this.maxLevel, d.level);
      for (const c of d.cells) this.deckIndex.set(c.row * world.width + c.col, { deck: d, cell: c });
    }
    this.makeGroundRT();
    this.scale.on("resize", () => this.makeGroundRT());
    // Fake debug spawn-area rectangles depend on the iso origin — (re)draw them
    // now that this.iso is set.
    this.drawSpawnAreas();
  }

  /** Iso outline of each maps2 monster SPAWN ZONE — a DEBUG overlay, off by
   * default (settings switch "spawn areas"). Drawn in WORLD space at a depth
   * just above the ground RT and below every sprite, so it never occludes a
   * monster. Redrawn whenever the iso origin is (re)built or the switch flips.
   *
   * Draws the zone's REAL POLYGON, lazily fetched from the world's spawns.json
   * the first time the overlay is enabled (zero cost while off) — NOT the
   * bounding box the server syncs: zones are concave by design and may sprawl
   * across a habitat, so a bbox rectangle describes a completely different
   * region (monster_demo's 5x5 pads are the only case where they coincide).
   * Vertices are TILE CORNERS (spawns@1), projected with projectZoneCorner. */
  private drawSpawnAreas() {
    if (!this.world) return;
    if (!this.spawnAreaGfx) this.spawnAreaGfx = this.add.graphics().setDepth(-800_000);
    const g = this.spawnAreaGfx;
    g.clear();
    if (!this.spawnAreasOn) return;
    if (this.spawnZones === null) {
      this.loadSpawnZones(); // async; redraws itself when the file lands
      return;
    }
    for (const zone of this.spawnZones) {
      const pts = zone.area.map(([cx, cy]) => this.projectZoneCorner(cx, cy));
      if (pts.length < 3) continue;
      g.fillStyle(0x66ccff, 0.05);
      g.fillPoints(pts, true);
      g.lineStyle(1, 0x8fd6ff, 0.45);
      g.strokePoints(pts, true);
    }
  }

  /** Screen point of a spawns@1 TILE CORNER (cell (c,r) spans corners (c,r)..
   * (c+1,r+1)). NOT project()/projectFlat(): those append the CHARACTER GROUND
   * ANCHOR — the point a body standing IN a cell is drawn at, i.e. the cell
   * diamond's CENTRE (+tile/2, +dy) — so feeding them corner coordinates put
   * the outline half a cell down-screen of the zone it describes (maps agent
   * report + maintainer's monster_demo screenshot, 2026-07-30). A corner is
   * horizontally centred in the tile (so +tile/2 stays) but sits at the
   * diamond's TOP vertex, which is `dy` ABOVE that centre — hence no +dy here.
   * Elevation: lift by the cell the corner belongs to (its down-right cell,
   * clamped), so a zone on a plateau traces the plateau's rim. */
  private projectZoneCorner(cornerCol: number, cornerRow: number): { x: number; y: number } {
    const { dx, dy, lh } = MAP_GEOMETRY;
    const W = this.world?.width ?? 1;
    const H = this.world?.height ?? 1;
    const c = Math.max(0, Math.min(W - 1, cornerCol));
    const r = Math.max(0, Math.min(H - 1, cornerRow));
    const lvl = this.world?.rows[Math.floor(r)]?.[Math.floor(c)]?.l ?? 0;
    return {
      x: this.iso.ox + (cornerCol - cornerRow) * dx + MAP_GEOMETRY.tile / 2,
      y: this.iso.oy + (cornerCol + cornerRow) * dy - lvl * lh + TILE_DIAMOND_TOP,
    };
  }

  /** Fetch the world's spawns.json once (debug overlay only). Missing file →
   * an empty list, so the overlay simply draws nothing and never retries. */
  private loadSpawnZones() {
    if (this.spawnZonesLoading) return;
    this.spawnZonesLoading = true;
    const name = this.worldName || DEFAULT_WORLD;
    fetch(`/assets/maps2/worlds/${name.replace(/[^a-z0-9_-]/gi, "")}/spawns.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        this.spawnZones = j ? parseSpawns(j) : [];
        this.drawSpawnAreas();
      })
      .catch(() => {
        this.spawnZones = [];
      });
  }

  /** Face tile key for a deck's underside/sides (the material's plain face, like
   * a raised ground cell), falling back to the slab's own top art. */
  private deckFaceKey(deck: Deck, topKey: string): string {
    const fp = this.world?.faceTiles?.[deck.mat];
    return fp && this.textures.exists(pathTileKey(fp)) ? pathTileKey(fp) : topKey;
  }

  private makeGroundRT() {
    this.groundRT?.destroy();
    const rs = this.renderScale();
    // World-space texture (1 texel = 1 world px): size it in WORLD px so it
    // covers the same view regardless of the device render scale — scale.width
    // is device px (= CSS·rs), so /rs gives the CSS/world width. rs=1 → unchanged.
    this.groundRT = this.add
      .renderTexture(0, 0, this.scale.width / rs + GROUND_MARGIN * 2, this.scale.height / rs + GROUND_MARGIN * 2)
      .setOrigin(0, 0)
      .setDepth(-1_000_000);
    this.lastGround = { x: NaN, y: NaN };
  }

  private redrawGround() {
    if (!this.world || !this.groundRT) return;
    const cam = this.cameras.main;
    // The WORLD centre of the view. `scrollX + width/2` only equals this at zoom
    // 1; the device-DPI zoom (base·rs) makes it fractional, so use worldView,
    // which is zoom-correct (and identical at zoom 1). Without this the ground RT
    // anchors off-centre and its edge shows through at rs>1.
    const ccx = cam.worldView.centerX;
    const ccy = cam.worldView.centerY;
    // Only redraw when the camera centre strays GROUND_MARGIN/2 from the last
    // anchor — everything in between scrolls the already-drawn texture.
    if (
      !Number.isNaN(this.lastGround.x) &&
      Math.abs(ccx - this.lastGround.x) < GROUND_MARGIN / 2 &&
      Math.abs(ccy - this.lastGround.y) < GROUND_MARGIN / 2
    )
      return;
    this.lastGround = { x: ccx, y: ccy };

    const world = this.world;
    const { dx, dy, lh, tile } = MAP_GEOMETRY;
    const rt = this.groundRT;
    // Anchor the texture in world space around the camera centre.
    const ax = Math.round(ccx - rt.width / 2);
    const ay = Math.round(ccy - rt.height / 2);
    rt.setPosition(ax, ay);
    rt.clear();
    rt.fill(0x181c28, 1);

    // Covered rect in virtual-canvas coords, padded for tile size + max lift.
    const x0 = ax - tile;
    const x1 = ax + rt.width + tile;
    const y0 = ay - tile;
    const y1 = ay + rt.height + tile + this.maxLevel * lh;
    // u = col−row indexes screen-x; v = col+row indexes screen-y.
    const u0 = Math.floor((x0 - this.iso.ox) / dx) - 1;
    const u1 = Math.ceil((x1 - this.iso.ox) / dx) + 1;
    const v0 = Math.max(0, Math.floor((y0 - this.iso.oy) / dy) - 1);
    const v1 = Math.ceil((y1 - this.iso.oy) / dy) + 1;

    rt.beginDraw();
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        if ((u + v) & 1) continue; // col/row must be integers
        const col = (u + v) / 2;
        const row = (v - u) / 2;
        if (col < 0 || row < 0 || col >= world.width || row >= world.height) continue;
        const cell = world.rows[row][col];
        const bx = this.iso.ox + u * dx - ax;
        const by = this.iso.oy + v * dy - ay;
        if (this.maps2) {
          // maps2: the world bakes the exact TOP tile per cell; terraces are
          // built by stacking the material's plain FACE tile 16px per level
          // (LEVEL_PX), with the cell's top tile last (like maps2 render2.py).
          const topKey0 = topKeyFor(cell);
          if (!topKey0 || !this.textures.exists(topKey0)) continue; // void cell
          // world@1 mirror: some transition tiles are placed flipped; honour it
          // or borders face the wrong way. RT batchDraw can't flip, so draw a
          // lazily-mirrored texture copy for flipped cells.
          const topKey = cell.flip ? this.flippedKey(topKey0) : topKey0;
          const faceKey = faceKeyFor(world, cell);
          const fk = faceKey && this.textures.exists(faceKey) ? faceKey : topKey0;
          for (let lvl = 0; lvl < cell.l; lvl++) rt.batchDraw(fk, bx, by - lvl * lh);
          rt.batchDraw(topKey, bx, by - cell.l * lh);
          // world@2 deck slab (roof / bridge span) at this cell, drawn right
          // after its base in (x+y) order: `thickness` face tiles below the top
          // with OPEN AIR beneath (so you see under it), then the top diamond.
          const dk = this.deckIndex.get(row * world.width + col);
          if (dk && dk.cell.path) {
            const dTop0 = pathTileKey(dk.cell.path);
            if (this.textures.exists(dTop0)) {
              const dTop = dk.cell.flip ? this.flippedKey(dTop0) : dTop0;
              const dFace = this.deckFaceKey(dk.deck, dTop0);
              const lvl0 = Math.max(0, dk.deck.level - dk.deck.thickness);
              for (let lvl = lvl0; lvl < dk.deck.level; lvl++) rt.batchDraw(dFace, bx, by - lvl * lh);
              rt.batchDraw(dTop, bx, by - dk.deck.level * lh);
            }
          }
          continue;
        }
        const key = tileKey(cell.t, cell.v);
        if (!this.textures.exists(key)) continue;
        // Per-level stacking builds raised TERRAIN columns out of flat tiles.
        // SOLID structures (trees, pillars, towers) are one object: stacking
        // their tall art drew 2-3 overlapping copies ("two long tiles on top
        // of each other" — trees on earth columns, scalloped pillar bases).
        // They draw exactly once, grounded at their cell's level, like the
        // maps agent's own renderer.
        const sSolid = surfaceFor(cell.t);
        const fromLvl = !sSolid.standable && !sSolid.swimmable
          ? cell.l
          : 0;
        for (let lvl = fromLvl; lvl <= cell.l; lvl++)
          rt.batchDraw(key, bx, by - lvl * lh - this.artYOff(key));
      }
    }
    rt.endDraw();
  }

  /** Start a jump if grounded and off cooldown (client-side prediction; the
   * server independently validates from the jump input). */
  /** Camera zoom for the current viewport: integer, targeting ~520 world-px
   * of visible width (see the note at create's setZoom call). */
  /** Living camera: ease the view toward the player's rendered position
   * (capped trail = the chase), and shed up to CAM_ZOOM_OUT of the base
   * integer zoom proportionally to the avatar's world speed so movement
   * reveals slightly more of the world. At rest it settles back onto the
   * crisp integer zoom and dead-centres the player. */
  private updateChaseCam(deltaMs: number) {
    if (this.camDetached) return;
    const id = this.room?.sessionId;
    const av = id ? this.avatars.get(id) : undefined;
    if (!av) return;
    const cam = this.cameras.main;
    const tx = av.sprite.x;
    const ty = av.sprite.y;
    const dt = Math.min(deltaMs, 100) / 1000;
    const base = this.zoomFor();

    if (!this.camChase.init || Math.hypot(tx - this.camChase.x, ty - this.camChase.y) > CAM_SNAP_DIST) {
      this.camChase = { x: tx, y: ty, zoom: base, init: true };
    } else {
      const a = 1 - Math.exp(-dt / CAM_TAU);
      this.camChase.x += (tx - this.camChase.x) * a;
      this.camChase.y += (ty - this.camChase.y) * a;
      const ddx = tx - this.camChase.x;
      const ddy = ty - this.camChase.y;
      const d = Math.hypot(ddx, ddy);
      if (d > CAM_TRAIL_MAX) {
        this.camChase.x = tx - (ddx / d) * CAM_TRAIL_MAX;
        this.camChase.y = ty - (ddy / d) * CAM_TRAIL_MAX;
      }
      // Zoom breathes with WORLD speed (spdWu is the gait EMA — water
      // slowdowns and walk/run all scale it naturally).
      const k = Math.min(1, Math.max(0, (av.spdWu ?? 0) / CAM_ZOOM_REF_WU));
      const zTarget = base * (1 - CAM_ZOOM_OUT * k);
      const tau = zTarget < this.camChase.zoom ? CAM_ZOOM_TAU_OUT : CAM_ZOOM_TAU_IN;
      const za = 1 - Math.exp(-dt / tau);
      this.camChase.zoom += (zTarget - this.camChase.zoom) * za;
      if (Math.abs(this.camChase.zoom - zTarget) < 0.0015) this.camChase.zoom = zTarget;
    }
    cam.setZoom(this.camChase.zoom);
    cam.centerOn(this.camChase.x, this.camChase.y);
  }

  /** Device-pixel render scale (window.devicePixelRatio, clamped): the canvas
   * backing is RS× the CSS size. 1 on standard-DPI / desktop / tests. */
  private renderScale(): number {
    return (this.registry.get("renderScale") as number) || 1;
  }

  private zoomFor(): number {
    // Pick the base zoom from the CSS width (scale.width / rs), then × rs so the
    // camera renders at DEVICE pixels while the visible world extent is unchanged
    // (1 world px still = base·rs backing px = base device px). rs=1 → byte-identical.
    const rs = this.renderScale();
    return Math.max(1, Math.round(this.scale.width / (520 * rs))) * rs;
  }

  private tryJump() {
    const now = this.time.now;
    if (now < this.jumpUntil || now < this.jumpReadyAt) return;
    this.jumpUntil = now + JUMP_MS;
    this.jumpReadyAt = now + JUMP_MS + JUMP_COOLDOWN_MS;
    this.jumpQueued = true;
  }

  /** Draw the local player's swim-stamina bar (bottom-centre HUD), shown only
   * while swimming or recovering. */
  /** First cliff-face level of a terrain column that is actually EXPOSED —
   * one above the LOWER of the E/S front neighbours' tops. The rationale is
   * at the call site: the ground RT already bakes every cell's full face
   * stack with the lower FRONT cells drawn over it, so re-drawing a COVERED
   * face here — on top of the RT, at occluder depth — repaints a wall over
   * the front cell's ground (the "half-tile" terrace tear).
   *
   * DECK-BLIND ON PURPOSE (do not "fix" this): it reads only base terrain
   * levels. A deck is a slab covering the BAND [level-thickness, level], not
   * a prefix [0..h], so folding a deck's height into this "first level to
   * draw" number is not expressible here and would UNDER-draw. Measured on
   * the_island2: a naive deck-aware variant cuts 4,748 terrain faces that
   * nothing covers — a far worse tear than the one this rule fixed. Over-
   * drawing because of a deck is the safe direction, and costs 0 faces on
   * every shipped world today.
   * (`solid` is vestigial — the one caller always passes false.) */
  private stackFrom(col: number, row: number, l: number, solid: boolean): number {
    if (solid) return l;
    const lE = this.world?.rows[row]?.[col + 1]?.l ?? -1;
    const lS = this.world?.rows[row + 1]?.[col]?.l ?? -1;
    return Math.max(0, Math.min(l, Math.min(lE, lS) + 1));
  }

  /** The DECK equivalent of stackFrom: the first slab-face level of this deck
   * cell that no FRONT (E/S) neighbour already covers.
   *
   * The deck branch had no exposure test at all — it drew `thickness` face
   * images at EVERY deck cell. the_island2's 12 cave decks are 16-32 levels
   * thick, so an interior cave cell cost 17-33 images, and decks were ~65% of
   * every occluder image in the mountain window (measured: 9,952 of 15,228).
   * A cell deep inside a slab is walled in by its own neighbours on both
   * front sides and needs only its TOP.
   *
   * Cover is a BAND, not a prefix: a neighbour covers `[nLvl0, nLevel]` from
   * its own slab, and `[0, n.l]` from its base column. Only the CONTIGUOUS
   * run that reaches down to my own bottom (`from`) actually hides my faces —
   * a neighbour slab floating higher than my bottom leaves open air below it,
   * and a face there is genuinely visible from underneath. Returning `from`
   * (draw everything) is always the safe answer. */
  private deckCoverFrom(col: number, row: number, from: number, level: number): number {
    const w = this.world;
    if (!w) return from;
    // How far up from `from` does this neighbour cover CONTIGUOUSLY?
    const coverTop = (c: number, r: number): number => {
      const cell = w.rows[r]?.[c];
      if (!cell) return -1; // off-map / void: covers nothing
      let top = cell.l; // base column covers [0 .. l]
      const nd = this.deckIndex.get(r * w.width + c);
      if (nd) {
        const nLo = Math.max(0, nd.deck.level - nd.deck.thickness);
        // The slab extends the run only if it MEETS the base column (or my
        // own bottom) — otherwise there is open air between them.
        if (nLo <= top + 1 || nLo <= from) top = Math.max(top, nd.deck.level);
      }
      return top;
    };
    const cover = Math.min(coverTop(col + 1, row), coverTop(col, row + 1));
    // One above the lower front cover, clamped into my own [from, level] band.
    return Math.max(from, Math.min(level, cover + 1));
  }

  private artYOff(key: string): number {
    let off = this.artOffCache.get(key);
    if (off === undefined) {
      // Per-variant measured base (tile-bases.json) when available — "extra
      // long" art (content to the canvas bottom) gets a deeper lift than
      // "long" art, so nothing sinks. Solid structures anchor their bottom V
      // to the surface diamond (footprint = collision diamond). Fallback:
      // the old constant imgH - 64.
      const [, t, v] = key.split(":");
      const sf = surfaceFor(t);
      const src = this.textures.get(key)?.getSourceImage() as { height?: number } | undefined;
      off = artLift(this.tileBases, t, Number(v), src?.height ?? 64, !sf.standable && !sf.swimmable);
      this.artOffCache.set(key, off);
    }
    return off;
  }

  /**
   * Rebuild the occluder set: every raised (l>0) or solid non-water tile near
   * the camera gets real depth-sorted images (depth = its footprint's TOP
   * vertex y), so sprites standing behind it are covered while sprites in
   * front draw over it. The ground RT stays as the flat base underneath.
   */
  /** Tag a maps2 terrain occluder image with its cell, top level and original
   * depth so the occlusion-fade pass can find/ghost/restore it. */
  private tagOccluder(
    img: Phaser.GameObjects.Image,
    col: number,
    row: number,
    top: number,
    od: number,
  ): Phaser.GameObjects.Image {
    img.setData("oc", col);
    img.setData("or", row);
    img.setData("ot", top);
    img.setData("od", od);
    return img;
  }

  /**
   * Occlusion fade (see the field note). Two parts, both keyed to the local
   * player (or debug `occFocus`):
   *  (1) tall occluders ABOVE the focus level, camera-closer than it, within a
   *      radius are dimmed to a faint GHOST and moved behind the player so they
   *      stop hiding the character;
   *  (2) a REVEAL render-texture redraws the player-level GROUND those towers
   *      were covering (so you see the grass/level you walk on, not the tower)
   *      and drops a BLACK diamond at each tower's ROOT (base footprint = void).
   */
  private updateOcclusionFade() {
    const world = this.world;
    const R = 14; // bubble radius in cells
    const GHOST = -800_000; // faded tower ghost: above the reveal layer, below sprites
    let fc = this.occFocus;
    const pav = this.room ? this.avatars.get(this.room.sessionId) : undefined;
    if (!fc && pav) fc = { col: Math.floor(pav.fx / CELL_WU), row: Math.floor(pav.fy / CELL_WU) };
    const active = this.occFadeOn && this.maps2 && !!world && !!fc;
    if (active && world && fc) {
      const fLevel = world.rows[fc.row]?.[fc.col]?.l ?? 0;
      const fSum = fc.col + fc.row;
      for (const o of this.occluders) {
        const col = o.getData("oc") as number | undefined;
        if (col === undefined) continue; // untagged (legacy/demo) — leave as-is
        const row = o.getData("or") as number;
        const top = o.getData("ot") as number;
        const od = o.getData("od") as number;
        const dist = Math.hypot(col - fc.col, row - fc.row);
        if (top > fLevel && dist < R && col + row > fSum) {
          const clear = Math.min(1, 1 - dist / R); // 1 at focus → 0 at edge
          o.setDepth(GHOST).setAlpha(0.16 + 0.34 * (1 - clear)); // fainter nearer the player
        } else {
          o.setDepth(od).setAlpha(1);
        }
      }
      this.occGhosted = true;
    } else if (this.occGhosted) {
      // ONE restore sweep, on the frame the feature (or the focus) goes away.
      // This used to run EVERY frame with the feature OFF — a getData +
      // setDepth + setAlpha over the whole occluder set, which on the_island2's
      // cave/mountain region is 6-15k Images, and every setDepth re-queues
      // Phaser's display-list sort. Measured 1.33ms/frame at (120,32) for a
      // feature that is off by default (ULTRACODE lag investigation, fix #1).
      // Fresh occluders are born with their natural depth/alpha, so
      // rebuildOccluders clears the flag rather than needing a sweep.
      for (const o of this.occluders) {
        const od = o.getData("od") as number | undefined;
        if (od !== undefined) o.setDepth(od).setAlpha(1);
      }
      this.occGhosted = false;
    }
    this.updateOccReveal(active && fc ? fc : null, pav, R);
  }

  /** Lazily build the occlusion-fade assets: a black cell-diamond (tower roots)
   * drawn into the reveal layer. */
  private ensureOccAssets() {
    const { tile, dy } = MAP_GEOMETRY;
    if (this.textures.exists("occ-root")) return;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0x000000, 1).beginPath();
    g.moveTo(tile / 2, 0);
    g.lineTo(tile, dy);
    g.lineTo(tile / 2, dy * 2);
    g.lineTo(0, dy);
    g.closePath();
    g.fillPath();
    g.generateTexture("occ-root", tile, dy * 2);
    g.destroy();
  }

  /**
   * Reveal layer: a world-anchored RenderTexture drawn just above the ground RT
   * (−900k) but below the faded ghosts + sprites. Within `R` cells of the focus
   * it redraws the player-level GROUND (walkable cells at/below the focus level)
   * — so a faded tower reveals the grass you walk on — and paints a BLACK
   * diamond at every taller cell's ROOT so the tower's own footprint reads as
   * void, never walkable. Redrawn only when the player/camera moves.
   */
  private updateOccReveal(fc: { col: number; row: number } | null, pav: Avatar | undefined, R: number) {
    if (!fc || !this.world || !pav) {
      this.occRevealRT?.setVisible(false);
      return;
    }
    this.ensureOccAssets();
    const { dx, dy, lh, tile } = MAP_GEOMETRY;
    if (!this.occRevealRT) {
      const rs = this.renderScale(); // world-space RT — size in world px (see makeGroundRT)
      this.occRevealRT = this.add
        .renderTexture(0, 0, this.scale.width / rs + GROUND_MARGIN * 2, this.scale.height / rs + GROUND_MARGIN * 2)
        .setOrigin(0, 0)
        .setDepth(-900_000);
    }
    const rt = this.occRevealRT;
    rt.setVisible(true);
    const cam = this.cameras.main;
    const ccx = cam.worldView.centerX; // zoom-correct world centre (see redrawGround)
    const ccy = cam.worldView.centerY;
    // Redraw only when the player or camera drifts — otherwise the texture holds.
    if (
      !Number.isNaN(this.lastReveal.x) &&
      Math.abs(pav.fx - this.lastReveal.x) < 4 &&
      Math.abs(pav.fy - this.lastReveal.y) < 4 &&
      Math.abs(ccx - this.lastReveal.cx) < 4 &&
      Math.abs(ccy - this.lastReveal.cy) < 4
    )
      return;
    this.lastReveal = { x: pav.fx, y: pav.fy, cx: ccx, cy: ccy };
    const world = this.world;
    const ax = Math.round(ccx - rt.width / 2);
    const ay = Math.round(ccy - rt.height / 2);
    rt.setPosition(ax, ay);
    rt.clear();
    const fLevel = world.rows[fc.row]?.[fc.col]?.l ?? 0;
    const fSum = fc.col + fc.row;
    const x0 = ax - tile;
    const x1 = ax + rt.width + tile;
    const y0 = ay - tile;
    const y1 = ay + rt.height + tile + this.maxLevel * lh;
    const u0 = Math.floor((x0 - this.iso.ox) / dx) - 1;
    const u1 = Math.ceil((x1 - this.iso.ox) / dx) + 1;
    const v0 = Math.max(0, Math.floor((y0 - this.iso.oy) / dy) - 1);
    const v1 = Math.ceil((y1 - this.iso.oy) / dy) + 1;
    rt.beginDraw();
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        if ((u + v) & 1) continue;
        const col = (u + v) / 2;
        const row = (v - u) / 2;
        const cell = world.rows[row]?.[col];
        if (!cell) continue;
        if (Math.hypot(col - fc.col, row - fc.row) > R) continue;
        const bx = this.iso.ox + u * dx - ax;
        const by = this.iso.oy + v * dy - ay;
        if (cell.l > fLevel && col + row > fSum) {
          // Taller than the player, in front of them → black root diamond (void).
          rt.batchDraw("occ-root", bx, by);
        } else if (surfaceFor(cell.t).standable || surfaceFor(cell.t).swimmable) {
          // The ground the player walks on — re-expose it over the towers above.
          const k0 = topKeyFor(cell);
          if (k0 && this.textures.exists(k0)) rt.batchDraw(cell.flip ? this.flippedKey(k0) : k0, bx, by - cell.l * lh);
        }
      }
    }
    rt.endDraw();
  }

  private rebuildOccluders() {
    if (!this.world) return;
    const cam = this.cameras.main;
    const ccx = cam.worldView.centerX;
    const ccy = cam.worldView.centerY;
    if (
      !Number.isNaN(this.lastOccl.x) &&
      Math.abs(ccx - this.lastOccl.x) < 96 &&
      Math.abs(ccy - this.lastOccl.y) < 96
    )
      return;
    this.lastOccl = { x: ccx, y: ccy };
    for (const im of this.occluders) im.destroy();
    for (const lo of this.litOccluders) lo.img.destroy();
    // The new set is built fresh at natural depth/alpha — no ghost state to
    // restore (updateOcclusionFade re-applies it next frame if the fade is on).
    this.occGhosted = false;
    this.litOccluders = [];
    this.occluders = [];
    this.occluderMeta = [];
    this.emissiveLights = [];

    const { dx, dy, lh, tile: tileSize } = MAP_GEOMETRY;
    const pad = 200;
    const x0 = cam.worldView.x - pad;
    const x1 = cam.worldView.right + pad;
    const y0 = cam.worldView.y - pad;
    const y1 = cam.worldView.bottom + pad + this.maxLevel * lh;
    const u0 = Math.floor((x0 - this.iso.ox) / dx) - 1;
    const u1 = Math.ceil((x1 - this.iso.ox) / dx) + 1;
    const v0 = Math.max(0, Math.floor((y0 - this.iso.oy) / dy) - 1);
    const v1 = Math.ceil((y1 - this.iso.oy) / dy) + 1;
    // VIEW CULL (perf 2026-07-31). The scan window above is deliberately huge:
    // its bottom carries `maxLevel * lh` (640px on the_island2) because a tall
    // column's ART rises from a footprint far below the screen, so those cells
    // MUST still be scanned. But an individual face/top IMAGE at level `lvl`
    // is drawn at `by - lvl*lh` and is one tile tall — most of them land
    // nowhere near the view. Measured: 82% of every image built never
    // intersects the camera at all.
    //
    // Culling an occluder can never leave a HOLE: the ground RT (depth
    // -1,000,000) already paints all this terrain. An occluder is only a
    // duplicate re-issued at sprite depth so bodies can interleave with it —
    // so the sole cost of over-culling is a body sorting wrongly against
    // terrain, which is why the box is padded by OCC_CULL_PAD (a full rebuild
    // step, a tile, and the widest body art box) rather than hugging the view.
    // occluderMeta is NOT culled: it is one record per CELL, it is what
    // resolveBodyDepth actually reads, and it is not what costs anything.
    const cx0 = cam.worldView.x - OCC_CULL_PAD;
    const cx1 = cam.worldView.right + OCC_CULL_PAD;
    const cy0 = cam.worldView.y - OCC_CULL_PAD;
    const cy1 = cam.worldView.bottom + OCC_CULL_PAD;
    let culled = 0;
    /** Is a tile-sized image drawn at (ix, iy) inside the cull box? */
    const shows = (ix: number, iy: number) =>
      ix + tileSize >= cx0 && ix <= cx1 && iy + tileSize >= cy0 && iy <= cy1;
    /** Does a WHOLE column (its occluderMeta box: art top `iyTop` down to the
     * footprint at `iyBot`) reach the cull box? A column that does MUST keep
     * at least one image — `resolveBodyDepth` clamps a body's depth and crops
     * its lit copy from the META box, so a column that still sorts against an
     * on-screen body while drawing nothing produces the classic artifact: a
     * body cut off at `coverY` behind terrain that is no longer there. Columns
     * that fail this test are outside view+OCC_CULL_PAD entirely and can never
     * overlap an on-screen body's art box, so culling them whole is safe. */
    const columnShows = (ix: number, iyTop: number, iyBot: number) =>
      ix + tileSize >= cx0 && ix <= cx1 && iyBot >= cy0 && iyTop <= cy1;
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        if ((u + v) & 1) continue;
        const col = (u + v) / 2;
        const row = (v - u) / 2;
        const cell = this.world.rows[row]?.[col];
        if (!cell) continue;
        const s = surfaceFor(cell.t);
        if (this.maps2) {
          // world@2 DECK occluder: a slab floating ABOVE its base (deck.level >
          // base level) must occlude whoever walks/swims under it, and must draw
          // on top of the ground RT so it's visible over the walls it roofs.
          // Built regardless of the base cell's own level (the interior floor is
          // l=0, which the terrain branch below skips). Where the deck coincides
          // with its base top (deck.level == base l — a roof lapping its own
          // walls), the terrain occluder already covers it, so skip.
          const dk = this.deckIndex.get(row * this.world.width + col);
          if (dk && dk.cell.path && dk.deck.level > cell.l) {
            const dTop0 = pathTileKey(dk.cell.path);
            if (this.textures.exists(dTop0)) {
              const dFace = this.deckFaceKey(dk.deck, dTop0);
              const bx0 = this.iso.ox + u * dx;
              const by0 = this.iso.oy + v * dy;
              const dDepth = by0 + dy;
              const lvl0 = Math.max(0, dk.deck.level - dk.deck.thickness);
              // EXPOSED slab faces only — the rule the terrain branch has had
              // since the terrace-tear fix, which the deck branch never got.
              // A cave cell walled in by its own slab on both front sides
              // needs nothing but its top; these decks are 16-32 thick, and
              // this was ~65% of every occluder image in the mountain window.
              const dFrom = this.deckCoverFrom(col, row, lvl0, dk.deck.level);
              for (let lvl = dFrom; lvl < dk.deck.level; lvl++) {
                if (!shows(bx0, by0 - lvl * lh)) {
                  culled++;
                  continue;
                }
                this.occluders.push(
                  this.tagOccluder(this.add.image(bx0, by0 - lvl * lh, dFace).setOrigin(0, 0).setDepth(dDepth), col, row, dk.deck.level, dDepth),
                );
              }
              culled += dFrom - lvl0;
              // The deck TOP is the walkable surface — it is what occludes a
              // body walking UNDER the slab. Never exposure-cull it, and keep
              // it whenever the COLUMN reaches the cull box (not merely when
              // the top tile itself does), so a meta record can never describe
              // terrain that draws nothing.
              if (columnShows(bx0, by0 - dk.deck.level * lh, by0 + tileSize))
                this.occluders.push(
                  this.tagOccluder(
                    this.add.image(bx0, by0 - dk.deck.level * lh, dTop0).setOrigin(0, 0).setFlipX(!!dk.cell.flip).setDepth(dDepth),
                    col, row, dk.deck.level, dDepth,
                  ),
                );
              else culled++;
              this.occluderMeta.push({
                col, row, top: dk.deck.level, solid: false, depth: dDepth,
                x0: bx0, x1: bx0 + tileSize, y0: by0 - dk.deck.level * lh, y1: by0 + tileSize,
              });
            }
          }
          // maps2 cells bake an explicit tile PNG path (loaded under
          // pathTileKey), NOT the legacy tile:(t,v) key — so the legacy branch
          // below finds no texture and builds ZERO occluders, leaving every
          // sprite drawn ON TOP of raised terraces. Build the occluder column
          // here instead, mirroring the ground pass's stacking (faces 0..l-1,
          // then the baked top at l). Flat (l=0) and void cells never occlude.
          if (cell.l <= 0) continue;
          const topKey = topKeyFor(cell);
          if (!topKey || !this.textures.exists(topKey)) continue;
          const faceKey = faceKeyFor(this.world, cell);
          const fk = faceKey && this.textures.exists(faceKey) ? faceKey : topKey;
          const bx = this.iso.ox + u * dx;
          const by = this.iso.oy + v * dy;
          const oDepth = by + dy;
          // Draw only the EXPOSED cliff faces (from the lowest front neighbour
          // up). The ground RT already bakes every cell's full face stack with
          // the lower front cells drawn OVER it; redrawing the covered lower
          // faces here — on top of the RT at a high depth — re-exposed them,
          // painting the front cell's ground back into a wall (the "half-tile"
          // terrace tear). stackFrom = one above the lower of the E/S fronts.
          for (let lvl = this.stackFrom(col, row, cell.l, false); lvl < cell.l; lvl++) {
            if (!shows(bx, by - lvl * lh)) {
              culled++;
              continue;
            }
            this.occluders.push(
              this.tagOccluder(this.add.image(bx, by - lvl * lh, fk).setOrigin(0, 0).setDepth(oDepth), col, row, cell.l, oDepth),
            );
          }
          // Keep the top whenever the COLUMN reaches the cull box, so every
          // meta record in range still has drawn art behind it (see
          // columnShows).
          if (columnShows(bx, by - cell.l * lh, by + tileSize))
            this.occluders.push(
              // Occluder images CAN flip directly (setFlipX) — matches the RT's
              // mirrored top so the two layers stay pixel-aligned for flipped cells.
              this.tagOccluder(
                this.add.image(bx, by - cell.l * lh, topKey).setOrigin(0, 0).setFlipX(!!cell.flip).setDepth(oDepth),
                col,
                row,
                cell.l,
                oDepth,
              ),
            );
          else culled++;
          this.occluderMeta.push({
            col,
            row,
            top: cell.l, // maps2 terrain is all standable ground: visual top = level
            solid: false,
            depth: oDepth,
            x0: bx,
            x1: bx + tileSize,
            y0: by - cell.l * lh,
            y1: by + tileSize,
          });
          continue;
        }
        // Emissive tiles (tiles/emission.json): atmosphere bloom for the
        // canvas fallback (glow POOLS are collected in their own wider pass
        // below). Per-VARIANT: plain variants of a glowing category stay
        // dark (only variants with detected glow sources emit; v1 entries
        // emit always).
        const em = this.emission[cell.t];
        const variantGlows = em && (!em.sources || (em.sources[String(cell.v)]?.length ?? 0) > 0);
        if (em && variantGlows && !this.night && this.emissiveLights.length < MAX_EMISSIVE) {
          const hex =
            (Math.round(em.color[0] * 255) << 16) |
            (Math.round(em.color[1] * 255) << 8) |
            Math.round(em.color[2] * 255);
          this.emissiveLights.push({
            x: this.iso.ox + u * dx + dx,
            y: this.iso.oy + v * dy + dy - cell.l * lh,
            color: hex,
            radius: em.radius * 32,
            ground: true,
            depth: this.iso.oy + v * dy + dy + 0.2, // occluded by fronting walls
          });
        }
        const tall = cell.l > 0 || (!s.standable && !s.swimmable);
        if (!tall) continue;
        const key = tileKey(cell.t, cell.v);
        if (!this.textures.exists(key)) continue;
        const bx = this.iso.ox + u * dx;
        const by = this.iso.oy + v * dy;
        // Depth = the column's CENTRE line (by + dy); avatars refine their
        // own depth against these per frame (see update) since a single
        // scalar can't resolve every sprite-vs-column case exactly. SOLID
        // structures draw ONCE (same rule as the ground RT) and get a +0.5
        // depth bias: they STAND ON their cell, in front of every terrain
        // copy on the same diagonal — so a sprite clamped behind a pillar
        // (below - 0.3) still stays ABOVE the neighbouring grass copies
        // (playtester: "my foot is drawn behind the grass to the left").
        // Every raised terrain cell keeps its copies: the occluder layer is
        // a complete painter re-render of the raised world, and each rim's
        // buried stack layers are covered by the cells in front of it —
        // culling "interior" cells re-exposed them ("tiles drawn 3 times").
        const solidHere = !s.standable && !s.swimmable;
        const oDepth = by + dy + (solidHere ? 0.5 : 0);
        const aOff = this.artYOff(key);
        const fromLvl = solidHere
          ? cell.l
          : 0;
        for (let lvl = fromLvl; lvl <= cell.l; lvl++) {
          this.occluders.push(
            this.add.image(bx, by - lvl * lh - aOff, key).setOrigin(0, 0).setDepth(oDepth),
          );
        }
        // DEMO stations: a raised EMISSIVE terrain column (flat glowing tile
        // stacked to expose its faces) gets floor-tinted glow copies of the
        // whole stack — the wall's lowest band falls into the diamond
        // interlock wedge where the shader resolves pixels to the dark
        // meadow IN FRONT, leaving an unlit "step" at the base (#64).
        // Tall solids get a LIT COPY above the darkness overlay (see the
        // litOccluders field note): billboard art must be lit by its OWN
        // cell, not by whatever terrain lies behind its upper pixels.
        // EMISSIVE variants additionally carry their emission entry — the
        // copy's tint gets the self-glow FLOOR (max per channel), so the
        // glow follows the ART'S OWN SHAPE instead of the shader's world
        // geometry (which lit the flat cell diamond / an analytic box
        // around the art — playtester, demo #28). Same depth band as every
        // other lit copy; no new ordering rules.
        if (this.night && solidHere && aOff > 0) {
          this.litOccluders.push({
            img: this.add
              .image(bx, by - cell.l * lh - aOff, key)
              .setOrigin(0, 0)
              .setDepth(litDepth(oDepth)),
            col: col + 0.5,
            row: row + 0.5,
            z: cell.l + 0.5,
            emission: em && variantGlows ? em : undefined,
            phase: ((((col * 73856093) ^ (row * 19349663)) >>> 0) % 628) / 100,
          });
        }
        this.occluderMeta.push({
          col,
          row,
          // Solid structures (trees, boulders…) visually stand ~1 level tall.
          top: cell.l + (s.standable ? 0 : 1),
          solid: solidHere,
          depth: oDepth,
          x0: bx,
          x1: bx + tileSize,
          y0: by - cell.l * lh - aOff,
          y1: by + tileSize,
        });
      }
    }

    this.occCulled = culled;

    // Placed props (maps2 world@1) share the occluder rebuild: they're tall
    // billboards that also occlude characters, so building them here — under
    // the same camera-move guard, appending to the SAME occluderMeta — keeps
    // the two layers atomic (a separate guard could rebuild one without the
    // other and desync the depth metadata).
    this.rebuildProps(cam);

    // Per-pixel glow halos (tile-emission@2 sources) for this window. Demo
    // stations draw tall art ONCE at ground level, so every source anchors
    // to the drawn art instead of repeating down a stacked column.
    this.glowStamps = buildGlowStamps(
      this.world,
      this.emission,
      this.iso,
      { x0, y0, x1, y1 },
      this.maxLevel,
      undefined,
      (t, v) => this.artYOff(tileKey(t, v)),
      false,
    ).concat(this.buildPoolStamps(cam)).concat(this.propStamps);
  }

  /**
   * Rebuild the placed-decoration set (maps2 world@1 `props`): each prop is a
   * TALL 64×128 tile standing on its cell, drawn as a depth-sorted billboard so
   * characters pass in front of / behind it. Called from rebuildOccluders under
   * its camera-move guard, so it culls to the same window and appends to the
   * same occluderMeta.
   *
   * ANCHOR: a prop's canvas is NOT bottom-full — the object's ground-contact row
   * varies (a short bush ends high in the canvas, a tall tower nearly fills it).
   * So we measure each prop's opaque BOTTOM (its base V) and plant it on the
   * cell's grid diamond FRONT vertex (groundTop + 2·dy), so the base sits IN the
   * grid cell. Two earlier tries were wrong: bottom-of-CANVAS (imgH−64) only
   * matched full-height props; content-bottom-to-skirt (row 54, as propdemo.py
   * does) dropped every prop one elevation level below the grid V (playtester).
   */
  private rebuildProps(cam: Phaser.Cameras.Scene2D.Camera) {
    for (const im of this.propImgs) im.destroy();
    this.propImgs = [];
    this.propStamps = [];
    if (!this.world || !this.maps2) return;
    const props = this.world.props;
    if (!props || !props.length) return;
    const ANIM: Record<string, number> = { static: 0, pulse: 1, flicker: 2 };

    const { dx, dy, lh, tile: tileSize } = MAP_GEOMETRY;
    const pad = 200;
    // A tall prop rises well above its ground box, so pad the top generously.
    const x0 = cam.worldView.x - pad;
    const x1 = cam.worldView.right + pad;
    const y0 = cam.worldView.y - pad - 128;
    const y1 = cam.worldView.bottom + pad + this.maxLevel * lh;
    // Anchor row: the cell's grid diamond FRONT vertex — groundTop (the surface
    // diamond's top row) + the diamond's full height (2·dy). A prop's opaque
    // BOTTOM (its base V) is planted here so it sits IN the grid cell, not one
    // level below it. maps2's propdemo aligns to the tile's SKIRT bottom (row
    // 54) instead, which drops every prop a full elevation level — the base V
    // ended up under the grid V (playtester). The skirt is the flat tile's own
    // front face; a prop is not part of that face.
    const anchorRow = (this.tileBases?.groundTop ?? 8) + 2 * dy;
    for (const p of props) {
      const cell = this.world.rows[p.row]?.[p.col];
      const key = pathTileKey(p.path);
      if (!this.textures.exists(key)) continue;
      const lvl = cell?.l ?? 0;
      const u = p.col - p.row;
      const v = p.col + p.row;
      const bx = this.iso.ox + u * dx;
      const byGround = this.iso.oy + v * dy - lvl * lh; // ground tile top-left
      const b = this.propBounds(key); // opaque {top,bottom} rows in the art
      const py = byGround + anchorRow - b.bottom; // base V on the grid diamond vertex
      if (bx + tileSize < x0 || bx > x1 || py + b.bottom < y0 || py + b.top > y1) continue;
      // Unlifted ground line (matches occluders + character depth), so painter
      // order by (col+row) puts characters correctly in front / behind.
      const depth = this.iso.oy + v * dy + dy;
      this.propImgs.push(this.add.image(bx, py, key).setOrigin(0, 0).setDepth(depth));
      // Self-emission: an emissive prop (a tiles2 tile with glow `sources`).
      // Two SEPARATE jobs, mirroring how the bonfire works vs how it looked
      // buggy before (root-caused with the playtester):
      //   • light ON THE GROUND + CHARACTER: a strong pool at GROUND level in
      //     the prop's real glow colour. Ground-anchored ⇒ the base lights up
      //     AND a character brightens monotonically as it walks in (litChar).
      //   • glow ON THE ART: the sharp per-source halos stamped high on the
      //     tall tile so the runes/crystals bloom — cosmetic only (litChar
      //     false), because sampling a HIGH point from the character's feet
      //     made it brighter-then-darker as you approached.
      const srcs = this.night ? this.tiles2Src[p.path] : undefined;
      if (srcs?.length) {
        const mat = p.path.split("/")[1]; // tiles2/<material>/…
        const em = this.tiles2Mat[mat];
        const anim = ANIM[em?.anim ?? "static"] ?? 0;
        // The prop's ACTUAL glow colour = strength-weighted mean of its source
        // colours (a stone obelisk's material hue is blue, but its runes glow
        // GREEN — the character was green, so the ground must be too), plus a
        // representative strength for the pool intensity.
        let cr = 0, cg = 0, cb = 0, sw = 0;
        for (const g of srcs) {
          cr += g.color[0] * g.s;
          cg += g.color[1] * g.s;
          cb += g.color[2] * g.s;
          sw += g.s;
        }
        const glowColor: [number, number, number] =
          sw > 0 ? [cr / sw, cg / sw, cb / sw] : em?.color ?? [1, 1, 1];
        const avgS = srcs.length ? sw / srcs.length : 0;
        // (a) GROUND POOL — the bonfire-like wash at ground level, in the real
        // glow colour. The ONLY stamp that tints characters (litChar). Nudged a
        // few px toward the camera-front so the standing sprite doesn't sit on
        // the brightest core.
        const rCells = (em?.radius ?? 2) + 0.5;
        this.propStamps.push({
          x: bx + dx,
          y: byGround + dy + 4,
          radius: rCells * Math.SQRT2 * dx,
          ry: rCells * Math.SQRT2 * dy,
          color: glowColor,
          alpha: Math.min(0.85, avgS * 0.7),
          anim,
          phase: ((((p.col * 40503) ^ (p.row * 12289)) >>> 0) % 628) / 100,
          litChar: true,
        });
        // (b) HIGH HALOS — cosmetic bloom on the glowing pixels of the art
        // itself (rendered into the glow field over the prop body). NOT used to
        // tint characters (litChar:false) — see the field note in nightlight.ts.
        for (let i = 0; i < srcs.length; i++) {
          const g = srcs[i];
          const phase = ((((p.col * 73856093) ^ (p.row * 19349663) ^ (i * 83492791)) >>> 0) % 628) / 100;
          this.propStamps.push({
            x: bx + g.x,
            y: py + g.y,
            radius: Math.min(90, 8 + g.r * 4),
            color: g.color,
            alpha: Math.min(1, g.s * 0.4),
            anim,
            phase,
            litChar: false,
          });
        }
      }
      // Register as a SOLID billboard occluder so a character standing behind
      // the prop is hidden by it (the per-frame depth test's solidArtOver
      // branch), instead of always drawing on top.
      this.occluderMeta.push({
        col: p.col,
        row: p.row,
        top: lvl + 1, // rises at least one level above its cell → "higher"
        solid: true,
        depth,
        x0: bx,
        x1: bx + tileSize,
        y0: py + b.top,
        y1: py + b.bottom,
      });
    }
  }

  /** Opaque vertical extent {top,bottom} (rows) of a prop texture, measured
   * once from its alpha and cached — props pad their 64×128 canvas differently
   * per object, so the anchor + occluder box need the real content rows. */
  private propBoundsCache = new Map<string, { top: number; bottom: number }>();
  private propBounds(key: string): { top: number; bottom: number } {
    let b = this.propBoundsCache.get(key);
    if (b) return b;
    b = { top: 0, bottom: 63 };
    try {
      const src = this.textures.get(key).getSourceImage() as CanvasImageSource & {
        width: number;
        height: number;
      };
      const w = src.width, h = src.height;
      const cnv = document.createElement("canvas");
      cnv.width = w;
      cnv.height = h;
      const ctx = cnv.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(src, 0, 0);
        const d = ctx.getImageData(0, 0, w, h).data;
        let top = -1, bottom = -1;
        for (let y = 0; y < h; y++) {
          let op = false;
          for (let x = 0; x < w; x++)
            if (d[(y * w + x) * 4 + 3] > 16) { op = true; break; }
          if (op) {
            if (top < 0) top = y;
            bottom = y;
          }
        }
        if (bottom >= 0) b = { top, bottom };
      }
    } catch {
      // Unreadable source (shouldn't happen same-origin) — keep the fallback.
    }
    this.propBoundsCache.set(key, b);
    return b;
  }

  /** Emission glow POOLS as elliptical stamps in the additive glow field.
   *
   * One cluster bucket per EMISSION_BUCKET cells of glowing same-category
   * cells (top pool + a floating pool in front of each exposed s/e face —
   * the top pool alone left a tall column's base wall pitch dark). Formerly
   * these were shader light slots and only the nearest few
   * won one, so walking re-ranked the winners and pools popped on/off deep
   * inside the viewport. The stamp field is unlimited, and the EMISSION_PAD
   * walk window exceeds the largest pool's reach plus the 96px rebuild
   * drift — a culled pool's entire influence is off-screen, always.
   *
   * The pool's grid-circular falloff maps through the iso projection to an
   * axis-aligned screen ellipse (1 cell of grid distance = √2·dx horizontal,
   * √2·dy vertical at the extremes), so pool stamps carry ry = radius·dy/dx.
   * Pools carry their category's anim mode: fire pools flicker with the
   * gust envelope, crystal pools breathe with the slow pulse (see
   * emissionWave — the calm "alive" waveform the maintainer asked for). */
  private buildPoolStamps(cam: Phaser.Cameras.Scene2D.Camera): GlowStamp[] {
    if (!this.world || !this.night) return [];
    const { dx, dy, lh } = MAP_GEOMETRY;
    const buckets = new Map<
      string,
      { color: [number, number, number]; strength: number; radius: number; anim: number; n: number; sc: number; sr: number; z: number }
    >();
    const x0 = cam.worldView.x - EMISSION_PAD;
    const x1 = cam.worldView.right + EMISSION_PAD;
    const y0 = cam.worldView.y - EMISSION_PAD;
    const y1 = cam.worldView.bottom + EMISSION_PAD + this.maxLevel * lh;
    const u0 = Math.floor((x0 - this.iso.ox) / dx) - 1;
    const u1 = Math.ceil((x1 - this.iso.ox) / dx) + 1;
    const v0 = Math.max(0, Math.floor((y0 - this.iso.oy) / dy) - 1);
    const v1 = Math.ceil((y1 - this.iso.oy) / dy) + 1;
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        if ((u + v) & 1) continue;
        const col = (u + v) / 2;
        const row = (v - u) / 2;
        const cell = this.world.rows[row]?.[col];
        if (!cell) continue;
        const em = this.emission[cell.t];
        if (!em) continue;
        if (em.sources && !(em.sources[String(cell.v)]?.length ?? 0)) continue;
        const sample = (kind: string, sc: number, sr: number, sz: number) => {
          const bk = `${cell.t}:${kind}:${Math.floor(col / EMISSION_BUCKET)}:${Math.floor(row / EMISSION_BUCKET)}`;
          let b = buckets.get(bk);
          if (!b) {
            b = {
              color: em.color,
              strength: em.strength,
              radius: em.radius,
              anim: em.anim === "flicker" ? 2 : em.anim === "pulse" ? 1 : 0,
              n: 0,
              sc: 0,
              sr: 0,
              z: 0,
            };
            buckets.set(bk, b);
          }
          b.n++;
          b.sc += sc;
          b.sr += sr;
          b.z += sz;
        };
        // Top glow pool: lights the surface around the tile.
        sample("t", col + 0.5, row + 0.5, cell.l + 0.6);
        // Exposed SIDE FACES are area lights of their own: a pool floating
        // in FRONT of the face at mid-face height.
        const lS = this.world.rows[row + 1]?.[col]?.l;
        const lE = this.world.rows[row]?.[col + 1]?.l;
        if (lS !== undefined && cell.l - lS >= 1)
          sample("s", col + 0.5, row + 1.35, (cell.l + lS) / 2 + 0.3);
        if (lE !== undefined && cell.l - lE >= 1)
          sample("e", col + 1.35, row + 0.5, (cell.l + lE) / 2 + 0.3);
      }
    }
    const out: GlowStamp[] = [];
    for (const b of buckets.values()) {
      const col = b.sc / b.n;
      const row = b.sr / b.n;
      const z = b.z / b.n; // mean sample height (tops carry their own +0.6)
      // Pool radius grows gently with cluster size (a lake glows wider than
      // a vein). √2·dx per cell: the widest point of the grid circle's
      // screen ellipse (cells at ±45° to the axes project the farthest).
      const rCells = b.radius * (1 + 0.35 * Math.sqrt(b.n - 1));
      const phase = ((((Math.round(col * 8) * 73856093) ^ (Math.round(row * 8) * 19349663)) >>> 0) % 628) / 100;
      out.push({
        x: this.iso.ox + (col - row) * dx + dx,
        y: this.iso.oy + 8 + (col + row) * dy - z * lh,
        radius: rCells * Math.SQRT2 * dx,
        ry: rCells * Math.SQRT2 * dy,
        color: b.color,
        // Calibrated against the former shader pools by the verify-emission
        // field probes: the old path CULLED to the 8 nearest pools, so in a
        // dense lake only part of the cluster ever lit at once — with every
        // pool present the per-pool weight must sit lower (0.7 washed the
        // crystal lake's field to near-white and broke its hue dominance).
        alpha: Math.min(1, b.strength * 0.42),
        anim: b.anim,
        phase,
      });
    }
    return out;
  }

  /** A burning campfire beside the spawn point — the gathering spot, and the
   * "you are home" landmark (maintainer 2026-07-30). Anchored to the WORLD'S
   * DECLARED SPAWN (world.json `spawn`, the same cell the server places
   * arrivals around in placeAtSpawn) — NOT the world centre, which is where
   * this used to look: every maps2 world declares a spawn far from its middle
   * (the_island2's is 95 cells away, trans_demo's 195), so the fire burned
   * alone in unrelated terrain on every map. findSpawn then snaps to standable
   * ground exactly as the server does, so both sides agree without a round
   * trip. Its fire feeds the night shader. */
  private placeCampfire() {
    if (!this.world || !this.terrain) return;
    if (!this.textures.exists(CAMPFIRE_KEY)) {
      // Never fail silently: a missing strip (e.g. asset domain absent from
      // the deploy image) must be visible in the console, not just "no fire".
      console.warn(`[nangijala] campfire strip missing (${CAMPFIRE_URL}) — fire not placed`);
      return;
    }
    // Same anchor expression as the server's worldSpawn (cell → world units).
    const anchor = this.world.spawn
      ? { x: this.world.spawn[0] * CELL_WU, y: this.world.spawn[1] * CELL_WU }
      : { x: this.worldW / 2, y: this.worldH / 2 };
    const spawn = findSpawn(this.terrain, anchor.x, anchor.y);
    const sc = Math.floor(spawn.x / CELL_WU);
    const sr = Math.floor(spawn.y / CELL_WU);
    const sLvl = levelAtWorld(this.terrain, spawn.x, spawn.y);
    // A couple of cells away from the exact spawn cell so players don't pop
    // into existence standing in the flames. First standable same-level
    // neighbour in a fixed order keeps it deterministic for everyone.
    let cell = { col: sc, row: sr };
    for (const [dc, dr] of [[2, 0], [0, 2], [2, 2], [-2, 0], [0, -2], [-2, -2], [1, 1], [0, 0]]) {
      const cx = (sc + dc + 0.5) * CELL_WU;
      const cy = (sr + dr + 0.5) * CELL_WU;
      if (isStandableAtWorld(this.terrain, cx, cy) && levelAtWorld(this.terrain, cx, cy) === sLvl) {
        cell = { col: sc + dc, row: sr + dr };
        break;
      }
    }
    const fx = (cell.col + 0.5) * CELL_WU;
    const fy = (cell.row + 0.5) * CELL_WU;
    const lvl = levelAtWorld(this.terrain, fx, fy);
    const p = this.project(fx, fy);
    // Same depth formula as players (unlifted ground y), nudged behind a
    // player standing on the very same cell.
    const depth = p.y + lvl * MAP_GEOMETRY.lh + 0.4;
    if (!this.anims.exists(CAMPFIRE_KEY)) {
      this.anims.create({
        key: CAMPFIRE_KEY,
        frames: this.anims.generateFrameNumbers(CAMPFIRE_KEY, { start: 0, end: CAMPFIRE_FRAMES - 1 }),
        frameRate: 12,
        repeat: -1,
      });
    }
    this.campfireSprite = this.add
      .sprite(p.x, p.y, CAMPFIRE_KEY)
      .setOrigin(0.5, CAMPFIRE_BASE)
      .setScale(CAMPFIRE_SCALE)
      .setDepth(depth)
      .play(CAMPFIRE_KEY);
    // Light at flame height: full fire flicker for the shader; a warm glow
    // for the canvas fallback (drawn in update()).
    this.campfire = { col: cell.col + 0.5, row: cell.row + 0.5, z: lvl + 0.5, x: p.x, y: p.y - 4, depth };
  }

  /** ANIMATION_UPDATE handler: if this (state, dir, frame) is a measured
   * foot-plant, stamp a mark at the frame-pixel the foot landed on,
   * converted through the sprite's origin/scale to world coords. */
  private onPlantFrame(uid: string, sprite: Phaser.GameObjects.Sprite, frame: Phaser.Animations.AnimationFrame) {
    if (!this.world) return;
    if (!this.footsteps) this.footsteps = new Footsteps(this);
    // frame texture key: f:<uid>:<state>:<dir>:<n> (see manifest frameKey)
    const parts = String(frame.textureKey).split(":");
    if (parts.length !== 5 || parts[0] !== "f") return;
    const state = parts[2];
    if (state !== "walk" && state !== "run") return;
    const def = this.manifest.characters.find((c) => c.uid === uid);
    const ev = def?.plants?.[state]?.[parts[3]];
    if (!ev || !def) return;
    const n = Number(parts[4]);
    let av: { fx: number; fy: number; swimming?: boolean } | undefined;
    for (const pEv of ev) {
      if (pEv.f !== n) continue;
      if (!av) {
        for (const a of this.avatars.values()) if (a.sprite === sprite) { av = a; break; }
        if (!av || av.swimming) return;
      }
      // frame pixel -> world: through the sprite's origin (the measured foot
      // anchor) and scale, so the mark lands under the DRAWN foot
      const wx = sprite.x + (pEv.x - sprite.originX * def.frameW) * sprite.scaleX;
      const wy = sprite.y + (pEv.y + 1 - sprite.originY * def.frameH) * sprite.scaleY;
      // ground type at the avatar's cell (marks differ per tile type)
      const c = Math.floor(av.fx / CELL_WU);
      const r = Math.floor(av.fy / CELL_WU);
      const cell = this.world.rows[r]?.[c];
      if (!cell) return;
      // Draw AT the lifted foot (wx, wy) but SORT by the avatar's flat-ground
      // depth — on raised terrain the lifted y sorts the mark under its block.
      this.footsteps.spawn(wx, wy, surfaceFor(cell.t).sound, sprite.scaleX, sprite.depth, cell.t);
    }
  }

  /** Project an authoritative world position (flat x,y) onto the iso ground —
   * the point where a character's feet stand, lifted by that cell's elevation. */
  private project(px: number, py: number): { x: number; y: number } {
    const f = this.projectFlat(px, py);
    return { x: f.x, y: f.y - f.lvl * MAP_GEOMETRY.lh };
  }

  /** Iso projection split into the FLAT (unlifted) ground point and the cell's
   * elevation level, so the renderer can animate the lift (fall under gravity)
   * separately from the horizontal walk. Flat x/y are continuous in (px,py);
   * only `lvl` steps at cell boundaries. */
  private projectFlat(px: number, py: number): { x: number; y: number; lvl: number } {
    if (!this.world) return { x: px, y: py, lvl: 0 };
    const { dx, dy, tile } = MAP_GEOMETRY;
    const W = this.world.width;
    const H = this.world.height;
    const col = Math.max(0, Math.min(W - 0.001, px / CELL_WU)); // 1 cell = CELL_WU wu
    const row = Math.max(0, Math.min(H - 0.001, py / CELL_WU));
    const lvl = this.world.rows[Math.floor(row)]?.[Math.floor(col)]?.l ?? 0;
    return {
      x: this.iso.ox + (col - row) * dx + tile / 2,
      y: this.iso.oy + (col + row) * dy + dy,
      lvl,
    };
  }

  /**
   * Advance an avatar's elevation lift one frame toward the target (cell
   * level×lh) via the shared `integrateFall`: up-steps EASE (a 1-level walk-up
   * rises like a stair; a jump's hop arcs on top), gentle down-steps ease, and
   * real cliff down-steps fall under gravity so walking off a ledge drops to the
   * ground below instead of teleporting.
   */
  private stepElevation(av: Avatar, target: number, dt: number): void {
    const s = integrateFall({ elev: av.elev, fallV: av.fallV, falling: av.falling }, target, dt, MAP_GEOMETRY.lh);
    av.elev = s.elev;
    av.fallV = s.fallV;
    av.falling = s.falling;
  }

  /** Soft elliptical drop shadow (Mario 64 style): drawn once, reused by every
   * avatar. Squashed to the iso ground ratio so it reads as lying on the tile. */
  private ensureShadowTexture() {
    if (this.textures.exists(SHADOW_TEX)) return;
    const w = 64;
    const h = 26; // ISO_DY/ISO_DX ground squash
    const tex = this.textures.createCanvas(SHADOW_TEX, w, h);
    const ctx = tex!.getContext();
    ctx.save();
    ctx.scale(1, h / w); // draw a circle in a squashed space → ellipse on canvas
    const grd = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grd.addColorStop(0, "rgba(0,0,0,0.62)");
    grd.addColorStop(0.65, "rgba(0,0,0,0.42)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, w);
    ctx.restore();
    tex!.refresh();
  }

  /** DIFFUSE shadow for MONSTERS (maintainer 2026-07-30: "when you draw a
   * sharp shadow, it must be spot on to look good. A more diffuse shadow is
   * less sensitive"). Same ellipse geometry, different falloff: a much
   * lighter core (0.34 vs 0.62) that decays smoothly to nothing instead of
   * holding ~0.42 out to 65% and then cliffing — so the rim reads as
   * penumbra rather than a hard disc edge, and a few px of anchor error
   * stops being visible. Drawn at 2× the avatar texture's resolution so the
   * gradient stays smooth when a 139px mammoth ellipse scales it up. */
  private ensureMonsterShadowTexture() {
    if (this.textures.exists(MONSTER_SHADOW_TEX)) return;
    const w = 128;
    const h = 52; // same ISO ground squash as the avatar shadow
    const tex = this.textures.createCanvas(MONSTER_SHADOW_TEX, w, h);
    const ctx = tex!.getContext();
    ctx.save();
    ctx.scale(1, h / w);
    const grd = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    // Gaussian-ish falloff: dense middle, long soft tail, zero at the rim.
    grd.addColorStop(0.0, "rgba(0,0,0,0.44)");
    grd.addColorStop(0.3, "rgba(0,0,0,0.39)");
    grd.addColorStop(0.55, "rgba(0,0,0,0.27)");
    grd.addColorStop(0.75, "rgba(0,0,0,0.14)");
    grd.addColorStop(0.9, "rgba(0,0,0,0.05)");
    grd.addColorStop(0.97, "rgba(0,0,0,0.015)");
    grd.addColorStop(1.0, "rgba(0,0,0,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, w);
    ctx.restore();
    tex!.refresh();
  }

  private flipCache = new Set<string>();
  /** A horizontally-mirrored copy of a tile texture, generated + cached on first
   * use — the RenderTexture's batchDraw can't flip, so world@1 `mirror` cells
   * (auto-tiler-flipped transition tiles) draw this instead. Cheap: only the few
   * distinct tiles that appear flipped (~1-4% of cells) ever get a copy. */
  private flippedKey(key: string): string {
    const fk = key + "#flip";
    if (!this.flipCache.has(fk)) {
      const src = this.textures.get(key).getSourceImage() as CanvasImageSource & { width: number; height: number };
      const w = src.width, h = src.height;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(src, 0, 0);
      if (this.textures.exists(fk)) this.textures.remove(fk);
      this.textures.addCanvas(fk, canvas);
      this.flipCache.add(fk);
    }
    return fk;
  }

  /** Draw the art-free "Wanderer" fallback sprite into a texture once. A small
   * hooded figure with feet near the bottom (origin 0.5,0.9 matches real art).
   * White base so per-player tint (setTint) reads cleanly. */
  private ensurePlaceholderTexture() {
    if (this.textures.exists(PLACEHOLDER_TEX)) return;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xf1c9a5, 1).fillRect(11, 6, 10, 9); // head
    g.fillStyle(0x3b3b57, 1).fillRect(10, 4, 12, 4); // hood
    g.fillStyle(0xffffff, 1).fillRect(10, 14, 12, 12); // body (tinted per player)
    g.fillStyle(0xe0e0ea, 1).fillRect(9, 15, 2, 8).fillRect(21, 15, 2, 8); // arms
    g.fillStyle(0x2a2a44, 1).fillRect(11, 26, 4, 6).fillRect(17, 26, 4, 6); // legs
    g.generateTexture(PLACEHOLDER_TEX, 32, 34);
    g.destroy();
  }

  private drawGround() {
    const g = this.add.graphics();
    g.fillStyle(0x213a2c, 1).fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    g.lineStyle(1, 0x2b4a38, 1);
    for (let x = 0; x <= WORLD_WIDTH; x += 64) g.lineBetween(x, 0, x, WORLD_HEIGHT);
    for (let y = 0; y <= WORLD_HEIGHT; y += 64) g.lineBetween(0, y, WORLD_WIDTH, y);
    g.lineStyle(2, 0x86b7cf, 1).strokeRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    g.setDepth(-10000);
  }
}

function down(key?: Phaser.Input.Keyboard.Key): boolean {
  return !!key && key.isDown;
}

function sheetKey(uid: string, anim: string, dir: string): string {
  return `sheet:${uid}:${anim}:${dir}`;
}

function animKey(uid: string, anim: string, dir: string): string {
  return `anim:${uid}:${anim}:${dir}`;
}

// Monster texture/anim keys are namespaced apart from character keys so a
// monster id can never collide with a character uid.
function monsterSheetKey(id: string, anim: string, dir: string): string {
  return `msheet:${id}:${anim}:${dir}`;
}

function monsterAnimKey(id: string, anim: string, dir: string): string {
  return `manim:${id}:${anim}:${dir}`;
}
