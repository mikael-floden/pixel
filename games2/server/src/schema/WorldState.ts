import { Schema, MapSchema, defineTypes } from "@colyseus/schema";
import { DEFAULT_DIRECTION, DEFAULT_TIME_IDX, MAX_STAMINA } from "@nangijala/shared";

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
});

/** The whole shared world. Everyone connected is in this one state. */
export class WorldState extends Schema {
  declare players: MapSchema<Player>;
  declare timeIdx: number; // shared time-of-day phase (server-owned)
  declare weather: number; // shared weather layer (server-owned; 0 = clear)
  declare aurora: boolean; // aurora night: northern lights over the world

  constructor() {
    super();
    this.players = new MapSchema<Player>();
    this.timeIdx = DEFAULT_TIME_IDX;
    this.weather = 0;
    this.aurora = false;
  }
}

defineTypes(WorldState, {
  players: { map: Player },
  timeIdx: "number",
  weather: "number",
  aurora: "boolean",
});
