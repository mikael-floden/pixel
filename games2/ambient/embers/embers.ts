import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";

/* EMBER SPARKS — what comes off a fire and goes UP.
 *
 * The maintainer set the two conditions himself: "Ember sparks need to both
 * know if this is a fire AND where the fire/light source is."
 *
 * WHERE is solved and shared with the moths: `__ml.lightsInView` publishes the
 * DRAWN position of a source's glowing pixels, so a spark leaves the flame
 * rather than the object's foot.
 *
 * WHETHER IT IS A FIRE IS PUBLISHED, and this effect waited for it rather than
 * guessing. The scenery domain classified all 500 lit pieces BY EYE off the lit
 * art (2026-09-08), because nothing derivable works: `brazier_001` is a bowl of
 * teal crystals, `lantern_post_017` is an open flame on a post, `torch_post_004`
 * burns blue, 13 trees have a lantern hung in them, and 99 of 500 pieces
 * override their own group — so a name test is wrong about one time in five.
 * The game's own `flicker` is no better: it is a BRIGHTNESS decision that calls
 * a street lamp a flame.
 *
 * EMBERS IS NOT FLAME, which is the part worth knowing and which this file
 * would have got wrong on its own: a lantern IS a real fire (`fire/enclosed`)
 * and throws nothing, because the glass is between it and the world. 142 pieces
 * are fire; 82 throw embers. So this reads `light.embers` — the published
 * boolean — and nothing else. No path parsing, no allowlist, no group names.
 *
 * THE LOOK: a spark leaves the flame fast, slows as it rises (it is riding
 * heat, not thrown), wobbles across, COOLS from the fire's own colour toward a
 * deep red, and winks out. It never simply appears or vanishes: it brightens
 * out of the flame over its first breath and dies by cooling. Sparks come in
 * BURSTS, because a fire pops rather than pours.
 */

const KEY = "amb-ember"; // 2x2 — see A SPARK HAS TO READ
const KEY_DIM = "amb-ember-dim"; // 1x1, what it shrinks to as it dies
/* A SPARK DRAWS IN FRONT OF THE FIRE IT CAME OUT OF.
 *
 * Ambient marks all sat just over the darkness overlay at ~900_000.0x, and that
 * is right for something lying on the GROUND — it is under every body and every
 * piece, which is what a footprint or a wavelet wants. A source-attached mark is
 * the opposite case: it is emitted from the middle of a drawn object, so sorting
 * it behind that object hides it by construction. Every scenery piece draws
 * TWICE — once below the overlay and again as an opaque LIT COPY at
 * `litDepth` — so the hearth's own copy painted straight over the sparks
 * (maintainer 2026-09-09, at his fireplace: "you render the sparks and also the
 * moths behind the Scenery object so it's hard to see"; measured there, spark
 * 900_000.084 under a hearth copy at 900_001.045 that is tinted near-black
 * indoors, so it was not dimming them, it was covering them).
 *
 * So a spark takes ITS OWN FIRE'S drawn depth plus a hair — `litDepth` from
 * `__ml.lightsInView`, which reads the number off the piece's live sprite. That
 * is a sort, not an override: the lit band compresses painter depth by 1e-5, so
 * SRC_LIFT is a tenth of a painter pixel and anything genuinely standing in
 * front of the fire — the player at his hearth measured one pixel nearer — still
 * draws over the sparks. Being in front of the fire is what makes them visible;
 * being in front of everything would make them wrong. */
const SRC_LIFT = 1e-6;
/* When there is no copy to sort against (no night shader, art not landed yet),
 * there is nothing to be in front OF, so go above the whole lit band: the widest
 * painter line the_game can produce is ~11.7k px = 900_001.12, and the target
 * rings and HP bars start at 900_001.44. */
const ABOVE_LIT = 900_001.3;
const GAIN_TAU = 1400;

const LIGHT_MS = 560; // how often the light list is re-read (NOT per frame)
const MAX_SPARKS = 34;
const PER_FIRE = 14;
const MIN_R = 1; // cells — even a candle-sized fire may spark

