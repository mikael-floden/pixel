import Phaser from "phaser";
import { AmbientCtx, AmbientFeature, PHASE_DAY, WEATHER_CLEAR } from "../runtime/types";
import { isRainy } from "../runtime/env";

// Heat haze / heat shimmer — a REAL refraction (maintainer). Hot air over
// baked ground bends the light, so this is a camera POST-PROCESS that
// re-samples the rendered world with a rising, wavering UV offset — it
// distorts the ACTUAL scene (world + lighting), never an overlay.
//
// Terrain-aware like its sibling sandstorm: the director only rolls it
// while the player stands on hot SAND in strong sun, and the shimmer keeps
// following the ground (eases toward the local sand fraction). Dry, sunlit,
// clear-ish air only.
//
// SAFETY (ambient must never break the game): the pipeline is ATTACHED to
// the main camera only while the shimmer is visible and REMOVED the moment
// it fades — so when no heat haze is playing the render path is byte-for-
// byte what it was before we existed. WebGL only; any failure sets a
// `broken` latch and the feature never touches the camera again.
const PIPE_KEY = "AmbHeatHaze";

// PostFX frag: uMainSampler is the rendered frame; outTexCoord the screen
// UV. outTexCoord.y is BOTTOM-UP here (verified with a hard-split row
// probe: uv.y>0.5 shifted the TOP screen rows), so the hot GROUND band —
// the lower screen where the terrain sits — is SMALL uv.y. Heat rises: the
// ripple is strongest low and fades up, scrolling over time.
const FRAG = `
precision mediump float;
uniform sampler2D uMainSampler;
uniform float uTime;
uniform float uIntensity;
varying vec2 outTexCoord;

void main() {
  vec2 uv = outTexCoord;
  // The game canvas is all terrain (no real sky), so shimmer covers the
  // whole ground, a touch stronger low where the heat pools.
  float ground = 1.0 - 0.55 * smoothstep(0.15, 0.95, uv.y);
  // Rising wavering columns: two beating sines scrolling over time, wobbled
  // along x so the shimmer is not a flat horizontal band.
  float w = sin(uv.y * 120.0 - uTime * 3.4 + uv.x * 22.0)
          + 0.6 * sin(uv.y * 61.0 - uTime * 2.1 + uv.x * 9.0);
  float dx = w * ground * uIntensity * 0.006;
  float dy = sin(uv.x * 85.0 + uTime * 2.6) * ground * uIntensity * 0.002;
  gl_FragColor = texture2D(uMainSampler, uv + vec2(dx, dy));
}
`;

// The PostFX pipeline. Uniforms are pushed from the feature via the two
// public fields each frame; onDraw binds them and draws the frame through.
class HeatHazePipeline extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  hazeTime = 0;
  hazeInt = 0;
  constructor(game: Phaser.Game) {
    super({ game, name: PIPE_KEY, fragShader: FRAG });
  }
  onDraw(renderTarget: Phaser.Renderer.WebGL.RenderTarget) {
    this.set1f("uTime", this.hazeTime);
    this.set1f("uIntensity", this.hazeInt);
    this.bindAndDraw(renderTarget);
  }
}

export function heatHazeFeature(): AmbientFeature {
  let scene: Phaser.Scene | null = null;
  let registered = false;
  let broken = false; // any failure latches here — never touch the camera again
  let attached = false;
  let inst: HeatHazePipeline | null = null;
  let active = false;
  let gain = 0;
  let sandEased = 0;
  let tAcc = 0;

  const register = (s: Phaser.Scene) => {
    if (registered || broken) return;
    try {
      const renderer = s.game.renderer as unknown as {
        type: number;
        pipelines?: { postPipelineClasses?: Map<string, unknown>; addPostPipeline: (k: string, c: unknown) => void };
      };
      if (!renderer || renderer.type !== Phaser.WEBGL) {
        broken = true; // canvas renderer: no shader, no shimmer (graceful)
        return;
      }
      const pm = renderer.pipelines;
      if (pm && !pm.postPipelineClasses?.has(PIPE_KEY)) pm.addPostPipeline(PIPE_KEY, HeatHazePipeline as unknown as new () => unknown);
      registered = true;
    } catch {
      broken = true;
    }
  };

  const detach = () => {
    if (!attached) return;
    try {
      scene?.cameras?.main?.removePostPipeline(PIPE_KEY);
    } catch {
      /* ignore */
    }
    attached = false;
    inst = null;
  };

  return {
    name: "heathaze",
    preferred: { time: PHASE_DAY, weather: WEATHER_CLEAR },
    weight(env) {
      // Hot dry sand in strong sun; cloud/mist/rain all kill the shimmer.
      const dry = isRainy(env) ? 0 : 1 - 0.7 * env.cloud - 0.5 * env.mist;
      return 0.5 * env.sun * env.sand * Math.max(0, dry);
    },
    setActive(on) {
      active = on; // eases both ways
    },
    init(ctx) {
      scene = ctx.scene;
      register(ctx.scene);
    },
    update(ctx, dt) {
      const env = ctx.env;
      // Follow the terrain (eased sand) with a demo floor off-sand, and fade
      // with the sun — no shimmer at night even if pinned.
      sandEased += (env.sand - sandEased) * Math.min(1, (dt / 1500) * 3);
      const target = active ? (0.4 + 0.6 * sandEased) * env.sun : 0;
      gain += (target - gain) * Math.min(1, (dt / 2200) * 3);
      tAcc += dt / 1000;
      const cam = ctx.scene.cameras?.main;
      if (!cam || broken) {
        if (attached) detach();
        return;
      }
      const visible = gain > 0.02;
      try {
        if (visible && !attached) {
          register(ctx.scene);
          if (broken) return;
          cam.setPostPipeline(HeatHazePipeline as unknown as string);
          const got = cam.getPostPipeline(HeatHazePipeline as unknown as string) as unknown;
          inst = (Array.isArray(got) ? got[0] : got) as HeatHazePipeline;
          attached = true;
        } else if (!visible && attached) {
          detach();
        }
        if (inst) {
          inst.hazeTime = tAcc;
          inst.hazeInt = gain;
        }
      } catch {
        broken = true;
        detach();
      }
    },
    debug() {
      return { active, gain, sand: sandEased, attached, broken, t: +tAcc.toFixed(2) };
    },
    dispose() {
      detach();
    },
  };
}
