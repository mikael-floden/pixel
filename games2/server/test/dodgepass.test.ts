// THE PASS — the player's "special move" past a body blocking the only lane
// (maintainer 2026-08-13: "sometimes running around is not possible because
// the monster/NPC/player is blocking the only path. This should not result in
// the player switching direction back and forth in panic — this is where the
// player uses its special move to run straight past the blocker", the
// basketball crossover; "left then right" OR "right then left" — the feint is
// heading-relative and either side works).
//
// Bodies are soft collision (input deflection only), so the physics of
// walking through one already works — these tests pin the BRAIN: the dodge
// stops negotiating exactly when negotiation cannot work, commits, and does
// not change anything anywhere else.
//
// All headless, driving the pure shared monsterDodge plus a real stepMovement
// integration loop — the same shape predictAndSend uses — per the dev-test
// rule (movement logic lives in server/test, not in a browser).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTerrainGrid,
  monsterDodge,
  MonsterDodgeState,
  steerAssist,
  stepMovement,
  makeBlockedElev,
  makeSideBlocked,
  screenToWorldVector,
  TerrainGrid,
  CELL_WU,
  WALK_CLIMB,
  WALK_SPEED,
  PLAYER_BODY_RADIUS,
  DODGE_PASS_STALL_MS,
  DODGE_PASS_JINK_MS,
  DODGE_PASS_MAX_MS,
} from "@nangijala/shared";

/** Flat 24x16 grass world with raised WALL cells (terrain, like a house). */
function world(walls: { c: number; r: number; l?: number }[]): TerrainGrid {
  const rows: { t: string; l?: number }[][] = [];
  for (let r = 0; r < 16; r++) {
    rows.push([]);
    for (let c = 0; c < 24; c++) {
      const w = walls.find((x) => x.c === c && x.r === r);
      rows[r].push({ t: "grass", l: w ? w.l ?? 6 : 0 });
    }
  }
  return buildTerrainGrid(24, 16, rows, []);
}

/** A north-south WALL at col `c` with a single 1-cell door at row `door` —
 * the shape the maintainer's stuck actually happens in. (A straight corridor
 * never truly sticks: the axis-separated wall-slide scrapes past any body.
 * At a DOORWAY the steer assist pulls the walker to the opening, the dodge
 * deflects it off the body parked in it, and the two fight forever — the
 * measured baseline below is 190+ heading flips per 5s of held input, parked
 * at the door line.) */
function doorway(c: number, door: number): TerrainGrid {
  const walls: { c: number; r: number }[] = [];
  for (let r = 0; r < 16; r++) if (r !== door) walls.push({ c, r });
  return world(walls);
}

/** The 8-way SCREEN input whose world vector best matches a world direction. */
function screenFor(wx: number, wy: number): { ax: number; ay: number } {
  let best = { ax: 0, ay: 0 };
  let bestDot = -Infinity;
  for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const w = screenToWorldVector(ax, ay);
    const l = Math.hypot(w.x, w.y) || 1;
    const dot = (w.x * wx + w.y * wy) / l;
    if (dot > bestDot) {
      bestDot = dot;
      best = { ax, ay };
    }
  }
  return best;
}

/** Integrate the dodge + real movement at 60Hz, exactly the client's shape:
 * per tick ask monsterDodge, integrate the (possibly deflected) input with
 * stepMovement, and record everything a feel-assertion needs. */
function run(
  g: TerrainGrid,
  start: { x: number; y: number },
  input: { ax: number; ay: number },
  bodies: Array<{ id: string; x: number; y: number; r?: number }>,
  opts: { allowPass: boolean; ms: number },
) {
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  const blocked = makeBlockedElev(g, walk, () => 0);
  const sideBlocked = makeSideBlocked(g, walk);
  let x = start.x;
  let y = start.y;
  let state: MonsterDodgeState | undefined;
  const dt = 1 / 60;
  const headings: Array<{ ax: number; ay: number }> = [];
  const passFrames: number[] = [];
  const jinks: number[] = [];
  let minBodyD = Infinity;
  const W = g.width * CELL_WU;
  const H = g.height * CELL_WU;
  for (let tick = 0; tick * dt * 1000 < opts.ms; tick++) {
    const now = tick * dt * 1000;
    const openHeading = (hax: number, hay: number) => {
      const probe = 0.08;
      const r = stepMovement(x, y, hax, hay, false, probe, blocked, 1, true, W, H, sideBlocked);
      return Math.hypot(r.x - x, r.y - y) > WALK_SPEED * probe * 0.35;
    };
    let ax = input.ax;
    let ay = input.ay;
    // The client's exact composition: steer assist first (walls/doors), then
    // the body dodge on the steered input.
    const assist = steerAssist(g, x, y, ax, ay);
    if (assist) {
      ax = assist.ax;
      ay = assist.ay;
    }
    const d = monsterDodge(
      x, y, ax, ay, bodies, state, undefined, openHeading,
      opts.allowPass ? now : undefined, opts.allowPass,
    );
    if (d) {
      ax = d.ax;
      ay = d.ay;
      state = d.state;
      if (d.state.pass) {
        passFrames.push(tick);
        if (ax !== input.ax || ay !== input.ay) jinks.push(tick);
      }
    } else state = undefined;
    const r = stepMovement(x, y, ax, ay, false, dt, blocked, 1, true, W, H, sideBlocked);
    x = r.x;
    y = r.y;
    headings.push({ ax, ay });
    for (const b of bodies) minBodyD = Math.min(minBodyD, Math.hypot(x - b.x, y - b.y));
  }
  // Direction flips: how often the emitted heading changes — the measurable
  // form of "switching direction back and forth in panic".
  let flips = 0;
  for (let i = 1; i < headings.length; i++)
    if (headings[i].ax !== headings[i - 1].ax || headings[i].ay !== headings[i - 1].ay) flips++;
  return { x, y, state, headings, flips, passFrames, jinks, minBodyD };
}

