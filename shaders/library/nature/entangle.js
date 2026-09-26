import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";

const cols = (s) => ({ uVine: rgb(s.tune.vine), uDark: rgb(s.tune.dark), uLeaf: rgb(s.tune.leaf), uBloom: rgb(s.tune.bloom) });

// Vines rooted on a ring around the feet, curling up: back half / front half.
const VINES = glsl`
uniform float uN, uR, uH, uHalf, uLeaves, uBlooms; uniform vec4 uB;
uniform vec3 uVine, uDark, uLeaf, uBloom;
vec4 effect(vec2 p) {
  float grow = smoothstep(0.0, 0.35, uTime) * uFade;
  vec4 c = vec4(0.0);
  for (int i = 0; i < 10; i++) {
    if (float(i) >= uN) break;
    vec3 h = hash31(float(i) * 6.7 + uSeed * 13.0);
    float th = (float(i) + h.x * 0.7) / uN * TAU;
    vec2 g = vec2(cos(th), sin(th)) * uR * (0.75 + 0.35 * h.y);
    vec2 base = vec2(g.x * uB.x + g.y * uB.z, -(g.x * uB.y + g.y * uB.w));
    if (base.y * uHalf < 0.0) continue;
    float H = uH * (0.55 + 0.45 * h.z) * grow;
    vec2 q = p - base;
    if (q.y < -1.0 || q.y > H + 3.0) continue;
    float k = clamp(q.y / max(H, 1.0), 0.0, 1.0);
    // lean toward the body's centre as it climbs, and curl
    float x0 = -base.x * k * 0.7 + sin(k * 5.0 + h.x * 6.0 + uTime * 1.5) * (2.0 + 3.0 * k);
    float w = mix(3.0, 0.8, k);
    float dx = abs(q.x - x0);
    if (dx < w && q.y <= H) {
      vec3 col = dx > w - 0.9 ? uDark : uVine;
      c = over(paint(col, 1.0), c);
    }
    // leaves: little diamonds alternating sides
    if (uLeaves > 0.5) {
      for (int j = 0; j < 3; j++) {
        float lk = 0.25 + 0.25 * float(j) + 0.08 * h.y;
        if (lk * uH * (0.55 + 0.45 * h.z) > H) continue;
        float ly = lk * uH * (0.55 + 0.45 * h.z);
        float lx = -base.x * lk * 0.7 + sin(lk * 5.0 + h.x * 6.0 + uTime * 1.5) * (2.0 + 3.0 * lk);
        float side = mod(float(j), 2.0) < 0.5 ? 1.0 : -1.0;
        vec2 lq = q - vec2(lx + side * 3.0, ly + 1.0);
        if (abs(lq.x) * 0.6 + abs(lq.y) < 1.8) c = over(paint(abs(lq.y) < 0.6 ? uLeaf * 1.2 : uLeaf, 1.0), c);
      }
    }
    if (uBlooms > 0.5 && h.z > 0.55) {
      vec2 bq = q - vec2(-base.x * 0.7 + sin(5.0 + h.x * 6.0 + uTime * 1.5) * 5.0, H);
      if (length(bq) < 1.7 && grow > 0.9) c = over(hot(uBloom, 1.0), c);
    }
  }
  return c;
}`;

export default defineEffect({
  id: "nature/entangle",
  name: "Entangle",
  kind: "aura",
  family: "nature",
  category: "debuff",
  tags: ["root", "debuff", "crowd control", "nature"],
  intro: 0.35,
  outro: 0.4,
  demo: { on: "target" },
  thinking: `A root has to answer one question instantly: "can I move?" So the vines come up OUT of the ground around the feet and wind in toward the legs, the one image everyone reads as "stuck". Each vine grows from a ring around the body, leans in as it climbs and curls in a slow sway, with a dark outline on one edge and alternating leaves, so it looks hand-drawn rather than procedural. Half the vines stand behind the body and half in front, so the target is caught INSIDE them. They are painted, not glowing (plants do not shine), except for the small flowers that open at the top at high level. On release they sink back into the ground.`,
  levels: `1-3: a few bare vines around the ankles. 4-6: more vines, with leaves. 7-9: vines climb to the waist. 10: a thicket that blooms with glowing flowers.`,
  tune: {
    vine: { type: "color", def: "#5f9a36", label: "Vine" },
    dark: { type: "color", def: "#2c4a1b", label: "Vine shadow" },
    leaf: { type: "color", def: "#86c64a", label: "Leaf" },
    bloom: { type: "color", def: "#ff9ad6", label: "Bloom" },
  },
  layers: ["back", "front"].map((half) => ({
    id: `vines_${half}`,
    emissive: false,
    sort: () => (half === "back" ? -0.35 : 0.35),
    box: (s) => {
      const b = box.ground(s, (s.height * 0.22) / 45 + 0.2, 10);
      const up = s.height * lv(s, 0.35, 0.75) + 10;
      return half === "back" ? { w: b.w, h: up + 4, ox: b.ox, oy: 2 } : { w: b.w, h: b.oy + up, ox: b.ox, oy: b.oy };
    },
    u: (s) => ({
      ...cols(s),
      uN: Math.round(lv(s, 5, 10)),
      uR: (s.height * 0.22) / 45,
      uH: s.height * lv(s, 0.3, 0.7),
      uHalf: half === "back" ? 1 : -1,
      uLeaves: tier(s, 4),
      uBlooms: tier(s, 10),
      uB: s.basis,
    }),
    frag: VINES,
  })),
});
