/**
 * The composer's own foley library — WHAT EXISTS, AND WHERE, read from data.
 *
 * This used to resolve takes with `import.meta.glob` over the disk at build
 * time, which had two consequences worth stating because both were paid for:
 *
 *  - It bundled the whole library through Vite, which is why the library had
 *    to sit inside games2/ at all. That is the reason a sound agent could not
 *    be handed one directory (maintainer, 2026-09-02: "you save your music and
 *    sound in your own folder and it has become a total mess").
 *  - Reading the DISK meant the manifest could rot unnoticed, and it did:
 *    foley.json named 452 takes .wav for two weeks after they shipped as .ogg,
 *    and nothing failed because the one consumer that would have caught it was
 *    working around it.
 *
 * Now the library is described by index.json (pixel-foley-index@1), which
 * carries `root` — where its paths live, repo-root-relative. The engine JOINS
 * that root rather than hardcoding a location, so moving the library is a data
 * change and not a code change. Both locations are probed below for exactly
 * that reason: the move can land whenever it lands.
 *
 * Loading is async and finishes with loadCatalog(), so composer foley and the
 * catalog it overrides become available in the same tick — the override order
 * can never be observed half-applied.
 *
 * WHY THE LIBRARY IS IN sounds/ AND NOT HERE. Measured on nangijala.online
 * 2026-09-02: /assets/composer/foley/... is 404 — the runtime image does not
 * carry composer/ at that path, whatever the server's two mounts suggest —
 * while /assets/sounds/ is served, content-hashed and immutable. So the move
 * is what MAKES this fetch work; it is not a tidy-up.
 */
import { assetBaseFor, withAudioV } from "./assetver";

interface FoleyIndex {
  format?: string;
  root?: string;
  sets?: Record<string, { takes?: string[]; pool?: string[] }>;
}

/** The library lives in sounds/ — one directory a dedicated sound agent owns
 *  outright — and is served from the same /assets/sounds mount as the catalog
 *  it overrides, so it is content-hashed and immutable like everything else. */
const INDEX_URL = "/assets/sounds/foley/index.json";

type Row = { name: string; url: string };
const takesBySet = new Map<string, Row[]>();
const poolBySet = new Map<string, Row[]>();

/** Turn the index into playable urls. Every path is JOINED to the manifest's
 *  own `root`, so where the library lives is data — the whole reason it could
 *  move out of games2/ without an engine change. */
function ingest(doc: FoleyIndex): boolean {
  if (!doc?.sets || !doc.root) return false;
  const base = assetBaseFor(doc.root);
  takesBySet.clear();
  poolBySet.clear();
  for (const [set, entry] of Object.entries(doc.sets)) {
    const row = (rel: string): Row => ({
      name: rel.split("/").pop() ?? rel,
      url: withAudioV(base + rel),
    });
    const t = (entry.takes ?? []).map(row);
    const p = (entry.pool ?? []).map(row);
    if (t.length) takesBySet.set(set, t);
    if (p.length) poolBySet.set(set, p);
  }
  return takesBySet.size > 0 || poolBySet.size > 0;
}

let loaded: Promise<boolean> | null = null;

/** Fetch the index once. Never throws: a missing library degrades to "the
 *  composer has generated nothing", which falls back to the catalog exactly
 *  as an ungenerated surface always has. */
export function loadComposerFoley(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (loaded) return loaded;
  loaded = (async () => {
    try {
      const res = await fetchImpl(INDEX_URL);
      if (res.ok && ingest((await res.json()) as FoleyIndex)) return true;
    } catch {
      /* a boot with no network: the composer has generated nothing */
    }
    return false;
  })();
  return loaded;
}

/** Take urls for a surface, or null if the composer has not generated it yet
 *  (→ fall back to the catalog). */
export function composerFoley(surface: string): string[] | null {
  const takes = takesBySet.get(surface);
  return takes && takes.length > 0 ? takes.map((r) => r.url) : null;
}

/** ONE named take of a set. `take` may be the file stem ("punch__take02"), the
 * bare number ("take02", "2", 2), or the full path the wiki sends. Returns null
 * when the set or the take is not in the index, so an assignment for a deleted
 * take goes silent rather than quietly playing a different recording. */
export function composerFoleyTake(set: string, take: string | number): string | null {
  // The POOL counts as a source of recordings, not just the selected takes.
  // The wiki auditions every candidate, so he assigns whatever he liked — he
  // picked thunder__cand07/08/09/17 (all pool files) for weather.thunder. If
  // this only looked at the takes, those four assignments would resolve to
  // silence and the request would look honoured while playing nothing.
  const rows = [...(takesBySet.get(set) ?? []), ...(poolBySet.get(set) ?? [])];
  if (!rows.length) return null;
  // The wiki's request carries the EXACT recording path — its own board note:
  // `take: composer/foley/ui_tick/ui_tick__take04.wav`. Accept that verbatim
  // (a request should wire in as DATA, not as a transcription step) alongside
  // a bare take name and a 1-based index.
  const want = String(take).trim().replace(/^.*\//, "").replace(/\.(ogg|wav)$/i, "");
  const stem = (r: Row) => r.name.replace(/\.(ogg|wav)$/i, "");
  const hit =
    rows.find((r) => stem(r) === want) ??
    rows.find((r) => stem(r).endsWith(`__${want}`)) ??
    (/^\d+$/.test(want) ? rows[Number(want) - 1] : undefined);
  return hit ? hit.url : null;
}

export function composerFoleySurfaces(): string[] {
  return [...takesBySet.keys()];
}

/** Candidate pools for the human audition page (/#foley): every generated
 *  candidate, not just the auto-selected takes. */
export function composerFoleyPools(): Map<string, Row[]> {
  return poolBySet;
}

export function composerFoleyTakes(): Map<string, Row[]> {
  return takesBySet;
}
