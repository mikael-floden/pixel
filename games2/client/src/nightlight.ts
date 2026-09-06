import Phaser from "phaser";
import { surfaceFor, CHARACTER_BODY_PX } from "@nangijala/shared";
import type { SceneryFootprints } from "@nangijala/shared";
import { World, MAP_GEOMETRY, geometryFor } from "./maps";
import { renderedWorldView, ViewRect } from "./camview";

/**
 * Serious night lighting: a fullscreen MULTIPLY shader that reconstructs each
 * pixel's WORLD position (cell + height) from the tile geometry, then for every
 * point light computes distance attenuation (in cell units ≈ meters) and
 * LINE-OF-SIGHT by raymarching the world heightmap — walls cast real shadows.
 * Several lights blend; fire-type lights flicker. The scene is multiplied by
 * ambient + Σ light contributions, so unlit areas sink into the night grade
 * and lit areas keep their true colours.
 *
 * Pixel → world reconstruction: for candidate level L (top→down), invert
 *   y = oy + (col+row)·dy − L·lh,  x = ox + (col−row)·dx
 * and accept the highest L whose heightmap cell is at least that tall (side
 * faces resolve to the wall's cell at the assumed height).
 */

export interface ShaderLight {
  col: number; // grid coords (fractional ok)
  row: number;
  z: number; // height in levels
  radius: number; // in cells; NEGATIVE = shadow-free GLOW pool (tile emission)
  color: [number, number, number];
  flicker: number; // 0 = steady, 1 = full fire flicker
}

/** One glowing pixel cluster inside a tile variant (tile-emission@2). */
export interface EmissionSource {
  x: number; // cluster centroid, tile-image px
  y: number;
  r: number; // cluster radius, px
  color: [number, number, number]; // the cluster's OWN colour
  s: number; // 0..1 strength
  dir: "up" | "sw" | "se"; // top diamond / left face / right face
}

/** One entry of tiles/emission.json — a tile category that glows by itself. */
export interface EmissionEntry {
  color: [number, number, number]; // 0..1, measured from the art
  strength: number; // 0..1 — intensity of the light POOL around the tile
  radius: number; // pool size in cells
  anim: "static" | "flicker" | "pulse";
  self: number; // 0..1 — how much the tile's OWN pixels resist darkness
  sources?: Record<string, EmissionSource[]>; // per variant ("0".."15")
  variants?: number; // total variant count (sourceless ones included)
}
export type EmissionMap = Record<string, EmissionEntry | null>;

/** A glow-halo stamp in WORLD px — one per visible emission source instance.
 * Stamped into a world-anchored RenderTexture each frame; the night shader
 * ADDS the sampled halo to the light field, so glow is perfectly localized
 * (a mushroom lights its patch, the forest stays dark) and needs no light
 * slots — a world full of light sources costs sprite draws, not uniforms. */
export interface GlowStamp {
  x: number; // world px (halo centre)
  y: number;
  radius: number; // halo radius, world px (horizontal semi-axis)
  ry?: number; // vertical semi-axis — emission POOLS are circles in grid
  // space, which the iso projection maps to a flat screen ellipse (dy/dx);
  // per-pixel halos stay round (ry omitted).
  color: [number, number, number];
  alpha: number; // 0..1 peak intensity
  anim: number; // 0 static, 1 pulse, 2 flicker
  phase: number; // per-source hash phase
  // Whether this stamp may tint a CHARACTER's lit copy (lightAt). Ground-level
  // pools set true; halos stamped HIGH on tall prop art set FALSE — a high
  // halo sampled at the character's FEET is a 2D screen distance that peaks at
  // an offset and dims when you stand under it (the "brighter then darker as I
  // approach" bug). Undefined = eligible (legacy/terrain stamps, near-ground).
  litChar?: boolean;
  // The emissive source ("col,row") this stamp belongs to. A source holding a
  // REAL light slot has its ground POOL filtered out for the frame (the light
  // replaces it — keeping both double-brightens the ground AND the characters,
  // since curLights and curStamps both feed lightAt); its high halos stay, they
  // are the art's own bloom, the campfire's flame-core equivalent.
  srcId?: string;
}

export const MAX_SHADER_LIGHTS = 12;

/** lightAt's BREAKDOWN for the scenery-lit pipeline (scenerylit.ts), which
 *  adds the point lights per texel and needs everything else at the foot:
 *  `base` = ambient·sun·cloud + aurora, AO'd, plus the glow stamps — the
 *  copy's flat tint minus the point lights; `occ[i]` = light i's LOS occlusion
 *  at the foot (1 = clear; the pipeline carries the first 8); `ao` = the
 *  ground AO factor; `sunF` = the sun factor alone (no cloud), so the pipeline
 *  can re-weight the sun share by the volume's Lambert. Filled in place. */
export interface LightParts {
  base: [number, number, number];
  occ: Float32Array;
  ao: number;
  sunF: number;
}

/* SCENERY OCCLUDER SIZING — see NightLights.setSceneryOccluders. */
/** Trunk bump ceiling, levels. The LOS ramp saturates 0.67 level over the ray,
 *  so 2 already reads as a full shadow; 3 is headroom for a torch held a step up. */
const SCN_TRUNK_MAX = 3;
/** A piece's OWN shares are removed from its lit-copy tint within this radius
 *  (cells): its trunk cell is ≤0.7 from its anchor and the bilinear skirt adds 1. */
const SCN_EXCL_R = 1.8;
/** The trunk CORE's radius (cells) for the own-cell directional shade: a pixel
 *  inside a piece's share cell is shaded by its own trunk only where the ray to
 *  the light (or the sun) passes through this core between them. */
const SCN_CORE = 0.45;
/** The CONTACT blob under a piece: radius (cells) and strength for the sun
 *  patch (a `m` share) and the torch march (an occ factor). Every direction —
 *  the ground beside and in front of a post read as bright spots against the
 *  skirt-shaded ground around it (maintainer, 2026-09-06). */
const SCN_CONTACT_R = 0.75;
const SCN_CONTACT_SUN = 0.7;
const SCN_CONTACT_TORCH = 0.5;
/** A SCENERY PIECE SHADOWS HARD under a point light (maintainer 2026-09-07:
 *  every light must make scenery cast shadows the way the bonfire does). A
 *  one-cell piece intercepts one or two march samples; at the wall chain's
 *  0.8 per sample that was a 10-16% dip behind a waystone under a
 *  streetlight (measured) — invisible in a half-strength pool, only the
 *  bonfire's overbright pool made it read. Samples on a scenery share take
 *  these factors instead (grazing → deep); walls keep 0.8→0.45. */
const SCN_SHADOW_NEAR = 0.55;
const SCN_SHADOW_DEEP = 0.3;
/** DON'T MARCH A SHADOW NOBODY CAN SEE — the threshold is on the light's OWN
 *  CONTRIBUTION (att × its peak channel), not on att, because a campfire at
 *  1.9 and a lamp at 0.5 reach this point at different distances. A shadow can
 *  remove at most 78% of that contribution (the march's 0.22 bounce floor), so
 *  below 0.012 the deepest possible shadow is worth 0.009 luma — under 3/255,
 *  invisible. It matters now that the manifest publishes radius-11
 *  streetlights (the cap came off on the maintainer's word, 2026-09-07): a
 *  radius-11 pool is wider than the phone's viewport, so without this every
 *  fragment on screen marches every light in it. Saves the outer 8-12% of each
 *  radius, which is 15-21% of its area and of its marched fragments.
 *  (NOT 0.06 on att alone — that was the first cut and it can hide 0.09 luma
 *  of a bright light's shadow, half the night's ambient.) MEASURED at the
 *  town's radius-11 lamp (peak 1.14, skip radius 9.87): the luma profile along
 *  the light's ray has NO step there — its largest step, 0.627, sits at 3.0
 *  cells and is a shadow edge. */
const SHADOW_MARCH_MIN_LIGHT = 0.012;
/** The glow field's resolution divisor — see where glowRT is built. */
const GLOW_FIELD_DIV = 2;
/** GLSL smoothstep, for the CPU twins of shader terms (e0 > e1 allowed, as in GLSL). */
function smoothStep01(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
/** Chebyshev radius (cells) of the sun patch's sparse gate around a share cell. */
const SCN_GATE_R = 4;
/** A scenery lit copy's LOS occlusion is marched for every light within its
 *  radius grown by this (cells): the crown's near edge can be lit by a light
 *  that is out of range at the foot, and it must carry a real occlusion. */
const SCN_CROWN_REACH = 2.5;

/** Per-channel emission animation — the "alive" waveform shared by every
 * emission layer (shader self-floor, glow stamps, lit-copy tints). Returns
 * [r,g,b] factors around 1. The GLSL block in FRAG mirrors this EXACTLY
 * (same constants, same shapes) — change BOTH or the floors, halos and lit
 * copies drift out of sync.
 *
 * flicker: an ever-present shimmer under a slow ~37s "gust" envelope
 *   (restless then calmer, but never fully still), a rare short surge when
 *   two slow sines align, and warm colour coupling — dimmer reads deep red,
 *   brighter reads yellow-white, like real embers.
 * pulse: three incommensurate slow sines (≈6s/15s/57s) breathing between
 *   ~0.64 and ~1.08, plus a very slow ±3% red↔blue hue drift.
 * static: near-steady with a soft occasional glint (gold catching light).
 * All terms are phase-decorrelated per cell/source. NB: the shader animation
 * clock is uAnimTime (NOT `time` — Phaser reserves `time` and overwrites it
 * every frame with the frame delta, which froze all shader animation). */
export function emissionWave(anim: number, t: number, ph: number): [number, number, number] {
  if (anim >= 2) {
    // Envelope floor kept high (0.45) so the shimmer is ALWAYS present — a
    // low floor let the gust damp flicker to invisibility between gusts.
    const env = 0.72 + 0.28 * Math.sin(t * 0.17 + ph * 3.1);
    let f =
      1 -
      env * (0.15 * (0.5 + 0.5 * Math.sin(t * 3.1 + ph)) + 0.07 * Math.sin(t * 8.3 + ph * 1.7)) -
      0.06 * Math.sin(t * 0.71 + ph * 1.3);
    f += (0.2 * Math.max(0, Math.sin(t * 0.41 + ph) * Math.sin(t * 0.67 + ph * 1.7) - 0.86)) / 0.14;
    const warm = f - 1;
    return [f, f * (1 + 0.35 * warm), f * (1 + 0.6 * warm)];
  }
  if (anim >= 1) {
    const f =
      0.86 +
      0.13 * Math.sin(t * 1.1 + ph) +
      0.06 * Math.sin(t * 0.43 + ph * 1.9) +
      0.03 * Math.sin(t * 0.11 + ph * 0.7);
    // Slight warm<->cool drift. Kept small (±3%): the dominant channel of a
    // saturated emitter is pinned at the 1.0 ceiling, so a bigger swing only
    // lifts the OTHER channels and erodes the tile's colour identity (crystal
    // stops reading blue — verify-emission's hue-dominance gate).
    const w = Math.sin(t * 0.23 + ph * 2.3);
    return [f * (1 + 0.03 * w), f, f * (1 - 0.03 * w)];
  }
  let f = 0.98 + 0.02 * Math.sin(t * 0.31 + ph);
  f += (0.12 * Math.max(0, Math.sin(t * 0.29 + ph * 2.1) * Math.sin(t * 0.53 + ph * 0.8) - 0.93)) / 0.07;
  return [f, f, f];
}

/** Multiplicative "self pulse" for an emitter's OWN pixels. emissionWave
 * modulates the FLOOR and the additive spill, but at the emitter's centre the
 * floor + its own halo saturate against the brightness clamp, so that wave gets
 * clipped there — the tile looks static while only the spill onto neighbours
 * moves (playtester). This factor is applied to the emissive cell's final light
 * BEFORE the clamp (and to solid billboards' lit-copy tint), so the tile dims
 * below saturation and visibly breathes. Peaks at 1.0 (never brighter than the
 * steady look), dips per anim. Flicker dips deep & fast (fire); pulse is a calm
 * ~4.6s breath; even 'static' gets a gentle ~11s life so nothing is truly dead.
 * Mirrored EXACTLY by emSelfPulse() in FRAG — change BOTH. */
export function emissionSelfPulse(anim: number, t: number, ph: number): number {
  // An ever-present quick twinkle on EVERY emitter so nothing ever reads as
  // frozen (light catching a facet / an ember breathing), on top of each
  // anim's characteristic motion. Pulse/static were slow enough (~5-11s) to
  // look dead at a glance — sped up here too.
  const tw = 0.08 * Math.sin(t * 2.3 + ph * 1.7);
  if (anim >= 2) {
    const env = 0.7 + 0.3 * Math.sin(t * 0.17 + ph * 3.1);
    const d =
      env * (0.3 * (0.5 + 0.5 * Math.sin(t * 3.3 + ph)) + 0.13 * Math.sin(t * 8.3 + ph * 1.7)) +
      0.07 * (0.5 + 0.5 * Math.sin(t * 0.71 + ph * 1.3));
    return Math.max(0.42, Math.min(1, 1 - d + tw));
  }
  if (anim >= 1) return Math.max(0.42, Math.min(1, 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 1.9 + ph)) + tw));
  return Math.max(0.5, Math.min(1, 0.66 + 0.34 * (0.5 + 0.5 * Math.sin(t * 1.2 + ph)) + tw));
}

