import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { RING_RY } from "../runtime/ellipse";
import { landableAt } from "../runtime/ground";
import { lakeAt } from "../runtime/water";
import {
  MAX_PATCHES,
  MIN_DAMP,
  PATCH_LIFE,
  PATCH_RX,
  BREATHE_MS,
  basin,
  breathe,
  drain,
  countFor,
  damp,
  ditherPixels,
  driftX,
  driftY,
  nextGap,
  mistTint,
  patchAlpha,
  sizeFor,
  weight,
} from "./hollow";

/* DAWN MIST IN THE HOLLOWS — fog lying in the low ground at first light.
 *
 * THE WHOLE EFFECT IS "WHERE", and the game already publishes it: `pickAt`
 * resolves what is DRAWN at a screen point and answers with the CELL and its
 * LEVEL, so a ring of picks around a candidate says whether the ground rises
 * around it. No seam was needed and none was asked for — the moths' lesson
 * (read the 168 keys on `__ml` before asking the games agent for anything)
 * paying off for once.
 *
 * IT IS DRAWN IN THE SURFACE BAND, under every body and under the darkness
 * overlay, and that is a correctness decision rather than a depth convenience:
 * - UNDER BODIES, because fog you walk into must not paint over your head. The
 *   foam does the same and for the same reason.
 * - UNDER THE OVERLAY, because the night must GRADE it. Every crawler in this
 *   folder deliberately sits above the overlay so its own colour survives the
 *   dark; mist has to do the exact reverse, or a pale bank at 3am is the
 *   brightest thing on the screen — the white-ants verdict in a new costume.
 *   Below it, the same grey is near-black in the small hours and catches the
 *   first light with the ground it lies on, which is the picture he asked for
 *   and costs nothing to get.
 *
 * PLACEMENT IS A SPOT, THEN A CLUSTER. One accepted point seeds several patches
 * jittered around it, because a bank is a bank and not a scatter of blobs. Only
 * the SPOT is required to be dry standable ground: the patches themselves are
 * free to drift out over the pond at the bottom of the hollow, which is the
 * best thing in the picture and would be refused by a per-patch land test.
 */

const NAME = "dawnmist";
const GAIN_TAU = 2600; // fog comes and goes slowly, even when forced
/** The ring of level samples, in screen px: 3 cells across, squashed by the
 *  projection like every ground shape here — and a WIDE one at 9 cells, which
 *  is the only way to tell a valley from a pocket on a summit (see `drain`). */
const RING_PX = 3 * 32;
const WIDE_PX = 9 * 32;
const RING_N = 4;
/** A SCREEN RING IS NOT A WORLD RING ON A SLOPE. The projection subtracts
 *  level x lh from screen y, so a point 42 px up-screen of you may resolve to
 *  a cell three levels higher AND several cells further back. The answer is
 *  not to aim more carefully — it is to USE WHAT WAS ACTUALLY HIT: `pickAt`
 *  reports where it resolved, so each sample is filed by its true distance
 *  from the centre rather than by the offset it was asked for. */
const NEAR_CELLS = 6;
/** ...AND `pickAt` ANSWERS IN WORLD UNITS, NOT CELLS — 32 to the cell, the
 *  same trap `playerAt` carries a warning about in the README. Comparing its
 *  distances against a threshold in CELLS put every sample in the far bucket,
 *  left the near ring empty and made `dampAt` return 0 for the whole world:
 *  the deepest hollow in the game reported no fog at all, with the feature
 *  otherwise working perfectly (measured — the player at cell 94.5,209.5 comes
 *  back as 3024,6704). */
const CELL_WU = 32;
/** How far out still water still counts as damp — 2 cells. */
const WATER_PX = 2 * 32;
/** Placement probes per attempt; the gap does the real throttling. */
const TRIES = 2;
/** JUST OVER THE DARKNESS OVERLAY, with every other ground-lying mark in this
 *  folder (`drips/` splash rings 900_000.05, `dust/` 900_000.09, `fish/` rings
 *  900_000.41) — and NOT in the surface band, which is where this started.
 *  Measured: at -999_999.5 nineteen banks at alpha 0.45 moved the screen by
 *  1 luma, and the same banks lifted above the overlay were plainly visible in
 *  the same shot. The surface band is under the terrain OCCLUDERS as well as
 *  the ground texture, and a grassy hollow's ground is drawn with those, so the
 *  fog was simply behind the world. `foam/` can live down there because it
 *  animates a line the game paints INTO the ground texture; nothing else here
 *  can. The cost is paid in `mistTint`, which now has to grade itself. */
