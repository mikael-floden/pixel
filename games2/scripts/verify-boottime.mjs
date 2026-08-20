#!/usr/bin/env node
// verify-boottime — THE STOPWATCH. Time-to-playable, honestly measured.
//
// THE METRIC: how long from hitting the URL until the player can actually
// play. Every player pays it on every visit and the maintainer's device is a
// phone, so this is the number the whole perf effort is judged on.
//
// This is an INSTRUMENT, not a gate: it never exits non-zero because the game
// is slow. It exits non-zero only when it could not measure (build failed,
// server never came up, every run timed out) — a broken stopwatch is the only
// failure it reports.
//
// USAGE
//   node scripts/verify-boottime.mjs                       # 5 runs, no throttling
//   node scripts/verify-boottime.mjs --throttle=4g
//   node scripts/verify-boottime.mjs --throttle=slow4g --runs=5
//   node scripts/verify-boottime.mjs --cpu=4 --label=after-atlas
//   node scripts/verify-boottime.mjs --no-build --port=2599  # reuse a server
//
// EVERY HARNESS TRAP BELOW WAS PAID FOR IN WASTED HOURS. Do not "simplify"
// them away:
//
//  * PROD BUILD ONLY. The dev server takes different code paths
//    (import.meta.env.DEV short-circuits loadWorldsList, vite serves unbundled
//    ES modules, nothing is minified or compressed). Numbers from `npm run
//    dev` are not numbers about the game players get. We build client/dist if
//    it is stale and run a SERVE_CLIENT=1 NODE_ENV=production server.
//  * serviceWorkers: "block". The app registers /sw.js, and neither
//    page.route() NOR the request/response events see what a service worker
//    fetches — a previous gate silently measured a completely different load.
//    (Today's sw.js deliberately caches NOTHING and just re-issues fetch, so
//    blocking it removes only the worker's own startup — but the moment it
//    starts caching, an unblocked run would measure the cache and this note is
//    what tells you the block is not optional.)
//  * A FRESH BROWSER PER RUN. Playwright contexts share the browser's HTTP
//    cache; reusing one turns run 2..N into warm-cache fiction. The point is
//    the FIRST visit.
//  * NO WARM-UP NAVIGATION TO SEED localStorage. The obvious way to skip the
//    character picker is goto -> setItem -> reload, but that reload is a
//    WARM-CACHE load: the bundle, the logo and every manifest are already
//    there. We use addInitScript instead, which runs at document-start on the
//    real origin, so the measured navigation is the only one.
//  * MEDIAN OF N, NEVER A SINGLE RUN. Headless software-GL starves the frame
//    loop and a single boot swings by seconds. Default 5 runs plus one
//    uncounted WARM-UP (the first boot after a server start pays node's JIT,
//    the world.json read and the first brotli compression of the bundle).
//  * SMALL VIEWPORT. Software GL fill rate is not the thing under test; a
//    phone-sized viewport keeps the frame loop alive so the reveal cinematic
//    is not measuring swiftshader.
//
// THE ONE WAY THESE NUMBERS DIFFER FROM PRODUCTION — know it before quoting
// them. The server here serves ASSETS_ROOT = the WORKING TREE, i.e. the whole
// repo; the deployed image serves the CURATED root the Dockerfile's `curate`
// stage emits (scripts/shipset.mjs) and rebuilds every manifest from it. So
// this harness boots against the STAGING superset: monsters.json lists all 57
// creatures and the boot pulls walk+idle strips for every one of them (912
// requests / 5.03 MB), where the image ships only the 24 kinds the_island2's
// spawn zones name (384 strips / 2.18 MB). Everything else — tiles, NPCs,
// characters, audio — is already world-scoped and matches.
// Consequence: the ABSOLUTE numbers are pessimistic for monster art and honest
// for everything else, and the A/B use (same harness before and after) is
// unaffected. Do NOT "fix" this by pointing the server at a curated root
// emitted here: the manifests would have to be rebuilt from it, and those
// rewrite TRACKED files (client/public/monsters.json, npcs.json) — a
// measurement that dirties the repo is worse than one with a known bias.
//
// WHAT IT REPORTS. Not one number — a chain, so a regression can be LOCALISED:
//   navigationStart .. selectReady  boot code: bundle parse, manifests, worlds
//   selectReady     .. worldFetched world.json over the wire + parse
//   worldFetched    .. loaderComplete   THE ASSET STORM (Phaser preload)
//   loaderComplete  .. wsOpen       socket handshake
//   wsOpen          .. firstState   room join + the server's full-state build
//   firstState      .. avatarIn     applying that state, building the scene
//   avatarIn        .. playable     the scripted reveal cinematic (~1.5s)
// plus art requests by category, transferred bytes, and long-task totals.
//
// THE A/B RECIPE (the only way a change to boot is allowed to ship):
//   git stash                      # or otherwise get back to the BEFORE state
//   node scripts/verify-boottime.mjs --label=before --throttle=4g
//   git stash pop
//   node scripts/verify-boottime.mjs --label=after  --throttle=4g
//   # both rows are now in .boottime.json; compare the CHAIN, not just the
//   # headline — a change that moves bytes but not time shows up as a flat
//   # loaderNear with a fatter matchmake, and that tells you what to do next.
// Compare `avatarIn` first: `playable` adds the reveal cinematic, whose frame
// floor is the noisiest thing in the run. And read the request census — a
// change that halves requests but raises avatarIn is the body-atlas failure
// mode (functionally perfect, 2× slower, caught only by an A/B).
//
// MARK SOURCES (why these and not performance.mark()s in the app): the client
// carries no instrumentation of its own, and adding some would change the
// thing being measured. Everything here is observed from outside:
//   - the loading overlay's OWN progress bar width (loading.ts writes
//     style.width; 5% = "Fetching world", 5..90% = asset loader, 95% =
//     "Connecting") — that is the app's own view of its progress, not a guess;
//   - a WebSocket subclass installed before any app code runs (open + every
//     message, with sizes);
//   - window.__ml.players() and the presence of #ml-loading — the two halves
//     of the maintainer's definition of playable;
//   - PerformanceResourceTiming for the request census (buffer raised to
//     30k entries first — the default 250 would drop ~700 of ~930 sprites).

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, statSync, readdirSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";

