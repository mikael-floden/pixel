import Phaser from "phaser";
import { AmbientCtx } from "../runtime/types";
import { waterAt } from "../runtime/water";
import { setPrecipShown } from "../runtime/precipstate";
import { gameAudio } from "../../composer/index";
import {
  Cfg, DEPTH, LEAF_TINTS, MARGIN, MAX_DROPS, MAX_SPLASH, SNOW_FADE, SNOW_FALLING,
  SNOW_MELTING, SNOW_RESTING, SPLASH_DEPTH, SPLASH_LIFE, WISP_ALPHA, WISP_EVERY,
  FALL_RAMP_PX, LEAF_REREAD_PX, easeShown, fallWeight, gustAt, makeRand, placeFall, snowLanding,
  snowTwinkle, splashAt, streakRot, targetCount,
} from "./precip";

/* THE SHEET — the Phaser half of weather. ONE PER WEATHER ROW since
 * 2026-09-20: weather is per ZONE, and a view can hold two weathers at once
 * (17 neighbouring zone pairs carry different precipitation signatures —
 * snow on the eastern summit beside storm on the western; measured on
 * maps2's tables), so each row draws its own sheet where ITS weight is on.
 * A row with nothing in view steps an empty pool and costs nothing.
 *
 * THE BOUNDARY (maintainer 2026-09-20: "it should already look like it's
 * raining on the other side and look as if it's not raining if you are
 * inside and looking out"): the sheet is a SCREEN-SPACE CURTAIN, so a drop is
 * drawn only where the zone field under it is on. The count is the full
 * view's and every drop is placed uniformly over the whole sheet (precip.ts
 * placeFall reads the field at its start and its landing and finds where the
 * fall crosses the line); it draws at cfg.alpha x fallWeight, a smooth step
 * at the crossing — the sheet thins to nothing across the ramp and never
 * cuts, and the density inside a zone is exactly a full sheet's. Leaves
 * stream sideways and re-read the field by distance as they go.
 *
 * Ported from client/src/weatherfx.ts unchanged in behaviour. The one thing
 * that DID change: the splash / snow-melt probe. It used to be the game's own
 * `isWaterAtScreen`, which answers TRUE on LAVA (the crabs-on-a-lava-shore bug,
 * 2026-09-14) — so rain popped water ripples and snow "melted on water" over
 * molten rock. It now asks ambient's harm-aware `runtime/water.ts`.
 */

interface Drop {
  img: Phaser.GameObjects.Image;
  x: number; y: number; vy: number;
  vxJit: number;   // per-drop horizontal jitter
  phase: number;   // snow/leaf sway phase
  landY: number;   // world-y this one lands at (0 = uninit)
  state: number;   // snow: falling / resting / melting
  restT: number;
  meltDur: number;
  wisp: boolean;   // Windy: a motion-line, not a leaf
  placed: boolean; // false = (re)start this drop on the next step
  w: number;       // the zone weight where this drop LANDS
  w0: number;      // the weight where it started falling (precip.ts fallWeight)
  pc: number;      // fall progress where it crosses the line, and the fade's half-width in progress
  half: number;
  y0: number;      // where the fall started (progress = (y - y0) / (landY - y0))
  xl: number;      // the predicted landing column
  wd: number;      // the weight it was last DRAWN at (leaves: the field where they are)
  rx: number;      // leaf: x at its last field read (re-read every LEAF_REREAD_PX)
}

interface Splash {
  img: Phaser.GameObjects.Image;
  age: number; life: number; grow: number; active: boolean;
  w: number;       // the drop's weight, so a ripple at the edge is as faint as its drop
}

type WeightAt = (x: number, y: number) => number;
const ONE: WeightAt = () => 1;

export class PrecipLayer {
  private pool: Drop[] = [];
  private splashes: Splash[] = [];
  private cfg: Cfg | null = null;
  private shown = 0;
  private nextFlash = 0;
  /** The outdoor gain stood above 0.5 last frame (see the lightning clock). */
  private wasOut = true;
  private flashes = 0;
  private gain = 1;
  private target = 0;
  private lastName = "";
  private rand = makeRand(1);
  private made = false;

