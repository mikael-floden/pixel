/**
 * CHESS AT THE BOARD — the server half. The world holds a few physical chess
 * boards; STANDING at a free seat is the whole matchmaking UI:
 *   - first player at a seat -> board.waitingSid (all clients bubble them);
 *   - second player at the other seat (or the board has a resident NPC) ->
 *     a ChessMatch both clients open as a dialog.
 * Walking away cancels a wait; leaving the room mid-match resigns.
 *
 * AUTHORITY: every move is validated by the shared rules (the client only
 * highlights). Clocks are banks-at-turnStart; the server settles a bank at
 * move receipt and flags timeouts in a 1s sweep that exists only while a
 * match is live. Dice are PRE-ROLLED at match creation with unequal values
 * (maintainer: predetermined so it cannot draw) — the client's throw is
 * theater that reveals them.
 *
 * NPC CPU BUDGET (maintainer: "almost 0 server CPU"): the brain is the shared
 * node-capped negamax — measured ~3ms per reply, scheduled once per opponent
 * move on a 1.2-2.6s humanizing delay, zero cost between moves. Boards come
 * from config/chess_boards.json, overridable per-world via the live channel
 * (tuning/chess.json) so the maintainer can add/move boards from his phone.
 */
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { ArraySchema } from "@colyseus/schema";
import {
  CELL_WU,
  ChessState, chessInitial, chessApply, chessParseMove, chessOutcome, chessKey, chessAiMove, chessMoveStr,
} from "@nangijala/shared";
import { ChessBoard, ChessMatch, WorldState } from "./schema/WorldState.js";
import { liveTuning } from "./live.js";

export interface ChessBoardCfg {
  id: string; col: number; row: number;
  seatA: [number, number]; seatB: [number, number];
  npc?: string; // display name of the resident opponent; presence makes it an NPC board
  sprite?: string; // /assets path of the in-world board art (scenery piece)
  bubble?: string; // /assets path of the challenge speech-bubble art
}

const CFG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "chess_boards.json");

export function chessBoardsFor(world: string, override?: ChessBoardCfg[]): ChessBoardCfg[] {
  if (override) return override;
  // live doc wins per WORLD; baked config is the boot truth. Shape:
  // { format, worlds: { <world>: [ {id,col,row,seatA,seatB,npc?} ] } }
  const live = (liveTuning() as { chess?: { worlds?: Record<string, ChessBoardCfg[]> } }).chess?.worlds?.[world];
  if (Array.isArray(live)) return live;
  try {
    if (existsSync(CFG_PATH)) {
      const doc = JSON.parse(readFileSync(CFG_PATH, "utf8")) as { worlds?: Record<string, ChessBoardCfg[]> };
      return doc.worlds?.[world] ?? [];
    }
  } catch { /* a broken config means no boards, never a dead room */ }
  return [];
}

// Stand ANYWHERE beside the table (maintainer 2026-08-22, with a screenshot
// of two players 1.6 cells out and a dead board: "can't press anything!").
// The first cut demanded the exact seat cell within 0.95 — pixel-parking no
// real human does. 1.75 cells from the TABLE CENTRE covers every touching
// cell including diagonals with margin for standing half-off one.
const TABLE_RADIUS_WU = CELL_WU * 1.75;
const CLOCK_MS_DEFAULT = 10 * 60 * 1000;
const NPC_MIN_DELAY = 1200, NPC_DELAY_SPREAD = 1400;

type Live = {
  match: ChessMatch;
  st: ChessState;
  reps: Map<string, number>;
  seed: number;
  npcTimer?: { clear(): void };
};

export class ChessManager {
  private live = new Map<string, Live>();
  private nextId = 1;

  constructor(
    private state: WorldState,
    private clockMs: number,
    private now: () => number,
    private setTimeout_: (fn: () => void, ms: number) => { clear(): void },
    private npcNodes = 2500,
  ) {}

  addBoards(cfgs: ChessBoardCfg[]) {
    for (const c of cfgs) {
      const b = new ChessBoard();
      b.id = c.id; b.col = c.col; b.row = c.row;
      b.seatAc = c.seatA[0]; b.seatAr = c.seatA[1];
      b.seatBc = c.seatB[0]; b.seatBr = c.seatB[1];
      b.npc = c.npc ?? ""; b.waitingSid = ""; b.matchId = "";
      b.sprite = c.sprite ?? ""; b.bubble = c.bubble ?? "";
      this.state.chessBoards.set(c.id, b);
    }
  }

