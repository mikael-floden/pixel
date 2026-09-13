import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { groundSoundAt, landableAt, playerAt } from "../runtime/ground";
import { powerOf, puffDone, puffLife, speckAt, speckCount } from "./puff";

/* LANDING DUST — the ground answers when you come down on it.
 *
 * The maintainer's pick from the list of twenty, and it belongs to the same
 * family as a butterfly taking off as you reach it: the world reacting in the
 * frame it happens rather than decorating around you. A jump that lands with
 * no consequence is a character floating; a puff at the boot is weight.
 *
 * HOW AMBIENT SEES A LANDING AT ALL, owning no game file. Two published
 * probes carry it and neither was added for this:
 *   `__ml.me().jumping` is the SYNCED jump flag. Its rising edge starts the
 *   hop and the hop is a fixed JUMP_MS parabola, so the touchdown is that
 *   edge plus JUMP_MS — no sampling of a sprite's height, and it is the same
 *   clock every client hops on.
 *   `__ml.fall().falling` is the gravity fall, and the frame it goes false is
 *   the impact. `fallV` on the last frame it was true is how hard: that is
 *   the game's own fall velocity, the number it bills damage on, so a landing
 *   that hurts and a landing that puffs agree by construction instead of by
 *   two thresholds drifting apart.
 *
 * ONLY THE LOCAL PLAYER. `jumping` is synced for everyone, but the probe
 * surface publishes it through `me()` alone and inventing a second way to
 * read other avatars would be re-deriving state ambient does not own. The
 * puff under your own feet is the one you are looking at.
 *
 * DUST IS THE GROUND, LIFTED. The colour comes from the surface landed on
 * (`groundSoundAt`, one call per landing — an event, never per frame), so
 * sand throws pale grit, stone grey, snow white and grass a dull olive. One
 * "dust colour" would be wrong on nine surfaces out of ten, and the fire
 * smoke's lesson lands on top of it: WHAT COLOUR A MARK SHOULD BE IS DECIDED
 * BY WHAT IS BEHIND IT. Each tint here is its own ground lifted toward the
 * light, not dust imagined in the abstract.
 *
 * NOT ON WATER. Landing in a lake is a splash — a different shape, a
 * different effect; `landableAt` says no and the puff is skipped.
 *
 * DEPTH: the small-mark band just above the darkness overlay, a hair over the
 * butterflies. Dust at your boot is in FRONT of the boot, and sitting above
 * the overlay is what stops it being multiplied into the night ground.
 */

const NAME = "dust";
const DEPTH = 900_000.09;
const DEPTH_BIAS = 1e-6;
/** Landings overlap rarely; four is a whole staircase's worth. */
const MAX_PUFFS = 4;
/** A storey's drawn height, px — the pitch a level costs on screen. Only used
 *  to carry the remembered ground down or up when a hop CHANGES level. */
const STOREY_PX = 15;
/** The hop's fixed visual window (`shared/src` JUMP_MS). */
const JUMP_MS = 500;
/* AND A COUPLE OF FRAMES OF SLACK BEFORE THE PUFF. The feet position ambient
 * can read is the SPRITE's, and the sprite carries the hop parabola — firing
 * the instant the timer expires threw the dust 28 px up in the air, measured,
 * because the flag edge and the drawn hop do not land on the identical frame.
 * The parabola is exactly zero once the window closes, so waiting two frames
 * past it makes the sprite the feet by definition. A FALL needs none of this:
 * `falling` goes false when the elevation reaches its target, which is the
 * frame the body is already down. */
const LAND_SLACK_MS = 80;
/** Two landings closer together than this are one landing. */
const DEBOUNCE_MS = 110;
/** Specks are 1px, or 2px on the heavier half of a landing. */
const BIG_FROM = 0.45;

/** THE DUST A SURFACE THROWS, by the ground's own `sound` — each one its own
 *  terrain lifted toward the light so it reads against that terrain. */
const DUST: Record<string, number> = {
  grass: 0x9ba07c,
  dirt: 0xb09272,
  sand: 0xd9c49a,
  stone: 0xb4b4b0,
  snow: 0xecf2f5,
  ice: 0xd8e8f0,
  wood: 0xbca880,
  swamp: 0x8f9a7c,
};
/** Ground with no entry (and structures, which publish an empty sound). */
const DUST_DEFAULT = 0xb0a894;

