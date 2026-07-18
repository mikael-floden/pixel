import Phaser from "phaser";
import { gameAudio } from "../../composer/index";

/** Precipitation weather (Drizzle / Rain / Heavy rain / Storm / Snowing).
 *
 * A manually-pooled particle layer in WORLD space: drops live at world
 * coordinates inside the camera view (+margin) and RECYCLE — a drop that
 * falls below the view respawns at the top band, x wraps horizontally — so
 * density stays constant however the camera moves, with no lifespan pops.
 * The layer sits at depth 899_500: above the world art, BELOW the night
 * multiply overlay (rain dims with the night and picks up torch light the
 * same way the world does) and below the lit avatar copies (a character
 * reads in FRONT of the sheet of rain).
 *
 * Storm adds slow wind GUSTS (a global sine on the horizontal velocity —
 * every streak leans together, which sells the wind far more than per-drop
 * noise) and camera-flash lightning on a random 5-14s timer, sometimes
 * double-striking. Snow sways per-flake (phase-offset sine) and SETTLES:
 * each flake falls to its own ground height, rests there as a still flake
 * for a few seconds, then melts (fades) and recycles — the same
 * fall→land→rest→fade lifecycle rain drops and autumn leaves use, so snow
 * reaches the ground instead of scrolling off the bottom of the view.
 *
 * The ambient dim for each state lives in WorldScene's ambEff (eased
 * curPrecipDim), NOT here — the same place the cloud grey lives.
 */

interface Cfg {
  count: number;      // drops on screen at the REFERENCE view area
  vy: [number, number];
  vx: number;         // base horizontal drift (world px/s, negative = left)
  alpha: number;
  scaleY: number;     // streak length multiplier
  snow?: boolean;
  leaf?: boolean;     // Windy: tumbling debris, mostly horizontal
  gust?: boolean;
  lightning?: boolean;
  splash?: boolean;   // rain: drop LANDS on the ground and pops a ripple
}

// Keyed by shared WEATHER_NAMES index.
const PRECIP: Record<number, Cfg> = {
  3: { count: 90,  vy: [300, 390], vx: -15,  alpha: 0.34, scaleY: 0.6, splash: true },  // Drizzle
  4: { count: 260, vy: [620, 760], vx: -70,  alpha: 0.45, scaleY: 1, splash: true },     // Rain
  5: { count: 520, vy: [700, 880], vx: -120, alpha: 0.52, scaleY: 1.25, splash: true },  // Heavy rain
  6: { count: 660, vy: [760, 960], vx: -250, alpha: 0.56, scaleY: 1.4, gust: true, lightning: true, splash: true }, // Storm
  7: { count: 240, vy: [55, 95],   vx: 0,    alpha: 0.9,  scaleY: 1, snow: true },    // Snowing
  8: { count: 110, vy: [15, 60],   vx: -200, alpha: 0.95, scaleY: 1, leaf: true, gust: true }, // Windy
};

const REF_AREA = 520 * 700; // world px² the counts are tuned for
const MARGIN = 60;
const DEPTH = 899_500;
// Ground splashes for rain: ripple rings just UNDER the falling drops.
const SPLASH_DEPTH = 899_490;
const MAX_SPLASH = 130;         // hard cap on live ripples (heavy rain sits here)
const SPLASH_LIFE: [number, number] = [300, 480]; // ms
// Snow SETTLES: a flake that reaches the ground rests, then melts/fades.
const SNOW_REST: [number, number] = [2500, 6000]; // ms a landed flake sits before melting
const SNOW_FADE = 1500;                            // ms melt/fade-out

interface Drop {
  img: Phaser.GameObjects.Image;
  x: number;
  y: number;
  vy: number;
  vxJit: number; // per-drop horizontal jitter
  phase: number; // snow sway phase
  landY: number; // rain/snow: world-y where this drop hits the ground (0 = uninit)
  state: number; // snow: 0 falling, 1 resting on ground, 2 fading (melting)
  restT: number; // snow: ms left in the current rest/fade phase
  wisp?: boolean; // Windy: this slot is a motion-line, not a leaf
}

interface Splash {
  img: Phaser.GameObjects.Image;
  x: number;
  y: number;
  age: number; // ms
  life: number;
  grow: number;
  active: boolean;
}

