import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";

const cols = (s) => ({ uLight: rgb(s.tune.light), uLifeC: rgb(s.tune.life), uDeep: rgb(s.tune.deep) });

// Motes spiralling up around a body: back half behind it, front half over it.
const MOTES = glsl`
uniform float uN, uRx, uH, uHalf; uniform vec3 uLight, uLifeC, uDeep;
vec4 effect(vec2 p) {
  vec4 c = vec4(0.0);
  for (int i = 0; i < 30; i++) {
    if (float(i) >= uN) break;
    vec3 h = hash31(float(i) * 4.7 + uSeed * 21.0);
    float t = (uLife - h.x * 0.35) / 0.65;
    if (t < 0.0 || t > 1.0) continue;
    float th = h.y * TAU + t * (2.5 + 2.0 * h.z);
    float side = sin(th);
    if (side * uHalf < 0.0) continue;
    float rr = uRx * (1.0 - 0.45 * t) * (0.7 + 0.3 * h.z);
    vec2 at = vec2(cos(th) * rr, side * rr * 0.42 + t * uH * (0.8 + 0.3 * h.y));
    vec2 q = abs(p - at);
    float big = step(0.62, h.z);
    float tw = step(0.45, fract(uTime * 6.0 + h.y * 3.0));
    float on = big > 0.5 ? (((q.x < 0.6 && q.y < 1.6 + tw) || (q.y < 0.6 && q.x < 1.6 + tw)) ? 1.0 : 0.0) : step(max(q.x, q.y), 0.6);
    vec3 col = mix(uLifeC, uLight, big * 0.7 + 0.3 * (1.0 - t));
    c = over(hot(col, on * step(t, 0.92 + 0.08 * h.x)), c);
  }
  return c;
}`;

export default defineEffect({
  id: "holy/heal",
  name: "Heal",
  kind: "burst",
  family: "holy",
  category: "heal",
  tags: ["heal", "single target", "support"],
  demo: { on: "caster" },
  thinking: `Healing has to read as the opposite of damage at a glance: nothing flies at the body, everything rises out of it. Warm gold over a living green says "life" without a word, and the motion is upward and gentle where an attack is fast and inward. Three things carry it: a soft column of light around the body that fades from the feet up, motes that spiral up around the body (half of them pass BEHIND it and half in front, so it wraps around the target instead of sitting on it like a sticker), and a thin rune ring on the ground that says a spell happened here. The few bright motes are four-point twinkles, the classic pixel sparkle. Levels add abundance, not violence.`,
  levels: `1-3: a faint column and a handful of motes. 4-6: more motes, twinkling stars and the rune ring. 7-9: a taller, brighter column and a second ring. 10: a halo crowns the target as the light peaks.`,
  tune: {
    light: { type: "color", def: "#fff0a8", label: "Light" },
    life: { type: "color", def: "#86e07a", label: "Life" },
    deep: { type: "color", def: "#2f9e62", label: "Deep" },
  },
  dur: (s) => lv(s, 1.1, 1.5),
  peakAt: 0.35,
  light: (s) => ({ color: [0.95, 0.95, 0.55], radius: lv(s, 2, 3.5), intensity: 1.1 * Math.sin(Math.min(1, s.life) * Math.PI) }),
  layers: [
    {
      id: "ring",
      plane: "ground",
      when: (s) => s.level >= 4,
      box: (s) => box.ground(s, lv(s, 0.8, 1.2)),
      u: (s) => ({ ...cols(s), uR: lv(s, 0.75, 1.1), uTwo: tier(s, 7) }),
      frag: glsl`
uniform float uR, uTwo; uniform vec3 uLight, uLifeC, uDeep;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float r = length(g);
  float grow = 0.75 + 0.25 * smoothstep(0.0, 0.3, uLife);
  float R = uR * grow;
  float fade = 1.0 - smoothstep(0.55, 1.0, uLife);
  float a = ang01(g);
  float ring = step(abs(r - R), 0.045);
  float inner = uTwo * step(abs(r - R * 0.78), 0.03);
  float ticks = step(abs(r - R * 0.89), 0.05) * step(0.8, fract(a * 16.0 + uTime * 0.3));
  float on = max(max(ring, inner), ticks) * fade;
  float fill = fall(r, R) * 0.35 * fade;
  vec4 c = hot(mix(uLifeC, uLight, 0.5 + 0.5 * ring), on);
  c += glow(uLifeC * dglow(fill, p)) * (1.0 - on);
  return c;
}`,
    },
    {
      id: "column",
      box: (s) => box.column(s.height * 0.42, s.height * lv(s, 1.15, 1.6), 6),
      u: (s) => ({ ...cols(s), uW: s.height * 0.3, uH: s.height * lv(s, 1.1, 1.55) }),
      frag: glsl`
uniform float uW, uH; uniform vec3 uLight, uLifeC, uDeep;
vec4 effect(vec2 p) {
  float env = sin(clamp(uLife, 0.0, 1.0) * PI);
  float y = p.y / uH;
  if (y < -0.05 || y > 1.0) return vec4(0.0);
  float w = uW * (1.0 - 0.35 * y) * (0.75 + 0.25 * env);
  float x = abs(p.x) / w;
  float shaft = fall(x, 1.0) * (1.0 - y) * env;
  float rays = step(0.82, fract(p.x * 0.18 + uTime * 0.6)) * fall(x, 1.0) * (1.0 - y) * env;
  float v = shaft * 0.7 + rays * 0.35;
  return glow(mix(uLifeC, uLight, qz(v, p)) * dglow(v, p));
}`,
    },
    { id: "motes_back", sort: () => -0.3, box: (s) => box.column(s.height * 0.5, s.height * 1.4, 10), u: (s) => ({ ...cols(s), uN: Math.round(lv(s, 6, 26)), uRx: s.height * 0.32, uH: s.height * 1.15, uHalf: 1 }), frag: MOTES },
    { id: "motes_front", sort: () => 0.3, box: (s) => box.column(s.height * 0.5, s.height * 1.4, 10), u: (s) => ({ ...cols(s), uN: Math.round(lv(s, 6, 26)), uRx: s.height * 0.32, uH: s.height * 1.15, uHalf: -1 }), frag: MOTES },
    {
      id: "halo",
      plane: "air",
      delay: 0.25,
      dur: 1.0,
      when: (s) => s.level >= 10,
      offset: (s) => [0, s.height * 1.08],
      box: (s) => box.rect(s.height * 0.5, 16),
      u: (s) => ({ ...cols(s), uR: s.height * 0.16 }),
      frag: glsl`
uniform float uR; uniform vec3 uLight, uLifeC, uDeep;
vec4 effect(vec2 p) {
  float env = sin(clamp(uLife, 0.0, 1.0) * PI);
  float d = abs(length(p * vec2(1.0, 3.2)) - uR);
  float ring = step(d, 1.1) * env;
  return hot(uLight, ring) + glow(uLight * dglow(fall(d, 5.0) * 0.6 * env, p)) * (1.0 - ring);
}`,
    },
  ],
});
