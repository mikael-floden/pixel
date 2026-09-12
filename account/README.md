# account/ — identity, accounts, and player persistence

The domain that answers "who is this player, and what do they own". It owns
the account record, how a player proves they are it, how a login gets attached
to one, and — once anything is sold — entitlements and receipts.

Named **account**, not login (maintainer 2026-09-07): the account is the
thing, login is only one of several ways to reach it. Most players will have
an account for a long time before they ever log in to anything.

Two agents work it (maintainer 2026-09-12): **account** and **account-assistant**,
same files, same law; a board claim says who holds a file
(`coordination/PROTOCOL.md`, "Two writers per directory").

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
- **Attachments** — zero or more ways to log in (Google today; Apple, Discord,
  Steam, passwordless email later). Stored as `providers.<provider>` = the
  provider's opaque subject id on the account, plus one `logins/<provider>:<sub>`
  row pointing back at the `accountId` — never an email, never the key.
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

- **Revocation is rotating a field.** Every pair issued before is dead at its
  next join. A login on a new device IS a rotation (the record holds only a
  hash, so a new pair is the only pair it can hand out): devices take turns
  on one account, never both — one live session per account, a device wider.
  The dead pair mints a fresh level-1 character at its next join, never an
  error (the no-oracle rule), and "Log in with Google" gets the real one back.
- **Identity is written once, at creation, and afterwards only by the identity
  methods** (`setSecretHash`, `linkProvider`). A room's save writes
  PROGRESSION only — see "Persistence rules". (Paid for before shipping:
  the room rewrites the document it loaded at join; a login on a phone
  rotates the secret while the laptop's session still holds the old one, and
  the join that kicks the laptop makes it save — a whole-record write put the
  OLD hash back and the phone's pair died on its very next join. Gate:
  `test/attach.test.ts`, "THE TRAP".)
- **Multi-process needs no key distribution** — every game process just reads
  Firestore.
- **Zero crypto libraries, zero key management, zero Secret Manager.**

REJECTED — signed tokens (EdDSA/JWT + `jose` + Secret Manager). They buy
identity verification WITHOUT a database read; the join already reads the
account document, so they bought nothing and cost a key-distribution problem.
(If some future service must authenticate without touching the account, that
is when to revisit — not before.)

REJECTED — the client inventing its own id (the old `net.ts getPlayerToken()`).
Unverified: whoever knew the string WAS that character. Gone since phase 1.

## Storage: Firestore, `europe-north1`, server-side only

**Firestore in Standard/Native mode, single region `europe-north1`**, reached
ONLY from the server through `@google-cloud/firestore`. Two collections, both
get-by-key: `accounts/<accountId>` (the record) and `logins/<provider>:<sub>`
(→ `accountId`, created with `create()` so one identity can never belong to
two accounts). No queries, no indexes, no joins.

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

Free tier covers development many times over; the measured rates and the
per-day allowance are in `docs/costs-and-payments.md`.

REJECTED — Cloud SQL/Postgres (never scales to zero: a permanent bill and a
VPC connector for get-by-key). Spanner (the answer to a cross-region shared
economy that does not exist; Firestore is built on it anyway, so this is a
billing choice, not a quality one). Firebase Auth / Auth0 / Clerk (they hold
the user table and sit in every sign-in; the user table is the asset).
Player data in `live/` like tuning (the repo is public; this is personal data).

## The laws

1. **`accountId` is the primary key. A provider identity is always a linked
   attribute, never the key.** This one rule is what keeps providers
   swappable, makes one account work across web/iOS/Android/Steam (a purchase
   on the web must appear on iOS), and keeps a later engine swap a
   one-module rewrite. Free today; the window closes the day there are real
   players.

2. **Write on MEANING, not on a timer.** Flush on level-up, item gained or
   lost, purchase, leave — never every N seconds regardless of change (~4x
   the bill at 20k concurrent, `docs/costs-and-payments.md`; write
   amplification is engine-independent).

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

8. **One identity per provider per account, one account per identity.** The
   `logins` row is claimed create-only before anything is written; a second
   account presenting the same Google identity is told whose it is (the same
   person, who just proved they hold that Google account) and offered the
   switch, never merged.

## Traps paid for (one line each)

- **Progress on the container disk is deleted progress**: Cloud Run at
  `--min-instances 0` loses `.data/` on every redeploy and scale-to-zero,
  silently (phase 1 deleted `server/src/store.ts` for this).
- **A synchronous whole-file write on the game loop stalls the tick** (the old
  30 s flush, every player ever seen, once per player). Now fire-and-forget,
  per account, dirty players only.
- **A message sent from `onJoin` can land before the client's handler exists**,
  silently: the pair is dropped and the browser is a NEW player every visit.
  The client PULLS the pair (`account:want`). Never push it.
