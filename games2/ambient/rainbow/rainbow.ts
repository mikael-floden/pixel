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

// The maintainer's concept art (2026-07-17, annotated screenshot): ONE HUGE
// bow of which you only ever see PARTS — a segment rising from one lower
// corner, another crossing the opposite upper corner, the middle swallowed
// by the sky. Distinct colour STRIPES, not a smooth gradient: red outermost,
// then yellow / green / blue / magenta, and a WHITE glow band on the inner
// edge (his exact six pens). So: giant radius (the circle dwarfs the
// screen), centre far off-screen on the anti-solar side, hard-ish posterized
// bands (the mist shader's stylized-layers philosophy), and PATCHY
// visibility — slow drifting noise lobes along the arc so only a few
// segments show at a time and they slowly migrate along the bow.
const FRAG = `
precision mediump float;
uniform float time;
uniform vec2 resolution;
uniform vec2 uCenter;  // arc circle centre, quad-local px (far off-screen)
uniform float uRadius; // bow radius, px (larger than the view diagonal)
uniform float uWidth;  // full stripe-stack thickness, px
uniform float uAlpha;  // master gain 0..1
uniform float uUp;     // +1/-1: which fragCoord y direction is screen-UP
uniform float uSeed;   // per-showing patch layout
varying vec2 fragCoord;

// Six hard-edged stripes, inner -> outer: white glow, magenta, blue, green,
// yellow, red. Edges get a short smoothstep (soft alpha, never a hard
// 100%->0% step — the house keying rule) but stay clearly banded.
vec3 stripes(float t) {
  vec3 c = vec3(1.0, 1.0, 1.0);                                   // white inner glow
  c = mix(c, vec3(1.0, 0.45, 0.90), smoothstep(0.115, 0.145, t)); // magenta
  c = mix(c, vec3(0.30, 0.50, 1.00), smoothstep(0.290, 0.320, t)); // blue
  c = mix(c, vec3(0.35, 1.00, 0.40), smoothstep(0.465, 0.495, t)); // green
  c = mix(c, vec3(1.00, 0.92, 0.25), smoothstep(0.640, 0.670, t)); // yellow
  c = mix(c, vec3(1.00, 0.30, 0.22), smoothstep(0.815, 0.845, t)); // red
  return c;
}

void main() {
  vec2 rel = fragCoord.xy - uCenter;
  float d = length(rel);
  float t = (d - uRadius) / uWidth + 0.5; // 0 inner .. 1 outer across the stack
  if (t < -0.1 || t > 1.1) { gl_FragColor = vec4(0.0); return; }
  // Band envelope: soft outer/inner skirts; the white band glows a bit softer.
  float env = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.92, 1.0, t));
  env *= mix(0.75, 1.0, smoothstep(0.115, 0.145, t));
  // Angle along the arc, up-half = (0..pi) after the uUp flip.
  float ang = atan(rel.y * uUp, rel.x);
  // Feet fade only right at the horizon; the bow otherwise reaches ground.
  float feet = smoothstep(0.0, 0.09, sin(ang));
  // PATCHY: slow-drifting lobes along the arc — you only see parts of the
  // bow, and which parts you see wanders over time. The lobe wavelength is
  // deliberately SMALLER than the visible arc window (the view only spans
  // ~1 rad of this giant circle), so some segment is always in frame —
  // "parts of it", never long minutes of nothing.
  float u = ang * 8.0;
  float n = 0.5 + 0.35 * sin(u * 1.7 + uSeed + time * 0.15)
                + 0.25 * sin(u * 3.3 - time * 0.11 + uSeed * 1.7);
  float vis = smoothstep(0.30, 0.56, n);
  float a = env * feet * vis * uAlpha * 0.5;
  gl_FragColor = vec4(stripes(t) * a, a); // premultiplied: soft luminous feel
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
  let seedPhase = 0; // per-showing patch layout (which parts of the bow show)
  let lastNow = 0; // wall-clock of the previous update (gain easing)
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
      if (on) seedPhase = rnd() * 6.28; // fresh patch layout each showing
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
        // fragCoord is BOTTOM-UP (Shadertoy convention — verified with a
        // gradient probe 2026-07-17): +y is screen-up, so uUp is +1 and the
        // centre's y is flipped into frag space when passed (update()).
        uUp: { type: "1f", value: 1 },
        uSeed: { type: "1f", value: 0 },
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
      // Ease on WALL-CLOCK, not frame dt: Phaser's smoothed delta
      // under-reports long frames (software-GL/laggy devices), and a bow
      // that condenses per-frame instead of per-second never shows there.
      const now = ctx.scene.time.now;
      const wallDt = lastNow ? Math.min(500, now - lastNow) : dt;
      lastNow = now;
      const target = active ? Math.min(1, env.sun * (0.35 + 0.65 * moisture(env))) : 0;
      gain += (target - gain) * Math.min(1, (wallDt / GAIN_TAU) * 3);
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
          // GIANT bow (maintainer's concept art): the circle dwarfs the
          // screen so only arc SEGMENTS cross the view. The centre sits far
          // off-screen, down-screen and leaning to the anti-solar side —
          // morning bows rise over the left of the view, evening the right,
          // noon straight across the top.
          const diag = Math.hypot(view.width, view.height);
          const radius = diag * 1.15;
          let cdx = sx * 0.6;
          let cdy = 1.0;
          const cdl = Math.hypot(cdx, cdy);
          cdx /= cdl;
          cdy /= cdl;
          const tx = view.centerX + cdx * radius * 0.8;
          const ty = view.centerY + cdy * radius * 0.8;
          if (!centered) {
            centered = true;
            cx = tx;
            cy = ty;
          } else {
            // The chase lag: run at the bow and it stays ahead of you.
            const k = Math.min(1, (wallDt / CENTER_TAU) * 3);
            cx += (tx - cx) * k;
            cy += (ty - cy) * k;
          }
          shader
            .setPosition(view.x, view.y)
            .setVisible(true);
          if (Math.abs(shader.width - view.width) > 1 || Math.abs(shader.height - view.height) > 1)
            shader.setSize(view.width, view.height);
          shader.setUniform("uCenter.value.x", cx - view.x);
          // Flip into the shader's bottom-up frag space.
          shader.setUniform("uCenter.value.y", view.height - (cy - view.y));
          shader.setUniform("uRadius.value", radius);
          shader.setUniform("uWidth.value", Math.max(20, diag * 0.09));
          shader.setUniform("uAlpha.value", gain);
          shader.setUniform("uSeed.value", seedPhase);
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
