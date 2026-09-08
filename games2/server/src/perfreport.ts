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
    frames: flat(body.frames, 12, 100000),
    sections: flat(body.sections, 40, 100000),
    /* 48, not 40: `flat` keeps the FIRST N entries and silently drops the rest,
     * so a cap close to the real key count turns "add a counter" into "lose the
     * counter at the end". 34 arrive today; the headroom is the point. */
    counts: flat(body.counts, 48, 1e9),
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
      ? (body.worst as unknown[]).slice(0, 24).map((w) => str(JSON.stringify(w), 900))
      : null,
    /* WHAT A GROUND PAINT ACTUALLY DID — cells resolved, blits issued,
     * boundaries composed and the ms they took. THE FOURTH FIELD THIS
     * ALLOWLIST HAS SILENTLY EATEN (after lights, zoomMean/jumps and longBy):
     * the client has emitted it from WorldScene.ts all along and 0 of 40
     * reports carried it, which is precisely why the 22-25 ms in a slice has
     * been guesswork. A field is emitted AND named here, in the same commit,
     * or it does not exist. */
    groundDrew: mixed(body.groundDrew, 12),
    /* The long-frame CENSUS — every frame over the threshold bucketed by ground
     * mode and dominant section, not just the unluckiest few. */
    longBy: nested(body.longBy, 24, 8),
  };
  return report;
}
