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
    const r = await fetch(`https://api.github.com/repos/${REPO}/commits/main`);
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
export async function enterStaging(world: string): Promise<boolean> {
  const b = await resolveStagingBase();
  if (!b) return false;
  try {
    const probe = await fetch(`${b}maps2/worlds/${world.replace(/[^a-z0-9_-]/gi, "")}/world.json`);
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
