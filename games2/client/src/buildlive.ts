/** A NEW BUILD, ANNOUNCED ON THE SOCKET INSTEAD OF WAITED FOR.
 *
 *  main.ts polls /version once a minute and only ever OFFERS the banner (the
 *  maintainer's rule: a live session is never reloaded under him). Those are
 *  two separate waits — the deploy landing, then up to 60 s before the page
 *  asks — and the second one is what makes a person sit and refresh. The
 *  server now broadcasts `build:live` the moment the store flips
 *  (server/src/bundlestore.ts), WorldScene relays it here, and main.ts turns
 *  it into the same banner the poll would have raised a minute later.
 *
 *  WHY A MODULE AND NOT A DIRECT CALL: showUpdateBanner is private to main.ts,
 *  and main.ts imports WorldScene — importing back would be a cycle. One
 *  handler, registered by whoever owns the banner, called by whoever hears the
 *  news. Nothing here knows what the banner is.
 *
 *  It never throws into the scene's message handler, and a message arriving
 *  before boot has registered anything is simply dropped: the minute poll is
 *  the belt under all of this and converges on its own. */
let handler: ((sha: string) => void) | null = null;
let socketUp = false;

/** Set by WorldScene when the room's socket comes up and when it goes away.
 *  It is what lets the /version poll be SLOW while the socket is carrying the
 *  news and FAST when nothing is: the select screen, the loading screen and a
 *  dropped connection have no socket, and those are exactly the pages that
 *  would otherwise sit up to a minute behind a deploy. */
export function buildSocket(up: boolean): void {
  socketUp = up;
}

export function buildSocketUp(): boolean {
  return socketUp;
}

/** Registered once, by main.ts, with what to do about a new build. */
export function onBuildLive(cb: (sha: string) => void): void {
  handler = cb;
}

/** Called by whoever hears the server say a new generation is being served. */
export function buildLive(sha: unknown): void {
  // THE SHA IS A HINT, NOT THE DECISION. The handler re-reads /version, which
  // is the authority, so anything here is only "go and look". It must not be
  // filtered on the value: a ROLLBACK announces the image's sha, and an
  // earlier version of this dropped any message it could not vouch for, which
  // would have made the one case that matters most — the bad build being taken
  // away — the one case nobody was told about.
  try {
    handler?.(typeof sha === "string" ? sha : "");
  } catch {
    /* the news is never worth breaking the frame over */
  }
}
