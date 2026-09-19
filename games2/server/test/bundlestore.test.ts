import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleStore, localBackend, backendFromEnv, hashBytes, mimeFor, onBundleServed } from "../src/bundlestore";

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

// ---------------------------------------------------------------------------
// The defects six adversarial review panels found in this lane before it was
// fired in production. Each test is the failure they described.
// ---------------------------------------------------------------------------

test("a backend that THROWS is 'keep what we have', never a rejection — an unhandled one exits the process", async () => {
  // Colyseus hands an unhandled rejection to its graceful-shutdown path, which
  // disposes every room and calls process.exit(1). A DNS hiccup reading a
  // pointer must never cost the authoritative world.
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  writeGen(root, "aaa", GEN_A);
  writePointer(root, { seq: 1, current: "aaa", retained: [] });
  const good = localBackend(root);
  let boom = false;
  const flaky = {
    label: "flaky",
    async get(p: string) {
      if (boom) throw new Error("ECONNRESET, simulated");
      return good.get(p);
    },
    async list(p: string) {
      if (boom) throw new Error("ECONNRESET, simulated");
      return good.list(p);
    },
  };
  const s = new BundleStore(flaky);
  await s.refresh();
  assert.equal(s.current?.id, "aaa");

  boom = true;
  await assert.doesNotReject(() => s.refresh()); // the whole point
  assert.equal(s.current?.id, "aaa", "a throwing backend leaves production exactly as it was");

  // and a generation that throws PART WAY through must not flip either
  boom = false;
  writeGen(root, "bbb", GEN_B);
  writePointer(root, { seq: 2, current: "bbb", retained: ["aaa"] });
  boom = true;
  await assert.doesNotReject(() => s.refresh(true));
  assert.equal(s.current?.id, "aaa", "an unreadable NEW generation is not adopted");
  boom = false;
  await s.refresh(true);
  assert.equal(s.current?.id, "bbb", "and it is adopted once the store is readable again");
  rmSync(root, { recursive: true, force: true });
});

test("the POKE forces a NEW read; a plain refresh reuses the one in flight", async () => {
  // refresh() coalesces. A poke that joins a read taken BEFORE the publisher
  // wrote the pointer answers 200 naming the OLD generation, and the publish
  // then looks like a no-op until the 60 s belt comes round. The contract the
  // fix adds, asserted directly: a forced refresh does not reuse an in-flight
  // result, it reads again.
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  writeGen(root, "aaa", GEN_A);
  writePointer(root, { seq: 1, current: "aaa", retained: [] });
  const good = localBackend(root);
  let reads = 0;
  let hold: Promise<void> | null = null;
  const counting = {
    label: "counting",
    async get(path: string) {
      if (path === "pointer.json") {
        reads++;
        if (hold) await hold;
      }
      return good.get(path);
    },
    list: (path: string) => good.list(path),
  };
  const s2 = new BundleStore(counting);
  await s2.refresh();
  assert.equal(s2.current?.id, "aaa");
  assert.equal(reads, 1);

  // block the next pointer read, start it, and let a plain and a forced
  // refresh both arrive while it is stuck
  let release!: () => void;
  hold = new Promise<void>((r) => { release = r; });
  const inflight = s2.refresh();
  assert.equal(reads, 2, "the in-flight refresh has taken its read and is stuck on it");
  const plain = s2.refresh(); // must JOIN: no new read
  assert.equal(reads, 2, "a plain refresh reuses the read already in flight, it does not take its own");

  hold = null;
  release();
  await inflight;
  await plain;
  assert.equal(reads, 2, "still two: the plain refresh added none");

  // now publish, and poke
  writeGen(root, "bbb", GEN_B);
  writePointer(root, { seq: 2, current: "bbb", retained: ["aaa"] });
  await s2.refresh(true);
  assert.equal(reads, 3, "the forced refresh read the pointer AGAIN rather than reusing a result");
  assert.equal(s2.current?.id, "bbb", "and saw the flip");
  rmSync(root, { recursive: true, force: true });
});

