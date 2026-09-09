# UI, mobile, landscape

The wiki-themed HUD, chess, landscape and handedness, rotation, PWA and reconnect. Moved verbatim out of `games2/CLAUDE.md` (2026-09-09), which keeps the law and points here; the measurements, traps and rejected approaches live in this file. Rewrite in place under the root doc law.

## Chess at the board

A playable chess easter egg: stand at a free seat on a world board and the
JUMP BUTTON becomes START / JOIN CHESSGAME; both players get a DOM dialog.
One rules module for server, client and NPC — `shared/src/chess.ts`; room and
match logic `server/src/chess.ts`; dialog `client/src/chessui.ts`; gate
`scripts/verify-chess.mjs`. Boards are placed in
`games2/config/chess_boards.json`, overridable per world from
`live/tuning/chess.json`.

- **PIXEL ART SCALES BY A WHOLE DEVICE-PIXEL FACTOR, NOT A WHOLE CSS ONE**
  (maintainer: "fractal scaling"). `image-rendering:pixelated` resolves in
  DEVICE px, so what must come out whole is `css x dpr / art` — at his dpr 2.75
  a 1:1 CSS sprite is 2.75x and neighbouring source pixels get 3 and 2 device
  px. `chessPieceCss` / `pixelArtCss` (shared) pick the integer scale and work
  back to a possibly-fractional CSS size; the dice strip scales all three of
  hand, `background-size` and the keyframe's landing offset together or the
  frames tear. The dragged ghost is NOT scaled up for the same reason. The
  opponent does not re-play the throw and is never mirrored — flipping it stood
  his die on its head; he shows the strip's last frame, upright. Tested at real ratios in `server/test/chesssize.test.ts` (no
  headless run reproduces 2.75).
- **DRAG AND TAP ARE ONE GESTURE, AND A DROP IS A MOVE OR NOTHING.**
  pointerdown always selects (that IS the tap flow); a drag starts past a 6px
  slop radius and lifts a ghost onto `<body>` (the squares are overflow:hidden
  and would clip it). THE TARGET IS THE SQUARE UNDER THE FINGER — hit-testing
  at the lifted ghost aimed 30px, two thirds of a square, high and read as a
  broken hitbox. The landing square highlights live while dragging, and a drop
  with no legal move re-selects NOTHING (`dropSquare`, not `tapSquare`, whose
  select-fallback is right for a tap and wrong for a drag).
- **DIALOG STABILITY LAW** (drop-dialog family, paid for in a 6-round ghost
  hunt): the card skeleton is built ONCE and its controls NEVER move or get
  replaced — squares update in place. THE VERDICT OBEYS IT TOO: won/lost/draw
  is a SCRIM over the board (absolute, inside `#ml-chess-board`), never a row
  in the column — as a flow element it grew the card 372 -> 424 px and shoved
  the board up the instant the game ended. verify-chess measures card, board
  and footer across the resign and fails on >1px of movement. A full re-render used to shift the
  Resign button sideways under a tap aimed a beat earlier.
  `touch-action:manipulation` on the card; the backdrop preventDefaults ONLY
  its own events (hud.ts's drop-dialog law — a card-event preventDefault eats
  button clicks on touch).

## Mobile / PWA (client)

