// THE COMPASS AND THE CUBE, CSS ONLY (maintainer 2026-09-26, his picks from ten
// rendered designs: "I want the cube from B3 Pill medallion and the compass
// from A1 Faceted rose … It should also be in sync with the rotation"; before
// that: "They should look more like UI and less like game art"). No pixel art,
// no strip: both are drawn from the theme tokens, so they follow light/dark.
//
// THE COMPASS is the search button's box (34 x 34, its border, radius and
// frosted glass) standing LEFT of the time-of-day pill, 10px off it — which
// lands it on the XP card's left edge, mirroring the Wiki row. It is SUNKEN
// (inset shadow, no lift) because it is a gauge, not a button: nothing
// presses it, so nothing can fail to respond. Inside: a dial with cardinal
// and diagonal ticks and a two-tone needle, each half split light/dark down
// its spine. The needle is the VIEW'S HEADING on a rose: up N, right E, down
// S, left W.
//
// THE CUBE is a frosted CSS 3D cube at the top centre of the game view,
// centred in the gap between the HP and XP cards, seen only while the world
// turns (fade in, fade out a beat after it lands). Its faces are shaded from
// their angle to a fixed light as it turns, and a coral arc under it sweeps
// the way it turns, led by a dot.
//
// IN SYNC: both are drawn from ONE number, the view's position in quarters
// (curQ), and while the world turns that number IS the world's (ml-view-angle,
// every frame), so the needle, the cube and the ground move together.
//
// THE TURN IS A SWIPE. A horizontal flick on the GAME VIEW (the canvas under
// #game — never the HUD, the stick or a dialog) turns the world a quarter:
// swipe LEFT and the world turns CLOCKWISE on screen, so the ground under a
// thumb in the lower half travels left with it; swipe RIGHT for the other way.
// What counts as a swipe is SWIPE_* below; a second finger (a pinch) is never
// one. IT IS FREE BECAUSE THE WALK IS A DOUBLE TAP (maintainer 2026-09-26: "To
// navigate to a position/marker the player will need to double tap! This frees
// up the swipe input in the game view!") — and it ARMS ITSELF on that: until
// WorldScene asks tapgesture.isSecondTap(), a swipe would also start a walk, so
// it turns nothing (walkIsDoubleTap()). The back gesture turns either way
// (backturn.ts). WorldScene hears a turn as a CLICK INSIDE
// `.ml-spinbtn.left|.right`, so a turn dispatches exactly that on two hidden
// elements, and also `ml-spin-tap` ({dir}).
import { secondTapNow, walkIsDoubleTap } from "./tapgesture";

const BAR = "ml-spinbar";
const BTN = "ml-spinbtn";
const ORB_CLS = "ml-spinorb";
const NEEDLE_CLS = "ml-spinneedle";
const CSS_ID = "ml-spinbar-css";
/** The project's one edge margin — and the gap to the pill. */
const GAP = 10;
/** The compass tile: the search button's 32 + its 1px border each side. */
const TILE = 34;
/** The cube's edge (css px). */
const CUBE = 36;
/** The cube's fade, and how long it stays after a turn lands. */
const FADE_MS = 200;
const FADE_HOLD_MS = 250;
/** WHAT A SWIPE IS. Quick (the walk is a HOLD, so a slow drag stays the
 *  walk's), long enough not to be a wobbly tap, and mostly sideways. */
const SWIPE_MS = 450;
const SWIPE_MIN_PX = 60;
const SWIPE_MIN_FRAC = 0.15; // …of the view's width, whichever is longer
const SWIPE_SIDEWAYS = 1.8; // |dx| over |dy|
/** A quarter on the cube's OWN clock — only when the world is not turning it
 *  (no world, or one that went silent): a control has to feel like it moved
 *  when the finger lifts. */
const QUARTER_MS = 360;

