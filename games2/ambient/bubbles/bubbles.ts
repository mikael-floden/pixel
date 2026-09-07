import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { drawnFlow, DrawnFlow } from "../deepwater/current";

/* BUBBLES — a string of them rising out of the deep and bursting at the top.
 *
 * SEEN FROM ABOVE, which is the whole design problem. We look down on the sea
 * at a shallow angle, so a bubble's rise is barely any travel: what actually
 * reads is that it GROWS, SHARPENS and finally BURSTS. So a bubble here is a
 * small ring that starts as one faint pixel deep down, swells to a four-pixel
 * ring as it nears the surface, and pops into an expanding ring that fades. The
 * pop is what sells it — a dot that merely fades is a dead pixel.
 *
 * THEY COME IN STRINGS, from a VENT. Random dots scattered over the sea read as
 * noise; three or four bubbles climbing out of ONE spot read as something down
 * there. A vent opens, breathes for a while, closes, and another opens
 * somewhere else.
 *
 * THEY DRIFT ON THE REAL CURRENT. The vent samples `deepCurrentAtScreen` — the
 * same function the server integrates and the swimmer is pushed by — so a
 * bubble string leans downstream exactly as the water is moving. Same seam the
 * seaward-current feature reads, same idea: draw the real force, not a
 * decoration of one.
 *
 * NOTHING POPS INTO OR OUT OF EXISTENCE (maintainer, standing rule): a bubble
 * fades UP out of the dark over the first third of its climb, and leaves only
 * through the burst, which expands as it fades. A vent that closes stops
 * EMITTING; the bubbles already climbing finish their climb.
 *
 * CONTRAST IS MEASURED, NOT ASSUMED. The day sea draws LIGHT on screen
 * (#cbd8d8 measured for the deep-water crests, far lighter than the material
 * colour suggests), so a white bubble on it is invisible; the ring is a dark
 * teal by day and turns pale after dark, when the sea is the dark thing. The
 * highlight pixel rides the two biggest stages only, where there is room for it.
 */

const RING = ["amb-bub-1", "amb-bub-2", "amb-bub-3", "amb-bub-4"] as const;
const POP = ["amb-bub-pop1", "amb-bub-pop2"] as const;
const HI = "amb-bub-hi";
const DEPTH = 900_000.33; // over the darkness overlay, just under the sea's own crests
const DEPTH_HI = 900_000.335;
const GAIN_TAU = 1400;

const MAX_VENTS = 3;
const MAX_BUBBLES = 16;
const PLACE_MS = 1200; // rate limit on hunting for a vent site — the only costly call
const TRIES = 8; // candidate points per hunt
const CURRENT_MS = 1100; // how often a vent re-reads the current it drifts on

const VENT_LIFE: [number, number] = [5000, 17_000]; // then it closes and the last bubbles finish
const VENT_GAP: [number, number] = [400, 2600];
const EMIT_MS: [number, number] = [170, 820]; // between bubbles of one string
const STRING: [number, number] = [2, 6]; // bubbles a vent lets go before it rests
const REST_MS: [number, number] = [900, 3600];

const RISE_MS: [number, number] = [1100, 2400];
const RISE_PX: [number, number] = [7, 17]; // how far up-screen the climb carries it
const WOBBLE_PX = 1.7; // a bubble does not rise straight
const WOBBLE_HZ: [number, number] = [1.4, 3.2];
const POP_MS = 280;
const FADE_IN = 0.34; // fraction of the climb spent coming up out of the dark
const ALPHA: [number, number] = [0.55, 0.9];

const RING_DAY = 0x4d7f8c; // dark teal — the day sea is LIGHT on screen
const RING_NIGHT = 0xbfe6f0; // pale — after dark the sea is the dark thing
const HI_TINT = 0xf2fbff;

interface Bubble {
  id: number;
  sprite: Phaser.GameObjects.Image;
  hi: Phaser.GameObjects.Image;
  vent: number;
  t: number; // 0 deep → 1 surface
  rise: number; // ms the climb takes
  age: number;
  up: number; // px of up-screen travel over the climb
  ph: number; // wobble phase
  hz: number;
  base: number; // peak alpha
  popping: number; // ms left of the burst, 0 while climbing
  live: boolean;
}

interface Vent {
  x: number;
  y: number;
  flow: DrawnFlow | null;
  since: number; // ms since the current was read
  life: number; // ms until it closes
  gap: number; // ms until the next bubble
  left: number; // bubbles left in this string
  rest: number; // ms until the next string
  open: boolean;
}

