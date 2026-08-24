/**
 * THE CHESS DIALOG — a DOM overlay on the wiki theme (the drop-dialog family:
 * backdrop + card centred in the game view, movement frozen while open).
 * Server-authoritative: this file never decides legality for the record — it
 * uses the SAME shared rules only to highlight and to refuse obviously dead
 * taps, and rebuilds its position by replaying the synced move list, so a
 * missed patch can never desync it.
 *
 * Flow mirrors the schema phases: dice (throw button + tumble animation that
 * lands on the server's pre-rolled value) -> play (board + clocks; the clock
 * display derives from wMs/bMs + turnStart and ticks locally at 4Hz) ->
 * over (won/lost/draw banner; Close tells the server to sweep).
 */
import {
  chessInitial, chessApply, chessParseMove, chessMoves, chessMoveStr, chessInCheck,
  chessPieceCss, pixelArtCss, ChessState, ChessMove,
} from "@nangijala/shared";

export interface ChessMatchView {
  id: string; boardId: string; aSid: string; bSid: string;
  phase: string; diceA: number; diceB: number; whiteSid: string;
  moves: { length: number; forEach(cb: (m: string) => void): void; onAdd?: unknown };
  turn: string; wMs: number; bMs: number; turnStart: number;
  result: string; reason: string;
  onChange?: (cb: () => void) => void;
}

export interface ChessApi {
  mySid: string;
  oppName: string; // "Wendell" on his board, else the other player's name
  send: (type: string, msg: Record<string, unknown>) => void;
  onClosed: () => void; // dialog fully closed (unlock movement)
}

const GLYPH: Record<number, string> = { 1: "♟", 2: "♞", 3: "♝", 4: "♜", 5: "♛", 6: "♚" };
const PIECE_CODE: Record<number, string> = { 1: "p", 2: "n", 3: "b", 4: "r", 5: "q", 6: "k" };
/** The maintainer's own pixel pieces (client/public/chess/, lossless WebP,
 * from his 2026-08-21 upload). alt carries the glyph so a failed load still
 * reads as chess. */
const pieceImg = (p: number) =>
  `<img class="pc-img" draggable="false" alt="${GLYPH[Math.abs(p)]}" src="/chess/${p > 0 ? "w" : "b"}${PIECE_CODE[Math.abs(p)]}.webp">`;
const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

