import Phaser from "phaser";
import { ISO_DX, ISO_DY, surfaceFor } from "@nangijala/shared";
import { World, MAP_GEOMETRY } from "./maps";

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
}

export const MAX_SHADER_LIGHTS = 12;

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
uniform vec3 uAmbient;    // night grade (what unlit white becomes)
uniform vec4 uSun;        // directional sun: cast dir (grid x,y), slope (levels/cell), strength
uniform float uCloud;     // weather: cloud cover 0..1 (world-anchored drifting shadow field)
uniform float uFlip;      // 1 = invert fragment y (GL bottom-up), 0 = direct
uniform float uTest;      // 1 = output a raw world-y gradient (calibration)
uniform float uNumLights;
uniform vec4 uLightPos[${MAX_SHADER_LIGHTS}];  // col, row, z, radius(cells)
uniform vec4 uLightCol[${MAX_SHADER_LIGHTS}];  // r, g, b, flicker
uniform sampler2D uHeight;
uniform sampler2D uHeightL; // occlusion heightmap, LINEAR-filtered (LOS march)
uniform sampler2D uEmit;    // emission palette: 2 texels/entry (colour; params)
uniform float uEmitN;       // number of palette entries (0 = no emission)
uniform sampler2D uGlow;    // world-anchored glow-halo field (same window as uCam)
uniform float uGlowOn;      // 1 when the glow field is bound (unbound sampler = unit 0!)
uniform float uGlowFlip;    // render-target y orientation (calibrated numerically)

// Bilinear height for the LOS march ONLY: blockers ramp in over ~a cell, so
// cast-shadow edges get a natural penumbra instead of cell-quantized 1px
// cliffs. The surface resolve keeps exact nearest-cell reads (uHeight).
float heightAtSoft(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 99.0;
  return texture2D(uHeightL, cr / vec2(uIsoB.y, uIsoB.z)).r * 255.0 / 16.0;
}