const FRAG = `
precision highp float;

uniform vec2 resolution;
uniform float uAnimTime;
uniform vec4 uCam;        // worldView x, y, w, h (world-render px)
uniform vec4 uIsoA;       // ox, oy, dx, dy
uniform vec4 uIsoB;       // lh, gridW, gridH, maxLevel
uniform sampler2D uHBlock; // BLOCK×BLOCK block-max of uHeight.r (unbound sampler = unit 0!)
uniform vec2 uHBlockN;     // the block grid's size
uniform float uSkip;       // 1 = uHBlock is bound and the march may skip whole blocks
uniform float uHScale;    // levels→byte pack scale (per-world; 16 unless the world tops ~15 levels)
uniform vec3 uAmbient;    // night grade (what unlit white becomes)
uniform vec4 uSun;        // directional sun: cast dir (grid x,y), slope (levels/cell), strength
uniform float uCloud;     // weather: cloud cover 0..1 (world-anchored drifting shadow field)
uniform float uAurora;    // aurora night 0..1: northern-light curtains ADD colour to the ambient
uniform float uFlip;      // 1 = invert fragment y (GL bottom-up), 0 = direct
uniform float uTest;      // 1 = output a raw world-y gradient (calibration)
uniform float uShadowDbg; // 0 = normal, 1 = shadows OFF, 2 = shadows RED (settings switch)
uniform float uNumLights;
uniform vec4 uLightPos[${MAX_SHADER_LIGHTS}];  // col, row, z, radius(cells)
uniform vec4 uLightCol[${MAX_SHADER_LIGHTS}];  // r, g, b, flicker
uniform float uIndoor;   // 1 while the local player is indoors (see heightAt)
uniform float uIndoorTop; // the cut-away's top level while indoors (see heightAt)
uniform sampler2D uRoom;  // R: 128+cut where the cell is in MY room, 0 outside
                          // (roomAt tests the top half; heightAt reads the cut).
                          // G: depth from the nearest opening PLUS ONE (0 = not a room).
                          // B: the ceiling's UNDERSIDE level — the top of the opening.
uniform float uCaveK;     // depth falloff — 0 disables the effect entirely
uniform float uRoomOn;    // 1 when uRoom is bound (unbound sampler = unit 0!)
uniform float uIndoorMix; // the EASED indoor blend — the outside fades to black
uniform vec3 uAmbientOut; // the OUTDOOR grade — what a cell outside my room fades to
uniform sampler2D uHeight;
uniform sampler2D uHeightL; // occlusion heightmap, LINEAR-filtered (LOS march)
uniform sampler2D uHeightG; // GROUND column tops, LINEAR (see groundAtSoft)
uniform sampler2D uEmit;    // emission palette: 2 texels/entry (colour; params)
uniform float uEmitN;       // number of palette entries (0 = no emission)
uniform sampler2D uGlow;    // world-anchored glow-halo field (same window as uCam)
uniform float uGlowOn;      // 1 when the glow field is bound (unbound sampler = unit 0!)
uniform float uHasProps;    // 0 when the world places no props: the prop-shadow loop is a no-op then
uniform float uSceneryOn;   // 1 when scenery shares are stamped (maps3): own-cell skirt skip armed
uniform float uPropGate;    // 1 when the ground map's G flags the sun patch's reach (sparse prop loop)
uniform float uGlowFlip;    // render-target y orientation (calibrated numerically)

// Bilinear height for the LOS march ONLY: blockers ramp in over ~a cell, so
// cast-shadow edges get a natural penumbra instead of cell-quantized 1px
// cliffs. The surface resolve keeps exact nearest-cell reads (uHeight).
float heightAtSoft(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 99.0;
  return texture2D(uHeightL, cr / vec2(uIsoB.y, uIsoB.z)).r * 255.0 / uHScale;
}

// The prop share of the occlusion height (G of the same map).
float propAtSoft(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 0.0;
  return texture2D(uHeightL, cr / vec2(uIsoB.y, uIsoB.z)).g * 255.0 / uHScale;
}

// TERRAIN occlusion height (terrain/deck minus the prop share) in ONE bilinear
// read — the cast-shadow march's per-sample height, used by its edge multi-sample.
float terrHeightSoft(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 99.0;
  vec2 rg = texture2D(uHeightL, cr / vec2(uIsoB.y, uIsoB.z)).rg;
  return (rg.r - rg.g) * 255.0 / uHScale;
}

// BASE terrain level (B of the linear map): the real ground, NEVER a floating
// deck slab. Sampled at the texel centre so the bilinear filter returns the
// exact cell value. The AO seam term must see TERRAIN here — a bridge/roof
// span floating over open water/air is not a concave corner, and reading the
// deck-inflated surface height painted a static dark band on the ground in
// front of every span (maintainer: the underside line was the ground AO).
float baseTerrAt(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 99.0;
  vec2 uv = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  return texture2D(uHeightL, uv).b * 255.0 / uHScale;
}

// The GROUND COLUMN's own top (A of the linear map): terrain + its solid/prop
// bump, but NEVER a deck. Bilinear like heightAtSoft, because the LOS march
// wants the same soft blocker ramp.
//
// Why this channel has to exist: R is max(ground, deck), ONE number per column,
// and the marches test "is the column taller than the ray". That is only true
// of terrain, which really is solid from 0 to its top. A DECK IS A FLOATING
// SLAB — a roof at level 6 over a floor at 0 leaves 6 levels of open air you
// walk through — so R makes the shader treat every roof and bridge as a solid
// pillar standing on the ground beneath it. MEASURED cost of that on live: a
// torch under the_island2's pier lights the water at 0.221 one cell away where
// the same torch on open water five cells south reaches 0.585 (-62%), and a
// torch inside the house dies from 0.640 to 0.186 in one cell. The room was
// never dark because of the ambient; its own ceiling was eating the light.
float groundAtSoft(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 99.0;
  // Its own map, R channel. It used to be the linear map's ALPHA, which
  // premultiplied every other channel of that texture — see the pin in
  // buildHeightmap for what that cost.
  return texture2D(uHeightG, cr / vec2(uIsoB.y, uIsoB.z)).r * 255.0 / uHScale;
}

// The GROUND column's top, NEAREST-sampled — the twin of heightAt, and the
// answer to "is there anything solid here at all". A deck is a floating slab
// with open air beneath it, so this is what decides whether a pixel below a
// column's top is a WALL FACE or simply the view through a gap.
float groundAt(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 99.0;
  vec2 uv = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  return texture2D(uHeightG, uv).r * 255.0 / uHScale;
}

// SCENERY (maps3, setSceneryOccluders): the ground map's B carries a cell's
// SCENERY share of its column (levels, R's packing) and its G flags every
// cell within the sun patch's reach of any share. Both 0 on a tiles2 world.
float sceneryShareAt(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 0.0;
  vec2 uv = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  return texture2D(uHeightG, uv).b * 255.0 / uHScale;
}
float sceneryNearAt(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 0.0;
  vec2 uv = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  return texture2D(uHeightG, uv).g;
}
// groundAt WITHOUT the scenery share — the terrain + solid column, for the
// cave-mouth walk: a trunk bump on a cliff-top cell must not extend that
// column over the mouth below it (B is 0 for props: same bytes as groundAt).
float groundTerrAt(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 99.0;
  vec2 uv = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  vec3 v = texture2D(uHeightG, uv).rgb;
  return (v.r - v.b) * 255.0 / uHScale;
}

// The SURFACE height a screen pixel resolves to.
//
// INDOORS THIS MUST IGNORE DECKS. uHeight's R is max(terrain, deck), so every
// cell under a roof reports the ROOF's level — and indoor mode has just
// stopped drawing that roof, so the pixel on screen is the FLOOR while the map
// still says 6. The resolve puts the floor 6 levels up, and a point light's
// attenuation counts the VERTICAL gap
// (dist = sqrt(horizontal^2 + ((lp.z - z)*0.6)^2)), so the player's own torch
// at z 0.55 is treated as ~3.3 cells from the ground it stands on before any
// horizontal distance: att = (1 - 3.27/6)^2 = 0.21.
//
// MEASURED in one of maps2' houses at (215,121) — torch-only light at the
// player's OWN cell: 0.631 resolved at the true floor, 0.211 at the deck level
// the map reports. A third of the light, which is exactly the "yes I can see
// something very very dim happens if I toggle it on/off in-door" the
// maintainer reported (2026-08-07) while the same torch throws a wide pool
// outdoors.
//
// SAME CLASS AS THE FLOATING-SLAB FIX in the LOS march (groundAtSoft above):
// a roof removed from the RENDER still living in a height map. That one was
// the OCCLUSION map; this is the SURFACE map, and fixing one without the other
// left the light crippled by the half that was missed.
//
// THE CUT-AWAY MAKES IT TWO CLAMPS, NOT ONE. Indoors the renderer draws every
// column of the building TRUNCATED at uIndoorTop levels (WorldScene's
// indoorTop = ceiling - the Settings dial), so the drawn surface is neither the
// deck-inflated height NOR the wall's full terrain level: it is
// min(base terrain, the cut). Leaving the cut out re-creates the very bug
// above one level up — a wall the picture ends at level 3 would still resolve
// at 6, putting the floor behind it 3 levels (48px) from where it is drawn and
// crippling every torch that lights it. This is the SURFACE resolve only.
//
// THE OCCLUSION MARCH (heightAtSoft / groundAtSoft / uHeightL) IS DELIBERATELY
// NOT CLAMPED. The roof and the full wall are still physically there — the sun
// really is blocked by a building whose top half we are choosing not to paint,
// and a cut-away that let daylight in through its own missing roof would light
// the room from above as you turned the dial. So: what the camera SEES is
// truncated, what the light TRAVELS THROUGH is not. The asymmetry is the point.
// HOW DEEP INTO A ROOM THIS CELL SITS, in cells from the nearest opening.
// Green of the room mask; 0 outdoors and at every entrance.
// PER PIXEL, NOT PER TILE. The mask is NEAREST on purpose (its RED channel is
// room membership and a LINEAR fetch would bleed ambient half a cell through
// the walls), so the smoothing is done by hand here: four taps, bilinear
// weights. Nearest sampling gave four flat bands marching into the cave, which
// reads as steps of paint; the walker wants a gradient that thickens.
float caveUnderAt(vec2 cr) {
  if (uRoomOn < 0.5) return 0.0;
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 0.0;
  return texture2D(uRoom, (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z)).b * 255.0;
}

float caveDepthAt(vec2 cr) {
  if (uRoomOn < 0.5) return 0.0;
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 0.0;
  // THE SMOOTHING MUST NOT LEAK OUT OF THE ROOM. A bilinear tap next to the
  // opening pulls interior depth onto the OUTER rock face, which darkened the
  // whole mountain column (maintainer 2026-08-08: "you made the whole column
  // dark! I want the inside dark, not the outside"). Gate on this pixel's OWN
  // cell first: outside a room there is no darkening at all, and the four-tap
  // blend only ever softens the gradient WITHIN the interior.
  vec2 own = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  if (texture2D(uRoom, own).g <= 0.0) return 0.0;
  vec2 g = cr - 0.5;              // sample grid sits at texel centres
  vec2 f = fract(g);
  vec2 b = floor(g);
  vec2 sz = vec2(uIsoB.y, uIsoB.z);
  float d00 = texture2D(uRoom, (b + vec2(0.5, 0.5)) / sz).g;
  float d10 = texture2D(uRoom, (b + vec2(1.5, 0.5)) / sz).g;
  float d01 = texture2D(uRoom, (b + vec2(0.5, 1.5)) / sz).g;
  float d11 = texture2D(uRoom, (b + vec2(1.5, 1.5)) / sz).g;
  return mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y) * 255.0;
}

// WHICH CELL IS ACTUALLY DRAWN HERE, with the roof slabs taken out.
//
// This is the whole reason a correct mask darkened nothing. The surface march
// in main() stops at the first column whose top the ray meets, and heightAt is
// max(terrain, deck) - so a roofed cave cell is opaque for its FULL height and
// every pixel of an opening resolves to the first interior column, which is at
// BFS depth 0, which means "the mouth itself" and multiplies by exactly 1.0.
// Measured on the shipped build: 0 of 86,640 mouth pixels darkened, worst
// multiply 1.00000. The floor and the inward wall faces behind that column
// were never sampled at all, however the mask was built - which is why widening
// the mask kept moving the darkening onto the OUTSIDE rock (the near jambs are
// the only cells the surface march does resolve, and a house's outer wall is
// the same kind of cell, which is what turned every house black).
//
// The GROUND field has no decks in it, so the identical walk over groundAt
// lands on the cell whose art is painted at this pixel: measured, 92% of
// inward-wall pixels and 70% of floor pixels, carrying depths 1..8 instead of
// a flat 1.
//
// It is a SECOND, SEPARATE march on purpose. cell/z from the surface walk still
// drive every existing lighting rule - Lambert, shadows, AO, emission - so this
// cannot move a pixel that is not already under a ceiling. It runs only for
// pixels that pass the ceiling gate, which is a thin band of the screen.
vec2 groundCellAt(float u, float v0, float kk) {
  float vHi = v0 + uIsoB.w * kk;
  vec2 hit = vec2(-1.0);
  bool got = false;
  for (int s = 0; s < 128; s++) {
    if (got || vHi <= v0 - 1.5) break;
    float vColB = 2.0 * floor((vHi + u) * 0.5 - 0.0001) - u;
    float vRowB = 2.0 * floor((vHi - u) * 0.5 - 0.0001) + u;
    float vLo = max(vColB, vRowB);
    float vMid = (vHi + vLo) * 0.5;
    vec2 c2 = vec2((u + vMid) * 0.5, (vMid - u) * 0.5);
    float H = groundTerrAt(c2);
    if (H < 90.0 && v0 + H * kk >= vLo - 0.0001) { hit = c2; got = true; }
    vHi = vLo;
  }
  return hit;
}

float heightAt(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 99.0;
  vec2 uv = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  if (uIndoor > 0.5) {
    // With no room texture bound there is no per-cell data to read — fail to
    // the scalar cut, the legacy behaviour (same guard family as uRoomOn in
    // roomAt: a phone with the bind missing must not black out the room).
    if (uRoomOn < 0.5) return min(baseTerrAt(cr), uIndoorTop);
    // THE CONSTRAINED-SET RESOLVE (2026-08-13): the drawn world indoors is
    // per CELL — my building at its per-wall raise, the covering cone at its
    // cap, and EVERYTHING ELSE WHOLE, deck included (the neighbour's house
    // keeps its roof; the up-screen mountain keeps its mass, black at zero
    // ambient). The cut rides the room mask's R channel — 128+cut in my room,
    // cut alone for a constrained outside cell, 127 = unconstrained (see
    // setRoom). The resolve must follow the renderer column for column: a
    // column clamped shorter than it is drawn hands its upper pixels to
    // whatever lies behind, and one clamped taller lights art that is not
    // there — both the roof-in-the-heightmap bug in a new coat.
    float rr = texture2D(uRoom, uv).r * 255.0;
    float low = rr - step(127.5, rr) * 128.0;
    if (low > 126.5) return texture2D(uHeight, uv).r * 255.0 / uHScale; // whole, deck-inflated
    return min(baseTerrAt(cr), low);
  }
  return texture2D(uHeight, uv).r * 255.0 / uHScale;
}

// IS THIS CELL IN THE ROOM I AM STANDING IN? 1 inside, 0 outside; 1 everywhere
// while outdoors, so every outdoor pixel is byte-identical to before.
//
// This is what makes "the outside is dark" a LIGHTING fact instead of a
// rendering one (maintainer 2026-08-07). The renderer draws the whole world
// indoors — skipping it was the old design and it cost three separate bugs:
// the grass POPPED into existence as you stepped out, a torch could not light
// what was not there, and a tile whose down-screen neighbour was missing had
// its own side exposed. Drawing everything and giving the outside ZERO AMBIENT
// fixes all three at once, and buys the thing he actually wanted: the ambient
// is the only term that goes to zero, so a POINT light still reaches those
// pixels and a torch indoors spills through the doorway and reveals the ground
// beyond it, with the opening's own shadow, before you have stepped out.
//
// NEAREST-filtered and read at the texel CENTRE, like every other per-cell
// map here — a smoothed room boundary would bleed a half-cell of ambient
// through the walls.
float roomAt(vec2 cr) {
  // GATED ON THE EASE, NOT THE VERDICT. uIndoor is boolean geometry and flips
  // the instant you cross the threshold; the mask has to outlive it, or
  // stepping OUT hands the whole world the interior's own light for the length
  // of the fade. The scene keeps the room published until this reaches 0.
  if (uIndoorMix < 0.001) return 1.0;
  // FAIL LIT, never dark. An unbound sampler2D reads texture unit 0 — here the
  // HEIGHTMAP — whose red channel is terrain height, so a missing bind would
  // not merely be wrong, it would black out the parts of the ROOM that happen
  // to sit at height 0 while leaving the outside lit. That is the exact
  // failure uGlowOn exists to prevent, and it is invisible on the headless
  // harness (SwiftShader binds every declared sampler) and fatal on a phone.
  if (uRoomOn < 0.5) return 1.0;
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 0.0;
  vec2 uv = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  // R carries the per-cell CUT beside the membership bit (128 + cut inside, 0
  // outside — see setRoom), so membership is the top half of the byte, not the
  // raw value: returning r itself would hand a 128/255 ambient to every room
  // cell whose wall keeps the scalar cut.
  return step(0.5, texture2D(uRoom, uv).r);
}

// Solid-object flag (bush, boulder, tree...): G channel of the heightmap.
float objAt(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 0.0;
  vec2 uv = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  return texture2D(uHeight, uv).g;
}

// Emission palette index + 1 (0 = the cell does not glow): B channel.
float emitAt(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 0.0;
  vec2 uv = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  return texture2D(uHeight, uv).b * 255.0;
}

// Multiplicative "self pulse" for an emitter's own pixels — EXACT mirror of
// emissionSelfPulse() (JS). Applied to the emissive cell's final light before
// the clamp so the tile itself visibly breathes (not just the spill). Peaks
// at 1.0; flicker dips deep/fast, pulse is a calm breath, static a gentle life.
float emSelfPulse(float m, float ph) {
  float tw = 0.08 * sin(uAnimTime * 2.3 + ph * 1.7);
  if (m > 150.0) {
    float env = 0.7 + 0.3 * sin(uAnimTime * 0.17 + ph * 3.1);
    float d = env * (0.30 * (0.5 + 0.5 * sin(uAnimTime * 3.3 + ph)) + 0.13 * sin(uAnimTime * 8.3 + ph * 1.7))
      + 0.07 * (0.5 + 0.5 * sin(uAnimTime * 0.71 + ph * 1.3));
    return clamp(1.0 - d + tw, 0.42, 1.0);
  } else if (m > 50.0) {
    return clamp(0.6 + 0.4 * (0.5 + 0.5 * sin(uAnimTime * 1.9 + ph)) + tw, 0.42, 1.0);
  }
  return clamp(0.66 + 0.34 * (0.5 + 0.5 * sin(uAnimTime * 1.2 + ph)) + tw, 0.5, 1.0);
}

// Whole-cell support pulse (mix toward 1.0 of emSelfPulse): the STRONGEST,
// eye-catching animation lives in the per-cluster glow halos on the actual
// glowing pixels; the tile base breathes at ~half that depth so it reads as
// "lit BY the glowing detail" while still clearly having life of its own.
float emCellSupport(float m, float ph) {
  return mix(1.0, emSelfPulse(m, ph), 0.5);
}

// Weather clouds: 2-octave value noise, world-anchored and wind-drifted.
// EXACT twin of cloudFactorAt() in JS (lit-copy tints) — change BOTH.
// Precision-exact lattice hash: every intermediate stays an INTEGER below
// 2^24, so GPU float32 and the JS twins' float64 compute IDENTICAL values.
// The old fract(sin(big)*43758.5453) decorrelated between GPU and CPU once
// the argument grew (phone GPUs resolve sin(27000) to ~0.002 rad — times
// 43758 and fract'd, a DIFFERENT random field than the CPU's): the avatar's
// cloud tint visibly disagreed with the drawn shade (maintainer: "darker
// before the shadow has even hit... not in sync").
float cwHash(vec2 i) {
  float a = mod(i.x * 113.0 + i.y * 271.0, 971.0);
  a = mod(a * a + 113.0, 971.0);
  a = mod(a * a + i.x, 971.0);
  a = mod(a * a + i.y, 971.0);
  return a / 971.0;
}
float cwNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cwHash(i), cwHash(i + vec2(1.0, 0.0)), u.x),
             mix(cwHash(i + vec2(0.0, 1.0)), cwHash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// The largest surface height any cell of block b can report through
// heightAt — the same decode as heightAt, so it bounds it exactly; a block
// outside the world answers 99 (= never skip; heightAt says 99 there too).
float blockMaxAt(vec2 b) {
  if (b.x < 0.0 || b.y < 0.0 || b.x >= uHBlockN.x || b.y >= uHBlockN.y) return 99.0;
  return texture2D(uHBlock, (b + 0.5) / uHBlockN).r * 255.0 / uHScale;
}

void main() {
  vec2 suv = gl_FragCoord.xy / resolution;
  float wx = uCam.x + suv.x * uCam.z;
  // Orientation + span are GROUND-TRUTH calibrated via the built-in test
  // patterns ([9]: gradient must be dark at top, grid must match tile art):
  // this stack needs NO y-inversion and a zoom-scaled, corner-anchored span.
  float wy = uCam.y + mix(suv.y, 1.0 - suv.y, uFlip) * uCam.w;
  if (uTest > 0.5 && uTest < 1.5) {
    // Calibration 1: brightness = position within the world view, dark at the
    // view's TOP edge. If the gradient on screen is dark at the BOTTOM, the
    // field is upside down.
    float g = (wy - uCam.y) / uCam.w;
    gl_FragColor = vec4(vec3(0.15 + 0.85 * g), 1.0);
    return;
  }
  if (uTest > 2.5 && uTest < 3.5) {
    // Calibration 3: emit the raw fragment coordinate as colour. Corner
    // pixel readback reveals the TRUE fragment range and orientation —
    // R = suv.x, G = suv.y, no interpretation involved.
    gl_FragColor = vec4(suv.x, suv.y, 0.0, 1.0);
    return;
  }
  // -1: tiles are drawn anchored at their diamond's LEFT corner (the art is
  // tile/2 wider than the dx step) — without it the inverse projection lands
  // one cell off diagonally: centre of cell (c,r) must invert to (c+.5,r+.5).
  float u = (wx - uIsoA.x) / uIsoA.z - 1.0;
  if (uTest > 1.5 && uTest < 2.5) {
    // Calibration 2: paint the shader's own cell grid. The bright diamond
    // lines MUST coincide with the artwork's tile edges — any span, offset
    // or orientation error in the screen->world mapping shows immediately.
    float v = (wy - uIsoA.y) / uIsoA.w;
    float gc = fract((u + v) * 0.5);
    float gr = fract((v - u) * 0.5);
    float line = (min(gc, 1.0 - gc) < 0.03 || min(gr, 1.0 - gr) < 0.03) ? 1.0 : 0.35;
    gl_FragColor = vec4(vec3(line), 1.0);
    return;
  }
  float v0 = (wy - uIsoA.y) / uIsoA.w; // grid diagonal at height 0
  float kk = uIsoB.x / uIsoA.w;        // diagonal shift per height level

  // Resolve the surface this pixel shows. A point at height h projects onto
  // diagonal v = v0 + h*kk, so this pixel's candidates lie on a ray through
  // (v, h) space; walking it front-to-back the ray crosses ONE grid cell per
  // unit of v. For each cell the hit height is solved EXACTLY (the column's
  // top, or the ray's own height on that segment = a wall-face pixel), so
  // faces get precise fractional heights — fixed-step marching aliased into
  // sawtooth teeth on tall walls.
  float vTop = v0 + uIsoB.w * kk;
  float z = 0.0;
  vec2 cell = vec2(0.0);
  bool found = false;
  // Walk the ray over EXACT cell-boundary crossings (col crosses integers at
  // v = 2m - u, row at v = 2n + u) so every interval lies inside exactly one
  // cell. Fixed-width segments straddled cells, attributing wall pixels to
  // the wrong column — every face rule downstream then judged the wrong wall.
  float vHi = vTop;
  // WALK BUDGET: sweeping from the max-level candidate down to level 0 needs
  // about maxLevel*(lh/dy) iterations (~1.07 per level on maps2 geometry; the
  // per-pixel step phase makes it vary by screen column). The old cap of 36
  // was sized for the <=15-level worlds: on the_island2 (max level 40) every
  // pixel whose true surface sits deeper than the budget NEVER RESOLVED, and
  // the !found fallback painted it flat-ambient (no sun/shadows), fog-less
  // and mist-less — the maintainer's "shadows don't work on low elevation,
  // fine on other maps" report, measured at 100% of pixels starved on a
  // level-0 gorge floor via the uTest=4 classification. 128 covers ~85-level
  // worlds; break-on-found keeps the cost proportional to each pixel's real
  // depth (a plain continue guard would tick all 128 iterations per fragment
  // — that alone stalled the software-GL harness across 3 fullscreen passes).
  vec2 blk = vec2(-9.0);
  float hb = 99.0;
  for (int s = 0; s < 128; s++) {
    if (found || vHi <= v0 - 1.5) break;
    float vColB = 2.0 * floor((vHi + u) * 0.5 - 0.0001) - u;
    float vRowB = 2.0 * floor((vHi - u) * 0.5 - 0.0001) + u;
    float vLo = max(vColB, vRowB);
    float vMid = (vHi + vLo) * 0.5;
    vec2 cr = vec2((u + vMid) * 0.5, (vMid - u) * 0.5);
    // THE HIERARCHICAL SKIP. This walk starts at the WORLD's max level and
    // pays one dependent fetch per cell until the first column whose top
    // reaches the segment — 44 per pixel per pass on level-0 ground under a
    // 40-level world, the forest spots' whole lag (investigation 2026-09-02).
    // A cell is hit iff v0 + H*kk >= vLo; every H in this block is <= the
    // block's max, so when v0 + hb*kk < vLo no cell in it can be hit and the
    // fetch is skipped. ONLY the fetch: the walk's arithmetic, vLo, vMid, cr
    // and the hit test are untouched, so z, cell and everything downstream
    // are bit-identical (uSkip is the A/B switch; parity is pinned on the
    // pass's own pixels by __ml.nightHash).
    vec2 b = floor(cr * 0.125);
    if (uSkip > 0.5 && (b.x != blk.x || b.y != blk.y)) { blk = b; hb = blockMaxAt(b); }
    if (uSkip > 0.5 && v0 + hb * kk < vLo - 0.0001) { vHi = vLo; continue; }
    float H = heightAt(cr);
    if (H < 90.0) {
      float vSurf = v0 + H * kk; // this column's top along the ray
      if (vSurf >= vLo - 0.0001) {
        float vHit = min(vHi, vSurf);
        z = max((vHit - v0) / kk, 0.0);
        cell = cr;
        found = true;
      }
    }
    vHi = vLo;
  }
  if (!found) {
    // Off-map / unresolved: plain ambient — but INDOORS that pixel is the sky
    // band above the cut-away, i.e. outside the room by definition. No cell was
    // resolved, so roomAt has nothing to sample; the rule has to be stated
    // outright or the one region with no geometry stays lit over a black world.
    gl_FragColor = vec4(uAmbient * (1.0 - uIndoorMix), 1.0);
    return;
  }

  float Ha = heightAt(cell);
  if (uTest > 3.5) {
    // Calibration 4: final surface classification — wall-face pixels RED,
    // top pixels GREEN (probed numerically by the verify scripts).
    float isFace = (Ha < 90.0 && Ha - z > 0.05 && groundAt(cell) - z > 0.05) ? 1.0 : 0.0;
    gl_FragColor = vec4(isFace, 1.0 - isFace, 0.0, 1.0);
    return;
  }

  // A CAVE MOUTH IS NOT A WALL. Ha is max(terrain, deck), so every pixel
  // under a roof slab used to classify as a wall FACE — and a face takes the
  // face's Lambert gate and shadow march, which painted the open entrance of
  // the cave with light and shadow as if a pane of glass were stretched across
  // it (maintainer 2026-08-08: "the torch is casting shadows on the open cave
  // entry... it looks like some sort of mirror or force-field. You can't cast
  // shadows on it since it's empty air"). The light MARCH already knows this —
  // see the two-solid-spans note above and groundAtSoft's own pin — the face
  // classification simply never got the same rule. A face needs SOLID GROUND
  // above the pixel, not a slab floating over open air.
  float Hg = groundAt(cell);

  // Face geometry, light-independent — hoisted out of the light loop.
  // The face's attenuation anchor is its EXACT point on the wall plane
  // (0.99 keeps floor() in the owning cell): the old per-cell centroid made
  // brightness jump at every face/ground boundary (knife edges at wall bases).
  bool isFace = (Ha < 90.0 && Ha - z > 0.05 && Hg - z > 0.05);
  vec2 baseF = floor(cell);
  float uf = u - (baseF.x - baseF.y);   // pixel left/right of front corner
  float pickR = smoothstep(-0.2, 0.2, uf);
  float hR = heightAt(baseF + vec2(1.5, 0.5));
  float hD = heightAt(baseF + vec2(0.5, 1.5));
  // On a CONTINUOUS wall the resolve can own a band as either of two
  // same-height cells; a face is only exposed where its neighbour is lower
  // than the pixel. If the nominal face is buried, the visible surface is
  // the neighbour's PERPENDICULAR face — gate on that plane.
  if (hR < 90.0 && hR > z + 0.01) pickR = 0.0; // +col face buried
  if (hD < 90.0 && hD > z + 0.01) pickR = 1.0; // +row face buried
  float vS = v0 + z * kk;
  vec2 pos = isFace
    ? mix(vec2(u + baseF.y + 0.99, baseF.y + 0.99), vec2(baseF.x + 0.99, baseF.x + 0.99 - u), pickR)
    : vec2((u + vS) * 0.5, (vS - u) * 0.5);
  // Top penumbra: the gate eases in over the first ~6px below the analytic
  // lip — the drawn lip (grass overhangs, organic edges) never sits exactly
  // on the analytic line, and a soft start admits that uncertainty instead
  // of stamping a fully-confident hard edge along it. The BOTTOM runs at
  // full strength to the ground: wall shadows must REACH the seam (an
  // earlier base fade-out lifted the last 7px — the opposite of how light
  // behaves in a concave corner).
  float gateFade = 1.0;
  // Ambient occlusion at the wall/ground seam: concave corners trap light,
  // so BOTH sides darken toward the seam — the face's last ~5px and the
  // ground tucked within ~6px of a HIGHER wall behind it. Geometric, always
  // on (subtle on lit corners, invisible on already-dark faces).
  float ao = 1.0;
  if (isFace) {
    gateFade = smoothstep(0.0, 6.0, max((Ha - z) * uIsoB.x, 0.0));
    float hFront = mix(hD, hR, pickR);
    // Face-seam AO only on REAL walls: a deck-capped column (surface height
    // above BASE terrain) has open air under the slab, not a wall foot - the
    // phantom face the walk attributes there must not stamp contact AO on the
    // water/ground in front of the span (the static thin line under every
    // bridge, identical at all times of day). Non-deck cells: Ha equals
    // baseTerrAt exactly (identical byte packing), so the guard is true and
    // shading is bit-identical everywhere else.
    if (hFront < 90.0 && Ha - baseTerrAt(cell) < 0.5) {
      float dAbove = max((z - hFront) * uIsoB.x, 0.0);
      ao = mix(0.75, 1.0, smoothstep(0.0, 5.0, dAbove));
    }
  } else {
    vec2 bg = floor(cell);
    float vColLo = 2.0 * bg.x - u;
    float vRowLo = 2.0 * bg.y + u;
    // Neighbour across the pixel's up-screen cell boundary. BASE terrain
    // heights only: solid objects are art and floating deck slabs are open
    // air at seam height — neither creates a concave corner, and the deck-
    // inflated surface read stamped a static dark AO band on the water in
    // front of every bridge span (same at all times of day).
    float hb = (vColLo >= vRowLo) ? baseTerrAt(bg + vec2(-0.5, 0.5)) : baseTerrAt(bg + vec2(0.5, -0.5));
    if (hb < 90.0 && hb > z + 0.5) {
      float dBase = max((v0 + z * kk - max(vColLo, vRowLo)) * uIsoA.w, 0.0);
      ao = mix(0.72, 1.0, smoothstep(0.0, 6.0, dBase));
    }
  }

  // DIRECTIONAL SUN (day phases; maintainer): daylight is modelled as
  // SKY + SUN — the phase ambient is split into a flat sky term (55%) and a
  // directional sun term (45%) that only reaches tiles with a clear line
  // toward the sun, so full authored brightness NEEDS the sun and shadowed
  // ground visibly drops to the sky level ("the previous ambient was
  // powerful enough to show full colour on its own — lower it so the
  // directional shadow is visible"). uSun.xy is the direction shadows are
  // CAST; march the linear heightmap the other way, rising uSun.z levels
  // per cell — terrain or solid objects above the ray shade the surface
  // with the point lights' soft penumbra family; faces turned away from
  // the sun shade via a Lambert gate. Point lights still add in shadow.
  // THE PIXEL'S OWN SCENERY SHARE (main scope: the sun patch and the torch
  // march both read it): the share its cell carries, and that cell's centre.
  float ownShare = uSceneryOn > 0.5 ? sceneryShareAt(cell) : 0.0;
  /* A SHARE BELONGS TO THE FLOOR THE PIECE STANDS ON. The share is a property
   * of the CELL, so without this a pixel on a DECK above that floor — a house
   * roof, a bridge — reads the furniture standing under it and takes its
   * contact shading: every object inside a house printed its own dark blob on
   * the roof, which is a wall-hack (maintainer 2026-09-07: "you can see where
   * scenery objects have been placed by looking at the roof"). groundTerrAt is
   * the column WITHOUT the share, i.e. the floor itself; one level of slack
   * covers the soft sampling. */
  if (ownShare > 0.0 && z > groundTerrAt(cell) + 1.0) ownShare = 0.0;
  vec2 ownC = floor(cell) + 0.5;
  float sunF = 1.0;
  float dbgShadow = 0.0; // see the shadow debug switch below
  if (uSun.w > 0.001) {
    // Terrain marches multiplicatively (long straight ridges project as
    // TERRAIN: the original multiplicative march, byte-identical to the
    // approved cliff look (maintainer: cliffs are PERFECT — locked). The
    // prop share is subtracted so props don't feed this path.
    // Anti-alias the cast-shadow EDGE. The occlusion map is one texel per tile,
    // so a hard-topped occluder (wall/tower/stair) throws an edge that staircases
    // across the grid. Average N COMPLETE marches, each offset a little PERP to
    // the sun ray (= along the shadow edge). Every march reads the real smooth
    // height field, so this is true supersampling — it can't alias (unlike sparse
    // in-loop taps) and never shortens a thin occluder's shadow.
    vec2 sPerp = normalize(vec2(-uSun.y, uSun.x));
    float jit = 0.5; // perp offset of the outer samples (cells)
    float visSum = 0.0;
    for (int k = -1; k <= 1; k++) {
      vec2 p0 = pos + sPerp * (float(k) * jit);
      float vis = 1.0;
      for (int s = 1; s <= 20; s++) {
        float dc = float(s) * 0.6;
        vec2 p = p0 - uSun.xy * dc;
        if (floor(p.x) == floor(pos.x) && floor(p.y) == floor(pos.y)) continue;
        float hRay = z + dc * uSun.z + 0.15;
        // Ramp BYTE-IDENTICAL to the locked cliff look — a straight edge (the
        // mountain/pyramid) is unchanged by the perp average, so cliffs stay
        // exactly as approved; only staircased edges (walls/towers) smooth.
        float H = terrHeightSoft(p);
        if (H < 90.0 && H > hRay) vis *= mix(0.80, 0.35, clamp((H - hRay) * 1.2, 0.0, 1.0));
      }
      visSum += vis;
    }
    float sunVis = visSum / 3.0;
    // PROPS: one smooth max-margin patch (fine 0.35 steps). Per-sample
    // multiplication scalloped these small shadows into "x-mas trees" —
    // a single margin has no sample structure. Shape (maintainer: "the
    // top of the shadow is so spiky/small"): the raw bilinear footprint
    // is a pyramid, so the cast narrowed linearly into a needle — the
    // share is AMPLIFIED into a plateau (near-constant width along the
    // cast) and the reach fades the pool out by ~2.5 cells, before the
    // geometric cone can pinch, so the tip ends as a soft round fade.
    float m = 0.0;
    float dcp = 0.0;
    // A world with no placed props has pArr == 0 everywhere, so pr is always
    // 0, m stays 0 and the loop's only effect (sunVis *= 1 - 0.75*m) is
    // identity — 7 iterations and two fetches per pixel per daytime frame for
    // nothing. Gated on the CPU-known fact, byte-identical.
    // SPARSE ON A SCENERY WORLD: uHasProps is 1 there too (scenery shares
    // feed this loop), but only 629 of the_game's 262,144 cells carry one, so
    // the ground map's G flags the cells within the patch's reach of any
    // share (setSceneryOccluders) and the 16 fetches run only there — one
    // texel-centre fetch everywhere else. Identity by construction (proven:
    // night hash equal gate on/off); tiles2 worlds keep uPropGate 0.
    bool propRun = uHasProps > 0.5;
    if (propRun && uPropGate > 0.5) propRun = sceneryNearAt(cell) > 0.5;
    if (propRun) for (int s = 1; s <= 8; s++) {
      dcp += 0.35;
      vec2 p = pos - uSun.xy * dcp;
      if (floor(p.x) == floor(pos.x) && floor(p.y) == floor(pos.y)) continue;
      float reach = smoothstep(2.7, 1.3, dcp);
      if (reach <= 0.0) break;
      float hRay = z + dcp * uSun.z + 0.15;
      float pr = propAtSoft(p);
      float Hs = heightAtSoft(p);
      float Hp = Hs - pr + min(pr * 1.8, 1.0);
      if (pr > 0.001 && Hs < 90.0 && Hp > hRay)
        m = max(m, min((Hp - hRay) * 2.2, 1.0) * reach);
    }
    // THE OWN TRUNK'S CORE, DIRECTIONALLY. The own-cell skip above keeps the
    // bump's bilinear skirt off the sunny side, but the trunk still stands
    // between the sun and a pixel on its FAR side — under a post, a cart, a
    // stone the cell was a BRIGHT DIAMOND inside the cast shadow wherever the
    // art does not cover it (maintainer, 2026-09-06). Shade exactly where the
    // sunward ray from the pixel passes through the core, to the cast
    // shadow's own depth; the sunny half of the cell stays lit. Scenery only
    // (ownShare is 0 on a props world) — the_island2 is byte-identical.
    if (ownShare > 0.0) {
      // CONTACT: a soft blob under the trunk in EVERY direction, then the
      // directional core on top of it. The strip alone left the cell beside
      // and in front of a post lit while the skirt shaded the ground around
      // it — bright spots (maintainer, 2026-09-06: "darker in corners").
      float ao = smoothstep(${SCN_CONTACT_R}, ${SCN_CONTACT_R} * 0.3, distance(pos, ownC));
      m = max(m, ${SCN_CONTACT_SUN} * ao);
      float tt = dot(ownC - pos, -uSun.xy);
      if (tt > 0.05) {
        float dq = distance(pos - uSun.xy * tt, ownC);
        float hRayC = z + tt * uSun.z + 0.15;
        float top = z + min(ownShare * 1.8, 1.0);
        if (top > hRayC) m = max(m, min((top - hRayC) * 2.2, 1.0) * smoothstep(${SCN_CORE}, ${SCN_CORE} * 0.55, dq));
      }
    }
    sunVis *= 1.0 - 0.75 * m;
    if (isFace) {
      vec2 nrm = mix(vec2(0.0, 1.0), vec2(1.0, 0.0), pickR);
      float cosS = dot(nrm, -uSun.xy);
      sunVis *= clamp(cosS * 1.4 + 0.55, 0.3, 1.0);
    }
    float sunShare = 0.45 * uSun.w; // the sun's slice of the phase ambient
    sunF = (1.0 - sunShare) + sunShare * clamp(sunVis, 0.0, 1.0);
    /* THE SHADOW DEBUG SWITCH (settings: "shadows"). The maintainer's tool for
     * telling a SHADOW from a TILE: a dotted line that survives mode 1 is
     * painted into the ground texture, and one that turns red in mode 2 is
     * this pass. Cheap and exact — the same term either way, only neutralised
     * or reported. */
    if (uShadowDbg > 0.5) {
      dbgShadow = 1.0 - clamp(sunVis, 0.0, 1.0); // how shadowed this pixel is
      sunF = 1.0;                                 // and never darken by it
    }
  }
  // Cloud shadows ride between the sun and the ground: world-anchored blobs
  // drifting on the wind, shading the ambient like the sun march does. The
  // depth scales with the sun's strength — thick clouds at night barely
  // register (no sun to block), at noon they stamp clear moving shade.
  float cloudF = 1.0;
  if (uCloud > 0.001) {
    // Big slow continents of cloud (wavelength ~550 world px), clearly
    // WIND-DRIVEN (~42/23 px/s) and a deep shade (maintainer round 2).
    vec2 cp = vec2(wx, wy) * 0.0018 + uAnimTime * vec2(0.075, 0.042);
    float n = cwNoise(cp) * 0.65 + cwNoise(cp * 2.3 + 17.0) * 0.35;
    float cover = smoothstep(0.52, 0.78, n);
    // Depth 0.62 (maintainer: "somewhat darker clouds" — 0.45 read faint,
    // and the character stands under this same multiply overlay, so she
    // dims with the ground). The night floor drops to 0.13 so nighttime
    // shade stays as muted as before (no sun to block).
    cloudF = 1.0 - cover * 0.62 * uCloud * mix(0.13, 1.0, uSun.w);
  }
  // THE ONE TERM THAT GOES TO ZERO OUTSIDE MY ROOM. Ambient (and the sky/sun
  // and cloud factors folded into it) is what makes the world visible by
  // default; killing it there — and NOTHING else — is what "render everything
  // outside black" means, while leaving every additive term below free to
  // light those pixels. See roomAt.
  // EASED with the grade, not snapped with the geometry: uIndoorMix is the same
  // 0.35s roll the indoor ambient itself rides, so crossing a doorway FADES the
  // outside to black under an interior that is still dimming, instead of
  // blacking half the screen a frame before the room has caught up.
  float r = roomAt(cell);
  float inRoom = mix(1.0, r, uIndoorMix);
  // TWO GRADES, ONE CROSSING. A cell in MY ROOM rides uAmbient, which is
  // already the eased blend from the outdoor grade to the interior dial. A cell
  // OUTSIDE fades between BLACK and its own OUTDOOR grade and never touches the
  // interior one — that is the whole fix for the maintainer's report (2026-08-07,
  // walking out of a house at night): "it snaps to a brightness brighter than
  // night and has to fade back down". With one shared uAmbient it had to. The
  // interior dial at 40% is over four times night's luma, so the moment the
  // mask let go the outside took THAT value and then eased down to night —
  // an overshoot, not a fade. Outdoors the two are equal and r is 1, so this
  // costs a mix and changes nothing.
  vec3 amb = mix(uAmbientOut * (1.0 - uIndoorMix), uAmbient, r);
  vec3 light = amb * sunF * cloudF;
  // AURORA NIGHTS: some nights the northern lights dance over Nangijala —
  // slow drifting curtains of arctic green/violet ADDED to the ambient (the
  // ground and everyone standing on it glows with the sky), auto-fading as
  // the sun returns. EXACT JS twin: auroraAt() — change BOTH together.
  if (uAurora > 0.001) {
    vec2 ap = vec2(wx, wy) * 0.0013 + uAnimTime * vec2(0.045, -0.02);
    float an = cwNoise(ap) * 0.6 + cwNoise(ap * 2.1 + 31.0) * 0.4;
    float curtain = smoothstep(0.40, 0.80, an);
    float hue = 0.5 + 0.5 * sin(uAnimTime * 0.12 + wx * 0.0011);
    vec3 acol = mix(vec3(0.10, 0.85, 0.45), vec3(0.45, 0.25, 0.85), hue);
    light += acol * curtain * 0.18 * uAurora * (1.0 - uSun.w) * inRoom;
  }
  // A SCENERY TRUNK NEVER SHADOWS ITS OWN CELL'S TREAD (maps3). The bump's
  // bilinear skirt reaches one cell out and the march's own-cell + 0.75-cell
  // near-field skips are sized for a pixel at a wall base: under a 0.5-cell
  // trunk the skirt darkened the tread on the TORCH side by 21% (measured) —
  // a dark ring hugging every root. For a pixel whose cell carries a scenery
  // share, samples within one cell of that cell's centre are skipped; props
  // carry no share in this channel, so tiles2 is byte-identical.
  for (int i = 0; i < ${MAX_SHADER_LIGHTS}; i++) {
    if (float(i) >= uNumLights) continue;
    vec3 lp = uLightPos[i].xyz;
    // Sign of w: positive = a real light (casts LOS shadows); NEGATIVE = a
    // GLOW pool from tile emission — soft ambience with no shadow geometry,
    // like Sea of Stars' environment point lights.
    float radius = abs(uLightPos[i].w);
    vec2 d2 = lp.xy - pos;
    float dist = sqrt(dot(d2, d2) + pow((lp.z - z) * 0.6, 2.0));
    float att = clamp(1.0 - dist / radius, 0.0, 1.0);
    att *= att;
    if (att <= 0.001) continue;

    // Line of sight: march the heightmap toward the light. Occlusion scales
    // with HOW FAR the blocker pokes above the ray — grazing edges dim gently
    // instead of stamping hard cell-shaped shadow blocks. Only samples in the
    // pixel's OWN column are skipped (a wall must not shadow its own face,
    // but it MUST still block light for the ground right at its base).
    // Surfaces ABOVE the light skip the LOS shadow and fade by distance only:
    // characters are billboards, and a body's upper pixels sample the terrain
    // BEHIND them — if a higher backdrop rim-shadows itself against a low
    // torch, the character standing lit in front turns black with it. Light
    // received from above or level (cliff bases, object shadows, faces)
    // keeps full occlusion.
    float occ = 1.0;
    // A light standing INSIDE a scenery share — a campfire, a brazier: the
    // fire IS the piece — must not be blocked by its own trunk (measured: a
    // cave brazier's own pool fell 28% at 1.3 cells once its cell carried a
    // share). The mirror of the pixel-side skirt skip, keyed on the light's
    // cell; the piece still shadows every OTHER light.
    float lShare = uSceneryOn > 0.5 ? sceneryShareAt(lp.xy) : 0.0;
    vec2 lC = floor(lp.xy) + 0.5;
    float peakC = max(max(uLightCol[i].r, uLightCol[i].g), uLightCol[i].b);
    if (uLightPos[i].w > 0.0 && att * peakC > ${SHADOW_MARCH_MIN_LIGHT} && (z < lp.z + 0.05 || objAt(cell) > 0.5)) {
      for (int s = 1; s <= 12; s++) {
        float t = float(s) / 13.0;
        // March from the EXACT surface point (same as attenuation): marching
        // from the cell centroid gave a face pixel a different occlusion
        // path than the ground pixel beside it — a light step at every base.
        vec2 p = mix(pos, lp.xy, t);
        if (floor(p.x) == floor(pos.x) && floor(p.y) == floor(pos.y)) continue;
        // Near-field skip: with the march anchored at the exact surface
        // point, a ground pixel AT a wall base gets its first sample inside
        // the wall cell — a false dark notch along every base line.
        vec2 dp = p - pos;
        if (dot(dp, dp) < 0.56) continue;
        if (ownShare > 0.0 && dot(p - ownC, p - ownC) < 1.0) continue;
        if (lShare > 0.0 && dot(p - lC, p - lC) < 1.0) continue;
        float hRay = mix(z, lp.z, t) + 0.2;
        // TWO SOLID SPANS PER COLUMN, not one height. The ground is solid
        // from 0 to hg; a deck (when H > hg) is a slab at H with OPEN AIR
        // under it. A slab can therefore only block a ray whose LIGHT is on the
        // far side of it — sun/lamp above, ray below. A torch under the same
        // slab is in the open air with it and must shine straight through.
        // (The sun march is deliberately untouched: it wants the deck to block,
        // and its cliff look is locked.)
        float H = heightAtSoft(p);
        float hg = groundAtSoft(p);
        float blocker = (H > hg + 0.01 && lp.z <= H) ? hg : H;
        if (blocker < 90.0 && blocker > hRay) {
          float pen = clamp((blocker - hRay) * 1.5, 0.0, 1.0);
          // A scenery share shadows HARD (one or two samples per piece);
          // terrain keeps the wall chain. One extra read, blocking samples only.
          float sc = uSceneryOn > 0.5 ? step(0.01, sceneryShareAt(p)) : 0.0;
          occ *= mix(mix(0.8, 0.45, pen), mix(${SCN_SHADOW_NEAR}, ${SCN_SHADOW_DEEP}, pen), sc);
        }
      }
      // Bounce floor: firelight scatters — shadowed ground near a light keeps
      // a faint glow instead of dropping to pitch ambient. Faces still gate
      // to dark below (the Lambert gate multiplies AFTER this floor).
      // THE OWN TRUNK'S CORE, DIRECTIONALLY — the far-side half of the skirt
      // rule above: a pixel in its piece's share cell is shaded where the ray
      // to the light passes through the core between them (the ground at a
      // barrel's base stayed lit inside its own cast shadow; maintainer,
      // 2026-09-06). To the march's floor, so it meets the cast shadow.
      if (ownShare > 0.0) {
        float ao = smoothstep(${SCN_CONTACT_R}, ${SCN_CONTACT_R} * 0.3, distance(pos, ownC));
        occ *= 1.0 - ${SCN_CONTACT_TORCH} * ao; // contact, every direction
        vec2 dl = lp.xy - pos;
        float tt = dot(ownC - pos, dl) / max(dot(dl, dl), 1e-4);
        if (tt > 0.05 && tt < 1.0) {
          float dq = distance(pos + dl * tt, ownC);
          float hRayC = mix(z, lp.z, tt) + 0.2;
          float top = z + ownShare;
          if (top > hRayC)
            occ *= mix(1.0, mix(0.8, 0.22, clamp((top - hRayC) * 1.5, 0.0, 1.0)), smoothstep(${SCN_CORE}, ${SCN_CORE} * 0.55, dq));
        }
      }
      occ = max(occ, 0.22);
    }

    // Side-face pixels (below their column's top): a column shows TWO faces —
    // left of its front corner faces +row, right of it faces +col. Each face
    // only catches light that stands beyond ITS OWN plane (in cells), so a
    // torch on the right lights the right face but never wraps onto the
    // left one, and a torch on top (behind both planes) lights neither.
    // NEGATIVE-radius GLOW POOLS are EXEMPT (2026-08-13): a pool is ambience,
    // not a lamp with a position a face can turn away from, so a TERRAIN face
    // beside a glowing tile takes the pool's light like the ground does — and
    // the CPU twin lightAt has never had a face gate, so this also removes a
    // shader/CPU disagreement on face cells. (Note for the curious: this is
    // NOT what darkened glow_test — its glowing cubes are prop BILLBOARDS on
    // flat terrain, and the heightmap is terrain-only, so isFace never fired
    // there at all; that night was the derived defaults' radius/intensity,
    // fixed in buildEmissiveSources. Measured: 0% of glow_test's prop pixels
    // classify as faces.)
    if (isFace && uLightPos[i].w > 0.0) {
      float frontL = lp.y - (baseF.y + 1.0); // beyond the +row (left) face
      float frontR = lp.x - (baseF.x + 1.0); // beyond the +col (right) face
      // Lateral: how far the light sits OUTSIDE the face's own 1-cell span.
      float latL = abs(lp.x - clamp(lp.x, baseF.x, baseF.x + 1.0));
      float latR = abs(lp.y - clamp(lp.y, baseF.y, baseF.y + 1.0));
      float front = mix(frontL, frontR, pickR);
      float lat = mix(latL, latR, pickR);
      // Lambert from the NEAREST point of the face to the light: a torch in
      // front of a long wall lights the whole run (cosine taper + the normal
      // distance attenuation) instead of only the single facing cell, while
      // a light behind the plane still leaves the face dark.
      float cosF = front / max(sqrt(front * front + lat * lat), 0.001);
      // Lambert-like lateral taper. The old smoothstep(0.2,0.6,cosF) crushed
      // grazing light: a torch CLOSE to a wall lit ~1 cell of it while its
      // ground pool spread 4+ cells (light must extend along the wall about
      // as far as along the ground). pow keeps a gentle cosine-ish falloff
      // along the run; the front gate still keeps back faces dark.
      float gate = smoothstep(0.0, 0.25, front) * pow(clamp(cosF, 0.0, 1.0), 0.45);
      // Penumbra: the gate fades in up the face (see gateFade above).
      occ *= mix(1.0, gate, gateFade);
    }

    // Fire flicker: slow cozy breathing + a mild shimmer (fast large-swing
    // flicker reads as a strobe when it drives a whole light pool).
    float fl = uLightCol[i].w;
    float flick = 1.0
      - fl * 0.10 * (0.5 + 0.5 * sin(uAnimTime * 2.9 + float(i) * 5.3))
      - fl * 0.05 * sin(uAnimTime * 7.1 + float(i) * 11.1);

    // Fire cools at the rim: fire-type lights (flicker > 0) shift from their
    // hot core colour toward deep ember red as they attenuate, so the pool
    // ends in a warm red ring instead of dimming uniformly.
    vec3 lc = uLightCol[i].rgb;
    vec3 ember = lc * vec3(0.95, 0.30, 0.12);
    float d01 = clamp(dist / radius, 0.0, 1.0);
    vec3 col = mix(lc, ember, smoothstep(0.35, 0.95, d01) * clamp(fl * 1.2, 0.0, 1.0));

    light += col * att * occ * flick;
  }

  light *= ao;

  // THE CAVE SWALLOWS THE LIGHT. Everything a room shows you from OUTSIDE dims
  // with its depth from the opening — one exponential, so it is dark fast and
  // never quite reaches black at the mouth itself (a monster standing in the
  // entrance stays visible, which is the whole point of an entrance).
  //
  // It multiplies the FINAL light, AFTER the point lights, deliberately: no
  // light source punches in (maintainer 2026-08-08: "I think it looks best if
  // no light source can punch in"). Shine a torch at a cave mouth and you get
  // the first cell or so, never the depths.
  //
  // MY OWN room is exempt, and it un-dims on exactly the indoor blend — so
  // walking in fades the depths up instead of snapping them on.
  // UNDER THE SLAB, OR IT IS OUTSIDE. This is the containment test two earlier
  // attempts got wrong by asking what CELL a pixel resolves to — the mountain's
  // exterior face resolves onto interior cells, so the rock darkened with the
  // room. Ask the pixel's own HEIGHT instead: an interior floor seen through
  // the opening sits BELOW the roof slab, while the roof itself, and every bit
  // of rock above the opening, resolves AT the slab or higher (maintainer
  // 2026-08-08: "the roof and everything over the opening is outside and should
  // not be affected"). The resolve cannot fake being under a ceiling.
  // ...AND NOT A FACE. A face pixel is BELOW its column's top by definition, so
  // the under-the-slab test alone admitted every vertical rock face on the
  // mountain — the third way the same mistake wore a new hat. The shadow is for
  // the interior GROUND you can see through the opening: a TOP pixel, under a
  // slab. Faces belong to the rock, and the rock is outside.
  // THE SHADOW LIVES ON THE CAVE FLOOR. Not "below the slab", not "not a face"
  // — ON THE GROUND. the_island2's cave is not a thin ceiling over a room: its
  // interior cells are terrain 0 with a deck at 24, so THE MOUNTAIN IS THE
  // SLAB, its underside at 8 and its top at 24. Every bit of rock you see above
  // the opening is that slab's own SIDE, resolving to the very same interior
  // cells at z between 8 and 24 — which is why three gates in a row let it
  // through: it is an interior cell, it is under the slab top, and (since a
  // slab side is open air below, not a wall) it is not a face either.
  // The floor is the one thing that resolves AT the ground column's top.
  // ONLY BELOW THE CEILING'S UNDERSIDE. That is the opening; above it is the
  // slab's own face, which is the mountain. Every earlier attempt either took
  // the whole face (black mountain) or nothing (no effect) because the shader
  // had no idea where the ceiling stopped. Now it is in the mask.
  if (uCaveK > 0.0 && z < caveUnderAt(cell) - 0.5) {
    // The GATE stays on the surface march - that is the piece that works, and z
    // (not the cell) is what tells the opening apart from the lintel above it.
    // The DEPTH comes from the deck-free march, because that is the cell whose
    // art this pixel is showing. See groundCellAt.
    vec2 dcell = groundCellAt(u, v0, kk);
    float dep = dcell.x < 0.0 ? caveDepthAt(cell) : caveDepthAt(dcell);
    if (dep > 0.0) {
      float mine = roomAt(cell) * uIndoorMix;
      // THE MOUTH ITSELF IS UNTOUCHED, and it goes dark FAST behind it. dep is
      // stored as depth+1 so that 0 can mean "not a room" (see setRoom), and
      // feeding that straight into the curve darkened the opening cell by half
      // before you had gone anywhere — which reads as a flat wash rather than a
      // cave swallowing the light (maintainer 2026-08-08: "I expected the
      // effect to fade from no effect at all near the opening to very very dark
      // a tile in"). Take the bias back off: the mouth multiplies by 1.
      light *= mix(exp(-max(dep - 1.0, 0.0) * uCaveK), 1.0, mine);
    }
  }

  // Self-emission floor (tiles/emission.json): a glowing tile's OWN pixels
  // never drop below colour*self — lava stays molten, crystals stay lit.
  // max() makes it a FLOOR, not an add: daylight (ambient 1.0) swallows it,
  // night reveals it, and the art's own contrast survives the multiply.
  // Per-cell hash phase so a lava lake shimmers instead of blinking in sync.
  float emSelf = 1.0; // tile self-pulse (1.0 for non-emitters — a no-op)
  float eIdx = -1.0;
  if (uEmitN > 0.5) eIdx = emitAt(cell) - 1.0; // a dead fetch when there is no palette
  if (uEmitN > 0.5 && eIdx > -0.5) {
    float tw = 0.5 / uEmitN; // one palette texel
    vec3 eCol = texture2D(uEmit, vec2((eIdx * 2.0 + 0.5) * tw, 0.5)).rgb;
    vec4 ePar = texture2D(uEmit, vec2((eIdx * 2.0 + 1.5) * tw, 0.5));
    float ph = fract(sin(dot(floor(cell), vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
    float m = ePar.b * 255.0; // anim mode: 0 static, ~100 pulse, ~200 flicker
    emSelf = emCellSupport(m, ph);
    // "Alive" emission waveform — EXACT mirror of emissionWave() (JS): gusty
    // warm-coupled flicker / slow breathing pulse with hue drift / near-
    // steady glinting static. Change BOTH or the layers drift out of sync.
    vec3 fv;
    if (m > 150.0) {
      float env = 0.72 + 0.28 * sin(uAnimTime * 0.17 + ph * 3.1);
      float f = 1.0
        - env * (0.15 * (0.5 + 0.5 * sin(uAnimTime * 3.1 + ph)) + 0.07 * sin(uAnimTime * 8.3 + ph * 1.7))
        - 0.06 * sin(uAnimTime * 0.71 + ph * 1.3);
      f += 0.20 * max(0.0, sin(uAnimTime * 0.41 + ph) * sin(uAnimTime * 0.67 + ph * 1.7) - 0.86) / 0.14;
      float warm = f - 1.0;
      fv = vec3(f, f * (1.0 + 0.35 * warm), f * (1.0 + 0.6 * warm));
    } else if (m > 50.0) {
      float f = 0.86 + 0.13 * sin(uAnimTime * 1.1 + ph)
        + 0.06 * sin(uAnimTime * 0.43 + ph * 1.9)
        + 0.03 * sin(uAnimTime * 0.11 + ph * 0.7);
      float w = sin(uAnimTime * 0.23 + ph * 2.3);
      fv = vec3(f * (1.0 + 0.03 * w), f, f * (1.0 - 0.03 * w));
    } else {
      float f = 0.98 + 0.02 * sin(uAnimTime * 0.31 + ph);
      f += 0.12 * max(0.0, sin(uAnimTime * 0.29 + ph * 2.1) * sin(uAnimTime * 0.53 + ph * 0.8) - 0.93) / 0.07;
      fv = vec3(f);
    }
    // Side faces: the tile ART bakes its faces ~0.70x darker than the top
    // (measured across lava/crystal/mushroom sets), so a uniform floor left
    // wall crystals dim while the cap glowed. Boost the face floor by the
    // inverse — glowing substance then reads the SAME on wall and top, and
    // the boost exactly cancels the baked shading (no visible seam).
    float eBoost = isFace ? 1.4 : 1.0;
    // Gated by inRoom for the same reason the aurora is: a glowing tile is a
    // LIGHT SOURCE, and the maintainer's rule is that light sources outside
    // the room you are in do not reach it ("point light from outside has to be
    // turned off"). Inside the room an emissive tile glows exactly as before.
    light = max(light, eCol * ePar.g * fv * eBoost * inRoom);
  }

  // Per-source glow halos (tile-emission@2 sources): a world-anchored field
  // stamped each frame with one radial halo per visible glowing pixel
  // cluster. ADDED after floor/AO — emission is not subject to corner
  // occlusion, and adding (not max) lets halos ride on top of pools/floors.
  // The field shares uCam's window exactly (stamps are placed by the same
  // world->texel mapping in update(), so a halo stays on its source at any zoom).
  if (uGlowOn > 0.5) {
    vec2 guv = vec2((wx - uCam.x) / uCam.z, (wy - uCam.y) / uCam.w);
    if (guv.x > 0.0 && guv.x < 1.0 && guv.y > 0.0 && guv.y < 1.0) {
      light += texture2D(uGlow, vec2(guv.x, mix(guv.y, 1.0 - guv.y, uGlowFlip))).rgb;
    }
  }

  // Emitter self-pulse: dim the emissive cell's whole light (floor + its own
  // halo) BEFORE the clamp, so the tile itself visibly breathes instead of
  // sitting pinned at the saturation ceiling. No-op (1.0) for non-emitters.
  light *= emSelf;

  // MODE 2 paints the shadow itself, over the unshadowed scene, so what is a
  // shadow is unmistakable and what is a tile is untouched.
  if (uShadowDbg > 1.5 && dbgShadow > 0.002) {
    gl_FragColor = vec4(mix(min(light, vec3(1.25)), vec3(1.6, 0.0, 0.0), clamp(dbgShadow * 1.6, 0.0, 1.0)), 1.0);
    return;
  }
  gl_FragColor = vec4(min(light, vec3(1.25)), 1.0);
}
`;

