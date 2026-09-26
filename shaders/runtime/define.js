// Helpers for WRITING an effect. An effect file default-exports
// defineEffect({...}); everything it needs besides GLSL lives here.

/** Level 1 -> a, level 10 -> b, linear. */
export const lv = (s, a, b) => a + (b - a) * s.lv;
/** Level 1 -> a, level 10 -> b, eased so the top levels jump the most. */
export const lvq = (s, a, b) => a + (b - a) * s.lv * s.lv;
/** Level 1 -> a, level 10 -> b, eased so the first points matter most. */
export const lvs = (s, a, b) => a + (b - a) * Math.sqrt(s.lv);
/** 1 when the level has reached n (a discrete unlock), else 0. */
export const tier = (s, n) => (s.level >= n ? 1 : 0);

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const mix = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeOut = (t) => 1 - (1 - clamp01(t)) ** 3;
export const easeIn = (t) => clamp01(t) ** 3;

/** "#rrggbb" (or [r,g,b] 0..1) -> [r,g,b] 0..1, for a vec3 uniform. */
export function rgb(c) {
  if (Array.isArray(c)) return c;
  const h = String(c).replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
/** Scale a colour (overbright is allowed: a light colour may exceed 1). */
export const scale3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
export const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

// ---- layer boxes: { w, h, ox, oy } in world px, (ox, oy) = where the anchor
// sits inside the box, measured from its LEFT and its BOTTOM (y up). ----
export const box = {
  /** A square of half-size r around the anchor. */
  around: (r) => ({ w: 2 * r, h: 2 * r, ox: r, oy: r }),
  /** A w x h rect, the anchor at fractions (fx, fy) of it (0,0 = bottom-left). */
  rect: (w, h, fx = 0.5, fy = 0.5) => ({ w, h, ox: w * fx, oy: h * fy }),
  /** A column standing on the anchor: halfW each side, `up` above, `down` below. */
  column: (halfW, up, down = 0) => ({ w: 2 * halfW, h: up + down, ox: halfW, oy: down }),
  /** A GROUND circle of r cells, as the projection draws it (an ellipse). */
  ground: (s, r, padPx = 2) => {
    const [a, b, c, d] = s.basis; // px per cell: e1 = (a, b), e2 = (c, d), y down
    const hx = r * Math.hypot(a, c) + padPx;
    const hy = r * Math.hypot(b, d) + padPx;
    return { w: 2 * hx, h: 2 * hy, ox: hx, oy: hy };
  },
  /** A rect along the screen direction: `ahead` px in front of the anchor,
   *  `behind` px behind it, `half` px each side — as its bounding box. */
  along: (s, ahead, behind, half) => {
    const [dx, dy] = s.dir;
    const pts = [[ahead, half], [ahead, -half], [-behind, half], [-behind, -half]];
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const [u, v] of pts) {
      const x = u * dx - v * dy, y = u * dy + v * dx;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { w: x1 - x0, h: y1 - y0, ox: -x0, oy: -y0 };
  },
  /** A beam from the anchor to the far end (s.len px), `half` px thick, padded. */
  beam: (s, half, pad = 8) => box.along(s, s.len + pad, pad, half),
  /** A rect on the GROUND along the ground direction, in cells. */
  groundAlong: (s, ahead, behind, half, padPx = 2) => {
    const [a, b, c, d] = s.basis;
    const [gx, gy] = s.gdir;
    const pts = [[ahead, half], [ahead, -half], [-behind, half], [-behind, -half]];
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const [u, v] of pts) {
      const cx = u * gx - v * gy, cy = u * gy + v * gx; // cells
      const x = cx * a + cy * c, y = -(cx * b + cy * d); // px, y up
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { w: x1 - x0 + 2 * padPx, h: y1 - y0 + 2 * padPx, ox: -x0 + padPx, oy: -y0 + padPx };
  },
  /** Two boxes as one (the union, anchor kept). */
  union: (A, B) => {
    const x0 = Math.min(-A.ox, -B.ox), y0 = Math.min(-A.oy, -B.oy);
    const x1 = Math.max(A.w - A.ox, B.w - B.ox), y1 = Math.max(A.h - A.oy, B.h - B.oy);
    return { w: x1 - x0, h: y1 - y0, ox: -x0, oy: -y0 };
  },
};

export const KINDS = ["burst", "projectile", "beam", "chain", "aura", "zone", "melee", "screen"];
export const PLANES = ["ground", "body", "air", "screen"];

/** The tunables every effect has, whatever it declares. */
export const STANDARD_TUNE = {
  size: { type: "range", def: 1, min: 0.5, max: 2, step: 0.05, label: "Size" },
  bright: { type: "range", def: 1, min: 0.25, max: 2.5, step: 0.05, label: "Brightness" },
  anim: { type: "range", def: 1, min: 0.25, max: 3, step: 0.05, label: "Animation speed" },
};

// ---- the CAST: which body animation carries an effect, and its key frame ----
// Hero states are characters2/animation_map.json's (the game resolves the
// folder per hero); every hero clip is 4 frames, and on frame 2 the wand
// thrusts (its spark drawn), the bow looses, the sword and fist land.
// `fps` is the rate the preview plays and the rate the game should play it:
// the game registers these clips at its 10 fps fallback today and triggers
// none of them yet (kick/punch run at 12). A monster's `attack` lasts 0.7 s
// whatever its frame count (the game's rate); its key is mid-clip.
export const CAST_ANIMS = {
  spell_wand: { frames: 4, fps: 10, key: 2, emit: "wand" },
  spell_channel: { frames: 4, fps: 10, key: 2, emit: "hands" },
  bow: { frames: 4, fps: 10, key: 2, emit: "bow" },
  sword: { frames: 4, fps: 12, key: 2, emit: null },
  punch: { frames: 4, fps: 12, key: 2, emit: null },
  kick: { frames: 4, fps: 12, key: 2, emit: null },
  attack: { seconds: 0.7, keyAt: 0.5, emit: null },
};

const ONE_SHOT_KINDS = new Set(["projectile", "melee", "burst", "chain"]);

/** Seconds from the start of an animation to its key frame. */
export function keyTime(anim) {
  const A = CAST_ANIMS[anim];
  if (!A) return 0;
  return A.seconds ? A.seconds * A.keyAt : A.key / A.fps;
}

/** The `release` to pass play() so the effect meets its cast animation:
 *  started together, the spell leaves on the key frame (a melee blow LANDS
 *  on it). 0 when the effect has no cast animation. */
export function castRelease(def, level = 1, anim = def.stage?.anim) {
  if (!anim || !CAST_ANIMS[anim]) return 0;
  const K = keyTime(anim);
  if (def.kind === "melee") {
    const s = { level, lv: (level - 1) / 9, tune: {} };
    const D = typeof def.dur === "function" ? def.dur(s) : def.dur ?? 0.35;
    const H = typeof def.hitAt === "function" ? def.hitAt(s) : def.hitAt ?? D * 0.5;
    return Math.max(0, K - H);
  }
  return K;
}

/** WHO IS ON STAGE for an effect, and how to play it there — the recipe the
 *  viewer and the wiki share (runtime/showcase.js performs it):
 *   caster  "hero" | "monster" | null   who performs it
 *   target  "monster" | "hero" | null   who it lands on
 *   extras  bodies near the target (a chain's hops)
 *   at      "caster" | "target" | "free" where a burst/aura/zone sits
 *   reach   cells between caster and target (null: the stage's full range)
 *   move    the caster steps to `at` on the peak (a blink)
 *   hold    s a sustained effect runs before the preview stops it
 *   anim    the caster's CAST_ANIMS clip, or null */
export function stageOf(def) {
  const demo = def.demo || {};
  const k = def.kind;
  const s = { caster: "hero", target: "monster", extras: 0, at: null, reach: null, move: false, hold: demo.hold ?? 2.4, anim: "spell_wand" };
  if (k === "beam") s.anim = "spell_channel";
  if (k === "chain") s.extras = 2;
  if (k === "melee") { s.reach = demo.dist ?? 1.25; s.anim = "sword"; }
  if (k === "burst" || k === "aura" || k === "zone" || k === "screen") {
    const onCaster = demo.on === "caster" || (k === "aura" && demo.on !== "target") || k === "screen";
    s.at = demo.dest === "free" ? "free" : onCaster ? "caster" : "target";
    if (s.at !== "target") s.target = null;
    s.move = !!demo.move;
  }
  if (k === "zone" && !demo.hold) s.hold = 3;
  return { ...s, ...(def.stage || {}) };
}

/** The moments a sound can be bound to, in the order they happen. Each:
 *  { slot, event, label, each, loop? } — `event` is the runtime event it
 *  plays on, `each` = once per copy of a volley / per hop, `loop` = a
 *  channel bed from release until stop. The game event is
 *  shaders.<family>-<name>.<slot> (soundEvent). */
export function soundsOf(def) {
  const k = def.kind, v = formationsCount(def);
  const out = [];
  const add = (slot, event, label, each = false, loop = false) => out.push({ slot, event, label, each, ...(loop ? { loop: true } : {}) });
  switch (k) {
    case "projectile":
      if (def.windup !== undefined) add("cast", "cast", "Gather — the cast begins");
      add("release", "release", "Creation — it leaves the caster", v > 0);
      add("impact", "impact", "Impact", v > 0);
      break;
    case "melee":
      add("release", "release", "Swing");
      add("hit", "hit", "Hit — the blow lands");
      break;
    case "chain":
      add("release", "release", "Creation — it leaves the caster");
      add("hop", "hop", "Each hop — it strikes a target", true);
      break;
    case "burst": {
      const pk = typeof def.peakAt === "function" ? def.peakAt({ level: 5, lv: 0.44, tune: {} }) : def.peakAt ?? 0;
      if (pk >= 0.15) add("release", "release", "Creation — it begins", v > 0);
      add("peak", "peak", pk >= 0.15 ? "Peak — it lands / strikes" : "Burst", v > 0);
      break;
    }
    default:
      add("release", "release", "Onset — it takes hold");
      add("channel", "release", "Channel — a bed until it ends", false, true);
      add("stop", "stop", "Fade — it lets go");
  }
  return out;
}

/** The game's sound event for one slot of an effect: three dot-separated
 *  parts like every scoped event (monsters.<kind>.<action>); the id's "/"
 *  becomes "-" (ids are [a-z0-9_], so it reads back unambiguously). */
export const soundEvent = (id, slot) => `shaders.${id.replace("/", "-")}.${slot}`;

// volley.js imports nothing from here; the count of formations is enough to
// know whether a sound slot repeats per copy (the list itself is volley.js's).
function formationsCount(def) {
  if (def.volley === false) return 0;
  if (Array.isArray(def.volley)) return def.volley.length;
  return def.kind === "projectile" ? 1 : 0;
}

/** Validate + normalise a definition. Throws on a malformed one: a broken
 *  definition is caught by the catalog gate, never discovered in a fight. */
export function defineEffect(def) {
  const need = ["id", "name", "kind", "family", "thinking", "layers"];
  for (const k of need) if (def[k] === undefined) throw new Error(`effect ${def.id || "?"}: missing ${k}`);
  if (!KINDS.includes(def.kind)) throw new Error(`effect ${def.id}: unknown kind ${def.kind}`);
  if (!/^[a-z0-9_]+\/[a-z0-9_]+$/.test(def.id)) throw new Error(`effect ${def.id}: id must be family/name`);
  const layers = def.layers.map((L, i) => {
    if (!L.id || !L.frag || !L.box) throw new Error(`effect ${def.id}: layer ${i} needs id, box, frag`);
    if (!/vec4\s+effect\s*\(\s*vec2/.test(L.frag)) throw new Error(`effect ${def.id}#${L.id}: frag must define vec4 effect(vec2 p)`);
    const plane = L.plane || "body";
    if (!PLANES.includes(plane)) throw new Error(`effect ${def.id}#${L.id}: unknown plane ${plane}`);
    return { order: i, emissive: true, ...L, plane };
  });
  const tune = { ...STANDARD_TUNE, ...(def.tune || {}) };
  const stage = stageOf(def);
  if (stage.anim !== null && !CAST_ANIMS[stage.anim]) throw new Error(`effect ${def.id}: unknown cast animation ${stage.anim}`);
  if (stage.anim === "attack" && stage.caster !== "monster") throw new Error(`effect ${def.id}: "attack" is a monster's clip`);
  if (def.volley !== undefined && def.volley !== false && !Array.isArray(def.volley)) throw new Error(`effect ${def.id}: volley is a list of formations or false`);
  if (Array.isArray(def.volley) && !ONE_SHOT_KINDS.has(def.kind)) throw new Error(`effect ${def.id}: only one-shot kinds volley`);
  return Object.freeze({ tags: [], category: def.kind, levels: "", ...def, layers, tune, stage, sounds: soundsOf(def) });
}

/** Default values of every tunable. */
export function tuneDefaults(def) {
  const o = {};
  for (const k in def.tune) o[k] = def.tune[k].def;
  return o;
}