- **WIKI-STYLE UI (the complete HUD remake, 2026-07-30)**: the pixel-art UI
  kit and vine/crystal frame are RETIRED (frame2.ts + plate.ts deleted;
  history in git). Every DOM surface is plain HTML/CSS on the SHARED WIKI
  THEME (`client/src/theme.ts` = wiki/site/wiki.css tokens: cream/dark
  palettes, serif headings, coral #d97757 accent, 1px var(--border), 8-14px
  radii). DARK MODE is one choice for wiki AND game:
  localStorage["wiki-theme"] → `<html data-theme>`; theme.ts follows the wiki
  drawer via `storage` events; wikipanel.ts mirrors game-side toggles onto
  the live iframe (`storage` doesn't fire in the writing document); Settings
  has a theme button. Pixel-art ICONS
  stay, pixelated, at their AUTHORED 1x GRID — hud.ts sizes each img to
  naturalWidth/2 (the /ui2 bakes are exact 2× of hand-drawn art on
  non-square canvases; a fixed square box distorts — maintainer: "not pixel
  perfect"). Tab row + pages share 16px side margins; tabs 56px (48 at
  ≤640h); 1px bottom rule. REJECTED (maintainer, do not re-propose): a
  screen-edge frame around the game view ("it looks bad" — full-bleed
  stands); an in-game bottom-right chip for the version badge (it keeps ONE
  quiet bottom-centre placement everywhere). NO zoom compensation in the new
  UI (uiscale.ts survives only for loading.ts + the reconnect toast). Gates:
  verify-bars/-hudtabs/-clockflip/-chatpage/-gamepad/-select.
- **THE WIKI DRAWER SLEEPS THE GAME LOOP** (`client/src/gamefreeze.ts`): the
  drawer hosts a second document on the SAME main thread, so `openWikiPanel`
  calls `freezeGame()` (TimeStep.sleep(), rAF cancelled) before the iframe
  exists; `closeWikiPanel` thaws. Measured: the wiki went 3.5fps/367ms
  stalls → 60fps/17ms worst. Nothing needed lives on that loop (Colyseus
  socket is event-driven — verified across a 30s freeze; WebAudio schedules
  itself; HUD is DOM). Input stops, which is correct (the server integrates
  only what it receives; a frozen client stands still; >2-cell movers snap on
  return under the teleport rule). **Waking is NOT `TimeStep.resume()`** —
  see UI_AGENT.md: it arms Phaser's 120-frame panic cooldown = visible slow
  motion. Gate: section 3 of verify-wikibtn.mjs; probe `__mlFreeze`.
- **`__ml.nearby()` — WHAT IS AROUND ME, BY WIKI ID** (games-ui's 🔍 button,
  `client/src/wikinear.ts`; contract `spec/WIKI_NEAR.md`; maintainer
  2026-09-02 "a way to fast find what you stand next to"). One row per
  (domain, id) at the NEAREST instance, `n` = how many within the radius,
  nearest first, capped 80: monsters by roster id, NPCs by characters2 key,
  drops by item id, scenery by BARE piece id, and the ground as
  `tiles/<material>` on a Tiles 2.0 world or `world/<type>` on a Tiles 3.0
  one (`this.t3` decides — the wiki has two ground domains; `#/world/<type>`
  is its ground-type page). Bodies within 12 cells, ground within 4, the cell
  under the feet is distance 0. Other players are not rows (no page). A probe
  like the rest of `__ml`, called once per drawer open — the scene owns the
  maps, so the enumeration lives here; wikinear.ts only relays it into the
  iframe as `wiki:near` — together with `heard`, the composer's ledger of the
  score now + the sound events of the last 30 s (`gameAudio.heard()`, also on
  `__ml.audio().heard`). Gate: section 6 of verify-wikibtn.mjs (every id
  checked against the wiki's shipped index; the ear asserted when the harness
  has a running AudioContext).
- **HUD (golden-ratio split)**: game viewport = TOP 61.8% (`#game`,
  `--hud-h-inv`); bottom 38.2% (`--hud-h`) is the DOM HUD
  (`client/src/hud.ts`): 6 wiki-style tabs over pages. applyLayout()
  publishes --hud-h/--hud-h-inv in REAL px (consumers parseFloat). Settings
  hosts the toggles + theme; the time-of-day button keeps the `.ml-hudbtn`
  hook (smoke). `.ml-plate-btn` survives as a plain-CSS class — the ambient
  agent's cycler expects it. Pointer events in the HUD never reach Phaser —
  e2e taps stay in the top 61.8% (canvas centre y = VH*0.309).

## Landscape, handedness, rotation (in-game only)

- **The WORLD plays landscape; title/select/loading stay portrait-only.**
  In-game, on TOUCH, a landscape viewport turns the golden split on its
  side: the game view keeps 61.8% of the long axis at FULL height; the menu
  becomes a 38.2vw side column with a VERTICAL tab strip hugging the
  game-view edge. Which side is HANDEDNESS (`client/src/controls.ts`,
  localStorage `ml-hand`, DEFAULT RIGHT, Settings "controls", event
  "ml-hand", probe `__ml.hand(h?)`): the promise is the STICK's side —
  right-handed keeps the stick right in every orientation (the approved
  portrait layout is right-handed), so the landscape menu goes LEFT;
  left-handed mirrors. Mechanism: `hud.ts applyLayout()` classes the root
  (`ml-ingame`/`ml-land`/`ml-lh`) and publishes px vars — `--menu-w`,
  `--hud-h` (0 in landscape), `--gv-left`/`--gv-right`. #game, the chips,
  the chat overlay and the pill anchor off the gv vars and TRANSITION their
  anchor property (handedness swaps glide; display swaps snap).
- ONE exception to "corners stay corners": in RIGHT-handed landscape the
  clock pill leaves the bottom-right corner (the thumb stick's) and parks
  under the XP chip, right edges aligned, 10px below — reading
  `--bars-r-h`, the chip's MEASURED height (bars.ts publishes it from a
  ResizeObserver). Left-handed keeps the corner.
- ICONS ARE NOT ROTATED (the "icons rotate 90°" ask described the
  locked-page mental model; a sideways backpack is not a backpack) — the
  gate pins transform:none.
- GAMEPAD: in landscape the stick is REPARENTED TO `<body>` — usable on
  EVERY tab (a HUD rebuild clears strays) — floating in the game view's
  bottom corner on the thumb's side (gamepad.ts LAND_INSET 38px, the centre
  the maintainer marked on two device screenshots). **MEASURE A DEVICE
  SCREENSHOT'S SCALE, never assume the portrait DPR**: his phone is 393 css
  px portrait (dpr 2.75) but its LANDSCAPE viewport is ~988 css px = 2.28
  device px per css px — reading marks at 2.75 said "move 10px" when the
  answer was 28; fitting a circle to the stick's own 148px blur disc settled
  it. Anchor measurements to something whose CSS size you KNOW.
