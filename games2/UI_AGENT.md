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
  40x12 art-pixel landscape painted into a canvas and shown at x2. The sun
  and moon ride a continuous belt (exit right == enter left), so it needs no
  hand-off animation and the server needs no time freeze. Driven only by
  `setClockTime(f, night)` + `clockStar()`. See the CLOCK PILL section of
  `games2/CLAUDE.md` before changing the art or the motion.
- `client/src/select.ts` — character/world select screen.
- `client/src/loading.ts` — loading overlay.
- `client/src/roster.ts` — player roster overlay (currently unmounted).
- `client/src/uiscale.ts` — LEGACY compensating zoom; only `loading.ts` and
  WorldScene's reconnect toast still consume it. The wiki-style UI proper is
  plain responsive CSS with NO zoom compensation.
- `client/public/ui/`, `client/public/ui2/`, `client/public/logo*.png`,
  `client/public/icons/`, `client/public/manifest.webmanifest` — UI art +
  PWA shell.
- UI build scripts: `scripts/build-ui-tiles.mjs`, `scripts/build-pwa-icons.py`
  (the `/ui2/*` kit PNGs are no longer consumed at runtime — the 2026-07-30
  wiki-style remake replaced them with CSS; only the baked tab icons and the
  gold icon remain in use as pixel art).
- UI verify scripts: `scripts/verify-select.mjs`, `scripts/verify-chat.mjs`,
  `scripts/verify-mobile.mjs`.
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

## Don't

- Don't edit the games agent's files (above) without a board round trip.
- Don't touch the art domains (`characters2/`, `tiles2/`, `maps2/`,
  `objects/`, `sounds/`) — read-only, same as ever.
- Don't write any `coordination/*.json` except `games-ui.json`.
- Don't push red — `npm test` + `npm run typecheck` first.
