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
- the **games-ui-assistant** — the games-ui agent's first assistant
  (maintainer 2026-09-12, the shape the game agent's `games-assistant` set):
  this charter and remit, for the units the games-ui agent is occupied
  elsewhere for. It reads `coordination/games-ui.json` first, never touches a
  file named there as in flight, names every file it touches on
  `coordination/games-ui-assistant.json`, and rebases onto games-ui's pushes
  before every push.

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
  section of `games2/docs/lighting.md` before changing the art, the motion, or
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
  now holds ONLY what the runtime loads: `select-bg`, `gold-icon`, the seven
  tab icons and the four CORNER icons (`icon-wiki`, `icon-theme`,
  `icon-search`, `icon-install`), each an exact 2x bake of the untouched
  export kept beside it in `client/ui-src/icon-<name>-src.png`. The 4.7 MB of retired UI-kit bakes (frame/stone/plate/
  kit-*/select-frame/select2/select3 and all of `public/ui/`) was DELETED —
  the wiki-style remake stopped loading it in 2026-07-30 and it was pure
  deploy weight; the maintainer's SOURCE art is untouched in
  `client/ui-src/`, and git has the bakes.
  EXCEPTION, do not "fix": `public/icons/*.png` stay PNG. iOS ignores a WebP
  `apple-touch-icon` and manifest-icon WebP support isn't universal — a
  ~236 KB saving that would cost the install icon on iPhones, and nobody
  downloads them during play.
- UI build scripts: `scripts/build-ui-tiles.mjs`, `scripts/build-pwa-icons.py`,
  `scripts/bake-tab-icons.py`, `scripts/bake-corner-icons.py` (all emit
  `.webp` — convert at the SOURCE, never as a build step: a Dockerfile
  conversion would add minutes to every deploy and bust the layer cache).
- UI verify scripts: `scripts/verify-select.mjs`, `scripts/verify-chat.mjs`,
  `scripts/verify-mobile.mjs`, `scripts/verify-landscape.mjs`,
  `scripts/verify-dropqty.mjs` (backpack ×N badges + the drop dialog, both
  orientations; the SERVER's count clamp is unit-tested in
  `server/test/combat.review.test.ts` instead),
  `scripts/verify-levelup.mjs` (the XP bar's level-up),
  `scripts/verify-tagline.mjs` (the logo's tagline pool + the erased art),
  `scripts/verify-map.mjs` (the Map tab: the file it fetches, a ceiling on
  its size, that its minimap.json is not stale, and the dot against maps2's
  own worked samples),
  `scripts/verify-wikibtn.mjs` (the in-game Wiki button, the wiki's
  remembered reading spot, the game-loop freeze while it is open, the
  🔍 button + its `wiki:near` contract, and that the 🔍 icon really decoded).
  `scripts/verify-safearea.mjs` (the cutout: the insets driven over CDP,
  the chips, the select corners and the landscape pill stack stepping down by
  the top inset, the pages' scroll end by the bottom one, and the plain
  geometry back the moment the insets are 0).
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
- **THE STICK AND JUMP SIT WHERE HIS THUMBS ARE, AND HE MARKS THE SPOT**
  (`gamepad.ts` `STICK_FX` .771 / `PICK_FX` .454 / `JUMP_FX` .19 — fractions of
  the HUD page's width; left-handed mirrors each). Maintainer 2026-09-17, two
  red crosses on a device screenshot: "my new location feels more where my
  thumbs are when holding the phone" — both moved OUTWARD toward the edges he
  grips (jump 98.1 → 75.2 css, stick 276.6 → 294.6), the vertical unchanged.
  MEASURE INSIDE HIS OWN SCREENSHOT, never through a dpr (the law above, paid
  for once): the shipped controls and their labels are in the same image as the
  crosses, so the page width falls out of the two fractions already known
  (jump .25 and stick .705 at 98.1 and 276.6 css ⇒ 392.3 css), and every number
  is a ratio inside one picture. JUMP keeps his cross; the other two follow one
  RULE — **the row reads balanced when the two INNER GAPS are equal, not when
  the outer margins are** (maintainer 2026-09-17: "the controls is now not in
  balance and the MOVE controller should be somewhat placed more to the right").
  Measured at 393 css the margins were already even at 35.2/38.2, while the gaps
  were 40.1 (jump→pick) against 23.5 (pick→stick) — the stick looked shoved
  against PICK UP, and the margins were never the thing he saw. .771/.454 give
  35.8/36.1 at the <585w widths (79/57/120 css): the stick 8px right, PICK UP
  4px left. The stick cannot go much further right — it is the WIDEST control,
  its own margin (30.0) is the tightest number in the row, and one more nudge
  buys an edge-margin asymmetry with a gap one. Gated in `verify-gamepad` as
  FRACTIONS (±3 css px) **and as the rule** (gaps within 2.5px, no margin under
  26), plus one shared centre row and the left-handed mirror — nothing held any
  of this before, so an edit could drift his marks silently.
- **THE STICK IS NEVER OUT OF REACH: a GHOST floats over the game view whenever
  the gamepad page is not showing** — landscape on every tab (2026-08-05), and
  since 2026-09-17 PORTRAIT too (maintainer: "I want the same semi transparent
  control [in portrait]… we can't place it at a perfect thumb location, but it's
  better to have it at a worse location than not have this control at all").
  `gamepad.ts` `layout()`: `ghost = land || page hidden`; the ghost is the SAME
  element reparented to `<body>` (`position:fixed`, z 4, blur disc under it),
  and opening the gamepad page takes it back onto the page — one stick, never
  two. The root class `ml-stickghost` carries the ghost alphas (light .15/.25,
  dark .4/.5, 1/1 while held); it is NOT keyed on `ml-land` any more.
  PORTRAIT PLACEMENT: the game view's bottom-right CORNER on the one 10px
  margin (`PORT_GHOST_INSET`, anchored in CSS to `--hud-h` like the chat
  overlay). That corner is free because the same day he moved the Wiki row and
  the pill to the top (next law); a first cut parked the ghost ABOVE that
  stack, 118 css up the screen, and he wanted it lower ("let's start here and
  feel how it feels. If we need it even lower we will find more creative
  solutions"). Left-handed mirrors to the bottom-left — and since 2026-09-19
  the CHAT LOG MIRRORS AWAY FROM IT (next law), so the two never share a
  corner. "Just make sure pressing on the wiki or
  the search still works and this input triggers when you press on this and
  nothing else" is the z-order, not a special case: 4 sits under the chat
  overlay (5/6) and the Wiki/🔍/pill row (8), and only the well listens —
  `verify-gamepad` hit-tests the well, the Wiki, the 🔍, the pill's spot and a
  point beside/above the well (canvas), asserts the corner rule, the alphas at
  rest and held, the synthesized W from a northward drag (keys, not distance —
  the phone-dpr frame loop is starved in the harness), and that the gamepad
  page takes the stick back.
- **THE CHAT TAKES THE CORNER THE STICK DOES NOT — PORTRAIT ONLY**
  (maintainer 2026-09-19: "when the control is left handed on the screen in
  portrait mode it's hard to read the chat messages. Can we make the chat right
  aligned for this mode? … The chat is still left aligned for right-handed
  people and I'm only talking about portrait mode here"). In portrait the pill
  and the Wiki row live top-right, so the game view's two bottom corners belong
  to the ghost stick and the chat log ALONE — and never to both. Right-handed
  is untouched (stick bottom-right, log bottom-left, his default); left-handed
  the log hangs off the RIGHT on the same 10px margin and `align-items` flips
  so the bubbles hang off that edge. REJECTED: `text-align:right` — a wrapped
  line would be ragged down its LEFT edge, the edge you read from, and
  readability is the whole request. LANDSCAPE IS UNTOUCHED by his word,
  spelled `:not(.ml-land)` rather than left to luck.
  THE LANE NEEDS NO CHANGE: `--ml-chatw` is a MAX-WIDTH, so the gap it holds
  open always falls on the side the log is not anchored to — which is the
  stick's side in either hand.
  IT LIVES IN `hud.ts`, NOT `chat.ts` (the games agent's): `.ml-lh` and
  `--gv-*` are ours, this sheet already reaches `.ml-chatlog`/`.ml-chatinput`
  for the rotation snap, and every handedness mirror in the client is then in
  one place. No specificity race — theirs anchor on a bare class (0,1,0),
  these are (0,4,0)/(0,5,0); posted to games, who may take it into `chat.ts`.
  `verify-chat` asserts the RELATIONSHIP, not a side: the log and the stick
  are measured in both hands and required to be on opposite sides (asserting
  "right-handed ⇒ log left" alone passes on a build that moved the STICK), plus
  the mirrored margin, the input following its log, the bubbles' own edge, and
  that forcing `ml-land` drops the mirror.
- **THE PORTRAIT HUD IS EXACTLY THREE BACKPACK ROWS TALL** (maintainer
  2026-09-18: "aim for the backpack only having exact 3 row slots (not the
  ~3.66 we have today)… A player should feel 3 rows fit exactly and the space
  to the top and bottom is even. Lowering the UI this much will also lower the
  thumbstick and make it easier to play in portrait (that's the goal!)").
  `hud.ts portraitHudHeight`: `--hud-h` = 1px rule + tab row (rect) + page
  padding-top + `BAG_ROWS_SHOWN`(3) slots + 2 gaps + the same padding + the
  safe-area inset, never taller than the golden split it replaced (a squat
  window's three rows would climb past it; this only lowers the rail); the
  slot is derived from the
  width (the page has no rect behind another tab) and every other term is read
  from the live CSS, so the compact @media tier and any restyle move the rail
  with them — never copy those numbers into JS. The page padding is EVEN
  (10/10, compact 8/8, + safe inset). It replaced the golden 38.2% split in
  portrait only; landscape keeps its 38.2vw side column. Measured 393×851:
  325 → 311, rows at 628/702/777, 10.2px above and below. `verify-chat` and
  `verify-landscape` assert the law computed the same way from the live CSS.
  His verdict on the whole portrait layout — top-right stack, corner ghost,
  three-row rail — on seeing it (2026-09-18): "Wow! This is perfect!" Do not
  re-litigate any of the three without his word.
- **THE RED BUTTON FREEZES THE WORLD ON A LOSSLESS FRAME OF IT**
  (`freezeframe.ts`, maintainer 2026-09-18: "printscreen the entire page/game
  and freeze the game / only show the printscreen as a 'freezed frame' when you
  press the red button? … Not jpeg encoded. I want the freezed image
  lossless"). **Never pass a `type` to `renderer.snapshot`** — its default is
  `image/png`, PNG is the lossless one, and `image/jpeg` is one argument away
  from being the bug he ruled out; `verify-freezeframe` proves it on the PNG
  SIGNATURE in the captured bytes, not on the argument we think we passed.
  **CAPTURE, THEN FREEZE** — a snapshot is scheduled for after the current
  frame renders because `gl.readPixels` must run before the compositor takes
  the drawing buffer (no `preserveDrawingBuffer` on this canvas), so sleeping
  the loop first means no next frame and a callback that never fires. The
  failure mode is a perfectly transparent image of exactly the right size, so
  the gate decodes the picture and proves the world is IN it (lit samples,
  distinct colours) — dimensions alone would pass a blank read. The freeze is
  `gamefreeze.ts`'s sleep (the wiki drawer's), never a second mechanism. The
  picture covers the GAME CANVAS at z 3, `pointer-events:none`; the DOM HUD
  stays live because the button that ends the freeze is in it, and a rotation
  releases it rather than stretch a picture of the old shape over the new one.
  It LISTENS to `ml-record` and knows nothing about the button; a capture that
  cannot happen puts the button back rather than leave it lit over a world that
  never stopped (gated — the one failure that would lie to him).
- **THE RECORD BUTTON IS ADMIN-ONLY AND ANCHORED OFF THE CARD'S OWN VARS**
  (`recbtn.ts` + `admin.ts`, maintainer 2026-09-18: "I want this button under
  the HP/EP card. Also right aligned with the same distance/linespace to the
  screen and top… if you press the button it should change state to
  red/recording", then "I want only the logged in admin to see this button").
  It mounts HIDDEN and is revealed only when the SERVER answers yes
  (`/api/wiki/me` with the `wiki-admin-token`) — hidden first, shown on the
  answer, never the other way round, so it cannot flash for a player. The token
  is an HMAC only the server can check; `admin.ts` never reads its contents,
  caches for the page's lifetime like the dev-world picker, and drops the cache
  on a `storage` event. (`maps.ts`, the games agent's, has a private copy of the
  same check — offered this one 2026-09-18.)
  PLACEMENT: `left: --gv-left + 10`, `top: 10 + --ml-safe-top + --bars-l-h +
  10` — the card's own anchor plus its published height — and ONLY the width is
  measured (bars.ts publishes no width var). The row spans the card and the
  button sits at its START, so the two LEFT EDGES line up (2026-09-18: "I
  didn't want you to stretch the button just left align it"), and the gap under
  the card is the 10px the card keeps above itself. **His 48x48 plate is never
  scaled** — `verify-recbtn` asserts the size as well as the edge.
  REJECTED, do not re-attempt without his word: a FULL-WIDTH plate. "Also left
  aligned same as the card" was read as both edges flush and shipped 5-sliced
  (caps kept, two plain columns repeated, lamp centred) — undistorted, and
  still not what he meant.
  **Do not place it from the card's rect**: `.ml-bars` transitions `left` over
  .3s, and a placement sampled on the landscape flip took the new WIDTH with the
  old LEFT (851x393: button at 10, card heading for 335). Both faces live in the
  DOM and toggle by `visibility` — a `src` swap's first frame is blank. State
  rides a `ml-record` event for whatever is bound to it next.
  ART: his untouched 48x48 exports are the source of record in `ui-src/`,
  through `bake-corner-icons.py` (two entries) to an exact 2x in `/ui2`,
  rendered at naturalWidth/2. Which export was the LIT face was measured (88
  warm px peaking 188 vs 16 peaking 98), not taken from the file order.
  `verify-recbtn` gates BOTH directions of the admin check — a gate that only
  proved the reveal would pass on a build that showed it to everybody — and
  counts the lamp's pixels in the part of the plate OPAQUE IN BOTH FACES: the
  whole-button crop was reading the world through his transparent corners (64
  idle, 352 recording, 538 back at idle — a warmer scene, not a lit lamp).
- **THE UPDATE POPUP LISTS WHAT CHANGED, AND THE LIST IS THE WIKI'S**
  (`updatenote.ts`, maintainer 2026-09-18: "I want it to list everything that
  has changed from the version I'm currently at to the version I'm about to
  get. See wiki release notes for inspiration … make it look nice! Yes this
  dialog will be bigger but that's OK"). `wiki/lib/releases.mjs` already
  publishes the last 50 commits ENDING AT THE BUILD BEING SERVED
  (`wiki/release_notes.json`, `pixel-wiki-releases@1`, regenerated into the
  build context by the deploy — wiki/README.md), and `wiki/` ships in the game
  image, so the old client fetches that deploy's own list from
  `/assets/wiki/release_notes.json` and the range is a SLICE of it: head down
  to (not including) this build's sha, compared on the shorter prefix because
  git abbreviates. **Never re-derive a changelog here** — a wiki-side change to
  how a commit is attributed must show up in the game with no edit on this
  side. `cache: "no-store"`: the static mount sets maxAge 1h and a cached copy
  describes the deploy before last.
  THE WIKI'S ROWS MADE READABLE is the whole design difference: the wiki is
  deliberately raw (2026-09-13, ADMIN-ONLY), here they are grouped by day, the
  area is a chip (agent, else first dir), the chip's own token is stripped off
  the front of the subject when it repeats it, and adjacent identical subjects
  collapse to `×N`.
  **THE CHIPS WEAR THE THEME AND SAY HIS NAME FOR THE AGENT** (maintainer
  2026-09-19: "I don't like the pill colors (doesn't follow the CSS). Here is a
  list with how I named the agents"). REJECTED: a per-area hue derived from the
  name — it needed no palette, which is exactly why it followed none of ours;
  every chip is now `--surface-2` on `--border` with `--muted` ink, the sha
  chip's own recipe, so the dialog re-themes with everything else and no new
  colour is invented here. And the chip says what HE calls that agent in his
  own session list — `games-ui` is **UI**, `maps2` is **Map**, `characters2` is
  **Character**, `games-perf` is **Optimization**, `games-audio` is
  **Composer** (`AGENTS` in `updatenote.ts`; the summary groups by the LABEL,
  so two board files with one name count once). The `-assistant` and
  `-github-agent` suffixes are DERIVED off the stem, so the next domain's
  github agent reads as "Scenery GitHub" with no entry to add — only a new
  DOMAIN needs one. The raw id stays the grouping key inside `areaOf()`
  because the subject-prefix strip matches against it. NOTHING IS FILTERED — he asked for everything, so a `live:` admin
  commit is a row like any other. A build older than the 50-commit window says
  so ("the most recent ones") instead of implying the list is the whole range.
  THE TOAST IS UNCHANGED and still the quiet FYI of 2026-08-05 — deploys land
  many times an hour, so the dialog opens on TAP, never by itself; its wording
  stays maintainer-fixed ("New version out <hash>", 2026-07-17) and
  `verify-bootversion`'s regex with it. z 110, above the z-100 toast that opens
  it. `main.ts` is the games agent's file: the hook is the one allowed
  mechanical line (the click handler), announced on the board.
  `verify-updatenotes` routes a fixture document and asserts the range (nothing
  from before your build), the grouping, the collapse, the hit test over a
  z-100 layer, all three dismissals, the outside-window case, that a MISSING
  file still opens the dialog with a working reload, and that Update now
  actually reloads.
- **THE CUTOUT BAND IS ON EVERY SCREEN, AND THE APP NEVER REQUESTS FULLSCREEN**
  (maintainer 2026-09-18: "fake a black border so the game always looks the
  same! Even in character select this time!"). His shell letterboxes the
  camera cutout on a cold launch and goes edge-to-edge after a task-switch; the
  world paints that strip black (`#ml-safebar`, index.html, games agent,
  2026-09-13, z 9) and the select overlay (z 10) paints its own
  (`select.ts .ml-safeband`, inside the overlay's stacking context), so both
  launches look alike everywhere. Height = `env(safe-area-inset-top)`, so it is
  0 wherever there is no cutout. REJECTED, tried on his phone the same day:
  re-requesting fullscreen on the Enter World tap to make the shell re-lay out
  the cutout (the manifest already runs the installed app `display:
  fullscreen`) — Chrome answered with its "swipe from the top and press back
  to exit fullscreen" toast on every launch ("the text from chrome is too
  ugly") and the letterbox stayed. No web API asks for edge-to-edge; do not
  try again. `verify-select` drives a 55px inset through CDP and asserts the
  band and the corner buttons under it.
- **AMBIENT EFFECTS: A ZONE-BASED / FORCED / NONE SWITCH, NOT AN AUTO ROW** (maintainer
  2026-09-18, the ambient-zones plan: effects become tied to zones maps2
  places, decided by the server per zone; "the settings should instead of
  checkboxes have a switch for 'forced ambient effect' / 'zone based ambient
  effects'. If you select forced the zone based system is disabled and I will
  see the effect I have selected — a way for me to test a new ambient effect
  without running to the zone"). `hud.ts tickAmbient`: `.ml-amb-mode`, two
  `.ml-plate-btn`s "Zone based" | "Forced", driven through
  `__mlAmbient.auto(on)` — auto === zone based (the director today, "follow
  the server" when games-ambient lands the runtime; the seam is theirs, posted
  2026-09-18), manual === forced. FORCED preserves the scene showing at the
  flip (manual empties the set, so what ran is re-enabled), then each row
  toggles itself; a row tap while zone based flips to forced the same way.
  NONE (2026-09-18: "handy when we debug something else") is manual with
  nothing ticked — every effect off; the switch READS the truth (auto = zone;
  manual + a tick = forced; manual + no tick = none). PERSISTED in
  `ml-amb-mode` {mode, on} and restored when the rows build, because the
  controller keeps its mode in memory only (toggles.ts) and a debug NONE that
  came back as the director on reload was no debug aid. The effect rows are
  unchanged (`.ml-amb-row`; a dozen ambient gates find effects by them — never
  rename).
- **MAP TAB LAYERS: ONE "layers" BUTTON + A MULTI-SELECT DIALOG, grouped Map /
  Ambient zones** (maintainer 2026-09-18: "there will be so many pills so I
  think a multi-select dropdown or modal/dialog is better … just make the UX
  good!"). `maplayers.ts`: the button reads "layers · N" (N = offered layers
  on); the dialog (`.ml-layers`, the drop-quantity card's recipe, z 70) is
  rebuilt on every open from `offered()` — every layer whose `has()` is true —
  with all/none per group; a tick applies at once and the map behind redraws;
  backdrop, Escape and Done close. The AMBIENT-ZONE layers are DERIVED, one per
  effect, from maps2's `ambient_zones.json` (schema `pixel-maps2/ambient-
  zones@1`, proposed to maps2 2026-09-18: `zones[{id, effect, pct,
  rects:[[x0,y0,x1,y1]…]}]`, world cells, x1/y1 exclusive; effect ids = the
  ambient registry names) — parallelograms in a per-effect hue whose fill
  deepens with pct, no text over the map; file missing = no group. Probes:
  `__ml.mapLayers(id?, want?)` (the scene's wiring, unchanged) and the
  module's own `window.__mlMapLayers` { list, set, open, close } — what the
  dialog offers. `verify-map` opens the dialog, ticks zones, reads the count,
  closes with Done. maplayers.ts is the games agent's file for the zones and
  dungeons DATA; the chooser and the ambient layer are ours (claimed and
  posted 2026-09-18).
  **A LEGEND PILL PER LAYER THAT IS ON — and only those** (maintainer
  2026-09-19: "Once something has been selected here I still think we should
  have a pill for it so the user can see what color correspond to what layer …
  so we don't have to [show] every ambient effect as a pill for all users all
  the time"). The button is the CONTROL, the pills are the KEY: swatch + name,
  rebuilt from `offered()` beside the button, and each is its own off switch —
  the gesture the per-layer chips had before the chooser replaced them.
  EVERY LAYER CARRIES `mark()` — colour + shape — AND ITS `draw` READS THE SAME
  CONSTANT (`ZONE_LINE`, `PIN_FILL`, the effect's hue), so a pill can never
  name a colour the map does not paint; the swatch copies the SHAPE too
  (diamond for a pin, square for a wash), because shape is what survives a
  colour-blind eye. `verify-map` asserts each swatch against the colours the
  live overlay is actually painting, not against the constant.
  **NO TWO EFFECTS MAY SHARE A COLOUR.** The hue was the effect NAME's hash —
  stable, and it collides: measured 2026-09-19, rain 36° / snow 35° and
  fireflies 147° / falling leaves 141°, four different colours by `===` and two
  indistinguishable pairs on a phone. `hueTable()` slots the wheel instead (≥12
  slots, +12 per 6 effects; each effect takes the free slot nearest the one its
  name asks for), so a non-colliding world still gets the hash's own answer and
  the colours move only when maps2 adds or drops an effect. The gate measures
  the minimum pairwise hue GAP against that wheel, never inequality — an `===`
  test passes the bug — and runs on those two measured pairs.
  **SECTIONS ARE SETTINGS' SECTIONS** (maintainer 2026-09-19: "You can have
  sections in the dialog similar to the sections under settings"): the rule
  above the heading is the whole recipe (`.ml-amb-title` — border-top, 12px,
  uppercase muted), minus the rule on the first, where a line under the card's
  own edge is noise. Gated by COMPARING the computed style against
  `.ml-amb-title` itself, so restyling Settings carries this along or fails
  loudly.
  The "no explaining text in the map view" law (2026-09-14) is unchanged and
  still gated: what he struck out was the CAPTION narrating each live layer's
  marks. The row's whole text must equal its CONTROLS' text — button + pills,
  each one word — so a caption still fails.
- **PORTRAIT CORNER STACK IS TOP-RIGHT: the Wiki/🔍 row directly under the XP
  chip, the time-of-day pill one `--ml-stack-step` under the ROW** (maintainer
  2026-09-17, arrows on a screenshot: "wiki + search to be top right and listed
  right under the XP/level card… the time-of-day pill to also be top right but
  under the wiki. This means the thumbstick can be lowered"). `wikibtn.ts`,
  `wikinear.ts`, `clock.ts`: one `:root:not(.ml-land)` rule each, `top: safe-top
  + --bars-r-h + 20px (+ step for the pill); bottom:auto` — the landscape
  right-handed formula, so both top anchors agree. Three placements, one order
  each (wikibtn.ts header): portrait row-then-pill under the chip; RIGHT-handed
  landscape pill-then-row under the chip (his 2026-08-05/09-03 verdict on that
  screen, not re-litigated — flip it only on his word); LEFT-handed landscape
  keeps the bottom corner with the pill stepping up over the row. The keyboard
  lift (`hud.ts :root.ml-kb-up`) still writes `bottom` on all three, but a
  `bottom` on a top-anchored fixed box with a height is over-constrained and
  ignored, so in portrait the lift moves only the chat log — `verify-chatpage`
  asserts the row and the pill stay put; `verify-chat` asserts the row's right
  gap is the chat's left gap and the pill hangs one step under the row;
  `verify-landscape` asserts the portrait return. `chat.ts`'s `--ml-chatw` lane
  (games agent's) still reserves the old row's width on the log's line; harmless,
  posted to games.
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
- **THE MAP RENDER IS CROPPED, SO THE DOT COMES FROM `minimap.json`.** maps2
  d8a399b1a6 draws deep water as nothing and cuts the transparent border away,
  so the file is only the island — and a fraction of the FULL iso canvas,
  which is how the client placed the dot for a year, is then wrong by
  construction. The crop is not re-derivable client-side (it depends on where
  the land happens to reach), so maps2 publishes the arithmetic beside the
  image (`pixel-maps3/minimap@1`): `px = kx*(x-y) + x0`,
  `py = ky*(x+y) - kz*level + y0`, the centre of that cell's top face.
  `loadMinimapMeta` fetches it once per world and it OUTRANKS both projection
  replicas; a world without the doc still falls back to them, which stays
  right for an uncropped render. Validate every field before using it — a
  half-written doc must fall back, not put the dot at NaN%.
  ITS OWN WORKED SAMPLES ARE THE GATE'S GROUND TRUTH: maps2 lists real land
  cells with the pixel each lands on, asserted at build time against the
  file's own alpha. Re-evaluating their formula in the gate would only agree
  with the client about a shared misreading of it — including the one thing
  worth doubting, whether `col` means the same on both sides. And pin that the
  doc is not STALE (its `world` must be the grid the game loaded), or every
  sample is describing a different island.
- **THE MAP TAB FETCHES `minimap.webp`, AND THE DOT IS CHECKED AGAINST THE
  PICTURE.** Every tree publishes that name now (maps2 47e08659d1); `overview`
  survives only as an iso fallback, and it is the QA render's name — for
  the_game it WAS render3's 16300x7576 / 15.2 MB review render, fetched on a
  phone and scaled into a ~360px frame, which is what made verify-landscape
  report a 16300px map frame. Hence the size ceiling in `verify-map`: a
  map-tab image over 2400px wide is a review render, not a map.
  (`overview.webp` is deleted now, so it is not even a fallback — asking for
  it only 404s on the way to one.) The apex check this gate used to make —
  the four corner CELLS are the four apexes of an uncropped iso diamond —
  was right for exactly one day: it is the check that CAUGHT the crop
  landing, and the samples above replaced it because a cropped render has no
  such relationship to the grid.
- **NO EXPLAINING TEXT IN THE UI — NOT OVER THE MAP, NOT STACKED OVER THE
  GAME** (maintainer 2026-09-14, twice in one sitting: "I don't like the big
  wall of text that happens when I switch collision in settings on/off" and "I
  don't like the explaining text in the map view when toggling a pill/layer.
  Should be no explaining text at all"). Two rules came out of it.
  (a) The Map tab's layer row is CHIPS ONLY — the caption that named each live
  layer's marks is gone, with the per-layer `note` that fed it. What a colour
  means belongs in a comment or the wiki, not over the island he is reading.
  `verify-map` asserts the row's whole text equals its chip labels.
  (b) A SETTINGS TOGGLE IS A STATUS, NOT AN EVENT: `chat.ts` keys every SYSTEM
  line by whatever it says before its first colon ("Collision overlay", "Zone
  borders", "fog") and a new line REPLACES the live one with that key instead
  of stacking. Six taps leave one line saying what it is now. No call site
  changed — 25 `addLog` sites in the scene get it for free — and a line with no
  short prefix ("Reconnected.", "Bex reached level 7!") still stacks like the
  event it is. Player chat is never keyed: two people saying the same thing are
  two messages. The Chat PAGE keeps every line; it is a scrollback. The
  collision LEGEND, which has no key and cannot collapse, prints once a
  session. Gated in `verify-chat` (six taps → exactly 1 state line, ≤1 legend).
- **A MAP LAYER READS THE PUBLISHER'S OWN NAMES, NEVER ITS OWN DERIVATION.**
  The `dungeons` chip pins maps2's `places.json` (`pixel-maps2/places@2`) —
  `kind: "cave"`, the display `name`, and the published `entrance` if there is
  one else `anchor` (the spec's own map-pin cell; for a cave the centroid is
  inside the mountain and the useful cell is the mouth). A dungeon appears the
  day maps2 ships it and nothing here moves when the terrain does. Houses and
  summits ride in the same file and are one `LAYERS` entry each.
  A CHIP IS OFFERED ONLY WHEN SOMETHING IS BEHIND IT (`Layer.has`) — a world
  with no caves shows no dungeons button.
  A PIN IS A DIAMOND IN HTML: the overlay `<svg>` is stretched to the image box
  (`preserveAspectRatio="none"`), so a circle drawn in it comes out an ellipse,
  and SHAPE is what separates a place from the round accent "you are here" dot
  at 2 inches wide and to a colour-blind eye. NO NAME IS EVER DRAWN — the icon
  is the whole mark (maintainer 2026-09-12: "when I want to see dungeons on the
  minimap I don't want any text over the dungeons … just icon is enough"). The
  first version placed a name under each pin and dropped the ones that
  collided; with nine caves in one massif that both half-failed and covered the
  island he was reading. The name rides the element as `data-pin`, which is
  what the gate finds a pin by and what a future tap-a-pin would open.
  A PIN IS PROJECTED AT ITS CELL'S OWN LEVEL, never the ground plane. maps2's
  formula lifts a cell by `kz*level` (1.05px per storey on this render), so a
  cave mouth 30 storeys up the massif drawn at level 0 lands 32px low on a
  478px image — 6.6% of the frame, out on the snowfield below the hole he
  walks into (maintainer 2026-09-12: "you should of course mark the entrance
  and not the center"). `minimapCellPct`'s `level` defaults to 0 because a
  FLAT overlay (the zone grid) wants the ground plane; anything that marks a
  place you STAND on passes `__ml.levelAt((col+0.5)*32, (row+0.5)*32)`.
  Gated in `verify-map` against maps2's own worked sample: the fixture's cave
  entrance IS sample 0's cell, so a pin agreeing with the published pixel
  cannot be agreeing with a shared misreading of the projection. The fixture
  rides on top of whatever the world really publishes.
  …AND AGAINST THE DOT, because every published sample is a level-0 land
  corner and therefore cannot tell a level-aware projection from one that
  passes 0 — which is how the level bug shipped past a green gate. The check
  stands the player ON the highest published cave mouth and requires the pin
  to be under them; the dot is itself gated against the samples, so this tests
  the level through a different mechanism. Pins carry `data-cell` for it,
  because a pin has no rendered text to be found by — and the same check
  asserts that: any ink on the island fails it.
- **SLIDER ROWS LEAVE A SCROLL GUTTER; BUTTONS DO NOT** (`--ml-slider-gutter`,
  100px, maintainer 2026-09-08 with the strip circled on a screenshot: "when
  scrolling in settings it's hard to not by mistake edit a slider … this is
  because the sliders spawn 100% width"). A track takes its value on
  POINTERDOWN — a tap anywhere on it jumps there, which is deliberate — so the
  first touch of a scroll that lands on a track has already changed the
  setting before it moved a pixel. The gutter is a strip his thumb can always
  start a drag in. NOT `touch-action:pan-y` on the track: the browser only
  rules a gesture a vertical pan after some movement, by which time pointerdown
  has applied the value, so the setting would change AND the page scroll away
  from it. BUTTONS KEEP THE FULL WIDTH on his instruction — dragging one does
  nothing, so there is nothing to protect — and the gate asserts BOTH
  directions, or "fix" it by narrowing the whole page and it still passes.
  THE GUTTER IS ON THE TRACK, NOT THE ROW, and that was learned the second
  time: insetting the whole row right-aligns the readout with the track and
  reads more deliberately, but it narrows the LABEL LINE too, and at 100px
  "Light resolution · 50% · 25% of the pixels" wrapped onto two centred lines.
  Only the track is draggable, so only the track moves.
  THE WIDTH IS HIS THUMB, MEASURED BY HIM — 80px was the strip he circled and
  he came back with "my thumb is just a little bit bigger", so it is 100px
  (118px clear of the screen edge at his 393px width). FIXED PX on purpose: a
  thumb is the same size on every screen, so this must never become a
  fraction of the viewport. The gate's floor is that number rather than the
  44px generic touch target, so shrinking it back toward a guideline fails.
  THE GUTTER IS ALSO THE "default" BUTTON'S LANE (`.ml-slider-def`, maintainer
  2026-09-10: "I want it to the right of the slider. We already have extra room
  there because the slider doesn't take up 100%"). The two uses do not fight: a
  button is not draggable — a touch that moves becomes a scroll and never fires
  a click — so the strip still starts scrolls and the track keeps its width. The
  button's flex-basis IS `--ml-slider-gutter` minus the row gap, so widening the
  gutter widens the button and the two numbers can never drift apart.
- **EVERY DIAL CARRIES A "default", AND DISABLED MEANS "already there"** (his
  words). `pctSlider`/`rangeSlider` take the default as a REQUIRED argument, in
  the same 0..1 axis as `get`/`set`, so a log or stepped dial converts it the
  way it converts everything else — and a new dial cannot forget to name one.
  The button asks the STORED value, never the drag's raw position: a drag that
  lands on the default must go dead, and a pointer fraction never equals a
  stored number exactly. These dials exist so he can find a number by eye, so
  the way back from a hand he did not like is part of the widget, not a nicety.
- **EVERY SLIDER SITS IN ONE BLOCK** (`.ml-dials`, maintainer 2026-09-10: "we
  have two settings sliders at the bottom of the page and the rest in the
  middle. Put all in the middle."). The two strays were the bird-density dial,
  which the ambient checklist built into ITSELF, and the games agent's Uphill
  bias, injected onto the end of the column from `navbias.ts`. A slider dropped
  anywhere else in `.ml-set` is MOVED into the group by an observer rather than
  asked to know about it: outside injectors find the page by class and re-inject
  after every HudBar rebuild, so the rule only stays true if it lives on the
  receiving side. Moving a node out of `.ml-set` fires only records the observer
  ignores, so it cannot loop.
  ADOPTION ALSO DRESSES IT (`adoptDial`): the track and the reset button are put
  into a `.ml-slider-row` and the button gains `.ml-slider-def`, reading none of
  the injector's own classes. PAID FOR — `navbias.ts` kept a private copy of the
  row CSS and a rewrite left the copy but dropped the call that injected it, so
  both Uphill dials shipped with the button on its own centred line above the
  track (maintainer 2026-09-11: "two default buttons look missplaced"). The gate
  now measures that a button's centre falls INSIDE its track's box, because that
  layout passes every class check.
- **THE LIGHT GROUND IS BEIGE, NOT WHITE** (maintainer 2026-09-12: "the light
  css is a bit too light/white … make it a little more beige … I just don't
  want this super white"). `theme.ts` light tokens: ground `#f6f0e6`, card
  `#fdf9f3`, pressed `#eee6da`, border `#e1dacd` — one CIELAB hue (86°, warm
  paper; 78° reads salmon beside the coral accent, 92° goes dusty olive), an
  even L* ramp 98.2 / 95.0 / 91.7 / 87.2 / 79.7, chroma rising as it darkens.
  HIS PICK from six rendered candidates was the SOFTER one (chroma × 0.72, a
  step lighter than the fuller paper beige) — "a little bit more beige than
  white", not a parchment (maintainer decision). `--good` / `--accent-ink` are
  a hair darker than the wiki's purely to hold ≥ 4.5:1 on the new ground.
  Pinned in `verify-hudtabs` (`palette()`): ground max channel ≤ 248 and R−B
  ≥ 12 (the old `#faf9f5` is 250 / 5), a card lighter than the ground, ink ≥
  12:1 and muted ≥ 4.5:1 — reverting to the wiki's white fails it. The DARK
  blocks are the wiki's verbatim and untouched. The wiki has the light values
  on its board to adopt; `wiki/` is never edited from here.
- **A DRAG ONTO ANOTHER ITEM SWAPS THEM, AND THE SWAP IS PREVIEWED LIVE**
  (maintainer 2026-09-17: "drag an item to a different item's slot so they
  change place. When I drag around the item I should see that item moving to
  the item I drag's location so I understand what will happen if I drop the
  item here … the item at that spot will animate towards the item I'm
  dragging's location, and the old item that was animated to this slot will
  animate back"). While a lifted item's ghost is over a FILLED cell, that
  cell's art is translated onto the lifted item's empty cell (`.displaced`,
  180ms transition on `img`/`b`, the cell raised above its neighbours); moving
  on clears the translation and the transition carries it home. The transform
  is on the ART, never the cell — the grid must not reflow under a finger that
  is still deciding. On release over that cell the HUD swaps its own grid AT
  ONCE (the selection follows the lifted item) and calls `onMoveItem(from, to,
  item)`; the game sends `invmove` and the server's echo is the authority — a
  refused swap heals the grid back. EMPTY CELLS ARE NOT TARGETS: the server
  list is compacted, there is nothing there to trade with, so a release on one
  is a cancel (the displaced art glides home, nothing is sent). The game view
  stays the drop exit (the quantity dialog). Gate: `scripts/verify-bagswap.mjs`
  — measured art centres for the preview both ways, the immediate swap plus the
  exact `invmove` (`__ml.invMoves`), the empty-cell cancel, and the dialog exit.
- **THE BACKPACK IS SELECT, THEN DRAG — AND AN UNSELECTED SLOT IS THE
  SCROLLER'S** (maintainer 2026-09-14: "it's hard to scroll in the backpack
  because I always drag an item by mistake … in order to drag an item to the
  game you must first select the item (so the slot is highlighted)"). A filled
  slot has TWO states and the difference is what the browser may do with the
  touch: unselected, nothing is captured or preventDefault()ed and there is no
  `touch-action`, so the finger scrolls; selected, it wears `touch-action:none`
  and the pointer-captured drag. One slot at a time, so 1 cell of 15 is sticky
  and the rest scroll. A tap toggles the selection; a real drag swallows the
  click that follows it, so an aborted drag keeps the selection.
  SELECTING IS ALSO A HOLD (maintainer 2026-09-17: "hold down until you see it
  has been selected and then you can drag … 0.25s", then halved the same
  sitting once he felt it: "0.25s is too much. Lower it to 0.125 (half)"):
  still for 125ms on an unselected slot → it selects itself (the accent outline
  is the signal) → the SAME finger drags. The scroller is not robbed: the hold timer dies on the
  first move past 8px or on the `pointercancel` the browser sends when it takes
  the touch for a scroll, so a moving finger scrolls exactly as before. A finger
  still for 125ms has begun no scroll, and from that instant every `touchmove`
  is preventDefault()ed by a NON-PASSIVE listener registered at touchstart — a
  scroll the browser has not begun can still be refused, whereas
  `touch-action` is read once at touchstart and changing it mid-gesture does
  nothing (the trap). NOTHING IS CAPTURED DURING THE HOLD (capture is what
  would rob the scroller), so a pointer that leaves the cell or lifts may never
  send it another event — the hold also ends on `pointerleave`, and up/cancel
  are watched on the WINDOW; a timer that outlived its pointer selected a slot
  the finger had left and started a drag on a pointer that was gone (paid for:
  verify-dropqty's press-and-slide caught it). The click after a hold is
  swallowed (`dragged`), or it would toggle the fresh selection off.
  `contextmenu` is prevented and the cell wears `user-select:none;
  -webkit-touch-callout:none`, so a long press opens no platform menu.
  GATE TIMING TRAP: one driver round-trip (a `page.mouse` step, a CDP touch
  send) costs ~750ms of wall time on the headless harness (measured), so a
  driver-paced "press then slide" holds still past the hold and LIFTS — the hold
  doing its job, not a scroll being stolen. The scroll arms therefore dispatch
  the press and its first move IN THE PAGE (synthetic PointerEvents, 40ms
  apart); only the still-hold arm uses real CDP touch, because holding still
  needs no fast events. `verify-bagswap`: 60ms in nothing is selected, 260ms in
  slot 0 is (half the hold either side — a read ON the boundary is a flake, not
  a check), the same touch drags and swaps, and nothing later can be read
  off a faked bag (the swap's echo of the REAL inventory replaces it — the
  authority, not a regression); a move past 8px inside the hold, or leaving the
  cell, selects and lifts nothing.
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
  ALL FOUR CORNER ICONS COME OUT OF ONE SCRIPT NOW
  (`scripts/bake-corner-icons.py`, 2026-09-13): the first three were baked by
  hand, so their transforms lived only in a commit message and nothing could
  be reproduced. It re-bakes the shipped three and compares them BYTE FOR BYTE
  — a disagreement fails the run instead of overwriting his art — and asserts
  each transform as above. The Install chip's ⤓ TEXT GLYPH went the way of the
  emoji the same day: his gold download arrow (PixelLab prompt "Download"),
  baked untransformed because its 18x21 ink already sits as centred as an odd
  remainder allows, and the artist's placement inside the canvas is part of
  the design. THE THREE CORNER CHIPS ARE ONE SET, sized by ONE rule
  (maintainer 2026-09-13, on the arrow landing in the old smaller chip: "The
  button should look similar to Wiki and theme same size and margin") — 118x46,
  the authored 24px icon box, 12px from each one's OWN edge, Install on Wiki's
  top line. The "utility chip reads a step smaller" reading is retired.
  `verify-select` asserts the SET — box, margin, line and the icon's inset
  inside its chip — never one chip on its own, which is the same rule that
  keeps the pair matched.
  AND THE GATE WAITS FOR THE DECODE: `naturalWidth` is 0 for a 404 AND for a
  file that has not arrived yet (on a cold dev server the corner art lands
  ~300 ms after the button exists, the hidden Install chip's later still), so
  verify-select waits for every `.ml-cicon-img` to decode before measuring.
  A missing file never decodes, so the wait times out and the gate still fails
  with the same meaning — it stops passing or failing on the harness's luck.
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
- **THE CHROME CLEARS THE CUTOUT THROUGH ONE TOKEN** (`--ml-safe-top` /
  `--ml-safe-bottom`, declared once in `theme.ts` as `env(safe-area-inset-*)`,
  0 wherever the browser letterboxes the cutout or there is none; the games
  agent's 2026-08-05 heads-up when Chrome began drawing installed apps INTO the
  punch hole). Anything hugging the TOP edge adds the token to its offset — the
  stat chips, the select corners, the update toast, and the landscape pill
  stack, which hangs off the chip's MEASURED height and so needs the inset
  itself. Pages pad their scroll end by the bottom one (the gesture bar). NEVER
  a literal `env()` in a consumer: one declaration is what lets the gate drive
  every surface at once. `env()` is CSS-only, so this is the ONE layout var
  `applyLayout()` cannot publish in px; a JS consumer reads the element's rect.
  AND THE BAND ITSELF IS PAINTED (`#ml-safebar`, `client/index.html`: one
  fixed strip, `height: env(safe-area-inset-top)`, the letterbox's own `#000`,
  `pointer-events:none`, z 9). THE TRIGGER IS A TAB-OUT AND BACK (his words,
  after "the card is not at the top … I then restarted the game and that fixed
  the issue"): his shell letterboxes the cutout, and on a resume from the task
  switcher it hands the app the whole screen instead, so the state flips
  MID-SESSION and a restart "fixes" it by landing back in the letterboxed one.
  MEASURED on his shots of the
  same build: the card does not move — its HP bar is 198 vs 196 device px from
  the top of the glass — because the chips already clear the cutout. All that
  differs is what fills the 152 device px (55.3 css px) above it: black
  letterbox, or live world. World there reads as a floating card, so the band
  wears the same black either way and the two launches are pixel-alike. It is
  PAINT, NOT LAYOUT — nothing is inset, the canvas is not re-fitted, the golden
  split is untouched — which is why it costs no gate. REJECTED: chips flush to
  the glass at 10px, the pre-inset layout; that is exactly what the inset
  exists to prevent, and a top-corner camera hole then sits on the HP numbers.
  Gated in `verify-safearea` through CDP's inset override — the only way to
  see a cutout on this harness — before AND after, so "inert at 0" is measured,
  not assumed. NOT DONE YET: the landscape cutout is a LEFT/RIGHT inset (the
  menu column and the floating stick) and the stick's well already touches the
  page bottom where the gesture bar lands — both wait for his device to
  confirm edge-to-edge, since a phantom inset there would move controls he
  has placed by hand.
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
