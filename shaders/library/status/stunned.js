import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";

const cols = (s) => ({ uStar: rgb(s.tune.star), uEdge: rgb(s.tune.edge) });

const STARS = glsl`
uniform float uN, uRx, uHalf; uniform vec3 uStar, uEdge;
vec4 effect(vec2 p) {
  vec4 c = vec4(0.0);
  for (int i = 0; i < 6; i++) {
    if (float(i) >= uN) break;
    float th = uTime * 3.2 + float(i) / uN * TAU;
    float side = sin(th);
    if (side * uHalf < 0.0) continue;
    vec2 at = vec2(cos(th) * uRx, side * uRx * 0.32);
    vec2 q = abs(floor(p - at + 0.5));
    float big = 1.0 + step(0.0, side);
    float tw = step(0.5, fract(uTime * 4.0 + float(i) * 0.37));
    float arm = big + tw;
    float star = ((q.x < 0.5 && q.y <= arm) || (q.y < 0.5 && q.x <= arm) || (q.x < 1.5 && q.y < 1.5)) ? 1.0 : 0.0;
    float core = (q.x < 0.5 && q.y < 0.5) ? 1.0 : 0.0;
    c = over(hot(core > 0.5 ? uEdge : uStar, star * uFade), c);
  }
  return c;
}`;

export default defineEffect({
  id: "status/stunned",
  name: "Stunned",
  kind: "aura",
  stage: { caster: null, anim: null },
  family: "status",
  category: "debuff",
  tags: ["stun", "debuff", "crowd control"],
  intro: 0.12,
  outro: 0.2,
  demo: { on: "target" },
  thinking: `The universal cartoon sign for "seeing stars", because a stun must be read in a split second in a crowd and nothing is faster to read than a symbol everyone already knows. Stars circle on a flat orbit just above the head, half passing behind it and half in front, nearer ones drawn bigger (a cheap depth cue that makes the orbit read as a ring in space). They twinkle out of phase. Levels add stars and widen the orbit, so a long heavy stun looks heavier than a short daze.`,
  levels: `1-3: three small stars. 4-6: four stars on a wider orbit. 7-9: five. 10: six stars in a wide halo.`,
  tune: {
    star: { type: "color", def: "#ffe04a", label: "Star" },
    edge: { type: "color", def: "#ffffff", label: "Twinkle" },
  },
  layers: ["back", "front"].map((half) => ({
    id: `stars_${half}`,
    sort: () => (half === "back" ? -0.3 : 0.3),
    offset: (s) => [0, s.height * 1.02],
    box: (s) => box.rect(s.height * 0.62 + 8, s.height * 0.26 + 10),
    u: (s) => ({ ...cols(s), uN: 3 + tier(s, 4) + tier(s, 7) + tier(s, 10), uRx: s.height * lv(s, 0.2, 0.28), uHalf: half === "back" ? 1 : -1 }),
    frag: STARS,
  })),
});
