import { defineEffect, lv, tier, rgb, mix3, scale3, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { SPARKS, SMOKE, SHOCK } from "../_shared/snippets.js";

// five-stop fire ramp from the three tunable colours
const ramp = (s) => {
  const core = rgb(s.tune.core), flame = rgb(s.tune.flame), ember = rgb(s.tune.ember);
  return {
    uC0: scale3(ember, 0.45),
    uC1: ember,
    uC2: flame,
    uC3: mix3(flame, core, 0.55),
    uC4: core,
  };
};
const orbR = (s) => lv(s, 5, 10);
const blastR = (s) => lv(s, 16, 38);

export default defineEffect({
  id: "fire/fireball",
  name: "Fireball",
  kind: "projectile",
  family: "fire",
  category: "attack",
  tags: ["projectile", "damage", "single target", "explosion"],
  speed: (s) => lv(s, 8, 10),
  windup: 0.1,
  thinking: `The fireball every RPG player already knows how to read, so the work is in the pixels, not the idea. The head is a ball of five hard colour bands (soot, ember, flame, yellow, white) with a turbulent edge, and the tail is flame tongues that stream backwards out of a noise field that scrolls faster than the ball flies. That makes it look pushed through the air rather than slid across the screen. Embers peel off the tail so the path is still readable after the ball has gone. It never trails behind the caster's hand on launch: the tail grows from the hand. The impact reads in three beats: a white flash disk (the frame you feel), a billowing ball that cools down the same ramp, and soot smoke that stays in the world's own light (not emissive), so at night the smoke is dark against the glow. Higher levels spend their budget on heat and debris, not only size.`,
  levels: `1-3: a small ember bolt with a short tail and a modest pop. 4-6: a bigger ball, shed embers in the tail, debris sparks on impact. 7-9: a white-hot core, a long tail, a burning shock ring racing across the ground, a wider scorch. 10: all of it at full size, with a second shock ring and a debris storm.`,
  tune: {
    core: { type: "color", def: "#fff1b8", label: "Core" },
    flame: { type: "color", def: "#ff7b22", label: "Flame" },
    ember: { type: "color", def: "#b8261a", label: "Ember" },
    soot: { type: "color", def: "#2b1a15", label: "Smoke" },
    trail: { type: "range", def: 1, min: 0, max: 2, step: 0.05, label: "Tail length" },
    smoke: { type: "bool", def: true, label: "Smoke after the blast" },
  },
  light: (s) => {
    const c = [1.0, 0.55, 0.2];
    if (s.phase === "windup") return { color: c, radius: 2, intensity: 0.5 * s.life };
    if (s.phase === "flight") return { color: c, radius: lv(s, 2.2, 3.6), intensity: 0.95, flicker: 0.35 };
    if (s.phase === "impact") {
      const k = Math.max(0, 1 - s.t / 0.7);
      return { color: [1.0, 0.62, 0.28], radius: lv(s, 3, 5.5), intensity: 2.4 * k * k, flicker: 0.5 };
    }
    return null;
  },
  layers: [
    {
      id: "gather",
      phase: "windup",
      box: () => box.around(14),
      u: (s) => ({ ...ramp(s), uR: orbR(s) }),
      frag: glsl`
uniform float uR; uniform vec3 uC0, uC1, uC2, uC3, uC4;
vec4 effect(vec2 p) {
  float r = uR * (0.3 + 0.7 * uLife);
  float n = vnoise(p * 0.35 + uTime * 12.0 + uSeed * 9.0);
  float e = 1.0 - length(p) / r + (n - 0.5) * 0.5;
  vec3 col = ramp5(uC0, uC1, uC2, uC3, uC4, qz(e * 1.2, p));
  return hot(col, cut(e, 0.05, p)) + glow(uC2 * dglow(0.5 * fall(length(p), r * 2.2), p));
}`,
    },
    {
      id: "orb",
      phase: "flight",
      box: (s) => {
        const R = orbR(s), tail = lv(s, 20, 48) * s.tune.trail;
        return box.along(s, R + 8, tail + R + 10, R + 10);
      },
      u: (s) => ({
        ...ramp(s),
        uR: orbR(s),
        uTail: Math.max(4, Math.min(lv(s, 20, 48) * s.tune.trail, s.len + orbR(s))),
        uSparkN: tier(s, 4) * lv(s, 4, 12),
      }),
      frag: glsl`
uniform float uR, uTail, uSparkN; uniform vec3 uC0, uC1, uC2, uC3, uC4;
vec4 effect(vec2 p) {
  vec2 q = along(p);
  float back = max(-q.x, 0.0);
  float k = clamp(back / uTail, 0.0, 1.0);
  float n = fbm(vec2(q.x * 0.11 + uTime * 7.0, q.y * 0.19) + uSeed * 31.0);
  float head = 1.0 - length(q) / uR;
  float rTail = uR * (1.0 - k) * (0.9 + 0.1 * sin(uTime * 31.0 + q.x * 0.4));
  float tail = q.x < 0.0 ? (1.0 - abs(q.y) / max(rTail, 0.01)) * (1.0 - k) * smoothstep(0.22, 0.58, n + 0.32 * (1.0 - k)) : -1.0;
  float shape = max(head + (n - 0.5) * 0.35, tail + (n - 0.5) * 0.45);
  float E = clamp(shape * (0.85 + 0.55 * uLv) + 0.25 * (1.0 - k), 0.0, 1.0);
  vec3 col = ramp5(uC0, uC1, uC2, uC3, uC4, qz(E, p));
  float cover = cut(shape, 0.02, p);
  vec4 c = hot(col, cover);
  float halo = fall(max(length(q) - uR * 0.7, 0.0), uR * 1.6) * 0.6;
  c += glow(uC2 * dglow(halo, p)) * (1.0 - cover);
  float em = -1.0;
  for (int i = 0; i < 12; i++) {
    if (float(i) >= uSparkN) break;
    vec3 h = hash31(float(i) * 3.7 + uSeed * 17.0);
    float age = fract(uTime * (1.3 + h.x) + h.y);
    vec2 sp = vec2(-uR * 0.6 - age * uTail * (0.8 + 0.6 * h.z), (h.x - 0.5) * uR * 1.7 + sin(age * 7.0 + h.z * 6.0) * 2.5 + age * 5.0);
    if (-sp.x < uLen - 2.0 && age < 0.7 && length(q - sp) < 0.8 + (1.0 - age) * 0.5) em = age / 0.7;
  }
  if (em >= 0.0) c = over(hot(mix(uC4, uC2, em), 1.0), c);
  return c;
}`,
    },
    {
      id: "smoke",
      phase: "impact",
      emissive: false,
      delay: 0.12,
      dur: (s) => lv(s, 0.8, 1.3),
      when: (s) => s.tune.smoke,
      box: (s) => box.column(blastR(s) * 1.6, blastR(s) * 3.2, blastR(s) * 1.2),
      u: (s) => ({ uR: blastR(s) * 1.05, uSoot: rgb(s.tune.soot) }),
      frag: glsl`
uniform float uR; uniform vec3 uSoot;
${SMOKE}
vec4 effect(vec2 p) {
  float dns = smoke(p, uLife, uR, uSeed);
  float n = vnoise(p * 0.18 + uSeed * 4.0);
  vec3 col = uSoot * (0.8 + 0.7 * qz(n, p));
  return paint(col, cut(dns, 0.22, p) * 0.9);
}`,
    },
    {
      id: "blast",
      phase: "impact",
      dur: (s) => lv(s, 0.45, 0.8),
      box: (s) => box.around(blastR(s) * 2.2 + 6),
      u: (s) => ({ ...ramp(s), uR: blastR(s), uSparkN: tier(s, 4) * lv(s, 6, 16) + tier(s, 10) * 8 }),
      frag: glsl`
uniform float uR, uSparkN; uniform vec3 uC0, uC1, uC2, uC3, uC4;
${SPARKS}
vec4 effect(vec2 p) {
  float L = uLife;
  vec2 q = p - vec2(0.0, L * uR * 0.35);
  float grow = 1.0 - pow(1.0 - min(L / 0.35, 1.0), 3.0);
  float R = uR * (0.3 + 0.7 * grow);
  float d = length(q) / R;
  float a = atan(q.y, q.x);
  float n = fbm(vec2(cos(a), sin(a)) * 1.8 + vec2(uSeed * 13.0, -uTime * 1.3) + d * 1.4);
  float shape = 1.0 - d + (n - 0.5) * 0.6;
  float heat = mix(1.3, 0.2, smoothstep(0.08, 1.0, L)) * (0.55 + 0.45 * (1.0 - d));
  float burn = smoothstep(0.4, 1.0, L) * (0.75 + 0.5 * n) * (1.0 - d * 0.55);
  float E = clamp(heat * (0.45 + shape), 0.0, 1.0);
  vec3 col = ramp5(uC0, uC1, uC2, uC3, uC4, qz(E, p));
  float cover = cut(shape - burn, 0.04, p);
  vec4 c = hot(col, cover);
  float flash = (1.0 - smoothstep(0.0, 0.1, L)) * step(length(p), uR * (0.3 + L * 4.0));
  c = over(hot(uC4, flash), c);
  float halo = fall(max(length(q) - R * 0.8, 0.0), R * 0.9) * (1.0 - L) * 0.7;
  c += glow(uC2 * dglow(halo, p)) * (1.0 - cover);
  float sp = sparks(p, uTime, uSparkN, uR * 3.4, uR * 2.6, 0.7, uSeed);
  if (sp > 0.0) c = over(hot(mix(uC1, uC3, sp), 1.0), c);
  return c;
}`,
    },
    {
      id: "ring",
      phase: "impact",
      plane: "ground",
      dur: 0.45,
      when: (s) => s.level >= 7,
      box: (s) => box.ground(s, lv(s, 1.6, 2.6)),
      u: (s) => ({ uR: lv(s, 1.6, 2.6), uC: rgb(s.tune.flame), uC2: rgb(s.tune.core), uTwo: tier(s, 10) }),
      frag: glsl`
uniform float uR, uTwo; uniform vec3 uC, uC2;
${SHOCK}
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float r = shock(g, uLife, uR, 0.22);
  r = max(r, uTwo * shock(g, clamp(uLife * 1.4 - 0.25, 0.0, 1.0), uR * 0.7, 0.18));
  float on = cut(r, 0.4, p);
  return hot(mix(uC, uC2, qz(r, p)), on) + glow(uC * dglow(r * 0.45, p)) * (1.0 - on);
}`,
    },
    {
      id: "scorch",
      phase: "impact",
      plane: "ground",
      emissive: false,
      dur: 2.6,
      box: (s) => box.ground(s, lv(s, 0.55, 1.3)),
      u: (s) => ({ uR: lv(s, 0.55, 1.3), uC: rgb(s.tune.soot) }),
      frag: glsl`
uniform float uR; uniform vec3 uC;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float n = fbm(g * 2.6 + uSeed * 5.0);
  float d = length(g) / uR + (n - 0.5) * 0.7;
  float a = (1.0 - smoothstep(0.55, 1.0, d)) * (1.0 - smoothstep(0.6, 1.0, uLife));
  return paint(uC, cut(a, 0.45, p) * 0.75);
}`,
    },
  ],
});
