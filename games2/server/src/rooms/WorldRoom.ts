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
  CELL_WU,
  TICK_RATE,
  MAX_INPUT_DT,
  INPUT_TIME_SLACK,
  stepMovement,
  TerrainGrid,
  buildTerrainGrid,
  parseWorld,
  makeBlocked,
  makeSideBlocked,
  unstickFromSolids,
  surfaceAtWorld,
  isStandableAtWorld,
  findSpawn,
  stepStamina,
  WALK_CLIMB,
  JUMP_CLIMB,
  JUMP_SPEED_FACTOR,
  JUMP_MS,
  JUMP_COOLDOWN_MS,
  MAX_STAMINA,
  TIME_PHASE_COUNT,
  TIME_PHASE_SECONDS,
  TIME_SPEEDS,
  WEATHER_COUNT,
} from "@nangijala/shared";
import { WorldState, Player } from "../schema/WorldState.js";
import { JsonPlayerStore, PlayerStore } from "../store.js";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/** The world's clock OUTLIVES any single room. Rooms auto-dispose when their
 * last player leaves and reconnects land in fresh ones, so room-local clock
 * state alone meant every rejoin quietly reset time to the frozen default —
 * the maintainer unfroze time and the next reconnect froze it again
 * ("unfreezing doesn't stick"). Keyed by world name for the process lifetime;
 * a brand-new process still boots frozen-by-default. */
interface WorldClock {
  timeIdx: number;
  phaseT: number;
  frozen: boolean;
  timeSpeed: number;
  weather: number;
  aurora: boolean;
  nextPhaseAt: number | null;
}
const worldClocks = new Map<string, WorldClock>();

