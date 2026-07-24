// QA: HUD Chat tab — the persistent message history that mirrors the on-screen
// chat (bottom-left log). Drives the maintainer's phone geometry and checks the
// eight requirements:
//   1. same stream as the on-screen log (system events + player chat)
//   2. keeps the last 1000 lines (oldest dropped past that)
//   3. each line prints its receive time as HH:MM
//   4. a day divider (YYYY-MM-DD) appears when the real-clock day changes
//   5. the divider LOOKS LIKE the Settings section header (.ml-amb-title)
//   6. the FIRST message starts with a date divider
//   7. a full-width input at the bottom you click to write a message
//   8. that input actually sends (server round-trip back into the log)
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);

async function enter(page, world) {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate((w) => {
    const i = window.__mlSelect.worlds().indexOf(w);
    if (i >= 0) window.__mlSelect.pickWorld(i);
  }, world);
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForSelector(".ml-tabrow .ml-tab", { timeout: 30000 });
  // the __ml debug object appears once the local player has joined
  await page.waitForFunction(() => window.__ml && typeof window.__ml.chatPush === "function", { timeout: 30000 });
}
const openChat = (page) => page.click('.ml-tab[data-tab="chat"]');
// read the rendered chat log: ordered rows of {kind:"day"|"line", ...}
const readLog = (page) => page.evaluate(() => {
  const log = document.querySelector(".ml-chat-log");
  if (!log) return null;
  const rows = [...log.children].map((el) => {
    if (el.classList.contains("ml-chat-day")) return { kind: "day", text: el.textContent };
    if (el.classList.contains("ml-chat-line")) {
      const time = el.querySelector(".ml-chat-time")?.textContent ?? "";
      const who = el.querySelector(".ml-chat-who")?.textContent ?? "";
      return { kind: "line", time, who, text: el.textContent };
    }
    return { kind: "other", text: el.textContent };
  });
  return { rows, lines: rows.filter((r) => r.kind === "line").length, days: rows.filter((r) => r.kind === "day").length };
});