let styled = false;
function ensureStyle() {
  if (styled) return;
  styled = true;
  const st = document.createElement("style");
  st.textContent = `
  .ml-chess-back{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.5);display:flex;align-items:safe center;justify-content:center;padding:8px 0}
  .ml-chess{touch-action:manipulation;-webkit-tap-highlight-color:transparent;user-select:none;background:var(--surface,#fff);color:var(--ink,#1f1e1a);border:1px solid var(--border-strong,#d5d0c2);
    border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.35);width:min(94vw,392px);padding:14px 14px 12px;
    font-family:inherit;display:flex;flex-direction:column;gap:10px}
  .ml-chess h3{margin:0;font-size:17px;display:flex;justify-content:space-between;align-items:center}
  .ml-chess .who{display:flex;justify-content:space-between;align-items:center;font-size:14px}
  .ml-chess .clk{font-variant-numeric:tabular-nums;font-weight:650;padding:2px 10px;border-radius:8px;
    border:1px solid var(--border,#e6e2d7);background:var(--bg,#faf9f5)}
  .ml-chess .clk.hot{background:var(--accent-soft,#f6e3db);border-color:var(--accent,#d97757)}
  .ml-chess .clk.low{background:var(--bad-soft,#f6e1de);border-color:var(--bad,#b3453a);color:var(--bad,#b3453a)}
  .ml-chess-back{overflow:auto}
  .ml-chess-board{display:grid;grid-template-columns:repeat(8,1fr);grid-template-rows:repeat(8,1fr);aspect-ratio:1/1;
    width:min(100%, calc(100dvh - 178px));align-self:center;
    border:1px solid var(--border-strong,#d5d0c2);border-radius:8px;overflow:hidden;user-select:none;touch-action:none}
  .ml-chess-sq{display:flex;align-items:center;justify-content:center;font-size:min(9.2vw,38px);line-height:1;cursor:pointer;position:relative;
    /* EVERY square is exactly 1/8 x 1/8 of the board, whatever it holds. Both
       template axes are 1fr AND min sizes are zeroed: a grid item's implicit
       min-content size otherwise lets a piece img inflate its row — which is
       how the board shipped with UNEQUAL squares that resized on every move
       (maintainer: "unplayable... the board changed size when we moved").
       overflow:hidden makes the cell a hard box, never a suggestion. */
    min-width:0;min-height:0;overflow:hidden}
  .ml-chess-sq.lt{background:#e9dcc3}.ml-chess-sq.dk{background:#b08b62}
  html[data-theme="dark"] .ml-chess-sq.lt{background:#8a7a5f}html[data-theme="dark"] .ml-chess-sq.dk{background:#5c4a38}
  .ml-chess-sq.last{box-shadow:inset 0 0 0 3px var(--star,#d9a13b)}
  .ml-chess-sq.sel{box-shadow:inset 0 0 0 3px var(--accent,#d97757)}
  .ml-chess-sq.chk{box-shadow:inset 0 0 0 3px var(--bad,#b3453a)}
  .ml-chess-sq .dot{position:absolute;width:26%;height:26%;border-radius:50%;background:rgba(30,26,20,.35)}
  html[data-theme="dark"] .ml-chess-sq .dot{background:rgba(250,247,240,.4)}
  .ml-chess-sq .cap{position:absolute;inset:6%;border-radius:50%;border:3px solid rgba(30,26,20,.4)}
  .ml-chess-sq .pc{pointer-events:none}
  /* The art is 32x32. At width:86% of a fractional square it landed on a
     ~1.21x scale, so nearest-neighbour gave some source pixels 2 screen px and
     others 3 — the "fractal" look. --pc is set from JS to a whole multiple of
     32 against an integer square, so every source pixel is the same size. */
  .ml-chess-sq .pc-img{pointer-events:none;width:var(--pc,32px);height:var(--pc,32px);
    image-rendering:pixelated;position:relative;z-index:1}
  .ml-chess-sq.dragging .pc-img{opacity:.28}
  .ml-chess-ghost{position:fixed;z-index:2147483000;pointer-events:none;image-rendering:pixelated;
    transform:translate(-50%,-50%) scale(1.16);filter:drop-shadow(0 5px 7px rgba(0,0,0,.45))}
  .ml-chess-sq .pc.w{color:#f6f1e6;text-shadow:0 0 2px #2c2620,0 1px 1px #2c2620,0 -1px 1px #2c2620,1px 0 1px #2c2620,-1px 0 1px #2c2620}
  .ml-chess-sq .pc.b{color:#332e28;text-shadow:0 0 2px #efe9da,0 1px 1px #efe9da}
  .ml-chess-foot{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .ml-chess button{font:inherit;font-size:14px;font-weight:600;padding:9px 16px;border-radius:9px;cursor:pointer;
    border:1px solid var(--border-strong,#d5d0c2);background:var(--bg,#faf9f5);color:var(--ink,#1f1e1a)}
  .ml-chess button.danger{border-color:var(--bad,#b3453a);color:var(--bad,#b3453a);background:var(--bad-soft,#f6e1de)}
  .ml-chess button.primary{background:var(--accent,#d97757);border-color:var(--accent,#d97757);color:#fff}
  .ml-chess .dicebox{display:flex;flex-direction:column;align-items:center;gap:12px;padding:12px 0 6px}
  .ml-chess .dice-row{display:flex;gap:26px;align-items:center}
  /* SIZE COMES FROM JS (--dieW/--dieStrip/--dieEnd): the 97px frames must land
     on a WHOLE device-pixel scale, which 1:1 CSS is not at dpr 2.75. Every
     length here scales together or the strip tears. */
  .ml-chess .die-hand{width:var(--dieW,97px);height:var(--dieW,97px);
    background:url(/chess/dice_throw_6.webp) 0 0 no-repeat;
    background-size:var(--dieStrip,873px) var(--dieW,97px);
    image-rendering:pixelated;transform-origin:50% 60%;
    transform:scaleY(var(--dieFlip,1))}
  .ml-chess .die-hand.one{background-image:url(/chess/dice_throw_1.webp)}
  /* THE OPPONENT SITS ACROSS THE TABLE (maintainer): his hand comes in from the
     top, so the whole sprite flips vertically and the landed pop grows from the
     mirrored pivot. */
  .ml-chess .die-hand.opp{--dieFlip:-1;transform-origin:50% 40%}
  /* ONE throw, ending on the landed face. It used to loop 'infinite' against a
     1,900ms reveal = 1.58 cycles, so the hand threw, snapped back to the fist
     and threw again half-way before jumping to the result (maintainer: "plays
     twice, looks ugly"). One iteration + forwards holds frame 8 by itself. */
  .ml-chess .die-hand.shaking{animation:mlDiceShake 1.15s steps(8) 1 forwards}
  @keyframes mlDiceShake{to{background-position-x:var(--dieEnd,-776px)}}
  .ml-chess .die-hand.landed{background-position-x:var(--dieEnd,-776px);animation:none;
    transform:scaleY(var(--dieFlip,1)) scale(1.22);transition:transform .18s cubic-bezier(.2,2.2,.4,1)}
  .ml-chess .verdict{text-align:center;padding:8px 0 2px}
  .ml-chess .verdict b{font-size:20px}
  .ml-chess .verdict .why{color:var(--muted,#706b5f);font-size:13px;margin-top:2px}
  .ml-chess .promo{position:absolute;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;gap:8px;z-index:2}
  .ml-chess .promo button{font-size:30px;padding:6px 12px}
  .ml-chess .hint{color:var(--muted,#706b5f);font-size:13px;text-align:center;min-height:17px}
  `;
  document.head.appendChild(st);
}

