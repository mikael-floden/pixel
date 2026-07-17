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

## File ownership (one writer per file, applied inside games2/)

**games-ui owns (the DOM overlay layer + its assets/QA):**

- `client/src/hud.ts` — bottom HUD: tab row, pages (Backpack/Equipment/Map/
  Settings/Logout), frame-layout glue.
- `client/src/frame2.ts` — the vine/crystal/clock UI frame (runtime-composed
  canvas, `/ui2/*`).
- `client/src/clock.ts` — the celestial clock overlay + animated hand.
- `client/src/select.ts` — character/world select screen.
- `client/src/loading.ts` — loading overlay.
- `client/src/chat.ts` — chat overlay.
- `client/src/roster.ts` — player roster overlay.
- `client/src/uiscale.ts` — the compensating CSS zoom for overlays.
- `client/public/ui/`, `client/public/ui2/`, `client/public/logo*.png`,
  `client/public/icons/`, `client/public/manifest.webmanifest` — UI art +
  PWA shell.
- UI build scripts: `scripts/build-clock.mjs`, `scripts/build-ui-tiles.mjs`,
  `scripts/build-pwa-icons.py`.
- UI verify scripts: `scripts/verify-select.mjs`, `scripts/verify-chat.mjs`,
  `scripts/verify-mobile.mjs`.
- This file.

**The games agent owns everything else**, notably: `client/src/scenes/`,
`nightlight.ts`, `lighting.ts`, `maps.ts` (world consumption — NOT the Map
tab page), `manifest.ts`, `net.ts`, `placeholder.ts`, `main.ts`, `shared/`,
`server/`, `Dockerfile`, `deploy/`, `loop/`, the remaining scripts, and
`games2/CLAUDE.md` + `games2/README.md`.

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

- **Pixel art scales nearest-neighbour only, everywhere, always.** Soft
  alpha on every keyed cut edge; no smoothing upscales, ever.
- **Two coordinate spaces coexist**: the page frame is fixed layout px
  (never uiZoom'd); overlays (clock, badge, banner, select, chat) get the
  compensating `zoom`. Anchoring an overlay to a frame feature needs
  `calc(<px> / var(--ml-uizoom, 1))`.
- **QA in the maintainer's REAL phone geometry** (desktop-site layout on a
  phone): Playwright `{viewport: 980×2123, screen: 393×851, isMobile: true,
  hasTouch: true}` → uiZoom ≈ 2.49. Check BOTH this and plain device-width
  mode when touching overlay anchors.
- Overlay CSS uses px/% only — never vw/vh (they double-count under zoom).
- HUD geometry is NOT uiZoom'd (its dvh split must match `#game`).
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
