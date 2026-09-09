import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { crawlerTint, findGround, flatWith, landableAt, levelAt, paintPixels } from "../runtime/ground";

// ANTS — a FIELD effect, and the smallest thing this agent draws.
//
// An ant is ONE PIXEL. There is deliberately no art pipeline behind it: the
// flocks get 34px 8-direction PixelLab objects with flap cycles because a bird
// is big enough on screen to READ as a bird, and an ant is not (maintainer
// 2026-09-06: "they should be so small using pixelart like we did for the birds
// make no sense"). At this size a sprite sheet would be a lie — you cannot see
// a leg, and a 1px dot rendered from eight directions is the same dot eight
// times.
//
// So the behaviour carries it, and for ants the behaviour is THE TRAIL. A lone
// moving dot is a speck of dust; a dozen dots nose-to-tail along one curved
// line, some going out and some coming back, is unmistakably ants — the eye
// reads the column, not the animal. That is the whole design: get the trail
// right and the ant is free.
//
// A trail runs between two spots of dry ground, holds for a while, then the
// colony moves on and a new line is laid somewhere else.

/* ABOVE THE DARKNESS OVERLAY, AND THAT IS DELIBERATE.
 *
 * The house rule is that ground-lit matter graded by time of day belongs UNDER
 * 900_000, and these obeyed it — which is why a night spider measured SIXTEEN
 * luma of contrast against its own ground even after its tint was paled: the
 * overlay MULTIPLIES, so it takes a pale 1-3 px speck down exactly as far as it
 * takes the ground under it, and the two stay indistinguishable by
 * construction. There is no tint that survives that.
 *
 * At this size the two goals cannot both hold: an animal that is one to three
 * pixels is either graded with the world or visible in it. The game already
 * makes this call for the hidden-behind outline, which draws above the overlay
 * for exactly the same reason — legibility beats grading when the mark IS the
 * information. So the crawlers draw a hair above it, keeping their own y-order,
 * and take a gentler alpha after dark so they read as a silhouette on the
 * ground rather than as a light on it. `ctx.outdoor` still stops them indoors.
 */
const DEPTH_BASE = 900_000.05; // just over the darkness overlay
const DEPTH_BIAS = 1e-6; // keeps their own near-far order among themselves
const NIGHT_ALPHA = 0.8; // a silhouette after dark, never a lamp
const GAIN_TAU = 1400;
const TRAIL_LIFE: [number, number] = [26_000, 55_000]; // then the colony re-routes
const RELAY_MS = 900; // how often the trail re-checks that it still lies on ground
const N_ANTS: [number, number] = [9, 20];
const SPAN: [number, number] = [70, 170]; // drawn px between the trail's two ends
const SPAN_VIEW_FRAC = 0.42; // ...and never longer than this much of the view
const ANCHOR_INSET = 0.22; // lay the first end inside this margin of the view
const SPEED: [number, number] = [11, 20]; // drawn px/s along the line
const WOBBLE = 1.4; // px of lateral sway — ants do not walk a ruled line
const SAMPLES = 28; // polyline points the curve is flattened to
const MARGIN = 10; // dry ground required around each end (see findGround)
const MIN_ON_SCREEN = 0.3; // re-lay once less than this much of the trail is in view
/* A COLONY LEAVES ONE ANT AT A TIME (maintainer 2026-09-07: "I don't like the
 * way you 'pop' the ants out of existence. Can you let the ant disappear one by
 * one over time?"). When a trail's time is up the ants do not vanish together:
 * each has its own delay before it goes and its own fade, so the line thins out
 * the way a real one does, and the next colony arrives the same way.
 *
 * A trail the player has LEFT BEHIND is exempt — it is off screen, nobody can
 * watch it go, and waiting the spread out before laying a new one would mean
 * arriving somewhere new and standing in an empty field for eight seconds. */
const LEAVE_SPREAD: [number, number] = [400, 7000]; // per ant, before it starts to go
const ARRIVE_SPREAD: [number, number] = [0, 2600]; // per ant, before it joins
const FADE_MS = 700; // one ant's own fade, either way
const SPAN_FALLBACK = [1, 0.7, 0.45, 0.3]; // shorter rather than no trail at all
const HEADING_TRIES = 6; // directions tried at each length