const DEPTH = 900_000.3;
/** Peak opacity of ONE patch. Low on purpose — the bank is built by OVERLAP,
 *  and the dither already leaves half the rim transparent — but not as low as
 *  the first cut: at 0.22 a bank moved its own pixels by 7.2 luma at first
 *  light (measured), and a mark nobody can see is not subtle, it is absent.
 *  The reason it is dimmer than it looks is the surface band itself: under the
 *  darkness overlay the mist is multiplied down with the ground it lies on, so
 *  its alpha has to be read against a DARK picture, not against the tint. */
const ALPHA = 0.28;
/** How far a patch may sit from its spot, and how far outside the view a
 *  patch is kept before it is retired. */
const SPREAD_PX = 40;
const CULL_PAD = 220;
/** FOG FILLS A DIP, IT DOES NOT SPRINKLE THE VIEW. A hollow is a few cells
 *  across and the view is fifteen, so sampling it uniformly finds one about
 *  one time in seven — measured in the world's deepest hollow: 12 banks from
 *  84 attempts and eleven patches on screen, which is a scatter and not a
 *  bank. So an accepted spot is REMEMBERED and most later samples are taken
 *  beside it: the dip fills instead of the screen speckling, which is both
 *  what fog does and what makes the probe budget buy something. */
const SPOT_MEMORY = 4;
const SPOT_TTL_MS = 14_000;
const SPOT_BIAS = 0.65;
const SPOT_JITTER_PX = 2 * 32;

const SEEDS = [11, 23, 37] as const;
const KEY = (size: number, seed: number) => `amb-mist${size}-${seed}`;

interface Patch {
  sprite: Phaser.GameObjects.Image;
  x: number;
  y: number;
  age: number;
  life: number;
  period: number;
  phase: number;
  damp: number;
  rx: number;
  live: boolean;
}

