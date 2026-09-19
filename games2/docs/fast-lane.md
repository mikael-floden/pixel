# The fast lanes — shipping client code AND ART with no image and no rollout

Two lanes publish to the RUNNING server. A generation is the COMPLETE
description of what sits on top of the image — client bundle + the generated
catalogs + an art overlay — so there is ONE pointer, ONE `seq`, ONE window and
ONE set of laws however a push arrives.

| lane | carries | checkout | push -> live |
|---|---|---|---|
| `fast-publish.yml` | `client/src/**`, `client/index.html` | sparse (6 s) | **33 s** |
| `art-publish.yml` | the nine art domains + the two tracked catalogs | full (24 s) | **~45 s** |
| the container | everything else, and every art push as well | full | **5 m 00 s** |

    push -> {fast,art}-publish.yml -> bundle-store branch -> POST /api/bundle/refresh -> served

Pieces: `scripts/fastbuild.mjs` (esbuild), `scripts/artbuild.mjs` (the
Dockerfile's curation, on a runner), `scripts/publish-bundle.mjs` (the store
writer and the delta), `server/src/bundlestore.ts` (the reader and the
overlay), `server/src/cachepolicy.ts` (the one-year decision).
Gates: `verify-fastbundle.mjs` (the bundle boots, joins, renders),
`verify-fastlane.mjs` (the channel cannot lie about a bundle),
`verify-artlane.mjs` (49 arms: it cannot lie about art either) and
`verify-artlive.mjs` (the art actually reached players — run against
production on every art publish).

THE TWO LANES SHARE ONE CONCURRENCY GROUP (`fast-publish`), repository-wide,
because the pointer's `seq` is read-modify-write and two publishers at once
could skip a generation. A push touching both art and browser code triggers
both workflows: fast-publish sees the art paths as OUTSIDE its set and stands
down, and the art lane carries the push whole (it builds the client anyway —
esbuild is 0.5 s).

## Why it exists

Push -> live on the container lane is p50 350 s (measured; run 4255 moved
1.14 GB for a 15-line change). The maintainer's ceiling is 10 s: "Having a long
deploy kinda kills the entire project." esbuild builds this client in 0.44-1.1 s
where vite/rollup takes 8.45 s with no incremental mode, and the channel that
carries `live/**` to production with no redeploy is already measured at 5-9 s
push-to-visible — so the lane is that proven channel carrying a bundle.

## What may NEVER travel this way

- **SERVER / `shared/` / config / `games2/scripts/**`.** Adopting it means
  re-importing modules in the process that owns the authoritative 20 Hz world:
  a restart, i.e. a revision. The scripts ARE the curation, so a push that
  edits them must be proven by a container build before its output is trusted.
- **ANY `client/public` FILE OUTSIDE THE FIVE GENERATED CATALOGS**
  (`PUBLISHABLE_ROOT`: characters.json, worlds.json, monsters.json, npcs.json,
  shipset.json). Every other dist-root file is `?v=`-stamped BY THE CLIENT —
  `withV("/ui2/icon-${t.id}.webp")` in hud.ts, `withV("/logo.webp")` in
  select.ts — and measured live against image e697e384ec5811,
  `/ui2/icon-map.webp?v=<sha>`, `/logo.webp?v=<sha>` and `/sw.js?v=<sha>` all
  answer `immutable`. Republishing one would change bytes under a URL a browser
  already holds frozen. The five that DO travel are the art pipeline's output,
  are fetched UNSTAMPED (`fetch("/characters.json")`,
  `fetch(gameUrl("/monsters.json"))`) so no browser has ever frozen one, and
  are told not to earn a year either way.
