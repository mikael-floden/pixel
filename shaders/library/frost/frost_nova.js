import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";

const R = (s) => s.radius; // cells: the game's AoE radius, or the level default
const cols = (s) => ({ uIce: rgb(s.tune.ice), uDeep: rgb(s.tune.deep), uRime: rgb(s.tune.rime) });

// One ice-spike ring, drawn as two halves: the back half sorts behind the
// caster, the front half in front of it. uHalf = +1 back (screen-up), -1 front.
const SPIKES = glsl`
uniform float uR, uN, uH, uHalf; uniform vec4 uB; uniform vec3 uIce, uDeep, uRime;
vec4 effect(vec2 p) {
  float fade = 1.0 - smoothstep(0.6, 1.0, uLife);
  vec4 c = vec4(0.0);
  for (int i = 0; i < 28; i++) {
    if (float(i) >= uN) break;
    vec3 h = hash31(float(i) * 5.31 + uSeed * 40.0);
    float th = (float(i) + h.x * 0.6) / uN * TAU;
    vec2 g = vec2(cos(th), sin(th)) * uR * (0.82 + 0.18 * h.y);
    vec2 base = vec2(g.x * uB.x + g.y * uB.z, -(g.x * uB.y + g.y * uB.w));
    if (base.y * uHalf < 0.0) continue;
    float arrive = 0.4 * (1.0 - pow(max(1.0 - length(g) / max(uR, 0.01), 0.0), 0.4545));
    float t = clamp((uLife - arrive) / 0.1, 0.0, 1.0);
    float hgt = uH * (0.55 + 0.45 * h.z) * t * clamp(fade * 1.4 - h.y * 0.4, 0.0, 1.0);
    if (hgt < 1.0) continue;
    float lean = (h.x - 0.5) * 0.5;
    vec2 q = p - base;
    q.x -= q.y * lean;
    float W = 2.5 + 2.5 * h.y;
    float w = W * (1.0 - q.y / max(hgt, 0.01));
    if (q.y >= -1.0 && q.y <= hgt && abs(q.x) <= w) {
      float split = -0.25 * w;
      vec3 col = q.x < split ? uRime : (q.x < w * 0.45 ? uIce : uDeep);
      if (abs(q.x) > w - 1.0) col = q.x < 0.0 ? uRime : uDeep * 0.8;
      if (q.y > hgt - 2.0) col = uRime;
      c = over(hot(col, 1.0), c);
    }
  }
  return c;
}`;

