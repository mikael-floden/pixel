// FRAME PACING (client/src/pacing.ts): the pacer fed synthetic rAF ticks. A
// tick lands on a vsync; a step that runs past the vsync pushes the next tick
// to the vsync after it ends (what the browser does); a skipped tick costs
// nothing. `clock` is the pacer's performance.now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pacer, PACE_HZ, paceInstall } from "../../client/src/pacing";

interface Drive {
  hz?: number;
  /** Wall-clock ms to drive, from the pacer's current time. */
  ms: number;
  /** The step's cost, by step index and tick time. */
  work: (i: number, t: number) => number;
  /** Hand the pacer Phaser's 10-tick smoothed delta instead of the raw gap. */
  smooth?: boolean;
}

class Sim {
  clock: { t: number };
  time = 0;
  prev = -1000 / 60;
  steps: { at: number; dt: number; work: number }[] = [];
  ticks = 0;
  private hist: number[] = [];
  constructor(readonly p: Pacer, clock: { t: number }) {
    this.clock = clock;
  }
  drive(d: Drive): void {
    const vs = 1000 / (d.hz ?? 60);
    if (this.prev < 0) this.prev = -vs;
    const end = this.time + d.ms;
    let i = this.steps.length;
    while (this.time < end) {
      const raw = this.time - this.prev;
      let delta = raw;
      if (d.smooth) {
        this.hist.push(Math.min(raw, 200));
        if (this.hist.length > 10) this.hist.shift();
        delta = this.hist.reduce((a, b) => a + b, 0) / this.hist.length;
      }
      this.clock.t = this.time;
      this.ticks++;
      const at = this.time;
      this.p.tick(at, raw, delta, (dt) => {
        const w = d.work(i, at);
        this.clock.t += w;
        this.steps.push({ at, dt, work: w });
        i++;
      });
      this.prev = this.time;
      this.time = vs * (Math.floor(this.clock.t / vs + 1e-9) + 1);
    }
  }
  gaps(from = 1): number[] {
    const g: number[] = [];
    for (let k = Math.max(1, from); k < this.steps.length; k++) g.push(+(this.steps[k].at - this.steps[k - 1].at).toFixed(2));
    return g;
  }
}

const near = (a: number, b: number, eps = 0.05) => Math.abs(a - b) <= eps;

function mk(mode: "auto" | "30" | "60"): Sim {
  const clock = { t: 0 };
  return new Sim(new Pacer(mode, () => clock.t), clock);
}

test("mode 30 at 60 Hz with 15 ms of work: a step every second vsync, 33.3 ms of delta each, never two in a row", () => {
  const sim = mk("30");
  sim.drive({ ms: 3000, work: () => 15 });
  const gaps = sim.gaps(2);
  assert.ok(gaps.length > 80, `steps: ${sim.steps.length}`);
  assert.ok(gaps.every((g) => near(g, 1000 / 30)), `gaps ${[...new Set(gaps)].join(",")}`);
  assert.ok(sim.steps.slice(2).every((st) => near(st.dt, 1000 / 30)), "the step's delta is the two ticks' summed");
  assert.equal(sim.ticks, sim.steps.length * 2, "every second tick is skipped");
  assert.equal(PACE_HZ, 30);
});

test("a 40 ms frame: the next tick runs at once and no catch-up frame follows — 50 then 33, never 17", () => {
  const sim = mk("30");
  sim.drive({ ms: 3000, work: (i) => (i === 40 ? 40 : 15), smooth: true });
  const gaps = sim.gaps(2);
  assert.ok(!gaps.some((g) => g < 30), `a catch-up frame: ${gaps.filter((g) => g < 30).join(",")}`);
  const slow = sim.steps.findIndex((st) => st.work === 40);
  const after = sim.steps[slow + 1].at - sim.steps[slow].at;
  const then = sim.steps[slow + 2].at - sim.steps[slow + 1].at;
  assert.ok(near(after, 50), `after the slow frame: ${after}`);
  assert.ok(near(then, 1000 / 30), `then: ${then}`);
  // The decision was on the raw gap (50): the smoothed delta handed to that
  // step lags the hitch by ten ticks and is well under it — Phaser's own
  // smoothing, which the pacer keeps rather than inventing a second one.
  assert.ok(sim.steps[slow + 1].dt < 30 && sim.steps[slow + 1].dt > 16, `smoothed dt ${sim.steps[slow + 1].dt}`);
});

