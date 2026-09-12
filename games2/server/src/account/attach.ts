// account/attach.ts — ATTACHING A LOGIN, AND LOGGING IN WITH ONE.
//
// Owned by the account agent (account/README.md is the law). Phase 2 of the
// build order: "Save your character". Nothing here is in the play path — a
// player who never taps the button never touches this file, and if Google is
// down only NEW Google logins fail; everyone already playing keeps playing
// because the game trusts its own record (law 6).
//
// Two things a login can do, and they are deliberately two endpoints:
//
//   attach — "save THIS character": the client proves it is the account
//            ({id, secret}, the same pair it joins with) and hands over a
//            provider credential; the provider identity is recorded as a
//            linked attribute of the account (never the key of anything).
//   login  — "get MY character back", on a new device or after the browser
//            evicted the pair: the credential alone; the server finds the
//            account the identity is attached to, ROTATES its secret and
//            returns the new pair. The record stores only a hash, so a new
//            pair is the only pair it can return — and rotation is exactly
//            the revocation law: every pair issued before is dead at its
//            next join. Two devices therefore take turns, never both — the
//            same rule as one live session per account, a device wider.
//
// The two are not one endpoint on purpose: a level-5 character on a phone
// whose Google is attached to a level-14 character on a laptop must be ASKED
// before it is switched. attach answers "taken" with who holds the identity;
// the client decides whether to call login.
//
// VERIFICATION IS ONE FETCH, ZERO LIBRARIES: Google's tokeninfo endpoint
// decodes and signature-checks the ID token and answers its claims; this
// module checks the claims that are OURS to check (audience = our client id,
// issuer, expiry, a subject). Sign-ins are rare events, so the round trip
// costs nothing; local JWKS verification is the escape hatch if volume ever
// makes it matter (account/README.md build order).
//
// NEVER STORED: the email. The provider's opaque subject id is the identity
// (GDPR: no personal data held that the game does not need).

import type express from "express";
import {
  AccountClaim,
  AccountStore,
  accountStore,
  cleanId,
  hashSecret,
  loginKey,
  mintSecret,
  secretMatches,
} from "./store.js";

export type Provider = "google";
export const PROVIDERS: readonly Provider[] = ["google"];

/** Who a verified credential is: the provider and its opaque subject id. */
export interface ProviderIdentity {
  provider: Provider;
  subject: string;
}

/** Verifies one provider credential; null for anything but a valid, current
 *  credential issued for THIS game. Injected in tests. */
export type Verifier = (provider: Provider, credential: string) => Promise<ProviderIdentity | null>;

/** Per-provider client ids. A provider without one is "not configured": the
 *  endpoints answer 503 so the client can say so instead of failing a
 *  sign-in it could never have completed. */
export interface AttachConfig {
  google?: string;
}

/** The runtime config: `GOOGLE_CLIENT_ID` on the Cloud Run service (set
 *  once with `gcloud run services update --update-env-vars`; the deploy
 *  passes no env, so it survives every rollout). Public by nature — it is
 *  in the sign-in button's HTML — so it is not a secret and needs no Secret
 *  Manager. */
export function attachConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AttachConfig {
  const google = (env.GOOGLE_CLIENT_ID || "").trim();
  return google ? { google } : {};
}

export function providerConfigured(cfg: AttachConfig, provider: Provider): boolean {
  return provider === "google" ? !!cfg.google : false;
}

// ------------------------------------------------------------------ google

const GOOGLE_TOKENINFO = "https://oauth2.googleapis.com/tokeninfo";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
/** A Google ID token is ~1-2 KB; anything past this is not one. */
export const CREDENTIAL_MAX = 4096;
const VERIFY_TIMEOUT_MS = 5000;
/** Three base64url segments — the shape of a JWT and nothing else. Checked
 *  before the fetch so garbage never leaves the process. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** Google's `sub`: an opaque string of up to 255 ASCII characters (digits in
 *  practice). Kept to characters that make a clean single path segment,
 *  since it becomes half of a `logins` document id. */
const SUBJECT_SHAPE = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * Verify a Google Identity Services credential (an ID token) against OUR
 * client id. Returns the identity, or null for any reason at all — the
 * client is told "bad credential" and nothing more.
 */
