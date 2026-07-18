/**
 * Composer-generated foley (games2/composer/foley/): the composer's own
 * audio, bundled straight into the client by Vite — no asset routes, no
 * server changes. `import.meta.glob` resolves every committed take at BUILD
 * time; surfaces with takes here override the catalog footsteps (the
 * maintainer's QA rated several catalog sets bad/okeyish — the composer
 * regenerates its own, see foley/pipeline/generate.py).
 */

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
  return takes && takes.length > 0 ? takes : null;
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
