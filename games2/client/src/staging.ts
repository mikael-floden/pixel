/**
 * STAGING WORLDS — play a map that is NOT in the deployed image, streamed from
 * GitHub (maintainer 2026-08-15: dev maps must cost the image nothing, and
 * "monster_demo with all monsters" must not drag 16 MB of monster art into
 * production).
 *
 * THE CONTRACT: the image carries only `userWorlds` (config/publish.json).
 * Every other world is STAGING — its world.json, tiles, sidecars and any
 * monster/NPC art the image lacks are fetched from the repo via CDN, but only
 * on the client that actually joins it (the admin's). A normal player is
 * never offered such a world and downloads none of this.
 *
 * WHY jsDelivr AND sha-pinned (same reasoning as the wiki's admin path,
 * measured 2026-08-14): a sha-pinned `cdn.jsdelivr.net/gh/<repo>@<sha>/…`
 * response carries `cache-control: max-age=31536000, immutable` + CORS `*` —
 * the same immutability contract the in-image `?v=<sha>` scheme gives — while
 * raw.githubusercontent answers max-age=300 even for a commit-pinned ref.
 *
 * INJECTABLE, which is what makes this testable at all: `ml-staging-base` in
 * localStorage overrides the CDN base. The agent sandbox gives the headless
 * browser no external egress, so the gate (verify-stagingworld.mjs) points
 * this at a local fixture origin — a genuinely different origin, exercising
 * the identical cross-origin path. The override is read BEFORE any network,
 * so a gated run never touches GitHub.
 *
 * The SERVER has its own half (WorldRoom: disk first, then GitHub) — this
 * module is only the browser's. Both fail soft: a dead CDN degrades a staging
 * join, never a normal one (shipped worlds resolve entirely from the image
 * and never enter this code path).
 */

const REPO = "mikael-floden/pixel";
let base: string | null = null; // trailing slash; null = staging inactive

/**
 * fetch WITH A DEADLINE. Every fetch on the boot path needs one, and none had
 * one until 2026-08-15 (maintainer: "when I start the game it's sometimes
 * stuck on a black screen").
 *
 * THE BUG THIS FIXES, because a try/catch is not enough: an admin's
 * loadWorldsList awaits isAdmin() -> stagingWorlds() -> resolveStagingBase(),
 * which fetches api.github.com and then cdn.jsdelivr.net. Every one of those
 * was wrapped in try/catch, so a FAILING request was handled — but a HANGING
 * one is not catchable. It just never settles, the await never returns, and
 * boot() never reaches the select screen. What the player gets is the version
 * badge (drawn before the first await) alone on a black page, forever, with no
 * spinner and nothing to retry.
 *
 * api.github.com rate-limits unauthenticated callers to 60/hour PER IP, and
 * the resolved sha is cached in sessionStorage, so the call happens once per
 * fresh session — which is exactly "sometimes, when I start the game".
 *
 * Aborting is strictly better than waiting here: every caller of these already
 * degrades gracefully to "no staging worlds", which costs an admin nothing but
 * three extra rows in the picker.
 */
export async function fetchSoon(url: string, ms = 3000, init?: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function stagingActive(): boolean {
  return base !== null;
}

/** Resolve the CDN base without activating anything (the picker uses this to
 * list dev worlds; activation happens only when one is actually joined). */
export async function resolveStagingBase(): Promise<string | null> {
  try {
    const override = localStorage.getItem("ml-staging-base");
    if (override) return override.endsWith("/") ? override : override + "/";
  } catch {}
  try {
    const hit = sessionStorage.getItem("ml-staging-sha");
    if (hit) return `https://cdn.jsdelivr.net/gh/${REPO}@${hit}/`;
  } catch {}
  try {
    // 2.5s: this is an admin nicety (three extra picker rows). It must never
    // be the reason the game does not start.
    const r = await fetchSoon(`https://api.github.com/repos/${REPO}/commits/main`, 2500);
    const sha = ((await r.json()) as { sha?: string })?.sha;
    if (sha) {
      try {
        sessionStorage.setItem("ml-staging-sha", sha);
      } catch {}
      return `https://cdn.jsdelivr.net/gh/${REPO}@${sha}/`;
    }
  } catch {}
  return null;
}

/**
 * Turn staging ON for this page: every URL passed through gameUrl() from here
 * on resolves against the repo instead of the image. Verified by actually
 * fetching the world's own world.json — activating on a dead base would turn
 * one broken join into a page of broken art.
 */
export async function enterStaging(world: string, root = "maps2/worlds"): Promise<boolean> {
  const b = await resolveStagingBase();
  if (!b) return false;
  try {
    // `root` is the world's tree (maps2/worlds or maps2/worlds3) — passed in by
    // the caller rather than imported from maps.ts, which imports gameUrl from
    // here. Anything else falls back to the default tree, so an unknown value
    // probes exactly the path this function probed before worlds3 existed.
    const dir = /^maps2\/worlds3?$/.test(root) ? root : "maps2/worlds";
    const probe = await fetchSoon(`${b}${dir}/${world.replace(/[^a-z0-9_-]/gi, "")}/world.json`, 5000);
    if (!probe.ok) return false;
  } catch {
    return false;
  }
  base = b;
  console.log(`[staging] world "${world}" streams from ${b}`);
  return true;
}

/**
 * THE CHOKEPOINT. Image-relative URL → where it really lives right now.
 * Inactive (every normal player, every shipped world): identity, zero cost.
 * Active: /assets/<path> is the repo path itself; the generated bundle files
 * (/atlases, /monsters.json, /npcs.json) live under games2/client/public in
 * the repo, because that is where their builders write and git tracks them.
 *
 * THE `/assets/<path>` RULE ALREADY COVERS TILES 3.0, and that is why no
 * tiles3 case appears below: the resolver names REPO-RELATIVE files
 * ("tiles/plates/…", "tiles/patterns/…", "tiles/review/…") which are served at
 * "/assets/tiles/…", so the same slice maps them onto the repo. Same for
 * "/assets/live/tuning/base_tile_sets.json" and a maps3 world's own
 * "/assets/maps2/worlds3/<name>/…". The image ships none of the tiles3 art
 * (config/publish.json ships `userWorlds` only), so on a staging join every one
 * of those bytes comes from the CDN and production carries zero of them.
 */
export function gameUrl(url: string): string {
  if (base === null) return url;
  if (url.startsWith("/assets/")) return base + url.slice("/assets/".length);
  if (url.startsWith("/atlases/")) return base + "games2/client/public" + url;
  if (url === "/monsters.json" || url === "/npcs.json") return base + "games2/client/public" + url;
  return url;
}

/**
 * Merge a staging manifest over the image's: entries the image already has
 * WIN (their art is local and byte-identical anyway); entries the image lacks
 * — the whole point — are added with every "/assets/…" string inside them
 * rewritten through gameUrl, so a dev-world monster's strips stream from the
 * repo while the island's keep coming from the image.
 */
export function mergeStagingEntries<T extends { id?: string }>(local: T[], staging: T[]): T[] {
  const have = new Set(local.map((e) => e.id));
  const rewrite = (v: unknown): unknown => {
    if (typeof v === "string") return v.startsWith("/assets/") ? gameUrl(v) : v;
    if (Array.isArray(v)) return v.map(rewrite);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, rewrite(x)]));
    return v;
  };
  const added = staging.filter((e) => e.id && !have.has(e.id)).map((e) => rewrite(e) as T);
  return added.length ? [...local, ...added] : local;
}
