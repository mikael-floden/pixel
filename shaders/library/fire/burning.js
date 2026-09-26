import { defineEffect, lv, tier, rgb, mix3, scale3, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { FLAME } from "../_shared/snippets.js";

const ramp = (s) => {
  const core = rgb(s.tune.core), flame = rgb(s.tune.flame), ember = rgb(s.tune.ember);
  return { uC0: scale3(ember, 0.5), uC1: ember, uC2: flame, uC3: mix3(flame, core, 0.55), uC4: core };
};

// BACK: a tall sheet of fire behind the body — the body cuts it into a burning
// silhouette. FRONT: low flames at the feet, flames caught on the body, embers.
const FIRE = glsl`
uniform float uW, uH, uHalf, uLicks, uEmbers;
uniform vec3 uC0, uC1, uC2, uC3, uC4;
${FLAME}
vec4 effect(vec2 p) {
  float f = -1.0;
  float y = clamp(p.y / uH, 0.0, 1.0);
  if (uHalf > 0.0) {
    f = flameField(p, uW, uH, uTime, uSeed);
  } else {
    f = max(flameField(p + vec2(uW * 0.6, 0.0), uW * 0.38, uH * 0.42, uTime * 1.15, uSeed + 3.0),
            flameField(p - vec2(uW * 0.6, 0.0), uW * 0.38, uH * 0.38, uTime * 1.2, uSeed + 5.0));
    f = max(f, flameField(p, uW * 0.55, uH * 0.13, uTime * 1.3, uSeed + 7.0));
    for (int i = 0; i < 2; i++) {
      if (float(i) >= uLicks) break;
      float sx = i == 0 ? -1.0 : 1.0;
      f = max(f, flameField(p - vec2(sx * uW * 0.34, 0.0), uW * 0.16, uH * 0.72, uTime * 1.35, uSeed + 9.0 + float(i)));
    }
  }
  vec4 c = vec4(0.0);
  if (f > 0.0) {
    float E = f * (1.25 - 0.75 * y);
    c = hot(ramp5(uC0, uC1, uC2, uC3, uC4, qz(E, p)), cut(f, 0.02, p));
  }
  if (uHalf < 0.0) {
    for (int i = 0; i < 10; i++) {
      if (float(i) >= uEmbers) break;
      vec3 h = hash31(float(i) * 9.7 + uSeed);
      float age = fract(uTime * (0.55 + 0.4 * h.x) + h.y);
      vec2 at = vec2((h.z - 0.5) * uW * 1.5 + sin(age * 6.0 + h.x * 5.0) * 3.0, uH * (0.25 + 1.0 * age));
      if (length(p - at) < 0.8 && age < 0.85) c = over(hot(mix(uC4, uC1, age), 1.0), c);
    }
  }
  return c * uFade;
}`;

export default defineEffect({
  id: "fire/burning",
  name: "Burning",
  kind: "aura",
  stage: { caster: null, anim: null },
  family: "fire",
  category: "debuff",
  tags: ["debuff", "damage over time", "fire"],
  intro: 0.25,
  outro: 0.45,
  demo: { on: "target" },
  thinking: `Burning is a status, so it must stay readable for as long as it lasts without hiding the creature wearing it. The trick is to put most of the fire BEHIND the body: a sheet of flame whose tongues rise past the shoulders and head, which the body itself cuts into a burning silhouette. In front there are only low flames at the feet and (from level 7) two tongues climbing the body's sides, so the creature stays visible inside its own fire. The flames are a noise field that scrolls upward and breaks into tongues at the top by itself, coloured with the same five-band ramp as the fireball, one fire language across the library. It scales with the body's height (a burning troll burns bigger than a burning rat) and carries a small flickering light, so a burning enemy in the dark is a lantern you can track.`,
  levels: `1-3: low flames licking up behind the body and at its feet. 4-6: taller fire and embers drifting up. 7-9: tongues climb the body's sides and the fire rises past the head. 10: the body is engulfed.`,
  tune: {
    core: { type: "color", def: "#fff1b8", label: "Core" },
    flame: { type: "color", def: "#ff7b22", label: "Flame" },
    ember: { type: "color", def: "#b8261a", label: "Ember" },
  },
  light: (s) => ({ color: [1.0, 0.55, 0.2], radius: lv(s, 1.6, 2.8), intensity: 0.85 * s.fade, flicker: 0.8 }),
  layers: ["back", "front"].map((half) => ({
    id: `fire_${half}`,
    sort: () => (half === "back" ? -0.3 : 0.3),
    box: (s) => box.column(s.height * 0.42, s.height * lv(s, 0.8, 1.35) + 8, 16),
    u: (s) => ({
      ...ramp(s),
      uW: s.height * lv(s, 0.24, 0.38),
      uH: s.height * lv(s, 0.5, 1.15),
      uHalf: half === "back" ? 1 : -1,
      uLicks: tier(s, 7) * 2,
      uEmbers: tier(s, 4) * Math.round(lv(s, 3, 10)),
    }),
    frag: FIRE,
  })),
});
