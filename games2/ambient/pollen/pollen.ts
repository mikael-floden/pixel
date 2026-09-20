import Phaser from "phaser";
import { AmbientCtx, AmbientFeature, PHASE_DAY, WEATHER_CLEAR } from "../runtime/types";
import { ZoneWatch } from "../runtime/zoneplace";

// Pollen / sun motes — the drifting dust you see when light cuts through
// forest air. Faint additive specks ride the same wind direction as the
// weather layer's clouds (~42,23 px/s, scaled down — pollen lags the sky),
// flutter on small sinusoids, settle slowly, and GLINT: alpha is a soft
// base times a slow sharpened sine, so each mote occasionally catches the
// light and sparkles before dimming back into the air. The whole field
// fades with the sun and with cloud cover — overcast air shows no motes.
const TEX = "amb-mote";
const DEPTH = 900_000.4; // under the tap beacon, above the darkness overlay
const MARGIN = 32;
const AREA_PER_MOTE = 5500; // ~28 motes on a 480×320 view
const MIN_MOTES = 10;
const MAX_MOTES = 42;
const GAIN_TAU = 1800; // ms
// Cloud wind is ~(42,23) px/s in the weather shader; pollen drifts slower.
const WIND_X = 42 * 0.28;
const WIND_Y = 23 * 0.28;
const SETTLE = 4.5; // px/s gentle fall
const TINT = 0xfff2c4; // warm sunlit dust

interface Mote {
  sprite: Phaser.GameObjects.Image;
  x: number;
  y: number;
  ff: number; // flutter freq (rad/s)
  f0: number; // flutter phase
  fa: number; // flutter amplitude (px)
  gf: number; // glint freq (rad/s)
  g0: number; // glint phase
  t: number;
  size: number;
  zw: number; // the zone field where it last read it, and where that was
  zx: number;
  zy: number;
}

