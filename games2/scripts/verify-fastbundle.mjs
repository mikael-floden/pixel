// THE PUBLISH GATE FOR THE FAST LANE: does a fastbuild bundle actually run the
// game? A lane that reaches production in seconds is only worth having if it
// cannot publish a bundle that does not start — a three-second deploy of a
// black page is a three-second outage, and the maintainer tests in production
// from a phone.
//
// Four things are asserted, and each one is a bug this gate already caught
// while it was being written:
//
//   BOOTS    `window.__ml` installs — the scene ran. (Missed when
//            `import.meta.env` was defined key-by-key: Phaser booted, the world
//            loaded, and the join died on `VITE_SERVER_URL` with ZERO page
//            errors, because the throw was inside a promise.)
//   JOINS    the WebSocket connects and `players() >= 1`.
//   RENDERS  `tiles3().drew.blits > 0`. THIS is the one that matters for
//            esbuild: the ground is drawn by tiles3worker, and a worker is
//            exactly what esbuild does not bundle for free — an un-rewritten
//            `new Worker(new URL("./tiles3worker.ts", ...))` asks the browser
//            for a .ts file and fails SILENTLY, since a dead worker is not a
//            page error. Joined-but-blank was the failure mode to catch.
//   CLEAN    no page errors, and no 404 other than /asset-index.json, which is
//            built in the image and absent from every local dist, vite's too.
//            (70 silent 404s once hid a relative --out that split the output
//            across two trees.)
//
// IT DELETES client/dist ON THE WAY OUT, deliberately. The server's served
// directory is hardcoded (server/src/index.ts: GAME_ROOT/client/dist), so this
// gate has to build there — and `ensureClientDist` (scripts/clientdist.mjs)
// decides freshness by MTIME, so a newer esbuild dist left behind would read as
// "up to date" and the next gate would silently measure the wrong bundler.
// Removing it makes the next ensureClientDist rebuild with vite.
//
// Needs no dev stack: it runs its own prod server, like verify-indoorscenery.
import { spawn } from "node:child_process";
import { existsSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { fastBuild } from "./fastbuild.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "client", "dist");
/** THE BROWSER, WHEREVER IT IS. This was a hardcoded
 *  /opt/pw-browsers/chromium-1194/... — which exists in the dev container and
 *  NOWHERE on a GitHub runner, so the gate could only ever have failed in CI
 *  and the lane could never have published. Resolution order: an explicit
 *  CHROME_EXE, then any chromium under PLAYWRIGHT_BROWSERS_PATH (the version
 *  suffix moves with playwright), then playwright's own default, which is what
 *  `playwright install chromium` provides on a runner (the wiki-guard workflow
 *  is the precedent). */
function findChrome() {
  if (process.env.CHROME_EXE && existsSync(process.env.CHROME_EXE)) return process.env.CHROME_EXE;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    for (const d of readdirSync(base)) {
      if (!d.startsWith("chromium")) continue;
      for (const exe of ["chrome-linux/chrome", "chrome-linux/headless_shell"]) {
        const full = join(base, d, exe);
        if (existsSync(full)) return full;
      }
    }
  } catch {
    /* no such directory: fall through to playwright's default */
  }
  return undefined; // playwright resolves its own install
}
const EXE = findChrome();
console.log(`[fastbundle] browser: ${EXE ?? "playwright's own install"}`);
let bad = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) bad++;
};

const built = await fastBuild({ outDir: DIST, gitSha: "fastbundlegate" });
console.log(`[fastbundle] built in ${built.ms} ms — assets/${built.bundle} (${(built.bytes / 1e6).toFixed(2)} MB)`);

// Every emitted name content-hashed (fastbuild enforces it; asserted here too,
// because this gate is what a publish lane will run and the store's one law is
// that a live name is never rewritten).
const HASHED = /^[A-Za-z0-9_.-]+-[A-Za-z0-9]{8,}\.[a-z0-9]+$/;
const stray = readdirSync(join(DIST, "assets")).filter((n) => !HASHED.test(n));
check(stray.length === 0, `every emitted asset name carries its content hash${stray.length ? ` (stray: ${stray.join(", ")})` : ""}`);
const html = readFileSync(join(DIST, "index.html"), "utf8");
check(html.includes(built.bundle), `index.html names the emitted bundle (${built.bundle})`);
check(!html.includes("/src/main.ts"), "and no longer names the dev entry");

const port = 3500 + Math.floor(Math.random() * 400);
const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
  cwd: join(ROOT, "server"),
  detached: true,
  env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production" },
  stdio: ["ignore", "ignore", "ignore"],
});
const stop = () => {
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  rmSync(DIST, { recursive: true, force: true }); // see the header
};
process.on("exit", stop);

