import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleStore, localBackend, backendFromEnv, hashBytes, mimeFor } from "../src/bundlestore";

// A generation, written the way publish-bundle.mjs writes one: files first,
// manifest second, pointer last.
function writeGen(root: string, id: string, files: Record<string, string>) {
  const manifest: Record<string, string> = {};
  for (const [name, body] of Object.entries(files)) {
    const hash = hashBytes(Buffer.from(body));
    const full = join(root, "blob", hash);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
    manifest[name] = hash;
  }
  mkdirSync(join(root, "gen", id), { recursive: true });
  writeFileSync(join(root, "gen", id, "manifest.json"), JSON.stringify({ files: manifest }));
  return manifest;
}
const writePointer = (root: string, p: object) => writeFileSync(join(root, "pointer.json"), JSON.stringify(p));
const store = (root: string) => new BundleStore(localBackend(root));
const GEN_A = { "index.html": "<html>A</html>", "assets/index-aaaaaaaa.js": "//A" };
const GEN_B = { "index.html": "<html>B</html>", "assets/index-bbbbbbbb.js": "//B" };

test("with no publication the store serves nothing, so the image bundle keeps serving", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  const s = store(root);
  await s.refresh();
  assert.equal(s.current, null);
  assert.equal(s.pointer, null);
  rmSync(root, { recursive: true, force: true });
});

test("a published generation is adopted, and its files are served by name with their own hash", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  writeGen(root, "aaa", GEN_A);
  writePointer(root, { seq: 1, current: "aaa", retained: [] });
  const s = store(root);
  await s.refresh();
  assert.equal(s.current?.id, "aaa");
  const html = s.current!.files.get("index.html")!;
  assert.equal(html.bytes.toString(), "<html>A</html>");
  // LAW 1: the ETag is the hash of the BYTES SERVED. Identical bytes on every
  // instance, so one validator can never name two documents.
  assert.equal(html.hash, hashBytes(Buffer.from("<html>A</html>")));
  assert.equal(html.type, "text/html; charset=utf-8");
  rmSync(root, { recursive: true, force: true });
});

test("a NEWER pointer flips, and the retained generation stays served by name", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  writeGen(root, "aaa", GEN_A);
  writePointer(root, { seq: 1, current: "aaa", retained: [] });
  const s = store(root);
  await s.refresh();
  writeGen(root, "bbb", GEN_B);
  writePointer(root, { seq: 2, current: "bbb", retained: ["aaa"] });
  await s.refresh();
  assert.equal(s.current?.id, "bbb");
  // A page already running the previous generation still resolves its chunk.
  assert.ok(s.generation("aaa"), "the retained generation is still held");
  assert.equal(s.fileFor("assets/index-aaaaaaaa.js")?.bytes.toString(), "//A");
  // ...but the DOCUMENT is never resolvable by name (law 5): index.html means
  // something different in each generation, so it is asked for by generation.
  assert.equal(s.fileFor("index.html"), null);
  assert.equal(s.generation("aaa")!.files.get("index.html")!.bytes.toString(), "<html>A</html>");
  assert.equal(s.current!.files.get("index.html")!.bytes.toString(), "<html>B</html>");
  rmSync(root, { recursive: true, force: true });
});

test("LAW 2 — a pointer that is not newer is REFUSED, so production cannot walk backward", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  writeGen(root, "aaa", GEN_A);
  writeGen(root, "bbb", GEN_B);
  writePointer(root, { seq: 2, current: "bbb", retained: ["aaa"] });
  const s = store(root);
  await s.refresh();
  assert.equal(s.current?.id, "bbb");
  // A stale read: the previous pointer, served by a CDN or a lost race.
  writePointer(root, { seq: 1, current: "aaa", retained: [] });
  await s.refresh();
  assert.equal(s.current?.id, "bbb", "the older pointer must not take effect");
  // Equal seq is refused too: a publisher that did not bump it is not a new
  // generation, whatever it claims.
  writePointer(root, { seq: 2, current: "aaa", retained: [] });
  await s.refresh();
  assert.equal(s.current?.id, "bbb");
  rmSync(root, { recursive: true, force: true });
});

test("LAW 3 — the retained window is materialised even when the current generation is unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  writeGen(root, "aaa", GEN_A);
  writePointer(root, { seq: 1, current: "aaa", retained: [] });
  const s = store(root);
  await s.refresh();
  assert.equal(s.generation("bbb"), null);
  // The pointer now retains a generation we have never held, while CURRENT is
  // the one we already serve — the "normal case" a fast-path early return
  // would skip, leaving a page mid-session unable to import bbb's chunk.
  writeGen(root, "bbb", GEN_B);
  writePointer(root, { seq: 2, current: "aaa", retained: ["bbb"] });
  await s.refresh();
  assert.equal(s.current?.id, "aaa");
  assert.ok(s.generation("bbb"), "the retained generation must be adopted on the no-flip path too");
  rmSync(root, { recursive: true, force: true });
});

