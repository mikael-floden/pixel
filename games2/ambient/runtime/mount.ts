import Phaser from "phaser";
import { AmbientCtx, AmbientEnv, AmbientFeature, defaultEnv } from "./types";
import { sampleEnv } from "./env";
import { Director } from "./director";
import { Toggles } from "./toggles";
import { Demo } from "./demo";
import { DemoButton } from "./hudbutton";
import { birdDensity, setBirdDensity } from "./density";
import { OUTDOOR_FADE_MS, OutdoorGain, readIndoor } from "./outdoor";
import { ZoneField, levelFromProbe, pickFromProbe, sourceFromProbe } from "./zonefield";
import { packRef, REF_SCALE } from "./zonefloor";
import { ZoneLines } from "./zonelines";
import { CLOUD_OF, MIST_EFFECT, forcedGloom, setGloomField } from "../weather/gloom";

const SCENE_KEY = "world"; // WorldScene's key
const ENV_SAMPLE_MS = 100; // mood changes are seconds-long fades; 10 Hz is plenty
/** THE MIST MASK (unit 2 of the boundaries): the zone field's mist weight
 *  rasterised over the view plus a margin each env tick and handed to the
 *  game's mist pass (`__ml.mistMask`), which interpolates it smoothly and
 *  multiplies it into the ALPHA the pass paints — a FADE, never a reshape of
 *  the fog (see MIST_FRAG's last lines for what reshaping cost).
 *  64 x 40 over a view and a quarter is about half a cell per sample, and the
 *  ramp it has to draw is three cells wide; the margin covers the camera's
 *  travel between ticks and the pass's render span, and leaves room for the
 *  world-anchoring snap below. 2560 memo reads a tick, ten times a second.
 *  (32 x 20 was a cell per sample and his mist came out BLOCKY.) */
const MASK_COLS = 64;
const MASK_ROWS = 40;
const MASK_MARGIN = 0.25;
/** The mask lattice (see maskRect): a step in whole world units, kept while
 *  it covers and is not this much finer than needed, grown with headroom. */
