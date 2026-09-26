import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { SPARKS } from "../_shared/snippets.js";

const cols = (s) => ({ uAcid: rgb(s.tune.acid), uDark: rgb(s.tune.dark), uFroth: rgb(s.tune.froth) });
const POOL = (s) => lv(s, 0.55, 1.25);

export default defineEffect({
  id: "poison/acid_spit",
  name: "Acid Spit",
  kind: "projectile",
  stage: { caster: "monster", target: "hero", anim: "attack", monster: "blight_elk" },
  family: "poison",
  category: "attack",
  tags: ["projectile", "damage over time", "lob", "monster", "ground pool"],
  speed: (s) => lv(s, 7, 8.5),
  arc: (s) => lv(s, 30, 42),
  targetZ: 0, // a lob lands at the victim's feet, not on its chest
  minFlight: 0.2,
  thinking: `Poison should feel wet and nasty, never clean. The spit is LOBBED on a high arc, which is the silhouette that says "spit" rather than "spell" (and gives a target a moment to see it coming). The glob wobbles with squash and stretch along its flight, has a dark outline and a single highlight pixel like a real pixel-art drop, and sheds droplets that fall away under gravity. When it lands it splashes up and outward and leaves a bubbling pool of acid on the ground: an irregular puddle with a bright rim and bubbles that swell and pop. The pool is the lingering damage zone, so its size comes from the level and it lasts long enough to be avoided.`,
  levels: `1-3: a small glob and a small puddle. 4-6: droplets in the air, a bigger splash, bubbling. 7-9: a big glob and a wide, long-lived pool. 10: a torrent of spit that leaves a broad acid lake.`,
  tune: {
    acid: { type: "color", def: "#9be83c", label: "Acid" },
    dark: { type: "color", def: "#2f5a18", label: "Dark acid" },
    froth: { type: "color", def: "#e6ff9a", label: "Froth" },
  },
  light: (s) => {
    if (s.phase === "impact") return { color: [0.55, 1.0, 0.25], radius: lv(s, 1.4, 2.6), intensity: 0.6 * Math.max(0, 1 - s.t / 3) };
    return null;
  },
  layers: [
    {
      id: "glob",
      phase: "flight",
      box: (s) => box.around(lv(s, 14, 22)),
      u: (s) => ({ ...cols(s), uR: lv(s, 3.5, 6.5), uDrops: tier(s, 4) * lv(s, 3, 7) }),
      frag: glsl`
uniform float uR, uDrops; uniform vec3 uAcid, uDark, uFroth;
vec4 effect(vec2 p) {
  vec2 q = along(p);
  float wob = sin(uTime * 26.0) * 0.18;
  vec2 s = vec2(1.0 + 0.3 + wob, 1.0 - 0.15 - wob);
  vec2 e = q / (uR * s);
  float d = length(e);
  vec4 c = vec4(0.0);
  for (int i = 0; i < 7; i++) {
    if (float(i) >= uDrops) break;
    vec3 h = hash31(float(i) * 5.3 + uSeed * 3.0);
    float age = fract(uTime * (2.0 + h.x) + h.y);
    vec2 at = vec2(-uR * 1.2 - age * 10.0, (h.z - 0.5) * uR * 1.2) ;
    vec2 dp = p - (vec2(at.x * uDir.x - at.y * uDir.y, at.x * uDir.y + at.y * uDir.x) - vec2(0.0, age * age * 14.0));
    if (max(abs(dp.x), abs(dp.y)) < 0.9 && age < 0.8) c = paint(uAcid, 1.0);
  }
  if (d < 1.0) {
    vec3 col = d > 0.78 ? uDark : uAcid;
    if (e.y > 0.25 && e.x > 0.1 && d < 0.55) col = uFroth;
    c = over(paint(col, 1.0), c);
  }
  return c;
}`,
    },
    {
      id: "splash",
      phase: "impact",
      dur: 0.5,
      box: (s) => box.column(lv(s, 26, 44), lv(s, 34, 56), 8),
      u: (s) => ({ ...cols(s), uN: Math.round(lv(s, 8, 20)) }),
      frag: glsl`
uniform float uN; uniform vec3 uAcid, uDark, uFroth;
${SPARKS}
vec4 effect(vec2 p) {
  float sp = sparks(p, uTime, uN, 95.0, 260.0, 1.0, uSeed);
  vec4 c = sp > 0.0 ? paint(sp > 0.6 ? uFroth : uAcid, 1.0) : vec4(0.0);
  float crown = step(abs(length(p * vec2(1.0, 2.3)) - 10.0 * (0.4 + uLife)), 1.2) * step(0.0, p.y) * (1.0 - step(0.45, uLife));
  return over(paint(uAcid, crown), c);
}`,
    },
    {
      id: "pool",
      phase: "impact",
      plane: "ground",
      dur: (s) => lv(s, 2.2, 4.5),
      box: (s) => box.ground(s, POOL(s) * 1.3),
      u: (s) => ({ ...cols(s), uR: POOL(s), uBub: tier(s, 4) }),
      frag: glsl`
uniform float uR, uBub; uniform vec3 uAcid, uDark, uFroth;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float grow = 1.0 - pow(1.0 - min(uLife * 7.0, 1.0), 2.0);
  float shrink = 1.0 - smoothstep(0.7, 1.0, uLife);
  float n = fbm(g * 1.8 + uSeed * 6.0);
  float d = length(g * vec2(1.0, 1.15)) / (uR * grow * (0.55 + 0.45 * shrink) + 0.001) + (n - 0.5) * 0.7;
  if (d > 1.0) return vec4(0.0);
  vec3 col = d > 0.82 ? uAcid : mix(uDark, uAcid, qz(0.35 + 0.3 * n, p));
  vec4 c = hot(col, 0.9);
  if (uBub > 0.5) {
    for (int i = 0; i < 6; i++) {
      vec3 h = hash31(float(i) * 7.7 + uSeed * 2.0);
      float cyc = fract(uTime * (0.6 + 0.5 * h.x) + h.y);
      vec2 at = (h.xy - 0.5) * uR * 1.1;
      float r = 0.06 + 0.1 * cyc;
      float ring = step(abs(length(g - at) - r), 0.025) * step(cyc, 0.85);
      c = over(hot(uFroth, ring), c);
    }
  }
  return c;
}`,
    },
  ],
});
