import Phaser from "phaser";

/** Footstep marks — every foot PLANT stamps a tiny ground mark at the exact
 * drawn spot the foot came down (maintainer). The plant frames + positions
 * are measured OFFLINE by scripts/build-manifest.mjs (plantsOf: the frame
 * where a foot blob arrives on the sole line and stays), shipped per
 * (character, gait, direction) in characters.json; WorldScene listens to
 * ANIMATION_UPDATE and converts the frame-pixel position through the
 * sprite's origin/scale, so the mark lands under the drawn foot, not at the
 * body anchor.
 *
 * Marks are styled by the ground's SURFACES sound id (grass shows soil
 * through crushed blades, dirt/sand press an oval pad, snow the strongest,
 * stone/wood a faint scuff), render at depth markY-0.5 so they y-sort with
 * the world like avatars do, and fade out over ~5s (FADE_MS — maintainer's
 * starting point). Faint by design: peak alpha ≤0.8, held ~2s then eased.
 * Pooled + capped; the oldest mark recycles when the cap is hit. */

const FADE_MS = 5000;
const MAX_MARKS = 240;

interface Mark {
  img: Phaser.GameObjects.Image;
  born: number;
  alpha: number;
}

export class Footsteps {
  private scene: Phaser.Scene;
  private pool: Mark[] = [];

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.makeTextures();
  }

  private makeTextures() {
    const mk = (key: string, w: number, h: number, px: [number, number][]) => {
      if (this.scene.textures.exists(key)) return;
      const g = this.scene.add.graphics();
      g.fillStyle(0xffffff, 1);
      for (const [x, y] of px) g.fillRect(x, y, 1, 1);
      g.generateTexture(key, w, h);
      g.destroy();
    };
    // iso-flattened prints, foot-width (~7px) and short (the ground is seen at
    // a shallow iso angle). White; tinted per style at spawn.
    mk("fs-oval", 7, 3, [
      [2, 0], [3, 0], [4, 0],
      [1, 1], [2, 1], [3, 1], [4, 1], [5, 1],
      [2, 2], [3, 2], [4, 2],
    ]); // pressed pad (dirt/sand/snow)
    mk("fs-pair", 7, 3, [
      [0, 0], [1, 0], [5, 0], [6, 0],
      [1, 1], [2, 1], [4, 1], [5, 1],
      [2, 2], [4, 2],
    ]); // grass: two crushed blade clusters
    mk("fs-dot", 4, 2, [[1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [3, 1]]); // scuff (stone/wood)
  }

  /** (sound id, material) -> visual. Unknown/empty ids get a neutral faint
   * press. Tints are chosen for CONTRAST against the surface, not to match it.
   * The SOUND drives the default; a few near-black MATERIALS that share a sound
   * with lighter ones override it so the step still reads (maintainer). Grass is
   * dark, so the step shows the DIRT pressed through the blades (dirt tile ≈
   * #a3865c). Ordinary `stone` reads fine as a dark scuff and keeps it; only
   * `black_mountain` (near-black stone) overrides to lighter STONE dust. Sand/
   * snow/ice sit on light ground, so a darker/cool press reads there. Marks draw
   * below the night overlay, so they dim with the ground and contrast holds at
   * night. Alphas are the peak (held ~2s, then eased out). */
  private styleFor(sound: string, material?: string): { key: string; tint: number; alpha: number } | null {
    // Material overrides: same sound as a lighter sibling, but too dark for the
    // sound's default mark.
    if (material === "black_mountain") return { key: "fs-dot", tint: 0x9a9aa0, alpha: 0.58 }; // light stone dust
    switch (sound) {
      case "grass":
        return { key: "fs-pair", tint: 0x9c7d4f, alpha: 0.72 }; // dirt through crushed blades
      case "dirt":
        return { key: "fs-oval", tint: 0x1c1206, alpha: 0.72 };
      case "sand":
        return { key: "fs-oval", tint: 0x6a5024, alpha: 0.66 };
      case "snow":
        return { key: "fs-oval", tint: 0x45597e, alpha: 0.8 };
      case "swamp":
        return { key: "fs-oval", tint: 0x16220e, alpha: 0.66 };
      case "ice":
        return { key: "fs-dot", tint: 0x7fb0cc, alpha: 0.5 };
      case "stone":
        return { key: "fs-dot", tint: 0x141418, alpha: 0.5 }; // dark scuff (good on ordinary stone)
      case "wood":
        return { key: "fs-dot", tint: 0x1b1206, alpha: 0.46 };
      case "water":
        return null; // swimming leaves no prints (ripples are their own idea)
      default:
        return sound ? { key: "fs-dot", tint: 0x1a1a1e, alpha: 0.44 } : null;
    }
  }

  /** Stamp a mark at screen (x, y) for the given SURFACES sound id. `depth`
   * is the painter y-sort value: it must come from the avatar's FLAT ground
   * row (its own `sprite.depth`), NOT from the lifted screen y — on raised
   * terrain those diverge and a lifted-y depth sorts the mark under the block
   * it sits on, hiding it. Falls back to `y` when no depth is given. */
  spawn(x: number, y: number, sound: string, scale = 1, depth = y, material?: string) {
    const st = this.styleFor(sound, material);
    if (!st) return;
    let m: Mark | undefined;
    for (const cand of this.pool) {
      if (!cand.img.visible) {
        m = cand;
        break;
      }
    }
    if (!m && this.pool.length < MAX_MARKS) {
      m = { img: this.scene.add.image(0, 0, st.key).setOrigin(0.5, 0.5), born: 0, alpha: 0 };
      this.pool.push(m);
    }
    if (!m) {
      // cap hit: recycle the oldest
      m = this.pool.reduce((a, b) => (a.born <= b.born ? a : b));
    }
    m.born = this.scene.time.now;
    m.alpha = st.alpha;
    m.img
      .setTexture(st.key)
      .setTint(st.tint)
      .setPosition(Math.round(x), Math.round(y))
      .setScale(scale)
      .setAlpha(st.alpha)
      .setDepth(depth - 0.5) // just under the body that stands on it
      .setVisible(true);
  }

  update(now: number) {
    for (const m of this.pool) {
      if (!m.img.visible) continue;
      const t = (now - m.born) / FADE_MS;
      if (t >= 1) {
        m.img.setVisible(false);
        continue;
      }
      // hold near-full for ~2s (the readable trail), then ease out
      const k = t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55;
      m.img.setAlpha(m.alpha * k * k);
    }
  }

  count() {
    let n = 0;
    for (const m of this.pool) if (m.img.visible) n++;
    return n;
  }

  /** Live marks (world pos + style) — headless QA cross-checks that marks
   * lie on the walked line and carry the right per-surface style. */
  list() {
    return this.pool
      .filter((m) => m.img.visible)
      .map((m) => ({
        x: m.img.x,
        y: m.img.y,
        key: m.img.texture.key,
        tint: m.img.tintTopLeft,
        alpha: m.img.alpha,
      }));
  }
}
