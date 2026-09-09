/* THE SCENERY-LIT PIPELINE — per-pixel lighting of a scenery piece's LIT COPY
 * (WorldScene.rebuildScenery attaches it; applyObjectLights feeds it).
 *
 * The copy is a Phaser Image above the multiply overlay that took ONE flat
 * tint from the CPU light twin at its foot, so a tree was one colour whichever
 * side the torch stood on. This pipeline keeps that flat tint for the AMBIENT
 * side — sky/sun/AO/glow stamps, everything the twin computes except the
 * point lights, so a piece in a cave or outside my room stays as dark as the
 * ground under it — and adds the POINT LIGHTS PER TEXEL against the volume the
 * shape map describes (scenerylight.ts: the hitbox for the base, the alpha
 * silhouette for the crown):
 *
 *   - the lights are the night shader's OWN uniform arrays (col,row,z,±radius
 *     / r,g,b,flicker), the same attenuation and ember terms, and the SAME
 *     flicker value — computed once per light per frame on the CPU from the
 *     same clock and folded into the colour (two sin() per texel per light
 *     saved; the product is identical);
 *   - ATTENUATION is per texel with the volume's depth and height, height
 *     weighted SHAPE_ZW_ATT (0.15) — the ground's 0.6 put every crown past
 *     the torch's radius (measured: whole trees at 22% of the flat tint);
 *   - the LAMBERT DIRECTION is the HORIZONTAL vector from the piece's AXIS
 *     (hitbox centre) to the light, one direction per piece per light, so a
 *     torch on the right lights the right side all the way up. Not per texel:
 *     with the torch under the crown (the usual case — a crown is 3 cells
 *     wide, the player stands beside the trunk) a per-texel direction
 *     degenerates (adjacent-row jumps of 1.4× measured) and any vertical
 *     weight puts the torch straight below the crown's front (dot ≈ 0 — the
 *     crown could never be lit). Height is the attenuation's job;
 *   - a wrapped Lambert (`wrap` 0.75) keeps the far side at wrap × the light
 *     and `gain` 1.25 restores the whole-tree mean (measured headless on the
 *     real trees: torch at the side 0.75×, in front 1.25×, behind 0.4× the
 *     flat copy; the near third ≥ 2.1× the far third from every side);
 *   - each light's LOS occlusion at the axis is the twin's (one 12-sample
 *     march per light per piece per frame — what the flat tint already paid),
 *     carried per vertex for ALL 12 slots (the ledger reshuffles slots as
 *     lights come and go; a slot left at 1 lit a copy through a cliff);
 *     glow pools (negative radius) have no direction;
 *   - by day the foot tint's SUN SHARE is re-weighted by a soft Lambert
 *     against the full 3D normal and an ELEVATED sun (the cast slope lifted
 *     to sin ≈ 1.2·slope: 33° at noon — the ground's own face gate would leave
 *     every tree front at 0.3 at noon, as it does cliff faces), softened by
 *     `sunLam`; nothing is ever brighter than the flat tint by day.
 *
 * PER-PIECE DATA RIDES VERTEX ATTRIBUTES, flat across the quad, never
 * uniforms: a uniform per sprite forces a flush per sprite. Seven attributes,
 * seven vec4 varyings (WebGL1 guarantees eight of each). The lights and the
 * foot are uploaded RELATIVE to an integer origin (`org`, the player's cell)
 * so a mediump phone GPU keeps sub-cell accuracy at cell 450. The shape map
 * rides texture unit 1 beside the art on unit 0 — every scenery sprite is
 * its own texture anyway, so a batch entry per (art, shape) pair costs
 * nothing the default pipeline was not already paying; the fog silhouettes
 * take the same pipeline with no shape (tintEffect 1 — Multi.frag's exact
 * path) so the lit band does not ping-pong between pipelines (measured +12.8
 * flushes/frame for 11 copies when it did). Fully transparent texels return
 * before the light loop — exact, the colour is 0 there on every path.
 *
 * With `shade` 0 the fragment is Multi.frag's own maths — the parity switch.
 */
