/* AMBIENT ZONES — maps2's `ambient.json` (pixel-maps3/ambient@1, maps2/spec/
 * AMBIENT.md) resolved into "which ambient effects are on HERE, now", the same
 * answer on the server and on every client.
 *
 * Maintainer 2026-09-18: "pick up the map-agent's ambient zones and implement
 * them in sync with all players on the server. If an ambient effect should
 * exist 30% of the time in an area that means over a long period of time the
 * effect will be present 30% of the time. No fast switching! Hold an ambient
 * effect active for ~10min!"
 *
 * THE ROLL IS A FUNCTION OF THE CLOCK, NOT OF A ROOM. Every zone rolls once
 * per AMBIENT_HOLD_S window, seeded by (zone id, window index): every zone
 * room of the world, a restarted process and a fresh room all compute the
 * same table for the same minute, so nothing is persisted, published on the
 * bus or handed off — the clock IS the sync. Each zone's window is phased by
 * a hash of its id so the world does not re-roll all at once every ten
 * minutes: with 84 zones a change lands somewhere every ~7 s, each zone
 * holds ~10 min. A roll is an independent draw per window, so over many
 * windows an effect is on for its share of the time exactly.
 *
 * A POINT reads the table through `resolveAmbientAt`: for each effect the
 * covering zone with the LARGEST share owns it (the spec's max rule), the
 * effect is on iff it is on in that zone's window, and effects that cannot
 * run together (the doc's `exclusive` groups + shared/ambient.ts's matrix)
 * keep the higher share. (The spec's "shares as weights of one draw" holds
 * inside a zone; across overlapping zones the owners' draws are independent
 * and the conflict rule trims the loser — measured on the wet west + the
 * mountain weather: snow 35%, rain ~12% of windows, "snows about twice as
 * often as it rains" as the spec asks. A per-point draw would need a
 * per-point sync and could not be held.)
 *
 * No Phaser, no DOM, no imports beyond ambient.ts: the SERVER imports this.
 */
import { compatible } from "./ambient";

export interface AmbientZone {
  id: string;
  name: string;
  kind: string;
  /** spawns@1 polygon: tile-corner vertices, axis-aligned edges, closes implicitly. */
  area: [number, number][];
  /** Inclusive level range the zone means where surfaces stack (caves); absent = any level. */
  elev?: [number, number];
  /** Cell centres the polygon holds (informative; the tie-break for ownership). */
  cells?: number;
  /** effect name -> share 1..100: how often it should be on here. */
  effects: Record<string, number>;
}

export interface AmbientZoneDoc {
  world: string;
  size: number;
  /** Groups whose members never run together; the shares are the weights of one draw. */
  exclusive: string[][];
  zones: AmbientZone[];
}

export const AMBIENT_SCHEMA = "pixel-maps3/ambient@1";
/** Seconds one zone holds a rolled set before its next window. */
export const AMBIENT_HOLD_S = 600;

/** Parse a raw ambient.json; null when it is not an ambient@1 doc. Zones with
 *  no usable polygon or no effects are dropped, a bad share is clamped. */
export function parseAmbientZones(raw: unknown): AmbientZoneDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.schema !== AMBIENT_SCHEMA || !Array.isArray(d.zones)) return null;
  const zones: AmbientZone[] = [];
  for (const z of d.zones as unknown[]) {
    if (!z || typeof z !== "object") continue;
    const o = z as Record<string, unknown>;
    if (typeof o.id !== "string" || !Array.isArray(o.area) || o.area.length < 3) continue;
    const area: [number, number][] = [];
    for (const p of o.area as unknown[]) {
      if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number") continue;
      area.push([p[0], p[1]]);
    }
    if (area.length < 3) continue;
    const effects: Record<string, number> = {};
    if (o.effects && typeof o.effects === "object") {
      for (const [k, v] of Object.entries(o.effects as Record<string, unknown>)) {
        if (typeof v !== "number" || !(v > 0)) continue;
        effects[k] = Math.min(100, Math.max(0, v));
      }
    }
    if (Object.keys(effects).length === 0) continue;
    const zone: AmbientZone = {
      id: o.id,
      name: typeof o.name === "string" ? o.name : o.id,
      kind: typeof o.kind === "string" ? o.kind : "",
      area,
      effects,
    };
    if (Array.isArray(o.elev) && typeof o.elev[0] === "number" && typeof o.elev[1] === "number")
      zone.elev = [o.elev[0], o.elev[1]];
    if (typeof o.cells === "number") zone.cells = o.cells;
    zones.push(zone);
  }
  const exclusive: string[][] = [];
  if (Array.isArray(d.exclusive))
    for (const g of d.exclusive as unknown[])
      if (Array.isArray(g)) exclusive.push(g.filter((n): n is string => typeof n === "string"));
  return {
    world: typeof d.world === "string" ? d.world : "",
    size: typeof d.size === "number" ? d.size : 0,
    exclusive,
    zones,
  };
}

