/** THE DEPTH-TESTED SPRITE PIPELINE — terrain occlusion per PIXEL, no
 *  occluder sprites.
 *
 *  Until 2026-09-12 a body interleaved with terrain by the painter alone: every
 *  raised cell near the camera was re-issued as a pooled Image at painter depth
 *  `by + dy` (3,400-7,800 of them, rebuilt every 96 px of camera travel at
 *  50-60 ms — 95 of the 140 long frames in the maintainer's last beacon run),
 *  and a lit copy was cropped by a cover atlas built from those same images.
 *  This pipeline deletes the whole set: the ground texture already paints all
 *  terrain, so a body only has to NOT draw where nearer terrain would have
 *  covered it. Each fragment resolves the terrain surface the screen pixel
 *  shows — the night shader's own `terrainResolve`, included verbatim through
 *  `resolveGlslChunk()` so lighting and occlusion can never disagree — and is
 *  discarded when that surface is nearer to the camera than the body's point.
 *
 *  THE TEST IS 3-D, NOT A PAINTER SCALAR. A body is a vertical billboard: the
 *  pixel drawn at world y `wy` is at height `zPx = (flatY − wy) / lh` above its
 *  feet's flat line (`a − b·wy` per vertex: a = flatY/lh, b = 1/lh); a ground
 *  decal (a shadow) is flat at one height (b = 0). On the camera ray through
 *  that pixel the nearer surface is the one with the LARGER height (the ray is
 *  v = v0 + z·kk, larger v = nearer), so the pixel is hidden exactly when the
 *  resolved surface's z exceeds zPx. Flat ground never hides a body on it (the
 *  ray reaches z = 0 BEHIND the feet), a raised cell in front does, a wall
 *  hides everything below its top and nothing above it — the cases
 *  depthrule.ts spends 230 lines approximating with lifts and clamps.
 *
 *  THE FLOOR (inOcc.z): art below the anchor (the 4 px body seat, walk frames
 *  dipping past the idle line) is treated as AT the standing level, never
 *  below it — otherwise the ground the body stands on, being "nearer" than a
 *  point below it, would eat the feet. A raised cell in front still hides the
 *  seat because its top is above the floor.
 *
 *  ONLY A NEARER DIAGONAL HIDES (inOcc.w = the caller's own cell, tdCell): a
 *  column beside the body is what the painter drew behind it, and a body's
 *  feet do overlap the columns beside its cell; the old renderer never
 *  clipped them there, so neither does this (measured: the feet's outer rows
 *  clipped along every dungeon corridor wall without it).
 *
 *  MODES (inMisc.w): 0 = no test (the plain sprite); 1 = draw only the visible
 *  part (base sprite, lit copy, fog silhouette, shadow); 2 = draw only the
 *  HIDDEN part (the hidden-behind outline, `syncCoverOutline`). Only fragments
 *  with alpha run the walk, and WorldScene arms mode 1 only on sprites the
 *  cover rule says something covers (`coverY` set), so the per-pixel walk
 *  costs on covered bodies alone.
 *
 *  Height/room textures ride on units 1-4 of every batch (`addTextureToBatch`,
 *  the scenery-lit pipeline's construction); the art is on unit 0 through one
 *  scalar `uMainSampler` (MobilePipeline's boot — `set1iv` on a scalar is a GL
 *  error). World coordinates come PER VERTEX (camera-space quad back through
 *  the camera matrix, as scenerylit does), never from gl_FragCoord: a masked or
 *  captured draw has no screen to read.
 *
 *  Switch: `?occ=depth` / `?occ=sprites` (remembered as `ml-occ-path`); parity
 *  against the sprite path is measured by `scripts/verify-render-retake.mjs`.
 */

import Phaser from "phaser";
import { resolveGlslChunk, RESOLVE_GLSL_UNIFORMS, type NightLights } from "./nightlight";

export const TERRAIN_DEPTH_PIPELINE = "terrain-depth";

/** Per-sprite data (`pipelineData.td`): a, b, floor, mode, own cell (col +
 *  1024 × row, one float), hTop (the tallest overlapping column, levels — the
 *  walk starts there) — see the header. */
export type TerrainDepthData = Float32Array;

export function terrainDepthData(): TerrainDepthData {
  return new Float32Array(6);
}

/** The caller's own cell as one float the shader unpacks (col + 1024·row). */
export function tdCell(col: number, row: number): number {
  return Math.max(0, Math.floor(col)) + 1024 * Math.max(0, Math.floor(row));
}

/** The height-line for a billboard whose feet's flat line is at `flatY` and
 *  which stands at level `floor` (levels) in `cell` (tdCell), or a flat decal
 *  at height `z`. */