import Phaser from "phaser";
import { MAX_SHADER_LIGHTS } from "./nightlight";
import { SHAPE_DEPTH_CELLS, SHAPE_ZW_ATT } from "./scenerylight";

export const SCENERY_LIT_PIPELINE = "scenery-lit";
/** Per-light occlusion slots carried per vertex — every ledger slot. */
export const SCENERY_LIT_OCC = MAX_SHADER_LIGHTS;

/** Per-piece VOLUME + per-frame LIGHT TERMS the pipeline reads off the lit
 *  copy's `pipelineData` (by reference — mutated each frame, never copied). */
export interface SceneryLitShape {
  /** The shape map's GL texture; undefined while it is still being built
   *  (the copy then draws exactly as the flat tint would). */
  tex?: Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper;
  /** Hitbox centre on screen (world px) — the line the volume stands on. */
  hbX: number;
  hbY: number;
  /** Hitbox centre in cells (fractional) and the tread's level. */
  fc: number;
  fr: number;
  fz: number;
  /** −1 when the art is drawn mirrored (N.x negated), else +1. */
  flip: number;
  /** Per-light LOS occlusion at the axis × the ground AO twin (this frame). */
  occ: Float32Array;
  /** The sun's lit share at the foot: sunF − (1 − 0.45·w) (this frame). */
  sv: number;
}

export interface SceneryLitFrame {
  pos: Float32Array;
  col: Float32Array;
  n: number;
  sun: [number, number, number, number];
  time: number;
  /** Integer origin (cells) the lights and feet are uploaded relative to. */
  orgX: number;
  orgY: number;
}

const SQ2 = Math.SQRT2;

const VERT = `#define SHADER_NAME SCENERY_LIT_VS
precision highp float;
uniform mat4 uProjectionMatrix;
attribute vec4 inPosUv;  // x, y, u, v
attribute vec4 inTint;
attribute vec4 inMisc;   // tintEffect, flip (0 = unshaped), sv, tread z
attribute vec4 inLocal;  // X (cells, +screen right), Z (levels above the hitbox line), hitbox col − org, row − org
attribute vec4 inOccA;   // per-light LOS occlusion × AO at the axis, lights 0..3
attribute vec4 inOccB;   // lights 4..7
attribute vec4 inOccC;   // lights 8..11
varying vec2 vUv;
varying vec4 vTint;
varying vec4 vMisc;
varying vec4 vLocal;
varying vec4 vOccA;
varying vec4 vOccB;
varying vec4 vOccC;
void main () {
  gl_Position = uProjectionMatrix * vec4(inPosUv.xy, 1.0, 1.0);
  vUv = inPosUv.zw;
  vTint = inTint;
  vMisc = inMisc;
  vLocal = inLocal;
  vOccA = inOccA;
  vOccB = inOccB;
  vOccC = inOccC;
}`;

