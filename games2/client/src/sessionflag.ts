/** THE SESSION FLAGS, GUARDED — because `sessionStorage` is not always there.
 *
 *  A browser with site data blocked (Chrome with cookies blocked, private
 *  modes, some embedded webviews) throws on the PROPERTY ACCESS itself, not
 *  just on the write, so `sessionStorage.getItem(...)` is an expression that
 *  can raise. Every localStorage read in this client already sits in a
 *  try/catch (accel, controls, composeclient, theme, …); the session flags were
 *  the outliers, and one of them — the `ml-rejoin` read in main.ts's boot —
 *  killed the boot outright: measured with the access blocked, the select
 *  screen never came up, `__mlSelect` was absent after 31 s and there were ZERO
 *  page errors, because the throw was swallowed into a boot failure.
 *
 *  The flags are conveniences (skip the select screen on a recovery reload,
 *  remember that we came from the game, bound one boot reload per tab). Losing
 *  them costs a tap; throwing costs the game. So every one of them goes through
 *  here, reads null when storage is unavailable, and never raises.
 *
 *  Gate: arm 3 of scripts/verify-bootversion.mjs blocks both storages. */
export function sessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function sessionSet(key: string, value: string): boolean {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function sessionRemove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* nothing to remove if there is nowhere to remove it from */
  }
}