export default defineEffect({
  id: "frost/frost_nova",
  name: "Frost Nova",
  kind: "burst",
  stage: { target: "monster", reach: 1.9, anim: "spell_channel" },
  family: "frost",
  category: "attack",
  tags: ["aoe", "damage", "slow", "self-centered"],
  radius: (s) => lv(s, 1.6, 3.2),
  demo: { on: "caster" },
  thinking: `A nova has to show its reach, because the reach is the gameplay: the ring that races out over the ground IS the radius the game hits, so it is drawn on the ground plane in the game's own iso ellipse and takes the game's radius when one is given. Frost reads as brittle and sharp, the opposite of fire's billow, so everything here is hard-edged: a crisp rime ring, a frosted floor with a cracked crystal pattern left behind, and (from level 4) a crown of ice spikes that shoot up along the ring and then fall away. The spikes are split into a back half and a front half so they stand behind and in front of the caster correctly. Colours are cold and few (deep blue, ice, white rime) and the light is a short pale-cyan flash, so a nova in a dark cave lights the room for a heartbeat.`,
  levels: `1-3: a thin rime ring and a light frost on the floor. 4-6: ice spikes burst up along the ring. 7-9: a wider ring, taller spikes, a second inner ring and drifting frost glitter. 10: a full crown of spikes and a frozen crystal floor that lingers.`,
  tune: {
    ice: { type: "color", def: "#8fdcf5", label: "Ice" },
    deep: { type: "color", def: "#2f6fb3", label: "Deep ice" },
    rime: { type: "color", def: "#f2fbff", label: "Rime" },
  },
  dur: (s) => lv(s, 0.9, 1.5),
  light: (s) => {
    const k = Math.max(0, 1 - s.t / 0.5);
    return { color: [0.6, 0.85, 1.0], radius: s.radius + 1.2, intensity: 1.6 * k * k };
  },
  layers: [
    {
      id: "floor",
      plane: "ground",
      fixedScale: true,
      box: (s) => box.ground(s, R(s) * 1.08),
      u: (s) => ({ ...cols(s), uR: R(s), uCrys: tier(s, 10) }),
      frag: glsl`
uniform float uR, uCrys; uniform vec3 uIce, uDeep, uRime;
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float r = length(g);
  float front = uR * (1.0 - pow(1.0 - min(uLife / 0.4, 1.0), 2.2));
  if (r > front + 0.05) return vec4(0.0);
  float fade = 1.0 - smoothstep(0.55 + 0.25 * uCrys, 1.0, uLife);
  vec3 v = voronoi(g * 2.6 + uSeed * 9.0);
  float crack = 1.0 - smoothstep(0.02, 0.07, v.y);
  float frost = (0.35 + 0.35 * v.z) * (1.0 - r / (uR * 1.05));
  float ring = 1.0 - smoothstep(0.0, 0.16, abs(r - front));
  vec3 col = mix(uDeep, uIce, qz(frost * 1.6, p));
  vec4 c = paint(col, cut(frost + crack * 0.5, 0.18, p) * 0.55 * fade);
  c = over(hot(uRime, cut(crack * frost * 2.0, 0.35, p) * 0.8 * fade), c);
  c = over(hot(mix(uIce, uRime, 0.6), cut(ring, 0.45, p) * (1.0 - smoothstep(0.35, 0.6, uLife))), c);
  return c;
}`,
    },
    {
      id: "ring2",
      plane: "ground",
      fixedScale: true,
      delay: 0.12,
      dur: 0.5,
      when: (s) => s.level >= 7,
      box: (s) => box.ground(s, R(s) * 0.75),
      u: (s) => ({ ...cols(s), uR: R(s) * 0.7 }),
      frag: glsl`
uniform float uR; uniform vec3 uIce, uDeep, uRime;
vec4 effect(vec2 p) {
  float r = length(gnd(p));
  float front = uR * (1.0 - pow(1.0 - uLife, 2.4));
  float ring = (1.0 - smoothstep(0.0, 0.12, abs(r - front))) * (1.0 - uLife);
  return hot(uRime, cut(ring, 0.4, p)) + glow(uIce * dglow(ring * 0.5, p));
}`,
    },
    {
      id: "spikes_back",
      plane: "body",
      fixedScale: true,
      sort: (s) => -R(s),
      when: (s) => s.level >= 4,
      box: (s) => {
        const b = box.ground(s, R(s) * 1.05, 6);
        return { w: b.w, h: b.h / 2 + lv(s, 20, 38) + 6, ox: b.ox, oy: 0 };
      },
      u: (s) => ({ ...cols(s), uR: R(s), uN: Math.round(lv(s, 12, 26)), uH: lv(s, 16, 34), uHalf: 1, uB: s.basis }),
      frag: SPIKES,
    },
    {
      id: "spikes_front",
      plane: "body",
      fixedScale: true,
      sort: (s) => R(s),
      when: (s) => s.level >= 4,
      box: (s) => {
        const b = box.ground(s, R(s) * 1.05, 6);
        return { w: b.w, h: b.oy + lv(s, 20, 38) + 6, ox: b.ox, oy: b.oy };
      },
      u: (s) => ({ ...cols(s), uR: R(s), uN: Math.round(lv(s, 12, 26)), uH: lv(s, 16, 34), uHalf: -1, uB: s.basis }),
      frag: SPIKES,
    },
    {
      id: "glitter",
      plane: "air",
      fixedScale: true,
      dur: (s) => lv(s, 0.9, 1.5),
      when: (s) => s.level >= 7,
      box: (s) => {
        const b = box.ground(s, R(s), 4);
        return { w: b.w, h: b.h + 40, ox: b.ox, oy: b.oy };
      },
      u: (s) => ({ ...cols(s), uR: R(s), uB: s.basis }),
      frag: glsl`
uniform float uR; uniform vec4 uB; uniform vec3 uIce, uDeep, uRime;
vec4 effect(vec2 p) {
  vec4 c = vec4(0.0);
  for (int i = 0; i < 22; i++) {
    vec3 h = hash31(float(i) * 2.9 + uSeed * 13.0);
    float th = h.x * TAU; float rr = uR * sqrt(h.y);
    vec2 g = vec2(cos(th), sin(th)) * rr;
    vec2 base = vec2(g.x * uB.x + g.y * uB.z, -(g.x * uB.y + g.y * uB.w));
    float t = uLife * 1.3 - h.z * 0.3;
    if (t < 0.0 || t > 1.0) continue;
    vec2 at = base + vec2(sin(t * 5.0 + h.z * 9.0) * 3.0, t * 26.0);
    vec2 q = abs(p - at);
    float tw = step(0.5, fract(uTime * 7.0 + h.z));
    float star = (q.x < 0.6 && q.y < 1.6 + tw) || (q.y < 0.6 && q.x < 1.6 + tw) ? 1.0 : 0.0;
    c = over(hot(uRime, star * (1.0 - t)), c);
  }
  return c;
}`,
    },
  ],
});