const EXE = process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- args
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "1"] : [a, "1"];
  }),
);
const RUNS = Number(args.runs ?? 5);
const WARMUP = Number(args.warmup ?? 1);
const THROTTLE = String(args.throttle ?? "none");
const CPU = Number(args.cpu ?? 1);
const WORLD = String(args.world ?? "the_island2");
const CHARACTER = String(args.character ?? "default_boy");
const LABEL = String(args.label ?? "");
// Generous on purpose: a slow-4G boot legitimately runs past two minutes, and
// a false "timed out" is the one way this instrument can lie about the game.
const TIMEOUT = Number(args.timeout ?? 300_000);
const OUTFILE = String(args.out ?? join(ROOT, ".boottime.json"));
const [VW, VH] = String(args.viewport ?? "412x732")
  .split("x")
  .map(Number);

const NET = {
  none: null,
  // ~9 Mbps down / 3 Mbps up / 100ms RTT — a good 4G connection.
  "4g": { downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8, latency: 100 },
  // ~1.6 Mbps down / 750 kbps up / 300ms RTT — Chrome DevTools' "Slow 4G".
  slow4g: { downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 300 },
};
if (!(THROTTLE in NET)) {
  console.error(`verify-boottime: --throttle must be one of ${Object.keys(NET).join("|")}`);
  process.exit(2);
}

