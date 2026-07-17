import Phaser from "phaser";
import { AmbientFeature } from "../runtime/types";
import { isRainy } from "../runtime/env";

// Distant thunder — an EPISODE feature: while active, sheet-lightning
// flashes wash over the whole view every so often (double/triple pulses,
// like a storm beyond the horizon). Visual only for now — when the sounds
// domain ships a rumble, this is where it hooks in.
//
// Likeliness follows the maintainer's spec verbatim: base × 2 when it's
// raining, × 3 when night + raining. No rain weather exists yet (Clear /
// Cloudy / Mist), so until it ships, cloud and mist stand in as weak
// storm proxies — the name-matched rain multiplier takes over the day the
// games agent adds one (runtime/env.ts isRainy).
const DEPTH = 1_499_900; // sky band, above bats, below shooting stars
const BASE_WEIGHT = 0.35;
const STRIKE_EVERY_MS: [number, number] = [7_000, 26_000];
const COLOR = 0xdbe2ff; // cold blue-white sheet light

export function thunderFeature(): AmbientFeature {
  let flash: Phaser.GameObjects.Rectangle | null = null;
  let active = false;
  let nextStrikeIn = 0;
  let strikes = 0;
  // A strike is 2-3 alpha spikes over ~600 ms: (time-offset ms, peak alpha).
  let spikes: [number, number][] = [];
  let strikeT = -1; // ms since strike start; -1 = idle
  let seed = 29;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  const strike = () => {
    strikes++;
    strikeT = 0;
    const n = 2 + (rnd() < 0.4 ? 1 : 0);
    spikes = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
      spikes.push([t, (i === 0 ? 0.22 : 0.13) + rnd() * 0.12]);
      t += 90 + rnd() * 180;
    }
  };

  return {
    name: "thunder",
    weight(env) {
      const rainMult = isRainy(env) ? 1 : 0.4 * env.cloud + 0.3 * env.mist;
      // 1 + rain + night: rain alone ×2, night+rain ×3 (maintainer's spec).
      return BASE_WEIGHT * (1 + rainMult + env.night);
    },
    setActive(on) {
      active = on;
      if (on) nextStrikeIn = 2500 + Math.random() * 5000;
      // off: current flash finishes its decay; no further strikes.
    },
    init(ctx) {
      flash = ctx.scene.add
        .rectangle(0, 0, 4, 4, COLOR)
        .setOrigin(0, 0)
        .setDepth(DEPTH)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setAlpha(0)
        .setVisible(false);
    },
    update(ctx, dt) {
      if (active) {
        nextStrikeIn -= dt;
        if (nextStrikeIn <= 0) {
          strike();
          nextStrikeIn = STRIKE_EVERY_MS[0] + rnd() * (STRIKE_EVERY_MS[1] - STRIKE_EVERY_MS[0]);
        }
      }
      if (!flash || strikeT < 0) return;
      strikeT += dt;
      // Envelope: each spike pops instantly and decays over ~140 ms.
      let a = 0;
      let done = true;
      for (const [t0, peak] of spikes) {
        const rel = strikeT - t0;
        if (rel < 0) done = false;
        else {
          const v = peak * Math.exp(-rel / 140);
          if (v > 0.004) done = false;
          a = Math.max(a, v);
        }
      }
      // Night flashes read brighter against the dark — scale down by day.
      a *= 0.5 + 0.5 * ctx.env.night;
      const view = ctx.view;
      flash
        .setPosition(view.x, view.y)
        .setSize(view.width, view.height)
        .setAlpha(a)
        .setVisible(a > 0.004);
      if (done) {
        strikeT = -1;
        flash.setVisible(false);
      }
    },
    debug() {
      return { active, strikes, flashing: strikeT >= 0, nextStrikeIn: active ? Math.round(nextStrikeIn) : null };
    },
    dispose() {
      flash?.destroy();
      flash = null;
    },
  };
}
