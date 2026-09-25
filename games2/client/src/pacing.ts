/** FRAME PACING: A STEADY 30 WHEN 60 CANNOT BE HELD.
 *
 *  His 16:50 run on 0b274482 (Mali-G715, dpr 2.6): frame p50 17-23 ms against
 *  a 16.7 ms vsync. The game's own work sits ON the budget, so a third of the
 *  frames make their vsync and the rest slip to the next one — 17, 33, 17, 33
 *  — while Phaser's smoothed delta (a 10-tick mean, ~25 ms) moves the world by
 *  an amount that agrees with neither. That alternation is what "the FPS is
 *  not stable" looks like (maintainer 2026-09-24). A steady 33 ms cadence is
 *  read as smooth motion, and it is half the work per second: the phone runs
 *  cooler (his window 4 ran the fixed benchmark at 21 ms — throttled).
 *
 *  The pacer wraps the loop's callback (Phaser.Core.TimeStep#callback, the
 *  game's step). rAF still ticks every vsync — a skipped tick costs nothing —
 *  and the step runs on the tick that lands at or past the paced period. The
 *  rule `elapsed >= period - vsync/2` renders on every Nth vsync at ANY
 *  refresh (60 Hz: every 2nd, 90: every 3rd, 120: every 4th) and never
 *  wobbles between N and N+1 on rAF jitter. After a long frame (a hop) the
 *  next tick runs at once — its gap already exceeds the period — and no
 *  catch-up frame follows: 50 then 33, not 50 then 17. Phaser's own
 *  `fps.limit` was read and rejected: it sums the SMOOTHED delta against
 *  exactly 1000/limit, which two 60 Hz ticks reach only when neither jittered
 *  short (a 33/33/50 pattern), and it is bound at start(), not switchable.
 *
 *  `auto` (the default) LOCKS when a quarter of a second's ticks arrive late
 *  — later than the 60 Hz frame plus half a vsync, i.e. a missed 60 Hz frame
 *  on any display (a 120 Hz phone holding a steady 60 on every 2nd vsync is
 *  never late) — and UNLOCKS after 3 s of step work under 55% of the 60 Hz
 *  frame, never sooner than 15 s after locking: hysteresis both ways, so a
 *  desktop that holds 60 never locks and a phone at 15 ms of work never flaps.
 *  `30` always paces, `60` never does (the A/B: Settings→Dev "frame pacing",
 *  `?pace=auto|30|60`, remembered as localStorage ml-pace). The vsync is
 *  read off the ticks themselves (the smallest gap of a second: nothing
 *  arrives faster than the display), so 90 and 120 Hz phones pace right.
 *
 *  While paced, the step's delta is the skipped ticks' smoothed deltas
 *  SUMMED and `game.loop.delta` is set to agree, so every ease, tween and
 *  animation keeps its time constant — it is what Phaser would have handed
 *  two steps, in one. The decision itself is on RAW wall clock: the
 *  smoothed value lags a hitch by ten ticks and would skip the tick after a
 *  slow frame (measured in pacing.test.ts).
 */

export type PaceMode = "auto" | "30" | "60";

const KEY = "ml-pace";
/** The paced rate. Half the vsync of every phone the game ships to. */
export const PACE_HZ = 30;
const PACE_MS = 1000 / PACE_HZ;
/** The frame the pacer asks a display to HOLD: 60 Hz, or the display's own
 *  when it is slower. A tick later than this plus half a vsync missed it. */
const HOLD_MS = 1000 / 60;
/** Lock when this share of a second's ticks were late... */
const LOCK_LATE_FRAC = 0.25;
/** ...and the second had at least this many ticks (a sleeping loop's first
 *  second after a wake is a handful of ticks, all "late"). */
const LOCK_MIN_TICKS = 10;
/** Unlock after this many consecutive seconds whose step work p90 was under
 *  UNLOCK_WORK_FRAC of a vsync — and never sooner than UNLOCK_HOLD_MS after
 *  the lock (a lock/unlock cycle is itself a visible cadence change). */
const UNLOCK_GOOD_S = 3;
const UNLOCK_WORK_FRAC = 0.55;
const UNLOCK_HOLD_MS = 15000;
const CENSUS_MS = 1000;

/** The beacon's row for one window (`pace` block; server allowlist `mixed`). */
export interface PaceRow {
  mode: PaceMode;
  /** Pacing now (at the snapshot): 1 or 0. */
  paced: number;
  /** Share of the window's ticking time spent paced, 0..1. */
  lockedFrac: number;
  /** The rate the game rendered at while paced (PACE_HZ), 0 when it was not. */
  hz: number;
  /** The display's own rate, read off the ticks. */
  tickHz: number;
  /** Lock transitions this window. */
  locks: number;
  /** Steps run and ticks skipped this window. */
  run: number;
  skipped: number;
  /** The step's own work (ms inside the callback): p50/p90/max over the window. */
  work50: number;
  work90: number;
  workMax: number;
}

/** THE PACER, pure enough for a headless test: feed it ticks, it calls the
 *  step or not. `clock` measures the step's work (performance.now by default). */
