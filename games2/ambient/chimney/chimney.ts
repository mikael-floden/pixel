import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import {
  CURL_HZ,
  CURL_PX,
  MAX_PUFFS,
  PER_VENT,
  PUFF_LIFE,
  RIM_MIX,
  RISE0,
  SPREAD_PX,
  driftX,
  driftY,
  flueTint,
  nextGap,
  puffAlpha,
  puffSize,
  riseY,
  stoke,
  vents,
  weight,
} from "./flue";

/* CHIMNEY SMOKE — a plume off a roof while the hearth inside is burning, seen
 * across the town.
 *
 * WHERE IT COMES OUT IS PUBLISHED, not guessed. The maintainer commissioned
 * the chimneys with this effect already in mind (2026-09-13: "make some form
 * of tag so the game/ambient-agent knows what this scenery is and can place it
 * and attach an effect to it properly ... he will need to know where the
 * chimney center hole is"), and the scenery domain then measured the flue
 * mouth per STATE and per FACING through four rounds of his own corrections —
 * the hole is not the middle of the box, not the top of the silhouette, and
 * not the dark socket beside the pot. `__ml.ventsInView` reports that point as
 * drawn, through the still's own crop, scale and flip. Nothing here derives an
 * anchor: that is the moths' mistake, twice paid for, and this time the answer
 * arrived as data.
 *
 * A HEARTH IS NOT A CAMPFIRE — see flue.ts for the three curves that differ
 * and for why a chimney's puff is two-tone when a campfire's is one flat grey.
 *
 * IT SORTS AGAINST ITS OWN STACK, the embers' law: a scenery piece draws an
 * opaque LIT COPY at ~900_001, so a mark left in the ambient band at
 * 900_000.0x is painted over by the very thing it comes out of. A puff takes
 * its chimney's own `litDepth` plus a hair — a sort, not an override.
 *
 * AND IT IS AN OUTDOOR EFFECT, `ctx.outdoor` and all: a chimney is never a
 * source you are in the room with (that exemption is the embers' and the
 * campfire smoke's, for sealed fires). Walking into the house cuts its roof
 * away and takes the stack with it, and `ctx.outdoor` has already gone to 0 by
 * then — the published `alpha` is the second lock, for a stack faded for any
 * other reason (the tree-over-the-house cover fade).
 */

const NAME = "chimney";
const GAIN_TAU = 1500;
const VENT_MS = 620; // how often the vent list is re-read (NOT per frame)
/** Below this the stack is mostly dissolved (a roof being cut away, a tree
 *  fading over the room): stop feeding it rather than leave smoke over a hole
 *  in a roof. */
const MIN_PIECE_ALPHA = 0.15;

/** The lift over the stack's own lit copy. The lit band compresses painter
 *  depth by 1e-5, so this is a tenth of a painter pixel — enough to sit in
 *  front of the chimney the smoke leaves, not enough to jump anything really
 *  nearer the camera. (The embers' constant, for the same reason.) */
const SRC_LIFT = 1e-6;
/** No lit copy to sort against (no night shader, or the art has not landed):
 *  nothing to be in front OF, so go above the whole lit band but under the
 *  target rings and HP bars at 900_001.43. */
const ABOVE_LIT = 900_001.3;

const KEY = (n: number) => `amb-flue${n}`;
/** The peak opacity of one puff. Higher than the campfire's 0.5: this is a
 *  body of smoke out of a pipe rather than a thin wisp, and it is read from
 *  across a town rather than at the player's feet. */
const ALPHA = 0.58;

interface Puff {
  sprite: Phaser.GameObjects.Image;
  /* THE FLUE IT LEFT, CAPTURED AT BIRTH — the position, not an index into a
   * list that is rebuilt every VENT_MS (the campfire smoke's measured bug: a
   * stored index made the debug report claim a 16,520 px column). */
  vent: string;
  vx: number;
  vy: number;
  x: number;
  y: number;
  age: number;
  life: number;
  up: number;
  curl: number;
  phase: number;
  hz: number;
  spread: number;
  /** The stack's own drawn opacity when this puff left it. */
  fade: number;
  depth: number;
  live: boolean;
}

