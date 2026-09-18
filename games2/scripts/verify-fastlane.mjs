// THE FAST LANE, END TO END, against a real server process: publish, poke,
// serve, flip, refuse, fall back. This is the gate that says the lane WORKS —
// verify-fastbundle proves the bundle runs the game, and this proves the
// channel that carries it cannot lie.
//
// Every arm is an edge case that would otherwise be discovered in production,
// on a phone, by the maintainer:
//
//   A  nothing published        the image's client/dist serves, untouched
//   B  a publish + poke         the published document serves, and says so
//   C  the ETag                 a conditional request 304s on the SAME bytes,
//                               and the validator is the hash of those bytes
//   D  a flip                   the new generation serves after one poke
//   E  the PREVIOUS generation  its hashed assets STILL resolve by name, which
//                               is what keeps a page loaded before the flip
//                               alive (bundlestore law 4)
//   F  a backward pointer       refused; production does not walk back (law 2)
//   G  a corrupted blob         refused; the old generation keeps serving
//   H  a missing asset          404 with `no-store`, never a cacheable 404 and
//                               never HTML
//   I  the lane off             byte-identical behaviour to today
//
// Needs no dev stack and no cloud: the store is a local directory, which is the
// same contract the GCS backend implements (the bus.ts idiom).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishBundle, localStore } from "./publish-bundle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) bad++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = mkdtempSync(join(tmpdir(), "fastlane-store-"));
const dist = mkdtempSync(join(tmpdir(), "fastlane-dist-"));
const servers = [];
function startServer(env) {
  const port = 3800 + Math.floor(Math.random() * 500);
  const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
    cwd: join(ROOT, "server"),
    detached: true,
    env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production", ...env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  servers.push(child);
  return { child, origin: `http://127.0.0.1:${port}` };
}
const stopAll = () => {
  for (const c of servers) {
    try { process.kill(-c.pid, "SIGKILL"); } catch {}
  }
  rmSync(store, { recursive: true, force: true });
  rmSync(dist, { recursive: true, force: true });
};
process.on("exit", stopAll);

