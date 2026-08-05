import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/** Per-WORLD record: where a returning player last stood in that world. The
 * progression fields are legacy — they rode this record briefly before moving
 * to the shared ProgressRecord below; kept optional so old files parse, and
 * onJoin reads them once as a migration seed. */
export interface PlayerRecord {
  character: string;
  name: string;
  x: number;
  y: number;
  level?: number;
  xp?: number;
  hp?: number;
  ep?: number;
  inv?: { item: string; n: number }[];
}

/** WORLD-AGNOSTIC character progression (RO: your character IS the level —
 * picking a different world must not fork it). One shared token-keyed file,
 * while position stays per-world. */
export interface ProgressRecord {
  level: number;
  xp: number;
  hp: number;
  ep: number;
  inv: { item: string; n: number }[];
}

export interface PlayerStore {
  load(token: string): PlayerRecord | undefined;
  save(token: string, rec: PlayerRecord): void;
}

/** JSON-file map store. Records are DEEP-COPIED at both boundaries: a live
 * Player must never alias the persisted record, or mid-play `slot.n++`
 * mutates the "saved" state and any other leaver persists the half-live
 * blend. The interface lets us swap in a real DB later without touching the
 * room; all values are written by the server from gameplay — the client only
 * supplies its opaque token. */
class JsonMapStore<T> {
  private data: Record<string, T> = {};

  constructor(private file: string) {
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        this.data = {};
      }
    }
  }

  load(token: string): T | undefined {
    const rec = token ? this.data[token] : undefined;
    return rec === undefined ? undefined : structuredClone(rec);
  }

  save(token: string, rec: T): void {
    if (!token) return;
    this.data[token] = structuredClone(rec);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data));
  }
}

export class JsonPlayerStore extends JsonMapStore<PlayerRecord> implements PlayerStore {}

/** In-memory store (used by tests / when no persistence is desired). Same
 * deep-copy contract as the JSON store. */
export class MemoryPlayerStore implements PlayerStore {
  private data = new Map<string, PlayerRecord>();
  load(token: string) {
    const rec = this.data.get(token);
    return rec === undefined ? undefined : structuredClone(rec);
  }
  save(token: string, rec: PlayerRecord) {
    if (token) this.data.set(token, structuredClone(rec));
  }
}

// One progression store per process, shared by every room regardless of world.
let sharedProgress: JsonMapStore<ProgressRecord> | undefined;
export function progressStore(): { load(token: string): ProgressRecord | undefined; save(token: string, rec: ProgressRecord): void } {
  return (sharedProgress ??= new JsonMapStore<ProgressRecord>(
    join(process.cwd(), ".data", "players-progress.json"),
  ));
}
