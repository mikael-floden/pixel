import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { BOLT, SPARKS } from "../_shared/snippets.js";

const cols = (s) => ({ uCore: rgb(s.tune.core), uGlow: rgb(s.tune.glow), uDeep: rgb(s.tune.deep) });
const SKY = (s) => lv(s, 190, 260);

// three strokes: the strike, a re-strike, and (from level 5) a last flicker
const PULSES = glsl`
float pulse(float t, float third) {
  return step(t, 0.07) + step(0.11, t) * step(t, 0.17) + third * step(0.24, t) * step(t, 0.29);
}
`;

export default defineEffect({
  id: "storm/lightning_strike",
  name: "Lightning Strike",
  kind: "burst",
  volley: ["rain", "line", "ring"],
  family: "storm",
  category: "attack",
  tags: ["damage", "single target", "instant", "stun"],
  demo: { on: "target" },
  thinking: `Lightning is the one effect that must feel instant, so it has no travel at all: the bolt is simply there on frame one, from far above the top of the screen down to the target's feet. What sells it is rhythm, not size. A real strike is a stroke, a dark gap and a re-strike, so the bolt is drawn in two or three hard pulses and each pulse is a NEW jagged path (the random seed steps with time instead of wobbling, which reads as lightning rather than a snake). The core is pure white and one pixel wide, the glow is a dithered blue fringe, and a big but short flash lights the whole area through the light slot: at night the world blinks white. On the ground the strike leaves a burst of light, crawling forks of current along the ground and a scorch that fades.`,
  levels: `1-3: one thin bolt, two strokes, a small ground flash. 4-6: side branches, sparks, forked current along the ground. 7-9: a thicker bolt, a third stroke and a bigger ground burst. 10: a massive bolt with many branches and a scorch that smoulders with sparks.`,
  tune: {
    core: { type: "color", def: "#ffffff", label: "Core" },
    glow: { type: "color", def: "#8fb8ff", label: "Glow" },
    deep: { type: "color", def: "#5b4bd6", label: "Deep glow" },
  },
  dur: 0.75,
  peakAt: 0.02,
  light: (s) => {
    const t = s.t;
    const on = t < 0.07 || (t > 0.11 && t < 0.17) || (s.level >= 5 && t > 0.24 && t < 0.29) ? 1 : 0.15 * Math.max(0, 1 - t / 0.6);
    return { color: [0.78, 0.86, 1.0], radius: lv(s, 4, 7), intensity: 2.6 * on, flicker: 1 };
  },
  layers: [
    {
      id: "bolt",
      dur: 0.32,
      box: (s) => box.column(lv(s, 60, 90), SKY(s) + 10, 6),
      u: (s) => ({ ...cols(s), uH: SKY(s), uW: lv(s, 1.1, 2.6), uBr: tier(s, 4) * Math.round(lv(s, 1, 4)), uThird: tier(s, 5) }),
      frag: glsl`
uniform float uH, uW, uBr, uThird; uniform vec3 uCore, uGlow, uDeep;
${BOLT}
${PULSES}
vec4 effect(vec2 p) {
  float on = pulse(uTime, uThird);
  if (on < 0.5) return vec4(0.0);
  float tq = floor(uTime / 0.055);
  vec2 top = vec2((hash11(uSeed * 7.0 + tq) - 0.5) * 60.0, uH);
  float d = bolt(p, top, vec2(0.0, 0.0), 14.0, 15.0, tq, uSeed);
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uBr) break;
    vec3 h = hash31(float(i) * 3.3 + tq * 1.7 + uSeed * 5.0);
    vec2 a = mix(top, vec2(0.0), 0.2 + 0.5 * h.x);
    vec2 b = a + vec2((h.y - 0.5) * 110.0, -30.0 - 45.0 * h.z);
    d = min(d, bolt(p, a, b, 6.0, 8.0, tq + 7.0, uSeed + float(i)) + 0.5);
  }
  float core = step(d, 0.75 * uW);
  float g1 = fall(d, 4.0 * uW), g2 = fall(d, 11.0 * uW) * 0.55;
  vec4 c = hot(uCore, core);
  c += glow(uGlow * dglow(g1, p) + uDeep * dglow(g2, p)) * (1.0 - core);
  return c;
}`,
    },
    {
      id: "flash",
      plane: "air",
      dur: 0.3,
      box: (s) => box.rect(lv(s, 90, 140), lv(s, 60, 90), 0.5, 0.3),
      u: (s) => ({ ...cols(s), uR: lv(s, 40, 64) }),
      frag: glsl`
uniform float uR; uniform vec3 uCore, uGlow, uDeep;
${PULSES}
vec4 effect(vec2 p) {
  float on = pulse(uTime, 1.0);
  float f = fall(length(p * vec2(1.0, 1.6)), uR) * on * (1.0 - uLife);
  return glow(mix(uGlow, uCore, 0.5) * dglow(f * 0.45, p));
}`,
    },
    {
      id: "burst",
      plane: "ground",
      dur: 0.6,
      box: (s) => box.ground(s, lv(s, 1.0, 1.9)),
      u: (s) => ({ ...cols(s), uR: lv(s, 1.0, 1.9), uForks: tier(s, 4) * Math.round(lv(s, 3, 7)) }),
      frag: glsl`
uniform float uR, uForks; uniform vec3 uCore, uGlow, uDeep;
${BOLT}
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float r = length(g);
  float L = uLife;
  float disk = fall(r, uR * (0.35 + 0.35 * L)) * (1.0 - L);
  float d = 9.0;
  float tq = floor(uTime / 0.07);
  for (int i = 0; i < 7; i++) {
    if (float(i) >= uForks) break;
    float th = (float(i) + hash11(float(i) + uSeed * 3.0) * 0.8) / max(uForks, 1.0) * TAU;
    vec2 e = vec2(cos(th), sin(th)) * uR * (0.65 + 0.35 * hash11(float(i) * 1.7 + uSeed));
    d = min(d, bolt(g, vec2(0.0), e * min(1.0, L * 5.0), 5.0, 0.16, tq, uSeed + float(i)));
  }
  float fork = step(d, 0.035) * (1.0 - smoothstep(0.25, 0.6, L));
  vec4 c = hot(uCore, cut(disk, 0.5, p));
  c = over(hot(mix(uGlow, uCore, 0.4), fork), c);
  c += glow(uGlow * dglow(disk * 0.9, p)) * (1.0 - c.a);
  return c;
}`,
    },
    {
      id: "scorch",
      plane: "ground",
      emissive: false,
      dur: 1.8,
      box: (s) => box.ground(s, lv(s, 0.45, 0.9)),
      u: (s) => ({ uR: lv(s, 0.45, 0.9) }),
      frag: glsl`
uniform float uR;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float n = fbm(g * 3.0 + uSeed * 4.0);
  float d = length(g) / uR + (n - 0.5) * 0.8;
  float a = (1.0 - smoothstep(0.5, 1.0, d)) * (1.0 - smoothstep(0.5, 1.0, uLife));
  return paint(vec3(0.07, 0.07, 0.09), cut(a, 0.45, p) * 0.7);
}`,
    },
    {
      id: "sparks",
      dur: 0.7,
      when: (s) => s.level >= 4,
      box: (s) => box.around(lv(s, 40, 70)),
      u: (s) => ({ ...cols(s), uN: Math.round(lv(s, 8, 22)), uV: lv(s, 90, 150) }),
      frag: glsl`
uniform float uN, uV; uniform vec3 uCore, uGlow, uDeep;
${SPARKS}
vec4 effect(vec2 p) {
  float sp = sparks(p, uTime, uN, uV, 260.0, 0.85, uSeed);
  return sp > 0.0 ? hot(mix(uGlow, uCore, sp), 1.0) : vec4(0.0);
}`,
    },
  ],
});
