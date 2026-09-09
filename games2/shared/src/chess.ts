/**
 * CHESS — the whole rule set, one implementation for three consumers: the
 * SERVER validates with it (authoritative), the CLIENT highlights legal moves
 * with it, and the NPC thinks with it. One source so they cannot disagree.
 *
 * Board model: mailbox 64, a1=0 .. h8=63 (sq = rank*8+file). Pieces are
 * signed ints (white +, black −): P1 N2 B3 R4 Q5 K6. State is immutable —
 * apply() returns a fresh state — which costs copies but removes the whole
 * class of unmake bugs; measured fast enough (perft(4) from the start
 * position, 197,281 nodes, runs in well under a second in the test).
 *
 * Correctness instrument: PERFT in server/test/chess.test.ts against the
 * published node counts (start position and Kiwipete, whose whole point is
 * castling/en-passant traffic). If a rules edit breaks anything, perft breaks
 * loudly. Do not "fix" perft numbers — they are the ground truth.
 *
 * THE NPC BRAIN (aiMove) is budgeted by NODES, not depth, because the
 * maintainer's constraint is server CPU ("almost 0"): alpha-beta stops the
 * instant the budget is spent and answers with the best completed move.
 * Measured in the test: < 10ms per move at the default budget. Tie-breaks are
 * seeded so a match replays deterministically but different matches differ.
 */

export type ChessState = {
  b: Int8Array;      // 64 squares, signed pieces
  turn: 1 | -1;      // 1 = white to move
  castle: number;    // bits: 1 wK, 2 wQ, 4 bK, 8 bQ
  ep: number;        // en-passant target square, -1 = none
  half: number;      // halfmove clock (50-move rule)
  full: number;      // fullmove number
};

export type ChessMove = {
  from: number; to: number; piece: number;
  capture?: number;        // piece taken (for ep: the pawn, not sq content)
  promo?: number;          // 2..5 (N/B/R/Q), always positive
  ep?: boolean; castle?: boolean; double?: boolean;
};

export const CH_P = 1, CH_N = 2, CH_B = 3, CH_R = 4, CH_Q = 5, CH_K = 6;

const KNIGHT_D = [17, 15, 10, 6, -17, -15, -10, -6];
const KING_D = [8, -8, 1, -1, 9, 7, -9, -7];
const BISHOP_D = [9, 7, -9, -7];
const ROOK_D = [8, -8, 1, -1];

const fileOf = (s: number) => s & 7;
const rankOf = (s: number) => s >> 3;
/** A step is on-board AND didn't wrap a rank edge (file delta ≤ 2 covers
 * every knight/king/slider step used here). */
const stepOk = (from: number, to: number) =>
  to >= 0 && to < 64 && Math.abs(fileOf(from) - fileOf(to)) <= 2;

export function chessInitial(): ChessState {
  const b = new Int8Array(64);
  const back = [CH_R, CH_N, CH_B, CH_Q, CH_K, CH_B, CH_N, CH_R];
  for (let f = 0; f < 8; f++) {
    b[f] = back[f]; b[8 + f] = CH_P;
    b[48 + f] = -CH_P; b[56 + f] = -back[f];
  }
  return { b, turn: 1, castle: 15, ep: -1, half: 0, full: 1 };
}

/** Is `sq` attacked by side `by`? Scans outward from sq — cheaper than
 * generating every enemy move, and it is the hot path of legality. */
export function chessAttacked(st: ChessState, sq: number, by: 1 | -1): boolean {
  const b = st.b;
  for (const d of KNIGHT_D) {
    const t = sq + d;
    if (stepOk(sq, t) && b[t] === CH_N * by) return true;
  }
  for (const d of KING_D) {
    const t = sq + d;
    if (stepOk(sq, t) && b[t] === CH_K * by) return true;
  }
  // Pawn attacks: a white pawn attacks up-board, so a square is attacked by
  // white from one rank BELOW it.
  for (const df of [-1, 1]) {
    const t = sq - 8 * by + df;
    if (t >= 0 && t < 64 && Math.abs(fileOf(sq) - fileOf(t)) === 1 && b[t] === CH_P * by) return true;
  }
  for (const dirs of [BISHOP_D, ROOK_D]) {
    const want = dirs === BISHOP_D ? CH_B : CH_R;
    for (const d of dirs) {
      let cur = sq;
      for (;;) {
        const t = cur + d;
        if (!stepOk(cur, t) || Math.abs(fileOf(cur) - fileOf(t)) > 1) break;
        const p = b[t];
        if (p !== 0) {
          if (p === want * by || p === CH_Q * by) return true;
          break;
        }
        cur = t;
      }
    }
  }
  return false;
}

