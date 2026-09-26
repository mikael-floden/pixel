import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";

const cols = (s) => ({ uLine: rgb(s.tune.line), uGlowC: rgb(s.tune.glow), uDeep: rgb(s.tune.deep) });

export default defineEffect({
  id: "summon/summoning_circle",
  name: "Summoning Circle",
  kind: "zone",
  stage: { anim: "spell_channel" },
  family: "summon",
  category: "summon",
  tags: ["summon", "channel", "ritual"],
  radius: (s) => lv(s, 1.0, 1.6),
  intro: 0.6,
  outro: 0.35,
  dur: 3,
  thinking: `The ritual before a summon: it tells everyone around that something is about to arrive, and exactly where. It is the classic magic circle, drawn on the ground in the iso ellipse: an outer and an inner ring, a star of straight lines joining points on the circle, and marks between the rings, all of which DRAW themselves on the intro (rings sweep round, the star's lines are ruled one after another). While it channels, the rings turn in opposite directions and a glow breathes in the middle. The game stops it the moment the creature appears, and plays Summon Arrival on the same spot.`,
  levels: `1-3: two rings and a five-point star. 4-6: rune marks between the rings. 7-9: a wider circle and a rising haze of light. 10: a second star, turning against the first.`,
  tune: {
    line: { type: "color", def: "#d8e2ff", label: "Lines" },
    glow: { type: "color", def: "#7d8fe8", label: "Glow" },
    deep: { type: "color", def: "#3a3aa8", label: "Deep" },
  },
  light: (s) => ({ color: [0.55, 0.6, 1.0], radius: s.radius + 1, intensity: 0.7 * s.fade }),
  layers: [
    {
      id: "circle",
      plane: "ground",
      fixedScale: true,
      box: (s) => box.ground(s, s.radius * 1.03),
      u: (s) => ({ ...cols(s), uR: s.radius, uRunes: tier(s, 4), uTwo: tier(s, 10) }),
      frag: glsl`
uniform float uR, uRunes, uTwo; uniform vec3 uLine, uGlowC, uDeep;
float segPx(vec2 g, vec2 a, vec2 b) {
  // distance in SCREEN px from ground point g to the ground segment a-b
  vec2 pa = g - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  vec2 d = pa - ba * h;
  vec2 dpx = vec2(dot(vec2(uGround.x, uGround.z), d), dot(vec2(uGround.y, uGround.w), d));
  mat2 M = mat2(uGround.xy, uGround.zw);
  float det = M[0][0] * M[1][1] - M[1][0] * M[0][1];
  mat2 I = mat2(M[1][1], -M[0][1], -M[1][0], M[0][0]) / det;
  return length(I * d);
}
float star(vec2 g, float R, float n, float skip, float rot, float drawn) {
  float m = 99.0;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= n) break;
    if (float(i) / n > drawn) break;
    float a0 = rot + float(i) / n * TAU;
    float a1 = rot + (float(i) + skip) / n * TAU;
    m = min(m, segPx(g, vec2(cos(a0), sin(a0)) * R, vec2(cos(a1), sin(a1)) * R));
  }
  return m;
}
vec4 effect(vec2 p) {
  vec2 g = gnd(p);
  float r = length(g);
  if (r > uR * 1.03) return vec4(0.0);
  float a = ang01(g);
  float intro = clamp(uTime / 0.6, 0.0, 1.0);
  float rot = uTime * 0.25;
  float lines = 0.0;
  lines += step(ringPx(g, uR * 0.98), 0.9) * step(fract(a - rot * 0.16), intro);
  lines += step(ringPx(g, uR * 0.82), 0.7) * step(fract(-a - rot * 0.16), intro);
  lines += step(star(g, uR * 0.82, 5.0, 2.0, rot, intro), 0.7);
  if (uTwo > 0.5) lines += step(star(g, uR * 0.55, 5.0, 2.0, -rot * 1.6 + 0.63, intro), 0.6) + step(ringPx(g, uR * 0.55), 0.6);
  if (uRunes > 0.5) {
    float n = 20.0;
    float ra = fract(a + rot * 0.16);
    float id = floor(ra * n);
    float f = fract(ra * n) - 0.5;
    float mark = step(abs(f), 0.12) * step(abs(r - uR * 0.9), 0.045) * step(0.35, hash11(id + 3.0)) * step(ra, intro);
    lines += mark;
  }
  lines = min(lines, 1.0) * uFade;
  float breathe = (0.2 + 0.12 * sin(uTime * 4.0)) * fall(r, uR * 0.9) * intro * uFade;
  vec4 c = hot(mix(uGlowC, uLine, 0.7), lines);
  return c + glow(uGlowC * dglow(breathe, p)) * (1.0 - lines);
}`,
    },
    {
      id: "haze",
      fixedScale: true,
      when: (s) => s.level >= 7,
      box: (s) => { const b = box.ground(s, s.radius * 0.8, 4); return { w: b.w, h: b.oy + 90, ox: b.ox, oy: b.oy }; },
      u: (s) => ({ ...cols(s), uW: s.radius * 32 }),
      frag: glsl`
uniform float uW; uniform vec3 uLine, uGlowC, uDeep;
vec4 effect(vec2 p) {
  float n = fbm(vec2(p.x * 0.06, p.y * 0.05 - uTime * 0.8) + uSeed * 3.0);
  float v = fall(abs(p.x), uW) * (1.0 - clamp(p.y / 85.0, 0.0, 1.0)) * (0.5 + n) * 0.5 * uFade * step(0.0, p.y);
  return glow(uGlowC * dglow(v, p));
}`,
    },
  ],
});
