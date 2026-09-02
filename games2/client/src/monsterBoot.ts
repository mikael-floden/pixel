/** WHICH MONSTER ART RIDES THE BOOT BATCH.
 *
 *  A world names every kind it can spawn (the_game: all 57), and loading all
 *  of their walk/idle strips before the player stands anywhere was 912 of the
 *  1,884 requests a cold boot made. The world's own spawns.json says which
 *  kinds live NEAR where the player will stand — the declared spawn, and the
 *  spot they last stood on in this world (a returning player lands on their
 *  saved spot, so that neighbourhood counts too). The rule itself is
 *  `monsterBootKinds` in shared; this module fetches its inputs.
 *
 *  `null` means "every kind at boot" — the pre-split behaviour, chosen
 *  whenever the inputs are missing (no spawns.json, no zones, a fetch error):
 *  when in doubt, include. A world with no zones spawns nothing anyway. */
import { monsterBootKinds, parseSpawns } from "@nangijala/shared";
import { worldFileUrl } from "./maps";
import { gameUrl } from "./staging";

const lastPosKey = (world: string) => `ml-lastpos:${world}`;

/** The cell the local player last stood on in this world, if known. */
export function readLastPos(world: string): [number, number] | null {
  try {
    const raw = localStorage.getItem(lastPosKey(world));
    if (!raw) return null;
    const [c, r] = raw.split(",").map(Number);
    return Number.isFinite(c) && Number.isFinite(r) ? [c, r] : null;
  } catch {
    return null;
  }
}

/** Remember where I stand (throttled by the caller; a cell is enough). */
export function writeLastPos(world: string, col: number, row: number): void {
  try {
    localStorage.setItem(lastPosKey(world), `${Math.round(col)},${Math.round(row)}`);
  } catch {}
}

export async function loadMonsterBootKinds(
  world: string,
  spawn: readonly [number, number] | null | undefined,
): Promise<Set<string> | null> {
  try {
    const res = await fetch(gameUrl(worldFileUrl(world, "spawns.json")));
    if (!res.ok) return null;
    const zones = parseSpawns(await res.json());
    if (!zones.length) return null;
    const centres: Array<readonly [number, number]> = [];
    if (spawn) centres.push(spawn);
    const last = readLastPos(world);
    if (last) centres.push(last);
    if (!centres.length) return null;
    return monsterBootKinds(zones, centres);
  } catch {
    return null;
  }
}