export class ChessDialog {
  private root?: HTMLElement;
  private m: ChessMatchView;
  private api: ChessApi;
  private st: ChessState = chessInitial();
  private replayed = 0;
  private sel = -1;
  private legal: ChessMove[] = [];
  private tick?: number;
  private promoPending: { from: number; to: number } | null = null;
  private resignArmed = 0;
  private throwRevealAt = 0; // the hand shakes until here, then the face shows
  private oppRevealAt = 0;   // the same, for the hand across the table
  /** Live drag. `on` flips once the pointer clears the slop radius, so a plain
   * tap never spawns a ghost and the old tap-then-tap flow still works. */
  private drag: { sq: number; id: number; x: number; y: number; on: boolean;
                  cell: HTMLElement; ghost?: HTMLElement; lift: number } | null = null;

  constructor(m: ChessMatchView, api: ChessApi) {
    this.m = m; this.api = api;
    ensureStyle();
    this.mount();
    this.render();
    this.tick = window.setInterval(() => this.renderClocks(), 250);
  }

  /** Called by WorldScene whenever the synced match changes. */
  update() { this.render(); }

  get mySide(): "w" | "b" | "" {
    if (!this.m.whiteSid) return "";
    return this.m.whiteSid === this.api.mySid ? "w" : "b";
  }

  private replay() {
    const target: string[] = [];
    this.m.moves.forEach((s) => target.push(s));
    if (target.length < this.replayed) { this.st = chessInitial(); this.replayed = 0; }
    for (let i = this.replayed; i < target.length; i++) {
      const mv = chessParseMove(this.st, target[i]);
      if (mv) this.st = chessApply(this.st, mv);
    }
    this.replayed = target.length;
  }

  private mount() {
    const back = document.createElement("div");
    back.className = "ml-chess-back";
    // THE DROP DIALOG'S LAW (hud.ts, paid for in a maintainer repro):
    // preventDefault the BACKDROP'S OWN events only — NEVER a card event
    // bubbling through, which eats the buttons' clicks. And no
    // stopPropagation at all: Phaser is fended off by uiLock, not by fencing
    // DOM events.
    const swallow = (e: Event) => { if (e.target === back && e.cancelable) e.preventDefault(); };
    back.addEventListener("touchstart", swallow, { passive: false });
    back.addEventListener("pointerdown", swallow);
    const card = document.createElement("div");
    card.className = "ml-chess";
    card.style.position = "relative";
    back.appendChild(card);
    document.body.appendChild(back);
    this.root = back;
  }

  close() {
    if (this.tick) clearInterval(this.tick);
    window.removeEventListener("resize", this.sizeBoard);
    window.removeEventListener("ml-layout", this.sizeBoard);
    window.removeEventListener("resize", this.sizeDice);
    window.removeEventListener("ml-layout", this.sizeDice);
    this.drag?.ghost?.remove(); // a drag interrupted by resign/timeout
    this.drag = null;
    this.root?.remove();
    this.root = undefined;
    this.api.onClosed();
  }

  private card(): HTMLElement { return this.root!.firstElementChild as HTMLElement; }

