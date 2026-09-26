import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";

const cols = (s) => ({ uLight: rgb(s.tune.light), uLifeC: rgb(s.tune.life), uDeep: rgb(s.tune.deep) });

// motes rising out of the circle's area: back half / front half
const RISE = glsl`
uniform float uR, uN, uHalf; uniform vec4 uB; uniform vec3 uLight, uLifeC, uDeep;
vec4 effect(vec2 p) {
  vec4 c = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    if (float(i) >= uN) break;
    vec3 h = hash31(float(i) * 3.9 + uSeed * 17.0);
    float cyc = fract(uTime * (0.35 + 0.25 * h.z) + h.x);
    float th = h.y * TAU + floor(uTime * (0.35 + 0.25 * h.z) + h.x) * 2.4;
    vec2 g = vec2(cos(th), sin(th)) * uR * sqrt(fract(h.x * 7.7 + floor(uTime * (0.35 + 0.25 * h.z) + h.x) * 0.37));
    vec2 base = vec2(g.x * uB.x + g.y * uB.z, -(g.x * uB.y + g.y * uB.w));
    if (base.y * uHalf < 0.0) continue;
    vec2 at = base + vec2(sin(cyc * 6.0 + h.z * 7.0) * 2.0, cyc * 44.0);
    vec2 q = abs(p - at);
    float big = step(0.7, h.z);
    float on = big > 0.5 ? ((q.x < 0.6 && q.y < 1.6) || (q.y < 0.6 && q.x < 1.6) ? 1.0 : 0.0) : step(max(q.x, q.y), 0.6);
    c = over(hot(mix(uLifeC, uLight, big), on * step(cyc, 0.9)), c);
  }
  return c * uFade;
}`;

export default defineEffect({
  id: "holy/healing_circle",
  name: "Healing Circle",
  kind: "zone",
  stage: { target: null, at: "caster", anim: "spell_channel" },
  family: "holy",
  category: "heal",
  tags: ["heal", "aoe", "zone", "support", "over time"],
  radius: (s) => lv(s, 1.8, 3),
  intro: 0.45,
  outro: 0.5,
  dur: 6,
  thinking: `A zone lasts, so its first job is to show exactly where it is: allies must be able to step into it in the middle of a fight. The rim is therefore a crisp double ring with rune marks between the rings, drawn on the ground at the game's radius, and it draws itself around the circle on the intro like a stroke of chalk (the moment you see the spell being CAST). Inside, a faint dithered fill and a soft pulse that rolls outward every second give it a heartbeat, the rhythm of healing ticks. Gentle motes float up across the area, half behind and half in front of anyone standing in it. It stays quiet enough to stand in for six seconds and still see the fight.`,
  levels: `1-3: a plain rim and a faint fill. 4-6: rune marks turn slowly between the rings and motes rise. 7-9: a stronger pulse and more motes. 10: a second, counter-rotating ring of runes.`,
  tune: {
    light: { type: "color", def: "#fff0a8", label: "Light" },
    life: { type: "color", def: "#86e07a", label: "Life" },
    deep: { type: "color", def: "#2f9e62", label: "Deep" },
  },
  light: (s) => ({ color: [0.85, 1.0, 0.6], radius: s.radius + 0.8, intensity: 0.55 * s.fade }),
  layers: [
    {
      id: "circle",
      plane: "ground",
      fixedScale: true,
      box: (s) => box.ground(s, s.radius * 1.02),
      u: (s) => ({ ...cols(s), uR: s.radius, uRunes: tier(s, 4), uTwo: tier(s, 10), uPulse: lv(s, 0.2, 0.45) }),
      frag: glsl`
uniform float uR, uRunes, uTwo, uPulse; uniform vec3 uLight, uLifeC, uDeep;
float rune(vec2 q, float id) {
  vec3 h = hash31(id * 5.7);
  float v = step(abs(q.x), 0.028) * step(abs(q.y), 0.1);
  float hbar = step(abs(q.y - (h.x - 0.5) * 0.12), 0.03) * step(abs(q.x), 0.07);
  float dia = step(abs(abs(q.x) + abs(q.y - 0.02) - 0.075), 0.022) * step(0.5, h.y);
  return max(v, max(hbar, dia));
}
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float r = length(g);
  if (r > uR * 1.02) return vec4(0.0);
  float a = ang01(g);
  float drawn = step(a, uTime / 0.45);
  float rim = step(ringPx(g, uR * 0.97), 1.0) + step(ringPx(g, uR * 0.8), 0.6);
  float c1 = 0.0;
  if (uRunes > 0.5) {
    float rot = a + uTime * 0.03;
    float n = 18.0;
    float id = floor(rot * n);
    vec2 q = vec2((fract(rot * n) - 0.5) * TAU * uR * 0.885 / n, r - uR * 0.885);
    c1 = rune(q, id);
  }
  float c2 = 0.0;
  if (uTwo > 0.5) {
    float rot = a - uTime * 0.05;
    float n = 12.0;
    float id = floor(rot * n) + 40.0;
    vec2 q = vec2((fract(rot * n) - 0.5) * TAU * uR * 0.62 / n, r - uR * 0.62);
    c2 = rune(q, id) + step(ringPx(g, uR * 0.52), 0.6);
  }
  float pulseR = fract(uTime * 0.85) * uR;
  float pulse = (1.0 - smoothstep(0.0, 0.16, abs(r - pulseR))) * uPulse * (1.0 - pulseR / uR);
  float fill = 0.16 + 0.1 * sin(uTime * 3.0);
  float lines = min(1.0, rim + c1 + c2) * drawn * uFade;
  vec4 c = hot(mix(uLifeC, uLight, 0.55), lines);
  float soft = (fill * fall(r, uR * 1.1) + pulse) * uFade * step(0.0, uTime - 0.2);
  c += glow(uLifeC * dglow(soft, p)) * (1.0 - lines);
  return c;
}`,
    },
    { id: "rise_back", fixedScale: true, sort: (s) => -s.radius, when: (s) => s.level >= 4, box: (s) => { const b = box.ground(s, s.radius, 4); return { w: b.w, h: b.h / 2 + 52, ox: b.ox, oy: 0 }; }, u: (s) => ({ ...cols(s), uR: s.radius, uN: Math.round(lv(s, 6, 22)), uHalf: 1, uB: s.basis }), frag: RISE },
    { id: "rise_front", fixedScale: true, sort: (s) => s.radius, when: (s) => s.level >= 4, box: (s) => { const b = box.ground(s, s.radius, 4); return { w: b.w, h: b.oy + 52, ox: b.ox, oy: b.oy }; }, u: (s) => ({ ...cols(s), uR: s.radius, uN: Math.round(lv(s, 6, 22)), uHalf: -1, uB: s.basis }), frag: RISE },
  ],
});
