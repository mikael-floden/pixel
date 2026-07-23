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

  // structure: two rows; frame + fill are 9-sliced into the box (data-URL srcs,
  // like the kit buttons), fill colour tagged via data-color, plus numbers
  const s = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".ml-bar-row")];
    return rows.map((r) => ({
      color: r.querySelector(".ml-bar-fill")?.dataset.color || "",
      imgs: r.querySelectorAll(".ml-bar-gauge img").length,
      fillData: (r.querySelector(".ml-bar-fill")?.getAttribute("src") || "").startsWith("data:"),
      num: r.querySelector(".ml-bar-num")?.textContent || "",
    }));
  });
  if (s.length !== 3) fail(`want 3 bar rows (HP, EP, XP), got ${s.length}`);
  else {
    s[0].color === "red" && s[0].imgs === 2 && s[0].fillData ? ok("health = red 9-sliced fill over the track") : fail(`hp row ${JSON.stringify(s[0])}`);
    s[1].color === "yellow" && s[1].imgs === 2 && s[1].fillData ? ok("energy = yellow 9-sliced fill over the track") : fail(`ep row ${JSON.stringify(s[1])}`);
    s[2].color === "blue" && s[2].imgs === 2 && s[2].fillData ? ok("experience = blue 9-sliced fill over the track") : fail(`xp row ${JSON.stringify(s[2])}`);
    /^\d+ \/ \d+ HP$/.test(s[0].num) ? ok(`hp number "${s[0].num}"`) : fail(`hp number "${s[0].num}"`);
    /^\d+ \/ \d+ EP$/.test(s[1].num) ? ok(`ep number "${s[1].num}"`) : fail(`ep number "${s[1].num}"`);
    /^\d+ \/ \d+ XP$/.test(s[2].num) ? ok(`xp number "${s[2].num}"`) : fail(`xp number "${s[2].num}"`);
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
