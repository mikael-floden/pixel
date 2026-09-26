import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { BOLT, SPARKS } from "../_shared/snippets.js";

const cols = (s) => ({ uCore: rgb(s.tune.core), uGlow: rgb(s.tune.glow), uDeep: rgb(s.tune.deep) });

export default defineEffect({
  id: "storm/chain_lightning",
  name: "Chain Lightning",
  kind: "chain",
  family: "storm",
  category: "attack",
  tags: ["damage", "multi target", "bounce", "instant"],
  hopDelay: (s) => lv(s, 0.14, 0.1),
  hopDur: (s) => lv(s, 0.3, 0.42),
  thinking: `Chain lightning is a story told in hops: the eye has to follow it from the caster to the first victim, then to the next and the next, so each hop gets its own arc that appears a beat after the last one lands (the game gets a "hop" event per target to apply damage in the same rhythm). Each arc is a jagged bolt that re-rolls its path every few frames, flickers out, and leaves a spark burst on the body it hit. The arcs connect chest to chest, and the light slot follows the newest hop, so a chain racing through a dark forest lights each victim in turn.`,
  levels: `1-3: a thin, quick arc per hop. 4-6: brighter arcs, bigger impact sparks. 7-9: a second forked strand on every hop. 10: thick arcs that linger and crackle between the victims after the chain has passed.`,
  tune: {
    core: { type: "color", def: "#ffffff", label: "Core" },
    glow: { type: "color", def: "#9ad1ff", label: "Glow" },
    deep: { type: "color", def: "#4f6bff", label: "Deep glow" },
  },
  light: (s) => ({ color: [0.75, 0.88, 1.0], radius: lv(s, 2.5, 4), intensity: 1.8, flicker: 1, at: "target" }),
  layers: [
    {
      id: "arc",
      phase: "hop",
      box: (s) => box.beam(s, 26, 6),
      u: (s) => ({ ...cols(s), uW: lv(s, 1, 1.7), uFork: tier(s, 7), uLinger: tier(s, 10) }),
      frag: glsl`
uniform float uW, uFork, uLinger; uniform vec3 uCore, uGlow, uDeep;
${BOLT}
vec4 effect(vec2 p) {
  vec2 q = along(p);
  float L = uLife;
  float alive = L < 0.4 ? 1.0 : step(0.5, fract(uTime * 22.0)) * (1.0 - smoothstep(0.4 + 0.3 * uLinger, 1.0, L));
  if (alive < 0.5) return vec4(0.0);
  float tq = floor(uTime / 0.05);
  float seg = max(3.0, uLen / 12.0);
  float d = bolt(q, vec2(0.0), vec2(uLen, 0.0), seg, 9.0, tq, uSeed);
  if (uFork > 0.5) d = min(d, bolt(q, vec2(0.0), vec2(uLen, 0.0), seg * 0.7, 14.0, tq + 3.0, uSeed + 5.0) + 0.6);
  float core = step(d, 0.7 * uW);
  vec4 c = hot(uCore, core);
  c += glow(uGlow * dglow(fall(d, 3.5 * uW), p) + uDeep * dglow(fall(d, 9.0 * uW) * 0.5, p)) * (1.0 - core);
  return c;
}`,
    },
    {
      id: "impact",
      phase: "impact",
      dur: 0.45,
      box: (s) => box.around(lv(s, 26, 44)),
      u: (s) => ({ ...cols(s), uR: lv(s, 7, 14), uN: Math.round(lv(s, 5, 14)) }),
      frag: glsl`
uniform float uR, uN; uniform vec3 uCore, uGlow, uDeep;
${SPARKS}
vec4 effect(vec2 p) {
  float L = uLife;
  float d = length(p);
  float flash = step(d, uR * (1.0 - L)) * step(L, 0.35);
  float ring = step(abs(d - uR * (0.6 + 1.4 * L)), 0.8) * (1.0 - step(0.6, L));
  vec4 c = hot(uCore, flash);
  c = over(hot(uGlow, ring), c);
  float sp = sparks(p, uTime, uN, 120.0, 200.0, 0.5, uSeed);
  if (sp > 0.0) c = over(hot(mix(uGlow, uCore, sp), 1.0), c);
  return c + glow(uDeep * dglow(fall(d, uR * 2.2) * (1.0 - L) * 0.6, p)) * (1.0 - c.a);
}`,
    },
  ],
});
