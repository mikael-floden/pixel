/* THE SPRITE BATCH WITHOUT A HEAP NUMBER PER CORNER (games-perf 2026-09-25).
 *
 * Phaser's MultiPipeline.batchSprite computes a sprite's quad and four tints
 * and hands them to `batchQuad` as twenty arguments. `batchQuad` is too big to
 * inline, so every one of those numbers that is not a small integer — eight
 * corner coordinates, four UVs, four packed tints (uint32s over the Smi range)
 * — is boxed into a fresh HeapNumber at the call, and so is each
 * `getTintAppendFloatAlpha` result. That was the largest allocation of a frame
 * on his phone: `render` 105-285 KB a frame in every window of his cool run
 * (6f3f9f8a), ~40% of everything allocated, all of it dying young — the reason
 * the young generation is collected ~18 times a second.
 *
 * This is the same function with `batchQuad`'s body written inline and the
 * tint packing inline: the same values into the same vertex slots in the same
 * order, so the vertex buffer — and every pixel — is byte for byte what
 * Phaser wrote (the render A/B harness with `--ls ml-batch-patch=0,1`). Only
 * a pipeline whose `batchQuad` is Phaser's own takes it: one that overrides it
 * (the scenery-lit pipeline, Phaser's PreFX) keeps the original call, and a
 * pipeline with its own `batchSprite` (Phaser's LightPipeline) never reaches
 * here. Copied from Phaser 3.90.0 (`MultiPipeline.batchSprite`,
 * `WebGLPipeline.batchQuad`, `Utils.getTintAppendFloatAlpha`); a Phaser
 * upgrade must re-copy it or drop the patch — `installBatchPatch` refuses any
 * other version. `?batchpatch=0` / localStorage `ml-batch-patch` "0" is the
 * off switch (read once, at install). */
import Phaser from "phaser";

const PHASER_VERSION = "3.90.0";

let installed = false;
let enabled = false;

/** Whether the patched batch is in force (for probes and the beacon). */
export function batchPatchOn(): boolean {
  return installed && enabled;
}

