// AM I THE ADMIN? — the one question, asked of the one thing that can answer it.
//
// The token in localStorage ("wiki-admin-token", shared with the wiki) is only
// a CLAIM: it is an HMAC the server signed (live.ts), and only the server can
// check it. So this never reads the token's contents — it presents it to
// `/api/wiki/me` and believes the answer. Anything gated on this is therefore
// gated on the server, and a hand-written localStorage entry buys nothing.
//
// CACHED FOR THE PAGE'S LIFETIME, the convention the world picker already
// follows (maps.ts): one ask at boot, no polling. A login in ANOTHER tab fires
// `storage` and drops the cache; a login in THIS tab lands on the next reload,
// exactly as the dev-world list does.
//
// NOTE, and the reason this file exists: maps.ts (the games agent's) carries a
// private copy of this same check for the dev-world filter. Two copies behind
// ONE server endpoint is the correctness-critical part being single, but it is
// still two — offered to them 2026-09-18 to import this and delete theirs.
import { fetchSoon } from "./staging";

const TOKEN_KEY = "wiki-admin-token";
let cache: Promise<boolean> | null = null;

/** Whether this browser holds a session the SERVER accepts as the admin. */
export function isAdmin(): Promise<boolean> {
  if (cache) return cache;
  cache = (async () => {
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) return false;
      const res = await fetchSoon("/api/wiki/me", 3000, {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) return false;
      return !!(await res.json())?.admin;
    } catch {
      return false; // offline, or no live channel — not an admin, never a throw
    }
  })();
  return cache;
}

/** Forget the cached answer, so the next `isAdmin()` asks again. */
export function forgetAdmin(): void {
  cache = null;
}

// Another tab logging in or out changes the claim under us.
window.addEventListener("storage", (e) => {
  if (e.key === TOKEN_KEY || e.key === null) forgetAdmin();
});
