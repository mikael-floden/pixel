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
} from "@nangijala/shared";
import { WorldState, Player } from "../schema/WorldState.js";
import { JsonPlayerStore, PlayerStore } from "../store.js";
import { join } from "path";

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

    // Returning player? Restore their last position (server-authoritative).
    const saved = player.token ? this.store.load(player.token) : undefined;
    if (saved) {
      player.x = saved.x;
      player.y = saved.y;
    } else {
      // Spawn near the world centre so newcomers meet quickly.
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
      const r = stepMovement(player.x, player.y, player.inputAx, player.inputAy, player.inputRunning, dt);
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
