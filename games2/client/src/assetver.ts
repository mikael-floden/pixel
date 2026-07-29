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

/** Version-pin an /assets URL (no-op in dev builds). */
export function withV(url: string): string {
  return V ? `${url}${url.includes("?") ? "&" : "?"}v=${V}` : url;
}
