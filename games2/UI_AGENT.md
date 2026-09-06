# UI_AGENT.md — the games-ui agent (HUD / UI / menus)

## Who this is

`games2/` is now worked by **two** agents (maintainer decision 2026-07-17 —
"the game starts to become so big now so we need a dedicated
UI/HUD/MENU-agent"):

- the **games agent** — gameplay, netcode, world rendering, shaders, server
  (board file `coordination/games.json`);
- the **games-ui agent** (THIS charter) — everything the player reads and
  taps that isn't the world itself: the HUD, the page frame, menus, screens,
  overlays (board file `coordination/games-ui.json`).

Both follow `games2/CLAUDE.md` (it stays the single source of truth for how
the game works) and `coordination/PROTOCOL.md`. This file only adds the
split: who owns which files, so the one-writer-per-file rule keeps working
INSIDE the shared domain.

**Read `games2/docs/UI_AGENT_ONBOARDING.md`** — the game agent's handoff
handbook: how the maintainer reviews (annotated screenshots, RED=remove /
BLUE=restore-or-coordinate / GREEN=keep, apply marks LITERALLY), the
screenshot-registration recipe, keying recipes per backdrop colour,
first-upload-is-pixel-source, send verification crops back to his phone,
and the frame/clock asset contracts. It outranks this file on technique —
but note its frame/clock ASSET pipeline is historical since the 2026-07-30
wiki-style remake (the frame and sprite clock no longer exist at runtime).

## File ownership (one writer per file, applied inside games2/)

**games-ui owns (the DOM overlay layer + its assets/QA):**

- `client/src/hud.ts` — bottom HUD: tab row, pages (Backpack/Equipment/Map/
  Settings/Logout), the golden-ratio split layout.
- `client/src/theme.ts` — the shared wiki theme: design tokens copied from
  `wiki/site/wiki.css`, the light/dark choice (localStorage `wiki-theme`,
  shared with the wiki), and the `.ui-*` component recipes.
- `client/src/clock.ts` — the day/night clock: the "Fern starfall" PILL, a
  40x16 art-pixel landscape painted into a canvas and shown at x2, parked at
  the game view's bottom-right corner (chat.ts reserves its lane). The sun
  and the moon are two independent bodies, each crossing in 2/3 of a day at
  the same speed and sharing the sky at dawn and dusk, so it needs no
  hand-off animation and the server needs no time freeze. Driven only by
  `setClockTime(timeIdx + phaseT)` + `clockStar()`. See the CLOCK PILL
  section of `games2/CLAUDE.md` before changing the art, the motion, or
  TIME_PHASE_SECONDS (day and night must stay equal).
- `client/src/controls.ts` — handedness (right/left, default right): which
  side the analog stick lives on, and in landscape which side the whole menu
  column takes. localStorage `ml-hand` + the "ml-hand" event; consumed by
  hud.ts (applyLayout + the Settings "controls" button) and gamepad.ts.
- `client/src/gamefreeze.ts` — puts the Phaser loop to sleep while a
  full-screen reader is over the world (today: the wiki drawer). The seam
  between `wikipanel.ts`, which asks, and `main.ts`, which registers the
  game — neither has to know about the other. Probe `__mlFreeze`.
- `client/src/wikinear.ts` — the 🔍 "what am I standing next to?" button
  (its face is the maintainer's own PixelLab antique magnifying glass,
  MIRRORED — `/ui2/icon-search.webp`, an exact 2x of the flipped 24x24 export
  kept at `client/ui-src/icon-search-src.png`),
  a pill-high square one gap left of the Wiki button, and the game's half of
  `spec/WIKI_NEAR.md`: it opens the drawer on `#/near` and hands the wiki a
  nearest-first snapshot keyed by the wiki's own ids (from WorldScene's
  `__ml.nearby()`), answering `wiki:wantNear` for as long as a drawer is up.
- `client/src/wikibtn.ts` — the in-game Wiki button; its face is the
  maintainer's own PixelLab open old book (`/ui2/icon-wiki.webp`), the same
  one the select screen's Wiki button wears.
