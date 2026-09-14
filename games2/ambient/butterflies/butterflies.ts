import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { findGround, groundSoundAt, landableAt, playerAt } from "../runtime/ground";
import { SPECIES, Species, bodyColour, darkPairs, pickSpecies } from "./species";
import {
  ALT,
  BEAT_MS,
  BOB_PX,
  FLICK_MS,
  FLICK_RAD,
  LAND_MS,
  homePull,
  SETTLE_EVERY,
  SETTLE_MS,
  SHY_TAKEOFF,
  SPEED,
  WING_CLOSED,
  Wing,
  bob,
  settleAlt,
  settleLife,
  settled,
  shySpeed,
  shyTurn,
  shyness,
  speedAt,
  steer,
  wing,
} from "./flight";

/* BUTTERFLIES — the meadow in summer.
 *
 * At four pixels a butterfly is not a shape, it is a WAY OF MOVING, and the
 * model in flight.ts is three things: the body BOBS with every wingbeat (a
 * mark that slides level reads as a bee), the path is short runs broken by
 * sudden hard turns rather than smooth curves (which read as a bird), and the
 * beat is uneven so it does not tick like a machine. The drawn wings change
 * SILHOUETTE WIDTH — five pixels open, three half, one shut — which is what
 * makes a flutter legible at this size.
 *
 * PLACED ON GRASS, and that is asked of the game rather than assumed: the
 * ground's own surface sound at the drawn point (`groundSoundAt`, two probes,
 * so a placement call and never a per-frame one). A meadow of butterflies over
 * a paved square or a stone quay reads as a mistake; over sand they are wrong
 * in a way the maintainer would notice on the beach he keeps photographing.
 *
 * Once placed it WORKS THAT PATCH (`homePull`) rather than being pinned to
 * grass frame by frame — that would cost two probes per butterfly per frame,
 * and a butterfly crossing the dirt path at the edge of the meadow is not a
 * bug, it is a butterfly. What the patch guarantees is that it comes back.
 *
 * They SETTLE: every few seconds one drops to the ground, shuts its wings for
 * a moment and lifts off again. A meadow where nothing ever lands is a screen
 * saver.
 *
 * DAY, WARM AND STILL. Butterflies are gone in rain and gone at night; wind
 * and snow take them too. The gate is the sun's own strength so it fades in
 * and out with the light rather than switching at a phase boundary.
 *
 * DEPTH: the small-flyer band just above the darkness overlay, with the gnats
 * and the feathers — a hair above both, since a butterfly is in the air over
 * them. Its own colour survives the night that way, which matters less here
 * than for the crawlers (it is a day creature) but keeps one convention.
 */

const NAME = "butterflies";
const DEPTH = 900_000.08;
const DEPTH_BIAS = 1e-6;
const GAIN_TAU = 1400;
const MAX_FLIT = 12;
/** One butterfly per this much view area, so a wide screen is not empty. */
const AREA_PER = 26_000;
/* ONE ground search per frame at most, and it BACKS OFF where there is no
 * meadow. A search is up to PLACE_TRIES probed points and each point costs
 * seven probes, so hammering it every frame over open water — where every
 * point fails — is the expensive case, not the meadow. */
const PLACE_MS = 150;
const PLACE_MAX_MS = 1800;
const PLACE_TRIES = 6;
/** After a failed settle probe, wait this long before asking the ground again. */
const SETTLE_RETRY_MS = 400;
const MARGIN = 16; // clearance the placement needs (the shoreline/cliff-lip rule)
const TAU = Math.PI * 2;
const OFF_VIEW = 60; // px past the edge before it is re-placed somewhere visible

/** THE GROUNDS A BUTTERFLY BELONGS OVER, by the surface's own sound. */
const MEADOW = new Set(["grass"]);

const KEY = (species: string, w: Wing) => `amb-flit-${species}_${w}`;

/* THE COLOURS ARE PAINTED IN, NOT TINTED. A butterfly is a MIX of two colours
 * (`species.ts` holds the maintainer's table) and Phaser's setTint multiplies
 * the WHOLE sprite by one value, so a two-tone creature cannot be a tint. Ten
 * species x three frames is thirty three-by-four textures, built once at init
 * and free thereafter — cheaper than the second sprite per butterfly the
 * alternative would need, and the colours come out exact instead of being a
 * multiply against whatever the art happened to be.
 *
 * The body is always the dark colour and the dark wing PAIRS are spent from
 * the outside in, so the layouts below are ordered outermost-first. */
type Px = readonly [number, number];
const OPEN_BODY: readonly Px[] = [[2, 1], [2, 2], [2, 3]];
/* Spent DARK-FIRST, and the order is the whole trick: the hindwing and the
 * forewing tips go first, so the forewing MASS (the pixels that tell you what
 * colour the butterfly is) is the last thing the marking ever reaches. */
