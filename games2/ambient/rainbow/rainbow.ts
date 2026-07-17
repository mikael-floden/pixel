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

// Maintainer round 2 (annotated screenshot 2026-07-17 evening): show ONE
// RAINBOW LEG only — a single flank of the giant circle rising steeply from
// the ground and dissolving mid-sky — and make the colours REAL rainbow
// optics (his words: not his draft's order): a continuous spectrum, red on
// the OUTER edge through orange/yellow/green/blue to violet on the inner
// edge. No white band, no posterized cartoon stripes.
const FRAG = `
precision mediump float;
uniform float time;
uniform vec2 resolution;
uniform vec2 uCenter;  // arc circle centre, quad-local px (far off-screen)
uniform float uRadius; // bow radius, px (larger than the view diagonal)
uniform float uWidth;  // spectrum thickness, px
uniform float uAlpha;  // master gain 0..1
uniform float uUp;     // +1/-1: which fragCoord y direction is screen-UP
uniform float uSeed;   // per-showing wobble phase
uniform float uA0;     // arc angle at the leg's FOOT (frag space, radians)
uniform float uSpan;   // angular span foot -> top-corner exit (positive)
varying vec2 fragCoord;

// Real-rainbow spectrum: t 0 (inner) .. 1 (outer) maps violet -> red, so
// red sits on the OUTSIDE of the bow like the real thing. Slightly
// desaturated toward white — a rainbow is glare on rain, not neon.
vec3 spectrum(float t) {
  float h = 0.75 * (1.0 - t); // hue: red 0.0 (outer) .. violet 0.75 (inner)
  vec3 p = abs(fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), 0.8);
}

void main() {
  vec2 rel = fragCoord.xy - uCenter;
  float d = length(rel);
  float t = (d - uRadius) / uWidth + 0.5; // 0 inner .. 1 outer across the spectrum
  if (t < -0.1 || t > 1.1) { gl_FragColor = vec4(0.0); return; }
  // Soft skirts both edges; a touch brighter toward the red edge (real bows
  // carry their intensity outward).
  float env = smoothstep(0.0, 0.14, t) * (1.0 - smoothstep(0.86, 1.0, t));
  env *= 0.8 + 0.2 * t;
  // ONE LEG (maintainer's red stroke): s runs 0 at the FOOT (lower-left,
  // fades in from the ground haze) to 1 where the leg EXITS the top corner
  // — the frame cuts it there, the crown stays forever beyond the screen.
  float ang = atan(rel.y * uUp, rel.x);
  float s = (uA0 - ang) / uSpan;
  float vis = smoothstep(0.0, 0.16, s) * (1.0 - smoothstep(1.15, 1.35, s));
  // Faint shimmer so the leg feels lit through moving rain.
  vis *= 0.94 + 0.06 * sin(s * 5.0 + time * 0.3 + uSeed);
  float a = env * vis * uAlpha * 0.7;
  // PREMULTIPLIED output — the shader pipeline blends (ONE, 1-SRC_ALPHA),
  // verified empirically: straight colour rendered neon-opaque, premult at
  // low master drowned the warm half into dark terrain. 0.7 master keeps
  // red/orange readable over the darkest ground while staying translucent.
  gl_FragColor = vec4(spectrum(t) * a, a);
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
  let seedPhase = 0; // per-showing wobble phase
  let lastNow = 0; // wall-clock of the previous update (gain easing)
  let geoDebug: Record<string, unknown> | null = null; // live geometry (QA probe)
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
      if (on) seedPhase = rnd() * 6.28; // fresh wobble phase each showing
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
        uA0: { type: "1f", value: 2.4 },
        uSpan: { type: "1f", value: 0.7 },
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
          // ONE LEFT LEG, exactly the maintainer's red stroke: the leg
          // enters at the lower-LEFT (its foot fading in from the ground
          // haze) and rises diagonally to EXIT the top-right corner — the
          // crown stays forever beyond the frame. We fit the giant circle
          // through those two view-anchored points every frame, so the leg
          // crosses the same way at any viewport aspect. (sx — the shadow
          // lean — still nudges the foot along the bottom a little, so the
          // leg breathes with the day.)
          const diag = Math.hypot(view.width, view.height);
          const F = {
            x: view.x + view.width * (0.06 + 0.05 * Math.max(-1, Math.min(1, sx))),
            y: view.y + view.height * 0.8,
          };
          const E = { x: view.x + view.width * 0.96, y: view.y + view.height * 0.04 };
          const dxc = E.x - F.x;
          const dyc = E.y - F.y;
          const chord = Math.hypot(dxc, dyc);
          const radius = Math.max(diag * 1.15, chord * 0.62); // circle must fit the chord
          const q = Math.sqrt(Math.max(0, radius * radius - (chord / 2) * (chord / 2)));
          // Perpendicular pointing down-right (screen-down coords) = the
          // concave side; the centre lives far off-screen there.
          let px = dyc;
          let py = -dxc;
          if (px + py < 0) {
            px = -px;
            py = -py;
          }
          const pl = Math.hypot(px, py) || 1;
          const tx = (F.x + E.x) / 2 + (px / pl) * q;
          const ty = (F.y + E.y) / 2 + (py / pl) * q;
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
          // Foot/exit angles measured from the EASED centre, in frag space
          // (y flipped), so the visible window tracks the lagging circle.
          const angOf = (p: { x: number; y: number }) =>
            Math.atan2(-(p.y - cy), p.x - cx); // -(dy): screen-down -> frag-up
          const a0 = angOf(F);
          const span = a0 - angOf(E); // foot angle > exit angle on this arc
          shader.setUniform("uA0.value", a0);
          shader.setUniform("uSpan.value", Math.max(0.15, span));
          shader.setUniform("uRadius.value", radius);
          shader.setUniform("uWidth.value", Math.max(20, diag * 0.09));
          shader.setUniform("uAlpha.value", gain);
          shader.setUniform("uSeed.value", seedPhase);
          geoDebug = {
            view: [Math.round(view.x), Math.round(view.y), Math.round(view.width), Math.round(view.height)],
            F: [Math.round(F.x - view.x), Math.round(F.y - view.y)],
            E: [Math.round(E.x - view.x), Math.round(E.y - view.y)],
            centerLocal: [Math.round(cx - view.x), Math.round(cy - view.y)],
            a0: +a0.toFixed(3),
            span: +span.toFixed(3),
            radius: Math.round(radius),
          };
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
        geo: geoDebug,
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
