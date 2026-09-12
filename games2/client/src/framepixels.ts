/* A FRAME'S PIXELS FOR A CPU READER, WHATEVER ITS SOURCE.
 *
 * Three readers in WorldScene draw a body's current frame into a canvas and
 * read the alpha back — `artBounds` (the opaque box), `alphaMap` (the swim
 * foam's silhouette) and `ringTextureFor` (the hidden-behind outline). They
 * did it with `drawImage(frame.source.image)`, which needs an element; a
 * texture the art queue uploaded in bands (artworker.ts) has a GL texture and
 * no element, and `drawImage` of a texture wrapper throws. So a reader asks
 * here: an element is drawn as before, a bare GL texture is READ BACK through
 * a temporary framebuffer and put in place.
 *
 * ALPHA ONLY. The readback is premultiplied RGBA and `putImageData` treats it
 * as straight, so the colours of a translucent texel land wrong — every reader
 * here reads the alpha channel alone (thresholds 16, 128, or the raw alpha),
 * which premultiplication never touches. A future reader that wants colour
 * must un-premultiply. Rows come back top-down: a band was uploaded with
 * UNPACK_FLIP_Y false, so texture row 0 is the image's top row and
 * `readPixels` walks texture rows upward. Gate: `__ml.artAlpha(key, frame)`
 * compares this against the <img> path's alpha for a banded frame.
 *
 * COST. A readback is a GPU sync — on his phone 32-63 ms inside the frame
 * (his 19:44 run of Smooth 3, the outline's first sight of a banded frame) —
 * so no reader takes it for a strip the art worker holds: `artBounds` has the
 * worker's boxes, and the outline and the foam clamp ask the worker for the
 * frame's alpha (`ArtQueue.frameAlpha`, answered a few frames later). The
 * readback is the element-less last resort and the parity probes' reference;
 * every reader caches per (texture, frame), so whichever path, it is once. */
import type Phaser from "phaser";

type Wrapper = Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper;
type GL = object | null | undefined; // a Phaser renderer of either kind; only a `gl` is read

/** Read `w x h` texels at (x, y) of a GL texture, top-down, premultiplied. */
export function readTextureRect(gl: WebGLRenderingContext | WebGL2RenderingContext, tex: WebGLTexture, x: number, y: number, w: number, h: number): Uint8ClampedArray<ArrayBuffer> | null {
  if (gl.isContextLost()) return null;
  const fb = gl.createFramebuffer();
  if (!fb) return null;
  const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  let out: Uint8ClampedArray<ArrayBuffer> | null = null;
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
    out = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
  gl.deleteFramebuffer(fb);
  return out;
}

/** Is this something `drawImage` accepts (and, for a bitmap, still open)? */
export function drawableSource(src: unknown): src is CanvasImageSource {
  if (!src || typeof src !== "object") return false;
  if (typeof ImageBitmap !== "undefined" && src instanceof ImageBitmap) return src.width > 0;
  if (typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement) return true;
  if (typeof HTMLCanvasElement !== "undefined" && src instanceof HTMLCanvasElement) return true;
  if (typeof OffscreenCanvas !== "undefined" && src instanceof OffscreenCanvas) return true;
  return false;
}

/** Draw the frame's cut rectangle 1:1 at (dx, dy). False when neither an
 *  element nor a readable GL texture is there. */
export function drawFrameInto(renderer: GL, ctx: CanvasRenderingContext2D, frame: Phaser.Textures.Frame, dx: number, dy: number): boolean {
  const src = frame.source.image as unknown;
  const w = frame.cutWidth;
  const h = frame.cutHeight;
  if (!w || !h) return false;
  if (drawableSource(src)) {
    ctx.drawImage(src, frame.cutX, frame.cutY, w, h, dx, dy, w, h);
    return true;
  }
  const gl = (renderer as { gl?: WebGLRenderingContext | WebGL2RenderingContext } | null | undefined)?.gl;
  const tex = (frame.source.glTexture as Wrapper | null)?.webGLTexture;
  if (!gl || !tex) return false;
  const px = readTextureRect(gl, tex, frame.cutX, frame.cutY, w, h);
  if (!px) return false;
  ctx.putImageData(new ImageData(px, w, h), dx, dy);
  return true;
}

/** The frame's alpha plane (cutWidth x cutHeight) the SYNCHRONOUS way: an
 *  element is drawn into a canvas, a bare GL texture is read back — the two
 *  paths of drawFrameInto, alpha only. For a banded frame a reader asks the
 *  art worker first (`ArtQueue.frameAlpha`, answered off the frame thread);
 *  this is the element path and the last resort. */
export function readFrameAlpha(renderer: GL, frame: Phaser.Textures.Frame): { w: number; h: number; a: Uint8Array } | null {
  const w = frame.cutWidth;
  const h = frame.cutHeight;
  if (!w || !h) return null;
  const src = frame.source.image as unknown;
  let px: Uint8ClampedArray | null = null;
  if (drawableSource(src)) {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(src, frame.cutX, frame.cutY, w, h, 0, 0, w, h);
    px = ctx.getImageData(0, 0, w, h).data;
  } else {
    const gl = (renderer as { gl?: WebGLRenderingContext | WebGL2RenderingContext } | null | undefined)?.gl;
    const tex = (frame.source.glTexture as Wrapper | null)?.webGLTexture;
    if (!gl || !tex) return null;
    px = readTextureRect(gl, tex, frame.cutX, frame.cutY, w, h);
  }
  if (!px) return null;
  const a = new Uint8Array(w * h);
  for (let i = 0, q = 3; i < a.length; i++, q += 4) a[i] = px[q];
  return { w, h, a };
}

/** The whole first source of a texture as straight (un-premultiplied) RGBA,
 *  read back from its GL texture — for a reader that used to draw the source
 *  element into a canvas (`texPixels`) when the texture has no element. The
 *  un-premultiply is exact where alpha is 255 or 0 and within rounding
 *  elsewhere, which is what a colour AVERAGE (the scenery light block) or an
 *  alpha test (the shape maps, alphaBBox) can bear. Null when it cannot. */
export function readTexturePixels(renderer: GL, texture: Phaser.Textures.Texture): { w: number; h: number; data: Uint8ClampedArray } | null {
  const src = texture.source[0];
  const gl = (renderer as { gl?: WebGLRenderingContext | WebGL2RenderingContext } | null | undefined)?.gl;
  const tex = (src?.glTexture as Wrapper | null)?.webGLTexture;
  const w = src?.width ?? 0;
  const h = src?.height ?? 0;
  if (!gl || !tex || !w || !h) return null;
  const px = readTextureRect(gl, tex, 0, 0, w, h);
  if (!px) return null;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0 || a === 255) continue;
    px[i] = Math.min(255, Math.round((px[i] * 255) / a));
    px[i + 1] = Math.min(255, Math.round((px[i + 1] * 255) / a));
    px[i + 2] = Math.min(255, Math.round((px[i + 2] * 255) / a));
  }
  return { w, h, data: px };
}
