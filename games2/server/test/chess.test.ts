// The chess rules gate. PERFT numbers are published ground truth — the start
// position and Kiwipete (a position built to stress castling + en passant).
// If a rules edit changes any of them, the rules are wrong, not the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chessInitial, chessMoves, chessApply, chessPerft, chessOutcome, chessKey,
  chessAiMove, chessParseMove, chessMoveStr, ChessState, CH_P, CH_N, CH_B, CH_R, CH_Q, CH_K,
} from "@nangijala/shared";

function fromFen(fen: string): ChessState {
  const [board, turn, castle, ep] = fen.split(" ");
  const b = new Int8Array(64);
  const rows = board.split("/");
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[7 - r]) {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      const side = ch === ch.toUpperCase() ? 1 : -1;
      const k = { p: CH_P, n: CH_N, b: CH_B, r: CH_R, q: CH_Q, k: CH_K }[ch.toLowerCase() as "p"]!;
      b[r * 8 + f] = k * side; f++;
    }
  }
  let c = 0;
  if (castle.includes("K")) c |= 1; if (castle.includes("Q")) c |= 2;
  if (castle.includes("k")) c |= 4; if (castle.includes("q")) c |= 8;
  const epSq = ep === "-" ? -1 : "abcdefgh".indexOf(ep[0]) + (Number(ep[1]) - 1) * 8;
  return { b, turn: turn === "w" ? 1 : -1, castle: c, ep: epSq, half: 0, full: 1 };
}

test("perft: start position matches published node counts", () => {
  const s = chessInitial();
  assert.equal(chessPerft(s, 1), 20);
  assert.equal(chessPerft(s, 2), 400);
  assert.equal(chessPerft(s, 3), 8902);
  assert.equal(chessPerft(s, 4), 197281);
});

test("perft: Kiwipete (castling + en passant stress) matches", () => {
  const s = fromFen("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -");
  assert.equal(chessPerft(s, 1), 48);
  assert.equal(chessPerft(s, 2), 2039);
  assert.equal(chessPerft(s, 3), 97862);
});

test("fool's mate is checkmate", () => {
  let s = chessInitial();
  for (const m of ["f2f3", "e7e5", "g2g4", "d8h4"]) s = chessApply(s, chessParseMove(s, m)!);
  const o = chessOutcome(s, 1);
  assert.ok(o.over && o.reason === "checkmate" && o.winner === -1);
});

test("stalemate is a draw", () => {
  const s = fromFen("7k/5Q2/6K1/8/8/8/8/8 b - -");
  const o = chessOutcome(s, 1);
  assert.ok(o.over && o.reason === "stalemate" && o.winner === 0);
});

test("promotion produces four options and a queen mates", () => {
  const s = fromFen("8/P6k/8/8/8/8/8/K7 w - -");
  const promos = chessMoves(s).filter((m) => m.promo);
  assert.equal(promos.length, 4);
  const q = chessParseMove(s, "a7a8q")!;
  assert.ok(q, "a7a8q is legal");
  assert.equal(Math.abs(chessApply(s, q).b[56]), CH_Q);
});

test("castling through check is refused, castling out of the lane is fine", () => {
  // Black rook on f8-file... rook on f3 attacks f1: white may NOT castle kingside.
  const s = fromFen("4k3/8/8/8/8/5r2/8/R3K2R w KQ -");
  const strs = chessMoves(s).map(chessMoveStr);
  assert.ok(!strs.includes("e1g1"), "kingside through an attacked f1 refused");
  assert.ok(strs.includes("e1c1"), "queenside still available");
});

test("en passant is generated and removes the passed pawn", () => {
  let s = chessInitial();
  for (const m of ["e2e4", "a7a6", "e4e5", "d7d5"]) s = chessApply(s, chessParseMove(s, m)!);
  const ep = chessParseMove(s, "e5d6");
  assert.ok(ep && ep.ep, "e5xd6 en passant exists");
  const after = chessApply(s, ep!);
  assert.equal(after.b[35], 0, "the passed pawn on d5 is gone");
});

test("threefold and insufficient material end the game", () => {
  const bare = fromFen("4k3/8/8/8/8/8/8/4KN2 w - -");
  const o = chessOutcome(bare, 1);
  assert.ok(o.over && o.reason === "material");
  const s = chessInitial();
  assert.ok(chessOutcome(s, 3).over && (chessOutcome(s, 3) as { reason: string }).reason === "threefold");
  assert.equal(chessKey(s), chessKey(chessInitial()), "key is deterministic");
});

test("the NPC brain: always legal, deterministic per seed, and CHEAP", () => {
  let s = chessInitial();
  const t0 = performance.now();
  let plies = 0;
  for (; plies < 40; plies++) {
    const m = chessAiMove(s, { seed: 42 + plies });
    if (!m) break;
    assert.ok(chessMoves(s).some((x) => chessMoveStr(x) === chessMoveStr(m)), "AI move is legal");
    s = chessApply(s, m);
    if (chessOutcome(s, 1).over) break;
  }
  const per = (performance.now() - t0) / Math.max(1, plies);
  assert.ok(per < 25, `NPC move must stay cheap (measured ${per.toFixed(1)}ms/move)`);
  const a = chessAiMove(chessInitial(), { seed: 7 })!;
  const b = chessAiMove(chessInitial(), { seed: 7 })!;
  assert.equal(chessMoveStr(a), chessMoveStr(b), "same seed, same move");
});