const FIELD_KEY = "night-light-field";
/** Per-cell ROOM MASK: R = 255 where the cell belongs to the room the local
 * player is standing in. One texel per world cell, NEAREST — see roomAt(). */
/* THE BLOCK-MAX HEIGHT TEXTURE — see the surface-resolve march. One texel per
 * BLOCK×BLOCK cells holding the maximum of uHeight's R over the block, in the
 * same byte packing, so a march can prove a whole block cannot be hit and skip
 * its fetches. Built beside the heightmaps in buildHeightmap. */
/** THE LIGHT FIELDS' RESOLUTION, as a fraction of the canvas (dev A/B for the
 *  maintainer's phone): `?light=0.5` renders the three full-screen passes
 *  (light, mist, depth fog) at half size and upsamples them LINEAR, i.e. a
 *  quarter of the fragments; remembered in localStorage `ml-light-scale`,
 *  `?light=1` restores. The passes sample everything normalised over uCam and
 *  Phaser sets `resolution` to the shader's own size, so nothing else moves. */
function lightScale(): number {
  try {
    const q = new URLSearchParams(location.search).get("light");
    if (q !== null) {
      const v = Number(q);
      if (Number.isFinite(v) && v > 0 && v <= 1) {
        localStorage.setItem("ml-light-scale", String(v));
        return v;
      }
    }
    const v = Number(localStorage.getItem("ml-light-scale"));
    if (Number.isFinite(v) && v > 0 && v <= 1) return v;
  } catch {
    /* storage/location blocked: full size */
  }
  return 1;
}

const BLOCK = 8;
const BLOCK_KEY = "world-heightmap-blockmax";

const ROOM_KEY = "world-room-mask";
const MIST_KEY = "mist-field";
const DEPTHFOG_KEY = "depthfog-field";

/** MIST weather (WorldState.weather === 2) — a creeping ground fog.
 *
 * The maintainer's brief: "a mysterious fog that follows the ground and
 * often appears over lakes and open fields... can also appear inside a
 * forest. The feeling is creepy. The mist must look like it actually is
 * part of the world and close to the ground — it must move in the same
 * isotropic coordinate system."
 *
 * So the fog is a WORLD-anchored field, not a screen effect: this fragment
 * runs the SAME exact-crossing surface resolve as the night shader (each
 * pixel finds the terrain cell + height it shows), and the fog density
 * pools by that height — full strength on level ≤0 ground (lakes, fields),
 * gone by ~2.5 levels, so banks hug valleys and stop against cliffs. The
 * noise banks drift along the WORLD axes (uAnimTime), which on screen is a
 * slow creep along the iso diagonals — the mist visibly belongs to the
 * ground plane. Drawn as its own NORMAL-blend overlay ABOVE the light
 * overlay and the avatars (depth 1_000_000): fog covers whoever wades
 * into it. Density is posterized into bands so the fog reads as stylized
 * pixel-art layers, not photographic smoke; the colour is a cold pale
 * grey dimmed by the ambient so night mist looms instead of glowing.
 * EXACT JS twin: mistAt() — change BOTH together. */
const MIST_FRAG = `
precision highp float;

uniform vec2 resolution;
uniform float uAnimTime;
uniform vec4 uCam;        // worldView x, y, w, h (world-render px)
uniform vec4 uIsoA;       // ox, oy, dx, dy
uniform vec4 uIsoB;       // lh, gridW, gridH, maxLevel
uniform sampler2D uHBlock; // BLOCK×BLOCK block-max of uHeight.r (unbound sampler = unit 0!)
uniform vec2 uHBlockN;     // the block grid's size
uniform float uSkip;       // 1 = uHBlock is bound and the march may skip whole blocks
uniform float uHScale;    // levels→byte pack scale (per-world; 16 unless the world tops ~15 levels)
uniform vec3 uAmbient;    // current grade — mist dims with the night
uniform float uMist;      // eased cover 0..1
uniform float uFlip;
uniform sampler2D uHeight;

float heightAt(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 99.0;
  vec2 uv = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  return texture2D(uHeight, uv).r * 255.0 / uHScale;
}
// Same precision-exact hash as cwHash (see there) — twin of mistAt().
float mHash(vec2 i) {
  float a = mod(i.x * 113.0 + i.y * 271.0, 971.0);
  a = mod(a * a + 113.0, 971.0);
  a = mod(a * a + i.x, 971.0);
  a = mod(a * a + i.y, 971.0);
  return a / 971.0;
}
float mNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u2 = f * f * (3.0 - 2.0 * f);
  return mix(mix(mHash(i), mHash(i + vec2(1.0, 0.0)), u2.x),
             mix(mHash(i + vec2(0.0, 1.0)), mHash(i + vec2(1.0, 1.0)), u2.x), u2.y);
}

// The largest surface height any cell of block b can report through
// heightAt — the same decode as heightAt, so it bounds it exactly; a block
// outside the world answers 99 (= never skip; heightAt says 99 there too).
float blockMaxAt(vec2 b) {
  if (b.x < 0.0 || b.y < 0.0 || b.x >= uHBlockN.x || b.y >= uHBlockN.y) return 99.0;
  return texture2D(uHBlock, (b + 0.5) / uHBlockN).r * 255.0 / uHScale;
}

void main() {
  /* THE PASS IS NEVER SKIPPED, SO IT MUST SKIP ITSELF, and this guard was 30
   * lines too late. setVisible(false) does NOT stop a Shader that has
   * setRenderToTexture: Shader.willRender returns true unconditionally in that
   * case, so the mist pass ran a full canvas-sized fragment program EVERY FRAME
   * with clear weather, and the uMist test sat AFTER the 128-iteration surface
   * march that is the expensive part. DEPTHFOG_FRAG has always had its uFog
   * guard on the first line of main; this is the same guard, and it is
   * pixel-identical because the old code answered vec4(0.0) for exactly these
   * fragments anyway. */
  if (uMist <= 0.001) { gl_FragColor = vec4(0.0); return; }
  vec2 suv = gl_FragCoord.xy / resolution;
  float wx = uCam.x + suv.x * uCam.z;
  float wy = uCam.y + mix(suv.y, 1.0 - suv.y, uFlip) * uCam.w;
  float u = (wx - uIsoA.x) / uIsoA.z - 1.0;
  float v0 = (wy - uIsoA.y) / uIsoA.w;
  float kk = uIsoB.x / uIsoA.w;
  // Surface resolve — same exact cell-boundary walk as the night shader.
  float vTop = v0 + uIsoB.w * kk;
  float z = 0.0;
  bool found = false;
  float vHi = vTop;
  // WALK BUDGET: sweeping from the max-level candidate down to level 0 needs
  // about maxLevel*(lh/dy) iterations (~1.07 per level on maps2 geometry; the
  // per-pixel step phase makes it vary by screen column). The old cap of 36
  // was sized for the <=15-level worlds: on the_island2 (max level 40) every
  // pixel whose true surface sits deeper than the budget NEVER RESOLVED, and
  // the !found fallback painted it flat-ambient (no sun/shadows), fog-less
  // and mist-less — the maintainer's "shadows don't work on low elevation,
  // fine on other maps" report, measured at 100% of pixels starved on a
  // level-0 gorge floor via the uTest=4 classification. 128 covers ~85-level
  // worlds; break-on-found keeps the cost proportional to each pixel's real
  // depth (a plain continue guard would tick all 128 iterations per fragment
  // — that alone stalled the software-GL harness across 3 fullscreen passes).
  vec2 blk = vec2(-9.0);
  float hb = 99.0;
  for (int s = 0; s < 128; s++) {
    if (found || vHi <= v0 - 1.5) break;
    float vColB = 2.0 * floor((vHi + u) * 0.5 - 0.0001) - u;
    float vRowB = 2.0 * floor((vHi - u) * 0.5 - 0.0001) + u;
    float vLo = max(vColB, vRowB);
    float vMid = (vHi + vLo) * 0.5;
    vec2 cr = vec2((u + vMid) * 0.5, (vMid - u) * 0.5);
    // THE HIERARCHICAL SKIP. This walk starts at the WORLD's max level and
    // pays one dependent fetch per cell until the first column whose top
    // reaches the segment — 44 per pixel per pass on level-0 ground under a
    // 40-level world, the forest spots' whole lag (investigation 2026-09-02).
    // A cell is hit iff v0 + H*kk >= vLo; every H in this block is <= the
    // block's max, so when v0 + hb*kk < vLo no cell in it can be hit and the
    // fetch is skipped. ONLY the fetch: the walk's arithmetic, vLo, vMid, cr
    // and the hit test are untouched, so z, cell and everything downstream
    // are bit-identical (uSkip is the A/B switch; parity is pinned on the
    // pass's own pixels by __ml.nightHash).
    vec2 b = floor(cr * 0.125);
    if (uSkip > 0.5 && (b.x != blk.x || b.y != blk.y)) { blk = b; hb = blockMaxAt(b); }
    if (uSkip > 0.5 && v0 + hb * kk < vLo - 0.0001) { vHi = vLo; continue; }
    float H = heightAt(cr);
    if (H < 90.0) {
      float vSurf = v0 + H * kk;
      if (vSurf >= vLo - 0.0001) {
        z = max((min(vHi, vSurf) - v0) / kk, 0.0);
        found = true;
      }
    }
    vHi = vLo;
  }
  if (!found || uMist <= 0.001) { gl_FragColor = vec4(0.0); return; }

  // Fog banks drifting along the WORLD axes (screen: the iso diagonals).
  vec2 w = vec2(wx, wy);
  vec2 p1 = w * 0.0026 + uAnimTime * vec2(0.055, 0.030);
  float banks = smoothstep(0.30, 0.60, mNoise(p1) * 0.6 + mNoise(p1 * 2.1 + 13.0) * 0.4);
  vec2 p2 = w * 0.0074 + uAnimTime * vec2(-0.030, 0.048);
  float roil = 0.55 + 0.45 * mNoise(p2);
  // Hug the ground: full in the low (lakes/open fields), gone by ~2.5 levels.
  float pool = clamp(1.0 - (z - 0.4) * 0.5, 0.0, 1.0);
  float d = clamp(banks * roil * 1.55, 0.0, 1.0) * pool * uMist;
  // Posterized bands = stylized pixel-art fog layers, capped so the ground
  // still ghosts through the thickest bank.
  float a = floor(d * 5.0 + 0.001) / 5.0 * 0.74;
  if (a <= 0.001) { gl_FragColor = vec4(0.0); return; }
  float ambLum = (uAmbient.r + uAmbient.g + uAmbient.b) / 3.0;
  vec3 col = vec3(0.72, 0.78, 0.76) * clamp(0.22 + 0.95 * ambLum, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a); // premultiplied for Phaser's NORMAL blend
}
`;

