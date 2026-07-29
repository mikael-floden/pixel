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
  MONSTER_SPEED_SCALE,
  MONSTER_ROAM_RADIUS_CELLS,
  randomPauseMs,
  startTrip,
  stepAutopilot,
} from "@nangijala/shared";
import { WorldState, Player, Monster, MonsterArea } from "../schema/WorldState.js";
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
  // HAND-OFF HOLD (games-ui, 2026-07-23): a NATURAL rollover into NIGHT or
  // MORNING freezes the clock — phaseT pinned at 0 — for the 1.25s the
  // clients' wheel+hand 180° rotation takes (clock.ts FADE_S; halved from
  // 2.5s so day<->night is twice as fast — this MUST stay equal to FADE_S*1000
  // or the hand won't resume from the rail exactly when the flip lands). WALL
  // milliseconds, deliberately NOT scaled by timeSpeed, so at any speed
  // multiplier the hand resumes from the phase start (the right rail) when the
  // flip lands (maintainer: "time freezed on the server and all clients during
  // the animation"). Manual "timeofday" skips stay untouched: they pin the
  // mid-phase keyframe look, and frozen-time testing depends on that.
  private handoffHoldMs = 1250;
  private handoffHoldUntil = 0;
  private worldName = ""; // set in onCreate; keys the worldClocks registry

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
    // natural entry into a hand-off phase: hold for the clients' rotation
    if (!skip && (this.state.timeIdx === 0 || this.state.timeIdx === 1))
      this.handoffHoldUntil = Date.now() + this.handoffHoldMs;
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
      // would snap backwards. Any remaining hand-off hold extends the
      // deadline so the phase runs FULL length after the flip lands.
      const holdLeft = Math.max(0, this.handoffHoldUntil - Date.now());
      this.nextPhaseAt = Date.now() + holdLeft + (1 - this.state.phaseT) * this.effPhaseMs();
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
    handoffHoldMs?: number; // test-only override of the hand-off hold
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
    if (typeof options?.handoffHoldMs === "number") this.handoffHoldMs = options.handoffHoldMs;
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
    for (const z of this.zones) {
      const count = Math.min(this.monsterCount ?? z.zone.num, z.cells.length);
      for (let n = 0; n < count; n++) {
        const m = new Monster();
        m.kind = z.zone.monster;
        m.areaId = z.zone.id;
        const cell = z.cells[Math.floor(this.monsterRng() * z.cells.length)];
        m.x = (cell.c + 0.5 + (this.monsterRng() - 0.5) * 0.5) * CELL_WU;
        m.y = (cell.r + 0.5 + (this.monsterRng() - 0.5) * 0.5) * CELL_WU;
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
      else if (now >= this.handoffHoldUntil)
        this.state.phaseT = Math.min(1, Math.max(0, 1 - (this.nextPhaseAt - now) / this.effPhaseMs()));
      // else: hand-off hold — the clock stands still at the phase start
      // while every client's wheel turns
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
    this.state.monsters.forEach((m) => {
      const zone = zoneById.get(m.areaId);
      if (!zone) {
        m.moving = false;
        return;
      }
      const ctx = { maxClimb: WALK_CLIMB, canSwim: zone.canSwim };

      // Idle → pick the next target once the pause has elapsed.
      if (!m.tripActive) {
        m.moving = false;
        if (now < m.nextMoveAt) return; // still pausing
        const t = this.pickMonsterTarget(zone, m.x, m.y);
        m.targetX = t.x;
        m.targetY = t.y;
        m.trip = startTrip(grid, m.x, m.y, t.x, t.y, false, now, m.elev);
        m.tripActive = !!m.trip;
        if (!m.tripActive) {
          // No route (rare — target boxed in): pause and retry shortly.
          m.nextMoveAt = now + Math.floor(randomPauseMs(this.monsterRng));
          return;
        }
      }

      // Active trip → autopilot toward the target, integrated like a player.
      const trip = m.trip!;
      const a = stepAutopilot(grid, trip, m.x, m.y, now, this.worldW, this.worldH, m.elev);
      if (a.done) {
        m.tripActive = false;
        m.trip = null;
        m.moving = false;
        m.nextMoveAt = now + Math.floor(randomPauseMs(this.monsterRng));
        return;
      }

      const surf = surfaceAtWorld(grid, m.x, m.y);
      const r = stepMovement(
        m.x,
        m.y,
        a.ax,
        a.ay,
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
    });
  }

  /** Pick a random roam target from the zone's PRE-VALIDATED cells, preferring
   * one within MONSTER_ROAM_RADIUS_CELLS of the current spot (local milling,
   * not cross-zone beelines) and at least a cell away. Falls back to any zone
   * cell — every candidate is valid ground, so no standability re-check. */
  private pickMonsterTarget(zone: ZoneRuntime, fromX: number, fromY: number): { x: number; y: number } {
    const fc = fromX / CELL_WU;
    const fr = fromY / CELL_WU;
    let fallback: { x: number; y: number } | null = null;
    for (let i = 0; i < 8; i++) {
      const cell = zone.cells[Math.floor(this.monsterRng() * zone.cells.length)];
      const p = { x: (cell.c + 0.5) * CELL_WU, y: (cell.r + 0.5) * CELL_WU };
      if (!fallback) fallback = p;
      const d = Math.hypot(cell.c + 0.5 - fc, cell.r + 0.5 - fr);
      if (d < 1) continue; // essentially on top of the current position
      if (d <= MONSTER_ROAM_RADIUS_CELLS) return p;
    }
    return fallback ?? { x: fromX, y: fromY };
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
