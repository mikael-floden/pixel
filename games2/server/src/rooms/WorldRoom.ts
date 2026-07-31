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
  makeBlockedElev,
  resolveElevAt,
  levelAtWorld,
  makeSideBlocked,
  unstickFromSolids,
  surfaceAtWorld,
  isStandableAtWorld,
  findSpawn,
  WALK_CLIMB,
  JUMP_CLIMB,
  JUMP_SPEED_FACTOR,
  JUMP_MS,
  JUMP_COOLDOWN_MS,
  TIME_PHASE_COUNT,
  TIME_PHASE_SECONDS,
  TIME_SPEEDS,
  WEATHER_COUNT,
  parseSpawns,
  buildZoneRuntimes,
  ZoneRuntime,
  zoneBBox,
  canEnterElev,
  MONSTER_SPEED_SCALE,
  MONSTER_ROAM_RADIUS_CELLS,
  MONSTER_ROAM_MAX_NODES,
  MONSTER_SEP_MARGIN,
  DEFAULT_MONSTER_RADIUS,
  PLAYER_BODY_RADIUS,
  separationPush,
  monsterDodge,
  MonsterDodgeState,
  randomPauseMs,
  startTrip,
  stepAutopilot,
} from "@nangijala/shared";
import { WorldState, Player, Monster, MonsterArea } from "../schema/WorldState.js";
import { onLiveChange, liveTuning } from "../live.js";
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
  // NO HAND-OFF HOLD. Until 2026-07-31 a natural rollover into NIGHT or
  // MORNING froze the world clock (phaseT pinned at 0) for 1.25s while every
  // client's half-dial spun its hand 180° back to the rail — a rendering
  // artifact that had leaked all the way into the authoritative sim. The
  // clock pill (client/src/clock.ts) now runs the sun and the moon on a
  // continuous BELT: the body leaving the right edge and the one entering on
  // the left are the same motion, so there is no discontinuity to hide and
  // nothing to freeze. Time just flows.
  private worldName = ""; // set in onCreate; keys the worldClocks registry
  private offLive?: () => void; // unsubscribe from live-tuning pushes

  // Monsters (server-authoritative roaming). Per-zone cap override + a seedable
  // RNG so tests get deterministic spawns/roams. `monsterRng` defaults to
  // Math.random; a `monsterSeed` room option swaps in a seeded PRNG.
  private monsterCount: number | null = null; // null → each zone's own `num`
  private monsterRng: () => number = Math.random;
  // The maps2 SPAWN ZONES for THIS world (worlds/<name>/spawns.json,
  // pixel-maps2/spawns@1), resolved against the terrain grid at onCreate —
  // maps2 owns monster placement (maintainer 2026-07-29; the old hardcoded
  // rectangles near the player spawn were fake debug areas and are gone).
  private zones: ZoneRuntime[] = [];
  // Server half of the monsters' own soft collision: per-monster dodge-side
  // hysteresis (mirrors the client player's dodgeState) — never synced.
  private monsterDodgeStates = new Map<string, MonsterDodgeState>();
  // Wild shooting stars streak the night sky at random (arrivals get their
  // own star in onJoin, any hour).
  private starTimer: ReturnType<typeof setTimeout> | null = null;
  private auroraChance = 0.45; // share of nights with northern lights

  private scheduleWildStar() {
    if (this.starTimer) clearTimeout(this.starTimer);
    // Free-running timer that only fires a star when it lands in NIGHT.
    // Interval scaled with the 3x-faster night (40s, was 120s) so a night
    // still sees the same ~2-3 wild stars it always did.
    this.starTimer = setTimeout(() => {
      if (this.state.timeIdx === 0) this.broadcast("star", {});
      this.scheduleWildStar();
    }, (8 + Math.random() * 17) * 1000);
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
      // must not restart the phase or the continuously-swept sun/shadows
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

  onCreate(options?: {
    world?: string;
    phaseSeconds?: number[];
    auroraChance?: number;
    monsterCount?: number; // per-area monster cap override (default: each area's own `max`)
    monsterSeed?: number; // seed a deterministic PRNG for spawns/roam (tests)
  }) {
    if (typeof options?.auroraChance === "number") this.auroraChance = options.auroraChance;
    if (typeof options?.monsterCount === "number")
      this.monsterCount = Math.max(0, Math.floor(options.monsterCount));
    if (typeof options?.monsterSeed === "number") this.monsterRng = mulberry32(options.monsterSeed);
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
      // The maps2 spawn zones for THIS world (sidecar next to world.json),
      // resolved against the grid: which cells are truly standable/swimmable
      // at each zone's elev band. No grid (open world) → no monsters.
      this.zones = this.terrain ? loadSpawnZones(world, this.terrain) : [];
    }
    this.setState(new WorldState());
    // Live tuning (live/tuning/* on GitHub main, held by the live store):
    // push every change to all clients over the room's own WebSocket, and
    // hand joiners the current state (see live.ts / live/README.md).
    this.offLive = onLiveChange((tuning) => this.broadcast("live:update", tuning));
    // Publish each zone's bounding box so clients can draw the debug overlay
    // (the true shape is a polygon; the bbox is plenty for a debug rect).
    for (const z of this.zones) {
      const bb = zoneBBox(z.zone);
      const ma = new MonsterArea();
      ma.id = z.zone.id;
      ma.kind = z.zone.monster;
      ma.x0 = bb.x0;
      ma.y0 = bb.y0;
      ma.x1 = bb.x1;
      ma.y1 = bb.y1;
      this.state.spawnAreas.push(ma);
    }

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

    // Respawn: send the player back to a fresh spawn point (settings button /
    // stuck recovery). Clear queued movement + any jump so they don't drift off
    // spawn; the client snaps to the teleport (its >2-cell jump threshold).
    this.onMessage("respawn", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      this.placeAtSpawn(player);
      player.inputQueue.length = 0;
      player.timeCredit = 0;
      player.jumpUntil = 0;
    });

    // Teleport: drop the player at an EXACT world coordinate (debug tool —
    // reproduce a spot from a screenshot). Unlike respawn it does NOT snap to a
    // standable spawn; it places precisely where asked (clamped to world bounds)
    // so a reported bug at a known (x,y) can be re-observed. Clears queued
    // movement + jump so they hold the mark; client snaps via its jump threshold.
    this.onMessage("teleport", (client, message: { x?: number; y?: number }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const w = this.terrain ? this.terrain.width * CELL_WU : this.worldW;
      const h = this.terrain ? this.terrain.height * CELL_WU : this.worldH;
      player.x = clamp(message?.x ?? player.x, 0, w - 1);
      player.y = clamp(message?.y ?? player.y, 0, h - 1);
      player.elev = this.terrain ? levelAtWorld(this.terrain, player.x, player.y) : 0;
      player.inputQueue.length = 0;
      player.timeCredit = 0;
      player.jumpUntil = 0;
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

    // Seed the roaming monsters from the maps2 spawn zones. Only meaningful
    // when a terrain grid is loaded (zones resolve against it).
    this.seedMonsters();

    const dtMs = 1000 / TICK_RATE;
    this.setSimulationInterval((delta) => this.update(delta / 1000), dtMs);
  }

  /** Populate this.state.monsters from the maps2 zones: `num` monsters per
   * zone (or the monsterCount test override), keyed "<zoneId>#<n>". Spawn
   * points come straight from the zone's PRE-VALIDATED cell list (centre +
   * small jitter, elev = that cell's qualifying surface level — base or deck),
   * so a monster never starts in water/a prop/the wrong layer. */
  private seedMonsters() {
    if (!this.terrain) return; // open world → no terrain to confine/route monsters on
    const now = Date.now();
    const radii = monsterRadii();
    for (const z of this.zones) {
      const count = Math.min(this.monsterCount ?? z.zone.num, z.cells.length);
      const r = radii.get(z.zone.monster) ?? DEFAULT_MONSTER_RADIUS;
      const placed: Array<{ x: number; y: number }> = [];
      for (let n = 0; n < count; n++) {
        const m = new Monster();
        m.kind = z.zone.monster;
        m.areaId = z.zone.id;
        // Radius-aware seeding (v2): try a handful of cells for one clear of
        // the zone-mates already placed — a pair must not START stacked (the
        // maintainer's screenshot was two mammoths seeded onto one spot).
        // Small/crowded zones fall back to the most-spaced attempt.
        let cell = z.cells[Math.floor(this.monsterRng() * z.cells.length)];
        let bestD = -Infinity;
        for (let t = 0; t < 10; t++) {
          const cand = z.cells[Math.floor(this.monsterRng() * z.cells.length)];
          const cx = (cand.c + 0.5) * CELL_WU;
          const cy = (cand.r + 0.5) * CELL_WU;
          const d = placed.length
            ? Math.min(...placed.map((p) => Math.hypot(cx - p.x, cy - p.y)))
            : Infinity;
          if (d > bestD) {
            bestD = d;
            cell = cand;
          }
          if (d >= 2 * r + MONSTER_SEP_MARGIN) break; // comfortably clear — done
        }
        m.x = (cell.c + 0.5 + (this.monsterRng() - 0.5) * 0.5) * CELL_WU;
        m.y = (cell.r + 0.5 + (this.monsterRng() - 0.5) * 0.5) * CELL_WU;
        placed.push({ x: m.x, y: m.y });
        m.elev = cell.lvl;
        m.dir = "south";
        m.moving = false;
        // Stagger first departure a touch so they don't all leave in lockstep.
        m.nextMoveAt = now + Math.floor(this.monsterRng() * 600);
        this.state.monsters.set(`${z.zone.id}#${n}`, m);
      }
    }
  }

  /** Put a player on a FRESH spawn point: open walkable land near the world's
   * spawn (jittered so arrivals don't stack), on the base ground surface — never
   * on a deck. Used by onJoin for new arrivals and by the "respawn" message. */
  private placeAtSpawn(player: Player) {
    const c = this.worldSpawn ?? { x: this.worldW / 2, y: this.worldH / 2 };
    if (this.terrain) {
      const s = findSpawn(this.terrain, c.x + rand(-120, 120), c.y + rand(-120, 120));
      player.x = s.x;
      player.y = s.y;
    } else {
      // No map loaded → open world; spawn near centre so newcomers meet quickly.
      player.x = c.x + rand(-120, 120);
      player.y = c.y + rand(-120, 120);
    }
    player.elev = this.terrain ? levelAtWorld(this.terrain, player.x, player.y) : 0;
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    // Current live tuning straight to the joiner (updates arrive as broadcasts).
    client.send("live:update", liveTuning());
    const player = new Player();
    player.token = (options.token || "").slice(0, 64);
    player.name = (options.name || `wanderer-${client.sessionId.slice(0, 4)}`).slice(0, 24);
    player.character = options.character || "";

    // Returning player? Restore their last position (server-authoritative),
    // but rescue anyone whose saved spot is now blocked (terrain can change).
    const saved = player.token ? this.store.load(player.token) : undefined;
    if (saved && !(this.terrain && !isStandableAtWorld(this.terrain, saved.x, saved.y))) {
      // Returning player: restore their last position on the base ground there.
      player.x = saved.x;
      player.y = saved.y;
      player.elev = this.terrain ? levelAtWorld(this.terrain, player.x, player.y) : 0;
    } else {
      this.placeAtSpawn(player);
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
            // world@2: the forward probe carries the player's live elevation so a
            // deck cell offers its deck OR its base depending on which surface
            // they're on (walk ON the bridge/roof vs UNDER it). Non-deck cells
            // resolve exactly as canEnter, so all other worlds are unaffected.
            makeBlockedElev(terrain, ctx, () => player.elev),
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
        // Update the surface elevation the player now stands on (deck vs base).
        if (terrain) {
          const ctx2 = { maxClimb: jumping ? JUMP_CLIMB : WALK_CLIMB, canSwim: true };
          player.elev = resolveElevAt(terrain, player.elev, player.x, player.y, ctx2);
        }
        moving = r.moving;
        running = r.moving && inp.running;
        if (r.dir) player.dir = r.dir;
        if (typeof inp.seq === "number") player.seq = inp.seq; // ack after applying
      }
      player.moving = moving;
      player.running = running;
      player.lastMoving = moving;

      // Swimming is free, sustainable locomotion — no stamina drain, no
      // drowning. Just mirror whether the feet are in swimmable water so the
      // client can render the swim look (shoulder-line waterline, no shadow).
      // world@2: only when the feet are actually IN the water — NOT when on a
      // DECK (bridge) whose base is water. A deck lifts the player's surface
      // elevation clear of the base, so compare against the base level.
      if (terrain) {
        const surf = surfaceAtWorld(terrain, player.x, player.y);
        player.swimming = surf.swimmable && player.elev <= levelAtWorld(terrain, player.x, player.y) + 0.5;
      }
    });

    // Roaming monsters are integrated AFTER players, on the same tick, sharing
    // none of the player state (separate MapSchema) — they can't collide-break
    // player movement.
    this.stepMonsters(dt, now);
  }

  /** Advance every roaming monster one tick. Each monster belongs to a maps2
   * zone; while paused it waits out `nextMoveAt`, then picks a random VALID
   * zone cell nearby and startTrip()s toward it; while a trip is active it
   * stepAutopilot()s (screen-space 8-way input) fed through the SAME
   * stepMovement the players use, so facing/animation come out right.
   * Confinement: targets only ever come from the zone's pre-validated cell
   * list, movement is blocked from bad ground by makeBlockedElev (canSwim only
   * in water zones), and a monster that still drifts off the polygon (body
   * radius past an edge cell) is snapped back to the nearest zone cell. */
  private stepMonsters(dt: number, now: number) {
    const grid = this.terrain;
    if (!grid) {
      // Open world (no terrain): monsters are inert but still synced.
      this.state.monsters.forEach((m) => {
        m.moving = false;
      });
      return;
    }
    const zoneById = new Map(this.zones.map((z) => [z.zone.id, z]));
    // SOFT SEPARATION v2 (maintainer 2026-07-30: two mammoths on one spot —
    // "can't see monsters avoiding each other even the slightest"): distances
    // are PER-BODY. Snapshot every body once per tick with its art-measured
    // radius (monsters first — index-aligned with `mons` — then players at
    // PLAYER_BODY_RADIUS); entries update in place as monsters move so later
    // monsters this tick separate against current positions, not stale ones.
    // Still deliberately NOT collision: positions already sync, findPath
    // never sees any of it.
    const radii = monsterRadii();
    const mons: Array<{ id: string; m: Monster }> = [];
    this.state.monsters.forEach((m: Monster, id: string) => mons.push({ id, m }));
    const bodies: Array<{ id: string; x: number; y: number; r: number }> = mons.map(
      ({ id, m }) => ({ id, x: m.x, y: m.y, r: radii.get(m.kind) ?? DEFAULT_MONSTER_RADIUS }),
    );
    this.state.players.forEach((p: Player, sid: string) =>
      bodies.push({ id: `p:${sid}`, x: p.x, y: p.y, r: PLAYER_BODY_RADIUS }),
    );
    // A push/dodge must never shove a monster off its zone polygon into the
    // snap-back teleport — validate zone membership alongside terrain.
    const inZone = (zone: ZoneRuntime, x: number, y: number) =>
      zone.cellSet.has(Math.floor(x / CELL_WU) + Math.floor(y / CELL_WU) * grid.width);

    mons.forEach(({ id, m }, i) => {
      const zone = zoneById.get(m.areaId);
      if (!zone) {
        m.moving = false;
        return;
      }
      const ctx = { maxClimb: WALK_CLIMB, canSwim: zone.canSwim };
      const rm = bodies[i].r;

      // POSITIONAL separation: overlap beyond (rA+rB+margin) is pushed out at
      // up to MONSTER_SEP_RELAX_SPEED — a firm, visible shove (stacked
      // mammoths walk apart in ~a second), per-axis validated so a wall,
      // water edge or the zone boundary just clips it.
      const push = separationPush(bodies, i, dt, tieBreakAngle(id));
      if (push) {
        const nx = clamp(m.x + push.dx, 1, this.worldW - 1);
        const ny = clamp(m.y + push.dy, 1, this.worldH - 1);
        if (inZone(zone, nx, m.y) && canEnterElev(grid, m.elev, m.x, m.y, nx, m.y, ctx).ok)
          m.x = nx;
        if (inZone(zone, m.x, ny) && canEnterElev(grid, m.elev, m.x, m.y, m.x, ny, ctx).ok)
          m.y = ny;
        m.elev = resolveElevAt(grid, m.elev, m.x, m.y, ctx);
        bodies[i].x = m.x;
        bodies[i].y = m.y;
      }

      // Idle → pick the next target once the pause has elapsed.
      if (!m.tripActive) {
        m.moving = false;
        if (now < m.nextMoveAt) return; // still pausing
        const t = this.pickMonsterTarget(zone, m.x, m.y, id, rm, radii);
        m.targetX = t.x;
        m.targetY = t.y;
        // Budgeted A*: a roam leg is a wander, not a commute — cap the search
        // so one unlucky path can't overrun the 20Hz tick (see
        // MONSTER_ROAM_MAX_NODES). Player taps are unbudgeted.
        m.trip = startTrip(grid, m.x, m.y, t.x, t.y, false, now, m.elev, undefined, MONSTER_ROAM_MAX_NODES);
        m.tripActive = !!m.trip;
        if (!m.tripActive) {
          // No route (rare — target boxed in): pause and retry shortly.
          m.nextMoveAt = now + Math.floor(randomPauseMs(this.monsterRng));
          return;
        }
      }

      // Active trip → autopilot toward the target, integrated like a player.
      // Monsters ARRIVE GENEROUSLY (maintainer 2026-07-30: "shaking back and
      // forth ... when they have walked for a bit and stops"): near the roam
      // target the separation push jiggles the position every tick, the 8-way
      // bearing to the waypoint flips sectors, and the autopilot can thrash
      // for its full 1.5s stall window before bailing. A roam target is an
      // arbitrary cell — being within 3/4 of one of it IS arrival.
      const trip = m.trip!;
      const distT = Math.hypot(m.targetX - m.x, m.targetY - m.y);
      const a = distT < CELL_WU * 0.75
        ? null // close enough — arrived
        : stepAutopilot(grid, trip, m.x, m.y, now, this.worldW, this.worldH, m.elev);
      if (!a || a.done) {
        m.tripActive = false;
        m.trip = null;
        m.moving = false;
        m.nextMoveAt = now + Math.floor(randomPauseMs(this.monsterRng));
        return;
      }

      // PROACTIVE avoidance (v2): the monster's own 8-way autopilot input
      // dodges other bodies — monsters AND players — through the SAME shared
      // radius-aware monsterDodge the player's input uses, with per-monster
      // side hysteresis. Monsters ARC around each other instead of colliding
      // and then being pushed apart.
      let ax = a.ax;
      let ay = a.ay;
      if (ax !== 0 || ay !== 0) {
        const near: Array<{ id: string; x: number; y: number; r: number }> = [];
        for (let j = 0; j < bodies.length; j++) {
          if (j === i) continue;
          const b = bodies[j];
          if (Math.abs(b.x - m.x) < 140 && Math.abs(b.y - m.y) < 140) near.push(b);
        }
        const dodge = near.length
          ? monsterDodge(m.x, m.y, ax, ay, near, this.monsterDodgeStates.get(id), rm)
          : null;
        if (dodge) {
          // Only take a deflection the zone allows (probe half a cell ahead);
          // otherwise keep the straight heading and let separation handle it.
          const v = Math.hypot(dodge.ax, dodge.ay) || 1;
          const probeX = m.x + (dodge.ax / v) * CELL_WU * 0.5;
          const probeY = m.y + (dodge.ay / v) * CELL_WU * 0.5;
          if (inZone(zone, probeX, probeY)) {
            ax = dodge.ax;
            ay = dodge.ay;
            this.monsterDodgeStates.set(id, dodge.state);
          }
        } else this.monsterDodgeStates.delete(id);
      }

      const surf = surfaceAtWorld(grid, m.x, m.y);
      const r = stepMovement(
        m.x,
        m.y,
        ax,
        ay,
        false, // never run
        dt,
        makeBlockedElev(grid, ctx, () => m.elev),
        surf.speed * MONSTER_SPEED_SCALE,
        true, // iso world → screen-relative input (matches players/autopilot)
        this.worldW,
        this.worldH,
        makeSideBlocked(grid, ctx),
      );
      m.x = r.x;
      m.y = r.y;
      if (r.dir) m.dir = r.dir;
      m.moving = r.moving;
      m.elev = resolveElevAt(grid, m.elev, m.x, m.y, ctx);

      // Safety net: never let a monster leave its zone polygon. Cheap O(1)
      // membership check; the nearest-cell scan only runs for the rare
      // offender (a body-radius slide past an edge cell).
      const mc = Math.floor(m.x / CELL_WU);
      const mr = Math.floor(m.y / CELL_WU);
      if (!zone.cellSet.has(mc + mr * grid.width)) {
        let best = zone.cells[0];
        let bestD = Infinity;
        for (const cell of zone.cells) {
          const d = Math.hypot(cell.c - mc, cell.r - mr);
          if (d < bestD) {
            bestD = d;
            best = cell;
          }
        }
        m.x = (best.c + 0.5) * CELL_WU;
        m.y = (best.r + 0.5) * CELL_WU;
        m.elev = best.lvl;
        m.tripActive = false;
        m.trip = null;
        m.nextMoveAt = now + Math.floor(randomPauseMs(this.monsterRng));
      }
      // Keep the snapshot current for the monsters that step after this one.
      bodies[i].x = m.x;
      bodies[i].y = m.y;
    });
  }

  /** Pick a random roam target from the zone's PRE-VALIDATED cells, preferring
   * one within MONSTER_ROAM_RADIUS_CELLS of the current spot (local milling,
   * not cross-zone beelines), at least a cell away, AND clear of the other
   * same-zone monsters' bodies and destinations (radius-aware, v2): arriving
   * on top of a neighbour just hands the mess to the separation push. Falls
   * back to the best-spaced candidate — every candidate is valid ground. */
  private pickMonsterTarget(
    zone: ZoneRuntime,
    fromX: number,
    fromY: number,
    selfId: string,
    selfR: number,
    radii: Map<string, number>,
  ): { x: number; y: number } {
    const fc = fromX / CELL_WU;
    const fr = fromY / CELL_WU;
    // Other same-zone monsters: current spot + (if travelling) destination.
    const avoid: Array<{ x: number; y: number; r: number }> = [];
    this.state.monsters.forEach((o: Monster, oid: string) => {
      if (oid === selfId || o.areaId !== zone.zone.id) return;
      const r = radii.get(o.kind) ?? DEFAULT_MONSTER_RADIUS;
      avoid.push({ x: o.x, y: o.y, r });
      if (o.tripActive) avoid.push({ x: o.targetX, y: o.targetY, r });
    });
    const clearance = (x: number, y: number) => {
      let worst = Infinity;
      for (const a of avoid)
        worst = Math.min(worst, Math.hypot(x - a.x, y - a.y) - (selfR + a.r + MONSTER_SEP_MARGIN));
      return worst; // >= 0 → comfortably clear of everyone
    };
    let best: { x: number; y: number; clear: number } | null = null;
    for (let i = 0; i < 12; i++) {
      const cell = zone.cells[Math.floor(this.monsterRng() * zone.cells.length)];
      const p = { x: (cell.c + 0.5) * CELL_WU, y: (cell.r + 0.5) * CELL_WU };
      const d = Math.hypot(cell.c + 0.5 - fc, cell.r + 0.5 - fr);
      if (d < 1) continue; // essentially on top of the current position
      const clear = clearance(p.x, p.y);
      const local = d <= MONSTER_ROAM_RADIUS_CELLS;
      if (local && clear >= 0) return p; // nearby AND clear — done
      // Remember the best-spaced candidate (prefer local ones) as fallback.
      const score = clear + (local ? 1000 : 0);
      if (!best || score > best.clear) best = { ...p, clear: score };
    }
    return best ?? { x: fromX, y: fromY };
  }

  onDispose() {
    if (this.starTimer) clearTimeout(this.starTimer);
    this.offLive?.();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

/** Tiny seedable PRNG (mulberry32) → () => [0,1). Deterministic monster
 * spawns/roam for tests (monsterSeed room option); production uses Math.random. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
      terrain: buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks),
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

/** kind → art-measured body radius (wu), read from the GENERATED monster
 * manifest (client/public/monsters.json, dist/ fallback) — the same numbers
 * the client derives its shadows and input-dodge from, so server spacing and
 * client rendering can never disagree about how big a monster is. Loaded once
 * per process; a missing manifest degrades to DEFAULT_MONSTER_RADIUS. */
let monsterRadiiCache: Map<string, number> | null = null;
function monsterRadii(): Map<string, number> {
  if (monsterRadiiCache) return monsterRadiiCache;
  const out = new Map<string, number>();
  const srcDir = dirname(fileURLToPath(import.meta.url)); // server/src/rooms
  const gameRoot = join(srcDir, "..", "..", ".."); // games2
  for (const p of [
    join(gameRoot, "client", "public", "monsters.json"),
    join(gameRoot, "client", "dist", "monsters.json"),
  ]) {
    try {
      if (!existsSync(p)) continue;
      const doc = JSON.parse(readFileSync(p, "utf8")) as {
        monsters?: Array<{ id?: string; radius?: number }>;
      };
      for (const m of doc.monsters ?? [])
        if (m.id && typeof m.radius === "number" && m.radius > 0) out.set(m.id, m.radius);
      break;
    } catch {
      /* unreadable candidate — try the next */
    }
  }
  monsterRadiiCache = out;
  return out;
}

/** Deterministic per-monster angle (radians) from its id — the direction an
 * EXACTLY stacked pair splits along. Id-derived so the two members of the
 * pair get different angles and every tick pushes the same way (no jitter). */
function tieBreakAngle(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h >>> 0) % 360) * (Math.PI / 180);
}

