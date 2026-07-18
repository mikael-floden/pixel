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
