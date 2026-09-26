import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { SPARKS } from "../_shared/snippets.js";

const cols = (s) => ({ uWhite: rgb(s.tune.white), uGold: rgb(s.tune.gold), uDeep: rgb(s.tune.deep) });
const SKY = (s) => lv(s, 170, 240);

export default defineEffect({
  id: "holy/smite",
  name: "Smite",
  kind: "burst",
  volley: ["rain", "ring"],
  family: "holy",
  category: "attack",
  tags: ["damage", "single target", "instant", "holy", "undead bane"],
  dur: (s) => lv(s, 0.8, 1.1),
  peakAt: 0.06,
  demo: { on: "target" },
  thinking: `Smite is judgement from above, so its shape is a pillar: a column of light that slams down onto the target from beyond the top of the screen. It arrives as a hair-thin line and blows open to full width in a few frames (the anticipation-then-impact rhythm that makes a hit feel heavy), holds for a beat, and then drains away upward, leaving the ground ringing: a flash disk, a ring that races out, and sun rays drawn flat on the floor. Everything is white and gold with hard edges; holy light should look clean where shadow looks smoky. The light slot is a big warm flash, the moment the whole area is lit by heaven.`,
  levels: `1-3: a narrow column and a ground flash. 4-6: a wider column, sun rays on the ground, sparks. 7-9: a blinding column and a second, wider ring. 10: a pillar of heaven with a crown of rays.`,
  tune: {
    white: { type: "color", def: "#fffdf0", label: "Core" },
    gold: { type: "color", def: "#ffd66b", label: "Gold" },
    deep: { type: "color", def: "#d9912b", label: "Deep gold" },
  },
  light: (s) => {
    const k = s.t < 0.08 ? s.t / 0.08 : Math.max(0, 1 - (s.t - 0.08) / 0.7);
    return { color: [1.0, 0.92, 0.6], radius: lv(s, 3, 5.5), intensity: 2.2 * k };
  },
  layers: [
    {
      id: "pillar",
      dur: (s) => lv(s, 0.55, 0.8),
      box: (s) => box.column(lv(s, 16, 32) + 4, SKY(s), 8),
      u: (s) => ({ ...cols(s), uW: lv(s, 9, 22), uH: SKY(s) }),
      frag: glsl`
uniform float uW, uH; uniform vec3 uWhite, uGold, uDeep;
vec4 effect(vec2 p) {
  float L = uLife;
  float open = smoothstep(0.0, 0.12, L);
  float drain = smoothstep(0.35, 1.0, L);
  if (p.y < -6.0 || p.y > uH || p.y < uH * drain - 6.0) return vec4(0.0);
  float w = uW * mix(0.08, 1.0, open) * (1.0 - 0.5 * drain) * (0.92 + 0.08 * sin(uTime * 40.0 + p.y * 0.1));
  float x = abs(p.x) / max(w, 0.5);
  float rays = step(0.75, fract(p.y * 0.04 - uTime * 3.0 + hash11(floor(p.x * 0.5) + uSeed * 9.0)));
  vec4 c = vec4(0.0);
  if (x < 1.0) {
    vec3 col = x < 0.3 ? uWhite : (x < 0.7 ? uGold : uDeep);
    c = hot(mix(col, uWhite, rays * 0.5), 1.0);
  }
  c += glow(uGold * dglow(fall(abs(p.x), w * 2.2) * 0.6 * (1.0 - drain), p)) * (1.0 - c.a);
  return c;
}`,
    },
    {
      id: "ground",
      plane: "ground",
      box: (s) => box.ground(s, lv(s, 1.2, 2.6)),
      u: (s) => ({ ...cols(s), uR: lv(s, 1.2, 2.6), uRays: tier(s, 4), uTwo: tier(s, 7) }),
      frag: glsl`
uniform float uR, uRays, uTwo; uniform vec3 uWhite, uGold, uDeep;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float r = length(g);
  float L = uLife;
  float disk = fall(r, uR * 0.45) * (1.0 - smoothstep(0.1, 0.6, L));
  float ring = step(ringPx(g, uR * (1.0 - pow(1.0 - L, 2.4))), 1.2) * (1.0 - L);
  float ring2 = uTwo * step(ringPx(g, uR * 0.62 * (1.0 - pow(1.0 - clamp(L * 1.3 - 0.15, 0.0, 1.0), 2.4))), 1.0) * (1.0 - L) * step(0.12, L);
  float a = ang01(g);
  float ray = uRays * step(0.86, fract(a * 16.0 + uSeed)) * step(r, uR * 0.95 * min(1.0, L * 4.0)) * step(uR * 0.25, r) * (1.0 - smoothstep(0.3, 0.8, L));
  vec4 c = hot(uWhite, cut(disk, 0.45, p));
  c = over(hot(uGold, max(max(ring, ring2), ray)), c);
  c += glow(uGold * dglow(disk * 0.8, p)) * (1.0 - c.a);
  return c;
}`,
    },
    {
      id: "sparks",
      delay: 0.05,
      dur: 0.8,
      when: (s) => s.level >= 4,
      box: (s) => box.column(lv(s, 40, 64), lv(s, 60, 90), 10),
      u: (s) => ({ ...cols(s), uN: Math.round(lv(s, 8, 20)) }),
      frag: glsl`
uniform float uN; uniform vec3 uWhite, uGold, uDeep;
${SPARKS}
vec4 effect(vec2 p) {
  float sp = sparks(p, uTime, uN, 100.0, 120.0, 0.9, uSeed);
  return sp > 0.0 ? hot(mix(uGold, uWhite, sp), 1.0) : vec4(0.0);
}`,
    },
  ],
});