  /** Textures are one-pixel primitives generated once per scene. */
  private ensureTextures(scene: Phaser.Scene) {
    if (this.made && scene.textures.exists("fx-rain")) return;
    this.made = true;
    const mk = (key: string, w: number, h: number, draw: (g: Phaser.GameObjects.Graphics) => void) => {
      if (scene.textures.exists(key)) return;
      const g = scene.add.graphics();
      draw(g);
      g.generateTexture(key, w, h);
      g.destroy();
    };
    mk("fx-rain", 1, 7, (g) => g.fillStyle(0xbcd2e8, 1).fillRect(0, 0, 1, 7));
    mk("fx-snow", 2, 2, (g) => g.fillStyle(0xf4f8ff, 1).fillRect(0, 0, 2, 2));
    // anime wind motion-line: a long faint streak sweeping with the gust
    mk("fx-wisp", 22, 1, (g) => g.fillStyle(0xffffff, 1).fillRect(0, 0, 22, 1));
    mk("fx-leaf", 2, 2, (g) => g.fillStyle(0xffffff, 1).fillRect(0, 0, 2, 2));
    // a thin ripple ring + a faint impact dot, tinted cool at use
    mk("fx-splash", 11, 11, (g) => {
      g.lineStyle(1.4, 0xffffff, 1);
      g.strokeCircle(5.5, 5.5, 4.5);
      g.fillStyle(0xffffff, 0.9).fillCircle(5.5, 5.5, 0.9);
    });
  }

  /** Which weather to draw, and how strongly. `null` fades the sheet out. */
  setWeather(cfg: Cfg | null, gain: number) {
    this.gain = gain;
    if (cfg?.name === this.cfg?.name) return;
    this.cfg = cfg;
    if (cfg) for (let i = 0; i < this.pool.length; i++) this.dress(this.pool[i], i);
  }

  /** Texture + tint a pool slot for the current weather. */
  private dress(d: Drop, i: number) {
    const cfg = this.cfg;
    if (!cfg) return;
    d.wisp = cfg.kind === "leaf" && i % WISP_EVERY === 0;
    const key = cfg.kind === "snow" ? "fx-snow" : d.wisp ? "fx-wisp" : cfg.kind === "leaf" ? "fx-leaf" : "fx-rain";
    d.img.setTexture(key);
    if (cfg.kind === "leaf" && !d.wisp) d.img.setTint(LEAF_TINTS[Math.floor(d.vxJit * 3) % 3]);
    else d.img.setTint(0xffffff);
  }

  private publish(drawn: number) {
    if (this.lastName) setPrecipShown(this.lastName, drawn);
  }

  private spawnSplash(scene: Phaser.Scene, x: number, y: number, w: number) {
    let s = this.splashes.find((p) => !p.active);
    if (!s) {
      if (this.splashes.length >= MAX_SPLASH) return;
      const img = scene.add.image(0, 0, "fx-splash").setDepth(SPLASH_DEPTH).setTint(0xcfe4ff).setVisible(false);
      s = { img, age: 0, life: 0, grow: 1, active: false, w: 1 };
      this.splashes.push(s);
    }
    s.w = w;
    s.age = 0;
    s.life = SPLASH_LIFE[0] + this.rand() * (SPLASH_LIFE[1] - SPLASH_LIFE[0]);
    s.grow = 1.3 + this.rand() * 1.3;
    s.active = true;
    s.img.setPosition(x, y).setVisible(true);
  }

  /** Ripples always animate to completion, even after the rain stops. */
  private stepSplashes(dtMs: number) {
    for (const s of this.splashes) {
      if (!s.active) continue;
      s.age += dtMs;
      const p = s.age / s.life;
      if (p >= 1) { s.active = false; s.img.setVisible(false); continue; }
      const v = splashAt(p, s.grow);
      s.img.setScale(v.sx, v.sy).setAlpha(v.a * this.gain * s.w);
    }
  }

