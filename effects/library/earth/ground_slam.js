import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { BOLT } from "../_shared/snippets.js";

const cols = (s) => ({ uDust: rgb(s.tune.dust), uRock: rgb(s.tune.rock), uCrack: rgb(s.tune.crack) });
const R = (s) => s.radius;

// rocks flung up from the ring: back half / front half of the slam
const DEBRIS = glsl`
uniform float uR, uN, uHalf; uniform vec4 uB; uniform vec3 uDust, uRock, uCrack;
vec4 effect(vec2 p) {
  vec4 c = vec4(0.0);
  for (int i = 0; i < 22; i++) {
    if (float(i) >= uN) break;
    vec3 h = hash31(float(i) * 8.3 + uSeed * 11.0);
    float th = h.x * TAU;
    vec2 g = vec2(cos(th), sin(th)) * uR * (0.25 + 0.6 * h.y);
    vec2 base = vec2(g.x * uB.x + g.y * uB.z, -(g.x * uB.y + g.y * uB.w));
    if (base.y * uHalf < 0.0) continue;
    float t = uTime - 0.03 * h.z;
    if (t < 0.0) continue;
    float vy = 70.0 + 110.0 * h.z, vx = (h.y - 0.5) * 60.0 + base.x * 0.8;
    vec2 at = base + vec2(vx * t, vy * t - 300.0 * t * t);
    if (at.y < base.y - 1.0) continue;
    vec2 q = floor(p - at + 0.5);
    float sz = 1.0 + floor(h.y * 2.5);
    float rx = sz, ry = max(1.0, sz - 1.0);
    if (abs(q.x) <= rx + 1.0 && abs(q.y) <= ry + 1.0) {
      bool inner = abs(q.x) <= rx && abs(q.y) <= ry;
      vec3 col = inner ? (q.y >= ry - 0.5 || q.x <= -rx + 0.5 ? uDust * 1.25 : uRock) : uCrack;
      c = over(paint(col, 1.0), c);
    }
  }
  return c;
}`;