function kingSq(st: ChessState, side: 1 | -1): number {
  const k = CH_K * side;
  for (let i = 0; i < 64; i++) if (st.b[i] === k) return i;
  return -1; // corrupt state; callers treat as "in check" via attacked(-1)=false paths
}

export function chessInCheck(st: ChessState, side: 1 | -1 = st.turn): boolean {
  const k = kingSq(st, side);
  return k >= 0 && chessAttacked(st, k, -side as 1 | -1);
}

function pseudoMoves(st: ChessState): ChessMove[] {
  const out: ChessMove[] = [];
  const { b, turn } = st;
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (p === 0 || Math.sign(p) !== turn) continue;
    const kind = Math.abs(p);
    if (kind === CH_P) {
      const dir = 8 * turn;
      const startRank = turn === 1 ? 1 : 6;
      const promoRank = turn === 1 ? 7 : 0;
      const one = from + dir;
      if (one >= 0 && one < 64 && b[one] === 0) {
        if (rankOf(one) === promoRank)
          for (const pr of [CH_Q, CH_R, CH_B, CH_N]) out.push({ from, to: one, piece: p, promo: pr });
        else out.push({ from, to: one, piece: p });
        const two = from + 2 * dir;
        if (rankOf(from) === startRank && b[two] === 0)
          out.push({ from, to: two, piece: p, double: true });
      }
      for (const df of [-1, 1]) {
        const to = from + dir + df;
        if (to < 0 || to >= 64 || Math.abs(fileOf(from) - fileOf(to)) !== 1) continue;
        if (b[to] !== 0 && Math.sign(b[to]) === -turn) {
          if (rankOf(to) === promoRank)
            for (const pr of [CH_Q, CH_R, CH_B, CH_N]) out.push({ from, to, piece: p, capture: b[to], promo: pr });
          else out.push({ from, to, piece: p, capture: b[to] });
        } else if (to === st.ep) {
          out.push({ from, to, piece: p, capture: CH_P * -turn as number, ep: true });
        }
      }
      continue;
    }
    if (kind === CH_N) {
      // Knights get their own loop: a legal knight step wraps up to TWO files,
      // which the slider guard below (file delta <= 1 per step) must reject —
      // sharing one loop silently dropped every 2-file knight move, and only
      // perft(3) caught it (the start position's knight moves are all 1-file,
      // so perft(1) and (2) pass with the bug in place).
      for (const d of KNIGHT_D) {
        const to = from + d;
        if (!stepOk(from, to)) continue;
        const q = b[to];
        if (q === 0) out.push({ from, to, piece: p });
        else if (Math.sign(q) === -turn) out.push({ from, to, piece: p, capture: q });
      }
    } else {
      const slide = kind === CH_B || kind === CH_R || kind === CH_Q;
      const dirset = kind === CH_Q ? [...BISHOP_D, ...ROOK_D] : kind === CH_B ? BISHOP_D : kind === CH_R ? ROOK_D : KING_D;
      for (const d of dirset) {
        let cur = from;
        for (;;) {
          const to = cur + d;
          if (!stepOk(cur, to) || Math.abs(fileOf(cur) - fileOf(to)) > 1) break;
          const q = b[to];
          if (q === 0) out.push({ from, to, piece: p });
          else {
            if (Math.sign(q) === -turn) out.push({ from, to, piece: p, capture: q });
            break;
          }
          if (!slide) break;
          cur = to;
        }
      }
    }
    if (kind === CH_K) {
      // Castling: rights + empty lane + king not passing through check.
      const home = turn === 1 ? 4 : 60;
      if (from === home && !chessAttacked(st, home, -turn as 1 | -1)) {
        const kBit = turn === 1 ? 1 : 4, qBit = turn === 1 ? 2 : 8;
        if (st.castle & kBit && b[home + 1] === 0 && b[home + 2] === 0 &&
            b[home + 3] === CH_R * turn &&
            !chessAttacked(st, home + 1, -turn as 1 | -1) && !chessAttacked(st, home + 2, -turn as 1 | -1))
          out.push({ from, to: home + 2, piece: p, castle: true });
        if (st.castle & qBit && b[home - 1] === 0 && b[home - 2] === 0 && b[home - 3] === 0 &&
            b[home - 4] === CH_R * turn &&
            !chessAttacked(st, home - 1, -turn as 1 | -1) && !chessAttacked(st, home - 2, -turn as 1 | -1))
          out.push({ from, to: home - 2, piece: p, castle: true });
      }
    }
  }
  return out;
}

