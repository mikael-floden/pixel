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

const SEAT_RADIUS_WU = CELL_WU * 0.95; // stand ON the seat cell (centre within ~a cell)
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
  /** After a match ends at a board, its players must LEAVE the seat before
   * they can re-seat — otherwise closing the dialog instantly re-matches. */
  private cooldown = new Map<string, string>(); // sid -> boardId
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
      this.state.chessBoards.set(c.id, b);
    }
  }

  /** Proximity seating, called at ~4Hz from the sim loop. Cheap by
   * construction: boards are few and this is distance math, no allocation on
   * the quiet path. */
  tick() {
    this.state.chessBoards.forEach((b) => {
      if (b.matchId) { this.checkDeserted(b); return; }
      const atA = this.sidAtSeat(b.seatAc, b.seatAr);
      const atB = b.npc ? "npc" : this.sidAtSeat(b.seatBc, b.seatBr);
      // cooldown: a just-finished player standing on the seat does not count
      const okA = atA && this.cooldown.get(atA) !== b.id ? atA : "";
      const okB = atB === "npc" ? "npc" : atB && this.cooldown.get(atB) !== b.id ? atB : "";
      // release cooldowns for anyone who stepped away
      for (const [sid, bid] of this.cooldown) {
        if (bid !== b.id) continue;
        const p = this.state.players.get(sid);
        if (!p || this.distToSeat(p.x, p.y, b) > SEAT_RADIUS_WU * 1.6) this.cooldown.delete(sid);
      }
      if (okA && okB) return this.startMatch(b, okA, okB);
      const waiting = okA || (okB !== "npc" ? okB : "");
      if (b.waitingSid !== waiting) b.waitingSid = waiting;
    });
    // clock sweep only while something is live
    if (this.live.size) this.sweep();
  }

  private distToSeat(x: number, y: number, b: ChessBoard): number {
    const dA = Math.hypot(x - (b.seatAc + 0.5) * CELL_WU, y - (b.seatAr + 0.5) * CELL_WU);
    const dB = b.npc ? Infinity : Math.hypot(x - (b.seatBc + 0.5) * CELL_WU, y - (b.seatBr + 0.5) * CELL_WU);
    return Math.min(dA, dB);
  }

  private sidAtSeat(c: number, r: number): string {
    let found = "";
    this.state.players.forEach((p, sid) => {
      if (found || p.dead) return;
      if (this.inMatch(sid)) return;
      if (Math.hypot(p.x - (c + 0.5) * CELL_WU, p.y - (r + 0.5) * CELL_WU) <= SEAT_RADIUS_WU) found = sid;
    });
    return found;
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
    // Pre-rolled, never equal: reroll the pair until they differ, so the dice
    // phase cannot draw and white is decided the moment the match exists.
    let a = 0, bb = 0;
    let x = seed || 1;
    const rnd = () => ((x = (x * 48271) % 2147483647) % 6) + 1;
    do { a = rnd(); bb = rnd(); } while (a === bb);
    (l as Live & { rolledA: number; rolledB: number }).rolledA = a;
    (l as Live & { rolledA: number; rolledB: number }).rolledB = bb;
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
    this.cooldown.delete(sid);
  }

  private finish(l: Live, result: string, reason: string) {
    const m = l.match;
    m.phase = "over"; m.result = result; m.reason = reason; m.turnStart = 0;
    l.npcTimer?.clear();
    for (const sid of [m.aSid, m.bSid]) if (sid !== "npc") this.cooldown.set(sid, m.boardId);
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
      if (!p || this.distToSeat(p.x, p.y, b) > CELL_WU * 3) this.resign(l.match.id, sid);
    }
  }
}