export class Pacer {
  mode: PaceMode;
  locked = false;
  /** The display's vsync in ms: the smallest tick gap of the last census
   *  second (60 Hz until the ticks say otherwise). Drives the late-tick and
   *  unlock verdicts (through `hold`) and the beacon's `tickHz`. */
  vsync = 1000 / 60;
  /** The frame to hold on this display: HOLD_MS, or the vsync when slower. */
  private get hold(): number {
    return Math.max(HOLD_MS, this.vsync);
  }
  /** The skip threshold's period: the smallest vsync ever seen, NEVER RAISED.
   *  An under-estimate is harmless — the threshold stays under every multiple
   *  of the true vsync at or past PACE_MS (an LTPO panel dropping 120→60
   *  still paces every 2nd) — while an over-estimate would not be: a second
   *  where every frame missed its vsync reads as a 30 Hz display, and a
   *  threshold built on 33 ms lets the next light frame through at 60
   *  (pacing.test.ts). */
  period = 1000 / 60;
  /** Rendered-frame gaps (rAF timestamps of consecutive steps) for the on-screen
   *  meter, and the timestamp of the last tick seen (a stale one means the
   *  loop is asleep and the meter falls back to the browser's own frames). */
  readonly gaps: number[] = [];
  lastTick = -1;
  private lastRun = -1;
  private lockedAt = 0;
  private accRaw = 0;
  private accDt = 0;
  private winAt = -1;
  private winRaw: number[] = [];
  private goodS = 0;
  private work: number[] = [];
  // The beacon window's counters.
  private bWork: number[] = [];
  private bLockedMs = 0;
  private bWallMs = 0;
  private bLocks = 0;
  private bRun = 0;
  private bSkipped = 0;

  constructor(mode: PaceMode = "auto", private readonly clock: () => number = () => performance.now()) {
    this.mode = mode;
  }

  /** Pacing this tick? */
  get paced(): boolean {
    return this.mode === "30" || (this.mode === "auto" && this.locked);
  }

  setMode(mode: PaceMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // A fresh verdict for auto: the census restarts and a lock is dropped, so
    // "auto" after "30" inherits neither the forced pacing as a lock nor the
    // forced cadence's ticks as late ones (they were; that was the bug).
    this.locked = false;
    this.goodS = 0;
    this.winAt = -1;
    this.winRaw.length = 0;
    this.work.length = 0;
    this.accRaw = 0;
    this.accDt = 0;
  }

  /** One rAF tick. `time` is the tick's timestamp, `raw` the ms since the
   *  previous tick (TimeStep#rawDelta), `delta` Phaser's smoothed delta for
   *  it; `run(dt)` is the step. Returns the delta handed to the step, 0 when
   *  the tick was skipped. */
  tick(time: number, raw: number, delta: number, run: (dt: number) => void): number {
    this.lastTick = time;
    const pacedNow = this.paced;
    this.bWallMs += raw;
    if (pacedNow) this.bLockedMs += raw;
    // The census: the second's tick gaps (its vsync and its late ticks, for
    // the lock) and the step work (for the unlock).
    if (this.winAt < 0) this.winAt = time;
    this.winRaw.push(raw);
    if (time - this.winAt >= CENSUS_MS) this.census(time);
    let dt: number;
    if (!pacedNow) {
      this.accRaw = 0;
      this.accDt = 0;
      dt = delta;
    } else {
      this.accRaw += raw;
      this.accDt += delta;
      if (this.accRaw < PACE_MS - this.period / 2) {
        this.bSkipped++;
        return 0;
      }
      dt = this.accDt;
      this.accRaw = 0;
      this.accDt = 0;
    }
    const t0 = this.clock();
    run(dt);
    const w = this.clock() - t0;
    this.work.push(w);
    this.bWork.push(w);
    this.bRun++;
    if (this.lastRun >= 0) {
      const g = time - this.lastRun;
      if (g >= 0 && g < 2000) this.gaps.push(g);
      if (this.gaps.length > 1200) this.gaps.splice(0, this.gaps.length - 600);
    }
    this.lastRun = time;
    return dt;
  }

  private census(time: number): void {
    const raws = this.winRaw;
    // The second's vsync: its smallest gap. A hidden tab's multi-second gap or
    // a long frame can only widen a gap, never shorten one; a second of ticks
    // that ALL missed reads as a slower display, which is why `period` only
    // ever comes down.
    let m = Infinity;
    for (const r of raws) if (r < m) m = r;
    if (m >= 4 && m <= 50) {
      this.vsync = m;
      if (m < this.period) this.period = m;
    }
    if (this.mode === "auto") {
      if (!this.locked) {
        let late = 0;
        const lateOver = this.hold + this.vsync / 2;
        for (const r of raws) if (r > lateOver) late++;
        if (raws.length >= LOCK_MIN_TICKS && late >= LOCK_LATE_FRAC * raws.length) {
          this.locked = true;
          this.lockedAt = time;
          this.goodS = 0;
          this.bLocks++;
          this.accRaw = 0;
          this.accDt = 0;
        }
      } else {
        const p90 = quantile(this.work, 0.9);
        if (this.work.length >= 5 && p90 < UNLOCK_WORK_FRAC * this.hold) this.goodS++;
        else this.goodS = 0;
        if (this.goodS >= UNLOCK_GOOD_S && time - this.lockedAt >= UNLOCK_HOLD_MS) {
          this.locked = false;
          this.goodS = 0;
        }
      }
    }
    this.winAt = time;
    raws.length = 0;
    this.work.length = 0;
  }