const FRAG = `#define SHADER_NAME SCENERY_LIT_FS
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uMainSampler;
uniform sampler2D uShapeSampler;
uniform float uOn;      // 0 = Multi.frag's own maths exactly (flat tint); 1 = volume lighting
uniform float uDebug;   // 1 = show the normal, 2 = the lit factor alone, 3 = the depth channel
uniform float uWrap;    // Lambert wrap floor: 0 = hard terminator, 1 = no direction at all
uniform float uSunLam;  // how much of the sun's Lambert applies (0 = flat)
uniform float uGain;    // point-light gain on the volume (a wrapped Lambert averages below 1)
uniform float uNumLights;
uniform vec4 uLightPos[${MAX_SHADER_LIGHTS}]; // col − org, row − org, z, ±radius — the night shader's own array, re-based
uniform vec4 uLightCol[${MAX_SHADER_LIGHTS}]; // r·flick, g·flick, b·flick, flicker amount
uniform vec4 uSun;      // cast dir (grid x,y), slope (levels/cell), strength
varying vec2 vUv;
varying vec4 vTint;
varying vec4 vMisc;
varying vec4 vLocal;
varying vec4 vOccA;
varying vec4 vOccB;
varying vec4 vOccC;
const float SQ2I = 0.70710678;
const float ZWA = ${SHAPE_ZW_ATT.toFixed(3)};
const float DEPTH = ${SHAPE_DEPTH_CELLS.toFixed(1)};

float occAt(int i) {
  if (i < 4) return i == 0 ? vOccA.x : i == 1 ? vOccA.y : i == 2 ? vOccA.z : vOccA.w;
  if (i < 8) return i == 4 ? vOccB.x : i == 5 ? vOccB.y : i == 6 ? vOccB.z : vOccB.w;
  return i == 8 ? vOccC.x : i == 9 ? vOccC.y : i == 10 ? vOccC.z : vOccC.w;
}

void main () {
  vec4 texture = texture2D(uMainSampler, vUv);
  float eff = vMisc.x;
  if (texture.a <= 0.0 && eff != 2.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec4 texel = vec4(vTint.bgr * vTint.a, vTint.a);
  vec4 color = texture * texel;
  if (eff == 1.0) color.rgb = mix(texture.rgb, vTint.bgr * vTint.a, texture.a);
  else if (eff == 2.0) color = texel;
  float flip = vMisc.y;
  if (uOn > 0.5 && eff == 0.0 && abs(flip) > 0.5) {
    vec4 sm = texture2D(uShapeSampler, vUv);
    float nx = (sm.r * 2.0 - 1.0) * flip;
    float nz = sm.g * 2.0 - 1.0;
    float ny = sqrt(max(0.0, 1.0 - nx * nx - nz * nz));
    vec3 N = vec3(nx, ny, nz);
    // The surface point in the ground frame (X: screen right, Y: toward the
    // viewer, Z: up) relative to the hitbox centre; cells, cells, levels.
    vec3 P = vec3(vLocal.x, sm.b * DEPTH, vLocal.y);
    vec2 fXY = vec2(vLocal.z - vLocal.w, vLocal.z + vLocal.w) * SQ2I;
    float fz = vMisc.w;
    vec3 light = vec3(0.0);
    for (int i = 0; i < ${MAX_SHADER_LIGHTS}; i++) {
      if (float(i) >= uNumLights) break;
      vec4 lp = uLightPos[i];
      float radius = abs(lp.w);
      vec2 aXY = vec2(lp.x - lp.y, lp.x + lp.y) * SQ2I - fXY; // the light from the piece's axis
      vec3 d = vec3(aXY - P.xy, (lp.z - fz - P.z) * ZWA);
      float dist = length(d);
      float att = clamp(1.0 - dist / radius, 0.0, 1.0);
      att *= att;
      if (att <= 0.001) continue;
      // Wrapped Lambert against the volume, from the axis' horizontal
      // direction to the light. GLOW POOLS (negative radius) are ambience
      // with no direction — the ground's own exemption.
      float lam = 1.0;
      if (lp.w > 0.0) lam = clamp((dot(N.xy, aXY) / max(length(aXY), 0.25)) * (1.0 - uWrap) + uWrap, 0.0, 1.0);
      vec3 lc = uLightCol[i].rgb;
      float fl = uLightCol[i].w;
      vec3 ember = lc * vec3(0.95, 0.30, 0.12);
      float d01 = clamp(dist / radius, 0.0, 1.0);
      vec3 col = mix(lc, ember, smoothstep(0.35, 0.95, d01) * clamp(fl * 1.2, 0.0, 1.0));
      light += col * att * occAt(i) * lam;
    }
    light *= uGain;
    // SUN: the flat tint carries the foot's sunF = (1-s) + s*vis; re-weight
    // its sun share by a soft Lambert against the volume normal and an
    // elevated sun, softened by uSunLam. Never brighter than the flat tint.
    vec3 base = vTint.bgr;
    if (uSun.w > 0.001) {
      float s = 0.45 * uSun.w;
      vec2 sXY = vec2(uSun.x - uSun.y, uSun.x + uSun.y) * SQ2I;
      float el = clamp(uSun.z * 1.2, 0.2, 0.8);
      vec3 toSun = normalize(vec3(-sXY * sqrt(1.0 - el * el), el));
      float lamS = clamp(0.8 + 0.35 * dot(N, toSun), 0.35, 1.0);
      lamS = mix(1.0, lamS, uSunLam);
      float sv = vMisc.z;
      base *= ((1.0 - s) + sv * lamS) / max((1.0 - s) + sv, 0.001);
    }
    vec3 lit = min(base + light, vec3(1.0));
    color = texture * vec4(lit * vTint.a, vTint.a);
    if (uDebug > 0.5) {
      vec3 dbg = N * 0.5 + 0.5;
      if (uDebug > 1.5) dbg = lit;
      if (uDebug > 2.5) dbg = vec3(sm.b, sm.b, sm.b);
      color = vec4(dbg * texture.a, texture.a);
    }
  }
  gl_FragColor = color;
}`;

