import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { FLOW } from "../_shared/snippets.js";

const cols = (s) => ({ uBlood: rgb(s.tune.blood), uDark: rgb(s.tune.dark), uHot: rgb(s.tune.hot) });

export default defineEffect({
  id: "shadow/life_drain",
  name: "Life Drain",
  kind: "beam",
  family: "shadow",
  category: "channel",
  tags: ["channel", "drain", "heal self", "single target"],
  intro: 0.2,
  outro: 0.3,
  thinking: `Life drain is a beam that runs BACKWARDS: the caster is not sending something, it is taking. So the motion is the whole design: red motes are pulled out of the victim and stream along a thin, sagging tether into the caster, where they are swallowed in a pulsing red glow. The tether is dark (a painted crimson thread, not a laser) and wavers like something alive. At the victim, a haze of red rises out of the chest; at the caster, the glow brightens with every mote that arrives. Direction of flow is the one thing a player must never misread, so the motes are the brightest thing on screen.`,
  levels: `1-3: a faint thread and a trickle of motes. 4-6: a steady stream and a red haze rising off the victim. 7-9: a thicker tether and a flood of motes. 10: the tether writhes and the victim bleeds light.`,
  tune: {
    blood: { type: "color", def: "#e0283c", label: "Life" },
    dark: { type: "color", def: "#3a0710", label: "Tether" },
    hot: { type: "color", def: "#ffb0a0", label: "Mote core" },
  },
  light: (s) => ({ color: [1.0, 0.25, 0.3], radius: lv(s, 1.8, 3), intensity: 0.9 * s.fade, at: "from" }),
  layers: [
    {
      id: "tether",
      phase: "sustain",
      box: (s) => box.beam(s, lv(s, 12, 20), 6),
      u: (s) => ({ ...cols(s), uN: Math.round(lv(s, 6, 22)), uAmp: lv(s, 3, 8), uW: lv(s, 0.6, 1.6) }),
      frag: glsl`
uniform float uN, uAmp, uW; uniform vec3 uBlood, uDark, uHot;
${FLOW}
vec4 effect(vec2 p) {
  vec2 q = along(p);
  float L = uLen;
  float reach = L * smoothstep(0.0, 1.0, uTime / 0.2);
  if (q.x < -3.0 || q.x > L + 3.0) return vec4(0.0);
  float k = clamp(q.x / max(L, 1.0), 0.0, 1.0);
  float sag = sin(k * PI) * (2.5 + sin(uTime * 3.0) * 1.2) + sin(q.x * 0.09 - uTime * 5.0) * 1.2 * sin(k * PI);
  float d = abs(q.y + sag);
  vec4 c = vec4(0.0);
  if (q.x > L - reach) c = paint(uDark, step(d, uW) * uFade);
  c += glow(uBlood * dglow(fall(d, 5.0) * 0.35 * uFade, p)) * (1.0 - c.a);
  // motes: from the victim (far end) back to the caster (origin)
  float m = flow(vec2(L - q.x, q.y + sag), vec2(0.0), vec2(L, 0.0), uN, 0.9, uAmp, uTime, uSeed);
  if (m >= 0.0 && uFade > 0.3) c = over(hot(mix(uBlood, uHot, 1.0 - m), 1.0), c);
  return c;
}`,
    },
    {
      id: "haze",
      phase: "sustain",
      at: "to",
      when: (s) => s.level >= 4,
      box: (s) => box.column(s.theight * 0.3, s.theight * 0.55, s.theight * 0.25),
      u: (s) => ({ ...cols(s), uW: s.theight * 0.22 }),
      frag: glsl`
uniform float uW; uniform vec3 uBlood, uDark, uHot;
vec4 effect(vec2 p) {
  float n = fbm(vec2(p.x * 0.12, p.y * 0.08 - uTime * 1.6) + uSeed * 4.0);
  float shape = 1.0 - length(p * vec2(1.0 / uW, 0.05)) + (n - 0.5) * 0.9 - max(p.y, 0.0) * 0.02;
  float v = clamp(shape, 0.0, 1.0) * uFade;
  return glow(uBlood * dglow(v * 0.7, p));
}`,
    },
    {
      id: "absorb",
      phase: "sustain",
      at: "from",
      box: (s) => box.around(16),
      u: (s) => ({ ...cols(s), uR: lv(s, 4, 7) }),
      frag: glsl`
uniform float uR; uniform vec3 uBlood, uDark, uHot;
vec4 effect(vec2 p) {
  float pulse = 0.75 + 0.25 * sin(uTime * 12.0);
  float d = length(p);
  vec4 c = hot(uHot, step(d, uR * 0.4 * pulse) * uFade);
  c = over(hot(uBlood, step(d, uR * pulse) * uFade), c);
  return c + glow(uBlood * dglow(fall(d, uR * 2.4) * 0.6 * uFade, p)) * (1.0 - c.a);
}`,
    },
  ],
});