- **`wiki/` AND `live/`**, though both are mounted and served. The image builds
  `wiki/release_notes.json` from GIT HISTORY inside the build ("the image has no
  .git"); `live/**` already has its own no-redeploy channel that `live.ts` reads
  straight from GitHub; and `live/telemetry/perf.json` is
  `.dockerignore`-EXCLUDED, so it exists in the tree and deliberately not in the
  image — publishing it would ship a file the image is specifically built
  without. Measured: those are 3 of the 5 paths out of 50,121 where a runner's
  curated root differs from the image's, and they are the only 3 that are not
  art. All three fall through to the image, which is the right answer.

Every one of them is enforced by ARITHMETIC rather than by the path filter: see
FALL-THROUGH below.

## THE ART LANE

### The one rule that makes it possible

`?v=<GIT_SHA>` USED TO GRANT ART A YEAR, and that is the only thing that ever
stood between this repo and an art lane. The stamp promises "for this GIT_SHA
these bytes are fixed" — true while art could only arrive in an image, and a
lie the moment a lane repaints art on a running instance. One URL, two
byte-sets, frozen for a year: the unrecallable bug.

So `cacheControlFor` takes `isArt`, and `?v=` grants NOTHING when it is set.
Art earns its year through `?h=<hash>` VERIFIED AGAINST THE BYTES BEING SENT,
where the hash IS the content: new pixels are a new hash and a new URL, and the
collision is not expressible. That is arithmetic, not a convention anyone has
to remember.

- **`isArt` IS SET BY THE CALLER, NEVER DERIVED FROM A PATH PREFIX.**
  `ASSETS_ROOT` is `/assets` in the image and THE REPO ROOT in dev — where it
  contains `client/dist` — so a prefix test would classify the bundle's own
  public files as art locally and not in production. The one thing a cache rule
  may never do is mean two things. The distinction is which mount answered: the
  13 art mounts pass true, `client/dist` passes true only for the five
  publishable catalogs.
- **ALREADY-FROZEN URLS ARE CLOSED TOO.** The lane arrives IN AN IMAGE (server
  code changed), so `GIT_SHA` changes with it; a page running the new bundle
  stamps `?v=<new sha>` or `?h=`, which are different URLs from the frozen
  `?v=<old sha>` ones, so those entries are never requested again.
- **IT COSTS NOTHING MEASURABLE.** `/asset-index.json` names every one of the
  50,121 files under ASSETS_ROOT, so `?h=` carries all of it; `?v=` for art
  only ever covered the boot window and a failed index read, and both now
  revalidate (304s) instead of freezing.

### Reproducing the image's art root on a runner, in 9.3 s

`scripts/artbuild.mjs` is the Dockerfile's curation in the Dockerfile's ORDER,
and the order is the whole point — run it any other way and you get a root that
looks right and is not.

| step | ASSETS_ROOT | measured |
|---|---|---|
| `shipset.mjs --emit <root> --check --report --write` | THE FULL TREE | 2.6 s (hardlinks, 43,117 of 88,000 files) |
| `manifest.mjs --force` | THE CURATED ROOT | 1.6 s |
| `ship-tiles3.ts --root <tree> --out <root> --check` | — | 5.0 s (7,570 files, a pure `copyFileSync`) |
| hash the finished root | — | 1.2 s single-threaded, 0.86 s on 4 workers |

**THE SECOND STEP IS THE TRAP, and it is the same one that made the client lane
refuse every generation for a day.** `manifest.mjs` against a plain checkout
does NOT reproduce what the image serves, because the image builds the catalogs
from the CURATED root. Against the curated root it reproduces production's
`characters.json`, `monsters.json`, `npcs.json` and `worlds.json` BYTE FOR
BYTE — `npcs.json` came out `8fc7205ae6daf870`, against a COMMITTED
`npcs.json` of `62fde8b7e644b032`. **The committed catalog is not what ships**,
which is why the lane republishes it from the curated root rather than from git.

Only `shipset.json` differs, and only by its `generatedAt` timestamp — so the
lane PUBLISHES that file instead of pinning it. A file whose bytes cannot be
predicted must never be something a generation's admission depends on.

**THE HASHING IS 1.2 s WARM AND 23.4 s COLD**, and the difference is I/O
latency rather than sha256 (272 MB of sha256 is under a second), which is why
it runs on a small pool of worker threads with an in-thread fallback.

Measured against the live image's own index, the curated root reproduces
**7,004/7,004 tiles, 19,037/19,037 scenery, 2,719/2,719 characters2** and all
of sounds, music, items and lore identically. Five of 50,121 paths differ; the
three that are not art are the `wiki/`+`live/` exclusions above.

### The delta, and what a generation carries

    manifest.json  { files, root?, art?, fallthrough, git_sha, commit_ts }

- `files` — the client bundle, content-hashed, unchanged.
- `art` — ASSETS_ROOT-relative, **exactly /asset-index.json's keys**, so the
  served index is a MERGE and never a translation.
- `root` — dist-root-relative, **exactly `fallthrough`'s keys**, which it
  PARTITIONS: a dist-root file is published or pinned, never neither.
- The delta is computed against `GET /api/bundle/artbase` — the IMAGE's own
  index — and **NOT** against `/asset-index.json`, which is the MERGED document
  and already carries a live generation's overlay. A publisher diffing against
  that would produce a delta relative to the OVERLAY, and the next generation
  would silently drop every file the previous one published: art appearing and
  then vanishing, which is worse than art arriving five minutes late.
- **THE GENERATION ID COVERS THE OVERLAY.** It was the bundle alone, which was
  right while the bundle was all a generation carried — with an overlay, two art
  publishes of one bundle would be the SAME id, so the second would report
  "already current" and publish nothing while the art sat on the runner.
- **THERE IS NO REMOVAL LIST**, and that is the same fail-safe direction
  `shipset.mjs` states: shipping a spare file wastes bytes, dropping a reachable
  one 404s in production. A deleted file keeps being served from the image until
  the container lands, and nothing asks for it — it left the catalogs and the
  index in the same commit. A removal list computed wrong 404s live art.

### The overlay in the server

- **ART NAMES ARE NOT APPEND-ONLY AND MUST NEVER ENTER `names`.** LAW 1 exists
  for content-hashed bundle names, where a name and its bytes are the same fact.
  `scenery/oak/south.webp` is a mutable name BY CONSTRUCTION — that is the whole
  point — so the overlay resolves against the CURRENT generation only. In
  `names` it would make the second art publish refuse itself forever.
- The art route is `/assets/<domain>/<rest>` and needs the SECOND slash: the
  bundle's own emits are `/assets/<one-segment>`, so the two namespaces are
  structurally disjoint however a name is chosen. Registered BEFORE the 13
  static mounts; a miss is one map lookup and `next()`.
- `sendOverlayFile` goes through `cacheControlFor` rather than setting a header
  itself — one place decides the year — with `filePath: ""` so the bundle-dir
  rule cannot fire and `fileHash: () => file.hash`, the bytes in hand.
- The ETag is the hash of THOSE bytes, so it differs from the weak size+mtime
  validator `express.static` derives from the image's file: a browser holding
  the image's version revalidates into the overlay instead of 304ing onto stale
  bytes.
- `/asset-index.json` is the image's document merged with the generation's
  `art`, memoised on the serving generation (the 4.33 MB base is parsed once;
  a flip re-stringifies, tens of milliseconds ONCE per publish).
- **OVERLAY BYTES ARE KEPT FOR THE CURRENT GENERATION ONLY.** An overlay name
  resolves against the current generation by definition, so a previous
  generation's art can never be reached — holding it would be pure cost, and
  the cost is tens of megabytes on a 1 GiB instance whose death takes the world.
- **EVERY BYTE A LOAD BRINGS IN IS HANDED BACK ON A REFUSAL.** A generation
  refused AFTER its blobs landed used to leave them resident until the next
  successful flip called `evict()` — which is exactly the OOM the cap exists to
  prevent, arriving by the back door.
- **BLOBS ARE FETCHED ON A POOL OF 12, WITH ONE RETRY EACH.** Sequential was
  fine for a bundle's 22 files; an art generation's p90 is 333 and a 0.4 s round
  trip each would put 133 s between the publish and the flip — longer than the
  60 s belt, so the next tick starts over and it never lands.

### The caps, and what going over them means

`ART_FILES_MAX` 6000, `ART_BYTES_MAX` 64 MB, enforced by BOTH halves — the
publisher (so a push too big fails at the runner) and the server (as the bytes
ARRIVE, never from a number the manifest declares: a cap that trusts the payload
it is protecting against is not a cap).

Over either one the lane STANDS DOWN and the container lane carries that push,
which it is already building. Measured over 14 days of `main`, an art commit
changes p50 **21 files / 0.73 MB**, p90 333 / 9.68 MB, p99 5,172 / 22.6 MB, max
12,887 / 33.7 MB — so the caps admit essentially everything while bounding the
worst case.

### AN ART PUSH STILL BUILDS A CONTAINER, and that is load-bearing

A generation's art is the delta against the IMAGE, so it grows for as long as
the image stands still. Keeping the container lane on art pushes:
- bounds the delta — and therefore the store branch and the server's memory —
  to about five minutes of art commits instead of a day's worth;
- makes LAW 6 undo a bad art generation AUTOMATICALLY when the image lands,
  with nobody doing anything, which is the strongest recovery a phone-only
  maintainer can have;
- costs no wall-clock a person experiences, because the art is live at ~45 s.

(The client-only skip stays as it is: a client push changes no art, so no delta
grows and there is nothing to settle. Do not "fix" `nangijala-deploy.yml` by
adding the art paths to its skip — the comment there says so.)

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

### Traps the ART lane paid for

- **THE `?v=` GRANT REACHES THE DIST ROOT TOO, and the client stamps it.** I
  argued the catalogs were safe because they are fetched unstamped — true, and
  incomplete: I had not RESTRICTED what `root` may publish. Measured live
  against image e697e384ec5811, `/ui2/icon-map.webp?v=<sha>`,
  `/logo.webp?v=<sha>` and `/sw.js?v=<sha>` all answer `immutable`, and
  `hud.ts`/`select.ts` genuinely construct those URLs through `withV`. A
  generation that republished one would change bytes under a frozen URL —
  the same hazard as art, one level down. Now an explicit allowlist
  (`PUBLISHABLE_ROOT`) in the store's admission AND in the cache policy, with
  gate arms proving a ui2 icon and `sw.js` are refused. Found by the review
  panel, not by me.
- **THE DELTA MUST BE TAKEN AGAINST THE IMAGE, NOT AGAINST `/asset-index.json`.**
  That document is the MERGED one, so with a generation live it already contains
  that generation's overlay; a publisher diffing against it produces a delta
  relative to the OVERLAY and the next generation silently drops everything the
  previous one published. Art appearing and then vanishing. Hence
  `/api/bundle/artbase`, which is the image's own index and nothing else.
- **THE GENERATION ID WAS THE BUNDLE ALONE.** Two art publishes of one bundle
  hashed to the same id, so the second reported "already current" and published
  nothing while the art sat on the runner. The id now folds in `art` and `root`
  under their own headings.
- **SEQUENTIAL BLOB FETCH DOES NOT SCALE TO ART.** Fine for a bundle's 22
  files; an art generation's p90 is 333, and 0.4 s each is 133 s between the
  publish and the flip — longer than the 60 s belt, so the next tick starts over
  and it NEVER lands. A pool of 12 with one retry each.
- **A REFUSED GENERATION LEFT ITS BYTES RESIDENT.** Blobs land in the shared
  map as they arrive, and `evict()` only runs on a successful flip — so an
  oversized generation refused by the cap kept exactly the megabytes the cap
  exists to prevent, until some later publish succeeded. Every byte a load
  brings in is now handed back on any refusal.
- **A DIST-ROOT FILE NAMED BY NEITHER MAP WAS SILENTLY UNPINNED.** Before the
  overlay, `fallthrough` was the whole set by construction; with `root` able to
  publish part of it, a file in neither would be served from the image with
  nothing checking it. `verifyFallthrough` now takes the published set too and
  refuses that case.
- **THE CONTENT-TYPE WAS CACHED ON THE BLOB, NOT THE NAME.** Two files with
  identical bytes share one blob, so the type was whichever name loaded first —
  a 28-byte fully transparent `.webp` (a valid file, normal at the end of a fade)
  and an empty `.json` would have traded `Content-Type`s. Derived per lookup now.
- **`wiki/` AND `live/` LOOK LIKE ART AND ARE NOT REPRODUCIBLE.** Only found by
  diffing the runner's curated index against the live image's per domain: the
  image builds `wiki/release_notes.json` from git history, and
  `live/telemetry/perf.json` is `.dockerignore`-excluded so it is in the tree
  and deliberately NOT in the image. Publishing either would have shipped bytes
  the image is specifically built without. They are skipped rather than
  refused — `release_notes.json` differs on EVERY run, so refusing would have
  killed the lane permanently.
- **`isArt` FROM A PATH PREFIX WOULD HAVE MEANT TWO THINGS.** `ASSETS_ROOT` is
  `/assets` in the image and THE REPO ROOT in dev, where it contains
  `client/dist` — so `filePath.startsWith(assetsRoot)` classifies the bundle's
  own public files as art locally and not in production. The caller says which
  mount answered instead.
- **The gate handed the server `BUNDLE_STORE=local:<dir>`** where
  `backendFromEnv` wants the bare path, so every generation was refused with
  NOTHING in the log and the first run of the new gate failed 20 arms for a
  reason that was not in the code under test. The gate now prints the store's
  own `recent` lines on every disagreement, which is how the real refusals were
  read afterwards.
- **THE CLIENT LANE EMPTIED THE ART OVERLAY, and I had written a test calling
  that CORRECT.** The worst defect of the batch, because it was a design hole
  rather than a slip. The server resolves the overlay against the current
  generation alone — deliberate, and right: the served state must be a function
  of ONE generation or nothing can say what is live. But a browser-code push
  builds no art, so its generation carried none, and on the flip a repaint
  reverted to the image's old pixels while a newly ADDED file 404'd into a
  missing texture. games-ui pushes land all day between art pushes, so that is
  the common case. Reproduced against a real server before and after the fix.
  My unit test had asserted the consequence as a desirable property ("no stale
  overlay survives the flip") and gate arm M said the same — I had reasoned
  about the art lane in isolation and never asked what the CLIENT lane does to a
  live overlay. A generation now carries the COMPLETE overlay whichever lane
  writes it (`carryOverlay`): a map copy, zero uploaded bytes, and it fails
  CLOSED — a missing carried blob refuses the publish rather than drop live art.
  Arm R, and the test and arm M are re-framed to name where the guarantee
  actually lives.
- **THE FILTER GUARD WAS VACUOUS.** Arm Q asserted the deploy's filter did not
  CONTAIN `"<domain>/"`. The canonical widening spells the art set
  `^(characters2|tiles|…|lore)/`, which contains no such substring, so the arm
  walked straight through the one edit it existed to catch — and that edit
  removes the container from art pushes, which is what bounds the delta, the
  server's memory and the automatic law-6 recovery all at once. A filter is a
  program: `check-deploy-filter.mjs` EXECUTES all three lanes' filters against
  probe paths, is proven to go red on that widening, and runs in
  `nangijala-deploy.yml`'s `test` job — because `art-publish.yml`'s own `paths:`
  never matches an edit to a workflow file.
- **A ROLLBACK POINTED AT A GENERATION WHOSE OVERLAY BYTES WERE EVICTED, AND
  THE STORE SERVED IT ANYWAY.** The sharpest defect of the batch. Overlay bytes
  are kept for the CURRENT generation only, so a generation still inside the
  window has its NAMES and not its art — and a rollback points straight at one
  of those. `doRefresh` skipped the load on a bare `gens.has(id)`, flipped, and
  then resolved that generation's art to hashes whose bytes were gone: its
  CLIENT served against the IMAGE's art and catalogs, with an asset index naming
  bytes nobody held. That is the mixed generation the whole partition exists to
  make unrepresentable, reached through the one path nobody had exercised
  because the rollback has never fired in production. The test is now whether
  every byte a generation names is in hand (`materialised`), not whether its
  names are remembered — gate arm O, plus a unit test.
- **NINE NEW REFUSALS DID NOT MATCH THE WORKFLOW'S GREP, so every art refusal
  reported GREEN.** Both workflows decide "a defect, or still replicating?" by
  looking for `refused <id>` in `/api/bundle`; the new refusals were phrased
  `— refusing`, so a push would have shown a green check and a summary saying
  the belt would adopt it while the art was never served. That is verbatim the
  failure that cost this lane its first day. Every refusal now goes through one
  `refuse(id, why)` helper, so a new one cannot be added in the wrong shape.
- **A REFUSED GENERATION RE-DOWNLOADED THE WHOLE ART DELTA EVERY 60 SECONDS,
  FOREVER.** A refusal does not advance `this.ptr`, so the belt re-read the same
  pointer, found the generation absent from `gens`, and re-fetched everything
  before refusing again for the identical reason — thousands of raw requests a
  minute at the p99 delta, from the production egress IP. A STRUCTURAL refusal
  is now remembered per pointer; an INCOMPLETE read deliberately is not, because
  a blob still replicating is exactly what the belt exists to retry. That split
  is why `doLoad` returns `ok | refused | incomplete` rather than a boolean.
- **NOTHING EVER DELETED A BLOB.** `git add` carries every blob ever published
  in the branch's HEAD tree and `--depth=1` materialises that whole tree on
  EVERY publish (depth bounds history, not the tree). Measured: the distinct art
  blobs 14 days of `main` would have written come to 86,952 objects and 1.50 GB
  — so within about a week the fetch alone costs more than the five minutes this
  lane exists to skip, and then the repository crosses GitHub's size limit. The
  publisher prunes to the window after the pointer write, and the workflows
  `git add -A` so the deletions are staged.
- **AND THE FIRST PRUNE DELETED THE LIVE GENERATION'S BYTES.** It kept the
  pointer's window — which is the PUBLISHER's list and can name generations this
  instance REFUSED, so the generation actually being served can sit outside it
  entirely. The server's own eviction learned this once already and keeps the
  union of the window and what it served. The prune now ASKS the server
  (`/api/bundle`), and a failed read prunes NOTHING — the same rule the
  fall-through has, because a delete decided from a guess is the one mistake
  here the next publish cannot undo. Caught by `verify-fastlane` arm M, which
  exists for precisely this trap in its client-lane form.
- **`.dockerignore` DOES NOT FILTER A GIT CHECKOUT**, so the runner's ship-set
  closure is a strict SUPERSET of the image's: measured 11.73 MB in two files,
  `maps2/worlds3/the_game/overview_full.webp` (10.95 MB) and
  `live/telemetry/perf.json` (0.78 MB). Neither ever appears in the image's
  base, so both would be "new" on EVERY art push forever — 11 MB of the 64 MB
  cap each time — and it would make a file the image is deliberately built
  WITHOUT fetchable from the running game. `artbuild.mjs` reads `.dockerignore`
  rather than keeping a second list, with Docker's own semantics and the one
  that matters: THE LAST MATCHING RULE WINS (a matcher asking "any exclude and
  no re-include" gets `*` + `!tiles` + `music/**/*.wav` wrong three times over).
  After it: 50,119 paths against the image's 50,119, zero on either side only,
  and 3 differing of which the domain allowlist publishes exactly 1.
- **THE RETRY HAD NO DELAY.** A freshly pushed raw path answers a CACHED
  negative, so a back-to-back retry asks the same edge the same question and
  buys nothing — and the art lane multiplies fresh paths by 15x over a bundle.
  Three attempts now, 250 ms then 750 ms.
- **THE AUDITION PAGES NEVER LOADED THE ASSET INDEX.** `#foley` returns from
  `main.ts` BEFORE `loadAssetIndex()` and `#score` did not await it, so both
  fell back to `?v=` — free while `?v=` still froze art, and 100% of their
  caching once it does not. The maintainer's two QA tools would have
  re-downloaded every take on every interaction. Both await it now.
- **A cap tested against its production value proves nothing.** Arm L started
  the server with a 150 KB / 40-file cap to exercise the mechanism, and asserts
  the SHIPPED 64 MB / 6000 separately against the constants — a gate that only
  ever sees a test value proves the code and not the policy.

## "BROWSER CODE ONLY" — what the lane check asks

It asks what a push CHANGED, never who pushed it. The old label was
"client-only", which reads as "only the client pushed" — and in this repo that
names something real, because the wiki BROWSER does cause git commits (you tap a
verdict, `live/**` changes; the browser initiates and the server commits with
its own token, `server/src/live.ts`). Say it the way it works instead: **the
lane carries a push that only changes the game code the browser runs. The new
file goes onto the already-running server, and browsers fetch it from there** —
no image, no restart, nobody disconnected. Anything else (the server's own
program, the art) lives INSIDE the container and needs a new container.

## PUBLISH FIRST, VERIFY AFTER, ROLL BACK ON RED

The gate used to run in front of the publish, which was right while nothing
could undo a bad generation. Measured, it put 28 s of checkout and 14 s of
browser ahead of every publish — the larger half of the 66 s a person sits
through. Now the `publish` job publishes and the `verify` job gates afterwards,
and a red gate rolls production back.

- **The rollback is a pointer write and a poke.** `publish-bundle.mjs --revert`
  points the store at the generation that was serving a moment ago — its blobs
  are still there, because a content-addressed name is never rewritten — then
  pokes, so it is live in about a second rather than within the 60 s belt.
- **`current: ""` means SERVE THE IMAGE**, and the store adopts it rather than
  refusing it (the seq still advances, so a later publish supersedes it
  normally, and law 6 never orders it against the image because it IS the
  image). That is where a rollback goes when there is no previous generation,
  and it is also the kill switch that used to need a laptop and
  `--remove-env-vars BUNDLE_STORE`.
- **A generation records its own `git_sha` and `commit_ts` in its manifest.**
  The pointer stamps only the CURRENT one, so stepping back off it lost exactly
  the field law 6 orders the two lanes by. A rollback reads the target's own
  stamp; a generation published before manifests carried one falls through to
  the image rather than being given an invented stamp.
- **The publish job takes a SPARSE checkout** (`games2`, `live`) because it
  needs no art: fastbuild takes client/public's generated catalogs from the
  running image, hash-verified, instead of regenerating them from the art
  domains. The `verify` job still takes the whole tree — the gate renders the
  real world and genuinely needs it (measured: an empty `ASSETS_ROOT` hangs it
  past 400 s with no output).
- TRAP: a sparse cone propagates into every worktree added from that checkout.
  The store worktree's files landed outside `games2`/`live`, so `git add bundle`
  staged nothing and the publish failed — `git sparse-checkout disable` in the
  worktree. Found only because "nothing to commit" is an ERROR in that step
  rather than a no-op; the alternative was reporting a publish nobody pushed.
- What this buys, and what it costs: the exposure is the seconds between a bad
  generation being served and the gate finishing. The image is untouched
  throughout and is what a rollback falls back to.

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

THE ART LANE, measured 2026-09-19:

| | |
|---|---|
| full checkout of the 1.7 GB tree on a runner | **24 s** (deploy run 4338) |
| `shipset.mjs --emit` (hardlinks, 43,117 files / 246 MB) | 2.6 s |
| `manifest.mjs` against the curated root | 1.6 s |
| `ship-tiles3.ts` (7,570 files copied) | 5.0 s |
| hashing the finished root (50,121 files / 272 MB) | 1.2 s warm, 0.86 s on 4 workers, **23.4 s cold** |
| **the whole curation** | **9.3 s** |
| the asset index document | 4.33 MB |
| art delta per commit, 14 days of `main` (200 commits) | p50 **21 files / 0.73 MB**, p90 333 / 9.68 MB, p99 5,172 / 22.6 MB, max 12,887 / 33.7 MB |
| the container lane for the same art push | **5 m 00 s** (13:45:51 -> 13:50:51), of which docker build+push 222 s and the rollout 22 s |

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
- **A truly append-only blob map** — not implementable in 1 GiB, and it adds
  nothing over the window: both answer a miss, one of them after an OOM.
- **Widening `fast-publish.yml` to carry art** instead of a sibling workflow —
  it would put the full checkout's 18 extra seconds in front of every BROWSER
  code push, which is the one wait the maintainer actually sits through.
- **A second pointer for art.** Two pointers can disagree, and the
  disagreement that matters is the dangerous one: new catalogs naming art that
  is not there, or art with no catalog entry. One generation cannot express that
  state. An art push has to build the client anyway (0.5 s), so the "saving"
  was never real.
- **Deciding the delta from `git diff` instead of by hashing.** It is exact for
  tracked files and silent when it is wrong: a file whose blob the lane failed
  to publish falls through to the image's OLD bytes, so the art push simply
  does not appear, with nothing said. Hashing the finished root costs 1.2 s and
  cannot miss.
- **Packing the art delta into one blob** to make materialisation a single
  fetch. It would bound the request count regardless of file count, but it
  destroys blob dedup — every publish re-uploads the whole delta — and the
  bounded fetch pool plus dedup already gets a steady-state flip down to the
  ~21 blobs that actually changed.
- **An `art_removed` tombstone list** — see "there is no removal list" above.
- **Revoking the `?v=` grant for the WHOLE dist root** rather than the five
  publishable catalogs. It would cost every UI icon and both logos their cache
  for nothing, since the lane has no reason to publish them.

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
- **A RUNNER CAN REPRODUCE THE IMAGE'S CURATED ART ROOT.** Run and compared
  against the live image's own index: four of the five dist-root catalogs
  byte-identical (the fifth differs only by a timestamp), 7,004/7,004 tiles,
  19,037/19,037 scenery, 2,719/2,719 characters2, sounds/music/items/lore
  identical. The locally computed hash of
  `items/abalone_shell_half/sprite.webp` earned the `immutable` grant from
  PRODUCTION, which is the strongest possible confirmation that the bytes match.
- **`ship-tiles3.ts` is a pure copy** (`copyFileSync` only, no transform), so
  its output is deterministic.
- **There is no CDN in front of Cloud Run** — `/version` answers
  `server: Google Frontend` with no `via`, `age` or `x-cache`, and the deploy
  configures none. The only cache in the path is the browser's, which is
  precisely why a wrong `immutable` is unrecallable.
- **Every one of the 50,121 curated art paths** matches
  `^[A-Za-z0-9][A-Za-z0-9._@/-]*$`; none holds `..`, a backslash, a space or a
  non-ASCII byte; the deepest is 8 segments and 117 characters. That is what
  `safeOverlayPath` is allowed to be as narrow as it is.

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
- **THE ROLLBACK HAS STILL NEVER FIRED IN PRODUCTION.** It is now gated in both
  directions — `verify-artlane` arm O drives a real revert onto a generation
  whose overlay bytes were evicted and proves its own art comes back — but no
  RED GATE has ever triggered one for real. Both lanes depend on it, so it wants
  a deliberate rehearsal rather than a first outing on an incident.
- **An art push whose OPEN pages do not reload keeps the old textures.** Art is
  loaded once into Phaser's texture cache, so a mid-session art publish appears
  on the next load. Identical to what a container art deploy does today, and
  the version banner already offers the reload.
- **The store branch's HISTORY still grows**, even though its HEAD tree is now
  pruned to the window: a blob deleted from the tip stays reachable from the
  branch's history, so the REMOTE keeps counting it and the repository grows at
  roughly the rate the lane publishes — measured **0.60-0.67 GB / 11k-16k blobs
  per 14 days (~45 MB/day)** of publishable art. Each run's `--depth=1` fetch
  stays small, so the lane's own 45 s is safe for months; the pressure is
  GitHub's advisory 5 GB, in the order of weeks. The fix is to make
  `bundle-store` a SINGLE-COMMIT branch (commit with no parent,
  `push --force-with-lease` against the tip this publish read, refusing rather
  than forcing on a lease failure). Safe by construction — the server reads the
  branch TIP and never a parent, and both gates fetch `--depth=1` — but it is a
  force-push on a machine-owned branch, so it is the maintainer's call to make
  rather than something to slip in.
- **`monsters/config/candidates.json` and `maps2/.../overview_full.webp` were
  in the measured delta** because this tree was a few commits ahead of the
  image. Both are legitimately publishable; noted only so a future reader does
  not read them as noise.
