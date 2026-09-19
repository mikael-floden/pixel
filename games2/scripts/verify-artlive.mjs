#!/usr/bin/env node
// THE ART LANE, AGAINST PRODUCTION, AFTER THE PUBLISH. verify-artlane proves
// the mechanism on a local server; this proves THE ART REACHED PLAYERS, which
// is the only claim the maintainer can check from a phone and the only one the
// lane exists to make.
//
// It answers four questions and nothing else:
//   1. is the generation we published the one being served?
//   2. do the art paths it published answer with the bytes it published?
//   3. does /asset-index.json name those hashes, so a browser asks with ?h=
//      and earns the year?
//   4. and can ?v=<the image's sha> still NOT freeze one of them?
//
// (4) is the one that must never regress. It is the whole safety argument of
// this lane in one request, and it is cheap, so it is asked in production on
// every publish rather than trusted from a unit test.
//
//   node scripts/verify-artlive.mjs --gen <id> --store <dir> [--origin <url>]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const ORIGIN = (arg("origin", process.env.IMAGE_ORIGIN || "https://nangijala.online")).replace(/\/+$/, "");
const GEN = arg("gen", "");
const STORE = arg("store", "");
const SAMPLE = Number(arg("sample", 12));
const IMMUTABLE = "public, max-age=31536000, immutable";
const h16 = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

let bad = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) bad++;
};
const get = (p, init) => fetch(ORIGIN + p, { headers: { "cache-control": "no-store" }, ...init });

if (!GEN || !STORE) {
  console.error("usage: verify-artlive.mjs --gen <id> --store <store dir> [--origin <url>] [--sample <n>]");
  process.exit(2);
}

// 1. the generation
const state = await (await get("/api/bundle")).json();
check(state.serving === GEN, `the published generation is serving (serving ${state.serving}, want ${GEN})`);
if (state.serving !== GEN) {
  console.log("  the store's own reason:");
  for (const line of state.recent ?? []) console.log(`    ${line}`);
  process.exit(1); // nothing below can mean anything
}
console.log(`  overlay: ${JSON.stringify(state.overlay)}`);

const manifest = JSON.parse(readFileSync(join(STORE, "gen", GEN, "manifest.json"), "utf8"));
const art = Object.entries(manifest.art ?? {});
const root = Object.entries(manifest.root ?? {});
check(state.overlay?.art === art.length, `the server holds all ${art.length} published art file(s) (it says ${state.overlay?.art})`);
check(state.overlay?.root === root.length, `and all ${root.length} published dist-root file(s) (it says ${state.overlay?.root})`);

const { image } = await (await get("/version")).json();
const index = await (await get("/asset-index.json")).json();

// 2, 3, 4 — a sample, because an art delta can be thousands of files and this
// runs on every publish. Deterministic (the first N of a sorted list) so a
// failure is reproducible rather than a lottery.
const sample = art.sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, SAMPLE);
for (const [rel, hash] of sample) {
  const r = await get(`/assets/${rel}?h=${hash}`);
  const body = Buffer.from(await r.arrayBuffer());
  const got = h16(body);
  check(r.status === 200 && got === hash, `${rel} serves the published bytes (${got} vs ${hash})`);
  check(r.headers.get("cache-control") === IMMUTABLE, `${rel}?h=<hash> earns the year (${r.headers.get("cache-control")})`);
  check(index.files?.[rel] === hash, `${rel} is named in /asset-index.json at the published hash`);
}
for (const [rel, hash] of root.slice(0, 5)) {
  const r = await get(`/${rel}`);
  const got = h16(Buffer.from(await r.arrayBuffer()));
  check(r.status === 200 && got === hash, `/${rel} serves the published catalog (${got} vs ${hash})`);
}

// 4. THE ONE THAT MUST NEVER REGRESS.
if (sample.length) {
  const [rel] = sample[0];
  const v = await get(`/assets/${rel}?v=${image}`);
  check(
    v.headers.get("cache-control") !== IMMUTABLE,
    `?v=<the image's own sha> does NOT freeze published art (${v.headers.get("cache-control")})`,
  );
}
// And the grant that DOES still work, on something the lane never publishes.
{
  const r = await get(`/logo.webp?v=${image}`);
  check(
    r.status !== 200 || r.headers.get("cache-control") === IMMUTABLE,
    `client/public keeps its ?v grant (${r.headers.get("cache-control")})`,
  );
}

if (!sample.length && !root.length) console.log("  (this generation published no art — the bundle travelled alone)");
console.log(bad ? `\nverify-artlive: ${bad} FAILURE(S)` : "\nverify-artlive: the art is live and correctly cached");
process.exit(bad ? 1 : 0);
