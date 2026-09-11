import { Room, Client, ClientState } from "@colyseus/core";
import { Encoder, StateView, MapSchema } from "@colyseus/schema";
import { randomBytes } from "crypto";
import { bus } from "../bus.js";

// THE ENCODER BUFFER IS SIZED HERE, WHERE THE ROOM IS, not in index.ts: every
// room's encoder is allocated at setState from this static, and a test that
// builds its own Server never ran index.ts — so its rooms encoded into the 8 KB
// default, and the first patch after a join, which now carries the whole view
// (140 monsters for an unlimited test client), overflowed silently: fields
// arrived undefined on the client (kind agrees across clients — 2026-09-09).
// 64 KB clears every world with an order of magnitude of headroom.
Encoder.BUFFER_SIZE = 2 * 1024 * 1024;
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
  INTEREST_WU,
  INTEREST_LEAVE_WU,
  INTEREST_TICKS,
  INTEREST_BUCKET_WU,
  WHOLE_WORLD,
  zoneGrid,
  zoneAt,
  zoneRect,
  zoneNeighbours,
  distToRect,
  nearEdge,
  quantizePos,
  POS_Q_ZONE,
  POS_Q_WHOLE,
  MAX_INPUT_DT,
  INPUT_TIME_SLACK,
  stepMovement,
  TerrainGrid,
  buildTerrainGrid,
  deepCurrentAt,
  warmDeepCurrent,
  stampSceneryCollision,
  ISO_GEOMETRY_MAPS3,
  type SceneryBboxDoc,
  parseWorld,
  makeBlockedElev,
  resolveElevAt,
  levelAtWorld,
  makeSideBlocked,
  unstickFromSolids,
  surfaceAtWorld,
  surfaceAtWorldElev,
  FALL_DMG_MIN_LEVELS,
  fallDamageFrac,
  fallDurationS,
  PLAYER_SPEED_MIN,
  PLAYER_SPEED_MAX,
  PLAYER_SPEED_DEFAULT,
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
import { WorldState, Player, Monster, MonsterArea, GroundItem, OWNER_VIEW_TAG } from "../schema/WorldState.js";
import { ChessManager, chessBoardsFor, ChessBoardCfg } from "../chess.js";
import { monsterStatsFor, monsterRadiusFor, MonsterStats } from "../tuning.js";
import { onLiveChange, liveTuning, sceneryHitboxOverrides } from "../live.js";
import { AccountRecord, AccountStore, accountStore, resolveAccount } from "../account/store.js";
import type { ZoneGrid, Rect, ZoneCfg } from "@nangijala/shared";
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
  origin?: string; // the room that wrote it (a room skips its own publish)
}
/** The clock lives on the BUS (`clock:<world>`, spec/ZONES.md): every zone
 *  room of a world derives phaseT from the same deadline, and a change
 *  publishes the document to all of them. In one process with the fake bus
 *  this is exactly the per-process registry it replaces. */
const clockKey = (world: string) => `clock:${world}`;
const clockWorlds = new Set<string>();

/** HOW LONG A DROPPED SEAT IS HELD. Long enough to ride out a tunnel, short
 *  enough that a genuine disconnect frees the body before anyone wonders why it
 *  is standing there. The client gives up and reloads after six backoff retries
 *  (~30 s), so this covers the whole of its own recovery. */
const RECONNECT_GRACE_S = 45;

/** Tests share one process per file; clock persistence must not leak between them. */
export function resetWorldClocks() {
  for (const w of clockWorlds) void bus().del(clockKey(w));
  clockWorlds.clear();
}

/**
 * The single shared world. Every client that connects joins this same room, so
 * they all see each other. The server is authoritative: clients send input, the
 * server integrates positions on a fixed tick and syncs state to everyone.
 */
/** games2/config/scenery-bbox.json, read once. Built by
 *  scripts/build-scenery-bbox.py; the server cannot measure art itself and a
 *  scenery hitbox is in FRAME pixels, so the alpha bbox is what turns one into
 *  world cells. Missing file = no scenery collision, never a crash. */
let sceneryBboxCache: SceneryBboxDoc | null | undefined;
export function sceneryBbox(): SceneryBboxDoc | null {
  if (sceneryBboxCache !== undefined) return sceneryBboxCache;
  try {
    // ESM: no __dirname. Same resolution `assetsRoot` uses, one level in —
    // games2/config, which the image carries and the dev tree has in place.
    const gameRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    sceneryBboxCache = JSON.parse(
      readFileSync(join(gameRoot, "config", "scenery-bbox.json"), "utf8"),
    ) as SceneryBboxDoc;
  } catch {
    sceneryBboxCache = null;
    console.warn("[scenery] config/scenery-bbox.json missing — scenery blocks nothing");
  }
  return sceneryBboxCache;
}

// ZONES (spec/ZONES.md) — the wire shapes between zone rooms.
/** Ghosts reach GHOST_BAND_WU across a border: the interest rim, so a client
 *  standing on the line sees exactly as far into the neighbour as into home. */
const GHOST_BAND_WU = INTEREST_LEAVE_WU;
const EDGE_TICKS = 2; // edge snapshots at 10 Hz
const GHOST_TTL_MS = 1000; // a ghost outlives its owner's last snapshot this long
const HANDOFF_TTL_S = 10; // the hot state waits on the bus this long for the receiving join
const HANDOFF_TIMEOUT_MS = 10_000; // then the sending room forgets the attempt and keeps the body
const HANDOFF_INPUT_CREDIT_S = 2; // integration credit granted to a handed-over body for the inputs it buffered
const handoffKey = (world: string, pid: string) => `handoff:${world}:${pid}`;
/** ONE ROOM PER ZONE PER PROCESS. joinOrCreate races: while the first room
 *  of a zone is still in onCreate (the terrain load, ~1 s), a second join
 *  finds no room and creates another — measured with the load bot, two
 *  zone-11 rooms of 200 players each, two universes. The first room to
 *  finish onCreate owns the key; a later one is a DUPLICATE: locked (never
 *  matched again), and every body that lands in it is handed to the owner
 *  through the ordinary hand-off. index.ts warms every zone room at boot so
 *  the race has no window in normal play. */
const zoneRooms = new Map<string, string>();
export const zoneRoomKey = (world: string, zone: number) => `${world}:${zone}`;
export function zoneRoomIds(): Map<string, string> {
  return zoneRooms;
}

interface HotState {
  key: string;
  pid: string;
  from: number;
  name: string;
  character: string;
  accountId: string;
  rec: AccountRecord | null;
  mintedSecret?: string;
  x: number;
  y: number;
  elev: number;
  dir: string;
  level: number;
  xp: number;
  hp: number;
  ep: number;
  inv: { item: string; n: number }[];
  seq: number;
  torch: boolean;
  noAggro: boolean;
  lastHitAt: number;
  lastCombatAt: number;
  dirty: boolean;
}
interface MonsterXfer {
  kind: string; x: number; y: number; dir: string; moving: boolean; elev: number;
  hp: number; hpMax: number; mstate: string; actionSeq: number; level: number; aggro: number;
  areaId: string; home: number; orbitSign: number; provoked: boolean; returning: boolean;
  targetSid: string; chaseOx: number; chaseOy: number;
}
type CtlMessage =
  | { type: "handoff:done"; pid: string }
  | { type: "monster:xfer"; id: string; m: MonsterXfer }
  | { type: "monster:respawn"; areaId: string }
  | { type: "kick"; pid: string }
  // CROSS-BORDER COMBAT (spec/ZONES.md phase 5): the fight runs in the
  // MONSTER's room against the ghost player it already mirrors; what the
  // player's own room must show or keep travels home.
  | { type: "engage"; pid: string; id: string } // a ghost player (pid) targets my monster (id); "" clears
  | { type: "swing"; pid: string; dir: string } // the ghost swung: bump the real body's clip
  | { type: "hurt"; pid: string; dmg: number } // my monster hit the ghost: hurt the real body
  | { type: "reward"; pid: string; xp: number } // the ghost killed my monster
  | { type: "pickup"; pid: string; id: string } // a ghost player picks my drop (id)
  | { type: "give"; pid: string; item: string } // the pickup went through: stack it at home
  | { type: "noaggro"; pid: string }; // a neighbour's ghost switched "disable aggro" ON
interface EdgeSnapshot {
  from: number;
  t: number;
  players: Array<{
    id: string; name: string; character: string; x: number; y: number; dir: string; moving: boolean;
    running: boolean; elev: number; jumping: boolean; swimming: boolean; torch: boolean; level: number;
    hp: number; hpMax: number; dead: boolean; slow: number; action: string; actionSeq: number; hitSeq: number;
    noAggro: boolean;
  }>;
  monsters: Array<{
    id: string; kind: string; x: number; y: number; dir: string; moving: boolean; elev: number; hp: number;
    hpMax: number; mstate: string; actionSeq: number; level: number; aggro: number; tsid: string;
  }>;
  drops: Array<{ id: string; item: string; x: number; y: number; elev: number }>;
}

/** games2/config/zones.json: the zone grid per world, read once. A world
 *  without an entry runs as one room. */
let zonesConfig: Record<string, ZoneCfg> | null = null;
export function zonesConfigFor(world: string): ZoneCfg | null {
  if (!zonesConfig) {
    try {
      const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
      const raw = JSON.parse(readFileSync(join(root, "config", "zones.json"), "utf8")) as Record<string, unknown>;
      zonesConfig = {};
      for (const [k, v] of Object.entries(raw)) {
        const c = v as ZoneCfg;
        if (c && typeof c === "object" && Number.isInteger(c.cols) && Number.isInteger(c.rows) && c.cols >= 1 && c.rows >= 1)
          zonesConfig[k] = c;
      }
    } catch {
      zonesConfig = {};
    }
  }
  return zonesConfig[world] ?? null;
}
/** Tests: forget the cached file. */
export function resetZonesConfig(): void {
  zonesConfig = null;
}

/** ROOM STATS for the load bot (`/api/stats`, spec/ZONES.md phase 4): every
 *  room keeps the last TICK_RING tick durations; the endpoint reports p50/p95/
 *  max per room plus process CPU and event-loop lag, so a load run reads the
 *  server's own numbers instead of guessing from the client side. */
const TICK_RING = 200;
/** AN EMPTY ROOM TICKS ITS BRAINS SLOWER: with nobody connected, the sim
 *  (monster brains, combat, zones, interest) runs every IDLE_DIVISOR-th tick
 *  with the accumulated dt — 5 Hz at the 20 Hz tick. The clock still advances
 *  every tick (it is cheap and shared), edge snapshots keep flowing at the
 *  slower rate (a neighbour's client eases ghosts at rate 12 anyway).
 *  Measured: 16 warm rooms of the_game idled at ~20% of a core. */