export function chessApply(st: ChessState, mv: ChessMove): ChessState {
  const b = new Int8Array(st.b);
  const turn = st.turn;
  let castle = st.castle, ep = -1, half = st.half + 1;
  b[mv.from] = 0;
  b[mv.to] = mv.promo ? mv.promo * turn : mv.piece;
  if (mv.ep) b[mv.to - 8 * turn] = 0;
  if (mv.capture || Math.abs(mv.piece) === CH_P) half = 0;
  if (mv.double) ep = mv.from + 8 * turn;
  if (mv.castle) {
    const home = turn === 1 ? 4 : 60;
    if (mv.to === home + 2) { b[home + 1] = b[home + 3]; b[home + 3] = 0; }
    else { b[home - 1] = b[home - 4]; b[home - 4] = 0; }
  }
  // Rights die when king or rook moves, or a rook is captured on its square.
  const clr = (sq: number, bit: number) => { if (mv.from === sq || mv.to === sq) castle &= ~bit; };
  if (Math.abs(mv.piece) === CH_K) castle &= turn === 1 ? ~3 : ~12;
  clr(7, 1); clr(0, 2); clr(63, 4); clr(56, 8);
  return { b, turn: -turn as 1 | -1, castle, ep, half, full: st.full + (turn === -1 ? 1 : 0) };
}

/** Fully legal moves: pseudo moves whose result leaves own king safe. */
export function chessMoves(st: ChessState): ChessMove[] {
  return pseudoMoves(st).filter((m) => !chessInCheck(chessApply(st, m), st.turn));
}

/** Position key for threefold repetition (board + turn + castle + ep). */
export function chessKey(st: ChessState): string {
  let s = st.turn === 1 ? "w" : "b";
  s += st.castle.toString(16) + (st.ep >= 0 ? st.ep : "-");
  for (let i = 0; i < 64; i++) s += String.fromCharCode(78 + st.b[i]);
  return s;
}

export type ChessOutcome =
  | { over: false; check: boolean }
  | { over: true; winner: 1 | -1 | 0; reason: "checkmate" | "stalemate" | "fifty" | "threefold" | "material" };

export function chessOutcome(st: ChessState, repCount: number): ChessOutcome {
  if (chessMoves(st).length === 0) {
    if (chessInCheck(st)) return { over: true, winner: -st.turn as 1 | -1, reason: "checkmate" };
    return { over: true, winner: 0, reason: "stalemate" };
  }
  if (st.half >= 100) return { over: true, winner: 0, reason: "fifty" };
  if (repCount >= 3) return { over: true, winner: 0, reason: "threefold" };
  // Insufficient material: K vs K, K+minor vs K (bare-bones on purpose).
  let minors = 0, other = 0;
  for (let i = 0; i < 64; i++) {
    const k = Math.abs(st.b[i]);
    if (k === 0 || k === CH_K) continue;
    if (k === CH_N || k === CH_B) minors++; else other++;
  }
  if (other === 0 && minors <= 1) return { over: true, winner: 0, reason: "material" };
  return { over: false, check: chessInCheck(st) };
}

const FILES = "abcdefgh";
export const chessSqName = (s: number) => FILES[fileOf(s)] + (rankOf(s) + 1);
export function chessMoveStr(m: ChessMove): string {
  return chessSqName(m.from) + chessSqName(m.to) + (m.promo ? "nbrq"[m.promo - 2] : "");
}
export function chessParseMove(st: ChessState, s: string): ChessMove | null {
  return chessMoves(st).find((m) => chessMoveStr(m) === s) ?? null;
}

export function chessPerft(st: ChessState, depth: number): number {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of chessMoves(st)) n += chessPerft(chessApply(st, m), depth - 1);
  return n;
}

