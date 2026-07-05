// Headless persistence check: join with a token, move, leave, rejoin with the
// same token → position is restored (not re-spawned at centre).
import { Client } from "colyseus.js";
import { ROOM_NAME } from "@nangijala/shared";

const ENDPOINT = process.env.ENDPOINT || "ws://localhost:2567";
const TOKEN = "persist-test-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const c1 = new Client(ENDPOINT);
const r1 = await c1.joinOrCreate(ROOM_NAME, { token: TOKEN, name: "Saver", character: "sk/c0" });
await sleep(300);
// Walk east for ~1s.
for (let i = 0; i < 25; i++) {
  r1.send("input", { ax: 1, ay: 0, running: false, seq: i });
  await sleep(40);
}
r1.send("input", { ax: 0, ay: 0, running: false, seq: 99 });
await sleep(200);
const savedX = r1.state.players.get(r1.sessionId).x;
await r1.leave(); // triggers server-side save
await sleep(300);

const c2 = new Client(ENDPOINT);
const r2 = await c2.joinOrCreate(ROOM_NAME, { token: TOKEN, name: "Saver", character: "sk/c0" });
await sleep(300);
const restoredX = r2.state.players.get(r2.sessionId).x;
await r2.leave();

console.log("RESULT " + JSON.stringify({ savedX, restoredX, diff: Math.abs(savedX - restoredX) }));
if (Math.abs(savedX - restoredX) > 2) throw new Error("position not restored on rejoin");
console.log("PERSIST OK");
process.exit(0);