type Img = Phaser.GameObjects.Image;
type TexWrap = Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper;

// Scratch for one quad's six vertices (no per-call allocation).
const QX = new Float32Array(6);
const QY = new Float32Array(6);
const QU = new Float32Array(6);
const QV = new Float32Array(6);
const QT = new Uint32Array(6);

export class SceneryLitPipeline extends Phaser.Renderer.WebGL.Pipelines.MultiPipeline {
  /** Where the frame's lights come from — WorldScene wires `night.lightUniforms`. */
  source: (() => SceneryLitFrame | null) | null = null;
  shade = 1;
  debug = 0;
  /** Lambert wrap — see the header. */
  wrap = 0.75;
  /** The sun's Lambert share. */
  sunLam = 0.6;
  /** Point-light gain on the volume. */
  gain = 1.25;
  /** Iso constants of the world being drawn (maps3: dx 32, lh 15). */
  dx = 32;
  lh = 15;
  private cam: Phaser.Cameras.Scene2D.Camera | null = null;
  private lastUpload = -1;
  private orgX = 0;
  private orgY = 0;
  private relPos = new Float32Array(MAX_SHADER_LIGHTS * 4);
  private relCol = new Float32Array(MAX_SHADER_LIGHTS * 4);
  private curShape: TexWrap | null = null;
  /** Quads batched through this pipeline this frame (probe). */
  quads = 0;
  /** Of which shaped (a shape map was bound). */
  shapedQuads = 0;
  lightsFed = 0;

  constructor(game: Phaser.Game) {
    super({
      game,
      name: SCENERY_LIT_PIPELINE,
      vertShader: VERT,
      fragShader: FRAG,
      attributes: [
        { name: "inPosUv", size: 4, type: Phaser.Renderer.WebGL.FLOAT },
        { name: "inTint", size: 4, type: Phaser.Renderer.WebGL.UNSIGNED_BYTE, normalized: true },
        { name: "inMisc", size: 4, type: Phaser.Renderer.WebGL.FLOAT },
        { name: "inLocal", size: 4, type: Phaser.Renderer.WebGL.FLOAT },
        { name: "inOccA", size: 4, type: Phaser.Renderer.WebGL.FLOAT },
        { name: "inOccB", size: 4, type: Phaser.Renderer.WebGL.FLOAT },
        { name: "inOccC", size: 4, type: Phaser.Renderer.WebGL.FLOAT },
      ],
    });
  }

  /** MobilePipeline's boot, not MultiPipeline's: two scalar samplers, no
   *  `uMainSampler[%count%]` array (set1iv on a scalar is a GL error). */
  boot(): void {
    Phaser.Renderer.WebGL.WebGLPipeline.prototype.boot.call(this);
    this.set1i("uMainSampler", 0);
    this.set1i("uShapeSampler", 1);
  }