test("a generation whose DOCUMENT names a file it does not carry is refused, not served as a black page", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  writeGen(root, "aaa", GEN_A);
  writePointer(root, { seq: 1, current: "aaa", retained: [] });
  const s = store(root);
  await s.refresh();
  assert.equal(s.current?.id, "aaa");

  // a document referencing a chunk absent from its own manifest passes every
  // hash test there is — the file it would check simply is not listed
  writeGen(root, "bad", {
    "index.html": '<html><script type="module" src="/assets/index-missing0.js"></script></html>',
    "assets/index-cccccccc.js": "//C",
  });
  writePointer(root, { seq: 2, current: "bad", retained: ["aaa"] });
  await s.refresh(true);
  assert.equal(s.current?.id, "aaa", "refused: it would have loaded, reported healthy and rendered nothing");
  rmSync(root, { recursive: true, force: true });
});

test("BYTES are evicted outside the window; NAMES are remembered, so law 1 stays absolute", async () => {
  // Holding every generation forever is an OOM on --memory 1Gi
  // --max-instances 1, and the world dies with the process.
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  const s = store(root);
  const ids: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const id = `gen${i}`;
    ids.push(id);
    writeGen(root, id, { "index.html": `<html>${i}</html>`, [`assets/index-${String(i).repeat(8)}.js`]: `//${i}` });
    writePointer(root, { seq: i, current: id, retained: ids.slice(0, -1).reverse().slice(0, 2) });
    await s.refresh(true);
    assert.equal(s.current?.id, id);
  }
  assert.ok(s.held <= 3, `the window is bounded (held ${s.held})`);
  // the generation served immediately before the current one still resolves
  assert.ok(s.fileFor("assets/index-55555555.js"), "the previous generation's chunk still resolves");
  // one well past the window is a coherent MISS — never wrong bytes
  assert.equal(s.fileFor("assets/index-11111111.js"), null, "a name past the window answers null, not other bytes");

  // AND the name is still remembered, so a generation may not redefine it
  writeGen(root, "evil", { "index.html": "<html>evil</html>" });
  const evilManifest = JSON.parse(readFileSync(join(root, "gen", "evil", "manifest.json"), "utf8"));
  evilManifest.files["assets/index-11111111.js"] = hashBytes(Buffer.from("//DIFFERENT"));
  writeFileSync(join(root, "blob", evilManifest.files["assets/index-11111111.js"]), "//DIFFERENT");
  writeFileSync(join(root, "gen", "evil", "manifest.json"), JSON.stringify(evilManifest));
  writePointer(root, { seq: 99, current: "evil", retained: [] });
  await s.refresh(true);
  assert.notEqual(s.current?.id, "evil", "a hashed name that ever meant one thing can never come back meaning another");
  rmSync(root, { recursive: true, force: true });
});

test("a generation disagreeing with the image it falls through to is refused (mixed generation)", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  writeGen(root, "aaa", GEN_A);
  writePointer(root, { seq: 1, current: "aaa", retained: [] });
  const seen: Record<string, string>[] = [];
  const s = new BundleStore(localBackend(root), (ft) => {
    seen.push(ft);
    return Object.keys(ft).filter((k) => ft[k] === "wrong");
  });
  await s.refresh();
  assert.equal(s.current?.id, "aaa", "no fallthrough recorded: nothing to disagree with");

  const m = JSON.parse(readFileSync(join(root, "gen", "aaa", "manifest.json"), "utf8"));
  writeGen(root, "mix", GEN_B);
  const m2 = JSON.parse(readFileSync(join(root, "gen", "mix", "manifest.json"), "utf8"));
  m2.fallthrough = { "monsters.json": "wrong" };
  writeFileSync(join(root, "gen", "mix", "manifest.json"), JSON.stringify(m2));
  writePointer(root, { seq: 2, current: "mix", retained: ["aaa"] });
  await s.refresh(true);
  assert.equal(s.current?.id, "aaa", "new code against the image's OLD data is refused");

  m2.fallthrough = { "monsters.json": "agreed" };
  writeFileSync(join(root, "gen", "mix", "manifest.json"), JSON.stringify(m2));
  writePointer(root, { seq: 3, current: "mix", retained: ["aaa"] });
  await s.refresh(true);
  assert.equal(s.current?.id, "mix", "and an agreeing one is adopted — the check is not simply refusing everything");
  void m;
  rmSync(root, { recursive: true, force: true });
});