/** Tests share one process per file; clock persistence must not leak between them. */
export function resetWorldClocks() {
  worldClocks.clear();
}

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

  // Per-room world state (NOT module-level — the server hosts many rooms, one
  // per selected world, and they can be different sizes / have different spawns).
  private terrain: TerrainGrid | null = null;
  private worldSpawn: { x: number; y: number } | null = null;
  private worldW = WORLD_WIDTH; // world extent (grid×CELL_WU) for movement bounds
  private worldH = WORLD_HEIGHT;

  // World-clock bookkeeping (see the "timeofday" wiring in onCreate). The
  // clock is a DEADLINE checked from the 20Hz simulation loop, not a lone
  // setTimeout: the sim loop provably runs in production (movement syncs),
  // so the phase tick can't stall independently of it.
  private nextPhaseAt: number | null = null;
  private phaseSeconds: readonly number[] = TIME_PHASE_SECONDS;
  private worldName = ""; // set in onCreate; keys the worldClocks registry
  // Wild shooting stars streak the night sky at random (arrivals get their
  // own star in onJoin, any hour).
  private starTimer: ReturnType<typeof setTimeout> | null = null;
  private auroraChance = 0.45; // share of nights with northern lights

  private scheduleWildStar() {
    if (this.starTimer) clearTimeout(this.starTimer);
    this.starTimer = setTimeout(() => {
      if (this.state.timeIdx === 0) this.broadcast("star", {});
      this.scheduleWildStar();
    }, (25 + Math.random() * 50) * 1000);
  }

  private advanceTime(skip = false) {
    this.state.timeIdx = (this.state.timeIdx + 1) % TIME_PHASE_COUNT;
    // Some nights the northern lights come out — rolled once as night
    // falls, shared by everyone, gone by morning.
    this.state.aurora = this.state.timeIdx === 0 && Math.random() < this.auroraChance;
    // Natural rollover continues from the phase START (time is CONTINUOUS —
    // phaseT sweeps 0..1 and the clients sweep the hand/sun/ambient with
    // it); a manual SKIP lands MID-phase, the phase's characteristic look
    // (hand on the phase position, approved grade), so frozen phase-testing
    // shows exactly the discrete-era look.
    this.state.phaseT = skip ? 0.5 : 0;
    this.scheduleTimeOfDay();
  }

  /** The phase's effective duration in ms at the current time speed. */
  private effPhaseMs() {
    const s = this.phaseSeconds[this.state.timeIdx % this.phaseSeconds.length];
    return (s * 1000) / this.state.timeSpeed;
  }

  private scheduleTimeOfDay() {
    if (this.state.timeSpeed <= 0) {
      this.nextPhaseAt = null; // x0 = freeze: the clock holds still (phaseT keeps its value)
    } else {
      // Resume from the CURRENT progress — speed changes and unfreezing
      // must not restart the phase or the continuously-swept hand/shadows
      // would snap backwards.
      this.nextPhaseAt = Date.now() + (1 - this.state.phaseT) * this.effPhaseMs();
    }
    this.saveClock();
  }

  /** Set the world-clock speed (x0 freeze .. x10) — the "timespeed" message
   * cycles TIME_SPEEDS; an explicit valid value (tests, tools) jumps to it. */
  private setTimeSpeed(v: number) {
    this.state.timeSpeed = v;
    this.state.frozen = v === 0; // mirror for the switch UI / old asserts
    this.scheduleTimeOfDay();
  }

  /** Mirror the clock into the per-world registry so the NEXT room for this
   * world (rooms recycle constantly) resumes instead of resetting. */
  private saveClock() {
    worldClocks.set(this.worldName, {
      timeIdx: this.state.timeIdx,
      phaseT: this.state.phaseT,
      frozen: this.state.frozen,
      timeSpeed: this.state.timeSpeed,
      weather: this.state.weather,
      aurora: this.state.aurora,
      nextPhaseAt: this.nextPhaseAt,
    });
  }

  onCreate(options?: { world?: string; phaseSeconds?: number[]; auroraChance?: number }) {
    if (typeof options?.auroraChance === "number") this.auroraChance = options.auroraChance;
    {
      // Load the maps2 world the client asked for (default ring_test). Rooms are
      // matched by this name (filterBy in index.ts), so everyone who picks the
      // same world shares one room; different worlds get separate rooms.
      const world = (options?.world || DEFAULT_WORLD).replace(/[^a-z0-9_-]/gi, "");
      const w = loadWorldGrid(world);
      this.terrain = w.terrain;
      this.worldSpawn = w.spawn;
      this.worldW = w.worldW;
      this.worldH = w.worldH;
      this.setMetadata({ world });
      this.worldName = world;
      this.store = new JsonPlayerStore(join(process.cwd(), ".data", `players-${world}.json`));
    }
    this.setState(new WorldState());

    this.onMessage("input", (client, message: InputMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      // Queue the input with its (bounded) duration; update() integrates the
      // stream so server math matches client prediction exactly.
      if (player.inputQueue.length < 60) {
        player.inputQueue.push({
          ax: clamp(message.ax ?? 0, -1, 1),
          ay: clamp(message.ay ?? 0, -1, 1),
          running: !!message.running,
          seq: typeof message.seq === "number" ? message.seq : undefined,
          dt: clamp(message.dt ?? 1 / TICK_RATE, 0, MAX_INPUT_DT),
        });
      } else if (typeof message.seq === "number") {
        player.seq = message.seq; // overloaded queue: drop but still ack
      }
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

    // Torch is PLAYER state: everyone sees whose torch is lit.
    this.onMessage("torch", (client, message: { on?: boolean }) => {
      const player = this.state.players.get(client.sessionId);
      if (player) player.torch = !!message?.on;
    });

    // Time-of-day is world state, and it RUNS: the server's world clock
    // advances the phase on its own (TIME_PHASE_SECONDS; the day/night
    // cycle is a core rhythm of the game). The settings button still sends
    // "timeofday" — now a SKIP that also restarts the phase timer so a
    // manual skip grants the full next phase.
    // An explicit valid {v} (ambient demo / tools) JUMPS straight to that
    // phase — mid-phase look, same as a manual skip; no {v} keeps the
    // legacy cycle semantics (same pattern as "timespeed").
    this.onMessage("timeofday", (client, message: { v?: number }) => {
      const v = message?.v;
      if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < TIME_PHASE_COUNT) {
        if (this.state.timeIdx !== v) {
          this.state.timeIdx = v;
          this.state.aurora = v === 0 && Math.random() < this.auroraChance;
        }
        this.state.phaseT = 0.5;
        this.scheduleTimeOfDay(); // re-arms the timer + saves the clock
        return;
      }
      this.advanceTime(true);
    });
    // Freeze time (world state, default ON): holds the clock so a given
    // phase can be tested; manual skips still work while frozen. When time
    // flows it ticks the same for every player — it's the room's clock.
    const cycleSpeed = (v?: unknown) => {
      if (typeof v === "number" && TIME_SPEEDS.includes(v)) return this.setTimeSpeed(v);
      const i = TIME_SPEEDS.indexOf(this.state.timeSpeed);
      this.setTimeSpeed(TIME_SPEEDS[(i + 1) % TIME_SPEEDS.length]);
    };
    this.onMessage("timespeed", (client, message: { v?: number }) => cycleSpeed(message?.v));
    // Back-compat alias (the old freeze switch): same cycle.
    this.onMessage("freezetime", () => cycleSpeed());
    if (options?.phaseSeconds) this.phaseSeconds = options.phaseSeconds;
    // Resume this world's clock if the process has seen it before (rooms are
    // disposable, the world's time is not), fast-forwarding any phases that
    // elapsed while no room was open so time flows even with nobody online.
    const saved = worldClocks.get(this.worldName);
    if (saved) {
      this.state.timeIdx = saved.timeIdx;
      this.state.phaseT = saved.phaseT;
      this.state.frozen = saved.frozen;
      this.state.timeSpeed = saved.timeSpeed ?? (saved.frozen ? 0 : 1);
      this.state.weather = saved.weather;
      this.state.aurora = saved.aurora;
      this.nextPhaseAt = saved.nextPhaseAt;
      let guard = 0;
      while (
        this.nextPhaseAt !== null &&
        this.state.timeSpeed > 0 &&
        Date.now() >= this.nextPhaseAt &&
        guard++ < 50_000
      ) {
        this.state.timeIdx = (this.state.timeIdx + 1) % TIME_PHASE_COUNT;
        this.state.aurora = this.state.timeIdx === 0 && Math.random() < this.auroraChance;
        this.nextPhaseAt += this.effPhaseMs();
      }
      this.saveClock();
    } else {
      this.scheduleTimeOfDay();
    }
    this.scheduleWildStar();

    // Weather is the second world-state layer, same contract.
    this.onMessage("weather", (client, message: { v?: number }) => {
      const v = message?.v;
      this.state.weather =
        typeof v === "number" && Number.isInteger(v) && v >= 0 && v < WEATHER_COUNT
          ? v
          : (this.state.weather + 1) % WEATHER_COUNT;
      this.saveClock();
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
      // Spawn on open walkable land near the world's spawn point.
      const c = this.worldSpawn ?? { x: this.worldW / 2, y: this.worldH / 2 };
      const s = findSpawn(this.terrain, c.x + rand(-120, 120), c.y + rand(-120, 120));
      player.x = s.x;
      player.y = s.y;
    } else {
      // No map loaded → open world; spawn near centre so newcomers meet quickly.
      const c = this.worldSpawn ?? { x: this.worldW / 2, y: this.worldH / 2 };
      player.x = c.x + rand(-120, 120);
      player.y = c.y + rand(-120, 120);
    }
    this.state.players.set(client.sessionId, player);
    // Every arrival in Nangijala is announced by a shooting star crossing
    // the sky — the same streak for every player in the world.
    this.broadcast("star", { name: player.name });
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
    // World clock: phase deadline checked here (see nextPhaseAt note); the
    // synced phaseT sweeps continuously between rollovers.
    if (this.nextPhaseAt !== null) {
      const now = Date.now();
      if (now >= this.nextPhaseAt) this.advanceTime();
      else this.state.phaseT = Math.min(1, Math.max(0, 1 - (this.nextPhaseAt - now) / this.effPhaseMs()));
    }

    const now = Date.now();
    this.state.players.forEach((player, id) => {
      const jumping = now < player.jumpUntil;
      player.jumping = jumping;

      // Integrate the queued input stream with each input's own duration —
      // the same (input, dt) sequence the client predicted with, so both
      // sides compute identical positions. A real-time budget stops clients
      // claiming more integration time than actually elapsed.
      const terrain = this.terrain;
      player.timeCredit = Math.min(player.timeCredit + dt, INPUT_TIME_SLACK);
      let moving = player.lastMoving;
      let running = player.running;
      while (player.inputQueue.length) {
        const inp = player.inputQueue.shift()!;
        const eff = Math.min(inp.dt, player.timeCredit);
        player.timeCredit -= eff;
        let r;
        if (terrain) {
          // Free a body overlapping a solid's margin BEFORE integrating (the
          // client prediction runs the identical call — lockstep).
          const u = unstickFromSolids(terrain, player.x, player.y, 80 * eff);
          player.x = u.x;
          player.y = u.y;
          // Surface under the feet drives walk speed; a jump raises how high
          // you can step (crossing a 1-level ledge) but slows ground travel.
          const surf = surfaceAtWorld(terrain, player.x, player.y);
          const ctx = { maxClimb: jumping ? JUMP_CLIMB : WALK_CLIMB, canSwim: true };
          r = stepMovement(
            player.x,
            player.y,
            inp.ax,
            inp.ay,
            inp.running,
            eff,
            makeBlocked(terrain, ctx),
            surf.speed * (jumping ? JUMP_SPEED_FACTOR : 1),
            true, // iso world → input is screen-relative (Up walks up on screen)
            this.worldW,
            this.worldH,
            makeSideBlocked(terrain, ctx), // corner probes: solids only (no ledge-wedging)
          );
        } else {
          r = stepMovement(player.x, player.y, inp.ax, inp.ay, inp.running, eff);
        }
        player.x = r.x;
        player.y = r.y;
        moving = r.moving;
        running = r.moving && inp.running;
        if (r.dir) player.dir = r.dir;
        if (typeof inp.seq === "number") player.seq = inp.seq; // ack after applying
      }
      player.moving = moving;
      player.running = running;
      player.lastMoving = moving;

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

  onDispose() {
    if (this.starTimer) clearTimeout(this.starTimer);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

/** A loaded world: its collision grid, spawn point, and extent (world units).
 * terrain null → the world is open and players move unobstructed. */
interface LoadedWorld {
  terrain: TerrainGrid | null;
  spawn: { x: number; y: number } | null;
  worldW: number;
  worldH: number;
}

/** Default world when the client sends none. */
export const DEFAULT_WORLD = "ring_test";

function assetsRoot(): string {
  const srcDir = dirname(fileURLToPath(import.meta.url)); // server/src/rooms
  const gameRoot = join(srcDir, "..", "..", ".."); // games2
  return process.env.ASSETS_ROOT || join(gameRoot, ".."); // repo root
}

/** Load a named maps2 world (maps2/worlds/<name>/world.json) into a collision
 * grid + spawn + extent, or an open world if it isn't present/parseable. */
function loadWorldGrid(name: string): LoadedWorld {
  const open: LoadedWorld = { terrain: null, spawn: null, worldW: WORLD_WIDTH, worldH: WORLD_HEIGHT };
  try {
    const path = join(assetsRoot(), "maps2", "worlds", name, "world.json");
    if (!existsSync(path)) return open;
    const world = parseWorld(JSON.parse(readFileSync(path, "utf8")));
    if (!world) return open;
    return {
      terrain: buildTerrainGrid(world.width, world.height, world.rows, world.props),
      spawn: world.spawn
        ? { x: world.spawn[0] * CELL_WU, y: world.spawn[1] * CELL_WU }
        : { x: (world.width * CELL_WU) / 2, y: (world.height * CELL_WU) / 2 },
      worldW: world.width * CELL_WU,
      worldH: world.height * CELL_WU,
    };
  } catch {
    return open;
  }
}