const MASK_STEP_Q = 2;
const MASK_STEP_SLACK = 1.4;
const MASK_STEP_GROW = 1.15;

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
    /* THE ZONE FIELD, built before the ctx it is a member of — see zonefield.ts. */
    const zone = new ZoneField(sourceFromProbe(), pickFromProbe(), undefined, levelFromProbe());
    const ctx: AmbientCtx = {
      scene,
      env: defaultEnv(),
      view: new Phaser.Geom.Rectangle(0, 0, 1, 1),
      zone,
      zoom: 1,
      outdoor: 1,
    };
    const outdoor = new OutdoorGain();
    /* THE ZONE OVERLAY (Settings/dev "ambient zones"): the ambient polygons in
     * the world, in the zone-borders recipe he approved — see zonelines.ts. */
    const zoneLines = new ZoneLines(scene, zone);
    const director = new Director(features);
    const toggles = new Toggles(features, director);
    const demo = new Demo(features, toggles);
    const demoButton = new DemoButton(demo);
    let inited = false;
    let envAge = ENV_SAMPLE_MS; // sample on the first tick
    /* THE GLOOM READS THE FIELD (weather/gloom.ts): each weather's weight at
     * my feet and the mist's cover of the view, published here every env tick
     * with the mist's mask; null where zones do not rule, so the room's sky
     * grades as it always did. A forced mist covers the view: no mask. */
    const ml = () => (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const myFeet = (): { x: number; y: number } => {
      const me = (ml()?.myScreen as undefined | (() => { sx: number; sy: number; zoom: number } | null))?.();
      if (!me || !(me.zoom > 0)) return { x: ctx.view.centerX, y: ctx.view.centerY };
      return { x: ctx.view.x + me.sx / me.zoom, y: ctx.view.y + me.sy / me.zoom };
    };
    const mistMask = (m: unknown) => (ml()?.mistMask as undefined | ((m: unknown) => unknown))?.(m);
    // held, not rebuilt: the forced path runs at the env tick's cadence
    const forcedMask = new Uint8Array(MASK_COLS * MASK_ROWS);
    const forcedRef = new Uint8Array(MASK_COLS * MASK_ROWS);
    const maskRef = new Uint8Array(MASK_COLS * MASK_ROWS);
    /* THE MASK'S RECT, ANCHORED TO THE WORLD AND NOT TO THE CAMERA. The
     * samples are half a cell apart and the field under them is a STEP
     * function (a cell is in the zone or it is not, blurred over 3x3 — so it
     * moves in ninths). Hung off the view, every sample slid as I walked and
     * crossed cell lines constantly, so the fade rippled by a ninth all over
     * the screen at walking pace. Snapping the origin to a whole sample step
     * pins every sample to a fixed world point: the fade then holds still
     * while the camera moves through it, which is what a fog bank does. The
     * 25% margin means the snap can never uncover the view. */
    /* THE LATTICE IS ZOOM-PROOF (games-perf 2026-09-23). The camera zoom
     * BREATHES with speed (updateChaseCam eases it every frame), and a step
     * of exactly view/64 changed with it — so the field's raster memo, keyed
     * on the exact step, was never reused while running: all 2,560 samples
     * recomputed ten times a second, `_gloom:raster` 2.5-7.8 ms a tick on his
     * phone (the split proved it: field 0.5, mask upload 0.2). The step is
     * now a whole number of world units and is KEPT while it still covers
     * the padded view and is not MASK_STEP_SLACK times finer than needed; a
     * new step overshoots by MASK_STEP_GROW so a zoom-out crosses two or
     * three lattices, not six. The lattice rect is the padded view widened
     * to cols x step, the extra split to both sides, so the view is always
     * inside it (the margin is 0.25 of the view, the step ~0.03). The mask
     * is a little coarser than the ideal (16 wu at rest, 22 running, against
     * 12.7 and 18.6) — the feather is a cell, 32 wu, so it still resolves. */
    const lat = { stepX: 0, stepY: 0 };
    const latticeStep = (have: number, need: number): number => {
      if (have >= need && have <= need * MASK_STEP_SLACK) return have;
      return Math.ceil((need * MASK_STEP_GROW) / MASK_STEP_Q) * MASK_STEP_Q;
    };
    const maskRect = () => {
      const width = ctx.view.width * (1 + 2 * MASK_MARGIN);
      const height = ctx.view.height * (1 + 2 * MASK_MARGIN);
      lat.stepX = latticeStep(lat.stepX, width / MASK_COLS);
      lat.stepY = latticeStep(lat.stepY, height / MASK_ROWS);
      const w = lat.stepX * MASK_COLS;
      const h = lat.stepY * MASK_ROWS;
      const x0 = ctx.view.x - ctx.view.width * MASK_MARGIN - (w - width) / 2;
      const y0 = ctx.view.y - ctx.view.height * MASK_MARGIN - (h - height) / 2;
      return {
        x: Math.floor(x0 / lat.stepX) * lat.stepX,
        y: Math.floor(y0 / lat.stepY) * lat.stepY,
        width: w,
        height: h,
      };
    };
    /* THE TICK'S PARTS ARE BILLED (games-perf, his 21:20 run: `_gloom` was
     * 3.5-9.7 ms a tick and SCALED WITH THE FRAME TIME — 3.5 at 43 fps, 9.7
     * at 21 — which is what a GPU sync looks like, not a raster). `_gloom:
     * field` is the weights at my feet and the coverage, `_gloom:raster` the
     * mask's walk, `_gloom:mask` the hand-off to the night shader (its
     * texture upload). The next run says which one it is. */
    const publishGloom = () => {
      if (!zone.ruled) { setGloomField(null); mistMask(null); return; }
      const g0 = performance.now();
      const feet = myFeet();
      const at: Record<string, number> = {};
      for (const n of Object.keys(CLOUD_OF)) at[n] = zone.weightAt(n, feet.x, feet.y);
      const cov = zone.coverage(MIST_EFFECT, ctx.view);
      setGloomField({ at, mistInView: cov.max });
      const g1 = performance.now();
      bill("_gloom:field", g1 - g0, g0);
      if (forcedGloom().includes(MIST_EFFECT)) {
        /* A FORCED ROW IS A TEST OF THE EFFECT ITSELF, so it covers the whole
         * view — and its ground is THE GROUND I AM STANDING ON. It used to
         * publish no mask at all, which also meant no floor, so switching Mist
         * on in Settings anywhere above sea level showed the same nothing the
         * zones did. A full mask multiplies the alpha by 1 exactly as no mask
         * did; the only thing that changes is that the fog now pools on my
         * own level. */
        const rect = maskRect();
        forcedMask.fill(255);
        forcedRef.fill(packRef(zone.cellAt(feet.x, feet.y)?.lvl ?? 0));
        const g2 = performance.now();
        mistMask({ x: rect.x, y: rect.y, w: rect.width, h: rect.height, cols: MASK_COLS, rows: MASK_ROWS, data: forcedMask, ref: forcedRef });
        bill("_gloom:mask", performance.now() - g2, g2);
        return;
      }
      const rect = maskRect();
      // the floor rides along in the mask's own walk (runtime/zonefloor.ts)
      const data = zone.raster(MIST_EFFECT, rect, MASK_COLS, MASK_ROWS, maskRef);
      const g2 = performance.now();
      bill("_gloom:raster", g2 - g1, g1);
      mistMask({ x: rect.x, y: rect.y, w: rect.width, h: rect.height, cols: MASK_COLS, rows: MASK_ROWS, data, ref: maskRef });
      bill("_gloom:mask", performance.now() - g2, g2);
    };
    const safe = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        // Ambient must never break the game — warn and move on.
        console.warn("[ambient]", e);
      }
    };
    let lastTick = 0;
    const cost = new Map<string, { sum: number; n: number; peak: number; t0: number; t1: number }>();
    /* A bill carries WHEN as well as how long (games-perf, his ask 2026-09-23):
     * the peak keeps its own start and end, and every bill is a mark on the
     * beacon's frame timeline (`window.__mlPerfMark`, absent = no beacon). */
    const mark = (window as unknown as { __mlPerfMark?: (name: string, t0: number, t1: number) => void }).__mlPerfMark;
    const bill = (name: string, ms: number, t0: number) => {
      const c = cost.get(name) ?? { sum: 0, n: 0, peak: 0, t0: 0, t1: 0 };
      c.sum += ms;
      c.n++;
      if (ms > c.peak) {
        c.peak = ms;
        c.t0 = t0;
        c.t1 = t0 + ms;
      }
      cost.set(name, c);
      const m = mark ?? (window as unknown as { __mlPerfMark?: (name: string, t0: number, t1: number) => void }).__mlPerfMark;
      if (m) m(name, t0, t0 + ms);
    };
    /* THE TICK'S TWO HALVES NEVER SHARE A FRAME (games-perf 2026-09-23, his
     * run: the mount's UPDATE listener was 8.5-17.9 ms a frame and the
     * dominant section of 1,705 long frames; the effects' own meter held
     * ~5.5 of it and the env tick the rest). The env sample, the field's
     * refresh and the gloom's raster run on the tick's frame; the director's
     * per-episode coverage waits for the next one. */
    let directorDue = false;
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
        const t0 = performance.now();
        ctx.env = sampleEnv(ctx.env, cam.worldView.centerX, cam.worldView.centerY);
        // The zone field re-reads the table on the same tick: a zone that
        // re-rolled drops its memos here, ten times a second, never per frame.
        safe(() => { zone.refresh(); });
        const t1 = performance.now();
        safe(publishGloom);
        const t2 = performance.now();
        // The mount's own parts ride the cost meter as `_` rows — mean per
        // OCCURRENCE (a tick here), so `cost()` answers where the tick goes.
        bill("_env", t1 - t0, t0);
        bill("_gloom", t2 - t1, t1);
        directorDue = true;
      } else if (directorDue) {
        directorDue = false;
        const t0 = performance.now();
        safe(() => director.tick(ctx.env, ctx));
        // The HudBar rebuilds on re-joins; keep the demo button alive/fresh.
        safe(() => demoButton.ensure());
        bill("_director", performance.now() - t0, t0);
      }
      ctx.view = cam.worldView;
      ctx.zoom = cam.zoom;
      const tf = performance.now();
      // EVERY FRAME, not on the 10 Hz env sample: this must stop the moment the
      // player is inside, and a sampled read would keep weather falling through
      // the roof for up to 100 ms (~6 frames) after they stepped in.
      ctx.env.indoor = readIndoor();
      ctx.outdoor = outdoor.step(dt, ctx.env.indoor);
      safe(() => zoneLines.step(ctx.view, ctx.zoom));
      bill("_frame", performance.now() - tf, tf); // the per-frame remainder: the indoor read, the gain, the overlay
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
        bill(f.name, performance.now() - t0, t0);
      }
    };
    scene.events.on(Phaser.Scenes.Events.UPDATE, onUpdate);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      scene.events.off(Phaser.Scenes.Events.UPDATE, onUpdate);
      for (const f of features) safe(() => f.dispose());
      zoneLines.dispose();
      setGloomField(null);
      safe(() => { mistMask(null); });
    });
    // QA probe surface, mirroring the game's __ml idiom.
    (window as unknown as { __mlAmbient?: unknown }).__mlAmbient = {
      list: () => features.map((f) => f.name),
      /** THE ZONE FIELD, for gates: no args = its state; a name = its
       *  coverage of the view; a name and a drawn point = the weight there. */
      zone: (name?: string, x?: number, y?: number) => {
        if (name === undefined) return zone.debug();
        if (x === undefined || y === undefined) return zone.coverage(name, ctx.view);
        return zone.weightAt(name, x, y);
      },
      /** The field in CELL space, for gates: the blurred presence of `name`
       *  at a cell — the geometry itself, with no picker between. */
      zoneCell: (name: string, col: number, row: number, lvl = 0) => ({
        on: zone.on(name, col, row, lvl),
        blurred: zone.blurred(name, col, row, lvl),
        active: [...zone.activeAt(col, row, lvl)].sort(),
      }),
      /** The mist mask as the mount last published it (unit 2): the rect it
       *  covers, its size and a few bytes, for gates. */
      mistMask: () => {
        if (!zone.ruled) return null;
        const rect = maskRect();
        // ONE walk, like the live path: a second raster call would overwrite
        // the overlap memo the tick depends on, from a probe.
        const forced = forcedGloom().includes(MIST_EFFECT);
        const probeRef = new Uint8Array(MASK_COLS * MASK_ROWS);
        const data = zone.raster(MIST_EFFECT, rect, MASK_COLS, MASK_ROWS, probeRef);
        if (forced) probeRef.fill(packRef(((f) => zone.cellAt(f.x, f.y))(myFeet())?.lvl ?? 0));
        let refMax = 0;
        for (const v of probeRef) if (v > refMax) refMax = v;
        let on = 0;
        for (const v of data) if (v > 0) on++;
        return { ...rect, cols: MASK_COLS, rows: MASK_ROWS, on, refMax: +(refMax / REF_SCALE).toFixed(2), forced };
      },
      /** Settings/dev "ambient zones": read with no argument, set with a
       *  boolean, "toggle" flips. */
      zoneLines: (on?: boolean | "toggle") => zoneLines.set(on === "toggle" ? !zoneLines.on : on),
      /** Per-feature update cost since the last reset: mean and worst ms of a
       * frame. `cost(true)` reads and resets, which is how an A/B is taken. */
      cost: (reset = false) => {
        const out: Record<string, { ms: number; peak: number; frames: number; t0: number; t1: number }> = {};
        for (const [k, c] of cost)
          out[k] = { ms: +(c.sum / Math.max(1, c.n)).toFixed(4), peak: +c.peak.toFixed(3), frames: c.n, t0: +c.t0.toFixed(1), t1: +c.t1.toFixed(1) };
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
      // ZONE CONTROL: server-driven per zone (true) or the free client
      // lottery (false). No arg reads.
      zoneControl: (on?: boolean) => toggles.zoneControl(on),
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
