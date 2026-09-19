// THE PUBLISHED CLIENT BUNDLE — served from a store the running server reads,
// so shipping client code does not need a container build or a Cloud Run
// rollout. The precedent is live.ts, which has read live/** from outside the
// image since 2026-08 with no redeploy; this carries the bundle the same way.
//
// OFF BY DEFAULT. With BUNDLE_STORE unset the server behaves EXACTLY as before
// (serve client/dist from the image) and nothing here runs. The image bundle is
// also the permanent fallback: a store that is empty, unreachable, stale or
// misconfigured degrades to the bundle we shipped, never to a blank page.
//
// THREE LAWS, each one a bug an adversarial review constructed against an
// earlier draft of this design. They are not precautions; they are what makes
// the failure unrepresentable.
//
// 1. THE DOCUMENT CARRIES NO PER-INSTANCE STAMP. The first draft embedded the
//    serving instance's GIT_SHA in index.html while deriving the generation id
//    from content alone, then used that id as the ETag — ONE STRONG VALIDATOR
//    NAMING TWO DIFFERENT BODIES. A second instance then answers 304/no-bytes
//    to a conditional request carrying the first instance's ETag, and the phone
//    keeps a document stamped with the previous revision FOREVER: a permanent
//    false "new version" toast, a wrong version badge, and every ?v=-stamped
//    asset downgraded from immutable to no-cache — the exact "loading for so
//    long" symptom that grant exists to cure. It fires on any deploy whose dist
//    is byte-identical, i.e. every art deploy. So: the bytes we serve are the
//    bytes that were published, identical on every instance, and the ETag is
//    their hash. The client learns the running sha from /version, as it already
//    does.
// 2. THE POINTER IS MONOTONIC. Content addressing makes a stale BLOB harmless
//    and does nothing for a stale POINTER: a store read that loses a race, or a
//    CDN serving a 5-minute-old pointer, would walk production BACKWARD onto
//    the previous generation and reload every open page. A pointer whose seq is
//    not greater than the one held is refused.
// 5. index.html IS ADDRESSED BY GENERATION, NEVER BY NAME. It is the one file
//    whose bytes legitimately differ between generations (it names the entry
//    chunk), so it is the one name the append-only rule below must NOT cover —
//    and it must never be resolvable by name either, or two generations would
//    fight over one lookup. Asking for the document always means "the document
//    of generation X". Everything else is content-hashed, so its name and its
//    bytes are the same fact.
// 4. A NAME IS NEVER FORGOTTEN. Bytes live under blob/<hash> and a manifest
//    maps name -> hash, so the name->hash map is APPEND-ONLY: a page from a
//    generation the pointer no longer mentions still resolves its chunk, as
//    long as the blob is there. The first draft held whole generations and
//    deleted the ones outside the window — which forgets names, and a
//    forgotten name is a 404 on a module script, i.e. a black page that
//    survives a reload. Content addressing also means a worker or an image
//    that did not change is stored ONCE across every generation, so an
//    unchanged file is never re-uploaded.
// 3. THE RETAINED WINDOW IS MATERIALISED BEFORE THE NO-OP. The early return for
//    "pointer names the generation I already hold" must not skip adopting the
//    retained ones, or the retention guarantee is empty on the most common path
//    and a page mid-session 404s a lazily-imported chunk. Adopt first, then
//    decide whether the current generation changed.
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, normalize } from "node:path";

export type BundleFile = { bytes: Buffer; hash: string; type: string };
export type Generation = { id: string; files: Map<string, BundleFile> };

/** THE OVERLAY: files a generation publishes whose NAMES ARE MUTABLE.
 *
 *  `files` (the bundle) is content-hashed, so a name and its bytes are the same
 *  fact and LAW 1 can make a name mean one thing forever. Art is the opposite
 *  by construction — `scenery/campfire/x.webp` IS the name the game asks for,
 *  and republishing it with new pixels is the entire point of the art lane. So
 *  the overlay is resolved against the CURRENT generation only and never enters
 *  the append-only `names` map; putting it there would make the second art
 *  publish refuse itself forever.
 *
 *  Two key spaces, each identical to one that already exists, so a merge is a
 *  merge and never a translation:
 *   - `art`  keys are ASSETS_ROOT-relative — exactly /asset-index.json's keys.
 *   - `root` keys are dist-root-relative  — exactly `fallthrough`'s keys, which
 *     it partitions: a dist-root file is published (`root`) or pinned
 *     (`fallthrough`), never neither. */
export type Manifest = {
  files: Record<string, string>;
  root?: Record<string, string>;
  fallthrough?: Record<string, string>;
  art?: Record<string, string>;
  /** The overlay's total size as the PUBLISHER measured it — a courtesy that
   *  lets an over-cap generation be refused before a byte is downloaded. Never
   *  trusted as the cap itself: the running total during the fetch is. */
  art_bytes?: number;
  git_sha?: string;
  commit_ts?: number;
};
export type Pointer = {
  seq: number;
  current: string;
  retained: string[];
  updated_at?: string;
  git_sha?: string;
  /** The publishing commit's committer date, epoch seconds. THE ORDER OF THE
   *  TWO LANES — see the ordering guard in doRefresh. */
  commit_ts?: number;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
  // The rest of what the curated art root actually holds, measured over its
  // 50,121 files: webp 48,078, json 1,274, ogg 664, gif 65, md 16, png 12,
  // mjs 6, html 5, js 1, css 1. A missing entry is not a 404, it is
  // `application/octet-stream` — which an <img> refuses to decode, so every
  // extension that ships is named here.
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".opus": "audio/ogg",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};
export const mimeFor = (name: string) => MIME[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream";
/** The one generation-addressed name (law 5). */
export const DOC = "index.html";
/** How many generations THIS PROCESS SERVED are kept readable past a flip —
 *  current + two back, matching the publisher's RETAIN. The root cache law asks
 *  for current + one; the extra one costs a few MB and covers a page that was
 *  loading across two quick publishes. */
const SERVED_WINDOW = 3;
export const hashBytes = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);

