// Chess at the board, end to end in a LIVE room: proximity seating, the
// waiting bubble contract, pre-rolled dice, authority (illegal move ignored),
// clocks, resign, NPC opponent, timeout. Port 2970 — unique per file, see
// ports.test.ts for why this is load-bearing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, Room } from "colyseus.js";
import { ROOM_NAME, CELL_WU, parseWorld, buildTerrainGrid, surfaceFor } from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";

// One port PER TEST: gracefullyShutdown resolves before the OS has freed the
// socket, so reusing one port makes the next test's listen() race EADDRINUSE
// (it lost by 3.5ms in the full run and won in isolation). Ports repeat
// freely ACROSS files only when distinct from every other file's (ports.test.ts).
let PORT = 2966;
type AnyRoom = Room<any>;

async function waitFor(cond: () => boolean, timeout = 6000): Promise<void> {
  const start = Date.now();
  const ready = () => { try { return cond(); } catch { return false; } };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 40));
  }
}

// Boards are injected via room options so the test controls geometry
// completely, but the geometry is the_game's: a flat 7x7 patch of level-0
// standable ground — no deck, no scenery within 6 cells — nearest the declared
// spawn, derived from the world doc so a reshaped town moves the boards, not
// the test. Two boards four rows apart, seats a cell either side.
const WORLD_PATH = pathJoin(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json");
const SKIP = "maps2/worlds3/the_game missing"; // the deploy's test job checks out no world tree
function flatPatch(): { c: number; r: number } {
  const doc = JSON.parse(readFileSync(WORLD_PATH, "utf8"));
  const world = parseWorld(doc)!;
  const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks);
  const scenery = world.scenery ?? [];
  const spawn = world.spawn!;
  let best: { c: number; r: number; d: number } | null = null;
  for (let r = 8; r < world.height - 8; r++) {
    for (let c = 8; c < world.width - 8; c++) {
      const d = Math.hypot(c - spawn[0], r - spawn[1]);
      if (best && d >= best.d) continue;
      let flat = true;
      for (let dr = -3; dr <= 3 && flat; dr++) {
        for (let dc = -3; dc <= 3 && flat; dc++) {
          const i = (r + dr) * grid.width + c + dc;
          if (grid.level[i] !== 0 || grid.deck[i] >= 0 || !surfaceFor(grid.type[i]).standable) flat = false;
        }
      }
      if (!flat) continue;
      if (scenery.some((p) => Math.abs(p.x - (c + 0.5)) <= 6 && Math.abs(p.y - (r + 0.5)) <= 6)) continue;
      best = { c, r, d };
    }
  }
  assert.ok(best, "the_game has no flat scenery-free 7x7 patch to put two chess boards on");
  return best!;
}
const P = existsSync(WORLD_PATH) ? flatPatch() : { c: 0, r: 0 };
const BOARDS = [
  { id: "pvp", col: P.c, row: P.r - 2, seatA: [P.c - 1, P.r - 2] as [number, number], seatB: [P.c + 1, P.r - 2] as [number, number] },
  { id: "bot", col: P.c, row: P.r + 2, seatA: [P.c - 1, P.r + 2] as [number, number], seatB: [P.c + 1, P.r + 2] as [number, number], npc: "Wendell" },
];
if (existsSync(WORLD_PATH)) console.log(`chessroom: boards on the_game at ${BOARDS[0].col},${BOARDS[0].row} and ${BOARDS[1].col},${BOARDS[1].row}`);

/** The repo's proven lifecycle (torch.test.ts): server per TEST, closed in a
 * finally with gracefullyShutdown(false) — a hook-held server keeps the node
 * test runner's process alive forever and the whole file "hangs". */
