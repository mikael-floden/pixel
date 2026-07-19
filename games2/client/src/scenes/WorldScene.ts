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
  makeSideBlocked,
  unstickFromSolids,
  autoJumpWanted,
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
} from "@nangijala/shared";
import { CharacterDef, Manifest, frameUrl, frameKey } from "../manifest";
import { colorForName } from "../placeholder";
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
import { ChatUI } from "../chat";
import { WeatherFX } from "../weatherfx";
import { Footsteps } from "../footsteps";
import { setClockPhase, setClockAngle, clockStar } from "../clock";
import { HudBar, mountPageFrame } from "../hud";
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

// jump/runjump play ONCE, timed to span the ~500ms hop (JUMP_MS): 9 frames→18fps,
// 8 frames→16fps land the character on its feet just as the arc completes.
const ANIM_FPS: Record<string, number> = { idle: 6, walk: 12, run: 14, jump: 18, runjump: 16 };
// Spawn campfire (objects/campfire, burn/south): 96px frames; per its
// placement metadata the fire is 0.6m ≈ 23px tall vs a 64px character, and
// the drawn logs span rows 15..83 of the frame → scale + base anchor below.
const CAMPFIRE_KEY = "campfire-burn";
const CAMPFIRE_URL = "/assets/objects/campfire/animations/burn__south.png";
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
 * face in proportion to their length, the night is the other sweep — with
 * night = the sunlit sum (shared TIME_PHASE_SECONDS) both sweeps run at
 * the same constant speed. Angle: degrees from straight DOWN, + = left. */
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

const TIME_TRANSITION_S = 2.5;
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
// Living camera (maintainer): the camera CHASES the player instead of pinning
// them dead-centre — exponential ease toward the sprite with the trail capped,
// plus a small speed-coupled ZOOM-OUT so the player still sees a bit further
// while moving (the chase alone would show less in the running direction).
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
  wasJumping?: boolean; // last synced jumping flag (hop re-arms on rising edge only)
  swimming: boolean;
  wasSwimming?: boolean; // last frame's swimming — detects the swim→land exit
  exitJumpUntil?: number; // while >now, ease the elevation UP (leap out of water)
  swimT: number; // 0..1 submerge amount (0 = feet on ground, 1 = shoulders at surface)
  bobPhase: number; // per-avatar swim bob phase
  waterMaskG?: Phaser.GameObjects.Graphics; // half-plane-above-shoulders mask shape
  waterMask?: Phaser.Display.Masks.GeometryMask; // the reusable geometry mask
  foam?: Phaser.GameObjects.Image; // waterline foam (per-frame texture, sprite-aligned)
  foamTilt?: number; // current foam crest tilt variant (-1/0/+1), the lapping frame
  foamNextAt?: number; // time.now when the foam rolls to a new tilt
  baseTint: number;
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