// ELEVATION DEPTH-FOG (maintainer: "make it easier to see the different ground
// levels"). A NORMAL-blend overlay keyed to each ground pixel's resolved level
// RELATIVE TO THE PLAYER (uPlayerZ): the player's own plane stays untouched, the
// layers BELOW fade into a teal atmospheric HAZE (the enchanted-forest look on
// the character screen), the layers ABOVE sink into a DARK fog of the SAME palette
// — so a cliff edge that used to vanish (looking down off a plateau, or a wall
// rising behind you) now separates by depth. Uses the SAME exact surface resolve
// as the light + mist passes, so faces get a smooth per-pixel gradient (clean
// bands between tops, a soft ramp down/up each cliff face). Composited ABOVE the
// light overlay but BELOW the lit avatar copies, so it fogs the WORLD, not the
// characters. Tunable: uFog is a 0..1 master strength (0 = off = instant rollback).
const DEPTHFOG_FRAG = `
precision highp float;

uniform vec2 resolution;
uniform vec4 uCam;        // worldView x, y, w, h (world-render px)
uniform vec4 uIsoA;       // ox, oy, dx, dy
uniform vec4 uIsoB;       // lh, gridW, gridH, maxLevel
uniform sampler2D uHBlock; // BLOCK×BLOCK block-max of uHeight.r (unbound sampler = unit 0!)
uniform vec2 uHBlockN;     // the block grid's size
uniform float uSkip;       // 1 = uHBlock is bound and the march may skip whole blocks
uniform float uHScale;    // levels→byte pack scale (per-world; 16 unless the world tops ~15 levels)
uniform vec3 uAmbient;    // current grade — the haze dims with the night
uniform float uPlayerZ;   // the local player's current surface LEVEL
uniform vec2  uPlayerXY;  // the local player's cell (col, row)
uniform float uFog;       // master strength 0..1 (0 = pass outputs nothing)
uniform float uFlip;
uniform sampler2D uHeight;
uniform sampler2D uHeightL; // terrain height, LINEAR — smooth (bilinear) sampling
uniform sampler2D uRoom;    // the room mask (membership in the 128 bit — see setRoom)
uniform float uRoomOn;      // 1 when uRoom is bound (unbound sampler = unit 0!)
uniform float uIndoorMix;   // the eased indoor blend — fog outside MY room fades with it


// Tunables (named consts). CEL-SHADED DEPTH FOG whose JOB is to HIGHLIGHT CLIFF EDGES
// (maintainer: "see the exact edge where the cliff starts / the ground ends"). TWO
// channels, summed then POSTERIZED once into snappy cel bands (teal FOG_NEAR → pale misty
// FOG_FAR): (1) a SMOOTH horizontal-DISTANCE term — flat ground reads as clean concentric
// bands (drape-reconstructed col/row, no per-tile zigzag) and it doubles as a MAX VIEW
// DISTANCE (network cull handle); (2) a HARD ELEVATION term keyed to the march's resolved
// surface level vs the player's, that snaps a band boundary ONTO the drawn cliff-top edge
// — the clear-top → hazy-below contrast IS the edge. Symmetric both ways (ground below AND
// a wall above foggier, same palette). (A pure 3D-distance SPHERE was tried and rejected:
// its bands are iso-distance rings that float across the terrain, never landing on an edge.)
const vec3  FOG_NEAR = vec3(0.30, 0.52, 0.50); // first band: teal
const vec3  FOG_FAR  = vec3(0.72, 0.88, 0.90); // farthest band: pale misty cyan
const float BANDS  = 6.0;   // cel-shade steps — band 0 is the clear near bubble
const float FOG_D0 = 11.0;  // ONSET (cells): distance fog starts this far out. Fires on ALL ground,
                            // but the per-level TRANSPARENCY below fades it to SAME_LEVEL_FOG on
                            // the player's own level, so it isn't a hard ring on the flat you're on.
const float FOG_DW = 1.2;   // width of each cel band past the onset (cells) — smaller = the
                            // distance haze on other levels INTENSIFIES faster (tighter bands).
const float FOG_MAX = 0.78; // opacity of the farthest band (the cull edge)
const float FOG_DEEP_MAX  = 1.0;  // opacity ceiling for the DEEP zone (elevation past band saturation)
const float FOG_DEEP_RATE = 0.5; // thickening speed per overflow band once the cel bands max out
const float DRAPE_RS = 2.5; // drape blur half-width along the col+row fold axis (s-units)
const float ELEV_STEP = 0.5; // fog BANDS added per LEVEL of player↔surface separation past the
                             // dead-zone. 0.5 ⇒ +1 band every ~2 levels (gentle Z ramp — maintainer
                             // "don't increase it so rapidly, ~every 2nd level"). Raise = steeper.
const float ELEV_EPS  = 0.05;// tiny FP dead-zone absorbing the resolve's jitter in z.
const float ELEV_D0   = 7.0; // ELEVATION DEAD-ZONE: no edge fog until the surface is this many
                             // LEVELS from the player — a regular house/roof stays CLEAR (its
                             // small step is read from the map's distinct tiles); only a real
                             // MOUNTAIN climb fogs (maintainer). Raise = fog fires only on taller
                             // cliffs; lower = fires on smaller drops.
const float SAME_LEVEL_FOG  = 0.10; // OPACITY multiplier on the player's OWN level — the fog there
                                    // is faded to 10% (maintainer), NOT removed.
const float LEVEL_FADE_SPAN = 15.0; // levels of |Δz| over which that fade ramps back to FULL
                                    // opacity. Set so the per-level opacity increase is ~0.06/level
                                    // ((1−SAME_LEVEL_FOG)/SPAN = 0.90/15) — a GENTLER climb than the
                                    // old 0.088/level, which went too opaque too fast up a tall wall
                                    // (maintainer: "6% each Z-step"); floor stays 10% on your level.

float heightAt(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 99.0;
  vec2 uv = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  return texture2D(uHeight, uv).r * 255.0 / uHScale;
}
// TERRAIN-ONLY surface height (levels), bilinear + edge-clamped. uHeightL packs
// R = occlusion height (terrain + solid/prop bump, or a deck slab) and G = the
// PLACED-PROP share, so R-G is the walkable ground/deck height with scattered props
// REMOVED — the field the fog sphere should measure against, so a boulder never
// bulges the bands on flat ground. Clamp a half-texel inside the grid so wide drape
// taps at the map border repeat the edge value (no rim darkening).
float terrH(vec2 cr) {
  vec2 g = vec2(uIsoB.y, uIsoB.z);
  vec2 c = clamp(cr, vec2(0.5), g - vec2(0.5));
  vec2 rg = texture2D(uHeightL, c / g).rg;
  return (rg.r - rg.g) * 255.0 / uHScale;
}
// DRAPE: anisotropic blur of the terrain height, WIDE along the iso depth axis
// s = col+row (one s-step = (0.5,0.5) in col,row — the ONLY screen axis the surface
// folds/steps along; every single-cell terrain edge has a nonzero s component, so a
// fold-axis blur smooths them all). Half-width DRAPE_RS drops a 1/2/3-level cliff's
// blurred slope below the fold threshold 1/kk = dy/lh = 0.68, so faces become smooth
// ramps. Weights sum to 1 (a flat region returns its exact level → flat ground stays
// clean circles). 5 taps.
float drape(vec2 cr) {
  vec2 e = vec2(0.5, 0.5);            // +1 in s = col+row = the depth/fold axis
  float R = DRAPE_RS;
  float h  = 0.24 * terrH(cr);
  h += 0.22 * terrH(cr + (0.5 * R) * e);
  h += 0.22 * terrH(cr - (0.5 * R) * e);
  h += 0.16 * terrH(cr + R * e);
  h += 0.16 * terrH(cr - R * e);
  return h;
}

// The largest surface height any cell of block b can report through
// heightAt — the same decode as heightAt, so it bounds it exactly; a block
// outside the world answers 99 (= never skip; heightAt says 99 there too).
float blockMaxAt(vec2 b) {
  if (b.x < 0.0 || b.y < 0.0 || b.x >= uHBlockN.x || b.y >= uHBlockN.y) return 99.0;
  return texture2D(uHBlock, (b + 0.5) / uHBlockN).r * 255.0 / uHScale;
}

void main() {
  if (uFog <= 0.003) { gl_FragColor = vec4(0.0); return; }
  vec2 suv = gl_FragCoord.xy / resolution;
  float wx = uCam.x + suv.x * uCam.z;
  float wy = uCam.y + mix(suv.y, 1.0 - suv.y, uFlip) * uCam.w;
  float u = (wx - uIsoA.x) / uIsoA.z - 1.0;
  float v0 = (wy - uIsoA.y) / uIsoA.w;
  float kk = uIsoB.x / uIsoA.w;
  // Surface resolve — the SAME exact cell-boundary walk as the night/mist shaders.
  float vTop = v0 + uIsoB.w * kk;
  float z = 0.0;
  vec2 cell = vec2(0.0); // resolved surface cell (col,row) — for the horizontal dist
  bool found = false;
  float vHi = vTop;
  // WALK BUDGET: sweeping from the max-level candidate down to level 0 needs
  // about maxLevel*(lh/dy) iterations (~1.07 per level on maps2 geometry; the
  // per-pixel step phase makes it vary by screen column). The old cap of 36
  // was sized for the <=15-level worlds: on the_island2 (max level 40) every
  // pixel whose true surface sits deeper than the budget NEVER RESOLVED, and
  // the !found fallback painted it flat-ambient (no sun/shadows), fog-less
  // and mist-less — the maintainer's "shadows don't work on low elevation,
  // fine on other maps" report, measured at 100% of pixels starved on a
  // level-0 gorge floor via the uTest=4 classification. 128 covers ~85-level
  // worlds; break-on-found keeps the cost proportional to each pixel's real
  // depth (a plain continue guard would tick all 128 iterations per fragment
  // — that alone stalled the software-GL harness across 3 fullscreen passes).
  vec2 blk = vec2(-9.0);
  float hb = 99.0;
  for (int s = 0; s < 128; s++) {
    if (found || vHi <= v0 - 1.5) break;
    float vColB = 2.0 * floor((vHi + u) * 0.5 - 0.0001) - u;
    float vRowB = 2.0 * floor((vHi - u) * 0.5 - 0.0001) + u;
    float vLo = max(vColB, vRowB);
    float vMid = (vHi + vLo) * 0.5;
    vec2 cr = vec2((u + vMid) * 0.5, (vMid - u) * 0.5);
    // THE HIERARCHICAL SKIP. This walk starts at the WORLD's max level and
    // pays one dependent fetch per cell until the first column whose top
    // reaches the segment — 44 per pixel per pass on level-0 ground under a
    // 40-level world, the forest spots' whole lag (investigation 2026-09-02).
    // A cell is hit iff v0 + H*kk >= vLo; every H in this block is <= the
    // block's max, so when v0 + hb*kk < vLo no cell in it can be hit and the
    // fetch is skipped. ONLY the fetch: the walk's arithmetic, vLo, vMid, cr
    // and the hit test are untouched, so z, cell and everything downstream
    // are bit-identical (uSkip is the A/B switch; parity is pinned on the
    // pass's own pixels by __ml.nightHash).
    vec2 b = floor(cr * 0.125);
    if (uSkip > 0.5 && (b.x != blk.x || b.y != blk.y)) { blk = b; hb = blockMaxAt(b); }
    if (uSkip > 0.5 && v0 + hb * kk < vLo - 0.0001) { vHi = vLo; continue; }
    float H = heightAt(cr);
    if (H < 90.0) {
      float vSurf = v0 + H * kk;
      if (vSurf >= vLo - 0.0001) {
        z = max((min(vHi, vSurf) - v0) / kk, 0.0);
        cell = cr;
        found = true;
      }
    }
    vHi = vLo;
  }
  if (!found) { gl_FragColor = vec4(0.0); return; }

  // ==== DEPTH FOG: SMOOTH horizontal distance + HARD elevation EDGE ============
  // The fog's JOB is to make cliff EDGES readable (maintainer). Two channels, one
  // cel-snap: (1) a SMOOTH 2D-distance term = flat-ground depth + the max-view cull
  // (drape reconstruction, zigzag-free); (2) a HARD elevation-difference term that
  // puts the fog CONTRAST exactly on the drawn cliff TOP edge. Summed, posterized once.

  // (1) SMOOTH HORIZONTAL POSITION. Seed the surface height at the player's own level
  // (a CONSTANT → exactly smooth in screen space), iterate the anisotropic terrain
  // blur ×3, take the EXACT iso inverse. scol/srow are smooth screen fields, so their
  // 2D distance reads as clean concentric bands on flat ground (no per-tile staircase)
  // and doubles as the far cull. Elevation is handled HARD below — nothing draped.
  float sz = uPlayerZ;
  for (int i = 0; i < 3; i++) {
    float svi = v0 + sz * kk;
    sz = drape(vec2((u + svi) * 0.5, (svi - u) * 0.5));
  }
  float sv = v0 + sz * kk;            // col+row at the smooth surface height
  float scol = (u + sv) * 0.5;        // EXACT iso inverse (u, v0 already smooth)
  float srow = (sv - u) * 0.5;
  float distH = length(vec2(scol - uPlayerXY.x, srow - uPlayerXY.y)); // 2D only
  // Same onset/spacing/cull as before: band 1 at FOG_D0, +1 every FOG_DW cells, full
  // fog (= the max view distance) at FOG_D0 + (BANDS-2)*FOG_DW ≈ 18.3 cells. The floor()
  // CEL-SNAPS it into crisp concentric rings — the organic look on flat ground.
  float distCont = (distH - FOG_D0) / FOG_DW + 1.0;
  // BUT a near-vertical cliff FACE compresses many rings into a few screen pixels, so those
  // hard rings STAIRCASE — the diagonal bands that CHEVRON where two faces meet (the
  // maintainer's zigzag). A face pixel resolves to its HIGH lip cell, so heightAt(cell)
  // sits well above the marched surface z: use that gap as "how far DOWN a face this pixel
  // is" and, as it grows, DROP the cel-snap so the face fades to the SMOOTH ring value — a
  // clean gradient, no hard staircase. On every flat/tread heightAt(cell)==z ⇒ faceDepth 0
  // ⇒ full cel-snap ⇒ the crisp rings are byte-for-byte unchanged.
  float faceDepth = max(0.0, heightAt(cell) - z);
  float faceMix = clamp(faceDepth - 0.5, 0.0, 1.0); // skip the ≤½-level resolve jitter at the lip
  float distBand = clamp(mix(floor(distCont), distCont, faceMix), 0.0, BANDS - 1.0);

  // (2) HARD ELEVATION EDGE — the core goal. Use the march's OWN resolved surface
  // height z (NOT heightAt(cell)): a cliff-FACE pixel resolves to the HIGH cell, so
  // heightAt(cell) is constant across the top AND face and only steps at the FOOT —
  // but z equals the player's integer level exactly on the tread and drops the instant
  // a pixel is past the lip, so the {z == player level} boundary IS the drawn top edge.
  // Round the eased fractional player elevation to its LEVEL so a jump/fall can't pulse
  // the field. abs() ⇒ symmetric both ways (ground below AND a wall above fog the same,
  // same palette). The ELEV_D0 DEAD-ZONE means SMALL elevation changes get NO fog — the
  // map's distinct tiles make those edges clear; fog is reserved for BIG cliffs (the
  // maintainer designs cliffs > ~10 levels for it). Past the dead-zone the fog snaps up,
  // and because the dead-zone eats the near part of a rising face, the contrast on a cliff
  // ABOVE the player moves UP toward its real top edge. z is constant across same-level
  // ground, so this adds ZERO contour on flats: it can't recreate the flat-ground zigzag.
  float pLev = uPlayerZ;                           // player's EASED elevation (NOT rounded) — so
                                                   // the fog FOLLOWS a jump/fall's z smoothly as
                                                   // it animates, instead of snapping at the
                                                   // half-level. Standing still it's a stable
                                                   // integer, so flats/edges are unaffected.
  float dLev = abs(pLev - z);                      // levels of separation
  // elevBand's hard ceil() staircase was the residual "fog sawtooth on cliff faces" (#62):
  // constant-z lines run diagonally across the iso side-face, so every ceil step drew a hard
  // diagonal fog contour that the follow-camera slid across the wall (maintainer 2026-07-24).
  // Mirror EXACTLY the face-smoothing distBand already has (line above, mix(floor,cont,faceMix)):
  // cel-snap only where faceMix<1 (flats, treads, the ≤1.5-level lip), and pass the SMOOTH ramp on
  // the face body (faceMix=1) so the face is one continuous gradient — no staircase, nothing to
  // slide. faceMix=0 ⇒ ceil(elevCont-ELEV_EPS) == the old expression float-for-float, so flats and
  // the cliff-top edge highlight are byte-identical; only the mid-face steps are smoothed.
  float elevCont = max(0.0, dLev - ELEV_D0) * ELEV_STEP;                    // smooth pre-snap ramp (0 in the dead-zone)
  // NO ceil-snap (maintainer 2026-07-24): the elevation band is the SMOOTH elevCont EVERYWHERE. The old
  // mix(ceil(elevCont-ELEV_EPS), elevCont, faceMix) snapped the flat mountain TOP (faceMix=0) up a fraction of a
  // band above the smooth face (faceMix=1), which drew a HARD step in band/a right at the cliff-top rim — the
  // "sharp line" (a yellow->white jump the maintainer marked on the fog debug heatmap) while every other transition
  // interpolated. Using elevCont on the top too makes it grade into the face identically (proven: the a-map's
  // vertical step at the rim vanished). Same-level flats are byte-identical (elevCont=0 in the dead-zone), the face
  // body is byte-identical (it was already elevCont at faceMix=1), and the distBand distance-rings are untouched.
  float elevBand = elevCont;

  // COMBINE + CEL-SNAP. Additive (NOT max) so a mid-range edge always adds its step on top of
  // the distance band. Both channels fire on ALL ground; the per-level TRANSPARENCY (below) is
  // what keeps the player's own level subtle — a soft fade, NOT the old hard gate (maintainer
  // took that back).
  float rawBand = distBand + elevBand;           // UNCLAMPED: elevBand grows past the cap for deep |Δlevel|
  float band = clamp(rawBand, 0.0, BANDS - 1.0); // downstream bf/colour/levelFade unchanged
  float bf = band / (BANDS - 1.0);
  // PER-LEVEL TRANSPARENCY (maintainer's knob): scale the fog OPACITY by |Δlevel| — faded to
  // SAME_LEVEL_FOG (10%) on the player's OWN level, ramping linearly (~6%/level) back to FULL by
  // LEVEL_FADE_SPAN (15) levels of separation. So your own level barely hazes, ~1 level off a
  // touch more … and 15+ levels away reads at full strength (a bridge high in the air).
  float levelFade = clamp(SAME_LEVEL_FOG + (1.0 - SAME_LEVEL_FOG) * (dLev / LEVEL_FADE_SPAN),
                          SAME_LEVEL_FOG, 1.0);
  // DEEP-THICKEN: the cel bands saturate at BANDS-1, so the z-elevation fog stopped densifying past
  // that point (maintainer 2026-07-24: a deep gorge/tall wall should keep thickening below the max-out
  // line). Capture the overflow past the cap and push OPACITY from FOG_MAX toward FOG_DEEP_MAX. distBand
  // is individually clamped to [0,BANDS-1] (above), so overflow is driven ONLY by elevation — flat ground
  // maxed by horizontal distance is untouched. The ternary keeps deep an EXACT 0 at/below saturation, so
  // everything up to the max-out line is byte-identical (no dependence on exp(0) rounding) and there's no
  // seam. Colour stays FOG_FAR (bf clamped) — only opacity thickens. levelFade still governs.
  float overflow = max(0.0, rawBand - (BANDS - 1.0));
  float deep = overflow > 0.0 ? (1.0 - exp(-overflow * FOG_DEEP_RATE)) : 0.0;
  float density = mix(bf * FOG_MAX, FOG_DEEP_MAX, deep); // == bf*FOG_MAX where deep==0
  float a = density * uFog * levelFade;
  // INDOORS THE FOG BELONGS TO MY ROOM ALONE (the scoped-cut era exposed
  // this: with the neighbourhood drawn again, the pale far bands painted a
  // GLOWING RING over the zero-ambient blackness beyond ~11 cells — daylight
  // haze over a world that, from in here, has no daylight). Fade fog on
  // cells outside my room exactly as their ambient fades, on the same eased
  // mix; fail OPEN when the mask is not bound (the pre-existing look).
  if (uIndoorMix > 0.001 && uRoomOn > 0.5) {
    float inR = 0.0;
    if (cell.x >= 0.0 && cell.y >= 0.0 && cell.x < uIsoB.y && cell.y < uIsoB.z)
      inR = step(0.5, texture2D(uRoom, (floor(cell) + 0.5) / vec2(uIsoB.y, uIsoB.z)).r);
    a *= mix(1.0, inR, uIndoorMix);
  }
  if (a <= 0.002) { gl_FragColor = vec4(0.0); return; }
  vec3 col = mix(FOG_NEAR, FOG_FAR, bf); // same palette both directions
  // Dim with the night, but keep a floor so the tones still read in the dark.
  float ambLum = (uAmbient.r + uAmbient.g + uAmbient.b) / 3.0;
  col *= clamp(0.45 + 0.7 * ambLum, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a); // premultiplied for Phaser's NORMAL blend
}
`;

/** Glow stamps for every visible emission source (tile-emission@2).
 *
 * For each cell whose category+variant has per-pixel sources: `up` sources
 * sit on the TOP drawn tile instance (lower instances' tops are buried in
 * the column); `sw`/`se` face sources repeat on every stacked instance whose
 * face is actually exposed (above the s/e neighbour's terrain), biased a few
 * px outward so the halo lands on the ground/walls beside the emitter, not
 * inside the block. Solid objects (spires…) are billboard art — all their
 * sources stamp once on the drawn art. Capped to the nearest `maxStamps`. */
export function buildGlowStamps(
  world: World,
  emission: EmissionMap,
  iso: { ox: number; oy: number },
  win: { x0: number; y0: number; x1: number; y1: number },
  maxLevel: number,
  maxStamps = 500, // one RT sprite-draw per stamp per frame — hundreds are cheap
  artYOff?: (t: string, v: number) => number, // bottom-anchor shift for 64x128 art
  anchorOnce = false, // demo: art is drawn ONCE at ground level — every source
  // stamps at its art position instead of repeating down a stacked column
): GlowStamp[] {
  // THE WORLD'S OWN PROJECTION, not the module constant — a maps3 world draws
  // on dy=14/lh=15 and a stamp placed at 15/16 lands a level off by the far
  // side of the map.
  const { dx, dy, lh } = geometryFor(world);
  const ANIM: Record<string, number> = { static: 0, pulse: 1, flicker: 2 };
  const out: GlowStamp[] = [];
  const u0 = Math.floor((win.x0 - iso.ox) / dx) - 1;
  const u1 = Math.ceil((win.x1 - iso.ox) / dx) + 1;
  const v0 = Math.max(0, Math.floor((win.y0 - iso.oy) / dy) - 1);
  const v1 = Math.ceil((win.y1 - iso.oy + maxLevel * lh) / dy) + 1;
  for (let v = v0; v <= v1; v++) {
    for (let u = u0; u <= u1; u++) {
      if ((u + v) & 1) continue;
      const col = (u + v) / 2;
      const row = (v - u) / 2;
      const cell = world.rows[row]?.[col];
      if (!cell) continue;
      const em = emission[cell.t];
      const srcs = em?.sources?.[String(cell.v)];
      if (!srcs?.length) continue;
      const sf = surfaceFor(cell.t);
      const solid = !sf.standable && !sf.swimmable;
      const bx = iso.ox + u * dx;
      const by = iso.oy + v * dy - (artYOff?.(cell.t, cell.v) ?? 0);
      const anim = ANIM[em!.anim] ?? 0;
      const lS = world.rows[row + 1]?.[col]?.l ?? cell.l;
      const lE = world.rows[row]?.[col + 1]?.l ?? cell.l;
      for (let i = 0; i < srcs.length; i++) {
        const g = srcs[i];
        const phase = ((((col * 73856093) ^ (row * 19349663) ^ (i * 83492791)) >>> 0) % 628) / 100;
        // Tuned for TRUE additive blending: overlapping halos sum, so a
        // dense cluster must not blow out to white (colour dies at clamp).
        const radius = Math.min(90, 8 + g.r * 4);
        const alpha = Math.min(1, g.s * 0.45);
        const off = 2 + g.r * 0.6;
        const push = (k: number, ox2: number, oy2: number) =>
          out.push({ x: bx + g.x + ox2, y: by - k * lh + g.y + oy2, radius, color: g.color, alpha, anim, phase });
        if (anchorOnce || solid || g.dir === "up") {
          const ox2 = g.dir === "sw" ? -off : g.dir === "se" ? off : 0;
          push(cell.l, ox2, g.dir === "up" ? 0 : off * 0.5);
        } else if (g.dir === "sw") {
          for (let k2 = Math.max(lS + 1, cell.l - 2); k2 <= cell.l; k2++) push(k2, -off, off * 0.5);
        } else {
          for (let k2 = Math.max(lE + 1, cell.l - 2); k2 <= cell.l; k2++) push(k2, off, off * 0.5);
        }
      }
    }
  }
  if (out.length > maxStamps) {
    const cx = (win.x0 + win.x1) / 2;
    const cy = (win.y0 + win.y1) / 2;
    out.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
    out.length = maxStamps;
  }
  return out;
}

export class NightLights {
  private scene: Phaser.Scene;
  private world: World;
  private iso: { ox: number; oy: number };
  /** THE WORLD'S PROJECTION (maps.ts geometryFor). Every iso term in this file
   *  reads it: the light field, the mist inverse projection and the shader's
   *  own uIso uniforms all have to agree with what the ground RT drew. */
  private geo = MAP_GEOMETRY;
  private maxLevel: number;
  /** Per-world level→byte pack scale for the heightmaps (set in buildHeightmap).
   *  16 for worlds ≤15 levels (byte-identical to the historical encoding), less
   *  for taller worlds so their peaks don't clamp the 8-bit channel. */
  private hScale = 16;
  private base?: Phaser.Display.BaseShader;
  private shader?: Phaser.GameObjects.Shader;
  /** Reused by update(): the rectangle the camera renders THIS frame. */
  private viewRect: ViewRect = { x: 0, y: 0, width: 0, height: 0 };
  private overlay?: Phaser.GameObjects.Image;
  private mistBase?: Phaser.Display.BaseShader;
  private mistShader?: Phaser.GameObjects.Shader;
  private mistOverlay?: Phaser.GameObjects.Image;
  // Elevation depth-fog (separate NORMAL pass, below the lit avatar copies).
  private depthFogBase?: Phaser.Display.BaseShader;
  private depthFogShader?: Phaser.GameObjects.Shader;
  private depthFogOverlay?: Phaser.GameObjects.Image;
  /** Master strength of the elevation depth-fog (0 = off). Tunable via
   *  `__ml.depthFog(v)`; the maintainer may roll it to 0 to disable. */
  fogStrength = 1;
  /** Per-frame SCENE scale on top of `fogStrength`, kept separate so the debug
   * knob above still owns the master value. WorldScene drives it to 0 while the
   * player is INDOORS: the fog is a distance cue for open country, and inside a
   * room its teal/pale bands paint over the black void that is supposed to BE
   * the outside. 1 outdoors ⇒ every existing reading is unchanged. */
  fogScale = 1;
  /** Headless QA only: force the player level / cell the fog keys off (null = live). */
  fogTestZ: number | null = null;
  fogTestXY: [number, number] | null = null;
  private curPlayerZ = 0;
  private curPlayerXY: [number, number] = [0, 0];
  private posArr = new Float32Array(MAX_SHADER_LIGHTS * 4);
  private colArr = new Float32Array(MAX_SHADER_LIGHTS * 4);
  private fieldCount = 0;
  private hArr!: Float32Array; // CPU occlusion heights (terrain + solid objects)
  private pArr!: Float32Array; // CPU prop share (props get their own shade patch)
  private sArrH!: Float32Array; // CPU SCENERY share in the occlusion heights — setSceneryOccluders
  private sArrG!: Float32Array; // CPU SCENERY share in the ground column (trunk only)
  /** The linear and ground maps' pixels, retained so setSceneryOccluders can
   *  rewrite a few cells and re-upload (the setRoom pattern). */
  private imgL?: ImageData;
  private imgG?: ImageData;
  /** Cells the scenery layer wrote → what they held before it (R, G, groundR bytes;
   *  hArr, gArr, pArr floats): restored before every re-apply, so the layer is
   *  rebuilt from scratch exactly like the collision stamp. */
  private sceneryOrig = new Map<number, [number, number, number, number, number, number]>();
  /** Placement index → the self-exclusion radius² (cells²) its lit copy tints with. */
  private sceneryExcl = new Map<number, number>();
  hasSceneryShares = false; // read by the perf beacon
  /** Cells whose ground-map G carries the sun patch's sparse-gate flag (restored before a re-apply). */
  private sceneryDil: number[] = [];
  /** Dev switch (__ml.sceneryShadows): false = scenery casts nothing, terrain only. */
  sceneryShadows = true;
  /** What the last frame uploaded — the perf beacon's light-cost fields: lights
   *  in the shader, how many march shadows, the summed pool area in cells
   *  (the march's per-pixel bill scales with it), the ambient luma. */
  lightStats = { n: 0, shadowing: 0, poolCells: 0, ambient: 1 };
  /** THE LIGHT BILL, ACCUMULATED PER UPLOADED FRAME and drained by the perf
   *  beacon (`lightBill`). Means over the window, not the last frame: the cost
   *  correlates with how many lights were up WHILE the frames were timed, and
   *  the maintainer walks in and out of the town's pools during one window. */
  private bill = { frames: 0, n: 0, shadowing: 0, poolCells: 0, nMax: 0, shadowMax: 0, ambient: 1 };
  /** THE PASS UPDATE'S OWN MS, accumulated per update and drained with the
   *  light bill. `lighting` was the beacon run's biggest CPU section and its
   *  whole cost is THIS call — measured headless: 116 ms/frame of it against
   *  under 0.7 for every other part of that section — so it is split here.
   *  `glow` is the glow render-texture: a mid-frame framebuffer bind, which a
   *  TILER like his Mali-G715 pays for with a tile flush; the remainder is the
   *  73 uniform writes and the overlay bookkeeping. */
  private updMs = 0;
  private updGlowMs = 0;
  /** Dev switch (__ml.sceneryShadows(on, gate)): the sparse sun-patch gate (uPropGate). Identity when off. */
  sunGate = true;
  /** Measured costs, ms: the once-per-world heightmap build and the last scenery apply. */
  buildMs = 0;
  sceneryStats = { footprints: 0, cells: 0, gateCells: 0, ms: 0 };
  private tArr!: Float32Array; // CPU surface heights (terrain or deck slab)
  /** 1 while the local player is INDOORS: the surface resolve then ignores
   * decks, because indoor mode has culled every one of them from the render.
   * See heightAt() in the fragment for the measured reason. Mirrored into the
   * CPU twin (tAt) so sprite tints agree with the ground under them. */
  indoor = false;
  /** The cut-away's top level while `indoor` — WorldScene.indoorTop. The
   * building is DRAWN truncated here, so the surface resolve must be too, or
   * the floor behind a shortened wall resolves at the wall's full height and
   * every torch lighting it is attenuated across a gap that is not there. Only
   * the SURFACE resolve clamps; the occlusion march does not (the building is
   * still solid to the sun). See heightAt(). */
  indoorTop = 0;
  /** WorldScene.indoorGrade() — the LIGHT grade, 0..1: the raw eased mix at
   * 1.5×, clamped (since 2026-08-13 every light half of the crossing rides
   * this one ramp — a bit faster than the raw roll, deliberately slower than
   * the debris crossfade's 3×: geometry runs hot to hide repaint seams, the
   * darkening is meant to be seen). The outside fades to black on it instead
   * of snapping, so a doorway crossing is a fade rather than half the screen
   * going out one frame ahead of the room. Applied to the light only, never
   * to geometry (`indoor`/`indoorTop` stay boolean — the roof and the
   * truncated columns flip on the same frame regardless). */
  indoorMix = 0;
  /** The OUTDOOR grade — what the world outside my room is fading between (0
   * and this), never the interior dial. Written every frame while indoors; see
   * `uAmbientOut` in FRAG for why the two grades cannot be one uniform. */
  ambientOut: [number, number, number] = [0, 0, 0];
  /** The cells of the room the local player is in (cell indices). Drives BOTH
   * the shader's mask texture and the CPU twin, so a sprite tint and the
   * ground under it can never disagree about which side of a wall they are on.
   * Empty while outdoors, where roomAt() short-circuits to 1 anyway. */
  private roomCells = new Set<number>();
  /** Last published per-cell cut map (the constrained set) — kept so setRoom
   * can tell a dial turn (same cells, new cuts) from a no-op republish, and so
   * the CPU seam twin can clamp against the same per-cell heights the shader
   * does. Null = the legacy scalar cut. */
  private roomCuts: Map<number, number> | null = null;
  private roomTop = 0; // the scalar dial the last publish carried
  /** The room mask's pixel buffer, kept across calls so publishing a room is
   * one full-grid rewrite + one upload. See setRoom(). */
  private roomImg: ImageData | null = null;
  /** Did buildShader actually bind uRoom on the CURRENT shader? Re-derived on
   * every rebuild (a resize builds a new shader object). Drives uRoomOn. */
  private roomBound = false;
  /** Same, for the depth-fog pass's own program (bound in buildDepthFogShader). */
  private fogRoomBound = false;
  /** The mask's GREEN channel (cave depth) is world-static — written once. */
  private depthWritten = false;
  private underWritten = false;
  private bArr!: Float32Array; // CPU BASE terrain heights (AO seam twin — no decks)
  private gArr!: Float32Array; // CPU GROUND column tops (terrain + bump, no deck)
  private oArr!: Uint8Array;   // CPU solid-object flags
  private curLights: ShaderLight[] = [];
  private curStamps: GlowStamp[] = [];
  private curAmbient: [number, number, number] = [0.075, 0.09, 0.14];
  private emission: EmissionMap;
  private emitList: EmissionEntry[] = []; // palette order (index = shader eIdx)
  // Glow-halo field: world-anchored RT sharing the shader's exact window.
  private glowRT?: Phaser.GameObjects.RenderTexture;
  private glowDirty = false;
  /** The block-max grid's size (buildHeightmap) and the skip's A/B switch. */
  private blockN = { x: 1, y: 1 };
  private skipOn = true;
  private glowKey = "";
  private stampImg?: Phaser.GameObjects.Image;
  // Measured (off-centre stamp probe): this stack's RT samples straight, no
  // y-flip — same family of ground truth as fieldFlip above.
  glowFlip = 0;
  /** Switch (dev A/B): the fog silhouettes on scenery and props
   *  (WorldScene.applyObjectLights) — off = the old crisp lit copies. */
  sceneryFog = true;
  active = false;
  // Live calibration (debug keys): rendering-path differences between GPUs
  // showed up as flipped/scaled fields that headless verification could not
  // reproduce — let the tester find the correct combo on THEIR machine.
  fieldFlip = 0; // gradient ground-truth: this stack needs NO y-inversion
  overlayFlip = false; // additionally mirror the composited image
  // Field world-span multiplier around the view centre. 1.02 since
  // 2026-08-05: the overlays are drawn scale invZoom*k while uCam spans k×
  // the camera view — the two stretches cancel, so the world→screen mapping
  // is IDENTICAL to k=1 (screen-left still lands exactly on worldView.x; the
  // verify scripts' calibrated samples are untouched) but the drawn quad
  // overshoots the screen by ~1% per side. Without the bleed, fractional
  // camera zooms leave the quad a sub-pixel short of an edge, and on a
  // high-DPR phone that showed as a 1px UNSHADED bright line at the screen
  // edge at night (maintainer, device screenshot).
  spanScale = 1.02;
  testPattern = 0; // 1 = world-y gradient, 2 = cell grid vs art tiles
  /** Settings switch "shadows": 0 normal, 1 off, 2 red. Tells a SHADOW from a
   *  TILE at a glance — the maintainer's own instrument for the dotted zigzag,
   *  and the right one: a line that survives mode 1 is in the ground texture,
   *  a line that turns red in mode 2 is this pass. */
  shadowDbg = 0;
  /** OVERLAY ISOLATION (debug switch, 0 = normal). The zigzag is provably NOT
   *  in the ground texture — an exact unlit palette census at the maintainer's
   *  own cell and zoom found zero wall-coloured texels — so whatever draws it
   *  is one of the three full-screen overlays or the sampling to the display.
   *  1 drops the depth fog, 2 also the mist, 3 also the multiply light pass.
   *  A line that survives 3 is in the texture or the resample; one that
   *  disappears at a step names the pass that paints it. */
  dbgOverlays = 0;

