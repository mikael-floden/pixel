import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { paintPixels } from "../runtime/ground";
import { ellipsePixels } from "../runtime/ellipse";
import {
  ASH,
  ASH_HZ,
  ASH_LIFE,
  ASH_RISE,
  ASH_SWAY,
  CRUST_R0,
  CRUST_RMAX,
  SPARK_N,
  SWELL_MS,
  HOLD_MS,
  ashAlpha,
  ashX,
  ashY,
  crustAlpha,
  crustR,
  crustTint,
  domeAlpha,
  domeR,
  domeTint,
  isLava,
  nextPeriod,
  phaseAt,
  popAlpha,
  sparkAt,
  timeline,
} from "./molten";

/* LAVA — the pool breathes: a dome swells, holds, bursts, and leaves a ring of
 * cooled crust; ash drifts up off the surface and is gone.
 *
 * WHERE IT GOES is asked of the SURFACE TABLE, not of a ground name: lava is
 * the game's one liquid that BURNS (`harm` 4 HP/s), and `isLava` in molten.ts
 * is that one question. A second molten liquid would bubble the day it is
 * added.
 *
 * IT ASKS THE PICKER, NOT `landableAtScreen`. Lava is not landable — it is
 * swimmable — and the folder's ground helpers answer about walkable dry top
 * ground, so none of them can find a pool at all. `pickAt` resolves what is
 * DRAWN at a screen point and `surfaceAt` says what that is made of; both are
 * two probes, so this is a PLACEMENT call and never a per-frame one (the
 * drips' lesson, in a different costume).
 *
 * THE POOL'S COLOUR IS READ FROM THE TILES DOMAIN, the seam `foam/` opened:
 * `/assets/tiles/ground_types.json` publishes `lava.palette.top` (the pool)
 * and `.wall` (its cooled skin), so a recoloured lava recolours its own
 * bubbles with no edit here. The measured values are the fallback, and a
 * failed fetch degrades to them rather than to nothing.
 *
 * AND IT DEPARTS FROM THAT COLOUR IN BOTH DIRECTIONS. The pool is the
 * brightest thing on the screen, so a mark that is merely orange is lost in it
 * — the smoke's lesson, paid in advance this time. The dome is HOTTER (a
 * stretched skin over the fire beneath), the crust is COOLER, and the ash is
 * nearly black. Every one of the three is legible against `#fd5a02`.
 */

const NAME = "lava";
/** Just over the darkness overlay, with the crawlers: a glowing mark must keep
 *  its own colour when night grades the world, and the pool it sits on is
 *  emissive anyway. */
const DEPTH_BASE = 900_000.05;
const DEPTH_BIAS = 1e-6;
const GAIN_TAU = 1200;

const GROUNDS_URL = "/assets/tiles/ground_types.json";
/** tiles/ground_types.json, measured 2026-09-13 — the fallback, never the
 *  source of truth. */
const LAVA_FALLBACK = 0xfd5a02;
const WALL_FALLBACK = 0xa73211;

const KEY = (n: number) => `amb-lava${n}`;
const RING_KEY = (r: number) => `amb-lavaring${r}`;
const ASH_KEY = "amb-lavaash";

const MAX_VENTS = 4;
const MIN_DIST = 36; // two vents never share a patch of pool
const CLEAR = CRUST_RMAX + 2; // room for the crust ring, all round
/** ONE PROBED POINT PER TRY, and few tries: the picker is a ray walk and the
 *  clearance check is four more of them, so six tries that all reach clearance
 *  is thirty probes in one frame — measured as a 4.8 ms spike, which is a
 *  dropped frame on his phone. Two tries on a 300 ms clock spreads the same
 *  search over time (the folder's law: rate-limit the SEARCH, not its success). */
const PLACE_TRIES = 2;
const SEARCH_MS = 300;
const SEARCH_MAX_MS = 2600;
const KEEP_PAD = 64;
const MAX_ASH = 26;
/** Ash leaves the pool around a vent, not out of one point — a pond smokes
 *  along its surface. */
const ASH_SPREAD = 14;
const ASH_GAP: [number, number] = [260, 700];