  /** The beacon window's row; resets the window's counters. */
  take(): PaceRow {
    // One native sort of the window's ~900 work samples, not two JS ones and a spread.
    const w = Float64Array.from(this.bWork).sort();
    const row: PaceRow = {
      mode: this.mode,
      paced: this.paced ? 1 : 0,
      lockedFrac: this.bWallMs > 0 ? +(this.bLockedMs / this.bWallMs).toFixed(2) : 0,
      hz: this.paced ? PACE_HZ : 0,
      tickHz: Math.round(1000 / this.vsync),
      locks: this.bLocks,
      run: this.bRun,
      skipped: this.bSkipped,
      work50: +pick(w, 0.5).toFixed(2),
      work90: +pick(w, 0.9).toFixed(2),
      workMax: w.length ? +w[w.length - 1].toFixed(2) : 0,
    };
    this.bWork = [];
    this.bLockedMs = 0;
    this.bWallMs = 0;
    this.bLocks = 0;
    this.bRun = 0;
    this.bSkipped = 0;
    return row;
  }
}

function quantile(xs: readonly number[], q: number): number {
  return pick(Float64Array.from(xs).sort(), q);
}

/** The q-quantile of an ascending list (0 when it is empty). */
function pick(s: ArrayLike<number>, q: number): number {
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0;
}

/** The structural slice of Phaser.Game the installer needs (no phaser import:
 *  the tests run this module headless under node). */
interface LoopLike {
  callback: (time: number, delta: number) => void;
  delta: number;
  rawDelta: number;
}
interface GameLike {
  loop: LoopLike;
  isRunning: boolean;
  events: { once(event: string, fn: () => void): unknown };
}

let pacer: Pacer | null = null;

/** The browser globals, structurally: this module is also typechecked and run
 *  headless under node (pacing.test.ts), where neither exists. */
interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
const g = globalThis as { location?: { search: string }; localStorage?: StorageLike };

function readMode(): PaceMode {
  try {
    const q = g.location ? new URLSearchParams(g.location.search).get("pace") : null;
    const want = q === "off" ? "60" : q;
    if (want === "auto" || want === "30" || want === "60") g.localStorage?.setItem(KEY, want);
    const v = g.localStorage?.getItem(KEY);
    if (v === "auto" || v === "30" || v === "60") return v;
  } catch {
    /* no storage (private mode) — the default */
  }
  return "auto";
}

function get(): Pacer {
  return pacer ?? (pacer = new Pacer(readMode()));
}

/** Wrap the game's step. Phaser's TimeStep holds a NOOP callback until
 *  Game.start() binds the real step — after the default textures decode,
 *  later than `new Phaser.Game` returns — so a wrap taken at construction is
 *  a wrap of NOOP that start() then overwrites (measured: the probe saw zero
 *  steps). The first PRE_STEP is emitted from inside the real step, which is
 *  when the callback is the one to keep. */
export function paceInstall(game: GameLike): void {
  const loop = game.loop;
  const wrap = () => {
    const real = loop.callback;
    const p = get();
    loop.callback = (time: number, delta: number) => {
      p.tick(time, loop.rawDelta, delta, (dt) => {
        loop.delta = dt;
        real(time, dt);
      });
    };
  };
  if (game.isRunning) wrap();
  else game.events.once("prestep", wrap); // Phaser.Core.Events.PRE_STEP
}

export function paceMode(): PaceMode {
  return get().mode;
}

export function paceSetMode(mode: PaceMode): void {
  get().setMode(mode);
  try {
    g.localStorage?.setItem(KEY, mode);
  } catch {
    /* private mode */
  }
}

/** The Settings→Dev button: auto → 30 → 60 → auto. */
export function paceCycle(): PaceMode {
  const next: Record<PaceMode, PaceMode> = { auto: "30", "30": "60", "60": "auto" };
  const m = next[get().mode];
  paceSetMode(m);
  return m;
}

/** Pacing at this moment (the meter's "paced" tag, the button's switch). */
export function pacedNow(): boolean {
  return get().paced;
}

/** The button's state text. */
export function paceLabel(): string {
  const p = get();
  if (p.mode === "auto") return p.locked ? `auto: ${PACE_HZ} locked` : "auto: 60";
  return `${p.mode} fps`;
}

/** The rendered frames for the on-screen meter: gaps between consecutive
 *  steps and the last tick's timestamp. */
export function paceFrames(): { gaps: readonly number[]; at: number } {
  const p = get();
  return { gaps: p.gaps, at: p.lastTick };
}

/** The beacon's `pace` block for the window that just ended. */
export function paceTake(): PaceRow {
  return get().take();
}