test("120 Hz: the vsync is read off the ticks and the pacer renders every 4th — still 30, not 40", () => {
  const sim = mk("30");
  sim.drive({ hz: 120, ms: 3000, work: () => 10 });
  assert.ok(near(sim.p.period, 1000 / 120), `period ${sim.p.period}`);
  assert.ok(near(sim.p.vsync, 1000 / 120), `vsync ${sim.p.vsync}`);
  const settled = sim.gaps(40);
  assert.ok(settled.every((g) => near(g, 1000 / 30)), `gaps ${[...new Set(settled)].join(",")}`);
});

test("auto locks within a second on a phone that misses every other vsync, and never on a desktop that holds 60", () => {
  const phone = mk("auto");
  phone.drive({ ms: 1000, work: (i) => (i % 2 ? 20 : 14) });
  assert.equal(phone.p.locked, false, "no verdict before the first census");
  phone.drive({ ms: 200, work: (i) => (i % 2 ? 20 : 14) });
  assert.equal(phone.p.locked, true, "a quarter of a second's ticks late: locked");
  phone.drive({ ms: 2000, work: () => 15 });
  assert.ok(phone.gaps(phone.steps.length - 50).every((g) => near(g, 1000 / 30)), "paced from then on");
  const desk = mk("auto");
  desk.drive({ ms: 5000, work: () => 4 });
  assert.equal(desk.p.locked, false);
  assert.equal(desk.steps.length, desk.ticks, "every tick stepped");
  assert.ok(desk.gaps(2).every((g) => near(g, 1000 / 60)));
});

test("120 Hz: a steady 60 on every 2nd vsync is never late (no lock); a 60/40 flicker is, and locks to every 4th", () => {
  const steady = mk("auto");
  steady.drive({ hz: 120, ms: 4000, work: () => 12 }); // 12 ms of work: every step spans 2 vsyncs — a steady 60
  assert.equal(steady.p.locked, false);
  assert.ok(steady.gaps(steady.steps.length - 50).every((g) => near(g, 1000 / 60)), "60 fps, held");
  const flicker = mk("auto");
  flicker.drive({ hz: 120, ms: 3000, work: (i) => (i % 2 ? 22 : 12) }); // 2 then 3 vsyncs: 60/40
  assert.equal(flicker.p.locked, true);
  flicker.drive({ hz: 120, ms: 2000, work: (i) => (i % 2 ? 22 : 12) });
  assert.ok(flicker.gaps(flicker.steps.length - 40).every((g) => near(g, 1000 / 30)), `paced to every 4th: ${[...new Set(flicker.gaps(flicker.steps.length - 40))].join(",")}`);
});

test("auto unlocks after three light seconds — never inside the 15 s hold — and re-locks when the work comes back", () => {
  const sim = mk("auto");
  sim.drive({ ms: 2000, work: (i) => (i % 2 ? 20 : 14) });
  assert.equal(sim.p.locked, true);
  const lockedBy = sim.time;
  sim.drive({ ms: 10000, work: () => 5 });
  assert.equal(sim.p.locked, true, "light work, but inside the hold");
  sim.drive({ ms: 8000, work: () => 5 });
  assert.equal(sim.p.locked, false, `still locked ${(sim.time - lockedBy) / 1000} s after the lock`);
  sim.drive({ ms: 2500, work: (i) => (i % 2 ? 20 : 14) });
  assert.equal(sim.p.locked, true, "re-locked");
  // Heavy work that FITS a paced frame never unlocks: p90 20 ms is over 55% of a vsync.
  sim.drive({ ms: 30000, work: () => 20 });
  assert.equal(sim.p.locked, true);
});

