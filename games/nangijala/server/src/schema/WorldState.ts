import { Schema, MapSchema, defineTypes } from "@colyseus/schema";
import { DEFAULT_DIRECTION } from "@nangijala/shared";

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

  // Server-only (not synced): latest input + rate-limit bookkeeping.
  inputAx = 0;
  inputAy = 0;
  inputRunning = false;
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
});

/** The whole shared world. Everyone connected is in this one state. */
export class WorldState extends Schema {
  declare players: MapSchema<Player>;

  constructor() {
    super();
    this.players = new MapSchema<Player>();
  }
}

defineTypes(WorldState, {
  players: { map: Player },
});
