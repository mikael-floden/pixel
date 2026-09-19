# The fast lane — shipping client code with no image and no rollout

A push that touches only `client/src/**` or `client/index.html` publishes a new
client to the running server. No container build, no Cloud Run revision. The
container lane is unchanged and carries everything else.

    push -> fast-publish.yml -> bundle-store branch -> POST /api/bundle/refresh -> served

Pieces: `scripts/fastbuild.mjs` (esbuild), `scripts/publish-bundle.mjs` (the
store writer), `server/src/bundlestore.ts` (the reader), `.github/workflows/fast-publish.yml`.
Gates: `scripts/verify-fastbundle.mjs` (the bundle boots, joins, renders) and
`scripts/verify-fastlane.mjs` (31 assertions: the channel cannot lie).

## Why it exists

Push -> live on the container lane is p50 350 s (measured; run 4255 moved
1.14 GB for a 15-line change). The maintainer's ceiling is 10 s: "Having a long
deploy kinda kills the entire project." esbuild builds this client in 0.44-1.1 s
where vite/rollup takes 8.45 s with no incremental mode, and the channel that
carries `live/**` to production with no redeploy is already measured at 5-9 s
push-to-visible — so the lane is that proven channel carrying a bundle.

## What may NEVER travel this way

- **ART.** Art touches the `?v=<GIT_SHA>` -> `immutable` grant in
  `cachepolicy.ts`. Changing art bytes while `GIT_SHA` is fixed freezes two
  different byte-sets under one URL for a year. That is the unrecallable,
  project-deleting bug. Art rides the image. (I claimed once that "assets are
  the easy half" — the review panel proved the opposite. Corrected.)
- **SERVER / shared / config code.** Adopting it means re-importing modules in
  the process that owns the authoritative 20 Hz world: a restart, i.e. a
  revision.
- **`client/public/**`.** A generation carries `index.html` + `assets/` and
  nothing else. The dist root also holds 43 files from `public/` (measured: 4.6
  MB — `monsters.json` 885 KB, `npcs.json` 765 KB, `ui2/`, `icons/`, `sw.js`,
  the catalogs), answered by the IMAGE. Publishing a `public/**` change would
  run new code against the image's old catalogs.

The last one is enforced by arithmetic, not by the path filter alone: see
FALL-THROUGH below.

## The five laws of the store

Stated in `bundlestore.ts`; each is an arm of `verify-fastlane.mjs`.

1. **A hashed name means one thing forever.** A generation that redefines a name
   this process has served is refused. `index.html` is exempt BY DESIGN — it is
   addressed by the generation, never by its own name.
2. **The pointer is monotonic.** A `seq` at or below the one held is refused; a
   stale pointer read must never walk production backward.
3. **The whole window materialises before anything flips.** A generation that
   cannot be read completely is never pointed at.
4. **The window is the guarantee.** Current + 2 previous keep resolving, so a
   page loaded before a flip keeps rendering. Beyond it, a name answers a
   `no-store` 404 — a coherent miss that reloads, never wrong bytes.
5. **The document belongs to a generation.** Asking for `index.html` by name is
   a question with two right answers, so `fileFor` returns null for it.
6. **THE TWO LANES ARE ORDERED, AND THE IMAGE WINS A TIE.** A generation carries
   its commit's committer date (`commit_ts`); the image carries its own
   (`GIT_COMMIT_TS`, a build-arg so it travels WITH the image and cannot be
   mismatched by an env update). A generation at or before the image is refused.
   `seq` orders publishes against each other and says nothing about the image,
   so without this a container rollout is silently overridden by a client
   published from an EARLIER commit — a rollback nobody asked for and a
   mismatched client/server pair. It is also what makes the image a FLOOR again:
   **a bad publish is undone by the next container deploy**, which is the only
   recovery a phone-only maintainer has. Strict on purpose: a generation that
   names a time is refused by an image that cannot name its own, because
   "cannot compare" must never read as "newer".

Write order is the whole safety argument: **blobs under their content hash, then
the manifest, then the pointer.** A publish interrupted anywhere leaves
production untouched. The generation id is the CONTENT and nothing else — no
sha, no timestamp — so a rebuild that changed nothing publishes nothing.

## Traps, each paid for

Six adversarial review panels read this lane before it was ever fired in
production. Every line below is a defect found in it before a single player saw
it — most by those panels, three by my own new gate arms and one by reading the
deploy's own rollback guard against the change I had just made to `/version`.

- **`/index.html` served the IMAGE while `/` served the published document** —
  two builds under one hostname, the mixed-generation bug itself. `index: false`
  on `express.static` is not enough: the path NAMES the file. Both paths now go
  through one `sendDocument`, registered before static. (Three panels, independently.)
- **`/version` named the image, not the served client.** The client compares it
  against the sha baked into itself and RELOADS on a difference, so every load
  of a published generation reloaded itself and then sat under a false "New
  version out `<old sha>`" banner. Where storage is blocked the 60 s guard cannot
  persist either and the reload is unbounded — measured 114 loads in 12 s.
  `/version` now reports the served generation's sha, and `image` separately.
  (Four panels, independently.)
- **`refresh()` could reject, and Colyseus turns an unhandled rejection into
  `process.exit(1)`** — disposing every room. A DNS hiccup reading a pointer
  would have cost the world. Every backend read is inside a catch, and every
  call site has a second `.catch`.
- **The store never evicted.** ~2.5 MB per generation, held forever, on
  `--memory 1Gi --max-instances 1`, in a lane whose whole point is publishing
  often: an OOM SIGKILL that drops the world. Now BYTES are evicted outside the
  window and NAMES are remembered (~100 bytes each), so law 1 stays absolute for
  the life of the process while the megabytes go.
- **Eviction on the pointer's `retained` alone drops a generation that is still
  being served.** That list is the PUBLISHER's and can name generations this
  instance refused (a corrupt blob, a mixed fall-through, a cold start).
  Eviction keeps the union of the pointer's window and what this process
  actually served. Found by my own new gate arm reporting 1 generation held
  where 3 were expected.
- **The poke could answer with the OLD generation.** `refresh()` coalesces, and
  an in-flight read may predate the publisher's write, so the publish looked
  like a no-op for up to 60 s. The poke forces a read that starts after it.
- **fastbuild's un-hashed-name check ran BEFORE the `public/` copy** — it
  guarded everything except the one source it cannot vouch for, into a directory
  granted `immutable` for a year. It now runs last, recursively.
- **That check's regex rejected compound extensions**, so `sourcemap: true`
  always threw and an ordinary `logo.webp` would have read as a hash failure.
- **An unreadable pointer made the publisher reset `seq` to 1**, which law 2
  then turns into "every future publish refused" until the seq climbs back. A
  pointer that exists and will not parse now ABORTS the publish.
- **A generation whose document named a chunk absent from its own manifest was
  adopted, served and reported healthy** — a black page. The document's
  references are checked against the manifest at admission.
- **A missing `.json` answered 200 `text/html`** (the SPA fallback), which reads
  as a corrupt catalog instead of a missing file. Data extensions 404 with
  `no-store`.
- **The publisher's default `--out` was the image's `client/dist`**, leaving an
  esbuild build that `clientdist.mjs` then declared fresh — so later gates
  graded the wrong bundle. It takes a scratch directory.
- **The exit code was a constant 0** (`r.published || r.id`, and `r.id` is
  always truthy), so CI could not tell a publish from a failure.
- **A push touching client AND server** would have handed players a client in
  seconds that needed a server arriving five minutes later. The workflow diffs
  the push and refuses unless it is client-only; the path filter cannot see this.
- **A container rollout could be silently overridden by an older generation**,
  and a bad publish could not be undone by any deploy — the image stopped being
  a floor the moment anything was published. Law 6 above.
- **`/version`'s `sha` is now the CLIENT's identity, and BOTH of the deploy's
  rollout guards were reading it** as "the image production is running". The
  pre-deploy one asks "is the live build already past this commit?" — with the
  lane serving a newer client it reads that as "a descendant is already live"
  and SKIPS the rollout, so every art push (container lane only) would have been
  silently dropped for as long as the lane was ahead. Both read `.image` now.
  This was the most serious defect of the whole batch and no review panel found
  it; it came out of reading the deploy against the change I had just made.
- **The blob skip was a presence test, not an integrity test.** `blob/<h>`
  existing does not mean it holds bytes that hash to h: an interrupted put
  leaves a truncated object under a name no later publish rewrites, and the
  server re-hashes on load — so every generation naming it is refused FOREVER
  while the publisher keeps printing success. Measured: one 0-byte worker blob
  took the whole lane down, including generations published before the
  truncation, because blobs are shared. The skip re-hashes now, and `put` is
  temp+rename so a killed publish cannot leave a partial object at all.
- **The gate launched Chromium from an absolute path that exists only in the dev
  container**, so in CI it could only ever have failed and the lane could never
  have published anything. It resolves a browser now (env, then any chromium
  under `PLAYWRIGHT_BROWSERS_PATH`, then playwright's own install) and the
  workflow installs and caches one.
- **The publish was piped to `tee` with no `pipefail`**, so the step took tee's
  exit status: a publish that THREW was reported as a successful one, after
  which the poke waited for a generation that was never written.
- **The commit step's `working-directory` did not exist.** The worktree was at
  `../store`, a sibling of the checkout, and a step's `working-directory`
  resolves inside `GITHUB_WORKSPACE`. It lives under `RUNNER_TEMP` now.
- **A transient fetch failure looked like "no store yet".** `fetch ||
  branch-from-empty-tree || true` hands the publisher an EMPTY store on a
  network blip; it then starts `seq` at 1 and law 2 makes every running instance
  refuse that generation and every later one. The remote is asked whether the
  branch exists, and the two cases are handled apart.
- **"Nothing to commit" was `|| exit 0`**, which hid the publisher reporting a
  generation that never reached the store.
- **`fastBuild` never ran the manifest step**, and three of the 43
  `client/public` files are generated by it and gitignored (`characters.json`,
  `worlds.json`, `shipset.json`). So the gate could only ever fail in CI and
  only ever pass locally: `404 /characters.json`, `boot failed: failed to load
  character manifest: 404`, a `#ml-bootfail` div, no select screen. It also
  means the check that justified the fall-through guarantee ("dist root IS
  public verbatim") was TRUE BUT NOT EVIDENCE — it passed because this
  container had already built. The test that mattered was a fresh tree.
- **The gate threw away its own evidence.** The boot wait died with playwright's
  bare `TimeoutError` and `log: []`, because the errors, 4xx responses and
  console it collects were only printed AFTER it. One run with the dump in place
  named the cause above exactly. A gate that cannot be debugged from CI is not a
  gate.
- **A git identity in the commit step is one step too late.** Creating the store
  branch uses `git commit-tree`, which refuses without one, so the
  branch-creation path died the first time anything reached it — a first-run-only
  path nothing exercises until the day it matters.
- **A standing refusal logged once a minute forever.** The belt re-reads the
  pointer for the life of the process, so a generation refused for a reason that
  cannot change until the store does filled the 40-line ring `/api/bundle`
  shows a phone. Said once now, keyed on the pointer.

## FALL-THROUGH: the mixed generation is refused by arithmetic

A generation records the hashes of every file it is NOT publishing (the 43
`public/` files) in its manifest as `fallthrough`. The server hashes the image's
own dist root once — the image is immutable for the life of the process — and
refuses any generation whose fall-through hashes disagree with what it would
actually serve. A mismatch can only produce a refused publish, which is loud and
leaves the image serving whole; it can never produce a mixed generation. That is
what makes the `public/**` prohibition structural instead of a convention
someone has to remember.

**THOSE HASHES COME FROM THE IMAGE (`GET /api/bundle/fallthrough`), NOT FROM THE
RUNNER'S TREE.** Hashing its own dist root was the first cut, and it refused
every generation ever published — which is the whole reason the lane went a day
without ever serving one. The image's `client/public` is the OUTPUT of the
art-curation pipeline: the Dockerfile runs `shipset.mjs --write` against the
full art tree at `/src` and copies `shipset.json` in, and the manifest step runs
against that CURATED root. A runner that only runs `manifest.mjs` over a plain
checkout therefore produces different catalogs and no `shipset.json` at all, and
reproducing them properly IS the five minutes this lane exists to skip.
Measured 2026-09-19 against generation `34cb856184e86f51`: `monsters.json`
differed (`022ce9a905134422` vs the committed `5dfd6d814237f0f3`) and
`shipset.json` was absent entirely — 42 entries against the image's 43.

So the image is asked, because the image is the only authority on what the image
serves, and the recorded set is TRUE instead of a guess taken from the wrong
tree. **A failed read is a failed publish**: falling back to the local walk
would silently restore exactly the bug that refused everything, so the publisher
throws and the container lane ships instead.

What that guarantees: a generation is served ONLY by an image whose dist root is
byte-identical to the one it was published against — change any of those files
and every generation pinned to the old bytes is refused. What it does NOT claim:
that the bundle was BUILT against those catalogs. That would need the art
pipeline, and pretending otherwise would be the more dangerous lie. (Not the
local walk — it cannot reproduce the image. Not skipping the check — that is the
mixed generation this design exists to prevent.)

## Freshness

The pointer is the one mutable name, so it is read through the GitHub contents
API (`WIKI_GITHUB_TOKEN`, already set on the service for the wiki) — strongly
consistent. `raw.githubusercontent.com` sits behind a ~5-minute CDN, which
`live.ts` learned first. Blobs come from raw and need no such care: a blob is
addressed by its own hash, so a new blob is a new URL (a cache miss that goes to
origin, measured 0.4 s) and a stale answer is either the right bytes or refused.

Retries in the poke loop are expected, not a failure mode: a path pushed seconds
ago can briefly 404 while it replicates, and the server never flips to a
generation it could not fully read. The server's 60 s belt is the floor under the
loop, so a lost poke costs a minute, never a deploy.

## Measurements

Measured ON A RUNNER, run 3 attempt 2 — the first run that published:

| step | |
|---|---|
| checkout | 25 s |
| `npm ci` | 6 s |
| lane check | 1 s |
| chromium install | 24 s cold; the cache cannot warm until a run SUCCEEDS (its post step is skipped on failure) |
| **gate: build + boot + join + render** | **23 s** |
| publish + branch push + poke | ~5 s |
| **steady state, push -> live** | **~1 min** |
| container lane, same class of change | **8m30s** measured (push 20:58:23, live 21:06:53) |

So ~8x, and the build was never the cost:

| | |
|---|---|
| esbuild client build | 397-490 ms on a runner (vite/rollup 8.45 s, no incremental) |
| publish (build + write) | 419-766 ms |
| second publish, same workers | 20 of 22 blobs skipped, 2.51 MB written |
| the manifest step inside fastbuild | 319 ms, incremental |
| container lane, push -> live | p50 350 s; 7m09s -> 5m05s -> 4m52s over three batches |
| `raw` read of a fresh path | 0.4 s |
| `live/**` channel, push -> visible | 5-9 s (the proven precedent) |

**WHY IT IS NOT 10 SECONDS.** Two thirds of the remaining minute is checkout
(25 s) and the boot gate (23 s), and neither has anything to do with building
the bundle. Sub-10s means taking the gate OUT of the push path — publish, verify
after, revert on red — which the retained window makes cheap (a revert is a
pointer write and a poke). NOT BUILT: that trades a verified-before-live
guarantee for speed on a production the maintainer tests from a phone, so it is
his call to make against these numbers, not an assumption to bury in a script.

## What has actually happened in production

- **NO generation had been SERVED for the lane's first day, and both reasons are
  now fixed.** Measured end to end on push `819704f8b8` (02:13:20): the lane
  published generation `34cb856184e86f51` at **+86s** (run created +5s, store
  commit +86s, run done +134s after 8 fruitless pokes) and the fix reached
  players at **+299s BY THE CONTAINER LANE** (`/version` sha == image).
- CAUSE 1, the fall-through set the runner cannot reproduce — see FALL-THROUGH
  above. The publisher now reads it from the image.
- CAUSE 2, THE TIE: `refused 34cb856184e86f51 ... (1789783999 <= 1789783999)`.
  Equal, because a client-only push triggers BOTH lanes on the SAME commit: the
  container bakes `GIT_COMMIT_TS` from that commit, the lane publishes the
  identical `commit_ts`, and law 6 gives a tie to the image. Not a rare race —
  EVERY client-only push. It does not block the lane on its own (the OLD image
  is older, so it adopts the generation at ~+90s and the container merely
  re-serves the same code at +299s), but it wastes a five-minute build on every
  client push. The deploy should take the same client-only check and skip.
- **A CLIENT-ONLY PUSH NO LONGER BUILDS AN IMAGE.** `nangijala-deploy.yml`'s
  `resolve` job asks the compare API what the push changed and skips
  `build-deploy` when every path is one `fast-publish.yml` admits. The verdict
  DEFAULTS TO DEPLOYING and every uncertainty resolves that way — no push range
  (a `workflow_dispatch`, a new branch), an API that will not answer, an empty
  file list, a comparison at the API's 300-file ceiling — because a deploy
  wrongly skipped strands art or a server change with no signal, which is far
  worse than a wasted build. A skip is always recoverable by running the
  workflow by hand. The `test` job still runs unconditionally: it is the only
  thing that runs the 806-test suite on a client push, and it is parallel to the
  build so it costs no wall time.
- TRAP, PAID FOR IN BOTH LANE CHECKS AT ONCE: `^games2/client/(src/|index\.html)`
  admits `index.htmlx` — the alternation had no end anchor, so the lane would
  have carried a file the image answers. It is `index\.html$`. Same class as
  `cachepolicy.ts`'s note that `.../dist/assetsX/` must never pass as
  `.../dist/assets/`; a prefix test is not a path test.
- WHY EIGHT SILENT POKES COST A DAY: the reason sat in `/api/bundle` the whole
  time while the workflow printed one `::warning::` that read like replication
  lag. The poke now reads the reason and fails the job on a named refusal.
- The lane's REACH, measured over 14 days of `main` (2193 commits): 2.6% are
  client-only, 55.8% need the container (57% of those touch art, 18% touch
  server/`shared`), 40.6% are `coordination/`+`live/` and deploy nothing. A
  further 279 commits touched client code but were bundled with something else,
  so committing client changes alone would roughly quintuple the lane's reach.
  The container lane's five minutes is the bigger prize.

## The kill switch

    gcloud run services update <svc> --region <r> --remove-env-vars BUNDLE_STORE

The store then reads nothing and the image's `client/dist` serves exactly as it
did before the lane existed (`verify-fastlane` arm A proves byte-identical
behaviour; arm I proves an unreachable store falls back the same way). The image
is always the floor.

## Rejected

- **A GCS bucket for the store** — needs IAM and a console step from a
  phone-only maintainer; the GitHub channel is already proven in production.
- **`--set-env-vars` on the deploy** — it REPLACES the service's whole
  environment and would have silently dropped every variable set elsewhere.
  `--update-env-vars` merges.
- **Serving art from the lane** — see "What may never travel this way".
- **A truly append-only blob map** — not implementable in 1 GiB, and it adds
  nothing over the window: both answer a miss, one of them after an OOM.

## Verified, not assumed

- `WIKI_GITHUB_TOKEN` IS on the live service, which is what decides whether the
  lane is fast at all (the pointer read is the strongly-consistent contents API
  with it, and a ~5-minute CDN without it). Probed live: `POST /api/perf`
  answers `400 empty report`, not the `503 no token` it returns when the token
  is absent.
- vite's dist root IS `client/public` verbatim — 43 files, byte-identical — so
  the fall-through check can pass at all.
- `raw.githubusercontent.com` reads this repo unauthenticated in 0.4 s, so the
  blob channel works without a token.

## Open

- **An `/assets` miss never asks the store.** A name outside the process's
  window 404s even when the bytes are still on the branch. With
  `--max-instances 1` this is only reachable for a generation older than the
  window, which is the documented contract; a name index in the store would
  close it properly.
- **No rollback from a phone.** A bad publish is undone by the next container
  deploy (law 6) or by `--remove-env-vars BUNDLE_STORE`, but there is no
  "serve the previous generation" button. The retained window makes it cheap to
  add: a pointer write and a poke.
- **A client-only push still runs the container deploy too**, so the image
  catches up ~5 minutes later. Harmless and arguably right, but it is a
  decision that should be written down rather than incidental.
- **The store branch grows ~2.5 MB per publish** and the lane's own fetch pays
  it. `--depth=1` bounds the fetch; the branch itself wants periodic pruning.
- `VITE_GIT_SHA` is still baked into the bundle, so two builds of identical
  sources at different shas are different generations (no dedup across shas).
  Correct but wasteful; taking it out means the client reads its identity from
  the served document instead. Five inline sites: `client/src/main.ts` (~:102,
  :125, :158), `client/src/assetver.ts:22`, `composer/engine/assetver.ts:40`.
- The `?v=` art stamp uses the client's build sha, so a published generation
  loses the `immutable` grant for `public/` art until the next image deploy.
  Safe-fail (revalidation, 304s, since those bytes are unchanged) but it should
  read `image` from `/version` and stamp with that.