export default defineEffect({
  id: "earth/ground_slam",
  name: "Ground Slam",
  kind: "burst",
  family: "earth",
  category: "attack",
  tags: ["aoe", "physical", "stun", "monster", "self-centered"],
  radius: (s) => lv(s, 1.3, 2.6),
  demo: { on: "caster" },
  dur: (s) => lv(s, 1.3, 1.9),
  peakAt: 0.02,
  thinking: `A slam is weight, and weight is shown by what the ground does, not by light. So this effect is almost entirely NON-emissive: dust, rock and cracks that the night darkens like any other part of the world. It works for a troll's club, a golem's fists or a warrior's leap. On the first frame the cracks shoot out from the point of impact (jagged lines in ground space, so they lie flat on the iso floor), a ring of dust races out to the attack's radius, rocks are flung up and fall back under gravity, and a low dust cloud rolls and settles. Nothing glows, which is exactly why it reads as physical next to the spells.`,
  levels: `1-3: short cracks and a dust ring. 4-6: longer cracks, flying rocks, a rolling dust cloud. 7-9: a wider radius and a second shock ring. 10: a crater's worth of cracks and a storm of debris.`,
  tune: {
    dust: { type: "color", def: "#a58b68", label: "Dust" },
    rock: { type: "color", def: "#6d5f52", label: "Rock" },
    crack: { type: "color", def: "#1c1510", label: "Cracks" },
  },
  layers: [
    {
      id: "cracks",
      plane: "ground",
      emissive: false,
      fixedScale: true,
      box: (s) => box.ground(s, R(s) * 1.1),
      u: (s) => ({ ...cols(s), uR: R(s), uN: Math.round(lv(s, 5, 11)) }),
      frag: glsl`
uniform float uR, uN; uniform vec3 uDust, uRock, uCrack;
${BOLT}
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float grow = min(1.0, uLife * 9.0);
  float fade = 1.0 - smoothstep(0.65, 1.0, uLife);
  float d = 9.0;
  for (int i = 0; i < 11; i++) {
    if (float(i) >= uN) break;
    vec3 h = hash31(float(i) * 4.1 + uSeed * 7.0);
    float th = (float(i) + h.x * 0.8) / uN * TAU;
    vec2 e = vec2(cos(th), sin(th)) * uR * (0.55 + 0.5 * h.y) * grow;
    d = min(d, bolt(g, vec2(0.0), e, 5.0, 0.22, 1.0, uSeed + float(i)));
    vec2 m = e * (0.4 + 0.3 * h.z);
    vec2 b2 = m + vec2(cos(th + 0.9 * (h.x - 0.5) * 2.0), sin(th + 0.9 * (h.x - 0.5) * 2.0)) * uR * 0.35 * grow;
    d = min(d, bolt(g, m, b2, 3.0, 0.1, 2.0, uSeed + float(i) * 3.0) + 0.01);
  }
  float line = step(d, 0.028);
  float lip = step(d, 0.065) * (1.0 - line);
  float pit = fall(length(g), uR * 0.28);
  vec4 c = paint(uCrack, max(line, cut(pit, 0.4, p) * 0.8) * fade);
  c = over(c, paint(uDust * 1.15, lip * 0.6 * fade));
  return c;
}`,
    },
    {
      id: "wave",
      plane: "ground",
      emissive: false,
      fixedScale: true,
      dur: 0.55,
      box: (s) => box.ground(s, R(s) * 1.15),
      u: (s) => ({ ...cols(s), uR: R(s), uTwo: tier(s, 7) }),
      frag: glsl`
uniform float uR, uTwo; uniform vec3 uDust, uRock, uCrack;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float r = length(g);
  float n = fbm(g * 3.0 + uSeed * 3.0 + uTime * 2.0);
  float front = uR * (1.0 - pow(1.0 - uLife, 2.2));
  float band = (1.0 - smoothstep(0.0, 0.18 + 0.3 * uLife, abs(r - front) + (n - 0.5) * 0.25)) * (1.0 - uLife);
  float front2 = uR * 0.65 * (1.0 - pow(1.0 - clamp(uLife * 1.5 - 0.3, 0.0, 1.0), 2.2));
  band = max(band, uTwo * (1.0 - smoothstep(0.0, 0.14, abs(r - front2))) * (1.0 - uLife) * step(0.2, uLife));
  return paint(mix(uDust, uDust * 1.3, qz(n, p)), cut(band, 0.3, p) * 0.9);
}`,
    },
    { id: "debris_back", emissive: false, fixedScale: true, dur: 0.95, sort: (s) => -R(s), when: (s) => s.level >= 4, box: (s) => { const b = box.ground(s, R(s) * 1.2, 8); return { w: b.w + 30, h: b.h / 2 + 60, ox: b.ox + 15, oy: 2 }; }, u: (s) => ({ ...cols(s), uR: R(s), uN: Math.round(lv(s, 8, 22)), uHalf: 1, uB: s.basis }), frag: DEBRIS },
    { id: "debris_front", emissive: false, fixedScale: true, dur: 0.95, sort: (s) => R(s), when: (s) => s.level >= 4, box: (s) => { const b = box.ground(s, R(s) * 1.2, 8); return { w: b.w + 30, h: b.oy + 60, ox: b.ox + 15, oy: b.oy }; }, u: (s) => ({ ...cols(s), uR: R(s), uN: Math.round(lv(s, 8, 22)), uHalf: -1, uB: s.basis }), frag: DEBRIS },
    {
      id: "impact",
      plane: "ground",
      fixedScale: true,
      dur: 0.16,
      box: (s) => box.ground(s, R(s) * 0.6),
      u: (s) => ({ ...cols(s), uR: R(s) * 0.55 }),
      frag: glsl`
uniform float uR; uniform vec3 uDust, uRock, uCrack;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float ring = step(ringPx(g, uR * (0.3 + 0.7 * uLife)), 1.2) * (1.0 - uLife);
  float core = fall(length(g), uR * 0.5) * (1.0 - uLife);
  return hot(mix(uDust, vec3(1.0), 0.6), max(ring, cut(core, 0.5, p)) * 0.9);
}`,
    },
    ...["back", "front"].map((half) => ({
      id: `dust_${half}`,
      emissive: false,
      fixedScale: true,
      delay: 0.05,
      dur: (s) => lv(s, 1.1, 1.6),
      sort: (s) => (half === "back" ? -R(s) : R(s)),
      when: (s) => s.level >= 4,
      box: (s) => {
        const b = box.ground(s, R(s) * 1.2, 6);
        return half === "back" ? { w: b.w, h: b.h / 2 + 26, ox: b.ox, oy: 2 } : { w: b.w, h: b.oy + 26, ox: b.ox, oy: b.oy };
      },
      u: (s) => ({ ...cols(s), uR: R(s), uHalf: half === "back" ? 1 : -1 }),
      frag: glsl`
uniform float uR, uHalf; uniform vec3 uDust, uRock, uCrack;
vec4 effect(vec2 p) {
  float front = uR * 0.8 * (1.0 - pow(1.0 - min(uLife * 1.6, 1.0), 2.0));
  float h = 20.0 * (1.0 - uLife * 0.3);
  vec2 fr = normalize(gnd(vec2(0.0, -1.0)));
  float n = fbm(vec2(p.x * 0.07, p.y * 0.1 - uTime * 0.6) + uSeed * 5.0);
  float best = 0.0;
  for (int i = 0; i < 5; i++) {
    float y = h * float(i) / 4.0;
    vec2 gp = gnd(p - vec2(0.0, y));
    if (dot(gp, fr) * uHalf > 0.0) continue;
    float ring = 1.0 - smoothstep(0.0, 0.35, abs(length(gp) - front));
    best = max(best, ring * (1.0 - y / (h + 0.001)));
  }
  float dns = best * (0.6 + 0.8 * n) * (1.0 - uLife);
  return paint(mix(uDust * 0.8, uDust * 1.2, qz(n, p)), cut(dns, 0.35, p) * 0.85);
}`,
    })),
  ],
});
