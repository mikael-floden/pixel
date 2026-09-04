/** THE JOIN TIMEOUT RACE — pure, and in its own file so the server test project
 *  can import it without dragging `location` and `import.meta.env` in with it.
 *
 *  Separated from `joinWorld` so the ordering below can be TESTED rather than
 *  reasoned about: the first cut set its flag after the race resolved, a full
 *  microtask too late, and leaked a `leave()` onto every healthy join. */

/** Resolve with `pending` if it settles before the deadline; reject on the
 *  deadline and hand a late arrival to `onLate` so it cannot become an orphan.
 *  `timeoutMs` of 0 opts out and returns `pending` untouched. */
export async function withJoinTimeout<T>(
  pending: Promise<T>,
  timeoutMs: number,
  onLate: (value: T) => void,
): Promise<T> {
  if (!timeoutMs) return pending;
  /* THE FLAG IS SET BY THE TIMEOUT, NOT BY SUCCESS. `pending` settling queues
   * BOTH the race's handler and the late-arrival handler below, and the latter
   * can run first — which would leave the room we just successfully joined. */
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`join timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  // Never let the abandoned attempt become an orphan connection, and never let
  // its rejection surface as an unhandled one.
  void pending.then(
    (v) => {
      if (timedOut) onLate(v);
    },
    () => {},
  );
  try {
    return await Promise.race([pending, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
