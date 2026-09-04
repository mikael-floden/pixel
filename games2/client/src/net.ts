import { Client, Room } from "colyseus.js";
import { withJoinTimeout } from "./jointimeout";
import { ROOM_NAME, JoinOptions } from "@nangijala/shared";

/** Resolve the world-server endpoint.
 *
 * - `VITE_SERVER_URL` always wins (explicit override).
 * - Production build: same origin (server serves the client + WS on one port),
 *   so `wss://host` on https and `ws://host` otherwise.
 * - Dev: the Colyseus server runs separately on :2567.
 */
export function serverEndpoint(): string {
  const override = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (override) return override;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  if (import.meta.env.PROD) return `${proto}://${location.host}`;
  return `${proto}://${location.hostname}:2567`;
}

/** A stable per-browser id used for persistence (created once, kept in localStorage). */
export function getPlayerToken(): string {
  const KEY = "ml-token";
  let token = localStorage.getItem(KEY) || "";
  if (!token) {
    token = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem(KEY, token);
  }
  return token;
}

/** A JOIN THAT CANNOT HANG FOREVER (maintainer 2026-09-04, third report:
 *  "I'm also stuck in 'Reconnecting...' when I tabbed back in again").
 *
 *  `joinOrCreate` does an HTTP seat reservation and then opens a WebSocket. If
 *  either stalls, the promise NEVER SETTLES — and a promise that never settles
 *  cannot be caught. WorldScene.handleDrop awaits exactly this, so a stalled
 *  connect skipped its catch, its backoff, its six retries and the reload
 *  backstop underneath them, and the toast sat there for good. It is the
 *  ordinary case on a phone: backgrounding a tab leaves a half-open socket
 *  that neither delivers nor errors until the OS reaps it, which is precisely
 *  "tabbed back in".
 *
 *  15 s is far past a healthy join (well under 2 s) and is not the thing that
 *  gives up — it turns a permanent hang back into a FAILURE, which the caller
 *  already knows how to handle: back off, retry, and reload after six.
 *
 *  A LATE ARRIVAL IS CLOSED. If the abandoned join lands after the timeout it
 *  is a live room nobody holds a reference to — a second connection for the
 *  same player, still receiving state, doubling everything the next rejoin
 *  adds. It gets left. */
const JOIN_TIMEOUT_MS = 15_000;

/** RECLAIM THE SEAT IF THE SERVER IS STILL HOLDING IT.
 *
 *  The server holds a dropped seat for RECONNECT_GRACE_S (WorldRoom.onLeave),
 *  and reclaiming it keeps the SAME player entity — position, inventory and the
 *  inputs the server had not yet acked. Joining fresh instead builds a new
 *  player anchored at the last acked position, which is what threw the
 *  maintainer around the map every time his train lost signal.
 *
 *  Kept in memory only. A reconnection token is one-shot and seat-scoped; a
 *  stale one from a previous page load names a seat that is long gone, so
 *  persisting it would trade this bug for a slower failure on every boot. */
let reconnectionToken: string | null = null;

/** Remember the seat this room holds, for the next drop. */
export function rememberSeat(room: Room): void {
  reconnectionToken = room.reconnectionToken ?? null;
}

/** Forget it — a consented leave, or a reclaim that the server refused. */
export function forgetSeat(): void {
  reconnectionToken = null;
}

export async function joinWorld(
  options: JoinOptions,
  room: string = ROOM_NAME,
  timeoutMs: number = JOIN_TIMEOUT_MS,
): Promise<Room> {
  const client = new Client(serverEndpoint());
  if (reconnectionToken) {
    const token = reconnectionToken;
    // One attempt. If the grace has expired the server answers with an error
    // and we fall through to a normal join rather than retrying a dead seat.
    try {
      const back = await withJoinTimeout(client.reconnect(token), timeoutMs, (r) => void r.leave(false));
      rememberSeat(back);
      return back;
    } catch {
      forgetSeat();
    }
  }
  const joining = client.joinOrCreate(room, { token: getPlayerToken(), ...options });
  const joined = await withJoinTimeout(joining, timeoutMs, (r) => void r.leave(false));
  rememberSeat(joined);
  return joined;
}