const KEY_SMALL = "amb-ant1";
const KEY_BIG = "amb-ant2";
const ANT_DARK = 0x241a12; // near-black brown, at every hour — an ant is never pale

interface Ant {
  sprite: Phaser.GameObjects.Image;
  t: number; // 0..1 along the trail
  dir: 1 | -1; // out to the food, or back to the nest
  spd: number;
  phase: number; // wobble phase
  big: boolean;
  /* EACH ANT KEEPS ITS OWN CLOCK. `wait` is the ms before it joins a new trail
   * or, while the colony is leaving, before it goes; `a` is its own 0..1
   * opacity, eased so it walks off rather than blinking out. */
  wait: number;
  a: number;
  gone: boolean;
}

export function antsFeature(): AmbientFeature {
  const ants: Ant[] = [];
  let path: { x: number; y: number }[] = [];
  let box = { x0: 0, y0: 0, x1: 0, y1: 0 }; // the trail's extent, for the on-screen test
  let pathLen = 0;
  let trailLvl: number | null = null; // the terrace this trail lies on
  let leaving = false; // the colony is thinning out, one ant at a time
  let life = 0;
  let relay = 0;
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let seed = 91;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const range = ([a, b]: [number, number]) => a + rnd() * (b - a);

  /** Lay a new trail: two ends on dry ground, joined by a cubic curve whose
   * control points bow it sideways, then flattened to a polyline. Ants follow
   * the polyline, so nothing downstream has to know about curves. */
  const layTrail = (ctx: AmbientCtx): boolean => {
    // Anchor INSIDE the view, not merely within it: a trail hung on the edge
    // puts most of its ants off screen, where they are worth nothing.
    const v = ctx.view;
    const inner = {
      x: v.x + v.width * ANCHOR_INSET,
      y: v.y + v.height * ANCHOR_INSET,
      width: v.width * (1 - 2 * ANCHOR_INSET),
      height: v.height * (1 - 2 * ANCHOR_INSET),
    };
    const a = findGround(inner, rnd, MARGIN);
    if (!a) return false;
    /* ONE TERRACE. Everything below is checked against the ANCHOR's level, so a
     * trail can never run over a cliff edge — see `levelAt`. */
    const lvl = levelAt(a.x, a.y);
    /* TRY SHORTER BEFORE GIVING UP. A colony has to be able to lay a line
     * wherever the player stops, and the full span is a long straight demand on
     * open ground: in a wood or a village the far end lands in a wall, a
     * hearth or the sea, the lay fails, and the ants stay hidden — which is
     * what "I see no spiders and ants if I run away to a different location"
     * looks like from inside this feature (maintainer 2026-09-07). A short
     * trail is a real trail; no trail is not. */
    const full = Math.min(range(SPAN), Math.min(ctx.view.width, ctx.view.height * 2) * SPAN_VIEW_FRAC);
    let span = 0;
    let b: { x: number; y: number } | null = null;
    for (const frac of SPAN_FALLBACK) {
      for (let t = 0; t < HEADING_TRIES; t++) {
        const th = rnd() * Math.PI * 2;
        const L = full * frac;
        const cand = { x: Math.round(a.x + Math.cos(th) * L), y: Math.round(a.y + Math.sin(th) * L * 0.6) };
        if (!flatWith(lvl, cand.x, cand.y)) continue;
        span = L;
        b = cand;
        break;
      }
      if (b) break;
    }
    if (!b) return false;
    // Bow the line so a trail never reads as a drawn ruler.
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const nx = -(b.y - a.y);
    const ny = b.x - a.x;
    const nl = Math.hypot(nx, ny) || 1;
    const bow = (rnd() - 0.5) * span * 0.35;
    const c = { x: mx + (nx / nl) * bow, y: my + (ny / nl) * bow };
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / (SAMPLES - 1);
      const u = 1 - t;
      pts.push({
        x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
        y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
      });
    }
    // A trail that crosses water or a cliff face is worse than no trail — so
    // check the BAND THE ANTS ACTUALLY WALK, every sample and both wobble
    // extremes, not every fourth centre point. A bowed 170px trail sampled
    // every fourth point leaves ~24px between checks, and the gate caught an
    // ant standing on water in the gap. This runs once per trail (every 26-55s
    // per colony), so exhaustive is free.
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i];
      const r = pts[Math.min(pts.length - 1, i + 1)];
      const tx = r.x - q.x;
      const ty = r.y - q.y;
      const tl = Math.hypot(tx, ty) || 1;
      for (const w of [0, WOBBLE, -WOBBLE])
        if (!flatWith(lvl, Math.round(q.x - (ty / tl) * w), Math.round(q.y + (tx / tl) * w))) return false;
    }
    path = pts;
    box = pts.reduce(
      (m, q) => ({ x0: Math.min(m.x0, q.x), y0: Math.min(m.y0, q.y), x1: Math.max(m.x1, q.x), y1: Math.max(m.y1, q.y) }),
      { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
    );
    pathLen = 0;
    for (let i = 1; i < pts.length; i++) pathLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    trailLvl = lvl;
    life = range(TRAIL_LIFE);
    return true;
  };

  /** Position + heading at parameter t along the flattened trail. */
  const at = (t: number) => {
    const f = Math.max(0, Math.min(0.9999, t)) * (path.length - 1);
    const i = f | 0;
    const k = f - i;
    const p = path[i];
    const q = path[Math.min(path.length - 1, i + 1)];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: p.x + dx * k, y: p.y + dy * k, nx: -dy / l, ny: dx / l };
  };

  return {
    name: "ants",
    init(ctx) {
      // WHITE art: the drawn colour is the per-frame tint (crawlerTint).
      paintPixels(ctx.scene, KEY_SMALL, 1, 1, 0xffffff, [[0, 0]]);
      // The bigger ones are two pixels along their own travel — enough to read
      // as "a slightly larger ant" without becoming a drawn insect.
      paintPixels(ctx.scene, KEY_BIG, 2, 1, 0xffffff, [[0, 0], [1, 0]]);
    },
    update(ctx, dt) {
      // Daytime foragers. Heavy cloud thins them; they are a fair-weather sight.
      const target = forced ? 1 : suppressed ? 0 : ctx.env.sun * (1 - 0.5 * ctx.env.cloud);
      gain += (target - gain) * Math.min(1, (dt / GAIN_TAU) * 3);
      const g = gain * ctx.outdoor; // stops indoors, like every effect here
      const visible = g > 0.02;

      if (!visible) {
        for (const a of ants) if (a.sprite.visible) a.sprite.setVisible(false);
        return;
      }

      // Re-lay the trail when it expires, when there is none, or when the view
      // has moved far enough that the old line is no longer on screen.
      life -= dt;
      relay -= dt;
      const v = ctx.view;
      // OFF SCREEN = too little of the trail is in the view to be worth
      // drawing. Asked as a FRACTION of the line, not as a box test: the ants
      // are spread over the whole path, so "some of the line is on screen" is
      // the only phrasing that guarantees some ANTS are. The box tests before
      // it both failed the same way — the first asked only where ONE END was
      // (measured ants at screen (-53, 238) while the feature reported itself
      // healthy), and the second, "the whole extent has left the view plus 24px
      // of slack", still kept a trail whose every ant was outside the frame.
      const inView = path.length
        ? path.filter((q) => q.x >= v.x && q.x <= v.x + v.width && q.y >= v.y && q.y <= v.y + v.height).length /
          path.length
        : 0;
      const off = path.length > 0 && inView < MIN_ON_SCREEN;

      /** Start a colony on a fresh trail: every ant re-rolled, each arriving on
       * its own delay. `instant` skips the stagger, for a colony nobody is
       * looking at (see LEAVE_SPREAD). */
      const settle = (instant: boolean) => {
        const want = Math.round(range(N_ANTS));
        while (ants.length < want)
          ants.push({
            sprite: ctx.scene.add.image(0, 0, KEY_SMALL).setOrigin(0, 0).setScale(1).setVisible(false),
            t: rnd(), dir: rnd() < 0.5 ? 1 : -1, spd: range(SPEED), phase: rnd() * Math.PI * 2,
            big: false, wait: 0, a: 0, gone: false,
          });
        for (const a of ants) {
          a.t = rnd();
          a.dir = rnd() < 0.5 ? 1 : -1;
          a.spd = range(SPEED);
          a.big = rnd() < 0.18;
          a.wait = instant ? 0 : range(ARRIVE_SPREAD);
          a.a = instant ? 1 : 0;
          a.gone = false;
          a.sprite.setTexture(a.big ? KEY_BIG : KEY_SMALL);
        }
        leaving = false;
      };

      if (path.length === 0 || off) {
        // No trail, or one the player has walked away from: replace it outright.
        if (!layTrail(ctx)) {
          for (const a of ants) a.sprite.setVisible(false);
          return;
        }
        settle(true);
      } else if (life <= 0 && !leaving) {
        // Its time is up WHILE IT IS BEING WATCHED: the colony thins out.
        leaving = true;
        for (const a of ants) a.wait = range(LEAVE_SPREAD);
      } else if (leaving && ants.every((a) => a.gone)) {
        // The last one has left — the colony moves on and a new line forms.
        if (!layTrail(ctx)) return;
        settle(false);
      }
      // The ground under a trail can change (a bridge deck, a tide of props);
      // re-check one point occasionally rather than every ant every frame.
      if (relay <= 0) {
        relay = RELAY_MS;
        const p = path[(rnd() * path.length) | 0];
        if (!flatWith(trailLvl, Math.round(p.x), Math.round(p.y))) life = 0;
      }

      const s = dt / 1000;
      for (const a of ants) {
        // Its own clock: wait, then fade in or out over FADE_MS.
        a.wait = Math.max(0, a.wait - dt);
        const want = leaving ? (a.wait > 0 ? 1 : 0) : a.wait > 0 ? 0 : 1;
        a.a = want > a.a ? Math.min(1, a.a + dt / FADE_MS) : Math.max(0, a.a - dt / FADE_MS);
        a.gone = leaving && a.a <= 0;
        if (a.a <= 0) { a.sprite.setVisible(false); continue; }
        a.t += (a.dir * a.spd * s) / (pathLen || 1);
        // Ants turn round at the ends — a nest and a food source, not a loop.
        if (a.t > 1) { a.t = 1; a.dir = -1; }
        if (a.t < 0) { a.t = 0; a.dir = 1; }
        a.phase += dt * 0.006;
        const p = at(a.t);
        const w = Math.sin(a.phase) * WOBBLE;
        const x = Math.round(p.x + p.nx * w);
        const y = Math.round(p.y + p.ny * w);
        a.sprite
          .setPosition(x, y)
          .setDepth(DEPTH_BASE + y * DEPTH_BIAS)
          .setTint(crawlerTint(ANT_DARK, ctx.env))
          .setAlpha(g * a.a * (1 - (1 - NIGHT_ALPHA) * ctx.env.night))
          .setVisible(true);
      }
    },
    setSuppressed(on) { suppressed = on; },
    setForced(on) { forced = on; },
    debug() {
      return {
        gain: +gain.toFixed(3),
        trail: path.length ? { from: { x: Math.round(path[0].x), y: Math.round(path[0].y) }, len: Math.round(pathLen) } : null,
        lifeMs: Math.max(0, Math.round(life)),
        ants: ants.filter((a) => a.sprite.visible).length,
        all: ants.filter((a) => a.sprite.visible).map((a) => ({ x: a.sprite.x, y: a.sprite.y, t: +a.t.toFixed(3), dir: a.dir, a: +a.sprite.alpha.toFixed(3) })),
      };
    },
    dispose() {
      for (const a of ants) a.sprite.destroy();
      ants.length = 0;
      path = [];
    },
  };
}
