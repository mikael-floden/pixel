import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { SPARKS } from "../_shared/snippets.js";

const cols = (s) => ({ uCore: rgb(s.tune.core), uMid: rgb(s.tune.mid), uEdge: rgb(s.tune.edge) });
const W = (s) => lv(s, 3, 6.5);

export default defineEffect({
  id: "arcane/arcane_beam",
  name: "Arcane Beam",
  kind: "beam",
  family: "arcane",
  category: "channel",
  tags: ["channel", "damage", "single target", "beam"],
  intro: 0.14,
  outro: 0.22,
  thinking: `A channelled beam is on screen for seconds, so it has to stay interesting without getting noisy. It is built like a neon tube: a one-pixel white-hot core, a violet body in hard bands, and a dithered magenta fringe, with a slow wobble so it feels like held energy rather than a laser. The motion that tells you it is DOING something is the bright pulses that run from the caster to the target, like a pump. It shoots out from the hand over the intro instead of popping in, thins away on release, and both ends are marked: a charged orb in the caster's hand and a crackling splash on the target, which is also where the light sits, so the target is what gets lit. It follows both bodies every frame (from and to may be functions), so the game only starts it and stops it.`,
  levels: `1-3: a thin wavering violet beam. 4-6: thicker, with energy pulses racing to the target and sparks at the hit. 7-9: a second strand twists around the beam as a helix. 10: a wide, blazing beam with a double helix and a heavy splash.`,
  tune: {
    core: { type: "color", def: "#fbeaff", label: "Core" },
    mid: { type: "color", def: "#b36bff", label: "Beam" },
    edge: { type: "color", def: "#5a2bd6", label: "Fringe" },
  },
  light: (s) => ({ color: [0.72, 0.45, 1.0], radius: lv(s, 2.2, 3.5), intensity: 1.2 * s.fade, flicker: 0.25, at: "to" }),
  layers: [
    {
      id: "beam",
      phase: "sustain",
      box: (s) => box.beam(s, W(s) * 2.6 + 8, 6),
      u: (s) => ({ ...cols(s), uW: W(s), uPulse: tier(s, 4), uHelix: tier(s, 7) + tier(s, 10) }),
      frag: glsl`
uniform float uW, uPulse, uHelix; uniform vec3 uCore, uMid, uEdge;
vec4 effect(vec2 p) {
  vec2 q = along(p);
  float L = uLen;
  float reach = L * smoothstep(0.0, 1.0, uTime / 0.14);
  if (q.x < -4.0 || q.x > reach + 3.0) return vec4(0.0);
  float k = clamp(q.x / max(L, 1.0), 0.0, 1.0);
  float env = smoothstep(0.0, 0.06, k) * smoothstep(1.0, 0.94, k);
  float wob = sin(q.x * 0.07 - uTime * 9.0 + uSeed * 6.0) * 1.6 * env + sin(q.x * 0.19 + uTime * 13.0) * 0.6 * env;
  float y = q.y - wob;
  float w = uW * uFade * (0.85 + 0.15 * sin(uTime * 23.0 + q.x * 0.05));
  float pulse = uPulse * fall(abs(fract(k * 3.0 - uTime * 2.2) - 0.5) * 2.0, 0.35);
  w *= 1.0 + 0.55 * pulse;
  float d = abs(y);
  float core = step(d, max(0.6, w * 0.22));
  float body = step(d, w * 0.62);
  float fringe = fall(d, w * 1.9) * 0.8;
  vec3 col = mix(uMid, uCore, qz(0.3 + pulse * 0.7, p));
  vec4 c = hot(uCore, core);
  c = over(hot(col, body * (1.0 - core)), c);
  c += glow(uEdge * dglow(fringe, p)) * (1.0 - c.a);
  for (int i = 0; i < 2; i++) {
    if (float(i) >= uHelix) break;
    float ph = float(i) * PI;
    float hy = sin(q.x * 0.21 - uTime * 11.0 + ph) * w * 1.5 * env;
    float front = cos(q.x * 0.21 - uTime * 11.0 + ph);
    float hd = abs(q.y - wob - hy);
    if (hd < 0.8 && (front > 0.0 || body < 0.5)) c = over(hot(mix(uMid, uCore, 0.6), 1.0), c);
  }
  return c * step(-4.0, q.x);
}`,
    },
    {
      id: "source",
      phase: "sustain",
      at: "from",
      box: (s) => box.around(W(s) * 3 + 6),
      u: (s) => ({ ...cols(s), uR: W(s) * 1.2 + 1 }),
      frag: glsl`
uniform float uR; uniform vec3 uCore, uMid, uEdge;
vec4 effect(vec2 p) {
  float r = uR * uFade * (0.9 + 0.1 * sin(uTime * 30.0));
  float d = length(p);
  vec4 c = hot(uCore, step(d, r * 0.55));
  c = over(hot(uMid, step(d, r) * (1.0 - step(d, r * 0.55))), c);
  float ring = step(abs(d - r * 1.8 - sin(uTime * 8.0) * 1.2), 0.6) * step(0.5, fract(ang01(p) * 6.0 + uTime * 1.5));
  c = over(hot(uEdge, ring * uFade), c);
  return c + glow(uMid * dglow(fall(d, r * 2.6) * 0.6 * uFade, p)) * (1.0 - c.a);
}`,
    },
    {
      id: "splash",
      phase: "sustain",
      at: "to",
      sort: () => 0.2,
      box: (s) => box.around(W(s) * 5 + 22),
      u: (s) => ({ ...cols(s), uR: W(s) * 2.2 + 4, uN: tier(s, 4) * Math.round(lv(s, 4, 12)) }),
      frag: glsl`
uniform float uR, uN; uniform vec3 uCore, uMid, uEdge;
${SPARKS}
vec4 effect(vec2 p) {
  float a = atan(p.y, p.x);
  float tq = floor(uTime * 18.0);
  float spikes = 0.5 + 0.5 * sin(a * 7.0 + hash11(tq + uSeed) * 6.0);
  float r = uR * uFade * (0.7 + 0.5 * spikes * hash11(tq * 1.3 + floor(a * 1.1)));
  float d = length(p);
  vec4 c = hot(uCore, step(d, uR * 0.35 * uFade));
  c = over(hot(uMid, step(d, r) * step(0.35, spikes)), c);
  float sp = sparks(p, fract(uTime * 1.6) * 0.62, uN, 70.0, 120.0, 0.0, uSeed + floor(uTime * 1.6));
  if (sp > 0.0) c = over(hot(mix(uMid, uCore, sp), uFade), c);
  return c + glow(uEdge * dglow(fall(d, uR * 1.8) * 0.5 * uFade, p)) * (1.0 - c.a);
}`,
    },
  ],
});