float heightAt(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 99.0;
  vec2 uv = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  return texture2D(uHeight, uv).r * 255.0 / 16.0;
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
float cwHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cwNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cwHash(i), cwHash(i + vec2(1.0, 0.0)), u.x),
             mix(cwHash(i + vec2(0.0, 1.0)), cwHash(i + vec2(1.0, 1.0)), u.x), u.y);
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
  for (int s = 0; s < 36; s++) {
    if (found || vHi <= v0 - 1.5) continue;
    float vColB = 2.0 * floor((vHi + u) * 0.5 - 0.0001) - u;
    float vRowB = 2.0 * floor((vHi - u) * 0.5 - 0.0001) + u;
    float vLo = max(vColB, vRowB);
    float vMid = (vHi + vLo) * 0.5;
    vec2 cr = vec2((u + vMid) * 0.5, (vMid - u) * 0.5);
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
    // Off-map / unresolved: plain ambient.
    gl_FragColor = vec4(uAmbient, 1.0);
    return;
  }

  float Ha = heightAt(cell);
  if (uTest > 3.5) {
    // Calibration 4: final surface classification — wall-face pixels RED,
    // top pixels GREEN (probed numerically by the verify scripts).
    float isFace = (Ha < 90.0 && Ha - z > 0.05) ? 1.0 : 0.0;
    gl_FragColor = vec4(isFace, 1.0 - isFace, 0.0, 1.0);
    return;
  }

  // Face geometry, light-independent — hoisted out of the light loop.
  // The face's attenuation anchor is its EXACT point on the wall plane
  // (0.99 keeps floor() in the owning cell): the old per-cell centroid made
  // brightness jump at every face/ground boundary (knife edges at wall bases).
  bool isFace = (Ha < 90.0 && Ha - z > 0.05);
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
    if (hFront < 90.0) {
      float dAbove = max((z - hFront) * uIsoB.x, 0.0);
      ao = mix(0.75, 1.0, smoothstep(0.0, 5.0, dAbove));
    }
  } else {
    vec2 bg = floor(cell);
    float vColLo = 2.0 * bg.x - u;
    float vRowLo = 2.0 * bg.y + u;
    // Neighbour across the pixel's up-screen cell boundary (terrain heights
    // only — solid objects are art, they don't create corner seams).
    float hb = (vColLo >= vRowLo) ? heightAt(bg + vec2(-0.5, 0.5)) : heightAt(bg + vec2(0.5, -0.5));
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
  float sunF = 1.0;
  if (uSun.w > 0.001) {
    float sunVis = 1.0;
    for (int s = 1; s <= 20; s++) {
      float dc = float(s) * 0.6;
      vec2 p = pos - uSun.xy * dc;
      if (floor(p.x) == floor(pos.x) && floor(p.y) == floor(pos.y)) continue;
      float hRay = z + dc * uSun.z + 0.15;
      float H = heightAtSoft(p);
      if (H < 90.0 && H > hRay) sunVis *= mix(0.80, 0.35, clamp((H - hRay) * 1.2, 0.0, 1.0));
    }
    if (isFace) {
      vec2 nrm = mix(vec2(0.0, 1.0), vec2(1.0, 0.0), pickR);
      float cosS = dot(nrm, -uSun.xy);
      sunVis *= clamp(cosS * 1.4 + 0.55, 0.3, 1.0);
    }
    float sunShare = 0.45 * uSun.w; // the sun's slice of the phase ambient
    sunF = (1.0 - sunShare) + sunShare * clamp(sunVis, 0.0, 1.0);
  }
  // Cloud shadows ride between the sun and the ground: world-anchored blobs
  // drifting on the wind, shading the ambient like the sun march does. The
  // depth scales with the sun's strength — thick clouds at night barely
  // register (no sun to block), at noon they stamp clear moving shade.
  float cloudF = 1.0;
  if (uCloud > 0.001) {
    vec2 cp = vec2(wx, wy) * 0.0042 + uAnimTime * vec2(0.030, 0.017);
    float n = cwNoise(cp) * 0.65 + cwNoise(cp * 2.3 + 17.0) * 0.35;
    float cover = smoothstep(0.52, 0.78, n);
    cloudF = 1.0 - cover * 0.32 * uCloud * mix(0.25, 1.0, uSun.w);
  }
  vec3 light = uAmbient * sunF * cloudF;
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
    if (uLightPos[i].w > 0.0 && (z < lp.z + 0.05 || objAt(cell) > 0.5)) {
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
        float hRay = mix(z, lp.z, t) + 0.2;
        float H = heightAtSoft(p);
        if (H < 90.0 && H > hRay) occ *= mix(0.8, 0.45, clamp((H - hRay) * 1.5, 0.0, 1.0));
      }
      // Bounce floor: firelight scatters — shadowed ground near a light keeps
      // a faint glow instead of dropping to pitch ambient. Faces still gate
      // to dark below (the Lambert gate multiplies AFTER this floor).
      occ = max(occ, 0.22);
    }

    // Side-face pixels (below their column's top): a column shows TWO faces —
    // left of its front corner faces +row, right of it faces +col. Each face
    // only catches light that stands beyond ITS OWN plane (in cells), so a
    // torch on the right lights the right face but never wraps onto the
    // left one, and a torch on top (behind both planes) lights neither.
    if (isFace) {
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

  // Self-emission floor (tiles/emission.json): a glowing tile's OWN pixels
  // never drop below colour*self — lava stays molten, crystals stay lit.
  // max() makes it a FLOOR, not an add: daylight (ambient 1.0) swallows it,
  // night reveals it, and the art's own contrast survives the multiply.
  // Per-cell hash phase so a lava lake shimmers instead of blinking in sync.
  float emSelf = 1.0; // tile self-pulse (1.0 for non-emitters — a no-op)
  float eIdx = emitAt(cell) - 1.0;
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
    light = max(light, eCol * ePar.g * fv * eBoost);
  }

  // Per-source glow halos (tile-emission@2 sources): a world-anchored field
  // stamped each frame with one radial halo per visible glowing pixel
  // cluster. ADDED after floor/AO — emission is not subject to corner
  // occlusion, and adding (not max) lets halos ride on top of pools/floors.
  // The field shares uCam's window exactly (1 world px = 1 texel).
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

  gl_FragColor = vec4(min(light, vec3(1.25)), 1.0);
}
`;

const FIELD_KEY = "night-light-field";

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
  const { dx, dy, lh } = MAP_GEOMETRY;
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
  private maxLevel: number;
  private base?: Phaser.Display.BaseShader;
  private shader?: Phaser.GameObjects.Shader;
  private overlay?: Phaser.GameObjects.Image;
  private posArr = new Float32Array(MAX_SHADER_LIGHTS * 4);
  private colArr = new Float32Array(MAX_SHADER_LIGHTS * 4);
  private fieldCount = 0;
  private hArr!: Float32Array; // CPU occlusion heights (terrain + solid objects)
  private tArr!: Float32Array; // CPU terrain-only heights (walls/AO seams)
  private oArr!: Uint8Array;   // CPU solid-object flags
  private curLights: ShaderLight[] = [];
  private curStamps: GlowStamp[] = [];
  private curAmbient: [number, number, number] = [0.075, 0.09, 0.14];
  private emission: EmissionMap;
  private emitList: EmissionEntry[] = []; // palette order (index = shader eIdx)
  // Glow-halo field: world-anchored RT sharing the shader's exact window.
  private glowRT?: Phaser.GameObjects.RenderTexture;
  private glowKey = "";
  private stampImg?: Phaser.GameObjects.Image;
  // Measured (off-centre stamp probe): this stack's RT samples straight, no
  // y-flip — same family of ground truth as fieldFlip above.
  glowFlip = 0;
  active = false;
  // Live calibration (debug keys): rendering-path differences between GPUs
  // showed up as flipped/scaled fields that headless verification could not
  // reproduce — let the tester find the correct combo on THEIR machine.
  fieldFlip = 0; // gradient ground-truth: this stack needs NO y-inversion
  overlayFlip = false; // additionally mirror the composited image
  spanScale = 1; // field world-span multiplier around the view centre
  testPattern = 0; // 1 = world-y gradient, 2 = cell grid vs art tiles

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
    this.maxLevel = maxLevel;
    this.emission = emission;
  }

  create() {
    this.buildHeightmap();
    this.base = new Phaser.Display.BaseShader("night-lights", FRAG, undefined, {
      uCam: { type: "4f", value: { x: 0, y: 0, z: 1, w: 1 } },
      uIsoA: { type: "4f", value: { x: 0, y: 0, z: ISO_DX, w: ISO_DY } },
      uIsoB: { type: "4f", value: { x: MAP_GEOMETRY.lh, y: 1, z: 1, w: 0 } },
      uAmbient: { type: "3f", value: { x: 0.16, y: 0.2, z: 0.36 } },
      // Directional sun (cast dir, slope, strength). DECLARED here on
      // purpose: a uniform that is setUniform()'d but missing from this
      // config gets no GL setter — some pipelines still sync it (headless
      // swiftshader did, which made the harness screenshots lie), real
      // phone GPUs leave it at vec4(0) = sun permanently off (playtest:
      // "0 effect"). The inverse twin of the uAnimTime bug below.
      uSun: { type: "4f", value: { x: 0, y: 0, z: 1, w: 0 } },
      uCloud: { type: "1f", value: 0 },
      uFlip: { type: "1f", value: 1 },
      uTest: { type: "1f", value: 0 },
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
      uHeight: { type: "sampler2D", value: null },
      uHeightL: { type: "sampler2D", value: null },
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
    this.buildShader(this.scene.scale.width, this.scene.scale.height);
    // The render target does NOT follow setSize — a resized window left a
    // stale wrong-scale light field (bright rectangles, pools that ignore
    // zoom). Rebuild the shader + target at the new size instead.
    this.scene.scale.on("resize", (sz: Phaser.Structs.Size) => {
      this.buildShader(sz.width, sz.height);
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

  /** (Re)create the shader + its render target at the given size. */
  private buildShader(width: number, height: number) {
    if (!this.base || width <= 0 || height <= 0) return;
    this.shader?.destroy();
    // A fresh texture key per size: destroying a shader doesn't unregister
    // its render target, and re-binding an existing key throws.
    const key = `${FIELD_KEY}-${this.fieldCount++}`;
    const s = this.scene.add
      .shader(this.base, 0, 0, width, height)
      .setOrigin(0, 0)
      .setVisible(this.active);
    s.setSampler2D("uHeight", "world-heightmap");
    if (this.scene.textures.exists("world-heightmap-linear"))
      s.setSampler2D("uHeightL", "world-heightmap-linear", 1);
    if (this.scene.textures.exists("emission-palette"))
      s.setSampler2D("uEmit", "emission-palette", 2);
    // Glow field RT: the shader's world window is ALWAYS screen-sized in
    // world px (view * zoom = screen), so 1 RT texel = 1 world px.
    this.glowRT?.destroy();
    if (this.glowKey && this.scene.textures.exists(this.glowKey)) this.scene.textures.remove(this.glowKey);
    this.glowRT = this.scene.make.renderTexture({ width, height }, false);
    this.glowKey = `night-glow-${this.fieldCount}`;
    this.glowRT.saveTexture(this.glowKey);
    s.setSampler2D("uGlow", this.glowKey, 3);
    s.setRenderToTexture(key);
    this.shader = s;
    const old = this.overlay!.texture.key;
    this.overlay!
      .setTexture(key)
      .setPosition(width / 2, height / 2)
      .setScale(1);
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
   * plausible blob. */
  private buildHeightmap() {
    if (this.scene.textures.exists("world-heightmap")) return;
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
    this.hArr = new Float32Array(w * h);
    this.tArr = new Float32Array(w * h);
    this.oArr = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = (r * w + c) * 4;
        const cell = this.world.rows[r][c];
        const s = surfaceFor(cell.t);
        const solid = !s.standable && !s.swimmable;
        // CPU twin marches LOS only → occlusion heights (with the solid +1).
        this.hArr[r * w + c] = cell.l + (solid ? 1 : 0);
        this.tArr[r * w + c] = cell.l;
        this.oArr[r * w + c] = solid ? 1 : 0;
        img.data[i] = Math.min(255, cell.l * 16);
        imgL.data[i] = Math.min(255, (cell.l + (solid ? 1 : 0)) * 16);
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
        imgL.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    tex!.refresh();
    const texL = this.scene.textures.createCanvas("world-heightmap-linear", w, h);
    if (texL) {
      texL.getContext().putImageData(imgL, 0, 0);
      texL.refresh();
      texL.setFilter(Phaser.Textures.FilterMode.LINEAR);
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

  /** CPU twin of the shader's lighting for a surface at (col,row,z): used to
   * tint STANDING objects (characters, wall columns, props) so they carry the
   * light of their own cell — the screen-space field only shades the flat
   * ground. Same ambient/attenuation/LOS/ember/flicker, same clock. */
  private curSun: [number, number, number, number] = [0, 0, 1, 0];
  private curCloud = 0;

  /** EXACT JS twin of the shader's cloud field (see cwNoise) — tints the
   * lit copies so characters dim as a cloud passes over them. */
  cloudFactorAt(wx: number, wy: number, cloud = this.curCloud, sunW = this.curSun[3]): number {
    if (cloud <= 0.001) return 1;
    const hash = (x: number, y: number) => {
      const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return v - Math.floor(v);
    };
    const noise = (x: number, y: number) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
      return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
    };
    const t = this.scene.time.now / 1000; // same clock as uAnimTime
    const cx = wx * 0.0042 + t * 0.03;
    const cy = wy * 0.0042 + t * 0.017;
    const n = noise(cx, cy) * 0.65 + noise(cx * 2.3 + 17, cy * 2.3 + 17) * 0.35;
    const ss = Math.min(1, Math.max(0, (n - 0.52) / 0.26));
    const cover = ss * ss * (3 - 2 * ss);
    return 1 - cover * 0.32 * cloud * (0.25 + 0.75 * sunW);
  }

  /** CPU twin of the shader's directional-sun shade for a surface (1 = fully
   * lit, ~0.62 = deepest shade). Drives lit-copy tints and the headless
   * verify probe. */
  sunFactorAt(col: number, row: number, z: number, sun: [number, number, number, number] = this.curSun): number {
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
    const hAtSoft = (c: number, r: number) => {
      const cf = c - 0.5, rf = r - 0.5;
      const c0 = Math.floor(cf), r0 = Math.floor(rf);
      const fx = cf - c0, fy = rf - r0;
      const v = (ci: number, ri: number) =>
        ci < 0 || ri < 0 || ci >= W || ri >= H ? 99 : this.hArr[ri * W + ci];
      const a = v(c0, r0), b = v(c0 + 1, r0), d = v(c0, r0 + 1), e = v(c0 + 1, r0 + 1);
      if (a > 90 || b > 90 || d > 90 || e > 90) return hAt(c, r);
      return (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
    };
    let sunVis = 1;
    for (let sN = 1; sN <= 20; sN++) {
      const dc = sN * 0.6;
      const px = col - sun[0] * dc;
      const py = row - sun[1] * dc;
      if (Math.floor(px) === Math.floor(col) && Math.floor(py) === Math.floor(row)) continue;
      const hRay = z + dc * sun[2] + 0.15;
      const hh = hAtSoft(px, py);
      if (hh < 90 && hh > hRay) sunVis *= 0.8 + (0.35 - 0.8) * Math.min(1, (hh - hRay) * 1.2);
    }
    const sunShare = 0.45 * sun[3];
    return 1 - sunShare + sunShare * Math.max(0, Math.min(1, sunVis));
  }

  lightAt(col: number, row: number, z: number, isObj: boolean): [number, number, number] {
    const W = this.world.width;
    const H = this.world.height;
    const hAt = (c: number, r: number) => {
      const ci = Math.floor(c), ri = Math.floor(r);
      return ci < 0 || ri < 0 || ci >= W || ri >= H ? 99 : this.hArr[ri * W + ci];
    };
    // Bilinear twin of the shader's heightAtSoft (LOS penumbra).
    const hAtSoft = (c: number, r: number) => {
      const cf = c - 0.5, rf = r - 0.5;
      const c0 = Math.floor(cf), r0 = Math.floor(rf);
      const fx = cf - c0, fy = rf - r0;
      const v = (ci: number, ri: number) =>
        ci < 0 || ri < 0 || ci >= W || ri >= H ? 99 : this.hArr[ri * W + ci];
      const a = v(c0, r0), b = v(c0 + 1, r0), d = v(c0, r0 + 1), e = v(c0 + 1, r0 + 1);
      if (a > 90 || b > 90 || d > 90 || e > 90) return hAt(c, r);
      return (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
    };
    const t = this.scene.game.loop.getDuration();
    // Directional-sun + cloud twins (see the shader): shade the ambient term.
    const geo = MAP_GEOMETRY;
    const wxT = this.iso.ox + (col - row) * geo.dx + geo.dx;
    const wyT = this.iso.oy + (col + row) * geo.dy + geo.dy - z * geo.lh;
    const sunF = this.sunFactorAt(col, row, z) * this.cloudFactorAt(wxT, wyT);
    const out: [number, number, number] = [
      this.curAmbient[0] * sunF,
      this.curAmbient[1] * sunF,
      this.curAmbient[2] * sunF,
    ];
    for (let i = 0; i < this.curLights.length && i < MAX_SHADER_LIGHTS; i++) {
      const L = this.curLights[i];
      const dx = L.col - col;
      const dy = L.row - row;
      const radius = Math.abs(L.radius); // negative = shadow-free glow pool
      const dist = Math.sqrt(dx * dx + dy * dy + Math.pow((L.z - z) * 0.6, 2));
      let att = Math.max(0, 1 - dist / radius);
      att *= att;
      if (att <= 0.001) continue;
      let occ = 1;
      if (L.radius > 0 && (z < L.z + 0.05 || isObj)) {
        for (let sN = 1; sN <= 12; sN++) {
          const tt = sN / 13;
          const px = col + dx * tt;
          const py = row + dy * tt;
          if (Math.floor(px) === Math.floor(col) && Math.floor(py) === Math.floor(row)) continue;
          if ((px - col) * (px - col) + (py - row) * (py - row) < 0.56) continue; // near-field
          const hRay = z + (L.z - z) * tt + 0.2;
          const hh = hAtSoft(px, py);
          if (hh < 90 && hh > hRay) occ *= 0.8 + (0.45 - 0.8) * Math.min(1, (hh - hRay) * 1.5);
        }
        occ = Math.max(occ, 0.22); // bounce floor — same as the shader
      }
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
    {
      const W2 = this.world.width;
      const H2 = this.world.height;
      const tAt = (ci: number, ri: number) =>
        ci < 0 || ri < 0 || ci >= W2 || ri >= H2 ? 99 : this.tArr[ri * W2 + ci];
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
      }
    }
    // Glow-halo twin (added after AO, like the shader): a character standing
    // in a mushroom/crystal halo must carry its glow — the field lights the
    // ground but the lit copy is tinted by THIS function only.
    if (this.curStamps.length) {
      const { dx, dy, lh } = MAP_GEOMETRY;
      const wx = this.iso.ox + (col - row) * dx + dx;
      const wy = this.iso.oy + (col + row) * dy + dy - z * lh;
      for (const g of this.curStamps) {
        if (g.litChar === false) continue; // high prop halos don't tint bodies
        const d = Math.hypot(g.x - wx, g.y - wy) / g.radius;
        if (d >= 1) continue;
        const f = (1 - d) * (1 - d); // ≈ the stamp texture's falloff
        for (let ch = 0; ch < 3; ch++) out[ch] += g.color[ch] * g.alpha * f;
      }
    }
    return out;
  }

  /** lightAt packed as a Phaser tint (multiplier clamped to 1). */
  tintAt(col: number, row: number, z: number, isObj: boolean): number {
    const l = this.lightAt(col, row, z, isObj);
    const r = Math.min(255, Math.round(Math.min(1, l[0]) * 255));
    const g = Math.min(255, Math.round(Math.min(1, l[1]) * 255));
    const b = Math.min(255, Math.round(Math.min(1, l[2]) * 255));
    return (r << 16) | (g << 8) | b;
  }

  setActive(on: boolean) {
    this.active = on;
    this.shader?.setVisible(on);
    this.overlay?.setVisible(on);
  }

  /** Headless-debug: real dimensions of the render target vs the screen. */
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

  update(
    cam: Phaser.Cameras.Scene2D.Camera,
    lights: ShaderLight[],
    ambient: [number, number, number],
    stamps: GlowStamp[] = [],
    sun: [number, number, number, number] = [0, 0, 1, 0],
    cloud = 0,
  ) {
    this.curLights = lights;
    this.curStamps = stamps;
    this.curAmbient = ambient;
    this.curSun = sun;
    this.curCloud = cloud;
    if (!this.shader || !this.active) return;
    const s = this.shader;
    // Ground-truth calibrated by raw suv readback: the zoomed overlay shows
    // the CENTRED 1/zoom portion of the fragment range (measured: screen ↔
    // suv [0.25, 0.75] at zoom 2, window-size independent). The world window
    // is therefore the camera view inflated by zoom AROUND ITS CENTRE.
    const k = this.spanScale * (cam.zoom || 1);
    const wv = cam.worldView;
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
    if (this.glowRT && this.stampImg) {
      const rt = this.glowRT;
      rt.clear();
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
          img.setDisplaySize(g.radius * 2, (g.ry ?? g.radius) * 2);
          rt.batchDraw(img, g.x - camX, g.y - camY);
        }
        rt.endDraw();
      }
      s.setUniform("uGlowOn.value", 1);
      s.setUniform("uGlowFlip.value", this.glowFlip);
    } else {
      s.setUniform("uGlowOn.value", 0);
    }
    s.setUniform("uFlip.value", this.fieldFlip);
    // Pattern 5 (probe-only): NORMAL lighting maths but composited opaque
    // (blend rule below keys off >= 3) — a screenshot then reads the RAW
    // light field, free of the art underneath.
    s.setUniform("uTest.value", this.testPattern === 5 ? 0 : this.testPattern);
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
    s.setUniform("uCloud.value", cloud);
    s.setUniform("uSun.value.x", sun[0]);
    s.setUniform("uSun.value.y", sun[1]);
    s.setUniform("uSun.value.z", sun[2]);
    s.setUniform("uSun.value.w", sun[3]);
    s.setUniform("uAmbient.value.x", ambient[0]);
    s.setUniform("uAmbient.value.y", ambient[1]);
    s.setUniform("uAmbient.value.z", ambient[2]);
    const n = Math.min(lights.length, MAX_SHADER_LIGHTS);
    for (let i = 0; i < n; i++) {
      const l = lights[i];
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
    s.setUniform("uLightPos.value", this.posArr);
    s.setUniform("uLightCol.value", this.colArr);
    s.setUniform("uEmitN.value", this.emitList.length);
  }
}