  private recycleSnow(d: Drop, top: number, left: number, span: number, bottom: number, vxBase: number, weightAt: WeightAt) {
    const cfg = this.cfg!;
    d.state = SNOW_FALLING;
    d.restT = 0;
    d.y = top - this.rand() * 30;
    d.vy = cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) * this.rand();
    d.landY = top + (0.5 + 0.45 * this.rand()) * (bottom - top);
    this.placeFall(d, left, span, vxBase, 30, weightAt);
  }

  /** A rain drop starts over again at the top of the sheet. */
  private startRain(d: Drop, top: number, left: number, span: number, bottom: number, vxBase: number, weightAt: WeightAt) {
    const cfg = this.cfg!;
    d.y = top - this.rand() * 30;
    d.vy = cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) * this.rand();
    d.landY = top + (0.45 + 0.5 * this.rand()) * (bottom - top);
    this.placeFall(d, left, span, vxBase, 40, weightAt);
  }

  /** A leaf starts anywhere on the sheet, at the field's weight there. */
  private placeLeaf(d: Drop, x: number, y: number, weightAt: WeightAt) {
    d.x = x; d.y = y; d.rx = x;
    d.w = d.w0 = d.wd = weightAt(x, y);
    d.placed = true;
  }

  /** Place a falling drop (y, vy and landY set): uniform over the sheet, the
   *  landing where the wind's drift over the fall takes it, the field read at
   *  both ends and the crossing between them found (precip.ts placeFall). The
   *  sway and the gust's change during one fall are not predicted (a storm's
   *  is ~30 px on average), which is why a splash reads the field where the
   *  drop HIT. */
  private placeFall(d: Drop, left: number, span: number, vxBase: number, jit: number, weightAt: WeightAt) {
    const vx = vxBase + (d.vxJit - 0.5) * jit;
    const secs = Math.max(0, (d.landY - d.y) / Math.max(1, d.vy));
    d.y0 = d.y;
    d.placed = true;
    if (weightAt === ONE) {
      // no field: full weight everywhere, no reads
      d.x = left + this.rand() * span; d.xl = d.x + vx * secs;
      d.w = d.w0 = 1; d.pc = 0.5; d.half = 1;
      return;
    }
    const p = placeFall(this.rand, left, span, d.y, d.landY, vx * secs, weightAt);
    d.x = p.x0; d.xl = p.xl;
    d.w = p.w; d.w0 = p.w0; d.pc = p.pc;
    d.half = FALL_RAMP_PX / Math.max(1, Math.hypot(p.xl - p.x0, d.landY - d.y));
  }

  /** Jump to the target density (a join, or headless QA — the ease assumes a
   *  live frame loop). */
  snap(ctx: AmbientCtx) {
    this.shown = targetCount(this.cfg, ctx.view.width, ctx.view.height);
  }

  info() {
    let rest = 0;
    if (this.cfg?.kind === "snow") for (const d of this.pool) if (d.state !== SNOW_FALLING) rest++;
    /* THE WEIGHTS OF WHAT IS DRAWN, for the boundary gate: none may be drawn
     * at 0, and a sample of positions says which side of the line they fall. */
    let wMin = 1, wSum = 0, wN = 0, zero = 0;
    const leaf = this.cfg?.kind === "leaf";
    // (x, y, w): where the drop is DRAWN and at what weight; (lx, ly, lw): where it lands, at the landing weight
    const sample: { x: number; y: number; w: number; lx: number; ly: number; lw: number }[] = [];
    for (const d of this.pool) {
      if (d.placed && !d.img.visible) zero++;
      if (!d.img.visible) continue;
      wN++; wSum += d.wd; if (d.wd < wMin) wMin = d.wd;
      if (sample.length < 60)
        sample.push({
          x: Math.round(d.x), y: Math.round(d.y), w: +d.wd.toFixed(3),
          lx: Math.round(leaf ? d.x : d.xl), ly: Math.round(leaf ? d.y : d.landY), lw: +d.w.toFixed(3),
        });
    }
    return {
      kind: this.cfg?.name ?? null,
      idx: this.cfg?.idx ?? 0,
      shown: Math.round(this.shown),
      drawn: this.pool.filter((d) => d.img.visible).length,
      splashes: this.splashes.filter((s) => s.active).length,
      flashes: this.flashes,
      rest,
      gain: +this.gain.toFixed(3),
      target: Math.round(this.target),
      w: { min: wN ? +wMin.toFixed(3) : 0, mean: wN ? +(wSum / wN).toFixed(3) : 0, hidden: zero },
      sample,
    };
  }

  /** `field` is the zone weight at an iso point for THIS weather, or null
   *  for "1 everywhere": the row passes null where zones do not rule and when
   *  a player forced it on in Settings (a forced snow falls over the whole
   *  view, not only inside the snow zones). */
  step(ctx: AmbientCtx, dtMs: number, field: ((x: number, y: number) => number) | null = null) {
    const scene = ctx.scene;
    this.ensureTextures(scene);
    const dt = Math.min(dtMs, 100) / 1000;
    this.stepSplashes(Math.min(dtMs, 100));

    const cfg = this.cfg;
    const wv = ctx.view;
    const target = this.gain > 0.01 ? targetCount(cfg, wv.width, wv.height) : 0;
    this.target = target;
    this.shown = easeShown(this.shown, target, Math.min(dtMs, 100));
    if (cfg) this.lastName = cfg.name;
    if (this.shown < 1 && !cfg) { this.publish(0); return; }

    // the zone field at a point, for THIS weather: 1 everywhere it does not rule
    const weightAt = field ?? ONE;

    const n = Math.min(Math.round(this.shown), MAX_DROPS);
    while (this.pool.length < n) {
      const img = scene.add.image(0, 0, "fx-rain").setDepth(DEPTH).setVisible(false);
      const d: Drop = {
        img,
        x: 0, y: 0,
        vy: 0, vxJit: this.rand(), phase: this.rand() * Math.PI * 2,
        landY: 0, state: SNOW_FALLING, restT: 0, meltDur: SNOW_FADE, wisp: false,
        placed: false, w: 0, w0: 0, pc: 0.5, half: 1, y0: 0, xl: 0, wd: 0, rx: 0,
      };
      this.dress(d, this.pool.length);
      this.pool.push(d);
    }
    if (!cfg) { for (const d of this.pool) d.img.setVisible(false); this.publish(0); return; }

    const t = scene.time.now / 1000;
    const gust = gustAt(t, cfg.gust);
    const vxBase = cfg.vx * gust;
    const rot = streakRot(cfg, vxBase);
    const left = wv.x - MARGIN;
    const right = wv.x + wv.width + MARGIN;
    const top = wv.y - MARGIN;
    const bottom = wv.y + wv.height + MARGIN;
    const span = right - left;
    let drawn = 0;

    for (let i = 0; i < this.pool.length; i++) {
      const d = this.pool[i];
      if (i >= n) { d.img.setVisible(false); continue; }
      if (d.vy === 0) d.vy = cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) * d.vxJit;
      // NEW, OR OFF THE SHEET: start it over. A leaf lands anywhere on the
      // sheet (the wind streams it); a faller starts at the top.
      if (!d.placed) {
        if (cfg.kind === "leaf") this.placeLeaf(d, left + this.rand() * span, top + this.rand() * (bottom - top), weightAt);
        else if (cfg.kind === "snow") this.recycleSnow(d, top, left, span, bottom, vxBase, weightAt);
        else this.startRain(d, top, left, span, bottom, vxBase, weightAt);
      }
      // a leaf streams across the line: it re-reads the field by DISTANCE, at any frame rate
      if (cfg.kind === "leaf" && Math.abs(d.x - d.rx) >= LEAF_REREAD_PX) { d.w = weightAt(d.x, d.y); d.rx = d.x; }
      let vx = vxBase + (d.vxJit - 0.5) * (cfg.kind === "snow" ? 30 : 40);
      if (cfg.kind === "snow") vx += Math.sin(t * 1.1 + d.phase) * 22;
      let snowAlphaMul = 1;

      if (cfg.kind === "snow") {
        // Snow HITS THE GROUND: each flake sways down to its own landing
        // height, SETTLES there for a few seconds, then melts and recycles.
        if (d.state === SNOW_RESTING) {
          d.restT -= dtMs;
          if (d.restT <= 0) { d.state = SNOW_MELTING; d.meltDur = SNOW_FADE; d.restT = d.meltDur; }
        } else if (d.state === SNOW_MELTING) {
          d.restT -= dtMs;
          snowAlphaMul = Math.max(0, d.restT / d.meltDur);
          if (d.restT <= 0) this.recycleSnow(d, top, left, span, bottom, vxBase, weightAt);
        } else {
          d.x += vx * dt;
          d.y += d.vy * dt;
          // off the sheet sideways: a wrap would carry this flake's weights over
          // ground the field never read — start it over instead
          if (d.x < left || d.x > right) { d.placed = false; d.img.setVisible(false); continue; }
          if (d.y >= d.landY) {
            d.y = d.landY;
            const land = snowLanding(waterAt(d.x, d.landY), this.rand);
            d.state = land.state;
            d.restT = land.dur;
            if (land.state === SNOW_MELTING) d.meltDur = land.dur;
          }
          snowAlphaMul = snowTwinkle(t, d.phase);
        }
        if (d.y < top - 200 || d.y > bottom + 200 || d.x < left - 200 || d.x > right + 200)
          this.recycleSnow(d, top, left, span, bottom, vxBase, weightAt);
      } else {
        let vyEff = d.vy;
        if (cfg.kind === "leaf") {
          if (d.wisp) {
            vx = vxBase * 2.3;
            vyEff = Math.sin(t * 1.4 + d.phase) * 12;
          } else {
            // leaves STREAM: a deep surge on the shared gust + a curling
            // swirl, so paths arc instead of gliding straight
            vx *= 0.5 + 0.65 * Math.sin(t * 1.3 + d.phase);
            vx += Math.cos(t * 2.6 + d.phase * 3.0) * 45;
            vyEff = d.vy * 0.4 + Math.sin(t * 2.1 + d.phase * 2.0) * 48;
          }
        }
        d.x += vx * dt;
        d.y += (cfg.kind === "leaf" ? vyEff : d.vy) * dt;
        if (cfg.splash) {
          if (d.y >= d.landY) {
            // the ripple is where the drop HIT, at the field's weight there
            this.spawnSplash(scene, d.x, d.landY, weightAt(d.x, d.landY));
            this.startRain(d, top, left, span, bottom, vxBase, weightAt);
          }
        } else if (d.y > bottom) {
          // a leaf (the only non-splash faller) re-enters from the top
          d.vy = cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) * this.rand();
          this.placeLeaf(d, left + this.rand() * span, top - this.rand() * 30, weightAt);
        }
        if (cfg.kind === "leaf") {
          // leaves wrap sideways and read the field where they land
          if (d.x < left) this.placeLeaf(d, d.x + span, top + this.rand() * (bottom - top), weightAt);
          else if (d.x > right) this.placeLeaf(d, d.x - span, d.y, weightAt);
        } else if (d.x < left || d.x > right) {
          // a rain drop off the sheet sideways: a wrap would carry its weights
          // over ground the field never read — start it over instead
          d.placed = false; d.img.setVisible(false); continue;
        }
        // camera jumped (teleport/respawn): start over in the new view next step
        if (d.y < top - 200 || d.y > bottom + 200) { d.placed = false; d.img.setVisible(false); continue; }
      }

      const wispA = d.wisp ? WISP_ALPHA : 1;
      const twinkle = cfg.kind === "snow" ? snowAlphaMul
        : cfg.kind === "leaf" && !d.wisp ? snowTwinkle(t, d.phase) : 1;
      const big = cfg.kind === "leaf" && !d.wisp;
      // THE WEIGHT IT DRAWS AT: a leaf's is the field where it is; a faller's
      // steps from its start weight to its landing weight where its fall
      // crosses the line (over ground outside the zone it is not drawn)
      d.wd = cfg.kind === "leaf" ? d.w
        : fallWeight(d.w0, d.w, d.pc, d.half, d.landY > d.y0 ? (d.y - d.y0) / (d.landY - d.y0) : 1);
      if (d.wd < 0.02) { d.img.setVisible(false); continue; }
      drawn++;
      d.img
        .setVisible(true)
        .setPosition(d.x, d.y)
        .setAlpha(cfg.alpha * wispA * twinkle * this.gain * d.wd)
        .setScale(big ? 1 + d.vxJit : 1, big ? (1 + d.vxJit) * cfg.scaleY : cfg.scaleY)
        .setRotation(rot);
    }
    // publish the DRAWN density for env.rain (runtime/precipstate.ts): what
    // is on screen, not the pool — a sliver of a zone in view is a few drops
    this.publish(drawn);

    // Storm lightning: camera flash, occasionally double-striking, with the
    // composer's thunder roll in sync.
    // NEVER ON THE FRAME THE GAIN COMES BACK (maintainer 2026-09-18, walking
    // out of a house: "the indoor to outdoor fade still ends with a flash").
    // This clock ran on while he stood inside, so the first frame the outdoor
    // gain crossed 0.5 after an exit fired a strike — on that exact frame,
    // every time. A gain that has just risen reschedules instead.
    const gainUp = this.gain > 0.5;
    const justOut = gainUp && !this.wasOut;
    this.wasOut = gainUp;
    if (cfg.lightning && gainUp && (scene.time.now >= this.nextFlash || justOut)) {
      if (this.nextFlash > 0 && !justOut) {
        this.flashes++;
        const cam = scene.cameras.main;
        cam.flash(110, 255, 255, 245);
        gameAudio.thunder(1);
        if (this.rand() < 0.35) scene.time.delayedCall(160, () => cam.flash(70, 255, 255, 245));
      }
      this.nextFlash = scene.time.now + 5000 + this.rand() * 9000;
    }
  }

  dispose() {
    for (const d of this.pool) d.img.destroy();
    for (const s of this.splashes) s.img.destroy();
    this.pool = [];
    this.splashes = [];
    this.cfg = null;
    this.shown = 0;
    this.made = false;
  }
}