/** Even-odd containment of a point (cell centre) in a closed polygon. */
export function pointInArea(area: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = area.length - 1; i < area.length; j = i++) {
    const [xi, yi] = area[i];
    const [xj, yj] = area[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Does the zone hold cell (col,row) at level `elev`? The centre decides. */
export function zoneHolds(z: AmbientZone, col: number, row: number, elev: number): boolean {
  if (z.elev && (elev < z.elev[0] || elev > z.elev[1])) return false;
  return pointInArea(z.area, col + 0.5, row + 0.5);
}

export function zonesAt(doc: AmbientZoneDoc, col: number, row: number, elev: number): AmbientZone[] {
  return doc.zones.filter((z) => zoneHolds(z, col, row, elev));
}

/** FNV-1a, 32-bit: the same on every runtime (integer arithmetic only). */
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a small seeded generator, identical everywhere. */
export function seededRnd(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The zone's window index at `nowMs`: its windows are AMBIENT_HOLD_S long and
 *  phased by its id so zones do not all switch together. */
export function zoneWindow(zoneId: string, nowMs: number): number {
  const phase = hashStr(zoneId) % AMBIENT_HOLD_S;
  return Math.floor((nowMs / 1000 + phase) / AMBIENT_HOLD_S);
}

/** ONE DRAW for a zone. `weights` are shares 0..1. Each exclusive group is one
 *  lottery: the shares are slices of the window and what remains of 1 is
 *  "none" (a group summing past 1 is normalised — then something is always
 *  on). Every other effect is its own coin. Then the matrix (ambient.ts):
 *  the group winners are kept, an independent that cannot join them is
 *  dropped, in name order so the rule is deterministic. Sorted. */
export function rollZoneSet(
  weights: Readonly<Record<string, number>>,
  groups: readonly (readonly string[])[],
  rnd: () => number,
): string[] {
  const out: string[] = [];
  const grouped = new Set<string>();
  for (const g of groups) {
    const members = g.filter((n) => (weights[n] ?? 0) > 0);
    for (const n of g) grouped.add(n);
    if (members.length === 0) continue;
    const sum = members.reduce((s, n) => s + weights[n], 0);
    let r = rnd() * Math.max(1, sum);
    for (const n of members) {
      if (r < weights[n]) { out.push(n); break; }
      r -= weights[n];
    }
  }
  for (const n of Object.keys(weights).sort()) {
    if (grouped.has(n)) continue;
    const w = weights[n];
    if (!(w > 0)) continue;
    if (rnd() < w) out.push(n);
  }
  const kept: string[] = [];
  for (const n of out) if (kept.every((k) => compatible(k, n))) kept.push(n);
  return kept.sort();
}

/** The zone's set for the window that holds `nowMs` — a pure function of
 *  (zone, window), so every machine agrees. */
export function zoneSetAt(z: AmbientZone, doc: AmbientZoneDoc, nowMs: number): string[] {
  const w = zoneWindow(z.id, nowMs);
  const weights: Record<string, number> = {};
  for (const [n, share] of Object.entries(z.effects)) weights[n] = share / 100;
  return rollZoneSet(weights, doc.exclusive, seededRnd(hashStr(`${z.id}#${w}`)));
}

/** The whole world's table at `nowMs`: zone id -> packed set. */
export function ambientTableAt(doc: AmbientZoneDoc, nowMs: number): Map<string, string> {
  const t = new Map<string, string>();
  for (const z of doc.zones) t.set(z.id, zoneSetAt(z, doc, nowMs).join(","));
  return t;
}

/** THE WIRE FORM of the table: "id=a,b;id2=;..." in id order. */
export function packZoneTable(t: ReadonlyMap<string, string>): string {
  return [...t.keys()].sort().map((id) => `${id}=${t.get(id) ?? ""}`).join(";");
}
export function unpackZoneTable(s: string | null | undefined): Map<string, string> {
  const t = new Map<string, string>();
  for (const part of (s ?? "").split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    t.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return t;
}

/** WHAT IS ON AT A CELL. Per effect the covering zone with the largest share
 *  owns it (tie: the smaller zone, then the id), and the effect is on iff the
 *  owner's window has it. Then effects that cannot run together (the doc's
 *  groups, then the matrix) keep the larger share (tie: name order). The
 *  result is sorted; `table` is the world's current table (packed sets). */
export function resolveAmbientAt(
  doc: AmbientZoneDoc,
  table: ReadonlyMap<string, string>,
  col: number,
  row: number,
  elev: number,
): string[] {
  const owner = new Map<string, { share: number; zone: AmbientZone }>();
  for (const z of doc.zones) {
    if (!zoneHolds(z, col, row, elev)) continue;
    for (const [n, share] of Object.entries(z.effects)) {
      const cur = owner.get(n);
      if (
        !cur ||
        share > cur.share ||
        (share === cur.share &&
          ((z.cells ?? Infinity) < (cur.zone.cells ?? Infinity) ||
            ((z.cells ?? Infinity) === (cur.zone.cells ?? Infinity) && z.id < cur.zone.id)))
      )
        owner.set(n, { share, zone: z });
    }
  }
  const on: { name: string; share: number }[] = [];
  for (const [n, o] of owner) {
    const packed = table.get(o.zone.id);
    if (packed === undefined) continue;
    if (packed.split(",").includes(n)) on.push({ name: n, share: o.share });
  }
  // the larger share wins a conflict; the order below makes that the rule
  on.sort((a, b) => b.share - a.share || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const groupOf = new Map<string, number>();
  doc.exclusive.forEach((g, i) => g.forEach((n) => groupOf.set(n, i)));
  const kept: string[] = [];
  const groupsTaken = new Set<number>();
  for (const e of on) {
    const g = groupOf.get(e.name);
    if (g !== undefined && groupsTaken.has(g)) continue;
    if (!kept.every((k) => compatible(k, e.name))) continue;
    if (g !== undefined) groupsTaken.add(g);
    kept.push(e.name);
  }
  return kept.sort();
}