interface Vent {
  id: string;
  place: number;
  x: number;
  y: number;
  piece: string;
  conf: string;
  alpha: number;
  gap: number;
  depth: number;
}

/** A TWO-TONE MARK FROM ONE SPRITE. `setTint` multiplies, so a texture painted
 *  white where the core goes and RIM_MIX grey where the rim goes comes out as
 *  `tint` and `tint x RIM_MIX` under a single tint — the pale half and the
 *  dark half of the pair, with no second sprite and no second draw call.
 *  (runtime/ground.ts `paintPixels` takes one colour; this is the same idea
 *  with two, kept local until a second effect wants it.) */
function paintTwoTone(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  core: [number, number][],
  rim: [number, number][],
): void {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  const v = Math.round(255 * RIM_MIX);
  g.fillStyle(0xffffff, 1);
  for (const [x, y] of core) g.fillRect(x, y, 1, 1);
  g.fillStyle((v << 16) | (v << 8) | v, 1);
  for (const [x, y] of rim) g.fillRect(x, y, 1, 1);
  g.generateTexture(key, w, h);
  g.destroy();
}

export function chimneyFeature(): AmbientFeature {
  const puffs: Puff[] = [];
  let vlist: Vent[] = [];
  let probes = 0;
  let seen = 0; // vents in view at the last read, before the conf filter (QA)
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let lastSun = 1;
  let lastRain = 0;
  let clock = 0; // ms since mount — the stoke cycles run off it
  let ventAge = 0; // ms since the last vent read (the throttle's accumulator)
  let seed = 4_913_113;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const range = ([a, b]: [number, number]) => a + rnd() * (b - a);

  const readVents = (): Vent[] => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const f = ml?.ventsInView as
      | undefined
      | ((pad?: number) => {
          id: string; x: number; y: number; footY: number;
          piece: string; state: string; fixture: string; conf: string;
          alpha: number; litDepth: number | null;
        }[]);
    if (!f) return []; // an older game build: no probe, no smoke, no throw
    probes++;
    try {
      const all = f(96) || [];
      seen = all.length;
      return all
        .filter((v) => vents(v.conf))
        .map((v) => ({
          id: v.id,
          // `s3:<placement index>` — the index is what makes a stack's stoke
          // its own and the same every time you walk past it.
          place: +v.id.slice(3) || 0,
          x: v.x, y: v.y, piece: v.piece, conf: v.conf, alpha: v.alpha,
          gap: rnd() * 260,
          depth: v.litDepth === null ? ABOVE_LIT : v.litDepth + SRC_LIFT,
        }));
    } catch {
      return [];
    }
  };

  const emit = (ctx: AmbientCtx, v: Vent, st: number) => {
    let p = puffs.find((q) => !q.live);
    if (!p && puffs.length < MAX_PUFFS) {
      p = {
        /* ORIGIN (0,0), like every pixel mark in this folder: a 1x1 quad
         * CENTRED on an integer straddles two pixels and the renderer drops
         * it. And the DEPTH IS SET HERE — a factory that takes one and forgets
         * to apply it leaves every mark at 0, under the darkness overlay (the
         * drips, 2026-09-13). */
        sprite: ctx.scene.add.image(0, 0, KEY(1)).setOrigin(0, 0).setScale(1).setVisible(false),
        vent: v.id, vx: 0, vy: 0, x: 0, y: 0, age: 0, life: 0, up: 0, curl: 0,
        phase: 0, hz: 1, spread: 0, fade: 1, depth: ABOVE_LIT, live: false,
      };
      puffs.push(p);
    }
    if (!p) return; // at the ceiling
    p.vent = v.id;
    p.vx = v.x;
    p.vy = v.y;
    // Leave the MOUTH, which is a hole a few pixels across, not one point.
    p.x = v.x + (rnd() - 0.5) * 3;
    p.y = v.y + (rnd() - 0.5) * 2;
    p.age = 0;
    p.life = range(PUFF_LIFE);
    // A stoked fire pushes harder as well as more often.
    p.up = range(RISE0) * (0.8 + 0.3 * st);
    p.curl = range(CURL_PX) * (rnd() < 0.5 ? 1 : -1);
    /* THE PHASE WALKS, IT IS NOT ROLLED — the campfire's rule and the reason a
     * column bends as one ribbon instead of scattering into dots: neighbours
     * must be neighbours in the swing too. */
    p.phase = (p.phase || rnd() * Math.PI * 2) + 0.14;
    p.hz = range(CURL_HZ);
    p.spread = (rnd() - 0.5) * 2 * SPREAD_PX;
    p.fade = v.alpha;
    p.depth = v.depth;
    p.live = true;
    p.sprite.setVisible(true).setAlpha(0);
  };

  /** Hide everything and zero what the gates read — `a` is the DRAWN alpha on
   *  every path, the early ones included (the spiders' bug, 2026-09-13). */
  const park = () => {
    for (const p of puffs)
      if (p.sprite.visible) {
        p.sprite.setVisible(false).setAlpha(0);
        p.live = false;
      }
    vlist = [];
  };

  return {
    name: NAME,
    init(ctx) {
      // 1 and 2 px are core only — there is no room for a rim inside two
      // pixels, and a lone dark pixel at the mouth reads as soot, not smoke.
      paintTwoTone(ctx.scene, KEY(1), 1, 1, [[0, 0]], []);
      paintTwoTone(ctx.scene, KEY(2), 2, 2, [[0, 0], [1, 0], [0, 1], [1, 1]], []);
      // 3 px: a core pixel inside a rim cross.
      paintTwoTone(ctx.scene, KEY(3), 3, 3, [[1, 1]], [[1, 0], [0, 1], [2, 1], [1, 2]]);
      // 4 px: a 2x2 core inside a rounded rim — the corners stay empty so the
      // mark is a blob rather than a square.
      paintTwoTone(
        ctx.scene, KEY(4), 4, 4,
        [[1, 1], [2, 1], [1, 2], [2, 2]],
        [[1, 0], [2, 0], [0, 1], [3, 1], [0, 2], [3, 2], [1, 3], [2, 3]],
      );
    },
    update(ctx, dt) {
      const dtc = Math.min(dt, 100);
      clock += dtc;
      lastSun = ctx.env.sun;
      lastRain = ctx.env.rain;
      const target = forced ? 1 : suppressed ? 0 : weight(ctx.env.sun, ctx.env.rain);
      gain += (target - gain) * Math.min(1, (dtc / GAIN_TAU) * 3);
      // OUTDOOR, by the folder's charter: indoors the whole outside draws at
      // zero ambient, and a mark above the darkness overlay would be the only
      // lit thing out there.
      const g = gain * ctx.outdoor;
      if (g <= 0.02) {
        park();
        return;
      }

      /* AN ACCUMULATOR, never `clock % VENT_MS < dtc`: a modulo window is
       * skipped whenever a frame is longer than the remainder, and `|| no
       * vents in view` would probe EVERY frame in the case that is normal
       * today — a world where no chimney is placed yet. */
      ventAge += dtc;
      if (ventAge >= VENT_MS) {
        ventAge = 0;
        const next = readVents();
        // Keep each flue's own gap clock across a re-read, or a stack that
        // stays in view restarts its timer twice a second and puffs in step.
        for (const v of next) {
          const was = vlist.find((o) => o.id === v.id);
          if (was) v.gap = was.gap;
        }
        vlist = next;
      }

      // ---- the hearths give off ----
      for (const v of vlist) {
        v.gap -= dtc;
        if (v.gap > 0) continue;
        const st = stoke(clock, v.place);
        v.gap = nextGap(rnd, st);
        if (v.alpha < MIN_PIECE_ALPHA) continue; // the stack is dissolving with its roof
        const alive = puffs.reduce((n, q) => n + (q.live && q.vent === v.id ? 1 : 0), 0);
        if (alive < PER_VENT) emit(ctx, v, st);
      }

      // ---- the plumes climb ----
      const tint = flueTint(ctx.env.sun);
      for (const p of puffs) {
        if (!p.live) continue;
        p.age += dtc;
        if (p.age >= p.life) {
          p.live = false;
          p.sprite.setVisible(false).setAlpha(0);
          continue;
        }
        const a = puffAlpha(p.age, p.life) * ALPHA * p.fade * g;
        if (a <= 0.004) {
          p.sprite.setVisible(false).setAlpha(0);
          continue;
        }
        const n = puffSize(p.age, p.life);
        p.sprite
          .setTexture(KEY(n))
          .setPosition(
            Math.round(p.x + driftX(p.age, p.life, p.curl, p.phase, p.hz, p.spread)),
            Math.round(p.y - riseY(p.age, p.life, p.up) + driftY(p.age, p.life)),
          )
          // NOT keyed on the puff's own screen y: a climbing plume would sort
          // itself behind the stack it came out of. It belongs to the stack.
          .setDepth(p.depth)
          .setTint(tint)
          .setAlpha(a)
          .setVisible(true);
      }
    },
    setSuppressed(on) {
      suppressed = on;
      if (on) park();
    },
    setForced(on) {
      forced = on;
    },
    debug() {
      const live = puffs.filter((p) => p.live && p.sprite.visible);
      return {
        gain: +gain.toFixed(3),
        /* WHAT IT WOULD DO UNFORCED. In MANUAL mode the toggles FORCE an
         * enabled field on regardless of its env gate, so `gain` reads 1 at
         * noon whatever the rule says. This is the pure weight. */
        weight: +weight(lastSun, lastRain).toFixed(3),
        sun: +lastSun.toFixed(3),
        rain: +lastRain.toFixed(3),
        probes, // QA: the vent list walks the drawn scenery — stay throttled
        seen, // how many vents were in view at all, before the conf filter
        vents: vlist.length, // ...and how many of those are holes worth using
        ventList: vlist.map((v) => ({
          id: v.id, x: Math.round(v.x), y: Math.round(v.y),
          piece: v.piece, conf: v.conf, alpha: v.alpha, depth: v.depth,
          stoke: +stoke(clock, v.place).toFixed(3),
        })),
        puffs: live.length,
        /* WHAT THE SPRITE ITSELF SAYS. A mark can be positioned, tinted and
         * given an alpha and still never reach the screen — a depth left at 0
         * reads exactly like a working effect from out here. */
        draw: (() => {
          const q = live.reduce(
            (best: Puff | null, c) => (!best || c.sprite.alpha > best.sprite.alpha ? c : best),
            null as Puff | null,
          );
          if (!q) return null;
          return {
            visible: q.sprite.visible, alpha: +q.sprite.alpha.toFixed(3), depth: q.sprite.depth,
            dw: q.sprite.displayWidth, dh: q.sprite.displayHeight, tex: q.sprite.texture?.key,
            blend: q.sprite.blendMode, tint: q.sprite.tintTopLeft, inScene: !!q.sprite.scene,
          };
        })(),
        /** Only what is on screen, and `a` is the DRAWN alpha. */
        all: live.map((p) => ({
          x: Math.round(p.sprite.x),
          y: Math.round(p.sprite.y),
          vent: p.vent,
          t: +(p.age / p.life).toFixed(3),
          a: +p.sprite.alpha.toFixed(3),
          vx: Math.round(p.vx),
          vy: Math.round(p.vy),
        })),
      };
    },
    dispose() {
      for (const p of puffs) p.sprite.destroy();
      puffs.length = 0;
      vlist = [];
    },
  };
}