/** HOW MUCH OVERLAY THIS PROCESS WILL HOLD, and why there is a number at all.
 *
 *  The service runs `--memory 1Gi --max-instances 1` and the world dies with
 *  the process, so an OOM SIGKILL costs every player in the game. Art is the
 *  first payload this store has carried that can be tens of megabytes: measured
 *  over 14 days of `main`, an art commit changes p50 21 files / 0.73 MB, p90
 *  333 / 9.68 MB, p99 5,172 / 22.6 MB, max 12,887 / 33.7 MB.
 *
 *  A generation's overlay is the delta against the IMAGE, not against the
 *  previous generation, so it grows while the image stands still — which is
 *  exactly why the container lane still runs on an art push (docs/fast-lane.md):
 *  the image refreshing every few minutes is what keeps this delta near p50
 *  instead of a day's worth of art. The caps are the belt under that, and going
 *  over one is not a failure — it is the container lane carrying that push,
 *  which it was going to do anyway.
 *
 *  ENFORCED AS THE BYTES ARRIVE, never from a number the manifest declares: a
 *  cap that trusts the payload it is protecting against is not a cap. */
const ART_FILES_MAX = Number(process.env.ART_FILES_MAX || 6000);
const ART_BYTES_MAX = Number(process.env.ART_BYTES_MAX || 64_000_000);
/** How many blobs are fetched at once while materialising a generation.
 *  Sequential was fine for a bundle's 22 files; an art generation's p90 is 333
 *  and a 0.4 s round trip each would put 133 s between the publish and the
 *  flip — longer than the belt, so the next tick starts over and it never
 *  lands. Bounded rather than unbounded: raw.githubusercontent throttles a
 *  burst, and this shares one Cloud Run core with a 20 Hz world. */
const FETCH_CONCURRENCY = Number(process.env.BUNDLE_FETCH_CONCURRENCY || 12);
const EMPTY: ReadonlyMap<string, string> = new Map();

/** THE ONLY DIST-ROOT FILES THE LANE MAY EVER PUBLISH — and this is an
 *  allowlist because the alternative is the project-deleting bug.
 *
 *  `?v=<GIT_SHA>` freezes a dist-root file for a year and the client STAMPS
 *  client/public art with it (`withV("/ui2/icon-map.webp")`, hud.ts;
 *  `withV("/logo.webp")`, select.ts). Measured live against image
 *  e697e384ec5811: `/ui2/icon-map.webp?v=<sha>`, `/logo.webp?v=<sha>`,
 *  `/sw.js?v=<sha>` and `/monsters.json?v=<sha>` ALL answer
 *  `public, max-age=31536000, immutable`. So a generation that published one of
 *  those would change the bytes under a URL a browser had already frozen —
 *  exactly the hazard the `isArt` change closes for /assets, arriving one level
 *  down. Revoking the `?v` grant for the whole dist root instead would cost
 *  every UI icon and both logos their cache for nothing, since the lane has no
 *  reason to publish them.
 *
 *  These five are the art pipeline's OUTPUT, regenerated by manifest.mjs and
 *  shipset.mjs from the curated root, and they must travel with the art that
 *  produced them: publish new monster art without monsters.json and the monster
 *  is invisible; publish the catalog without the art and it 404s. They are also
 *  the only dist-root files the client fetches UNSTAMPED (`fetch("/characters.json")`,
 *  `fetch(gameUrl("/monsters.json"))`), so no browser has ever frozen one — and
 *  cachepolicy is told not to grant them a year either way, so none ever can. */
/** THE ART DOMAINS THE LANE MAY PUBLISH — the game's art, and only the art it
 *  can faithfully REPRODUCE on a runner.
 *
 *  Measured 2026-09-19, the curated root artbuild.mjs builds against the live
 *  image's own index: tiles 7,004/7,004 identical, scenery 19,037/19,037,
 *  characters2 2,719/2,719, and sounds, music, items and lore identical to the
 *  file. Five paths differ out of 50,121, and three of them are not art:
 *   - `wiki/release_notes.json` is built from GIT HISTORY inside the image
 *     build ("the image has no .git"), which a curation step cannot reproduce;
 *   - `live/feedback/**` is the LIVE channel, which `live.ts` already reads
 *     straight from GitHub with no redeploy — it has its own lane and does not
 *     want this one;
 *   - `live/telemetry/perf.json` is `.dockerignore`-EXCLUDED, so it exists in
 *     the tree and deliberately not in the image. Publishing it would ship a
 *     file the image is specifically built without.
 *  So neither domain travels here. They fall through to the image exactly as
 *  they do today, which is the correct answer for all three. */
export const ART_LANE_DOMAINS: readonly string[] = [
  "characters2",
  "tiles",
  "maps2",
  "scenery",
  "sounds",
  "music",
  "monsters",
  "items",
  "lore",
];

export const PUBLISHABLE_ROOT: ReadonlySet<string> = new Set([
  "characters.json",
  "worlds.json",
  "monsters.json",
  "npcs.json",
  "shipset.json",
]);

/** A path an overlay may name. Deliberately narrow — anything it rejects can
 *  simply ride the container lane, and the cost of being wrong the other way
 *  is a handler reading outside the store. Measured against the whole curated
 *  root: all 50,121 paths match, none holds `..`, a backslash, a space or a
 *  non-ASCII byte, and the deepest is 8 segments / 117 chars. */
const OVERLAY_PATH = /^[A-Za-z0-9][A-Za-z0-9._@-]*(\/[A-Za-z0-9][A-Za-z0-9._@-]*)*$/;
export function safeOverlayPath(p: string): boolean {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= 256 &&
    !p.includes("..") &&
    OVERLAY_PATH.test(p) &&
    normalize(p) === p
  );
}