export function dawnMistFeature(): AmbientFeature {
  const patches: Patch[] = [];
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let gap = 0;
  let probes = 0;
  const stats = { tries: 0, placed: 0, rejected: 0, lastDamp: 0, lastBasin: 0, lastDrain: 0, bestDamp: 0, nearHits: 0 };
  /** Spots that fogged, so the next samples are taken beside them. Capped, and
   *  the LEAST damp is evicted, so the memory drifts toward the bottom of the
   *  dip rather than sticking to whatever was found first. */
  const spots: { x: number; y: number; d: number; ttl: number }[] = [];
  let env = { sun: 1, phase: "Day", cloud: 0, rain: 0 };
  let seed = 6_031_913;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const range = ([a, b]: [number, number]) => a + rnd() * (b - a);

  const ml = () => (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;

  /** The CELL and level of whatever is DRAWN at a screen point, or null.
   *  Fenced like every probe read here: no probe, no mist, never a throw. */
  const pickAt = (wx: number, wy: number): { x: number; y: number; lvl: number } | null => {
    const pick = ml()?.pickAt as undefined | ((x: number, y: number) => { x: number; y: number; lvl: number } | null);
    if (!pick) return null;
    probes++;
    try {
      return pick(wx, wy) ?? null;
    } catch {
      return null;
    }
  };

  /** Is this spot a hollow, and how damp? A ring of levels around it plus a
   *  look for still water beside it — a PLACEMENT call, never per frame. */
  const dampAt = (wx: number, wy: number): number => {
    if (!landableAt(wx, wy)) return 0; // the spot itself must be dry standable ground
    const c = pickAt(wx, wy);
    if (!c) return 0;
    const centre = c.lvl;
    const ring: number[] = [];
    const far: number[] = [];
    for (let i = 0; i < RING_N; i++) {
      const a = (i / RING_N) * Math.PI * 2 + Math.PI / RING_N;
      for (const r of [RING_PX, WIDE_PX]) {
        const p = pickAt(wx + Math.cos(a) * r, wy + Math.sin(a) * r * RING_RY);
        if (!p) continue;
        // Filed by the distance ACTUALLY resolved, not the one asked for.
        const d = Math.hypot(p.x - c.x, p.y - c.y) / CELL_WU;
        if (d < 1) continue; // the same cell says nothing about its surroundings
        if (d <= NEAR_CELLS) ring.push(p.lvl);
        else far.push(p.lvl);
      }
    }
    if (!ring.length) return 0;
    const b = basin(centre, ring);
    let water = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (lakeAt(wx + dx * WATER_PX, wy + dy * WATER_PX * RING_RY)) { water = true; break; }
    }
    const dr = drain(centre, far);
    stats.lastBasin = +b.toFixed(3);
    stats.lastDrain = +dr.toFixed(3);
    const d = damp(b, water, dr);
    stats.lastDamp = +d.toFixed(3);
    return d;
  };

  const spawn = (ctx: AmbientCtx, x: number, y: number, d: number) => {
    let p = patches.find((q) => !q.live);
    const size = sizeFor(d, rnd);
    const key = KEY(size, SEEDS[Math.floor(rnd() * SEEDS.length) % SEEDS.length]);
    if (!p && patches.length < MAX_PATCHES) {
      p = {
        /* ORIGIN CENTRED, unlike every 1-px mark in this folder: a patch is an
         * even-sized shape drawn around a point rather than a pixel placed on
         * one, and its texture is built symmetrically about its own middle.
         * The DEPTH IS APPLIED HERE — a factory that takes one and forgets it
         * leaves the mark at 0, above the overlay, which for this effect would
         * undo the whole reason it is in the surface band (the drips, 2026-09-13). */
        sprite: ctx.scene.add.image(0, 0, key).setOrigin(0.5, 0.5).setScale(1).setDepth(DEPTH).setVisible(false),
        x, y, age: 0, life: 0, period: 1, phase: 0, damp: d, rx: PATCH_RX[size], live: false,
      };
      patches.push(p);
    }
    if (!p) return; // at the ceiling
    p.sprite.setTexture(key).setDepth(DEPTH);
    p.x = x;
    p.y = y;
    p.age = 0;
    p.life = range(PATCH_LIFE);
    p.period = range(BREATHE_MS);
    p.phase = rnd() * Math.PI * 2;
    p.damp = d;
    p.rx = PATCH_RX[size];
    p.live = true;
    p.sprite.setVisible(true).setAlpha(0);
  };

  /** One search: up to TRIES probed points, each a ring of picks — taken
   *  beside a remembered spot most of the time, and anywhere in the view the
   *  rest, because a bank has to be able to start somewhere new. */
  const place = (ctx: AmbientCtx): boolean => {
    const v = ctx.view;
    for (let t = 0; t < TRIES; t++) {
      stats.tries++;
      const near = spots.length && rnd() < SPOT_BIAS ? spots[Math.floor(rnd() * spots.length) % spots.length] : null;
      const x = Math.round(near ? near.x + (rnd() - 0.5) * 2 * SPOT_JITTER_PX : v.x + rnd() * v.width);
      const y = Math.round(near ? near.y + (rnd() - 0.5) * 2 * SPOT_JITTER_PX * RING_RY : v.y + rnd() * v.height);
      const d = dampAt(x, y);
      if (near && d >= MIN_DAMP) stats.nearHits++;
      stats.bestDamp = Math.max(stats.bestDamp, d);
      if (d < MIN_DAMP) continue;
      // A SPOT IS A CLUSTER: one accepted point puts a bank down, not a blob.
      const n = countFor(d);
      for (let i = 0; i < n; i++)
        spawn(ctx, x + (rnd() - 0.5) * 2 * SPREAD_PX, y + (rnd() - 0.5) * 2 * SPREAD_PX * RING_RY, d);
      const hit = spots.find((sp) => Math.abs(sp.x - x) < SPOT_JITTER_PX && Math.abs(sp.y - y) * 2.3 < SPOT_JITTER_PX);
      if (hit) {
        hit.ttl = SPOT_TTL_MS;
        hit.d = Math.max(hit.d, d);
      } else {
        spots.push({ x, y, d, ttl: SPOT_TTL_MS });
        if (spots.length > SPOT_MEMORY) {
          let worst = 0;
          for (let i = 1; i < spots.length; i++) if (spots[i].d < spots[worst].d) worst = i;
          spots.splice(worst, 1);
        }
      }
      stats.placed++;
      return true;
    }
    stats.rejected++;
    return false;
  };

  /** Hide everything and zero what the gates read — `a` is the DRAWN alpha on
   *  every path, the early ones included (the spiders' bug, 2026-09-13). */
  const park = () => {
    for (const p of patches)
      if (p.sprite.visible) {
        p.sprite.setVisible(false).setAlpha(0);
        p.live = false;
      }
    spots.length = 0; // ...and forget the dip: a re-enable starts from here
  };

  return {
    name: NAME,
    init(ctx) {
      for (let s = 0; s < PATCH_RX.length; s++) {
        const rx = PATCH_RX[s];
        const ry = Math.max(1, Math.round(rx * RING_RY));
        for (const sd of SEEDS) {
          const key = KEY(s, sd);
          if (ctx.scene.textures.exists(key)) continue;
          const g = ctx.scene.make.graphics({ x: 0, y: 0 }, false);
          g.fillStyle(0xffffff, 1); // the drawn colour is the tint
          for (const [px, py] of ditherPixels(rx, ry, sd)) g.fillRect(rx + px, ry + py, 1, 1);
          g.generateTexture(key, rx * 2 + 1, ry * 2 + 1);
          g.destroy();
        }
      }
    },
    update(ctx, dt) {
      const dtc = Math.min(dt, 100);
      env = { sun: ctx.env.sun, phase: ctx.env.phase, cloud: ctx.env.cloud, rain: ctx.env.rain };
      const target = forced ? 1 : suppressed ? 0 : weight(env.sun, env.phase, env.cloud, env.rain);
      gain += (target - gain) * Math.min(1, (dtc / GAIN_TAU) * 3);
      const g = gain * ctx.outdoor;
      if (g <= 0.02) {
        park();
        return;
      }

      // ---- the banks gather ----
      const v0 = ctx.view;
      for (let i = spots.length - 1; i >= 0; i--) {
        const sp = spots[i];
        sp.ttl -= dtc;
        // A spot is forgotten when it goes stale OR leaves the view: the
        // memory is about THIS dip, not about where we have been.
        if (
          sp.ttl <= 0 ||
          sp.x < v0.x - CULL_PAD || sp.x > v0.x + v0.width + CULL_PAD ||
          sp.y < v0.y - CULL_PAD || sp.y > v0.y + v0.height + CULL_PAD
        )
          spots.splice(i, 1);
      }
      gap -= dtc;
      if (gap <= 0) {
        gap = nextGap(rnd);
        if (patches.filter((p) => p.live).length < MAX_PATCHES) place(ctx);
      }

      // ---- and lie there, breathing ----
      const tint = mistTint(env.sun);
      const v = ctx.view;
      for (const p of patches) {
        if (!p.live) continue;
        p.age += dtc;
        const x = p.x + driftX(p.age);
        const y = p.y + driftY(p.age);
        if (
          p.age >= p.life ||
          x < v.x - CULL_PAD || x > v.x + v.width + CULL_PAD ||
          y < v.y - CULL_PAD || y > v.y + v.height + CULL_PAD
        ) {
          p.live = false;
          p.sprite.setVisible(false).setAlpha(0);
          continue;
        }
        const a = patchAlpha(p.age, p.life) * breathe(p.age, p.period, p.phase) * ALPHA * g;
        if (a <= 0.004) {
          p.sprite.setVisible(false).setAlpha(0);
          continue;
        }
        p.sprite.setPosition(Math.round(x), Math.round(y)).setTint(tint).setAlpha(a).setVisible(true);
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
      const live = patches.filter((p) => p.live && p.sprite.visible);
      return {
        gain: +gain.toFixed(3),
        /* WHAT IT WOULD DO UNFORCED. In MANUAL mode a selected field is FORCED,
         * so `gain` reads 1 at noon whatever the rule says. This is the pure
         * weight at the current sky. */
        weight: +weight(env.sun, env.phase, env.cloud, env.rain).toFixed(3),
        sun: +env.sun.toFixed(3),
        phase: env.phase,
        cloud: +env.cloud.toFixed(3),
        rain: +env.rain.toFixed(3),
        probes, // QA: a ring of picks is a PLACEMENT cost — it must stay off the frame
        ...stats,
        spots: spots.map((sp) => ({ x: Math.round(sp.x), y: Math.round(sp.y), d: +sp.d.toFixed(3) })),
        patches: live.length,
        /* WHAT THE SPRITE ITSELF SAYS. A mark can be positioned, tinted and
         * given an alpha and still never reach the screen — a depth left at 0
         * reads exactly like a working effect from out here, and for THIS
         * effect a wrong depth is the whole bug (above the overlay it would
         * glow at night). */
        draw: (() => {
          const q = live.reduce(
            (best: Patch | null, c) => (!best || c.sprite.alpha > best.sprite.alpha ? c : best),
            null as Patch | null,
          );
          if (!q) return null;
          return {
            visible: q.sprite.visible, alpha: +q.sprite.alpha.toFixed(3), depth: q.sprite.depth,
            dw: q.sprite.displayWidth, dh: q.sprite.displayHeight, tex: q.sprite.texture?.key,
            blend: q.sprite.blendMode, tint: q.sprite.tintTopLeft, inScene: !!q.sprite.scene,
          };
        })(),
        /** Only what is on screen, and `a` is the drawn alpha. */
        all: live.map((p) => ({
          x: Math.round(p.sprite.x),
          y: Math.round(p.sprite.y),
          a: +p.sprite.alpha.toFixed(3),
          rx: p.rx,
          damp: +p.damp.toFixed(3),
          t: +(p.age / p.life).toFixed(3),
        })),
      };
    },
    dispose() {
      for (const p of patches) p.sprite.destroy();
      patches.length = 0;
    },
  };
}
