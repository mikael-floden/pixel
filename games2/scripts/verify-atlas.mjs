// verify-atlas — a maps2 world boots from its COMMITTED atlas, not from
// hundreds of per-tile requests, and the sliced textures really draw.
//
// The instrument is the network itself: every request the page makes is
// recorded, and the gate asserts the shape of the load —
//   • the atlas index + its sheet(s) were fetched (a handful of requests),
//   • ZERO individual /assets/tiles2/ requests fired (the pre-atlas world
//     needed 571 of them on the_island2),
//   • __ml.atlasInfo() confirms every needed tile was sliced from the sheet
//     and none fell back,
//   • and the world actually RENDERED (a centre patch of the frame carries
//     art, not void) — slicing that silently produced blank textures would
//     pass every count above, so the pixels get the final word.
//
// The deeper rendering guarantees (iso stacking, cuts, lighting) are what
// verify-indoor asserts; it runs against the same dev server and therefore
// the same atlas-sliced textures, so it doubles as this feature's pixel gate.
//
// Needs the dev stack (npm run dev).
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const WORLD = "the_island2"; // the default world — the one players boot
const fail = (m) => {
  console.error(`verify-atlas: FAIL — ${m}`);
  process.exit(1);
};

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  const page = await (await browser.newContext({ viewport: { width: 720, height: 480 } })).newPage();
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));

  await page.goto("http://localhost:5173/", { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  const idx = await page.evaluate((w) => window.__mlSelect.worlds().findIndex((n) => n === w), WORLD);
  if (idx < 0) fail(`${WORLD} missing from the picker`);
  await page.evaluate((i) => {
    window.__mlSelect.pickWorld(i);
    window.__mlSelect.commit();
  }, idx);
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 30000 });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => window.__ml.atlasInfo());
  if (!info) fail("atlasInfo() is null — the loader never ran for a maps2 world");
  if (!info.index) fail("no atlas index was used — is client/public/atlases missing or stale-pruned?");
  if (!(info.sliced > 400))
    fail(`only ${info.sliced} tiles sliced from the sheet — the_island2 needs ~571`);
  if (info.individual !== 0)
    fail(`${info.individual} tiles fell back to individual requests (${JSON.stringify(info)}) — the atlas is incomplete`);

  // Tile ART only: tiles2/emission.json (the light params) is supposed to
  // load and is not a tile.
  const tileReqs = requests.filter((u) => u.includes("/assets/tiles2/") && /\.(webp|png)(\?|$)/.test(u));
  const atlasReqs = requests.filter((u) => u.includes("/atlases/"));
  if (tileReqs.length !== 0)
    fail(`${tileReqs.length} individual tile requests fired (e.g. ${tileReqs[0]}) — the whole point is zero`);
  if (!(atlasReqs.length >= 2 && atlasReqs.length <= 8))
    fail(`expected a handful of atlas requests, saw ${atlasReqs.length}`);

  // Pixels get the final word: the centre of the frame must carry ART.
  const png = PNG.sync.read(await page.screenshot());
  let sum = 0, n = 0;
  for (let y = 140; y < 340; y += 2)
    for (let x = 200; x < 520; x += 2) {
      const i = (y * png.width + x) * 4;
      sum += 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
      n++;
    }
  const lum = sum / n;
  if (!(lum > 8)) fail(`the world did not render (centre luminance ${lum.toFixed(1)}) — sliced textures may be blank`);
  if (errs.length) fail(`page errors: ${errs.join(" | ")}`);

  console.log(
    `verify-atlas: OK — ${WORLD} booted from ${info.sheets} sheet(s): ${info.sliced} tiles sliced, ` +
      `0 individual tile requests (atlas fetches: ${atlasReqs.length}), world rendered (centre luminance ${lum.toFixed(1)})`,
  );
} finally {
  await browser.close();
}
