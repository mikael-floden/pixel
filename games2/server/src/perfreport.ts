/** THE PERF BEACON'S REPORT, SANITISED (POST /api/perf → live/telemetry/perf.json).
 *
 *  EVERY FIELD IS AN ALLOWLIST ENTRY: the handler rebuilds the report from
 *  scratch, so a field the client starts sending is DROPPED SILENTLY until it
 *  is added here. (A `lights` block shipped client-side on 2026-09-07 would
 *  have arrived empty for exactly this reason — caught before it flew.) It is
 *  a pure function so the filter is testable without a server.
 */
export function perfReport(body: Record<string, unknown>, atISO: string) {
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v * 100) / 100)) : null;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
  /** Numbers, booleans and short strings — for blocks that carry switches and
   *  device names beside their counts. Anything else is dropped. */
  const mixed = (v: unknown, keys: number) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out: Record<string, number | boolean | string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, keys)) {
      const key = k.slice(0, 40);
      if (typeof val === "boolean") out[key] = val;
      else if (typeof val === "number") { const n = num(val, -1e9, 1e9); if (n !== null) out[key] = n; }
      else if (typeof val === "string") out[key] = val.slice(0, 80);
    }
    return out;
  };
  /* A LIST OF RECORDS (`{ hops, last: [ {...}, ... ] }`). `mixed` drops an
   * array and `nested` expects keys, so a list of flat rows — one per zone
   * crossing — needs its own arm; same trap, third shape. */
  const rows = (v: unknown, max: number, keys: number) => {
    if (!Array.isArray(v)) return null;
    const out = [];
    for (const r of v.slice(0, max)) {
      const m = mixed(r, keys);
      if (m) out.push(m);
    }
    return out.length ? out : null;
  };
  /* A RECORD OF RECORDS. `mixed` keeps scalars and silently drops anything
   * else, so a nested block passed to it arrives as {} — which is how this
   * allowlist has quietly eaten fields three times now. Anything shaped
   * `{ bucket: { ...numbers } }` goes through here instead. */
  const nested = (v: unknown, keys: number, inner: number) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out: Record<string, Record<string, number | boolean | string>> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, keys)) {
      const m = mixed(val, inner);
      if (m) out[k.slice(0, 60)] = m;
    }
    return out;
  };
  const flat = (v: unknown, keys: number, hi: number) => {
    if (!v || typeof v !== "object") return null;
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, keys)) {
      const n = num(val, 0, hi);
      if (n !== null) out[k.slice(0, 40)] = n;
    }
    return out;
  };
  const report = {
    at: atISO,
    build: str(body.build, 40),
    where: str(body.where, 60),
    tod: str(body.tod, 16),
    zoom: num(body.zoom, 0, 16),
    /* THE WINDOW'S MEAN ZOOM — the client has always sent it and this allowlist
     * dropped it, which is this file's own trap for the second time. It is the
     * variable the fill maths needs: the instantaneous `zoom` is demonstrably
     * unrepresentative (one window snapshotted zoom 2.0 with 320 occluders
     * against a mean of 5,682). */
    zoomMean: num(body.zoomMean, 0, 16),
    dpr: num(body.dpr, 0, 8),
    /* Logical cores on his device. The client uses exactly one of them; this
     * says how many are sitting idle while a ground slice holds the frame. */
    cores: num(body.cores, 0, 256),
    view: str(body.view, 24),
    secs: num(body.secs, 0, 3600),
    final: body.final === true,
    /* 24, not 12: n/p50/p90/p99/max plus the histogram (le17..gt100, mean)
     * and rafHz — 12 keys exactly, which is the cap-one-short trap again. */
    frames: flat(body.frames, 24, 100000),
    /* 64, not 40: 36 sections arrive since `preUpdate`/`hooks` (2026-09-19),
     * and `flat` keeps the first N in silence — the headroom is the point. */
    sections: flat(body.sections, 64, 100000),
    /* EACH SECTION'S WORST OCCURRENCE THIS WINDOW, with its start and end on
     * performance.now() (2026-09-23, his ask: "how long, and the real-time
     * clock when it started/completed"; `counts.clock0` converts). */
    sectionsPeak: nested(body.sectionsPeak, 64, 4),
    // Heap growth by section, KB per frame (client perfAlloc) — who allocates.
    allocBy: flat(body.allocBy ?? {}, 12, 100000),
    /* 48, not 40: `flat` keeps the FIRST N entries and silently drops the rest,
     * so a cap close to the real key count turns "add a counter" into "lose the
     * counter at the end". 34 arrive today; the headroom is the point. */
    /* 96, not 64: 58 keys arrived on 2026-09-12 and the GPU counters, the gap
     * ledger and the rAF lag add fourteen — the cap-one-short trap, again. */
    /* 128, not 96 (2026-09-23): the gap ledger's peaks and starts and the
     * three clocks (`clock0`, `winT0`, `winT1`) ride beside the 80-odd keys. */
    counts: flat(body.counts, 128, 1e13), // 1e13: `clock0` is an epoch in ms
    /* THE WINDOW'S CONTEXT (2026-09-11): which page load (`runId`) and which
     * window of it, seconds since load, zone and hops with the last hop's
     * join/state/bound ms, what the player was doing (moving/running share,
     * cells travelled), device memory, the connection hint and the UA. A
     * session that degrades over its windows is thermal or a leak; one slow
     * from window 1 is the build. */
    run: mixed(body.run, 24),
    /* THE INPUT ROUND TRIP — sent seq to the server's ack — and the state
     * patch rate. The one lag no CPU section can see: a phone on bad Wi-Fi
     * rubber-bands with a flat 16 ms frame. */
    rtt: mixed(body.rtt, 12),
    /* THE THROTTLING PROXY: the same 400k-step benchmark every window. A
     * window where this went up and the game's sections did not is the phone
     * slowing down, not the game. */
    cpu: mixed(body.cpu, 8),
    /* THE FELT LAG (Event Timing API, client perfextra.ts `inputSummary`):
     * input delay and tap-to-paint duration quantiles, events over 100 ms and
     * the worst one named — the number a frame histogram cannot give, and the
     * one his "it lags when I tap" is about. `avail` first: a browser without
     * the API must never read as "no slow taps". */
    input: mixed(body.input, 12),
    /* THE CLIENT'S OWN DELIVERY LEDGER (2026-09-19): what became of the posts
     * before this one — sent/ok/failed/retried, the last status and error, the
     * last window that got through, and how many wait in the outbox. A run
     * that lost a window says so in the next window that arrives. */
    beacon: mixed(body.beacon, 12),
    /* THE GPU'S OWN FRAME TIME (EXT_disjoint_timer_query_webgl2), with
     * `avail`/`reason` first: no numbers must never read as 0 ms. */
    gpu: mixed(body.gpu, 12),
    /* WHAT IS BEING UPLOADED, BY KEY FAMILY. `texturesAdded` said 2,099 in one
     * 30 s window of his 2026-09-08 run and nothing said what they were — and a
     * texture add is a decode plus a GPU upload on the main thread, i.e. a
     * prime suspect for `gapBusy`, the second-biggest bucket in that run and
     * the only one no section owns. The client already groups adds by the first
     * path segment of the key; it was simply never sent. */
    texFam: flat(body.texFam, 20, 1e9),
    /* THE NETWORK/DISK BILL PER ASSET FAMILY (client/src/netperf.ts). `nested`,
     * not `mixed` — every bucket is itself a record of numbers, and `mixed`
     * would flatten each one to {}, which is how this allowlist has quietly
     * eaten fields before. */
    /* THE GPU UPLOAD BILL (client/src/texupload.ts) — the main-thread cost of
     * getting art into video memory, which is the maintainer's own theory of
     * the lag and the one thing no instrument here measured: netperf times the
     * fetch, texFam counts the adds. `msPerSec` against 1000 is the share of
     * the budget; texUpWorst names the biggest uploads with their pixel size,
     * because the claim is about SIZE. */
    texUp: mixed(body.texUp, 12),
    texUpWorst: Array.isArray(body.texUpWorst)
      ? (body.texUpWorst as unknown[]).slice(0, 10).map((w) => String(w).slice(0, 80))
      : null,
    // Creations by (kind, size) with the caller — see client texupload.ts.
    texUpBy: Array.isArray(body.texUpBy) ? (body.texUpBy as unknown[]).slice(0, 10).map((w) => String(w).slice(0, 200)) : [],
    net: nested(body.net, 12, 16),
    netWorst: Array.isArray(body.netWorst)
      ? (body.netWorst as unknown[]).slice(0, 12).map((w) => String(w).slice(0, 140))
      : null,
    /* THE GROUND RESOLVER ON ANOTHER CORE (client/src/resolveworker.ts). MIXED,
     * not flat: `state` and `error` are strings and they are the first thing to
     * read — a worker that never booted on his device reports every millisecond
     * as zero, which is indistinguishable from one that booted and was never
     * needed. */
    worker: mixed(body.worker, 16),
    /* THE RESOLVER'S OWN BILL ON THE FRAME THREAD (2026-09-19): cells,
     * boundaries and decks resolved this window with their summed ms, the
     * fade scan's cells, neighbour visits and placements, and the cache held.
     * The worker was off in every run he has sent, so this is where the
     * resolver's time went — inside groundSlice/prefetch/repaintCells, with
     * no line of its own — and the fade scan is (2·reach+1)² a cell. */
    resolve: mixed(body.resolve, 16),
    /* THE AMBIENT EFFECTS' OWN COST, per feature (ambient/runtime/mount.ts
     * `cost`): one row per effect — mean ms a frame, the peak, frames — and a
     * `_` row with the mode and what the director has on. NESTED, not mixed:
     * the rows are records and `mixed` would flatten them to {}. */
    /* 48 x 16, not 24 x 6: 24 effects plus the `_` mode row already lost one
     * to the cap, and the mount's own parts (`_env`, `_gloom`, `_director`,
     * `_frame`) and the field's counters (`_zone`) ride here now. */
    ambient: nested(body.ambient, 48, 24),
    // The compose worker (client/src/composeclient.ts), state and miss reasons included.
    compose: mixed(body.compose, 16),
    // THE ZONE CROSSINGS of this window (WorldScene's `zone` block): hops and
    // up to four folded rows — the hand-off's milestones, what its first
    // snapshot carried and the frames' visible-body floor.
    zone: (() => {
      const z = body.zone as { hops?: unknown; last?: unknown } | undefined;
      const last = rows(z?.last, 4, 16);
      if (!last) return null;
      return { hops: num(z?.hops, 0, 1e6) ?? 0, last };
    })(),
    /* THE HEAP AND ITS COLLECTIONS. The client has sent this since db459b988a
     * and THIS ALLOWLIST DROPPED EVERY SAMPLE — the fifth field lost the same
     * way, and lost while chasing the one question it answers: whether GC
     * explains why a paint that draws no scenery gets 3x dearer when scenery
     * is on. `grewMbPerSec` is the allocation RATE and `drops` the collection
     * count; a latch that rebuilds every scenery lit copy shows up in both. */
    heap: mixed(body.heap, 8),
    /* THE LIGHT BILL — what the night pass uploaded on HIS device (lights in
     * the shader, how many march shadows, summed pool area in cells, ambient),
     * plus the GPU string and backing store the cost scales with. MIXED types,
     * unlike `flat`: booleans are switches (torch, scenery shadows) and the
     * strings name the device, both of which decide how to read the ms. */
    lights: mixed(body.lights, 32),
    // The ground-texture sample: where the dark texels sit on the tile
    // lattice, measured on HIS device because the harness never reproduces it.
    ground: body.ground && typeof body.ground === "object"
      ? Object.fromEntries(
          Object.entries(body.ground as Record<string, unknown>).slice(0, 16).map(([k, v]) => [
            k.slice(0, 24),
            typeof v === "number"
              ? v
              : Array.isArray(v)
                ? v.slice(0, 12).map((x) => String(x).slice(0, 24))
                // The texture crop is a data: URL and needs its own ceiling —
                // a few KB of PNG, which is the whole point of it.
                : k === "png"
                  ? String(v).slice(0, 24000)
                  : String(v).slice(0, 48),
          ]),
        )
      : null,
    groundFull: body.groundFull && typeof body.groundFull === "object"
      ? Object.fromEntries(
          Object.entries(body.groundFull as Record<string, unknown>).slice(0, 16).map(([k, v]) => [
            k.slice(0, 24),
            typeof v === "number" ? v : Array.isArray(v) ? v.slice(0, 12).map((x) => String(x).slice(0, 24)) : k === "png" ? String(v).slice(0, 24000) : String(v).slice(0, 48),
          ]),
        )
      : null,
    // Position jumps the client recorded this window (teleports, rubber-banding).
    jumps: Array.isArray(body.jumps) ? (body.jumps as unknown[]).slice(0, 40).map((j) => str(JSON.stringify(j), 200)) : null,
    /* ALL 24, NOT 8, AND NOT CUT AT 400 CHARS. The client has kept 24 worst
     * frames all along and this threw away two thirds of them, then truncated
     * the survivors mid-JSON — so every record arrived with its tail (`mode`,
     * `ring`, `tex`) missing exactly when the tail was the evidence. THIS FILE
     * IS AN ALLOWLIST: a field the client adds arrives as nothing until it is
     * named here, which has now silently eaten `lights`, `zoomMean`/`jumps`,
     * and this. Add the field here in the same commit that emits it. */
    worst: Array.isArray(body.worst)
      ? (body.worst as unknown[]).slice(0, 24).map((w) => str(JSON.stringify(w), 8000))
      : null,
    /* WHAT A GROUND PAINT ACTUALLY DID — cells resolved, blits issued,
     * boundaries composed and the ms they took. THE FOURTH FIELD THIS
     * ALLOWLIST HAS SILENTLY EATEN (after lights, zoomMean/jumps and longBy):
     * the client has emitted it from WorldScene.ts all along and 0 of 40
     * reports carried it, which is precisely why the 22-25 ms in a slice has
     * been guesswork. A field is emitted AND named here, in the same commit,
     * or it does not exist. */
    /* 24, not 12: the client already sent 13 keys against a cap of 12, so one
     * was being dropped before the sub-batch fields were added. Same trap,
     * seventh time — `mixed` keeps the first N and says nothing. */
    groundDrew: mixed(body.groundDrew, 24),
    /* The long-frame CENSUS — every frame over the threshold bucketed by ground
     * mode and dominant section, not just the unluckiest few. */
    longBy: nested(body.longBy, 24, 8),
    // Why the long frames were long — wait (compositor/GPU) | task | gc — the
    // population the ground-path decision rests on (docs/perf.md, 2026-09-13).
    longWhy: mixed(body.longWhy, 8),
    /* AND BY PLACE, in 8-cell blocks: every report he sends is about a spot
     * ("when I run here it lags"), and `longBy` could only say what the bad
     * frames were doing, never where they were. The key is the block's corner,
     * so it reads back as a teleport target. */
    longWhere: nested(body.longWhere, 16, 6),
    /* THE BROWSER'S OWN SPLIT OF THE LONG FRAMES (client/src/perfloaf.ts,
     * Chrome's long-animation-frame entries): `state` first — "unsupported"
     * must never read as "no long frames" — then how many, and their ms
     * BEFORE the rendering update (`pre`: the tasks that ran first), inside
     * the rAF callbacks (`raf`: our frame) and in style/layout/paint (`dom`).
     * `loafBy` names the invokers over 5 ms ("WebSocket.onmessage",
     * "Worker.onmessage", "TimerHandler:setTimeout", "FrameRequestCallback")
     * with count and ms — a record of records, so `nested`. */
    loaf: mixed(body.loaf, 14),
    loafBy: nested(body.loafBy, 12, 4),
    /* The long-frame census BY GROUP (ground, occ, light, sim, render, gl,
     * busy, idle, other), idle and busy in the argmax — the one that turns
     * "unattributed" into a population with a fix. */
    longGroup: nested(body.longGroup, 24, 6),
  };
  return report;
}