export function pollenFeature(): AmbientFeature {
  const zone = new ZoneWatch("pollen");
  const motes: Mote[] = [];
  let gain = 0;
  let suppressed = false; // demo solo mode: another effect owns the stage
  let forced = false; // demo: pollen selected — show at full, any time
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  const ensureTexture = (scene: Phaser.Scene) => {
    if (scene.textures.exists(TEX)) return;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 0.14).fillCircle(3, 3, 2.4);
    g.fillStyle(0xffffff, 1).fillCircle(3, 3, 1.1);
    g.generateTexture(TEX, 6, 6);
    g.destroy();
  };

  const spawnInto = (m: Mote, view: Phaser.Geom.Rectangle, anywhere: boolean, ctx?: AmbientCtx) => {
    // Steady state: enter from the upwind edge so the field flows through
    // the frame instead of popping in mid-air. Initial fill: anywhere.
    if (anywhere) {
      m.x = view.x + rnd() * view.width;
      m.y = view.y + rnd() * view.height;
    } else {
      m.x = view.x - MARGIN + rnd() * MARGIN;
      m.y = view.y + rnd() * view.height * 0.9;
    }
    m.ff = 0.6 + rnd() * 1.2;
    m.f0 = rnd() * Math.PI * 2;
    m.fa = 2 + rnd() * 5;
    m.gf = 0.25 + rnd() * 0.5;
    m.g0 = rnd() * Math.PI * 2;
    m.t = rnd() * 20;
    m.size = 0.7 + rnd() * 0.7;
    /* THE ZONE (runtime/zoneplace.ts): a mote DRAWS at the field's weight
     * where it is, re-read as it drifts, so the haze thins out across the
     * feather. A mote is a speck of light, so a partial alpha reads as
     * distance rather than as a ghost. */
    if (ctx) zone.seed(ctx, m, m.x, m.y);
  };

  const targetCount = (view: Phaser.Geom.Rectangle) =>
    Math.max(MIN_MOTES, Math.min(MAX_MOTES, Math.round((view.width * view.height) / AREA_PER_MOTE)));

  return {
    name: "pollen",
    preferred: { time: PHASE_DAY, weather: WEATHER_CLEAR },
    conflicts: ["fireflies"], // day/night floating-mote pair — one at a time
    init(ctx) {
      ensureTexture(ctx.scene);
    },
    update(ctx, dt) {
      zone.step(ctx, dt);
      const dts = Math.min(dt, 100) / 1000;
      const view = ctx.view;
      // Sunlit air, clear-ish sky. The sun ramp already covers dawn/dusk;
      // cloud cover kills the beams the motes are supposed to hang in.
      // ...and only where its zone is, read on the VIEW rather than my cell
      const target = forced ? 1 : suppressed || !zone.any ? 0 : ctx.env.sun * (1 - 0.85 * ctx.env.cloud);
      gain += (target - gain) * Math.min(1, (dt / GAIN_TAU) * 3);
      // OUTDOOR GAIN: every effect here is outdoor weather/wildlife, so it must
      // stop the moment the player steps inside (runtime/outdoor.ts). Applied
      // AFTER the feature's own easing so it is not slowed by GAIN_TAU — the
      // crossing snaps today, and when it becomes a fade this carries it.
      const g = gain * ctx.outdoor;
      const visible = g > 0.02;

      const want = targetCount(view);
      while (motes.length < want) {
        const sprite = ctx.scene.add
          .image(0, 0, TEX)
          .setDepth(DEPTH)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setTint(TINT)
          .setVisible(false);
        const m: Mote = { sprite, x: 0, y: 0, ff: 0, f0: 0, fa: 0, gf: 0, g0: 0, t: 0, size: 1, zw: 1, zx: 0, zy: 0 };
        spawnInto(m, view, true, ctx);
        motes.push(m);
      }
      while (motes.length > want) motes.pop()!.sprite.destroy();

      if (!visible) {
        for (const m of motes) if (m.sprite.visible) m.sprite.setVisible(false);
        return;
      }
      for (const m of motes) {
        m.t += dts;
        m.x += WIND_X * dts;
        m.y += (WIND_Y * 0.4 + SETTLE) * dts + Math.cos(m.t * m.ff * 1.3 + m.f0) * 1.2 * dts;
        if (
          m.x > view.right + MARGIN || m.x < view.x - MARGIN * 2 ||
          m.y > view.bottom + MARGIN || m.y < view.y - MARGIN
        ) {
          spawnInto(m, view, false, ctx);
        }
        const flutter = Math.sin(m.t * m.ff + m.f0) * m.fa;
        // Sharpened slow sine: mostly a faint speck, occasionally a glint.
        const g = Math.max(0, Math.sin(m.t * m.gf + m.g0));
        const glint = 0.22 + 0.78 * g * g * g;
        m.sprite
          .setPosition(m.x + flutter, m.y)
          .setScale(m.size)
          .setAlpha(g * 0.5 * glint * zone.drift(ctx, m, m.x, m.y))
          .setVisible(true);
      }
    },
    setSuppressed(on) {
      suppressed = on;
    },
    setForced(on) {
      forced = on;
    },
    debug() {
      return {
        gain,
        zone: zone.info(), // the boundary: is a pollen zone in view, and how much of it
        suppressed,
        forced,
        count: motes.length,
        lit: motes.filter((m) => m.sprite.visible && m.sprite.alpha > 0.02).length,
        sample: motes[0] ? { x: motes[0].sprite.x, y: motes[0].sprite.y, a: motes[0].sprite.alpha } : null,
        /* `all` IS THE CHARTER'S FIELD: every drawn instance with the alpha it
         * is DRAWN at. It was missing here, so nothing that reads the ambient
         * report — the zone-boundary gate among them — could see this effect
         * at all; it counted zero and called the boundary broken. */
        all: motes
          .filter((m) => m.sprite.visible && m.sprite.alpha > 0.01)
          .map((m) => ({ x: Math.round(m.sprite.x), y: Math.round(m.sprite.y), a: +m.sprite.alpha.toFixed(3), z: +m.zw.toFixed(3) })),
      };
    },
    dispose() {
      for (const m of motes) m.sprite.destroy();
      motes.length = 0;
    },
  };
}