/** Load the maps2 spawn zones for a world (worlds/<name>/spawns.json,
 * pixel-maps2/spawns@1) and resolve them against the terrain grid. Missing
 * file → no monsters (maps2 owns placement; nothing to invent here). Zones
 * with no valid cell at their claimed elevation are skipped with a warning —
 * that's map data disagreeing with itself, worth surfacing. */
function loadSpawnZones(name: string, grid: TerrainGrid): ZoneRuntime[] {
  try {
    const path = join(assetsRoot(), "maps2", "worlds", name, "spawns.json");
    if (!existsSync(path)) return [];
    const zones = parseSpawns(JSON.parse(readFileSync(path, "utf8")));
    const runtimes = buildZoneRuntimes(grid, zones);
    if (runtimes.length < zones.length) {
      const kept = new Set(runtimes.map((r) => r.zone.id));
      const dropped = zones.filter((z) => !kept.has(z.id)).map((z) => `${z.id}(${z.monster})`);
      console.warn(`[monsters] ${name}: ${dropped.length} zone(s) had no valid cells and were skipped: ${dropped.join(", ")}`);
    }
    return runtimes;
  } catch (e) {
    console.warn(`[monsters] failed to load spawns.json for ${name}:`, (e as Error).message);
    return [];
  }
}
