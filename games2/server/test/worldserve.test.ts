// ============================================================================
// SERVE — the_game is REACHABLE, from disk and over the wire
// ============================================================================
//
// world3.test.ts proves the game can READ a `pixel-maps3/world@1` document.
// This gate proves one can be REACHED, and it covers BOTH halves of that:
//
//   • THE SERVER IS AUTHORITATIVE for collision and spawn zones, so a world
//     has to parse SERVER-SIDE. The one world tree (maps2/worlds3) is
//     exercised through the REAL readWorldDoc/loadWorldGrid — imported from
//     WorldRoom, not re-implemented — from disk AND over the wire.
//   • A NORMAL PLAYER'S PATH ISSUES NO NETWORK REQUEST: the disk read of the
//     shipped world is pinned at ZERO fetches, and a staging world absent from
//     disk issues EXACTLY one request per file, in maps2/worlds3 — there is no
//     second tree to probe (the world@1/@2 tree was retired 2026-09-09).
//
// The staging base is a LOCAL FIXTURE ORIGIN — the same injection point the
// real CDN uses (STAGING_WORLD_BASE) — because this sandbox gives no external
// egress and a gate that tested GitHub's uptime would not be testing our code.
// Headless node, no browser: nothing here needs pixels (games2/CLAUDE.md's
// fast-loop rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseWorld, CELL_WU } from "@nangijala/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const GAME3 = join(REPO, "maps2", "worlds3", "the_game");

/* -- the fixture origin ----------------------------------------------------- */
// Serves one world that exists NOWHERE on disk and logs every path it is asked
// for — the request log IS the assertion for "one request per file".
const served = new Map<string, unknown>();
const log: string[] = [];
const fixture = createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  log.push(path);
  const doc = served.get(path);
  if (doc === undefined) {
    res.writeHead(404).end("no");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(doc));
});
await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
const PORT = (fixture.address() as AddressInfo).port;

// STAGING_WORLD_BASE is read at WorldRoom's module load, so the env has to be
// set before the import — hence a dynamic one. Same reason the fixture picks
// its own port: a fixed one collides with a dev stack on the same machine.
process.env.STAGING_WORLD_BASE = `http://127.0.0.1:${PORT}`;
const room = (await import("../src/rooms/WorldRoom")) as {
  readWorldDoc(name: string, file: string): Promise<unknown | null>;
  worldRootFor(name: string): Promise<string>;
  loadWorldGrid(name: string): Promise<{
    terrain: unknown;
    spawn: { x: number; y: number } | null;
    worldW: number;
    worldH: number;
  }>;
  resetWorldSourceCaches(): void;
};

/** A minimal but REAL pixel-maps3 doc — same schema the dispatch keys on, so
 *  the fixture proves routing without pushing 1 MB per request. */
const probe3Doc = {
  schema: "pixel-maps3/world@1",
  name: "probe3",
  size: { w: 4, h: 4 },
  grounds: ["grass", "deep_water"],
  liquids: ["deep_water"],
  ground: [
    [0, 0, 0, 0],
    [0, 0, 1, 1],
    [0, 0, 1, 1],
    [0, 0, 0, 0],
  ],
  level: [
    [2, 2, 2, 2],
    [2, 2, 0, 0],
    [2, 2, 0, 0],
    [2, 2, 2, 2],
  ],
  spawn: [1, 0],
  decks: [],
  walls: [],
  scenery: [],
};
served.set("/maps2/worlds3/probe3/world.json", probe3Doc);
served.set("/maps2/worlds3/probe3/spawns.json", { schema: "pixel-maps3/spawns@1", zones: [] });

