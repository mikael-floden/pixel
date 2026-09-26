// THE SHADER CONTRACT — every effect layer is ONE fragment function,
//   vec4 effect(vec2 p)
// where p is the fragment's position in WORLD PIXELS relative to the layer's
// anchor, x right and y UP (height above the anchor is +y). It returns a
// PREMULTIPLIED colour: rgb may exceed a (that excess is pure additive light),
// a is how much of the world behind it is covered. One blend mode (ONE,
// ONE_MINUS_SRC_ALPHA) then draws smoke, opaque fire cores and pure glow alike.
//
// GLSL ES 1.00 (his phone runs WebGL1): no integer ops, no texelFetch, loops
// with constant bounds. HIGHP always (games2 highp.ts is law). Hashes are
// sin-free (Hoskins) — fract(sin()) bands on a 16-bit-ish mobile sin.

export const VERT = `precision highp float;
attribute vec2 aPos;
uniform vec4 uRect;   // box: top-left x, y (world px, y DOWN), w, h
uniform vec2 uAnchor; // the layer's anchor, world px
uniform vec4 uView;   // clip = world * uView.xy + uView.zw
uniform float uScale; // the Size tunable: the whole effect grows about its anchor
varying vec2 vLocal;
void main() {
  vec2 w = uRect.xy + aPos * uRect.zw;
  vLocal = vec2(w.x - uAnchor.x, uAnchor.y - w.y) / uScale;
  gl_Position = vec4(w * uView.xy + uView.zw, 0.0, 1.0);
}
`;

export const PRELUDE = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vLocal;
uniform vec4 uRect;
uniform float uTime;   // layer-local seconds (stepped when the style asks for it)
uniform float uLife;   // 0..1 across the layer's span (0 for an open-ended loop)
uniform float uFade;   // 0..1 envelope: intro ramp x outro ramp (1 for one-shots)
uniform float uLevel;  // 1..10
uniform float uLv;     // (level - 1) / 9
uniform float uSeed;   // 0..1, one per cast
uniform vec2  uDir;    // unit direction on SCREEN, y up (travel, facing, beam)
uniform vec2  uGDir;   // the same direction on the GROUND, in cells
uniform float uLen;    // px: beam length / distance travelled / reach
uniform vec4  uGround; // mat2: local px (y up) -> ground cells
uniform float uBands;  // palette bands (0 = smooth)
uniform float uDither; // ordered dither on/off
uniform float uBright; // brightness tunable
uniform float uPx;     // pixel snap in local px (0 = smooth)
uniform vec3  uTint;   // what the world's light does to a NON-emissive layer (1 = untouched)
#define PI 3.14159265
#define TAU 6.28318531

// ---- hashes (Dave Hoskins, "Hash without Sine", MIT) ----
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash21(float p) { vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash31(float p) { vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }

// ---- noise ----
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
const mat2 OCT = mat2(1.6, 1.2, -1.2, 1.6);
float fbm2(vec2 p) { return (vnoise(p) * 0.6667 + vnoise(OCT * p + 3.7) * 0.3333); }
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = OCT * p + 3.7; a *= 0.5; }
  return v / 0.9375;
}
float ridged(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0); v += a * n * n; p = OCT * p + 3.7; a *= 0.5; }
  return v / 0.9375;
}
// F1 distance, F2 - F1 (0 on a cell edge), the cell's own random
vec3 voronoi(vec2 p) {
  vec2 n = floor(p); vec2 f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + hash22(n + g) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = hash12(n + g + 17.0); } else if (d < d2) { d2 = d; }
  }
  d1 = sqrt(d1); d2 = sqrt(d2);
  return vec3(d1, d2 - d1, id);
}

// ---- shapes (signed distance, px) ----
float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float sdRing(vec2 p, float r, float w) { return abs(length(p) - r) - w; }
// an n-pointed star: outer radius r, inner radius ri
float sdStar(vec2 p, float r, float ri, float n) {
  float a = atan(p.y, p.x); float seg = TAU / n;
  float k = abs(mod(a + seg * 0.5, seg) - seg * 0.5) / (seg * 0.5);
  return length(p) - mix(r, ri, k);
}

