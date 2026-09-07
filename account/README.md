# account/ — identity, accounts, and player persistence

The domain that answers "who is this player, and what do they own". It owns
the account record, how a player proves they are it, how a login gets attached
to one, and — once anything is sold — entitlements and receipts.

Named **account**, not login (maintainer 2026-09-07): the account is the
thing, login is only one of several ways to reach it. Most players will have
an account for a long time before they ever log in to anything.

## THE ENTRY LAW — read this before proposing anything

**The game is a web address you can play immediately, and that must never
change.** Today entry is ONE TAP: the character is preselected
(`default_girl`), the name is pre-filled from `select.ts`'s NAMES pool, and
`Enter world` starts the game. A second tap only exists if you want a
different hero.

**This domain may not add a step to that.** No login screen, no "sign up or
continue as guest" fork, nothing between the address and the world.
(Maintainer: "Each click to get started counts... You have failed if you make
the time for a new player to get into the game." Not negotiable, not tunable,
not worth one conversion percent.)

The design that makes an account system possible under that law is inversion:

**Every player already HAS an account.** The server creates one silently at
first join — no interaction, on the network call the join already makes. So
"create an account" never creates anything. It **attaches a way to log back
in** to the account that already holds your level-14 character.

That is why the ask converts: the player is not filling in a form to be
allowed to play, they are protecting something they already earned. It is
offered only once they have something to lose (default: first level-up; the
moment is the maintainer's taste call).

## What a player is

- **`accountId`** — server-minted, random, opaque. **The primary key of
  everything, forever.** (See the laws below. This is the single most
  load-bearing decision in the domain.)
- **`secret`** — server-minted random value the client keeps beside the id.
  Proves the client is that account.
- **Attachments** — zero or more ways to log in (Google, Apple, Discord,
  Steam, passwordless email). A provider identity is stored as its opaque
  subject id, never as the key.
- **Progression** — level, xp, hp, ep, inventory. World-agnostic: your
  character IS the level, so picking a different world must never fork it.
- **Position** — per world. Hot state, not the account of record (see the
  hot-state law).
- **Entitlements** — a SET of grants, never a tier.

## Identity: `{accountId, secret}`, verified on the read that already happens

The client stores the pair; the join sends it; the server compares the secret
against the hash on the account document **using the read it was already
doing** for level and inventory. Timing-safe compare, hashed at rest (node's
built-in `crypto` — a 256-bit random value needs no password KDF).

- **Revocation** is rotating a field. Every existing client for that account
  is dead at next join.
- **Multi-process needs no key distribution** — every game process just reads
  Firestore.
- **Zero crypto libraries, zero key management, zero Secret Manager.**

REJECTED — signed tokens (EdDSA/JWT + `jose` + Secret Manager). They buy
identity verification WITHOUT a database read; the join already reads the
account document, so they bought nothing and cost a key-distribution problem.
(If some future service must authenticate without touching the account, that
is when to revisit — not before.)

REJECTED — the client inventing its own id (what `net.ts getPlayerToken()`
does today). Unverified: whoever knows the string IS that character. Harmless
while nothing is at stake, unrecoverable account theft the day it holds a
purchase.

## Storage: Firestore, `europe-north1`, server-side only

**Firestore in Standard/Native mode, single region `europe-north1`**, reached
ONLY from the server through `@google-cloud/firestore`.

- **`europe-north1`, not the `eur3` multi-region.** Multi-region storage under
  single-region compute buys availability you cannot use — a `europe-north1`
  outage takes Cloud Run with it and the game is down either way. Cheaper,
  lower latency, and the same region the rest of the stack already picked
  (`games2/deploy/gcp-bootstrap.sh`: "Finland — closest to Sweden").
- **NO Firebase SDK in the client. NO security rules. NO Firebase Auth.**
  Firestore is the database; Firebase is a platform we do not use. A client
  that can write the database directly can write its own inventory, and the
  server is authoritative. The client never learns the database exists.
- **No provisioned cost.** No instance, no node, no minimum — unused is
  unbilled. That is why it beat Cloud SQL and Spanner here, not raw
  throughput.
- **PITR and scheduled backups stay OFF.** They bill per GiB and player data
  in development is disposable by the no-migration law.

Measured (us-central1 rates; EU somewhat higher): reads $0.03/100k, writes
$0.09/100k, deletes $0.01/100k, storage ~$0.144/GiB/month. Free every day:
50,000 reads / 20,000 writes / 20,000 deletes / 1 GiB stored — **for the
`(default)` database only, one per project**. Development usage is ~0.1% of
that, so development costs nothing.

REJECTED — Cloud SQL/Postgres: never scales to zero, a permanent bill and a
VPC connector for get-by-key.
REJECTED — Spanner: the right answer to a question that only exists with a
cross-region shared economy (one global market where a Stockholm↔São Paulo
trade must be strongly consistent). Firestore is built on Spanner anyway, so
this is a billing-model and API choice, not a quality one.
REJECTED — Firebase Auth / Auth0 / Clerk: they hold the user table and sit in
every sign-in. The user table is the asset.
REJECTED — committing player data to `live/` like tuning: the repo is public
and this is personal data.

## The laws

1. **`accountId` is the primary key. A provider identity is always a linked
   attribute, never the key.** This one rule is what keeps providers
   swappable, makes one account work across web/iOS/Android/Steam (a purchase
   on the web must appear on iOS), and keeps a later engine swap a
   one-module rewrite. Free today; the window closes the day there are real
   players.

2. **Write on MEANING, not on a timer.** Flush on level-up, item gained or
   lost, purchase, leave — never every N seconds regardless of change.
   (Estimated at 20k concurrent: ~$390/month event-driven vs ~$1,550/month on
   a 30s timer. Write amplification is the cost driver in every database, so
   this is engine-independent.)

3. **The account of record is not hot state.** Position changes 20x/sec and is
   worth nothing if lost; level, inventory, entitlements and purchases change
   rarely and are worth everything. They do not share a lifecycle. Never pay
   durable-write cost for throwaway data.

4. **Entitlements are a SET of grants, never a tier column.** `founder`,
   `supporter`, `cosmetic_x`. A set is additive forever; a tier becomes a lie
   the moment there are two kinds of supporter.

5. **No migration code, no schema versioning. A schema change is "delete the
   collection".** (Maintainer 2026-09-07: "I'm the only user and I test
   directly in prod. So never think about backwards compatibility.")
   **TRIPWIRE:** this holds until the first character anyone would be annoyed
   to lose — the maintainer's own included. Named in advance so the flip is a
   decision, not a discovery.

6. **Providers are verified server-side and never sit in the play path.** An
   OIDC sign-in is a direct browser↔provider exchange returning a signed token
   OUR server verifies. If Google's sign-in is down, only new Google logins
   fail — everyone already playing keeps playing, because the game trusts our
   own record. No third party is ever in the path of play.

7. **Display names stay free text and non-unique; nothing is ever keyed on
   them.** Already true in the code (`Player.name`, 24 chars, no uniqueness).
   Written down so it stays true once names are worth impersonating.

## The two live bugs this domain deletes

**Player progress is being silently deleted today.** `games2/server/src/store.ts`
writes `.data/players-<world>.json` and `.data/players-progress.json` to the
container filesystem. Cloud Run runs `--min-instances 0 --max-instances 1`, so
that disk is ephemeral: it dies on every redeploy (every art push deploys) and
on every idle scale-to-zero. Level, XP and inventory evaporate with no error
and no log.

**The 30s flush stalls the game loop.** `WorldRoom.ts:1776` calls `savePlayer`
per player; `JsonMapStore.save` (`store.ts:60`) does
`writeFileSync(JSON.stringify(<entire map of every player ever seen>))`
synchronously, once per player, across two stores. At 200 players that is 400
whole-file synchronous writes every 30s, each O(all accounts), on the game
loop.

Both die with `store.ts`. **The change is a net deletion**: `store.ts`,
`store.test.ts`, `getPlayerToken()` and every `saved?.` migration fallback in
`onJoin` go; one package and one small module arrive.

## Setup (both Cloud-Shell one-liners — no laptop, per repo law)

```
gcloud services enable firestore.googleapis.com
gcloud firestore databases create --location=europe-north1
```

IAM is likely already done: the deploy passes no `--service-account`, so Cloud
Run runs as the default compute SA, which carries Editor. A dedicated service
account with `roles/datastore.user` is tidier once it matters.

**Tests and local dev use an in-memory fake, not the Firestore emulator** —
the same shape `MemoryPlayerStore` already has. `npm run dev` needs no GCP
credentials.

## Cross-domain contracts

- **games** owns `WorldRoom.ts`, `net.ts`, `shared/src/index.ts`. Every change
  this domain needs there is a request on their board, never an edit.
  **A durable shared account store is a PREREQUISITE for their multi-process
  work**: two processes cannot share a JSON file on one instance's local disk,
  so sharding is incoherent until player state is central.
- **games-ui** owns `select.ts` and `hud.ts`. The eventual ask is ONE optional
  "Save your character" affordance — instinct: a row in the HUD Settings page
  beside Log out (`hud.ts:743`), never on the select screen. Wording is theirs.
  `select.ts`'s `ml-last-choice` preselect record is theirs and untouched.
- **PROTOCOL.md and the agent table are the maintainer's.** This domain does
  not edit them.

## Where the implementation lives — OPEN, needs the maintainer

This directory is docs. The service itself must run inside the game server
process (it shares the Express app and the Colyseus room), so it cannot live
here.

**Recommendation: a `games2/account/` carve-out owned by this agent**, exactly
the precedent of `games2/ambient/` (games-ambient) and `games2/composer/`
(games-audio) — one-writer-per-file inside a shared domain. Needs the
maintainer's blessing and a line in `coordination/PROTOCOL.md`.

Docs-only, this directory ships nothing: `.dockerignore` is `*` + allowlist,
so a new top-level name is excluded by default, and `account/**` is not a
deploy trigger path. **If code ever lands here it must be named in all three
allowlists** (`.dockerignore`, `games2/Dockerfile` COPY, and the deploy
workflow's trigger paths) — missing one fails silently.

## Build order

1. **The account service.** Firestore + silent account at first join +
   `{accountId, secret}`. Deletes `store.ts` and the flush stall. Invisible to
   players.
2. **Attach: Google.** "Save your character." Verify the ID token via Google's
   `tokeninfo` endpoint — one fetch, zero libraries; sign-ins are rare events,
   so the round trip costs nothing. Local JWKS verification only if volume
   ever makes it matter.
3. **More attachments** — Apple (required by App Store rules once any other
   social login ships on iOS), Discord, passwordless email code (the
   "game-only account": nothing to store, leak, reset, or type on a phone).
   Skip Facebook/Twitter. Then log-in-on-a-new-device.
4. **Entitlements + receipts**, before anything is ever sold. A purchase writes
   an immutable receipt and a grant, idempotent on the store's transaction id
   so a retry can never double-grant. Never ask a platform at render time
   whether a player owns something.

## Payments — decided in advance, built last

- **Platform tax is the strategic fact.** iOS/Android require their IAP for
  in-app digital goods (30%, or 15% under their small-business programmes,
  which this qualifies for); Steam takes 30%. The web keeps ~97%. **The
  browser is the storefront and the apps are clients** — which is what the
  mission already says the game is.
- **One account across every platform**, which only works because of law 1.
- **GDPR**: EU players and an EU maintainer. Storing an email means holding
  personal data — export and delete paths, EU region, and a privacy policy
  (required before any app store accepts a submission anyway). One
  `accountId` reaching all of a player's data makes it trivial. Prefer a
  provider's opaque subject id over storing their email at all.
