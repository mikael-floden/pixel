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
  TerrainGrid,
  buildTerrainGrid,
  parseWorld,
  makeBlocked,
  makeDrops,
  surfaceAtWorld,
  isStandableAtWorld,
  findSpawn,
  stepStamina,
  WALK_CLIMB,
  JUMP_CLIMB,
  JUMP_MS,
  JUMP_COOLDOWN_MS,
  MAX_STAMINA,
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

  // Terrain (elevation + surface) from the maps agent's world (null → open).
  private terrain: TerrainGrid | null = loadTerrain();

  onCreate() {
    this.setState(new WorldState());

    this.onMessage("input", (client, message: InputMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.inputAx = clamp(message.ax ?? 0, -1, 1);
      player.inputAy = clamp(message.ay ?? 0, -1, 1);
      player.inputRunning = !!message.running;
      if (typeof message.seq === "number") player.seq = message.seq; // ack for reconciliation
      // Jump is edge-triggered: only start a fresh jump when grounded and off
      // cooldown (guards ignore repeats if the client re-sends jump held).
      if (message.jump) {
        const now = Date.now();
        if (now >= player.jumpUntil && now >= player.jumpReadyAt) {
          player.jumpUntil = now + JUMP_MS;
          player.jumpReadyAt = now + JUMP_MS + JUMP_COOLDOWN_MS;
        }
      }
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
    if (saved && !(this.terrain && !isStandableAtWorld(this.terrain, saved.x, saved.y))) {
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
    const now = Date.now();
    this.state.players.forEach((player, id) => {
      const jumping = now < player.jumpUntil;
      player.jumping = jumping;

      const terrain = this.terrain;
      let r;
      if (terrain) {
        // Surface under the player's feet drives walk speed; a jump raises how
        // high you can step so you can cross a 1-level ledge.
        const surf = surfaceAtWorld(terrain, player.x, player.y);
        const ctx = { maxClimb: jumping ? JUMP_CLIMB : WALK_CLIMB, canSwim: true };
        r = stepMovement(
          player.x,
          player.y,
          player.inputAx,
          player.inputAy,
          player.inputRunning,
          dt,
          makeBlocked(terrain, ctx),
          surf.speed,
          true, // iso world → input is screen-relative (Up walks up on screen)
          makeDrops(terrain),
        );
      } else {
        r = stepMovement(player.x, player.y, player.inputAx, player.inputAy, player.inputRunning, dt);
      }
      player.x = r.x;
      player.y = r.y;
      player.moving = r.moving;
      player.running = r.moving && player.inputRunning;
      if (r.dir) player.dir = r.dir;

      // Swimming + stamina: draining in water, recovering on land. Run out and
      // you drown — respawn on the nearest solid ground with stamina restored.
      if (terrain) {
        const swimming = surfaceAtWorld(terrain, player.x, player.y).swimmable;
        player.swimming = swimming;
        const s = stepStamina(player.stamina, swimming, dt);
        player.stamina = s.stamina;
        if (s.drowned) {
          const spot = findSpawn(terrain, player.x, player.y);
          player.x = spot.x;
          player.y = spot.y;
          player.stamina = MAX_STAMINA;
          player.swimming = false;
          this.broadcast("drown", { id, name: player.name });
        }
      }
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
    const world = parseWorld(JSON.parse(readFileSync(path, "utf8")));
    if (!world) return null;
    return buildTerrainGrid(world.width, world.height, world.rows);
  } catch {
    return null;
  }
}