  /** Per-frame uniforms, uploaded ONCE per frame (the first sprite that binds
   *  the pipeline); `set4fv` uploads unconditionally, hence the frame guard. */
  onBind(_gameObject?: Phaser.GameObjects.GameObject): void {
    const frame = this.game.loop.frame;
    if (frame === this.lastUpload) return;
    this.lastUpload = frame;
    this.quads = 0;
    this.shapedQuads = 0;
    const f = this.source?.() ?? null;
    this.set1f("uOn", this.shade);
    this.set1f("uDebug", this.debug);
    this.set1f("uWrap", this.wrap);
    this.set1f("uSunLam", this.sunLam);
    this.set1f("uGain", this.gain);
    if (!f) {
      this.lightsFed = 0;
      this.set1f("uNumLights", 0);
      this.set4f("uSun", 0, 0, 1, 0);
      return;
    }
    this.orgX = f.orgX;
    this.orgY = f.orgY;
    const rel = this.relPos;
    const rc = this.relCol;
    const t = f.time;
    for (let i = 0; i < f.n; i++) {
      rel[i * 4] = f.pos[i * 4] - f.orgX;
      rel[i * 4 + 1] = f.pos[i * 4 + 1] - f.orgY;
      rel[i * 4 + 2] = f.pos[i * 4 + 2];
      rel[i * 4 + 3] = f.pos[i * 4 + 3];
      // The night shader's flicker, per light per FRAME (it evaluates the same
      // expression per texel; the product is identical), folded into the colour.
      const fl = f.col[i * 4 + 3];
      const flick = 1 - fl * 0.1 * (0.5 + 0.5 * Math.sin(t * 2.9 + i * 5.3)) - fl * 0.05 * Math.sin(t * 7.1 + i * 11.1);
      rc[i * 4] = f.col[i * 4] * flick;
      rc[i * 4 + 1] = f.col[i * 4 + 1] * flick;
      rc[i * 4 + 2] = f.col[i * 4 + 2] * flick;
      rc[i * 4 + 3] = fl;
    }
    this.lightsFed = f.n;
    this.set1f("uNumLights", f.n);
    this.set4fv("uLightPos", rel);
    this.set4fv("uLightCol", rc);
    this.set4f("uSun", f.sun[0], f.sun[1], f.sun[2], f.sun[3]);
  }

  batchSprite(
    gameObject: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite,
    camera: Phaser.Cameras.Scene2D.Camera,
    parentTransformMatrix?: Phaser.GameObjects.Components.TransformMatrix,
  ): void {
    this.cam = camera;
    super.batchSprite(gameObject, camera, parentTransformMatrix);
  }

  /** A batch entry per (art, shape) pair: art on unit 0, the shape map (or
   *  the renderer's white texture for an unshaped quad) on unit 1 — the
   *  LightPipeline's own construction, minus its per-object flush. */
  private ensureBatch(texture: TexWrap, shape: TexWrap): void {
    if (this.currentBatch && this.currentTexture === texture && this.curShape === shape) return;
    this.createBatch(texture);
    this.addTextureToBatch(shape);
    this.curShape = shape;
  }

  setGameObject(gameObject: Phaser.GameObjects.GameObject, frame?: Phaser.Textures.Frame): number {
    if (frame === undefined) frame = (gameObject as Img).frame;
    const d = (gameObject as Img).pipelineData as Partial<SceneryLitShape> | undefined;
    this.ensureBatch(frame.source.glTexture as TexWrap, d?.tex ?? (this.renderer.whiteTexture as TexWrap));
    return 0;
  }

  onAfterFlush(): void {
    this.curShape = null;
  }

