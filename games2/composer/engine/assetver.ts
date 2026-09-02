/**
 * Cache tokens for AUDIO urls — and, just as important, which urls get NONE.
 *
 * Two kinds of audio url reach the browser, and they are cached by different
 * mechanisms; stamping the wrong one is a measured loss, not a no-op
 * (game agent, 2026-08-22, prod build across a simulated deploy: night.mp3
 * 1.52 MB plus thunder and both jump voices re-fetched for nothing).
 *
 *  1. URLS BUILT UNDER /assets/sounds/ and /assets/music/ (catalog.ts). These
 *     are files served from the runtime image. The server freezes such a
 *     response for a year ONLY when `?h=<hash>` equals the sha256-16 of the
 *     bytes it is about to send (server/src/cachepolicy.ts + assethash.ts) —
 *     it never trusts an index, so a stale hash can only earn a revalidation,
 *     never a wrong file. The hash comes from /asset-index.json, loaded by
 *     main.ts before the composer boots (client/src/assetver.ts). Result: an
 *     unchanged bed keeps its url across deploys and is never requested
 *     again. `?v=<build sha>` stays as the fallback for a boot where the index
 *     did not load — that url changes every deploy, which is exactly the
 *     re-download the hash removes.
 *
 *  2. URLS THAT CAME FROM AN IMPORT (foley.ts, contextMusic.ts, titleTheme.ts
 *     — import.meta.glob with ?url). In a production build those are Vite
 *     BUNDLE EMITS, /assets/<name>-<contenthash>.<ext> under client/dist, and
 *     the server already grants them immutable BY DIRECTORY because the
 *     bundler put the content hash in the filename. They need no token, ever,
 *     and a `?v` on one is pure loss: it changes the url every deploy and
 *     forces a re-download of bytes the browser already holds. So those call
 *     sites use the url exactly as the bundler handed it over.
 *
 * ONE HASH, ONE SOURCE. This file used to be a "twin" of client/src/assetver
 * with its own build-sha token, and then briefly a whole second manifest with
 * a different algorithm (blake2b/8) that could never match what the server
 * verifies (sha256-16). Both were the same mistake: a second opinion about
 * what the bytes are. The safety property is that the server compares the
 * token against the bytes it serves, so the only correct client is one that
 * asks the same index the server's own client reads.
 */
import { assetHashFor } from "../../client/src/assetver";

const sha = ((import.meta.env.VITE_GIT_SHA as string | undefined) || "").trim();
const V = sha && sha !== "dev" ? sha : "";

/** Stamp a url the engine BUILT under /assets/sounds/ or /assets/music/:
 *  `?h=<content hash>` when the asset index names it, else the deploy `?v`
 *  fallback, else (dev) untouched. NEVER call this on a url that came from an
 *  import — see the header. */
export function withAudioV(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  const h = assetHashFor(url);
  if (h) return `${url}${sep}h=${h}`;
  return V ? `${url}${sep}v=${V}` : url;
}
