// ============================================================================
// SERVE — a maps3 world is REACHABLE, and a maps2 world is untouched
// ============================================================================
//
// Milestone 1 taught the game to READ a `pixel-maps3/world@1` document
// (world3.test.ts). Nothing could REACH one: build-worlds.mjs globbed only
// maps2/worlds, config/publish.json named no maps3 world, and WorldRoom's
// readWorldDoc hardcoded the maps2/worlds path. This gate covers the fix, and
// it covers BOTH halves of "reachable":
//
//   • THE SERVER IS AUTHORITATIVE for collision and spawn zones, so a world the
//     image lacks has to parse SERVER-SIDE. Both trees are exercised through
//     the REAL readWorldDoc/loadWorldGrid — imported from WorldRoom, not
//     re-implemented — from disk AND over the wire.
//   • A NORMAL PLAYER'S PATH IS BYTE-IDENTICAL. Two independent pins: the disk
//     read of a shipped world issues ZERO network requests, and a maps2
//     staging world issues EXACTLY the requests it issued before worlds3
//     existed (one per file, in maps2/worlds, no second-tree probe).
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
const ISLAND2 = join(REPO, "maps2", "worlds", "the_island2");
const GAME3 = join(REPO, "maps2", "worlds3", "the_game");

/* -- the fixture origin ----------------------------------------------------- */
// Serves exactly two worlds that exist NOWHERE on disk and logs every path it
// is asked for — the request log IS the assertion for "resolves as before".
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
 *  the fixture proves routing without pushing 1.2 MB per request. */
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
const probe2Doc = {
  schema: "pixel-maps2/world@1",
  size: { w: 2, h: 2 },
  paths: ["tiles2/x/tile_00.webp"],
  materials: ["grass"],
  mat: [
    [0, 0],
    [0, 0],
  ],
  top: [
    [0, 0],
    [0, 0],
  ],
  level: [
    [0, 0],
    [0, 0],
  ],
  spawn: [1, 1],
};
served.set("/maps2/worlds3/probe3/world.json", probe3Doc);
served.set("/maps2/worlds3/probe3/spawns.json", { schema: "pixel-maps2/spawns@1", zones: [] });
served.set("/maps2/worlds/probe2/world.json", probe2Doc);
served.set("/maps2/worlds/probe2/spawns.json", { schema: "pixel-maps2/spawns@1", zones: [] });

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

/* -- disk: the live game, unchanged ---------------------------------------- */

test("a shipped maps2 world resolves from DISK with zero network requests", async () => {
  if (!existsSync(ISLAND2)) return test.skip("maps2/worlds/the_island2 missing");
  const grid = await fromCold(
    async () => {
      assert.equal(await room.worldRootFor("the_island2"), "maps2/worlds");
      const doc = await room.readWorldDoc("the_island2", "world.json");
      assert.deepEqual(doc, JSON.parse(readFileSync(join(ISLAND2, "world.json"), "utf8")));
      assert.deepEqual(
        await room.readWorldDoc("the_island2", "spawns.json"),
        JSON.parse(readFileSync(join(ISLAND2, "spawns.json"), "utf8")),
      );
      return room.loadWorldGrid("the_island2");
    },
    { offline: true },
  );
  // The_island2's own numbers, so a wrong tree or a wrong parse cannot pass.
  assert.ok(grid.terrain, "the live world must produce a collision grid");
  assert.deepEqual(grid.spawn, { x: 201 * CELL_WU, y: 120 * CELL_WU });
  assert.equal(grid.worldW, 248 * CELL_WU);
  assert.equal(grid.worldH, 248 * CELL_WU);
  assert.equal(log.length, 0);
});

/* -- disk: the maps3 world -------------------------------------------------- */

test("the_game resolves out of maps2/worlds3 and parses through the real server path", async () => {
  if (!existsSync(GAME3)) return test.skip("maps2/worlds3/the_game missing");
  const doc = JSON.parse(readFileSync(join(GAME3, "world.json"), "utf8"));
  const grid = await fromCold(
    async () => {
      assert.equal(await room.worldRootFor("the_game"), "maps2/worlds3");
      // The SAME bytes the file holds — no rewriting, no second source.
      assert.deepEqual(await room.readWorldDoc("the_game", "world.json"), doc);
      // Sidecars follow the world into ITS tree; searching maps2/worlds for
      // them would be one pointless 404 per file on the staging path.
      assert.deepEqual(
        await room.readWorldDoc("the_game", "spawns.json"),
        JSON.parse(readFileSync(join(GAME3, "spawns.json"), "utf8")),
      );
      return room.loadWorldGrid("the_game");
    },
    { offline: true },
  );
  assert.equal(doc.schema, "pixel-maps3/world@1");
  assert.ok(parseWorld(doc), "parseWorld must dispatch the maps3 schema (milestone 1)");
  assert.ok(grid.terrain, "a maps3 world must produce a collision grid — the server owns collision");
  assert.deepEqual(grid.spawn, { x: doc.spawn[0] * CELL_WU, y: doc.spawn[1] * CELL_WU });
  assert.equal(grid.worldW, 512 * CELL_WU);
  assert.equal(grid.worldH, 512 * CELL_WU);
  assert.equal(log.length, 0);
});

/* -- network: the staging half, both trees --------------------------------- */