export function tdBillboard(d: TerrainDepthData, flatY: number, floor: number, lh: number, mode: number, cell: number, hTop: number): void {
  d[0] = flatY / lh;
  d[1] = 1 / lh;
  d[2] = floor;
  d[3] = mode;
  d[4] = cell;
  d[5] = Math.min(63, Math.max(0, Math.ceil(hTop + 0.5)));
}
export function tdFlat(d: TerrainDepthData, z: number, mode: number, cell: number, hTop: number): void {
  d[0] = z;
  d[1] = 0;
  d[2] = z;
  d[3] = mode;
  d[4] = cell;
  d[5] = Math.min(63, Math.max(0, Math.ceil(hTop + 0.5)));
}

/** THE OCCLUSION TEST AS GLSL — the resolve chunk plus one function, for this
 *  pipeline and for the scenery-lit one (same uniforms, same walk). */
export function terrainHidesGlsl(): string {
  return `${RESOLVE_GLSL_UNIFORMS}
uniform float uTdEps;
${resolveGlslChunk()}
// Is the point drawn at world w, at height zPx (levels), standing in the cell
// on diagonal vCell (col + row), behind nearer terrain? Only a column on a
// NEARER diagonal may hide it: a column beside the body (same diagonal) is
// what the painter draws behind it (equal depth, the body created later), and
// a body's feet do overlap the columns beside its cell — the old renderer
// never clipped them there and neither does this.
// A DECK TOP (a slab over lower ground: roof, bridge, lid) hides a body that
// stands BELOW it wherever the ray meets that top, whatever the pixel's own
// height — the painter clamps such a body behind the slab and the plates
// cover it; a head "poking through the planks" is what the 3-D rule alone
// draws (measured at the river bridge). ownPacked = col + 1024 x row (tdCell).
// Returns WHY: 0 visible, 1 a nearer deck top, 2 the own column's slab,
// 3 nearer terrain (the 3-D rule) — the probe's uTdDbg paints the reason.
// hTop: the tallest column overlapping the sprite (levels) — the walk starts
// there, not at the world's top (the walk's cost is its length).
int terrainHidesWhy(vec2 w, float zPx, float zFloor, float ownPacked, float hTop) {
  float u = (w.x - uIsoA.x) / uIsoA.z - 1.0;
  float v0 = (w.y - uIsoA.y) / uIsoA.w;
  vec2 cell;
  float z;
  if (!terrainResolve(u, v0, hTop, cell, z)) return 0;
  vec2 own = vec2(mod(ownPacked, 1024.0), floor(ownPacked / 1024.0));
  float cv = floor(cell.x) + floor(cell.y);
  float ov = own.x + own.y;
  float H = heightAt(cell);
  if (H > baseTerrAt(cell) + 0.5 && H > zFloor + 0.5 && z >= H - 0.01) {
    // A deck top over a body below it: nearer diagonals cover; the body's
    // own diagonal covers too while its own column wears the slab (the
    // painter clamps it just behind that column); diagonals behind never.
    if (cv > ov + 0.5) return 1;
    if (cv > ov - 0.5) {
      vec2 oc = own + 0.5;
      float Ho = heightAt(oc);
      return (Ho > baseTerrAt(oc) + 0.5 && Ho > zFloor + 0.5) ? 2 : 0;
    }
    return 0;
  }
  if (cv < ov + 0.5) return 0;
  // A LOW LEDGE NEVER COVERS: a column rising less than two levels above the
  // caller's floor is drawn behind it (depthrule's lift — the maintainer's
  // rule; measured: a one-level cut wall beside a dungeon corridor ate the
  // feet of anyone walking along it).
  if (H < zFloor + 1.5) return 0;
  return z > zPx + uTdEps ? 3 : 0;
}
bool terrainHides(vec2 w, float zPx, float zFloor, float ownPacked, float hTop) {
  return terrainHidesWhy(w, zPx, zFloor, ownPacked, hTop) > 0;
}
`;
}

const VERT = `#define SHADER_NAME TERRAIN_DEPTH_VS
precision highp float;
uniform mat4 uProjectionMatrix;
attribute vec4 inPosUv;
attribute vec4 inTint;
attribute vec4 inMisc;
attribute vec4 inOcc;
varying vec2 outTexCoord;
varying float outTintEffect;
varying vec4 outTint;
varying vec2 vWorld;
varying vec4 vOcc;
varying float vMode;
varying float vTop;
void main() {
  gl_Position = uProjectionMatrix * vec4(inPosUv.xy, 1.0, 1.0);
  outTexCoord = inPosUv.zw;
  outTint = inTint;
  outTintEffect = inMisc.x;
  vWorld = inMisc.yz;
  vMode = mod(inMisc.w, 4.0);   // mode + 4 x hTop share one float
  vTop = floor(inMisc.w / 4.0);
  vOcc = inOcc;
}
`;

