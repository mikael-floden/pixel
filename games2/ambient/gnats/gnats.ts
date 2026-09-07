import Phaser from "phaser";
import { AmbientCtx, AmbientEnv, AmbientFeature } from "../runtime/types";
import { findGround, paintPixels } from "../runtime/ground";

/* GNATS — the column that hangs over one spot at dusk.
 *
 * A midge swarm is not a cloud of insects going somewhere: it is a COLUMN that
 * stands still. Each gnat flies hard inside a small volume, the volume itself
 * barely moves, and the whole thing hangs over one patch of ground until
 * something walks through it. That standing-still is the entire effect — a
 * drifting cloud reads as dust, and this repo already has dust (pollen/).
 *
 * WHEN. Dusk, which here means the EVENING phase, with a weaker dawn column in
 * the morning: a swarm needs still, warm, low-light air. Rain, storm, snow and
 * wind take it away outright — a real swarm is gone the moment the air moves.
 *
 * WHERE. Over dry ground with clearance on every side (`findGround`), never a
 * shoreline or a cliff lip, and it MOVES WITH THE PLAYER: when its anchor
 * leaves the view the column re-places on ground the player can see. Running
 * somewhere new must not empty the world (the crawlers' lesson).
 *
 * The column has no cliff problem the ants have — it is one anchor point, not a
 * line laid across the terrain — so there is no one-terrace rule here.
 *
 * COST. Per frame this is trig on at most MAX_COLS x N_GNATS pooled sprites,
 * no probe and no allocation; the only probes are the ground search when a
 * column re-places (rare) and one player read a frame. A day frame returns
 * before all of it. `__mlAmbient.cost()` reports what it actually measures at.
 */

const KEY = "amb-gnat";
const KEY_NEAR = "amb-gnat-near";
const DEPTH_BASE = 900_000.07; // just over the darkness overlay, like the crawlers
const DEPTH_BIAS = 1e-6;
const GAIN_TAU = 1600;

const MAX_COLS = 2;
const COL_APART = 120; // px between two columns — a swarm is a landmark, not a texture
const N_GNATS: [number, number] = [14, 26];
const NEAR_FRAC = 0.18; // this many fly as 2px, which is what gives the column depth

const COL_H: [number, number] = [26, 52]; // height of the volume, screen px
const COL_RX: [number, number] = [5, 11]; // horizontal radius, GROUND px
const SQUASH = 0.55; // the ground plane is shallow on screen (the moths' number)
const LIFT: [number, number] = [8, 20]; // how far the column's foot floats above the ground

const SPIN: [number, number] = [0.5, 1.5]; // rad/s around the column's axis
const RISE: [number, number] = [0.6, 1.7]; // rad/s up and down it
const FLICK: [number, number] = [6, 13]; // rad/s — the fast twitch that makes it a midge
const FLICK_PX = 1.4;
const SWAY_PX = 3.5; // the whole column breathes sideways; nothing more
const SWAY_HZ = 0.00035;

const LIFE: [number, number] = [16_000, 44_000];
const FADE_MS = 900;
const ARRIVE_SPREAD: [number, number] = [0, 2200];
/* AND THEY LEAVE ONE AT A TIME TOO. Each gnat picks a moment in the column's
 * last seconds to go, and the earliest of those still leaves a full FADE_MS to
 * fade in — a swarm that blinks out together is the thing the maintainer
 * objected to on the ants ("I don't like the way you 'pop' the ants out of
 * existence"), and a column is far more visible than one ant. */
const LEAVE_SPREAD: [number, number] = [FADE_MS, 3400];
const ALPHA: [number, number] = [0.30, 0.62];

/* WALKING THROUGH IT SCATTERS IT. The one thing everybody knows about a gnat
 * column is what happens when you blunder into one. The swarm swells, thins and
 * re-forms behind you — it never dies, because it is still there when you turn
 * round. */
const SCATTER_R = 62; // px from the column's axis where it starts to break up
const SCATTER_TAU = 220; // ms to break
const REFORM_TAU = 1400; // ms to gather again — slower than the break, as it is
const SCATTER_SPREAD = 1.9; // how much wider it gets, at full scatter
const SCATTER_DIM = 0.55; // and how much of its opacity it loses