const OPEN_PAIRS: readonly (readonly Px[])[] = [
  [[1, 2], [3, 2]], // hindwing tips
  [[0, 0], [4, 0]], // forewing tips
  [[0, 1], [4, 1]], // the outer forewing
  [[1, 0], [3, 0]],
  [[1, 1], [3, 1]], // innermost, against the body
];
const HALF_BODY: readonly Px[] = [[1, 1], [1, 2], [1, 3]];
const HALF_PAIRS: readonly (readonly Px[])[] = [[[0, 0], [2, 0]], [[0, 1], [2, 1]]];
const HALF_CAP: Px = [1, 0]; // where the raised wings meet over the back
/** Wings shut is the UNDERSIDE, and an underside is drab — all dark. */
const SHUT_ALL: readonly Px[] = [[1, 0], [1, 1], [1, 2], [1, 3]];

interface Flit {
  sprite: Phaser.GameObjects.Image;
  x: number; // ground point, world px
  y: number;
  hx: number; // the patch it was placed on, and works
  hy: number;
  alt: number;
  cruise: number;
  h: number; // heading, radians
  spd: number;
  beat: number;
  phase: number;
  bobA: number;
  species: Species;
  t: number;
  flickIn: number;
  settleIn: number;
  settleT: number; // >0 while a settle is running
  settleHold: number;
  shy: number; // last frame's alarm, 0..1 — reported, never re-probed
  a: number;
}