  /**
   * SEATING IS A BUTTON PRESS, NOT PROXIMITY (maintainer 2026-08-22: stand
   * close to a side and the jump button reads "START CHESS GAME"/"JOIN CHESS
   * GAME"). The client sends chess.sit; the server validates you really stand
   * at a free seat. Nobody is ever seated by merely walking past a board.
   */
  sit(sid: string) {
    const p = this.state.players.get(sid);
    if (!p || p.dead || this.inMatch(sid)) return;
    let best: { b: ChessBoard; d: number } | null = null;
    this.state.chessBoards.forEach((b) => {
      if (b.matchId || b.waitingSid === sid) return;
      const d = this.tableDist(p.x, p.y, b);
      if (d <= TABLE_RADIUS_WU && (!best || d < best.d)) best = { b, d };
    });
    if (!best) return;
    const b = (best as { b: ChessBoard }).b;
    if (b.npc) return this.startMatch(b, sid, "npc");
    if (b.waitingSid && b.waitingSid !== sid) return this.startMatch(b, b.waitingSid, sid);
    b.waitingSid = sid;
  }

  /** Distance to the TABLE itself — the join zone is the whole ring of cells
   * around it, not two blessed seats. */
  private tableDist(x: number, y: number, b: ChessBoard): number {
    return Math.hypot(x - (b.col + 0.5) * CELL_WU, y - (b.row + 0.5) * CELL_WU);
  }

  /** Housekeeping at ~4Hz: a waiting player who walked away stops waiting; a
   * deserted match resigns; the clock sweeps while matches live. */
  tick() {
    this.state.chessBoards.forEach((b) => {
      if (b.matchId) { this.checkDeserted(b); return; }
      if (b.waitingSid) {
        const p = this.state.players.get(b.waitingSid);
        if (!p || p.dead || this.tableDist(p.x, p.y, b) > TABLE_RADIUS_WU * 1.4) b.waitingSid = "";
      }
    });
    if (this.live.size) this.sweep();
  }


  private inMatch(sid: string): boolean {
    for (const l of this.live.values()) if (l.match.aSid === sid || l.match.bSid === sid) return true;
    return false;
  }

  private startMatch(b: ChessBoard, aSid: string, bSid: string) {
    const m = new ChessMatch();
    m.id = `m${this.nextId++}`;
    m.boardId = b.id; m.aSid = aSid; m.bSid = bSid;
    m.phase = "dice"; m.diceA = 0; m.diceB = 0; m.whiteSid = "";
    m.moves = new ArraySchema<string>();
    m.turn = "w"; m.wMs = this.clockMs; m.bMs = this.clockMs; m.turnStart = 0;
    m.result = ""; m.reason = "";
    const seed = (this.now() ^ (this.nextId * 2654435761)) >>> 0;
    const l: Live = { match: m, st: chessInitial(), reps: new Map(), seed };
    // Pre-rolled and CANON: the winner always throws a 6, the loser a 1
    // (maintainer 2026-08-22) — the two hand-throw animations END on exactly
    // those faces, so the player watches "their" throw land on the number
    // that decided their colour. A seeded coin picks the winner; it can
    // never draw by construction.
    const winnerA = ((seed >>> 8) & 1) === 0;
    (l as Live & { rolledA: number; rolledB: number }).rolledA = winnerA ? 6 : 1;
    (l as Live & { rolledA: number; rolledB: number }).rolledB = winnerA ? 1 : 6;
    this.live.set(m.id, l);
    this.state.chessMatches.set(m.id, m);
    b.matchId = m.id; b.waitingSid = "";
    // The NPC "throws" its die on its own after a beat.
    if (bSid === "npc") this.setTimeout_(() => this.throwDice(m.id, "npc"), 900);
  }

  throwDice(matchId: string, sid: string) {
    const l = this.live.get(matchId);
    if (!l || l.match.phase !== "dice") return;
    const m = l.match;
    const r = l as Live & { rolledA: number; rolledB: number };
    if (sid === m.aSid && m.diceA === 0) m.diceA = r.rolledA;
    else if (sid === m.bSid && m.diceB === 0) m.diceB = r.rolledB;
    else return;
    if (m.diceA > 0 && m.diceB > 0) {
      m.whiteSid = m.diceA > m.diceB ? m.aSid : m.bSid;
      m.phase = "play"; m.turn = "w"; m.turnStart = 0; // white's clock waits for move 1
      if (this.npcSide(m) === "w") this.scheduleNpc(m.id);
    }
  }

  /** Which colour the NPC plays, or "" on a PvP board. */
  private npcSide(m: ChessMatch): "w" | "b" | "" {
    if (m.bSid !== "npc") return "";
    return m.whiteSid === "npc" ? "w" : "b";
  }

  private sideOf(m: ChessMatch, sid: string): "w" | "b" | "" {
    if (sid !== m.aSid && sid !== m.bSid) return "";
    return m.whiteSid === sid ? "w" : "b";
  }

  move(matchId: string, sid: string, moveStr: string) {
    const l = this.live.get(matchId);
    if (!l || l.match.phase !== "play") return;
    const m = l.match;
    const side = this.sideOf(m, sid);
    if (side !== m.turn) return;
    this.applyMove(l, moveStr);
  }