- **A whole-record save clobbers identity written under it** (a rotation, an
  attach). Saves write progression only.
- **`gcloud config get-value project` prints `(unset)` and exits 0**, so a
  `&&` chain sails past a missing project; `games2/deploy/ar-cleanup.sh` and
  `.github/gcs-backup-bootstrap.sh` guard it — reuse their derivation.

## The database — LIVE since 2026-09-07

`projects/nagijala/databases/(default)` · `europe-north1` · `FIRESTORE_NATIVE`
· `freeTier: true` · `POINT_IN_TIME_RECOVERY_DISABLED`.

Created from Cloud Shell on a phone (per repo law — no laptop) with:

```
gcloud config set project nagijala && \
gcloud services enable firestore.googleapis.com && \
gcloud firestore databases create --location=europe-north1 --type=firestore-native
```

- **`nagijala`** — one `n`, not "nangijala": the GCP project id does not match
  the game's name.
- **No `--database` flag** makes it `(default)`, and ONLY the default database
  gets the free tier. **`--type=firestore-native`** explicitly (Datastore mode
  is a different product). **The location is PERMANENT** — a different region
  is a different database.
- IAM: the deploy passes no `--service-account`, so Cloud Run runs as the
  default compute SA (Editor). A dedicated SA with `roles/datastore.user` is
  tidier once it matters.

**Tests and local dev use an in-memory fake, not the Firestore emulator** —
`MemoryAccountStore`, the same interface. `npm run dev` needs no GCP
credentials. The store is chosen by CONFIG, never by failure: `K_SERVICE`
(Cloud Run) means Firestore and an error there is loud; `ACCOUNT_STORE=memory|firestore`
overrides.

## Google sign-in — setup, from a phone