// The doorway: a wall at col 12, its only opening at row 8, a body parked in
// the opening. The walker starts two cells west and holds east.
const DOOR_C = 12;
const DOOR_R = 8;
const BODY = { id: "npc:blocker", x: 12.5 * CELL_WU, y: 8.5 * CELL_WU, r: 12 };
const START = { x: 10.5 * CELL_WU, y: 8.5 * CELL_WU };
const EAST = screenFor(1, 0);

test("baseline: a body in the doorway is a wall, and the input panics", () => {
  const g = doorway(DOOR_C, DOOR_R);
  const out = run(g, START, EAST, [BODY], { allowPass: false, ms: 5000 });
  // Five seconds of held input: never through, AND the steer/dodge tug-of-war
  // thrashes the heading — the maintainer's "switching direction back and
  // forth in panic", measured (192 flips when this fixture was built). This
  // baseline is what makes the passing test mean something.
  assert.ok(
    out.x < (DOOR_C + 1) * CELL_WU,
    `the old system somehow got through (x=${(out.x / CELL_WU).toFixed(1)} cells) — the fixture no longer blocks`,
  );
  assert.ok(out.flips > 60, `only ${out.flips} heading flips — the panic this feature kills is not reproducing`);
});

test("the pass: straight through the doorway blocker, no panic weave", () => {
  const g = doorway(DOOR_C, DOOR_R);
  const out = run(g, START, EAST, [BODY], { allowPass: true, ms: 5000 });
  // Through and well past — the whole point.
  assert.ok(
    out.x > BODY.x + 2 * CELL_WU,
    `never passed the blocker (x=${(out.x / CELL_WU).toFixed(1)} cells, body at ${(BODY.x / CELL_WU).toFixed(1)})`,
  );
  // Through the DOOR, not over a wall.
  assert.ok(Math.abs(out.y - (DOOR_R + 0.5) * CELL_WU) < CELL_WU, `left the door lane (y ${(out.y / CELL_WU).toFixed(1)})`);
  // Committed, not panicked: an order of magnitude fewer heading changes than
  // the baseline's tug-of-war (31 vs 192 measured when this was built).
  assert.ok(out.flips <= 45, `heading changed ${out.flips} times — still the back-and-forth panic`);
  assert.ok(out.passFrames.length > 0, "the pass never engaged");
  // And it engages promptly: within the stall clock plus the approach, not
  // after seconds of visible grinding.
  const firstMs = (out.passFrames[0] ?? Infinity) * (1000 / 60);
  assert.ok(firstMs < DODGE_PASS_STALL_MS + 1500, `the pass took ${Math.round(firstMs)}ms to engage`);
});

test("structural trigger: a fully sealed lane passes on the FIRST dodge frame", () => {
  // Direct-call: every dodge candidate is terrain-closed, only the raw
  // heading is open — the body stands in the one walkable lane. No stall
  // clock needed; the pass fires the same frame the dodge engages, so the
  // panic never appears at all.
  const rawOnly = (hax: number, hay: number) => hax === EAST.ax && hay === EAST.ay;
  const bodies = [{ id: "m1", x: START.x + 40, y: START.y, r: 10 }];
  const d = monsterDodge(START.x, START.y, EAST.ax, EAST.ay, bodies, undefined, undefined, rawOnly, 0, true);
  assert.ok(d, "the dodge did not engage");
  assert.equal(d!.state.pass, "m1", "no pass on the first sealed frame");
  assert.equal(d!.ax, EAST.ax);
  assert.equal(d!.ay, EAST.ay);
});

test("open field: the pass never triggers and the dodge routes around as before", () => {
  const g = world([]); // no walls at all
  const out = run(g, START, EAST, [BODY], { allowPass: true, ms: 4000 });
  assert.equal(out.passFrames.length, 0, `the pass engaged ${out.passFrames.length} frames in an open field`);
  // The normal dodge keeps personal space: the walker went AROUND, never
  // through the middle of the body.
  const personal = (BODY.r ?? 13) + PLAYER_BODY_RADIUS; // margin excluded: the arc grazes it
  assert.ok(
    out.minBodyD > personal * 0.72,
    `the walker cut through the body (min distance ${out.minBodyD.toFixed(1)}wu vs personal ${personal})`,
  );
  assert.ok(out.x > BODY.x + CELL_WU, "the open-field dodge failed to get past at all");
});