const GNAT_LIT = 0xffd2a0; // caught in the last warm light
const GNAT_DIM = 0xb9a892; // and what is left of one once the sun has gone

interface Gnat {
  sprite: Phaser.GameObjects.Image;
  col: number;
  slot: number; // its place in that column — a column shows its first `n`
  ang: number;
  spin: number;
  rise: number;
  flick: number;
  ph: number; // phase for the rise
  pf: number; // phase for the flick
  pr: number; // phase for the radius breathing
  wait: number; // ms until it joins (the arrival stagger)
  leaveAt: number; // column life remaining at which this one goes
  a: number; // own 0..1 opacity
  base: number; // its peak alpha
  near: boolean;
}

interface Column {
  x: number;
  y: number; // the ANCHOR: a point of dry ground
  h: number;
  rx: number;
  lift: number;
  sway: number; // phase
  life: number;
  n: number; // how many gnats this column holds — rolled ONCE, at placement
  scatter: number; // 0..1
}

/** DUSK, and what takes a swarm away. Phase-driven rather than sun-driven: the
 * sunset RAMP is only a few seconds of a two-minute cycle, so gating on it
 * would make this effect something nobody ever sees. Evening is the column;
 * morning gets a thinner one. An unknown phase (a probe that drifted) falls
 * back to the sun's own low band so the effect degrades instead of vanishing. */
function duskGain(env: AmbientEnv): number {
  if (env.rain > 0.05) return 0;
  if (env.weather >= 6) return 0; // storm, snow, wind — the air is moving
  const known = env.phase === "Evening" || env.phase === "Morning" || env.phase === "Day" || env.phase === "Night";
  const base = known
    ? env.phase === "Evening"
      ? 1
      : env.phase === "Morning"
        ? 0.5
        : 0
    : env.sun > 0.03 && env.sun < 0.75
      ? 0.8
      : 0;
  return base * (1 - 0.45 * env.cloud);
}

