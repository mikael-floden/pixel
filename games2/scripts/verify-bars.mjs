// QA: HP/MP bars — mounted top-left, two recoloured fills, animated sweep,
// numbers to the right. Runs at the maintainer's phone geometry.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);
try {
  const ctx = await browser.newContext({
    viewport: { width: 980, height: 2123 }, screen: { width: 393, height: 851 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForSelector(".ml-bars", { timeout: 30000 });

  // structure: two rows, hp=red fill, mp=blue fill, both frames + numbers
  const s = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".ml-bar-row")];
    return rows.map((r) => ({
      fill: r.querySelector(".ml-bar-fill")?.getAttribute("src") || "",
      hasFrame: !!r.querySelector('img[src*="bar-frame"]'),
      num: r.querySelector(".ml-bar-num")?.textContent || "",
    }));
  });
  if (s.length !== 2) fail(`want 2 bar rows, got ${s.length}`);
  else {
    s[0].fill.includes("red") && s[0].hasFrame ? ok("health = red fill over the track") : fail(`hp row ${JSON.stringify(s[0])}`);
    s[1].fill.includes("yellow") && s[1].hasFrame ? ok("mana = yellow fill over the track") : fail(`mp row ${JSON.stringify(s[1])}`);
    /^\d+ \/ \d+ HP$/.test(s[0].num) ? ok(`hp number "${s[0].num}"`) : fail(`hp number "${s[0].num}"`);
    /^\d+ \/ \d+ MP$/.test(s[1].num) ? ok(`mp number "${s[1].num}"`) : fail(`mp number "${s[1].num}"`);
  }

  // the fill sweeps: clip-path inset changes over time, and stays within 0..100
  const readClip = () => page.evaluate(() =>
    [...document.querySelectorAll(".ml-bar-fill")].map((f) => f.style.clipPath));
  const a = await readClip();
  await page.waitForTimeout(1200);
  const b = await readClip();
  a[0] !== b[0] || a[1] !== b[1] ? ok(`fill sweeps (hp ${a[0]} -> ${b[0]})`) : fail("fill not animating");
  const pctOk = [...a, ...b].every((c) => {
    const m = /inset\(0(?:px)? ([\d.]+)% 0(?:px)? 0(?:px)?\)/.exec(c);
    return m && +m[1] >= 0 && +m[1] <= 100;
  });
  pctOk ? ok("clip stays within 0..100%") : fail(`clip out of range: ${[...a, ...b]}`);

  // numbers track the fill: 0% -> "0 / 500", full -> "500 / 500"
  const track = await page.evaluate(() => {
    const f = document.querySelector(".ml-bar-fill");
    const n = document.querySelector(".ml-bar-num");
    const m = /inset\(0(?:px)? ([\d.]+)% 0(?:px)? 0(?:px)?\)/.exec(f.style.clipPath);
    const pct = m ? 1 - +m[1] / 100 : 0;
    const cur = +(/^(\d+)/.exec(n.textContent) || [])[1];
    return { pct, cur, ok: Math.abs(cur - pct * 500) < 12 };
  });
  track.ok ? ok(`number tracks fill (${track.cur} ~ ${(track.pct * 500) | 0})`) : fail(`number/fill mismatch ${JSON.stringify(track)}`);

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
} finally { await browser.close(); }
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
