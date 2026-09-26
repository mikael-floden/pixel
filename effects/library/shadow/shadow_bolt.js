import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { COMET } from "../_shared/snippets.js";

const cols = (s) => ({ uVoid: rgb(s.tune.void), uRim: rgb(s.tune.rim), uHot: rgb(s.tune.hot) });
const R = (s) => lv(s, 5, 9.5);

export default defineEffect({
  id: "shadow/shadow_bolt",
  name: "Shadow Bolt",
  kind: "projectile",
  family: "shadow",
  category: "attack",
  tags: ["projectile", "damage", "curse", "single target"],
  speed: (s) => lv(s, 7.5, 9.5),
  windup: 0.12,
  thinking: `Shadow magic is drawn inside out: where fire is brightest in the middle, a shadow bolt is a hole of near-black with a burning violet rim, like light bending around something that should not be there. Its trail is black smoke laced with violet, painted rather than glowing, so it stays dark even at night and reads as absence. The impact is an implosion first (the rim collapses inward) and only then a dark burst outward with shreds of smoke. It is slower than the fireball on purpose, a heavier, more ominous shot.`,
  levels: `1-3: a small dark orb with a thin rim. 4-6: a smoke trail with violet sparks. 7-9: a big void orb and a double-ringed implosion. 10: a black star that tears the air open on impact.`,
  tune: {
    void: { type: "color", def: "#140a1f", label: "Void" },
    rim: { type: "color", def: "#a55cff", label: "Rim" },
    hot: { type: "color", def: "#f0c8ff", label: "Rim highlight" },
  },
  light: (s) => {
    if (s.phase === "flight") return { color: [0.55, 0.3, 0.9], radius: lv(s, 1.6, 2.6), intensity: 0.7 };
    if (s.phase === "impact") return { color: [0.6, 0.3, 1.0], radius: lv(s, 2.5, 4), intensity: 1.3 * Math.max(0, 1 - s.t / 0.6) };
    return null;
  },
  layers: [
    {
      id: "orb",
      phase: "flight",
      box: (s) => box.along(s, R(s) + 8, R(s) + lv(s, 26, 50), R(s) + 10),
      u: (s) => ({ ...cols(s), uR: R(s), uTail: Math.min(lv(s, 24, 48), s.len + R(s)), uSp: tier(s, 4) }),
      frag: glsl`
uniform float uR, uTail, uSp; uniform vec3 uVoid, uRim, uHot;
${COMET}
vec4 effect(vec2 p) {
  vec2 q = along(p);
  float body = comet(q, uR, uTail, uTime, uSeed, 1.4);
  vec4 c = vec4(0.0);
  if (body > 0.0) {
    float k = clamp(-q.x / uTail, 0.0, 1.0);
    float n = vnoise(q * 0.3 + uTime * 6.0 + uSeed * 4.0);
    vec3 smokeC = mix(uVoid, uRim * 0.35, qz(n * (1.0 - k), p));
    c = paint(smokeC, cut(body, 0.05 + k * 0.2, p));
    if (uSp > 0.5 && n > 0.78 && k > 0.1) c = hot(uRim, 1.0);
  }
  float d = length(q);
  float rim = step(abs(d - uR * 0.85), 1.1 + 0.4 * sin(uTime * 20.0 + atan(q.y, q.x) * 3.0));
  if (d < uR * 0.85) c = paint(uVoid, 1.0);
  c = over(hot(mix(uRim, uHot, step(0.3, sin(atan(q.y, q.x) * 2.0 + uTime * 9.0))), rim), c);
  c += glow(uRim * dglow(fall(max(d - uR, 0.0), uR * 1.3) * 0.5, p)) * (1.0 - c.a);
  return c;
}`,
    },
    {
      id: "implode",
      phase: "impact",
      dur: (s) => lv(s, 0.5, 0.75),
      box: (s) => box.around(lv(s, 26, 48)),
      u: (s) => ({ ...cols(s), uR: lv(s, 16, 34), uTwo: tier(s, 7) }),
      frag: glsl`
uniform float uR, uTwo; uniform vec3 uVoid, uRim, uHot;
vec4 effect(vec2 p) {
  float L = uLife;
  float d = length(p);
  float a = atan(p.y, p.x);
  vec4 c = vec4(0.0);
  if (L < 0.35) {
    float k = L / 0.35;
    float rr = uR * (1.0 - k);
    float ring = step(abs(d - rr), 1.4) + uTwo * step(abs(d - rr * 0.6), 1.0);
    c = hot(mix(uRim, uHot, k), min(ring, 1.0));
    c = over(paint(uVoid, step(d, rr * 0.4 * k)), c);
  } else {
    float k = (L - 0.35) / 0.65;
    float n = fbm(vec2(a * 2.0, d * 0.08 - uTime * 2.0) + uSeed * 7.0);
    float R = uR * (0.4 + 0.9 * k);
    float shape = 1.0 - d / R + (n - 0.5) * 0.8;
    float inner = 1.0 - d / (R * k * 0.9 + 0.001) + (n - 0.5) * 0.6;
    float cover = cut(shape, 0.0, p) * (1.0 - cut(inner, 0.0, p));
    c = paint(mix(uVoid, uRim * 0.4, qz(n, p)), cover * (1.0 - k * k));
    c = over(hot(uRim, step(abs(shape), 0.08) * (1.0 - k)), c);
  }
  return c;
}`,
    },
  ],
});
