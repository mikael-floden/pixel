import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { crawlerTint, findGround, flatWith, landableAt, levelAt, paintPixels } from "../runtime/ground";

// SPIDERS — a FIELD effect, and the other half of the too-small-for-art pair
// (see ants/ants.ts for why there is no sprite sheet here).
//
// Where an ant is read from the COLUMN it walks in, a spider is read from the
// SKITTER: a hard dart of a few dozen pixels, then a dead stop, then another
// dart somewhere slightly different. Nothing else in this world moves like
// that, so the motion alone identifies it — which is lucky, because at this
// size the animal is three pixels and a suggestion of legs.
//
// They are solitary (one or two on screen, never a flock), they favour dusk and
// night, and they keep away from open ground the player is standing on: a
// spider that skitters over your feet is a jump-scare, and this layer is
// atmosphere.

/* ABOVE THE DARKNESS OVERLAY, AND THAT IS DELIBERATE.
 *
 * The house rule is that ground-lit matter graded by time of day belongs UNDER
 * 900_000, and these obeyed it — which is why a night spider measured SIXTEEN
 * luma of contrast against its own ground even after its tint was paled: the
 * overlay MULTIPLIES, so it takes a pale 1-3 px speck down exactly as far as it
 * takes the ground under it, and the two stay indistinguishable by
 * construction. There is no tint that survives that.
 *
 * At this size the two goals cannot both hold: an animal that is one to three
 * pixels is either graded with the world or visible in it. The game already
 * makes this call for the hidden-behind outline, which draws above the overlay
 * for exactly the same reason — legibility beats grading when the mark IS the
 * information. So the crawlers draw a hair above it, keeping their own y-order,
 * and take a gentler alpha after dark so they read as a silhouette on the
 * ground rather than as a light on it. `ctx.outdoor` still stops them indoors.
 */
const DEPTH_BASE = 900_000.05; // just over the darkness overlay
const DEPTH_BIAS = 1e-6; // keeps their own near-far order among themselves
const NIGHT_ALPHA = 0.8; // a silhouette after dark, never a lamp
const GAIN_TAU = 1600;
const MAX_SPIDERS = 2; // solitary by design — a crowd of these reads as vermin
const SPAWN_EVERY: [number, number] = [7_000, 22_000];
const FIRST_MS = 900; // an EMPTY world waits this long, not the full gap
const LIFE: [number, number] = [14_000, 34_000];
const DASH_MS: [number, number] = [140, 420];
const REST_MS: [number, number] = [420, 2600];
const DASH_SPEED: [number, number] = [46, 104]; // drawn px/s — quick, that is the tell
const TURN = 1.5; // radians of heading change allowed between dashes
const PLAYER_CLEAR = 46; // never skitter closer than this to the player
const MARGIN = 8;
const SPAWN_INSET = 0.2; // spawn inside the view, not on its rim
const OFF_VIEW = 40; // this far outside the view and it has gone for good
const EDGE_TURN = 6; // it turns this far INSIDE the rim, before it is off it

const KEY = "amb-spider";
const SPIDER_DARK = 0x14100f;

interface Spider {
  sprite: Phaser.GameObjects.Image;
  x: number;
  y: number;
  ang: number;
  lvl: number | null; // the terrace it is skittering on
  spd: number;
  dashing: boolean;
  timer: number; // ms left in the current dash/rest
  life: number;
}

