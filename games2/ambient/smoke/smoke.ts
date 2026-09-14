import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { paintPixels } from "../runtime/ground";
import {
  CURL_HZ,
  CURL_PX,
  MAX_PUFFS,
  PER_FIRE,
  PUFF_LIFE,
  RISE0,
  SPREAD_PX,
  driftX,
  driftY,
  nextGap,
  puffAlpha,
  puffSize,
  riseY,
  smokeTint,
  smokes,
  weight,
} from "./plume";

/* FIRE SMOKE — what comes off an open flame and goes up, in daylight.
 *
 * The maintainer's ask (2026-09-13): "Thin grey wisps curling up from open
 * flames, so a fire reads as burning by day too." Every word of that is a
 * constraint. THIN: a handful of one-to-three pixel marks, never a cloud.
 * GREY: no colour at all, which is also the background palette law. CURLING:
 * the column bends, or it reads as a post. OPEN FLAMES: a lantern is a fire
 * and it is behind glass, so it smokes nothing. AND BY DAY: the embers are a
 * night effect by design, so a fire at noon had nothing at all coming off it —
 * this is the daylight half of the same object.
 *
 * WHERE IT COMES FROM is already solved and shared with the moths and the
 * embers: `__ml.lightsInView` publishes `x`/`y` as the DRAWN position of a
 * source's glowing pixels, so a wisp leaves the flame rather than the object's
 * foot. It walks every source in the world, so it is read on a throttle and
 * everything between reads is trig on pooled sprites.
 *
 * WHETHER IT IS AN OPEN FIRE is published too — the scenery domain classified
 * all 500 lit pieces by eye (`light.kind`), and `smokes()` in plume.ts is that
 * one test. No name matching, no allowlist, no guessing from colour.
 *
 * IT SORTS AGAINST ITS OWN FIRE, the embers' law: every scenery piece draws an
 * opaque LIT COPY at ~900_001, so a mark left in the ambient band at 900_000.0x
 * is painted over by the very thing it comes out of. A puff takes its fire's
 * own `litDepth` plus a hair — a sort, not an override, so anything genuinely
 * standing in front of the fire still draws over the smoke.
 *
 * AND IT IS NOT ADDITIVE. The sparks glow, because an ember is hotter than
 * what is behind it; smoke is the opposite — it is something in the way. An
 * additive grey over a bright sky is invisible and over dark rock it is a
 * lantern. Normal blend, a neutral tint, low alpha.
 */

const NAME = "smoke";
const GAIN_TAU = 1500;
const LIGHT_MS = 620; // how often the light list is re-read (NOT per frame)
const MIN_R = 1; // cells — even a small fire smokes

/** The lift over the fire's own lit copy. The lit band compresses painter
 *  depth by 1e-5, so this is a tenth of a painter pixel: enough to sit in
 *  front of the piece the smoke leaves, not enough to jump anything that is
 *  really nearer the camera. (The embers' constant, for the same reason.) */
const SRC_LIFT = 1e-6;
/** No lit copy to sort against (no night shader, or the art has not landed):
 *  there is nothing to be in front OF, so go above the whole lit band but
 *  under the target rings and HP bars at 900_001.43. */
const ABOVE_LIT = 900_001.3;

const KEY = (n: number) => `amb-smoke${n}`;
/** The peak opacity of one puff. THIN IS THE COLUMN, NOT THE MARK: his word
 *  is about a few small wisps rather than a pillar, and a mark nobody can see
 *  is not thin, it is absent — a 0.34 peak moved its own pixels by 5.8 luma
 *  over lit ground (measured at a brazier, 2026-09-13). Most of a puff's life
 *  is spent well under this: `puffAlpha` holds the peak only briefly. */
const ALPHA = 0.5;

interface Puff {
  sprite: Phaser.GameObjects.Image;
  /* THE FLAME IT LEFT, CAPTURED AT BIRTH — the position, not just an index.
   * The fire list is REBUILT every LIGHT_MS from a fresh `lightsInView`, so an
   * index stored on a puff points at whatever happens to be in that slot a
   * moment later, or at nothing: the debug report then read a puff's height
   * above a flame at the world origin and called a 16,520 px column "wide"
   * (measured 2026-09-13, which is how the gate found it). The drawing was
   * always right — only the report was lying — and a report a gate reads is
   * not allowed to lie. */
  fire: number;
  fx: number;
  fy: number;
  x: number; // the flame it left, captured at birth
  y: number;
  age: number;
  life: number;
  up: number;
  curl: number;
  phase: number;
  hz: number;
  spread: number;
  depth: number;
  live: boolean;
}

