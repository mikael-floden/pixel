import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { ANGLE_STEPS, DrawnFlow, angleIndex, drawnFlow, rasterLine } from "./current";
import { GLINT_SHAPES, GLINT_SIZE, reflection } from "../runtime/glint";

// THE SEAWARD CURRENT — deep water is the END OF THE WORLD, and this is what
// that looks like (maintainer 2026-09-06: "deep_water is something we use to
// mark 'end of world'. When the player swim into deep_water we drag them back
// ... it would be cool if deep_water was able to visualize the waves taking you
// back in better").
//
// Until now the ambient layer drew the SAME lake chop on a pond and on the open
// sea, because it could not tell them apart: `water` and `deep_water` carry
// identical Surface records, so neither `waterAtScreen` nor `surfaceAt` sees a
// difference. The game grew a seam for it (`__ml.deepCurrentAtScreen`) and this
// feature is what reads it.
//
// It draws the REAL current, not a decoration of one. `deepCurrentAt` is the
// same function the server integrates and the client predicts, so every mark
// here streams along the exact vector the swimmer is being pushed along, at the
// speed they are being pushed. Swim out and the sea visibly carries you back at
// the rate it is actually carrying you; stop fighting it and the drift and your
// body drift together. That is the whole idea — a force you can read, not a
// wall you bump into.
//
// TWO LAYERS, because one speed reads as a sliding sheet rather than water:
//   • SWELLS  — long dim lines ACROSS the flow, marching inward at the current
//     itself. These are the waves that carry you. Sparse, slow to fade.
//   • DRIFT   — single specks riding slightly FASTER than the current, so they
//     skate over the swells. Never slower: drift the swimmer overtakes would
//     read as being dragged out. SPECKS, NOT STREAKS: a streak along the flow
//     draws a line ACROSS the crests, and the crossing lines read as a mesh
//     rather than as water (maintainer 2026-09-06: "should not have that line
//     perpendicular to the wave direction"). A speck carries the same motion
//     with no line at all.
//
// A swell is RASTERISED at whatever angle the current runs there — free
// rotation, never a rotated sprite (see current.ts): pixel art may not be
// resampled, but Bresenham at any angle is exact pixel art and lands on the
// world's own grid. A speck needs no angle at all. Both sit CLOSE to
// deep_water's own colour: this is the sea moving, not sparkling on it.
// Strength (0 in the free shallows, 1 out at sea) scales count, brightness and
// length, so the current FADES IN over the shoreline band exactly where the
// player crosses into it rather than switching on at a line.

const DEPTH_SWELL = 900_000.34; // above the darkness overlay, below the water feature's chop
const DEPTH_DRIFT = 900_000.36;
const DEPTH_SPARK = 900_000.38; // over its own crest
const GAIN_TAU = 900;
const SAMPLE_MS = 260; // how often the view is re-scanned for open sea
const GRID = 5; // GRID x GRID probe samples across the view (spawn candidates)
const RECHECK_MS = 380; // how often a live mark re-asks whether it is still at sea
/* Probe calls serviced per frame, at most. The probe runs the game's own
 * screen->ground resolve, which walks every level of the column — 47 of them on
 * the_game — so its cost is real and, worse, it SCALES WITH THE FRAME TIME: at
 * dt >= RECHECK_MS every mark comes due every frame, so a machine that is
 * already struggling pays the most. Measured at a starved 5fps that was +44 ms
 * a frame. Round-robin under a fixed budget makes the bill flat instead: marks
 * that miss their turn keep drifting on the last flow they read, which is
 * exactly right — the current varies slowly across the sea, and a mark is only
 * a few tens of pixels from where it last asked. */
/* ...but staleness must be bounded in SPACE, not only in time. The budget is a
 * frame-rate compromise; what the eye actually notices is a mark carrying a
 * reading from somewhere the current was different, and the current varies over
 * DISTANCE (steeply so across the shoreline ramp, which climbs 0 -> full over
 * about 176 px). So a mark that has travelled this far since its last reading
 * probes regardless of whose turn it is: the budget then costs nothing on a
 * healthy frame and pays exactly where correctness needs it on a slow one. */
