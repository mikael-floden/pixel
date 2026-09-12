/* THE BOUNDARY ON THE GPU — the shader test's compositor (2026-09-12).
 *
 * `composeBoundary` (tiles3draw.ts) is three reads per texel: `rgb = mask ?
 * plateB : plateA`, `alpha = the silhouette`, then the seam texels darkened to
 * `tone` of themselves. This is the same three reads as a fragment shader over
 * the two plate FILES and the three pattern SHEETS — all of them textures the
 * game has already uploaded once — so a boundary costs the GPU one 64x46 quad
 * and the CPU nothing: no canvas, no readback, no texture per (pattern,
 * groundA, groundB). It exists so the maintainer can measure that ceiling
 * before the real compositor is written; it is the SHAPE of the real one, not
 * the real one: where a plate file has no texel the CPU conformer paints the
 * palette wall colour and this does the same, but a conformed plate's own
 * texels keep the file's colour, the liquid margin row is not replicated, and
 * the raised occluder copy of a cap still draws plate A alone.
 *
 * Extends Phaser's SinglePipeline (one texture unit for plate A, the one the
 * DynamicTexture draws with) and adds four samplers on units 1-4. Per stamp the
 * scene binds the pipeline, sets the frame rects, binds the four textures, and
 * draws ONE image through it — uniforms are per draw, so each boundary is its
 * own draw call (15-287 a window; a slice draws a few dozen). */
import Phaser from "phaser";

export const BOUNDARY_PIPELINE = "t3boundary";

const FRAG = `
#define SHADER_NAME T3_BOUNDARY_FS
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uMainSampler; // plate A, the image's own texture
uniform sampler2D uPlateB;
uniform sampler2D uMask;
uniform sampler2D uBorder;
uniform sampler2D uSil;   // alpha: the silhouette; red: the library top face
uniform vec4 uFrameA;     // plate A's window in its texture: u0, v0, du, dv
uniform vec4 uFrameB;     // plate B's
uniform vec4 uMaskRect;   // the mask frame in the mask/border sheets (same layout)
uniform vec3 uWallA;      // each ground's palette wall colour: what the CPU
uniform vec3 uWallB;      // conformer paints where the file has no texel
uniform float uTone;
uniform float uTopOnly;
varying vec2 outTexCoord;
varying float outTintEffect;
varying vec4 outTint;
void main () {
  vec2 l = (outTexCoord - uFrameA.xy) / uFrameA.zw;
  vec4 a = texture2D(uMainSampler, outTexCoord);
  vec4 b = texture2D(uPlateB, uFrameB.xy + l * uFrameB.zw);
  vec2 m = uMaskRect.xy + l * uMaskRect.zw;
  float mask = texture2D(uMask, m).a;
  float border = texture2D(uBorder, m).a;
  vec4 s = texture2D(uSil, l);
  // The plates are premultiplied; under the silhouette both are opaque, so
  // their rgb is the colour itself.
  vec3 rgb = mask > 0.5 ? (b.a > 0.0 ? b.rgb : uWallB) : (a.a > 0.0 ? a.rgb : uWallA);
  if (border > 0.5) rgb *= uTone;
  float alpha = s.a * (uTopOnly > 0.5 ? (s.r > 0.0 ? 1.0 : 0.0) : 1.0);
  vec4 color = vec4(rgb * alpha, alpha);
  gl_FragColor = color * vec4(outTint.bgr * outTint.a, outTint.a);
}
`;

export class BoundaryPipeline extends Phaser.Renderer.WebGL.Pipelines.SinglePipeline {
  constructor(game: Phaser.Game) {
    super({ game, fragShader: FRAG });
  }
  onBoot(): void {
    this.set1i("uMainSampler", 0);
    this.set1i("uPlateB", 1);
    this.set1i("uMask", 2);
    this.set1i("uBorder", 3);
    this.set1i("uSil", 4);
  }
}

/** The pipeline, registered once per renderer; null on the canvas renderer. */
export function boundaryPipeline(game: Phaser.Game): BoundaryPipeline | null {
  const r = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
  if (!r || !("pipelines" in r) || !r.pipelines) return null;
  const have = r.pipelines.get(BOUNDARY_PIPELINE) as BoundaryPipeline | null;
  if (have) return have;
  const pipe = new BoundaryPipeline(game);
  r.pipelines.add(BOUNDARY_PIPELINE, pipe);
  return pipe;
}
