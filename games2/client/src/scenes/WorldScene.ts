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
  deepCurrentAt,
  vectorToDirection,
  TerrainGrid,
  buildTerrainGrid,
  stampSceneryCollision,
  sceneryDrawnPx,
  footprintsInCells,
  MIN_FOOTPRINT_SEMI,
  ISO_GEOMETRY_MAPS3,
  type SceneryBboxDoc,
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
  MonsterShadow,
  shadowScreenEllipse,
  shadowBodyRadius,
  shadowAnchorOf,
  startTrip,
  walkHeading,
  bodyStalled,
  slideAlong,
  type SlideMemo,
  stepAutopilot,
  bodyStandoff,
  startBestTrip,
  AutopilotTrip,
  findIndoorSpace,
  roofAbove,
  type IndoorSpace,
  INDOOR_DEPTH,
  INDOOR_WALL_RATIO,
  MIN_ROOM_CELLS,
  surfaceAtWorld,
  surfaceAtWorldElev,
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
  canEnter,
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
  MONSTER_DODGE_MARGIN,
  PROVOKE_RADIUS_WU,
  DROP_TTL_MS,
  DROP_FLASH_MS,
} from "@nangijala/shared";
import { CharacterDef, Manifest, frameUrl, frameKey, BOOT_ANIM_STATES } from "../manifest";
import { indoorAmbient, indoorLight, setIndoorLight } from "../indoorlight";
import { indoorWall, setIndoorWall, INDOOR_WALL_MIN, INDOOR_WALL_MAX } from "../indoorwall";
import { withV, assetIndexInfo } from "../assetver";
import { queueTileLoads, TileAtlasLoad } from "../tileatlas";
import { ChessDialog, ChessMatchView } from "../chessui";
import { gameUrl } from "../staging";
import { MonsterManifest, MonsterDef, monsterWalkKey, resolveMonsterAnim } from "../monsterManifest";
import { writeLastPos } from "../monsterBoot";
import { NpcManifest, NpcDef, NpcPlacement, loadNpcPlacement } from "../npcManifest";
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
import { reservedLights, WORLD_LIGHT_SLOTS, RESERVED_LIGHT_SLOTS } from "../lightslots";
import { joinWorld } from "../net";
import { bindLiveTuning, liveTuningSnapshot, monsterShadow, onLiveTuning } from "../live";
import { ChatUI } from "../chat";
import { WeatherFX } from "../weatherfx";
import { Footsteps } from "../footsteps";
import { setClockTime, clockStar } from "../clock";
import { HudBar, mountPageFrame } from "../hud";
import { getHand, setHand } from "../controls";
import { setLoadingProgress, hideLoading } from "../loading";
import { cameraZoom } from "../camzoom";
import { fadeToBlack } from "../fade";
import { applyUiZoom } from "../uiscale";
import {
  World,
  MAP_GEOMETRY,
  geometryFor,
  isMaps3World,
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
  loadPlaces,
  worldFileUrl,
} from "../maps";
import type { MapGeometry, PlaceLookup } from "../maps";
// ---- TILES 3.0 (maps3 worlds) -------------------------------------------
// The resolver (what draws on this cell), the draw layer (the two pixel ops +
// the texture factory), the streaming per-cell runtime, and scenery. All four
// are pure and Phaser-free; this scene is the only thing that knows about both
// them and Phaser.
import {
  Tiles3,
  DX as T3_DX,
  TOP_Y as T3_TOP_Y,
  TILE as T3_TILE,
  PLATE_H as T3_PLATE_H,
  columnX as t3columnX,
  columnY as t3columnY,
  measureStoreyPitch,
  type Frame as T3Frame,
  type PatternsDoc,
  type Tiles3Boundary,
  type Tiles3Cell,
  type Tiles3DeckCell,
} from "../tiles3";
import {
  Tiles3Textures,
  patternSheets,
  patternSheetPaths,
  artKey as t3ArtKey,
  type PatternSheets,
  type Pixels as T3Pixels,
  type TextureManagerLike,
  type UrlRoute,
  assetPath,
} from "../tiles3draw";
import {
  Tiles3Loader,
  Tiles3World,
  TILES3_DOCS,
  cellArtPaths,
  cellBlits,
  boundaryArtPaths,
  deckArtPaths,
  docUrl,
  faceKey as t3FaceKey,
  sheetPaths,
  surfaceKey as t3SurfaceKey,
  tiles3DataFrom,
  viewFromParsed,
  type Tiles3DocKey,
} from "../tiles3runtime";
import {
  SceneryIndex,
  type SceneryPlacement,
  SceneryPieces,
  buildPlacements,
  fitSprite,
  alphaBBox,
  artKey as sceneryArtKey,
  artUrl as sceneryArtUrl,
  roofedCells,
  facedSprite,
  stateFor,
  sceneryHitboxFor,
  type SceneryHitboxRec,
  type SceneryFit,
  anchorX,
  anchorY,
} from "../scenery3";

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
// The blood spatter's 8 direction variants (scenery/blood_spatter, trimmed to
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
/** THE OCCLUSION OUTLINE (maintainer 2026-08-07: "my solution was to go with a
 * white pixel outline on parts being behind something"). The other half of the
 * indoor cut-away: the cut shortens a wall so you can see over it, and this
 * keeps whoever is behind what remains readable — without making anything
 * transparent, which is the feature he rejected. Not indoor-only: a body behind
 * any terrain gets it, which is what the deleted see-through-walls sweep was
 * for and this replaces at a fraction of the cost (one image per COVERED body,
 * not an alpha pass over thousands of occluders).
 *
 * These two must differ from every other ring's INNER colour: ringTextureFor's
 * cache key hashes the inner one alone, so two palettes sharing it would
 * silently share the first-baked outer line too. */
const HIDDEN_RING_COLOR = 0xf0f0f0; // inner, a hair off white
const HIDDEN_RING_BRIGHT = 0xffffff; // outer — the white the maintainer asked for
// How much of the border's brightness survives total darkness (see
// syncCoverOutline). The rest tracks the local light, so the line dims at
// night, darkens in shadow and warms in a torch pool. 1.0 = the old flat white.
// 0.42 was still too loud after dark (maintainer 2026-08-09); at 0.30 a body
// out of every light sits near a third of white instead of half.
const RING_LIGHT_FLOOR = 0.30;
const RING_PAD = 2; // outline canvas pad = border width in art pixels
// THE COVER SURFACES (see registerCoverSlot / flushCoverSurfaces). Three
// atlases sharing ONE slot layout, so a body's visible part, its covered part
// and its outline are the same rectangle in all three and can never drift.
// 1024x512 RGBA = 2 MB each. A slot is the body's frame padded by RING_PAD and
// rounded up to a 32px class so freed slots are reusable; anything that does
// not fit falls back to the flat coverY crop, together with its lit copy.
const COVER_ATLAS_W = 1024;
const COVER_ATLAS_H = 512;
const COVER_GUTTER = 4; // > the 2px the ring dilation bleeds past a slot
const COVER_BUCKET = 128; // occluder broad-phase bucket, world px
// Ticks a body keeps its cover slot after it stops being covered (see
// sweepCoverSlots). Generous: re-acquiring costs nothing while the atlas has
// room, and a body stepping in and out of cover at a wall edge must not thrash.
const COVER_SLOT_GRACE = 240;
// The two dilation passes that build the outline out of the COVERED part —
// exactly ringTextureFor's structuring element (two successive 4-neighbour
// dilations = the L1 ball of radius 2), applied to the covered sub-silhouette
// instead of the whole one. Distance 2 gets the outer colour, then distance 1
// overpaints with the inner, then the body itself is erased: a ring texel
// draws iff ANY silhouette texel within L1 2 of it is covered.
/** Bucket key for the occluder broad phase. Offset so the negative screen y a
 * tall column reaches still packs into one non-negative integer. */
const coverBucketKey = (bx: number, by: number) => (bx + 1024) * 65536 + (by + 1024);
const COVER_RING_PASSES: { color: number; offsets: [number, number][] }[] = [2, 1].map((r) => ({
  color: r === 2 ? HIDDEN_RING_BRIGHT : HIDDEN_RING_COLOR,
  offsets: (() => {
    const o: [number, number][] = [];
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) if (Math.abs(dx) + Math.abs(dy) <= r) o.push([dx, dy]);
    return o;
  })(),
}));
// Tap hitboxes (maintainer round 12: taps kept missing small targets). World
// px ≈ screen px at zoom 1; phones run integer zoom ≥1, so these are AT
// LEAST fingertip-scale on every device.
// MONSTER GAIT SYNC (maintainer round 13: monsters "jump" or the walk clip
// "is limping forward" — the animation must sync with the actual movement).
// A monster's speed spans 42 wu/s (roam) → 105 (chase) → 220 (a provoked
// hunt), but every walk clip used to play ONE fixed rate (6 or 10 fps picked
// from the frame count alone), so the feet could only match the ground at one
// of those speeds. The clip is now paced by DISTANCE: one cycle per the
// manifest's measured gait.cycleWu, i.e. fps = frames × speed / cycleWu.
const GAIT_REF_WU = 42; // roam speed (WALK_SPEED × MONSTER_SPEED_SCALE) — the clips' base rate
const GAIT_FPS_MIN = 3; // a heavy body may pace slowly, but never freeze mid-stride
const GAIT_FPS_MAX = 26; // …nor blur at a provoked sprint
const GAIT_HOP_EASE = 10; // hop-offset smoothing (per second) — no pops on frame changes
// THE GRAB (maintainer 2026-08-06): the player walks to the spot where the
// pickup gesture's hand actually reaches the item, and the item vanishes on
// the exact frame the hand closes on it. How near that spot counts as
// "standing on it" — the autopilot's own arrival tolerance is a few wu, so a
// tighter number would just stall the grab.
// NPCs stand around town breathing. The generated idle is short and would
// read as a room full of metronomes if every one of them looped it back to
// back (maintainer 2026-08-06: "I want a more calm idle … freeze on the first
// frame for a pseudo-random duration between 0.1s and 5s so they don't repeat
// the idle animation too often and too regularly"). So each NPC plays its clip
// ONCE, then holds frame 0 for a fresh random pause before the next one.
const NPC_HOLD_MIN_MS = 100;
const NPC_HOLD_MAX_MS = 5000;
const NPC_BODY_RADIUS = 9; // same personal space as a player body (fake collision)
// NPC HEAD-TURNING (maintainer 2026-08-09: "when we have this much content it
// feels dumb to not utilize more of it"). maps2' facing stays HOME; two things
// pull an NPC off it, and both hand it back.
// ALMOST TOUCHING, deliberately: the look is a reaction to someone brushing
// past you, not a 5-cell stare. A player body is ~9wu and a cell is 32, so
// this fires roughly when the two bodies overlap.
// THE DEATH SEQUENCE (maintainer 2026-08-09: "make it a little bit more
// dramatic... fade very dark and if possible even monochrome, the music should
// become silent and the camera should slowly slowly zoom into the player").
// Nothing here is on a timer that revives you — the press is (see the server's
// "respawn" message); these only pace the picture.
// The drain rides the ZOOM's own curve, not a clock of its own (maintainer
// 2026-08-09: "monochrome and darkness should fade in together with the zoom
// in") — one easing, so the picture cannot arrive before the push does.
// What the game can actually make the local player do within seconds of a
// spawn, most urgent first. These lead the deferred batch; my remaining states
// (the weapon/spell clips, which nothing can trigger yet — there are no weapons
// and every swing resolves to kick or punch) queue behind the NPCs. Ordering
// only, never a filter: everything still loads.
const PLAYER_URGENT_STATES = ["hurt", "die", "kick", "punch", "pickup"];
// The revive ask is retried on this cadence and starts admitting trouble after
// REVIVE_QUIET_MS — the server's own backstop is PLAYER_DEATH_MAX_MS (3 min),
// far too long to sit in front of a prompt that looks broken.
const REVIVE_RETRY_MS = 600;
const REVIVE_QUIET_MS = 4_000;
const DEATH_ZOOM_MS = 10_000; // the SLOW push onto the body — the whole mood
const DEATH_ZOOM = 3; // x the normal integer zoom, as asked
// THE VEIL IS A VIGNETTE, NOT A FLAT WASH. A flat one crushes the torch pool
// exactly as hard as everything else — and at 3x zoom the body sits well INSIDE
// the torch's 6-cell radius, so there is no falloff left on screen to read as a
// pool either. Both together are why the shipped fade read as "very dark only"
// with no torch at all (maintainer 2026-08-12, with a shot). So the veil keeps
// most of the light ON the body and takes nearly all of it at the edges: the
// gradient MANUFACTURES the pool the zoom flattened, and what shows through it
// is the torch's own warm light.
const DEATH_DARK = 0.05; // brightness left at the screen EDGE
const DEATH_DARK_CORE = 0.62; // brightness left ON the body — the torch's pool
const DEATH_FOCUS_Y = 0.46; // where the body lands in the view (see DEATH_AIM_FRAC)
const DEATH_TORCH_BOOST = 1.6; // x my torch while dead — overbright widens the hot plateau
const DEATH_AIM_FRAC = 0.12; // how far above the foot anchor the push aims — a lying body
const DEATH_PROMPT_MS = 450; // the card's own CSS fade — see the .45s transition
const NPC_LOOK_WU = 26;
const NPC_LOOK_LINGER_MS = 900; // keep watching a moment after they step away
// ONE COMPASS NOTCH AT A TIME, so a turn SWEEPS instead of snapping — even a
// direction the head only passes through is held for this long.
const NPC_TURN_STEP_MS = 200;
// A random glance holds 10-30s, then home holds ~4x that. Home therefore wins
// about 90/(90+20) = 82% of the time, which is the ~80% asked for; the two
// ranges are what to move if that share should change.
const NPC_GLANCE_MIN_MS = 10_000;
const NPC_GLANCE_MAX_MS = 30_000;
const NPC_HOME_MIN_MS = 55_000;
const NPC_HOME_MAX_MS = 125_000;
const GRAB_ALIGN_WU = 10;
/** Frame index out of a character frame's texture key (f:<uid>:<state>:<dir>:<n>). */
const frameIndexOf = (key?: string): number => {
  const m = key ? /:(\d+)$/.exec(key) : null;
  return m ? +m[1] : 0;
};
const DROP_TAP_HALF = 26; // was 16 — items are ~29px art on the ground
const MONSTER_TAP_MIN_HALF_W = 26; // was 18, and the art factor grew 0.4→0.5+6
const MONSTER_TAP_MIN_H = 48; // minimum box height — sprigling-class bodies
// Spawn campfire (scenery/campfire, burn/south): 96px frames; per its
// placement metadata the fire is 0.6m ≈ 23px tall vs a 64px character, and
// the drawn logs span rows 15..83 of the frame → scale + base anchor below.
const CAMPFIRE_KEY = "campfire-burn";
// The ONE art asset the game names directly instead of reading it from a
// manifest — scenery/ ships none the game reads, and that whole domain is now
// this single file. If scenery/ ever gains a manifest, read the url from it instead of
// hardcoding the extension here.
const CAMPFIRE_URL = "/assets/scenery/campfire/animations/burn__south.webp";
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
/** Set a sprite's origin to a tuned monster's shadow centre for one facet —
 * the shared inheritance chain, with the art-derived default (measured foot
 * line + hover, the untuned game's own anchor) as the final fallback. */
function applyTunedOrigin(
  sprite: Phaser.GameObjects.Sprite,
  rec: MonsterShadow,
  state: string,
  dir: string,
  artBottom?: number,
  hoverPx?: number,
): "facet" | "idle" | "base" | "default" {
  const off = shadowAnchorOf(rec, state, dir);
  if (off) {
    sprite.setOrigin(0.5 + off.ax / sprite.width, 0.5 + off.ay / sprite.height);
    return rec.offsets?.[`${state}#${dir}`]
      ? "facet"
      : rec.offsets?.[`idle#${dir}`]
        ? "idle"
        : "base";
  }
  sprite.setOrigin(0.5, (artBottom ?? 0.85) + (hoverPx ?? 0) / sprite.height);
  return "default";
}
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

// THE LIGHT SLOT LEDGER — see lightslots.ts for the layout. World lights are
// picked closest-to-camera-first among candidates whose POOL can touch the
// view; a source holding a slot keeps it until a competitor is meaningfully
// closer (hysteresis), so walking a boundary can't strobe a light on and off.
// A newly acquired light ramps in over this long, its pool stamp crossfading
// out underneath — a mid-view acquisition is a fade, never a pop. Retirement
// dissolves at the same speed, in reverse.
const LIGHT_RAMP_MS = 450;
// A waiting candidate must be this much CLOSER to the camera than a settled
// holder to start its retirement (hysteresis — the pair can never ping-pong),
// and at most this many dissolves run at once (pressure reads as fires
// breathing one by one, never a wave).
const LIGHT_STEAL_MARGIN = 200;
const LIGHT_RETIRE_MAX = 2;
// Exit margin past the pool's own reach before a HELD light is released — a
// pool sitting exactly on the view boundary must not flicker candidacy.
const LIGHT_EXIT_PX = 96;
// A world light candidate resolved from an emissive prop + emission.json.
interface EmissiveSource {
  id: string; // "col,row" — matches the pool stamp's srcId
  col: number;
  row: number;
  z: number;
  radius: number; // cells
  color: [number, number, number];
  flicker: number;
  shadows: boolean; // false → negative radius = the shader's shadow-free glow pool
  sx: number; // projected screen anchor (elevation-lifted) for view culling
  sy: number;
  // The source stands inside a SEALED ROOM (the indoor verdict's own rule — a
  // bridge or arch is not a room). Such a light is INDOOR-ONLY: lit exactly to
  // the degree I am in its room, never from outside. Probed via the cell's
  // 4-neighbours because a prop BLOCKS its own cell — the room flood can never
  // contain it (the same trap the stamp gate fell into).
  sealed: boolean;
}
// The optional `lights` block in tiles2/emission.json (per tile-path stem or
// per material). All fields optional; radius in CELLS; color may exceed 1
// (the shader clamps the multiply at 1.25, so >1 widens the hot plateau —
// the campfire trick); z = levels above the cell surface.
interface EmissiveLightCfg {
  radius?: number;
  color?: [number, number, number];
  flicker?: number;
  shadows?: boolean;
  z?: number;
}
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
/** Depth falloff for the cave shadow: mouth 5%, 1 tile in 0.2%, then black.
 * Steep because the ONLY surface a cave mouth actually shows is its floor —
 * the walls of the room are buried behind the mountain's outer columns and
 * never reach the screen, so the floor has to carry the whole effect. */
const CAVE_FALLOFF = 3.0;
/** The draw-time floor tint is OFF: the shader covers the same pixels. */
const CAVE_TINT_TILES = false;
const GROUND_MARGIN = 512; // extra ground drawn beyond the screen (px per side)
/** Texels the exposed band overlaps back into the kept picture (see
 *  scrollTiles3Ground). 1 is what the measured artefact needed; it is a
 *  repaint of pixels that are already right, so it is safe to raise. */
const GROUND_SEAM = 1;
// Occluder rebuild cadence, and the slack every occluder cull margin is
// derived FROM. The set is only re-evaluated once the camera centre has
// drifted this far, so anything culled must stay invisible for a whole
// OCC_STEP of camera travel — every cull box below is grown by at least this
// much (plus a tile) or geometry would wink in at the leading screen edge.
const OCC_STEP = 96;
/** How long a perf-beacon window is (see perfBeaconTick). Long enough that a
 *  report covers several ground latches, short enough that a run into fresh
 *  terrain is not averaged away. */
const PERF_BEACON_MS = 30_000;
// Extra cull margin beyond OCC_STEP: one tile of art, plus room for the
// biggest body art box that resolveBodyDepth can test against a column
// (a mammoth spans ~190px) — a column that could still sort against an
// on-screen body must keep its images, not just the ones that draw.
const OCC_CULL_PAD = OCC_STEP + 64 + 200;
// Living camera (maintainer): the camera CHASES the player instead of pinning
// them dead-centre — exponential ease toward the sprite with the trail capped,
// plus a small speed-coupled ZOOM-OUT so the player still sees a bit further
// while moving (the chase alone would show less in the running direction).
// Per-monster SFX cadence (games-audio 2026-08-06). Idle and angry LOOP, so
// they fire on a jittered per-individual interval — a pack must breathe out of
// phase, not in chorus. The per-second budget is the herd guard: at most this
// many monster sounds may START in any one second across the whole view, which
// is what keeps a visible mammoth herd from machine-gunning.
const MONSTER_IDLE_GAP_MS: [number, number] = [5200, 12800];
const MONSTER_ANGRY_GAP_MS: [number, number] = [2200, 4600];
const MONSTER_SFX_PER_SEC = 10;

// Battle music (composer): how close a HUNTING monster (mstate chase/combat)
// has to be for the fight to count as mine — world units, 32/cell, so ~7
// cells. Roaming monsters score zero at any distance.
const THREAT_NEAR_WU = 220;
const CAM_TAU = 0.3; // s — position smoothing (run trail ≈ 175px/s × τ ≈ 52px)
const CAM_TRAIL_MAX = 70; // scene px — the player never outruns the frame
const CAM_SNAP_DIST = 600; // teleports (respawn/lookAt) snap instead of crawl
/** THE PREFETCH RING: how far beyond the ground texture art is asked for ahead
 *  of the camera (world px; the texture already reaches GROUND_MARGIN past the
 *  view), and how many ring cells one frame resolves — see t3prefetchStep. */
/** FLAT SCENERY (a piece published `collision: false` — the rugs) draws in its
 *  own band UNDER every body, every other piece and every terrain occluder, and
 *  above the ground texture at -1,000,000: it lies ON the floor, so nothing it
 *  is drawn beside can ever be behind it (maintainer 2026-09-03: "everything
 *  marked as no collision should always be drawn under the
 *  player/monsters/npcs/other scenery"). Its own painter line is kept as a
 *  small offset so two overlapping rugs still sort against each other. */
const SCENERY_FLAT_DEPTH = -500_000;
/** `?ground=legacy` (remembered) selects the pre-rework ground path — see the
 *  `groundScroll` field. Returns TRUE for the current path. */
/** `?perf=1` arms the client perf beacon (remembered; `?perf=0` clears it).
 *  OFF for everyone else: it turns on the per-section timers and posts a
 *  report every PERF_BEACON_MS to /api/perf. See perfBeaconTick. */
function perfBeaconArmed(): boolean {
  try {
    const q = new URLSearchParams(location.search).get("perf");
    if (q === "1" || q === "0") localStorage.setItem("ml-perf-beacon", q);
    return (localStorage.getItem("ml-perf-beacon") ?? "0") === "1";
  } catch {
    return false;
  }
}

/** THE SLEDGEHAMMER, TEMPORARILY THE DEFAULT (maintainer 2026-09-03: "can't you
 *  just try something crazy that will for sure fix it and then step back to the
 *  minimum fix needed afterwards — just to get rid of the 3 day long bug hunt").
 *
 *  LEGACY turns the whole 2026-09-02/03 ground rework off in one go: no scroll,
 *  no sliced band, no landing repaints, no prefetch — every camera latch paints
 *  the whole texture. If the zigzag lives anywhere in that machinery it cannot
 *  survive this, and if it DOES survive, every conclusion drawn from the
 *  incremental path is wrong and the search moves elsewhere. Either answer is
 *  worth more than another minimal guess: seven of those were shipped and all
 *  seven were wrong.
 *
 *  It costs what the rework bought — a full repaint per latch, measured 18-78 ms
 *  on this machine and worse on a phone — so this default is a DIAGNOSTIC and
 *  must be bisected back to the minimum once the artefact is confirmed gone.
 *  `?ground=fast` restores the streaming path for anyone who wants to compare,
 *  and the choice is still remembered in `ml-ground-path`. */
function groundPathFast(): boolean {
  try {
    const q = new URLSearchParams(location.search).get("ground");
    if (q === "legacy" || q === "fast") localStorage.setItem("ml-ground-path", q);
    return localStorage.getItem("ml-ground-path") === "fast";
  } catch {
    return false; // storage or location blocked: the diagnostic path, for now
  }
}
/** How far AHEAD the prefetch reaches when the direction of travel is not yet
 *  known (the first paint after a join or a teleport) — see t3armRing. */
const GROUND_RING = 512;
const GROUND_RING_STEP = 80;
/** THE BAND IS PAINTED IN SLICES, one per frame — see t3paintSliceStep. Slice
 *  depth in texture px along the band's long axis. The texture reaches
 *  GROUND_MARGIN (512 px) beyond the view and a step exposes at most 256 px, so
 *  a freshly exposed band is entirely OFF SCREEN for ~2.9 s at run speed
 *  (512/175). SIZED AGAINST THE GPU, not just the JS: every beginDraw/endDraw
 *  bracket costs a full capture-target clear AND a full-texture blit whatever
 *  it draws (Phaser 3.90 DynamicTexture.beginDraw -> RenderTarget.bind, and
 *  endDraw -> blitFrame), so slices trade a spread-out JS cost for MORE
 *  brackets. 384 px gives ~4-8 slices: the JS of a latch lands in 4-8 pieces
 *  while the whole-texture GPU work stays within ~2x the unsliced scroll. */
const GROUND_SLICE_PX = 384;
/** What ONE painted slice should cost, and the range the slice size may take to
 *  hit it. Same lesson as GROUND_RING_MS, same source: `groundSlice` measured
 *  6.48 ms per frame on the maintainer's phone against ~1.7 ms here, because a
 *  384 px slice is a SIZE budget and size does not predict cost across devices.
 *  The size is now steered by the measured milliseconds of the slices actually
 *  painted, so the same code lands near the target on both machines. */
const GROUND_SLICE_MS = 2;
const GROUND_SLICE_MAX = 768;
/** Composed boundary/plate textures the PREFETCH RING may build per frame. */
const GROUND_RING_COMPOSE = 3;
/** THE PREFETCH'S REAL BUDGET: MILLISECONDS, not counts.
 *
 *  Measured on the maintainer's own phone (live/telemetry/perf.json, the client
 *  beacon, 2026-09-03): `prefetch` cost **15.65 ms per frame** in his worst
 *  window and 5.96 in the next — on a 16.7 ms budget, the prefetch ALONE could
 *  exceed the whole frame. The same section measures ~1.7 ms here, so the
 *  count-based budget above is roughly NINE TIMES too large on the device that
 *  matters, which is exactly what a count tuned on a dev box does.
 *
 *  A time budget adapts by construction: a phone gets fewer cells and one
 *  composition, this machine still gets its eighty. The counts stay as upper
 *  bounds so a pathologically cheap frame cannot run away. */
const GROUND_RING_MS = 2;
/** ONE COMPOSITION IS AN ATOM, AND ON HIS PHONE IT IS ~13 ms.
 *
 *  Measured: with GROUND_RING_MS already in force, `prefetch` still cost 15.64
 *  ms/frame, because the budget is tested BEFORE a composition and cannot stop
 *  one halfway — a canvas blend plus a GPU upload either happens or does not.
 *  So the budget has to be spent across FRAMES instead: track what a
 *  composition actually costs here and let the ring attempt one only every
 *  ceil(cost / GROUND_RING_MS) frames. On this machine that is every frame; on
 *  his it is one every seven, which is what holds the average at the budget
 *  instead of the atom. */
const GROUND_RING_COMPOSE_EMA = 0.25;
/** Files in flight for the DEFERRED animation batch — see loadDeferredAnims.
 *  Dev A/B: localStorage `ml-deferred-parallel` overrides (0 = the loader's own). */
const DEFERRED_PARALLEL = 2;
function deferredParallel(): number {
  try {
    const n = Number(localStorage.getItem("ml-deferred-parallel"));
    if (Number.isFinite(n) && n >= 0 && localStorage.getItem("ml-deferred-parallel") !== null) return n;
  } catch {
    /* storage blocked: the constant */
  }
  return DEFERRED_PARALLEL;
}
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
  fog?: Phaser.GameObjects.Image; // the fog silhouette over the lit copy (syncLitCopy)
  hidden?: Phaser.GameObjects.Image; // white outline over the covered part (syncCoverOutline)
  // Screen y of the highest wall top drawn over the sprite this frame, or
  // undefined when nothing covers it — the lit copy is cropped BELOW this line.
  coverY?: number;
  // The pixel-exact cover surfaces (see BodyVisual) — structurally shared with
  // monsters and NPCs through the same body pipeline.
  coverSlot?: CoverSlot;
  coverAt?: number;
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
  // The pickup sound waits for the frame the hand closes on the item (see the
  // pickup branch). `pickupSfxAt` is when the gesture started — armed state and
  // the safety-valve clock in one field; null means nothing pending.
  pickupSfxFrame?: number | null;
  pickupSfxAt?: number | null;
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

/* EVERY IMAGE A REBUILD PLACES GETS A UNIQUE DEPTH: its base painter depth plus
 * its creation index times this. Phaser's depth sort is STABLE, so images that
 * share a depth draw in INSERTION order — and a column's wall faces and cap all
 * share one depth (oDepth = by + dy) and stack correctly only because they were
 * inserted bottom-up, cap last. Once images are REUSED across rebuilds (the
 * occluder pool, below) insertion order is history, so the order is written
 * into the depth instead: creation index × 1e-6 reproduces "insertion order
 * among equals" exactly, and tops out at ~0.006 over a 6,000-image rebuild —
 * far inside the ≥0.3 every body and light keeps from a column's depth
 * (resolveBodyDepth: +0.5 / above+0.6 / below−0.3; lights +0.1/+0.2).
 *
 * A BASE-BAND QUANTITY ONLY. `litDepth` compresses painter depth into the lit
 * band by ×1e-5, where the same 0.3 of body margin is 3e-6 — so 1e-6 per index
 * there is 0.1 world px of painter depth, and 5,000 indices put a tree's lit
 * copy 500 px in front of a body standing before it (caught in review,
 * 2026-09-02). Nothing that goes through litDepth takes the epsilon: lit copies
 * are never pooled, are recreated in creation order every rebuild, and the
 * stable sort resolves their ties exactly as it always did. */
const OCC_DEPTH_EPS = 1e-6;

/* THE LOADING BAR'S BANDS — a stage gets the share of the BAR that matches its
 * share of the TIME, measured, so the bar moves at roughly one speed the whole
 * way (maintainer 2026-09-02: "it loads 55% and the last 45% goes super fast").
 *
 * Measured on a cold the_game boot before this: 3.0 s of boot, 5.4 s of art
 * batch, 2.7 s standing still at "Connecting…", 15.5 s streaming — and the bar
 * showed 0-60% for all of it, then jumped 54 -> 100 when the one big terrain
 * batch landed. Bands 60-99% were never displayed at all.
 *
 * BOOT ends at 0.08 (bundle, manifests, world.json — no fine progress to be
 * had before the scene exists). ART is the Phaser boot batch, which reports per
 * file. CONNECT has nothing to count — matchmake, the join, the first state —
 * so it CREEPS asymptotically across its band and never reaches the end of it.
 * STREAM is terrain + scenery, also per file now, and it is the long pole. */
const BAR_ART0 = 0.08;
const BAR_ART1 = 0.3;
const BAR_CONNECT1 = 0.4;
/** Time constant of the connect creep. Its band is ~2.7 s of a ~27 s boot, so a
 *  2 s constant spends most of the band without ever claiming it. */
const BAR_CONNECT_TAU_MS = 2000;
const STREAM_BAR0 = 0.4;
const STREAM_BAR1 = 0.98;

// ===========================================================================
// INDOORS — the renderer half of shared/src/indoor.ts
// ===========================================================================
// The module answers "am I under a roof, and is that a ROOM?"; everything
// below is what the picture then does about it (maintainer 2026-08-06):
//
//   "we should automatically detect when a player walks into a house/cave…
//    The game does this by removing the roof and everything over the roof. The
//    game also renders everything outside the house (not under the roof)
//    black, but we have to still be able to show the walls facing the inside
//    of the house/cave, but only the part that faces the inside. Not the
//    entire tile."
//   "The lighting indoors is always dark as during the night, but with a less
//    'blue moonlight ambient' tone. It's up to each individual room to place
//    lights."
//   "It's also important to re-enable the players torch even if it's day."
//
// IT IS A CUT-AWAY, NOT AN X-RAY. The building is drawn WHOLE and simply
// TRUNCATED: every one of its columns — floor, near wall, far wall, corner —
// stops at `indoorTop` levels, and what stood above that is not drawn. The
// roof goes because it is above the cut; the near walls become a low parapet
// you look over. Nothing is hidden, nothing is made transparent, nothing is
// half a tile.
//
// THE HISTORY IS WORTH ONE PARAGRAPH, because the obvious idea is the wrong
// one. The first cut CULLED: no roof, no near walls at all, and a 32px
// half-face "skirt" of each far wall. It shipped holes — wall slabs floating
// disconnected in the void, black wedges through a solid roof line — and the
// holes were structural rather than a tuning miss. Culling has to ask "whose
// inward face does the camera see", and a room's own CORNER has no inward
// face, so no wall set could contain it, so nobody drew it; the same for every
// T-junction where an interior partition meets an outer wall. See `shell` in
// shared/src/indoor.ts. Maintainer 2026-08-07, who had asked for the cut-away
// in the first place: "You added a transparent wall feature where my idea was
// to instead cut all walls at roof-1, roof-2, etc. Even making this
// configurable in settings so I can test what looks best... my solution was to
// go with a white pixel outline on parts being behind something."
//
// So the two halves of the design are: this truncation, and the white
// silhouette outline that keeps a body readable when a parapet still covers
// its legs. The WALL HEIGHT is the maintainer's dial — see indoorwall.ts.
//
// THE OUTSIDE IS A VOID, NOT A BLACK TILE. "Draw the outside black" is
// implemented as "draw nothing and make the ground RT's backdrop black",
// because a black TILE is strictly worse: the ground RT paints in painter
// order (v = col+row ascending), so a black copy of the outside terrain
// down-screen of the house would be drawn AFTER the interior and cover it.
// Drawing nothing against a black backdrop IS "rendered black", at no cost.
//
// The per-cell verdict is a BITMASK, one entry per cell of the current space,
// rebuilt only when the space changes (see refreshIndoorMask). It is also the
// hook the ray-traced doorway daylight will want: keep the mask a plain
// bitfield and add a PARALLEL Map<cellIndex, number> of light, rather than
// turning these into objects — the mask is walked once per cell per ground
// redraw and per occluder rebuild.
//
// Both bits draw the SAME truncated column; they are kept apart because other
// passes genuinely mean "the floor of the room" — props only stand on IN_ROOF
// cells, and a light must be inside the room to count.
const IN_ROOF = 1; // under the same roof as me: interior floor
const IN_WALL = 2; // the building itself: any solid cell of the enclosure

/** Indoor ambient — "always dark as during the night, but with a less blue
 * moonlight ambient tone" (maintainer). Derived from TIME_PHASES[0] Night
 * [0.075, 0.09, 0.14] by holding LUMINANCE and rotating the hue about green:
 *
 *   Rec.709 luma  night 0.09042 → indoor 0.09016   (−0.3%: equally dark)
 *   B ÷ R         night 1.867   → indoor 1.209     (76% of the blue tilt gone)
 *   chroma        night 0.639   → indoor 0.193     (30% of night's saturation)
 *
 * Equal luminance is the load-bearing half: stepping inside at midnight must be
 * a HUE change, not a brightness pop. G is left at night's own 0.090 and only
 * R/B move, which is why the luma barely shifts (G carries 71% of Rec.709).
 * The residual +21% blue is deliberate — unlit stone and wood are cool; going
 * fully neutral reads as flat grey and going warm reads as if a fire were
 * already lit, which would pre-empt "it's up to each individual room to place
 * lights". TUNE ALONG [0.09 − k·0.015, 0.090, 0.09 + k·0.050]: k=1 is Night
 * itself, k=0.28 is this. Every point on that line holds luma within 1%.
 *
 * THE BRIGHTNESS IS NOW A SETTINGS SLIDER (maintainer 2026-08-06: "a slider on
 * the settings page … 0% = BLACK, 100% = THE TILE WILL LOOK JUST LIKE THE PNG").
 * indoorlight.ts owns the dial and derives the triple from it, keeping the hue
 * above as RATIOS so moving the slider changes brightness and nothing else —
 * until the very top, where the tint fades out so 100% is exactly [1,1,1] (a
 * tinted 100% would render every tile faintly blue and would not be the source
 * art). The dial defaults to 0.104, which reproduces the triple this comment
 * derives, so the shipped look is unchanged until someone drags it. */

/** Time constant of the indoor LIGHT cross-fade (seconds). The geometry snaps
 * — a half-faded roof is just a wrong roof — but the grade must not, or a
 * doorstep reads as a camera cut. Same exponential-roll idiom as the cloud /
 * mist / aurora eases (frame-rate independent, and retarget-safe: turn round in
 * the doorway and it simply reverses from wherever it is). 0.35s is ~93% of the
 * way in 1s — an eye adapting, and finished before you have walked one cell in.
 * The weather roll's 4s is far too slow for a doorway. */
const INDOOR_TAU = 0.35;
// The transition's two speeds, as multiples of the eased indoor mix. The
// GEOMETRY crossfade (debris) runs hot — hiding the repaint seams is its whole
// job, and they hide better the less time they get (maintainer: 2× was not
// enough, 3×). The LIGHT grade (darkening, light gains, fog) is "a bit
// faster" than the raw roll and deliberately NOT roof-fast (maintainer
// 2026-08-13: a first cut that ran everything at 3× read as one big snap —
// "the roof fade is intended to be faster to hide bugs").
const INDOOR_DEBRIS_RATE = 3;
const INDOOR_GRADE_RATE = 1.5;

/** Minimum wall-clock between APPLIED indoor transitions. Layers 1 and 2 of the
 * hysteresis (the relaxed leave bar and the space identity, see
 * `indoorVerdict`) cannot smooth the last case: a player standing astride a
 * doorway steps between two cells that differ by ROOF MEMBERSHIP, and no depth
 * bar reaches that. A deferred verdict is never discarded — it is re-checked
 * every recompute and lands the moment this expires — so this can only DELAY a
 * flip, never lose one. It matters because a flip rebuilds the whole ground RT
 * AND ~3,900 occluder sprites. */
const INDOOR_DWELL_MS = 250;

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
  fog?: Phaser.GameObjects.Image; // the fog silhouette over the lit copy (syncLitCopy)
  hidden?: Phaser.GameObjects.Image; // white outline over the covered part (syncCoverOutline)
  coverY?: number; // wall-top line covering the sprite (lit copy cropped below it)
  // The pixel-exact cover surfaces (see BodyVisual / registerCoverSlot).
  coverSlot?: CoverSlot;
  coverAt?: number;
  surfLevel?: number; // surface level in LEVELS (occluder + light sampling basis)
  shadowW: number; // resting nadir-shadow ellipse, measured from the walk ART
  shadowH: number; // (footprint blended toward body width; see addMonster)
  // THE GAME MASTER'S ONE TUNED SHADOW (wiki shadow editor, live/tuning/
  // monsters `shadow` field). When set it replaces the whole legacy ground
  // contract for this monster: the sprite anchors on the shadow's centre (one
  // origin for every direction and animation, so the art rotates around it),
  // the ellipse rotates with the facing, and the body radius derives from its
  // size. undefined = legacy per-direction measured anchors, unchanged.
  tuned?: MonsterShadow;
  // The CANONICAL facet state the tuned anchor is resolved against — one of
  // idle/walk/attack/angry/die, the names the wiki's editor writes as
  // `offsets["<state>#<dir>"]`. NEVER the manifest-resolved clip alias
  // (monsterWalkKey can answer "jump"): the wiki keys by the canonical state,
  // so looking up by the alias would silently fall through to idle#<dir>.
  // playMonsterAnim records it; the per-frame re-anchor and the live-tuning
  // handler read it back so both re-resolve the SAME facet.
  shState?: string;
  // Which link of the chain supplied the anchor in force: the facet's own
  // offset, the direction's idle offset, the v1 base ax/ay, or the art
  // default. QA only (__ml.monsterInfo) — a gate that cannot see WHY an
  // anchor was chosen cannot tell "tuned" from "fell back".
  shSrc?: "facet" | "idle" | "base" | "default";
  artBottom?: number; // manifest foot line — the untuned default anchor fraction
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
  // ART PENDING: this kind's walk/idle strips ride the deferred batch and
  // have not landed. Parked exactly like a culled body — never the placeholder
  // wanderer, never a checkerboard — and released by onMonsterArtLanded.
  artPending?: boolean;
  // COMBAT mirrors (server mstate/actionSeq drive the clips).
  mstate?: string;
  lastActionSeq?: number;
  combatClip?: boolean; // current clip is attack/angry/die — per-frame walk drift must not index into it
  // ---- per-monster SFX bookkeeping (games-audio 2026-08-06) ----
  // The wiki assigns a sound per (monster, animation state); these fields are
  // what keep a LOOPING state from firing every frame and a herd from firing
  // at once. All silent until the Game Master assigns something.
  sfxIdleAt?: number; // ms of the last idle call
  sfxIdleGap?: number; // this individual's current idle interval (jittered)
  sfxAngryAt?: number;
  sfxAngryGap?: number;
  sfxWalkProg?: number; // last seen anim progress — a wrap is one gait cycle
  sfxLastSwing?: number; // actionSeq the attack sound last fired on
  hpBg?: Phaser.GameObjects.Rectangle;
  hpFill?: Phaser.GameObjects.Rectangle;
  nameText?: Phaser.GameObjects.Text; // display name — left-aligned OVER the bar
  lvText?: Phaser.GameObjects.Text; // "Lv N" — left-aligned UNDER the bar
  hpText?: Phaser.GameObjects.Text; // "hp/max" — right-aligned UNDER the bar
  label?: string; // manifest display name ("Dewling"), resolved once at spawn
  lastHp?: number;
  // GAIT SYNC (round 13). cycleWu = world units one walk cycle covers, so the
  // clip is paced by DISTANCE travelled; travel[] = per-frame ground-track
  // weights (mean 1) for real hoppers. spdWu/scrPerWu are measured from the
  // body's own drawn motion each frame.
  cycleWu?: number;
  travel?: number[];
  travelCum?: number[]; // prefix sums of travel/frames — the hop offset curve
  spdWu?: number; // EMA of world speed (wu/s)
  scrPerWu?: number; // EMA of drawn screen px per world unit (iso projection)
  hdx?: number; // EMA of the drawn heading (screen unit vector)
  hdy?: number;
  hopOff?: number; // current mean-zero ground-track offset (screen px)
}

/** A placed NPC. Client-only decor with NO server state: maps2' npcs.json says
 * where it stands and which way it faces, characters2 says what it looks like.
 * Satisfies BodyVisual, so it renders through the exact same depth / nadir
 * shadow / lit-copy path as players and monsters. */
interface NpcAvatar {
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Image;
  lx: number;
  lyFlat: number;
  ly: number;
  elev: number;
  fx: number; // flat world position (fixed — they never walk)
  fy: number;
  lit?: Phaser.GameObjects.Sprite;
  fog?: Phaser.GameObjects.Image; // the fog silhouette over the lit copy (syncLitCopy)
  hidden?: Phaser.GameObjects.Image; // white outline over the covered part (syncCoverOutline)
  coverY?: number;
  surfLevel?: number;
  charId: string;
  name: string;
  type: string;
  dir: string;
  /** maps2' own facing — what this NPC returns to (see stepNpcFacing). */
  home: string;
  def: NpcDef; // for the art of a direction it turns to later
  turnAt: number; // next sweep notch is due
  glanceDir: string | null;
  glanceUntil: number;
  nextGlanceAt: number;
  lookDir: string | null; // at the player, while they are almost touching
  lookUntil: number;
  animKey: string | null; // the idle clip for THIS facing, when the art has one
  pendingAnim?: { key: string; frames: string[] }; // queued art, registered when it lands
  holdUntil: number; // frame-0 pause deadline — the "calm idle" (see NPC_HOLD_*)
  culled?: boolean;
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
  fog?: Phaser.GameObjects.Image; // the fog silhouette over the lit copy (syncLitCopy)
  hidden?: Phaser.GameObjects.Image; // white outline over the covered part (syncCoverOutline)
  coverY?: number;
  // The body's slot in the three cover atlases, held while it lives, and the
  // frame counter it was last registered on. `coverAt === scene.coverTick` is
  // what both consumers test — a body that did not register this frame falls
  // back to the flat coverY crop, and the OUTLINE and the LIT COPY must always
  // make that decision together.
  coverSlot?: CoverSlot;
  coverAt?: number;
  surfLevel?: number;
  swimming?: boolean;
}

/** One body-sized rectangle, at the SAME coordinates in all three cover
 * atlases, registered as a named frame on each. `w`/`h` are the 32px-rounded
 * class box; the body's padded frame sits at its top-left corner. */
interface CoverSlot {
  i: number;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  cls: string;
  /** The body currently holding this slot, so the idle sweep can hand it back
   * (see sweepCoverSlots). Cleared by releaseCoverSlot. */
  owner?: BodyVisual;
}

/** At most one manifest-landed scenery rebuild per this many ms. The timer
 *  arms on the FIRST landing of a burst and is not pushed back by the rest,
 *  so a trickle of ~200 manifests costs a bounded number of rebuilds and the
 *  first art request is never more than this late. */
const SCENERY_MANIFEST_SETTLE_MS = 120;

export class WorldScene extends Phaser.Scene {
  private manifest!: Manifest;
  private myCharacter!: CharacterDef;
  private myName!: string;
  private room?: Room;
  private avatars = new Map<string, Avatar>();
  // Roaming monsters (server-authoritative, all clients see the same ones).
  private monsters = new Map<string, MonsterAvatar>();
  private liveShadowUnsub?: () => void;
  // Rolling one-second window for the monster-SFX budget (see monsterSfx).
  private monSfxWindowAt = 0;
  private monSfxInWindow = 0;
  // How many monsters passed the camera gate last frame (QA: __ml.monsterGate).
  private monstersActive = 0;
  // Monster catalog (null when /monsters.json was unavailable → no monsters).
  private monsterManifest: MonsterManifest | null = null;
  /** Kinds whose walk/idle art rides the BOOT batch (client/src/monsterBoot.ts);
   *  null = every kind, the pre-split behaviour. */
  private monsterBootKinds: Set<string> | null = null;
  /** Kinds the boot batch left out: queued in the deferred batch, and their
   *  bodies stay parked (artPending) until THEIR strips land. */
  private monsterDeferredKinds = new Set<string>();
  private lastPosSavedAt = 0;
  private npcManifest: NpcManifest | null = null;
  /** Placed NPCs, rendered through the SAME body pipeline as players and
   * monsters (depth, nadir shadow, lit copy). Client-only decor: they have no
   * server state at all — position and facing come straight from maps2' file. */
  private npcs = new Map<string, NpcAvatar>();
  private npcPlacement: NpcPlacement[] = [];
  /** NPC idle frames waiting for the DEFERRED batch (never the boot one). */
  private npcIdleQueue: Array<{ key: string; url: string }> = [];
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
  /** The short route round whatever the HELD STICK is jammed against, and the
   *  stick direction that asked for it — see startStickDetour. Distinct from
   *  `trip`, which is the player's own tap destination: this one is disposable,
   *  never draws a marker, and dies the moment the stick moves or the way ahead
   *  opens up. */
  private stickTrip: AutopilotTrip | null = null;
  private stickDir = { ax: 0, ay: 0 };
  /** Which way the body is currently sliding along something — see slideAlong. */
  private walkHold: SlideMemo = { ax: 0, ay: 0 };
  /** The tap autopilot's own slide commitment — never shared with walkHold. */
  private tapSlide: SlideMemo = { ax: 0, ay: 0 };
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
  // ---- chess at the board (chessui.ts; server chess.ts) ----
  private chessDialog: ChessDialog | null = null;
  /** Non-null while standing at a joinable seat: what the jump button offers.
   * "start" = free board, "join" = someone (or the resident NPC) waits. */
  private chessPrompt: { mode: "start" | "join" } | null = null;
  private chessPromptAt = 0;
  private chessDecor = new Map<string, Phaser.GameObjects.Image>();
  private chessWaitB = new Map<string, Phaser.GameObjects.Text>();
  /** …and the tap that CLOSES a modal must not become a trip either: the
   * close handler runs on the element, Phaser's window listener runs after it
   * in the same dispatch, so the lock is lifted a beat later than it is
   * released. */
  private uiLockLiftAt = 0;
  /** The ground point the finger is over, WITH the camera-world point it was
   * picked at. The `at` is load-bearing: holdRepath re-plans 50ms after every
   * tap and again on release, so without it the tap's two-reading resolution is
   * computed once at pointerdown and then thrown away a frame later. */
  private holdGround: { x: number; y: number; lvl: number; at: { wx: number; wy: number } } | null = null;
  private holdRepathAt = 0;
  private keysActive = false;
  private tapMarker?: Phaser.GameObjects.Container;
  /** Camera-world point the beacon is PINNED to — the pixel the finger touched.
   * Null for beacons with no gesture behind them (probes, keyboard), which keep
   * the old projected-from-the-target placement. */
  private tapMarkerAt: { x: number; y: number } | null = null;
  // Isometric tile world (null → fall back to a plain ground).
  private world: World | null = null;
  private worldName: string = DEFAULT_WORLD; // which maps2 world (room + assets)
  private tileAtlas: TileAtlasLoad | null = null; // this world's sheet loader (tileatlas.ts)
  private worldW = WORLD_WIDTH; // this world's extent in world units (grid×CELL_WU)
  private worldH = WORLD_HEIGHT;
  private maps2 = false; // true when the world uses maps2 explicit tile paths
  // MAPS3 (pixel-maps3/world@1): cells name a ground TYPE and no art at all —
  // tiles3 resolves what draws, per cell, at draw time. Mutually exclusive with
  // maps2 by construction (isMaps2World tests for baked paths, which a v3 world
  // has none of), so every existing `if (this.maps2)` branch is untouched.
  private maps3 = false;
  // THE PROJECTION IS PER WORLD. `MAP_GEOMETRY` is the default (tiles2's
  // 32/15/16) and is the exact object a world@1/world@2 world gets, so their
  // pixels cannot move; a maps3 world draws on 32/14/15 (shared
  // ISO_GEOMETRY_MAPS3, the second number MEASURED off the wall art). Every
  // projection in this scene reads THIS, never the module constant.
  private geom: MapGeometry = MAP_GEOMETRY;
  private iso = { ox: 0, oy: 0, w: WORLD_WIDTH, h: WORLD_HEIGHT };
  // ---- TILES 3.0 RUNTIME (maps3 only; every field stays null otherwise) ----
  private t3: Tiles3World | null = null; // per-cell resolution over the whole doc
  private t3tex: Tiles3Textures | null = null; // the composed-texture factory
  private t3load: Tiles3Loader | null = null; // streaming art, one request per path
  private t3sheets: PatternSheets | null = null; // silhouette + masks + borders
  private t3route: UrlRoute = {}; // staging + version pin, injected into both modules
  private t3tm: TextureManagerLike = this.t3TextureManager(); // see t3TextureManager
  private t3loader: Phaser.Loader.LoaderPlugin | null = null; // see tiles3Loader
  // What the last ground pass resolved and drew, plus how long it took. The
  // pass runs on the ground RT's own latch (every GROUND_MARGIN/2 of camera
  // drift), never per frame — `ms` is what makes that budget checkable.
  private t3stats = { cells: 0, blits: 0, boundaries: 0, decks: 0, scenery: 0, ms: 0, culled: 0, composed: 0, composeMs: 0 };
  /** The ground has drawn SOMETHING this world — sticky, because after a
   *  scroll t3stats counts only the exposed bands (which can be all void). */
  private groundPainted = false;
  /* THE GROUND CULL — see t3Blit. `groundCull` is the A/B switch for
   * `__ml.groundRedraw`; nothing in play reads it. */
  private groundCull = true;
  private groundCulled = 0;
  /* THE PER-CELL RESOLUTION CACHE — see t3resolve. A/B switch for
   * `__ml.groundRedraw`; nothing in play reads it. */
  private groundCacheOn = true;
  /** `clear: pink` — fill the ground texture with magenta instead of the page
   *  dark, so an unpainted texel is unmistakable. Diagnostic, default off. */
  private groundClearPink = false;
  /** `transitions` — skip the composed transition tile and let each cell draw
   *  its own plate instead. The draw loop takes ONE of the two, never both, so
   *  this is the A/B for "the zigzag is the transition tile you make with the
   *  mask". Diagnostic, default off (transitions on). */
  private noTransitions = false;
  private t3cells = new Map<number, { cell?: Tiles3Cell | null; boundary?: Tiles3Boundary | null; decks?: Tiles3DeckCell[] }>();
  private t3pitchChecked = false;
  private t3regionMs = 0;
  private t3Failed = new Set<string>(); // see t3Try — one line per distinct resolver failure
  private scenery: SceneryIndex | null = null; // placements bucketed by screen anchor
  private sceneryPieces: SceneryPieces | null = null; // lazy per-piece manifests
  private sceneryImgs: Phaser.GameObjects.Image[] = [];
  private sceneryFit = new Map<string, SceneryFit | null>(); // per piece+state, measured once
  private sceneryAsked = new Set<string>();
  private sceneryQueue: [string, string][] = [];
  private sceneryRebuilds = 0; // the boot hold waits for the first one
  /** Scenery ART files (not manifests) queued and finished — the loading bar's
   *  last stage counts them beside the terrain's. */
  private sceneryArt = { requested: 0, done: 0 };
  /* THE FRAME BUDGET, on demand (`__ml.perf(true)`). Off by default and gated
   * at every call site, so a normal frame pays one boolean per section. The
   * question it answers is the only one that matters for a stutter: WHICH
   * section of update() owned the long frames, and how many objects it was
   * walking when it did. Sections nest (rebuildOccluders contains
   * rebuildScenery), hence the stack. */
  private perfOn = perfBeaconArmed();
  /* THE PERF BEACON — the maintainer's own device, reporting to live/.
   *
   * His idea (2026-09-03), and it is the right instrument: the headless
   * harness runs software GL at 1-3 fps and WALKS ABOUT ONE CELL PER 24
   * SECONDS, so the paths that only fire on fresh terrain — the cell repaint,
   * first-sight plate/boundary composition — never execute in it. Every
   * "cannot reproduce" measured there was a test of code that never ran. He
   * plays on a phone and tests in production, so the numbers that matter can
   * only be taken there. `?perf=1` (remembered; `?perf=0` clears) arms the
   * section profiler and posts a summary to /api/perf, which commits it to
   * live/telemetry/perf.json — the channel agents already read from GitHub.
   * Reports only go out after the player has actually MOVED, so a phone left
   * idle on a bench does not fill the file with nothing. */
  private perfBeacon = perfBeaconArmed();
  private perfBeaconAt = 0;
  private perfBeaconFrom: { x: number; y: number } | null = null;
  private perfHideHooked = false;
  private perfStack: number[] = [];
  private perfAcc: Record<string, { n: number; ms: number; max: number }> = {};
  private perfFrames: number[] = [];
  private perfLast = 0;
  /* THE HITCH RECORDER — the instrument the whole optimisation day lacked.
   * Per FRAME (update-start to update-start, so it includes render), it keeps
   * the profiled sections' own ms, the counters that say what happened that
   * frame, and — the discriminator — `other` = frame total minus every section,
   * which is render + GPU + unprofiled JS. Worst frames are kept, so a run
   * ends with "the 20 longest frames and what was in them". */
  private hitchOn = false;
  private hitchSec: Record<string, number> = {};
  private hitchC = { tex: 0, files: 0, built: 0, buildMs: 0, blits: 0, objs: 0 };
  private hitchWorst: Record<string, unknown>[] = [];
  private hitchN = 0;
  private hitchSum = 0;
  private hitchPrevBuilt = 0;
  private hitchPrevBuildMs = 0;
  private perfTexAdded = 0;
  private perfTexFam: Record<string, number> = {};
  private perfTexFrame = 0;
  private perfTexFrameMax = 0;
  private perfTexHooked = false;
  /** One frame's record — called at the TOP of update() for the frame that
   *  just ended, so `total` spans render as well. */
  private closeHitchFrame(total: number): void {
    const tex = this.t3tex;
    const built = (tex?.stats.built ?? 0) - this.hitchPrevBuilt;
    const buildMs = (tex?.stats.buildMs ?? 0) - this.hitchPrevBuildMs;
    this.hitchPrevBuilt = tex?.stats.built ?? 0;
    this.hitchPrevBuildMs = tex?.stats.buildMs ?? 0;
    let secMs = 0;
    for (const k in this.hitchSec) secMs += this.hitchSec[k];
    this.hitchN++;
    this.hitchSum += total;
    const rec: Record<string, unknown> = {
      f: this.hitchN,
      total: +total.toFixed(1),
      other: +(total - secMs).toFixed(1), // render + GPU + unprofiled JS
      sec: Object.fromEntries(Object.entries(this.hitchSec).filter(([, v]) => v > 0.2).map(([k, v]) => [k, +v.toFixed(1)])),
      mode: this.groundLastMode,
      composed: built,
      composeMs: +buildMs.toFixed(1),
      tex: this.hitchC.tex,
      files: this.hitchC.files,
      objs: this.hitchC.objs,
      ring: this.t3ringQueue.length - this.t3ringAt,
    };
    if (this.hitchWorst.length < 24) this.hitchWorst.push(rec);
    else {
      let wi = 0;
      for (let i = 1; i < this.hitchWorst.length; i++)
        if ((this.hitchWorst[i].total as number) < (this.hitchWorst[wi].total as number)) wi = i;
      if (total > (this.hitchWorst[wi].total as number)) this.hitchWorst[wi] = rec;
    }
    this.hitchSec = {};
    this.hitchC = { tex: 0, files: 0, built: 0, buildMs: 0, blits: 0, objs: 0 };
  }

  private ps(): void {
    if (this.perfOn) this.perfStack.push(performance.now());
  }
  /** Arm or disarm the perf beacon from the settings panel, and remember it —
   *  the installed app cannot be given a query parameter. Arming also turns on
   *  the section timers the report is built from; disarming turns them off so
   *  nobody pays for measurement they are not sending. */
  private togglePerfBeacon(): void {
    // TURNING OFF: send what has accumulated first, or the last window — the
    // one he just finished reproducing something in — is thrown away.
    if (this.perfBeacon) this.perfBeaconSend(performance.now(), true);
    this.perfBeacon = !this.perfBeacon;
    this.perfOn = this.perfBeacon;
    this.perfBeaconAt = 0;
    this.perfBeaconFrom = null;
    this.perfAcc = {};
    this.perfFrames = [];
    this.perfStack = [];
    this.perfLast = 0;
    try {
      localStorage.setItem("ml-perf-beacon", this.perfBeacon ? "1" : "0");
    } catch {
      /* storage blocked: the toggle still holds for this session */
    }
    this.chat.addLog("—", this.perfBeacon ? "perf beacon ON — run around for a minute" : "perf beacon off");
  }

  /** One beacon tick: every PERF_BEACON_MS, if the player has moved, post the
   *  window's numbers and start a new one. Everything it reports is what
   *  `__ml.perf()` already computes, so the beacon adds no measurement cost of
   *  its own — only the section timers `?perf=1` already turned on. */
  private perfBeaconTick(now: number): void {
    if (!this.perfBeaconAt) {
      this.perfBeaconAt = now;
      this.perfBeaconFrom = this.mePos();
      if (!this.perfHideHooked) {
        this.perfHideHooked = true;
        /* BACKGROUNDING IS A FLUSH TOO. He plays from an installed app and
         * leaves by swiping it away, which fires visibilitychange and nothing
         * else — `pagehide`/`unload` are unreliable on mobile. The POST already
         * carries keepalive, which is what lets it outlive the hidden page. */
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "hidden" && this.perfBeacon) {
            this.perfBeaconSend(performance.now(), true);
          }
        });
      }
      return;
    }
    if (now - this.perfBeaconAt < PERF_BEACON_MS) return;
    this.perfBeaconSend(now, false);
  }

  /** Send the window that has accumulated so far, and start a new one.
   *
   *  `final` is the flush: switching the beacon OFF, or the app going to the
   *  background, would otherwise DISCARD the window in progress — and that is
   *  routinely the interesting one, because he turns the beacon off right after
   *  reproducing whatever he was chasing (his point, 2026-09-03). A final flush
   *  drops the "have you moved" gate: at that moment even a short or stationary
   *  window is the last thing he saw, and `keepalive` is what lets it survive
   *  the page being hidden or torn down. */
  private perfBeaconSend(now: number, final: boolean): void {
    const from = this.perfBeaconFrom;
    const at = this.mePos();
    const secs = (now - this.perfBeaconAt) / 1000;
    this.perfBeaconAt = now;
    this.perfBeaconFrom = at;
    if (secs < 1) return; // nothing has accumulated worth a commit
    // MOVED? A stationary window says nothing about the lag he reports while
    // running, and would evict a useful report from the file's tail. A FINAL
    // flush is exempt — see above.
    if (!final && (!from || !at || Math.hypot(at.x - from.x, at.y - from.y) < 2)) return;
    let snap: Record<string, unknown> | null = null;
    try {
      snap = (window as unknown as { __ml?: { perf?: () => Record<string, unknown> } }).__ml?.perf?.() ?? null;
    } catch {
      snap = null;
    }
    if (!snap) return;
    const sec = snap.sections as Record<string, { totalMs?: number }> | undefined;
    const perFrame: Record<string, number> = {};
    const frames = (snap.frames as { n?: number } | undefined)?.n || 1;
    for (const [k, v] of Object.entries(sec ?? {})) perFrame[k] = +(((v?.totalMs ?? 0) / frames)).toFixed(3);
    const cam = this.cameras.main;
    const body = {
      build: assetIndexInfo().buildSha,
      where: at ? `${at.x.toFixed(1)},${at.y.toFixed(1)}` : "unknown",
      tod: TIME_PHASES[this.timeIdx].name,
      zoom: cam.zoom,
      dpr: window.devicePixelRatio || 1,
      view: `${this.scale.width}x${this.scale.height}`,
      secs: +secs.toFixed(1),
      final,
      frames: snap.frames,
      sections: perFrame,
      counts: { ...(snap.counts as Record<string, number>), texturesAdded: snap.texturesAdded as number },
      ground: this.groundTexelReport(final),
      /* THE DISCRIMINATOR. On a flush, sample the texture, then FORCE a full
       * repaint and sample it again. The zigzag is in the ground texture (his
       * crop shows it), but nothing offline reproduces it: clean tiles tile
       * with zero holes, and so do clean mixed with conform. So either the
       * SCROLL/band/cell-repaint machinery puts the gaps there — in which case
       * a full repaint wipes them — or the base painting does, and they
       * survive. Two numbers, one answer, and no more of my theories. */
      groundFull: final ? this.groundAfterFullPaint() : null,
      worst: (() => {
        try {
          const h = (window as unknown as { __ml?: { hitch?: () => { worst?: unknown[] } } }).__ml?.hitch?.();
          return h?.worst?.slice(0, 5) ?? null;
        } catch {
          return null;
        }
      })(),
    };
    // Fire and forget: a failed report must never disturb the frame it rode on.
    void fetch("/api/perf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  }

  /** THE GROUND TEXTURE, SAMPLED ON HIS DEVICE — the render half of the beacon.
   *
   *  The zigzag is a lattice of dark texels on the tile grid that the harness
   *  has never once reproduced, because the harness walks ~1 cell per 24 s and
   *  so never runs the paths that only fire on fresh terrain. His phone runs
   *  them constantly. This reads a bounded block straight off the ground render
   *  target with gl.readPixels — NOT through DynamicTexture.snapshot, whose
   *  framebuffer branch returns the image unflipped and cost a wrong diagnosis
   *  today — classifies each texel, and reports WHERE the dark ones sit modulo
   *  the 64x28 tile lattice. A lattice shows up as a few (dx,dy) bins holding
   *  nearly all the hits; scattered art detail does not.
   *
   *  Bounded on purpose: one 256x192 block, once per beacon window, is ~49k
   *  texels — a readback he will not feel, against a full-texture snapshot he
   *  would. */
  private groundTexelReport(wantPng: boolean): Record<string, unknown> | null {
    const rt = this.groundRT;
    const r = this.game.renderer as unknown as {
      gl?: WebGLRenderingContext;
      pushFramebuffer?: (fb: WebGLFramebuffer, u?: boolean, s?: boolean) => void;
      popFramebuffer?: () => void;
    };
    /* THE FRAMEBUFFER LIVES ON THE DYNAMIC TEXTURE, not on the game object.
     * `groundRT` is a RenderTexture (an Image); its DynamicTexture is
     * `rt.texture`, and that is what owns `renderTarget`. Reaching for
     * `rt.renderTarget` silently returned undefined and the whole sample came
     * back null — his first run carried no ground data at all because of it. */
    const fb = rt
      ? (rt.texture as unknown as { renderTarget?: { framebuffer?: WebGLFramebuffer } })?.renderTarget?.framebuffer
      : undefined;
    if (!rt || !r?.gl || !fb || !r.pushFramebuffer || !r.popFramebuffer) {
      return { unavailable: `rt=${!!rt} gl=${!!r?.gl} fb=${!!fb} push=${!!r?.pushFramebuffer}` };
    }
    const gl = r.gl;
    const W = Math.min(256, rt.width);
    const H = Math.min(192, rt.height);
    const x0 = Math.max(0, Math.floor((rt.width - W) / 2));
    const y0 = Math.max(0, Math.floor((rt.height - H) / 2));
    const px = new Uint8Array(W * H * 4);
    try {
      r.pushFramebuffer(fb, false, false);
      gl.readPixels(x0, y0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      r.popFramebuffer();
    } catch {
      try { r.popFramebuffer(); } catch { /* already popped */ }
      return null;
    }
    // The fill this texture is painted over, and "much darker than the local
    // median" — the dots read as one or the other depending on the ground.
    let fill = 0;
    let dark = 0;
    let clear = 0;
    const bins: Record<string, number> = {};
    const sums = new Int32Array(W * H);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) sums[j] = px[i] + px[i + 1] + px[i + 2];
    const sorted = Int32Array.from(sums).sort();
    const med = sorted[sorted.length >> 1];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const j = y * W + x;
        const i = j * 4;
        if (px[i + 3] === 0) { clear++; continue; }
        const isFill = px[i] === 0x18 && px[i + 1] === 0x1c && px[i + 2] === 0x28;
        const isDark = sums[j] < med - 150;
        if (!isFill && !isDark) continue;
        if (isFill) fill++;
        if (isDark) dark++;
        // gl.readPixels is bottom-up, so give the bin in TEXTURE space.
        const tx = (x0 + x) % 64;
        const ty = (rt.height - 1 - (y0 + y)) % 28;
        const k = `${tx},${ty}`;
        bins[k] = (bins[k] ?? 0) + 1;
      }
    }
    const top = Object.entries(bins).sort((a, b) => b[1] - a[1]).slice(0, 10);
    /* AND, ON A FINAL FLUSH, A PICTURE OF IT.
     *
     * Counts located the artefact — fill-coloured texels at the tile diamond's
     * tips — but they cannot show its SHAPE, and every shape I have inferred
     * from a phone screenshot today has been wrong, because a screenshot is the
     * texture after zoom, lighting and whatever the panel drew. A 128x112 crop
     * of the texture ITSELF is four tiles across and four down: enough to see
     * whether the tips are missing, and small enough (a few KB of PNG) to ride
     * in a JSON commit. Only on the flush, never per window. */
    let png: string | null = null;
    if (wantPng) {
      try {
        const cw = Math.min(128, W);
        const ch = Math.min(112, H);
        const cv = document.createElement("canvas");
        cv.width = cw;
        cv.height = ch;
        const g2 = cv.getContext("2d");
        if (g2) {
          const id = g2.createImageData(cw, ch);
          for (let y = 0; y < ch; y++) {
            // readPixels is bottom-up; flip so the crop reads like the texture.
            const src = (H - 1 - y) * W * 4;
            const dst = y * cw * 4;
            for (let x = 0; x < cw * 4; x++) id.data[dst + x] = px[src + x];
          }
          g2.putImageData(id, 0, 0);
          png = cv.toDataURL("image/png");
          if (png.length > 24000) png = null; // never bloat the committed file
        }
      } catch {
        png = null;
      }
    }
    return {
      png,
      rt: `${rt.width}x${rt.height}`,
      block: `${W}x${H}@${x0},${y0}`,
      anchor: `${Math.round(rt.x)},${Math.round(rt.y)}`,
      mode: this.groundLastMode,
      cellRuns: this.groundCellStats.runs,
      medianSum: med,
      /* PLACEMENT INTEGRITY — the maintainer's hypothesis, under test. How many
       * ground ops were placed on a FRACTIONAL texel, and whether the texture's
       * own anchor and position are whole. A tile diamond meets its neighbours
       * along a 2:1 staircase with ONE texel of overlap, so half a texel of
       * placement error opens a gap on some rows and not others — his "rounding
       * error that sometimes creates an extra gap". Zero on this machine; his
       * device is the only one that can say otherwise, which is the whole point
       * of reporting it rather than shipping another silent guess. */
      nonInt: this.groundNonInt,
      /* THE TOP-FACE TEXTURE HIS DEVICE ACTUALLY BUILT. A liquid draws
       * top-face-only: 924 opaque px over 29 rows, the wall stripped. If HIS
       * build carries more rows, the wall is in the texture and every correct
       * placement in the world cannot help — which would explain the 146 px of
       * water WALL colour (76,138,152) his last sample carried along the tile
       * edges. Mine measures 924/29; this is the one thing about his that I
       * have never measured. */
      topFace: (() => {
        try {
          const k = Object.keys(this.textures.list).find((n) => n.startsWith("t3f:"));
          if (!k) return "none";
          const src = this.textures.get(k).getSourceImage() as CanvasImageSource & { width: number; height: number };
          const cv = document.createElement("canvas");
          cv.width = src.width;
          cv.height = src.height;
          const g2 = cv.getContext("2d");
          if (!g2) return "no-ctx";
          g2.clearRect(0, 0, cv.width, cv.height);
          g2.drawImage(src, 0, 0);
          const dd = g2.getImageData(0, 0, cv.width, cv.height).data;
          let opaque = 0;
          let rows = 0;
          let last = -1;
          for (let y = 0; y < cv.height; y++) {
            let n = 0;
            for (let x = 0; x < cv.width; x++) if (dd[(y * cv.width + x) * 4 + 3] > 0) n++;
            if (n) {
              rows++;
              last = y;
              opaque += n;
            }
          }
          return `${cv.width}x${cv.height} opaque=${opaque} rows=${rows} lastRow=${last} (expect 924/29/28)`;
        } catch {
          return "err";
        }
      })(),
      anchorFrac: this.groundAnchor
        ? +(Math.abs(this.groundAnchor.ax % 1) + Math.abs(this.groundAnchor.ay % 1)).toFixed(3)
        : -1,
      rtPosFrac: +(Math.abs((this.groundRT?.x ?? 0) % 1) + Math.abs((this.groundRT?.y ?? 0) % 1)).toFixed(3),
      fill,
      dark,
      clear,
      topBins: top.map(([k, n]) => `${k}:${n}`),
    };
  }

  /** Force a full ground repaint and re-sample the texture — see groundFull.
   *  Costs one paint, on a flush only, on a device that is about to stop
   *  reporting anyway. */
  private groundAfterFullPaint(): Record<string, unknown> | null {
    try {
      this.t3flushSlices();
      this.lastGround = { x: NaN, y: NaN }; // poison the latch: the next pass is FULL
      this.redrawGround();
      return this.groundTexelReport(true);
    } catch {
      return null;
    }
  }

  /** The local player's cell, or null before the join lands. */
  private mePos(): { x: number; y: number } | null {
    const m = this.avatars.get(this.room?.sessionId ?? "");
    if (!m) return null;
    return { x: m.sprite.x / CELL_WU, y: m.sprite.y / CELL_WU };
  }

  private pe(key: string): void {
    if (!this.perfOn) return;
    const t0 = this.perfStack.pop();
    if (t0 === undefined) return;
    const d = performance.now() - t0;
    const a = (this.perfAcc[key] ??= { n: 0, ms: 0, max: 0 });
    a.n++;
    a.ms += d;
    if (d > a.max) a.max = d;
    if (this.hitchOn) this.hitchSec[key] = (this.hitchSec[key] ?? 0) + d;
  }
  /** The "Connecting…" creep — see the bar bands. */
  private connectCreep: Phaser.Time.TimerEvent | null = null;
  private sceneryArtCounting = false;
  private sceneryRoofedDrawn = 0; // roofed pieces the last rebuild actually drew
  private sceneryManifestTimer: Phaser.Time.TimerEvent | null = null; // a manifest-landed rebuild is pending
  /** games2/config/scenery-bbox.json, or null until it lands. */
  private sceneryBboxDoc: SceneryBboxDoc | null = null;
  /** live/tuning/scenery_hitbox.json `.overrides`, or null until it lands. */
  private sceneryHitboxDoc: Record<string, SceneryHitboxRec> | null = null;
  // Terrain (elevation + surface) — same grid the server uses, so prediction matches.
  private terrain: TerrainGrid | null = null;
  // ---- INDOOR MODE (see the constants block above) ------------------------
  // ONE state, the LOCAL player's. Every consumer the renderer has is a
  // singleton — one ground RenderTexture, one occluder set, one ambient
  // uniform, one "the outside is black" decision about MY room — so a
  // per-avatar boolean would have nothing to drive. The one place per-body
  // really differs is the torch day-gate, and that is answered by an O(1)
  // `indoorContains` lookup into MY space's roof set (no second flood fill).
  private indoorSpace: IndoorSpace | null = null;
  // NAMED PLACES (maps2 places.json): which labelled room the player is in,
  // and the last value handed to the composer. Null until the file loads, and
  // null forever for a world that names nothing — both mean "outdoors".
  private places: PlaceLookup | null = null;
  private placeNow: string | null = null;
  private indoorInside = false; // the APPLIED verdict the renderer obeys
  private indoorPending = false; // verdict waiting on the dwell timer
  private indoorKey = -1; // canonical space id = min(roof); -1 = none
  private indoorFlipAt = -Infinity; // time.now of the last applied transition
  private indoorMix = 0; // 0..1 eased light blend toward INDOOR_AMBIENT
  /** Per-cell render verdict for the current space: cellIndex → IN_ROOF |
   * IN_WALL. A cell that is ABSENT is outside and draws nothing.
   * Rebuilt only when the space (or its cut level) changes. */
  private indoorMask: Map<number, number> | null = null;
  /** The room's LIGHT mask. Same contents as `indoorMask` while you are inside,
   * but it OUTLIVES the verdict by one 0.35s roll: geometry snaps back the
   * frame you step out (the roof returns, every column is untruncated again)
   * while the light is still rolling, and a room that stopped existing mid-roll
   * would hand the whole world the interior's own grade for that quarter
   * second — which is exactly the flash the maintainer reported walking out of
   * a house at night. Everything keyed on "is this outside MY room?" reads THIS,
   * not indoorMask: the shader mask, the point-light filter, and the chrome
   * that draws above the darkness overlay. Dropped in easeIndoorMix. */
  private roomMask: Map<number, number> | null = null;
  /** cell -> 1 when it is sealed inside a ROOM, 0 when it is not (open sky, a
   * bridge, an arch). Filled a whole space at a time by inHiddenRoom; cleared
   * when the world changes, which is the only thing that can invalidate it. */
  private roomCellMemo = new Map<number, number>();
  /** cell -> depth from the nearest entrance, for every ROOM in the world.
   * Built once per world (buildCaveDepth) and published to the light in the
   * room mask's green channel. */
  private caveDepth: Map<number, number> | null = null;
  /** cell -> the room ceiling's UNDERSIDE level. Everything below it is the
   * opening you see through; everything above is the slab's face, i.e. rock. */
  private caveUnder = new Map<number, number>();
  private indoorMaskSig = ""; // what indoorMask was built for (space key + cut)
  /** The room's CEILING level — the slab's UNDERSIDE over the player's own
   * cell, i.e. `deckBot`, NOT `IndoorSpace.roofLevel` (the slab's TOP). The two
   * differ by the slab's thickness and the gap is the whole wall height:
   * measured on the_island2, the house is level 6 / thickness 0 (ceiling 6 ==
   * roofLevel), but every one of the cave's 12 decks is level 24-40 with
   * thickness 16-32 and they ALL have deckBot 8 — a uniform 8-level (128px)
   * void. Cutting the cave's walls at roofLevel 24 would leave 16 levels of
   * rock standing above a ceiling that is no longer drawn.
   *
   * Since the dial became a wall height measured UP from the floor, this is no
   * longer what the cut is derived FROM — it is the CLAMP (a wall taller than
   * its own room would seal the box again) and the "am I above the room?" line
   * for bodies and flyers. */
  private indoorCeil = 0;
  /** THE CUT — the highest level any column of the WORLD still draws while
   * indoors: `min(roomFloor + indoorWall(), indoorCeil)`. Everything above it
   * is simply not drawn, which is what takes the roof off AND what shortens the
   * walls, in one rule. Kept beside `indoorCeil` rather than replacing it
   * because the two mean different things and both have consumers — the CEILING
   * decides what counts as being IN the room, while THIS decides what is
   * painted. */
  private indoorTop = 0;
  /** THE PER-WALL RAISE (maintainer 2026-08-13: "make the current wall height
   * a MINIMUM setting... draw the walls all the way to the roof on sides where
   * it's possible; some walls might be able to be drawn higher, but not all
   * the way, and that's ok too — as tall as they can be before they intersect
   * with another floor"). cell → the level that cell's column draws to, for
   * exactly the cells of MY building that may rise PAST the scalar `indoorTop`
   * — a wall rises until one more level would start covering a protected
   * floor (any verdict-passing room's floor or entrance, my own included) that
   * lies up-screen of it. Near walls stay at the dial (their own room's floor
   * is right behind them — the dial is the minimum, never reduced); far and
   * side walls rise to the ceiling clamp. null = no raise anywhere (the flat
   * scalar cut — also the QA kill switch's state). Every consumer of
   * `indoorTop` goes through `cutAt`. */
  private indoorCut: Map<number, number> | null = null;
  /** QA kill switch (`__ml.indoorRaise(false)`) — flat scalar cut everywhere,
   * so a gate can diff raise-on/raise-off frames. Not persisted: the raise is
   * the design, not a preference. */
  private indoorRaiseOn = true;
  /** QA pin for the indoor light blend (see easeIndoorMix) — null = live. */
  private indoorMixPinV: number | null = null;
  /** THE TRANSITION DEBRIS (maintainer 2026-08-13, hard task #1: the roof
   * "pops on a single frame... I want this to feel more fade in/fade out").
   * The art the cut REMOVES — my roof slab, the wall bands above each cell's
   * cut, the covering cone's tops — re-issued as world-anchored images at the
   * occluder depths, alpha = debrisAlpha() (3× curves). Entering: the world
   * repaints to the cut state on the flip frame, but the debris is OPAQUE on
   * that frame, so the picture is unchanged — then it dissolves by mix ⅓,
   * while the light grade keeps rolling to ⅔. Leaving: the world KEEPS
   * drawing the cut state, the debris fades back IN over it, and the real
   * repaint happens when the light GRADE lands (mix ⅓) — the debris has been
   * opaque since mix ⅔, so the swap is invisible. Per-image depths keep bodies sorting correctly through the
   * whole fade (a body under the returning roof is covered by it, exactly as
   * outdoors). Null between transitions; never built for the kill-switch's
   * legacy scalar cut (QA wants instant frames). */
  private indoorDebris: Phaser.GameObjects.Image[] | null = null;
  private indoorAtCol = NaN; // the (cell, surface elev) the cached space is for
  private indoorAtRow = NaN;
  private indoorAtElev = NaN;
  private indoorDirty = true; // world load / teleport: force the next recompute
  private indoorFlips = 0; // QA: applied transitions (hysteresis is assertable)
  private indoorComputes = 0; // QA: findIndoorSpace calls (never per frame)
  // Streaming ground renderer state.
  private groundRT?: Phaser.GameObjects.RenderTexture;
  /* THE GROUND SCROLL — see scrollTiles3Ground. A second texture to scroll
   * into (the two swap roles every scrolled redraw), the anchor + indoor state
   * of the picture the visible one holds (null = nothing valid: a full paint is
   * due), the band a scrolled pass clips its ops to, and the A/B switch. */
  private groundScratch?: Phaser.GameObjects.RenderTexture;
  private groundAnchor: { ax: number; ay: number; mask: Map<number, number> | null; top: number } | null = null;
  private groundClip: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** Ground ops whose placement was NOT a whole texel — see t3Blit. Zero on
   *  this machine; the maintainer's device is the one that can say otherwise. */
  private groundNonInt = 0;
  /** The slice size in force, steered toward GROUND_SLICE_MS by what slices
   *  actually cost on THIS device (see t3paintSliceStep). */
  private groundSlicePx = GROUND_SLICE_PX;
  /** What one prefetch composition costs on THIS device (ms, EMA), and how many
   *  frames have passed since the last one — see GROUND_RING_COMPOSE_EMA. */
  private ringComposeMs = 0;
  private ringSinceCompose = 0;
  /* THE GROUND PATH, SWITCHABLE FROM THE PHONE. `?ground=legacy` turns the
   * whole 2026-09-02/03 ground rework off — no scroll, no sliced band, no
   * landing repaints, no prefetch: every camera latch paints the texture in
   * full, exactly as it did before that work. It is a BISECT the maintainer can
   * run in one page load: if an artefact survives `?ground=legacy` it is not
   * from the rework, and if it vanishes it is. Remembered in localStorage
   * (`ml-ground-path`) so it survives the reload; `?ground=fast` restores. */
  private groundScroll = groundPathFast();
  private groundLastMode: "full" | "scroll" | "cells" = "full";
  /* THE LANDING REPAINT + THE PREFETCH RING — see onTerrainBatch, repaintTiles3Cells,
   * t3prefetchStep. Which window cells wanted which missing file (rebuilt by every
   * full paint, extended by band paints); the cells a landed batch made drawable;
   * the ring of cells beyond the texture whose art is asked for ahead of time. */
  private t3missing = new Map<string, Set<number>>();
  /** A paint DROPPED at least one op (its texture was not registered) and the
   *  loader has not gone idle since. THE GUESS, shipped at the maintainer's
   *  explicit request ("PLEASE PUSH YOUR GUESS! we might be able to save time
   *  if it works"): a dropped op leaves the render texture's background showing
   *  and nothing is guaranteed to come back for it — t3missing only remembers
   *  ops whose FILE is still coming, so a drop for any other reason (a
   *  tombstoned 404, a composition that returned null, a resolution cached as
   *  empty) is permanent, through every full paint, which is exactly what he
   *  photographs while standing still. When the loader finally goes idle, repaint
   *  once. Bounded by construction: it fires at most once per idle transition. */
  private groundDropsPending = false;
  private t3sheetPaths = new Set<string>();
  private groundDirtyCells: number[] = [];
  private repaintGroundPartial = false;
  private groundPartial = groundPathFast();
  private groundPrefetch = groundPathFast();
  private t3ringQueue: [number, number][] = [];
  private t3ringAt = 0;
  /** The grown window's cell INDICES, for the prune — see t3armRing. */
  private t3keepIdx: Set<number> | null = null;
  /* THE SLICED BAND — see t3paintSliceStep. */
  private groundSliceQ: { x0: number; y0: number; x1: number; y1: number }[] = [];
  private groundSliceCtx: { ax: number; ay: number; mask: Map<number, number> | null; cuts: Map<number, number> | null; top: number } | null = null;
  private groundSliceStats = { runs: 0, slices: 0, ms: 0, flushes: 0 };
  /** The last anchor shift — the direction the world is travelling, which is
   *  the only direction worth prefetching (t3armRing). */
  private groundLastShift = { x: 0, y: 0 };
  private groundSliced = groundPathFast();
  private groundRedrewThisFrame = false;
  private worldUp = false;
  /** When the boot hold's readiness condition first became true — see
   *  hideLoadingWhenTerrainIsUp. 0 while not ready. */
  private holdReadySince = 0;
  private groundCellStats = { runs: 0, full: 0, cells: 0, ms: 0 };
  /** DEV: the last landing repaint's stamp rect and grown clip rect. */
  private groundLastRect: unknown = null;
  /** DIAGNOSTIC ring: the last scrolls' (prevAx, prevAy, ax, ay, sx, sy). */
  private groundScrollLog: number[][] = [];
  // Chase-cam state: eased world centre + eased zoom; detached while a debug
  // lookAt holds the camera elsewhere.
  private camChase = { x: 0, y: 0, zoom: 0, init: false };
  private camDetached = false;
  private lastGround = { x: NaN, y: NaN };
  private maxLevel = 0;
  // The TERRAIN maximum alone. `maxLevel` above is lifted by deck slabs so the
  // streamed window and the shader ray cover them; the map-image origin is not
  // — BOTH map renderers take their headroom from the level grid only
  // (render2 `_origin`, render3 `render`), so the Map tab's dot reads this.
  private terrainMaxLevel = 0;
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
    /** THE FOG SILHOUETTE — see applyObjectLights. Lazily made, same crop/flip/box. */
    fog?: Phaser.GameObjects.Image;
    /** The FOOT POINT on screen (world px) the fog is read at — nightlight.depthFogAtFoot. */
    bx: number;
    by: number;
    /** Its own painter depth (the base image's), for the cover test. */
    pd: number;
    /** THE COVER LINE the SHARED rule returned for this piece (resolveDrawDepth,
     *  the same call bodies make). Infinity = uncovered; set once per rebuild. */
    cover?: number;
  }[] = [];
  private occluderMeta: {
    col: number;
    row: number;
    top: number; // column's top level
    solid: boolean; // impassable structure — its tall art is a billboard
    /** POINT-ANCHORED (scenery): `depth` is the published hitbox centre's own
     *  painter line, so "is it in front of me" is that against the body's nadir
     *  line — exact, and not the grid diagonal with its cell-sized slack. */
    point?: boolean;
    depth: number;
    /** Where the thing is actually DRAWN, when that differs from its anchor
     *  line: a scenery piece is LIFTED over the tiles it overlaps (the shared
     *  rule's `above`), and a body that must pass in front of it has to clear
     *  what is drawn, not the anchor. Terrain draws at its anchor and leaves
     *  this undefined. NEVER fold this into `depth` — `depth` answers "is it
     *  in front of me", and a lifted value there reads a body standing in
     *  FRONT of a tree as standing behind it (maintainer 2026-09-03: "when I
     *  stand under this tree the player's head is not visible"). */
    drawDepth?: number;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  }[] = [];
  private lastOccl = { x: NaN, y: NaN };
  /** Dev switch for A/B measurement of destroyBatch's two paths (`__ml.occRebuild`);
   *  nothing in play reads it. */
  private occFastDestroy = true;
  /** Pure-JS cost of the last rebuild's destroy pass(es), for the probe. */
  private occDestroyMs = 0;
  /* THE OCCLUDER POOL — see occImage. `occNext` holds the CURRENT set keyed by
   * everything that makes an image what it is; a rebuild moves it to `occPool`,
   * takes what it can back out, and destroys the rest. Dev switch `occPoolOn`
   * exists only for the A/B in `__ml.occRebuild`. */
  private occPool = new Map<string, Phaser.GameObjects.Image[]>();
  private occNext = new Map<string, Phaser.GameObjects.Image[]>();
  private occPoolOn = true;
  /* THE SCENERY POOL — the same two maps for the same reason; see `scnImage`.
   * ART ONLY: the lit copies and their fog silhouettes are deliberately outside
   * it, exactly as rebuildOccluders' destroy says. */
  private scnPool = new Map<string, Phaser.GameObjects.Image[]>();
  private scnNext = new Map<string, Phaser.GameObjects.Image[]>();
  private scnPoolOn = true;
  private scnReused = 0;
  private scnCreated = 0;
  private occSeq = 0;
  private occReused = 0;
  private occCreated = 0;
  // ── THE COVER SURFACES ────────────────────────────────────────────────────
  // "Covered" is not modelled, it is RASTERISED: the very occluder Images that
  // hide a body are drawn into that body's own frame grid, so a diagonal wall
  // top is diagonal, a doorway is a hole and a tree trunk covers three columns
  // — because that is what the terrain drew. Three surfaces, one slot layout:
  //   E = the body frame MINUS every covering occluder  → the LIT COPY
  //   C = the body frame MINUS E                        → the covered part
  //   O = dilate2(C) two-tone MINUS the body frame      → the WHITE OUTLINE
  // E and C are complements BY CONSTRUCTION (C is one erase of E), which is
  // what makes the lit copy and the outline structurally unable to disagree —
  // it used to rest on two call sites reading one scalar the same way.
  private coverExact = false;
  private coverE?: Phaser.Textures.DynamicTexture;
  private coverC?: Phaser.Textures.DynamicTexture;
  private coverO?: Phaser.Textures.DynamicTexture;
  private coverSlots: CoverSlot[] = [];
  private coverFree = new Map<string, CoverSlot[]>();
  private coverShelf = { x: 0, y: 0, h: 0 };
  private coverQueue: BodyVisual[] = [];
  private coverScratch?: Phaser.GameObjects.Image;
  private coverTick = 1;
  private coverSig = "";
  // Bumped by rebuildOccluders/rebuildProps — the ONLY things that move,
  // create or cull an occluder image, so it is the whole "did the terrain
  // change" term of a slot's rebuild signature.
  private coverGen = 0;
  private coverBuckets = new Map<number, Phaser.GameObjects.Image[]>();
  private coverSeen = new Set<Phaser.GameObjects.Image>();
  private coverCands: Phaser.GameObjects.Image[] = [];
  private coverStat = { slots: 0, quads: 0, brackets: 0, skips: 0, flushes: 0, cands: 0 };
  // Images the last rebuild skipped (view-culled + deck-exposure-culled) —
  // reported by __ml.occCount() so the win is measurable, not asserted.
  private occCulled = 0;
  private emissiveLights: LightSource[] = [];
  // Local jump prediction (client owns its jump timing).
  private jumpUntil = 0;
  private jumpReadyAt = 0;
  private jumpQueued = false;
  private deferredAnimsKicked = false; // action-state frames background-load once, after join
  private selfDead = false; // mirror of my own Player.dead (freezes input sending)
  /** Deferred-batch bookkeeping for MY OWN character's clips — see animReady. */
  private myAnimDebug: { queued: number; left: number; at: number | null } | null = null;
  /** The death sequence, while it runs. `armed` = the push has landed and the
   * prompt is up, so a press now asks the server to revive. */
  private death: {
    at: number;
    armed: boolean;
    askAt?: number;   // when the player FIRST asked to come back
    nextAsk?: number; // when to re-send the ask (0 = now)
    veil?: HTMLDivElement;
    el?: HTMLDivElement; // the "Press to continue..." card (DOM, screen space)
    /** The camera pose the push starts from — see startDeath. */
    from: { x: number; y: number; zoom: number };
    mode: string;
  } | null = null;
  private engagedId: string | null = null; // monster I tapped to fight (client intent)
  private pendingPickupId: string | null = null; // walk-to-item, grab on arrival
  private pickupIntentUntil = 0; // give up on a pickup intent after this
  private nextPickupSendAt = 0; // pickup re-send throttle (server race under latency)
  private lastHudSig = ""; // last hp/ep/xp/level pushed to the DOM bars
  // How the last grabbed drop was retired (round-15 gate reads it via grabInfo).
  private lastGrabRetire?: {
    frame: number; grabFrame: number | null; anim: string; via: string; heldMs: number;
  };
  private monsterRings = new Map<string, Phaser.GameObjects.Image>(); // red outlines: engaged + hunters
  private itemRingImg?: Phaser.GameObjects.Image; // blue outline on the item being fetched
  private aggroGfx?: Phaser.GameObjects.Graphics; // aggro-radius debug rings
  private aggroRadiusOn = localStorage.getItem("ml-aggro-radius") === "1";
  /** COLLISION DEBUG: paint what the body is actually held by. Asked for
   *  because the footprints are invisible and their faults are not (maintainer
   *  2026-08-30: "add a debug setting under settings so I can see the
   *  collisions, so hard for me to understand what's going on right now"), and
   *  then asked to show BOTH halves of it, because collision and navigation are
   *  no longer the same shape: "the show hitbox button should show both what
   *  the nav navigates around and the real ellipse hitbox". See
   *  drawCollisionDebug for each mark and what it means — including the bodies,
   *  which own no cell and no footprint and so are invisible to every other
   *  layer here (maintainer 2026-09-02: "should show the collision for NPCs and
   *  monsters as well"). */
  private collisionOn = localStorage.getItem("ml-collision") === "1";
  private collisionGfx?: Phaser.GameObjects.Graphics;
  /** Settings "disable aggro" — persisted here, ENFORCED on the server (the
   * proximity scan is server-side). Re-sent on every join. */
  private noAggroOn = localStorage.getItem("ml-no-aggro") === "1";
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
      // Held past the server's removal until my pickup clip reaches the frame
      // the hand closes on it (removeDrop / stepGroundDecor).
      grabbedAt?: number;
      grabFrame?: number;
      sawPickup?: boolean; // the clip has actually started (see stepGroundDecor)
    }
  >();
  private roomBoundAt = 0; // when the current room's state flood began (join vs witnessed)
  // Grave crosses (scenery/grave_cross): appear where a monster died, hold on
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
  // OPTIONAL real-light params from emission.json `lights` (tiles2-owned):
  // keyed by tile-path STEM (no extension) or material name; explicit null =
  // "stamp only, never a real light". Absent → a subtle default is derived.
  private tiles2Lights: Record<string, EmissiveLightCfg | null> = {};
  // Every emissive prop in the WORLD, resolved once per world into real-light
  // candidates. World-level on purpose: a light reaches the screen before its
  // source does, so the per-frame pick below cannot start from the visible-prop
  // set the way the stamps do.
  private emissiveSources: EmissiveSource[] = [];
  // Which world-slot holders are lit THIS frame (emissive ids + "campfire").
  // Read by the stamp filter (a slotted source's ground POOL is replaced by
  // its real light) and by the __ml.lightSlots probe.
  private slotLit = new Set<string>();
  // TENURE: who holds a world slot and how far their fade-in has come. A
  // holder keeps its slot until its pool stops touching the view — see
  // pickWorldLights.
  // ramp 0..1 (smoothstepped into the light's brightness), dir +1 fading in /
  // -1 retiring (dissolving out under slot pressure).
  private slotTenure = new Map<string, { ramp: number; dir: 1 | -1 }>();
  // Each holder's measured px-past-view edge this frame (negative = the pool
  // touches the screen). QA only: the churn gate proves releases happen at the
  // boundary, never mid-view, and it can only do that from the same numbers
  // the release rule reads.
  private slotEdges: Record<string, number> = {};
  private lastTenureStats: { waitingBest: number | null; worstSettled: number | null; retiring: string[] } = {
    waitingBest: null,
    worstSettled: null,
    retiring: [],
  };
  private lightOverflow = 0; // in-view candidates that did NOT fit the budget
  private lastSlotInfo = { torch: false, reserved: 0, total: 0 };
  // Cells of emissive props standing inside a sealed room (indoor-only light).
  private sealedEmissiveCells = new Set<number>();
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
  /** 1 while the bonfire's light counts, easing to 0 as I close a door on it.
   * Set once per frame in update(); read by everything that draws the fire
   * ABOVE the darkness overlay, which no amount of zero ambient can dim. */
  private fireRoomK = 1;
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
    this.monsterBootKinds = (this.registry.get("monsterBootKinds") as Set<string> | null | undefined) ?? null;
    this.npcManifest = (this.registry.get("npcManifest") as NpcManifest | null) ?? null;
    this.npcPlacement = (this.registry.get("npcPlacement") as NpcPlacement[] | null) ?? [];
    this.myCharacter = this.registry.get("character") as CharacterDef;
    this.myName = this.registry.get("name") as string;
    this.world = (this.registry.get("world") as World | null) ?? null;
    this.worldName = (this.registry.get("worldName") as string | undefined) ?? DEFAULT_WORLD;
    this.maps2 = !!this.world && isMaps2World(this.world);
    this.maps3 = !!this.world && isMaps3World(this.world);
    this.geom = geometryFor(this.world);
    // The maps agent's named interiors, fetched alongside the world. Async and
    // deliberately un-awaited: a world with no places.json is normal, and the
    // music must not wait on a file that may never arrive. Until it lands,
    // `places` is null and every cell reads as outdoors — which is what the
    // game did before this existed.
    void loadPlaces(this.worldName).then((p) => {
      this.places = p;
      this.indoorDirty = true; // re-answer "where am I" on the next frame
    });
    this.tileBases = (this.registry.get("tileBases") as TileBases | null) ?? null;
    if (this.world) {
      // The world's extent in world units (grid×CELL_WU) — per-world, so any
      // size renders/collides right (see shared: WORLD_WIDTH is only a default).
      this.worldW = this.world.width * CELL_WU;
      this.worldH = this.world.height * CELL_WU;
      this.terrain = buildTerrainGrid(this.world.width, this.world.height, this.world.rows, this.world.props, this.world.decks);
      /* THE SAME SCENERY FOOTPRINTS THE SERVER STAMPS, from the same function
       * and the same two documents. Prediction that disagreed with authority
       * would rubber-band the player off every tree, so this is not a second
       * implementation — it is the same one. The docs arrive asynchronously;
       * `restampScenery` re-runs it when they land. */
      this.restampScenery();
      // New grid ⇒ every cached indoor verdict is about a world that no longer
      // exists. Start outdoors and force the first recompute.
      this.indoorSpace = null;
      this.indoorMask = null;
      this.roomMask = null; // no fade to finish — this world is gone
      this.roomCellMemo.clear();
      this.caveDepth = null;
      this.indoorCut = null;
      this.destroyIndoorDebris();
      this.indoorMaskSig = "";
      this.indoorInside = false;
      this.indoorPending = false;
      this.indoorKey = -1;
      this.indoorMix = 0;
      this.indoorAtCol = NaN;
      this.indoorDirty = true;
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
    /* THE BAR MUST SPEND ITS LENGTH WHERE THE TIME GOES. For a tiles2 world
     * that is this batch — hundreds of small images out of the deployed image —
     * so it keeps 0.05..0.90. A maps3 world's terrain and scenery are NOT in the
     * image at all and stream from the CDN afterwards, which is much the longer
     * half; giving this batch the whole bar is what parked it at "100%" while
     * the real work had not started (maintainer 2026-08-29: "the loading freezes
     * on 100% for a long time"). It gets a third, and the streaming stage owns
     * the rest. */
    const art0 = this.maps3 ? BAR_ART0 : 0.05;
    const artSpan = this.maps3 ? BAR_ART1 - BAR_ART0 : 0.85;
    this.load.on("progress", (f: number) => {
      if (!this.deferredAnimsKicked) setLoadingProgress(art0 + f * artSpan, "Loading art…");
    });
    // The world's NPCs stand there from the first frame: their standing art
    // joins THIS batch (one small image per distinct character) instead of
    // starting a second loader run mid-create.
    this.preloadNpcArt();
    // characters2 stores animations as frame FOLDERS (one PNG per frame), not
    // strips — load each frame as its own texture. BOOT loads only the
    // movement states (BOOT_ANIM_STATES); the 9 action states (~800 PNGs the
    // 2026-07-29 overhaul added, nothing triggers them yet) background-load
    // AFTER the avatar is in (loadDeferredAnims) so joining stays fast.
    // MY OWN CHARACTER LEADS THE QUEUE (charsMeFirst) — the loader is FIFO, so
    // otherwise whether my art is first or last is decided by where I happen to
    // sit in characters.json.
    for (const def of this.charsMeFirst()) {
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
    // NEAR KINDS ONLY (client/src/monsterBoot.ts): a world can name every kind
    // there is (the_game: 57 — 912 strips, 5.3 MB, half of a cold boot's
    // requests), but only the kinds with a zone near where the player will
    // stand ride the boot batch. The rest queue in the deferred batch and
    // their bodies stay parked until their own strips land.
    for (const def of this.monsterManifest?.monsters ?? []) {
      if (this.monsterBootKinds && !this.monsterBootKinds.has(def.id)) {
        this.monsterDeferredKinds.add(def.id);
        continue;
      }
      this.queueMonsterBodyStrips(def);
    }
    // Isometric ground tiles.
    if (this.world) {
      if (this.maps2) {
        // maps2 world bakes an explicit tile PNG per cell + per-material face
        // tiles + placed props. Since 2026-08-15 that unique set arrives as a
        // committed atlas sheet when one exists (571 requests → 2 on
        // the_island2) and falls back to per-file loads for anything the
        // atlas cannot provide — see tileatlas.ts. Same `t2:` texture keys
        // either way; the renderer cannot tell which path ran.
        this.tileAtlas = queueTileLoads(this, this.world, this.worldName, this.game.registry.get("atlasIndex") ?? null);
      } else if (!this.maps3) {
        // The legacy category+variant worlds. A MAPS3 world must not fall in
        // here: its `t` is a ground TYPE, not a tile category, so every one of
        // these would be a 404 for art that does not exist and never did.
        for (const { t, v } of distinctTiles(this.world)) {
          this.load.image(tileKey(t, v), withV(tileUrl(t, v)));
        }
      }
      // maps2 worlds get their glow from tiles2/emission.json
      // (per-MATERIAL params + per-TILE-PATH sources — see loadTiles2Emission).
      if (this.maps2) this.load.json("tiles2-emission", withV("/assets/tiles2/emission.json"));
      if (this.maps3) {
        // MAPS3 SHIPS NO TILE ART IN THE WORLD, so there is no per-cell load
        // list to queue here — only the DOCUMENTS the resolver reads, and the
        // three pattern sheets every composed boundary blends through. The art
        // itself streams per camera window (Tiles3Loader), because the whole
        // library is 240 MB and a window needs a few hundred files of it.
        //
        // ~8 MB of JSON, of which tiles/review/manifest.json is 5.6 MB: it is
        // the x-over-y matrix and it is the ONLY source of wall art, so a maps3
        // world cannot draw a cliff without it. Acceptable because maps3 is a
        // dev world streamed from the CDN; if it ever ships, the matrix wants a
        // published subset keyed by the grounds a world actually uses.
        this.t3route = { gameUrl, withV };
        for (const [k, path] of Object.entries(TILES3_DOCS))
          this.load.json(`t3doc:${k}`, docUrl(path, this.t3route));
        // The three sheets ride the dedicated loader for the same reason the
        // plates do — and because their pixels are READ BACK, so they need the
        // crossOrigin attribute a staging join depends on.
        const l = this.tiles3Loader();
        for (const path of sheetPaths({} as PatternsDoc)) l.image(t3ArtKey(path), docUrl(path, this.t3route));
        l.once("complete", () => this.requestRepaint("terrain"));
        l.start();
      }
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
    this.initCoverSurfaces();
    this.buildAnimations();
    this.buildMonsterAnimations();
    // Slice the atlas sheets into per-path textures BEFORE anything draws:
    // the ground RT and occluder passes resolve tiles via textures.exists and
    // silently skip missing keys, so this must run ahead of them.
    this.tileAtlas?.finalize(this);
    if (this.world) {
      this.setupStreamingGround();
      // MAPS3 resolves its art at draw time, so the runtime has to exist before
      // the first redrawGround — and after setupStreamingGround, whose `iso` is
      // what the resolver's frame is built on.
      if (this.maps3) this.initTiles3();
    } else this.drawGround();
    this.placeCampfire();
    // The world's people (maps2 npcs.json). AFTER the world/projection exist —
    // projectFlat is meaningless in init(), and the registry's "world" key is
    // the parsed World OBJECT; the id lives in "worldName".
    this.spawnNpcs();

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
        | {
            materials?: EmissionMap;
            sources?: Record<string, EmissionSource[]>;
            lights?: Record<string, EmissiveLightCfg | null>;
          }
        | undefined;
      this.tiles2Mat = t2?.materials ?? {};
      this.tiles2Src = t2?.sources ?? {};
      this.tiles2Lights = t2?.lights ?? {};
      if (!t2) console.warn("[nangijala] tiles2/emission.json missing — prop glow disabled");
      this.buildEmissiveSources();
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
      // DEAD: the only thing a press does is ask to come back, and only once
      // the push has landed and the prompt is up. Before that a press is
      // swallowed — a stray tap during the fade must not skip the sequence,
      // and the server refuses it anyway until the die clip has finished.
      //
      // THIS IS CHECKED BEFORE THE UI LOCK, DELIBERATELY. The lock is there so
      // an open dialog does not also walk the player around, but it used to
      // sit in front of this branch — so ANY stale lock (a dialog torn down
      // without its onClosed, a drop cancelled through a racing gesture) left
      // "Press to continue..." on screen with every tap silently dropped until
      // the server's own PLAYER_DEATH_MAX_MS backstop three minutes later.
      // Being dead outranks every dialog: the revive press always goes through.
      if (this.selfDead) {
        if (this.death?.armed) this.askRevive();
        return;
      }
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
          const meNow = this.avatars.get(this.room!.sessionId);
          if (meNow) this.walkToGrab(meNow, d.wx, d.wy);
          else this.setMoveTarget(d.wx, d.wy, true, false, undefined, false);
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
      const down = this.pickGround(p.worldX, p.worldY);
      this.holdGround = down ? { ...down, at: { wx: p.worldX, wy: p.worldY } } : null;
      // Fresh gesture = fresh trip (hold=false: reset the sticky slow, build
      // the beacon); subsequent drag replans go through holdRepath's budget.
      if (this.holdGround)
        this.setMoveTarget(this.holdGround.x, this.holdGround.y, true, false, this.holdGround.lvl, true,
          this.holdGround.at);
      this.holdRepathAt = performance.now() + 50;
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (p.id !== this.holdPointerId || !p.isDown) return;
      const g = this.pickGround(p.worldX, p.worldY);
      if (!g) return;
      this.holdGround = { ...g, at: { wx: p.worldX, wy: p.worldY } };
      // The beacon tracks the FINGER in realtime (free — pure projection);
      // the actual findPath replan runs on holdRepath's adaptive budget, so
      // the drag never *feels* throttled even when a replan is deferred.
      if (this.tapMarker) {
        // Under the FINGER, literally — same pin as a fresh tap, so a drag can
        // never leave the beacon on a projection of the route's end instead.
        this.tapMarkerAt = { x: p.worldX, y: p.worldY };
        this.tapMarker.setPosition(p.worldX, p.worldY);
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
    this.input.keyboard!.on("keydown-SPACE", () => {
      // Dead: the jump button is the one control a thumb is already resting on
      // (it synthesizes this key), so it asks to come back too.
      if (this.selfDead) { if (this.death?.armed) this.askRevive(); return; }
      // Standing at a chess seat, the jump affordance IS the chess offer
      // (maintainer: the button reads "START/JOIN CHESSGAME"). Auto-jump
      // (maybeAutoJump) bypasses this on purpose — walking into a ledge
      // beside a board must still hop.
      if (this.chessPrompt) return void this.room?.send("chess.sit", {});
      this.tryJump();
    });
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
        // Monster spawn zones (maps2 spawns@1) — a DEBUG overlay, off by
        // default (maintainer 2026-07-30: "not visible by default").
        { label: "spawn areas", act: () => this.toggleSpawnAreas(), get: () => this.spawnAreasOn },
        // Aggro radii (combat round 2) — DEBUG rings, off by default: red =
        // a predator's proximity radius, gold = the provoke radius on the
        // sword-marked target.
        { label: "aggro radius", act: () => this.toggleAggroRadius(), get: () => this.aggroRadiusOn },
        /* THE COLLISION OVERLAY — the maintainer's "show hitbox button". Both
         * layers at once: the cells the nav plans around AND the real footprint
         * ellipses the body collides with (see drawCollisionDebug). */
        { label: "collision (hitbox)", act: () => this.toggleCollision(), get: () => this.collisionOn },
        /* SHADOWS: on / off / RED — the maintainer's instrument for telling a
         * SHADOW from a TILE (2026-09-03, on the dotted zigzag: "make a
         * settings button that switches between shadows enabled, disabled, red
         * shadows. This will make it easy to see what is a shadow and what is
         * a tile"). A line that SURVIVES "off" is painted into the ground
         * texture; a line that turns RED is the light pass. It settles in one
         * tap what I spent a day inferring from screenshots. */
        {
          label: "shadows",
          act: () => {
            const n = this.night;
            if (!n) return;
            n.shadowDbg = (n.shadowDbg + 1) % 3;
            this.chat.addLog("—", `shadows: ${["on", "OFF", "RED"][n.shadowDbg]}`);
          },
          get: () => !!this.night && this.night.shadowDbg !== 0,
          state: () => ["on", "off", "red"][this.night?.shadowDbg ?? 0],
        },
        /* OVERLAYS — the same idea as the shadows switch, for the three
         * full-screen passes. The zigzag is NOT in the ground texture (exact
         * unlit palette census at his cell and zoom: zero wall-coloured
         * texels), so it is painted downstream. Each tap removes one pass:
         * all -> no depth-fog -> no mist -> no light. The step where the line
         * disappears names the pass; a line that survives "none" is the
         * texture reaching the display, not the lighting. Four taps instead of
         * four deploys. */
        {
          label: "overlays",
          act: () => {
            const n = this.night;
            if (!n) return;
            n.dbgOverlays = (n.dbgOverlays + 1) % 4;
            this.chat.addLog("—", `overlays: ${["all", "no depth-fog", "no mist", "NONE"][n.dbgOverlays]}`);
          },
          get: () => !!this.night && this.night.dbgOverlays !== 0,
          state: () => ["all", "no fog", "no mist", "none"][this.night?.dbgOverlays ?? 0],
        },
        /* DROPPED OPS, PAINTED MAGENTA. The maintainer's artefact is bare
         * ground fill inside the painted field on a FULL paint, and neighbours
         * overlap by 32 rows, so the only way to expose the background is a
         * tile that never drew — which `opsForCell` has always done silently.
         * This paints those spots magenta instead. A zigzag that turns MAGENTA
         * is dropped ops and the cause is a missing texture; one that stays
         * dark is not, and that kills this whole line of enquiry in one tap.
         * His idea, from the pink-background test. */
        {
          label: "clear: pink",
          act: () => {
            this.groundClearPink = !this.groundClearPink;
            this.chat.addLog("—", `ground clear: ${this.groundClearPink ? "MAGENTA" : "normal"} — magenta means NOTHING painted there`);
            this.repaintWorld();
          },
          get: () => this.groundClearPink,
          state: () => (this.groundClearPink ? "pink" : "off"),
        },
        {
          label: "transitions",
          act: () => {
            this.noTransitions = !this.noTransitions;
            this.chat.addLog("—", `transition tiles: ${this.noTransitions ? "OFF — cells draw their own plates" : "on"}`);
            this.repaintWorld();
          },
          get: () => !this.noTransitions,
          state: () => (this.noTransitions ? "off" : "on"),
        },
        {
          label: "dropped ops",
          act: () => {
            const t = this.t3tex;
            if (!t) return;
            t.debugDrops = !t.debugDrops;
            this.chat.addLog("—", `dropped ops: ${t.debugDrops ? "MAGENTA" : "hidden"} (dropped so far: ${t.droppedOps})`);
            this.repaintWorld();
          },
          get: () => !!this.t3tex?.debugDrops,
          state: () => (this.t3tex?.debugDrops ? "magenta" : "off"),
        },
        /* THE PERF BEACON, as a BUTTON — because the maintainer plays from an
         * INSTALLED HOME-SCREEN APP, which has no address bar, so `?perf=1`
         * cannot be typed there at all (his question, 2026-09-03). Same law as
         * the repo's ops rule: a step that needs a URL he cannot enter will not
         * happen. The switch is the same localStorage key the query param sets,
         * so either route works and the app remembers it across launches. */
        {
          label: "perf beacon",
          act: () => this.togglePerfBeacon(),
          get: () => this.perfBeacon,
          state: () => (this.perfBeacon ? "reporting" : "off"),
        },
        // Disable aggro (maintainer 2026-08-07: "I will use this feature to
        // test walk around in the cave without dying"). Server-side and per
        // player — see the "noaggro" handler in WorldRoom.
        { label: "disable aggro", act: () => this.toggleNoAggro(), get: () => this.noAggroOn },
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

    setLoadingProgress(this.maps3 ? BAR_ART1 : 0.95, "Connecting…");
    /* A BAR THAT STANDS STILL READS AS A HANG. This stage — matchmake, the
     * join, the first state — publishes nothing to count, and it is ~10% of a
     * maps3 boot. So the bar creeps across its own band on an exponential that
     * approaches BAR_CONNECT1 without arriving: it can never overtake the
     * streaming stage that follows (which starts exactly there), and it cannot
     * promise a finish it does not know about. Cleared when the world starts
     * streaming, and by shutdown. */
    if (this.maps3) {
      const t0 = performance.now();
      this.connectCreep?.remove();
      this.connectCreep = this.time.addEvent({
        delay: 100,
        loop: true,
        callback: () => {
          const f = 1 - Math.exp(-(performance.now() - t0) / BAR_CONNECT_TAU_MS);
          setLoadingProgress(BAR_ART1 + (BAR_CONNECT1 - BAR_ART1) * f, "Connecting…");
        },
      });
      this.events.once("shutdown", () => { this.connectCreep?.remove(); this.connectCreep = null; });
    }
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

    // The Settings "Indoor wall cut" slider changes GEOMETRY, so unlike the
    // indoor LIGHT dial (read fresh every frame in ambEff, and free) it has to
    // invalidate the mask and repaint. Clearing the signature is what forces
    // the rebuild — refreshIndoorMask is otherwise a no-op while you stand in
    // one room, which is the whole point of it.
    window.addEventListener("ml-indoor-wall", () => {
      if (!this.indoorInside) return; // outdoors there is nothing cut to redraw
      this.indoorMaskSig = "";
      if (this.refreshIndoorMask()) this.repaintWorld();
    });

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
        // The map images are ISO renders, so hud.ts needs maxL (both renderers
        // lift the canvas origin by the world's tallest level) and the player's
        // own cell level (the dot lifts with the terrain it stands on). `iso`
        // says WHICH renderer drew it — maps.ts branches the projection and the
        // filename on it. Clamp the cell index — fx/fy can ease past the rim.
        const ci = w ? Math.max(0, Math.min(w.width - 1, Math.floor(col))) : 0;
        const ri = w ? Math.max(0, Math.min(w.height - 1, Math.floor(row))) : 0;
        return {
          world: this.worldName,
          w: w?.width ?? 0,
          h: w?.height ?? 0,
          maxL: this.terrainMaxLevel,
          col,
          row,
          level: w?.rows[ri]?.[ci]?.l ?? 0,
          iso: w?.iso,
        };
      },
      /** INDOOR MODE — the whole verdict, for gate assertions.
       *
       * `indoor` is what the renderer obeys; `pending` differs only while the
       * dwell timer holds a flip. The raw module fields are exposed so a gate
       * can assert WHY a verdict came out the way it did (a space that failed
       * on `capped` and one that failed on `wallRatio` are very different
       * bugs), and the two COUNTERS make the two performance/robustness claims
       * assertable rather than merely asserted: stand still for 200 frames and
       * `computes` must not move (the fill is not per-frame); walk a doorway
       * back and forth ten times and `flips` must not track your steps (the
       * hysteresis holds).
       *
       * `elev` is the RESOLVED SURFACE LEVEL fed to the module; `renderedLvl`
       * is the WRONG basis (`elev px / lh`) printed beside it, because the two
       * disagree exactly when it matters — while swimming and mid-fall. */
      // The Settings "Indoor light" dial (indoorlight.ts). No arg reads it;
      // a number 0..1 drives it, so a gate can walk both ends without a
      // pointer drag. Returns the dial AND the ambient triple it resolves to.
      indoorLight: (v?: number) => {
        if (typeof v === "number") setIndoorLight(v);
        return { dial: indoorLight(), ambient: indoorAmbient().map((x) => +x.toFixed(4)) };
      },
      // The Settings "Indoor wall height" dial (indoorwall.ts). No arg reads it; a
      // number sets it, so a gate can walk every level without a pointer drag.
      // Returns the dial AND what it resolves to for the room you are in — the
      // dial is levels ABOVE THE FLOOR and `top` is the absolute level it lands
      // on, which is the number the picture is actually made of.
      indoorWall: (v?: number) => {
        if (typeof v === "number") setIndoorWall(v);
        return {
          wall: indoorWall(),
          min: INDOOR_WALL_MIN,
          max: INDOOR_WALL_MAX,
          ceiling: this.indoorCeil,
          top: this.indoorTop,
        };
      },
      // THE PER-WALL RAISE's QA switch + live state. No arg reads; a boolean
      // flips it (false = the flat scalar cut everywhere, the pre-raise
      // picture) and rebuilds the mask the way the wall dial does, so a gate
      // can diff the two renderings of the same room from the same camera.
      // `cuts` maps "col,row" → the level that column draws to (raised cells
      // only — everything else is at `top`).
      indoorRaise: (on?: boolean) => {
        if (typeof on === "boolean" && on !== this.indoorRaiseOn) {
          this.indoorRaiseOn = on;
          this.destroyIndoorDebris(); // QA toggles are instant — no stale fade layer
          if (this.indoorInside) {
            this.indoorMaskSig = "";
            if (this.refreshIndoorMask()) this.repaintWorld();
          }
        }
        const w = this.world;
        const cuts: Record<string, number> = {};
        let raised = 0;
        let cone = 0;
        let maxWallCut = 0;
        if (w && this.indoorCut)
          for (const [ci, cut] of this.indoorCut) {
            cuts[`${ci % w.width},${(ci - (ci % w.width)) / w.width}`] = cut;
            if (this.indoorMask?.has(ci)) {
              if (cut > this.indoorTop) raised++;
              if (cut > maxWallCut) maxWallCut = cut;
            } else cone++;
          }
        return {
          on: this.indoorRaiseOn,
          // `raised` counts MY WALLS above the dial; `cone` is the covering
          // slice in front of the room (also constrained); everything else in
          // the world is unconstrained and draws whole — `constrained` is the
          // full set the cuts map (and the room texture) carries.
          raised,
          cone,
          constrained: this.indoorCut?.size ?? 0,
          maxWallCut,
          top: this.indoorTop,
          ceiling: this.indoorCeil,
          protectedFloors: this.indoorSpace ? this.indoorSpace.roof.size + this.indoorSpace.entrances.size : 0,
          cuts,
        };
      },
      // THE TRANSITION FADE's live state — the debris layer that carries the
      // roof/wall crossfade (hard task #1). `alpha` is 1 − indoorMix, the
      // opacity every debris image wears this frame; `exiting` marks the
      // outward half (verdict outdoors, cut world still drawn).
      indoorFade: () => ({
        debris: this.indoorDebris?.length ?? 0,
        alpha: +this.debrisAlpha().toFixed(3),
        exiting: !this.indoorInside && !!this.indoorMask,
      }),
      // How this world's tile art arrived: sheets sliced from the committed
      // atlas vs individual fallback requests (verify-atlas's instrument).
      atlasInfo: () => this.tileAtlas?.stats() ?? null,
      chess: () => ({
        boards: this.room ? [...this.room.state.chessBoards.entries()].map(([id, b]: [string, any]) => ({
          id, col: b.col, row: b.row, npc: b.npc, waiting: b.waitingSid, matchId: b.matchId,
        })) : [],
        dialog: this.chessDialog?.probe() ?? null,
        waitBubbles: this.chessWaitB.size,
        prompt: this.chessPrompt?.mode ?? null,
      }),
      chessTap: (sq: number) => this.chessDialog?.tapSquare(sq),
      // The debris pieces standing on ONE cell, as (level, textureKey) pairs —
      // the instrument behind the lap-rule gate: a cell must never carry two
      // pieces at the same level (the deck stamped over its own equal-height
      // column was exactly that — the island hall's "roof suddenly changes
      // look", 2026-08-13).
      debrisAt: (c: number, r: number) => {
        if (!this.indoorDebris || !this.world) return null;
        const { dx, dy, lh } = this.geom;
        const bx = this.iso.ox + (c - r) * dx;
        const by = this.iso.oy + (c + r) * dy;
        return this.indoorDebris
          .filter((img) => img.x === bx && img.y <= by && (by - img.y) % lh === 0)
          .map((img) => ({ lvl: (by - img.y) / lh, key: img.texture.key }));
      },
      // Park the indoor blend anywhere in (0,1) — a number pins it, no arg /
      // null releases it. The instrument that lets a starved headless gate
      // photograph the 3× crossfade mid-blend (see easeIndoorMix).
      indoorMixPin: (v?: number | null) => {
        this.indoorMixPinV = typeof v === "number" ? Math.max(0.001, Math.min(0.999, v)) : null;
        return this.indoorMixPinV;
      },
      // Is the room mask really reaching the shader? The one failure this
      // feature has that is INVISIBLE on the headless harness and fatal on a
      // phone: an unbound uRoom sampler reads texture unit 0 (the heightmap)
      // and blacks out the ROOM instead of the outside. `bound` is the answer.
      roomTex: () => this.night?.roomDebug() ?? null,
      // The torch, for gates that must shoot the same frame lit and unlit —
      // with the outside at zero ambient a drawn tile and a missing one are
      // pixel-identical, so a light is the only instrument that tells them
      // apart (see verify-indoor's beam assertions).
      torchOn: () => this.torchOn,
      toggleTorch: () => this.toggleTorch(),
      indoor: () => {
        const s = this.indoorSpace;
        const av = this.avatars.get(this.room?.sessionId ?? "");
        return {
          indoor: this.indoorInside,
          roofLevel: s?.roofLevel ?? null,
          depth: s ? s.depth : null,
          wallRatio: s ? +s.wallRatio.toFixed(4) : null,
          roof: s?.roof.size ?? 0,
          entrances: s?.entrances.size ?? 0,
          capped: s?.capped ?? false,
          // Renderer-side state (what the mask is doing about that verdict).
          pending: this.indoorPending,
          mix: +this.indoorMix.toFixed(3),
          ceiling: this.indoorCeil, // deckBot — the room UNDERSIDE, not roofLevel
          key: this.indoorKey,
          mask: this.indoorMask?.size ?? 0,
          wallLeft: s?.wallLeft.size ?? 0,
          wallRight: s?.wallRight.size ?? 0,
          shell: s?.shell.size ?? 0,
          top: this.indoorTop, // the cut level the picture is drawn at
          fringe: s?.fringe.size ?? 0,
          cell: [this.indoorAtCol, this.indoorAtRow],
          elev: this.indoorAtElev,
          renderedLvl: av ? +(av.elev / this.geom.lh).toFixed(2) : null,
          swimming: av?.swimming ?? null,
          flips: this.indoorFlips,
          computes: this.indoorComputes,
          sinceFlipMs: Number.isFinite(this.indoorFlipAt) ? Math.round(this.time.now - this.indoorFlipAt) : null,
          torchF: +this.curTorchF.toFixed(3),
        };
      },
      // MAPS3: what the tiles3 pipeline actually resolved and drew this frame.
      // A gate cannot tell a black screen from a correct one by pixels alone —
      // an unlit outdoors is black too — so the counters are the instrument.
      tiles3: () => ({
        on: this.maps3,
        ready: !!this.t3,
        sheets: !!this.t3sheets,
        textures: !!this.t3tex,
        geom: { dx: this.geom.dx, dy: this.geom.dy, lh: this.geom.lh },
        drew: { ...this.t3stats },
        regionMs: this.t3regionMs,
        art: this.t3load ? { ...this.t3load.stats } : null,
        composed: this.t3tex ? { ...this.t3tex.stats } : null,
        resolver: this.t3 ? { ...this.t3.tiles.stats } : null,
        failures: [...this.t3Failed],
        placements: this.scenery?.placements.length ?? 0,
        pieces: this.sceneryPieces ? { ...this.sceneryPieces.stats } : null,
        occluders: this.occluders.length,
        // THE BOOT HOLD'S OWN INPUTS, raw — which of them is still false is
        // the only way to tell why a loading screen ran to its deadline.
        hold: {
            repaintPending: this.repaintGroundPending || this.repaintOccPending,
          rebuilds: this.sceneryRebuilds,
          queued: this.sceneryQueue.length,
          piecesIdle: !this.sceneryPieces || this.sceneryPieces.idle,
          artIdle: !this.t3load || this.t3load.idle,
          loaderBusy: this.tiles3Loader().isLoading(),
          manifestTimer: !!this.sceneryManifestTimer,
        },
      }),
      /** MAPS3, ONE CELL: what tiles3 resolves at (col,row) and what it can
       *  actually blit there right now.
       *
       *  The aggregate counters above cannot separate "this cell resolved to
       *  nothing" from "the window is empty", and a screenshot cannot separate
       *  "the fade tile drew" from "the plate under it drew" — the two are the
       *  same ground in nearly the same colour. So the per-cell verdict is
       *  published raw, and `verify-tiles3.mjs` pins it at coordinates derived
       *  from the world doc's own geometry.
       *
       *  READ-ONLY in the only sense that matters: everything here is taken
       *  through the SAME resolver and the SAME texture factory the ground pass
       *  uses, so a cell whose art has not streamed in yet reads as zero blits
       *  rather than as a resolution failure — and nothing is composed that the
       *  next redraw would not compose anyway. */
      t3at: (col: number, row: number) => {
        const t3 = this.t3;
        if (!t3 || !this.world) return null;
        const tex = this.ensureTiles3Textures();
        const cell = this.t3Try(`probe cell ${col},${row}`, () => t3.cell(col, row), null);
        const b = this.t3Try(`probe boundary ${col},${row}`, () => t3.boundary(col, row), null);
        const bop = b && tex ? tex.opsForBoundary(b) : null;
        return {
          cell: cell && {
            ground: cell.ground,
            level: cell.level,
            region: cell.region,
            kind: cell.kind,
            // `path` is absent on a liquid's art (it is a colour, not a file).
            art: cell.art
              ? { kind: cell.art.kind, path: (cell.art as { path?: string }).path ?? null }
              : null,
            fade: cell.fade
              ? { other: cell.fade.other, dist: cell.fade.dist, file: cell.fade.file }
              : null,
            wall: cell.wall
              ? {
                  side: cell.wall.side,
                  frontLow: cell.wall.frontLow,
                  capped: cell.wall.capped,
                  storeys: cell.wall.stack.length,
                }
              : null,
            sx: cell.sx,
            sy: cell.sy,
          },
          blits: cell && tex ? cellBlits(tex, this.t3tm, cell).map((o) => ({ role: o.role, key: o.key })) : [],
          boundary: b && { index: b.index, a: b.a, b: b.b, maskFrame: b.maskFrame, drawn: !!bop },
          decks: this.t3Try(`probe decks ${col},${row}`, () => t3.decks(col, row), []).length,
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
      jump: () => (this.chessPrompt ? this.room?.send("chess.sit", {}) : this.tryJump()),
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
      // THE REAL TAP PATH, at a camera-world POINT — pick + setMoveTarget,
      // exactly what pointerdown does. `tapTo` above takes an already-resolved
      // world position and so cannot exercise the two-candidate routing.
      tapPoint: (wx: number, wy: number, run = false) => {
        const g = this.pickGround(wx, wy);
        if (!g) return null;
        this.setMoveTarget(g.x, g.y, !!run, false, g.lvl, true, { wx, wy });
        const t = this.trip;
        return {
          picked: { x: g.x, y: g.y, lvl: g.lvl },
          target: t ? { x: t.target.x, y: t.target.y } : null,
          goalLevel: t?.goalLevel ?? null,
          endLevel: t?.endLevel ?? null,
        };
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
      /* THE COLLISION / HITBOX OVERLAY, and the two layers it paints. `on`
       * flips the same switch the settings row does (so a headless screenshot
       * needs no menu), and the counts make "is the client holding the same
       * scenery the server stamped" answerable without looking at pixels: the
       * server logs the same two numbers at world load. Measured equal on
       * the_game — 1,747 footprints, 2,568 nav cells — through the JSON the
       * /api/scenery-collision endpoint serves. */
      collision: (on?: boolean) => {
        if (on !== undefined) this.toggleCollision(on);
        const g = this.terrain;
        let nav = 0;
        let props = 0;
        if (g)
          for (let i = 0; i < g.blocked.length; i++) {
            if (g.blocked[i]) nav++;
            if (g.propBlocked[i]) props++;
          }
        return { on: this.collisionOn, footprints: g?.footprints?.n ?? 0, navCells: nav, propCells: props };
      },
      pickAt: (wx: number, wy: number) => this.pickGround(wx, wy),
      caveDbg: () => ({
        depth: this.caveDepth ? this.caveDepth.size : -1,
        under: this.caveUnder.size,
        deckBotAt: this.terrain ? this.terrain.deckBot[66 * this.terrain.width + 143] : null,
        deckAt: this.terrain ? this.terrain.deck[66 * this.terrain.width + 143] : null,
      }),
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
          playerZ: av ? +Math.max(0, av.elev / this.geom.lh).toFixed(2) : 0,
        };
      },
      // Local avatar's lit-copy light sample. `l` is what SHIPS: the light at
      // the avatar's RENDERED surface height (a.elev px → levels), so a deck top
      // (roof/bridge) is lit. `lBase` is the OLD base-terrain sample — dark under
      // a roof. QA for the "character shaded on the roof in daylight" deck bug.
      litInfo: () => {
        const av = this.avatars.get(this.room?.sessionId ?? "");
        if (!av || !this.night) return null;
        const rendLvl = Math.max(0, av.elev / this.geom.lh); // sunk while swimming
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
          elev: +(av.elev / this.geom.lh).toFixed(2),
          litVisible: av.lit ? av.lit.visible : null,
          litCropped: av.lit ? !!av.lit.isCropped : null,
          // The WHITE OCCLUSION OUTLINE over the covered part (syncCoverOutline).
          // `hiddenFrac` is the share of the art box the outline claims is
          // behind terrain — 0 when nothing is, 1 when the body is entirely
          // swallowed. It is the number to assert on, because "the ring exists"
          // is true even when it is cropped to nothing.
          hidden: av.hidden ? av.hidden.visible : null,
          // WHICH REPRESENTATION the outline is on. "surface" = the pixel-exact
          // cover atlas (a per-texel set, so there is no crop to report and
          // `hiddenCropped` is meaningless); "crop" = the old flat coverY band,
          // still the fail-open fallback. Ask coverStats() for the real
          // covered/silhouette fraction — it costs a GPU readback, so it is a
          // DEV probe and never runs in the frame loop.
          hiddenMode: av.coverAt === this.coverTick && av.coverSlot ? "surface" : "crop",
          hiddenCropped: av.hidden ? !!av.hidden.isCropped : null,
          hiddenFrac: (() => {
            if (!av.hidden?.visible || av.coverY === undefined) return 0;
            const ab = this.artBounds(av.sprite);
            const top = av.sprite.y - av.sprite.displayHeight * av.sprite.originY;
            const cut = Math.min(Math.max((av.coverY - top) / av.sprite.scaleY, ab.y0), ab.y1);
            return +((ab.y1 - cut) / (ab.y1 - ab.y0)).toFixed(3);
          })(),
        };
      },
      // THE REAL COVERED FRACTION, in texels — what the pixel-exact outline
      // actually traces, as opposed to `hiddenFrac`'s band of the art box.
      // Reads the body's own slot back out of the C (covered) and E (visible)
      // surfaces, which tile its silhouette exactly, so
      // `covered / (covered + visible)` needs no CPU alpha map and cannot
      // disagree with what is drawn. ASYNC and dev-only: it is a GPU readback.
      coverStats: (which?: string) => {
        const b: BodyVisual | undefined = !which || which === "me"
          ? this.avatars.get(this.room?.sessionId ?? "")
          : this.monsters.get(which);
        const slot = b ? this.coverSlotOf(b) : undefined;
        if (!b || !slot || !this.coverC || !this.coverE) return Promise.resolve(null);
        // NB whole-atlas snapshot, then index the slot: snapshotArea() is GL
        // bottom-origin while snapshot() is not, and a silently y-flipped read
        // would report a plausible-looking wrong number.
        const count = (dt: Phaser.Textures.DynamicTexture) =>
          new Promise<number>((res) => {
            dt.snapshot((img: any) => {
              const cnv = document.createElement("canvas");
              cnv.width = dt.width;
              cnv.height = dt.height;
              const g = cnv.getContext("2d", { willReadFrequently: true })!;
              g.drawImage(img, 0, 0);
              const d = g.getImageData(slot.x, slot.y, slot.w, slot.h).data;
              let n = 0;
              for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) n++;
              res(n);
            });
          });
        return Promise.all([count(this.coverC), count(this.coverE)]).then(([cov, vis]) => ({
          covered: cov,
          visible: vis,
          silhouette: cov + vis,
          coveredFrac: cov + vis ? +(cov / (cov + vis)).toFixed(4) : 0,
          outlined: !!b.hidden?.visible,
        }));
      },
      // Per-frame cost of the cover surfaces: draw brackets (CONSTANT in body
      // count — that is what the shared atlas buys), quads, how many bodies are
      // on a surface, and how often a frame needs no rebuild at all.
      coverCost: () => ({
        exact: this.coverExact,
        ...this.coverStat,
        allocated: this.coverSlots.length,
        buckets: this.coverBuckets.size,
      }),
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
      // The death sequence's live state (fade/zoom progress, whether the press
      // is armed) — a gate cannot see a mood from the outside.
      deathInfo: () => {
        const d = this.death;
        if (!d) return null;
        const t = this.time.now - d.at;
        return {
          armed: d.armed,
          asked: !!d.askAt,
          ms: Math.round(t),
          zoomP: +Math.min(1, t / DEATH_ZOOM_MS).toFixed(3),
          ease: +(1 - Math.pow(1 - Math.min(1, t / DEATH_ZOOM_MS), 3)).toFixed(3),
          veil: +(d.veil?.style.opacity || 0),
          prompt: d.el ? +(d.el.style.opacity || 0) : 0,
          // The MEASURED light on my own corpse — the death torch's whole
          // point. `on` is the switch, which the death light deliberately
          // ignores; `l` is what actually reaches the body, so a gate asserts
          // the effect and not the intent.
          torch: (() => {
            const id = this.room?.sessionId;
            const a = id ? this.avatars.get(id) : undefined;
            if (!a || !this.night) return null;
            const l = this.night.lightAt(a.fx / CELL_WU, a.fy / CELL_WU, this.litLevelOf(a), false);
            return { on: this.torchOn, l: l.map((v) => +v.toFixed(3)) };
          })(),
        };
      },
      // THE LIGHT SLOT LEDGER, live: which sources hold a real slot, what
      // overflowed to the stamp fallback, whether the reserved slots are in
      // use. A budget that only fails by LOOKING dim needs this to be
      // assertable ("the channel is empty" and "the effect does nothing" are
      // identical on screen — the cave lesson).
      // The CPU light twin at an exact cell — the same sample the lit copies
      // tint by (point lights + room gating + sun/cloud), so a gate can assert
      // "this ground is fire-lit" numerically instead of decoding screenshots.
      lightAt: (col: number, row: number, z?: number) => {
        if (!this.night || !this.world) return null;
        const zz = z ?? (this.world.rows[Math.floor(row)]?.[Math.floor(col)]?.l ?? 0);
        return this.night.lightAt(col, row, zz, false).map((v) => +v.toFixed(4));
      },
      // Torch switch for gates: measuring a fire's OWN pool needs my torch
      // dark, and the settings button is not reachable headlessly.
      torch: (on?: boolean) => {
        if (on !== undefined && on !== this.torchOn) this.toggleTorch();
        return this.torchOn;
      },
      lightSlots: () => ({
        max: MAX_SHADER_LIGHTS,
        reserved: RESERVED_LIGHT_SLOTS,
        worldSlots: WORLD_LIGHT_SLOTS,
        torch: this.lastSlotInfo.torch,
        reservedInUse: this.lastSlotInfo.reserved,
        total: this.lastSlotInfo.total,
        slotted: [...this.slotLit],
        // Tenure ramps (0..1): a value under 1 means that light is still
        // fading in over its crossfading pool stamp.
        ramps: Object.fromEntries([...this.slotTenure].map(([k, t]) => [k, +t.ramp.toFixed(3)])),
        edges: this.slotEdges,
        ...this.lastTenureStats,
        overflow: this.lightOverflow,
        sources: this.emissiveSources.length,
        probe: !!this.probeLight,
      }),
      // WHICH OF MY OWN CHARACTER'S CLIPS ARE REGISTERED. "The player is
      // loaded" means clips, not textures: a frame in the texture manager that
      // no clip points at is exactly the state this probe exists to catch.
      animReady: () => {
        const def = this.myCharacter;
        if (!def) return null;
        const states: Record<string, string> = {};
        let ready = 0;
        let total = 0;
        for (const [state, dirs] of Object.entries(def.animations)) {
          let n = 0;
          const dirCount = Object.keys(dirs).length;
          for (const dir of Object.keys(dirs)) {
            if (this.anims.exists(animKey(def.uid, state, dir))) n++;
          }
          states[state] = `${n}/${dirCount}`;
          ready += n;
          total += dirCount;
        }
        return {
          uid: def.uid,
          ready,
          total,
          states,
          kicked: this.deferredAnimsKicked,
          // The early-registration path: how many of MY frames the deferred
          // batch queued, how many are still outstanding, and when my clips
          // actually became playable. `left` stuck above 0 with `at` null after
          // the batch is the tell that the fast path silently did nothing.
          mine: this.myAnimDebug,
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
      worldInfo: () => {
        let maxL = 0;
        if (this.world) for (const r of this.world.rows) for (const c of r) if (c.l > maxL) maxL = c.l;
        return { name: this.worldName, maps2: this.maps2, w: this.world?.width, h: this.world?.height, maxL };
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
      // opts rides along so a VOICE-SCOPED assignment is testable: the engine
      // resolves `player.die@default_girl` off opts.voice, and a probe that
      // dropped opts could only ever exercise the shared, unscoped route.
      audioEvent: (name: string, opts?: Parameters<typeof gameAudio.event>[1]) =>
        gameAudio.event(name, opts ?? {}),
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
        this.holdGround = { x, y, lvl: this.terrain ? levelAtWorld(this.terrain, x, y) : 0,
          at: { wx: x, wy: y } };
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
        const { dx, dy, lh } = this.geom;
        const cam = this.cameras.main;
        const cell = this.world.rows[row]?.[col];
        if (!cell) return null;
        const wx = this.iso.ox + (col - row) * dx;
        const wy = this.iso.oy + (col + row) * dy - cell.l * lh;
        return {
          x: (wx - cam.worldView.x) * cam.zoom,
          y: (wy - cam.worldView.y) * cam.zoom,
          zoom: cam.zoom,
          // The camera's own origin, so a caller can undo the transform and
          // hand pickGround the WORLD coords its pointerdown works in.
          camX: cam.worldView.x,
          camY: cam.worldView.y,
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
        const { dx, dy, lh } = this.geom;
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
        const dy = this.geom.dy;
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
      /** MICRO-BENCH: force one full ground redraw right now — the latch
       *  poisoned as repaintWorld does — and report its pure-JS cost with the
       *  pass's counters. `cull` flips the off-texture cull for an A/B. */
      /** The ground scroll's switch (A/B) and what the last redraw did. */
      groundScroll: (on?: boolean) => {
        if (typeof on === "boolean") {
          this.groundScroll = on;
          this.groundAnchor = null; // the next redraw paints in full either way
        }
        const log = this.groundScrollLog;
        this.groundScrollLog = [];
        return { on: this.groundScroll, lastMode: this.groundLastMode, anchor: this.groundAnchor ? { ax: this.groundAnchor.ax, ay: this.groundAnchor.ay } : null, log, cells: { ...this.groundCellStats }, ring: { queued: this.t3ringQueue.length - this.t3ringAt, missing: this.t3missing.size } };
      },
      /** THE LANDING REPAINT's switch (off = a landed batch paints in full) and
       *  THE PREFETCH RING's (off = art is asked for only by the window). */
      groundPartial: (on?: boolean) => {
        if (typeof on === "boolean") this.groundPartial = on;
        return this.groundPartial;
      },
      groundPrefetch: (on?: boolean) => {
        if (typeof on === "boolean") {
          this.groundPrefetch = on;
          if (!on) this.t3ringQueue = [];
        }
        return this.groundPrefetch;
      },
      /** The resolution cache's switch, for the occluder-pass parity check. */
      groundCache: (on: boolean) => {
        this.groundCacheOn = on;
        if (!on) this.t3cells.clear();
        return on;
      },
      /** THE SLICED BAND's counters and its A/B switch (off = the whole band in
       *  the scroll's own frame, the pre-slicing behaviour). */
      groundSlices: (on?: boolean) => {
        if (typeof on === "boolean") {
          this.groundSliced = on;
          this.t3flushSlices();
        }
        return { on: this.groundSliced, pending: this.groundSliceQ.length, ...this.groundSliceStats, ms: +this.groundSliceStats.ms.toFixed(1), shift: this.groundLastShift, ring: this.t3ringQueue.length - this.t3ringAt };
      },
      groundRedraw: (cull?: boolean, cache?: boolean) => {
        // The switches are applied for THIS forced redraw only and restored
        // after, so an A/B never leaves the game running with either off.
        const prevCull = this.groundCull;
        const prevCache = this.groundCacheOn;
        if (typeof cull === "boolean") this.groundCull = cull;
        if (typeof cache === "boolean") this.groundCacheOn = cache;
        this.lastGround = { x: NaN, y: NaN };
        const t0 = performance.now();
        this.redrawGround();
        this.t3flushSlices(); // a forced redraw settles the picture before it is read
        // The pass's own counters (incl. its `ms`) plus the whole redraw's wall clock.
        const out = {
          ...this.t3stats,
          cull: this.groundCull,
          cache: this.groundCacheOn,
          cached: this.t3cells.size,
          mode: this.groundLastMode,
          totalMs: +(performance.now() - t0).toFixed(1),
        };
        this.groundCull = prevCull;
        this.groundCacheOn = prevCache;
        return out;
      },
      /** DIAGNOSTIC: every lit piece within `radius` cells of the player, with
       *  the cell it fogs by and the twin's answers (snapped / smooth) beside
       *  the pass's pixel over that cell. */
      fogPieces: (radius = 8) => {
        const me = this.avatars.get(this.room?.sessionId ?? "");
        const px = me ? me.fx / CELL_WU : 0;
        const py = me ? me.fy / CELL_WU : 0;
        const out: Record<string, unknown>[] = [];
        for (const lo of this.litOccluders) {
          if (Math.hypot(lo.col - px, lo.row - py) > radius) continue;
          const foot = this.night!.depthFogAtFoot(lo.bx, lo.by, Math.floor(lo.z), lo.col, lo.row);
          const cellTwin = this.night!.depthFogAt(lo.col, lo.row, Math.floor(lo.z), true);
          let pass: unknown = null;
          try {
            pass = (this.night!.fogProbeAt(lo.bx, lo.by) as { pass: unknown }).pass;
          } catch {
            pass = null;
          }
          out.push({ key: lo.img.texture.key.slice(0, 40), col: +lo.col.toFixed(2), row: +lo.row.toFixed(2), z: lo.z, worldL: this.world?.rows[Math.floor(lo.row)]?.[Math.floor(lo.col)]?.l ?? null, x: Math.round(lo.img.x), y: Math.round(lo.img.y), h: Math.round(lo.img.displayHeight), footA: +foot.a.toFixed(3), footRGB: [+foot.r.toFixed(2), +foot.g.toFixed(2), +foot.b.toFixed(2)], cellA: +cellTwin.a.toFixed(3), pass });
        }
        return { player: [+px.toFixed(2), +py.toFixed(2)], pieces: out };
      },
      /** THE HITCH RECORDER: `hitch(true)` arms it (perf must be on too),
       *  `hitch()` reads the worst frames of the run and clears them. */
      hitch: (on?: boolean) => {
        if (typeof on === "boolean") {
          this.hitchOn = on;
          this.hitchWorst = [];
          this.hitchSec = {};
          this.hitchN = 0;
          this.hitchSum = 0;
          this.hitchC = { tex: 0, files: 0, built: 0, buildMs: 0, blits: 0, objs: 0 };
          this.hitchPrevBuilt = this.t3tex?.stats.built ?? 0;
          this.hitchPrevBuildMs = this.t3tex?.stats.buildMs ?? 0;
          if (on) this.perfOn = true;
        }
        const worst = [...this.hitchWorst].sort((a, b) => (b.total as number) - (a.total as number));
        this.hitchWorst = [];
        return { on: this.hitchOn, frames: this.hitchN, avgMs: +(this.hitchSum / Math.max(1, this.hitchN)).toFixed(1), worst };
      },
      /** DIAGNOSTIC: every visible image/sprite whose box meets a world rect. */
      objectsIn: (x0: number, y0: number, x1: number, y1: number) => {
        const out: Record<string, unknown>[] = [];
        for (const o of this.children.list) {
          const im = o as unknown as Phaser.GameObjects.Image;
          if (!(o instanceof Phaser.GameObjects.Image || o instanceof Phaser.GameObjects.Sprite) || !im.visible) continue;
          const b = im.getBounds();
          if (b.right < x0 || b.left > x1 || b.bottom < y0 || b.top > y1) continue;
          out.push({ key: im.texture.key.slice(0, 44), frame: String(im.frame.name).slice(0, 24), depth: +im.depth.toFixed(3), alpha: +im.alpha.toFixed(2), tint: im.isTinted ? im.tintTopLeft.toString(16) : "-", fill: im.tintFill, x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), scroll: im.scrollFactorX });
        }
        return out.sort((a, b) => (a.depth as number) - (b.depth as number));
      },
      /** DIAGNOSTIC: the fog pass's pixel over a cell vs the JS twin. */
      fogProbe: (col: number, row: number) => this.night?.fogProbe(col, row) ?? null,
      /** THE DEPTH FOG ON SCENERY AND PROPS: on = each piece wears a fog
       *  silhouette at the fog of the cell under its feet; off = crisp copies. */
      sceneryFog: (on?: boolean) => {
        if (!this.night) return null;
        if (typeof on === "boolean") this.night.sceneryFog = on;
        return this.night.sceneryFog;
      },
      /** THE LIGHTING PASSES' A/B: arm/disarm the surface-march block skip. */
      nightSkip: (on: boolean) => this.night?.setSkip(on) ?? null,
      /** PARITY, same turn: the night or fog pass rendered with the skip off and on
       *  back to back, nothing else changing — {full, skip} hashes of its pixels. */
      nightParity: (which: "night" | "fog" = "night") =>
        this.night ? this.night.parityHash(which) : Promise.reject(new Error("no night lighting")),
      /** PARITY for the lighting passes: hash of the night or fog pass's own pixels. */
      nightHash: (which: "night" | "fog" = "night") =>
        this.night ? this.night.passHash(which) : Promise.reject(new Error("no night lighting")),
      /** PARITY: a hash of the ground render texture's ACTUAL PIXELS (read
       *  back through Phaser's snapshot), so two modes can be proven to draw
       *  the same picture rather than argued to. Exact because the RT is
       *  OPAQUE (redrawGround fills alpha 1 before drawing): the canvas
       *  round-trip would quantise alpha<255 pixels. Carries the RT's world
       *  anchor, so a mismatch between two redraws can be told apart from the
       *  camera having moved between them. */
      groundHash: () =>
        new Promise<{ hash: string; w: number; h: number; anchor: { x: number; y: number } }>((resolve, reject) => {
          this.t3flushSlices();
          const rt = this.groundRT;
          if (!rt) return reject(new Error("no ground RT"));
          rt.snapshot((img) => {
            try {
              const el = img as HTMLImageElement;
              const c = document.createElement("canvas");
              c.width = el.width;
              c.height = el.height;
              const g = c.getContext("2d")!;
              g.drawImage(el, 0, 0);
              const d = g.getImageData(0, 0, c.width, c.height).data;
              let h = 0x811c9dc5;
              for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193) >>> 0;
              resolve({ hash: h.toString(16).padStart(8, "0"), w: c.width, h: c.height, anchor: { x: rt.x, y: rt.y } });
            } catch (e) {
              reject(e);
            }
          });
        }),
      /** PARITY for the landing repaint: repaint these cells (col,row pairs)
       *  of the current window through repaintTiles3Cells — over a fresh full
       *  paint this must leave every pixel as it was (__ml.groundHash before
       *  and after). Returns what it did. */
      groundCellsRepaint: (cells: [number, number][]) => {
        const world = this.world;
        if (!world) return null;
        const before = { ...this.groundCellStats };
        this.repaintTiles3Cells(cells.map(([c, r]) => r * world.width + c));
        return { ...this.t3stats, mode: this.groundLastMode, runs: this.groundCellStats.runs - before.runs, full: this.groundCellStats.full - before.full, totalMs: +(this.groundCellStats.ms - before.ms).toFixed(1) };
      },
      /** LENS: STAMP EXACTNESS. Clears the ground RT to opaque black straight
       *  on its framebuffer, lays ONE `rt.stamp` of a 1x1 white texture over
       *  the given texture-space rect exactly as repaintTiles3Cells lays its
       *  background, then reads the framebuffer back and reports which texels
       *  it actually covered. DEV ONLY — it destroys the ground picture; call
       *  __ml.groundRedraw() after. */
      stampProbe: (x0: number, y0: number, x1: number, y1: number, margin?: number) => {
        const rt = this.groundRT;
        const r = this.game.renderer as unknown as {
          gl?: WebGLRenderingContext;
          flush?: () => void;
          pushFramebuffer?: (fb: WebGLFramebuffer, u?: boolean, s?: boolean) => void;
          popFramebuffer?: () => void;
        };
        const fb = rt
          ? (rt.texture as unknown as { renderTarget?: { framebuffer?: WebGLFramebuffer } })?.renderTarget?.framebuffer
          : undefined;
        if (!rt || !r?.gl || !fb || !r.pushFramebuffer || !r.popFramebuffer) return { err: "unavailable" };
        const gl = r.gl;
        const raw = (fb as unknown as { webGLFramebuffer?: WebGLFramebuffer }).webGLFramebuffer ?? (fb as unknown as WebGLFramebuffer);
        const bindFb = () => gl.bindFramebuffer(gl.FRAMEBUFFER, raw);
        const unbindFb = () => gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const W = rt.width;
        const H = rt.height;
        const key = "probe-white";
        if (!this.textures.exists(key)) {
          const cv = document.createElement("canvas");
          cv.width = 1;
          cv.height = 1;
          const g = cv.getContext("2d")!;
          g.fillStyle = "#ffffff";
          g.fillRect(0, 0, 1, 1);
          this.textures.addCanvas(key, cv)?.setFilter(Phaser.Textures.FilterMode.NEAREST);
        }
        r.flush?.();
        bindFb();
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        unbindFb();
        rt.stamp(key, undefined, x0, y0, { originX: 0, originY: 0, scaleX: x1 - x0, scaleY: y1 - y0, alpha: 1 });
        r.flush?.();
        const m = margin ?? 4;
        const tx0 = Math.max(0, x0 - m);
        const ty0 = Math.max(0, y0 - m);
        const tx1 = Math.min(W, x1 + m);
        const ty1 = Math.min(H, y1 + m);
        const w = tx1 - tx0;
        const h = ty1 - ty0;
        const px = new Uint8Array(w * h * 4);
        bindFb();
        gl.readPixels(tx0, H - ty1, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        unbindFb();
        let lo = 255;
        let hi = 0;
        for (let i = 0; i < px.length; i += 4) { if (px[i] < lo) lo = px[i]; if (px[i] > hi) hi = px[i]; }
        const cx = Math.floor((x0 + x1) / 2) - tx0;
        const cyTex = Math.floor((y0 + y1) / 2);
        const cy = ty1 - 1 - cyTex;
        const centre = cx >= 0 && cx < w && cy >= 0 && cy < h ? Array.from(px.slice((cy * w + cx) * 4, (cy * w + cx) * 4 + 4)) : null;
        // Map the bottom-up read back into TEXTURE space and classify.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let full = 0, partial = 0, none = 0;
        const partVals: Record<string, number> = {};
        const rowFull: Record<number, number> = {};
        const colFull: Record<number, number> = {};
        for (let ry = 0; ry < h; ry++) {
          const ty = ty1 - 1 - ry; // texture-space row
          for (let x = 0; x < w; x++) {
            const v = px[(ry * w + x) * 4];
            const txx = tx0 + x;
            if (v === 0) { none++; continue; }
            if (v === 255) {
              full++;
              rowFull[ty] = (rowFull[ty] ?? 0) + 1;
              colFull[txx] = (colFull[txx] ?? 0) + 1;
            } else {
              partial++;
              const k = String(v);
              partVals[k] = (partVals[k] ?? 0) + 1;
            }
            if (txx < minX) minX = txx;
            if (txx > maxX) maxX = txx;
            if (ty < minY) minY = ty;
            if (ty > maxY) maxY = ty;
          }
        }
        return {
          lo,
          hi,
          centre,
          fbKind: (fb as unknown as { webGLFramebuffer?: unknown }).webGLFramebuffer ? "wrapped" : "raw",
          asked: { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 },
          covered: full ? { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 } : null,
          full,
          partial,
          none,
          expectFull: (x1 - x0) * (y1 - y0),
          partVals,
          rowSpans: Object.keys(rowFull).map(Number).sort((a, b) => a - b).map((k) => `${k}:${rowFull[k]}`),
          colSpans: Object.keys(colFull).map(Number).sort((a, b) => a - b).map((k) => `${k}:${colFull[k]}`),
        };
      },
      /** LENS: full-framebuffer scan after one stamp — no coordinate mapping
       *  assumptions at all. Returns the bounding box of every non-black texel
       *  in FRAMEBUFFER (bottom-up) rows and in texture (top-down) rows. */
      stampScan: (x0: number, y0: number, x1: number, y1: number) => {
        const rt = this.groundRT;
        const r = this.game.renderer as unknown as { gl?: WebGLRenderingContext; flush?: () => void };
        const fb = rt
          ? (rt.texture as unknown as { renderTarget?: { framebuffer?: { webGLFramebuffer?: WebGLFramebuffer } | WebGLFramebuffer } })?.renderTarget?.framebuffer
          : undefined;
        if (!rt || !r?.gl || !fb) return { err: "unavailable" };
        const gl = r.gl;
        const raw = (fb as { webGLFramebuffer?: WebGLFramebuffer }).webGLFramebuffer ?? (fb as WebGLFramebuffer);
        const tex = (rt.texture as unknown as { renderTarget?: { width: number; height: number } }).renderTarget!;
        const W = tex.width;
        const H = tex.height;
        const key = "probe-white";
        if (!this.textures.exists(key)) {
          const cv = document.createElement("canvas");
          cv.width = 1;
          cv.height = 1;
          const g = cv.getContext("2d")!;
          g.fillStyle = "#ffffff";
          g.fillRect(0, 0, 1, 1);
          this.textures.addCanvas(key, cv)?.setFilter(Phaser.Textures.FilterMode.NEAREST);
        }
        r.flush?.();
        gl.bindFramebuffer(gl.FRAMEBUFFER, raw);
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        rt.stamp(key, undefined, x0, y0, { originX: 0, originY: 0, scaleX: x1 - x0, scaleY: y1 - y0, alpha: 1 });
        r.flush?.();
        const px = new Uint8Array(W * H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, raw);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        let minX = Infinity;
        let maxX = -Infinity;
        let minR = Infinity;
        let maxR = -Infinity;
        let full = 0;
        let partial = 0;
        const partVals: Record<string, number> = {};
        for (let row = 0; row < H; row++) {
          for (let x = 0; x < W; x++) {
            const v = px[(row * W + x) * 4];
            if (v === 0) continue;
            if (v === 255) full++;
            else { partial++; partVals[String(v)] = (partVals[String(v)] ?? 0) + 1; }
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (row < minR) minR = row;
            if (row > maxR) maxR = row;
          }
        }
        return {
          rtSize: `${rt.width}x${rt.height}`,
          fbSize: `${W}x${H}`,
          asked: { x0, y0, x1, y1 },
          full,
          partial,
          partVals,
          expect: (x1 - x0) * (y1 - y0),
          fbBox: full + partial ? { x0: minX, x1: maxX + 1, row0: minR, row1: maxR + 1 } : null,
          // the same box expressed in TEXTURE rows (top-down), assuming row = H-1-texY
          texBox: full + partial ? { x0: minX, x1: maxX + 1, y0: H - 1 - maxR, y1: H - minR } : null,
        };
      },
      /** The stamp rect and clip rect of the last landing repaint. */
      lastRepaintRect: () => this.groundLastRect,
      /** DIAGNOSTIC: the ground render texture's pixels as a PNG data URL (with
       *  its world anchor), so two redraws can be diffed pixel by pixel. */
      groundSnap: () =>
        new Promise<{ png: string; w: number; h: number; anchor: { x: number; y: number } }>((resolve, reject) => {
          this.t3flushSlices();
          const rt = this.groundRT;
          if (!rt) return reject(new Error("no ground RT"));
          rt.snapshot((img) => {
            try {
              const el = img as HTMLImageElement;
              const c = document.createElement("canvas");
              c.width = el.width;
              c.height = el.height;
              c.getContext("2d")!.drawImage(el, 0, 0);
              resolve({ png: c.toDataURL("image/png"), w: c.width, h: c.height, anchor: { x: rt.x, y: rt.y } });
            } catch (e) {
              reject(e);
            }
          });
        }),
      /** THE STREAMING REPAINTS: how many landings asked, how many passes ran.
       *  `coalesce` flips the A/B switch (legacy = every landing repaints
       *  synchronously). Counters reset on read. */
      repaints: (coalesce?: boolean) => {
        if (typeof coalesce === "boolean") this.repaintCoalesce = coalesce;
        const out = { coalesce: this.repaintCoalesce, ...this.repaintStats };
        this.repaintStats = { terrain: 0, scenery: 0, manifest: 0, groundRuns: 0, occRuns: 0 };
        return out;
      },
      /** MICRO-BENCH: force one full occluder rebuild right now — the latch
       *  poisoned exactly as repaintWorld does — and report its pure-JS cost,
       *  split into the destroy pass and the rest. `fast` flips destroyBatch's
       *  O(n) path off/on for an A/B in one session. */
      /** THE SET AS DRAWN, for parity checks: every occluder in display-list
       *  painter order (depth, then list position), with its base depth. */
      occDump: () => {
        const list = this.children.list;
        const pos = new Map<Phaser.GameObjects.GameObject, number>();
        list.forEach((o, i) => pos.set(o, i));
        const order = (ims: readonly Phaser.GameObjects.Image[]) =>
          ims
            .map((im) => ({ im, i: pos.get(im) ?? -1 }))
            .sort((a, b) => a.im.depth - b.im.depth || a.i - b.i)
            .map(({ im }) => [im.texture.key, im.x, im.y, Math.round(im.depth * 10) / 10, im.getData("oc"), im.getData("or")]);
        // Three bands, each in its own painter order: the terrain occluders
        // (pooled), the scenery base images, and the LIT copies (never pooled,
        // and where review found the epsilon must not go — so parity covers it).
        return { occluders: order(this.occluders), scenery: order(this.sceneryImgs), lit: order(this.litOccluders.map((lo) => lo.img)) };
      },
      /** THE ROW PROFILE OF A BUILT TEXTURE — how many opaque px per row.
       *  For the terrain rasters the game COMPOSES (t3f: top-face-only,
       *  t3c: conformed), which is the only way to see whether what was built
       *  matches what the mask says it should be. A top face must be 29 rows
       *  and 924 px; anything less is a hole the tiling cannot close. */
      texRows: (key: string) => {
        if (!this.textures.exists(key)) {
          return { key, missing: true, like: Object.keys(this.textures.list).filter((k) => k.startsWith(key.slice(0, 6))).slice(0, 8) };
        }
        const src = this.textures.get(key).getSourceImage() as CanvasImageSource & { width: number; height: number };
        const c = document.createElement("canvas");
        c.width = src.width;
        c.height = src.height;
        const g = c.getContext("2d");
        if (!g) return { key, err: "no 2d context" };
        g.clearRect(0, 0, c.width, c.height);
        g.drawImage(src, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const rows: string[] = [];
        let opaque = 0;
        for (let y = 0; y < c.height; y++) {
          let n = 0;
          for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 0) n++;
          if (n) rows.push(`${y}:${n}`);
          opaque += n;
        }
        return { key, size: `${c.width}x${c.height}`, opaque, rowCount: rows.length, rows };
      },
      /** Every composed terrain texture the factory has built, by prefix. */
      texKeys: (prefix: string) => Object.keys(this.textures.list).filter((k) => k.startsWith(prefix)).slice(0, 20),
      occRebuild: (mode?: "legacy" | "bulk" | "pool") => {
        if (mode === "legacy") {
          this.occFastDestroy = false;
          this.occPoolOn = false;
          this.scnPoolOn = false;
        } else if (mode === "bulk") {
          this.occFastDestroy = true;
          this.occPoolOn = false;
          this.scnPoolOn = false;
        } else if (mode === "pool") {
          this.occFastDestroy = true;
          this.occPoolOn = true;
          this.scnPoolOn = true;
        }
        const before = this.occluders.length + this.litOccluders.length + this.sceneryImgs.length;
        this.lastOccl = { x: NaN, y: NaN };
        const t0 = performance.now();
        this.rebuildOccluders();
        const ms = performance.now() - t0;
        return {
          mode: this.occPoolOn ? "pool" : this.occFastDestroy ? "bulk" : "legacy",
          reused: this.occReused,
          created: this.occCreated,
          scnReused: this.scnReused,
          scnCreated: this.scnCreated,
          destroyed: before,
          built: this.occluders.length + this.litOccluders.length + this.sceneryImgs.length,
          ms: +ms.toFixed(1),
          destroyMs: +this.occDestroyMs.toFixed(1),
          buildMs: +(ms - this.occDestroyMs).toFixed(1),
          displayList: this.children.length,
        };
      },
      /** THE FRAME BUDGET at this spot — `perf(true)` arms it, `perf()` reads
       *  and RESETS. Sections are wall-clock inside update(); `counts` is what
       *  the scene was carrying when they ran. Frame deltas are the scene's own
       *  update cadence, so they include Phaser's render. */
      perf: (on?: boolean) => {
        if (!this.perfTexHooked) {
          this.perfTexHooked = true;
          this.textures.on(Phaser.Textures.Events.ADD, (key: string) => {
            this.perfTexAdded++;
            this.perfTexFrame++;
            this.hitchC.tex++;
            // WHAT is being added, by key family (the first path-ish segment).
            const fam = String(key).replace(/^([a-z0-9_-]+[:/]).*$/i, "$1").slice(0, 16);
            this.perfTexFam[fam] = (this.perfTexFam[fam] ?? 0) + 1;
          });
        }
        if (on !== undefined) {
          this.perfTexAdded = 0;
          this.perfTexFam = {};
          this.perfTexFrame = 0;
          this.perfTexFrameMax = 0;
          this.perfOn = on;
          this.perfAcc = {};
          this.perfFrames = [];
          this.perfStack = [];
          this.perfLast = 0;
          return { armed: on };
        }
        const f = [...this.perfFrames].sort((a, b) => a - b);
        const pick = (q: number) => (f.length ? +f[Math.min(f.length - 1, Math.floor(f.length * q))].toFixed(1) : 0);
        const sections = Object.fromEntries(
          Object.entries(this.perfAcc)
            .sort((a, b) => b[1].ms - a[1].ms)
            .map(([k, v]) => [k, { n: v.n, totalMs: +v.ms.toFixed(1), avgMs: +(v.ms / Math.max(1, v.n)).toFixed(2), maxMs: +v.max.toFixed(1) }]),
        );
        const r = this.game.renderer as unknown as { drawCount?: number; batches?: number };
        const out = {
          frames: { n: f.length, p50: pick(0.5), p90: pick(0.9), p99: pick(0.99), max: f.length ? +f[f.length - 1].toFixed(1) : 0 },
          sections,
          counts: {
            occluders: this.occluders.length,
            litOccluders: this.litOccluders.length,
            occluderMeta: this.occluderMeta.length,
            sceneryImgs: this.sceneryImgs.length,
            propImgs: this.propImgs?.length ?? 0,
            monsters: this.monsters.size,
            monstersActive: this.monstersActive,
            avatars: this.avatars.size,
            npcs: this.npcs.size,
            displayList: this.children.length,
            textures: Object.keys(this.textures.list).length,
            drawCount: r?.drawCount ?? null,
          },
          window: { ms: +this.perfFrames.reduce((a, b) => a + b, 0).toFixed(0) },
          texturesAdded: this.perfTexAdded,
          texFamilies: this.perfTexFam,
          texFrameMax: this.perfTexFrameMax,
          groundLast: { composed: this.t3stats.composed, composeMs: this.t3stats.composeMs, ms: this.t3stats.ms },
        };
        this.perfTexAdded = 0;
        this.perfTexFam = {};
        this.perfTexFrameMax = 0;
        this.perfAcc = {};
        this.perfFrames = [];
        return out;
      },
      /** THE TWO PLANES a world point can be drawn on, for one cell — the
       *  question every overlay/anchor argument reduces to. `flat` is
       *  projectFlat (the BODY's feet convention: +tile/2, +dy); `art` is the
       *  tiles3 frame's anchor for the same point, which is where the terrain
       *  and the scenery sprites are actually drawn. */
      planes: (col: number, row: number) => {
        const pf = this.projectFlat((col + 0.5) * CELL_WU, (row + 0.5) * CELL_WU);
        const f = this.t3?.frame;
        const art = f ? { x: anchorX(f, col + 0.5, row + 0.5), y: anchorY(f, col + 0.5, row + 0.5, 0) } : null;
        // What the OVERLAYS draw a cell through — must equal `art`, or the
        // marks and the world they describe are on two planes.
        const cn = this.projectCellCorner(col + 0.5, row + 0.5, 0);
        return {
          flat: { x: +pf.x.toFixed(3), y: +pf.y.toFixed(3), lvl: pf.lvl },
          art: art ? { x: +art.x.toFixed(3), y: +art.y.toFixed(3) } : null,
          corner: { x: +cn.x.toFixed(3), y: +cn.y.toFixed(3) },
          delta: art ? { x: +(pf.x - art.x).toFixed(3), y: +(pf.y - art.y).toFixed(3) } : null,
          cornerVsArt: art ? { x: +(cn.x - art.x).toFixed(3), y: +(cn.y - art.y).toFixed(3) } : null,
          geom: { dx: this.geom.dx, dy: this.geom.dy, lh: this.geom.lh, tile: this.geom.tile },
        };
      },
      /** INDOOR SCENERY: what the index holds under roofs, and how much of it
       *  the cut is letting through right now. */
      sceneryIndoor: () => {
        const ps = this.scenery?.placements ?? [];
        const roofed = ps.filter((p) => p.roofed);
        return {
          placements: ps.length,
          roofed: roofed.length,
          cutAway: roofed.filter((p) => this.roofCutAwayAt(p.cx, p.cy, p.level)).length,
          drawn: this.t3stats.scenery,
          drawnRoofed: this.sceneryRoofedDrawn,
          indoor: this.indoorInside,
          // The DRAWN cut state, which is what the rule actually reads: the mask
          // outlives the verdict for the length of the exit fade.
          maskUp: !!this.indoorMask,
          grade: +this.indoorGrade().toFixed(3),
          pieces: [...new Set(roofed.map((p) => p.piece))].length,
        };
      },
      /** The boot/deferred split of monster art and what is still parked. */
      monsterBoot: () => ({
        boot: this.monsterBootKinds ? [...this.monsterBootKinds].sort() : null,
        deferred: [...this.monsterDeferredKinds].sort(),
        pending: [...this.monsters.values()].filter((mv) => mv.artPending).map((mv) => mv.kind),
        // kinds whose south walk clip is registered — the deferred ones join
        // this list one kind at a time as their strips land
        clipKinds: (this.monsterManifest?.monsters ?? [])
          .filter((d) => this.anims.exists(monsterAnimKey(d.id, monsterWalkKey(d), DEFAULT_DIRECTION)))
          .map((d) => d.id).length,
      }),
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
            // w/h are the CULL extents (for a tuned monster, the worst case
            // over all 8 facings) — NOT what is drawn. dw/dh/rot below are.
            w: mv.shadowW,
            h: mv.shadowH,
            dw: +mv.shadow.displayWidth.toFixed(3),
            dh: +mv.shadow.displayHeight.toFixed(3),
            rot: +mv.shadow.rotation.toFixed(6),
            alpha: +mv.shadow.alpha.toFixed(3),
          },
          // THE TUNED SHADOW IN FORCE (wiki editor → live/tuning/monsters).
          // null = this kind is on the legacy art-measured contract. `state`
          // is the canonical facet the anchor was resolved for and `src` which
          // link of the chain supplied it — without these a gate can only see
          // THAT an origin moved, never whether the tuned record governed it.
          tuned: mv.tuned
            ? {
                rx: mv.tuned.rx,
                ry: mv.tuned.ry,
                state: mv.shState ?? null,
                src: mv.shSrc ?? null,
                offsets: mv.tuned.offsets ? Object.keys(mv.tuned.offsets).length : 0,
              }
            : null,
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
          // The WHITE OCCLUSION OUTLINE. `hidden` alone is not assertable — the
          // image survives cropped to nothing — so report the SHARE of the art
          // box it claims, exactly as myCover does, plus whether this body is
          // sealed in a room the camera's owner is not in (the wall-hack gate).
          hidden: mv.hidden ? mv.hidden.visible : null,
          // "surface" = the pixel-exact cover atlas, "crop" = the flat coverY
          // band (the fail-open fallback). __ml.coverStats(id) reads the real
          // covered/silhouette texel counts back off the surfaces.
          hiddenMode: mv.coverAt === this.coverTick && mv.coverSlot ? "surface" : "crop",
          hiddenFrac: (() => {
            if (!mv.hidden?.visible || mv.coverY === undefined) return 0;
            const ab = this.artBounds(mv.sprite);
            const top = mv.sprite.y - mv.sprite.displayHeight * mv.sprite.originY;
            const cut = Math.min(Math.max((mv.coverY - top) / mv.sprite.scaleY, ab.y0), ab.y1);
            return +((ab.y1 - cut) / (ab.y1 - ab.y0)).toFixed(3);
          })(),
          // What the GEOMETRY says is covered, regardless of whether the
          // outline is actually drawn. The two together are what makes the
          // wall-hack gate non-vacuous: a body with coverFrac 1 and hiddenFrac
          // 0 is one the old code WOULD have outlined through the rock.
          coverFrac: (() => {
            if (mv.coverY === undefined || !mv.sprite.visible) return 0;
            const ab = this.artBounds(mv.sprite);
            const top = mv.sprite.y - mv.sprite.displayHeight * mv.sprite.originY;
            const cut = Math.min(Math.max((mv.coverY - top) / mv.sprite.scaleY, ab.y0), ab.y1);
            return +((ab.y1 - cut) / (ab.y1 - ab.y0)).toFixed(3);
          })(),
          inHiddenRoom: this.inHiddenRoom(mv.fx, mv.fy, mv.surfLevel ?? 0),
          // Animation state — a headless probe CAN catch "moving but frozen"
          // (screenshots can't distinguish a stuck walk from freeze-frame idle).
          anim: mv.sprite.anims.getName() || null,
          playing: mv.sprite.anims.isPlaying,
          tex: mv.sprite.texture.key,
          // Camera-gated (off-screen): its pipeline is parked this frame, so
          // `playing`/`depth`/`lit` are deliberately stale — QA must skip it.
          culled: !!mv.culled,
          artPending: !!mv.artPending,
          spriteVisible: mv.sprite.visible,
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
          // Who this monster is hunting ("" = nobody). The one field that
          // answers "did it notice me?" without inferring it from behaviour —
          // what the "disable aggro" gate reads.
          tsid: (this.room?.state as any)?.monsters?.get(id)?.tsid ?? "",
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
      // The loaded monster manifest's gait contract, per kind (round-13 QA).
      monsterDefs: () =>
        (this.monsterManifest?.monsters ?? []).map((d) => ({
          id: d.id,
          bodyW: d.bodyW ?? null,
          frames: Object.values(d.animations?.[d.walkAnim] ?? {})[0] ?? 0,
          gait: d.gait ?? null,
        })),
      // GAIT SYNC probe (round 13): per active monster, the measured drawn
      // speed, the clip's base rate + live timeScale, and the resulting
      // effective fps — so a gate can assert cadence-true playback (one walk
      // cycle per gait.cycleWu of ground) instead of eyeballing a screenshot.
      monsterGait: () =>
        [...this.monsters.entries()]
          .filter(([, mv]) => !mv.culled)
          .map(([id, mv]) => {
            const a = mv.sprite.anims;
            const base = a.currentAnim?.frameRate ?? 0;
            const frames = a.currentAnim?.getTotalFrames?.() ?? 0;
            return {
              id,
              kind: mv.kind,
              anim: a.getName() || null,
              walking: a.getName() === monsterAnimKey(mv.kind, mv.walkKey, mv.dispDir),
              spdWu: mv.spdWu !== undefined ? +mv.spdWu.toFixed(1) : null,
              cycleWu: mv.cycleWu ?? null,
              frames,
              baseFps: +base.toFixed(2),
              timeScale: +a.timeScale.toFixed(3),
              fps: +(base * a.timeScale).toFixed(2),
              // Ground covered per completed cycle — the invariant: ≈ cycleWu
              // whenever the clamps are not binding.
              wuPerCycle:
                base * a.timeScale > 0 && frames
                  ? +(((mv.spdWu ?? 0) * frames) / (base * a.timeScale)).toFixed(1)
                  : null,
              hop: !!mv.travel,
              hopOff: mv.hopOff !== undefined ? +mv.hopOff.toFixed(2) : null,
            };
          }),
      // THE GRAB (round 15): where my character must stand for the pickup
      // gesture to land on a given drop, how far off it currently is, and the
      // live state of a drop being held for its grab frame.
      grabInfo: (dropId?: string) => {
        const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
        if (!me) return null;
        const id = dropId ?? this.pendingPickupId ?? [...this.drops.keys()][0];
        const rec = id ? this.drops.get(id) : undefined;
        const def = this.manifest.characters.find((c) => c.uid === me.character);
        const spot = rec ? this.grabStandSpot(me, rec.wx, rec.wy) : null;
        const anim = me.sprite.anims.getName() ?? "";
        return {
          id: id ?? null,
          hasGrabData: !!def?.grab,
          dir: me.dispDir,
          grabFrame: (me.dispDir && def?.grab?.[me.dispDir]?.f) ?? null,
          approx: (me.dispDir && def?.grab?.[me.dispDir]?.approx) ?? false,
          spot: spot ? { x: +spot.x.toFixed(1), y: +spot.y.toFixed(1), dir: spot.dir } : null,
          // How far the body is from the aligned spot (wu) — 0 = the hand
          // lands exactly on the item.
          offBy: spot ? +Math.hypot(spot.x - me.fx, spot.y - me.fy).toFixed(1) : null,
          anim,
          frame: frameIndexOf(me.sprite.texture.key),
          held: rec ? { grabbedAt: rec.grabbedAt ?? null, grabFrame: rec.grabFrame ?? null } : null,
          lastRetire: this.lastGrabRetire ?? null,
          drops: this.drops.size,
        };
      },
      // The world's NPCs (round 16): placement, art state and the calm-idle
      // clock, for the gate.
      npcInfo: () =>
        [...this.npcs.entries()].map(([id, n]) => ({
          id,
          charId: n.charId,
          name: n.name,
          type: n.type,
          dir: n.dir,
          x: Math.round(n.fx),
          y: Math.round(n.fy),
          // Drawn geometry, for the anchor gate: where the sprite is pinned,
          // its origin, and where the nadir shadow sits. The feet must land on
          // the shadow's centre or the NPC reads as flying.
          sx: +n.sprite.x.toFixed(1),
          sy: +n.sprite.y.toFixed(1),
          originX: +n.sprite.originX.toFixed(4),
          originY: +n.sprite.originY.toFixed(4),
          dw: n.sprite.displayWidth,
          dh: n.sprite.displayHeight,
          shadowX: +n.shadow.x.toFixed(1),
          shadowY: +n.shadow.y.toFixed(1),
          culled: !!n.culled,
          // HEAD-TURNING state (stepNpcFacing): where maps2 put them, and the
          // two things that pull them off it. `looking`/`glancing` are the
          // deadlines resolved against the clock, so a gate never has to guess
          // which source is currently winning.
          home: n.home,
          noTurn: !!n.def.noTurn,
          looking: n.lookUntil > this.time.now ? n.lookDir : null,
          glancing: n.glanceUntil > this.time.now ? n.glanceDir : null,
          glanceMsLeft: Math.max(0, Math.round(n.glanceUntil - this.time.now)),
          hasAnim: !!n.animKey,
          playing: n.sprite.anims.isPlaying,
          holdMs: n.holdUntil ? Math.max(0, Math.round(n.holdUntil - this.time.now)) : 0,
          tex: n.sprite.texture.key,
          depth: +n.sprite.depth.toFixed(1),
          shadow: n.shadow.visible,
          lit: !!n.lit?.visible,
        })),
      toggleAggroRadius: (on?: boolean) => this.toggleAggroRadius(on),
      // Settings "disable aggro" — read with no argument, set with one.
      noAggro: (on?: boolean) => (on === undefined ? this.noAggroOn : this.toggleNoAggro(on)),
      mySid: () => this.room?.sessionId ?? "",
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
        let parkedInView = 0;
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
            // A body parked for art it does not have yet is culled ON PURPOSE
            // wherever it stands — counted apart, never as a wrong cull.
            if (hits) mv.artPending ? parkedInView++ : wrongCulled++;
          } else if (!hits) wastedActive++;
        });
        return {
          total: this.monsters.size,
          active: this.monstersActive,
          culled,
          visibleCulled,
          animatingCulled,
          wrongCulled,
          parkedInView,
          wastedActive,
          slack: MONSTER_CULL_SLACK,
        };
      },
      monstersDump: () => {
        const st = (this.room?.state as any)?.monsters;
        const out: Record<string, unknown>[] = [];
        this.ps();
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
        this.pe("monsterLoop");
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
      // WHAT IS AROUND ME, by wiki id (games-ui's 🔍 button — spec/WIKI_NEAR.md,
      // maintainer 2026-09-02: "a way to fast find what you stand next to").
      // One row per (domain, id) at the NEAREST instance, `n` = how many are
      // within the radius, sorted nearest first. The ids are the domains' own
      // — roster id, characters2 folder key, item id, scenery piece, material
      // — so the wiki's route is `#/<domain>/<id>` with nothing invented here.
      // Other players are not rows: they have no wiki page. Terrain samples a
      // tighter ring than bodies (the ground is everywhere; "what am I standing
      // on / next to" is the question), and the tile drawn under the nearest
      // cell rides along so the wiki can deep-link the instance.
      nearby: (radius = 12, groundRadius = 4) => {
        const me = this.room?.state.players.get(this.room!.sessionId);
        if (!me || !this.world) return { world: this.worldName, at: null, radius, items: [] };
        const mx = me.x, my = me.y;
        type Row = { domain: string; id: string; dist: number; n: number; path?: string };
        const best = new Map<string, Row>();
        const add = (domain: string, id: string, wx: number, wy: number, path?: string) => {
          const dist = Math.hypot(wx - mx, wy - my) / CELL_WU;
          const key = `${domain}/${id}`;
          const cur = best.get(key);
          if (!cur) best.set(key, { domain, id, dist, n: 1, ...(path ? { path } : {}) });
          else {
            cur.n++;
            if (dist < cur.dist) { cur.dist = dist; if (path) cur.path = path; }
          }
        };
        const within = (wx: number, wy: number, r: number) => Math.hypot(wx - mx, wy - my) <= r * CELL_WU;
        for (const mv of this.monsters.values()) if (within(mv.fx, mv.fy, radius)) add("monsters", mv.kind, mv.fx, mv.fy);
        for (const n of this.npcs.values()) if (within(n.fx, n.fy, radius)) add("characters", n.charId, n.fx, n.fy);
        for (const d of this.drops.values()) if (within(d.wx, d.wy, radius)) add("items", d.item, d.wx, d.wy);
        for (const sc of this.world.scenery ?? []) {
          const wx = sc.x * CELL_WU, wy = sc.y * CELL_WU;
          // A placement names `category/piece`; the wiki keys objects by the
          // bare piece id (unique across categories — verified on the index).
          if (within(wx, wy, radius)) add("objects", sc.piece.split("/").pop() ?? sc.piece, wx, wy);
        }
        // GROUND: a Tiles 2.0 material is a page in the wiki's `tiles` domain;
        // a Tiles 3.0 ground TYPE (the_game and every maps3 world) is a page in
        // its `world` domain (`#/world/<type>` — viewWorldType). Same cell.t,
        // two routes, decided by which renderer this world booted.
        const groundDomain = this.t3 ? "world" : "tiles";
        // Terrain: the cell centres in a ring around the feet, plus the tiles2
        // PROPS standing on them (tall tile art — a tree, a boulder — whose
        // page is its material's).
        const c0 = Math.floor(mx / CELL_WU), r0 = Math.floor(my / CELL_WU);
        const rows = this.world.rows;
        for (let rr = r0 - groundRadius; rr <= r0 + groundRadius; rr++) {
          for (let cc = c0 - groundRadius; cc <= c0 + groundRadius; cc++) {
            const cell = rows[rr]?.[cc];
            if (!cell || !cell.t) continue;
            const wx = (cc + 0.5) * CELL_WU, wy = (rr + 0.5) * CELL_WU;
            if (!within(wx, wy, groundRadius)) continue;
            // The cell UNDER the feet is "0 cells away" whatever its centre is.
            const under = cc === c0 && rr === r0;
            add(groundDomain, cell.t, under ? mx : wx, under ? my : wy, cell.path);
          }
        }
        for (const pr of this.world.props ?? []) {
          const wx = (pr.col + 0.5) * CELL_WU, wy = (pr.row + 0.5) * CELL_WU;
          if (!within(wx, wy, radius)) continue;
          const mat = pr.path.split("/")[1];
          if (mat) add(groundDomain, mat, wx, wy, pr.path);
        }
        const items = [...best.values()]
          .map((r) => ({ ...r, dist: +r.dist.toFixed(2) }))
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 80);
        return {
          world: this.worldName,
          at: { col: +(mx / CELL_WU).toFixed(2), row: +(my / CELL_WU).toFixed(2) },
          radius,
          items,
        };
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
      // DEBUG ONLY, same standing as `teleport`/`dbgkill`: force the UI lock a
      // dialog would set, so a gate can prove the revive press survives a STALE
      // one (the class of bug that left the maintainer pressing a dead prompt
      // until the server's 3-minute backstop).
      uiLock: (on: boolean) => {
        this.uiLocked = !!on;
        if (!on) this.uiLockLiftAt = performance.now() + 150;
        return this.uiLocked;
      },
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
      // The Settings button PRINTS the phase, and the world clock advances by
      // itself every 20-40s — so the label has to be re-read here or it keeps
      // whatever phase happened to be current when the page was last built
      // (maintainer 2026-08-06: "often gets out of sync with the real time").
      // frozen/timeSpeed/weather all do this; time-of-day was the one listener
      // that didn't, which is why IT was the button that drifted.
      this.hud?.refreshSettings();
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
        // Same for "disable aggro": the server keys it by SESSION id, and a
        // rejoin is a new session — without this the setting looks on in
        // Settings while everything in the cave hunts you again.
        if (this.noAggroOn) room.send("noaggro", { on: true });
        this.hideLoadingWhenTerrainIsUp(); // v3 streams its art — see the method
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

    // ---------------- CHESS: boards in the world + my matches -------------
    $(room.state).chessBoards.onAdd((b: any, id: string) => {
      this.placeChessBoard(id, b);
      $(b).onChange(() => this.syncChessWait(id, b));
      this.syncChessWait(id, b);
    });
    $(room.state).chessBoards.onRemove((_b: any, id: string) => {
      this.chessDecor.get(id)?.destroy(); this.chessDecor.delete(id);
      this.chessWaitB.get(id)?.destroy(); this.chessWaitB.delete(id);
    });
    $(room.state).chessMatches.onAdd((m: any, id: string) => {
      const mine = m.aSid === room.sessionId || m.bSid === room.sessionId;
      if (!mine) return;
      const open = () => {
        if (this.chessDialog) return;
        const board = room.state.chessBoards.get(m.boardId);
        const oppSid = m.aSid === room.sessionId ? m.bSid : m.aSid;
        const oppName = oppSid === "npc"
          ? board?.npc || "Opponent"
          : room.state.players.get(oppSid)?.name || "Opponent";
        this.setChessLock(true);
        this.chessDialog = new ChessDialog(m as ChessMatchView, {
          mySid: room.sessionId,
          oppName,
          send: (t, msg) => this.room?.send(t, msg),
          onClosed: () => { this.chessDialog = null; this.setChessLock(false); },
        });
        $(m).onChange(() => this.chessDialog?.update());
        $(m).moves.onAdd(() => this.chessDialog?.update());
      };
      open();
    });
    $(room.state).chessMatches.onRemove((m: any) => {
      // Swept server-side (both closed, or the 60s broom). If my dialog is
      // still up past "over", let it be — it closes itself; but a live match
      // vanishing (opponent left before dice) must not strand a locked UI.
      if (this.chessDialog && m.phase !== "over" &&
          (m.aSid === room.sessionId || m.bSid === room.sessionId)) this.chessDialog.close();
    });
    $(room.state).drops.onRemove((_g: any, id: string) => this.removeDrop(id));
    // Spawn areas are server-computed per world and synced once — redraw the
    // debug overlay as they arrive (they land after the first iso build).
    $(room.state).spawnAreas.onAdd(() => this.drawSpawnAreas());
    // Live tuning pushes (monster stats + constant overrides edited in the
    // wiki) — sent on join and broadcast on every admin save / live/** push.
    bindLiveTuning(room);
    // …and the SHADOW half of that tuning re-applies to monsters already on
    // screen: committing a shadow in the wiki re-anchors the live world the
    // same second, no rejoin. (Registered per room bind; the previous room's
    // listener is dropped with it.)
    this.liveShadowUnsub?.();
    this.liveShadowUnsub = onLiveTuning(() => {
      this.monsters.forEach((mv) => {
        const t = monsterShadow(mv.kind) ?? undefined;
        const K = this.geom.dy / this.geom.dx;
        const def = this.monsterManifest?.monsters.find((d) => d.id === mv.kind);
        mv.tuned = t;
        if (t) {
          // Re-anchor the facet the monster is ACTUALLY playing, not a
          // hardcoded "idle" — a monster mid-swing would otherwise sit on the
          // wrong offset until its next clip change (and a CULLED one until
          // it re-enters the view).
          this.applyTunedOriginFor(mv, mv.shState ?? "idle", mv.dispDir);
          mv.shadowW = Math.ceil(2 * Math.max(t.rx, t.ry / K));
          mv.shadowH = Math.ceil(2 * Math.max(t.ry, t.rx * K));
          mv.radius = shadowBodyRadius(t.rx, t.ry);
          // …and the DRAWN ellipse right now. The per-frame draw only runs for
          // ACTIVE monsters, so without this a culled body keeps its old
          // ellipse — invisible, but every probe and gate reads it as truth.
          const e = shadowScreenEllipse(t.rx, t.ry, mv.dispDir);
          mv.shadow.setDisplaySize(
            e.p * 2 * MONSTER_SHADOW_SPREAD,
            e.q * 2 * MONSTER_SHADOW_SPREAD,
          );
          mv.shadow.setRotation(e.theta);
        } else {
          // Tuning dropped: back to the legacy measured contract, rotation off.
          mv.shState = undefined;
          mv.shSrc = undefined;
          const g = mv.ground?.[mv.dispDir];
          if (g) mv.sprite.setOrigin(g.cx, g.f);
          mv.shadow.setRotation(0);
          mv.shadowW = def?.shadowW ?? Math.round((def?.frameW ?? 48) * 0.54);
          mv.shadowH = def?.shadowH ?? Math.max(6, Math.round(mv.shadowW * 0.385));
          mv.radius = def?.radius ?? DEFAULT_MONSTER_RADIUS;
          mv.shadow.setDisplaySize(
            mv.shadowW * MONSTER_SHADOW_SPREAD,
            mv.shadowH * MONSTER_SHADOW_SPREAD,
          );
        }
      });
    });
    /* A HITBOX EDITED IN THE WIKI, WITHOUT A REDEPLOY OR A REJOIN. The server
     * restamps its own collision when the live doc changes and says so; the
     * prediction has to follow in the same breath, because a client and an
     * authority holding different footprints is precisely the divergence the
     * single collision endpoint exists to rule out. Refetch rather than trust a
     * payload: the endpoint is the authority's own copy. */
    room.onMessage("scenery:collision", () => {
      void fetch("/api/scenery-collision")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return;
          this.sceneryBboxDoc = (d.bbox as SceneryBboxDoc) ?? null;
          this.sceneryHitboxDoc = (d.hitbox as Record<string, SceneryHitboxRec>) ?? null;
          // Straight back through the stamp — no grid rebuild. It used to be
          // rebuilt here because stamping only ever ADDED blocked cells, so a
          // retired hitbox stayed solid forever; the stamp now resets the
          // derived layer to `propBlocked` and rebuilds the ellipse table from
          // scratch, and keeping the SAME grid object means nothing that has a
          // reference to it (the overlay's bare-terrain view, a trip in flight)
          // is left pointing at a grid the game no longer moves on.
          this.restampScenery();
          this.repaintWorld();
        })
        .catch(() => {});
    });
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
    av.fog?.destroy();
    // BEFORE av.waterMask is destroyed below — the outline holds that mask now.
    this.releaseCoverSlot(av);
    av.hidden?.destroy();
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
  /** Anchor a tuned monster's sprite on its shadow centre FOR THIS FACET.
   * v2: the offset is per <state>#<direction> (maintainer 2026-08-20: "The
   * shadow offset is per animation and direction" — PixelLab frames each
   * direction's strip independently, so one offset cannot fit them all).
   * Chain: facet → same direction's idle → v1 base → the art-derived default
   * (the measured foot line, the same fallback an untuned monster uses). */
  private applyTunedOriginFor(mv: MonsterAvatar, state: string, dir: string) {
    mv.shState = state;
    if (!mv.tuned || mv.sprite.width <= 0) return;
    // No manifest scan here: this runs per monster PER FRAME (the re-anchor
    // after playMonsterAnim), and a 57-entry find × 160 monsters × 60fps is
    // real cost. The two fields it needs are mirrored onto the avatar.
    mv.shSrc = applyTunedOrigin(mv.sprite, mv.tuned, state, dir, mv.artBottom, mv.hoverPx);
  }

  /** The tuned ellipse for a facing, drawn: ONE size for the whole monster,
   *  turned on the GROUND with the facing, centred on the monster's position.
   *  (Maintainer 2026-08-20: one shadow size, rotated by direction. So it must
   *  NOT breathe with the animation's `air[]` the way a legacy nadir shadow
   *  does — a tuned ellipse is a decision, not a measurement.) */
  private placeTunedShadow(mv: MonsterAvatar, targetElev: number) {
    const e = shadowScreenEllipse(mv.tuned!.rx, mv.tuned!.ry, mv.dispDir);
    this.placeBodyShadow(
      mv, targetElev, 0,
      e.p * 2 * MONSTER_SHADOW_SPREAD, e.q * 2 * MONSTER_SHADOW_SPREAD,
    );
    mv.shadow.setRotation(e.theta);
  }

  private addMonster(id: string, m: any) {
    const def = this.monsterManifest?.monsters.find((d) => d.id === m.kind);
    // The roster's own display name ("Dewling" for forest_poring) — resolved
    // HERE, once, because updateMonsterHpBar runs per monster per frame and a
    // manifest scan there would be 24 finds × 160 monsters × 60fps.
    const label = def?.name || m.kind;
    const f0 = this.projectFlat(m.x, m.y);
    const elev0 = (m.elev ?? f0.lvl) * this.geom.lh;
    const p0 = { x: f0.x, y: f0.y - elev0 };
    const walk = def ? monsterWalkKey(def) : "jump";
    const initKey = monsterSheetKey(m.kind, walk, DEFAULT_DIRECTION);
    const hasArt = this.textures.exists(initKey);
    // 48px art, drawn at scale 1 (the camera zoom already scales the world);
    // origin near the feet so it y-sorts and lifts like a player. Fall back to
    // the wanderer placeholder if a monster's strip failed to load.
    const sprite = this.add.sprite(p0.x, p0.y, hasArt ? initKey : PLACEHOLDER_TEX);
    // A kind whose strips are still in the deferred batch starts PARKED —
    // hidden like a culled body — and onMonsterArtLanded releases it. A kind
    // whose art is simply missing keeps today's placeholder.
    const artPending = !hasArt && this.monsterDeferredKinds.has(m.kind);
    if (artPending) sprite.setVisible(false);
    // Feet origin = the PER-DIRECTION measured ground contract (feet line +
    // foot centre of the south strip to start; playMonsterAnim re-anchors on
    // every facing change). One pooled anchor floated whole directions by up
    // to 9px and off-centre art (turtle east: feet 6px from frame centre) put
    // the shadow beside the body (maintainer 2026-07-30, round 2). The parked
    // frame is the direction's planted CONTACT frame, never an airborne f0.
    const g0 = def?.ground?.[DEFAULT_DIRECTION];
    if (hasArt) sprite.setFrame(g0?.contact ?? 0);
    sprite.setOrigin(g0?.cx ?? 0.5, g0?.f ?? def?.artBottom ?? 0.85).setScale(1);
    // THE TUNED SHADOW WINS. When the Game Master has placed this monster's
    // one shadow in the wiki, its centre IS the monster's position: the sprite
    // anchors there (one origin for every facing — the art rotates around the
    // shadow, exactly as the wiki previewed it), the ellipse turns with the
    // facing, and the body radius comes from its size. No record → the legacy
    // measured pipeline below, untouched.
    const tuned = monsterShadow(m.kind) ?? undefined;
    if (tuned && sprite.width > 0) {
      applyTunedOrigin(sprite, tuned, "idle", DEFAULT_DIRECTION, def?.artBottom, def?.hoverPx);
    }
    // Nadir shadow sized from the ART, not the frame (manifest-emitted:
    // ground-contact footprint blended toward body width — frame-scaled
    // shadows ran huge on padded frames and tiny on slim bodies, RED/GREEN).
    // For a TUNED monster shadowW/H hold the ellipse's worst-case extents over
    // all facings — they feed the off-screen cull margin, which must not
    // shrink when the monster turns its long side on.
    const shadowW = tuned
      ? Math.ceil(2 * Math.max(tuned.rx, tuned.ry / (this.geom.dy / this.geom.dx)))
      : (def?.shadowW ?? Math.round((def?.frameW ?? 48) * 0.54));
    const shadowH = tuned
      ? Math.ceil(2 * Math.max(tuned.ry, tuned.rx * (this.geom.dy / this.geom.dx)))
      : (def?.shadowH ?? Math.max(6, Math.round(shadowW * 0.385)));
    const e0 = tuned ? shadowScreenEllipse(tuned.rx, tuned.ry, DEFAULT_DIRECTION) : null;
    const shadow = this.add
      .image(p0.x, p0.y, MONSTER_SHADOW_TEX)
      .setOrigin(0.5, 0.5)
      .setDisplaySize(
        (e0 ? e0.p * 2 : shadowW) * MONSTER_SHADOW_SPREAD,
        (e0 ? e0.q * 2 : shadowH) * MONSTER_SHADOW_SPREAD,
      );
    if (e0) shadow.setRotation(e0.theta);
    if (artPending) shadow.setVisible(false);
    const mv: MonsterAvatar = {
      sprite,
      shadow,
      kind: m.kind,
      label,
      artPending,
      culled: artPending,
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
      tuned,
      // "The size will be the monsters hit box" — the tuned ellipse decides
      // the body radius the input-dodge slips around, same formula the server
      // fights with (shared shadowBodyRadius).
      radius: tuned ? shadowBodyRadius(tuned.rx, tuned.ry) : (def?.radius ?? DEFAULT_MONSTER_RADIUS),
      hoverPx: def?.hoverPx ?? 0,
      // Mirrored off the manifest so applyTunedOriginFor can run per frame
      // without a 57-entry scan (see MonsterAvatar.shState).
      artBottom: def?.artBottom,
      shState: tuned ? "idle" : undefined,
      walkKey: walk,
      attackKey: def ? resolveMonsterAnim(def, "attack") : undefined,
      angryKey: def ? resolveMonsterAnim(def, "angry") : undefined,
      dieKey: def ? resolveMonsterAnim(def, "die") : undefined,
      idleKey: def?.idleAnim ?? undefined,
      ground: def?.ground,
      groundIdle: def?.groundIdle ?? undefined,
      cycleWu: def?.gait?.cycleWu,
      travel: def?.gait?.travel,
      // Prefix sums of the travel weights: cum[i] = the fraction of the
      // cycle's ground already covered when frame i STARTS. The hop offset is
      // (cum − uniform progress) × cycleWu, which is 0 at both ends of the
      // cycle — so the surge never accumulates into drift.
      travelCum: def?.gait?.travel
        ? (() => {
            const t = def.gait!.travel!;
            const cum = [0];
            for (let i = 0; i < t.length; i++) cum.push(cum[i] + t[i] / t.length);
            return cum;
          })()
        : undefined,
    };
    // A tuned anchor already contains the hover gap — ay is tuned against the
    // art with the creature floating where it floats — so only legacy monsters
    // get the extra lift here.
    sprite.y = p0.y - (mv.tuned ? 0 : mv.hoverPx);
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
    const y = p.y - Math.max(g.elev ?? 0, p.lvl) * this.geom.lh;
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
    // GRAB ON THE EXACT FRAME (maintainer 2026-08-06: the item should vanish
    // "the exact frame the hand is closest to the ground actually picking up
    // that item"). The server removes the drop the moment it validates the
    // pickup, which is ~half the gesture EARLIER than the hand arrives — the
    // loot used to blink out while the character was still bending down. When
    // this is MY pickup and my avatar is playing the clip, hold the sprite and
    // let stepGroundDecor retire it on the measured grab frame. Everyone
    // else's pickups, TTL despawns and my own un-animated grabs are unchanged.
    if (id === this.pendingPickupId && !rec.grabbedAt) {
      const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
      const g = me && this.grabFrameFor(me);
      if (me && g) {
        rec.grabbedAt = this.time.now;
        rec.grabFrame = g.f;
        this.pendingPickupId = null; // the intent is satisfied; the art plays on
        return;
      }
    }
    rec.img.destroy();
    rec.shadow.destroy();
    this.drops.delete(id);
    if (this.pendingPickupId === id) this.pendingPickupId = null;
  }

  /** The measured grab frame for the avatar's CURRENT facing (the pickup
   * handler has already turned it toward the drop). Deliberately does NOT
   * require the clip to be playing yet: the drop's removal and the player's
   * `action` field arrive in the same state patch, and the removal listener
   * runs FIRST — demanding a live pickup clip here made the deferral never
   * engage at all. null → this character ships no measured grab. */
  private grabFrameFor(av: Avatar): { f: number } | null {
    const def = this.manifest.characters.find((c) => c.uid === av.character);
    const g = av.dispDir ? def?.grab?.[av.dispDir] : undefined;
    return g ? { f: g.f } : null;
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
      let halfW = Math.max(MONSTER_TAP_MIN_HALF_W, sp.displayWidth * 0.5 + 6);
      let top = sp.y - sp.displayHeight * sp.originY - 8;
      let bottom = sp.y + 10;
      if (mv.tuned) {
        // THE TAP BOX FOLLOWS THE TUNED SHADOW. Two things change under a
        // tuned anchor: the shadow he sized IS the hit box, and the art now
        // hangs BELOW the anchor (the legacy +10 assumed feet). Both are
        // UNIONED into the box — never subtracted: the finger-sized pads
        // (MONSTER_TAP_MIN_*) still win wherever they are bigger, because
        // missing small monsters is the complaint this box exists for.
        const p = mv.shadow.displayWidth * 0.5;
        const q = mv.shadow.displayHeight * 0.5;
        const cosT = Math.cos(mv.shadow.rotation), sinT = Math.sin(mv.shadow.rotation);
        // Axis-aligned half-extents of the ROTATED ellipse (exact, not a
        // bounding rect of the unrotated one — a turned mammoth is wider).
        const ex = Math.hypot(p * cosT, q * sinT);
        const ey = Math.hypot(p * sinT, q * cosT);
        halfW = Math.max(halfW, Math.abs(mv.shadow.x - mv.lx) + ex);
        top = Math.min(top, mv.shadow.y - ey);
        // THE ART'S BOTTOM, NOT THE FRAME'S. The frame is mostly transparent
        // padding on the big kinds, and reaching to it turns empty ground into
        // a monster tap: measured, mammoth gained 56px of pad (~3.7 cells of
        // ground south of it engaging instead of walking), diablo_2 11px.
        // artBounds is already cached by the scene for exactly this reason.
        const ab = this.artBounds(sp);
        const artLow = sp.y + (ab.y1 - sp.height * sp.originY) * (sp.displayHeight / sp.height);
        bottom = Math.max(bottom, mv.shadow.y + ey, artLow);
      }
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
        // WAIT FOR THE ALIGNED SPOT before grabbing (maintainer 2026-08-06):
        // being merely inside the pickup radius means the gesture would reach
        // into empty ground beside the loot. Hold until we are standing where
        // the hand actually lands on it — unless the trip has already ended
        // (path blocked / autopilot arrived as close as it can), which must
        // still grab rather than stand there forever.
        const spot = this.grabStandSpot(me, d.wx, d.wy);
        const aligned =
          !spot || !this.trip || Math.hypot(spot.x - me.fx, spot.y - me.fy) <= GRAB_ALIGN_WU;
        if (aligned && nowP >= this.nextPickupSendAt) {
          this.nextPickupSendAt = nowP + 400;
          this.room.send("pickup", { id: this.pendingPickupId });
        }
        if (aligned && this.trip) this.clearMoveTarget(); // arrived: stand for the grab
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

  /** Allocate the three cover atlases, once, at boot. Everything downstream
   * branches on `coverExact`, and the false side is the flat coverY crop this
   * feature shipped with — so a Canvas renderer, or a driver that refuses the
   * textures, degrades to the old behaviour instead of to no outline at all
   * (showing a line that could have been hidden is cosmetic; hiding one that
   * should show is the feature not working). */
  private initCoverSurfaces() {
    if (this.game.renderer.type !== Phaser.WEBGL) return;
    try {
      const mk = (key: string) => {
        if (this.textures.exists(key)) this.textures.remove(key);
        const dt = this.textures.addDynamicTexture(key, COVER_ATLAS_W, COVER_ATLAS_H);
        // NEAREST explicitly — addDynamicTexture does not inherit pixelArt's
        // default, and LINEAR smears the 2px outline into a halo (same trap
        // ringTextureFor documents).
        dt?.setFilter(Phaser.Textures.FilterMode.NEAREST);
        // Belt and braces on top of the integer placement in
        // coverDrawOccluders: a DynamicTexture's BaseCamera ships
        // renderRoundPixels true and nothing ever updates it, so a quad it
        // draws is snapped to the atlas grid. Every position we hand it is
        // already a whole texel, so this changes nothing today — it just stops
        // a future fractional draw from being silently re-registered.
        if (dt) (dt.camera as unknown as { renderRoundPixels: boolean }).renderRoundPixels = false;
        return dt ?? undefined;
      };
      this.coverE = mk("cover-E");
      this.coverC = mk("cover-C");
      this.coverO = mk("cover-O");
      this.coverExact = !!(this.coverE && this.coverC && this.coverO);
    } catch {
      this.coverExact = false;
    }
  }

  /** The reused off-display-list Image every atlas blit goes through (the
   * pattern nightlight already ships for its glow stamps: one object,
   * reconfigured and batchDraw'n per stamp inside a single beginDraw). */
  private coverBlitter(): Phaser.GameObjects.Image {
    if (!this.coverScratch)
      this.coverScratch = this.make.image({ x: 0, y: 0, key: "__MISSING", add: false }).setOrigin(0, 0);
    return this.coverScratch;
  }

  /** Give this body a slot, keeping the one it already has when the frame size
   * class is unchanged. Null = no slot (atlas full, or a frame larger than the
   * atlas) → BOTH consumers fall back, together. */
  private coverSlotFor(b: BodyVisual, w: number, h: number): CoverSlot | null {
    const cw = Math.ceil(w / 32) * 32;
    const ch = Math.ceil(h / 32) * 32;
    const cls = `${cw}x${ch}`;
    const cur = b.coverSlot;
    if (cur && cur.cls === cls) return cur;
    if (cur) this.releaseCoverSlot(b);
    const pool = this.coverFree.get(cls);
    let slot = pool && pool.length ? pool.pop() : undefined;
    if (!slot) slot = this.coverAllocSlot(cw, ch, cls) ?? undefined;
    // ANY FREE SLOT BIG ENOUGH WILL DO. The shelf cursor never rewinds, so once
    // the atlas is packed the only way to serve a body is to reuse a slot — and
    // keying the free pools strictly by class meant a returned 160x192 could
    // never serve a 96x96. Measured before this: allocation froze at 13 slots
    // after three teleports (25 in another run), and from then on every further
    // covered body silently fell back to the flat coverY line — the reported
    // defect, returning mid-session with no recovery, on the player's own body.
    // A larger slot leaves transparent margin nobody reads, exactly as a body
    // smaller than its own class box already does.
    if (!slot) slot = this.coverTakeLargerFree(cw, ch);
    // AND IF EVERY SLOT IS HELD, TAKE THE STALEST — never refuse.
    //
    // Recycling idle slots is not enough on its own: with the atlas packed and
    // every slot owned by a body that is still covered, a newcomer gets nothing
    // and falls back to the flat line FOREVER, decided by nothing but who
    // happened to be covered first. That is the maintainer's "it reverts when
    // you have played for a while" — and it lands on the player's own body as
    // readily as on a monster, because the player is just another body in the
    // queue. Eviction makes the failure GRACEFUL and self-healing instead:
    // whoever has gone longest without being drawn gives up its slot, so the
    // exact path always belongs to the bodies being looked at now, and a body
    // that loses one gets it straight back the moment it is covered again.
    // The atlas holds ~9-25 bodies against a handful covered at once, so this
    // is a backstop, not a working path — but a backstop that cannot fail is
    // the whole difference between a bug and a bounded resource.
    if (!slot) slot = this.coverEvictStalest(b, cw, ch);
    if (!slot) return null;
    b.coverSlot = slot;
    slot.owner = b;
    b.coverAt = this.coverTick;
    return slot;
  }

  /** Free the least-recently-drawn slot that fits, and hand it over. Never
   * takes a slot drawn THIS tick (those bodies are on screen right now) and
   * never the caller's own. */
  private coverEvictStalest(self: BodyVisual, cw: number, ch: number): CoverSlot | undefined {
    let victim: CoverSlot | undefined;
    let oldest = Infinity;
    for (const s of this.coverSlots) {
      const o = s.owner;
      if (!o || o === self || o.coverSlot !== s) continue;
      if (s.w < cw || s.h < ch) continue;
      const at = o.coverAt ?? 0;
      if (at >= this.coverTick) continue;
      if (at < oldest) {
        oldest = at;
        victim = s;
      }
    }
    if (!victim) return undefined;
    this.releaseCoverSlot(victim.owner!);
    const pool = this.coverFree.get(victim.cls);
    if (pool) {
      const i = pool.indexOf(victim);
      if (i >= 0) pool.splice(i, 1);
    }
    return victim;
  }

  /** The smallest free slot that fits — see coverSlotFor. Smallest so a run of
   * small bodies cannot eat the few boxes only a mammoth can use. */
  private coverTakeLargerFree(cw: number, ch: number): CoverSlot | undefined {
    let best: CoverSlot | undefined;
    let bestPool: CoverSlot[] | undefined;
    for (const pool of this.coverFree.values())
      for (const s of pool)
        if (s.w >= cw && s.h >= ch && (!best || s.w * s.h < best.w * best.h)) {
          best = s;
          bestPool = pool;
        }
    if (best && bestPool) bestPool.splice(bestPool.indexOf(best), 1);
    return best;
  }

  /** Reclaim slots from bodies that have stopped being covered.
   *
   * A slot used to be held until the body was destroyed or changed frame size,
   * so walking out from behind a rock kept it forever and the atlas only ever
   * filled. What bounds the atlas is the number of bodies covered AT ONCE, which
   * is small; what was filling it was every body ever covered. The grace period
   * is generous because re-acquiring is free while the atlas has room, and a
   * body stepping in and out of cover at a wall edge must not thrash. */
  private sweepCoverSlots() {
    if (!this.coverSlots.length) return;
    for (const s of this.coverSlots) {
      const b = s.owner;
      if (!b || b.coverSlot !== s) continue;
      if (this.coverTick - (b.coverAt ?? 0) > COVER_SLOT_GRACE) this.releaseCoverSlot(b);
    }
  }

  /** Shelf packer over the shared atlas rect. One Frame per slot per surface,
   * registered once and reused for its whole life — the frame rect is the
   * CLASS box, so a smaller body simply leaves transparent margin nobody
   * reads, and no frame is ever re-added. */
  private coverAllocSlot(w: number, h: number, cls: string): CoverSlot | null {
    if (!this.coverE || !this.coverC || !this.coverO) return null;
    const s = this.coverShelf;
    if (s.x + w > COVER_ATLAS_W) {
      s.y += s.h + COVER_GUTTER;
      s.x = 0;
      s.h = 0;
    }
    if (s.y + h > COVER_ATLAS_H || w > COVER_ATLAS_W) return null;
    const slot: CoverSlot = { i: this.coverSlots.length, x: s.x, y: s.y, w, h, name: `cs${this.coverSlots.length}`, cls };
    s.x += w + COVER_GUTTER;
    if (h > s.h) s.h = h;
    for (const t of [this.coverE, this.coverC, this.coverO]) t.add(slot.name, 0, slot.x, slot.y, slot.w, slot.h);
    this.coverSlots.push(slot);
    return slot;
  }

  private releaseCoverSlot(b: BodyVisual) {
    const slot = b.coverSlot;
    if (!slot) return;
    slot.owner = undefined;
    b.coverSlot = undefined;
    b.coverAt = undefined;
    let pool = this.coverFree.get(slot.cls);
    if (!pool) this.coverFree.set(slot.cls, (pool = []));
    pool.push(slot);
  }

  /** Appended to the TAIL of resolveBodyDepth — the ONE place that runs for
   * avatars, monsters AND NPCs before both consumers. Registering inside
   * syncCoverOutline instead would skip every body the two room guards
   * suppress, leaving their LIT COPIES on the flat crop while everyone else is
   * per-pixel: the outline and the lit copy would be cut on different rules.
   * `sprite.visible` first keeps the camera-culled bodies at zero cost. */
  private registerCoverSlot(b: BodyVisual) {
    b.coverAt = undefined;
    const sp = b.sprite;
    if (!this.coverExact || b.coverY === undefined || !sp.visible) return;
    // The atlas maps world px to frame px by integer translation, which is
    // only the identity at scale 1 (bodies and occluders both ship that).
    if (sp.scaleX !== 1 || sp.scaleY !== 1) return;
    const fw = sp.frame.cutWidth;
    const fh = sp.frame.cutHeight;
    if (!fw || !fh) return;
    if (!this.coverSlotFor(b, fw + RING_PAD * 2, fh + RING_PAD * 2)) return;
    b.coverAt = this.coverTick;
    this.coverQueue.push(b);
  }

  /** The slot a consumer may read THIS frame, or undefined → flat-crop path. */
  private coverSlotOf(b: BodyVisual): CoverSlot | undefined {
    return b.coverAt === this.coverTick ? b.coverSlot : undefined;
  }

  /** Bucket index over the drawn occluder + prop images, rebuilt with them
   * (i.e. once per OCC_STEP of camera drift, never per frame). Without it a
   * covered body scans 100-3,885 images every frame on the phone's CPU. */
  private rebuildCoverIndex() {
    this.coverBuckets.clear();
    this.coverGen++;
    if (!this.coverExact) return;
    const add = (im: Phaser.GameObjects.Image) => {
      if (!im.visible) return;
      const f = im.frame;
      const x0 = im.x - im.originX * f.cutWidth * im.scaleX;
      const y0 = im.y - im.originY * f.cutHeight * im.scaleY;
      const x1 = x0 + f.cutWidth * im.scaleX;
      const y1 = y0 + f.cutHeight * im.scaleY;
      for (let bx = Math.floor(x0 / COVER_BUCKET); bx <= Math.floor((x1 - 1) / COVER_BUCKET); bx++)
        for (let by = Math.floor(y0 / COVER_BUCKET); by <= Math.floor((y1 - 1) / COVER_BUCKET); by++) {
          const k = coverBucketKey(bx, by);
          let a = this.coverBuckets.get(k);
          if (!a) this.coverBuckets.set(k, (a = []));
          a.push(im);
        }
    };
    for (const im of this.occluders) add(im);
    for (const im of this.propImgs) add(im);
    /* SCENERY TOO. A tree is a prop that happens to sit off the grid, and a
     * body walking behind one must be covered by it exactly as by a boulder. */
    for (const im of this.sceneryImgs) add(im);
  }

  /** Everything drawn IN FRONT of this body that overlaps its padded frame box.
   * `depth > sprite.depth` is Phaser's own painter rule, which is exactly what
   * "covered" means on screen. The returned array is reused — consume it before
   * asking again. */
  private coverCandidates(sp: Phaser.GameObjects.Sprite, x0: number, y0: number, x1: number, y1: number) {
    const out = this.coverCands;
    out.length = 0;
    const seen = this.coverSeen;
    seen.clear();
    for (let bx = Math.floor(x0 / COVER_BUCKET); bx <= Math.floor((x1 - 1) / COVER_BUCKET); bx++)
      for (let by = Math.floor(y0 / COVER_BUCKET); by <= Math.floor((y1 - 1) / COVER_BUCKET); by++) {
        const a = this.coverBuckets.get(coverBucketKey(bx, by));
        if (!a) continue;
        for (const im of a) {
          if (seen.has(im)) continue;
          seen.add(im);
          if (!im.visible || im.depth <= sp.depth) continue;
          const f = im.frame;
          const l = im.x - im.originX * f.cutWidth * im.scaleX;
          const t = im.y - im.originY * f.cutHeight * im.scaleY;
          if (l >= x1 || l + f.cutWidth * im.scaleX <= x0 || t >= y1 || t + f.cutHeight * im.scaleY <= y0) continue;
          out.push(im);
        }
      }
    return out;
  }

  /** Draw the body's CURRENT frame into its slot, flip BAKED IN (so the slot is
   * in display space and every consumer draws it with flipX false). */
  private coverDrawBody(dt: Phaser.Textures.DynamicTexture, b: BodyVisual) {
    const sp = b.sprite;
    const s = b.coverSlot!;
    const im = this.coverBlitter();
    im.setTexture(sp.texture.key, sp.frame.name).setOrigin(0, 0).setFlipX(sp.flipX).setAlpha(1).clearTint();
    if (im.isCropped) im.setCrop();
    dt.batchDraw(im, s.x + RING_PAD, s.y + RING_PAD);
    this.coverStat.quads++;
  }

  /** Erase every covering occluder out of the body's slot.
   *
   * THE PLACEMENT IS AN INTEGER TRANSLATION, AND THAT IS EXACT, NOT A ROUNDING
   * FUDGE. A body's frame grid is not aligned to the world integer grid (its
   * origin is the measured foot anchor — 56.504px into a 112px frame), so an
   * occluder sits at a fractional offset q in the slot. But the two grids have
   * the SAME PITCH (both scale 1), so NEAREST sampling at offset q gives
   * literally the same texels as a whole-texel translation by ceil(q - 0.5):
   * slot texel k wants source texel floor(k + 0.5 - q) = k - ceil(q - 0.5).
   * That is exactly the CPU rule "which terrain texel is under this character
   * texel's centre", expressed as a translation — and expressing it that way
   * takes the engine's own sub-texel phase out of the answer. It has to be:
   * MEASURED (scripts/_tmp-iso2.mjs), a DynamicTexture's endDraw blit shifts
   * the Y phase of a fractionally-placed quad, which walked the cover boundary
   * one texel outward along every diamond edge (15 of 1,795 silhouette texels
   * at wallA, 0 after).
   *
   * Each image is then cropped to the slot's own window, or a 64x128 tile would
   * spill into the neighbouring slot. */
  private coverDrawOccluders(dt: Phaser.Textures.DynamicTexture, b: BodyVisual) {
    const sp = b.sprite;
    const s = b.coverSlot!;
    const fw = sp.frame.cutWidth;
    const fh = sp.frame.cutHeight;
    const wx0 = sp.x - sp.originX * fw - RING_PAD;
    const wy0 = sp.y - sp.originY * fh - RING_PAD;
    const W = fw + RING_PAD * 2;
    const H = fh + RING_PAD * 2;
    // ASK ABOUT THE ART BOX, NOT THE FRAME BOX. A character's frame is 112x112
    // and its drawn figure is 29x86 inside it, so querying the whole padded
    // frame admits every tile that overlaps three cells of empty margin — 80
    // candidates per body in mountain terrain (measured), against a median of
    // ~6 that can actually touch the figure. An occluder clear of the art box
    // cannot cover an opaque body texel, so skipping it changes no pixel: E is
    // the body MINUS the occluders, and outside the silhouette there is no
    // body to subtract from. The draw loop below still clips to the slot.
    const ab = this.artBounds(sp);
    // The slot bakes the flip in (coverDrawBody draws flipped), but these are
    // WORLD coordinates and the sprite on screen is mirrored about its own
    // frame box, so the art box mirrors with it.
    const ax0 = sp.flipX ? fw - ab.x1 : ab.x0;
    const ax1 = sp.flipX ? fw - ab.x0 : ab.x1;
    const qx0 = wx0 + RING_PAD + ax0 * sp.scaleX;
    const qx1 = wx0 + RING_PAD + ax1 * sp.scaleX;
    const qy0 = wy0 + RING_PAD + ab.y0 * sp.scaleY;
    const qy1 = wy0 + RING_PAD + ab.y1 * sp.scaleY;
    const cands = this.coverCandidates(sp, qx0, qy0, qx1, qy1);
    this.coverStat.cands += cands.length;
    for (const im of cands) {
      const f = im.frame;
      const ow = f.cutWidth;
      const oh = f.cutHeight;
      const ix = Math.ceil(im.x - wx0 - 0.5); // slot column of the image's col 0
      const iy = Math.ceil(im.y - wy0 - 0.5);
      const dx0 = Math.max(0, -ix);
      const dx1 = Math.min(ow, W - ix);
      const dy0 = Math.max(0, -iy);
      const dy1 = Math.min(oh, H - iy);
      if (dx1 <= dx0 || dy1 <= dy0) continue;
      let px = s.x + ix;
      const py = s.y + iy;
      const full = dx0 === 0 && dy0 === 0 && dx1 === ow && dy1 === oh;
      if (!full) {
        im.setCrop(dx0, dy0, dx1 - dx0, dy1 - dy0);
        // MEASURED (scripts/_tmp-cropflip.mjs): on a flipped object Phaser puts
        // the cropped window at display x = realWidth - x - width instead of at
        // x, so the sub-image lands mirrored about the frame centre. The content
        // it samples is right; only the registration is off, by this much.
        if (im.flipX) px += 2 * dx0 + (dx1 - dx0) - f.realWidth;
      }
      dt.batchDraw(im, px, py);
      this.coverStat.quads++;
      if (!full) im.setCrop();
    }
  }

  private coverDrawSlot(dt: Phaser.Textures.DynamicTexture, src: Phaser.Textures.DynamicTexture, s: CoverSlot, dx: number, dy: number, tint?: number) {
    const im = this.coverBlitter();
    im.setTexture(src.key, s.name).setOrigin(0, 0).setFlipX(false).setAlpha(1);
    if (tint === undefined) im.clearTint();
    else im.setTintFill(tint);
    if (im.isCropped) im.setCrop();
    dt.batchDraw(im, s.x + dx, s.y + dy);
    this.coverStat.quads++;
  }

  /** Build all three surfaces for every body that registered this frame, once,
   * after applyObjectLights — SEVEN draw brackets and three clears, CONSTANT in
   * body count (that is the whole reason for the atlas: on a tile-based mobile
   * GPU the charge is the render-pass switch, not the fill). Skipped entirely
   * when no slot's signature moved. */
  private flushCoverSurfaces() {
    const q = this.coverQueue;
    const E = this.coverE, C = this.coverC, O = this.coverO;
    this.coverStat.slots = q.length;
    if (!E || !C || !O || !q.length) {
      this.coverQueue = [];
      return;
    }
    let sig = String(this.coverGen);
    for (const b of q) {
      const sp = b.sprite;
      const s = b.coverSlot!;
      sig += `|${s.i},${sp.texture.key},${sp.frame.name},${sp.flipX ? 1 : 0},${Math.round(sp.x * 16)},${Math.round(sp.y * 16)},${Math.round(sp.depth * 8)}`;
    }
    if (sig === this.coverSig) {
      this.coverStat.skips++;
      this.coverQueue = [];
      return;
    }
    this.coverSig = sig;
    this.coverStat.flushes++;
    this.coverStat.quads = 0;
    this.coverStat.cands = 0;
    this.coverStat.brackets = 7;

    // E — what you can still SEE: the body, minus the terrain in front of it.
    E.clear();
    E.beginDraw();
    for (const b of q) this.coverDrawBody(E, b);
    E.endDraw();
    E.beginDraw();
    for (const b of q) this.coverDrawOccluders(E, b);
    E.endDraw(true);

    // C — what is COVERED: the body, minus what you can see. Complementary by
    // construction, so nothing has to keep two rules in agreement.
    C.clear();
    C.beginDraw();
    for (const b of q) this.coverDrawBody(C, b);
    C.endDraw();
    C.beginDraw();
    for (const b of q) this.coverDrawSlot(C, E, b.coverSlot!, 0, 0);
    C.endDraw(true);

    // O — the outline: the L1-ball-2 dilation of C in the outer colour, the
    // ball-1 dilation overpainted in the inner colour, then the body erased.
    // Per SLOT, never whole-atlas: 18 blits of a 1024x512 atlas is ~9.4 Mpix a
    // frame; 18 blits of a ~40x96 body is ~70 Kpix.
    O.clear();
    for (const pass of COVER_RING_PASSES) {
      O.beginDraw();
      for (const b of q) {
        const s = b.coverSlot!;
        for (const [dx, dy] of pass.offsets) this.coverDrawSlot(O, C, s, dx, dy, pass.color);
      }
      O.endDraw();
    }
    O.beginDraw();
    for (const b of q) this.coverDrawBody(O, b);
    O.endDraw(true);

    this.coverBlitter().clearTint();
    this.coverQueue = [];
    this.sweepCoverSlots();
  }

  /** The engagement overlays, per frame after the monster loop: (1) the red
   * target/aggro borders + the blue item border; (2) the settings debug
   * rings: every monster's aggro radius, plus the provoke radius on the
   * marked one. (The in-fight hp/level readout lives ON the monster —
   * updateMonsterHpBar.) */
  /**
   * THE WHITE OCCLUSION OUTLINE — the second half of the indoor cut-away
   * (maintainer 2026-08-07: "my solution was to go with a white pixel outline
   * on parts being behind something").
   *
   * The cut shortens a wall so you can look over it; this keeps whoever is
   * still behind what remains readable. It is the EXACT COMPLEMENT of the lit
   * copy: `syncLitCopy` crops that copy to [0, coverY) — the part of the body
   * you can see — so this draws the silhouette ring over [coverY, bottom), the
   * part you cannot. Between them they tile the figure with no seam and no
   * double-draw, because both are cut on the same number.
   *
   * WHY AN OUTLINE AND NOT TRANSPARENCY. The deleted see-through-walls sweep
   * (see games2/CLAUDE.md) re-tinted thousands of occluder images every frame
   * at 1.33ms/frame and never looked good; the culled-wall design after it left
   * holes. An outline costs ONE image per COVERED body, adds no state to the
   * terrain, and — being a border with no interior — cannot wash out the art it
   * marks. Not indoor-only: a body behind any cliff or tower gets it.
   *
   * Drawn at 900_001.43 — above the darkness overlay and every lit copy, below
   * the item ring (.44) and the monster target ring (.45), and far above every
   * occluder sprite (those sort at world y, in the low thousands). So no depth
   * work is needed to get the line over the wall; the band already does it.
   */
  private syncCoverOutline(b: BodyVisual) {
    const sp = b.sprite;
    const hide = () => {
      if (b.hidden?.visible) b.hidden.setVisible(false);
    };
    // A body that is not drawn has nothing hidden — this also covers the
    // camera-culled monsters (whose coverY is deliberately stale).
    if (!sp.visible || b.coverY === undefined) return hide();
    // INDOORS, nobody outside my room gets an outline. The line draws at
    // 900_001.43, ABOVE the darkness overlay, so it is immune to the zero
    // ambient that makes those bodies black — and a crisp white silhouette
    // around a figure you are meant to barely see out there inverts the whole
    // feature. The outline exists to show you who is behind YOUR walls.
    if (this.indoorOutside(b.fx, b.fy, b.surfLevel ?? 0)) return hide();
    // ...AND THE MIRROR OF IT: standing OUTSIDE, nobody sealed in a room gets
    // one either (maintainer 2026-08-08: "when standing next to the mountain
    // wall with the cave inside it I can see the monsters white outline. They
    // are indoors and I am outdoors, so this should not be possible" — the
    // outline was a wall-hack into the cave). The guard above only ever fired
    // while I was indoors; out here `roomMask` is null, so nothing stopped a
    // body under a mountain from being outlined through solid rock.
    //
    // The line is drawn at "sealed under a ROOM's roof that is not mine". A
    // body merely behind a cliff, a tower or a BRIDGE still gets its outline —
    // that is the feature, and roomAt() answers false for those. Someone in
    // the cave MOUTH is not sealed either: an entrance cell has no slab over
    // it, so they outline normally, which is what the maintainer asked for.
    if (this.inHiddenRoom(b.fx, b.fy, b.surfLevel ?? 0)) return hide();
    // Frame-space y of the covering terrain's top line, exactly as syncLitCopy
    // computes it — the two MUST agree or the body shows a gap or a seam.
    const frameTop = sp.y - sp.displayHeight * sp.originY;
    const cropH = (b.coverY - frameTop) / sp.scaleY;
    const ab = this.artBounds(sp);
    const fw = sp.frame.cutWidth;
    const fh = sp.frame.cutHeight;
    const slot = this.coverSlotOf(b);
    // THE FLAT LINE MAY NOT VETO THE EXACT PATH. `coverY` is the top of the
    // covering column's 64px IMAGE BOX, so a low occluder in front of the feet
    // can put it below the art while genuinely covering texels — measured at
    // (165,126): 95 covered texels of 1840 and no outline drawn at all, because
    // this early-out fired before the slot was consulted. With a slot the O
    // surface answers for itself: when nothing is covered it is empty and the
    // image draws nothing, which costs one transparent quad and cannot lie.
    if (!slot && cropH >= ab.y1) return hide();
    const key = slot ? this.coverO!.key : this.ringTextureFor(sp, HIDDEN_RING_COLOR, HIDDEN_RING_BRIGHT);
    if (!key) return hide();
    let img = b.hidden;
    if (!img) {
      img = this.add.image(0, 0, key).setVisible(false);
      b.hidden = img;
    }
    // Same sync chain as the target rings, and for the same reasons: position
    // from the LIVE sprite (lit copies sync later in the frame and smear a
    // hopping body sideways), and shift the origin by RING_PAD because the
    // outline canvas is the frame padded on every side. The cover SLOT is the
    // same padded box (rounded up to its size class), so the only thing that
    // changes is the denominator — and the flip, which is baked into the slot.
    const sw = slot ? slot.w : fw + RING_PAD * 2;
    const sh = slot ? slot.h : fh + RING_PAD * 2;
    // THE BORDER TAKES THE LIGHT — but never all of it (maintainer 2026-08-09:
    // "especially at night the white is so extreme it becomes so much easier to
    // see things behind walls vs in front of walls... visible but not stand out
    // like crazy"). It draws ABOVE the darkness overlay so nothing dims it, and
    // full-brightness white against a night world reads brighter than anything
    // actually lit — the hidden body ended up the most legible thing on screen,
    // which inverts the point of hiding it.
    //
    // Same sample the LIT COPY uses (litLevelOf + lightAt at the body's own
    // surface height), so the ring dims with the hour, darkens in a wall's
    // shadow and warms inside a torch pool, exactly as the body it traces
    // would. The FLOOR is what keeps it a feature rather than a fade: at night
    // ambient luma is ~0.10 and an honest multiply would leave the line
    // essentially black, i.e. the wall-hack switched off after sunset.
    // RING_LIGHT_FLOOR is the one dial — 1.0 restores the old flat white.
    let ringTint = 0xffffff;
    if (this.night) {
      const l = this.night.lightAt(b.fx / CELL_WU, b.fy / CELL_WU, this.litLevelOf(b), false);
      const ch = (v: number) =>
        Math.min(255, Math.round(255 * (RING_LIGHT_FLOOR + (1 - RING_LIGHT_FLOOR) * Math.min(1, Math.max(0, v)))));
      ringTint = (ch(l[0]) << 16) | (ch(l[1]) << 8) | ch(l[2]);
    }
    img
      .setTexture(key, slot ? slot.name : undefined)
      .setOrigin((sp.originX * fw + RING_PAD) / sw, (sp.originY * fh + RING_PAD) / sh)
      .setScale(sp.scaleX, sp.scaleY)
      .setFlipX(slot ? false : sp.flipX)
      .setPosition(sp.x, sp.y)
      .setAlpha(1)
      .setTint(ringTint)
      .setDepth(900_001.43)
      .setVisible(true);
    if (slot) {
      // THE PIXEL-EXACT PATH. The O surface already IS the ring of the covered
      // sub-silhouette — a diagonal wall top, a doorway, a tree trunk — so
      // there is nothing left to crop. (maintainer 2026-08-09: "the effect is
      // just a line that is not close to the exact pixels that are actually
      // behind something"; the flat coverY line was one horizontal row across
      // the whole body, measured 71.5% false positives.)
      if (img.isCropped) img.setCrop();
    } else if (cropH <= ab.y0 + 2) {
      // FALLBACK, unchanged: completely hidden — the whole silhouette is the
      // outline, the inverse of syncLitCopy's setVisible(false) on this test.
      if (img.isCropped) img.setCrop();
    } else {
      // The crop lives in the PADDED frame, so every sprite-frame y needs
      // + RING_PAD — a crop computed in sprite-frame pixels is silently 2px
      // high and clips the top row of the line off.
      const cut = cropH + RING_PAD;
      img.setCrop(0, cut, fw + RING_PAD * 2, fh + RING_PAD * 2 - cut);
    }
    // THE WATER CUT (maintainer 2026-08-09: "when swimming behind a wall the
    // entire body now gets the wall-hack effect while only the top of the
    // players body should"). The outline was the ONE body layer that never got
    // the waterline mask — updateWaterClip puts it on the base sprite and
    // applyObjectLights puts the SAME object on the lit copy, so the ring was
    // tracing the submerged legs through open water.
    //
    // Read `sp.mask`, never `swimming`/`swimT`: that is the same OBJECT the
    // body itself is cut with, so the two cannot disagree — including in all
    // three of updateWaterClip's bail-outs (not swimming, swimT<=0.001, no
    // waterline span), where `sp.mask` is null and the outline is whole again
    // in the SAME frame. Monsters and NPCs never swim, so `sprite.mask` is
    // always null for them and this is a no-op.
    if (sp.mask) {
      if (img.mask !== sp.mask) img.setMask(sp.mask);
    } else if (img.mask) img.clearMask();
  }

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
        mv2.sprite.visible &&
        // Above the overlay (900_001.45), so zero ambient cannot dim it — a
        // monster outside my room keeps no red ring while I am indoors.
        !this.indoorOutside(mv2.fx, mv2.fy, mv2.surfLevel);
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
    // THE WHITE OCCLUSION OUTLINE, for every body the camera can see. Here and
    // not in the body loops because `coverY` is written by resolveBodyDepth,
    // which runs for NPCs, avatars and monsters BEFORE this — and read by
    // syncLitCopy in applyObjectLights, which runs AFTER. This is the one point
    // in the frame where the number is fresh for all three.
    for (const av of this.avatars.values()) this.syncCoverOutline(av);
    for (const mv2 of this.monsters.values()) this.syncCoverOutline(mv2);
    for (const nv of this.npcs.values()) this.syncCoverOutline(nv);
    this.updateChessPrompt();

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

    this.drawCollisionDebug();
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
          const lift = (sm.elev ?? 0) * this.geom.lh;
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

  /** Paint what really holds the body — BOTH layers, because they are not the
   *  same shape and telling them apart is the whole point (maintainer
   *  2026-08-30: "the show hitbox button should show both what the nav
   *  navigates around and the real ellipse hitbox").
   *
   *  Four marks, each answering a different question:
   *
   *   RED diamond    TERRAIN — ground `canEnter` refuses on its own: a wall, a
   *                  cliff step, deep water, a maps2 prop. Asked on a view of
   *                  the grid with the SCENERY TAKEN OUT (`bareTerrain`), so a
   *                  tree leaning against a house still reads as house, and so
   *                  the rules (climb, stairs, swim, decks) stay canEnter's own
   *                  instead of being re-derived here to drift.
   *   AMBER diamond  NAV — a cell the scenery closes completely: no body centre
   *                  fits anywhere inside it, so findPath routes around it.
   *                  DERIVED from the ellipses and deliberately SMALLER than
   *                  they are — 2,568 cells on the_game against the 3,185 the
   *                  old raster claimed. A piece the body can slide past closes
   *                  no cell at all and shows only as its outline, which is the
   *                  maintainer's rule: "that object might be invisible for the
   *                  nav system because the player will be able to run by that
   *                  object by sliding around the object".
   *   TEAL ellipse   THE FOOTPRINT ITSELF — the collision truth, the shape the
   *                  body actually stops against. Stroked straight in SCREEN px
   *                  at the piece's own screen position, which is the space the
   *                  wiki drew it in, so nothing on the way here can distort it.
   *                  VIOLET when a semi-axis sits at MIN_FOOTPRINT_SEMI: that
   *                  piece collides WIDER than drawn, because under 4.5wu the
   *                  six movement probes step clean over it (50 of the_game's
   *                  1,747 — the waystone with "no hitbox at all").
   *   WHITE ellipse  MY OWN BODY at PLAYER_RADIUS (12wu), on the ground under
   *                  me — so "does it stop exactly at the edge" is something to
   *                  LOOK at rather than something to believe. Its skin should
   *                  kiss a teal outline and never cross it; the axis probes
   *                  reach 0.75R sideways as well, so a corner can hold you
   *                  hypot(12,9) = 15wu out.
   *
   *  Only near the player: the grid is 512x512 and this is a debug aid, not a
   *  render path. */
  private drawCollisionDebug(): void {
    if (!this.collisionGfx && this.collisionOn) {
      /* AN X-RAY, ABOVE THE ART. Under the world it is invisible exactly where
       * it matters: a wall cell's marker sits on the GROUND, and the wall's own
       * art stands over that spot and hides it — so the overlay showed every
       * footprint on open grass and nothing at all on the building he could not
       * walk into. Over the top, it reads as the floor plan it is meant to be. */
      this.collisionGfx = this.add.graphics().setDepth(900_002.5);
    }
    const gfx = this.collisionGfx;
    if (!gfx) return;
    gfx.clear();
    const t = this.terrain;
    if (!this.collisionOn || !t) return;
    const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
    if (!me) return;
    const RANGE = 16; // cells each way — a screen's worth on a phone
    const c0 = Math.floor(me.fx / CELL_WU);
    const r0 = Math.floor(me.fy / CELL_WU);
    /* ONE PLANE — THE PLAYER'S. Lifting each mark to its own cell's surface put
     * a wall's marker up on the roof, six levels above the ground it actually
     * stops you on, so a building read as a patch of colour floating over its
     * own tiles. What this overlay is FOR is a floor plan of where the body may
     * go, so every mark — diamonds and ellipses alike — sits on the plane the
     * body is standing on. */
    /* ONE LEVEL FOR EVERY MARK — the player's — and ONE PROJECTION, the
     * ground's (projectCellCorner). Mixing the two conventions is what put the
     * footprint ellipses 4 px above the cells they block. */
    const meLevel = me.surfLevel ?? 0;
    const bare = this.bareTerrain(t);
    for (let r = r0 - RANGE; r <= r0 + RANGE; r++) {
      if (r < 0 || r >= t.height) continue;
      for (let c = c0 - RANGE; c <= c0 + RANGE; c++) {
        if (c < 0 || c >= t.width) continue;
        const i = r * t.width + c;
        /* WALLS ARE ELEVATION, NOT `blocked`. The first cut drew only the
         * blocked array and so showed footprints while leaving the house he
         * could not walk into completely unmarked — the one thing he was
         * looking at. What a player means by "can I go there" is canEnter from
         * where he stands, which folds in the climb, water and deck rules too,
         * so ask exactly that — of the terrain alone. */
        const terrain = !canEnter(bare, me.fx, me.fy, (c + 0.5) * CELL_WU, (r + 0.5) * CELL_WU, {
          maxClimb: WALK_CLIMB,
          canSwim: true,
        });
        // Terrain wins the colour where both hold: a wall with a tree against
        // it is a wall, and painting it amber is how the house he could not
        // enter would go back to looking like set dressing.
        const nav = !terrain && t.sceneryBlocked?.[i] === true;
        if (!terrain && !nav) continue;
        const pts = [
          [c, r],
          [c + 1, r],
          [c + 1, r + 1],
          [c, r + 1],
        ].map(([cx, cy]) => this.projectCellCorner(cx, cy, meLevel));
        gfx.fillStyle(terrain ? 0xf25d5d : 0xffa94d, 0.3);
        gfx.fillPoints(pts, true);
        gfx.lineStyle(1, terrain ? 0xff8787 : 0xffc078, 0.85);
        gfx.strokePoints(pts, true);
      }
    }
    /* THE REAL HITBOX, LAST, SO IT LIES OVER THE CELLS IT PRODUCED. A footprint
     * is published as an iso ellipse in SCREEN px about a centre in CELLS, and
     * projectFlat's own formula turns that centre into the same screen point
     * the art is drawn at — after which rx/ry need no arithmetic whatsoever,
     * because the projection is exactly what they were measured through. The
     * clamp inside projectFlat is deliberately not used: it exists to keep a
     * BODY on the map, and dragging a footprint centre inward would draw the
     * outline somewhere its owner is not. */
    const { dx, dy } = this.geom;
    const floorRx = (MIN_FOOTPRINT_SEMI / CELL_WU) * dx * Math.SQRT2;
    const floorRy = (MIN_FOOTPRINT_SEMI / CELL_WU) * dy * Math.SQRT2;
    /* THE OUTLINE HANGS OFF THE ART'S OWN ANCHOR, not off projectFlat.
     *
     * projectFlat answers where a BODY's feet go, and that convention is +DX
     * right and +DY below a cell's anchor and carries no elevation at all — it
     * returns the level rather than applying it. Drawing footprints through it
     * therefore put every outline 32px right and 14px low of the piece it
     * belongs to (maintainer 2026-09-02: "all hitboxes are a bit lowered
     * compared to the wiki"), and pinned them to the PLAYER's plane, so a piece
     * standing on any other level was wrong by a whole storey as well ("when I
     * look at objects at a different elevation I feel as if the hitbox can be
     * very wrong"). Both were mine, and both are the same mistake: re-deriving a
     * projection beside the one the art already uses.
     *
     * A placement carries `ax`/`ay` — anchorX/anchorY, the exact screen point
     * the sprite is drawn from, with that piece's own level already in it. The
     * ellipse centre is a world offset from the anchor, so it is that same
     * offset projected: sx = (ox-oy)*dx, sy = (ox+oy)*dy, which is precisely the
     * mapping stampSceneryCollision inverted to place the centre. Outline and
     * art now share one anchor and cannot drift again. */
    const byIndex = this.footprintAnchors();
    for (const f of footprintsInCells(t, c0 - RANGE, r0 - RANGE, c0 + RANGE, r0 + RANGE)) {
      const pl = byIndex.get(f.place);
      if (!pl) continue; // off-window: the art is not placed, so nothing to mark
      const ox = f.cx - pl.x;
      const oy = f.cy - pl.y;
      const ex = pl.ax + (ox - oy) * dx;
      const ey = pl.ay + (ox + oy) * dy;
      const widened = f.rx <= floorRx + 1e-6 || f.ry <= floorRy + 1e-6;
      gfx.lineStyle(1, widened ? 0xb197fc : 0x3bc9db, 0.95);
      gfx.strokeEllipse(ex, ey, f.rx * 2, f.ry * 2, 44);
      // A centre tick: a hitbox parked off its own art is the fault that is
      // hardest to see from the outline alone (it just looks like the wrong
      // size), and it is the one the wiki editor fixes.
      gfx.lineBetween(ex - 3, ey, ex + 3, ey);
      gfx.lineBetween(ex, ey - 3, ex, ey + 3);
    }
    /* AND MY OWN BODY, so the standoff can be READ off the screen: a world
     * circle of PLAYER_RADIUS projects to the axis-aligned screen ellipse with
     * semi-axes R*dx*SQRT2 and R*dy*SQRT2 in cells (the singular values of
     * [[dx,-dx],[dy,dy]]) — the same identity the footprints are stored under,
     * so the two shapes are drawn by one rule and cannot disagree. */
    const bp = this.projectCellCorner(me.fx / CELL_WU, me.fy / CELL_WU, meLevel);
    const brx = (PLAYER_RADIUS / CELL_WU) * dx * Math.SQRT2;
    const bry = (PLAYER_RADIUS / CELL_WU) * dy * Math.SQRT2;
    gfx.lineStyle(1, 0xffffff, 0.8);
    gfx.strokeEllipse(bp.x, bp.y, brx * 2, bry * 2, 36);

    /* AND THE BODIES — MONSTERS AND NPCS (maintainer 2026-09-02: "should show
     * the collision for NPCs and monsters as well").
     *
     * These are the one collision on the map that owns NO CELL AND NO
     * FOOTPRINT: they are deliberately kept out of the grid entirely (no
     * network cost, no pathfinder cost — maintainer 2026-07-30), and the INPUT
     * dodges a radius instead. So nothing above this line can ever draw them,
     * and without their own mark the overlay would answer "what stops me?" with
     * everything except the thing walking towards him.
     *
     * TWO RINGS, because there are two honest answers and they differ by more
     * than half a body:
     *   GREEN SOLID  the body itself, `radius` — for a tuned monster that is
     *                shadowBodyRadius of the wiki's own shadow, which is why it
     *                can differ per monster and per state.
     *   GREEN FAINT  where the dodge actually turns him: radius + his own
     *                PLAYER_BODY_RADIUS + MONSTER_DODGE_MARGIN. He never
     *                touches the inner ring, and being unable to see why was
     *                the same complaint as the footprints.
     * Each sits on the BODY's own elevation (already a pixel lift), not the
     * player's plane — the aggro rings' rule. A monster up on a deck draws its
     * circle under itself rather than on the floor below. */
    const ring = (wx: number, wy: number, r: number, px: number, colour: number, alpha: number) => {
      const p = this.projectCellCorner(wx / CELL_WU, wy / CELL_WU, 0);
      gfx.lineStyle(1, colour, alpha);
      gfx.strokeEllipse(
        p.x,
        p.y - px,
        (r / CELL_WU) * dx * Math.SQRT2 * 2,
        (r / CELL_WU) * dy * Math.SQRT2 * 2,
        36,
      );
    };
    const self = PLAYER_BODY_RADIUS + MONSTER_DODGE_MARGIN;
    this.monsters.forEach((mv) => {
      if (Math.abs(mv.fx - me.fx) > 400 || Math.abs(mv.fy - me.fy) > 400) return;
      ring(mv.fx, mv.fy, mv.radius, mv.elev, 0x51cf66, 0.95);
      ring(mv.fx, mv.fy, mv.radius + self, mv.elev, 0x51cf66, 0.35);
    });
    this.npcs.forEach((npc) => {
      if (Math.abs(npc.fx - me.fx) > 400 || Math.abs(npc.fy - me.fy) > 400) return;
      ring(npc.fx, npc.fy, NPC_BODY_RADIUS, npc.elev, 0x51cf66, 0.95);
      ring(npc.fx, npc.fy, NPC_BODY_RADIUS + self, npc.elev, 0x51cf66, 0.35);
    });
  }

  /** Placements by their world index, for the collision overlay: the footprint
   *  table names a placement by index and the overlay needs that placement's
   *  own screen anchor. Cached against the index object, which is rebuilt
   *  whenever the window moves. */
  private anchorCache?: { of: unknown; map: Map<number, SceneryPlacement> };
  private footprintAnchors(): Map<number, SceneryPlacement> {
    const idx = this.scenery;
    if (this.anchorCache?.of !== idx) {
      const map = new Map<number, SceneryPlacement>();
      for (const p of idx?.placements ?? []) map.set(p.i, p);
      this.anchorCache = { of: idx, map };
    }
    return this.anchorCache.map;
  }

  /** The same grid with the SCENERY TAKEN OUT: no `footprints`, so the ellipse
   *  query answers false, and `blocked` back to the terrain half it used to
   *  mean. The overlay asks canEnter on this to decide whether a cell is
   *  refused by the GROUND, instead of re-deriving canEnter's climb/stairs/
   *  swim/deck rules beside it and letting the copy drift.
   *
   *  Cached per grid object: the terrain half is fixed once built (only the
   *  scenery re-stamps), and a fresh spread per cell would be 1,089 objects a
   *  frame. Read-only — `blocked` here IS `propBlocked`, not a copy of it. */
  private bareGrid?: { of: TerrainGrid; view: TerrainGrid };
  private bareTerrain(t: TerrainGrid): TerrainGrid {
    if (this.bareGrid?.of !== t) {
      this.bareGrid = {
        of: t,
        view: { ...t, blocked: t.propBlocked, sceneryBlocked: undefined, footprints: undefined },
      };
    }
    return this.bareGrid.view;
  }

  private toggleCollision(on = !this.collisionOn) {
    this.collisionOn = on;
    try {
      localStorage.setItem("ml-collision", on ? "1" : "0");
    } catch {}
    if (!on) this.collisionGfx?.clear();
    this.chat.addLog("—", `Collision overlay: ${on ? "on" : "off"}`);
    // The legend on its own line: the marks do not fit on the end of a
    // sentence, and this overlay is unreadable without knowing which is which.
    if (on)
      this.chat.addLog(
        "—",
        "red = terrain · amber = a cell the nav routes around · teal = the REAL hitbox ellipse " +
          "(violet = widened to the minimum) · white = your body · green = a monster or NPC body, " +
          "faint green = where its dodge turns you",
      );
    return this.collisionOn;
  }

  private toggleAggroRadius(on = !this.aggroRadiusOn) {
    this.aggroRadiusOn = on;
    try {
      localStorage.setItem("ml-aggro-radius", on ? "1" : "0");
    } catch {}
    this.chat.addLog("—", `Aggro radius: ${on ? "on" : "off"}`);
    return this.aggroRadiusOn;
  }

  /** DISABLE AGGRO — stop monsters noticing me on their own, so a cave can be
   * walked through and looked at (maintainer 2026-08-07).
   *
   * The switch lives on the SERVER (per session, see WorldRoom's "noaggro"),
   * because that is where the proximity scan runs; the client only owns the
   * preference and re-sends it on every join. It suppresses UNPROVOKED aggro
   * only: raise your sword at something and it still comes, hit something and
   * it still fights back. Turning it ON also releases whatever is already
   * chasing you unprovoked — otherwise you would have to outrun the thing that
   * noticed you first, which is exactly the situation it exists for. */
  private toggleNoAggro(on = !this.noAggroOn) {
    this.noAggroOn = on;
    try {
      localStorage.setItem("ml-no-aggro", on ? "1" : "0");
    } catch {}
    this.room?.send("noaggro", { on });
    this.chat.addLog("—", `Aggro: ${on ? "DISABLED — nothing will jump you" : "back on"}`);
    return this.noAggroOn;
  }

  /** The PICKUP BUTTON / F key: grab the nearest ground item — immediately
   * when in reach, else walk to it first (same flow as tapping it). */
  /** WHERE TO STAND so the pickup gesture lands ON the item (maintainer
   * 2026-08-06: "walk to the location where the hand in the pick up animation
   * is as close as possible … so the animation at that angle align perfectly
   * with the item"). The manifest measures, per direction, the screen offset
   * from the character's foot anchor to the spot its hand reaches — so the
   * stand position is simply itemPos − thatOffset, back-projected into world
   * units. We get to choose the FACING, so try all eight and take the one
   * whose stand spot is the shortest walk from here: the character then
   * approaches naturally and ends up reaching exactly at the loot.
   * Returns null when the character ships no measured grab (older art) — the
   * caller then falls back to walking at the item itself, as before. */
  private grabStandSpot(
    av: Avatar,
    wx: number,
    wy: number,
  ): { x: number; y: number; dir: string } | null {
    const def = this.manifest.characters.find((c) => c.uid === av.character);
    const grab = def?.grab;
    if (!grab) return null;
    const fw = def?.frameW ?? 0;
    const fh = def?.frameH ?? 0;
    if (!fw || !fh) return null;
    let best: { x: number; y: number; dir: string; d: number } | null = null;
    for (const [dir, g] of Object.entries(grab)) {
      // Frame fractions → screen px → world units (the same inverse iso the
      // gait speed measurement uses: Δsx = Δ(x−y)·dx/CELL, Δsy = Δ(x+y)·dy/CELL).
      const sx = g.x * fw;
      const sy = g.y * fh;
      let ox: number;
      let oy: number;
      if (this.world) {
        const dDiff = (sx * CELL_WU) / this.geom.dx; // Δ(x−y)
        const dSum = (sy * CELL_WU) / this.geom.dy; // Δ(x+y)
        ox = (dSum + dDiff) / 2;
        oy = (dSum - dDiff) / 2;
      } else {
        ox = sx;
        oy = sy;
      }
      const px = wx - ox;
      const py = wy - oy;
      const d = Math.hypot(px - av.fx, py - av.fy);
      if (!best || d < best.d) best = { x: px, y: py, dir, d };
    }
    return best ? { x: best.x, y: best.y, dir: best.dir } : null;
  }

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
      this.walkToGrab(me, d.wx, d.wy);
    }
  }

  /** Walk to the spot where the pickup gesture reaches the item (grabStandSpot),
   * falling back to the item itself when the character ships no measured grab.
   * Blue item border, never the ground beacon. */
  private walkToGrab(av: Avatar, wx: number, wy: number) {
    const spot = this.grabStandSpot(av, wx, wy);
    const tx = spot ? spot.x : wx;
    const ty = spot ? spot.y : wy;
    this.setMoveTarget(tx, ty, true, false, undefined, false);
  }

  private removeMonster(id: string) {
    const mv = this.monsters.get(id);
    if (!mv) return;
    mv.lit?.destroy();
    mv.fog?.destroy();
    this.releaseCoverSlot(mv);
    mv.hidden?.destroy();
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

  /** The wooden grave cross (scenery/grave_cross, the maintainer's PixelLab
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
      this.load.spritesheet(KEY, withV("/assets/scenery/grave_cross/animations/appear__south.webp"), {
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
  /** Fire each armed pickup sound on the frame that avatar's hand closes on
   * the item — the same measured frame stepGroundDecor retires the drop on, so
   * the sound and the item disappearing are the same instant.
   *
   * The safety valve matters as much as the trigger: a pickup clip can be cut
   * short by a hit, a respawn or a hidden tab, and a sound armed forever would
   * fire on some unrelated pickup much later. If the gesture is over and the
   * frame never arrived, play it then — late by a few frames beats silent, and
   * beats a stray sound minutes afterwards. */
  private stepPickupSfx() {
    const now = this.time.now;
    for (const [id, av] of this.avatars) {
      if (av.pickupSfxAt == null) continue;
      const playing = /:pickup:/.test(av.sprite.anims.getName() ?? "");
      const reached = playing && frameIndexOf(av.sprite.texture.key) >= (av.pickupSfxFrame ?? 0);
      // 850 ms is the gesture length set where the action arrives; give it a
      // little margin before giving up on the frame.
      if (!reached && now - av.pickupSfxAt < 1000) continue;
      av.pickupSfxAt = null;
      av.pickupSfxFrame = null;
      const sp = this.avatarSpatial(id);
      gameAudio.event("item.pickup", { pan: sp.pan, dist: sp.dist });
    }
  }

  private stepGroundDecor() {
    const now = this.time.now;
    // A drop being GRABBED lingers past the server's removal until my pickup
    // clip reaches the measured frame the hand closes on it. Safety valve: if
    // the clip is interrupted (a hit, a respawn, the tab hidden), retire it on
    // a timeout instead of leaving a phantom item lying there forever.
    for (const [id, rec] of [...this.drops]) {
      if (!rec.grabbedAt) continue;
      const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
      const anim = me?.sprite.anims.getName() ?? "";
      // Character frames are PER-FRAME TEXTURES keyed f:<uid>:<state>:<dir>:<n>
      // (only monsters use numbered spritesheet frames), so the index comes
      // from the texture key — frame.name is not a number here and parsing it
      // pinned every read at 0, which let the clip run to its end instead.
      const frame = frameIndexOf(me?.sprite.texture.key);
      const playing = /:pickup:/.test(anim);
      if (playing) rec.sawPickup = true;
      // Retire when the hand closes on it; or when the clip has come and gone
      // (interrupted by a hit/respawn); or on a timeout, so a pickup clip that
      // never starts cannot strand a phantom item on the ground.
      const grabbed = playing && frame >= (rec.grabFrame ?? 0);
      const clipOver = rec.sawPickup && !playing;
      if (grabbed || clipOver || now - rec.grabbedAt > 1200) {
        // Record WHY and WHEN, for the gate: polling from the outside cannot
        // resolve a ~77ms animation frame, so the client reports the exact
        // frame it retired the item on.
        this.lastGrabRetire = {
          frame,
          grabFrame: rec.grabFrame ?? null,
          anim,
          via: grabbed ? "grab-frame" : clipOver ? "clip-ended" : "timeout",
          heldMs: Math.round(now - rec.grabbedAt),
        };
        rec.img.destroy();
        rec.shadow.destroy();
        this.drops.delete(id);
      }
    }
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
      // A drop lying outside my room is DRAWN and goes black with the ground
      // under it — no special case. The art only shows once its texture has
      // landed: a drop still on "__MISSING" must stay hidden.
      // ...and a drop resting on terrain the cut removed is hidden with it —
      // same rule as the bodies (see aboveCut). `wx/wy` is the FLAT world
      // position; the level it lies on is the terrain there.
      const dropLvl = this.terrain
        ? this.terrain.level[
            Math.floor(rec.wy / CELL_WU) * this.terrain.width + Math.floor(rec.wx / CELL_WU)
          ] ?? 0
        : 0;
      const out = rec.img.texture.key === "__MISSING" || this.aboveCut(dropLvl, rec.wx, rec.wy);
      rec.img.setVisible(!out);
      rec.shadow.setVisible(!out);
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
      (m.hp < m.hpMax || m.mstate === "combat" || this.engagedId === id) &&
      // The bar, the name and the Lv/HP text sit at 900_001.5-1.7, above the
      // darkness overlay: indoors they would be the only readable thing on a
      // monster that is otherwise a black silhouette out on the grass.
      !this.indoorOutside(mv.fx, mv.fy, mv.surfLevel);
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

  /** A blood spatter on a struck body (scenery/blood_spatter, the
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
  /** Per-monster SEMANTIC EVENTS for the wiki's sound card: one per animation
   * state, `monsters.<kind>.<idle|walk|angry|attack>` — the id shape the wiki
   * agent specified (`<domain>.<entityId>.<action>`, e.g. monsters.mammoth.attack).
   * Every one of them is SILENT until the Game Master assigns a sound on the
   * monster's wiki page; emitting them is what makes the card able to offer
   * them at all.
   *
   * The whole difficulty here is CADENCE, because two of the four states LOOP
   * and the_island2 ships 160 monsters:
   *   · attack — a true one-shot, fired off the same `actionSeq` change that
   *     restarts the swing clip, so the sound lands exactly on the swing.
   *   · walk  — once per GAIT CYCLE, detected by the clip's own progress
   *     wrapping. That makes it a footfall: it already scales with speed,
   *     because round 13 paces the walk clip by ground covered, so a chasing
   *     body steps faster without a second cadence to keep in sync.
   *   · idle / angry — periodic with a per-individual jittered gap, so a pack
   *     breathes and growls out of phase instead of in chorus.
   * On top of that: culled (off-screen) bodies are silent, the dying are left
   * to combat.monster_die, and a GLOBAL budget caps how many monster sounds
   * may start in any one second — a visible herd must never machine-gun. */
  private monsterSfx(mv: MonsterAvatar, moving: boolean, mstate: string, actionSeq: number): void {
    if (mv.culled || mstate === "die") return;
    const now = this.time.now;
    const fire = (action: string) => {
      // Global budget, oldest-window: a herd cresting a hill is exactly when
      // this matters, and it is cheaper to drop a call than to duck later.
      if (now - this.monSfxWindowAt > 1000) {
        this.monSfxWindowAt = now;
        this.monSfxInWindow = 0;
      }
      if (this.monSfxInWindow >= MONSTER_SFX_PER_SEC) return;
      this.monSfxInWindow++;
      const sp = this.worldSpatial(mv.sprite.x, mv.sprite.y);
      gameAudio.event(`monsters.${mv.kind}.${action}`, { pan: sp.pan, dist: sp.dist });
    };

    // ATTACK — the swing itself. Same signal the clip restarts on, so an
    // assigned sound cannot drift off the animation.
    if (mstate === "combat" && actionSeq !== (mv.sfxLastSwing ?? mv.lastActionSeq ?? 0)) {
      mv.sfxLastSwing = actionSeq;
      fire("attack");
      return; // the swing IS this frame's monster sound
    }
    if (mstate === "chase" || mstate === "combat") {
      // ANGRY IDLE — the growl between swings, and while closing in.
      if (mv.sfxAngryGap === undefined) mv.sfxAngryGap = MONSTER_ANGRY_GAP_MS[0];
      if (now - (mv.sfxAngryAt ?? 0) >= mv.sfxAngryGap) {
        mv.sfxAngryAt = now;
        mv.sfxAngryGap = MONSTER_ANGRY_GAP_MS[0] + Math.random() * (MONSTER_ANGRY_GAP_MS[1] - MONSTER_ANGRY_GAP_MS[0]);
        fire("angry");
      }
    }
    if (moving) {
      // WALK / hop forward — once per gait cycle. Progress running backwards
      // is a wrap; a state change resets it so a fresh clip cannot fire on
      // its first frame.
      const prog = mv.sprite.anims.isPlaying ? mv.sprite.anims.getProgress() : 0;
      const prev = mv.sfxWalkProg;
      mv.sfxWalkProg = prog;
      if (prev !== undefined && prog < prev - 0.25) fire("walk");
      return;
    }
    mv.sfxWalkProg = undefined;
    if (mstate === "chase" || mstate === "combat") return; // angry owns the stopped case
    // IDLE — a resting creature's own noise, jittered per individual.
    if (mv.sfxIdleGap === undefined) {
      mv.sfxIdleGap = MONSTER_IDLE_GAP_MS[0] + Math.random() * (MONSTER_IDLE_GAP_MS[1] - MONSTER_IDLE_GAP_MS[0]);
      mv.sfxIdleAt = now; // never on the first frame a body appears
    }
    if (now - (mv.sfxIdleAt ?? 0) >= mv.sfxIdleGap) {
      mv.sfxIdleAt = now;
      mv.sfxIdleGap = MONSTER_IDLE_GAP_MS[0] + Math.random() * (MONSTER_IDLE_GAP_MS[1] - MONSTER_IDLE_GAP_MS[0]);
      fire("idle");
    }
  }

  private playMonsterAnim(mv: MonsterAvatar, moving: boolean, dir: string, mstate = "roam", actionSeq = 0) {
    const want = DIRECTIONS.includes(dir as never) ? dir : DEFAULT_DIRECTION;
    // Monsters take EVERY turn (even 90-180°) through hysteresis: they are
    // remote puppets, so a 160ms facing lag is invisible — while autopilot
    // thrash near a roam target flipped them "back and forth like crazy"
    // right before stopping (maintainer 2026-07-30). Players keep instant
    // large turns for input feel.
    const d = this.stableDir(mv, want, true);
    mv.mstate = mstate;
    // Phaser's timeScale lives on the sprite's ANIMATION STATE, not on the
    // clip, so it survives every play() — a monster that broke off a 3.5×
    // chase would swing/die at 3.5× too. Reset to the authored rate here; the
    // walk branch below re-applies the gait scale when it is actually walking.
    mv.sprite.anims.timeScale = 1;

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
        // AFTER play(): the origin is a fraction of the CURRENT frame's size,
        // and a state's strip may be framed at other dimensions. Canonical
        // state name ("die", never mv.dieKey) — see MonsterAvatar.shState.
        this.applyTunedOriginFor(mv, "die", d);
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
          this.applyTunedOriginFor(mv, "attack", d);
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
        this.applyTunedOriginFor(mv, "angry", d);
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
    //
    // A TUNED monster keeps ONE origin instead — the shadow's centre — for
    // every direction and state: the whole point of the tuned model is that
    // the art rotates around that point, so a per-facing origin would undo it.
    const g = (!moving && mv.groundIdle?.[d]) || mv.ground?.[d];
    if (mv.tuned) {
      this.applyTunedOriginFor(mv, moving ? "walk" : "idle", d);
    } else if (g) {
      mv.sprite.setOrigin(g.cx, g.f);
    }
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
      // CADENCE ∝ SPEED (round 13). The walk clip's base rate plants the gait
      // at ROAM speed; a monster that breaks into a chase covers 2.5× the
      // ground per second and must cycle 2.5× faster or its legs skate — the
      // old fixed 6/10 fps could only be right at one speed, which is what
      // read as "limping" / "jumping". Effective fps = frames × speed /
      // cycleWu, clamped so a heavy body never freezes mid-stride and a
      // provoked sprint never blurs. Idle keeps its own breathing rate.
      mv.sprite.anims.timeScale = moving ? this.gaitScaleFor(mv) : 1;
    } else {
      // No idle art (legacy poring family): park on the walk strip's PLANTED
      // CONTACT FRAME (frame 0 is airborne for hop gaits — parked frogs
      // levitated above their shadow until the next trip).
      mv.sprite.anims.stop();
      const sk = monsterSheetKey(mv.kind, mv.walkKey, d);
      if (this.textures.exists(sk)) mv.sprite.setTexture(sk, g?.contact ?? 0);
    }
  }

  /** Playback scale for a monster's WALK clip so the cycle completes once per
   * `gait.cycleWu` of ground actually covered (round 13). The clip's base rate
   * was authored for GAIT_REF_WU, so the scale is just speed/ref — with the
   * effective fps clamped into a readable band (a mammoth paces slowly, but
   * never freezes; a provoked hunter never blurs). Reads the body's OWN
   * measured drawn speed, so easing, water, chases and the flee-slow all pace
   * continuously with no per-state pops. */
  private gaitScaleFor(mv: MonsterAvatar): number {
    const base = mv.sprite.anims.currentAnim?.frameRate ?? 0;
    if (!base) return 1;
    const spd = mv.spdWu ?? GAIT_REF_WU;
    const frames = mv.sprite.anims.currentAnim?.getTotalFrames?.() ?? 0;
    const cycleWu = mv.cycleWu ?? 36;
    const wantFps = frames > 0 ? (frames * spd) / cycleWu : base * (spd / GAIT_REF_WU);
    return Phaser.Math.Clamp(wantFps, GAIT_FPS_MIN, GAIT_FPS_MAX) / base;
  }

  /** The hop's mean-zero ground-track offset in SCREEN px (round 13), eased so
   * a frame change can't pop the body. `travelCum[i]` is the fraction of the
   * cycle's ground the ART has covered when frame i starts, so the body should
   * lead (or lag) the even glide by (travelled − progress) × cycleWu: a frog
   * surges through its leap and stands still while it gathers, instead of
   * sliding forward at a constant rate through a hop it is clearly not making.
   * Only real hoppers ship `travel` — everyone else glides evenly, as before. */
  private hopOffsetFor(mv: MonsterAvatar, dt: number): number {
    const cum = mv.travelCum;
    let want = 0;
    if (
      cum &&
      mv.cycleWu &&
      !mv.combatClip &&
      mv.sprite.anims.isPlaying &&
      (mv.spdWu ?? 0) > 1 &&
      mv.sprite.anims.getName() === monsterAnimKey(mv.kind, mv.walkKey, mv.dispDir)
    ) {
      const n = cum.length - 1;
      const p = Phaser.Math.Clamp(mv.sprite.anims.getProgress(), 0, 1);
      const t = p * n;
      const i = Math.min(n - 1, Math.max(0, Math.floor(t)));
      const travelled = cum[i] + (cum[i + 1] - cum[i]) * (t - i);
      want = (travelled - p) * mv.cycleWu * (mv.scrPerWu ?? 1);
    }
    const cur = mv.hopOff ?? 0;
    return cur + (want - cur) * Math.min(1, dt * GAIT_HOP_EASE);
  }

  /** Spawn the world's NPCs (maps2 npcs.json). Art loads lazily per character:
   * a world places a couple of dozen people out of a 191-strong roster, so
   * pulling the whole catalog would be pure waste. Nothing here touches the
   * server — NPCs are client-side decor. */
  private spawnNpcs() {
    if (!this.npcManifest || !this.npcPlacement.length) return;
    const byId = new Map(this.npcManifest.npcs.map((d) => [d.id, d]));
    for (const p of this.npcPlacement) {
      const def = byId.get(p.character);
      if (def) this.addNpc(p, def);
    }
  }

  /** Queue the placed NPCs' STANDING art in preload, so they are on screen the
   * moment the world is — one small image per distinct character (a world
   * places ~20 people, mostly different ones). Their idle FRAMES are NOT here:
   * those ride the deferred batch after the join, and the calm idle hides that
   * wait completely, because an NPC parks on the standing pose anyway. */
  private preloadNpcArt() {
    const man = (this.registry.get("npcManifest") as NpcManifest | null) ?? null;
    const placed = (this.registry.get("npcPlacement") as NpcPlacement[] | null) ?? [];
    if (!man || !placed.length) return;
    const byId = new Map(man.npcs.map((d) => [d.id, d]));
    const seen = new Set<string>();
    for (const p of placed) {
      const def = byId.get(p.character);
      if (!def) continue;
      // KEYED BY CHARACTER **AND** DIRECTION. Now that maps2' facing is
      // honoured, two placements of the same character can need two different
      // rotations — deduping by character alone preloaded one of them and left
      // the other on the placeholder until its lazy load landed.
      const dir = this.npcFacing(p, def);
      if (seen.has(`${def.id}:${dir}`)) continue;
      seen.add(`${def.id}:${dir}`);
      const url = def.base[dir];
      const key = `npc:${def.id}:${dir}`;
      if (url && !this.textures.exists(key)) this.load.image(key, withV(url));
    }
  }

  /** WHICH WAY THIS NPC STANDS — the one rule, so the boot preload and the
   * spawn cannot disagree (they did: the preload fetched south while the body
   * rendered south-west, and it showed as the placeholder texture).
   *
   * maps2' `facing` is honoured whenever this character has an IDLE for it, and
   * falls back to south otherwise. The test is the ART, not a list of today's
   * three directions: a frozen NPC beside a breathing one is what the old
   * south-only pin existed to prevent, and the day characters2 generates
   * north-east this starts honouring it with no edit here. */
  private npcFacing(p: NpcPlacement, def: NpcDef): string {
    const want = p.facing && DIRECTIONS.includes(p.facing as never) ? p.facing : null;
    return want && (def.idle?.[want] ?? 0) > 0 && def.base[want] ? want : DEFAULT_DIRECTION;
  }

  private addNpc(p: NpcPlacement, def: NpcDef) {
    // MAPS2 DECIDES THE FACING, as far as the art can carry it (2026-08-09).
    // The rule has never been about placement — it is that a frozen NPC beside
    // a breathing one reads as broken, so a facing is only honoured when this
    // character actually has an IDLE for it. characters2 has now generated
    // SOUTH-EAST and SOUTH-WEST for all 191, so those three are honoured and
    // the other five still fall back to south rather than standing still.
    // Asking the manifest (`def.idle[dir]`) rather than listing the three
    // directions here means the day north-east lands, this needs no edit: the
    // fallback simply stops firing for it. Missing/unknown facings and the few
    // characters with no idle at all resolve to south exactly as before.
    // They still never walk — there is no walk art and no server body.
    const dir = this.npcFacing(p, def);
    // maps2 gives a TILE cell; bodies stand at the cell CENTRE like everything
    // else that is placed by cell (the campfire, spawn scatter).
    const fx = (p.x + 0.5) * CELL_WU;
    const fy = (p.y + 0.5) * CELL_WU;
    const g = this.projectFlat(fx, fy);
    const elev = (p.elev ?? g.lvl) * this.geom.lh;
    const shadow = this.add
      .image(g.x, g.y - elev, SHADOW_TEX)
      .setOrigin(0.5, 0.5)
      .setDisplaySize(34, 14)
      .setAlpha(0.5);
    // ORIGIN = THE MEASURED FOOT ANCHOR, never a guess. It is the point
    // between the two feet at their underside, so the drawn soles land exactly
    // on the ground point placeBodyShadow puts the nadir shadow at — the whole
    // difference between standing and hovering (measured: the eyeballed 0.9
    // this replaces was up to 9px off, and the monsters' "flying" rounds were
    // this same mistake).
    const a = def.anchors?.[dir];
    const sprite = this.add
      .sprite(g.x, g.y - elev, PLACEHOLDER_TEX)
      .setOrigin(a?.x ?? 0.5, a?.y ?? 0.84);
    const npc: NpcAvatar = {
      sprite,
      shadow,
      lx: g.x,
      lyFlat: g.y,
      ly: g.y - elev,
      elev,
      fx,
      fy,
      charId: def.id,
      name: p.name || def.name,
      type: p.type,
      dir,
      home: dir,
      def,
      turnAt: 0,
      glanceDir: null,
      glanceUntil: 0,
      // Stagger the first glance across the whole home window, or a street
      // queued in one loop would all look away together on the same beat.
      nextGlanceAt: this.time.now + NPC_HOME_MIN_MS * Math.random() + NPC_HOME_MIN_MS * 0.5,
      lookDir: null,
      lookUntil: 0,
      animKey: null,
      holdUntil: 0,
      surfLevel: p.elev ?? g.lvl,
    };
    this.npcs.set(p.id, npc);
    this.loadNpcArt(npc, def);
  }

  /** Lazy art for ONE npc: the static rotation for its facing always, plus the
   * idle clip when the art ships one for that direction. The generated idle is
   * SOUTH-ONLY today, so most NPCs correctly stand still on their rotation —
   * when characters2 generates the rest they animate with no client change. */
  private loadNpcArt(npc: NpcAvatar, def: NpcDef) {
    const baseKey = `npc:${def.id}:${npc.dir}`;
    const frames = def.idle?.[npc.dir] ?? 0;
    const animKey = `npcanim:${def.id}:${npc.dir}`;
    // EVERY ROTATION THIS BODY CAN TURN TO, on the DEFERRED batch. Head-turning
    // can reach all eight (a look at the player) and idles on the three that
    // have them, and art that has not arrived means a turn silently completes
    // late — so they are queued once, here, rather than fetched at the moment
    // someone walks past. Never the BOOT batch: NPC frames there is precisely
    // what restarted the loading bar (maintainer 2026-08-06).
    for (const d of DIRECTIONS) {
      // A no-turn NPC will never adopt another rotation, so fetching the other
      // seven (and their idle frames) is pure waste on someone's phone data.
      if (def.noTurn && d !== npc.dir) continue;
      const url = def.base[d];
      const k = `npc:${def.id}:${d}`;
      if (url && !this.textures.exists(k)) this.npcIdleQueue.push({ key: k, url });
      const fn = def.idle?.[d] ?? 0;
      if (!fn || !def.idleAnim || d === npc.dir) continue;
      for (let i = 0; i < fn; i++) {
        const fk = `npcf:${def.id}:${d}:${i}`;
        if (this.textures.exists(fk)) continue;
        this.npcIdleQueue.push({
          key: fk,
          url: `/assets/characters2/npcs/${def.id}/animations/${def.idleAnim}/${d}/${i}.webp`,
        });
      }
    }
    // The standing pose arrived with the BOOT batch (preloadNpcArt), so the
    // NPC is drawn the instant the world is. Loading it lazily here is what
    // restarted the loading bar and popped them in half a second late
    // (maintainer 2026-08-06).
    if (this.textures.exists(baseKey)) npc.sprite.setTexture(baseKey);
    if (frames > 0 && def.idleAnim) {
      const keys: string[] = [];
      for (let i = 0; i < frames; i++) {
        const k = `npcf:${def.id}:${npc.dir}:${i}`;
        keys.push(k);
        if (!this.textures.exists(k)) {
          this.npcIdleQueue.push({
            key: k,
            url: `/assets/characters2/npcs/${def.id}/animations/${def.idleAnim}/${npc.dir}/${i}.webp`,
          });
        }
      }
      // Registered LAZILY by stepNpcs once every frame texture exists — NOT on
      // a one-shot loader COMPLETE. A world queues ~20 NPCs back to back, so
      // COMPLETE fires between batches while later files are still pending and
      // a one-shot handler finds its own textures missing and gives up
      // silently: measured 0 of 19 clips registering. Same shape as the
      // monsters' single-call-site trap.
      npc.pendingAnim = { key: animKey, frames: keys };
    }
  }

  /** WHERE THIS NPC WANTS TO BE LOOKING, this frame. Three sources, in order:
   *
   * 1. THE PLAYER, but only while almost touching (NPC_LOOK_WU). The brief is a
   *    reaction to someone brushing past, not a stare across the square, so the
   *    radius is body-sized and a short linger keeps the head from snapping
   *    back the instant you clear it.
   * 2. A RANDOM GLANCE, held 10-30s, then home for ~4x that (~82% home).
   * 3. HOME — what maps2 placed them on.
   *
   * A LOOK may use any of the eight rotations; a GLANCE only ones this
   * character has an idle for. That is not a detail: a glance holds for up to
   * 30 seconds, and a body frozen that long beside a breathing neighbour is
   * exactly what the old south-only pin existed to prevent. A look is over in
   * about a second, and a person actually does still while they watch you. */
  private stepNpcFacing(npc: NpcAvatar, now: number) {
    // SOME ART ONLY READS RIGHT FROM ONE FACING. characters2 flags those
    // (`no_turn` on the NPC's metadata record, published through the manifest
    // as noTurn) and they must NEVER change direction — not for a glance, not
    // to look at the player. Thorne is the first: his armorer's breastplate
    // stands on the GROUND BESIDE HIM in south and south-west and is absent in
    // south-east, so any turn pops a large prop in and out of the scene. He
    // keeps whatever facing addNpc gave him, permanently.
    if (npc.def.noTurn) return;
    const me = this.avatars.get(this.room?.sessionId ?? "");
    if (me) {
      const dx = me.fx - npc.fx;
      const dy = me.fy - npc.fy;
      if (dx * dx + dy * dy <= NPC_LOOK_WU * NPC_LOOK_WU) {
        const d = faceDirWorld(npc.fx, npc.fy, me.fx, me.fy);
        // Standing exactly on top of an NPC has no direction — keep the last
        // one rather than flapping through whatever rounding produces.
        if (d) npc.lookDir = d;
        npc.lookUntil = now + NPC_LOOK_LINGER_MS;
      }
    }
    const looking = npc.lookDir && now < npc.lookUntil;
    // A glance never interrupts a look, and never starts during one.
    if (!looking && now >= npc.nextGlanceAt && now >= npc.glanceUntil) {
      const canIdle = DIRECTIONS.filter((d) => (npc.def.idle?.[d] ?? 0) > 0 && d !== npc.home);
      if (canIdle.length) {
        npc.glanceDir = canIdle[Math.floor(Math.random() * canIdle.length)];
        npc.glanceUntil = now + NPC_GLANCE_MIN_MS + Math.random() * (NPC_GLANCE_MAX_MS - NPC_GLANCE_MIN_MS);
        npc.nextGlanceAt = npc.glanceUntil + NPC_HOME_MIN_MS + Math.random() * (NPC_HOME_MAX_MS - NPC_HOME_MIN_MS);
      } else {
        npc.nextGlanceAt = now + NPC_HOME_MIN_MS; // no art to glance with — ask again later
      }
    }
    const n = DIRECTIONS.length;
    // The facing this NPC would hold with nobody around: home, or the glance
    // it is currently on. A look is measured AGAINST this, never against the
    // last frame's facing, or the clamp below would ratchet round the compass
    // one notch at a time and become the head-spin it exists to prevent.
    const base = now < npc.glanceUntil ? npc.glanceDir ?? npc.home : npc.home;
    const bi = DIRECTIONS.indexOf(base as never);

    if (looking && bi >= 0) {
      // A GLANCE OVER THE SHOULDER, NOT A TRACKING TURRET (maintainer
      // 2026-08-09: "at most ±1 direction and that has to be INSTANT... they
      // will not follow you when running by"). Clamp the direction of the
      // player to ONE notch either side of base, and take it THIS FRAME — a
      // 200ms sweep on something that lasts a second reads as the NPC lagging
      // behind you, which is the opposite of noticing you. Running past
      // therefore plays as base+1 -> base -> base-1: a head tilting to follow,
      // then letting you go.
      const li = DIRECTIONS.indexOf(npc.lookDir as never);
      if (li >= 0) {
        let d = (((li - bi) % n) + n) % n;
        if (d > n / 2) d -= n;
        const want = DIRECTIONS[(bi + Math.max(-1, Math.min(1, d)) + n) % n];
        if (want !== npc.dir) this.setNpcDir(npc, want);
        npc.turnAt = now; // the sweep owes nothing after an instant look
      }
      return;
    }

    if (base === npc.dir || now < npc.turnAt) return;
    // THE SWEEP, and it is ONLY for turns the NPC makes on its own — settling
    // back from a look, or going to and from a glance. DIRECTIONS is a compass
    // ring, so the gap in indices IS the notch count, and the head takes them
    // one at a time the short way round: a neck does not teleport.
    const from = DIRECTIONS.indexOf(npc.dir as never);
    if (from < 0 || bi < 0) return;
    const step = ((((bi - from) % n) + n) % n) <= n / 2 ? 1 : -1;
    this.setNpcDir(npc, DIRECTIONS[(from + step + n) % n]);
    npc.turnAt = now + NPC_TURN_STEP_MS;
  }

  /** Face this way NOW: the rotation, its foot anchor, and the idle clip for
   * it. Falls back to holding the current art when the new direction has not
   * arrived yet (it rides the deferred batch), so a turn never blinks a
   * placeholder — it simply completes when the art lands. */
  private setNpcDir(npc: NpcAvatar, dir: string) {
    npc.dir = dir;
    const def = npc.def;
    const baseKey = `npc:${def.id}:${dir}`;
    // THE ORIGIN MOVES WITH THE ROTATION IT BELONGS TO, NEVER AHEAD OF IT.
    // Every facing has its own measured foot anchor, so applying the new one
    // while the old rotation is still on screen shifts the drawn body off the
    // ground point — the feet slide out from under the nadir shadow for as
    // long as the art takes to arrive. Both move together or neither does; the
    // turn then completes late at worst, which is invisible.
    if (this.textures.exists(baseKey)) {
      npc.sprite.setTexture(baseKey);
      const a = def.anchors?.[dir];
      if (a) npc.sprite.setOrigin(a.x, a.y);
    }
    const frames = def.idle?.[dir] ?? 0;
    const animKey = `npcanim:${def.id}:${dir}`;
    npc.animKey = null;
    npc.pendingAnim = undefined;
    npc.holdUntil = 0;
    if (frames > 0 && def.idleAnim) {
      const keys: string[] = [];
      for (let i = 0; i < frames; i++) keys.push(`npcf:${def.id}:${dir}:${i}`);
      if (this.anims.exists(animKey)) npc.animKey = animKey;
      else npc.pendingAnim = { key: animKey, frames: keys };
    }
  }

  /** Per frame: place every NPC through the shared body pipeline and drive the
   * CALM IDLE — play the clip once, then freeze on frame 0 for a fresh random
   * 0.1-5s pause, so a street full of people never breathes in unison or
   * loops often enough to read as a machine. Off-screen bodies are parked
   * exactly like culled monsters (no depth ray, no shadow, no lit copy). */
  private stepNpcs() {
    if (!this.npcs.size) return;
    const cam = this.cameras.main.worldView;
    const now = this.time.now;
    for (const npc of this.npcs.values()) {
      const sp = npc.sprite;
      const halfW = Math.max(sp.displayWidth, 40) * 0.5;
      const on =
        npc.lx + halfW >= cam.x - MONSTER_CULL_SLACK &&
        npc.lx - halfW <= cam.right + MONSTER_CULL_SLACK &&
        npc.ly + 20 >= cam.y - MONSTER_CULL_SLACK &&
        npc.ly - sp.displayHeight <= cam.bottom + MONSTER_CULL_SLACK &&
        !this.aboveCut(npc.surfLevel ?? 0, npc.fx, npc.fy);
      // The indoor test is ONLY about height (see aboveCut). A villager on the
      // street outside my room is drawn and lit like the street is — black,
      // until my torch finds them. One standing on a rooftop is not drawn at
      // all, because the rooftop is not drawn either.
      if (!on) {
        if (!npc.culled) {
          npc.culled = true;
          sp.setVisible(false);
          npc.shadow.setVisible(false);
          npc.lit?.setVisible(false);
          npc.fog?.setVisible(false);
          sp.anims.pause();
        }
        continue;
      }
      if (npc.culled) {
        npc.culled = false;
        sp.setVisible(true);
        npc.shadow.setVisible(true);
        sp.anims.resume();
      }
      sp.x = npc.lx;
      sp.y = npc.ly;
      this.stepNpcFacing(npc, now);
      if (!npc.animKey && npc.pendingAnim) {
        const pa = npc.pendingAnim;
        if (pa.frames.every((k) => this.textures.exists(k))) {
          if (!this.anims.exists(pa.key)) {
            this.anims.create({
              key: pa.key,
              frames: pa.frames.map((k) => ({ key: k })),
              frameRate: ANIM_FPS.idle ?? 6,
              repeat: 0, // ONE pass, then the calm hold below
            });
          }
          npc.animKey = pa.key;
          npc.pendingAnim = undefined;
        }
      }
      // THE CALM IDLE: a finished (or never started) clip parks on frame 0
      // until its own random deadline passes, then plays once more.
      if (npc.animKey && !sp.anims.isPlaying) {
        if (!npc.holdUntil) {
          npc.holdUntil = now + NPC_HOLD_MIN_MS + Math.random() * (NPC_HOLD_MAX_MS - NPC_HOLD_MIN_MS);
        } else if (now >= npc.holdUntil) {
          npc.holdUntil = 0;
          sp.play(npc.animKey);
        }
      }
      this.resolveBodyDepth(npc, npc.surfLevel ?? 0);
      this.placeBodyShadow(npc, npc.elev, 0, 34, 14);
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
    const myLevel = Math.max(0, me.elev / this.geom.lh);
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
        // AND THE DEATH SEQUENCE, which is DOM and therefore outlives the room
        // that started it. A backgrounded tab drops the connection, the server
        // revives me on its own backstop, and the fresh room's state has me
        // ALIVE — so the dead→alive transition that normally ends the sequence
        // never fires here, and the veil and the prompt hung over a player
        // running around at full health (maintainer 2026-08-12, with shots).
        this.selfDead = false;
        this.endDeath();
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


  /** Recompute the jump-button chess offer, ~7Hz. Cheap: a handful of
   * boards, pure distance math. Fires a window event ONLY on change — the
   * gamepad label (games-ui's file) listens for it. */
  private updateChessPrompt() {
    const now = this.time.now;
    if (now - this.chessPromptAt < 150) return;
    this.chessPromptAt = now;
    const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
    let next: { mode: "start" | "join" } | null = null;
    if (me && this.room && !this.chessDialog) {
      // The join zone is the whole ring around the TABLE (server tableDist,
      // 1.75 cells) — the exact-seat version demanded pixel parking and two
      // real players stood beside a dead board (maintainer screenshot).
      const R = CELL_WU * 1.75;
      this.room.state.chessBoards?.forEach((b: any) => {
        if (next || b.matchId || b.waitingSid === this.room!.sessionId) return;
        const d = Math.hypot(me.fx - (b.col + 0.5) * CELL_WU, me.fy - (b.row + 0.5) * CELL_WU);
        if (d <= R) next = { mode: b.npc || b.waitingSid ? "join" : "start" };
      });
    }
    const label = next ? ((next as { mode: string }).mode === "join" ? "JOIN CHESSGAME" : "START CHESSGAME") : null;
    const prev = this.chessPrompt ? (this.chessPrompt.mode === "join" ? "JOIN CHESSGAME" : "START CHESSGAME") : null;
    this.chessPrompt = next;
    if (label !== prev) window.dispatchEvent(new CustomEvent("ml-chess-prompt", { detail: { label } }));
  }

  /** The in-world chess board: a generated iso-checker decor image (replaced
   * by real scenery art once the scenery agent's boards are placed — the
   * texture is one swap away). Depth = painter y like any flat decor. */
  private placeChessBoard(id: string, b: { col: number; row: number; sprite?: string }) {
    if (this.chessDecor.has(id)) return;
    if (b.sprite === "world") return; // the world's own PROP renders the table
    if (b.sprite) {
      // The scenery agent's synced board (the maintainer's PixelLab piece,
      // world_px_height 27 -> display height 27, bottom-anchored). Campfire
      // pattern: queue the image; a 404 falls through to the placeholder.
      const key = `chess-board:${b.sprite}`;
      const place = () => {
        const p2 = this.projectFlat((b.col + 0.5) * CELL_WU, (b.row + 0.5) * CELL_WU);
        const img = this.add.image(p2.x, p2.y - p2.lvl * this.geom.lh + this.geom.dy / 2, key)
          .setOrigin(0.5, 1);
        img.setScale(27 / img.height);
        img.setDepth(p2.y + 0.4);
        this.chessDecor.set(id, img);
      };
      if (this.textures.exists(key)) { place(); return; }
      this.load.image(key, withV(b.sprite));
      this.load.once(`filecomplete-image-${key}`, place);
      this.load.once("loaderror", (f: Phaser.Loader.File) => {
        if (f.key === key && !this.chessDecor.has(id)) this.placeChessBoardFallback(id, b);
      });
      this.load.start();
      return;
    }
    this.placeChessBoardFallback(id, b);
  }

  private placeChessBoardFallback(id: string, b: { col: number; row: number }) {
    if (this.chessDecor.has(id)) return;
    const key = "chess-board-decor";
    if (!this.textures.exists(key)) {
      const W = 44, H = 22, cnv = document.createElement("canvas");
      cnv.width = W; cnv.height = H;
      const g = cnv.getContext("2d")!;
      for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
        const cx = W / 2 + (f - r) * (W / 16), cy = 3 + (f + r) * (H - 6) / 16;
        g.fillStyle = (f + r) % 2 ? "#e9dcc3" : "#7a5a3a";
        g.beginPath();
        g.moveTo(cx, cy); g.lineTo(cx + W / 16, cy + (H - 6) / 16);
        g.lineTo(cx, cy + (H - 6) / 8); g.lineTo(cx - W / 16, cy + (H - 6) / 16);
        g.closePath(); g.fill();
      }
      this.textures.addCanvas(key, cnv)?.setFilter(Phaser.Textures.FilterMode.NEAREST);
    }
    const p = this.projectFlat((b.col + 0.5) * CELL_WU, (b.row + 0.5) * CELL_WU);
    const img = this.add.image(p.x, p.y - p.lvl * this.geom.lh, key).setDepth(p.y + 0.4);
    this.chessDecor.set(id, img);
  }

  /** The waiting-for-an-opponent indicator over the seated player. A drawn
   * bubble today; the maintainer's PixelLab "chess challenge" icon replaces
   * the TEXT with an image the moment it syncs into scenery/ (one texture
   * swap here, nothing else moves). Waiting players are standing still by
   * definition, so a static position is honest. */
  private syncChessWait(id: string, b: { waitingSid: string; bubble?: string }) {
    const old = this.chessWaitB.get(id);
    if (old) { old.destroy(); this.chessWaitB.delete(id); }
    if (!b.waitingSid) return;
    const av = this.avatars.get(b.waitingSid);
    if (!av) return;
    if (b.bubble) {
      // The maintainer's challenge-bubble art (dots point at the head): set
      // `bubble` in the board config the moment the piece syncs into
      // scenery/ — no code change. Campfire pattern; drawn text below is the
      // fallback while it loads or if it 404s.
      const key = `chess-bubble:${b.bubble}`;
      const placeImg = () => {
        if (!this.room?.state.chessBoards?.get(id)?.waitingSid) return;
        const av2 = this.avatars.get(b.waitingSid);
        if (!av2) return;
        this.chessWaitB.get(id)?.destroy();
        const img = this.add.image(av2.sprite.x, av2.sprite.y - av2.sprite.displayHeight * av2.sprite.originY - 2, key)
          .setOrigin(0.5, 1).setDepth(900_100) as unknown as Phaser.GameObjects.Text;
        this.chessWaitB.set(id, img);
      };
      if (this.textures.exists(key)) { placeImg(); return; }
      this.load.image(key, withV(b.bubble));
      this.load.once(`filecomplete-image-${key}`, placeImg);
      this.load.start();
      // fall through: drawn bubble shows until the art lands
    }
    const t = this.add
      .text(av.sprite.x, av.sprite.y - av.sprite.displayHeight * av.sprite.originY - 6, "♞ Chess?", {
        fontFamily: "system-ui, sans-serif", fontSize: "13px",
        color: "#1f1e1a", backgroundColor: "#f6e3db",
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0.5, 1)
      .setDepth(900_100); // the chat-bubble band: above darkness, below floats
    this.chessWaitB.set(id, t);
  }

  /** Freeze movement while the chess dialog is up — the same ops as the HUD's
   * onUiLock (drop dialog): a DOM overlay does NOT keep pointerdowns from
   * Phaser's window-level listeners, so the flag + keyboard disable are what
   * actually stop the player being walked out of their seat mid-game. */
  private setChessLock(locked: boolean) {
    this.input.keyboard!.enabled = !locked && !this.chat?.open;
    this.uiLocked = locked;
    if (!locked) { this.uiLockLiftAt = performance.now() + 150; return; }
    this.input.keyboard!.resetKeys();
    this.dropHold();
    this.clearMoveTarget();
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
    const elev0 = f0.lvl * this.geom.lh;
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
    // One tick per frame, BEFORE any body registers. Both consumers test
    // `coverAt === coverTick`, and so do the dev probes AFTER the frame has
    // run — bumping it in the flush instead would make every probe read
    // "this body has no surface" one tick too early.
    this.coverTick++;
    // The coalesced streaming repaints — see requestRepaint / onTerrainBatch.
    if (this.repaintGroundPending) {
      this.repaintGroundPending = false;
      this.repaintGroundPartial = false; // the full paint covers the landed cells
      this.groundDirtyCells = [];
      this.lastGround = { x: NaN, y: NaN };
      this.repaintStats.groundRuns++;
    } else if (this.repaintGroundPartial) {
      this.repaintGroundPartial = false;
      const dirty = this.groundDirtyCells;
      this.groundDirtyCells = [];
      this.ps();
      this.repaintTiles3Cells(dirty);
      this.pe("repaintCells");
      this.repaintStats.groundRuns++;
    }
    if (this.repaintOccPending) {
      this.repaintOccPending = false;
      this.lastOccl = { x: NaN, y: NaN };
      this.repaintStats.occRuns++;
    }
    if (this.perfOn) {
      const now = performance.now();
      if (this.perfLast) this.perfFrames.push(now - this.perfLast);
      if (this.hitchOn && this.perfLast) this.closeHitchFrame(now - this.perfLast);
      this.perfLast = now;
      if (this.perfTexFrame > this.perfTexFrameMax) this.perfTexFrameMax = this.perfTexFrame;
      this.perfTexFrame = 0;
      if (this.perfBeacon) this.perfBeaconTick(now);
    }
    this.ps();
    const groundBefore = this.groundSliceStats.runs + this.repaintStats.groundRuns;
    this.redrawGround();
    this.groundRedrewThisFrame = this.groundSliceStats.runs + this.repaintStats.groundRuns !== groundBefore;
    this.pe("redrawGround");
    if (!this.groundRedrewThisFrame) {
      this.ps();
      this.t3paintSliceStep(); // one slice of the exposed band
      this.pe("groundSlice");
    }
    this.ps();
    this.rebuildOccluders();
    this.pe("rebuildOccluders");
    this.ps();
    this.t3prefetchStep();
    this.pe("prefetch");
    // ...and, once the art has settled, repair anything a paint dropped.
    this.t3drainDrops();
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

    this.ps();
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
            // THE SAME ELEVATION-AWARE SURFACE THE SERVER USES. On a deck the
            // feet are on the deck's material, not the water it spans — and
            // prediction must ask the identical question or the two disagree
            // about speed for the whole length of the bridge, which is a
            // rubber-band, not a wrong number.
            speed =
              surfaceAtWorldElev(this.terrain, rx, ry, predElev).speed *
              (jumping ? JUMP_SPEED_FACTOR : 1) *
              slowF;
          }
          // screenInput matches the server: on the iso world, input is screen-relative.
          const r = stepMovement(rx, ry, ax, ay, running, sdt, blocked, speed, !!this.terrain, this.worldW, this.worldH, sideBlocked);
          rx = r.x;
          ry = r.y;
          /* THE DEEP-SEA CURRENT — the SAME second move the server integrates
           * (WorldRoom), from the same shared function. Predicting it here is
           * what keeps a swimmer from rubber-banding: the server will apply it
           * whether or not we do. */
          if (this.terrain) {
            const cur = deepCurrentAt(this.terrain, rx, ry);
            if (cur) {
              const d = stepMovement(
                rx, ry, cur.dx, cur.dy, false, sdt, blocked,
                cur.speed / WALK_SPEED,
                false, this.worldW, this.worldH, sideBlocked,
              );
              rx = d.x;
              ry = d.y;
            }
          }
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
          // DEFERRED to the frame the hand closes (maintainer 2026-08-06: "I
          // want the pick up item sound to play when the hand reaches the
          // ground and the item is actually picked up. Now I get the feeling
          // the sound is triggered to early"). It WAS early: this branch runs
          // the instant the pickup ACTION arrives, which is the start of an
          // 850 ms gesture, and the hand does not reach the ground until the
          // measured grab frame about halfway through. The art already knows
          // that exact moment — it is the frame the ITEM vanishes on
          // (character manifest `grab[dir].f`, used by stepGroundDecor) — so
          // the sound now waits for the same frame instead of guessing a
          // delay, which keeps it locked to the animation at any frame rate.
          // Every avatar gets this, not just mine: a remote player's gesture
          // is just as long, so their pickup was just as early.
          av.pickupSfxFrame = this.grabFrameFor(av)?.f ?? null;
          av.pickupSfxAt = null;
          if (av.pickupSfxFrame == null) {
            // No measured grab frame for this character/facing — play it now
            // rather than not at all. Silence would be a worse bug than early.
            const spP = this.avatarSpatial(id);
            gameAudio.event("item.pickup", { pan: spP.pan, dist: spP.dist });
          } else {
            av.pickupSfxAt = nowMs; // armed; stepPickupSfx fires it
          }
        } else if (player.action === "die") {
          av.actionKey = "die";
          av.actionUntil = nowMs + 10_000; // held below while dead anyway
          const spD = this.avatarSpatial(id);
          // `voice` carries WHOSE death this is, exactly as the jump grunt
          // does — the maintainer wants the die sound to be the character's
          // own male/female voice, and an event that does not say which
          // character died can never route to one. Silent either way: nothing
          // is assigned to player.die yet.
          gameAudio.event("player.die", { pan: spD.pan, dist: spD.dist, voice: av.character });
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
          this.startDeath();
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
          this.endDeath();
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
      const targetElev = surfLevel * this.geom.lh - (swimming ? swimDrop : 0);
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
        // …and the indoor verdict: a snap across the map must not spend 250ms
        // of dwell rendering the room you left, nor cross-fade the grade over
        // what is really a cut.
        if (id === myId) this.indoorSnap();
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
          const dSum = dsy * (CELL_WU / this.geom.dy); // Δ(x+y)
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
        ? Math.max(0, Math.min(1, (surfLevel * this.geom.lh - av.elev) / swimDrop))
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
      // INDOORS a REMOTE player standing outside my room is DRAWN and goes
      // black with the ground under them — but their NAME TAG is not, because
      // it draws at depth 900_100, above the darkness overlay. A readable name
      // floating in the black is the one thing that would give away a body you
      // are meant to barely see, so the label and the chat bubble follow the
      // room while the body follows the light. I am never outside my own room.
      const away = id !== myId && this.indoorOutside(av.fx, av.fy, av.surfLevel);
      // ABOVE THE CUT the body goes too, not just its name tag: it would be
      // standing on terrain that is not drawn. I am never above my own cut —
      // the room is resolved from where I stand.
      const overhead = id !== myId && this.aboveCut(av.surfLevel ?? 0, av.fx, av.fy);
      av.sprite.setVisible(!overhead);
      av.label.setVisible(!away && !overhead);
      av.shadow.setVisible(!av.swimming && !overhead);
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
        av.bubble.setPosition(av.lx, topY - 18).setVisible(!away && !overhead); // goes with the body
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
    this.pe("avatarLoop");

    // INDOORS — run it HERE, not at the top of update(): this is the earliest
    // point at which the local player's fx/fy AND surfLevel are all fresh (the
    // loop above writes surfLevel), and it is still upstream of the torch loop
    // and the ambient blend, so the lighting reacts in the SAME frame. The
    // ground RT + occluders ran at the top of the frame; on a transition
    // commitIndoor re-runs them immediately rather than showing one frame of
    // stale roof (both are self-gating no-ops the rest of the time).
    this.updateIndoor();

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
        const targetElev = (m.elev ?? g.lvl) * this.geom.lh;
        // Is any of this body's art inside the view? The anchor is at the FEET,
        // so the sprite occupies [y-h, y] and the shadow — which can be WIDER
        // than the sprite (a mammoth's ellipse spans ~190px) — straddles it.
        const sp = mv.sprite;
        const halfW =
          Math.max(sp.displayWidth, mv.shadowW * MONSTER_SHADOW_SPREAD) * 0.5;
        // A TUNED anchor is not the feet: it is the shadow centre, so the art
        // hangs BELOW it too (crystal_horn: 61px of a 97px frame) and the
        // sprite is NOT lifted by hoverPx (the tuned ay contains it). Untuned
        // bodies keep the exact legacy box — `up` stays the whole frame and
        // `down` stays shadowH, which for every shipped kind already exceeds
        // the art below a feet anchor, so this is byte-identical for them.
        const ay = g.y - targetElev - (mv.tuned ? 0 : mv.hoverPx); // where it WILL be drawn
        const up = mv.tuned ? sp.displayHeight * sp.originY : sp.displayHeight;
        const down = mv.tuned
          ? Math.max(mv.shadowH, sp.displayHeight * (1 - sp.originY))
          : mv.shadowH;
        const onScreen =
          !mv.artPending && // parked until its strips land — see addMonster
          g.x + halfW >= vL &&
          g.x - halfW <= vR &&
          ay + down >= vT &&
          ay - up <= vB &&
          !this.aboveCut(m.elev ?? g.lvl, m.x, m.y);
        // The indoor test is ONLY about height. A monster outside my room but
        // at my level is drawn and lit like the ground under it — that is the
        // whole zero-ambient design. One ABOVE the cut is different: the
        // terrain it stands on is not drawn, so it would hang in the void.
        // Its ABOVE-OVERLAY chrome is a third case — see indoorOutside.
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
            mv.fog?.setVisible(false);
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
          const px0 = mv.lx;
          const py0 = mv.lyFlat;
          mv.lx += (g.x - mv.lx) * k;
          mv.lyFlat += (g.y - mv.lyFlat) * k;
          // GAIT SYNC (round 13): measure this body's own DRAWN motion — the
          // gait must match what the eye sees, not the 20Hz server steps.
          // Screen delta back-projects to world units exactly like the
          // player's spdWu (Δsx = Δ(x−y)·dx/CELL, Δsy = Δ(x+y)·dy/CELL), so a
          // screen-north walk counts the ~2.13× more world ground it really
          // covers. scrPerWu is the local iso scale along THIS heading, which
          // converts the hop's world-unit surge back into screen px for free.
          if (dt > 0.001) {
            const dsx = mv.lx - px0;
            const dsy = mv.lyFlat - py0;
            const scr = Math.hypot(dsx, dsy);
            const dSum = dsy * (CELL_WU / this.geom.dy);
            const v = this.world
              ? Math.hypot((dsx + dSum) / 2, (dSum - dsx) / 2) / dt
              : scr / dt;
            const ema = Math.min(1, dt * 8); // ~125ms — irons out the ease ripple
            mv.spdWu = mv.spdWu === undefined ? v : mv.spdWu + (v - mv.spdWu) * ema;
            if (scr > 0.01) {
              const r = scr / dt / Math.max(1e-3, v);
              mv.scrPerWu = mv.scrPerWu === undefined ? r : mv.scrPerWu + (r - mv.scrPerWu) * ema;
              const ux = dsx / scr;
              const uy = dsy / scr;
              mv.hdx = mv.hdx === undefined ? ux : mv.hdx + (ux - mv.hdx) * ema;
              mv.hdy = mv.hdy === undefined ? uy : mv.hdy + (uy - mv.hdy) * ema;
            }
          }
          // Elevation eases/falls via the shared integrator, like avatars.
          const s = integrateFall(
            { elev: mv.elev, fallV: mv.fallV, falling: mv.falling },
            targetElev,
            dt,
            this.geom.lh,
          );
          mv.elev = s.elev;
          mv.fallV = s.fallV;
          mv.falling = s.falling;
        }
        mv.ly = mv.lyFlat - mv.elev;
        // SHARED body pipeline (same code as players — maintainer 2026-07-29:
        // the naive painter depth drew terrace tiles over monsters and their
        // shadows in front): occluder-aware depth + landing-ground shadow.
        const sLvl = m.elev ?? g.lvl;
        mv.surfLevel = sLvl; // occluder + light sampling basis (LEVELS)
        this.playMonsterAnim(mv, !!m.moving, m.dir, m.mstate ?? "roam", m.actionSeq ?? 0);
        // RE-ANCHOR AFTER the clip is resolved. The tuned origin is a fraction
        // of the CURRENT frame's dimensions, and playMonsterAnim's combat
        // branches can return having played a strip framed at other dims (and
        // an attack re-anchors only on a new actionSeq, so a stale origin
        // would ride the whole swing). Cheap: one lookup + setOrigin, no
        // manifest scan. Untuned monsters keep their per-direction measured
        // anchor + per-frame shift[] re-pin below, untouched.
        if (mv.tuned) this.applyTunedOriginFor(mv, mv.shState ?? "idle", mv.dispDir);
        // …and the per-state semantic events the wiki's sound card assigns to
        // (silent until it does). AFTER playMonsterAnim, so the walk cadence
        // reads the clip that is actually running this frame.
        this.monsterSfx(mv, !!m.moving, m.mstate ?? "roam", m.actionSeq ?? 0);
        // HOP TRAVEL (round 13): a hopper covers its ground DURING the leap,
        // so glide it along the heading by (travel-so-far − even progress) ×
        // cycleWu. The curve returns to 0 at both ends of the cycle, so this
        // is a pure mean-zero lead/lag — it never moves the body off the
        // server position it is easing toward. Applied to the drawn anchor
        // (never to mv.lx, which IS the ease state and would absorb it), so
        // the shadow and the lit copy travel with the body as they must.
        mv.hopOff = this.hopOffsetFor(mv, dt);
        const hx = (mv.hopOff ?? 0) * (mv.hdx ?? 0);
        const hy = (mv.hopOff ?? 0) * (mv.hdy ?? 0);
        mv.sprite.x = mv.lx + hx;
        // Winged flyers levitate hoverPx above the ground anchor; the nadir
        // shadow stays ON the ground (placeBodyShadow gets the hover as air
        // height, so it shrinks/fades slightly — the bird pattern). A tuned
        // anchor already contains the hover gap (see addMonster).
        mv.sprite.y = mv.ly - (mv.tuned ? 0 : mv.hoverPx) + hy;
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
        // Per-frame body-mass re-pinning belongs to the LEGACY contract: a
        // tuned monster's art moves inside its frame as the animation animates
        // — that is real motion around the anchor, not drift to compensate.
        const ox = mv.tuned ? undefined : gd?.shift?.[fi];
        if (ox !== undefined) mv.sprite.setOrigin(ox, gd!.f);
        const airPx = gd?.air?.[fi] ?? 0;
        // Damage float + blood + hp bar (RO: you SEE the number and the wound).
        if (mv.lastHp !== undefined && m.hp < mv.lastHp) {
          this.spawnDamageFloat(mv.lx, mv.sprite.y - mv.sprite.displayHeight * mv.sprite.originY, `${mv.lastHp - m.hp}`, 0xffe08a);
          // Origin-relative ONLY for a tuned monster, whose anchor moved to the
          // shadow centre. An untuned monster keeps the shipped fixed −0.45·h
          // EXACTLY: the origin-relative form is identical only at the 0.85
          // anchor this once assumed, and real measured anchors are
          // ground[dir].f — it moved blood by −8.7 px on saber_toothed_tiger
          // and −16.1 px on dark_donkey, which is a visible change to shipped
          // monsters that has nothing to do with tuned shadows.
          this.spawnBloodFx(
            mv.lx,
            mv.tuned
              ? mv.sprite.y - mv.sprite.displayHeight * (mv.sprite.originY - 0.4)
              : mv.sprite.y - mv.sprite.displayHeight * 0.45,
          );
        }
        mv.lastHp = m.hp;
        this.updateMonsterHpBar(mv, m, id);
        this.resolveBodyDepth(mv, sLvl);
        if (mv.tuned) {
          // THE TUNED ELLIPSE, TURNED WITH THE FACING. Rotated on the GROUND
          // (shared shadowScreenEllipse — same math the wiki previewed), and
          // centred exactly on the monster's position: no toe-kiss, no contact
          // heuristics. Where it sits IS what the Game Master placed.
          // ONE SIZE: the animation's own `air[]` and the flyer's `hoverPx` are
          // NOT fed to the hop shrink here. Both are baked into the tuned
          // anchor, and a shadow that breathes with the idle cycle is not the
          // one size he placed (measured on diablo_2: −4.6% width every idle
          // loop, −13% on walk south; a tuned butterfly_dragon would have sat
          // permanently 11% small and 15% faint). A real FALL still shrinks it
          // — placeBodyShadow derives that from the drawn height itself.
          this.placeTunedShadow(mv, targetElev);
        } else {
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
        }
        // A hopping body's shadow travels WITH it — placeBodyShadow anchors on
        // the ease state (mv.lx), which is deliberately free of the surge.
        if (hx || hy) mv.shadow.setPosition(mv.shadow.x + hx, mv.shadow.y + hy);
      });
      this.monstersActive = active;
    }

    // The world's people: placed by maps2, drawn through the shared body
    // pipeline, breathing on their own calm clocks.
    this.ps();
    this.stepNpcs();
    this.pe("stepNpcs");
    // Sword marker + target frame + aggro-radius debug rings (all read the
    // freshly-updated monster sprites above).
    this.updateTargetOverlays();
    // The pickup sound, held until the hand actually reaches the ground —
    // before stepGroundDecor, so the sound and the item vanishing land on the
    // same frame rather than one frame apart.
    this.stepPickupSfx();
    // Grave crosses (appear → hold → reverse) + the drop end-of-life flash.
    this.stepGroundDecor();

    if (this.death) this.stepDeath(this.time.now);
    this.updateChaseCam(delta);

    // The bonfire is world ART and is DRAWN wherever it stands — indoors the
    // outside is no longer a void, so nothing about the room hides it. Its
    // LIGHT is a different question, answered below with every other light
    // source: while indoors, only lights inside my room count (the maintainer
    // 2026-08-07, "point light from outside has to be turned off" —
    // the_island2 puts this fire ~5 cells from the house door, well inside its
    // radius-7 pool, so leaving it alone pours firelight through the wall onto
    // the floor). Its lit copy is gated to match, in syncLitCopies.
    this.campfireSprite?.setVisible(this.fireOn);
    const fireLit = !!this.campfire && this.fireOn;
    // How much of the fire's LIGHT survives — 1 outdoors or when it shares my
    // room, easing to 0 as I shut the door on it. The shader light is faded by
    // the room filter below; this is the same factor for everything the shader
    // cannot reach: the two additive blooms and the flame's full-bright lit
    // copy, all of which draw ABOVE the darkness overlay.
    this.fireRoomK =
      fireLit && this.campfire && !this.inMyRoom(this.campfire.col, this.campfire.row)
        ? 1 - this.indoorGrade()
        : 1;

    // Night lighting (always on): per-pixel point lights with heightmap
    // line-of-sight when WebGL is available; the multiply grade otherwise.
    const shaderNight = !!this.night;
    this.night?.setActive(shaderNight);
    this.atmo.suppressGrade = shaderNight;
    if (shaderNight && this.world) {
      // THE LIGHT SLOT LEDGER (maintainer 2026-08-12) — 12 slots, laid out so
      // no system can starve another. See lightslots.ts for the contract:
      //   1 my own torch · 1 ambient agent · 2 future fx · 8 the world.
      // Push order below IS the layout. The QA probe light consumes a WORLD
      // slot when set, so the total can never exceed MAX_SHADER_LIGHTS.
      const sl: ShaderLight[] = [];
      // Debug-only probe light (set via __ml.probeLight) — lets headless
      // verification place a light at an exact grid position, since walking
      // there is dt-clamped to a crawl on slow headless clients.
      if (this.probeLight) sl.push(this.probeLight);
      // [SLOT: MY TORCH] — and ONLY mine. Remote players' torches are no
      // longer lights at all (maintainer 2026-08-12: "a player can only ever
      // see its own torch") — with 8 slots handed to the world, a crowded
      // street of torch-bearers would otherwise be the thing that starves it.
      //
      // MY TORCH IS ALSO THE DEATH LIGHT (2026-08-12: "the players torch will
      // be the thing that highlights the player being dead"). It rides the
      // SAME eased curve as the zoom and the veil, so a torch that was out —
      // broad daylight, or switched off — kindles as the world goes dark
      // instead of popping on at the first dead frame; one already burning is
      // untouched, max() can only raise it.
      const dt0 = this.death ? Math.min(1, (this.time.now - this.death.at) / DEATH_ZOOM_MS) : 0;
      const deathTorch = dt0 > 0 ? 1 - Math.pow(1 - dt0, 3) : 0;
      const me = myId ? this.avatars.get(myId) : undefined;
      this.lastSlotInfo.torch = false;
      if (me) {
        // Day gate + doorway override, now for one body: full Day outdoors a
        // torch has no impact; indoors the doorway fade re-enables it.
        const base = Math.max(this.curTorchF, this.indoorContains(me.fx, me.fy) ? this.indoorGrade() : 0);
        const tf = Math.max(this.torchOn ? base : 0, deathTorch);
        if (tf > 0.01) {
          this.lastSlotInfo.torch = true;
          // Grid position from the FLAT authoritative coords (1 cell = CELL_WU
          // world units) — the projected lx/ly live in screen space and put
          // the torch underground, so the terrain shadowed its own light.
          // Held low (waist height), anchored to the RENDERED elevation
          // (litLevelOf) so a torch carried onto a deck lights the deck.
          // While dead it goes OVERBRIGHT (the clamp widens the plateau
          // instead of blowing out) — that is what survives the death veil.
          const k = tf * (1 + (DEATH_TORCH_BOOST - 1) * deathTorch);
          sl.push({
            col: me.fx / CELL_WU,
            row: me.fy / CELL_WU,
            z: this.litLevelOf(me) + 0.55,
            radius: 6,
            color: [0.85 * k, 0.58 * k, 0.32 * k],
            flicker: 0.35, // hand torch: gentle fire flicker
          });
        }
      }
      // [SLOT: AMBIENT AGENT] + [2 FX SLOTS] — reserved write-side APIs in
      // lightslots.ts. Empty slots stay empty: the reservation is strict, a
      // loan would mean a world light pops off when the owner shows up.
      const rl = reservedLights();
      this.lastSlotInfo.reserved = 0;
      for (const l of [rl.ambient, rl.selfFx, rl.monsterFx])
        if (l) {
          sl.push(l);
          this.lastSlotInfo.reserved++;
        }
      // [8 WORLD SLOTS] — the campfire scenery + every emissive tile/prop in
      // range, as REAL lights at last. Overflow keeps the glow stamp.
      this.pickWorldLights(sl, fireLit, this.game.loop.delta);
      this.lastSlotInfo.total = sl.length;
      // LIGHT SOURCES OUTSIDE MY ROOM DO NOT REACH IT (maintainer 2026-08-07:
      // "point light from outside has to be turned off"). This became load
      // bearing the moment the outside stopped being a void: it is drawn now
      // and lit only by point lights, so an un-filtered bonfire in the street
      // would be the ONE thing illuminating everything you are supposed to
      // have shut the door on — and it would pour back through the doorway.
      //
      // The gate is the light's own CELL against the room mask, which is the
      // same set the shader gives ambient to, so "what is lit" and "what lights
      // it" can never disagree. My torch is inside by construction, so its
      // spill through the doorway — the reveal he asked for — survives.
      //
      // FADED on the GRADE, not switched: an outside light dies over the same
      // quick ramp the outside ambient does, so nothing on screen steps.
      // The debug PROBE is exempt. It is the only instrument a headless gate
      // has for "the outside tiles really are drawn" — with ambient at zero a
      // drawn tile and a missing one are pixel-identical, and a light is the
      // only thing that tells them apart. Filtering it would make the gate
      // unable to see the very property this change exists to create.
      if (this.roomMask)
        for (let i = sl.length - 1; i >= 0; i--) {
          const L = sl[i];
          if (L === this.probeLight) continue;
          if (this.inMyRoom(L.col, L.row)) continue;
          const k = 1 - this.indoorGrade();
          if (k <= 0.01) sl.splice(i, 1);
          else L.color = [L.color[0] * k, L.color[1] * k, L.color[2] * k];
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
      // INDOOR GRADE. Blend the FINISHED outdoor ambient (cloud grey + rain
      // gloom already applied) toward INDOOR_AMBIENT, rather than mutating
      // `curAmbient`: a storm outside has no bearing on a sealed room, mix=1
      // lands exactly on INDOOR_AMBIENT whatever the weather is doing, and
      // `curAmbient` stays the OUTDOOR world clock — which matters because
      // setTimeOfDay snapshots it as `timeFromAmbient` (writing the interior
      // grade there would ease FROM it toward the next phase and pop bright)
      // and `__ml.timeOfDay()` / verify-timecycle read it.
      const iF = this.indoorGrade();
      // The interior target is READ PER FRAME from the Settings slider — it is
      // a live tuning dial, so a drag has to show while you stand in the room.
      // Cheap: three multiplies, no allocation beyond the triple itself.
      const indoorTarget = indoorAmbient();
      // Kept SEPARATELY, because the two are for different halves of the world
      // while the crossing eases: `ambOut` is what a cell OUTSIDE my room is
      // heading for, `ambEff` is what a cell INSIDE it gets. Blending the
      // outside toward the indoor grade is what made stepping out of a house at
      // night FLASH — the maintainer, 2026-08-07: "it snaps to a brightness
      // brighter than night and has to fade back down". See uAmbientOut.
      const ambOut = this.curAmbient.map((v) => {
        const grey = (this.curAmbient[0] + this.curAmbient[1] + this.curAmbient[2]) / 3;
        const clouded = v + (grey * 0.94 - v) * this.curCloud * 0.22;
        return clouded * (1 - this.curPrecipDim);
      }) as [number, number, number];
      const ambEff = ambOut.map((outdoor, i) => outdoor + (indoorTarget[i] - outdoor) * iF) as
        [number, number, number];
      // …and the SKY terms have to go with it, or the roof we just deleted
      // stops being the only thing keeping the room dark:
      //   uSun.w is `sunShare` — `sunF = (1-sunShare) + sunShare*sunVis` — so
      //     zeroing it gives sunF = 1.0 exactly: no directional term, no cast
      //     shadows, and the interior sits on INDOOR_AMBIENT at EVERY hour.
      //     Left alone, a day interior would be 0.55x a night one, and the
      //     maintainer's rule is "always dark as during the night". This is
      //     also precisely the knob the future doorway daylight turns back up
      //     (per cell, for cells with line of sight to an `entrances` cell).
      //   cloud/aurora/mist: you cannot see the sky from inside.
      // this.curSun itself is untouched — __ml.sunAt/sunInfo keep reporting the
      // WORLD clock, which is what they are for.
      const sunIn: [number, number, number, number] = [
        this.curSun[0],
        this.curSun[1],
        this.curSun[2],
        this.curSun[3] * (1 - iF),
      ];
      // The cel-shaded DISTANCE fog is a distance cue for open country; indoors
      // it paints its teal/pale bands over the black void that is supposed to
      // BE the outside. `fogScale` is a separate multiplier from `fogStrength`
      // so the __ml.depthFog debug knob keeps owning the master value.
      if (this.night) this.night.fogScale = 1 - iF;
      // THE SURFACE RESOLVE MUST FORGET THE ROOF TOO. uHeight reports
      // max(terrain, deck), so with the roof culled every floor pixel still
      // resolves to the CEILING's level and the torch — held at z 0.55 — is
      // attenuated as if it were ~3.3 cells above the ground it stands on
      // (measured: 0.631 -> 0.211 at the player's own cell). Flip it on the
      // GEOMETRY, not the light blend: the roof is drawn or it is not, and
      // indoorInside is what the ground RT and the occluders already switch on,
      // so the height map can never disagree with the art on screen.
      if (this.night) {
        // The BOOLEAN geometry state, never indoorMix — the mask flips with the
        // verdict and the light eases behind it, so a resolve driven by the ease
        // would read half-cut geometry for a quarter-second on every doorway.
        // The shader's surface clamp follows the VERDICT on the way out, not
        // the drawn state (maintainer 2026-08-13, the exit-fade colour snap):
        // through the exit fade the debris IS the returning geometry, and the
        // light it wears must be the light it will keep. Clamped, the roof
        // pixels resolved to the shadowed interior behind them and the mix-0
        // repaint swapped a dark slab for a sunlit one — the art never
        // changed, its LIGHT did ("the top of the roof completely changes
        // color"). Unclamping at the exit FLIP lights the whole fade as the
        // real outdoor world, so the final swap has nothing left to change.
        // The accepted cost is the mirror image, on the half you are leaving:
        // for the first fraction of a second the still-visible interior is
        // tinted as the surfaces returning above it — under a debris layer
        // already fading in over it, where the roof snap was the LAST frame,
        // in full view. Entry keeps the clamp from its own flip: the room you
        // are entering lights as a room immediately.
        this.night.indoor = this.indoorInside && !!this.indoorMask;
        this.night.indoorTop = this.indoorTop;
        // The LIGHT half of the same state rides the GRADE — 1.5×, its own
        // clip: a bit faster than the raw roll (maintainer 2026-08-13: the
        // darkening trailed the roof by the rest of the roll), deliberately
        // slower than the debris' 3× (same day: everything at 3× read as one
        // big snap — "the roof fade is intended to be faster to hide bugs").
        this.night.indoorMix = this.indoorGrade();
        // What the OUTSIDE is fading between: black and this, never the
        // interior grade. Set every frame — the outdoor phase keeps moving
        // while you stand indoors.
        this.night.ambientOut = ambOut;
      }
      // Local player drives the cel-shaded distance fog: its rendered elevation
      // (so the fog eases as it climbs/falls) + its cell (col,row) for the
      // horizontal distance term.
      const meAv = this.avatars.get(this.room?.sessionId ?? "");
      const playerZ = meAv ? Math.max(0, meAv.elev / this.geom.lh) : 0;
      const playerCol = meAv ? meAv.fx / CELL_WU : 0;
      const playerRow = meAv ? meAv.fy / CELL_WU : 0;
      // A source holding a REAL light slot hands its ground POOL stamp back —
      // the light replaces it (keeping both double-brightens ground and
      // characters: curLights and curStamps both feed lightAt). CROSSFADED on
      // the tenure ramp: while the light fades in, the pool fades out under it
      // at exactly the complementary weight, so acquiring a slot mid-view is a
      // dissolve between the two looks, never a swap. High halos (ry unset)
      // stay: they are the art's own bloom. The glow RT repaints from this
      // array every frame, so this is a map, not a rebuild.
      const stampsDrawn = this.slotTenure.size
        ? this.glowStamps.flatMap((g) => {
            if (!g.srcId || g.ry === undefined) return [g];
            const t = this.slotTenure.get(g.srcId);
            if (!t || !this.slotLit.has(g.srcId)) return [g];
            if (t.ramp >= 1) return [];
            const k = t.ramp * t.ramp * (3 - 2 * t.ramp);
            return [{ ...g, alpha: g.alpha * (1 - k) }];
          })
        : this.glowStamps;
      this.night!.update(
        this.cameras.main,
        sl,
        ambEff,
        stampsDrawn,
        sunIn,
        this.curCloud * (1 - iF),
        this.curAurora * (1 - iF),
        this.curMist * (1 - iF),
        playerZ,
        playerCol,
        playerRow,
      );
    }

    const lights: LightSource[] = [];
    if (fireLit && this.campfire && this.fireRoomK > 0.01) {
      const c = this.campfire;
      // Additive bloom hugging the flames (both render paths) — the shader
      // lights the WORLD but the fire itself must also glow, like the ref.
      // Slow breathing, not a strobe: ~4s and ~1.4s periods, small swing.
      // Both alphas are scaled by fireRoomK: they are ADDITIVE, so nothing
      // else can take them away when the fire is out on the grass and I have
      // closed the door on it.
      const flick = 0.52 + Math.sin(this.time.now / 640) * 0.05 + Math.sin(this.time.now / 225) * 0.03;
      const k = this.fireRoomK;
      lights.push({ x: c.x, y: c.y - 9, color: 0xff8830, radius: 72, alpha: flick * k, depth: c.depth + 0.2 });
      // Flame-core bloom ABOVE the night grade + vignette so the flame never
      // goes dull at screen edges — but sized to HUG the flame (a big fixed
      // disc read as a floating ball from afar) and scaled by proximity, so
      // the fire joins the brightens-as-you-approach effect.
      const camMid = this.cameras.main.midPoint;
      const camDist = Math.hypot(c.x - camMid.x, c.y - camMid.y);
      const near = Math.max(0.45, Math.min(1, 1.15 - camDist / 1400));
      lights.push({ x: c.x, y: c.y - 12, color: 0xffb75a, radius: 12, alpha: (flick + 0.2) * near * k, depth: 900_005 });
      if (!shaderNight)
        lights.push({ x: c.x, y: c.y, color: 0xff9e4a, radius: 120, ground: true, depth: c.depth + 0.1 });
    }
    if (!shaderNight) {
      // MY torch only — same rule as the shader path (2026-08-12: remote
      // players' torches are never lights), same death term so the corpse is
      // lit on the Canvas renderer too.
      const dt0 = this.death ? Math.min(1, (this.time.now - this.death.at) / DEATH_ZOOM_MS) : 0;
      const deathTorch = dt0 > 0 ? 1 - Math.pow(1 - dt0, 3) : 0;
      const meAv = myId ? this.avatars.get(myId) : undefined;
      if (meAv) {
        const base = Math.max(this.curTorchF, this.indoorContains(meAv.fx, meAv.fy) ? this.indoorGrade() : 0);
        const tf = Math.max(this.torchOn ? base : 0, deathTorch);
        if (tf > 0.5) lights.push({ x: meAv.lx, y: meAv.ly - 20 }); // lantern pool
      }
      lights.push(...this.emissiveLights);
    }
    this.applyObjectLights();
    // After every body has registered AND both consumers have read their slot,
    // before render: rasterise the surfaces the frame's images point at.
    this.flushCoverSurfaces();
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

  // (torchLit(id) is gone with the remote torch lights, 2026-08-12: only MY
  // torch is ever a light — "a player can only ever see its own torch" — so
  // the preference is just this.torchOn. Player.torch stays synced on the
  // server; nothing here reads it any more.)

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
    const fogOn = on && night!.sceneryFog;
    for (const lo of this.litOccluders) {
      lo.img.setVisible(on);
      if (!on) {
        lo.fog?.setVisible(false);
        continue;
      }
      /* DEPTH-FOG ON SCENERY AND PROPS (maintainer 2026-09-03: fogged ground,
       * crisp skulls, spires and tree roots "pop out"; "a tall scenery object
       * will have the same fog at the top as at the bottom"). The lit copy sits
       * ABOVE the fog overlay, so the wash never reached it. Fading the copy
       * (the bodies' cross-fade) is NOT enough: the fog under it is itself
       * weighted by a, so the piece composited to a·a fog against the ground's
       * a — half the wash at a=0.5, the root still near-black beside grey
       * ground. EXACT instead: a FOG SILHOUETTE — the same art, tintFill in
       * the fog's own colour, alpha a — drawn right over the opaque copy, which
       * composites to copy·(1-a) + fogcol·a, precisely what the pass paints on
       * the ground under it (g·light·(1-a) + fogcol·a). ONE a and ONE colour per
       * piece, read at ITS FOOT POINT through the pass's own distance field
       * (depthFogAtFoot: the fragment's smooth screen-space field, NOT the true
       * cell distance — a plateau tree drawn below the player is NEAR ground to
       * the pass), band centred between the tread's snapped steps so it fades
       * gradually and never more than half a band from the ground it stands
       * on; at the tread's integer level. Fog 0 → nothing drawn. */
      /* COVERED BY TERRAIN? The lit copy sits at litDepth — ABOVE every terrain
       * occluder — so without this a tree behind a hill drew its whole self over
       * the hill (maintainer 2026-09-03: "the trees around the player should be
       * covered by the hill"). The BASE image is sorted correctly in the world
       * layer; the copy just has to show the same part of it, which is exactly
       * what bodies do with `coverY` in syncLitCopy. Computed ONCE per rebuild:
       * both the piece and the terrain are static. */
      if (lo.cover !== undefined && lo.cover !== Infinity) {
        const im = lo.img;
        const cropH = (lo.cover - im.y) / (im.scaleY || 1);
        if (cropH <= 0) {
          im.setVisible(false);
          lo.fog?.setVisible(false);
          continue;
        }
        im.setCrop(0, 0, im.frame.cutWidth, cropH);
        lo.fog?.setCrop(0, 0, im.frame.cutWidth, cropH);
      } else if (lo.img.isCropped) {
        lo.img.setCrop();
        lo.fog?.setCrop();
      }
      const f = night!.depthFogAtFoot(lo.bx, lo.by, Math.floor(lo.z), lo.col, lo.row);
      const fa = fogOn ? Math.min(1, Math.max(0, f.a)) : 0;
      if (fa > 0.002) {
        if (!lo.fog) this.makeFogSilhouette(lo);
        const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
        lo.fog!.setTintFill((c(f.r) << 16) | (c(f.g) << 8) | c(f.b)).setAlpha(fa).setVisible(true);
      } else lo.fog?.setVisible(false);
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
      // ...and its fog silhouette, or a distant swimmer wears fog-coloured legs
      // over the water.
      if (a.fog) {
        if (a.swimming && a.swimT > 0.001 && a.waterMask) a.fog.setMask(a.waterMask);
        else if (a.fog.mask) a.fog.clearMask();
      }
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
    // NPCs ride it too. They were the ONE body type without a lit copy, which
    // meant their light came entirely from the multiply overlay — and the
    // overlay is per SCREEN PIXEL, lighting each pixel by the terrain cell the
    // ray resolves BEHIND it. For a 64px-tall sprite that is the cell several
    // steps UP-SCREEN of its feet, which outdoors is close enough to pass and
    // indoors is plainly wrong: a villager standing one step outside my door
    // had black legs and a fully lit head and shoulders, because her head
    // pixels resolved to my floor. The lit copy samples the light at the
    // BODY's own cell, once, like players and monsters already do.
    for (const nv of this.npcs.values())
      if (!nv.culled) this.syncLitCopy(nv, on, 0xffffff);
    if (this.campfireSprite) {
      if (!this.campfireLit) {
        this.campfireLit = this.add
          .sprite(this.campfireSprite.x, this.campfireSprite.y, CAMPFIRE_KEY)
          .setOrigin(0.5, CAMPFIRE_BASE)
          .setScale(CAMPFIRE_SCALE);
      }
      // INDOORS the flame's lit copy follows fireRoomK. Everything else on this
      // pass is tinted by the CPU light field, which already zeroes the ambient
      // outside the room — but this copy carries no tint at all (the fire is
      // its own light, at full brightness by definition), so without the gate a
      // bonfire out on the grass keeps burning bright above the darkness
      // overlay while its LIGHT has been filtered out of the shader. Art and
      // light have to agree: hide the copy and the base sprite is left to the
      // shader, which paints it black out there and lets a torch reveal it like
      // any other outside pixel.
      this.campfireLit
        .setVisible(on && this.fireOn && this.campfireSprite.visible && this.fireRoomK > 0.01)
        .setAlpha(this.fireRoomK)
        .setFrame(this.campfireSprite.frame.name)
        .setPosition(this.campfireSprite.x, this.campfireSprite.y)
        .setDepth(litDepth(this.campfireSprite.depth));
      // Like the avatar lit copies: a camera-forward SOLID structure whose
      // art overlaps the fire must cover its lit copy too — otherwise the
      // flames float on top of the pillar in front (playtester report).
      //
      // DELIBERATELY THE LAST FLAT-LINE CONSUMER IN THE FILE. Bodies moved to
      // the per-pixel cover surfaces (2026-08-09); this did not, and should
      // not: it is the lit copy of a STATIC prop at a fixed spot, its "body" is
      // a flame halo with no silhouette to trace, and it never gets an outline
      // — so there is no second layer here for a flat line to disagree with.
      // Not forgotten; if the fire ever grows a cover outline, give it a slot.
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

  /** Remember the cell I stand on in this world (localStorage, every few
   *  seconds): the next boot loads the monster art of THIS neighbourhood too,
   *  because a returning player lands on their saved spot, not the spawn. */
  private saveLastPos() {
    const now = this.time.now;
    if (now - this.lastPosSavedAt < 3000) return;
    this.lastPosSavedAt = now;
    const me = this.room?.state.players?.get(this.room.sessionId);
    if (me) writeLastPos(this.worldName, me.x / CELL_WU, me.y / CELL_WU);
  }

  private predictAndSend(dt: number) {
    this.saveLastPos();
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
          // The stick moved: whatever was being rounded is no longer the ask.
          if (this.stickTrip && (ax !== this.stickDir.ax || ay !== this.stickDir.ay)) {
            this.stickTrip = null;
            this.walkHold.ax = 0;
            this.walkHold.ay = 0;
          }
          this.stickDir = { ax, ay };
          /* ONE decision, shared and headless-tested — see walkHeading. It owns
           * the whole order: hold a commitment, follow a planned detour, the
           * local assist, plan round a footprint, slide rather than stand
           * still, never retreat. The order is the part that was wrong, which
           * is exactly why it does not live inline here any more. */
          const r = walkHeading(this.terrain, me.fx, me.fy, ax, ay, this.walkHold, {
            nowMs: performance.now(),
            trip: this.stickTrip,
            fromElev: me.surfLevel ?? undefined,
            worldW: this.worldW,
            worldH: this.worldH,
          });
          ax = r.ax;
          ay = r.ay;
          this.stickTrip = r.trip;
        }
      }
    } else {
      this.stickTrip = null; // stick released
      this.walkHold.ax = 0;
      this.walkHold.ay = 0;
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
    /* THE TAP PATH GETS THE SAME FLOOR. `walkHeading` covers a held direction;
     * a tap trip can wedge against a footprint just as easily, and standing
     * still with open ground beside you is never the right answer. Keys already
     * went through walkHeading above, so this only ever fires for the autopilot.
     * Its own memo: the two paths must not share a commitment. */
    if (this.terrain && !this.keysActive && (ax !== 0 || ay !== 0)) {
      const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
      if (me && bodyStalled(this.terrain, me.fx, me.fy, ax, ay)) {
        const sl = slideAlong(this.terrain, me.fx, me.fy, ax, ay, this.tapSlide);
        if (sl) {
          ax = sl.ax;
          ay = sl.ay;
        }
      } else if (this.tapSlide.ax !== 0 || this.tapSlide.ay !== 0) {
        this.tapSlide.ax = 0;
        this.tapSlide.ay = 0;
      }
    }
    // SOFT MONSTER COLLISION (maintainer 2026-07-30): monsters are not in the
    // collision grid — no network or pathfinder cost — so the INPUT slips
    // around a monster's personal space instead, exactly like steer assist
    // slips around a prop corner. Applies to keys AND the autopilot; the
    // deflected vector is what gets predicted AND sent, so the server
    // integrates the same move and nothing rubber-bands.
    if ((ax !== 0 || ay !== 0) && (this.monsters.size || this.npcs.size)) {
      const me = this.room ? this.avatars.get(this.room.sessionId) : undefined;
      if (me) {
        // Per-monster ART radii (v2): a mammoth deflects the walker from ~4×
        // the distance a poring does, so the near-filter box must admit the
        // biggest bodies' lookahead (~140wu), not the old fixed 48.
        const near = this.nearBodies(me.fx, me.fy);
        // Which way round a body is WALKABLE, not just roomier — simulated
        // with the real movement tick, the same instrument steerAssist uses,
        // so the dodge can never disagree with the collision probes. Without
        // it the dodge is pure geometry and will happily send you into a wall
        // that happens to be on the roomier side of the person in your way.
        const openHeading = this.terrain
          ? (hax: number, hay: number) => {
              const walk = { maxClimb: WALK_CLIMB, canSwim: true };
              const dt = 0.08; // ≈5.6wu at walk speed — one substep plus margin
              const r = stepMovement(
                me.fx, me.fy, hax, hay, false, dt,
                makeBlockedElev(this.terrain!, walk, () => me.surfLevel ?? 0),
                1, true, this.worldW, this.worldH,
                makeSideBlocked(this.terrain!, walk),
              );
              return Math.hypot(r.x - me.fx, r.y - me.fy) > WALK_SPEED * dt * 0.35;
            }
          : undefined;
        // `now` + allowPass arm THE PASS (the "special move"): when a body
        // blocks the only lane the dodge stops negotiating and walks straight
        // through, with the little crossover jink when a sliver exists —
        // instead of the back-and-forth panic (maintainer 2026-08-13).
        const dodge = near.length
          ? monsterDodge(me.fx, me.fy, ax, ay, near, this.dodgeState, undefined, openHeading, this.time.now, true)
          : null;
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
    const { dx, dy, lh, tile } = this.geom;
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
    const { dx, dy, lh, tile } = this.geom;
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
    const { dx, dy, lh, tile } = this.geom;
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
    // INDOORS a flyer outside my room needs NO special case any more. lightAt
    // now returns ~zero there by itself (the ambient is gated on the room mask,
    // and `l` is a MULTIPLY tint in critters.ts), so a bird over the grass goes
    // black on its own — and correctly lights up again when it crosses my
    // torch's spill through the doorway, which a hard [0,0,0] could never do.
    // The shadow follows the same reasoning: there IS drawn ground under it
    // now, so suppressing the shadow would be the artefact.
    //
    // The one case still worth stating is a flyer AT OR ABOVE MY CEILING. Its
    // ground point is honestly inside the room — a bird cruising 70-120px up
    // over the house has its cell on the interior floor — but it is outside the
    // room and above the cut, so it must not take the room's ambient. Blacking
    // it here is exactly the `z < indoorCeil` half of indoorOutside.
    if (
      this.indoorInside &&
      this.indoorMask &&
      z >= this.indoorCeil &&
      (this.indoorMask.get(Math.floor(row) * this.world.width + Math.floor(col)) ?? 0) !== 0
    )
      return {
        l: [0, 0, 0], fog: 0, fogCol: [0, 0, 0],
        // `lift` > alt is applyShadow's own "draw no shadow" case, and it is
        // right here: the ceiling this thing is flying above is not drawn.
        col, row, L, cellL, lift: altPx + 1, shadowDepth: gy + 3, z,
      };
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

  private pickGround(
    wx: number,
    wy: number,
    // Ignore EVERY surface at or above this level — decks AND raised terrain —
    // so the scan falls through to the other surface drawn under the same
    // pixel. That surface is a different CELL (the projection subtracts
    // level*lh from screen y), which is why it looks like the same spot.
    //
    // Decks alone was a real gap: a CLIFF is plain terrain, so the re-scan
    // matched the same cliff top again, left one candidate, and the walker
    // always climbed — even when two steps would have put her behind it
    // (maintainer 2026-08-08: "did you only try two paths if I clicked on a
    // roof and forgot that a cliff can also mean two things?").
    ignoreAtOrAbove?: number,
  ): { x: number; y: number; lvl: number } | null {
    const clampW = (x: number, y: number, lvl: number) => ({
      x: Math.max(1, Math.min(this.worldW - 1, x)),
      y: Math.max(1, Math.min(this.worldH - 1, y)),
      lvl,
    });
    if (!this.world) return clampW(wx, wy, 0); // plain-ground fallback: screen == flat world
    const { dx, dy, lh, tile } = this.geom;
    const u = (wx - this.iso.ox - tile / 2) / dx;
    // A TAP MUST RESOLVE AGAINST WHAT IS ON SCREEN, and indoors that is the
    // CUT-AWAY: nothing above `indoorTop` is drawn and the roof slab is not
    // drawn at all. Resolving against the untruncated data instead put EVERY
    // indoor tap on the roof deck — the scan runs top-down and the house's
    // slab matched at level 6 before the floor could match at 0, so the walk
    // target landed 6 levels' worth of screen y down-screen of the finger
    // (maintainer 2026-08-07: "the player walks to a spot about a full
    // character in length under the spot I actually clicked on. This makes it
    // really hard to point and click navigate indoors").
    // "What is drawn" is the INDOOR MASK's presence, not the verdict: the exit
    // fade keeps the cut world painted for the length of the light roll, and a
    // tap during it must still resolve against the picture on screen.
    const drawn = !!this.indoorMask;
    const cuts = drawn ? this.indoorCut : null;
    // Legacy kill-switch cut (cuts null): the scalar world-wide truncation —
    // nothing above the dial exists anywhere. With per-cell cuts the drawn
    // world reaches full height wherever a column is unconstrained (the
    // neighbour's roof is a real tappable deck again).
    const scanTop = drawn && !cuts ? this.indoorTop : this.maxLevel;
    for (let l = scanTop; l >= 0; l--) {
      const v = (wy - this.iso.oy - dy + l * lh) / dy;
      const col = (u + v) / 2;
      const row = (v - u) / 2;
      const ci = Math.floor(col);
      const ri = Math.floor(row);
      const cell = this.world.rows[ri]?.[ci];
      if (!cell) continue;
      const cutE = drawn ? (cuts ? cuts.get(ri * this.world.width + ci) : this.indoorTop) : undefined;
      // world@2: a deck slab drawn at level l here is the TOP surface — tapping
      // it targets the deck (bridge/roof), not the base underneath. Skipped for
      // CONSTRAINED cells indoors, where the slab is exactly what is not drawn
      // (my roof, or a lid over my floor); an unconstrained deck — the
      // neighbour's roof, a far bridge — is painted and taps like outdoors.
      if (cutE === undefined) {
        const deckL = this.terrain?.deck[ri * this.world.width + ci] ?? -1;
        if (deckL === l && !(ignoreAtOrAbove !== undefined && deckL >= ignoreAtOrAbove))
          return clampW(col * CELL_WU, row * CELL_WU, l);
      }
      // THE CUT TRUNCATES THE DRAWING, NOT THE WORLD. A parapet you can see
      // over is still a full-height wall you cannot stand on, so a tap that
      // lands on its drawn top means the FLOOR BEYOND it — keep scanning down.
      // Resolving to the parapet instead put the target 2 levels (2.13 cells)
      // past the finger for every tap near a wall, which is the same bug as
      // the roof deck one level down and just as invisible from the code.
      // A wall SHORTER than its cut is not truncated and stays tappable: its
      // top is a real sill, and it is drawn exactly where it is — a raised
      // wall drawn whole included.
      if (cutE !== undefined && cell.l > cutE) continue;
      if (cell.l !== l) continue;
      // Re-resolve mode: this surface is the one we are looking UNDER.
      if (ignoreAtOrAbove !== undefined && l >= ignoreAtOrAbove) continue;
      const s = surfaceFor(cell.t);
      if (!s.standable && !s.swimmable) {
        // Re-resolve mode asks "what GROUND is under this pixel, given I am
        // ignoring the slab it hit" — so a solid on the way down is something
        // to look UNDER, not a reason to give up. The ray from a roof pixel
        // crosses the wall carrying that roof, and aborting there is why an
        // earlier cut of this never found the second reading at all.
        if (ignoreAtOrAbove !== undefined) continue;
        return null; // tapped a solid prop/structure
      }
      return clampW(col * CELL_WU, row * CELL_WU, l);
    }
    return null; // void (outside the drawn world)
  }

  /** The nearest spot a body can STAND whose drawn position is closest to a
   * camera-world pixel. Used when the pixel's own ground reading is a wall or
   * empty — the walker must still end up as near the marker as the world
   * allows, and "the cell under the one you clicked" is 96px away, not near.
   *
   * Screen distance, not world distance: the marker is a pixel, and two cells
   * equally far in world terms can be a storey apart on screen. Bounded to a
   * small ring around the pixel's own ground cell — this runs once per tap. */
  private nearestGroundTo(wx: number, wy: number): { x: number; y: number; lvl: number } | null {
    const g = this.terrain;
    if (!g || !this.world) return null;
    const { dx, dy, lh, tile } = this.geom;
    const u = (wx - this.iso.ox - tile / 2) / dx;
    const v = (wy - this.iso.oy - dy) / dy; // the LEVEL-0 reading of this pixel
    const c0 = Math.floor((u + v) / 2);
    const r0 = Math.floor((v - u) / 2);
    let best: { x: number; y: number; lvl: number } | null = null;
    let bestD = Infinity;
    for (let dr = -4; dr <= 4; dr++)
      for (let dc = -4; dc <= 4; dc++) {
        const c = c0 + dc;
        const r = r0 + dr;
        const cell = this.world.rows[r]?.[c];
        if (!cell) continue;
        const surf = surfaceFor(cell.t);
        if (!surf.standable) continue;
        if (g.blocked[r * g.width + c]) continue;
        // Where this cell's surface DRAWS, against the pixel we are aiming at.
        const sy = this.iso.oy + (c + r) * dy + dy - cell.l * lh;
        const sx = this.iso.ox + (c - r) * dx + tile / 2;
        const d = Math.hypot(sx - wx, sy - wy);
        if (d < bestD) {
          bestD = d;
          best = { x: (c + 0.5) * CELL_WU, y: (r + 0.5) * CELL_WU, lvl: cell.l };
        }
      }
    return best;
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
    if (this.tapMarkerAt && this.tapMarker) {
      // Pinned: the gesture already decided where this beacon lives.
      this.tapMarker.setPosition(this.tapMarkerAt.x, this.tapMarkerAt.y);
    } else if (this.trip && this.tapMarker) {
      const e = this.trip.target;
      const pr = this.projectFlat(e.x, e.y);
      // Lift the beacon onto the tapped surface — a deck target sits at its
      // deck level (projectFlat returns the lower BASE level).
      this.tapMarker.setPosition(pr.x, pr.y - Math.max(pr.lvl, this.trip.goalLevel ?? 0) * this.geom.lh);
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
    this.setMoveTarget(g.x, g.y, true, true, g.lvl, true, g.at);
    const cost = performance.now() - t0;
    this.holdRepathAt = nowMs + Math.min(400, Math.max(50, cost * 8));
  }

  private setMoveTarget(
    x: number,
    y: number,
    run: boolean,
    hold = false,
    goalLevel?: number,
    showMarker = true,
    // The camera-world point the tap came from. Needed to find the SECOND
    // surface drawn under that same pixel — a different cell, same pixel.
    pick?: { wx: number; wy: number },
  ) {
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
    // ONE TAP, TWO MEANINGS — BOTH UNDER THE FINGER. A raised pixel — a roof
    // slab OR a cliff top — also shows the ground drawn at that same pixel,
    // which is a different CELL (6.4 of them up-screen for level 6). Offer both and let the ROUTING decide:
    // startBestTrip drops a candidate whose route cannot finish on it (the house
    // roof, six levels up with no ramp) and otherwise takes the shorter walk (a
    // bridge you can get both under and over). The tapped surface goes first so
    // it keeps ties.
    //
    // THE BEACON DOES NOT MOVE between the two: they are the same pixel. That
    // is the whole reason to resolve it this way rather than by dropping the
    // marker onto whatever the walk managed to reach.
    const cands: Array<{ x: number; y: number; goalLevel?: number }> = [{ x, y, goalLevel }];
    // (1) the other surface drawn at the SAME PIXEL — a different cell, since
    //     screen y subtracts level*lh. Usually the room under a roof.
    const under = pick && goalLevel !== undefined ? this.pickGround(pick.wx, pick.wy, goalLevel) : null;
    if (under) cands.push({ x: under.x, y: under.y, goalLevel: under.lvl });
    // ...and when that reading is a WALL or empty sky, the answer is NOT "the
    // floor of the cell you clicked": that draws `level * lh` = 96px below the
    // marker, which is the walker standing with her head at it. Take the
    // nearest walkable spot to the MARKER instead, measured in screen space —
    // "as close as she can get" is a statement about the pixel, not the cell.
    else if (pick) {
      const near = this.nearestGroundTo(pick.wx, pick.wy);
      if (near) cands.push({ x: near.x, y: near.y, goalLevel: near.lvl });
    }
    // THE SAME CELL'S FLOOR IS NOT A CANDIDATE, and adding it was a mistake
    // worth naming: it draws `level * lh` BELOW the marker, so choosing it is
    // precisely the bug — "you don't walk to the marker, you walk the player
    // under it". The marker's pixel is the contract; a destination that is not
    // at that pixel is not what was clicked, however close it looks in plan.
    const trip = startBestTrip(this.terrain, me.fx, me.fy, run, this.time.now, fromElev, cands);
    if (!trip) return;
    // THE BEACON DOES NOT MOVE — and now it cannot, because every candidate is
    // the SAME PIXEL. It is drawn from the winner's cell AND the winner's level,
    // which is the only pair that lands back on the clicked pixel: the ground
    // reading is 3.2 cells up-screen in both axes AND 6 levels lower, and those
    // two shifts cancel exactly. Lifting the ground cell by the ROOF's level
    // instead puts the marker 96px above the click (measured); using the tapped
    // cell with the ground's level puts it 96px below. Both are wrong, and both
    // were shipped once.
    goalLevel = trip.goalLevel;
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
    // THE BEACON IS THE PIXEL YOU TOUCHED — it is never derived from where the
    // route ends. Deriving it from `trip.target` is what made it drift: a click
    // on a WALL TOP has only one surface (plain terrain at level 6, no deck
    // under it), the route cannot reach it, and findPath's best-effort rim is a
    // NEIGHBOURING cell — so the beacon slid to that rim and lifted by the
    // wall's six levels, landing at the walker's head (maintainer 2026-08-08:
    // "if I click on top of the wall the marker moves a bit up and the player
    // walks so that her head is on the marker... if I click on the roof the
    // player correctly goes to the marker with her feet"). A ROOF hid this,
    // because it has two surfaces and the reachable one lands exactly under the
    // finger anyway.
    const end = trip.target;
    this.ensureTapAssets();
    const p = pick
      ? { x: pick.wx, y: pick.wy, lvl: 0 }
      : this.projectFlat(end.x, end.y);
    // Sit the beacon ON the tapped surface: a deck target lifts to its deck
    // level (projectFlat returns the BASE level, which is lower).
    const my = pick ? pick.wy : p.y - Math.max(p.lvl, goalLevel ?? 0) * this.geom.lh;
    // Remembered so the per-frame follow below cannot drag it off that pixel
    // either — the route may be re-planned many times during one gesture.
    this.tapMarkerAt = pick ? { x: pick.wx, y: pick.wy } : null;
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
      this.tapMarkerAt = null;
      this.tweens.killTweensOf(m);
      this.tweens.add({ targets: m, alpha: 0, duration: 180, onComplete: () => m.destroy() });
    }
  }

  /** Every BODY near a point that the walker's input has to slip around —
   * monsters (server-driven, per-art radii) and NPCs (client-side decor with
   * no server body, same faked collision since 2026-08-06).
   *
   * ONE list, read by both the dodge AND the autopilot's standoff. They have to
   * agree about who is standing where: when they disagreed, the autopilot
   * steered at a waypoint the dodge would never allow, and the walker circled
   * the NPC. The near-filter box admits the biggest bodies' lookahead (~140wu),
   * not the old fixed 48 — a mammoth deflects from ~4× a poring's distance. */
  private nearBodies(fx: number, fy: number): Array<{ id: string; x: number; y: number; r: number }> {
    const near: Array<{ id: string; x: number; y: number; r: number }> = [];
    this.monsters.forEach((mv, id) => {
      if (Math.abs(mv.fx - fx) < 140 && Math.abs(mv.fy - fy) < 140)
        near.push({ id, x: mv.fx, y: mv.fy, r: mv.radius });
    });
    this.npcs.forEach((npc, id) => {
      if (Math.abs(npc.fx - fx) < 140 && Math.abs(npc.fy - fy) < 140)
        near.push({ id: `npc:${id}`, x: npc.fx, y: npc.fy, r: NPC_BODY_RADIUS });
    });
    return near;
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
    // A waypoint someone is STANDING ON is unreachable — the dodge will never
    // let the walker have that spot — so it counts as arrived at from as near
    // as her personal space allows. Without this the two halves fight and the
    // walker orbits her (maintainer 2026-08-08: "the player runs a full circle
    // around the NPC").
    const bodies = this.nearBodies(me.fx, me.fy);
    const d = stepAutopilot(
      this.terrain, this.trip, me.fx, me.fy, this.time.now, this.worldW, this.worldH, myElev,
      bodies.length ? (wx, wy) => bodyStandoff(wx, wy, bodies) : undefined,
    );
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

  private artBounds(sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image) {
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
    return Math.max(0, a.elev / this.geom.lh);
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
    const r = this.resolveDrawDepth(b, lvl);
    b.coverY = r.coverY;
    b.sprite.setDepth(r.depth);
    // The depth is final here, and `depth > sprite.depth` is what the cover
    // surfaces filter occluders on — so the slot registers LAST, and in this
    // one function rather than in either consumer (see registerCoverSlot).
    this.registerCoverSlot(b);
  }

  /** THE ONE DEPTH-AND-COVER RULE, for ANYTHING drawn standing in the world —
   *  players, monsters, NPCs and SCENERY. It answers two questions off the same
   *  occluder scan: what painter depth puts this thing in the right place
   *  among the terrain around it, and (if terrain covers it) the screen line
   *  where it stops being visible.
   *
   *  SCENERY IS A CALLER, NOT A COPY (maintainer 2026-09-03, after grass drew
   *  over a tree: "I told you to reuse the player/monster/npc rendering … this
   *  is a classic 'let's implement the player's renderer again' bug"). The
   *  piece-only version this replaced had no `above` LIFT, which is exactly
   *  what puts a body in front of the flat tile drawn at a higher painter
   *  depth than its own anchor — so every piece sat behind the ground in front
   *  of it. `self` is the caller's OWN occluder record, skipped: scenery is in
   *  `occluderMeta` (bodies are not), and without it a tree reads itself as a
   *  solid covering itself and crops its own lit copy away. */
  private resolveDrawDepth(
    v: { sprite: Phaser.GameObjects.Image; lx: number; lyFlat: number; ly: number; fx: number; fy: number },
    lvl: number,
    self?: unknown,
  ): { depth: number; coverY: number | undefined } {
    const b = v;
    let depth = b.lyFlat + 0.5; // painter y at the flat (unlifted) ground
    let coverOut: number | undefined;
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
        if (o === self) continue; // never occlude yourself — see the note above
        if (o.x1 < sx0 || o.x0 > sx1 || o.y1 < sy0 || o.y0 > sy1) continue;
        const od = o.drawDepth ?? o.depth; // what it DRAWS at — see drawDepth
        const higher = o.top > lvl;
        // (a) Wall genuinely between the camera and the feet point.
        const t0 = Math.max(o.col - colf, o.row - rowf);
        const t1 = Math.min(o.col + 1 - colf, o.row + 1 - rowf);
        /* TERRAIN ONLY. This is a CELL test — does the ray from the camera to
         * the feet cross this column — and it is right for a wall, whose art
         * fills its cell and which you can never stand inside. A SOLID
         * billboard is point-anchored and walkable-through: scenery sitting in
         * the very cell the player stands in made the ray "blocked" and clamped
         * him BEHIND it, so an anvil 0.4 cells behind him drew over him and he
         * wore the hidden-behind-terrain outline in open ground. A billboard's
         * question is the DIAGONAL one, which is what solidArtOver below asks. */
        const rayBlocked = higher && !o.solid && t1 > Math.max(t0, 0);
        // (b) A higher column whose LIFTED TOP FACE overlaps the feet band
        // (the sprite is a billboard — raised corners of side/front
        // neighbours pass in front of its lower pixels even when the feet
        // point itself is visible) and whose face is camera-closer.
        // The upper reach must clear a DIAGONALLY adjacent ledge: a step to
        // the E/S (same-row/col neighbour) sits one grid diagonal AND one
        // level up, so its top lands ~lh+dy above the feet — a tighter band
        // (the old −26) let that ledge's corner poke between the legs with
        // the foot drawn over it (playtester, standing at a step edge).
        /* IS THIS PIECE IN FRONT OF ME? A grid occluder answers on cell
         * diagonals with a 1.2 slack, because its anchor is a cell corner and
         * the body's is fractional. A POINT-anchored piece has a real published
         * centre, so it answers exactly — the maintainer's own rule: "a player
         * above an ellipse's centre is drawn behind that part of the piece,
         * below it in front." With the slack, a tree whose footprint centre sat
         * 0.2 cells BEHIND the player still claimed the front. */
        const fwd = o.point ? o.depth > b.lyFlat : o.col + o.row + 1.2 > colf + rowf;
        const faceOverFeet =
          higher &&
          o.y0 <= feetY + 6 &&
          o.y0 >= feetY - (this.geom.lh + this.geom.dy + 9) &&
          fwd;
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
          fwd &&
          b.lx >= o.x0 - 6 &&
          b.lx <= o.x1 + 6;
        if (rayBlocked || faceOverFeet || solidArtOver) {
          below = Math.min(below, od);
          coverY = Math.min(coverY, o.y0);
        } else if (
          !o.solid ||
          // POINT-ANCHORED (scenery): its own anchor line is the exact
          // comparison — the cell+1 rule is a whole cell of slack, and a body
          // standing under a tree's canopy but in front of its trunk sits
          // inside that slack, so it never lifted and the (lifted) tree drew
          // over its head. Grid-anchored terrain keeps the cell rule.
          (o.point ? b.lyFlat > o.depth : colf + rowf > o.col + o.row + 1)
        ) {
          // Overlapping, not covering → lift the sprite above it. For
          // STANDABLE terrain this must stay unconditional: the flat tile
          // in FRONT of the feet has a higher painter depth and would
          // otherwise draw over the drop shadow/feet (playtester report).
          // SOLID structures are gated on the feet being camera-forward
          // of their front corner — their bottom-anchored tall art
          // (128px spires) overlaps characters standing well BEHIND
          // them, and the blanket lift drew those on top of the pillar.
          above = Math.max(above, od);
        }
      }
      if (above > -Infinity) depth = Math.max(depth, above + 0.6);
      if (below < Infinity) depth = Math.min(depth, below - 0.3); // walls win conflicts
      coverOut = below < Infinity ? coverY : undefined;
    }
    return { depth, coverY: coverOut };
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
      // Its fog silhouette, made RIGHT AFTER it so the two keep the creation
      // order the epsilon-free lit band sorts ties by (litA, fogA, litB, fogB).
      b.fog = this.add.image(b.sprite.x, b.sprite.y, b.sprite.texture.key).setDepth(900_001).setVisible(false);
    }
    if (!on || !b.sprite.visible) {
      b.lit.setVisible(false);
      b.fog?.setVisible(false);
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
    // ...read at the FEET through the pass's own distance field, like scenery
    // (depthFogAtFoot) — and worn as a FOG SILHOUETTE over the opaque copy
    // rather than by fading the copy: a faded copy composited to a·a fog
    // against the ground's a (see applyObjectLights).
    const sp0 = b.sprite;
    const fog = this.night!.depthFogAtFoot(sp0.x, sp0.y, Math.floor(lvl), b.fx / CELL_WU, b.fy / CELL_WU);
    const r = Math.min(255, Math.round(((baseTint >> 16) & 0xff) * Math.min(1, l[0])));
    const g = Math.min(255, Math.round(((baseTint >> 8) & 0xff) * Math.min(1, l[1])));
    const bl = Math.min(255, Math.round((baseTint & 0xff) * Math.min(1, l[2])));
    const sp = b.sprite;
    // THE SAME CUT AS THE OUTLINE, FROM THE SAME PIXELS. On the exact path the
    // lit copy literally IS the E surface and the outline is built from its
    // complement by a single erase — so "no seam and no double-draw" stops
    // being a discipline two call sites have to keep and becomes a property of
    // the framebuffer. (It also kills the dark band the flat line left across
    // visible legs, which only ever showed at Night.)
    const slot = this.coverSlotOf(b);
    const fw = sp.frame.cutWidth;
    const fh = sp.frame.cutHeight;
    b.lit
      .setVisible(true)
      .setTexture(slot ? this.coverE!.key : sp.texture.key, slot ? slot.name : sp.frame.name)
      .setPosition(sp.x, sp.y)
      .setOrigin(
        slot ? (sp.originX * fw + RING_PAD) / slot.w : sp.originX,
        slot ? (sp.originY * fh + RING_PAD) / slot.h : sp.originY,
      )
      .setFlipX(slot ? false : sp.flipX)
      .setScale(sp.scaleX, sp.scaleY)
      .setDepth(litDepth(sp.depth))
      .setAlpha(1)
      .setTint((r << 16) | (g << 8) | bl);
    if (slot) {
      if (b.lit.isCropped) b.lit.setCrop();
    } else if (b.coverY !== undefined) {
      // FALLBACK: frame-space y of the occluding wall's top line.
      const frameTop = sp.y - sp.displayHeight * sp.originY;
      const cropH = (b.coverY - frameTop) / sp.scaleY;
      const ab = this.artBounds(sp);
      if (cropH <= ab.y0 + 2) b.lit.setVisible(false); // wall covers the whole figure
      else b.lit.setCrop(0, 0, fw, cropH);
    } else if (b.lit.isCropped) b.lit.setCrop();
    // THE FOG SILHOUETTE: the lit copy's exact twin (texture, frame, origin,
    // flip, scale, crop) filled with the fog's colour at the fog's strength,
    // equal depth and made later, so it draws right over its own copy.
    const fa = this.night!.sceneryFog ? Math.min(1, Math.max(0, fog.a)) : 0;
    if (fa > 0.002 && b.lit.visible) {
      if (!b.fog) b.fog = this.add.image(b.lit.x, b.lit.y, b.lit.texture.key).setDepth(b.lit.depth);
      const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
      const fg = b.fog;
      fg.setVisible(true)
        .setTexture(b.lit.texture.key, b.lit.frame.name)
        .setPosition(b.lit.x, b.lit.y)
        .setOrigin(b.lit.originX, b.lit.originY)
        .setFlipX(b.lit.flipX)
        .setScale(b.lit.scaleX, b.lit.scaleY)
        .setDepth(b.lit.depth)
        .setAlpha(fa)
        .setTintFill((c(fog.r) << 16) | (c(fog.g) << 8) | c(fog.b));
      if (b.lit.isCropped) {
        const cc = (b.lit as unknown as { _crop: { width: number; height: number } })._crop;
        fg.setCrop(0, 0, cc?.width ?? b.lit.frame.cutWidth, cc?.height ?? b.lit.frame.cutHeight);
      } else if (fg.isCropped) fg.setCrop();
    } else b.fog?.setVisible(false);
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
    const queueState = (def: CharacterDef, state: string): string[] => {
      const keys: string[] = [];
      for (const [dir, count] of Object.entries(def.animations[state] ?? {})) {
        for (let n = 0; n < count; n++) {
          const fk = frameKey(def.uid, state, dir, n);
          if (this.textures.exists(fk)) continue;
          this.load.image(fk, withV(frameUrl(def, state, dir, n)));
          keys.push(fk);
          queued++;
        }
      }
      return keys;
    };
    const deferredStates = (def: CharacterDef) =>
      Object.keys(def.animations).filter((s) => !BOOT_ANIM_STATES.includes(s));

    // MY OWN URGENT STATES GO FIRST — ahead of the NPCs, who held this spot
    // until now (maintainer 2026-08-12: "the player is the most critical
    // graphics/animations to always have fully loaded"). hurt/die/kick/punch/
    // pickup are ALL deferred, so in manifest order the local player's could sit
    // behind ~315 NPC frames AND another character's 408 — many seconds on a
    // phone, and exactly the window where you spawn, get jumped by a predator
    // and have no die clip. The NPCs lose their head start for this and the calm
    // idle's frame-0 hold covers it: a frozen villager is cosmetic, a player
    // with no death animation is not.
    //
    // PLAYER_URGENT_STATES is what the game can actually trigger seconds after
    // a spawn. The weapon and spell states are deliberately NOT in it and are
    // queued dead LAST of mine — nothing in the game can play them yet (there
    // are no weapons; every swing resolves to kick or punch), and at 128 of my
    // 408 frames they were a third of my own set sitting in front of art that
    // was about to be drawn.
    const chars = this.charsMeFirst();
    const myDef = chars[0]?.uid === this.myCharacter?.uid ? chars[0] : null;
    const mineByState = new Map<string, string[]>();
    let myRest: string[] = [];
    if (myDef) {
      const all = deferredStates(myDef);
      const urgent = PLAYER_URGENT_STATES.filter((s) => all.includes(s));
      myRest = all.filter((s) => !urgent.includes(s));
      for (const s of urgent) mineByState.set(s, queueState(myDef, s));
    }
    // NPC idle frames next. They ride the deferred batch (never boot — a second
    // loader run mid-create restarted the loading bar), but queued LAST they
    // landed 18s in, behind every action-state frame and every monster combat
    // strip, so a town stood frozen the whole time.
    for (const f of this.npcIdleQueue) {
      if (this.textures.exists(f.key)) continue;
      this.load.image(f.key, withV(f.url));
      queued++;
    }
    this.npcIdleQueue = [];
    // FAR MONSTERS' walk/idle strips — the kinds the boot batch left out.
    // Behind my urgent clips and the NPC idles, ahead of my weapon/spell
    // states: a body that can wander into view outranks a clip nothing can
    // trigger yet. Each kind releases its parked bodies the moment ITS strips
    // land (per-kind FILE_COMPLETE count below), not at the batch's end.
    const farKeys = new Map<string, string[]>();
    for (const def of this.monsterManifest?.monsters ?? []) {
      if (!this.monsterDeferredKinds.has(def.id)) continue;
      const keys = this.queueMonsterBodyStrips(def);
      if (keys.length) farKeys.set(def.id, keys);
      else this.onMonsterArtLanded(def.id); // already resident — nothing to wait for
      queued += keys.length;
    }
    if (myDef) for (const s of myRest) mineByState.set(s, queueState(myDef, s));
    for (const def of chars) {
      if (def.uid === myDef?.uid) continue; // already queued, first
      for (const s of deferredStates(def)) queueState(def, s);
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
    // The BLOOD SPATTER variants (scenery/blood_spatter, trimmed) ride the
    // same batch — tiny (8 strips, 34px frames), ready before the first hit.
    for (const dir of BLOOD_DIRS) {
      const bk = `blood:${dir}`;
      if (this.textures.exists(bk)) continue;
      this.load.spritesheet(bk, withV(`/assets/scenery/blood_spatter/animations/spatter__${dir}.webp`), {
        frameWidth: 34,
        frameHeight: 34,
      });
      queued++;
    }
    // (Neither target marker needs an asset since rounds 9-11 — both borders
    // are drawn from the marked body's own silhouette.)
    if (!queued) return;
    // AND MY CLIPS REGISTER THE MOMENT MY ART IS IN — queueing first buys
    // nothing on its own, because buildAnimations ran ONLY on the loader's
    // COMPLETE, i.e. after the other character, every NPC idle, all 525 monster
    // combat strips and the blood spatters. My frames could be sitting in the
    // texture manager for ten seconds with no clip pointing at them. Counting
    // MY OWN queued keys is what makes the early run safe: a clip is built from
    // whatever frames exist and is never repaired, so it may only fire once
    // every one of them has landed — which is exactly when `left` hits 0.
    // ...AND EACH OF MY STATES REGISTERS THE MOMENT ITS OWN FRAMES ARE IN.
    // Queueing first buys nothing on its own, because buildAnimations ran ONLY
    // on the loader's COMPLETE — after the other character, every NPC idle, all
    // 525 monster combat strips and the blood spatters. Measured: my frames sat
    // in the texture manager with no clip pointing at them for the whole batch.
    // PER STATE and not per character, because those are 40-88 frames rather
    // than 408: `hurt` is playable in a fraction of the time `sword` takes, and
    // it is the one you need. Counting the keys is also what makes an early run
    // SAFE — a clip is built from whatever frames exist and is never repaired,
    // so a state may only be built once every one of its frames has landed.
    const owner = new Map<string, string>(); // frame key -> which state wants it
    const left = new Map<string, number>(); // state -> frames outstanding
    for (const [s, keys] of mineByState) {
      if (!keys.length) continue;
      left.set(s, keys.length);
      for (const k of keys) owner.set(k, s);
    }
    this.myAnimDebug = { queued: owner.size, left: owner.size, at: null };
    if (owner.size) {
      const dbg = this.myAnimDebug;
      const onFile = (key: string) => {
        const s = owner.get(key);
        if (s === undefined) return;
        owner.delete(key);
        dbg.left--;
        const n = (left.get(s) ?? 1) - 1;
        if (n > 0) return void left.set(s, n);
        left.delete(s);
        this.buildAnimations(myDef?.uid, s);
        if (dbg.at === null) dbg.at = Math.round(this.time.now);
        if (!left.size) this.load.off(Phaser.Loader.Events.FILE_COMPLETE, onFile);
      };
      this.load.on(Phaser.Loader.Events.FILE_COMPLETE, onFile);
      // A file that ERRORS never fires FILE_COMPLETE, so a state could stall at
      // 1 forever — the batch's own COMPLETE drops the listener either way.
      this.load.once(Phaser.Loader.Events.COMPLETE, () =>
        this.load.off(Phaser.Loader.Events.FILE_COMPLETE, onFile),
      );
    }
    if (farKeys.size) {
      const kindOf = new Map<string, string>(); // sheet key -> kind
      const leftOf = new Map<string, number>(); // kind -> strips outstanding
      for (const [kind, keys] of farKeys) {
        leftOf.set(kind, keys.length);
        for (const k of keys) kindOf.set(k, kind);
      }
      const onStrip = (key: string) => {
        const kind = kindOf.get(key);
        if (kind === undefined) return;
        kindOf.delete(key);
        const n = (leftOf.get(kind) ?? 1) - 1;
        if (n > 0) return void leftOf.set(kind, n);
        leftOf.delete(kind);
        this.onMonsterArtLanded(kind);
        if (!leftOf.size) this.load.off(Phaser.Loader.Events.FILE_COMPLETE, onStrip);
      };
      this.load.on(Phaser.Loader.Events.FILE_COMPLETE, onStrip);
      this.load.once(Phaser.Loader.Events.COMPLETE, () => {
        this.load.off(Phaser.Loader.Events.FILE_COMPLETE, onStrip);
        // An ERRORED strip never fires FILE_COMPLETE: release what is left so a
        // kind with a missing file degrades to today's placeholder, not to a
        // body parked forever.
        for (const kind of [...leftOf.keys()]) this.onMonsterArtLanded(kind);
      });
    }
    // PACED. This batch is ~1,000 files (every character's deferred states,
    // every NPC rotation and idle frame, 525 monster combat strips) streaming
    // behind a LIVE world, and each landed file is a decode + a GPU upload on
    // the main thread the moment it arrives. With the loader's default
    // parallelism (32; 6 on Android) a warm cache lands them in bursts —
    // measured 565 textures added in ONE step of the north run, 30-60 per step
    // for the rest of it — which is the "something is loading" hitch while
    // running. Two in flight bounds the arrivals to ~2 per frame (~1,000 files
    // in ~8 s at 60 fps), and nothing here is needed in the first second: my
    // urgent clips are queued first and a state registers the moment its own
    // frames are in (above). Restored on COMPLETE for whatever loads next.
    const prevParallel = this.load.maxParallelDownloads;
    const paced = deferredParallel();
    if (paced > 0) this.load.maxParallelDownloads = paced;
    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      this.load.maxParallelDownloads = prevParallel;
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

  /** The character list with MY OWN first. The Phaser loader is a FIFO queue,
   * so manifest order alone decides whose art exists first — and the local
   * player's is the one nobody can tolerate missing (maintainer 2026-08-12:
   * "the player is the most critical graphics/animations to always have fully
   * loaded"). `sort` is stable, so everyone else keeps manifest order. */
  private charsMeFirst(): CharacterDef[] {
    const uid = this.myCharacter?.uid;
    if (!uid) return this.manifest.characters;
    return [...this.manifest.characters].sort((a, b) => (a.uid === uid ? 0 : 1) - (b.uid === uid ? 0 : 1));
  }

  /** `onlyUid` scopes the run to one character. IT IS NOT AN OPTIMISATION —
   * a clip is built from whatever frames EXIST and, once created, is never
   * repaired (`anims.exists` skips it), so registering mid-load would freeze a
   * 9-frame die clip at the 2 frames that happened to have landed. Only pass a
   * uid whose every frame is known to be in. */
  private buildAnimations(onlyUid?: string, onlyState?: string) {
    // Anti-moonwalk playback rates measured from the art (build-manifest
    // gaitFps): the fps at which the gait's feet track the ground at the
    // gait's BASE speed. ONE rate per gait — legs keep the same cadence in
    // every direction (the old per-direction table was measurement noise and
    // made cadence pop on turns). Movement speed itself is untouched; actual
    // speed variation scales anims.timeScale per frame (applyAnimState).
    for (const def of this.manifest.characters) {
      if (onlyUid && def.uid !== onlyUid) continue;
      for (const [state, dirs] of Object.entries(def.animations)) {
        if (onlyState && state !== onlyState) continue;
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
  /** WALK + IDLE strips for one kind (maintainer 2026-07-30: stopped monsters
   *  must PLAY their idle, not freeze on a walk frame); attack/angry/die are
   *  always deferred. Returns the sheet keys it queued, so a caller can count
   *  them landing. Sliced with the STRIP'S OWN measured frame size — art
   *  repairs resize strips in place, so the monster-level size can be stale
   *  (frame bleed). */
  private queueMonsterBodyStrips(def: MonsterDef): string[] {
    const keys: string[] = [];
    const states = [monsterWalkKey(def)];
    if (def.idleAnim && !states.includes(def.idleAnim)) states.push(def.idleAnim);
    for (const anim of states) {
      const dirStrips = def.strips?.[anim] ?? {};
      for (const [dir, url] of Object.entries(dirStrips)) {
        if (!url) continue; // guard a missing strip
        const sk = monsterSheetKey(def.id, anim, dir);
        if (this.textures.exists(sk)) continue;
        const dims = def.stripDims?.[anim]?.[dir];
        this.load.spritesheet(sk, withV(url), {
          frameWidth: dims?.w ?? def.frameW,
          frameHeight: dims?.h ?? def.frameH,
        });
        keys.push(sk);
      }
    }
    return keys;
  }

  /** A deferred kind's strips are in: register its clips and release every
   *  parked body of that kind. The per-frame path then un-culls it and swaps
   *  the placeholder for the real strip (playMonsterAnim re-textures whenever
   *  the sheet exists), so nothing here touches a sprite directly. */
  private onMonsterArtLanded(kind: string) {
    this.monsterDeferredKinds.delete(kind);
    this.buildMonsterAnimations(kind);
    this.monsters.forEach((mv) => {
      if (mv.kind === kind) mv.artPending = false;
    });
  }

  private buildMonsterAnimations(only?: string) {
    for (const def of this.monsterManifest?.monsters ?? []) {
      if (only !== undefined && def.id !== only) continue;
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
                  : // WALK: the base rate is the art-measured gait at ROAM speed
                    // (one cycle per gait.cycleWu), and playMonsterAnim scales
                    // it by the body's live speed every frame. The old rate was
                    // a flat 6/10 from the frame count — unrelated to how far
                    // the art strides or how fast the monster is going.
                    Math.max(
                      GAIT_FPS_MIN,
                      Math.min(GAIT_FPS_MAX, (frames * GAIT_REF_WU) / (def.gait?.cycleWu || 36)),
                    );
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
    this.terrainMaxLevel = cs.maxLevel;
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
    const W = this.world?.width ?? 1;
    const H = this.world?.height ?? 1;
    const c = Math.max(0, Math.min(W - 1, cornerCol));
    const r = Math.max(0, Math.min(H - 1, cornerRow));
    const lvl = this.world?.rows[Math.floor(r)]?.[Math.floor(c)]?.l ?? 0;
    return this.projectCellCorner(cornerCol, cornerRow, lvl);
  }

  /** THE ONE PROJECTION FOR A POINT OF THE GROUND ITSELF — corners, cell
   *  diamonds, footprints, anything that describes the WORLD rather than a
   *  body standing in it. NEVER projectFlat for these.
   *
   *  `projectFlat` answers a different question: where a BODY's feet are
   *  DRAWN, which is the cell diamond's centre plus the character ground
   *  anchor (+tile/2, +dy). Feeding it ground coordinates puts every outline
   *  built from them down-screen of the art it describes, and that mistake has
   *  now been made twice — the spawn overlay's half-cell drop (maps agent +
   *  monster_demo screenshot, 2026-07-30) and the collision overlay's constant
   *  vertical offset (maps agent + the maintainer's annotated screenshot,
   *  2026-09-02: he marked the collision centre and the tile-top centre
   *  himself and they were apart, straight down, with zero horizontal error —
   *  the tell of an anchor term applied to one and not the other).
   *
   *  WHERE THE GROUND IS depends on which renderer drew it:
   *   - maps3: the tiles3 FRAME is the art plane BY CONSTRUCTION — the same
   *     anchorX/anchorY every plate, boundary, deck slab and scenery sprite is
   *     placed through. Measured against projectFlat with `__ml.planes`: 0 px
   *     in x, exactly DY − TOP_Y = 4 px in y, everywhere.
   *   - maps2: the lattice plus TILE_DIAMOND_TOP, the measured seat of the
   *     drawn diamond inside the 64 px art box.
   *
   *  `level` is the surface to lift to and belongs to the CALLER, because the
   *  two overlays differ on purpose: the collision floor plan flattens every
   *  mark to the player's own plane (a wall's marker must not fly up to the
   *  roof), while a spawn zone traces the rim it actually sits on. Coordinates
   *  are continuous CELLS, so a body's world point works too (px / CELL_WU). */
  private projectCellCorner(col: number, row: number, level: number): { x: number; y: number } {
    const f = this.t3?.frame;
    if (f) return { x: anchorX(f, col, row), y: anchorY(f, col, row, level) };
    const { dx, dy, lh, tile } = this.geom;
    return {
      x: this.iso.ox + (col - row) * dx + tile / 2,
      y: this.iso.oy + (col + row) * dy - level * lh + TILE_DIAMOND_TOP,
    };
  }

  /** Fetch the world's spawns.json once (debug overlay only). Missing file →
   * an empty list, so the overlay simply draws nothing and never retries. */
  private loadSpawnZones() {
    if (this.spawnZonesLoading) return;
    this.spawnZonesLoading = true;
    const name = this.worldName || DEFAULT_WORLD;
    fetch(gameUrl(worldFileUrl(name, "spawns.json")))
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

  // =========================================================================
  // INDOOR STATE MACHINE
  // =========================================================================

  /**
   * Re-derive the module's own room rule at an arbitrary DEPTH bar.
   *
   * Identical to `space.indoor` when `bar === INDOOR_DEPTH` (indoor.ts) — that
   * equality is the whole point: ENTER uses the shipped rule untouched, and
   * only LEAVE relaxes. `IndoorOptions` has no depth knob, so the re-derivation
   * has to live here.
   *
   * HYSTERESIS LAYER 1. The module's own note says `depth` is a property of the
   * QUERIED CELL, not of the space, so `indoor` can flip while you walk INSIDE
   * one cave and a player straddling the boundary flips it every step. Enter at
   * INDOOR_DEPTH (4), leave at 3. The relaxed bar is safe against bridges
   * because ENTERING still needs 4, which no shipped bridge cell reaches (the
   * measured maxima are 2 / 2 / 3) — so a bridge can never be entered, and the
   * relaxed bar can only ever apply inside a space you are already in. Only the
   * DEPTH branch needs it: `wallRatio` is a property of the whole space and
   * cannot flicker per step, which is why the house's doorway cell (depth 1,
   * ratio 0.9286) never dithers.
   */
  private indoorVerdict(space: IndoorSpace, bar: number): boolean {
    return (
      !space.capped &&
      space.roof.size >= MIN_ROOM_CELLS &&
      (space.wallRatio > INDOOR_WALL_RATIO || space.depth >= bar)
    );
  }

  /**
   * THE INDOOR STATE MACHINE — called ONCE per frame from update(), right after
   * the avatar loop writes `av.surfLevel` and BEFORE the torch loop and the
   * `ambEff` blend consume the result, so the lighting reacts in the SAME
   * frame. Costs one Math.floor and three comparisons while nothing changes.
   *
   * THE ELEVATION IS `av.surfLevel`, NOT `av.elev / lh`. findIndoorSpace
   * ENFORCES that `elev` is a RESOLVED SURFACE LEVEL (|grid.level[i] − elev| <=
   * 1e-6) and returns null otherwise, and `av.elev` is PIXELS eased by
   * integrateFall. Two cases where the rendered basis is not merely imprecise
   * but wrong: while SWIMMING the drawn body is deliberately sunk `swimDrop` px
   * below the pool surface, so elev/lh is a fraction strictly under
   * grid.level[i] and the precondition rejects it — the maintainer's
   * swim-into-a-water-cave case could never fire; and mid-FALL it is a
   * non-surface float, so the verdict would blink outdoors for the whole drop.
   * `surfLevel` is exactly what `resolveElevAt` returned (or the authoritative
   * `player.elev` for a remote), i.e. grid.level[i] or grid.deck[i].
   */
  private updateIndoor() {
    const now = this.time.now;
    const g = this.terrain;
    // PUBLISH THE DEPTH MAP EVEN IF YOU NEVER GO INSIDE. It used to ride along
    // with the room mask, which is only ever published on entering or leaving a
    // room — so a player who merely WALKS PAST a cave got an empty green
    // channel and no darkening at all, which is precisely the case the feature
    // exists for. Once per world; setRoom early-returns on every later call.
    if (!this.caveDepth && g && this.world) {
      this.caveDepth = this.buildCaveDepth();
      // A draw-time input (caveTint) the kept ground picture may predate: the
      // next redraw paints in full rather than scrolling an untinted picture.
      this.lastGround = { x: NaN, y: NaN };
      this.night?.setRoom(this.roomMask ? this.roomMask.keys() : null, this.caveDepth, this.caveUnder);
    }
    const av = this.avatars.get(this.room?.sessionId ?? "");
    if (!g || !av || av.surfLevel === undefined) {
      // No grid / no body yet: outdoors, and forget the cache so the next real
      // frame recomputes instead of trusting a stale space.
      this.indoorAtCol = NaN;
      this.setIndoor(false, null, -1, now, true);
      this.easeIndoorMix();
      return;
    }
    const col = Math.floor(av.fx / CELL_WU);
    const row = Math.floor(av.fy / CELL_WU);
    const elev = av.surfLevel;
    // WHICH NAMED PLACE? Same cell the roof test already needs, so this costs
    // one Map lookup and only talks to the composer when the answer CHANGES —
    // a bed swap on every frame you stand in the cave would restart the music.
    const place = this.places?.at(col, row) ?? null;
    if (place !== this.placeNow) {
      this.placeNow = place;
      gameAudio.setPlace(place);
    }
    if (!this.indoorDirty && col === this.indoorAtCol && row === this.indoorAtRow && elev === this.indoorAtElev) {
      // Nothing that can change the answer has changed. Still service the dwell
      // timer — a verdict deferred on the doorstep must land even if you then
      // stand perfectly still.
      this.applyPendingIndoor(now);
      this.easeIndoorMix();
      return;
    }
    this.indoorAtCol = col;
    this.indoorAtRow = row;
    this.indoorAtElev = elev;
    this.indoorDirty = false;

    // FAST PATH: O(1), zero allocation. findIndoorSpace allocates a
    // Uint8Array(w*h) + an Int32Array(w*h) — ~307 KB on the_island2's 248×248 —
    // and a walking body crosses a cell several times a second, so it must
    // never run under open sky. `roofAbove` is the same test findIndoorSpace
    // opens with, so this can only skip calls that would have returned null.
    if (roofAbove(g, col, row, elev) === null) {
      this.setIndoor(false, null, -1, now, false);
      this.easeIndoorMix();
      return;
    }
    this.indoorComputes++;
    const space = findIndoorSpace(g, col, row, elev);
    if (!space) {
      // The precondition rejected us (an elev that is not one of this cell's
      // resolved surfaces). Fail OUTDOORS exactly as the module does: a wrong
      // room hides the map, a missing one does not.
      this.setIndoor(false, null, -1, now, false);
      this.easeIndoorMix();
      return;
    }
    // HYSTERESIS LAYER 2 — space identity. min(roof) is canonical for a
    // connected component whatever cell seeded the fill, so "am I still in the
    // same room?" is exact, and the relaxed LEAVE bar can apply inside the
    // space we entered without also relaxing the ENTER bar for the next one.
    let key = Infinity;
    for (const i of space.roof) if (i < key) key = i;
    const sameSpace = this.indoorInside && key === this.indoorKey;
    this.setIndoor(this.indoorVerdict(space, sameSpace ? INDOOR_DEPTH - 1 : INDOOR_DEPTH), space, key, now, false);
    this.easeIndoorMix();
  }

  /** Record a verdict, gated by the dwell timer (HYSTERESIS LAYER 3). */
  private setIndoor(inside: boolean, space: IndoorSpace | null, key: number, now: number, force: boolean) {
    this.indoorPending = inside;
    const flip = inside !== this.indoorInside;
    const held = flip && !force && now - this.indoorFlipAt < INDOOR_DWELL_MS;
    // A held LEAVE must KEEP the room it is still drawing. The mask, the torch
    // gate and the outside-body cull all read `indoorSpace`, so dropping it to
    // null the moment the raw verdict says "outside" would put the torches out
    // and bring the whole village back for a quarter of a second while the
    // ground RT still showed the interior. A held ENTER has the opposite need —
    // nothing is drawn from it yet, and the space must be remembered for when
    // the timer expires and applyPendingIndoor lands it.
    if (!held || inside) {
      this.indoorSpace = space;
      this.indoorKey = key;
    }
    if (held) return; // applyPendingIndoor lands it
    if (!flip) {
      // Same verdict, possibly a DIFFERENT room — a door between two spaces, or
      // a cave whose ceiling steps to another height. The mask has to follow,
      // and if it really changed the two caches are now stale even though
      // nothing "flipped": repaint them exactly as commitIndoor would.
      if (inside && this.refreshIndoorMask()) this.repaintWorld();
      return;
    }
    this.commitIndoor(inside, now);
  }

  /** Land a verdict the dwell timer deferred. */
  private applyPendingIndoor(now: number) {
    if (this.indoorPending !== this.indoorInside && now - this.indoorFlipAt >= INDOOR_DWELL_MS)
      this.commitIndoor(this.indoorPending, now);
  }

  /**
   * THE TRANSITION. Everything that CACHES world art has to be rebuilt here.
   *
   * NOT rebuilt, deliberately: the light/occlusion HEIGHTMAP (the roof is still
   * physically there and must keep blocking the sun — that is what keeps the
   * room dark, and it is the field the future doorway raytracing marches
   * through). Only what is DRAWN changes.
   */
  private commitIndoor(inside: boolean, now: number) {
    const wasDrawn = !!this.indoorMask;
    this.indoorInside = inside;
    this.indoorPending = inside;
    this.indoorFlipAt = now;
    this.indoorFlips++;
    if (inside) {
      this.refreshIndoorMask();
      this.repaintWorld();
      // THE ENTRY FADE (maintainer 2026-08-13: "the sudden roof pop is
      // dominating the transition"). The world above just repainted to the
      // cut state, but the debris layer — the exact art the cut removed — is
      // built OPAQUE on this same frame, so the flip frame shows the picture
      // you were already looking at. It then dissolves on the transition
      // grade (alpha = 1 − indoorGrade, applied in easeIndoorMix).
      this.buildIndoorDebris();
      return;
    }
    // THE EXIT FADE, the same crossfade run backward: keep drawing the CUT
    // world (mask, cuts and the shader clamp all stay), let the removed art
    // fade back IN at 3×, and do the real repaint only when the light GRADE
    // lands (mix ⅓, ~0.39s) — by then the debris has been opaque for most of
    // the roll, so the swap cannot be seen (easeIndoorMix's landing branch).
    if (wasDrawn && this.indoorCut && this.world && this.terrain) {
      this.buildIndoorDebris();
      return;
    }
    // Nothing was drawn (never really committed), the world is going away, or
    // the legacy kill-switch cut is active (no per-cell map to fade) — the
    // old instant transition.
    this.clearIndoorDrawState();
    this.repaintWorld();
  }

  /** Drop everything the cut-away DRAWS from — the mask, the per-cell cuts,
   * the signature and any transition debris. The caller repaints. */
  private clearIndoorDrawState() {
    this.indoorMask = null;
    this.indoorCut = null;
    this.indoorMaskSig = "";
    this.destroyIndoorDebris();
  }

  private destroyIndoorDebris() {
    if (!this.indoorDebris) return;
    for (const img of this.indoorDebris) img.destroy();
    this.indoorDebris = null;
  }

  /** THE LIGHT GRADE — the eased mix at INDOOR_GRADE_RATE, clamped to [0,1].
   * Every LIGHT half of a doorway crossing rides this single value: the
   * shader's indoor blend (outside-to-black, room un-dim, fog gate) and every
   * CPU light gain (torch enable, outside lights dying, sealed fires,
   * ambEff/sunIn/fogScale). One value means those parts cannot trail each
   * other — but it is deliberately NOT the debris' 3× (maintainer 2026-08-13:
   * "I wanted the darkening a bit faster... the roof fade is intended to be
   * faster to hide bugs", after a first cut that ran everything at 3× read as
   * one big snap). At 1.5× the darkening lands at mix ⅔ entering / mix ⅓
   * leaving — ~0.39s, half the raw roll's perceived length, ~3× the roof
   * crossfade's — and the leaving landing is when easeIndoorMix runs the
   * repaint swap (past it the roll's exponential tail drives nothing
   * visible). The raw indoorMix stays the easing SUBSTRATE (and the QA pin's
   * target); consumers take the grade. */
  private indoorGrade(): number {
    const R = INDOOR_GRADE_RATE;
    return this.indoorInside
      ? Math.min(1, R * this.indoorMix)
      : Math.max(0, R * this.indoorMix - (R - 1));
  }

  /** The debris layer's opacity — its own 3× curves, the speed the maintainer
   * tuned by eye (2026-08-13: 2× was not enough, then "3×, both directions"):
   * entering, opaque at the flip and dissolved by mix ⅓; leaving, complete by
   * the roll's first third and then held at 1 through the swap. Runs HOTTER
   * than the light grade on purpose — the crossfade's whole job is hiding
   * repaint seams, and seams hide better the less time they get. */
  private debrisAlpha(): number {
    const D = INDOOR_DEBRIS_RATE;
    return this.indoorInside
      ? Math.max(0, 1 - D * this.indoorMix)
      : Math.min(1, D * (1 - this.indoorMix));
  }

  /** Build the TRANSITION DEBRIS: every piece of art the current cut removes,
   * as ordinary world-anchored images at the same depths the occluder pass
   * would give them — wall bands above each constrained column's cut, the
   * column's real top diamond, and the deck slab (my roof, a covering lid).
   * Iterates the constrained set itself (a few hundred cells), not the world.
   * Alpha starts at the current 1 − indoorMix so a rebuild mid-fade continues
   * the dissolve instead of restarting it. Per-image depths mean bodies keep
   * sorting correctly through the fade — someone under the returning roof is
   * covered by it exactly as they will be once it is real. */
  private buildIndoorDebris() {
    this.destroyIndoorDebris();
    const cuts = this.indoorCut;
    const world = this.world;
    if (!cuts || !world || !this.maps2) return; // legacy cut / no world: instant
    const { dx, dy, lh, tile: tileSize } = this.geom;
    const cam = this.cameras.main;
    const cx0 = cam.worldView.x - OCC_CULL_PAD;
    const cx1 = cam.worldView.right + OCC_CULL_PAD;
    const cy0 = cam.worldView.y - OCC_CULL_PAD;
    const cy1 = cam.worldView.bottom + OCC_CULL_PAD;
    const shows = (ix: number, iy: number) =>
      ix + tileSize >= cx0 && ix <= cx1 && iy + tileSize >= cy0 && iy <= cy1;
    const a = this.debrisAlpha();
    const out: Phaser.GameObjects.Image[] = [];
    const push = (img: Phaser.GameObjects.Image) => out.push(img.setAlpha(a));
    for (const [idx, cutE] of cuts) {
      const col: number = idx % world.width;
      const row: number = (idx - col) / world.width;
      const cell = world.rows[row]?.[col];
      if (!cell) continue;
      const u = col - row;
      const v = col + row;
      const bx = this.iso.ox + u * dx;
      const by = this.iso.oy + v * dy;
      const depth = by + dy;
      const hi = Math.min(cell.l, cutE);
      if (hi < cell.l) {
        const topKey0 = topKeyFor(cell);
        if (topKey0 && this.textures.exists(topKey0)) {
          const faceKey = faceKeyFor(world, cell);
          const fk = faceKey && this.textures.exists(faceKey) ? faceKey : topKey0;
          // The removed band: faces above the drawn cap (the cap itself is
          // identical art in both states), then the real top diamond.
          for (let lvl = hi + 1; lvl < cell.l; lvl++)
            if (shows(bx, by - lvl * lh))
              push(this.add.image(bx, by - lvl * lh, fk).setOrigin(0, 0).setDepth(depth));
          if (shows(bx, by - cell.l * lh))
            push(
              this.add
                .image(bx, by - cell.l * lh, topKey0)
                .setOrigin(0, 0)
                .setFlipX(!!cell.flip)
                .setDepth(depth),
            );
        }
      }
      // The deck a constrained cell no longer draws — my own roof, or a slab
      // that would lid my floor. Exposed faces + top, the outdoor rule —
      // INCLUDING the lap rule: where the deck coincides with its own
      // equal-height column (deck.level == cell.l — the roof lapping its
      // walls, or the pillars of a hypostyle hall), the real renderers draw
      // the COLUMN's baked top and skip the deck (rebuildOccluders /
      // redrawGround), so the debris must too. Without this the fade stamped
      // the dark deck tile over every pale wall-top and pillar-top, and the
      // swap popped the real mixed-tile roof back in (maintainer 2026-08-13,
      // the island hall: "the roof suddenly changes look... something to do
      // with the walls having a different tile than the roof").
      const dk = this.deckIndex.get(idx);
      if (dk && dk.cell.path && dk.deck.level > cell.l) {
        const dTop0 = pathTileKey(dk.cell.path);
        if (this.textures.exists(dTop0)) {
          const dFace = this.deckFaceKey(dk.deck, dTop0);
          const lvl0 = Math.max(0, dk.deck.level - dk.deck.thickness);
          const dFrom = this.deckCoverFrom(col, row, lvl0, dk.deck.level);
          for (let lvl = dFrom; lvl < dk.deck.level; lvl++)
            if (shows(bx, by - lvl * lh))
              push(this.add.image(bx, by - lvl * lh, dFace).setOrigin(0, 0).setDepth(depth));
          if (shows(bx, by - dk.deck.level * lh))
            push(
              this.add
                .image(bx, by - dk.deck.level * lh, dTop0)
                .setOrigin(0, 0)
                .setFlipX(!!dk.cell.flip)
                .setDepth(depth),
            );
        }
      }
    }
    this.indoorDebris = out.length ? out : null;
  }

  /** An EXPLICIT repaint — a state change (the indoor cut, a landed hitbox
   *  doc) whose caller may read the result on the same frame. Poisons BOTH
   *  latches together and runs both passes NOW rather than at the top of the
   *  next frame, which is what buys a frame with no stale roof between the
   *  verdict and the picture. Counted in the perf sections like the latched
   *  passes. A full explicit pass satisfies any pending request by
   *  construction, so the streaming flags are cleared first — without that,
   *  an art batch landing beside a state change cost a second, identical full
   *  pass on the following frame (review, 2026-09-02). */
  private repaintWorld() {
    this.groundSliceQ = [];
    this.groundSliceCtx = null;
    this.repaintGroundPending = false;
    this.repaintOccPending = false;
    this.repaintGroundPartial = false; // the full paint covers the landed cells
    this.groundDirtyCells = [];
    this.lastGround = { x: NaN, y: NaN };
    this.lastOccl = { x: NaN, y: NaN };
    this.ps();
    this.redrawGround();
    this.pe("redrawGround");
    this.ps();
    this.rebuildOccluders();
    this.pe("rebuildOccluders");
  }

  /* STREAMING REPAINTS ARE COALESCED — one per frame, and only the pass the
   * landed art actually needs.
   *
   * Three things fire while a window's art streams in: the terrain loader's
   * batch landing, the scenery loader's batch landing — BOTH once("complete")
   * handlers on the ONE Phaser loader, so one batch fired both — and the
   * scenery manifest settle. Each ran a FULL repaint synchronously: the whole
   * ground RT (41-52 ms of JS) plus every occluder. Measured over a 24 s walk
   * with art landing: 8 of 11 occluder rebuilds and 8 of 8 ground redraws were
   * this, not camera movement (investigation 2026-09-02). That is the stutter
   * of a freshly loading area.
   *
   * Now a landing MARKS what it dirtied and update() poisons the matching
   * latch at most once per frame: a terrain batch needs the ground (its
   * plates were holes) and the occluders (its wall faces were skipped); a
   * scenery batch or manifest needs only the occluder rebuild, because scenery
   * rides inside it — the terrain occluders come back out of the pool, while
   * the scenery images and every lit copy are rebuilt in full (they are not
   * pooled: see OCC_DEPTH_EPS). The explicit repaintWorld() callers (indoor
   * cut, hitbox docs) are unchanged: state changes whose callers may read the
   * result immediately.
   * `repaintCoalesce` is the A/B switch for `__ml.repaints`, nothing else
   * reads it. */
  private repaintGroundPending = false;
  private repaintOccPending = false;
  private repaintCoalesce = true;
  private repaintStats = { terrain: 0, scenery: 0, manifest: 0, groundRuns: 0, occRuns: 0 };
  private requestRepaint(kind: "terrain" | "scenery" | "manifest"): void {
    this.repaintStats[kind]++;
    if (!this.repaintCoalesce) {
      // LEGACY, byte-for-byte: terrain and scenery batches repainted everything
      // synchronously; a manifest settle rebuilt the occluders.
      if (kind === "manifest") {
        this.lastOccl = { x: NaN, y: NaN };
        this.ps();
        this.rebuildOccluders();
        this.pe("rebuildOccluders");
        this.repaintStats.occRuns++;
      } else {
        this.repaintWorld();
        this.repaintStats.groundRuns++;
        this.repaintStats.occRuns++;
      }
      return;
    }
    if (kind === "terrain") this.repaintGroundPending = true;
    this.repaintOccPending = true;
  }

  /** Is this world cell part of the room I am standing in?
   *
   * TRUE whenever I am not indoors at all — outdoors there is no "my room", so
   * every caller that asks "may this thing light / shine / be lit?" gets the
   * unrestricted answer and needs no `indoorInside` check of its own.
   *
   * The mask is floor ∪ shell, so a torch mounted ON the wall of my room
   * counts as mine, which is what you want: the wall is part of the room.
   * Anything else — the bonfire on the grass, a lamp in the house next door,
   * a brazier upstairs — is outside, and both its light and any full-bright
   * copy of its art are dropped. (The maintainer 2026-08-07: "yes — point
   * light from outside has to be turned off".) */
  private inMyRoom(col: number, row: number): boolean {
    if (!this.roomMask || !this.world) return true;
    const c = Math.floor(col);
    const r = Math.floor(row);
    if (c < 0 || r < 0 || c >= this.world.width || r >= this.world.height) return false;
    return (this.roomMask.get(r * this.world.width + c) ?? 0) !== 0;
  }

  /** Rebuild the per-cell mask when the SPACE or its CUT changed; a no-op
   * otherwise, so walking around one room costs nothing. Returns whether it
   * really rebuilt — the caller must repaint when it did. */
  private refreshIndoorMask(): boolean {
    const g = this.terrain;
    const s = this.indoorSpace;
    if (!this.indoorInside || !s || !g) {
      const had = !!this.indoorMask;
      this.clearIndoorDrawState();
      // NOTE the LIGHT mask (`roomMask` / night.setRoom) is deliberately NOT
      // cleared here. Geometry snaps — the roof and every truncated column come
      // back this frame — but the light has a 0.35s roll to finish, and a room
      // that stopped existing mid-roll hands the whole world the interior's own
      // grade. easeIndoorMix drops it when the roll lands on 0.
      return had;
    }
    // The room's ceiling: the slab UNDERSIDE over my own cell. deckBot is what
    // the player's head actually meets; roofLevel is the slab's top (see the
    // indoorCeil field note for the measured 24-vs-8 case).
    const i = this.indoorAtRow * g.width + this.indoorAtCol;
    const ceil = g.deckBot[i] >= 0 ? g.deckBot[i] : s.roofLevel;
    // THE ROOM'S FLOOR — the LOWEST level under its roof, not the level of the
    // cell I happen to be standing on. A cave floor is not flat, and anchoring
    // the cut to my own feet would make every wall in the room jump 16px each
    // time I stepped onto a ledge. The minimum also keeps the whole floor plan
    // below the cut, so a raised shelf inside the room reads as a shelf you
    // look over rather than as a wall.
    let floor = Infinity;
    for (const ci of s.roof) if (g.level[ci] < floor) floor = g.level[ci];
    if (!Number.isFinite(floor)) floor = 0;
    // THE CUT-AWAY: walls stand `indoorWall()` levels ABOVE THAT FLOOR, clamped
    // by the ceiling — a wall taller than its own room would just seal the box
    // again. Measuring UP is the whole point (maintainer 2026-08-07): the dial
    // is a WALL HEIGHT, and "roof − N" only equals one when every room has the
    // same ceiling. the_island2's house has its ceiling at 6 and its caves at 8
    // over the same level-0 floor, so the roof−4 that gave him the 2-level wall
    // he liked gave FOUR in the cave — "the walls are higher than what I
    // wanted". From the floor, 2 is 2 everywhere.
    // All three numbers go in the signature: turning the Settings slider must
    // rebuild the mask exactly the way walking into a different room does.
    const top = Math.max(0, Math.min(ceil, floor + indoorWall()));
    // The raise flag is part of the signature: flipping the QA switch must
    // rebuild the mask exactly the way a dial turn does.
    const sig = `${this.indoorKey}:${ceil}:${floor}:${top}:${this.indoorRaiseOn ? "r" : "f"}`;
    if (sig === this.indoorMaskSig && this.indoorMask) return false;
    this.indoorMaskSig = sig;
    this.indoorCeil = ceil;
    this.indoorTop = top;
    const m = new Map<number, number>();
    for (const ci of s.roof) m.set(ci, IN_ROOF);
    // THE WHOLE BUILDING, with no attempt to work out which of its faces the
    // camera can see — `shell` is every solid cell of the enclosure, near and
    // far walls, corners and T-junctions alike. Classifying was what left holes
    // (see the constants block and `shell` in shared/src/indoor.ts); truncating
    // has nothing to classify.
    for (const ci of s.shell) m.set(ci, (m.get(ci) ?? 0) | IN_WALL);
    this.indoorMask = m;
    this.roomMask = m;
    this.indoorCut = this.indoorRaiseOn ? this.computeIndoorCuts(m, s, ceil, top) : null;
    // Publish the room to the LIGHT. This is what makes the outside black:
    // the renderer draws it like any other terrain, and the shader gives every
    // cell outside this set zero ambient — so a point light inside can still
    // reach it (the torch through the doorway) while the sky cannot. The cuts
    // go with it: the shader's surface resolve must truncate every column at
    // exactly the level the renderer draws it to — and resolve every column
    // WITHOUT an entry at its full, deck-inflated height, because that is
    // what the renderer paints now (see nightlight heightAt / setRoom).
    this.night?.setRoom(m.keys(), (this.caveDepth ??= this.buildCaveDepth()), this.caveUnder, this.indoorCut, top);
    return true;
  }

  /** THE CONSTRAINED SET — every column the indoor renderer must truncate,
   * with the level it may draw to. Two kinds of entry, one geometry:
   *
   *   • MY BUILDING (every mask cell): the per-wall raise — from the dial
   *     minimum up toward the room's ceiling, stopping one margin short of
   *     covering any of MY OWN floors/entrances. Floor cells store the dial
   *     (their columns are below it anyway); an entry is ALSO what says "draw
   *     no deck here", which is how my own roof comes off.
   *   • THE COVERING CONE (maintainer 2026-08-13, hard task #2): any OTHER
   *     column whose full-height art would bury one of my floors — the
   *     down-screen slice between the camera and my room. It cuts to the
   *     tallest height that leaves every floor visible, never below the dial.
   *
   * EVERYTHING ELSE DRAWS FULL, deck included: the neighbouring house keeps
   * its roof, the up-screen mountain keeps its mass — both at zero ambient,
   * so what actually changes on screen is that entering house_a no longer
   * pops house_b open ("you don't want to also see into house_b"). The
   * mountain-in-front worry is exactly the cone: anything that would block
   * the floor is still cut, no matter what it is. Other rooms' floors need
   * no protection any more — a room that is not mine draws its own roof, so
   * its floor is not visible either way; the dungeon's multi-chamber case
   * never needed it (chambers connected by doorways are ONE space, and this
   * space's floors are all mine).
   *
   * THE GEOMETRY, from the painter order this whole renderer sorts by: a
   * column at (u = col−row, v = col+row) drawn to level L covers the cell k
   * steps up-screen (v−k) once its art top rises past that cell's floor
   * diamond — L ≥ (dy/lh)·k + floorLevel, the same ~0.9375·k slope the
   * world-wide truncation note derives. Horizontally its 64px tile overlaps
   * the SAME iso column (u, even k) fully and the two half-step neighbours
   * (u±1, odd k) by half a tile — u±2 only touches at the edge and never
   * covers. So the cap a floor at (k up-screen, level L') imposes is
   * floor(0.9375·k + L' − MARGIN).
   *
   * MARGIN = 1 level (16px): at the cap, a column's top edge stays a level
   * below the burial line, leaving roughly half the floor diamond visible.
   * What falls out for free: a NEAR wall has its own room's floor one step
   * up-screen (k=1 caps below the dial), so near walls sit exactly at the
   * dial — the "minimum setting" — while far and side walls rise clean to
   * the ceiling.
   *
   * Cost: |myFloors| × kMax ≈ 500 × 45 pushes on mask rebuilds only. */
  private computeIndoorCuts(
    mask: Map<number, number>,
    s: IndoorSpace,
    ceil: number,
    top: number,
  ): Map<number, number> | null {
    const g = this.terrain;
    const w = this.world;
    if (!g || !w) return null;
    const { dy, lh } = this.geom;
    const cover = dy / lh; // levels of height per up-screen step (0.9375)
    const MARGIN = 1; // levels a column's top stays below the burial line
    // 126 = the room texture's encoding budget (R packs the cut beside the
    // membership bit, 127 = the "unconstrained" sentinel).
    const clampCut = (v: number) => Math.max(top, Math.min(v, 126));
    // The tallest art any column can draw (terrain or a deck slab) bounds how
    // far down-screen a floor's protection has to reach.
    let maxCol = this.maxLevel;
    for (const dk of this.deckIndex.values()) maxCol = Math.max(maxCol, dk.deck.level);
    const kMax = Math.ceil((maxCol + MARGIN + 1) / cover);
    // Sweep DOWN-screen from each of my floors/entrances: the tightest cap any
    // of them imposes, per cell.
    const floorCap = new Map<number, number>();
    const sweep = (fi: number) => {
      const fl = g.level[fi];
      const c = fi % w.width;
      const r = (fi - c) / w.width;
      const u = c - r;
      const v = c + r;
      for (let k = 1; k <= kMax; k++) {
        const cap = Math.floor(cover * k + fl - MARGIN);
        if (cap >= maxCol) break; // nothing anywhere is tall enough to care
        const vv = v + k;
        for (const uu of (k & 1) === 1 ? [u - 1, u + 1] : [u]) {
          const cc = (uu + vv) / 2;
          const rr = (vv - uu) / 2;
          if (cc < 0 || rr < 0 || cc >= w.width || rr >= w.height) continue;
          const idx = rr * w.width + cc;
          const prev = floorCap.get(idx);
          if (prev === undefined || cap < prev) floorCap.set(idx, cap);
        }
      }
    };
    for (const fi of s.roof) sweep(fi);
    for (const e of s.entrances) sweep(e);
    const cuts = new Map<number, number>();
    // My building: always an entry (the raise, ceiling-clamped).
    for (const ci of mask.keys()) {
      const cap = floorCap.get(ci);
      let cand = Math.min(g.level[ci], ceil);
      if (cap !== undefined && cap < cand) cand = cap;
      cuts.set(ci, clampCut(cand));
    }
    // The cone: an entry only where full height would really bury a floor.
    for (const [idx, cap] of floorCap) {
      if (mask.has(idx)) continue;
      const dk = this.deckIndex.get(idx);
      const colTop = Math.max(g.level[idx], dk ? dk.deck.level : -1);
      if (cap >= colTop) continue; // even drawn whole it cannot reach the floor
      cuts.set(idx, clampCut(cap));
    }
    return cuts;
  }

  /** Ease the LIGHT blend toward the current geometric state. Exponential roll
   * on the frame delta (the cloud/mist idiom), with the same `< 0.005 → snap`
   * clamp so it settles exactly instead of asymptotically. */
  private easeIndoorMix() {
    const to = this.indoorInside ? 1 : 0;
    const k = 1 - Math.exp(-(this.game.loop.delta / 1000) / INDOOR_TAU);
    this.indoorMix += (to - this.indoorMix) * k;
    if (Math.abs(this.indoorMix - to) < 0.005) this.indoorMix = to;
    // QA PIN (__ml.indoorMixPin): parks the blend anywhere in (0,1) so a
    // headless gate can photograph a mid-transition frame deterministically.
    // At 3× the debris crosses its whole alpha range inside one or two
    // STARVED harness frames (a single ~180ms delta carries the mix past ⅓),
    // so no wall-clock sampling can catch the blend there — while a real
    // 60fps device renders ~8 blended frames. NOTE a pin at mix ≤ ⅓ on the
    // way out IS the landed light grade — the swap below fires under it.
    if (this.indoorMixPinV !== null) this.indoorMix = this.indoorMixPinV;
    // THE TRANSITION DEBRIS rides its own 3× curves (maintainer 2026-08-13:
    // "the fade should go faster so no user notices any glitch" — first 2×,
    // then "twice as fast is not enough, 3×", both directions). Entering, the
    // debris is gone by mix ⅓; leaving, it is fully opaque by mix ⅔ — and
    // held there while the slower light grade finishes, until the landing
    // branch below swaps the real geometry in. Turning around mid-doorway
    // reverses the same curve (the mix is the state; the debris has none of
    // its own).
    if (this.indoorDebris) {
      const a = this.debrisAlpha();
      if (this.indoorInside && a <= 0.004) this.destroyIndoorDebris();
      else for (const img of this.indoorDebris) img.setAlpha(a);
    }
    // The room's LIGHT rules outlive the geometry by exactly one GRADE. The
    // grade landing on 0 means the outside has finished fading up from black
    // and the lights outside have finished fading in — everything keyed on
    // `roomMask` is done, so it is dropped HERE and not the moment the
    // verdict flipped. Landing on the grade rather than the raw mix matters
    // for more than symmetry: the swap needs the debris' build-time view cull
    // to still cover the camera, and while the OLD mix-0 landing sat ~1.9s of
    // exponential tail after the flip — a walking player drags the camera a
    // few hundred px by then, past the cull box, exposing cut-state cells
    // that then popped at the swap (maintainer 2026-08-13: "all black/dark
    // → grey areas at the top of the wall after the fade") — the 1.5× grade
    // lands ~0.39s in, ≤~60px of camera drift against OCC_CULL_PAD's ~360.
    // The swap frame itself changes nothing: cut world + opaque debris and
    // the full repaint are pixel-identical under a locked camera (measured,
    // exitsnap probe).
    if (this.indoorGrade() === 0 && !this.indoorInside) {
      if (this.roomMask) {
        this.roomMask = null;
        this.night?.setRoom(null, (this.caveDepth ??= this.buildCaveDepth()), this.caveUnder);
      }
      // THE EXIT LANDS. The debris is fully opaque, i.e. the picture already
      // equals the real outdoor geometry — swap the real thing in underneath
      // and drop the fade layer in the same frame. This is the repaint
      // commitIndoor deliberately did not do at the flip.
      if (this.indoorMask) {
        this.clearIndoorDrawState();
        this.repaintWorld();
      }
    }
  }

  /** Teleport / respawn: apply the next verdict instantly. A snap across the
   * map must not spend 250ms of dwell rendering the room you left, nor
   * cross-fade the grade over what is really a cut. */
  private indoorSnap() {
    this.indoorDirty = true;
    this.indoorFlipAt = -Infinity;
    this.indoorMix = this.indoorInside ? 1 : 0;
  }

  /** Indoors, is this body outside MY room?
   *
   * NOT a visibility test. Bodies are always DRAWN — a villager outside the
   * door is black at zero ambient and your torch reaching through the doorway
   * reveals them, which is the whole point of the change (maintainer
   * 2026-08-07). The earlier cut of this feature hid them, because the ground
   * under them was not drawn either and they would have hung in a black void at
   * sprite depth; that reason is gone.
   *
   * What this IS for is the chrome drawn ABOVE the darkness overlay — name
   * labels, chat bubbles, hp bars, target rings, the white cover outline. No
   * amount of zero ambient touches those, so a pitch-black villager out on the
   * grass would still wear a crisp readable name tag. Anything at depth
   * 900_001+ has to ask this question itself.
   *
   * `z` in LEVELS: a body up on the roof is outside even though the cell under
   * it is my floor. */
  /** Indoors, is this body standing ABOVE THE CUT — on terrain that is not
   * drawn at all?
   *
   * The zero-ambient design says draw the outside and let the light decide,
   * and that is right for everything at ground level: the ground under it IS
   * drawn, so a villager out there is a black silhouette your torch can find.
   * It stops being right above the cut, because up there NOTHING is drawn —
   * the cut removes every column's art above `indoorTop`, world-wide. A body
   * standing on that vanished terrain has no ground under it and hangs in the
   * void, which is exactly the artefact the old design was full of (maintainer
   * 2026-08-08: "monsters on top of the mountain are drawn when you are inside
   * the cave... you should not draw monsters outside that are on top of the
   * roof/ceiling when you are indoors").
   *
   * So the rule is not "outside my room" — it is "on ground I am not drawing".
   * The two differ exactly where it matters: the mountain around a cave is
   * outside the room AND above the cut (hidden), while the grass outside a
   * house door is outside the room but at my own level (drawn, and lit by a
   * torch through the doorway). The threshold is the CUT, not the ceiling: the
   * cut is what decides what is painted. */
  private aboveCut(z: number, fx?: number, fy?: number): boolean {
    // Gated on the DRAWN state, not the verdict: the exit fade keeps the cut
    // world painted while the light rolls back, and a body must not pop onto
    // terrain that is still not there.
    if (!this.indoorMask) return false;
    if (!this.indoorCut) return z > this.indoorTop; // legacy scalar (kill switch)
    if (z <= this.indoorTop) return false;
    // Per CELL: a body on an UNCONSTRAINED column (the neighbour's roof, the
    // up-screen mountain) stands on ground that is fully drawn now, black
    // under zero ambient like the street — it is DRAWN, and the torch can
    // find it. Only bodies on truncated columns hang over nothing. Callers
    // with no position keep the scalar answer (conservative: hide) — today
    // every body caller passes its fx/fy.
    if (fx === undefined || fy === undefined) return z > this.indoorTop;
    return z > this.cutAt(fx / CELL_WU, fy / CELL_WU);
  }

  /** IS THE ROOF OVER THIS CELL CUT AWAY RIGHT NOW? — the one question a piece
   *  of indoor scenery asks (`SceneryPlacement.roofed`). It stands under a roof
   *  or cave deck, so it may be drawn exactly when that deck is not.
   *
   *  The answer is the cut itself, never a room test: `cutAt` returns Infinity
   *  for a column drawn WHOLE — the street, the neighbour's house, my own
   *  building before I step inside — and a finite level for one the cut-away
   *  has truncated, which is precisely "the roof above it has been removed
   *  this frame". A piece above that level is still under drawn art and stays
   *  hidden (`level <= cut`), which is what keeps a cave's upper gallery from
   *  showing through the floor of the one above it.
   *
   *  Gated on `indoorMask` for the same reason aboveCut is: the exit fade keeps
   *  the cut world painted while the light rolls back, and the furniture must
   *  not vanish a beat before the roof slab returns over it. */
  private roofCutAwayAt(col: number, row: number, level: number): boolean {
    if (!this.indoorMask) return false; // no cut drawn: every roof is whole
    const cut = this.cutAt(col, row);
    return Number.isFinite(cut) && level <= cut;
  }

  /** The level the column at this cell draws to while the cut is active: its
   * entry in the constrained set, or Infinity for a column drawn whole (the
   * per-cell world), or the scalar dial (the legacy kill-switch world).
   * Coords in CELLS (fractions floored). */
  private cutAt(col: number, row: number): number {
    const w = this.world;
    if (!this.indoorCut || !w) return this.indoorTop;
    const c = Math.floor(col);
    const r = Math.floor(row);
    if (c < 0 || r < 0 || c >= w.width || r >= w.height) return this.indoorTop;
    return this.indoorCut.get(r * w.width + c) ?? Infinity;
  }

  private indoorOutside(fx: number, fy: number, z = 0): boolean {
    const w = this.world;
    if (!this.roomMask || !w) return false;
    const col = Math.floor(fx / CELL_WU);
    const row = Math.floor(fy / CELL_WU);
    if (col < 0 || row < 0 || col >= w.width || row >= w.height) return true;
    return !((this.roomMask.get(row * w.width + col) ?? 0) !== 0 && z < this.indoorCeil);
  }

  /** DEPTH FROM DAYLIGHT for every cell of every ROOM in the world: 0 at an
   * entrance, +1 per cell further in. This is what "you cannot see deep into
   * the cave" rides on (maintainer 2026-08-08: "darker and darker the further
   * into tiles being indoor you can see... a thickening shadow that gets very
   * dark, very fast").
   *
   * DEPTH, NOT DISTANCE FROM THE CAMERA. A long twisting cave goes black around
   * its first corner while a shallow alcove stays readable, and neither needs
   * tuning — the geometry says how deep it is. `findIndoorSpace` already hands
   * back the room's `entrances`, so this is a 4-connected BFS from them across
   * the room's own cells.
   *
   * Built ONCE per world: every roofed cell is visited at most twice (once to
   * discover its space, once in that space's fill), and the whole of
   * the_island2 is ~600 roofed cells. Bridges and arches are skipped — the
   * indoor verdict decides what is a room, exactly as it does everywhere else,
   * so a bridge does not acquire a shadow just for having a slab. */
  private buildCaveDepth(): Map<number, number> {
    const out = new Map<number, number>();
    this.caveUnder = new Map<number, number>();
    const g = this.terrain;
    const w = this.world;
    if (!g || !w) return out;
    const seen = new Uint8Array(w.width * w.height);
    for (let r = 0; r < w.height; r++)
      for (let c = 0; c < w.width; c++) {
        const i = r * w.width + c;
        if (seen[i] || g.deck[i] < 0) continue;
        const space = findIndoorSpace(g, c, r, g.level[i]);
        if (!space) { seen[i] = 1; continue; }
        for (const ci of space.roof) seen[ci] = 1;
        if (!this.indoorVerdict(space, INDOOR_DEPTH)) continue;
        // THE CEILING'S UNDERSIDE, which is where the OPENING stops. The slab's
        // own face runs from here up to its top, and that face is the mountain
        // — darkening it is what blackened the whole mountain three times. Below
        // it is the void you look through (maintainer 2026-08-08: "you should
        // just have stopped making it dark over the opening").
        // grid.deckBot IS the underside — already computed per cell when the
        // terrain was built. Rederiving it from the deck table produced nothing
        // (measured: 0 cells carried a value, so the shader compared against
        // zero and never fired), which is the whole reason the last attempt
        // darkened nothing at all.
        for (const ci of space.roof) {
          const ub = g.deckBot[ci];
          if (ub >= 0) this.caveUnder.set(ci, ub);
        }

        // BFS from the openings. A sealed room (no entrance at all) gets the
        // maximum everywhere — nothing can see into it, which is correct.
        const q: number[] = [];
        for (const e of space.entrances)
          for (const n of [e - 1, e + 1, e - w.width, e + w.width])
            if (space.roof.has(n) && !out.has(n)) { out.set(n, 0); q.push(n); }
        if (!q.length) { for (const ci of space.roof) out.set(ci, 255); continue; }
        for (let head = 0; head < q.length; head++) {
          const cur = q[head];
          const d = out.get(cur)!;
          for (const n of [cur - 1, cur + 1, cur - w.width, cur + w.width])
            if (space.roof.has(n) && !out.has(n)) { out.set(n, d + 1); q.push(n); }
        }
        // Anything the fill never reached is walled off from every opening.
        for (const ci of space.roof) if (!out.has(ci)) out.set(ci, 255);
        // THE INWARD-FACING WALLS — the ones you are actually looking AT when
        // you look into a mouth. The floor alone is a thin sliver through an
        // opening; what fills the frame is rock, and until now every attempt to
        // include rock took the WHOLE ring around the room. Half that ring is
        // the NEAR (down-screen) side, whose two drawn faces point away from
        // the room and out at the camera: that is the mountain's outside skirt,
        // and darkening it is "you fade what's not inside the cave opening
        // dark" (maintainer 2026-08-08) — the same complaint in a new coat.
        //
        // The projection settles which is which and the detector already sorts
        // them: a cell's drawn faces are its +col and +row sides (both go DOWN
        // the screen), so a fringe cell shows the room an inward face exactly
        // when the room lies on one of those two sides — space.wallLeft /
        // wallRight, the far walls, and no others. See IndoorSpace.wallLeft.
        //
        // No band, no rings: a wall face is 8 levels tall (128px) while a cell
        // step is 15px, so the second row of rock behind it is buried whole.
        //
        // AND ONLY WHERE IT IS ROCK, NOT A HOUSE WALL. A house's far wall is
        // one cell thick and its inward face is what the cut-away shows you
        // from inside — taking it blindly turned every house's sides black.
        // The two part on how far the column rises above the room's ceiling:
        // measured on the_island2, the cave's 146 far walls stand at terrain
        // 24-40 under an 8-level ceiling, while both houses' far walls stop at
        // 6 under a 6-level roof. Two levels of headroom is the bar, and it
        // keeps 146 cave cells and 0 house cells.
        for (const fi of [...space.wallLeft, ...space.wallRight]) {
          if (out.has(fi)) continue;
          // The ceiling and the depth both come from the room cell this wall
          // faces: the wall is as deep in as the floor in front of it, and it
          // is framed by the same opening.
          let ub = -1;
          let best = Infinity;
          for (const n of [fi - 1, fi + 1, fi - w.width, fi + w.width]) {
            if (!space.roof.has(n)) continue;
            if (g.deckBot[n] >= 0) ub = Math.max(ub, g.deckBot[n]);
            const d = out.get(n);
            if (d !== undefined && d < best) best = d;
          }
          if (ub < 0 || g.level[fi] <= ub + 2) continue; // a house wall, not rock
          if (best < Infinity) { out.set(fi, best + 1); this.caveUnder.set(fi, ub); }
        }
      }
    return out;
  }

  /** Is this point sealed inside a ROOM that is not the one I am standing in?
   *
   * The occlusion outline draws above the darkness overlay, so without this a
   * monster deep inside the mountain shows a crisp white silhouette through
   * solid rock — a wall-hack, and the exact inverse of what the feature is for.
   *
   * "Room" is the SAME verdict the indoor state machine uses (roof size, wall
   * ratio, depth), not merely "has a slab overhead": a bridge or an arch is not
   * a room, and a body under one must keep its outline. The verdict is a
   * property of the whole space, so ONE flood fill answers for every cell of
   * it — the cave's 472 cells are memoised in a single pass, and thereafter
   * this is a Map lookup per body per frame. Outdoor cells cost even less:
   * `roofAbove` returns null before any fill starts.
   *
   * Fails OPEN (outline shown) when the geometry can't be resolved — a body on
   * a surface whose level disagrees with the terrain, say. Showing an outline
   * that could have been hidden is a cosmetic miss; hiding one that should show
   * is the feature not working. */
  /** The STATIC half of inHiddenRoom: is this CELL part of a space the indoor
   * verdict calls a room? (Memoised per space; knows nothing about which room
   * is currently mine.) Split out 2026-08-12 so the light ledger can ask the
   * same question about an emissive source once per world. */
  private roomVerdictAt(col: number, row: number, z = 0): boolean {
    const g = this.terrain;
    const w = this.world;
    if (!g || !w) return false;
    if (col < 0 || row < 0 || col >= w.width || row >= w.height) return false;
    const idx = row * w.width + col;
    let room = this.roomCellMemo.get(idx);
    if (room === undefined) {
      const space = findIndoorSpace(g, col, row, z);
      this.indoorComputes++; // the QA counter counts EVERY fill, including these
      room = space && this.indoorVerdict(space, INDOOR_DEPTH) ? 1 : 0;
      // Memoise the WHOLE space, not just the queried cell: one fill then
      // answers for every body in the cave for the rest of the session.
      if (space) for (const c of space.roof) this.roomCellMemo.set(c, room);
      else this.roomCellMemo.set(idx, 0);
    }
    return !!room;
  }

  private inHiddenRoom(fx: number, fy: number, z = 0): boolean {
    const w = this.world;
    if (!w) return false;
    const col = Math.floor(fx / CELL_WU);
    const row = Math.floor(fy / CELL_WU);
    if (!this.roomVerdictAt(col, row, z)) return false;
    // It IS a room — mine or someone else's? THE TEST IS "IS THE CUT STILL
    // APPLIED", i.e. is the roof off, and NOT the fade mask.
    //
    // `roomMask` outlives the verdict on purpose: it drives the ambient fade,
    // which keeps easing for OUTDOOR_FADE_MS after you step out. Reading it
    // here meant that for a whole second after the roof snapped back, every
    // monster still in the cave kept its outline — drawn straight through the
    // mountain (maintainer 2026-08-08: "there is a delay until the white border
    // is removed... the very instant the roof is back the white border is
    // placed around all monsters in the cave"). `indoorInside && indoorMask` is
    // the same pair `pickGround` and `aboveCut` use, and it flips in the SAME
    // frame redrawGround puts the roof back, so the outline and the rock can
    // never disagree about which of them the camera is looking at.
    return !(this.indoorInside && this.indoorMask && this.inMyRoom(col, row));
  }

  /** Is this body under MY roof? O(1) — no extra flood fill. Used by the torch
   * gate so a torch is re-enabled in daylight for bodies sharing my space and
   * for nobody else (everyone outside is drawn black anyway). */
  private indoorContains(fx: number, fy: number): boolean {
    const g = this.terrain;
    const s = this.indoorSpace;
    if (!this.indoorInside || !s || !g) return false;
    const col = Math.floor(fx / CELL_WU);
    const row = Math.floor(fy / CELL_WU);
    if (col < 0 || row < 0 || col >= g.width || row >= g.height) return false;
    return s.roof.has(row * g.width + col);
  }

  /**
   * Register the two 32×64 screen-space HALVES of a tile texture as named
   * sub-frames, so `batchDrawFrame` / `add.image(x, y, key, frame)` can draw one
   * inward-facing wall face without the other. RenderTexture.batchDraw cannot
   * crop; a sub-frame is the crop primitive.
   *
   * THE TRAP, paid for once: `Texture.add` HIJACKS `firstFrame` —
   * `if (this.firstFrame === "__BASE") this.firstFrame = name;` — and every
   * plain `batchDraw(key, …)` / `add.image(x, y, key)` resolves its frame
   * through `texture.get(undefined)` → `frames[firstFrame]`. Measured live:
   * after one `add()`, a default-frame Image on that texture reported 32×64 and
   * the ground RT drew the LEFT HALF of every tile using it. Putting
   * `firstFrame` back is MANDATORY, not tidiness.
   *
   * Only ever called on FACE textures, which are never mirrored (redrawGround
   * flips the TOP tile for `cell.flip` and leaves `fk` alone), so the other
   * half-frame trap — `setFlipX` mirrors WITHIN the sub-frame's own 32px box,
   * landing the half mirrored AND on the wrong side — cannot be reached here.
   */
  /* ================= TILES 3.0 — the SECOND art source ====================
   *
   * A maps3 world's cells name a ground TYPE and nothing else, so there is no
   * baked path to look up: `tiles3.ts` resolves what draws, `tiles3draw.ts`
   * composes the two rasters the resolver only names, and `tiles3runtime.ts`
   * does both ONE CELL AT A TIME. Everything else in this scene — the
   * streaming RenderTexture, the depth sort, the occluders, the indoor cut,
   * collision, nav — is geometry and compositing and does not care where the
   * picture came from, which is why the wiring below is a second branch and not
   * a second renderer.
   *
   * THE COORDINATE BRIDGE, and it is the whole trick: tiles3 works in its own
   * `Frame`, and this scene works in `iso.ox/oy + MAP geometry`. They are the
   * same lattice with different origins, so ONE frame built here maps every
   * resolver output straight into world space:
   *
   *     columnX(f,x,y)     = f.ox + (x−y)·32 − 32   ≡ iso.ox + (x−y)·dx
   *     columnY(f,x,y,z)−10 = f.oy + (x+y)·14 − z·pitch − 10 ≡ iso.oy + (x+y)·dy − z·lh
   *
   * hence `f.ox = iso.ox + DX` and `f.oy = iso.oy + TOP_Y`, with dy = 14 and
   * lh = the MEASURED storey pitch. Get either offset wrong and nothing looks
   * broken — the whole map simply shears by a row per grid step. */

  /** The resolver's frame, expressed in this scene's world-space projection. */
  private tiles3Frame(): T3Frame {
    const w = this.world!;
    return {
      x0: 0,
      y0: 0,
      x1: w.width,
      y1: w.height,
      ox: this.iso.ox + T3_DX,
      oy: this.iso.oy + T3_TOP_Y,
      pitch: this.geom.lh,
      canvas: [this.iso.w, this.iso.h],
    };
  }

  /** Build the maps3 runtime out of the documents preload fetched. Runs once,
   *  after setupStreamingGround has set `iso`. A missing ground_types or
   *  patterns index leaves `t3` null and the world renders as empty ground —
   *  loudly, because a silent fall-through here is a black map. */
  private initTiles3() {
    const world = this.world;
    if (!world) return;
    const docs: Partial<Record<Tiles3DocKey, unknown>> = {};
    const absent: string[] = [];
    for (const k of Object.keys(TILES3_DOCS) as Tiles3DocKey[]) {
      const doc = this.cache.json.get(`t3doc:${k}`);
      if (doc === undefined) absent.push(TILES3_DOCS[k]);
      docs[k] = doc;
    }
    if (absent.length) console.warn(`[nangijala] tiles3: documents did not load: ${absent.join(", ")}`);
    // The pitch is the MEASURED one (shared ISO_GEOMETRY_MAPS3.lh = 15) and the
    // frame is already built with it — `checkTiles3Pitch` re-measures off the
    // real art once it lands and says so if the two ever disagree.
    const data = tiles3DataFrom(docs, this.geom.lh, (m) => console.warn(m));
    if (!data) {
      console.warn("[nangijala] tiles3: no ground_types/patterns — this world cannot resolve any art");
      return;
    }
    const tiles = new Tiles3(data);
    const view = viewFromParsed(world);
    // THE REGION FLOOD FILL RUNS HERE, ONCE, OVER THE WHOLE DOC — measured 38ms
    // on the_game's 512x512. Per camera window it would be faster and WRONG: a
    // region id is `<ground>@<lexicographic minimum cell>`, so a window-local
    // component gets a different id, a different set, and different art every
    // time the camera moves, and the ground visibly reshuffles as you walk.
    const t0 = performance.now();
    this.groundPainted = false;
    this.groundSliceQ = [];
    this.groundSliceCtx = null;
    this.worldUp = false;
    this.t3missing.clear();
    this.groundDirtyCells = [];
    this.repaintGroundPartial = false;
    this.t3ringQueue = [];
    this.t3keepIdx = null;
    this.t3cells.clear(); // a new resolver: nothing cached against the old one may survive
    this.t3 = new Tiles3World({ view, tiles, frame: this.tiles3Frame(), patterns: data.patterns });
    this.t3regionMs = +(performance.now() - t0).toFixed(1);
    this.t3load = new Tiles3Loader({
      loader: this.tiles3LoaderAdapter(),
      textures: this.t3tm,
      route: this.t3route,
      onBatch: (paths) => this.onTerrainBatch(paths),
    });
    // The index decides which sheets to fetch; preload queued the library's
    // published names, so this is a no-op unless a republish renamed one.
    // The pattern sheets are a dependency of EVERY composed op (ensureTiles3Textures
    // returns null without them, and the pass then draws nothing): a batch that
    // carries one is a full repaint, whatever cells recorded (onTerrainBatch).
    this.t3sheetPaths = new Set(sheetPaths(data.patterns));
    for (const path of this.t3sheetPaths) this.t3load.need(path);
    this.t3load.flush();
    this.initScenery(view);
    // A LoaderPlugin constructed after the scene has booted never sees BOOT, so
    // it never registers the SHUTDOWN hook the scene's own loader gets — it has
    // to be torn down by hand or an in-flight batch outlives the world it was
    // fetched for.
    this.events.once("shutdown", () => {
      this.t3loader?.destroy();
      this.t3loader = null;
    });
  }

  /** Phaser's TextureManager as `tiles3draw` declares it.
   *
   * THE TRAP, and it is silent: Phaser's `textures.get(key)` returns the
   * built-in `__MISSING` texture — a 32x32 checker — for a key it does not
   * have, NOT undefined. Handed straight to the composer, an unloaded 64x46
   * plate therefore arrives as 32x32 pixels: `composeBoundary` throws on the
   * geometry mismatch (which kills the frame) and `conformPlate` would happily
   * paste a checkerboard into the world. `exists` is the only honest test, so
   * the adapter makes `get` answer through it. */
  private t3TextureManager(): TextureManagerLike {
    return {
      exists: (k) => this.textures.exists(k),
      get: (k) => (this.textures.exists(k) ? this.textures.get(k) : undefined),
      addCanvas: (k, src) => this.textures.addCanvas(k, src as HTMLCanvasElement),
      remove: (k) => this.textures.remove(k),
    };
  }

  /** THE TERRAIN GETS ITS OWN LOADER, and it has to.
   *
   * `this.load` is a single FIFO queue, and the moment the avatar is in,
   * `loadDeferredAnims` pushes ~1,700 action-animation frames onto it. Streamed
   * terrain queued behind those waits minutes: measured on the_game, 95 plate
   * files sat at position 1,719 and the ground never filled in at all — the
   * world simply stayed empty while the counters said everything had been
   * requested. A second `LoaderPlugin` on the same scene has its own queue and
   * its own `complete`, writes into the SAME TextureManager, and downloads in
   * parallel with the character art instead of behind it.
   *
   * `crossOrigin = "anonymous"` IS LOAD-BEARING, and having a dedicated loader
   * is what makes it safe to set once. A composed boundary is built by reading
   * its two plates back out of their textures (`getImageData`), and a
   * cross-origin image loaded WITHOUT the attribute taints the canvas and makes
   * that read throw — so on a staging join (art from jsDelivr, which answers
   * `access-control-allow-origin: *`) every boundary in the world would
   * silently vanish. The character/monster/NPC art stays on `this.load` with
   * its old, forgiving behaviour, because a host that does NOT send CORS fails
   * the load outright once the attribute is set. */
  private tiles3Loader(): Phaser.Loader.LoaderPlugin {
    if (!this.t3loader) {
      this.t3loader = new Phaser.Loader.LoaderPlugin(this);
      this.t3loader.crossOrigin = "anonymous";
    }
    return this.t3loader;
  }

  private tiles3LoaderAdapter() {
    const l = this.tiles3Loader();
    return {
      image: (key: string, url: string) => l.image(key, url),
      isLoading: () => l.isLoading(),
      start: () => l.start(),
      once: (event: string, cb: () => void) => l.once(event, cb),
      /* EVERY FILE, SUCCESS OR ERROR — what turns the loading bar from a
       * staircase into a line. Phaser reports the two outcomes on different
       * events (an ERRORED file never fires FILE_COMPLETE), and a stage that
       * only counted successes would stall the bar on a 404 for the whole
       * batch. Registered once per loader; both the terrain loader and the
       * scenery art ride this one Phaser queue, so the key is what tells them
       * apart (`t2:` vs `s3:`). */
      onFile: (cb: (key: string) => void) => {
        l.on(Phaser.Loader.Events.FILE_COMPLETE, (key: string) => cb(key));
        l.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: { key?: string }) => cb(file?.key ?? ""));
      },
    };
  }

  /** Decoded RGBA behind a loaded texture. A texture whose source is already a
   *  canvas is read from its own context; an `<img>` is drawn into a scratch
   *  one first. Null while the art is not resident. */
  private texPixels(key: string): T3Pixels | null {
    if (!this.textures.exists(key)) return null;
    const src = this.textures.get(key)?.getSourceImage() as
      | (HTMLImageElement & HTMLCanvasElement)
      | undefined;
    if (!src) return null;
    const w = src.naturalWidth || src.width;
    const h = src.naturalHeight || src.height;
    if (!w || !h) return null;
    let ctx: CanvasRenderingContext2D | null =
      typeof src.getContext === "function" ? src.getContext("2d") : null;
    if (!ctx) {
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      ctx = cv.getContext("2d");
      ctx?.drawImage(src as CanvasImageSource, 0, 0);
    }
    try {
      const id = ctx?.getImageData(0, 0, w, h);
      return id ? { w, h, data: new Uint8ClampedArray(id.data) } : null;
    } catch (e) {
      // A TAINTED canvas — cross-origin art loaded without CORS. Say so once:
      // every composed boundary in the world depends on this read.
      console.warn(`[nangijala] tiles3: cannot read pixels of ${key} (${e})`);
      return null;
    }
  }

  /** The composed-texture factory, built the first time all three pattern
   *  sheets are resident. Null until then, and a null factory draws no
   *  boundaries and no conformed plates — the flats meet hard, which is the
   *  pre-3.0 look, never a hole. */
  private ensureTiles3Textures(): Tiles3Textures | null {
    if (this.t3tex) return this.t3tex;
    const t3 = this.t3;
    if (!t3) return null;
    const patterns = this.cache.json.get("t3doc:patterns") as PatternsDoc | undefined;
    const groundTypes = (this.cache.json.get("t3doc:groundTypes") as { grounds?: Record<string, unknown> } | undefined)?.grounds;
    if (!patterns || !groundTypes) return null;
    if (!this.t3sheets) {
      const p = patternSheetPaths(patterns);
      const sil = this.texPixels(t3ArtKey(p.silhouette));
      const masks = this.texPixels(t3ArtKey(p.masks));
      const border = this.texPixels(t3ArtKey(p.border));
      if (!sil || !masks || !border) return null;
      this.t3sheets = patternSheets(patterns, sil, masks, border);
    }
    this.t3tex = new Tiles3Textures({
      textures: this.t3tm,
      sheets: this.t3sheets,
      /* NO SEAM IN THE GAME — this is the maintainer's zigzag, the part of it
       * that was never a defect (2026-09-04).
       *
       * `compose()` darkens every texel of the border mask to `border.tone` of
       * what it already is: a deliberate one-texel line along every ground
       * transition, so a transition reads as a soft edge instead of a 0-100
       * hard cut. He approved exactly that in tiles/patterns/index.json
       * (2026-08-27) and the wiki preview he reviews from still draws it.
       *
       * It does not survive contact with the device. At camera zoom 2 one texel
       * is two screen px, and 18% darker reads as a dotted dark line tracing
       * the diamonds — which is what he has been photographing. MEASURED, two
       * ways that agree: off his screenshot at 441.3,374.0, 4,923 dot texels on
       * sand with a median dot/sand ratio of 0.825/0.819/0.820 (a FLAT multiply
       * — the wall band's signature is 0.731/0.695/0.671, cooler in blue, and
       * is what the previous commit removed); and rendering his window here
       * with the seam on vs off differs by 8,846 texels at a median ratio of
       * 0.821/0.819/0.817. `border.tone` is 0.82.
       *
       * It also explains his three-way localisation exactly, like the wall band
       * did: a boundary is dressed only at level 0 on non-liquid ground, and he
       * reports the artefact 100% absent on raised ground and on water.
       *
       * THE LIBRARY IS NOT TOUCHED and neither is the wiki: this turns the seam
       * off for the GAME only, which is what `seam` was added for. The key
       * carries it (`boundaryKey` appends `|noseam`), so a seamed and an
       * unseamed composition are different keys and no cache can serve one for
       * the other. One word to restore if he wants it back. */
      seam: false,
      groundTypes: groundTypes as Record<string, { palette?: { wall?: string; top?: string }; base_color?: string }>,
      // UNBOUNDED, deliberately. Eviction calls textures.remove, which pulls a
      // texture out from under anything still holding the key; the ground RT
      // drops its reference after the blit but the OCCLUDER pass keeps live
      // Sprites on composed keys. Measured ceiling on the_game: 2,248 distinct
      // compositions = 25 MB of canvas for the whole 512x512 world, and a
      // camera window holds ~400.
      limit: 0,
      // THE OCCLUDER POOL HOLDS TEXTURE OBJECTS ACROSS REBUILDS (occImage), so any
      // future eviction must also clear occPool/occNext or a pooled image renders
      // from a destroyed texture — legacy's per-rebuild recreate no longer re-resolves the key.
    });
    return this.t3tex;
  }

  /** THE MEASURED STOREY PITCH, re-derived from the art the game actually
   *  loaded and compared with the published one. render3 measures it off the
   *  x-over-x wall tile; a pitch one row too large exposes a bright stripe of
   *  each lower floor at every storey, so a disagreement has to be visible in
   *  the console rather than only on screen. Runs once, when the tile lands. */
  private checkTiles3Pitch() {
    if (this.t3pitchChecked || !this.t3) return;
    let path: string | undefined;
    try {
      path = this.t3.tiles.overTile("grey_stone", "grey_stone").path;
    } catch {
      this.t3pitchChecked = true;
      return;
    }
    if (!path) return;
    const px = this.texPixels(t3ArtKey(path));
    if (!px) return;
    this.t3pitchChecked = true;
    const pitch = measureStoreyPitch(px.w, px.h, (x, y) => px.data[(y * px.w + x) * 4 + 3] > 128);
    if (pitch && pitch !== this.geom.lh)
      console.warn(
        `[nangijala] tiles3: the wall art measures a ${pitch}px storey, the world projects at ${this.geom.lh}px ` +
          `— every stacked column is off by ${Math.abs(pitch - this.geom.lh)}px per storey (shared ISO_GEOMETRY_MAPS3.lh)`,
      );
  }

  /** One resolved blit onto the ground RenderTexture. `batchDraw` cannot crop,
   *  and exactly one op needs it — a FADE tile is the top `TOP_Y + 2·DY + 2`
   *  rows of a 64x64 file and its wall is explicitly meaningless, so drawing
   *  the whole file grows a stray wall band on flat ground. A cropped frame is
   *  registered on the texture once, under a name derived from the crop. */
  private t3Blit(
    rt: Phaser.GameObjects.RenderTexture,
    op: { key: string; x: number; y: number; sx: number; sy: number; sw: number; sh: number },
    ax: number,
    ay: number,
    tint: number,
  ) {
    /* A DRAW ENTIRELY OUTSIDE THE TEXTURE CONTRIBUTES NOTHING — skip it before
     * the texture lookup. The ground pass walks every cell of a window that is
     * padded by a tile on each side and by the world's whole level range
     * (maxLevel × lh) below, and issues every op of every cell whether or not
     * its rectangle reaches the render texture; measured on the_game, 31-55%
     * of a redraw's blits landed entirely outside it (forest 1,739 of 3,892;
     * autumn wood 6,623 of 12,067; snow cliffs 3,915 of 12,564 — the deck
     * face stacks rise 360-480 px above their cell and are most of them). The
     * RT clips them to nothing at the cost of a batchDraw each. This test is
     * the same rectangle-vs-box test the occluder pass already applies; it is
     * pixel-identical by construction and the parity probe (__ml.groundHash)
     * checks that on the real pixels. Scale is 1 here, so the drawn size IS
     * the crop size (op.sw × op.sh) — and the test assumes POSITIVE sw/sh
     * (every producer passes real file dimensions; a negative-width op would
     * rasterise a mirrored quad the four-way test misjudges, so such an op is
     * simply never culled). Anchoring is the frame's top-left at (dx, dy) and
     * the texture is exactly [0, rt.width) × [0, rt.height) in these units
     * (identity camera, rt.width is the texel size) — verified in review
     * against Phaser 3.90's MultiPipeline.batchTextureFrame. */
    /* EVERY GROUND OP LANDS ON A WHOLE TEXEL.
     *
     * The maintainer's read, and the one class of cause left standing after
     * the art, the mask, the pitch, the shaders, the crop and the streaming
     * were each measured innocent: "a rounding error that sometimes creates an
     * extra gap due to not working with clean integers". A tile diamond meets
     * its neighbours along a 2:1 staircase with ONE texel of overlap, so half a
     * texel of placement error opens a gap on some rows and not others — which
     * is exactly the shape he photographed: the same screen Y every time, the
     * upper edges only, on every ground, and dotted rather than solid because
     * the staircase steps two across for one down.
     *
     * On paper each term is whole (columnX/columnY step by DX=32 and DY=14 off
     * an integer frame origin, the anchor is Math.round). On his device
     * something in that chain is not, and rounding here is free where it is
     * already true. `nonInt` counts what needed it, so the beacon can say
     * whether this was the cause instead of leaving another guess in the tree. */
    if (!Number.isInteger(op.x - ax) || !Number.isInteger(op.y - ay)) this.groundNonInt++;
    const dx = Math.round(op.x - ax);
    const dy = Math.round(op.y - ay);
    if (
      this.groundCull &&
      op.sw > 0 &&
      op.sh > 0 &&
      (dx + op.sw <= 0 || dy + op.sh <= 0 || dx >= rt.width || dy >= rt.height)
    ) {
      this.groundCulled++;
      return;
    }
    const clip = this.groundClip;
    if (clip && op.sw > 0 && op.sh > 0) {
      /* A BAND PASS (the ground scroll, the cell repaint). THE CLIP DECIDES
       * WHETHER TO DRAW, NEVER WHAT TO DRAW: an op with no pixels inside the
       * band is skipped, and every other op is drawn WHOLE.
       *
       * It used to CROP an op that crossed the edge to an exact sub-rect. That
       * was the zigzag, and the maintainer is who found it — his red-shadow
       * switch killed the shadow theory in one tap (the shadow goes red, the
       * artefact stays black), and he then saw that it is POSITIONAL: ground
       * either side of a straight screen-space line differs, clean on one side
       * and dotted on the other, on sand as well as water. Those lines are the
       * BAND EDGES. Measured the same way: full-painted ground carries 0
       * fill-coloured texels where the same ground streamed carries 131.
       *
       * Drawing whole is safe by construction. The band's window is already
       * padded by a tile and the world's level range; the painter is
       * deterministic and world-anchored; and the kept picture outside the band
       * came from that same painter at that same anchor. So the pixels an
       * uncropped op lays outside the band are the pixels already there — it
       * repaints them and cannot change them. What was never safe was sub-rect
       * arithmetic in a path with one texel of margin, which is exactly what a
       * liquid has, and why water showed this worst and longest. */
      if (dx + op.sw <= clip.x0 || dy + op.sh <= clip.y0 || dx >= clip.x1 || dy >= clip.y1) {
        this.groundCulled++;
        return;
      }
    }
    const tex = this.textures.get(op.key);
    const src = tex?.getSourceImage() as { width?: number; height?: number } | undefined;
    const fw = src?.width ?? op.sw;
    const fh = src?.height ?? op.sh;
    if (op.sx === 0 && op.sy === 0 && op.sw === fw && op.sh === fh) {
      rt.batchDrawFrame(op.key, "__BASE", dx, dy, 1, tint); // explicit: never the texture's default frame
      return;
    }
    const name = `t3c:${op.sx},${op.sy},${op.sw},${op.sh}`;
    if (!tex.has(name)) {
      tex.add(name, 0, op.sx, op.sy, op.sw, op.sh);
      tex.firstFrame = "__BASE"; // see the clip path: added frames must not become the default
    }
    rt.batchDrawFrame(op.key, name, dx, dy, 1, tint);
  }

  /** ONE CELL'S RESOLUTION, REMEMBERED — PER MEMBER, LAZILY. `t3.cell` /
   *  `t3.boundary` / `t3.decks` are pure functions of static world data (the
   *  view, the frame, the fills, the deck map) — nothing in a session changes
   *  their answer — yet the ground pass and the occluder pass each re-ran them
   *  for every cell of the window on every rebuild: ~4,267 cells per ground
   *  redraw, ~82% of them resolved by the redraw before (a 256 px step exposes
   *  ~18% of the texture), and the same cells again for the occluders every
   *  96 px. Measured after the draw cull, the resolver was the larger share of
   *  a redraw. Each member memoises on its own, so a caller that never asked
   *  for a boundary (a void cell) or decks (a cut column) still never pays for
   *  one — and with the cache OFF these are exactly the old calls, which is
   *  what makes the A/B honest. The OPS built from a resolution (`cellBlits`,
   *  `opsFor*`) are NOT cached: they depend on which art is resident and on
   *  the indoor cut. Failures cache as the same null/[] `t3Try` answered
   *  (warned once). BOUNDED: pruned to the last ground window after every
   *  ground redraw (t3pruneCache — the occluder window lies inside it), so the
   *  Map holds ~4-5k entries, a few MB, never the world; cleared when a new
   *  resolver is built. The resolver's own stats counters now count once per
   *  session per cell, not per redraw. */
  private t3entry(col: number, row: number) {
    const i = row * (this.world?.width ?? 1) + col;
    let e = this.t3cells.get(i);
    if (!e) this.t3cells.set(i, (e = {}));
    return e;
  }
  private t3cellOf(t3: Tiles3World, col: number, row: number): Tiles3Cell | null {
    if (!this.groundCacheOn) return this.t3Try(`cell ${col},${row}`, () => t3.cell(col, row), null);
    const e = this.t3entry(col, row);
    if (e.cell === undefined) e.cell = this.t3Try(`cell ${col},${row}`, () => t3.cell(col, row), null);
    return e.cell;
  }
  private t3boundaryOf(t3: Tiles3World, col: number, row: number): Tiles3Boundary | null {
    if (!this.groundCacheOn) return this.t3Try(`boundary ${col},${row}`, () => t3.boundary(col, row), null);
    const e = this.t3entry(col, row);
    if (e.boundary === undefined) e.boundary = this.t3Try(`boundary ${col},${row}`, () => t3.boundary(col, row), null);
    return e.boundary;
  }
  private t3decksOf(t3: Tiles3World, col: number, row: number): Tiles3DeckCell[] {
    if (!this.groundCacheOn) return this.t3Try(`decks ${col},${row}`, () => t3.decks(col, row), [] as Tiles3DeckCell[]);
    const e = this.t3entry(col, row);
    if (e.decks === undefined) e.decks = this.t3Try(`decks ${col},${row}`, () => t3.decks(col, row), [] as Tiles3DeckCell[]);
    return e.decks;
  }
  /** Keep only the cells of the window just drawn (see t3cellOf). */
  private t3pruneCache(keep: readonly [number, number][] | Set<number>) {
    const W = this.world?.width ?? 1;
    let live: Set<number>;
    if (keep instanceof Set) live = keep;
    else {
      live = new Set<number>();
      for (const [c, r] of keep) live.add(r * W + c);
    }
    for (const k of this.t3cells.keys()) if (!live.has(k)) this.t3cells.delete(k);
  }

  /** The cell window whose art can reach a rectangle of the ground texture
   *  (RT-relative [x, x+w) × [y, y+h)): a tile on each side and the world's
   *  whole level range BELOW, because a column's art rises above its cell.
   *  The full-texture rule the pass always used, now also applied to a band. */
  private t3groundWindow(ax: number, ay: number, x: number, y: number, w: number, h: number) {
    const { dx, dy, lh, tile } = this.geom;
    const x0 = ax + x - tile;
    const x1 = ax + x + w + tile;
    const y0 = ay + y - tile;
    const y1 = ay + y + h + tile + this.maxLevel * lh;
    return {
      u0: Math.floor((x0 - this.iso.ox) / dx) - 1,
      u1: Math.ceil((x1 - this.iso.ox) / dx) + 1,
      v0: Math.max(0, Math.floor((y0 - this.iso.oy) / dy) - 1),
      v1: Math.ceil((y1 - this.iso.oy) / dy) + 1,
    };
  }

  /** THE GROUND SCROLL. A camera-latched redraw used to repaint the whole
   *  ground texture — every op of ~4,267 cells — when a 256 px step exposes
   *  ~18% of it (measured 30-75 ms of JS per step while running, after the
   *  cull and the resolution cache; the walking hitch). The texture is
   *  world-anchored, so the picture it holds is still right, just displaced:
   *  the kept part is copied into the other texture shifted by the anchor
   *  delta, only the newly exposed L-shaped band (a vertical strip, a
   *  horizontal strip; their corner twice, which is idempotent — each band is
   *  filled, then the whole painter sequence replayed into it) is painted, and
   *  the two textures swap roles. EXACT, because the band pass is the same pass
   *  clipped: every op that crosses the band edge is CROPPED to it (t3Blit,
   *  integer texel rects at scale 1), so the band's pixels see the same painter
   *  sequence a full paint gives them and nothing outside the band is touched.
   *  (Not a GL scissor: endDraw flushes into a capture target and blits it
   *  whole, so a scissor would clip the wrong stage.) Only camera latches
   *  scroll: a poisoned latch — repaintWorld, a landed batch, a resize, any
   *  indoor change — takes the full path, so the indoor state can never differ
   *  between the kept picture and the band. Parity: `__ml.groundHash()` after a
   *  scroll equals a forced full repaint at the same anchor (dev A/B:
   *  `__ml.groundScroll(on)`). */
  private scrollTiles3Ground(
    ax: number,
    ay: number,
    sx: number,
    sy: number,
    mask: Map<number, number> | null,
    cuts: Map<number, number> | null,
    top: number,
  ) {
    // Anything still owed on the OLD picture is painted now — the copy below
    // carries it forward, so a slice can never target a swapped texture.
    this.t3flushSlices();
    const cur = this.groundRT!;
    const next = this.groundScratch!;
    this.groundScrollLog.push([ax - sx, ay - sy, ax, ay, sx, sy, cur.x, cur.y]);
    if (this.groundScrollLog.length > 16) this.groundScrollLog.shift();
    const W = cur.width;
    const H = cur.height;
    const bg = this.groundFillRGB(mask);
    next.setPosition(ax, ay);
    next.clear();
    // The background under everything, as the full paint lays it: a WHOLE-
    // texture fill, the one fill that is texel-exact. (DynamicTexture.fill with
    // a rect is NOT: it keeps the renderer's projection over the texture's
    // viewport, scales the rect by canvas/texture and floors it — up to 1/scale
    // texels off per edge, measured as a 3 px navy seam bleeding into the kept
    // picture at 412/1436. So the bands get no fill of their own.)
    this.fillGround(next, bg);
    // The kept picture, moved: old texel (px, py) is world (prevAx + px,
    // prevAy + py), which in the new texture is (px - sx, py - sy). Opaque, so
    // under NORMAL blending it replaces the fill exactly.
    next.drawFrame(cur.texture.key, "__BASE", -sx, -sy);
    // Integer texels — see makeGroundRT. A fractional edge here is a sub-texel
    // crop, and sub-texel crops are what left background-coloured columns.
    const bands: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const IW = Math.ceil(W);
    const IH = Math.ceil(H);
    /* THE BAND OVERLAPS THE KEPT PICTURE BY `GROUND_SEAM` TEXELS.
     *
     * Without it every latch left ONE texel row showing the bare fill, and the
     * maintainer photographed the result: full-width bands of exactly 0x181c28
     * — this fill's own colour, so the row is filled and simply has no terrain
     * on it — spaced 512 device px apart at zoom 2, which is 256 world px, the
     * GROUND_MARGIN/2 latch step EXACTLY. One line per scroll, and they ride
     * up the screen and accumulate because the copy carries each one forward.
     *
     * Repainting a texel the copy already provided is IDEMPOTENT: the band pass
     * is the same painter sequence clipped, so the overlap row is drawn with
     * the ops it already had, and where the terrain is void the fill under it
     * is the same fill. So this cannot change a pixel that was right, and it
     * closes the seam whatever the sub-texel cause — which is the point: the
     * exactness argument for the band said no gap was possible, and a gap was
     * there anyway. One row of ops per latch is free. */
    const seam = GROUND_SEAM;
    if (sx > 0) bands.push({ x0: Math.max(0, IW - sx - seam), y0: 0, x1: IW, y1: IH });
    else if (sx < 0) bands.push({ x0: 0, y0: 0, x1: Math.min(IW, -sx + seam), y1: IH });
    if (sy > 0) bands.push({ x0: 0, y0: Math.max(0, IH - sy - seam), x1: IW, y1: IH });
    else if (sy < 0) bands.push({ x0: 0, y0: 0, x1: IW, y1: Math.min(IH, -sy + seam) });
    /* THE BAND IS NOT PAINTED HERE. Painting it cost 60-98 ms of JS in ONE
     * frame on fresh terrain (measured: ~3,000 blits plus 66-98 texture
     * compositions) — the freeze felt every ~1.5 s while running straight
     * (256 px / ~175 px per second). The band is background already (the
     * whole-texture fill above, with the kept picture copied over it) and lies
     * entirely OUTSIDE the view: the texture reaches GROUND_MARGIN past the
     * screen and a step exposes at most half of that, so nothing in the band
     * can be seen for ~2.9 s. It is QUEUED in slices and painted one per frame
     * (t3paintSliceStep) — identical pixels, none of the frames long. */
    this.groundLastShift = { x: sx, y: sy };
    this.groundSliceCtx = { ax, ay, mask, cuts, top };
    this.groundSliceQ = [];
    for (const b of bands) {
      if (!this.groundSliced) {
        this.groundSliceQ.push(b);
        continue;
      }
      // Cut along the band's LONG axis. Disjoint rects, so slice order cannot
      // change a pixel (the same argument the two bands already rest on).
      const vertical = b.y1 - b.y0 >= b.x1 - b.x0;
      const span = vertical ? b.y1 - b.y0 : b.x1 - b.x0;
      const n = Math.max(1, Math.ceil(span / this.groundSlicePx));
      for (let i = 0; i < n; i++) {
        if (vertical) {
          const lo = b.y0 + Math.round(((b.y1 - b.y0) * i) / n);
          const hi = b.y0 + Math.round(((b.y1 - b.y0) * (i + 1)) / n);
          if (hi > lo) this.groundSliceQ.push({ x0: b.x0, y0: lo, x1: b.x1, y1: hi });
        } else {
          const lo = b.x0 + Math.round(((b.x1 - b.x0) * i) / n);
          const hi = b.x0 + Math.round(((b.x1 - b.x0) * (i + 1)) / n);
          if (hi > lo) this.groundSliceQ.push({ x0: lo, y0: b.y0, x1: hi, y1: b.y1 });
        }
      }
    }
    this.groundSliceStats.runs++;
    this.t3stats = { cells: 0, blits: 0, boundaries: 0, decks: 0, scenery: this.t3stats.scenery, ms: 0, culled: 0, composed: 0, composeMs: 0 };
    // The cache keeps the FULL window's cells, not the band's — the next step
    // wants the ~82% it already knows.
    if (this.groundCacheOn && this.t3keepIdx) this.t3pruneCache(this.t3keepIdx);
    this.groundRT = next;
    this.groundScratch = cur;
    next.setVisible(true).setDepth(-1_000_000);
    cur.setVisible(false);
    this.groundAnchor = { ax, ay, mask, top };
    this.groundLastMode = "scroll";
  }

  /** ONE SLICE OF THE EXPOSED BAND, painted into the live texture through the
   *  same clipped pass the whole band used — identical pixels, a frame's worth
   *  at a time. Runs once per frame while anything is owed. */
  private t3paintSliceStep(): void {
    const b = this.groundSliceQ[0];
    const ctx = this.groundSliceCtx;
    const rt = this.groundRT;
    if (!b || !ctx || !rt || !this.maps3) return;
    this.groundSliceQ.shift();
    const t0 = performance.now();
    const win = this.t3groundWindow(ctx.ax, ctx.ay, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    this.groundClip = b;
    try {
      this.drawTiles3Ground(rt, ctx.ax, ctx.ay, win.u0, win.u1, win.v0, win.v1, ctx.mask, ctx.cuts, ctx.top);
    } finally {
      this.groundClip = null;
    }
    const sliceMs = performance.now() - t0;
    this.groundSliceStats.slices++;
    this.groundSliceStats.ms += sliceMs;
    /* THE SIZE IS NOT THE LEVER, AND STEERING IT DOWNWARD BACKFIRED. Measured
     * on his phone: shrinking slices took `groundSlice` from 6.48 ms/frame to
     * 16.66 — two and a half times WORSE. The reason is already written down
     * one screen up: every beginDraw/endDraw bracket costs a capture-target
     * clear AND A FULL-TEXTURE BLIT whatever it draws, so cost is dominated by
     * the number of BRACKETS, not by the area inside them. Smaller slices mean
     * more brackets for the same band, and each one pays that fixed price.
     * So the size only ever GROWS here, toward fewer brackets, and the floor is
     * the size that was shipping. */
    if (sliceMs < GROUND_SLICE_MS * 0.5) {
      this.groundSlicePx = Math.min(GROUND_SLICE_MAX, Math.round(this.groundSlicePx * 1.15));
    }
    if (!this.groundSliceQ.length) this.groundSliceCtx = null;
  }

  /** Pay off every owed slice NOW — before a scroll copies the picture forward,
   *  and before any probe reads the texture back. */
  private t3flushSlices(): void {
    if (!this.groundSliceQ.length) return;
    this.groundSliceStats.flushes++;
    let guard = 4096;
    while (this.groundSliceQ.length && guard-- > 0) this.t3paintSliceStep();
  }

  /** A lit piece's FOG SILHOUETTE: the copy's twin (texture, frame, origin,
   *  scale, flip) at the copy's depth, made RIGHT AFTER it so the two keep the
   *  creation order the epsilon-free lit band sorts ties by (litA, fogA, litB,
   *  fogB — never fogA over litB). Hidden until its fog is non-zero. */
  private makeFogSilhouette(lo: (typeof this.litOccluders)[number]): void {
    const im = lo.img;
    lo.fog = this.add
      .image(im.x, im.y, im.texture.key, im.frame.name)
      .setOrigin(im.originX, im.originY)
      .setScale(im.scaleX, im.scaleY)
      .setFlipX(im.flipX)
      .setDepth(im.depth)
      .setVisible(false);
  }

  /** A TERRAIN BATCH LANDED. The files it carried were wanted by known window
   *  cells (t3missing) or by nobody in the window (the prefetch ring, or cells
   *  that have since scrolled out) — so the repaint is scoped to the cells that
   *  can now draw, and a landing that changes nothing on the texture paints
   *  nothing. The occluders rebuild either way (they draw the same art). Legacy
   *  (coalesce off) and the switch off keep the old full repaint. */
  private onTerrainBatch(paths: string[]): void {
    this.repaintStats.terrain++;
    if (!this.repaintCoalesce) {
      this.repaintWorld();
      this.repaintStats.groundRuns++;
      this.repaintStats.occRuns++;
      return;
    }
    const cells = new Set<number>();
    let sheets = false;
    for (const p of paths) {
      if (this.t3sheetPaths.has(p)) sheets = true;
      const set = this.t3missing.get(p);
      if (!set) continue;
      for (const i of set) cells.add(i);
      this.t3missing.delete(p);
    }
    if (!this.groundPartial || !this.groundScroll || sheets) this.repaintGroundPending = true;
    else if (cells.size) {
      for (const i of cells) this.groundDirtyCells.push(i);
      this.repaintGroundPartial = true;
    }
    this.repaintOccPending = true;
    // Ring paths a slice left queued while this batch was in flight go now.
    const load = this.t3load;
    if (load && load.stats.pending === 0 && load.queuedCount > 0) load.flush();
  }

  /** REPAINT THE CELLS A LANDING MADE DRAWABLE — their rectangle (each cell's
   *  64-wide column from the world's highest storey down past its base, the
   *  same reach the window rule assumes) is reset to the background through
   *  the capture path (a 1x1 texture of the exact colour, scaled: NEAREST makes
   *  every texel that colour — not DynamicTexture.fill, which is not
   *  texel-exact for a rect) and repainted through the SAME clipped pass the
   *  scroll's bands use, so it equals a full paint pixel for pixel. A landing
   *  whose cells span more than half the texture paints in full instead, and
   *  so does one that arrives with no valid anchor. */
  private repaintTiles3Cells(cells: number[]): void {
    const rt = this.groundRT;
    const a = this.groundAnchor;
    const f = this.t3?.frame;
    const world = this.world;
    if (!cells.length) return;
    if (!rt || !a || !f || !world || !this.maps3 || Number.isNaN(this.lastGround.x)) {
      this.lastGround = { x: NaN, y: NaN }; // the next latch paints in full
      return;
    }
    const t0 = performance.now();
    const { lh } = this.geom;
    const W = rt.width;
    const H = rt.height;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const idx of cells) {
      const col = idx % world.width;
      const row = (idx - col) / world.width;
      const cx = t3columnX(f, col, row) - a.ax;
      const top = t3columnY(f, col, row, this.maxLevel) - T3_TOP_Y - lh - a.ay;
      const bot = t3columnY(f, col, row, 0) + T3_TILE + lh - a.ay;
      // A cell that has scrolled off the texture since it asked (t3missing
      // outlives the window until the next full paint) must not stretch the
      // rectangle from there to the visible ones.
      if (cx + T3_TILE <= 0 || cx >= W || bot <= 0 || top >= H) continue;
      if (cx < x0) x0 = cx;
      if (cx + T3_TILE > x1) x1 = cx + T3_TILE;
      if (top < y0) y0 = top;
      if (bot > y1) y1 = bot;
    }
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(W, Math.ceil(x1));
    y1 = Math.min(H, Math.ceil(y1));
    if (x1 <= x0 || y1 <= y0) return; // every landed cell lies off the texture
    if ((x1 - x0) * (y1 - y0) > 0.5 * W * H) {
      this.groundCellStats.full++;
      this.lastGround = { x: NaN, y: NaN };
      return;
    }
    const mask = a.mask;
    const cuts = mask ? this.indoorCut : null;
    const bgKey = mask ? "ground-bg-black" : "ground-bg-navy";
    if (!this.textures.exists(bgKey)) {
      const cv = document.createElement("canvas");
      cv.width = 1;
      cv.height = 1;
      const g = cv.getContext("2d")!;
      g.fillStyle = mask ? "#000000" : "#181c28";
      g.fillRect(0, 0, 1, 1);
      this.textures.addCanvas(bgKey, cv)?.setFilter(Phaser.Textures.FilterMode.NEAREST);
    }
    /* THE CLIP IS THE STAMP GROWN BY `GROUND_SEAM`, and that is what keeps the
     * repaint from eating a texel of its own border.
     *
     * The background under this rect is laid by `stamp` — a 1x1 texture scaled
     * to the rect — because a partial `fill` is documented NOT texel-exact
     * here. But a scaled stamp has its own rounding, and any spill lands
     * OUTSIDE the clip, where the replay below can never paint it back: a
     * one-texel line of bare 0x181c28 along the rect's edge, on terrain that
     * was already correct. The rects follow cell boundaries and this pass runs
     * wherever ART LANDS — i.e. all over ground the player is seeing for the
     * first time — so the lines accumulate into a lattice on the tile grid,
     * which is the maintainer's "zigzag on the water, and on the sand, and on
     * the road" (2026-09-03; measured off his screenshot as 2-device-px runs at
     * zoom 2 = exactly ONE TEXEL, so it is drawn at texel resolution, i.e. in
     * this texture and not by any full-screen pass).
     *
     * Painting one texel MORE than was stamped is idempotent — the same painter
     * sequence over pixels that already hold its output — so this can only
     * repair, never change a correct pixel. Same argument, same constant, as
     * the scroll band's seam overlap. */
    const b = {
      x0: Math.max(0, x0 - GROUND_SEAM),
      y0: Math.max(0, y0 - GROUND_SEAM),
      x1: Math.min(W, x1 + GROUND_SEAM),
      y1: Math.min(H, y1 + GROUND_SEAM),
    };
    this.groundLastRect = { stamp: { x0, y0, x1, y1 }, clip: { ...b }, W, H, cells: cells.length };
    rt.stamp(bgKey, undefined, x0, y0, { originX: 0, originY: 0, scaleX: x1 - x0, scaleY: y1 - y0, alpha: 1 });
    const win = this.t3groundWindow(a.ax, a.ay, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    this.groundClip = b;
    try {
      this.drawTiles3Ground(rt, a.ax, a.ay, win.u0, win.u1, win.v0, win.v1, mask, cuts, a.top);
    } finally {
      this.groundClip = null;
    }
    this.groundLastMode = "cells";
    this.groundCellStats.runs++;
    this.groundCellStats.cells += cells.length;
    this.groundCellStats.ms += performance.now() - t0;
  }

  /** THE PREFETCH RING, armed by every ground redraw: the cells of the texture
   *  window grown by GROUND_RING on every side, minus the window's own (the
   *  pass asks for those itself), queued for t3prefetchStep. The grown window
   *  is also what the resolution cache keeps, so a ring cell's resolution is
   *  still there when the cell scrolls in. */
  private t3armRing(ax: number, ay: number, w: number, h: number): void {
    if (!this.groundPrefetch || !this.maps3) {
      this.t3keepIdx = null;
      return;
    }
    const win = this.t3groundWindow(ax, ay, 0, 0, w, h);
    /* ONLY WHAT THE NEXT STEP WILL ACTUALLY NEED — the window as it will stand
     * after ANOTHER step of the same size, minus what is drawn now. A RING
     * around all four sides prefetched three sides nobody was walking towards:
     * ~6,100 cells to grind at 150 a frame, which is ~41 frames — longer than
     * the 1.46 s between latches at run speed, so the ring never stopped
     * working and its per-frame cost (resolves plus compositions) was paid on
     * EVERY frame of a run. Measured, that was the sustained bill the
     * maintainer felt as "I cannot get a smooth FPS" after the spike itself was
     * spread. The leading strip is a quarter to a half of the ring and is
     * exactly what the next band paints. Direction unknown (first paint after a
     * join or teleport) falls back to the symmetric ring. */
    const dx0 = this.groundLastShift.x;
    const dy0 = this.groundLastShift.y;
    const ring =
      dx0 === 0 && dy0 === 0
        ? this.t3groundWindow(ax, ay, -GROUND_RING, -GROUND_RING, w + 2 * GROUND_RING, h + 2 * GROUND_RING)
        : this.t3groundWindow(ax + dx0, ay + dy0, 0, 0, w, h);
    /* ONE WALK, TWO OUTPUTS, NO INTERMEDIATE ARRAY. This ran on every ground
     * latch (~1.5 s at run speed) and used to materialise the grown window as
     * ~11,000 [col,row] PAIRS just to filter them — 11,000 arrays plus the
     * queue, every latch, for the garbage collector to find later. The keep
     * list is now a Set of cell INDICES (what the prune actually tests) and
     * only the cells OUTSIDE the drawn window are materialised. */
    const world = this.world;
    if (!world) return;
    const keep = new Set<number>();
    const queue: [number, number][] = [];
    for (let v = ring.v0; v <= ring.v1; v++)
      for (let u = ring.u0; u <= ring.u1; u++) {
        if ((u + v) & 1) continue;
        const col = (u + v) / 2;
        const row = (v - u) / 2;
        if (col < 0 || row < 0 || col >= world.width || row >= world.height) continue;
        keep.add(row * world.width + col);
        if (u >= win.u0 && u <= win.u1 && v >= win.v0 && v <= win.v1) continue;
        queue.push([col, row]);
      }
    this.t3keepIdx = keep;
    this.t3ringQueue = queue;
    this.t3ringAt = 0;
  }

  /** A SLICE of the ring per frame: resolve (cached) and ask for the art, so it
   *  lands BEFORE its cell enters the texture and a landing then repaints
   *  nothing. Only once the world is up (the loading hold counts terrain
   *  requests). FLUSHED PER SLICE AND ONLY WHILE NOTHING IS IN FLIGHT: Phaser's
   *  loader merges files added mid-cycle into the running cycle and fires ONE
   *  complete for all of them, so a ring flush on top of a pass-owned batch
   *  would delay the landing the player is looking at until the ring's files
   *  were in too. Small ring batches, one at a time, bound that merge the other
   *  way round (a pass flush joins at most one slice's files); what a slice
   *  could not flush stays queued for the next slice, the next pass, or the
   *  landing (onTerrainBatch). */
  private t3prefetchStep(): void {
    const load = this.t3load;
    const t3 = this.t3;
    if (!load || !t3 || !this.worldUp || this.t3ringAt >= this.t3ringQueue.length) return;
    const tex = this.ensureTiles3Textures();
    if (!tex) return; // no composer yet (the pattern sheets): nothing to ask for
    // Never stack the ring onto the frame that scrolled or painted a slice —
    // those are the frames the player would feel.
    if (this.groundRedrewThisFrame || this.groundSliceQ.length) return;
    const built0 = tex.stats.built;
    const ringT0 = performance.now();
    /* MAY THIS FRAME COMPOSE AT ALL? A composition cannot be interrupted, so
     * the only way to hold a per-frame average below its own cost is to skip
     * frames. Resolution work (paths, cells) still runs every frame — it is
     * cheap and it is what feeds the loader. */
    this.ringSinceCompose++;
    const everyN = Math.max(1, Math.ceil(this.ringComposeMs / GROUND_RING_MS));
    const mayCompose = this.ringSinceCompose >= everyN;
    const end = Math.min(this.t3ringQueue.length, this.t3ringAt + GROUND_RING_STEP);
    const need = (p: string | null | undefined) => {
      if (p) load.need(p);
    };
    let i = this.t3ringAt;
    for (; i < end; i++) {
      const [col, row] = this.t3ringQueue[i];
      const cell = this.t3cellOf(t3, col, row);
      if (!cell) continue;
      cellArtPaths(cell, need);
      const b = this.t3boundaryOf(t3, col, row);
      if (b) boundaryArtPaths(b, need);
      for (const d of this.t3decksOf(t3, col, row)) deckArtPaths(d, need);
      /* AND COMPOSE IT — the half the ring used to leave on the critical path.
       * A boundary/plate texture is a canvas blend plus a GPU upload, and a
       * fresh 256 px step needed 66-98 of them inside ONE frame (measured 33-44
       * ms of the 60-98 ms spike). Built here, ahead of the camera and budgeted
       * per frame, they are cache hits by the time the band is painted. The ops
       * are discarded; only the textures they build are wanted. */
      // BUDGET SPENT — resume here next frame. The MILLISECOND test is the one
      // that binds on a phone (see GROUND_RING_MS); the compose count is an
      // upper bound for machines fast enough never to reach it.
      if (tex.stats.built - built0 >= GROUND_RING_COMPOSE || performance.now() - ringT0 >= GROUND_RING_MS) {
        i++;
        break;
      }
      if (!mayCompose) continue; // resolution only this frame; composing waits
      const cT0 = performance.now();
      const before = tex.stats.built;
      if (b) this.t3Try(`prewarm boundary ${col},${row}`, () => tex.opsForBoundary(b), null);
      this.t3Try(`prewarm blits ${col},${row}`, () => cellBlits(tex, this.t3tm, cell, undefined), []);
      if (tex.stats.built > before) {
        // LEARN WHAT IT COSTS HERE. One sample per composition, eased, so a
        // single slow blend cannot lock the ring out for a second.
        const ms = performance.now() - cT0;
        this.ringComposeMs = this.ringComposeMs
          ? this.ringComposeMs * (1 - GROUND_RING_COMPOSE_EMA) + ms * GROUND_RING_COMPOSE_EMA
          : ms;
        this.ringSinceCompose = 0;
        break; // one composition is this frame's whole share
      }
    }
    this.t3ringAt = i;
    if (load.stats.pending === 0) load.flush();
  }

  /** The (col,row) list of a cell window, in the pass's own order. */
  private t3windowCells(u0: number, u1: number, v0: number, v1: number): [number, number][] {
    const world = this.world;
    const cells: [number, number][] = [];
    if (!world) return cells;
    for (let v = v0; v <= v1; v++)
      for (let u = u0; u <= u1; u++) {
        if ((u + v) & 1) continue;
        const col = (u + v) / 2;
        const row = (v - u) / 2;
        if (col < 0 || row < 0 || col >= world.width || row >= world.height) continue;
        cells.push([col, row]);
      }
    return cells;
  }

  /** THE MAPS3 GROUND PASS, in render3's own order: every cell (painter-sorted
   *  by the u/v sweep), then the composed boundaries on the corner lattice
   *  above them, then the deck slabs.
   *
   *  THREE PASSES, NOT ONE INTERLEAVED PASS, and that is the spec's order for a
   *  reason: a boundary tile sits on the quad (x..x+1, y..y+1), so three of the
   *  four cells it blends are drawn AFTER it in painter order — interleaving
   *  would let those cells' own plates paint straight back over the transition.
   *
   *  Art that has not streamed in yet is simply not drawn; the loader repaints
   *  when the batch lands. A hole this frame is a hole; a substituted tile is a
   *  wrong picture that nothing ever corrects. */
  /** HIDE THE LOADING SCREEN WHEN THERE IS A WORLD BEHIND IT.
   *
   *  A tiles2 world's art is in the image and already loaded when the avatar
   *  arrives, so hiding on "my avatar is in" was the same instant as "the world
   *  is drawn". A maps3 world's art is NOT in the image (config/publish.json
   *  ships userWorlds only): every plate, pattern and top streams from the CDN
   *  after the join. The screen came down on the first frame anyway, and since
   *  `opsForCell` DROPS an op whose texture is not resident yet — a hole this
   *  frame is a hole, never a wrong tile — what the player got was his avatar
   *  and a campfire standing on empty dark ground for several seconds
   *  (maintainer 2026-08-29: "After loading the game is still rendered without
   *  textures for a while").
   *
   *  So: hold until the terrain has actually painted, and show real progress
   *  while it streams. DEADLINE-BOUNDED, because the alternative to a late
   *  world is a screen that never lifts — a dead CDN, a 404 tombstone, or a
   *  world whose art genuinely never arrives must all still drop the player in.
   *  Releasing early only restores today's behaviour; it can never strand. */
  private hideLoadingWhenTerrainIsUp(): void {
    if (!this.maps3) {
      hideLoading(); // image art: the avatar arriving IS the world being up
      this.worldUp = true;
      return;
    }
    /* TWO DEADLINES, because releasing onto a BLACK world is the one outcome
     * worse than waiting. The soft one gives up on the trimmings — scenery
     * still streaming, a manifest still in flight — and shows a world that has
     * at least drawn its ground. The hard one is the true backstop and only it
     * may release with NOTHING painted, which on a phone streaming a staging
     * world from the CDN is exactly the case the soft deadline used to hit
     * (maintainer 2026-08-29: "the game started without texture again"). */
    /* How long "everything is loaded" must stay true before the screen lifts.
     * 1.2 s covers several loader passes, so a flush window cannot masquerade
     * as an idle loader.
     *
     * THE 5 s / 90 s / 150 s TEST VALUES ARE REVERTED (they shipped in
     * bc6bd0bad1 to answer "does loading everything fix it?" — it did not).
     * A RECONNECT GOES THROUGH THIS SAME HOLD, so a 90 s soft deadline left
     * the maintainer stuck on "Reconnecting…" after tabbing back in. Raising
     * these is not free and must not be done again without accounting for the
     * rejoin path. */
    const HOLD_SETTLE_MS = 1200;
    const SOFT_DEADLINE_MS = 20000;
    const HARD_DEADLINE_MS = 60000;
    const t0 = performance.now();
    /* MONOTONIC. The denominator GROWS as the window discovers art — a scenery
     * manifest arrives and queues its sprites — so the raw fraction can fall,
     * and a bar that walks backwards reads as a fault. It only ever advances. */
    this.connectCreep?.remove(); // the streaming stage counts real files now
    this.connectCreep = null;
    let shown = STREAM_BAR0;
    setLoadingProgress(shown, "Streaming the world…");
    const tick = this.time.addEvent({
      delay: 100,
      loop: true,
      callback: () => {
        const waited = performance.now() - t0;
        const load = this.t3load;
        // PAINTED, not merely "nothing pending": a pass that drew zero blits
        // has requested nothing yet, so pending is legitimately 0 on the very
        // first frame and would release onto the same empty ground.
        /* TERRAIN **AND** SCENERY. Holding for terrain alone still let the
         * market stall and its trader appear after the player was already
         * standing next to them (maintainer 2026-08-29: "some objects pop into
         * existence after the game has already started"). Scenery does not ride
         * the terrain loader's queue: placements are bucketed per screen anchor,
         * each piece's MANIFEST is fetched lazily on the first rebuild that sees
         * it (205 fetches for 1,388 placements), and its landing schedules the
         * rebuild that queues its art (onSceneryManifest — before that hook the
         * art waited for camera drift and this hold always ran to its deadline).
         * So the wait is: the first rebuild has run, no manifest is in flight,
         * nothing is queued, and the shared Phaser loader is quiet. */
        const scenery =
          this.sceneryRebuilds > 0 &&
          this.sceneryQueue.length === 0 &&
          (!this.sceneryPieces || this.sceneryPieces.idle) &&
          !this.tiles3Loader().isLoading();
        const ready =
          this.groundPainted && (!load || load.idle) && scenery && !this.repaintGroundPending && !this.repaintOccPending;
        /* AND IT HAS TO STAY READY (maintainer 2026-09-03: "can you try to make
         * the loading a bit longer to make sure everything is loaded before we
         * start the game?").
         *
         * `load.idle` is queued 0 AND pending 0, and `need()` only QUEUES — the
         * queue does not become pending until `flush()`, which runs at the END
         * of a pass. So there is a real window, every pass, where art is owed
         * and the loader reads idle. One sample of `ready` can land in it and
         * release the screen with files still to come; the ground then paints
         * without them, and nothing repaints it afterwards while the player
         * stands still, because repaints are driven by camera latches. That is
         * the state he photographs.
         *
         * So require the condition CONTINUOUSLY for HOLD_SETTLE_MS. The tick is
         * 100 ms, so this costs at most that much extra loading on a world that
         * really is ready, and it cannot strand: both deadlines below still
         * fire regardless. */
        if (!ready) this.holdReadySince = 0;
        else if (!this.holdReadySince) this.holdReadySince = performance.now();
        const painted = ready && performance.now() - this.holdReadySince >= HOLD_SETTLE_MS;
        // The ground has drawn SOMETHING — the only fact that makes giving up
        // on the rest reasonable.
        const anyGround = this.groundPainted;
        const done = painted || this.unloading || waited >= (anyGround ? SOFT_DEADLINE_MS : HARD_DEADLINE_MS);
        if (!done) {
          /* REAL WORK, REAL BAR: terrain files plus scenery manifests plus the
           * sprite queue those manifests open, counted together — this stage is
           * most of a maps3 join and now owns most of the bar (0.40 -> 0.98). */
          const t = load?.stats;
          const sp = this.sceneryPieces?.stats;
          /* THREE COUNTS, ONE BAR: terrain files, scenery manifests, and the
           * scenery ART those manifests open — all per FILE now, so this stage
           * moves continuously instead of standing still until a batch lands.
           * The queue is in `want` because those files are known to be coming;
           * it empties into sceneryArt.requested, so the denominator does not
           * lurch when a flush happens. */
          const want =
            (t?.requested ?? 0) + (sp?.requested ?? 0) + this.sceneryArt.requested + this.sceneryQueue.length;
          const have = (t?.done ?? 0) + (sp ? sp.loaded + sp.failed : 0) + this.sceneryArt.done;
          const measured = want > 0 ? STREAM_BAR0 + (STREAM_BAR1 - STREAM_BAR0) * Math.min(1, have / want) : 0;
          /* AND A FLOOR THAT MOVES ON ITS OWN for the opening seconds, because
           * "requested" happens in one step and the first file lands whole
           * round trips later: measured, the bar sat dead at the stage's start
           * for 5.0 s while 140 terrain files were in flight and none had
           * finished. The creep is asymptotic to a FIFTH of the stage, so it
           * can never overtake honest progress or promise the end. */
          const creep = STREAM_BAR0 + (STREAM_BAR1 - STREAM_BAR0) * 0.2 * (1 - Math.exp(-waited / 2500));
          shown = Math.max(shown, measured, creep);
          setLoadingProgress(shown, "Streaming the world…");
          return;
        }
        tick.remove();
        if (!painted && !this.unloading)
          console.warn(
            `[nangijala] loading released after ${Math.round(waited)}ms without a finished world` +
              ` (blits=${this.t3stats.blits}, scenery=${scenery})`,
          );
        setLoadingProgress(1, "Ready");
        hideLoading();
        this.worldUp = true;
      },
    });
  }

  private drawTiles3Ground(
    rt: Phaser.GameObjects.RenderTexture,
    ax: number,
    ay: number,
    u0: number,
    u1: number,
    v0: number,
    v1: number,
    mask: Map<number, number> | null,
    cuts: Map<number, number> | null,
    top: number,
  ) {
    const t3 = this.t3;
    const world = this.world;
    if (!t3 || !world) return;
    const tex = this.ensureTiles3Textures();
    const load = this.t3load;
    // A file the pass wanted and does not have yet is remembered AGAINST THE
    // CELL that wanted it — a landed batch then repaints those cells' rectangle
    // and nothing else (onTerrainBatch). Rebuilt by a full paint (the window is
    // new), extended by a band paint.
    if (!this.groundClip) this.t3missing.clear();
    let needIdx = -1;
    const need = (p: string | null | undefined) => {
      if (!p || !load) return;
      if (load.need(p) || needIdx < 0) return;
      if (!load.wanted(p)) return; // tombstoned (404): it never lands, so never a repaint
      let set = this.t3missing.get(p);
      if (!set) this.t3missing.set(p, (set = new Set()));
      set.add(needIdx);
    };
    // Published BEFORE the passes and mutated in place: a gate reads these
    // counters to tell a correct dark frame from a black one, and an exception
    // mid-pass must leave what actually drew visible, not last frame's numbers.
    const stats = { cells: 0, blits: 0, boundaries: 0, decks: 0, scenery: this.t3stats.scenery, ms: 0, culled: 0, composed: 0, composeMs: 0 };
    this.groundCulled = 0;
    const built0 = tex?.stats.built ?? 0;
    const buildMs0 = tex?.stats.buildMs ?? 0;
    this.t3stats = stats;
    const drops0 = tex?.droppedOps ?? 0;
    const t0 = performance.now();
    const cellOf = (c: number, r: number) => this.t3cellOf(t3, c, r);
    const boundaryOf = (c: number, r: number) => this.t3boundaryOf(t3, c, r);
    const decksOf = (c: number, r: number) => this.t3decksOf(t3, c, r);

    // The window, once — all three passes walk the same cells.
    const cells = this.t3windowCells(u0, u1, v0, v1);

    rt.beginDraw();
    for (const [col, row] of cells) {
      const cell = cellOf(col, row);
      if (!cell) continue;
      stats.cells++;
      needIdx = row * world.width + col;
      cellArtPaths(cell, need);
      // THE COMPOSED BOUNDARY — `mask ? plateB : plateA` under the published
      // silhouette with a mandatory 1px darkened seam, which is why 18 shapes x
      // 16 Wang masks over per-ground plates cover all 105 pairs.
      //
      // DRAWN WITH ITS CELL, and that is the whole point. It used to be a
      // SECOND pass over the window, after every surface — so a transition
      // belonging to a far cell painted on top of the nearer cliff faces in
      // front of it, and the column of a cliff came out shuffled (maintainer
      // 2026-08-29: "the draw order is fucked up", circling one cliff edge).
      // render3 hit the identical bug and killed the same pass — its loop is
      // still there, spelled `for s in []`, with the note "the boundary is
      // drawn WITH the cell now" (render3.py:1190). In painter order a cell
      // draws once, and everything that cell wears draws inside that slot.
      const b = boundaryOf(col, row);
      if (b) boundaryArtPaths(b, need);
      if (!tex) continue;
      const idx = row * world.width + col;
      const cut = mask ? (cuts ? cuts.get(idx) : top) : undefined;
      const tint = this.caveTint(idx, !!mask);
      // A boundary is skipped INDOORS wherever ANY cell of its quad is a
      // constrained column: the cut-away has already truncated those, and a
      // transition pasted at the uncut level floats over the stump. With the
      // legacy kill switch (cuts null) every column is constrained, so no
      // boundary draws at all — which is what that switch means.
      /* GUARDED, like the resolves above it. A composition throws on art that
       * is not plate geometry, and an unguarded throw here escapes the whole
       * pass — one bad cell would black out the entire world instead of
       * costing its own diamond. */
      const bop =
        b && !(mask && (!cuts || this.t3QuadCut(cuts, col, row)))
          ? this.t3Try(`boundary art ${col},${row}`, () => tex.opsForBoundary(b), null)
          : null;
      // THE TILE IS THE BOUNDARY: on a flat cell the composed tile replaces the
      // plate rather than covering it — same silhouette, so the plate under it
      // was pure overdraw, and render3 composites exactly one tile here
      // (`wang_surface()`). A raised cell still draws its wall column first and
      // wears the transition on the cap, which is render3's own order.
      /* THE GROUND'S OWN COLOUR UNDER EVERY FLAT CELL, FIRST.
       *
       * A hole in this texture is a texel no op painted, and the maintainer's
       * dots are exactly that: measured off his screenshot, the ground fill
       * 0x181c28 in ONE-TEXEL runs along tile edges — and when the fill colour
       * was changed the dots changed with it, which is direct proof. The plate
       * lattice is provably gapless when every op draws (0 uncovered texels),
       * so a hole means an op did not draw; three days did not establish which
       * op or why, and it does not reproduce on this machine at his exact
       * geometry, screen or texture.
       *
       * So stop needing to know. A flat diamond of the cell's OWN top colour,
       * drawn before its art, means whatever fails to draw above it exposes the
       * ground's colour instead of the background: a missing tile reads as flat
       * ground, and a one-texel gap is invisible. It cannot change a correct
       * pixel — the art is opaque over its whole silhouette and paints straight
       * over this.
       *
       * CHEAP: `liquid()` caches one flat diamond per RGB (it is how water is
       * drawn), so this is one extra batchDrawFrame per flat cell against a
       * pass whose draw calls measured ~20% of its cost. Skipped for liquids,
       * which already ARE that diamond, and for raised cells, whose wall stack
       * is drawn from its own art. */
      if (cell.kind === "field" && cell.art?.kind !== "liquid") {
        const under = this.t3Try(`under ${col},${row}`, () => tex.groundUnderlay(cell), null);
        if (under) {
          this.t3Blit(rt, under, ax, ay, tint);
          stats.blits++;
        }
      }
      if (bop && cell.kind === "field" && !this.noTransitions) {
        this.t3Blit(rt, bop, ax, ay, tint);
        stats.blits++;
        stats.boundaries++;
      } else {
        for (const op of this.t3Try(`blits ${col},${row}`, () => cellBlits(tex, this.t3tm, cell, cut), [])) {
          this.t3Blit(rt, op, ax, ay, tint);
          stats.blits++;
        }
        if (bop) {
          this.t3Blit(rt, bop, ax, ay, tint);
          stats.boundaries++;
        }
      }
    }

    // DECK SLABS (roofs, bridges, the cave lid) last, as render3 draws them.
    for (const [col, row] of cells) {
      const idx = row * world.width + col;
      if (mask && (cuts ? cuts.get(idx) : top) !== undefined) continue; // my roof, or a lid over my floor
      needIdx = idx;
      for (const d of decksOf(col, row)) {
        deckArtPaths(d, need);
        if (!tex) continue;
        const tint = this.caveTint(idx, !!mask);
        for (const op of tex.opsForDeck(d)) {
          this.t3Blit(rt, op, ax, ay, tint);
          stats.decks++;
        }
      }
    }
    rt.endDraw();
    if (this.groundCacheOn && !this.groundClip) this.t3pruneCache(cells); // a band pass prunes after (scrollTiles3Ground); the ring keeps its cells
    stats.culled = this.groundCulled;
    // COMPOSITIONS this redraw paid for: boundaries/plates built on the fly
    // (pixels read, blended on a canvas, uploaded) — the streaming stall.
    stats.composed = (tex?.stats.built ?? 0) - built0;
    stats.composeMs = +((tex?.stats.buildMs ?? 0) - buildMs0).toFixed(1);
    stats.ms = +(performance.now() - t0).toFixed(1);
    if (stats.blits > 0) this.groundPainted = true;
    /* DID THIS PAINT DROP ANYTHING? See groundDropsPending. */
    if ((tex?.droppedOps ?? 0) > drops0) this.groundDropsPending = true;
    load?.flush();
    this.checkTiles3Pitch();
  }

  /** ONE REPAINT AFTER THE ART SETTLES, IF ANY OP WAS EVER DROPPED.
   *
   *  Called from update(). A dropped op leaves the render texture's own
   *  background showing — the maintainer's dotted line — and the existing
   *  repair path (t3missing -> onTerrainBatch) only covers ops whose FILE is
   *  still in flight. Anything else that drops (a tombstoned 404, a null
   *  composition, a resolution cached as empty) is never repainted at all, so
   *  it survives every later paint and he sees it while standing still, which
   *  no camera latch will ever clear.
   *
   *  Fires at most once per idle transition: the flag is set by a paint that
   *  dropped and cleared the moment the repaint is issued, so a cell whose art
   *  genuinely never arrives costs one repaint, not one per frame. */
  private t3drainDrops(): void {
    if (!this.groundDropsPending || !this.maps3) return;
    const load = this.t3load;
    if (!load || load.queuedCount > 0 || !load.idle) return;
    this.groundDropsPending = false;
    this.repaintWorld();
  }

  /** RESOLVE, BUT NEVER TAKE THE FRAME DOWN. `Tiles3.overTile` THROWS when the
   *  x-over-y matrix has no entry for a pair — deliberately, because the matrix
   *  is the only wall source and a missing entry is a hole in it, not something
   *  to paint around. In a still render that is a fatal; in a running game the
   *  same throw would kill the whole update loop, every frame, for one
   *  unpublished tile. So it is reported ONCE per distinct message and the cell
   *  is skipped: a hole in the map, loudly, rather than a black screen. */
  private t3Try<T>(where: string, f: () => T, fallback: T): T {
    try {
      return f();
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      if (!this.t3Failed.has(m)) {
        this.t3Failed.add(m);
        console.warn(`[nangijala] tiles3: ${where} could not resolve — ${m}`);
      }
      return fallback;
    }
  }

  /** Is any cell of the lattice quad anchored at (col,row) a CONSTRAINED
   *  column? (indoor cut-away — see drawTiles3Ground). */
  private t3QuadCut(cuts: Map<number, number>, col: number, row: number): boolean {
    const w = this.world!.width;
    return (
      cuts.has(row * w + col) ||
      cuts.has(row * w + col + 1) ||
      cuts.has((row + 1) * w + col) ||
      cuts.has((row + 1) * w + col + 1)
    );
  }

  /** OCCLUDER COLUMNS for a maps3 world — the same contract as the maps2
   *  branch: a duplicate of what the ground RT already painted, re-issued at
   *  sprite depth so bodies interleave with terrain, plus one `occluderMeta`
   *  record per column for `resolveBodyDepth`. Art and meta must agree in both
   *  directions (meta without art crops a body's lit copy against terrain that
   *  is not there; art without meta lets a body draw through a wall). */
  private tiles3Occluders(
    u0: number,
    u1: number,
    v0: number,
    v1: number,
    mask: Map<number, number> | null,
    cuts: Map<number, number> | null,
    top: number,
    shows: (x: number, y: number) => boolean,
    columnShows: (x: number, yTop: number, yBot: number) => boolean,
  ): number {
    const t3 = this.t3;
    const world = this.world;
    const tex = this.ensureTiles3Textures();
    if (!t3 || !world || !tex) return 0;
    const { dx, dy, lh, tile: tileSize } = this.geom;
    let culled = 0;
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        if ((u + v) & 1) continue;
        const col = (u + v) / 2;
        const row = (v - u) / 2;
        if (col < 0 || row < 0 || col >= world.width || row >= world.height) continue;
        const bx = this.iso.ox + u * dx;
        const by = this.iso.oy + v * dy;
        const oDepth = by + dy;
        const idx = row * world.width + col;
        const occCut = mask ? (cuts ? cuts.get(idx) : top) : undefined;

        // A deck slab floating ABOVE its base must occlude whoever walks under
        // it. Same rule as world@2: skip it entirely on a constrained column.
        if (occCut === undefined)
          for (const d of this.t3decksOf(t3, col, row)) {
            const base = world.rows[row]?.[col]?.l ?? 0;
            if (d.level <= base) continue; // the terrain occluder already covers it
            /* THE DECK TOP IS NEVER EXPOSURE-CULLED — world@2's rule, which this
             * branch did not copy. The top is the walkable surface and it is
             * the thing that hides a body walking UNDER the slab. `shows` is a
             * TILE-sized test at the op's own y, and a roof six levels up sits
             * ~90px above its cell, so the top fell outside the box, its image
             * was dropped, and the meta was pushed anyway — a meta record
             * describing terrain that draws nothing. The body then rendered
             * straight over the roof it was standing under (maintainer
             * 2026-08-29: "THE PLAYER STILL RENDERS OVER THE WALL WHEN BEHIND
             * THE WALL. THIS WORKED PERFECTLY"). It did: world@2 keeps the top
             * whenever the COLUMN reaches the cull box. Faces still cull. */
            const dops = tex.opsForDeck(d);
            for (let oi = 0; oi < dops.length; oi++) {
              const op = dops[oi];
              const isTop = oi === dops.length - 1;
              if (!(isTop ? columnShows(bx, by - d.level * lh, by + tileSize) : shows(bx, op.y))) {
                culled++;
                continue;
              }
              this.occluders.push(this.occImage(op.key, bx, op.y, oDepth, col, row));
            }
            this.occluderMeta.push({
              col, row, top: d.level, solid: false, depth: oDepth,
              x0: bx, x1: bx + tileSize, y0: by - d.level * lh, y1: by + tileSize,
            });
          }

        const cell = this.t3cellOf(t3, col, row);
        if (!cell) continue; // void cells never occlude
        /* ANY RAISED COLUMN OCCLUDES — world@2's rule, restored.
         *
         * `kind === "wall"` answers a DRAWING question: does this column show an
         * EXPOSED face? A cell whose down-screen neighbours sit at its own level
         * shows none, so the resolver calls it a field — and it is still six
         * levels of terrain standing between the camera and a body behind it.
         * Gating OCCLUSION on that test dropped the occluder and its meta for
         * every interior cell of a plateau or a thick house wall, so a body
         * walked in front of terrain it should have been hidden by (maintainer
         * 2026-08-29: "the player is rendered on top of the wall. THIS WORKED IN
         * V2"). world@2 emits one for every l>0 tile, exposed or not, and so
         * does this now. The exposed-face rule still governs the FACE COURSES
         * below — those are art, and drawing a band with nothing in front of it
         * is the row of ticks that rule exists to prevent. */
        if (cell.kind !== "wall" && cell.level <= 0) continue;
        const topKey = t3SurfaceKey(tex, this.t3tm, cell);
        const fk = t3FaceKey(this.t3tm, cell) ?? topKey;
        if (!topKey || !fk) continue; // art still streaming
        const topL = occCut !== undefined ? Math.min(cell.level, occCut) : cell.level;
        if (topL < 0) continue;
        const cutL = (c: number, r: number): number => {
          const n = world.rows[r]?.[c];
          if (!n) return -1;
          const e = cuts ? cuts.get(r * world.width + c) : top;
          return e === undefined ? n.l : Math.min(n.l, e);
        };
        // Only the EXPOSED faces, from the lowest front neighbour up — the same
        // rule the world@2 branch has: redrawing the covered lower faces on top
        // of the RT paints the front cell's ground back into a wall.
        const from =
          cell.kind !== "wall"
            ? topL // no exposed face: the cap alone, never a band
            : mask
              ? Math.max(0, Math.min(topL, Math.min(cutL(col + 1, row), cutL(col, row + 1)) + 1))
              : this.stackFrom(col, row, topL, false);
        for (let lvl = from; lvl < topL; lvl++) {
          if (!shows(bx, by - lvl * lh)) {
            culled++;
            continue;
          }
          this.occluders.push(this.occImage(fk, bx, by - lvl * lh, oDepth, col, row));
        }
        if (columnShows(bx, by - topL * lh, by + tileSize))
          this.occluders.push(this.occImage(topL === cell.level ? topKey : fk, bx, by - topL * lh, oDepth, col, row));
        else culled++;
        this.occluderMeta.push({
          col, row, top: topL, solid: false, depth: oDepth,
          x0: bx, x1: bx + tileSize, y0: by - topL * lh, y1: by + tileSize,
        });
      }
    }
    return culled;
  }

  /* -- SCENERY (maps3) -----------------------------------------------------
   * Freely placed, off-grid set dressing at CONTINUOUS cell coordinates —
   * 1,388 placements over 205 distinct pieces on the_game. `scenery3.ts` owns
   * the anchor projection, the crop/scale/flip fit and the spatial index; this
   * scene owns the sprites, and it draws them through the SAME conventions the
   * props do (one image per visible placement, origin 0,0, depth on the
   * unlifted painter line) so bodies interleave with a tree exactly as they
   * interleave with a pillar. There is no second depth path here — this repo
   * has paid for that one. */

  private initScenery(view: { levelAt: (x: number, y: number) => number }) {
    const world = this.world;
    if (!world?.scenery?.length || !this.t3) return;
    this.scenery = new SceneryIndex(
      buildPlacements(world.scenery, {
        frame: this.t3.frame,
        levelAt: (x, y) => view.levelAt(x, y),
        // A piece under a ROOF or CAVE deck is indoors and render3 skips it —
        // drawing it put a bush on the meadow house's roof. A BRIDGE hides
        // nothing: you walk under a bridge and the scenery below is the point.
        roofed: roofedCells(world.decks, world.width),
        width: world.width,
        bounds: { x0: 0, y0: 0, x1: world.width, y1: world.height },
      }),
    );
    this.sceneryPieces = new SceneryPieces({
      fetchJson: (url) =>
        fetch(url).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
      route: this.t3route,
      onLanded: () => this.onSceneryManifest(),
    });
    /* THE COLLISION DOCUMENTS, FROM THE AUTHORITY THAT STAMPS WITH THEM.
     * Footprints become blocked cells from two documents, and the prediction
     * has to reach the SAME cells the server does or the body fights the
     * correction every frame. Fetching them as ASSETS reached neither: the
     * bbox table is under games2/, which is not an ASSET_DOMAIN, so it 404'd
     * and `restampScenery` bailed on every call — the client stamped NOTHING
     * and tap-to-move routed straight through trees (maintainer 2026-08-29:
     * "the player walks straight into the tree and doesn't navigate around",
     * and the stuck-oscillation before it: the server held a body the client
     * believed was in open ground). The hitbox doc DID load, from the image's
     * baked copy, while the server stamps from the LIVE one off GitHub — so
     * tuning a hitbox in the wiki moved the server's trees and not ours.
     * One endpoint answers both from the objects the server itself holds,
     * which is the only arrangement in which they cannot drift; ~96 KB
     * gzipped. Never `docUrl`: a staging CDN pinned at this TAB's sha would
     * put two players' trees in different places. Failure is soft — no doc
     * means no scenery collision, exactly as before, never a crash. */
    void fetch("/api/scenery-collision")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        this.sceneryBboxDoc = (d?.bbox as SceneryBboxDoc) ?? null;
        this.sceneryHitboxDoc = (d?.hitbox as Record<string, SceneryHitboxRec>) ?? null;
        this.restampScenery();
        this.repaintWorld();
      })
      .catch(() => {});
  }

  /** The still's crop and canvas, measured ONCE per distinct art file. It is a
   *  full alpha scan of the source, so per placement would cost the_game 1,388
   *  scans for 205 answers — and per frame would cost that every frame. */
  /** Re-apply the scenery footprints to the prediction grid — THE SAME
   *  FUNCTION, the same two documents and the same projection the server stamps
   *  with, because a client and an authority holding different ellipses is the
   *  divergence /api/scenery-collision exists to rule out.
   *
   *  CALLED WITH WHATEVER HAS LANDED, INCLUDING NOTHING. The two documents
   *  arrive asynchronously, so this runs again as each one does; the stamp is
   *  idempotent (it resets the derived cells to `propBlocked` and rebuilds the
   *  ellipse table from scratch) and a missing document resets and stops. That
   *  is why the caller no longer rebuilds the whole grid first: bailing out
   *  early instead would leave the PREVIOUS footprints in place when a live
   *  hitbox edit retires one, and the body would keep colliding with a shape
   *  the wiki has deleted. */
  private restampScenery(): void {
    if (!this.terrain) return;
    stampSceneryCollision(
      this.terrain,
      this.world?.scenery ?? [],
      this.sceneryBboxDoc,
      this.sceneryHitboxDoc,
      // Scenery is a maps3 thing, and maps3 draws on dy=14 — the same argument
      // WorldRoom passes, or the client's trees would stand somewhere else.
      ISO_GEOMETRY_MAPS3,
    );
  }

  private sceneryArtFit(key: string): { bbox: ReturnType<typeof alphaBBox>; canvas: { w: number; h: number } } | null {
    const hit = this.sceneryFit.get(key);
    if (hit !== undefined) return hit as never;
    const px = this.texPixels(key);
    if (!px) return null;
    const rec = { bbox: alphaBBox(px), canvas: { w: px.w, h: px.h } };
    this.sceneryFit.set(key, rec as never);
    return rec;
  }

  /** Queue one scenery art file. Same one-request-per-path tombstone rule the
   *  tiles loader uses: a 404 must not re-fire every frame the piece is on
   *  screen. Flushed once per rebuild by `flushScenery`. */
  private needScenery(spritePath: string): boolean {
    const key = sceneryArtKey(spritePath);
    if (this.textures.exists(key)) return true;
    if (!this.sceneryAsked.has(key)) {
      this.sceneryAsked.add(key);
      this.sceneryQueue.push([key, sceneryArtUrl(spritePath, this.t3route)]);
    }
    return false;
  }

  private flushScenery() {
    if (!this.sceneryQueue.length) return;
    const batch = this.sceneryQueue;
    this.sceneryQueue = [];
    const l = this.tiles3LoaderAdapter();
    /* COUNTED, because the loading bar's last stage is mostly these. They ride
     * the terrain loader's Phaser queue but are not the terrain loader's files,
     * so they keep their own tally and the hold adds the two. */
    this.sceneryArt.requested += batch.length;
    if (!this.sceneryArtCounting) {
      this.sceneryArtCounting = true;
      l.onFile((key) => {
        if (key.startsWith("s3:") && this.sceneryArt.done < this.sceneryArt.requested) this.sceneryArt.done++;
      });
    }
    for (const [key, url] of batch) l.image(key, url);
    l.once("complete", () => {
      // Reconcile, the batch rule: everything queued before this landed.
      this.sceneryArt.done = this.sceneryArt.requested;
      this.requestRepaint("scenery");
    });
    if (!l.isLoading()) l.start();
  }

  /** The visible scenery for this camera window. Rebuilt on the occluder
   *  latch, with the props, so the two terrain-adjacent layers stay atomic. */
  /** A scenery MANIFEST landed: rebuild, so the art it names is queued NOW.
   *  The first rebuild over a fresh window can only request manifests; only a
   *  rebuild that SEES them queues their art. Nothing scheduled that second
   *  rebuild except camera drift past the occluder latch, so on a maps3 join
   *  the manifests landed onto a parked camera and their art sat unrequested
   *  until the loading screen gave up on its deadline (the boot hold's
   *  `scenery` condition could not come true before it). Coalesced: one
   *  rebuild per SCENERY_MANIFEST_SETTLE_MS, the camera latch poisoned because
   *  the window did not move — its contents did. */
  private onSceneryManifest() {
    if (this.sceneryManifestTimer || this.unloading || !this.world) return;
    this.sceneryManifestTimer = this.time.delayedCall(SCENERY_MANIFEST_SETTLE_MS, () => {
      this.sceneryManifestTimer = null;
      if (this.unloading || !this.world) return;
      this.requestRepaint("manifest");
    });
  }

  /** ONE SCENERY IMAGE, REUSED WHEN NOTHING ABOUT IT CHANGED — `occImage`'s
   *  twin, for the same measured reason. rebuildScenery rides the SAME 96 px
   *  latch as the occluders and destroyed and recreated every drawn piece's
   *  image on each one: standing still in a forest, that is the identical
   *  picture torn down and rebuilt about twice a second, and while running it
   *  is 109-230 ms per second of a phone's frame budget.
   *
   *  The key is everything that makes the image what it is — texture, crop
   *  frame, placed box and flip — so an image that comes back out of the pool
   *  needs NOTHING re-set but its depth, which the caller assigns on every
   *  piece anyway and the second pass overwrites. A multimap because two
   *  placements can legitimately be identical, and a pooled image the scene has
   *  since destroyed is dropped rather than reused.
   *
   *  ART ONLY, and this is a correctness boundary, not an oversight: the lit
   *  band carries NO depth epsilon and breaks ties by DISPLAY-LIST order, which
   *  is why the copies and their fog silhouettes are destroyed and recreated in
   *  creation order every rebuild (see OCC_DEPTH_EPS and rebuildOccluders'
   *  destroy). A pooled image keeps its old list position, so pooling those is
   *  precisely what would let a fog silhouette sort over the wrong lit copy.
   *  The art has its own `occSeq` epsilon and is therefore free to move. */
  private scnImage(
    tex: string,
    frame: string,
    x: number,
    y: number,
    w: number,
    h: number,
    flip: boolean,
  ): Phaser.GameObjects.Image {
    const k = `${tex}|${frame}|${x},${y},${w},${h},${flip ? 1 : 0}`;
    const have = this.scnPool.get(k);
    let img: Phaser.GameObjects.Image | undefined;
    while (have && have.length) {
      const cand = have.pop()!;
      if (cand.scene) {
        img = cand;
        break;
      }
    }
    if (img) this.scnReused++;
    else {
      img = this.add
        .image(x, y, tex, frame)
        .setOrigin(0, 0)
        .setDisplaySize(w, h)
        // The mirror is about the CROP's centre, never the source canvas's:
        // measured on the_game, 245 of 599 flipped placements shift a pixel
        // or more the other way, tree_021 by 16. setFlipX on an origin-(0,0)
        // image mirrors within its own displayed box, which IS the crop.
        .setFlipX(flip);
      this.scnCreated++;
    }
    let arr = this.scnNext.get(k);
    if (!arr) this.scnNext.set(k, (arr = []));
    arr.push(img);
    return img;
  }

  /** Destroy every pooled scenery image this rebuild did not take back out.
   *  Called at EVERY exit of rebuildScenery — an early return (no scenery
   *  index yet) must still tear down the previous set, which is what the
   *  unconditional destroy it replaced did. */
  private scnDrain(): void {
    if (!this.scnPool.size) return;
    const left: Phaser.GameObjects.Image[] = [];
    for (const arr of this.scnPool.values()) for (const im of arr) left.push(im);
    this.scnPool.clear();
    this.destroyBatch(left);
  }

  private rebuildScenery(cam: Phaser.Cameras.Scene2D.Camera) {
    /* THE CURRENT SET BECOMES THE POOL (see `scnImage`). Whatever this rebuild
     * does not take back out is destroyed by `scnDrain` at every exit. The
     * self-heal mirrors the occluders': a throw between the swap and the drain
     * would otherwise leave images alive, drawn and never re-sorted. */
    if (this.scnPoolOn) {
      this.scnDrain();
      this.scnPool = this.scnNext;
      this.scnNext = new Map();
    } else {
      this.destroyBatch(this.sceneryImgs);
      this.scnPool.clear();
      this.scnNext.clear();
    }
    this.scnReused = 0;
    this.scnCreated = 0;
    this.sceneryImgs = [];
    /* COUNTED BEFORE THE GUARD: the boot hold waits for this pass to have RUN,
     * and a world with no scenery index runs it and finds nothing. Counting
     * after the early return would make every such join sit out the hold's full
     * deadline instead of starting immediately. */
    this.sceneryRebuilds++;
    const idx = this.scenery;
    const pieces = this.sceneryPieces;
    const world = this.world;
    if (!idx || !pieces || !world) {
      this.scnDrain();
      return;
    }
    const { dy, lh, tile: tileSize } = this.geom;
    /* TWO RADII: what is DRAWN, and what is FETCHED.
     *
     * They used to be one 200px pad, which is barely off screen — so a piece
     * was first ASKED for at the moment it was almost visible, and a scenery
     * piece is two round trips deep (its manifest, then the art that manifest
     * names). Running into new ground outpaced that and the forest assembled
     * itself in front of the player (maintainer 2026-08-29: "scenery started to
     * pop up on screen... we must understand what will soon come, and load it
     * before we need it").
     *
     * The fetch radius is a full extra screen in every direction, so a piece is
     * requested about a screen's worth of walking before it can be seen, while
     * the DRAW set is unchanged — prefetching costs requests, not draw calls or
     * sprites. */
    const pad = 200;
    const view = cam.worldView;
    const rect = { x: view.x - pad, y: view.y - pad, w: view.width + pad * 2, h: view.height + pad * 2 };
    const reach = { x: view.x - view.width, y: view.y - view.height, w: view.width * 3, h: view.height * 3 };
    let drawn = 0;
    let roofedDrawn = 0;
    /* Pieces awaiting the SHARED depth/cover resolve (second pass, below). */
    const resolve: {
      img: Phaser.GameObjects.Image;
      meta: WorldScene["occluderMeta"][number] | null;
      lo: WorldScene["litOccluders"][number] | null;
      hbX: number; hbY: number; hbDepth: number; lvl: number; fx: number; fy: number;
    }[] = []; // indoor furniture the cut let through — see roofCutAwayAt
    for (const p of idx.query(reach)) {
      const piece = pieces.get(p.piece);
      if (piece === undefined) {
        void pieces.request(p.piece); // 205 fetches for 1,388 placements, lazily; landing → onSceneryManifest
        continue;
      }
      // INDOOR FURNITURE: a piece under a roof/cave deck draws only while that
      // roof is actually cut away — see roofCutAwayAt.
      if (p.roofed && !this.roofCutAwayAt(p.cx, p.cy, p.level)) continue;
      if (piece === null) continue; // tombstoned: the manifest 404'd or is broken
      // THE VARIATION THE MAP PLACED — without it every tree in a forest drew
      // the piece's base still and the wood looked stamped from one tree.
      const st = stateFor(piece, p.lit, p.state);
      const sprite = facedSprite(st, p.dir);
      if (!this.needScenery(sprite)) continue;
      /* PREFETCH ONLY beyond the draw pad: the manifest is in hand and the art
       * is queued by `needScenery` above, which is the whole point of coming
       * out this far. Everything below builds a sprite. */
      if (p.ax < rect.x - 256 || p.ax > rect.x + rect.w + 256 || p.ay < rect.y - 512 || p.ay > rect.y + rect.h + 256)
        continue;
      const art = this.sceneryArtFit(sceneryArtKey(sprite));
      if (!art) continue;
      /* Scale by the PIECE's own base sprite, never by the one being drawn — see
       * fitSprite. The bbox DOC is the source rather than the loaded texture:
       * the base art is often not even queued when a rotation is what shows, and
       * this is the same table the collision stamp scales the ellipse by, so the
       * outline and the art cannot drift apart. */
      const baseSprite = this.sceneryBboxDoc?.pieces?.[p.piece]?.sprite ?? null;
      const baseBox = baseSprite ? this.sceneryBboxDoc?.boxes?.[baseSprite] : undefined;
      const baseH = baseBox ? Math.max(1, baseBox[3] - baseBox[1]) : undefined;
      /* THE PERSON'S SCALE, NOT THE CONTRACT'S: world_px_height was derived for
       * a 64 px character and this game's people are 88 — a bed drawn at the raw
       * number stood at 0.54 of the man where its metres say 0.76. The stamp
       * re-bases through the same function, so outline and art still share one
       * scale (shared sceneryDrawnPx). */
      const fit = fitSprite(
        art.bbox,
        art.canvas,
        sceneryDrawnPx(piece.worldPxHeight, piece.contractCharacterPx),
        p.ax,
        p.ay,
        p.hflip,
        baseH,
      );
      if (fit.x + fit.w < rect.x || fit.x > rect.x + rect.w || fit.y + fit.h < rect.y || fit.y > rect.y + rect.h)
        continue;
      // INDOORS a piece outside my room still DRAWS — it renders below the
      // multiply overlay, so zero ambient blacks it out for free and a torch
      // through the doorway finds it. That is the props' rule, and the reason
      // there is no mask test here.
      /* THE PUBLISHED HITBOX — the ground this piece stands on, from the wiki
       * (live/tuning/scenery_hitbox.json, pushed with every other live file).
       * Its own contract says what it is for: "its centre line is what decides
       * render order — a player above an ellipse's centre is drawn behind that
       * part of the piece, below it in front." The ellipse is in FRAME pixels
       * from the frame's centre, so `fit.kx/ky` (frame -> screen) and the
       * crop's origin put it on screen; `flipX` mirrors ax with the art.
       *
       * A record with `boxes: []` is a DECISION — this piece needs no footprint
       * (anything hung on a wall) — and is not the same as no record at all,
       * which falls back to the anchor and a one-tile box. */
      const hb = sceneryHitboxFor(this.sceneryHitboxDoc, p.piece, st.key);
      /* CONFIRMED BOXES ONLY — the doc's own advice ("filter on !auto for
       * confirmed ones only"), and measured: of 3,704 records 3,689 are the
       * wiki's ALPHA-PLACED proposals and 15 are the maintainer's. The two are
       * not alike. His sit at ay 9..13 with ry 12..20; the proposals wrap the
       * whole visible art, so tree_075's is ay 56.25, ry 30.75 — a footprint
       * centre 34.5px (2.5 cells) up-screen of where the tree stands and a
       * radius half again as big. That is the CANOPY once more, this time in
       * the data: a body 2.4 cells behind the trunk still measured as below the
       * ellipse's centre and drew in front (maintainer 2026-08-29: "maybe the
       * hitbox is misplaced on this exact object" — it is).
       *
       * An auto record therefore falls back to the one-tile default at the
       * anchor, which is predictable. Accepting or editing a box in the wiki
       * drops the flag, and the game picks it up on the next fetch. */
      /* THE PUBLISHED BOX, auto or confirmed (maintainer 2026-08-29: "WE WANT
       * THE DEFAULT HITBOX WITH COLLISION"). The wiki's alpha-placed default is
       * the answer until he edits it, and editing one in the Scenery page
       * rewrites the record without the flag — the game reads whatever is
       * current, with no code change either way. */
      const box0 = hb?.boxes[0];
      const hbX = box0
        ? fit.x + (art.canvas.w / 2 + (fit.flipX ? -box0.ax : box0.ax) - fit.sx) * fit.kx
        : fit.x + fit.w / 2;
      const hbY = box0 ? fit.y + (art.canvas.h / 2 + box0.ay - fit.sy) * fit.ky : fit.ay;
      /* THE SORT KEY IS THE FOOTPRINT'S CENTRE, not the sprite's anchor — the
       * maintainer's rule, and the same quantity the body sorts on (its nadir
       * centre). Expressed as an offset from the anchor's painter line so the
       * base stays the projection everything else uses. */
      const hbDepth = this.iso.oy + (p.x + p.y) * dy + (hbY - fit.ay);
      /* FLAT ON THE GROUND (`collision: false`): a rug is floor, not an object.
       * It draws in the flat band under everything, it gets NO LIT COPY (the
       * copy exists to lift a standing object above the darkness overlay so it
       * reads as its own silhouette — floor wants exactly the ground's own
       * light, which is what being under the overlay gives it), and it
       * registers NO occluder (its `top` rounded its 39-56 px art up to 3-4
       * LEVELS, so a rug claimed to cover the player standing on it — the
       * "wall hack border in open ground" this file already warns about). */
      const flat = !piece.collision;
      const key = sceneryArtKey(sprite);
      // Resolved in a SECOND PASS below, once every piece has registered — a
      // piece must sort against its neighbours, not only against terrain.
      const tex = this.textures.get(key);
      const name = `s3c:${fit.sx},${fit.sy},${fit.sw},${fit.sh}`;
      if (!tex.has(name)) tex.add(name, 0, fit.sx, fit.sy, fit.sw, fit.sh);
      const img = this.scnImage(key, name, fit.x, fit.y, fit.w, fit.h, fit.flipX);
      this.sceneryImgs.push(
        img
          /* THE UNLIFTED PAINTER LINE AT THE ANCHOR — and NO cell-front `+dy`.
           * A terrain occluder adds it because a tile fills a whole cell and
           * must cover a body standing in that cell. Scenery is anchored at a
           * POINT, so the same offset let a piece BEHIND the player win by up
           * to a full cell: measured, anvil_003 at x+y 802.1 drew over a body
           * at 802.5, four tenths of a cell in front of it (maintainer
           * 2026-08-29: "I'm standing under the scenery, but the scenery is
           * still rendered on top of me"). */
          .setDepth(
            flat
              ? SCENERY_FLAT_DEPTH + hbDepth * 1e-3 + this.occSeq++ * OCC_DEPTH_EPS
              : hbDepth + this.occSeq++ * OCC_DEPTH_EPS,
          ),
      );
      /* AND IT OCCLUDES. Scenery drew with the right painter depth but told
       * `resolveBodyDepth` nothing, so a body never sorted behind a tree — it
       * only ever looked right by luck of raw painter order. This is the props'
       * record: `solid` marks bottom-anchored BILLBOARD art, which is what
       * makes the solidArtOver branch fire (written for "128px spires" — tall
       * art that covers anything behind its diagonal however far its top rises
       * above the feet). `top` is the ground plus one level, the same "a solid
       * structure visually stands ~1 level tall" the maps2 props use.
       *
       * THE BOX IS THE ART's, not the piece's own footprint: nothing in
       * scenery.json publishes one yet (it carries world_px_height but no
       * occluder/footprint), so this is the drawn crop. That reads a tree's
       * CANOPY where a player should be able to stand under it — asked scenery
       * for a published box so the maintainer can tune it in the wiki. */
      const scol = Math.floor(p.x);
      const srow = Math.floor(p.y);
      /* THE LIT COPY — the black-silhouette effect, which scenery never had.
       * A piece draws BELOW the darkness overlay, so zero ambient blacks it
       * out; the copy above the band is then tinted by the piece's OWN cell.
       * That is what makes an NPC outdoors read as a silhouette from inside a
       * house, and a tree must do the same (maintainer 2026-08-29: "my hope was
       * that Scenery worked the same way in every aspect and I would be able to
       * see a black silhouette of the tree"). Same construction as the props'
       * copy — same crop, same flip, same displayed box, same depth band, no
       * new ordering rules. */
      if (this.night && !flat) {
        this.litOccluders.push({
          img: this.add
            .image(fit.x, fit.y, key, name)
            .setOrigin(0, 0)
            .setDisplaySize(fit.w, fit.h)
            .setFlipX(fit.flipX)
            .setDepth(litDepth(hbDepth)), // NO epsilon here — see OCC_DEPTH_EPS: this is the lit band
          col: p.x,
          row: p.y,
          z: (world.rows[srow]?.[scol]?.l ?? 0) + 0.5,
          phase: ((((scol * 73856093) ^ (srow * 19349663)) >>> 0) % 628) / 100,
          bx: p.ax,
          by: p.ay,
          pd: hbDepth,
        });
        this.makeFogSilhouette(this.litOccluders[this.litOccluders.length - 1]);
      }
      const meta = flat ? null : {
        col: scol,
        row: srow,
        /* ITS OWN HEIGHT, from the piece's published `world_px_height`. A
         * blanket +1 made every rug, chair and table a one-level billboard, and
         * `higher` is what gates solidArtOver — so a RUG on the floor claimed to
         * cover the player and painted the "hidden behind terrain" outline on
         * him in open ground (maintainer: "the player get a wall hack border
         * even if it's obvious here that the Scenery is behind the player").
         * A rug rounds to 0 levels and can never occlude; a tree is several. */
        top: (world.rows[srow]?.[scol]?.l ?? 0) + Math.max(0, Math.round((piece.worldPxHeight ?? 0) / lh)),
        solid: true,
        point: true,
        depth: hbDepth,
        /* THE BOX IS A FOOTPRINT, NOT THE DRAWN ART — the props' own rule
         * (`x0: bx, x1: bx + tileSize`), which never uses the art's width
         * either. A tree's crop is its CANOPY: metres of leaves that a body
         * should walk straight under, and using it made everything beneath the
         * branches count as behind the trunk. One tile wide at the anchor, and
         * never wider than the art itself so a lamp post does not claim a whole
         * cell. Still a default: the moment scenery publishes a real
         * ground-contact box, this reads it instead. */
        /* THE ELLIPSE'S OWN EXTENT when the wiki has published one, else the
         * props' one-tile default. `y0` stays the art's top — that is how high
         * the thing rises, which is what the cover crop line means — while the
         * near edge is the footprint's, not the canopy's. */
        x0: box0 ? hbX - box0.rx * fit.kx : fit.x + fit.w / 2 - Math.min(tileSize, fit.w) / 2,
        x1: box0 ? hbX + box0.rx * fit.kx : fit.x + fit.w / 2 + Math.min(tileSize, fit.w) / 2,
        y0: fit.y,
        y1: box0 ? hbY + box0.ry * fit.ky : fit.y + fit.h,
      };
      if (meta) this.occluderMeta.push(meta);
      if (!flat)
        resolve.push({
          img,
          meta,
          lo: this.night ? this.litOccluders[this.litOccluders.length - 1] : null,
          hbX,
          hbY,
          hbDepth,
          lvl: world.rows[srow]?.[scol]?.l ?? 0,
          fx: p.x * CELL_WU,
          fy: p.y * CELL_WU,
        });
      drawn++;
      if (p.roofed) roofedDrawn++;
    }
    /* SECOND PASS — THE SHARED RULE. Every piece is registered now, so each one
     * resolves against the complete occluder set (terrain AND the other pieces)
     * through `resolveDrawDepth`, the very function players, monsters and NPCs
     * use. That is where the LIFT above the flat tile in front comes from — the
     * thing the piece-only code lacked, which drew grass over a tree — and
     * where the cover line comes from, so a piece's lit copy is cropped by the
     * same test that crops a body's. Its own record is excluded or it would
     * read itself as covering itself. */
    for (const r of resolve) {
      const d = this.resolveDrawDepth(
        { sprite: r.img, lx: r.hbX, lyFlat: r.hbDepth - 0.5, ly: r.hbY, fx: r.fx, fy: r.fy },
        r.lvl,
        r.meta,
      );
      r.img.setDepth(d.depth + (r.img.depth - r.hbDepth)); // keep this rebuild's tie-breaking epsilon
      if (r.meta) r.meta.drawDepth = d.depth; // the anchor line in `depth` stays put
      if (r.lo) {
        r.lo.pd = d.depth;
        r.lo.cover = d.coverY ?? Infinity;
        r.lo.img.setDepth(litDepth(d.depth));
        r.lo.fog?.setDepth(litDepth(d.depth));
      }
    }
    this.t3stats.scenery = drawn;
    this.sceneryRoofedDrawn = roofedDrawn;
    this.scnDrain();
    this.flushScenery();
  }

  private makeGroundRT() {
    // A SAVED texture outlives its game object (RenderTexture.preDestroy skips
    // texture.destroy() once saveTexture ran), so drop both through the
    // manager — that is what frees the GL render target. Every resize comes
    // through here (a phone's URL bar alone fires it), so a leak here would be
    // two viewport-sized textures per event.
    for (const rt of [this.groundRT, this.groundScratch]) {
      const key = rt?.texture?.key;
      rt?.destroy();
      if (key && this.textures.exists(key)) this.textures.remove(key);
    }
    this.groundAnchor = null;
    const rs = this.renderScale();
    // World-space texture (1 texel = 1 world px): size it in WORLD px so it
    // covers the same view regardless of the device render scale — scale.width
    // is device px (= CSS·rs), so /rs gives the CSS/world width. rs=1 → unchanged.
    /* INTEGER TEXELS, ALWAYS. `scale.width / rs` is fractional on a real phone
     * (1080 device px at rs 2.75 = 392.727), and a fractional texture width
     * makes every rectangle derived from it fractional too: the scroll's band
     * (x0 = W - sx), the slice rects and the clip crops in t3Blit. A crop on a
     * fractional edge samples a sub-texel column, and repeated over successive
     * scrolls those columns stack into the BACKGROUND-COLOURED vertical lines
     * the maintainer photographed (measured: 2 device px wide, exactly
     * 0x181c28, the ground fill). The whole-texture paint never showed it —
     * only the clipped passes do — which is why it arrived with the scroll. */
    const w = Math.ceil(this.scale.width / rs) + GROUND_MARGIN * 2;
    const h = Math.ceil(this.scale.height / rs) + GROUND_MARGIN * 2;
    const make = (key: string) => {
      const rt = this.add.renderTexture(0, 0, w, h).setOrigin(0, 0).setDepth(-1_000_000);
      /* NEAREST, EXPLICITLY — the same trap this file already documents twice
       * for `addCanvas` and `addDynamicTexture` ("does not inherit pixelArt's
       * default, and LINEAR smears…"), and never applied to the one texture the
       * whole world is drawn from.
       *
       * WHY THIS IS THE SUSPECT (maintainer 2026-09-03, after three days): the
       * zigzag DISAPPEARS when he opens the app switcher, which renders the
       * window at a different scale, and returns at full size. Combined with
       * repeated censuses of this texture finding ZERO artefact texels — screen
       * and texture, at his exact geometry — that says the dots are created when
       * the texture is SAMPLED to the display, not stored in it. LINEAR sampling
       * of a pixel-art texture at a fractional device scale does precisely that:
       * it blends each texel with its neighbour, so a diamond edge picks up the
       * darker wall band directly beneath it and the unpainted background beyond
       * it — which are the two exact colours he measured, (171,146,116) and
       * (24,28,40), one texel wide, at tile edges only.
       *
       * It also explains what nothing else did: why it never reproduces here
       * (this machine's device scale is an integer, so LINEAR samples texel
       * centres and looks identical to NEAREST), and why it is worst on his
       * phone at dpr 2.23.
       *
       * COSTS NOTHING IF WRONG: if Phaser already resolved this texture to
       * NEAREST via `pixelArt: true` — TextureSource.init does call setFilter(1)
       * when antialias is false — then this is a no-op. */
      rt.texture?.setFilter(Phaser.Textures.FilterMode.NEAREST);
      // A key, so the OTHER texture can draw this one's picture (the scroll copy).
      if (this.textures.exists(key)) this.textures.remove(key);
      rt.saveTexture(key);
      rt.texture?.setFilter(Phaser.Textures.FilterMode.NEAREST); // ...and after saveTexture rewires it
      return rt;
    };
    this.groundRT = make("ground-rt-a");
    this.groundScratch = make("ground-rt-b").setVisible(false);
    this.lastGround = { x: NaN, y: NaN };
  }

  /** Multiplicative grey for an interior floor tile, by its depth from the
   * opening — white (no tint) everywhere else. `depth` is stored +1, so 1 is
   * the cell at the mouth and 0 means "not a room" (see buildCaveDepth).
   * Skipped while INDOORS: the room you are standing in is lit by its own
   * ambient, and darkening it would undo the cut-away. */
  private caveTint(idx: number, indoors: boolean): number {
    if (indoors || !this.caveDepth) return 0xffffff;
    const dep = this.caveDepth.get(idx) ?? 0;
    if (dep <= 0) return 0xffffff;
    // DISABLED: the shader now darkens everything below the ceiling, floor
    // included, so tinting the floor here as well multiplied the two together
    // and the opening went pitch black. Kept as one switch rather than deleted
    // — if the shader path ever has to go, this is the fallback that worked.
    if (!CAVE_TINT_TILES) return 0xffffff;
    const f = Math.max(0, Math.min(1, Math.exp(-dep * CAVE_FALLOFF)));
    const c = Math.round(f * 255);
    return (c << 16) | (c << 8) | c;
  }

  /** THE BACKGROUND UNDER THE WHOLE GROUND TEXTURE.
   *
   *  A WHOLE-texture fill, which is the only fill that is texel-exact, and it
   *  covers EVERY row — verified directly off the framebuffer with
   *  `gl.readPixels` (400/400 opaque on the first and last row of a probe
   *  texture), not through `DynamicTexture.snapshot`, whose framebuffer branch
   *  returns the image unflipped and reads as a missing edge row. An earlier
   *  round mistook that readback for a real defect and overscanned this fill to
   *  "fix" it; the overscan was a no-op and the row it chased was the probe. */
  private fillGround(rt: Phaser.GameObjects.RenderTexture, rgb: number): void {
    rt.fill(rgb, 1);
  }

  /** THE GROUND TEXTURE'S CLEAR COLOUR — normally the page's own dark, and
   *  MAGENTA while the `clear: pink` switch is on. His idea, asked for
   *  repeatedly: "clear the screen with pink before we draw. Then we know if
   *  the pixels are still pink it means the black border is the pink
   *  background." It separates the only two things a dark line can be, in one
   *  tap and with no argument: a texel NOTHING painted turns magenta, and a
   *  texel something painted DARK stays dark. `0x181c28` is close enough to a
   *  dark tile colour that no screenshot census has ever settled it. */
  private groundFillRGB(mask: unknown): number {
    if (this.groundClearPink) return 0xff00ff;
    return mask ? 0x000000 : 0x181c28;
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
    // POISONED (repaintWorld, a landed batch, a resize, the indoor cut): the
    // picture is not to be trusted and a full paint is due. Read before the
    // latch is overwritten.
    const poisoned = Number.isNaN(this.lastGround.x);
    this.lastGround = { x: ccx, y: ccy };

    const world = this.world;
    const { dx, dy, lh, tile } = this.geom;
    const rt = this.groundRT;
    // Anchor the texture in world space around the camera centre.
    const ax = Math.round(ccx - rt.width / 2);
    const ay = Math.round(ccy - rt.height / 2);
    const mask = this.indoorInside ? this.indoorMask : null;
    const top = this.indoorTop; // the cut: highest level any column still draws
    const cuts = mask ? this.indoorCut : null; // per-wall raises past it
    // The colour behind everything. Outdoors the usual night-navy; INDOORS
    // BLACK, because indoors this fill is what shows through the sky band
    // above the cut-away and in genuine void cells — and navy times the indoor
    // ambient still reads as a faintly lit sky over an unlit world.
    if (this.maps3) {
      const prev = this.groundAnchor;
      const sx = prev ? ax - prev.ax : 0;
      const sy = prev ? ay - prev.ay : 0;
      const canScroll =
        this.groundScroll &&
        !!prev &&
        !poisoned &&
        !!this.groundScratch &&
        prev.mask === mask &&
        prev.top === top &&
        (sx !== 0 || sy !== 0) &&
        Math.abs(sx) < rt.width &&
        Math.abs(sy) < rt.height;
      this.t3armRing(ax, ay, rt.width, rt.height);
      if (canScroll) {
        this.scrollTiles3Ground(ax, ay, sx, sy, mask, cuts, top);
        return;
      }
      // A full paint covers everything: whatever the band still owed is void.
      this.groundSliceQ = [];
      this.groundSliceCtx = null;
      rt.setPosition(ax, ay);
      rt.clear();
      this.fillGround(rt, this.groundFillRGB(mask));
      const win = this.t3groundWindow(ax, ay, 0, 0, rt.width, rt.height);
      this.groundClip = null;
      this.drawTiles3Ground(rt, ax, ay, win.u0, win.u1, win.v0, win.v1, mask, cuts, top);
      this.groundAnchor = { ax, ay, mask, top };
      this.groundLastMode = "full";
      return;
    }
    rt.setPosition(ax, ay);
    rt.clear();
    this.fillGround(rt, mask ? 0x000000 : 0x181c28);

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

    // MAPS3: no cell carries a baked path, so the whole pass is the tiles3
    // resolution — three ordered sub-passes with their own begin/endDraw.
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
          if (mask) {
            // ---- THE CUT-AWAY, scoped to what can HIDE MY ROOM ----
            // A cell with an entry in the cut map is CONSTRAINED: my own
            // building (the roof comes off, the walls stand at their per-wall
            // raise) and the covering cone — any column down-screen whose
            // full-height art would bury one of my floors, mountain and
            // neighbouring wall alike (computeIndoorCuts). Painter order is
            // why the cone exists at all: a column k steps down-screen buries
            // an interior cell once it is ≳0.94·k levels taller — in
            // the_island2's caves the surrounding rock hides 417 of 417
            // interior cells if left standing.
            //
            // A cell WITHOUT an entry cannot cover my room from any angle and
            // falls through to the ordinary outdoor draw below — full column,
            // deck slab and all. That is what keeps the NEIGHBOUR'S house
            // closed when you step into yours (maintainer 2026-08-13: "you
            // don't want to also see into house_b") — it renders whole and
            // simply goes black under the zero-ambient rule, torch-findable
            // like everything else out there. With the legacy kill switch
            // (cuts null) every cell is constrained at the scalar dial — the
            // pre-scope world-wide cut, kept for QA's flat frames.
            //
            // The tile at the top of a TRUNCATED stack is a FACE, not the
            // baked top diamond — the baked top is the outdoor grass/rock
            // surface and reads as a lid on a wall stump. Only a column that
            // reaches its own real top gets its diamond (the floor, a sill, a
            // raised wall drawn whole).
            const cutE = cuts ? cuts.get(row * world.width + col) : top;
            if (cutE !== undefined) {
              const hi = Math.min(cell.l, cutE);
              if (hi >= 0) {
                for (let lvl = 0; lvl < hi; lvl++) rt.batchDraw(fk, bx, by - lvl * lh);
                rt.batchDraw(hi === cell.l ? topKey : fk, bx, by - hi * lh);
              }
              continue; // and never its deck slab — my roof, or a lid over my floor
            }
          }
          // The face stack too: an interior wall is what you actually SEE
          // through the opening, and a floor alone still reads bright.
          const ct = this.caveTint(row * world.width + col, !!mask);
          for (let lvl = 0; lvl < cell.l; lvl++) rt.batchDraw(fk, bx, by - lvl * lh, 1, ct);
          // THE CAVE SWALLOWS THE LIGHT — and it has to happen HERE, not in the
          // light shader. Outdoors the shader resolves every pixel of a cave to
          // max(terrain, deck), which in the_island2 is the MOUNTAIN's own 24:
          // floor and rock become the same number, so no per-pixel test can
          // separate them (four tried). At THIS line there is no ambiguity —
          // this is the cell's floor tile, being drawn as a floor.
          rt.batchDraw(topKey, bx, by - cell.l * lh, 1, ct);
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
              const dct = this.caveTint(row * world.width + col, !!mask);
              for (let lvl = lvl0; lvl < dk.deck.level; lvl++) rt.batchDraw(dFace, bx, by - lvl * lh, 1, dct);
              rt.batchDraw(dTop, bx, by - dk.deck.level * lh, 1, dct);
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
  /** DEATH: fade dark, drain the colour, and push slowly onto the body.
   *
   * The camera work is here rather than in updateChaseCam because it is the
   * opposite of a chase — it ignores the trail, the speed zoom and the
   * settle-to-integer rule, and simply eases onto a corpse that cannot move.
   * Nothing in it revives the player: the sequence ENDS in a prompt, and the
   * press is what asks the server (maintainer 2026-08-09: "only when/if the
   * player presses the screen will the player respawn").
   *
   * The colour drain wants a post-pipeline, which is WebGL-only — on the Canvas
   * renderer the veil alone still carries the fade, just without the
   * desaturation. Same shape as the cover surfaces' WEBGL gate. */
  private startDeath() {
    if (this.death) return;
    const cam = this.cameras.main;
    // WHERE THE CAMERA ACTUALLY IS, not where a chase would have put it. The
    // chase runs a trail (up to CAM_TRAIL_MAX behind you) and a speed-coupled
    // zoom-out, so at the moment of death the camera is centred somewhere
    // BEHIND the body at a fractional zoom. Starting the push from the body at
    // base zoom therefore snapped both on the first dead frame — it read as a
    // lag spike (maintainer 2026-08-09: "the camera jumps a bit... as if we
    // don't interpolate from where the camera actually was"). The push now
    // eases FROM this pose, so frame one is a no-op by construction.
    this.death = {
      at: this.time.now,
      armed: false,
      mode: "hushed",
      from: { x: cam.midPoint.x, y: cam.midPoint.y, zoom: cam.zoom },
    };
    // NO CAMERA POST-PIPELINE. The monochrome pass was a camera ColorMatrix,
    // and adding one re-routes the whole scene through its own render target —
    // which took the night/weather/shadow overlays and the bodies with it. The
    // screen went LIGHTER at the moment it was supposed to go dark, and the
    // corpse and its killer vanished (maintainer 2026-08-09, with shots). The
    // darkening has to COMPOSITE ON TOP of the light the world already has, so
    // it is a plain veil and nothing else touches the render path.
    // A DOM VEIL OVER THE GAME VIEW. It was a Phaser Rectangle with
    // scrollFactor 0 — screen space — positioned every frame at cam.midPoint,
    // which is WORLD space. So it sat thousands of pixels off-screen and the
    // darkening never appeared at all (maintainer 2026-08-09: "it doesn't feel
    // at all like the game becomes darker, that effect feels totally
    // missing"). In the DOM there is no scroll factor and no zoom to get
    // wrong: it covers the game view's own box, the same --gv-*/--hud-h insets
    // the card uses, and sits under the card and over the canvas.
    // Sweep strays first — the same rule the landscape gamepad follows. These
    // two nodes live on <body>, so a teardown that skipped endDeath (a scene
    // swap, a reload race) leaves them behind, and the card is
    // pointer-events:none and can never be dismissed by hand.
    for (const el of document.querySelectorAll(".ml-death-veil, .ml-death-card")) el.remove();
    const veil = document.createElement("div");
    veil.className = "ml-death-veil";
    veil.style.cssText = [
      "position:fixed",
      "left:var(--gv-left, 0px)",
      "right:var(--gv-right, 0px)",
      "top:0",
      "bottom:var(--hud-h, 0px)",
      "z-index:5",
      "pointer-events:none",
      // ONE static gradient, rasterised once; only `opacity` moves per frame,
      // which the compositor animates without repainting anything.
      `background:radial-gradient(circle at 50% ${(DEATH_FOCUS_Y * 100).toFixed(0)}%,` +
        ` rgba(5,5,10,${(1 - DEATH_DARK_CORE).toFixed(3)}) 0%,` +
        // The mid stop is out at 34% so the whole FIGURE stays in the bright
        // part — at 3x zoom the body is ~200px tall and a tighter core put a
        // gradient across it. The gradient's extent is farthest-corner.
        ` rgba(5,5,10,${(1 - (DEATH_DARK_CORE + DEATH_DARK) / 2).toFixed(3)}) 34%,` +
        ` rgba(5,5,10,${(1 - DEATH_DARK).toFixed(3)}) 76%)`,
      "will-change:opacity",
      "transform:translateZ(0)",
      "opacity:0",
    ].join(";");
    document.body.appendChild(veil);
    this.death.veil = veil;
    // MUSIC DOWN. `hushed` is the quietest mode the audio engine publishes
    // (0.25x); the composer agent owns that table and a true silence needs a
    // mode from them — asked for on their board. Restored on revive.
    gameAudio.setMode(this.death.mode);
    this.camDetached = true; // updateChaseCam must not fight the push
  }

  /** ASK TO COME BACK, AND KEEP ASKING. The press used to be fire-and-forget:
   * one `room.send` with no retry and no feedback, so a refusal (the server
   * still owes the die clip), a dropped patch or a half-dead socket left the
   * player pressing a prompt that could never answer. Now the ask is a state
   * that stepDeath re-sends until `selfDead` actually clears — the same shape
   * as the pickup intent, which is retried for exactly this reason. */
  private askRevive() {
    const d = this.death;
    if (!d || !d.armed) return;
    if (!d.askAt) d.askAt = this.time.now; // first ask — starts the patience clock
    d.nextAsk = 0; // send on this frame
  }

  private stepDeath(now: number) {
    const d = this.death;
    if (!d) return;
    // SELF-HEAL: the sequence may not outlive being dead. `selfDead` is cleared
    // on the revive AND by the rejoin's clean slate, and anything else that
    // learns I am alive gets this for free rather than having to remember to
    // tear down a pair of DOM nodes it does not know about.
    if (!this.selfDead) return this.endDeath();
    const cam = this.cameras.main;
    const id = this.room?.sessionId;
    const av = id ? this.avatars.get(id) : undefined;
    const t = now - d.at;
    // ONE curve for the push, the dark and the drain: ease-out, so it starts
    // quickly enough to read as a reaction and then crawls.
    const zp = Math.min(1, t / DEATH_ZOOM_MS);
    const ease = 1 - Math.pow(1 - zp, 3);
    const base = this.zoomFor();
    cam.setZoom(d.from.zoom + (base * DEATH_ZOOM - d.from.zoom) * ease);
    if (av) {
      const tx = av.sprite.x;
      // AIM AT THE CORPSE, NOT AT WHERE A STANDING BODY'S CHEST WOULD BE. The
      // die clip lays the character out on the ground, so its mass sits at the
      // bottom of the frame, around the foot anchor — a 0.35-frame lift centred
      // the push on the empty air above it (maintainer 2026-08-12: "you zoom in
      // a bit too high up. The player falls to the ground so you should zoom in
      // a bit further down").
      const ty = av.sprite.y - av.sprite.displayHeight * DEATH_AIM_FRAC;
      cam.centerOn(d.from.x + (tx - d.from.x) * ease, d.from.y + (ty - d.from.y) * ease);
    }
    // The gradient already carries how dark each part of the screen ends up, so
    // the ramp is the plain ease — 1 means "the vignette, fully arrived".
    if (d.veil) d.veil.style.opacity = String(ease);
    // THE BODY DARKENS WITH THE WORLD. A second copy of the corpse used to be
    // drawn above the veil so it stayed brighter, and it worked — but a body
    // drawn twice is a body outside the depth sort, so it sat over things it
    // should have been behind (maintainer 2026-08-09: "don't draw the player
    // again so the z-order get buggy... we can make the player lighter in a
    // non-buggy way when we have time"). Lifting it properly means lighting,
    // not a second draw.
    // ARMED once the push has landed. The prompt sits UNDER the body, in world
    // space, so it rides the zoom with it instead of floating in screen space.
    if (zp >= 1 && !d.armed) d.armed = true;
    if (d.armed && av) {
      // A CARD IN THE HUD'S OWN CLOTHES, over the body — the character is
      // lying down, so where the head used to be is empty picture and the one
      // place a card does not cover anything (maintainer 2026-08-09).
      // A REAL UI CARD, IN THE DOM, IN SCREEN SPACE. It was a Phaser text in
      // WORLD space, which the 3x death zoom then magnified into a banner
      // across the top of the screen (maintainer 2026-08-09: "way too high up
      // and doesn't follow the UI/UX style at all"). Everything else in this
      // game's chrome is DOM on the wiki theme, so this is too: the colours,
      // the serif and the radii are the theme's own custom properties, which
      // also means it follows light/dark for free and needs no JS to do it.
      // Sits at 40% of the GAME VIEW's height — the camera centres the body
      // just below middle, so this lands over it without covering it.
      if (!d.el) {
        const el = document.createElement("div");
        el.className = "ml-death-card";
        el.textContent = "Press to continue...";
        el.style.cssText = [
          "position:fixed",
          // CENTRED ON THE GAME VIEW, not on the window. In landscape the menu
          // is a side COLUMN, so the view is inset by --gv-left/--gv-right (in
          // portrait both are 0 and this reduces to the middle of the screen).
          // Same vars the chat log, the stat chips and the clock pill anchor
          // off — anything that centres on 50vw is wrong the moment the layout
          // turns sideways (maintainer 2026-08-09).
          "left:calc(var(--gv-left, 0px) + (100vw - var(--gv-left, 0px) - var(--gv-right, 0px)) / 2)",
          "top:calc((100dvh - var(--hud-h, 0px)) * 0.40)",
          "transform:translate(-50%,-50%)",
          "z-index:6",
          "pointer-events:none",
          "font-family:var(--serif)",
          "font-size:15px",
          "font-weight:600",
          "color:var(--ink)",
          "background:var(--surface)",
          "border:1px solid var(--border)",
          "border-radius:12px",
          "padding:8px 16px",
          "box-shadow:0 2px 10px rgba(0,0,0,.35)",
          "opacity:0",
          "transition:opacity .45s ease",
        ].join(";");
        document.body.appendChild(el);
        d.el = el;
        requestAnimationFrame(() => el && (el.style.opacity = "1"));
      }
      // THE ASK IS RE-SENT UNTIL IT IS ANSWERED. The only proof the press
      // worked is `selfDead` going false (this whole sequence self-heals on
      // it), so keep asking rather than trusting one packet. Survives a press
      // the server still refuses, a dropped patch, and a socket that died
      // without firing room.onLeave — the rejoin rewires `this.room` and the
      // next retry simply lands.
      if (d.askAt && now >= (d.nextAsk ?? 0)) {
        this.room?.send("respawn", {});
        d.nextAsk = now + REVIVE_RETRY_MS;
        // ...and SAY SO if it still has not taken. Silence is what made this
        // read as a dead button (maintainer: "pressed all over the place but
        // nothing happened") — after a few unanswered seconds the prompt stops
        // pretending it is waiting for him and admits it is waiting for the
        // server.
        if (d.el && now - d.askAt > REVIVE_QUIET_MS &&
            d.el.textContent !== "Reconnecting…") d.el.textContent = "Reconnecting…";
      }
    }
  }

  /** Revived (or left the world): put everything back. */
  private endDeath() {
    const d = this.death;
    if (!d) return;
    this.death = null;
    d.el?.remove();
    d.veil?.remove();
    gameAudio.setMode("overworld");
    this.camDetached = false;
    this.camChase.init = false; // snap back onto the living body
    this.cameras.main.setZoom(this.zoomFor());
  }

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
    // (1 world px still = base·rs backing px = base device px). rs=1 →
    // byte-identical. ROUNDED to a whole backing pixel per world pixel — see
    // `cameraZoom`, which owns the reason and the arithmetic.
    return cameraZoom(this.scale.width, this.renderScale());
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

  /** Stamp a maps2 terrain occluder image with the CELL it was built for — that
   * is all these tags carry. The ONE reader is the cull audit
   * (`__ml.occAudit`), which uses them to answer "which cells contributed at
   * least one image this rebuild?" and so to compute `metaWithoutArt`. Nothing
   * reads a depth or a level from here: the audit measures geometry with
   * Phaser's own `getBounds()` and takes each column's top level, cell and
   * bounds (`top`, `col`/`row`, `solid`, `x0`/`x1`/`y0`/`y1`) from
   * `occluderMeta`. Keep this cheap — a rebuild runs it ~3,885 times at
   * the_island2's mountain. */
  /** DESTROY A SET OF DISPLAY OBJECTS IN O(n), NOT O(n²).
   *
   *  Phaser's `destroy()` takes the object off the scene's display list by
   *  SCANNING it: `exists()` is an indexOf over the whole list, then `remove()`
   *  is a second indexOf plus a splice (Phaser 3.90:
   *  GameObject.removeFromDisplayList → DisplayList.exists / List.remove →
   *  ArrayUtils.Remove). Destroying the occluder set one object at a time is
   *  therefore QUADRATIC in the list length — measured at the snow cliffs,
   *  5,714 occluders in a ~6,000-object list cost 90-130 ms of pure JS in ONE
   *  frame, every 96 px of camera travel: the single largest JS event at the
   *  maintainer's laggy spots (investigation 2026-09-02).
   *
   *  So the whole set leaves the display list in ONE pass — the list is
   *  filtered in place against a Set — and only then is each object destroyed;
   *  it now finds itself absent (its `exists()` scans only the few hundred
   *  objects that remain) and skips the removal. Everything else `destroy()`
   *  does — texture release, event teardown, update-list removal — runs exactly
   *  as before. What is skipped is the per-object REMOVED_FROM_SCENE emit,
   *  whose only listeners in Phaser are Sprite (update-list removal; these are
   *  Images) and Group/Layer (which hold none of these) — nothing observes the
   *  difference. One depth sort is queued for the frame, as the rebuild's new
   *  objects would have queued anyway. */
  private destroyBatch(objs: readonly Phaser.GameObjects.GameObject[]): void {
    if (!objs.length) return;
    if (this.occFastDestroy) {
      const gone = new Set<Phaser.GameObjects.GameObject>(objs);
      const list = this.children.list;
      let w = 0;
      for (let r = 0; r < list.length; r++) {
        const o = list[r];
        if (!gone.has(o)) list[w++] = o;
      }
      list.length = w;
      this.children.queueDepthSort();
    }
    for (const o of objs) o.destroy();
  }

  private tagOccluder(img: Phaser.GameObjects.Image, col: number, row: number): Phaser.GameObjects.Image {
    img.setData("oc", col);
    img.setData("or", row);
    return img;
  }

  /** ONE OCCLUDER IMAGE, REUSED WHEN NOTHING ABOUT IT CHANGED.
   *
   *  Every 96 px of camera travel the occluder set was destroyed and rebuilt
   *  from scratch, and the investigation measured that 90-95% of the images it
   *  recreated were bit-identical to the ones it had just destroyed (a one-latch
   *  step at the forest: 1,489 of 1,649 the same, reproduced twice). Creating
   *  ~5,400 Phaser images costs ~46-58 ms of JS at the snow cliffs and
   *  destroying them ~12 ms even after the O(n) destroy — in ONE frame, roughly
   *  twice a second while running. That stall IS the lag at the maintainer's
   *  laggy spots.
   *
   *  So an image is identified by everything that makes it what it is — cell,
   *  texture, position and base depth (col/row are in the key because two cells
   *  at different levels CAN land on the same screen point) — and a rebuild
   *  asks for the same key it asked for last time: the image comes back out of
   *  the pool untouched, the ~5-10% delta is created and destroyed, and the
   *  cover index and metadata are rebuilt in full as before (they are data).
   *  The pool is a multimap because the old set could legitimately hold two
   *  identical images. A pooled image that the scene has since destroyed
   *  (`scene` gone) is dropped, never reused. Depth: see OCC_DEPTH_EPS. */
  private occImage(tex: string, x: number, y: number, depth: number, col: number, row: number): Phaser.GameObjects.Image {
    const k = `${col},${row},${tex},${x},${y},${depth}`;
    const have = this.occPool.get(k);
    let img: Phaser.GameObjects.Image | undefined;
    while (have && have.length) {
      const cand = have.pop()!;
      if (cand.scene) {
        img = cand;
        break;
      }
    }
    if (img) this.occReused++;
    else {
      img = this.tagOccluder(this.add.image(x, y, tex).setOrigin(0, 0), col, row);
      this.occCreated++;
    }
    img.setDepth(depth + this.occSeq++ * OCC_DEPTH_EPS);
    let arr = this.occNext.get(k);
    if (!arr) this.occNext.set(k, (arr = []));
    arr.push(img);
    return img;
  }

  /**
   * Rebuild the occluder set: every raised (l>0) or solid non-water tile near
   * the camera gets real depth-sorted images (depth = its footprint's TOP
   * vertex y), so sprites standing behind it are covered while sprites in
   * front draw over it. The ground RT stays as the flat base underneath.
   */
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
    const tDestroy = performance.now();
    this.occSeq = 0;
    this.occReused = 0;
    this.occCreated = 0;
    if (this.maps3 && this.occPoolOn) {
      /* THE CURRENT SET BECOMES THE POOL. Every maps3 occluder is created by
       * occImage and therefore lives in occNext; what this rebuild does not
       * take back out is destroyed at the end of the maps3 branch. LIT COPIES
       * ARE DELIBERATELY OUTSIDE THE POOL — maps2 emissive art AND the maps3
       * scenery silhouettes rebuildScenery pushes per drawn piece — and are
       * destroyed and recreated in creation order every rebuild; that order is
       * what keeps their ties right without any depth epsilon (see
       * OCC_DEPTH_EPS). Do not drop this destroy as dead: it is one image per
       * tree per rebuild. */
      /* SELF-HEALING: a throw between the swap and the drain (tiles3draw's
       * composeBoundary documents one) would leave images in occPool with no
       * other reference — alive, drawn every frame, never re-sorted for a cut.
       * Normally occPool is empty here and this costs nothing. */
      if (this.occPool.size) {
        const stray: Phaser.GameObjects.Image[] = [];
        for (const arr of this.occPool.values()) for (const im of arr) stray.push(im);
        this.destroyBatch(stray);
      }
      this.occPool = this.occNext;
      this.occNext = new Map();
      this.destroyBatch(this.litOccluders.flatMap((lo) => (lo.fog ? [lo.img, lo.fog] : [lo.img])));
    } else {
      // ONE pass for both sets — see destroyBatch.
      this.destroyBatch(this.occluders.concat(this.litOccluders.flatMap((lo) => (lo.fog ? [lo.img, lo.fog] : [lo.img]))));
      this.occPool.clear();
      this.occNext.clear();
    }
    this.litOccluders = [];
    this.occluders = [];
    this.occDestroyMs = performance.now() - tDestroy;
    this.occluderMeta = [];
    this.emissiveLights = [];

    // ONE mask, TWO consumers — the ground RT and this pass are independent
    // renderings of the same terrain, and deriving the verdict twice guarantees
    // they drift. Roof art suppressed only in the RT comes straight back here
    // as a sprite at depth `by+dy`, floating over a ground that has already
    // deleted it. (commitIndoor poisons BOTH camera latches for the same
    // reason — they fire on different thresholds.)
    const mask = this.indoorInside ? this.indoorMask : null;
    const top = this.indoorTop; // the cut: highest level any column still draws
    const cuts = mask ? this.indoorCut : null; // per-wall raises past it

    const { dx, dy, lh, tile: tileSize } = this.geom;
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
    // MAPS3: the column's art comes from tiles3, not from a baked path. Same
    // cull boxes, same occluderMeta contract, same atomic rebuild — scenery
    // rides here for exactly the reason props do (see rebuildProps).
    if (this.maps3) {
      this.occCulled = this.tiles3Occluders(u0, u1, v0, v1, mask, cuts, top, shows, columnShows);
      this.ps();
      this.rebuildScenery(cam);
      this.pe("rebuildScenery");
      // No glow field: tiles2/emission.json is a tiles2 product and a v3 world
      // references none of it. An empty stamp list is what the night pipeline
      // already does for a world with no emissive art.
      this.glowStamps = [];
      /* THE COVER INDEX, which this early return skipped on EVERY maps3 world.
       * It is the last line of the maps2 path for a reason: the occluder images
       * have just been destroyed and recreated, so this is the one moment their
       * broad-phase index can go stale. Returning before it left `coverBuckets`
       * empty, so `coverCandidates` found nothing for any body, nothing was ever
       * COVERED, and the pixel-exact lit copy drew over every wall and roof in
       * the world — the player standing on top of a house he was behind. The
       * depth sort was right the whole time; the second copy was not. */
      this.rebuildCoverIndex();
      // WHAT THE POOL DID NOT GIVE BACK is what actually left the window.
      const tLeft = performance.now();
      const leftover: Phaser.GameObjects.Image[] = [];
      for (const arr of this.occPool.values()) for (const im of arr) leftover.push(im);
      this.occPool.clear();
      this.destroyBatch(leftover);
      this.occDestroyMs += performance.now() - tLeft;
      return;
    }
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
          // INDOORS a CONSTRAINED cell draws no deck — my own ceiling (the
          // roof the cut takes off) and any slab in the covering cone. An
          // UNCONSTRAINED cell keeps its deck exactly as outdoors: the
          // neighbour's roof and a distant bridge are painted by the RT now,
          // so the occluder copy must exist too — art and meta agree, in both
          // directions (a meta record without art crops a body's lit copy
          // against terrain that is not there, and art without meta lets a
          // body draw through the neighbour's roof).
          const occIdx = row * this.world.width + col;
          const occCut = mask ? (cuts ? cuts.get(occIdx) : top) : undefined;
          const dk = occCut !== undefined ? undefined : this.deckIndex.get(occIdx);
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
                  this.tagOccluder(this.add.image(bx0, by0 - lvl * lh, dFace).setOrigin(0, 0).setDepth(dDepth), col, row),
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
                    col, row,
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
          // The occluder copy must draw exactly what the ground RT drew, or
          // the difference comes back as a sprite at sprite depth: draw taller
          // here and the battlement the RT no longer has reappears above the
          // cut. Same per-cell constraint as the RT — a CONSTRAINED column is
          // truncated at its own cut, an unconstrained one is whole. `topL <
          // cell.l` means the column was cut, and the surviving top is a FACE
          // tile — the baked top diamond is the outdoor grass/rock surface and
          // would read as a lid on a wall stump.
          const topL = occCut !== undefined ? Math.min(cell.l, occCut) : cell.l;
          if (topL < 0) continue;
          // Draw only the EXPOSED cliff faces (from the lowest front neighbour
          // up). The ground RT already bakes every cell's full face stack with
          // the lower front cells drawn OVER it; redrawing the covered lower
          // faces here — on top of the RT at a high depth — re-exposed them,
          // painting the front cell's ground back into a wall (the "half-tile"
          // terrace tear). stackFrom = one above the lower of the E/S fronts.
          // INDOORS the front neighbours' cover is their DRAWN height, not the
          // terrain's: per-cell cuts mean a raised wall can stand behind an
          // unraised one whose real column is far taller than what is painted
          // (the corner where the far run meets the capped near run), and
          // trusting the real level there skips faces the RT plainly shows —
          // an occluder hole a body behind the wall would draw straight
          // through. An UNCONSTRAINED neighbour draws whole and covers with
          // its real level, exactly as stackFrom assumes outdoors.
          const cutL = (c: number, r: number): number => {
            const n = this.world?.rows[r]?.[c];
            if (!n) return -1;
            const e = cuts ? cuts.get(r * (this.world?.width ?? 0) + c) : top;
            return e === undefined ? n.l : Math.min(n.l, e);
          };
          const from = mask
            ? Math.max(0, Math.min(topL, Math.min(cutL(col + 1, row), cutL(col, row + 1)) + 1))
            : this.stackFrom(col, row, topL, false);
          for (let lvl = from; lvl < topL; lvl++) {
            if (!shows(bx, by - lvl * lh)) {
              culled++;
              continue;
            }
            this.occluders.push(
              this.tagOccluder(this.add.image(bx, by - lvl * lh, fk).setOrigin(0, 0).setDepth(oDepth), col, row),
            );
          }
          // Keep the top whenever the COLUMN reaches the cull box, so every
          // meta record in range still has drawn art behind it (see
          // columnShows).
          if (columnShows(bx, by - topL * lh, by + tileSize))
            this.occluders.push(
              // Occluder images CAN flip directly (setFlipX) — matches the RT's
              // mirrored top so the two layers stay pixel-aligned for flipped cells.
              this.tagOccluder(
                this.add
                  .image(bx, by - topL * lh, topL === cell.l ? topKey : fk)
                  .setOrigin(0, 0)
                  .setFlipX(topL === cell.l && !!cell.flip)
                  .setDepth(oDepth),
                col,
                row,
              ),
            );
          else culled++;
          this.occluderMeta.push({
            col,
            row,
            top: topL, // maps2 terrain is all standable ground: visual top = level
            solid: false,
            depth: oDepth,
            x0: bx,
            x1: bx + tileSize,
            y0: by - topL * lh,
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
            bx: bx + tileSize / 2,
            by: by + this.geom.margin + dy - cell.l * lh, // the tread's diamond centre
            pd: oDepth,
          });
          this.makeFogSilhouette(this.litOccluders[this.litOccluders.length - 1]);
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

    // The occluder + prop images have just been destroyed and recreated, so
    // this is the one moment their broad-phase index (and every cover slot's
    // "did the terrain move" signature term) can go stale.
    this.rebuildCoverIndex();
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

    const { dx, dy, lh, tile: tileSize } = this.geom;
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
    // INDOORS a prop outside my room is DRAWN like the ground it stands on —
    // it renders below the multiply overlay, so zero ambient blacks it out for
    // free and a torch through the doorway finds it. Its GLOW STAMP is another
    // matter: that is a light source, additive into the glow field, and a
    // glowing mushroom out on the grass would be the one thing lighting the
    // world you shut the door on. Art drawn, light suppressed — the same split
    // the bonfire gets. (Measured on the shipped worlds: 3 props, all deep in
    // the_island2's caves, can reach a room interior at all; none near a house.)
    const mask = this.indoorInside ? this.indoorMask : null;
    const top = this.indoorTop;
    for (const p of props) {
      // ROOM MEMBERSHIP FOR A PROP IS ROOF ∪ WALL, not roof alone. A prop
      // BLOCKS its own cell in the terrain grid, so the room flood-fill can
      // never put that cell in `roof` ("could the player stand here") — it
      // lands in the shell. Gating on IN_ROOF alone therefore classified every
      // emissive prop as "outside my room" the moment you stepped indoors,
      // including the bonfire burning in the middle of the room you are
      // standing in (maintainer 2026-08-12, screenshot: a pitch-black room
      // around a lit fire). The LIGHT filter's mask has always been floor ∪
      // shell for exactly this reason ("a torch mounted ON the wall of my room
      // lights it") — the stamp gate now matches it. A glowing mushroom out on
      // the grass is neither roof nor wall and stays suppressed.
      const propIdx = p.row * this.world.width + p.col;
      const propOut =
        (!!mask && !((mask.get(propIdx) ?? 0) & (IN_ROOF | IN_WALL))) ||
        // A SEALED-ROOM fire's stamps are indoor-only too: its high halos
        // paint at the prop's screen position, which from OUTSIDE is the
        // house's ROOF — an orange blob glowing on the shingles (the other
        // half of the maintainer's bleed-through screenshot). Same gate as
        // the light: visible only while I am in its room. rebuildProps
        // re-runs on the indoor commit, so door crossings stay fresh.
        (this.sealedEmissiveCells.has(propIdx) && !(this.roomMask && this.inMyRoom(p.col, p.row)));
      const cell = this.world.rows[p.row]?.[p.col];
      const key = pathTileKey(p.path);
      if (!this.textures.exists(key)) continue;
      // Indoors a prop on a CONSTRAINED column rides its truncated stump
      // instead of hanging where the vanished hilltop used to be; on an
      // unconstrained column (the neighbour's garden) it stands at full
      // height like the ground it grows from. Its own art is never shortened
      // — it is one object, like a tree, and the occluder pass agrees.
      let lvl = cell?.l ?? 0;
      if (mask) {
        const e = this.indoorCut ? this.indoorCut.get(propIdx) : top;
        if (e !== undefined) lvl = Math.min(lvl, e);
      }
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
      const srcs = this.night && !propOut ? this.tiles2Src[p.path] : undefined;
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
          // Tagged with its source: while this source holds a REAL light slot
          // the pool is filtered out per frame (the light replaces it) and it
          // returns the moment the slot is lost — the overflow fallback.
          srcId: `${p.col},${p.row}`,
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
    const { dx, dy, lh } = this.geom;
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
  /** Resolve every emissive prop in the world into a REAL-light candidate,
   * once per world. Until 2026-08-12 an emissive tile only ever produced an
   * additive glow stamp — a sticker over the darkened frame, no attenuation,
   * no LOS, no elevation ("why can't the bonfire tile look like the campfire
   * object? SAME PLACE, SAME NIGHT" — maintainer). The shader's real-light
   * path (including the never-wired negative-radius glow pool) was built for
   * exactly this; what was missing is this list and the per-frame pick.
   *
   * Params come from emission.json's optional `lights` block (tile-path stem
   * beats material name; explicit null = stamp-only opt-out). Absent, a
   * SUBTLE default is derived from the data that already ships: the same
   * strength-weighted source colour the pool stamp uses, radius a little
   * past the stamp's, flicker from the material's anim. The bonfire tile's
   * entry pins the campfire object's exact numbers — that parity is the
   * whole point — while a glowing flower stays a quiet pool. */
  private buildEmissiveSources() {
    this.emissiveSources = [];
    this.sealedEmissiveCells.clear();
    this.slotTenure.clear(); // a fresh world starts with no held slots
    if (!this.world?.props?.length) return;
    const stem = (p: string) => p.replace(/\.(png|webp)$/, "");
    for (const p of this.world.props) {
      const srcs = this.tiles2Src[p.path];
      if (!srcs?.length) continue;
      const mat = p.path.split("/")[1];
      const cfg = this.tiles2Lights[stem(p.path)] !== undefined
        ? this.tiles2Lights[stem(p.path)]
        : this.tiles2Lights[mat];
      if (cfg === null) continue; // tiles2 said: stamp only
      const em = this.tiles2Mat[mat];
      // Same colour derivation as the pool stamp — the ground must glow in
      // the colour the art actually emits, not the material's average hue.
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
      const lvl = this.world.rows[p.row]?.[p.col]?.l ?? 0;
      const pj = this.project((p.col + 0.5) * CELL_WU, (p.row + 0.5) * CELL_WU);
      // CAMPFIRE-ANCHORED intensity (round 5, the maintainer's night on
      // glow_test: "IT'S FILLED WITH LIGHT SOURCES — HOW CAN THIS MAP STILL
      // BE DARK?… a tile light source should aim to look as bright and lit
      // up as the good old campfire"). Two earlier deriveds (avgS*0.9, then
      // *1.3) produced peak channels of ~0.2-0.5 against the campfire's 1.9
      // OVERBRIGHT at twice the radius — a 4-10x intensity gap; eight of
      // those cannot light a night, and that is the whole answer to "why
      // isn't 8 point lights making the night bright". The anchor: take the
      // art's HUE (normalized so its strongest channel is 1) and give it
      // CAMPFIRE-CLASS punch scaled by the art's own strength — a blazing
      // source reaches the campfire's 1.9 peak, a faint one still lands at
      // ~45% of it, and radius grows with strength toward the campfire's 7.
      // "Some objects will be way brighter and some less" — the s values in
      // emission.json are that dial, and tiles2's curated `lights` entries
      // can still override either way.
      const peak = Math.max(glowColor[0], glowColor[1], glowColor[2], 0.001);
      const inten = 1.9 * Math.min(1, Math.max(0.45, avgS * 1.15));
      // SEALED-ROOM test: the prop's own cell is blocked (never in a room's
      // roof set), so ask the 4-neighbours — the floor around a fire in a
      // room IS the room. A fire under a bridge stays unsealed (a bridge is
      // not a room by the indoor verdict), so it still lights the night.
      let sealed = false;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nc = p.col + dc;
        const nr = p.row + dr;
        const nl = this.world.rows[nr]?.[nc]?.l ?? lvl;
        if (this.roomVerdictAt(nc, nr, nl)) {
          sealed = true;
          break;
        }
      }
      this.emissiveSources.push({
        id: `${p.col},${p.row}`,
        col: p.col + 0.5,
        row: p.row + 0.5,
        z: lvl + (cfg?.z ?? 0.5),
        radius: Math.max(1, cfg?.radius ?? Math.min(7, 4 + avgS * 4)),
        color:
          cfg?.color ??
          [(glowColor[0] / peak) * inten, (glowColor[1] / peak) * inten, (glowColor[2] / peak) * inten],
        flicker: cfg?.flicker ?? (em?.anim === "flicker" ? 0.5 : em?.anim === "pulse" ? 0.15 : 0),
        // Derived defaults are SHADOW-FREE GLOW POOLS (negative radius) — the
        // path built for tile emission. Two reasons, both from the maintainer's
        // first night with the ledger: a prop occludes ITS OWN CELL in the
        // heightmap, so a shadowed light at z 0.5 is eaten by its own prop
        // before it reaches the body standing beside it (the ground survives
        // on the march's bounce floor — which is exactly why "the surrounding
        // is lit up more than the player"); and a decorative glow has no
        // business casting hard LOS geometry anyway. Curated entries (the
        // bonfire) opt back into shadows and must place their z ABOVE the
        // prop's +1 occluder.
        shadows: cfg?.shadows ?? false,
        sx: pj.x,
        sy: pj.y,
        sealed,
      });
      if (sealed) this.sealedEmissiveCells.add(p.row * this.world.width + p.col);
    }
  }

  /** Fill the WORLD light slots for this frame: the campfire scenery + every
   * emissive source whose pool can touch the view, closest to the camera
   * first, at most WORLD_LIGHT_SLOTS of them (the QA probe light consumes one
   * when set, so the total can never exceed MAX_SHADER_LIGHTS). The
   * reservation is STRICT — empty torch/ambient/fx slots are never lent out,
   * because a loan would mean a world light pops the moment the torch is
   * struck. Losers keep their glow stamp (the old system IS the overflow
   * fallback), so an over-budget spot degrades to exactly yesterday's look. */
  private pickWorldLights(sl: ShaderLight[], fireLit: boolean, dtMs: number) {
    const room = Math.max(0, WORLD_LIGHT_SLOTS - (this.probeLight ? 1 : 0));
    const cam = this.cameras.main;
    const wv = cam.worldView;
    const cx = cam.midPoint.x;
    const cy = cam.midPoint.y;
    type Cand = { key: string; dist: number; edge: number; l: ShaderLight };
    const cands = new Map<string, Cand>();
    // How far OUTSIDE the view rect a pool's reach ends: negative while the
    // pool can touch the screen. Enter and exit use DIFFERENT margins (space
    // hysteresis): a light comes alive just before its pool scrolls on, but a
    // HELD one is only released once it is comfortably past — a pool sitting
    // exactly on the boundary must not flicker candidacy.
    const edgeOf = (sx: number, sy: number, reach: number) =>
      Math.max(wv.x - (sx + reach), sx - reach - wv.right, wv.y - (sy + reach), sy - reach - wv.bottom);
    if (fireLit && this.campfire) {
      const c = this.campfire;
      const reach = 7 * this.geom.dx;
      const edge = edgeOf(c.x, c.y, reach);
      if (edge < LIGHT_EXIT_PX)
        cands.set("campfire", {
          key: "campfire",
          dist: Math.hypot(c.x - cx, c.y - cy),
          edge,
          l: { col: c.col, row: c.row, z: c.z, radius: 7, color: [1.9, 0.88, 0.3], flicker: 1 },
        });
    }
    for (const s of this.emissiveSources) {
      // A pool reaches radius*dx px past its anchor — the light must be LIVE
      // before its source scrolls on, or pools visibly pop at the screen edge.
      const reach = s.radius * this.geom.dx + 128;
      const edge = edgeOf(s.sx, s.sy, reach);
      if (edge >= LIGHT_EXIT_PX) continue;
      // A SEALED-ROOM fire is indoor-only: lit exactly to the degree I am in
      // its room, invisible from outside. Without this, the LOS march's 0.22
      // bounce floor let 22% of the indoor bonfire pour through the house
      // walls at night (maintainer 2026-08-12: "I'm outside of the house and
      // I can clearly see there is a light source inside bleeding through").
      // Scaled by the GRADE — the same ramp the room's ambient rides — so
      // walking out fades the fire with the room instead of popping it.
      let gain = 1;
      if (s.sealed) {
        if (!(this.roomMask && this.inMyRoom(s.col, s.row))) continue;
        gain = this.indoorGrade();
        if (gain <= 0.01) continue;
      }
      cands.set(s.id, {
        key: s.id,
        dist: Math.hypot(s.sx - cx, s.sy - cy),
        edge,
        l: {
          col: s.col,
          row: s.row,
          z: s.z,
          // Sign of radius: negative = the shader's shadow-free glow pool.
          radius: s.shadows ? s.radius : -s.radius,
          color: gain === 1 ? s.color : [s.color[0] * gain, s.color[1] * gain, s.color[2] * gain],
          flicker: s.flicker,
        },
      });
    }
    // TENURE, not a per-frame ranking (maintainer 2026-08-12, running across
    // glow_test: "a lot of light sources pop in and out inside the view…
    // maintain a light for as long as it's still impacting the game view
    // before you free up its slot"). Re-ranking by distance every frame means
    // slots change hands while BOTH fires are mid-screen — the loser snaps to
    // stamp-look, the winner snaps to full light, a visible pop each handover.
    // So: a HOLDER keeps its slot until its pool stops touching the view (or
    // its candidacy dies — sealed rooms fade themselves out first via `gain`).
    // Newcomers take only genuinely FREE slots, nearest first, and RAMP in
    // over LIGHT_RAMP_MS while their pool stamp crossfades out — an
    // over-budget map degrades to "some fires are stamp-only while visible",
    // which is a look, never an event.
    // Release: a holder leaves tenure only when its pool is a full
    // LIGHT_EXIT_PX beyond touching the view (it fell out of `cands`), or its
    // candidacy died (sealed room left — which faded itself to zero via
    // `gain` first), or its RETIREMENT dissolve below reached zero.
    // Acquisition requires edge < 0 (actually touching), so entry is strictly
    // TIGHTER than release: a boundary hoverer can neither flicker in nor out.
    for (const [key, t] of this.slotTenure) {
      if (!cands.has(key) || (t.dir < 0 && t.ramp <= 0)) this.slotTenure.delete(key);
    }
    // Probe shrinks the room (QA): evict the farthest holders to fit.
    while (this.slotTenure.size > room) {
      let worst: string | null = null;
      let worstDist = -1;
      for (const key of this.slotTenure.keys()) {
        const d = cands.get(key)?.dist ?? Infinity;
        if (d > worstDist) {
          worstDist = d;
          worst = key;
        }
      }
      if (worst === null) break;
      this.slotTenure.delete(worst);
    }
    // GRACEFUL RETIREMENT (round 4, maintainer 2026-08-12: "are you holding a
    // slot too long to fulfil never-pop, making it impossible for new scenes
    // to show real spot-lights?"). Hold-until-exit alone biases the slots
    // toward the TRAILING half of a run — the scene you are running INTO
    // stays stamp-only while lights you are leaving hog their slots. So under
    // pressure a clearly-outranked holder is DISSOLVED out: the same 450ms
    // crossfade an acquisition uses, in reverse — light down, pool stamp back
    // up — then its slot frees for the front. Rules that keep it calm: only
    // fully-faded-in holders retire (a mid-fade flip would wobble), a waiting
    // candidate must beat the holder by LIGHT_STEAL_MARGIN (hysteresis — the
    // pair can't ping-pong), and at most LIGHT_RETIRE_MAX dissolves run at
    // once, so heavy pressure reads as fires breathing one by one, never a
    // wave. NOTHING here snaps: this trades "held too long" for a second
    // dissolve, not for the pop the tenure rule exists to prevent.
    const waiting = [...cands.values()]
      .filter((c) => c.edge < 0 && !this.slotTenure.has(c.key))
      .sort((a, b) => a.dist - b.dist);
    let retiring = 0;
    for (const t of this.slotTenure.values()) if (t.dir < 0) retiring++;
    if (waiting.length && this.slotTenure.size >= room) {
      let wi = 0;
      while (retiring < LIGHT_RETIRE_MAX && wi < waiting.length) {
        // The worst SETTLED holder (full ramp, not already retiring).
        let worst: string | null = null;
        let worstDist = -1;
        for (const [key, t] of this.slotTenure) {
          if (t.dir < 0 || t.ramp < 1) continue;
          const d = cands.get(key)?.dist ?? Infinity;
          if (d > worstDist) {
            worstDist = d;
            worst = key;
          }
        }
        if (worst === null || waiting[wi].dist + LIGHT_STEAL_MARGIN >= worstDist) break;
        this.slotTenure.get(worst)!.dir = -1;
        retiring++;
        wi++;
      }
    }
    // Free slots go to the nearest unslotted candidates. Most acquisitions
    // happen as a pool ENTERS the view (edge ≈ 0) where the ramp is invisible;
    // a mid-view acquisition (a slot freed while a fire is centre screen)
    // fades in instead of popping on.
    if (this.slotTenure.size < room) {
      for (const c of waiting) {
        if (this.slotTenure.size >= room) break;
        this.slotTenure.set(c.key, { ramp: 0, dir: 1 });
      }
    }
    // QA: the fairness numbers the tenure gate asserts on — captured AFTER
    // this frame's decisions, or a sample can show "pressure, nothing
    // retiring" for a retirement that started the same frame.
    {
      let worstSettled = -1;
      for (const [key, t] of this.slotTenure) {
        if (t.dir < 0 || t.ramp < 1) continue;
        worstSettled = Math.max(worstSettled, cands.get(key)?.dist ?? -1);
      }
      const stillWaiting = waiting.filter((c) => !this.slotTenure.has(c.key));
      this.lastTenureStats = {
        waitingBest: stillWaiting.length ? Math.round(stillWaiting[0].dist) : null,
        worstSettled: worstSettled < 0 ? null : Math.round(worstSettled),
        retiring: [...this.slotTenure.entries()].filter(([, t]) => t.dir < 0).map(([k]) => k),
      };
    }
    this.lightOverflow = Math.max(0, cands.size - this.slotTenure.size);
    this.slotLit.clear();
    // STABLE PUSH ORDER: the shader's flicker phase is derived from the SLOT
    // INDEX (uAnimTime*2.9 + i*5.3), not from the light itself — a shuffled
    // order re-phases every flame. Tenure keys, sorted, are stable while the
    // held set is.
    const held = [...this.slotTenure.keys()].sort();
    this.slotEdges = {};
    for (const key of held) {
      const c = cands.get(key);
      const t = this.slotTenure.get(key)!;
      if (!c) continue;
      this.slotEdges[key] = Math.round(c.edge);
      t.ramp = Math.max(0, Math.min(1, t.ramp + (t.dir * dtMs) / LIGHT_RAMP_MS));
      const k = t.ramp * t.ramp * (3 - 2 * t.ramp); // smoothstep — no snap at either end
      if (sl.length >= MAX_SHADER_LIGHTS) break;
      sl.push(
        k >= 1
          ? c.l
          : { ...c.l, color: [c.l.color[0] * k, c.l.color[1] * k, c.l.color[2] * k] },
      );
      this.slotLit.add(key);
    }
  }

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
    const depth = p.y + lvl * this.geom.lh + 0.4;
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
    return { x: f.x, y: f.y - f.lvl * this.geom.lh };
  }

  /** Iso projection split into the FLAT (unlifted) ground point and the cell's
   * elevation level, so the renderer can animate the lift (fall under gravity)
   * separately from the horizontal walk. Flat x/y are continuous in (px,py);
   * only `lvl` steps at cell boundaries. */
  private projectFlat(px: number, py: number): { x: number; y: number; lvl: number } {
    if (!this.world) return { x: px, y: py, lvl: 0 };
    const { dx, dy, tile } = this.geom;
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
    const s = integrateFall({ elev: av.elev, fallV: av.fallV, falling: av.falling }, target, dt, this.geom.lh);
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
