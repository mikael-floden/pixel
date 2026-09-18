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
export type Pointer = { seq: number; current: string; retained: string[]; updated_at?: string; git_sha?: string };

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
};
export const mimeFor = (name: string) => MIME[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream";
/** The one generation-addressed name (law 5). */
export const DOC = "index.html";
export const hashBytes = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);

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

export class BundleStore {
  /** APPEND-ONLY (law 4): a name we have ever served keeps resolving. */
  private names = new Map<string, string>();
  private blobs = new Map<string, BundleFile>();
  private gens = new Map<string, Map<string, string>>(); // id -> name -> hash
  private ptr: Pointer | null = null;
  private inflight: Promise<void> | null = null;
  readonly log: string[] = [];

  constructor(private readonly backend: StoreBackend) {}

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
    return hash ? this.blobs.get(hash) ?? null : null;
  }

  private note(msg: string) {
    this.log.push(`${new Date().toISOString()} ${msg}`);
    if (this.log.length > 40) this.log.shift();
    console.log(`[bundle] ${msg}`);
  }

  /** Read the pointer and adopt what it names. Coalesced; never throws. */
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => { this.inflight = null; });
    return this.inflight;
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
      if (next.seq < this.ptr.seq) this.note(`refused a pointer going backward (seq ${next.seq} < ${this.ptr.seq})`);
      return;
    }
    // LAW 3: materialise the whole window BEFORE deciding anything.
    for (const id of [next.current, ...(next.retained ?? [])]) {
      if (this.gens.has(id)) continue;
      const ok = await this.load(id);
      if (!ok && id === next.current) {
        this.note(`generation ${id} incomplete, NOT flipping`);
        return; // never point at a generation we could not fully read
      }
    }
    const from = this.ptr?.current;
    this.ptr = next;
    this.note(
      `serving ${next.current}${from ? ` (was ${from})` : ""}, ${this.gens.size} generation(s), ` +
        `${this.names.size} name(s), ${this.blobs.size} blob(s), seq ${next.seq}`,
    );
  }

  private async load(id: string): Promise<boolean> {
    const manifestRaw = await this.backend.get(`gen/${id}/manifest.json`);
    if (!manifestRaw) return false;
    let manifest: { files: Record<string, string> };
    try {
      manifest = JSON.parse(manifestRaw.toString("utf8"));
    } catch {
      return false;
    }
    const entries = Object.entries(manifest.files ?? {});
    if (!entries.some(([n]) => n === "index.html")) return false;
    // LAW 1 as an admission test: a name this process has served may not come
    // back meaning different bytes. Two generations sharing a name must share
    // its hash — otherwise a page holding the old one would be handed the new.
    // index.html is exempt BY DESIGN (law 5): it is generation-addressed.
    for (const [name, hash] of entries) {
      if (name === DOC) continue;
      const known = this.names.get(name);
      if (known && known !== hash) {
        this.note(`generation ${id} redefines ${name} (${known} -> ${hash}) — refusing`);
        return false;
      }
    }
    for (const [name, hash] of entries) {
      if (!this.blobs.has(hash)) {
        const bytes = await this.backend.get(`blob/${hash}`);
        if (!bytes) return false; // a half-uploaded generation is not a generation
        const got = hashBytes(bytes);
        if (got !== hash) {
          this.note(`blob ${hash} hashes ${got} — refusing generation ${id}`);
          return false;
        }
        this.blobs.set(hash, { bytes, hash: got, type: mimeFor(name) });
      }
    }
    this.gens.set(id, new Map(entries));
    // append-only, and never the document (law 5)
    for (const [name, hash] of entries) if (name !== DOC) this.names.set(name, hash);
    return true;
  }
}