The server half is built (`attach.ts`); it is dormant until the service knows
its OAuth client id. Public by nature (it sits in the sign-in button's HTML),
so it is an env var, not a secret. One-time:

1. Console → APIs & Services → **OAuth consent screen** ("Branding"): app name
   Nangijala, support email, developer contact; External; add
   `nangijala.online` as an authorised domain; publish (only basic scopes —
   `openid email profile` — so no verification review is needed).
2. **Credentials → Create credentials → OAuth client ID → Web application**:
   authorised JavaScript origin `https://nangijala.online` (no redirect URI;
   the credential comes back in the page). Copy the client id.
3. Cloud Shell, one line (the deploy passes no env, so a value set here
   survives every rollout):

```
gcloud run services update nangijala --region europe-north1 --update-env-vars GOOGLE_CLIENT_ID=<the id>.apps.googleusercontent.com
```

Verify: `https://nangijala.online/api/account/config` answers `{"google":"<the id>"}`
(`null` until then, and the client shows no button). There is no gcloud
command that creates an OAuth client, which is why steps 1-2 are the console.

## Cross-domain contracts

- **games** owns `WorldRoom.ts`, `net.ts`, `index.ts`, `shared/src/index.ts`.
  Every change this domain needs there is a request on their board, never an
  edit. Pending: ONE line in `server/src/index.ts`, after `registerLiveRoutes(app)`:
  `registerAccountRoutes(app)` (import from `./account/attach.js`). Until it
  lands the endpoints below 404 and nothing else changes.
  **A durable shared account store is a PREREQUISITE for their multi-process
  work**: met since phase 1 (every process reads the same account document).
- **games-ui** owns `select.ts` and `hud.ts`. The affordance is theirs to word
  and place, driven by the wire contract below. This domain's instinct: a row
  in the HUD Settings page beside Log out, NEVER on the select screen; the
  Google script (`https://accounts.google.com/gsi/client`) loaded only when
  Settings opens, never at boot; "Save with Google" while `status.providers`
  lacks `google`, "Saved with Google" once it has it, "Restore a saved
  character" → login. The one-time nudge after the first level-up is the
  maintainer's call.
- **PROTOCOL.md and the agent table are the maintainer's.** This domain does
  not edit them.

## Where the implementation lives — `games2/server/src/account/`

This directory is docs (`README.md` the law, `docs/` the receipts) and ships
nothing. The service runs inside the game server process (it shares the
Express app and the Colyseus room), so the code lives at
**`games2/server/src/account/`** — `store.ts` the record and the stores,
`attach.ts` the logins and their HTTP surface; tests
`server/test/account.test.ts`, `server/test/attach.test.ts`. NOT a top-level
`games2/account/`: the runtime image copies `games2/shared/`, `games2/server/`
and `games2/config/` and nothing else, so a top-level module would typecheck,
test, build green and then be MISSING from production. (If code ever lands
under `account/` it must be named in `.dockerignore`, the Dockerfile COPY and
the deploy workflow's trigger paths — missing one fails silently.)

## The wire contract

**The join** (Colyseus, unchanged since phase 1):

- **Join** carries `JoinOptions.account = {id, secret}`, or nothing at all on a
  first-ever visit.
- **The client PULLS a minted pair, the server never pushes it.** After joining,
  the client registers its handler and sends `account:want`; the server answers
  `account {id, secret}` only for a join that actually minted one, and drops it
  from memory as it goes out.
- **A wrong secret, an unknown id and no claim at all are answered identically**
  — with a fresh account. Anything else turns the join into an oracle for which
  account ids exist. The HTTP surface keeps the same rule: a bad pair is
  `401 unauthorized` whatever was wrong with it.

**The logins** (HTTP, under `/api`, JSON bodies; the pair travels in a POST
body and never in a URL — URLs are logged):

| call | body | answers |
|---|---|---|
| `GET /api/account/config` | — | `{google: <client id> \| null}`; `null` = not set up, show nothing |
| `POST /api/account/attach` | `{id, secret, provider, credential}` | `200 {ok, providers}` · `401 unauthorized` (the pair) · `401 bad credential` · `409 {error:"taken", other:{name, character, level}}` · `409 {error:"attached"}` · `503 provider not configured` |
| `POST /api/account/login` | `{provider, credential}` | `200 {ok, id, secret, name, character, level}` — store the pair, rejoin · `401 bad credential` · `404 {error:"unknown"}` (nobody saved a character with it) · `503` |
| `POST /api/account/status` | `{id, secret}` | `200 {ok, providers, name, character, level}` · `401` |

- `provider` is `"google"`; `credential` is the ID token Google Identity
  Services hands the page. The server verifies it with ONE fetch to Google's
  `tokeninfo` (audience = our client id, issuer, expiry, a subject) — zero
  libraries; a sign-in is a rare event.
- **`taken` is the switch prompt, not an error**: the identity protects
  another character (theirs — they just proved they hold that Google
  account). The client asks "switch to <name>, level N?" and calls `login`.
- **`login` rotates**: the pair it returns is the only live one; the device
  that held the old pair becomes a new player at its next join and can log in
  the same way. The client stores the pair (`setAccount`) and rejoins — a
  page reload is enough, the join reads localStorage.
- Never stored: the email. `providers` on the record holds the opaque
  subject; `status` returns provider NAMES only.

## Persistence rules the room obeys

- **`Player.dirty` marks what was EARNED** — level, xp, inventory. Never hp/ep:
  they regenerate, and marking them would write on every tick of combat.
- **The periodic flush saves only dirty players**, so an idle world costs zero
  writes. Eager saves stay on leave, death, level-up and the session kick.
- **Saves are fire-and-forget** — a durable write is never awaited inside the
  20Hz loop.
- **A save writes PROGRESSION only** (`progressionOf`: name, character, level,
  xp, hp, ep, inv, pos), merged into the document with one `update()` — no
  read, and identity is never in the payload; only a document that does not
  exist yet gets the whole record (a fresh mint). The room still holds the
  loaded document in `Player.rec` and rewrites it, but a stale copy can no
  longer put an old `secretHash` back or drop a `providers` link.
- **`onJoin` awaits a database read**, so it checks `client.state` before adding
  the player to the room — a link dropped inside that window would otherwise
  leave a body no client owns and nothing ever removes.

## Build order

1. ~~**The account service.**~~ **DONE 2026-09-07.** Firestore + a silent
   account at first join + `{accountId, secret}`. Invisible to players —
   nothing about entry changed.
2. **Attach: Google.** "Save your character." **Server half DONE 2026-09-12**
   (`attach.ts` + `attach.test.ts`: verification, attach, login with
   rotation, status, the routes). Dormant until three things outside this
   domain land: the mount line (games), the Settings affordance (games-ui),
   `GOOGLE_CLIENT_ID` on the service (maintainer, above). Local JWKS
   verification only if volume ever makes the tokeninfo round trip matter.
3. **More attachments** — Apple (App Store rules require it once any other
   social login ships on iOS), Discord, passwordless email code (the
   "game-only account": nothing to store, leak, reset or type on a phone).
   Skip Facebook/Twitter. Each is a `Provider` name and a verifier, nothing
   else — the flows and the rows are provider-agnostic.
4. **Entitlements + receipts**, before anything is ever sold. A purchase writes
   an immutable receipt and a grant, idempotent on the store's transaction id
   so a retry can never double-grant. Never ask a platform at render time
   whether a player owns something.

## Payments — decided in advance, built last

`docs/costs-and-payments.md`: platform tax (the browser is the storefront,
the apps are clients), one account across every platform (law 1), GDPR (one
`accountId` reaches all of a player's data; store a provider's subject id,
never an email — `attach.ts` does).
