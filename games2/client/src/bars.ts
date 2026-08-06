/**
 * HP / Energy / XP bars + LEVEL + Gold — HP + Energy top-LEFT, Experience
 * (with "LEVEL n" on its number line) + Gold top-RIGHT, floating over the
 * game view.
 *
 * WIKI-STYLE (maintainer 2026-07-30): the UI-kit bar art (bar-frame/fill
 * 9-slices) is gone. Each group sits in a translucent rounded CHIP (the
 * page theme's --bg at ~75%, blurred) so the text and tracks stay readable
 * over any world art, in light and dark theme alike; the gauges are slim
 * rounded tracks (surface-2 well + coloured fill). The gold nugget icon
 * (the maintainer's PixelLab art) STAYS — "not the icons".
 *
 * Gauge colours keep their meanings: HP red (--bad), Energy gold (--star),
 * XP blue (fixed #5f87c0 — the tokens carry no blue; it reads on both
 * themes). data-color hp=red / ep=yellow / xp=blue survives for the QA gate.
 *
 * The bars show STATIC placeholder values for now (HP 10/10 full, Energy 0/0
 * empty, XP 0/10 empty, gold 0, level 1); setBar(kind, cur, max) / setGold(n)
 * / setLevel(n) are the seams the real player state plugs into later.
 *
 * LEVELLING UP plays here too — see playLevelUp() at the bottom.
 */

import { withV } from "./assetver";

type Kind = "hp" | "ep" | "xp";
interface Bar {
  fill: HTMLElement;
  num: HTMLElement;
  cur: number;
  max: number;
  suffix: string;
}

let root: HTMLDivElement | null = null; // left chip: HP + Energy
let rootR: HTMLDivElement | null = null; // right chip: Experience + Gold
const bars: Record<Kind, Bar> = {} as any;
let goldNumEl: HTMLElement | null = null; // the gold amount label
let gold = 0; // how much gold the player has (0 until real state is wired)
let levelEl: HTMLElement | null = null; // the "LEVEL n" label on the XP row
let level = 1; // player level (1 until real state is wired)

export function mountBars() {
  if (root) return;
  injectStyles();
  // Anchored to the GAME VIEW's top corners via the --gv-left/--gv-right
  // insets (hud.ts applyLayout): in portrait those are 0 and this is the
  // screen's own corners, exactly as before; in landscape the game view
  // shares the screen with the menu column, and the chips stay on the
  // WORLD's corners instead of floating over the menu. The left/right
  // transition makes the re-anchor glide (orientation + handedness swaps).
  root = document.createElement("div");
  root.className = "ml-bars ml-bars-l";
  rootR = document.createElement("div");
  rootR.className = "ml-bars ml-bars-r";

  const make = (container: HTMLElement, colour: string, max: number, suffix: string): Bar => {
    const row = document.createElement("div");
    row.className = "ml-bar-row";
    const gauge = document.createElement("div");
    gauge.className = "ml-bar-gauge";
    const fill = document.createElement("div");
    fill.className = "ml-bar-fill";
    fill.dataset.color = colour; // HP=red / EP=yellow / XP=blue (gate checks this)
    gauge.append(fill);
    const num = document.createElement("span");
    num.className = "ml-bar-num";
    row.append(gauge, num);
    container.appendChild(row);
    return { fill, num, cur: 0, max, suffix };
  };
  bars.hp = make(root, "red", 10, "HP");
  bars.ep = make(root, "yellow", 0, "EP");
  bars.xp = make(rootR, "blue", 10, "XP");

  // "LEVEL n" on the XP row's number line, LEFT-aligned opposite the
  // right-aligned XP count (maintainer 2026-07-25). Binds to the real player
  // level via setLevel().
  const xpRow = bars.xp.num.parentElement!;
  const numRow = document.createElement("div");
  numRow.className = "ml-bar-numrow";
  levelEl = document.createElement("span");
  levelEl.className = "ml-bar-level";
  xpRow.replaceChild(numRow, bars.xp.num);
  numRow.append(levelEl, bars.xp.num);

  // Gold under the Experience row (maintainer 2026-07-24): the nugget icon at
  // the RIGHT, the amount right-aligned just to its left.
  const goldRow = document.createElement("div");
  goldRow.className = "ml-gold-row";
  goldNumEl = document.createElement("span");
  goldNumEl.className = "ml-gold-num";
  const goldIcon = document.createElement("img");
  goldIcon.className = "ml-gold-icon";
  goldIcon.src = withV("/ui2/gold-icon.webp");
  goldIcon.alt = "";
  goldIcon.draggable = false;
  goldRow.append(goldNumEl, goldIcon); // amount left, icon right (both flush right)
  rootR.appendChild(goldRow);

  document.body.append(root, rootR);
  // Publish BOTH chips' heights: the time-of-day pill parks directly under
  // the RIGHT one in right-handed landscape (clock.ts reads --bars-r-h), and
  // the update banner — centred, so it can pass under EITHER — clears the
  // TALLER of the two (main.ts). Measured, not assumed: a chip's height moves
  // with the theme's font metrics, the gold row and the >=700px row tier, and
  // the left chip (two stat rows) is normally the taller.
  if ("ResizeObserver" in window) {
    const publish = (el: HTMLElement, name: string) =>
      new ResizeObserver(() =>
        document.documentElement.style.setProperty(
          name,
          `${Math.round(el.getBoundingClientRect().height)}px`,
        ),
      ).observe(el);
    publish(rootR, "--bars-r-h");
    publish(root, "--bars-l-h");
  }
  renderGold();
  renderLevel();
  mountProbe();

  // Static placeholder values (maintainer 2026-07-23: HP 10/10 full, Energy
  // 0/0 empty, XP 0/10 empty; no animation). setBar() replaces these once
  // real state is wired.
  apply("hp", 1); // 10 / 10 — full
  apply("ep", 0); // 0 / 0  — empty
  apply("xp", 0); // 0 / 10 — empty
}

