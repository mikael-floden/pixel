import Phaser from "phaser";
import { AmbientCtx, AmbientEnv, AmbientFeature, defaultEnv } from "./types";
import { sampleEnv } from "./env";
import { Director } from "./director";
import { Demo } from "./demo";
import { DemoButton } from "./hudbutton";

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
    };
    const director = new Director(features);
    const demo = new Demo(features, director);
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
    const onUpdate = (_time: number, dt: number) => {
      const cam = scene.cameras?.main;
      if (!cam) return;
      envAge += dt;
      if (envAge >= ENV_SAMPLE_MS) {
        envAge = 0;
        ctx.env = sampleEnv(ctx.env);
        safe(() => director.tick(ctx.env));
        // The HudBar rebuilds on re-joins; keep the demo button alive/fresh.
        safe(() => demoButton.ensure());
      }
      ctx.view = cam.worldView;
      ctx.zoom = cam.zoom;
      if (!inited) {
        inited = true;
        for (const f of features) safe(() => f.init(ctx));
      }
      for (const f of features) safe(() => f.update(ctx, dt));
    };
    scene.events.on(Phaser.Scenes.Events.UPDATE, onUpdate);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      scene.events.off(Phaser.Scenes.Events.UPDATE, onUpdate);
      for (const f of features) safe(() => f.dispose());
    });
    // QA probe surface, mirroring the game's __ml idiom.
    (window as unknown as { __mlAmbient?: unknown }).__mlAmbient = {
      list: () => features.map((f) => f.name),
      debug: (name: string) => features.find((f) => f.name === name)?.debug() ?? null,
      env: () => ({ ...ctx.env }),
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
