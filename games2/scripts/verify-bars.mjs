// QA: HP/Energy/XP bars — HP+Energy top-left, XP top-right; STATIC placeholder
// values (HP 10/10 full, Energy 0/0 empty, XP 0/10 empty), no animation
// (maintainer 2026-07-23). Runs at the maintainer's phone geometry.
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
    s[0].num === "10 / 10 HP" ? ok(`hp number "${s[0].num}"`) : fail(`hp number "${s[0].num}" (want "10 / 10 HP")`);
    s[1].num === "0 / 0 EP" ? ok(`ep number "${s[1].num}"`) : fail(`ep number "${s[1].num}" (want "0 / 0 EP")`);
    s[2].num === "0 / 10 XP" ? ok(`xp number "${s[2].num}"`) : fail(`xp number "${s[2].num}" (want "0 / 10 XP")`);
  }

  // STATIC fills: HP full, Energy + XP empty; the clip must NOT change over time
  // (the demo animation was removed). fill% = 100 - inset-right%.
  const readClip = () => page.evaluate(() =>
    [...document.querySelectorAll(".ml-bar-fill")].map((f) => f.style.clipPath));
  const pctOf = (c) => {
    const m = /inset\(0(?:px)? ([\d.]+)% 0(?:px)? 0(?:px)?\)/.exec(c || "");
    return m ? 100 - +m[1] : NaN;
  };
  const a = await readClip();
  await page.waitForTimeout(1200);
  const b = await readClip();
  a.every((c, i) => c === b[i]) ? ok("fills are static (no animation)") : fail(`fill still animating: ${a} -> ${b}`);
  const pa = a.map(pctOf);
  Math.abs(pa[0] - 100) < 1 ? ok(`hp full (${pa[0]}%)`) : fail(`hp fill ${pa[0]}% (want 100)`);
  Math.abs(pa[1] - 0) < 1 ? ok(`energy empty (${pa[1]}%)`) : fail(`ep fill ${pa[1]}% (want 0)`);
  Math.abs(pa[2] - 0) < 1 ? ok(`experience empty (${pa[2]}%)`) : fail(`xp fill ${pa[2]}% (want 0)`);

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
} finally { await browser.close(); }
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
