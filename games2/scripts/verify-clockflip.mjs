// 360-wheel clock verification: the wheel+hand layer sits BEHIND the frame,
// and each day/night hand-off ROTATES the assembly +180° (no teleport) —
// night shows the night face, morning/day/evening the day face.
// Drives the REAL client headlessly against a dev stack.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const OUT = process.env.OUT || "/tmp";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const fail = (m) => {
  throw new Error(m);
};
try {
  const ctx = await browser.newContext({
    viewport: { width: 980, height: 2123 },
    screen: { width: 393, height: 851 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 30000 });
  await page.waitForSelector(".ml-clock-hand img", { timeout: 15000 });
  await page.waitForTimeout(1200);

  // ---- 1. layering: wheel+hand plane BEHIND the frame canvas, clipped ----
  const layer = await page.evaluate(() => {
    const root = document.querySelector(".ml-clock-hand");
    const frame = document.querySelector("#ml-frame2");
    const imgs = root.querySelectorAll("img");
    return {
      z: getComputedStyle(root).zIndex,
      fz: getComputedStyle(frame).zIndex,
      clip: root.style.clipPath,
      imgs: imgs.length,
      wheelSrc: imgs[0].src,
    };
  });
  if (!(+layer.z < +layer.fz)) fail(`layer z ${layer.z} not behind frame z ${layer.fz}`);
  if (!layer.clip.includes("inset")) fail("clock layer has no clip-path");
  if (layer.imgs !== 2 || !layer.wheelSrc.includes("clock360")) fail("wheel img missing");
  console.log(`layering OK (clock z${layer.z} < frame z${layer.fz}, clipped)`);

  const wheelDeg = () =>
    page.evaluate(() => {
      const w = document.querySelector(".ml-clock-hand img");
      const m = /rotate\(([-\d.]+)deg\)/.exec(w.style.transform || "rotate(0deg)");
      return m ? +m[1] : 0;
    });
  const handRot = () =>
    page.evaluate(() => {
      const h = document.querySelectorAll(".ml-clock-hand img")[1];
      const m = /rotate\(([-\d.]+)deg\)/.exec(h.style.transform || "rotate(0deg)");
      return m ? +m[1] : 0;
    });
  const shotClock = (name) =>
    page.screenshot({ path: `${OUT}/${name}`, clip: { x: 0, y: 0, width: 980, height: 400 } });

  // ---- 2. day parity: wheel at 0 mod 360 (day face down) ----
  await page.evaluate(() => window.__ml.timeOfDay("Day"));
  await page.waitForTimeout(600);
  const d0 = await wheelDeg();
  if (((d0 % 360) + 360) % 360 !== 0) fail(`day wheel at ${d0}deg, want 0 mod 360`);
  await shotClock("clockflip-day.png");
  console.log(`day face OK (wheel ${d0}deg)`);

  // ---- 3. evening -> night: the hand-off FLIPS +180, no teleport ----
  await page.evaluate(() => window.__ml.timeOfDay("Evening", false));
  await page.waitForTimeout(3000);
  const dEve = await wheelDeg();
  const hEve = await handRot();
  await page.evaluate(() => window.__ml.timeOfDay("Night", false));
  await page.waitForTimeout(1100); // mid-flip
  await shotClock("clockflip-mid.png");
  await page.waitForTimeout(2200); // flip settled
  const dN = await wheelDeg();
  const hN = await handRot();
  if (dN - dEve !== 180) fail(`night flip: wheel ${dEve} -> ${dN}, want +180`);
  if (!(hN > hEve)) fail(`hand went backwards at hand-off: ${hEve} -> ${hN} (teleport?)`);
  await shotClock("clockflip-night.png");
  console.log(`night hand-off OK (wheel ${dEve} -> ${dN}, hand ${hEve.toFixed(1)} -> ${hN.toFixed(1)})`);

  // ---- 4. night -> morning: flips again, day face returns ----
  await page.evaluate(() => window.__ml.timeOfDay("Morning", false));
  await page.waitForTimeout(3300);
  const dM = await wheelDeg();
  if (dM - dN !== 180) fail(`morning flip: wheel ${dN} -> ${dM}, want +180`);
  if (((dM % 360) + 360) % 360 !== 0) fail(`morning wheel ${dM} not day-parity`);
  console.log(`morning hand-off OK (wheel ${dN} -> ${dM}, day face back)`);

  // ---- 5. instant join sync lands the right face without animation ----
  await page.evaluate(() => window.__ml.timeOfDay("Night"));
  await page.waitForTimeout(400);
  const dJ = await wheelDeg();
  if (((dJ % 360) + 360) % 360 !== 180) fail(`instant night: wheel ${dJ}, want 180 mod 360`);
  console.log(`instant night sync OK (wheel ${dJ}deg)`);

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log("CLOCKFLIP OK — wheel behind frame, hand-offs rotate instead of teleporting");
} finally {
  await browser.close();
}
