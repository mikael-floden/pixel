import { defineEffect, lv, tier, rgb, box } from "../../runtime/define.js";
import { glsl } from "../../runtime/glsl.js";
import { SPARKS } from "../_shared/snippets.js";

const cols = (s) => ({ uEdge: rgb(s.tune.edge), uSmear: rgb(s.tune.smear), uDeep: rgb(s.tune.deep) });
const REACH = (s) => lv(s, 0.95, 1.45); // cells
const SWING = (s) => lv(s, 0.2, 0.26);

// The smear: a crescent in a plane parallel to the ground at chest height,
// swept from one side of the facing to the other. uHalf picks the half in
// front of (-1) or behind (+1) the attacker; uMir mirrors the swing.
const ARC = glsl`
uniform float uR, uHalf, uMir, uTilt, uSparkN; uniform vec3 uEdge, uSmear, uDeep;
float sparkAt(vec2 p, vec2 at) { return step(max(abs(p.x - at.x), abs(p.y - at.y)), 0.6); }
vec4 effect(vec2 p) {
  vec2 pp = vec2(p.x, p.y - p.x * uTilt);
  vec2 g = gnd(pp);
  vec2 fr = normalize(gnd(vec2(0.0, -1.0)));
  if (dot(g, fr) * uHalf > 0.02) return vec4(0.0);
  float r = length(g) / uR;
  vec2 f = galong(g);
  float th = atan(f.y, f.x) * uMir;
  float A = 1.35;
  float lead = mix(A, -A, 1.0 - pow(1.0 - clamp(uLife / 0.55, 0.0, 1.0), 2.0));
  float behind = th - lead;
  float tailLen = 1.9 * (1.0 - smoothstep(0.55, 1.0, uLife)) + 0.05;
  if (behind < -0.02 || behind > tailLen) return vec4(0.0);
  float k = behind / tailLen;
  float rin = 0.42 + 0.4 * k;
  if (r < rin || r > 1.0) return vec4(0.0);
  float band = (r - rin) / (1.0 - rin);
  float e = (1.0 - k) * (0.55 + 0.45 * band);
  float edge = step(behind, 0.12) * step(0.35, band);
  vec3 col = mix(uDeep, uSmear, qz(e * 1.3, p));
  float cover = cut(e, 0.18, p);
  vec4 c = hot(col, cover * 0.85);
  c = over(hot(uEdge, edge), c);
  return c;
}`;

export default defineEffect({
  id: "weapon/sword_slash",
  name: "Sword Slash",
  kind: "melee",
  family: "weapon",
  category: "attack",
  tags: ["melee", "physical", "sword", "arc"],
  dur: (s) => SWING(s) + 0.14,
  hitAt: (s) => SWING(s) * 0.45,
  thinking: `A slash is a smear frame: the one drawing an animator adds so the eye sees the blade's path instead of a sword that teleports. So this is the smear, drawn as the ghost of a blade sweeping a crescent at chest height, in a plane parallel to the ground. That plane is the trick for an isometric game: the same crescent reads right whichever of the eight directions the attacker faces, because the iso projection squashes it exactly like the floor. A white leading edge races ahead and the steel-blue smear behind it thins and fades, the whole swing in a fifth of a second. It is cut into the half in front of the attacker and the half behind, so a slash toward the camera covers the body and one away from it passes behind. The hit spark on the victim lands on the hit event, which is where the game applies damage.`,
  levels: `1-3: a quick, narrow crescent and a small hit spark. 4-6: a longer reach and sparks off the blade's edge. 7-9: a second, mirrored counter-slash follows the first. 10: a double slash whose edge glows, and a heavy hit flash.`,
  tune: {
    edge: { type: "color", def: "#ffffff", label: "Edge" },
    smear: { type: "color", def: "#bcd3ea", label: "Smear" },
    deep: { type: "color", def: "#5d7ea6", label: "Smear tail" },
  },
  light: (s) => (s.level >= 10 ? { color: [0.8, 0.9, 1.0], radius: 1.6, intensity: s.phase === "swing" ? 0.7 : 0 } : null),
  layers: [
    ...["back", "front"].map((half) => ({
      id: `arc_${half}`,
      phase: "swing",
      dur: (s) => SWING(s),
      sort: (s) => (half === "back" ? -REACH(s) : REACH(s)),
      offset: (s) => [0, s.height * 0.62],
      box: (s) => {
        const b = box.ground(s, REACH(s) * 1.05, 4);
        return { w: b.w, h: b.h + b.w * 0.35, ox: b.ox, oy: b.oy + b.w * 0.175 };
      },
      u: (s) => ({ ...cols(s), uR: REACH(s), uHalf: half === "back" ? 1 : -1, uMir: 1, uTilt: s.seed > 0.5 ? 0.14 : -0.14 }),
      frag: ARC,
    })),
    ...["back", "front"].map((half) => ({
      id: `counter_${half}`,
      phase: "swing",
      delay: (s) => SWING(s) * 0.55,
      dur: (s) => SWING(s),
      when: (s) => s.level >= 7,
      sort: (s) => (half === "back" ? -REACH(s) : REACH(s)),
      offset: (s) => [0, s.height * 0.55],
      box: (s) => {
        const b = box.ground(s, REACH(s) * 1.05, 4);
        return { w: b.w, h: b.h + b.w * 0.35, ox: b.ox, oy: b.oy + b.w * 0.175 };
      },
      u: (s) => ({ ...cols(s), uR: REACH(s) * 0.92, uHalf: half === "back" ? 1 : -1, uMir: -1, uTilt: s.seed > 0.5 ? -0.2 : 0.2 }),
      frag: ARC,
    })),
    {
      id: "hit",
      phase: "hit",
      dur: 0.22,
      sort: () => 0.4,
      box: (s) => box.around(lv(s, 16, 30)),
      u: (s) => ({ ...cols(s), uR: lv(s, 9, 18), uN: tier(s, 4) * Math.round(lv(s, 4, 12)), uTilt: s.seed > 0.5 ? 1 : -1 }),
      frag: glsl`
uniform float uR, uN, uTilt; uniform vec3 uEdge, uSmear, uDeep;
${SPARKS}
vec4 effect(vec2 p) {
  float L = uLife;
  float s = uR * (1.0 - L * 0.6);
  vec2 q = abs(p);
  float star = step(q.x * q.y, s * 0.35) * step(max(q.x, q.y), s) * (1.0 - step(0.5, L));
  vec2 dd = vec2(0.7071, 0.7071 * uTilt);
  float cutl = step(abs(dot(p, vec2(-dd.y, dd.x))), 0.7) * step(abs(dot(p, dd)), uR * 1.2 * min(1.0, L * 4.0)) * (1.0 - L);
  vec4 c = hot(uEdge, max(star, cutl));
  float sp = sparks(p, uTime, uN, 110.0, 150.0, 0.4, uSeed);
  if (sp > 0.0) c = over(hot(mix(uSmear, uEdge, sp), 1.0), c);
  return c;
}`,
    },
  ],
});
