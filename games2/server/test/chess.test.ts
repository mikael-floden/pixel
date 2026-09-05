// The chess rules gate. PERFT numbers are published ground truth — the start
// position and Kiwipete (a position built to stress castling + en passant).
// If a rules edit changes any of them, the rules are wrong, not the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

// ============================================================================
// A PLACED TABLE IS A PLAYABLE BOARD
// ============================================================================
//
// The maps agent places the furniture; `config/chess_boards.json` is what makes
// it playable. Nothing connects the two, so a world can ship chess tables — and
// a resident opponent standing at one — while the game has no idea they exist.
// That is exactly what happened: the_game shipped two `chess_tables/*` pieces
// and a Rannulf carrying `anchor: "chess"`, became the DEFAULT map on
// 2026-09-02, and had no entry here at all, so chess quietly left the game the
// day the map changed under it. Nothing was removed; the config simply never
// followed the world (maintainer: "I feel like I can't play chess in the game
// any more.. Have you removed that feature?").
//
// So the gate is stated from the WORLD's side, not the config's: every chess
// table a shipped world places must have a board within reach of it. A future
// world gets this for free the moment the maps agent puts a table down.
//
// SKIPPED, NOT FAILED, when the world tree is absent — the deploy's test job
// sparse-checks-out a subset.
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const REPO = join(HERE, "..", "..", "..");
  const CFG = join(REPO, "games2", "config", "chess_boards.json");
  const publish = join(REPO, "games2", "config", "publish.json");
  const worldDoc = (w: string) => {
    for (const root of ["worlds", "worlds3"]) {
      const p = join(REPO, "maps2", root, w, "world.json");
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
    }
    return null;
  };
  const have = existsSync(CFG) && existsSync(publish);
  test("every chess table a world places is a board you can sit at", { skip: !have }, () => {
    const cfg = JSON.parse(readFileSync(CFG, "utf8"));
    const worlds: string[] = JSON.parse(readFileSync(publish, "utf8")).userWorlds ?? [];
    let tables = 0;
    const orphans: string[] = [];
    for (const w of worlds) {
      const doc = worldDoc(w);
      if (!doc) continue;
      /* A maps3 world places the table as SCENERY (a piece id); a tiles2 world
       * as a PROP, which carries NO type string at all — only `{x, y, tile}`,
       * an INDEX into the world's own `paths[]`. Resolving that index is the
       * only way to see the_island2's two tables; matching on a `type` field
       * finds nothing and leaves the older world silently uncovered. */
      const paths: string[] = doc.paths ?? [];
      const placed: { x: number; y: number }[] = [
        ...((doc.scenery ?? []) as any[]).filter((p) => String(p.piece).includes("chess")),
        ...((doc.props ?? []) as any[]).filter((p) =>
          String(paths[p.tile] ?? "").toLowerCase().includes("chess"),
        ),
      ];
      const boards: any[] = cfg.worlds?.[w] ?? [];
      for (const t of placed) {
        tables++;
        // THE SAME 1.75-CELL RADIUS THE SERVER SEATS BY (chess.ts TABLE_RADIUS_WU),
        // measured from the board cell's CENTRE to the table's anchor — so a
        // board that names the wrong cell fails this too, not just a missing one.
        const near = boards.some(
          (b) => Math.hypot(b.col + 0.5 - (t.x + 0.5), b.row + 0.5 - (t.y + 0.5)) <= 1.75,
        );
        if (!near) orphans.push(`${w} (${t.x.toFixed(1)}, ${t.y.toFixed(1)})`);
      }
    }
    assert.deepEqual(orphans, [], "chess tables standing in a published world with no board to sit at");
    // NON-VACUOUS: if no shipped world places a table, this gate proves nothing
    // and should be deleted rather than left passing.
    assert.ok(tables > 0, "no published world places a chess table — this gate is vacuous");
    console.log(`chess: ${tables} placed tables across ${worlds.length} published worlds, all playable`);
  });
}
