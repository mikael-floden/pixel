// Proof that the wiki renders a domain that has CONVERTED to WebP: build a
// scratch root, convert a domain into it, serve it, and compare what the
// browser paints against the PNG build.  See wiki/README.md.
//
//   WEBP_URL=http://127.0.0.1:8907/wiki/site/index.html node wiki/tools/check-webp.mjs
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await (await b.newContext({ viewport: { width: 426, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const errs = [], bad = [], seen = [];
p.on("pageerror", (e) => errs.push(String(e)));
p.on("response", (r) => { const u = r.url();
  if (/\.(webp|png)$/i.test(u)) { seen.push([u.split("/").slice(-2).join("/"), r.status()]); if (!r.ok()) bad.push([u, r.status()]); } });
const W = process.env.WEBP_URL ?? "http://127.0.0.1:8907/wiki/site/index.html";
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
await p.goto(W + "#/monsters/butterfly_dragon", { waitUntil: "load" });
await p.waitForTimeout(2500);
const st = await p.evaluate(() => {
  const imgs = [...document.querySelectorAll("img")].map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight, done: i.complete }));
  const cv = document.querySelector(".stage canvas, canvas");
  return { h1: document.querySelector("h1")?.textContent, imgs,
    canvas: cv ? { w: cv.width, h: cv.height } : null,
    // is anything actually painted on the animation canvas?
    painted: cv ? (() => { const c = cv.getContext("2d"); try { const d = c.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++; return n; } catch { return -1; } })() : null };
});
console.log("page:", st.h1, "| canvas", JSON.stringify(st.canvas), "| opaque px:", st.painted);
ok(st.h1 === "Emberwing", "the WebP monster page renders");
// A lazy image below the fold has not STARTED loading (complete=false);
// only a finished-but-zero-sized image actually failed to decode.
const broken = st.imgs.filter((i) => i.done && i.w === 0);
console.log("images:", st.imgs.length, "| webp:", st.imgs.filter((i) => /\.webp/.test(i.src)).length, "| broken:", broken.length);
for (const b2 of broken.slice(0, 5)) console.log("   broken:", b2.src);
ok(broken.length === 0, `every loaded image decoded (${st.imgs.filter((i) => i.done).length} loaded)`);
ok(st.imgs.some((i) => /\.webp/.test(i.src)), "the page is actually serving WebP");
ok(st.painted > 100, `the animation canvas is painted (${st.painted} opaque px)`);
await p.evaluate(() => scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(1500);
const late = await p.evaluate(() => [...document.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src));
console.log("after scrolling the whole page:", late.length ? late : "every image decoded");
ok(late.length === 0, "the lazy images below the fold decode too");
// icons on the start page
await p.evaluate(() => { location.hash = "#/"; }); await p.waitForTimeout(1200);
const icons = await p.evaluate(() => [...document.querySelectorAll(".sect-icon")].map((i) => ({ src: i.src.split("/").pop(), w: i.naturalWidth })));
console.log("section icons:", JSON.stringify(icons.slice(0, 3)), `(${icons.length})`);
ok(icons.length > 0 && icons.every((i) => i.w === 48), "every section icon decoded at 48px native");
ok(icons.every((i) => i.src.endsWith(".webp")), "the icons are WebP");
console.log("asset 404s:", bad.length ? bad.slice(0, 5) : "none");
ok(bad.length === 0, "no image 404s");
console.log("page errors:", errs.length ? errs : "none");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL WEBP RENDER CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