export function bubblesFeature(): AmbientFeature {
  const bubbles: Bubble[] = [];
  const vents: Vent[] = [];
  let sinceTry = 0;
  let probes = 0;
  let hunts = 0;
  let pops = 0;
  let nextId = 1;
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let seed = 8221;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const range = ([a, b]: [number, number]) => a + rnd() * (b - a);

  /** The deep-sea current at a drawn point, already projected. Fenced like
   * every probe read: no probe (or no open sea) means no vents at all. */
  const flowAt = (x: number, y: number): DrawnFlow | null => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const f = ml?.deepCurrentAtScreen as
      | undefined
      | ((x: number, y: number) => { dx: number; dy: number; speed: number } | null);
    if (!f) return null;
    probes++;
    try { return drawnFlow(f(x, y)); } catch { return null; }
  };

  const paint = (scene: Phaser.Scene, key: string, w: number, h: number, px: ReadonlyArray<readonly [number, number]>) => {
    if (scene.textures.exists(key)) return;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1); // WHITE: setTint multiplies, so the tint is the colour
    for (const [x, y] of px) g.fillRect(x, y, 1, 1);
    g.generateTexture(key, w, h);
    g.destroy();
  };

  /** Which ring art a bubble wears at this point of its climb. */
  const stageOf = (t: number): number => (t < 0.3 ? 0 : t < 0.58 ? 1 : t < 0.84 ? 2 : 3);

  const openVent = (ctx: AmbientCtx, v: Vent): boolean => {
    hunts++;
    const view = ctx.view;
    for (let i = 0; i < TRIES; i++) {
      const x = Math.round(view.x + rnd() * view.width);
      const y = Math.round(view.y + rnd() * view.height);
      const flow = flowAt(x, y);
      if (!flow) continue; // not open sea
      if (vents.some((o) => o !== v && o.open && Math.hypot(o.x - x, o.y - y) < 70)) continue;
      v.x = x; v.y = y; v.flow = flow; v.since = 0;
      v.life = range(VENT_LIFE);
      v.gap = range(VENT_GAP);
      v.left = Math.round(range(STRING));
      v.rest = 0;
      v.open = true;
      return true;
    }
    return false;
  };

  const release = (ctx: AmbientCtx, v: Vent, vi: number) => {
    let b = bubbles.find((q) => !q.live);
    if (!b && bubbles.length < MAX_BUBBLES) {
      b = {
        id: 0,
        sprite: ctx.scene.add.image(0, 0, RING[0]).setOrigin(0.5, 0.5).setScale(1).setVisible(false),
        hi: ctx.scene.add.image(0, 0, HI).setOrigin(0.5, 0.5).setScale(1).setVisible(false),
        vent: vi, t: 0, rise: 0, age: 0, up: 0, ph: 0, hz: 2, base: 1, popping: 0, live: false,
      };
      bubbles.push(b);
    }
    if (!b) return; // at the ceiling — the sea is busy enough
    b.id = nextId++;
    b.vent = vi;
    b.t = 0;
    b.age = 0;
    b.rise = range(RISE_MS);
    b.up = range(RISE_PX);
    b.ph = rnd() * Math.PI * 2;
    b.hz = range(WOBBLE_HZ);
    b.base = range(ALPHA);
    b.popping = 0;
    b.live = true;
    b.sprite.setTexture(RING[0]).setAlpha(0).setVisible(true);
  };

  return {
    name: "bubbles",
    init(ctx) {
      // Four climbing stages: a pixel, a blob, then two hollow rings — a bubble
      // is a RING, and the hole is what stops four pixels reading as a speck.
      paint(ctx.scene, RING[0], 1, 1, [[0, 0]]);
      paint(ctx.scene, RING[1], 2, 2, [[0, 0], [1, 0], [0, 1], [1, 1]]);
      paint(ctx.scene, RING[2], 3, 3, [[1, 0], [0, 1], [2, 1], [1, 2]]);
      paint(ctx.scene, RING[3], 4, 4, [[1, 0], [2, 0], [0, 1], [3, 1], [0, 2], [3, 2], [1, 3], [2, 3]]);
      // And the burst: a ring that expands and thins as it goes.
      paint(ctx.scene, POP[0], 5, 5, [[2, 0], [1, 1], [3, 1], [0, 2], [4, 2], [1, 3], [3, 3], [2, 4]]);
      paint(ctx.scene, POP[1], 7, 7, [[3, 0], [1, 1], [5, 1], [0, 3], [6, 3], [1, 5], [5, 5], [3, 6]]);
      paint(ctx.scene, HI, 1, 1, [[0, 0]]);
    },
    update(ctx, dt) {
      const target = forced ? 1 : suppressed ? 0 : 1; // self-gating is the SEA, not the sky
      gain += (target - gain) * Math.min(1, (dt / GAIN_TAU) * 3);
      const g = gain * ctx.outdoor;
      if (g <= 0.02) {
        for (const b of bubbles) if (b.sprite.visible) { b.sprite.setVisible(false); b.hi.setVisible(false); b.live = false; }
        vents.length = 0;
        return;
      }

      const v0 = ctx.view;
      // ---- vents: open, breathe, close, and move with the view ----
      while (vents.length < MAX_VENTS)
        vents.push({ x: 0, y: 0, flow: null, since: 0, life: 0, gap: 0, left: 0, rest: 0, open: false });
      sinceTry += dt;
      for (let vi = 0; vi < vents.length; vi++) {
        const v = vents[vi];
        if (v.open) {
          v.life -= dt;
          v.since += dt;
          const off =
            v.x < v0.x - 40 || v.x > v0.x + v0.width + 40 || v.y < v0.y - 40 || v.y > v0.y + v0.height + 40;
          // A vent re-reads its current on a slow clock — never per bubble, and
          // never per frame. If the sea has stopped being sea under it (drifted
          // to a shore, the view moved), it closes.
          if (v.since >= CURRENT_MS) {
            v.since = 0;
            v.flow = flowAt(v.x, v.y);
          }
          if (v.life <= 0 || off || !v.flow) {
            // CLOSING IS NOT KILLING: it stops emitting; whatever is already
            // climbing finishes its climb and its burst.
            v.open = false;
            continue;
          }
          if (v.rest > 0) {
            v.rest -= dt;
            if (v.rest <= 0) v.left = Math.round(range(STRING));
          } else {
            v.gap -= dt;
            if (v.gap <= 0) {
              v.gap = range(EMIT_MS);
              if (v.left > 0) { v.left--; release(ctx, v, vi); }
              if (v.left <= 0) v.rest = range(REST_MS);
            }
          }
        } else if (sinceTry >= PLACE_MS) {
          // RATE-LIMITED HUNT. Over land, or on a map with no open sea at all,
          // this is the entire per-second cost of the feature.
          sinceTry = 0;
          openVent(ctx, v);
        }
      }

      // ---- the bubbles ----
      const sun = Math.min(1, Math.max(0, ctx.env.sun));
      const mix = (a: number, b: number, k: number) => {
        const m = (sh: number) =>
          Math.round(((a >> sh) & 255) + (((b >> sh) & 255) - ((a >> sh) & 255)) * k) & 255;
        return (m(16) << 16) | (m(8) << 8) | m(0);
      };
      const ring = mix(RING_NIGHT, RING_DAY, sun);

      for (const b of bubbles) {
        if (!b.live) continue;
        const v = vents[b.vent];
        b.age += dt;

        if (b.popping > 0) {
          // THE BURST: two frames, expanding and fading to nothing.
          b.popping -= dt;
          if (b.popping <= 0) {
            b.live = false;
            b.sprite.setVisible(false);
            b.hi.setVisible(false);
            continue;
          }
          const k = 1 - b.popping / POP_MS; // 0 → 1
          b.sprite.setTexture(POP[k < 0.5 ? 0 : 1]).setAlpha(g * b.base * (1 - k) * 0.9);
          b.hi.setVisible(false);
          continue;
        }

        b.t = Math.min(1, b.age / b.rise);
        if (b.t >= 1) {
          b.popping = POP_MS;
          pops++;
          continue;
        }

        // Drift on the vent's own current, wobble across it, and climb.
        const drift = v && v.flow ? v.flow.speed * (b.age / 1000) : 0;
        const dx = v && v.flow ? v.flow.ux * drift : 0;
        const dy = v && v.flow ? v.flow.uy * drift : 0;
        const wob = Math.sin(b.ph + (b.age / 1000) * b.hz * Math.PI * 2) * WOBBLE_PX;
        const x = (v ? v.x : 0) + dx + wob;
        const y = (v ? v.y : 0) + dy - b.up * b.t;

        // FADE UP OUT OF THE DARK — never an appearing dot.
        const a = g * b.base * Math.min(1, b.t / FADE_IN);
        const st = stageOf(b.t);
        const iy = Math.round(y);
        b.sprite
          .setTexture(RING[st])
          .setPosition(Math.round(x), iy)
          .setDepth(DEPTH + iy * 1e-6)
          .setTint(ring)
          .setAlpha(a)
          .setVisible(a > 0.01);
        // A highlight only where there is room for one: the two biggest rings.
        if (st >= 2) {
          b.hi
            .setPosition(Math.round(x) - 1, iy - 1)
            .setDepth(DEPTH_HI + iy * 1e-6)
            .setTint(HI_TINT)
            .setAlpha(a * 0.55)
            .setVisible(true);
        } else b.hi.setVisible(false);
      }
    },
    setSuppressed(on) { suppressed = on; },
    setForced(on) { forced = on; },
    debug() {
      const live = bubbles.filter((b) => b.live && b.sprite.visible);
      return {
        gain: +gain.toFixed(3),
        probes, // QA: the vent hunt is the costly call and must stay rate-limited
        hunts,
        pops,
        vents: vents.filter((v) => v.open).length,
        bubbles: live.length,
        ventList: vents.filter((v) => v.open).map((v) => ({
          x: Math.round(v.x), y: Math.round(v.y),
          flow: v.flow ? [+v.flow.ux.toFixed(3), +v.flow.uy.toFixed(3)] : null,
          speed: v.flow ? Math.round(v.flow.speed) : 0,
        })),
        all: live.map((b) => ({
          id: b.id,
          x: Math.round(b.sprite.x), y: Math.round(b.sprite.y),
          t: +b.t.toFixed(3), stage: stageOf(b.t), popping: b.popping > 0,
          a: +b.sprite.alpha.toFixed(3),
        })),
      };
    },
    dispose() {
      for (const b of bubbles) { b.sprite.destroy(); b.hi.destroy(); }
      bubbles.length = 0;
      vents.length = 0;
    },
  };
}
