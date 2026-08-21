// Chess at the board, end to end in a LIVE room: proximity seating, the
// waiting bubble contract, pre-rolled dice, authority (illegal move ignored),
// clocks, resign, NPC opponent, timeout. Port 2970 — unique per file, see
// ports.test.ts for why this is load-bearing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, Room } from "colyseus.js";
import { ROOM_NAME, CELL_WU } from "@nangijala/shared";
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

// monster_demo is small and flat; boards are injected via room options so the
// test controls geometry completely.
const BOARDS = [
  { id: "pvp", col: 10, row: 7, seatA: [9, 7] as [number, number], seatB: [11, 7] as [number, number] },
  { id: "bot", col: 10, row: 11, seatA: [9, 11] as [number, number], seatB: [11, 11] as [number, number], npc: "Wendell" },
];

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

const sit = (r: AnyRoom, c: number, row: number) =>
  r.send("teleport", { x: (c + 0.5) * CELL_WU, y: (row + 0.5) * CELL_WU });

async function join(world: string, opts: Record<string, unknown> = {}): Promise<AnyRoom> {
  const c = new Client(`ws://localhost:${PORT}`);
  const r = await c.joinOrCreate(ROOM_NAME, { world, name: "t", ...opts });
  await waitFor(() => r.state.players?.size >= 1);
  return r as AnyRoom;
}

test("PvP: seat -> wait bubble -> match -> dice -> moves -> resign", async () => { await withServer(async () => {
  const opts = { chessBoards: BOARDS, monsterCount: 0 };
  const a = await join("monster_demo", opts);
  const b = await join("monster_demo", opts);
  await waitFor(() => a.state.chessBoards?.size === 2);

  sit(a, 9, 7);
  await waitFor(() => a.state.chessBoards.get("pvp")?.waitingSid === a.sessionId);

  sit(b, 11, 7);
  await waitFor(() => a.state.chessMatches?.size === 1);
  const mid: string = [...a.state.chessMatches.keys()][0];
  const m = () => a.state.chessMatches.get(mid)!;
  assert.equal(m().phase, "dice");
  assert.equal(a.state.chessBoards.get("pvp")!.waitingSid, "", "bubble cleared once matched");

  a.send("chess.dice", { m: mid });
  b.send("chess.dice", { m: mid });
  await waitFor(() => m().phase === "play");
  assert.ok(m().diceA >= 1 && m().diceB >= 1 && m().diceA !== m().diceB, "pre-rolled, never equal");
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

test("NPC board: instant match, NPC throws its die and answers moves", async () => { await withServer(async () => {
  const a = await join("monster_demo", { chessBoards: BOARDS, monsterCount: 0 });
  await waitFor(() => a.state.chessBoards?.size === 2);
  sit(a, 9, 11);
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

test("timeout: the bank empties and the flag falls", async () => { await withServer(async () => {
  const a = await join("monster_demo", { chessBoards: BOARDS, monsterCount: 0, chessClockMs: 1200 });
  const b = await join("monster_demo", { chessBoards: BOARDS, monsterCount: 0, chessClockMs: 1200 });
  await waitFor(() => a.state.chessBoards?.size === 2);
  sit(a, 9, 7); sit(b, 11, 7);
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
