import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { SMOKE } from "../_shared/snippets.js";

const cols = (s) => ({ uLine: rgb(s.tune.line), uGlowC: rgb(s.tune.glow), uDeep: rgb(s.tune.deep), uSmoke: rgb(s.tune.smoke) });

// Smoke puffs rolling out from the feet and rising: round, lit from above.
const PUFFS = glsl`
uniform float uR, uSpread; uniform vec3 uLine, uGlowC, uDeep, uSmoke;
vec4 effect(vec2 p) {
  float L = uLife;
  float best = 0.0, shade = 0.0;
  for (int i = 0; i < 9; i++) {
    vec3 h = hash31(float(i) * 3.7 + uSeed * 5.0);
    float side = (h.x - 0.5) * 2.0;
    float out_ = 1.0 - pow(1.0 - L, 2.2);
    vec2 at = vec2(side * uSpread * out_, uR * 0.6 + L * uR * (1.0 + 2.0 * h.y));
    float r = uR * (0.6 + 0.6 * h.z) * (0.7 + 0.6 * L);
    vec2 q = (p - at) / r;
    float n = vnoise(q * 1.7 + h.xy * 9.0 + uTime * 0.6);
    float v = 1.0 - length(q) + (n - 0.5) * 0.5;
    if (v > best) { best = v; shade = q.y; }
  }
  best *= 1.0 - smoothstep(0.55, 1.0, L);
  vec3 col = shade > 0.35 ? uSmoke * 1.5 : (shade > -0.3 ? uSmoke * 1.1 : uSmoke * 0.75);
  return paint(col, cut(best, 0.05, p) * 0.92);
}`;

export default defineEffect({
  id: "summon/summon_arrival",
  name: "Summon Arrival",
  kind: "burst",
  family: "summon",
  category: "summon",
  tags: ["summon", "spawn", "appear"],
  dur: 1.2,
  peakAt: 0.12,
  demo: { on: "target" },
  thinking: `The moment a summoned creature steps into the world. The problem it solves is the pop-in: a sprite that simply appears looks like a bug. So a column of blue-white light erupts from the ground where it will stand and a ring of smoke bursts out around its feet, and the game spawns the creature on the "peak" event, when the column is widest and the smoke is thickest, so the creature is revealed by the light draining away rather than popping in. The column scales with the creature's height (pass the summon's height), so a summoned dragon arrives in a bigger pillar than a summoned wolf.`,
  levels: `1-3: a quick pillar and a puff of smoke. 4-6: a taller pillar and a rolling smoke ring. 7-9: a blinding pillar. 10: a pillar that rises past the screen, and heavy smoke.`,
  tune: {
    line: { type: "color", def: "#eef2ff", label: "Core" },
    glow: { type: "color", def: "#7d8fe8", label: "Glow" },
    deep: { type: "color", def: "#3a3aa8", label: "Deep" },
    smoke: { type: "color", def: "#6a6a82", label: "Smoke" },
  },
  light: (s) => ({ color: [0.65, 0.7, 1.0], radius: lv(s, 2.4, 4), intensity: 1.8 * Math.max(0, 1 - s.t / 0.9) }),
  layers: [
    {
      id: "smoke_back",
      emissive: false,
      sort: () => -0.5,
      dur: 1.1,
      box: (s) => box.column(s.height * 0.8, s.height * 1.15, 10),
      u: (s) => ({ ...cols(s), uR: s.height * lv(s, 0.18, 0.26), uSpread: s.height * lv(s, 0.4, 0.6) }),
      frag: PUFFS,
    },
    {
      id: "pillar",
      dur: 0.85,
      box: (s) => box.column(s.height * 0.45, s.height * lv(s, 1.6, 2.8), 6),
      u: (s) => ({ ...cols(s), uW: s.height * lv(s, 0.18, 0.3), uH: s.height * lv(s, 1.6, 2.8) }),
      frag: glsl`
uniform float uW, uH; uniform vec3 uLine, uGlowC, uDeep, uSmoke;
vec4 effect(vec2 p) {
  float L = uLife;
  float top = uH * smoothstep(0.0, 0.12, L);
  float thin = 1.0 - smoothstep(0.2, 1.0, L);
  if (p.y < -3.0 || p.y > top) return vec4(0.0);
  float w = uW * thin * (0.96 + 0.04 * sin(uTime * 24.0 + p.y * 0.15));
  float x = abs(p.x) / max(w, 0.5);
  if (x > 1.6) return vec4(0.0);
  vec3 col = x < 0.35 ? uLine : (x < 0.75 ? uGlowC : uDeep);
  vec4 c = x < 1.0 ? hot(col, 1.0) : vec4(0.0);
  return c + glow(uGlowC * dglow(fall(x, 1.6) * 0.6, p)) * (1.0 - c.a);
}`,
    },
    {
      id: "ring",
      plane: "ground",
      dur: 0.6,
      box: (s) => box.ground(s, lv(s, 1.0, 1.7)),
      u: (s) => ({ ...cols(s), uR: lv(s, 1.0, 1.7) }),
      frag: glsl`
uniform float uR; uniform vec3 uLine, uGlowC, uDeep, uSmoke;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float on = step(ringPx(g, uR * (1.0 - pow(1.0 - uLife, 2.5))), 1.2) * (1.0 - uLife);
  return hot(uLine, on);
}`,
    },
    {
      id: "smoke_front",
      emissive: false,
      sort: () => 0.5,
      delay: 0.05,
      dur: 1.1,
      when: (s) => s.level >= 4,
      box: (s) => box.column(s.height * 0.85, s.height * 0.9, 10),
      u: (s) => ({ ...cols(s), uR: s.height * lv(s, 0.14, 0.2), uSpread: s.height * lv(s, 0.45, 0.7) }),
      frag: PUFFS,
    },
  ],
});