test("a maps2 world absent from disk streams with EXACTLY the old request set", async () => {
  const grid = await fromCold(() => room.loadWorldGrid("probe2"));
  assert.ok(grid.terrain);
  assert.deepEqual(grid.spawn, { x: 1 * CELL_WU, y: 1 * CELL_WU });
  // ONE request, in the first tree. A second-tree probe here would be the
  // regression: every existing dev world would pay a 404 per file.
  assert.deepEqual(log, ["/maps2/worlds/probe2/world.json"]);
  assert.ok(await room.readWorldDoc("probe2", "spawns.json"));
  assert.deepEqual(log, ["/maps2/worlds/probe2/world.json", "/maps2/worlds/probe2/spawns.json"]);
});

test("a maps3 world absent from disk streams from maps2/worlds3", async () => {
  const grid = await fromCold(() => room.loadWorldGrid("probe3"));
  assert.ok(grid.terrain, "the server must build collision from a STREAMED maps3 doc");
  assert.deepEqual(grid.spawn, { x: 1 * CELL_WU, y: 0 * CELL_WU });
  assert.equal(grid.worldW, 4 * CELL_WU);
  // The first tree is probed first and misses; the second answers. The
  // world.json is then served out of stagingCache, so resolving the ROOT costs
  // no extra request — the log would carry a duplicate otherwise.
  assert.deepEqual(log, ["/maps2/worlds/probe3/world.json", "/maps2/worlds3/probe3/world.json"]);
  assert.ok(await room.readWorldDoc("probe3", "world.json"));
  assert.equal(log.length, 2, "the root resolve and the read must share one fetch");
  assert.ok(await room.readWorldDoc("probe3", "spawns.json"));
  assert.deepEqual(log[2], "/maps2/worlds3/probe3/spawns.json");
});

test("a world in neither tree degrades to an open plain, as before", async () => {
  const grid = await fromCold(() => room.loadWorldGrid("no_such_world"));
  assert.equal(grid.terrain, null);
  assert.deepEqual(log, [
    "/maps2/worlds/no_such_world/world.json",
    "/maps2/worlds3/no_such_world/world.json",
  ]);
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
    "/assets/maps2/worlds/the_island2/world.json",
    "/assets/maps2/worlds3/the_game/world.json",
    "/assets/tiles/plates/index.json",
    "/assets/live/tuning/base_tile_sets.json",
    "/atlases/the_island2.json",
    "/monsters.json",
    "/npcs.json",
    "/worlds.json",
  ])
    assert.equal(staging.gameUrl(u), u, "a normal player's URL must come back untouched");
});

test("an unregistered world keeps the exact maps2/worlds URL it always had", () => {
  assert.equal(maps.worldRoot("the_island2"), "maps2/worlds");
  assert.equal(maps.worldUrl("the_island2"), "/assets/maps2/worlds/the_island2/world.json");
  assert.equal(maps.worldFileUrl("the_island2", "npcs.json"), "/assets/maps2/worlds/the_island2/npcs.json");
});

test("a registered maps3 world addresses its own tree, and junk cannot register", () => {
  maps.setWorldRoot("the_game", "maps2/worlds3");
  assert.equal(maps.worldUrl("the_game"), "/assets/maps2/worlds3/the_game/world.json");
  for (const f of ["spawns.json", "npcs.json", "places.json"])
    assert.equal(maps.worldFileUrl("the_game", f), `/assets/maps2/worlds3/the_game/${f}`);
  // Only the two known trees are accepted — a root is data off the network.
  maps.setWorldRoot("evil", "../../../etc");
  maps.setWorldRoot("evil2", "https://elsewhere.example/x");
  assert.equal(maps.worldRoot("evil"), "maps2/worlds");
  assert.equal(maps.worldRoot("evil2"), "maps2/worlds");
  // The world NAME is sanitised at the join, as it always was.
  assert.equal(maps.worldFileUrl("../secret", "world.json"), "/assets/maps2/worlds/secret/world.json");
});

/* -- the policy names it, the picker manifest carries the tree -------------- */

test("publish.json offers the_game as a DEV world and ships nothing for it", () => {
  const pol = JSON.parse(readFileSync(join(REPO, "games2", "config", "publish.json"), "utf8"));
  assert.deepEqual(pol.devWorlds3, ["the_game"]);
  assert.ok(!pol.userWorlds.includes("the_game"), "a maps3 world must never be in the ship-set roots");
  assert.ok(!(pol.alwaysShip ?? []).includes("tiles"), "tiles3 art must not enter the image");
  assert.ok(!(pol.entityDomains ?? []).includes("tiles"), "tiles3 art must not enter the image");
});

test("worlds.json carries the tree for a maps3 world and omits it for maps2", () => {
  const wl = JSON.parse(readFileSync(join(REPO, "games2", "client", "public", "worlds.json"), "utf8"));
  const island = wl.find((w: { name: string }) => w.name === "the_island2");
  if (island) assert.equal("root" in island, false, "the default tree stays omitted — those rows must not move");
  const game = wl.find((w: { name: string }) => w.name === "the_game");
  if (!game) return test.skip("maps2/worlds3 not checked out");
  assert.equal(game.root, "maps2/worlds3");
  assert.equal(game.dev, true, "a maps3 world is never offered to a normal player");
  assert.equal(game.schema, "pixel-maps3/world@1");
});

test.after(() => fixture.close());
