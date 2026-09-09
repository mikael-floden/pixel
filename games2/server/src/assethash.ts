/** THE HASH OF THE BYTES A FILE ACTUALLY HOLDS — sha256, first 16 hex digits.
 *
 *  This is what the per-file cache grant is verified against (cachepolicy.ts):
 *  a request for `<art>?h=<hash>` is frozen for a year ONLY when <hash> equals
 *  the hash of the file the server is about to send. The client's index
 *  (/asset-index.json) is merely how it learns the current hashes; the server
 *  never trusts it. A stale index can therefore only ever produce a
 *  revalidated response, never a frozen wrong file.
 *
 *  Memoised per path, keyed on size + mtime so an edited file (dev, or a
 *  hot-patched volume) re-hashes instead of serving a stale verdict. In the
 *  image files never change and every file is hashed at most once. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const ASSET_HASH_ALGO = "sha256-16";
export const ASSET_HASH_RE = /^[0-9a-f]{16}$/;

export function hashBytes(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

const memo = new Map<string, { size: number; mtimeMs: number; hash: string }>();

/** Null when the file cannot be read — the caller must then NOT grant. */
export function assetHash(filePath: string): string | null {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    const m = memo.get(filePath);
    if (m && m.size === st.size && m.mtimeMs === st.mtimeMs) return m.hash;
    const hash = hashBytes(readFileSync(filePath));
    memo.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, hash });
    return hash;
  } catch {
    return null;
  }
}

/** Test seam: forget every memoised verdict. */
export function resetAssetHashMemo(): void {
  memo.clear();
}
