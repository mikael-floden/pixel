// ============================================================================
// THE ZONE TABLE IS BUILT ONCE A SECOND, AND PER-SECOND IS EXACT
// ============================================================================
//
// `WorldRoom.refreshAmbientZones` is called from update() ELEVEN LINES ABOVE
// the idle-divisor gate, so it ran on every tick of every room whether or not
// anyone was connected: 16 rooms x 20 Hz = 320 builds a second. Each build
// walks 96 zones, seeds a roll per zone, allocates a Map, joins 96 strings,
// sorts 96 keys and concatenates a 3,141-character line — and the comparison
// UNDERNEATH it then discovers the answer is the one we already had and throws
// the lot away. Measured against this very doc: 197.8 us a build, 63 ms of CPU
// per wall second, 6.3% of the single core the world runs on. It shipped on
// 2026-09-18; on the 21st a starved event loop on that same core stopped the
// maintainer's art reaching his phone for an evening, because the process that
// runs the 20 Hz world also serves ~50,000 art files.
//
// THE MEMO KEY IS THE SECOND. This file exists to prove that costs nothing,
// and to pin the trap that the OBVIOUS key — the AMBIENT_HOLD_S window — would
// have been WRONG: `zoneWindow` phases every zone by `hashStr(id) %
// AMBIENT_HOLD_S`, so the zones roll at up to 96 different moments, and a
// window-granularity memo would have silently frozen the offset ones.
//
// SKIPPED, NOT FAILED, when the world tree is absent — the deploy's test job
// sparse-checks-out neither maps2/worlds3 nor tiles/ (repo law).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AMBIENT_HOLD_S,
  type AmbientZoneDoc,
  ambientTableAt,
  hashStr,
  packZoneTable,
  parseAmbientZones,
  zoneWindow,
} from "@nangijala/shared";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REAL = join(REPO, "maps2", "worlds3", "the_game", "ambient.json");

function realDoc(): AmbientZoneDoc | null {
  if (!existsSync(REAL)) return null;
  return parseAmbientZones(JSON.parse(readFileSync(REAL, "utf8")));
}

const at = (doc: AmbientZoneDoc, ms: number) => packZoneTable(ambientTableAt(doc, ms));

/** A fixed, arbitrary wall-clock to sweep from, so the test is deterministic:
 *  2026-09-22T00:00:00Z. */
const T0 = Date.UTC(2026, 8, 22, 0, 0, 0);

test("the table is constant within a whole second — so building once a second loses nothing", () => {
  const doc = realDoc();
  if (!doc) return; // no world tree in this checkout
  // Sweep two whole AMBIENT_HOLD_S windows at one-second steps — long enough
  // that every zone rolls at least once, whatever its phase — and inside each
  // second check the instants a 20 Hz tick actually lands on.
  for (let s = 0; s < 2 * AMBIENT_HOLD_S; s++) {
    const base = T0 + s * 1000;
    const want = at(doc, base);
    for (const off of [1, 50, 250, 500, 750, 999]) {
      assert.equal(at(doc, base + off), want, `table moved ${off} ms into second ${s}`);
    }
  }
});

test("every window boundary falls on a whole second — no roll can be stepped over", () => {
  const doc = realDoc();
  if (!doc) return;
  for (const z of doc.zones) {
    // Find the SECOND this zone rolls in (a whole window is 600 steps, not
    // 600,000 — the point is which second, not which millisecond)...
    const w0 = zoneWindow(z.id, T0);
    let sec = -1;
    for (let s = 1; s <= AMBIENT_HOLD_S; s++) {
      if (zoneWindow(z.id, T0 + s * 1000) !== w0) {
        sec = s;
        break;
      }
    }
    assert.notEqual(sec, -1, `zone ${z.id} never rolled within a whole window`);
    // ...then demand the roll happens exactly ON that second: the last
    // millisecond of the previous second still reads the OLD window. If a roll
    // could land mid-second, a per-second memo could step over it.
    assert.equal(
      zoneWindow(z.id, T0 + sec * 1000 - 1),
      w0,
      `zone ${z.id} rolls mid-second — a per-second memo would miss it`,
    );
  }
});

test("...and the table really does change, so the arms above are not vacuous", () => {
  const doc = realDoc();
  if (!doc) return;
  const seen = new Set<string>();
  for (let s = 0; s <= 2 * AMBIENT_HOLD_S; s += 5) seen.add(at(doc, T0 + s * 1000));
  assert.ok(seen.size > 1, `the table never changed over ${2 * AMBIENT_HOLD_S}s — the memo would be untested`);
});

test("THE TRAP: zones roll at different moments, so a window-granularity memo would be wrong", () => {
  const doc = realDoc();
  if (!doc) return;
  // The phases really are spread — if they were all equal, memoising on
  // floor(now/AMBIENT_HOLD_S) would have been safe and this note pointless.
  const phases = new Set(doc.zones.map((z) => hashStr(z.id) % AMBIENT_HOLD_S));
  assert.ok(phases.size > 1, `all ${doc.zones.length} zones share one phase — the memo comment is over-cautious`);

  /* And prove the consequence, not just the input: sweep a whole window and
   * find a second where the TABLE changes while the naive key —
   * floor(nowMs / 1000 / AMBIENT_HOLD_S) — does NOT. That is exactly the roll
   * a window-keyed memo would have slept through, and it is why this memo
   * keys on the second. */
  const naiveKey = (ms: number) => Math.floor(ms / 1000 / AMBIENT_HOLD_S);
  let sleptThrough = 0;
  let prev = at(doc, T0);
  let prevKey = naiveKey(T0);
  for (let s = 1; s <= AMBIENT_HOLD_S; s++) {
    const ms = T0 + s * 1000;
    const now = at(doc, ms);
    const key = naiveKey(ms);
    if (now !== prev && key === prevKey) sleptThrough++;
    prev = now;
    prevKey = key;
  }
  assert.ok(
    sleptThrough > 0,
    "no off-phase roll found in a full window — a window-keyed memo might have been safe after all",
  );
});