test("a HALF-UPLOADED generation is never pointed at", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  writeGen(root, "aaa", GEN_A);
  writePointer(root, { seq: 1, current: "aaa", retained: [] });
  const s = store(root);
  await s.refresh();
  // A manifest naming a file that has not landed yet — the window a publisher
  // would open if it flipped the pointer before finishing its uploads.
  const m = writeGen(root, "ccc", GEN_B);
  m["assets/missing-cccccccc.js"] = "f".repeat(16); // a blob that was never uploaded
  writeFileSync(join(root, "gen", "ccc", "manifest.json"), JSON.stringify({ files: m }));
  writePointer(root, { seq: 2, current: "ccc", retained: ["aaa"] });
  await s.refresh();
  assert.equal(s.current?.id, "aaa", "an incomplete generation must not become current");
  rmSync(root, { recursive: true, force: true });
});

test("bytes that do not match the manifest's hash are refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  writeGen(root, "aaa", GEN_A);
  writePointer(root, { seq: 1, current: "aaa", retained: [] });
  const s = store(root);
  await s.refresh();
  // A manifest naming a hash whose blob holds DIFFERENT bytes.
  const m = writeGen(root, "ddd", { "index.html": "<html>D</html>" });
  writeFileSync(join(root, "blob", m["index.html"]), "<html>TAMPERED</html>");
  writePointer(root, { seq: 2, current: "ddd", retained: ["aaa"] });
  await s.refresh();
  assert.equal(s.current?.id, "aaa", "bytes must match the name they were published under");
  rmSync(root, { recursive: true, force: true });
});

test("a malformed or unreadable pointer keeps what we have", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  writeGen(root, "aaa", GEN_A);
  writePointer(root, { seq: 1, current: "aaa", retained: [] });
  const s = store(root);
  await s.refresh();
  writeFileSync(join(root, "pointer.json"), "{ not json");
  await s.refresh();
  assert.equal(s.current?.id, "aaa");
  writePointer(root, { seq: 3 }); // no `current`
  await s.refresh();
  assert.equal(s.current?.id, "aaa");
  rmSync(root, { recursive: true, force: true });
});

test("a generation with no index.html is not a generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  writeGen(root, "eee", { "assets/index-eeeeeeee.js": "//E" });
  writePointer(root, { seq: 1, current: "eee", retained: [] });
  const s = store(root);
  await s.refresh();
  assert.equal(s.current, null);
  rmSync(root, { recursive: true, force: true });
});

test("the store escapes nothing: a path climbing out of the root cannot be read", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  const b = localBackend(root);
  assert.equal(await b.get("../../etc/passwd"), null);
  rmSync(root, { recursive: true, force: true });
});

test("BUNDLE_STORE unset means the lane is OFF — nothing about serving changes", () => {
  assert.equal(backendFromEnv({} as NodeJS.ProcessEnv), undefined);
  assert.equal(backendFromEnv({ BUNDLE_STORE: "" } as NodeJS.ProcessEnv), undefined);
  assert.equal(backendFromEnv({ BUNDLE_STORE: "/tmp/x" } as NodeJS.ProcessEnv)?.label, "local:/tmp/x");
  assert.equal(backendFromEnv({ BUNDLE_STORE: "gs://b/p" } as NodeJS.ProcessEnv)?.label, "gs://b/p");
  assert.equal(backendFromEnv({ BUNDLE_STORE: "gs://b" } as NodeJS.ProcessEnv)?.label, "gs://b/bundle");
});

test("mime types cover what a client bundle actually contains", () => {
  assert.equal(mimeFor("index.html"), "text/html; charset=utf-8");
  assert.equal(mimeFor("assets/index-aaaaaaaa.js"), "text/javascript; charset=utf-8");
  assert.equal(mimeFor("assets/fly-12345678.webp"), "image/webp");
  assert.equal(mimeFor("assets/x-12345678.weird"), "application/octet-stream");
});

