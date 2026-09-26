import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { SPARKS } from "../_shared/snippets.js";

const cols = (s) => ({ uCore: rgb(s.tune.core), uMid: rgb(s.tune.mid), uDeep: rgb(s.tune.deep) });

// A body-sized slit of light: OPENING (appear) or CLOSING (vanish).
const RIFT = glsl`
uniform float uW, uH, uOpen; uniform vec3 uCore, uMid, uDeep;
${SPARKS}
vec4 effect(vec2 p) {
  float L = uLife;
  float k = uOpen > 0.5 ? L : 1.0 - L;
  float wide = sin(clamp(k, 0.0, 1.0) * PI);
  float w = max(uW * wide, 0.5);
  float hh = uH * 0.55 * (0.35 + 0.65 * wide);
  vec2 c0 = p - vec2(0.0, uH * 0.5);
  float d = length(c0 / vec2(w, hh));
  vec4 c = vec4(0.0);
  float edgePx = abs(d - 1.0) * min(w, hh);
  float rim = step(edgePx, 0.9) * step(0.12, wide);
  float core = step(abs(c0.x), 0.6 + wide * 1.4) * step(abs(c0.y), hh * 0.9);
  c = hot(uCore, core);
  c = over(hot(uMid, rim), c);
  c += glow(mix(uDeep, uMid, 0.5) * dglow(fall(d, 1.25) * 0.75 * wide, p)) * (1.0 - c.a);
  float sp = sparks(c0, uTime, 14.0, 90.0, 40.0, 0.5, uSeed + uOpen);
  if (sp > 0.0) c = over(hot(mix(uMid, uCore, sp), 1.0), c);
  return c;
}`;

export default defineEffect({
  id: "arcane/blink",
  name: "Blink",
  kind: "burst",
  family: "arcane",
  category: "utility",
  tags: ["teleport", "mobility", "escape"],
  dur: 0.7,
  peakAt: 0.14,
  demo: { dest: "free", move: true },
  thinking: `A blink is two moments and a promise that they are connected. At the old spot the body folds into a vertical slit of violet light that snaps shut, throwing off sparks; at the new spot the same slit tears open and lets the body out, with a ring on the ground to mark the landing. The slits are body-sized so the eye reads "the person went into that and came out of this". The game moves the body on the "peak" event, which lands while both slits are open, so there is never a frame where the hero is simply missing or doubled. From level 7 a streak of sparks connects the two points, so the path can be followed in a crowd.`,
  levels: `1-3: two quick slits. 4-6: brighter slits and a landing ring. 7-9: a spark streak joins the two points. 10: a wide rift and a bright landing flash.`,
  tune: {
    core: { type: "color", def: "#ffffff", label: "Core" },
    mid: { type: "color", def: "#c58bff", label: "Rift" },
    deep: { type: "color", def: "#6a35d6", label: "Rift edge" },
  },
  light: (s) => ({ color: [0.75, 0.5, 1.0], radius: 2.2, intensity: 1.0 * Math.max(0, 1 - s.t / 0.6), at: s.t < 0.14 ? "from" : "at" }),
  layers: [
    {
      id: "vanish",
      at: "from",
      lift: "ground",
      dur: 0.3,
      box: (s) => box.column(s.height * 0.5, s.height * 1.2, 6),
      u: (s) => ({ ...cols(s), uW: s.height * lv(s, 0.2, 0.3), uH: s.height, uOpen: 0 }),
      frag: RIFT,
    },
    {
      id: "appear",
      delay: 0.1,
      dur: 0.42,
      box: (s) => box.column(s.height * 0.5, s.height * 1.2, 6),
      u: (s) => ({ ...cols(s), uW: s.height * lv(s, 0.2, 0.3), uH: s.height, uOpen: 1 }),
      frag: RIFT,
    },
    {
      id: "land",
      plane: "ground",
      delay: 0.14,
      dur: 0.45,
      when: (s) => s.level >= 4,
      box: (s) => box.ground(s, lv(s, 0.8, 1.3)),
      u: (s) => ({ ...cols(s), uR: lv(s, 0.8, 1.3) }),
      frag: glsl`
uniform float uR; uniform vec3 uCore, uMid, uDeep;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float ring = step(ringPx(g, uR * (0.3 + 0.7 * uLife)), 1.1) * (1.0 - uLife);
  return hot(uMid, ring) + glow(uMid * dglow(fall(length(g), uR * 0.6) * (1.0 - uLife) * 0.6, p)) * (1.0 - ring);
}`,
    },
    {
      id: "streak",
      at: "from",
      dur: 0.45,
      when: (s) => s.level >= 7,
      box: (s) => box.beam(s, 10, 6),
      u: (s) => ({ ...cols(s), uH: s.height * 0.55 }),
      frag: glsl`
uniform float uH; uniform vec3 uCore, uMid, uDeep;
vec4 effect(vec2 p) {
  vec2 q = along(p);
  if (q.x < 0.0 || q.x > uLen) return vec4(0.0);
  float k = q.x / max(uLen, 1.0);
  float show = step(k, uLife * 3.0) * step(uLife * 1.6 - 0.35, k);
  float lane = abs(q.y - sin(k * 18.0 + uTime * 30.0) * 2.0);
  float dots = step(0.55, hash12(floor(q) + floor(uTime * 20.0)));
  return hot(mix(uMid, uCore, dots), step(lane, 0.8) * show * dots);
}`,
    },
  ],
});