function buildFrag(): string {
  return `#define SHADER_NAME TERRAIN_DEPTH_FS
precision highp float;
uniform sampler2D uMainSampler;
uniform float uTdDbg;
varying vec2 outTexCoord;
varying float outTintEffect;
varying vec4 outTint;
varying vec2 vWorld;
varying vec4 vOcc;
varying float vMode;
varying float vTop;
${terrainHidesGlsl()}
void main() {
  vec4 texture = texture2D(uMainSampler, outTexCoord);
  vec4 texel = vec4(outTint.bgr * outTint.a, outTint.a);
  vec4 color = texture * texel;
  if (outTintEffect == 1.0) {
    color.rgb = mix(texture.rgb, outTint.bgr * outTint.a, texture.a);
  } else if (outTintEffect == 2.0) {
    color = texel;
  }
  if (vMode > 0.5 && color.a > 0.002) {
    float zPx = max(vOcc.x - vOcc.y * vWorld.y, vOcc.z);
    int why = terrainHidesWhy(vWorld, zPx, vOcc.z, vOcc.w, vTop);
    if (uTdDbg > 2.5) {
      // Probe 3: every tested pixel this pipeline DRAWS, magenta — the parity
      // harness's mask (a hidden region always wears its ring, so a body the
      // sprite path showed there still meets the mask at the ring).
      bool drawn = vMode < 1.5 ? why == 0 : why > 0;
      if (!drawn) discard;
      color = vec4(1.0, 0.0, 1.0, 1.0);
    } else if (uTdDbg > 1.5) {
      // Probe 2: every tested pixel magenta, hidden or not.
      color = vec4(1.0, 0.0, 1.0, 1.0);
    } else if (uTdDbg > 0.5) {
      // Probe 1: paint the reason (red deck, green own slab, blue terrain).
      if (why == 0) discard;
      color = why == 1 ? vec4(1.0, 0.0, 0.0, 1.0) : why == 2 ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(0.0, 0.4, 1.0, 1.0);
    } else if (vMode < 1.5) {
      if (why > 0) discard;
    } else if (why == 0) discard;
  }
  gl_FragColor = color;
}
`;
}

type Img = Phaser.GameObjects.Image;
export type TexWrap = Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper;

/** Upload the frame's terrain uniforms to a pipeline that includes
 *  terrainHidesGlsl() and return the four texture wrappers for units
 *  uHeight, uHeightL, uHBlock, uRoom (the renderer's white texture where a map
 *  is absent — an unbound sampler reads unit 0, the art). Shared by this
 *  pipeline and the scenery-lit one. */
export function uploadTerrainUniforms(pipe: Phaser.Renderer.WebGL.WebGLPipeline, night: NightLights | null, eps: number): TexWrap[] {
  const white = pipe.renderer.whiteTexture as TexWrap;
  const tm = pipe.game.textures;
  const wrap = (key: string | null): TexWrap => {
    if (!key || !tm.exists(key)) return white;
    return (tm.get(key).source[0].glTexture as TexWrap | null) ?? white;
  };
  pipe.set1f("uTdEps", eps);
  const t = night?.terrainUniforms() ?? null;
  if (!t) {
    // No night pass yet: nothing resolves, every test reads "not hidden".
    pipe.set4f("uIsoB", 15, 0, 0, 0);
    pipe.set1f("uSkip", 0);
    pipe.set1f("uRoomOn", 0);
    return [white, white, white, white];
  }
  pipe.set4f("uIsoA", t.ox, t.oyArt, t.dx, t.dy);
  pipe.set4f("uIsoB", t.lh, t.gridW, t.gridH, t.maxLevel);
  pipe.set1f("uHScale", t.hScale);
  pipe.set2f("uHBlockN", t.blockN.x, t.blockN.y);
  pipe.set1f("uSkip", t.skip ? 1 : 0);
  pipe.set1f("uIndoor", t.indoor ? 1 : 0);
  pipe.set1f("uIndoorTop", t.indoorTop);
  pipe.set1f("uRoomOn", t.roomOn ? 1 : 0);
  return [wrap(t.heightKey), wrap(t.heightLKey), wrap(t.skip ? t.blockKey : null), wrap(t.roomOn ? t.roomKey : null)];
}

const QX = new Float32Array(6);
const QY = new Float32Array(6);
const QU = new Float32Array(6);
const QV = new Float32Array(6);
const QT = new Uint32Array(6);

