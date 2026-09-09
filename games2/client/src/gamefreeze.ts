/**
 * FREEZE THE WORLD WHILE A FULL-SCREEN READER IS UP (maintainer 2026-08-13:
 * "the wiki lags a bit when opened on top of the game — can you freeze or
 * pause the game rendering when the wiki is open?").
 *
 * The wiki drawer hosts a whole SECOND DOCUMENT in an iframe, and it is laid
 * out, styled and painted on the SAME main thread the game loop runs on. Every
 * frame Phaser spends on a world nobody can see — the drawer covers 88% of it
 * and the rest is under a 62% scrim — is a frame the wiki does not get, and
 * the scrolling stutters for it.
 *
 * So the loop is put to SLEEP for as long as the drawer is up. `TimeStep.sleep()`
 * cancels the requestAnimationFrame outright: no update, no render, no GPU
 * work, nothing left to compete with. `wake()` starts it again and ticks one
 * frame synchronously, so the world is already repainted before the drawer has
 * finished sliding away.
 *
 * WHY THE REST OF THE CLIENT DOESN'T CARE. Nothing that has to keep working
 * while you read is driven by Phaser's loop: the Colyseus socket is
 * event-driven (state patches keep arriving, the room never notices you went
 * quiet, and a drop still triggers its own rejoin), the composer schedules
 * against the WebAudio clock (the score plays on), and the HUD is plain DOM.
 * What DOES stop is `predictAndSend` — which is the behaviour you want:
 * `WorldRoom` integrates only the inputs it actually receives, so a frozen
 * client stands still instead of coasting into a cliff while its player reads.
 * On the way back, bodies that moved more than two cells snap rather than ease
 * (WorldScene's own teleport rule), so a long read doesn't slide the world
 * into place.
 *
 * WAKING UP IS NOT `TimeStep.resume()`. That is Phaser's BACKGROUNDED-TAB
 * recovery and it arms a panic cooldown — `_coolDown = panicMax` (120) — which
 * clamps every delta to the 16.7ms target for the next 120 FRAMES. On a device
 * already rendering slower than 60fps that is visible slow motion: measured
 * here at 16.7ms of game time per 167ms of real time, and the player walked
 * 20wu where an unfrozen client walked 151. It is the right recovery for a tab
 * that really lost minutes of wall clock; it is the wrong one for a drawer that
 * closed. All we actually need is for the first frame back not to be charged
 * for the whole read, and that is one field: `lastTime`. `wake()` ticks
 * immediately, `step()` computes `now - lastTime`, so moving lastTime to now
 * makes that a ~0ms frame with no cooldown behind it. `time` (the clock's
 * real-world accumulator) moves with it to stay honest.
 *
 * Ownership: the freeze is asked for by the wiki drawer (wikipanel.ts) and the
 * game handle is registered by main.ts — this module is the seam between them,
 * so neither has to know about the other.
 */

/** Phaser's TimeStep + Game, structurally — so this module stays Phaser-free. */
type GameLoop = {
  running: boolean;
  frame: number;
  /** Timestamp of the last step; `step()` charges `now - lastTime` as delta. */
  lastTime: number;
  /** The clock's real-world accumulator, advanced by each step's raw delta. */
  time: number;
  sleep(): void;
  wake(seamless?: boolean): void;
};
type GameLike = { loop: GameLoop };

let game: GameLike | null = null;
/** True only while the loop is asleep BECAUSE OF US — never wake someone
 * else's sleep (a loop we found already stopped is not ours to restart). */
let frozen = false;

/** main.ts hands over the game the moment it exists. Before that — the select
 * screen, where the wiki is also reachable — every call here is a no-op. */
export function registerGame(g: GameLike): void {
  game = g;
  installProbe();
}

export function freezeGame(): void {
  const loop = game?.loop;
  if (frozen || !loop || !loop.running) return;
  frozen = true;
  loop.sleep();
}

export function thawGame(): void {
  const loop = game?.loop;
  if (!frozen) return;
  frozen = false;
  if (!loop) return;
  // Don't bill the read to the first frame — see the note above on why this is
  // `lastTime` and not `resume()`.
  const now = performance.now();
  loop.time += now - loop.lastTime;
  loop.lastTime = now;
  loop.wake(); // ticks one step synchronously, so we repaint at once
}

export const gameFrozen = (): boolean => frozen;

/** QA probe. Its OWN namespace: WorldScene assigns `__ml` wholesale, so
 * anything hung off that gets overwritten when the scene comes up. `frame` is
 * Phaser's own step counter — the one number that can prove the loop really
 * stopped rather than merely claiming to have. */
function installProbe(): void {
  (window as unknown as { __mlFreeze?: unknown }).__mlFreeze = {
    frozen: () => frozen,
    running: () => !!game?.loop?.running,
    frame: () => game?.loop?.frame ?? -1,
  };
}