export class WorldScene extends Phaser.Scene {
  private manifest!: Manifest;
  private myCharacter!: CharacterDef;
  private myName!: string;
  private room?: Room;
  private avatars = new Map<string, Avatar>();
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
  private pending: { seq: number; ax: number; ay: number; running: boolean; dt: number; jumping: boolean }[] = [];
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
  private holdGround: { x: number; y: number } | null = null;
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
  private collisionOverlay?: Phaser.GameObjects.Graphics;
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
  // --- Occlusion fade: tall geometry ABOVE the local player's level near the
  // player is faded to a faint ghost (moved behind the player) so it stops
  // hiding the character; a REVEAL layer redraws the player-level ground the
  // tower was covering (so you see the grass/level you're walking on, NOT the
  // tower), and drops a BLACK diamond at each faded tower's ROOT (its base
  // footprint — the one spot with nothing behind it, so it must read as void).
  // Masked to a soft bubble around the player (distance falloff).
  private occFadeOn = false; // feature toggle ([7]) — WIP prototype, opt-in for now
  private occFocus: { col: number; row: number } | null = null; // debug focus override
  private occRevealRT?: Phaser.GameObjects.RenderTexture; // player-level ground + black roots
  private lastReveal = { x: NaN, y: NaN, cx: NaN, cy: NaN };
  private emissiveLights: LightSource[] = [];
  // Local jump prediction (client owns its jump timing).
  private jumpUntil = 0;
  private jumpReadyAt = 0;
  private jumpQueued = false;
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
      this.terrain = buildTerrainGrid(this.world.width, this.world.height, this.world.rows, this.world.props);
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
    this.load.on("progress", (f: number) => setLoadingProgress(0.05 + f * 0.85, "Loading art…"));
    // characters2 stores animations as frame FOLDERS (one PNG per frame), not
    // strips — load each frame as its own texture.
    for (const def of this.manifest.characters) {
      for (const [state, dirs] of Object.entries(def.animations)) {
        for (const [dir, count] of Object.entries(dirs)) {
          for (let n = 0; n < count; n++) {
            this.load.image(frameKey(def.uid, state, dir, n), frameUrl(def, state, dir, n));
          }
        }
      }
    }
    // Isometric ground tiles.
    if (this.world) {
      if (this.maps2) {
        // maps2 world bakes an explicit tile PNG per cell + per-material face
        // tiles + placed props — load that unique set.
        for (const path of distinctTilePaths(this.world)) {
          this.load.image(pathTileKey(path), assetUrl(path));
        }
        for (const path of distinctPropPaths(this.world)) {
          this.load.image(pathTileKey(path), assetUrl(path));
        }
      } else {
        for (const { t, v } of distinctTiles(this.world)) {
          this.load.image(tileKey(t, v), tileUrl(t, v));
        }
      }
      // maps2 worlds get their glow from tiles2/emission.json
      // (per-MATERIAL params + per-TILE-PATH sources — see loadTiles2Emission).
      if (this.maps2) this.load.json("tiles2-emission", "/assets/tiles2/emission.json");
      this.load.spritesheet(CAMPFIRE_KEY, CAMPFIRE_URL, {
        frameWidth: CAMPFIRE_FRAME,
        frameHeight: CAMPFIRE_FRAME,
      });
    }
  }

  async create() {
    this.ensurePlaceholderTexture();
    this.ensureShadowTexture();
    this.buildAnimations();
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
      if (this.holdPointerId !== null) return; // first touch keeps the wheel
      this.holdPointerId = p.id;
      this.holdGround = this.pickGround(p.worldX, p.worldY);
      // Fresh gesture = fresh trip (hold=false: reset the sticky slow, build
      // the beacon); subsequent drag replans go through holdRepath's budget.
      if (this.holdGround) this.setMoveTarget(this.holdGround.x, this.holdGround.y, true);
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
        this.tapMarker.setPosition(pr.x, pr.y - pr.lvl * MAP_GEOMETRY.lh);
      }
      this.holdRepath(performance.now());
    });
    const releaseHold = (p: Phaser.Input.Pointer) => {
      if (p.id !== this.holdPointerId) return;
      // Commit the final finger position even if the budget deferred it, then
      // land the beacon on the trip's TRUE end (the finger point clearance-
      // adjusted out of solids — they can differ while dragging).
      this.holdRepathAt = 0;
      this.holdRepath(performance.now());
      if (this.trip && this.tapMarker) {
        const e = this.trip.target;
        const pr = this.projectFlat(e.x, e.y);
        this.tapMarker.setPosition(pr.x, pr.y - pr.lvl * MAP_GEOMETRY.lh);
      }
      this.holdPointerId = null;
      this.holdGround = null;
    };
    this.input.on("pointerup", releaseHold);
    this.input.on("pointerupoutside", releaseHold);

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
    this.input.keyboard!.on("keydown-FOUR", sync(() => this.toggleCollision()));
    this.input.keyboard!.on("keydown-FIVE", sync(() => this.toggleTorch()));
    this.input.keyboard!.on("keydown-SIX", sync(() => this.toggleBonfire()));
    this.input.keyboard!.on("keydown-SEVEN", sync(() => this.toggleWalls()));
    // Bottom HUD (the golden-ratio dock): framed tab row + content page; the
    // game viewport itself gets the matching pixel frame overlay.
    this.hud = new HudBar({
      onLogout: () => this.logout(),
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
        { label: "collision", act: () => this.toggleCollision(), get: () => !!this.collisionOverlay },
        { label: "torch", act: () => this.toggleTorch(), get: () => this.torchOn },
        { label: "bonfire", act: () => this.toggleBonfire(), get: () => this.fireOn },
        { label: "see-through walls", act: () => this.toggleWalls(), get: () => this.occFadeOn },
        {
          label: "overlay",
          act: () => this.setOverlay((this.overlayIdx + 1) % OVERLAYS.length),
          get: () => this.overlayIdx !== 0,
          state: () => OVERLAYS[this.overlayIdx].name,
        },
      ],
    });
    mountPageFrame();

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
      // Debug: occluder build state (maps2 z-order verification).
      occCount: () => ({ maps2: this.maps2, occluders: this.occluders.length, meta: this.occluderMeta.length }),
      bubbles: () => [...this.avatars.values()].filter((a) => a.bubble).map((a) => a.bubble!.text),
      jump: () => this.tryJump(),
      // Tap-to-move probes: set/inspect the autopilot target directly, and
      // run the same screen-point picking a real tap uses.
      tapTo: (x: number, y: number, run = false) => this.setMoveTarget(x, y, !!run),
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
      // Chase-cam probe: eased zoom vs base, and how far the camera trails
      // the avatar (scene px).
      camInfo: () => {
        const id = this.room?.sessionId;
        const av = id ? this.avatars.get(id) : undefined;
        const cam = this.cameras.main;
        const cx = cam.scrollX + cam.width / 2;
        const cy = cam.scrollY + cam.height / 2;
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
      // Current animation key of the local avatar's sprite — headless probe for
      // verifying jump/runjump selection.
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
      levelAt: (x: number, y: number) => (this.terrain ? levelAtWorld(this.terrain, x, y) : 0),
      nightShader: () => !!this.night && this.night.active,
      // Get/set the time-of-day phase (by index or name); instant when set —
      // headless probes sample grades without waiting out the transition.
      timeOfDay: (which?: number | string, instant = true) => {
        if (which !== undefined) {
          const idx =
            typeof which === "number"
              ? which % TIME_PHASES.length
              : TIME_PHASES.findIndex((p) => p.name.toLowerCase() === String(which).toLowerCase());
          if (idx >= 0) this.setTimeOfDay(idx, instant, 0.5); // probes pin the exact keyframe
        }
        return { name: TIME_PHASES[this.timeIdx].name, t: this.timeT, ambient: [...this.curAmbient] };
      },
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
    };
  }

  /** Wire a (re)joined room into the scene: state callbacks, messages, and
   * the dead-connection recovery. Called for the initial join and for every
   * in-place rejoin. */
  private bindRoom(room: Room) {
    this.room = room;
    this.connected = true;
    this.reconnectRetries = 0;
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
      }
      this.refreshRoster();
    });
    $(room.state).players.onRemove((_player: any, id: string) => {
      this.removeAvatar(id);
      this.refreshRoster();
    });
    room.onMessage("chat", (msg: ChatBroadcast) => {
      this.chat.addLog(msg.name, msg.text);
      this.showBubble(msg.id, msg.text);
      if (msg.id !== room.sessionId) gameAudio.event("ui.notify", { gainDb: -9 });
    });
    // Every arrival in Nangijala is a shooting star everyone sees at the
    // same moment; the night sky also throws wild ones (no name).
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

  /** Stereo position of an avatar relative to the camera view — pan (-1..1)
   * and distance (0 at centre, 1 at the edge of earshot) for the composer's
   * spatialized one-shots. The local player is always centred. */
  private avatarSpatial(id: string | undefined): { pan: number; dist: number } {
    if (!id || id === this.room?.sessionId) return { pan: 0, dist: 0 };
    const av = id ? this.avatars.get(id) : undefined;
    if (!av) return { pan: 0, dist: 0.5 };
    const view = this.cameras.main.worldView;
    const nx = (av.sprite.x - view.centerX) / Math.max(1, view.width * 0.55);
    const ny = (av.sprite.y - view.centerY) / Math.max(1, view.height * 0.55);
    return {
      pan: Math.max(-1, Math.min(1, nx)),
      dist: Math.min(1, Math.hypot(nx, ny) * 0.75),
    };
  }

  /** Terrain mood around the player for the composer's ambience beds:
   * fractions (0..1) of forest / water / town cells in earshot, plus
   * campfire proximity. Sampled by the composer at ~4 Hz — keep it cheap
   * (a 15×15 cell window ≈ 225 string checks). */
  private sampleAudioField(): { forest: number; water: number; town: number; fire: number } {
    const none = { forest: 0, water: 0, town: 0, fire: 0 };
    const g = this.terrain;
    const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
    if (!g || !me) return none;
    const cc = Math.floor(me.fx / CELL_WU);
    const cr = Math.floor(me.fy / CELL_WU);
    const R = 7;
    let forest = 0;
    let water = 0;
    let town = 0;
    let n = 0;
    for (let r = cr - R; r <= cr + R; r++) {
      if (r < 0 || r >= g.height) continue;
      for (let c = cc - R; c <= cc + R; c++) {
        if (c < 0 || c >= g.width) continue;
        n++;
        const t = g.type[r * g.width + c];
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
    return { forest: frac(forest), water: frac(water), town: frac(town), fire };
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
    // FRAME layout-px: with UI_ZOOM_X1 (uiscale.ts) the overlay is NOT zoom'd,
    // so 340px shares the frame's coordinate space and lands below the clock
    // disc (a plain top:150px sat on the disc on the real phone).
    el.style.cssText =
      "position:fixed;top:calc(340px / var(--ml-uizoom, 1));left:50%;transform:translateX(-50%);z-index:100;" +
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
    const panel = this.add.rectangle(cx, cy, Math.min(560, this.scale.width - 40), 150, 0x12121c, 0.92)
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
        const jumpingNow = this.time.now < this.jumpUntil;
        // Each input replays with the jump state it was ORIGINALLY integrated
        // under (see the `pending` field note) — using "jumping right now" for
        // historical inputs rolled the anchor back below ledges after landing.
        const stepLocal = (ax: number, ay: number, running: boolean, sdt: number, jumping: boolean) => {
          let blocked;
          let sideBlocked;
          let speed = 1;
          if (this.terrain) {
            // Mirror the server exactly: unstick before integrating.
            const u = unstickFromSolids(this.terrain, rx, ry, 80 * sdt);
            rx = u.x;
            ry = u.y;
            const ctx = { maxClimb: jumping ? JUMP_CLIMB : WALK_CLIMB, canSwim: true };
            blocked = makeBlocked(this.terrain, ctx);
            sideBlocked = makeSideBlocked(this.terrain, ctx); // corner probes: solids only
            speed = surfaceAtWorld(this.terrain, rx, ry).speed * (jumping ? JUMP_SPEED_FACTOR : 1);
          }
          // screenInput matches the server: on the iso world, input is screen-relative.
          const r = stepMovement(rx, ry, ax, ay, running, sdt, blocked, speed, !!this.terrain, this.worldW, this.worldH, sideBlocked);
          rx = r.x;
          ry = r.y;
        };
        for (const p of this.pending) stepLocal(p.ax, p.ay, p.running, p.dt, p.jumping);
        // Integrate the not-yet-sent input tail too, so the local player moves
        // every FRAME (60fps-smooth) instead of only at the 20Hz send tick.
        if (this.sendAccum > 0)
          stepLocal(this.lastInput.ax, this.lastInput.ay, this.lastInput.running, this.sendAccum, jumpingNow);
        tx = rx;
        ty = ry;
        // Animate from live input for instant turn/walk feedback.
        const li = this.lastInput;
        moving = li.ax !== 0 || li.ay !== 0;
        running = li.running && moving;
        dir = (moving ? vectorToDirection(li.ax, li.ay) : null) ?? player.dir;
      } else {
        tx = player.x;
        ty = player.y;
        moving = player.moving;
        running = player.running;
        dir = player.dir;
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
      // level — the feet sink `swimDrop` px under. Falling in from a ledge
      // then submerges progressively (gravity carries the body through the
      // surface) and STOPS (buoyancy) at the shoulder line. swimDir = the
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
      const targetElev = swimming ? -swimDrop : g.lvl * MAP_GEOMETRY.lh;
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
      if (Math.abs(g.x - av.lx) > CELL_WU * 2 || Math.abs(g.y - av.lyFlat) > CELL_WU * 2) {
        av.lx = g.x;
        av.lyFlat = g.y;
        av.elev = targetElev;
        av.fallV = 0;
        av.falling = false;
        av.wasFalling = false; // a teleport landing must not swallow the next fall grunt
        av.exitJumpUntil = 0; // a teleport cancels any in-progress leap-out
        av.spdWu = undefined; // a teleport is not a speed sample
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

      // Submerge amount: 0 = feet at the surface, 1 = shoulders at the surface
      // (fully floating). Tied to how far the fall has sunk the feet below the
      // surface, so a ledge drop submerges progressively then floats.
      av.swimT = swimDrop > 0 ? Math.max(0, Math.min(1, -av.elev / swimDrop)) : swimming ? 1 : 0;

      // Jump hop: a short parabola driven by the synced `jumping` flag —
      // RISING-EDGE triggered. Re-arming whenever the flag was still true
      // after the hop expired replayed a whole second hop when a state patch
      // arrived late (the flag outlives the local 500ms window by a frame on
      // jittery links): the "jumps again after landing on the hill" bug.
      if (player.jumping && !av.wasJumping && av.hopUntil <= this.time.now) {
        av.hopUntil = this.time.now + JUMP_MS;
        // Sound exactly when the visual hop starts (synced flag = same
        // trigger for every client), spatialized for other players.
        const sp = this.avatarSpatial(id);
        gameAudio.event("player.jump", { pan: sp.pan, dist: sp.dist, voice: av.character });
      }
      av.wasJumping = !!player.jumping;
      const hopLeft = av.hopUntil - this.time.now;
      const hop = hopLeft > 0 ? Math.sin((1 - hopLeft / JUMP_MS) * Math.PI) * JUMP_HEIGHT : 0;

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
      // Depth vs occluding columns: a single painter scalar can't resolve
      // every sprite-vs-column case (diagonals, same-level, lower columns),
      // so refine per frame with the EXACT test — a column truly hides the
      // sprite only if its top is strictly higher than the sprite's ground
      // AND it lies on the camera ray (grid interval test). Place the sprite
      // above every falsely-deeper column and below every true occluder.
      const lvl = this.terrain ? levelAtWorld(this.terrain, tx, ty) : 0;
      let depth = av.lyFlat + 0.5; // painter y at the flat (unlifted) ground
      if (this.world) {
        const colf = tx / CELL_WU; // 1 cell = CELL_WU world units (any world size)
        const rowf = ty / CELL_WU;
        // Sprite bounds = the MEASURED opaque art box (+4px margin for walk
        // frames dipping past the idle anchor). The drawn figure is ~30x68px
        // inside a 128px frame — testing the whole frame let raised cells 2-3
        // tiles away "cover" the sprite via its transparent padding.
        const ab = this.artBounds(av.sprite);
        const aLeft = av.sprite.x - av.sprite.displayWidth * av.sprite.originX;
        const aTop = av.sprite.y - av.sprite.displayHeight * av.sprite.originY;
        const sx0 = aLeft + ab.x0 * av.sprite.scaleX - 4;
        const sx1 = aLeft + ab.x1 * av.sprite.scaleX + 4;
        const sy0 = aTop + ab.y0 * av.sprite.scaleY - 4;
        const sy1 = aTop + ab.y1 * av.sprite.scaleY + 4;
        let above = -Infinity;
        let below = Infinity;
        let coverY = Infinity;
        const feetY = av.ly;
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
            av.lx >= o.x0 - 6 &&
            av.lx <= o.x1 + 6;
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
        av.coverY = below < Infinity ? coverY : undefined;
      } else {
        av.coverY = undefined;
      }
      av.sprite.setDepth(depth);
      // Shadow: cast on the LANDING ground (flat − target elevation), not the
      // sprite's current lifted feet. It stays put on the lower ground while the
      // character hops OR falls toward it, shrinking with total air height so a
      // cliff fall reads as "dropping toward the shadow below".
      const landY = av.lyFlat - targetElev;
      const airFrac = Math.min(1, (hop + Math.max(0, landY - av.ly)) / JUMP_HEIGHT);
      av.shadow
        .setPosition(av.lx, landY)
        .setVisible(!av.swimming)
        .setAlpha(1 - airFrac * 0.35)
        .setDisplaySize(34 - airFrac * 9, 14 - airFrac * 4)
        .setDepth(av.sprite.depth - 0.1);
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
          .setText(`${(av.fx / CELL_WU).toFixed(1)}, ${(av.fy / CELL_WU).toFixed(1)}`);
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
          // lights ground far below cliffs, which reads as leakage.
          z: (this.terrain ? levelAtWorld(this.terrain, a.fx, a.fy) : 0) + 0.55,
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
      setClockAngle(ha.deg);
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
      this.night!.update(
        this.cameras.main,
        sl,
        ambEff,
        this.glowStamps,
        this.curSun,
        this.curCloud,
        this.curAurora,
        this.curMist,
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
    } catch {}
    try {
      this.room?.leave();
    } catch {}
    // fade the whole page to black before the reload; the select screen
    // fades back in from black on the other side (fade.ts)
    fadeToBlack(() => location.reload());
  }

  private toggleCollision() {
    this.toggleCollisionOverlay();
    this.chat.addLog("—", `[4] Collision overlay: ${this.collisionOverlay ? "on" : "off"}`);
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
    setClockPhase(idx, instant); // celestial dial top-centre follows the phase
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
      setClockAngle(ha.deg, true);
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
      if (!a.lit) {
        a.lit = this.add.sprite(a.sprite.x, a.sprite.y, a.sprite.texture.key).setDepth(900_001);
      }
      if (!on || !a.sprite.visible) {
        a.lit.setVisible(false);
        if (!on) a.foam?.clearTint(); // day: foam at full brightness
        continue;
      }
      const lvl = this.terrain ? levelAtWorld(this.terrain, a.fx, a.fy) : 0;
      const l = night!.lightAt(a.fx / CELL_WU, a.fy / CELL_WU, lvl, false);
      const base = a.baseTint;
      const r = Math.min(255, Math.round(((base >> 16) & 0xff) * Math.min(1, l[0])));
      const g = Math.min(255, Math.round(((base >> 8) & 0xff) * Math.min(1, l[1])));
      const bl = Math.min(255, Math.round((base & 0xff) * Math.min(1, l[2])));
      a.lit
        .setVisible(true)
        .setTexture(a.sprite.texture.key, a.sprite.frame.name)
        .setPosition(a.sprite.x, a.sprite.y)
        .setOrigin(a.sprite.originX, a.sprite.originY)
        .setScale(a.sprite.scaleX, a.sprite.scaleY)
        .setDepth(litDepth(a.sprite.depth))
        .setTint((r << 16) | (g << 8) | bl);
      if (a.coverY !== undefined) {
        // Frame-space y of the occluding wall's top line.
        const frameTop = a.sprite.y - a.sprite.displayHeight * a.sprite.originY;
        const cropH = (a.coverY - frameTop) / a.sprite.scaleY;
        const ab = this.artBounds(a.sprite);
        if (cropH <= ab.y0 + 2) a.lit.setVisible(false); // wall covers the whole figure
        else a.lit.setCrop(0, 0, a.sprite.frame.cutWidth, cropH);
      } else if (a.lit.isCropped) a.lit.setCrop();
      // Underwater clip: the lit copy follows the same shoulder-waterline mask
      // as the base sprite so the submerged body doesn't show above the night
      // overlay (composes with the wall crop above).
      if (a.swimming && a.swimT > 0.001 && a.waterMask) a.lit.setMask(a.waterMask);
      else if (a.lit.mask) a.lit.clearMask();
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
    } else {
      // Held finger at rest: pointermove stops firing, so commit any
      // budget-deferred drag retarget from the frame loop instead.
      this.holdRepath(performance.now());
      if (this.trip) {
        const drive = this.driveAutopilot();
        ax = drive.ax;
        ay = drive.ay;
        running = drive.running;
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
   * inverse-projection as pickGround, but reports the topmost hit cell's
   * swimmable-ness — used by the snow FX so flakes melt on lakes, not rest. */
  private isWaterAtScreen(wx: number, wy: number): boolean {
    if (!this.world) return false;
    const { dx, dy, lh, tile } = MAP_GEOMETRY;
    const u = (wx - this.iso.ox - tile / 2) / dx;
    for (let l = this.maxLevel; l >= 0; l--) {
      const v = (wy - this.iso.oy - dy + l * lh) / dy;
      const col = (u + v) / 2;
      const row = (v - u) / 2;
      const cell = this.world.rows[Math.floor(row)]?.[Math.floor(col)];
      if (!cell || cell.l !== l) continue;
      const s = surfaceFor(cell.t);
      return !s.standable && s.swimmable; // a lake surface (not a walkable bank)
    }
    return false;
  }

  private pickGround(wx: number, wy: number): { x: number; y: number } | null {
    const clampW = (x: number, y: number) => ({
      x: Math.max(1, Math.min(this.worldW - 1, x)),
      y: Math.max(1, Math.min(this.worldH - 1, y)),
    });
    if (!this.world) return clampW(wx, wy); // plain-ground fallback: screen == flat world
    const { dx, dy, lh, tile } = MAP_GEOMETRY;
    const u = (wx - this.iso.ox - tile / 2) / dx;
    for (let l = this.maxLevel; l >= 0; l--) {
      const v = (wy - this.iso.oy - dy + l * lh) / dy;
      const col = (u + v) / 2;
      const row = (v - u) / 2;
      const cell = this.world.rows[Math.floor(row)]?.[Math.floor(col)];
      if (!cell || cell.l !== l) continue;
      const s = surfaceFor(cell.t);
      if (!s.standable && !s.swimmable) return null; // tapped a solid prop/structure
      return clampW(col * CELL_WU, row * CELL_WU);
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
    this.setMoveTarget(g.x, g.y, true, true);
    const cost = performance.now() - t0;
    this.holdRepathAt = nowMs + Math.min(400, Math.max(50, cost * 8));
  }

  private setMoveTarget(x: number, y: number, run: boolean, hold = false) {
    const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
    if (!me) return;
    // startTrip routes with the shared findPath; the trip's destination is
    // the route's END — the tapped point pushed out of any solid's collision
    // margin, or the reachable rim when the goal is walled off. Null →
    // nowhere to go (tap into a sealed area) — ignore (a hold-drag passing
    // over a sealed spot keeps the current trip alive).
    const trip = startTrip(this.terrain, me.fx, me.fy, x, y, run, this.time.now);
    if (!trip) return;
    // A hold-drag retarget carries the sticky run→walk demotion: fresh trips
    // reset it, and at ~7 retargets/s a throttled tab would re-arm the run
    // every retarget and oscillate run/walk forever.
    if (hold && this.trip) trip.slow = this.trip.slow;
    this.trip = trip;
    const end = trip.target;
    this.ensureTapAssets();
    const p = this.projectFlat(end.x, end.y);
    const my = p.y - p.lvl * MAP_GEOMETRY.lh;
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
    const d = stepAutopilot(this.terrain, this.trip, me.fx, me.fy, this.time.now, this.worldW, this.worldH);
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
   * can't — i.e. exactly a 1-level wall (`WALK_CLIMB < step ≤ JUMP_CLIMB`) —
   * fire the jump automatically. A 2-level+ wall fails the jump check too, so
   * it's left alone; solid props (trees/boulders) are impassable at any climb,
   * so they never auto-jump either. `tryJump` still gates on grounded+cooldown.
   */
  private maybeAutoJump(ax: number, ay: number) {
    if (ax === 0 && ay === 0) return;
    const now = this.time.now;
    if (now < this.jumpUntil || now < this.jumpReadyAt) return; // already airborne / cooling down
    const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
    if (me && this.wouldAutoJump(me.fx, me.fy, ax, ay)) this.tryJump();
  }

  /** The terrain predicate behind auto-jump: from world (fromX,fromY), moving
   * in screen direction (ax,ay), is the terrain just past the feet a 1-level
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
      // The jump state this window was integrated under — replays must match
      // (jump flushes immediately in predictAndSend, so windows never straddle
      // a jump onset).
      jumping: this.time.now < this.jumpUntil,
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
    // Airborne overrides ground gait: a moving-fast leap uses running-jump, any
    // other hop (standing or walking) uses the plain jump. Timed to the hop so
    // the leap/land poses line up with the visual arc.
    const state = jumping
      ? running && moving
        ? "runjump"
        : "jump"
      : moving
        ? running
          ? "run"
          : "walk"
        : "idle";
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
  private stableDir(av: Avatar, want: string): string {
    const cur = (av.dispDir ??= want);
    if (want === cur) {
      av.pendDir = undefined;
      return cur;
    }
    const i = DIRECTIONS.indexOf(cur as (typeof DIRECTIONS)[number]);
    const j = DIRECTIONS.indexOf(want as (typeof DIRECTIONS)[number]);
    const ring = Math.abs(i - j);
    if (Math.min(ring, DIRECTIONS.length - ring) >= 2) {
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
      state === "runjump"
        ? ["runjump", "jump", "run", "walk", "idle"]
        : state === "jump"
          ? ["jump", "walk", "idle"]
          : state === "run"
            ? ["run", "walk", "idle"]
            : state === "walk"
              ? ["walk", "idle"]
              : ["idle"];
    for (const s of order) {
      for (const d of [dir, DEFAULT_DIRECTION]) {
        const key = animKey(uid, s, d);
        if (this.anims.exists(key)) return key;
      }
    }
    return null;
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
          // idle/walk/run loop; jump/runjump/kick play once.
          const once = state === "jump" || state === "runjump" || state === "kick";
          this.anims.create({
            key,
            frames,
            frameRate: def.gaitFps?.[state] ?? ANIM_FPS[state] ?? 10,
            repeat: once ? 0 : -1,
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
  }

  /** Face tile key for a deck's underside/sides (the material's plain face, like
   * a raised ground cell), falling back to the slab's own top art. */
  private deckFaceKey(deck: Deck, topKey: string): string {
    const fp = this.world?.faceTiles?.[deck.mat];
    return fp && this.textures.exists(pathTileKey(fp)) ? pathTileKey(fp) : topKey;
  }

  private makeGroundRT() {
    this.groundRT?.destroy();
    this.groundRT = this.add
      .renderTexture(0, 0, this.scale.width + GROUND_MARGIN * 2, this.scale.height + GROUND_MARGIN * 2)
      .setOrigin(0, 0)
      .setDepth(-1_000_000);
    this.lastGround = { x: NaN, y: NaN };
  }

  private redrawGround() {
    if (!this.world || !this.groundRT) return;
    const cam = this.cameras.main;
    const ccx = cam.scrollX + cam.width / 2;
    const ccy = cam.scrollY + cam.height / 2;
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

  private zoomFor(): number {
    return Math.max(1, Math.round(this.scale.width / 520));
  }

  private tryJump() {
    const now = this.time.now;
    if (now < this.jumpUntil || now < this.jumpReadyAt) return;
    this.jumpUntil = now + JUMP_MS;
    this.jumpReadyAt = now + JUMP_MS + JUMP_COOLDOWN_MS;
    this.jumpQueued = true;
  }

  /** Toggle a debug overlay marking non-standable cells around the camera
   * (blue = swimmable water, red = solid). Redrawn for the CURRENT view each
   * time it's toggled on — the world is far too large to mark everywhere. */
  private toggleCollisionOverlay() {
    if (this.collisionOverlay) {
      this.collisionOverlay.destroy();
      this.collisionOverlay = undefined;
      return;
    }
    if (!this.world) return;
    const { dx, dy, lh } = MAP_GEOMETRY;
    const cam = this.cameras.main;
    const g = this.add.graphics().setDepth(1_000_000);
    const u0 = Math.floor((cam.worldView.x - this.iso.ox) / dx) - 2;
    const u1 = Math.ceil((cam.worldView.right - this.iso.ox) / dx) + 2;
    const v0 = Math.max(0, Math.floor((cam.worldView.y - this.iso.oy) / dy) - 2);
    const v1 = Math.ceil((cam.worldView.bottom - this.iso.oy + this.maxLevel * lh) / dy) + 2;
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        if ((u + v) & 1) continue;
        const col = (u + v) / 2;
        const row = (v - u) / 2;
        const cell = this.world.rows[row]?.[col];
        if (!cell) continue;
        const s = surfaceFor(cell.t);
        if (s.standable) continue;
        // Water reads soft blue; solid blockers pop in strong red.
        if (s.swimmable) g.fillStyle(0x3bb0ff, 0.3);
        else g.fillStyle(0xff0000, 0.55);
        const bx = this.iso.ox + u * dx;
        // A solid blocker stops the player on the surrounding WALKABLE
        // ground — draw its footprint there (the base of the obstacle),
        // not on the obstacle's own raised surface: on the demo's l:1
        // lava blocks the diamond floated on the top face. Water keeps
        // its own level (you collide/swim AT the water surface), and so
        // do fully enclosed solids (forest interiors, no ground nearby).
        let lvl = cell.l;
        if (!s.swimmable) {
          let ground = Infinity;
          for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const n = this.world.rows[row + dr]?.[col + dc];
            if (!n) continue;
            const ns = surfaceFor(n.t);
            if (ns.standable || ns.swimmable) ground = Math.min(ground, n.l);
          }
          if (ground !== Infinity) lvl = Math.min(lvl, ground);
        }
        // The tile ART paints its surface diamond groundTop px below its
        // canvas top — without the shift the overlay hovered 8px above the
        // drawn ground (playtester: "why is the collision box not at ground
        // level where the wall begins?"). Pure visualization; the collision
        // math itself is grid-space and has no such offset.
        const by =
          this.iso.oy + v * dy - lvl * lh + (this.tileBases?.groundTop ?? 8);
        g.fillPoints(
          [
            new Phaser.Geom.Point(bx + dx, by),
            new Phaser.Geom.Point(bx + dx * 2, by + dy),
            new Phaser.Geom.Point(bx + dx, by + dy * 2),
            new Phaser.Geom.Point(bx, by + dy),
          ],
          true,
        );
      }
    }
    this.collisionOverlay = g;
  }

  /** Draw the local player's swim-stamina bar (bottom-centre HUD), shown only
   * while swimming or recovering. */
  /** First stack level to DRAW for a DEMO station column: the lvl-0 copy is
   * underground — drawing it pushed the column's base one full block below
   * its grid diamond (and past its hitbox; playtester overlay check).
   * MAIN-WORLD terraces keep their full stacks: a global cut left floating
   * wall fragments at partially-exposed cells (measured). */
  private stackFrom(col: number, row: number, l: number, solid: boolean): number {
    if (solid) return l;
    const lE = this.world?.rows[row]?.[col + 1]?.l ?? -1;
    const lS = this.world?.rows[row + 1]?.[col]?.l ?? -1;
    return Math.max(0, Math.min(l, Math.min(lE, lS) + 1));
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
    } else {
      for (const o of this.occluders) {
        const od = o.getData("od") as number | undefined;
        if (od !== undefined) o.setDepth(od).setAlpha(1);
      }
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
      this.occRevealRT = this.add
        .renderTexture(0, 0, this.scale.width + GROUND_MARGIN * 2, this.scale.height + GROUND_MARGIN * 2)
        .setOrigin(0, 0)
        .setDepth(-900_000);
    }
    const rt = this.occRevealRT;
    rt.setVisible(true);
    const cam = this.cameras.main;
    const ccx = cam.scrollX + cam.width / 2;
    const ccy = cam.scrollY + cam.height / 2;
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
              for (let lvl = lvl0; lvl < dk.deck.level; lvl++)
                this.occluders.push(
                  this.tagOccluder(this.add.image(bx0, by0 - lvl * lh, dFace).setOrigin(0, 0).setDepth(dDepth), col, row, dk.deck.level, dDepth),
                );
              this.occluders.push(
                this.tagOccluder(
                  this.add.image(bx0, by0 - dk.deck.level * lh, dTop0).setOrigin(0, 0).setFlipX(!!dk.cell.flip).setDepth(dDepth),
                  col, row, dk.deck.level, dDepth,
                ),
              );
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
          for (let lvl = this.stackFrom(col, row, cell.l, false); lvl < cell.l; lvl++)
            this.occluders.push(
              this.tagOccluder(this.add.image(bx, by - lvl * lh, fk).setOrigin(0, 0).setDepth(oDepth), col, row, cell.l, oDepth),
            );
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

  /** A burning campfire beside the spawn point — the gathering spot. The
   * server spawns newcomers around findSpawn(world centre), which is a pure
   * function of the terrain, so the client can find the same cell and dress
   * it without any server round-trip. Its fire feeds the night shader. */
  private placeCampfire() {
    if (!this.world || !this.terrain) return;
    if (!this.textures.exists(CAMPFIRE_KEY)) {
      // Never fail silently: a missing strip (e.g. asset domain absent from
      // the deploy image) must be visible in the console, not just "no fire".
      console.warn(`[nangijala] campfire strip missing (${CAMPFIRE_URL}) — fire not placed`);
      return;
    }
    const spawn = findSpawn(this.terrain, this.worldW / 2, this.worldH / 2);
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
   * level×lh) via the shared `integrateFall`: up-steps snap (the hop sells the
   * arc), gentle down-steps ease, and real cliff down-steps fall under gravity
   * so walking off a ledge drops to the ground below instead of teleporting.
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