const RECHECK_PX = 44;
const SWELL_PROBE_BUDGET = 2;
const DRIFT_PROBE_BUDGET = 2;
const AREA_PER_SWELL = 3400;
const AREA_PER_DRIFT = 7600;
const MAX_SWELL = 16;
const MAX_DRIFT = 9;
const DRIFT_LEAD = 1.35; // drift runs this much faster than the current it rides

/* HOW FAST THE PICTURE MOVES — not how fast the current does.
 *
 * The marks used to run at the current's own rate, which is 0 in the free
 * shallows and 120 wu/s out at sea, and the maintainer's verdict on that is the
 * spec now (2026-09-07): "It's like you try to make them the same speed the
 * player get pushed back, but that feels too fast and at the start a bit too
 * slow." Both halves are the same fault — an unbounded range. Water does not
 * stand still where a current is weak, and a sea running at a swimmer's tow
 * speed reads as a conveyor belt.
 *
 * So the rate is a NARROW BAND that still ranks with the current: strength 0
 * shows SHOW_MIN_WU, strength 1 shows SHOW_MAX_WU, linearly. The sea still
 * visibly quickens as you swim out — that ordering is the mechanic, and it is
 * what the gate checks — it simply no longer runs from a standstill to a
 * gallop. The projection scale still multiplies (`DrawnFlow.scale`), so marks
 * on different headings stay in step with the water they are drawn on. */
const SHOW_MIN_WU = 17; // the shallows drift instead of freezing
const SHOW_MAX_WU = 41; // the open sea rolls; it does not race (the current is 120)
const showSpeed = (f: DrawnFlow): number => f.scale * (SHOW_MIN_WU + (SHOW_MAX_WU - SHOW_MIN_WU) * f.strength);
/* SPACING, and the reason it is enforced every frame rather than only at
 * placement (maintainer 2026-09-07: "the wave speed is so small at the
 * intersection all lines group up at that location ... if a lot of waves group
 * up at that spot they need to be removed earlier so we kinda always have the
 * same wave density"). The current CONVERGES — that is what a current running
 * at land does — so marks placed evenly are carried together, and where the
 * flow stalls they arrive and stay: spacing checked once, at birth, cannot
 * survive a field that transports its own marks into a heap. So a crowded mark
 * is retired early and re-placed somewhere the sea is empty, which holds the
 * COUNT (density) constant while keeping the marks apart. */
const SWELL_MIN_DIST = 26; // crests are 27-53px lines; they need real air
const DRIFT_MIN_DIST = 13; // a speck needs only its own space
const STALL_PX_S = 14; // below this a mark is parked, not flowing: retire it
const CROWD_MS = 260; // how long a retired mark has left — it fades, never blinks
const PLACE_TRIES = 10;

// Swells come in three lengths so ranks of them read as sea rather than as a
// drawn grid. Long: a crest has to span a good part of the view to be a WAVE
// and not a tick mark.
const SWELL_LENS = [27, 39, 53];
const DRIFT_PX = 1; // a speck. NOT a streak — see the header.

const SWELL_KEY = (i: number, L: number) => `amb-dwswell${i}_${L}`;
// 64 angles x 3 lengths, so they are built ON DEMAND: a view uses a handful of
// angles (the current turns smoothly), and generating all 192 up front would
// cost the join a stall for art most seas never show.
const DRIFT_KEY = () => `amb-dwfoam`;
const SPARK_KEYS = ["amb-dwspark0", "amb-dwspark1", "amb-dwspark2"];

/* THE GLITTER — THE LAKE'S OWN GLINT, RIDING A WAVE (maintainer 2026-09-07:
 * "I want the same bright sparks as we have in regular water. A small part of
 * the wave should be able to glimmer in very bright/close to white ... We just
 * can't glimmer the entire wave because it's longer, and we can't put the other
 * effect because it looks like static water and this one moves like waves ...
 * if you do that effect has to move with the waves").
 *
 * So it IS the other effect, with the one thing that made it wrong out here
 * fixed: `runtime/glint.ts` holds the shape and the sun/moon palette, `water/`
 * sparkles with it on a pond, and here each spark is PARENTED TO A CREST — it
 * picks a live swell and a point along that swell's own line and travels with
 * it, so the glimmer moves as the wave moves instead of sitting still on water
 * that is running past it.
 *
 * BRIGHT ON PURPOSE, and the one thing here allowed to be: the crest itself
 * sits close to the sea's own colour ("pop less"), and a glint that inherited
 * that restraint would not be a glint at all. It is near-white, it is 3x3, and
 * it is a few pixels of a 27-53px line — a small part of the wave, never the
 * line. */
