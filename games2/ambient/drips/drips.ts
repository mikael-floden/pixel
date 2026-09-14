import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { paintPixels } from "../runtime/ground";
import { ellipsePixels } from "../runtime/ellipse";
import {
  FLASH_MS,
  HANG_MS,
  RING_R0,
  RING_RMAX,
  SPECK_MS,
  SPECK_N,
  SPLASH_MS,
  fallHeightPx,
  fallMs,
  fallY,
  flashAlpha,
  hangAlpha,
  hangSize,
  indoorGain,
  isCaveDecks,
  nextPeriod,
  phaseAt,
  ringAlpha,
  ringR,
  speckAt,
  timeline,
} from "./fall";

/* CAVE DRIPS — item 10 of the maintainer's effect list.
 *
 * THE FIRST EFFECT IN THIS FOLDER THAT LIVES UNDER A ROOF. Everything else
 * here is outdoor weather and wildlife and multiplies by `ctx.outdoor`; a drip
 * is the opposite case, so it multiplies by `1 - ctx.outdoor` (`indoorGain`)
 * and declares `indoor: true` so the indoor gate knows to assert the mirror.
 * One number either way, so the two can never disagree about how far through
 * the doorway you are.
 *
 * WHAT IT IS, at this scale: a POINT THAT KEEPS DRIPPING, not a rain of drops.
 * One drop is a couple of pixels and gone in half a second; what says "cave" is
 * that the SAME spot on the floor takes a drop every few seconds and rings
 * spread from it. So the unit is a spout with a period (`fall.ts` holds the
 * whole timeline, pinned by server/test/drips.test.ts).
 *
 * ONLY UNDER A CAVE, never under a cottage: a house ceiling that drips is a
 * leak, not a mood. The world's decks carry a KIND and `__ml.t3at` reports the
 * slabs over a cell with it, so the test is `isCaveDecks` on published data —
 * no name matching, no cell list, no guessing from the ground material.
 * `t3at` is a HEAVYWEIGHT probe, so it is read once per placement TRY and
 * never per frame, and the search itself is rate-limited with a backoff (the
 * folder's law for anything that has to find somewhere to be: rate-limit the
 * SEARCH, not just its success, or a cave with no landable floor in view costs
 * a probe every frame forever).
 *
 * ABOVE THE DARKNESS OVERLAY, with the crawlers. A cave is the darkest place in
 * the game — that is the whole point of it (INDOOR.md: the cave swallows the
 * light) — and a mark graded by the light where it stands would be multiplied
 * into the rock. Their own colour has to survive, so they sit a hair over the
 * overlay like the ants and spiders, and the drop is a pale, low-saturation
 * water blue: this is background, so the palette obeys the same cap the
 * butterflies do.
 */

const NAME = "drips";
const DEPTH_BASE = 900_000.05; // just over the darkness overlay, with the crawlers
const DEPTH_BIAS = 1e-6; // near-far order among the spouts themselves
const GAIN_TAU = 900;

/** A drop, and the water it leaves. Pale and barely saturated (HSV S ~0.13):
 *  a background mark, the butterflies' law. Painted WHITE and tinted, because
 *  `setTint` multiplies. */
const WATER = 0xcfe6ef;

const KEY_DROP = "amb-drip1"; // 1x1, the drop while it is still forming
const KEY_DROP2 = "amb-drip2"; // 2x2, swollen and falling
const KEY_FLASH = "amb-dripflash"; // 2x2, the moment of contact
const KEY_SPECK = "amb-dripspeck"; // 1x1
const RING_KEY = (r: number) => `amb-dripring${r}`;

const MAX_SPOUTS = 4;
/** Clearance a spout needs around its landing point, so a ring never crosses
 *  onto a wall: the ring's own reach along x, its squash down the screen. */
const CLEAR_X = RING_RMAX + 2;
const CLEAR_Y = 3;
const MIN_DIST = 40; // two spouts never share a patch of floor
const PLACE_TRIES = 6; // probed points per search, never nested searches
/** The search's own clock: one try per this many ms, backing off hard where
 *  there is no cave floor to find (a house, a lit room, a chamber whose floor
 *  is all water) and snapping back on the first success. */
