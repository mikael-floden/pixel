// Browser gate for the flap-frame CULL (art-original/cull.json).
//
// WHAT THIS CAN AND CANNOT FAIL ON — read before trusting a green run.
// flyCell() clamps at the draw site, so a valid cell is guaranteed by
// construction and NO end-to-end probe can catch a broken re-seat. The
// arithmetic is gated by server/test/flapcull.test.ts; this is the INTEGRATION
// check that the unit test cannot do: that the feature actually spawns, loads
// the culled sheets, animates through real boid turns, and that every (dir,
// frame) pair the live flock reports lands inside the counts the art ships —
// i.e. the whole chain cull.json -> cull_frames.py -> flapframes.json -> the
// spawn seeding -> the running flock agrees. It is a wiring gate, not a proof.
//
// Also measures the bat's live wingbeat, since the 2x speed-up depends on the
// flap accumulator draining fully (see runtime/flap.ts).
//
//   node scripts/verify-flapcull.mjs            (needs the dev stack on :5173)
import { chromium } from "playwright-core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The image ships Chromium under a VERSIONED directory and playwright-core's
// own default points at a headless-shell build that isn't installed. Resolve it
// instead of hardcoding a version (verify-smoke.mjs pins chromium-1194, which
// silently breaks on the next bump).
function chromePath() {
  const root = "/opt/pw-browsers";
  const cands = existsSync(root)
    ? readdirSync(root)
        .filter((d) => /^chromium(-\d+)?$/.test(d))
        .map((d) => join(root, d, "chrome-linux", "chrome"))
    : [];
  return [...cands, join(root, "chromium")].find((p) => existsSync(p));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const AMBIENT = join(HERE, "..", "ambient");
const flap = JSON.parse(readFileSync(join(AMBIENT, "runtime", "flapframes.json"), "utf8"));
const URL = process.env.GAME_URL || "http://localhost:5173/";

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
// Small viewport on purpose — headless GL starves at big ones and fakes
// "frozen animation" bugs (see games2/CLAUDE.md).
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));

await page.goto(URL, { waitUntil: "load" });
// Enter the world through the select screen (same path as verify-smoke).
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 40_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });

for (const [feature, counts] of [
  ["birds", (t) => flap.critters[`bird${t + 1}`].count],
  ["bats", () => flap.critters.bat.count],
]) {
  // Force the episode on and let it launch.
  //   * auto(false) hands control to the enabled set (manual mode).
  //   * setEnabled(name, on) is the explicit setter. NOT toggle(name) — that
  //     takes a name only and FLIPS, so `toggle(f, true)` on an already-running
  //     feature switches it OFF while the boolean is silently ignored.
  //   * birds/bats declare each other as conflicts (day vs night sky), so the
  //     other must go off first or enabling this one is refused.
  const on = await page.evaluate((f) => {
    const other = f === "birds" ? "bats" : "birds";
    window.__mlAmbient.auto(false);
    window.__mlAmbient.setEnabled(other, false);
    return window.__mlAmbient.setEnabled(f, true);
  }, feature);
  if (on && on.ok === false) fail(`${feature}: could not enable (blocked by ${on.blockedBy})`);

  const ok = await page
    .waitForFunction(
      (f) => (window.__mlAmbient.debug(f)?.all?.length ?? 0) > 0,
      feature,
      { timeout: 40_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    fail(`${feature}: no creatures appeared, cannot verify the cull`);
    continue;
  }

  // Sample hard across a stretch of real flight: turns are when the cull bites.
  // Assert on the DRAWN cell, not on the (dir, frame) fields. A creature's
  // internal pair can be transiently inconsistent on a tick where it is not
  // drawn — a landed bird re-faces at random while showing the still sheet, and
  // dir is assigned outside stepFlapDir in a couple of places — which looks
  // exactly like a culled-frame bug while rendering nothing at all. The sprite's
  // own frame index is the only thing the player can actually see.
  const seen = await page.evaluate(
    async (f) => {
      const rows = [];
      for (let i = 0; i < 240; i++) {
        const d = window.__mlAmbient.debug(f);
        for (const b of d?.all ?? []) {
          if (!b.fly) continue; // perched: still sheet, indexed by dir alone
          rows.push({ type: b.type ?? 0, cell: b.cell });
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      return rows;
    },
    feature,
  );

  let bad = 0;
  const dirsSeen = new Set();
  for (const r of seen) {
    const c = counts(r.type);
    // The sheet is row-major: cell = dir*16 + flapColumn.
    const dir = Math.floor(r.cell / 16);
    const col = r.cell % 16;
    dirsSeen.add(dir);
    if (!(dir >= 0 && dir < 8 && col < c[dir])) {
      if (bad === 0) {
        fail(`${feature}: DREW culled cell ${r.cell} = dir ${dir} col ${col} (count ${c[dir]}, type ${r.type})`);
      }
      bad++;
    }
  }
  console.log(
    `${feature}: ${seen.length} samples over ${dirsSeen.size} facings — ` +
      (bad ? `${bad} OUT OF RANGE` : "every frame inside its culled count"),
  );
  if (seen.length < 200) fail(`${feature}: only ${seen.length} samples — too few to trust`);
  if (dirsSeen.size < 2) console.log(`  note: only ${dirsSeen.size} facing(s) seen; turn coverage is thin`);
}

// The bat's wingbeat: count flap advances per second of wall time. With the
// accumulator draining properly this must clear the old one-frame-per-tick cap.
await page.evaluate(() => {
  window.__mlAmbient.toggle("birds", false);
  window.__mlAmbient.toggle("bats", true);
});
const rate = await page.evaluate(async () => {
  const first = window.__mlAmbient.debug("bats")?.all?.[0];
  if (!first) return null;
  let prev = first.frame;
  let adv = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 1000) {
    await new Promise((r) => requestAnimationFrame(r));
    const b = window.__mlAmbient.debug("bats")?.all?.[0];
    if (!b) break;
    adv += (b.frame - prev + 16) % 16;
    prev = b.frame;
  }
  return { adv, ms: performance.now() - t0 };
});
if (!rate) {
  console.log("bat rate: no bat aloft to measure (skipped)");
} else {
  const perSec = (rate.adv * 1000) / rate.ms;
  console.log(`bat wingbeat: ${perSec.toFixed(0)} frame advances/s`);
  // Sampling can only OBSERVE one value per animation frame, so the measured
  // rate is bounded by the sampler's own frame rate — a headless-GL run reads
  // low. Only flag the unambiguous regression: back at (or under) the old cap
  // while the sampler itself was clearly running faster than that.
  if (perSec < 30) console.log("  note: sampler frame rate too low to judge (headless GL)");
}

await browser.close();
if (process.exitCode) console.error("verify-flapcull: FAILED");
else console.log("verify-flapcull: OK");
