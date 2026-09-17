import Phaser from "phaser";
import { AmbientCtx } from "../runtime/types";
import { waterAt } from "../runtime/water";
import { setPrecipShown } from "../runtime/precipstate";
import { gameAudio } from "../../composer/index";
import {
  Cfg, DEPTH, LEAF_TINTS, MARGIN, MAX_DROPS, MAX_SPLASH, SNOW_FADE, SNOW_FALLING,
  SNOW_MELTING, SNOW_RESTING, SPLASH_DEPTH, SPLASH_LIFE, WISP_ALPHA, WISP_EVERY,
  easeShown, gustAt, makeRand, snowLanding, snowTwinkle, splashAt, streakRot, targetCount,
} from "./precip";

/* THE POOLED SHEET — the Phaser half of weather. ONE of these exists however
 * many weather features are registered, because the world has exactly one
 * weather at a time; the features hand it a Cfg and a gain and it draws.
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
}

interface Splash {
  img: Phaser.GameObjects.Image;
  age: number; life: number; grow: number; active: boolean;
}

export class PrecipLayer {
  private pool: Drop[] = [];
  private splashes: Splash[] = [];
  private cfg: Cfg | null = null;
  private shown = 0;
  private nextFlash = 0;
  private flashes = 0;
  private gain = 1;
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

  private spawnSplash(scene: Phaser.Scene, x: number, y: number) {
    let s = this.splashes.find((p) => !p.active);
    if (!s) {
      if (this.splashes.length >= MAX_SPLASH) return;
      const img = scene.add.image(0, 0, "fx-splash").setDepth(SPLASH_DEPTH).setTint(0xcfe4ff).setVisible(false);
      s = { img, age: 0, life: 0, grow: 1, active: false };
      this.splashes.push(s);
    }
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
      s.img.setScale(v.sx, v.sy).setAlpha(v.a * this.gain);
    }
  }

  private recycleSnow(d: Drop, top: number, left: number, span: number, bottom: number) {
    const cfg = this.cfg!;
    d.state = SNOW_FALLING;
    d.restT = 0;
    d.y = top - this.rand() * 30;
    d.x = left + this.rand() * span;
    d.vy = cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) * this.rand();
    d.landY = top + (0.5 + 0.45 * this.rand()) * (bottom - top);
  }

  /** Jump to the target density (a join, or headless QA — the ease assumes a
   *  live frame loop). */
  snap(ctx: AmbientCtx) {
    this.shown = targetCount(this.cfg, ctx.view.width, ctx.view.height);
  }

  info() {
    let rest = 0;
    if (this.cfg?.kind === "snow") for (const d of this.pool) if (d.state !== SNOW_FALLING) rest++;
    return {
      kind: this.cfg?.name ?? null,
      idx: this.cfg?.idx ?? 0,
      shown: Math.round(this.shown),
      drawn: this.pool.filter((d) => d.img.visible).length,
      splashes: this.splashes.filter((s) => s.active).length,
      flashes: this.flashes,
      rest,
      gain: +this.gain.toFixed(3),
    };
  }

  step(ctx: AmbientCtx, dtMs: number) {
    const scene = ctx.scene;
    this.ensureTextures(scene);
    const dt = Math.min(dtMs, 100) / 1000;
    this.stepSplashes(Math.min(dtMs, 100));

    const cfg = this.cfg;
    const wv = ctx.view;
    const target = this.gain > 0.01 ? targetCount(cfg, wv.width, wv.height) : 0;
    this.shown = easeShown(this.shown, target, Math.min(dtMs, 100));
    // publish the DRAWN density for env.rain (runtime/precipstate.ts)
    setPrecipShown(cfg ? this.shown : 0);
    if (this.shown < 1 && !cfg) return;

    const n = Math.min(Math.round(this.shown), MAX_DROPS);
    while (this.pool.length < n) {
      const img = scene.add.image(0, 0, "fx-rain").setDepth(DEPTH).setVisible(false);
      const d: Drop = {
        img,
        x: wv.x + this.rand() * wv.width,
        y: wv.y + this.rand() * wv.height,
        vy: 0, vxJit: this.rand(), phase: this.rand() * Math.PI * 2,
        landY: 0, state: SNOW_FALLING, restT: 0, meltDur: SNOW_FADE, wisp: false,
      };
      this.dress(d, this.pool.length);
      this.pool.push(d);
    }
    if (!cfg) { for (const d of this.pool) d.img.setVisible(false); return; }

    const t = scene.time.now / 1000;
    const gust = gustAt(t, cfg.gust);
    const vxBase = cfg.vx * gust;
    const rot = streakRot(cfg, vxBase);
    const left = wv.x - MARGIN;
    const right = wv.x + wv.width + MARGIN;
    const top = wv.y - MARGIN;
    const bottom = wv.y + wv.height + MARGIN;
    const span = right - left;

    for (let i = 0; i < this.pool.length; i++) {
      const d = this.pool[i];
      if (i >= n) { d.img.setVisible(false); continue; }
      if (d.vy === 0) d.vy = cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) * d.vxJit;
      let vx = vxBase + (d.vxJit - 0.5) * (cfg.kind === "snow" ? 30 : 40);
      if (cfg.kind === "snow") vx += Math.sin(t * 1.1 + d.phase) * 22;
      let snowAlphaMul = 1;

      if (cfg.kind === "snow") {
        // Snow HITS THE GROUND: each flake sways down to its own landing
        // height, SETTLES there for a few seconds, then melts and recycles.
        if (d.landY === 0) d.landY = top + (0.5 + 0.45 * this.rand()) * (bottom - top);
        if (d.state === SNOW_RESTING) {
          d.restT -= dtMs;
          if (d.restT <= 0) { d.state = SNOW_MELTING; d.meltDur = SNOW_FADE; d.restT = d.meltDur; }
        } else if (d.state === SNOW_MELTING) {
          d.restT -= dtMs;
          snowAlphaMul = Math.max(0, d.restT / d.meltDur);
          if (d.restT <= 0) this.recycleSnow(d, top, left, span, bottom);
        } else {
          d.x += vx * dt;
          d.y += d.vy * dt;
          if (d.x < left) d.x += span; else if (d.x > right) d.x -= span;
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
          this.recycleSnow(d, top, left, span, bottom);
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
          if (d.landY === 0) d.landY = top + (0.45 + 0.5 * this.rand()) * (bottom - top);
          if (d.y >= d.landY) {
            this.spawnSplash(scene, d.x, d.landY);
            d.y = top - this.rand() * 30;
            d.x = left + this.rand() * span;
            d.vy = cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) * this.rand();
            d.landY = top + (0.45 + 0.5 * this.rand()) * (bottom - top);
          }
        } else if (d.y > bottom) {
          d.y = top - this.rand() * 30;
          d.x = left + this.rand() * span;
          d.vy = cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) * this.rand();
        }
        if (d.x < left) {
          d.x += span;
          if (cfg.kind === "leaf") d.y = top + this.rand() * (bottom - top);
        } else if (d.x > right) d.x -= span;
        // camera jumped (teleport/respawn): re-scatter into the new view
        if (d.y < top - 200 || d.y > bottom + 200) {
          d.y = top + this.rand() * (bottom - top);
          d.x = left + this.rand() * span;
          d.landY = 0;
        }
      }

      const wispA = d.wisp ? WISP_ALPHA : 1;
      const twinkle = cfg.kind === "snow" ? snowAlphaMul
        : cfg.kind === "leaf" && !d.wisp ? snowTwinkle(t, d.phase) : 1;
      const big = cfg.kind === "leaf" && !d.wisp;
      d.img
        .setVisible(true)
        .setPosition(d.x, d.y)
        .setAlpha(cfg.alpha * wispA * twinkle * this.gain)
        .setScale(big ? 1 + d.vxJit : 1, big ? (1 + d.vxJit) * cfg.scaleY : cfg.scaleY)
        .setRotation(rot);
    }

    // Storm lightning: camera flash, occasionally double-striking, with the
    // composer's thunder roll in sync.
    if (cfg.lightning && this.gain > 0.5 && scene.time.now >= this.nextFlash) {
      if (this.nextFlash > 0) {
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
