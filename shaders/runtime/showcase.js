// SHOWCASE — how the shader agent means an effect to be SEEN: who stands
// where, which clip the caster plays, and the moment the spell leaves it.
// The viewer and the wiki's Shaders page both run THIS, so a preview is the
// author's staging, never a guess (define.js stageOf is the data it reads).
//
//   const bodies = layout(def, { origin, dir: [0.7071, -0.7071], range: 4.5 });
//   bodies.caster.hero = "default_boy"; bodies.caster.facing = "east"; ...
//   const { handle, cast } = showcase(fx, def, bodies, { level: 7 });
//   // start the caster's cast.anim clip NOW at cast.fps: the effect leaves on
//   // frame cast.key (cast.release s from now) — play() was told the same.

import { CAST_ANIMS, castRelease } from "./define.js";
import { CAST_POINTS } from "../library/cast_points.js";

/** The art's eight facings, clockwise from screen-down. */
export const FACINGS = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"];

/** The facing for a SCREEN direction (x right, y DOWN): east is screen-right,
 *  south screen-down — the sprites are drawn in screen space. */
export function facingOf(dx, dy) {
  if (!dx && !dy) return "south";
  const k = Math.round(Math.atan2(dx, dy) / (Math.PI / 4));
  return FACINGS[((k % 8) + 8) % 8];
}

/** A hero's cast point as play()'s `from`: the body's world point, with the
 *  wand tip / orb / arrow of this clip and facing as a SCREEN offset — the
 *  runtime draws `sx` px right and `z` px up of the feet (cast_points.js,
 *  measured on the clip's key frame against the game's foot anchor). A hero
 *  or clip with no table gets the plain point (z: 0.55 of the height). */
export function castFrom(body, hero, anim, facing) {
  const p = CAST_POINTS.heroes[hero]?.clips[anim]?.dirs[facing];
  const k = body.scale || 1;
  return p ? { x: body.x, y: body.y, sx: p.sx * k, z: p.z * k } : { x: body.x, y: body.y };
}

/** Where the bodies stand for an effect, in world units: the caster at
 *  `origin`, the target `range` cells away along the ground unit vector
 *  `dir` (at arm's length when the stage has a reach — plus `pad` cells for
 *  bodies wider than a person, so a bear claws the hero instead of standing
 *  on him), a chain's extra targets beside it, and the free spot a blink
 *  lands on. A role the stage leaves empty is null — a status shows only its
 *  victim, a heal only its caster. */
export function layout(def, { origin, dir = [Math.SQRT1_2, -Math.SQRT1_2], range = 4.5, cellWu = 32, pad = 0 }) {
  const S = def.stage;
  const d = S.reach != null ? S.reach + pad : range;
  const T = { x: origin.x + dir[0] * d * cellWu, y: origin.y + dir[1] * d * cellWu };
  const extras = [[0.6, 1.4], [-0.9, -1.3]].slice(0, S.extras).map(([a, b]) => ({ x: T.x + a * cellWu, y: T.y + b * cellWu }));
  const free = { x: (origin.x + T.x) / 2 + 1.1 * cellWu, y: (origin.y + T.y) / 2 + 1.1 * cellWu };
  return {
    caster: S.caster ? { x: origin.x, y: origin.y, kind: S.caster } : null,
    target: S.target || S.at === "target" ? { x: T.x, y: T.y, kind: S.target || "monster" } : null,
    extras,
    free,
  };
}

/** Play an effect the way it is meant to be seen.
 *  bodies: layout()'s, each body completed with { height (px) } and, for a
 *  hero caster, { hero (characters2 id), facing }. opts: { level, seed,
 *  tune, count, formation, owner }.
 *  Returns { handle, cast, move }: `cast` = the caster's clip { anim, fps,
 *  frames, key, release } to start together with the effect (null: none),
 *  `move` = where the caster stands after the peak (a blink), else null. */
export function showcase(fx, def, bodies, opts = {}) {
  const S = def.stage, k = def.kind;
  const C = bodies.caster, T = bodies.target;
  const anim = C && S.anim ? S.anim : null;
  const A = anim ? CAST_ANIMS[anim] : null;
  const release = anim ? castRelease(def, opts.level ?? 1, anim) : 0;
  const owner = opts.owner ?? (S.caster === "monster" ? "monster" : "self");
  const common = { level: opts.level, seed: opts.seed, tune: opts.tune, count: opts.count, formation: opts.formation, owner, release };
  const from = C && A?.emit && C.hero ? castFrom(C, C.hero, anim, C.facing) : C || undefined;
  const H = C?.height ?? T?.height ?? 88, TH = T?.height ?? H;
  const spot = S.at === "caster" ? C : S.at === "free" ? bodies.free : T;
  let h;
  switch (k) {
    case "projectile":
      h = fx.play(def.id, { ...common, from, to: T, height: H, targetHeight: TH });
      break;
    case "beam":
      h = fx.play(def.id, { ...common, from, to: T, height: H, targetHeight: TH, duration: S.hold });
      break;
    case "chain":
      h = fx.play(def.id, { ...common, from, to: T, targets: [T, ...(bodies.extras || [])], height: H, targetHeight: TH });
      break;
    case "melee":
      h = fx.play(def.id, { ...common, at: C, to: T, height: H, targetHeight: TH });
      break;
    case "burst": {
      const onBody = S.at !== "target";
      h = fx.play(def.id, { ...common, at: spot, from: C || undefined, to: onBody ? undefined : T, height: S.at === "target" ? TH : H, targetHeight: TH });
      break;
    }
    default: // aura / zone / screen: sustained, stopped after the stage's hold
      h = fx.play(def.id, { ...common, at: spot, from: C || undefined, height: S.at === "target" ? TH : H, targetHeight: TH, duration: S.hold });
  }
  return {
    handle: h,
    cast: A ? { anim, release, ...A } : null,
    move: S.move ? bodies.free : null,
  };
}
