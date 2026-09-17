// THE BACKPACK'S ORDER IS SERVER STATE — dragging a slot has to be a message.
//
// "drag an item to a different item's slot so they change place … the item at
// that spot will animate towards the item I'm dragging's location" (maintainer
// 2026-09-17). `player.inv` is re-sent on every change, so a client-side
// reorder reverts on the next refresh; `invmove` is where it lives.
//
// A drag SWAPS, it does not insert: the two entries trade places and nothing
// else moves — the HUD previews exactly that while the finger is down, so the
// drop must do exactly that. Both slots must hold an entry: the list is
// compacted (an emptied stack is spliced out), the grid's empty cells are past
// the end, and a swap with nothing is refused rather than turned into "put it
// last".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOM_NAME, swapInvEntries } from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";

const HAVE_WORLD = existsSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"),
);

const inv = (...ids: string[]) => ids.map((item) => ({ item, n: 1 }));
const ids = (list: { item: string }[]) => list.map((s) => s.item);

test("a drag swaps two entries and moves nothing else", () => {
  const a = inv("axe", "rope", "torch", "bread");
  assert.equal(swapInvEntries(a, 0, 2), true);
  assert.deepEqual(ids(a), ["torch", "rope", "axe", "bread"], "forward: the two trade places, rope and bread stay put");
  const b = inv("axe", "rope", "torch", "bread");
  assert.equal(swapInvEntries(b, 3, 1), true);
  assert.deepEqual(ids(b), ["axe", "bread", "torch", "rope"], "backward: the same swap from the other end");
  // NOT AN INSERT: an insert-move of 0 → 2 would give rope, torch, axe, bread —
  // two bystanders shifted. That was the first version and it is the one
  // behaviour the preview he asked for cannot show.
  const c = inv("axe", "rope");
  assert.equal(swapInvEntries(c, 0, 99), false, "a drop past the last cell is not a swap");
  assert.deepEqual(ids(c), ["axe", "rope"], "…and nothing moved");
});

test("nothing moves on a stale slot, a bad index, or a drag onto itself", () => {
  const a = inv("axe", "rope");
  assert.equal(swapInvEntries(a, 0, 0), false, "onto itself");
  assert.equal(swapInvEntries(a, -1, 1), false, "before the list");
  assert.equal(swapInvEntries(a, 2, 0), false, "past the list");
  assert.equal(swapInvEntries(a, 0, -1), false, "onto a slot before the list");
  assert.equal(swapInvEntries(a, NaN, 0), false, "not a number");
  assert.deepEqual(ids(a), ["axe", "rope"], "and the list is untouched");
  // THE STALE SLOT, which is the whole reason the message carries the item id:
  // a stack that empties splices out and everything after it slides up, so the
  // index the grid was drawn with names a different entry by the time the drag
  // lands.
  assert.equal(swapInvEntries(a, 0, 1, "rope"), false, "the id at that slot is not the one dragged");
  assert.deepEqual(ids(a), ["axe", "rope"]);
  assert.equal(swapInvEntries(a, 0, 1, "axe"), true, "…and it swaps when they agree");
  assert.deepEqual(ids(a), ["rope", "axe"]);
});

test("the room swaps on `invmove` and echoes the inventory", { skip: !HAVE_WORLD && "the_game missing" }, async () => {
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
    assert.deepEqual(ids(player.inv), ["torch", "rope", "axe"], "the server's own order swapped the two");
    assert.deepEqual(ids(invs[invs.length - 1].items), ["torch", "rope", "axe"], "and the echo carries it");
    // (`player.dirty` is set by the handler and CLEARED by the next save flush,
    // which can land between the send and this line — persistence has its own
    // arm in combat.test.ts rather than a race here.)
    // A STALE DRAG CHANGES NOTHING and still heals the grid.
    await new Promise((r) => setTimeout(r, 120)); // the item clock
    const before2 = invs.length;
    room.send("invmove", { from: 0, to: 2, item: "axe" }); // "axe" is at 2 now
    await waitFor(() => invs.length > before2, 4000, "the refusal still echoes");
    assert.deepEqual(ids(player.inv), ["torch", "rope", "axe"], "…and the order is untouched");
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
