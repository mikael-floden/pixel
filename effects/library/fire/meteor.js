import { defineEffect, lv, tier, rgb, mix3, scale3, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { SPARKS, SMOKE, SHOCK, COMET } from "../_shared/snippets.js";

const ramp = (s) => {
  const core = rgb(s.tune.core), flame = rgb(s.tune.flame), ember = rgb(s.tune.ember);
  return { uC0: scale3(ember, 0.45), uC1: ember, uC2: flame, uC3: mix3(flame, core, 0.55), uC4: core };
};
const R = (s) => s.radius; // cells: the blast radius the game hits
const LAND = 0.95; // s from cast to impact: the "peak" event
const FALL = 0.5;
const FROM = [-150, 280]; // px the meteor starts from, relative to the impact (left, up)

export default defineEffect({
  id: "fire/meteor",
  name: "Meteor",
  kind: "burst",
  family: "fire",
  category: "attack",
  tags: ["aoe", "damage", "delayed", "ultimate", "telegraphed"],
  radius: (s) => lv(s, 1.4, 2.8),
  dur: 3.2,
  peakAt: LAND,
  demo: { on: "target" },
  thinking: `The big one, so it is built as a little film in three acts. First the WARNING: a burning circle appears on the ground at exactly the blast radius, its inner ring closing toward the centre like a countdown, which is fair to the target and thrilling for the caster. Then the FALL: a flaming rock streaks in from high on the left, its tail torn by the same backward-streaming flame noise as the fireball, growing brighter as it comes. Then the IMPACT on the "peak" event (0.95 s, where the game applies damage): a white flash, a huge billowing blast, a shock ring racing out, flung rocks and embers, and a crater whose cracks glow and cool for seconds afterwards. Soot smoke stays unlit so the night swallows it.`,
  levels: `1-3: a small rock and a modest blast. 4-6: flung debris and a shock ring. 7-9: a bigger radius, a blinding blast and a glowing crater. 10: a catastrophic impact with a second shock ring.`,
  tune: {
    core: { type: "color", def: "#fff1b8", label: "Core" },
    flame: { type: "color", def: "#ff7b22", label: "Flame" },
    ember: { type: "color", def: "#b8261a", label: "Ember" },
    rock: { type: "color", def: "#3b2a22", label: "Rock" },
    soot: { type: "color", def: "#26170f", label: "Smoke" },
  },
  light: (s) => {
    const t = s.t;
    if (t < LAND - FALL) return { color: [1.0, 0.35, 0.15], radius: s.radius + 0.5, intensity: 0.35 * (t / (LAND - FALL)) };
    if (t < LAND) return { color: [1.0, 0.6, 0.25], radius: s.radius + 1.5, intensity: 0.4 + 1.2 * ((t - LAND + FALL) / FALL) };
    const k = Math.max(0, 1 - (t - LAND) / 1.4);
    return { color: [1.0, 0.62, 0.3], radius: s.radius + 3, intensity: 3.0 * k * k + 0.3 * k, flicker: 0.5 };
  },
  layers: [
    {
      id: "mark",
      plane: "ground",
      fixedScale: true,
      dur: LAND + 0.05,
      box: (s) => box.ground(s, R(s) * 1.05),
      u: (s) => ({ ...ramp(s), uR: R(s) }),
      frag: glsl`
uniform float uR; uniform vec3 uC0, uC1, uC2, uC3, uC4;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float r = length(g);
  float L = uLife;
  float blink = 0.6 + 0.4 * step(0.5, fract(uTime * (3.0 + 6.0 * L)));
  float rim = step(ringPx(g, uR), 1.2);
  float inner = step(ringPx(g, uR * (1.0 - L)), 1.0);
  float fill = fall(r, uR) * 0.25 * L;
  vec4 c = hot(mix(uC1, uC3, L), max(rim, inner) * blink);
  return c + glow(uC2 * dglow(fill * blink, p)) * (1.0 - c.a);
}`,
    },
    {
      id: "fall",
      plane: "air",
      delay: LAND - FALL,
      dur: FALL,
      box: () => ({ w: -FROM[0] + 40, h: FROM[1] + 40, ox: -FROM[0] + 20, oy: 20 }),
      u: (s) => ({ ...ramp(s), uR: lv(s, 6, 12), uFrom: FROM, uRock: rgb(s.tune.rock) }),
      frag: glsl`
uniform float uR; uniform vec2 uFrom; uniform vec3 uC0, uC1, uC2, uC3, uC4, uRock;
${COMET}
vec4 effect(vec2 p) {
  float k = uLife * uLife;
  vec2 at = uFrom * (1.0 - k);
  vec2 dir = normalize(-uFrom);
  vec2 q0 = p - at;
  vec2 q = vec2(dot(q0, dir), dot(q0, vec2(-dir.y, dir.x)));
  float tail = uR * 7.0 * (0.4 + 0.6 * uLife);
  float body = comet(q, uR * 1.15, tail, uTime, uSeed, 1.0);
  vec4 c = vec4(0.0);
  if (body > 0.0) {
    float kk = clamp(-q.x / tail, 0.0, 1.0);
    c = hot(ramp5(uC0, uC1, uC2, uC3, uC4, qz(body * 1.4 * (1.0 - kk * 0.6), p)), cut(body, 0.02, p));
  }
  float d = length(q - vec2(uR * 0.15, 0.0));
  if (d < uR * 0.7) c = paint(d < uR * 0.45 ? uRock * 1.4 : uRock, 1.0);
  c += glow(uC2 * dglow(fall(length(q), uR * 3.0) * 0.6, p)) * (1.0 - c.a);
  return c;
}`,
    },
    {
      id: "smoke",
      emissive: false,
      delay: LAND + 0.15,
      dur: 1.6,
      box: (s) => box.column(lv(s, 40, 70), lv(s, 110, 170), 20),
      u: (s) => ({ uR: lv(s, 30, 55), uSoot: rgb(s.tune.soot) }),
      frag: glsl`
uniform float uR; uniform vec3 uSoot;
${SMOKE}
vec4 effect(vec2 p) {
  float dns = smoke(p - vec2(0.0, uR * 0.3), uLife, uR, uSeed);
  float n = vnoise(p * 0.15 + uSeed * 4.0);
  return paint(uSoot * (0.8 + 0.7 * qz(n, p)), cut(dns, 0.22, p) * 0.9);
}`,
    },
    {
      id: "blast",
      delay: LAND,
      dur: (s) => lv(s, 0.7, 1.1),
      box: (s) => box.around(lv(s, 50, 90)),
      u: (s) => ({ ...ramp(s), uR: lv(s, 26, 46), uN: tier(s, 4) * lv(s, 10, 22) }),
      frag: glsl`
uniform float uR, uN; uniform vec3 uC0, uC1, uC2, uC3, uC4;
${SPARKS}
vec4 effect(vec2 p) {
  float L = uLife;
  vec2 q = p - vec2(0.0, uR * 0.35 + L * uR * 0.5);
  float grow = 1.0 - pow(1.0 - min(L / 0.3, 1.0), 3.0);
  float Rr = uR * (0.35 + 0.65 * grow);
  float d = length(q * vec2(1.0, 1.1)) / Rr;
  float a = atan(q.y, q.x);
  float n = fbm(vec2(cos(a), sin(a)) * 2.0 + vec2(uSeed * 13.0, -uTime * 1.2) + d * 1.3);
  float shape = 1.0 - d + (n - 0.5) * 0.6;
  float heat = mix(1.35, 0.2, smoothstep(0.08, 1.0, L)) * (0.55 + 0.45 * (1.0 - d));
  float burn = smoothstep(0.35, 1.0, L) * (0.75 + 0.5 * n) * (1.0 - d * 0.5);
  vec3 col = ramp5(uC0, uC1, uC2, uC3, uC4, qz(clamp(heat * (0.45 + shape), 0.0, 1.0), p));
  float cover = cut(shape - burn, 0.04, p);
  vec4 c = hot(col, cover);
  float flash = (1.0 - smoothstep(0.0, 0.08, L)) * step(length(p), uR * 0.9);
  c = over(hot(uC4, flash), c);
  c += glow(uC3 * dglow(fall(length(p), uR * 2.2) * (1.0 - smoothstep(0.0, 0.15, L)) * 0.8, p)) * (1.0 - c.a);
  c += glow(uC2 * dglow(fall(max(length(q) - Rr * 0.8, 0.0), Rr) * (1.0 - L) * 0.7, p)) * (1.0 - cover);
  float sp = sparks(p, uTime, uN, uR * 4.2, uR * 3.2, 0.75, uSeed);
  if (sp > 0.0) c = over(hot(mix(uC1, uC3, sp), 1.0), c);
  return c;
}`,
    },
    {
      id: "shock",
      plane: "ground",
      fixedScale: true,
      delay: LAND,
      dur: 0.55,
      box: (s) => box.ground(s, R(s) * 1.35),
      u: (s) => ({ ...ramp(s), uR: R(s) * 1.3, uTwo: tier(s, 10) }),
      frag: glsl`
uniform float uR, uTwo; uniform vec3 uC0, uC1, uC2, uC3, uC4;
${SHOCK}
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float r = shock(g, uLife, uR, 0.3);
  r = max(r, uTwo * shock(g, clamp(uLife * 1.4 - 0.25, 0.0, 1.0), uR * 0.75, 0.2));
  float on = cut(r, 0.35, p);
  return hot(mix(uC2, uC4, qz(r, p)), on) + glow(uC2 * dglow(r * 0.5, p)) * (1.0 - on);
}`,
    },
    {
      id: "crater",
      plane: "ground",
      fixedScale: true,
      delay: LAND,
      dur: 2.2,
      box: (s) => box.ground(s, R(s) * 0.75),
      u: (s) => ({ ...ramp(s), uR: R(s) * 0.7, uRock: rgb(s.tune.rock) }),
      frag: glsl`
uniform float uR; uniform vec3 uC0, uC1, uC2, uC3, uC4, uRock;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float n = fbm(g * 2.2 + uSeed * 5.0);
  float d = length(g) / uR + (n - 0.5) * 0.5;
  if (d > 1.0) return vec4(0.0);
  float fade = 1.0 - smoothstep(0.7, 1.0, uLife);
  vec3 v = voronoi(g * 3.2 + uSeed * 2.0);
  float crack = 1.0 - smoothstep(0.02, 0.07, v.y);
  float heat = (1.0 - uLife) * (1.0 - d);
  vec4 c = paint(uRock * (0.6 + 0.4 * d), cut(1.0 - d, 0.05, p) * fade);
  if (crack > 0.5 && heat > 0.05) c = over(hot(ramp5(uC0, uC1, uC2, uC3, uC4, qz(heat * 1.6, p)), fade), c);
  return c;
}`,
    },
  ],
});
