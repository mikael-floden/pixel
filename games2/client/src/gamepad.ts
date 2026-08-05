/**
 * On-screen ANALOG STICK — the gamepad tab's controller (maintainer
 * 2026-07-22: play without tapping the world).
 *
 * WIKI-STYLE (maintainer 2026-07-30): the sprite art (pad-stick2-*.png) is
 * gone — the stick is now pure HTML/CSS on the shared theme: a round WELL
 * (surface-2, 1px border, inset shade) with a round CAP that translates, and
 * the jump control is a plain round wiki button. ONLY the visuals changed —
 * the input contract is byte-identical to the art era:
 *
 *  - The stick SNAPS TO 8 DIRECTIONS — it simulates the keyboard (WASD),
 *    nothing else: each octant maps to the same key set a keyboard player
 *    would hold (NE = W+D …), synthesized as real window KeyboardEvents.
 *    WorldScene's Phaser keyboard consumes them exactly like physical keys
 *    (prediction, server validation, keyboard-cancels-tap all identical) —
 *    no games-agent file is touched. Phaser reads event.keyCode, which the
 *    KeyboardEvent init dict can't set — defineProperty fills it in.
 *  - The CAP's ANGLE snaps to the 8 directions (octant changes glide there
 *    through a FAST transition — "the snap should not be instant"); its
 *    AMPLITUDE is analog, drawn damped by CAP_VISUAL_FRAC. The finger keeps
 *    steering at ANY distance past the travel radius without losing input
 *    (setPointerCapture keeps the drag alive far outside the well).
 *  - Dead zone around the centre releases all keys (rest = no input).
 *
 * FEEL (2026-07-30): the travel/dead/run distances are WELL-derived now
 * (maxCss = well * TRAVEL_FRAC — the maintainer wanted a longer drag than
 * the art-era 18-27px feel tiers gave); the KEY CONTRACT — octants, dead
 * zone fraction, run fraction, synthesized WASD/SHIFT — is unchanged
 * (verify-gamepad.mjs pins it).
 */

import { gameAudio } from "../../composer/index";
import { getHand } from "./controls";

// Full-gate travel is derived from the WELL since the wiki remake (maintainer
// 2026-07-30: "you should be able to drag the thumbstick a longer distance" —
// the art-era TRAVEL*feelK gave only ~18-27px of drag inside a 104-132px
// well). travel = well * TRAVEL_FRAC, with TRAVEL_FRAC chosen so the CAP's
// damped deflection (travel * CAP_VISUAL_FRAC) reaches exactly the well rim
// at full gate: rim gap = well*0.25 (cap dia = well/2) and 0.38*0.65 ≈ 0.25.
const TRAVEL_FRAC = 0.38;
const DEAD_FRAC = 0.35; // of the max: inside this, all keys are up
const RUN_FRAC = 0.75; // of the max: past this amplitude the gait is RUN (Shift), else walk
const SNAP_MS = 80; // the fast (not instant) glide between snap positions
// the cap DRAWS at this fraction of the input radius — like a real thumbstick,
// the cap's centre moves less than the thumb; the input circle (dead zone,
// run, full gate) is untouched.
const CAP_VISUAL_FRAC = 0.65;
// Octants counter-clockwise from screen-east with y DOWN → index = round(angle/45°)
// mod 8 over atan2(dy,dx): E, SE, S, SW, W, NW, N, NE — each holds the keys a
// keyboard player would.
const SECTOR_KEYS: string[][] = [
  ["D"],
  ["S", "D"],
  ["S"],
  ["S", "A"],
  ["A"],
  ["W", "A"],
  ["W"],
  ["W", "D"],
];
const KEYCODE: Record<string, number> = { W: 87, A: 65, S: 83, D: 68, SHIFT: 16, SPACE: 32, F: 70 };

function synthKey(kind: "keydown" | "keyup", k: string) {
  const e = new KeyboardEvent(
    kind,
    k === "SHIFT"
      ? { key: "Shift", code: "ShiftLeft", bubbles: true }
      : k === "SPACE"
        ? { key: " ", code: "Space", bubbles: true }
        : { key: k.toLowerCase(), code: `Key${k}`, bubbles: true },
  );
  // Phaser's KeyboardPlugin routes by event.keyCode — not settable via the
  // init dict, so define it on the instance.
  Object.defineProperty(e, "keyCode", { get: () => KEYCODE[k] });
  Object.defineProperty(e, "which", { get: () => KEYCODE[k] });
  window.dispatchEvent(e);
}