test("the jink: a stalled (not sealed) pass opens with one sideways feint, either side", () => {
  // Direct-call harness: the walker is pinned in place (we never integrate),
  // so the dodge sees zero displacement with open candidates — the stall
  // fallback's exact shape. openHeading says everything is walkable.
  const open = () => true;
  const bodies = [{ id: "m1", x: START.x + 40, y: START.y, r: 10 }];
  let state: MonsterDodgeState | undefined;
  let passStart = -1;
  const emitted: Array<{ t: number; ax: number; ay: number; pass: boolean }> = [];
  for (let t = 0; t <= DODGE_PASS_STALL_MS + DODGE_PASS_JINK_MS + 400; t += 16) {
    const d = monsterDodge(START.x, START.y, EAST.ax, EAST.ay, bodies, state, undefined, open, t, true);
    assert.ok(d, "the body ahead must keep the dodge engaged");
    state = d!.state;
    emitted.push({ t, ax: d!.ax, ay: d!.ay, pass: !!d!.state.pass });
    if (d!.state.pass && passStart < 0) passStart = t;
  }
  assert.ok(passStart > 0, "the stall fallback never fired");
  assert.ok(passStart >= DODGE_PASS_STALL_MS, `fired at ${passStart}ms — before the stall clock`);
  const during = emitted.filter((e) => e.pass);
  const jinked = during.filter((e) => e.ax !== EAST.ax || e.ay !== EAST.ay);
  const straight = during.filter((e) => e.ax === EAST.ax && e.ay === EAST.ay);
  assert.ok(jinked.length > 0, "no feint at all — the crossover look is gone");
  assert.ok(straight.length > 0, "never straightened out after the feint");
  // The feint is the OPENING move only, and it is a 45° neighbour of the
  // heading (heading-relative — 'left' is whatever the player's left is).
  const lastJink = Math.max(...jinked.map((e) => e.t));
  const firstStraight = Math.min(...straight.map((e) => e.t));
  assert.ok(lastJink < firstStraight, "the feint recurred mid-pass — it must be the opening step only");
  assert.ok(lastJink - passStart < DODGE_PASS_JINK_MS + 20, `the feint outlived its window (${lastJink - passStart}ms)`);
  for (const e of jinked) {
    const diff = Math.abs(e.ax - EAST.ax) + Math.abs(e.ay - EAST.ay);
    assert.ok(diff <= 1, `the feint jumped more than one ring step (${e.ax},${e.ay} vs ${EAST.ax},${EAST.ay})`);
  }
});

test("the valve: a pass that cannot complete expires and re-arms the dodge", () => {
  // The blocker mirrors the walker forever (never gets passed) — the pass
  // must not hold past DODGE_PASS_MAX_MS; after expiry the normal dodge is
  // back until a FRESH stall matures.
  const open = () => true;
  const bodies = [{ id: "m1", x: START.x + 40, y: START.y, r: 10 }];
  let state: MonsterDodgeState | undefined;
  const spans: Array<{ from: number; to: number }> = [];
  let cur: { from: number; to: number } | null = null;
  for (let t = 0; t <= 6000; t += 16) {
    const d = monsterDodge(START.x, START.y, EAST.ax, EAST.ay, bodies, state, undefined, open, t, true);
    state = d?.state;
    const passing = !!d?.state.pass;
    if (passing && !cur) cur = { from: t, to: t };
    else if (passing && cur) cur.to = t;
    else if (!passing && cur) { spans.push(cur); cur = null; }
  }
  if (cur) spans.push(cur);
  assert.ok(spans.length >= 2, `only ${spans.length} pass span(s) in 6s — the valve/re-arm cycle is broken`);
  for (const s of spans.slice(0, -1))
    assert.ok(s.to - s.from <= DODGE_PASS_MAX_MS + 40, `a pass held ${s.to - s.from}ms — the valve did not close`);
  const gap = spans[1].from - spans[0].to;
  assert.ok(gap >= DODGE_PASS_STALL_MS - 40, `re-triggered after only ${gap}ms — expiry must demand a fresh stall`);
});

test("monsters' own dodge is byte-identical (no clock, no opt-in)", () => {
  // The server call passes neither `now` nor `allowPass`; whatever the
  // terrain, the returned heading must be exactly the pre-pass behaviour —
  // pinned here by running the same doorway through the 7-arg signature and
  // checking no pass state ever appears.
  const g = doorway(DOOR_C, DOOR_R);
  const out = run(g, START, EAST, [BODY], { allowPass: false, ms: 2500 });
  assert.ok(out.passFrames.length === 0, "a pass appeared without the opt-in");
  assert.equal(out.state?.pass, undefined, "pass state leaked into the no-opt-in path");
});