- `client/src/select.ts` — character/world select screen.
- `client/src/loading.ts` — loading overlay.
- `client/src/roster.ts` — player roster overlay (currently unmounted).
- `client/src/uiscale.ts` — LEGACY compensating zoom; only `loading.ts` and
  WorldScene's reconnect toast still consume it. The wiki-style UI proper is
  plain responsive CSS with NO zoom compensation.
- `client/public/ui2/`, `client/public/logo*.webp`, `client/public/icons/`,
  `client/public/manifest.webmanifest` — UI art + PWA shell.
  **UI art is lossless WebP** (project default, 2026-07-31). `public/ui2/`
  now holds ONLY what the runtime loads: `select-bg`, `gold-icon` and the
  seven tab icons. The 4.7 MB of retired UI-kit bakes (frame/stone/plate/
  kit-*/select-frame/select2/select3 and all of `public/ui/`) was DELETED —
  the wiki-style remake stopped loading it in 2026-07-30 and it was pure
  deploy weight; the maintainer's SOURCE art is untouched in
  `client/ui-src/`, and git has the bakes.
  EXCEPTION, do not "fix": `public/icons/*.png` stay PNG. iOS ignores a WebP
  `apple-touch-icon` and manifest-icon WebP support isn't universal — a
  ~236 KB saving that would cost the install icon on iPhones, and nobody
  downloads them during play.
- UI build scripts: `scripts/build-ui-tiles.mjs`, `scripts/build-pwa-icons.py`,
  `scripts/bake-tab-icons.py` (emits `.webp` — convert at the SOURCE, never
  as a build step: a Dockerfile conversion would add minutes to every deploy
  and bust the layer cache).
- UI verify scripts: `scripts/verify-select.mjs`, `scripts/verify-chat.mjs`,
  `scripts/verify-mobile.mjs`, `scripts/verify-landscape.mjs`,
  `scripts/verify-dropqty.mjs` (backpack ×N badges + the drop dialog, both
  orientations; the SERVER's count clamp is unit-tested in
  `server/test/combat.review.test.ts` instead),
  `scripts/verify-levelup.mjs` (the XP bar's level-up),
  `scripts/verify-tagline.mjs` (the logo's tagline pool + the erased art),
  `scripts/verify-map.mjs` (the Map tab: the file it fetches, a ceiling on
  its size, and the dot checked against the RENDERED image's own diamond),
  `scripts/verify-wikibtn.mjs` (the in-game Wiki button, the wiki's
  remembered reading spot, the game-loop freeze while it is open, the
  🔍 button + its `wiki:near` contract, and that the 🔍 icon really decoded).
- This file.

**The games agent owns everything else**, notably: `client/src/scenes/`,
`chat.ts` (chat internals — per the handoff), `nightlight.ts`,
`lighting.ts`, `maps.ts` (world consumption — NOT the Map tab page),
`manifest.ts`, `net.ts`, `placeholder.ts`, `main.ts`, `shared/`, `server/`,
`Dockerfile`, `deploy/`, `loop/`, the remaining scripts, and
`games2/CLAUDE.md` + `games2/README.md`. The Settings buttons' BEHAVIOUR is
also theirs — they call into WorldScene; the `HudActions` interface
(`act`/`get`/`state` callbacks in hud.ts) is the contract between us. Keep
it stable; changing its semantics needs a board round trip.

**Shared glue — coordinate via the board BEFORE editing:**

- `client/src/main.ts` and `client/index.html` — boot glue + the CSS both
  layers hang off. Small mechanical hook-ups (mounting a new overlay,
  adding a CSS block for a UI element) are fine; announce them in a board
  note. Structural changes get a board request first.
- In-canvas HUD elements living inside `scenes/WorldScene.ts` (stamina bar,
  toasts, tap beacon, shooting-star log): the scene file is the games
  agent's; the UI agent proposes changes via board request (or extracts the
  element into a ui-owned module by agreement).
- `package.json` / lockfile: either agent may add a dependency; note it.

If a UI task genuinely needs an edit in the other agent's file, post a
`board.py post games-ui --to games --text "..."` request (and vice versa) —
one Routine cycle of latency is fine, conflicting edits are not.

## Backlog / issues

Issues live on `mikael-floden/pixel`, labeled **`game` + `ui`** — the UI
agent works that intersection and keeps **≥ 5 open `ui` issues** filed
(concrete, ~one-iteration each, same format the games loop uses). The games
agent keeps its ≥ 15 `game` backlog; it should route new UI-shaped ideas to
the `ui` label instead of implementing them.

Open UI backlog at charter time: #5 (Continue-as fast path), #10 (select
search/paging), #12 (inventory panel — UI half; the Inventory model/server
half is the games agent's), #16 (dialogue box — UI half, needs NPC entities
from the games agent), #18 (title/landing screen).

