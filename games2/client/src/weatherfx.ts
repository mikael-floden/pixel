import Phaser from "phaser";

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
 * double-striking. Snow sways per-flake (phase-offset sine).
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
}

// Keyed by shared WEATHER_NAMES index.
const PRECIP: Record<number, Cfg> = {
  3: { count: 90,  vy: [300, 390], vx: -15,  alpha: 0.34, scaleY: 0.6 },              // Drizzle
  4: { count: 260, vy: [620, 760], vx: -70,  alpha: 0.45, scaleY: 1 },                // Rain
  5: { count: 520, vy: [700, 880], vx: -120, alpha: 0.52, scaleY: 1.25 },             // Heavy rain
  6: { count: 660, vy: [760, 960], vx: -250, alpha: 0.56, scaleY: 1.4, gust: true, lightning: true }, // Storm
  7: { count: 240, vy: [55, 95],   vx: 0,    alpha: 0.9,  scaleY: 1, snow: true },    // Snowing
  8: { count: 110, vy: [15, 60],   vx: -200, alpha: 0.95, scaleY: 1, leaf: true, gust: true }, // Windy
};

const REF_AREA = 520 * 700; // world px² the counts are tuned for
const MARGIN = 60;
const DEPTH = 899_500;

interface Drop {
  img: Phaser.GameObjects.Image;
  x: number;
  y: number;
  vy: number;
  vxJit: number; // per-drop horizontal jitter
  phase: number; // snow sway phase
  wisp?: boolean; // Windy: this slot is a motion-line, not a leaf
}

export class WeatherFX {
  private scene: Phaser.Scene;
  private pool: Drop[] = [];
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
  }

  private rand(): number {
    // deterministic enough for visuals, no Math.random in the hot path
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
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
    return { kind: this.kind, shown: Math.round(this.shown), flashes: this.flashes };
  }

  update(dtMs: number, cam: Phaser.Cameras.Scene2D.Camera) {
    const dt = Math.min(dtMs, 100) / 1000;
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
      // recycle: below the view -> back to the top band; wrap x
      if (d.y > bottom) {
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
      }
      const wispA = d.wisp ? 0.13 : 1;
      d.img
        .setVisible(true)
        .setPosition(d.x, d.y)
        .setAlpha(cfg.alpha * wispA * (cfg.snow || (cfg.leaf && !d.wisp) ? 0.75 + 0.25 * Math.sin(t * 2 + d.phase) : 1))
        .setScale(cfg.leaf && !d.wisp ? 1 + d.vxJit : 1, cfg.leaf && !d.wisp ? (1 + d.vxJit) * cfg.scaleY : cfg.scaleY)
        .setRotation(rot);
    }

    // Storm lightning: camera flash, occasionally double-striking.
    if (cfg.lightning && this.scene.time.now >= this.nextFlash) {
      this.flashes++;
      cam.flash(110, 255, 255, 245);
      if (this.rand() < 0.35) {
        this.scene.time.delayedCall(160, () => cam.flash(70, 255, 255, 245));
      }
      this.nextFlash = this.scene.time.now + 5000 + this.rand() * 9000;
    }
  }
}
