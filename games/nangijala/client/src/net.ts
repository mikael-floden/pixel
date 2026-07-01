import { Client, Room } from "colyseus.js";
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

export async function joinWorld(options: JoinOptions): Promise<Room> {
  const client = new Client(serverEndpoint());
  return client.joinOrCreate(ROOM_NAME, { token: getPlayerToken(), ...options });
}
