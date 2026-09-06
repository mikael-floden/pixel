import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { findGround, landableAt, paintPixels } from "../runtime/ground";

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

const DEPTH_BIAS = -0.5; // just under a body standing on the same ground line
const GAIN_TAU = 1600;
const MAX_SPIDERS = 2; // solitary by design — a crowd of these reads as vermin
const SPAWN_EVERY: [number, number] = [7_000, 22_000];
const LIFE: [number, number] = [14_000, 34_000];
const DASH_MS: [number, number] = [140, 420];
const REST_MS: [number, number] = [420, 2600];
const DASH_SPEED: [number, number] = [46, 104]; // drawn px/s — quick, that is the tell
const TURN = 1.5; // radians of heading change allowed between dashes
const PLAYER_CLEAR = 46; // never skitter closer than this to the player
const MARGIN = 8;

const KEY = "amb-spider";
const SPIDER_DARK = 0x14100f;

interface Spider {
  sprite: Phaser.GameObjects.Image;
  x: number;
  y: number;
  ang: number;
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
      paintPixels(ctx.scene, KEY, 3, 3, SPIDER_DARK, [
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

      nextIn -= dt;
      if (nextIn <= 0 && spiders.length < MAX_SPIDERS) {
        nextIn = range(SPAWN_EVERY);
        const p = findGround(ctx.view, rnd, MARGIN);
        const me = playerAt(ctx);
        if (p && (!me || Math.hypot(p.x - me.x, p.y - me.y) > PLAYER_CLEAR * 2)) {
          const s: Spider = {
            sprite: ctx.scene.add.image(p.x, p.y, KEY).setScale(1).setVisible(false),
            x: p.x,
            y: p.y,
            ang: rnd() * Math.PI * 2,
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
      for (let i = spiders.length - 1; i >= 0; i--) {
        const s = spiders[i];
        s.life -= dt;
        s.timer -= dt;
        if (s.timer <= 0) (s.dashing ? rest : dash)(s);

        if (s.dashing) {
          const nx = s.x + Math.cos(s.ang) * s.spd * secs;
          const ny = s.y + Math.sin(s.ang) * s.spd * secs * 0.6; // the iso plane is shallow
          // Turn at anything it cannot walk on, and shy away from the player.
          const blocked = !landableAt(Math.round(nx), Math.round(ny));
          const tooNear = me && Math.hypot(nx - me.x, ny - me.y) < PLAYER_CLEAR;
          if (blocked || tooNear) {
            s.ang += Math.PI * (0.5 + rnd() * 0.5); // veer, do not reverse exactly
            rest(s);
          } else {
            s.x = nx;
            s.y = ny;
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
          .setDepth(y + DEPTH_BIAS)
          .setAlpha(g * fade)
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
