import Phaser from "phaser";
import { isRainy, isRough } from "../runtime/env";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { ABOVE_LIT, SRC_LIFT, SceneryPiece, sceneryInView } from "../runtime/scenery";
import { MAX_SAT, saturation } from "../runtime/palette";
import {
  ALT,
  BLUR,
  BODIES,
  DART,
  DART_LEN,
  DART_SPEED,
  HOVER,
  HOVER_MS,
  ISO_SQUASH,
  Mode,
  PERCH,
  PERCH_MS,
  Wing,
  dartAt,
  dartMs,
  facing,
  hoverJitter,
  perchAlt,
  wingOf,
} from "./dart";

/* DRAGONFLIES OVER THE REEDS — the waterline in summer.
 *
 * THE POINT OF THIS ONE IS THE CONTRAST WITH THE BUTTERFLIES. They share a
 * sky and they must never read as the same creature: a butterfly bobs and
 * drifts and never stops, and a dragonfly is parked, then a straight line at
 * speed, then parked again. If you can tell which is which at four pixels
 * with the colour turned off, this worked.
 *
 * IT BELONGS TO THE REEDS, not to the water. The maps2 agent placed 124
 * waterline pieces — 54 lily clumps, 35 cattail clumps, 35 reed beds — and a
 * dragonfly hunts the strip of air over them and perches on them. That is the
 * feature's whole sense of place, and it is asked of the game rather than
 * guessed: `runtime/scenery.ts` reads the drawn pieces out of the display
 * list by their published category, THROTTLED, because the probe behind it
 * walks every object on screen.
 *
 * A world with no reeds in view has no dragonflies, in the same way the moths
 * need a lamp and the crabs need a beach. It is not a field that fills the
 * sky; it is a handful of creatures over a specific patch of marsh.
 *
 * AND IT SORTS AGAINST ITS OWN REED, which is what makes it a creature you can
 * actually see. Every scenery piece draws twice — once on the painter line and
 * again as an opaque LIT COPY at `litDepth` (~900_001+) — while every ambient
 * mark sits just over the darkness overlay at ~900_000.0x, so a dragonfly
 * hovering 11-23 px over its reed's foot, and perching ON it, was painted
 * underneath the very thing it belongs to (maintainer 2026-09-21: "I have
 * never seen a dragonfly ever in this game"; measured at the marsh, dragonfly
 * 900_000.090 under a reed copy at 900_001.053). That is the same trap the
 * sparks and the moths paid for on 2026-09-09, and the same fix: take the
 * PIECE's own drawn depth plus a hair. It is a sort, not an override — the lit
 * band compresses painter depth by 1e-5, so a player standing in front of the
 * reeds still draws over the dragonfly.
 *
 * DAY, and warm: gone at night, gone in rain, gone in anything windy — a
 * hovering insect is the first thing a gust removes.
 */

const NAME = "dragonflies";
/* The flies sort among THEMSELVES by this, never by their y: each one is
 * already based on its OWN reed's copy, and reed copies are 1e-5 apart per
 * painter pixel — a y-scaled bias (5.3e-3 at the marsh) would jump a fly in
 * front of the NEXT reed along. Six flies, so at most 6e-6. */
const DEPTH_BIAS = 1e-6;
const GAIN_TAU = 1600;
const MAX_FLIES = 6;
/** One dragonfly per this many waterline pieces in view, capped. */
const PER_PIECE = 3;
/* HOW OFTEN THE SCENERY IS RE-SCANNED. The probe behind it walks the WHOLE
 * display list — 1,072 objects in a busy view — and that showed up as a 9.8 ms
 * single-frame spike, which is a dropped frame you can see. So the scan is
 * driven by the CAMERA MOVING, not by a timer: standing at a reed bed, the
 * pieces in view do not change, and rescanning them twice a second buys
 * nothing and costs a hitch. A slow heartbeat still runs underneath it so a
 * piece that fades in or is placed nearby is picked up eventually. */
const SCAN_MOVE_PX = 96;
/* Two heartbeats, because the two cases are not alike. Holding pieces, the
 * answer cannot change while the camera sits still — reeds do not walk — so
 * ask rarely. Holding none, we may be about to arrive at a marsh and there is
 * nothing on screen for a 3 ms frame to stutter, so ask often. */
