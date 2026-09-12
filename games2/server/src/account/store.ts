// account/store.ts — THE ACCOUNT OF RECORD.
//
// Owned by the account agent (see account/README.md, which is the law for this
// domain). It lives under server/src/ rather than a top-level games2/account/
// for one hard reason: the runtime image copies games2/shared, games2/server
// and games2/config ONLY, so a top-level module would typecheck, test, build
// and then be MISSING from production — the silent-404 trap .dockerignore and
// the Dockerfile COPY list exist to make loud.
//
// ONE DOCUMENT PER PLAYER, in Firestore collection `accounts`, keyed by an
// opaque server-minted accountId. It replaces the JSON files that used to sit
// in .data/ on a Cloud Run container running --min-instances 0: that disk is
// ephemeral, so every redeploy and every idle scale-to-zero deleted every
// player's level, xp and inventory with no error and no log.
//
// A SECOND, TINY COLLECTION `logins` maps a provider identity ("google:<sub>")
// to the accountId it is attached to — get-by-key, one document per attached
// login, created with create() so two accounts can never own one identity.
// The provider identity is a linked attribute, NEVER the key of anything
// (law 1): the account outlives any login attached to it.
//
// WHAT IS *NOT* HERE, deliberately: no signed tokens, no JWT, no key
// management, no Secret Manager. Identity is {accountId, secret} compared
// against a hash on the account document during the read onJoin already
// performs for level and inventory — so authentication costs ZERO extra reads
// and needs no key distributed across processes. (A signed token buys identity
// WITHOUT a database read; that read was already happening, so it bought
// nothing.)

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { Firestore } from "@google-cloud/firestore";

/** One account: who they are, and everything they earned.
 *
 *  `pos` is HOT STATE and is the exception in here — it rides along with a
 *  write that some real change already earned, and is never worth a write of
 *  its own (position changes 20x/sec and is worth nothing if lost; a level is
 *  worth everything). Keyed by world: your character IS the level, so
 *  progression is world-agnostic while where you stood is not. */
export interface AccountRecord {
  secretHash: string;
  createdAt: number;
  /** Attached ways to log back in: provider → the provider's opaque subject
   *  id (Google's `sub`), never an email. Absent until the first attach. The
   *  same pair is the key of the `logins` document that points back here. */
  providers?: Record<string, string>;
  name: string;
  character: string;
  level: number;
  xp: number;
  hp: number;
  ep: number;
  inv: { item: string; n: number }[];
  /** Per world: where the player stood, and the SURFACE level they stood on
   *  (absent in older records — the base level then; a deck walker without it
   *  was restored into the cave under the lid). */
  pos: Record<string, { x: number; y: number; elev?: number }>;
}

/** The fields a ROOM owns and rewrites: everything the player earned or
 *  stood on. Identity (`secretHash`, `createdAt`, `providers`) is not in
 *  here on purpose — see `AccountStore.save`. */
export type Progression = Pick<AccountRecord, "name" | "character" | "level" | "xp" | "hp" | "ep" | "inv" | "pos">;

export const IDENTITY_FIELDS = ["secretHash", "createdAt", "providers"] as const;

export function progressionOf(rec: AccountRecord): Progression {
  return {
    name: rec.name,
    character: rec.character,
    level: rec.level,
    xp: rec.xp,
    hp: rec.hp,
    ep: rec.ep,
    inv: rec.inv.map((s) => ({ item: s.item, n: s.n })),
    pos: structuredClone(rec.pos ?? {}),
  };
}

/** The `logins` document id for one provider identity. The provider name is
 *  ours (an allowlist in attach.ts) and Google's `sub` is a digit string, so
 *  the key is a clean single path segment. */
export const loginKey = (provider: string, subject: string): string => `${provider}:${subject}`;

