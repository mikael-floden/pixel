/** ASSET URL STAMPING — what makes a browser cache a piece of art for a year
 *  and STILL never show a stale one.
 *
 *  Preferred: `?h=<content hash>` from /asset-index.json (one `no-cache`
 *  document, revalidated each boot — a 304 until a deploy changes art). The
 *  server freezes the response ONLY when the hash equals the hash of the bytes
 *  it serves (server/src/cachepolicy.ts), so an unchanged file keeps its URL
 *  across deploys and is never requested again, and a stale index can only
 *  earn a revalidated response, never a frozen wrong file.
 *
 *  Fallback: `?v=<build sha>` — the pre-index scheme, kept for whatever the
 *  index does not name: client/public art (UI, atlases, icons), CDN URLs of a
 *  staging world, or any boot where the index failed to load. Every deploy
 *  changes those URLs, which is exactly the re-download the index removes for
 *  everything under /assets.
 *
 *  Only URLs of the form `/assets/<path>` are looked up; the index keys are
 *  paths relative to the server's ASSETS_ROOT. The lookup is synchronous —
 *  the index is a module-level map filled once by loadAssetIndex(), which
 *  main.ts starts before anything stamps a URL. */
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const sha = (env.VITE_GIT_SHA || "").trim();
const V = sha && sha !== "dev" ? sha : "";

export const ASSET_INDEX_SCHEMA = "nangijala-asset-index@1";
let index: Record<string, string> | null = null;

/** The current index (tests, probes), or null when none has loaded. */
export function assetIndex(): Readonly<Record<string, string>> | null {
  return index;
}

export function setAssetIndex(files: Record<string, string> | null): void {
  index = files;
}

export function assetHashFor(url: string): string | null {
  if (!index || !url.startsWith("/assets/")) return null;
  const q = url.indexOf("?");
  const path = url.slice("/assets/".length, q >= 0 ? q : undefined);
  const h = index[path];
  return typeof h === "string" && /^[0-9a-f]{12,64}$/.test(h) ? h : null;
}

export function withV(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  const h = assetHashFor(url);
  if (h) return `${url}${sep}h=${h}`;
  return V ? `${url}${sep}v=${V}` : url;
}

/** Fetch /asset-index.json; never throws, never blocks a boot — a missing or
 *  malformed index just leaves the `?v` fallback in force. */
export async function loadAssetIndex(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl("/asset-index.json"); // the server says no-cache; the browser revalidates
    if (!res.ok) return false;
    const doc = (await res.json()) as { schema?: string; files?: Record<string, string> };
    if (doc?.schema !== ASSET_INDEX_SCHEMA || !doc.files || typeof doc.files !== "object") return false;
    setAssetIndex(doc.files);
    return true;
  } catch {
    return false;
  }
}

export function assetIndexInfo(): { loaded: boolean; files: number; buildSha: string } {
  return { loaded: !!index, files: index ? Object.keys(index).length : 0, buildSha: V || "dev" };
}