let bar: HTMLElement | null = null;
let orb: HTMLElement | null = null;
let cube: HTMLElement | null = null;
let faces: HTMLElement[] = [];
let needle: HTMLElement | null = null;
let needleBox: HTMLElement | null = null;
let fadeT = 0;
/** THE CUBE IS SEEN ONLY WHILE THE WORLD TURNS: shown at once, hidden a beat
 *  after the turn has landed (a quick second swipe keeps it up). */
function showCube(on: boolean): void {
  if (!orb) return;
  clearTimeout(fadeT);
  if (on) orb.classList.add("on");
  else fadeT = window.setTimeout(() => orb?.classList.remove("on"), FADE_HOLD_MS);
}
/** WHERE THE VIEW IS, and WHERE IT IS HEADING, in quarters and UNWRAPPED —
 *  that is the whole design (maintainer 2026-09-26).
 *
 *  A turn does not queue an animation; it moves `targetQ` by one, and one loop
 *  travels the SIGNED distance to it. Every rule he gave falls out of that:
 *   - "left arrow and then the right arrow during the animation… should change
 *     direction immidiatly and go back to the original position" — the two
 *     turns cancel on the target and the next frame walks back.
 *   - "twice on left or twice on right… 180°. 3 taps = 270°. 4 taps = 360°" —
 *     turns ACCUMULATE.
 *   - "always the shortest rotation towards the goal" — an unwrapped target
 *     makes the long way round inexpressible: `targetQ - curQ` IS the route.
 *  Both are reduced by a whole turn once it settles. */
let curQ = 0;
let targetQ = 0;
/** The running loop and the timestamp it last integrated. */
let raf = 0;
let last = 0;
/** Which way the arc sweeps: the way the current turn goes. */
let arcDir: 1 | -1 = 1;

/** How far the Report button (recbtn.ts) drops for a spin row in its column:
 *  NOTHING — there is none. Still published (0) so recbtn.ts keeps one source
 *  for the answer. */
const STEP = "0px";

/** The needle's angle: the view's HEADING, +90° per quarter (the view's +1
 *  turns the world counter-clockwise on screen, i.e. the viewer clockwise,
 *  N -> E). */
const needleDeg = () => curQ * 90;

/** DRAW BOTH FROM curQ. The cube turns WITH the ground: the view's +1 turns
 *  the world counter-clockwise on screen, and rotateY(+) turns a CSS cube's
 *  top face counter-clockwise as seen from above-front — so +90° per quarter,
 *  from the 45° that shows two sides like the isometric world does. */
function draw(): void {
  const deg = needleDeg();
  if (needle) needle.style.transform = `rotate(${deg}deg)`;
  if (!cube || !orb) return;
  cube.style.transform = `rotateX(-30deg) rotateY(${45 + deg}deg)`;
  // THE LIGHT STAYS PUT while the cube turns: each side face is shaded by its
  // angle to a key light at the upper front-left
  for (let i = 0; i < 4; i++) {
    const th = ((i * 90 + 45 + deg) * Math.PI) / 180;
    const lit = Math.max(0, Math.min(1, 0.55 + 0.55 * (Math.cos(th) * 0.8 - Math.sin(th) * 0.6)));
    faces[i]?.style.setProperty("--lit", lit.toFixed(3));
  }
  // the floor shadow is as wide as the cube's footprint seen from the front
  const yaw = ((45 + deg) * Math.PI) / 180;
  orb.style.setProperty("--sw", ((Math.abs(Math.cos(yaw)) + Math.abs(Math.sin(yaw))) / Math.SQRT2).toFixed(3));
  // THE ARC: how much of the quarter under way is done, swept the way it goes
  const remain = targetQ - curQ;
  if (Math.abs(remain) > 1e-6) {
    arcDir = remain > 0 ? -1 : 1;
    const sweep = 180 * (1 - Math.min(1, Math.abs(remain)));
    const a = (sweep * Math.PI) / 180;
    orb.style.setProperty("--sweep", `${sweep}deg`);
    orb.style.setProperty("--arc-dir", String(arcDir));
    orb.style.setProperty("--ax", `${33 * Math.cos(a) * arcDir}px`);
    orb.style.setProperty("--ay", `${12 * Math.sin(a)}px`);
  }
}