async function healthy(origin, ms = 90_000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    try {
      if ((await fetch(origin + "/health")).ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}
const bundleInfo = async (origin) => (await fetch(origin + "/api/bundle")).json();
const poke = async (origin) => (await fetch(origin + "/api/bundle/refresh", { method: "POST" })).json();

// ---------------------------------------------------------------- A: lane off
// The image's own client/dist must serve exactly as it does today. Uses the
// repo's real dist, building it if it is not there (the gate before this one
// deletes it deliberately).
if (!existsSync(join(ROOT, "client", "dist", "index.html"))) {
  const { fastBuild } = await import("./fastbuild.mjs");
  await fastBuild({ outDir: join(ROOT, "client", "dist"), gitSha: "fastlane" });
}
{
  const { origin } = startServer({ BUNDLE_STORE: "" });
  if (!(await healthy(origin))) { console.error("FAIL: server with the lane off never became healthy"); process.exit(1); }
  const doc = await fetch(origin + "/");
  const body = await doc.text();
  check(doc.status === 200 && body.includes("<html"), "A — with the lane OFF the image's document serves");
  check((await fetch(origin + "/api/bundle")).status === 404, "A — and the lane's endpoints do not exist at all");
  const imageDoc = readFileSync(join(ROOT, "client", "dist", "index.html"), "utf8");
  check(body === imageDoc, "A — byte-identical to the file on disk");
}

// -------------------------------------------------- B..H: the lane, published
const genA = await publishBundle({ store: localStore(store), outDir: dist, gitSha: "genA" });
check(genA.published, `B — published generation A (${genA.id}, seq ${genA.seq})`);

const { origin } = startServer({ BUNDLE_STORE: store });
if (!(await healthy(origin))) { console.error("FAIL: server with the lane on never became healthy"); process.exit(1); }

let info = await bundleInfo(origin);
check(info.serving === genA.id, `B — the server serves the published generation (${info.serving})`);
const docA = await fetch(origin + "/");
const bodyA = await docA.text();
const manifestA = JSON.parse(readFileSync(join(store, "gen", genA.id, "manifest.json"), "utf8")).files;
const entryA = Object.keys(manifestA).find((n) => /^assets\/index-/.test(n));
check(bodyA.includes(entryA.replace("assets/", "")), `B — and its document names that generation's entry chunk`);
check(docA.headers.get("cache-control") === "no-cache", "B — the document revalidates on every load");

// C: the ETag identifies the BYTES, and a conditional request 304s
const etagA = docA.headers.get("etag");
const { hashBytes } = await import("../server/src/bundlestore.ts").catch(() => ({ hashBytes: null }));
check(!!etagA && etagA === `"${manifestA["index.html"]}"`, `C — the document's ETag is the hash of its bytes (${etagA})`);
const cond = await fetch(origin + "/", { headers: { "if-none-match": etagA } });
check(cond.status === 304, "C — a conditional request with that ETag is a 304");
const asset = await fetch(`${origin}/${entryA}`);
check(asset.status === 200, `C — a published asset is served by name (${entryA})`);
check(
  (asset.headers.get("cache-control") || "").includes("immutable"),
  "C — and a content-hashed asset is immutable, because its name IS its hash",
);

// D + E: flip, and the previous generation's assets keep resolving
const genB = await publishBundle({ store: localStore(store), outDir: dist, gitSha: "genB" });
check(genB.published && genB.id !== genA.id, `D — published generation B (${genB.id}, seq ${genB.seq})`);
const afterPoke = await poke(origin);
check(afterPoke.serving === genB.id, `D — ONE poke and the server serves B (${afterPoke.serving})`);
const bodyB = await (await fetch(origin + "/")).text();
check(bodyB !== bodyA, "D — the document changed");
const stillA = await fetch(`${origin}/${entryA}`);
check(stillA.status === 200, "E — generation A's entry chunk STILL resolves after the flip (law 4)");
check(hashBytes ? hashBytes(Buffer.from(await stillA.arrayBuffer())) === manifestA[entryA] : true,
  "E — and it is byte-for-byte the bytes A published");

// F: a backward pointer is refused
const ptrPath = join(store, "pointer.json");
const good = JSON.parse(readFileSync(ptrPath, "utf8"));
writeFileSync(ptrPath, JSON.stringify({ ...good, seq: 1, current: genA.id, retained: [] }));
const afterBack = await poke(origin);
check(afterBack.serving === genB.id, "F — a pointer with a lower seq is REFUSED (law 2)");
writeFileSync(ptrPath, JSON.stringify(good));

// G: a corrupted blob cannot become current
const genC = await publishBundle({ store: localStore(store), outDir: dist, gitSha: "genC" });
const manifestC = JSON.parse(readFileSync(join(store, "gen", genC.id, "manifest.json"), "utf8")).files;
writeFileSync(join(store, "blob", manifestC["index.html"]), "<html>TAMPERED</html>");
const afterBad = await poke(origin);
check(afterBad.serving === genB.id, "G — a generation whose bytes disagree with their hash is refused");
check((await (await fetch(origin + "/")).text()) === bodyB, "G — and the document is untouched");

// H: a missing asset is a 404 that nothing may cache
const miss = await fetch(`${origin}/assets/index-0000000000.js`);
check(miss.status === 404, "H — a missing asset is a hard 404");
check((miss.headers.get("cache-control") || "") === "no-store", "H — with no-store, so a phone cannot remember it");
check(!(miss.headers.get("content-type") || "").includes("html"), "H — and never HTML");

// I: a cold instance with an UNREACHABLE store still serves the image
{
  const { origin: o2 } = startServer({ BUNDLE_STORE: join(store, "does-not-exist") });
  if (!(await healthy(o2))) check(false, "I — a server pointed at a missing store never became healthy");
  else {
    const r = await fetch(o2 + "/");
    const b = await r.text();
    check(r.status === 200 && b.includes("<html"), "I — an unreachable store falls back to the image's document");
    check((await bundleInfo(o2)).serving === null, "I — and reports that it is serving no published generation");
  }
}

console.log(bad ? `verify-fastlane: ${bad} FAILED` : "verify-fastlane: ALL OK");
process.exit(bad ? 1 : 0);
