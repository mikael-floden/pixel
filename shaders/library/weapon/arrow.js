import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { SPARKS } from "../_shared/snippets.js";

const cols = (s) => ({ uShaft: rgb(s.tune.shaft), uHead: rgb(s.tune.head), uFletch: rgb(s.tune.fletch), uGlowC: rgb(s.tune.glow) });

export default defineEffect({
  id: "weapon/arrow",
  name: "Arrow",
  kind: "projectile",
  stage: { anim: "bow" },
  family: "weapon",
  category: "attack",
  tags: ["projectile", "physical", "bow", "ranged"],
  speed: (s) => lv(s, 15, 20),
  minFlight: 0.08,
  arc: (s) => lv(s, 12, 7),
  thinking: `An arrow is the effect a player will see ten thousand times, so it is kept small, fast and exact: a one-pixel shaft, a steel head and two fletching pixels, drawn along its true flight direction every frame (it pitches up, then noses down over a slight arc, like a real shot). Speed is most of the feel: at 15-20 cells per second it crosses a phone screen in about a third of a second, which is too fast to lose and too slow to miss. A faint white motion streak behind it keeps it readable at that speed. The hit is a small puff of splinters and a white tick, deliberately modest so a volley of arrows does not become a light show. Higher levels are faster and flatter shots, then an enchanted, glowing head.`,
  levels: `1-3: a plain arrow on a visible arc. 4-6: a faster, flatter shot with a longer streak. 7-9: the head glows and leaves a faint light trail. 10: a keen shot wrapped in a spiralling wind trail.`,
  tune: {
    shaft: { type: "color", def: "#7a5433", label: "Shaft" },
    head: { type: "color", def: "#d9e1e8", label: "Head" },
    fletch: { type: "color", def: "#efe7d2", label: "Fletching" },
    glow: { type: "color", def: "#bff0ff", label: "Enchant glow" },
  },
  light: (s) => (s.level >= 7 && s.phase === "flight" ? { color: [0.7, 0.95, 1.0], radius: 1.4, intensity: 0.6 } : null),
  layers: [
    {
      id: "arrow",
      phase: "flight",
      box: (s) => box.along(s, 8, lv(s, 30, 52), 9),
      u: (s) => ({ ...cols(s), uStreak: Math.min(lv(s, 12, 34), s.len), uEnchant: tier(s, 7), uWind: tier(s, 10) }),
      frag: glsl`
uniform float uStreak, uEnchant, uWind; uniform vec3 uShaft, uHead, uFletch, uGlowC;
vec4 effect(vec2 p) {
  vec2 q = along(p);
  vec4 c = vec4(0.0);
  float ay = abs(q.y);
  // streak: a faint line behind the arrow, dithered away
  float sk = clamp(-(q.x + 10.0) / max(uStreak, 1.0), 0.0, 1.0);
  if (q.x < -10.0 && q.x > -10.0 - uStreak && ay < 0.7) c = glow(mix(uFletch, uGlowC, uEnchant) * dglow((1.0 - sk) * 0.55, p));
  if (uWind > 0.5 && q.x < -4.0 && q.x > -10.0 - uStreak) {
    float w = sin(q.x * 0.5 + uTime * 40.0) * 3.0 * (1.0 - sk);
    if (abs(q.y - w) < 0.6) c = over(hot(uGlowC, 1.0 - sk), c);
  }
  // shaft
  if (q.x > -10.0 && q.x < 1.0 && ay < 0.55) c = hot(uShaft, 1.0);
  // head: a small steel barb
  if (q.x >= 0.0 && q.x < 4.0 && ay < (4.0 - q.x) * 0.55) c = hot(mix(uHead, uGlowC, uEnchant * 0.6), 1.0);
  // fletching
  if (q.x > -10.5 && q.x < -7.0 && ay > 0.5 && ay < 2.2 + (q.x + 10.5) * -0.2 + 0.7) c = hot(uFletch, 1.0);
  if (uEnchant > 0.5) c += glow(uGlowC * dglow(fall(length(q - vec2(2.0, 0.0)), 7.0) * 0.8, p)) * (1.0 - c.a);
  return c;
}`,
    },
    {
      id: "hit",
      phase: "impact",
      dur: 0.35,
      box: () => box.around(20),
      u: (s) => ({ ...cols(s), uN: Math.round(lv(s, 4, 9)) }),
      frag: glsl`
uniform float uN; uniform vec3 uShaft, uHead, uFletch, uGlowC;
${SPARKS}
vec4 effect(vec2 p) {
  float L = uLife;
  vec2 q = abs(p);
  float tick = step(q.x * q.y, 2.5) * step(max(q.x, q.y), 5.0 * (1.0 - L)) * step(L, 0.4);
  vec4 c = hot(uFletch, tick);
  float sp = sparks(p, uTime, uN, 70.0, 220.0, 0.6, uSeed);
  if (sp > 0.0) c = over(paint(mix(uShaft, uFletch, sp * 0.5), 1.0), c);
  return c;
}`,
    },
  ],
});