interface Spark {
  sprite: Phaser.GameObjects.Image;
  live: boolean;
}

interface Vent {
  x: number;
  y: number;
  t: number;
  swell: number;
  hold: number;
  period: number;
  tl: ReturnType<typeof timeline>;
  dome: Phaser.GameObjects.Image | null;
  flash: Phaser.GameObjects.Image | null;
  ring: Phaser.GameObjects.Image | null;
  sparks: Spark[];
  ashIn: number;
  /** Peak drawn alpha this frame — written on EVERY path, the early ones too. */
  a: number;
  phase: string;
}

interface Mote {
  sprite: Phaser.GameObjects.Image;
  /** A STABLE ID FOR THE LIFE OF THIS MOTE. A gate that wants to watch one
   *  rise has to tell it from its neighbours, and position is not an identity:
   *  keying on the drawn x conflated two motes that drifted across each other
   *  and reported ash SINKING (2151 times against 3874 rising) on a curve that
   *  is monotone by construction. Anything a gate follows over time needs an
   *  id that does not move. */
  id: number;
  x: number;
  y: number;
  age: number;
  life: number;
  up: number;
  sway: number;
  phase: number;
  hz: number;
  live: boolean;
}

export function lavaFeature(): AmbientFeature {
  const vents: Vent[] = [];
  const ash: Mote[] = [];
  let scene: Phaser.Scene | null = null;
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let searchIn = 0;
  let searchGap = SEARCH_MS;
  let seed = 0x1a7a;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const range = ([a, b]: [number, number]) => a + rnd() * (b - a);
  const stats = { placed: 0, tries: 0, rejected: 0, retired: 0, bursts: 0 };
  let lavaRGB = LAVA_FALLBACK;
  let wallRGB = WALL_FALLBACK;
  let palette: "fetched" | "fallback" = "fallback";
  let moteSeq = 0;

  const probes = () => (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;

  /** What is DRAWN at this screen point, and is it a molten pool? Two probes,
   *  so placement only — and `pickAt` because it is the cut-aware one. */
  const lavaAt = (wx: number, wy: number): { x: number; y: number; lvl: number } | null => {
    const ml = probes();
    const pick = ml?.pickAt as undefined | ((x: number, y: number) => { x: number; y: number; lvl: number } | null);
    const surf = ml?.surfaceAt as
      | undefined
      | ((x: number, y: number) => { swimmable?: boolean; harm?: number } | null);
    if (!pick || !surf) return null;
    try {
      const p = pick(wx, wy);
      if (!p) return null;
      return isLava(surf(p.x, p.y)) ? p : null;
    } catch {
      return null;
    }
  };

  const loadPalette = () => {
    fetch(GROUNDS_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((doc: { grounds?: Record<string, unknown> } & Record<string, unknown>) => {
        const table = (doc.grounds ?? doc) as Record<string, { palette?: { top?: string; wall?: string }; base_color?: string }>;
        const hex = (s: unknown): number | null =>
          typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s) ? parseInt(s.slice(1), 16) : null;
        const top = hex(table.lava?.palette?.top ?? table.lava?.base_color);
        const wall = hex(table.lava?.palette?.wall);
        if (top !== null) {
          lavaRGB = top;
          palette = "fetched";
        }
        if (wall !== null) wallRGB = wall;
      })
      .catch((e) => console.warn("[ambient/lava] ground palette unavailable, the pool takes its measured tone:", e));
  };

  const tooClose = (x: number, y: number): boolean =>
    vents.some((v) => Math.abs(v.x - x) < MIN_DIST && Math.abs(v.y - y) * 2.3 < MIN_DIST);

  const img = (key: string, depth: number, blend: number, tint: number): Phaser.GameObjects.Image | null =>
    scene
      ? scene.add
          .image(0, 0, key)
          .setOrigin(0, 0)
          .setScale(1)
          .setDepth(depth) // APPLIED here — a factory that forgets leaves it at 0 (the drips)
          .setBlendMode(blend)
          .setTint(tint)
          .setVisible(false)
      : null;

  /** One search: up to PLACE_TRIES probed points, each a picker resolve, plus
   *  four clearance probes on a point that already looks molten. */
  const place = (ctx: AmbientCtx): boolean => {
    const view = ctx.view;
    for (let t = 0; t < PLACE_TRIES; t++) {
      stats.tries++;
      const x = Math.round(view.x + rnd() * view.width);
      const y = Math.round(view.y + rnd() * view.height);
      const p = lavaAt(x, y);
      if (!p) continue;
      if (tooClose(x, y)) continue;
      // Room for the crust ring on every side, or it climbs onto the rock.
      if (!lavaAt(x + CLEAR, y) || !lavaAt(x - CLEAR, y)) continue;
      if (!lavaAt(x, y + 3) || !lavaAt(x, y - 3)) continue;
      const swell = range(SWELL_MS);
      const hold = range(HOLD_MS);
      const period = nextPeriod(rnd);
      vents.push({
        x, y, swell, hold, period,
        // Start each vent somewhere in its own cycle, or a pool pulses.
        t: rnd() * period,
        tl: timeline(swell, hold, period),
        dome: null, flash: null, ring: null,
        sparks: Array.from({ length: SPARK_N }, () => ({ sprite: null as unknown as Phaser.GameObjects.Image, live: false })),
        ashIn: range(ASH_GAP),
        a: 0, phase: "wait",
      });
      stats.placed++;
      return true;
    }
    stats.rejected++;
    return false;
  };

  const retire = (v: Vent) => {
    v.dome?.destroy();
    v.flash?.destroy();
    v.ring?.destroy();
    for (const s of v.sparks) s.sprite?.destroy();
  };

  const park = () => {
    for (const v of vents) {
      v.a = 0;
      v.phase = "off";
      v.dome?.setVisible(false).setAlpha(0);
      v.flash?.setVisible(false).setAlpha(0);
      v.ring?.setVisible(false).setAlpha(0);
      for (const s of v.sparks) s.sprite?.setVisible(false).setAlpha(0);
    }
    for (const m of ash)
      if (m.sprite.visible) {
        m.sprite.setVisible(false).setAlpha(0);
        m.live = false;
      }
  };

  const emitAsh = (v: Vent) => {
    let m = ash.find((q) => !q.live);
    if (!m && ash.length < MAX_ASH && scene) {
      m = {
        sprite: scene.add.image(0, 0, ASH_KEY).setOrigin(0, 0).setScale(1).setDepth(DEPTH_BASE).setTint(ASH).setVisible(false),
        id: 0, x: 0, y: 0, age: 0, life: 0, up: 0, sway: 0, phase: 0, hz: 1, live: false,
      };
      ash.push(m);
    }
    if (!m) return;
    m.id = ++moteSeq;
    m.x = v.x + (rnd() - 0.5) * 2 * ASH_SPREAD;
    m.y = v.y + (rnd() - 0.5) * 4;
    m.age = 0;
    m.life = range(ASH_LIFE);
    m.up = range(ASH_RISE);
    m.sway = range(ASH_SWAY) * (rnd() < 0.5 ? 1 : -1);
    m.phase = rnd() * Math.PI * 2;
    m.hz = range(ASH_HZ);
    m.live = true;
    m.sprite.setDepth(DEPTH_BASE + m.y * DEPTH_BIAS + 4e-7).setVisible(true).setAlpha(0);
  };

  return {
    name: NAME,
    init(ctx) {
      scene = ctx.scene;
      paintPixels(ctx.scene, KEY(1), 1, 1, 0xffffff, [[0, 0]]);
      paintPixels(ctx.scene, KEY(2), 2, 2, 0xffffff, [[0, 0], [1, 0], [0, 1], [1, 1]]);
      paintPixels(ctx.scene, KEY(3), 3, 3, 0xffffff, [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]]);
      paintPixels(ctx.scene, ASH_KEY, 1, 1, 0xffffff, [[0, 0]]);
      for (let r = CRUST_R0; r <= CRUST_RMAX; r++) {
        const { ry, px } = ellipsePixels(r);
        paintPixels(ctx.scene, RING_KEY(r), 2 * r + 1, 2 * ry + 1, 0xffffff,
          px.map(([x, y]) => [x + r, y + ry] as [number, number]));
      }
      loadPalette();
    },
    update(ctx, dt) {
      const dtc = Math.min(dt, 100);
      const target = forced ? 1 : suppressed ? 0 : 1;
      gain += (target - gain) * Math.min(1, (dtc / GAIN_TAU) * 3);
      // A pool is out in the weather like everything else in this folder.
      const g = gain * ctx.outdoor;

      if (g <= 0.02) {
        if (vents.length || ash.some((m) => m.live)) {
          park();
          for (const v of vents) retire(v);
          vents.length = 0;
          stats.retired++;
        }
        searchIn = 0;
        searchGap = SEARCH_MS;
        return;
      }

      // ---- the camera moved on ----
      const view = ctx.view;
      for (let i = vents.length - 1; i >= 0; i--) {
        const v = vents[i];
        if (v.x < view.x - KEEP_PAD || v.x > view.right + KEEP_PAD || v.y < view.y - KEEP_PAD || v.y > view.bottom + KEEP_PAD) {
          retire(v);
          vents.splice(i, 1);
          stats.retired++;
        }
      }

      // ---- find a pool, on the search's own clock ----
      searchIn -= dtc;
      if (searchIn <= 0 && vents.length < MAX_VENTS) {
        searchIn = searchGap;
        searchGap = place(ctx) ? SEARCH_MS : Math.min(SEARCH_MAX_MS, searchGap * 1.7);
      }

      const hot = domeTint(lavaRGB, 0);
      const crust = crustTint(wallRGB);

      // ---- the pool breathes ----
      for (const v of vents) {
        v.t += dtc;
        if (v.t >= v.tl.nextAt) {
          v.t -= v.tl.nextAt;
          v.swell = range(SWELL_MS);
          v.hold = range(HOLD_MS);
          v.period = nextPeriod(rnd);
          v.tl = timeline(v.swell, v.hold, v.period);
        }
        const ph = phaseAt(v.t, v.tl);
        if (ph === "pop" && v.phase === "swell") stats.bursts++;
        v.phase = ph;
        v.a = 0;

        // the dome, swelling and holding
        const da = domeAlpha(v.t, v.swell, v.hold) * g * 0.85;
        if (da > 0.01) {
          const r = domeR(v.t, v.swell);
          if (!v.dome) v.dome = img(KEY(1), DEPTH_BASE + v.y * DEPTH_BIAS + 1e-7, Phaser.BlendModes.NORMAL, hot);
          v.dome
            ?.setTexture(KEY(r))
            .setPosition(Math.round(v.x - (r - 1)), Math.round(v.y - (r - 1)))
            // hotter as the skin stretches
            .setTint(domeTint(lavaRGB, Math.min(1, v.t / Math.max(1, v.swell))))
            .setAlpha(da)
            .setVisible(true);
          if (da > v.a) v.a = da;
        } else if (v.dome?.visible) v.dome.setVisible(false).setAlpha(0);

        // the burst: a flash of light, a ring of cooled crust, a few sparks
        const age = v.t - v.tl.popAt;
        const fa = popAlpha(age) * g;
        if (fa > 0.01) {
          if (!v.flash) v.flash = img(KEY(3), DEPTH_BASE + v.y * DEPTH_BIAS + 3e-7, Phaser.BlendModes.ADD, hot);
          v.flash?.setPosition(Math.round(v.x - 1), Math.round(v.y - 1)).setAlpha(fa).setVisible(true);
          if (fa > v.a) v.a = fa;
        } else if (v.flash?.visible) v.flash.setVisible(false).setAlpha(0);

        const ca = crustAlpha(age) * g * 0.9;
        if (ca > 0.01) {
          const r = crustR(age);
          const { ry } = ellipsePixels(r);
          if (!v.ring) v.ring = img(RING_KEY(CRUST_R0), DEPTH_BASE + v.y * DEPTH_BIAS + 2e-7, Phaser.BlendModes.NORMAL, crust);
          v.ring
            ?.setTexture(RING_KEY(r))
            .setPosition(Math.round(v.x - r), Math.round(v.y - ry))
            .setTint(crust)
            .setAlpha(ca)
            .setVisible(true);
          if (ca > v.a) v.a = ca;
        } else if (v.ring?.visible) v.ring.setVisible(false).setAlpha(0);

        for (let k = 0; k < v.sparks.length; k++) {
          const s = sparkAt(k, age);
          const sa = s.alive ? g * 0.9 * popAlphaTail(age) : 0;
          const sp = v.sparks[k];
          if (sa > 0.01) {
            if (!sp.sprite) {
              const made = img(KEY(1), DEPTH_BASE + v.y * DEPTH_BIAS + 5e-7, Phaser.BlendModes.ADD, hot);
              if (!made) continue;
              sp.sprite = made;
            }
            sp.sprite.setPosition(Math.round(v.x + s.dx), Math.round(v.y + s.dy)).setAlpha(sa).setVisible(true);
            if (sa > v.a) v.a = sa;
          } else if (sp.sprite?.visible) sp.sprite.setVisible(false).setAlpha(0);
        }

        // ...and the pool smokes between bursts
        v.ashIn -= dtc;
        if (v.ashIn <= 0) {
          v.ashIn = range(ASH_GAP);
          emitAsh(v);
        }
      }

      // ---- the ash drifts ----
      for (const m of ash) {
        if (!m.live) continue;
        m.age += dtc;
        const a = ashAlpha(m.age, m.life, m.up) * g * 0.75;
        if (m.age >= m.life || a <= 0.004) {
          m.live = false;
          m.sprite.setVisible(false).setAlpha(0);
          continue;
        }
        m.sprite
          .setPosition(
            Math.round(m.x + ashX(m.age, m.sway, m.phase, m.hz)),
            Math.round(m.y - ashY(m.age, m.life, m.up)),
          )
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
      const liveAsh = ash.filter((m) => m.live && m.sprite.visible);
      const shown = vents.filter((v) => v.a > 0);
      return {
        gain: +gain.toFixed(3),
        vents: vents.length,
        ash: liveAsh.length,
        palette, // fetched from the tiles domain, or the measured fallback
        lava: lavaRGB,
        wall: wallRGB,
        searchGapMs: Math.round(searchGap),
        ...stats,
        /** The brightest live mark's own render state — a mark can be placed,
         *  tinted and given an alpha and still never reach the screen. */
        draw: (() => {
          const v = shown.sort((a, b) => b.a - a.a)[0];
          const sp = v?.dome?.visible ? v.dome : v?.ring?.visible ? v.ring : v?.flash?.visible ? v.flash : null;
          if (!sp) return null;
          return {
            visible: sp.visible, alpha: +sp.alpha.toFixed(3), depth: sp.depth,
            dw: sp.displayWidth, dh: sp.displayHeight, tex: sp.texture?.key,
            blend: sp.blendMode, tint: sp.tintTopLeft,
          };
        })(),
        /** Only what is on screen, and `a` is the drawn alpha. */
        all: shown.map((v) => ({
          x: Math.round(v.x), y: Math.round(v.y), phase: v.phase,
          domeR: v.dome?.visible ? domeR(v.t, v.swell) : null,
          ringR: v.ring?.visible ? crustR(v.t - v.tl.popAt) : null,
          a: +v.a.toFixed(3),
        })),
        /** ...and the motes, so the gate can watch them rise and stop. */
        motes: liveAsh.map((m) => ({
          id: m.id,
          x: Math.round(m.sprite.x), y: Math.round(m.sprite.y),
          up: Math.round(ashY(m.age, m.life, m.up)),
          a: +m.sprite.alpha.toFixed(3),
        })),
      };
    },
    dispose() {
      for (const v of vents) retire(v);
      for (const m of ash) m.sprite.destroy();
      vents.length = 0;
      ash.length = 0;
      scene = null;
    },
  };
}

/** A spark dims over the burst's own tail rather than winking out — the
 *  folder's standing rule that nothing is switched off. */
function popAlphaTail(age: number): number {
  const t = Math.max(0, age) / 520;
  return Math.max(0, 1 - t * t);
}
