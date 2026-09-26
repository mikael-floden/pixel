import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";

const cols = (s) => ({ uCore: rgb(s.tune.core), uHot: rgb(s.tune.hot), uEdge: rgb(s.tune.edge) });

export default defineEffect({
  id: "weapon/critical_hit",
  name: "Critical Hit",
  kind: "burst",
  stage: { reach: 1.25, anim: "sword" },
  family: "weapon",
  category: "impact",
  tags: ["impact", "critical", "hit", "any weapon"],
  dur: 0.32,
  peakAt: 0,
  demo: { on: "target" },
  thinking: `The punctuation mark of combat: it adds nothing to the fight except the feeling that THAT one mattered. It lasts a third of a second and uses the biggest, simplest shape there is, an eight-pointed star of white with a hot yellow and orange rim, that punches out to full size in two frames and then shrinks and turns as it dies. Straight speed lines burst outward from it, the manga convention for impact. It sits at chest height on the victim and is played on top of whatever weapon effect landed the blow (sword, arrow, fist, bite), so a critical reads the same whatever caused it.`,
  levels: `1-3: a small star. 4-6: a bigger star with speed lines. 7-9: a ring bursts out behind the star. 10: a huge double star.`,
  tune: {
    core: { type: "color", def: "#ffffff", label: "Core" },
    hot: { type: "color", def: "#ffe066", label: "Hot" },
    edge: { type: "color", def: "#ff7a2a", label: "Rim" },
  },
  light: (s) => ({ color: [1.0, 0.9, 0.6], radius: 1.8, intensity: 1.2 * Math.max(0, 1 - s.t / 0.3) }),
  layers: [
    {
      id: "star",
      offset: (s) => [0, s.height * 0.55],
      sort: () => 0.5,
      box: (s) => box.around(lv(s, 26, 48)),
      u: (s) => ({ ...cols(s), uR: lv(s, 12, 26), uLines: tier(s, 4), uRing: tier(s, 7), uTwo: tier(s, 10) }),
      frag: glsl`
uniform float uR, uLines, uRing, uTwo; uniform vec3 uCore, uHot, uEdge;
vec4 effect(vec2 p) {
  float L = uLife;
  float pop = L < 0.12 ? L / 0.12 : 1.0 - (L - 0.12) / 0.88 * 0.75;
  vec2 q = rot(L * 0.6) * p;
  float R = uR * pop;
  float d = sdStar(q, R, R * 0.32, 8.0);
  vec4 c = vec4(0.0);
  if (d < 0.0) c = hot(d < -R * 0.28 ? uCore : (d < -R * 0.12 ? uHot : uEdge), 1.0);
  if (uTwo > 0.5) {
    float d2 = sdStar(rot(0.39) * q, R * 0.62, R * 0.25, 8.0);
    if (d2 < 0.0) c = hot(uCore, 1.0);
  }
  if (uRing > 0.5) {
    float rr = uR * (0.6 + 1.3 * L);
    c = over(c, hot(uEdge, step(abs(length(p) - rr), 1.0) * (1.0 - L)));
  }
  if (uLines > 0.5) {
    float a = atan(p.y, p.x);
    float id = floor((a / TAU + 0.5) * 16.0);
    float ray = step(0.55, hash11(id + uSeed * 7.0));
    float within = abs(fract((a / TAU + 0.5) * 16.0) - 0.5);
    float r = length(p);
    float r0 = uR * (0.8 + 1.6 * L), r1 = r0 + uR * 0.7 * (1.0 - L);
    if (ray > 0.5 && within < 0.07 && r > r0 && r < r1) c = over(hot(uHot, 1.0), c);
  }
  return c;
}`,
    },
  ],
});