const origin = `http://127.0.0.1:${port}`;
for (let t0 = Date.now(); ; ) {
  try { if ((await fetch(origin + "/health")).ok) break; } catch {}
  if (Date.now() - t0 > 90_000) { console.error("FAIL: the server never became healthy"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({
  ...(EXE ? { executablePath: EXE } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await (await browser.newContext({ viewport: { width: 480, height: 320 }, serviceWorkers: "block" })).newPage();
const errs = [];
const missing = [];
const workers = [];
const console_ = [];
page.on("console", (m) => { if (console_.length < 40) console_.push(`${m.type()}: ${m.text().slice(0, 160)}`); });
// Its OWN array: `missing` is what the "nothing 404s" assertion reads, and an
// aborted /asset-index.json (absent outside the image, and exempted there) is
// diagnostic noise, not a failure. Mixing the two turned a passing arm red.
const failed = [];
page.on("requestfailed", (r) => failed.push(`${r.failure()?.errorText ?? "?"} ${r.url().slice(-56)}`));
page.on("pageerror", (e) => errs.push(e.message.slice(0, 200)));
page.on("response", (r) => {
  const u = r.url();
  if (r.status() >= 400 && !u.endsWith("/asset-index.json")) missing.push(`${r.status()} ${u.slice(-56)}`);
  if (/worker-[A-Za-z0-9]{8,}\.js$/.test(u)) workers.push(`${r.status()} ${u.split("/").pop()}`);
});
await page.goto(origin + "/", { waitUntil: "load" });

// A GATE THAT TIMES OUT MUST SAY WHY. This wait used to throw playwright's bare
// TimeoutError with an empty `log`, and the errors/404s collected above were
// only printed AFTER it — so the first CI failure of this lane reported
// "Timeout 90000ms exceeded" and nothing else, and the one question that
// mattered (which fetch stalled the select screen?) was unanswerable from the
// run. Everything known about the page is dumped here instead.
try {
  // 150 s, not 90: a GitHub runner is slower and colder than this container
  // (the first CI run of this lane timed out here at exactly 90 s while the
  // same gate passes locally), and a gate that fails on a slow box teaches
  // nothing. If it is genuinely stuck the dump below says so either way.
  await page.waitForFunction(() => !!window.__mlSelect, null, { timeout: 150_000 });
} catch {
  const diag = await page
    .evaluate(() => ({
      url: location.href,
      title: document.title,
      globals: {
        __mlSelect: typeof window.__mlSelect,
        __ml: typeof window.__ml,
        Phaser: typeof window.Phaser,
      },
      overlay: !!document.querySelector("#ml-select, .ml-select"),
      bodyChildren: [...document.body.children].map((e) => `${e.tagName.toLowerCase()}#${e.id || "-"}`).slice(0, 12),
      loading: (document.querySelector("#ml-loading, .ml-loading")?.textContent ?? "").slice(0, 120),
    }))
    .catch((e) => ({ evaluateFailed: String(e).slice(0, 160) }));
  console.error("FAIL: the select screen never installed __mlSelect within 90 s");
  console.error(`  page: ${JSON.stringify(diag)}`);
  console.error(`  page errors (${errs.length}):`);
  for (const e of errs.slice(0, 12)) console.error(`    ${e}`);
  console.error(`  4xx/5xx responses (${missing.length}):`);
  for (const m of missing.slice(0, 20)) console.error(`    ${m}`);
  console.error(`  requests that never completed (${failed.length}):`);
  for (const f of failed.slice(0, 20)) console.error(`    ${f}`);
  console.error(`  console (${console_.length}):`);
  for (const c of console_.slice(0, 25)) console.error(`    ${c}`);
  process.exit(1);
}
await page.evaluate(() => window.__mlSelect.commit());

let state = null;
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(5000);
  state = await page.evaluate(() => {
    const t = (() => { try { return window.__ml.tiles3().drew.blits; } catch { return null; } })();
    return { ml: typeof window.__ml, players: window.__ml?.players?.() ?? null, blits: t };
  });
  if (state.players >= 1 && state.blits > 0) break;
}
console.log(`[fastbundle] ${JSON.stringify(state)}; worker fetches: ${workers.join(", ") || "none"}`);
check(state?.ml === "object", "BOOTS — the scene installed __ml");
check((state?.players ?? 0) >= 1, `JOINS — the world accepted the player (players ${state?.players})`);
check((state?.blits ?? 0) > 0, `RENDERS — terrain drew (${state?.blits} blits), so the worker rewrite holds`);
// EVERY EMITTED WORKER IS FETCHABLE, asked of the server directly rather than
// inferred from what the page happened to request. Watching the page is the
// weaker test and it reads stronger than it is: this run saw only 2 of the 3
// (compose, art) because tiles3 can take its documented SYNC fallback, so the
// page-traffic check passed with a worker it had never proven reachable.
const served = [];
for (const name of Object.values(built.workers)) {
  const r = await fetch(`${origin}/assets/${name}`);
  served.push(`${r.status} ${name}`);
}
check(
  served.length === 3 && served.every((s2) => s2.startsWith("200")),
  `all ${served.length} emitted worker bundles are served (${served.join(", ")})`,
);
if (workers.length) console.log(`[fastbundle] the page itself fetched: ${workers.join(", ")}`);
check(errs.length === 0, `no page errors${errs.length ? ` — ${errs.slice(0, 2).join(" | ")}` : ""}`);
check(missing.length === 0, `nothing 404s but the image-built asset-index${missing.length ? ` — ${missing.slice(0, 3).join(" | ")}` : ""}`);

await browser.close();
console.log(bad ? `verify-fastbundle: ${bad} FAILED` : "verify-fastbundle: ALL OK");
process.exit(bad ? 1 : 0);
