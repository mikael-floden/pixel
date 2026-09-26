import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";

const cols = (s) => ({ uCore: rgb(s.tune.core), uMid: rgb(s.tune.mid), uDeep: rgb(s.tune.deep) });

export default defineEffect({
  id: "arcane/channel",
  name: "Channeling",
  kind: "aura",
  family: "arcane",
  category: "channel",
  tags: ["channel", "charge", "cast time", "wind-up"],
  intro: 0.2,
  outro: 0.25,
  demo: { on: "caster", hold: 2.6 },
  thinking: `The cast bar made visible, for any spell with a cast time: energy is being GATHERED, so everything moves inward. Motes are drawn in from a wide ring toward the caster's hands, where an orb grows brighter the longer the channel lasts, orbited by a thin ring that spins faster and faster; a sigil circle turns on the ground. The motion reads even to someone who has never seen the spell, and because the orb keeps growing, you can see how far along the cast is. Stopping it (an interrupt) snaps everything out on the outro. Played on the caster's position; the orb sits at hand height.`,
  levels: `1-3: a small orb and a few inward motes. 4-6: a ring spins around the orb, more motes. 7-9: a turning sigil on the ground. 10: a storm of motes and a blazing orb.`,
  tune: {
    core: { type: "color", def: "#ffffff", label: "Core" },
    mid: { type: "color", def: "#b98cff", label: "Energy" },
    deep: { type: "color", def: "#5b35c9", label: "Deep" },
  },
  light: (s) => ({ color: [0.7, 0.5, 1.0], radius: lv(s, 1.4, 2.6), intensity: (0.3 + 0.6 * Math.min(1, s.T / 2.5)) * s.fade, flicker: 0.2 }),
  layers: [
    {
      id: "sigil",
      plane: "ground",
      when: (s) => s.level >= 7,
      box: (s) => box.ground(s, 0.85),
      u: (s) => ({ ...cols(s), uR: 0.75 }),
      frag: glsl`
uniform float uR; uniform vec3 uCore, uMid, uDeep;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float a = ang01(g) + uTime * 0.12;
  float ring = step(ringPx(g, uR), 0.8) + step(ringPx(g, uR * 0.7), 0.6) * step(0.5, fract(a * 12.0));
  float tri = 0.0;
  for (int i = 0; i < 3; i++) {
    float t0 = uTime * 0.12 * TAU + float(i) * TAU / 3.0;
    vec2 A = vec2(cos(t0), sin(t0)) * uR * 0.7, B = vec2(cos(t0 + TAU / 3.0), sin(t0 + TAU / 3.0)) * uR * 0.7;
    vec2 pa = g - A, ba = B - A;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    tri = max(tri, step(length(pa - ba * h), 0.03));
  }
  return hot(uMid, min(ring + tri, 1.0) * uFade * 0.9);
}`,
    },
    {
      id: "gather",
      offset: (s) => [s.height * 0.12, s.height * 0.55],
      sort: () => 0.3,
      box: (s) => box.around(s.height * 0.62),
      u: (s) => ({ ...cols(s), uN: Math.round(lv(s, 6, 22)), uR: s.height * 0.55, uOrb: lv(s, 2.5, 6), uRing: tier(s, 4), uGrow: Math.min(1, s.T / 2.5) }),
      frag: glsl`
uniform float uN, uR, uOrb, uRing, uGrow; uniform vec3 uCore, uMid, uDeep;
vec4 effect(vec2 p) {
  vec4 c = vec4(0.0);
  for (int i = 0; i < 22; i++) {
    if (float(i) >= uN) break;
    vec3 h = hash31(float(i) * 3.9 + uSeed * 6.0);
    float k = fract(uTime * (0.7 + 0.5 * h.x) + h.y);
    float th = h.z * TAU + k * 1.6;
    float rr = uR * (1.0 - k) * (0.6 + 0.4 * h.x);
    vec2 at = vec2(cos(th), sin(th) * 0.75) * rr;
    vec2 q = abs(floor(p - at + 0.5));
    float trail = step(q.x + q.y, 1.0 - step(0.5, k));
    c = over(hot(mix(uMid, uCore, k), max(trail, step(max(q.x, q.y), 0.5)) * uFade), c);
  }
  float r = uOrb * (0.6 + 0.6 * uGrow) * (0.9 + 0.1 * sin(uTime * 25.0)) * uFade;
  float d = length(p);
  c = over(hot(uCore, step(d, r * 0.5)), c);
  c = over(hot(uMid, step(d, r) * step(r * 0.5, d)), c);
  if (uRing > 0.5) {
    float spin = uTime * (4.0 + 10.0 * uGrow);
    vec2 e = rot(spin) * p;
    float ring = step(abs(length(e * vec2(1.0, 2.6)) - r * 2.2), 0.8) * step(0.0, sin(atan(e.y, e.x) * 2.0));
    c = over(hot(uMid, ring * uFade), c);
  }
  return c + glow(uDeep * dglow(fall(d, r * 3.5) * 0.6 * uFade, p)) * (1.0 - c.a);
}`,
    },
  ],
});