/** THE FILE THE REPORTS LAND IN, MERGED (pure, tested in perfdoc.test.ts).
 *
 *  The newest report is appended, the oldest dropped past `keep` reports —
 *  and past `maxBytes` of TEXT, which is the cap that matters: the GitHub
 *  contents API returns NO CONTENT for a file over 1 MB (the object media
 *  type answers `content: ""`), and the handler that read it as an empty
 *  document RESET THE HISTORY: at 1,078,993 bytes on 2026-09-13 every report
 *  before 02:02 vanished in one commit. The reader falls through to the blob
 *  API now (ghGetContents), and the cap keeps the file where one GET serves
 *  it. One report per line, compact: a commit's diff is the report it added,
 *  and the same 40 reports take ~30% fewer bytes than the indented form. */
export function perfDocMerge(
  cur: unknown,
  report: Record<string, unknown>,
  updatedAt: string,
  keep = 40,
  maxBytes = 800_000,
): { doc: { format: string; _comment: string; updated_at: string; reports: unknown[] }; text: string; dropped: number } {
  const prev = cur && typeof cur === "object" && Array.isArray((cur as { reports?: unknown[] }).reports) ? ((cur as { reports: unknown[] }).reports as unknown[]) : [];
  let reports = [...prev, report].slice(-keep);
  let dropped = prev.length + 1 - reports.length;
  const render = () => {
    const doc = {
      format: "nangijala-client-perf@1",
      _comment:
        "PER-DEVICE FRAME TIMINGS, posted by the game client (the Settings perf switch, or ?perf=1) and committed " +
        "here by the server. The maintainer plays on a phone and tests in production; the headless harness walks " +
        "~1 cell per 24 s and never reaches the fresh-terrain code paths, so these are the only honest numbers for " +
        "the paths that matter. Newest last; one report per line; the file keeps the most recent reports and stays " +
        "under the contents API's 1 MB. Read it with scripts/perf-read.mjs.",
      updated_at: updatedAt,
      reports,
    };
    const head = JSON.stringify({ format: doc.format, _comment: doc._comment, updated_at: doc.updated_at });
    const text = head.slice(0, -1) + ',"reports":[\n' + reports.map((r) => JSON.stringify(r)).join(",\n") + "\n]}\n";
    return { doc, text };
  };
  let out = render();
  while (out.text.length > maxBytes && reports.length > 1) {
    reports = reports.slice(1);
    dropped++;
    out = render();
  }
  return { ...out, dropped };
}
