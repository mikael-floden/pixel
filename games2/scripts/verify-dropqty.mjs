// BACKPACK QUANTITY verification (maintainer 2026-08-05): "The backpack should
// show a small ×1, ×2, ×3 … symbol on items (lower right corner) … When
// dragging and dropping an item with more than ×1 a popup dialog in the
// game-screen center will appear for the user to input how many … When this
// dialog is open the player can't walk."
// SAME-DAY REFINEMENT: the backdrop DARKENS (a theme wash brightened the light
// theme); no close button (tap outside); no max button (−/+ WRAP AROUND
// instead); −/+ share the item's row; the count is TYPABLE on the number
// keyboard and junk in the box never moves the amount; DROP is full width and
// says so.
//
// Drives the REAL client against a dev stack, at the maintainer's phone
// geometry, and then again rotated — the card centres in the GAME VIEW, which
// is the top 61.8% in portrait and one side column's worth narrower in
// landscape. The backpack is faked through __ml.invFake (the server never
// hands out a ×3 on demand); the SERVER's own clamping lives in
// server/test/combat.review.test.ts.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const OUT = process.env.OUT || "/tmp";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => {
  console.log("FAIL:", m);
  bad = true;
};
const ok = (m) => console.log("ok:", m);

const ctx = await browser.newContext({
  viewport: { width: 393, height: 851 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

/** Poll until two consecutive frames agree — the anchors transition and the
 * starved headless compositor reports mid-flight values (the repo rule). */
const settle = async () => {
  let prev = "";
  for (let i = 0; i < 30; i++) {
    const now = await page.evaluate(() => {
      const r = (s) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return [Math.round(b.left), Math.round(b.top), Math.round(b.width)];
      };
      return JSON.stringify([r(".ml-hud"), r(".ml-qty"), r(".ml-slots")]);
    });
    if (now === prev) return;
    prev = now;
    await page.waitForTimeout(100);
  }
};

/** Geometry of the dialog + the game view it must sit in. */
const geom = () =>
  page.evaluate(() => {
    const r = (s) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return {
        l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top),
        b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height),
      };
    };
    const cs = getComputedStyle(document.documentElement);
    const px = (n) => Math.round(parseFloat(cs.getPropertyValue(n)) || 0);
    return {
      card: r(".ml-qty"),
      back: r(".ml-qty-back"),
      count: document.querySelector(".ml-qty-count")?.value ?? null,
      of: document.querySelector(".ml-qty-of")?.textContent ?? null,
      backZ: (() => {
        const e = document.querySelector(".ml-qty-back");
        return e ? getComputedStyle(e).zIndex : null;
      })(),
      backBg: (() => {
        const e = document.querySelector(".ml-qty-back");
        return e ? getComputedStyle(e).backgroundColor : null;
      })(),
      // the number box: typable on the phone's NUMBER keyboard
      countKind: (() => {
        const e = document.querySelector(".ml-qty-count");
        return e ? { tag: e.tagName, mode: e.inputMode, pattern: e.pattern } : null;
      })(),
      rows: (() => {
        const b = (s) => document.querySelector(s)?.getBoundingClientRect();
        const im = b(".ml-qty-head img");
        const dec = b(".ml-qty-dec");
        const inc = b(".ml-qty-inc");
        const cnt = b(".ml-qty-count");
        const drop = b(".ml-qty-drop");
        // "on the same line" = every one of them overlaps the item icon's
        // band (the count sits a hair high — its "of N" caption rides under
        // it inside the same cell).
        const shares = (x) => !!x && !!im && x.top < im.bottom - 4 && x.bottom > im.top + 4;
        const of = b(".ml-qty-of");
        const card = document.querySelector(".ml-qty")?.getBoundingClientRect();
        return {
          sameLine: shares(dec) && shares(inc) && shares(cnt),
          // "of N" beside the box (not under it), and the box as tall as ±
          ofInline:
            !!of && !!cnt && !!dec && shares(of) && of.left >= cnt.right - 1 &&
            Math.abs(cnt.height - dec.height) <= 2,
          boxH: cnt ? Math.round(cnt.height) : null,
          // item + count hug the LEFT edge, the steppers ride the RIGHT one,
          // adjacent to each other (maintainer 2026-08-05)
          countLeft: !!im && !!cnt && !!card && im.left - card.left < 20 && cnt.left < card.left + card.width / 2,
          steppersRight:
            !!dec && !!inc && !!of && !!card &&
            dec.left > of.right && card.right - inc.right < 20 && inc.left - dec.right < 14,
          decLeftOfInc: !!dec && !!inc && dec.right <= inc.left,
          dropBelow: !!drop && !!im && drop.top >= im.bottom,
          dropFull: !!drop && !!document.querySelector(".ml-qty") &&
            drop.width >= document.querySelector(".ml-qty").getBoundingClientRect().width - 30,
          dropText: document.querySelector(".ml-qty-drop")?.textContent.trim() ?? null,
        };
      })(),
      icons: [...document.querySelectorAll(".ml-qty-btn")].map((b) => ({
        label: b.getAttribute("aria-label"),
        svg: !!b.querySelector("svg"),
        text: b.textContent.trim(),
        off: b.disabled,
      })),
      gv: { l: px("--gv-left"), r: px("--gv-right"), hud: px("--hud-h") },
      vw: window.innerWidth,
      vh: window.innerHeight,
      land: document.documentElement.classList.contains("ml-land"),
    };
  });

