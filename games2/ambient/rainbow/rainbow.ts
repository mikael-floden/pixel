import Phaser from "phaser";
import { AmbientCtx, AmbientFeature, PHASE_DAY, WEATHER_CLOUDY } from "../runtime/types";
import { isRainy } from "../runtime/env";

// Rainbow — an EPISODE feature rendered by a real fragment SHADER
// (maintainer: "make the effect in a shader... you can never arrive at the
// rainbow, it always moves forward").
//
// Physics the shader keeps:
// - ANTI-SOLAR placement: a rainbow stands exactly where the shadows point.
//   The bow's azimuth is derived from the game's sun cast direction
//   (__ml.sunInfo via env sampling feeds curSun through the runtime), so it
//   hangs screen-right in the morning, down-screen at noon, screen-left in
//   the evening — always opposite the sun, sweeping with the world clock.
// - NEVER ARRIVED AT: the arc is anchored RELATIVE TO THE CAMERA at a fixed
//   distance (optical infinity), eased with a short lag — walk toward it
//   and it slips away ahead of you; stop and it settles.
// - DOUBLE BOW: primary band red-outside → violet-inside, plus a fainter,
//   wider secondary at 1.28× radius with the colour order REVERSED (real
//   double-rainbow optics), with a subtle time shimmer.
// The bow is paired with a light DRIZZLE sprite layer (thin streaks) so an
// active rainbow reads as the sun-shower that makes one. WebGL-only by
// nature; on a canvas renderer the feature quietly does nothing (charter:
// degrade gracefully). Zero gameplay impact — display objects only.
const DEPTH = 900_000.3; // above the darkness overlay band, under the beacon
const DRIZZLE_DEPTH = 900_000.35;
const BASE_WEIGHT = 0.5;
const GAIN_TAU = 2200; // ms — a rainbow condenses and dissolves slowly
const CENTER_TAU = 550; // ms — the chase lag that makes it recede
const DRIZZLE_COUNT = 36;
const DRIZZLE_TEX = "amb-drizzle";

const FRAG = `
precision mediump float;
uniform float time;
uniform vec2 resolution;
uniform vec2 uCenter;  // arc circle centre, quad-local px
uniform float uRadius; // primary bow radius, px
uniform float uWidth;  // primary band thickness, px
uniform float uAlpha;  // master gain 0..1
uniform float uUp;     // +1/-1: which fragCoord y direction is screen-UP
varying vec2 fragCoord;

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// One spectral band: t = signed distance from band centre in widths.
// reversed=0: red on the OUTER edge (primary bow); 1: red inner (secondary).
float band(float d, float radius, float width, out vec3 col, float reversed) {
  float t = (d - radius) / width + 0.5; // 0 inner .. 1 outer
  float env = smoothstep(0.0, 0.22, t) * (1.0 - smoothstep(0.78, 1.0, t));
  float spec = mix(t, 1.0 - t, reversed);
  // hue: red (0.0) at the red edge -> violet (0.78) at the violet edge
  col = hsv2rgb(vec3((1.0 - spec) * 0.78, 0.75, 1.0));
  return env;
}

void main() {
  vec2 p = fragCoord.xy;
  vec2 rel = p - uCenter;
  float d = length(rel);
  if (d < 1.0) { gl_FragColor = vec4(0.0); return; }
  vec2 dir = rel / d;
  // Only the arc ABOVE the horizon shows; the feet fade toward the ground.
  float upness = dir.y * uUp;
  float arc = smoothstep(-0.05, 0.45, upness);
  vec3 c1; float b1 = band(d, uRadius, uWidth, c1, 0.0);
  vec3 c2; float b2 = band(d, uRadius * 1.28, uWidth * 1.5, c2, 1.0) * 0.32;
  // Gentle shimmer along the arc so the bow feels lit by moving air.
  float ang = atan(rel.y, rel.x);
  float shimmer = 0.92 + 0.08 * sin(ang * 9.0 + time * 0.6);
  float a1 = b1 * arc * shimmer;
  float a2 = b2 * arc;
  vec3 col = (c1 * a1 + c2 * a2) / max(a1 + a2, 1e-4);
  float a = (a1 + a2) * uAlpha * 0.42;
  gl_FragColor = vec4(col * a, a); // premultiplied-ish: soft additive feel
}
`;

