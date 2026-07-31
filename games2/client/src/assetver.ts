/**
 * Deploy-pinned asset URLs: append ?v=<build sha> to /assets requests so the
 * server can grant them `immutable` caching (see server/src/index.ts
 * setCacheHeaders). Art bytes are BAKED into the deploy image, so for one sha
 * the bytes can never change — same sha ⇒ cache hit with zero requests, new
 * deploy ⇒ new sha ⇒ new URL ⇒ guaranteed fresh download. The server only
 * grants immutable when the ?v matches ITS OWN GIT_SHA, so a mixed-revision
 * race during a rollout degrades to no-cache (a revalidated fetch), never a
 * stale cache entry. In dev VITE_GIT_SHA is "dev"/unset → URLs stay unversioned
 * and keep the no-cache revalidate behavior.
 */
const sha = ((import.meta.env.VITE_GIT_SHA as string | undefined) || "").trim();
const V = sha && sha !== "dev" ? sha : "";

/** Version-pin a deploy-baked URL (no-op in dev builds). Used for /assets art
 * AND for the two logo PNGs in client/public — they are the heaviest bytes on
 * the critical path (~1.1 MB), and unstamped they cost a revalidation
 * round-trip on EVERY visit before the loading screen can even paint. Same
 * contract as the art: the server grants immutable only when ?v matches its own
 * GIT_SHA, so a stamped URL is stale-proof and a deploy mints a new one. */
export function withV(url: string): string {
  return V ? `${url}${url.includes("?") ? "&" : "?"}v=${V}` : url;
}