  constructor(
    scene: Phaser.Scene,
    world: World,
    iso: { ox: number; oy: number },
    maxLevel: number,
    emission: EmissionMap = {},
  ) {
    this.scene = scene;
    this.world = world;
    this.iso = iso;
    this.geo = geometryFor(world);
    this.maxLevel = maxLevel;
    this.emission = emission;
  }

  create() {
    const tBuild = performance.now();
    this.buildHeightmap();
    this.buildMs = +(performance.now() - tBuild).toFixed(1);
    // MIST overlay shader (weather 2): declared uniforms only — the uSun
    // lesson applies here too (an undeclared uniform silently never syncs
    // on real phone GPUs).
    this.mistBase = new Phaser.Display.BaseShader("mist-field", MIST_FRAG, undefined, {
      uCam: { type: "4f", value: { x: 0, y: 0, z: 1, w: 1 } },
      uIsoA: { type: "4f", value: { x: 0, y: 0, z: this.geo.dx, w: this.geo.dy } },
      uIsoB: { type: "4f", value: { x: this.geo.lh, y: 1, z: 1, w: 0 } },
      uAmbient: { type: "3f", value: { x: 1, y: 1, z: 1 } },
      uMist: { type: "1f", value: 0 },
      uFlip: { type: "1f", value: 1 },
      uAnimTime: { type: "1f", value: 0 },
      uHScale: { type: "1f", value: 16 },
      uHeight: { type: "sampler2D", value: null },
      uHBlock: { type: "sampler2D", value: null },
      uHBlockN: { type: "2f", value: { x: 1, y: 1 } },
      uSkip: { type: "1f", value: 0 },
      uHasProps: { type: "1f", value: 0 },
    });
    // Elevation depth-fog shader (declared uniforms only — the uSun lesson).
    this.depthFogBase = new Phaser.Display.BaseShader("depthfog-field", DEPTHFOG_FRAG, undefined, {
      uCam: { type: "4f", value: { x: 0, y: 0, z: 1, w: 1 } },
      uIsoA: { type: "4f", value: { x: 0, y: 0, z: this.geo.dx, w: this.geo.dy } },
      uIsoB: { type: "4f", value: { x: this.geo.lh, y: 1, z: 1, w: 0 } },
      uAmbient: { type: "3f", value: { x: 1, y: 1, z: 1 } },
      uPlayerZ: { type: "1f", value: 0 },
      uPlayerXY: { type: "2f", value: { x: 0, y: 0 } },
      uFog: { type: "1f", value: 0 },
      uFlip: { type: "1f", value: 1 },
      uHScale: { type: "1f", value: 16 },
      // The room gate (the uSun lesson: DECLARED or it never reaches a phone).
      uRoomOn: { type: "1f", value: 0 },
      uIndoorMix: { type: "1f", value: 0 },
      uHeight: { type: "sampler2D", value: null },
      uHBlock: { type: "sampler2D", value: null },
      uHBlockN: { type: "2f", value: { x: 1, y: 1 } },
      uSkip: { type: "1f", value: 0 },
      uHasProps: { type: "1f", value: 0 },
      uHeightL: { type: "sampler2D", value: null },
      uHeightG: { type: "sampler2D", value: null },
      uRoom: { type: "sampler2D", value: null },
    });
    this.base = new Phaser.Display.BaseShader("night-lights", FRAG, undefined, {
      uCam: { type: "4f", value: { x: 0, y: 0, z: 1, w: 1 } },
      uIsoA: { type: "4f", value: { x: 0, y: 0, z: this.geo.dx, w: this.geo.dy } },
      uIsoB: { type: "4f", value: { x: this.geo.lh, y: 1, z: 1, w: 0 } },
      uAmbient: { type: "3f", value: { x: 0.16, y: 0.2, z: 0.36 } },
      // The OUTDOOR half of the same grade — see the `amb` mix in FRAG.
      uAmbientOut: { type: "3f", value: { x: 0.16, y: 0.2, z: 0.36 } },
      // Directional sun (cast dir, slope, strength). DECLARED here on
      // purpose: a uniform that is setUniform()'d but missing from this
      // config gets no GL setter — some pipelines still sync it (headless
      // swiftshader did, which made the harness screenshots lie), real
      // phone GPUs leave it at vec4(0) = sun permanently off (playtest:
      // "0 effect"). The inverse twin of the uAnimTime bug below.
      uSun: { type: "4f", value: { x: 0, y: 0, z: 1, w: 0 } },
      uCloud: { type: "1f", value: 0 },
      uAurora: { type: "1f", value: 0 },
      uFlip: { type: "1f", value: 1 },
      uTest: { type: "1f", value: 0 },
      uShadowDbg: { type: "1f", value: 0 },
      // Animation clock (seconds). MUST be driven every frame from the SAME
      // clock as the JS emission layers (stamps/lit copies, scene.time.now/
      // 1000) or the shader floor/fire flicker either freezes (the long-
      // standing "nothing moves" bug: this uniform was declared+used but
      // never set, so it sat at 0) or drifts out of phase with them.
      uAnimTime: { type: "1f", value: 0 },
      uNumLights: { type: "1f", value: 0 },
      uLightPos: { type: "4fv", value: this.posArr },
      uLightCol: { type: "4fv", value: this.colArr },
      uEmitN: { type: "1f", value: 0 },
      uGlowOn: { type: "1f", value: 0 },
      uGlowFlip: { type: "1f", value: 1 },
      uHScale: { type: "1f", value: 16 },
      // 1 while the local player is INDOORS — see heightAt(). Declared here
      // because an UNDECLARED uniform silently never syncs on real phone GPUs
      // (the uSun lesson, already paid for twice in this file).
      uIndoor: { type: "1f", value: 0 },
      // DECLARED, like every other uniform here — the uSun lesson: a uniform
      // missing from this config gets no GL setter and silently never reaches
      // real phone GPUs, where headless SwiftShader would never show it.
      uIndoorTop: { type: "1f", value: 0 },
      uIndoorMix: { type: "1f", value: 0 },
      // OFF (0) until the containment is right. The depth map and the multiply are
      // correct and tested; what is NOT solved is telling an INSIDE pixel from an
      // OUTSIDE one. Gating on the pixel's own cell fails because the mountain's
      // exterior face RESOLVES ONTO INTERIOR CELLS — so the rock darkened with the
      // room (maintainer 2026-08-08: "you have darkened the entire mountain and the
      // outside as well! The inside I said!"). The next attempt needs a test the
      // resolve cannot spoof — the pixel being below the roof slab AND inside the
      // room's own footprint — not a cell lookup.
      // OFF, and it cannot be switched on from here. Outdoors heightAt returns
      // max(terrain, deck) — 24 everywhere in the cave — so EVERY pixel of the
      // interior resolves to the slab top and no z means "floor". Gates that
      // admitted the floor admitted the mountain with it; the gate that
      // excluded the mountain excluded the floor. The shader does not have the
      // information. Shade the interior tiles where they are DRAWN (the ground
      // RT knows which tile it is painting and can read the depth map directly)
      // rather than trying to recover it per pixel here.
      // 3.6, measured from the OPENING (which stays untouched): one tile in
      // reads 3%, two 0.07%, i.e. black. Nothing at the mouth, gone immediately
      // behind it.
      // Depth falloff. Now that the depth reaches the cells that are really
      // drawn (see groundCellAt), 3.6 was a cliff rather than a fade: it put
      // the first cell behind the mouth at 2.7% and the second at 0.07%. 1.2
      // reads as the brief - the mouth untouched, 30% one cell in, 9% two,
      // 2.7% three, 0.8% four: dark fast, near-black by the third or fourth
      // tile, still a gradient rather than a wall of paint.
      uCaveK: { type: "1f", value: 1.2 },
      // 0 until uRoom is really bound — roomAt FAILS LIT on it, so a missing
      // bind can never black out the room itself. Same guard as uGlowOn, for
      // the same reason: an unbound sampler silently reads texture unit 0.
      uRoomOn: { type: "1f", value: 0 },
      uRoom: { type: "sampler2D", value: null },
      uHeight: { type: "sampler2D", value: null },
      uHBlock: { type: "sampler2D", value: null },
      uHBlockN: { type: "2f", value: { x: 1, y: 1 } },
      uSkip: { type: "1f", value: 0 },
      uHasProps: { type: "1f", value: 0 },
      // DECLARED (the uSun lesson) — scenery-world switches, 0 on tiles2 worlds.
      uSceneryOn: { type: "1f", value: 0 },
      uPropGate: { type: "1f", value: 0 },
      uHeightL: { type: "sampler2D", value: null },
      uHeightG: { type: "sampler2D", value: null },
      uEmit: { type: "sampler2D", value: null },
      uGlow: { type: "sampler2D", value: null },
    });
    this.buildStampTexture();
    // Shader GameObjects can't blend directly — render the light field to a
    // texture and composite it with a MULTIPLY image on top of the scene.
    this.overlay = this.scene.add
      .image(0, 0, "__WHITE")
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(900_000) // above the scene; avatars carve via the light mask
      .setBlendMode(Phaser.BlendModes.MULTIPLY)
      .setVisible(false);
    // Mist rides ABOVE the light overlay and the lit avatar copies: ground
    // fog covers whoever wades into it (NORMAL blend — fog occludes, it
    // doesn't tint).
    this.mistOverlay = this.scene.add
      .image(0, 0, "__WHITE")
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(1_000_000)
      .setBlendMode(Phaser.BlendModes.NORMAL)
      .setVisible(false);
    // Elevation depth-fog rides ABOVE the multiply light overlay (900_000) but
    // BELOW the tap marker (900_000.5) and the lit avatar copies (900_001): it
    // fogs the lit WORLD by depth, while the characters (drawn on top) stay
    // crisp — the effect is a terrain depth cue, not a screen wash on players.
    this.depthFogOverlay = this.scene.add
      .image(0, 0, "__WHITE")
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(900_000.2)
      .setBlendMode(Phaser.BlendModes.NORMAL)
      .setVisible(false);
    this.buildShader(this.scene.scale.width, this.scene.scale.height);
    this.buildMistShader(this.scene.scale.width, this.scene.scale.height);
    this.buildDepthFogShader(this.scene.scale.width, this.scene.scale.height);
    // The render target does NOT follow setSize — a resized window left a
    // stale wrong-scale light field (bright rectangles, pools that ignore
    // zoom). Rebuild the shader + target at the new size instead.
    this.scene.scale.on("resize", (sz: Phaser.Structs.Size) => {
      this.buildShader(sz.width, sz.height);
      this.buildMistShader(sz.width, sz.height);
      this.buildDepthFogShader(sz.width, sz.height);
    });
  }

  /** White radial gradient — the halo brush, tinted per stamp. */
  private buildStampTexture() {
    if (this.scene.textures.exists("glow-stamp")) return;
    const S = 128;
    const tex = this.scene.textures.createCanvas("glow-stamp", S, S);
    if (!tex) return;
    const ctx = tex.getContext();
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    // Bright core hugging the source, fast falloff into nothing — the
    // "intense mushroom, pitch-dark forest" profile.
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.2, "rgba(255,255,255,0.75)");
    g.addColorStop(0.5, "rgba(255,255,255,0.28)");
    g.addColorStop(0.8, "rgba(255,255,255,0.07)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    tex.refresh();
    this.stampImg = this.scene.make.image({ key: "glow-stamp", add: false }).setOrigin(0.5, 0.5);
    // TRUE additive blend: Phaser's built-in ADD is (ONE, DST_ALPHA), which
    // multiplies existing content by the destination ALPHA — on a render
    // texture that made every stamped quad erase/replace the glow beneath it
    // (hard black rectangles all over dense glow, playtester report).
    // (ONE, ONE) is pure out = src + dst: overlap order can't matter.
    const renderer = this.scene.game.renderer;
    if (renderer.type === Phaser.WEBGL) {
      const wr = renderer as Phaser.Renderer.WebGL.WebGLRenderer;
      const gl = wr.gl;
      this.stampImg.setBlendMode(wr.addBlendMode([gl.ONE, gl.ONE], gl.FUNC_ADD));
    } else {
      this.stampImg.setBlendMode(Phaser.BlendModes.ADD);
    }
  }