const IDLE_DIVISOR = 4;
interface RoomStat {
  world: string;
  zone: number;
  clients: number;
  players: number;
  monsters: number;
  ghosts: number;
  ticks: number[];
  at: number;
  simTicks: number; // sim steps run (an idle room runs fewer than it ticks)
  bytesOut: number; // patch + message bytes sent to this room's clients since the last stats call
  bytesAt: number;
}
const roomStats = new Map<string, RoomStat>();
let cpuLast = process.cpuUsage();
let cpuLastAt = Date.now();
let loopLagMax = 0;
let loopLagSum = 0;
let loopLagN = 0;
{
  // Event-loop lag: a 100 ms timer that measures how late it fires.
  let expected = Date.now() + 100;
  const t = setInterval(() => {
    const lag = Math.max(0, Date.now() - expected);
    loopLagMax = Math.max(loopLagMax, lag);
    loopLagSum += lag;
    loopLagN++;
    expected = Date.now() + 100;
  }, 100);
  t.unref?.();
}
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
export function perfStats() {
  const now = Date.now();
  const cpu = process.cpuUsage(cpuLast);
  const wall = Math.max(1, now - cpuLastAt);
  cpuLast = process.cpuUsage();
  cpuLastAt = now;
  const rooms = [...roomStats.entries()]
    .filter(([, r]) => now - r.at < 5000)
    .map(([id, r]) => {
      const t = [...r.ticks].sort((a, b) => a - b);
      const secs = Math.max(0.001, (now - r.bytesAt) / 1000);
      const kbps = r.bytesOut / 1024 / secs; // KB/s to ALL clients of the room
      const out = {
        id, world: r.world, zone: r.zone, clients: r.clients, players: r.players, monsters: r.monsters, ghosts: r.ghosts,
        tickMs: { p50: +pct(t, 0.5).toFixed(2), p95: +pct(t, 0.95).toFixed(2), max: +(t[t.length - 1] ?? 0).toFixed(2), n: t.length },
        simHz: +(r.simTicks / secs).toFixed(1),
        outKBps: +kbps.toFixed(1),
        outKBpsPerClient: +(r.clients ? kbps / r.clients : 0).toFixed(2),
      };
      r.bytesOut = 0;
      r.simTicks = 0;
      r.bytesAt = now;
      return out;
    });
  const out = {
    at: now,
    cpuPct: +(((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(1), // of ONE core, since the last call
    loopLagMs: { mean: +(loopLagN ? loopLagSum / loopLagN : 0).toFixed(1), max: loopLagMax },
    rssMb: +(process.memoryUsage().rss / 1048576).toFixed(0),
    rooms,
    totals: { clients: rooms.reduce((a, r) => a + r.clients, 0), players: rooms.reduce((a, r) => a + r.players, 0), monsters: rooms.reduce((a, r) => a + r.monsters, 0) },
  };
  loopLagMax = 0;
  loopLagSum = 0;
  loopLagN = 0;
  return out;
}

export class WorldRoom extends Room<WorldState> {
  // A generous cap; a real deployment can shard once this fills.
  maxClients = 200;

  // The account of record. ONE store for the whole process, not one file per
  // world: progression is world-agnostic (your character IS the level) and
  // position is a field keyed by world inside the same document.
  private store: AccountStore = accountStore();

  // Per-room world state (NOT module-level — the server hosts many rooms, one
  // per selected world, and they can be different sizes / have different spawns).
  private terrain: TerrainGrid | null = null;
  /** Fingerprint of the scenery hitbox doc this room's collision was stamped
   *  from, so a live edit can be noticed — see restampSceneryFromLive. */
  private sceneryHbStamp = "";

  /** A HITBOX EDITED IN THE WIKI REACHES A ROOM THAT IS ALREADY RUNNING.
   *  Live docs refresh on push, so `sceneryHitboxOverrides()` goes current
   *  within seconds — but the collision grid is stamped ONCE when the room is
   *  built and never again, so the authority kept the old footprints while the
   *  client, which fetches the documents fresh, got the new ones. Two bodies
   *  disagreeing about where a tree stands is the divergence the single
   *  collision endpoint exists to prevent, so the room restamps and tells
   *  everyone to do the same. Cheap: only when the BOXES actually changed. */
  private async restampSceneryFromLive(): Promise<void> {
    const stamp = hitboxStamp();
    if (!stamp || stamp === this.sceneryHbStamp || !this.worldName) return;
    this.sceneryHbStamp = stamp;
    const w = await loadWorldGrid(this.worldName, stamp);
    if (!w.terrain) return; // open world, or the reload failed — keep what works
    this.terrain = w.terrain;
    console.log(`[scenery] hitboxes changed — restamped "${this.worldName}" collision`);
    this.broadcast("scenery:collision", { stamp });
  }
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
      // One room per world rolls the wild stars (zone 0, or the whole-world
      // room); every room broadcasts them.
      if (this.state.timeIdx === 0 && this.zoneId <= 0) this.publishEvent("star", {});
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
    const doc: WorldClock = {
      timeIdx: this.state.timeIdx,
      phaseT: this.state.phaseT,
      frozen: this.state.frozen,
      timeSpeed: this.state.timeSpeed,
      weather: this.state.weather,
      aurora: this.state.aurora,
      nextPhaseAt: this.nextPhaseAt,
      origin: this.roomId,
    };
    clockWorlds.add(this.worldName);
    const key = clockKey(this.worldName);
    void bus().set(key, JSON.stringify(doc));
    void bus().publish(key, doc);
  }

  /** Another room of this world moved the clock: adopt its document. Our own
   *  publish is skipped — applying a document one tick old would step phaseT
   *  backwards by a tick. */
  private applyClock(doc: WorldClock) {
    if (!doc || doc.origin === this.roomId) return;
    this.state.timeIdx = doc.timeIdx;
    this.state.phaseT = doc.phaseT;
    this.state.frozen = doc.frozen;
    this.state.timeSpeed = doc.timeSpeed ?? (doc.frozen ? 0 : 1);
    this.state.weather = doc.weather;
    this.state.aurora = doc.aurora;
    this.nextPhaseAt = doc.nextPhaseAt;
  }

  async onCreate(options?: {
    world?: string;
    phaseSeconds?: number[];
    auroraChance?: number;
    monsterCount?: number; // per-area monster cap override (default: each area's own `max`)
    monsterSeed?: number; // seed a deterministic PRNG for spawns/roam (tests)
    lootChance?: number; // TEST override: force every loot entry to this chance (1 = always drop)
    chessBoards?: ChessBoardCfg[]; // TEST override: boards for this room
    chessClockMs?: number; // TEST override: per-player bank (default 10 min)
    interestRadius?: number; // wu; 0 = the whole room (tests/QA only — never a client option)
    zone?: number; // the zone this room owns (spec/ZONES.md); absent = the whole world
    zonesCfg?: ZoneCfg; // TEST override: the zone grid for this world
  }) {
    if (typeof options?.interestRadius === "number" && isFinite(options.interestRadius)) {
      const r = Math.max(0, options.interestRadius);
      this.interestR = r === 0 ? Infinity : r;
      this.interestLeave = r === 0 ? Infinity : r * (INTEREST_LEAVE_WU / INTEREST_WU);
    }
    if (typeof options?.auroraChance === "number") this.auroraChance = options.auroraChance;
    if (typeof options?.monsterCount === "number")
      this.monsterCount = Math.max(0, Math.floor(options.monsterCount));
    if (typeof options?.monsterSeed === "number") this.monsterRng = mulberry32(options.monsterSeed);
    if (typeof options?.lootChance === "number") this.lootChance = clamp(options.lootChance, 0, 1);
    {
      // Load the maps2 world the client asked for (default the_game). Rooms are
      // matched by this name (filterBy in index.ts), so everyone who picks the
      // same world shares one room; different worlds get separate rooms.
      const world = (options?.world || DEFAULT_WORLD).replace(/[^a-z0-9_-]/gi, "");
      const w = await loadWorldGrid(world);
      this.terrain = w.terrain;
      this.worldSpawn = w.spawn;
      this.worldW = w.worldW;
      this.worldH = w.worldH;
      this.worldName = world;
      // ZONES: a world with a grid and a zone option becomes ONE zone room;
      // everything else (no config, no option, tests) is the whole-world room.
      const cfg = options?.zonesCfg ?? zonesConfigFor(world);
      const zone = typeof options?.zone === "number" && Number.isInteger(options.zone) ? options.zone : WHOLE_WORLD;
      if (cfg && this.terrain && zone >= 0 && zone < cfg.cols * cfg.rows) {
        this.grid = zoneGrid(cfg, this.terrain.width, this.terrain.height, CELL_WU);
        this.zoneId = zone;
        this.rect = zoneRect(this.grid, zone);
        this.idPrefix = `z${zone}:`;
      }
      if (this.zoneId !== WHOLE_WORLD) {
        const key = zoneRoomKey(world, this.zoneId);
        if (zoneRooms.has(key)) {
          this.duplicate = true;
          this.lock();
        } else {
          zoneRooms.set(key, this.roomId);
          this.autoDispose = false; // a zone room lives as long as the process
        }
      }
      this.setMetadata({ world, zone: this.zoneId, duplicate: this.duplicate });
      this.posOx = this.rect?.x0 ?? 0;
      this.posOy = this.rect?.y0 ?? 0;
      this.posQ = this.rect ? POS_Q_ZONE : POS_Q_WHOLE;
      // The maps2 spawn zones for THIS world (sidecar next to world.json),
      // resolved against the grid: which cells are truly standable/swimmable
      // at each zone's elev band. No grid (open world) → no monsters.
      this.zones = this.terrain ? await loadSpawnZones(world, this.terrain) : [];
      // A world absent from disk was STAGED (fetched from the repo) — say so,
      // with the two facts that decide whether the join is playable.
      if (!WORLD_ROOTS.some((r) => existsSync(join(assetsRoot(), r, world))))
        console.log(`[staging] world "${world}": terrain=${!!this.terrain} zones=${this.zones.length}`);
    }
    this.setState(new WorldState());
    this.state.ox = this.posOx;
    this.state.oy = this.posOy;
    this.state.pq = this.posQ;
    this.chan = {
      events: `world:${this.worldName}:events`,
      presence: `presence:${this.worldName}`,
      edge: (z: number) => `zone:${this.worldName}:${z}:edge`,
      ctl: (z: number) => `zone:${this.worldName}:${z}:ctl`,
    };
    // World-wide events (chat, the arrival star, level-ups) reach every room
    // of the world over the bus and each room broadcasts them to its clients.
    this.unsubs.push(
      bus().subscribe(this.chan.events, (m: { type: string; data: unknown }) => {
        if (m && typeof m.type === "string") this.broadcast(m.type, m.data);
      }),
    );
    if (this.zoneId !== WHOLE_WORLD && this.grid) {
      for (const n of zoneNeighbours(this.grid, this.zoneId))
        this.unsubs.push(bus().subscribe(this.chan.edge(n), (m: EdgeSnapshot) => this.onEdgeSnapshot(m)));
      this.unsubs.push(bus().subscribe(this.chan.ctl(this.zoneId), (m: CtlMessage) => this.onCtl(m)));
    }
    // Live tuning (live/tuning/* on GitHub main, held by the live store):
    // push every change to all clients over the room's own WebSocket, and
    // hand joiners the current state (see live.ts / live/README.md).
    this.offLive = onLiveChange((tuning) => {
      this.broadcast("live:update", tuning);
      void this.restampSceneryFromLive();
    });
    this.sceneryHbStamp = hitboxStamp();
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
      const player = this.playerOf(client);
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
          // THE PLAYER-SPEED DIAL, clamped here because this is the authority.
          // It rides per input rather than sitting in room state so the
          // client's replay of its pending buffer integrates each window under
          // the number that window was sent with — see InputMessage.sm.
          sm: clamp(
            Number.isFinite(message.sm as number) ? (message.sm as number) : PLAYER_SPEED_DEFAULT,
            PLAYER_SPEED_MIN,
            PLAYER_SPEED_MAX,
          ),
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
      const player = this.playerOf(client);
      if (player) player.torch = !!message?.on;
    });

    /** "Did you just give me an account?" Asked by every client right after it
     *  registers its handlers; answered only for a join that actually minted
     *  one, and once — the pair is dropped from memory as it goes out. */
    this.onMessage("account:want", (client) => {
      const p = this.playerOf(client);
      if (!p?.mintedSecret) return;
      client.send("account", { id: p.accountId, secret: p.mintedSecret });
      p.mintedSecret = "";
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
      const pid = this.pidOf(client);
      if (on) this.noAggro.add(pid);
      else this.noAggro.delete(pid);
      if (!on) return;
      const now = Date.now();
      /* MY OWN SWORD MARK GOES WITH IT. `marked` (player.target === the
       * monster's id) is this switch's ONE bypass, so a mark left standing
       * keeps that monster hunting through the switch and re-takes it the
       * moment the release below lets go. Switching the ambush off IS "I am
       * not fighting anything". */
      const me = this.state.players.get(pid);
      if (me) this.clearMark(me, pid);
      this.releaseHunts(pid, now);
      this.releaseHuntsNextDoor(pid);
    });

    // Respawn: send the player back to a fresh spawn point (settings button /
    // stuck recovery). Clear queued movement + any jump so they don't drift off
    // spawn; the client snaps to the teleport (its >2-cell jump threshold).
    this.onMessage("respawn", (client) => {
      const player = this.playerOf(client);
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
      const player = this.playerOf(client);
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
      const player = this.playerOf(client);
      if (!player || player.dead) return;
      const id = typeof message?.id === "string" ? message.id : "";
      const pid = this.pidOf(client);
      if (!id) {
        // With the ambush switch on, dropping the mark means nothing is
        // hunting me: a chase the mark itself started must not outlive it.
        if (this.clearMark(player, pid) && this.noAggro.has(pid)) {
          this.releaseHunts(pid, Date.now());
          this.releaseHuntsNextDoor(pid);
        }
        return;
      }
      const m = this.state.monsters.get(id);
      if (!m) {
        // A GHOST monster: the fight runs in its owner's room against the
        // ghost of this player that room already mirrors (spec/ZONES.md).
        const owner = this.ghostOwner.get(id);
        const gm = this.state.ghostMonsters.get(id);
        if (owner === undefined || !gm || gm.mstate === "die") return;
        player.target = id;
        void bus().publish(this.chan.ctl(owner), { type: "engage", pid, id } satisfies CtlMessage);
        return;
      }
      if (m.mstate === "die") return;
      player.target = id;
    });

    // PICK UP a ground item. Range-validated server-side; the pickup clip is
    // signalled through action/actionSeq so every client sees the crouch.
    this.onMessage("pickup", (client, message: { id?: string }) => {
      const player = this.playerOf(client);
      const id = typeof message?.id === "string" ? message.id : "";
      const drop = this.state.drops.get(id);
      if (!drop && this.state.ghostDrops.has(id)) {
        const owner = this.ghostOwner.get(id);
        if (owner !== undefined)
          void bus().publish(this.chan.ctl(owner), { type: "pickup", pid: this.pidOf(client), id } satisfies CtlMessage);
        return;
      }
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
      const player = this.playerOf(client);
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
      player.dirty = true;
      for (let i = 0; i < want; i++) this.spawnDrop(item, player.x, player.y, player.elev);
      client.send("inv", { items: player.inv });
    });

    // Teleport: drop the player at an EXACT world coordinate (debug tool —
    // reproduce a spot from a screenshot). Unlike respawn it does NOT snap to a
    // standable spawn; it places precisely where asked (clamped to world bounds)
    // so a reported bug at a known (x,y) can be re-observed. Clears queued
    // movement + jump so they hold the mark; client snaps via its jump threshold.
    // DEBUG: move a monster (same standing as "teleport"; the zone gates use
    // it to walk a monster over a border without waiting for its roam).
    this.onMessage("dbgmonster", (client, message: { id?: string; x?: number; y?: number; pin?: boolean }) => {
      const m = typeof message?.id === "string" ? this.state.monsters.get(message.id) : undefined;
      if (!m || m.mstate === "die") return;
      if (typeof message.x === "number" && isFinite(message.x)) m.x = message.x;
      if (typeof message.y === "number" && isFinite(message.y)) m.y = message.y;
      if (this.terrain) m.elev = levelAtWorld(this.terrain, m.x, m.y);
      m.pinned = !!message.pin;
      m.trip = null;
      m.tripActive = false;
      m.nextMoveAt = Date.now() + 500;
    });

    this.onMessage("teleport", (client, message: { x?: number; y?: number }) => {
      const player = this.playerOf(client);
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
      this.fallPend.delete(player.pid); // an ASSIGNED elevation ends the fall it was in
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
    const savedRaw = await bus().get(clockKey(this.worldName));
    const saved: WorldClock | null = savedRaw ? (JSON.parse(savedRaw) as WorldClock) : null;
    this.unsubs.push(bus().subscribe(clockKey(this.worldName), (doc: WorldClock) => this.applyClock(doc)));
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
      const player = this.playerOf(client);
      if (!player) return;
      const text = sanitizeChat(message?.text);
      if (!text) return;
      const now = Date.now();
      if (now - player.lastChatAt < CHAT_MIN_INTERVAL_MS) return; // rate limit
      player.lastChatAt = now;
      const out: ChatBroadcast = { id: this.pidOf(client), name: player.name, text };
      this.publishEvent("chat", out);
    });

    // Seed the roaming monsters from the maps2 spawn zones. Only meaningful
    // when a terrain grid is loaded (zones resolve against it).
    this.seedMonsters();

    const dtMs = 1000 / TICK_RATE;
    this.setSimulationInterval((delta) => {
      const t0 = performance.now();
      this.update(delta / 1000);
      this.recordTick(performance.now() - t0);
    }, dtMs);

    // CHESS boards for this world (config, live-overridable; tests inject).
    this.chess = new ChessManager(
      this.state,
      options?.chessClockMs ?? 10 * 60 * 1000,
      () => Date.now(),
      (fn, ms) => this.clock.setTimeout(fn, ms),
    );
    this.chess.addBoards(chessBoardsFor(this.worldName, options?.chessBoards));
    this.onMessage("chess.sit", (client) => this.chess.sit(this.pidOf(client)));
    this.onMessage("chess.dice", (client, msg: { m?: string }) => {
      if (typeof msg?.m === "string") this.chess.throwDice(msg.m, this.pidOf(client));
    });
    this.onMessage("chess.move", (client, msg: { m?: string; mv?: string }) => {
      if (typeof msg?.m === "string" && typeof msg?.mv === "string")
        this.chess.move(msg.m, this.pidOf(client), msg.mv);
    });
    this.onMessage("chess.resign", (client, msg: { m?: string }) => {
      if (typeof msg?.m === "string") this.chess.resign(msg.m, this.pidOf(client));
    });
    this.onMessage("chess.close", (client, msg: { m?: string }) => {
      if (typeof msg?.m === "string") this.chess.dismiss(msg.m, this.pidOf(client));
    });
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
      const cells = this.ownCells(z);
      const count = Math.min(this.zoneShare(z, this.monsterCount ?? z.zone.num), cells.length);
      const r = monsterRadiusFor(z.zone.monster, radii.get(z.zone.monster), DEFAULT_MONSTER_RADIUS);
      const placed: Array<{ x: number; y: number }> = [];
      for (let n = 0; n < count; n++) {
        const m = new Monster();
        m.kind = z.zone.monster;
        m.areaId = z.zone.id;
        // Radius-aware seeding (v2): try a handful of cells for one clear of
        // the zone-mates already placed — a pair must not START stacked (the
        // maintainer's screenshot was two mammoths seeded onto one spot).
        // Small/crowded zones fall back to the most-spaced attempt.
        let cell = cells[Math.floor(this.monsterRng() * cells.length)];
        let bestD = -Infinity;
        for (let t = 0; t < 10; t++) {
          const cand = cells[Math.floor(this.monsterRng() * cells.length)];
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
        const mid = `${this.idPrefix}${z.zone.id}#${n}`;
        m.home = this.zoneId;
        m.orbitSign = idSalt(mid) & 1 ? 1 : -1; // circling handedness varies per monster
        this.syncPos(m);
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
    this.fallPend.delete(player.pid); // an ASSIGNED elevation ends the fall it was in
  }

  /** Sessions this room ejected on purpose (the one-token-one-session rule).
   *  They leave for good; only a DROPPED link gets its seat held. */
  private kicked = new Set<string>();

  /** INTEREST MANAGEMENT (spec/ZONES.md). Every client owns a StateView and
   *  receives only the players, monsters and drops within `interestR` of its
   *  own player; `interestLeave` is the hysteresis rim; `seen` is what each
   *  view holds right now (the view's own sets are WeakSets, not iterable).
   *  Infinity = the whole room (tests, QA). */
  private interestR = INTEREST_WU;
  private interestLeave = INTEREST_LEAVE_WU;
  private interestTick = 0;
  private seen = new Map<string, Set<object>>();

  /** Give a joiner its view with its own player in it — BEFORE the join
   *  snapshot is encoded (Colyseus sends the full state after onJoin resolves),
   *  so "me" is in the first patch and the client never waits a pass for it. */
  private attachView(client: Client, player: Player) {
    const view = new StateView();
    client.view = view;
    // Count every byte this room sends the client (patches and messages) for
    // /api/stats — the per-client bandwidth is what a phone on mobile data
    // pays, and what the position encoding is measured on.
    const raw = client.raw.bind(client);
    const roomId = this.roomId;
    client.raw = (data: any, ...rest: any[]) => {
      const r = roomStats.get(roomId);
      if (r) r.bytesOut += data?.length ?? data?.byteLength ?? 0;
      return raw(data, ...rest);
    };
    view.add(player);
    view.add(player, OWNER_VIEW_TAG); // the ack and the prediction fields: mine alone
    this.seen.set(client.sessionId, new Set([player]));
  }

  /** Recompute every client's view from distance. Entities are bucketed once
   *  (O(E)), each client queries the buckets its rim can reach (49 at most),
   *  so a room of 200 players and 300 monsters costs ~10k distance tests per
   *  pass at INTEREST_TICKS — never E x C per tick. An entity that left the
   *  state (death, pickup, leave) was already DELETEd to every view that held
   *  it by the encoder; it is dropped from `seen` without a view call. */
  private stepInterest() {
    type Ent = { e: object; x: number; y: number };
    const all: Ent[] = [];
    this.state.players.forEach((p) => all.push({ e: p, x: p.x, y: p.y }));
    this.state.monsters.forEach((m) => all.push({ e: m, x: m.x, y: m.y }));
    this.state.drops.forEach((g) => all.push({ e: g, x: g.x, y: g.y }));
    this.state.ghosts.forEach((p) => all.push({ e: p, x: p.x, y: p.y }));
    this.state.ghostMonsters.forEach((m) => all.push({ e: m, x: m.x, y: m.y }));
    this.state.ghostDrops.forEach((g) => all.push({ e: g, x: g.x, y: g.y }));
    const live = new Set<object>(all.map((a) => a.e));
    const R = this.interestR;
    const L = this.interestLeave;
    const unlimited = !isFinite(R);
    const B = INTEREST_BUCKET_WU;
    const buckets = new Map<number, Ent[]>();
    const key = (bx: number, by: number) => bx * 1_000_003 + by;
    if (!unlimited) {
      for (const a of all) {
        const k = key(Math.floor(a.x / B), Math.floor(a.y / B));
        const b = buckets.get(k);
        if (b) b.push(a);
        else buckets.set(k, [a]);
      }
    }
    const reach = Math.ceil(L / B);
    for (const client of this.clients) {
      const view = client.view;
      const me = this.playerOf(client);
      if (!view || !me) continue;
      const had = this.seen.get(client.sessionId) ?? new Set<object>();
      const keep = new Set<object>([me]);
      const consider = (a: Ent) => {
        if (a.e === me) return;
        const d = Math.max(Math.abs(a.x - me.x), Math.abs(a.y - me.y));
        if (had.has(a.e) ? d <= L : d <= R) keep.add(a.e);
      };
      if (unlimited) for (const a of all) consider(a);
      else {
        const bx0 = Math.floor(me.x / B);
        const by0 = Math.floor(me.y / B);
        for (let bx = bx0 - reach; bx <= bx0 + reach; bx++)
          for (let by = by0 - reach; by <= by0 + reach; by++) {
            const b = buckets.get(key(bx, by));
            if (b) for (const a of b) consider(a);
          }
      }
      for (const e of had) if (!keep.has(e) && live.has(e)) view.remove(e as any);
      for (const e of keep) if (!had.has(e)) view.add(e as any);
      this.seen.set(client.sessionId, keep);
    }
  }

  async onJoin(client: Client, options: JoinOptions = {}) {
    // A HAND-OFF from another zone room (spec/ZONES.md): the hot state comes
    // off the bus, not the database, and the body keeps its stable id. It is
    // the SAME client, which already holds the live tuning: the 85 KB
    // `live:update` is not resent (measured: it was most of what the hop
    // waited for behind a busy phone frame).
    const hot = await this.takeHandoff(options);
    if (hot) {
      if (typeof options.t0 === "number") console.log(`[zones] hand-off onJoin for ${hot.pid} into zone ${this.zoneId}: +${Date.now() - options.t0} ms after zone:go`);
      return this.joinHandedOff(client, hot);
    }
    // Current live tuning straight to the joiner (updates arrive as broadcasts).
    client.send("live:update", liveTuning());
    const player = new Player();
    player.name = (options.name || `wanderer-${client.sessionId.slice(0, 4)}`).slice(0, 24);
    player.character = options.character || "";

    // THE ACCOUNT. A first-time player presents nothing and is GIVEN one right
    // here, on the join call the client already makes — no screen, no extra
    // tap, no step added to the one that gets someone into the world.
    const acc = await resolveAccount(this.store, options.account, player.name, player.character);
    player.accountId = acc.id;
    player.rec = acc.rec;
    // NOT pushed here — see Player.mintedSecret. The client asks once it is
    // listening, which is the only ordering that cannot drop the pair.
    player.mintedSecret = acc.secret ?? "";

    // ONE live session per account (RO kicks the older login): a second tab on
    // the same browser shares the localStorage pair, and two live sessions on
    // one account document dup/eat items on last-writer-wins saves. The
    // newcomer takes over the LIVE progression (fresher than the store) and
    // the old session is disconnected.
    if (player.accountId) {
      // In this room first (no bus round trip, and the presence hash may be
      // a tick behind), then world-wide through presence.
      let oldPid = "";
      this.state.players.forEach((p: Player, pid: string) => {
        if (!oldPid && p.accountId === player.accountId && pid !== client.sessionId) oldPid = pid;
      });
      if (oldPid) this.kickPid(oldPid);
      await this.kickOtherSession(player.accountId, client.sessionId);
    }

    // Returning player? Restore where they stood IN THIS WORLD
    // (server-authoritative), but rescue anyone whose saved spot is now
    // blocked (terrain can change).
    const spot = acc.rec.pos?.[this.worldName];
    /* A saved spot on a DECK is a legal spot: the base under a cave lid is the
     * cave floor and under a bridge the water, so "standable at the base"
     * alone sent a lid-walker to the spawn or, worse, restored him INTO the
     * cave (maintainer 2026-09-09: "if I log out and back in again I get
     * teleported to inside the cave"). */
    const deckUnderSpot = (s: { x: number; y: number }): boolean => {
      const t = this.terrain;
      if (!t) return false;
      const c = Math.floor(s.x / CELL_WU);
      const r = Math.floor(s.y / CELL_WU);
      return c >= 0 && r >= 0 && c < t.width && r < t.height && t.deck[r * t.width + c] >= 0;
    };
    if (spot && (!this.terrain || isStandableAtWorld(this.terrain, spot.x, spot.y) || deckUnderSpot(spot))) {
      // Returning player: restore their last position ON THE SURFACE THEY LEFT
      // FROM — the saved elev, resolved against today's terrain (a spot that
      // lost its deck falls back to the base; one without a saved elev too).
      player.x = spot.x;
      player.y = spot.y;
      player.elev = this.terrain
        ? resolveElevAt(
            this.terrain,
            spot.elev ?? levelAtWorld(this.terrain, player.x, player.y),
            player.x,
            player.y,
            { maxClimb: WALK_CLIMB, canSwim: true },
          )
        : 0;
    } else {
      this.placeAtSpawn(player);
    }
    // Progression survives relogs (RO: your character IS the level) and is
    // WORLD-AGNOSTIC — one account document, with position the only field
    // keyed by world, so switching worlds can never fork the character.
    player.level = Math.min(LEVEL_CAP, Math.max(1, acc.rec.level || 1));
    player.xp = Math.max(0, acc.rec.xp || 0);
    player.hpMax = hpMaxFor(player.level);
    player.epMax = epMaxFor(player.level);
    // Never restore a corpse: a save written at 0 hp comes back at 1 (limping,
    // not dead — dying logs you out at the spawn next tick otherwise). A
    // brand-new account stores 0 and takes full pools from the level curve.
    player.hp = acc.rec.hp > 0 ? Math.min(player.hpMax, Math.max(1, acc.rec.hp)) : player.hpMax;
    player.ep = acc.rec.ep > 0 ? Math.min(player.epMax, Math.max(0, acc.rec.ep)) : player.epMax;
    player.inv = Array.isArray(acc.rec.inv)
      ? acc.rec.inv
          .filter((s) => s && typeof s.item === "string" && typeof s.n === "number" && s.n > 0)
          .map((s) => ({ item: s.item, n: Math.min(INV_MAX_STACK, Math.floor(s.n)) }))
          .slice(0, INV_MAX_SLOTS)
      : [];
    // onJoin AWAITS A DATABASE READ NOW, and a phone can drop the link inside
    // that window. onLeave would then find no player, delete nothing, and this
    // line would add a body no client owns and nothing ever removes — a ghost
    // that walks nowhere and never leaves. Cheap to check, impossible to spot
    // in production if we do not.
    if (client.state === ClientState.LEAVING || client.state === ClientState.CLOSED) {
      this.savePlayer(player); // they still earned whatever the account arrived with
      return;
    }
    this.adoptPlayer(client, client.sessionId, player, !!options.noAggro);
    // The backpack is PRIVATE — targeted message, never schema-synced.
    client.send("inv", { items: player.inv });
    // Every arrival in Nangijala is announced by a shooting star crossing
    // the sky — the same streak for every player in the world.
    this.publishEvent("star", { name: player.name });
  }

  /** A DROPPED LINK IS NOT A DEPARTURE — the seat is held open (2026-09-04,
   *  the maintainer on a train: "the player was flying around like I don't know
   *  what... the network connection goes up/down all the time").
   *
   *  Without this, every blip destroyed the player entity. The server's x/y
   *  freeze at the last ACKED input the moment the socket dies, the client keeps
   *  predicting and you keep walking on screen, and the rejoin then built a
   *  BRAND NEW player anchored back at the frozen position while the client
   *  threw away every unacked input. So each blip snapped him back to wherever
   *  the link died — and on a train that is every few seconds, which is the
   *  flying. His eight screenshots are all places he had just been.
   *
   *  Holding the seat means the reconnecting client reclaims the SAME session:
   *  the entity, its position, its inventory and its unacked inputs all
   *  survive, and nothing is restored from the store at all. A CONSENTED leave
   *  (the player really left) is unaffected and cleans up at once. */
  async onLeave(client: Client, consented?: boolean) {
    const pid = this.pidOf(client);
    if (this.handed.delete(client.sessionId)) {
      // Handed to another zone: that room owns the body now — nothing to
      // save, no seat to hold.
      this.sidPid.delete(client.sessionId);
      this.pidSid.delete(pid);
      this.seen.delete(client.sessionId);
      return;
    }
    const player = this.playerOf(client);
    // Flush first: if the grace expires we must not have lost the session.
    if (player) this.savePlayer(player);
    const wasKicked = this.kicked.delete(client.sessionId);
    if (!consented && !wasKicked && player) {
      /* THE PARKED SEAT IS CANCELLABLE, and it has to be. A dropped link waits
       * here with the BODY STILL IN STATE, which is right for a reconnect and
       * wrong for a second login: the newcomer's kick could not reach a client
       * that is no longer in `this.clients`, so his old body stood at the spawn
       * spot beside him for the whole grace (maintainer 2026-09-10: "sometimes
       * when I login I see another version of myself at the exact same spot I
       * was spawned at"). Keeping the deferred lets `kickPid` reject it, which
       * lands in the catch below and runs the ONE removal path there is —
       * rather than a second copy of it, which would drift. */
      const grace = this.allowReconnection(client, RECONNECT_GRACE_S);
      this.reconnects.set(client.sessionId, grace);
      try {
        await grace;
        return; // reclaimed — the body never moved and nothing was rebuilt
      } catch {
        /* the grace ran out, the room is shutting down, or a newcomer on this
         * account rejected it: fall through and drop the body */
      } finally {
        this.reconnects.delete(client.sessionId);
      }
    }
    this.state.players.delete(pid);
    this.fallPend.delete(pid);
    this.seen.delete(client.sessionId);
    this.sidPid.delete(client.sessionId);
    this.pidSid.delete(pid);
    if (player?.accountId) {
      // Only MY presence: a newcomer on the same account has overwritten it.
      const acc = player.accountId;
      void bus()
        .hget(this.chan.presence, acc)
        .then((raw) => {
          if (raw && (JSON.parse(raw) as { pid?: string }).pid === pid) return bus().hdel(this.chan.presence, acc);
        })
        .catch(() => {});
    }
    // Session ids are not reused, so a stale entry would leak for the room's
    // lifetime and silently pacify whoever inherited the id.
    this.noAggro.delete(pid);
    this.chess?.onPlayerLeave(pid);
  }

  /** Persist one player into their account document. Called on leave, death,
   * level-up and the periodic flush of DIRTY players — onLeave-only
   * persistence meant a crash ate every connected player's session gains.
   *
   * FIRE AND FORGET, on purpose: a durable write must never be awaited inside
   * the 20Hz loop. The store this replaces was worse than slow — it was
   * `writeFileSync(JSON.stringify(every player ever seen))`, once per player,
   * synchronously, which stalled the tick outright.
   *
   * It REWRITES the held document rather than building a fresh one: the room
   * has no idea what secretHash, createdAt or another world's position are,
   * and a rebuild would silently drop all three. */
  private savePlayer(player: Player) {
    const rec = player.rec;
    if (!player.accountId || !rec) return;
    player.dirty = false;
    rec.name = player.name;
    rec.character = player.character;
    rec.level = player.level;
    rec.xp = player.xp;
    rec.hp = player.hp;
    rec.ep = player.ep;
    // COPY, never alias: a live Player.inv sharing the stored array is the bug
    // that silently corrupted saves in the store this replaces.
    rec.inv = player.inv.map((s) => ({ item: s.item, n: s.n }));
    if (this.worldName) rec.pos[this.worldName] = { x: player.x, y: player.y, elev: player.elev };
    void this.store
      .save(player.accountId, rec)
      .catch((e) => console.error(`[account] save failed for ${player.accountId}:`, e));
  }

  private update(dt: number) {
    // Chess seating scan at ~4Hz (20Hz sim / 5) — distance math over a
    // handful of boards; the manager is quiet when nothing is happening.
    if (this.chess && ++this.chessTick >= 5) { this.chessTick = 0; this.chess.tick(); }
    // World clock: phase deadline checked here (see nextPhaseAt note); the
    // synced phaseT sweeps continuously between rollovers.
    if (this.nextPhaseAt !== null) {
      const now = Date.now();
      if (now >= this.nextPhaseAt) this.advanceTime();
      else this.state.phaseT = Math.min(1, Math.max(0, 1 - (this.nextPhaseAt - now) / this.effPhaseMs()));
    }

    // AN EMPTY ROOM runs the sim every IDLE_DIVISOR-th tick with the dt it
    // skipped (the clock above still moved every tick).
    if (this.clients.length === 0) {
      this.idleDt += dt;
      if (++this.idleTick < IDLE_DIVISOR) return;
      dt = this.idleDt;
    }
    this.idleTick = 0;
    this.idleDt = 0;
    const rs = roomStats.get(this.roomId);
    if (rs) rs.simTicks++;

    const now = Date.now();
    // Who is being HUNTED by a monster they provoked? Those players carry the
    // persistent flee slow until the escape line is crossed (the hunter
    // disengages) — one monster pass here, consumed in the player loop below.
    const hunted = new Set<string>();
    this.state.monsters.forEach((m: Monster) => {
      if (m.provoked && m.targetSid && (m.mstate === "chase" || m.mstate === "combat"))
        hunted.add(m.targetSid);
    });
    // A fall that has reached the ground bills FIRST — before the input that
    // follows it — so the flinch and the death land on the frame of impact.
    this.settleFalls(now);
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
          const u = unstickFromSolids(terrain, player.x, player.y, 80 * eff, undefined, player.elev);
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
            surf.speed * (jumping ? JUMP_SPEED_FACTOR : 1) * player.slow * (inp.sm ?? PLAYER_SPEED_DEFAULT),
            true, // iso world → input is screen-relative (Up walks up on screen)
            this.worldW,
            this.worldH,
            makeSideBlocked(terrain, ctx, () => player.elev), // corner probes: solids only (no ledge-wedging)
          );
        } else {
          // No map (the open-world fallback): still the player's own dial.
          r = stepMovement(
            player.x, player.y, inp.ax, inp.ay, inp.running, eff,
            undefined, inp.sm ?? PLAYER_SPEED_DEFAULT,
          );
        }
        /* THE DEEP-SEA CURRENT. Integrated as a SECOND ordinary move rather
         * than added to the position, so terrain still collides and the sea can
         * never push a body through a wall or onto a cliff. `speed` here is a
         * scale on WALK_SPEED, which is how stepMovement takes it. The client
         * predicts with the identical call — a current only one side applied
         * would rubber-band every swimmer. */
        if (terrain) {
          const cur = deepCurrentAt(terrain, r.x, r.y);
          if (cur) {
            const ctxC = { maxClimb: jumping ? JUMP_CLIMB : WALK_CLIMB, canSwim: true };
            r = stepMovement(
              r.x, r.y, cur.dx, cur.dy, false, eff,
              makeBlockedElev(terrain, ctxC, () => player.elev),
              cur.speed / WALK_SPEED,
              false, // already a WORLD-space direction, not screen-relative
              this.worldW, this.worldH,
              makeSideBlocked(terrain, ctxC, () => player.elev),
            );
          }
        }
        player.x = r.x;
        player.y = r.y;
        // Update the surface elevation the player now stands on (deck vs base).
        if (terrain) {
          const ctx2 = { maxClimb: jumping ? JUMP_CLIMB : WALK_CLIMB, canSwim: true };
          const elevBefore = player.elev;
          player.elev = resolveElevAt(terrain, player.elev, player.x, player.y, ctx2);
          // FALL DAMAGE (maintainer 2026-08-12): a drop of FALL_DMG_MIN_LEVELS+
          // costs fallDamageFrac of MAX hp — the house roof 10%, the_island2's
          // summit 95%, higher is death from full health. Landing in swimmable
          // WATER is a dive, not a fall. This sits on the INPUT integration
          // only, so teleport/respawn/join (which assign elev directly) can
          // never bill their elevation change as a fall. Routed navigation
          // refuses these drops outright (stepReach) — a damaging fall can
          // only be the player's own input walking off the edge.
          //
          // BILLED ON IMPACT, NOT ON THE STEP OFF. The whole drop resolves in
          // ONE tick, but the body is drawn falling for `fallDurationS` of it
          // — so taking the hp here emptied the bar, played the flinch and
          // started the death animation in mid-air (maintainer 2026-09-11:
          // "when I fall down a cliff I should take fall damage when I hit the
          // ground and not when I start falling"). The hit is scheduled and
          // `settleFalls` lands it. A second cliff caught mid-fall adds to the
          // pending hit and pushes it out to ITS own landing.
          const drop = elevBefore - player.elev;
          if (drop >= FALL_DMG_MIN_LEVELS && !player.dead) {
            const landing = surfaceAtWorldElev(terrain, player.x, player.y, player.elev);
            if (!landing.swimmable) {
              const dmg = Math.round(fallDamageFrac(drop) * player.hpMax);
              if (dmg > 0) {
                const pend = this.fallPend.get(id);
                this.fallPend.set(id, {
                  dmg: (pend?.dmg ?? 0) + dmg,
                  at: now + Math.round(fallDurationS(drop, this.storeyPx) * 1000),
                });
              }
            }
          }
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
        // A HARMFUL liquid (lava) drains `harm` HP per second while you swim
        // in it — accumulated and landed whole through hurtPlayer once a
        // second, so it flinches, slows and kills like any hit.
        if (player.swimming && surf.harm && !player.dead) {
          const acc = (this.harmAcc.get(id) ?? 0) + surf.harm * dt;
          const dmg = Math.floor(acc);
          this.harmAcc.set(id, acc - dmg);
          if (dmg > 0) this.hurtPlayer(player, dmg, now);
        } else if (this.harmAcc.has(id)) this.harmAcc.delete(id);
      }
    });

    // Roaming monsters are integrated AFTER players, on the same tick, sharing
    // none of the player state (separate MapSchema) — they can't collide-break
    // player movement.
    this.stepMonsters(dt, now);
    this.stepCombat(dt, now);
    if (this.zoneId !== WHOLE_WORLD) this.stepZones(now);
    if (++this.interestTick >= INTEREST_TICKS) {
      this.interestTick = 0;
      this.stepInterest();
    }
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
      // The tuned shadow IS the hit box when the Game Master has placed one
      // (wiki shadow editor); the art-measured manifest radius otherwise.
      ({ id, m }) => ({ id, x: m.x, y: m.y, r: monsterRadiusFor(m.kind, radii.get(m.kind), DEFAULT_MONSTER_RADIUS) }),
    );
    this.state.players.forEach((p: Player, sid: string) =>
      bodies.push({ id: `p:${sid}`, x: p.x, y: p.y, r: PLAYER_BODY_RADIUS }),
    );
    // ONE POSITION DEFINITION. (m.x, m.y) is the monster's position, and where
    // the Game Master has tuned a shadow that point IS the shadow centre — the
    // client draws the ellipse there and hangs the sprite off it by the facet
    // offset. Zone membership, the snap-back target, elevation, surface speed,
    // the loot drop and every distance in this file read that same point;
    // nothing in the sim uses an art-derived feet anchor. Membership stays
    // CENTRE-only: making it radius-aware would shrink every zone polygon by
    // each monster's body radius (edge cells would stop being spawnable/
    // walkable), which is a world-wide change nobody asked for — a wide body's
    // shadow may overhang the rim.
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
      // A debug-pinned monster (dbgmonster {pin}) stands where it was put
      // while roaming — no trip, no snap-back — but fights like any other.
      if (m.pinned && !m.targetSid) {
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
        const tp = this.bodyOf(m.targetSid);
        if (!tp || tp.dead) this.disengageMonster(m, zone, now);
      }
      if (m.mstate === "chase" || m.mstate === "combat") {
        const tp = this.bodyOf(m.targetSid);
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
            this.hurtBody(tp, damageRoll(stats.damage, idSalt(m.areaId), m.actionSeq), now);
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
            makeSideBlocked(grid, ctx, () => m.elev),
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
        const consider = (p: Player, sid: string, ghost: boolean) => {
          if (p.dead || p.swimming || Math.abs(p.elev - m.elev) > 2) return; // water = sanctuary
          const marked = p.target === id;
          // "Disable aggro" (Settings): this player is invisible to UNPROVOKED
          // aggro. Marking a monster with the sword still provokes it — the
          // switch removes the ambush, not the fight.
          if (!marked && (ghost ? p.ghostNoAggro : this.noAggro.has(sid))) return;
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
        };
        this.state.players.forEach((p, sid) => consider(p, sid, false));
        // A neighbour zone's player standing in the band is prey too; hits
        // and the hunt travel to its home room (spec/ZONES.md phase 5).
        this.state.ghosts.forEach((p, pid) => consider(p, pid, true));
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
        makeSideBlocked(grid, ctx, () => m.elev),
      );
      m.x = r.x;
      m.y = r.y;
      if (r.dir) m.dir = r.dir;
      m.moving = r.moving;
      m.elev = resolveElevAt(grid, m.elev, m.x, m.y, ctx);

      // Safety net: never let a monster leave its zone polygon. Cheap O(1)
      // membership check; the nearest-cell scan only runs for the rare
      // offender (a body-radius slide past an edge cell). Same position
      // definition as everything else (see ONE POSITION DEFINITION above): the
      // cell tested and the cell centre snapped to are both the shadow centre.
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
  private chess!: ChessManager; // the boards + matches for this world (chess.ts)
  private chessTick = 0;
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
  /** Fractional HP owed by a harmful liquid (lava), per session — landed
   *  whole through hurtPlayer as it accrues. */
  private harmAcc = new Map<string, number>();
  /** pid -> the fall hit waiting for the body to LAND: the hp it costs and the
   *  wall clock it is due. Dropped whenever an elevation is ASSIGNED rather
   *  than walked (spawn, teleport, revive, hand-off, leave) — the fall those
   *  storeys belonged to is over, and a hit that outlived it would kill
   *  someone standing somewhere else. */
  private fallPend = new Map<string, { dmg: number; at: number }>();
  /** The storey pitch in px the fall clock runs on, so the server's landing
   *  and the client's drawn descent are the same fall. The maps3 constant for
   *  the same reason the scenery stamp uses it: the game ships ONE world and
   *  the loader does not carry its `iso` block this far. */
  private storeyPx = ISO_GEOMETRY_MAPS3.lh;

  /** LAND EVERY FALL THAT HAS REACHED THE GROUND. Runs before the player loop
   *  so a hit due this tick is taken before the input that follows it. */
  private settleFalls(now: number) {
    if (!this.fallPend.size) return;
    for (const [id, f] of [...this.fallPend]) {
      if (now < f.at) continue;
      this.fallPend.delete(id);
      const p = this.state.players.get(id);
      if (!p || p.dead) continue;
      this.hurtPlayer(p, f.dmg, now);
    }
  }
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
      this.publishEvent("chat", { name: "—", text: `${player.name} was slain.` });
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
    // A GHOST killer earns at home (spec/ZONES.md phase 5); at the cap xp has
    // nowhere to go (RO shows a frozen bar) — grantXp keeps the bar frozen
    // rather than a meaningless ever-growing number in the save file.
    if (this.state.ghosts.get(killer.pid) === killer) {
      const home = this.ghostOwner.get(killer.pid);
      if (home !== undefined)
        void bus().publish(this.chan.ctl(home), { type: "reward", pid: killer.pid, xp: stats.xp } satisfies CtlMessage);
      return;
    }
    this.grantXp(killer, stats.xp);
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
    this.syncPos(g);
    this.state.drops.set(`${this.idPrefix}d${this.dropCounter++}`, g);
  }

  /** One replacement monster in a zone, MONSTER_RESPAWN_MS after a death —
   * the zone's `num` stays the concurrent cap (RO-style repop). */
  private respawnMonster(areaId: string, now: number) {
    const z = this.zones.find((zz) => zz.zone.id === areaId);
    const cells = z ? this.ownCells(z) : [];
    if (!z || !cells.length) return;
    const m = new Monster();
    m.kind = z.zone.monster;
    m.areaId = areaId;
    m.home = this.zoneId;
    const cell = cells[Math.floor(this.monsterRng() * cells.length)];
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
    const id = `${this.idPrefix}${areaId}#r${this.respawnCounter++}`;
    m.orbitSign = idSalt(id) & 1 ? 1 : -1;
    this.syncPos(m);
    this.state.monsters.set(id, m);
  }

  /** Stack an item into the backpack. False = full (slot cap hit). */
  private addInvItem(player: Player, item: string): boolean {
    const slot = player.inv.find((s) => s.item === item && s.n < INV_MAX_STACK);
    if (slot) {
      slot.n++;
      player.dirty = true;
      return true;
    }
    if (player.inv.length >= INV_MAX_SLOTS) return false;
    player.inv.push({ item, n: 1 });
    player.dirty = true;
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
      this.queueRespawn(m.areaId, m.home, now);
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
      // ONLY THE DIRTY. Write on meaning, not on a timer: a player who earned
      // nothing this window is not written at all, so an idle world costs zero
      // writes. (Measured at the 20k-concurrent target: an unconditional 30s
      // flush is ~$1,550/month of mostly-unchanged documents.)
      this.state.players.forEach((p: Player) => {
        if (p.dirty) this.savePlayer(p);
      });
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
      this.swingLoop(player, sid, now, dt, radii, false);
    });
    // A neighbour's player fighting one of MY monsters from across the line:
    // the ghost mirrored here swings, and what its own room must show or
    // keep (the clip, the hits, the xp) travels home over the bus.
    this.state.ghosts.forEach((g, pid) => {
      if (g.target && !g.dead) this.swingLoop(g, pid, now, dt, radii, true);
    });
  }

  private swingLoop(player: Player, sid: string, now: number, dt: number, radii: Map<string, number>, ghost: boolean) {
    {
      if (!player.target) return;
      const m = this.state.monsters.get(player.target);
      if (!m || m.mstate === "die") {
        // A GHOST monster is fought in its owner's room: keep the mark until
        // that room reports it dead (the ghost mirrors mstate) or it leaves.
        const gm = !ghost ? this.state.ghostMonsters.get(player.target) : undefined;
        if (gm && gm.mstate !== "die") return;
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
      const rm = monsterRadiusFor(m.kind, radii.get(m.kind), DEFAULT_MONSTER_RADIUS);
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
      if (this.terrain && !ghost) {
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
      const face = faceDirWorld(player.x, player.y, m.x, m.y);
      let swingSeq: number;
      if (ghost) {
        // The real body's clip, facing and combat clock live at home.
        swingSeq = ++player.ghostSwings;
        const home = this.ghostOwner.get(sid);
        if (home !== undefined)
          void bus().publish(this.chan.ctl(home), { type: "swing", pid: sid, dir: face ?? "" } satisfies CtlMessage);
      } else {
        player.action = "attack";
        player.actionSeq++;
        player.lastCombatAt = now;
        if (face) player.dir = face;
        swingSeq = player.actionSeq;
      }
      const dmg = damageRoll(playerAtk(player.level), idSalt(sid), swingSeq);
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
    }
  }

  /** DROP A PLAYER'S SWORD MARK, telling the monster's own room when the
   *  monster is a neighbour's (the ghost of this player carries the mark
   *  there, and that room runs the fight — spec/ZONES.md phase 5). */
  private clearMark(player: Player, pid: string): boolean {
    const old = player.target;
    if (!old) return false;
    player.target = "";
    const owner = this.ghostOwner.get(old);
    if (owner !== undefined) void bus().publish(this.chan.ctl(owner), { type: "engage", pid, id: "" } satisfies CtlMessage);
    return true;
  }

  /** CALL OFF EVERY HUNT ON THIS PLAYER, among this room's own monsters.
   *
   *  This is what "disable aggro" means once it is on: THE ONLY MONSTER THAT
   *  MAY BE HUNTING YOU IS ONE YOU ARE MARKING RIGHT NOW. Provoked hunts go
   *  with the rest — the button prints "nothing will jump you" and exists to
   *  walk a cave and look at it (maintainer 2026-08-07) — and tapping a
   *  monster marks it again, which provokes it again. The switch removes the
   *  ambush, never the ability to pick a fight.
   *
   *  disengageMonster is the SAME exit every other ended chase takes: it lifts
   *  the victim's flee slow and walks the monster home if the hunt carried it
   *  off its zone. Hand-clearing targetSid here would leave strays. */
  private releaseHunts(pid: string, now: number) {
    this.state.monsters.forEach((m) => {
      if (m.targetSid !== pid || m.mstate === "die") return;
      const z = this.zones.find((zz) => zz.zone.id === m.areaId);
      if (z) this.disengageMonster(m, z, now);
    });
  }

  /** ...and ask the NEIGHBOURS to do the same to the ghost of this player.
   *  Their next edge snapshot carries the flag (EDGE_TICKS), but that only
   *  stops a NEW aggro — a chase already running is ended by its own room. */
  private releaseHuntsNextDoor(pid: string) {
    if (this.zoneId === WHOLE_WORLD || !this.grid) return;
    for (const n of zoneNeighbours(this.grid, this.zoneId))
      void bus().publish(this.chan.ctl(n), { type: "noaggro", pid } satisfies CtlMessage);
  }

  /** A body by stable id: a player of this room, else a neighbour's ghost. */
  private bodyOf(pid: string): Player | undefined {
    return this.state.players.get(pid) ?? this.state.ghosts.get(pid);
  }

  /** Hurt a body: a real player here, or a ghost whose home room takes the
   *  hit (the flinch, the slow, the death all happen there; the ghost mirrors
   *  hp and hitSeq back on the next snapshot). */
  private hurtBody(p: Player, dmg: number, now: number) {
    if (this.state.players.get(p.pid) === p) return this.hurtPlayer(p, dmg, now);
    const home = this.ghostOwner.get(p.pid);
    if (home !== undefined) void bus().publish(this.chan.ctl(home), { type: "hurt", pid: p.pid, dmg } satisfies CtlMessage);
  }

  /** XP earned by a kill, with the level-up burst; the reason a ding is
   *  saved at once. */
  private grantXp(killer: Player, xp: number) {
    if (killer.level < LEVEL_CAP) killer.xp += xp;
    killer.dirty = true; // xp is EARNED — hp/ep are not, they regenerate
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
      this.publishEvent("levelup", { name: killer.name, level: killer.level });
      this.savePlayer(killer); // the worst thing a crash could eat is a ding
    }
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
      const r = monsterRadiusFor(o.kind, radii.get(o.kind), DEFAULT_MONSTER_RADIUS);
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


  // ------------------------------------------------------------------ ZONES
  // spec/ZONES.md. Everything below is inert in the whole-world room except
  // the pid keying, the presence hash and the event bus, which are the same
  // code path in both modes on purpose.
  private zoneId = WHOLE_WORLD;
  private grid: ZoneGrid | null = null;
  private rect: Rect | null = null;
  private idPrefix = ""; // monsters and drops of a zone room carry `z<zone>:` so ids are world-unique
  /** POSITIONS ON THE WIRE (shared/worldunits.ts): the room's origin and
   *  quantum; `syncPos` writes an entity's px/py from its float x/y. */
  private posOx = 0;
  private posOy = 0;
  private posQ = POS_Q_WHOLE;
  private syncPos(e: { x: number; y: number; px: number; py: number }) {
    const px = quantizePos(e.x, this.posOx, this.posQ);
    const py = quantizePos(e.y, this.posOy, this.posQ);
    if (e.px !== px) e.px = px;
    if (e.py !== py) e.py = py;
  }
  /** Positions are written to the wire fields right before EVERY patch, so a
   *  position set outside the tick (a respawn, a teleport, a message handler)
   *  can never reach a client a patch later than the flag set beside it. */
  broadcastPatch(): boolean {
    this.syncAllPositions();
    return super.broadcastPatch();
  }
  private syncAllPositions() {
    /* THE PATCH TIMER CAN FIRE BEFORE THE STATE EXISTS: onCreate loads the
     * world first and calls setState after, and a room whose world failed to
     * load (CI's sparse checkout has no maps2) never gets one — an unguarded
     * read here was an uncaught TypeError that killed seven test files in
     * CI, and with them every deploy since it landed (2026-09-09). */
    if (!this.state) return;
    this.state.players.forEach((p) => this.syncPos(p));
    this.state.monsters.forEach((m) => this.syncPos(m));
    this.state.drops.forEach((g) => this.syncPos(g));
    this.state.ghosts.forEach((p) => this.syncPos(p));
    this.state.ghostMonsters.forEach((m) => this.syncPos(m));
    this.state.ghostDrops.forEach((g) => this.syncPos(g));
  }
  private duplicate = false; // a second room of a zone that already has one (see zoneRooms)
  private chan = {
    events: "",
    presence: "",
    edge: (_z: number) => "",
    ctl: (_z: number) => "",
  };
  private unsubs: Array<() => void> = [];
  /** session id → stable player id (the map key) and back. */
  private sidPid = new Map<string, string>();
  private pidSid = new Map<string, string>();
  /** Parked reconnection graces by session id, so a newcomer on the same
   *  account can REJECT one (see kickPid) instead of leaving a twin standing
   *  in the world for the whole grace. */
  private reconnects = new Map<string, { reject: Function }>();
  /** Sessions whose body was handed to another zone: their leave saves nothing. */
  private handed = new Set<string>();
  private ghostOwner = new Map<string, number>(); // ghost id → the zone that owns the body
  private edgeTick = 0;
  private ownCellsCache = new Map<string, ZoneRuntime["cells"]>();

  private pidOf(client: Client): string {
    return this.sidPid.get(client.sessionId) ?? client.sessionId;
  }
  private playerOf(client: Client): Player | undefined {
    return this.state.players.get(this.pidOf(client));
  }
  private publishEvent(type: string, data: unknown) {
    void bus().publish(this.chan.events, { type, data });
  }

  /** A body enters this room under its stable id: the map key, the session
   *  link, its view, its private backpack and the world presence. */
  private adoptPlayer(client: Client, pid: string, player: Player, noAggro = false) {
    player.pid = pid;
    player.sid = client.sessionId;
    /* THE AMBUSH SWITCH BEFORE THE FIRST SCAN. The client's `noaggro` message
     * arrives a round trip after the body is in state, and the 450 ms scan does
     * not wait: logging in beside a predator was a death with the switch
     * showing ON in Settings, and toggling it off and on again was the only way
     * to make it bite (maintainer 2026-09-10). The join call carries it now
     * (JoinOptions.noAggro) and a hand-off carries it in the hot state. */
    if (noAggro) this.noAggro.add(pid);
    this.sidPid.set(client.sessionId, pid);
    this.pidSid.set(pid, client.sessionId);
    this.state.ghosts.delete(pid); // it may have been a neighbour's ghost a moment ago
    this.syncPos(player);
    this.state.players.set(pid, player);
    this.attachView(client, player);
    // The backpack is PRIVATE — targeted message, never schema-synced.
    client.send("inv", { items: player.inv });
    // PRESENCE is keyed by ACCOUNT (a person), never by pid (a session):
    // it is what "one live session per account" is enforced on, world-wide.
    if (player.accountId)
      void bus().hset(this.chan.presence, player.accountId, JSON.stringify({ pid, zone: this.zoneId, name: player.name }));
    // A duplicate room hands every arrival to the zone's owner at once (the
    // same zone id; this room is locked, so the join lands in the owner).
    if (this.duplicate) this.startHandoff(player, pid, this.zoneId, Date.now());
  }

  /** ONE LIVE SESSION PER ACCOUNT, WORLD-WIDE (the account agent's contract,
   *  2026-09-09): the newcomer looks the account up in the presence hash and
   *  kicks the session it names, in this room directly or through the zone's
   *  `ctl` channel. The kicked room saves and drops that session as the
   *  in-room kick always did; the newcomer's adopt then overwrites presence. */
  private async kickOtherSession(accountId: string, myPid: string): Promise<void> {
    if (!accountId) return;
    const raw = await bus().hget(this.chan.presence, accountId);
    if (!raw) return;
    let prev: { pid?: string; zone?: number };
    try {
      prev = JSON.parse(raw);
    } catch {
      return;
    }
    if (!prev.pid || prev.pid === myPid) return;
    if (prev.zone === this.zoneId) this.kickPid(prev.pid);
    else if (typeof prev.zone === "number")
      void bus().publish(this.chan.ctl(prev.zone), { type: "kick", pid: prev.pid } satisfies CtlMessage);
  }

  private kickPid(pid: string) {
    const oldSid = this.pidSid.get(pid);
    const oldPlayer = this.state.players.get(pid);
    if (!oldSid || !oldPlayer) return;
    this.savePlayer(oldPlayer); // flush the live state the newcomer restores
    /* A KICK IS NOT A DROPPED LINK. `onLeave` holds a seat open for a
     * reconnect, and a kicked session must not hold one — the whole point
     * is that ONE token means one live session, and a reclaimable ghost
     * would leave two. Marked before the leave, read inside it. */
    this.kicked.add(oldSid);
    const live = this.clients.find((c) => c.sessionId === oldSid);
    if (live) {
      live.leave(4001); // its onLeave re-saves the same values
      return;
    }
    /* NOBODY BEHIND IT: the link dropped and that session's onLeave is parked
     * in `allowReconnection` with the body still in state. Reject the grace —
     * onLeave then falls through to its own removal, so the twin goes and the
     * seat can never be reclaimed by the session we just kicked. Without this
     * the `?.` swallowed the kick and the old body stood there for the whole
     * grace window. */
    const grace = this.reconnects.get(oldSid);
    if (grace) grace.reject(new Error("kicked"));
    else this.kicked.delete(oldSid); // nothing to kick; don't poison a future leave
  }

  /** The spawn cells of a maps2 zone that lie inside THIS room's rectangle
   *  (all of them in the whole-world room). Seeding and respawning draw from
   *  these; roaming keeps the whole polygon and a monster that walks out is
   *  transferred. */
  private ownCells(z: ZoneRuntime): ZoneRuntime["cells"] {
    if (!this.rect) return z.cells;
    let own = this.ownCellsCache.get(z.zone.id);
    if (!own) {
      const r = this.rect;
      own = z.cells.filter((c) => {
        const x = (c.c + 0.5) * CELL_WU;
        const y = (c.r + 0.5) * CELL_WU;
        return x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
      });
      this.ownCellsCache.set(z.zone.id, own);
    }
    return own;
  }

  /** This room's share of a zone's `num`: proportional to the cells it owns,
   *  rounded, so a polygon straddling a border seeds its count once. */
  private zoneShare(z: ZoneRuntime, num: number): number {
    if (!this.rect || !z.cells.length) return num;
    return Math.round((num * this.ownCells(z).length) / z.cells.length);
  }

  /** A respawn goes back to the room that seeded the monster (its cells are
   *  there); the same room queues it locally. */
  private queueRespawn(areaId: string, home: number, now: number) {
    if (home === this.zoneId) this.respawnQueue.push({ areaId, at: now + MONSTER_RESPAWN_MS });
    else void bus().publish(this.chan.ctl(home), { type: "monster:respawn", areaId } satisfies CtlMessage);
  }

  private stepZones(now: number) {
    const grid = this.grid!;
    // 1. Players that crossed into another zone are handed over; a hand-off
    //    nobody completed is dropped after HANDOFF_TIMEOUT_MS so a failed hop
    //    never strands a body.
    this.state.players.forEach((p, pid) => {
      if (p.handoff) {
        if (now - p.handoff.at > HANDOFF_TIMEOUT_MS) p.handoff = null;
        return;
      }
      if (p.dead) return;
      const z = zoneAt(grid, p.x, p.y);
      if (z !== this.zoneId) this.startHandoff(p, pid, z, now);
    });
    // 2. Monsters that walked out are transferred with their brain.
    const xfer: Array<[string, number]> = [];
    this.state.monsters.forEach((m, id) => {
      if (m.mstate === "die") return;
      const z = zoneAt(grid, m.x, m.y);
      if (z !== this.zoneId) xfer.push([id, z]);
    });
    for (const [id, z] of xfer) this.transferMonster(id, z);
    // 3. The border band goes out as ghosts, EDGE_TICKS apart.
    if (++this.edgeTick >= EDGE_TICKS) {
      this.edgeTick = 0;
      this.publishEdge(now);
    }
    // 4. Ghosts whose owner went quiet expire.
    const gone: Array<[MapSchema<any>, string]> = [];
    this.state.ghosts.forEach((p, id) => {
      if (now - p.lastSeen > GHOST_TTL_MS) gone.push([this.state.ghosts, id]);
    });
    this.state.ghostMonsters.forEach((m, id) => {
      if (now - m.lastSeen > GHOST_TTL_MS) gone.push([this.state.ghostMonsters, id]);
    });
    this.state.ghostDrops.forEach((g, id) => {
      if (now - g.lastSeen > GHOST_TTL_MS) gone.push([this.state.ghostDrops, id]);
    });
    for (const [map, id] of gone) {
      map.delete(id);
      this.ghostOwner.delete(id);
    }
  }

  /** HAND-OFF, the sending side: the hot state goes to the bus under a
   *  one-shot key, the client is told where to go, and this room keeps
   *  stepping the body until the receiving room says it has it. */
  private startHandoff(p: Player, pid: string, to: number, now: number) {
    const sid = this.pidSid.get(pid);
    const client = sid ? this.clients.find((c) => c.sessionId === sid) : undefined;
    if (!client) return;
    const key = randomBytes(16).toString("hex"); // 128 bits: the capability for ONE join
    p.handoff = { to, key, at: now };
    const hot: HotState = {
      key,
      pid,
      from: this.zoneId,
      name: p.name,
      character: p.character,
      accountId: p.accountId,
      rec: p.rec,
      mintedSecret: p.mintedSecret,
      x: p.x,
      y: p.y,
      elev: p.elev,
      dir: p.dir,
      level: p.level,
      xp: p.xp,
      hp: p.hp,
      ep: p.ep,
      inv: p.inv.map((s) => ({ item: s.item, n: s.n })),
      seq: p.seq,
      torch: p.torch,
      noAggro: this.noAggro.has(pid),
      lastHitAt: p.lastHitAt,
      lastCombatAt: p.lastCombatAt,
      dirty: p.dirty,
    };
    void bus()
      .set(handoffKey(this.worldName, pid), JSON.stringify(hot), HANDOFF_TTL_S)
      .then(() => client.send("zone:go", { zone: to, pid, key, seq: hot.seq }))
      .catch((e) => {
        console.error("[zones] hand-off write failed:", e);
        p.handoff = null;
      });
  }

  /** HAND-OFF, the receiving side: only a pid + key pair that matches the
   *  bus document is honoured, and the document is consumed. */
  private async takeHandoff(options: JoinOptions): Promise<HotState | null> {
    if (typeof options.pid !== "string" || typeof options.handoff !== "string") return null;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(options.pid) || !/^[0-9a-f]{32}$/.test(options.handoff)) return null;
    const key = handoffKey(this.worldName, options.pid);
    const raw = await bus().get(key);
    if (!raw) return null;
    let hot: HotState;
    try {
      hot = JSON.parse(raw) as HotState;
    } catch {
      return null;
    }
    if (hot.key !== options.handoff || hot.pid !== options.pid) return null;
    await bus().del(key);
    return hot;
  }

  private joinHandedOff(client: Client, hot: HotState) {
    const player = new Player();
    player.name = hot.name;
    player.character = hot.character;
    player.accountId = hot.accountId;
    player.rec = hot.rec;
    player.mintedSecret = hot.mintedSecret ?? "";
    player.x = hot.x;
    player.y = hot.y;
    player.elev = hot.elev;
    player.dir = hot.dir;
    player.level = hot.level;
    player.xp = hot.xp;
    player.hpMax = hpMaxFor(player.level);
    player.epMax = epMaxFor(player.level);
    player.hp = Math.min(player.hpMax, Math.max(1, hot.hp));
    player.ep = Math.min(player.epMax, Math.max(0, hot.ep));
    player.inv = hot.inv.map((s) => ({ item: s.item, n: s.n }));
    player.seq = hot.seq;
    // The client buffered its inputs while it swapped rooms (a matchmake and
    // a socket on a phone: hundreds of ms) and replays them the moment it is
    // bound. Without credit for that gap the burst is throttled to
    // INPUT_TIME_SLACK (0.25 s) and the body snaps back to the border, then
    // catches up — the "laggy" crossing. Grant the gap up front.
    player.timeCredit = HANDOFF_INPUT_CREDIT_S;
    player.torch = hot.torch;
    player.lastHitAt = hot.lastHitAt;
    player.lastCombatAt = hot.lastCombatAt;
    player.dirty = hot.dirty;
    if (client.state === ClientState.LEAVING || client.state === ClientState.CLOSED) {
      this.savePlayer(player);
      return;
    }
    this.adoptPlayer(client, hot.pid, player, !!hot.noAggro);
    // The old room saved nothing for this body and this room would not
    // until its flush or the leave: a link dropped mid-hop that fails its
    // seat reclaim then rejoins from the LAST SAVED spot — minutes old, in a
    // house it left long ago. One write per crossing keeps the spot current.
    this.savePlayer(player);
    void bus().publish(this.chan.ctl(hot.from), { type: "handoff:done", pid: hot.pid } satisfies CtlMessage);
  }

  private onCtl(m: CtlMessage) {
    if (!m || typeof m.type !== "string") return;
    const now = Date.now();
    if (m.type === "handoff:done") {
      const p = this.state.players.get(m.pid);
      if (!p?.handoff) return;
      const sid = this.pidSid.get(m.pid);
      this.state.players.delete(m.pid);
      this.fallPend.delete(m.pid);
      if (sid) {
        this.handed.add(sid);
        this.seen.delete(sid);
      }
      this.noAggro.delete(m.pid);
      this.chess?.onPlayerLeave(m.pid);
      // The client leaves this room itself once it is bound to the new one;
      // its onLeave finds `handed` and touches nothing.
    } else if (m.type === "monster:xfer") {
      if (this.state.monsters.has(m.id)) return;
      const d = m.m;
      const mon = new Monster();
      mon.kind = d.kind;
      mon.x = d.x;
      mon.y = d.y;
      mon.dir = d.dir;
      mon.moving = d.moving;
      mon.elev = d.elev;
      mon.hp = d.hp;
      mon.hpMax = d.hpMax;
      mon.actionSeq = d.actionSeq;
      mon.level = d.level;
      mon.aggro = d.aggro;
      mon.areaId = d.areaId;
      mon.home = d.home;
      mon.orbitSign = d.orbitSign;
      mon.chaseOx = d.chaseOx;
      mon.chaseOy = d.chaseOy;
      // The hunt survives the border only if the victim is here too.
      const victim = d.targetSid && this.state.players.has(d.targetSid) ? d.targetSid : "";
      mon.targetSid = victim;
      mon.provoked = victim ? d.provoked : false;
      mon.mstate = victim && (d.mstate === "chase" || d.mstate === "combat") ? d.mstate : "roam";
      mon.tsid = mon.mstate === "roam" ? "" : victim;
      mon.returning = !victim && d.returning;
      mon.nextMoveAt = now + 200;
      this.state.ghostMonsters.delete(m.id);
      this.ghostOwner.delete(m.id);
      this.syncPos(mon);
      this.state.monsters.set(m.id, mon);
    } else if (m.type === "monster:respawn") {
      this.respawnQueue.push({ areaId: m.areaId, at: now + MONSTER_RESPAWN_MS });
    } else if (m.type === "kick") {
      this.kickPid(m.pid);
    } else if (m.type === "noaggro") {
      // A neighbour's player switched "disable aggro" ON: drop the mark its
      // ghost carries here and call off every hunt my monsters have on it.
      const g = this.state.ghosts.get(m.pid);
      if (g) {
        g.target = "";
        g.ghostNoAggro = true;
      }
      this.releaseHunts(m.pid, now);
    } else if (m.type === "engage") {
      const g = this.state.ghosts.get(m.pid);
      if (g) g.target = m.id && this.state.monsters.get(m.id)?.mstate !== "die" ? m.id : "";
    } else if (m.type === "swing") {
      const p = this.state.players.get(m.pid);
      if (!p || p.dead) return;
      p.action = "attack";
      p.actionSeq++;
      p.lastCombatAt = now;
      if (m.dir) p.dir = m.dir;
    } else if (m.type === "hurt") {
      const p = this.state.players.get(m.pid);
      if (p && !p.dead && Number.isFinite(m.dmg) && m.dmg > 0) this.hurtPlayer(p, Math.floor(m.dmg), now);
    } else if (m.type === "reward") {
      const p = this.state.players.get(m.pid);
      if (p && Number.isFinite(m.xp) && m.xp > 0) {
        p.target = "";
        this.grantXp(p, Math.floor(m.xp));
      }
    } else if (m.type === "pickup") {
      // A ghost player picks one of MY drops: validate against the ghost's
      // mirrored position, take the item off the ground, send it home.
      const g = this.state.ghosts.get(m.pid);
      const drop = this.state.drops.get(m.id);
      if (!g || !drop || g.dead) return;
      if (Math.hypot(drop.x - g.x, drop.y - g.y) > PICKUP_RADIUS_WU) return;
      if (Math.abs(g.elev - drop.elev) > 2) return;
      const home = this.ghostOwner.get(m.pid);
      if (home === undefined) return;
      this.state.drops.delete(m.id);
      void bus().publish(this.chan.ctl(home), { type: "give", pid: m.pid, item: drop.item } satisfies CtlMessage);
    } else if (m.type === "give") {
      const p = this.state.players.get(m.pid);
      if (!p || typeof m.item !== "string") return;
      if (!this.addInvItem(p, m.item)) this.spawnDrop(m.item, p.x, p.y, p.elev); // a full backpack: it lands at the feet
      const sid = this.pidSid.get(m.pid);
      const client = sid ? this.clients.find((c) => c.sessionId === sid) : undefined;
      if (client) {
        client.send("inv", { items: p.inv });
        if (p.inv.length >= INV_MAX_SLOTS) client.send("chat", { name: "—", text: "Your backpack is full." });
      }
    }
  }

  private transferMonster(id: string, to: number) {
    const m = this.state.monsters.get(id);
    if (!m) return;
    const data: MonsterXfer = {
      kind: m.kind, x: m.x, y: m.y, dir: m.dir, moving: m.moving, elev: m.elev,
      hp: m.hp, hpMax: m.hpMax, mstate: m.mstate, actionSeq: m.actionSeq, level: m.level, aggro: m.aggro,
      areaId: m.areaId, home: m.home, orbitSign: m.orbitSign, provoked: m.provoked, returning: m.returning,
      targetSid: m.targetSid, chaseOx: m.chaseOx, chaseOy: m.chaseOy,
    };
    void bus().publish(this.chan.ctl(to), { type: "monster:xfer", id, m: data } satisfies CtlMessage);
    this.state.monsters.delete(id);
    this.monsterDodgeStates.delete(id);
  }

  /** The border band, complete, to every neighbour: what is inside this rect
   *  within GHOST_BAND_WU of an edge, plus anything of ours standing outside
   *  it (a body mid-hand-off). A receiver keeps what lies within the band of
   *  ITS rect. */
  private publishEdge(now: number) {
    const rect = this.rect!;
    const grid = this.grid!;
    const inBand = (x: number, y: number) => nearEdge(rect, grid, x, y, GHOST_BAND_WU) || distToRect(rect, x, y) > 0;
    const msg: EdgeSnapshot = { from: this.zoneId, t: now, players: [], monsters: [], drops: [] };
    this.state.players.forEach((p, pid) => {
      if (!inBand(p.x, p.y)) return;
      msg.players.push({
        id: pid, name: p.name, character: p.character, x: p.x, y: p.y, dir: p.dir, moving: p.moving,
        running: p.running, elev: p.elev, jumping: p.jumping, swimming: p.swimming, torch: p.torch,
        level: p.level, hp: p.hp, hpMax: p.hpMax, dead: p.dead, slow: p.slow, action: p.action,
        actionSeq: p.actionSeq, hitSeq: p.hitSeq, noAggro: this.noAggro.has(pid),
      });
    });
    this.state.monsters.forEach((m, id) => {
      if (!inBand(m.x, m.y)) return;
      msg.monsters.push({
        id, kind: m.kind, x: m.x, y: m.y, dir: m.dir, moving: m.moving, elev: m.elev, hp: m.hp, hpMax: m.hpMax,
        mstate: m.mstate, actionSeq: m.actionSeq, level: m.level, aggro: m.aggro, tsid: m.tsid,
      });
    });
    this.state.drops.forEach((g, id) => {
      if (!inBand(g.x, g.y)) return;
      msg.drops.push({ id, item: g.item, x: g.x, y: g.y, elev: g.elev });
    });
    if (msg.players.length || msg.monsters.length || msg.drops.length || this.edgeSent) {
      this.edgeSent = msg.players.length + msg.monsters.length + msg.drops.length > 0;
      void bus().publish(this.chan.edge(this.zoneId), msg);
    }
  }
  private edgeSent = false;

  private onEdgeSnapshot(m: EdgeSnapshot) {
    if (!m || typeof m.from !== "number" || !this.rect) return;
    const now = Date.now();
    const rect = this.rect;
    const keep = new Set<string>();
    const near = (x: number, y: number) => distToRect(rect, x, y) <= GHOST_BAND_WU;
    for (const p of m.players ?? []) {
      if (!near(p.x, p.y) || this.state.players.has(p.id)) continue;
      keep.add(p.id);
      let g = this.state.ghosts.get(p.id);
      const fresh = !g;
      if (!g) g = new Player();
      g.name = p.name; g.character = p.character; g.x = p.x; g.y = p.y; g.dir = p.dir; g.moving = p.moving;
      g.running = p.running; g.elev = p.elev; g.jumping = p.jumping; g.swimming = p.swimming; g.torch = p.torch;
      g.level = p.level; g.hp = p.hp; g.hpMax = p.hpMax; g.dead = p.dead; g.slow = p.slow; g.action = p.action;
      g.actionSeq = p.actionSeq; g.hitSeq = p.hitSeq; g.sid = ""; g.pid = p.id; g.lastSeen = now;
      g.ghostNoAggro = !!p.noAggro;
      this.syncPos(g);
      if (fresh) this.state.ghosts.set(p.id, g);
      this.ghostOwner.set(p.id, m.from);
    }
    for (const d of m.monsters ?? []) {
      if (!near(d.x, d.y) || this.state.monsters.has(d.id)) continue;
      keep.add(d.id);
      let g = this.state.ghostMonsters.get(d.id);
      const fresh = !g;
      if (!g) g = new Monster();
      g.kind = d.kind; g.x = d.x; g.y = d.y; g.dir = d.dir; g.moving = d.moving; g.elev = d.elev; g.hp = d.hp;
      g.hpMax = d.hpMax; g.mstate = d.mstate; g.actionSeq = d.actionSeq; g.level = d.level; g.aggro = d.aggro;
      g.tsid = d.tsid; g.lastSeen = now;
      this.syncPos(g);
      if (fresh) this.state.ghostMonsters.set(d.id, g);
      this.ghostOwner.set(d.id, m.from);
    }
    for (const d of m.drops ?? []) {
      if (!near(d.x, d.y) || this.state.drops.has(d.id)) continue;
      keep.add(d.id);
      let g = this.state.ghostDrops.get(d.id);
      const fresh = !g;
      if (!g) g = new GroundItem();
      g.item = d.item; g.x = d.x; g.y = d.y; g.elev = d.elev; g.lastSeen = now;
      this.syncPos(g);
      if (fresh) this.state.ghostDrops.set(d.id, g);
      this.ghostOwner.set(d.id, m.from);
    }
    // A snapshot is that zone's whole band: what it no longer carries is gone.
    const gone: string[] = [];
    for (const [id, owner] of this.ghostOwner) if (owner === m.from && !keep.has(id)) gone.push(id);
    for (const id of gone) {
      this.state.ghosts.delete(id);
      this.state.ghostMonsters.delete(id);
      this.state.ghostDrops.delete(id);
      this.ghostOwner.delete(id);
    }
  }

  private idleTick = 0;
  private idleDt = 0;
  private recordTick(ms: number) {
    let r = roomStats.get(this.roomId);
    if (!r) {
      r = { world: this.worldName, zone: this.zoneId, clients: 0, players: 0, monsters: 0, ghosts: 0, ticks: [], at: 0, simTicks: 0, bytesOut: 0, bytesAt: Date.now() };
      roomStats.set(this.roomId, r);
    }
    r.ticks.push(ms);
    if (r.ticks.length > TICK_RING) r.ticks.shift();
    r.clients = this.clients.length;
    r.players = this.state.players.size;
    r.monsters = this.state.monsters.size;
    r.ghosts = this.state.ghosts.size + this.state.ghostMonsters.size;
    r.at = Date.now();
  }

  onDispose() {
    roomStats.delete(this.roomId);
    if (this.zoneId !== WHOLE_WORLD && zoneRooms.get(zoneRoomKey(this.worldName, this.zoneId)) === this.roomId)
      zoneRooms.delete(zoneRoomKey(this.worldName, this.zoneId));
    if (this.starTimer) clearTimeout(this.starTimer);
    this.offLive?.();
    for (const off of this.unsubs) off();
    this.unsubs = [];
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

/** Default world when the client sends none: THE game (the only world). */
export const DEFAULT_WORLD = "the_game";

function assetsRoot(): string {
  const srcDir = dirname(fileURLToPath(import.meta.url)); // server/src/rooms
  const gameRoot = join(srcDir, "..", "..", ".."); // games2
  return process.env.ASSETS_ROOT || join(gameRoot, ".."); // repo root
}

// ---------------------------------------------------------------- staging ----
// A world that is NOT in this image (config/publish.json ships only
// `userWorlds` since 2026-08-15) can still be joined by an admin: its
// world.json/spawns.json are fetched from the repo. DISK FIRST, ALWAYS — a
// shipped world never touches the network, so the ordinary player join path
// is byte-identical to before this existed. The fetch half only runs for
// names the image does not carry, i.e. dev maps.
//
// STAGING_WORLD_BASE overrides the GitHub base — that is how the gate
// (verify-stagingworld.mjs) points this at a local fixture, since asserting
// against live GitHub from CI would test their uptime, not our code.
//
// Cached in memory: positive 5 min (a room create per world per process is
// the real frequency), negative 60 s so a typo'd join cannot hammer GitHub.
const STAGING_BASE =
  process.env.STAGING_WORLD_BASE || "https://raw.githubusercontent.com/mikael-floden/pixel/main";
const stagingCache = new Map<string, { doc: unknown | null; at: number }>();
async function fetchStagingJson(rel: string): Promise<unknown | null> {
  const hit = stagingCache.get(rel);
  if (hit && Date.now() - hit.at < (hit.doc ? 300_000 : 60_000)) return hit.doc;
  let doc: unknown | null = null;
  try {
    const res = await fetch(`${STAGING_BASE}/${rel}`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) doc = await res.json();
    else console.warn(`[staging] ${rel}: ${res.status} from ${STAGING_BASE}`);
  } catch (e) {
    console.warn(`[staging] ${rel}: ${(e as Error).message}`);
  }
  stagingCache.set(rel, { doc, at: Date.now() });
  return doc;
}

// THE WORLD TREE: `maps2/worlds3` holds pixel-maps3/world@1 (semantics only,
// art resolved at draw time). A list, not a string, so a second tree can be
// probed again without touching the callers. (`maps2/worlds` — world@1/@2
// with baked tile paths — was retired 2026-09-09 with tiles2.)
const WORLD_ROOTS = ["maps2/worlds3"] as const;

/** Which tree holds `name`, resolved ONCE per world and cached for the process.
 *
 * DISK FIRST, ACROSS BOTH TREES, BEFORE ANY NETWORK — the shipped-world rule is
 * unchanged: a world the image carries never touches GitHub. Only a name absent
 * from both trees on disk falls through to the staging fetch, and the world.json
 * it fetches lands in `stagingCache`, so the readWorldDoc call right behind it
 * is served from memory rather than issuing a second request.
 *
 * Unresolvable names return the FIRST root, which reproduces the old
 * "missing world" path exactly (loadWorldGrid gets null and opens a plain). */
const worldRootCache = new Map<string, string>();
export async function worldRootFor(name: string): Promise<string> {
  const hit = worldRootCache.get(name);
  if (hit) return hit;
  let root: string | null = null;
  for (const r of WORLD_ROOTS) {
    if (existsSync(join(assetsRoot(), ...r.split("/"), name, "world.json"))) {
      root = r;
      break;
    }
  }
  if (!root)
    for (const r of WORLD_ROOTS) {
      if (await fetchStagingJson(`${r}/${name}/world.json`)) {
        root = r;
        break;
      }
    }
  root ??= WORLD_ROOTS[0];
  worldRootCache.set(name, root);
  return root;
}

/** The raw world.json/spawns.json for a name: disk (the shipped image / dev
 * working tree) first, staging fetch second. Null = the world truly does not
 * exist. Every file of one world is read from the SAME tree (resolving the
 * root per file would cost one pointless probe per sidecar). */
export async function readWorldDoc(name: string, file: string): Promise<unknown | null> {
  const root = await worldRootFor(name);
  try {
    const path = join(assetsRoot(), ...root.split("/"), name, file);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // a CORRUPT local file is not rescued by GitHub — surface it as missing
  }
  return fetchStagingJson(`${root}/${name}/${file}`);
}

/** Test seam: the world-root and staging caches are process-lifetime by design
 * (a room create per world per process is the real frequency). A gate that
 * asserts the RESOLUTION itself has to start from cold.
 *
 * worldRootFor/readWorldDoc/loadWorldGrid are exported for the same reason —
 * server/test/worldserve.test.ts proves the REAL server path, not a copy. */
export function resetWorldSourceCaches(): void {
  worldGridCache.clear();
  worldRootCache.clear();
  stagingCache.clear();
}

/** A cheap fingerprint of the scenery hitbox doc. Only the BOXES matter to
 *  collision — `updated_at` churns on every wiki save without changing where a
 *  body may stand, and restamping the world for that would be pure waste. */
function hitboxStamp(): string {
  const doc = sceneryHitboxOverrides();
  if (!doc) return "";
  let h = 0x811c9dc5;
  for (const k of Object.keys(doc).sort()) {
    const boxes = (doc[k] as { boxes?: unknown })?.boxes;
    const s = k + JSON.stringify(boxes ?? null);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(36);
}

/** Load a named world (maps2/worlds3 — see WORLD_ROOTS) into a collision
 * grid + spawn + extent, or an open world if it isn't present/parseable.
 * `parseWorld` dispatches on the doc's own schema.
 * Async since the staging path (2026-08-15): a world absent from disk may
 * stream from the repo — see readWorldDoc. */
/** ONE GRID PER WORLD PER PROCESS, shared by every zone room (spec/ZONES.md).
 *  A room never writes the grid; the scenery restamp REPLACES it through a
 *  fresh load keyed by the hitbox stamp, so every room adopts the same new
 *  grid. Measured: 16 warm rooms each building their own grid was 850 MB rss
 *  on a 512 MiB Cloud Run instance. */
const worldGridCache = new Map<string, Promise<LoadedWorld>>();
export function loadWorldGrid(name: string, stamp = hitboxStamp()): Promise<LoadedWorld> {
  const key = `${name}@${stamp ?? ""}`;
  let p = worldGridCache.get(key);
  if (!p) {
    p = loadWorldGridUncached(name);
    worldGridCache.set(key, p);
    // A failed load must not be cached as the world forever.
    p.then((w) => { if (!w.terrain) worldGridCache.delete(key); }).catch(() => worldGridCache.delete(key));
  }
  return p;
}
async function loadWorldGridUncached(name: string): Promise<LoadedWorld> {
  const open: LoadedWorld = { terrain: null, spawn: null, worldW: WORLD_WIDTH, worldH: WORLD_HEIGHT };
  try {
    const doc = await readWorldDoc(name, "world.json");
    if (!doc) return open;
    const world = parseWorld(doc);
    if (!world) return open;
    const terrain = buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks);
    // The deep-sea current's fields, built here rather than by the first
    // swimmer to reach open water (see warmDeepCurrent).
    warmDeepCurrent(terrain);
    /* SCENERY BLOCKS THE GROUND IT STANDS ON. world3.ts held this back — "no
     * canonical field ships today" — and scenery now publishes one, so the
     * precondition is met (maintainer 2026-08-29: "WE WANT THE DEFAULT HITBOX
     * WITH COLLISION"). Default (auto) boxes count: measured on the_game, all
     * 1,406 placements resolve and block 5,066 cells, 1.93% of the map.
     * Server-authoritative; the client stamps the same grid with the same
     * function so prediction cannot disagree. */
    if (world.scenery?.length) {
      const n = stampSceneryCollision(
        terrain,
        world.scenery,
        sceneryBbox(),
        sceneryHitboxOverrides(),
        // Scenery is a maps3 thing, and maps3 draws on dy=14, not the default 15.
        ISO_GEOMETRY_MAPS3,
      );
      if (n) console.log(`[scenery] ${world.scenery.length} pieces block ${n} cells`);
    }
    return {
      terrain,
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
async function loadSpawnZones(name: string, grid: TerrainGrid): Promise<ZoneRuntime[]> {
  try {
    const doc = await readWorldDoc(name, "spawns.json");
    if (!doc) return [];
    const zones = parseSpawns(doc);
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