const SCAN_IDLE_HELD_MS = 10_000;
const SCAN_IDLE_EMPTY_MS = 1500;
/* The scan reaches further than the view by MORE than the move that triggers
 * it (128 > 96), so a piece is always already known by the time it is on
 * screen. Get that the wrong way round and reeds pop in a beat late. */
const SCAN_PAD = 128;
/** How far from its reed a dragonfly will hunt, px on the ground plane. */
const BEAT_R = 74;

/** THE PIECES IT BELONGS TO, by the maps2 agent's own category names. */
const WATERLINE = new Set(["reed_beds", "cattail_clumps", "water_lily_clumps"]);

const KEY = (sp: number, w: Wing) => `amb-dfly${sp}_${w}`;

interface Fly {
  sprite: Phaser.GameObjects.Image;
  x: number; // ground point, world px
  y: number;
  alt: number;
  cruise: number;
  species: number;
  mode: Mode;
  t: number; // ms in the current mode
  hold: number; // how long this mode lasts
  fromX: number; // dart endpoints
  fromY: number;
  toX: number;
  toY: number;
  dartAlt: number;
  homeX: number; // the reed it works
  homeY: number;
  face: number;
  phase: number;
  a: number;
  depth: number; // its reed's lit copy + SRC_LIFT — see the header
}