const SEARCH_MS = 260;
const SEARCH_MAX_MS = 2400;
/** Off-view margin at which a spout is retired — the camera moved on. */
const KEEP_PAD = 64;

interface Spout {
  x: number; // the landing point, drawn iso px
  y: number;
  h: number; // fall height in px, from this room's own ceiling
  t: number; // ms into the current cycle
  period: number;
  hang: number;
  tl: ReturnType<typeof timeline>;
  drop: Phaser.GameObjects.Image | null;
  ring: Phaser.GameObjects.Image | null;
  flash: Phaser.GameObjects.Image | null;
  specks: (Phaser.GameObjects.Image | null)[];
  /** Peak drawn alpha this frame — the indoor gate and the browser gate read
   *  this, so it is written on EVERY path, the early ones included. */
  a: number;
  phase: string;
}

export function dripsFeature(): AmbientFeature {
  const spouts: Spout[] = [];
  let scene: Phaser.Scene | null = null;
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let searchIn = 0;
  let searchGap = SEARCH_MS;
  let seed = 20260913;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const stats = { placed: 0, tries: 0, caveProbes: 0, rejected: 0, retired: 0 };
  let ceiling: number | null = null;

  const probes = () => (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;

  /* THE GROUND HELPERS IN `runtime/ground.ts` CANNOT SEE INSIDE A ROOM, which is
   * why this feature carries its own. They are built on `landableAtScreen`, and
   * that probe resolves the front-most drawn surface out of the RAW world rows —
   * it knows nothing about the cut-away, so inside a cave it keeps answering
   * about the mountain overhead instead of the floor you are standing on.
   * Measured over 64 points across one chamber: `landableAtScreen` said yes to
   * ONE of them, while `pickAt` + `surfaceAt` found 22 dry floor points, 21 of
   * them on my own terrace. `pickGround` IS cut-aware (it starts its scan at
   * `indoorTop`, which is the whole reason an indoor tap lands where the finger
   * is), so every indoor placement asks it. Two probes, so this is a PLACEMENT
   * call and never a per-frame one. */
  const groundAt = (wx: number, wy: number): { x: number; y: number; lvl: number } | null => {
    const ml = probes();
    const pick = ml?.pickAt as undefined | ((x: number, y: number) => { x: number; y: number; lvl: number } | null);
    if (!pick) return null;
    try {
      return pick(wx, wy);
    } catch {
      return null;
    }
  };

  /** Is the ground at a picked point dry and standable? World units in — the
   *  picker has already left drawn iso pixels behind. */
  const dryAt = (p: { x: number; y: number }): boolean => {
    const surf = probes()?.surfaceAt as undefined | ((x: number, y: number) => { standable?: boolean; swimmable?: boolean } | null);
    if (!surf) return false;
    try {
      const s = surf(p.x, p.y);
      return !!s && s.standable === true && s.swimmable !== true;
    } catch {
      return false;
    }
  };

  /** Is a CAVE's slab over this cell? The world's decks carry a KIND, so the
   *  test is published data rather than a guess from the ground material — and
   *  it is what keeps a cottage from leaking. `t3at` is heavyweight: one read
   *  per placement try that got this far, never per frame. */
  const overCave = (p: { x: number; y: number; lvl: number }): boolean => {
    const t3 = probes()?.t3at as undefined | ((col: number, row: number) => { decks?: { kind?: string | null; level?: number }[] } | null);
    if (!t3) return false;
    try {
      stats.caveProbes++;
      return isCaveDecks(t3(Math.floor(p.x / 32), Math.floor(p.y / 32))?.decks, p.lvl);
    } catch {
      return false;
    }
  };

  /** The room's ceiling AND my own floor, in LEVELS, from one probe read:
   *  `ceiling` is `indoorCeil` (the slab underside over my cell) and `elev` is
   *  the surface I am standing on. Read on the search's clock, never per frame. */
  const readRoom = (): { ceiling: number | null; elev: number | null } => {
    try {
      const r = (probes()?.indoor as undefined | (() => { ceiling?: number | null; elev?: number | null } | null))?.();
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      return { ceiling: num(r?.ceiling), elev: num(r?.elev) };
    } catch {
      return { ceiling: null, elev: null };
    }
  };

  const tooClose = (x: number, y: number): boolean =>
    spouts.some((s) => Math.abs(s.x - x) < MIN_DIST && Math.abs(s.y - y) * 2.3 < MIN_DIST);

  /* ORIGIN (0,0) and the DEPTH APPLIED HERE — both load-bearing, and the second
   * one shipped wrong for a day. A 1x1 quad centred on an integer straddles two
   * pixels and the renderer drops it (the embers' law), and a sprite left at
   * Phaser's default depth 0 sits UNDER the darkness overlay at 900_000: in a
   * cave, which is the darkest place in the game, that paints it out
   * completely. Every counter said the effect was running — 4 spouts, alpha 1,
   * rings spreading — and the screen moved 0.6 luma where the drop was. */
  const img = (key: string, depth: number): Phaser.GameObjects.Image | null =>
    scene
      ? scene.add.image(0, 0, key).setOrigin(0, 0).setScale(1).setDepth(depth).setVisible(false).setTint(WATER)
      : null;

  /** One search: up to PLACE_TRIES probed points, each one picker-resolved, and
   *  at most one cave read on a point that already looks like floor. Never a
   *  nested search (the folder's law: a search is one probed point per try). */
  const place = (ctx: AmbientCtx, floorLvl: number | null): boolean => {
    const v = ctx.view;
    for (let t = 0; t < PLACE_TRIES; t++) {
      stats.tries++;
      const x = Math.round(v.x + rnd() * v.width);
      const y = Math.round(v.y + rnd() * v.height);
      const p = groundAt(x, y);
      if (!p) continue;
      if (floorLvl !== null && p.lvl !== floorLvl) continue; // my terrace, not the shelf above
      if (!dryAt(p)) continue;                                // never over the cave's water
      if (tooClose(x, y)) continue;
      // Room for the ring on every side, measured the same cut-aware way: a
      // splash that crosses onto a wall face reads as a mark climbing the rock.
      const flat = (dx: number, dy: number) => {
        const q = groundAt(x + dx, y + dy);
        return !!q && q.lvl === p.lvl;
      };
      if (!flat(CLEAR_X, 0) || !flat(-CLEAR_X, 0) || !flat(0, CLEAR_Y) || !flat(0, -CLEAR_Y)) continue;
      if (!overCave(p)) continue;
      const hang = HANG_MS[0] + rnd() * (HANG_MS[1] - HANG_MS[0]);
      const period = nextPeriod(rnd);
      const h = fallHeightPx(ceiling, p.lvl);
      spouts.push({
        x, y, h, hang, period,
        // Start each spout somewhere in its own cycle, or every spout in a
        // chamber lets go on the same frame and the cave claps.
        t: rnd() * period,
        tl: timeline(hang, h, period),
        drop: null, ring: null, flash: null, specks: Array.from({ length: SPECK_N }, () => null),
        a: 0, phase: "wait",
      });
      stats.placed++;
      return true;
    }
    stats.rejected++;
    return false;
  };

  const retire = (s: Spout) => {
    s.drop?.destroy();
    s.ring?.destroy();
    s.flash?.destroy();
    for (const q of s.specks) q?.destroy();
  };

  const hideAll = () => {
    for (const s of spouts) {
      // `a` IS THE DRAWN ALPHA ON EVERY PATH — zero it here too, or the gates
      // read a mark nobody is drawing (the spiders' bug, 2026-09-13).
      s.a = 0;
      s.phase = "off";
      s.drop?.setVisible(false).setAlpha(0);
      s.ring?.setVisible(false).setAlpha(0);
      s.flash?.setVisible(false).setAlpha(0);
      for (const q of s.specks) q?.setVisible(false).setAlpha(0);
    }
  };

  return {
    name: NAME,
    /** UNDER A ROOF, not out in the weather — the mount's outdoor gain is
     *  mirrored for this one, and the indoor gate reads this flag. */
    indoor: true,
    init(ctx) {
      scene = ctx.scene;
      paintPixels(ctx.scene, KEY_DROP, 1, 1, 0xffffff, [[0, 0]]);
      paintPixels(ctx.scene, KEY_DROP2, 2, 2, 0xffffff, [[0, 0], [1, 0], [0, 1], [1, 1]]);
      paintPixels(ctx.scene, KEY_FLASH, 2, 2, 0xffffff, [[0, 0], [1, 0], [0, 1], [1, 1]]);
      paintPixels(ctx.scene, KEY_SPECK, 1, 1, 0xffffff, [[0, 0]]);
      for (let r = RING_R0; r <= RING_RMAX; r++) {
        const { ry, px } = ellipsePixels(r);
        paintPixels(ctx.scene, RING_KEY(r), 2 * r + 1, 2 * ry + 1, 0xffffff,
          px.map(([x, y]) => [x + r, y + ry] as [number, number]));
      }
    },
    update(ctx, dt) {
      const dtc = Math.min(dt, 100);
      const target = forced ? 1 : suppressed ? 0 : 1;
      gain += (target - gain) * Math.min(1, (dtc / GAIN_TAU) * 3);
      // THE MIRROR: 1 outdoors is 0 here. A forced spout in the open still draws
      // nothing — there is no ceiling out there to drip from.
      const g = gain * indoorGain(ctx.outdoor);

      if (g <= 0.02) {
        if (spouts.length) {
          hideAll();
          for (const s of spouts) retire(s);
          spouts.length = 0;
          stats.retired++;
        }
        searchIn = 0;
        searchGap = SEARCH_MS;
        return;
      }

      // ---- the camera moved on ----
      const v = ctx.view;
      for (let i = spouts.length - 1; i >= 0; i--) {
        const s = spouts[i];
        if (s.x < v.x - KEEP_PAD || s.x > v.right + KEEP_PAD || s.y < v.y - KEEP_PAD || s.y > v.bottom + KEEP_PAD) {
          retire(s);
          spouts.splice(i, 1);
          stats.retired++;
        }
      }

      // ---- find somewhere to drip, on the search's own clock ----
      searchIn -= dtc;
      if (searchIn <= 0 && spouts.length < MAX_SPOUTS) {
        searchIn = searchGap;
        const room = readRoom();
        ceiling = room.ceiling;
        if (place(ctx, room.elev)) searchGap = SEARCH_MS;
        else searchGap = Math.min(SEARCH_MAX_MS, searchGap * 1.7);
      }

      // ---- the spouts drip ----
      for (const s of spouts) {
        s.t += dtc;
        if (s.t >= s.tl.nextAt) {
          s.t -= s.tl.nextAt;
          s.hang = HANG_MS[0] + rnd() * (HANG_MS[1] - HANG_MS[0]);
          s.period = nextPeriod(rnd);
          s.tl = timeline(s.hang, s.h, s.period);
        }
        const ph = phaseAt(s.t, s.tl);
        s.phase = ph;
        s.a = 0;

        // the drop: hanging, then falling
        if (ph === "hang" || ph === "fall") {
          const hanging = ph === "hang";
          const key = hanging ? (hangSize(s.t, s.hang) === 2 ? KEY_DROP2 : KEY_DROP) : KEY_DROP2;
          const a = hanging ? hangAlpha(s.t, s.hang) * g : g;
          if (!s.drop) s.drop = img(KEY_DROP, DEPTH_BASE + s.y * DEPTH_BIAS);
          const dy = hanging ? 0 : fallY(s.t - s.tl.fallAt, s.h);
          s.drop
            ?.setTexture(key)
            .setPosition(Math.round(s.x), Math.round(s.y - s.h + dy))
            .setAlpha(a)
            .setVisible(a > 0.01);
          if (a > s.a) s.a = a;
        } else if (s.drop?.visible) s.drop.setVisible(false).setAlpha(0);

        // the splash: a flash at contact, a ring leaving it, two specks
        const age = s.t - s.tl.splashAt;
        const ra = ringAlpha(age) * g;
        if (ra > 0.01) {
          const r = ringR(age);
          if (!s.ring) s.ring = img(RING_KEY(RING_R0), DEPTH_BASE + s.y * DEPTH_BIAS + 1e-7);
          const { ry } = ellipsePixels(r);
          s.ring
            ?.setTexture(RING_KEY(r))
            .setPosition(Math.round(s.x - r), Math.round(s.y - ry))
            .setAlpha(ra)
            .setVisible(true);
          if (ra > s.a) s.a = ra;
        } else if (s.ring?.visible) s.ring.setVisible(false).setAlpha(0);

        const fa = flashAlpha(age) * g;
        if (fa > 0.01) {
          if (!s.flash) s.flash = img(KEY_FLASH, DEPTH_BASE + s.y * DEPTH_BIAS + 2e-7);
          s.flash?.setPosition(Math.round(s.x), Math.round(s.y - 1)).setAlpha(fa).setVisible(true);
          if (fa > s.a) s.a = fa;
        } else if (s.flash?.visible) s.flash.setVisible(false).setAlpha(0);

        for (let k = 0; k < s.specks.length; k++) {
          const q = speckAt(k, age);
          const qa = q.alive ? g * 0.8 * (1 - age / SPECK_MS) : 0;
          if (qa > 0.01) {
            if (!s.specks[k]) s.specks[k] = img(KEY_SPECK, DEPTH_BASE + s.y * DEPTH_BIAS + 3e-7);
            s.specks[k]?.setPosition(Math.round(s.x + q.dx), Math.round(s.y + q.dy)).setAlpha(qa).setVisible(true);
            if (qa > s.a) s.a = qa;
          } else if (s.specks[k]?.visible) s.specks[k]!.setVisible(false).setAlpha(0);
        }
      }
    },
    setSuppressed(on) {
      suppressed = on;
      if (on) hideAll();
    },
    setForced(on) {
      forced = on;
    },
    debug() {
      return {
        gain: +gain.toFixed(3),
        suppressed,
        forced,
        ceiling,
        spouts: spouts.length,
        searchGapMs: Math.round(searchGap),
        splashMs: SPLASH_MS,
        flashMs: FLASH_MS,
        ...stats,
        /* WHAT THE SPRITE ITSELF SAYS. A mark can be positioned, tinted and
         * given an alpha and still never reach the screen, and from outside
         * this feature the numbers look identical either way — a depth left at
         * 0 under the darkness overlay reads exactly like a working effect.
         * So the brightest live mark reports its own render state. */
        draw: (() => {
          const q = spouts.filter((s) => s.a > 0).sort((a, b) => b.a - a.a)[0];
          const sp = q?.drop?.visible ? q.drop : q?.ring?.visible ? q.ring : null;
          if (!sp) return null;
          return {
            visible: sp.visible, alpha: +sp.alpha.toFixed(3), depth: sp.depth,
            dw: sp.displayWidth, dh: sp.displayHeight, tex: sp.texture?.key,
            x: Math.round(sp.x), y: Math.round(sp.y), inScene: !!sp.scene,
          };
        })(),
        /** Only what is on screen, and `a` is the drawn alpha — the folder's
         *  law, which the spiders paid for on 2026-09-13. */
        all: spouts
          .filter((s) => s.a > 0)
          .map((s) => ({
            x: Math.round(s.x),
            y: Math.round(s.y),
            h: s.h,
            phase: s.phase,
            // where the drop is RIGHT NOW, so a gate can watch it fall
            dropY: s.drop?.visible ? Math.round(s.drop.y) : null,
            ringR: s.ring?.visible ? ringR(s.t - s.tl.splashAt) : null,
            a: +s.a.toFixed(3),
          })),
      };
    },
    dispose() {
      for (const s of spouts) retire(s);
      spouts.length = 0;
      scene = null;
    },
  };
}
