import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";

const cols = (s) => ({ uEdge: rgb(s.tune.edge), uHex: rgb(s.tune.hex), uDeep: rgb(s.tune.deep) });

// The bubble: an ellipsoid around the body. BACK draws the far shell behind
// the body, FRONT the near shell over it (mostly empty in the middle).
const BUBBLE = glsl`
uniform float uRx, uRy, uHalf, uHexOn; uniform vec3 uEdge, uHex, uDeep;
vec4 effect(vec2 p) {
  float intro = smoothstep(0.0, 1.0, uTime / 0.3);
  vec2 q = (p - vec2(0.0, uRy * 0.92)) / vec2(uRx, uRy) / max(intro, 0.05);
  float d = length(q);
  if (d > 1.0) return vec4(0.0);
  float rim = smoothstep(0.72, 1.0, d);
  float shell = pow(max(d, 0.0), 6.0);
  vec4 c = vec4(0.0);
  float stop = uFade;
  // BACK: only the shell's inner glow, which the body cuts out of
  if (uHalf > 0.0) return glow(uDeep * dglow(shell * 0.5 * stop, p));
  // FRONT: the rim and the hex shimmer, the middle left clear
  if (uHexOn > 0.5) {
    vec2 hp = q * 7.0;
    hp.y += hp.x * 0.5;
    vec2 cell = floor(hp);
    vec2 f = fract(hp) - 0.5;
    float edge = step(0.4, max(abs(f.x), abs(f.y)));
    float wave = fract(uTime * 0.45 + hash12(cell) * 0.25 - q.y * 0.35);
    float lit = step(0.9, wave) * edge;
    c = hot(uHex, lit * 0.9 * stop);
  }
  float line = step(0.93, d);
  c = over(hot(uEdge, line * stop), c);
  c += glow(uDeep * dglow(rim * 0.3 * stop, p)) * (1.0 - c.a);
  return c;
}`;

export default defineEffect({
  id: "arcane/arcane_shield",
  name: "Arcane Shield",
  kind: "aura",
  family: "arcane",
  category: "buff",
  tags: ["shield", "buff", "absorb", "defensive"],
  intro: 0.3,
  outro: 0.35,
  demo: { on: "caster", hold: 2.6 },
  thinking: `A shield has to be visible around the body without hiding it, so it is a bubble drawn almost entirely in its RIM: a bright one-pixel outline, a glow that thickens toward the edge (the way light gathers at the silhouette of a glass sphere) and nothing in the middle. The far half of the bubble is drawn behind the body and the near half in front, so it reads as a volume the hero stands inside. From level 4 a hex lattice shimmers over the shell in slow waves, which is what makes it read as a force field rather than a soap bubble. It inflates from the body on the intro and snaps away on release.`,
  levels: `1-3: a thin rim and edge glow. 4-6: a hex lattice shimmers over the shell. 7-9: a larger, brighter bubble. 10: a thick, bright barrier.`,
  tune: {
    edge: { type: "color", def: "#dff1ff", label: "Rim" },
    hex: { type: "color", def: "#8fc9ff", label: "Lattice" },
    deep: { type: "color", def: "#3d7bff", label: "Glow" },
  },
  light: (s) => ({ color: [0.55, 0.75, 1.0], radius: lv(s, 1.6, 2.6), intensity: 0.55 * s.fade }),
  layers: ["back", "front"].map((half) => ({
    id: `bubble_${half}`,
    sort: () => (half === "back" ? -0.4 : 0.4),
    box: (s) => box.column(s.height * lv(s, 0.42, 0.55) + 3, s.height * lv(s, 1.12, 1.32) + 4, 4),
    u: (s) => ({ ...cols(s), uRx: s.height * lv(s, 0.4, 0.52), uRy: s.height * lv(s, 0.56, 0.66), uHalf: half === "back" ? 1 : -1, uHexOn: tier(s, 4) }),
    frag: BUBBLE,
  })),
});