export function spidersFeature(): AmbientFeature {
  const spiders: Spider[] = [];
  let nextIn = 3000;
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let seed = 137;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const range = ([a, b]: [number, number]) => a + rnd() * (b - a);

  /** The player's drawn position, so a spider can keep its distance. */
  const playerAt = (ctx: AmbientCtx): { x: number; y: number } | null => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const ms = ml?.myScreen?.() as { sx: number; sy: number; zoom: number } | null | undefined;
    if (!ms || !ms.zoom) return null;
    return { x: ctx.view.x + ms.sx / ms.zoom, y: ctx.view.y + ms.sy / ms.zoom };
  };

  const rest = (s: Spider) => {
    s.dashing = false;
    s.timer = range(REST_MS);
  };
  const dash = (s: Spider) => {
    s.dashing = true;
    s.timer = range(DASH_MS);
    s.ang += (rnd() - 0.5) * 2 * TURN;
    s.spd = range(DASH_SPEED);
  };

  return {
    name: "spiders",
    init(ctx) {
      // Three pixels of body with four hinted legs — the most that reads at
      // this size. Anything more detailed is invisible; anything less is a dot.
      // WHITE art: the drawn colour is the per-frame tint (crawlerTint).
      paintPixels(ctx.scene, KEY, 3, 3, 0xffffff, [
        [1, 0],
        [0, 1], [1, 1], [2, 1],
        [0, 2], [2, 2],
      ]);
    },
    update(ctx, dt) {
      // Dusk and night creatures, but not exclusively — a quarter of them are
      // out by day, so a daytime walk is not guaranteed spider-free.
      const target = forced ? 1 : suppressed ? 0 : 0.25 + 0.75 * ctx.env.night;
      gain += (target - gain) * Math.min(1, (dt / GAIN_TAU) * 3);
      const g = gain * ctx.outdoor; // stops indoors, like every effect here
      const visible = g > 0.02;

      if (!visible) {
        for (const s of spiders) if (s.sprite.visible) s.sprite.setVisible(false);
        return;
      }

      /* A SPOT IN THE VIEW WE ARE LOOKING AT NOW — used both to spawn and to
       * MOVE an existing spider (see the relocation rule below). */
      const spotInView = (): { x: number; y: number } | null => {
        const v = ctx.view;
        const inner = {
          x: v.x + v.width * SPAWN_INSET,
          y: v.y + v.height * SPAWN_INSET,
          width: v.width * (1 - 2 * SPAWN_INSET),
          height: v.height * (1 - 2 * SPAWN_INSET),
        };
        const p = findGround(inner, rnd, MARGIN);
        const who = playerAt(ctx);
        if (!p) return null;
        if (who && Math.hypot(p.x - who.x, p.y - who.y) <= PLAYER_CLEAR * 2) return null;
        return p;
      };

      /* THE FIRST ONE COMES QUICKLY. The spawn gap is what keeps a spider a
       * rare thing to notice rather than a stream of them — but applied to an
       * EMPTY world it is just a wait, and after running somewhere new the
       * world is always empty (maintainer 2026-09-07: "I see no spiders and
       * ants if I run away to a different location"). So the gap governs the
       * SECOND spider onward; the first one only ever waits FIRST_MS. */
      if (!spiders.length) nextIn = Math.min(nextIn, FIRST_MS);

      nextIn -= dt;
      if (nextIn <= 0 && spiders.length < MAX_SPIDERS) {
        nextIn = range(SPAWN_EVERY);
        const p = spotInView();
        if (p) {
          const s: Spider = {
            sprite: ctx.scene.add.image(p.x, p.y, KEY).setOrigin(0, 0).setScale(1).setVisible(false),
            x: p.x,
            y: p.y,
            ang: rnd() * Math.PI * 2,
            lvl: levelAt(p.x, p.y),
            spd: 0,
            dashing: false,
            timer: 0,
            life: range(LIFE),
          };
          rest(s);
          spiders.push(s);
        }
      }

      const me = playerAt(ctx);
      const secs = dt / 1000;
      const vw = ctx.view;
      for (let i = spiders.length - 1; i >= 0; i--) {
        const s = spiders[i];
        s.life -= dt;
        s.timer -= dt;
        if (s.timer <= 0) (s.dashing ? rest : dash)(s);

        if (s.dashing) {
          const nx = s.x + Math.cos(s.ang) * s.spd * secs;
          const ny = s.y + Math.sin(s.ang) * s.spd * secs * 0.6; // the iso plane is shallow
          // Turn at anything it cannot walk on, shy away from the player — and
          // treat the EDGE OF THE VIEW as a wall it cannot cross. There are at
          // most two spiders in the world, so one that skitters off the side of
          // the screen is the whole effect gone: measured before this, a spider
          // spent 17 of 191 frames entirely out of frame. Retiring it (below)
          // is the backstop for a camera that walks away; this is what keeps
          // the one the player has in view.
          // Not merely walkable: the SAME TERRACE. A cliff foot is walkable
          // and is drawn a few pixels below the plateau it stands under, so a
          // walkability test alone lets a skitter run down the cliff face.
          const blocked = !flatWith(s.lvl, Math.round(nx), Math.round(ny));
          const tooNear = me && Math.hypot(nx - me.x, ny - me.y) < PLAYER_CLEAR;
          const leaving =
            nx < vw.x + EDGE_TURN || nx > vw.x + vw.width - EDGE_TURN ||
            ny < vw.y + EDGE_TURN || ny > vw.y + vw.height - EDGE_TURN;
          if (blocked || tooNear || leaving) {
            s.ang += Math.PI * (0.5 + rnd() * 0.5); // veer, do not reverse exactly
            rest(s);
          } else {
            s.x = nx;
            s.y = ny;
          }
        }

        /* A SPIDER THAT LEAVES THE VIEW IS MOVED, NOT KILLED (maintainer
         * 2026-09-07: "you can move the simulated ants and spiders to a new
         * location when/if the user runs to a new location"). It used to be
         * retired 300 ms after going out of frame, which is right for one that
         * skittered off the edge and wrong for the case that actually happens:
         * the PLAYER left, taking the view with them and stranding the whole
         * population behind — after which the spawn gap (7-22 s) is a wait with
         * nothing on screen. There is no simulation to preserve out there (a
         * spider is a position, a heading and a timer), so the same spider is
         * re-placed on ground in the view we are looking at now, keeping its
         * life and its dash/rest phase. If there is nowhere to put it — no dry
         * ground, or only the player's lap — it keeps skittering where it is
         * and the next frame tries again; a spider that has run out of world
         * still retires on its own life. */
        const v2 = ctx.view;
        const outside =
          s.x < v2.x - OFF_VIEW || s.x > v2.x + v2.width + OFF_VIEW ||
          s.y < v2.y - OFF_VIEW || s.y > v2.y + v2.height + OFF_VIEW;
        if (outside) {
          const p = spotInView();
          if (p) {
            s.x = p.x;
            s.y = p.y;
            s.ang = rnd() * Math.PI * 2;
            s.lvl = levelAt(p.x, p.y);
          }
        }
        // Leave quietly: the last stretch of life fades rather than blinking out.
        const fade = s.life < 1200 ? Math.max(0, s.life / 1200) : 1;
        if (s.life <= 0) {
          s.sprite.destroy();
          spiders.splice(i, 1);
          continue;
        }
        const x = Math.round(s.x);
        const y = Math.round(s.y);
        s.sprite
          .setPosition(x, y)
          .setDepth(DEPTH_BASE + y * DEPTH_BIAS)
          .setTint(crawlerTint(SPIDER_DARK, ctx.env))
          .setAlpha(g * fade * (1 - (1 - NIGHT_ALPHA) * ctx.env.night))
          .setVisible(true);
      }
    },
    setSuppressed(on) { suppressed = on; },
    setForced(on) { forced = on; },
    debug() {
      return {
        gain: +gain.toFixed(3),
        spiders: spiders.length,
        nextInMs: Math.max(0, Math.round(nextIn)),
        all: spiders.map((s) => ({
          x: Math.round(s.x), y: Math.round(s.y),
          dashing: s.dashing, spd: +s.spd.toFixed(1),
          lifeMs: Math.round(s.life), a: +s.sprite.alpha.toFixed(3),
        })),
      };
    },
    dispose() {
      for (const s of spiders) s.sprite.destroy();
      spiders.length = 0;
    },
  };
}