/** Run `fn` over `items` at most `limit` at a time. Stops early once anything
 *  answers false. Never rejects: a throwing `fn` counts as false, because every
 *  caller here is inside the refresh path where a rejection reaches Colyseus's
 *  graceful-shutdown and exits the process. */
async function pooled<T>(items: T[], limit: number, fn: (t: T) => Promise<boolean>): Promise<boolean> {
  let next = 0;
  let ok = true;
  const worker = async () => {
    for (;;) {
      if (!ok) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        if (!(await fn(items[i]))) ok = false;
      } catch {
        ok = false;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return ok;
}

/** A place published generations are read from. A local directory is the
 *  in-process backend (the bus.ts idiom): same contract, no cloud, so the whole
 *  lane is testable without credentials. A gs:// URL uses the bucket. */
export interface StoreBackend {
  get(path: string): Promise<Buffer | null>;
  list(prefix: string): Promise<string[]>;
  readonly label: string;
}

export function localBackend(root: string): StoreBackend {
  const safe = (p: string) => {
    const full = normalize(join(root, p));
    if (!full.startsWith(normalize(root))) throw new Error(`bundlestore: path escapes the store: ${p}`);
    return full;
  };
  return {
    label: `local:${root}`,
    async get(p) {
      try {
        return await readFile(safe(p));
      } catch {
        return null;
      }
    },
    async list(prefix) {
      const dir = safe(prefix);
      try {
        if (!(await stat(dir)).isDirectory()) return [];
        return (await readdir(dir)).sort();
      } catch {
        return [];
      }
    },
  };
}

export function gcsBackend(bucket: string, prefix = "bundle"): StoreBackend {
  // Read-only, via the JSON API with the instance's own metadata-server token.
  // No SDK: one dependency-free GET per object, and the objects are immutable
  // apart from the pointer, so a plain fetch is the whole client.
  const base = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`;
  let token: { value: string; until: number } | null = null;
  const auth = async () => {
    if (token && Date.now() < token.until) return token.value;
    const r = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(4000) },
    );
    if (!r.ok) throw new Error(`bundlestore: metadata token ${r.status}`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, until: Date.now() + Math.max(30, j.expires_in - 60) * 1000 };
    return token.value;
  };
  return {
    label: `gs://${bucket}/${prefix}`,
    async get(p) {
      const name = encodeURIComponent(`${prefix}/${p}`);
      const r = await fetch(`${base}/${name}?alt=media`, {
        headers: { authorization: `Bearer ${await auth()}`, "cache-control": "no-cache" },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    },
    async list(prefix2) {
      const r = await fetch(`${base}?prefix=${encodeURIComponent(`${prefix}/${prefix2}/`)}&fields=items/name`, {
        headers: { authorization: `Bearer ${await auth()}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return [];
      const j = (await r.json()) as { items?: { name: string }[] };
      return (j.items ?? []).map((i) => i.name.slice(`${prefix}/${prefix2}/`.length)).filter(Boolean).sort();
    },
  };
}

export function githubBackend(repo: string, branch: string, prefix = "bundle"): StoreBackend {
  // THE CHANNEL THIS REPO ALREADY RUNS IN PRODUCTION. live.ts has read live/**
  // from raw.githubusercontent since 2026-08 with no redeploy, measured at 5-9 s
  // push-to-visible, and it needs no bucket, no IAM and no console step from a
  // phone-only maintainer.
  //
  // TWO THINGS IT MUST GET RIGHT, both learned from live.ts. raw sits behind a
  // ~5-minute CDN, so a read that matters for FRESHNESS asks the contents API
  // when a token is available (live.ts:293 does exactly this, for exactly this
  // reason) — here that is the pointer. And a BLOB never needs that care: it is
  // addressed by its own hash, so a stale CDN answer is either the right bytes
  // or refused by the hash check in load().
  const RAW = `https://raw.githubusercontent.com/${repo}/${branch}`;
  const API = `https://api.github.com/repos/${repo}/contents`;
  const token = () => process.env.WIKI_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";
  return {
    label: `github:${repo}@${branch}/${prefix}`,
    async get(p) {
      const path = `${prefix}/${p}`;
      // The pointer is the one mutable name, so it is the one read that must
      // not come from a 5-minute CDN.
      const fresh = p === "pointer.json" && !!token();
      try {
        if (fresh) {
          const r = await fetch(`${API}/${path}?ref=${encodeURIComponent(branch)}`, {
            headers: {
              authorization: `Bearer ${token()}`,
              accept: "application/vnd.github.raw",
              "cache-control": "no-cache",
            },
            signal: AbortSignal.timeout(8000),
          });
          if (r.ok) return Buffer.from(await r.arrayBuffer());
          // fall through to raw: a missing token scope or a 403 must not make
          // the lane unreadable, only staler.
        }
        const r = await fetch(`${RAW}/${path}`, {
          headers: { "cache-control": "no-cache" },
          signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) return null;
        return Buffer.from(await r.arrayBuffer());
      } catch {
        return null; // unreachable is "keep what we have", never a throw
      }
    },
    async list() {
      return []; // nothing needs listing: the pointer names what to load
    },
  };
}

/** Pick the backend from the environment. `undefined` = the lane is off. */
export function backendFromEnv(env = process.env): StoreBackend | undefined {
  const spec = (env.BUNDLE_STORE || "").trim();
  if (!spec) return undefined;
  if (spec.startsWith("gs://")) {
    const [, rest] = spec.split("gs://");
    const slash = rest.indexOf("/");
    return slash < 0 ? gcsBackend(rest) : gcsBackend(rest.slice(0, slash), rest.slice(slash + 1));
  }
  // github:owner/repo@branch[/prefix]
  if (spec.startsWith("github:")) {
    const rest = spec.slice("github:".length);
    const at = rest.indexOf("@");
    if (at < 0) return undefined;
    const repo = rest.slice(0, at);
    const after = rest.slice(at + 1);
    const slash = after.indexOf("/");
    return slash < 0 ? githubBackend(repo, after) : githubBackend(repo, after.slice(0, slash), after.slice(slash + 1));
  }
  return localBackend(spec);
}

/** A FLIP IS NEWS. Listeners are module-level for the same reason
 *  `onLiveChange` is: the rooms cannot reach the store instance, and the store
 *  must not know what a room is. A throwing listener is swallowed — this runs
 *  inside refresh(), and an unhandled rejection there reaches Colyseus's
 *  graceful-shutdown path and exits the process. */
const servedListeners = new Set<(sha: string, id: string) => void>();

export function onBundleServed(cb: (sha: string, id: string) => void): () => void {
  servedListeners.add(cb);
  return () => servedListeners.delete(cb);
}

export function noteBundleServed(sha: string, id: string): void {
  for (const cb of servedListeners) {
    try {
      cb(sha, id);
    } catch {
      /* a listener must never break a flip */
    }
  }
}

export class BundleStore {
  /** APPEND-ONLY (law 4): a name we have ever served keeps resolving. */
  private names = new Map<string, string>();
  private blobs = new Map<string, BundleFile>();
  private gens = new Map<string, Map<string, string>>(); // id -> name -> hash
  /** id -> ASSETS_ROOT-relative path -> hash. NOT in `names`: see Overlay. */
  private artGens = new Map<string, Map<string, string>>();
  /** id -> dist-root-relative path -> hash. NOT in `names`: same reason. */
  private rootGens = new Map<string, Map<string, string>>();
  private ptr: Pointer | null = null;
  /** Generations THIS PROCESS actually flipped to, most recent first. The
   *  pointer's `retained` is the PUBLISHER's list and can name generations this
   *  instance refused or never read (a corrupt blob, a mixed fall-through, a
   *  cold start); evicting on that list alone can therefore drop the generation
   *  the open pages are actually running. What was served is what must keep
   *  resolving, so eviction keeps the union of the two. */
  private servedIds: string[] = [];
  private inflight: Promise<void> | null = null;
  readonly log: string[] = [];

  /** `verifyFallthrough` is the server half of the mixed-generation guarantee
   *  (publish-bundle.mjs explains the publisher half). It is handed the
   *  generation's recorded hashes for every dist-root file the generation does
   *  NOT carry, PLUS the set it DOES carry (`root`), and returns everything
   *  that disagrees with the bytes this instance would actually serve. The
   *  second argument is what closes the gap the overlay opened: before it, a
   *  dist-root file named by NEITHER map was silently unpinned. Omitted in
   *  tests that have no image beside them.
   *
   *  `artDomains` is the whitelist an `art` path's first segment must be in —
   *  the same list index.ts mounts. Empty (the default) admits no art at all,
   *  which is what a test or a misconfiguration should get. */
  constructor(
    private readonly backend: StoreBackend,
    private readonly verifyFallthrough?: (fallthrough: Record<string, string>, published: ReadonlySet<string>) => string[],
    private readonly artDomains: readonly string[] = [],
  ) {}

  get label() { return this.backend.label; }
  get pointer() { return this.ptr; }
  get held() { return this.gens.size; }
  /** The generation to serve, or null while nothing is held (serve the image). */
  get current(): Generation | null {
    if (!this.ptr) return null;
    const m = this.gens.get(this.ptr.current);
    if (!m) return null;
    const files = new Map<string, BundleFile>();
    for (const [name, hash] of m) {
      const b = this.blobs.get(hash);
      if (b) files.set(name, b);
    }
    return { id: this.ptr.current, files };
  }
  generation(id: string): Generation | null {
    const m = this.gens.get(id);
    if (!m) return null;
    const files = new Map<string, BundleFile>();
    for (const [name, hash] of m) {
      const b = this.blobs.get(hash);
      if (b) files.set(name, b);
    }
    return { id, files };
  }
  /** Any CONTENT-HASHED name this process has ever served — the append-only
   *  lookup a page from an older generation depends on. Never the document:
   *  index.html belongs to a generation (law 5), so asking for it by name is a
   *  question with two right answers and this returns null. */
  fileFor(path: string): BundleFile | null {
    if (path === DOC) return null;
    const hash = this.names.get(path);
    return this.typed(path, hash);
  }

  /** THE BYTES ARE THE BLOB'S; THE CONTENT-TYPE IS THE NAME'S. Two files with
   *  identical bytes share one blob, so a type cached on the blob is whichever
   *  name happened to load first — a 28-byte fully transparent .webp and an
   *  empty .json would then trade Content-Types. Derived per lookup instead:
   *  it is a string-slice and a map hit. */
  private typed(name: string, hash: string | undefined): BundleFile | null {
    if (!hash) return null;
    const b = this.blobs.get(hash);
    return b ? { bytes: b.bytes, hash: b.hash, type: mimeFor(name) } : null;
  }

  /** ART THIS GENERATION PUBLISHES, resolved against the CURRENT generation
   *  ONLY. `rel` is ASSETS_ROOT-relative, i.e. an /asset-index.json key. A miss
   *  is not an error: it means the image's own file is the right answer. */
  artFor(rel: string): BundleFile | null {
    const m = this.ptr ? this.artGens.get(this.ptr.current) : null;
    return m ? this.typed(rel, m.get(rel)) : null;
  }

  /** A DIST-ROOT file this generation publishes (the generated catalogs).
   *  `rel` is dist-root-relative, i.e. a `fallthrough` key. */
  rootFor(rel: string): BundleFile | null {
    const m = this.ptr ? this.rootGens.get(this.ptr.current) : null;
    return m ? this.typed(rel, m.get(rel)) : null;
  }

  /** The current generation's art map (path -> hash), for merging into the
   *  served /asset-index.json. Empty when nothing is overlaid. */
  artHashes(): ReadonlyMap<string, string> {
    return (this.ptr && this.artGens.get(this.ptr.current)) || EMPTY;
  }

  /** What /api/bundle shows a maintainer on a phone about the overlay. */
  get overlay(): { art: number; root: number; bytes: number } {
    const a = this.artHashes();
    const r = (this.ptr && this.rootGens.get(this.ptr.current)) || EMPTY;
    let bytes = 0;
    for (const h of new Set([...a.values(), ...r.values()])) bytes += this.blobs.get(h)?.bytes.length ?? 0;
    return { art: a.size, root: r.size, bytes };
  }

  /** A refusal that cannot change until the STORE does must be said once.
   *  The 60 s belt re-reads the pointer forever, so a generation refused for a
   *  standing reason — older than this image, a corrupt blob, a fall-through
   *  mismatch — logged once a minute for as long as it sat there. Measured: one
   *  stale generation wrote the same line 40+ times and evicted every useful
   *  entry from this 40-line ring, which is the log a phone reads through
   *  /api/bundle. Keyed on the pointer, so a NEW pointer always speaks up. */
  private noteOnce(key: string, msg: string) {
    if (this.lastSaid === key) return;
    this.lastSaid = key;
    this.note(msg);
  }
  private lastSaid = "";

  /** EVERY REFUSAL SAYS `refused <id>:`, and that phrasing is a contract.
   *  Both workflows decide "was this a defect or is it still replicating?" by
   *  looking for exactly that in `/api/bundle` — so a refusal phrased any other
   *  way reports a GREEN check over art that will never be served, which is
   *  precisely how this lane once went a day claiming success while having
   *  served nothing. One helper, so a new refusal cannot be added in the wrong
   *  shape. */
  private refuse(id: string, why: string): "refused" {
    this.note(`refused ${id}: ${why}`);
    return "refused";
  }

  /** THE POINTER THIS STORE HAS ALREADY REFUSED, and why it is remembered.
   *  A refusal for a STRUCTURAL reason cannot change until the store does, but
   *  `this.ptr` does not advance on a refusal — so the 60 s belt re-read the
   *  pointer, found the generation absent from `gens`, and RE-DOWNLOADED THE
   *  WHOLE ART DELTA every minute forever, before refusing again for the same
   *  reason. At the p99 delta that is thousands of raw.githubusercontent
   *  requests a minute from the production egress IP. An INCOMPLETE read is
   *  different and is deliberately not remembered: a blob still replicating is
   *  exactly what the belt exists to retry. */
  private refusedPointer = "";

  private note(msg: string) {
    this.log.push(`${new Date().toISOString()} ${msg}`);
    if (this.log.length > 40) this.log.shift();
    console.log(`[bundle] ${msg}`);
  }

  /** Read the pointer and adopt what it names.
   *
   *  NEVER THROWS, and that is load-bearing rather than tidy. This runs from a
   *  60 s interval and from an HTTP handler; an unhandled rejection in a
   *  Colyseus process reaches its graceful-shutdown path, which ends in
   *  `process.exit(1)`. A DNS hiccup reading a pointer would then drop every
   *  player in the authoritative world. Every backend read is inside a catch,
   *  here and in load().
   *
   *  `force` is for THE POKE. A plain refresh joins one already in flight, and
   *  an in-flight read may have read the pointer BEFORE the publisher wrote it
   *  — so the poke would answer 200 naming the old generation and the publish
   *  would look like a no-op until the interval came round, up to 60 s later.
   *  A forced refresh lets the in-flight read finish and then reads again. */
  async refresh(force = false): Promise<void> {
    if (this.inflight) {
      if (!force) return this.inflight;
      await this.inflight.catch(() => {});
    }
    this.inflight = this.doRefresh()
      .catch((e) => this.note(`refresh failed, keeping what we have: ${String(e).slice(0, 160)}`))
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** The identity of the CLIENT being served: the sha the current generation
   *  was built from, or null when the image's own bundle is serving. `/version`
   *  answers with this, because the client compares it against the sha baked
   *  into ITSELF — see the boot check in client/src/main.ts. */
  servedSha(): string | null {
    if (!this.ptr || !this.gens.has(this.ptr.current)) return null;
    const s = (this.ptr.git_sha || "").trim();
    return s && s !== "dev" ? s : null;
  }

  private async doRefresh(): Promise<void> {
    let next: Pointer;
    try {
      const raw = await this.backend.get("pointer.json");
      if (!raw) return; // no publication yet: the image bundle serves
      next = JSON.parse(raw.toString("utf8")) as Pointer;
    } catch (e) {
      this.note(`pointer unreadable, keeping what we have: ${String(e).slice(0, 120)}`);
      return;
    }
    if (!next || typeof next.current !== "string" || typeof next.seq !== "number") {
      this.note("pointer malformed, keeping what we have");
      return;
    }
    // LAW 2: monotonic. A stale blob is harmless; a stale pointer walks
    // production backward.
    if (this.ptr && next.seq <= this.ptr.seq) {
      if (next.seq < this.ptr.seq)
        this.note(`refused ${next.current}: the pointer goes backward (seq ${next.seq} < ${this.ptr.seq})`);
      return;
    }
    // THE TWO LANES ARE ORDERED, AND THE IMAGE WINS A TIE. `seq` orders
    // publishes against each other, and says nothing about this image: a
    // generation published from an EARLIER commit is perfectly monotonic, so
    // without this a container rollout is silently overridden by an older
    // client — a rollback nobody asked for, and a mismatched client/server
    // pair. It is also what makes the image a FLOOR again: a bad publish is
    // undone by any later container deploy, which is the only recovery a
    // phone-only maintainer has.
    //
    // STRICT ON PURPOSE: a generation that names a time is refused by an image
    // that cannot name its own, because "cannot compare" must not read as
    // "newer". That only happens on an image built before this guard existed,
    // and the next container deploy clears it.
    // A serve-the-image pointer is never ordered against the image: it IS the
    // image, so it can never override a rollout and must always be adoptable.
    if (next.current && typeof next.commit_ts === "number" && next.commit_ts > 0) {
      const mine = Number(process.env.GIT_COMMIT_TS || 0);
      if (!mine) {
        this.noteOnce(
          `${next.current}@${next.seq}:nots`,
          `refused ${next.current}: it names a commit time but this image does not (GIT_COMMIT_TS unset) — the two lanes cannot be ordered`,
        );
        return;
      }
      if (next.commit_ts <= mine) {
        this.noteOnce(
          `${next.current}@${next.seq}:order`,
          `refused ${next.current}: published from a commit at or before this image (${next.commit_ts} <= ${mine}) — the image is newer and stays`,
        );
        return;
      }
    }
    // LAW 3: materialise the whole window BEFORE deciding anything.
    // An EMPTY `current` is the one exception, and it is deliberate: it means
    // SERVE THE IMAGE. There is nothing to materialise, nothing to order
    // against (the image cannot be older than itself), and `get current()`
    // already answers null for an id the map does not hold — so the image
    // serves whole, which is the safest thing this store can ever do. It is
    // what an automatic rollback writes when the generation it would fall back
    // to does not exist (the bad one was the first), and it is the kill switch
    // that previously needed a laptop and `--remove-env-vars BUNDLE_STORE`.
    // The seq still advances, so this is a normal forward step under LAW 2 and
    // a later good publish simply supersedes it.
    // ALREADY REFUSED THIS EXACT POINTER? Then nothing below can have changed
    // and re-reading it is pure cost (see refusedPointer).
    const ptrKey = `${next.seq}:${next.current}`;
    if (this.refusedPointer === ptrKey) return;
    for (const id of next.current ? [next.current, ...(next.retained ?? [])] : (next.retained ?? [])) {
      // `gens.has(id)` IS NOT ENOUGH, and that gap is a mixed generation.
      // Overlay bytes are kept for the CURRENT generation only, so a
      // generation still inside the window has its NAMES but not its art — and
      // a ROLLBACK points straight at one of those. With a bare `has` check the
      // store skipped the load, flipped, and then resolved that generation's
      // art to hashes whose bytes were gone: its client served against the
      // IMAGE's art and catalogs, with an asset index naming bytes nobody
      // holds. So the test is whether every byte it names is in hand.
      if (this.materialised(id)) continue;
      const outcome = await this.load(id);
      if (outcome !== "ok" && id === next.current) {
        if (outcome === "refused") this.refusedPointer = ptrKey;
        else this.note(`refused ${id}: incomplete, NOT flipping (a blob could not be read; the belt will retry)`);
        return; // never point at a generation we could not fully read
      }
    }
    const from = this.ptr?.current;
    this.ptr = next;
    this.servedIds = [next.current, ...this.servedIds.filter((i) => i !== next.current)].slice(0, SERVED_WINDOW);
    this.lastSaid = ""; // a flip is news; let the next standing refusal speak once more
    this.evict();
    this.note(
      `serving ${next.current || "the image (no generation)"}${from ? ` (was ${from})` : ""}, ${this.gens.size} generation(s), ` +
        `${this.names.size} name(s), ${this.blobs.size} blob(s), seq ${next.seq}`,
    );
    // TELL THE OPEN PAGES, so a new build is news in a second instead of in up
    // to a minute. main.ts polls /version every 60 s and only ever OFFERS the
    // banner (his rule), so the deploy landing and the banner appearing were
    // two separate waits: 66 s to serve plus 0-60 s to notice, which is what
    // makes a person sit and refresh. A flip is the exact moment the news
    // exists, so say it here; WorldRoom broadcasts it over the socket already
    // open. ANNOUNCED AFTER the flip and the log, never before — a listener
    // must never be told about a generation this store is not yet serving.
    // The poll stays as the belt: the select screen has no room, and a page
    // that missed the message still converges within the minute.
    // A rollback to the image serves the IMAGE's sha, not the empty string the
    // pointer carries — the announcement names what is actually being served.
    noteBundleServed(next.current ? next.git_sha || "" : process.env.GIT_SHA || "", next.current);
  }

  /** BYTES ARE EVICTED; NAMES NEVER ARE.
   *
   *  The window (current + `retained`) is the guarantee the publisher and the
   *  root cache law both state: a page loaded from a generation inside it keeps
   *  resolving every chunk it names. Holding every generation FOREVER is not a
   *  stronger guarantee — it is an OOM. The service runs `--memory 1Gi
   *  --max-instances 1`, a generation is ~2.5 MB, and publishing often is the
   *  entire point of this lane; the world dies with the process, so "keep
   *  everything" trades a 404 on a very old chunk for dropping every player in
   *  the game.
   *
   *  What is NOT evicted is the name -> hash map: ~100 bytes an entry, and it
   *  is what keeps LAW 1 absolute for the life of the process. A hashed name
   *  that ever meant one thing can never come back meaning another, even after
   *  its bytes are gone. A name whose bytes have been evicted answers 404 with
   *  `no-store` — a coherent miss that reloads, never a wrong file. */
  private evict(): void {
    if (!this.ptr) return;
    const keep = new Set([this.ptr.current, ...(this.ptr.retained ?? []), ...this.servedIds]);
    for (const id of [...this.gens.keys()]) if (!keep.has(id)) this.gens.delete(id);
    for (const id of [...this.artGens.keys()]) if (!keep.has(id)) this.artGens.delete(id);
    for (const id of [...this.rootGens.keys()]) if (!keep.has(id)) this.rootGens.delete(id);
    const live = new Set<string>();
    for (const m of this.gens.values()) for (const h of m.values()) live.add(h);
    // THE OVERLAY'S BYTES ARE KEPT FOR THE CURRENT GENERATION ONLY, and that is
    // a rule about what can be ASKED FOR, not a corner cut for memory. An
    // overlay name resolves against the current generation by definition
    // (artFor/rootFor), so a previous generation's art bytes can never be
    // reached — holding them would be pure cost, and the cost here is tens of
    // megabytes on a 1 GiB instance whose death takes the world with it. A page
    // that loaded the old art already has it; a page that asks again gets the
    // new bytes with `no-cache`, which is exactly what a container art deploy
    // does today.
    for (const m of [this.artGens.get(this.ptr.current), this.rootGens.get(this.ptr.current)])
      if (m) for (const h of m.values()) live.add(h);
    let freed = 0;
    for (const [h, f] of [...this.blobs]) {
      if (live.has(h)) continue;
      freed += f.bytes.length;
      this.blobs.delete(h);
    }
    if (freed) {
      this.note(
        `evicted ${(freed / 1e6).toFixed(2)} MB outside the window; ` +
          `${this.gens.size} generation(s), ${this.blobs.size} blob(s), ${this.names.size} name(s) remembered`,
      );
    }
  }

  /** Is every byte this generation names in hand? `gens` records the NAMES; the
   *  overlay's BYTES are evicted outside the current generation, so a
   *  generation in the window can be half-present. */
  private materialised(id: string): boolean {
    const f = this.gens.get(id);
    if (!f) return false;
    for (const m of [f, this.artGens.get(id), this.rootGens.get(id)])
      if (m) for (const h of m.values()) if (!this.blobs.has(h)) return false;
    return true;
  }

  private async load(id: string): Promise<"ok" | "refused" | "incomplete"> {
    try {
      return await this.doLoad(id);
    } catch (e) {
      // A backend that THROWS (DNS, TLS, a 500 from the contents API) must read
      // as "could not load this generation", never as a rejection escaping into
      // the process. doRefresh treats anything but "ok" on the CURRENT
      // generation as "do not flip", so a transient error leaves production
      // exactly as it is — and "incomplete", not "refused", because a throw is
      // the one thing that CAN fix itself.
      this.note(`generation ${id} unreadable: ${String(e).slice(0, 140)}`);
      return "incomplete";
    }
  }

  private async doLoad(id: string): Promise<"ok" | "refused" | "incomplete"> {
    const manifestRaw = await this.backend.get(`gen/${id}/manifest.json`);
    if (!manifestRaw) return "incomplete"; // not written yet, or still replicating
    let manifest: Manifest;
    try {
      manifest = JSON.parse(manifestRaw.toString("utf8")) as Manifest;
    } catch {
      return this.refuse(id, "its manifest does not parse");
    }
    const entries = Object.entries(manifest.files ?? {});
    if (!entries.some(([n]) => n === "index.html")) return this.refuse(id, "it carries no document");

    // THE OVERLAY IS VALIDATED BEFORE A SINGLE BYTE IS FETCHED. Every rejection
    // below costs nothing and leaves the image serving whole; the container
    // lane is already carrying this same push, so a refusal is a delay of
    // minutes, never an outage.
    const art = this.overlayEntries(id, manifest.art, "art");
    const root = this.overlayEntries(id, manifest.root, "root");
    if (!art || !root) return "refused"; // overlayEntries already said why
    if (art.length + root.length > ART_FILES_MAX)
      return this.refuse(id, `it overlays ${art.length + root.length} files, over the ${ART_FILES_MAX} cap — the container lane carries this push`);
    // THE DECLARED WEIGHT, refused BEFORE a byte is fetched. The running check
    // below is the one that cannot be lied to; this one saves a 64 MB download
    // when the publisher is honest, which it always is.
    if (typeof manifest.art_bytes === "number" && manifest.art_bytes > ART_BYTES_MAX)
      return this.refuse(id, `it declares ${manifest.art_bytes} overlay bytes, over the ${ART_BYTES_MAX} cap — the container lane carries this push`);
    // `root` PUBLISHES a dist-root file and `fallthrough` PINS one; claiming
    // both for a path means the generation does not know which bytes it is
    // asking for.
    const ft = manifest.fallthrough ?? {};
    const both = root.filter(([n]) => n in ft).map(([n]) => n);
    if (both.length)
      return this.refuse(id, `it both publishes and pins ${both.length} dist-root path(s) (${both[0]})`);

    // LAW 1 as an admission test, and ONLY for the bundle's content-hashed
    // names: a name this process has served may not come back meaning
    // different bytes. Two generations sharing a name must share its hash —
    // otherwise a page holding the old one would be handed the new.
    // index.html is exempt BY DESIGN (law 5): it is generation-addressed, and
    // so is the whole overlay, whose names are mutable on purpose.
    for (const [name, hash] of entries) {
      if (name === DOC) continue;
      const known = this.names.get(name);
      if (known && known !== hash) return this.refuse(id, `it redefines ${name} (${known} -> ${hash})`);
    }

    // EVERY BYTE THIS LOAD BRINGS IN, so a refusal can hand them all back. A
    // generation refused AFTER its blobs landed used to leave them resident
    // until the next successful flip called evict() — which is precisely the
    // OOM the overlay cap exists to prevent, arriving by the back door.
    const added = new Set<string>();
    const undo = () => {
      for (const h of added) this.blobs.delete(h);
    };

    const overlay = [...art, ...root];
    let overlayBytes = 0;
    // WHY a pooled fetch stopped, so the outcome can say whether the belt
    // should ever try again. A lying blob and an over-cap overlay are
    // STRUCTURAL; a missing blob is replication.
    let lied = false;
    let tooBig = false;
    const fetchOne = async ([name, hash]: [string, string], isOverlay: boolean): Promise<boolean> => {
      const have = this.blobs.get(hash);
      if (have) {
        if (isOverlay) overlayBytes += have.bytes.length;
        return overlayBytes <= ART_BYTES_MAX;
      }
      // ONE RETRY. A path pushed seconds ago can briefly 404 while it
      // replicates, and with hundreds of blobs in a generation the chance that
      // at least one read blips is no longer small — without this, one blip
      // costs the whole generation and the belt starts over a minute later.
      // WITH A DELAY BETWEEN THE ATTEMPTS. A freshly pushed raw path answers a
      // CACHED negative, so a back-to-back retry asks the same CDN edge the
      // same question and gets the same 404 — the retry bought nothing. Three
      // attempts, 250 ms then 750 ms, which is within the poke's own loop and
      // well inside the 60 s belt.
      let bytes: Buffer | null = null;
      for (let attempt = 0; attempt < 3 && !bytes; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, attempt === 1 ? 250 : 750));
        bytes = await this.backend.get(`blob/${hash}`);
      }
      if (!bytes) return false; // still replicating, or a half-uploaded generation
      const got = hashBytes(bytes);
      if (got !== hash) {
        lied = true;
        this.note(`blob ${hash} hashes ${got} — the store holds bytes under a name they do not hash to`);
        return false;
      }
      this.blobs.set(hash, { bytes, hash: got, type: mimeFor(name) });
      added.add(hash);
      if (isOverlay) {
        overlayBytes += bytes.length;
        if (overlayBytes > ART_BYTES_MAX) {
          tooBig = true;
          this.note(`its overlay passed the ${ART_BYTES_MAX} byte cap while loading (at ${overlayBytes})`);
          return false;
        }
      }
      return true;
    };

    if (!(await pooled(entries, FETCH_CONCURRENCY, (e) => fetchOne(e, false)))) {
      undo();
      return lied ? this.refuse(id, "a blob does not hash to its name") : "incomplete";
    }
    if (!(await pooled(overlay, FETCH_CONCURRENCY, (e) => fetchOne(e, true)))) {
      undo();
      if (tooBig) return this.refuse(id, "its overlay is over the byte cap — the container lane carries this push");
      return lied ? this.refuse(id, "an overlay blob does not hash to its name") : "incomplete";
    }

    // A MIXED GENERATION IS REFUSED, BY ARITHMETIC. The generation carries
    // index.html + assets/ + whatever `root` names; every OTHER dist-root file
    // is answered by the IMAGE, and the publisher recorded the hash it saw for
    // each of them. If any disagrees with what this instance would serve — or
    // if any dist-root file is named by neither map — then adopting this
    // generation would run new code against other bytes than it was built and
    // gated against. Refusing is always safe: the image keeps serving, whole
    // and self-consistent, and the container lane delivers the pair together.
    if (this.verifyFallthrough && (manifest.fallthrough || root.length)) {
      const bad = this.verifyFallthrough(ft, new Set(root.map(([n]) => n)));
      if (bad.length) {
        undo();
        return this.refuse(
          id,
          `it does not match the image it would fall through to (${bad.length} file(s): ${bad.slice(0, 3).join("; ")})`,
        );
      }
    }
    // THE DOCUMENT MAY NOT NAME A FILE THIS GENERATION DOES NOT CARRY. An
    // index.html whose entry chunk is absent from its own manifest passes every
    // other test here — the manifest's hash check cannot see a file that simply
    // is not listed — then loads, reports healthy and renders a black page.
    const docFile = this.blobs.get(manifest.files?.[DOC] ?? "");
    if (docFile) {
      const refs = [
        ...docFile.bytes.toString("utf8").matchAll(/(?:src|href)\s*=\s*["']\/?(assets\/[^"']+)["']/g),
      ].map((m) => m[1]);
      const missing = refs.filter((r) => !(r in (manifest.files ?? {})));
      if (missing.length) {
        undo();
        return this.refuse(id, `its document names ${missing.length} file(s) it does not carry (${missing[0]})`);
      }
    }
    this.gens.set(id, new Map(entries));
    if (art.length) this.artGens.set(id, new Map(art));
    if (root.length) this.rootGens.set(id, new Map(root));
    // append-only, and never the document (law 5) and never the overlay
    for (const [name, hash] of entries) if (name !== DOC) this.names.set(name, hash);
    if (overlay.length)
      this.note(
        `generation ${id} overlays ${art.length} art + ${root.length} dist-root file(s), ${(overlayBytes / 1e6).toFixed(2)} MB`,
      );
    return "ok";
  }

  /** Validate one overlay map, or refuse the generation. Returns the entries,
   *  or null once anything is wrong — and says WHY, because a refusal nobody
   *  can read cost this lane a day the first time (docs/fast-lane.md). */
  private overlayEntries(id: string, map: Record<string, string> | undefined, kind: "art" | "root"): [string, string][] | null {
    if (!map) return [];
    if (typeof map !== "object") {
      this.refuse(id, `it has a malformed ${kind} map`);
      return null;
    }
    const out: [string, string][] = [];
    for (const [name, hash] of Object.entries(map)) {
      if (!safeOverlayPath(name)) {
        this.refuse(id, `it names an unsafe ${kind} path (${JSON.stringify(name).slice(0, 80)})`);
        return null;
      }
      if (typeof hash !== "string" || !/^[0-9a-f]{16}$/.test(hash)) {
        this.refuse(id, `it names ${kind} ${name} with a malformed hash`);
        return null;
      }
      if (kind === "art") {
        // The first segment IS the mount. Anything else would have the store
        // answer for a URL no art mount owns.
        const dom = name.slice(0, name.indexOf("/"));
        if (!dom || !this.artDomains.includes(dom)) {
          this.refuse(id, `it names art outside the domains the lane may publish (${name})`);
          return null;
        }
      } else {
        // The bundle owns `assets/` and the document; `root` may not reach into
        // either or the two would fight over one lookup (law 5).
        if (name === DOC || name === "assets" || name.startsWith("assets/")) {
          this.refuse(id, `it publishes ${name} as a dist-root file, which the bundle owns`);
          return null;
        }
        if (!PUBLISHABLE_ROOT.has(name)) {
          this.refuse(
            id,
            `it publishes ${name}, which is not one of the generated catalogs the lane may carry ` +
              `(a ?v=-stamped dist-root file cannot change bytes under a frozen URL; see PUBLISHABLE_ROOT)`,
          );
          return null;
        }
      }
      out.push([name, hash]);
    }
    return out;
  }
}
