import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { SPARKS } from "../_shared/snippets.js";

const cols = (s) => ({ uCore: rgb(s.tune.core), uEdge: rgb(s.tune.edge), uBlood: rgb(s.tune.blood) });

export default defineEffect({
  id: "monster/claw_swipe",
  name: "Claw Swipe",
  kind: "melee",
  family: "monster",
  category: "attack",
  tags: ["melee", "monster", "physical", "bleed"],
  dur: 0.4,
  hitAt: 0.1,
  thinking: `Every beast with claws needs this, and it has to hit harder than a punch without becoming a light show. Three (at level 7, four) parallel rakes are drawn ACROSS the victim, each one a white-hot line with red edges that is dragged out to full length in a few frames, one claw a hair behind the last, so the eye sees one swipe of a paw rather than three lines. The direction of the rake follows the attacker's direction, so a monster to the left rakes left to right. A spray of dark red flecks sells the damage. Painted in white and red it reads on any creature, in day or night.`,
  levels: `1-3: three thin, short rakes. 4-6: longer rakes and a spray of flecks. 7-9: four claws. 10: deep, glowing wounds that linger a moment.`,
  tune: {
    core: { type: "color", def: "#ffffff", label: "Core" },
    edge: { type: "color", def: "#ff4a3a", label: "Edge" },
    blood: { type: "color", def: "#8a0f1a", label: "Flecks" },
  },
  layers: [
    {
      id: "rake",
      phase: "hit",
      dur: (s) => lv(s, 0.3, 0.5),
      sort: () => 0.35,
      box: (s) => box.around(lv(s, 22, 34)),
      u: (s) => ({ ...cols(s), uL: lv(s, 16, 28), uN: 3 + tier(s, 7), uFlecks: tier(s, 4) * Math.round(lv(s, 5, 14)), uGlowOn: tier(s, 10) }),
      frag: glsl`
uniform float uL, uN, uFlecks, uGlowOn; uniform vec3 uCore, uEdge, uBlood;
${SPARKS}
vec4 effect(vec2 p) {
  // rake direction: the attack's direction, tipped 35 degrees downward
  vec2 d = normalize(vec2(uDir.x, uDir.y - 0.7 * sign(uDir.x + 0.001)));
  vec2 n = vec2(-d.y, d.x);
  vec4 c = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uN) break;
    float off = (float(i) - (uN - 1.0) * 0.5) * 5.0;
    float t0 = float(i) * 0.035;
    float grow = clamp((uTime - t0) / 0.07, 0.0, 1.0);
    float fade = 1.0 - smoothstep(0.45 + 0.35 * uGlowOn, 1.0, uLife);
    vec2 q = vec2(dot(p, d), dot(p, n) - off);
    float half_ = uL * 0.5;
    float x0 = -half_, x1 = -half_ + uL * grow;
    if (q.x < x0 || q.x > x1) continue;
    float k = (q.x - x0) / uL;
    float w = sin(k * PI) * 1.6 + 0.3;
    if (abs(q.y) < w) {
      vec3 col = abs(q.y) < w * 0.45 ? uCore : uEdge;
      c = over(hot(col, fade), c);
    }
  }
  float sp = sparks(p, uTime, uFlecks, 80.0, 260.0, 0.3, uSeed);
  if (sp > 0.0) c = over(paint(uBlood, 1.0), c);
  return c;
}`,
    },
  ],
});