export async function verifyGoogleCredential(
  credential: string,
  clientId: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<ProviderIdentity | null> {
  if (!clientId) return null;
  if (typeof credential !== "string" || credential.length > CREDENTIAL_MAX || !JWT_SHAPE.test(credential)) return null;
  let claims: Record<string, unknown>;
  try {
    const res = await fetchImpl(`${GOOGLE_TOKENINFO}?id_token=${encodeURIComponent(credential)}`, {
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return null; // 400 = not a valid token, per Google
    claims = (await res.json()) as Record<string, unknown>;
  } catch {
    return null; // network, timeout, not JSON — a sign-in to retry, never an account
  }
  if (!claims || typeof claims !== "object") return null;
  if (claims.aud !== clientId) return null; // issued for some other app
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) return null;
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= now) return null;
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  if (!SUBJECT_SHAPE.test(subject)) return null;
  return { provider: "google", subject };
}

/** The production verifier: each configured provider's real check; an
 *  unconfigured one answers null. */
export function configuredVerifier(cfg: AttachConfig, fetchImpl: typeof fetch = fetch): Verifier {
  return async (provider, credential) => {
    if (provider === "google") return cfg.google ? verifyGoogleCredential(credential, cfg.google, fetchImpl) : null;
    return null;
  };
}

// ------------------------------------------------------------------- flows

export type AttachResult =
  | { ok: true; providers: string[] }
  /** The pair did not verify. An unknown id and a wrong secret answer the
   *  same way (the no-oracle rule, as in resolveAccount). */
  | { ok: false; reason: "unauthorized" }
  /** The identity is attached to ANOTHER account — the player's own saved
   *  character, most likely. `other` is what the client shows when it asks
   *  whether to switch (it is the same person: they just proved they hold
   *  that provider account). */
  | { ok: false; reason: "taken"; other: { name: string; character: string; level: number } }
  /** This account already has a DIFFERENT identity of this provider attached.
   *  One identity per provider per account keeps `providers` truthful. */
  | { ok: false; reason: "attached" };

const attachedProviders = (providers: Record<string, string> | undefined): string[] =>
  Object.keys(providers ?? {}).filter((p) => (PROVIDERS as readonly string[]).includes(p)).sort();

/** Attach a verified identity to the account the claim proves. Idempotent:
 *  attaching the same identity again is `ok`. */
export async function attachLogin(
  store: AccountStore,
  claim: AccountClaim | undefined,
  ident: ProviderIdentity,
): Promise<AttachResult> {
  const id = cleanId(claim?.id);
  const secret = typeof claim?.secret === "string" ? claim.secret : "";
  const rec = id && secret ? await store.load(id) : undefined;
  if (!rec || !secretMatches(secret, rec.secretHash)) return { ok: false, reason: "unauthorized" };
  const have = rec.providers?.[ident.provider];
  if (have && have !== ident.subject) return { ok: false, reason: "attached" };
  // The `logins` row is claimed FIRST and atomically (create-only): two
  // accounts can never both hold one identity, whatever the interleaving.
  const owner = await store.claimLogin(loginKey(ident.provider, ident.subject), id);
  if (owner !== id) {
    const theirs = await store.load(owner);
    return {
      ok: false,
      reason: "taken",
      other: theirs
        ? { name: theirs.name, character: theirs.character, level: theirs.level }
        : { name: "", character: "", level: 0 },
    };
  }
  const providers = { ...(rec.providers ?? {}), [ident.provider]: ident.subject };
  if (have !== ident.subject) await store.linkProvider(id, ident.provider, ident.subject);
  return { ok: true, providers: attachedProviders(providers) };
}

export type LoginResult =
  | { ok: true; id: string; secret: string; name: string; character: string; level: number }
  /** Nobody attached this identity to a character. Not an error to retry:
   *  the client offers to attach it to the character it is playing. */
  | { ok: false; reason: "unknown" };

/** Log in with a verified identity: find the account it is attached to,
 *  rotate its secret, hand back the new pair. */
export async function loginWithProvider(store: AccountStore, ident: ProviderIdentity): Promise<LoginResult> {
  const owner = await store.lookupLogin(loginKey(ident.provider, ident.subject));
  const rec = owner ? await store.load(owner) : undefined;
  if (!owner || !rec) return { ok: false, reason: "unknown" };
  const secret = mintSecret();
  await store.setSecretHash(owner, hashSecret(secret));
  return { ok: true, id: owner, secret, name: rec.name, character: rec.character, level: rec.level };
}

export type StatusResult =
  | { ok: true; providers: string[]; name: string; character: string; level: number }
  | { ok: false; reason: "unauthorized" };

/** What the account panel shows: which logins are attached (names only,
 *  never a subject id) and the character they protect. */
export async function accountStatus(store: AccountStore, claim: AccountClaim | undefined): Promise<StatusResult> {
  const id = cleanId(claim?.id);
  const secret = typeof claim?.secret === "string" ? claim.secret : "";
  const rec = id && secret ? await store.load(id) : undefined;
  if (!rec || !secretMatches(secret, rec.secretHash)) return { ok: false, reason: "unauthorized" };
  return { ok: true, providers: attachedProviders(rec.providers), name: rec.name, character: rec.character, level: rec.level };
}

// ------------------------------------------------------------------ routes

export interface AccountRoutesOptions {
  /** Defaults to the process's store (accountStore()). */
  store?: AccountStore;
  /** Defaults to the real per-provider verification. */
  verify?: Verifier;
  /** Defaults to the environment (GOOGLE_CLIENT_ID). */
  config?: AttachConfig;
}

/**
 * The HTTP surface, under `/api` (express.json is mounted there by index.ts).
 * The pair travels in a POST body, never a URL: a URL is logged.
 *
 *   GET  /api/account/config            -> { google: <client id> | null }
 *   POST /api/account/attach  {id, secret, provider, credential}
 *        200 { ok, providers }  401 unauthorized | bad credential
 *        409 { error: "taken", other: {name, character, level} } | { error: "attached" }
 *        503 provider not configured
 *   POST /api/account/login   {provider, credential}
 *        200 { ok, id, secret, name, character, level }  401  404 { error: "unknown" }  503
 *   POST /api/account/status  {id, secret}
 *        200 { ok, providers, name, character, level }  401
 */
export function registerAccountRoutes(app: express.Application, opts: AccountRoutesOptions = {}): void {
  const cfg = opts.config ?? attachConfigFromEnv();
  const verify = opts.verify ?? configuredVerifier(cfg);
  const store = () => opts.store ?? accountStore();
  const noStore = (res: express.Response) => res.setHeader("Cache-Control", "no-store");
  const claimOf = (body: any): AccountClaim => ({ id: body?.id, secret: body?.secret });
  const providerOf = (body: any): Provider | null =>
    (PROVIDERS as readonly string[]).includes(body?.provider) ? (body.provider as Provider) : null;
  const credentialOf = (body: any): string | null =>
    typeof body?.credential === "string" && body.credential.length > 0 && body.credential.length <= CREDENTIAL_MAX
      ? body.credential
      : null;

  app.get("/api/account/config", (_req, res) => {
    noStore(res).json({ google: cfg.google ?? null });
  });

  app.post("/api/account/attach", async (req, res) => {
    noStore(res);
    const provider = providerOf(req.body);
    const credential = credentialOf(req.body);
    if (!provider || !credential) return void res.status(400).json({ error: "provider and credential required" });
    if (!providerConfigured(cfg, provider)) return void res.status(503).json({ error: "provider not configured" });
    try {
      const ident = await verify(provider, credential);
      if (!ident) return void res.status(401).json({ error: "bad credential" });
      const r = await attachLogin(store(), claimOf(req.body), ident);
      if (r.ok) res.json({ ok: true, providers: r.providers });
      else if (r.reason === "unauthorized") res.status(401).json({ error: "unauthorized" });
      else if (r.reason === "taken") res.status(409).json({ error: "taken", other: r.other });
      else res.status(409).json({ error: "attached" });
    } catch (e) {
      console.error("[account] attach failed:", e);
      res.status(500).json({ error: "attach failed" });
    }
  });

  app.post("/api/account/login", async (req, res) => {
    noStore(res);
    const provider = providerOf(req.body);
    const credential = credentialOf(req.body);
    if (!provider || !credential) return void res.status(400).json({ error: "provider and credential required" });
    if (!providerConfigured(cfg, provider)) return void res.status(503).json({ error: "provider not configured" });
    try {
      const ident = await verify(provider, credential);
      if (!ident) return void res.status(401).json({ error: "bad credential" });
      const r = await loginWithProvider(store(), ident);
      if (r.ok) res.json({ ok: true, id: r.id, secret: r.secret, name: r.name, character: r.character, level: r.level });
      else res.status(404).json({ error: "unknown" });
    } catch (e) {
      console.error("[account] login failed:", e);
      res.status(500).json({ error: "login failed" });
    }
  });

  app.post("/api/account/status", async (req, res) => {
    noStore(res);
    try {
      const r = await accountStatus(store(), claimOf(req.body));
      if (r.ok) res.json({ ok: true, providers: r.providers, name: r.name, character: r.character, level: r.level });
      else res.status(401).json({ error: "unauthorized" });
    } catch (e) {
      console.error("[account] status failed:", e);
      res.status(500).json({ error: "status failed" });
    }
  });
}