export function rainbowFeature(): AmbientFeature {
  let shader: Phaser.GameObjects.Shader | null = null;
  let base: Phaser.Display.BaseShader | null = null;
  let active = false;
  let gain = 0;
  let cx = 0; // eased arc-centre (world px) — the "never arrive" anchor
  let cy = 0;
  let centered = false;
  const drops: { sprite: Phaser.GameObjects.Image; x: number; y: number; v: number }[] = [];
  let seed = 41;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  // How much water hangs in the sunlit air. No rain weather exists yet
  // (Clear/Cloudy/Mist) — cloud/mist stand in; a future "Rain"/"Drizzle"
  // weather takes over via the name match with no edit here.
  const moisture = (env: { cloud: number; mist: number; weatherName: string }) =>
    isRainy(env as never) ? 1.0 : 0.55 * env.cloud + 0.4 * env.mist;

  const ensureDrizzleTex = (scene: Phaser.Scene) => {
    if (scene.textures.exists(DRIZZLE_TEX)) return;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xdce8f4, 1).fillRect(0, 0, 1, 7);
    g.generateTexture(DRIZZLE_TEX, 1, 7);
    g.destroy();
  };

  return {
    name: "rainbow",
    preferred: { time: PHASE_DAY, weather: WEATHER_CLOUDY }, // sun-shower stand-in until rain ships
    weight(env) {
      // Sunlight through wet air, or no bow at all.
      return BASE_WEIGHT * env.sun * moisture(env);
    },
    setActive(on) {
      active = on; // gain eases both ways — a rainbow never pops
    },
    init(ctx) {
      const scene = ctx.scene;
      if (scene.game.renderer.type !== Phaser.WEBGL) return; // canvas: no shader, no bow
      ensureDrizzleTex(scene);
      base = new Phaser.Display.BaseShader("amb-rainbow", FRAG, undefined, {
        uCenter: { type: "2f", value: { x: 0, y: 0 } },
        uRadius: { type: "1f", value: 260 },
        uWidth: { type: "1f", value: 24 },
        uAlpha: { type: "1f", value: 0 },
        uUp: { type: "1f", value: -1 }, // fragCoord y grows down-screen
      });
      shader = scene.add
        .shader(base, 0, 0, 2, 2)
        .setOrigin(0, 0)
        .setDepth(DEPTH)
        .setVisible(false);
    },
    update(ctx, dt) {
      const view = ctx.view;
      const env = ctx.env;
      const target = active ? Math.min(1, env.sun * (0.35 + 0.65 * moisture(env))) : 0;
      gain += (target - gain) * Math.min(1, (dt / GAIN_TAU) * 3);
      const visible = gain > 0.02;

      // ---- the bow (shader quad) ----
      if (shader) {
        if (!visible) {
          if (shader.visible) shader.setVisible(false);
        } else {
          // Anti-solar azimuth: shadows point away from the sun; project the
          // grid cast direction to screen. At noon the cast is down-screen.
          const ml = (window as unknown as { __ml?: { sunInfo?: () => { sun: number[] } } }).__ml;
          let gx = 0.707, gy = 0.707;
          try {
            const s = ml?.sunInfo?.();
            if (s && Math.abs(s.sun[0]) + Math.abs(s.sun[1]) > 0.01) {
              gx = s.sun[0];
              gy = s.sun[1];
            }
          } catch {
            /* keep default noon-ish cast */
          }
          // Iso projection of a grid direction onto the screen.
          let sx = gx - gy;
          let sy = (gx + gy) * 0.55;
          const sl = Math.hypot(sx, sy) || 1;
          sx /= sl;
          sy /= sl;
          const radius = Math.min(view.width, view.height) * 0.62;
          // The circle centre sits toward the anti-solar side and BELOW the
          // horizon line so only the upper arc rises over the land.
          const tx = view.centerX + sx * view.width * 0.22;
          const ty = view.centerY + Math.max(0.25, sy) * view.height * 0.28 + radius * 0.55;
          if (!centered) {
            centered = true;
            cx = tx;
            cy = ty;
          } else {
            // The chase lag: run at the bow and it stays ahead of you.
            const k = Math.min(1, (dt / CENTER_TAU) * 3);
            cx += (tx - cx) * k;
            cy += (ty - cy) * k;
          }
          shader
            .setPosition(view.x, view.y)
            .setVisible(true);
          if (Math.abs(shader.width - view.width) > 1 || Math.abs(shader.height - view.height) > 1)
            shader.setSize(view.width, view.height);
          shader.setUniform("uCenter.value.x", cx - view.x);
          shader.setUniform("uCenter.value.y", cy - view.y);
          shader.setUniform("uRadius.value", radius);
          shader.setUniform("uWidth.value", Math.max(14, radius * 0.085));
          shader.setUniform("uAlpha.value", gain);
        }
      }

      // ---- the sun-shower drizzle ----
      const wantDrops = visible ? DRIZZLE_COUNT : 0;
      while (drops.length < wantDrops) {
        const sprite = ctx.scene.add
          .image(0, 0, DRIZZLE_TEX)
          .setDepth(DRIZZLE_DEPTH)
          .setAlpha(0)
          .setRotation(-0.12);
        drops.push({
          sprite,
          x: view.x + rnd() * view.width,
          y: view.y + rnd() * view.height,
          v: 220 + rnd() * 120,
        });
      }
      while (drops.length > wantDrops) drops.pop()!.sprite.destroy();
      const dts = Math.min(dt, 100) / 1000;
      for (const drop of drops) {
        drop.y += drop.v * dts;
        drop.x += drop.v * 0.12 * dts; // slight wind lean, matches rotation
        if (drop.y > view.bottom + 8 || drop.x > view.right + 8) {
          drop.x = view.x + rnd() * view.width;
          drop.y = view.y - 10;
          drop.v = 220 + rnd() * 120;
        }
        drop.sprite.setPosition(drop.x, drop.y).setAlpha(0.16 * gain);
      }
    },
    debug() {
      return {
        active,
        gain,
        shader: !!shader,
        center: shader?.visible ? [Math.round(cx), Math.round(cy)] : null,
        drops: drops.length,
      };
    },
    dispose() {
      shader?.destroy();
      shader = null;
      for (const d of drops) d.sprite.destroy();
      drops.length = 0;
    },
  };
}