const die = (msg) => {
  console.error(`verify-boottime: CANNOT MEASURE — ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------- build
function newestMtime(dir, skip = /node_modules|\/dist(\/|$)/) {
  let newest = 0;
  const walk = (d) => {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(d, e.name);
      if (skip.test(p)) continue;
      if (e.isDirectory()) walk(p);
      else {
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  walk(dir);
  return newest;
}

function ensureBuild() {
  const dist = join(ROOT, "client", "dist", "index.html");
  if (args["no-build"]) {
    if (!existsSync(dist)) die("--no-build but client/dist/index.html does not exist");
    return "reused (--no-build)";
  }
  const distAt = existsSync(dist) ? statSync(dist).mtimeMs : 0;
  const srcAt = Math.max(
    newestMtime(join(ROOT, "client", "src")),
    newestMtime(join(ROOT, "shared", "src")),
    newestMtime(join(ROOT, "client", "public")),
    statSync(join(ROOT, "client", "index.html")).mtimeMs,
  );
  if (distAt > srcAt) return "up to date";
  console.log("[boottime] client/dist is stale — building (npm run build:client)…");
  try {
    execFileSync("npm", ["run", "build:client"], { cwd: ROOT, stdio: "inherit" });
  } catch {
    die("npm run build:client failed");
  }
  return "rebuilt";
}

// ---------------------------------------------------------------- server
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function waitHealthy(origin, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(origin + "/health");
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function startServer(port) {
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) die(`tsx not found at ${tsx} — run npm install`);
  const child = spawn(tsx, ["src/index.ts"], {
    cwd: join(ROOT, "server"),
    detached: true,
    env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  child.on("exit", (c) => log.push(`\n[server exited ${c}]`));
  const ok = await waitHealthy(`http://127.0.0.1:${port}`);
  if (!ok) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    die(`prod server never became healthy on :${port}\n${log.join("").slice(-2000)}`);
  }
  return {
    child,
    stop() {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    },
  };
}

// ---------------------------------------------------------------- in-page probe
// Runs at document-start, before a single line of app code. Everything it
// touches is either storage (to skip the picker) or observation.
function probe({ world, characterUid }) {
  try {
    localStorage.setItem("ml-last-choice", JSON.stringify({ world, characterUid, name: "Stopwatch" }));
    sessionStorage.setItem("ml-rejoin", "1");
  } catch {}
  try {
    // ~930 sprite loads; the default 250-entry buffer would drop most of them.
    performance.setResourceTimingBufferSize(30000);
  } catch {}

  const M = Object.create(null);
  const B = {
    marks: M,
    ws: { msgs: 0, bytes: 0, first: [] },
    longtasks: [],
    barMax: 0,
    errors: [],
  };
  window.__boot = B;
  const now = () => performance.now();
  const mark = (k) => {
    if (M[k] === undefined) M[k] = now();
  };

  addEventListener("error", (e) => B.errors.push(String(e.message).slice(0, 160)));

  // --- WebSocket: open + every message, installed before colyseus.js exists.
  const NWS = window.WebSocket;
  class StopwatchWS extends NWS {
    constructor(...a) {
      super(...a);
      mark("wsCreate");
      this.addEventListener("open", () => mark("wsOpen"));
      this.addEventListener("message", (e) => {
        const d = e.data;
        const n = d && d.byteLength !== undefined ? d.byteLength : typeof d === "string" ? d.length : 0;
        B.ws.msgs++;
        B.ws.bytes += n;
        if (B.ws.first.length < 8) B.ws.first.push([Math.round(now()), n]);
        if (B.ws.msgs === 1) mark("wsFirstMsg");
        // The room's FULL-STATE snapshot is the first substantial payload
        // (the_island2's is multi-KB; the handshake frames before it are tiny).
        if (n >= 1024) mark("firstState");
      });
    }
  }
  window.WebSocket = StopwatchWS;

  // --- long tasks: the CPU story, for localising a regression to a phase.
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) B.longtasks.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ entryTypes: ["longtask"] });
  } catch {}

  // --- the overlay's own progress + the two halves of "playable".
  let overlaySeen = false;
  let stopped = false;
  const scan = () => {
    if (stopped) return;
    const ov = document.getElementById("ml-loading");
    if (ov) {
      overlaySeen = true;
      mark("selectReady"); // manifests + worlds are in and a choice was made
      const bar = document.getElementById("ml-load-bar");
      if (bar) {
        const w = parseFloat(bar.style.width) || 0;
        if (w > B.barMax) B.barMax = w;
        if (w >= 5) mark("worldFetch"); // main.ts: 0.05 "Fetching world…"
        if (w > 5) mark("loaderStart"); // WorldScene.preload's first tick
        if (w >= 90) mark("loaderNear"); // 0.05 + 0.85 — the asset storm is done
        if (w >= 95) mark("loaderComplete"); // 0.95 "Connecting…"
      }
    } else if (overlaySeen) mark("overlayHidden");
    const ml = window.__ml;
    if (ml) {
      mark("mlReady");
      try {
        if (ml.players() >= 1) mark("avatarIn");
      } catch {}
    }
    if (M.avatarIn !== undefined && M.overlayHidden !== undefined) {
      mark("playable");
      stopped = true;
      try {
        mo.disconnect();
      } catch {}
      clearInterval(iv);
    }
  };
  // Three samplers, because each is blind somewhere: the observer catches DOM
  // writes inside a long task, the interval catches JS-only state (players()),
  // and rAF catches what a starved timer queue delays.
  const mo = new MutationObserver(scan);
  const iv = setInterval(scan, 10);
  const raf = () => {
    if (stopped) return;
    scan();
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  const attach = () => {
    try {
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style"],
      });
    } catch {
      setTimeout(attach, 5);
    }
  };
  attach();
}

