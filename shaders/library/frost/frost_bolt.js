import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { SPARKS, STAR4 } from "../_shared/snippets.js";

const cols = (s) => ({ uIce: rgb(s.tune.ice), uDeep: rgb(s.tune.deep), uRime: rgb(s.tune.rime), uMist: rgb(s.tune.mist) });
const LEN = (s) => lv(s, 9, 17);

export default defineEffect({
  id: "frost/frost_bolt",
  name: "Frost Bolt",
  kind: "projectile",
  family: "frost",
  category: "attack",
  tags: ["projectile", "damage", "slow", "single target"],
  speed: (s) => lv(s, 9, 12),
  windup: 0.08,
  thinking: `Frost's answer to the fireball, built as its opposite so the two never read alike: where fire billows, ice is faceted. The bolt is a hard crystal shard, lit on one face and shaded on the other, that points exactly where it flies, with a thin trail of cold mist and a few sparkles of rime falling off it. The shard stays small and precise even at level 10; power shows in the mist and the shatter. On impact it bursts into splinters, a white flash and a ring of cold vapour, and it leaves a small patch of frost on the ground under the target, which is the visual promise of the slow the spell applies.`,
  levels: `1-3: a small shard with a short mist trail. 4-6: a longer shard, rime sparkles in the trail, splinters on impact. 7-9: a heavy crystal and a frosted patch on the ground. 10: a lance of ice that shatters into a wide frost patch.`,
  tune: {
    ice: { type: "color", def: "#9fe3ff", label: "Ice" },
    deep: { type: "color", def: "#3478c8", label: "Deep ice" },
    rime: { type: "color", def: "#ffffff", label: "Rime" },
    mist: { type: "color", def: "#bfe8ff", label: "Mist" },
  },
  light: (s) => {
    if (s.phase === "flight") return { color: [0.6, 0.85, 1.0], radius: lv(s, 1.8, 3), intensity: 0.8 };
    if (s.phase === "impact") return { color: [0.65, 0.88, 1.0], radius: lv(s, 2.5, 4), intensity: 1.6 * Math.max(0, 1 - s.t / 0.4) };
    return null;
  },
  layers: [
    {
      id: "shard",
      phase: "flight",
      box: (s) => box.along(s, LEN(s) + 4, LEN(s) + lv(s, 18, 40), lv(s, 8, 12)),
      u: (s) => ({ ...cols(s), uL: LEN(s), uW: lv(s, 2.5, 4.5), uTrail: Math.min(lv(s, 18, 40), s.len), uSp: tier(s, 4) * lv(s, 3, 8) }),
      frag: glsl`
uniform float uL, uW, uTrail, uSp; uniform vec3 uIce, uDeep, uRime, uMist;
${STAR4}
vec4 effect(vec2 p) {
  vec2 q = along(p);
  vec4 c = vec4(0.0);
  // mist: a thin wavering trail behind the shard
  float k = clamp(-q.x / max(uTrail, 1.0), 0.0, 1.0);
  if (q.x < 0.0 && -q.x < uTrail) {
    float n = vnoise(vec2(q.x * 0.2 + uTime * 9.0, q.y * 0.4) + uSeed * 8.0);
    float w = uW * (1.0 - k) * (0.6 + 0.8 * n);
    float m = (1.0 - abs(q.y) / max(w, 0.01)) * (1.0 - k);
    if (m > 0.0) c = glow(uMist * dglow(m * 0.7, p));
  }
  // rime sparkles falling off
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uSp) break;
    vec3 h = hash31(float(i) * 4.1 + uSeed * 9.0);
    float age = fract(uTime * (1.1 + h.x) + h.y);
    vec2 at = vec2(-uL * 0.3 - age * uTrail * 0.9, (h.z - 0.5) * uW * 3.0 - age * 6.0);
    if (-at.x < uLen && star4(q, at, age < 0.4 ? 1.0 : 0.0) > 0.0) c = over(hot(uRime, 1.0), c);
  }
  // the shard: a long diamond, lit face above, shaded below
  float front = uL * 0.62, back = uL * 0.38;
  float ext = q.x > 0.0 ? q.x / front : -q.x / back;
  float d = ext + abs(q.y) / uW;
  if (d < 1.0) {
    vec3 col = q.y > 0.4 ? uIce : uDeep;
    if (q.y > uW * 0.35 * (1.0 - ext)) col = mix(uIce, uRime, 0.6);
    if (d > 0.78) col = q.y > 0.0 ? uRime : uDeep * 0.75;
    if (q.x > front - 2.5) col = uRime;
    c = over(hot(col, 1.0), c);
  }
  c += glow(uIce * dglow(fall(length(q), uL * 0.9) * 0.45, p)) * (1.0 - c.a);
  return c;
}`,
    },
    {
      id: "shatter",
      phase: "impact",
      dur: 0.5,
      box: (s) => box.around(lv(s, 26, 46)),
      u: (s) => ({ ...cols(s), uN: Math.round(lv(s, 6, 18)), uR: lv(s, 8, 16) }),
      frag: glsl`
uniform float uN, uR; uniform vec3 uIce, uDeep, uRime, uMist;
${SPARKS}
vec4 effect(vec2 p) {
  float L = uLife;
  float d = length(p);
  vec4 c = hot(uRime, step(d, uR * 0.8 * (1.0 - L * 3.0)));
  float ring = fall(abs(d - uR * (0.5 + 1.6 * L)), 3.0) * (1.0 - L);
  c += glow(uMist * dglow(ring * 0.8, p)) * (1.0 - c.a);
  float sp = sparks(p, uTime, uN, 120.0, 180.0, 0.35, uSeed);
  if (sp > 0.0) c = over(hot(sp > 0.5 ? uRime : uIce, 1.0), c);
  return c;
}`,
    },
    {
      id: "frost",
      phase: "impact",
      plane: "ground",
      dur: (s) => lv(s, 1.2, 2.6),
      when: (s) => s.level >= 7,
      box: (s) => box.ground(s, lv(s, 0.6, 1.2)),
      u: (s) => ({ ...cols(s), uR: lv(s, 0.6, 1.2) }),
      frag: glsl`
uniform float uR; uniform vec3 uIce, uDeep, uRime, uMist;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float grow = min(1.0, uLife * 6.0);
  float n = fbm(g * 3.0 + uSeed * 5.0);
  float d = length(g) / (uR * grow + 0.01) + (n - 0.5) * 0.5;
  float a = (1.0 - smoothstep(0.7, 1.0, d)) * (1.0 - smoothstep(0.6, 1.0, uLife));
  vec3 v = voronoi(g * 4.0 + uSeed * 3.0);
  float crack = 1.0 - smoothstep(0.02, 0.06, v.y);
  vec4 c = paint(mix(uDeep, uIce, 0.5 + 0.5 * v.z), cut(a, 0.35, p) * 0.55);
  return over(hot(uRime, crack * cut(a, 0.5, p) * 0.8), c);
}`,
    },
  ],
});
