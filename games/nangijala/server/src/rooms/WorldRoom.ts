import { Room, Client } from "@colyseus/core";
import {
  InputMessage,
  JoinOptions,
  ChatInput,
  ChatBroadcast,
  CHAT_MIN_INTERVAL_MS,
  sanitizeChat,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  TICK_RATE,
  stepMovement,
  BlockedFn,
  TerrainGrid,
  buildTerrainGrid,
  makeBlocked,
  isBlockedAtWorld,
  findSpawn,
} from "@nangijala/shared";
import { WorldState, Player } from "../schema/WorldState.js";
import { JsonPlayerStore, PlayerStore } from "../store.js";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * The single shared world. Every client that connects joins this same room, so
 * they all see each other. The server is authoritative: clients send input, the
 * server integrates positions on a fixed tick and syncs state to everyone.
 */
export class WorldRoom extends Room<WorldState> {
  // A generous cap; a real deployment can shard once this fills.
  maxClients = 200;

  // Persistence: swap JsonPlayerStore for a DB-backed store later.
  private store: PlayerStore = new JsonPlayerStore(join(process.cwd(), ".data", "players.json"));

  // Terrain collision derived from the maps agent's world (null → open world).
  private terrain: TerrainGrid | null = loadTerrain();
  private blocked: BlockedFn | undefined = this.terrain ? makeBlocked(this.terrain) : undefined;

  onCreate() {
    this.setState(new WorldState());

    this.onMessage("input", (client, message: InputMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.inputAx = clamp(message.ax ?? 0, -1, 1);
      player.inputAy = clamp(message.ay ?? 0, -1, 1);
      player.inputRunning = !!message.running;
      if (typeof message.seq === "number") player.seq = message.seq; // ack for reconciliation
    });

    this.onMessage("chat", (client, message: ChatInput) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const text = sanitizeChat(message?.text);
      if (!text) return;
      const now = Date.now();
      if (now - player.lastChatAt < CHAT_MIN_INTERVAL_MS) return; // rate limit
      player.lastChatAt = now;
      const out: ChatBroadcast = { id: client.sessionId, name: player.name, text };
      this.broadcast("chat", out);
    });

    const dtMs = 1000 / TICK_RATE;
    this.setSimulationInterval((delta) => this.update(delta / 1000), dtMs);
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    const player = new Player();
    player.token = (options.token || "").slice(0, 64);
    player.name = (options.name || `wanderer-${client.sessionId.slice(0, 4)}`).slice(0, 24);
    player.character = options.character || "";

    // Returning player? Restore their last position (server-authoritative),
    // but rescue anyone whose saved spot is now blocked (terrain can change).
    const saved = player.token ? this.store.load(player.token) : undefined;
    if (saved && !(this.terrain && isBlockedAtWorld(this.terrain, saved.x, saved.y))) {
      player.x = saved.x;
      player.y = saved.y;
    } else if (this.terrain) {
      // Spawn on open walkable land near the world centre.
      const s = findSpawn(this.terrain, WORLD_WIDTH / 2 + rand(-120, 120), WORLD_HEIGHT / 2 + rand(-120, 120));
      player.x = s.x;
      player.y = s.y;
    } else {
      // No map loaded → open world; spawn near centre so newcomers meet quickly.
      player.x = WORLD_WIDTH / 2 + rand(-120, 120);
      player.y = WORLD_HEIGHT / 2 + rand(-120, 120);
    }
    this.state.players.set(client.sessionId, player);
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player?.token) {
      this.store.save(player.token, {
        character: player.character,
        name: player.name,
        x: player.x,
        y: player.y,
      });
    }
    this.state.players.delete(client.sessionId);
  }

  private update(dt: number) {
    this.state.players.forEach((player) => {
      const r = stepMovement(
        player.x,
        player.y,
        player.inputAx,
        player.inputAy,
        player.inputRunning,
        dt,
        this.blocked,
      );
      player.x = r.x;
      player.y = r.y;
      player.moving = r.moving;
      player.running = r.moving && player.inputRunning;
      if (r.dir) player.dir = r.dir;
    });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

/** Load the maps agent's world grid and build a collision grid, or null if the
 * map isn't present (then the world is open and players move unobstructed). */
function loadTerrain(): TerrainGrid | null {
  try {
    const srcDir = dirname(fileURLToPath(import.meta.url)); // server/src/rooms
    const gameRoot = join(srcDir, "..", "..", ".."); // games/nangijala
    const assetsRoot = process.env.ASSETS_ROOT || join(gameRoot, "..", ".."); // repo root
    const path = join(assetsRoot, "maps", "world", "world.json");
    if (!existsSync(path)) return null;
    const world = JSON.parse(readFileSync(path, "utf8")) as {
      width: number;
      height: number;
      rows: { t: string }[][];
    };
    if (!world?.rows?.length) return null;
    return buildTerrainGrid(world.width, world.height, world.rows);
  } catch {
    return null;
  }
}