export function butterfliesFeature(): AmbientFeature {
  const flits: Flit[] = [];
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let placeAge = 0;
  let placeWait = PLACE_MS;
  let scene: Phaser.Scene | null = null;
  let seed = 20260912;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const between = (r: readonly [number, number]) => r[0] + rnd() * (r[1] - r[0]);
  const stats = { placed: 0, rejected: 0, settles: 0, startled: 0 };

  const ensureTextures = (s: Phaser.Scene) => {
    if (s.textures.exists(KEY(SPECIES[0].key, WING_CLOSED))) return;
    const paint = (key: string, w: number, h: number, layers: { c: number; px: readonly Px[] }[]) => {
      if (s.textures.exists(key)) return;
      const g = s.make.graphics({ x: 0, y: 0 }, false);
      for (const { c, px } of layers) {
        g.fillStyle(c, 1);
        for (const [x, y] of px) g.fillRect(x, y, 1, 1);
      }
      g.generateTexture(key, w, h);
      g.destroy();
    };
    /* ALL THREE FRAMES ARE FOUR PIXELS TALL and have their body in the middle
     * column, so Phaser's centred origin puts the body in the same place in
     * every frame: the wings change WIDTH (5 -> 3 -> 1) and nothing else
     * moves. A frame of a different height makes the whole creature hop by
     * half a pixel every beat, which reads as a glitch, not a flutter. */
    for (const sp of SPECIES) {
      const n = darkPairs(sp.darkShare);
      const body = bodyColour(sp);
      const flat = (rows: readonly (readonly Px[])[]) => rows.flat() as Px[];
      // OPEN: a dark border of `n` pairs round a bright middle, notched at the
      // head and tapering to an abdomen — the silhouette names the creature
      paint(KEY(sp.key, 2), 5, 4, [
        { c: sp.bright, px: flat(OPEN_PAIRS.slice(n)) },
        { c: sp.dark, px: flat(OPEN_PAIRS.slice(0, n)) },
        { c: body, px: OPEN_BODY },
      ]);
      // HALF: the wings are coming up, so the span narrows to the shoulders.
      // They MEET across the top — leaving that pixel open put a one-pixel
      // hole in the middle of the creature, which at this size is noise
      const hn = Math.min(n, HALF_PAIRS.length);
      paint(KEY(sp.key, 1), 3, 4, [
        { c: sp.bright, px: [...flat(HALF_PAIRS.slice(hn)), HALF_CAP] },
        { c: sp.dark, px: flat(HALF_PAIRS.slice(0, hn)) },
        { c: body, px: HALF_BODY },
      ]);
      // SHUT: wings together over the back — a sliver, and also how it sits.
      // An underside is drab, so it is the marking colour all the way down.
      paint(KEY(sp.key, 0), 3, 4, [{ c: sp.dark, px: SHUT_ALL }]);
    }
  };

  /** A patch of MEADOW in view with clearance, or null. ONE point per try, so
   *  the whole search costs at most PLACE_TRIES x seven probes whether it ends
   *  on the first grass or on none at all — the earlier shape nested a 4-try
   *  ground search inside a 6-try meadow search and cost 130 probes over the
   *  sea, which is exactly where it never succeeds. */
  const findMeadow = (view: Phaser.Geom.Rectangle): { x: number; y: number } | null => {
    for (let t = 0; t < PLACE_TRIES; t++) {
      const p = findGround(view, rnd, MARGIN, 1);
      if (!p) continue;
      const sound = groundSoundAt(p.x, p.y);
      // no probe at all (an older build) reads as "fine" rather than "never"
      if (sound === null || MEADOW.has(sound)) return p;
    }
    return null;
  };

  const place = (f: Flit, view: Phaser.Geom.Rectangle): boolean => {
    const p = findMeadow(view);
    if (!p) {
      stats.rejected++;
      placeWait = Math.min(PLACE_MAX_MS, placeWait * 2);
      return false;
    }
    placeWait = PLACE_MS;
    f.x = p.x;
    f.y = p.y;
    f.hx = p.x;
    f.hy = p.y;
    f.cruise = between(ALT);
    f.alt = f.cruise;
    f.h = rnd() * Math.PI * 2;
    f.spd = between(SPEED);
    f.beat = between(BEAT_MS);
    f.phase = rnd();
    f.bobA = between(BOB_PX);
    f.species = pickSpecies(rnd());
    f.t = 0;
    f.flickIn = between(FLICK_MS);
    f.settleIn = between(SETTLE_EVERY);
    f.settleT = 0;
    stats.placed++;
    return true;
  };

  const make = (s: Phaser.Scene): Flit => ({
    sprite: s.add.image(0, 0, KEY(SPECIES[0].key, 2)).setDepth(DEPTH).setScale(1).setVisible(false),
    x: 0,
    y: 0,
    hx: 0,
    hy: 0,
    alt: 0,
    cruise: 20,
    h: 0,
    spd: 20,
    beat: 180,
    phase: 0,
    bobA: 3,
    species: SPECIES[0],
    t: 0,
    flickIn: 500,
    settleIn: 6000,
    settleT: 0,
    settleHold: 1200,
    shy: 0,
    a: 0,
  });

  /** Day, warm, still. Never a butterfly at night, in rain, or in moving air.
   *  Indices 6+ are storm, snow and wind — the gnats' rule, and for the same
   *  reason: a creature this light does not choose to be out in it. */
  const weight = (env: { sun: number; rain: number; weather: number }): number => {
    if (env.weather >= 6) return 0;
    const day = Math.max(0, Math.min(1, (env.sun - 0.25) / 0.45));
    const wet = 1 - Math.min(1, env.rain * 1.6);
    return day * Math.max(0, wet);
  };

  return {
    name: NAME,
    init(ctx) {
      scene = ctx.scene;
      ensureTextures(ctx.scene);
    },
    update(ctx, dt) {
      const dtc = Math.min(dt, 100);
      const view = ctx.view;
      const w = forced ? 1 : weight(ctx.env);
      const target = suppressed ? 0 : w;
      gain += (target - gain) * Math.min(1, (dtc / GAIN_TAU) * 3);
      const g = gain * ctx.outdoor;
      const want = g < 0.02 ? 0 : Math.min(MAX_FLIT, Math.round((view.width * view.height) / AREA_PER));
      if (!scene) return;
      while (flits.length > want) flits.pop()!.sprite.destroy();
      while (flits.length < want) flits.push(make(scene));
      if (!flits.length) return;

      placeAge += dtc;
      const mayPlace = placeAge >= placeWait;
      /* ONE player read per frame for the whole population, not one each:
       * it is a probe call, and twelve of them a frame is twelve too many. */
      const you = playerAt(view);
      /* The iso plane again — un-squash y before any distance to the player,
       * or a butterfly is shy of someone twice as far away to the north. */
      const shyOf = (f: Flit) => (you ? shyness(you.x - f.x, (you.y - f.y) * (32 / 14)) : 0);

      for (let i = 0; i < flits.length; i++) {
        const f = flits[i];
        // off the view, or never placed: find a new meadow (rate-limited)
        const gone =
          f.x < view.x - OFF_VIEW || f.x > view.right + OFF_VIEW || f.y < view.y - OFF_VIEW || f.y > view.bottom + OFF_VIEW;
        if (gone || f.cruise === 0) {
          // `a` IS THE DRAWN ALPHA, always — the indoor gate and every gate
          // arm read it, and a butterfly parked off the view while it waits
          // for a meadow used to keep reporting the alpha it had before it
          // left. Over a sea with no grass in reach that read as four
          // butterflies flying over open water.
          const park = () => {
            f.a = 0;
            f.shy = 0;
            f.sprite.setVisible(false);
          };
          if (!mayPlace) {
            park();
            continue;
          }
          placeAge = 0;
          if (!place(f, view)) {
            park();
            continue;
          }
        }
        f.t += dtc;

        const shy = shyOf(f);
        f.shy = shy;
        if (f.settleT > 0) {
          /* IT TAKES OFF WHEN YOU REACH IT. This is the whole reason the
           * feature reads the player at all: a butterfly that sits there
           * while you walk into it is scenery, and one that leaves the grass
           * as you arrive is alive. Cutting the settle short to the start of
           * its lift-off means it rises from where it sat rather than
           * teleporting into the air. */
          if (shy > SHY_TAKEOFF && f.settleT < LAND_MS + f.settleHold) {
            f.settleT = LAND_MS + f.settleHold;
            stats.startled++;
          }
          f.settleT += dtc;
          f.alt = settleAlt(f.settleT, f.settleHold, f.cruise);
          if (f.settleT >= settleLife(f.settleHold)) {
            f.settleT = 0;
            f.settleIn = between(SETTLE_EVERY);
          }
        } else {
          f.settleIn -= dtc;
          // and it will not sit down while you are standing over it
          if (f.settleIn <= 0 && shy <= 0) {
            if (landableAt(f.x, f.y)) {
              f.settleT = 1;
              f.settleHold = between(SETTLE_MS);
              stats.settles++;
            } else {
              // over water or a cliff face: ask again shortly, not every frame
              f.settleIn = SETTLE_RETRY_MS;
            }
          }
          // a hard turn now and then, a gentle drift between
          f.flickIn -= dtc;
          let turn = 0;
          if (f.flickIn <= 0) {
            f.flickIn = between(FLICK_MS);
            turn = (rnd() < 0.5 ? -1 : 1) * between(FLICK_RAD);
          }
          if (shy > 0 && you) {
            // GETTING OUT OF YOUR WAY BEATS GOING HOME. The patch tether
            // would fight the flight and hold it in your path, which is the
            // one thing a startled butterfly must not do.
            turn += shyTurn(f.h, you.x - f.x, (you.y - f.y) * (32 / 14), dtc);
          } else {
            // back toward its patch when it has wandered off the edge of it.
            // The y difference is un-squashed first: on the iso plane a step
            // is 32 wide to 14 tall, so a raw dy makes the pull lopsided.
            turn += homePull(f.h, f.hx - f.x, (f.hy - f.y) * (32 / 14), dtc);
          }
          // wrapped, or a butterfly left running all afternoon loses precision
          // in the heading and starts to stutter
          f.h = (steer(f.h, dtc, rnd() * 2 - 1, turn) % TAU + TAU) % TAU;
          const v = speedAt(f.spd, f.t, f.beat, f.phase) * shySpeed(shy);
          // the iso ground plane: a step is wider than it is tall
          f.x += Math.cos(f.h) * v * (dtc / 1000);
          f.y += Math.sin(f.h) * v * (dtc / 1000) * (14 / 32);
          f.alt = f.cruise;
        }

        const down = f.settleT > 0 && settled(f.settleT, f.settleHold);
        const wg: Wing = down ? WING_CLOSED : wing(f.t, f.beat, f.phase);
        const lift = down ? 0 : bob(f.t, f.beat, f.phase, f.bobA);
        const a = g;
        f.a = a;
        f.sprite
          .setTexture(KEY(f.species.key, wg))
          .setPosition(Math.round(f.x), Math.round(f.y - f.alt + lift))
          .setDepth(DEPTH + f.y * DEPTH_BIAS)
          .setAlpha(a)
          .setVisible(a > 0.02);
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
        gain,
        suppressed,
        forced,
        weight: +weight({ sun: 1, rain: 0, weather: 0 }).toFixed(2),
        count: flits.length,
        ...stats,
        all: flits.map((f) => ({
          x: Math.round(f.x),
          y: Math.round(f.y),
          alt: Math.round(f.alt),
          wing: f.settleT > 0 && settled(f.settleT, f.settleHold) ? WING_CLOSED : wing(f.t, f.beat, f.phase),
          bob: f.settleT > 0 && settled(f.settleT, f.settleHold) ? 0 : bob(f.t, f.beat, f.phase, f.bobA),
          settling: f.settleT > 0,
          down: f.settleT > 0 && settled(f.settleT, f.settleHold),
          species: f.species.key,
          shy: +f.shy.toFixed(2),
          hx: Math.round(f.hx),
          hy: Math.round(f.hy),
          home: Math.round(Math.hypot(f.hx - f.x, (f.hy - f.y) * (32 / 14))),
          h: +f.h.toFixed(2),
          a: +f.a.toFixed(3),
        })),
      };
    },
    dispose() {
      for (const f of flits) f.sprite.destroy();
      flits.length = 0;
      scene = null;
    },
  };
}