function switchOn(): boolean {
  try {
    const q = new URLSearchParams(location.search).get("batchpatch");
    if (q === "0" || q === "1") localStorage.setItem("ml-batch-patch", q);
    return localStorage.getItem("ml-batch-patch") !== "0";
  } catch {
    return true;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function installBatchPatch(): boolean {
  if (installed) return enabled;
  installed = true;
  enabled = switchOn() && Phaser.VERSION === PHASER_VERSION;
  if (!enabled) return false;
  const proto = Phaser.Renderer.WebGL.Pipelines.MultiPipeline.prototype as any;
  const original = proto.batchSprite as (this: any, g: any, c: any, p?: any) => void;
  const baseQuad = (Phaser.Renderer.WebGL.WebGLPipeline.prototype as any).batchQuad;
  proto.batchSprite = function batchSprite(this: any, gameObject: any, camera: any, parentTransformMatrix?: any): void {
    if (this.batchQuad !== baseQuad) {
      original.call(this, gameObject, camera, parentTransformMatrix);
      return;
    }
    this.manager.set(this, gameObject);

    const camMatrix = this._tempMatrix1;
    const spriteMatrix = this._tempMatrix2;
    const calcMatrix = this._tempMatrix3;

    const frame = gameObject.frame;
    const texture = frame.glTexture;

    let u0 = frame.u0;
    let v0 = frame.v0;
    let u1 = frame.u1;
    let v1 = frame.v1;
    let frameX = frame.x;
    let frameY = frame.y;
    let frameWidth = frame.cutWidth;
    let frameHeight = frame.cutHeight;
    const customPivot = frame.customPivot;

    const displayOriginX = gameObject.displayOriginX;
    const displayOriginY = gameObject.displayOriginY;

    let x = -displayOriginX + frameX;
    let y = -displayOriginY + frameY;

    if (gameObject.isCropped) {
      const crop = gameObject._crop;
      if (crop.flipX !== gameObject.flipX || crop.flipY !== gameObject.flipY) frame.updateCropUVs(crop, gameObject.flipX, gameObject.flipY);
      u0 = crop.u0;
      v0 = crop.v0;
      u1 = crop.u1;
      v1 = crop.v1;
      frameWidth = crop.width;
      frameHeight = crop.height;
      frameX = crop.x;
      frameY = crop.y;
      x = -displayOriginX + frameX;
      y = -displayOriginY + frameY;
    }

    let flipX = 1;
    let flipY = 1;
    if (gameObject.flipX) {
      if (!customPivot) x += -frame.realWidth + displayOriginX * 2;
      flipX = -1;
    }
    if (gameObject.flipY) {
      if (!customPivot) y += -frame.realHeight + displayOriginY * 2;
      flipY = -1;
    }

    let gx = gameObject.x;
    let gy = gameObject.y;
    if (camera.roundPixels) {
      gx = Math.floor(gx);
      gy = Math.floor(gy);
    }

    spriteMatrix.applyITRS(gx, gy, gameObject.rotation, gameObject.scaleX * flipX, gameObject.scaleY * flipY);
    camMatrix.copyFrom(camera.matrix);
    if (parentTransformMatrix) {
      camMatrix.multiplyWithOffset(parentTransformMatrix, -camera.scrollX * gameObject.scrollFactorX, -camera.scrollY * gameObject.scrollFactorY);
      spriteMatrix.e = gx;
      spriteMatrix.f = gy;
    } else {
      spriteMatrix.e -= camera.scrollX * gameObject.scrollFactorX;
      spriteMatrix.f -= camera.scrollY * gameObject.scrollFactorY;
    }
    camMatrix.multiply(spriteMatrix, calcMatrix);

    const quad = calcMatrix.setQuad(x, y, x + frameWidth, y + frameHeight, camera.renderRoundPixels);

    // Utils.getTintAppendFloatAlpha, inline: ((alpha * 255 | 0) & 0xff) << 24 | rgb, unsigned.
    const cameraAlpha = camera.alpha;
    const tintTL = ((((cameraAlpha * gameObject._alphaTL * 255) | 0) & 0xff) << 24 | gameObject.tintTopLeft) >>> 0;
    const tintTR = ((((cameraAlpha * gameObject._alphaTR * 255) | 0) & 0xff) << 24 | gameObject.tintTopRight) >>> 0;
    const tintBL = ((((cameraAlpha * gameObject._alphaBL * 255) | 0) & 0xff) << 24 | gameObject.tintBottomLeft) >>> 0;
    const tintBR = ((((cameraAlpha * gameObject._alphaBR * 255) | 0) & 0xff) << 24 | gameObject.tintBottomRight) >>> 0;

    if (this.shouldFlush(6)) this.flush();

    let unit = this.setGameObject(gameObject, frame);

    this.manager.preBatch(gameObject);

    // ---- WebGLPipeline.batchQuad, inline ----
    if (unit === undefined) unit = this.currentUnit;
    if (this.shouldFlush(6)) this.flush();
    if (!this.currentBatch) unit = this.setTexture2D(texture);

    const tintEffect = gameObject.tintFill;
    const x0 = quad[0], y0 = quad[1], x1 = quad[2], y1 = quad[3], x2 = quad[4], y2 = quad[5], x3 = quad[6], y3 = quad[7];
    const F = this.vertexViewF32;
    const U = this.vertexViewU32;
    let o = this.vertexCount * this.currentShader.vertexComponentCount - 1;

    F[++o] = x0; F[++o] = y0; F[++o] = u0; F[++o] = v0; F[++o] = unit; F[++o] = tintEffect; U[++o] = tintTL;
    F[++o] = x1; F[++o] = y1; F[++o] = u0; F[++o] = v1; F[++o] = unit; F[++o] = tintEffect; U[++o] = tintBL;
    F[++o] = x2; F[++o] = y2; F[++o] = u1; F[++o] = v1; F[++o] = unit; F[++o] = tintEffect; U[++o] = tintBR;
    F[++o] = x0; F[++o] = y0; F[++o] = u0; F[++o] = v0; F[++o] = unit; F[++o] = tintEffect; U[++o] = tintTL;
    F[++o] = x2; F[++o] = y2; F[++o] = u1; F[++o] = v1; F[++o] = unit; F[++o] = tintEffect; U[++o] = tintBR;
    F[++o] = x3; F[++o] = y3; F[++o] = u1; F[++o] = v0; F[++o] = unit; F[++o] = tintEffect; U[++o] = tintTR;

    this.vertexCount += 6;
    this.currentBatch.count = this.vertexCount - this.currentBatch.start;
    this.onBatch(gameObject);
    // ---- end batchQuad ----

    this.manager.postBatch(gameObject);
  };
  return true;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
