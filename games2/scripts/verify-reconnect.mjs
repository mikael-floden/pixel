// Dead-connection recovery: when the websocket drops (phone slept, network
// blip), the client must rejoin IN PLACE — no page reload (phones background
// constantly; re-running the whole loading screen each time is unacceptable).
// Expected: "Reconnecting…" toast, new session in the same page, position
// restored via the token store, old avatars swapped for fresh state.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const fail = (m) => {
  throw new Error(m);
};
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => {
    window.__noReloadMarker = true; // survives only if the page does NOT reload
    const m = window.__ml.me();
    return { x: m.x, y: m.y, id: window.__ml.myId() };
  });

  // Kill the socket; the scene must reconnect in place.
  await page.evaluate(() => window.__ml.dropConnection());
  await page.waitForFunction(
    (oldId) => window.__ml && window.__ml.myId() && window.__ml.myId() !== oldId && window.__ml.players() >= 1,
    before.id,
    { timeout: 20000 },
  );
  const after = await page.evaluate(() => {
    const m = window.__ml.me();
    return { x: m.x, y: m.y, marker: !!window.__noReloadMarker, toast: !!document.body.textContent.includes?.("Reconnecting") };
  });
  if (!after.marker) fail("page RELOADED — reconnect must happen in place");
  const d = Math.hypot(after.x - before.x, after.y - before.y);
  console.log(`rejoined in place (new session), moved ${d.toFixed(0)}wu from before`);
  if (d > 64) fail(`position not restored (drifted ${d.toFixed(0)}wu)`);
  // The toast must be gone once reconnected.
  const toastGone = await page.evaluate(() => !document.body.innerText.includes("Reconnecting"));
  if (!toastGone) fail("Reconnecting toast still visible after rejoin");
  console.log("RECONNECT-IN-PLACE OK");
} finally {
  await browser.close();
}