/* A SPARK HAS TO READ, AND ONE WORLD PIXEL DOES NOT.
 *
 * The first version drew 1x1 marks. On the maintainer's phone the camera sits
 * at zoom 3 against a device ratio of 2.75, so one world pixel is about ONE CSS
 * PIXEL — an additive speck over a brightly lit fireplace. It was genuinely
 * being drawn (54 luma of pixel change on a dark harness background) and he
 * still could not find one, three times, which is the answer: technically
 * visible is not visible.
 *
 * So a spark is 2x2 while it is hot and shrinks to 1x1 as it dies, and it
 * leaves the flame WHITE-HOT rather than in the fire's colour — an ember's core
 * is brighter than the flame it came from, which is both true and the thing
 * that lets it stand out against one. It cools through the fire's own colour
 * and then to a deep red. */
const HOT = 0xfff6e2; // the core, leaving the flame
const HOT_MS = 0.28; // fraction of life spent cooling from HOT to the fire's colour
const SHRINK = 0.62; // ...and where it drops to the 1x1 art

const LIFE: [number, number] = [900, 2100];
const RISE0: [number, number] = [40, 96]; // px/s at the flame
const RISE_DRAG = 0.5; // how much of that speed is left at the end of its life
const SIDE: [number, number] = [4, 16]; // px of sideways wander over the whole rise
const WOBBLE_HZ: [number, number] = [0.9, 2.4];
const START_SPREAD = 4; // px — sparks leave the flame's width, not one point

const BURST_GAP: [number, number] = [200, 1100]; // ms between bursts from one fire
const BURST: [number, number] = [1, 4]; // sparks per burst

/* Brighten out of the flame. Fast — it is already burning — but a REAL ramp:
 * at 90ms this was under two frames on a phone, which is a pop wearing a
 * fade's clothes, and the gate caught it (mean alpha 0.493 at birth against
 * 0.628 mid-life, where a fade should be far below). */
const IN_MS = 190;
const COOL = 0x8c1c06; // what an ember cools toward before it dies
const ALPHA: [number, number] = [0.7, 1];

interface Spark {
  sprite: Phaser.GameObjects.Image;
  fire: number;
  x: number;
  y: number;
  age: number;
  life: number;
  up: number; // px/s at birth
  side: number; // px across, over the whole rise
  ph: number;
  hz: number;
  base: number;
  depth: number; // captured at birth: the fire list is rebuilt under a live spark
  tint: number; // the fire's own colour, cooled per frame
  live: boolean;
}

interface Fire {
  id: string;
  x: number;
  y: number;
  kind: string; // its published light kind — fire/open, fire/ember, ...
  piece: string;
  color: number;
  gap: number;
  depth: number; // where its sparks draw — see SRC_LIFT
}