/** The centre of slot 0. */
const slot0 = () =>
  page.evaluate(() => {
    const b = document.querySelector(".ml-slot.filled").getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });

/** Click slot 0 the way a player does — a real click. A touch that turns into
 *  a scroll never fires one, which is the whole point of the gesture
 *  (maintainer 2026-09-14). The click TOGGLES, so every caller that wants the
 *  slot selected goes through selectSlot0 instead of clicking blindly. */
const tapSlot0 = async () => {
  const p0 = await slot0();
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.up();
  await settle();
};
const isSel0 = () => page.evaluate(() => !!document.querySelector(".ml-slot.filled")?.classList.contains("sel"));
/** Leave slot 0 SELECTED whatever state it was in. */
const selectSlot0 = async () => {
  if (!(await isSel0())) await tapSlot0();
};

/** Drag slot 0 out of the backpack and release over the game view's middle.
 *  Selects first unless `pre` is false — an UNSELECTED slot must not drag. */
const dragSlotOut = async (pre = true) => {
  if (pre) await selectSlot0();
  const from = await slot0();
  const to = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const px = (n) => parseFloat(cs.getPropertyValue(n)) || 0;
    const l = px("--gv-left");
    const rr = px("--gv-right");
    const hud = px("--hud-h");
    return { x: (l + window.innerWidth - rr) / 2, y: (window.innerHeight - hud) / 2 };
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await settle();
};

/** What the grid shows mid-drag: is there a ghost, and has the source slot
 *  given up its art? Driven with the mouse held down. */
const midDrag = async () => {
  await selectSlot0();
  const from = await slot0();
  const to = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const px = (n) => parseFloat(cs.getPropertyValue(n)) || 0;
    return { x: (px("--gv-left") + window.innerWidth - px("--gv-right")) / 2,
             y: (window.innerHeight - px("--hud-h")) / 2 };
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  const g = await page.evaluate(() => {
    const c = document.querySelector(".ml-slot.filled");
    const img = c.querySelector("img"), b = c.querySelector("b");
    const vis = (e) => (e ? getComputedStyle(e).visibility : null);
    return { ghosts: document.querySelectorAll(".ml-slot-ghost").length,
             art: vis(img), badge: vis(b), sel: c.classList.contains("sel"),
             box: Math.round(c.getBoundingClientRect().height) };
  });
  await page.mouse.up();
  await settle();
  // close whatever the release opened, so the caller starts clean
  await page.evaluate(() => {
    const back = document.querySelector(".ml-qty-back");
    if (back) { const b = back.getBoundingClientRect();
      back.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: b.left + 8, clientY: b.top + 8 })); }
  });
  await settle();
  return g;
};

const clickQty = async (label) => {
  await page.evaluate(
    (l) => document.querySelector(`.ml-qty-btn[aria-label="${l}"]`)?.click(),
    label,
  );
  await page.waitForTimeout(80);
};