interface Fire {
  id: string;
  x: number;
  y: number;
  kind: string;
  piece: string;
  gap: number;
  depth: number;
}

export function smokeFeature(): AmbientFeature {
  const puffs: Puff[] = [];
  let fires: Fire[] = [];
  let lightAge = 0;
  let probes = 0;
  let lit = 0; // how many lights were in view at the last read (QA)
  let inside = false; // under a roof? read on the light throttle, with the list
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let lastSun = 1;
  let seed = 7_310_913;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const range = ([a, b]: [number, number]) => a + rnd() * (b - a);

  const readFires = (): Fire[] => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    // On the same throttle as the light list — never per frame.
    try {
      const ind = ml?.indoor?.() as { indoor?: boolean } | null | undefined;
      inside = ind?.indoor === true;
    } catch {
      inside = false;
    }
    const f = ml?.lightsInView as
      | undefined
      | ((pad?: number) => {
          id: string; x: number; y: number; r: number;
          piece: string; kind: string; sealed: boolean;
          litDepth: number | null;
        }[]);
    if (!f) return [];
    probes++;
    try {
      const all = f(96) || [];
      lit = all.length;
      return all
        /* A SEALED FIRE IS ONE INSIDE A ROOM: it smokes only while you are in
         * there with it, or the wisps would draw over the roof that hides
         * their own fire — the wall-hack the cut-away exists to prevent. The
         * embers' rule, and the reason a source-attached effect follows its
         * SOURCE and not the sky. */
        .filter((l) => smokes(l.kind) && l.r >= MIN_R && (!l.sealed || inside))
        .map((l) => ({
          id: l.id, x: l.x, y: l.y, kind: l.kind, piece: l.piece,
          gap: rnd() * 200,
          depth: l.litDepth === null ? ABOVE_LIT : l.litDepth + SRC_LIFT,
        }));
    } catch {
      return [];
    }
  };

  const emit = (ctx: AmbientCtx, fi: number, fire: Fire) => {
    let p = puffs.find((q) => !q.live);
    if (!p && puffs.length < MAX_PUFFS) {
      p = {
        /* ORIGIN (0,0), like every pixel mark in this folder: a 1x1 quad
         * CENTRED on an integer straddles two pixels and the renderer drops it
         * (the embers measured 0.1 luma of change on a mark at alpha 0.81).
         * And the DEPTH IS APPLIED HERE — a factory that takes one and forgets
         * it leaves every mark at 0, under the darkness overlay (the drips,
         * 2026-09-13). */
        sprite: ctx.scene.add.image(0, 0, KEY(1)).setOrigin(0, 0).setScale(1).setVisible(false),
        fire: fi, fx: 0, fy: 0, x: 0, y: 0, age: 0, life: 0, up: 0, curl: 0, phase: 0, hz: 1, spread: 0,
        depth: ABOVE_LIT, live: false,
      };
      puffs.push(p);
    }
    if (!p) return; // at the ceiling
    p.fire = fi;
    p.fx = fire.x;
    p.fy = fire.y;
    // Leave the flame's own width, not one point.
    p.x = fire.x + (rnd() - 0.5) * 3;
    p.y = fire.y + (rnd() - 0.5) * 2;
    p.age = 0;
    p.life = range(PUFF_LIFE);
    p.up = range(RISE0);
    p.curl = range(CURL_PX) * (rnd() < 0.5 ? 1 : -1);
    /* THE PHASE WALKS, IT IS NOT ROLLED. Neighbours in a column must bend
     * together or the ribbon scatters into dots, so each puff takes the last
     * one's phase plus a small step rather than a fresh random. */
    p.phase = (p.phase || rnd() * Math.PI * 2) + 0.18;
    p.hz = range(CURL_HZ);
    p.spread = (rnd() - 0.5) * 2 * SPREAD_PX;
    p.depth = fire.depth;
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
    fires = [];
  };

  return {
    name: NAME,
    init(ctx) {
      // One, two and three pixels of white — the drawn colour is the tint.
      paintPixels(ctx.scene, KEY(1), 1, 1, 0xffffff, [[0, 0]]);
      paintPixels(ctx.scene, KEY(2), 2, 2, 0xffffff, [[0, 0], [1, 0], [0, 1], [1, 1]]);
      paintPixels(ctx.scene, KEY(3), 3, 3, 0xffffff, [
        [1, 0], [0, 1], [1, 1], [2, 1], [1, 2],
      ]);
    },
    update(ctx, dt) {
      const dtc = Math.min(dt, 100);
      lastSun = ctx.env.sun;
      const target = forced ? 1 : suppressed ? 0 : weight(ctx.env.sun);
      gain += (target - gain) * Math.min(1, (dtc / GAIN_TAU) * 3);
      /* NOT multiplied by ctx.outdoor — a source-attached effect follows its
       * SOURCE, not the roof (the embers' charter refinement). The sealed half
       * of the filter is what keeps it honest indoors. */
      const g = gain;
      if (g <= 0.02) {
        park();
        return;
      }

      lightAge += dtc;
      if (lightAge >= LIGHT_MS) {
        lightAge = 0;
        const next = readFires();
        // Keep each fire's own gap clock across a re-read, or a fire that stays
        // in view restarts its timer twice a second and puffs in lockstep.
        for (const f of next) {
          const was = fires.find((o) => o.id === f.id);
          if (was) f.gap = was.gap;
        }
        fires = next;
      }

      // ---- the fires give off ----
      for (let fi = 0; fi < fires.length; fi++) {
        const f = fires[fi];
        f.gap -= dtc;
        if (f.gap > 0) continue;
        f.gap = nextGap(rnd);
        const alive = puffs.reduce((n, q) => n + (q.live && q.fire === fi ? 1 : 0), 0);
        if (alive < PER_FIRE) emit(ctx, fi, f);
      }

      // ---- the wisps rise ----
      const tint = smokeTint(ctx.env.sun);
      for (const p of puffs) {
        if (!p.live) continue;
        p.age += dtc;
        if (p.age >= p.life) {
          p.live = false;
          p.sprite.setVisible(false).setAlpha(0);
          continue;
        }
        const a = puffAlpha(p.age, p.life) * ALPHA * g;
        if (a <= 0.004) {
          p.sprite.setVisible(false).setAlpha(0);
          continue;
        }
        const n = puffSize(p.age, p.life);
        p.sprite
          .setTexture(KEY(n))
          .setPosition(
            Math.round(p.x + driftX(p.age, p.curl, p.phase, p.hz, p.spread)),
            Math.round(p.y - riseY(p.age, p.life, p.up) + driftY(p.age)),
          )
          // NOT keyed on the puff's own screen y: a rising wisp would sort
          // itself behind its fire as it climbed. It belongs to the fire.
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
         * enabled field on regardless of its env gate — which is right for the
         * demo and useless for measuring a day/night rule, because `gain` then
         * reads 1 at midnight. This is the pure weight at the current sun. */
        weight: +weight(lastSun).toFixed(3),
        sun: +lastSun.toFixed(3),
        probes, // QA: the light list walks every source — it must stay throttled
        lights: lit, // how many lights were in view at all
        inside, // ...and whether the player is under a roof (sealed fires need it)
        fires: fires.length, // ...and how many of those are open fires
        fireList: fires.map((f) => ({
          id: f.id, x: Math.round(f.x), y: Math.round(f.y),
          kind: f.kind, piece: f.piece, depth: f.depth,
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
        /** Only what is on screen, and `a` is the drawn alpha. */
        all: live.map((p) => ({
          x: Math.round(p.sprite.x),
          y: Math.round(p.sprite.y),
          fire: p.fire,
          t: +(p.age / p.life).toFixed(3),
          a: +p.sprite.alpha.toFixed(3),
          fx: Math.round(p.fx),
          fy: Math.round(p.fy),
        })),
      };
    },
    dispose() {
      for (const p of puffs) p.sprite.destroy();
      puffs.length = 0;
      fires = [];
    },
  };
}
