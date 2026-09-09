import Phaser from "phaser";
import { AmbientCtx, AmbientEnv, AmbientFeature, defaultEnv } from "./types";
import { sampleEnv } from "./env";
import { Director } from "./director";
import { Toggles } from "./toggles";
import { Demo } from "./demo";
import { DemoButton } from "./hudbutton";
import { birdDensity, setBirdDensity } from "./density";
import { OUTDOOR_FADE_MS, OutdoorGain, readIndoor } from "./outdoor";

const SCENE_KEY = "world"; // WorldScene's key
const ENV_SAMPLE_MS = 100; // mood changes are seconds-long fades; 10 Hz is plenty

/** Attach the ambient features to the world scene from the OUTSIDE: poll for
 * the scene, ride its UPDATE event, add our own display objects. Zero edits
 * inside the games agent's files; if the scene never appears (e.g. the
 * #map preview boot) this quietly does nothing. */
export function mountAmbient(game: Phaser.Game, features: AmbientFeature[]) {
  let tries = 0;
  const attach = () => {
    const scene = game.scene?.getScene(SCENE_KEY);
    // Scene exists once the game boots; UPDATE only fires after its create(),
    // so a successful getScene is all we need before hooking.
    if (!scene) {
      if (++tries < 80) setTimeout(attach, 250); // give up quietly after ~20s
      return;
    }
    const ctx: AmbientCtx = {
      scene,
      env: defaultEnv(),
      view: new Phaser.Geom.Rectangle(0, 0, 1, 1),
      zoom: 1,
      outdoor: 1,
    };
    const outdoor = new OutdoorGain();
    const director = new Director(features);
    const toggles = new Toggles(features, director);
    const demo = new Demo(features, toggles);
    const demoButton = new DemoButton(demo);
    let inited = false;
    let envAge = ENV_SAMPLE_MS; // sample on the first tick
    const safe = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        // Ambient must never break the game — warn and move on.
        console.warn("[ambient]", e);
      }
    };
    let lastTick = 0;
    const cost = new Map<string, { sum: number; n: number; peak: number }>();
    const onUpdate = (_time: number, phaserDt: number) => {
      const cam = scene.cameras?.main;
      if (!cam) return;
      // Hand features WALL-CLOCK deltas, not Phaser's smoothed dt: under
      // long frames (software-GL harnesses, laggy phones) the smoothed dt
      // under-reports real time and every ambient timer/fade crawls — the
      // eased-gain lesson, applied to the whole layer. Capped at 500ms so
      // a background-tab hitch can't teleport particles.
      const now = scene.time.now;
      const dt = lastTick ? Math.min(500, now - lastTick) : phaserDt;
      lastTick = now;
      envAge += dt;
      if (envAge >= ENV_SAMPLE_MS) {
        envAge = 0;
        ctx.env = sampleEnv(ctx.env, cam.worldView.centerX, cam.worldView.centerY);
        safe(() => director.tick(ctx.env));
        // The HudBar rebuilds on re-joins; keep the demo button alive/fresh.
        safe(() => demoButton.ensure());
      }
      ctx.view = cam.worldView;
      ctx.zoom = cam.zoom;
      // EVERY FRAME, not on the 10 Hz env sample: this must stop the moment the
      // player is inside, and a sampled read would keep weather falling through
      // the roof for up to 100 ms (~6 frames) after they stepped in.
      ctx.env.indoor = readIndoor();
      ctx.outdoor = outdoor.step(dt, ctx.env.indoor);
      if (!inited) {
        inited = true;
        for (const f of features) safe(() => f.init(ctx));
      }
      /* WHAT EACH EFFECT COSTS, measured rather than argued about. Every
       * feature draws into the same frame the player is walking in, so "does
       * this lag?" has to be answerable per feature and not just per frame —
       * the harness's own frame time is far too noisy to see a 0.2 ms effect
       * inside it. Two `performance.now()` calls per feature per frame is
       * ~2 us total, which is cheaper than the question. */
      for (const f of features) {
        const t0 = performance.now();
        safe(() => f.update(ctx, dt));
        const ms = performance.now() - t0;
        const c = cost.get(f.name) ?? { sum: 0, n: 0, peak: 0 };
        c.sum += ms;
        c.n++;
        c.peak = Math.max(c.peak, ms);
        cost.set(f.name, c);
      }
    };
    scene.events.on(Phaser.Scenes.Events.UPDATE, onUpdate);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      scene.events.off(Phaser.Scenes.Events.UPDATE, onUpdate);
      for (const f of features) safe(() => f.dispose());
    });
    // QA probe surface, mirroring the game's __ml idiom.
    (window as unknown as { __mlAmbient?: unknown }).__mlAmbient = {
      list: () => features.map((f) => f.name),
      /** Per-feature update cost since the last reset: mean and worst ms of a
       * frame. `cost(true)` reads and resets, which is how an A/B is taken. */
      cost: (reset = false) => {
        const out: Record<string, { ms: number; peak: number; frames: number }> = {};
        for (const [k, c] of cost)
          out[k] = { ms: +(c.sum / Math.max(1, c.n)).toFixed(4), peak: +c.peak.toFixed(3), frames: c.n };
        if (reset) cost.clear();
        return out;
      },
      debug: (name: string) => features.find((f) => f.name === name)?.debug() ?? null,
      env: () => ({ ...ctx.env }),
      // INDOOR/OUTDOOR: the game's geometry verdict, the gain every effect
      // multiplies by, and the crossing time (0 = the current snap). QA asserts
      // gain 0 indoors; a future fade shows up here as fadeMs > 0.
      outdoor: () => ({ indoor: ctx.env.indoor, gain: ctx.outdoor, fadeMs: OUTDOOR_FADE_MS }),
      director: () => director.debug(),
      // Headless QA: force a re-roll (optionally with a pinned random) or
      // compute the current weight table without rolling.
      reroll: (r?: number) => {
        director.reroll(ctx.env, r === undefined ? Math.random : () => r);
        return director.debug();
      },
      // Demo cycler (the settings button's brain): no args = next stop on
      // the ring; a name jumps straight there; null returns to auto.
      demo: (name?: string | null) => {
        const label = name === undefined ? demo.next() : demo.select(name);
        demoButton.sync();
        return label;
      },
      // ---- per-effect toggles (the games-ui agent builds the Settings
      // switches on these; see ambient/README.md "Toggling effects") ----
      // Every effect + its live state for rendering switches: { name, kind,
      // conflicts, on, enabled, blocked }. `blocked` = the enabled effect that
      // forbids switching this one on (grey the switch), else null.
      effects: () => toggles.effects(),
      // Flip one effect. Enabling is REFUSED (no state change) when an
      // incompatible effect is active — returns { ok, blockedBy }.
      toggle: (name: string) => {
        const r = toggles.toggle(name);
        demoButton.sync();
        return r;
      },
      setEnabled: (name: string, on: boolean) => {
        const r = toggles.setEnabled(name, on);
        demoButton.sync();
        return r;
      },
      // AUTO (director rolls) vs MANUAL (the enabled set drives). No arg reads.
      auto: (on?: boolean) => {
        if (on !== undefined) toggles.setAuto(on);
        demoButton.sync();
        return toggles.getMode();
      },
      // Can two effects run together? (symmetric)
      compatible: (a: string, b: string) => toggles.compatible(a, b),
      // Bird DENSITY ratio (0.1×–10× of today's amount): no arg reads, a number
      // writes (clamped + persisted). Read by BOTH bird flocks; driven by the
      // games-ui Settings slider. Lives outside the director so it survives
      // re-rolls and effect toggles. Returns the stored value.
      birdDensity: (v?: number) => (v === undefined ? birdDensity() : setBirdDensity(v)),
      weights: (envOverride?: Partial<AmbientEnv>) => {
        const env = { ...ctx.env, ...envOverride };
        const out: Record<string, number> = {};
        for (const f of features) if (f.weight) out[f.name] = f.weight(env);
        return out;
      },
    };
  };
  attach();
}
