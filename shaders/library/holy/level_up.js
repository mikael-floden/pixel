import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { STAR4 } from "../_shared/snippets.js";

const cols = (s) => ({ uWhite: rgb(s.tune.white), uGold: rgb(s.tune.gold), uDeep: rgb(s.tune.deep) });

const RISE = glsl`
uniform float uN, uH, uHalf; uniform vec3 uWhite, uGold, uDeep;
${STAR4}
vec4 effect(vec2 p) {
  vec4 c = vec4(0.0);
  for (int i = 0; i < 30; i++) {
    if (float(i) >= uN) break;
    vec3 h = hash31(float(i) * 2.7 + uSeed * 19.0);
    float t = (uLife - h.x * 0.4) / 0.6;
    if (t < 0.0 || t > 1.0) continue;
    float th = h.y * TAU + t * 3.0;
    float side = sin(th);
    if (side * uHalf < 0.0) continue;
    float rr = 22.0 * (0.5 + 0.5 * h.z) * (1.0 - 0.3 * t);
    vec2 at = vec2(cos(th) * rr, side * rr * 0.4 + t * uH);
    float s = star4(p, at, h.z > 0.6 ? 2.0 : (h.z > 0.3 ? 1.0 : 0.0));
    c = over(hot(mix(uGold, uWhite, h.z), s * (1.0 - smoothstep(0.8, 1.0, t))), c);
  }
  return c;
}`;

export default defineEffect({
  id: "holy/level_up",
  name: "Level Up",
  kind: "burst",
  family: "holy",
  category: "utility",
  tags: ["level up", "celebration", "reward"],
  dur: 1.8,
  peakAt: 0.1,
  demo: { on: "caster" },
  thinking: `The one effect the player earns rather than casts, so it is pure celebration and it is gold. A beam of light rises (not falls: this comes from the player, it is their power growing), rings of gold burst out along the ground one after another like a bell struck twice, and a fountain of four-point sparkles spirals up around the body, half behind and half in front. It deliberately avoids anything that looks like damage: no flash-to-white, no debris, no smoke. Here "level" is how big a milestone it is (every level, every 10th, a class milestone), so the game can make the rare ones bigger.`,
  levels: `1-3: a gold beam, one ring, a spray of sparkles. 4-6: a second ring and more sparkles. 7-9: a taller, wider beam. 10: a pillar of gold and a sparkle storm, for the milestones.`,
  tune: {
    white: { type: "color", def: "#fffbe8", label: "Core" },
    gold: { type: "color", def: "#ffd24a", label: "Gold" },
    deep: { type: "color", def: "#e08a1e", label: "Deep gold" },
  },
  light: (s) => ({ color: [1.0, 0.85, 0.4], radius: lv(s, 2.5, 4.5), intensity: 1.4 * Math.sin(Math.min(1, s.life * 1.4) * Math.PI) }),
  layers: [
    {
      id: "beam",
      dur: 1.3,
      box: (s) => box.column(s.height * lv(s, 0.34, 0.5), s.height * lv(s, 1.8, 2.6), 4),
      u: (s) => ({ ...cols(s), uW: s.height * lv(s, 0.24, 0.36), uH: s.height * lv(s, 1.8, 2.6) }),
      frag: glsl`
uniform float uW, uH; uniform vec3 uWhite, uGold, uDeep;
vec4 effect(vec2 p) {
  float L = uLife;
  float top = uH * smoothstep(0.0, 0.25, L);
  float fade = 1.0 - smoothstep(0.55, 1.0, L);
  if (p.y < -2.0 || p.y > top) return vec4(0.0);
  float y = p.y / uH;
  float w = uW * (1.0 - 0.3 * y) * (0.9 + 0.1 * sin(uTime * 25.0));
  float x = abs(p.x) / w;
  float streak = step(0.8, fract(p.y * 0.05 - uTime * 2.5 + hash11(floor(p.x / 2.0) + uSeed * 3.0)));
  float v = (1.0 - x) * (1.0 - y * 0.7) * fade;
  if (x > 1.0) v = 0.0;
  vec3 col = ramp3(uDeep, uGold, uWhite, qz(v * 1.4 + streak * 0.3, p));
  // LIGHT, not paint: the hero stays visible inside the beam
  float edge = step(0.86, x) * step(x, 1.0) * fade;
  vec4 c = glow(col * dglow(v * 0.85, p));
  c = over(hot(uGold, edge * 0.9), c);
  return c + glow(uGold * dglow(fall(abs(p.x), w * 1.8) * 0.3 * fade, p));
}`,
    },
    {
      id: "rings",
      plane: "ground",
      dur: 1.2,
      box: (s) => box.ground(s, lv(s, 1.6, 2.6)),
      u: (s) => ({ ...cols(s), uR: lv(s, 1.6, 2.6), uTwo: tier(s, 4) }),
      frag: glsl`
uniform float uR, uTwo; uniform vec3 uWhite, uGold, uDeep;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float L = uLife;
  float r1 = uR * (1.0 - pow(1.0 - min(L / 0.6, 1.0), 2.5));
  float on = step(ringPx(g, r1), 1.3) * (1.0 - smoothstep(0.3, 0.6, L));
  float L2 = clamp((L - 0.25) / 0.6, 0.0, 1.0);
  float r2 = uR * 0.8 * (1.0 - pow(1.0 - L2, 2.5));
  on = max(on, uTwo * step(ringPx(g, r2), 1.0) * step(0.001, L2) * (1.0 - L2));
  float disk = fall(length(g), uR * 0.5) * (1.0 - smoothstep(0.0, 0.5, L)) * 0.7;
  vec4 c = hot(uGold, on);
  return c + glow(uGold * dglow(disk, p)) * (1.0 - on);
}`,
    },
    { id: "rise_back", sort: () => -0.3, box: (s) => box.column(30, s.height * 1.9, 8), u: (s) => ({ ...cols(s), uN: Math.round(lv(s, 10, 30)), uH: s.height * 1.6, uHalf: 1 }), frag: RISE },
    { id: "rise_front", sort: () => 0.3, box: (s) => box.column(30, s.height * 1.9, 8), u: (s) => ({ ...cols(s), uN: Math.round(lv(s, 10, 30)), uH: s.height * 1.6, uHalf: -1 }), frag: RISE },
  ],
});
