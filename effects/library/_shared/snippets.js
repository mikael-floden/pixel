// GLSL building blocks shared by many effects. Paste into a layer's frag
// (template literal) ahead of effect(). Each is a pure function of its
// arguments, so an effect can call it twice with different numbers.
import { glsl } from "../../runtime/glsl.js";

/** Debris flung from the origin and pulled down: n (<= 24) one-pixel streaks.
 *  v0 launch speed px/s, g gravity px/s^2, up 0..1 how much they favour up.
 *  Returns the streak's remaining life (0 = no spark here). */
export const SPARKS = glsl`
float sparks(vec2 p, float t, float n, float v0, float g, float up, float seed) {
  float m = 0.0;
  for (int i = 0; i < 24; i++) {
    if (float(i) >= n) break;
    vec3 h = hash31(float(i) * 7.13 + seed * 91.7);
    float life = 0.3 + 0.55 * h.z;
    if (t > life) continue;
    float a = mix(h.x * TAU, mix(0.2, PI - 0.2, h.x), up);
    float v = v0 * (0.35 + 0.65 * h.y);
    vec2 d = vec2(cos(a), sin(a));
    vec2 p1 = d * v * t - vec2(0.0, 0.5 * g * t * t);
    float t0 = max(t - 0.03 - 0.02 * h.y, 0.0);
    vec2 p0 = d * v * t0 - vec2(0.0, 0.5 * g * t0 * t0);
    if (sdSeg(p, p0, p1) < 0.75) m = max(m, 1.0 - t / life);
  }
  return m;
}
`;

/** Billowing smoke that rises and thins: density 0..1. R = size px. */
export const SMOKE = glsl`
float smoke(vec2 p, float L, float R, float seed) {
  vec2 q = p - vec2(0.0, L * R * 0.9);
  float r = R * (0.45 + 0.75 * L);
  float d = length(q * vec2(1.0, 1.2)) / r;
  float n = fbm(q / (R * 0.42) + vec2(seed * 7.0, -L * 2.2));
  return clamp((1.0 - d) + (n - 0.5) * 1.15, 0.0, 1.0) * (1.0 - L * L);
}
`;

/** A ring on the GROUND expanding to R cells over the layer's life:
 *  intensity 0..1 at ground point g (cells). */
export const SHOCK = glsl`
float shock(vec2 g, float L, float R, float w) {
  float r = length(g);
  float cur = R * (1.0 - pow(1.0 - L, 2.6));
  float ww = w * (0.35 + 0.65 * (1.0 - L));
  return (1.0 - smoothstep(0.0, ww, abs(r - cur))) * (1.0 - L);
}
`;

/** A jagged bolt from a to b (px): distance to it. seg = kinks, amp = px of
 *  displacement, tq = time quantum so it re-strikes rather than wobbles. */
export const BOLT = glsl`
float bolt(vec2 p, vec2 a, vec2 b, float seg, float amp, float tq, float seed) {
  vec2 ab = b - a; float L = length(ab); vec2 u = ab / max(L, 0.001); vec2 n = vec2(-u.y, u.x);
  float x = dot(p - a, u); float y = dot(p - a, n);
  float k = clamp(x / max(L, 0.001), 0.0, 1.0);
  float fi = k * seg; float i0 = floor(fi); float f = fi - i0;
  float o0 = (hash12(vec2(i0, tq + seed * 13.0)) - 0.5) * 2.0;
  float o1 = (hash12(vec2(i0 + 1.0, tq + seed * 13.0)) - 0.5) * 2.0;
  float env = sin(k * PI);
  float off = mix(o0, o1, f) * amp * env;
  float dy = abs(y - off);
  float dx = max(max(-x, x - L), 0.0);
  return length(vec2(dx, dy));
}
`;

/** Soft round mote with a hard pixel core: 0..1. */
export const MOTE = glsl`
float mote(vec2 p, vec2 c, float r) { return 1.0 - smoothstep(r * 0.5, r, length(p - c)); }
`;

/** A flame field: > 0 inside the flame (the value is its heat), < 0 outside.
 *  p in px with the flame's base centre at the origin; w = half-width at the
 *  base, h = height, t = time. Tongues break off the top by themselves. */
