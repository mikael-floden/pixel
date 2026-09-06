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
    dpr: num(body.dpr, 0, 8),
    view: str(body.view, 24),
    secs: num(body.secs, 0, 3600),
    final: body.final === true,
    frames: flat(body.frames, 12, 100000),
    sections: flat(body.sections, 40, 100000),
    counts: flat(body.counts, 40, 1e9),
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
    worst: Array.isArray(body.worst)
      ? (body.worst as unknown[]).slice(0, 8).map((w) => str(JSON.stringify(w), 400))
      : null,
  };
  return report;
}
