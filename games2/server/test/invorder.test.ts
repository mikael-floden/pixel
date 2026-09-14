// THE BACKPACK'S ORDER IS SERVER STATE — dragging a slot has to be a message.
//
// "dragging an item onto another slot to move or swap it" (maintainer
// 2026-09-14, his third backpack ask, relayed by games-ui-assistant, who has
// the HUD half). `player.inv` is re-sent on every change, so a client-side
// reorder reverts on the next refresh; `invmove` is where it lives.
//
// A drag MOVES rather than swaps: the entry comes out and goes back in at the
// target and the rest close up behind it, which is what dragging one cell onto
// another does in a list with no holes. The list IS compacted (an emptied stack
// is spliced out), so the grid's empty cells are past the end and a drop there
// means "put it last".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOM_NAME, moveInvEntry } from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";

const HAVE_WORLD = existsSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"),
);

const inv = (...ids: string[]) => ids.map((item) => ({ item, n: 1 }));
const ids = (list: { item: string }[]) => list.map((s) => s.item);

test("a drag moves an entry and closes the list behind it", () => {
  const a = inv("axe", "rope", "torch", "bread");
  assert.equal(moveInvEntry(a, 0, 2), true);
  assert.deepEqual(ids(a), ["rope", "torch", "axe", "bread"], "forward: it lands AT the target index");
  const b = inv("axe", "rope", "torch", "bread");
  assert.equal(moveInvEntry(b, 3, 1), true);
  assert.deepEqual(ids(b), ["axe", "bread", "rope", "torch"], "backward: the rest shift down");
  const c = inv("axe", "rope");
  assert.equal(moveInvEntry(c, 0, 99), true, "a drop past the last cell is a drop at the end");
  assert.deepEqual(ids(c), ["rope", "axe"]);
});

test("nothing moves on a stale slot, a bad index, or a drag onto itself", () => {
  const a = inv("axe", "rope");
  assert.equal(moveInvEntry(a, 0, 0), false, "onto itself");
  assert.equal(moveInvEntry(a, -1, 1), false, "before the list");
  assert.equal(moveInvEntry(a, 2, 0), false, "past the list");
  assert.equal(moveInvEntry(a, NaN, 0), false, "not a number");
  assert.deepEqual(ids(a), ["axe", "rope"], "and the list is untouched");
  // THE STALE SLOT, which is the whole reason the message carries the item id:
  // a stack that empties splices out and everything after it slides up, so the
  // index the grid was drawn with names a different entry by the time the drag
  // lands.
  assert.equal(moveInvEntry(a, 0, 1, "rope"), false, "the id at that slot is not the one dragged");
  assert.deepEqual(ids(a), ["axe", "rope"]);
  assert.equal(moveInvEntry(a, 0, 1, "axe"), true, "…and it moves when they agree");
  assert.deepEqual(ids(a), ["rope", "axe"]);
});

test("the room reorders on `invmove` and echoes the inventory", { skip: !HAVE_WORLD && "the_game missing" }, async () => {
  const http = createServer();
  const gs = new Server({ transport: new WebSocketTransport({ server: http }) });
  gs.define(ROOM_NAME, WorldRoom);
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as { port: number }).port;
  const client = new Client(`ws://127.0.0.1:${port}`);
  try {
    const room = await client.joinOrCreate(ROOM_NAME, { name: "Packer", characterUid: "default_boy" });
    const invs: { items: { item: string; n: number }[] }[] = [];
    room.onMessage("inv", (m: any) => invs.push(m));
    // Every other message the room may send while we wait.
    for (const t of ["chat", "star", "live:update", "hurt", "level"]) room.onMessage(t, () => {});
    // The room object itself, in this process (the pattern playerspeed.test.ts
    // uses): seed a backpack rather than farm three kills for loot — the pickup
    // path has its own gate in combat.test.ts.
    const worldRoom: any = matchMaker.getLocalRoomById(room.roomId);
    assert.ok(worldRoom, "the room is reachable in-process");
    const player = [...worldRoom.state.players.values()][0];
    assert.ok(player, "the player joined");
    player.inv.length = 0;
    player.inv.push({ item: "axe", n: 1 }, { item: "rope", n: 2 }, { item: "torch", n: 1 });
    const before = invs.length;
    room.send("invmove", { from: 0, to: 2, item: "axe" });
    await waitFor(() => invs.length > before, 4000, "the room echoed the inventory");
    assert.deepEqual(ids(player.inv), ["rope", "torch", "axe"], "the server's own order moved");
    assert.deepEqual(ids(invs[invs.length - 1].items), ["rope", "torch", "axe"], "and the echo carries it");
    // (`player.dirty` is set by the handler and CLEARED by the next save flush,
    // which can land between the send and this line — persistence has its own
    // arm in combat.test.ts rather than a race here.)
    // A STALE DRAG CHANGES NOTHING and still heals the grid.
    await new Promise((r) => setTimeout(r, 120)); // the item clock
    const before2 = invs.length;
    room.send("invmove", { from: 0, to: 2, item: "axe" }); // "axe" is at 2 now
    await waitFor(() => invs.length > before2, 4000, "the refusal still echoes");
    assert.deepEqual(ids(player.inv), ["rope", "torch", "axe"], "…and the order is untouched");
    await room.leave();
  } finally {
    await gs.gracefullyShutdown(false);
    await new Promise<void>((r) => http.close(() => r()));
  }
});

async function waitFor(cond: () => boolean, timeout = 8000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!(() => {
    try {
      return cond();
    } catch {
      return false;
    }
  })()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}