const MAX_SPARK = 7;
const SPARK_MS: [number, number] = [220, 460]; // long enough to twinkle through its frames
const SPARK_FRAME_MS: [number, number] = [70, 130]; // the in-place twinkle, as on the lake
const SPARK_GAP: [number, number] = [260, 1500]; // dark between glints, per slot
const SPARK_ALPHA: [number, number] = [0.75, 1]; // near-white: this is the glimmer
const SPARK_INSET = 0.16; // never at the very tip of a crest: it reads as a longer line
const SPARK_COLOR = 0xffffff; // painted white, TINTED to the sun or moon per mark
const DRIFT_FRAMES = 1; // a speck has nothing to animate

/* These draw ADDITIVE over the sea, so what ships is water + colour x alpha and
 * only the COMPOSITE says how loud it is. The maintainer's note (2026-09-06):
 * the waves "should pop less, should be similar in color to the deep_water".
 * Measured on the day-lit open sea, which draws far lighter than deep_water's
 * material colour (#cbd8d8 on screen): a crest lifts it by a median of +27 per
 * channel and never past +49. Raising either of these is how the effect gets
 * loud again; verify-deepwater fails past a p99 of +60. */
const DRIFT_BODY = 0x9fd2de;
const SWELL_LINE = 0x9fd2de;
const NIGHT_TINT = 0x8fa8cc; // marks wash toward moonlit blue after dark

const lerpC = (a: number, b: number, t: number) => {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (((Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t)) >>> 0);
};

interface Mark {
  sprite: Phaser.GameObjects.Image;
  x: number; // drawn world position, floats; the SPRITE is snapped to integers
  y: number;
  ux: number; // drawn unit direction of travel
  uy: number;
  cx: number; // drawn unit direction the CREST lies along (a world quarter turn)
  cy: number;
  spd: number; // drawn px/s
  dir: number; // which rasterised angle is currently drawn
  fi: number;
  seqT: number;
  frameDur: number;
  life: number;
  maxLife: number;
  base: number;
  strength: number;
  travel: number; // px drifted since the last reading (see RECHECK_PX)
  li: number; // which SWELL_LENS entry (swells only)
  age: number; // ms since the last deep-water re-check
}

