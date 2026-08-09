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
  surfaceAtWorldElev,
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
  WALK_SPEED,
  RUN_SPEED,
  ISO_DX,
  ISO_DY,
  faceDirWorld,
  attackRange,
  playerAtk,
  damageRoll,
  idSalt,
  xpToNext,
  hpMaxFor,
  epMaxFor,
  slowFactorAt,
  SLOW_FACTOR,
  FLEE_SLOW_FACTOR,
  provokedChaseSpeed,
  rollDrops,
  LEVEL_CAP,
  PLAYER_ATTACK_MS,
  PROVOKE_RADIUS_WU,
  CHASE_SPEED_WU,
  ESCAPE_RADIUS_WU,
  MAX_CHASE_WU,
  ORBIT_SPEED_WU,
  ORBIT_FLIP_MEAN_S,
  MONSTER_DIE_MS,
  MONSTER_RESPAWN_MS,
  PLAYER_RESPAWN_MS,
  PLAYER_DEATH_MAX_MS,
  REGEN_DELAY_MS,
  HP_REGEN_FRAC_PER_S,
  EP_REGEN_FRAC_PER_S,
  DROP_SCATTER_WU,
  DROP_TTL_MS,
  PICKUP_RADIUS_WU,
  DROP_SPACING_WU,
  INV_MAX_STACK,
  INV_MAX_SLOTS,
} from "@nangijala/shared";
import { WorldState, Player, Monster, MonsterArea, GroundItem } from "../schema/WorldState.js";
import { monsterStatsFor, MonsterStats } from "../tuning.js";
import { onLiveChange, liveTuning } from "../live.js";
import { JsonPlayerStore, PlayerStore, progressStore } from "../store.js";
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
  /** Session ids that have "disable aggro" on — see the "noaggro" handler.
   * A Set rather than a schema field: nobody else can see the difference, so
   * it costs no bandwidth and no sync. Cleared in onLeave with the player. */
  private noAggro = new Set<string>();
  // Wild shooting stars streak the night sky at random (arrivals get their
  // own star in onJoin, any hour).
  private starTimer: ReturnType<typeof setTimeout> | null = null;
  private auroraChance = 0.45; // share of nights with northern lights

  private scheduleWildStar() {
    if (this.starTimer) clearTimeout(this.starTimer);
    // Free-running timer that only fires a star when it lands in NIGHT.
    // The 8-25s interval is sized against night's own length (50s, a third
    // of the cycle) so a night still sees the same ~2-3 wild stars.
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
    lootChance?: number; // TEST override: force every loot entry to this chance (1 = always drop)
  }) {
    if (typeof options?.auroraChance === "number") this.auroraChance = options.auroraChance;
    if (typeof options?.monsterCount === "number")
      this.monsterCount = Math.max(0, Math.floor(options.monsterCount));
    if (typeof options?.monsterSeed === "number") this.monsterRng = mulberry32(options.monsterSeed);
    if (typeof options?.lootChance === "number") this.lootChance = clamp(options.lootChance, 0, 1);
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
      // A corpse doesn't move, but its in-flight inputs MUST still be acked:
      // un-acked seqs stay in the client's pending replay buffer and render
      // the body offset from where it fell (and pop it off-spawn on revive).
      if (player.dead) {
        if (typeof message.seq === "number") player.seq = message.seq;
        return;
      }
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

    // DISABLE AGGRO — a per-player testing switch (maintainer 2026-08-07: "I
    // will use this feature to test walk around in the cave without dying").
    //
    // PER PLAYER, and deliberately NOT in the schema. It changes nothing anyone
    // else can see — no art, no state another client renders — so putting it in
    // the schema would spend a synced field per player on a debug flag. The
    // client owns it in localStorage and re-sends it on join, exactly like the
    // torch does; the server is the only thing that has to know.
    //
    // It suppresses UNPROVOKED aggro only. A monster you have raised your sword
    // at (p.target === id) still comes for you, and one you hit still fights
    // back — the switch is "nothing jumps me while I walk", not god mode.
    // Flipping it ON also RELEASES every unprovoked chase already running:
    // without that you would have to outrun whatever noticed you before the
    // switch could help, which is the whole situation it exists for.
    this.onMessage("noaggro", (client, message: { on?: boolean }) => {
      const on = !!message?.on;
      if (on) this.noAggro.add(client.sessionId);
      else this.noAggro.delete(client.sessionId);
      if (!on) return;
      const now = Date.now();
      this.state.monsters.forEach((m) => {
        if (m.targetSid !== client.sessionId || m.provoked || m.mstate === "die") return;
        // The SAME exit every other ended chase takes — it also clears the
        // victim's flee slow and walks the monster home if the hunt carried it
        // off its zone. Hand-clearing targetSid here would leave strays.
        const z = this.zones.find((zz) => zz.zone.id === m.areaId);
        if (z) this.disengageMonster(m, z, now);
      });
    });

    // Respawn: send the player back to a fresh spawn point (settings button /
    // stuck recovery). Clear queued movement + any jump so they don't drift off
    // spawn; the client snaps to the teleport (its >2-cell jump threshold).
    this.onMessage("respawn", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      // DEAD PLAYERS COME BACK WHEN THEY ASK TO. The death sequence (fade,
      // desaturate, slow zoom onto the body, "press to continue") runs on the
      // client and ends in this message — the server only insists the die clip
      // has finished, so a stray early press cannot strand a walking body at
      // spawn mid-animation. Before this, respawn was on a 2.6s timer and the
      // message ignored the dead entirely.
      if (player.dead) {
        if (Date.now() < player.respawnAt) return;
        this.revivePlayer(player);
        return;
      }
      this.placeAtSpawn(player);
      player.inputQueue.length = 0;
      player.timeCredit = 0;
      player.jumpUntil = 0;
    });

    // DEBUG ONLY, same standing as `teleport`: drop my own hp to zero so the
    // death sequence can be driven from a gate. It runs the REAL death path
    // (hurtPlayer's kill branch), so what a probe sees is what a monster does
    // — a test that fakes the state would not have caught the respawn timer
    // still firing underneath the new press-to-continue.
    this.onMessage("dbgkill", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.dead) return;
      // Full hp of damage through the REAL path, so every field death sets
      // (respawnAt, deadUntil, the die clip, the chat line) is set the same way.
      this.hurtPlayer(player, player.hpMax + 1, Date.now());
    });

    // ENGAGE a monster (RO: click a monster to fight it). The client walks
    // into reach first and then engages; the server drives the swing loop
    // while the target stays alive, in range and the player stands still.
    // {id: null} disengages (any movement input also does).
    this.onMessage("engage", (client, message: { id?: string | null }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.dead) return;
      const id = typeof message?.id === "string" ? message.id : "";
      if (!id) {
        player.target = "";
        return;
      }
      const m = this.state.monsters.get(id);
      if (!m || m.mstate === "die") return;
      player.target = id;
    });

    // PICK UP a ground item. Range-validated server-side; the pickup clip is
    // signalled through action/actionSeq so every client sees the crouch.
    this.onMessage("pickup", (client, message: { id?: string }) => {
      const player = this.state.players.get(client.sessionId);
      const id = typeof message?.id === "string" ? message.id : "";
      const drop = this.state.drops.get(id);
      if (!player || player.dead || !drop) return;
      const now = Date.now();
      if (now < player.nextItemMsgAt) return; // pickup/drop share a light cadence cap
      player.nextItemMsgAt = now + 150;
      if (Math.hypot(drop.x - player.x, drop.y - player.y) > PICKUP_RADIUS_WU) return;
      // Same layer band as every combat range check — no grabbing through a deck.
      if (Math.abs(player.elev - drop.elev) > 2) return;
      if (!this.addInvItem(player, drop.item)) {
        client.send("chat", { name: "—", text: "Your backpack is full." });
        return;
      }
      this.state.drops.delete(id);
      player.action = "pickup";
      player.actionSeq++;
      // Turn TO the item being grabbed (maintainer 2026-08-05) — the synced
      // dir is what every other client renders the crouch with.
      const face = faceDirWorld(player.x, player.y, drop.x, drop.y);
      if (face) player.dir = face;
      client.send("inv", { items: player.inv });
    });

    // DROP an inventory item on the ground (backpack drag-out). Placement is
    // ALWAYS a pseudo-random scatter around the PLAYER (maintainer
    // 2026-08-05), spaced off items already lying there — the release point
    // only expresses "onto the ground", never a throw.
    this.onMessage("drop", (client, message: { slot?: number; item?: string; n?: number; wx?: number; wy?: number }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.dead) return;
      const now = Date.now();
      if (now < player.nextItemMsgAt) return;
      player.nextItemMsgAt = now + 150; // charged before every early return below
      const slot = typeof message?.slot === "number" ? Math.floor(message.slot) : -1;
      const entry = player.inv[slot];
      if (!entry || entry.n < 1) return;
      // Slot indices go stale the moment a stack empties and the array
      // compacts (the client learns via the async "inv" refresh) — the item
      // id in the message is the ground truth for WHICH item the player meant.
      if (typeof message?.item === "string" && message.item !== entry.item) {
        client.send("inv", { items: player.inv }); // heal the stale grid now
        return;
      }
      const item = entry.item;
      // HOW MANY: the backpack's quantity dialog (maintainer 2026-08-05) sends
      // the count a ×2+ stack was dropped with; anything absent or junk is ONE,
      // and the stack itself is the ceiling — a client can never drop what it
      // does not hold. The cadence charge is per ITEM (a flat 150ms per
      // message would let one tap put a 99-stack on the ground and repeat
      // 6.7×/s), so a mass drop pays for its own burst.
      const want = clamp(
        typeof message?.n === "number" && isFinite(message.n) ? Math.floor(message.n) : 1,
        1,
        entry.n,
      );
      player.nextItemMsgAt += 20 * (want - 1);
      entry.n -= want;
      if (entry.n <= 0) player.inv.splice(slot, 1);
      for (let i = 0; i < want; i++) this.spawnDrop(item, player.x, player.y, player.elev);
      client.send("inv", { items: player.inv });
    });

    // Teleport: drop the player at an EXACT world coordinate (debug tool —
    // reproduce a spot from a screenshot). Unlike respawn it does NOT snap to a
    // standable spawn; it places precisely where asked (clamped to world bounds)
    // so a reported bug at a known (x,y) can be re-observed. Clears queued
    // movement + jump so they hold the mark; client snaps via its jump threshold.
    this.onMessage("teleport", (client, message: { x?: number; y?: number }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.dead) return;
      const w = this.terrain ? this.terrain.width * CELL_WU : this.worldW;
      const h = this.terrain ? this.terrain.height * CELL_WU : this.worldH;
      // Finite-number validation, same as the drop handler: NaN/junk here
      // would poison the synced position and everything downstream of it.
      const tx = typeof message?.x === "number" && isFinite(message.x) ? message.x : player.x;
      const ty = typeof message?.y === "number" && isFinite(message.y) ? message.y : player.y;
      player.x = clamp(tx, 0, w - 1);
      player.y = clamp(ty, 0, h - 1);
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
        const stats = monsterStatsFor(m.kind);
        m.hp = m.hpMax = stats.max_hp;
        m.level = stats.level;
        m.aggro = stats.aggro_radius_wu;
        const mid = `${z.zone.id}#${n}`;
        m.orbitSign = idSalt(mid) & 1 ? 1 : -1; // circling handedness varies per monster
        this.state.monsters.set(mid, m);
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

    // ONE live session per token (RO kicks the older login): a second tab on
    // the same browser shares the localStorage token, and two live sessions on
    // one store record dup/eat items on last-writer-wins saves. The newcomer
    // takes over the LIVE progression (fresher than the store) and the old
    // session is disconnected.
    if (player.token) {
      let oldSid = "";
      this.state.players.forEach((p: Player, sid: string) => {
        if (!oldSid && p.token === player.token && sid !== client.sessionId) oldSid = sid;
      });
      if (oldSid) {
        const oldPlayer = this.state.players.get(oldSid);
        if (oldPlayer) this.savePlayer(oldPlayer); // flush the live state the newcomer restores
        this.clients.find((c) => c.sessionId === oldSid)?.leave(4001); // its onLeave re-saves the same values
      }
    }

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
    // Progression survives relogs (RO: your character IS the level) and is
    // WORLD-AGNOSTIC — it lives in the shared progress store, not the
    // per-world position file, so switching worlds never forks the character.
    // Migration: tokens whose progression still rides an old per-world record
    // (or none at all — pre-combat records) seed from `saved` once.
    const prog = player.token ? progressStore().load(player.token) : undefined;
    player.level = Math.min(LEVEL_CAP, Math.max(1, prog?.level ?? saved?.level ?? 1));
    player.xp = Math.max(0, prog?.xp ?? saved?.xp ?? 0);
    player.hpMax = hpMaxFor(player.level);
    player.epMax = epMaxFor(player.level);
    // Never restore a corpse: a save written at 0 hp comes back at 1 (limping,
    // not dead — dying logs you out at the spawn next tick otherwise).
    player.hp = Math.min(player.hpMax, Math.max(1, prog?.hp ?? saved?.hp ?? player.hpMax));
    player.ep = Math.min(player.epMax, Math.max(0, prog?.ep ?? saved?.ep ?? player.epMax));
    const invSrc = prog?.inv ?? saved?.inv;
    player.inv = Array.isArray(invSrc)
      ? invSrc
          .filter((s) => s && typeof s.item === "string" && typeof s.n === "number" && s.n > 0)
          .map((s) => ({ item: s.item, n: Math.min(INV_MAX_STACK, Math.floor(s.n)) }))
          .slice(0, INV_MAX_SLOTS)
      : [];
    this.state.players.set(client.sessionId, player);
    // The backpack is PRIVATE — targeted message, never schema-synced.
    client.send("inv", { items: player.inv });
    // Every arrival in Nangijala is announced by a shooting star crossing
    // the sky — the same streak for every player in the world.
    this.broadcast("star", { name: player.name });
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) this.savePlayer(player);
    this.state.players.delete(client.sessionId);
    // Session ids are not reused, so a stale entry would leak for the room's
    // lifetime and silently pacify whoever inherited the id.
    this.noAggro.delete(client.sessionId);
  }

  /** Persist one player: position to the per-world store, progression to the
   * shared world-agnostic store. Called on leave, death, level-up and the
   * periodic flush — onLeave-only persistence meant a crash ate every
   * connected player's session gains. */
  private savePlayer(player: Player) {
    if (!player.token) return;
    this.store.save(player.token, {
      character: player.character,
      name: player.name,
      x: player.x,
      y: player.y,
    });
    progressStore().save(player.token, {
      level: player.level,
      xp: player.xp,
      hp: player.hp,
      ep: player.ep,
      inv: player.inv,
    });
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
    // Who is being HUNTED by a monster they provoked? Those players carry the
    // persistent flee slow until the escape line is crossed (the hunter
    // disengages) — one monster pass here, consumed in the player loop below.
    const hunted = new Set<string>();
    this.state.monsters.forEach((m: Monster) => {
      if (m.provoked && m.targetSid && (m.mstate === "chase" || m.mstate === "combat"))
        hunted.add(m.targetSid);
    });
    this.state.players.forEach((player, id) => {
      const jumping = now < player.jumpUntil;
      player.jumping = jumping;

      // The hit stagger + the flee slow: ONE synced factor the client
      // prediction mirrors (both sides multiply stepMovement's speedScale).
      player.slow = player.dead
        ? 1
        : Math.min(slowFactorAt(player.lastHitAt, now), hunted.has(id) ? FLEE_SLOW_FACTOR : 1);
      // A corpse doesn't walk: swallow queued input while dead (the client
      // freezes its own input too; this is the authoritative guard). Ack the
      // dropped seqs — un-acked entries would sit in the client's pending
      // replay buffer and render the corpse offset from where it fell.
      if (player.dead) {
        for (const q of player.inputQueue) if (typeof q.seq === "number") player.seq = q.seq;
        player.inputQueue.length = 0;
        player.moving = false;
        player.running = false;
        player.lastMoving = false;
        return;
      }

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
          // ELEVATION-AWARE: on a DECK the feet are on the deck's own material,
          // not on the water or chasm it spans. Reading the base made every
          // bridge crossing a swim (maintainer 2026-08-09: "I don't want
          // players to run slower over bridges"). The client's prediction calls
          // the identical function — they must, or the two disagree about speed
          // and the body rubber-bands the length of the bridge.
          const surf = surfaceAtWorldElev(terrain, player.x, player.y, player.elev);
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
            surf.speed * (jumping ? JUMP_SPEED_FACTOR : 1) * player.slow,
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
    this.stepCombat(dt, now);
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
      // Mirror the hunt target into the synced field (colyseus only encodes
      // changes, so re-assigning the same value each tick costs nothing). The
      // client draws the red aggro border on monsters whose tsid is its own
      // session (round 11); roam/return/die always read as "not hunting".
      m.tsid = (m.mstate === "chase" || m.mstate === "combat") ? m.targetSid : "";
      const zone = zoneById.get(m.areaId);
      if (!zone) {
        m.moving = false;
        return;
      }
      // A corpse holds its spot for the die clip; stepCombat sweeps it.
      if (m.mstate === "die") {
        m.moving = false;
        return;
      }
      const ctx = { maxClimb: WALK_CLIMB, canSwim: zone.canSwim };
      const rm = bodies[i].r;
      // Movement containment depends on the state: roaming stays ON the zone
      // polygon (the shipped invariant), but a CHASE follows its victim off it
      // — bounded by the leash box instead, so combat can spill past the edge
      // without tripping the snap-back teleport mid-fight.
      const contained = (x: number, y: number) =>
        m.mstate === "roam" && !m.returning ? inZone(zone, x, y) : this.withinLeash(zone, x, y);

      // POSITIONAL separation: overlap beyond (rA+rB+margin) is pushed out at
      // up to MONSTER_SEP_RELAX_SPEED — a firm, visible shove (stacked
      // mammoths walk apart in ~a second), per-axis validated so a wall,
      // water edge or the zone boundary just clips it.
      const push = separationPush(bodies, i, dt, tieBreakAngle(id));
      if (push) {
        const nx = clamp(m.x + push.dx, 1, this.worldW - 1);
        const ny = clamp(m.y + push.dy, 1, this.worldH - 1);
        if (contained(nx, m.y) && canEnterElev(grid, m.elev, m.x, m.y, nx, m.y, ctx).ok)
          m.x = nx;
        if (contained(m.x, ny) && canEnterElev(grid, m.elev, m.x, m.y, m.x, ny, ctx).ok)
          m.y = ny;
        m.elev = resolveElevAt(grid, m.elev, m.x, m.y, ctx);
        bodies[i].x = m.x;
        bodies[i].y = m.y;
      }

      // --- COMBAT STATES (chase / in-fight) --------------------------------
      if (m.targetSid) {
        const tp = this.state.players.get(m.targetSid);
        if (!tp || tp.dead) this.disengageMonster(m, zone, now);
      }
      if (m.mstate === "chase" || m.mstate === "combat") {
        const tp = this.state.players.get(m.targetSid);
        if (!tp) {
          this.disengageMonster(m, zone, now);
          return;
        }
        // WATER SANCTUARY: a swimming victim is untouchable and unhuntable —
        // reaching the water IS an escape (monsters cannot enter it, and the
        // swing loop refuses swimming attackers, so there is no water-sniping).
        if (tp.swimming) {
          this.disengageMonster(m, zone, now);
          return;
        }
        const stats = monsterStatsFor(m.kind);
        const dxp = tp.x - m.x;
        const dyp = tp.y - m.y;
        const dist = Math.hypot(dxp, dyp);
        // MAX CHASE — "max chase is 1.5 screens (regardless of how close it
        // is)" (maintainer 2026-08-06), measured from WHERE THIS HUNT BEGAN.
        //
        // This used to be measured from the zone's BOUNDING BOX, and that is
        // why a hunt could run six screens (maintainer 2026-08-06: "I had to
        // run so extremely long and the enemy still didn't give up … I said I
        // wanted them to give up after a single screen"). MEASURED on
        // the_island2: shore-1's bbox is 10.0 screens tall and shore-2's 8.5,
        // so "within MAX_CHASE_WU of the box" licensed 13 and 11.5 screens of
        // pursuit. The box is the monster's HABITAT — its size says nothing
        // about how far one chase should run, and it grows with every world
        // maps2 authors.
        //
        // It also could not be rescued by the victim-distance rule below: a
        // PROVOKED hunter moves at 1.12x its victim's speed by design, so the
        // gap NEVER opens by running and ESCAPE_RADIUS_WU can only fire when
        // terrain stops the monster. Both exits were shut; this is the one
        // that has to hold, so it is now anchored to the pursuit itself.
        const chased = Math.hypot(m.x - m.chaseOx, m.y - m.chaseOy);
        if (chased > MAX_CHASE_WU) {
          this.disengageMonster(m, zone, now);
          return;
        }
        // Habitat containment stays as a SECOND, independent bound: a chase
        // that starts near the rim of a small zone must not tow the monster
        // into the next biome even if it has not travelled 1.5 screens yet.
        if (!this.withinLeash(zone, m.x, m.y)) {
          this.disengageMonster(m, zone, now);
          return;
        }
        const range = attackRange(rm, PLAYER_BODY_RADIUS);
        // DE-AGGRO BY DISTANCE (maintainer round 9: "aggro monsters should
        // also stop chasing if the player runs away too far"). The leash box
        // below is measured from the monster's HOME ZONE, and a big zone's
        // bbox can be most of the map — a predator that noticed you at the
        // edge of a huge zone would follow far past any sane give-up point.
        // This rule is measured monster-to-victim instead, so ~0.75 of a
        // screen of daylight ends ANY hunt regardless of zone size. (A provoked
        // hunter paces its victim and never falls this far behind unless
        // terrain has genuinely stopped it — where giving up is also right.)
        if (dist > ESCAPE_RADIUS_WU) {
          this.disengageMonster(m, zone, now);
          return;
        }
        // Give up when the VICTIM has escaped past the leash and is out of
        // reach: the chase may not follow there, so it cannot be won — and a
        // terrain-wedged chaser (a lake inside the leash box) must not stand
        // hunting forever either. Rim-fights survive: in-reach keeps combat.
        if (dist > range && !this.withinLeash(zone, tp.x, tp.y)) {
          this.disengageMonster(m, zone, now);
          return;
        }
        const sameLayer = Math.abs(m.elev - tp.elev) <= 2; // no swiping through a deck
        if (dist <= range && sameLayer) {
          // IN REACH — the fight. Face the victim; CIRCLE it slowly (the
          // maintainer's in-a-fight idea: tangential drift plus a soft radial
          // hold, so attack/angry directions sweep as the pair rotates); swing
          // on the tuning cooldown. moving stays false: the client shows the
          // angry between-swings loop, not the walk.
          m.mstate = "combat";
          m.moving = false;
          const face = faceDirWorld(m.x, m.y, tp.x, tp.y);
          if (face) m.dir = face;
          // The boxing pair RARELY switches direction — exponential with a
          // ~ORBIT_FLIP_MEAN_S mean while actively circling (maintainer:
          // "rarely change orbit direction, once every min on average").
          if (Math.random() < dt / ORBIT_FLIP_MEAN_S) m.orbitSign = -m.orbitSign;
          const inv = 1 / (dist || 1);
          const ux = dxp * inv;
          const uy = dyp * inv;
          const radial = (dist - range * 0.88) * 1.4; // hold just inside reach (round 6: a bit farther out)
          const mx2 = clamp(m.x + (-uy * m.orbitSign * ORBIT_SPEED_WU + ux * radial) * dt, 1, this.worldW - 1);
          const my2 = clamp(m.y + (ux * m.orbitSign * ORBIT_SPEED_WU + uy * radial) * dt, 1, this.worldH - 1);
          if (contained(mx2, m.y) && canEnterElev(grid, m.elev, m.x, m.y, mx2, m.y, ctx).ok) m.x = mx2;
          if (contained(m.x, my2) && canEnterElev(grid, m.elev, m.x, m.y, m.x, my2, ctx).ok) m.y = my2;
          m.elev = resolveElevAt(grid, m.elev, m.x, m.y, ctx);
          if (now >= m.nextAttackAt) {
            m.nextAttackAt = now + stats.attack_cooldown_ms;
            m.actionSeq++;
            this.hurtPlayer(tp, damageRoll(stats.damage, idSalt(m.areaId), m.actionSeq), now);
          }
        } else {
          // OUT OF REACH — the hunt. Direct drive through the same collision
          // pipeline as roam (wall-slide handles obstacles). UNPROVOKED
          // (predator noticed you): constant 105 wu/s — an innocent sprinter
          // (175) always pulls clear. PROVOKED (you started it): the monster
          // tracks its victim's CURRENT possible speed and stays slightly
          // above it, so running only postpones the next bite — escape is
          // crossing the ESCAPE line, not winning a footrace.
          m.mstate = "chase";
          let chaseWu = CHASE_SPEED_WU;
          if (m.provoked) {
            const victimWu =
              (tp.moving ? (tp.running ? RUN_SPEED : WALK_SPEED) : 0) *
              tp.slow *
              surfaceAtWorld(grid, tp.x, tp.y).speed;
            chaseWu = provokedChaseSpeed(victimWu);
          }
          const sax = dxp - dyp; // world delta -> SCREEN input (iso projection)
          const say = (dxp + dyp) * (ISO_DY / ISO_DX);
          const slen = Math.hypot(sax, say) || 1;
          const surf2 = surfaceAtWorld(grid, m.x, m.y);
          const r2 = stepMovement(
            m.x,
            m.y,
            sax / slen,
            say / slen,
            false,
            dt,
            makeBlockedElev(grid, ctx, () => m.elev),
            surf2.speed * (chaseWu / WALK_SPEED),
            true,
            this.worldW,
            this.worldH,
            makeSideBlocked(grid, ctx),
          );
          if (contained(r2.x, r2.y)) {
            m.x = r2.x;
            m.y = r2.y;
            if (r2.dir) m.dir = r2.dir;
            m.moving = r2.moving;
            m.elev = resolveElevAt(grid, m.elev, m.x, m.y, ctx);
          } else {
            // A leash-rejected chase step IS the give-up signal. The :830
            // position check alone is dead code — every way a chasing monster
            // moves is gated by withinLeash, so it can reach the rim but never
            // cross it; without this branch it wedges there in "chase" forever
            // (walking in place, untargetable-by-others, no way home).
            this.disengageMonster(m, zone, now);
            return;
          }
        }
        bodies[i].x = m.x;
        bodies[i].y = m.y;
        return; // combat drive replaces roam entirely this tick
      }

      // --- PROXIMITY AGGRO -------------------------------------------------
      // Scanned ~2/s, not per tick. Two ways in: a PREDATOR (tuning
      // aggro_radius_wu > 0) notices anyone close — an UNPROVOKED chase the
      // victim can simply outrun; and a SWORD-MARKED monster (a player's
      // engage target — the attack icon hangs over it) aggros the moment that
      // player closes inside max(its radius, PROVOKE_RADIUS) — a PROVOKED
      // fight, passive kinds included: raising your sword IS the provocation.
      // Suppressed while walking home from a given-up chase: a predator that
      // just disengaged at the leash rim would otherwise re-aggro the same
      // out-of-reach player every 450ms in a chase/disengage yo-yo (each
      // round burning a full walk-home A*).
      if (now >= m.aggroCheckAt && !m.returning) {
        m.aggroCheckAt = now + 450;
        const stats = monsterStatsFor(m.kind);
        let bestSid = "";
        let bestD = Infinity;
        let bestProvoked = false;
        this.state.players.forEach((p, sid) => {
          if (p.dead || p.swimming || Math.abs(p.elev - m.elev) > 2) return; // water = sanctuary
          const marked = p.target === id;
          // "Disable aggro" (Settings): this player is invisible to UNPROVOKED
          // aggro. Marking a monster with the sword still provokes it — the
          // switch removes the ambush, not the fight.
          if (!marked && this.noAggro.has(sid)) return;
          const radius = marked
            ? Math.max(stats.aggro_radius_wu, PROVOKE_RADIUS_WU)
            : stats.aggro_radius_wu;
          if (radius <= 0) return;
          const d = Math.hypot(p.x - m.x, p.y - m.y);
          if (d <= radius && d < bestD) {
            bestD = d;
            bestSid = sid;
            bestProvoked = marked;
          }
        });
        if (bestSid) {
          m.targetSid = bestSid;
          m.provoked = bestProvoked;
          m.mstate = "chase";
          m.chaseOx = m.x; // the hunt's origin — MAX_CHASE_WU is measured from here
          m.chaseOy = m.y;
          m.tripActive = false;
          m.trip = null;
          m.returning = false;
          return;
        }
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
        m.trip = startTrip(grid, m.x, m.y, t.x, t.y, false, now, m.elev, undefined, MONSTER_ROAM_MAX_NODES, false);
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
        m.returning = false; // if this was the walk home, we have arrived
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
      if (!m.returning && !zone.cellSet.has(mc + mr * grid.width)) {
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

  // --- COMBAT -----------------------------------------------------------

  private lootChance: number | null = null; // test knob — see onCreate
  private respawnQueue: Array<{ areaId: string; at: number }> = [];
  private respawnCounter = 0;
  private dropCounter = 0;
  private dropSweepAt = 0;
  private storeFlushAt = 0;
  private leashBoxes = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();

  /** True while (x,y) is within MAX_CHASE_WU (~1.5 screens) of the zone's
   * bounding box — the LEASH: a chase may spill this far from home and no
   * further, whatever the victim does. Separate from ESCAPE_RADIUS_WU, which
   * ends a hunt on monster-to-victim daylight (~0.75 screens). Cheap: clamp
   * + hypot. */
  private withinLeash(zone: ZoneRuntime, x: number, y: number): boolean {
    let box = this.leashBoxes.get(zone.zone.id);
    if (!box) {
      box = zoneBBox(zone.zone);
      this.leashBoxes.set(zone.zone.id, box);
    }
    const cx = clamp(x, box.x0, box.x1);
    const cy = clamp(y, box.y0, box.y1);
    return Math.hypot(x - cx, y - cy) <= MAX_CHASE_WU;
  }

  /** End a monster's fight: clear the target and, if the chase carried it off
   * its polygon, walk it home (a legal out-of-zone trip the snap-back ignores;
   * if no route exists, snap immediately — never leave a stray). */
  private disengageMonster(m: Monster, zone: ZoneRuntime, now: number) {
    m.targetSid = "";
    m.provoked = false; // the hunt is over — the victim's flee slow lifts
    if (m.mstate !== "die") m.mstate = "roam";
    m.tripActive = false;
    m.trip = null;
    const grid = this.terrain!;
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
      m.targetX = (best.c + 0.5) * CELL_WU;
      m.targetY = (best.r + 0.5) * CELL_WU;
      m.trip = startTrip(grid, m.x, m.y, m.targetX, m.targetY, false, now, m.elev, undefined, 900, false);
      m.tripActive = !!m.trip;
      m.returning = m.tripActive;
      if (!m.tripActive) {
        // Boxed in outside the zone — hard snap, same as the roam safety net.
        m.x = m.targetX;
        m.y = m.targetY;
        m.elev = best.lvl;
      }
    }
    m.nextMoveAt = now + Math.floor(randomPauseMs(this.monsterRng));
  }

  /** Damage LANDING on a player: hp, the hurt flinch, the hit-slow window —
   * and death when it empties (die clip holds until the respawn snap). */
  private hurtPlayer(player: Player, dmg: number, now: number) {
    player.hp = Math.max(0, player.hp - dmg);
    player.hitSeq++;
    player.lastHitAt = now;
    player.lastCombatAt = now;
    player.regenAccHp = 0;
    player.regenAccEp = 0;
    // Mirror the slow into the synced field NOW, not at the next tick top —
    // otherwise the patch carrying hitSeq precedes the one carrying slow and
    // the client integrates a full-speed tick the server didn't.
    if (!player.dead) player.slow = SLOW_FACTOR;
    if (player.hp <= 0 && !player.dead) {
      player.dead = true;
      player.action = "die";
      player.actionSeq++;
      player.slow = 1;
      player.target = "";
      player.respawnAt = now + PLAYER_RESPAWN_MS; // earliest the press may land
      player.deadUntil = now + PLAYER_DEATH_MAX_MS; // backstop if it never does
      for (const q of player.inputQueue) if (typeof q.seq === "number") player.seq = q.seq;
      player.inputQueue.length = 0;
      player.moving = false;
      player.running = false;
      this.broadcast("chat", { name: "—", text: `${player.name} was slain.` });
      this.savePlayer(player); // a crash between here and respawn loses nothing
    }
  }

  /** Bring a dead player back: fresh spawn, full bars, queues cleared. ONE
   * implementation for both the press and the backstop — two copies of a
   * revive is how a field gets cleared on one path and not the other. */
  private revivePlayer(player: Player) {
    this.placeAtSpawn(player);
    player.hp = player.hpMax;
    player.ep = player.epMax;
    player.dead = false;
    player.action = "";
    player.slow = 1;
    player.lastHitAt = -100000;
    player.regenAccHp = 0;
    player.regenAccEp = 0;
    for (const q of player.inputQueue) if (typeof q.seq === "number") player.seq = q.seq;
    player.inputQueue.length = 0;
    player.timeCredit = 0;
  }

  /** A monster dies: start the die clip (the schema entry lingers so every
   * client renders the death), award xp + level-ups to the killer. Drops and
   * removal happen MONSTER_DIE_MS later in stepCombat. */
  private killMonster(killer: Player, m: Monster, now: number) {
    m.mstate = "die";
    m.moving = false;
    m.targetSid = "";
    m.provoked = false;
    m.diedAt = now;
    killer.target = "";
    const stats = monsterStatsFor(m.kind);
    // At the cap xp has nowhere to go (RO shows a frozen bar) — don't let it
    // accumulate into a meaningless ever-growing number in the save file.
    if (killer.level < LEVEL_CAP) killer.xp += stats.xp;
    let leveled = false;
    while (killer.level < LEVEL_CAP && killer.xp >= xpToNext(killer.level)) {
      killer.xp -= xpToNext(killer.level);
      killer.level++;
      leveled = true;
      // Level-up burst: full pools at the new maxima (the RO ding feel).
      killer.hpMax = hpMaxFor(killer.level);
      killer.epMax = epMaxFor(killer.level);
      killer.hp = killer.hpMax;
      killer.ep = killer.epMax;
    }
    if (killer.level >= LEVEL_CAP) killer.xp = Math.min(killer.xp, xpToNext(LEVEL_CAP) - 1);
    if (leveled) {
      this.broadcast("levelup", { name: killer.name, level: killer.level });
      this.savePlayer(killer); // the worst thing a crash could eat is a ding
    }
  }

  /** Put one item on the ground near (x,y): a pseudo-random scatter that
   * KEEPS ITS DISTANCE from items already lying there (maintainer 2026-08-05:
   * "close and not on top of each other" — a pile of loot must read as
   * distinct sprites). srcElev threads the dropper's layer through: a drop
   * made ON a bridge deck stays on the deck (deck-aware elevation) instead of
   * rendering in the water under the span. Placement prefers reachable ground
   * clear of other drops (the ring grows as the ground crowds), then the
   * best-spaced reachable point, then the nearest standable cell — and only a
   * corpse floating in open water (swim zones) keeps its exact spot, where
   * swimmers can still grab it. */
  private spawnDrop(item: string, x: number, y: number, srcElev = 0) {
    if (!item) return;
    const terr = this.terrain;
    let gx = clamp(x, 1, this.worldW - 1);
    let gy = clamp(y, 1, this.worldH - 1);
    const ctx = { maxClimb: WALK_CLIMB, canSwim: true };
    const ok = (px: number, py: number) =>
      !terr ||
      isStandableAtWorld(terr, px, py) ||
      resolveElevAt(terr, srcElev, px, py, ctx) > levelAtWorld(terr, px, py); // on a deck
    const nearestDrop = (px: number, py: number) => {
      let d = Infinity;
      this.state.drops.forEach((g: GroundItem) => {
        d = Math.min(d, Math.hypot(g.x - px, g.y - py));
      });
      return d;
    };
    let bestScore = -1; // the source point itself is only the last-resort fallback
    let placed = false;
    for (let t = 0; t < 12 && !placed; t++) {
      const a = Math.random() * Math.PI * 2;
      // Never right ON the source: the grave cross rises exactly there, and
      // loot must not cover it (maintainer: "a small margin away from the
      // cross is enough, not much") — so the ring starts ~21wu out.
      const r = (0.8 + Math.random() * 0.5) * DROP_SCATTER_WU * (1 + t / 6);
      const cx = clamp(x + Math.cos(a) * r, 1, this.worldW - 1);
      const cy = clamp(y + Math.sin(a) * r, 1, this.worldH - 1);
      if (!ok(cx, cy)) continue;
      const score = nearestDrop(cx, cy);
      if (score > bestScore) {
        bestScore = score;
        gx = cx;
        gy = cy;
      }
      if (score >= DROP_SPACING_WU) placed = true;
    }
    if (bestScore < 0 && terr && !ok(gx, gy)) {
      // All probes wet/blocked: take the nearest standable cell centre within
      // a short ring-scan before giving up to the open-water fallback.
      const c0 = Math.floor(gx / CELL_WU);
      const r0 = Math.floor(gy / CELL_WU);
      let best: { x: number; y: number; d: number } | null = null;
      for (let dr = -3; dr <= 3; dr++) {
        for (let dc = -3; dc <= 3; dc++) {
          const px = (c0 + dc + 0.5) * CELL_WU;
          const py = (r0 + dr + 0.5) * CELL_WU;
          if (px < 1 || py < 1 || px > this.worldW - 1 || py > this.worldH - 1) continue;
          if (!isStandableAtWorld(terr, px, py)) continue;
          const d = Math.hypot(px - gx, py - gy);
          if (!best || d < best.d) best = { x: px, y: py, d };
        }
      }
      if (best) {
        gx = best.x;
        gy = best.y;
      }
    }
    const g = new GroundItem();
    g.item = item;
    g.x = gx;
    g.y = gy;
    g.elev = terr ? resolveElevAt(terr, srcElev, gx, gy, ctx) : 0;
    g.bornAt = Date.now();
    this.state.drops.set(`d${this.dropCounter++}`, g);
  }

  /** One replacement monster in a zone, MONSTER_RESPAWN_MS after a death —
   * the zone's `num` stays the concurrent cap (RO-style repop). */
  private respawnMonster(areaId: string, now: number) {
    const z = this.zones.find((zz) => zz.zone.id === areaId);
    if (!z || !z.cells.length) return;
    const m = new Monster();
    m.kind = z.zone.monster;
    m.areaId = areaId;
    const cell = z.cells[Math.floor(this.monsterRng() * z.cells.length)];
    m.x = (cell.c + 0.5) * CELL_WU;
    m.y = (cell.r + 0.5) * CELL_WU;
    m.elev = cell.lvl;
    m.dir = "south";
    m.moving = false;
    m.nextMoveAt = now + 400;
    const stats = monsterStatsFor(m.kind);
    m.hp = m.hpMax = stats.max_hp;
    m.level = stats.level;
    m.aggro = stats.aggro_radius_wu;
    const id = `${areaId}#r${this.respawnCounter++}`;
    m.orbitSign = idSalt(id) & 1 ? 1 : -1;
    this.state.monsters.set(id, m);
  }

  /** Stack an item into the backpack. False = full (slot cap hit). */
  private addInvItem(player: Player, item: string): boolean {
    const slot = player.inv.find((s) => s.item === item && s.n < INV_MAX_STACK);
    if (slot) {
      slot.n++;
      return true;
    }
    if (player.inv.length >= INV_MAX_SLOTS) return false;
    player.inv.push({ item, n: 1 });
    return true;
  }

  /** Everything combat that is not monster movement: corpse sweep -> drops ->
   * repop scheduling, ground-item TTL, player death/respawn timers, regen and
   * the player swing loop. Runs each tick after stepMonsters. */
  private stepCombat(dt: number, now: number) {
    // Corpses whose die clip has finished -> loot + removal + repop timer.
    const swept: string[] = [];
    this.state.monsters.forEach((m: Monster, id: string) => {
      if (m.mstate === "die" && now >= m.diedAt + MONSTER_DIE_MS) swept.push(id);
    });
    for (const id of swept) {
      const m = this.state.monsters.get(id)!;
      const stats = monsterStatsFor(m.kind);
      const loot =
        this.lootChance === null ? stats.loot : stats.loot.map((l) => ({ ...l, chance: this.lootChance! }));
      for (const item of rollDrops(loot, idSalt(id), m.diedAt | 0)) this.spawnDrop(item, m.x, m.y, m.elev);
      this.state.monsters.delete(id);
      this.respawnQueue.push({ areaId: m.areaId, at: now + MONSTER_RESPAWN_MS });
    }
    if (this.respawnQueue.length && this.respawnQueue.some((r) => now >= r.at)) {
      const due = this.respawnQueue.filter((r) => now >= r.at);
      this.respawnQueue = this.respawnQueue.filter((r) => now < r.at);
      for (const r of due) this.respawnMonster(r.areaId, now);
    }
    // Periodic progression flush: bounds crash loss to ~30s of play (leave,
    // death and level-up flush eagerly on top of this).
    if (now >= this.storeFlushAt) {
      this.storeFlushAt = now + 30_000;
      this.state.players.forEach((p: Player) => this.savePlayer(p));
    }
    // Ground items despawn (1s sweep granularity is plenty for a 90s TTL).
    if (now >= this.dropSweepAt) {
      this.dropSweepAt = now + 1000;
      const stale: string[] = [];
      this.state.drops.forEach((g: GroundItem, id: string) => {
        if (now >= g.bornAt + DROP_TTL_MS) stale.push(id);
      });
      for (const id of stale) this.state.drops.delete(id);
    }
    // Players: respawn timers, out-of-combat regen, the swing loop.
    const radii = monsterRadii();
    this.state.players.forEach((player: Player, sid: string) => {
      if (player.dead) {
        // The BACKSTOP only — the press is what normally revives (see the
        // "respawn" message). Without it a closed tab leaves a corpse in the
        // world forever.
        if (now >= player.deadUntil) this.revivePlayer(player);
        return;
      }
      if (now - player.lastCombatAt > REGEN_DELAY_MS) {
        // Whole points only: the fraction accrues server-side so the synced
        // hp/ep (and every client's HUD write) change ~2x/s, not 20x/s.
        if (player.hp < player.hpMax) {
          player.regenAccHp += player.hpMax * HP_REGEN_FRAC_PER_S * dt;
          const whole = Math.floor(player.regenAccHp);
          if (whole >= 1) {
            player.regenAccHp -= whole;
            player.hp = Math.min(player.hpMax, player.hp + whole);
          }
        }
        if (player.ep < player.epMax) {
          player.regenAccEp += player.epMax * EP_REGEN_FRAC_PER_S * dt;
          const whole = Math.floor(player.regenAccEp);
          if (whole >= 1) {
            player.regenAccEp -= whole;
            player.ep = Math.min(player.epMax, player.ep + whole);
          }
        }
      }
      if (!player.target) return;
      const m = this.state.monsters.get(player.target);
      if (!m || m.mstate === "die") {
        player.target = "";
        return;
      }
      // RO: SWINGS require standing still — but the TARGET persists while
      // moving (the attack icon hangs over it and approach-aggro reads it);
      // ground taps / movement keys disengage explicitly from the client.
      if (player.moving) return;
      // No fighting FROM the water either — sanctuary cuts both ways, or a
      // swimmer could snipe shore monsters that can never reach back.
      if (player.swimming) return;
      const rm = radii.get(m.kind) ?? DEFAULT_MONSTER_RADIUS;
      const range = attackRange(PLAYER_BODY_RADIUS, rm);
      // A grace band past swing range: the circling must not flicker the
      // engagement off every time the pair drifts a few wu apart.
      const pdx = m.x - player.x;
      const pdy = m.y - player.y;
      const pdist = Math.hypot(pdx, pdy);
      if (pdist > range * 1.2) return;
      if (Math.abs(m.elev - player.elev) > 2) return;
      // THE BOXING SHUFFLE (maintainer: "both the player and the monster
      // should walk around each other"): a standing engaged fighter drifts
      // tangentially around its opponent with the SAME rotational sense as
      // the monster's orbit — the pair revolves about its midpoint. Ground-
      // validated per axis (never into water — the sanctuary — or off a
      // cliff); no `moving` flag, so the stance stays the fight idle. The
      // client needs no prediction: with no input pending, its predicted
      // position IS the synced one, and the render ease glides the 20Hz
      // steps.
      if (this.terrain) {
        const pin = 1 / (pdist || 1);
        const pux = pdx * pin; // player -> monster
        const puy = pdy * pin;
        const bctx = { maxClimb: WALK_CLIMB, canSwim: false };
        // OPPOSITE tangential to the monster's (its u points monster->player,
        // ours player->monster — same formula on mirrored vectors gives
        // PARALLEL strafing, the round-5 report): with the flip the pair
        // truly revolves about its midpoint like boxers.
        const bx = clamp(player.x - puy * m.orbitSign * ORBIT_SPEED_WU * dt, 1, this.worldW - 1);
        const by = clamp(player.y + pux * m.orbitSign * ORBIT_SPEED_WU * dt, 1, this.worldH - 1);
        if (canEnterElev(this.terrain, player.elev, player.x, player.y, bx, player.y, bctx).ok) player.x = bx;
        if (canEnterElev(this.terrain, player.elev, player.x, player.y, player.x, by, bctx).ok) player.y = by;
        player.elev = resolveElevAt(this.terrain, player.elev, player.x, player.y, bctx);
      }
      if (now < player.nextSwingAt) return;
      player.nextSwingAt = now + PLAYER_ATTACK_MS;
      player.action = "attack";
      player.actionSeq++;
      player.lastCombatAt = now;
      const face = faceDirWorld(player.x, player.y, m.x, m.y);
      if (face) player.dir = face;
      const dmg = damageRoll(playerAtk(player.level), idSalt(sid), player.actionSeq);
      m.hp = Math.max(0, m.hp - dmg);
      // Retaliation: hitting anything wakes it (passive kinds included) —
      // and a fight the PLAYER started is PROVOKED: the hunter paces its
      // victim and pins the flee slow on them until the escape line.
      if (!m.targetSid) {
        m.targetSid = sid;
        m.provoked = true;
        m.mstate = "chase";
        m.chaseOx = m.x; // the hunt's origin — MAX_CHASE_WU is measured from here
        m.chaseOy = m.y;
        m.tripActive = false;
        m.trip = null;
        m.returning = false;
      }
      if (m.hp <= 0) this.killMonster(player, m, now);
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
