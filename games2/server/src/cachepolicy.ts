/**
 * ONE decision, isolated: what `Cache-Control` does this file get?
 *
 * Split out of index.ts because it is the highest-consequence line in the
 * server. A wrong `immutable` is UNRECALLABLE — a browser that has frozen a
 * URL for a year cannot be told to forget it: no deploy, no cache purge, no
 * F5 and no amount of shouting reaches it. The only safe way to hand out a
 * one-year grant is to be able to prove the rule, which means being able to
 * test it without booting a server. Hence a pure function.
 *
 * THE THREE OUTCOMES:
 *
 *  1. `immutable` — a rollup emit under client/dist/assets. Vite names every
 *     file there `<name>-<contenthash>.<ext>`, so that URL cannot ever denote
 *     different bytes: change the content and you change the filename.
 *  2. `immutable` — art requested with `?v=<this instance's GIT_SHA>`. The
 *     client stamps its own build sha (client/src/assetver.ts) and the art is
 *     baked into the SAME image, so for that one sha the bytes are fixed.
 *     A rollout mismatch (old instance, new sha) simply falls through to (3).
 *  3. `no-cache` — everything else. Revalidated on every load: cheap 304s,
 *     and a deploy is visible immediately.
 *
 * WHY THE DIRECTORY TEST IS LOAD-BEARING, and not merely tidy:
 * one `setCacheHeaders` serves the /assets/<domain> ART mounts AND the client
 * bundle. The art agents routinely repaint a tile IN PLACE — same path, new
 * pixels — which is exactly why art defaults to no-cache. So a rule that
 * asked only "does this filename look content-hashed?" would freeze a
 * repainted tile for a year the first time an art file happened to be named
 * `foo-a1b2c3d4.webp`. Measured 2026-08-15: zero art files match that shape
 * today, across every domain. That is luck, not an invariant, and it is not
 * something a future art push should be able to break by accident. A file
 * inside client/dist/assets, by contrast, is rollup output by construction —
 * client/public has no `assets/` directory, so nothing else can land there.
 *
 * The filename test then stays as the second condition, so a future build
 * step dropping a FIXED-name file into that directory keeps no-cache instead
 * of inheriting a grant it cannot honour.
 */
import { basename, sep } from "path";

/** One year, and never revalidate. Only for bytes that cannot change. */
export const IMMUTABLE = "public, max-age=31536000, immutable";
/** Cache, but check with the server every time. The safe default. */
export const REVALIDATE = "no-cache";

/** Vite/rollup default: 8+ url-safe base64 chars before the extension. */
const HASHED_NAME = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

export function isHashedBundleFile(filePath: string, bundleDir: string): boolean {
  // Append the separator so ".../dist/assetsX/" can never pass as ".../dist/assets/".
  const dir = bundleDir.endsWith(sep) ? bundleDir : bundleDir + sep;
  return filePath.startsWith(dir) && HASHED_NAME.test(basename(filePath));
}

export interface CacheSubject {
  /** Absolute on-disk path, as express.static resolved it (NOT the URL). */
  filePath: string;
  /** Absolute path of Vite's output directory (client/dist/assets). */
  bundleDir: string;
  /** This instance's GIT_SHA. "" or "dev" means "not a real deploy". */
  gitSha: string;
  /** The request's `?v` value, if any. */
  queryV: unknown;
}

export function cacheControlFor(s: CacheSubject): string {
  if (isHashedBundleFile(s.filePath, s.bundleDir)) return IMMUTABLE;
  if (s.gitSha && s.gitSha !== "dev" && s.queryV === s.gitSha) return IMMUTABLE;
  return REVALIDATE;
}
