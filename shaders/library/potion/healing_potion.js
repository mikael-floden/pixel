import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";

const cols = (s) => ({ uLiq: rgb(s.tune.liquid), uDark: rgb(s.tune.dark), uShine: rgb(s.tune.shine) });

// A ribbon of liquid spiralling up the body: back half / front half.
const SPIRAL = glsl`
uniform float uRx, uH, uHalf, uHearts; uniform vec3 uLiq, uDark, uShine;
float heart(vec2 q) {
  q = floor(q + 0.5);
  if (q.y > 1.0 || q.y < -2.0 || abs(q.x) > 2.0) return 0.0;
  if (q.y == 1.0 && (q.x == 0.0 || abs(q.x) == 2.0)) return 0.0;
  if (q.y == -1.0 && abs(q.x) == 2.0) return 0.0;
  if (q.y == -2.0 && abs(q.x) > 0.0) return 0.0;
  return 1.0;
}
vec4 effect(vec2 p) {
  float L = uLife;
  vec4 c = vec4(0.0);
  float head = uH * smoothstep(0.0, 0.6, L);
  float tailEnd = uH * smoothstep(0.35, 1.0, L);
  if (p.y > tailEnd && p.y < head) {
    float k = p.y / uH;
    float th = k * TAU * 1.6 - uTime * 2.0;
    float side = sin(th);
    if (side * uHalf >= 0.0) {
      float x = cos(th) * uRx * (1.0 - 0.3 * k);
      float w = 2.0 + 1.2 * (1.0 - k);
      float dx = abs(p.x - x);
      if (dx < w) {
        vec3 col = dx < w * 0.35 && side * uHalf > 0.3 ? uShine : (dx > w - 0.9 ? uDark : uLiq);
        c = hot(col, 1.0);
      }
    }
  }
  if (uHalf < 0.0) {
    for (int i = 0; i < 6; i++) {
      if (float(i) >= uHearts) break;
      vec3 h = hash31(float(i) * 3.3 + uSeed * 5.0);
      float t = (L - 0.3 - h.x * 0.3) / 0.5;
      if (t < 0.0 || t > 1.0) continue;
      vec2 at = vec2((h.y - 0.5) * uRx * 2.5 + sin(t * 6.0 + h.z * 5.0) * 2.0, uH * (0.55 + 0.6 * t));
      if (heart(p - at) > 0.5) c = over(hot(mix(uShine, uLiq, t), 1.0 - step(0.85, t)), c);
    }
    float bub = 0.0;
    for (int i = 0; i < 8; i++) {
      vec3 h = hash31(float(i) * 7.1 + uSeed);
      float t = fract(uTime * (0.8 + h.x) + h.y);
      vec2 at = vec2((h.z - 0.5) * uRx * 2.0, t * uH);
      if (step(abs(length(p - at) - 1.5), 0.5) > 0.0 && L < 0.8) bub = 1.0;
    }
    c = over(hot(uShine, bub * 0.9), c);
  }
  return c;
}`;

export default defineEffect({
  id: "potion/healing_potion",
  name: "Healing Potion",
  kind: "burst",
  family: "potion",
  category: "heal",
  tags: ["potion", "heal", "item", "consumable"],
  dur: (s) => lv(s, 1.1, 1.5),
  peakAt: 0.3,
  demo: { on: "caster" },
  thinking: `Drinking a potion is an item, not a spell, so it must look different from the priest's heal even though both restore health. It is LIQUID: a red ribbon spirals up around the drinker (half behind, half in front), with a dark edge and a shine along its near side, the way a pixel artist draws a glass of wine, while bubbles rise through it. At the top it releases little pixel hearts. The colour is the item's own (red for health, and the same effect in blue makes a mana potion), and the potion's grade is the level, so a Greater Healing Potion spirals longer and throws more hearts.`,
  levels: `1-3: a short red ribbon and bubbles. 4-6: a longer spiral and a few hearts. 7-9: a spiral that climbs over the head. 10: a fountain of hearts.`,
  tune: {
    liquid: { type: "color", def: "#e2324a", label: "Liquid" },
    dark: { type: "color", def: "#7a1024", label: "Edge" },
    shine: { type: "color", def: "#ffc4cc", label: "Shine" },
  },
  light: (s) => ({ color: [1.0, 0.35, 0.4], radius: 1.8, intensity: 0.7 * Math.sin(Math.min(1, s.life) * Math.PI) }),
  layers: ["back", "front"].map((half) => ({
    id: `spiral_${half}`,
    sort: () => (half === "back" ? -0.3 : 0.3),
    box: (s) => box.column(s.height * 0.42, s.height * lv(s, 1.0, 1.45) + 10, 4),
    u: (s) => ({ ...cols(s), uRx: s.height * 0.28, uH: s.height * lv(s, 0.85, 1.25), uHalf: half === "back" ? 1 : -1, uHearts: tier(s, 4) * Math.round(lv(s, 2, 6)) }),
    frag: SPIRAL,
  })),
});