export class TerrainDepthPipeline extends Phaser.Renderer.WebGL.Pipelines.MultiPipeline {
  /** Where the frame's terrain uniforms come from — WorldScene wires the night pass. */
  night: NightLights | null = null;
  /** Levels of slack before a surface counts as nearer (the body's own ground
   *  resolves to exactly its level; faces are fractional). */
  eps = 0.01;
  /** Probe: 1 paints every tested pixel by the reason it is hidden, 2 paints
   *  every tested pixel magenta, 3 every tested pixel that is DRAWN (the
   *  parity harness's mask). */
  dbg = 0;
  private cam: Phaser.Cameras.Scene2D.Camera | null = null;
  private lastUpload = -1;
  private white: TexWrap | null = null;
  private texUnits: TexWrap[] = [];
  /** Quads batched this frame, of them tested, and the tested quads' screen
   *  area in px (the fragments the walk may run on — the beacon's tdPx). */
  quads = 0;
  testedQuads = 0;
  testedPx = 0;

  constructor(game: Phaser.Game) {
    super({
      game,
      name: TERRAIN_DEPTH_PIPELINE,
      vertShader: VERT,
      fragShader: buildFrag(),
      attributes: [
        { name: "inPosUv", size: 4, type: Phaser.Renderer.WebGL.FLOAT },
        { name: "inTint", size: 4, type: Phaser.Renderer.WebGL.UNSIGNED_BYTE, normalized: true },
        { name: "inMisc", size: 4, type: Phaser.Renderer.WebGL.FLOAT },
        { name: "inOcc", size: 4, type: Phaser.Renderer.WebGL.FLOAT },
      ],
    });
  }

  boot(): void {
    Phaser.Renderer.WebGL.WebGLPipeline.prototype.boot.call(this);
    this.set1i("uMainSampler", 0);
    this.set1i("uHeight", 1);
    this.set1i("uHeightL", 2);
    this.set1i("uHBlock", 3);
    this.set1i("uRoom", 4);
  }

  /** Per-frame uniforms and the four texture wrappers, once per frame. */
  onBind(_gameObject?: Phaser.GameObjects.GameObject): void {
    const frame = this.game.loop.frame;
    if (frame === this.lastUpload) return;
    this.lastUpload = frame;
    this.quads = 0;
    this.testedQuads = 0;
    this.testedPx = 0;
    this.white = this.renderer.whiteTexture as TexWrap;
    this.set1f("uTdDbg", this.dbg);
    this.texUnits = uploadTerrainUniforms(this, this.night, this.eps);
  }

  batchSprite(
    gameObject: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite,
    camera: Phaser.Cameras.Scene2D.Camera,
    parentTransformMatrix?: Phaser.GameObjects.Components.TransformMatrix,
  ): void {
    this.cam = camera;
    super.batchSprite(gameObject, camera, parentTransformMatrix);
  }

  /** One batch per art texture; the height textures ride on units 1-4. */
  private ensureBatch(texture: TexWrap): void {
    if (this.currentBatch && this.currentTexture === texture) return;
    this.createBatch(texture);
    const u = this.texUnits.length === 4 ? this.texUnits : [this.white!, this.white!, this.white!, this.white!];
    for (let i = 0; i < 4; i++) this.addTextureToBatch(u[i]);
  }

  setGameObject(gameObject: Phaser.GameObjects.GameObject, frame?: Phaser.Textures.Frame): number {
    if (frame === undefined) frame = (gameObject as Img).frame;
    this.ensureBatch(frame.source.glTexture as TexWrap);
    return 0;
  }

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
    if (!this.currentBatch && texture) this.ensureBatch(texture);
    const d = ((gameObject as Img | null)?.pipelineData as { td?: TerrainDepthData } | undefined)?.td;
    const mode = d ? d[3] : 0;
    const modeTop = d ? d[3] + 4 * d[5] : 0; // mode + 4 x hTop, one attribute float
    const eff = typeof tintEffect === "boolean" ? (tintEffect ? 1 : 0) : tintEffect;
    // Camera space → world px: cam-space = m.a·(wx − scrollX) + m.e (no rotation).
    let sx = 1, sy = 1, ex = 0, ey = 0, scx = 0, scy = 0;
    const cam = this.cam;
    if (cam) {
      const m = (cam as unknown as { matrix: Phaser.GameObjects.Components.TransformMatrix }).matrix;
      sx = m.a || 1; sy = m.d || 1; ex = m.e; ey = m.f;
      scx = cam.scrollX; scy = cam.scrollY;
    }
    const a = d ? d[0] : 0;
    const b = d ? d[1] : 0;
    const fl = d ? d[2] : 0;
    const vc = d ? d[4] : 0;
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
      F[++o] = eff; F[++o] = (x - ex) / sx + scx; F[++o] = (y - ey) / sy + scy; F[++o] = modeTop;
      F[++o] = a; F[++o] = b; F[++o] = fl; F[++o] = vc;
    }
    this.vertexCount += 6;
    this.currentBatch!.count = this.vertexCount - this.currentBatch!.start;
    this.quads++;
    if (mode > 0) {
      this.testedQuads++;
      this.testedPx += Math.abs((x2 - x0) * (y2 - y0));
    }
    this.onBatch(gameObject ?? undefined);
    return hasFlushed;
  }
}
