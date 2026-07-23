import { Schema, MapSchema, defineTypes } from "@colyseus/schema";
import { DEFAULT_DIRECTION, DEFAULT_TIME_IDX, MAX_STAMINA } from "@nangijala/shared";
import type { AutopilotTrip } from "@nangijala/shared";

/**
 * One connected player. Synced fields are declared with `declare` (so no class
 * field shadows the schema accessors under any `useDefineForClassFields` setting)
 * and wired with `defineTypes` instead of `@type` decorators — this keeps the
 * server runnable with plain `tsx`/esbuild on any Node version, no
 * `experimentalDecorators` tsconfig required.
 */
export class Player extends Schema {
  declare x: number;
  declare y: number;
  declare dir: string;
  declare moving: boolean;
  declare running: boolean;
  declare name: string;
  declare character: string;
  declare seq: number; // last input sequence the server has applied (ack)
  declare jumping: boolean; // in a jump window (for the hop visual + climb)
  declare swimming: boolean; // currently in water
  declare stamina: number; // swim stamina 0..MAX_STAMINA
  declare torch: boolean; // player's torch lit (visible to everyone)
  declare elev: number; // current surface elevation in LEVELS (world@2 decks: on the deck vs under it)

  // Server-only (not synced): queued inputs + rate-limit bookkeeping. The
  // server integrates each input's dt (client-reported, budget-bounded) so
  // both sides run identical movement math.
  inputQueue: { ax: number; ay: number; running: boolean; seq?: number; dt: number }[] = [];
  timeCredit = 0; // seconds of integration budget (accrues with real time)
  lastMoving = false;
  jumpUntil = 0; // ms timestamp: jump window ends
  jumpReadyAt = 0; // ms timestamp: earliest next jump (cooldown)
  lastChatAt = 0;
  token = ""; // persistence key (server-only)

  constructor() {
    super();
    this.x = 0;
    this.y = 0;
    this.dir = DEFAULT_DIRECTION;
    this.moving = false;
    this.running = false;
    this.name = "";
    this.character = "";
    this.seq = 0;
    this.jumping = false;
    this.swimming = false;
    this.stamina = MAX_STAMINA;
    this.torch = true;
    this.elev = 0;
  }
}

defineTypes(Player, {
  x: "number",
  y: "number",
  dir: "string",
  moving: "boolean",
  running: "boolean",
  name: "string",
  character: "string",
  seq: "number",
  jumping: "boolean",
  swimming: "boolean",
  stamina: "number",
  torch: "boolean",
  elev: "number",
});

/**
 * One server-authoritative roaming monster (the poring family, WALK/ROAM this
 * round). Same decorator-free style as Player: synced fields `declare`d +
 * initialized in the ctor + wired via `defineTypes` below. Every connected
 * client sees the same monsters at the same positions — the server owns all
 * movement (see WorldRoom.stepMonsters). AI state (which area it belongs to,
 * the current roam target and autopilot trip, the pause deadline) is
 * SERVER-ONLY: plain class fields NOT in defineTypes, so they never sync.
 */
export class Monster extends Schema {
  declare kind: string; // one of MONSTER_KINDS (drives which sprite/strip to draw)
  declare x: number; // authoritative world-unit position
  declare y: number;
  declare dir: string; // Direction name (from stepMovement) — 8-dir facing
  declare moving: boolean; // true while hopping — drives walk anim vs freeze on pause
  declare elev: number; // surface elevation in LEVELS (client lift + y-sort, like Player)

  // Server-only AI state (NOT synced). ------------------------------------
  areaId = ""; // which SpawnArea this monster roams inside
  targetX = 0; // current roam goal (world units)
  targetY = 0;
  tripActive = false; // true while an autopilot trip is in flight
  trip: AutopilotTrip | null = null; // handle from startTrip(); stepped via stepAutopilot
  nextMoveAt = 0; // Date.now() ms deadline: when paused, pick the next target after this

  constructor() {
    super();
    this.kind = "";
    this.x = 0;
    this.y = 0;
    this.dir = DEFAULT_DIRECTION;
    this.moving = false;
    this.elev = 0;
  }
}

defineTypes(Monster, {
  kind: "string",
  x: "number",
  y: "number",
  dir: "string",
  moving: "boolean",
  elev: "number",
});

/** The whole shared world. Everyone connected is in this one state. */
export class WorldState extends Schema {
  declare players: MapSchema<Player>;
  declare monsters: MapSchema<Monster>;
  declare timeIdx: number; // shared time-of-day phase (server-owned)
  declare phaseT: number; // continuous progress 0..1 through the phase (clock hand/sun sweep smoothly)
  declare weather: number; // shared weather layer (server-owned; 0 = clear)
  declare aurora: boolean; // aurora night: northern lights over the world
  declare frozen: boolean; // timeSpeed === 0 mirror (kept for the switch/UI)
  declare timeSpeed: number; // world-clock speed multiplier (TIME_SPEEDS)

  constructor() {
    super();
    this.players = new MapSchema<Player>();
    this.monsters = new MapSchema<Monster>();
    this.timeIdx = DEFAULT_TIME_IDX;
    this.phaseT = 0.5; // mid-phase: the exact "characteristic" look of the phase
    this.weather = 0;
    this.aurora = false;
    this.frozen = true; // frozen by default for now (maintainer: testing phases)
    this.timeSpeed = 0;
  }
}

defineTypes(WorldState, {
  players: { map: Player },
  monsters: { map: Monster },
  timeIdx: "number",
  phaseT: "number",
  weather: "number",
  aurora: "boolean",
  frozen: "boolean",
  timeSpeed: "number",
});