function apply(kind: Kind, pct: number, cur = Math.round(pct * bars[kind].max)) {
  const b = bars[kind];
  b.cur = cur;
  if (kind === "xp") xpShownPct = pct;
  b.fill.style.width = `${(pct * 100).toFixed(2)}%`;
  b.num.textContent = `${cur} / ${b.max} ${b.suffix}`;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const pctOf = (cur: number, max: number) => (max > 0 ? clamp01(cur / max) : 0);

/** The seam the real player state plugs into. */
export function setBar(kind: Kind, cur: number, max: number) {
  if (!root) return;
  const b = bars[kind];
  if (kind === "xp") {
    // Remember where the gauge WAS. A level-up reaches us as the setLevel()
    // that follows this call in the SAME synchronous block (WorldScene pushes
    // the bars then the level), and by then `max` is already the new level's
    // requirement and `cur` the carry-over — the frame the animation has to
    // start from is gone. Nothing has painted in between, so replaying from
    // here is invisible.
    xpPrevPct = xpShownPct;
    xpPrevMax = b.max;
  }
  b.max = max;
  b.cur = cur;
  // A level-up animation OWNS the gauge until it ends; it drains onto
  // whatever the latest sync says, so a kill mid-animation still lands right.
  if (kind === "xp" && luPlaying) return;
  apply(kind, pctOf(cur, max), cur);
}

function renderGold() {
  if (goldNumEl) goldNumEl.textContent = gold.toLocaleString("en-US");
}

/** The seam the real player gold plugs into (0 until wired to server state). */
export function setGold(n: number) {
  gold = Math.max(0, Math.round(n) || 0);
  renderGold();
}

function renderLevel() {
  // While a level-up is in flight the label deliberately still reads the OLD
  // number — it changes ON the impact frame, with the stamp.
  if (levelEl && !luLabelHeld) levelEl.textContent = `LEVEL ${level}`;
}

/** The seam the real player level plugs into (1 until wired to server state). */
export function setLevel(n: number) {
  const next = Math.max(1, Math.round(n) || 1);
  // The FIRST push is the join sync — a returning level-9 player arrives at 9
  // and has not just levelled up.
  const gained = levelKnown && next > level;
  level = next;
  levelKnown = true;
  if (gained && startLevelUp()) return; // the new number lands with the stamp
  renderLevel();
}

/* ── LEVEL UP — "Thunderclap" ─────────────────────────────────────────────
 *
 * Chosen by the maintainer from a page of eleven alternatives and then tuned
 * on it over two rounds ("the level up graphics is perfect! I love it!",
 * 2026-08-06). Three effects — a light sweeping the track, a shockwave ring
 * thrown off the chip, and the LEVEL number stamping down — that all peak on
 * ONE frame: "I want the punch from each effect at the same time/frame."
 *
 * The shape, and why each piece is the way it is (all three were bugs first):
 *
 *  1. The gauge RUNS TO FULL on the level you just finished. The server never
 *     sends that frame — it sends the carry-over — so it is synthesised from
 *     the fraction the gauge held before the sync (see setBar).
 *  2. The light is PRE-ROLLED so its brightest moment lands ON the impact
 *     instead of after it, and the impact fires off the sweep's OWN clock:
 *     a setTimeout lands a frame or two late, which reads as "the number is
 *     behind the light". MID-TRACK IS NOT MID-ANIMATION — the bloom is the
 *     gradient's centre, and a band 60% of the track wide travelling
 *     -70%..230% of its own width puts that centre over the middle at
 *     (50+12)/180 = 34.4% of the sweep, not 50%.
 *  3. THE IMPACT FRAME: every punch is at offset 0 of its own animation, so
 *     all three extremes are this one frame and each decays from here. The
 *     plate's pulse and knock are ONE animation — as two animations on the
 *     same element the later silently cancels the earlier, which is what made
 *     the stamp feel like a separate, later event.
 *
 * Then a beat, and the bar drains to the new level's carry-over — numbers
 * first (that is what the server sent), width after.
 *
 * It plays entirely off setLevel(), so the scene needs no wiring: the level
 * going up IS the event. Honours prefers-reduced-motion (nothing moves, the
 * values just land) and makes no sound — sounds are the audio agent's, and
 * only when the maintainer asks for one.
 */

const LU = {
  fill: 520, // the gauge runs to full
  sweep: 220, // the light crosses the track (linear — see MID)
  sweepMid: 0.344, // where the bloom is over mid-track (fraction of the sweep)
  ring: 460, // the shockwave
  bright: 280, // the fill's own flash
  recoil: 300, // the chip's pulse + knock
  stamp: 420, // the LEVEL number
  hold: 220, // the beat before the drain
  drain: 320,
  watchdog: 6000, // a backgrounded tab freezes rAF — never hold the gauge forever
};
const RING_R0 = 18; // the ring starts just inside the chip…
const RING_GROW = 86; // …and reaches this much further
const RING_PAD = 112; // canvas margin: RING_R0 + RING_GROW + the line width

let levelKnown = false; // has a real level landed yet? (join vs. level-up)
let xpShownPct = 0; // the fraction currently PAINTED on the gauge
let xpPrevPct = 0; // …and the one before the newest setBar("xp")
let xpPrevMax = 10; // the XP the level we were on required
let luPlaying = false;
let luLabelHeld = false; // the LEVEL label is frozen on the old number
let luRun = 0; // generation token: a newer level-up supersedes an older
let luRuns = 0; // QA: how many have played
let luWatch = 0 as unknown as ReturnType<typeof setTimeout>;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tween(ms: number, tok: number, fn: (t: number) => void, easing = easeOut) {
  return new Promise<void>((done) => {
    const t0 = performance.now();
    const step = () => {
      if (tok !== luRun) return done(); // superseded — stop painting
      const t = Math.min(1, (performance.now() - t0) / ms);
      fn(easing(t));
      if (t < 1) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  });
}

/** Paint the XP gauge directly — the animation owns it while it runs. */
function paintXp(pct: number, cur: number, max: number) {
  xpShownPct = pct;
  bars.xp.fill.style.width = `${(pct * 100).toFixed(2)}%`;
  bars.xp.num.textContent = `${cur} / ${max} ${bars.xp.suffix}`;
}

/** Hand the gauge and the label back to the synced state. */
function endLevelUp(tok: number) {
  if (tok !== luRun) return;
  clearTimeout(luWatch);
  luPlaying = false;
  luLabelHeld = false;
  renderLevel();
  apply("xp", pctOf(bars.xp.cur, bars.xp.max), bars.xp.cur);
}

/** @returns false when it declines, so the caller renders the plain way. */
function startLevelUp(): boolean {
  if (!rootR || !levelEl || reducedMotion()) return false;
  const from = luPlaying ? xpShownPct : xpPrevPct;
  const fromMax = xpPrevMax;
  clearTimeout(luWatch);
  const tok = ++luRun;
  luPlaying = true;
  luLabelHeld = true;
  luRuns++;
  // Paint the starting frame NOW: setBar already wrote the carry-over into the
  // gauge this same tick, and the first tween frame is a whole rAF away.
  paintXp(from, Math.round(from * fromMax), fromMax);
  luWatch = setTimeout(() => endLevelUp(tok), LU.watchdog);
  void playLevelUp(tok, from, fromMax);
  return true;
}

async function playLevelUp(tok: number, from: number, fromMax: number) {
  const chip = rootR!;
  const fillEl = bars.xp.fill;
  const gauge = fillEl.parentElement!;

  // 1 ── the gauge runs to full, the XP line counting up with it
  await tween(LU.fill, tok, (t) => {
    const p = from + (1 - from) * t;
    paintXp(p, Math.round(p * fromMax), fromMax);
  });
  if (tok !== luRun) return;

  // 2 ── the light, pre-rolled so its bloom lands on the impact
  const flash = document.createElement("div");
  flash.className = "ml-lvup-flash";
  gauge.appendChild(flash);
  const sweep = flash.animate(
    [{ transform: "translateX(-70%)" }, { transform: "translateX(230%)" }],
    { duration: LU.sweep, easing: "linear" },
  );
  // Cleanup AT CREATION: an animation with no fill mode snaps its element back
  // to the base state on finish, and a removal attached after the next await
  // left the bloom parked across the track (the maintainer screenshotted it).
  const drop = () => flash.remove();
  sweep.finished.then(drop, drop);

  const MID = LU.sweep * LU.sweepMid;
  await new Promise<void>((go) => {
    const t0 = performance.now();
    const at = () => {
      // Wall-clock bail: a throttled tab can park the sweep's own clock.
      if (tok !== luRun || Number(sweep.currentTime ?? 0) >= MID || performance.now() - t0 > LU.sweep) go();
      else requestAnimationFrame(at);
    };
    requestAnimationFrame(at);
  });
  if (tok !== luRun) return;

  // 3 ── THE IMPACT FRAME. Every punch below is at offset 0 of its own
  //      animation, so all of them peak here and decay from here.
  ring(tok); // measured before the recoil starts, so it centres on the chip's rest position
  fillEl.animate([{ filter: "brightness(1.95)" }, { filter: "brightness(1)" }], {
    duration: LU.bright,
    easing: "ease-out",
  });
  chip.animate(
    [
      { transform: "scale(1.055) translate(-2px, 1px)", offset: 0 },
      { transform: "scale(1.02) translate(1.5px, -1px)", offset: 0.34 },
      { transform: "scale(1) translate(0, 0)", offset: 1 },
    ],
    { duration: LU.recoil, easing: "ease-out" },
  );
  luLabelHeld = false;
  renderLevel(); // the number changes ON the impact, never before it
  levelEl!.animate(
    [
      { transform: "scale(2)", color: "var(--ink)", offset: 0 },
      { transform: "scale(.94)", color: "var(--ink)", offset: 0.45 },
      { transform: "scale(1)", color: "var(--muted)", offset: 1 },
    ],
    { duration: LU.stamp, easing: "cubic-bezier(.2,.9,.3,1)" },
  );

  // 4 ── a beat, then the drain: the new level's numbers land FIRST (that is
  //      what the server sent) and the bar travels to where they say it is.
  await wait(LU.hold);
  if (tok !== luRun) return;
  const b = bars.xp;
  const to = pctOf(b.cur, b.max);
  b.num.textContent = `${b.cur} / ${b.max} ${b.suffix}`; // …the numbers, now…
  await tween(LU.drain, tok, (t) => paintXp(1 - t * (1 - to), b.cur, b.max), easeInOut);
  endLevelUp(tok);
}

/**
 * The shockwave — a ring thrown off the chip onto its own canvas. Sized to the
 * chip's rect grown by the ring's reach and NOT to the viewport: a full-screen
 * backing store at phone DPR is megabytes to allocate on the impact frame, and
 * the ring never leaves this box anyway.
 */
function ring(tok: number) {
  const r = rootR!.getBoundingClientRect();
  const w = r.width + RING_PAD * 2;
  const h = r.height + RING_PAD * 2;
  const cv = document.createElement("canvas");
  cv.className = "ml-lvup-fx";
  cv.style.left = `${Math.round(r.left - RING_PAD)}px`;
  cv.style.top = `${Math.round(r.top - RING_PAD)}px`;
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const g = cv.getContext("2d");
  if (!g) return;
  document.body.appendChild(cv);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t0 = performance.now();
  const step = () => {
    const t = (performance.now() - t0) / LU.ring;
    if (t >= 1 || tok !== luRun) return cv.remove();
    g.clearRect(0, 0, w, h);
    g.beginPath();
    g.arc(w / 2, h / 2, RING_R0 + easeOut(t) * RING_GROW, 0, Math.PI * 2);
    g.strokeStyle = `rgba(255,255,255,${((1 - t) * 0.5).toFixed(3)})`;
    g.lineWidth = 2 - t * 1.4;
    g.stroke();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * QA probe. Its OWN namespace (like __mlKb / __mlSelect / __mlAmbient) because
 * WorldScene assigns window.__ml wholesale and would clobber a property here.
 */
function mountProbe() {
  (window as unknown as { __mlBars?: unknown }).__mlBars = {
    /** Fake the exact pair of calls a real level-up arrives as. */
    levelUp: (carry = 0, need = 141) => {
      setBar("xp", carry, need);
      setLevel(level + 1);
    },
    state: () => ({
      level,
      levelText: levelEl?.textContent ?? "",
      xpText: bars.xp?.num.textContent ?? "",
      fill: parseFloat(bars.xp?.fill.style.width || "0"),
      levelScale: levelEl ? new DOMMatrixReadOnly(getComputedStyle(levelEl).transform).a : 1,
      chipScale: rootR ? new DOMMatrixReadOnly(getComputedStyle(rootR).transform).a : 1,
      fillFilter: bars.xp ? getComputedStyle(bars.xp.fill).filter : "none",
      flash: document.querySelectorAll(".ml-lvup-flash").length,
      ring: document.querySelectorAll(".ml-lvup-fx").length,
      playing: luPlaying,
      runs: luRuns,
    }),
  };
}

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  const s = document.createElement("style");
  s.textContent = `
  /* a translucent theme chip so the group reads over any world art */
  .ml-bars{position:fixed;top:10px;z-index:8;pointer-events:none;display:flex;
    flex-direction:column;gap:7px;padding:8px 10px;border-radius:12px;
    background:color-mix(in srgb, var(--bg) 76%, transparent);
    border:1px solid color-mix(in srgb, var(--border) 65%, transparent);
    backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
    transition:left .3s ease,right .3s ease}
  .ml-bars-l{left:calc(var(--gv-left,0px) + 10px)}
  .ml-bars-r{right:calc(var(--gv-right,0px) + 10px)}
  .ml-bar-row{display:flex;flex-direction:column;width:126px}
  .ml-bar-gauge{position:relative;width:100%;height:10px;border-radius:999px;
    background:var(--surface-2);border:1px solid var(--border);
    overflow:hidden;box-sizing:border-box}
  .ml-bar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px}
  .ml-bar-fill[data-color=red]{background:var(--bad)}
  .ml-bar-fill[data-color=yellow]{background:var(--star)}
  .ml-bar-fill[data-color=blue]{background:#5f87c0}
  .ml-bar-num{margin-top:2px;text-align:right;
    font:600 11px/1.3 var(--sans);letter-spacing:.02em;
    color:var(--ink);font-variant-numeric:tabular-nums;white-space:nowrap}
  /* XP row only: "LEVEL n" LEFT + the XP count RIGHT share one line */
  .ml-bar-numrow{margin-top:2px;display:flex;justify-content:space-between;
    align-items:baseline;width:100%;gap:10px}
  .ml-bar-numrow .ml-bar-num{margin-top:0}
  .ml-bar-level{font:600 11px/1.3 var(--sans);letter-spacing:.04em;
    color:var(--muted);white-space:nowrap;text-align:left}
  /* Gold: amount then the nugget icon, both flush right */
  .ml-gold-row{display:flex;justify-content:flex-end;align-items:center;gap:6px;width:100%}
  .ml-gold-num{font:600 12px/1.2 var(--sans);color:var(--ink);
    font-variant-numeric:tabular-nums;white-space:nowrap}
  .ml-gold-icon{height:16px;width:auto;image-rendering:pixelated;
    -webkit-user-drag:none;display:block}
  @media (min-width:700px){ .ml-bar-row{width:170px} }
  /* Level up — "Thunderclap"; the timings live in LU, see playLevelUp(). The
     band is 60% of the track wide, which is what puts its bloom over the
     middle at 34% of the sweep rather than half way. */
  .ml-lvup-flash{position:absolute;top:0;bottom:0;left:0;width:60%;
    border-radius:999px;pointer-events:none;
    background:linear-gradient(90deg,rgba(255,255,255,0) 0%,
      rgba(255,255,255,.95) 50%,rgba(255,255,255,0) 100%)}
  /* z 7 — over the world, UNDER the chips (8): the shockwave passes BEHIND
     the chip it is thrown from, exactly as on the approved page. */
  .ml-lvup-fx{position:fixed;z-index:7;pointer-events:none}`;
  document.head.appendChild(s);
}
