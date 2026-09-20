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
- `client/src/clock.ts` — the day/night clock: the "Fern starfall" PILL, an
  art-pixel landscape painted into a canvas and shown at x2, HANGING ONE
  `--ml-stack-step` UNDER THE WIKI BUTTON AND AS WIDE AS IT (maintainer
  2026-09-20: "once again place the time-of-day pill under the wiki button
  and make it the same size as the wiki button (same width as only the wiki
  button, not wiki + search). It doesn't look good when it's at the top").
  That superseded 2026-09-19's top-centre placement and its
  third-of-the-card's-extra-width rule; neither comes back without his word.
  `fitPill()` is the whole rule: it MEASURES the Wiki button's box (another
  element — the rule against reading a rect is about the pill's OWN, which
  fitPill is about to resize), floors its content width to a WHOLE art pixel
  and draws that many columns; the box is then exactly `aw * SCALE` css px,
  so one art pixel is always exactly 2 css px (floored, so an odd button
  leaves the pill 1px narrower on the shared right edge, never half an art
  pixel wider). The height is `AH * SCALE` = 32 = the button's content
  height (wikibtn.ts `PILL_H`) by construction. The placement is CSS:
  `right` the button's own anchor (`--gv-right` + 10px), `top` the row's
  anchor plus the published step, one rule for both orientations and both
  hands — the row moves the pill and never the other way round (wikibtn.ts
  reads nothing of it). Top-anchored, so the keyboard lift has nothing of it
  to lift; `:root.ml-noanim` freezes its `right`/`top` transitions through a
  rotation like the row's.
  **NOTHING IS EVER STRETCHED TO GET THERE** ("I think stretching the
  graphics will kinda destroy the sun and moon"): a wider pill is MORE SKY
  AND MORE HILL — the orbs keep `R` 3.4 and their glow, the hills keep their
  wavelength (`sin(x*f+o)` gives more of them, not longer ones), and
  `spotsFor()` keeps his six hand-placed stars at their exact coordinates
  and scatters the extra ones beyond x=40 at the same measured density (5.9
  per 40 columns against the mock's 6), hashed off the column so they never
  twinkle or crawl. An earlier cut divided the pill's own bounding rect, got
  one art column too many from the 1px border and rendered at 1.973x — the
  exact smear this exists to prevent, caught by the gate.
  `verify-wikibtn`'s `assertPill` asserts all of it in every placement —
  the button's width (at most 1px narrower), its height, its right edge, one
  step under its top, an exact 2x on both axes, and the pill's rect
  intersecting no other chrome; section 8b runs at his own 495x1111 so the
  rule is read at his width as well as the common one. The sun
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
  the chips, the select corners and the landscape top chrome stepping down by
  the top inset, the pages' scroll end by the bottom one, and the plain
  geometry back the moment the insets are 0),
  `scripts/verify-subtabs.mjs` (the Settings sub-tabs: the rail growing by
  exactly the strip while the page and the canvas keep their geometry, the
  lock-step slide by declaration with the ghost stick riding it, the four
  pages and their live controls, the admin-only Dev, the landscape
  icons-only strip),
  `scripts/verify-hudtabs.mjs` (the tab row and its 1x icons at three
  widths, the light palette's beige floor, and the backpack grid: exactly
  `INV_MAX_SLOTS` square cells — an empty cell is a free slot, a full pack
  shows none — empty / one-item / full packs driven through `__mlHud.inv`,
  the real pack put back),
  `scripts/verify-chatpage.mjs` (the Chat page: the history's rows, cap,
  dividers and scroll hold, an arriving line APPENDED rather than rebuilt,
  and the keyboard lift — the box 20px above the keys, the log and the ghost
  stick on the line above it with their .15s glides both ways, the game, the
  HUD and the top-right stack unmoved).
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
- **THE STICK IS A GHOST OVER THE GAME VIEW, ALWAYS** — landscape on every tab
  (2026-08-05), portrait whenever its page was hidden (2026-09-17: "I want the
  same semi transparent control [in portrait]… it's better to have it at a
  worse location than not have this control at all"), and since 2026-09-19 on
  the gamepad tab too ("ONLY show the player analog thumbstick over the game
  screen and not in the gamepad menu. We do this in landscape mode already …
  also be visible on top of game view when the player select the gamepad").
  `gamepad.ts` `layout()`: the ghost is ONE element parented to `<body>`
  (`position:fixed`, z 4, blur disc under it) in both branches. AND SINCE
  2026-09-20 THE PAGE HAS ITS OWN STICK AGAIN IN PORTRAIT (maintainer: "I
  know we removed the analog thumbstick from this page. I want it back on
  the same location as before. And when the user change the analog
  thumbstick location (in settings) that only applies to the analog
  thumbstick that is drawn on top of the game"): `.ml-pad-pagestick`, the
  same two parts, OPAQUE, at his mark (`STICK_FX` .771 on the buttons'
  midline, the WALK label over it, mirrored for the left hand), hidden in
  landscape where the page stacks the two buttons. TWO STICKS, ONE INPUT
  PATH: `attach()` wires each with its own drag and cap, the keys they
  synthesize are one set, and ONLY THE GHOST takes the fine-tune. Every
  gate's `.ml-pad-stick` is the ghost, and the ghost alphas are scoped to
  it. The root class `ml-stickghost` is always on and carries those alphas
  (light .15/.25, dark .4/.5, 1/1 while held).
  **AND THE GHOST DISAPPEARS WHILE THE PAGE STICK DRIVES** (maintainer
  2026-09-20: "the analog thumbstick at the screen should fade invisible
  while I am holding/using the thumbstick in the menu … it would just be
  cooler if it fades to fully transparent"): the page stick's drag puts
  `ml-pad-usingpage` on `:root` and the ghost's two parts go `opacity:0` on
  their own .25s transition. TWO CLASSES ON `:root` = specificity 5, the
  dark rest rules' equal, so the rule sits AFTER them to win the tie — and
  BEFORE `.held`, so two thumbs on both sticks leave the one being touched
  visible. Cleared on release, on blur, on visibilitychange and in the
  landscape branch, where no page stick exists to release it. `verify-gamepad` pins the
  three-control row (fractions ±3 css px, even inner gaps, margins ≥ 26,
  one centre row, the left-handed mirror), the page stick opaque inside
  the page beside one ghost, and the page stick unmoved by a nudge.
  PORTRAIT PLACEMENT: the game view's bottom-right CORNER on the one 10px
  margin (`PORT_GHOST_INSET`, anchored in CSS to `--hud-h` like the chat
  overlay, so it rides the rail and the open sub-tab strip — and GLIDES with
  it: under `:root.ml-subanim` the stick and its blur disc transition
  `bottom` on the rail's own `.25s ease`, since `.ml-pad-stick` is otherwise
  `transition:none` and the strip's height landed in one frame while the
  rail slid; maintainer 2026-09-20: "the thumbstick doesn't animate up like
  the chat messages does. It directly snaps into a new position").
  THE FINE-TUNE (maintainer 2026-09-19: "a new control to be able to
  fine-tune the analog stick location … ± half radius in player control …
  margin 0 is the min so the stick can never be rendered outside of
  screen/div"): `controls.ts stickNudge` — x/y in css px, screen space (+x
  right, +y up), persisted, event `ml-stick`. A DIAL'S RANGE IS THE EFFECTIVE
  RANGE (his, at "14 px right" with nothing happening: "Why is not the
  max/min values that actually have effect not also the slider limit?"):
  `stickNudgeRange()` is per axis the half radius (`well/4`: 30 on the phone,
  37 at the big well) AWAY from the stick's corner and only the inset (10
  portrait, 38 landscape) TOWARD it, following the hand (which side the
  corner is) and the orientation — `layout()` clamps to those numbers and
  floors the margin at 0 under them, and the Controls dials ("Stick left /
  right", "Stick up / down") are built on them, default off-centre, rebuilt
  when the range changes (`ml-hand`, `ml-layout`), so every end of a dial is
  a position that moves the stick; one pair of stored numbers for both
  orientations. The dials drive it live (the stick is a ghost over the view
  while Settings is open), and the Hand choice is LEFT-HANDED ON THE LEFT,
  right on the right (his order). Gates: `verify-gamepad` (the corner with the page open, the nudge
  and both floors, the stored-value clamp), `verify-subtabs` (the dials' round
  trip), `verify-landscape` (the floating stick through rotations). That corner is free because the same day he moved the Wiki row and
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
  people and I'm only talking about portrait mode here"). In portrait the Wiki
  row and the pill live top-right, so the two bottom corners belong
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
- **THE LANDSCAPE MENU COLUMN IS AS WIDE AS WHAT IS IN IT** (maintainer
  2026-09-19: "when holding the phone in landscape the menu area has not been
  made smaller the way we did for portrait mode"). `landscapeMenuWidth()` is
  `portraitHudHeight()` turned on its side: 1px border + the vertical tab strip
  + the page's own padding + the backpack grid's own computed max-width,
  `Math.min` with the golden 38.2vw, which stays the CEILING — a column wider
  than the split would be a regression. It READS the grid's computed max-width
  rather than restating that height-derived formula, because two copies of it
  drift the first time either is tuned.
  **AND THE MARGIN BESIDE THE BAG IS THE BAG'S OWN GUTTER** — which is the
  whole ask, and all of it (maintainer 2026-09-19, both margins drawn in red on
  a screenshot: "the space here is more than between backpack slots. I want
  menu to be smaller so this area can be the same as the spacing between slots.
  THAT WAS ALL I WANTED"). The short-viewport rule gave every page 14px sides
  while the grid's gaps are 8, so the bag sat in a frame wider than its own
  gutters; `:root.ml-land .ml-page` makes the sides 8px, and because
  `landscapeMenuWidth()` READS the padding the column hands back exactly the
  12px the page stopped holding. Measured at 851×393: menu 325 → 314, sides
  8px = slot gap 8px, three columns kept, slot 65 → 66. Gated as the
  RELATIONSHIP (side gap === column gap), never a number, plus `< golden` so a
  change that wins nothing fails loudly. PORTRAIT IS NOT TOUCHED: 16px sides
  against a 10px gap is his, unremarked on the screen he uses most.
  **REJECTED, 2026-09-19, and do not re-attempt: TWO COLUMNS.** Asked for a
  smaller menu I dropped the backpack to 2 columns and took the menu to 251 —
  it also widened the game view by 74px, which visibly re-zoomed his world.
  His verdict: "You fucked up the landscape mode! … I asked for making the menu
  just a bit smaller so the spacing in the backpack looks better." THE LESSON
  IS THE MEASUREMENT: the thing that looked wrong was never the column's width
  in the abstract, it was ONE 6px difference between a margin and a gutter.
  Measure what he circles before redesigning what he did not.
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
- **THE BACKPACK DRAWS EVERY SLOT THE SERVER ALLOWS, AND NOT ONE MORE**
  (maintainer 2026-09-20, at a full pack scrolled to its last row with five
  empty cells under it and "Your backpack is full." on the log: "I can still
  see free slots in the backpack. It would be better if I can actually see I
  have no more free slots … a player should be able to see all slots in the
  backpack even if I only have let's say one item. This give the player a
  feeling for how many slots he/she has left"). `hud.ts renderInventory`
  lays out exactly `INV_MAX_SLOTS` cells (`@nangijala/shared`, 30 — the
  server's own cap, so the two cannot drift), filled entries first, then
  empties: an empty cell MEANS a free slot, so a full pack shows none and a
  one-item pack shows the other 29. (The first grid padded to at least 15
  cells and always one empty row past the last item, so 30/30 read as
  30/35 — the "free slots" he saw.) Six rows of five in portrait, ten of
  three in landscape; the page scrolls and the three-row rail is unchanged
  (`portraitHudHeight` reads the CSS, never the cell count). The "full"
  line answering every retried pickup is the games agent's (WorldRoom
  `pickup`, WorldScene's 400 ms intent retry, chat.ts) — requested, never
  patched from here. Gate: `verify-hudtabs` (the exact count at three
  widths; empty / one / full packs through the `__mlHud.inv` probe in one
  synchronous evaluate, the real pack put back).
- **THE KEYBOARD MOVES THE CHAT BOX, THE LOG AND THE STICK, AND NOTHING
  ELSE — AND IT NEVER RE-LAYS OUT THE GAME** (maintainer 2026-09-20, two
  Chat-tab screenshots: "open and close the keyboard the game lags … the
  right thumbstick is also not moved up to make room for the input the way
  the chat-messages do … the input box is a little bit to close to my
  keyboard … when I close the keyboard the game lags like crazy").
  `hud.ts mountChatKeyboardLift` floats the focused box `KB_GAP` (20px) above
  the keys — 10 read as ~2 on his phone, the reported keyboard top sitting
  under the keys' visible edge — and publishes `--ml-inputlift`; the chat log
  (hud.ts) and the ghost stick (gamepad.ts: portrait `bottom` is
  `--ml-pad-bottom` with the rail anchor as its fallback, the var
  `--ml-inputlift + 56px` under `.ml-kb-up` — it REPLACES the anchor, never
  max()-es with it, because on a browser that resizes the page for its keys
  the rail is below the viewport) take the line above it on the same .15s
  ease-out, the stick's glide DOWN carried by the `.ml-kb-drop` window
  `drop()` holds for 220 ms (outside the two windows the stick snaps, which
  rotation needs). THE LIFT'S OWN WORK IS FLOORED: `--ml-kb` is an inherited
  custom property on `:root`, so each write recalculates the whole document
  (measured in the harness: 1.2 ms with the Chat page hidden, 7 ms with its
  1000-line history shown — several times that on a phone) — never the same
  value twice, the tracking writes coalesced to one per frame, the rail floor
  read from `hudHpx` (applyLayout's px) instead of a computed-style read per
  poll. THE KEYBOARD NEVER LAYS OUT (his four screenshots: a black game view
  when the keys closed "as if the game render engine restarts"; his browser
  resizes the page around its keys — the window shrinks under them on open
  and grows back on close): a resize that keeps the width is not laid out
  while a box is lifted nor for `KB_SETTLE_MS` (700) after the drop
  (`kbHolding`); at the settle window's end the drop lays out once and only
  if the viewport is not the one last laid out (`layoutW`/`layoutH`), which a
  keyboard's close never leaves — an earlier cut laid out AT the drop, on the
  still-shrunk page, and that was the black frame itself. So `--hud-h-inv`
  stays and `#game` never changes size (a canvas resize is the one ~2 s stall
  this codebase knows). The lift measures the keys from where `bottom:0`
  LANDS (the probe's rect against the visual viewport's bottom), not from
  innerHeight: a visual-viewport shrink lifts by the difference, a page
  shrink (`layoutShrunk`, the fixed edge moved with the keys) lifts by 0 with
  no rail floor, so the box, the log and the stick sit on the keys' top edge
  on either kind of browser; a report has `KB_GRACE_MS` (250) from focus to
  arrive before the estimate runs, so a page-resizing browser never sends the
  box up the screen and back. And for as long as a chat box is focused the
  viewport meta carries `interactive-widget=overlays-content` (restored at
  the settle window's end): a Chrome that honours it keeps the window
  full-size under the keys, so the HUD stays painted behind them ("it must
  be possible to keep the UI behind the keyboard somehow") — declared around
  the game's own chat boxes only; the select screen's name field, the wiki
  drawer and the drop dialog keep the browser's default. Whether his browser
  honours it is not known from the harness, which has no keys; the
  page-shrink drive in `verify-chatpage` proves everything else. THE CHAT
  PAGE APPENDS: `pushChat` → `appendChat`
  adds one row (a day divider when the day turns) and trims the top past the
  cap, keeping the first-row-is-a-divider rule; `renderChat` (the wipe and
  rebuild, 43 ms per line at the cap in the harness) runs only when the tab
  opens. Both build rows through `chatRow`/`chatDivider`. Measured in the
  harness before the round: focus and blur add NO canvas resize, NO layout
  run and NO viewport event over its baseline, so what remains on his phone
  is the browser's own keyboard work plus whatever the DOM costs per write —
  which is what this round cut. Gate: `verify-chatpage` (the lift's geometry
  and glides, the 20px, the drop window, and a real page shrink and grow
  around the lift: no layout run, no canvas resize, the box/log/stick on the
  keys' top edge, the meta's overlay mode on while focused and off after).
- **A PAGE'S SUB-TABS ARE A STRIP THE RAIL GROWS BY, NEVER THE PAGE SHRINKS
  BY** (maintainer 2026-09-19: "the subsection appears by sliding up the menu
  over it so the menu content area is just as big as the menu inner area we
  have today … in landscape ONLY use the icons and show the tabs at the top …
  at most 4 … the last option should always be dev if the admin is logged
  in"). `hud.ts SUBTABS` is the registry — a page lists up to four entries
  and gets a chip row in the one shared strip (`.ml-subrow`, between the tab
  row and the pages) and a `.ml-sub` pane per entry inside its page; the page
  stays the scroller. Equipment gets its sub-tabs the same way, so nothing
  here is Settings-only. PORTRAIT: `applyLayout` adds the open strip's
  measured height (`--sub-h`, `subStripHeight`) to the three-row rail AFTER
  the golden ceiling — `--hud-h`/`--hud-h-inv` are the HUD's real edge, so
  the chat log, the ghost stick, the fps badge and the drop dialog ride up
  untouched — and `#game` (index.html) adds `--sub-h` back, so the CANVAS
  NEVER RESIZES for a menu (a resize is a framebuffer realloc plus a
  whole-world redraw and would fire per frame of the slide); the world under
  the strip is covered. THE SLIDE IS LOCK-STEP: the strip is a
  `grid-template-rows` 0fr→1fr fold and the rail's `top` transitions under
  `:root.ml-subanim` (set for the slide only — resizes and rotations still
  snap, and `ml-noanim` covers both), both `.25s ease` from one style recalc,
  so the page's top edge never moves; the ghost stick and its blur disc
  (`gamepad.ts`, anchored to `--hud-h`) transition `bottom` under the same
  class on the same curve, so the 10px gap above the rail holds through the
  slide (his 2026-09-20 report: the stick snapped while the chat glided);
  the LEAVING chip row stays `.show`
  through the collapse or the fold has no content and the page jumps a frame
  (filmed). `.ml-subrow.open` is the truth, not the row. LANDSCAPE: the strip
  is the top of the page column (`.ml-body` = strip + pages, re-ordered beside
  the vertical tab strip), icons only, `--sub-h` 0. THE STRIP IS A
  `--surface-2` BAND (his, on the first screenshots: "slightly darker in
  light theme and slightly brighter in dark theme. Ofc follow the color
  palette" — that token is that step in both themes by construction) and THE
  CHIPS are 30px ("25% less tall and still clickable", on the 40px first
  cut; 33 in landscape, 28 on the compact tier), wearing the wiki's own
  page-tab recipe (`wiki.css .pagetabs`: one bordered box, dividers, muted
  segments, `.sel` accent-soft in ink) stretched to the tab row's width;
  four chips take the type one step down (`data-n`, measured: "Contr…" at
  90px otherwise). Icons are inline-SVG placeholders on
  currentColor until his 24x24 PixelLab set lands (then `img:` in the
  registry, natural/2). SETTINGS' FOUR: General (Theme choice, the adopted
  Resolution dial, Log out), Sound (two VOLUME dials — maintainer 2026-09-19:
  "This should ofc be a slider/volume control" — on the composer's per-bus
  level, `gameAudio.volume/setVolume("sound"|"music")`: "sound" is the
  sfx+ui+ambience set its mute switch covers, held UNDER the mute in
  `AudioGraph.setBusLevel` and persisted beside the switches; the scene's
  on/off entries stay in Dev), Controls (the Hand choice and the stick's two
  dials), Dev = the whole old page (the switch grid with its `.ml-hudbtn`
  hook, every dial, the ambient checklist), hidden until the server says
  admin (`admin.ts`;
  `__mlHud.admin(true)` re-asks, gates route `/api/wiki/me` like
  verify-recbtn). OUTSIDE INJECTORS ARE NOT TOLD: their hooks
  (`.ml-page[data-page=settings] .ml-set` / `.ml-dials`) are the Dev pane's,
  so a new dev dial lands in Dev by default; a PLAYER dial is adopted into
  General on the receiving side by the label it prints (`DISPLAY_DIALS`),
  the way `adoptDial` already moves strays. THE DEV PANE IS FIRST IN THE
  PAGE'S DOM (its chip stays last): the injectors take the FIRST hook by
  `querySelector`, and General's dial group wears `.ml-dials` as well because
  the one-block law is gated on the slider's PARENT class (verify-smoke) —
  reorder the panes and every dev dial lands on the player's page. Measured
  393×851: strip 49px, rail 311→360, page top 618 and height 233 in both
  states, chips 120px three-up / 90px four-up; landscape strip 52px, chips
  53px in the 314px column. Probe
  `__mlHud.sub(page, id?)` / `.subs(page)` / `.admin(force?)`. Gate:
  `scripts/verify-subtabs.mjs`; `qa-hudpages` opens Dev as the admin.
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
- **THE REPORT BUTTON WEARS THE WIKI BUTTON'S CLOTHES** (`recbtn.ts`,
  maintainer 2026-09-19: "I want that button to look more like the wiki button.
  This means it needs a 24x24 icon and text instead… the text should be
  'Report' and the size and style and margin should be like the wiki button").
  His bug icon at the /ui2 24px grid + the word Report, in the Wiki pill's
  exact box: 80x32 content, 1px `--border-strong`, radius 7, `--shadow`, 76%-of
  `--bg` over a 5px blur, 600 12px/.03em. THE MARGIN IS THE SAME 10px MIRRORED
  — the Wiki pill 10px inside the game view's right edge, this one 10px inside
  its left — and it keeps its anchor under the HP/EP card, sharing that card's
  left edge and hanging the same 10px below it.
  THE DECLARATIONS ARE WRITTEN OUT, NOT SHARED: the two modules are about
  different things and one pill class would couple them, so `verify-recbtn`
  compares this button's COMPUTED style against the LIVE `.ml-wikibtn` (18
  properties) instead — restyle the Wiki button and this fails until it
  follows. That comparison is what keeps the promise; a gate of literals would
  have passed the day the pill changed.
  RECORDING IS THE HOUSE `.on` TREATMENT (`--accent-soft` on `--accent`,
  `--accent-ink`), which IS the red he asked for on 2026-09-18 and re-themes
  with everything else; gated against the computed tokens, never a literal red.
  THE BUG IS `centre`-BAKED, NOT CSS-NUDGED (maintainer 2026-09-19: "I feel the
  Report bug should be lifted a couple of pixels to feel more vertically
  centered"). His export's ink sits at y 6..21 of a 24px canvas — six above,
  three below — and read low beside the label; `centre` in
  `bake-corner-icons.py` computes exactly dy −2, dx 0 for it, so the fix is the
  transform that already exists and is already asserted (pure integer
  translation, same pixels, nothing clipped) rather than a magic `top:-2px` in
  a stylesheet. `verify-recbtn` measures the DECODED pixels and requires the
  ink's top gap ≤ its bottom gap, so a re-export that lands low fails instead
  of looking slightly wrong for ever.
  RETIRED with the restyle: his 48x48 two-face plate, the lamp pixel-crop, the
  5-slice widening and the ResizeObserver that copied the card's width — a
  fixed-width pill needs none of them. The bakes stay on disk (his art;
  `bake-corner-icons.py` proves every entry it lists) and nothing references
  them. The `ml-record` seam is untouched, so `freezeframe.ts` never knew.
  TWO GATE ASSUMPTIONS PAID FOR HERE: `offsetParent` is null for EVERY
  `position:fixed` element, so it can never stand in for "is it painted" (the
  box itself is the test); and a dev build stamps no `?v=`, so an icon's cache
  stamp is asserted as a RELATIONSHIP with the other /ui2 icons, never as a
  presence.
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
  **UPDATING FROM INSIDE THE WORLD COMES BACK INTO THE WORLD** (maintainer
  2026-09-19: "If I'm inside the game and a new version is out… press upgrade
  [and] the game restarts and I'm back at the title-screen/character select. It
  would be much smoother to first reload the game of course, but then
  immediately get into loading the game. This will take me back to where I was
  so much faster"). "Update now" sets `ml-rejoin` before reloading — the flag
  WorldScene already sets before its dead-connection recovery reload and
  main.ts's fast path already consumes: it skips the select screen, shows the
  loading overlay and re-enters with `ml-last-choice`, the server restoring the
  position from the token store. NO NEW STATE and no second way of doing the
  same thing. ONLY FROM THE WORLD — the same dialog opens over the character
  select, where the flag would skip the screen he is standing on; `ml-ingame`
  (main.ts's own root class) is the question asked of the thing that answers
  it. Gated END TO END in both directions, through real reloads, because the
  claim is about where you end up: a test of the flag alone passes on a build
  that sets it and then ignores it.
  THE TOAST IS UNCHANGED and still the quiet FYI of 2026-08-05 — deploys land
  many times an hour, so the dialog opens on TAP, never by itself; its wording
  stays maintainer-fixed ("New version out <hash>", 2026-07-17) and
  `verify-bootversion`'s regex with it. z 110, above the z-100 toast that opens
  it. `main.ts` is the games agent's file: the hook is the one allowed
  mechanical line (the click handler), announced on the board.
  **THE CARD OPENS AT THE SIZE ITS CONTENT NEEDS, because the notes are already
  in hand** (maintainer 2026-09-19: "We need to know the best dialog size when
  we open/before we open the dialog… Once we know a new version is out we fetch
  the data we need and after that we display a 'new version out' popup… When
  the player clicks on the toast the dialog will display with the best possible
  size immediately. This removed the loading completely because that has
  already been done"). `prefetchNotes()` is memoised, never rejects, and
  `main.ts` awaits it BEFORE raising the toast (the one mechanical line in the
  shared glue, announced). `openUpdateNotes` then builds the whole card —
  rows, summary, your own build — and inserts it filled, so there is no size to
  change and no loading state to show. REJECTED, and it reached his phone: a
  FIXED `height`. It answered "I hate dialogs that suddenly changes size" and
  made two commits look like fifty and an EMPTY list a full-screen empty box.
  `max-height` caps it; the prefetch is what stops it moving. The gate opens a
  50-row list and a 1-row list and requires the second to be SHORTER, as well
  as neither moving a pixel a second after opening.
  **FOUR FIXES, 2026-09-19, each his own sentence.** (a) THE DAY BAND left
  pixels over itself while scrolling: `-webkit-overflow-scrolling:touch` on the
  list — a no-op on every browser this game runs on — put the scroller on a
  compositor layer whose sticky child is not repainted per frame. Gone; the
  band is also FULL-BLEED now (negative margins + matching padding), because it
  used to stop at the list's content box and a row slid past showed in the 16px
  gutters. (b) YOUR OWN BUILD is the last thing in the list, under a "You are
  running" label, wearing the accent and a heavier rule above it — "it has to
  be clear this is my version and not part of the commit". Absent from the
  published window = no block, never a guess. (c) THE CARD NEVER RESIZES: the
  height is `height`, not `max-height`, so it opens at the size it will end at
  ("I hate dialogs that suddenly changes size!"). (d) A SPINNER holds it while
  the fetch runs, its centre at 45% down the list — his optical centre, "like
  55% (45% from the div top)". The gate measures the card's height DURING the
  load and again after, and the loader's centre as a percentage; it scopes
  every change-row assertion to `.ml-upd-list > .ml-upd-row`, because the
  "you are running" block holds a row that is deliberately not a change.
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
  good!"). `maplayers.ts`: the button is a **30px ⧉ glyph in the row's
  BOTTOM-RIGHT** (maintainer 2026-09-19: "can just be a small ⧉ icon at the
  bottom right corner in order to save space"). **THE GLYPH IS THE ANSWER, NOT
  A PLACEHOLDER** — he offered to make a PixelLab icon for it and then settled
  it himself on seeing it: "That unicode button you used looks great! Keep that
  one instead!" (maintainer decision). So this is NOT a slot waiting for art:
  do not swap it for an `/ui2` bake, and `verify-map` asserts the character
  itself, so an `<img>` here fails the gate. It carries no count — the pills beside it ARE the count and say
  WHICH — and it is the row's LAST child with margin-left:auto, which on a
  wrapping row puts it at the right end of whatever line it lands on, so the
  pills fill from the top-left and the button ends the flow in the corner. It
  still names itself for a screen reader ("Choose layers (N on)"). The dialog (`.ml-layers`, the drop-quantity card's recipe, z 70) is
  rebuilt on every open from `offered()` — every layer whose `has()` is true —
  with all/none per group; a tick applies at once and the map behind redraws;
  backdrop, Escape and Done close. **IT HAS A HEIGHT THAT LOOKS GOOD, NOT THE
  TALLEST THE SCREEN ALLOWS** (maintainer 2026-09-19: "the dialog should not
  be able to grow that insanely tall. The user can scroll. Use a height that
  looks good instead"): a 400px card capped at 560px or two thirds of the
  screen, a fixed title row ("Map layers" + the "n of 10" cap) and a fixed Done
  under a body that scrolls on its own, and the rows of every group in **two
  columns** (`.ml-layers-grid`; "Maybe ambient zones can be displayed in two
  columns?") — thirty effects one per line was a list you scroll, two abreast
  is a table you scan. The AMBIENT-ZONE layers are DERIVED, one per
  effect, from **maps2's own `ambient.json`, schema `pixel-maps3/ambient@1`** —
  `{size, exclusive, zones:[{id, name, kind, area, cells, effects}]}` where
  `area` is a CLOSED POLYGON of world cells (coastlines run to 830 points, so
  every point is projected — `poly()`, never `quad()`) and `effects` is a MAP
  of effect name → share, so ONE zone carries MANY effects and a layer per
  effect is derived across all of them. Drawn biggest-zone-first (a small
  place over the large one beside it), fill deepening with that zone's share,
  no text over the map; file missing = no group. **A DOOR IS NOT DRAWN**: since
  2026-09-19 a place carries one signature at 90, supports at 20 or under and
  "doors" at 0.5 (the effect that should not happen there, once in two
  hundred windows — `maps2/spec/AMBIENT.md`), and painting every share put a
  faint snow wash over the whole sea; a share under 1 is skipped, so the map
  answers where an effect LIVES.
  **THE PAID-FOR TRAP, 2026-09-19: this reader was written against
  `ambient_zones.json` / `pixel-maps2/ambient-zones@1` — a schema PROPOSED to
  maps2 and never adopted.** It fetched a name nothing publishes, 404'd, and
  the group was silently absent in production while `verify-map` passed green
  against a FIXTURE OF THE PROPOSAL ("THIS IS A CRITICAL BUG! I AM ON YOUR NEW
  VERSION AND IT DOESN'T COME UP!"). The gate now reads the REAL published file
  out of the served tree and asserts its name, its schema and that EVERY effect
  in it becomes a layer. **A fixture may stand in for data that is hard to
  stage; it may never stand in for the producer's own published file** — then
  the one thing the gate cannot see is the only thing that can break. Probes:
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
  rebuilt from `offered()` beside the button. **A TAP ON A PILL FINDS THE
  LAYER, IT NEVER REMOVES IT** (maintainer 2026-09-19: "If I go to the map-tab
  and press on a pill - I want that area to pulsate in order for me to find it
  better. I don't want to remove it. To remove it I will use the dialog."):
  every layer draws into its own `<g data-layer>` and stamps its labels and
  pins with the same id, so `pulseLayer` blinks that layer's marks and the
  pill together, four beats (`.ml-maplayer-pulse`, opacity — a wash and a pin
  blink alike; one slow fade under reduced motion) and changes nothing. The
  pill used to be its own off switch, which made the one gesture a legend
  invites — "which one is this?" — the one that destroyed what you asked about.
  EVERY LAYER CARRIES `mark()` — colour + shape — AND ITS `draw` READS THE SAME
  CONSTANT (`ZONE_LINE`, `PIN_FILL`, the effect's hue), so a pill can never
  name a colour the map does not paint; the swatch copies the SHAPE too
  (diamond for a pin, square for a wash), because shape is what survives a
  colour-blind eye. `verify-map` asserts each swatch against the colours the
  live overlay is actually painting, not against the constant.
  **AT MOST 10 LAYERS ON, AND TEN HAND-PICKED COLOURS** (maintainer 2026-09-19:
  "add a max 10 layers limit so you don't need to come up with too many
  different colors"). A palette limit stated as a feature limit, and the right
  way round — ten washes over one small map is already the most anyone can
  read. `PALETTE` is Okabe–Ito's colour-blind-safe set (minus its yellow, too
  near the dungeons amber) plus four picked to maximise the smallest gap: no
  two are closer than **67 in RGB**, and that holds against the two FIXED marks
  too (zones blue, dungeons amber), which never take a palette slot. A layer
  takes the lowest FREE slot when switched on and gives it back when switched
  off — never by position in the list, which would re-colour the whole legend
  every time one is removed. A layer that is OFF wears an EMPTY outline: a
  colour is only claimed once something wears it. At the cap the rows that
  cannot go on are `disabled` and a line says why; `all` fills up to the cap
  and stops; `setLayer` RETURNS whether the layer ended up on, and callers
  repaint from the answer rather than from what they asked.
  REJECTED, with its measurement, so it is not re-attempted: a GENERATED hue
  wheel. Name-hash alone put rain at 36° and snow at 35° — two colours by
  `===`, one to the eye — and over maps2's real 32 it put `ants` and `thunder`
  on the identical pixel value. 12 slots × 3 rings fixed that at 45 apart;
  ten by hand does 67, and the cap is what makes ten enough. The gate measures
  SEPARATION, never inequality, over the layers actually ON.
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
- **THE CORNER CHROME IS AS WIDE AS THE CARD ABOVE IT** (maintainer
  2026-09-19, marks drawn on a screenshot: "The Report button should have the
  same size as the card over it so it aligns! The wiki button should also align
  with the card over it! But the wiki button has to still be smaller because we
  want the search button to left align with the cards left edge and not the
  wiki button. But the wiki button should be wider and not the search button.
  Spacing should be the same."). `hud.ts` publishes `--bars-l-w` / `--bars-r-w`
  by MEASURING the two cards in `applyLayout` — bars.ts is the games agent's
  and publishes only its heights, and measuring is what lets all of this follow
  any width they choose with no change here. Then: the Report pill is
  `--bars-l-w` wide (both edges flush with the HP/EP card); the 🔍 keeps its
  32px square and takes the card's LEFT edge; the Wiki pill takes the
  remainder, `--bars-r-w - 44 - 2`, so the row spans the XP card exactly with
  the one 10px gap between them. Every `-2px` is a button's own borders, which
  sit outside a content-box width. **THE ROW GOES DIRECTLY UNDER THE CHIP** —
  "we once again must place the wiki and search over the time-of-day pill",
  because a row that is the card's width has to TOUCH the card or its
  alignment is invisible. (This swapped to pill-first earlier the same day and
  back again within the hour; the second verdict carries the reason, so it is
  the one that stands.) EVERY PLACEMENT, BOTH HANDS: left-handed landscape
  kept the game view's bottom corner for the row until 2026-09-19
  (maintainer: "Left-handed landscape mode has still not placed the
  wiki+search under the XP-card"); that corner holds no chrome since the pill
  went top-centre, so `wikibtn.ts` / `wikinear.ts` carry ONE `top` anchor in
  the base rule — no orientation or hand rule at all — and no corner is the
  row's anywhere.
  THE PILL IS NO LONGER PART OF THIS. It was the row's twin for six weeks —
  same box, same right edge, one `--ml-stack-step` apart, in an order that
  flipped with the anchor — and on 2026-09-19 it went to the view's centre and
  took none of that with it. `assertStack` lost its `rowFirst` argument the
  same day: a parameter that exists to describe a relationship outlives its
  purpose the moment the relationship does.
  **AND THE TWO CARDS ARE THE SAME HEIGHT** (maintainer 2026-09-19, both card
  bottoms drawn on a screenshot: "the gold however is not as tall as EP so the
  two cards have different size. This makes all UI elements under the card
  un-aligned"). The gold row was 16px against a bar row's 26.3, so the XP card
  was short and everything anchored under it inherited the difference. ONE
  declaration in `bars.ts` — the games agent's file, claimed and announced on
  both boards — gives `.ml-gold-row` a `min-height` written from the bar row's
  own three terms (10px border-box gauge + 2px number margin + 11px/1.3 line),
  never a rounded literal. `verify-recbtn` asserts THE TWO CARDS ARE EQUAL in
  height and top, so that number is held to a real bar row.
  STILL OPEN, and NOT OURS: the cards are 148px wide in portrait and 192 in
  landscape (`.ml-bar-row` 126/170 with a `min-width:700px` override in
  `bars.ts`). He wants ONE width in both, between the two; posted to games
  2026-09-19 with the exact line. Nothing here needs touching when they ship
  it — the vars are measured. `wikibtn.ts`,
  `wikinear.ts`: `top: safe-top + --bars-r-h + 20px` in the base rule and no
  `bottom` anywhere — one anchor for every placement since 2026-09-19: the
  row directly under the chip in portrait and in landscape with either hand
  (the left hand joined last, on his report), the pill one step under the
  row again since 2026-09-20 (clock.ts). The keyboard lift (`hud.ts :root.ml-kb-up`) writes
  `bottom` on the chat log, the chat input and (through `--ml-pad-floor`,
  gamepad.ts) the ghost stick, and nothing else; the row's own lift rules
  went with its last bottom anchor, so the keys move nothing of it —
  `verify-chatpage`
  AND `verify-wikibtn` assert the row and the pill stay put (the latter still
  demanded they RISE and had been red on main since the stack moved top-right
  on 2026-09-17: two of our own gates contradicting each other, fixed
  2026-09-19 in favour of the law); `verify-chat` asserts the row's right
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
- **THE WIKI BUTTON** (`wikibtn.ts`, maintainer 2026-08-13, placements from
  his three red-circled shots): pill-sized (80x32+border); since 2026-09-19
  the row hangs under the XP chip in every placement and the pill is
  top-centred (the row law above). ONE order everywhere, including over the
  phone keyboard — chrome that reorders when the keys come up reads as a bug.
  THE STEP IS PUBLISHED, NOT COPIED: `--ml-stack-step` is declared once by
  wikibtn.ts (that button's own outer height + the 10px gap) and read by
  clock.ts (the pill's fallback row when the cards leave it no room at the
  top), wikinear.ts and chat.ts (the log's width). It was three hardcoded
  44s before, which is exactly the shape that desyncs. The button is in hud's
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