try {
  const ctx = await browser.newContext({
    viewport: { width: 980, height: 2123 }, screen: { width: 393, height: 851 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    timezoneId: "Europe/Stockholm", // deterministic day boundaries for the divider test
  });
  const page = await ctx.newPage();
  await enter(page, "ring_test");
  await openChat(page);
  await page.waitForSelector(".ml-chat-log", { timeout: 10000 });

  // ── the input: inset from the rails, wide, centered, at the bottom ──
  const inp = await page.evaluate(() => {
    const wrap = document.querySelector(".ml-chat");
    const log = document.querySelector(".ml-chat-log");
    const el = document.querySelector(".ml-chat-input");
    if (!wrap || !log || !el) return null;
    const wr = wrap.getBoundingClientRect(), er = el.getBoundingClientRect(), lr = log.getBoundingClientRect();
    const leftGap = er.left - wr.left, rightGap = wr.right - er.right;
    return {
      exists: true, maxLength: el.maxLength, placeholder: el.placeholder,
      leftGap, rightGap,
      inset: leftGap > 12 && rightGap > 12,          // clears the vine rails both sides
      centered: Math.abs(leftGap - rightGap) <= 2,   // equal L/R space
      wide: er.width > wr.width * 0.6,               // still a wide box
      belowLog: er.top >= lr.bottom - 2,             // pinned under the scrolling log
    };
  });
  inp && inp.exists ? ok("chat input present") : fail(`no chat input (${JSON.stringify(inp)})`);
  inp && inp.maxLength === 140 ? ok("input maxLength = MAX_CHAT_LEN (140)") : fail(`maxLength ${inp?.maxLength}`);
  inp && inp.placeholder === "say something…" ? ok("input placeholder matches") : fail(`placeholder "${inp?.placeholder}"`);
  inp && inp.inset && inp.centered ? ok(`input inset from the rails (L=${inp.leftGap.toFixed(0)} R=${inp.rightGap.toFixed(0)})`) : fail(`input not inset/centered (${JSON.stringify(inp)})`);
  inp && inp.wide ? ok("input still spans most of the width") : fail(`input too narrow (${JSON.stringify(inp)})`);
  inp && inp.belowLog ? ok("input sits below the log (bottom)") : fail("input not at the bottom");

  // ── keyboard: overlaysContent keeps the world+HUD FIXED (keyboard drawn on top,
  //    no scroll/reflow); only the focused input detaches and floats up. The
  //    viewport meta must NOT force resizes-visual (that scrolls the whole game). ──
  const meta = await page.evaluate(() => document.querySelector('meta[name=viewport]')?.getAttribute("content") || "");
  !/interactive-widget/.test(meta)
    ? ok("viewport meta leaves the keyboard to overlaysContent (no forced scroll)") : fail(`viewport meta forces interactive-widget: ${meta}`);
  const vk = await page.evaluate(() => {
    const api = navigator.virtualKeyboard;
    return { present: !!api, overlays: api ? api.overlaysContent : null };
  });
  vk.present
    ? (vk.overlays === true ? ok("VirtualKeyboard overlaysContent enabled (game stays put)") : fail(`overlaysContent=${vk.overlays}`))
    : ok("VirtualKeyboard API absent (skipped — non-Chromium)");
  // lift: while a chat input is focused AND the keyboard is up (.ml-kb-up +
  // --ml-kb from visualViewport), the input floats fixed at bottom = keyboard
  // height, ANIMATED (transition on bottom) so it isn't a snap. No real keyboard
  // headless, so drive --ml-kb + the class; without the class it stays in flow.
  const down = await page.evaluate(() => {
    const el = document.querySelector(".ml-chat-input");
    el.focus();
    return getComputedStyle(el).position; // keyboard down → in-HUD flow
  });
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--ml-kb", "300px");
    document.documentElement.classList.add("ml-kb-up"); // keyboard up (300px tall)
  });
  await page.waitForTimeout(280); // let the bottom-transition settle before measuring
  const up = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".ml-chat-input"));
    return { position: cs.position, bottom: cs.bottom, tprop: cs.transitionProperty, tdur: cs.transitionDuration };
  });
  const after = await page.evaluate(() => {
    const el = document.querySelector(".ml-chat-input");
    document.documentElement.classList.remove("ml-kb-up");
    document.documentElement.style.removeProperty("--ml-kb");
    const p = getComputedStyle(el).position; // keyboard down again
    el.blur();
    return p;
  });
  down !== "fixed" && up.position === "fixed" && after !== "fixed"
    ? ok(`input lifts (fixed) only while keyboard up (${down}->${up.position}->${after})`)
    : fail(`lift wrong: down=${down} up=${up.position} after=${after}`);
  Math.abs(parseFloat(up.bottom) - 310) < 3
    ? ok(`input rides just above the keyboard (bottom=${up.bottom} at kb=300)`) : fail(`input bottom ${up.bottom} != ~310px`);
  /bottom|all/.test(up.tprop) && parseFloat(up.tdur) > 0
    ? ok(`lift is animated, not snapped (transition ${up.tprop} ${up.tdur})`) : fail(`no bottom transition (${up.tprop} ${up.tdur})`);

  // ── req 1 (system side) + req 6: on login the world logs system events
  //    immediately (time-of-day sync, the join "star"). Wait for one, then the
  //    FIRST row must be a date divider (so the first message shows its date). ──
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".ml-chat-line .ml-chat-who")]
      .some((w) => /^(—|⭐)/.test(w.textContent || "")),
    { timeout: 10000 }).catch(() => {});
  const login = await readLog(page);
  const sysLine = login?.rows.find((r) => r.kind === "line" && /^(—|⭐)/.test(r.who));
  sysLine ? ok(`system message shown on login ("${sysLine.who.trim()} …")`) : fail(`no system message on login: ${JSON.stringify(login)}`);
  login && login.rows[0]?.kind === "day" && /^\d{4}-\d{2}-\d{2}$/.test(login.rows[0].text)
    ? ok(`first message on login starts with a date divider (${login.rows[0].text})`)
    : fail(`first login row is not a date divider: ${JSON.stringify(login?.rows[0])}`);

  // ── keyboard leak guard: a keydown in the input must NOT bubble to window
  //    (Phaser's WASD listener lives there) — stopPropagation like ChatUI. ──
  const leaked = await page.evaluate(() => {
    let hits = 0;
    const h = () => hits++;
    window.addEventListener("keydown", h);
    const el = document.querySelector(".ml-chat-input");
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "w", bubbles: true, cancelable: true }));
    window.removeEventListener("keydown", h);
    el.blur();
    return hits;
  });
  leaked === 0 ? ok("movement keys don't leak past the input") : fail(`keydown leaked to window (${leaked}x)`);

  // ── req 1 + 3 + 6: real path. Send a chat via __ml.say → the server
  //    broadcasts it back → WorldScene.addLog → onLog → the Chat page. ──
  await page.evaluate(() => window.__ml.say("hello from qa"));
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".ml-chat-line")].some((l) => l.textContent.includes("hello from qa")),
    { timeout: 8000 }).catch(() => {});
  let s = await readLog(page);
  const real = s?.rows.find((r) => r.kind === "line" && r.text.includes("hello from qa"));
  real ? ok(`player chat mirrored to the page ("${real.who}…")`) : fail("player chat not mirrored");
  real && /^\d{2}:\d{2}$/.test(real.time) ? ok(`line shows HH:MM time (${real.time})`) : fail(`bad time "${real?.time}"`);
  real && real.who.trim().length > 1 ? ok("line shows sender name") : fail(`no sender ("${real?.who}")`);
  // req 6: the very first row is a date divider
  s && s.rows[0]?.kind === "day" && /^\d{4}-\d{2}-\d{2}$/.test(s.rows[0].text)
    ? ok(`first row is a date divider (${s.rows[0].text})`) : fail(`first row not a divider: ${JSON.stringify(s?.rows[0])}`);

  // ── req 5: the divider LOOKS LIKE the Settings header (.ml-amb-title) ──
  const look = await page.evaluate(() => {
    const key = (el) => {
      const c = getComputedStyle(el);
      // include text-shadow: .ml-chat-log sets one that inherits, so the divider
      // must reset it to truly match the (shadowless) Settings header.
      return { bt: c.borderTopWidth, bs: c.borderTopStyle, ta: c.textAlign, tt: c.textTransform, ls: c.letterSpacing, sh: c.textShadow };
    };
    const day = document.querySelector(".ml-chat-day");
    const title = document.querySelector(".ml-amb-title");
    return day && title ? { day: key(day), title: key(title) } : null;
  });
  if (!look) fail("could not compare divider styles");
  else {
    const same = ["bt", "bs", "ta", "tt", "ls", "sh"].filter((k) => look.day[k] !== look.title[k]);
    same.length === 0 ? ok(`divider matches Settings header style (${JSON.stringify(look.day)})`)
      : fail(`divider style differs on ${same.join(",")}: ${JSON.stringify(look)}`);
  }

  // ── req 4: a NEW-DAY divider between two lines on different real days. Push
  //    at controlled times (local noon, two adjacent days — no midnight edge). ──
  const dd = await page.evaluate(() => {
    const t1 = new Date(2026, 0, 15, 12, 0, 0).getTime();
    const t2 = new Date(2026, 0, 16, 12, 0, 0).getTime();
    window.__ml.chatPush("Alma", "day-one line", t1);
    window.__ml.chatPush("Bo", "day-two line", t2);
    const f = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
    return { d1: f(t1), d2: f(t2) };
  });
  s = await readLog(page);
  const i1 = s.rows.findIndex((r) => r.kind === "line" && r.text.includes("day-one line"));
  const i2 = s.rows.findIndex((r) => r.kind === "line" && r.text.includes("day-two line"));
  const divBetween = i1 >= 0 && i2 > i1 && s.rows.slice(i1 + 1, i2).some((r) => r.kind === "day" && r.text === dd.d2);
  divBetween ? ok(`new-day divider (${dd.d2}) sits between the two days`) : fail(`no day divider between lines: ${JSON.stringify(s.rows.slice(Math.max(0,i1), i2 + 1))}`);
  s.rows.some((r) => r.kind === "day" && r.text === dd.d1) ? ok(`day-one divider present (${dd.d1})`) : fail(`missing ${dd.d1} divider`);

  // ── req 2: cap at 1000, oldest dropped. Bulk-push while the tab is hidden
  //    (no per-push render), then reopen for one render. ──
  await page.click('.ml-tab[data-tab="settings"]');
  await page.evaluate(() => {
    for (let i = 0; i < 1100; i++) window.__ml.chatPush("Bulk", `bulk-${i}`, Date.now());
  });
  await openChat(page);
  await page.waitForTimeout(200);
  const cap = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".ml-chat-line")].map((l) => l.textContent);
    return {
      count: lines.length,
      hasFirst: lines.some((t) => t.includes("hello from qa")),
      hasBulk0: lines.some((t) => /(^|\s)bulk-0($|:|\s)/.test(t)),
      hasBulkLast: lines.some((t) => t.includes("bulk-1099")),
    };
  });
  cap.count === 1000 ? ok(`history capped at exactly 1000 lines`) : fail(`line count ${cap.count} (want 1000)`);
  !cap.hasFirst ? ok("oldest lines dropped past the cap") : fail("oldest line survived the cap");
  cap.hasBulkLast && !cap.hasBulk0 ? ok("newest kept, oldest bulk dropped") : fail(`cap window wrong (last=${cap.hasBulkLast} bulk0=${cap.hasBulk0})`);

  // ── scroll preservation: scrolled UP reading history, an arriving line must
  //    NOT yank the view to the top (the rebuild wipe resets scrollTop to 0). ──
  const scr = await page.evaluate(() => {
    const log = document.querySelector(".ml-chat-log");
    log.scrollTop = 300;              // 1000 lines → well within range, not near bottom
    const before = log.scrollTop, max = log.scrollHeight - log.clientHeight;
    window.__ml.chatPush("Zed", "scroll-preserve probe", Date.now()); // renderChat(false)
    return { before, after: log.scrollTop, max };
  });
  scr.before > 100 && scr.max > 400 && Math.abs(scr.after - scr.before) < 60
    ? ok(`scroll position held on a new line (${scr.before} -> ${scr.after})`)
    : fail(`scroll not held (before=${scr.before} after=${scr.after} max=${scr.max})`);

  // ── req 7/8: type in the box + Enter → it round-trips through the server
  //    back into the log (proves the input actually sends). ──
  const marker = "qa-send-token";
  await page.evaluate((m) => {
    const el = document.querySelector(".ml-chat-input");
    el.focus(); el.value = m;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  }, marker);
  const sent = await page.waitForFunction((m) =>
    [...document.querySelectorAll(".ml-chat-line")].some((l) => l.textContent.includes(m)),
    marker, { timeout: 8000 }).then(() => true).catch(() => false);
  sent ? ok("typing + Enter sends a chat that returns to the log") : fail("input did not send / round-trip");
  const cleared = await page.evaluate(() => document.querySelector(".ml-chat-input").value);
  cleared === "" ? ok("input clears after send") : fail(`input not cleared ("${cleared}")`);
} finally { await browser.close(); }
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
