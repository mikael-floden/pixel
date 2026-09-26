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
import type { Tiles3Data } from "./tiles3.js";
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
import { rotateWorldDoc, normRot, unrotCell } from "./viewrot";
import { slopeRule } from "./slopeheight";
import { setPickFrame } from "./tiles3";

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
  /** The details dial (detailrate.ts) — the same rate the main thread rolls. */
  detailRate?: number;
  /** THE GAME RULES THE MAIN THREAD SETS ON ITS RESOLVER, and the worker must
   *  too, or the two disagree on every cell the rules touch (the foot, the
   *  slope on both sides of a rise, the fade dials): the worker ran the parity
   *  path until 2026-09-24. */
  fadeTune?: Tiles3Data["fadeTune"];
  footBoundary?: boolean;
  deckBoundary?: boolean;
  /** His slope switch's STOP (slopeheight.ts), not a share: the worker runs
   *  `slopeRule` over its own (turned) world, as the main thread does. */
  slopeStop?: number;
  /** VIEW ROTATION (viewrot.ts): quarter-turns the DRAWN world is rotated by.
   *  The worker fetches world.json itself, so it must rotate it itself - with
   *  the same function the main thread uses - or it resolves the unrotated
   *  world and answers for the wrong cells. */
  viewRot?: number;
  /** Test switch: picks keyed by the DRAWN cell (WorldScene PICK_VIEW). */
  pickView?: boolean;
}
export interface WorkerResolve {
  type: "resolve";
  gen: number;
  /** Cell indices, `row * width + col`. */
  cells: Int32Array;
}
/** Build the resolver for another view orientation AHEAD of a turn, without
 *  switching to it (the neighbours of the one on screen), from the documents
 *  this worker already holds. */
export interface WorkerWarm {
  type: "warm";
  viewRot: number;
}
export type WorkerIn = WorkerInit | WorkerResolve | WorkerWarm;

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
/* WHAT A VIEW TURN KEEPS. A turn used to terminate this worker and boot a new
 * one: the world (737 KB, 262,144 cells) and the thirteen resolver documents
 * (13.5 MB) fetched and parsed again, the regions flood-filled again, and the
 * main thread resolving the new view by itself meanwhile — the "preparing"
 * a person felt in every turn. Now the fetched documents stay (keyed by every
 * option but the view), and each orientation's resolver is built once and
 * kept; a turn to a warmed orientation answers "ready" at once. */
let held: { key: string; worldDoc: unknown; docs: Partial<Record<Tiles3DocKey, unknown>>; opts: WorkerInit } | null = null;
const byView = new Map<number, { t3: Tiles3World; world: { width: number; height: number }; regionMs: number }>();
let curView = 0;

const post = (m: WorkerOut, transfer?: Transferable[]) =>
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(m, transfer);

/** Everything a resolver depends on except the view: equal keys share documents. */
function optsKey(m: WorkerInit): string {
  return JSON.stringify([m.worldUrl, m.docUrls, m.frame, m.pitch, m.detailRate, m.fadeTune, m.footBoundary, m.deckBoundary, m.slopeStop, m.pickView]);
}

/** The resolver for orientation `vk`, built from the held documents (cached). */
function resolverFor(vk: number): { t3: Tiles3World; world: { width: number; height: number }; regionMs: number } {
  const hit = byView.get(vk);
  if (hit) return hit;
  if (!held) throw new Error("no documents held");
  const msg = held.opts;
  const worldDoc = held.worldDoc as { size?: { w?: number; h?: number } };
  const parsed = parseWorld(rotateWorldDoc(worldDoc, vk as 0 | 1 | 2 | 3));
  if (!parsed) throw new Error("world did not parse");
  const data = tiles3DataFrom(held.docs, msg.pitch, () => {});
  if (!data) throw new Error("no ground_types/patterns — the resolver cannot be built");
  if (msg.detailRate !== undefined) data.detailRate = msg.detailRate;
  if (msg.fadeTune) data.fadeTune = msg.fadeTune;
  if (msg.footBoundary !== undefined) data.footBoundary = msg.footBoundary;
  if (msg.deckBoundary !== undefined) data.deckBoundary = msg.deckBoundary;
  if (msg.slopeStop !== undefined) {
    const sr = slopeRule(parsed as never, msg.slopeStop);
    data.slopeHeight = sr.slopeHeight;
    if (sr.shares) {
      data.slopeShares = sr.shares;
      data.slopeSharesW = parsed.width;
    }
  }
  const view = viewFromParsed(parsed as never);
  /* THE REGION FLOOD FILL — 38 ms over the_game on the dev host, and the single
   * biggest lump of the main thread's own world load. Here it is free. */
  const rT0 = performance.now();
  const out = { t3: new Tiles3World({ view, tiles: new Tiles3(data), frame: msg.frame, patterns: data.patterns }), world: { width: parsed.width, height: parsed.height }, regionMs: performance.now() - rT0 };
  byView.set(vk, out);
  return out;
}

/** Picks keyed by the SERVER cell, exactly as the main thread keys them (tiles3 setPickFrame). */
function pickFrameFor(vk: number, pickView: boolean | undefined): void {
  const d = held?.worldDoc as { size?: { w?: number; h?: number } } | undefined;
  const sw = d?.size?.w ?? 0, sh = d?.size?.h ?? 0;
  setPickFrame(vk && !pickView ? (x, y) => unrotCell(x, y, vk as 0 | 1 | 2 | 3, sw, sh) : null);
}

async function init(msg: WorkerInit): Promise<void> {
  const t0 = performance.now();
  gen = msg.gen;
  t3 = null;
  world = null;
  const key = optsKey(msg);
  if (!held || held.key !== key) {
    byView.clear();
    held = null;
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
    if (msg.gen !== gen) return; // a newer init arrived while this one fetched
    const docs: Partial<Record<Tiles3DocKey, unknown>> = {};
    for (const [k, v] of docEntries) docs[k as Tiles3DocKey] = v;
    held = { key, worldDoc, docs, opts: msg };
  }
  const vk = normRot(msg.viewRot ?? 0);
  curView = vk;
  pickFrameFor(vk, msg.pickView);
  const r = resolverFor(vk);
  t3 = r.t3;
  world = r.world;
  post({ type: "ready", gen, ms: performance.now() - t0, width: r.world.width, height: r.world.height, regionMs: r.regionMs });
  // and the NEIGHBOURS, after the answer: the next turn either way finds its
  // resolver built (a turn's worth of work done while nobody waits on it)
  setTimeout(() => {
    warm({ type: "warm", viewRot: vk + 1 });
    warm({ type: "warm", viewRot: vk + 3 });
  }, 0);
}

/** A neighbour's resolver, built ahead of its turn (idle work in this thread). */
function warm(msg: WorkerWarm): void {
  if (!held) return;
  const vk = normRot(msg.viewRot);
  if (byView.has(vk)) return;
  // built under ITS OWN pick frame (picks key by the server cell of that
  // orientation), then the one on screen is put back
  pickFrameFor(vk, held.opts.pickView);
  try {
    resolverFor(vk);
  } catch {
    /* built again, for real, when the turn asks */
  } finally {
    pickFrameFor(curView, held.opts.pickView);
  }
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
      boundary = t3.boundary(col, row, cell); // the cell resolved just above, not a second resolve
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
  if (msg.type === "warm") warm(msg);
};