  private applyMove(l: Live, moveStr: string) {
    const m = l.match;
    const mv = chessParseMove(l.st, String(moveStr).slice(0, 5));
    if (!mv) return; // illegal or garbage: ignore, client resyncs from moves[]
    const now = this.now();
    // settle the mover's bank (white's move 1 burns nothing: turnStart is 0)
    if (m.turnStart > 0) {
      const spent = now - m.turnStart;
      if (m.turn === "w") m.wMs = Math.max(0, m.wMs - spent);
      else m.bMs = Math.max(0, m.bMs - spent);
    }
    l.st = chessApply(l.st, mv);
    const key = chessKey(l.st);
    l.reps.set(key, (l.reps.get(key) ?? 0) + 1);
    m.moves.push(chessMoveStr(mv));
    m.turn = l.st.turn === 1 ? "w" : "b";
    m.turnStart = now; // from white's first move on, someone is always burning
    const out = chessOutcome(l.st, l.reps.get(key) ?? 1);
    if (out.over) {
      const winner = out.winner === 0 ? "draw" : out.winner === 1 ? "w" : "b";
      return this.finish(l, winner, out.reason);
    }
    if (this.npcSide(m) === m.turn) this.scheduleNpc(m.id);
  }

  private scheduleNpc(matchId: string) {
    const l = this.live.get(matchId);
    if (!l) return;
    const delay = NPC_MIN_DELAY + ((l.seed = (l.seed * 48271) % 2147483647) % NPC_DELAY_SPREAD);
    l.npcTimer = this.setTimeout_(() => {
      const cur = this.live.get(matchId);
      if (!cur || cur.match.phase !== "play") return;
      if (this.npcSide(cur.match) !== cur.match.turn) return;
      const mv = chessAiMove(cur.st, { nodes: this.npcNodes, seed: cur.seed });
      if (mv) this.applyMove(cur, chessMoveStr(mv));
    }, delay);
  }

  resign(matchId: string, sid: string) {
    const l = this.live.get(matchId);
    if (!l || l.match.phase === "over") return;
    const side = this.sideOf(l.match, sid);
    if (!side) return;
    this.finish(l, side === "w" ? "b" : "w", "resign");
  }

  /** A closed dialog / departure claim: once BOTH humans have closed (or on a
   * timer) the match schema is swept. */
  dismiss(matchId: string, sid: string) {
    const l = this.live.get(matchId);
    if (!l || l.match.phase !== "over") return;
    (l as Live & { closed?: Set<string> }).closed ??= new Set();
    (l as Live & { closed: Set<string> }).closed.add(sid);
    const humans = [l.match.aSid, l.match.bSid].filter((s) => s !== "npc");
    if (humans.every((h) => (l as Live & { closed: Set<string> }).closed.has(h))) this.sweepMatch(matchId);
  }

  onPlayerLeave(sid: string) {
    for (const l of this.live.values()) {
      const m = l.match;
      if (m.phase !== "over" && (m.aSid === sid || m.bSid === sid)) this.resign(m.id, sid);
      else if (m.phase === "over" && (m.aSid === sid || m.bSid === sid)) this.dismiss(m.id, sid);
    }
    this.state.chessBoards.forEach((b) => { if (b.waitingSid === sid) b.waitingSid = ""; });
  }

  private finish(l: Live, result: string, reason: string) {
    const m = l.match;
    m.phase = "over"; m.result = result; m.reason = reason; m.turnStart = 0;
    l.npcTimer?.clear();
    const b = this.state.chessBoards.get(m.boardId);
    if (b) b.matchId = "";
    // Sweep the schema after a minute even if a client never closes.
    this.setTimeout_(() => this.sweepMatch(m.id), 60_000);
    if (m.bSid === "npc") this.setTimeout_(() => this.sweepMatch(m.id), 15_000);
  }

  private sweepMatch(matchId: string) {
    if (!this.live.has(matchId)) return;
    this.live.delete(matchId);
    this.state.chessMatches.delete(matchId);
  }

  /** 1s flag sweep + desertion (a mid-match player teleported/respawned away). */
  private lastSweep = 0;
  private sweep() {
    const now = this.now();
    if (now - this.lastSweep < 1000) return;
    this.lastSweep = now;
    for (const l of this.live.values()) {
      const m = l.match;
      if (m.phase !== "play" || m.turnStart <= 0) continue;
      const rem = (m.turn === "w" ? m.wMs : m.bMs) - (now - m.turnStart);
      if (rem <= 0) this.finish(l, m.turn === "w" ? "b" : "w", "time");
    }
  }

  private checkDeserted(b: ChessBoard) {
    const l = b.matchId ? this.live.get(b.matchId) : undefined;
    if (!l || l.match.phase === "over") return;
    for (const sid of [l.match.aSid, l.match.bSid]) {
      if (sid === "npc") continue;
      const p = this.state.players.get(sid);
      if (!p || this.tableDist(p.x, p.y, b) > CELL_WU * 3.5) this.resign(l.match.id, sid);
    }
  }
}