export function gnatsFeature(): AmbientFeature {
  const gnats: Gnat[] = [];
  const cols: Column[] = [];
  let t = 0;
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let placeFails = 0;
  let places = 0;
  let lastPhase = "";
  let seed = 24_593;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const range = ([a, b]: [number, number]) => a + rnd() * (b - a);

  /** The player's drawn position, so a column can be walked through. */
  const playerAt = (ctx: AmbientCtx): { x: number; y: number } | null => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const ms = ml?.myScreen?.() as { sx: number; sy: number; zoom: number } | null | undefined;
    if (!ms || !ms.zoom) return null;
    return { x: ctx.view.x + ms.sx / ms.zoom, y: ctx.view.y + ms.sy / ms.zoom };
  };

  const seat = (g: Gnat, col: number, instant: boolean) => {
    g.col = col;
    g.ang = rnd() * Math.PI * 2;
    g.spin = range(SPIN) * (rnd() < 0.5 ? 1 : -1);
    g.rise = range(RISE);
    g.flick = range(FLICK);
    g.ph = rnd() * Math.PI * 2;
    g.pf = rnd() * Math.PI * 2;
    g.pr = rnd() * Math.PI * 2;
    g.base = range(ALPHA);
    g.near = rnd() < NEAR_FRAC;
    g.wait = instant ? 0 : range(ARRIVE_SPREAD);
    g.leaveAt = range(LEAVE_SPREAD);
    g.a = instant ? 1 : 0;
    g.sprite.setTexture(g.near ? KEY_NEAR : KEY);
  };

  /** Stand a column over dry ground the player can see. The search is inset
   * from the view so the whole volume stays on screen — a column half off the
   * top edge is a row of specks, not a swarm. */
  const place = (ctx: AmbientCtx, c: Column): boolean => {
    const v = ctx.view;
    const h = range(COL_H);
    const lift = range(LIFT);
    const inset = {
      x: v.x + 24,
      y: v.y + h + lift + 16,
      width: Math.max(1, v.width - 48),
      height: Math.max(1, v.height - (h + lift + 16) - 24),
    };
    for (let tries = 0; tries < 6; tries++) {
      const spot = findGround(inset, rnd, 14, 6);
      if (!spot) break;
      if (cols.some((o) => o !== c && o.life > 0 && Math.hypot(o.x - spot.x, o.y - spot.y) < COL_APART)) continue;
      c.x = spot.x;
      c.y = spot.y;
      c.h = h;
      c.rx = range(COL_RX);
      c.lift = lift;
      c.sway = rnd() * Math.PI * 2;
      c.n = Math.round(range(N_GNATS));
      c.life = range(LIFE);
      places++;
      c.scatter = 0;
      return true;
    }
    return false;
  };

  return {
    name: "gnats",
    init(ctx) {
      // One pixel, and a two-pixel one for the ones flying nearest. Painted
      // WHITE: setTint multiplies, so the drawn colour is the per-frame tint.
      paintPixels(ctx.scene, KEY, 1, 1, 0xffffff, [[0, 0]]);
      paintPixels(ctx.scene, KEY_NEAR, 2, 1, 0xffffff, [[0, 0], [1, 0]]);
    },
    update(ctx, dt) {
      lastPhase = ctx.env.phase;
      const target = forced ? 1 : suppressed ? 0 : duskGain(ctx.env);
      gain += (target - gain) * Math.min(1, (dt / GAIN_TAU) * 3);
      const g = gain * ctx.outdoor;
      if (g <= 0.02) {
        // NOT DUSK: nothing is searched for, nothing is stepped, nothing drawn.
        for (const q of gnats) if (q.sprite.visible) q.sprite.setVisible(false);
        if (cols.length) cols.length = 0;
        return;
      }
      t += dt;

      // ---- the columns: place, expire, and follow the player ----
      const v = ctx.view;
      const want = Math.min(MAX_COLS, 1 + (v.width * v.height > 260_000 ? 1 : 0));
      while (cols.length < want)
        cols.push({ x: 0, y: 0, h: 36, rx: 8, lift: 12, sway: 0, life: 0, n: 0, scatter: 0 });
      if (cols.length > want) cols.length = want; // the view shrank
      const player = playerAt(ctx);
      for (const c of cols) {
        c.life -= dt;
        // OFF SCREEN is the whole test: the anchor is one point, so unlike the
        // ants' trail there is no fraction to weigh — either the player can see
        // this patch of ground or the swarm belongs somewhere else.
        const off = c.x < v.x - 40 || c.x > v.x + v.width + 40 || c.y < v.y - 40 || c.y > v.y + v.height + 40;
        if (c.life > 0 && !off) continue;
        const had = c.life > 0;
        if (!place(ctx, c)) {
          // No dry ground in view (open sea, a rooftop) — hold the column back
          // rather than standing it on the water.
          c.life = 0;
          placeFails++;
          continue;
        }
        // A column that MOVED with the player arrives whole (it is the same
        // swarm, seen from somewhere else); one that expired where you were
        // watching assembles gnat by gnat.
        const ci = cols.indexOf(c);
        for (const q of gnats) if (q.col === ci) seat(q, ci, had && off);
      }

      const live = cols.filter((c) => c.life > 0).length;
      if (!live) {
        for (const q of gnats) if (q.sprite.visible) q.sprite.setVisible(false);
        return;
      }

      /* ---- the swarm ----
       * The pool is FIXED and SLOTTED: gnat i belongs to column i % cols and
       * sits at slot i / cols, and a column draws its first `n` slots. The
       * first cut rolled the population every frame, which is a random number
       * per frame deciding how many sprites exist — the pool only ever grew,
       * and the count it reported was noise. */
      const per = Math.ceil(N_GNATS[1]);
      while (gnats.length < MAX_COLS * per) {
        const i = gnats.length;
        const ci = i % MAX_COLS;
        const q: Gnat = {
          sprite: ctx.scene.add.image(0, 0, KEY).setOrigin(0, 0).setScale(1).setVisible(false),
          col: ci, slot: (i / MAX_COLS) | 0,
          ang: 0, spin: 1, rise: 1, flick: 8, ph: 0, pf: 0, pr: 0, wait: 0, leaveAt: 0, a: 0, base: 0.5, near: false,
        };
        seat(q, ci, false);
        gnats.push(q);
      }

      // Scatter: how close is the player to each column's axis?
      for (const c of cols) {
        if (c.life <= 0) continue;
        const near =
          player !== null &&
          Math.hypot(player.x - c.x, (player.y - c.y) / SQUASH) < SCATTER_R;
        const tau = near ? SCATTER_TAU : REFORM_TAU;
        c.scatter += ((near ? 1 : 0) - c.scatter) * Math.min(1, dt / tau);
      }

      // Colour: what the last light leaves on a midge. Warm while the sun is
      // still on them, a dim grey once it has gone.
      const sun = Math.min(1, Math.max(0, ctx.env.sun));
      const mix = (a: number, b: number, k: number) => {
        const m = (sh: number) =>
          Math.round(((a >> sh) & 255) + (((b >> sh) & 255) - ((a >> sh) & 255)) * k) & 255;
        return (m(16) << 16) | (m(8) << 8) | m(0);
      };
      const tint = mix(GNAT_DIM, GNAT_LIT, Math.min(1, sun * 2.2));

      const secs = dt / 1000;
      for (const q of gnats) {
        const c = q.col < cols.length ? cols[q.col] : undefined;
        if (!c || c.life <= 0 || q.slot >= c.n) { q.sprite.setVisible(false); continue; }
        if (q.wait > 0) { q.wait -= dt; q.sprite.setVisible(false); continue; }

        q.ang += q.spin * secs;
        const spread = 1 + SCATTER_SPREAD * c.scatter;
        // Radius breathes, so the column is a living volume and not a cylinder.
        const r = c.rx * spread * (0.35 + 0.65 * Math.abs(Math.sin(t * 0.001 * q.rise + q.pr)));
        // Height: a smooth rise and fall inside the column, plus the twitch.
        const u = 0.5 + 0.5 * Math.sin(t * 0.001 * q.rise + q.ph);
        const flick = Math.sin(t * 0.001 * q.flick + q.pf) * FLICK_PX;
        const sway = Math.sin(t * SWAY_HZ + c.sway) * SWAY_PX;

        const x = c.x + Math.cos(q.ang) * r + sway + flick;
        const y =
          c.y -
          c.lift -
          u * c.h * (1 + 0.5 * c.scatter) +
          Math.sin(q.ang) * r * SQUASH +
          Math.cos(t * 0.001 * q.flick + q.pf) * FLICK_PX * 0.6;

        // Its own moment to leave, inside the column's last seconds.
        const wantA = c.life <= q.leaveAt ? 0 : 1;
        q.a = wantA > q.a ? Math.min(1, q.a + dt / FADE_MS) : Math.max(0, q.a - dt / FADE_MS);

        const iy = Math.round(y);
        q.sprite
          .setPosition(Math.round(x), iy)
          .setDepth(DEPTH_BASE + iy * DEPTH_BIAS)
          .setTint(tint)
          .setAlpha(g * q.a * q.base * (1 - SCATTER_DIM * c.scatter))
          .setVisible(q.a > 0.01);
      }
    },
    setSuppressed(on) { suppressed = on; },
    setForced(on) { forced = on; },
    debug() {
      const shown = gnats.filter((q) => q.sprite.visible);
      return {
        gain: +gain.toFixed(3),
        phase: lastPhase,
        columns: cols.filter((c) => c.life > 0).length,
        placeFails,
        places,
        gnats: shown.length,
        cols: cols
          .filter((c) => c.life > 0)
          .map((c) => ({
            x: Math.round(c.x), y: Math.round(c.y),
            h: Math.round(c.h), rx: +c.rx.toFixed(1), lift: Math.round(c.lift),
            life: Math.round(c.life), n: c.n,
            scatter: +c.scatter.toFixed(3),
          })),
        all: shown.map((q) => {
          const c = q.col < cols.length ? cols[q.col] : undefined;
          return {
            x: Math.round(q.sprite.x), y: Math.round(q.sprite.y),
            col: q.col,
            cx: Math.round(c?.x ?? 0), cy: Math.round(c?.y ?? 0),
            h: Math.round(c?.h ?? 0), rx: +(c?.rx ?? 0).toFixed(1), lift: Math.round(c?.lift ?? 0),
            a: +q.sprite.alpha.toFixed(3),
          };
        }),
      };
    },
    dispose() {
      for (const q of gnats) q.sprite.destroy();
      gnats.length = 0;
      cols.length = 0;
    },
  };
}
