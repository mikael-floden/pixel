/**
 * Deploy-pinned AUDIO urls — the composer's twin of client/src/assetver.ts.
 *
 * The score + foley only change when the composer regenerates them, i.e. on a
 * new deploy. But every audio /assets url the engine fetches is UNVERSIONED, so
 * the server hands it `no-cache` (see server/src/index.ts setCacheHeaders) and
 * the browser REVALIDATES the whole music bed + every footstep set on every
 * single page load — a round-trip per file even when the bytes are already in
 * the disk cache (the maintainer: "stop downloading music and sound effects
 * [that] already download"). Stamping `?v=<build sha>` moves them into the
 * server's `immutable` branch: the bytes are BAKED into the image, so for one
 * sha they can never change → same sha ⇒ cache hit with ZERO requests, new
 * deploy ⇒ new sha ⇒ new url ⇒ one guaranteed-fresh download. The server only
 * grants immutable when the ?v matches ITS OWN GIT_SHA, so a mixed-revision
 * rollout degrades to a revalidated fetch, never a stale one. In dev
 * VITE_GIT_SHA is "dev"/unset → urls stay unversioned and keep revalidating
 * (and Vite's dev middleware serves the raw source paths, which we must not
 * touch). Kept separate from the client's copy on purpose: the composer is a
 * self-contained domain and never reaches into client/src.
 */
const sha = ((import.meta.env.VITE_GIT_SHA as string | undefined) || "").trim();
const V = sha && sha !== "dev" ? sha : "";

/** Version-pin an /assets audio url (no-op in dev builds). */
export function withAudioV(url: string): string {
  return V ? `${url}${url.includes("?") ? "&" : "?"}v=${V}` : url;
}