export class WeatherFX {
  private scene: Phaser.Scene;
  private pool: Drop[] = [];
  private splashes: Splash[] = [];
  private cfg: Cfg | null = null;
  private kind = 0;
  private shown = 0;         // eased visible-drop count
  private nextFlash = 0;
  private seed = 1;
  private snapPending = false;
  private flashes = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.makeTextures();
  }

  private makeTextures() {
    const t = this.scene.textures;
    if (!t.exists("fx-rain")) {
      const g = this.scene.add.graphics();
      g.fillStyle(0xbcd2e8, 1);
      g.fillRect(0, 0, 1, 7);
      g.generateTexture("fx-rain", 1, 7);
      g.destroy();
    }
    if (!t.exists("fx-snow")) {
      const g = this.scene.add.graphics();
      g.fillStyle(0xf4f8ff, 1);
      g.fillRect(0, 0, 2, 2);
      g.generateTexture("fx-snow", 2, 2);
      g.destroy();
    }
    if (!t.exists("fx-wisp")) {
      // anime wind motion-line: a long faint streak sweeping with the gust
      const g = this.scene.add.graphics();
      g.fillStyle(0xffffff, 1);
      g.fillRect(0, 0, 22, 1);
      g.generateTexture("fx-wisp", 22, 1);
      g.destroy();
    }
    if (!t.exists("fx-leaf")) {
      const g = this.scene.add.graphics();
      g.fillStyle(0xffffff, 1); // white, tinted per particle (green/brown mix)
      g.fillRect(0, 0, 2, 2);
      g.generateTexture("fx-leaf", 2, 2);
      g.destroy();
    }
    if (!t.exists("fx-splash")) {
      // A thin 11×11 ripple ring + a faint impact dot; tinted cool at use.
      const g = this.scene.add.graphics();
      g.lineStyle(1.4, 0xffffff, 1);
      g.strokeCircle(5.5, 5.5, 4.5);
      g.fillStyle(0xffffff, 0.9).fillCircle(5.5, 5.5, 0.9);
      g.generateTexture("fx-splash", 11, 11);
      g.destroy();
    }
  }

  /** Pop a ripple where a rain drop hit the ground (pooled, hard-capped). */
  private spawnSplash(x: number, y: number) {
    let s: Splash | undefined = this.splashes.find((p) => !p.active);
    if (!s) {
      if (this.splashes.length >= MAX_SPLASH) return; // at cap — skip
      const img = this.scene.add
        .image(0, 0, "fx-splash")
        .setDepth(SPLASH_DEPTH)
        .setTint(0xcfe4ff)
        .setVisible(false);
      s = { img, x: 0, y: 0, age: 0, life: 0, grow: 1, active: false };
      this.splashes.push(s);
    }
    s.x = x;
    s.y = y;
    s.age = 0;
    s.life = SPLASH_LIFE[0] + this.rand() * (SPLASH_LIFE[1] - SPLASH_LIFE[0]);
    s.grow = 1.3 + this.rand() * 1.3;
    s.active = true;
    s.img.setPosition(x, y).setVisible(true);
  }

  private updateSplashes(dtMs: number) {
    for (const s of this.splashes) {
      if (!s.active) continue;
      s.age += dtMs;
      const p = s.age / s.life;
      if (p >= 1) {
        s.active = false;
        s.img.setVisible(false);
        continue;
      }
      const sc = 0.35 + p * s.grow;
      s.img.setScale(sc, sc * 0.5).setAlpha((1 - p) * 0.7); // iso ground ellipse
    }
  }

  private rand(): number {
    // deterministic enough for visuals, no Math.random in the hot path
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /** Send a settled/melted snow flake back to the top band for another fall
   * (new landing height, falling state). */
  private recycleSnow(d: Drop, top: number, left: number, span: number, bottom: number) {
    const cfg = this.cfg!;
    d.state = 0;
    d.restT = 0;
    d.y = top - this.rand() * 30;
    d.x = left + this.rand() * span;
    d.vy = cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) * this.rand();
    d.landY = top + (0.5 + 0.45 * this.rand()) * (bottom - top);
  }

  setWeather(idx: number) {
    if (idx === this.kind) return;
    this.kind = idx;
    this.cfg = PRECIP[idx] ?? null;
    if (this.cfg) {
      for (let i = 0; i < this.pool.length; i++) this.dress(this.pool[i], i);
      this.nextFlash = this.scene.time.now + 4000 + this.rand() * 6000;
    }
  }

  /** Texture + tint a pool slot for the current weather (leaves mix three
   * autumn tints; every 7th Windy slot is a faint wind motion-line). */
  private dress(d: Drop, i: number) {
    const cfg = this.cfg;
    if (!cfg) return;
    d.wisp = !!cfg.leaf && i % 7 === 0;
    const key = cfg.snow ? "fx-snow" : d.wisp ? "fx-wisp" : cfg.leaf ? "fx-leaf" : "fx-rain";
    d.img.setTexture(key);
    if (cfg.leaf && !d.wisp) {
      const tints = [0x7da05a, 0xa5854f, 0x5f8a4e];
      d.img.setTint(tints[Math.floor(d.vxJit * 3) % 3]);
    } else {
      d.img.setTint(0xffffff);
    }
  }

  /** Jump straight to the target intensity (join sync + headless QA — the
   * ease assumes a live frame loop). */
  snap() {
    this.snapPending = true;
  }

  info() {
    // `rest` = snow flakes currently settled on / melting into the ground
    // (0 for rain/leaves/windy) — lets QA confirm snow actually lands.
    let rest = 0;
    if (this.cfg?.snow) for (const d of this.pool) if (d.state === 1 || d.state === 2) rest++;
    return { kind: this.kind, shown: Math.round(this.shown), flashes: this.flashes, rest };
  }

  update(dtMs: number, cam: Phaser.Cameras.Scene2D.Camera) {
    const dt = Math.min(dtMs, 100) / 1000;
    // Ripples always animate to completion, even after the rain stops.
    this.updateSplashes(Math.min(dtMs, 100));
    const cfg = this.cfg;
    const wv = cam.worldView;
    const areaScale = Math.min(3, (wv.width * wv.height) / REF_AREA);
    const target = cfg ? cfg.count * areaScale : 0;
    // ease shown count on the weather's ~4s roll
    if (this.snapPending) {
      this.shown = target;
      this.snapPending = false;
    } else {
      this.shown += (target - this.shown) * (1 - Math.exp(-dt / 4));
    }
    if (this.shown < 1 && !cfg) return;

    const n = Math.min(Math.round(this.shown), 2000);
    while (this.pool.length < n) {
      const img = this.scene.add.image(0, 0, "fx-rain").setDepth(DEPTH).setVisible(false);
      const d: Drop = {
        img,
        x: wv.x + this.rand() * wv.width,
        y: wv.y + this.rand() * wv.height,
        vy: 0,
        vxJit: this.rand(),
        phase: this.rand() * Math.PI * 2,
        landY: 0,
        state: 0,
        restT: 0,
      };
      this.dress(d, this.pool.length);
      this.pool.push(d);
    }
    if (!cfg) {
      for (const d of this.pool) d.img.setVisible(false);
      return;
    }

    const t = this.scene.time.now / 1000;
    const gust = cfg.gust ? 0.65 + 0.55 * Math.sin(t * 0.45) + 0.2 * Math.sin(t * 1.7) : 1;
    const vxBase = cfg.vx * gust;
    const rot = cfg.snow || cfg.leaf ? 0 : Math.atan2(-vxBase, cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) / 2);
    const left = wv.x - MARGIN;
    const right = wv.x + wv.width + MARGIN;
    const top = wv.y - MARGIN;
    const bottom = wv.y + wv.height + MARGIN;
    const span = right - left;

    for (let i = 0; i < this.pool.length; i++) {
      const d = this.pool[i];
      if (i >= n) {
        d.img.setVisible(false);
        continue;
      }
      if (d.vy === 0) d.vy = cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) * d.vxJit;
      let vx = vxBase + (d.vxJit - 0.5) * (cfg.snow ? 30 : 40);
      if (cfg.snow) vx += Math.sin(t * 1.1 + d.phase) * 22;
      let snowAlphaMul = 1;
      if (cfg.snow) {
        // Snow HITS THE GROUND like the rain/leaves: each flake sways down to
        // its own landing height (a world-y in the near-ground band), SETTLES
        // there as a resting flake for a few seconds, then melts (fades out)
        // and recycles to the top for another fall.
        if (d.landY === 0) d.landY = top + (0.5 + 0.45 * this.rand()) * (bottom - top);
        if (d.state === 1) {
          // resting on the ground — stays put in the WORLD (camera scrolls over)
          d.restT -= dtMs;
          if (d.restT <= 0) {
            d.state = 2;
            d.restT = SNOW_FADE;
          }
        } else if (d.state === 2) {
          // melting away where it settled
          d.restT -= dtMs;
          snowAlphaMul = Math.max(0, d.restT / SNOW_FADE);
          if (d.restT <= 0) this.recycleSnow(d, top, left, span, bottom);
        } else {
          // FALLING: sway sideways, drift down to the landing height
          d.x += vx * dt;
          d.y += d.vy * dt;
          if (d.x < left) d.x += span;
          else if (d.x > right) d.x -= span;
          if (d.y >= d.landY) {
            d.y = d.landY;
            d.state = 1;
            d.restT = SNOW_REST[0] + this.rand() * (SNOW_REST[1] - SNOW_REST[0]);
          }
          snowAlphaMul = 0.75 + 0.25 * Math.sin(t * 2 + d.phase); // falling twinkle
        }
        // far off-screen (camera teleport, or a resting flake scrolled away):
        // drop the slot back into the current view
        if (d.y < top - 200 || d.y > bottom + 200 || d.x < left - 200 || d.x > right + 200) {
          this.recycleSnow(d, top, left, span, bottom);
        }
      } else {
        let vyEff = d.vy;
        if (cfg.leaf) {
          if (d.wisp) {
            // motion-line: races ahead of the leaves on the gust, waves gently
            vx = vxBase * 2.3;
            vyEff = Math.sin(t * 1.4 + d.phase) * 12;
          } else {
            // leaves STREAM (anime wind): deep per-leaf surge on the shared
            // gust + a curling swirl so paths arc instead of gliding straight
            vx *= 0.5 + 0.65 * Math.sin(t * 1.3 + d.phase);
            vx += Math.cos(t * 2.6 + d.phase * 3.0) * 45;
            vyEff = d.vy * 0.4 + Math.sin(t * 2.1 + d.phase * 2.0) * 48;
          }
        }
        d.x += vx * dt;
        d.y += (cfg.leaf ? vyEff : d.vy) * dt;
        if (cfg.splash) {
          // Rain HITS THE GROUND: each drop falls to its own landing height
          // (a world-y in the lower-middle band — the near ground), pops a
          // ripple there, and recycles to the top with a fresh landing point.
          if (d.landY === 0) d.landY = top + (0.45 + 0.5 * this.rand()) * (bottom - top);
          if (d.y >= d.landY) {
            this.spawnSplash(d.x, d.landY);
            d.y = top - this.rand() * 30;
            d.x = left + this.rand() * span;
            d.vy = cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) * this.rand();
            d.landY = top + (0.45 + 0.5 * this.rand()) * (bottom - top);
          }
        } else if (d.y > bottom) {
          // leaves: recycle below the view -> back to the top band
          d.y = top - this.rand() * 30;
          d.x = left + this.rand() * span;
          d.vy = cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) * this.rand();
        }
        if (d.x < left) {
          d.x += span;
          if (cfg.leaf) d.y = top + this.rand() * (bottom - top);
        } else if (d.x > right) d.x -= span;
        // camera jumped (teleport/respawn): re-scatter into the new view
        if (d.y < top - 200 || d.y > bottom + 200) {
          d.y = top + this.rand() * (bottom - top);
          d.x = left + this.rand() * span;
          d.landY = 0; // recompute the landing point for the new view
        }
      }
      const wispA = d.wisp ? 0.13 : 1;
      const twinkle = cfg.snow ? snowAlphaMul : cfg.leaf && !d.wisp ? 0.75 + 0.25 * Math.sin(t * 2 + d.phase) : 1;
      d.img
        .setVisible(true)
        .setPosition(d.x, d.y)
        .setAlpha(cfg.alpha * wispA * twinkle)
        .setScale(cfg.leaf && !d.wisp ? 1 + d.vxJit : 1, cfg.leaf && !d.wisp ? (1 + d.vxJit) * cfg.scaleY : cfg.scaleY)
        .setRotation(rot);
    }

    // Storm lightning: camera flash, occasionally double-striking. The
    // composer's thunder roll fires IN SYNC with the flash (audio hook by
    // the games-audio agent — these weather flashes are separate from the
    // ambient thunder episode's, and used to be silent).
    if (cfg.lightning && this.scene.time.now >= this.nextFlash) {
      this.flashes++;
      cam.flash(110, 255, 255, 245);
      gameAudio.thunder(1);
      if (this.rand() < 0.35) {
        this.scene.time.delayedCall(160, () => cam.flash(70, 255, 255, 245));
      }
      this.nextFlash = this.scene.time.now + 5000 + this.rand() * 9000;
    }
  }
}