/** Run `fn` from cold caches, with the network either forbidden or logged. */
async function fromCold<T>(fn: () => Promise<T>, { offline = false } = {}): Promise<T> {
  room.resetWorldSourceCaches();
  log.length = 0;
  const real = globalThis.fetch;
  if (offline)
    globalThis.fetch = (async (u: unknown) => {
      throw new Error(`a disk-resolvable world must not touch the network (asked for ${String(u)})`);
    }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/* -- disk: the shipped world ------------------------------------------------ */

test("the_game resolves out of maps2/worlds3 from DISK, through the real server path, with zero network requests", async () => {
  if (!existsSync(GAME3)) return test.skip("maps2/worlds3/the_game missing");
  const doc = JSON.parse(readFileSync(join(GAME3, "world.json"), "utf8"));
  const grid = await fromCold(
    async () => {
      assert.equal(await room.worldRootFor("the_game"), "maps2/worlds3");
      // The SAME bytes the file holds — no rewriting, no second source.
      assert.deepEqual(await room.readWorldDoc("the_game", "world.json"), doc);
      // Sidecars follow the world into its tree.
      assert.deepEqual(
        await room.readWorldDoc("the_game", "spawns.json"),
        JSON.parse(readFileSync(join(GAME3, "spawns.json"), "utf8")),
      );
      return room.loadWorldGrid("the_game");
    },
    { offline: true },
  );
  assert.equal(doc.schema, "pixel-maps3/world@1");
  assert.ok(parseWorld(doc), "parseWorld must dispatch the maps3 schema");
  assert.ok(grid.terrain, "the world must produce a collision grid — the server owns collision");
  // The doc's own numbers, so a wrong tree or a wrong parse cannot pass.
  assert.deepEqual(grid.spawn, { x: doc.spawn[0] * CELL_WU, y: doc.spawn[1] * CELL_WU });
  assert.equal(grid.worldW, doc.size.w * CELL_WU);
  assert.equal(grid.worldH, doc.size.h * CELL_WU);
  assert.equal(log.length, 0);
});

/* -- network: the staging half ---------------------------------------------- */

test("a world absent from disk streams from maps2/worlds3 with ONE request per file", async () => {
  const grid = await fromCold(() => room.loadWorldGrid("probe3"));
  assert.ok(grid.terrain, "the server must build collision from a STREAMED maps3 doc");
  assert.deepEqual(grid.spawn, { x: 1 * CELL_WU, y: 0 * CELL_WU });
  assert.equal(grid.worldW, 4 * CELL_WU);
  // ONE request, in the ONE tree. The world.json is then served out of
  // stagingCache, so resolving the ROOT costs no extra request — the log
  // would carry a duplicate otherwise.
  assert.deepEqual(log, ["/maps2/worlds3/probe3/world.json"]);
  assert.ok(await room.readWorldDoc("probe3", "world.json"));
  assert.equal(log.length, 1, "the root resolve and the read must share one fetch");
  assert.ok(await room.readWorldDoc("probe3", "spawns.json"));
  assert.deepEqual(log, ["/maps2/worlds3/probe3/world.json", "/maps2/worlds3/probe3/spawns.json"]);
});

test("a world in no tree degrades to an open plain after exactly one probe", async () => {
  const grid = await fromCold(() => room.loadWorldGrid("no_such_world"));
  assert.equal(grid.terrain, null);
  assert.deepEqual(log, ["/maps2/worlds3/no_such_world/world.json"]);
});

/* -- the whole join, through a live room ------------------------------------ */

test("a player can actually JOIN the_game and stands on its maps3 spawn", async (t) => {
  if (!existsSync(GAME3)) return t.skip("maps2/worlds3/the_game missing");
  const { Server } = await import("@colyseus/core");
  const { WebSocketTransport } = await import("@colyseus/ws-transport");
  const { Client } = await import("colyseus.js");
  const { WorldRoom } = await import("../src/rooms/WorldRoom");
  const { ROOM_NAME } = await import("@nangijala/shared");

  const http = createServer();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: http }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  try {
    const client = new Client(`ws://127.0.0.1:${port}`);
    const joined = await client.joinOrCreate<any>(ROOM_NAME, {
      world: "the_game",
      name: "probe",
      characterUid: "humans/default_boy",
    });
    // room.state is undefined until the first patch (games2/CLAUDE.md).
    const deadline = Date.now() + 15000;
    while (!joined.state?.players?.get?.(joined.sessionId)) {
      if (Date.now() > deadline) throw new Error("no player state after join");
      await new Promise((r) => setTimeout(r, 25));
    }
    const me = joined.state.players.get(joined.sessionId);
    const doc = JSON.parse(readFileSync(join(GAME3, "world.json"), "utf8"));
    // placeAtSpawn scatters around the declared cell — the assertion is that
    // the server used THIS WORLD's spawn, not the open-plain fallback (which
    // would sit at the centre of a default 160x160 grid).
    const dist = Math.hypot(me.x - doc.spawn[0] * CELL_WU, me.y - doc.spawn[1] * CELL_WU);
    assert.ok(dist < 8 * CELL_WU, `spawned ${(dist / CELL_WU).toFixed(1)} cells from the declared spawn`);
    await joined.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

/* -- the client half: URLs, and gameUrl's identity -------------------------- */
// Imported by COMPUTED file URL on purpose: these are client modules (DOM
// globals in their types) and a static specifier would drag them into the
// server tsconfig's program. tsx resolves them at runtime all the same.
const maps = (await import(pathToFileURL(join(HERE, "..", "..", "client", "src", "maps.ts")).href)) as {
  worldUrl(n: string): string;
  worldFileUrl(n: string, f: string): string;
  worldRoot(n: string): string;
  setWorldRoot(n: string, r: string | null | undefined): void;
};
const staging = (await import(
  pathToFileURL(join(HERE, "..", "..", "client", "src", "staging.ts")).href
)) as { gameUrl(u: string): string; stagingActive(): boolean };

test("gameUrl is the IDENTITY function while staging is inactive", () => {
  assert.equal(staging.stagingActive(), false);
  for (const u of [
    "/assets/maps2/worlds3/the_game/world.json",
    "/assets/tiles/plates/index.json",
    "/assets/live/tuning/base_tile_sets.json",
    "/monsters.json",
    "/npcs.json",
    "/worlds.json",
  ])
    assert.equal(staging.gameUrl(u), u, "a normal player's URL must come back untouched");
});

test("every world addresses maps2/worlds3 — registered or not — and junk cannot register", () => {
  // A name nobody registered still answers with the one tree.
  assert.equal(maps.worldRoot("nobody_registered_me"), "maps2/worlds3");
  assert.equal(maps.worldUrl("nobody_registered_me"), "/assets/maps2/worlds3/nobody_registered_me/world.json");
  maps.setWorldRoot("the_game", "maps2/worlds3");
  assert.equal(maps.worldUrl("the_game"), "/assets/maps2/worlds3/the_game/world.json");
  for (const f of ["spawns.json", "npcs.json", "places.json"])
    assert.equal(maps.worldFileUrl("the_game", f), `/assets/maps2/worlds3/the_game/${f}`);
  // Only the known tree is accepted — a root is data off the network, and the
  // retired tree is junk now too.
  maps.setWorldRoot("evil", "../../../etc");
  maps.setWorldRoot("evil2", "https://elsewhere.example/x");
  maps.setWorldRoot("evil3", "maps2/worlds");
  assert.equal(maps.worldRoot("evil"), "maps2/worlds3");
  assert.equal(maps.worldRoot("evil2"), "maps2/worlds3");
  assert.equal(maps.worldRoot("evil3"), "maps2/worlds3");
  // The world NAME is sanitised at the join, as it always was.
  assert.equal(maps.worldFileUrl("../secret", "world.json"), "/assets/maps2/worlds3/secret/world.json");
});

/* -- the policy names it, the picker manifest carries the tree -------------- */

test("publish.json publishes the_game as a USER world, and the tiles/ domain still never ships wholesale", () => {
  const pol = JSON.parse(readFileSync(join(REPO, "games2", "config", "publish.json"), "utf8"));
  // the_game is baked into the image: the only playable world (maintainer
  // 2026-09-09: "We will commit 100% to the new tiles3 system and the new map").
  assert.ok(pol.userWorlds.includes("the_game"), "the_game is a published world");
  assert.ok(!(pol.devWorlds3 ?? []).includes("the_game"), "a world is published OR staging, never both");
  // Its terrain art enters the image ONLY as the resolver's closure
  // (scripts/ship-tiles3.ts in the Dockerfile's build stage) — the ~400 MB
  // tiles/ domain must never be shipped as a whole or per entity.
  assert.ok(!(pol.alwaysShip ?? []).includes("tiles"), "tiles/ must not ship wholesale");
  assert.ok(!(pol.entityDomains ?? []).includes("tiles"), "tiles/ must not ship per entity");
});

test("worlds.json carries the tree and schema for the_game", () => {
  const wl = JSON.parse(readFileSync(join(REPO, "games2", "client", "public", "worlds.json"), "utf8"));
  const game = wl.find((w: { name: string }) => w.name === "the_game");
  if (!game) return test.skip("maps2/worlds3 not checked out");
  assert.equal(game.root, "maps2/worlds3");
  assert.equal(game.dev, undefined, "a published world is offered to every player");
  assert.equal(game.schema, "pixel-maps3/world@1");
});

test.after(() => fixture.close());