export interface AccountStore {
  load(id: string): Promise<AccountRecord | undefined>;
  /**
   * A ROOM's save: writes the PROGRESSION only — never `secretHash`,
   * `createdAt` or `providers` — merged into the document that exists; the
   * whole record only when no document exists yet (a fresh mint).
   *
   * The room holds the document it loaded at join and rewrites it on every
   * save. Identity, though, can change UNDER a live room: a login on a new
   * device rotates the secret, an attach links a provider. A save that wrote
   * the held record whole would put the OLD hash back — and the join that
   * kicks the old session makes it save, so the new device's pair would die
   * on its very next join. Identity is therefore written once at creation and
   * afterwards only by the identity methods below, and a stale `rec` is
   * harmless by construction. (Gated in test/attach.test.ts.)
   */
  save(id: string, rec: AccountRecord): Promise<void>;
  /** Rotate the secret: every pair issued before is dead at its next join. */
  setSecretHash(id: string, hash: string): Promise<void>;
  /** Record an attached login on the account (the `logins` row is the truth
   *  for lookups; this is what the account panel shows). */
  linkProvider(id: string, provider: string, subject: string): Promise<void>;
  /** Claim a provider identity for an account. Returns the accountId that
   *  OWNS the key after the call: `accountId` when it was free (or already
   *  this account's), another account's id when it was theirs first. Atomic:
   *  two accounts can never both hold one identity. */
  claimLogin(key: string, accountId: string): Promise<string>;
  lookupLogin(key: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------- identity
// The secret is 256 bits of CSPRNG output, not a password — SHA-256 is the
// right hash for it and a KDF (argon2/bcrypt) would be cargo cult: those exist
// to slow down guessing of LOW-entropy inputs. Stored hashed anyway so a leak
// of the collection does not hand out accounts.

export const mintId = (): string => randomBytes(16).toString("hex");
export const mintSecret = (): string => randomBytes(32).toString("hex");
export const hashSecret = (secret: string): string =>
  createHash("sha256").update(secret, "utf8").digest("hex");

/** Timing-safe compare of a presented secret against a stored hash. */
export function secretMatches(secret: string, hash: string): boolean {
  if (typeof secret !== "string" || typeof hash !== "string") return false;
  if (!/^[0-9a-f]{64}$/.test(hash)) return false;
  const got = createHash("sha256").update(secret, "utf8").digest();
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A brand-new account at level 1, carrying the name/character they arrived with. */
export function newAccount(secretHash: string, name: string, character: string): AccountRecord {
  return {
    secretHash,
    createdAt: Date.now(),
    name,
    character,
    level: 1,
    xp: 0,
    hp: 0, // 0 = "no saved pools yet"; the room fills them from the level curve
    ep: 0,
    inv: [],
    pos: {},
  };
}

/** What the client keeps in localStorage and presents on every join. */
export interface AccountClaim {
  id?: string;
  secret?: string;
}

/** The resolved account for one join. `secret` is set ONLY when a new account
 *  was minted — that is the one moment the client must be told its new pair. */
export interface Resolved {
  id: string;
  rec: AccountRecord;
  secret?: string;
}

/** A claim's id, cleaned: 32 hex chars or nothing. Anything else never
 *  reaches the store. */
export function cleanId(id: unknown): string {
  const s = typeof id === "string" ? id.slice(0, 64) : "";
  return /^[0-9a-f]{32}$/.test(s) ? s : "";
}

/**
 * Resolve a join's claim to an account, MINTING ONE IF ANYTHING IS OFF.
 *
 * No claim, an unknown id, and a wrong secret are handled IDENTICALLY and on
 * purpose: answering differently would turn this into an oracle for which
 * account ids exist. The cost of being wrong is a fresh level-1 character,
 * never someone else's.
 *
 * This is also what makes entry one tap: a first-time player presents nothing,
 * gets an account created for them by the join call the client already makes,
 * and never sees a screen.
 */
export async function resolveAccount(
  store: AccountStore,
  claim: AccountClaim | undefined,
  name: string,
  character: string,
): Promise<Resolved> {
  const id = cleanId(claim?.id);
  const secret = typeof claim?.secret === "string" ? claim.secret : "";
  if (id && secret) {
    const rec = await store.load(id);
    if (rec && secretMatches(secret, rec.secretHash)) return { id, rec };
  }
  const fresh = mintSecret();
  const rec = newAccount(hashSecret(fresh), name, character);
  const newId = mintId();
  await store.save(newId, rec);
  return { id: newId, rec, secret: fresh };
}

// ------------------------------------------------------------------ stores

/** Tests and local dev. Deep-copies at both boundaries: a live Player.inv
 *  aliasing the stored record silently corrupted saves in the store this
 *  replaces, and the bug is easy to reintroduce. */
export class MemoryAccountStore implements AccountStore {
  private data = new Map<string, AccountRecord>();
  private logins = new Map<string, string>();
  async load(id: string): Promise<AccountRecord | undefined> {
    const rec = id ? this.data.get(id) : undefined;
    return rec === undefined ? undefined : structuredClone(rec);
  }
  async save(id: string, rec: AccountRecord): Promise<void> {
    if (!id) return;
    const have = this.data.get(id);
    if (have) Object.assign(have, progressionOf(rec));
    else this.data.set(id, structuredClone(rec));
  }
  async setSecretHash(id: string, hash: string): Promise<void> {
    const have = this.data.get(id);
    if (have) have.secretHash = hash;
  }
  async linkProvider(id: string, provider: string, subject: string): Promise<void> {
    const have = this.data.get(id);
    if (have) have.providers = { ...(have.providers ?? {}), [provider]: subject };
  }
  async claimLogin(key: string, accountId: string): Promise<string> {
    const owner = this.logins.get(key);
    if (owner) return owner;
    this.logins.set(key, accountId);
    return accountId;
  }
  async lookupLogin(key: string): Promise<string | undefined> {
    return this.logins.get(key);
  }
}

// grpc status codes the Firestore client throws as `err.code`.
const NOT_FOUND = 5;
const ALREADY_EXISTS = 6;

/** Production. One document per account, one per attached login; no queries,
 *  no indexes, no joins — get-by-key and put-by-key, which is the one shape a
 *  document store is optimal for rather than a compromise. */
export class FirestoreAccountStore implements AccountStore {
  private readonly col;
  private readonly logins;
  constructor(db: Firestore = new Firestore({ ignoreUndefinedProperties: true })) {
    this.col = db.collection("accounts");
    this.logins = db.collection("logins");
  }
  async load(id: string): Promise<AccountRecord | undefined> {
    if (!id) return undefined;
    const snap = await this.col.doc(id).get();
    return snap.exists ? (snap.data() as AccountRecord) : undefined;
  }
  async save(id: string, rec: AccountRecord): Promise<void> {
    if (!id) return;
    // update() touches ONLY the named fields and refuses a missing document
    // (NOT_FOUND) — one write, no read, and identity is never in the payload.
    // Only a document that does not exist yet gets the whole record.
    try {
      await this.col.doc(id).update({ ...progressionOf(rec) });
    } catch (e: any) {
      if (e?.code !== NOT_FOUND) throw e;
      await this.col.doc(id).set(rec);
    }
  }
  async setSecretHash(id: string, hash: string): Promise<void> {
    if (!id) return;
    await this.col.doc(id).update({ secretHash: hash });
  }
  async linkProvider(id: string, provider: string, subject: string): Promise<void> {
    if (!id) return;
    await this.col.doc(id).set({ providers: { [provider]: subject } }, { merge: true });
  }
  async claimLogin(key: string, accountId: string): Promise<string> {
    const ref = this.logins.doc(key);
    try {
      await ref.create({ accountId, at: Date.now() });
      return accountId;
    } catch (e: any) {
      if (e?.code !== ALREADY_EXISTS) throw e;
    }
    const snap = await ref.get();
    const owner = snap.data()?.accountId;
    return typeof owner === "string" && owner ? owner : accountId;
  }
  async lookupLogin(key: string): Promise<string | undefined> {
    const snap = await this.logins.doc(key).get();
    const owner = snap.data()?.accountId;
    return typeof owner === "string" && owner ? owner : undefined;
  }
}

/**
 * The process's store, chosen by CONFIG and never by failure.
 *
 * A "try Firestore, fall back to memory on error" scheme is exactly the bug
 * this domain exists to delete: it looks healthy and silently stops persisting.
 * So the choice is explicit — Cloud Run (K_SERVICE) means Firestore and a
 * Firestore error is LOUD; anything else means memory, so `npm run dev` and
 * the test suite need no GCP credentials and no emulator.
 */
let shared: AccountStore | undefined;
export function accountStore(): AccountStore {
  if (shared) return shared;
  const mode = process.env.ACCOUNT_STORE || (process.env.K_SERVICE ? "firestore" : "memory");
  shared = mode === "firestore" ? new FirestoreAccountStore() : new MemoryAccountStore();
  if (mode !== "firestore") console.warn("[account] in-memory store — nothing is persisted (ACCOUNT_STORE=firestore to use Firestore)");
  return shared;
}

/** Tests only: point the process at a store of their own. */
export function setAccountStore(store: AccountStore | undefined): void {
  shared = store;
}