async function withServer(fn: () => Promise<void>): Promise<void> {
  PORT += 2;
  const gameServer = new Server({ greet: false, transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world"]);
  await gameServer.listen(PORT);
  try { await fn(); } finally { await gameServer.gracefullyShutdown(false); }
}

// Explicit seating since 2026-08-22 (maintainer: the jump button reads
// START/JOIN CHESSGAME): stand at the seat, then SEND chess.sit — walking
// past a board must never seat anyone, which the PvP test asserts.
const sit = async (r: AnyRoom, c: number, row: number) => {
  r.send("teleport", { x: (c + 0.5) * CELL_WU, y: (row + 0.5) * CELL_WU });
  await new Promise((res) => setTimeout(res, 350)); // teleport lands, tick sees it
  r.send("chess.sit", {});
};

async function join(world: string, opts: Record<string, unknown> = {}): Promise<AnyRoom> {
  const c = new Client(`ws://localhost:${PORT}`);
  const r = await c.joinOrCreate(ROOM_NAME, { world, name: "t", ...opts });
  await waitFor(() => r.state.players?.size >= 1);
  return r as AnyRoom;
}

const pvp = BOARDS[0];
const bot = BOARDS[1];

test("PvP: seat -> wait bubble -> match -> dice -> moves -> resign", async (t) => { if (!existsSync(WORLD_PATH)) return t.skip(SKIP); await withServer(async () => {
  const opts = { chessBoards: BOARDS, monsterCount: 0 };
  const a = await join("the_game", opts);
  const b = await join("the_game", opts);
  await waitFor(() => a.state.chessBoards?.size === 2);

  // Standing there alone does NOT seat you — the press does.
  a.send("teleport", { x: (pvp.seatA[0] + 0.5) * CELL_WU, y: (pvp.seatA[1] + 0.5) * CELL_WU });
  await new Promise((res) => setTimeout(res, 700));
  assert.equal(a.state.chessBoards.get("pvp")?.waitingSid ?? "", "", "no auto-seat from proximity");
  a.send("chess.sit", {});
  await waitFor(() => a.state.chessBoards.get("pvp")?.waitingSid === a.sessionId);

  await sit(b, pvp.seatB[0], pvp.seatB[1]);
  await waitFor(() => a.state.chessMatches?.size === 1);
  const mid: string = [...a.state.chessMatches.keys()][0];
  const m = () => a.state.chessMatches.get(mid)!;
  assert.equal(m().phase, "dice");
  assert.equal(a.state.chessBoards.get("pvp")!.waitingSid, "", "bubble cleared once matched");

  a.send("chess.dice", { m: mid });
  b.send("chess.dice", { m: mid });
  await waitFor(() => m().phase === "play");
  // Canon (maintainer 2026-08-22): winner throws 6, loser 1 — the two hand
  // animations end on exactly those faces.
  assert.ok([m().diceA, m().diceB].sort().join(",") === "1,6", "dice are always {6,1}");
  const whiteRoom: AnyRoom = m().whiteSid === a.sessionId ? a : b;
  const blackRoom: AnyRoom = whiteRoom === a ? b : a;
  assert.equal(m().turnStart, 0, "clock not running before white's first move");

  blackRoom.send("chess.move", { m: mid, mv: "e2e4" }); // out of turn: ignored
  whiteRoom.send("chess.move", { m: mid, mv: "e2e5" }); // illegal: ignored
  whiteRoom.send("chess.move", { m: mid, mv: "e2e4" });
  await waitFor(() => m().moves.length === 1);
  assert.ok(m().turnStart > 0, "clock runs from white's first move");
  blackRoom.send("chess.move", { m: mid, mv: "e7e5" });
  await waitFor(() => m().moves.length === 2);

  blackRoom.send("chess.resign", { m: mid });
  await waitFor(() => m().phase === "over");
  assert.equal(m().result, "w");
  assert.equal(m().reason, "resign");
  a.send("chess.close", { m: mid }); b.send("chess.close", { m: mid });
  await waitFor(() => a.state.chessMatches.size === 0);
  await a.leave(); await b.leave();
}); });

test("NPC board: instant match, NPC throws its die and answers moves", async (t) => { if (!existsSync(WORLD_PATH)) return t.skip(SKIP); await withServer(async () => {
  const a = await join("the_game", { chessBoards: BOARDS, monsterCount: 0 });
  await waitFor(() => a.state.chessBoards?.size === 2);
  await sit(a, bot.seatA[0], bot.seatA[1]);
  await waitFor(() => a.state.chessMatches?.size === 1, 4000);
  const mid: string = [...a.state.chessMatches.keys()][0];
  const m = () => a.state.chessMatches.get(mid)!;
  assert.equal(m().bSid, "npc");
  a.send("chess.dice", { m: mid });
  await waitFor(() => m().phase === "play", 6000); // NPC die lands on its own
  // Play until it is MY turn, then move; the NPC must reply.
  const mySide = m().whiteSid === a.sessionId ? "w" : "b";
  if (m().turn !== mySide) await waitFor(() => m().turn === mySide || m().phase === "over", 8000);
  const before = m().moves.length;
  a.send("chess.move", { m: mid, mv: mySide === "w" ? "e2e4" : "e7e5" });
  await waitFor(() => m().moves.length >= before + 2, 9000); // mine + the NPC's
  assert.ok(m().moves.length >= before + 2, "NPC replied");
  a.send("chess.resign", { m: mid });
  await waitFor(() => m().phase === "over");
  assert.equal(m().result, mySide === "w" ? "b" : "w");
  await a.leave();
}); });

test("timeout: the bank empties and the flag falls", async (t) => { if (!existsSync(WORLD_PATH)) return t.skip(SKIP); await withServer(async () => {
  const a = await join("the_game", { chessBoards: BOARDS, monsterCount: 0, chessClockMs: 1200 });
  const b = await join("the_game", { chessBoards: BOARDS, monsterCount: 0, chessClockMs: 1200 });
  await waitFor(() => a.state.chessBoards?.size === 2);
  await sit(a, pvp.seatA[0], pvp.seatA[1]); await sit(b, pvp.seatB[0], pvp.seatB[1]);
  await waitFor(() => a.state.chessMatches?.size >= 1);
  const mid: string = [...a.state.chessMatches.keys()][0];
  const m = () => a.state.chessMatches.get(mid)!;
  a.send("chess.dice", { m: mid }); b.send("chess.dice", { m: mid });
  await waitFor(() => m().phase === "play");
  const whiteRoom: AnyRoom = m().whiteSid === a.sessionId ? a : b;
  whiteRoom.send("chess.move", { m: mid, mv: "e2e4" }); // starts black's burn
  await waitFor(() => m().moves.length === 1);
  await waitFor(() => m().phase === "over", 8000); // black never moves -> flag
  assert.equal(m().result, "w");
  assert.equal(m().reason, "time");
  await a.leave(); await b.leave();
}); });