/** Mount the stick into the gamepad page. Idempotent per page element. */
export function mountGamepadStick(page: HTMLElement) {
  injectStyles();
  const pad = mk("div", "ml-pad-stick");
  const top = mk("div", "ml-pad-top");
  pad.append(top);
  page.appendChild(pad);

  // ── the landscape ghost's BLUR DISC (maintainer 2026-08-05: "the same blur
  // you use for the other on-top-of-game-view UI boxes"). It has to be its
  // OWN element, not backdrop-filter on the stick: the stick's background is
  // opaque, so it would paint straight over its own blurred backdrop — and
  // the 0.25 ghost opacity would then dilute whatever survived to nothing
  // (a child or ::before can't escape it either; parent opacity applies to
  // the whole group). So the blur is a full-opacity, transparent disc pinned
  // under the stick (z 3 vs 4), carrying exactly the bars chips' blur(5px).
  // Landscape only — the portrait stick sits on the opaque HUD page.
  const padBlur = mk("div", "ml-pad-blur");
  page.appendChild(padBlur);

  // ── JUMP BUTTON (maintainer's spot: left side at the stick's mirror
  // height): a round wiki button. A press synthesizes SPACE (WorldScene:
  // keydown-SPACE -> tryJump), so the button jumps exactly like the
  // keyboard; it owns its own pointer, so steering and jumping work at
  // the same time.
  const jump = mk("button", "ml-pad-jump");
  page.appendChild(jump);

  // ── PICK UP BUTTON (maintainer 2026-07-31: "a pick up-button next to the
  // jump button"): same round wiki look, a size down. A press synthesizes F
  // (WorldScene: keydown-F -> pickupNearest) — walks to the nearest ground
  // item and grabs it, exactly like the keyboard.
  const pickup = mk("button", "ml-pad-pickup");
  page.appendChild(pickup);

  // labels over each control (maintainer: "write JUMP over it… WALK over
  // the button to the right") — the wiki section-label look, same as the
  // Settings "Ambient effects" header.
  const jumpLabel = mk("div", "ml-pad-label");
  jumpLabel.textContent = "Jump";
  const pickupLabel = mk("div", "ml-pad-label");
  pickupLabel.textContent = "Pick up";
  const walkLabel = mk("div", "ml-pad-label");
  walkLabel.textContent = "Walk";
  page.append(jumpLabel, pickupLabel, walkLabel);

  // ── ONE-TIME HELP (maintainer 2026-08-05): tell new players the stick side
  // is theirs to choose. An absolute overlay chip at the top of the page, so
  // it NEVER moves the controls; the × dismisses it forever (localStorage).
  if (!localStorage.getItem("ml-hand-help")) {
    const help = mk("div", "ml-pad-help");
    const txt = mk("span", "");
    txt.textContent = "Playing left-handed? Swap the stick side any time in Settings → controls.";
    const x = mk("button", "ml-pad-help-x") as HTMLButtonElement;
    x.type = "button";
    x.textContent = "×";
    x.setAttribute("aria-label", "Dismiss");
    x.addEventListener("click", () => {
      try {
        localStorage.setItem("ml-hand-help", "1");
      } catch {}
      help.remove();
    });
    help.append(txt, x);
    page.appendChild(help);
  }

  // ── layout: sizes step with the FEEL tier; anchors keep the maintainer's
  // marked spots (stick centre ~70.5% across, jump at 25%, both centred on
  // one midline). ──
  let maxCss = 56; // full-gate travel in css px (well-derived; see layout)
  let well = 148; // well diameter, css px
  // the cap's VISUAL state: the ANGLE snaps to the active octant (-1 =
  // centred) but the AMPLITUDE is analog — the cap follows the finger's
  // distance up to the css travel clamp ("only snap the angle, not the
  // amplitude"). Radius kept in css px.
  let visSector = -1;
  let visRadius = 0;
  // Animate INTO position only on orientation/handedness changes (maintainer
  // 2026-08-05: "not when clicking from and to the game-controller page") —
  // the left/top transitions live under a transient .anim class; everything
  // else (page entry, plain resizes) repositions instantly.
  let lastLand: boolean | null = null;
  let lastHand: boolean | null = null;
  let animTimer = 0;
  const controls = () => [pad, padBlur, jump, pickup, jumpLabel, pickupLabel, walkLabel];
  const armAnim = () => {
    for (const el of controls()) el.classList.add("anim");
    window.clearTimeout(animTimer);
    animTimer = window.setTimeout(() => {
      for (const el of controls()) el.classList.remove("anim");
    }, 350);
  };
  const setCap = (sector: number, radiusCss: number) => {
    visSector = sector;
    visRadius = sector < 0 ? 0 : radiusCss;
    const a = (sector * Math.PI) / 4;
    const dx = sector < 0 ? 0 : Math.cos(a) * visRadius;
    const dy = sector < 0 ? 0 : Math.sin(a) * visRadius;
    top.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const layout = () => {
    well = window.innerWidth >= 585 ? 148 : 120;
    // travel rides the well: full gate when the damped cap reaches the rim
    maxCss = Math.round(well * TRAVEL_FRAC);
    const cap = Math.round(well * 0.5);
    const jumpD = Math.round(well * 0.66);
    pad.style.width = pad.style.height = `${well}px`;
    top.style.width = top.style.height = `${cap}px`;
    top.style.left = top.style.top = `${Math.round((well - cap) / 2)}px`;
    const cs = getComputedStyle(page);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBot = parseFloat(cs.paddingBottom) || 0;
    const midY = padTop + (page.clientHeight - padTop - padBot) * 0.5;
    // HANDEDNESS (controls.ts): right-handed (default) keeps the maintainer's
    // marked spots — stick 70.5% across, pick-up 46.5%, jump 25%; left-handed
    // mirrors all three. The stick side is the promise ("always on the right
    // / always on the left"), portrait and landscape alike. Pick up sits
    // between jump and the stick, a size down so the jump stays the primary
    // thumb target (games agent, 2026-08-05 — merged with handedness here).
    const leftHand = getHand() === "left";
    const stickFx = leftHand ? 1 - 0.705 : 0.705;
    const jumpFx = leftHand ? 1 - 0.25 : 0.25;
    const pickFx = leftHand ? 1 - 0.465 : 0.465;
    const pickD = Math.round(jumpD * 0.72);
    const land = document.documentElement.classList.contains("ml-land");
    // glide only when the ARRANGEMENT changes (rotation / handedness) and the
    // page is actually visible — never on page entry or plain resizes
    if (page.clientWidth > 0 && lastLand !== null && (land !== lastLand || leftHand !== lastHand)) armAnim();
    lastLand = land;
    lastHand = leftHand;
    if (land) {
      // LANDSCAPE: the stick leaves the page and FLOATS in the game view's
      // very bottom corner on the thumb's side, GHOSTED at 0.25 alpha
      // (maintainer 2026-08-05: "75% transparency… behind any chat text or
      // time-of-day pill") — position:fixed escapes the page box; an
      // unselected gamepad tab still hides it (display:none up the tree).
      // z-index 4 keeps it UNDER the chat overlay (5), the pill and the
      // chips (8); chat lines and the pill are pointer-events:none, so the
      // thumb steers straight through them. Jump + pick up stay IN the menu
      // column under the other thumb, side by side on the midline (no hand
      // mirror inside the column — it is under the free thumb either way).
      pad.style.position = "fixed";
      pad.style.zIndex = "4";
      pad.style.opacity = "0.25";
      pad.style.left = `${leftHand ? 10 : window.innerWidth - 10 - well}px`;
      pad.style.top = `${window.innerHeight - 10 - well}px`;
      // the blur disc rides exactly under it
      padBlur.style.display = "block";
      padBlur.style.width = padBlur.style.height = `${well}px`;
      padBlur.style.left = pad.style.left;
      padBlur.style.top = pad.style.top;
      // JUMP sits UNDER PICK UP (maintainer 2026-08-05) — a centred vertical
      // stack around the column's midline, label above each button.
      const cx = Math.round(page.clientWidth / 2);
      const gap = 34; // room for the lower button's label between the two
      pickup.style.width = pickup.style.height = `${pickD}px`;
      pickup.style.left = `${cx - Math.round(pickD / 2)}px`;
      pickup.style.top = `${Math.round(midY - gap / 2 - pickD)}px`;
      jump.style.width = jump.style.height = `${jumpD}px`;
      jump.style.left = `${cx - Math.round(jumpD / 2)}px`;
      jump.style.top = `${Math.round(midY + gap / 2)}px`;
      pickupLabel.style.left = `${cx}px`;
      pickupLabel.style.top = `${Math.round(midY - gap / 2 - pickD - 10)}px`;
      jumpLabel.style.left = `${cx}px`;
      jumpLabel.style.top = `${Math.round(midY + gap / 2 - 10)}px`;
      walkLabel.style.display = "none"; // a floating label over world art is noise
    } else {
      pad.style.position = "";
      pad.style.zIndex = "";
      pad.style.opacity = "";
      padBlur.style.display = "none"; // portrait sits on the opaque HUD page
      pad.style.left = `${Math.round(page.clientWidth * stickFx - well / 2)}px`;
      pad.style.top = `${Math.round(midY - well / 2)}px`;
      jump.style.width = jump.style.height = `${jumpD}px`;
      jump.style.left = `${Math.round(page.clientWidth * jumpFx - jumpD / 2)}px`;
      jump.style.top = `${Math.round(midY - jumpD / 2)}px`;
      pickup.style.width = pickup.style.height = `${pickD}px`;
      pickup.style.left = `${Math.round(page.clientWidth * pickFx - pickD / 2)}px`;
      pickup.style.top = `${Math.round(midY - pickD / 2)}px`;
      // labels share one row, floating a fixed gap above the taller control
      const labelY = Math.round(midY - well / 2 - 10);
      walkLabel.style.display = "";
      for (const [el, fx] of [
        [jumpLabel, jumpFx],
        [pickupLabel, pickFx],
        [walkLabel, stickFx],
      ] as const) {
        el.style.left = `${Math.round(page.clientWidth * fx)}px`;
        el.style.top = `${labelY}px`;
      }
    }
    setCap(visSector, visRadius);
  };
  layout();
  window.addEventListener("resize", layout);
  window.addEventListener("ml-hand", layout);
  new ResizeObserver(layout).observe(page);

  // ── input ──
  const held = new Set<string>();
  const setKeys = (sector: number, run: boolean) => {
    // plain WASD walks; SHIFT held = run (WorldScene: running = SHIFT down)
    const want = sector < 0 ? [] : run ? [...SECTOR_KEYS[sector], "SHIFT"] : SECTOR_KEYS[sector];
    for (const key of [...held]) {
      if (!want.includes(key)) {
        held.delete(key);
        synthKey("keyup", key);
      }
    }
    for (const key of want) {
      if (!held.has(key)) {
        held.add(key);
        synthKey("keydown", key);
      }
    }
  };
  let dragging = false;
  const apply = (ev: PointerEvent) => {
    const r = pad.getBoundingClientRect();
    const dx = ev.clientX - (r.left + r.width / 2);
    const dy = ev.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    // the ANGLE keeps working at any finger distance — only the cap's drawn
    // deflection is clamped. All thresholds are CSS px (the feel tier), so
    // the art-to-CSS remake did not change what the finger does.
    const max = maxCss;
    const sector = len < max * DEAD_FRAC ? -1 : (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
    // amplitude → gait: a light tilt WALKS, past RUN_FRAC it RUNS
    setKeys(sector, len >= max * RUN_FRAC);
    // angle snapped, amplitude analog (clamped to the travel radius, drawn
    // damped by CAP_VISUAL_FRAC); the SNAP_MS transition smooths both the
    // octant glide and the radius
    setCap(sector, Math.min(len, max) * CAP_VISUAL_FRAC);
  };
  const release = () => {
    if (!dragging) return;
    dragging = false;
    setKeys(-1, false);
    setCap(-1, 0); // glide back to centre
    // the landscape ghost fades back to rest once the thumb lets go
    if (document.documentElement.classList.contains("ml-land")) pad.style.opacity = "0.25";
    gameAudio.event("ui.release");
  };
  pad.addEventListener("pointerdown", (ev) => {
    dragging = true;
    pad.setPointerCapture(ev.pointerId); // the finger may leave the well — keep it
    // IN USE = fully visible (maintainer 2026-08-05): the landscape ghost
    // fades to 1 while the thumb holds it (opacity transition is always on).
    if (document.documentElement.classList.contains("ml-land")) pad.style.opacity = "1";
    gameAudio.event("ui.press");
    apply(ev);
  });
  pad.addEventListener("pointermove", (ev) => {
    if (dragging) apply(ev);
  });
  pad.addEventListener("pointerup", release);
  pad.addEventListener("pointercancel", release);

  let jumpHeld = false;
  const jumpDown = (ev: PointerEvent) => {
    jump.setPointerCapture(ev.pointerId);
    if (jumpHeld) return;
    jumpHeld = true;
    jump.classList.add("press");
    gameAudio.event("ui.press");
    synthKey("keydown", "SPACE");
  };
  const jumpUp = () => {
    if (!jumpHeld) return;
    jumpHeld = false;
    jump.classList.remove("press");
    synthKey("keyup", "SPACE");
  };
  jump.addEventListener("pointerdown", jumpDown);
  jump.addEventListener("pointerup", jumpUp);
  jump.addEventListener("pointercancel", jumpUp);
  const pickDown = (e: PointerEvent) => {
    e.preventDefault();
    pickup.classList.add("press");
    synthKey("keydown", "F");
  };
  const pickUp = () => {
    pickup.classList.remove("press");
    synthKey("keyup", "F");
  };
  pickup.addEventListener("pointerdown", pickDown);
  pickup.addEventListener("pointerup", pickUp);
  pickup.addEventListener("pointercancel", pickUp);
  // never leave keys stuck if the tab/page goes away mid-drag
  window.addEventListener("blur", () => {
    release();
    jumpUp();
    pickUp();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      release();
      jumpUp();
      pickUp();
    }
  });
}

function mk(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  const s = document.createElement("style");
  s.textContent = `
  /* the WELL: a round surface-2 basin with an inset shade. The OPACITY
     transition is always on (the landscape ghost fades to 1 while the thumb
     holds it); left/top glide ONLY under the transient .anim class, which
     layout() arms for orientation/handedness changes — page entry and plain
     resizes reposition instantly (maintainer 2026-08-05). */
  .ml-pad-stick{position:absolute;border-radius:50%;touch-action:none;cursor:pointer;
    background:var(--surface-2);border:1px solid var(--border-strong);
    box-shadow:inset 0 2px 6px rgba(0,0,0,.12);box-sizing:border-box;
    transition:opacity .25s ease;
    -webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
  .ml-pad-stick.anim{transition:left .25s ease,top .25s ease,opacity .25s ease}
  .ml-pad-jump.anim,.ml-pad-pickup.anim,.ml-pad-label.anim,.ml-pad-blur.anim{
    transition:left .25s ease,top .25s ease}
  /* the ghost stick's backdrop blur — its own disc, see the note at the
     element. Same blur(5px) as the .ml-bars chips; no background of its own,
     so ONLY the blur reads. z 3 keeps it under the stick (4) and therefore
     under the chat log (5) and the pill (8) too. */
  .ml-pad-blur{position:fixed;z-index:3;display:none;border-radius:50%;
    pointer-events:none;
    backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}
  /* the CAP: a raised round knob; the cap glides between its snap positions —
     fast, not instant */
  .ml-pad-top{position:absolute;border-radius:50%;pointer-events:none;box-sizing:border-box;
    background:var(--surface);border:1px solid var(--border-strong);box-shadow:var(--shadow);
    transition:transform ${SNAP_MS}ms ease-out}
  /* JUMP: a round wiki button */
  .ml-pad-pickup{position:absolute;border-radius:50%;touch-action:none;cursor:pointer;
    background:var(--surface);border:1px solid var(--border);box-shadow:var(--shadow);
    box-sizing:border-box}
  .ml-pad-pickup.press{background:var(--surface-2);border-color:var(--border-strong)}
  .ml-pad-jump{position:absolute;border-radius:50%;touch-action:none;cursor:pointer;
    background:var(--surface);border:1px solid var(--border);box-shadow:var(--shadow);
    box-sizing:border-box;padding:0;
    -webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
  .ml-pad-jump.press{background:var(--surface-2);border-color:var(--border-strong);
    transform:translateY(1px);box-shadow:none}
  /* the wiki section-label look — matches the Settings "Ambient effects" header */
  .ml-pad-label{position:absolute;transform:translate(-50%,-100%);
    color:var(--muted);font:600 12px/1.2 var(--sans);letter-spacing:.08em;
    text-transform:uppercase;pointer-events:none;user-select:none}
  /* the one-time handedness tip: an overlay chip, so it can never move the
     controls under it (maintainer) — and pointer-events:none on the BODY so
     it can't eat their input either (on a short viewport the chip can lie
     over the stick; a drag must start on the stick, not on a tooltip). Only
     the × is clickable. */
  .ml-pad-help{position:absolute;left:16px;right:16px;top:10px;z-index:2;
    display:flex;align-items:center;gap:8px;text-align:left;pointer-events:none;
    background:var(--surface);border:1px solid var(--border);border-radius:10px;
    padding:8px 10px;color:var(--muted);font:500 12px/1.4 var(--sans);
    box-shadow:var(--shadow)}
  .ml-pad-help-x{flex:none;width:28px;height:28px;border-radius:8px;cursor:pointer;
    pointer-events:auto;
    background:var(--surface-2);border:1px solid var(--border);color:var(--ink);
    font:600 16px/1 var(--sans);padding:0;
    -webkit-tap-highlight-color:transparent}`;
  document.head.appendChild(s);
}
