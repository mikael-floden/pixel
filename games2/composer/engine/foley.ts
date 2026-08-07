/**
 * Composer-generated foley (games2/composer/foley/): the composer's own
 * audio, bundled straight into the client by Vite — no asset routes, no
 * server changes. `import.meta.glob` resolves every committed take at BUILD
 * time; surfaces with takes here override the catalog footsteps (the
 * maintainer's QA rated several catalog sets bad/okeyish — the composer
 * regenerates its own, see foley/pipeline/generate.py).
 */

import { withAudioV } from "./assetver";

// foley/<surface>/<surface>__takeNN.wav → hashed bundle URLs.
const files = import.meta.glob("../foley/*/*.wav", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const bySurface = new Map<string, string[]>();
for (const path of Object.keys(files).sort()) {
  const m = path.match(/\.\.\/foley\/([^/]+)\//);
  if (!m) continue;
  const list = bySurface.get(m[1]) ?? [];
  list.push(files[path]);
  bySurface.set(m[1], list);
}

/** Absolute (bundled) take URLs for a surface, or null if the composer has
 * not generated this surface yet (→ fall back to the catalog). */
export function composerFoley(surface: string): string[] | null {
  const takes = bySurface.get(surface);
  // Vite already content-hashes these bundle urls; the ?v=<sha> stamp is what
  // flips the server from no-cache to immutable for a .wav (its hashed-asset
  // rule only covers .js/.css), so a footstep set downloads once per deploy.
  return takes && takes.length > 0 ? takes.map(withAudioV) : null;
}

/** ONE named take of a set, stamped like composerFoley's urls. `take` may be
 * the file stem ("punch__take02"), the bare number ("take02", "2", 2), or the
 * filename — the wiki picks a RECORDING now, not a set, and this is the one
 * place that resolves whichever way it spells it. Returns null when the set or
 * the take is not bundled, so an assignment for a deleted take goes silent
 * rather than quietly playing a different recording. */
export function composerFoleyTake(set: string, take: string | number): string | null {
  // The POOL counts as a source of recordings, not just the selected takes.
  // The wiki auditions every candidate, so he assigns whatever he liked — he
  // picked thunder__cand07/08/09/17 (all pool files) for weather.thunder. If
  // this only looked at the takes, those four assignments would resolve to
  // silence and the request would look honoured while playing nothing.
  const rows = [...(composerFoleyTakes().get(set) ?? []), ...(composerFoleyPools().get(set) ?? [])];
  if (!rows.length) return null;
  // The wiki's request carries the EXACT recording path — its own board note:
  // `take: composer/foley/ui_tick/ui_tick__take04.wav`. Accept that verbatim
  // (a request should wire in as DATA, not as a transcription step) alongside
  // a bare take name and a 1-based index.
  const want = String(take).trim().replace(/^.*\//, "").replace(/\.wav$/i, "");
  const hit =
    rows.find((r) => r.name.replace(/\.wav$/i, "") === want) ??
    rows.find((r) => r.name.replace(/\.wav$/i, "").endsWith(`__${want}`)) ??
    // a bare index: "3" / 3 means the THIRD take, 1-based like the filenames
    (/^\d+$/.test(want) ? rows[Number(want) - 1] : undefined);
  return hit ? withAudioV(hit.url) : null;
}

export function composerFoleySurfaces(): string[] {
  return [...bySurface.keys()];
}

// Candidate pools (foley/<set>/pool/*.wav) for the human audition page
// (/#foley): every generated candidate, not just the auto-selected takes.
const poolFiles = import.meta.glob("../foley/*/pool/*.wav", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const poolBySet = new Map<string, { name: string; url: string }[]>();
for (const path of Object.keys(poolFiles).sort()) {
  const m = path.match(/\.\.\/foley\/([^/]+)\/pool\/([^/]+)$/);
  if (!m) continue;
  const list = poolBySet.get(m[1]) ?? [];
  list.push({ name: m[2], url: poolFiles[path] });
  poolBySet.set(m[1], list);
}

export function composerFoleyPools(): Map<string, { name: string; url: string }[]> {
  return poolBySet;
}

export function composerFoleyTakes(): Map<string, { name: string; url: string }[]> {
  const out = new Map<string, { name: string; url: string }[]>();
  for (const path of Object.keys(files).sort()) {
    const m = path.match(/\.\.\/foley\/([^/]+)\/([^/]+)$/);
    if (!m) continue;
    const list = out.get(m[1]) ?? [];
    list.push({ name: m[2], url: files[path] });
    out.set(m[1], list);
  }
  return out;
}