/** The quarter an unwrapped position belongs to, 0..3 — what `ml-spin` says. */
const quarterOf = (q: number) => ((Math.round(q) % 4) + 4) % 4;

/** THE WORLD'S ANGLE, while the world turns (WorldScene publishes it every frame
 *  on `ml-view-angle`, in quarters, with the goal its turns set): the compass
 *  and the cube draw where the WORLD is instead of running a clock of their own
 *  — the two drifted apart, the cube done in 0.4 s while the world was still
 *  preparing its turn (maintainer 2026-09-26: "it's not in sync with the cube
 *  rotation"). The world counts the same turns, so `worldLag` — how far it
 *  still has to turn, in quarters — is all they need: they stand at
 *  `targetQ - worldLag`. A world
 *  that stops publishing is let go after WORLD_STALE_MS, and the cube finishes
 *  on its own clock. */
let worldLag: number | null = null;
let worldBusy = false;
let worldAt = 0;
/** A LAST RESORT only: the world re-publishes every frame while a turn is owed
 *  (through its captures, its swap, a refused turn's retries) and says `busy:
 *  false` at rest, so silence this long means the world is gone. */
const WORLD_STALE_MS = 5000;
window.addEventListener("ml-view-angle", (e) => {
  // verify-spinbar sets this: it gates the compass's OWN arithmetic, and a
  // software browser turning the world would set its pace
  if ((window as unknown as { __mlSpinFollow?: boolean }).__mlSpinFollow === false) return;
  const d = (e as CustomEvent<{ q?: number; goal?: number; busy?: boolean }>).detail;
  if (!d || typeof d.q !== "number" || typeof d.goal !== "number") return;
  worldLag = d.goal - d.q;
  worldBusy = !!d.busy;
  worldAt = performance.now();
  if (worldBusy || Math.abs(worldLag) > 1e-6) showCube(true);
  // drawn NOW, not on the next frame: a frame behind the world is a visible
  // step at mid-turn speed
  curQ = targetQ - worldLag;
  draw();
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
});

const tick = (now: number) => {
  // A BACKGROUNDED TAB MUST NOT TELEPORT IT. rAF stops while hidden, so the
  // first frame back carries the whole gap; clamped, the orb simply resumes
  // from where it was, which is what a paused animation should look like.
  const dt = Math.min(200, Math.max(0, now - last));
  last = now;
  if (worldLag !== null) {
    if (now - worldAt > WORLD_STALE_MS) worldLag = null;
    else {
      // FOLLOWING THE WORLD: never past the target, never behind where it was
      // asked to come back from — the lag is the world's own
      curQ = targetQ - worldLag;
      if (worldBusy || Math.abs(worldLag) > 1e-6) {
        draw();
        raf = requestAnimationFrame(tick);
        return;
      }
      worldLag = null; // the world rests on the goal: land below, as ever
    }
  }
  const remain = targetQ - curQ;
  const step = dt / QUARTER_MS;
  if (Math.abs(remain) <= step) {
    // LANDED, always on a quarter boundary because every turn moves the
    // target by exactly one: "a perfect 90° rotation".
    curQ = targetQ;
    draw();
    raf = 0;
    showCube(false);
    curQ = targetQ = ((targetQ % 4) + 4) % 4; // same heading, small numbers
    window.dispatchEvent(new CustomEvent("ml-spin", { detail: { quarter: quarterOf(targetQ) } }));
    return;
  }
  curQ += Math.sign(remain) * step;
  draw();
  raf = requestAnimationFrame(tick);
};

