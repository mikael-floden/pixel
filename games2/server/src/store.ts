import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

/** What we persist for a returning player, keyed by their token. */
export interface PlayerRecord {
  character: string;
  name: string;
  x: number;
  y: number;
}

export interface PlayerStore {
  load(token: string): PlayerRecord | undefined;
  save(token: string, rec: PlayerRecord): void;
}

/** Simple JSON-file store. The interface lets us swap in a real DB later
 * without touching the room. All values are written by the server from
 * gameplay — the client only supplies its opaque token. */
export class JsonPlayerStore implements PlayerStore {
  private data: Record<string, PlayerRecord> = {};

  constructor(private file: string) {
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        this.data = {};
      }
    }
  }

  load(token: string): PlayerRecord | undefined {
    return token ? this.data[token] : undefined;
  }

  save(token: string, rec: PlayerRecord): void {
    if (!token) return;
    this.data[token] = rec;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data));
  }
}

/** In-memory store (used by tests / when no persistence is desired). */
export class MemoryPlayerStore implements PlayerStore {
  private data = new Map<string, PlayerRecord>();
  load(token: string) {
    return this.data.get(token);
  }
  save(token: string, rec: PlayerRecord) {
    if (token) this.data.set(token, rec);
  }
}
