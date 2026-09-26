import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";

const cols = (s) => ({ uGas: rgb(s.tune.gas), uDark: rgb(s.tune.dark), uLight: rgb(s.tune.light) });

// Gas puffs drifting over the area: back half / front half of the zone.
const GAS = glsl`
uniform float uR, uN, uHalf; uniform vec4 uB; uniform vec3 uGas, uDark, uLight;
vec4 effect(vec2 p) {
  float dens = 0.0; float shade = 0.0;
  for (int i = 0; i < 14; i++) {
    if (float(i) >= uN) break;
    vec3 h = hash31(float(i) * 4.3 + uSeed * 11.0);
    float th = h.x * TAU + uTime * (0.12 + 0.1 * h.z) * (h.y > 0.5 ? 1.0 : -1.0);
    vec2 g = vec2(cos(th), sin(th)) * uR * (0.1 + 0.72 * sqrt(h.y));
    vec2 base = vec2(g.x * uB.x + g.y * uB.z, -(g.x * uB.y + g.y * uB.w));
    if (base.y * uHalf < 0.0) continue;
    float pr = 22.0 + 14.0 * h.z;
    vec2 at = base + vec2(0.0, pr * 0.55 + sin(uTime * 0.8 + h.x * 6.0) * 2.0);
    vec2 q = (p - at) / pr;
    float n = fbm(q * 1.6 + vec2(h.z * 9.0, uTime * 0.25));
    float d = length(q * vec2(1.0, 1.35));
    float v = (1.0 - d) * 1.3 + (n - 0.5) * 1.1;
    if (v > dens) { dens = v; shade = q.y + (n - 0.5); }
  }
  dens *= uFade;
  if (dens < 0.2) return vec4(0.0);
  vec3 col = shade > 0.25 ? uLight : (shade > -0.2 ? uGas : uDark);
  return hot(col * 0.8, cut(dens, 0.3, p) * 0.62);
}`;

export default defineEffect({
  id: "poison/toxic_cloud",
  name: "Toxic Cloud",
  kind: "zone",
  family: "poison",
  category: "attack",
  tags: ["aoe", "zone", "damage over time", "gas"],
  radius: (s) => lv(s, 1.4, 2.6),
  intro: 0.5,
  outro: 0.7,
  dur: 6,
  thinking: `A gas cloud must show where it is dangerous and still let the player see through it. It is built from a handful of fat, lumpy puffs that drift slowly around the zone's centre, each lit from above (a pale top, a sickly middle, a dark underside) like pixel-art smoke. The puffs are a little more than half opaque, so bodies inside are veiled but readable, and they sit on a stained patch of ground at exactly the zone's radius, the honest edge a player can step out of. Half the puffs stand behind the bodies inside and half in front. The gas glows faintly, a miasma: a danger zone you cannot see at night would be unfair, so it never goes dark. Bubbles rise and pop out of the stain.`,
  levels: `1-3: a few thin puffs over a faint stain. 4-6: a fuller cloud and popping bubbles. 7-9: a wide, dense cloud. 10: a choking fog bank.`,
  tune: {
    gas: { type: "color", def: "#7fbf3a", label: "Gas" },
    dark: { type: "color", def: "#35601f", label: "Shadow" },
    light: { type: "color", def: "#c9f07a", label: "Highlight" },
  },
  light: (s) => ({ color: [0.5, 0.95, 0.25], radius: s.radius + 0.5, intensity: 0.25 * s.fade }),
  layers: [
    {
      id: "stain",
      plane: "ground",
      emissive: false,
      fixedScale: true,
      box: (s) => box.ground(s, s.radius * 1.05),
      u: (s) => ({ ...cols(s), uR: s.radius }),
      frag: glsl`
uniform float uR; uniform vec3 uGas, uDark, uLight;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float n = fbm(g * 1.4 + uSeed * 3.0);
  float d = length(g) / uR + (n - 0.5) * 0.25;
  float a = (1.0 - smoothstep(0.85, 1.0, d)) * uFade;
  return paint(mix(uDark, uGas, qz(n * 0.7, p)), cut(a, 0.4, p) * 0.45);
}`,
    },
    {
      id: "bubbles",
      plane: "ground",
      fixedScale: true,
      when: (s) => s.level >= 4,
      box: (s) => box.ground(s, s.radius),
      u: (s) => ({ ...cols(s), uR: s.radius }),
      frag: glsl`
uniform float uR; uniform vec3 uGas, uDark, uLight;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  vec4 c = vec4(0.0);
  for (int i = 0; i < 10; i++) {
    vec3 h = hash31(float(i) * 6.1 + uSeed * 2.0 + floor(uTime * 0.7 + hash11(float(i))) * 0.37);
    float cyc = fract(uTime * 0.7 + hash11(float(i)));
    vec2 at = (h.xy - 0.5) * 2.0 * uR * 0.8;
    if (length(at) > uR * 0.85) continue;
    float r = 0.05 + 0.1 * cyc;
    c = over(hot(uLight, step(ringPx(g - at, r), 0.6) * step(cyc, 0.9) * uFade), c);
  }
  return c;
}`,
    },
    ...["back", "front"].map((half) => ({
      id: `gas_${half}`,
      fixedScale: true,
      sort: (s) => (half === "back" ? -s.radius : s.radius),
      box: (s) => {
        const b = box.ground(s, s.radius, 30);
        return half === "back" ? { w: b.w + 40, h: b.h / 2 + 76, ox: b.ox + 20, oy: 4 } : { w: b.w + 40, h: b.oy + 76, ox: b.ox + 20, oy: b.oy };
      },
      u: (s) => ({ ...cols(s), uR: s.radius, uN: Math.round(lv(s, 7, 14)), uHalf: half === "back" ? 1 : -1, uB: s.basis }),
      frag: GAS,
    })),
  ],
});