test("a second where every frame missed its vsync never raises the period: the next light frame is still paced, not let through at 60", () => {
  const sim = mk("30");
  sim.drive({ ms: 3000, work: () => 20 }); // every tick 33 ms apart: already every-other, nothing to skip
  assert.ok(sim.gaps(2).every((g) => near(g, 1000 / 30)), "an overloaded second runs at the paced rate by itself");
  assert.ok(near(sim.p.period, 1000 / 60), `period ${sim.p.period}`);
  sim.drive({ ms: 2000, work: () => 4 });
  const light = sim.gaps(sim.steps.length - 50);
  assert.ok(light.every((g) => near(g, 1000 / 30)), `light frames slipped through: ${[...new Set(light)].join(",")}`);
  // An LTPO panel dropping 120 → 60: the period stays at the 120 Hz vsync and 60 Hz ticks still pace every 2nd.
  const ltpo = mk("30");
  ltpo.drive({ hz: 120, ms: 2000, work: () => 4 });
  assert.ok(near(ltpo.p.period, 1000 / 120));
  ltpo.drive({ hz: 60, ms: 2000, work: () => 4 });
  assert.ok(near(ltpo.p.period, 1000 / 120), "never raised");
  assert.ok(near(ltpo.p.vsync, 1000 / 60), "the census reads the display as it is now");
  assert.ok(ltpo.gaps(ltpo.steps.length - 50).every((g) => near(g, 1000 / 30)));
});

test("60 never skips a tick; switching to auto drops a forced 30 and waits for its own verdict", () => {
  const sim = mk("60");
  sim.drive({ ms: 2000, work: () => 20 });
  assert.equal(sim.steps.length, sim.ticks);
  sim.p.setMode("30");
  sim.drive({ ms: 1000, work: () => 20 });
  assert.equal(sim.p.paced, true);
  sim.p.setMode("auto");
  assert.equal(sim.p.paced, false);
  sim.drive({ ms: 1500, work: () => 4 });
  assert.equal(sim.p.locked, false);
});

test("the beacon row: steps run, ticks skipped, the paced share, the display rate and the step's own work", () => {
  const sim = mk("30");
  sim.drive({ ms: 2000, work: () => 15 });
  const row = sim.p.take();
  assert.equal(row.mode, "30");
  assert.equal(row.paced, 1);
  assert.equal(row.hz, 30);
  assert.equal(row.tickHz, 60);
  assert.equal(row.lockedFrac, 1);
  assert.ok(row.run >= 58 && row.run <= 61, `run ${row.run}`);
  assert.ok(row.skipped >= 58 && row.skipped <= 61, `skipped ${row.skipped}`);
  assert.equal(row.work50, 15);
  assert.equal(row.work90, 15);
  assert.equal(row.workMax, 15);
  const empty = sim.p.take();
  assert.equal(empty.run, 0);
  assert.equal(empty.lockedFrac, 0);
  assert.equal(sim.p.gaps.length > 50, true, "the meter's rendered-frame gaps");
});

test("paceInstall wraps the step Phaser binds at start(), not the NOOP the loop holds at construction", () => {
  // The bug the probe caught: TimeStep.callback is NOOP until Game.start(),
  // so a wrap taken when `new Phaser.Game` returns is overwritten by start()
  // and the pacer never ticks.
  const calls: [number, number][] = [];
  const noop = () => {};
  const real = (time: number, delta: number) => calls.push([time, delta]);
  const handlers: Record<string, () => void> = {};
  const game = {
    loop: { callback: noop as (t: number, d: number) => void, delta: 0, rawDelta: 0 },
    isRunning: false,
    events: { once: (ev: string, fn: () => void) => { handlers[ev] = fn; } },
  };
  paceInstall(game);
  assert.equal(game.loop.callback, noop, "nothing wrapped before the game runs");
  assert.ok(handlers.prestep, "waits for the first pre-step");
  game.loop.callback = real; // Game.start()
  game.isRunning = true;
  handlers.prestep(); // emitted from inside the first real step
  assert.notEqual(game.loop.callback, real, "the wrapper is in place");
  game.loop.rawDelta = 16.67;
  game.loop.callback(1000, 16.67);
  assert.deepEqual(calls, [[1000, 16.67]], "the real step ran through the wrapper with its delta");
  assert.equal(game.loop.delta, 16.67, "game.loop.delta agrees with the delta handed to the step");
  // A game already running is wrapped at once.
  const calls2: number[] = [];
  const game2 = { loop: { callback: (t: number, _d: number) => calls2.push(t), delta: 0, rawDelta: 16.67 }, isRunning: true, events: { once: () => { throw new Error("no wait"); } } };
  paceInstall(game2);
  game2.loop.callback(2000, 16.67);
  assert.deepEqual(calls2, [2000]);
});
