// verify-staging — the WIKI'S ADMIN PATH: read the whole repo from another
// origin (maintainer 2026-08-14, "make the wiki and the other maps work for me
// again as an admin using CORS").
//
// WHY A LOCAL FIXTURE AND NOT jsDelivr: this agent sandbox gives the headless
// browser NO https egress at all — example.com resets exactly like
// cdn.jsdelivr.net does, while curl and node have full access — so a gate that
// hit the real CDN could never run here. It would also make CI depend on a
// third party's uptime and rate limits.
//
// So the gate serves the repo from a SECOND LOCAL PORT with
// `access-control-allow-origin: *`. That is a genuinely different origin, so it
// exercises the identical browser path the real thing does: cross-origin fetch,
// crossOrigin="anonymous" image decode, and — the one that actually matters —
// whether the canvas is still readable afterwards. The wiki reads pixels back;
// a tainted canvas throws on getImageData in a way no HTTP 200 reveals.
//
// What it deliberately does NOT cover is jsDelivr's own behaviour. That is
// verified separately and by other means: the response headers by curl
// (immutable + ACAO), and end-to-end on a real device via
// client/public/cors-check.html.
//
// Needs the dev server on :5173 (npm run dev). Starts its own fixture.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 5199;
const fail = (m) => {
  console.error(`verify-staging: FAIL — ${m}`);
  process.exit(1);
};

const TYPES = { ".json": "application/json", ".webp": "image/webp", ".png": "image/png" };
const fixture = createServer(async (req, res) => {
  const p = join(REPO_ROOT, decodeURIComponent(req.url.split("?")[0]));
  // The whole point of the fixture: a cross-origin server that permits reads.
  res.setHeader("access-control-allow-origin", "*");
  try {
    if (!(await stat(p)).isFile()) throw 0;
    res.setHeader("content-type", TYPES[extname(p)] ?? "application/octet-stream");
    res.end(await readFile(p));
  } catch {
    res.statusCode = 404;
    res.end("nope");
  }
});
await new Promise((r) => fixture.listen(PORT, r));

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  const page = await (await browser.newContext()).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
  await page.goto("http://localhost:5173/assets/wiki/site/index.html", { waitUntil: "domcontentloaded", timeout: 60000 });
  // The injectable base — the reason this path is testable at all.
  await page.evaluate((base) => localStorage.setItem("ml-staging-base", base), `http://localhost:${PORT}/`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const r = await page.evaluate(async () => {
    const D = (x) => x?.domains ?? {};
    const out = { localRoot: String(ROOT) };
    const full = await useStagingRoot();
    out.ok = !!full;
    out.stagingRoot = String(ROOT);
    out.objects = (D(full).objects ?? []).length;
    out.monsters = (D(full).monsters ?? []).length;
    const rel = (D(full).objects ?? [])[0]?.preview;
    if (rel) {
      out.asset = assetUrl(rel);
      const im = await new Promise((res) => {
        const i = new Image();
        i.crossOrigin = "anonymous";
        i.onload = () => res(i);
        i.onerror = () => res(null);
        i.src = assetUrl(rel);
      });
      if (!im) return { ...out, decoded: false };
      out.decoded = `${im.naturalWidth}x${im.naturalHeight}`;
      try {
        const cv = document.createElement("canvas");
        cv.width = im.naturalWidth;
        cv.height = im.naturalHeight;
        const cx = cv.getContext("2d");
        cx.drawImage(im, 0, 0);
        cx.getImageData(0, 0, 1, 1);
        out.canvasReadable = true;
      } catch (e) {
        out.canvasReadable = false;
        out.taint = String(e).slice(0, 100);
      }
    }
    return out;
  });

  if (errs.length) fail(`page errors: ${errs.join(" | ")}`);
  if (!r.ok) fail("useStagingRoot() returned nothing — the admin registry did not load cross-origin");
  if (!String(r.stagingRoot).includes(String(PORT)))
    fail(`ROOT did not move to the staging origin (${r.stagingRoot}) — assets would still come from the image`);
  if (!(r.objects > 0)) fail("staging registry has no objects — wrong shape?");
  if (!r.decoded) fail(`a staging asset failed to decode cross-origin (${r.asset})`);
  if (r.canvasReadable !== true)
    fail(`CANVAS TAINTED after drawing a cross-origin asset — the wiki reads pixels back and would throw. ${r.taint ?? ""}`);

  console.log(
    `verify-staging: OK — registry ${r.objects} objects / ${r.monsters} monsters from ${r.stagingRoot}, ` +
      `asset ${r.decoded} decoded cross-origin, canvas readable (not tainted)`,
  );
} finally {
  await browser.close();
  fixture.close();
}
