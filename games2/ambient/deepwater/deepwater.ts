import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { DrawnFlow, FLOW_DIRS, crossDir8, dir8, drawnFlow, rasterLine } from "./current";

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
// the rate it is actually carrying you; stop fighting it and the foam and your
// body drift together. That is the whole idea — a force you can read, not a
// wall you bump into.
//
// TWO LAYERS, because one speed reads as a sliding sheet rather than water:
//   • SWELLS  — long dim lines ACROSS the flow, marching inward at the current
//     itself. These are the waves that carry you. Sparse, slow to fade.
//   • FOAM    — short bright streaks ALONG the flow with a bright leading head,
//     running slightly FASTER than the current, so they skate over the swells.
//     Never slower: foam the swimmer overtakes would read as being dragged out.
//
// Both are quantised to the 8 drawn tile directions and rasterised as whole
// pixels (see current.ts) — pixel art may not be rotated to arbitrary angles,
// and the marks share the world's own pixel grid like every other effect here.
// Strength (0 in the free shallows, 1 out at sea) scales count, brightness and
// length, so the current FADES IN over the shoreline band exactly where the
// player crosses into it rather than switching on at a line.

const DEPTH_SWELL = 900_000.34; // above the darkness overlay, below the water feature's chop
const DEPTH_FOAM = 900_000.36;
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
const FOAM_PROBE_BUDGET = 2;
const AREA_PER_SWELL = 1800;
const AREA_PER_FOAM = 5200;
const MAX_SWELL = 30;
const MAX_FOAM = 16;
const FOAM_LEAD = 1.35; // foam runs this much faster than the current it rides
const MIN_DIST = 13; // marks keep this far apart (Chebyshev, drawn px)
const PLACE_TRIES = 10;

// Swells come in three lengths so ranks of them read as sea rather than as a
// drawn grid. Long: a crest has to span a good part of the view to be a WAVE
// and not a tick mark.
const SWELL_LENS = [27, 39, 53];
const FOAM_LEN = 11; // px along the flow

const SWELL_KEY = (i: number, L: number) => `amb-dwswell${i}_${L}`;
const FOAM_KEY = (i: number, f: number) => `amb-dwfoam${i}_${f}`;
const FOAM_FRAMES = 3; // the bright head marches down the streak

