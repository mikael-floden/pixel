import { test } from "node:test";
import assert from "node:assert/strict";
import { directorRunsNow } from "../../ambient/runtime/cadence.js";

/* The env tick's second half must run on SOME frame in every regime. Walked
 * frame by frame the way mount.ts walks it: envAge accumulates dt, an env
 * frame resets it and sets `due`, the director clears `due`. */
function walk(dts: number[], sampleMs = 100) {
  let envAge = 0, due = false;
  const log: { env: boolean; director: boolean }[] = [];
  for (const dt of dts) {
    envAge += dt;
    const env = envAge >= sampleMs;
    if (env) { envAge = 0; due = true; }
    const director = directorRunsNow(env, due, dt, sampleMs);
    if (director) due = false;
    log.push({ env, director });
  }
  return log;
}

test("fast frames: the director takes the frame AFTER an env frame and never shares one", () => {
  const log = walk(new Array(120).fill(16));
  const envFrames = log.filter((f) => f.env).length;
  const shared = log.filter((f) => f.env && f.director).length;
  const runs = log.filter((f) => f.director).length;
  assert.ok(envFrames >= 15, `env frames ${envFrames}`);
  assert.equal(shared, 0, "a fast frame carried both halves");
  assert.equal(runs, envFrames, "one director run per env frame");
  for (let i = 1; i < log.length; i++) if (log[i - 1].env) assert.ok(log[i].director, `frame ${i} should be the director's`);
});

test("slow frames: EVERY frame is an env frame, and the director still runs — on the same frame — instead of never", () => {
  const log = walk(new Array(40).fill(250));
  assert.ok(log.every((f) => f.env), "every 250 ms frame is an env frame");
  const runs = log.filter((f) => f.director).length;
  assert.ok(runs >= 39, `director ran ${runs} of 40 — the rule as first written ran it 0 times`);
});

test("a burst of long frames inside a fast run costs at most one env period of director latency", () => {
  const dts = [...new Array(30).fill(16), ...new Array(6).fill(180), ...new Array(30).fill(16)];
  const log = walk(dts);
  let worst = 0, since = 0;
  for (const f of log) { if (f.env) since++; if (f.director) { worst = Math.max(worst, since); since = 0; } }
  assert.ok(worst <= 1, `an env sample waited ${worst} periods for its director`);
});

test("not due, no run — the director never ticks twice on one sample", () => {
  assert.equal(directorRunsNow(false, false, 16, 100), false);
  assert.equal(directorRunsNow(true, false, 250, 100), false);
  assert.equal(directorRunsNow(false, true, 16, 100), true);
  assert.equal(directorRunsNow(true, true, 99, 100), false, "a fast env frame still waits");
  assert.equal(directorRunsNow(true, true, 100, 100), true);
});