/** A turn: one quarter onto the target, in the direction pressed. It never
 *  refuses — a press DURING the animation is the point. */
function nudge(dir: 1 | -1): void {
  showCube(true);
  // THE WORLD HEARS IT: the new event, and the click its listener still reads
  // (see the header) on the hidden twin for this direction.
  window.dispatchEvent(new CustomEvent("ml-spin-tap", { detail: { dir } }));
  bar?.querySelector<HTMLElement>(`.${BTN}.${dir < 0 ? "left" : "right"}`)?.click();
  targetQ += dir;
  // the world hears this tap too, a frame later: until it says so, the lag
  // grows with the target so the cube does not jump a quarter ahead
  if (worldLag !== null) worldLag += dir;
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
}

/** TURN THE VIEW a quarter, exactly as a swipe does — the cube, the compass
 *  and the world together. backturn.ts calls this; false when the bar is not up
 *  (the caller then has nothing to turn). */
export function turnView(dir: 1 | -1): boolean {
  if (!bar) return false;
  nudge(dir);
  return true;
}

/** THE HIDDEN TWINS: WorldScene turns on a click inside `.ml-spinbtn.left` /
 *  `.right`. Not buttons anyone can see or reach — display:none, no tab stop,
 *  aria-hidden — just the two targets that contract needs until the world
 *  listens to `ml-spin-tap`. */
function twin(dir: 1 | -1): HTMLElement {
  const b = document.createElement("span");
  b.className = `${BTN} ${dir < 0 ? "left" : "right"}`;
  b.setAttribute("aria-hidden", "true");
  b.style.display = "none";
  return b;
}

/** PLACE the compass left of the LIVE pill, on its line, and the cube at the
 *  game view's horizontal centre. Called on every layout event and whenever
 *  the pill changes size. */
function place(): void {
  const pill = document.querySelector<HTMLElement>(".ml-clock");
  if (needleBox && pill) {
    const p = pill.getBoundingClientRect();
    if (p.height) {
      needleBox.style.top = `${Math.round(p.top + (p.height - TILE) / 2)}px`;
      needleBox.style.left = `${Math.round(p.left - GAP - TILE)}px`;
    }
  }
  const game = document.getElementById("game");
  if (orb && game) {
    const g = game.getBoundingClientRect();
    if (g.width) orb.style.left = `${Math.round(g.left + g.width / 2 - CUBE / 2)}px`;
  }
}

/** THE SWIPE. Listens on the document (passive, capture — nothing of the
 *  world's is touched), and counts only a gesture that STARTED on the game
 *  canvas with one finger. */
let swipeFrom: { id: number; x: number; y: number; t: number } | null = null;
let fingers = 0;
function onDown(e: PointerEvent): void {
  fingers++;
  const onCanvas = e.target instanceof HTMLCanvasElement && !!e.target.closest("#game");
  // the EVENT's own time, not the handler's: a frame that ran long must not
  // turn a quick flick into a slow drag
  // THE SECOND TAP OF A DOUBLE TAP IS THE WALK'S (tapgesture.ts): its drag
  // steers the trip it started, so it is never a swipe.
  const second = onCanvas && secondTapNow();
  swipeFrom = fingers === 1 && onCanvas && !second ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
}
function onUp(e: PointerEvent): void {
  fingers = Math.max(0, fingers - 1);
  const s0 = swipeFrom;
  if (!s0 || s0.id !== e.pointerId) return;
  swipeFrom = null;
  if (e.type === "pointercancel") return;
  const dx = e.clientX - s0.x;
  const dy = e.clientY - s0.y;
  const long = Math.max(SWIPE_MIN_PX, window.innerWidth * SWIPE_MIN_FRAC);
  const ms = e.timeStamp - s0.t;
  const ok = ms <= SWIPE_MS && Math.abs(dx) >= long && Math.abs(dx) >= SWIPE_SIDEWAYS * Math.abs(dy);
  const armed = walkIsDoubleTap();
  lastSwipe = { dx: Math.round(dx), dy: Math.round(dy), ms: Math.round(ms), long: Math.round(long), ok, armed };
  // NOT ARMED: a single touch still starts a walk, so a turn here would be a
  // turn AND a trip (tapgesture.ts says when it arms)
  if (!ok || !armed) return;
  // LEFT turns the world CLOCKWISE on screen (-1): the ground below the view's
  // middle — where the thumb swipes — travels left with the finger. (The
  // view's +1 is counter-clockwise: measured, the house on the player's right
  // went to the upper left on one +1.)
  nudge(dx < 0 ? -1 : 1);
}
let swipeBound = false;
/** The last gesture judged, for the gate and for tuning. */
let lastSwipe: { dx: number; dy: number; ms: number; long: number; ok: boolean; armed: boolean } | null = null;