// Open sea reads COLD and pale against deep_water's own #3d7c8a. Additive, like
// the water feature's crests — the night overlay sits below these, so the look
// is driven here by time of day instead of being multiplied into nothing.
const FOAM_HEAD = 0xffffff;
const FOAM_BODY = 0xbfe6ef;
const SWELL_LINE = 0xbfe9f2; // the crest
const SWELL_BACK = 0x4f8fa0; // its back slope, a pixel down-current
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
  spd: number; // drawn px/s
  dir: number; // which of the 8 sprites
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
  const foam: Mark[] = [];
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
  // all of the foam — could go unchecked indefinitely and stream up a beach.
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

  const ensureTextures = (scene: Phaser.Scene) => {
    if (scene.textures.exists(SWELL_KEY(0, 0))) return;
    const paint = (key: string, w: number, h: number, layers: { c: number; px: [number, number][] }[]) => {
      const g = scene.make.graphics({ x: 0, y: 0 }, false);
      for (const { c, px } of layers) {
        g.fillStyle(c, 1);
        for (const [x, y] of px) g.fillRect(x, y, 1, 1);
      }
      g.generateTexture(key, w, h);
      g.destroy();
    };
    for (let i = 0; i < 8; i++) {
      // A SWELL is a crest line across the flow, plus a dimmer line one pixel
      // DOWN-CURRENT of it — the wave's back slope. A bare line reads as a tick
      // mark; the pair reads as something with a front and a back, which is
      // what makes a rank of them look like sea rolling in.
      const step = FLOW_DIRS[(i + 6) % 8]; // the flow a crest at `i` travels along
      const ox = Math.round(step[0]);
      const oy = Math.round(step[1]);
      for (let L = 0; L < SWELL_LENS.length; L++) {
        const line = rasterLine(i, SWELL_LENS[L]);
        const back = line.px.map(([x, y]) => [x + ox, y + oy] as [number, number]);
        const all = [...line.px, ...back];
        const mnX = Math.min(...all.map((q) => q[0]));
        const mnY = Math.min(...all.map((q) => q[1]));
        const mxX = Math.max(...all.map((q) => q[0]));
        const mxY = Math.max(...all.map((q) => q[1]));
        const sh = ([x, y]: [number, number]) => [x - mnX, y - mnY] as [number, number];
        paint(SWELL_KEY(i, L), mxX - mnX + 1, mxY - mnY + 1, [
          { c: SWELL_BACK, px: back.map(sh) },
          { c: SWELL_LINE, px: line.px.map(sh) },
        ]);
      }
      // Foam is a streak ALONG the flow with a BRIGHT HEAD that marches toward
      // the leading end — an in-place animation, so the streak reads as moving
      // water even in a still frame (the same trick the lake wavelets use).
      const f = rasterLine(i, FOAM_LEN);
      for (let k = 0; k < FOAM_FRAMES; k++) {
        const headAt = f.px.length - 1 - k; // the head sits near the leading end
        const body = f.px.filter((_, n) => n !== headAt);
        const head = f.px.filter((_, n) => n === headAt);
        paint(FOAM_KEY(i, k), f.w, f.h, [
          { c: FOAM_BODY, px: body },
          { c: FOAM_HEAD, px: head },
        ]);
      }
    }
  };

  const tooClose = (x: number, y: number, self: Mark): boolean => {
    for (const o of foam)
      if (o !== self && o.sprite.visible && Math.abs(o.x - x) < MIN_DIST && Math.abs(o.y - y) < MIN_DIST) return true;
    return false;
  };

  /** Drop a mark on open sea, taking its direction and speed from the current
   * that is actually there. Returns false when no spot is found (the mark stays
   * hidden and tries again next time). */
  const place = (m: Mark, spaced: boolean): boolean => {
    if (!seaPts.length) return false;
    for (let t = 0; t < PLACE_TRIES; t++) {
      const p = seaPts[(rnd() * seaPts.length) | 0];
      const x = Math.round(p.x + (rnd() - 0.5) * 90);
      const y = Math.round(p.y + (rnd() - 0.5) * 60);
      const flow = flowAt(x, y);
      if (!flow) continue; // drifted onto a lake, a beach, or the free shallows
      if (spaced && tooClose(x, y, m)) continue;
      m.x = x;
      m.y = y;
      m.ux = flow.ux;
      m.uy = flow.uy;
      m.spd = flow.speed;
      m.strength = flow.strength;
      return true;
    }
    return false;
  };

  const makeMark = (scene: Phaser.Scene, key: string, depth: number): Mark => ({
    sprite: scene.add.image(0, 0, key).setDepth(depth).setScale(1).setVisible(false).setBlendMode(Phaser.BlendModes.ADD),
    x: 0, y: 0, ux: 1, uy: 0, spd: 0, dir: 0, fi: 0, seqT: 0, frameDur: 120,
    life: 0, maxLife: 1, base: 1, strength: 0, travel: 0, li: 0, age: 0,
  });

  const resetSwell = (m: Mark) => {
    m.maxLife = m.life = 2600 + rnd() * 2600;
    m.li = (rnd() * SWELL_LENS.length) | 0;
    m.base = 0.58 + rnd() * 0.30;
    m.age = 0;
    m.travel = 0;
  };
  const resetFoam = (m: Mark) => {
    m.fi = (rnd() * FOAM_FRAMES) | 0;
    m.seqT = 0;
    m.frameDur = 70 + rnd() * 70;
    m.maxLife = m.life = 900 + rnd() * 1100;
    m.base = 0.50 + rnd() * 0.30;
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
   * is easily far enough to run up a beach, and foam sliding over sand is worse
   * than no foam at all. */
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
      m.spd = flow.speed;
      m.strength = flow.strength;
    }
    return true;
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
      const wantFoam = g < 0.02 ? 0 : Math.min(MAX_FOAM, Math.round((area / AREA_PER_FOAM) * seaFrac * meanStrength));

      while (swells.length < wantSwell) swells.push(makeMark(ctx.scene, SWELL_KEY(0, 0), DEPTH_SWELL));
      while (foam.length < wantFoam) foam.push(makeMark(ctx.scene, FOAM_KEY(0, 0), DEPTH_FOAM));

      for (let i = 0; i < swells.length; i++) {
        const m = swells[i];
        if (i >= wantSwell) { m.sprite.setVisible(false); continue; }
        if (m.life <= 0) {
          if (!place(m, false)) { m.sprite.setVisible(false); continue; }
          resetSwell(m);
        }
        const turn = swells.length > 0 && (i - swellCursor + swells.length) % swells.length < SWELL_PROBE_BUDGET;
        if (!advance(m, dt, 1, turn)) { m.life = 0; m.sprite.setVisible(false); continue; }
        const a = envelope(m, dt) * g * dim * byStrength(m.strength);
        // A swell lies ACROSS its own travel.
        const d = crossDir8(dir8(m.ux, m.uy));
        if (d !== m.dir) { m.dir = d; }
        m.sprite.setTexture(SWELL_KEY(d, m.li));
        m.sprite
          .setPosition(Math.round(m.x), Math.round(m.y))
          .setTint(tint)
          .setAlpha(a)
          .setVisible(a > 0.012);
      }

      for (let i = 0; i < foam.length; i++) {
        const m = foam[i];
        if (i >= wantFoam) { m.sprite.setVisible(false); continue; }
        if (m.life <= 0) {
          if (!place(m, true)) { m.sprite.setVisible(false); continue; }
          resetFoam(m);
        }
        const turn = foam.length > 0 && (i - foamCursor + foam.length) % foam.length < FOAM_PROBE_BUDGET;
        if (!advance(m, dt, FOAM_LEAD, turn)) { m.life = 0; m.sprite.setVisible(false); continue; }
        const a = envelope(m, dt) * g * dim * byStrength(m.strength);
        m.seqT += dt;
        if (m.seqT >= m.frameDur) { m.seqT -= m.frameDur; m.fi = (m.fi + 1) % FOAM_FRAMES; }
        const d = dir8(m.ux, m.uy);
        m.dir = d;
        m.sprite.setTexture(FOAM_KEY(d, m.fi));
        m.sprite
          .setPosition(Math.round(m.x), Math.round(m.y))
          .setTint(tint)
          .setAlpha(a)
          .setVisible(a > 0.012);
      }
      if (swells.length) swellCursor = (swellCursor + SWELL_PROBE_BUDGET) % swells.length;
      if (foam.length) foamCursor = (foamCursor + FOAM_PROBE_BUDGET) % foam.length;
    },
    setSuppressed(on) { suppressed = on; },
    setForced(on) { forced = on; },
    debug() {
      const live = (a: Mark[]) => a.filter((m) => m.sprite.visible).length;
      const s = foam.find((m) => m.sprite.visible);
      return {
        gain: +gain.toFixed(3),
        seaFrac: +seaFrac.toFixed(3),
        meanStrength: +meanStrength.toFixed(3),
        swells: live(swells),
        foam: live(foam),
        probe: !!(window as unknown as { __ml?: Record<string, unknown> }).__ml?.deepCurrentAtScreen,
        sample: s ? { x: Math.round(s.x), y: Math.round(s.y), dir: s.dir, spd: +s.spd.toFixed(1), strength: +s.strength.toFixed(2) } : null,
        // Per-mark drawn heading + speed, for the QA that checks the foam
        // really streams the way the player is pushed.
        all: [...swells, ...foam]
          .filter((m) => m.sprite.visible)
          .map((m) => ({ x: Math.round(m.x), y: Math.round(m.y), ux: +m.ux.toFixed(3), uy: +m.uy.toFixed(3), spd: +m.spd.toFixed(1), a: +m.sprite.alpha.toFixed(3) })),
      };
    },
    dispose() {
      for (const m of [...swells, ...foam]) m.sprite.destroy();
      swells.length = 0;
      foam.length = 0;
    },
  };
}