  // ------------------------------------------------------------ rendering --
  private render() {
    if (!this.root) return;
    this.replay();
    if (this.m.phase === "dice") return this.renderDice();
    // LET THE THROW LAND. Both dice can be in within a second (the NPC throws
    // at ~0.9s), which would swap the panel mid-shake. Hold the dice panel
    // until the reveal plus a beat to read both faces, then build the board.
    // Both hands get their moment — whoever throws LAST sets the linger.
    const lastThrow = Math.max(this.throwRevealAt, this.oppRevealAt);
    if (this.diceBuilt && !this.gameBuilt && Date.now() < lastThrow + 1400) {
      this.renderDice();
      const wait = lastThrow + 1450 - Date.now();
      setTimeout(() => this.render(), Math.max(50, wait));
      return;
    }
    this.renderGame();
  }

  private diceBuilt = false;
  private renderDice() {
    const m = this.m;
    const mine = m.aSid === this.api.mySid ? m.diceA : m.diceB;
    const theirs = m.aSid === this.api.mySid ? m.diceB : m.diceA;
    const c = this.card();
    if (!this.diceBuilt) {
      this.diceBuilt = true;
      c.innerHTML = `
        <h3>Chess <span style="font-size:13px;color:var(--muted)">vs ${this.api.oppName}</span></h3>
        <div class="dicebox">
          <div class="hint">Highest die plays White</div>
          <div class="dice-row">
            <div>
              <div class="die-hand" id="ml-die-hand"></div>
              <div style="text-align:center;font-size:12px;margin-top:4px">You</div>
            </div>
            <div>
              <div class="die-hand opp" id="ml-die-opp"></div>
              <div style="text-align:center;font-size:12px;margin-top:4px">${this.api.oppName}</div>
            </div>
          </div>
          <button class="primary" id="ml-die-throw">Throw the dice</button>
          <div class="hint" id="ml-die-hint"></div>
        </div>`;
      this.sizeDice();
      window.addEventListener("resize", this.sizeDice);
      window.addEventListener("ml-layout", this.sizeDice);
      c.querySelector("#ml-die-throw")!.addEventListener("click", (e) => {
        // Pre-rolled server-side; the maintainer's hand-shake animation (his
        // 2026-08-21 GIF, 9 frames) is honest theater — the value it "lands
        // on" is whatever the server already decided. The reveal is
        // time-gated to ~2 shakes so the animation gets its moment even
        // though the value syncs back within a frame.
        const btn = e.currentTarget as HTMLButtonElement;
        btn.disabled = true;
        (c.querySelector("#ml-die-hand") as HTMLElement).classList.add("shaking");
        (c.querySelector("#ml-die-hand") as HTMLElement).classList.remove("landed");
        this.throwRevealAt = Date.now() + 1150;   // == the single shake's length
        this.api.send("chess.dice", { m: this.m.id });
        setTimeout(() => this.render(), 1200);
      });
    }
    const hand = c.querySelector("#ml-die-hand") as HTMLElement;
    const opEl = c.querySelector("#ml-die-opp") as HTMLElement;
    // The strip is chosen by the pre-rolled value the moment it syncs in —
    // winner's hand throws the 6, loser's the 1 (server canon). Both strips
    // share the same fist frames, so this swap mid-shake is invisible.
    if (mine > 0) hand.classList.toggle("one", mine === 1);
    if (mine > 0 && Date.now() >= this.throwRevealAt && !hand.classList.contains("landed")) {
      // PAUSE ON THE LAST FRAME AND AMPLIFY (maintainer: the player must
      // believe they threw this — the 6/1 IS the reason they got their
      // colour). The landed die stays on screen through the linger.
      hand.classList.remove("shaking");
      hand.classList.add("landed");
      (c.querySelector("#ml-die-throw") as HTMLElement).style.visibility = "hidden";
      (c.querySelector("#ml-die-hint") as HTMLElement).textContent = `Waiting for ${this.api.oppName}…`;
    }
    if (this.m.phase !== "dice" && this.mySide)
      (c.querySelector("#ml-die-hint") as HTMLElement).textContent =
        this.mySide === "w" ? "You play White!" : "You play Black!";
    // HE THROWS TOO. His value only syncs in when he actually throws, so that
    // transition IS his throw: same 1.15s shake, same landed pop, upside down.
    // Until then his hand rests on frame 0 — the fist, waiting.
    if (theirs > 0 && !opEl.dataset.v) {
      opEl.dataset.v = String(theirs);
      opEl.classList.toggle("one", theirs === 1);
      opEl.classList.add("shaking");
      this.oppRevealAt = Date.now() + 1150;
      setTimeout(() => this.render(), 1200);
    }
    if (this.oppRevealAt && Date.now() >= this.oppRevealAt && !opEl.classList.contains("landed")) {
      opEl.classList.remove("shaking");
      opEl.classList.add("landed");
    }
  }