export function dragonfliesFeature(): AmbientFeature {
  const flies: Fly[] = [];
  let scene: Phaser.Scene | null = null;
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let scanAge = 1e9;
  let scanX = NaN;
  let scanY = NaN;
  let pieces: SceneryPiece[] = [];
  let seed = 20260913;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const between = (r: readonly [number, number]) => r[0] + rnd() * (r[1] - r[0]);
  const stats = { placed: 0, darts: 0, perches: 0, pieces: 0, scans: 0 };

  const ensureTextures = (s: Phaser.Scene) => {
    if (s.textures.exists(KEY(0, 0))) return;
    const paint = (key: string, w: number, h: number, layers: { c: number; a: number; px: [number, number][] }[]) => {
      if (s.textures.exists(key)) return;
      const g = s.make.graphics({ x: 0, y: 0 }, false);
      for (const { c, a, px } of layers) {
        g.fillStyle(c, a);
        for (const [x, y] of px) g.fillRect(x, y, 1, 1);
      }
      g.generateTexture(key, w, h);
      g.destroy();
    };
    for (let sp = 0; sp < BODIES.length; sp++) {
      /* IN THE AIR: a long body with a HAZE across it. A beating wing at this
       * scale has no pose — four hundred a second — so the wings are a pale
       * half-alpha smear over and under the thorax, never a drawn pair. */
      paint(KEY(sp, 0), 7, 3, [
        { c: BLUR, a: 0.45, px: [[1, 0], [2, 0], [3, 0], [1, 2], [2, 2], [3, 2]] },
        { c: BODIES[sp], a: 1, px: [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1]] },
      ]);
      /* PERCHED: the wings RESOLVE, and they stay OUT. A butterfly folds its
       * wings up over its back at rest and a dragonfly never does — at four
       * pixels that silhouette is the whole difference between the two. */
      paint(KEY(sp, 1), 7, 3, [
        { c: BLUR, a: 0.8, px: [[1, 0], [3, 0], [1, 2], [3, 2]] },
        { c: BODIES[sp], a: 1, px: [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1]] },
      ]);
    }
  };

  const make = (s: Phaser.Scene): Fly => ({
    sprite: s.add.image(0, 0, KEY(0, 0)).setDepth(ABOVE_LIT).setVisible(false),
    x: 0, y: 0, alt: 16, cruise: 16, species: 0,
    mode: HOVER, t: 0, hold: 1000,
    fromX: 0, fromY: 0, toX: 0, toY: 0, dartAlt: 16,
    homeX: 0, homeY: 0, face: 1, phase: 0, a: 0, depth: ABOVE_LIT,
  });

  /** In front of the piece it belongs to — see the header. */
  const depthOf = (piece: SceneryPiece) => (piece.litDepth === null ? ABOVE_LIT : piece.litDepth + SRC_LIFT);

  /** Settle a dragonfly onto a piece's beat. */
  const place = (f: Fly, piece: SceneryPiece) => {
    f.homeX = piece.cx;
    f.homeY = piece.footY;
    f.depth = depthOf(piece);
    f.x = piece.cx + (rnd() * 2 - 1) * BEAT_R * 0.5;
    f.y = piece.footY + (rnd() * 2 - 1) * BEAT_R * 0.5 * ISO_SQUASH;
    f.cruise = between(ALT);
    f.alt = f.cruise;
    f.species = (rnd() * BODIES.length) | 0;
    f.mode = HOVER;
    f.t = 0;
    f.hold = between(HOVER_MS);
    f.phase = rnd();
    f.face = rnd() < 0.5 ? -1 : 1;
    stats.placed++;
  };

  /** Aim a dart: a straight segment, kept inside the beat around its reed. */
  const aim = (f: Fly) => {
    const len = between(DART_LEN);
    for (let tries = 0; tries < 5; tries++) {
      const h = rnd() * Math.PI * 2;
      const tx = f.x + Math.cos(h) * len;
      const ty = f.y + Math.sin(h) * len * ISO_SQUASH;
      const dx = tx - f.homeX;
      const dy = (ty - f.homeY) / ISO_SQUASH;
      if (Math.hypot(dx, dy) <= BEAT_R || tries === 4) {
        f.fromX = f.x; f.fromY = f.y; f.toX = tx; f.toY = ty;
        f.mode = DART;
        f.t = 0;
        f.hold = dartMs(len, between(DART_SPEED));
        f.face = facing(tx - f.x, f.face);
        f.dartAlt = f.cruise;
        stats.darts++;
        return;
      }
    }
  };

  /** Day, warm, still. */
  const weight = (env: { sun: number; active: ReadonlySet<string> }): number => {
    if (isRough(env)) return 0; // storm, snow, wind — nothing small hangs in it
    /* GONE IN RAIN, read off the ACTIVE WEATHER and never off `env.rain`.
     * Since the zones took over the weather sheet (2026-09-20) `env.rain` is
     * the DRAWN splash intensity of this view — the drop count the sheet
     * actually put on screen — so it reads 0 in a downpour whose zone is not
     * in view, and the dragonflies kept hovering through one. `isRough` on the
     * line above already asks the active set; this is the same question and
     * must come from the same place. The 1.6 s gain ramp is the fade. */
    if (isRainy(env)) return 0;
    return Math.max(0, Math.min(1, (env.sun - 0.22) / 0.4));
  };

  return {
    name: NAME,
    init(ctx) {
      scene = ctx.scene;
      ensureTextures(ctx.scene);
    },
    update(ctx, dt) {
      const dtc = Math.min(dt, 100);
      const w = forced ? 1 : weight(ctx.env);
      const target = suppressed ? 0 : w;
      gain += (target - gain) * Math.min(1, (dtc / GAIN_TAU) * 3);
      const g = gain * ctx.outdoor;
      if (!scene) return;

      scanAge += dtc;
      const moved = !(Math.abs(ctx.view.x - scanX) < SCAN_MOVE_PX && Math.abs(ctx.view.y - scanY) < SCAN_MOVE_PX);
      const idle = pieces.length ? SCAN_IDLE_HELD_MS : SCAN_IDLE_EMPTY_MS;
      /* REJECTED: a "is there water in view" pre-filter to skip the scan.
       * REEDS AND CATTAILS GROW ON MARSH MUD, NOT IN WATER — only the lilies
       * need water — and at the densest reed bed in the world `waterAtScreen`
       * answers false at all thirty sampled points. The filter cost the whole
       * feature its sense of place to save a 3 ms frame. Frequency is the only
       * honest lever here. */
      if (g > 0.02 && (moved || scanAge >= idle)) {
        scanAge = 0;
        scanX = ctx.view.x;
        scanY = ctx.view.y;
        pieces = sceneryInView(ctx.view, WATERLINE, SCAN_PAD);
        stats.pieces = pieces.length;
        stats.scans++;
        /* A REBUILT COPY IS A NEW OBJECT at a new depth, so a fly that is
         * already working a reed re-reads it here rather than keeping the
         * number it was born with — otherwise one camera latch puts it back
         * behind the reed. Matched on the home point, which `place` copied
         * from the piece, so the match is exact until the piece moves. */
        for (const f of flies) {
          let best: SceneryPiece | null = null;
          let bestD = 8;
          for (const p of pieces) {
            const d = Math.hypot(p.cx - f.homeX, p.footY - f.homeY);
            if (d < bestD) { bestD = d; best = p; }
          }
          if (best) f.depth = depthOf(best);
        }
      }

      const want = g < 0.02 || !pieces.length ? 0 : Math.min(MAX_FLIES, Math.ceil(pieces.length / PER_PIECE));
      while (flies.length > want) flies.pop()!.sprite.destroy();
      while (flies.length < want) {
        const f = make(scene);
        place(f, pieces[(rnd() * pieces.length) | 0]);
        flies.push(f);
      }
      if (!flies.length) return;

      for (let i = 0; i < flies.length; i++) {
        const f = flies[i];
        f.t += dtc;
        // its reed left the view: adopt another one
        if (pieces.length && (f.homeX < ctx.view.x - 200 || f.homeX > ctx.view.x + ctx.view.width + 200))
          place(f, pieces[(rnd() * pieces.length) | 0]);

        if (f.mode === DART) {
          const u = dartAt(f.t, f.hold);
          f.x = f.fromX + (f.toX - f.fromX) * u;
          f.y = f.fromY + (f.toY - f.fromY) * u;
          f.alt = f.dartAlt;
          if (u >= 1) {
            // STOPS DEAD. No coast, no ease — that is the whole creature.
            f.mode = HOVER;
            f.t = 0;
            f.hold = between(HOVER_MS);
          }
        } else if (f.mode === PERCH) {
          const LAND = 260;
          if (f.t < LAND) f.alt = perchAlt(f.t, LAND, f.cruise, 0);
          else if (f.t > f.hold - LAND) f.alt = perchAlt(f.t - (f.hold - LAND), LAND, 0, f.cruise);
          else f.alt = 0;
          if (f.t >= f.hold) {
            f.mode = HOVER;
            f.t = 0;
            f.hold = between(HOVER_MS);
          }
        } else {
          f.alt = f.cruise;
          if (f.t >= f.hold) {
            // a hover ends in a dart, or now and then in a perch on its reed
            if (rnd() < 0.22) {
              f.mode = PERCH;
              f.t = 0;
              f.hold = between(PERCH_MS);
              f.x = f.homeX + (rnd() * 2 - 1) * 6;
              f.y = f.homeY - 2;
              stats.perches++;
            } else aim(f);
          }
        }

        const j = f.mode === HOVER ? hoverJitter(f.t, f.phase) : { x: 0, y: 0 };
        const wing: Wing = wingOf(f.mode);
        const a = g;
        f.a = a;
        f.sprite
          .setTexture(KEY(f.species, wing))
          .setFlipX(f.face < 0)
          .setPosition(Math.round(f.x + j.x), Math.round(f.y - f.alt + j.y))
          .setDepth(f.depth + i * DEPTH_BIAS)
          .setAlpha(a)
          .setVisible(a > 0.02);
      }
    },
    setSuppressed(on) { suppressed = on; },
    setForced(on) { forced = on; },
    debug() {
      return {
        gain,
        suppressed,
        forced,
        weight: +weight({ sun: 1, active: new Set<string>() }).toFixed(2),
        count: flies.length,
        ...stats,
        maxSat: MAX_SAT,
        sats: BODIES.map((c) => +saturation(c).toFixed(2)),
        all: flies.map((f) => ({
          x: Math.round(f.x),
          y: Math.round(f.y),
          alt: Math.round(f.alt),
          mode: f.mode,
          wing: wingOf(f.mode),
          species: f.species,
          home: Math.round(Math.hypot(f.homeX - f.x, (f.homeY - f.y) / ISO_SQUASH)),
          // The reed it works, and the depth it took FROM that reed: the gate
          // joins the two to prove the sort is per piece and not a constant.
          hx: Math.round(f.homeX),
          hy: Math.round(f.homeY),
          depth: +f.depth.toFixed(6),
          a: +f.a.toFixed(3),
        })),
      };
    },
    dispose() {
      for (const f of flies) f.sprite.destroy();
      flies.length = 0;
      scene = null;
    },
  };
}
