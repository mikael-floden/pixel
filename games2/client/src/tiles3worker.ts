/** THE GROUND RESOLVER, ON ANOTHER CORE.
 *
 * WHY THIS EXISTS. Every line of this client runs on the browser's ONE main
 * thread — the resolver, the ground slice, the occluder rebuild, the lighting
 * twins, prediction and the render commands — so a 25.8 ms ground slice does not
 * run BESIDE a frame, it runs INSTEAD of one, and the frame comes out at 50.6 ms.
 * That is the maintainer's stutter, thirty times in twenty-four seconds, and his
 * question was the right one: "doesn't my phone have several cores?" It does.
 * The game used one of them.
 *
 * WHAT MOVES, AND WHAT CANNOT. A worker has no WebGL and no textures, so the
 * DRAW stays on the main thread. What moves is the RESOLUTION — which cell wears
 * which art — measured at 60-75% of a cold ground paint (dev host, forced full
 * paints: 21.5-31.5 ms with the resolution cache warm against 64.3-112.8 ms
 * cold). Nothing here composes a raster or touches a texture.
 *
 * IT IS THE SAME CODE, NOT A COPY. tiles3.ts, tiles3runtime.ts and
 * wallregion.ts were written pure and Phaser-free for the parity gates against
 * render3.py, and that turns out to be exactly the precondition for a worker:
 * every `document`/`window`/`Phaser.` in those three files is a COMMENT. So this
 * imports the real resolver and the real world parser rather than reimplementing
 * either — a second implementation of "what draws on this cell" is the one thing
 * this repo must never have.
 *
 * IT ANSWERS AHEAD, NEVER ON DEMAND. The ground pass cannot await a message, so
 * nothing blocks on this: it serves the PREFETCH ring, whose whole job is to
 * warm the main thread's resolution cache before the band that needs it is
 * painted. A late answer costs nothing — the main thread resolves that cell
 * itself, exactly as it does today. That is what makes this safe to try.
 */
import { parseWorld } from "@nangijala/shared";
import { Tiles3, type Frame } from "./tiles3";
import {
  Tiles3World,
  tiles3DataFrom,
  viewFromParsed,
  cellArtPaths,
  boundaryArtPaths,
  deckArtPaths,
  type Tiles3DocKey,
} from "./tiles3runtime";
import type { Tiles3Cell, Tiles3Boundary, Tiles3DeckCell } from "./tiles3";

/** Boot: every URL is built by the MAIN thread and handed over. The worker must
 *  not re-derive a URL — staging rewrites `/assets/**` onto a CDN and a second
 *  copy of that rule is a second thing to get wrong. */
export interface WorkerInit {
  type: "init";
  gen: number;
  docUrls: Partial<Record<Tiles3DocKey, string>>;
  worldUrl: string;
  frame: Frame;
  pitch: number;
}
export interface WorkerResolve {
  type: "resolve";
  gen: number;
  /** Cell indices, `row * width + col`. */
  cells: Int32Array;
}
export type WorkerIn = WorkerInit | WorkerResolve;

export interface ResolvedCell {
  i: number;
  cell: Tiles3Cell | null;
  boundary: Tiles3Boundary | null;
  decks: Tiles3DeckCell[];
}
export type WorkerOut =
  | { type: "ready"; gen: number; ms: number; width: number; height: number; regionMs: number }
  | { type: "failed"; gen: number; error: string }
  | { type: "resolved"; gen: number; cells: ResolvedCell[]; paths: string[]; ms: number };

let world: { width: number; height: number } | null = null;
let t3: Tiles3World | null = null;
let gen = -1;

const post = (m: WorkerOut, transfer?: Transferable[]) =>
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(m, transfer);

async function init(msg: WorkerInit): Promise<void> {
  const t0 = performance.now();
  gen = msg.gen;
  t3 = null;
  world = null;
  /* Fetched HERE rather than cloned from the main thread: the_game's world.json
   * is 737 KB raw and its parsed form is 262,144 cell objects, so a structured
   * clone would cost the main thread more than the parse it is saving. The
   * documents are already `no-cache`-revalidated or content-hash-immutable, so
   * a second fetch is a 304 or a cache hit, not a second download. */
  const [worldDoc, docEntries] = await Promise.all([
    fetch(msg.worldUrl).then((r) => (r.ok ? r.json() : null)),
    Promise.all(
      Object.entries(msg.docUrls).map(async ([k, url]) => {
        try {
          const r = await fetch(url as string);
          return [k, r.ok ? await r.json() : undefined] as const;
        } catch {
          return [k, undefined] as const;
        }
      }),
    ),
  ]);
  if (!worldDoc) throw new Error(`world did not load: ${msg.worldUrl}`);
  const parsed = parseWorld(worldDoc);
  if (!parsed) throw new Error("world did not parse");
  const docs: Partial<Record<Tiles3DocKey, unknown>> = {};
  for (const [k, v] of docEntries) docs[k as Tiles3DocKey] = v;
  const data = tiles3DataFrom(docs, msg.pitch, () => {});
  if (!data) throw new Error("no ground_types/patterns — the resolver cannot be built");
  const view = viewFromParsed(parsed as never);
  /* THE REGION FLOOD FILL — 38 ms over the_game on the dev host, and the single
   * biggest lump of the main thread's own world load. Here it is free. */
  const rT0 = performance.now();
  t3 = new Tiles3World({ view, tiles: new Tiles3(data), frame: msg.frame, patterns: data.patterns });
  const regionMs = performance.now() - rT0;
  world = { width: parsed.width, height: parsed.height };
  post({ type: "ready", gen, ms: performance.now() - t0, width: parsed.width, height: parsed.height, regionMs });
}

function resolve(msg: WorkerResolve): void {
  if (!t3 || !world || msg.gen !== gen) return; // a stale request against a rebuilt resolver
  const t0 = performance.now();
  const out: ResolvedCell[] = [];
  const paths = new Set<string>();
  const need = (p: string | null | undefined) => {
    if (p) paths.add(p);
  };
  for (const i of msg.cells) {
    const col = i % world.width;
    const row = (i - col) / world.width;
    /* EVERY CALL IS GUARDED, exactly as the scene's `t3Try` guards them:
     * `Tiles3.overTile` THROWS on a missing x-over-y pair, deliberately, and an
     * uncaught throw here would kill the worker for the whole session rather
     * than one cell. A cell that fails resolves to nothing and the main thread
     * falls back to its own path, which is the behaviour without a worker. */
    let cell: Tiles3Cell | null = null;
    let boundary: Tiles3Boundary | null = null;
    let decks: Tiles3DeckCell[] = [];
    try {
      cell = t3.cell(col, row);
    } catch {
      cell = null;
    }
    try {
      boundary = t3.boundary(col, row);
    } catch {
      boundary = null;
    }
    try {
      decks = t3.decks(col, row);
    } catch {
      decks = [];
    }
    if (cell) cellArtPaths(cell, need);
    if (boundary) boundaryArtPaths(boundary, need);
    for (const d of decks) deckArtPaths(d, need);
    out.push({ i, cell, boundary, decks });
  }
  post({ type: "resolved", gen, cells: out, paths: [...paths], ms: performance.now() - t0 });
}

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    init(msg).catch((e) => post({ type: "failed", gen: msg.gen, error: String((e as Error)?.message ?? e) }));
    return;
  }
  if (msg.type === "resolve") resolve(msg);
};