  private gameBuilt = false;
  private cellEls: HTMLElement[] = []; // index = VIEW cell order (row-major from top-left)

  /** Build the PLAY-phase skeleton exactly once. The controls live in fixed
   * nodes for the dialog's whole life: a full innerHTML rebuild here used to
   * run every time the opponent moved, and the hint text's new width shifted
   * the Resign button sideways in the flex row — a tap aimed a moment earlier
   * (a phone thumb, or a gate) landed on empty footer. Squares update their
   * CONTENT in place; nothing that can be tapped ever moves. */
  private buildGame() {
    if (this.gameBuilt) return;
    this.gameBuilt = true;
    this.diceBuilt = false;
    const c = this.card();
    const flip = this.mySide === "b";
    c.innerHTML = `
      <h3>Chess <span style="font-size:13px;color:var(--muted)">${this.mySide === "w" ? "You play White" : "You play Black"}</span></h3>
      <div class="who"><span>${this.api.oppName}</span><span class="clk" id="ml-clk-opp"></span></div>
      <div class="ml-chess-board" id="ml-chess-board"></div>
      <div class="who"><span>You</span><span class="clk" id="ml-clk-me"></span></div>
      <div id="ml-chess-verdict"></div>
      <div class="ml-chess-foot">
        <div class="hint" id="ml-chess-hint"></div>
        <button class="danger" id="ml-chess-resign">Resign</button>
        <button class="primary" id="ml-chess-close" style="display:none">Close</button>
      </div>`;
    const boardEl = c.querySelector("#ml-chess-board") as HTMLElement;
    this.cellEls = [];
    for (let vr = 7; vr >= 0; vr--) for (let vf = 0; vf < 8; vf++) {
      const f = flip ? 7 - vf : vf, r = flip ? 7 - vr : vr;
      const sq = r * 8 + f;
      const cell = document.createElement("div");
      cell.className = `ml-chess-sq ${(f + r) % 2 ? "lt" : "dk"}`;
      cell.dataset.sq = String(sq);
      boardEl.appendChild(cell);
      this.cellEls.push(cell);
    }
    // TAP-TO-MOVE AND DRAG-AND-DROP, one gesture. pointerdown always selects
    // (that IS the tap flow); a drag only begins once the pointer leaves a 6px
    // slop radius, and drops by hit-testing the square under the finger.
    boardEl.addEventListener("pointerdown", (e) => {
      const el = (e.target as HTMLElement).closest("[data-sq]") as HTMLElement | null;
      if (!el) return;
      const sq = Number(el.dataset.sq);
      this.tapSquare(sq);
      if (this.sel !== sq) return; // the tap did not pick up a piece of mine
      this.drag = { sq, id: e.pointerId, x: e.clientX, y: e.clientY, on: false, cell: el,
                    lift: e.pointerType === "touch" ? 30 : 0 };
      try { boardEl.setPointerCapture(e.pointerId); } catch { /* mouse re-entry */ }
    });
    boardEl.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      if (!d.on) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
        const img = d.cell.querySelector("img.pc-img") as HTMLImageElement | null;
        if (!img) { this.drag = null; return; }
        const r = img.getBoundingClientRect();
        const g = img.cloneNode(true) as HTMLElement;
        g.className = "ml-chess-ghost";
        g.style.width = `${r.width}px`;
        g.style.height = `${r.height}px`;
        // On the BODY, not in the card: the squares are overflow:hidden and
        // would clip the piece the moment it left its own cell.
        document.body.appendChild(g);
        d.ghost = g;
        d.on = true;
        d.cell.classList.add("dragging");
      }
      // A touch drag lifts the piece clear of the thumb; a mouse drag centres.
      d.ghost!.style.left = `${e.clientX}px`;
      d.ghost!.style.top = `${e.clientY - d.lift}px`;
      e.preventDefault();
    });
    const endDrag = (e: PointerEvent, drop: boolean) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      d.cell.classList.remove("dragging");
      d.ghost?.remove(); // remove BEFORE hit-testing, or we would hit the ghost
      if (!d.on) return; // a plain tap — pointerdown already did the work
      if (!drop) return;
      const under = document.elementFromPoint(e.clientX, e.clientY - d.lift);
      const cell = under?.closest?.("[data-sq]") as HTMLElement | null;
      if (cell && Number(cell.dataset.sq) !== d.sq) this.tapSquare(Number(cell.dataset.sq));
    };
    boardEl.addEventListener("pointerup", (e) => endDrag(e, true));
    boardEl.addEventListener("pointercancel", (e) => endDrag(e, false));
    c.querySelector("#ml-chess-close")!.addEventListener("click", () => {
      this.api.send("chess.close", { m: this.m.id });
      this.close();
    });
    c.querySelector("#ml-chess-resign")!.addEventListener("click", (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      if (this.m.phase === "over") return;
      if (this.resignArmed > Date.now()) { this.api.send("chess.resign", { m: this.m.id }); this.resignArmed = 0; return; }
      this.resignArmed = Date.now() + 5000;
      btn.textContent = "Really resign?";
      setTimeout(() => { if (this.resignArmed <= Date.now() && btn.isConnected) btn.textContent = "Resign"; }, 5100);
    });
    this.sizeBoard();
    window.addEventListener("resize", this.sizeBoard);
    window.addEventListener("ml-layout", this.sizeBoard); // rotation / handedness
  }

  /** Squares are whole CSS px so the board is exactly 8*sq and all 64 stay
   * identical (verify-chess pins that). The PIECE size comes from shared
   * `chessPieceCss` — whole DEVICE-pixel scaling, reasoned and tested there
   * (server/test/chesssize.test.ts covers dpr 2.75, which no headless run
   * reproduces). */
  private sizeBoard = () => {
    const board = this.root?.querySelector("#ml-chess-board") as HTMLElement | null;
    const parent = board?.parentElement as HTMLElement | null;
    if (!board || !parent) return;
    const avail = Math.min(parent.clientWidth, window.innerHeight - 178);
    const sq = Math.max(24, Math.floor(avail / 8));
    const pc = chessPieceCss(sq, window.devicePixelRatio || 1);
    board.style.width = `${sq * 8}px`;
    board.style.setProperty("--pc", `${pc}px`);
  };

  /** The dice strip is 9 frames of 97x97. Every length has to scale together —
   * the hand, the background-size and the keyframe's landing offset — or the
   * strip tears mid-frame. Size comes from `pixelArtCss` so the frames land on
   * a WHOLE device-pixel scale (1:1 CSS is 2.75x on the maintainer's phone,
   * which is the uneven scaling he caught on the pieces). */
  private sizeDice = () => {
    const box = this.root?.querySelector(".dicebox") as HTMLElement | null;
    if (!box) return;
    // Two hands plus the row gap; the cap keeps it near the art's own 97px on
    // ordinary ratios and only grows where a whole scale demands it.
    const budget = Math.max(48, Math.min(120, Math.floor((box.clientWidth - 26) / 2)));
    const w = pixelArtCss(budget, window.devicePixelRatio || 1, 97);
    const k = w / 97;
    box.style.setProperty("--dieW", `${w}px`);
    box.style.setProperty("--dieStrip", `${873 * k}px`);
    box.style.setProperty("--dieEnd", `${-776 * k}px`);
  };

  private renderGame() {
    this.buildGame();
    const m = this.m;
    const c = this.card();
    // Only the DESTINATION gets the last-move mark (maintainer: highlighting
    // the walked-from square too read as noise).
    const last = (() => {
      let str = "";
      m.moves.forEach((x) => (str = x));
      if (!str) return -1;
      return "abcdefgh".indexOf(str[2]) + (Number(str[3]) - 1) * 8;
    })();
    const myTurn = m.phase === "play" && this.mySide === m.turn;
    const kingSq = (() => {
      if (!chessInCheck(this.st)) return -1;
      for (let i = 0; i < 64; i++) if (this.st.b[i] === 6 * this.st.turn) return i;
      return -1;
    })();
    for (const cell of this.cellEls) {
      const sq = Number(cell.dataset.sq);
      const p = this.st.b[sq];
      const tgt = this.legal.find((mv) => mv.from === this.sel && mv.to === sq);
      const html = (p ? pieceImg(p) : "") + (tgt ? (p ? `<span class="cap"></span>` : `<span class="dot"></span>`) : "");
      if (cell.dataset.html !== html) { cell.innerHTML = html; cell.dataset.html = html; }
      cell.classList.toggle("last", sq === last);
      cell.classList.toggle("sel", sq === this.sel);
      cell.classList.toggle("chk", sq === kingSq);
    }
    const over = m.phase === "over";
    const hint = c.querySelector("#ml-chess-hint") as HTMLElement;
    hint.textContent = over ? "" : myTurn ? "Your move" : `Waiting for ${this.api.oppName}…`;
    const verdict = c.querySelector("#ml-chess-verdict") as HTMLElement;
    if (over && !verdict.hasChildNodes()) {
      const iWon = m.result === this.mySide, draw = m.result === "draw";
      const why: Record<string, string> = {
        checkmate: "by checkmate", resign: "by resignation", time: "on time",
        stalemate: "stalemate", fifty: "fifty-move rule", threefold: "threefold repetition", material: "insufficient material",
      };
      verdict.innerHTML = `<div class="verdict"><b>${draw ? "Draw" : iWon ? "You won! ⚔️" : "You lost"}</b>
        <div class="why">${why[m.reason] ?? m.reason}</div></div>`;
      (c.querySelector("#ml-chess-resign") as HTMLElement).style.display = "none";
      (c.querySelector("#ml-chess-close") as HTMLElement).style.display = "";
    }
    this.renderClocks();
    if (this.promoPending) this.renderPromo();
  }

  private renderClocks() {
    if (!this.root || this.m.phase === "dice") return;
    const m = this.m;
    const burn = (side: string) =>
      m.phase === "play" && m.turnStart > 0 && m.turn === side ? Date.now() - m.turnStart : 0;
    const w = m.wMs - burn("w"), b = m.bMs - burn("b");
    const mine = this.mySide === "b" ? b : w, opp = this.mySide === "b" ? w : b;
    const set = (id: string, ms: number, side: string) => {
      const el = this.root!.querySelector(id) as HTMLElement | null;
      if (!el) return;
      el.textContent = mmss(ms);
      el.classList.toggle("hot", m.phase === "play" && m.turn === side && m.turnStart > 0);
      el.classList.toggle("low", ms < 60_000);
    };
    set("#ml-clk-me", mine, this.mySide || "w");
    set("#ml-clk-opp", opp, this.mySide === "b" ? "w" : "b");
  }

  /** A user (or the gate) taps a square. Selection -> target -> send. */
  tapSquare(sq: number) {
    const m = this.m;
    if (m.phase !== "play" || this.mySide !== m.turn) return;
    const mine = this.st.b[sq] !== 0 && Math.sign(this.st.b[sq]) === (this.mySide === "w" ? 1 : -1);
    const tgt = this.legal.filter((mv) => mv.from === this.sel && mv.to === sq);
    if (tgt.length > 1 && tgt[0].promo !== undefined) { this.promoPending = { from: this.sel, to: sq }; this.render(); return; }
    if (tgt.length === 1) {
      this.api.send("chess.move", { m: m.id, mv: chessMoveStr(tgt[0]) });
      this.sel = -1; this.legal = []; this.render(); return;
    }
    if (mine) { this.sel = sq; this.legal = chessMoves(this.st).filter((mv) => mv.from === sq); }
    else { this.sel = -1; this.legal = []; }
    this.render();
  }

  private renderPromo() {
    const p = this.promoPending!;
    const box = document.createElement("div");
    box.className = "promo";
    for (const [promo, g] of [[5, "♛"], [4, "♜"], [3, "♝"], [2, "♞"]] as const) {
      const b = document.createElement("button");
      b.textContent = g;
      b.addEventListener("click", () => {
        const mv = this.legal.find((x) => x.from === p.from && x.to === p.to && x.promo === promo);
        if (mv) this.api.send("chess.move", { m: this.m.id, mv: chessMoveStr(mv) });
        this.promoPending = null; this.sel = -1; this.legal = [];
        this.render();
      });
      box.appendChild(b);
    }
    this.card().appendChild(box);
  }

  /** QA: current view state. */
  probe() {
    this.replay();
    return {
      phase: this.m.phase, mySide: this.mySide, turn: this.m.turn,
      moves: this.m.moves.length, sel: this.sel, result: this.m.result, reason: this.m.reason,
      armed: this.resignArmed > Date.now(),
      open: !!this.root,
    };
  }
}
