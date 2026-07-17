import Phaser from "phaser";
import { AmbientCtx, AmbientFeature, PHASE_DAY, WEATHER_CLEAR } from "../runtime/types";
import { isRainy } from "../runtime/env";

// Sandstorm — the first TERRAIN-AWARE episode (maintainer: "unusual
// effect... need the player to be at sand"). The director can only roll it
// while the ground around the player is sandy (env.sand, sampled off the
// game's surfaceAt probe), and the storm's strength keeps following the
// terrain: wander off the sand and it thins to drifting dust, wander back
// in and it whips up again.
//
// Two layers, both ABOVE the lit copies and the mist pass (a storm swallows
// whoever stands in it, like the games agent's fog):
// - a warm dust HAZE veil breathing with the gusts;
// - fast wind-driven sand STREAKS riding the same wind heading as the
//   weather layer's clouds, with slow gust surges and per-grain jitter.
// Visual only — no movement, camera or gameplay coupling, per charter.
const HAZE_DEPTH = 1_000_000.5; // above the mist RT (1_000_000), below sky events
const STREAK_DEPTH = 1_000_000.6;
const STREAK_TEX = "amb-sandgrain";
const STREAK_COUNT = 64;
const BASE_WEIGHT = 0.6;
const GAIN_TAU = 2600; // ms — a storm rolls in, never pops
const HAZE_COLOR = 0xd8b070; // warm dust
// Same wind heading as the cloud layer (~42,23), much faster.
const WIND_X = 42;
const WIND_Y = 23;
const WIND_LEN = Math.hypot(WIND_X, WIND_Y);
const WX = WIND_X / WIND_LEN;
const WY = WIND_Y / WIND_LEN;

interface Grain {
  sprite: Phaser.GameObjects.Image;
  x: number;
  y: number;
  v: number; // base speed px/s (scaled by the gust)
  jf: number; // jitter freq
  j0: number; // jitter phase
  t: number;
  a: number; // per-grain alpha factor
}

export function sandstormFeature(): AmbientFeature {
  let haze: Phaser.GameObjects.Rectangle | null = null;
  const grains: Grain[] = [];
  let active = false;
  let gain = 0;
  let sandEased = 0; // eased env.sand — the storm follows the terrain
  let gustT = 0;
  let lastNow = 0;
  let seed = 53;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  const ensureTexture = (scene: Phaser.Scene) => {
    if (scene.textures.exists(STREAK_TEX)) return;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xf0d8a0, 0.55).fillRect(0, 0, 5, 1);
    g.fillStyle(0xf8e8c0, 1).fillRect(1, 0, 2, 1);
    g.generateTexture(STREAK_TEX, 5, 1);
    g.destroy();
  };

  const spawnGrain = (gr: Grain, view: Phaser.Geom.Rectangle, anywhere: boolean) => {
    if (anywhere) {
      gr.x = view.x + rnd() * view.width;
      gr.y = view.y + rnd() * view.height;
    } else {
      // Enter from the upwind edge (left/top for a right-down wind).
      if (rnd() < 0.7) {
        gr.x = view.x - 12;
        gr.y = view.y + rnd() * view.height;
      } else {
        gr.x = view.x + rnd() * view.width;
        gr.y = view.y - 8;
      }
    }
    gr.v = 260 + rnd() * 200;
    gr.jf = 2 + rnd() * 5;
    gr.j0 = rnd() * Math.PI * 2;
    gr.t = rnd() * 10;
    gr.a = 0.5 + rnd() * 0.5;
  };

  return {
    name: "sandstorm",
    // Storms need to be SEEN: clear day shows the warm veil best. The sand
    // requirement is in the weight, not the preferred — the demo button
    // can't teleport the player to a beach.
    preferred: { time: PHASE_DAY, weather: WEATHER_CLEAR },
    weight(env) {
      // Only rolls while the player stands in sandy ground; dry air only
      // (a future rain weather zeroes it, mist dampens it).
      const dry = isRainy(env) ? 0 : 1 - 0.35 * env.mist;
      return BASE_WEIGHT * env.sand * dry;
    },
    setActive(on) {
      active = on; // eases both ways — a storm rolls in and out
    },
    init(ctx) {
      ensureTexture(ctx.scene);
      haze = ctx.scene.add
        .rectangle(0, 0, 4, 4, HAZE_COLOR)
        .setOrigin(0, 0)
        .setDepth(HAZE_DEPTH)
        .setAlpha(0)
        .setVisible(false);
    },
    update(ctx, dt) {
      const view = ctx.view;
      const now = ctx.scene.time.now;
      const wallDt = lastNow ? Math.min(500, now - lastNow) : dt;
      lastNow = now;
      gustT += wallDt / 1000;
      // The storm follows the terrain: eased sand keeps it from flickering
      // at patch borders. A demoed storm off-sand still shows drifting dust
      // (0.35 floor) — on real sand it whips up to full force.
      sandEased += (ctx.env.sand - sandEased) * Math.min(1, (wallDt / 1500) * 3);
      const target = active ? 0.35 + 0.65 * sandEased : 0;
      gain += (target - gain) * Math.min(1, (wallDt / GAIN_TAU) * 3);
      const visible = gain > 0.02;
      // Slow gust surges + a faster flutter — the storm BREATHES.
      const gust = 0.62 + 0.28 * Math.sin(gustT * 0.55) + 0.1 * Math.sin(gustT * 2.1);

      if (haze) {
        if (!visible) {
          if (haze.visible) haze.setVisible(false);
        } else {
          haze
            .setPosition(view.x, view.y)
            .setSize(view.width, view.height)
            .setAlpha(0.34 * gain * (0.75 + 0.25 * gust))
            .setVisible(true);
        }
      }

      const want = visible ? STREAK_COUNT : 0;
      while (grains.length < want) {
        const sprite = ctx.scene.add
          .image(0, 0, STREAK_TEX)
          .setDepth(STREAK_DEPTH)
          .setAlpha(0)
          .setRotation(Math.atan2(WY, WX));
        const gr: Grain = { sprite, x: 0, y: 0, v: 0, jf: 0, j0: 0, t: 0, a: 1 };
        spawnGrain(gr, view, true);
        grains.push(gr);
      }
      while (grains.length > want) grains.pop()!.sprite.destroy();
      if (!visible) return;

      const dts = Math.min(dt, 100) / 1000;
      for (const gr of grains) {
        gr.t += dts;
        const v = gr.v * gust;
        gr.x += WX * v * dts;
        gr.y += WY * v * dts + Math.sin(gr.t * gr.jf + gr.j0) * 14 * dts;
        if (gr.x > view.right + 12 || gr.y > view.bottom + 12) spawnGrain(gr, view, false);
        // Faster grains stretch longer — cheap motion blur via scaleX.
        gr.sprite
          .setPosition(gr.x, gr.y)
          .setScale(0.8 + (v / 460) * 1.2, 1)
          .setAlpha(gr.a * gain * 0.75);
      }
    },
    debug() {
      return {
        active,
        gain,
        sand: sandEased,
        gust: +(0.62 + 0.28 * Math.sin(gustT * 0.55) + 0.1 * Math.sin(gustT * 2.1)).toFixed(2),
        streaks: grains.length,
      };
    },
    dispose() {
      haze?.destroy();
      haze = null;
      for (const gr of grains) gr.sprite.destroy();
      grains.length = 0;
    },
  };
}