test("a REAL publish round-trips: publish-bundle.mjs writes what BundleStore reads", async () => {
  // The two halves of the lane, against each other, with no mocks between them.
  // The publisher is a plain .mjs script (it runs in CI with no build step), so
  // it is imported through a computed specifier: a literal one makes tsc demand
  // a declaration file for a file that deliberately has none.
  type Pub = {
    publishBundle: (o: { store: unknown; outDir: string; gitSha?: string; dryRun?: boolean }) => Promise<{
      id: string; published: boolean; ms: number; seq: number; files?: number;
    }>;
    localStore: (root: string) => unknown;
  };
  const { publishBundle, localStore } = (await import(
    new URL("../../scripts/publish-bundle.mjs", import.meta.url).href
  )) as Pub;
  const root = mkdtempSync(join(tmpdir(), "bs-real-"));
  const out = mkdtempSync(join(tmpdir(), "bs-dist-"));
  const r = await publishBundle({ store: localStore(root), outDir: out, gitSha: "roundtrip" });
  assert.ok(r.published, "the first publish publishes");
  assert.equal(r.seq, 1);

  const s = store(root);
  await s.refresh();
  assert.equal(s.current?.id, r.id, "the store serves the generation that was published");
  const html = s.current!.files.get("index.html")!;
  assert.ok(html.bytes.toString().includes("index-"), "and its index.html names a hashed bundle");
  // Every file the manifest named is present and hash-verified (load() refuses
  // otherwise, so a non-null generation IS that assertion) — check the count.
  assert.equal(s.current!.files.size, r.files);

  // IDEMPOTENT for the same inputs: the id is the CONTENT, so a rebuild that
  // changed nothing publishes nothing and cannot disturb an open page.
  const same = await publishBundle({ store: localStore(root), outDir: out, gitSha: "roundtrip" });
  assert.equal(same.published, false, "an unchanged rebuild publishes nothing");
  assert.equal(same.id, r.id);

  /* ...BUT THE SHA IS PART OF THE CONTENT TODAY, and that is worth asserting
   * rather than hoping otherwise. fastbuild bakes VITE_GIT_SHA into the bundle
   * (client/src/assetver.ts stamps ?v=<sha> on art with it, main.ts shows it as
   * the version badge), so identical SOURCES under a new sha are new BYTES and
   * therefore a new generation. Consequences, both real:
   *   - every deploy republishes the client even when no client source moved,
   *     so a returning phone re-downloads 2.5 MB it already had;
   *   - the id cannot be used as a document validator across shas — which is
   *     exactly the trap LAW 1 in bundlestore.ts describes, and the reason the
   *     ETag there is the hash of the bytes served instead.
   * Taking the stamp out of the bundle (the client reading its sha from
   * /version, which it already fetches) is the follow-up that makes an
   * art-only deploy free for the client. Until then, this is the truth. */
  const otherSha = await publishBundle({ store: localStore(root), outDir: out, gitSha: "another-sha" });
  assert.ok(otherSha.published, "a new sha is new bytes, so it publishes");
  assert.notEqual(otherSha.id, r.id, "and is a different generation");
  assert.equal(otherSha.seq, r.seq + 1, "with the seq bumped, so the flip is monotonic");

  rmSync(root, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test("LAW 1 — a generation that redefines a CONTENT-HASHED name is refused outright", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  writeGen(root, "aaa", GEN_A);
  writePointer(root, { seq: 1, current: "aaa", retained: [] });
  const s = store(root);
  await s.refresh();
  // Same hashed name, different bytes: impossible from a real bundler, and a
  // cache bug if it ever happened, because a page holding the old chunk would
  // be handed the new one under the identical URL.
  writeGen(root, "fff", { "index.html": "<html>F</html>", "assets/index-aaaaaaaa.js": "//DIFFERENT" });
  writePointer(root, { seq: 2, current: "fff", retained: ["aaa"] });
  await s.refresh();
  assert.equal(s.current?.id, "aaa", "the redefining generation must not become current");
  assert.equal(s.fileFor("assets/index-aaaaaaaa.js")?.bytes.toString(), "//A", "and the name keeps its bytes");
  rmSync(root, { recursive: true, force: true });
});

test("the GitHub backend parses the spec the deploy sets, and only valid ones", () => {
  const b = backendFromEnv({ BUNDLE_STORE: "github:mikael-floden/pixel@bundle-store/bundle" } as NodeJS.ProcessEnv);
  assert.equal(b?.label, "github:mikael-floden/pixel@bundle-store/bundle");
  // no prefix -> the default
  assert.equal(
    backendFromEnv({ BUNDLE_STORE: "github:o/r@br" } as NodeJS.ProcessEnv)?.label,
    "github:o/r@br/bundle",
  );
  // no branch is not a store: better OFF (the image serves) than reading main
  // by accident, which is a different tree from the one publishes go to.
  assert.equal(backendFromEnv({ BUNDLE_STORE: "github:o/r" } as NodeJS.ProcessEnv), undefined);
});

test("a GitHub backend that cannot reach anything returns null, never throws", async () => {
  // The contract the store depends on: unreachable is "keep what we have".
  const { githubBackend } = await import("../src/bundlestore");
  const b = githubBackend("this-owner-does-not-exist-9z/nope", "no-such-branch", "bundle");
  assert.equal(await b.get("pointer.json"), null);
  assert.deepEqual(await b.list("gen"), []);
});