test("the IMAGE wins against a generation published from an earlier commit, and a tie", async () => {
  // `seq` orders publishes against EACH OTHER and says nothing about the
  // image. A generation published from an earlier commit is perfectly
  // monotonic, so without this guard a container rollout is silently
  // overridden by an older client — a rollback nobody asked for, and a
  // mismatched client/server pair. It is also what makes the image a FLOOR
  // again: a bad publish is undone by the next container deploy, which is the
  // only recovery a phone-only maintainer has.
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  const prev = process.env.GIT_COMMIT_TS;
  try {
    process.env.GIT_COMMIT_TS = "1000";
    const s3 = store(root);

    // read the getter through a local each time: assert.equal narrows its
    // declared type to null, and TypeScript cannot know a getter changes
    const idOf = (b: BundleStore): string | null => b.current?.id ?? null;

    writeGen(root, "older", GEN_A);
    writePointer(root, { seq: 1, current: "older", retained: [], commit_ts: 900 });
    await s3.refresh(true);
    assert.equal(idOf(s3), null, "a client from before this image is refused");

    writeGen(root, "tie", GEN_B);
    writePointer(root, { seq: 2, current: "tie", retained: [], commit_ts: 1000 });
    await s3.refresh(true);
    assert.equal(idOf(s3), null, "and a tie goes to the image");

    writeGen(root, "newer", { "index.html": "<html>N</html>", "assets/index-nnnnnnnn.js": "//N" });
    writePointer(root, { seq: 3, current: "newer", retained: [], commit_ts: 1001 });
    await s3.refresh(true);
    assert.equal(idOf(s3), "newer", "one second newer than the image IS adopted");

    // an image that cannot name its own time must not read as "newer"
    delete process.env.GIT_COMMIT_TS;
    const s4 = store(root);
    await s4.refresh(true);
    assert.equal(idOf(s4), null, "an image with no commit time refuses a generation that names one");

    // and an UNSTAMPED generation is ordered on seq alone (local runs, tests)
    process.env.GIT_COMMIT_TS = "1000";
    writeGen(root, "plain", { "index.html": "<html>P</html>", "assets/index-pppppppp.js": "//P" });
    writePointer(root, { seq: 4, current: "plain", retained: [] });
    const s5 = store(root);
    await s5.refresh(true);
    assert.equal(idOf(s5), "plain", "no commit_ts means unordered, not refused");
  } finally {
    if (prev === undefined) delete process.env.GIT_COMMIT_TS;
    else process.env.GIT_COMMIT_TS = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a standing refusal is said ONCE, not once a minute forever", async () => {
  // The 60 s belt re-reads the pointer for the life of the process, so a
  // generation refused for a reason that cannot change until the STORE changes
  // wrote the same line every minute — measured in production: one stale
  // generation filled this 40-line ring and evicted every useful entry, and
  // that ring is what /api/bundle shows a phone.
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  const prev = process.env.GIT_COMMIT_TS;
  try {
    process.env.GIT_COMMIT_TS = "2000";
    const s6 = store(root);
    writeGen(root, "older", GEN_A);
    writePointer(root, { seq: 1, current: "older", retained: [], commit_ts: 1000 });

    for (let i = 0; i < 5; i++) await s6.refresh(true);
    const said = s6.log.filter((l) => l.includes("older")).length;
    assert.equal(said, 1, `five refreshes, one line (got ${said})`);
    assert.equal(s6.current, null);

    // a NEW pointer is news even when it is refused for the same reason
    writeGen(root, "older2", GEN_B);
    writePointer(root, { seq: 2, current: "older2", retained: [], commit_ts: 1500 });
    await s6.refresh(true);
    await s6.refresh(true);
    assert.equal(s6.log.filter((l) => l.includes("older2")).length, 1, "the new pointer speaks once");
    assert.equal(s6.log.filter((l) => l.includes("older")).length >= 2, true, "and the first line is still there");
  } finally {
    if (prev === undefined) delete process.env.GIT_COMMIT_TS;
    else process.env.GIT_COMMIT_TS = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

/* THE FALL-THROUGH SET COMES FROM THE IMAGE, AND A FAILED READ IS A FAILED
 * PUBLISH. Hashing the runner's own dist root refused every generation ever
 * published — the image's client/public is the art pipeline's output and a
 * plain checkout cannot reproduce it (measured 2026-09-19 on generation
 * 34cb856184e86f51: monsters.json differed, shipset.json was absent, 42
 * entries against 43). The publisher now asks the running image. These two
 * arms hold the part that is easy to regress by "helpfully" adding a
 * fallback: the recorded set must be the IMAGE's, and an origin that cannot
 * answer must stop the publish rather than quietly hash the wrong tree. */
test("the publisher records the IMAGE's fall-through set, not its own tree's", async () => {
  type Pub = {
    publishBundle: (o: {
      store: unknown; outDir: string; gitSha?: string; imageOrigin?: string;
    }) => Promise<{ id: string; published: boolean; seq: number }>;
    localStore: (root: string) => unknown;
  };
  const { publishBundle, localStore } = (await import(
    new URL("../../scripts/publish-bundle.mjs", import.meta.url).href
  )) as Pub;
  const http = await import("node:http");

  // An "image" that serves a set deliberately UNLIKE anything the local build
  // produces, so a pass cannot be the local walk agreeing by luck.
  const served = { "catalogs/only-the-image-has-this.json": "feedfacefeedface" };
  const srv = http.createServer((_q, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ git_sha: "imagesha", files: served }));
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const port = (srv.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const root = mkdtempSync(join(tmpdir(), "bs-ft-"));
    const out = mkdtempSync(join(tmpdir(), "bs-ftdist-"));
    const r = await publishBundle({ store: localStore(root), outDir: out, gitSha: "ft", imageOrigin: origin });
    assert.ok(r.published);
    const man = JSON.parse(
      readFileSync(join(root, "gen", r.id, "manifest.json"), "utf8"),
    ) as { fallthrough: Record<string, string> };
    assert.deepEqual(man.fallthrough, served, "the manifest records what the image said it serves");
  } finally {
    await new Promise<void>((ok) => srv.close(() => ok()));
  }
});

test("an image that cannot say what it serves stops the publish, and never falls back", async () => {
  type Pub = {
    publishBundle: (o: {
      store: unknown; outDir: string; gitSha?: string; imageOrigin?: string;
    }) => Promise<unknown>;
    localStore: (root: string) => unknown;
  };
  const { publishBundle, localStore } = (await import(
    new URL("../../scripts/publish-bundle.mjs", import.meta.url).href
  )) as Pub;
  const http = await import("node:http");
  const srv = http.createServer((_q, res) => { res.statusCode = 503; res.end("nope"); });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const port = (srv.address() as { port: number }).port;
  try {
    const root = mkdtempSync(join(tmpdir(), "bs-ftbad-"));
    const out = mkdtempSync(join(tmpdir(), "bs-ftbaddist-"));
    await assert.rejects(
      () => publishBundle({ store: localStore(root), outDir: out, gitSha: "ftbad", imageOrigin: `http://127.0.0.1:${port}` }),
      /could not read what the image serves/,
      "a 503 throws — the local walk is NOT a fallback",
    );
    // And nothing was written: a refused publish leaves the store untouched.
    assert.ok(!existsSync(join(root, "pointer.json")), "no pointer was written");
  } finally {
    await new Promise<void>((ok) => srv.close(() => ok()));
  }
});

/* A FLIP IS ANNOUNCED, A REFUSAL IS NOT. The client polls /version once a
 * minute and only ever offers the banner, so a 66 s deploy could take another
 * 60 s to be noticed — the second wait is what makes a person sit and refresh.
 * WorldRoom relays this announcement over the socket already open. The part
 * worth holding in a test is the NEGATIVE: a generation the store refused must
 * announce nothing, or every open page would be told to expect code that is
 * not being served. */
test("a flip announces what is now serving; a refused generation announces nothing", async () => {
  const seen: { sha: string; id: string }[] = [];
  const off = onBundleServed((sha, id) => seen.push({ sha, id }));
  try {
    const root = mkdtempSync(join(tmpdir(), "bs-say-"));
    writeGen(root, "aaa", GEN_A);
    writePointer(root, { seq: 1, current: "aaa", retained: [], git_sha: "shaAAA" });
    const s = store(root);
    await s.refresh();
    assert.equal(s.current?.id, "aaa");
    assert.deepEqual(seen, [{ sha: "shaAAA", id: "aaa" }], "the adopted generation is announced once");

    // A re-read that changes nothing is not news.
    await s.refresh(true);
    assert.equal(seen.length, 1, "an unchanged re-read announces nothing");

    // A pointer naming a generation that was never written is REFUSED — and
    // must stay silent, because nothing new is being served.
    writePointer(root, { seq: 2, current: "ghost", retained: ["aaa"], git_sha: "shaGHOST" });
    await s.refresh(true);
    assert.equal(s.current?.id, "aaa", "the store keeps serving what it had");
    assert.equal(seen.length, 1, "a refused generation announces nothing");
    rmSync(root, { recursive: true, force: true });
  } finally {
    off();
  }
});

test("a throwing listener cannot break a flip", async () => {
  // This runs inside refresh(), and an unhandled rejection there reaches
  // Colyseus's graceful-shutdown path and exits the process.
  const off = onBundleServed(() => {
    throw new Error("a listener misbehaving");
  });
  try {
    const root = mkdtempSync(join(tmpdir(), "bs-throw-"));
    writeGen(root, "aaa", GEN_A);
    writePointer(root, { seq: 1, current: "aaa", retained: [] });
    const s = store(root);
    await s.refresh();
    assert.equal(s.current?.id, "aaa", "the flip completed regardless");
    rmSync(root, { recursive: true, force: true });
  } finally {
    off();
  }
});

/* SERVE THE IMAGE, ON PURPOSE. An automatic rollback writes `current: ""` when
 * the generation it would fall back to does not exist — and it is also the
 * kill switch that previously needed a laptop and `--remove-env-vars
 * BUNDLE_STORE`. It must be ADOPTED (so the seq advances and a later publish
 * supersedes it), not refused like a generation that failed to load. */
test('a pointer with an empty current serves the image, and is adopted rather than refused', async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-img-"));
  writeGen(root, "aaa", GEN_A);
  writePointer(root, { seq: 1, current: "aaa", retained: [] });
  const s = store(root);
  await s.refresh();
  assert.equal(s.current?.id, "aaa");

  writePointer(root, { seq: 2, current: "", retained: [], git_sha: "", commit_ts: 0 });
  await s.refresh(true);
  assert.equal(s.pointer?.seq, 2, "the rollback pointer was ADOPTED, not refused");
  assert.equal(s.current, null, "and nothing is served, so the image serves whole");
  assert.equal(s.servedSha(), null, "/version then answers with the image's own sha");

  // Law 2 still holds forward: a later good publish supersedes the rollback.
  writeGen(root, "bbb", GEN_B);
  writePointer(root, { seq: 3, current: "bbb", retained: [] });
  await s.refresh(true);
  // Read through a helper: asserting `s.current === null` above narrows the
  // getter to `never` for the rest of the block, and the later read is a fresh
  // one after another refresh.
  assert.equal((s as { current: { id: string } | null }).current?.id, "bbb", "a later generation supersedes a rollback normally");
  rmSync(root, { recursive: true, force: true });
});

/* AND THE ORDERING GUARD MUST NOT BLOCK IT. Law 6 refuses a generation at or
 * before the image's commit time. A rollback to the image IS the image, so it
 * can never override a rollout and must always be adoptable — otherwise the
 * one pointer that makes production safe is the one production refuses. */
test("a rollback to the image is adopted even when the image is newer than everything", async () => {
  const root = mkdtempSync(join(tmpdir(), "bs-imgord-"));
  writeGen(root, "aaa", GEN_A);
  writePointer(root, { seq: 1, current: "aaa", retained: [], commit_ts: 5000 });
  const prev = process.env.GIT_COMMIT_TS;
  process.env.GIT_COMMIT_TS = "9999"; // the image is much newer than any generation
  try {
    const s = store(root);
    await s.refresh();
    assert.equal(s.current, null, "the generation is refused — the image is newer (law 6)");

    writePointer(root, { seq: 2, current: "", retained: [], commit_ts: 0 });
    await s.refresh(true);
    assert.equal(s.pointer?.seq, 2, "but the rollback to the image is adopted");
    assert.equal(s.current, null);
  } finally {
    if (prev === undefined) delete process.env.GIT_COMMIT_TS;
    else process.env.GIT_COMMIT_TS = prev;
  }
  rmSync(root, { recursive: true, force: true });
});

/* THE ROLLBACK THE GATE ACTUALLY RUNS, against a real store: publish two
 * generations, roll back, and check the store serves the earlier one with the
 * stamp taken from its OWN manifest rather than a guess. */
test("revertBundle rolls production back to the previous generation, honestly stamped", async () => {
  type Pub = {
    publishBundle: (o: { store: unknown; outDir: string; gitSha?: string; commitTs?: number }) => Promise<{ id: string }>;
    revertBundle: (o: { store: unknown }) => Promise<{ current: string; seq: number }>;
    localStore: (root: string) => unknown;
  };
  const { publishBundle, revertBundle, localStore } = (await import(
    new URL("../../scripts/publish-bundle.mjs", import.meta.url).href
  )) as Pub;
  const root = mkdtempSync(join(tmpdir(), "bs-rev-"));
  const a = await publishBundle({
    store: localStore(root), outDir: mkdtempSync(join(tmpdir(), "bs-revA-")), gitSha: "aaaaaaaaaa", commitTs: 1000,
  });
  await publishBundle({
    store: localStore(root), outDir: mkdtempSync(join(tmpdir(), "bs-revB-")), gitSha: "bbbbbbbbbb", commitTs: 2000,
  });
  // The image must be OLDER than both generations, or law 6 refuses them and
  // there is nothing to roll back from. Unset, the store refuses outright —
  // it cannot order the two lanes — which is correct and not what this tests.
  const prevTs = process.env.GIT_COMMIT_TS;
  process.env.GIT_COMMIT_TS = "500";
  try {
  const s = store(root);
  await s.refresh();
  const idOf = (b: typeof s) => b.current?.id ?? null;
  const served = idOf(s);
  assert.ok(served, "the newest generation is serving");

  const back = await revertBundle({ store: localStore(root) });
  assert.equal(back.current, a.id, "rolled back to the generation that was serving before");
  assert.notEqual(back.current, served, "which is not the one that was just published");
  assert.equal(back.seq, 3, "and the seq went FORWARD — a rollback is not a rewind (law 2)");

  await s.refresh(true);
  assert.equal(idOf(s), a.id, "and the store now serves it");
  assert.equal(s.servedSha(), "aaaaaaaaaa", "under the sha from its own manifest, not the pointer's old one");
  } finally {
    if (prevTs === undefined) delete process.env.GIT_COMMIT_TS;
    else process.env.GIT_COMMIT_TS = prevTs;
  }
  rmSync(root, { recursive: true, force: true });
});