// ---------------------------------------------------------------- the NPC ---
const VAL = [0, 100, 300, 310, 500, 900, 0];
/** Centre pull for minor pieces and pawns — enough to not shuffle rook pawns. */
function centre(sq: number): number {
  const f = fileOf(sq), r = rankOf(sq);
  return 6 - (Math.abs(2 * f - 7) + Math.abs(2 * r - 7)) / 2;
}
function evalOf(st: ChessState): number {
  // From the perspective of the side to move (negamax convention).
  let sc = 0;
  for (let i = 0; i < 64; i++) {
    const p = st.b[i];
    if (p === 0) continue;
    const k = Math.abs(p);
    let v = VAL[k];
    if (k === CH_P || k === CH_N || k === CH_B) v += centre(i);
    sc += p > 0 ? v : -v;
  }
  return st.turn === 1 ? sc : -sc;
}
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Budgeted negamax. `nodes` is a HARD cap — when it runs out mid-branch the
 * search returns what it has, so worst-case cost is bounded regardless of
 * position. Depth 3 within the default budget plays "somewhat ok": it takes
 * hanging pieces, avoids simple one-move blunders, and pushes toward the
 * centre — exactly the maintainer's bar, at well under 10ms.
 */
export function chessAiMove(st: ChessState, opts?: { nodes?: number; seed?: number; depth?: number }): ChessMove | null {
  const budget = { n: opts?.nodes ?? 2500 };
  const rnd = mulberry(opts?.seed ?? 1);
  const maxDepth = opts?.depth ?? 3;
  const moves = chessMoves(st);
  if (moves.length === 0) return null;
  // Captures first — makes the pruning bite and the budget go further.
  const jitter = new Map(moves.map((m) => [m, rnd()]));
  moves.sort((a, b) => (VAL[Math.abs(b.capture ?? 0)] - VAL[Math.abs(a.capture ?? 0)]) || (jitter.get(a)! - jitter.get(b)!));
  const negamax = (s: ChessState, depth: number, alpha: number, beta: number): number => {
    if (budget.n-- <= 0 || depth === 0) return evalOf(s);
    // PSEUDO moves inside the tree — the legality filter is what made a node
    // cost 30 state copies. A move that captures the king scores as mate,
    // which prunes illegal lines the classic way; only the ROOT is strictly
    // legal, so the move the NPC actually plays is always valid. Measured:
    // 29ms/move -> ~3ms at the same budget.
    const ms = pseudoMoves(s);
    if (ms.length === 0) return chessInCheck(s) ? -100000 - depth : 0;
    for (const m of ms) if (Math.abs(m.capture ?? 0) === CH_K) return 100000 + depth;
    ms.sort((a, b) => VAL[Math.abs(b.capture ?? 0)] - VAL[Math.abs(a.capture ?? 0)]);
    let best = -Infinity;
    for (const m of ms) {
      const v = -negamax(chessApply(s, m), depth - 1, -beta, -alpha);
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  };
  let best = moves[0], bestV = -Infinity;
  for (const m of moves) {
    if (budget.n <= 0) break;
    const v = -negamax(chessApply(st, m), maxDepth - 1, -Infinity, Infinity);
    if (v > bestV) { bestV = v; best = m; }
  }
  return best;
}

/**
 * Chess board sizing, kept pure so it can be tested at device ratios no
 * headless browser will reproduce.
 *
 * The pieces are 32x32 pixel art and `image-rendering:pixelated` resolves in
 * DEVICE pixels, so the number that must come out WHOLE is `css * dpr / 32`.
 * A whole CSS size is not enough: at dpr 2.75 a 32px CSS piece is 88 device px
 * = 2.75x, which gives some source pixels 3 device px and their neighbours 2 —
 * the uneven "fractal" scaling. Pick the integer device scale that fits, then
 * work back to a (possibly fractional) CSS size.
 *
 * `sq` is the square's whole-CSS-px size; a board too small for even 1x fills
 * the square rather than clipping the art.
 */
export function chessPieceCss(sq: number, dpr: number, art = 32): number {
  const k = Math.max(1, Math.floor((sq * 0.92 * dpr) / art));
  return Math.min(sq, (k * art) / dpr);
}

/**
 * The same rule for any pixel-art element given a CSS size budget: the largest
 * size within `budget` that renders `art` source px at a WHOLE device-pixel
 * scale (falling back to the budget when not even 1x fits). Used for the dice
 * hand, whose 97px frames had exactly the piece bug — 1:1 in CSS is 2.75x in
 * device pixels on the maintainer's phone.
 */
export function pixelArtCss(budget: number, dpr: number, art: number): number {
  const k = Math.max(1, Math.floor((budget * dpr) / art));
  return Math.min(budget, (k * art) / dpr);
}