const KEY_SMALL = "amb-dust1";
const KEY_BIG = "amb-dust2";

interface Puff {
  x: number; // the feet, world px
  y: number;
  t: number; // ms since touchdown
  life: number;
  n: number;
  power: number;
  tint: number;
  jitter: number[];
  sprites: Phaser.GameObjects.Image[];
}

/** The local player's landing state, from the two probes. */
interface Me {
  jumping: boolean;
  swimming: boolean;
}
interface Fall {
  falling: boolean;
  fallV: number;
  elev: number;
}

export function dustFeature(): AmbientFeature {
  const puffs: Puff[] = [];
  let scene: Phaser.Scene | null = null;
  let suppressed = false;
  let forced = false;
  let seed = 20260913;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  // landing detection state
  let wasJumping = false;
  let wasFalling = false;
  let lastFallV = 0;
  let hopDue = 0; // >0 = a hop touchdown is scheduled at this age
  let sinceLand = 1e9;
  /* WHERE THE FEET WERE WHEN THEY WERE LAST ON THE GROUND. The position
   * ambient can read is the sprite's, and the sprite carries the hop
   * parabola — sampling it on a timer put the dust 28 px up, and adding
   * slack only shrank the error to 9 because the flag edge and the drawn hop
   * do not share a frame at every frame rate. This is exact instead: on flat
   * ground the pre-jump feet ARE the landing feet, and when the slack was
   * generous enough the player is already grounded and this was refreshed on
   * the same frame anyway. */
  let groundY: number | null = null;
  let groundElev = 0;
  const stats = { hops: 0, falls: 0, skippedWet: 0, puffs: 0 };

  const probe = <T,>(name: string): T | null => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const f = ml?.[name] as undefined | (() => T | null);
    if (!f) return null;
    try {
      return f() ?? null;
    } catch {
      return null;
    }
  };

  const ensureTextures = (s: Phaser.Scene) => {
    for (const [key, size] of [[KEY_SMALL, 1], [KEY_BIG, 2]] as const) {
      if (s.textures.exists(key)) continue;
      const g = s.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0xffffff, 1);
      g.fillRect(0, 0, size, size);
      g.generateTexture(key, size, size);
      g.destroy();
    }
  };

  /** Throw a puff at the player's feet, if the ground there takes one.
   *  `elev` is the elevation at touchdown, so a hop that ended a level up or
   *  down carries the remembered ground with it. */
  const land = (ctx: AmbientCtx, power: number, elev: number) => {
    if (!scene) return;
    const at = playerAt(ctx.view);
    if (!at) return;
    // x is always the sprite's: the hop only ever moves it vertically
    const feet = { x: at.x, y: groundY === null ? at.y : groundY - (elev - groundElev) * STOREY_PX };
    // a lake landing is a splash, not dust
    if (!landableAt(feet.x, feet.y)) {
      stats.skippedWet++;
      return;
    }
    const sound = groundSoundAt(feet.x, feet.y);
    const tint = (sound && DUST[sound]) || DUST_DEFAULT;
    const n = speckCount(power);
    const life = puffLife(power);
    while (puffs.length >= MAX_PUFFS) puffs.shift()!.sprites.forEach((s) => s.destroy());
    const jitter: number[] = [];
    const sprites: Phaser.GameObjects.Image[] = [];
    for (let i = 0; i < n; i++) {
      jitter.push(rnd());
      sprites.push(
        scene.add
          .image(0, 0, power >= BIG_FROM && i % 2 === 0 ? KEY_BIG : KEY_SMALL)
          .setDepth(DEPTH)
          .setTint(tint)
          .setVisible(false),
      );
    }
    puffs.push({ x: feet.x, y: feet.y, t: 0, life, n, power, tint, jitter, sprites });
    stats.puffs++;
    sinceLand = 0;
  };

  return {
    name: NAME,
    init(ctx) {
      scene = ctx.scene;
      ensureTextures(ctx.scene);
    },
    update(ctx, dt) {
      const dtc = Math.min(dt, 100);
      sinceLand += dtc;
      if (!scene) return;

      // ---- watch for a landing -------------------------------------------
      const me = probe<Me>("me");
      const fall = probe<Fall>("fall");
      const jumping = !!me?.jumping;
      const swimming = !!me?.swimming;
      const falling = !!fall?.falling;
      if (falling) lastFallV = Math.abs(fall?.fallV ?? 0);
      // remember the ground whenever the body is actually standing on it
      if (!jumping && !falling && !swimming && hopDue <= 0) {
        const here = playerAt(ctx.view);
        if (here) {
          groundY = here.y;
          groundElev = fall?.elev ?? groundElev;
        }
      }

      // A HOP: the rising edge schedules its own touchdown JUMP_MS later.
      if (jumping && !wasJumping) hopDue = JUMP_MS + LAND_SLACK_MS;
      wasJumping = jumping;
      if (hopDue > 0) {
        hopDue -= dtc;
        if (hopDue <= 0) {
          hopDue = 0;
          /* A hop that turned into a fall has no landing of its own — the
           * fall's own impact is the real one, and firing here would puff in
           * mid-air on the way down. */
          if (!falling && !swimming && sinceLand > DEBOUNCE_MS) {
            stats.hops++;
            land(ctx, 0, fall?.elev ?? groundElev);
          }
        }
      }

      // A FALL: the frame it stops falling is the impact, and the speed it
      // was doing on the last falling frame is how hard.
      if (!falling && wasFalling) {
        hopDue = 0; // the fall consumed any hop that led into it
        if (!swimming && sinceLand > DEBOUNCE_MS) {
          stats.falls++;
          land(ctx, powerOf(lastFallV), fall?.elev ?? groundElev);
        }
        lastFallV = 0;
      }
      wasFalling = falling;

      // ---- draw ------------------------------------------------------------
      const gain = suppressed ? 0 : forced ? 1 : 1;
      const g = gain * ctx.outdoor;
      for (let p = puffs.length - 1; p >= 0; p--) {
        const puff = puffs[p];
        puff.t += dtc;
        if (puffDone(puff.t, puff.life) || g <= 0.02) {
          puff.sprites.forEach((s) => s.destroy());
          puffs.splice(p, 1);
          continue;
        }
        for (let i = 0; i < puff.n; i++) {
          const s: ReturnType<typeof speckAt> = speckAt(i, puff.n, puff.t, puff.power, puff.jitter[i], puff.life);
          const spr = puff.sprites[i];
          const a = s.alpha * g;
          spr
            .setPosition(Math.round(puff.x + s.x), Math.round(puff.y + s.y - s.alt))
            .setDepth(DEPTH + (puff.y + s.y) * DEPTH_BIAS)
            .setAlpha(a)
            .setVisible(a > 0.02);
        }
      }
    },
    setSuppressed(on) {
      suppressed = on;
    },
    setForced(on) {
      forced = on;
    },
    debug() {
      return {
        ...stats,
        live: puffs.length,
        suppressed,
        forced,
        all: puffs.map((p) => ({
          x: Math.round(p.x),
          y: Math.round(p.y),
          t: Math.round(p.t),
          life: Math.round(p.life),
          n: p.n,
          power: +p.power.toFixed(2),
          tint: p.tint,
          a: +(p.sprites[0]?.visible ? p.sprites[0].alpha : 0).toFixed(3),
          /* WHERE EVERY SPECK IS DRAWN. A gate cannot isolate this effect by
           * diffing frames — the jump animation runs on its own clock, so two
           * jumps never line up and a plain ON/OFF diff measured 6,074 pixels
           * of moving character against four pixels of dust. Publishing the
           * specks lets it judge the pixels the feature actually claims. */
          specks: p.sprites.map((spr) => ({
            x: Math.round(spr.x),
            y: Math.round(spr.y),
            a: +(spr.visible ? spr.alpha : 0).toFixed(3),
          })),
        })),
      };
    },
    dispose() {
      for (const p of puffs) p.sprites.forEach((s) => s.destroy());
      puffs.length = 0;
      scene = null;
    },
  };
}