## Iteration procedure (one run = one iteration)

1. `python coordination/board.py inbox games-ui` — MANDATORY first step;
   handle requests addressed to you.
2. `git pull --ff-only origin main`, `cd games2 && npm install`.
3. Tend the `ui` backlog (file/close issues as needed).
4. Pick ONE issue; implement inside your owned files (board-request anything
   beyond them). Keep `npm test` + `npm run typecheck` green; browser-bound
   checks go through `scripts/verify-*.mjs`.
5. Update `coordination/games-ui.json` (heartbeat + notes), commit
   (`Fixes #NN`), **push straight to `main`** (maintainer 2026-07-17: no
   feature branches; rebase on reject like every other agent), confirm CI.

## Hard-won UI rules (inherited — do not relearn these)

- **The remaining pixel art scales nearest-neighbour only, at its TRUE
  grid.** Tab icons render at the AUTHORED 1x grid — hud.ts sizes each img
  to naturalWidth/2, since the /ui2 bakes are exact 2x of hand-drawn art on
  non-square canvases (a fixed square box distorts AND fractionally scales;
  maintainer 2026-07-30). No smoothing upscales, ever. Everything else is
  plain CSS on the shared wiki tokens (`theme.ts`) — no sprites, no
  9-slices.
- **NO zoom compensation in the wiki-style UI** (2026-07-30 remake): all
  overlays are plain responsive CSS, exactly like the wiki. The old
  `--ml-uizoom` machinery survives ONLY inside `loading.ts` and WorldScene's
  reconnect toast — never reintroduce it elsewhere, and never divide new CSS
  by `var(--ml-uizoom)`.
- **One theme, two surfaces**: light/dark lives in localStorage
  `wiki-theme` + `<html data-theme>`. The game toggles via Settings; the
  wiki drawer mirrors live (`wikipanel.ts` + the `ml-theme` window event).
  Any new UI must style BOTH themes via the tokens, never hardcode colours.
- **QA at DEVICE-WIDTH mobile geometry** (393×851, dpr 2.75), light AND
  dark. The desktop-site squeeze (viewport 980×2123, screen 393×851) still
  matters for the CANVAS (WorldScene.zoomFor) and the wiki drawer's iframe
  scaling — check it when touching those.
- **A DEVICE SCREENSHOT'S SCALE IS NOT THE PORTRAIT DPR — MEASURE IT.** The
  maintainer's phone is 393 css px wide in portrait (dpr 2.75) but its
  LANDSCAPE viewport is ~988 css px, i.e. **2.28** device px per css px, and
  a landscape screenshot also carries a ~152px black cutout band on one side
  that is NOT viewport. Converting one of his red position marks with the
  portrait dpr under-reported the move by 3× ("10px" when he had marked 28)
  and he caught it. Anchor every measurement to something whose CSS size you
  KNOW and can find in the image — the analog stick's 148px well (fit a
  circle to its blur disc), the clock pill's 80×32 — then convert.
- HUD geometry: `applyLayout()` publishes `--hud-h`/`--hud-h-inv` in REAL px
  (consumers parseFloat them — keyboard lift, chat anchors). The split must
  keep matching `#game`'s 61.8/38.2.
- Pointer events in the HUD must never reach Phaser; e2e taps stay in the
  top 61.8% of the page.
- Buttons print their state ("time speed: x2"); switches render pressed
  while ON; `pressFx` handles touch (CSS `:active` is hover-only on mobile).