function el(tag: string, cls: string, parent?: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

export function mountSpinBar(): void {
  document.querySelectorAll(`.${BAR}`).forEach((e) => e.remove());
  injectStyles();
  document.documentElement.style.setProperty("--ml-spin-step", STEP);
  bar = el("div", BAR);
  // THE CUBE: six faces, the arc and its dot, and the floor shadow
  orb = el("div", ORB_CLS);
  orb.setAttribute("aria-hidden", "true");
  el("i", `${ORB_CLS}-floor`, orb);
  cube = el("div", `${ORB_CLS}-cube`, orb);
  faces = ["fr", "rt", "bk", "lt"].map((f) => el("i", `${ORB_CLS}-f ${f}`, cube!));
  el("b", "", el("i", `${ORB_CLS}-f tp`, cube));
  el("i", `${ORB_CLS}-f bt`, cube);
  el("i", `${ORB_CLS}-arc`, orb);
  el("i", `${ORB_CLS}-head`, orb);
  // THE COMPASS: the dial, its two tick rings, the needle and its pin
  needleBox = el("div", `${NEEDLE_CLS}-box`);
  needleBox.setAttribute("role", "img");
  needleBox.setAttribute("aria-label", "Compass");
  const dial = el("div", `${NEEDLE_CLS}-dial`, needleBox);
  el("i", `${NEEDLE_CLS}-tk`, dial);
  el("i", `${NEEDLE_CLS}-tk2`, dial);
  needle = el("div", NEEDLE_CLS, dial);
  el("i", "n", needle);
  el("i", "s", needle);
  el("b", `${NEEDLE_CLS}-pin`, dial);
  bar.append(orb, needleBox, twin(-1), twin(1));
  document.body.appendChild(bar);
  draw();
  place();
  if (!swipeBound) {
    swipeBound = true;
    document.addEventListener("pointerdown", onDown, { capture: true, passive: true });
    document.addEventListener("pointerup", onUp, { capture: true, passive: true });
    document.addEventListener("pointercancel", onUp, { capture: true, passive: true });
    // …and a frame LATER too: the pill re-sizes and re-rows itself on the same
    // event (clock.ts fitPill), and listener order must not decide who wins
    const later = () => {
      place();
      requestAnimationFrame(place);
    };
    window.addEventListener("ml-layout", later);
    window.addEventListener("resize", later);
  }
  // THE PILL IS MOUNTED AFTER THIS (hud.ts order), so it is waited for rather
  // than assumed: a frame at a time until it and the game view exist, then
  // watched — the pill grows with the card (clock.ts fitPill) — and placed on
  // every change, measured.
  const mine = bar;
  const watch = () => {
    if (bar !== mine) return; // a rebuilt HUD mounted a new row
    const els = [".ml-clock", "#game"].map((q) => document.querySelector(q));
    if (els.some((e) => !e)) return void requestAnimationFrame(watch);
    const ro = new ResizeObserver(place);
    for (const e of els) ro.observe(e as Element);
    place();
  };
  watch();
}

/** QA probe: a turn exactly as a swipe or a back makes one. */
(window as unknown as { __mlSpinTurn?: (d: 1 | -1) => boolean }).__mlSpinTurn = (d) => turnView(d);

/** QA probe: where the compass and the cube stand, in QUARTERS and unwrapped
 *  (curQ where they are, targetQ where the turns put them) — a gate reads
 *  these rather than racing the compositor for a frame. */
(window as unknown as { __mlSpin?: () => unknown }).__mlSpin = () => ({
  quarter: quarterOf(targetQ),
  spinning: raf !== 0,
  curQ,
  targetQ,
  needleDeg: needleDeg(),
  cubeDeg: 45 + needleDeg(),
  cubeShown: !!orb?.classList.contains("on"),
  swipeArmed: walkIsDoubleTap(),
  lastSwipe,
  fingers,
});

let injected = false;
function injectStyles(): void {
  if (injected) return;
  injected = true;
  const s = document.createElement("style");
  s.id = CSS_ID;
  const N = NEEDLE_CLS;
  const O = ORB_CLS;
  // one 4-point clip for the needle halves, the tick masks as rings
  const ring = (r0: number, r1: number) =>
    `-webkit-mask:radial-gradient(circle,transparent ${r0}px,#000 ${r0 + 0.5}px,#000 ${r1}px,transparent ${r1 + 0.5}px);` +
    `mask:radial-gradient(circle,transparent ${r0}px,#000 ${r0 + 0.5}px,#000 ${r1}px,transparent ${r1 + 0.5}px)`;
  s.textContent = `
  /* A holder only: the cube and the compass are each fixed and placed from JS
     (place()). */
  .${BAR}{position:fixed;left:0;top:0;width:0;height:0;z-index:8;pointer-events:none}

  /* THE COMPASS: the search button's box (wikinear.ts), SUNKEN — an inset
     shadow and no lift, because it is a gauge and nothing presses it. */
  .${N}-box{position:fixed;width:${TILE - 2}px;height:${TILE - 2}px;box-sizing:content-box;
    border:1px solid var(--border-strong);border-radius:7px;pointer-events:none;
    display:flex;align-items:center;justify-content:center;
    background:color-mix(in srgb, var(--bg) 76%, transparent);
    backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
    box-shadow:inset 0 1px 2px rgba(0,0,0,.14),inset 0 0 0 1px color-mix(in srgb, var(--surface) 55%, transparent);
    transition:left .3s ease,top .3s ease}
  .${N}-dial{position:relative;width:26px;height:26px;border-radius:50%;
    background:radial-gradient(circle at 50% 30%, var(--surface), var(--surface-2) 80%);
    box-shadow:inset 0 0 0 1px var(--border),inset 0 1px 3px rgba(0,0,0,.14)}
  /* ticks: the four cardinals, then fainter diagonals, each a conic ring */
  .${N}-tk,.${N}-tk2{position:absolute;inset:1.5px;border-radius:50%}
  .${N}-tk{background:repeating-conic-gradient(from -2deg, var(--muted) 0 4deg, transparent 4deg 90deg);${ring(9, 11.5)}}
  .${N}-tk2{background:repeating-conic-gradient(from 43.5deg, color-mix(in srgb, var(--muted) 60%, transparent) 0 3deg, transparent 3deg 90deg);${ring(10.5, 11.5)}}
  /* the needle: two halves, each split light/dark down its spine */
  .${N}{position:absolute;left:10px;top:2.5px;width:6px;height:21px;transform-origin:50% 50%}
  .${N} i{position:absolute;left:0;width:6px;height:10.5px}
  .${N} .n{top:0;clip-path:polygon(50% 0,100% 100%,0 100%);
    background:linear-gradient(90deg, color-mix(in srgb, var(--accent) 72%, #fff) 50%, color-mix(in srgb, var(--accent) 86%, #000) 50%)}
  .${N} .s{bottom:0;clip-path:polygon(0 0,100% 0,50% 100%);
    background:linear-gradient(90deg, color-mix(in srgb, var(--ink) 55%, var(--surface)) 50%, var(--ink) 50%)}
  .${N}-pin{position:absolute;left:10.5px;top:10.5px;width:5px;height:5px;border-radius:50%;
    background:var(--surface);box-shadow:0 0 0 1px var(--ink),0 1px 1px rgba(0,0,0,.3)}

  /* THE CUBE: centred in the gap between the HP and XP cards, seen only while
     the world turns. Frosted faces, shaded from JS (--lit). */
  .${O}{position:fixed;top:calc(var(--ml-safe-top, 0px) + ${GAP}px + var(--bars-r-h, 78px) / 2 - ${CUBE / 2}px);
    width:${CUBE}px;height:${CUBE}px;perspective:520px;pointer-events:none;
    opacity:0;transform:scale(.9);transition:opacity ${FADE_MS}ms ease,transform ${FADE_MS + 100}ms cubic-bezier(.2,.8,.2,1)}
  .${O}.on{opacity:1;transform:none}
  .${O}-cube{position:absolute;inset:0;transform-style:preserve-3d}
  .${O}-f{position:absolute;inset:0;display:grid;place-items:center;
    background:color-mix(in srgb, var(--surface) 55%, transparent);
    border:1px solid color-mix(in srgb, var(--ink) 35%, transparent)}
  .${O}-f::before{content:"";position:absolute;inset:0;background:#000;opacity:calc((1 - var(--lit, 1)) * .25)}
  .${O}-f.fr{transform:translateZ(${CUBE / 2}px)}
  .${O}-f.rt{transform:rotateY(90deg) translateZ(${CUBE / 2}px)}
  .${O}-f.bk{transform:rotateY(180deg) translateZ(${CUBE / 2}px)}
  .${O}-f.lt{transform:rotateY(-90deg) translateZ(${CUBE / 2}px)}
  .${O}-f.tp{transform:rotateX(90deg) translateZ(${CUBE / 2}px);background:color-mix(in srgb, var(--surface) 85%, transparent)}
  .${O}-f.tp b{width:5px;height:5px;border-radius:50%;background:var(--accent)}
  .${O}-f.bt{transform:rotateX(-90deg) translateZ(${CUBE / 2}px);--lit:.4}
  .${O}-floor{position:absolute;left:50%;top:${CUBE * 0.62}px;width:calc(${CUBE * 1.25}px * var(--sw, 1));height:${CUBE * 0.34}px;
    transform:translateX(-50%);border-radius:50%;background:radial-gradient(closest-side, rgba(0,0,0,.34), rgba(0,0,0,0))}
  /* THE ARC under the cube: the lower half of an ellipse, revealed the way the
     turn goes (--sweep, --arc-dir), led by a dot (--ax, --ay). */
  .${O}-arc{position:absolute;left:${CUBE / 2 - 34}px;top:${CUBE / 2 + 2}px;width:68px;height:26px;border-radius:50%;
    border:2px solid transparent;border-bottom-color:var(--accent);box-sizing:border-box;
    transform:scaleX(var(--arc-dir, 1));
    -webkit-mask:conic-gradient(from 90deg, #000 0 var(--sweep, 0deg), transparent 0);
    mask:conic-gradient(from 90deg, #000 0 var(--sweep, 0deg), transparent 0);
    filter:drop-shadow(0 0 1px rgba(0,0,0,.35))}
  .${O}-head{position:absolute;left:calc(${CUBE / 2}px + var(--ax, 33px));top:calc(${CUBE / 2 + 15}px + var(--ay, 0px));
    width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;background:var(--accent);
    box-shadow:0 0 0 1.5px var(--surface)}
  @media (prefers-reduced-motion: reduce){.${O}{transition:none}}
`;
  document.head.appendChild(s);
}