export const FLAME = glsl`
float flameField(vec2 p, float w, float h, float t, float seed) {
  float y = p.y / h;
  if (p.y < -14.0 || y > 1.25) return -1.0;
  float ww = w * (1.0 - 0.62 * clamp(y, 0.0, 1.0));
  float x = p.x / max(ww, 0.01);
  float n = fbm(vec2(p.x * 0.085, p.y * 0.055 - t * 2.3) + seed * 10.0);
  float n2 = vnoise(vec2(p.x * 0.2, p.y * 0.13 - t * 4.4) + seed * 3.0);
  // the base follows the front of an iso foot ring (lower in the middle) and
  // is torn by the same noise: never a straight, white-hot cut
  float bx = clamp(abs(p.x) / max(w, 0.01), 0.0, 1.0);
  // in PX, whatever the flame's height: a 200 px flame must not start 20 px underground
  float dip = min(0.14 * h, 9.0);
  float base = smoothstep(-3.0, 4.0, p.y + dip * (1.0 - bx * bx) + (n2 - 0.5) * 6.0);
  // max(): above the top (1 - y) turns negative and would flip a hugely
  // negative (1 - x*x) into a full-width bar of fire
  return (max(1.0 - x * x, -2.0) * max(1.0 - y, 0.0) * 1.3 + (n - 0.5) * 1.2 + (n2 - 0.5) * 0.45 - y * 0.3 - 0.12) * base;
}
`;

/** A four-point pixel sparkle centred at c: 1 on the star, else 0. arm =
 *  arm length px (0 = a single pixel). */
export const STAR4 = glsl`
float star4(vec2 p, vec2 c, float arm) {
  vec2 q = abs(floor(p - c + 0.5));
  return ((q.x < 0.5 && q.y <= arm) || (q.y < 0.5 && q.x <= arm)) ? 1.0 : 0.0;
}
`;

/** A comet in the direction frame q (x forward): a ball of radius r at the
 *  origin and a tail of length tail tapering behind it, torn by noise that
 *  streams backwards. Returns the body value (> 0 inside). */
export const COMET = glsl`
float comet(vec2 q, float r, float tail, float t, float seed, float rough) {
  float k = clamp(-q.x / max(tail, 0.01), 0.0, 1.0);
  float n = fbm(vec2(q.x * 0.11 + t * 7.0, q.y * 0.2) + seed * 31.0);
  float head = 1.0 - length(q) / r;
  float rt = r * (1.0 - k) * 0.95;
  float body = q.x < 0.0 ? (1.0 - abs(q.y) / max(rt, 0.01)) * (1.0 - k) : -1.0;
  return max(head + (n - 0.5) * 0.3 * rough, body + (n - 0.5) * 0.6 * rough - k * 0.2);
}
`;

/** Particles flowing along a segment from a to b (px) over time: returns the
 *  particle's progress 0..1 where one is, else -1. Motes wiggle across the
 *  segment by up to amp px. */
export const FLOW = glsl`
float flow(vec2 p, vec2 a, vec2 b, float n, float speed, float amp, float t, float seed) {
  vec2 ab = b - a; float L = length(ab); vec2 u = ab / max(L, 0.01); vec2 nn = vec2(-u.y, u.x);
  float best = -1.0;
  for (int i = 0; i < 24; i++) {
    if (float(i) >= n) break;
    vec3 h = hash31(float(i) * 3.17 + seed * 7.0);
    float k = fract(t * speed * (0.8 + 0.4 * h.x) + h.y);
    float off = sin(k * PI) * amp * (h.z - 0.5) * 2.0 + sin(k * 12.0 + h.x * 9.0) * 1.2;
    vec2 at = a + u * (k * L) + nn * off;
    if (length(p - at) < 0.85 + 0.6 * step(0.7, h.z)) best = k;
  }
  return best;
}
`;

/** Soft cloud puffs around the origin: density 0..1. R = cloud radius px. */
export const CLOUD = glsl`
float cloud(vec2 p, float R, float t, float seed) {
  float n = fbm(p / (R * 0.5) + vec2(seed * 5.0, t * 0.35));
  float n2 = fbm(p / (R * 0.25) - vec2(t * 0.5, seed * 3.0));
  float d = length(p * vec2(1.0, 1.4)) / R;
  return clamp((1.0 - d) * 1.2 + (n - 0.5) * 1.1 + (n2 - 0.5) * 0.4, 0.0, 1.0);
}
`;
