import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";

const cols = (s) => ({ uTox: rgb(s.tune.tox), uDark: rgb(s.tune.dark), uFroth: rgb(s.tune.froth) });

// Bubbles rising off the body and drips falling from it: back half / front half.
const SICK = glsl`
uniform float uW, uH, uHalf, uN, uDrips, uHaze; uniform vec3 uTox, uDark, uFroth;
vec4 effect(vec2 p) {
  vec4 c = vec4(0.0);
  // a faint sickly haze hugging the body (back layer only)
  if (uHalf > 0.0 && uHaze > 0.5) {
    float n = fbm(vec2(p.x * 0.1, p.y * 0.07 - uTime * 0.9) + uSeed * 4.0);
    float body = 1.0 - length(vec2(p.x / (uW * 1.3), (p.y - uH * 0.45) / (uH * 0.62)));
    float v = clamp(body + (n - 0.5) * 0.8, 0.0, 1.0) * 0.45 * uFade;
    c = glow(uTox * dglow(v, p));
  }
  for (int i = 0; i < 14; i++) {
    if (float(i) >= uN) break;
    vec3 h = hash31(float(i) * 4.9 + uSeed * 12.0);
    float cyc = fract(uTime * (0.45 + 0.35 * h.x) + h.y);
    float th = h.z * TAU;
    float side = sin(th);
    if (side * uHalf < 0.0) continue;
    vec2 at = vec2(cos(th) * uW * (0.6 + 0.4 * h.x) + sin(cyc * 5.0 + h.z * 9.0) * 2.0, uH * (0.15 + 0.7 * h.y) + cyc * uH * 0.55);
    float r = 1.0 + 1.6 * h.x * (0.5 + cyc);
    float d = length(p - at);
    float pop = step(0.82, cyc);
    float ring = step(abs(d - r), 0.55) * (1.0 - pop);
    float shine = step(length(p - at - vec2(-r * 0.4, r * 0.4)), 0.6) * (1.0 - pop);
    float burst = pop * step(abs(d - r * 1.5), 0.5) * step(0.5, fract(atan(p.y - at.y, p.x - at.x) * 1.27));
    c = over(hot(mix(uTox, uFroth, shine), max(max(ring, shine), burst) * uFade), c);
  }
  if (uHalf < 0.0) {
    for (int i = 0; i < 6; i++) {
      if (float(i) >= uDrips) break;
      vec3 h = hash31(float(i) * 8.3 + uSeed * 3.0);
      float cyc = fract(uTime * (0.7 + 0.4 * h.x) + h.y);
      vec2 at = vec2((h.z - 0.5) * uW * 1.6, uH * (0.35 + 0.35 * h.x) - cyc * cyc * uH * 0.45);
      vec2 q = p - at;
      float drop = step(abs(q.x), 0.6) * step(-1.0, q.y) * step(q.y, 1.0 + 2.0 * (1.0 - cyc));
      c = over(paint(uDark * 1.4, drop * uFade * step(cyc, 0.9)), c);
    }
  }
  return c;
}`;

export default defineEffect({
  id: "poison/poisoned",
  name: "Poisoned",
  kind: "aura",
  stage: { caster: null, anim: null },
  family: "poison",
  category: "debuff",
  tags: ["debuff", "damage over time", "poison", "infection"],
  intro: 0.3,
  outro: 0.4,
  demo: { on: "target" },
  thinking: `The toxic infection, as a status on a body: it must say "sick" from across the screen without the flames of burning or the ice of a slow. Bubbles are the sign: green bubbles rise off the body in a loose cloud, swell as they climb and pop into a little broken ring, like something boiling under the skin, while dark drips run down and fall off. Half the bubbles pass behind the body and half in front. A faint sickly haze hugs the silhouette from level 4. It is slow and irregular on purpose, each bubble on its own clock, because an even rhythm reads as magic and poison should read as nature gone wrong.`,
  levels: `1-3: a few bubbles. 4-6: more bubbles, drips, and a sickly haze on the body. 7-9: a boiling cloud of bubbles. 10: the body seethes with poison.`,
  tune: {
    tox: { type: "color", def: "#9be83c", label: "Poison" },
    dark: { type: "color", def: "#3b6a1c", label: "Drips" },
    froth: { type: "color", def: "#efffb0", label: "Shine" },
  },
  light: (s) => (s.level >= 7 ? { color: [0.55, 1.0, 0.3], radius: 1.5, intensity: 0.4 * s.fade } : null),
  layers: ["back", "front"].map((half) => ({
    id: `sick_${half}`,
    sort: () => (half === "back" ? -0.3 : 0.3),
    box: (s) => box.column(s.height * 0.5, s.height * 1.25, 4),
    u: (s) => ({ ...cols(s), uW: s.height * 0.22, uH: s.height * 0.95, uHalf: half === "back" ? 1 : -1, uN: Math.round(lv(s, 4, 14)), uDrips: tier(s, 4) * Math.round(lv(s, 2, 6)), uHaze: tier(s, 4) }),
    frag: SICK,
  })),
});