export function deepWaterFeature(): AmbientFeature {
  const swells: Mark[] = [];
  const drift: Mark[] = [];
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let sampleAge = SAMPLE_MS;
  let seaPts: { x: number; y: number; flow: DrawnFlow }[] = [];
  let seaFrac = 0;
  let meanStrength = 0;
  // Round-robin cursors for the probe budget. A plain "first N due marks win"
  // budget is not fair: the lists are walked in a fixed order, so the head of
  // the first list would take the whole allowance every frame and the tail —
  // all of the drift — could go unchecked indefinitely and stream up a beach.
  let swellCursor = 0;
  let foamCursor = 0;
  let seed = 61;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  /** The game's deep-sea current at a DRAWN point, already projected. Fenced
   * like every probe read: an older client (or a world with no open sea) has no
   * probe, reads as "no current", and the whole feature simply stays dark. */
  const flowAt = (wx: number, wy: number): DrawnFlow | null => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const f = ml?.deepCurrentAtScreen as
      | undefined
      | ((x: number, y: number) => { dx: number; dy: number; speed: number } | null);
    if (!f) return null;
    try {
      return drawnFlow(f(wx, wy));
    } catch {
      return null;
    }
  };

  const paintTex = (scene: Phaser.Scene, key: string, w: number, h: number, c: number, px: [number, number][]) => {
    if (scene.textures.exists(key)) return;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(c, 1);
    for (const [x, y] of px) g.fillRect(x, y, 1, 1);
    g.generateTexture(key, w, h);
    g.destroy();
  };

  const ensureTextures = (scene: Phaser.Scene) => {
    // Drift and sparks are one pixel each; no per-direction art at all.
    paintTex(scene, DRIFT_KEY(), DRIFT_PX, DRIFT_PX, DRIFT_BODY, [[0, 0]]);
    GLINT_SHAPES.forEach((px, i) =>
      paintTex(scene, SPARK_KEYS[i], GLINT_SIZE, GLINT_SIZE, SPARK_COLOR, px.map(([x, y]) => [x, y] as [number, number])),
    );
  };

  /** The crest sprite for one angle and length, rasterised the first time that
   * angle is actually used. A crest is a SINGLE line: it used to carry a
   * second, dimmer line a pixel down-current as a "back slope", but these draw
   * ADDITIVE, so that line brightened the water instead of shading it and read
   * as a doubled crest. */
  const swellKey = (scene: Phaser.Scene, i: number, L: number): string => {
    const key = SWELL_KEY(i, L);
    if (!scene.textures.exists(key)) {
      const line = rasterLine(i, SWELL_LENS[L]);
      paintTex(scene, key, line.w, line.h, SWELL_LINE, line.px);
    }
    return key;
  };

  const tooClose = (list: Mark[], gap: number, x: number, y: number, self: Mark): boolean => {
    for (const o of list)
      if (o !== self && o.sprite.visible && Math.abs(o.x - x) < gap && Math.abs(o.y - y) < gap) return true;
    return false;
  };

  /** Hold the spacing against a field that carries marks together, and drop a
   * mark the current has parked. Retiring shortens LIFE rather than hiding the
   * sprite, so the envelope fades it out and the loop re-places it — the count
   * never changes, only where the marks are. O(n^2) over at most 30 marks. */
  const spaceOut = (list: Mark[], gap: number) => {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.sprite.visible || a.life <= 0) continue;
      if (a.spd < STALL_PX_S) { a.life = Math.min(a.life, CROWD_MS); continue; }
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.sprite.visible || b.life <= 0) continue;
        if (Math.abs(a.x - b.x) < gap && Math.abs(a.y - b.y) < gap) {
          // Retire whichever is nearer the end of its life: the older wave has
          // already been read, and the younger one keeps the sea moving.
          const go = a.life < b.life ? a : b;
          go.life = Math.min(go.life, CROWD_MS);
        }
      }
    }
  };

  /** Drop a mark on open sea, taking its direction and speed from the current
   * that is actually there. Returns false when no spot is found (the mark stays
   * hidden and tries again next time). */
  const place = (m: Mark, list: Mark[], gap: number, spaced = true): boolean => {
    if (!seaPts.length) return false;
    for (let t = 0; t < PLACE_TRIES; t++) {
      const p = seaPts[(rnd() * seaPts.length) | 0];
      const x = Math.round(p.x + (rnd() - 0.5) * 90);
      const y = Math.round(p.y + (rnd() - 0.5) * 60);
      const flow = flowAt(x, y);
      if (!flow) continue; // drifted onto a lake, a beach, or the free shallows
      if (spaced && tooClose(list, gap, x, y, m)) continue;
      m.x = x;
      m.y = y;
      m.ux = flow.ux;
      m.uy = flow.uy;
      m.cx = flow.cx;
      m.cy = flow.cy;
      m.spd = showSpeed(flow);
      m.strength = flow.strength;
      return true;
    }
    return false;
  };

  const makeMark = (scene: Phaser.Scene, key: string, depth: number): Mark => ({
    sprite: scene.add.image(0, 0, key).setDepth(depth).setScale(1).setVisible(false).setBlendMode(Phaser.BlendModes.ADD),
    x: 0, y: 0, ux: 1, uy: 0, cx: 0, cy: 1, spd: 0, dir: 0, fi: 0, seqT: 0, frameDur: 120,
    life: 0, maxLife: 1, base: 1, strength: 0, travel: 0, li: 0, age: 0,
  });

  const resetSwell = (m: Mark) => {
    m.maxLife = m.life = 2600 + rnd() * 2600;
    m.li = (rnd() * SWELL_LENS.length) | 0;
    m.base = 0.16 + rnd() * 0.10;
    m.age = 0;
    m.travel = 0;
  };
  const resetDrift = (m: Mark) => {
    m.fi = 0;
    m.seqT = 0;
    m.frameDur = 0;
    m.maxLife = m.life = 900 + rnd() * 1100;
    m.base = 0.24 + rnd() * 0.14; // one pixel: a speck needs more alpha than a line to read at all
    m.age = 0;
    m.travel = 0;
  };

  /** Life envelope, STEPPED into a few levels so marks pop like animated pixel
   * art rather than dissolving (the look the maintainer picked for the lake). */
  const envelope = (m: Mark, dt: number): number => {
    m.life -= dt;
    const p = 1 - m.life / m.maxLife;
    const raw = p < 0.22 ? p / 0.22 : p > 0.7 ? (1 - p) / 0.3 : 1;
    return (Math.ceil(Math.max(0, Math.min(1, raw)) * 3) / 3) * m.base;
  };

  /** Move a mark along the current and keep it honest about where it is. The
   * re-check matters: at full strength a mark crosses ~200px in its life, which
   * is easily far enough to run up a beach, and drift sliding over sand is worse
   * than no drift at all. */
  const advance = (m: Mark, dt: number, lead: number, mayProbe: boolean): boolean => {
    const s = dt / 1000;
    const step = m.spd * lead * s;
    m.x += m.ux * step;
    m.y += m.uy * step;
    m.age += dt;
    m.travel += Math.abs(step);
    if ((m.age >= RECHECK_MS && mayProbe) || m.travel >= RECHECK_PX) {
      m.age = 0;
      m.travel = 0;
      const flow = flowAt(m.x, m.y);
      if (!flow) return false; // left the open sea — let it die and respawn
      m.ux = flow.ux;
      m.uy = flow.uy;
      m.cx = flow.cx;
      m.cy = flow.cy;
      m.spd = showSpeed(flow);
      m.strength = flow.strength;
    }
    return true;
  };

  const range = ([a, b]: [number, number]) => a + rnd() * (b - a);

  /** Sparks live in slots: each is either riding a crest for SPARK_MS, or dark
   * for SPARK_GAP before picking a new one. A slot with no crest to ride stays
   * dark, so an empty sea sparkles not at all. */
  interface Spark {
    sprite: Phaser.GameObjects.Image;
    on: boolean;
    timer: number;
    host: number; // index into `swells`
    at: number; // -0.5..0.5 along that crest's own line
    a: number;
    fi: number; // frame of the twinkle
    seqT: number;
    frameDur: number;
  }
  const sparks: Spark[] = [];

  const stepSparks = (ctx: AmbientCtx, dt: number, gain: number, refl: { tint: number; strength: number }) => {
    const want = gain < 0.02 ? 0 : Math.min(MAX_SPARK, Math.max(0, Math.round(swells.length * 0.45)));
    while (sparks.length < want)
      sparks.push({
        sprite: ctx.scene.add
          .image(0, 0, SPARK_KEYS[0])
          .setDepth(DEPTH_SPARK)
          .setOrigin(0.5, 0.5)
          .setVisible(false)
          .setBlendMode(Phaser.BlendModes.ADD),
        on: false,
        timer: range(SPARK_GAP),
        host: 0,
        at: 0,
        a: 0,
        fi: 0,
        seqT: 0,
        frameDur: 100,
      });
    for (let i = 0; i < sparks.length; i++) {
      const s = sparks[i];
      if (i >= want) { s.sprite.setVisible(false); s.on = false; continue; }
      s.timer -= dt;
      if (s.timer <= 0) {
        s.on = !s.on;
        s.timer = range(s.on ? SPARK_MS : SPARK_GAP);
        if (s.on) {
          // Pick a live crest to ride, and a point along it that is not its tip.
          const live: number[] = [];
          for (let k = 0; k < swells.length; k++) if (swells[k].sprite.visible) live.push(k);
          if (!live.length) { s.on = false; s.timer = range(SPARK_GAP); }
          else {
            s.host = live[(rnd() * live.length) | 0];
            s.at = (rnd() - 0.5) * (1 - 2 * SPARK_INSET);
            s.a = range(SPARK_ALPHA);
            s.fi = 0;
            s.seqT = 0;
            s.frameDur = range(SPARK_FRAME_MS);
          }
        }
      }
      const host = s.on ? swells[s.host] : null;
      if (!host || !host.sprite.visible) { s.sprite.setVisible(false); continue; }
      // The in-place twinkle: full T, shrunk, point — the lake's own sequence.
      s.seqT += dt;
      if (s.seqT >= s.frameDur) {
        s.seqT -= s.frameDur;
        s.fi = Math.min(GLINT_SHAPES.length - 1, s.fi + 1);
      }
      // ON the crest: its centre plus an offset along the line it was drawn at.
      const len = SWELL_LENS[host.li];
      s.sprite
        .setTexture(SPARK_KEYS[s.fi])
        .setPosition(Math.round(host.x + host.cx * s.at * len), Math.round(host.y + host.cy * s.at * len))
        .setTint(refl.tint)
        .setAlpha(s.a * gain * refl.strength)
        .setVisible(true);
    }
  };

  return {
    name: "deepwater",
    init(ctx) {
      ensureTextures(ctx.scene);
    },
    update(ctx, dt) {
      const view = ctx.view;
      // Re-scan the view for open sea on a throttle: the probe runs the game's
      // own screen->ground resolve, which is cheap but not free.
      sampleAge += dt;
      if (sampleAge >= SAMPLE_MS) {
        sampleAge = 0;
        const pts: { x: number; y: number; flow: DrawnFlow }[] = [];
        let sum = 0;
        for (let i = 0; i < GRID; i++)
          for (let j = 0; j < GRID; j++) {
            const wx = view.x + ((i + 0.5) / GRID) * view.width;
            const wy = view.y + ((j + 0.5) / GRID) * view.height;
            const flow = flowAt(wx, wy);
            if (flow) {
              pts.push({ x: wx, y: wy, flow });
              sum += flow.strength;
            }
          }
        seaPts = pts;
        seaFrac = pts.length / (GRID * GRID);
        meanStrength = pts.length ? sum / pts.length : 0;
      }

      const target = forced ? 1 : suppressed ? 0 : seaFrac > 0 ? 1 : 0;
      gain += (target - gain) * Math.min(1, (dt / GAIN_TAU) * 3);
      // OUTDOOR GAIN: the open sea is an outdoor effect like every other one
      // here — it stops when the player is inside (runtime/outdoor.ts).
      const g = gain * ctx.outdoor;

      // Night washes the marks cool and dims them; the sea does not sparkle in
      // the dark, but a current you cannot see at all would hide the mechanic.
      const night = ctx.env.night;
      const tint = lerpC(0xffffff, NIGHT_TINT, night);
      const dim = 1 - 0.45 * night;

      /* How much a mark's own strength dims it. NOT a plain multiply: density
       * already scales by strength, so multiplying alpha by it as well
       * double-dipped and left the open sea — where the current is at its most
       * inescapable — drawn at a fifth of the intended brightness. This keeps
       * the shoreline fade-in the ramp exists for while letting the far sea
       * reach full. */
      const byStrength = (st: number) => 0.45 + 0.55 * st;
      const area = view.width * view.height;
      const wantSwell = g < 0.02 ? 0 : Math.min(MAX_SWELL, Math.round((area / AREA_PER_SWELL) * seaFrac * meanStrength));
      const wantFoam = g < 0.02 ? 0 : Math.min(MAX_DRIFT, Math.round((area / AREA_PER_DRIFT) * seaFrac * meanStrength));

      while (swells.length < wantSwell) swells.push(makeMark(ctx.scene, SWELL_KEY(0, 0), DEPTH_SWELL));
      while (drift.length < wantFoam) drift.push(makeMark(ctx.scene, DRIFT_KEY(), DEPTH_DRIFT));

      for (let i = 0; i < swells.length; i++) {
        const m = swells[i];
        if (i >= wantSwell) { m.sprite.setVisible(false); continue; }
        if (m.life <= 0) {
          if (!place(m, swells, SWELL_MIN_DIST)) { m.sprite.setVisible(false); continue; }
          resetSwell(m);
        }
        const turn = swells.length > 0 && (i - swellCursor + swells.length) % swells.length < SWELL_PROBE_BUDGET;
        if (!advance(m, dt, 1, turn)) { m.life = 0; m.sprite.setVisible(false); continue; }
        const a = envelope(m, dt) * g * dim * byStrength(m.strength);
        // A swell lies ACROSS its own travel, at whatever angle the current
        // there actually runs — rasterised at that angle, never rotated.
        const d = angleIndex(m.cx, m.cy);
        if (d !== m.dir) { m.dir = d; }
        m.sprite.setTexture(swellKey(ctx.scene, d, m.li));
        m.sprite
          .setPosition(Math.round(m.x), Math.round(m.y))
          .setTint(tint)
          .setAlpha(a)
          .setVisible(a > 0.012);
      }

      for (let i = 0; i < drift.length; i++) {
        const m = drift[i];
        if (i >= wantFoam) { m.sprite.setVisible(false); continue; }
        if (m.life <= 0) {
          if (!place(m, drift, DRIFT_MIN_DIST)) { m.sprite.setVisible(false); continue; }
          resetDrift(m);
        }
        const turn = drift.length > 0 && (i - foamCursor + drift.length) % drift.length < DRIFT_PROBE_BUDGET;
        if (!advance(m, dt, DRIFT_LEAD, turn)) { m.life = 0; m.sprite.setVisible(false); continue; }
        const a = envelope(m, dt) * g * dim * byStrength(m.strength);
        m.sprite
          .setPosition(Math.round(m.x), Math.round(m.y))
          .setTint(tint)
          .setAlpha(a)
          .setVisible(a > 0.012);
      }
      // The glimmer takes the sun/moon reflection, exactly as the lake's does:
      // amber low in the day, white at noon, cool and gentler after dark.
      stepSparks(ctx, dt, g, reflection(ctx.env));
      spaceOut(swells, SWELL_MIN_DIST);
      spaceOut(drift, DRIFT_MIN_DIST);
      if (swells.length) swellCursor = (swellCursor + SWELL_PROBE_BUDGET) % swells.length;
      if (drift.length) foamCursor = (foamCursor + DRIFT_PROBE_BUDGET) % drift.length;
    },
    setSuppressed(on) { suppressed = on; },
    setForced(on) { forced = on; },
    debug() {
      const live = (a: Mark[]) => a.filter((m) => m.sprite.visible).length;
      const s = drift.find((m) => m.sprite.visible);
      return {
        gain: +gain.toFixed(3),
        seaFrac: +seaFrac.toFixed(3),
        meanStrength: +meanStrength.toFixed(3),
        swells: live(swells),
        drift: live(drift),
        sparks: sparks.filter((s) => s.sprite.visible).length,
        probe: !!(window as unknown as { __ml?: Record<string, unknown> }).__ml?.deepCurrentAtScreen,
        sample: s ? { x: Math.round(s.x), y: Math.round(s.y), dir: s.dir, spd: +s.spd.toFixed(1), strength: +s.strength.toFixed(2) } : null,
        // Per-mark drawn heading + speed, for the QA that checks the drift
        // really streams the way the player is pushed.
        // `kind` matters to QA: spacing is a rule WITHIN a family. A speck
        // riding over a crest is the design (drift skates over the swells), so
        // measuring the two families together reads intent as crowding.
        all: [...swells.map((m) => ["swell", m] as const), ...drift.map((m) => ["drift", m] as const)]
          .filter(([, m]) => m.sprite.visible)
          .map(([kind, m]) => ({ kind, x: Math.round(m.x), y: Math.round(m.y), ux: +m.ux.toFixed(3), uy: +m.uy.toFixed(3), spd: +m.spd.toFixed(1), a: +m.sprite.alpha.toFixed(3) })),
      };
    },
    dispose() {
      for (const m of [...swells, ...drift]) m.sprite.destroy();
      for (const s of sparks) s.sprite.destroy();
      swells.length = 0;
      drift.length = 0;
      sparks.length = 0;
    },
  };
}
