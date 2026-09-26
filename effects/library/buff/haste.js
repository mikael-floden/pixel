import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";

const cols = (s) => ({ uWind: rgb(s.tune.wind), uEdge: rgb(s.tune.edge) });

// Wind arcs circling the legs on the ground plane: back half / front half.
const WIND = glsl`
uniform float uR, uN, uHalf, uLines; uniform vec3 uWind, uEdge;
vec4 effect(vec2 p) {
  vec4 c = vec4(0.0);
  vec2 fr = normalize(gnd(vec2(0.0, -1.0)));
  for (int j = 0; j < 3; j++) {
    float lift = float(j) * 9.0 + 3.0;
    vec2 g = gnd(p - vec2(0.0, lift));
    if (dot(g, fr) * uHalf > 0.0) continue;
    float r = length(g);
    float a = atan(g.y, g.x);
    for (int i = 0; i < 3; i++) {
      if (float(i) >= uN) break;
      float rr = uR * (0.8 + 0.15 * float(j) + 0.1 * float(i));
      float spin = uTime * (5.0 + float(i)) + float(i) * 2.1 + float(j) * 1.3 + uSeed * 6.0;
      float ph = mod(a - spin, TAU);
      float arc = step(ph, 1.4) * step(ringPx(g, rr), 0.7);
      c = over(hot(mix(uWind, uEdge, ph / 1.4), arc * (1.0 - ph / 1.6) * uFade), c);
    }
  }
  // speed lines streaming up past the body (front only)
  if (uHalf < 0.0) {
    for (int i = 0; i < 6; i++) {
      if (float(i) >= uLines) break;
      vec3 h = hash31(float(i) * 5.1 + uSeed * 4.0);
      float cyc = fract(uTime * (1.4 + h.x) + h.y);
      vec2 at = vec2((h.z - 0.5) * uR * 70.0, cyc * 70.0 + 6.0);
      vec2 q = p - at;
      if (abs(q.x) < 0.6 && q.y > 0.0 && q.y < 9.0 * (1.0 - cyc)) c = over(hot(uEdge, uFade), c);
    }
  }
  return c;
}`;

export default defineEffect({
  id: "buff/haste",
  name: "Haste",
  kind: "aura",
  family: "buff",
  category: "buff",
  tags: ["buff", "speed", "movement"],
  intro: 0.2,
  outro: 0.3,
  demo: { on: "caster" },
  thinking: `Speed is shown with the oldest trick in animation: motion lines. Short arcs of wind whip around the legs on the ground plane (so they wrap the body in iso, half behind and half in front), at three heights, spinning fast enough to read as a whirl rather than as rings; from level 4, thin speed lines stream upward past the body. It stays light and pale, a buff that is on for a long time must not be louder than the combat around it, and it is kept around the feet where it reads as "fast feet" and leaves the body clear.`,
  levels: `1-3: a single whirl of wind at the feet. 4-6: two whirls and speed lines. 7-9: three whirls. 10: a gale around the legs.`,
  tune: {
    wind: { type: "color", def: "#a8e8ff", label: "Wind" },
    edge: { type: "color", def: "#ffffff", label: "Streak" },
  },
  layers: ["back", "front"].map((half) => ({
    id: `wind_${half}`,
    sort: () => (half === "back" ? -0.3 : 0.3),
    box: (s) => {
      const b = box.ground(s, 0.62, 6);
      return half === "back" ? { w: b.w, h: b.h / 2 + 34, ox: b.ox, oy: 2 } : { w: b.w, h: b.oy + 84, ox: b.ox, oy: b.oy };
    },
    u: (s) => ({ ...cols(s), uR: 0.5, uN: 1 + tier(s, 4) + tier(s, 7), uHalf: half === "back" ? 1 : -1, uLines: tier(s, 4) * Math.round(lv(s, 2, 6)) }),
    frag: WIND,
  })),
});