  /** (Re)create the mist shader + render target (same lifecycle rules as
   * the main field: fresh key per size, rebuilt on resize). */
  private buildMistShader(width: number, height: number) {
    if (!this.mistBase || width <= 0 || height <= 0) return;
    const full = { width, height };
    const ls = lightScale();
    width = Math.max(1, Math.round(width * ls));
    height = Math.max(1, Math.round(height * ls));
    this.mistShader?.destroy();
    const key = `${MIST_KEY}-${this.fieldCount++}`;
    const s = this.scene.add
      .shader(this.mistBase, 0, 0, width, height)
      .setOrigin(0, 0)
      .setVisible(false);
    s.setSampler2D("uHeight", "world-heightmap");
    // THE SKIP IS ARMED ONLY WITH ITS TEXTURE BOUND — an unbound sampler reads
    // unit 0 (the full heightmap), which would make one cell's height the
    // "block max" and skip cells that are hit.
    if (this.scene.textures.exists(BLOCK_KEY)) {
      s.setSampler2D("uHBlock", BLOCK_KEY, 6);
      s.setUniform("uHBlockN.value", { x: this.blockN.x, y: this.blockN.y });
      s.setUniform("uSkip.value", this.skipOn ? 1 : 0);
    } else s.setUniform("uSkip.value", 0);
    s.setRenderToTexture(key);
    if (ls !== 1) this.scene.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR);
    this.mistShader = s;
    const old = this.mistOverlay!.texture.key;
    this.mistOverlay!
      .setTexture(key)
      .setPosition(full.width / 2, full.height / 2)
      .setScale(full.width / width, full.height / height);
    if (old.startsWith(MIST_KEY) && this.scene.textures.exists(old)) {
      this.scene.textures.remove(old);
    }
  }

  /** (Re)create the depth-fog shader + render target (same lifecycle rules). */
  private buildDepthFogShader(width: number, height: number) {
    if (!this.depthFogBase || width <= 0 || height <= 0) return;
    const full = { width, height };
    const ls = lightScale();
    width = Math.max(1, Math.round(width * ls));
    height = Math.max(1, Math.round(height * ls));
    this.depthFogShader?.destroy();
    const key = `${DEPTHFOG_KEY}-${this.fieldCount++}`;
    const s = this.scene.add
      .shader(this.depthFogBase, 0, 0, width, height)
      .setOrigin(0, 0)
      .setVisible(false);
    s.setSampler2D("uHeight", "world-heightmap");
    // THE SKIP IS ARMED ONLY WITH ITS TEXTURE BOUND — an unbound sampler reads
    // unit 0 (the full heightmap), which would make one cell's height the
    // "block max" and skip cells that are hit.
    if (this.scene.textures.exists(BLOCK_KEY)) {
      s.setSampler2D("uHBlock", BLOCK_KEY, 6);
      s.setUniform("uHBlockN.value", { x: this.blockN.x, y: this.blockN.y });
      s.setUniform("uSkip.value", this.skipOn ? 1 : 0);
    } else s.setUniform("uSkip.value", 0);
    if (this.scene.textures.exists("world-heightmap-linear"))
      s.setSampler2D("uHeightL", "world-heightmap-linear", 1);
    if (this.scene.textures.exists("world-heightmap-ground"))
      s.setSampler2D("uHeightG", "world-heightmap-ground", 5);
    // The room mask, for the indoor gate — same eager-create-then-bind pattern
    // as the main shader's uRoom.
    this.ensureRoomTexture();
    this.fogRoomBound = this.scene.textures.exists(ROOM_KEY);
    if (this.fogRoomBound) s.setSampler2D("uRoom", ROOM_KEY, 2);
    s.setRenderToTexture(key);
    if (ls !== 1) this.scene.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR);
    this.depthFogShader = s;
    const old = this.depthFogOverlay!.texture.key;
    this.depthFogOverlay!
      .setTexture(key)
      .setPosition(full.width / 2, full.height / 2)
      .setScale(full.width / width, full.height / height);
    if (old.startsWith(DEPTHFOG_KEY) && this.scene.textures.exists(old)) {
      this.scene.textures.remove(old);
    }
  }

  /** (Re)create the shader + its render target at the given size. */
  private buildShader(width: number, height: number) {
    if (!this.base || width <= 0 || height <= 0) return;
    const full = { width, height };
    const ls = lightScale();
    width = Math.max(1, Math.round(width * ls));
    height = Math.max(1, Math.round(height * ls));
    this.shader?.destroy();
    // A fresh texture key per size: destroying a shader doesn't unregister
    // its render target, and re-binding an existing key throws.
    const key = `${FIELD_KEY}-${this.fieldCount++}`;
    const s = this.scene.add
      .shader(this.base, 0, 0, width, height)
      .setOrigin(0, 0)
      .setVisible(this.active);
    s.setSampler2D("uHeight", "world-heightmap");
    // THE SKIP IS ARMED ONLY WITH ITS TEXTURE BOUND — an unbound sampler reads
    // unit 0 (the full heightmap), which would make one cell's height the
    // "block max" and skip cells that are hit.
    if (this.scene.textures.exists(BLOCK_KEY)) {
      s.setSampler2D("uHBlock", BLOCK_KEY, 6);
      s.setUniform("uHBlockN.value", { x: this.blockN.x, y: this.blockN.y });
      s.setUniform("uSkip.value", this.skipOn ? 1 : 0);
    } else s.setUniform("uSkip.value", 0);
    if (this.scene.textures.exists("world-heightmap-linear"))
      s.setSampler2D("uHeightL", "world-heightmap-linear", 1);
    if (this.scene.textures.exists("world-heightmap-ground"))
      s.setSampler2D("uHeightG", "world-heightmap-ground", 5);
    if (this.scene.textures.exists("emission-palette"))
      s.setSampler2D("uEmit", "emission-palette", 2);
    /* Glow field RT at HALF the field, aspect preserved. The shader samples it
     * NORMALIZED over uCam's window and the stamps are placed by that same
     * mapping (`gscale` in update(), which is derived from rt.width), so the
     * size is free to change and only the stamps' own resolution follows — and
     * they are soft radial blobs, which is the one thing half resolution costs
     * nothing on. It is cleared and redrawn EVERY frame the stamps move, so its
     * area is paid ~3x per frame (explicit clear, capture clear, blit): at his
     * 1079x1404 that was 1.52 Mpix a bracket, and a quarter of that now.
     * (GLOW_FIELD_DIV 2 — measured on his Mali-G715 run of 2026-09-07, where
     * the pass update WAS the `lighting` section.) */
    this.glowRT?.destroy();
    if (this.glowKey && this.scene.textures.exists(this.glowKey)) this.scene.textures.remove(this.glowKey);
    const gw = Math.max(1, Math.round(width / GLOW_FIELD_DIV));
    const gh = Math.max(1, Math.round(height / GLOW_FIELD_DIV));
    this.glowRT = this.scene.make.renderTexture({ width: gw, height: gh }, false);
    this.glowKey = `night-glow-${this.fieldCount}`;
    this.glowRT.saveTexture(this.glowKey);
    s.setSampler2D("uGlow", this.glowKey, 3);
    s.setUniform("uHasProps.value", this.propsFlag());
    // ON THE SHADER BEING BUILT, not `this.shader`: that is assigned below,
    // so pushing through it here landed on the previous shader (none, on the
    // first build) and every scenery-world switch stayed at its table value
    // of 0 in play — the skirt skip, the sparse gate, the own-trunk rules —
    // until some later restamp happened to re-push them. Measured: uSceneryOn
    // 0 at join with 1,267 share cells stamped; 1 after one manual push.
    this.setScenerySwitches(s);
    // The room mask (unit 4). Built lazily the first time the player steps
    // indoors — a world nobody ever enters a building in never pays for it.
    this.ensureRoomTexture();
    this.roomBound = this.scene.textures.exists(ROOM_KEY);
    if (this.roomBound) s.setSampler2D("uRoom", ROOM_KEY, 4);
    s.setRenderToTexture(key);
    if (ls !== 1) this.scene.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR);
    this.shader = s;
    const old = this.overlay!.texture.key;
    this.overlay!
      .setTexture(key)
      .setPosition(full.width / 2, full.height / 2)
      .setScale(full.width / width, full.height / height);
    if (old.startsWith(FIELD_KEY) && this.scene.textures.exists(old)) {
      this.scene.textures.remove(old);
    }
  }

  /** TWO heightmaps — surface geometry vs occlusion geometry.
   *
   * world-heightmap (NEAREST, drives the resolve + face classification):
   * R = TERRAIN level*16 only. Solid objects (trees, boulders…) are NOT
   * terrain: modelling them as full-cell blocks made the shader paint their
   * phantom block's Lambert-gated wall band as a knife-edged near-black
   * wedge on the flat ground BESIDE the drawn art (measured: the wedge
   * matched the analytic l+1 band ±1.8px on all 64 columns while the art is
   * a floating canopy). An object's visual mass is its ART; the ground at
   * its cell is ground.
   *
   * world-heightmap-linear (LINEAR, drives the LOS march only):
   * R = (terrain + solid)*16 — objects still BLOCK light and cast their
   * soft, bounce-floored shadow. The bilinear read rounds the block into a
   * plausible blob. B = BASE terrain level (never deck-inflated), read at
   * texel centres by the AO seam term so floating slabs don't fake walls. */
  /** Create the room-mask texture (all zeros) if it does not exist yet. Same
   * size and convention as the heightmaps, so roomAt() can reuse their uv. */
  private ensureRoomTexture() {
    if (this.scene.textures.exists(ROOM_KEY)) return;
    const t = this.scene.textures.createCanvas(ROOM_KEY, this.world.width, this.world.height);
    if (!t) return;
    t.setFilter(Phaser.Textures.FilterMode.NEAREST);
    t.refresh();
  }

  /** Publish the set of cells that count as "my room" to the shader AND to the
   * CPU twin. Called by WorldScene whenever the indoor mask is rebuilt — a
   * doorway crossing or a turn of the wall-cut dial — and never per frame.
   *
   * ONE full-grid rewrite, not a per-cell patch. `CanvasTexture.refresh()`
   * re-uploads the WHOLE canvas (Phaser has no sub-image path), so painting
   * each changed cell with its own putImageData buys nothing and costs a lot:
   * the_island2's 472-cell cave would do 944 canvas calls to produce the same
   * single texImage2D. Rewriting all 61,504 bytes of the worst-case grid and
   * pushing once is O(1) in room size and lands around 0.3 ms — on a doorway
   * crossing or a turn of the cut dial, never on a frame.
   *
   * R packs MEMBERSHIP and the PER-CELL CUT into one byte, because indoors the
   * surface resolve needs an answer for EVERY cell of the world:
   *
   *     128 + cut   — a cell of MY room, its column drawn to `cut`
   *     cut (0-126) — a CONSTRAINED outside cell (the covering cone)
   *     127         — UNCONSTRAINED: drawn whole, deck included (the
   *                   neighbour's roof, the up-screen mountain)
   *     0 everywhere on the outdoor publish (never read — uIndoor gates)
   *
   * roomAt tests the 128 bit; heightAt reads the low half (see both). With the
   * legacy kill-switch cut (cuts null) every cell is constrained at the scalar
   * dial, so the low half is `top` world-wide. A pinned at 255 everywhere
   * because canvas uploads are PREMULTIPLIED (the same reason the heightmap
   * pins its alpha) — an A below 255 would scale the R the shader reads, which
   * is also why the cut could NOT ride the A channel.
   */
  setRoom(
    cells: Iterable<number> | null,
    depth?: Map<number, number>,
    under?: Map<number, number>,
    cuts?: Map<number, number> | null,
    top = 0,
  ) {
    this.ensureRoomTexture();
    const t = this.scene.textures.get(ROOM_KEY) as Phaser.Textures.CanvasTexture | undefined;
    const src = t?.getSourceImage() as HTMLCanvasElement | undefined;
    if (!t || !src) return;
    const next = new Set<number>(cells ?? []);
    const nextCuts = cuts ?? null;
    // Two latches, not one: the first publish of a world carried DEPTH but no
    // ceiling map, and a single flag meant the ceiling could never be written
    // afterwards — measured as 940 cells in the scene and 0 in the texture,
    // which is exactly why the shader gate compared against zero and nothing
    // ever darkened.
    const needDepth = (depth !== undefined && !this.depthWritten) || (under !== undefined && !this.underWritten);
    // The CUTS can change while the cell set does not — the wall-height dial
    // moves every per-cell value without moving the room — so they get their
    // own change test beside the set's, and the scalar top is part of it (the
    // legacy encoding writes it into every cell).
    const sameCuts = (() => {
      if (top !== this.roomTop) return false;
      const a = this.roomCuts;
      if (!a && !nextCuts) return true;
      if (!a || !nextCuts || a.size !== nextCuts.size) return false;
      for (const [i, v] of nextCuts) if (a.get(i) !== v) return false;
      return true;
    })();
    // Nothing to do if the room did not actually change (the scene guards this
    // too, but the mask is also rebuilt for the CUT, which does not move it) —
    // unless the DEPTH channel has never been written, which happens on the
    // first publish of a world and whenever that publish is `null` (outdoors,
    // which is exactly when you are looking into someone else's cave).
    if (!needDepth && sameCuts && next.size === this.roomCells.size && [...next].every((i) => this.roomCells.has(i)))
      return;
    const ctx = t.getContext();
    const w = this.world.width;
    const h = this.world.height;
    if (!this.roomImg) {
      this.roomImg = ctx.createImageData(w, h);
      for (let p = 3; p < this.roomImg.data.length; p += 4) this.roomImg.data[p] = 255;
    }
    const d = this.roomImg.data;
    const clamp7 = (v: number) => Math.max(0, Math.min(126, Math.round(v)));
    // Full-grid R baseline: 127 (unconstrained) in the per-cell world, the
    // scalar dial in the legacy one, 0 on the outdoor publish.
    const base = cells === null ? 0 : nextCuts ? 127 : clamp7(top);
    for (let i = 0; i < w * h; i++) d[i * 4] = base;
    if (nextCuts)
      for (const [i, cut] of nextCuts) if (i >= 0 && i < w * h) d[i * 4] = clamp7(cut);
    for (const i of next)
      if (i >= 0 && i < w * h) d[i * 4] = 128 + clamp7(nextCuts?.get(i) ?? top);
    this.roomCuts = nextCuts ? new Map(nextCuts) : null;
    this.roomTop = top;
    // GREEN = DEPTH FROM DAYLIGHT, in cells, 0 at an opening. Static for a
    // world, so it is written once: the geometry of a cave does not move.
    if (needDepth) {
      for (const [i, dep] of depth!)
        // +1 SO ZERO MEANS 'NOT A ROOM'. Depth 0 is the cell at the opening,
        // and storing it as a literal 0 made it indistinguishable from open
        // ground — the containment gate then read every entrance cell as
        // outside and the effect vanished exactly where it matters.
        if (i >= 0 && i < w * h) d[i * 4 + 1] = Math.min(255, Math.max(0, dep) + 1);
      this.depthWritten = true;
      // BLUE = the ceiling's UNDERSIDE level: the top of the opening. Above it
      // is the slab's own face, which is the mountain, and darkening that is
      // what blackened the whole thing three times over.
      if (under) {
        for (const [i, u] of under)
          if (i >= 0 && i < w * h) d[i * 4 + 2] = Math.max(1, Math.min(255, Math.round(u)));
        this.underWritten = true;
      }
    }
    ctx.putImageData(this.roomImg, 0, 0);
    this.roomCells = next;
    t.refresh();
    // refresh() re-runs canvasToTexture, which re-applies the source's scale
    // mode — re-assert NEAREST rather than trust that it survived. A LINEAR
    // room mask would bleed a half-cell of ambient straight through the walls.
    t.setFilter(Phaser.Textures.FilterMode.NEAREST);
  }

  /** What the room mask really holds, and whether the shader really has it.
   *
   * `lit` counts texels the SHADER would read as in-room, straight off the
   * canvas; `cells` is what the scene last published. They must match — a
   * divergence means an upload was lost. `bound`/`roomOn` are the guard against
   * the one silent, phone-only failure: an unbound sampler2D reads texture
   * unit 0 (the heightmap), which would black out the ROOM and light the
   * outside. Read by __ml.roomTex() and by verify-indoor. */
  roomDebug() {
    const t = this.scene.textures.get(ROOM_KEY);
    const src = t?.getSourceImage() as HTMLCanvasElement | undefined;
    if (!src) return { exists: false };
    const ctx = (t as Phaser.Textures.CanvasTexture).getContext();
    const d = ctx.getImageData(0, 0, src.width, src.height).data;
    let on = 0;
    // ...and the DEPTH channel, which is the one that can silently be empty:
    // it is written once per world, so "the effect does nothing" and "the
    // channel was never filled" look identical on screen.
    let deep = 0;
    let maxDep = 0;
    let und = 0;
    let maxUnd = 0;
    // The per-cell CUT rides R's low half — count my-room cells raised past
    // the scalar dial and the outside sentinels, so a gate can tell "the
    // raise/scope did nothing" from "it was never published", which look
    // identical on screen when a room happens to have no raisable wall or no
    // unconstrained neighbour.
    let raised = 0;
    let maxCut = 0;
    let uncut = 0;
    const topB = Math.max(0, Math.min(126, Math.round(this.indoorTop)));
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 127) on++;
      if (d[i] > 127 && d[i] - 128 > topB) { raised++; maxCut = Math.max(maxCut, d[i] - 128); }
      if (d[i] === 127) uncut++;
      if (d[i + 1] > 0) { deep++; maxDep = Math.max(maxDep, d[i + 1]); }
      if (d[i + 2] > 0) { und++; maxUnd = Math.max(maxUnd, d[i + 2]); }
    }
    return {
      exists: true,
      w: src.width,
      h: src.height,
      lit: on,
      raisedCells: raised,
      maxCut,
      uncut,
      depthCells: deep,
      depthMax: maxDep,
      underCells: und,
      underMax: maxUnd,
      cells: this.roomCells.size,
      indoor: this.indoor,
      bound: this.roomBound,
      roomOn: (this.shader as any)?.uniforms?.uRoomOn?.value,
      uIndoor: (this.shader as any)?.uniforms?.uIndoor?.value,
      mix: +this.indoorMix.toFixed(3),
    };
  }

  private buildHeightmap() {
    if (this.scene.textures.exists("world-heightmap")) {
      // Textures outlive this instance (the manager is per game): keep the
      // block grid's size honest for the bindings, or arm nothing.
      const bt = this.scene.textures.get(BLOCK_KEY);
      if (this.scene.textures.exists(BLOCK_KEY) && bt) {
        const src = bt.getSourceImage() as { width: number; height: number };
        this.blockN = { x: src.width, y: src.height };
      } else this.skipOn = false;
      return;
    }
    const w = this.world.width;
    const h = this.world.height;
    // Emission palette indices: category → position in emitList (+1 in the
    // texture's B channel; 0 = does not glow). Only categories the registry
    // marks emissive get an index.
    const emitIdx = new Map<string, number>();
    for (const [cat, entry] of Object.entries(this.emission)) {
      if (entry) {
        emitIdx.set(cat, this.emitList.length);
        this.emitList.push(entry);
      }
    }
    const tex = this.scene.textures.createCanvas("world-heightmap", w, h);
    const ctx = tex!.getContext();
    const img = ctx.createImageData(w, h); // surface (terrain-only heights)
    const imgL = ctx.createImageData(w, h); // occlusion (terrain + solids)
    // The GROUND COLUMN's top (terrain + solid/prop bump, deck EXCLUDED) — what
    // lets the point-light march tell a floating slab from a solid pillar. Its
    // OWN texture rather than a spare channel of the linear map, because the
    // only channel left there was alpha, and alpha is not a data channel on a
    // premultiplied upload (see the pin below).
    const imgG = ctx.createImageData(w, h);
    this.hArr = new Float32Array(w * h);
    this.tArr = new Float32Array(w * h);
    this.bArr = new Float32Array(w * h);
    this.gArr = new Float32Array(w * h);
    this.oArr = new Uint8Array(w * h);
    this.pArr = new Float32Array(w * h);
    this.sArrH = new Float32Array(w * h);
    this.sArrG = new Float32Array(w * h);
    this.imgL = imgL;
    this.imgG = imgG;
    this.sceneryOrig.clear();
    // Placed props occlude EXACTLY like solid terrain categories: +1 level,
    // one shadow system for everything (maintainer — the torch LOS look).
    // Their taller art heights (2-5 levels) were tried in the map and only
    // ever bought spike/blob artifacts; +1 gives the same compact soft
    // shadow the torch casts, from the same march.
    const propLvl = new Map<number, number>();
    for (const pr of this.world.props ?? []) propLvl.set(pr.row * w + pr.col, 1);
    // world@2 decks (bridges, roofs): the deck slab's level feeds BOTH heightmaps.
    // SURFACE (uHeight): so the shader resolves a deck-top screen pixel to its real
    // height (4) and lights it as that surface, not the base ground 4 levels below.
    // OCCLUSION (uHeightL): so the slab CASTS a sun shadow like any raised terrain —
    // a roof shades the ground under its eaves (incl. across the doorway where there
    // is no wall, only roof), a bridge shades the water. The deck top itself stays
    // lit: the sun march starts at the resolved surface height (4), so neighbouring
    // level-4 cells never rise above it.
    const deckH = new Float32Array(w * h);
    for (const d of this.world.decks ?? []) {
      for (const cc of d.cells) {
        if (cc.col < 0 || cc.row < 0 || cc.col >= w || cc.row >= h) continue;
        const di = cc.row * w + cc.col;
        if (d.level > deckH[di]) deckH[di] = d.level;
      }
    }
    // Levels are packed into a single 8-bit channel as level*hScale. The
    // historical scale was 16, which SATURATES at 255/16 = 15.9 levels: any
    // world taller than that (the_island 19, the_island2 32) clamped every high
    // cell to a phantom ~16-level ceiling, so the surface resolve read a bogus
    // low z and the depth-fog painted the whole peak (and night/occlusion read
    // wrong heights too). Shrink the scale JUST enough that the tallest occluder
    // fits — worlds that already fit keep the exact *16 bytes (byte-identical,
    // zero regression). One cheap pre-scan of the tallest packed height.
    let maxH = 1;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const cell = this.world.rows[r][c];
        const s = surfaceFor(cell.t);
        const solid = !s.standable && !s.swimmable;
        const pl = propLvl.get(r * w + c) ?? 0;
        const occH = Math.max(cell.l + Math.max(solid ? 1 : 0, pl), deckH[r * w + c]);
        if (occH > maxH) maxH = occH;
      }
    }
    const hScale = maxH * 16 <= 255 ? 16 : 255 / maxH;
    this.hScale = hScale;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = (r * w + c) * 4;
        const cell = this.world.rows[r][c];
        const s = surfaceFor(cell.t);
        const solid = !s.standable && !s.swimmable;
        const pl = propLvl.get(r * w + c) ?? 0;
        const deckL = deckH[r * w + c];
        // The GROUND column on its own: terrain plus its solid/prop bump, with
        // no deck. This is the real solid span from 0 upward; the deck is a
        // separate floating slab (see groundAtSoft / the LOS march).
        const groundH = cell.l + Math.max(solid ? 1 : 0, pl);
        // Occlusion: the taller of the terrain (+ solid/prop bump) and any deck
        // slab, so a roof/bridge casts a real cast shadow on the ground below.
        const occH = Math.max(groundH, deckL);
        // The lit SURFACE height: the deck slab when one caps this cell, else the terrain.
        const surfL = Math.max(cell.l, deckL);
        // CPU twin marches LOS only → occlusion heights (solids/props +1).
        this.hArr[r * w + c] = occH;
        this.gArr[r * w + c] = groundH;
        this.tArr[r * w + c] = surfL;
        this.bArr[r * w + c] = cell.l;
        this.oArr[r * w + c] = solid ? 1 : 0;
        this.pArr[r * w + c] = pl;
        img.data[i] = Math.min(255, surfL * hScale);
        imgL.data[i] = Math.min(255, occH * hScale);
        // G = the prop share: props get their own smooth shade patch while
        // TERRAIN keeps the byte-identical march (cliffs are locked).
        imgL.data[i + 1] = Math.min(255, pl * hScale);
        // B = the BASE terrain level, never deck-inflated: the AO seam term
        // reads this (baseTerrAt) so a floating bridge/roof slab doesn't
        // masquerade as a tall wall next to the ground drawn under it. Same
        // packing expression as the surface R so non-deck cells stay
        // byte-identical to what heightAt would have returned.
        imgL.data[i + 2] = Math.min(255, cell.l * hScale);
        // G flags solid OBJECTS (bush, boulder, tree…): they keep full LOS
        // occlusion — the billboard compromise is for players, who can never
        // stand on these cells.
        img.data[i + 1] = solid ? 255 : 0;
        // B = self-emission palette index + 1 (see the shader's emitAt).
        // tile-emission@2 is per-VARIANT: a category's plain variants (grey
        // basalt in the lava set…) must NOT inherit the molten floor — the
        // demo sweep caught every such variant rendering rust-tinted with
        // phantom ember rims. Entries without sources data (v1) keep the
        // whole-category behaviour.
        const em2 = this.emission[cell.t];
        const glows = em2 && (!em2.sources || (em2.sources[String(cell.v)]?.length ?? 0) > 0);
        const ei = glows ? emitIdx.get(cell.t) : undefined;
        img.data[i + 2] = ei === undefined ? 0 : Math.min(255, ei + 1);
        img.data[i + 3] = 255;
        // A IS PINNED AT 255 — DATA MUST NEVER GO IN THIS CHANNEL.
        //
        // Canvas uploads are PREMULTIPLIED (UNPACK_PREMULTIPLY_ALPHA_WEBGL), so
        // whatever goes in alpha SCALES R, G and B on the way to the GPU. This
        // channel briefly held the ground column's top, and it silently wrecked
        // the directional sun for the whole game: alpha = groundH * hScale, so
        // every occlusion height the sun march reads came back multiplied by
        // groundH*hScale/255. On the_island2 hScale is ~6.4, which means FLAT
        // GROUND (groundH 0) scaled R to ZERO, a level-6 house wall to 0.15x,
        // and a level-40 mountain to 255/255 = 1.0x — untouched. That is
        // exactly what the maintainer reported (2026-08-08): the house and the
        // hilltop stopped casting entirely, the bridge lit from nowhere, and
        // "the mountain still casts on the ground but doesn't shade its own
        // hillside" — the hillside is baseTerrAt, which reads B, scaled too.
        // The sibling map pins its alpha for this same reason; this one did not.
        // groundH now lives in its own texture (see world-heightmap-ground).
        imgL.data[i + 3] = 255;
        imgG.data[i] = Math.min(255, groundH * hScale);
        imgG.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    /* THE BLOCK-MAX GRID beside it: max of R over each BLOCK×BLOCK of cells,
     * same byte packing, so the shader's decode of it bounds heightAt exactly. */
    {
      const bw = Math.ceil(w / BLOCK);
      const bh = Math.ceil(h / BLOCK);
      if (this.scene.textures.exists(BLOCK_KEY)) this.scene.textures.remove(BLOCK_KEY);
      const btex = this.scene.textures.createCanvas(BLOCK_KEY, bw, bh)!;
      const bctx = btex.getContext();
      const bimg = bctx.createImageData(bw, bh);
      for (let by = 0; by < bh; by++)
        for (let bx = 0; bx < bw; bx++) {
          let m = 0;
          const r1 = Math.min(h, (by + 1) * BLOCK);
          const c1 = Math.min(w, (bx + 1) * BLOCK);
          for (let r = by * BLOCK; r < r1; r++)
            for (let c = bx * BLOCK; c < c1; c++) {
              const v = img.data[(r * w + c) * 4];
              if (v > m) m = v;
            }
          const j = (by * bw + bx) * 4;
          bimg.data[j] = m;
          bimg.data[j + 3] = 255;
        }
      bctx.putImageData(bimg, 0, 0);
      btex.setFilter(Phaser.Textures.FilterMode.NEAREST);
      btex.refresh();
      this.blockN = { x: bw, y: bh };
    }
    tex!.refresh();
    const texL = this.scene.textures.createCanvas("world-heightmap-linear", w, h);
    if (texL) {
      texL.getContext().putImageData(imgL, 0, 0);
      texL.refresh();
      texL.setFilter(Phaser.Textures.FilterMode.LINEAR);
    }
    const texG = this.scene.textures.createCanvas("world-heightmap-ground", w, h);
    if (texG) {
      texG.getContext().putImageData(imgG, 0, 0);
      texG.refresh();
      texG.setFilter(Phaser.Textures.FilterMode.LINEAR);
    }
    // Palette texture: 2 texels per entry — texel 0 = colour, texel 1 =
    // (strength, self, anim mode 0/100/200). NEAREST so indices read exact.
    if (this.emitList.length) {
      const pw = this.emitList.length * 2;
      const ptex = this.scene.textures.createCanvas("emission-palette", pw, 1);
      if (ptex) {
        const pctx = ptex.getContext();
        const pimg = pctx.createImageData(pw, 1);
        this.emitList.forEach((e, k) => {
          const i = k * 8;
          pimg.data[i] = Math.round(e.color[0] * 255);
          pimg.data[i + 1] = Math.round(e.color[1] * 255);
          pimg.data[i + 2] = Math.round(e.color[2] * 255);
          pimg.data[i + 3] = 255;
          pimg.data[i + 4] = Math.round(e.strength * 255);
          pimg.data[i + 5] = Math.round(e.self * 255);
          pimg.data[i + 6] = e.anim === "flicker" ? 200 : e.anim === "pulse" ? 100 : 0;
          pimg.data[i + 7] = 255;
        });
        pctx.putImageData(pimg, 0, 0);
        ptex.refresh();
        ptex.setFilter(Phaser.Textures.FilterMode.NEAREST);
      }
    }
  }

  /** 1 when the sun's prop patch has anything to read: placed props, or scenery shares. */
  private propsFlag(): number {
    return (this.world.props?.length ?? 0) > 0 || this.hasSceneryShares ? 1 : 0;
  }

  /** The scenery-world switches on the night pass: the own-cell skirt skip and
   *  the sparse sun-patch gate — both 0 unless scenery shares are stamped. */
  private setScenerySwitches(sh: Phaser.GameObjects.Shader | undefined = this.shader): void {
    sh?.setUniform("uSceneryOn.value", this.hasSceneryShares ? 1 : 0);
    sh?.setUniform("uPropGate.value", this.hasSceneryShares && this.sunGate ? 1 : 0);
  }

  /** The lit-copy self-exclusion radius² for a scenery placement (0 = none stamped). */
  sceneryExclR2(place: number): number {
    return this.sceneryExcl.get(place) ?? 0;
  }

  /** SCENERY OCCLUDES LIKE A PROP: a maps3 piece enters the SAME two maps a
   *  tiles2 prop does — the linear map's R plus an EQUAL G share, and the ground
   *  map's R — so the torch's LOS march and the sun's prop patch shade it with no
   *  shader change: one shadow system for everything (the props' approved torch
   *  look). Re-applied whenever the footprints change (the docs land after the
   *  heightmap is built; the wiki edits hitboxes live) and rebuilt from scratch
   *  each time, like the collision stamp. Bytes are ADDED over the cell's own
   *  terrain byte and the same bytes go into G, so R−G — the locked cliff march
   *  and the depth fog — stays bit-identical (verified: fog hash unchanged).
   *  - THE TRUNK is the collision footprint: the cell holding its centre plus
   *    every cell whose centre the ellipse/rect covers — one cell for a tree, a
   *    row for a log or a stall. Its height is round(art over the hitbox / a
   *    body's 88 px) levels, clamped 1..3: a stone or bush is a prop's +1 (occ
   *    0.67 per sample), a tree's 2 saturates the ramp (0.45). Only 1-vs-≥2 is
   *    visible to the torch, and the sun patch flattens any share to +1 itself
   *    (min(pr·1.8, 1)) — the props' "levels made spikes" cannot recur.
   *    REJECTED: coverage-weighted shares — a 0.5-cell trunk straddling a corner
   *    spread to 4 × 0.19 level (under the ray's +0.2) and cast NOTHING; and a
   *    dilated footprint, which darkened the ground on the TORCH side of the
   *    trunk (the march's 0.75-cell near field is sized for one-cell bumps).
   *  - NO CANOPY (rejected, measured): a tree's crown as a disc of share cells
   *    at its true top (a slab in the two-span rule — the torch passed under it
   *    correctly, the sun shaded beneath it) drew a DIAMOND LATTICE under every
   *    tree by day: the sun patch skips a pixel's OWN cell, so inside a block of
   *    share cells each cell shades from its first up-sun sample — m runs 1 → 0.58
   *    across every cell (Hp − hRay falls with dcp) and the block reads as tiled
   *    diamonds, not a blob (scratch p4-day-on-crop). A smooth canopy needs the
   *    patch itself changed, and that patch IS the_island2's approved prop look —
   *    a maintainer verdict, not a stamp choice. So a tree casts as a prop does:
   *    its trunk cell, and the compact soft pool the patch makes of one cell.
   *  - SKIPPED: cells capped by a deck (surface > terrain): furniture under a
   *    roof, anything under a bridge — a G share there would DENT the deck for
   *    the cliff march and the fog, and a bed must not cast on the street. Flat
   *    pieces (`collision: false`) never reach the footprint table.
   *  - THE PIECE'S OWN LIT COPY is tinted with its own shares removed within
   *    `sceneryExclR2(place)` (1.8 cells): the tint is read at
   *    the anchor, which is not always the trunk's cell, so without this every
   *    tree stood in its own shadow from every side ("a prop OCCLUDES ITS OWN
   *    CELL" — the bonfire trap). Cost, measured headless: 2-19 ms for the_game's
   *    649 footprints INCLUDING the two 1 MB re-uploads; the heightmap build
   *    itself (153-184 ms there) is untouched. */
  setSceneryOccluders(fp: SceneryFootprints | undefined): void {
    if (!this.hArr || !this.imgL || !this.imgG) return;
    const t0 = performance.now();
    const W = this.world.width;
    const Hh = this.world.height;
    const dL = this.imgL.data;
    const dG = this.imgG.data;
    for (const [i, o] of this.sceneryOrig) {
      dL[i * 4] = o[0];
      dL[i * 4 + 1] = o[1];
      dG[i * 4] = o[2];
      dG[i * 4 + 2] = 0;
      this.hArr[i] = o[3];
      this.gArr[i] = o[4];
      this.pArr[i] = o[5];
      this.sArrH[i] = 0;
      this.sArrG[i] = 0;
    }
    for (const i of this.sceneryDil) dG[i * 4 + 1] = 0;
    this.sceneryDil = [];
    const had = this.sceneryOrig.size > 0;
    this.sceneryOrig.clear();
    this.sceneryExcl.clear();
    const stats = { footprints: 0, cells: 0, gateCells: 0, ms: 0 };
    const hs = this.hScale;
    const trunk = new Map<number, number>(); // cell → bump bytes over its OWN terrain byte
    if (fp && this.sceneryShadows) {
      for (let j = 0; j < fp.n; j++) {
        const cx = fp.cx[j];
        const cy = fp.cy[j];
        const cc = Math.floor(cx);
        const cr = Math.floor(cy);
        if (cc < 0 || cr < 0 || cc >= W || cr >= Hh) continue;
        const artH = fp.artH[j];
        const tb = Math.round(Math.max(1, Math.min(SCN_TRUNK_MAX, Math.round(artH / CHARACTER_BODY_PX))) * hs);
        const p = fp.p[j];
        const q = fp.q[j];
        const isRect = fp.rect[j] === 1;
        const bump = (c: number, r: number) => {
          if (c < 0 || r < 0 || c >= W || r >= Hh) return;
          const i = r * W + c;
          if ((trunk.get(i) ?? 0) < tb) trunk.set(i, tb);
        };
        bump(cc, cr);
        // Every cell whose CENTRE the shape covers — the footprint's own inside
        // test (footprintPenetration's frame: X/Y along the map diagonals).
        const reach = isRect ? (fp.supX[j] + fp.supY[j]) / Math.SQRT2 : Math.sqrt((p * p + q * q) / 2);
        const c0 = Math.floor(cx - reach);
        const c1 = Math.floor(cx + reach);
        const r0 = Math.floor(cy - reach);
        const r1 = Math.floor(cy + reach);
        for (let r = r0; r <= r1; r++)
          for (let c = c0; c <= c1; c++) {
            const ox = c + 0.5 - cx;
            const oy = r + 0.5 - cy;
            const X = (ox - oy) / Math.SQRT2;
            const Y = (ox + oy) / Math.SQRT2;
            let inside: boolean;
            if (isRect) {
              const U = X * fp.rcos[j] + Y * fp.rsin[j];
              const V = fp.rcos[j] * Y - fp.rsin[j] * X;
              inside = Math.abs(U) <= p && Math.abs(V) <= q;
            } else inside = (X * X) / (p * p) + (Y * Y) / (q * q) <= 1;
            if (inside) bump(c, r);
          }
        this.sceneryExcl.set(fp.place[j], SCN_EXCL_R * SCN_EXCL_R);
        stats.footprints++;
      }
    }
    for (const i of trunk.keys()) {
      const i4 = i * 4;
      const Rb0 = dL[i4];
      const Gb0 = dL[i4 + 1];
      const Bb = dL[i4 + 2]; // the cell's terrain byte — same packing as R
      const Grb0 = dG[i4];
      const eT = trunk.get(i) ?? 0;
      const newGr = Math.max(Grb0, Math.min(255, Bb + eT));
      // UNDER A CAP — a room under its roof, a cave under its ceiling, ground
      // under a span — the linear column IS the cap: growing it would raise
      // the roof, and the sun (linear G) must not shade inside. The ground
      // share is the whole story there: the point-light march already falls
      // back to the GROUND map for a light under a cap (`lp.z <= H → hg`, in
      // the shader and the CPU twin alike), so a torch indoors shadows the
      // piece off exactly this byte. Skipping capped cells outright was the
      // first cut — measured as a barrel beside the player casting nothing,
      // behind/beside 1.00 (maintainer's house and cave, 2026-09-06).
      const capped = this.tArr[i] > this.bArr[i] + 1e-3;
      const newR = capped ? Rb0 : Math.max(Rb0, Math.min(255, Bb + eT));
      if (newR === Rb0 && newGr === Grb0) continue;
      const newG = Math.min(255, Gb0 + (newR - Rb0)); // R−G unchanged, byte-exact
      this.sceneryOrig.set(i, [Rb0, Gb0, Grb0, this.hArr[i], this.gArr[i], this.pArr[i]]);
      dL[i4] = newR;
      dL[i4 + 1] = newG;
      dG[i4] = newGr;
      // The share alone (B): what groundTerrAt subtracts and the own-cell skirt
      // skip keys on — the SAME bytes the column grew by, so R − B is exact.
      dG[i4 + 2] = newGr - Grb0;
      const dh = (newR - Rb0) / hs;
      const dg = (newGr - Grb0) / hs;
      this.hArr[i] += dh;
      this.gArr[i] += dg;
      this.pArr[i] += (newG - Gb0) / hs;
      this.sArrH[i] = dh;
      this.sArrG[i] = dg;
      stats.cells++;
    }
    // THE SPARSE GATE (G of the ground map): every cell within SCN_GATE_R of a
    // cell carrying ANY prop share. The sun patch samples up to 2.45 cells
    // from the pixel, its bilinear read spreads one more, and the pixel sits
    // up to 0.5 from its cell's centre: a share can influence a pixel at most
    // 3.95 cells away per axis, so a Chebyshev radius of 4 is complete.
    if (this.sceneryOrig.size > 0) {
      const dil = new Uint8Array(W * Hh);
      for (let i = 0; i < W * Hh; i++) {
        if (this.pArr[i] <= 0) continue;
        const c = i % W;
        const r = (i - c) / W;
        const r0 = Math.max(0, r - SCN_GATE_R);
        const r1 = Math.min(Hh - 1, r + SCN_GATE_R);
        const c0 = Math.max(0, c - SCN_GATE_R);
        const c1 = Math.min(W - 1, c + SCN_GATE_R);
        for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) dil[rr * W + cc] = 1;
      }
      for (let i = 0; i < W * Hh; i++)
        if (dil[i]) {
          dG[i * 4 + 1] = 255;
          this.sceneryDil.push(i);
        }
    }
    if (had || this.sceneryOrig.size > 0) {
      const maps: [string, ImageData][] = [
        ["world-heightmap-linear", this.imgL],
        ["world-heightmap-ground", this.imgG],
      ];
      for (const [key, img] of maps) {
        if (!this.scene.textures.exists(key)) continue;
        const t = this.scene.textures.get(key) as Phaser.Textures.CanvasTexture;
        t.getContext().putImageData(img, 0, 0);
        t.refresh();
        // refresh() re-applies the source's scale mode (see setRoom) — re-assert.
        t.setFilter(Phaser.Textures.FilterMode.LINEAR);
      }
    }
    this.hasSceneryShares = this.sceneryOrig.size > 0;
    this.shader?.setUniform("uHasProps.value", this.propsFlag());
    this.setScenerySwitches();
    stats.gateCells = this.sceneryDil.length;
    stats.ms = +(performance.now() - t0).toFixed(2);
    this.sceneryStats = stats;
  }

  /** CPU twin of the shader's lighting for a surface at (col,row,z): used to
   * tint STANDING objects (characters, wall columns, props) so they carry the
   * light of their own cell — the screen-space field only shades the flat
   * ground. Same ambient/attenuation/LOS/ember/flicker, same clock. */
  private curSun: [number, number, number, number] = [0, 0, 1, 0];
  private curCloud = 0;
  private curAurora = 0;
  private curMist = 0;

  /** EXACT JS twin of the shader's aurora curtains (additive RGB) — tints
   * the lit copies so characters glow with the sky. Change BOTH together. */
  auroraAt(
    wx: number,
    wy: number,
    aurora = this.curAurora,
    sunW = this.curSun[3],
  ): [number, number, number] {
    if (aurora <= 0.001) return [0, 0, 0];
    // Precision-exact integer hash — MUST stay identical to the shader's
    // cwHash/mHash (see the GLSL comment: the old sin-hash decorrelated
    // GPU vs CPU and the avatar tint sampled a different field).
    const hash = (x: number, y: number) => {
      const m971 = (v: number) => ((v % 971) + 971) % 971;
      let a2 = m971(x * 113 + y * 271);
      a2 = m971(a2 * a2 + 113);
      a2 = m971(a2 * a2 + x);
      a2 = m971(a2 * a2 + y);
      return a2 / 971;
    };
    const noise = (x: number, y: number) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
      return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
    };
    const t = this.scene.time.now / 1000; // same clock as uAnimTime
    const ax = wx * 0.0013 + t * 0.045;
    const ay = wy * 0.0013 - t * 0.02;
    const an = noise(ax, ay) * 0.6 + noise(ax * 2.1 + 31, ay * 2.1 + 31) * 0.4;
    const ss = Math.min(1, Math.max(0, (an - 0.40) / 0.4));
    const curtain = ss * ss * (3 - 2 * ss);
    const hue = 0.5 + 0.5 * Math.sin(t * 0.12 + wx * 0.0011);
    const k = curtain * 0.18 * aurora * (1 - sunW);
    return [
      (0.1 + (0.45 - 0.1) * hue) * k,
      (0.85 + (0.25 - 0.85) * hue) * k,
      (0.45 + (0.85 - 0.45) * hue) * k,
    ];
  }

  /** EXACT JS twin of the shader's cloud field (see cwNoise) — tints the
   * lit copies so characters dim as a cloud passes over them. */
  cloudFactorAt(wx: number, wy: number, cloud = this.curCloud, sunW = this.curSun[3]): number {
    if (cloud <= 0.001) return 1;
    // Precision-exact integer hash — MUST stay identical to the shader's
    // cwHash/mHash (see the GLSL comment: the old sin-hash decorrelated
    // GPU vs CPU and the avatar tint sampled a different field).
    const hash = (x: number, y: number) => {
      const m971 = (v: number) => ((v % 971) + 971) % 971;
      let a2 = m971(x * 113 + y * 271);
      a2 = m971(a2 * a2 + 113);
      a2 = m971(a2 * a2 + x);
      a2 = m971(a2 * a2 + y);
      return a2 / 971;
    };
    const noise = (x: number, y: number) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
      return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
    };
    const t = this.scene.time.now / 1000; // same clock as uAnimTime
    const cx = wx * 0.0018 + t * 0.075;
    const cy = wy * 0.0018 + t * 0.042;
    const n = noise(cx, cy) * 0.65 + noise(cx * 2.3 + 17, cy * 2.3 + 17) * 0.35;
    const ss = Math.min(1, Math.max(0, (n - 0.52) / 0.26));
    const cover = ss * ss * (3 - 2 * ss);
    return 1 - cover * 0.62 * cloud * (0.13 + 0.87 * sunW);
  }

  /** CPU twin of the shader's directional-sun shade for a surface (1 = fully
   * lit, ~0.62 = deepest shade). Drives lit-copy tints and the headless
   * verify probe. */
  sunFactorAt(
    col: number,
    row: number,
    z: number,
    sun: [number, number, number, number] = this.curSun,
    selfR2 = 0,
    groundContact = false,
  ): number {
    if (sun[3] <= 0.001) return 1;
    // z < 0 = "use the cell's own terrain height" (headless probe sugar).
    if (z < 0) {
      const ci = Math.floor(col), ri = Math.floor(row);
      z = ci < 0 || ri < 0 || ci >= this.world.width || ri >= this.world.height ? 0 : this.tArr[ri * this.world.width + ci];
      if (z > 90) z = 0;
    }
    const W = this.world.width;
    const H = this.world.height;
    const hAt = (c: number, r: number) => {
      const ci = Math.floor(c), ri = Math.floor(r);
      return ci < 0 || ri < 0 || ci >= W || ri >= H ? 99 : this.hArr[ri * W + ci];
    };
    const soft = (arr: Float32Array, empty: number) => (c: number, r: number) => {
      const cf = c - 0.5, rf = r - 0.5;
      const c0 = Math.floor(cf), r0 = Math.floor(rf);
      const fx = cf - c0, fy = rf - r0;
      const v = (ci: number, ri: number) =>
        ci < 0 || ri < 0 || ci >= W || ri >= H ? empty : arr[ri * W + ci];
      const a = v(c0, r0), b = v(c0 + 1, r0), d = v(c0, r0 + 1), e = v(c0 + 1, r0 + 1);
      if (a > 90 || b > 90 || d > 90 || e > 90) return empty === 99 ? hAt(c, r) : 0;
      return (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
    };
    const hAtSoft = soft(this.hArr, 99);
    const pAtSoft = soft(this.pArr, 0);
    const sstep = (e0: number, e1: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    // Mirror of the shader: terrain multiplicative (cliffs locked), props
    // as one smooth max-margin patch.
    let sunVis = 1;
    for (let sN = 1; sN <= 20; sN++) {
      const dc = sN * 0.6;
      const px = col - sun[0] * dc;
      const py = row - sun[1] * dc;
      if (Math.floor(px) === Math.floor(col) && Math.floor(py) === Math.floor(row)) continue;
      const hRay = z + dc * sun[2] + 0.15;
      const hh = hAtSoft(px, py) - pAtSoft(px, py);
      if (hh < 90 && hh > hRay) sunVis *= 0.8 + (0.35 - 0.8) * Math.min(1, (hh - hRay) * 1.2);
    }
    let m = 0;
    let dcp = 0;
    for (let sN = 1; sN <= 8; sN++) {
      dcp += 0.35;
      const px = col - sun[0] * dcp;
      const py = row - sun[1] * dcp;
      if (Math.floor(px) === Math.floor(col) && Math.floor(py) === Math.floor(row)) continue;
      const reach = sstep(2.7, 1.3, dcp);
      if (reach <= 0) break;
      const hRay = z + dcp * sun[2] + 0.15;
      let pr = pAtSoft(px, py);
      let hh = hAtSoft(px, py);
      if (selfR2 > 0 && dcp * dcp < selfR2) {
        // A piece's OWN shares do not shade its own copy — setSceneryOccluders.
        const sc = this.shareAtSoft(this.sArrH, px, py);
        pr -= sc;
        hh -= sc;
      }
      const hp = hh - pr + Math.min(1, pr * 1.8);
      if (pr > 0.001 && hh < 90 && hp > hRay)
        m = Math.max(m, Math.min(1, (hp - hRay) * 2.2) * reach);
    }
    // THE OWN TRUNK'S CORE, DIRECTIONALLY — the shader's rule; a lit copy
    // (selfR2 > 0) excludes its own shares and takes none of it.
    if (selfR2 <= 0 && this.hasSceneryShares) {
      const oc = Math.floor(col);
      const orow = Math.floor(row);
      const Wc = this.world.width;
      const Hc = this.world.height;
      const oi = orow * Wc + oc;
      const ownShareRaw = oc >= 0 && orow >= 0 && oc < Wc && orow < Hc ? this.sArrG[oi] : 0;
      // The shader's rule: a deck pixel does not read the floor's furniture.
      const ownShare = ownShareRaw > 0 && z > this.gArr[oi] - this.sArrG[oi] + 1 ? 0 : ownShareRaw;
      if (ownShare > 0) {
        const ocx = oc + 0.5;
        const ocy = orow + 0.5;
        if (groundContact) m = Math.max(m, SCN_CONTACT_SUN * smoothStep01(SCN_CONTACT_R, SCN_CONTACT_R * 0.3, Math.hypot(col - ocx, row - ocy)));
        const tt = (ocx - col) * -sun[0] + (ocy - row) * -sun[1];
        if (tt > 0.05) {
          const dq = Math.hypot(col - sun[0] * tt - ocx, row - sun[1] * tt - ocy);
          const hRayC = z + tt * sun[2] + 0.15;
          const top = z + Math.min(1, ownShare * 1.8);
          if (top > hRayC) m = Math.max(m, Math.min(1, (top - hRayC) * 2.2) * smoothStep01(SCN_CORE, SCN_CORE * 0.55, dq));
        }
      }
    }
    sunVis *= 1 - 0.75 * m;
    const sunShare = 0.45 * sun[3];
    return 1 - sunShare + sunShare * Math.max(0, Math.min(1, sunVis));
  }

  lightAt(col: number, row: number, z: number, isObj: boolean, selfR2 = 0, parts?: LightParts, groundContact = false): [number, number, number] {
    const W = this.world.width;
    const H = this.world.height;
    const hAt = (c: number, r: number) => {
      const ci = Math.floor(c), ri = Math.floor(r);
      return ci < 0 || ri < 0 || ci >= W || ri >= H ? 99 : this.hArr[ri * W + ci];
    };
    // Bilinear twin of the shader's heightAtSoft (LOS penumbra).
    const soft2 = (arr: Float32Array) => (c: number, r: number) => {
      const cf = c - 0.5, rf = r - 0.5;
      const c0 = Math.floor(cf), r0 = Math.floor(rf);
      const fx = cf - c0, fy = rf - r0;
      const v = (ci: number, ri: number) =>
        ci < 0 || ri < 0 || ci >= W || ri >= H ? 99 : arr[ri * W + ci];
      const a = v(c0, r0), b = v(c0 + 1, r0), d = v(c0, r0 + 1), e = v(c0 + 1, r0 + 1);
      if (a > 90 || b > 90 || d > 90 || e > 90) return hAt(c, r);
      return (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
    };
    const hAtSoft = soft2(this.hArr);
    // Twin of groundAtSoft: the ground column alone, deck excluded.
    const gAtSoft = soft2(this.gArr);
    // Same clock as uAnimTime (scene.time.now): the shader's flicker and the
    // scenery-lit pipeline's are on it, and a copy beside a shaded piece must
    // breathe in phase with it (game.loop.getDuration lags by the boot).
    const t = this.scene.time.now / 1000;
    // The own-cell skirt skip, twin of the shader's (see FRAG): the pixel's
    // cell carries a scenery share → samples within a cell of its centre skip.
    const oc = Math.floor(col);
    const orow = Math.floor(row);
    const oidx = orow * W + oc;
    const ownShareRaw = this.hasSceneryShares && oc >= 0 && orow >= 0 && oc < W && orow < H ? this.sArrG[oidx] : 0;
    // The shader's rule: a deck pixel does not read the floor's furniture.
    const ownShare = ownShareRaw > 0 && z > this.gArr[oidx] - this.sArrG[oidx] + 1 ? 0 : ownShareRaw;
    const ocx = oc + 0.5;
    const ocy = orow + 0.5;
    // Directional-sun + cloud twins (see the shader): shade the ambient term.
    const geo = this.geo;
    const wxT = this.iso.ox + (col - row) * geo.dx + geo.dx;
    const wyT = this.iso.oy + (col + row) * geo.dy + geo.dy - z * geo.lh;
    const sunOnly = this.sunFactorAt(col, row, z, this.curSun, selfR2, groundContact);
    const sunF = sunOnly * this.cloudFactorAt(wxT, wyT);
    const aur = this.auroraAt(wxT, wyT);
    // EXACT TWIN of the fragment's `inRoom` (roomAt): indoors, a cell outside
    // MY room gets no ambient and no sky glow — only the point lights below.
    // The shader and this must agree or a body standing just outside the
    // doorway is tinted for a different world than the ground it stands on.
    // Eased on indoorMix exactly like the fragment's mix(1.0, roomAt, uIndoorMix),
    // and gated on the EASE rather than `indoor` for the same reason: the mask
    // has to outlive the boolean or stepping out gives the whole world the
    // interior's light for the length of the fade.
    const hit =
      this.indoorMix > 0
        ? this.roomCells.has(Math.floor(row) * this.world.width + Math.floor(col)) ? 1 : 0
        : 1;
    const inRoom = 1 + (hit - 1) * this.indoorMix;
    // TWIN of the fragment's two-grade `amb` mix: in-room rides curAmbient (the
    // blended one), outside fades between black and the OUTDOOR grade only.
    const ao = this.indoorMix > 0 ? this.ambientOut : this.curAmbient;
    const k = 1 - this.indoorMix;
    const amb = (i: number) => this.curAmbient[i] * hit + ao[i] * k * (1 - hit);
    const out: [number, number, number] = [
      amb(0) * sunF + aur[0] * inRoom,
      amb(1) * sunF + aur[1] * inRoom,
      amb(2) * sunF + aur[2] * inRoom,
    ];
    if (parts) {
      parts.base[0] = out[0];
      parts.base[1] = out[1];
      parts.base[2] = out[2];
      parts.sunF = sunOnly;
      parts.ao = 1;
      parts.occ.fill(1);
    }
    for (let i = 0; i < this.curLights.length && i < MAX_SHADER_LIGHTS; i++) {
      const L = this.curLights[i];
      const dx = L.col - col;
      const dy = L.row - row;
      const radius = Math.abs(L.radius); // negative = shadow-free glow pool
      const dist = Math.sqrt(dx * dx + dy * dy + Math.pow((L.z - z) * 0.6, 2));
      let att = Math.max(0, 1 - dist / radius);
      att *= att;
      // A lit copy's crown reaches nearer the light than its axis: its
      // occlusion is marched whenever the light is within reach of the volume.
      const wantOcc = parts !== undefined && dist < radius + SCN_CROWN_REACH;
      if (att <= 0.001 && !wantOcc) continue;
      let occ = 1;
      const lc = Math.floor(L.col);
      const lr = Math.floor(L.row);
      const lShare = this.hasSceneryShares && lc >= 0 && lr >= 0 && lc < W && lr < H ? this.sArrG[lr * W + lc] : 0;
      const lcx = lc + 0.5;
      const lcy = lr + 0.5;
      if (L.radius > 0 && (att * Math.max(L.color[0], L.color[1], L.color[2]) > SHADOW_MARCH_MIN_LIGHT || wantOcc) && (z < L.z + 0.05 || isObj)) {
        for (let sN = 1; sN <= 12; sN++) {
          const tt = sN / 13;
          const px = col + dx * tt;
          const py = row + dy * tt;
          if (Math.floor(px) === Math.floor(col) && Math.floor(py) === Math.floor(row)) continue;
          if ((px - col) * (px - col) + (py - row) * (py - row) < 0.56) continue; // near-field
          if (ownShare > 0 && (px - ocx) * (px - ocx) + (py - ocy) * (py - ocy) < 1.0) continue; // own trunk's skirt
          if (lShare > 0 && (px - lcx) * (px - lcx) + (py - lcy) * (py - lcy) < 1.0) continue; // the LIGHT's own trunk (a fire IS its piece)
          const hRay = z + (L.z - z) * tt + 0.2;
          // EXACT twin of the shader's two-span test: a deck is a floating
          // slab, so it only blocks a ray whose light is on its far side.
          let hh = hAtSoft(px, py);
          let hg = gAtSoft(px, py);
          if (selfR2 > 0 && (px - col) * (px - col) + (py - row) * (py - row) < selfR2) {
            // The piece's OWN shares (0 off-grid) — subtracted inside its
            // exclusion radius so its lit copy is never shadowed by itself.
            hh -= this.shareAtSoft(this.sArrH, px, py);
            hg -= this.shareAtSoft(this.sArrG, px, py);
          }
          const blocker = hh > hg + 0.01 && L.z <= hh ? hg : hh;
          if (blocker < 90 && blocker > hRay) {
            const pen = Math.min(1, (blocker - hRay) * 1.5);
            const pc = Math.floor(px);
            const pr = Math.floor(py);
            const inSelf = selfR2 > 0 && (px - col) * (px - col) + (py - row) * (py - row) < selfR2;
            const sc = !inSelf && this.hasSceneryShares && pc >= 0 && pr >= 0 && pc < W && pr < H && this.sArrG[pr * W + pc] > 0.01;
            occ *= sc ? SCN_SHADOW_NEAR + (SCN_SHADOW_DEEP - SCN_SHADOW_NEAR) * pen : 0.8 + (0.45 - 0.8) * pen;
          }
        }
        // THE OWN TRUNK'S CORE, DIRECTIONALLY — the shader's rule.
        if (ownShare > 0 && selfR2 <= 0) {
          if (groundContact) occ *= 1 - SCN_CONTACT_TORCH * smoothStep01(SCN_CONTACT_R, SCN_CONTACT_R * 0.3, Math.hypot(col - ocx, row - ocy));
          const dd = Math.max(dx * dx + dy * dy, 1e-4);
          const tt = ((ocx - col) * dx + (ocy - row) * dy) / dd;
          if (tt > 0.05 && tt < 1) {
            const dq = Math.hypot(col + dx * tt - ocx, row + dy * tt - ocy);
            const hRayC = z + (L.z - z) * tt + 0.2;
            const top = z + ownShare;
            if (top > hRayC) {
              const k = 0.8 + (0.22 - 0.8) * Math.min(1, (top - hRayC) * 1.5);
              occ *= 1 + (k - 1) * smoothStep01(SCN_CORE, SCN_CORE * 0.55, dq);
            }
          }
        }
        occ = Math.max(occ, 0.22); // bounce floor — same as the shader
      }
      if (parts && i < parts.occ.length) parts.occ[i] = occ;
      if (att <= 0.001) continue;
      const fl = L.flicker;
      const flick = 1 - fl * 0.1 * (0.5 + 0.5 * Math.sin(t * 2.9 + i * 5.3)) - fl * 0.05 * Math.sin(t * 7.1 + i * 11.1);
      const d01 = Math.min(1, dist / radius);
      const sst = Math.min(1, Math.max(0, (d01 - 0.35) / 0.6));
      const emberK = sst * sst * (3 - 2 * sst) * Math.min(1, fl * 1.2);
      const eb = [0.95, 0.3, 0.12];
      for (let ch = 0; ch < 3; ch++) {
        const lc = L.color[ch];
        const colr = lc * (1 - emberK) + lc * eb[ch] * emberK;
        out[ch] += colr * att * occ * flick;
      }
    }
    // Ambient occlusion twin (ground side): a body tucked against a HIGHER
    // terrain wall darkens toward the seam with the ground it stands on.
    // BASE terrain heights, like the shader's baseTerrAt: a bridge span
    // overhead is not a wall — swimmers next to it must not phantom-darken.
    {
      const W2 = this.world.width;
      const H2 = this.world.height;
      // Clamped to the cut-away indoors, for the same reason heightAt is: the
      // seam is between a body and the wall AS DRAWN, and a wall truncated to
      // level 3 must not cast a level-6 wall's shading onto the floor beside
      // it. Per CELL like the shader — an unconstrained column (no entry) is
      // drawn whole and seams at its real height; the legacy cut (roomCuts
      // null) clamps everything at the scalar dial.
      const tAt = (ci: number, ri: number) => {
        if (ci < 0 || ri < 0 || ci >= W2 || ri >= H2) return 99;
        const b = this.bArr[ri * W2 + ci];
        if (!this.indoor) return b;
        if (!this.roomCuts) return Math.min(b, this.indoorTop);
        const e = this.roomCuts.get(ri * W2 + ci);
        return e === undefined ? b : Math.min(b, e);
      };
      const ci = Math.floor(col);
      const ri = Math.floor(row);
      const vColLo = 2 * ci - (col - row);
      const vRowLo = 2 * ri + (col - row);
      const hb = vColLo >= vRowLo ? tAt(ci - 1, ri) : tAt(ci, ri - 1);
      if (hb < 90 && hb > z + 0.5) {
        const dBase = Math.max(0, (col + row - Math.max(vColLo, vRowLo)) * 15);
        const t2 = Math.min(1, dBase / 6);
        const ao = 0.72 + 0.28 * (t2 * t2 * (3 - 2 * t2));
        for (let ch = 0; ch < 3; ch++) out[ch] *= ao;
        if (parts) {
          parts.ao = ao;
          for (let ch = 0; ch < 3; ch++) parts.base[ch] *= ao;
        }
      }
    }
    // Glow-halo twin (added after AO, like the shader): a character standing
    // in a mushroom/crystal halo must carry its glow — the field lights the
    // ground but the lit copy is tinted by THIS function only.
    if (this.curStamps.length) {
      const { dx, dy, lh } = this.geo;
      const wx = this.iso.ox + (col - row) * dx + dx;
      const wy = this.iso.oy + (col + row) * dy + dy - z * lh;
      for (const g of this.curStamps) {
        if (g.litChar === false) continue; // high prop halos don't tint bodies
        const d = Math.hypot(g.x - wx, g.y - wy) / g.radius;
        if (d >= 1) continue;
        const f = (1 - d) * (1 - d); // ≈ the stamp texture's falloff
        for (let ch = 0; ch < 3; ch++) out[ch] += g.color[ch] * g.alpha * f;
        if (parts) for (let ch = 0; ch < 3; ch++) parts.base[ch] += g.color[ch] * g.alpha * f;
      }
    }
    return out;
  }

  /** THE FRAME'S LIGHTS AS THE NIGHT PASS UPLOADS THEM — col,row,z,±radius /
   *  r,g,b,flicker, the sun and the animation clock — for the scenery-lit
   *  pipeline, so a piece is lit by the SAME lights, phase and flicker as the
   *  ground it stands on (one ledger, no second light list). Live views. */
  lightUniforms(): { pos: Float32Array; col: Float32Array; n: number; sun: [number, number, number, number]; time: number } {
    const u = this.lightU;
    u.pos = this.posArr;
    u.col = this.colArr;
    u.n = Math.min(this.curLights.length, MAX_SHADER_LIGHTS);
    u.sun = this.curSun;
    u.time = this.scene.time.now / 1000;
    return u;
  }
  /** One object, mutated per call — the pipeline reads it every frame. */
  private lightU: { pos: Float32Array; col: Float32Array; n: number; sun: [number, number, number, number]; time: number } = {
    pos: new Float32Array(0),
    col: new Float32Array(0),
    n: 0,
    sun: [0, 0, 1, 0],
    time: 0,
  };

  /** The sun's current strength (uSun.w) — no object per read. */
  get sunStrength(): number {
    return this.curSun[3];
  }

  /** Bilinear read of a scenery-share array at (c, r) — 0 off-grid. Twin of
   *  the map's LINEAR filter for the share alone; no closure per call. */
  private shareAtSoft(arr: Float32Array, c: number, r: number): number {
    const cf = c - 0.5;
    const rf = r - 0.5;
    const c0 = Math.floor(cf);
    const r0 = Math.floor(rf);
    const fx = cf - c0;
    const fy = rf - r0;
    return (
      (this.shareCell(arr, c0, r0) * (1 - fx) + this.shareCell(arr, c0 + 1, r0) * fx) * (1 - fy) +
      (this.shareCell(arr, c0, r0 + 1) * (1 - fx) + this.shareCell(arr, c0 + 1, r0 + 1) * fx) * fy
    );
  }
  private shareCell(arr: Float32Array, ci: number, ri: number): number {
    const W = this.world.width;
    return ci < 0 || ri < 0 || ci >= W || ri >= this.world.height ? 0 : arr[ri * W + ci];
  }

  /** lightAt packed as a Phaser tint (multiplier clamped to 1). */
  tintAt(col: number, row: number, z: number, isObj: boolean, selfR2 = 0): number {
    const l = this.lightAt(col, row, z, isObj, selfR2);
    const r = Math.min(255, Math.round(Math.min(1, l[0]) * 255));
    const g = Math.min(255, Math.round(Math.min(1, l[1]) * 255));
    const b = Math.min(255, Math.round(Math.min(1, l[2]) * 255));
    return (r << 16) | (g << 8) | b;
  }

  setActive(on: boolean) {
    this.active = on;
    this.shader?.setVisible(on);
    this.overlay?.setVisible(on);
    if (!on) {
      this.mistShader?.setVisible(false);
      this.mistOverlay?.setVisible(false);
      this.depthFogShader?.setVisible(false);
      this.depthFogOverlay?.setVisible(false);
    }
  }

  /** Headless-debug: real dimensions of the render target vs the screen. */
  /** What the night pass cost this beacon window, and the geometry it cost it
   *  over: lights uploaded (mean + peak), how many of them MARCH SHADOWS (the
   *  12-sample loop — the actual per-fragment bill), the summed pool area in
   *  cells, and the FIELD the shader runs at. Resolution is the biggest lever
   *  there is (`?light=` scales it) and was invisible to the beacon until now,
   *  so a slow run could not be told apart from a large one. Drains on read. */
  lightBill(): Record<string, number | string> {
    const f = Math.max(1, this.bill.frames);
    const w = Math.round(this.shader?.width ?? 0);
    const h = Math.round(this.shader?.height ?? 0);
    const out = {
      frames: this.bill.frames,
      n: +(this.bill.n / f).toFixed(2),
      shadowing: +(this.bill.shadowing / f).toFixed(2),
      nMax: this.bill.nMax,
      shadowMax: this.bill.shadowMax,
      poolCells: Math.round(this.bill.poolCells / f),
      ambient: this.bill.ambient,
      field: `${w}x${h}`,
      ls: lightScale(),
      fragPerPass: w * h,
      // What the pass UPDATE cost, ms per frame: the glow render-texture, and
      // the rest (uniform writes + overlay bookkeeping) as updMs - glowMs.
      updMs: +(this.updMs / f).toFixed(3),
      glowMs: +(this.updGlowMs / f).toFixed(3),
    };
    this.bill = { frames: 0, n: 0, shadowing: 0, poolCells: 0, nMax: 0, shadowMax: 0, ambient: this.bill.ambient };
    this.updMs = 0;
    this.updGlowMs = 0;
    return out;
  }

  debugInfo() {
    const key = this.overlay?.texture.key ?? "?";
    const tex = this.scene.textures.get(key);
    const src = tex?.getSourceImage() as { width?: number; height?: number } | undefined;
    const frame = tex?.get();
    return {
      key,
      srcW: src?.width,
      srcH: src?.height,
      frameW: frame?.width,
      frameH: frame?.height,
      shaderW: this.shader?.width,
      shaderH: this.shader?.height,
      canvasW: this.scene.scale.width,
      canvasH: this.scene.scale.height,
      overlayW: this.overlay?.displayWidth,
      overlayH: this.overlay?.displayHeight,
      flipY: this.overlay?.flipY,
    };
  }

  /** A/B: arm or disarm the hierarchical skip on every pass (dev probe). */
  setSkip(on: boolean): boolean {
    this.skipOn = on;
    for (const sh of [this.shader, this.mistShader, this.depthFogShader])
      sh?.setUniform("uSkip.value", on && this.scene.textures.exists(BLOCK_KEY) ? 1 : 0);
    return on;
  }

  /** THE RAW PIXELS of a pass's own framebuffer, hashed — read with
   *  gl.readPixels while its framebuffer is bound, so it is exact for ANY
   *  alpha (the depth-fog pass writes fractional alpha, which a 2D-canvas
   *  round trip would premultiply and quantise — review, 2026-09-02) and
   *  synchronous. */
  private hashPass(sh: Phaser.GameObjects.Shader): string {
    const buf = this.readPass(sh);
    let h = 0x811c9dc5;
    for (let i = 0; i < buf.length; i++) h = Math.imul(h ^ buf[i], 0x01000193) >>> 0;
    return h.toString(16).padStart(8, "0");
  }

  /** The raw RGBA of a pass's framebuffer (what hashPass hashes). */
  private readPass(sh: Phaser.GameObjects.Shader): Uint8Array {
    const r = this.scene.game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
    const gl = r.gl;
    const fb = (sh as unknown as { framebuffer?: unknown }).framebuffer;
    if (!fb) throw new Error("pass has no framebuffer");
    (r as unknown as { setFramebuffer: (f: unknown, s?: boolean) => void }).setFramebuffer(fb, true);
    const buf = new Uint8Array(sh.width * sh.height * 4);
    gl.readPixels(0, 0, sh.width, sh.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    (r as unknown as { setFramebuffer: (f: unknown, s?: boolean) => void }).setFramebuffer(null, true);
    return buf;
  }

  private passSnaps = new Map<string, Uint8Array>();

  /** DIAGNOSTIC: keep a pass's raw pixels under a label, for diffPass. */
  snapPass(which: "night" | "fog", label: string): number {
    const sh = which === "night" ? this.shader : this.depthFogShader;
    if (!sh) throw new Error(`no ${which} pass`);
    const buf = this.readPass(sh);
    this.passSnaps.set(label, buf);
    return buf.length;
  }

  /** DIAGNOSTIC: how two snapshots differ — a hash says "not equal", this says
   *  by how much (max |Δ| per byte, how many bytes, where). */
  diffPass(
    a: string,
    b: string,
  ): { bytes: number; differing: number; maxAbs: number; meanAbs: number; box: number[] | null; w: number; samples: number[][] } | null {
    const A = this.passSnaps.get(a);
    const B = this.passSnaps.get(b);
    if (!A || !B || A.length !== B.length) return null;
    const w = this.shader?.width ?? 0;
    let differing = 0;
    let maxAbs = 0;
    let sum = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    const samples: number[][] = []; // [px, py, Ar,Ag,Ab,Aa, Br,Bg,Bb,Ba] at a few differing pixels
    for (let i = 0; i < A.length; i++) {
      const d = Math.abs(A[i] - B[i]);
      if (d) {
        differing++;
        sum += d;
        if (d > maxAbs) maxAbs = d;
        if (w) {
          const px = (i >> 2) % w, py = Math.floor((i >> 2) / w);
          if (px < x0) x0 = px;
          if (px > x1) x1 = px;
          if (py < y0) y0 = py;
          if (py > y1) y1 = py;
          if (samples.length < 6 && differing % 4000 === 1) {
            const k = (i >> 2) * 4;
            samples.push([px, py, A[k], A[k + 1], A[k + 2], A[k + 3], B[k], B[k + 1], B[k + 2], B[k + 3]]);
          }
        }
      }
    }
    // box = [x0, y0, x1, y1] in pass texels (readPixels rows are bottom-up).
    return { bytes: A.length, differing, maxAbs, meanAbs: differing ? +(sum / differing).toFixed(3) : 0, box: differing ? [x0, y0, x1, y1] : null, w, samples };
  }

  /** DIAGNOSTIC: the bytes the two LINEAR maps hold for a cell range — from the
   *  retained ImageData AND read back from the live canvas (must agree), plus the
   *  CPU twins — so a GPU reading that disagrees can be attributed. */
  heightmapBytes(c0: number, r0: number, c1: number, r1: number): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    const W = this.world.width;
    const tL = this.scene.textures.exists("world-heightmap-linear") ? (this.scene.textures.get("world-heightmap-linear") as Phaser.Textures.CanvasTexture) : null;
    const tG = this.scene.textures.exists("world-heightmap-ground") ? (this.scene.textures.get("world-heightmap-ground") as Phaser.Textures.CanvasTexture) : null;
    const cL = tL ? tL.getContext().getImageData(c0, r0, c1 - c0 + 1, r1 - r0 + 1).data : null;
    const cG = tG ? tG.getContext().getImageData(c0, r0, c1 - c0 + 1, r1 - r0 + 1).data : null;
    const cw = c1 - c0 + 1;
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const i = r * W + c;
        const k = ((r - r0) * cw + (c - c0)) * 4;
        out[`${c},${r}`] = [
          this.imgL?.data[i * 4] ?? -1, this.imgL?.data[i * 4 + 1] ?? -1, this.imgL?.data[i * 4 + 2] ?? -1, this.imgG?.data[i * 4] ?? -1,
          cL ? cL[k] : -1, cL ? cL[k + 1] : -1, cL ? cL[k + 2] : -1, cG ? cG[k] : -1,
          +(this.hArr[i] ?? -1).toFixed(2), +(this.pArr[i] ?? -1).toFixed(2), +(this.gArr[i] ?? -1).toFixed(2), this.tArr[i] ?? -1,
        ];
      }
    return out;
  }

  /** DIAGNOSTIC: the sampler uniforms of the night pass in their sync order and the texture key each holds. */
  samplerLayout(): string[] {
    const sh = this.shader as unknown as { uniforms?: Record<string, { type?: string; value?: unknown; textureKey?: string }> } | undefined;
    const out: string[] = [];
    if (!sh?.uniforms) return out;
    let n = 0;
    for (const [k, u] of Object.entries(sh.uniforms)) {
      if (u.value === null || u.value === undefined) continue;
      if (u.type === "sampler2D") out.push(`unit${n++}:${k}=${u.textureKey ?? "?"}`);
    }
    return out;
  }

  /** DIAGNOSTIC: the GL filters the height maps carry NOW (9729 = LINEAR, 9728 =
   *  NEAREST). A CanvasTexture refresh() re-uploads with the renderer's default
   *  (NEAREST under pixelArt), so setSceneryOccluders must re-assert LINEAR on
   *  the two bilinear maps — this is the proof that it did. */
  heightmapFilters(): Record<string, number | null> {
    const f = (key: string): [number | null, number | null] => {
      if (!this.scene.textures.exists(key)) return [null, null];
      const g = this.scene.textures.get(key).source[0]?.glTexture as unknown as { minFilter?: number; magFilter?: number } | null;
      return [g?.minFilter ?? null, g?.magFilter ?? null];
    };
    const [linMin, linMag] = f("world-heightmap-linear");
    const [gndMin, gndMag] = f("world-heightmap-ground");
    const [surfMin, surfMag] = f("world-heightmap");
    return { linMin, linMag, gndMin, gndMag, surfMin, surfMag };
  }

  /** DIAGNOSTIC: the fog PASS's own pixel over a cell's tread centre (its
   *  premultiplied output, unpremultiplied here) beside the JS twin's answer
   *  for that cell — the two must agree for the fog silhouettes to match the
   *  ground. `wx/wy` are the world point sampled, `px/py` the pass texel. */
  fogProbe(col: number, row: number): Record<string, unknown> {
    const lvl = this.tArr?.[Math.floor(row) * this.world.width + Math.floor(col)] ?? 0;
    const wx = this.iso.ox + (col - row) * this.geo.dx + this.geo.dx;
    const wy = this.iso.oy + 8 + (col + row) * this.geo.dy + this.geo.dy - lvl * this.geo.lh;
    return { ...this.fogProbeAt(wx, wy), cell: [col, row, lvl] };
  }

  /** DIAGNOSTIC: the fog PASS's pixel at a world point beside the foot-point twin there. */
  fogProbeAt(wx: number, wy: number): Record<string, unknown> {
    const sh = this.depthFogShader;
    if (!sh || !this.tArr) throw new Error("no fog pass");
    const sd = this.screenFogDist(wx, wy);
    const lvl = this.tArr[Math.floor(sd.srow) * this.world.width + Math.floor(sd.scol)] ?? 0;
    const cam = (sh as unknown as { uniforms: Record<string, { value: { x: number; y: number; z: number; w: number } | number }> }).uniforms;
    const uCam = cam.uCam.value as { x: number; y: number; z: number; w: number };
    const flip = cam.uFlip.value as number;
    const sx = (wx - uCam.x) / uCam.z;
    let sy = (wy - uCam.y) / uCam.w;
    sy = flip > 0.5 ? 1 - sy : sy;
    const px = Math.floor(sx * sh.width);
    const py = Math.floor(sy * sh.height);
    const r = this.scene.game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
    const gl = r.gl;
    const fb = (sh as unknown as { framebuffer?: unknown }).framebuffer;
    if (!fb) throw new Error("pass has no framebuffer");
    (r as unknown as { setFramebuffer: (f: unknown, s?: boolean) => void }).setFramebuffer(fb, true);
    const buf = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    (r as unknown as { setFramebuffer: (f: unknown, s?: boolean) => void }).setFramebuffer(null, true);
    const a = buf[3] / 255;
    const un = (v: number) => (a > 0 ? +(v / 255 / a).toFixed(3) : 0);
    const foot = this.depthFogAtFoot(wx, wy, lvl, sd.scol, sd.srow);
    const twin0 = this.depthFogAt(sd.scol, sd.srow, lvl, true);
    return {
      wx, wy, px, py, inView: sx >= 0 && sx < 1 && sy >= 0 && sy < 1, field: { scol: +sd.scol.toFixed(2), srow: +sd.srow.toFixed(2), distH: +sd.distH.toFixed(2), lvl },
      pass: { a: +a.toFixed(3), r: un(buf[0]), g: un(buf[1]), b: un(buf[2]) },
      twin: { a: +foot.a.toFixed(3), r: +foot.r.toFixed(3), g: +foot.g.toFixed(3), b: +foot.b.toFixed(3) },
      twinSnap: { a: +twin0.a.toFixed(3), r: +twin0.r.toFixed(3), g: +twin0.g.toFixed(3), b: +twin0.b.toFixed(3) },
      player: { xy: this.curPlayerXY, z: this.curPlayerZ }, ambient: this.curAmbient,
    };
  }

  /** PARITY: a hash of a pass's OWN pixels as last rendered (dev probe). */
  passHash(which: "night" | "fog"): Promise<{ hash: string; w: number; h: number }> {
    const sh = which === "night" ? this.shader : this.depthFogShader;
    if (!sh) return Promise.reject(new Error(`no ${which} pass`));
    try {
      return Promise.resolve({ hash: this.hashPass(sh), w: sh.width, h: sh.height });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** PARITY, SAME TURN: render a pass with the skip OFF and read its pixels,
   *  then with the skip ON and read again — nothing else changes in between
   *  (no frame passes: uAnimTime, the eased ambient and every light are the
   *  same uniforms for both), so the two hashes differ only by the skip. The
   *  renderer draws a render-to-texture shader with exactly load() + flush()
   *  (ShaderWebGLRenderer). Raw readPixels, so exact for both passes. */
  parityHash(which: "night" | "fog", toggle: "skip" | "gate" = "skip"): Promise<{ full: string; skip: string; w: number; h: number }> {
    const sh = which === "night" ? this.shader : this.depthFogShader;
    if (!sh) return Promise.reject(new Error(`no ${which} pass`));
    const draw = sh as unknown as { load: () => void; flush: () => void };
    const armed = this.scene.textures.exists(BLOCK_KEY);
    if (toggle === "gate") {
      // THE SPARSE SUN-PATCH GATE, same turn: the pass with the prop loop run
      // for every pixel, then gated by the ground map's G flag — nothing else
      // changing. `full` = ungated, `skip` = gated; equal = the gate is identity.
      const gated = this.hasSceneryShares && this.sunGate ? 1 : 0;
      try {
        sh.setUniform("uPropGate.value", 0);
        draw.load();
        draw.flush();
        const full = this.hashPass(sh);
        sh.setUniform("uPropGate.value", this.hasSceneryShares ? 1 : 0);
        draw.load();
        draw.flush();
        const skip = this.hashPass(sh);
        sh.setUniform("uPropGate.value", gated);
        return Promise.resolve({ full, skip, w: sh.width, h: sh.height });
      } catch (e) {
        sh.setUniform("uPropGate.value", gated);
        return Promise.reject(e);
      }
    }
    try {
      sh.setUniform("uSkip.value", 0);
      draw.load();
      draw.flush();
      const full = this.hashPass(sh);
      sh.setUniform("uSkip.value", armed ? 1 : 0);
      draw.load();
      draw.flush();
      const skip = this.hashPass(sh);
      sh.setUniform("uSkip.value", this.skipOn && armed ? 1 : 0);
      return Promise.resolve({ full, skip, w: sh.width, h: sh.height });
    } catch (e) {
      sh.setUniform("uSkip.value", this.skipOn && armed ? 1 : 0);
      return Promise.reject(e);
    }
  }

  update(
    cam: Phaser.Cameras.Scene2D.Camera,
    lights: ShaderLight[],
    ambient: [number, number, number],
    stamps: GlowStamp[] = [],
    sun: [number, number, number, number] = [0, 0, 1, 0],
    cloud = 0,
    aurora = 0,
    mist = 0,
    playerZ = 0,
    playerCol = 0,
    playerRow = 0,
  ) {
    this.curLights = lights;
    this.curStamps = stamps;
    this.curAmbient = ambient;
    this.curSun = sun;
    this.curCloud = cloud;
    this.curAurora = aurora;
    this.curMist = mist;
    this.curPlayerZ = this.fogTestZ ?? playerZ;
    this.curPlayerXY = this.fogTestXY ?? [playerCol, playerRow];
    if (!this.shader || !this.active) return;
    const tUpd0 = performance.now();
    const s = this.shader;
    // The overlay Images are setScrollFactor(0) but Phaser STILL scales them by the
    // camera zoom. Counter that here: scale each overlay by 1/zoom so its on-screen
    // size is ALWAYS exactly the screen. Previously the code left the overlays at
    // scale 1 and instead INFLATED the world window by zoom (so the visible centred
    // 1/zoom portion showed the view) — that only covers the screen for zoom >= 1. The
    // speed-coupled zoom-OUT drops the zoom BELOW the base, and on a phone (base zoom 1)
    // below 1, so the screen-sized overlay rendered SMALLER than the screen and left the
    // newly revealed margins UNSHADED (maintainer 2026-07-24, mobile-only). With the
    // counter-scale the overlay fills the screen at any zoom, so uCam is just the plain
    // camera view (× spanScale) and the field maps 1:1 to what the camera shows.
    const zoom = cam.zoom || 1;
    const invZoom = 1 / zoom;
    // ×k: the drawn quad grows with the field window (see spanScale) — the
    // stretches cancel, the mapping stays exact, and the quad bleeds past
    // every screen edge so rounding can never expose an unshaded line.
    // TEST PATTERNS opt out (k = 1): the raw-field readbacks (nightCal
    // patterns ≥3, the glow-seams scan) treat canvas pixels as field texels
    // 1:1, and the 2% stretch resamples rows into phantom straight seams.
    const k = this.testPattern >= 3 ? 1 : this.spanScale;
    this.overlay?.setScale(invZoom * k);
    this.mistOverlay?.setScale(invZoom * k);
    this.depthFogOverlay?.setScale(invZoom * k);
    // NOT cam.worldView: inside update() that is LAST frame's rectangle, and
    // every night-pass pixel then trails the sprites by one frame of camera
    // motion (measured: lit ground between a running block and its shadow).
    const wv = renderedWorldView(cam, this.viewRect);
    const camX = wv.x - (wv.width * (k - 1)) / 2;
    const camY = wv.y - (wv.height * (k - 1)) / 2;
    // Drive the shader animation clock from the SAME source as the JS
    // emission layers (glow stamps below, lit-copy tints) so the shader
    // floor + fire flicker move and stay phase-locked with them.
    s.setUniform("uAnimTime.value", this.scene.time.now / 1000);
    s.setUniform("uCam.value.x", camX);
    s.setUniform("uCam.value.y", camY);
    s.setUniform("uCam.value.z", wv.width * k);
    s.setUniform("uCam.value.w", wv.height * k);
    // Redraw the glow-halo field for this frame's window: one tinted radial
    // stamp per visible emission source, animated by per-source phase.
    const tGlow0 = performance.now();
    if (this.glowRT && this.stampImg) {
      const rt = this.glowRT;
      // World px -> glow-RT texel. The shader samples uGlow normalized over
      // uCam's window (guv = (world-camX)/uCam.z), so a source at world g lands
      // at texel (g-camX)*rt.width/uCam.z. Scale every stamp by that factor so
      // the halos stay ON their sources at ANY zoom. It equals 1 only when
      // uCam.z == rt.width (world window == canvas px); the overlay-coverage fix
      // set uCam.z to the PLAIN view (= canvas/zoom), so at zoom!=1 this is
      // zoom/k — without it the glow slid off its source by 1/zoom when the
      // camera zoomed out while running (maintainer 2026-07-25).
      const gscale = rt.width / (wv.width * k);
      // A clear of an already-empty field is a whole extra render pass on a
      // tile-based GPU (~6 MB of writes at dpr 2.75): clear only when there
      // is something to draw or something to erase.
      if (stamps.length || this.glowDirty) rt.clear();
      this.glowDirty = stamps.length > 0;
      if (stamps.length) {
        const t = this.scene.time.now / 1000;
        const img = this.stampImg;
        rt.beginDraw();
        for (const g of stamps) {
          // Two kinds of stamp share this loop, and they play different roles
          // in "the glowing DETAIL comes alive, and THAT lights the tile":
          //   • per-cluster HALOS (no ry) sit exactly on each glowing crystal/
          //     cap/crack, each on its OWN phase — they carry the STRONG pulse
          //     (emissionSelfPulse, ~0.45..1.0) so individual details visibly
          //     breathe independently, the focus of the effect;
          //   • broad POOLS (ry set) light the whole tile + surroundings — they
          //     only GENTLY breathe (remap into ~0.8..1.0) so the emphasis
          //     stays on the detail, not the tile as a slab.
          // Colour-shift (warm/cool) rides in the tint via emissionWave.
          const isPool = g.ry !== undefined;
          const fv = emissionWave(g.anim, t, g.phase);
          const fm = (fv[0] + fv[1] + fv[2]) / 3;
          const ch = (i: number) => Math.min(255, Math.round(g.color[i] * (fv[i] / fm) * 255));
          img.setTint((ch(0) << 16) | (ch(1) << 8) | ch(2));
          const pulse = emissionSelfPulse(g.anim, t, g.phase);
          const amp = isPool ? 0.6 + 0.4 * pulse : pulse;
          img.setAlpha(Math.min(1, g.alpha * amp));
          img.setDisplaySize(g.radius * 2 * gscale, (g.ry ?? g.radius) * 2 * gscale);
          rt.batchDraw(img, (g.x - camX) * gscale, (g.y - camY) * gscale);
        }
        rt.endDraw();
      }
      // An empty field adds vec3(0): skip its dependent fetch per pixel.
      s.setUniform("uGlowOn.value", stamps.length ? 1 : 0);
      s.setUniform("uGlowFlip.value", this.glowFlip);
    } else {
      s.setUniform("uGlowOn.value", 0);
    }
    this.updGlowMs += performance.now() - tGlow0;
    s.setUniform("uFlip.value", this.fieldFlip);
    // Pattern 5 (probe-only): NORMAL lighting maths but composited opaque
    // (blend rule below keys off >= 3) — a screenshot then reads the RAW
    // light field, free of the art underneath.
    s.setUniform("uTest.value", this.testPattern === 5 ? 0 : this.testPattern);
    s.setUniform("uShadowDbg.value", this.shadowDbg);
    this.overlay?.setFlipY(this.overlayFlip);
    // Raw-readback test mode draws opaque (multiply would mix in the art).
    this.overlay?.setBlendMode(
      this.testPattern >= 3 ? Phaser.BlendModes.NORMAL : Phaser.BlendModes.MULTIPLY,
    );
    s.setUniform("uIsoA.value.x", this.iso.ox);
    // +8: the tile art's diamond top vertex sits at image row 8 (measured
    // across grass/water/sand) — the visible grid is 8 world px below the
    // geometric origin, and the light field must match the ART.
    s.setUniform("uIsoA.value.y", this.iso.oy + 8);
    s.setUniform("uIsoB.value.y", this.world.width);
    s.setUniform("uIsoB.value.z", this.world.height);
    s.setUniform("uIsoB.value.w", this.maxLevel);
    s.setUniform("uHScale.value", this.hScale);
    s.setUniform("uCloud.value", cloud);
    s.setUniform("uIndoor.value", this.indoor ? 1 : 0);
    s.setUniform("uIndoorTop.value", this.indoorTop);
    s.setUniform("uIndoorMix.value", this.indoorMix);
    // Only now is roomAt allowed to darken anything: buildShader really bound
    // the sampler on THIS shader object. Until then it fails LIT (see roomAt).
    s.setUniform("uRoomOn.value", this.roomBound ? 1 : 0);
    s.setUniform("uAurora.value", aurora);
    s.setUniform("uSun.value.x", sun[0]);
    s.setUniform("uSun.value.y", sun[1]);
    s.setUniform("uSun.value.z", sun[2]);
    s.setUniform("uSun.value.w", sun[3]);
    s.setUniform("uAmbient.value.x", ambient[0]);
    s.setUniform("uAmbient.value.y", ambient[1]);
    s.setUniform("uAmbient.value.z", ambient[2]);
    // Falls back to `ambient` itself, so a caller that never sets ambientOut
    // (or a world with no indoor spaces) behaves exactly as before.
    const ao = this.indoorMix > 0 ? this.ambientOut : ambient;
    s.setUniform("uAmbientOut.value.x", ao[0]);
    s.setUniform("uAmbientOut.value.y", ao[1]);
    s.setUniform("uAmbientOut.value.z", ao[2]);
    const n = Math.min(lights.length, MAX_SHADER_LIGHTS);
    let shadowing = 0;
    let poolCells = 0;
    for (let i = 0; i < n; i++) {
      const l = lights[i];
      if (l.radius > 0) shadowing++;
      poolCells += Math.PI * l.radius * l.radius;
      this.posArr[i * 4] = l.col;
      this.posArr[i * 4 + 1] = l.row;
      this.posArr[i * 4 + 2] = l.z;
      this.posArr[i * 4 + 3] = l.radius;
      this.colArr[i * 4] = l.color[0];
      this.colArr[i * 4 + 1] = l.color[1];
      this.colArr[i * 4 + 2] = l.color[2];
      this.colArr[i * 4 + 3] = l.flicker;
    }
    s.setUniform("uNumLights.value", n);
    this.lightStats.n = n;
    this.lightStats.shadowing = shadowing;
    this.lightStats.poolCells = Math.round(poolCells);
    this.lightStats.ambient = +(0.2126 * ambient[0] + 0.7152 * ambient[1] + 0.0722 * ambient[2]).toFixed(3);
    this.bill.frames++;
    this.bill.n += n;
    this.bill.shadowing += shadowing;
    this.bill.poolCells += poolCells;
    this.bill.nMax = Math.max(this.bill.nMax, n);
    this.bill.shadowMax = Math.max(this.bill.shadowMax, shadowing);
    this.bill.ambient = this.lightStats.ambient;
    s.setUniform("uLightPos.value", this.posArr);
    s.setUniform("uLightCol.value", this.colArr);
    s.setUniform("uEmitN.value", this.emitList.length);

    // MIST overlay — same world window/clock as the light field, its own
    // shader (NORMAL blend can't share the multiply pass). SETTING IT INVISIBLE
    // DOES NOT SKIP IT: `Shader.willRender` returns true unconditionally once
    // `setRenderToTexture` is set, so the pass runs whatever this says. What
    // makes it cheap while clear is the `uMist` guard on the first line of
    // MIST_FRAG's main, not this call.
    const showMist = mist > 0.003;
    this.mistShader?.setVisible(showMist);
    this.mistOverlay?.setVisible(showMist);
    /* uMist IS WRITTEN EVEN WHEN THE PASS IS "OFF", or it LATCHES ON.
     * `setVisible(false)` does not stop a render-to-texture Shader — Phaser's
     * willRender returns true for one unconditionally, as this file's own note
     * at the pass list says — so all three passes execute every frame no matter
     * what. The ONLY thing that makes mist cheap when it is off is the shader's
     * first line, `if (uMist <= 0.001) return`. Writing uMist only inside the
     * show branch meant that once mist had ever been on, the last value written
     * was > 0.001 and never written again: the full 128-iteration surface march
     * ran over every fragment, every frame, forever, painting into a texture
     * nobody composites. Costs nothing to write; the picture is identical
     * because the shader already returns vec4(0) for exactly these fragments. */
    this.mistShader?.setUniform("uMist.value", mist);
    if (showMist && this.mistShader) {
      const m = this.mistShader;
      m.setUniform("uAnimTime.value", this.scene.time.now / 1000);
      m.setUniform("uCam.value.x", camX);
      m.setUniform("uCam.value.y", camY);
      m.setUniform("uCam.value.z", wv.width * k);
      m.setUniform("uCam.value.w", wv.height * k);
      m.setUniform("uFlip.value", this.fieldFlip);
      m.setUniform("uIsoA.value.x", this.iso.ox);
      m.setUniform("uIsoA.value.y", this.iso.oy + 8);
      m.setUniform("uIsoB.value.y", this.world.width);
      m.setUniform("uIsoB.value.z", this.world.height);
      m.setUniform("uIsoB.value.w", this.maxLevel);
      m.setUniform("uHScale.value", this.hScale);
      m.setUniform("uMist.value", mist);
      m.setUniform("uAmbient.value.x", ambient[0]);
      m.setUniform("uAmbient.value.y", ambient[1]);
      m.setUniform("uAmbient.value.z", ambient[2]);
    }

    // ELEVATION DEPTH-FOG overlay — same world window as the light field. Only
    // drawn when the master strength is on (0 = disabled, costs nothing).
    const showFog = this.fogStrength * this.fogScale > 0.003;
    // ...and the same for the depth-fog pass, for the same reason (see uMist).
    this.depthFogShader?.setUniform("uFog.value", this.fogStrength * this.fogScale);
    this.depthFogShader?.setVisible(showFog);
    this.depthFogOverlay?.setVisible(showFog);
    if (showFog && this.depthFogShader) {
      const f = this.depthFogShader;
      f.setUniform("uCam.value.x", camX);
      f.setUniform("uCam.value.y", camY);
      f.setUniform("uCam.value.z", wv.width * k);
      f.setUniform("uCam.value.w", wv.height * k);
      f.setUniform("uFlip.value", this.fieldFlip);
      f.setUniform("uIsoA.value.x", this.iso.ox);
      f.setUniform("uIsoA.value.y", this.iso.oy + 8);
      f.setUniform("uIsoB.value.y", this.world.width);
      f.setUniform("uIsoB.value.z", this.world.height);
      f.setUniform("uIsoB.value.w", this.maxLevel);
      f.setUniform("uHScale.value", this.hScale);
      f.setUniform("uPlayerZ.value", this.curPlayerZ);
      f.setUniform("uPlayerXY.value.x", this.curPlayerXY[0]);
      f.setUniform("uPlayerXY.value.y", this.curPlayerXY[1]);
      f.setUniform("uFog.value", this.fogStrength * this.fogScale);
      f.setUniform("uAmbient.value.x", ambient[0]);
      f.setUniform("uAmbient.value.y", ambient[1]);
      f.setUniform("uAmbient.value.z", ambient[2]);
      f.setUniform("uRoomOn.value", this.fogRoomBound ? 1 : 0);
      f.setUniform("uIndoorMix.value", this.indoorMix);
    }

    /* The isolation switch is applied LAST, over whatever the passes above
     * decided, so no future visibility rule can slip past it. */
    if (this.dbgOverlays >= 1) {
      this.depthFogShader?.setVisible(false);
      this.depthFogOverlay?.setVisible(false);
    }
    if (this.dbgOverlays >= 2) {
      this.mistShader?.setVisible(false);
      this.mistOverlay?.setVisible(false);
    }
    if (this.dbgOverlays >= 3) {
      this.shader?.setVisible(false);
      this.overlay?.setVisible(false);
    }
    this.updMs += performance.now() - tUpd0;
  }

  /** EXACT JS twin of the shader's mist density at a WORLD point (probes +
   * QA) — change together with MIST_FRAG. Returns 0..1 opacity BEFORE the
   * posterize/cap (the field's raw density). */
  mistAt(wx: number, wy: number, mist = this.curMist): number {
    if (mist <= 0.001 || !this.tArr) return 0;
    // ground-plane inverse projection (level-0 cell; probes sample flats)
    const u = (wx - this.iso.ox) / this.geo.dx - 1;
    const v = (wy - (this.iso.oy + 8)) / this.geo.dy;
    const col = Math.floor((u + v) / 2);
    const row = Math.floor((v - u) / 2);
    if (col < 0 || row < 0 || col >= this.world.width || row >= this.world.height) return 0;
    const z = this.tArr[row * this.world.width + col];
    const t = this.scene.time.now / 1000;
    // Precision-exact integer hash — MUST stay identical to the shader's
    // cwHash/mHash (see the GLSL comment: the old sin-hash decorrelated
    // GPU vs CPU and the avatar tint sampled a different field).
    const hash = (x: number, y: number) => {
      const m971 = (v: number) => ((v % 971) + 971) % 971;
      let a2 = m971(x * 113 + y * 271);
      a2 = m971(a2 * a2 + 113);
      a2 = m971(a2 * a2 + x);
      a2 = m971(a2 * a2 + y);
      return a2 / 971;
    };
    const noise = (x: number, y: number) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
      return a + (b - a) * ux + (c + (d - c) * ux - (a + (b - a) * ux)) * uy;
    };
    const sstep = (e0: number, e1: number, x: number) => {
      const k2 = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return k2 * k2 * (3 - 2 * k2);
    };
    const p1x = wx * 0.0026 + t * 0.055, p1y = wy * 0.0026 + t * 0.03;
    const banks = sstep(0.30, 0.60, noise(p1x, p1y) * 0.6 + noise(p1x * 2.1 + 13, p1y * 2.1 + 13) * 0.4);
    const p2x = wx * 0.0074 - t * 0.03, p2y = wy * 0.0074 + t * 0.048;
    const roil = 0.55 + 0.45 * noise(p2x, p2y);
    const pool = Math.min(1, Math.max(0, 1 - (z - 0.4) * 0.5));
    return Math.min(1, banks * roil * 1.55) * pool * mist;
  }

  /** CPU DEPTH-FOG for a POINT already at grid (col,row) + level z — the
   * altitude-aware twin the DEPTHFOG_FRAG shader has none of. The shader spends
   * most of its length reconstructing the smooth col/row/z a screen PIXEL maps
   * to (drape + iso march); a known point (an ambient flyer) skips all of that
   * and just runs the player-relative band arithmetic. Returns the fog OPACITY
   * `a` (0..1) and its ambient-dimmed colour r,g,b (0..1) so a far/high bird
   * hazes into the fog exactly like the terrain behind it. Two deliberate
   * differences from the fragment, both because the point MOVES: the distance
   * band is NOT cel-snapped (floor()) — a flyer crossing a band edge would
   * strobe — so both channels stay smooth; and faceMix is irrelevant (a point
   * has no cliff-face compression). Everything else mirrors DEPTHFOG_FRAG and
   * MUST be kept in sync with the GLSL consts atop it. */
  /** THE FOG PASS's OWN HORIZONTAL DISTANCE for a screen point — its smooth
   *  field, not the true cell distance. DEPTHFOG_FRAG seeds the surface height
   *  at the PLAYER's level and drapes it three times through the blurred
   *  terrain (`drape`), then inverts the iso projection: a plateau 8 levels up
   *  drawn just below the player reads as NEAR ground, not as the 16 cells its
   *  cell index says (measured: pass 0.04 vs a true-distance twin's 0.48 on
   *  one tree — the maintainer's "this tree pops"). Same maths, same CPU
   *  heights (hArr − pArr bilinear = the linear heightmap's R−G), so a JS
   *  consumer at a screen point lands where the pass does. */
  screenFogDist(wx: number, wy: number): { scol: number; srow: number; distH: number } {
    const { dx, dy, lh } = this.geo;
    const u = (wx - this.iso.ox) / dx - 1;
    const v0 = (wy - (this.iso.oy + 8)) / dy;
    const kk = lh / dy;
    let sz = this.curPlayerZ;
    for (let i = 0; i < 3; i++) {
      const svi = v0 + sz * kk;
      sz = this.drapeJS((u + svi) * 0.5, (svi - u) * 0.5);
    }
    const sv = v0 + sz * kk;
    const scol = (u + sv) * 0.5;
    const srow = (sv - u) * 0.5;
    return { scol, srow, distH: Math.hypot(scol - this.curPlayerXY[0], srow - this.curPlayerXY[1]) };
  }

  /** `terrH` of the fragment: the LINEAR heightmap's (R − G), i.e. occlusion
   *  height minus the prop share, bilinear at texel centres, in levels. */
  private terrHJS(cx: number, cy: number): number {
    const w = this.world.width;
    const h = this.world.height;
    if (!this.hArr || !this.pArr) return 0;
    const x = Math.min(Math.max(cx, 0.5), w - 0.5) - 0.5;
    const y = Math.min(Math.max(cy, 0.5), h - 0.5) - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0;
    const fy = y - y0;
    const v =
      (this.terrByte(y0 * w + x0) * (1 - fx) + this.terrByte(y0 * w + x1) * fx) * (1 - fy) +
      (this.terrByte(y1 * w + x0) * (1 - fx) + this.terrByte(y1 * w + x1) * fx) * fy;
    return v / this.hScale;
  }

  /** One texel of the linear heightmap's R − G, in bytes (what the GPU holds). */
  private terrByte(i: number): number {
    const hs = this.hScale;
    return Math.round(Math.min(255, this.hArr[i] * hs)) - Math.round(Math.min(255, this.pArr[i] * hs));
  }

  /** `drape` of the fragment: the anisotropic 5-tap blur along col+row. */
  private drapeJS(cx: number, cy: number): number {
    const R = 2.5; // DRAPE_RS
    return (
      0.24 * this.terrHJS(cx, cy) +
      0.22 * this.terrHJS(cx + 0.25 * R, cy + 0.25 * R) +
      0.22 * this.terrHJS(cx - 0.25 * R, cy - 0.25 * R) +
      0.16 * this.terrHJS(cx + 0.5 * R, cy + 0.5 * R) +
      0.16 * this.terrHJS(cx - 0.5 * R, cy - 0.5 * R)
    );
  }

  /** THE FOG A STANDING THING WEARS, from its FOOT POINT on screen (world px)
   *  and the level of the tread under it: the pass's own distance field
   *  (screenFogDist) with the band CENTRED between the tread's snapped steps
   *  (distCont − ½, unsnapped) — gradual with distance, never more than half a
   *  band from the ground it stands on (maintainer 2026-09-03: "fade more
   *  gradually with distance, but as close as possible to the fog on the
   *  ground the scenery is standing on"). Used by scenery, props and bodies. */
  depthFogAtFoot(wx: number, wy: number, z: number, col: number, row: number): { a: number; r: number; g: number; b: number } {
    return this.fogFor(this.screenFogDist(wx, wy).distH - 0.5 * 1.2, z, false, col, row);
  }

  depthFogAt(col: number, row: number, z: number, snap = false): { a: number; r: number; g: number; b: number } {
    const px = this.curPlayerXY[0], py = this.curPlayerXY[1];
    return this.fogFor(Math.hypot(col - px, row - py), z, snap, col, row);
  }

  /** The fog formula proper for a horizontal distance (cells), a surface level
   *  and the cell the room test reads (the fragment's mix(1, roomAt, uIndoorMix)). */
  private fogFor(distH: number, z: number, snap: boolean, col: number, row: number): { a: number; r: number; g: number; b: number } {
    const uFog = this.fogStrength * this.fogScale;
    const NONE = { a: 0, r: 0, g: 0, b: 0 };
    if (uFog <= 0.003) return NONE;
    // MUST MATCH the GLSL consts atop DEPTHFOG_FRAG.
    const BANDS = 6, FOG_D0 = 11, FOG_DW = 1.2, FOG_MAX = 0.78, FOG_DEEP_MAX = 1.0, FOG_DEEP_RATE = 0.5;
    const ELEV_D0 = 7, ELEV_STEP = 0.5, SAME_LEVEL_FOG = 0.1, LEVEL_FADE_SPAN = 15;
    const NEAR = [0.3, 0.52, 0.5], FAR = [0.72, 0.88, 0.9];
    const pz = this.curPlayerZ;
    // `snap`: the fragment CEL-SNAPS the distance band on a flat tread
    // (faceMix 0 → floor(distCont)); a STATIC piece standing on that tread must
    // take the snapped band or it wears more fog than the ground under it
    // (measured: 0.216 vs the pass's 0.129 one band in). Bodies stay smooth —
    // a walker's band would step visibly under a snap.
    const distCont = (distH - FOG_D0) / FOG_DW + 1;
    const distBand = Math.max(0, Math.min(snap ? Math.floor(distCont) : distCont, BANDS - 1));
    // (2) HARD elevation edge — |Δlevel| from the player past the ELEV_D0 dead-zone.
    const dLev = Math.abs(pz - z);
    const elevBand = Math.max(0, dLev - ELEV_D0) * ELEV_STEP;
    const rawBand = distBand + elevBand; // unclamped: elevBand overflows the cap for deep |Δz|
    const band = Math.max(0, Math.min(rawBand, BANDS - 1));
    const bf = band / (BANDS - 1);
    const levelFade = Math.max(SAME_LEVEL_FOG, Math.min(SAME_LEVEL_FOG + (1 - SAME_LEVEL_FOG) * (dLev / LEVEL_FADE_SPAN), 1));
    const overflow = Math.max(0, rawBand - (BANDS - 1));
    const deep = overflow > 0 ? 1 - Math.exp(-overflow * FOG_DEEP_RATE) : 0;
    const density = bf * FOG_MAX * (1 - deep) + FOG_DEEP_MAX * deep;
    let a = density * uFog * levelFade;
    // THE ROOM FADE, as the fragment: outside my room the fog eases out with
    // the indoor mix (a silhouette would otherwise paint fog on a body the
    // pass paints none on — a pale teal figure in the zero-ambient dark).
    if (this.fogRoomBound && this.indoorMix > 0) {
      const hit = this.roomCells.has(Math.floor(row) * this.world.width + Math.floor(col)) ? 1 : 0;
      a *= 1 + (hit - 1) * this.indoorMix;
    }
    if (a <= 0.002) return NONE;
    // Dim the fog tone with the ambient, same floor as the fragment.
    const amb = this.curAmbient;
    const ambLum = (amb[0] + amb[1] + amb[2]) / 3;
    const dim = Math.max(0, Math.min(0.45 + 0.7 * ambLum, 1));
    return {
      a,
      r: (NEAR[0] + (FAR[0] - NEAR[0]) * bf) * dim,
      g: (NEAR[1] + (FAR[1] - NEAR[1]) * bf) * dim,
      b: (NEAR[2] + (FAR[2] - NEAR[2]) * bf) * dim,
    };
  }
}