// ---- frames ----
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
// p in the direction frame: x along uDir, y across it (left of travel)
vec2 along(vec2 p) { return vec2(dot(p, uDir), dot(p, vec2(-uDir.y, uDir.x))); }
// p on the GROUND, in cells (a ground circle is a circle here)
vec2 gnd(vec2 p) { return mat2(uGround.xy, uGround.zw) * p; }
// SCREEN px from ground point g (cells) to the ground circle of radius R: a
// ring drawn with this is the same number of pixels thick all the way round
// (a width in cells would be 2.3x thinner at the ellipse's top and bottom).
float ringPx(vec2 g, float R) {
  float r = length(g); vec2 n = g / max(r, 1e-4);
  float k = length(vec2(dot(uGround.xy, n), dot(uGround.zw, n)));
  return abs(r - R) / max(k, 1e-5);
}
// ground frame: x along the ground direction, y across it
vec2 galong(vec2 g) { return vec2(dot(g, uGDir), dot(g, vec2(-uGDir.y, uGDir.x))); }
float ang01(vec2 p) { return atan(p.y, p.x) / TAU + 0.5; }

// ---- the pixel look ----
float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float dith(vec2 p) { return uDither > 0.5 ? bayer4(p) - 0.46875 : 0.0; }
// quantize 0..1 into the palette's bands, ordered-dithered between them
float qz(float v, vec2 p) {
  if (uBands < 0.5) return clamp(v, 0.0, 1.0);
  return clamp(floor(v * uBands + 0.5 + dith(p)), 0.0, uBands) / uBands;
}
// a hard pixel edge (soft in smooth mode): 1 where v is above the edge
float cut(float v, float edge, vec2 p) {
  if (uBands < 0.5) return smoothstep(edge - 0.035, edge + 0.035, v);
  return step(edge, v + dith(p) * 0.1);
}
// dithered falloff for glows: a 0..1 amount becomes on/off pixels in pixel
// mode. Below 0.06 it is OFF: a glow's faint tail must never sprinkle lone
// pixels out to the edge of the layer's box.
float dglow(float v, vec2 p) {
  if (v < 0.06) return 0.0;
  if (uBands < 0.5) return clamp(v, 0.0, 1.0);
  float q = clamp(v, 0.0, 1.0) * 4.0;
  return (floor(q) + step(0.5 - dith(p) * 0.999, fract(q))) / 4.0;
}
// COMPACT falloff: 1 at d = 0, exactly 0 from d = r on (never exp: an
// exponential never ends, and its tail becomes dust at the box edge)
float fall(float d, float r) { float k = clamp(1.0 - d / r, 0.0, 1.0); return k * k; }
vec3 ramp3(vec3 a, vec3 b, vec3 c, float t) {
  t = clamp(t, 0.0, 1.0) * 2.0;
  return t < 1.0 ? mix(a, b, t) : mix(b, c, t - 1.0);
}
vec3 ramp4(vec3 a, vec3 b, vec3 c, vec3 d, float t) {
  t = clamp(t, 0.0, 1.0) * 3.0;
  return t < 1.0 ? mix(a, b, t) : (t < 2.0 ? mix(b, c, t - 1.0) : mix(c, d, t - 2.0));
}
vec3 ramp5(vec3 a, vec3 b, vec3 c, vec3 d, vec3 e, float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  if (t < 1.0) return mix(a, b, t);
  if (t < 2.0) return mix(b, c, t - 1.0);
  if (t < 3.0) return mix(c, d, t - 2.0);
  return mix(d, e, t - 3.0);
}

// ---- output (premultiplied) ----
vec4 paint(vec3 c, float a) { return vec4(c * a, a); }          // covers what is behind
vec4 hot(vec3 c, float a) { return vec4(c * a * uBright, a); }  // covers, and is a light
vec4 glow(vec3 c) { return vec4(c * uBright, 0.0); }            // pure added light
vec4 over(vec4 top, vec4 bottom) { return top + bottom * (1.0 - top.a); }
`;

export const MAIN = `
void main() {
  vec2 p = vLocal;
  if (uPx > 0.0) p = (floor(p / uPx) + 0.5) * uPx;
  vec4 c = clamp(effect(p), 0.0, 1.0);
  c.rgb *= uTint;
  gl_FragColor = c;
}
`;

/** Line of the effect's own source that a compiler error names, so a shader
 *  error reads "fire/fireball orb:12" and not "line 131 of a prelude". */
export const PRELUDE_LINES = PRELUDE.split("\n").length;

export function fragmentSource(body) {
  return PRELUDE + "\n#line 1\n" + body + "\n" + MAIN;
}

/** A template tag that only exists so editors highlight the GLSL. */
export const glsl = (s, ...v) => s.reduce((a, b, i) => a + b + (i < v.length ? v[i] : ""), "");