  /** MultiPipeline.batchQuad with the extra per-vertex data. The quad arrives
   *  in CAMERA space; the world px of each corner come back through the camera
   *  matrix (uniform zoom + scroll, no rotation), and the hitbox centre
   *  (`hbX/hbY`, world px) turns them into (X cells, Z levels). */
  batchQuad(
    gameObject: Phaser.GameObjects.GameObject | null,
    x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
    u0: number, v0: number, u1: number, v1: number,
    tintTL: number, tintTR: number, tintBL: number, tintBR: number,
    tintEffect: number | boolean,
    texture?: TexWrap,
    _unit?: number,
  ): boolean {
    let hasFlushed = false;
    if (this.shouldFlush(6)) {
      this.flush();
      hasFlushed = true;
    }
    const d = (gameObject as Img | null)?.pipelineData as Partial<SceneryLitShape> | undefined;
    const shaped = !!d && !!d.tex && d.hbX !== undefined && d.occ !== undefined;
    if (!this.currentBatch && texture) this.ensureBatch(texture, (shaped ? d!.tex : undefined) ?? (this.renderer.whiteTexture as TexWrap));
    const cam = this.cam;
    const eff = typeof tintEffect === "boolean" ? (tintEffect ? 1 : 0) : tintEffect;
    // Camera space → world px: cam-space = m.a·(wx − scrollX) + m.e (no rotation).
    let sx = 1, sy = 1, ex = 0, ey = 0, scx = 0, scy = 0;
    if (cam) {
      const m = (cam as unknown as { matrix: Phaser.GameObjects.Components.TransformMatrix }).matrix;
      sx = m.a || 1; sy = m.d || 1; ex = m.e; ey = m.f;
      scx = cam.scrollX; scy = cam.scrollY;
    }
    const hbX = shaped ? d!.hbX! : 0;
    const hbY = shaped ? d!.hbY! : 0;
    const kx = 1 / (this.dx * SQ2);
    const kz = 1 / this.lh;
    const flip = shaped ? d!.flip ?? 1 : 0;
    const sv = shaped ? d!.sv ?? 0 : 0;
    const fc = shaped ? d!.fc! - this.orgX : 0;
    const fr = shaped ? d!.fr! - this.orgY : 0;
    const fz = shaped ? d!.fz! : 0;
    const O = shaped ? d!.occ! : null;
    const F = this.vertexViewF32;
    const U = this.vertexViewU32;
    let o = this.vertexCount * this.currentShader.vertexComponentCount - 1;
    QX[0] = x0; QX[1] = x1; QX[2] = x2; QX[3] = x0; QX[4] = x2; QX[5] = x3;
    QY[0] = y0; QY[1] = y1; QY[2] = y2; QY[3] = y0; QY[4] = y2; QY[5] = y3;
    QU[0] = u0; QU[1] = u0; QU[2] = u1; QU[3] = u0; QU[4] = u1; QU[5] = u1;
    QV[0] = v0; QV[1] = v1; QV[2] = v1; QV[3] = v0; QV[4] = v1; QV[5] = v0;
    QT[0] = tintTL; QT[1] = tintBL; QT[2] = tintBR; QT[3] = tintTL; QT[4] = tintBR; QT[5] = tintTR;
    for (let k = 0; k < 6; k++) {
      const x = QX[k];
      const y = QY[k];
      F[++o] = x; F[++o] = y; F[++o] = QU[k]; F[++o] = QV[k];
      U[++o] = QT[k];
      F[++o] = eff; F[++o] = flip; F[++o] = sv; F[++o] = fz;
      F[++o] = shaped ? ((x - ex) / sx + scx - hbX) * kx : 0;
      F[++o] = shaped ? (hbY - ((y - ey) / sy + scy)) * kz : 0;
      F[++o] = fc; F[++o] = fr;
      if (O) for (let j = 0; j < SCENERY_LIT_OCC; j++) F[++o] = O[j];
      else for (let j = 0; j < SCENERY_LIT_OCC; j++) F[++o] = 1;
    }
    this.vertexCount += 6;
    this.currentBatch!.count = this.vertexCount - this.currentBatch!.start;
    this.quads++;
    if (shaped) this.shapedQuads++;
    this.onBatch(gameObject ?? undefined);
    return hasFlushed;
  }
}