- Suppress `contextmenu` on roots containing `<img>` (Android long-press).
- Movement-timing e2e stays on small viewports (headless-GL starvation);
  UI screenshots use the real phone geometry — the two never mix.
- **THE WIKI BUTTON LIVES WITH THE CLOCK PILL** (`wikibtn.ts`, maintainer
  2026-08-13, placements from his three red-circled shots): pill-sized
  (80x32+border), same right edge, and one 10px gap BELOW the pill in EVERY
  placement (maintainer 2026-09-03, on a screenshot: "I think it looks better
  if the wiki+search is under the time-of-day pill — they should swap y
  position"). At rest the Wiki row takes the corner anchor and the PILL steps
  up over it by `--ml-stack-step`; in right-handed landscape the pill is
  top-anchored under the XP chip and the row hangs one step under it, which
  already read that way. ONE order everywhere, including over the phone
  keyboard — chrome that reorders when the keys come up reads as a bug.
  THE STEP IS PUBLISHED, NOT COPIED: `--ml-stack-step` is declared once by
  wikibtn.ts (it is that button's own outer height + the gap) and read by
  clock.ts, wikinear.ts and hud.ts's keyboard lift. It was three hardcoded
  44s before the swap, which is exactly the shape that desyncs. And the chat
  log moves WITH the pill over the keyboard: "the log and the pill on one
  line" is an approved 2026-07-31 arrangement that verify-chatpage pins. Every
  rule mirrors `.ml-clock` plus one step, including the `:root.ml-kb-up`
  keyboard lift, so the two always move as a stack; change the pill's
  anchoring and this file changes in the same commit. It is in hud's
  `ml-noanim` list (rotation snaps). The drawer it opens REMEMBERS the
  reading spot (`wikipanel.ts`, the wiki agent's module, edited on the
  maintainer's ask + board note): {hash, scroll} in `ml-wiki-spot`, saved on
  close and pagehide, applied on the next open — the hash rides the iframe
  src, the scroll waits for the page to be tall enough (the wiki fetches
  data.json before it renders).
- **THE MAP TAB FETCHES `minimap.webp`, AND THE DOT IS CHECKED AGAINST THE
  PICTURE.** Every tree publishes that name now (maps2 47e08659d1); `overview`
  survives only as an iso fallback, and it is the QA render's name — for
  the_game it WAS render3's 16300x7576 / 15.2 MB review render, fetched on a
  phone and scaled into a ~360px frame, which is what made verify-landscape
  report a 16300px map frame. Hence the size ceiling in `verify-map`: a
  map-tab image over 2400px wide is a review render, not a map.
  THE DOT'S GROUND TRUTH IS THE RENDERED BITMAP, never a second copy of
  `isoFrame` — a gate that re-derives the projection agrees with the client
  about a shared mistake. The render is an iso projection of a square grid, so
  the four corner CELLS are the four APEXES of the diamond in the picture, and
  those can be found by reading the pixels. Measured on the new 1200x558
  downscale: every corner within 0.4% of its apex. That check is also the one
  that would catch maps2 CROPPING or re-centring the render one day — the
  client places the dot as a fraction of the FULL iso canvas, so a crop moves
  every dot and nothing else in the client would notice. (Asked about in
  2026-09-06: the landmass looks centred because an iso projection of a square
  grid IS a centred diamond, not because anything was cropped.)
- **A UI ICON IS THE MAINTAINER'S ART AT ITS AUTHORED GRID, NEVER AN EMOJI.**
  The 🔍 button shipped with the `&#128269;` glyph and he replaced it with his
  own PixelLab piece (2026-09-03) — an emoji is whatever the phone's font
  vendor drew that year, and it cannot be pixel art. The 📖 and 🌗 on the Wiki
  and Theme buttons went the same way the next day. The recipe, same as every
  `/ui2` icon: keep the untouched export as the PIXEL SOURCE in
  `client/ui-src/`, bake an EXACT 2x nearest-neighbour upscale to
  `/ui2/<name>.webp` through `scripts/to-webp.py` (which verifies the
  round-trip), and let the runtime size it to `naturalWidth / 2` — that lands
  it on its authored grid on every screen, and it is ONE rule shared with
  hud.ts rather than a hardcoded box per icon. Stamp the URL with `withV()`.
  A transform is worth asserting in the bake script itself: a mirror must be a
  pure mirror, a 2x must reproduce the source in every 2x2 block, and a
  re-centring must move the same pixels it started with — or you have
  resampled pixel art without noticing.
  WHEN AN ICON SHARES A BOX, GROW THE BOX — never squeeze the art. The select
  screen's Wiki and Theme glyphs sit in one fixed `.ml-cicon` exactly so the
  pair cannot differ in size or baseline (his 2026-07-30 report), so it went
  19px -> the art's authored 24px and BOTH kept their alignment; sizing one of
  a matched pair alone re-creates the very bug the box exists for. Then check
  what the growth PUSHED: 5px of extra button height silently closed the 9px
  gap to the Theme button below, because `.ml-theme{top}` is an absolute
  offset that does not follow a taller neighbour. And mind the FRAMING of
  what you are given — the theme disc's export sat flush to two canvas edges
  while the book beside it was centred, which reads as 2px of misalignment in
  a shared box; the bake centres the ink (pure integer translation, export
  kept as the source of record).
- **A MISSING `/ui2` FILE IS AN EMPTY BOX, NOT AN ERROR.** Nothing throws, the
  button keeps its shape, and a screenshot at a glance looks like a design
  choice. The only honest gate is the DECODED bitmap — `naturalWidth` is 0 for
  a 404 and the bake's real width when it arrived. Assert cache stamping
  RELATIVE to an icon that already has it (both bare, or both `?v=`/`?h=`):
  `withV()` is a deliberate no-op in dev, so "does the URL end in ?v=" tests
  the environment, not the code.
- **THE 🔍 BUTTON IS THE WIKI'S SEARCH, SORTED BY DISTANCE** (`wikinear.ts`
  + `spec/WIKI_NEAR.md`, maintainer 2026-09-02: "a square search icon to the
  left of the Wiki button … directly to the search with the results sorted by
  how far away they are from the player — a way to fast find what you stand
  next to"). Two agents, one contract file; change it in the same commit as
  either side. THE IDS ARE THE WIKI'S OWN, and they come from two id spaces
  that look alike: a Tiles 2.0 material is a `tiles` page, but a Tiles 3.0
  ground TYPE (`the_game`, every maps3 world — `grass`, `brown_paving_stone`)
  is a `world` page (`#/world/<type>`), and the wiki keys scenery by the bare
  piece id while a placement names `category/piece`. The first cut sent
  `tiles/grass` and `objects/streetlights/streetlight_007` and 7 of 29 rows
  routed; the gate now fetches the wiki's shipped `data.json` and requires
  the ground under the feet to route. A stale wiki BUILD can still leave a
  fresh roster entry unresolved — that is reported, never failed. The
  snapshot is taken AFTER the freeze, so it cannot go stale while the player
  reads; `#/near` is a page like any other to the spot store (the Wiki button
  returns to it), the 🔍 always starts a fresh one. THE EAR (maintainer, same day:
  "does #/near also contain the music playing right now and the sound effects
  triggered the last 30 s?"): the snapshot carries `heard` — the composer's
  ledger (`gameAudio.heard()`: score now + every sound EVENT of the last 30 s,
  newest first, `sound: null` when the event is unassigned and played nothing,
  which is the row the Game Master wants). The ledger lives in the composer
  (games-audio's module, edited additively + announced); we only relay it.
  Probe `__mlNear.snapshot()`.
- **A FULL-SCREEN READER OVER THE WORLD PUTS THE LOOP TO SLEEP** — and waking
  it is NOT `TimeStep.resume()` (`gamefreeze.ts`, maintainer 2026-08-13: "the
  wiki lags a bit when opened on top of the game — can you freeze or pause the
  game rendering when the wiki is open?"). The wiki drawer is a second document
  painted on the same main thread, so `loop.sleep()` cancels the rAF outright
  for as long as it is up. Nothing that has to keep working is on that loop:
  the socket is event-driven, WebAudio schedules itself, the HUD is DOM. What
  DOES stop is input, which is the behaviour you want — the server integrates
  only what it receives, so a frozen client stands still instead of coasting.
  THE TRAP is the wake: `resume()` is the obvious partner and it arms Phaser's
  BACKGROUNDED-TAB recovery, `_coolDown = panicMax` (120), which clamps every
  delta to the 16.7ms target for the next 120 FRAMES. Measured: 16.7ms of game
  time per 167ms of real time, and a thawed player walked 20wu where an
  unfrozen one walked 151 — visible slow motion on anything under 60fps. Move
  `lastTime` to now instead and the first frame back is a ~0ms frame with no
  cooldown behind it. (Phaser arms the SAME cooldown from its own window-focus
  handler, so tapping inside the iframe and back out already does this with or
  without the freeze — verified against the unfrozen baseline. Do not
  re-diagnose that one as a freeze bug.)
- **To TIME a DOM animation on this harness, drop the WebGL context first.**
  The software GL renders the world at ~5fps (measured at every viewport and
  on the lightest worlds), and WAAPI clocks run on the document timeline — at
  that rate an animation's own `currentTime` can still read 0 after a whole
  interval of wall time, and every sampled film collapses. `verify-levelup`
  joins, waits for the real stats, then calls `WEBGL_lose_context.loseContext()`
  on the game canvas: Phaser stops rasterising, the thread comes free (~42fps,
  zero page errors) and the animation runs at something like device speed.
  Everything DOM keeps working — the socket, the synced state, the HUD. It
  BLANKS the canvas, so it is useless for a screenshot of anything over the
  world, and useless for anything Phaser draws.
- **THE LOGO'S TAGLINE IS TEXT NOW, NOT ART** (maintainer 2026-08-06). It was
  baked into `logo.webp`, which is generated — "each time Gemini regenerates
  the graphics the quality is reduced" — so the words could never change
  without redrawing the whole logo. The letters are painted out of the art and
  drawn over the empty banner from a pool in `select.ts` (`pixeltext.ts` is the
  font). Four things that cost a round each:
  - **MATCH BY MEASUREMENT, NOT BY EYE.** The baked line is a 5x7 font at 2
    art-px per cell; transcribing the glyphs off the art gave a byte-for-byte
    metric match (274x14 for the same sentence). Anything less exact shows,
    because the new words sit beside the art they are imitating.
  - **PIXEL-ART INK IS NEVER ONE COLOUR.** The maintainer's read was "a little
    whiter and not as gold … work on the bold and texture". It is SEVEN golds,
    one per cell row, plus a warm brown shoulder ring on the plate. A flat fill
    reads cheap and cold.
  - **A BLUR IS NOT A SOFT UPSCALE.** Imitating the art's shoulder with a
    bilinear blur covered MORE pixels than the art while carrying 20% LESS
    light — wide and washed out where the art is tight and bright. A hard 1px
    dilation under a crisp core matched it to 1.5%.
  - **THE PLATE'S LIMIT IS THE FLOURISHES, NOT THE BANNER.** The gold arms
    reach in over the cap rows and leave 293px clear, not the rule's 352 — the
    first limit passed a line whose S and full stop sat on top of the gold.
    A long line is now SCALED DOWN to the arms rather than rejected (the
    canvas is already downscaled ~3.5x on a phone, so a few percent costs
    nothing visible), and the word space is 2 cells rather than the art's 3 —
    one art pixel per gap, which buys 4-6 cells on every line.
  When ERASING baked text from art, inpaint by diffusion (blur, restore the
  known pixels, repeat) so any glow behind the letters survives, and keep the
  box off the ornaments: the first pass smeared a flourish into a brown blur.
- **Film DOM animations with a MutationObserver, not a sampler.** It fires per
  mutation BATCH, so every paint is one ordered snapshot however slow the page
  is, and reading `getComputedStyle` inside the callback flushes style — which
  resolves animations created in that same block to their offset-0 values, i.e.
  the impact frame, exactly. For "did these start together", read the browser's
  own `Animation.startTime` instead of any pixel: grab the objects when their
  effect appears and read them at the end (a finished animation keeps it).