try {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 30000 });
  await page.waitForTimeout(600);

  // ---- 1. the badge: EVERY filled slot prints its count, ×1 included ----
  await page.evaluate(() => document.querySelector('[data-tab="backpack"]').click());
  await page.evaluate(() =>
    window.__ml.invFake([
      { item: "green_slime_glob", n: 3 },
      { item: "smooth_river_stone", n: 1 },
    ]),
  );
  await settle();
  const badges = await page.evaluate(() =>
    [...document.querySelectorAll(".ml-slot.filled")].map((c) => {
      const b = c.querySelector("b");
      const cell = c.getBoundingClientRect();
      const box = b?.getBoundingClientRect();
      return {
        text: b?.textContent ?? null,
        // lower-RIGHT corner of its own slot
        corner: box ? box.right <= cell.right + 1 && box.bottom <= cell.bottom + 1 &&
          box.right > cell.left + cell.width / 2 && box.bottom > cell.top + cell.height / 2 : false,
      };
    }),
  );
  badges.length === 2 && badges.every((b) => /^×\d+$/.test(b.text ?? ""))
    ? ok(`every filled slot badges its count (${badges.map((b) => b.text).join(", ")})`)
    : fail(`badges wrong: ${JSON.stringify(badges)}`);
  badges.some((b) => b.text === "×1")
    ? ok("…including a lone item (×1)")
    : fail(`no ×1 badge: ${JSON.stringify(badges)}`);
  badges.every((b) => b.corner)
    ? ok("badges sit in each slot's lower-right corner")
    : fail(`badge placement: ${JSON.stringify(badges)}`);

  // ---- 1b. SELECT, THEN DRAG (maintainer 2026-09-14: "it's hard to scroll in
  //          the backpack because I always drag an item by mistake … you must
  //          first select the item"). The regression that protects his scroll
  //          is the FIRST one: an unselected slot must not lift anything, and
  //          it must leave the touch to the page. ----
  const noTouchAction = await page.evaluate(() => {
    const c = document.querySelector(".ml-slot.filled");
    return { unsel: getComputedStyle(c).touchAction, sel: c.classList.contains("sel") };
  });
  !noTouchAction.sel && noTouchAction.unsel !== "none"
    ? ok(`an unselected slot leaves the touch to the scroller (touch-action: ${noTouchAction.unsel})`)
    : fail(`unselected slot is still grabbing the gesture: ${JSON.stringify(noTouchAction)}`);
  await dragSlotOut(false); // drag WITHOUT selecting first
  const stray = await page.evaluate(() => ({
    dialog: !!document.querySelector(".ml-qty-back"),
    ghosts: document.querySelectorAll(".ml-slot-ghost").length,
  }));
  !stray.dialog && stray.ghosts === 0
    ? ok("dragging an UNSELECTED slot lifts nothing — no ghost, no drop dialog")
    : fail(`an unselected slot still dragged: ${JSON.stringify(stray)}`);
  await selectSlot0();
  const picked = await page.evaluate(() => {
    const cells = [...document.querySelectorAll(".ml-slot.filled")];
    const c = cells[0], cs = getComputedStyle(c);
    return { sel: c.classList.contains("sel"), touch: cs.touchAction,
             others: cells.filter((x) => x.classList.contains("sel")).length,
             bg: cs.backgroundColor, border: cs.borderColor,
             accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() };
  });
  picked.sel && picked.others === 1
    ? ok("a click selects exactly one slot")
    : fail(`click did not select one slot: ${JSON.stringify(picked)}`);
  picked.touch === "none"
    ? ok("…and the selected slot takes the gesture (touch-action: none)")
    : fail(`selected slot touch-action ${picked.touch}, wanted none`);
  picked.bg !== "rgba(0, 0, 0, 0)" && picked.border !== picked.bg
    ? ok(`…and it is highlighted (${picked.bg} on ${picked.border})`)
    : fail(`the selected slot is not highlighted: ${JSON.stringify(picked)}`);
  // THE LIFTED ITEM LEAVES ITS SLOT (his second ask, measured mid-drag)
  const held = await midDrag();
  held.ghosts === 1
    ? ok("a drag from the selected slot lifts one ghost onto the finger")
    : fail(`${held.ghosts} ghosts mid-drag, wanted 1`);
  held.art === "hidden" && held.badge === "hidden"
    ? ok("…and the slot it came from shows neither art nor badge")
    : fail(`the item is still in its slot mid-drag (art ${held.art}, badge ${held.badge})`);
  held.box > 0
    ? ok(`…while the cell keeps its size (${held.box}px — the grid never reflows under the finger)`)
    : fail("the source cell collapsed mid-drag");
  held.sel
    ? ok("…and keeps its outline, so you can see where the item came from")
    : fail("the source slot lost its selection mid-drag");
  // tapping the selected slot again puts it down
  await selectSlot0(); // make sure it is up first (a drag may have cleared it)
  await tapSlot0();
  const selLeft = await page.evaluate(() => document.querySelectorAll(".ml-slot.sel").length);
  selLeft === 0
    ? ok("tapping it again clears the selection")
    : fail(`a second tap left ${selLeft} slot(s) selected`);

  // ---- 2. a ×1 slot ALSO asks — the dialog doubles as the drop CONFIRM
  //         (maintainer: "we want it for dropping 1 item … as well") ----
  await page.evaluate(() => window.__ml.invFake([{ item: "smooth_river_stone", n: 1 }]));
  await settle();
  await dragSlotOut();
  const lone = await page.evaluate(() => {
    const back = document.querySelector(".ml-qty-back");
    return back
      ? { open: true, n: document.querySelector(".ml-qty-count").value, of: document.querySelector(".ml-qty-of").textContent }
      : { open: false };
  });
  lone.open && lone.n === "1" && /of 1$/.test(lone.of ?? "")
    ? ok(`dragging a lone item asks for confirmation (×${lone.n} ${lone.of})`)
    : fail(`×1 drag: ${JSON.stringify(lone)}`);
  // close it again (tap outside) before the stack case
  await page.evaluate(() => {
    const b = document.querySelector(".ml-qty-back").getBoundingClientRect();
    document.querySelector(".ml-qty-back").dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientX: b.left + 8, clientY: b.top + 8 }),
    );
  });
  await page.waitForTimeout(150);

  // ---- 3. a ×N slot ASKS: the centred card, icon buttons, movement frozen ----
  await page.evaluate(() => window.__ml.invFake([{ item: "green_slime_glob", n: 5 }]));
  await settle();
  await dragSlotOut();
  let g = await geom();
  if (!g.card) fail("no quantity dialog after dragging a ×5 stack out");
  else {
    ok("dragging a ×5 stack opens the quantity dialog");
    const gvL = g.gv.l;
    const gvR = g.vw - g.gv.r;
    const gvB = g.vh - g.gv.hud;
    const cx = (g.card.l + g.card.r) / 2;
    const cy = (g.card.t + g.card.b) / 2;
    // horizontally centred; vertically at 45% of the game view — a hair high,
    // so the number keyboard clears the box without the card ever moving.
    Math.abs(cx - (gvL + gvR) / 2) <= 3 && Math.abs(cy - gvB * 0.45) <= 3
      ? ok(`card at 45% of the game view (${Math.round(cx)},${Math.round(cy)} of ${gvL}..${gvR} × 0..${gvB})`)
      : fail(`card misplaced: ${JSON.stringify(g.card)}, want cy≈${Math.round(gvB * 0.45)} in ${gvL}..${gvR} × 0..${gvB}`);
    g.card.l >= gvL && g.card.r <= gvR && g.card.b <= gvB
      ? ok("…and stays inside it")
      : fail(`card spills out of the game view: ${JSON.stringify(g.card)}`);
    g.count === "1" && /5/.test(g.of ?? "")
      ? ok(`opens at 1 of the stack (×${g.count} ${g.of})`)
      : fail(`opening state wrong: ${g.count} / ${g.of}`);
    const labels = g.icons.map((i) => i.label).sort();
    JSON.stringify(labels) === JSON.stringify(["drop", "fewer", "more"])
      ? ok(`three controls, no cancel and no max: ${labels.join(", ")}`)
      : fail(`controls are ${JSON.stringify(labels)}`);
    g.icons.filter((i) => i.label !== "drop").every((i) => i.svg && i.text === "")
      ? ok("the steppers are icon-only")
      : fail(`a stepper is wrong: ${JSON.stringify(g.icons)}`);
    g.icons.every((i) => i.label !== "drop" || (!i.svg && /drop/i.test(i.text)))
      ? ok("…and DROP is the WORD alone, no icon")
      : fail(`drop button wrong: ${JSON.stringify(g.icons)}`);
    +g.backZ >= 60
      ? ok(`backdrop above every other overlay (z ${g.backZ})`)
      : fail(`backdrop z ${g.backZ} — the slot ghost is 60`);
    // DARKENS, in both themes (maintainer): a near-black wash, not a tint of
    // the theme's own background (which brightened the light theme).
    {
      const m = /rgba?\(([^)]+)\)/.exec(g.backBg ?? "");
      const [r0, g0, b0] = m ? m[1].split(",").map((v) => parseFloat(v)) : [255, 255, 255];
      r0 < 60 && g0 < 60 && b0 < 60
        ? ok(`backdrop darkens the world (${g.backBg})`)
        : fail(`backdrop is not a darkening wash: ${g.backBg}`);
    }
    // ONE ROW: item + count LEFT, −/+ together RIGHT — DROP full width under.
    g.rows.sameLine && g.rows.decLeftOfInc
      ? ok("item, count, − and + share one line")
      : fail(`head row wrong: ${JSON.stringify(g.rows)}`);
    g.rows.countLeft && g.rows.steppersRight
      ? ok("item + count hug the left edge, the steppers ride the right")
      : fail(`row alignment wrong: ${JSON.stringify(g.rows)}`);
    g.rows.ofInline
      ? ok(`"of N" sits on that line too, and the box matches the buttons (${g.rows.boxH}px)`)
      : fail(`"of N" or the box height is off: ${JSON.stringify(g.rows)}`);
    g.rows.dropBelow && g.rows.dropFull && /drop/i.test(g.rows.dropText ?? "")
      ? ok(`DROP spans the card underneath and says so ("${g.rows.dropText}")`)
      : fail(`drop button wrong: ${JSON.stringify(g.rows)}`);
    g.countKind?.tag === "INPUT" && g.countKind.mode === "numeric"
      ? ok(`the count is typable on the number keyboard (${JSON.stringify(g.countKind)})`)
      : fail(`count is not a numeric input: ${JSON.stringify(g.countKind)}`);
  }
  // the player CAN'T WALK while it is open — both halves of the lock
  (await page.evaluate(() => window.__ml.canWalk() === false))
    ? ok("movement is frozen while the dialog is open")
    : fail("player can still walk with the dialog open");
  const hit = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const px = (n) => parseFloat(cs.getPropertyValue(n)) || 0;
    const x = (px("--gv-left") + window.innerWidth - px("--gv-right")) / 2;
    const y = (window.innerHeight - px("--hud-h")) * 0.25;
    const e = document.elementFromPoint(x, y);
    return e ? e.className || e.tagName : null;
  });
  /ml-qty-back/.test(String(hit))
    ? ok("the backdrop swallows taps on the world (no tap-to-move behind it)")
    : fail(`a tap over the game view hits "${hit}", not the backdrop`);
  await page.screenshot({ path: `${OUT}/dropqty-portrait.png` });

  // ---- 4. the counter: −/+ step and WRAP AROUND (there is no max button) ----
  const shown = () => page.evaluate(() => document.querySelector(".ml-qty-count").value);
  await clickQty("more");
  await clickQty("more");
  (await shown()) === "3"
    ? ok("more steps the count up")
    : fail(`after two "more" the count is ${await shown()}`);
  await clickQty("fewer");
  (await shown()) === "2"
    ? ok("fewer steps it back down")
    : fail("fewer did not step down");
  await clickQty("fewer");
  (await shown()) === "1" ? ok("…down to 1") : fail(`expected 1, got ${await shown()}`);
  await clickQty("fewer");
  (await shown()) === "5"
    ? ok("fewer WRAPS from 1 to the whole stack (what replaced the max button)")
    : fail(`no wrap below 1: ${await shown()}`);
  await clickQty("more");
  (await shown()) === "1"
    ? ok("…and more wraps from the top back to 1")
    : fail(`no wrap above the stack: ${await shown()}`);

  // ---- 5. TYPING a number, and junk that must not move the amount ----
  // Tapping the box CLEARS it, so the number is typed straight in (maintainer).
  const cleared = await page.evaluate(() => {
    const e = document.querySelector(".ml-qty-count");
    const before = e.value;
    e.focus();
    return { before, after: e.value };
  });
  cleared.before !== "" && cleared.after === ""
    ? ok(`focusing the box clears it ("${cleared.before}" → empty)`)
    : fail(`box not cleared on focus: ${JSON.stringify(cleared)}`);
  await page.keyboard.type("4");
  (await shown()) === "4" ? ok("the count accepts a typed number") : fail(`typed 4, box shows ${await shown()}`);
  // out of range and non-numeric are both refused — the amount holds at 4,
  // and leaving the box repaints it.
  for (const junk of ["9", "0", "abc", ""]) {
    await page.evaluate(() => document.querySelector(".ml-qty-count").focus());
    if (junk) await page.keyboard.type(junk);
    else await page.keyboard.press("Backspace");
    await page.evaluate(() => document.querySelector(".ml-qty-count").blur());
    await page.waitForTimeout(60);
    const back = await shown();
    back === "4"
      ? ok(`"${junk || "(empty)"}" left the amount alone (${back})`)
      : fail(`"${junk}" moved the amount to ${back}, want 4`);
  }

  // ---- 6. tapping OUTSIDE closes it and hands movement back (no cancel
  //         button) — and the CANCEL TAP MUST NOT BECOME A WALK-TO
  //         (maintainer 2026-08-05: "press outside the dialog and the player
  //         will run to that location"). Phaser's window-level listeners
  //         process events whose target is not the canvas, so a DOM overlay
  //         tap reached the world's tap-to-move. Driven with a REAL mouse
  //         gesture over the game view, and the player must not budge. ----
  const before = await page.evaluate(() => {
    const m = window.__ml.me();
    return { x: m.x, y: m.y };
  });
  const spot = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const px = (n) => parseFloat(cs.getPropertyValue(n)) || 0;
    return {
      x: (px("--gv-left") + window.innerWidth - px("--gv-right")) / 2,
      y: (window.innerHeight - px("--hud-h")) * 0.2, // well inside the world
    };
  });
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(1200); // long enough for a trip to visibly start
  const afterCancel = await page.evaluate(() => ({
    open: !!document.querySelector(".ml-qty-back"),
    walk: window.__ml.canWalk(),
    target: window.__ml.target?.() ?? null,
    me: (() => {
      const m = window.__ml.me();
      return { x: m.x, y: m.y };
    })(),
  }));
  !afterCancel.open && afterCancel.walk
    ? ok("a tap outside the card closes the dialog and unfreezes the player")
    : fail(`after tapping outside: ${JSON.stringify({ open: afterCancel.open, walk: afterCancel.walk })}`);
  const drift = Math.hypot(afterCancel.me.x - before.x, afterCancel.me.y - before.y);
  drift < 4 && !afterCancel.target
    ? ok(`…and the cancel tap did NOT become a walk-to (drift ${drift.toFixed(1)}wu, no trip target)`)
    : fail(`cancelling the drop walked the player: drift ${drift.toFixed(1)}wu, target ${JSON.stringify(afterCancel.target)}`);

  // ---- 7. drop closes it too (the server's own clamping is unit-tested) ----
  await dragSlotOut();
  await clickQty("more");
  await clickQty("drop");
  await page.waitForTimeout(200);
  const afterDrop = await page.evaluate(() => ({
    open: !!document.querySelector(".ml-qty-back"),
    walk: window.__ml.canWalk(),
  }));
  !afterDrop.open && afterDrop.walk
    ? ok("drop closes the dialog and unfreezes the player")
    : fail(`after drop: ${JSON.stringify(afterDrop)}`);

  // ---- 8. LANDSCAPE: the card follows the game view off the menu column ----
  await page.setViewportSize({ width: 851, height: 393 });
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-tab="backpack"]').click());
  await page.evaluate(() => window.__ml.invFake([{ item: "green_slime_glob", n: 4 }]));
  await settle();
  await dragSlotOut();
  g = await geom();
  if (!g.land) fail("landscape layout did not engage at 851x393");
  else if (!g.card) fail("no quantity dialog in landscape");
  else {
    const gvL = g.gv.l;
    const gvR = g.vw - g.gv.r;
    const cx = (g.card.l + g.card.r) / 2;
    const cy = (g.card.t + g.card.b) / 2;
    Math.abs(cx - (gvL + gvR) / 2) <= 3 && g.card.l > gvL && g.card.b <= g.vh
      ? ok(`landscape card centred in the game view (${Math.round(cx)} of ${gvL}..${gvR}), clear of the menu column`)
      : fail(`landscape card ${JSON.stringify(g.card)} vs game view ${gvL}..${gvR}`);
    // …and a step HIGHER than portrait's 45% — the keyboard takes a bigger
    // share of a ~393px-tall view (maintainer 2026-08-05).
    Math.abs(cy - (g.vh - g.gv.hud) * 0.4) <= 3
      ? ok(`landscape card at 40% of the view height (y ${Math.round(cy)} of ${g.vh})`)
      : fail(`landscape card at y ${cy}, want ${Math.round((g.vh - g.gv.hud) * 0.4)}`);
    g.card.h <= g.vh - 20
      ? ok(`card fits the short viewport (${g.card.h}px of ${g.vh})`)
      : fail(`card ${g.card.h}px tall on a ${g.vh}px viewport`);
  }
  await page.screenshot({ path: `${OUT}/dropqty-landscape.png` });

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
} catch (e) {
  fail(`threw: ${e.message}`);
} finally {
  await browser.close();
}
console.log(bad ? "verify-dropqty: FAILED" : "verify-dropqty: OK");
process.exit(bad ? 1 : 0);