export function embersFeature(): AmbientFeature {
  const sparks: Spark[] = [];
  let fires: Fire[] = [];
  let lightAge = 0;
  let probes = 0;
  let lit = 0; // how many lights were in view at the last read (QA)
  let inside = false; // is the player under a roof? read on the light throttle
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let seed = 40_961;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const range = ([a, b]: [number, number]) => a + rnd() * (b - a);

  const readFires = (): Fire[] => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    // On the same throttle as the light list — never per frame.
    try {
      const ind = ml?.indoor?.() as { indoor?: boolean } | null | undefined;
      inside = ind?.indoor === true;
    } catch { inside = false; }
    const f = ml?.lightsInView as
      | undefined
      | ((pad?: number) => {
          id: string; x: number; y: number; r: number;
          piece: string; kind: string; embers: boolean;
          color: [number, number, number]; sealed: boolean;
          litDepth: number | null;
        }[]);
    if (!f) return [];
    probes++;
    try {
      const all = f(48) || [];
      lit = all.length;
      return all
        // A sealed fire is one inside a room: it sparks only while you are in
        // there with it, or the sparks would draw over its own roof.
        .filter((l) => l.embers && l.r >= MIN_R && (!l.sealed || inside))
        .map((l) => {
          // The light's own colour, normalised — a blue resin torch throws blue
          // sparks, which is the whole reason this is read rather than assumed.
          const peak = Math.max(l.color[0], l.color[1], l.color[2], 0.001);
          const ch = (v: number) => Math.max(60, Math.min(255, Math.round((v / peak) * 255)));
          return {
            id: l.id, x: l.x, y: l.y, kind: l.kind, piece: l.piece,
            color: (ch(l.color[0]) << 16) | (ch(l.color[1]) << 8) | ch(l.color[2]),
            gap: range(BURST_GAP),
            depth: l.litDepth === null ? ABOVE_LIT : l.litDepth + SRC_LIFT,
          };
        });
    } catch {
      return [];
    }
  };

  const mix = (a: number, b: number, k: number) => {
    const m = (sh: number) =>
      Math.round(((a >> sh) & 255) + (((b >> sh) & 255) - ((a >> sh) & 255)) * k) & 255;
    return (m(16) << 16) | (m(8) << 8) | m(0);
  };

  const emit = (ctx: AmbientCtx, fi: number, fire: Fire) => {
    let s = sparks.find((q) => !q.live);
    if (!s && sparks.length < MAX_SPARKS) {
      s = {
        /* ORIGIN (0,0), LIKE EVERY OTHER PIXEL MARK IN THIS FOLDER — and it is
         * load-bearing, not tidiness. A 1x1 quad CENTRED on an integer position
         * spans x-0.5 to x+0.5, straddling the boundary between two pixels, and
         * a sampler with nothing whole to hit all but drops it: measured, a
         * spark at alpha 0.81 sitting on screen changed the pixel under it by
         * 0.1 luma. Every counter said the effect was working — visible, right
         * depth, right alpha, right position — and the screen showed nothing,
         * which is exactly why the gate now judges PIXELS. */
        sprite: ctx.scene.add.image(0, 0, KEY).setOrigin(0, 0).setScale(1).setVisible(false),
        fire: fi, x: 0, y: 0, age: 0, life: 0, up: 0, side: 0, ph: 0, hz: 1, base: 1,
        depth: ABOVE_LIT, tint: 0xffffff, live: false,
      };
      sparks.push(s);
    }
    if (!s) return; // at the ceiling
    s.fire = fi;
    s.x = fire.x + (rnd() - 0.5) * 2 * START_SPREAD;
    s.y = fire.y + (rnd() - 0.5) * START_SPREAD;
    s.age = 0;
    s.life = range(LIFE);
    s.up = range(RISE0);
    s.side = range(SIDE) * (rnd() < 0.5 ? 1 : -1);
    s.ph = rnd() * Math.PI * 2;
    s.hz = range(WOBBLE_HZ);
    s.base = range(ALPHA);
    s.depth = fire.depth;
    s.tint = fire.color;
    s.live = true;
    s.sprite.setVisible(true).setAlpha(0);
  };

  return {
    name: "embers",
    init(ctx) {
      // One pixel, painted WHITE — setTint multiplies, so the drawn colour is
      // the fire's own, cooling as the spark rises.
      const paint = (key: string, n: number) => {
        if (ctx.scene.textures.exists(key)) return;
        const g = ctx.scene.make.graphics({ x: 0, y: 0 }, false);
        g.fillStyle(0xffffff, 1);
        g.fillRect(0, 0, n, n);
        g.generateTexture(key, n, n);
        g.destroy();
      };
      paint(KEY, 2);
      paint(KEY_DIM, 1);
    },
    update(ctx, dt) {
      // Embers read at any hour but they only really tell after dark, so this
      // leans on night without switching off in daylight.
      const target = forced ? 1 : suppressed ? 0 : 0.25 + 0.75 * ctx.env.night;
      gain += (target - gain) * Math.min(1, (dt / GAIN_TAU) * 3);
      // NOT multiplied by ctx.outdoor — see the note at the top of this file.
      const g = gain;
      if (g <= 0.02) {
        for (const s of sparks) if (s.sprite.visible) { s.sprite.setVisible(false); s.live = false; }
        fires = [];
        return;
      }

      lightAge += dt;
      if (lightAge >= LIGHT_MS) {
        lightAge = 0;
        const next = readFires();
        // Keep each fire's own burst clock across a re-read, or a fire that
        // stays in view would restart its timer twice a second and never pop.
        for (const f of next) {
          const was = fires.find((o) => o.id === f.id);
          if (was) f.gap = was.gap;
        }
        fires = next;
      }

      // ---- the fires pop ----
      const secs = dt / 1000;
      for (let fi = 0; fi < fires.length; fi++) {
        const f = fires[fi];
        f.gap -= dt;
        if (f.gap > 0) continue;
        f.gap = range(BURST_GAP);
        const alive = sparks.filter((q) => q.live && q.fire === fi).length;
        const want = Math.min(Math.round(range(BURST)), PER_FIRE - alive);
        for (let k = 0; k < want; k++) emit(ctx, fi, f);
      }

      // ---- the sparks rise ----
      for (const s of sparks) {
        if (!s.live) continue;
        s.age += dt;
        const t = s.age / s.life;
        if (t >= 1) { s.live = false; s.sprite.setVisible(false); continue; }

        // Riding heat: fast at the flame, slowing as it goes.
        const speed = s.up * (1 - (1 - RISE_DRAG) * t);
        s.y -= speed * secs;
        s.x += (s.side / s.life) * dt + Math.sin(s.ph + (s.age / 1000) * s.hz * Math.PI * 2) * 0.35;

        /* IN, THEN COOL. It brightens out of the flame over its first breath and
         * then dies by COOLING rather than by being switched off: the tint runs
         * from the fire's own colour toward a deep red as the alpha falls, which
         * is what an ember does and what keeps it from reading as a fading dot. */
        const rise = Math.min(1, s.age / IN_MS);
        // Hold, then fall away linearly — squaring this made a spark dim for
        // most of its life, which is half of why none of them could be found.
        const fade = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
        // WHITE-HOT, then the fire's colour, then a dying red.
        const tint = t < HOT_MS
          ? mix(HOT, s.tint, t / HOT_MS)
          : mix(s.tint, COOL, Math.min(1, (t - HOT_MS) / (1 - HOT_MS)));
        const iy = Math.round(s.y);
        s.sprite
          .setTexture(t < SHRINK ? KEY : KEY_DIM)
          .setPosition(Math.round(s.x), iy)
          // NOT keyed on the spark's own screen y: a rising spark would sort
          // itself BEHIND its fire as it climbed. It belongs to the fire.
          .setDepth(s.depth)
          .setTint(tint)
          .setAlpha(g * s.base * rise * fade)
          .setBlendMode(Phaser.BlendModes.ADD);
      }
    },
    setSuppressed(on) { suppressed = on; },
    setForced(on) { forced = on; },
    debug() {
      const live = sparks.filter((s) => s.live && s.sprite.visible);
      return {
        gain: +gain.toFixed(3),
        probes, // QA: the light list walks every source — it must stay throttled
        lights: lit, // how many lights were in view at all
        inside, // ...and whether the player is under a roof (sealed fires need it)
        fires: fires.length, // ...and how many of those are fires
        fireList: fires.map((f) => ({
          id: f.id, x: Math.round(f.x), y: Math.round(f.y),
          kind: f.kind, piece: f.piece, color: f.color, depth: f.depth,
        })),
        sparks: live.length,
        /* WHAT THE SPRITE ITSELF SAYS. A mark can be positioned, tinted and
         * given an alpha and still never reach the screen, and from outside
         * this feature there is no way to tell the two apart — the debug
         * numbers look identical. So the first live spark reports its own
         * render state. */
        draw: (() => {
          /* THE BIGGEST live spark, not the first: a spark shrinks to 1x1 as it
           * dies, so sampling whichever happens to be first reports the dying
           * art and reads as "the marks are one pixel" — which is the exact bug
           * this field exists to catch. */
          const q = live.reduce(
            (a: Spark | null, c) => (!a || c.sprite.displayWidth > a.sprite.displayWidth ? c : a),
            null as Spark | null,
          );
          if (!q) return null;
          const sp = q.sprite as unknown as {
            visible: boolean; alpha: number; depth: number; blendMode: number;
            displayWidth: number; displayHeight: number; scrollFactorX: number;
            texture: { key: string }; scene: unknown;
          };
          return {
            visible: sp.visible, alpha: +sp.alpha.toFixed(3), depth: sp.depth,
            blend: sp.blendMode, dw: sp.displayWidth, dh: sp.displayHeight,
            sfx: sp.scrollFactorX, tex: sp.texture?.key,
            texExists: (q.sprite.scene?.textures?.exists?.(KEY)) ?? null,
            inScene: !!q.sprite.scene,
          };
        })(),
        all: live.map((s) => ({
          x: Math.round(s.sprite.x), y: Math.round(s.sprite.y),
          fire: s.fire, t: +(s.age / s.life).toFixed(3),
          a: +s.sprite.alpha.toFixed(3), tint: s.sprite.tintTopLeft,
          fx: Math.round(fires[s.fire]?.x ?? 0), fy: Math.round(fires[s.fire]?.y ?? 0),
        })),
      };
    },
    dispose() {
      for (const s of sparks) s.sprite.destroy();
      sparks.length = 0;
      fires = [];
    },
  };
}