// ---------------------------------------------------------------- one run
const ART_DOMAINS = ["characters2", "monsters", "tiles2", "maps2", "scenery", "items", "sounds", "music", "composer", "lore", "wiki"];

async function collect(page) {
  return page.evaluate((domains) => {
    const B = window.__boot;
    const P = B.marks.playable ?? performance.now();
    const nav = performance.getEntriesByType("navigation")[0];
    const cats = {};
    const all = performance.getEntriesByType("resource");
    let total = 0;
    let bytes = 0;
    let after = 0;
    let inflight = 0; // started before playable, still arriving when it happened
    const big = [];
    for (const r of all) {
      if (r.startTime > P) {
        after++;
        continue;
      }
      const p = new URL(r.name, location.href).pathname;
      let cat = "other";
      const m = /^\/assets\/([^/]+)\//.exec(p);
      if (m && domains.includes(m[1])) {
        const d = m[1];
        if (d === "characters2") cat = /\/animations\//.test(p) ? "characterFrames" : "characterOther";
        else if (d === "monsters") cat = "monsterStrips";
        else if (d === "tiles2") cat = "tiles";
        else if (d === "maps2") cat = "worldData";
        else if (d === "sounds" || d === "music" || d === "composer") cat = "audio";
        else cat = d;
      } else if (/^\/atlases\//.test(p)) cat = "atlases";
      else if (/^\/assets\//.test(p)) cat = /\.(ogg|m4a|mp3|wav)$/.test(p) ? "audio" : "bundle";
      else if (/^\/matchmake\//.test(p)) cat = "matchmake";
      else if (/\.json$/.test(p)) cat = "manifests";
      else if (/\.(webp|png|jpg)$/.test(p)) cat = "uiArt";
      // BYTE HONESTY: a file that STARTED before playable but was still on the
      // wire at that moment did not cost the player any of their wait — count
      // it as in-flight, not as "downloaded to become playable". Without this
      // split a throttled run credits the boot with megabytes of background
      // audio that had barely begun.
      const done = r.responseEnd > 0 && r.responseEnd <= P;
      const c = (cats[cat] ??= { n: 0, bytes: 0, encoded: 0, inflight: 0 });
      c.n++;
      total++;
      if (done) {
        c.bytes += r.transferSize || 0;
        c.encoded += r.encodedBodySize || 0;
        bytes += r.transferSize || 0;
        if (r.transferSize > 0) big.push([Math.round(r.transferSize), p.slice(-70)]);
      } else {
        c.inflight++;
        inflight++;
      }
    }
    big.sort((a, b) => b[0] - a[0]);
    // The matchmake POST is the server-side room create + full-state build;
    // it sits between "Connecting…" and the socket opening.
    const mm = all.find((r) => /^\/matchmake\//.test(new URL(r.name, location.href).pathname));
    const lt = B.longtasks.filter(([s]) => s <= P);
    return {
      marks: {
        ...B.marks,
        ...(mm ? { matchmakeStart: mm.startTime, matchmakeEnd: mm.responseEnd } : {}),
      },
      nav: {
        domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
        loadEvent: nav ? nav.loadEventEnd : null,
        ttfb: nav ? nav.responseStart : null,
      },
      ws: { msgs: B.ws.msgs, bytes: B.ws.bytes, first: B.ws.first },
      requests: { total, bytes, afterPlayable: after, inflight, cats, big: big.slice(0, 8) },
      longtasks: { n: lt.length, ms: lt.reduce((a, [, d]) => a + d, 0), worst: Math.max(0, ...lt.map(([, d]) => d)) },
      barMax: B.barMax,
      errors: B.errors.slice(0, 5),
    };
  }, ART_DOMAINS);
}

async function runOnce(origin, n, tag) {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const ctx = await browser.newContext({
      viewport: { width: VW, height: VH },
      serviceWorkers: "block", // page.route/events cannot see a worker's fetches
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.addInitScript(probe, { world: WORLD, characterUid: CHARACTER });

    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    const cond = NET[THROTTLE];
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: cond ? cond.latency : 0,
      downloadThroughput: cond ? cond.downloadThroughput : -1,
      uploadThroughput: cond ? cond.uploadThroughput : -1,
    });
    if (CPU > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });

    const t0 = Date.now();
    await page.goto(origin + "/", { waitUntil: "commit", timeout: TIMEOUT });
    // NOTE THE `null`: waitForFunction's second parameter is the ARGUMENT
    // passed to the page function, and the third is the options bag. Passing
    // {timeout} in second position is silently accepted as an argument and
    // leaves the DEFAULT 30s timeout in force — which turned every throttled
    // run into a bogus "TIMED OUT" (a 4G boot legitimately takes ~35s).
    const ok = await page
      .waitForFunction(() => window.__boot?.marks?.playable !== undefined, null, {
        timeout: TIMEOUT,
        polling: 100,
      })
      .then(() => true)
      .catch((e) => {
        console.log(`  [wait failed] ${String(e).slice(0, 200)}`);
        return false;
      });
    const wall = Date.now() - t0;
    const data = await collect(page);
    data.ok = ok;
    data.wall = wall;
    data.run = n;
    data.tag = tag;
    if (!ok) console.log(`  run ${tag}${n}: TIMED OUT after ${wall}ms (marks so far: ${Object.keys(data.marks).join(",")})`);
    else
      console.log(
        `  run ${tag}${n}: playable ${(data.marks.playable / 1000).toFixed(2)}s  ` +
          `(${data.requests.total} reqs, ${(data.requests.bytes / 1048576).toFixed(1)} MB, ` +
          `${data.longtasks.n} long tasks / ${data.longtasks.ms}ms)`,
      );
    return data;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- stats
const med = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const stat = (xs) => (xs.length ? { median: med(xs), min: Math.min(...xs), max: Math.max(...xs) } : null);

const CHAIN = [
  ["ttfb", "TTFB (nav responseStart)"],
  ["domContentLoaded", "DOMContentLoaded"],
  ["selectReady", "selectReady (manifests+worlds in, overlay up)"],
  ["worldFetch", "worldFetch (bar 5% — fetching world.json)"],
  ["loaderStart", "loaderStart (first preload progress)"],
  ["loaderNear", "loaderNear (bar 90% — asset storm done)"],
  ["loaderComplete", "loaderComplete (bar 95% — 'Connecting…')"],
  ["matchmakeStart", "matchmakeStart (POST /matchmake — room create)"],
  ["matchmakeEnd", "matchmakeEnd (server has a room + seat)"],
  ["wsCreate", "wsCreate (client opens the socket)"],
  ["wsOpen", "wsOpen (socket handshake done)"],
  ["firstState", "firstState (first >=1KB server frame)"],
  ["avatarIn", "avatarIn (__ml.players() >= 1)"],
  ["overlayHidden", "overlayHidden (#ml-loading gone)"],
  ["playable", "PLAYABLE"],
];

function report(runs) {
  const good = runs.filter((r) => r.ok);
  if (!good.length) die("every run timed out before the world was playable");
  const val = (r, k) => (k in r.nav ? r.nav[k] : r.marks[k]);
  const rows = [];
  let prevMedian = 0;
  for (const [k, label] of CHAIN) {
    const xs = good.map((r) => val(r, k)).filter((v) => typeof v === "number");
    const s = stat(xs);
    if (!s) continue;
    const delta = k === "ttfb" ? s.median : s.median - prevMedian;
    prevMedian = s.median;
    rows.push({ key: k, label, ...s, delta });
  }
  const wid = Math.max(...rows.map((r) => r.label.length));
  console.log("");
  console.log(
    `MARK${" ".repeat(wid - 4)}   median      Δ       min       max   (n=${good.length}${good.length < runs.length ? `, ${runs.length - good.length} timed out` : ""})`,
  );
  console.log("-".repeat(wid + 44));
  for (const r of rows)
    console.log(
      `${r.label.padEnd(wid)}  ${(r.median / 1000).toFixed(2).padStart(6)}s ` +
        `${(r.delta / 1000).toFixed(2).padStart(6)}s ` +
        `${(r.min / 1000).toFixed(2).padStart(8)}s ${(r.max / 1000).toFixed(2).padStart(8)}s`,
    );

  const cats = {};
  for (const r of good)
    for (const [c, v] of Object.entries(r.requests.cats)) {
      (cats[c] ??= { n: [], bytes: [] }).n.push(v.n);
      cats[c].bytes.push(v.bytes);
    }
  console.log("");
  console.log("REQUESTS UP TO PLAYABLE (median; bytes = actually delivered before playable)");
  const order = Object.entries(cats).sort((a, b) => med(b[1].n) - med(a[1].n));
  for (const [c, v] of order)
    console.log(`  ${c.padEnd(18)} ${String(med(v.n)).padStart(5)} reqs   ${(med(v.bytes) / 1048576).toFixed(2).padStart(7)} MB`);
  console.log(
    `  ${"TOTAL".padEnd(18)} ${String(med(good.map((r) => r.requests.total))).padStart(5)} reqs   ` +
      `${(med(good.map((r) => r.requests.bytes)) / 1048576).toFixed(2).padStart(7)} MB` +
      `   (${med(good.map((r) => r.requests.inflight))} still in flight, ` +
      `+${med(good.map((r) => r.requests.afterPlayable))} started after playable)`,
  );
  const big = good[good.length >> 1].requests.big ?? [];
  if (big.length)
    console.log(
      `  biggest: ${big
        .slice(0, 5)
        .map(([n, p]) => `${(n / 1048576).toFixed(2)}MB ${p}`)
        .join("  ")}`,
    );
  console.log(
    `  long tasks: ${med(good.map((r) => r.longtasks.n))} totalling ${med(good.map((r) => r.longtasks.ms))}ms, ` +
      `worst ${med(good.map((r) => r.longtasks.worst))}ms   ws: ${med(good.map((r) => r.ws.msgs))} msgs / ` +
      `${(med(good.map((r) => r.ws.bytes)) / 1024).toFixed(0)} KB`,
  );
  const errs = good.flatMap((r) => r.errors);
  if (errs.length) console.log(`  page errors: ${[...new Set(errs)].slice(0, 3).join(" | ")}`);

  // THE HEADLINE. Two numbers, and the second one is the one to optimise
  // against day to day:
  //  * PLAYABLE is the maintainer's definition and includes the scripted
  //    reveal cinematic (loading.ts: 0.45s logo fade, a >=700ms / >=6-frame
  //    floor, then a 0.8s black fade). Its floor is ~1.5s of wall clock that
  //    no asset work can remove — and under headless software GL the frame
  //    floor stretches, so this mark carries most of the run-to-run spread.
  //  * AVATAR IN is the same boot minus that cinematic: the frame where the
  //    world exists and the player's own avatar is in it. Low noise, and it
  //    moves if and only if real work moved.
  const pl = stat(good.map((r) => r.marks.playable));
  const av = stat(good.map((r) => r.marks.avatarIn).filter((v) => typeof v === "number"));
  console.log("");
  console.log(
    `HEADLINE  playable ${(pl.median / 1000).toFixed(2)}s [${(pl.min / 1000).toFixed(2)}–${(pl.max / 1000).toFixed(2)}]   ` +
      (av ? `avatarIn ${(av.median / 1000).toFixed(2)}s [${(av.min / 1000).toFixed(2)}–${(av.max / 1000).toFixed(2)}]   ` : "") +
      `throttle=${THROTTLE} cpu=${CPU}x n=${good.length}`,
  );

  return { rows, cats, good };
}

// ---------------------------------------------------------------- main
const built = ensureBuild();
const port = args.port ? Number(args.port) : await freePort();
const origin = `http://127.0.0.1:${port}`;
let server = null;
if (!args.port) server = await startServer(port);
else if (!(await waitHealthy(origin, 5000))) die(`--port=${port} given but nothing healthy is listening there`);

let sha = "";
try {
  sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
} catch {}

console.log(
  `[boottime] ${built}; prod server on ${origin}; world=${WORLD} char=${CHARACTER} ` +
    `viewport=${VW}x${VH} throttle=${THROTTLE} cpu=${CPU}x runs=${RUNS} (+${WARMUP} warm-up)${LABEL ? ` label=${LABEL}` : ""}`,
);

const runs = [];
try {
  for (let i = 0; i < WARMUP; i++) await runOnce(origin, i + 1, "warmup ");
  for (let i = 0; i < RUNS; i++) runs.push(await runOnce(origin, i + 1, ""));
} finally {
  server?.stop();
}

const { rows, cats, good } = report(runs);

const record = {
  ts: new Date().toISOString(),
  sha,
  label: LABEL,
  throttle: THROTTLE,
  cpu: CPU,
  runs: good.length,
  attempted: runs.length,
  viewport: `${VW}x${VH}`,
  world: WORLD,
  character: CHARACTER,
  marks: Object.fromEntries(rows.map((r) => [r.key, { median: Math.round(r.median), min: Math.round(r.min), max: Math.round(r.max) }])),
  requests: {
    total: med(good.map((r) => r.requests.total)),
    bytes: med(good.map((r) => r.requests.bytes)),
    cats: Object.fromEntries(Object.entries(cats).map(([c, v]) => [c, { n: med(v.n), bytes: med(v.bytes) }])),
  },
  longtasks: { n: med(good.map((r) => r.longtasks.n)), ms: med(good.map((r) => r.longtasks.ms)) },
  raw: good.map((r) => Math.round(r.marks.playable)),
};
try {
  mkdirSync(dirname(OUTFILE), { recursive: true });
  appendFileSync(OUTFILE, JSON.stringify(record) + "\n");
  console.log(`\n[boottime] appended to ${OUTFILE}`);
} catch (e) {
  console.log(`\n[boottime] could not write ${OUTFILE}: ${e.message}`);
}