- THE GHOST IS TWO PAINTED PARTS, EACH WITH ITS OWN ALPHA: `.ml-pad-well`
  (basin) + `.ml-pad-top` (cap) inside a paint-nothing `.ml-pad-stick` — it
  HAS to be built that way: the cap must read STRONGER than the well, and a
  parent's group opacity can only make a child fainter. Rest alphas: LIGHT
  well .15 / cap .25; DARK well .4 / cap .5 (a faint grey ghost vanishes on
  dark terrain). Dark is the explicit data-theme AND the OS default, so
  every dark rule needs its prefers-color-scheme twin. WHILE HELD both go
  to 1 — the rule is written `:root.ml-land .ml-pad-stick.held …` ON
  PURPOSE (the dark rest rules carry an attribute selector; the shorter
  form lost the specificity race and the ghost stayed faint in dark).
  Backed by a blur disc as its OWN full-opacity element (`.ml-pad-blur`,
  z 3) pinned to the stick's rect — backdrop-filter ON the stick cannot
  work (its opaque background paints over its own blurred backdrop, and the
  ghost opacity dilutes the rest). Portrait hides the disc. PICK UP stacks
  above JUMP on the column's centre line; the vertical tab strip is
  centred.
- **Anything positioning against ml-land / the gv vars listens to
  "ml-layout", NEVER the raw resize**: applyLayout fires it last;
  gamepad.ts's own resize listener registers BEFORE hud's, so on rotation
  it read the PREVIOUS ml-land and left the floating stick parented to a
  display:none page at 0×0 — invisible, untappable, unhealed (a hidden page
  never resizes, so its ResizeObserver can't fire). Gate 4d rotates with
  the BACKPACK tab open, each hand, and asserts the stick is
  body-parented, hit-tested, and steers. Page-RELATIVE writes in layout()
  are skipped while the page is display:none (width reads 0 — buttons park
  at garbage and visibly correct on tab entry).
- The position glide is `.anim`-GATED and fires ONLY on a handedness change
  while the page is visible (a glide during rotation fights the canvas
  resize and the OS's own rotation animation).
- **ROTATION SNAPS UNDER A VEIL** (FIVE rounds — keep the arc):
  anchor-transition glides, an outright snap, and a flip pin-then-glide were
  ALL rejected; the closing insight: Chrome/the OS already animate the
  rotation, so ANY chrome animation on top reads as a broken double
  animation. On an orientation flip every anchor jumps straight to final
  (`:root.ml-noanim` pins transitions off); only the handedness glide
  remains. What `hud.ts beginFlip` owns is the HEAVY part: a real rotation
  restages the viewport several times, and a full scale.resize per stage
  (framebuffer realloc + whole-world redraw, traced ~2s PER resize) stalls
  the thread into stale letterboxed frames. main.ts fitCanvas holds fire
  while `:root.ml-flip` is up — AND whenever in-game + touch + viewport
  aspect disagrees with ml-land (the #game ResizeObserver delivers BEFORE
  the resize event that starts the flip, traced 3ms). A THEME-SURFACE VEIL
  (`.ml-flip-veil`, z 3 — over the canvas, under stick/HUD/chat/chips)
  hides the stale world; at quiet (~300ms without a resize) ONE
  "ml-flip-flush" re-fits the canvas in a single resize under the veil;
  after two calm frames (cap 2.5s) the veil fades. The in-game html/body
  wear the THEME background (index.html ships #000 for pre-game screens) so
  a mid-rotation flash reads as surface. Gate sections 4b + 4c
  (verify-landscape) watch a clean and a STAGED rotation frame-by-frame:
  zero transforms/glides on chrome, veil up during and gone after, ZERO
  canvas resizes before the flush, one re-fit after, pill on its true
  anchor. settle() treats a live veil as "not settled".
- **A tap must land where you tapped after a rotation**: Phaser's
  `displayScale` derives from `canvasBounds`, filled during ITS resize
  pass; fitCanvas sets the canvas CSS size AFTER that, so the cached bounds
  kept the pre-rotation size (measured: real canvas 526×393 vs bounds
  393×526 → every tap ~98wu off in landscape, ~134wu after rotating back;
  0.0 in all three states now). fitCanvas calls `updateBounds()` and
  recomputes displayScale with Phaser's own formula (ScaleManager
  `baseSize / canvasBounds`). **Do NOT "fix" with `scale.refresh()`**: in
  RESIZE mode it re-derives gameSize/baseSize/canvas.width from the PARENT,
  discarding the deliberate resolution scaling (a 393×526 box backed by
  786×1052). fitCanvas also runs on `ml-hand` — handedness MOVES the view
  without resizing it, so only the bounds POSITION goes stale. Gate: 4e
  (tap your own feet through portrait → landscape → portrait).
- Landscape column sizing: tabs keep 56px (the global ≤640px-HEIGHT shrink
  rule was written for short PORTRAIT phones and silently shrank every
  landscape strip; a ≤388px-height media keeps 48px for tiny screens);
  strip 84px wide; the backpack grid turns 3 wide × 5 tall
  (`:root.ml-land .ml-slots`, capped 320px; width cap HEIGHT-derived —
  `calc((100dvh − 72px)*0.6 + 20px)` — so all five rows fit without the
  1px scroll); the MAP sizes to the SHORT viewport side (same size portrait
  gives it), `.ml-map` overflow:hidden clips evenly so the you-are-here
  dot's percent offsets stay true; the keyboard-floated Chat input takes
  the gv insets (floats inside the game view). A ONE-TIME help chip on the
  gamepad page points at Settings → controls (× dismisses forever,
  `ml-hand-help`); absolute overlay, its BODY pointer-events:none (on a
  short viewport it can lie over the stick — caught by verify-gamepad).
  Desktop (no touch — `touchDevice()`, shared with the keyboard lift) keeps
  the portrait split at ANY aspect — which keeps every 480×320 e2e gate on
  the portrait coordinate model. Gate: `scripts/verify-landscape.mjs` (both
  hands, portrait return, floating-stick input, help persistence, desktop
  immunity; settle-polled — the starved compositor reports mid-flight
  values long after wall-clock).
- **Portrait-only OUTSIDE the world**: `#ml-rotate` (index.html media query
  — coarse pointer + landscape + max-height 520px) covers
  title/select/loading; `html.ml-ingame` (set by mountPageFrame) suppresses
  it in-world. The manifest is `orientation: any`; the REAL gate is
  main.ts's boot-time `screen.orientation.lock("portrait")` (covers the
  installed app's pre-game screens), RE-LOCKED to "any" by mountPageFrame
  when the world mounts (the boot lock silently kept the phone portrait
  in-game whatever the manifest said). Logout reloads, so the portrait lock
  returns. In a browser tab both lock() calls reject harmlessly. An
  installed WebAPK may need a reinstall to shed an OLD manifest's lock;
  Android auto-rotate must be on.
- **Dead-connection recovery**: backgrounding freezes JS; the server drops
  the client and the room turns ZOMBIE (no patches/acks — prediction
  replays an ever-growing unacked history; the old "teleport when jumping
  uphill after tabbing back"). `room.onLeave` (ignoring real unloads —
  pagehide fires first) triggers an IN-PLACE rejoin (`handleDrop`):
  "Reconnecting…" toast, joinWorld again (immediately when visible, else on
  visibilitychange), old avatars + prediction state dropped, `bindRoom`
  rewires — NO page reload (phones background constantly). Input sending is
  frozen while disconnected (flushInput guard). Retries back off; after 6
  failures a reload with `ml-rejoin` set (main.ts then skips the select
  screen via `ml-last-choice`). NOTE: `room.state.players` is undefined
  until the first patch. Probe: `__ml.dropConnection()`; regression:
  `scripts/verify-reconnect.mjs`.
